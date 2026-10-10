import CoreGraphics
import os
import XCTest
import WinterProtocol
import WinterSessionKit
@testable import WinterKit

/// ComputerV2 Phase 1b — the phone mirror through the Gateway: `session.mirror` is gated by the daemon, served from
/// Winter.app's own mirror (`RemoteMirrorSource`) on `WireKind.mirror`, tied to the phone's attach, and ended by
/// every way the attach or the connection can end (stop, lapse, detach, re-attach elsewhere, revoke).
final class GatewayMirrorTests: XCTestCase {

    // MARK: - A fake of Winter.app's mirror

    final class FakeMirrorSource: RemoteMirrorSource, @unchecked Sendable {
        private struct State {
            var watches: [RemoteMirrorWatch] = []
            var unwatched: [RemoteMirrorWatch] = []
            var delivers: [UUID: @Sendable (MirrorUpdate) -> Void] = [:]
        }
        private let state = OSAllocatedUnfairLock(initialState: State())
        let initial: [MirrorUpdate]

        init(initial: [MirrorUpdate] = [.clear]) { self.initial = initial }

        var watches: [RemoteMirrorWatch] { state.withLock { $0.watches } }
        var unwatched: [RemoteMirrorWatch] { state.withLock { $0.unwatched } }
        var liveWatchCount: Int { state.withLock { $0.delivers.count } }

        func watch(sessionId: String, deliver: @escaping @Sendable (MirrorUpdate) -> Void) async -> RemoteMirrorWatch {
            let watch = RemoteMirrorWatch(sessionId: sessionId)
            state.withLock { $0.watches.append(watch); $0.delivers[watch.id] = deliver }
            for update in initial { deliver(update) }
            return watch
        }

        func unwatch(_ watch: RemoteMirrorWatch) async {
            state.withLock { $0.unwatched.append(watch); $0.delivers.removeValue(forKey: watch.id) }
        }

        func push(_ update: MirrorUpdate) {
            let delivers = state.withLock { Array($0.delivers.values) }
            for deliver in delivers { deliver(update) }
        }
    }

    // MARK: - Helpers

    private func encodeEnvelope(kind: WireKind, payload: Data, epoch: Int = 1) -> Data {
        try! WireFrame.encode(WireEnvelope(v: 1, pairingEpoch: epoch, hostID: "phone-x", sessionID: nil, streamID: nil,
                                           seq: nil, kind: kind, timestamp: 0, payload: payload))
    }

    private func helloFrame(clientInstanceID: String, resumes: [StreamResume]) throws -> Data {
        let hello = ClientHello(protocolVersions: [1], appBuild: "1", clientInstanceID: clientInstanceID, pairingEpoch: 1, resumes: resumes)
        return encodeEnvelope(kind: .hello, payload: try JSONEncoder().encode(hello))
    }

    private func rpcFrame(id: Int, method: String, params: JSONValue) throws -> Data {
        let payload = try JSONEncoder().encode(JSONValue.object([
            "jsonrpc": .string("2.0"), "id": .number(Double(id)), "method": .string(method), "params": params,
        ]))
        return encodeEnvelope(kind: .rpcRequest, payload: payload)
    }

    private func mirrorFrame(_ id: Int, _ sessionId: String, watch: Bool) throws -> Data {
        try rpcFrame(id: id, method: "session.mirror", params: .object(["sessionId": .string(sessionId), "watch": .bool(watch)]))
    }

    private func envelopes(_ conn: ScriptedRemoteConn) -> [WireEnvelope] {
        conn.outbound.compactMap { try? WireFrame.decode($0, expectedEpoch: 1) }
    }

    private func mirrorUpdates(_ conn: ScriptedRemoteConn) -> [MirrorUpdate] {
        envelopes(conn).filter { $0.kind == .mirror }.compactMap { MirrorWire.decode($0.payload) }
    }

    private func rpcResponses(_ conn: ScriptedRemoteConn) -> [JSONValue] {
        envelopes(conn).filter { $0.kind == .rpcResponse }.compactMap { try? JSONDecoder().decode(JSONValue.self, from: $0.payload) }
    }

    private func until(_ timeout: TimeInterval = 3, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return condition()
    }

    private struct Rig {
        let gateway: Gateway
        let daemon: ScriptedTransport
        let listener: LoopbackListener
        let source: FakeMirrorSource
        let run: Task<Void, Never>
    }

    private func rig(source: FakeMirrorSource = FakeMirrorSource(), mirrorSource: Bool = true, lease: TimeInterval = MirrorWire.lease) -> Rig {
        let daemon = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = Gateway(
            listener: listener,
            daemonFactory: { WinterClient(makeTransport: { daemon }, token: "remote-token", clientName: "iphone-gateway") },
            hostID: "host-test",
            directory: InMemoryDirectory(peerID: "peer-stub"),
            mirrorSource: mirrorSource ? source : nil,
            mirrorLease: lease)
        let run = Task { await gateway.run() }
        return Rig(gateway: gateway, daemon: daemon, listener: listener, source: source, run: run)
    }

    /// The daemon's next request line, once it is `method`.
    private func nextDaemonRequest(_ r: Rig, index: Int, method: String) async throws -> Int {
        let line = try await waitForSent(r.daemon, count: index + 1)[index]
        XCTAssertEqual(decodeLine(line)["method"] as? String, method)
        return decodeLine(line)["id"] as! Int
    }

    /// A phone connected and attached to `session` through its hello's resume. Returns the connection and how many
    /// daemon lines have been sent so far.
    private func attachedPhone(_ r: Rig, client: String = "phone-m", session: String = "s1") async throws -> (ScriptedRemoteConn, Int) {
        let conn = ScriptedRemoteConn()
        r.listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: client, resumes: [StreamResume(sessionID: session, streamID: session, lastAppliedSeq: 0)]))
        let helloId = try await nextDaemonRequest(r, index: 0, method: "protocol.hello")
        r.daemon.feed(#"{"jsonrpc":"2.0","id":\#(helloId),"result":{"ok":true}}"#)
        let attachId = try await nextDaemonRequest(r, index: 1, method: "session.attach")
        r.daemon.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"harness_attached","seq":1,"sessionId":"\#(session)","ts":0,"clientName":"iphone-gateway"}}"#)
        r.daemon.feed(#"{"jsonrpc":"2.0","id":\#(attachId),"result":{"ok":true,"lastSeq":1}}"#)
        let acked = await until { self.envelopes(conn).contains { $0.kind == .helloAck } }
        XCTAssertTrue(acked)
        return (conn, 2)
    }

    /// Sends `session.mirror {watch}` and answers the daemon's gate with `mirror`.
    private func watch(_ r: Rig, _ conn: ScriptedRemoteConn, id: Int, daemonIndex: Int, session: String = "s1", watch: Bool = true, mirror: Bool = true) async throws {
        let before = rpcResponses(conn).count
        conn.enqueueInbound(try mirrorFrame(id, session, watch: watch))
        let gateId = try await nextDaemonRequest(r, index: daemonIndex, method: "session.mirror")
        let line = try await waitForSent(r.daemon, count: daemonIndex + 1)[daemonIndex]
        let params = decodeLine(line)["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, session)
        XCTAssertEqual(params?["watch"] as? Bool, watch)
        r.daemon.feed(#"{"jsonrpc":"2.0","id":\#(gateId),"result":{"ok":true,"mirror":\#(mirror && watch)}}"#)
        let answered = await until { self.rpcResponses(conn).count > before }
        XCTAssertTrue(answered)
    }

    // MARK: - Gate

    func testWatchingNeedsTheAttachAndAnUnattachedAskNeverReachesTheDaemon() async throws {
        let r = rig()
        defer { r.run.cancel() }
        let conn = ScriptedRemoteConn()
        r.listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-n", resumes: []))
        let helloId = try await nextDaemonRequest(r, index: 0, method: "protocol.hello")
        r.daemon.feed(#"{"jsonrpc":"2.0","id":\#(helloId),"result":{"ok":true}}"#)
        _ = await until { self.envelopes(conn).contains { $0.kind == .helloAck } }

        conn.enqueueInbound(try mirrorFrame(1, "s1", watch: true))
        let answered = await until { !self.rpcResponses(conn).isEmpty }
        XCTAssertTrue(answered)
        XCTAssertEqual(rpcResponses(conn).first?["error"]?["message"]?.stringValue, "attach to the session first")
        XCTAssertEqual(rpcResponses(conn).first?["error"]?["code"]?.intValue, -32004)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(r.daemon.sent.count, 1, "only the hello: the ask never reached the daemon")
        XCTAssertTrue(r.source.watches.isEmpty)
    }

    func testAnAttachedPhoneIsGatedByTheDaemonThenServedOnTheMirrorKind() async throws {
        let r = rig(source: FakeMirrorSource(initial: [.show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true)]))
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        try await watch(r, conn, id: 1, daemonIndex: sent)
        XCTAssertEqual(rpcResponses(conn).last?["result"]?["mirror"]?.boolValue, true, "the daemon's own answer is relayed")
        XCTAssertEqual(r.source.watches.map(\.sessionId), ["s1"])

        r.source.push(.cursor(MirrorCursor(kind: "press", point: CGPoint(x: 3, y: 4))))
        r.source.push(.frame(MirrorFrame(seq: 1, jpeg: RemoteMirrorTests.jpeg(width: 64, height: 48, noise: false), width: 64, height: 48, windowSize: CGSize(width: 800, height: 600))))
        let got = await until { self.mirrorUpdates(conn).count >= 3 }
        XCTAssertTrue(got, "\(mirrorUpdates(conn))")
        let updates = mirrorUpdates(conn)
        XCTAssertEqual(updates.first, .show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true))
        XCTAssertEqual(updates[1], .cursor(MirrorCursor(kind: "press", point: CGPoint(x: 3, y: 4))))
        guard case .frame(let f) = updates[2] else { return XCTFail("\(updates)") }
        XCTAssertEqual(f.width, 64)

        // Every mirror envelope: this session, no seq, no stream — nothing cursor- or replay-related.
        for env in envelopes(conn) where env.kind == .mirror {
            XCTAssertEqual(env.sessionID, "s1")
            XCTAssertNil(env.seq)
            XCTAssertNil(env.streamID)
        }
        XCTAssertFalse(envelopes(conn).contains { $0.kind == .event && MirrorWire.decode($0.payload) != nil }, "never on the event stream")
    }

    func testTheUsersSettingOffMeansNoWatchAtAll() async throws {
        let r = rig()
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        try await watch(r, conn, id: 1, daemonIndex: sent, mirror: false)
        XCTAssertEqual(rpcResponses(conn).last?["result"]?["mirror"]?.boolValue, false)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(r.source.watches.isEmpty)
        XCTAssertTrue(mirrorUpdates(conn).isEmpty)
    }

    /// The user turning `computerUse.mirror` (or computer use) off while a phone watches: the next renewal's gate says
    /// so and the watch — with the Mac-side subscription it held — ends then.
    func testTheSettingTurnedOffMidWatchEndsItAtTheNextRenewal() async throws {
        let r = rig()
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        try await watch(r, conn, id: 1, daemonIndex: sent)
        XCTAssertEqual(r.source.watches.count, 1)
        try await watch(r, conn, id: 2, daemonIndex: sent + 1, mirror: false)
        XCTAssertEqual(rpcResponses(conn).last?["result"]?["mirror"]?.boolValue, false)
        let stopped = await until { r.source.unwatched.count == 1 }
        XCTAssertTrue(stopped)
        let mirrorWatch = await r.gateway.mirrorWatchForTesting("phone-m")
        XCTAssertNil(mirrorWatch)
    }

    func testAGatewayWithNoMirrorAnswersMirrorFalseAfterTheGate() async throws {
        let r = rig(mirrorSource: false)
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        try await watch(r, conn, id: 1, daemonIndex: sent)
        XCTAssertEqual(rpcResponses(conn).last?["result"]?["mirror"]?.boolValue, false)
        XCTAssertTrue(mirrorUpdates(conn).isEmpty)
    }

    func testADaemonRefusalIsRelayedAndStartsNothing() async throws {
        let r = rig()
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        conn.enqueueInbound(try mirrorFrame(1, "s1", watch: true))
        let gateId = try await nextDaemonRequest(r, index: sent, method: "session.mirror")
        r.daemon.feed(#"{"jsonrpc":"2.0","id":\#(gateId),"error":{"code":-32602,"message":"cowork sessions are not available to remote clients"}}"#)
        let answered = await until { !self.rpcResponses(conn).isEmpty }
        XCTAssertTrue(answered)
        XCTAssertEqual(rpcResponses(conn).last?["error"]?["code"]?.intValue, -32602)
        XCTAssertTrue(r.source.watches.isEmpty)
    }

    // MARK: - Lifecycle

    func testARenewalKeepsTheOneWatchAndAStopEndsIt() async throws {
        let r = rig()
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        try await watch(r, conn, id: 1, daemonIndex: sent)
        try await watch(r, conn, id: 2, daemonIndex: sent + 1)
        XCTAssertEqual(r.source.watches.count, 1, "a renewal is not a second watch")

        try await watch(r, conn, id: 3, daemonIndex: sent + 2, watch: false)
        XCTAssertEqual(rpcResponses(conn).last?["result"]?["mirror"]?.boolValue, false)
        let stopped = await until { r.source.unwatched.count == 1 }
        XCTAssertTrue(stopped)
        let mirrorWatch = await r.gateway.mirrorWatchForTesting("phone-m")
        XCTAssertNil(mirrorWatch)
        let countAfterStop = mirrorUpdates(conn).count
        r.source.push(.clear)
        try await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(mirrorUpdates(conn).count, countAfterStop, "nothing after a stop")
    }

    func testAWatchNotRenewedLapses() async throws {
        let r = rig(lease: 0.3)
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        try await watch(r, conn, id: 1, daemonIndex: sent)
        XCTAssertEqual(r.source.watches.count, 1)
        let lapsed = await until(3) { r.source.unwatched.count == 1 }
        XCTAssertTrue(lapsed, "a suspended phone that never said stop stops getting the mirror")
    }

    func testTheConnectionClosingEndsTheWatch() async throws {
        let r = rig()
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        try await watch(r, conn, id: 1, daemonIndex: sent)
        conn.endInbound()
        let stopped = await until { r.source.unwatched.count == 1 }
        XCTAssertTrue(stopped)
    }

    func testAttachingAnotherSessionEndsTheWatch() async throws {
        let r = rig()
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        try await watch(r, conn, id: 1, daemonIndex: sent)
        conn.enqueueInbound(try rpcFrame(id: 2, method: "session.attach", params: .object(["sessionId": .string("s2"), "fromSeq": .number(0)])))
        let attachId = try await nextDaemonRequest(r, index: sent + 1, method: "session.attach")
        r.daemon.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"harness_attached","seq":1,"sessionId":"s2","ts":0,"clientName":"iphone-gateway"}}"#)
        r.daemon.feed(#"{"jsonrpc":"2.0","id":\#(attachId),"result":{"ok":true,"lastSeq":1}}"#)
        let stopped = await until { r.source.unwatched.count == 1 }
        XCTAssertTrue(stopped, "the mirror follows the attach")
    }

    func testRevokingThePhoneEndsTheWatch() async throws {
        let r = rig()
        defer { r.run.cancel() }
        let (conn, sent) = try await attachedPhone(r)
        try await watch(r, conn, id: 1, daemonIndex: sent)
        await r.gateway.revoke(clientInstanceID: "phone-m")
        let stopped = await until { r.source.unwatched.count == 1 }
        XCTAssertTrue(stopped)
    }

    func testAShellConnectionOfTheSamePhoneCannotTakeTheMirror() async throws {
        let r = rig()
        defer { r.run.cancel() }
        let (_, sent) = try await attachedPhone(r)
        // The iOS connection pool's resume-less shell connection, same phone.
        let shell = ScriptedRemoteConn()
        r.listener.simulateConnection(shell)
        shell.enqueueInbound(try helloFrame(clientInstanceID: "phone-m", resumes: []))
        _ = await until { self.envelopes(shell).contains { $0.kind == .helloAck } }
        shell.enqueueInbound(try mirrorFrame(1, "s1", watch: true))
        let answered = await until { !self.rpcResponses(shell).isEmpty }
        XCTAssertTrue(answered)
        XCTAssertEqual(rpcResponses(shell).first?["error"]?["message"]?.stringValue, "attach to the session first")
        try await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(r.daemon.sent.count, sent, "never relayed")
    }
}
