import XCTest
import os
import NormaProtocol
import NormaSessionKit
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
///   G7  the remote allowlist is EXACTLY the nineteen names (Swift half of the cross-language
///       tripwire — the count is asserted, so this header must be re-stamped when it moves)
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

    func waitForClosed(_ conn: ScriptedRemoteConn, timeout: TimeInterval = 3) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if conn.isClosed { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for conn to close")
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
    /// `memberPeerIDs` seeds an `InMemoryDirectory` at epoch 1 (SP2b Task 4 — `PairingStub` is
    /// gone; every test peer must now be a real allowlist member) — defaults to the lone
    /// `"peer-stub"` every `ScriptedRemoteConn()` default constructs.
    func realGateway(socketPath: String, remoteToken: String, listener: LoopbackListener, memberPeerIDs: [String] = ["peer-stub"]) -> Gateway {
        let directory = InMemoryDirectory(records: memberPeerIDs.map {
            PairRecord(phoneEndpointID: $0, label: "test", createdAt: 0, caps: ["sessions"], pairingEpoch: 1, lastSeenAt: 0)
        })
        return Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { UnixSocketTransport(path: socketPath) }, token: remoteToken, clientName: "iphone-gateway") },
            hostID: "host-test",
            directory: directory
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
        let gateway = realGateway(socketPath: socketPath, remoteToken: remoteToken, listener: listener, memberPeerIDs: ["peer-A", "peer-B"])
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
            hostID: "host-test",
            directory: InMemoryDirectory(peerID: "peer-stub"),
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
            hostID: "host-test",
            directory: InMemoryDirectory(peerID: "peer-stub")
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
        let directory = InMemoryDirectory(peerID: "peer-stub")
        let gateway = Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { daemonTransport }, token: "remote-token", clientName: "iphone-gateway") },
            hostID: "host-test",
            directory: directory
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

        // Production revocation order (`RemoteHost.revoke`): the STORE record goes first, then the
        // gateway fan-out — mirrored here so the post-revoke reconnect below exercises the real
        // enforcement point. Since the SP2b whole-branch review fix, the directory miss (not the
        // gateway's `revoked` set) is what keeps a revoked phone out at the handshake: a member
        // presenting the current epoch deliberately CLEARS its stale `revoked` entry (re-pair
        // re-admission), so a gateway-level revoke alone no longer outlasts a still-valid record.
        directory.remove("peer-stub")
        await gateway.revoke(clientInstanceID: "phone-rev")
        XCTAssertEqual(pump?.isCancelled, true, "revoke must cancel the pumpTask (G5)")

        // Task 4 fix: revoke must also drop the phone's transport connection outright — not just
        // start refusing its future frames (the real-iroh E2E's scenario F is what caught this: a
        // revoked phone's connection must actually disconnect). The `session.revoked` guard in
        // `handleLiveFrame` remains as defense-in-depth for a frame already in flight when revoke
        // lands, but once the conn is closed no further frame can arrive on it at all.
        try await waitForClosed(conn)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(daemonTransport.sent.count, baselineSent, "a revoked phone must not reach the daemon again")

        // T4 review-2 fix 3: a direct per-client revoke must ALSO prune `peerToClients` (the last
        // path that could leave a dead id mapped, breaking the bounded-by-live-state invariant).
        let peerClients = await gateway.peerClientsForTesting("peer-stub")
        XCTAssertFalse(peerClients.contains("phone-rev"), "revoke(clientInstanceID:) must prune the id from peerToClients")

        // A reconnect by the SAME phone is refused at the handshake (as `not_paired` — the
        // membership gate, the revoked phone's record being gone) and the conn is closed.
        let conn2 = ScriptedRemoteConn()
        listener.simulateConnection(conn2)
        conn2.enqueueInbound(try helloFrame(clientInstanceID: "phone-rev", resumes: []))
        let out2 = try await waitForOutbound(conn2, count: 1)
        // SP3.1 T1: a SESSION dialer (its first frame is a `.hello` WireEnvelope) reconnecting after
        // revoke now gets a WireEnvelope `error` carrying a structured `HandshakeRejection`, not the
        // raw-JSON `PairRejected` a pairing dialer sees — so a `NormaSessionClient` can surface the
        // typed `.handshakeRejected(not_paired)` (→ the app's honest `.revoked`) instead of a bare close.
        let rejectionEnv2 = try decodeEnvelope(out2[0])
        XCTAssertEqual(rejectionEnv2.kind, .error)
        let rejected2 = try JSONDecoder().decode(HandshakeRejection.self, from: rejectionEnv2.payload)
        XCTAssertEqual(rejected2.code, "not_paired", "a revoked phone's reconnect is refused at the membership gate")
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

    // MARK: - KA-T2: transport keepalive — gateway answers .ping with .pong pre-rpc, ignores inbound .pong

    func pingFrame(epoch: Int = 1) throws -> Data {
        encodeEnvelope(kind: .ping, payload: Data(), epoch: epoch)
    }

    func pongFrame(epoch: Int = 1) throws -> Data {
        encodeEnvelope(kind: .pong, payload: Data(), epoch: epoch)
    }

    func testPingDrawsPongPreRpc_NeverReachesDaemonOrRateLimiter() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { daemonTransport }, token: "remote-token", clientName: "iphone-gateway") },
            hostID: "host-test",
            directory: InMemoryDirectory(peerID: "peer-stub")
        )
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-ping", resumes: []))
        try await feedDaemonHelloResponse(daemonTransport)
        _ = try await waitForOutbound(conn, count: 1) // helloAck
        let baselineSent = daemonTransport.sent.count

        conn.enqueueInbound(try pingFrame())
        let out = try await waitForOutbound(conn, count: 2)
        let reply = try decodeEnvelope(out[1])
        XCTAssertEqual(reply.kind, .pong, "a ping must draw exactly one pong")
        XCTAssertTrue(reply.payload.isEmpty, "the pong payload must be empty")
        XCTAssertNil(reply.sessionID)
        XCTAssertNil(reply.streamID)
        XCTAssertNil(reply.seq)

        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(daemonTransport.sent.count, baselineSent, "a ping must never reach the daemon or rpc parser")
    }

    func testInboundPongIsIgnored_ConnectionStillServesRpcAfterward() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { daemonTransport }, token: "remote-token", clientName: "iphone-gateway") },
            hostID: "host-test",
            directory: InMemoryDirectory(peerID: "peer-stub")
        )
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-pong", resumes: []))
        try await feedDaemonHelloResponse(daemonTransport)
        _ = try await waitForOutbound(conn, count: 1) // helloAck

        conn.enqueueInbound(try pongFrame())
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(conn.outbound.count, 1, "an inbound pong must draw no reply — no error frame, no extra frame")
        XCTAssertFalse(conn.isClosed, "an inbound pong must not close the connection")

        // The connection still serves a normal rpc afterward.
        conn.enqueueInbound(try rpcRequestFrame(id: 1, method: "session.list", params: nil))
        let lines = try await waitForSent(daemonTransport, count: 2) // hello + this request
        let daemonId = decodeLine(lines[1])["id"] as! Int
        daemonTransport.feed(#"{"jsonrpc":"2.0","id":\#(daemonId),"result":{"sessions":[]}}"#)
        let out = try await waitForOutbound(conn, count: 2)
        let resp = try decodeEnvelope(out[1])
        XCTAssertEqual(resp.kind, .rpcResponse, "the connection must still serve a normal rpc after an ignored pong")
    }

    // MARK: - G7: the Swift remote allowlist is EXACTLY the nineteen names (cross-language tripwire)

    func testG7_RemoteAllowlistIsExactlyTheNineteenNames() {
        let expected: Set<String> = [
            "protocol.hello", "session.list", "session.attach", "session.send",
            "session.dispatch", "approval.respond", "ask_user.respond",
            "session.interrupt", "engine.activity", "approval.list",
            "session.create", "session.history", "session.setModel",
            // provider-correctness T4: per-session reasoning effort, its own method beside setModel.
            "session.setEffort",
            // Chat Slice D task 2: chat-session log replication.
            "sync.heads", "sync.pull", "sync.push",
            // Chat Slice D task 3: standalone-chat config bundle + memory-bucket replica.
            "sync.config", "sync.memory",
        ]
        XCTAssertEqual(Gateway.remoteAllowedMethods.count, 19)
        XCTAssertEqual(Gateway.remoteAllowedMethods, expected,
                       "Swift remote allowlist drifted from the nineteen — mirror packages/core/src/ipc/server.ts's REMOTE_ALLOWED_METHODS")
    }

    // MARK: - WB-C1: a JSON-RPC error's `data` survives the relay (DIVERGED{lastSeq} → the phone)

    /// Chat Slice D whole-branch review, Critical WB-C1. The phone's fork-on-divergence machinery
    /// keys on ONE field: `error.data.lastSeq` off an `ERR.DIVERGED` (-32006) `sync.push` response
    /// (`SyncClient.push` — `guard let daemonLast = e.divergedLastSeq else { throw e }`). Every
    /// per-task gate tested one SIDE of that field's journey — T2 spoke TS straight to the daemon
    /// socket (where `data` is intact), T9 drove a scripted `RpcConn` that FABRICATES
    /// `divergedLastSeq` — and neither touched the component BETWEEN them, this gateway, which
    /// dropped the field twice over (`RpcError` had no `data`; `sendRpcError` re-minted the body as
    /// `{code, message}`). Over the production transport every DIVERGED therefore arrived
    /// field-less and the phone threw instead of reconciling: a lost push ack wedged that session's
    /// sync permanently and fork-on-divergence — the slice's headline mechanic — never ran once.
    ///
    /// So this test deliberately uses NEITHER double: a real daemon, a real `Gateway`, a real
    /// `NormaClient` bridge, and the assertion made on the bytes of the phone-bound `rpcResponse`
    /// frame. Both `lastSeq` values that the client branches on are driven, because they mean
    /// opposite things and only one of them is zero (which a "field present" assertion could pass
    /// by accident):
    ///   • `lastSeq: 0`  — the daemon holds nothing for this id → re-push from seq 1 (NOT a fork);
    ///   • `lastSeq: >0` — a genuine branch point → byte-compare reconcile, then fork.
    func testWBC1_DivergedErrorDataSurvivesTheGatewayRelay_BothZeroAndNonZeroLastSeq() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: daemon.socketPath, remoteToken: daemon.remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-diverged", resumes: []))
        _ = try await waitForOutbound(conn, count: 1) // helloAck

        /// The `error` object of the Nth phone-bound `rpcResponse` frame.
        func errorBody(_ frames: [Data], index: Int) throws -> JSONValue? {
            let env = try decodeEnvelope(frames[index])
            XCTAssertEqual(env.kind, .rpcResponse)
            return try JSONDecoder().decode(JSONValue.self, from: env.payload)["error"]
        }

        // ---- (a) unknown session, baseSeq > 0 → DIVERGED{lastSeq: 0} ------------------------------
        let unknownId = "11111111-2222-4333-8444-555555555555"
        conn.enqueueInbound(try rpcRequestFrame(id: 1, method: "sync.push", params: .object([
            "sessionId": .string(unknownId), "baseSeq": .number(5), "data": .string(""), "complete": .bool(false),
        ])))
        let outA = try await waitForOutbound(conn, count: 2)
        let errA = try errorBody(outA, index: 1)
        XCTAssertEqual(errA?["code"]?.intValue, -32006, "an unknown session pushed at a non-zero base is DIVERGED")
        XCTAssertEqual(errA?["data"]?["lastSeq"]?.intValue, 0,
                       "the relay dropped error.data — the phone reads DIVERGED{lastSeq:0} as 're-push from seq 1', and without it wedges instead")

        // ---- (b) a real chat session, pushed at a stale base → DIVERGED{lastSeq: 1} ---------------
        // Create it the way the phone does: a creating push whose seq-1 event is a chat
        // `session_created` (sync.ts's own precondition for starting a log).
        let liveId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        let created = #"{"type":"session_created","sessionId":"\#(liveId)","seq":1,"ts":1,"scope":"global","mode":"chat"}"#
        conn.enqueueInbound(try rpcRequestFrame(id: 2, method: "sync.push", params: .object([
            "sessionId": .string(liveId), "baseSeq": .number(0),
            "data": .string(Data((created + "\n").utf8).base64EncodedString()), "complete": .bool(true),
        ])))
        let outB = try await waitForOutbound(conn, count: 3)
        let createEnv = try decodeEnvelope(outB[2])
        let createBody = try JSONDecoder().decode(JSONValue.self, from: createEnv.payload)
        XCTAssertNil(createBody["error"], "the creating push must land: \(createBody)")
        XCTAssertEqual(createBody["result"]?["lastSeq"]?.intValue, 1)

        conn.enqueueInbound(try rpcRequestFrame(id: 3, method: "sync.push", params: .object([
            "sessionId": .string(liveId), "baseSeq": .number(7), "data": .string(""), "complete": .bool(false),
        ])))
        let outC = try await waitForOutbound(conn, count: 4)
        let errC = try errorBody(outC, index: 3)
        XCTAssertEqual(errC?["code"]?.intValue, -32006)
        XCTAssertEqual(errC?["data"]?["lastSeq"]?.intValue, 1,
                       "a NON-ZERO branch point must reach the phone verbatim — it is the seq the byte-compare reconcile pulls from")
    }

    // MARK: - Eviction: session-map cap (32) bounds phone churn (SP2b Task 4)

    /// 31 phones connect then hang up (evictable — no `currentConn`), a 32nd stays connected, and
    /// a 33rd trips the cap: the OLDEST disconnected session (phone-0) must be evicted (pump
    /// cancelled, entry gone) while the still-connected one and the newly-added one both survive.
    func testEviction_OldestDisconnectedSessionEvicted_ConnectedSessionSurvives() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: daemon.socketPath, remoteToken: daemon.remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        for i in 0..<31 {
            let conn = ScriptedRemoteConn()
            listener.simulateConnection(conn)
            conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-\(i)", resumes: []))
            _ = try await waitForOutbound(conn, count: 1) // helloAck
            conn.endInbound() // hang up — becomes evictable once `handle`'s loop notices
        }
        let firstPump = await gateway.pumpTaskForTesting("phone-0")
        XCTAssertNotNil(firstPump, "phone-0's session/pump must exist before eviction")

        // A phone that STAYS connected — must survive eviction even though it joins the map at
        // the same "already near cap" moment as the disconnected ones.
        let survivorConn = ScriptedRemoteConn()
        listener.simulateConnection(survivorConn)
        survivorConn.enqueueInbound(try helloFrame(clientInstanceID: "phone-survivor", resumes: []))
        _ = try await waitForOutbound(survivorConn, count: 1)
        // sessions.count is now 32 (phone-0..30 disconnected + phone-survivor connected).

        // Settle grace window (matches this file's own idiom elsewhere): let the 31 disconnects'
        // async `currentConn = nil` cleanup actually land before tripping eviction with the 33rd
        // connection — this is a precondition settle, not the eviction assertion itself (that's
        // the condition-based poll below).
        try await Task.sleep(nanoseconds: 200_000_000)

        let conn32 = ScriptedRemoteConn()
        listener.simulateConnection(conn32)
        conn32.enqueueInbound(try helloFrame(clientInstanceID: "phone-32", resumes: []))
        _ = try await waitForOutbound(conn32, count: 1)

        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline, firstPump?.isCancelled != true {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(firstPump?.isCancelled, true, "the oldest disconnected session must be evicted once the cap is hit")
        let phone0PumpAfter = await gateway.pumpTaskForTesting("phone-0")
        XCTAssertNil(phone0PumpAfter, "phone-0's session entry must be gone after eviction")

        let survivorPump = await gateway.pumpTaskForTesting("phone-survivor")
        XCTAssertNotNil(survivorPump, "a still-connected session must never be evicted")
        let phone32Pump = await gateway.pumpTaskForTesting("phone-32")
        XCTAssertNotNil(phone32Pump, "the newly-added session must exist")
    }

    /// T4 review fix 2: `peerToClients` must be pruned in lockstep with eviction. One paired device
    /// (every `ScriptedRemoteConn()` defaults to peerID "peer-stub") churns 40 distinct
    /// `clientInstanceID`s — e.g. repeated app reinstalls — each connecting, handshaking, hanging
    /// up. Eviction keeps `sessions` capped at 32; before the fix, `peerToClients["peer-stub"]`
    /// still grew to all 40 ever-seen ids. Post-fix it must track LIVE sessions exactly: every id
    /// in the set has a session, every session's id is in the set, and the count is bounded by the
    /// cap — never the churn total.
    func testEviction_PeerToClientsPrunedInLockstep_BoundedForChurningPeer() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: daemon.socketPath, remoteToken: daemon.remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        for i in 0..<40 {
            let conn = ScriptedRemoteConn()
            listener.simulateConnection(conn)
            conn.enqueueInbound(try helloFrame(clientInstanceID: "churn-\(i)", resumes: []))
            _ = try await waitForOutbound(conn, count: 1) // helloAck
            conn.endInbound() // hang up — evictable once `handle`'s loop notices
        }
        // Settle grace window (this file's established idiom): let the trailing disconnects'
        // async `currentConn = nil` cleanup land before taking the final snapshot.
        try await Task.sleep(nanoseconds: 200_000_000)

        let clients = await gateway.peerClientsForTesting("peer-stub")
        XCTAssertLessThanOrEqual(clients.count, 32, "peerToClients must stay bounded by the session cap, never grow with every ever-seen id")
        XCTAssertGreaterThan(clients.count, 0, "sanity: the live sessions' ids are still mapped")

        // The set must equal the LIVE session set exactly — membership both ways.
        for i in 0..<40 {
            let id = "churn-\(i)"
            let hasSession = await gateway.pumpTaskForTesting(id) != nil
            XCTAssertEqual(clients.contains(id), hasSession,
                           "\(id): peerToClients membership must track its session's existence exactly (session: \(hasSession))")
        }
    }

    // MARK: - Eviction re-entrancy (T4 review-2 fix 1): the close-await window

    /// Parks the FIRST eviction inside `evictIfNeeded`'s close-await window (via the gateway's
    /// `#if DEBUG` eviction gate — a deterministic stand-in for `close()`'s own suspension) and
    /// passes every later one through. Continuation-based both ways — no sleeps: the test awaits
    /// `waitUntilParked()` to know eviction is genuinely inside the window, and eviction awaits
    /// the test's `release()`. Same `OSAllocatedUnfairLock` + resume-outside-the-lock conventions
    /// as `ScriptedRemoteConn`.
    private final class EvictionGate: @unchecked Sendable {
        private struct State {
            var firstEvictedID: String?
            var fired = false
            var parkedWaiter: CheckedContinuation<String, Never>?
            var release: CheckedContinuation<Void, Never>?
            var released = false
        }
        private let state = OSAllocatedUnfairLock(initialState: State())

        /// The gateway-side half — install as the eviction gate.
        func onEvict(_ id: String) async {
            let (shouldPark, waiter): (Bool, CheckedContinuation<String, Never>?) = state.withLock { s in
                guard !s.fired else { return (false, nil) }
                s.fired = true
                s.firstEvictedID = id
                let w = s.parkedWaiter
                s.parkedWaiter = nil
                return (true, w)
            }
            waiter?.resume(returning: id)
            guard shouldPark else { return }
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                let releaseNow: Bool = state.withLock { s in
                    if s.released { return true }
                    s.release = cont
                    return false
                }
                if releaseNow { cont.resume() }
            }
        }

        /// The test-side half — resolves (with the evicted id) once the first eviction is parked.
        func waitUntilParked() async -> String {
            await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
                let already: String? = state.withLock { s in
                    if s.fired { return s.firstEvictedID }
                    s.parkedWaiter = cont
                    return nil
                }
                if let already { cont.resume(returning: already) }
            }
        }

        func release() {
            let cont: CheckedContinuation<Void, Never>? = state.withLock { s in
                s.released = true
                let c = s.release
                s.release = nil
                return c
            }
            cont?.resume()
        }
    }

    /// T4 review-2 fix 1, both hazards, raced deterministically into the close-await window:
    ///   (a) a same-id reconnect landing WHILE its session is being evicted must mint a FRESH,
    ///       fully-functional session (helloAck AND a live daemon round trip AND an alive pump) —
    ///       pre-fix (entry removed only AFTER the close-await) the reconnect cache-hit the
    ///       half-torn-down object: cancelled pump, closing daemon client, then eviction's resume
    ///       removed the entry despite the now-live conn;
    ///   (b) a LATER eviction candidate that acquires a live connection while an earlier
    ///       iteration is suspended must be SKIPPED (the snapshot's `currentConn == nil` filter is
    ///       stale by then) — a live-conn session is never evicted.
    func testEviction_SameIDReconnectDuringCloseGetsFunctionalSession_LiveConnNeverEvicted() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: daemon.socketPath, remoteToken: daemon.remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        // Fill to cap with 32 disconnected sessions — phone-0 oldest, phone-1 second-oldest.
        for i in 0..<32 {
            let conn = ScriptedRemoteConn()
            listener.simulateConnection(conn)
            conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-\(i)", resumes: []))
            _ = try await waitForOutbound(conn, count: 1) // helloAck
            conn.endInbound()
        }
        // Settle grace window (this file's established idiom): a PRECONDITION — let every
        // disconnect's async `currentConn = nil` land so all 32 are genuinely evictable before
        // the race below starts. The race itself is entirely continuation-based, no sleeps.
        try await Task.sleep(nanoseconds: 200_000_000)

        let gate = EvictionGate()
        await gateway.setEvictionGateForTesting { id in await gate.onEvict(id) }

        // A NEW phone id trips eviction; its own handshake stays parked inside the gate with it.
        let trigger = ScriptedRemoteConn()
        listener.simulateConnection(trigger)
        trigger.enqueueInbound(try helloFrame(clientInstanceID: "phone-new", resumes: []))

        // Eviction is now provably inside the close-await window: phone-0's entry is REMOVED
        // (and peer map pruned, pump cancelled) but its daemon client is not yet closed.
        let parkedID = await gate.waitUntilParked()
        XCTAssertEqual(parkedID, "phone-0", "the oldest disconnected candidate is evicted first")

        // Hazard (a): phone-0 reconnects INSIDE the window → cache miss → a fresh session.
        let phone0Reconn = ScriptedRemoteConn()
        listener.simulateConnection(phone0Reconn)
        phone0Reconn.enqueueInbound(try helloFrame(clientInstanceID: "phone-0", resumes: []))
        let out0 = try await waitForOutbound(phone0Reconn, count: 1)
        XCTAssertEqual(try decodeEnvelope(out0[0]).kind, .helloAck)
        // FUNCTIONAL, not just acked: a live rpc must round-trip against the real daemon — the
        // pre-fix stale ride fails exactly here (its daemon client is the one being closed).
        phone0Reconn.enqueueInbound(try rpcRequestFrame(id: 1, method: "session.list", params: nil))
        let out0b = try await waitForOutbound(phone0Reconn, count: 2)
        let listResp = try decodeEnvelope(out0b[1])
        XCTAssertEqual(listResp.kind, .rpcResponse)
        let listBody = try JSONDecoder().decode(JSONValue.self, from: listResp.payload)
        XCTAssertNil(listBody["error"], "the reconnect's session must reach the daemon — a stale ride's closing client errors here")
        let pump0 = await gateway.pumpTaskForTesting("phone-0")
        XCTAssertNotNil(pump0, "the fresh session must have a pump")
        XCTAssertEqual(pump0?.isCancelled, false, "…an ALIVE one, not the evicted session's cancelled pump")

        // Hazard (b): phone-1 — still in the (stale) candidates snapshot — acquires a live conn
        // while eviction is parked. When eviction resumes it must SKIP phone-1, not evict it.
        let phone1Reconn = ScriptedRemoteConn()
        listener.simulateConnection(phone1Reconn)
        phone1Reconn.enqueueInbound(try helloFrame(clientInstanceID: "phone-1", resumes: []))
        _ = try await waitForOutbound(phone1Reconn, count: 1) // helloAck riding its intact session

        gate.release()

        // Eviction resumes: closes phone-0's stale client, skips phone-1 (live conn), evicts the
        // next disconnected candidate (phone-2) to get back under cap, and phone-new's own
        // handshake completes. Condition-based waits only.
        let outTrigger = try await waitForOutbound(trigger, count: 1)
        XCTAssertEqual(try decodeEnvelope(outTrigger[0]).kind, .helloAck, "the triggering phone's handshake completes after eviction")
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if await gateway.pumpTaskForTesting("phone-2") == nil { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let phone2Pump = await gateway.pumpTaskForTesting("phone-2")
        XCTAssertNil(phone2Pump, "with phone-1 skipped, the next disconnected candidate (phone-2) is evicted instead")

        let pump1 = await gateway.pumpTaskForTesting("phone-1")
        XCTAssertNotNil(pump1, "a candidate that went live mid-eviction must never be evicted")
        XCTAssertEqual(pump1?.isCancelled, false)
        XCTAssertFalse(phone1Reconn.isClosed, "…and its live connection is untouched")

        await gateway.setEvictionGateForTesting(nil)
    }

    // MARK: - Re-pair after revoke (SP2b whole-branch review): stale revocation must not outlive it

    /// SP2b whole-branch review (Important): the `revoked` set never cleared, so a revoked-then-
    /// RE-PAIRED phone reconnecting with its stable `clientInstanceID` was refused "pairing
    /// revoked" forever — despite being a current directory member presenting the current epoch —
    /// until an app reinstall minted a new id. (Reachable in production because the gateway
    /// survives a revoke whenever ANOTHER device is still paired — `RemoteHost.stopIfIdle` won't
    /// tear it down — so the set outlives the re-pair ceremony.) Fail-closed, but silently breaks
    /// re-pair for the multi-device case.
    ///
    /// Contract proven here, both directions:
    ///   - a revoked peer that was NOT re-added to the directory stays refused (`not_paired` at
    ///     the membership gate — SP2a gate G5's production shape, NOT weakened);
    ///   - a revoked peer that WAS re-paired (directory record back, epoch bumped) and presents
    ///     the CURRENT epoch is re-admitted under the SAME `clientInstanceID`.
    func testRepair_RevokedThenRepairedPeerSameClientInstanceID_IsAdmitted_UnrepairedStaysRefused() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let directory = InMemoryDirectory(peerID: "peer-X", epoch: 1)
        let listener = LoopbackListener()
        let gateway = Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { UnixSocketTransport(path: daemon.socketPath) }, token: daemon.remoteToken, clientName: "iphone-gateway") },
            hostID: "host-test",
            directory: directory
        )
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        // Initial handshake: member @epoch1, stable clientInstanceID "X".
        let conn1 = ScriptedRemoteConn(peerID: "peer-X")
        listener.simulateConnection(conn1)
        conn1.enqueueInbound(try helloFrame(clientInstanceID: "X", resumes: [], epoch: 1))
        let out1 = try await waitForOutbound(conn1, count: 1)
        XCTAssertEqual(try decodeEnvelope(out1[0]).kind, .helloAck)

        // Revoke, production order (RemoteHost.revoke): store record removed FIRST, then the
        // gateway fan-out tears down the live footprint.
        directory.remove("peer-X")
        await gateway.revoke(peerID: "peer-X")
        try await waitForClosed(conn1)

        // STILL revoked (no re-pair): the reconnect dies at the membership gate as not_paired —
        // the directory miss, not the `revoked` set, is what keeps a revoked phone out.
        let conn2 = ScriptedRemoteConn(peerID: "peer-X")
        listener.simulateConnection(conn2)
        conn2.enqueueInbound(try helloFrame(clientInstanceID: "X", resumes: [], epoch: 1))
        let out2 = try await waitForOutbound(conn2, count: 1)
        // SP3.1 T1: a session dialer's not_paired refusal is now a WireEnvelope `error` carrying a
        // structured `HandshakeRejection` (see the reconnect assertion in `testG5_...`).
        let rejectionEnv = try decodeEnvelope(out2[0])
        XCTAssertEqual(rejectionEnv.kind, .error)
        let rejected = try JSONDecoder().decode(HandshakeRejection.self, from: rejectionEnv.payload)
        XCTAssertEqual(rejected.code, "not_paired", "a revoked, not-re-paired phone is refused at the membership gate")
        try await waitForClosed(conn2)

        // RE-PAIR: the ceremony's `store.add` puts the record back with the epoch BUMPED (what
        // `PairingManager.confirm` does after a revoke) — simulated directly on the directory.
        directory.set(PairRecord(phoneEndpointID: "peer-X", label: "re-paired", createdAt: 0, caps: ["sessions"], pairingEpoch: 2, lastSeenAt: 0))

        // The re-paired phone reconnects: SAME clientInstanceID "X", CURRENT epoch 2 → must be
        // ADMITTED (ServerHello), not refused "pairing revoked" by the stale set.
        let conn3 = ScriptedRemoteConn(peerID: "peer-X")
        listener.simulateConnection(conn3)
        conn3.enqueueInbound(try helloFrame(clientInstanceID: "X", resumes: [], epoch: 2))
        let out3 = try await waitForOutbound(conn3, count: 1)
        let env3 = try decodeEnvelope(out3[0], epoch: 2)
        XCTAssertEqual(env3.kind, .helloAck, "a re-paired member presenting the CURRENT epoch must be re-admitted — a stale revocation must not outlive the re-pair")
        let serverHello = try JSONDecoder().decode(ServerHello.self, from: env3.payload)
        XCTAssertEqual(serverHello.hostID, "host-test")
    }

    // MARK: - T6b: TWO connections on ONE PhoneSession
    //
    // Since the iOS connection pool landed, a single install genuinely holds two connections at
    // once — a short-lived SHELL conn (`session.list`/`sync.*`/`session.create`, always a
    // resume-less handshake) alongside a `CodeSessionModel`'s own attached conn — and both carry
    // the same `PhoneClientInstanceID.stable()`, so both land on the SAME `PhoneSession`. Every
    // OTHER case in this file uses a distinct `clientInstanceID` per connection, so nothing here
    // covered that shape at all. These three tests do, and each one fails without its own fix.

    /// **T6b review, Important 1.** A resume-less hello must not disturb ANOTHER connection's
    /// in-flight `session.attach` replay flush.
    ///
    /// `handle` used to raise a live hold before it knew whether the hello carried resumes. Post-6b
    /// a resume-less hello can neither move `liveConn` nor receive a live frame, so its hold
    /// protects nothing — but `drainHeldLive` targets `liveConn`, so that hold's drain flushed a
    /// DIFFERENT connection's queued live events onto that connection's wire, mid-replay, and
    /// lowered the hold behind it. The phone cannot repair the reorder on this path:
    /// `NormaSessionClient` buffers only while `replaying`, which is set from a `ServerHello`
    /// verdict, and the attach rpc returns only `lastSeq` — so the higher-seq live event advances
    /// the durable cursor and the still-pending lower-seq replay frames are dropped as duplicates.
    /// Silent, permanent transcript loss, on exactly the two paths this task exists to make work
    /// (the foreground-hop probe and the adopted "+ New Chat" connection).
    ///
    /// The interleave is made deterministic rather than raced: `blockSendsFrom` parks conn A inside
    /// its FIRST replay frame's `send`, which suspends the actor exactly where a real transport
    /// would, and the shell hello is driven into that window.
    func testT6b_ResumelessHelloDoesNotReorderAnotherConnectionsReplayFlush() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: daemon.socketPath, remoteToken: daemon.remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let seeded = try await seedTwoMessages(socketPath: daemon.socketPath, harnessToken: daemon.harnessToken)

        // Conn A — the session connection. Resume-less hello, then the live `session.attach` rpc
        // (the probe / adopted-connection path), which has a real two-event replay window.
        let sessionConn = ScriptedRemoteConn()
        listener.simulateConnection(sessionConn)
        sessionConn.enqueueInbound(try helloFrame(clientInstanceID: "phone-pooled", resumes: []))
        _ = try await waitForOutbound(sessionConn, count: 1) // helloAck

        // Park conn A inside the FIRST frame the attach flush sends (frame #2 overall).
        sessionConn.blockSendsFrom(2)
        sessionConn.enqueueInbound(try rpcRequestFrame(id: 1, method: "session.attach", params: .object([
            "sessionId": .string(seeded.sid), "fromSeq": .number(Double(seeded.afterHarnessAttach)),
        ])))
        _ = try await waitForOutbound(sessionConn, count: 2) // the first replay frame, recorded then parked

        // A live event lands while conn A is parked: it must queue on `heldLive` behind the replay.
        let harness = NormaClient(makeTransport: { UnixSocketTransport(path: daemon.socketPath) }, token: daemon.harnessToken, clientName: "t6b-live")
        try await harness.connect(role: "harness")
        _ = try await harness.attach(sessionId: seeded.sid, fromSeq: seeded.seqM2)
        let seqM3 = try await harness.send(sessionId: seeded.sid, text: "m3")
        defer { Task { await harness.close() } }
        // Settle so the gateway's own pump has enqueued it before the shell hello (this file's
        // established precondition-settle idiom — the assertion below is not timing-based).
        try await Task.sleep(nanoseconds: 300_000_000)

        // Conn B — the pool's shell connection, SAME install id, resume-less. Pre-fix its drain
        // fires here and lands `m3` on conn A's wire between conn A's two replay frames.
        let shellConn = ScriptedRemoteConn()
        listener.simulateConnection(shellConn)
        shellConn.enqueueInbound(try helloFrame(clientInstanceID: "phone-pooled", resumes: []))
        _ = try await waitForOutbound(shellConn, count: 1) // shell helloAck
        try await Task.sleep(nanoseconds: 300_000_000) // give a (pre-fix) drain time to land

        sessionConn.releaseSends()

        // Wait for the WHOLE flush, not just for `m3` — pre-fix `m3` arrives BEFORE the second
        // replay frame, so waiting on it alone would snapshot `outbound` mid-flush and fail on a
        // count assertion instead of on the ordering one that is the actual subject here. The
        // attach's rpcResponse is emitted after the replay loop, so "3 events + a response" is the
        // honest "flush complete" condition under both orderings.
        func eventSeqsSoFar() -> [Int] {
            sessionConn.outbound.compactMap { frame -> Int? in
                guard let env = try? decodeEnvelope(frame), env.kind == .event else { return nil }
                return env.seq
            }
        }
        let flushDeadline = Date().addingTimeInterval(5)
        while Date() < flushDeadline {
            let sawResponse = sessionConn.outbound.contains { (try? decodeEnvelope($0))?.kind == .rpcResponse }
            if eventSeqsSoFar().count >= 3, sawResponse { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        let eventSeqs = eventSeqsSoFar()
        XCTAssertTrue(eventSeqs.contains(seqM3), "sanity: the live event must reach the session connection at all")
        XCTAssertGreaterThanOrEqual(eventSeqs.count, 3, "sanity: two replay frames plus the live one")
        XCTAssertEqual(eventSeqs, eventSeqs.sorted(),
                       "a resume-less hello on ANOTHER connection must not flush live events into the middle of this one's replay — the phone's reorder buffer is inactive on the attach-rpc path, so an out-of-order seq here is permanently lost transcript. Got \(eventSeqs)")
    }

    /// **T6b review, Important 2a.** `revoke` must close EVERY connection the phone holds.
    ///
    /// Pre-6b it closed `currentConn` — whichever connection handshook most recently — so the other
    /// one stayed open indefinitely. That is precisely the hole SP2a Task 4 closed ("a real phone's
    /// connection must actually drop, not just get ignored going forward"), silently re-opened by
    /// the phone growing a second connection underneath it. G5 above pins the single-connection
    /// case; nothing pinned this one, so reverting the fix would have left the suite green.
    func testT6b_RevokeClosesEveryConnectionThePhoneHolds() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let directory = InMemoryDirectory(peerID: "peer-stub")
        let gateway = Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { daemonTransport }, token: "remote-token", clientName: "iphone-gateway") },
            hostID: "host-test",
            directory: directory
        )
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        // Conn A first, conn B second — same install id, so ONE PhoneSession. Only conn A's hello
        // opens the daemon client (`session.connected` is already true for conn B).
        let connA = ScriptedRemoteConn()
        listener.simulateConnection(connA)
        connA.enqueueInbound(try helloFrame(clientInstanceID: "phone-pooled", resumes: []))
        try await feedDaemonHelloResponse(daemonTransport)
        _ = try await waitForOutbound(connA, count: 1)

        let connB = ScriptedRemoteConn()
        listener.simulateConnection(connB)
        connB.enqueueInbound(try helloFrame(clientInstanceID: "phone-pooled", resumes: []))
        _ = try await waitForOutbound(connB, count: 1)

        directory.remove("peer-stub")
        await gateway.revoke(clientInstanceID: "phone-pooled")

        try await waitForClosed(connB)
        try await waitForClosed(connA)
        XCTAssertTrue(connA.isClosed, "revoke must close the OLDER connection too — pre-T6b only the most recent one was closed, leaving an authenticated peer's transport open after its authorization was withdrawn")
        XCTAssertTrue(connB.isClosed)
    }

    /// **T6b review, Important 2b.** Eviction's liveness signal must be "any open connection", not
    /// "the most recent connection".
    ///
    /// `evictIfNeeded` read `currentConn == nil` — the same pointer live forwarding used. When a
    /// phone holds two connections and the NEWER one hangs up (the pool's shell conn after its
    /// linger, the common case), that cleared the pointer and the phone looked disconnected — so
    /// eviction could tear down the daemon client and event pump of a phone still attached on its
    /// other connection. The pooled phone here is deliberately the OLDEST session in the map, so it
    /// is the eviction candidate the pre-fix code would pick FIRST.
    func testT6b_APhoneWithAnotherOpenConnectionIsNotEvictable() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let listener = LoopbackListener()
        let gateway = realGateway(socketPath: daemon.socketPath, remoteToken: daemon.remoteToken, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        func connect(_ id: String) async throws -> ScriptedRemoteConn {
            let conn = ScriptedRemoteConn()
            listener.simulateConnection(conn)
            conn.enqueueInbound(try helloFrame(clientInstanceID: id, resumes: []))
            _ = try await waitForOutbound(conn, count: 1) // helloAck
            return conn
        }

        // The pooled phone goes FIRST so its `lastActiveAt` is the oldest in the map — i.e. it is
        // the first candidate `evictIfNeeded` would take if it looked disconnected.
        let connA = try await connect("phone-pooled")
        let connB = try await connect("phone-pooled")   // same install id → same PhoneSession

        for i in 0..<30 {
            let filler = try await connect("phone-\(i)")
            filler.endInbound() // hang up — evictable
        }
        // sessions: phone-pooled (2 conns) + phone-0..29 disconnected = 31.

        connB.endInbound() // the NEWER connection hangs up; conn A is still attached
        try await Task.sleep(nanoseconds: 300_000_000) // let the disconnect bookkeeping land

        _ = try await connect("filler-a")   // 31 < cap: inserts, no eviction. Map is now 32.
        _ = try await connect("filler-b")   // 32 >= cap: eviction runs, oldest disconnected first.

        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline, await gateway.pumpTaskForTesting("phone-0") != nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let pooledPump = await gateway.pumpTaskForTesting("phone-pooled")
        XCTAssertNotNil(pooledPump, "a phone with ANOTHER connection still open must never be evicted — pre-T6b the newer connection's hang-up cleared the liveness pointer and this phone, the oldest in the map, was taken first")
        XCTAssertEqual(pooledPump?.isCancelled, false, "...and its event pump must still be running")
        let evicted = await gateway.pumpTaskForTesting("phone-0")
        XCTAssertNil(evicted, "sanity: eviction really did run, and took the oldest genuinely-disconnected session instead")

        // ...and the signal is symmetric: once the LAST connection goes, the phone is evictable.
        connA.endInbound()
        try await Task.sleep(nanoseconds: 300_000_000)
        _ = try await connect("filler-c")   // trips the cap again; phone-pooled is now the oldest evictable

        let deadline2 = Date().addingTimeInterval(3)
        while Date() < deadline2, await gateway.pumpTaskForTesting("phone-pooled") != nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let pooledAfter = await gateway.pumpTaskForTesting("phone-pooled")
        XCTAssertNil(pooledAfter, "once its last connection closes the phone must become evictable again — `openConns` must empty, not just shrink")
    }
}
