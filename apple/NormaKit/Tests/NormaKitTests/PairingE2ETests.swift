import XCTest
import os
import NormaProtocol
import IrohLib
@testable import NormaKit

/// SP2b Task 4 (the capstone): prove the WHOLE stack — `RemoteHost` (the composition root) driving
/// a real `IrohListener` (loopback, relay disabled) + `PairingRouter` + `PairingManager` + `Gateway`
/// against a REAL bun daemon (`RealDaemon`) — with a genuine in-process iroh "phone" running the
/// actual pairing ceremony crypto (`PairingCrypto`, NormaProtocol) end-to-end. Every earlier test
/// left at least one piece of this out: `IrohE2ETests` never runs a ceremony (dev-stub "accept any
/// peer" wiring, no `PairingRouter`); `PairingManagerTests`/`PairingRouterTests` never touch real
/// iroh or a real daemon. This file is the first place the WHOLE SP2b stack is genuine at once.
///
/// Four scenarios (a-d), matching the task brief. No sleeps used as WAIT conditions — every
/// expected frame is read via `PhoneConn.expectFrame()`/`expectRawFrame()`, bounded by the same
/// wall-clock `withTimeout` idiom `IrohE2ETests` established (iroh-ffi's generated async calls
/// ignore Swift task cancellation).
final class PairingE2ETests: XCTestCase {

    // MARK: - Shared setup

    private func makeRelayConfig() -> SignedRelayConfig {
        SignedRelayConfig(config: RelayConfig(version: 1, relays: ["relay1.norma.dev"]), sig: Data(repeating: 7, count: 64))
    }

    private func tempStoreDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-pairing-e2e-tests-\(UUID().uuidString)", isDirectory: true)
    }

    /// Captures the `IrohListener` `RemoteHost.start()` binds via the `#if DEBUG` `makeListener`
    /// hook — needed so the test can dial it directly (`PhoneConn.dial` needs a concrete
    /// `IrohListener` for its `endpointAddr`; `RemoteHost` itself never exposes the listener object,
    /// only `macEndpointID`). `@unchecked Sendable`/`OSAllocatedUnfairLock`: matches this test
    /// target's existing double convention.
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
    }

    /// Builds a `RemoteHost` wired against a REAL `RealDaemon` and a REAL (loopback) `IrohListener`
    /// — the `#if DEBUG` hooks stand in ONLY for what production reads from the Keychain/binds
    /// without a pinned address; everything downstream (`PairingRouter`, `PairingManager`,
    /// `Gateway`) is the real, unmodified production wiring.
    @MainActor
    private func makeHost(daemon: RealDaemon) async throws -> TestSetup {
        let secretStore = InMemoryEndpointSecretStore()
        let identity = try MacIdentity.loadOrCreate(store: secretStore)
        let listenerBox = ListenerBox()
        let config = RemoteHost.Config(
            storeDir: tempStoreDir(), socketPath: daemon.socketPath, hostLabel: "E2E Mac",
            relayConfig: makeRelayConfig(), relayURLs: []
        )
        let host = RemoteHost(
            config: config,
            secretStore: secretStore,
            makeListener: {
                // Loopback + disabled relay (the same hermetic pattern `IrohE2ETests` uses) — a
                // wildcard bind is non-deterministic in a sandboxed test environment.
                let listener = try await IrohListener.start(secret: identity.secret, relayURLs: [], bindAddr: "127.0.0.1:0")
                listenerBox.value = listener
                return listener
            },
            makeDaemonFactory: {
                NormaClient(makeTransport: { UnixSocketTransport(path: daemon.socketPath) }, token: daemon.remoteToken, clientName: "iphone-gateway")
            }
        )
        // Force-starts (even at zero paired devices) so the listener is bound before the caller
        // dials anything.
        _ = try await host.openPairingWindow()
        guard let irohListener = listenerBox.value else {
            throw PairingE2EError("makeListener never ran — RemoteHost.start() didn't bind a listener")
        }
        // T4 review fix 4: pin the derivation. `RemoteHost.macEndpointID` is computed from the
        // identity secret (`SecretKey.fromBytes(...).public()`) rather than read off the bound
        // listener — assert, against the REAL listener, that the two can never silently diverge
        // (e.g. a future iroh release changing how an endpoint's id derives from its secret key).
        XCTAssertEqual(
            host.macEndpointID, irohListener.endpointID.description,
            "RemoteHost's derived macEndpointID must equal the bound iroh listener's actual endpoint id"
        )
        return TestSetup(host: host, irohListener: irohListener)
    }

    private func decodeBody(_ e: WireEnvelope) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: e.payload)
    }

    /// Runs one full pairing ceremony against an ALREADY-OPEN pairing window (the caller opened it
    /// via `makeHost`/a prior `host.openPairingWindow()`), for a phone identified by `secret`.
    /// SP2b Task 5: the phone side now goes through the REAL `PhonePairingClient` (this package's
    /// production phone-ceremony implementation) instead of hand-rolled transcript/proof/
    /// `PairRequest` frames — `addrOverride: setup.irohListener.endpointAddr` is the SAME
    /// test-only seam `PhonePairingClientTests` uses (production has no relay/discovery wired
    /// yet — SP2b T6 — so a hermetic test has nothing else to dial through). `PhonePairingClient`
    /// closes its own ceremony connection before returning (single-use, matches the OLD
    /// `ceremonyPhone.closeConnection()/closeDialer()` this replaces) — the caller dials a FRESH
    /// `PhoneConn` (same `secret`) for anything post-pairing, mirroring a real phone hanging up
    /// and reconnecting once accepted (brief scenario (a)'s own "phone reconnects").
    @MainActor
    private func pairPhone(setup: TestSetup, secret: Data, label: String = "iPhone") async throws -> PairAccepted {
        guard let manager = setup.host.pairingManager else {
            throw PairingE2EError("pairPhone requires an already-open pairing window")
        }
        let qr = await manager.beginPairing()
        var events = manager.events.makeAsyncIterator()

        async let phoneResult = PhonePairingClient.pairInternal(
            qr: qr, bindAddr: nil, secret: secret, addrOverride: setup.irohListener.endpointAddr,
            onWords: { _ in }
        )

        guard case .requestReceived(let macWords, _) = await events.next() else {
            throw PairingE2EError("expected requestReceived")
        }

        await manager.confirm(label: label)
        guard case .completed = await events.next() else {
            throw PairingE2EError("expected completed")
        }

        let (accepted, phoneWords, _) = try await phoneResult
        XCTAssertEqual(phoneWords, macWords, "the SAS words the Mac would show a human must match the phone's own computation")

        await setup.host.closePairingWindow()
        return accepted
    }

    // MARK: - Scenario (a): full ceremony -> reconnect -> session.list works

    func testScenarioA_FullCeremony_PhoneReconnectsThenSessionListWorks() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon)

        let secret = SecretKey.generate().toBytes()
        let accepted = try await pairPhone(setup: setup, secret: secret)
        XCTAssertEqual(accepted.epoch, 1)
        XCTAssertEqual(accepted.grantedCaps, ["sessions"])

        // The phone hangs up after PairAccepted and reconnects — a FRESH connection, same iroh
        // identity, now carrying the accepted epoch.
        let phone = try await PhoneConn.dial(listener: setup.irohListener, epoch: accepted.epoch, secret: secret)
        defer { phone.closeConnection(); phone.closeDialer() }

        try await phone.sendHello(clientInstanceID: "phone-a", resumes: [])
        let ack = try await phone.expectFrame()
        XCTAssertEqual(ack.kind, .helloAck, "a freshly-paired phone must be admitted by the router straight through to the gateway")

        try await phone.sendRpcRequest(id: 1, method: "session.list", params: nil)
        let resp = try await phone.expectFrame()
        XCTAssertEqual(resp.kind, .rpcResponse)
        XCTAssertNil(try decodeBody(resp)["error"], "session.list must succeed for a newly-paired phone over the real daemon")
    }

    // MARK: - Scenario (b): unpaired dialer, window closed -> not_paired then EOF

    func testScenarioB_UnpairedDialerWithWindowClosed_ObservesNotPairedThenEOF() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon)
        // `makeHost` opens a window to force-start; close it — nobody has paired anything, so the
        // host stays running (per `RemoteHost`'s own "closePairingWindow doesn't auto-stop"
        // design) with the window now genuinely closed.
        await setup.host.closePairingWindow()

        let strangerSecret = SecretKey.generate().toBytes()
        let stranger = try await PhoneConn.dial(listener: setup.irohListener, secret: strangerSecret)
        defer { stranger.closeDialer() }

        // The router's membership/window verdict is already fixed the moment the connection is
        // accepted (by `peerID` alone) — but per `sendNotPairedRejection`'s own doc comment, it
        // still waits for the phone to send SOMETHING first (a real iroh constraint: the
        // ACCEPTING side can't reliably `send()` before the OPENING side has). A real phone always
        // speaks first anyway (the wire protocol's own convention), so this is exactly what one
        // would send not yet knowing it's unpaired.
        try await stranger.sendRaw(Data("client-hello-stand-in".utf8))
        let rejectedData = try await stranger.expectRawFrame()
        let rejected = try JSONDecoder().decode(PairRejected.self, from: rejectedData)
        XCTAssertEqual(rejected.type, "pair_rejected")
        XCTAssertEqual(rejected.code, "not_paired")

        let eof = try await stranger.readNext(timeout: 10)
        guard case .closed = eof else {
            return XCTFail("expected the connection to close after the rejection, got \(eof)")
        }
    }

    // MARK: - Scenario (c): revoke while streaming -> conn closes; reconnect + resume both refused

    func testScenarioC_RevokeWhileStreaming_ClosesConn_ReconnectAndResumeBothRefused() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon)

        let secret = SecretKey.generate().toBytes()
        let phoneEndpointID = try PhoneConn.peerID(forSecret: secret)
        let accepted = try await pairPhone(setup: setup, secret: secret)

        let phone = try await PhoneConn.dial(listener: setup.irohListener, epoch: accepted.epoch, secret: secret)
        defer { phone.closeConnection(); phone.closeDialer() }
        try await phone.sendHello(clientInstanceID: "phone-c", resumes: [])
        let ack = try await phone.expectFrame()
        XCTAssertEqual(ack.kind, .helloAck)

        // Prove it's genuinely "streaming": a session.list round trip while paired and connected.
        try await phone.sendRpcRequest(id: 1, method: "session.list", params: nil)
        let listResp = try await phone.expectFrame()
        XCTAssertEqual(listResp.kind, .rpcResponse)

        try await setup.host.revoke(phoneEndpointID: phoneEndpointID)

        // The live connection must actually drop (Gateway.revoke(peerID:)'s own fan-out).
        let closedResult = try await phone.readNext(timeout: 10)
        guard case .closed = closedResult else {
            return XCTFail("revoke must drop the phone's live connection, got \(closedResult)")
        }

        // A reconnect attempt (same iroh identity, no re-pair) never reaches the GATEWAY's own
        // ClientHello/resume machinery at all — `PairingRouter` refuses it as `not_paired`,
        // since `RemoteHost.revoke` removed the `PairingStore` record entirely, regardless of
        // what the phone's own hello asks for. Send an actual resume-carrying hello (not just any
        // bytes) to prove the "resume after revoke is refused" half directly: the router reads it
        // (routing policy needs SOMETHING to arrive first — see `sendNotPairedRejection`'s own doc
        // comment) but never hands it to Gateway/resume machinery at all.
        let reconnect = try await PhoneConn.dial(listener: setup.irohListener, secret: secret)
        defer { reconnect.closeDialer() }
        try await reconnect.sendHello(clientInstanceID: "phone-c", resumes: [
            StreamResume(sessionID: "whatever-session", streamID: "whatever-session", lastAppliedSeq: 0),
        ])
        let rejectedData = try await reconnect.expectRawFrame()
        let rejected = try JSONDecoder().decode(PairRejected.self, from: rejectedData)
        XCTAssertEqual(rejected.code, "not_paired")
        let eof = try await reconnect.readNext(timeout: 10)
        guard case .closed = eof else {
            return XCTFail("expected the reconnect to close after the rejection, got \(eof)")
        }
    }

    // MARK: - Scenario (d): epoch mismatch — revoke, re-pair (epoch bumps), replay of the OLD epoch is refused

    func testScenarioD_EpochMismatchAfterRevokeAndRepair_RefusedByGateway() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon)

        let secret = SecretKey.generate().toBytes()
        let phoneEndpointID = try PhoneConn.peerID(forSecret: secret)
        let firstAccept = try await pairPhone(setup: setup, secret: secret)
        XCTAssertEqual(firstAccept.epoch, 1)

        try await setup.host.revoke(phoneEndpointID: phoneEndpointID)

        // Re-pair the SAME phone — `PairingStore.add` (via `PairingManager.confirm`) bumps the
        // epoch past whatever a future revoke last remembered, so this MUST come back as 2.
        _ = try await setup.host.openPairingWindow()
        let secondAccept = try await pairPhone(setup: setup, secret: secret, label: "iPhone (re-paired)")
        XCTAssertEqual(secondAccept.epoch, 2)

        // The phone is a MEMBER again (re-paired) — the router forwards it straight to Gateway —
        // but this ClientHello replays the OLD (now-stale) epoch, exactly the scenario the task
        // brief calls out: "gateway refuses (wire decode expectedEpoch now comes from the CURRENT
        // record)".
        let staleReplay = try await PhoneConn.dial(listener: setup.irohListener, epoch: firstAccept.epoch, secret: secret)
        defer { staleReplay.closeConnection(); staleReplay.closeDialer() }
        try await staleReplay.sendHello(clientInstanceID: "phone-d", resumes: [])

        // The Mac's rejection is stamped with ITS current epoch (2) — this phone's own
        // epoch-aware decode path (`PhoneConn.readNext`, fixed at epoch 1) would ALSO see that as
        // a mismatch from its own stale point of view, exactly as a real stale phone would; read
        // it raw instead to positively confirm the gateway DID send an error (not silently
        // accept), then confirm the connection closes right after.
        let raw = try await staleReplay.expectRawFrame(timeout: 10)
        let body = try JSONDecoder().decode(JSONValue.self, from: raw)
        XCTAssertEqual(body["kind"]?.stringValue, "error", "a stale-epoch hello must be refused with a gateway error frame")

        let eof = try await staleReplay.readNext(timeout: 10)
        guard case .closed = eof else {
            return XCTFail("the connection must close right after refusing a stale-epoch hello, got \(eof)")
        }
    }
}

private struct PairingE2EError: Error, CustomStringConvertible {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { "PairingE2EError: \(message)" }
}
