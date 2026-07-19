import Foundation
import os
import NormaProtocol
import NormaSessionKit
import IrohLib

/// The real iroh transport behind SP1's `RemoteListener` seam: the Mac binds an iroh
/// endpoint on the private ALPN `computer.norma.rpc/1`, accepts inbound phone connections,
/// and hands the gateway one `IrohConn` per authenticated peer. Each `IrohConn` adapts the
/// accepted QUIC bidirectional stream to the gateway's frame-oriented `RemoteConn`
/// contract, de-framing the raw byte stream into whole `WireEnvelope` frames via
/// `NormaProtocol.LengthPrefix`.
///
/// DEV-STUB PAIRING (SP2b seam): this listener accepts ANY peer that authenticates on the
/// ALPN — there is no allowlist or pairing ceremony yet. That is why `IrohListener` is
/// NEVER constructed in the shipped app (only tests / the dev harness build it); the
/// gateway's own construction-seam comment guards the production path. SP2b replaces the
/// "accept any authenticated peer" policy below with the real allowlist + pairing epoch.
///
/// Concurrency: the accept loop runs on its own `Task`; each accepted connection's mutable
/// state lives in `IrohConn` (a serialized-write actor + a read loop) — no `NSLock` is ever
/// held across an `await` (SP2a gate G6).
public final class IrohListener: RemoteListener, @unchecked Sendable {
    /// The private ALPN this listener accepts — and ONLY this. A dialer negotiating any
    /// other protocol is rejected at accept (iroh fails ALPN negotiation for unadvertised
    /// protocols; `accept` re-checks defensively).
    public static let defaultALPN = "computer.norma.rpc/1"

    public let connections: AsyncStream<RemoteConn>
    private let cont: AsyncStream<RemoteConn>.Continuation

    /// The bound iroh endpoint. Retained for the listener's whole lifetime.
    private let endpoint: Endpoint
    private let acceptTask: Task<Void, Never>
    /// Tracks the accept loop's per-incoming handshake sub-tasks (SP2b Task 1) so `stop()` can
    /// structurally cancel every still-running one instead of leaving them to finish unattended.
    private let acceptSubTasks = TaskBag()

    /// Dev/test hook: the address a dialer uses to reach this listener (id + bound
    /// address). Not part of the `RemoteListener` protocol — production discovery goes
    /// through relay/pairing tickets, which SP2b builds.
    public var endpointAddr: EndpointAddr { endpoint.addr() }
    /// Dev/test hook: this listener's own authenticated EndpointID.
    public var endpointID: EndpointId { endpoint.id() }

    /// Binds an iroh endpoint from `secret` and starts accepting on `alpn`.
    ///
    /// - Parameters:
    ///   - secret: the 32-byte endpoint secret key (identity of this Mac).
    ///   - alpn: the private ALPN to accept on. Defaults to `computer.norma.rpc/1`.
    ///   - relayURLs: LEGACY relay seam — empty disables relays entirely (in-process / loopback /
    ///     same-LAN dev use), non-empty means custom relays by URL. Superseded by `relays` below;
    ///     retained so existing call sites (the hermetic loopback suite, the live-gate
    ///     `IrohRelayE2ETests`) compile unchanged. Ignored whenever `relays` is non-nil.
    ///   - relays: explicit relay selection (`.disabled` / `.n0Default` / `.custom`). `nil` (the
    ///     default) falls back to the legacy `relayURLs` behavior above, keeping every existing
    ///     caller hermetic. Production (`RemoteHost`) passes `.n0Default` so this Mac registers
    ///     with n0's public relays and becomes reachable from a phone on another network.
    ///   - bindAddr: dev/test hook to pin the bind address (e.g. `"127.0.0.1:0"` for a
    ///     hermetic loopback test — see task-0-report.md on why wildcard bind + `addr()`
    ///     enrichment is non-deterministic in sandboxed environments). `nil` lets iroh
    ///     choose (the production default).
    ///   - maxFrameBytes: hard cap on a single de-framed frame (oversize → the connection's
    ///     inbound stream ends).
    public static func start(
        secret: Data,
        alpn: String = defaultALPN,
        relayURLs: [String] = [],
        relays: RelaySelection? = nil,
        bindAddr: String? = nil,
        maxFrameBytes: Int = 1 << 20
    ) async throws -> IrohListener {
        let alpnData = Data(alpn.utf8)
        let relayMode = try RelaySelection.resolve(relays: relays, legacyURLs: relayURLs)
        let endpoint = try await Endpoint.bind(options: EndpointOptions(
            preset: presetN0(),
            bindAddr: bindAddr,
            secretKey: secret,
            alpns: [alpnData],
            relayMode: relayMode
        ))
        return IrohListener(endpoint: endpoint, alpn: alpnData, maxFrameBytes: maxFrameBytes)
    }

    private init(endpoint: Endpoint, alpn: Data, maxFrameBytes: Int) {
        self.endpoint = endpoint
        var c: AsyncStream<RemoteConn>.Continuation!
        self.connections = AsyncStream { c = $0 }
        self.cont = c
        let cont = c!
        let bag = acceptSubTasks
        // The accept loop captures only Sendable values (endpoint, alpn bytes, the
        // continuation, the task bag) — never `self` — so it needs no init-completion ordering.
        self.acceptTask = Task {
            await IrohListener.acceptLoop(
                endpoint: endpoint, alpn: alpn, cont: cont, maxFrameBytes: maxFrameBytes, bag: bag
            )
        }
    }

    public func stop() {
        acceptTask.cancel()
        // SP2b Task 1: cancel every in-flight per-incoming handshake sub-task too. This can't
        // interrupt an in-flight uniffi call (no cancellation handler — closing the endpoint
        // below is what actually unblocks those), but it does make teardown structured: combined
        // with `accept`'s `Task.isCancelled` guard at the yield site, it prevents a straggler
        // handshake that finishes AFTER `stop()` from still `cont.yield`ing a `RemoteConn` into a
        // connections stream that has already been told to finish.
        acceptSubTasks.cancelAll()
        cont.finish()
        // Close the endpoint off the caller's thread (Endpoint.close is async). Closing is
        // also what actually unblocks the accept loop: `acceptNext()` ignores Swift task
        // cancellation (uniffi futures have no cancellation handler) but returns nil once
        // the endpoint closes.
        let ep = endpoint
        Task { try? await ep.close() }
    }

    /// Safety net: the accept loop deliberately does NOT capture `self` (no retain cycle),
    /// so a listener dropped without `stop()` would otherwise leave an orphaned accept loop
    /// holding the endpoint bound forever. `stop()` is idempotent-enough for this
    /// (double-finish of the stream and double-close of the endpoint are both no-ops).
    deinit {
        stop()
    }

    // MARK: - Accept loop

    private static func acceptLoop(
        endpoint: Endpoint,
        alpn: Data,
        cont: AsyncStream<RemoteConn>.Continuation,
        maxFrameBytes: Int,
        bag: TaskBag
    ) async {
        while !Task.isCancelled {
            guard let incoming = await endpoint.acceptNext() else { break } // endpoint closed
            // Handshake each incoming on its own task so one slow/hostile peer can't stall
            // acceptance of the next. Tracked in `bag` (SP2b Task 1) so `stop()` can cancel any
            // still-running stragglers structurally; the task removes its own entry once
            // `accept` returns (or drops), whichever comes first.
            let id = UUID()
            let task = Task {
                await IrohListener.accept(
                    incoming, alpn: alpn, cont: cont, maxFrameBytes: maxFrameBytes
                )
                bag.remove(id)
            }
            bag.insert(id, task: task)
        }
        cont.finish()
    }

    private static func accept(
        _ incoming: Incoming,
        alpn: Data,
        cont: AsyncStream<RemoteConn>.Continuation,
        maxFrameBytes: Int
    ) async {
        do {
            let accepting = try await incoming.accept()
            // Reject a foreign ALPN at accept (defense-in-depth; iroh already refuses
            // unadvertised protocols during negotiation). Dropping `accepting` closes it.
            let negotiated = try await accepting.alpn()
            guard negotiated == alpn else { return }

            let conn = try await accepting.connect()
            // SP2b SEAM: dev-stub pairing accepts ANY authenticated peer here. The real
            // allowlist / pairing-epoch check goes at this point.
            let bi = try await conn.acceptBi()
            let peerID = conn.remoteId().description
            // SP2b Task 1: a `stop()` that raced ahead of this handshake finishing must not let
            // this straggler hand a fresh RemoteConn to a connections stream already told to
            // finish — dropping `conn`/`bi` here (never wrapped in an `IrohConn`) tears the
            // just-accepted QUIC connection down via the same ARC-drop mechanism the LIFETIME
            // note on `IrohConn` documents, which is exactly the desired outcome for a
            // connection nobody will ever consume.
            if !Task.isCancelled {
                cont.yield(IrohConn(connection: conn, bi: bi, peerID: peerID, maxFrameBytes: maxFrameBytes))
            }
        } catch {
            // Handshake failed, peer went away, or ALPN was refused — drop silently. The
            // dev-stub has no reporting surface; SP2b's pairing layer will observe rejects.
        }
    }
}

/// Tracks the accept loop's per-incoming handshake sub-tasks (SP2b Task 1). A small,
/// self-contained bookkeeping type — separate from `IrohListener` itself — so its lock is never
/// held across an `await` (SP2a gate G6): every method here is a synchronous critical section.
private final class TaskBag: @unchecked Sendable {
    private let tasks = OSAllocatedUnfairLock<[UUID: Task<Void, Never>]>(initialState: [:])

    /// Registers `task` under `id`. `id` is minted by the caller BEFORE the task is created (so
    /// the task's own body can capture it by value to remove itself) — a task that races ahead
    /// and calls `remove(id)` before this runs is harmless: removing an absent key is a no-op,
    /// and the (already-finished) task just sits in the bag until `cancelAll()` sweeps it, where
    /// cancelling an already-completed task is itself a no-op.
    func insert(_ id: UUID, task: Task<Void, Never>) {
        tasks.withLock { $0[id] = task }
    }

    func remove(_ id: UUID) {
        _ = tasks.withLock { $0.removeValue(forKey: id) }
    }

    /// Cancels every currently-tracked task and empties the bag. Safe to call from `stop()`
    /// concurrently with tasks still removing themselves — the lock serializes both.
    func cancelAll() {
        let all = tasks.withLock { t -> [Task<Void, Never>] in
            let values = Array(t.values)
            t.removeAll()
            return values
        }
        for task in all { task.cancel() }
    }
}
