import Foundation
import NormaKit

/// Trips exactly once; returns `true` only for the tripping caller. A private twin of NormaKit's
/// own `UnixSocketTransport.OnceFlag` — that one is internal to NormaKit's module and not visible
/// here, so this repeats the same ten lines rather than reaching across a module boundary for
/// them.
final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var tripped = false
    func trip() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if tripped { return false }
        tripped = true
        return true
    }
}

/// One client connection to an office helper's Unix socket: line-buffered NDJSON framing over
/// NormaKit's `UnixSocketTransport`, plus a single-outstanding-request/response primitive with a
/// timeout. Owns no retry policy and no process lifecycle — `OfficeHelperSupervisor` layers both
/// on top. `OfficeSupervisorTests`' token-mismatch case uses this directly, with no supervisor
/// involved, to assert the WIRE PROTOCOL's own refusal behavior against the fake helper fixture.
///
/// **Only one outstanding `nextFrame` wait at a time.** Every Stage A caller (the supervisor's own
/// handshake; `OfficeHelperClient`'s ping/open/close) always awaits one reply before sending the
/// next request — there is no pipelining to support yet. `nextFrame` delivers frames to at most
/// one waiter; if none is waiting, decoded frames queue for the next call.
///
/// **Why not a `TaskGroup` race against `Task.sleep` for the timeout**, which looks like the
/// obvious shape: a `for await` loop over `transport.incoming` does not actually stop when its
/// enclosing `Task` is cancelled — `AsyncStream.Iterator.next()` isn't a cancellation-checking
/// suspension point — so `group.cancelAll()` on the timeout winning leaves the reader child
/// un-finished, and `withTaskGroup` awaits every child before it can return: the whole call would
/// hang forever the first time a peer went silent instead of replying (exactly the "silent"
/// fixture mode this connection has to survive). Instead, ONE persistent reader `Task` (started in
/// `open()`, living for the connection's whole lifetime) continuously drains `transport.incoming`
/// into `frameQueue` / hands frames straight to a waiting continuation; `nextFrame`'s timeout is a
/// second, fully independent `Task.sleep` that races only via a shared `OnceFlag`-guarded
/// continuation — never via structured cancellation of the reader.
final class OfficeWireConnection: @unchecked Sendable {
    private struct PendingWait {
        let once: OnceFlag
        let continuation: CheckedContinuation<OfficeWireFrame?, Never>
    }

    private let transport: NormaTransport
    private let lock = NSLock()
    private var buffer = Data()
    /// Task 4 — how many leading bytes of `buffer` are ALREADY confirmed newline-free. Without
    /// this, `ingest`'s newline scan restarted from `buffer.startIndex` on every call — fine for
    /// the small control frames every OTHER frame in this file produces, but a single `tile` push
    /// (base64 RGBA pixels, ~1.4MB as text — the transport decision's own chosen rung, see
    /// `OfficeWireFrame.tile`'s header) commonly arrives split across many `UnixSocketTransport`
    /// read chunks: each `ingest` call before the terminating newline appears would re-scan the
    /// ENTIRE buffer accumulated so far, making total scan cost quadratic in the line's length
    /// (caught during this task's own transport measurement, not by a correctness test — a
    /// confounder that would have inflated every arrival-latency number). Reset to 0 only when a
    /// line is actually consumed (`removeSubrange` shifts everything after it down to index 0,
    /// invalidating any prior "scanned up to here" offset); advanced to `buffer.count` whenever a
    /// scan finds no newline in the new tail, so the NEXT call resumes exactly where this one left
    /// off. Net effect: every byte is scanned at most once as part of finding the line it belongs
    /// to — linear in total bytes, not quadratic in chunk count.
    private var scannedPrefixLength = 0
    private var frameQueue: [OfficeWireFrame] = []
    private var waiter: PendingWait?
    private var streamClosed = false
    private var readerTask: Task<Void, Never>?

    /// Fired at most once, when the underlying transport reports closed — from whatever thread/
    /// queue the transport's own state machine runs on. `OfficeHelperSupervisor` hops back to
    /// `@MainActor` itself; this connection makes no isolation promises about when it fires.
    var onClosed: (@Sendable () -> Void)?

    /// Task 3 — fires for every `.documentEvent` frame this connection receives, from the
    /// reader task's own thread (no isolation promise, same as `onClosed`). **Never delivered
    /// through `nextFrame`/`frameQueue`** — see `ingest(_:)`'s own comment for the real bug this
    /// avoids: before Task 3, every frame a helper could send was a direct reply to a request this
    /// connection's single outstanding `nextFrame` waiter was already expecting. A `.documentEvent`
    /// push has no such waiter — it can arrive between two ordinary requests. Queuing it into the
    /// SAME `frameQueue` a `ping`/`open`/`close` call drains would let it be handed to whichever
    /// call is CURRENTLY awaiting a reply, failing that call with a seq mismatch while the real
    /// reply it should have gotten sits queued behind the misdelivered push — a real, reachable bug
    /// the moment async pushes exist on a connection also doing ordinary request/response traffic
    /// (proven by `testDocumentEventPushDoesNotStarveAConcurrentPingReply` in
    /// `OfficeHelperLiveTests`). Routing by CASE at ingest time, before anything touches
    /// `frameQueue`, is what keeps the two streams apart with no dependency on tracking outstanding
    /// seqs. `nil` (the default): pushes are silently dropped — correct for every Stage A caller
    /// except the one that sets this (`OfficeHelperClient`, via `OfficeHelperSupervisor`).
    var onDocumentEvent: (@Sendable (String, OfficeDocumentEvent) -> Void)?

    /// Task 4 — the same "never through `frameQueue`" routing as `onDocumentEvent` above, for the
    /// three NEW push-only frame types tiles introduce. `.subscribed`/`.unsubscribed`/
    /// `.tileRequestAccepted` are direct, seq-correlated REPLIES (awaited via the normal
    /// `nextFrame`/`expectReply` path in `OfficeHelperClient`, exactly like `opened`/`closed`) and
    /// are deliberately NOT listed here — only frames the helper sends WITHOUT a matching
    /// outstanding request need this treatment.
    var onTile: (@Sendable (String, TileKey, Int, Int, Int, String) -> Void)?      // docId, key, generation, width, height, pixelsBase64
    var onTileFailed: (@Sendable (String, TileKey, String) -> Void)?               // docId, key, reason
    var onInvalidated: (@Sendable (String, [TileKey]) -> Void)?                    // docId, keys

    init(socketPath: String) {
        transport = UnixSocketTransport(path: socketPath)
    }

    /// Connects and starts the persistent background reader. Throws whatever
    /// `UnixSocketTransport.open()` throws (including its own ~3s internal connect timeout) if the
    /// socket cannot be reached at all.
    func open() async throws {
        try await transport.open()
        let incoming = transport.incoming
        readerTask = Task { [weak self] in
            for await event in incoming {
                guard let self else { return }
                switch event {
                case .data(let data): self.ingest(data)
                case .closed: self.ingestClosed()
                }
            }
        }
    }

    func send(_ frame: OfficeWireFrame) async throws {
        try await transport.send(frame.encodedLine())
    }

    /// Bypasses `OfficeWireFrame` encoding to send arbitrary bytes — test-only (F4's regression
    /// tests construct a deliberately invalid-UTF-8 line this way; nothing in production code ever
    /// needs to send bytes that aren't a well-formed frame).
    func sendRaw(_ data: Data) async throws {
        try await transport.send(data)
    }

    /// Waits for the next frame this connection hasn't yet delivered. `nil` on timeout OR the
    /// connection closing first — callers that must tell those apart check `isClosed` afterward.
    ///
    /// **The frameQueue/streamClosed check and the waiter registration happen under ONE lock
    /// hold, inside the continuation body — not as a separate fast-path check before it.** An
    /// earlier version checked `frameQueue` first, unlocked, and only then registered the waiter
    /// inside `withCheckedContinuation`: the reader task could `ingest()` a frame in the gap
    /// between those two lock holds, see no waiter yet registered, and leave it queued —
    /// delivering nothing, so the waiter that registers a moment later starves for the full
    /// `timeout` with its answer already sitting in `frameQueue`. A real request that should have
    /// returned instantly would instead read as a timeout, intermittently. Doing both checks and
    /// the registration atomically closes that window.
    func nextFrame(timeout: TimeInterval) async -> OfficeWireFrame? {
        await withCheckedContinuation { (continuation: CheckedContinuation<OfficeWireFrame?, Never>) in
            let once = OnceFlag()
            lock.lock()
            if !frameQueue.isEmpty {
                let frame = frameQueue.removeFirst()
                lock.unlock()
                if once.trip() { continuation.resume(returning: frame) }
                return
            }
            if streamClosed {
                lock.unlock()
                if once.trip() { continuation.resume(returning: nil) }
                return
            }
            waiter = PendingWait(once: once, continuation: continuation)
            lock.unlock()

            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                self.clearWaiterIfStillPending(once)
                if once.trip() { continuation.resume(returning: nil) }
            }
        }
    }

    /// If `waiter` is still the one registered under `once` (i.e. `ingest`/`ingestClosed` hasn't
    /// already claimed and cleared it), clear it — so a frame arriving AFTER this timeout has
    /// already fired finds no waiter to (incorrectly) resume a second time. A plain, non-async
    /// function on purpose: `NSLock.lock()`/`.unlock()` are marked unavailable from a LEXICALLY
    /// async context (a Swift 6 error, a warning here) — calling them from inside this ordinary
    /// function, itself called from `Task { }`'s async closure, is the sanctioned way to bridge
    /// that, exactly as Apple's own migration guidance for `noasync` APIs describes.
    private func clearWaiterIfStillPending(_ once: OnceFlag) {
        lock.lock()
        if waiter?.once === once { waiter = nil }
        lock.unlock()
    }

    var isClosed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return streamClosed
    }

    func close() {
        readerTask?.cancel()
        transport.close()
        // Do not rely on the reader task to notice `.closed` promptly — it may already be
        // cancelled, and cancellation does not interrupt a suspended `for await` (see the header
        // comment). Wake any waiter directly.
        ingestClosed()
    }

    // MARK: - Reader-side ingestion (called from the reader Task only)

    private func ingest(_ data: Data) {
        var toDeliver: OfficeWireFrame?
        var pending: PendingWait?
        var pushesToDeliver: [(String, OfficeDocumentEvent)] = []
        // Task 4 — the three new async-push shapes, collected the same way `pushesToDeliver`
        // already is (under `lock`, delivered to callbacks after `lock.unlock()` below).
        var tilesToDeliver: [(String, TileKey, Int, Int, Int, String)] = []
        var tileFailuresToDeliver: [(String, TileKey, String)] = []
        var invalidationsToDeliver: [(String, [TileKey])] = []
        lock.lock()
        buffer.append(data)
        while true {
            let searchStart = buffer.index(buffer.startIndex, offsetBy: scannedPrefixLength)
            guard let newlineIndex = buffer[searchStart...].firstIndex(of: 0x0A) else {
                scannedPrefixLength = buffer.count // nothing new to find until more bytes arrive
                break
            }
            let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
            scannedPrefixLength = 0 // the remaining buffer is a fresh, unscanned tail
            // F4 (T2 review), client side: an undecodable line is now LOGGED, not silently
            // dropped — "your call on shape, disclose it." Logging only, not surfaced as a
            // delivered frame: this client has no reply mechanism (it isn't the one being asked
            // anything), and forcibly handing an unrelated garbage line to whichever caller is
            // CURRENTLY awaiting `nextFrame` would misattribute it to that request, which is worse
            // than the request simply timing out normally. A malformed line from the helper is
            // also a signal something is more fundamentally wrong (a protocol version mismatch, a
            // corrupted stream) that a developer should be able to see in the log, not just infer
            // from a mysteriously timed-out request.
            if let line = String(data: lineData, encoding: .utf8) {
                if let frame = OfficeWireFrame.decode(line) {
                    // Task 3/4: unprompted PUSHES never go into `frameQueue` — routed straight to
                    // their own dedicated callback (see `onDocumentEvent`/`onTile`/`onTileFailed`/
                    // `onInvalidated`'s own headers for the real interleaving bug this avoids).
                    // Collected here, under THIS lock hold; delivered after `lock.unlock()` below —
                    // never invoke an arbitrary caller-supplied closure while holding `lock`.
                    switch frame {
                    case .documentEvent(_, let docId, let event):
                        pushesToDeliver.append((docId, event))
                    case .tile(_, let docId, let key, let generation, let width, let height, let pixelsBase64):
                        tilesToDeliver.append((docId, key, generation, width, height, pixelsBase64))
                    case .tileFailed(_, let docId, let key, let reason):
                        tileFailuresToDeliver.append((docId, key, reason))
                    case .invalidated(_, let docId, let keys):
                        invalidationsToDeliver.append((docId, keys))
                    default:
                        frameQueue.append(frame)
                    }
                } else {
                    NSLog("[OfficeWireConnection] dropped an undecodable line from the helper: %@", line)
                }
            } else {
                NSLog("[OfficeWireConnection] dropped a non-UTF-8 line from the helper (%d bytes)", lineData.count)
            }
        }
        if waiter != nil, !frameQueue.isEmpty {
            toDeliver = frameQueue.removeFirst()
            pending = waiter
            waiter = nil
        }
        lock.unlock()
        for (docId, event) in pushesToDeliver {
            onDocumentEvent?(docId, event)
        }
        for (docId, key, generation, width, height, pixelsBase64) in tilesToDeliver {
            onTile?(docId, key, generation, width, height, pixelsBase64)
        }
        for (docId, key, reason) in tileFailuresToDeliver {
            onTileFailed?(docId, key, reason)
        }
        for (docId, keys) in invalidationsToDeliver {
            onInvalidated?(docId, keys)
        }
        if let pending, let toDeliver, pending.once.trip() {
            pending.continuation.resume(returning: toDeliver)
        }
    }

    private func ingestClosed() {
        lock.lock()
        let alreadyClosed = streamClosed
        streamClosed = true
        let pending = waiter
        waiter = nil
        lock.unlock()
        if let pending, pending.once.trip() {
            pending.continuation.resume(returning: nil)
        }
        guard !alreadyClosed else { return }
        onClosed?()
    }
}
