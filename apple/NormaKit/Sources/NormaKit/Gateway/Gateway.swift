import Foundation
import NormaProtocol

/// Remote Gateway sub-project, Task 5 (the capstone): terminate a remote (phone) transport,
/// validate envelopes, bridge to the daemon as the least-privileged `remote` principal, and
/// orchestrate resume/replay + the gateway-side allowlist.
///
/// **Design note (load-bearing for SP3):** the gateway keeps exactly ONE daemon `NormaClient` per
/// paired phone (keyed by `ClientHello.clientInstanceID`) and does NOT tear it down when the
/// phone's transport connection closes — only a pairing revocation would (out of scope for SP1,
/// no revocation exists yet). This lets the daemon's per-connection command dedup (Task 2) and
/// attach state survive a phone drop/reconnect. SP1's own tests (scenario D) only exercise dedup
/// within a single connection; the across-reconnect guarantee is exercised in SP3 (real
/// reconnects over the real iroh transport).
///
/// **Transparent relay for `commandId`:** the gateway forwards a phone's `rpcRequest` payload
/// (including any top-level `commandId`) UNCHANGED to the daemon — see `NormaClient.request
/// (_:params:commandId:)`. It never dedups a repeat itself; the daemon does (Task 2). This
/// layering is deliberate (task brief's own "deviations a reviewer should NOT flag" section) —
/// do not "optimize" by deduping here.
///
/// **No production listener in SP1:** nothing in this file (or anywhere else in the app) ever
/// constructs a real `RemoteListener` — only `GatewayTests` builds a `LoopbackListener`. SP2 wires
/// the real iroh-backed listener + a real `PairingStore` at the exact seam `Gateway.init` takes
/// today (`listener:`/`pairing:` params) — see the one-line comment there.
public actor Gateway {
    /// Fixed pairing identity for SP1 — SP2 replaces this with a real `PairingStore` (per-phone
    /// keys, epoch bumped on re-pairing, QR-exchanged hostID). Not a security gap for SP1: no
    /// production listener exists yet for this stub to protect.
    public struct PairingStub: Sendable {
        public let hostID = "host-stub"
        public let epoch = 1
        public init() {}
    }

    /// Mirrors the daemon's own `REMOTE_ALLOWED_METHODS` (packages/core/src/ipc/server.ts) as an
    /// independent Swift constant — defense in depth: the gateway rejects an off-list method
    /// BEFORE it ever reaches the daemon, which enforces the identical 9-method allowlist itself.
    static let remoteAllowedMethods: Set<String> = [
        "protocol.hello", "session.list", "session.attach", "session.send",
        "session.dispatch", "approval.respond", "ask_user.respond",
        "session.interrupt", "engine.activity",
    ]

    private let listener: RemoteListener
    private let daemonFactory: @Sendable () -> NormaClient
    private let pairing: PairingStub

    /// Inbound `rpcRequest` rate-limit budget (SP2a gate G4a), one bucket minted per phone. Default
    /// 50/s sustained with 200 burst — generous for a human-driven phone, a firm ceiling on a
    /// runaway/hostile one. Injectable so tests can shrink the burst to a couple of tokens.
    private let rateLimit: (perSec: Int, burst: Int)
    /// Injected wall clock feeding each `RateLimiter.allow(now:)` — real time in production, a
    /// frozen/hand-advanced value in tests so the limiter is exercised deterministically.
    private let now: @Sendable () -> TimeInterval

    /// Per-phone state, keyed by `ClientHello.clientInstanceID` — see this type's own header
    /// comment on daemon-connection lifetime.
    private var sessions: [String: PhoneSession] = [:]

    /// `clientInstanceID`s that `revoke(_:)` has torn down (SP2a gate G5). A revoked phone's
    /// reconnect is refused at the handshake, even though `sessions` no longer holds its (dropped)
    /// entry — the set outlives the entry so a pairing revocation stays enforced.
    private var revoked: Set<String> = []

    // SP2 wires the real construction here: `Gateway(listener: IrohListener(...), daemonFactory:
    // { NormaClient(makeTransport: { UnixSocketTransport(...) }, token: pairingStore.remoteToken,
    // clientName: "iphone-gateway") }, pairing: pairingStore.current)` — nothing in SP1 calls this
    // initializer outside of tests.
    public init(
        listener: RemoteListener,
        daemonFactory: @escaping @Sendable () -> NormaClient,
        pairing: PairingStub,
        rateLimit: (perSec: Int, burst: Int) = (perSec: 50, burst: 200),
        now: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) {
        self.listener = listener
        self.daemonFactory = daemonFactory
        self.pairing = pairing
        self.rateLimit = rateLimit
        self.now = now
    }

    public func run() async {
        for await conn in listener.connections {
            Task { [weak self] in await self?.handle(conn) }
        }
    }

    // MARK: - Per-connection handshake + live loop

    private func handle(_ conn: RemoteConn) async {
        var iter = conn.inbound.makeAsyncIterator()
        guard let firstFrame = await iter.next() else { return } // conn closed before ever sending hello

        let helloEnvelope: WireEnvelope
        do {
            helloEnvelope = try WireFrame.decode(firstFrame, expectedEpoch: pairing.epoch)
        } catch {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "invalid hello frame: \(error)")
            conn.close()
            return
        }
        guard helloEnvelope.kind == .hello else {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "expected hello-first frame, got \(helloEnvelope.kind)")
            conn.close()
            return
        }
        guard let clientHello = try? JSONDecoder().decode(ClientHello.self, from: helloEnvelope.payload) else {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "malformed ClientHello")
            conn.close()
            return
        }

        // SP2a gate G5: a revoked phone may not re-establish — refuse the handshake outright.
        guard !revoked.contains(clientHello.clientInstanceID) else {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "pairing revoked")
            conn.close()
            return
        }

        let session = phoneSession(for: clientHello.clientInstanceID)
        if !session.connected {
            do {
                try await session.daemonClient.connect(role: "remote")
            } catch {
                await sendGatewayError(conn, id: .null, sessionID: nil, message: "daemon connect failed: \(error)")
                conn.close()
                return
            }
            session.connected = true
        }

        session.connGeneration += 1
        let myGeneration = session.connGeneration
        session.currentConn = conn
        startPumpIfNeeded(session)

        // SP2a gates G1/G2/G3 (+ review follow-up 2) — the handshake is four ordered phases with
        // NO event frame emitted until after the ack, and NO live frame until the replay flushed:
        //   1. HOLD live forwarding for the whole handshake: on a real async transport every
        //      `conn.send` suspends this actor, so an unheld live forward could land BETWEEN the
        //      helloAck and the still-unflushed lower-seq replay (out-of-order wire delivery) —
        //      and on a reconnect `liveSessionID` is already set before the ack is even built.
        //      Held events queue on `session.heldLive` (see `routeDaemonEvent`) instead of racing.
        //   2. attach + collect each resume's replay, compute the HONEST (content-only) verdict,
        //      and BUFFER the filtered replay events; register the (last) resumed session as live
        //      so mid-handshake daemon events are captured (G2) — queued, per phase 1.
        //   3. send `helloAck`/`ServerHello` FIRST (G3), THEN flush the buffered replay frames.
        //   4. drain the held live queue (already in seq order — single pump) and lift the hold:
        //      replay and live can never interleave, in that order: ack → replay → live.
        session.holdLiveEvents = true
        var verdicts: [ResumeVerdict] = []
        var pendingReplay: [SessionEvent] = []
        for resume in clientHello.resumes {
            let (verdict, _, buffered) = await attachAndReplay(session: session, resume: resume)
            verdicts.append(verdict)
            pendingReplay.append(contentsOf: buffered)
        }
        signalAttachResolvedForTesting()
        // Only the LAST resumed session is truly live-forwardable (one daemon connection, one
        // attach at a time — see `PhoneSession.liveSessionID`). Set once, after the loop, so an
        // earlier resume's session can never leak a live frame ahead of the ack.
        if let last = clientHello.resumes.last {
            session.liveSessionID = last.sessionID
        }

        let serverHello = ServerHello(chosenVersion: 1, hostID: pairing.hostID, verdicts: verdicts)
        if let payload = try? JSONEncoder().encode(serverHello) {
            await send(conn, kind: .helloAck, sessionID: nil, streamID: nil, seq: nil, payload: payload)
        }
        for event in pendingReplay {
            await sendEventFrame(conn, event: event)
        }
        await drainHeldLive(session: session, conn: conn, generation: myGeneration)

        while let frame = await iter.next() {
            await handleLiveFrame(frame, conn: conn, session: session)
        }

        // Phone disconnected. Per this type's header comment: do NOT tear down the daemon client
        // — only stop routing live events to this now-dead conn (unless a newer connection for
        // the same phone has already taken over, in which case leave its pointer alone).
        if session.connGeneration == myGeneration {
            session.currentConn = nil
        }
    }

    private func phoneSession(for clientInstanceID: String) -> PhoneSession {
        if let existing = sessions[clientInstanceID] { return existing }
        let fresh = PhoneSession(
            clientInstanceID: clientInstanceID,
            daemonClient: daemonFactory(),
            rateLimiter: RateLimiter(ratePerSec: rateLimit.perSec, burst: rateLimit.burst)
        )
        sessions[clientInstanceID] = fresh
        return fresh
    }

    // MARK: - Revocation (SP2a gate G5)

    /// Tears down a paired phone's gateway footprint: cancels its persistent daemon-event pump,
    /// closes its daemon `NormaClient` (releasing the `remote` connection), CLOSES its current
    /// transport connection (if any — SP2a Task 4 E2E fix, see below), drops its `PhoneSession`,
    /// and records the `clientInstanceID` as revoked so both any in-flight live loop AND a future
    /// reconnect are refused. Idempotent; safe to call for an unknown id (the id is still marked
    /// revoked, pre-empting a first connection).
    ///
    /// **Task 4 fix:** the original SP2a Task 2 implementation never closed `session.currentConn`
    /// — a revoked phone's transport connection stayed open indefinitely; only its FUTURE frames
    /// got a "pairing revoked" error (via `handleLiveFrame`'s `session.revoked` guard, kept below as
    /// defense-in-depth for a frame already in flight when this runs). Only visible against a real
    /// transport (`ScriptedRemoteConn`'s `isClosed` was never asserted for the conn revoke() itself
    /// was called on, only for a POST-revoke reconnect attempt) — the E2E's scenario F (real iroh)
    /// caught it: a real phone's connection must actually drop, not just get ignored going forward.
    public func revoke(clientInstanceID: String) async {
        revoked.insert(clientInstanceID)
        guard let session = sessions[clientInstanceID] else { return }
        session.revoked = true
        session.pumpTask?.cancel()
        await session.daemonClient.close()
        session.currentConn?.close()
        session.currentConn = nil
        sessions[clientInstanceID] = nil
    }

    /// Test-only inspection hook (`@testable`): the live pump `Task` for a phone, captured BEFORE
    /// `revoke` removes the session so a test can assert it ends up cancelled.
    func pumpTaskForTesting(_ clientInstanceID: String) -> Task<Void, Never>? {
        sessions[clientInstanceID]?.pumpTask
    }

    /// Test-only synchronization hook (`@testable`, SP2a Task 4's E2E): resumed once the
    /// handshake's (or live re-attach's) `attachAndReplay` calls have all resolved — i.e., the
    /// daemon-side attach is now registered and the CONTENT verdict is fixed, but the
    /// ack/replay/drain flush hasn't happened yet. A test that awaits this before firing a
    /// concurrent live event is guaranteed that event lands strictly INSIDE the hold-and-drain
    /// window (review-follow-up-2's fix), landing precisely in the gap between attach resolving
    /// and the flush completing — proving the fix over the REAL async transport instead of
    /// guessing at wall-clock timing (confirmed necessary empirically: firing a concurrent send at
    /// dial-time, or even right as the hold flag raises, still let the gateway's own attach call
    /// win the race often enough to land as ordinary replay rather than a genuinely live event —
    /// see `IrohE2ETests`' scenario C for the full account).
    private var attachResolvedContinuations: [CheckedContinuation<Void, Never>] = []

    func waitForNextAttachResolvedForTesting() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            attachResolvedContinuations.append(cont)
        }
    }

    private func signalAttachResolvedForTesting() {
        guard !attachResolvedContinuations.isEmpty else { return }
        let toResume = attachResolvedContinuations
        attachResolvedContinuations = []
        for c in toResume { c.resume() }
    }

    /// A `harness_attached`/`harness_detached` event is connection-lifecycle NOISE, never phone
    /// content (SP2a gate G1) — the gateway filters it out of both replay and live forwarding, and
    /// excludes it from the honest content high-watermark.
    private func isHarnessNoise(_ e: SessionEvent) -> Bool {
        switch e {
        case .harnessAttached, .harnessDetached: return true
        default: return false
        }
    }

    // MARK: - Daemon event routing (one persistent pump per phone, for its whole lifetime)

    /// Started lazily on first connect and NEVER restarted across reconnects — the sole consumer
    /// of `daemonClient.events` for this phone. Keeping exactly one consumer for the client's
    /// entire lifetime means a reconnect's replay-collection (`attachAndReplay`) never races a
    /// stale forwarder for a since-superseded connection.
    private func startPumpIfNeeded(_ session: PhoneSession) {
        guard session.pumpTask == nil else { return }
        session.pumpTask = Task { [weak self] in
            guard let self else { return }
            var it = session.daemonClient.events.makeAsyncIterator()
            while let ev = await it.next() {
                await self.routeDaemonEvent(ev, session: session)
            }
        }
    }

    private func routeDaemonEvent(_ ev: NormaEvent, session: PhoneSession) async {
        guard case .session(let e) = ev else { return }

        // A `StreamResume`/live `session.attach` handshake is in flight for this session — feed
        // the collector instead of live-forwarding (see `attachAndReplay`/`awaitReplayBatch`).
        if var w = session.waiter, w.sessionID == e.sessionId {
            w.collected.append(e)
            if let target = w.target, e.seq >= target, let cont = w.continuation {
                session.waiter = nil
                cont.resume(returning: w.collected)
            } else {
                session.waiter = w
            }
            return
        }

        guard e.sessionId == session.liveSessionID, let conn = session.currentConn else { return }
        // SP2a gate G1: the same harness-noise filter that guards replay guards live forwarding —
        // the phone never sees a `harness_attached`/`harness_detached` frame.
        guard !isHarnessNoise(e) else { return }
        // Review follow-up 2: a handshake (or live re-attach) is mid-flush — queue instead of
        // sending, so this live frame can never interleave ahead of lower-seq replay frames on a
        // suspending transport. Drained, in order, by `drainHeldLive` once the flush completes.
        if session.holdLiveEvents {
            session.heldLive.append(e)
            return
        }
        await sendEventFrame(conn, event: e)
    }

    /// Review follow-up 2 (the drain half — see `handle`'s phase comment): sends the live events
    /// queued while the hold was up, then lifts the hold. The single pump appends in seq order, so
    /// FIFO drain IS seq order. The loop re-checks emptiness after every (suspending) send and the
    /// flag flips synchronously after the LAST check — no `await` between — so no event can slip
    /// past both the queue and the flag. `generation`: if a newer connection for this phone took
    /// over mid-drain, stop and leave the hold + queue to THAT handshake's own drain — never lift
    /// a hold someone else now owns (its sends belong on the newer conn anyway).
    private func drainHeldLive(session: PhoneSession, conn: RemoteConn, generation: Int) async {
        while session.connGeneration == generation, !session.heldLive.isEmpty {
            let e = session.heldLive.removeFirst()
            guard e.sessionId == session.liveSessionID else { continue } // resumed a different session mid-queue
            await sendEventFrame(conn, event: e)
        }
        if session.connGeneration == generation {
            session.holdLiveEvents = false
        }
    }

    /// Attaches the daemon client to `resume.sessionID` at `resume.lastAppliedSeq`, collects the
    /// replay batch the daemon streams, and returns `(verdict, contentHighWatermark, buffered)` —
    /// the FILTERED replay events to send, but does NOT send them itself. The caller decides
    /// ordering (the handshake sends `helloAck` first, then flushes; the live `session.attach`
    /// re-attach flushes then answers with its `lastSeq`).
    ///
    /// **Honest content watermark (SP2a gate G1).** The daemon's `attach()` return is NOT a usable
    /// high-watermark: `hub.attach` appends a `harness_attached` for THIS very attach and returns
    /// its seq, so the raw return is always `> fromSeq` — which made `.upToDate` unreachable and
    /// leaked that `harness_attached` as a phone-bound frame. Instead we collect the batch, DROP
    /// the `harness_attached`/`harness_detached` noise, and take the high-watermark as the max
    /// CONTENT seq we'll actually deliver (falling back to `fromSeq` when the only thing replayed
    /// was noise — the genuinely-caught-up case, which now correctly yields `.upToDate`).
    private func attachAndReplay(session: PhoneSession, resume: StreamResume) async -> (ResumeVerdict, Int, [SessionEvent]) {
        // Pre-arm the collector BEFORE sending `session.attach` — the daemon (real or faked) may
        // emit the replay's `event` lines strictly before the attach's own RPC response (hub.ts's
        // `hub.attach` delivers synchronously, before the handler returns), so the collector must
        // already be registered when those lines land — mirrors `NormaClient.attach()`'s own
        // "seed lastSeq before the request" trick, one level up.
        session.waiterGeneration += 1
        let myGeneration = session.waiterGeneration
        session.waiter = Waiter(sessionID: resume.sessionID, generation: myGeneration)

        let rawHighWatermark: Int
        do {
            rawHighWatermark = try await session.daemonClient.attach(sessionId: resume.sessionID, fromSeq: resume.lastAppliedSeq)
        } catch {
            session.waiter = nil
            return (.snapshotRequired(sessionID: resume.sessionID, reason: "attach failed: \(error)", oldestAvailableSeq: 0), resume.lastAppliedSeq, [])
        }

        // Collect whenever the daemon's raw return moved past the client's cursor — which, for any
        // LEGITIMATE cursor, is always (the attach's own `harness_attached` bumps it). We must SEE
        // the batch to compute the content-only watermark, even when the client turns out to be
        // caught up (the batch then holds nothing but the terminal `harness_attached`).
        var batch: [SessionEvent] = []
        if rawHighWatermark > resume.lastAppliedSeq {
            batch = await awaitReplayBatch(session: session, sessionID: resume.sessionID, generation: myGeneration, target: rawHighWatermark)
        } else {
            // Cursor-ahead (SP2a review follow-up 1): `rawHighWatermark` is the seq of the
            // `harness_attached` the attach JUST appended — strictly newer than any event the
            // phone could have legitimately applied, so every legitimate cursor sits BELOW it and
            // takes the branch above. A cursor at/beyond it is impossible/corrupt (e.g. a phone
            // that outlived a session wipe). Reporting `.upToDate(fromSeq)` here — the pre-review
            // behavior — would wedge the phone: every real live event (whose seq is far lower)
            // would be silently dropped as stale. The daemon's newest possible CONTENT is
            // `raw - 1`, so feed ResumePlanner exactly that: its cursor-ahead branch
            // (`fromSeq > highWatermark`) fires and demands the snapshot that breaks the wedge.
            session.waiter = nil
            let verdict = ResumePlanner.verdict(fromSeq: resume.lastAppliedSeq, highWatermark: rawHighWatermark - 1, sessionID: resume.sessionID)
            return (verdict, rawHighWatermark - 1, [])
        }

        let content = batch.filter { !isHarnessNoise($0) }
        let toSend = ResumePlanner.replaySlice(events: content, fromSeq: resume.lastAppliedSeq, seqOf: { $0.seq })
        let contentHighWatermark = toSend.map { $0.seq }.max() ?? resume.lastAppliedSeq
        let verdict = ResumePlanner.verdict(fromSeq: resume.lastAppliedSeq, highWatermark: contentHighWatermark, sessionID: resume.sessionID)
        return (verdict, contentHighWatermark, toSend)
    }

    /// Waits until the collector (pre-armed by `attachAndReplay`) has accumulated every event up
    /// to `target` (persisted per-session seq is gapless, so "seq >= target" is exactly "done").
    /// Bounded by a watchdog (mirrors `NormaClient.request`'s own timeout pattern) so a
    /// misbehaving/malformed daemon feed degrades to "replay whatever arrived" rather than a hang.
    /// `generation` (from `session.waiterGeneration`) guards against a STALE watchdog for an
    /// abandoned handshake clobbering a NEWER attach for the same session that starts within the
    /// timeout window — the two are otherwise indistinguishable by `sessionID` alone.
    private func awaitReplayBatch(session: PhoneSession, sessionID: String, generation: Int, target: Int, timeout: Duration = .seconds(5)) async -> [SessionEvent] {
        guard var w = session.waiter, w.sessionID == sessionID, w.generation == generation else { return [] }
        if let last = w.collected.last, last.seq >= target {
            session.waiter = nil
            return w.collected
        }
        return await withCheckedContinuation { (cont: CheckedContinuation<[SessionEvent], Never>) in
            w.target = target
            w.continuation = cont
            session.waiter = w
            Task { [weak self] in
                try? await Task.sleep(for: timeout)
                await self?.timeoutReplayWait(session: session, sessionID: sessionID, generation: generation)
            }
        }
    }

    private func timeoutReplayWait(session: PhoneSession, sessionID: String, generation: Int) {
        guard let w = session.waiter, w.sessionID == sessionID, w.generation == generation, let cont = w.continuation else { return }
        session.waiter = nil
        cont.resume(returning: w.collected)
    }

    // MARK: - Live loop (post-handshake)

    private func handleLiveFrame(_ frame: Data, conn: RemoteConn, session: PhoneSession) async {
        // SP2a gate G5: once revoked, this conn's in-flight read loop keeps draining frames — every
        // one is refused, none reaches the (now-closed) daemon client.
        guard !session.revoked else {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "pairing revoked")
            return
        }
        let envelope: WireEnvelope
        do {
            envelope = try WireFrame.decode(frame, expectedEpoch: pairing.epoch)
        } catch WireError.staleEpoch {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "stale pairing epoch")
            conn.close()
            return
        } catch {
            // Recoverable: an oversize/malformed/unknown-kind frame gets an error frame, but the
            // connection stays open — the phone can just retry (task brief scenario C).
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "invalid envelope: \(error)")
            return
        }

        guard envelope.kind == .rpcRequest else {
            await sendGatewayError(conn, id: .null, sessionID: envelope.sessionID, message: "expected rpcRequest frame, got \(envelope.kind)")
            return
        }
        // SP2a gate G4a: throttle inbound rpcRequests BEFORE parse/allowlist — a phone flooding
        // past its token bucket gets a gateway error, and the frame never touches the daemon.
        guard session.rateLimiter.allow(now: now()) else {
            await sendGatewayError(conn, id: .null, sessionID: envelope.sessionID, message: "rate limit exceeded")
            return
        }
        // SP2a gate G4b: the outer-frame decode above bounds the ENVELOPE's depth, but the inner
        // JSON-RPC payload rode as a base64 string there — validate ITS nesting BEFORE
        // `parseRpcRequest` (the recursive decoder this tripwire protects), so a nesting-bomb
        // payload is refused before it can stress the parser, let alone reach the daemon.
        do {
            try WireFrame.validateJSONDepth(envelope.payload, maxDepth: 32)
        } catch {
            await sendGatewayError(conn, id: .null, sessionID: envelope.sessionID, message: "payload nesting too deep")
            return
        }
        guard let rpc = parseRpcRequest(envelope.payload) else {
            await sendGatewayError(conn, id: .null, sessionID: envelope.sessionID, message: "malformed JSON-RPC payload")
            return
        }
        guard Gateway.remoteAllowedMethods.contains(rpc.method) else {
            // Off-list: rejected here, BEFORE the daemon ever sees it (defense in depth — the
            // daemon enforces the identical allowlist independently).
            await sendGatewayError(conn, id: rpc.id, sessionID: envelope.sessionID, message: "remote role may not call \(rpc.method)")
            return
        }

        // `session.attach` is special-cased to go through the SAME resume/replay machinery as a
        // hello-time `ClientHello.resumes` entry, rather than a bare passthrough — a live
        // re-attach still needs the gateway to know which session is now "live" for event
        // forwarding, and to correctly seed the replay collector.
        if rpc.method == "session.attach", let sessionId = rpc.params?["sessionId"]?.stringValue {
            let fromSeq = rpc.params?["fromSeq"]?.intValue ?? 0
            let resume = StreamResume(sessionID: sessionId, streamID: sessionId, lastAppliedSeq: fromSeq)
            // Same hold-and-drain as the handshake (review follow-up 2): a live event landing
            // while the replay flush below suspends on send must queue behind it, not interleave.
            let myGeneration = session.connGeneration
            session.holdLiveEvents = true
            let (_, contentHighWatermark, buffered) = await attachAndReplay(session: session, resume: resume)
            signalAttachResolvedForTesting()
            // Register live-forwarding BEFORE flushing the replay (G2), then answer with the
            // content-only `lastSeq` (G1) — the phone's cursor tracks what it actually received,
            // not the raw attach return that counts the filtered `harness_attached`. Order is
            // replay → response → drained live: monotonic for the phone's cursor (replay ≤ lastSeq
            // in the response ≤ every drained live seq).
            session.liveSessionID = sessionId
            for event in buffered {
                await sendEventFrame(conn, event: event)
            }
            await sendRpcResult(conn, id: rpc.id, sessionID: envelope.sessionID, streamID: envelope.streamID, result: .object(["lastSeq": .number(Double(contentHighWatermark))]))
            await drainHeldLive(session: session, conn: conn, generation: myGeneration)
            return
        }

        do {
            // Transparent relay — `rpc.commandId` (if any) passes through untouched; the daemon
            // dedups, the gateway never does (this type's own header comment).
            let result = try await session.daemonClient.request(rpc.method, params: rpc.params, commandId: rpc.commandId)
            await sendRpcResult(conn, id: rpc.id, sessionID: envelope.sessionID, streamID: envelope.streamID, result: result)
        } catch let e as RpcError {
            await sendRpcError(conn, id: rpc.id, sessionID: envelope.sessionID, code: e.code, message: e.message)
        } catch {
            await sendRpcError(conn, id: rpc.id, sessionID: envelope.sessionID, code: -1, message: "\(error)")
        }
    }

    // MARK: - JSON-RPC payload parsing

    private struct ParsedRpcRequest {
        let id: JSONValue
        let method: String
        let params: JSONValue?
        let commandId: String?
    }

    private func parseRpcRequest(_ payload: Data) -> ParsedRpcRequest? {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: payload),
              let method = json["method"]?.stringValue else { return nil }
        return ParsedRpcRequest(id: json["id"] ?? .null, method: method, params: json["params"], commandId: json["commandId"]?.stringValue)
    }

    // MARK: - Envelope construction / sending

    private func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    private func send(_ conn: RemoteConn, kind: WireKind, sessionID: String?, streamID: String?, seq: Int?, payload: Data) async {
        let envelope = WireEnvelope(
            v: 1, pairingEpoch: pairing.epoch, hostID: pairing.hostID, sessionID: sessionID,
            streamID: streamID, seq: seq, kind: kind, timestamp: nowMs(), payload: payload
        )
        guard let frame = try? WireFrame.encode(envelope) else { return }
        await conn.send(frame)
    }

    private func sendEventFrame(_ conn: RemoteConn, event: SessionEvent) async {
        guard let payload = try? JSONEncoder().encode(event) else { return }
        await send(conn, kind: .event, sessionID: event.sessionId, streamID: event.sessionId, seq: event.seq, payload: payload)
    }

    /// Gateway-level protocol error (envelope validation failures, hello-first violations, the
    /// allowlist rejection) — distinct from `sendRpcError`, which wraps a genuine daemon RESPONSE
    /// (the request DID reach the daemon and it answered with a JSON-RPC error).
    private func sendGatewayError(_ conn: RemoteConn, id: JSONValue, sessionID: String?, message: String) async {
        let body = JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "error": .object(["code": .number(-32000), "message": .string(message)])])
        guard let payload = try? JSONEncoder().encode(body) else { return }
        await send(conn, kind: .error, sessionID: sessionID, streamID: nil, seq: nil, payload: payload)
    }

    private func sendRpcResult(_ conn: RemoteConn, id: JSONValue, sessionID: String?, streamID: String?, result: JSONValue) async {
        let body = JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "result": result])
        guard let payload = try? JSONEncoder().encode(body) else { return }
        await send(conn, kind: .rpcResponse, sessionID: sessionID, streamID: streamID, seq: nil, payload: payload)
    }

    private func sendRpcError(_ conn: RemoteConn, id: JSONValue, sessionID: String?, code: Int, message: String) async {
        let body = JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "error": .object(["code": .number(Double(code)), "message": .string(message)])])
        guard let payload = try? JSONEncoder().encode(body) else { return }
        await send(conn, kind: .rpcResponse, sessionID: sessionID, streamID: nil, seq: nil, payload: payload)
    }
}

/// Per-phone state, keyed by `ClientHello.clientInstanceID` — see `Gateway`'s own header comment
/// on daemon-connection lifetime.
///
/// `@unchecked Sendable`: every read/mutation happens only from within `Gateway`-actor-isolated
/// code (this class never escapes to any other actor/thread), so access is already serialized by
/// the actor even though the compiler can't prove it for a plain reference type.
private final class PhoneSession: @unchecked Sendable {
    /// The `ClientHello.clientInstanceID` this session is keyed by — carried on the object so
    /// revocation/inspection paths can round-trip it without a reverse lookup.
    let clientInstanceID: String
    let daemonClient: NormaClient
    /// Inbound-rpcRequest token bucket (SP2a gate G4a), one per phone — a flood from one phone
    /// never spends another's budget.
    let rateLimiter: RateLimiter
    /// Set by `Gateway.revoke` (SP2a gate G5): the in-flight live loop checks it to refuse every
    /// subsequent frame after the daemon client has been closed and the session dropped.
    var revoked = false
    var connected = false

    /// The one session currently "live" for this phone. `NormaClient` supports exactly one
    /// attach at a time (mirroring the daemon's own hub move-semantics re-attach), so only the
    /// MOST RECENT `attachAndReplay` call's session is truly live-forwarded afterward — an
    /// inherent SP1/single-daemon-connection limitation; true concurrent multi-session live
    /// streaming would need one daemon connection per attached session (out of scope here, and
    /// not exercised by the task brief's 5 scenarios, which each use one session at a time).
    var liveSessionID: String?

    /// The phone's current physical connection — where live (post-handshake) events for
    /// `liveSessionID` get forwarded. Reassigned on every (re)connect.
    var currentConn: RemoteConn?
    /// Bumped on every new connection for this phone; guards `currentConn`'s clearing on a
    /// natural disconnect from wiping out a NEWER connection that has already taken over.
    var connGeneration = 0

    /// Handshake-time replay collector — see `Gateway.attachAndReplay`/`awaitReplayBatch`/
    /// `routeDaemonEvent`. Non-nil only while a `StreamResume` (or live `session.attach`)
    /// handshake is in flight.
    var waiter: Waiter?
    /// Bumped on every new `attachAndReplay` call — stamped onto that call's `Waiter` so a stale
    /// replay-timeout watchdog (see `awaitReplayBatch`) can tell "my own abandoned handshake timed
    /// out" apart from "a NEWER handshake for the same sessionID is now in flight" and never
    /// clobbers the latter.
    var waiterGeneration = 0

    /// Review follow-up 2 (replay/live ordering): while `true`, `routeDaemonEvent` QUEUES
    /// live-forwardable events on `heldLive` instead of sending — raised for the span of a
    /// handshake (or live re-attach) so a live frame can never interleave ahead of lower-seq
    /// replay frames when a real async transport's `send` suspends the actor. Lowered by
    /// `Gateway.drainHeldLive` once the replay flush completes and the queue is drained.
    var holdLiveEvents = false
    /// The events queued while `holdLiveEvents` was up — appended by the single pump, so already
    /// in seq order; drained FIFO after the replay flush.
    var heldLive: [SessionEvent] = []

    /// Started lazily on first connect and never restarted — the sole consumer of
    /// `daemonClient.events` for this phone's entire lifetime.
    var pumpTask: Task<Void, Never>?

    init(clientInstanceID: String, daemonClient: NormaClient, rateLimiter: RateLimiter) {
        self.clientInstanceID = clientInstanceID
        self.daemonClient = daemonClient
        self.rateLimiter = rateLimiter
    }
}

/// Handshake-time event collector state (see `PhoneSession.waiter`). `target` is `nil` until the
/// triggering `attach()` call has returned (its return value IS the target) — any events that
/// race ahead of that are still captured into `collected` in the meantime. `generation` pins this
/// instance to one `attachAndReplay` call (see `PhoneSession.waiterGeneration`).
private struct Waiter {
    let sessionID: String
    let generation: Int
    var target: Int?
    var collected: [SessionEvent] = []
    var continuation: CheckedContinuation<[SessionEvent], Never>?
}
