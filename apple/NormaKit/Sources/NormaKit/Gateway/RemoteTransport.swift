import Foundation
import os

/// Server-side seam for the remote (iPhone) transport that `Gateway` (Gateway.swift) terminates.
/// SP2 implements this concretely over iroh (a QUIC-like P2P library); kept as a bare protocol
/// here so SP1 can build and test the gateway against an in-memory `LoopbackListener` +
/// `ScriptedRemoteConn` without any real networking dependency. No production listener is
/// constructed anywhere in SP1 — only tests build `LoopbackListener` (see Gateway.swift's own
/// construction-seam comment).
public protocol RemoteListener: Sendable {
    /// One element per accepted phone connection, for the listener's entire lifetime.
    var connections: AsyncStream<RemoteConn> { get }
    func stop()
}

/// One accepted phone connection: a duplex channel of already-framed `WireEnvelope` JSON frames.
/// A concrete network-backed implementation (SP2's iroh listener) owns its OWN byte-stream
/// framing internally (e.g. via `NormaProtocol.LengthPrefix`) and hands the gateway one discrete
/// frame's bytes per `inbound` element / `send(_:)` call — the gateway itself never touches
/// length-prefix framing, only whole `WireEnvelope` frames.
public protocol RemoteConn: Sendable {
    var inbound: AsyncStream<Data> { get }
    /// Stable identity of the remote peer on the other end (SP2's iroh listener supplies the
    /// verified node id; the scripted test double returns a fixed stub). Load-bearing for SP2a's
    /// revocation path — the gateway keys per-phone state on `ClientHello.clientInstanceID`, but a
    /// listener-level identity is what a future transport-level ban would gate on.
    var peerID: String { get }
    func send(_ frame: Data) async
    func close()
}

/// Test/dev-harness-only listener — connections are pushed in explicitly via
/// `simulateConnection`, never accepted from a real network. Exists so `Gateway` can be driven
/// end-to-end in tests (and in the human "live gate" dev harness described in the Task 5 brief)
/// without any of SP2's iroh wiring.
public final class LoopbackListener: RemoteListener, @unchecked Sendable {
    public let connections: AsyncStream<RemoteConn>
    private let cont: AsyncStream<RemoteConn>.Continuation

    public init() {
        var c: AsyncStream<RemoteConn>.Continuation!
        connections = AsyncStream { c = $0 }
        cont = c
    }

    /// Test/harness hook: simulate a phone dialing in.
    public func simulateConnection(_ conn: RemoteConn) {
        cont.yield(conn)
    }

    public func stop() {
        cont.finish()
    }
}

/// Scripted phone-side connection double for `GatewayTests` — drives inbound frames and records
/// outbound ones, with fault injection for the reconnect/fault-tolerance scenario (Task 5 brief
/// scenario E). All mutable state is behind a lock since `send`/the script API may be called from
/// different tasks (the gateway's actor-isolated code vs. the test's own).
public final class ScriptedRemoteConn: RemoteConn, @unchecked Sendable {
    public let inbound: AsyncStream<Data>
    private let inboundCont: AsyncStream<Data>.Continuation

    /// All mutable state behind ONE Swift-6 `OSAllocatedUnfairLock` (SP2a gate G6, replacing the
    /// prior `NSLock`) — the lock guards only synchronous critical sections; any suspension (the
    /// send-gate below) happens strictly OUTSIDE `withLock`, honoring the "no lock held across an
    /// await" rule the gateway actor's isolation depends on.
    private struct State {
        var outbound: [Data] = []
        var closed = false
        var sentAttempts = 0
        var dropNextSend = false
        var dupNextSend = false
        var disconnectAfterN: Int?
        /// Send-gate (SP2a gate G2 test infra): the 1-based index from which `send` suspends until
        /// `releaseSends()`, plus the continuations parked there. Lets a test freeze the gateway
        /// mid-handshake (blocked on its first phone-bound frame) so a daemon event delivered in
        /// that window deterministically exercises the switchover path.
        var gateFrom: Int?
        var parked: [CheckedContinuation<Void, Never>] = []
    }
    private let state = OSAllocatedUnfairLock(initialState: State())

    public let peerID: String

    public init(peerID: String = "peer-stub") {
        self.peerID = peerID
        var c: AsyncStream<Data>.Continuation!
        inbound = AsyncStream { c = $0 }
        inboundCont = c
    }

    /// Every frame actually delivered to the "phone" (post fault-injection) — what a real phone
    /// would have received, in order.
    public var outbound: [Data] { state.withLock { $0.outbound } }
    public var isClosed: Bool { state.withLock { $0.closed } }

    // MARK: - Script API (test → gateway direction)

    public func enqueueInbound(_ data: Data) { inboundCont.yield(data) }

    /// Ends the inbound stream — simulates the phone hanging up (the gateway's read loop sees
    /// end-of-stream and returns).
    public func endInbound() { inboundCont.finish() }

    // MARK: - Fault injection (affects the gateway → phone direction, i.e. the NEXT `send()`s)

    /// The next frame the gateway tries to send is silently dropped — never recorded in
    /// `outbound` — simulating a flaky link losing a packet.
    public func injectDrop() { state.withLock { $0.dropNextSend = true } }

    /// The next frame the gateway sends is delivered TWICE — simulating a retransmit duplicate.
    public func injectDup() { state.withLock { $0.dupNextSend = true } }

    /// After the Nth `send()` attempt (counting drops), the connection auto-closes — simulating
    /// the link dying mid-stream.
    public func disconnectAfter(_ n: Int) { state.withLock { $0.disconnectAfterN = n } }

    /// From the `n`-th `send()` onward (1-based), suspend inside `send` until `releaseSends()`.
    /// The frame is still RECORDED in `outbound` before parking, so a test can observe that the
    /// gateway reached the send while it stays blocked. See `State.gateFrom`.
    public func blockSendsFrom(_ n: Int) { state.withLock { $0.gateFrom = n } }

    /// Releases every parked `send` and lifts the gate, so subsequent sends pass through freely.
    public func releaseSends() {
        let toResume: [CheckedContinuation<Void, Never>] = state.withLock {
            $0.gateFrom = nil
            let parked = $0.parked
            $0.parked = []
            return parked
        }
        for c in toResume { c.resume() }
    }

    public func send(_ frame: Data) async {
        enum Outcome { case dropped, closedAlready, delivered(shouldBlock: Bool, shouldClose: Bool) }
        let outcome: Outcome = state.withLock { s in
            guard !s.closed else { return .closedAlready }
            s.sentAttempts += 1
            if s.dropNextSend {
                s.dropNextSend = false
                // A dropped frame is neither recorded nor gated, but still counts toward
                // disconnectAfterN (parity with the pre-refactor behavior).
            } else {
                s.outbound.append(frame)
                if s.dupNextSend {
                    s.dupNextSend = false
                    s.outbound.append(frame)
                }
            }
            var shouldClose = false
            if let n = s.disconnectAfterN, s.sentAttempts >= n {
                s.disconnectAfterN = nil
                shouldClose = true
            }
            let shouldBlock = s.gateFrom.map { s.sentAttempts >= $0 } ?? false
            return .delivered(shouldBlock: shouldBlock, shouldClose: shouldClose)
        }

        guard case .delivered(let shouldBlock, let shouldClose) = outcome else { return }

        if shouldBlock {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                // Re-check under the lock: a release that raced ahead of this park would otherwise
                // strand the continuation forever.
                let releaseNow = state.withLock { s -> Bool in
                    if s.gateFrom == nil { return true }
                    s.parked.append(cont)
                    return false
                }
                if releaseNow { cont.resume() }
            }
        }
        if shouldClose { close() }
    }

    public func close() {
        let didClose: Bool = state.withLock { s in
            guard !s.closed else { return false }
            s.closed = true
            return true
        }
        if didClose { inboundCont.finish() }
    }
}
