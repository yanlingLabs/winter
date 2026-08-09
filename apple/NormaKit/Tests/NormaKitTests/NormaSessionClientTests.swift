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

    /// A handshake-rejection `.error` frame (SP3.1 T1). `frameEpoch` defaults to the client's own
    /// epoch (the same-epoch refusals: not_paired/revoked/protocol/daemon_unavailable); pass a
    /// DIFFERENT value to model the `stale_epoch` case, where the frame is stamped with the Mac's
    /// (newer) epoch and the client's strict decode would reject it — the client must still surface
    /// the typed rejection by decoding this ONE frame epoch-lenient.
    private func rejectionFrame(code: String, message: String = "why", frameEpoch: Int? = nil) -> Data {
        let e = WireEnvelope(
            v: 1, pairingEpoch: frameEpoch ?? epoch, hostID: "mac-host", sessionID: nil,
            streamID: nil, seq: nil, kind: .error, timestamp: 0,
            payload: try! JSONEncoder().encode(HandshakeRejection(code: code, message: message))
        )
        return try! WireFrame.encode(e)
    }

    /// `type` is the event's wire discriminator and it is NOT decoration: the client exempts the
    /// nine TRANSIENT types from seq dedupe/cursor advance, so a frame's type decides which half of
    /// `applyEvent` it exercises. Anything testing dedupe/gap/replay must therefore use a PERSISTED
    /// type (the `assistant_message` default); the transient tests pass their own.
    private func eventFrame(
        session: String, stream: String? = nil, seq: Int,
        type: String = "assistant_message", extra: [String: SessionEvent.JSONValue] = [:]
    ) -> Data {
        var body: [String: SessionEvent.JSONValue] = [
            "sessionId": .string(session), "seq": .number(Double(seq)), "type": .string(type),
        ]
        for (k, v) in extra { body[k] = v }
        let payload = try! JSONEncoder().encode(SessionEvent.JSONValue.object(body))
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

    // MARK: - KA-T3: heartbeat test infra

    /// Thread-safe mutable "now" the test advances explicitly — the same seam
    /// `PairingManagerTests.TestClock` uses (a per-file copy: this codebase's convention for a
    /// tiny test-only double rather than a shared one). Every OTHER test in this file passes the
    /// frozen `clock: { 0 }` above, which never crosses any `HeartbeatConfig` threshold — that's
    /// what keeps every pre-existing construction site's outbound-frame-count assertions
    /// unaffected by the new watchdog defaulting to `.production`.
    private final class TestClock: @unchecked Sendable {
        private let box = OSAllocatedUnfairLock<Int>(initialState: 0)
        var now: Int {
            get { box.withLock { $0 } }
            set { box.withLock { $0 = newValue } }
        }
    }

    private func makeHeartbeatClient(
        conn: ScriptedRemoteConn, cursors: CursorStore = InMemoryCursorStore(),
        clock: TestClock, heartbeat: HeartbeatConfig,
        isActive: @escaping @Sendable () -> Bool = { true }
    ) -> NormaSessionClient {
        NormaSessionClient(
            conn: conn, hostID: "mac-host", epoch: epoch, cursors: cursors,
            clientInstanceID: "phone-under-test", clock: { clock.now }, idgen: { UUID().uuidString },
            firstFrameDeadline: 2, heartbeat: heartbeat, isActive: isActive
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
    private func types(_ envs: [SessionEnvelope]) -> [String] { envs.map { $0.json["type"]?.stringValue ?? "<untyped>" } }
    private func deltas(_ envs: [SessionEnvelope]) -> [String] { envs.compactMap { $0.json["delta"]?.stringValue } }

    /// The nine broadcast-only TRANSIENT event types — the list this suite drives the phone client
    /// with. An INDEPENDENT literal, deliberately not read from `SessionEvent.transientTypes`: the
    /// remote-allowlist parity pattern, where each copy pins itself to the same literal names so
    /// editing one alone fails a test (`testTransientListMatchesTheProtocolConstant` just below)
    /// instead of silently diverging.
    ///
    /// Growth log: 7 → 8 (session-activity-hygiene T4, `session_activity`); 8 → 9 (panel-shell T3,
    /// `panel_command`).
    private static let transientTypes = [
        "assistant_delta", "lease_granted", "lease_lost", "peripheral_call_requested",
        "plugin_tool_invoke", "hardware_requested", "plugin_tile_updated", "session_activity",
        "panel_command",
    ]

    /// Parity: this suite's literal nine ARE the protocol's canonical nine. Without this, a type
    /// added to `SessionEvent.transientTypes` (and therefore honoured by the shipped client) would
    /// silently go untested here, and a type dropped from it would leave these tests passing
    /// against a list the client no longer uses.
    func testTransientListMatchesTheProtocolConstant() {
        XCTAssertEqual(Set(Self.transientTypes), SessionEvent.transientTypes)
    }

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

    /// SP3.1 T1: a same-epoch handshake-rejection `.error` frame (the not_paired/revoked/protocol/
    /// daemon_unavailable refusals, stamped with the current record's epoch == the client's) makes
    /// `handshake` throw a typed `.handshakeRejected(code:)` — NOT a bare `connectionClosed` (which
    /// the app collapses to `.macUnavailable`) and NOT a timeout. This is the reachability the whole
    /// task exists to restore.
    func testHandshakeThrowsTypedRejectionOnErrorFrame() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore(), firstFrameDeadline: 1)
        conn.enqueueInbound(rejectionFrame(code: "revoked", message: "pairing revoked"))

        do {
            _ = try await client.handshake(resumes: [])
            XCTFail("handshake should have thrown a typed rejection")
        } catch {
            XCTAssertEqual(error as? SessionClientError, .handshakeRejected(code: "revoked", message: "pairing revoked"))
        }
    }

    /// SP3.1 T1: the `stale_epoch` case specifically — the rejection frame is stamped with the Mac's
    /// (newer) epoch, DIFFERENT from the client's, so a strict `WireFrame.decode(expectedEpoch:)`
    /// would throw `.staleEpoch` and drop the frame (→ timeout). The client must decode THIS one
    /// error-kind handshake frame epoch-lenient and still surface `.handshakeRejected("stale_epoch")`
    /// — never a `.staleEpoch`, never a timeout.
    func testHandshakeThrowsTypedRejectionOnStaleEpochErrorFrameDecodedLeniently() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore(), firstFrameDeadline: 1)
        // Frame epoch 999 ≠ the client's epoch (7): strict decode would reject it.
        conn.enqueueInbound(rejectionFrame(code: "stale_epoch", message: "stale pairing epoch", frameEpoch: 999))

        let start = Date()
        do {
            _ = try await client.handshake(resumes: [])
            XCTFail("handshake should have thrown a typed rejection, not decoded-dropped the stale frame")
        } catch {
            XCTAssertEqual(error as? SessionClientError, .handshakeRejected(code: "stale_epoch", message: "stale pairing epoch"))
        }
        // Surfaced promptly via the lenient decode — did NOT sit until the first-frame deadline.
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.9)
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

    // MARK: - Transient events: exempt from BOTH the seq dedupe and the cursor advance

    /// **The bug this pins.** `hub.ts`'s `broadcastTransient` stamps a transient with the store's
    /// CURRENT `lastSeq` — the seq of the last event it actually APPENDED, never a seq of its own
    /// (`packages/protocol/src/events.ts` writes the contract out: clients "MUST exempt
    /// assistant_delta from seq-based dedupe and lastSeq updates"). So on a caught-up client every
    /// delta of a turn arrives at `seq == cursor`, and the plain `seq <= cursor` drop killed 100% of
    /// them — no streaming at all on a remote session, the whole reply landing at once at
    /// turn end.
    ///
    /// Note the shape: FOUR deltas ALL carrying seq 5 (the seq of the `turn_started` that preceded
    /// them). Every pre-existing event test in this file feeds STRICTLY INCREASING seqs — a shape
    /// the daemon never produces for a transient — which is exactly why the suite was green while
    /// streaming was totally broken.
    func testAssistantDeltaBurstAtCursorSeqIsDeliveredNotDeduped() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors)
        let (events, evTask) = drain(client.events)
        defer { evTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.upToDate(sessionID: "s1", highWatermark: 0)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        // The persisted event that opens the turn: the cursor lands on ITS seq.
        conn.enqueueInbound(eventFrame(session: "s1", seq: 5, type: "turn_started"))
        // ...and every delta of that turn is then stamped with the same 5.
        for i in 1...4 {
            conn.enqueueInbound(eventFrame(session: "s1", seq: 5, type: "assistant_delta",
                                           extra: ["delta": .string("chunk-\(i)")]))
        }
        // Barrier: the persisted final message closes the turn at the next real seq.
        conn.enqueueInbound(eventFrame(session: "s1", seq: 6, type: "assistant_message"))

        try await waitUntil({ self.types(events.items).last == "assistant_message" }, "the turn's final message")
        XCTAssertEqual(deltas(events.items), ["chunk-1", "chunk-2", "chunk-3", "chunk-4"],
                       "every streamed delta must reach the consumer — pre-fix all four died on `seq <= cursor`")
        XCTAssertEqual(types(events.items), ["turn_started"] + Array(repeating: "assistant_delta", count: 4) + ["assistant_message"],
                       "deltas are delivered in order, between the two persisted events")
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 6,
                       "only the two PERSISTED events moved the cursor")
    }

    /// The same drop killed all NINE transient types, not just streaming: the peripheral-lease v1
    /// events, `plugin_tool_invoke`, `hardware_requested` and `plugin_tile_updated` are broadcast
    /// with the same borrowed seq. Pins the phone's exemption list against the Mac client's
    /// (`NormaClient.swift`) — membership drift in either direction fails here.
    func testEveryTransientTypeAtCursorSeqIsExempt() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors)
        let (events, evTask) = drain(client.events)
        defer { evTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.upToDate(sessionID: "s1", highWatermark: 0)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 5, type: "turn_started")) // cursor → 5
        for t in Self.transientTypes { conn.enqueueInbound(eventFrame(session: "s1", seq: 5, type: t)) }
        conn.enqueueInbound(eventFrame(session: "s1", seq: 6, type: "assistant_message")) // barrier

        try await waitUntil({ self.types(events.items).last == "assistant_message" }, "the barrier event")
        XCTAssertEqual(types(events.items), ["turn_started"] + Self.transientTypes + ["assistant_message"],
                       "every transient type must pass the dedupe gate at seq == cursor")
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 6,
                       "no transient moved the cursor")
    }

    /// **The other half, and why exempting only the dedupe would be a WORSE bug.** A transient's
    /// borrowed seq belongs to a REAL event — one this client may not have applied yet (here: seqs
    /// 4 and 5 of a replay batch still in flight). If the transient advanced the cursor to its
    /// borrowed seq, those two genuine, persisted events would be swallowed as duplicates the
    /// moment they arrived: streaming restored, transcript silently truncated.
    ///
    /// Pre-fix this test fails in exactly that shape — the delta (seq 5 > cursor 3) IS yielded and
    /// DOES drag the cursor to 5, and replay seqs 4 and 5 then vanish.
    func testTransientDoesNotAdvanceCursorSoLaterRealEventsAtThatSeqStillArrive() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors)
        let (events, evTask) = drain(client.events)
        let (gaps, gapTask) = drain(client.gaps)
        defer { evTask.cancel(); gapTask.cancel() }

        // Replay window 1..5 — the batch is mid-flight while the live turn streams.
        conn.enqueueInbound(helloAckFrame(verdicts: [.replayBegin(sessionID: "s1", fromSeq: 0, highWatermark: 5)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        for seq in 1...3 { conn.enqueueInbound(eventFrame(session: "s1", seq: seq, type: "assistant_message")) }
        // A live delta borrowing seq 5 lands while the cursor is still at 3.
        conn.enqueueInbound(eventFrame(session: "s1", seq: 5, type: "assistant_delta",
                                       extra: ["delta": .string("live")]))
        // The rest of the replay batch — these are the events a cursor-advancing transient eats.
        conn.enqueueInbound(eventFrame(session: "s1", seq: 4, type: "assistant_message"))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 5, type: "assistant_message"))

        try await waitUntil({ self.seqs(events.items).count >= 6 }, "the full replay batch plus the live delta")
        XCTAssertEqual(seqs(events.items), [1, 2, 3, 5, 4, 5],
                       "the delta rides through at seq 5 without consuming replay seqs 4 and 5")
        XCTAssertEqual(types(events.items),
                       ["assistant_message", "assistant_message", "assistant_message",
                        "assistant_delta", "assistant_message", "assistant_message"])
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 5,
                       "the cursor tracks persisted events only — the transient never moved it")
        XCTAssertTrue(gaps.items.isEmpty)
    }

    /// Control: the exemption is type-scoped, not a blanket hole. A REPLAYED persisted event at
    /// `seq <= cursor` is still dropped, and persisted events still advance the cursor — even when
    /// a transient at the very same seq passes between them.
    func testNonTransientReplayAtOrBelowCursorIsStillDroppedAndStillAdvances() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors)
        let (events, evTask) = drain(client.events)
        defer { evTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.upToDate(sessionID: "s1", highWatermark: 0)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 1, type: "user_message"))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 2, type: "assistant_message")) // cursor → 2
        conn.enqueueInbound(eventFrame(session: "s1", seq: 2, type: "assistant_message")) // replay dup: dropped
        conn.enqueueInbound(eventFrame(session: "s1", seq: 1, type: "user_message"))      // older dup: dropped
        // A transient at the SAME seq the duplicates were rejected at still gets through.
        conn.enqueueInbound(eventFrame(session: "s1", seq: 2, type: "assistant_delta",
                                       extra: ["delta": .string("live")]))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 3, type: "assistant_message")) // barrier

        try await waitUntil({ self.types(events.items).count >= 4 }, "the barrier event")
        XCTAssertEqual(types(events.items),
                       ["user_message", "assistant_message", "assistant_delta", "assistant_message"],
                       "persisted duplicates stay deduped; only the transient bypasses the gate")
        XCTAssertEqual(seqs(events.items), [1, 2, 2, 3])
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 3,
                       "persisted events still advance the cursor")
    }

    // MARK: - T7: the replay hold parks transients too — for ORDER — but never counts them

    /// **The ordering the phone's transcript depends on, pinned so it cannot be "optimised" away.**
    /// A transient cannot move the cursor, so cursor safety — the hold's stated reason — does not
    /// apply to one, and releasing it immediately looks like a strict improvement (the deltas of a
    /// turn in flight stop going silent while a replay batch drains). **It is a regression.** The
    /// phone folds this stream in ARRIVAL order (`norma-ios` `TranscriptBuilder`), and the
    /// order-safe fold that repairs out-of-order arrivals covers PERSISTED events only —
    /// `assistant_delta` is excluded from `mergedEnvelopes`/`maxFoldedSeq` by design. Release the
    /// delta early and its streaming row lands above the replay frames it outran; the canonical
    /// `assistant_message` then replaces that row in place, rendering the newest message above two
    /// older ones. Nor does it self-heal: `seedHistoryIfNeeded` returns early on exactly this path
    /// (`resumeWasReplay`).
    ///
    /// The shape is the one the daemon actually produces on the open-a-session-mid-turn path: the
    /// attach's replay ceiling is the `harness_attached` seq, and any delta broadcast afterwards
    /// borrows a LATER `lastSeq` — i.e. `seq > highWatermark` by construction, so it takes the hold.
    ///
    /// So: `[1, 2, 3, delta]`. Make the transient bypass the hold and this test reads `[1, delta,
    /// 2, 3]` — which is precisely the mis-ordered transcript.
    func testTransientDuringReplayIsHeldWithTheBatchSoTheTranscriptStaysInArrivalOrder() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors)
        let (events, evTask) = drain(client.events)
        let (gaps, gapTask) = drain(client.gaps)
        defer { evTask.cancel(); gapTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.replayBegin(sessionID: "s1", fromSeq: 0, highWatermark: 3)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 1))                       // replay
        conn.enqueueInbound(eventFrame(session: "s1", seq: 7, type: "assistant_delta",
                                       extra: ["delta": .string("live")]))           // live delta, seq > 3
        conn.enqueueInbound(eventFrame(session: "s1", seq: 2))                       // replay
        conn.enqueueInbound(eventFrame(session: "s1", seq: 3))                       // replay, completes batch

        try await waitUntil({ self.seqs(events.items).count >= 4 }, "the replay batch plus the held delta")
        XCTAssertEqual(types(events.items),
                       ["assistant_message", "assistant_message", "assistant_message", "assistant_delta"],
                       "the delta must be released AFTER the batch it outran — the transcript folds in arrival order")
        XCTAssertEqual(seqs(events.items), [1, 2, 3, 7])
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 3,
                       "released from the hold, the transient still must not touch the cursor")
        XCTAssertTrue(gaps.items.isEmpty)
    }

    /// **The genuinely dangerous half, and the one this task fixes.** The hold also counted
    /// transients against `liveBufferCap`, so a long enough stream of deltas during a replay batch
    /// tripped the overflow path — which does not merely drop the buffer, it marks the whole stream
    /// `gapped` and yields a `GapSignal`, killing every further event on it until a fresh handshake.
    /// That is a false alarm by construction: the cap bounds the events the hold exists FOR (the
    /// persisted ones, which is what a stalled replay accumulates), and a transient is not one of
    /// them. Deltas are still parked — see the ordering test above — they are simply not counted,
    /// and can no longer displace a persisted event's budget either.
    ///
    /// Pre-fix at `cap = 5`: the four deltas and the first persisted live event fill the shared
    /// count, so the SECOND persisted live event raises the gap, the stream dies, and it plus the
    /// two batch-completing replay frames are all dropped by the `gapped` guard — 1 event delivered
    /// in total. Post-fix: everything is delivered. The persisted-event half of the cap is unchanged
    /// and stays pinned by `testLiveBufferOverflowSurfacesGapInsteadOfGrowingUnbounded` above.
    func testTransientsDuringReplayNeverConsumeTheLiveBufferCapOrFalselyGap() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors, liveBufferCap: 5)
        let (events, evTask) = drain(client.events)
        let (gaps, gapTask) = drain(client.gaps)
        defer { evTask.cancel(); gapTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.replayBegin(sessionID: "s1", fromSeq: 0, highWatermark: 3)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 1)) // replay; cursor 1, still replaying
        // FOUR transients interleaved with TWO persisted live events, against a cap of five. Both
        // classes are individually under it; only a SHARED count overflows — which is the bug.
        for i in 1...2 {
            conn.enqueueInbound(eventFrame(session: "s1", seq: 9, type: "assistant_delta",
                                           extra: ["delta": .string("chunk-\(i)")]))
        }
        conn.enqueueInbound(eventFrame(session: "s1", seq: 5)) // live, held
        for i in 3...4 {
            conn.enqueueInbound(eventFrame(session: "s1", seq: 9, type: "assistant_delta",
                                           extra: ["delta": .string("chunk-\(i)")]))
        }
        conn.enqueueInbound(eventFrame(session: "s1", seq: 6)) // live, held — the 6th shared slot
        // ...and now the rest of the replay batch, which completes it and drains the hold.
        conn.enqueueInbound(eventFrame(session: "s1", seq: 2))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 3))

        try await waitUntil({ self.deltas(events.items).count >= 4 }, "all four deltas to drain with the hold")
        XCTAssertTrue(gaps.items.isEmpty,
                      "a burst of transients must never trip the live-buffer cap — that gap kills the stream")
        XCTAssertEqual(deltas(events.items), ["chunk-1", "chunk-2", "chunk-3", "chunk-4"],
                       "all four survive: none was dropped for a budget that was never theirs")
        // Replay batch first, then the hold drained in seq order — the two persisted live events
        // ahead of the deltas that borrowed the later seq 9.
        XCTAssertEqual(seqs(events.items), [1, 2, 3, 5, 6, 9, 9, 9, 9])
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 6,
                       "only the persisted events moved the cursor")
    }

    /// Not counting transients against the cap must not mean not bounding them at all — so they get
    /// their OWN budget of `liveBufferCap`, and past it a transient is DROPPED rather than allowed
    /// to grow the buffer or to raise the gap that would take the stream down. A dropped delta is
    /// cosmetic (the turn's canonical `assistant_message` carries the whole text); a gap is not.
    /// This is the branch that keeps the worst case at 2 × cap instead of unbounded.
    func testTransientsPastTheirOwnBudgetAreDroppedNeverGapped() async throws {
        let conn = ScriptedRemoteConn()
        let cursors = InMemoryCursorStore()
        let client = makeClient(conn: conn, cursors: cursors, liveBufferCap: 2)
        let (events, evTask) = drain(client.events)
        let (gaps, gapTask) = drain(client.gaps)
        defer { evTask.cancel(); gapTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: [.replayBegin(sessionID: "s1", fromSeq: 0, highWatermark: 3)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])

        conn.enqueueInbound(eventFrame(session: "s1", seq: 1)) // replay; still replaying
        for i in 1...5 { // FIVE deltas against a transient budget of two
            conn.enqueueInbound(eventFrame(session: "s1", seq: 9, type: "assistant_delta",
                                           extra: ["delta": .string("chunk-\(i)")]))
        }
        conn.enqueueInbound(eventFrame(session: "s1", seq: 5)) // a persisted live event still fits
        conn.enqueueInbound(eventFrame(session: "s1", seq: 2))
        conn.enqueueInbound(eventFrame(session: "s1", seq: 3)) // completes the batch → drain

        try await waitUntil({ self.seqs(events.items).count >= 6 }, "the batch plus the surviving hold")
        XCTAssertTrue(gaps.items.isEmpty, "overflowing transients are dropped, never escalated to a gap")
        XCTAssertEqual(deltas(events.items), ["chunk-1", "chunk-2"], "only the budgeted two are parked")
        XCTAssertEqual(seqs(events.items), [1, 2, 3, 5, 9, 9])
        XCTAssertEqual(cursors.cursor(host: "mac-host", session: "s1", stream: "s1"), 5,
                       "the persisted live event kept its own budget and was delivered")
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

    // MARK: - orb-regressions fix round 1 (2026-07-29): no-argument RPCs carry `params: {}`
    //
    // `rpcCall` built its frame with `if let params { obj["params"] = params }` — character-for-
    // character the NormaKit bug that killed the orb's Enter and detach: the daemon validates each
    // method with `parseParams` against its zod schema, every no-argument method's schema is
    // `z.object({})`, and `z.object({}).safeParse(undefined)` FAILS, so an omitted key comes back
    // `-32602 invalid params: (root)`.
    //
    // It mattered MORE here than in NormaKit: NormaSessionKit — not NormaKit — is what `norma-ios`
    // actually consumes (the root Package.swift exports NormaProtocol + NormaSessionKit only), and
    // the phone is version-skewed by design (kit tags + App Store cadence), so a client-side-only
    // fix is precisely the fix that cannot be shipped there quickly. `engine.activity` and
    // `session.dispatch` are both remote-allowed and both `z.object({})`, so a phone feature
    // calling either without params would have reproduced the orb's exact symptom on a binary this
    // repo's suites cannot catch.
    //
    // `send`'s `params` gained a `nil` default in the same change — source-compatible (every
    // existing caller passes a value), and it turns "a no-argument call is a trap" into "a
    // no-argument call is correct by construction", which is also what makes this test possible.

    func testNoArgumentSendCarriesAnEmptyParamsObject() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let call = Task { try await client.send(method: "engine.activity") }
        let out = try await waitOutbound(conn, count: 2) // [hello, engine.activity request]
        let req = decodeOutbound(out[1])
        XCTAssertEqual(req.kind, .rpcRequest)
        XCTAssertEqual(outboundPayload(req)["method"]?.stringValue, "engine.activity")
        XCTAssertNotNil(
            outboundPayload(req)["params"]?.objectValue,
            "a no-argument RPC must carry a params OBJECT — the daemon parses it with z.object({}), which REJECTS an omitted params key (-32602 invalid params: (root))"
        )
        let id = outboundPayload(req)["id"]!.intValue!
        conn.enqueueInbound(rpcResponseFrame(id: id, result: .object(["activeTurns": .number(0)])))
        let result = try await call.value
        XCTAssertEqual(result["activeTurns"]?.intValue, 0)
    }

    /// CONTROL: a call that DOES carry params is untouched — the normalization only fills an
    /// absent value, it never replaces a real one.
    func testExplicitParamsAreStillSentVerbatim() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let call = Task { try await client.send(method: "session.send", params: .object(["text": .string("hi")])) }
        let out = try await waitOutbound(conn, count: 2)
        let req = decodeOutbound(out[1])
        XCTAssertEqual(outboundPayload(req)["params"]?["text"]?.stringValue, "hi")
        let id = outboundPayload(req)["id"]!.intValue!
        conn.enqueueInbound(rpcResponseFrame(id: id, result: .object(["ok": .bool(true)])))
        _ = try await call.value
    }

    // MARK: - WB-C1: the JSON-RPC error's `data` member reaches the caller
    //
    // `sync.push` answers a base-seq mismatch with `ERR.DIVERGED (-32006)` and puts the daemon's own
    // head in `error.data.lastSeq`. `NormaChatKit.SyncClient` branches on THAT number and nothing
    // else — `0` means "the daemon holds nothing for this id, re-push from seq 1", `> 0` is a real
    // branch point that forks. The Mac gateway was fixed to relay `data` through; a client that
    // decoded only `code`/`message` would put the phone right back where it started, and the failure
    // is SILENT: `push` rethrows, the session simply never reconciles, and no error surfaces.

    func testRpcErrorCarriesItsDataMemberThroughToTheCaller() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let call = Task { try await client.send(method: "sync.push", params: .object(["baseSeq": .number(3)])) }
        let out = try await waitOutbound(conn, count: 2)
        let id = outboundPayload(decodeOutbound(out[1]))["id"]!.intValue!
        // A REAL error body, byte-shaped exactly as the daemon writes it.
        let body = SessionEvent.JSONValue.object([
            "jsonrpc": .string("2.0"), "id": .number(Double(id)),
            "error": .object([
                "code": .number(-32006), "message": .string("diverged"),
                "data": .object(["lastSeq": .number(9)]),
            ]),
        ])
        conn.enqueueInbound(serverFrame(kind: .rpcResponse, payload: try JSONEncoder().encode(body)))

        do {
            _ = try await call.value
            XCTFail("a JSON-RPC error body must throw")
        } catch let e as SessionClientError {
            guard case .rpcError(let code, let message, let data) = e else { return XCTFail("wrong case: \(e)") }
            XCTAssertEqual(code, -32006)
            XCTAssertEqual(message, "diverged")
            XCTAssertEqual(data?["lastSeq"]?.intValue, 9, "data.lastSeq is the ONLY thing the fork logic keys on")
        }
    }

    /// The same for a gateway-level `.error` FRAME (an allowlist/envelope rejection of an in-flight
    /// request) — a second construction site that would have to be fixed independently.
    func testGatewayErrorFrameAlsoCarriesItsDataMember() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let call = Task { try await client.send(method: "sync.push", params: .object([:])) }
        let out = try await waitOutbound(conn, count: 2)
        let id = outboundPayload(decodeOutbound(out[1]))["id"]!.intValue!
        let body = SessionEvent.JSONValue.object([
            "jsonrpc": .string("2.0"), "id": .number(Double(id)),
            "error": .object([
                "code": .number(-32006), "message": .string("diverged"),
                "data": .object(["lastSeq": .number(0)]),
            ]),
        ])
        conn.enqueueInbound(serverFrame(kind: .error, payload: try JSONEncoder().encode(body)))

        do {
            _ = try await call.value
            XCTFail("an error frame must throw")
        } catch let e as SessionClientError {
            guard case .rpcError(_, _, let data) = e else { return XCTFail("wrong case: \(e)") }
            // ZERO, not nil — "the daemon has nothing for this id", which re-pushes rather than forks.
            XCTAssertEqual(data?["lastSeq"]?.intValue, 0)
        }
    }

    /// CONTROL: an error with no `data` member still surfaces, with `data == nil` — the field is
    /// optional on the wire and its absence must never turn into a decode failure.
    func testAnErrorWithoutDataStillSurfacesWithNilData() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let call = Task { try await client.send(method: "session.list", params: .object([:])) }
        let out = try await waitOutbound(conn, count: 2)
        let id = outboundPayload(decodeOutbound(out[1]))["id"]!.intValue!
        let body = SessionEvent.JSONValue.object([
            "jsonrpc": .string("2.0"), "id": .number(Double(id)),
            "error": .object(["code": .number(-32000), "message": .string("pairing revoked")]),
        ])
        conn.enqueueInbound(serverFrame(kind: .rpcResponse, payload: try JSONEncoder().encode(body)))

        do {
            _ = try await call.value
            XCTFail("expected a throw")
        } catch let e as SessionClientError {
            guard case .rpcError(let code, let message, let data) = e else { return XCTFail("wrong case: \(e)") }
            XCTAssertEqual(code, -32000)
            XCTAssertEqual(message, "pairing revoked")
            XCTAssertNil(data)
        }
    }

    // MARK: - Session history (opaque decode)

    func testHistoryDecodesPageOpaquelyIncludingAnUnknownEventType() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let call = Task { try await client.history(sessionID: "s1", beforeSeq: 42, limit: 200) }
        let out = try await waitOutbound(conn, count: 2) // [hello, history request]
        let req = decodeOutbound(out[1])
        XCTAssertEqual(req.kind, .rpcRequest)
        XCTAssertEqual(outboundPayload(req)["method"]?.stringValue, "session.history")
        XCTAssertEqual(outboundPayload(req)["params"]?["sessionId"]?.stringValue, "s1")
        XCTAssertEqual(outboundPayload(req)["params"]?["beforeSeq"]?.intValue, 42)
        XCTAssertEqual(outboundPayload(req)["params"]?["limit"]?.intValue, 200)
        let id = outboundPayload(req)["id"]!.intValue!

        // A page whose 2nd event is an ADVERSARIALLY-inserted unknown type must decode without
        // throwing (defense in depth — the strict SessionEvent enum is never used here).
        let events = SessionEvent.JSONValue.array([
            .object(["type": .string("assistant_message"), "sessionId": .string("s1"), "seq": .number(43), "threadId": .string("main"), "text": .string("hi")]),
            .object(["type": .string("totally_unknown_future_type"), "sessionId": .string("s1"), "seq": .number(44), "mystery": .string("x")]),
        ])
        conn.enqueueInbound(rpcResponseFrame(id: id, result: .object([
            "events": events, "hasMore": .bool(true), "oldestSeq": .number(43),
        ])))

        let page = try await call.value
        XCTAssertEqual(page.envelopes.count, 2, "the unknown-type event is retained, not dropped or thrown")
        XCTAssertEqual(page.envelopes.map(\.seq), [43, 44])
        XCTAssertEqual(page.envelopes[1].json["type"]?.stringValue, "totally_unknown_future_type")
        XCTAssertEqual(page.envelopes[0].kind, .event)
        XCTAssertEqual(page.hasMore, true)
        XCTAssertEqual(page.oldestSeq, 43)
    }

    func testHistoryOmitsBeforeSeqAndLimitWhenNil() async throws {
        let conn = ScriptedRemoteConn()
        let client = makeClient(conn: conn, cursors: InMemoryCursorStore())
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])

        let call = Task { try await client.history(sessionID: "s1") }
        let out = try await waitOutbound(conn, count: 2)
        let req = decodeOutbound(out[1])
        let params = outboundPayload(req)["params"]!
        XCTAssertEqual(params["sessionId"]?.stringValue, "s1")
        XCTAssertNil(params["beforeSeq"], "omitted, not sent as null")
        XCTAssertNil(params["limit"], "omitted, not sent as null")
        let id = outboundPayload(req)["id"]!.intValue!
        conn.enqueueInbound(rpcResponseFrame(id: id, result: .object(["events": .array([]), "hasMore": .bool(false), "oldestSeq": .null])))
        let page = try await call.value
        XCTAssertTrue(page.envelopes.isEmpty)
        XCTAssertNil(page.oldestSeq)
        XCTAssertFalse(page.hasMore)
    }

    // MARK: - KA-T3: client heartbeat (lastInboundAt watchdog)

    /// Baseline: after `quietMs` of silence the watchdog sends exactly one `.ping`; advancing
    /// further but still short of `quietMs + secondWindowMs` does not draw a second one.
    func testQuietLinkPingsAtThreshold() async throws {
        let conn = ScriptedRemoteConn()
        let clock = TestClock()
        let cfg = HeartbeatConfig(quietMs: 100, secondWindowMs: 100, graceMs: 50, tickMs: 10)
        let client = makeHeartbeatClient(conn: conn, clock: clock, heartbeat: cfg)
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])
        _ = try await waitOutbound(conn, count: 1) // [hello]

        clock.now += 100 // == quietMs
        let out = try await waitOutbound(conn, count: 2) // [hello, ping]
        XCTAssertEqual(decodeOutbound(out[1]).kind, .ping)
        XCTAssertTrue(decodeOutbound(out[1]).payload.isEmpty)

        clock.now += 50 // still < quietMs + secondWindowMs (200)
        try await Task.sleep(nanoseconds: 40_000_000) // several ticks elapse
        XCTAssertEqual(conn.outbound.count, 2, "no second ping until the full second window elapses")
    }

    /// ANY inbound frame — even one shaped like an OLD gateway's generic error reply to a `.ping`
    /// it doesn't understand, not a `.pong` — counts as liveness and resets the window. Config is
    /// deliberately asymmetric (`quietMs` >> `secondWindowMs + graceMs`) so the OLD (unreset)
    /// schedule's close deadline can be crossed while the FRESH (reset) schedule's own next
    /// threshold is still comfortably in the future — the two outcomes are unambiguous at the same
    /// clock value: a buggy unreset impl would have closed by then, a correct one has done nothing.
    func testAnyInboundFrameResetsTheWindow() async throws {
        let conn = ScriptedRemoteConn()
        let clock = TestClock()
        let cfg = HeartbeatConfig(quietMs: 100, secondWindowMs: 20, graceMs: 10, tickMs: 10)
        let client = makeHeartbeatClient(conn: conn, clock: clock, heartbeat: cfg)
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])
        _ = try await waitOutbound(conn, count: 1) // [hello]

        clock.now += 100 // quiet → first ping
        _ = try await waitOutbound(conn, count: 2) // [hello, ping]

        // The OLD-gateway reply shape: a generic `.error` frame, not a `.pong` — still proves the
        // path is alive. Give the actor a moment to actually process it (real time, not the fake
        // clock) before advancing further, so the reset is durably applied first.
        conn.enqueueInbound(serverFrame(kind: .error, payload: Data()))
        try await Task.sleep(nanoseconds: 30_000_000)

        // Past the OLD (unreset) close deadline (quiet >= 100 + 20 + 10 = 130 from the ORIGINAL
        // t=0, i.e. clock >= 130) — a buggy impl that failed to reset would have closed by now.
        // The reset schedule's own next threshold (a fresh ping at quiet >= 100 from the reset
        // point, i.e. clock >= 200) is still far off.
        clock.now += 40 // clock == 140
        try await Task.sleep(nanoseconds: 60_000_000) // several ticks elapse
        XCTAssertFalse(conn.isClosed, "the reset must prevent closing on the stale (unreset) schedule")
        XCTAssertEqual(conn.outbound.count, 2, "no second ping and no close until a FRESH quiet period elapses")
    }

    /// Two full silent windows (a ping, then silence past the second window, then silence past
    /// grace) declare the path dead by closing OUR side of the connection — never a bespoke error.
    /// Downstream, this must be indistinguishable from an ordinary socket death: the pending rpc
    /// waiter resumes with `.connectionClosed` and the events stream finishes.
    func testTwoSilentWindowsCloseTheConnection() async throws {
        let conn = ScriptedRemoteConn()
        let clock = TestClock()
        let cfg = HeartbeatConfig(quietMs: 50, secondWindowMs: 50, graceMs: 20, tickMs: 10)
        let client = makeHeartbeatClient(conn: conn, clock: clock, heartbeat: cfg)
        let (events, evTask) = drain(client.events)
        defer { evTask.cancel() } // no-op once it finishes naturally below; safety net otherwise

        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])
        let sendTask = Task { try await client.send(method: "session.list", params: .object([:])) }
        _ = try await waitOutbound(conn, count: 2) // [hello, session.list request] — pending rpc parked

        clock.now += 50 // quietMs → ping 1
        _ = try await waitOutbound(conn, count: 3)

        clock.now += 50 // secondWindowMs → ping 2
        _ = try await waitOutbound(conn, count: 4)

        clock.now += 20 // graceMs → nothing heard from either solicitation: the path is dead
        try await waitUntil({ conn.isClosed }, "conn.close() to fire after two unanswered pings")

        do {
            _ = try await sendTask.value
            XCTFail("the pending rpc waiter should have resumed with connectionClosed")
        } catch {
            XCTAssertEqual(error as? SessionClientError, .connectionClosed)
        }
        _ = await evTask.value // the events AsyncStream finished naturally (handleClose ran)
        XCTAssertTrue(events.items.isEmpty, "no .ping/.pong ever surfaces as a SessionEnvelope")
    }

    /// A genuinely streaming link (inbound events arriving well inside every quiet window) never
    /// draws a ping, across several windows' worth of elapsed time.
    func testStreamingLinkNeverPings() async throws {
        let conn = ScriptedRemoteConn()
        let clock = TestClock()
        let cfg = HeartbeatConfig(quietMs: 50, secondWindowMs: 50, graceMs: 20, tickMs: 10)
        let client = makeHeartbeatClient(conn: conn, clock: clock, heartbeat: cfg)
        conn.enqueueInbound(helloAckFrame(verdicts: [.upToDate(sessionID: "s1", highWatermark: 0)]))
        _ = try await client.handshake(resumes: [StreamResume(sessionID: "s1", streamID: "s1", lastAppliedSeq: 0)])
        _ = try await waitOutbound(conn, count: 1) // [hello]

        // 9 events at 20ms(-equivalent-clock) spacing (< quietMs) span > 3 quiet windows in total.
        for i in 1...9 {
            clock.now += 20
            conn.enqueueInbound(eventFrame(session: "s1", seq: i))
            try await Task.sleep(nanoseconds: 15_000_000) // let it land + a watchdog tick pass
        }
        XCTAssertEqual(conn.outbound.count, 1, "no ping ever fires while genuinely streaming")
    }

    /// A backgrounded client (`isActive: { false }`) never pings and never closes on staleness —
    /// that judgment belongs to conn-keep (background lifecycle), not this watchdog.
    func testInactiveClientNeverPings() async throws {
        let conn = ScriptedRemoteConn()
        let clock = TestClock()
        let cfg = HeartbeatConfig(quietMs: 20, secondWindowMs: 20, graceMs: 10, tickMs: 10)
        let client = makeHeartbeatClient(conn: conn, clock: clock, heartbeat: cfg, isActive: { false })
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])
        _ = try await waitOutbound(conn, count: 1) // [hello]

        clock.now += 10_000 // quiet "forever" relative to every threshold
        try await Task.sleep(nanoseconds: 100_000_000) // many ticks elapse
        XCTAssertEqual(conn.outbound.count, 1, "an inactive client must never ping")
        XCTAssertFalse(conn.isClosed, "and must never close on staleness while inactive")
    }

    /// `.pong` is consumed silently: it never surfaces on `client.events`, but its arrival still
    /// counts as liveness — observable indirectly as "no ping at what would have been the old
    /// (unreset) deadline". Same asymmetric-config trick as `testAnyInboundFrameResetsTheWindow`.
    func testPongIsConsumedSilently() async throws {
        let conn = ScriptedRemoteConn()
        let clock = TestClock()
        let cfg = HeartbeatConfig(quietMs: 100, secondWindowMs: 20, graceMs: 10, tickMs: 10)
        let client = makeHeartbeatClient(conn: conn, clock: clock, heartbeat: cfg)
        let (events, evTask) = drain(client.events)
        defer { evTask.cancel() }

        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])
        _ = try await waitOutbound(conn, count: 1) // [hello]

        clock.now += 100 // quiet → ping
        _ = try await waitOutbound(conn, count: 2)

        conn.enqueueInbound(serverFrame(kind: .pong, payload: Data()))
        try await Task.sleep(nanoseconds: 30_000_000) // let the actor consume it (real time)

        XCTAssertTrue(events.items.isEmpty, "a .pong must never surface on the events stream")

        // The OLD (unreset) 2nd-ping deadline is quiet >= 100 + 20 = 120 from the ORIGINAL t=0,
        // i.e. clock >= 120. The pong's arrival reset lastInboundAt, so nothing fires here — the
        // fresh cycle's own next threshold (clock >= 200) is still far off.
        clock.now += 25 // clock == 125
        try await Task.sleep(nanoseconds: 40_000_000)
        XCTAssertEqual(conn.outbound.count, 2, "the pong reset lastInboundAt: no 2nd ping at the stale deadline")
    }

    /// Branch review (Important): a LEGAL custom config with `secondWindowMs: .max` ("ping once,
    /// never escalate") must never crash. Pre-fix, `heartbeatTick`'s threshold comparisons summed
    /// config fields directly (`cfg.quietMs + cfg.secondWindowMs`) — once `pingsSinceInbound`
    /// reached 1, EVERY subsequent tick evaluated `50 + Int.max` to decide the second-ping branch,
    /// an Int overflow TRAP (not a catchable Swift error) that killed the process outright. Drives
    /// past the first ping, then advances the clock far past every real-world deadline and ticks
    /// repeatedly: must observe exactly one ping ever, no crash, no close.
    func testMaxSecondWindowConfigNeverOverflows() async throws {
        let conn = ScriptedRemoteConn()
        let clock = TestClock()
        let cfg = HeartbeatConfig(quietMs: 50, secondWindowMs: .max, graceMs: 0, tickMs: 10)
        let client = makeHeartbeatClient(conn: conn, clock: clock, heartbeat: cfg)
        conn.enqueueInbound(helloAckFrame(verdicts: []))
        _ = try await client.handshake(resumes: [])
        _ = try await waitOutbound(conn, count: 1) // [hello]

        clock.now += 50 // == quietMs → first (and, per this config, ONLY EVER) ping
        _ = try await waitOutbound(conn, count: 2) // [hello, ping]

        // Advance the clock far past any real-world deadline and let MANY ticks elapse — pre-fix,
        // the very next tick after the first ping traps regardless of `quiet`'s value (the
        // overflow is in the config-field addition itself), so surviving this at all is the point.
        clock.now += 1_000_000_000
        try await Task.sleep(nanoseconds: 150_000_000) // ~15 ticks at tickMs=10

        XCTAssertEqual(conn.outbound.count, 2, "secondWindowMs: .max must mean 'never' — exactly one ping, ever")
        XCTAssertFalse(conn.isClosed, "a config that never reaches its second window must never close")
    }
}
