import Foundation

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

    private let lock = NSLock()
    private var _outbound: [Data] = []
    private var _closed = false
    private var sentAttempts = 0
    private var dropNextSend = false
    private var dupNextSend = false
    private var disconnectAfterN: Int?

    public init() {
        var c: AsyncStream<Data>.Continuation!
        inbound = AsyncStream { c = $0 }
        inboundCont = c
    }

    /// Every frame actually delivered to the "phone" (post fault-injection) — what a real phone
    /// would have received, in order.
    public var outbound: [Data] { lock.lock(); defer { lock.unlock() }; return _outbound }
    public var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return _closed }

    // MARK: - Script API (test → gateway direction)

    public func enqueueInbound(_ data: Data) { inboundCont.yield(data) }

    /// Ends the inbound stream — simulates the phone hanging up (the gateway's read loop sees
    /// end-of-stream and returns).
    public func endInbound() { inboundCont.finish() }

    // MARK: - Fault injection (affects the gateway → phone direction, i.e. the NEXT `send()`s)

    /// The next frame the gateway tries to send is silently dropped — never recorded in
    /// `outbound` — simulating a flaky link losing a packet.
    public func injectDrop() { lock.lock(); dropNextSend = true; lock.unlock() }

    /// The next frame the gateway sends is delivered TWICE — simulating a retransmit duplicate.
    public func injectDup() { lock.lock(); dupNextSend = true; lock.unlock() }

    /// After the Nth `send()` attempt (counting drops), the connection auto-closes — simulating
    /// the link dying mid-stream.
    public func disconnectAfter(_ n: Int) { lock.lock(); disconnectAfterN = n; lock.unlock() }

    public func send(_ frame: Data) async {
        lock.lock()
        guard !_closed else { lock.unlock(); return }
        sentAttempts += 1
        if dropNextSend {
            dropNextSend = false
        } else {
            _outbound.append(frame)
            if dupNextSend {
                dupNextSend = false
                _outbound.append(frame)
            }
        }
        var shouldClose = false
        if let n = disconnectAfterN, sentAttempts >= n {
            disconnectAfterN = nil
            shouldClose = true
        }
        lock.unlock()
        if shouldClose { close() }
    }

    public func close() {
        lock.lock()
        guard !_closed else { lock.unlock(); return }
        _closed = true
        lock.unlock()
        inboundCont.finish()
    }
}
