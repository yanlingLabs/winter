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
    private var frameQueue: [OfficeWireFrame] = []
    private var waiter: PendingWait?
    private var streamClosed = false
    private var readerTask: Task<Void, Never>?

    /// Fired at most once, when the underlying transport reports closed — from whatever thread/
    /// queue the transport's own state machine runs on. `OfficeHelperSupervisor` hops back to
    /// `@MainActor` itself; this connection makes no isolation promises about when it fires.
    var onClosed: (@Sendable () -> Void)?

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
        lock.lock()
        buffer.append(data)
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
            if let line = String(data: lineData, encoding: .utf8), let frame = OfficeWireFrame.decode(line) {
                frameQueue.append(frame)
            }
        }
        if waiter != nil, !frameQueue.isEmpty {
            toDeliver = frameQueue.removeFirst()
            pending = waiter
            waiter = nil
        }
        lock.unlock()
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
