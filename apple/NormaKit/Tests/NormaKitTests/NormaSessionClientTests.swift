import XCTest
import os
import NormaProtocol
import NormaSessionKit

/// SP3 Task 4: the phone-side resume / idempotency / approval state machine. Driven entirely by
/// `ScriptedRemoteConn` (loss/dup/gap/reorder injectors) + `InMemoryCursorStore` + injected
/// clock/idgen — no real iroh, no real daemon (that is T5's real-daemon conformance).
final class NormaSessionClientTests: XCTestCase {

    // MARK: - Frame helpers (server → phone direction)

    private let epoch = 7

    private func serverFrame(
        kind: WireKind, sessionID: String? = nil, streamID: String? = nil, seq: Int? = nil, payload: Data
    ) -> Data {
        let e = WireEnvelope(
            v: 1, pairingEpoch: epoch, hostID: "mac-host", sessionID: sessionID,
            streamID: streamID, seq: seq, kind: kind, timestamp: 0, payload: payload
        )
        return try! WireFrame.encode(e)
    }

    private func helloAckFrame(verdicts: [ResumeVerdict]) -> Data {
        let sh = ServerHello(chosenVersion: 1, hostID: "mac-host", verdicts: verdicts)
        return serverFrame(kind: .helloAck, payload: try! JSONEncoder().encode(sh))
    }

    private func eventFrame(session: String, stream: String? = nil, seq: Int) -> Data {
        let payload = try! JSONEncoder().encode(SessionEvent.JSONValue.object([
            "sessionId": .string(session), "seq": .number(Double(seq)), "type": .string("assistant_delta"),
        ]))
        return serverFrame(kind: .event, sessionID: session, streamID: stream ?? session, seq: seq, payload: payload)
    }

    private func rpcResponseFrame(id: Int, result: SessionEvent.JSONValue) -> Data {
        let body = SessionEvent.JSONValue.object([
            "jsonrpc": .string("2.0"), "id": .number(Double(id)), "result": result,
        ])
        return serverFrame(kind: .rpcResponse, payload: try! JSONEncoder().encode(body))
    }

    // MARK: - Outbound inspection (phone → server direction)

    private func decodeOutbound(_ data: Data) -> WireEnvelope { try! WireFrame.decode(data, expectedEpoch: epoch) }
    private func outboundPayload(_ env: WireEnvelope) -> SessionEvent.JSONValue {
        try! JSONDecoder().decode(SessionEvent.JSONValue.self, from: env.payload)
    }

    private func waitOutbound(_ conn: ScriptedRemoteConn, count: Int, timeout: TimeInterval = 2) async throws -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if conn.outbound.count >= count { return conn.outbound }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("timed out waiting for \(count) outbound frames; got \(conn.outbound.count)")
        return conn.outbound
    }

    // MARK: - Stream collectors (event / gap AsyncStreams)

    /// Lock-guarded drain of an `AsyncStream` — the same polling posture `GatewayTests` uses for
    /// async delivery. Tests assert on `.items` after a `waitUntil` barrier, never on a sleep.
    private final class Sink<T: Sendable>: @unchecked Sendable {
        private let lock = OSAllocatedUnfairLock(initialState: [T]())
        var items: [T] { lock.withLock { $0 } }
        func append(_ v: T) { lock.withLock { $0.append(v) } }
    }

    private func drain<T: Sendable>(_ stream: AsyncStream<T>) -> (Sink<T>, Task<Void, Never>) {
        let sink = Sink<T>()
        let task = Task { for await v in stream { sink.append(v) } }
        return (sink, task)
    }

    private func waitUntil(_ predicate: @escaping () -> Bool, timeout: TimeInterval = 2, _ msg: String) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("timed out: \(msg)")
    }

    private func makeClient(
        conn: ScriptedRemoteConn, cursors: CursorStore, firstFrameDeadline: Double = 1,
        idgen: @escaping @Sendable () -> String = { UUID().uuidString },
        liveBufferCap: Int = 10_000
    ) -> NormaSessionClient {
        NormaSessionClient(
            conn: conn, hostID: "mac-host", epoch: epoch, cursors: cursors,
            clientInstanceID: "phone-under-test", clock: { 0 }, idgen: idgen,
            firstFrameDeadline: firstFrameDeadline, liveBufferCap: liveBufferCap
        )
    }

    /// T4-review minor 1's double: reads delegate to a real in-memory store, every `advance`
    /// throws — a stand-in for a persistently failing `FileCursorStore` (disk full / bad perms).
    private struct ThrowingAdvanceCursorStore: CursorStore {
        struct Boom: Error {}
        let inner = InMemoryCursorStore()
        func cursor(host: String, session: String, stream: String) -> Int? {
            inner.cursor(host: host, session: session, stream: stream)
        }
        func advance(host: String, session: String, stream: String, to seq: Int) throws {
            throw Boom()
        }
    }

    private func seqs(_ envs: [SessionEnvelope]) -> [Int] { envs.compactMap { $0.seq } }

    // MARK: - Step 1: CursorStore

    func testInMemoryCursorRoundTrip() throws {
        let store = InMemoryCursorStore()
        XCTAssertNil(store.cursor(host: "h", session: "s", stream: "t"))
        try store.advance(host: "h", session: "s", stream: "t", to: 5)
        XCTAssertEqual(store.cursor(host: "h", session: "s", stream: "t"), 5)
        // Distinct keys don't bleed.
        XCTAssertNil(store.cursor(host: "h", session: "s", stream: "OTHER"))
    }

    func testFileCursorPersistsAndReloadsFresh() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-cursors-\(UUID().uuidString)")
            .appendingPathComponent("cursors.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

        let store = try FileCursorStore(url: url)
        try store.advance(host: "h", session: "s1", stream: "s1", to: 3)
        try store.advance(host: "h", session: "s2", stream: "s2", to: 9)
        XCTAssertEqual(store.cursor(host: "h", session: "s1", stream: "s1"), 3)

        // A FRESH instance reloads the persisted table from disk.
        let reloaded = try FileCursorStore(url: url)
        XCTAssertEqual(reloaded.cursor(host: "h", session: "s1", stream: "s1"), 3)
        XCTAssertEqual(reloaded.cursor(host: "h", session: "s2", stream: "s2"), 9)
    }

    func testFileCursorIsAtomic0600() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-cursors-\(UUID().uuidString)")
            .appendingPathComponent("cursors.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

        let store = try FileCursorStore(url: url)
        try store.advance(host: "h", session: "s", stream: "s", to: 1)

        let perms = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(perms?.int16Value, 0o600)
        // No leftover temp file beside it (rename consumed it).
        let siblings = try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path)
        XCTAssertEqual(siblings.filter { $0.hasSuffix(".tmp") }, [])
    }

    // MARK: - Step 2/3: handshake + first-frame deadline

    func testHandshakeSendsClientHelloAndReturnsServerHello() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: [.upToDate(sessionID: "s1", highWatermark: 4)]))

        let resumes = [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 4)]
        let hello = try await client.handshake(resumes: resumes)

        XCTAssertEqual(hello.chosenVersion, 1)
        XCTAssertEqual(hello.verdicts, [.upToDate(sessionID: "s1", highWatermark: 4)])

        // The outgoing frame is a `.hello` carrying the ClientHello with our epoch + resumes.
        let out = try await waitOutbound(conn, count: 1)
        let env = decodeOutbound(out[0])
        XCTAssertEqual(env.kind, .hello)
        XCTAssertEqual(env.pairingEpoch, epoch)
        let ch = try JSONDecoder().decode(ClientHello.self, from: env.payload)
        XCTAssertEqual(ch.pairingEpoch, epoch)
        XCTAssertEqual(ch.resumes, resumes)
    }

    func testHandshakeTimesOutOnSilentConn() async throws {
        let conn = ScriptedRemoteConn() // never sends helloAck
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore(), firstFrameDeadline: 0.2)

        let start = Date()
        do {
            _ = try await client.handshake(resumes: [])
            XCTFail("handshake should have timed out")
        } catch {
            XCTAssertEqual(error as? SessionClientError, .handshakeTimeout)
        }
        // Threw promptly (bounded by the deadline), did NOT hang.
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.5)
    }

    // MARK: - Step 4/5: events dedup / gap / handoff / cursor-after-apply

    func testExactDuplicateIsIgnored() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors)
        let (events, drainTask) = drain(client.events)
        defer { drainTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.upToDate(sessionID: "s1", highWatermark: 0)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 1))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 1)) // exact duplicate
        conn.enqueueInbound(eventFrame(session: "s1", seq: 2))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 3)) // barrier: last frame in FIFO order

        try await waitUntil({ self.seqs(events.items).contains(3) }, "seq 3 to arrive")
        XCTAssertEqual(seqs(events.items), [1, 2, 3], "duplicate seq 1 must not be re-yielded")
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 3)
    }

    /// T5 conformance fix: the gateway filters `harness_attached`/`harness_detached` bookkeeping
    /// from the wire but those events still CONSUME daemon seqs — so received content legitimately
    /// has holes (every attach mints one). On the reliable, ordered QUIC bi-stream a missing seq
    /// between two received events is ALWAYS a gateway-filtered event, never mid-stream loss (real
    /// staleness is handled at the handshake via `.snapshotRequired`) — SP2a G1's own contract:
    /// "cursors stay exclusive-> over what the phone actually received (filtered seq gaps are
    /// fine)." A forward jump must therefore APPLY and advance, never surface a GapSignal — the
    /// earlier strict `cursor + 1` rule made the basic attach-then-see-messages flow a PERMANENT
    /// false gap (snapshot resume → re-attach → fresh harness_attached → new hole → repeat).
    func testForwardJumpFromFilteredSeqIsAppliedNotGapped() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors)
        let (events, evTask) = drain(client.events)
        let (gaps, gapTask) = drain(client.gaps)
        defer { evTask.cancel(); gapTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.upToDate(sessionID: "s1", highWatermark: 0)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 1))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 3)) // seq 2 was a filtered harness event
        conn.enqueueInbound(eventFrame(session: "s1", seq: 6)) // seqs 4-5 filtered too — still benign

        try await waitUntil({ self.seqs(events.items).contains(6) }, "forward-jumped events to apply")

        // Both jumped events applied in order; the cursor tracks the last RECEIVED seq; no gap.
        XCTAssertEqual(seqs(events.items), [1, 3, 6])
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 6)
        XCTAssertTrue(gaps.items.isEmpty, "a benign forward jump must never surface a GapSignal")
    }

    func testLiveDuringReplayIsDeliveredAfterReplayBatchInOrder() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors)
        let (events, evTask) = drain(client.events)
        let (gaps, gapTask) = drain(client.gaps)
        defer { evTask.cancel(); gapTask.cancel() }

        // Replay window is seq 1..3; a live event (seq 4, > highWatermark) is injected MID-replay.
        conn.enqueueInbound(helloAckFrame(verdicts: [.replayBegin(sessionID: "s1", fromSeq: 0, highWatermark: 3)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 1))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 2))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 4)) // LIVE, arrives before replay finishes
        conn.enqueueInbound(eventFrame(session: "s1", seq: 3)) // last replay event → completes the batch

        try await waitUntil({ self.seqs(events.items).contains(4) }, "live seq 4 to drain after replay")
        // Held live event is delivered AFTER the whole replay batch, in order — no drop, no reorder.
        XCTAssertEqual(seqs(events.items), [1, 2, 3, 4])
        // A naive impl would gap on seq 4 (4 > cursor+1 while cursor==2); the correct impl never does.
        XCTAssertTrue(gaps.items.isEmpty, "no gap: seq 4 is a held live event, not a replay hole")
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 4)
    }

    // MARK: - T4 review hardening (2 minors on the resume path)

    func testCursorPersistFailureIsSurfacedAfterYieldNotSwallowed() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: ThrowingAdvanceCursorStore())
        let (events, evTask) = drain(client.events)
        let (failures, pfTask) = drain(client.persistErrors)
        defer { evTask.cancel(); pfTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.upToDate(sessionID: "s1", highWatermark: 0)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 1))

        try await waitUntil({ !failures.items.isEmpty }, "persist failure to surface")
        // The event was still yielded (persist failure never suppresses delivery)...
        XCTAssertEqual(seqs(events.items), [1])
        // ...and the failure carries the stream identity + the failed seq (message is diagnostic).
        let f = failures.items[0]
        XCTAssertEqual(f.sessionID, "s1")
        XCTAssertEqual(f.streamID, "s1")
        XCTAssertEqual(f.seq, 1)
        XCTAssertFalse(f.message.isEmpty)
    }

    func testReplayBeginWithCursorAlreadyAtWatermarkDoesNotStallLiveEvents() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        // The client already durably applied up to the announced watermark (e.g. the host's verdict
        // raced a concurrent cursor advance) — no replay event will EVER arrive to complete the batch.
        try cursors.advance(host: "mac-host", session: "s1", stream: "s1", to: 3)
        let client = makeClient(conn: conn, cursors: cursors)
        let (events, evTask) = drain(client.events)
        let (gaps, gapTask) = drain(client.gaps)
        defer { evTask.cancel(); gapTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.replayBegin(sessionID: "s1", fromSeq: 0, highWatermark: 3)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 3)])

        // A naive impl enters `replaying` and buffers this forever (silent stall).
        conn.enqueueInbound(eventFrame(session: "s1", seq: 4))

        try await waitUntil({ self.seqs(events.items).contains(4) }, "live seq 4 to deliver without a replay batch")
        XCTAssertEqual(seqs(events.items), [4])
        XCTAssertTrue(gaps.items.isEmpty)
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 4)
    }

    func testLiveBufferOverflowSurfacesGapInsteadOfGrowingUnbounded() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors, liveBufferCap: 3)
        let (events, evTask) = drain(client.events)
        let (gaps, gapTask) = drain(client.gaps)
        defer { evTask.cancel(); gapTask.cancel() }

        // Replay window 1..2; seq 2 (the exact-watermark event) never arrives → replay never completes.
        conn.enqueueInbound(helloAckFrame(verdicts: [.replayBegin(sessionID: "s1", fromSeq: 0, highWatermark: 2)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 1)) // replay; cursor 1, still replaying
        for seq in [3, 4, 5] { conn.enqueueInbound(eventFrame(session: "s1", seq: seq)) } // fill the cap
        conn.enqueueInbound(eventFrame(session: "s1", seq: 6)) // overflow → gap

        try await waitUntil({ !gaps.items.isEmpty }, "overflow gap to surface")
        XCTAssertEqual(gaps.items, [GapSignal(sessionID: "s1", streamID: "s1", expectedSeq: 2, receivedSeq: 6)])
        // Only the applied replay event was ever yielded; nothing buffered leaked out of order.
        XCTAssertEqual(seqs(events.items), [1])
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 1)
    }

    // MARK: - Step 6: idempotency (commandId) + approval state machine

    func testSendCarriesStableCommandIdAcrossRetries() async throws {
        let conn = ScriptedRemoteConn()
        // Fixed idgen: a retried call reuses the SAME commandId (the daemon dedups on it).
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore(), idgen: { "cmd-fixed" })
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let t1 = Task { try await client.send(method: "session.send", params: .object(["text": .string("hi")])) }
        let afterReq1 = try await waitOutbound(conn, count: 2) // [hello, req1]
        let req1 = decodeOutbound(afterReq1[1])
        XCTAssertEqual(req1.kind, .rpcRequest)
        XCTAssertEqual(outboundPayload(req1)["method"]?.stringValue, "session.send")
        let id1 = outboundPayload(req1)["id"]!.intValue!
        conn.enqueueInbound(rpcResponseFrame(id: id1, result: .object(["ok": .bool(true)])))
        _ = try await t1.value

        let t2 = Task { try await client.send(method: "session.send", params: .object(["text": .string("hi")])) }
        let afterReq2 = try await waitOutbound(conn, count: 3) // [hello, req1, req2]
        let req2 = decodeOutbound(afterReq2[2])
        let id2 = outboundPayload(req2)["id"]!.intValue!
        conn.enqueueInbound(rpcResponseFrame(id: id2, result: .object(["ok": .bool(true)])))
        _ = try await t2.value

        XCTAssertEqual(outboundPayload(req1)["commandId"]?.stringValue, "cmd-fixed")
        XCTAssertEqual(outboundPayload(req2)["commandId"]?.stringValue, "cmd-fixed")
        XCTAssertNotEqual(id1, id2, "distinct JSON-RPC ids so both can be in flight, but the same commandId")
    }

    /// SP3 T4b review fix (Important #2): a caller-provided `commandID` is used VERBATIM (idgen is
    /// never consulted) and stays identical across a simulated retry — T9's prompt resend depends
    /// on this for daemon-side dedup. The idgen here is a decoy: if `send` minted its own id, the
    /// frames would carry "cmd-idgen" and the assertions would catch it.
    func testSendUsesCallerProvidedCommandIdVerbatimAcrossRetries() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore(), idgen: { "cmd-idgen" })
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        // First attempt.
        let t1 = Task { try await client.send(method: "session.send", params: .object(["text": .string("hi")]), commandID: "cmd-caller") }
        let afterReq1 = try await waitOutbound(conn, count: 2) // [hello, req1]
        let req1 = decodeOutbound(afterReq1[1])
        let id1 = outboundPayload(req1)["id"]!.intValue!
        conn.enqueueInbound(rpcResponseFrame(id: id1, result: .object(["ok": .bool(true)])))
        _ = try await t1.value

        // Simulated retry of the SAME logical command: same caller-owned commandID.
        let t2 = Task { try await client.send(method: "session.send", params: .object(["text": .string("hi")]), commandID: "cmd-caller") }
        let afterReq2 = try await waitOutbound(conn, count: 3) // [hello, req1, req2]
        let req2 = decodeOutbound(afterReq2[2])
        let id2 = outboundPayload(req2)["id"]!.intValue!
        conn.enqueueInbound(rpcResponseFrame(id: id2, result: .object(["ok": .bool(true)])))
        _ = try await t2.value

        XCTAssertEqual(outboundPayload(req1)["commandId"]?.stringValue, "cmd-caller", "caller id used verbatim, not idgen's")
        XCTAssertEqual(outboundPayload(req2)["commandId"]?.stringValue, "cmd-caller", "retry reuses the SAME caller id")
        XCTAssertNotEqual(id1, id2, "fresh JSON-RPC id per attempt; only the commandId is stable")
    }

    func testAnswerApprovalHostAccepted() async throws {
        try await assertApproval(
            result: .object(["ok": .bool(true), "alreadyResolved": .bool(false)]),
            expected: .hostAccepted
        )
    }

    func testAnswerApprovalResolvedElsewhere() async throws {
        try await assertApproval(
            result: .object(["ok": .bool(true), "alreadyResolved": .bool(true)]),
            expected: .resolvedElsewhere
        )
    }

    /// `.expired` is phone-DERIVED (SP3 T4b): an answer whose `expiresAt` is already in the past on
    /// the client clock short-circuits to `.expired` WITHOUT ever sending `approval.respond` (the
    /// host has already failed it closed with `by:"timeout"`). Assert both the state AND that no
    /// approval.respond frame reached the wire.
    func testAnswerApprovalExpiredIsDerivedWithoutSending() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let pastDeadline = Int(Date().timeIntervalSince1970 * 1000) - 60_000
        let answer = ApprovalAnswer(sessionID: "s", callID: "c1", approved: true, commandID: "cmd-appr", expiresAt: pastDeadline)
        let state = try await client.answerApproval(answer)
        XCTAssertEqual(state, .expired)

        // Only the hello frame ever went out — no approval.respond was sent.
        let out = try await waitOutbound(conn, count: 1)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(decodeOutbound(out[0]).kind, .hello)
    }

    /// Drives one approval round-trip and asserts BOTH the mapped state AND that `answerApproval`
    /// never returns before the host acks (the result box stays empty until the reply is enqueued).
    /// The answer's `expiresAt` is nil (not locally expired), so it actually sends and blocks.
    private func assertApproval(result: SessionEvent.JSONValue, expected: ApprovalState) async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let answer = ApprovalAnswer(sessionID: "s", callID: "appr-1", approved: true, commandID: "cmd-appr", expiresAt: nil)
        let box = Sink<ApprovalState>()
        let task = Task { box.append(try await client.answerApproval(answer)) }

        let out = try await waitOutbound(conn, count: 2) // [hello, approval.respond]
        let req = decodeOutbound(out[1])
        let payload = outboundPayload(req)
        XCTAssertEqual(payload["method"]?.stringValue, "approval.respond")
        XCTAssertEqual(payload["commandId"]?.stringValue, "cmd-appr")
        XCTAssertEqual(payload["params"]?["sessionId"]?.stringValue, "s")
        XCTAssertEqual(payload["params"]?["callId"]?.stringValue, "appr-1")
        XCTAssertEqual(payload["params"]?["approved"]?.boolValue, true)

        // Never returns before the host acks: no state yet.
        XCTAssertTrue(box.items.isEmpty, "answerApproval must not return before the host reply")

        let id = payload["id"]!.intValue!
        conn.enqueueInbound(rpcResponseFrame(id: id, result: result))
        _ = try await task.value
        XCTAssertEqual(box.items, [expected])
    }

    func testPendingApprovalsQueriesLiveState() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let task = Task { try await client.pendingApprovals(sessionID: "s") }
        let out = try await waitOutbound(conn, count: 2)
        let req = decodeOutbound(out[1])
        XCTAssertEqual(outboundPayload(req)["method"]?.stringValue, NormaSessionClient.approvalListMethod)
        // The sessionId scopes the query.
        XCTAssertEqual(outboundPayload(req)["params"]?["sessionId"]?.stringValue, "s")
        let id = outboundPayload(req)["id"]!.intValue!

        // Real approval.list shape: { pending: [{ callId, toolName, summary, issuedAt, expiresAt }] }.
        let pending = SessionEvent.JSONValue.array([
            .object(["callId": .string("c1"), "toolName": .string("write"), "summary": .string("write a.txt"),
                     "issuedAt": .number(1000), "expiresAt": .number(6000)]),
            .object(["callId": .string("c2"), "toolName": .string("bash"), "summary": .string("run ls"),
                     "issuedAt": .number(2000), "expiresAt": .number(7000)]),
        ])
        conn.enqueueInbound(rpcResponseFrame(id: id, result: .object(["pending": pending])))
        let got = try await task.value
        XCTAssertEqual(got.count, 2)
        XCTAssertEqual(got.first?["callId"]?.stringValue, "c1")
        // expiresAt decodes so a caller can render "expires in Ns".
        XCTAssertEqual(got.first?["expiresAt"]?.intValue, 6000)
    }
}
