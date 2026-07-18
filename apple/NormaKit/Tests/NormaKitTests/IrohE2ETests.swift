import XCTest
import os
import NormaProtocol
import IrohLib
@testable import NormaKit

/// SP2a Task 4 (the capstone): prove the WHOLE stack — a real bun daemon, a real `Gateway`, a
/// real `IrohListener`, and a real dialing iroh endpoint speaking the actual
/// `WireEnvelope`/`LengthPrefix` wire protocol — works end-to-end. Every earlier SP2a test left
/// at least one side scripted: `GatewayTests`/`GatewayGateTests` use `ScriptedRemoteConn` for the
/// phone (synchronous `send` by default — no real suspension unless a test explicitly gates it);
/// `IrohListenerTests` exercises real iroh but with bare bytes, no `Gateway`/daemon at all. This
/// file is the first place NOTHING is a double.
///
/// Six scenarios (A-F), matching the task brief. No sleeps used as WAIT conditions — every
/// expected frame is read via `PhoneConn.expectFrame()`, which is itself bounded by a wall-clock
/// `withTimeout` (iroh-ffi's generated async calls ignore Swift task cancellation — verified in
/// Task 3/`IrohListenerTests` — so an unbounded await would hang the whole suite on a regression
/// instead of failing loudly). A couple of short fixed sleeps ARE used, but only as a "settle" grace
/// window to confirm NO further frame arrives — the same idiom `GatewayGateTests` already uses.
final class IrohE2ETests: XCTestCase {

    // MARK: - Shared setup

    /// Starts a real `IrohListener` (loopback, relay disabled — the same hermetic pattern
    /// `IrohListenerTests` uses) and a `Gateway` whose `daemonFactory` connects to `daemon` as the
    /// `remote` principal. This is exactly the production wiring `RemoteHost` assembles (this file
    /// still tests `Gateway`+`IrohListener` directly, with NO `PairingRouter` in front — the
    /// full-stack proof of router+manager+gateway together lives in `PairingE2ETests`), except
    /// `directory` is a scripted `InMemoryDirectory` a caller seeds with whichever phone secrets
    /// it's about to dial (see `PhoneConn.dial`'s own doc comment on why that has to happen BEFORE
    /// dialing).
    private func startGatewayOverIroh(daemon: RealDaemon, directory: any PairingDirectory) async throws -> (listener: IrohListener, gateway: Gateway, runTask: Task<Void, Never>) {
        let listener = try await IrohListener.start(
            secret: SecretKey.generate().toBytes(),
            relayURLs: [],
            bindAddr: "127.0.0.1:0"
        )
        let gateway = Gateway(
            listener: listener,
            daemonFactory: {
                NormaClient(makeTransport: { UnixSocketTransport(path: daemon.socketPath) }, token: daemon.remoteToken, clientName: "iphone-gateway")
            },
            hostID: "host-e2e",
            directory: directory
        )
        let runTask = Task { await gateway.run() }
        return (listener, gateway, runTask)
    }

    /// One phone secret + its pre-derived `peerID`, seeded into a single-member `InMemoryDirectory`
    /// so the caller can dial with `secret` and know `Gateway.handle`'s membership check will
    /// already see it as a paired member the instant the connection is accepted.
    private func singlePhoneDirectory() throws -> (secret: Data, peerID: String, directory: InMemoryDirectory) {
        let secret = SecretKey.generate().toBytes()
        let peerID = try PhoneConn.peerID(forSecret: secret)
        return (secret, peerID, InMemoryDirectory(peerID: peerID))
    }

    /// A harness-role `NormaClient` connected to `daemon` — used to seed/verify session state from
    /// a principal OTHER than the phone (mirrors `GatewayGateTests`' own `seedTwoMessages` helper).
    private func harnessClient(_ daemon: RealDaemon, name: String) async throws -> NormaClient {
        let c = NormaClient(makeTransport: { UnixSocketTransport(path: daemon.socketPath) }, token: daemon.harnessToken, clientName: name)
        try await c.connect(role: "harness")
        return c
    }

    private func isHarnessNoise(_ e: SessionEvent) -> Bool {
        switch e { case .harnessAttached, .harnessDetached: return true; default: return false }
    }

    private func decodeBody(_ e: WireEnvelope) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: e.payload)
    }

    private func decodeEvent(_ e: WireEnvelope) throws -> SessionEvent {
        try JSONDecoder().decode(SessionEvent.self, from: e.payload)
    }

    // MARK: - Scenario A: hello/resume (empty resumes) — helloAck first, session.list works

    func testScenarioA_HelloEmptyResumesThenSessionListWorks() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let (secret, _, directory) = try singlePhoneDirectory()
        let (listener, _, runTask) = try await startGatewayOverIroh(daemon: daemon, directory: directory)
        defer { runTask.cancel(); listener.stop() }

        let phone = try await PhoneConn.dial(listener: listener, secret: secret)
        defer { phone.closeConnection(); phone.closeDialer() }

        try await phone.sendHello(clientInstanceID: "phone-a", resumes: [])
        let ack = try await phone.expectFrame()
        XCTAssertEqual(ack.kind, .helloAck, "helloAck must be the first frame the real phone sees")
        let hello = try JSONDecoder().decode(ServerHello.self, from: ack.payload)
        XCTAssertEqual(hello.verdicts, [], "no resumes were requested — no verdicts")

        try await phone.sendRpcRequest(id: 1, method: "session.list", params: nil)
        let resp = try await phone.expectFrame()
        XCTAssertEqual(resp.kind, .rpcResponse)
        let body = try decodeBody(resp)
        XCTAssertNil(body["error"], "session.list must succeed over the real iroh transport")
        XCTAssertNotNil(body["result"]?["sessions"]?.arrayValue, "session.list must return a sessions array")
    }

    // MARK: - Scenario B: stream — attach a real session, send a message, receive the streamed
    // event, with NO harness_attached leak.

    func testScenarioB_AttachSendStreamsEventsNoHarnessLeak() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }

        // Seed a real session over a SEPARATE harness-role connection. Raw `session.dispatch {}` —
        // NOT `NormaClient.dispatchSession()`, whose `params: nil` the daemon rejects (a known
        // latent bug flagged in Task 2's report; out of scope here).
        let seeder = try await harnessClient(daemon, name: "seeder")
        guard let sid = try await seeder.request("session.dispatch", params: .object([:]))["sessionId"]?.stringValue else {
            return XCTFail("session.dispatch must return a sessionId")
        }
        await seeder.close()

        let (secret, _, directory) = try singlePhoneDirectory()
        let (listener, _, runTask) = try await startGatewayOverIroh(daemon: daemon, directory: directory)
        defer { runTask.cancel(); listener.stop() }

        let phone = try await PhoneConn.dial(listener: listener, secret: secret)
        defer { phone.closeConnection(); phone.closeDialer() }

        try await phone.sendHello(clientInstanceID: "phone-b", resumes: [])
        let helloAck = try await phone.expectFrame()
        XCTAssertEqual(helloAck.kind, .helloAck)

        // Live attach — the `session.attach` special-case in `handleLiveFrame`, not a hello-time
        // resume. The replay (session_created) is guaranteed to precede this request's own
        // rpcResponse: both sends happen sequentially, in the SAME task, per `handleLiveFrame`'s
        // code structure (unlike the send-vs-streamed-event race below).
        try await phone.sendRpcRequest(id: 1, method: "session.attach", params: .object([
            "sessionId": .string(sid), "fromSeq": .number(0),
        ]))
        let replay = try await phone.expectFrame()
        XCTAssertEqual(replay.kind, .event, "the attach's own replay must precede its rpcResponse")
        let replayedEvent = try decodeEvent(replay)
        guard case .sessionCreated = replayedEvent else {
            return XCTFail("expected a session_created replay, got \(replayedEvent)")
        }
        let attachResp = try await phone.expectFrame()
        XCTAssertEqual(attachResp.kind, .rpcResponse)
        XCTAssertNil(try decodeBody(attachResp)["error"])

        // Send a message live.
        try await phone.sendRpcRequest(id: 2, method: "session.send", params: .object([
            "sessionId": .string(sid), "text": .string("hello from phone"),
        ]))

        // The streamed event (delivered via the gateway's persistent daemon-event PUMP task) and
        // this request's own rpcResponse (delivered via `handleLiveFrame`'s direct `await
        // daemonClient.request(...)`) race on two DIFFERENT tasks — unlike the attach replay
        // above, there is no code-structure guarantee of their relative order. Collect both, in
        // whichever order they land, and assert on CONTENT rather than wire order.
        let frames = [try await phone.expectFrame(), try await phone.expectFrame()]
        guard let eventFrame = frames.first(where: { $0.kind == .event }),
              let respFrame = frames.first(where: { $0.kind == .rpcResponse }) else {
            return XCTFail("expected one event frame and one rpcResponse frame, got kinds \(frames.map(\.kind))")
        }
        let streamedEvent = try decodeEvent(eventFrame)
        guard case .userMessage(let um) = streamedEvent else {
            return XCTFail("expected a streamed user_message, got \(streamedEvent)")
        }
        XCTAssertEqual(um.text, "hello from phone")
        XCTAssertEqual(um.sessionId, sid)
        XCTAssertFalse(isHarnessNoise(streamedEvent), "no harness_attached/detached leak (G1, over the real transport)")

        let sendBody = try decodeBody(respFrame)
        XCTAssertNil(sendBody["error"])
        XCTAssertEqual(sendBody["result"]?["seq"]?.intValue, um.seq, "the send's own response must agree with the streamed event's seq")
    }

    // MARK: - Scenario C: reconnect/replay — drop mid-stream; reconnect with the cursor → exact
    // gap replayed, no dup/loss, helloAck precedes everything — proven over the REAL async
    // transport, where every `IrohConn.send` genuinely suspends (unlike `ScriptedRemoteConn`'s
    // default synchronous path) — this is the hold-and-drain fix's actual target environment.

    func testScenarioC_ReconnectReplaysExactGapInOrderOverRealAsyncTransport() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }

        let live = try await harnessClient(daemon, name: "live")
        guard let sid = try await live.request("session.dispatch", params: .object([:]))["sessionId"]?.stringValue else {
            return XCTFail("session.dispatch must return a sessionId")
        }
        let afterAttach = try await live.attach(sessionId: sid, fromSeq: 0)
        let seqM1 = try await live.send(sessionId: sid, text: "seed-m1")

        // Same physical phone reconnects later in this scenario — one secret, one directory entry,
        // reused for BOTH dials (see `PhoneConn.dial`'s own doc comment on why a reconnect must
        // reuse its identity rather than mint a fresh one).
        let (secret, _, directory) = try singlePhoneDirectory()
        let (listener, gateway, runTask) = try await startGatewayOverIroh(daemon: daemon, directory: directory)
        defer { runTask.cancel(); listener.stop() }

        let phone1 = try await PhoneConn.dial(listener: listener, secret: secret)
        defer { phone1.closeConnection(); phone1.closeDialer() }
        try await phone1.sendHello(clientInstanceID: "phone-c", resumes: [
            StreamResume(sessionID: sid, streamID: sid, lastAppliedSeq: afterAttach),
        ])
        let ack1 = try await phone1.expectFrame()
        XCTAssertEqual(ack1.kind, .helloAck, "helloAck must precede the replay, even over real iroh")
        let hello1 = try JSONDecoder().decode(ServerHello.self, from: ack1.payload)
        XCTAssertEqual(hello1.verdicts, [.replayBegin(sessionID: sid, fromSeq: afterAttach, highWatermark: seqM1)])
        let replay1 = try await phone1.expectFrame()
        XCTAssertEqual(replay1.kind, .event)
        XCTAssertEqual(replay1.seq, seqM1)

        // Drop the phone mid-stream.
        phone1.closeConnection()

        // A live message must land in the EXACT gap review-follow-up-2 protects: after the
        // reconnect's own attach() has resolved (so the daemon's committed state at that instant
        // still shows nothing new — the verdict WILL be `.upToDate`), but before the ack/drain flush
        // completes. Two things had to be ruled out empirically to get here reliably:
        //   1. A naive wall-clock race (fire concurrently with dialing phone2) is NOT reliable: a
        //      direct unix-socket daemon round trip consistently resolves faster than an iroh dial +
        //      QUIC handshake, so the gap message lands as plain replay content nearly every time —
        //      confirmed empirically: 10/10 green even with the hold-and-drain queueing disabled.
        //   2. Firing right as the hold RAISES (before attach) still races the gateway's own attach
        //      call over a separate connection — ~50/50 replay vs. live, confirmed empirically.
        // `waitForNextAttachResolvedForTesting()` removes both races: it resumes only once THIS
        // reconnect's attach has genuinely resolved, guaranteeing the send below always counts as a
        // live, held broadcast — see the `.upToDate` assertion below, which is the proof this
        // actually happened (not a guess).
        //
        // Honesty note (see the report): even with the branch pinned this way, deliberately
        // reverting the hold-and-drain queueing in `routeDaemonEvent` did NOT reproduce a visible
        // ordering violation here — on this machine the ack's own encode+send consistently wins
        // the race against the live event's longer round trip (a separate daemon connection's
        // broadcast back through the gateway's pump), so this scenario is not a reliable RED/GREEN
        // discriminator for the interleaving bug by itself. The deterministic proof — an ARTIFICIAL
        // suspension at the exact send call, forcing the interleave every time — lives in
        // `GatewayGateTests.testR2_HelloAckReplayLiveStrictOrderUnderSuspendingSend`. What THIS
        // scenario reliably proves is that the same code path produces correct, ordered output when
        // driven by a genuinely (not artificially) suspending transport — the real thing the fix
        // has to hold up against in production.
        async let gapSeq: Int = {
            await gateway.waitForNextAttachResolvedForTesting()
            return try await live.send(sessionId: sid, text: "gap-m2")
        }()
        let phone2 = try await PhoneConn.dial(listener: listener, secret: secret)
        defer { phone2.closeConnection(); phone2.closeDialer() }
        try await phone2.sendHello(clientInstanceID: "phone-c", resumes: [
            StreamResume(sessionID: sid, streamID: sid, lastAppliedSeq: seqM1),
        ])
        let seqGap = try await gapSeq

        let ack2 = try await phone2.expectFrame()
        XCTAssertEqual(ack2.kind, .helloAck, "helloAck must be the FIRST frame on reconnect too (G3, real transport)")
        let hello2 = try JSONDecoder().decode(ServerHello.self, from: ack2.payload)
        XCTAssertEqual(hello2.verdicts, [.upToDate(sessionID: sid, highWatermark: seqM1)],
                       "the gap message must NOT be visible to the reconnect's own attach — it must be a genuinely live, held event")

        let gapFrame = try await phone2.expectFrame()
        XCTAssertEqual(gapFrame.kind, .event)
        XCTAssertEqual(gapFrame.seq, seqGap, "exactly the gap message, delivered as a held live event strictly after the ack")
        let gapEvent = try decodeEvent(gapFrame)
        guard case .userMessage(let gm) = gapEvent else {
            return XCTFail("expected the gap user_message, got \(gapEvent)")
        }
        XCTAssertEqual(gm.text, "gap-m2")
        XCTAssertFalse(isHarnessNoise(gapEvent))

        // No dup of seqM1 (already delivered to phone1), and nothing more arrives at all — exactly
        // these 2 frames for phone2.
        do {
            let extra = try await phone2.readNext(timeout: 0.5)
            XCTFail("expected no third frame — phone2 should see exactly [helloAck, gap event], got \(extra)")
        } catch {
            // Timed out waiting for a (nonexistent) third frame — expected.
        }

        await live.close()
    }

    // MARK: - Scenario D: idempotency — resend the SAME commandId across a reconnect → ONE
    // daemon effect (the daemon's own per-connection dedup cache; the gateway is a transparent
    // relay and never dedups itself — see Gateway.swift's own header comment).

    func testScenarioD_IdempotentResendAcrossReconnectYieldsOneDaemonEffect() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let (secret, _, directory) = try singlePhoneDirectory()
        let (listener, _, runTask) = try await startGatewayOverIroh(daemon: daemon, directory: directory)
        defer { runTask.cancel(); listener.stop() }

        let verifier = try await harnessClient(daemon, name: "verifier")

        let phone1 = try await PhoneConn.dial(listener: listener, secret: secret)
        defer { phone1.closeConnection(); phone1.closeDialer() }
        try await phone1.sendHello(clientInstanceID: "phone-d", resumes: [])
        let helloAck1 = try await phone1.expectFrame()
        XCTAssertEqual(helloAck1.kind, .helloAck)

        try await phone1.sendRpcRequest(id: 1, method: "session.dispatch", params: .object([:]))
        let dispatchBody = try decodeBody(try await phone1.expectFrame())
        guard let sid = dispatchBody["result"]?["sessionId"]?.stringValue else {
            return XCTFail("session.dispatch must return a sessionId")
        }

        try await phone1.sendRpcRequest(id: 2, method: "session.attach", params: .object([
            "sessionId": .string(sid), "fromSeq": .number(0),
        ]))
        let dReplay = try await phone1.expectFrame()
        XCTAssertEqual(dReplay.kind, .event) // session_created replay
        let dAttachResp = try await phone1.expectFrame()
        XCTAssertNil(try decodeBody(dAttachResp)["error"]) // attach rpcResponse

        try await phone1.sendRpcRequest(id: 3, method: "session.send", params: .object([
            "sessionId": .string(sid), "text": .string("hi"),
        ]), commandId: "cmd-d1")
        let frames1 = [try await phone1.expectFrame(), try await phone1.expectFrame()]
        guard let event1 = frames1.first(where: { $0.kind == .event }),
              let resp1 = frames1.first(where: { $0.kind == .rpcResponse }) else {
            return XCTFail("expected event + rpcResponse for the first send, got kinds \(frames1.map(\.kind))")
        }
        let firstEvent = try decodeEvent(event1)
        guard case .userMessage(let m1) = firstEvent else { return XCTFail("expected a user_message") }
        let seq1 = try decodeBody(resp1)["result"]?["seq"]?.intValue
        XCTAssertEqual(seq1, m1.seq)

        phone1.closeConnection()

        // Reconnect — SAME clientInstanceID (and SAME iroh identity/secret), so the gateway reuses
        // the SAME persistent daemon connection (and therefore the SAME server-side
        // `socket.data.seenCommands` cache entry).
        let phone2 = try await PhoneConn.dial(listener: listener, secret: secret)
        defer { phone2.closeConnection(); phone2.closeDialer() }
        try await phone2.sendHello(clientInstanceID: "phone-d", resumes: [
            StreamResume(sessionID: sid, streamID: sid, lastAppliedSeq: m1.seq),
        ])
        let helloAck2 = try await phone2.expectFrame()
        XCTAssertEqual(helloAck2.kind, .helloAck) // upToDate — nothing new happened

        // Baseline AFTER the reconnect's own re-attach (which mints its own `harness_detached` +
        // `harness_attached` housekeeping noise — unrelated to idempotency, filtered from the
        // phone either way) but BEFORE the resend — isolates "did the RESEND itself mint a new
        // event" from the reconnect's own unavoidable bookkeeping.
        let lastSeqBeforeResend = try await verifier.listSessions().first { $0.sessionId == sid }?.lastSeq
        XCTAssertNotNil(lastSeqBeforeResend)

        // The EXACT same commandId, from the reconnected phone — the daemon must answer from its
        // per-connection cache without re-invoking hub.send: no new event, the SAME cached seq.
        try await phone2.sendRpcRequest(id: 4, method: "session.send", params: .object([
            "sessionId": .string(sid), "text": .string("hi"),
        ]), commandId: "cmd-d1")
        let resendResp = try await phone2.expectFrame()
        XCTAssertEqual(resendResp.kind, .rpcResponse)
        XCTAssertEqual(try decodeBody(resendResp)["result"]?["seq"]?.intValue, seq1, "the cached result must be replayed unchanged")

        // No new event: a deduped resend must never re-broadcast.
        do {
            let extra = try await phone2.readNext(timeout: 0.5)
            XCTFail("a deduped resend must not produce a second event, got \(extra)")
        } catch { /* expected: nothing else arrives */ }

        let lastSeqAfterResend = try await verifier.listSessions().first { $0.sessionId == sid }?.lastSeq
        XCTAssertEqual(lastSeqAfterResend, lastSeqBeforeResend, "ONE daemon effect: the resend must not mint a new seq")

        await verifier.close()
    }

    // MARK: - Scenario E: off-list rpcRequest → error frame, daemon unaffected

    func testScenarioE_OffListMethodRejectedDaemonUnaffected() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let (secret, _, directory) = try singlePhoneDirectory()
        let (listener, _, runTask) = try await startGatewayOverIroh(daemon: daemon, directory: directory)
        defer { runTask.cancel(); listener.stop() }

        let phone = try await PhoneConn.dial(listener: listener, secret: secret)
        defer { phone.closeConnection(); phone.closeDialer() }

        try await phone.sendHello(clientInstanceID: "phone-e", resumes: [])
        let eHelloAck = try await phone.expectFrame()
        XCTAssertEqual(eHelloAck.kind, .helloAck)

        try await phone.sendRpcRequest(id: 1, method: "daemon.trustDir", params: .object(["path": .string("/tmp")]))
        let rejection = try await phone.expectFrame()
        XCTAssertEqual(rejection.kind, .error)
        let body = try decodeBody(rejection)
        XCTAssertEqual(body["error"]?["message"]?.stringValue, "remote role may not call daemon.trustDir")

        // The daemon is unaffected: a legitimate call right after still works normally — the
        // off-list attempt never touched (let alone corrupted) the daemon connection or its state.
        try await phone.sendRpcRequest(id: 2, method: "session.list", params: nil)
        let ok = try await phone.expectFrame()
        XCTAssertEqual(ok.kind, .rpcResponse)
        XCTAssertNil(try decodeBody(ok)["error"])
    }

    // MARK: - Scenario F: revoke mid-stream — conn drops (Task 4 fix, see report), pump cancelled

    func testScenarioF_RevokeDropsConnAndCancelsPump() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let (secret, peerID, directory) = try singlePhoneDirectory()
        let (listener, gateway, runTask) = try await startGatewayOverIroh(daemon: daemon, directory: directory)
        defer { runTask.cancel(); listener.stop() }

        let phone1 = try await PhoneConn.dial(listener: listener, secret: secret)
        defer { phone1.closeConnection(); phone1.closeDialer() }
        try await phone1.sendHello(clientInstanceID: "phone-f", resumes: [])
        let fHelloAck = try await phone1.expectFrame()
        XCTAssertEqual(fHelloAck.kind, .helloAck)

        let pump = await gateway.pumpTaskForTesting("phone-f")
        XCTAssertNotNil(pump, "the phone's daemon-event pump should be running before revoke")

        // Production revocation order (`RemoteHost.revoke`): the STORE record goes first, then
        // the gateway fan-out — since the SP2b whole-branch review fix the directory miss (not
        // the gateway's `revoked` set, which a re-paired member's next valid hello deliberately
        // clears) is what refuses a revoked phone's reconnect.
        directory.remove(peerID)
        await gateway.revoke(clientInstanceID: "phone-f")
        XCTAssertEqual(pump?.isCancelled, true, "revoke must cancel the pumpTask")

        // Task 4 fix (flagged in the report): revoke() previously only marked the phone
        // revoked/refused its future frames — it never closed the actual transport connection, so
        // a revoked phone's REAL iroh connection stayed open indefinitely. Confirmed here via the
        // real transport: the phone's read loop must now observe the connection closing.
        let result = try await phone1.readNext(timeout: 10)
        guard case .closed = result else {
            return XCTFail("revoke must drop the phone's connection, got \(result)")
        }

        // A reconnect by the SAME clientInstanceID is refused at the handshake — as a raw JSON
        // `not_paired` from the membership gate (the record is gone; there's no epoch left to
        // wrap a WireEnvelope error in) — and closed too.
        let phone2 = try await PhoneConn.dial(listener: listener, secret: secret)
        defer { phone2.closeConnection(); phone2.closeDialer() }
        try await phone2.sendHello(clientInstanceID: "phone-f", resumes: [])
        let rejectedData = try await phone2.expectRawFrame()
        let rejected = try JSONDecoder().decode(PairRejected.self, from: rejectedData)
        XCTAssertEqual(rejected.code, "not_paired", "a revoked phone's reconnect is refused at the membership gate")
        let closed2 = try await phone2.readNext(timeout: 10)
        guard case .closed = closed2 else {
            return XCTFail("a revoked phone's reconnect must be closed, got \(closed2)")
        }
    }
}

// MARK: - PhoneConn: the in-process iroh "phone"

/// An in-process iroh endpoint that DIALS the Gateway's `IrohListener` and speaks the actual wire
/// protocol: `ClientHello`/`rpcRequest` out, `helloAck`/`event`/`rpcResponse`/`error` in, each
/// frame `NormaProtocol.LengthPrefix`-framed — mirrors `IrohListenerTests`' own dialer plumbing,
/// but speaks the REAL `WireEnvelope` protocol the Gateway expects instead of bare stand-in bytes.
///
/// Every network call is bounded by `withTimeout` (below) — iroh-ffi's generated async calls
/// ignore Swift task cancellation (verified in Task 3/`IrohListenerTests`), so an unbounded await
/// would hang the whole suite on a regression instead of failing loudly.
///
/// `@unchecked Sendable`: used from a single flow of `await` calls per test (never concurrently
/// against the SAME instance, except the deliberate `async let` race in scenario C, which only
/// ever touches a DIFFERENT `PhoneConn`/`NormaClient`) — matches this test target's existing
/// convention for test-only connection doubles (`ScriptedRemoteConn`).
final class PhoneConn: @unchecked Sendable {
    private let dialerEndpoint: Endpoint
    private let connection: Connection
    private let sendStream: SendStream
    private let recvStream: RecvStream
    private let epoch: Int
    private var buffer = Data()

    /// `secret` (SP2b Task 4): defaults to a fresh random identity, but a caller simulating a
    /// RECONNECT of the same physical phone should pass the SAME secret it used for the first
    /// dial — a real phone's iroh identity is stable across reconnects (`MacIdentity`'s own
    /// header comment makes the same point about the Mac side). This is also how a test seeds
    /// `InMemoryDirectory` with the right `peerID` BEFORE dialing at all: derive it from `secret`
    /// via `PhoneConn.peerID(forSecret:)` (a pure function, no networking needed), insert that
    /// into the directory, THEN dial — eliminating the race a post-hoc "read `conn.peerID` off
    /// the accepted connection and insert it" approach would have against `Gateway.handle`'s own
    /// membership check, which runs the instant the connection is accepted.
    static func dial(listener: IrohListener, alpn: String = IrohListener.defaultALPN, epoch: Int = 1, secret: Data = SecretKey.generate().toBytes()) async throws -> PhoneConn {
        try await withTimeout(15, "PhoneConn.dial") {
            let dialer = try await Endpoint.bind(options: EndpointOptions(
                preset: presetN0(), bindAddr: "127.0.0.1:0",
                secretKey: secret, relayMode: RelayMode.disabled()
            ))
            let alpnData = Data(alpn.utf8)
            let conn = try await dialer.connect(addr: listener.endpointAddr, alpn: alpnData)
            let bi = try await conn.openBi()
            return PhoneConn(dialerEndpoint: dialer, connection: conn, bi: bi, epoch: epoch)
        }
    }

    /// The `EndpointId` (== `RemoteConn.peerID`) a `secret` will bind to, WITHOUT any networking —
    /// pure key derivation (`SecretKey.public()`). See `dial`'s own doc comment on why a test
    /// needs this BEFORE dialing, not after.
    static func peerID(forSecret secret: Data) throws -> String {
        try SecretKey.fromBytes(bytes: secret).public().description
    }

    private init(dialerEndpoint: Endpoint, connection: Connection, bi: BiStream, epoch: Int) {
        self.dialerEndpoint = dialerEndpoint
        self.connection = connection
        self.sendStream = bi.send()
        self.recvStream = bi.recv()
        self.epoch = epoch
    }

    // MARK: - Outbound

    private func sendFrame(_ envelope: WireEnvelope) async throws {
        let data = try WireFrame.encode(envelope)
        let framed = LengthPrefix.wrap(data)
        try await withTimeout(10, "PhoneConn.send") { [self] in
            try await sendStream.writeAll(buf: framed)
        }
    }

    func sendHello(clientInstanceID: String, resumes: [StreamResume]) async throws {
        let hello = ClientHello(protocolVersions: [1], appBuild: "e2e-phone", clientInstanceID: clientInstanceID, pairingEpoch: epoch, resumes: resumes)
        let payload = try JSONEncoder().encode(hello)
        try await sendFrame(WireEnvelope(
            v: 1, pairingEpoch: epoch, hostID: "phone-e2e", sessionID: nil, streamID: nil, seq: nil,
            kind: .hello, timestamp: 0, payload: payload
        ))
    }

    func sendRpcRequest(id: Int, method: String, params: JSONValue?, commandId: String? = nil) async throws {
        var obj: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": .number(Double(id)), "method": .string(method)]
        if let params { obj["params"] = params }
        if let commandId { obj["commandId"] = .string(commandId) }
        let payload = try JSONEncoder().encode(JSONValue.object(obj))
        try await sendFrame(WireEnvelope(
            v: 1, pairingEpoch: epoch, hostID: "phone-e2e", sessionID: nil, streamID: nil, seq: nil,
            kind: .rpcRequest, timestamp: 0, payload: payload
        ))
    }

    /// SP2b Task 4 (`PairingE2ETests`): a pairing-ceremony message (`PairRequest`/`PairAccepted`/
    /// `PairRejected`) is raw JSON, `LengthPrefix`-framed WITHOUT a `WireEnvelope` wrapper — the
    /// phone hasn't paired yet, so there's no epoch/hostID to validate one against (mirrors
    /// `PairingManager.handleConnection`'s own bare `JSONDecoder().decode(PairRequest.self, from:
    /// frame)`). Shares this type's dial/framing plumbing but skips the `WireEnvelope` layer
    /// entirely.
    func sendRaw(_ data: Data) async throws {
        try await withTimeout(10, "PhoneConn.sendRaw") { [self] in
            try await sendStream.writeAll(buf: LengthPrefix.wrap(data))
        }
    }

    /// The raw counterpart to `expectFrame()` — one whole de-framed (but NOT `WireEnvelope`-decoded)
    /// JSON document. See `sendRaw`'s own doc comment.
    func expectRawFrame(timeout: Double = 10) async throws -> Data {
        try await withTimeout(timeout, "PhoneConn.expectRawFrame") { [self] in
            while true {
                if let frame = try LengthPrefix.unwrap(&buffer, maxBytes: 1 << 20) {
                    return frame
                }
                let chunk = try await recvStream.read(sizeLimit: 4096)
                guard !chunk.isEmpty else { throw PhoneTestError.connectionClosedUnexpectedly }
                buffer.append(chunk)
            }
        }
    }

    // MARK: - Inbound

    enum ReadResult { case frame(WireEnvelope); case closed }

    /// Reads one whole de-framed `WireEnvelope`, or `.closed` on clean EOF / a stream error — the
    /// same either/or `IrohConn`'s own read loop treats as end-of-connection. Bounded by a
    /// wall-clock timeout — see the type header.
    func readNext(timeout: Double = 10) async throws -> ReadResult {
        try await withTimeout(timeout, "PhoneConn.readNext") { [self] in
            while true {
                if let frame = try LengthPrefix.unwrap(&buffer, maxBytes: 1 << 20) {
                    return .frame(try WireFrame.decode(frame, expectedEpoch: epoch))
                }
                do {
                    let chunk = try await recvStream.read(sizeLimit: 4096)
                    guard !chunk.isEmpty else { return .closed }
                    buffer.append(chunk)
                } catch {
                    return .closed
                }
            }
        }
    }

    func expectFrame(timeout: Double = 10) async throws -> WireEnvelope {
        guard case .frame(let e) = try await readNext(timeout: timeout) else {
            throw PhoneTestError.connectionClosedUnexpectedly
        }
        return e
    }

    // MARK: - Teardown

    /// Closes the QUIC connection (idempotent on the iroh side) — simulates the phone dropping.
    func closeConnection() {
        try? connection.close(errorCode: 0, reason: Data())
    }

    /// Releases this phone's own dialer endpoint. Best-effort/fire-and-forget, matching
    /// `IrohListener.stop()`'s own idiom for the async `Endpoint.close()` call.
    func closeDialer() {
        let ep = dialerEndpoint
        Task { try? await ep.close() }
    }
}

enum PhoneTestError: Error { case connectionClosedUnexpectedly }

private struct E2ETimeoutError: Error, CustomStringConvertible {
    let context: String
    var description: String { "timed out: \(context)" }
}

/// Runs `op` with a hard wall-clock bound — a per-file copy of `IrohListenerTests`' own
/// `withTimeout` (this codebase's convention for such test-only helpers), generalized to return a
/// value: iroh-ffi's generated async calls ignore Swift task cancellation
/// (`uniffiRustCallAsync` polls via `withUnsafeContinuation` with no cancellation handler —
/// verified in `vendor/IrohLibSwift/IrohLib.swift`), so this is a first-wins race between two
/// UNSTRUCTURED tasks (NOT a `withThrowingTaskGroup`, which awaits every child on scope exit and
/// would hang right along with a stuck child): on timeout the test throws immediately and the
/// hung op task is abandoned (it leaks until the test process exits — the acceptable cost of
/// failing loudly instead of hanging).
private func withTimeout<T>(_ seconds: Double, _ context: String = "", _ op: @escaping @Sendable () async throws -> T) async throws -> T {
    let resumed = OSAllocatedUnfairLock(initialState: false)
    let result: Result<T, Error> = await withCheckedContinuation { cont in
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: .failure(E2ETimeoutError(context: context)))
            }
        }
        Task {
            let r: Result<T, Error>
            do { r = .success(try await op()) } catch { r = .failure(error) }
            timer.cancel()
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: r)
            }
        }
    }
    return try result.get()
}
