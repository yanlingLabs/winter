import Foundation
import CryptoKit
import NormaProtocol

// ================================================================================================
// SyncClient (Chat Slice D task 9) — the phone half of the replication wire, the mirror image of
// packages/core/src/ipc/sync.ts. It reconciles the phone's `LocalEventStore` with the daemon's chat
// logs over three verbs (`sync.heads` / `sync.pull` / `sync.push`), plus two session-less bootstrap
// reads (`sync.config` / `sync.memory`). It speaks through a minimal `RpcConn` the app implements
// over its EXISTING paired connection — the client owns none of the transport, so every unit test
// drives a scripted double and never opens a socket.
//
// THE ONE HARD RULE (T2 review correction, restated at the seam): a `DIVERGED` error is read off its
// `data.lastSeq`, NEVER off the bare code. `lastSeq: 0` means the daemon holds NOTHING for this id —
// the answer is "re-push from seq 1", which CREATES it, not "fork". Only a non-zero `lastSeq` is a
// real branch point that forks. A client that forks on the bare code spawns a spurious fork for
// every retry after a partial failure. See `push` below.
// ================================================================================================

/// A JSON-RPC failure surfaced from the transport. `divergedLastSeq` is `data.lastSeq` parsed out of
/// an `ERR.DIVERGED` payload (the branch point, or 0 for "daemon has nothing") — the ONE field the
/// fork logic keys on.
public struct RpcError: Error, Equatable {
    public let code: Int
    public let message: String
    public let divergedLastSeq: Int?
    public init(code: Int, message: String, divergedLastSeq: Int? = nil) {
        self.code = code
        self.message = message
        self.divergedLastSeq = divergedLastSeq
    }
}

/// The narrow seam the app fills over its paired connection. One method: send a JSON-RPC request
/// (method + already-encoded params object) and hand back the `result` value's raw JSON bytes, or
/// throw `RpcError` carrying the JSON-RPC `code` and — for `DIVERGED` — `data.lastSeq`. Keeping it
/// byte-in/byte-out (not typed) decouples the client from whatever RPC stack the app already runs.
public protocol RpcConn: Sendable {
    func call(method: String, paramsJSON: Data) async throws -> Data
}

// ------------------------------------------------------------------------------------------------
// Wire shapes — the Swift mirrors of the T2/T3 result/param schemas (packages/protocol/src/methods.ts).
// ------------------------------------------------------------------------------------------------

/// One row of `sync.heads` — a daemon chat session's head plus its index-only facts.
public struct SyncHead: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let lastSeq: Int
    public let title: String?          // `null` on the wire when the session has none
    public let model: String?
    public let forkedFrom: SessionForkRef?
}

struct SyncHeadsResult: Decodable { let sessions: [SyncHead] }
struct SyncPullResult: Decodable { let data: String; let nextCursor: Int?; let complete: Bool }
struct SyncPushResult: Decodable { let applied: Bool; let lastSeq: Int; let buffered: Int }

/// `sync.config` — a freshly-paired phone's bootstrap for its OWN local chat.
public struct SyncConfig: Codable, Equatable, Sendable {
    public let exaKey: String?
    public let dangerousDomains: [String]
    public let defaultModel: String
    public init(exaKey: String?, dangerousDomains: [String], defaultModel: String) {
        self.exaKey = exaKey
        self.dangerousDomains = dangerousDomains
        self.defaultModel = defaultModel
    }
}

/// One replicated `_assistant` memory file.
public struct SyncMemoryFile: Decodable, Equatable, Sendable {
    public let name: String
    public let content: String
}
struct SyncMemoryResult: Decodable { let files: [SyncMemoryFile]; let nextCursor: Int?; let complete: Bool }

// Param encoders. Optionals are synthesized with `encodeIfPresent`, so a nil field is ABSENT on the
// wire (never `null`) — exactly what the daemon's optional schema fields expect.
private struct HeadsParams: Encodable {}
private struct PullParams: Encodable { let sessionId: String; let fromSeq: Int; let cursor: Int? }
private struct PushMetaParams: Encodable { let title: String?; let model: String?; let forkedFrom: SessionForkRef? }
private struct PushParams: Encodable { let sessionId: String; let baseSeq: Int; let data: String; let complete: Bool; let meta: PushMetaParams? }
private struct ConfigParams: Encodable {}
private struct MemoryParams: Encodable { let cursor: Int? }

// ------------------------------------------------------------------------------------------------
// SyncClient
// ------------------------------------------------------------------------------------------------

public actor SyncClient {
    private let store: LocalEventStore
    private let conn: RpcConn

    /// Hard ceiling on ONE `sync.push` chunk's base64 payload — the Swift mirror of the protocol's
    /// `SYNC_MAX_CHUNK_B64` (384 KiB), sized so a maximal chunk in its JSON-RPC envelope clears the
    /// phone transport's 1 MiB iroh frame with margin.
    public static let maxChunkBase64 = 384 * 1024
    /// Raw bytes per push chunk, chosen so its base64 (×4/3) stays under `maxChunkBase64` — the same
    /// 256 KiB the daemon's own `sync-core` drill uses (349,528 base64 chars, well under the cap).
    static let rawChunkBytes = 256 * 1024

    /// The base64 length of `raw` bytes — 4 characters per 3-byte group, padded. The arithmetic the
    /// `rawChunkBytes` ↔ `maxChunkBase64` relationship rests on; asserted in the suite (review M3).
    static func base64Length(ofRawBytes raw: Int) -> Int { ((raw + 2) / 3) * 4 }

    /// Raw bytes per push chunk for THIS client — `rawChunkBytes` in production; tests inject a tiny
    /// value to exercise multi-chunk reassembly without a quarter-MiB payload. CLAMPED so no caller
    /// (or future edit) can pick a size whose base64 breaches `maxChunkBase64`, which the daemon
    /// enforces hard with `data: z.string().max(SYNC_MAX_CHUNK_B64)` — over it, the push is refused
    /// outright, and on the phone transport an oversized frame ENDS the connection rather than
    /// returning an error (review M3: the ceiling was a comment, not a guard).
    private let chunkBytes: Int

    public init(store: LocalEventStore, conn: RpcConn) {
        self.init(store: store, conn: conn, chunkBytes: SyncClient.rawChunkBytes)
    }

    init(store: LocalEventStore, conn: RpcConn, chunkBytes: Int) {
        self.store = store
        self.conn = conn
        let maxRaw = (SyncClient.maxChunkBase64 / 4) * 3 // the largest raw size whose base64 still fits
        self.chunkBytes = max(1, min(chunkBytes, maxRaw))
    }

    // MARK: - syncAll

    /// One full reconcile pass: exchange heads, pull every daemon session/range the phone is behind
    /// on, then push every local-ahead session. Called at a turn boundary (never mid-turn), so the
    /// common case is a clean fast-forward in one direction; a genuine two-sided divergence resolves
    /// through the fork dance in `push`.
    @discardableResult
    public func syncAll() async throws -> [SyncHead] {
        let heads = try await headsCall()
        let headsById = Dictionary(uniqueKeysWithValues: heads.map { ($0.sessionId, $0) })

        // 1. PULL: daemon sessions the phone has never seen, or is strictly behind on with no local
        //    divergence. A session with local-ahead events (localLast > localSynced) is left for the
        //    push phase, where a real divergence forks rather than clobbering the local tail.
        for head in heads {
            let localLast = await store.lastSeq(sessionId: head.sessionId)
            let localSynced = await store.lastSyncedSeq(sessionId: head.sessionId)
            if head.lastSeq > localSynced && localLast == localSynced {
                try await pull(head: head, fromSeq: localSynced)
            }
        }

        // 2. PUSH: every session whose local head is ahead of what the daemon has confirmed.
        for meta in await store.sessions() where meta.lastSeq > meta.lastSyncedSeq {
            try await push(sessionId: meta.sessionId, headsById: headsById)
        }
        return heads
    }

    // MARK: - pull

    /// Pages `sync.pull` from `fromSeq` to the end, concatenates the base64 pages into the verbatim
    /// tail, and applies it to the store (creating the session when the phone doesn't hold it yet).
    ///
    /// The watermark is set by `applyPull` from the head it ACTUALLY applied — never from `head`,
    /// the `sync.heads` snapshot taken before the pull (review C1). A Mac append landing inside the
    /// pull window makes the pull return more than the snapshot advertised; recording the snapshot
    /// would then leave the session permanently one push away from a spurious fork.
    private func pull(head: SyncHead, fromSeq: Int) async throws {
        let bytes = try await pullBytes(sessionId: head.sessionId, fromSeq: fromSeq)
        try await store.applyPull(sessionId: head.sessionId, data: bytes,
                                  title: .some(head.title), model: .some(head.model),
                                  forkedFrom: .some(head.forkedFrom))
    }

    /// Drains `sync.pull` page by page (cursor-resumed) and returns the concatenated raw JSONL bytes.
    private func pullBytes(sessionId: String, fromSeq: Int) async throws -> Data {
        var acc = Data()
        var cursor: Int? = nil
        var guardPages = 0
        while true {
            let raw = try await conn.call(method: METHODS.syncPull,
                                          paramsJSON: encode(PullParams(sessionId: sessionId, fromSeq: fromSeq, cursor: cursor)))
            let page = try JSONDecoder().decode(SyncPullResult.self, from: raw)
            if let chunk = Data(base64Encoded: page.data) { acc.append(chunk) }
            if page.complete { break }
            cursor = page.nextCursor
            guardPages += 1
            if guardPages > 10_000 { throw RpcError(code: ERR_INTERNAL, message: "sync.pull did not terminate") }
        }
        return acc
    }

    // MARK: - push (+ fork)

    /// Pushes a session's local-ahead tail. On `DIVERGED` it branches on `data.lastSeq`:
    ///   • `0`  → the daemon has nothing for this id: re-push the WHOLE log from seq 1 (a creating
    ///            push). NOT a fork — that would spawn a spurious session for a mere retry.
    ///   • `>0` → a genuine two-sided divergence: fork the local branch off and pull the daemon's.
    private func push(sessionId: String, headsById: [String: SyncHead]) async throws {
        let meta = try await metaSnapshot(sessionId)
        let baseSeq = meta.lastSyncedSeq
        let tail = await store.rawTail(sessionId: sessionId, fromSeq: baseSeq)
        if tail.isEmpty { return }
        let pushMeta = PushMetaParams(title: meta.title, model: meta.model, forkedFrom: meta.forkedFrom)
        do {
            let result = try await pushChunked(sessionId: sessionId, baseSeq: baseSeq, data: tail, meta: pushMeta)
            await store.setLastSyncedSeq(sessionId: sessionId, result.lastSeq)
        } catch let e as RpcError where e.code == ERR_DIVERGED {
            guard let daemonLast = e.divergedLastSeq else { throw e }
            if daemonLast == 0 {
                // Re-push from seq 1 — a creating push over the whole log.
                let whole = await store.rawTail(sessionId: sessionId, fromSeq: 0)
                let result = try await pushChunked(sessionId: sessionId, baseSeq: 0, data: whole, meta: pushMeta)
                await store.setLastSyncedSeq(sessionId: sessionId, result.lastSeq)
            } else {
                try await reconcileDivergence(sessionId: sessionId, baseSeq: baseSeq,
                                              localTail: tail, pushMeta: pushMeta,
                                              daemonHead: headsById[sessionId])
            }
        }
    }

    /// `DIVERGED{lastSeq > 0}` means only that `baseSeq != daemonHead` — it is NOT proof that anything
    /// diverged (review I1). Three ordinary failures produce the identical error while the two logs
    /// agree completely:
    ///   • a push the daemon APPLIED whose acknowledgement was lost (connection drop, iOS suspending
    ///     the app mid-call — routine on this transport),
    ///   • a crash between the daemon's append and this side's sidecar write, and
    ///   • a retry after a fork push failed partway.
    /// Forking on any of them duplicates the conversation on BOTH devices, permanently, by hand-delete
    /// only. So: establish what actually differs before doing anything destructive. Pull the daemon's
    /// range from our own watermark and compare it byte-for-byte against the same local range.
    ///   • daemon ⊇ local (our bytes are a prefix of theirs) → they already HAVE our events; adopt
    ///     their remainder and fast-forward the watermark. NO fork.
    ///   • local ⊃ daemon (they are a strict prefix of us) → a plain fast-forward push from their head.
    ///   • otherwise → the branches genuinely differ: fork.
    private func reconcileDivergence(sessionId: String, baseSeq: Int, localTail: Data,
                                     pushMeta: PushMetaParams, daemonHead: SyncHead?) async throws {
        let daemonTail = try await pullBytes(sessionId: sessionId, fromSeq: baseSeq)

        if daemonTail.starts(with: localTail) {
            // Lost ACK (or a crash before the sidecar write): the daemon holds our bytes verbatim,
            // possibly plus events of its own. Append only what we are missing and adopt their head.
            let remainder = daemonTail.subdata(in: localTail.count..<daemonTail.count)
            if remainder.isEmpty {
                await store.setLastSyncedSeq(sessionId: sessionId, await store.lastSeq(sessionId: sessionId))
            } else {
                try await store.applyPull(sessionId: sessionId, data: remainder,
                                          title: .some(daemonHead?.title ?? nil), model: .some(daemonHead?.model ?? nil),
                                          forkedFrom: .some(daemonHead?.forkedFrom ?? nil))
            }
            return
        }

        if localTail.starts(with: daemonTail) {
            // The daemon is a strict PREFIX of us — nothing diverged, we are simply further ahead
            // than our watermark claimed. Push the remainder from their real head.
            let ahead = localTail.subdata(in: daemonTail.count..<localTail.count)
            guard !ahead.isEmpty else { return }
            let daemonLast = baseSeq + LocalChatSession.split(daemonTail).count
            let result = try await pushChunked(sessionId: sessionId, baseSeq: daemonLast, data: ahead, meta: pushMeta)
            await store.setLastSyncedSeq(sessionId: sessionId, result.lastSeq)
            return
        }

        // Genuine two-sided divergence.
        try await forkAndReconcile(originalId: sessionId, atSeq: baseSeq, daemonHead: daemonHead)
    }

    /// The full reconcile for a GENUINE divergence (only ever reached once `reconcileDivergence` has
    /// byte-proved the branches differ):
    ///   1. PLAN the fork of the entire local log at a DETERMINISTIC id (bytes rewritten at the
    ///      `sessionId` field only, seqs preserved) — computed, not yet written,
    ///   2. push it as a NEW session (`baseSeq: 0`, its own `session_created` opening it), and only
    ///      once that LANDS commit the local copy,
    ///   3. truncate the original's local log back to `atSeq` (the divergent tail now lives in the
    ///      fork) and pull the daemon's branch in its place.
    /// Postcondition: both stores hold BOTH sessions; the fork's log equals the original's pre-fork
    /// log with only the id field rewritten.
    ///
    /// PUSH-THEN-COMMIT, and a deterministic id, together close review I1's third trigger. The old
    /// order (create locally, then push) left an orphaned local fork behind whenever the push failed:
    /// the next pass pushed that orphan as another creating session AND minted a second fresh UUID —
    /// a transient network error accumulating duplicates. Now a failed push leaves nothing at all,
    /// and because the retry derives the SAME id from `originalId + atSeq`, a push that actually
    /// landed before the failure is recognised rather than duplicated.
    private func forkAndReconcile(originalId: String, atSeq: Int, daemonHead: SyncHead?) async throws {
        let newId = Self.forkId(originalId: originalId, atSeq: atSeq)
        let plan = try await store.planFork(originalId: originalId, newId: newId, atSeq: atSeq)
        let forkPushMeta = PushMetaParams(title: plan.title, model: plan.model, forkedFrom: plan.forkedFrom)
        do {
            let result = try await pushChunked(sessionId: newId, baseSeq: 0, data: plan.bytes, meta: forkPushMeta)
            await store.commitFork(plan, syncedSeq: result.lastSeq)
        } catch let e as RpcError where e.code == ERR_DIVERGED {
            // The deterministic id already exists on the daemon — this fork landed on an earlier
            // attempt whose acknowledgement we lost. Adopt it instead of minting a duplicate.
            guard let head = e.divergedLastSeq, head > 0 else { throw e }
            await store.commitFork(plan, syncedSeq: min(head, plan.lastSeq))
        }

        // Reconcile the original: drop the divergent tail, then pull the daemon's branch. The
        // watermark again comes from what was applied, not from the heads snapshot (C1).
        await store.truncate(sessionId: originalId, toSeq: atSeq)
        let branch = try await pullBytes(sessionId: originalId, fromSeq: atSeq)
        try await store.applyPull(sessionId: originalId, data: branch,
                                  title: .some(daemonHead?.title ?? nil), model: .some(daemonHead?.model ?? nil),
                                  forkedFrom: .some(daemonHead?.forkedFrom ?? nil))
    }

    /// A fork's id, derived DETERMINISTICALLY from its branch point so a retried reconcile targets the
    /// same session instead of minting a new one each attempt. Shaped as a v4-looking UUID because the
    /// daemon's creating-push path requires that form (`sync.ts`'s `SYNCED_SESSION_ID_RE`).
    static func forkId(originalId: String, atSeq: Int) -> String {
        var hasher = SHA256()
        hasher.update(data: Data("norma-chat-fork:\(originalId):\(atSeq)".utf8))
        var bytes = Array(hasher.finalize().prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x40 // version 4
        bytes[8] = (bytes[8] & 0x3F) | 0x80 // RFC 4122 variant
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let s = { (lo: Int, hi: Int) in String(hex[hex.index(hex.startIndex, offsetBy: lo)..<hex.index(hex.startIndex, offsetBy: hi)]) }
        return "\(s(0, 8))-\(s(8, 12))-\(s(12, 16))-\(s(16, 20))-\(s(20, 32))"
    }

    /// Splits `data` into base64 chunks under `maxChunkBase64` and pushes them in order. `meta` rides
    /// the FINAL (complete) chunk only — the daemon applies it alongside a successful complete
    /// (`syncPush` reads `p.meta` on the final frame). Returns the final result.
    private func pushChunked(sessionId: String, baseSeq: Int, data: Data, meta: PushMetaParams) async throws -> SyncPushResult {
        var offset = 0
        var last: SyncPushResult? = nil
        repeat {
            let end = min(offset + chunkBytes, data.count)
            let slice = data.subdata(in: offset..<end)
            let complete = end >= data.count
            let raw = try await conn.call(method: METHODS.syncPush, paramsJSON: encode(PushParams(
                sessionId: sessionId, baseSeq: baseSeq, data: slice.base64EncodedString(),
                complete: complete, meta: complete ? meta : nil)))
            last = try JSONDecoder().decode(SyncPushResult.self, from: raw)
            offset = end
        } while offset < data.count
        return last!
    }

    // MARK: - config / memory bootstrap (session-less)

    /// `sync.config` — the Exa key, the user's added dangerous domains, and the daemon's live default
    /// model, for a phone bootstrapping its OWN standalone chat.
    public func fetchConfig() async throws -> SyncConfig {
        let raw = try await conn.call(method: METHODS.syncConfig, paramsJSON: encode(ConfigParams()))
        return try JSONDecoder().decode(SyncConfig.self, from: raw)
    }

    /// `sync.memory` — the full (paged) replica of the shared `_assistant` memory bucket, so the
    /// phone's own context assembler can inject the same memory a Mac chat sees.
    public func fetchMemory() async throws -> [SyncMemoryFile] {
        var files: [SyncMemoryFile] = []
        var cursor: Int? = nil
        var guardPages = 0
        while true {
            let raw = try await conn.call(method: METHODS.syncMemory, paramsJSON: encode(MemoryParams(cursor: cursor)))
            let page = try JSONDecoder().decode(SyncMemoryResult.self, from: raw)
            files.append(contentsOf: page.files)
            if page.complete { break }
            cursor = page.nextCursor
            guardPages += 1
            if guardPages > 10_000 { throw RpcError(code: ERR_INTERNAL, message: "sync.memory did not terminate") }
        }
        return files
    }

    // MARK: - helpers

    private func headsCall() async throws -> [SyncHead] {
        let raw = try await conn.call(method: METHODS.syncHeads, paramsJSON: encode(HeadsParams()))
        return try JSONDecoder().decode(SyncHeadsResult.self, from: raw).sessions
    }

    private func metaSnapshot(_ sessionId: String) async throws -> LocalSessionMeta {
        for meta in await store.sessions() where meta.sessionId == sessionId { return meta }
        throw RpcError(code: ERR_INTERNAL, message: "push: local session \(sessionId) vanished")
    }

    private func encode<T: Encodable>(_ value: T) -> Data { (try? JSONEncoder().encode(value)) ?? Data("{}".utf8) }
}

// JSON-RPC error codes the client branches on (mirror packages/protocol/src/jsonrpc.ts's `ERR`).
let ERR_DIVERGED = -32006
let ERR_INTERNAL = -32603

// `METHODS` string constants the client sends. Kept as a tiny local mirror so NormaChatKit does not
// take a source dependency on the TS protocol's method table for five strings.
enum METHODS {
    static let syncHeads = "sync.heads"
    static let syncPull = "sync.pull"
    static let syncPush = "sync.push"
    static let syncConfig = "sync.config"
    static let syncMemory = "sync.memory"
}
