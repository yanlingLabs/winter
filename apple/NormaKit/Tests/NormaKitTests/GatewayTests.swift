import XCTest
import NormaProtocol
@testable import NormaKit

/// Remote Gateway SP1 Task 5 (the capstone): the `Gateway` actor terminates a remote (phone)
/// transport, validates envelopes, bridges to the daemon as the `remote` principal, and
/// orchestrates resume/replay + the gateway-side allowlist. Exercised end-to-end with:
///   - `ScriptedRemoteConn`/`LoopbackListener` (RemoteTransport.swift) standing in for the
///     phone-side transport (SP2 wires the real iroh listener at this exact seam).
///   - `ScriptedTransport` (NormaClientTests.swift, same test target) standing in for the
///     daemon-side `NormaTransport` — no live bun process needed.
/// Scenarios A-E mirror the task brief verbatim.
final class GatewayTests: XCTestCase {

    // MARK: - Helpers

    func makeGateway(daemonTransport: ScriptedTransport, listener: LoopbackListener) -> Gateway {
        Gateway(
            listener: listener,
            daemonFactory: { NormaClient(makeTransport: { daemonTransport }, token: "remote-token", clientName: "iphone-gateway") },
            pairing: Gateway.PairingStub()
        )
    }

    func encodeEnvelope(
        kind: WireKind, sessionID: String? = nil, streamID: String? = nil, seq: Int? = nil,
        payload: Data, epoch: Int = 1
    ) -> Data {
        let e = WireEnvelope(
            v: 1, pairingEpoch: epoch, hostID: "phone-x", sessionID: sessionID, streamID: streamID,
            seq: seq, kind: kind, timestamp: 0, payload: payload
        )
        return try! WireFrame.encode(e)
    }

    func decodeEnvelope(_ data: Data, epoch: Int = 1, maxBytes: Int = 4 << 20) throws -> WireEnvelope {
        try WireFrame.decode(data, maxBytes: maxBytes, expectedEpoch: epoch)
    }

    func helloFrame(clientInstanceID: String, resumes: [StreamResume], epoch: Int = 1) throws -> Data {
        let hello = ClientHello(
            protocolVersions: [1], appBuild: "1", clientInstanceID: clientInstanceID,
            pairingEpoch: epoch, resumes: resumes
        )
        return encodeEnvelope(kind: .hello, payload: try JSONEncoder().encode(hello), epoch: epoch)
    }

    func rpcRequestFrame(id: Int, method: String, params: JSONValue?, commandId: String? = nil) throws -> Data {
        var obj: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": .number(Double(id)), "method": .string(method)]
        if let params { obj["params"] = params }
        if let commandId { obj["commandId"] = .string(commandId) }
        let payload = try JSONEncoder().encode(JSONValue.object(obj))
        return encodeEnvelope(kind: .rpcRequest, payload: payload)
    }

    func waitForOutbound(_ conn: ScriptedRemoteConn, count: Int, timeout: TimeInterval = 2) async throws -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if conn.outbound.count >= count { return conn.outbound }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(count) outbound frames; got \(conn.outbound.count)")
        return conn.outbound
    }

    func waitForClosed(_ conn: ScriptedRemoteConn, timeout: TimeInterval = 2) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if conn.isClosed { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for conn to close")
    }

    /// Answers the daemon-side hello (always the first line the gateway's bridge client sends).
    func feedDaemonHelloResponse(_ t: ScriptedTransport) async throws {
        let line = try await waitForSent(t, count: 1)[0]
        let id = decodeLine(line)["id"] as! Int
        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"ok":true}}"#)
    }

    // MARK: - Scenario A: hello/resume replays the gap; a fresh cursor is up-to-date

    func testScenarioA_HelloResumeReplaysGapThenFreshCursorIsUpToDate() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = makeGateway(daemonTransport: daemonTransport, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn1 = ScriptedRemoteConn()
        listener.simulateConnection(conn1)
        conn1.enqueueInbound(try helloFrame(
            clientInstanceID: "phone-a",
            resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 2)]
        ))

        try await feedDaemonHelloResponse(daemonTransport)

        let attachLine = try await waitForSent(daemonTransport, count: 2)[1]
        XCTAssertEqual(decodeLine(attachLine)["method"] as? String, "session.attach")
        let attachId = decodeLine(attachLine)["id"] as! Int
        for seq in 3...5 {
            daemonTransport.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"user_message","seq":\#(seq),"sessionId":"s1","ts":0,"threadId":"main","text":"m\#(seq)","clientName":"harness"}}"#)
        }
        daemonTransport.feed(#"{"jsonrpc":"2.0","id":\#(attachId),"result":{"ok":true,"lastSeq":5}}"#)

        // SP2a G3: helloAck is now the FIRST phone-bound frame; the replay events follow it.
        let outbound1 = try await waitForOutbound(conn1, count: 4)
        let ack1 = try decodeEnvelope(outbound1[0])
        XCTAssertEqual(ack1.kind, .helloAck)
        let ev3 = try decodeEnvelope(outbound1[1])
        let ev4 = try decodeEnvelope(outbound1[2])
        let ev5 = try decodeEnvelope(outbound1[3])
        XCTAssertEqual(ev3.kind, .event)
        XCTAssertEqual(ev3.seq, 3)
        XCTAssertEqual(ev4.seq, 4)
        XCTAssertEqual(ev5.seq, 5)
        let serverHello1 = try JSONDecoder().decode(ServerHello.self, from: ack1.payload)
        XCTAssertEqual(serverHello1.verdicts, [.replayBegin(sessionID: "s1", fromSeq: 2, highWatermark: 5)])

        // Second connection, SAME phone, cursor already at the high watermark: upToDate, zero
        // replay frames — only the helloAck should land.
        let conn2 = ScriptedRemoteConn()
        listener.simulateConnection(conn2)
        conn2.enqueueInbound(try helloFrame(
            clientInstanceID: "phone-a",
            resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 5)]
        ))

        let attachLine2 = try await waitForSent(daemonTransport, count: 3)[2]
        XCTAssertEqual(decodeLine(attachLine2)["method"] as? String, "session.attach")
        let attachId2 = decodeLine(attachLine2)["id"] as! Int
        // Real-daemon-faithful script (SP2a review follow-up 1): hub.attach ALWAYS appends a fresh
        // `harness_attached` for the attach itself and returns ITS seq — so a caught-up cursor
        // still sees raw return (6) > fromSeq (5), with nothing but noise in the replay. (The old
        // `lastSeq:5` == fromSeq shape is, under honest semantics, an impossible/ahead cursor and
        // now correctly demands a snapshot — see GatewayGateTests.testR1.)
        daemonTransport.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"harness_attached","seq":6,"sessionId":"s1","ts":0,"clientName":"iphone-gateway"}}"#)
        daemonTransport.feed(#"{"jsonrpc":"2.0","id":\#(attachId2),"result":{"ok":true,"lastSeq":6}}"#)

        let outbound2 = try await waitForOutbound(conn2, count: 1)
        let ack2 = try decodeEnvelope(outbound2[0])
        XCTAssertEqual(ack2.kind, .helloAck)
        let serverHello2 = try JSONDecoder().decode(ServerHello.self, from: ack2.payload)
        XCTAssertEqual(serverHello2.verdicts, [.upToDate(sessionID: "s1", highWatermark: 5)])
        // No event frames beyond the helloAck.
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(conn2.outbound.count, 1)
    }

    // MARK: - Scenario B: gateway-side allowlist rejects an off-list method before the daemon sees it

    func testScenarioB_AllowlistRejectsOffListMethodBeforeDaemon() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = makeGateway(daemonTransport: daemonTransport, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-b", resumes: []))
        try await feedDaemonHelloResponse(daemonTransport)
        _ = try await waitForOutbound(conn, count: 1) // helloAck

        let baselineSentCount = daemonTransport.sent.count
        conn.enqueueInbound(try rpcRequestFrame(id: 1, method: "daemon.trustDir", params: .object(["path": .string("/tmp")])))

        let outbound = try await waitForOutbound(conn, count: 2)
        let rejection = try decodeEnvelope(outbound[1])
        XCTAssertEqual(rejection.kind, .error)
        let body = try JSONDecoder().decode(JSONValue.self, from: rejection.payload)
        XCTAssertEqual(body["error"]?["message"]?.stringValue, "remote role may not call daemon.trustDir")

        // Never reached the daemon.
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(daemonTransport.sent.count, baselineSentCount)
    }

    // MARK: - Scenario C: envelope rejection — oversize (recoverable) vs stale epoch (closes)

    func testScenarioC_EnvelopeRejectionOversizeAndStaleEpoch() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = makeGateway(daemonTransport: daemonTransport, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-c", resumes: []))
        try await feedDaemonHelloResponse(daemonTransport)
        _ = try await waitForOutbound(conn, count: 1) // helloAck

        // Oversize: a payload bigger than WireFrame.decode's default 1MB maxBytes — the gateway
        // must emit an error frame but NOT close the connection.
        let hugePayload = try JSONEncoder().encode(JSONValue.object([
            "jsonrpc": .string("2.0"), "id": .number(1), "method": .string("session.list"),
            "junk": .string(String(repeating: "x", count: 2 << 20)),
        ]))
        conn.enqueueInbound(encodeEnvelope(kind: .rpcRequest, payload: hugePayload))
        let outbound = try await waitForOutbound(conn, count: 2)
        let oversizeError = try decodeEnvelope(outbound[1])
        XCTAssertEqual(oversizeError.kind, .error)
        XCTAssertFalse(conn.isClosed, "an oversize frame is recoverable — the connection must stay open")

        // Stale epoch: encoded with a DIFFERENT pairingEpoch than the gateway's PairingStub (1).
        let staleFrame = encodeEnvelope(
            kind: .rpcRequest,
            payload: try JSONEncoder().encode(JSONValue.object(["jsonrpc": .string("2.0"), "id": .number(2), "method": .string("session.list")])),
            epoch: 999
        )
        conn.enqueueInbound(staleFrame)

        let outbound2 = try await waitForOutbound(conn, count: 3) // helloAck, oversize-err, stale-err
        let staleError = try decodeEnvelope(outbound2[2])
        XCTAssertEqual(staleError.kind, .error)
        try await waitForClosed(conn)
    }

    // MARK: - Scenario D: transparent commandId passthrough — the gateway never dedups itself

    func testScenarioD_IdempotencyPassthroughForwardsBothUnchanged() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = makeGateway(daemonTransport: daemonTransport, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn = ScriptedRemoteConn()
        listener.simulateConnection(conn)
        conn.enqueueInbound(try helloFrame(clientInstanceID: "phone-d", resumes: []))
        try await feedDaemonHelloResponse(daemonTransport)
        _ = try await waitForOutbound(conn, count: 1) // helloAck

        conn.enqueueInbound(try rpcRequestFrame(
            id: 1, method: "session.send", params: .object(["sessionId": .string("s1"), "text": .string("hi")]), commandId: "c1"
        ))
        let sentLine1 = try await waitForSent(daemonTransport, count: 2)[1]
        let decoded1 = decodeLine(sentLine1)
        XCTAssertEqual(decoded1["commandId"] as? String, "c1")
        let daemonId1 = decoded1["id"] as! Int
        daemonTransport.feed(#"{"jsonrpc":"2.0","id":\#(daemonId1),"result":{"seq":1}}"#)
        _ = try await waitForOutbound(conn, count: 2) // rpcResponse for id 1

        // Same commandId, second frame — the GATEWAY must forward it too (dedup is the daemon's job).
        conn.enqueueInbound(try rpcRequestFrame(
            id: 2, method: "session.send", params: .object(["sessionId": .string("s1"), "text": .string("hi")]), commandId: "c1"
        ))
        let sentLine2 = try await waitForSent(daemonTransport, count: 3)[2]
        let decoded2 = decodeLine(sentLine2)
        XCTAssertEqual(decoded2["commandId"] as? String, "c1")
        let daemonId2 = decoded2["id"] as! Int
        XCTAssertNotEqual(daemonId1, daemonId2, "each forward gets its own daemon-side request id even though commandId repeats")
        daemonTransport.feed(#"{"jsonrpc":"2.0","id":\#(daemonId2),"result":{"seq":1}}"#) // daemon's own cache answers identically
        let outbound = try await waitForOutbound(conn, count: 3)
        let resp2 = try decodeEnvelope(outbound[2])
        XCTAssertEqual(resp2.kind, .rpcResponse)
    }

    // MARK: - Scenario E: fault injection — disconnect mid-stream, reconnect replays exactly the gap

    func testScenarioE_FaultInjectionReconnectReplaysExactlyTheGap() async throws {
        let daemonTransport = ScriptedTransport()
        let listener = LoopbackListener()
        let gateway = makeGateway(daemonTransport: daemonTransport, listener: listener)
        let runTask = Task { await gateway.run() }
        defer { runTask.cancel() }

        let conn1 = ScriptedRemoteConn()
        conn1.disconnectAfter(2) // helloAck (#1) + one live event (#2) — then the link dies
        listener.simulateConnection(conn1)
        conn1.enqueueInbound(try helloFrame(
            clientInstanceID: "phone-e",
            resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)]
        ))

        try await feedDaemonHelloResponse(daemonTransport)
        let attachLine1 = try await waitForSent(daemonTransport, count: 2)[1]
        let attachId1 = decodeLine(attachLine1)["id"] as! Int
        // Nothing to replay yet — fresh session, immediately up to date.
        daemonTransport.feed(#"{"jsonrpc":"2.0","id":\#(attachId1),"result":{"ok":true,"lastSeq":0}}"#)
        _ = try await waitForOutbound(conn1, count: 1) // helloAck (upToDate)

        // Now a LIVE event streams in — forwarded to the phone, and this is the 2nd outbound send
        // that trips `disconnectAfter(2)`.
        daemonTransport.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"user_message","seq":1,"sessionId":"s1","ts":0,"threadId":"main","text":"m1","clientName":"harness"}}"#)
        _ = try await waitForOutbound(conn1, count: 2)
        try await waitForClosed(conn1)
        XCTAssertEqual(conn1.outbound.count, 2, "the link died right after frame 2 — nothing more delivered to conn1")

        // Phone reconnects with its last-applied cursor (it received seq 1).
        let conn2 = ScriptedRemoteConn()
        listener.simulateConnection(conn2)
        conn2.enqueueInbound(try helloFrame(
            clientInstanceID: "phone-e", // SAME phone — the gateway must reuse the persistent daemon client
            resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 1)]
        ))

        let attachLine2 = try await waitForSent(daemonTransport, count: 3)[2]
        XCTAssertEqual(decodeLine(attachLine2)["method"] as? String, "session.attach")
        let attachId2 = decodeLine(attachLine2)["id"] as! Int
        daemonTransport.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"user_message","seq":2,"sessionId":"s1","ts":0,"threadId":"main","text":"m2","clientName":"harness"}}"#)
        daemonTransport.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"user_message","seq":3,"sessionId":"s1","ts":0,"threadId":"main","text":"m3","clientName":"harness"}}"#)
        daemonTransport.feed(#"{"jsonrpc":"2.0","id":\#(attachId2),"result":{"ok":true,"lastSeq":3}}"#)

        // SP2a G3: helloAck first, then the replayed gap (seq 2, 3).
        let outbound2 = try await waitForOutbound(conn2, count: 3)
        let ack2 = try decodeEnvelope(outbound2[0])
        XCTAssertEqual(ack2.kind, .helloAck)
        let gap1 = try decodeEnvelope(outbound2[1])
        let gap2 = try decodeEnvelope(outbound2[2])
        XCTAssertEqual(gap1.kind, .event)
        XCTAssertEqual(gap1.seq, 2)
        XCTAssertEqual(gap2.seq, 3)
        let serverHello2 = try JSONDecoder().decode(ServerHello.self, from: ack2.payload)
        XCTAssertEqual(serverHello2.verdicts, [.replayBegin(sessionID: "s1", fromSeq: 1, highWatermark: 3)])
        // No duplicate of seq 1 anywhere in conn2's outbound.
        XCTAssertFalse(outbound2.contains { (try? decodeEnvelope($0))?.seq == 1 })
    }
}
