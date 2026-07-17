import XCTest
import NormaProtocol
@testable import NormaKit

/// SP2a Task 2: the eight review gates SP1's whole-branch review flagged as only surfacing against
/// the REAL daemon (SP1's own `GatewayTests` used a scripted fake). Each gate that needs genuine
/// `hub.attach` semantics (the harness_attached the attach itself appends, the exclusive replay
/// read) runs against `RealDaemon`; the pure ones (the token bucket, the allowlist tripwire, the
/// Swift-6 lock) stay scripted.
///
///   G1  honest verdicts + harness-noise filter (`.upToDate` reachable; no `harness_attached` leak)
///   G2  switchover — a daemon event landing mid-handshake is delivered, not dropped
///   G3  `helloAck` is the FIRST phone-bound frame; replay events follow it
///   G4a inbound rpcRequest rate limit (token bucket)
///   G4b inner-payload JSON depth ceiling (≤32), enforced before forwarding
///   G5  `revoke(_:)` — pump cancelled, daemon client closed, future frames + reconnect refused
///   G6  `ScriptedRemoteConn` on `OSAllocatedUnfairLock` + `RemoteConn.peerID`
///   G7  the remote allowlist is EXACTLY the nine names (Swift half of the cross-language tripwire)
final class GatewayGateTests: XCTestCase {

    // MARK: - Shared helpers (per-file copies, matching this codebase's test-double convention)

    func encodeEnvelope(kind: WireKind, sessionID: String? = nil, streamID: String? = nil, seq: Int? = nil, payload: Data, epoch: Int = 1) -> Data {
        let e = WireEnvelope(v: 1, pairingEpoch: epoch, hostID: "phone-x", sessionID: sessionID, streamID: streamID, seq: seq, kind: kind, timestamp: 0, payload: payload)
        return try! WireFrame.encode(e)
    }

    func decodeEnvelope(_ data: Data, epoch: Int = 1, maxBytes: Int = 4 << 20) throws -> WireEnvelope {
        try WireFrame.decode(data, maxBytes: maxBytes, expectedEpoch: epoch)
    }

    func helloFrame(clientInstanceID: String, resumes: [StreamResume], epoch: Int = 1) throws -> Data {
        let hello = ClientHello(protocolVersions: [1], appBuild: "1", clientInstanceID: clientInstanceID, pairingEpoch: epoch, resumes: resumes)
        return encodeEnvelope(kind: .hello, payload: try JSONEncoder().encode(hello), epoch: epoch)
    }

    func rpcRequestFrame(id: Int, method: String, params: JSONValue?, commandId: String? = nil) throws -> Data {
        var obj: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": .number(Double(id)), "method": .string(method)]
        if let params { obj["params"] = params }
        if let commandId { obj["commandId"] = .string(commandId) }
        return encodeEnvelope(kind: .rpcRequest, payload: try JSONEncoder().encode(JSONValue.object(obj)))
    }

    func waitForOutbound(_ conn: ScriptedRemoteConn, count: Int, timeout: TimeInterval = 3) async throws -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if conn.outbound.count >= count { return conn.outbound }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(count) outbound frames; got \(conn.outbound.count)")
        return conn.outbound
    }

    func waitForOutboundContainingSeq(_ conn: ScriptedRemoteConn, seq: Int, timeout: TimeInterval = 4) async throws -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let out = conn.outbound
            if out.contains(where: { (try? decodeEnvelope($0))?.seq == seq }) { return out }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for an outbound frame with seq \(seq); got \(conn.outbound.count) frames")
        return conn.outbound
    }

    func feedDaemonHelloResponse(_ t: ScriptedTransport) async throws {
        let line = try await waitForSent(t, count: 1)[0]
        let id = decodeLine(line)["id"] as! Int
        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"ok":true}}"#)
    }

    /// A gateway whose daemon-facing bridge client speaks to a REAL daemon's socket as `remote`.
    func realGateway(socketPath: String, remoteToken: String, listener: LoopbackListener) -> Gateway {
        Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: remoteToken, clientName: "iphone-gateway") },
            pairing: Gateway.PairingStub()
        )
    }

    /// Seeds a real session with two user messages, returning the ids plus `afterHarnessAttach`
    /// (the seq of the seeding harness's own `harness_attached`, a clean cursor to resume from that
    /// is PAST the session_created/harness_attached preamble) and the last content seq.
    func seedTwoMessages(socketPath: String, harnessToken: String) async throws -> (sid: String, afterHarnessAttach: Int, seqM2: Int) {
        let harness = NormaClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: harnessToken, clientName: "seed")
        try await harness.connect(role: "harness")
        // `session.dispatch {}` (empty object, NOT nil — SessionDispatchParams is z.object({})).
        let sid = try await harness.request("session.dispatch", params: .object([:]))["sessionId"]!.stringValue!
        let afterAttach = try await harness.attach(sessionId: sid, fromSeq: 0)
        _ = try await harness.send(sessionId: sid, text: "m1")
        let seqM2 = try await harness.send(sessionId: sid, text: "m2")
        await harness.close()
        return (sid, afterAttach, seqM2)
    }

    func sessionEvent(_ frame: Data) -> SessionEvent? {
        guard let env = try? decodeEnvelope(frame), env.kind == .event else { return nil }
        return try? JSONDecoder().decode(SessionEvent.self, from: env.payload)
    }

    func isHarnessNoiseEvent(_ ev: SessionEvent) -> Bool {
        switch ev { case .harnessAttached, .harnessDetached: return true; default: return false }
    }

    // MARK: - G1: honest verdicts + harness-noise filter (real daemon)

    func testG1_UpToDateReachable_HonestWatermark_NoHarnessLeak() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let socketPath = daemon.socketPath, remoteToken = daemon.remoteToken

        let seed = try await seedTwoMessages(socketPath: socketPath, harnessToken: daemon.harnessToken)

        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: socketPath, remoteToken: remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        // Connection 1 — BEHIND (resume just past the preamble): the daemon replays m1, m2, plus
        // the gateway's OWN harness_attached. The phone must see helloAck + exactly m1, m2 (the
        // harness_attached filtered out), and the verdict's highWatermark must be m2's CONTENT seq
        // — NOT the raw attach return (which counts that harness_attached: SP1's gap G1).
        let conn1 = ScriptedRemoteConn(peerID: "peer-A")
        listener.simulateConnection(conn1)
        conn1.enqueueInbound(try helloFrame(clientInstanceID: "phone-A", resumes: [
            StreamResume(sessionID: seed.sid, streamID: seed.sid, lastAppliedSeq: seed.afterHarnessAttach)
        ]))

        let out1 = try await waitForOutbound(conn1, count: 3)
        let ack1 = try decodeEnvelope(out1[0])
        XCTAssertEqual(ack1.kind, .helloAck, "helloAck must be the first phone-bound frame (G3)")
        let hello1 = try JSONDecoder().decode(ServerHello.self, from: ack1.payload)
        XCTAssertEqual(hello1.verdicts, [.replayBegin(sessionID: seed.sid, fromSeq: seed.afterHarnessAttach, highWatermark: seed.seqM2)],
                       "highWatermark must be the CONTENT high-water (m2), not the raw attach return")
        // Every delivered event frame is content — never harness_attached/detached.
        for frame in out1[1...] {
            let ev = sessionEvent(frame)
            XCTAssertNotNil(ev)
            XCTAssertFalse(isHarnessNoiseEvent(ev!), "a harness_attached/detached leaked to the phone (G1)")
        }
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(conn1.outbound.count, 3, "exactly helloAck + m1 + m2 — no extra (harness) frames")
        XCTAssertEqual(try decodeEnvelope(conn1.outbound[2]).seq, seed.seqM2)

        // Connection 2 — CAUGHT UP (fresh phone, resume AT the content high-water): the daemon
        // still replays harness_attached noise, but after filtering there is nothing → the verdict
        // must be .upToDate (unreachable before the fix) and NOT a single event frame is sent.
        let conn2 = ScriptedRemoteConn(peerID: "peer-B")
        listener.simulateConnection(conn2)
        conn2.enqueueInbound(try helloFrame(clientInstanceID: "phone-B", resumes: [
            StreamResume(sessionID: seed.sid, streamID: seed.sid, lastAppliedSeq: seed.seqM2)
        ]))

        let out2 = try await waitForOutbound(conn2, count: 1)
        let ack2 = try decodeEnvelope(out2[0])
        XCTAssertEqual(ack2.kind, .helloAck)
        let hello2 = try JSONDecoder().decode(ServerHello.self, from: ack2.payload)
        XCTAssertEqual(hello2.verdicts, [.upToDate(sessionID: seed.sid, highWatermark: seed.seqM2)],
                       ".upToDate must be reachable — a caught-up phone sees no replay (G1)")
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(conn2.outbound.count, 1, "a caught-up phone gets ONLY the helloAck, no harness_attached frame")
    }

    // MARK: - G2: switchover — an event arriving mid-handshake is delivered, not dropped (real daemon)

    func testG2_MidHandshakeLiveEventIsDelivered() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let socketPath = daemon.socketPath, remoteToken = daemon.remoteToken

        // A live harness that stays attached, so it can produce a new event mid-handshake.
        let live = NormaClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: daemon.harnessToken, clientName: "live")
        try await live.connect(role: "harness")
        let sid = try await live.request("session.dispatch", params: .object([:]))["sessionId"]!.stringValue!
        let afterAttach = try await live.attach(sessionId: sid, fromSeq: 0)
        _ = try await live.send(sessionId: sid, text: "m1")
        let seqM2 = try await live.send(sessionId: sid, text: "m2")

        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: socketPath, remoteToken: remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        // Freeze the gateway on its FIRST phone-bound frame — it is now mid-handshake: with the fix,
        // liveSessionID is already registered (helloAck parked, replay not yet flushed).
        let conn = ScriptedRemoteConn()
        conn.blockSendsFrom(1)
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-live", resumes: [
            StreamResume(sessionID: sid, streamID: sid, lastAppliedSeq: afterAttach)
        ]))
        _ = try await waitForOutbound(conn, count: 1) // gateway attached + parked on frame #1

        // The mid-handshake event: the gateway's remote client (attached during the handshake)
        // receives this broadcast; pre-fix it is dropped in the switchover gap (liveSessionID unset
        // until after the replay send-loop), post-fix it is live-forwarded.
        let seqLive = try await live.send(sessionId: sid, text: "m3-live")
        try await Task.sleep(nanoseconds: 300_000_000) // let the pump route it while the gate holds
        conn.releaseSends()

        // Wait for the replay's tail (m2) so the flush is known-complete, then assert BOTH the
        // replay AND the mid-handshake live event landed (the live frame was recorded at/around
        // the release, the replay follows it once the helloAck send unparks).
        _ = try await waitForOutboundContainingSeq(conn, seq: seqM2)
        let frames = try await waitForOutboundContainingSeq(conn, seq: seqLive)
        XCTAssertTrue(frames.contains { (try? decodeEnvelope($0))?.seq == seqLive },
                      "the mid-handshake live event (seq \(seqLive)) must be delivered, not dropped (G2)")
        XCTAssertTrue(frames.contains { (try? decodeEnvelope($0))?.seq == seqM2 }, "the replay (m2) still arrives")
        await live.close()
    }

    // MARK: - G3: helloAck precedes the replay frames (real daemon)

    func testG3_HelloAckIsFirstFrameThenReplay() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let socketPath = daemon.socketPath, remoteToken = daemon.remoteToken
        let seed = try await seedTwoMessages(socketPath: socketPath, harnessToken: daemon.harnessToken)

        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: socketPath, remoteToken: remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-ack", resumes: [
            StreamResume(sessionID: seed.sid, streamID: seed.sid, lastAppliedSeq: seed.afterHarnessAttach)
        ]))

        let out = try await waitForOutbound(conn, count: 3)
        XCTAssertEqual(try decodeEnvelope(out[0]).kind, .helloAck, "the FIRST frame after ClientHello must be helloAck (G3)")
        XCTAssertEqual(try decodeEnvelope(out[1]).kind, .event, "replay event frames follow the ack")
        XCTAssertEqual(try decodeEnvelope(out[2]).kind, .event)
    }

    // MARK: - G4a: inbound rpcRequest rate limit (scripted; frozen clock for determinism)

    func testG4a_RateLimitRejectsExcessAndOnlyAllowedReachDaemon() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        // burst 2, frozen clock → tokens never refill: exactly 2 admitted, the 3rd rejected.
        let gateway = Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { daemonTransport }, token: "remote-token", clientName: "iphone-gateway") },
            pairing: Gateway.PairingStub(),
            rateLimit: (perSec: 1000, burst: 2),
            now: { 1000.0 }
        )
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-rl", resumes: []))
        try await feedDaemonHelloResponse(daemonTransport)
        _ = try await waitForOutbound(conn, count: 1) // helloAck

        // Two allowed round-trips (each forwarded → answered), then a third that the bucket denies.
        func roundtrip(id: Int, expectSent: Int, expectOutbound: Int) async throws {
            conn.enqueueInbound(try rpcRequestFrame(id: id, method: "session.list", params: nil))
            let lines = try await waitForSent(daemonTransport, count: expectSent)
            let daemonId = decodeLine(lines[expectSent - 1])["id"] as! Int
            daemonTransport.feed(#"{"jsonrpc":"2.0","id":\#(daemonId),"result":{"sessions":[]}}"#)
            _ = try await waitForOutbound(conn, count: expectOutbound)
        }
        try await roundtrip(id: 1, expectSent: 2, expectOutbound: 2)
        try await roundtrip(id: 2, expectSent: 3, expectOutbound: 3)

        conn.enqueueInbound(try rpcRequestFrame(id: 3, method: "session.list", params: nil))
        let out = try await waitForOutbound(conn, count: 4)
        let rejection = try decodeEnvelope(out[3])
        XCTAssertEqual(rejection.kind, .error)
        let body = try JSONDecoder().decode(JSONValue.self, from: rejection.payload)
        XCTAssertEqual(body["error"]?["message"]?.stringValue, "rate limit exceeded")

        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(daemonTransport.sent.count, 3, "hello + 2 allowed forwards — the rate-limited 3rd never reached the daemon")
    }

    func testG4_RateLimiterTokenBucketRefills() {
        let rl = RateLimiter(ratePerSec: 50, burst: 200)
        for _ in 0..<200 { XCTAssertTrue(rl.allow(now: 1000)) }
        XCTAssertFalse(rl.allow(now: 1000), "bucket empty, no time elapsed → denied")
        for _ in 0..<50 { XCTAssertTrue(rl.allow(now: 1001)) } // +1s refills 50
        XCTAssertFalse(rl.allow(now: 1001))
    }

    // MARK: - G4b: inner-payload depth ceiling, enforced before forwarding (scripted)

    func testG4b_DeepInnerPayloadRejectedNotForwarded() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { daemonTransport }, token: "remote-token", clientName: "iphone-gateway") },
            pairing: Gateway.PairingStub()
        )
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-deep", resumes: []))
        try await feedDaemonHelloResponse(daemonTransport)
        _ = try await waitForOutbound(conn, count: 1) // helloAck
        let baselineSent = daemonTransport.sent.count

        // A payload nesting ~40 deep — the outer envelope decodes fine (payload rides as a base64
        // string there), but the INNER JSON-RPC document exceeds the depth-32 ceiling.
        var deep: JSONValue = .object(["leaf": .string("x")])
        for _ in 0..<40 { deep = .object(["n": deep]) }
        conn.enqueueInbound(try rpcRequestFrame(id: 1, method: "session.list", params: deep))

        let out = try await waitForOutbound(conn, count: 2)
        let err = try decodeEnvelope(out[1])
        XCTAssertEqual(err.kind, .error)
        let body = try JSONDecoder().decode(JSONValue.self, from: err.payload)
        XCTAssertEqual(body["error"]?["message"]?.stringValue, "payload nesting too deep")

        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(daemonTransport.sent.count, baselineSent, "the nesting-bomb payload must never reach the daemon (G4b)")
    }

    // MARK: - G5: revoke cancels the pump, closes the daemon client, refuses future frames + reconnect

    func testG5_RevokeCancelsPumpAndRefusesFramesAndReconnect() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { daemonTransport }, token: "remote-token", clientName: "iphone-gateway") },
            pairing: Gateway.PairingStub()
        )
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-rev", resumes: []))
        try await feedDaemonHelloResponse(daemonTransport)
        _ = try await waitForOutbound(conn, count: 1) // helloAck
        let baselineSent = daemonTransport.sent.count

        let pump = await gateway.pumpTaskForTesting("phone-rev")
        XCTAssertNotNil(pump, "the phone's daemon-event pump should be running before revoke")

        await gateway.revoke(clientInstanceID: "phone-rev")
        XCTAssertEqual(pump?.isCancelled, true, "revoke must cancel the pumpTask (G5)")

        // A subsequent frame on the SAME conn is refused — and never reaches the (closed) daemon client.
        conn.enqueueInbound(try rpcRequestFrame(id: 1, method: "session.list", params: nil))
        let out = try await waitForOutbound(conn, count: 2)
        XCTAssertEqual(try decodeEnvelope(out[1]).kind, .error)
        let body = try JSONDecoder().decode(JSONValue.self, from: try decodeEnvelope(out[1]).payload)
        XCTAssertEqual(body["error"]?["message"]?.stringValue, "pairing revoked")
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(daemonTransport.sent.count, baselineSent, "a revoked phone's frame must not reach the daemon")

        // A reconnect by the SAME phone is refused at the handshake and the conn is closed.
        let conn2 = ScriptedRemoteConn()
        listener.simulateConnection(conn2)
        conn2.enqueueInbound(try helloFrame(clientInstanceID: "phone-rev", resumes: []))
        let out2 = try await waitForOutbound(conn2, count: 1)
        XCTAssertEqual(try decodeEnvelope(out2[0]).kind, .error)
        let body2 = try JSONDecoder().decode(JSONValue.self, from: try decodeEnvelope(out2[0]).payload)
        XCTAssertEqual(body2["error"]?["message"]?.stringValue, "pairing revoked")
        let closeDeadline = Date().addingTimeInterval(2)
        while Date() < closeDeadline, !conn2.isClosed { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(conn2.isClosed, "a revoked phone's reconnect must be closed")
    }

    // MARK: - G6: ScriptedRemoteConn on OSAllocatedUnfairLock + peerID (builds + behaves)

    func testG6_ScriptedRemoteConnPeerIDAndSend() async throws {
        let conn = ScriptedRemoteConn()
        XCTAssertEqual(conn.peerID, "peer-stub", "default peerID stub")
        XCTAssertEqual(ScriptedRemoteConn(peerID: "node-xyz").peerID, "node-xyz")
        await conn.send(Data("f1".utf8))
        await conn.send(Data("f2".utf8))
        XCTAssertEqual(conn.outbound.count, 2)
        conn.close()
        XCTAssertTrue(conn.isClosed)
    }

    // MARK: - Review follow-up 1: cursor-ahead must yield .snapshotRequired (not a false .upToDate)

    func testR1_CursorFarAheadYieldsSnapshotRequired() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let seed = try await seedTwoMessages(socketPath: daemon.socketPath, harnessToken: daemon.harnessToken)

        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: daemon.socketPath, remoteToken: daemon.remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        // A cursor FAR beyond the session's real high-water (content tops out at seed.seqM2): an
        // impossible/corrupt cursor. Reporting .upToDate(1000) here would wedge the phone — every
        // real live event (seq << 1000) would be silently dropped as stale. The snapshot verdict
        // exists precisely to break that state.
        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-ahead", resumes: [
            StreamResume(sessionID: seed.sid, streamID: seed.sid, lastAppliedSeq: 1000)
        ]))

        let out = try await waitForOutbound(conn, count: 1)
        let ack = try decodeEnvelope(out[0])
        XCTAssertEqual(ack.kind, .helloAck)
        let hello = try JSONDecoder().decode(ServerHello.self, from: ack.payload)
        XCTAssertEqual(hello.verdicts, [.snapshotRequired(sessionID: seed.sid, reason: "cursor-ahead", oldestAvailableSeq: 0)],
                       "a cursor beyond the daemon's real high-water must demand a snapshot, never report upToDate")
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(conn.outbound.count, 1, "nothing to replay for an ahead cursor — only the helloAck")
    }

    // MARK: - Review follow-up 2: replay and live must never interleave under a suspending send

    func testR2_HelloAckReplayLiveStrictOrderUnderSuspendingSend() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let socketPath = daemon.socketPath

        let live = NormaClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: daemon.harnessToken, clientName: "live")
        try await live.connect(role: "harness")
        let sid = try await live.request("session.dispatch", params: .object([:]))["sessionId"]!.stringValue!
        let afterAttach = try await live.attach(sessionId: sid, fromSeq: 0)
        let seqM1 = try await live.send(sessionId: sid, text: "m1")
        let seqM2 = try await live.send(sessionId: sid, text: "m2")

        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: socketPath, remoteToken: daemon.remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        // `blockSendsFrom(1)` makes send() genuinely SUSPEND the gateway actor on its first
        // phone-bound frame (the helloAck) — modeling a real async transport whose send awaits.
        // While it is parked, the pump routes a fresh live event. Without hold-and-drain the live
        // frame's send interleaves AHEAD of the still-unflushed lower-seq replay: wire order
        // [helloAck, live, m1, m2]. The phone must instead see helloAck → replay → live.
        let conn = ScriptedRemoteConn()
        conn.blockSendsFrom(1)
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-order", resumes: [
            StreamResume(sessionID: sid, streamID: sid, lastAppliedSeq: afterAttach)
        ]))
        _ = try await waitForOutbound(conn, count: 1) // parked on the helloAck send

        let seqLive = try await live.send(sessionId: sid, text: "m3-live")
        try await Task.sleep(nanoseconds: 300_000_000) // let the pump route it while the gate holds
        conn.releaseSends()

        _ = try await waitForOutboundContainingSeq(conn, seq: seqLive)
        let out = conn.outbound
        XCTAssertEqual(out.count, 4, "exactly helloAck + m1 + m2 + live")
        XCTAssertEqual(try decodeEnvelope(out[0]).kind, .helloAck)
        XCTAssertEqual(try decodeEnvelope(out[1]).seq, seqM1, "replay must precede the live event")
        XCTAssertEqual(try decodeEnvelope(out[2]).seq, seqM2)
        XCTAssertEqual(try decodeEnvelope(out[3]).seq, seqLive, "the live event drains strictly AFTER the replay flush")
        await live.close()
    }

    // MARK: - G7: the Swift remote allowlist is EXACTLY the nine names (cross-language tripwire)

    func testG7_RemoteAllowlistIsExactlyTheNineNames() {
        let expected: Set<String> = [
            "protocol.hello", "session.list", "session.attach", "session.send",
            "session.dispatch", "approval.respond", "ask_user.respond",
            "session.interrupt", "engine.activity",
        ]
        XCTAssertEqual(Gateway.remoteAllowedMethods.count, 9)
        XCTAssertEqual(Gateway.remoteAllowedMethods, expected,
                       "Swift remote allowlist drifted from the nine — mirror packages/core/src/ipc/server.ts's REMOTE_ALLOWED_METHODS")
    }
}
