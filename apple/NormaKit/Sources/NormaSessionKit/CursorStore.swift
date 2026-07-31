import Foundation
import os

/// The phone's per-stream replay cursor persistence seam (SP3 Task 4). One `Int` per
/// `(hostID, sessionID, streamID)` — the last seq the client has **durably applied** (yielded to
/// its consumer). `NormaSessionClient` reads these to build `ClientHello.resumes` on attach, and
/// advances one **only after** the corresponding event has been emitted (durable-apply-then-advance):
/// an in-memory counter that advanced before the yield would lose events on a crash between advance
/// and apply.
public protocol CursorStore: Sendable {
    /// The last durably-applied seq for a stream, or `nil` if this stream was never seen.
    func cursor(host: String, session: String, stream: String) -> Int?
    /// Persist `seq` as the new durable cursor for a stream, before it returns, so a crash
    /// immediately after can never lose the fact that `seq` was applied.
    ///
    /// **What `FileCursorStore` actually delivers is ATOMICITY, not durability** — write-temp +
    /// `rename(2)`, with **no `fsync`** on the temp file or its directory. A reader therefore always
    /// sees a complete table (never a torn one), and a PROCESS crash cannot lose an advance; a
    /// KERNEL panic or power loss inside the writeback window can. That is the right trade here (the
    /// direction of loss is safe: a stale cursor re-delivers events that dedup absorbs, never skips
    /// one) — but it is not what "durable" usually promises, and the comment used to say "fsyncs",
    /// which it has never done. Recorded so nobody weakens this believing they are giving up an
    /// fsync that is not there.
    func advance(host: String, session: String, stream: String, to seq: Int) throws
}

/// The composite identity of one replay cursor. `Codable` so `FileCursorStore` can round-trip a
/// flat record array (a delimiter-joined string key would be ambiguous for arbitrary ids).
struct CursorKey: Hashable, Codable, Sendable {
    let host: String
    let session: String
    let stream: String
}

/// One on-disk cursor row — a flat `{host, session, stream, seq}` record, encoded as an array so
/// arbitrary host/session/stream strings never collide the way a joined string key could.
private struct CursorRecord: Codable {
    let host: String
    let session: String
    let stream: String
    let seq: Int
}

/// In-memory `CursorStore` for tests and ephemeral use — a lock-guarded dictionary, no persistence.
/// `Sendable` via the `OSAllocatedUnfairLock` box (same posture as `ScriptedRemoteConn`); `advance`
/// is non-mutating (the struct is passed as a `let` into the actor) because all mutation lands
/// inside the lock's protected state, never on the struct itself.
public struct InMemoryCursorStore: CursorStore {
    private let state = OSAllocatedUnfairLock(initialState: [CursorKey: Int]())

    public init() {}

    public func cursor(host: String, session: String, stream: String) -> Int? {
        state.withLock { $0[CursorKey(host: host, session: session, stream: stream)] }
    }

    public func advance(host: String, session: String, stream: String, to seq: Int) throws {
        state.withLock { $0[CursorKey(host: host, session: session, stream: stream)] = seq }
    }
}

/// Errors the file-backed cursor store surfaces (a failed atomic rename, most likely).
public enum CursorStoreError: Error, Equatable {
    case renameFailed(Int32)
}

/// File-backed `CursorStore` — an atomically-persisted JSON record array at an injected URL, always
/// written `0600`. Each `advance` writes the whole table to a fresh temp file (chmod `0600`) then
/// `rename(2)`s it over the target: `rename` is atomic on a single filesystem and replaces the
/// destination, so a crash mid-write can only ever leave the previous complete table, never a torn
/// one. A fresh instance loads the persisted table in `init`, so a cursor survives process restart.
public struct FileCursorStore: CursorStore {
    private let url: URL
    /// Write-through in-memory mirror of the on-disk table — read path is lock-only (no per-read
    /// disk hit), write path updates the mirror and flushes atomically under the same lock.
    private let state = OSAllocatedUnfairLock(initialState: [CursorKey: Int]())

    public init(url: URL) throws {
        self.url = url
        if let data = try? Data(contentsOf: url),
           let records = try? JSONDecoder().decode([CursorRecord].self, from: data) {
            var loaded: [CursorKey: Int] = [:]
            for r in records {
                loaded[CursorKey(host: r.host, session: r.session, stream: r.stream)] = r.seq
            }
            let snapshot = loaded
            state.withLock { $0 = snapshot }
        }
    }

    public func cursor(host: String, session: String, stream: String) -> Int? {
        state.withLock { $0[CursorKey(host: host, session: session, stream: stream)] }
    }

    public func advance(host: String, session: String, stream: String, to seq: Int) throws {
        try state.withLock { table in
            table[CursorKey(host: host, session: session, stream: stream)] = seq
            try Self.persist(table, to: url)
        }
    }

    /// Atomic temp+rename write, final file `0600`. Synchronous I/O only — the lock is held for the
    /// duration but never across an `await` (there is none), so the actor's no-lock-across-await
    /// invariant is untouched.
    private static func persist(_ table: [CursorKey: Int], to url: URL) throws {
        let records = table.map { CursorRecord(host: $0.key.host, session: $0.key.session, stream: $0.key.stream, seq: $0.value) }
        let data = try JSONEncoder().encode(records)
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent(".cursors-\(UUID().uuidString).tmp")
        try data.write(to: tmp)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
        let rc = url.path.withCString { dst in tmp.path.withCString { src in rename(src, dst) } }
        guard rc == 0 else {
            try? FileManager.default.removeItem(at: tmp)
            throw CursorStoreError.renameFailed(errno)
        }
    }
}
