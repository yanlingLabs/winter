import XCTest
import os
import NormaProtocol
import IrohLib
@testable import NormaKit
@testable import NormaSessionKit

/// SP3 Task 5 (closes Phase A): the CI conformance harness proving `norma-fake-phone`'s new
/// `--attach` path — `IrohDialer.dial` -> `NormaSessionClient` — is genuinely the SAME production
/// client the app will use, driven end-to-end against a REAL `RealDaemon` (never the live
/// `~/.norma` daemon). Structurally this is `PairingE2ETests.testScenarioA_...`'s own ceremony ->
/// reconnect -> `session.list` proof (that file's helpers are `private` to it, so this file
/// duplicates the small harness-setup glue rather than reusing them directly — this codebase's own
/// established convention for such test-only plumbing, e.g. `withTimeout`'s many per-file copies),
/// carried one step further: the reconnect goes through `NormaSessionClient` itself (not a
/// hand-rolled `PhoneConn`), then drives a full prompt round trip AND the REAL approval flow
/// (`ApprovalBroker`/`peripheral.lease`, SP3 T4b's shipped `approval.list`/`approval.respond`
/// wiring) — never a scripted/fake broker.
///
/// **A genuine finding this harness surfaced — now FIXED in the client.** `Gateway.swift`'s
/// `session.attach` (both at hello-time via `ClientHello.resumes` and live via the `session.attach`
/// RPC) ALWAYS mints its own `harness_attached` bookkeeping event on the daemon (`hub.attach`'s own
/// `appendAndBroadcast`) — filtered from the wire (SP2a gate G1: "no harness_attached/detached
/// leak"), but it still CONSUMES a real, persisted seq slot. `NormaSessionClient`'s original strict
/// gap detection (each seq EXACTLY `cursor + 1`) therefore flagged the very next piece of real
/// content after ANY attach as a permanent false gap (snapshot resume → re-attach → fresh
/// `harness_attached` → new hole → repeat) — first reproduced here against a REAL daemon+gateway,
/// confirmed via a raw `NormaClient` (harness-role, whose own dedup is the more lenient
/// `seq <= lastSeq`, immune to this) observing the SAME events land correctly. The fix aligns the
/// client with SP2a G1's documented contract ("cursors stay exclusive-> over what the phone
/// actually received (filtered seq gaps are fine)"): on the single reliable, ordered QUIC
/// bi-stream a missing seq between two received events is ALWAYS a gateway-filtered event, never
/// mid-stream loss, so `applyEvent` now APPLIES forward jumps and advances the cursor to the
/// received seq; real loss/staleness stays a HANDSHAKE concern (`.snapshotRequired`), and
/// `client.gaps` fires only on liveBuffer overflow. This test now asserts the content events
/// STREAM CLEANLY through the shipped client (events land, `client.gaps` stays silent) — the real
/// "attach → see messages" flow, end-to-end — with the independent harness observers retained as
/// corroboration that the underlying daemon round trips genuinely happened.
final class FakePhoneConformanceTests: XCTestCase {

    // MARK: - Host + ceremony setup (mirrors PairingE2ETests' own pattern)

    private func makeRelayConfig() -> SignedRelayConfig {
        SignedRelayConfig(config: RelayConfig(version: 1, relays: ["relay1.norma.dev"]), sig: Data(repeating: 7, count: 64))
    }

    private func tempStoreDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-fake-phone-conformance-\(UUID().uuidString)", isDirectory: true)
    }

    /// Captures the `IrohListener` `RemoteHost.start()` binds via the `#if DEBUG` `makeListener`
    /// hook — see `PairingE2ETests.ListenerBox`'s own doc comment for why this indirection exists
    /// (`RemoteHost` never exposes its bound listener directly).
    private final class ListenerBox: @unchecked Sendable {
        private let box = OSAllocatedUnfairLock<IrohListener?>(initialState: nil)
        var value: IrohListener? {
            get { box.withLock { $0 } }
            set { box.withLock { $0 = newValue } }
        }
    }

    private struct TestSetup {
        let host: RemoteHost
        let irohListener: IrohListener
        /// Captured once at bind time (pure key derivation off the listener — no MainActor hop
        /// needed later): equals `host.macEndpointID` (`PairingE2ETests` asserts that equality
        /// directly; not re-asserted here to keep this file's own focus on the session client).
        let macEndpointID: String
    }

    @MainActor
    private func makeHost(daemon: RealDaemon) async throws -> TestSetup {
        let secretStore = InMemoryEndpointSecretStore()
        let identity = try MacIdentity.loadOrCreate(store: secretStore)
        let listenerBox = ListenerBox()
        let config = RemoteHost.Config(
            storeDir: tempStoreDir(), socketPath: daemon.socketPath, hostLabel: "Conformance Mac",
            relayConfig: makeRelayConfig(), relayURLs: []
        )
        let host = RemoteHost(
            config: config,
            secretStore: secretStore,
            makeListener: {
                let listener = try await IrohListener.start(secret: identity.secret, relayURLs: [], bindAddr: "127.0.0.1:0")
                listenerBox.value = listener
                return listener
            },
            makeDaemonFactory: {
                NormaClient(makeTransport: { UnixSocketTransport(path: daemon.socketPath) }, token: daemon.remoteToken, clientName: "iphone-gateway")
            }
        )
        // Force-starts (even at zero paired devices) so the listener is bound before pairing.
        _ = try await host.openPairingWindow()
        guard let irohListener = listenerBox.value else {
            throw FakePhoneConformanceError("makeListener never ran — RemoteHost.start() didn't bind a listener")
        }
        return TestSetup(host: host, irohListener: irohListener, macEndpointID: irohListener.endpointID.description)
    }

    /// Runs one full pairing ceremony through the REAL `PhonePairingClient` (not hand-rolled
    /// frames) against an already-open pairing window — see `PairingE2ETests.pairPhone`'s own doc
    /// comment for the identical reasoning (`addrOverride` is the same hermetic test-only seam
    /// `PhonePairingClientTests`/`PairingE2ETests` already use; production has no relay/discovery
    /// wired yet).
    @MainActor
    private func pairPhone(setup: TestSetup, secret: Data) async throws -> PairAccepted {
        guard let manager = setup.host.pairingManager else {
            throw FakePhoneConformanceError("pairPhone requires an already-open pairing window")
        }
        let qr = await manager.beginPairing()
        var events = manager.events.makeAsyncIterator()

        async let phoneResult = PhonePairingClient.pairInternal(
            qr: qr, bindAddr: nil, secret: secret, addrOverride: setup.irohListener.endpointAddr,
            onWords: { _ in }
        )

        guard case .requestReceived = await events.next() else {
            throw FakePhoneConformanceError("expected requestReceived")
        }
        await manager.confirm(label: "Conformance iPhone")
        guard case .completed = await events.next() else {
            throw FakePhoneConformanceError("expected completed")
        }

        let (accepted, _, _) = try await phoneResult
        await setup.host.closePairingWindow()
        return accepted
    }

    // MARK: - Harness (Mac-side, non-phone) connections — drive session.create/peripheral.* the
    // way an ordinary harness client (a CLI, the menu-bar app itself) does; NEVER on the phone's
    // own remote-role connection. `peripheral.advertise`/`peripheral.lease` are still deliberately
    // NOT on `Gateway.remoteAllowedMethods` (v1: peripheral leasing is harness-only — ipc/server.ts's
    // own `peripheral.lease` role guard). `session.create` itself IS on the allowlist as of SP3.4
    // (the phone may start a Code session) — but the daemon rejects a remote-role caller that sets
    // `cwd`/`approvalPolicy` explicitly (SP3.4 hardening: the phone can't browse the Mac's
    // filesystem or override the approval gate), and the conformance session below is created with
    // an explicit `approvalPolicy: "ask"` to force the approval leg — so it still has to go over a
    // harness connection, not the phone's. The phone still drives the REAL approval this provokes —
    // via `pendingApprovals`/`answerApproval` (see this file's header comment on why those, not the
    // push-event path, are what the phone leg below relies on) — exactly how a real phone would be
    // asked to approve something the Mac side wants to do. A couple of these harness connections
    // ALSO double as independent, gap-immune observers (see `verifier`/`approvalVerifier` below)
    // that confirm the underlying events genuinely happened.

    private func harnessClient(_ daemon: RealDaemon, name: String) async throws -> NormaClient {
        let c = NormaClient(makeTransport: { UnixSocketTransport(path: daemon.socketPath) }, token: daemon.harnessToken, clientName: name)
        try await c.connect(role: "harness")
        return c
    }

    // MARK: - Event-wait helpers (mirrors NormaSessionClientTests' own Sink/drain/waitUntil)

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

    private func waitUntil(timeout: TimeInterval = 10, _ msg: String, _ predicate: @escaping () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("timed out: \(msg)")
    }

    /// Polls the REAL broker via `approval.list` (`NormaSessionClient.pendingApprovals`) until it
    /// reports a pending entry — a genuine RPC round trip against `ApprovalBroker.list()`, the
    /// queryable-state surface T4b shipped (pending approvals age out of the retained log, so live
    /// state — not event reconstruction — is the right source regardless of stream timing).
    private func waitForPendingApproval(_ client: NormaSessionClient, sessionID: String, timeout: TimeInterval = 10) async throws -> SessionEvent.JSONValue {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let pending = try await client.pendingApprovals(sessionID: sessionID)
            if let first = pending.first { return first }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw FakePhoneConformanceError("no pending approval appeared for \(sessionID) within \(timeout)s")
    }

    // MARK: - The conformance test

    func testFullLoopThroughNormaSessionClient_PromptRoundTripAndRealApprovalFlow() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon)

        let secret = SecretKey.generate().toBytes()
        let accepted = try await pairPhone(setup: setup, secret: secret)
        XCTAssertEqual(accepted.epoch, 1)
        XCTAssertEqual(accepted.grantedCaps, ["sessions"])

        // ---- Reconnect through the SAME production entry points norma-fake-phone now uses ----
        // (IrohDialer.dial -> NormaSessionClient — NOT a hand-rolled PhoneConn/dial/hello loop).
        // `dialInternal`'s `addrOverride` is the identical hermetic seam `IrohDialerTests` uses:
        // production has no bare-macEndpointID discovery wired up in a test environment.
        let phoneEndpointID = try SecretKey.fromBytes(bytes: secret).public().description
        let conn = try await IrohDialer.dialInternal(
            secret: secret, macEndpointID: setup.macEndpointID, alpn: IrohListener.defaultALPN,
            relayURLs: [], addrOverride: setup.irohListener.endpointAddr
        )
        let client = NormaSessionClient(
            conn: conn, hostID: phoneEndpointID, epoch: accepted.epoch, cursors: InMemoryCursorStore(),
            clientInstanceID: "norma-fake-phone", clock: { Int(Date().timeIntervalSince1970 * 1000) },
            idgen: { UUID().uuidString }
        )
        // The shipped client's own event feed IS the primary assertion surface now (see this
        // file's header comment): content events must stream cleanly through it after attach —
        // filtered-seq forward jumps applied, `client.gaps` silent.
        let (eventSink, eventTask) = drain(client.events)
        defer { eventTask.cancel() }
        let (gapSink, gapTask) = drain(client.gaps)
        defer { gapTask.cancel() }

        _ = try await client.handshake(resumes: [])

        let listResult = try await client.send(method: "session.list", params: .object([:]))
        XCTAssertNotNil(listResult["sessions"]?.arrayValue, "session.list must return a sessions array through the shipped client")

        // ---- Prompt leg: session.dispatch -> attach -> send, verified two ways ----
        //
        // 1. The shipped client's OWN `events` stream delivers the live `user_message` cleanly —
        //    the real "attach → see messages" flow through `NormaSessionClient` itself (the
        //    header comment's finding, now fixed: the filtered-seq forward jump applies, no gap).
        // 2. An independent harness `NormaClient` ("verifier") also attaches and genuinely
        //    observes the same `user_message` — corroborating the REAL daemon/hub/gateway round
        //    trip (session.dispatch -> session.attach -> session.send) underneath.
        let dispatchResult = try await client.send(method: "session.dispatch", params: .object([:]))
        guard let sid = dispatchResult["sessionId"]?.stringValue else {
            return XCTFail("session.dispatch must return a sessionId")
        }
        _ = try await client.send(method: "session.attach", params: .object([
            "sessionId": .string(sid), "fromSeq": .number(0),
        ]))
        let verifier = try await harnessClient(daemon, name: "verifier")
        _ = try await verifier.attach(sessionId: sid, fromSeq: 0)
        let (verifierSink, verifierTask) = drain(verifier.events)
        defer { verifierTask.cancel() }

        let promptText = "hello from the conformance harness"
        let sendResult = try await client.send(method: "session.send", params: .object([
            "sessionId": .string(sid), "text": .string(promptText),
        ]))
        XCTAssertNotNil(sendResult["seq"]?.intValue, "session.send must succeed through the shipped client's transparent-relay RPC path")

        try await waitUntil("expected the independent verifier harness to observe the REAL broadcast user_message") {
            verifierSink.items.contains {
                if case .session(.userMessage(let m)) = $0 { return m.sessionId == sid && m.text == promptText }
                return false
            }
        }
        // The shipped client's OWN feed delivers the content cleanly: the user_message arrives on
        // `client.events` despite the filtered `harness_attached` seq hole in front of it, and no
        // GapSignal fires — the header comment's finding, fixed.
        try await waitUntil("expected the shipped client's own events stream to deliver the user_message cleanly (no gap)") {
            eventSink.items.contains {
                $0.sessionID == sid && $0.json["type"]?.stringValue == "user_message"
                    && $0.json["text"]?.stringValue == promptText
            }
        }
        XCTAssertTrue(gapSink.items.isEmpty, "no GapSignal on the basic attach→see-messages flow — filtered-seq forward jumps are benign")

        // ---- REAL approval leg: a Mac-side peripheral.lease under an "ask" policy, resolved
        // through the phone's OWN pendingApprovals/answerApproval — never a scripted broker. ----
        let provider = try await harnessClient(daemon, name: "conformance-provider")
        _ = try await provider.request("peripheral.advertise", params: .object([
            "classes": .array([.object(["class": .string("screenshot"), "tccGranted": .bool(true)])]),
        ]))

        let requester = try await harnessClient(daemon, name: "conformance-requester")
        let created = try await requester.request("session.create", params: .object([
            "scope": .string("conformance"), "approvalPolicy": .string("ask"),
        ]))
        guard let approvalSid = created["sessionId"]?.stringValue else {
            return XCTFail("session.create must return a sessionId")
        }

        // Move THIS SAME phone connection's live attach over to the approval session — awaited
        // (not fired-and-forgotten), so the gateway's own attach (replay-then-drain-held-live, per
        // Gateway.swift's `session.attach` special-case) has fully landed before anything can be
        // requested on this session.
        _ = try await client.send(method: "session.attach", params: .object([
            "sessionId": .string(approvalSid), "fromSeq": .number(0),
        ]))
        // The SAME independent-observer pattern as the prompt leg above — immune to this file's
        // documented gap finding, so it reliably proves the REAL event lifecycle landed.
        let approvalVerifier = try await harnessClient(daemon, name: "approval-verifier")
        _ = try await approvalVerifier.attach(sessionId: approvalSid, fromSeq: 0)
        let (approvalVerifierSink, approvalVerifierTask) = drain(approvalVerifier.events)
        defer { approvalVerifierTask.cancel() }

        // Fired, not awaited yet: `peripheral.lease` blocks (on the REAL `ApprovalBroker.wait`)
        // until `approval.respond` answers it, exactly mirroring packages/core's own
        // `test/peripheral/e2e.test.ts` "ask policy raises an approval card" sequence — the ONLY
        // difference here is that the answering side is the PHONE, over `NormaSessionClient`,
        // instead of the same harness connection that requested the lease.
        async let leaseResult = requester.request("peripheral.lease", params: .object([
            "sessionId": .string(approvalSid), "class": .string("screenshot"),
        ]))

        // approval.list (NormaSessionClient.pendingApprovals) — a genuine RPC query against the
        // REAL `ApprovalBroker.list()`, never dependent on the push-event path — is how the phone
        // discovers the pending approval, exactly as T4b's own doc comment intends ("pending
        // approvals age out of the retained log" is the SAME reason it queries live state rather
        // than reconstructing from events; that queryable-state design is what makes this leg
        // provable at all despite this file's documented gap finding).
        let pendingEntry = try await waitForPendingApproval(client, sessionID: approvalSid)
        guard let callID = pendingEntry["callId"]?.stringValue else {
            return XCTFail("expected approval.list's pending entry to carry a callId")
        }
        XCTAssertEqual(pendingEntry["toolName"]?.stringValue, "peripheral.lease")

        let state = try await client.answerApproval(ApprovalAnswer(
            sessionID: approvalSid, callID: callID, approved: true, commandID: "conformance-approve-1", expiresAt: nil
        ))
        XCTAssertEqual(state, .hostAccepted, "a fresh, never-before-answered approval must be accepted by the real broker")

        // The real broker actually granted the lease once approved — proves the phone's answer
        // (via the REAL `approval.respond` RPC) genuinely unblocked the Mac-side `peripheral.lease`
        // await, not just that a reply was sent.
        let lease = try await leaseResult
        XCTAssertNotNil(lease["leaseId"]?.stringValue, "the real broker must grant the lease once the phone approves it")

        // Independent confirmation that the FULL real event lifecycle (request -> resolve) landed,
        // via the observer immune to this file's documented gap finding.
        try await waitUntil("expected the independent verifier to observe the REAL approval_requested") {
            approvalVerifierSink.items.contains {
                if case .session(.approvalRequested(let a)) = $0 { return a.sessionId == approvalSid && a.callId == callID }
                return false
            }
        }
        try await waitUntil("expected the independent verifier to observe the REAL approval_resolved") {
            approvalVerifierSink.items.contains {
                if case .session(.approvalResolved(let a)) = $0 { return a.sessionId == approvalSid && a.callId == callID && a.approved }
                return false
            }
        }
        // Same clean-streaming proof on the re-attached approval session: the approval_requested
        // content event streams through the shipped client itself, and the gaps channel stays
        // silent across BOTH legs (it now signals only liveBuffer overflow).
        try await waitUntil("expected the shipped client's own events stream to deliver approval_requested cleanly (no gap)") {
            eventSink.items.contains {
                $0.sessionID == approvalSid && $0.json["type"]?.stringValue == "approval_requested"
                    && $0.json["callId"]?.stringValue == callID
            }
        }
        XCTAssertTrue(gapSink.items.isEmpty, "client.gaps must stay silent across both legs — filtered-seq forward jumps never gap")

        await provider.close()
        await requester.close()
        await verifier.close()
        await approvalVerifier.close()
    }

    // MARK: - iOS remote-path T1+T2: streaming, opaque state, and the frame cliff — on the wire

    /// **The end-to-end proof for the whole iOS remote path, and the tripwire for both of its
    /// tasks.** Everything below runs through production code: a REAL daemon with a REAL
    /// `AgentEngine` (only the `Provider` is injected — `RealDaemon.streamingProviderFixture`), a
    /// REAL pairing ceremony, the REAL `Gateway` over a REAL iroh QUIC link, into the shipped
    /// `NormaSessionClient`. Nothing between the provider and the phone is faked.
    ///
    /// It exists because NOTHING in either suite covered a transient event traversing the gateway,
    /// and that hole hid two bugs at once:
    ///
    ///  * **T1 (client).** `hub.broadcastTransient` stamps an `assistant_delta` with the store's
    ///    CURRENT `lastSeq` — the seq of the last event actually APPENDED, never one of its own — so
    ///    a burst of deltas all share ONE seq. The phone client deduped on `seq <= cursor`, so the
    ///    first delta advanced the cursor onto that shared seq and every delta after it was dropped
    ///    at `seq == cursor`. Pre-T1 this test sees 1 of 7 chunks; post-T1, all 7.
    ///  * **T2 (daemon).** The obvious way to write T2's live-stream allowlist — reuse
    ///    `HISTORY_EVENT_TYPES` — drops `assistant_delta` entirely, because history governs
    ///    PERSISTED replay and transients are never persisted. That would have re-broken streaming
    ///    one hop UPSTREAM of the client just fixed, with a fully green suite. Here it is 0 of 7.
    ///
    /// It also pins T2's two guarantees on the real wire: the opaque `reasoning_item` the engine
    /// persists mid-turn never reaches the phone, and a >1 MiB event does not silently kill the
    /// connection (`LengthPrefix.unwrap` throws `.oversize` → `IrohConn.readLoop` `cont.finish()`es
    /// the phone's inbound stream → reconnect, with nothing logged anywhere — the reported "it
    /// reconnects every time I open a chat"). Uncapped, the oversized chunk ends this connection and
    /// the assertions after it never see their events.
    ///
    /// Honest note on the reasoning half: the Swift stack was ALREADY accidentally safe there —
    /// `apple/NormaProtocol` has no `reasoningItem` variant, so `NormaClient` yields `.unknownEvent`
    /// and the gateway's `guard case .session` drops it. That accident evaporates the moment someone
    /// mirrors the variant into Swift, which is exactly what CLAUDE.md's protocol checklist tells
    /// them to do. The RED evidence for that hole is `remote-live-stream.test.ts` at the daemon
    /// seam, where the leak is real for every remote client; this assertion pins the end-to-end
    /// guarantee so the Swift-side accident can never become the only thing holding it up.
    func testStreamingDeltasReachThePhone_OpaqueStateDoesNot_AndAnOversizedEventDoesNotKillTheLink() async throws {
        let daemon = try await RealDaemon.start(fixtureOverride: RealDaemon.streamingProviderFixture)
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon)

        let secret = SecretKey.generate().toBytes()
        let accepted = try await pairPhone(setup: setup, secret: secret)
        let phoneEndpointID = try SecretKey.fromBytes(bytes: secret).public().description
        let conn = try await IrohDialer.dialInternal(
            secret: secret, macEndpointID: setup.macEndpointID, alpn: IrohListener.defaultALPN,
            relayURLs: [], addrOverride: setup.irohListener.endpointAddr
        )
        let client = NormaSessionClient(
            conn: conn, hostID: phoneEndpointID, epoch: accepted.epoch, cursors: InMemoryCursorStore(),
            clientInstanceID: "norma-fake-phone", clock: { Int(Date().timeIntervalSince1970 * 1000) },
            idgen: { UUID().uuidString }
        )
        let (eventSink, eventTask) = drain(client.events)
        defer { eventTask.cancel() }
        let (gapSink, gapTask) = drain(client.gaps)
        defer { gapTask.cancel() }

        _ = try await client.handshake(resumes: [])
        let dispatchResult = try await client.send(method: "session.dispatch", params: .object([:]))
        guard let sid = dispatchResult["sessionId"]?.stringValue else {
            return XCTFail("session.dispatch must return a sessionId")
        }
        _ = try await client.send(method: "session.attach", params: .object([
            "sessionId": .string(sid), "fromSeq": .number(0),
        ]))
        _ = try await client.send(method: "session.send", params: .object([
            "sessionId": .string(sid), "text": .string("stream me something"),
        ]))

        func received(_ type: String) -> [SessionEnvelope] {
            eventSink.items.filter { $0.sessionID == sid && $0.json["type"]?.stringValue == type }
        }

        // `turn_completed` is the turn's terminal PERSISTED event — waiting on it (not on the
        // deltas) means a missing delta fails as a mismatch, never as a timeout, AND it is what
        // proves the link survived the oversized chunk that preceded it.
        try await waitUntil(timeout: 30, "the turn to complete on the phone's own event stream") {
            !received("turn_completed").isEmpty
        }

        // ---- T1: every streamed chunk crossed the wire ----
        let deltas = received("assistant_delta")
        XCTAssertEqual(deltas.count, RealDaemon.streamedChunks.count + 1,
                       "every assistant_delta must reach the phone (the six small chunks + the big one). Pre-T1 only the FIRST survived the client's seq dedupe; a history-allowlist live filter would have delivered NONE.")
        XCTAssertEqual(deltas.prefix(RealDaemon.streamedChunks.count).map { $0.json["delta"]?.stringValue ?? "" },
                       RealDaemon.streamedChunks, "deltas arrive in provider order, unmodified")

        // The shape that makes the above a genuine regression test rather than a happy path: a
        // delta's seq is BORROWED from the store's head, never its own, so a run of deltas repeats
        // one seq. Whatever the first of them does to a client's cursor, every one after it arrives
        // at `seq == cursor` — the case a naive `seq <= cursor` dedupe drops 100% of the time.
        // (The 7th delta's seq differs from the first six precisely because the `reasoning_item`
        // the engine persisted between them moved the store's head — a borrowed seq tracks the LOG,
        // not the stream.)
        let smallDeltaSeqs = Set(deltas.prefix(RealDaemon.streamedChunks.count).compactMap { $0.seq })
        XCTAssertEqual(smallDeltaSeqs.count, 1,
                       "the six chunks streamed before the mid-turn reasoning_item all share the store's head seq — that is what makes `seq == cursor` the norm, not an edge case")
        XCTAssertGreaterThanOrEqual(deltas.count - Set(deltas.compactMap { $0.seq }).count, 5,
                                    "at least five deltas repeated a seq an earlier delta already delivered — i.e. arrived at `seq == cursor`")

        // ---- T2a: the opaque provider state stayed on the Mac ----
        XCTAssertTrue(received("reasoning_item").isEmpty,
                      "reasoning_item wraps the provider's opaque encrypted_content — the session JSONL is its only sink (CLAUDE.md)")
        let everySessionEnvelope = eventSink.items.map { String(describing: $0.json) }.joined()
        XCTAssertFalse(everySessionEnvelope.contains(RealDaemon.streamedReasoningSecret),
                       "the opaque payload must not appear on the phone's wire under ANY event type")

        // ---- T2b: the >1 MiB event was capped, and the link survived it ----
        // Reaching this line at all is most of the proof: `turn_completed` is emitted AFTER the
        // oversized assistant_message, so an uncapped frame would have ended the phone's inbound
        // stream before it ever arrived.
        let messages = received("assistant_message")
        XCTAssertEqual(messages.count, 1, "the canonical assistant_message must still arrive after the oversized chunk")
        for env in eventSink.items {
            let size = (try? JSONEncoder().encode(env.json).count) ?? 0
            XCTAssertLessThan(size, 1 << 20, "no event may reach the phone at or past the transport's hard 1 MiB frame limit — oversize is a SILENT connection kill, not an error")
        }
        XCTAssertTrue(gapSink.items.isEmpty, "no GapSignal across a full streamed turn")
    }

    // MARK: - iOS remote-path T6b: live forwarding follows the ATTACH, not the connection

    /// One phone, two connections, ONE `clientInstanceID` — production shape since the iOS
    /// connection pool landed (T6). `PhoneClientInstanceID.stable()` mints exactly one install-wide
    /// id, and every connection the app opens carries it: the pool's short-lived SHELL connection
    /// (`session.list` / `sync.*` / `session.create`, always a resume-less handshake) and a
    /// `CodeSessionModel`'s own long-lived attached connection. Both therefore land on the SAME
    /// `Gateway.PhoneSession`.
    private func dialPhone(
        setup: TestSetup, secret: Data, epoch: Int, installID: String,
        heartbeat: HeartbeatConfig
    ) async throws -> NormaSessionClient {
        let phoneEndpointID = try SecretKey.fromBytes(bytes: secret).public().description
        let conn = try await IrohDialer.dialInternal(
            secret: secret, macEndpointID: setup.macEndpointID, alpn: IrohListener.defaultALPN,
            relayURLs: [], addrOverride: setup.irohListener.endpointAddr
        )
        return NormaSessionClient(
            conn: conn, hostID: phoneEndpointID, epoch: epoch, cursors: InMemoryCursorStore(),
            clientInstanceID: installID, clock: { Int(Date().timeIntervalSince1970 * 1000) },
            idgen: { UUID().uuidString }, heartbeat: heartbeat
        )
    }

    private func sawUserMessage(_ sink: Sink<SessionEnvelope>, sessionID: String, text: String) -> Bool {
        sink.items.contains {
            $0.sessionID == sessionID && $0.json["type"]?.stringValue == "user_message"
                && $0.json["text"]?.stringValue == text
        }
    }

    /// An aggressive keepalive: two unanswered pings kill the connection inside ~900 ms, so the
    /// "and its keepalive still succeeds" half of the assertion below is real, not nominal — the
    /// shipped watchdog genuinely runs several full ping cycles during the quiet window.
    private static let twitchyHeartbeat = HeartbeatConfig(quietMs: 300, secondWindowMs: 300, graceMs: 300, tickMs: 50)

    /// **T6b RED — the diagnostic combination.** `Gateway` used to re-point
    /// `PhoneSession.currentConn` on EVERY hello, while `liveSessionID` was only ever written from
    /// `resumes.last`. So any resume-less shell round trip on a second connection from the same
    /// phone (mode entry, a session-list refresh, a post-turn chat sync, opening the drawer) moved
    /// the live-forwarding target off an attached session's connection — and, because
    /// `handleLiveFrame` answers `.ping` with `.pong` on WHATEVER connection it arrives on, the
    /// orphaned session's keepalive kept succeeding and the phone never learned it had been
    /// orphaned. The session looked perfectly connected and simply went quiet.
    ///
    /// That pairing is the whole bug: silence ALONE would look like a stall, and a dead keepalive
    /// alone would just reconnect. Both assertions therefore live in one test — the second is what
    /// makes the first non-recoverable.
    ///
    /// (This is the SILENCE half of the user's report. The visible "it reconnects every time"
    /// half is the oversize-frame kill fixed in T2 and pinned by
    /// `testStreamingDeltasReachThePhone_...` above — different symptom, different bug, both real.)
    func testResumelessShellHandshakeDoesNotStealLiveForwarding_WhileTheOrphanedSessionKeepsPonging() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon)

        let secret = SecretKey.generate().toBytes()
        let accepted = try await pairPhone(setup: setup, secret: secret)
        let installID = "norma-ios-install-6b"

        // ---- The session connection: handshake, dispatch, attach, and prove events flow ----
        let sessionClient = try await dialPhone(
            setup: setup, secret: secret, epoch: accepted.epoch, installID: installID,
            heartbeat: Self.twitchyHeartbeat
        )
        let (sessionEvents, sessionEventTask) = drain(sessionClient.events)
        defer { sessionEventTask.cancel() }

        _ = try await sessionClient.handshake(resumes: [])
        let dispatched = try await sessionClient.send(method: "session.dispatch", params: .object([:]))
        guard let sid = dispatched["sessionId"]?.stringValue else {
            return XCTFail("session.dispatch must return a sessionId")
        }
        _ = try await sessionClient.send(method: "session.attach", params: .object([
            "sessionId": .string(sid), "fromSeq": .number(0),
        ]))

        let before = "before the shell round trip"
        _ = try await sessionClient.send(method: "session.send", params: .object([
            "sessionId": .string(sid), "text": .string(before),
        ]))
        try await waitUntil("baseline: an attached session receives its own live events") {
            self.sawUserMessage(sessionEvents, sessionID: sid, text: before)
        }

        // ---- The resume-less shell round trip: exactly what the iOS pool does, on its own conn ----
        let shellClient = try await dialPhone(
            setup: setup, secret: secret, epoch: accepted.epoch, installID: installID,
            heartbeat: .disabled
        )
        let (shellEvents, shellEventTask) = drain(shellClient.events)
        defer { shellEventTask.cancel() }
        _ = try await shellClient.handshake(resumes: [])   // resume-less — the trigger
        let shellList = try await shellClient.send(method: "session.list", params: .object([:]))
        XCTAssertNotNil(shellList["sessions"]?.arrayValue, "the shell round trip itself must still work")

        // ---- Half 1 of the signature: the orphaned session's keepalive still succeeds ----
        // Three quiet seconds with `twitchyHeartbeat` running: the watchdog pings, and only a
        // gateway that keeps ponging this connection stops it closing. If it closed, `send` below
        // throws `.connectionClosed` — i.e. the phone WOULD have noticed and reconnected, and this
        // bug would have been found years ago.
        try await Task.sleep(nanoseconds: 3_000_000_000)
        do {
            _ = try await sessionClient.send(method: "session.list", params: .object([:]))
        } catch {
            XCTFail("the attached session's connection must still be alive and answering — got \(error)")
        }

        // ---- Half 2: ...and yet it receives nothing. That is the bug. ----
        let after = "after the shell round trip"
        _ = try await sessionClient.send(method: "session.send", params: .object([
            "sessionId": .string(sid), "text": .string(after),
        ]))
        try await waitUntil(timeout: 15, "the attached session must STILL receive live events after another connection's RESUME-LESS handshake — a shell round trip must not steal the forwarding target") {
            self.sawUserMessage(sessionEvents, sessionID: sid, text: after)
        }
        XCTAssertFalse(self.sawUserMessage(shellEvents, sessionID: sid, text: after),
                       "an attached session's live events must never be forwarded to a resume-less shell connection that never asked for them")
    }

    /// **T6b RED — the probe path.** `probeExistingConnection` (iOS, the foreground hop) confirms a
    /// kept connection by sending `session.attach` on it. The gateway's `session.attach` rpc branch
    /// set `liveSessionID` but never re-pointed the forwarding target, so the probe answered
    /// `alive == true` while delivery stayed dead — the phone re-confirmed itself healthy and only a
    /// real transport death, `NWPathMonitor` or a relaunch ever recovered it. (And
    /// `seedHistoryIfNeeded` never runs from that path, so nothing backfilled either.)
    ///
    /// The discriminating shape: a SECOND connection legitimately attaches to the same session and
    /// takes live forwarding (last attach wins — one daemon client, one attach). The first
    /// connection then probes exactly as the foreground hop does, and must take forwarding back.
    /// Pre-fix the probe succeeds and the events keep going to the other connection.
    func testLiveAttachRepointsForwardingToItsOwnConnection_TheProbeTheForegroundHopSends() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon)

        let secret = SecretKey.generate().toBytes()
        let accepted = try await pairPhone(setup: setup, secret: secret)
        let installID = "norma-ios-install-6b-probe"

        let first = try await dialPhone(setup: setup, secret: secret, epoch: accepted.epoch, installID: installID, heartbeat: .disabled)
        let (firstEvents, firstTask) = drain(first.events)
        defer { firstTask.cancel() }
        _ = try await first.handshake(resumes: [])
        let dispatched = try await first.send(method: "session.dispatch", params: .object([:]))
        guard let sid = dispatched["sessionId"]?.stringValue else {
            return XCTFail("session.dispatch must return a sessionId")
        }
        _ = try await first.send(method: "session.attach", params: .object([
            "sessionId": .string(sid), "fromSeq": .number(0),
        ]))

        // A second connection from the same install attaches to the same session and legitimately
        // takes live forwarding.
        let second = try await dialPhone(setup: setup, secret: secret, epoch: accepted.epoch, installID: installID, heartbeat: .disabled)
        let (secondEvents, secondTask) = drain(second.events)
        defer { secondTask.cancel() }
        _ = try await second.handshake(resumes: [])
        _ = try await second.send(method: "session.attach", params: .object([
            "sessionId": .string(sid), "fromSeq": .number(0),
        ]))
        let toSecond = "belongs to the second connection"
        _ = try await second.send(method: "session.send", params: .object([
            "sessionId": .string(sid), "text": .string(toSecond),
        ]))
        try await waitUntil("the most recent attach owns live forwarding") {
            self.sawUserMessage(secondEvents, sessionID: sid, text: toSecond)
        }

        // The foreground hop's probe, verbatim: `session.attach` on the kept connection. It reports
        // healthy — and must actually BE healthy, i.e. take forwarding back.
        let probed = try await first.send(method: "session.attach", params: .object([
            "sessionId": .string(sid), "fromSeq": .number(0),
        ]))
        XCTAssertNotNil(probed["lastSeq"]?.intValue, "the probe reports alive — that half was never broken")

        let toFirst = "belongs to the probing connection"
        _ = try await first.send(method: "session.send", params: .object([
            "sessionId": .string(sid), "text": .string(toFirst),
        ]))
        try await waitUntil(timeout: 15, "a live session.attach must re-point live forwarding at the connection it arrived on — otherwise a foreground-hop probe answers `alive` while delivering nothing") {
            self.sawUserMessage(firstEvents, sessionID: sid, text: toFirst)
        }
    }

    /// SP3.1 T1 (the whole point): a REAL revoke, reached through the REAL router/gateway stack, must
    /// surface on the shipped `NormaSessionClient` as a TYPED `.handshakeRejected` with a re-pair code
    /// — the signal the iOS app maps to its honest `.revoked` state — NOT a bare `connectionClosed`/
    /// timeout (which the SP3 whole-branch review found collapsed to `.macUnavailable`, making the
    /// honest state unreachable from a real revoke). Pre-fix, the router sent a raw-JSON `PairRejected`
    /// the client couldn't decode → it saw only the close → `.connectionClosed`. This test genuinely
    /// DISCRIMINATES: it fails on any non-`.handshakeRejected` outcome.
    ///
    /// The observed code is `not_paired` (not `revoked`): `RemoteHost.revoke` REMOVES the
    /// `PairingStore` record, so the reconnect is bounced by the router's membership gate
    /// (`sendNotPairedRejection`) before it ever reaches the gateway's `revoked`-set — exactly the
    /// task brief's own note. Either re-pair code is asserted as acceptable.
    func testRealRevoke_ReconnectSurfacesTypedHandshakeRejection() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon)

        let secret = SecretKey.generate().toBytes()
        let accepted = try await pairPhone(setup: setup, secret: secret)
        XCTAssertEqual(accepted.epoch, 1)
        let phoneEndpointID = try SecretKey.fromBytes(bytes: secret).public().description

        // Revoke: removes the PairingStore record AND tears down the gateway footprint (the real
        // production revoke, `RemoteHost.revoke` → store.revoke + gateway.revoke(peerID:)). The
        // pairing window is already closed (pairPhone closes it), so the reconnect below hits the
        // router's not_paired path, not the ceremony.
        try await setup.host.revoke(phoneEndpointID: phoneEndpointID)

        // Reconnect through the SAME production entry points a real phone uses: IrohDialer.dial ->
        // NormaSessionClient (identical to the conformance test above), a fresh conn on the same
        // iroh identity, carrying the accepted epoch.
        let conn = try await IrohDialer.dialInternal(
            secret: secret, macEndpointID: setup.macEndpointID, alpn: IrohListener.defaultALPN,
            relayURLs: [], addrOverride: setup.irohListener.endpointAddr
        )
        let client = NormaSessionClient(
            conn: conn, hostID: phoneEndpointID, epoch: accepted.epoch, cursors: InMemoryCursorStore(),
            clientInstanceID: "norma-fake-phone", clock: { Int(Date().timeIntervalSince1970 * 1000) },
            idgen: { UUID().uuidString }, firstFrameDeadline: 15
        )

        do {
            _ = try await client.handshake(resumes: [])
            XCTFail("a revoked phone's handshake must be refused with a typed rejection, not admitted")
        } catch let error as SessionClientError {
            guard case .handshakeRejected(let code, _) = error else {
                return XCTFail("expected .handshakeRejected — got \(error). A bare close/timeout means the honest .revoked state is STILL unreachable from a real revoke (the pre-SP3.1 bug).")
            }
            let rePairCodes = [HandshakeRejectionCode.notPaired.rawValue, HandshakeRejectionCode.revoked.rawValue, HandshakeRejectionCode.staleEpoch.rawValue]
            XCTAssertTrue(rePairCodes.contains(code), "expected a re-pair code (the app maps it to .revoked); got \(code)")
        }
    }
}

private struct FakePhoneConformanceError: Error, CustomStringConvertible {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { "FakePhoneConformanceError: \(message)" }
}
