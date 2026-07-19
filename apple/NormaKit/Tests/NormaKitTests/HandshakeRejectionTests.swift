import XCTest
import NormaProtocol
import NormaSessionKit
@testable import NormaKit

/// SP3.1 Task 1: the gateway assigns the RIGHT `HandshakeRejectionCode` on each handshake refusal,
/// and the pairing router's `sendNotPairedRejection` peeks the first frame to reply in the shape the
/// dialer can decode — a WireEnvelope `error` for a SESSION dialer (a `NormaSessionClient`, which
/// turns it into a typed `.handshakeRejected` → the app's honest `.revoked`), the UNCHANGED raw-JSON
/// `PairRejected` for a PAIRING dialer (`PhonePairingClient`). Driven with scripted doubles
/// (`ScriptedRemoteConn`/`LoopbackListener`, `ScriptedTransport`) — no iroh, no real daemon (that's
/// `FakePhoneConformanceTests`' real-revoke E2E). The client-side recognition of these frames is
/// covered in `NormaSessionClientTests` (`testHandshakeThrowsTypedRejection...`).
final class HandshakeRejectionTests: XCTestCase {

    // MARK: - Harness (per-file copies, matching this target's test-double convention)

    private func makeGateway(daemonTransport: NormaTransport, listener: LoopbackListener, directoryEpoch: Int = 1) -> Gateway {
        Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { daemonTransport }, token: "remote-token", clientName: "iphone-gateway") },
            hostID: "host-test",
            directory: InMemoryDirectory(peerID: "peer-stub", epoch: directoryEpoch)
        )
    }

    private func encodeEnvelope(kind: WireKind, payload: Data, epoch: Int = 1) -> Data {
        let e = WireEnvelope(
            v: 1, pairingEpoch: epoch, hostID: "phone-x", sessionID: nil, streamID: nil,
            seq: nil, kind: kind, timestamp: 0, payload: payload
        )
        return try! WireFrame.encode(e)
    }

    private func helloFrame(clientInstanceID: String = "phone-hr", epoch: Int = 1) throws -> Data {
        let hello = ClientHello(
            protocolVersions: [1], appBuild: "1", clientInstanceID: clientInstanceID,
            pairingEpoch: epoch, resumes: []
        )
        return encodeEnvelope(kind: .hello, payload: try JSONEncoder().encode(hello), epoch: epoch)
    }

    private func waitForOutbound(_ conn: ScriptedRemoteConn, count: Int, timeout: TimeInterval = 2) async throws -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if conn.outbound.count >= count { return conn.outbound }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(count) outbound frames; got \(conn.outbound.count)")
        return conn.outbound
    }

    private func waitForClosed(_ conn: ScriptedRemoteConn, timeout: TimeInterval = 2) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if conn.isClosed { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for conn to close")
    }

    private func feedDaemonHelloResponse(_ t: ScriptedTransport) async throws {
        let line = try await waitForSent(t, count: 1)[0]
        let id = decodeLine(line)["id"] as! Int
        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"ok":true}}"#)
    }

    /// The handshake-refusal `.error` frame decodes to a `HandshakeRejection` with the expected
    /// code, and the connection is closed. Frames are stamped with the record's epoch (1), which the
    /// default `decodeLenient` reads regardless — the same-epoch refusals also decode strictly.
    private func assertRejection(_ conn: ScriptedRemoteConn, code: HandshakeRejectionCode) async throws {
        let out = try await waitForOutbound(conn, count: 1)
        let env = try WireFrame.decodeLenient(out[0])
        XCTAssertEqual(env.kind, .error, "a handshake refusal must be an .error frame")
        let rejection = try JSONDecoder().decode(HandshakeRejection.self, from: env.payload)
        XCTAssertEqual(rejection.code, code.rawValue)
        XCTAssertFalse(rejection.message.isEmpty, "the free-text message is kept for diagnostics")
        try await waitForClosed(conn)
    }

    // MARK: - Gateway: each handshake-refusal path carries the right code

    /// A hello stamped with an OLD epoch (record epoch 1, hello epoch 999) → the `WireFrame.decode`
    /// staleEpoch catch → `stale_epoch`.
    func testGateway_StaleEpochHello_EmitsStaleEpochCode() async throws {
        let listener = LoopbackListener()
        let gateway = makeGateway(daemonTransport: ScriptedTransport(), listener: listener, directoryEpoch: 1)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(epoch: 999))
        try await assertRejection(conn, code: .staleEpoch)
    }

    /// A first frame that decodes but isn't a `.hello` (valid envelope, wrong kind) → `protocol`.
    func testGateway_NonHelloFirstFrame_EmitsProtocolCode() async throws {
        let listener = LoopbackListener()
        let gateway = makeGateway(daemonTransport: ScriptedTransport(), listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(encodeEnvelope(kind: .rpcRequest, payload: Data("{}".utf8), epoch: 1))
        try await assertRejection(conn, code: .protocolError)
    }

    /// A `.hello` frame whose payload isn't a decodable `ClientHello` → `protocol`.
    func testGateway_MalformedClientHello_EmitsProtocolCode() async throws {
        let listener = LoopbackListener()
        let gateway = makeGateway(daemonTransport: ScriptedTransport(), listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(encodeEnvelope(kind: .hello, payload: Data(#"{"not":"a hello"}"#.utf8), epoch: 1))
        try await assertRejection(conn, code: .protocolError)
    }

    /// The daemon connection fails to open → `daemon_unavailable`. The hello is valid (epoch 1,
    /// well-formed ClientHello) so the gateway gets past every wire check and only trips on the
    /// daemon `connect`.
    func testGateway_DaemonConnectFailure_EmitsDaemonUnavailableCode() async throws {
        let listener = LoopbackListener()
        let gateway = makeGateway(daemonTransport: FailingOpenTransport(), listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(epoch: 1))
        try await assertRejection(conn, code: .daemonUnavailable)
    }

    // MARK: - Router: sendNotPairedRejection's dual-path peek

    /// A SESSION dialer's first frame is a `.hello` WireEnvelope → the router replies with a
    /// WireEnvelope `error` carrying `HandshakeRejection(not_paired)`, ECHOING the phone's own
    /// claimed epoch (the router has no record to consult), then closes.
    func testRouter_SessionDialer_GetsWireFrameNotPairedError() async throws {
        let conn = ScriptedRemoteConn()
        conn.enqueueInbound(try helloFrame(clientInstanceID: "session-dialer", epoch: 5))

        await sendNotPairedRejection(conn)

        let out = try await waitForOutbound(conn, count: 1)
        let env = try WireFrame.decodeLenient(out[0])
        XCTAssertEqual(env.kind, .error, "a session dialer must get a WireEnvelope error, not raw JSON")
        XCTAssertEqual(env.pairingEpoch, 5, "the error echoes the phone's own claimed hello epoch")
        let rejection = try JSONDecoder().decode(HandshakeRejection.self, from: env.payload)
        XCTAssertEqual(rejection.code, "not_paired")
        try await waitForClosed(conn)
    }

    /// A PAIRING dialer's first frame is a raw-JSON `PairRequest` (no WireEnvelope wrapper) → the
    /// router replies with the UNCHANGED raw-JSON `PairRejected(not_paired)` `PhonePairingClient`
    /// decodes — the pairing ceremony wire is untouched.
    func testRouter_PairingDialer_GetsRawJSONPairRejected() async throws {
        let conn = ScriptedRemoteConn()
        let request = PairRequest(
            type: "pair_request", pairID: Data(repeating: 0xAB, count: 16),
            phoneEndpointID: "pairing-dialer", phoneInstallNonce: Data(repeating: 0x11, count: 16),
            caps: ["sessions"], proof: Data(repeating: 0x22, count: 32)
        )
        conn.enqueueInbound(try JSONEncoder().encode(request))

        await sendNotPairedRejection(conn)

        let out = try await waitForOutbound(conn, count: 1)
        // The reply is a raw-JSON PairRejected — NOT a WireEnvelope (a WireEnvelope has no top-level
        // `type`/`code`, so a PairRejected decode of one would fail).
        let rejected = try JSONDecoder().decode(PairRejected.self, from: out[0])
        XCTAssertEqual(rejected.type, "pair_rejected")
        XCTAssertEqual(rejected.code, "not_paired")
        XCTAssertNil(rejected.pairID, "a stranger's bounce carries no ceremony context")
        // And it is NOT a decodable WireEnvelope — positively confirming the pairing wire is untouched.
        XCTAssertThrowsError(try WireFrame.decodeLenient(out[0]))
        try await waitForClosed(conn)
    }
}

/// A `NormaTransport` whose `open()` fails immediately — drives `NormaClient.connect(role:)` to
/// throw, so the gateway's daemon-connect refusal path (`daemon_unavailable`) is exercised without a
/// real daemon.
private final class FailingOpenTransport: NormaTransport, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation

    init() {
        var c: AsyncStream<TransportEvent>.Continuation!
        incoming = AsyncStream { c = $0 }
        cont = c
    }

    func open() async throws { throw RpcError(code: -1, message: "simulated daemon unavailable") }
    func send(_ data: Data) async throws {}
    func close() { cont.finish() }
}
