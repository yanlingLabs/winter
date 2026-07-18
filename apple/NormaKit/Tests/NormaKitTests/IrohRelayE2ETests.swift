import XCTest
import os
import NormaProtocol
import IrohLib
@testable import NormaKit

/// SP2b Task 6: forced-relay end-to-end proof against the REAL production relay fleet (Oracle
/// Always-Free, Frankfurt). Env-gated (`NORMA_RELAY_E2E=1`) — this suite makes REAL network calls
/// to REAL internet infrastructure this repo doesn't control the uptime of, so it must never run
/// in CI or a normal `swift test` and must never be a dependency of anything else passing.
///
/// **Relay engagement, not relay exclusivity.** iroh-ffi v1.1.0 (this repo's pinned binding — see
/// `apple/NormaKit/vendor/README.md`) exposes no "force relay, refuse direct" knob, nor a
/// connection-level `connectionType()`/`RemoteInfo` API (grepped the vendored `IrohLib.swift` —
/// absent). What it DOES expose is `Connection.paths() -> [PathSnapshot]`, each with
/// `isSelected`/`isRelay` — this is the closest available proxy to the brief's "connection-type
/// probe," and what this suite polls. Both endpoints here are also constructed to give iroh no
/// direct-connectivity information at all: the phone's dial address carries ONLY a relay URL
/// (`EndpointAddr(id:, relayUrl:, addresses: [])`, no direct IP candidates), mirroring
/// `PhonePairingClient`'s own "no addresses" seam. On a real two-machine pairing this is
/// necessarily how the FIRST hop happens regardless (a phone never starts out already knowing the
/// Mac's direct address) — what this test can't fully rule out, running both "devices" as
/// processes on the SAME Mac, is iroh's OWN opportunistic direct-upgrade (QUIC hole-punching,
/// negotiated via the relay's QUIC address-discovery service) kicking in mid-connection and
/// swapping the selected path to direct. Polling `paths()` promptly after connect — before that
/// upgrade race has had time to complete over a real Frankfurt round trip — is what makes this a
/// meaningful assertion rather than a tautology; see `awaitRelayPath` below.
///
/// Run against relay-1 (default) and again against relay-2 via `NORMA_RELAY_E2E_URL` (the task's
/// "run it live once against relay-1, then once against relay-2" — both runs' results belong in
/// `infra/relay/README.md`, not in this file):
///
/// ```sh
/// NORMA_RELAY_E2E=1 swift test --filter IrohRelayE2ETests
/// NORMA_RELAY_E2E=1 NORMA_RELAY_E2E_URL="https://relay-2.yanlinglabs.com./" swift test --filter IrohRelayE2ETests
/// ```
final class IrohRelayE2ETests: XCTestCase {

    private static let defaultRelayURL = "https://relay-1.yanlinglabs.com./"

    private func relayURL() -> String {
        ProcessInfo.processInfo.environment["NORMA_RELAY_E2E_URL"] ?? Self.defaultRelayURL
    }

    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["NORMA_RELAY_E2E"] == "1",
            "forced-relay E2E against live production infra — set NORMA_RELAY_E2E=1 to run"
        )
    }

    // MARK: - Shared setup (mirrors PairingE2ETests.makeHost, but relay-enabled and not loopback-pinned)

    private func makeRelayConfig(relays: [String]) -> SignedRelayConfig {
        SignedRelayConfig(config: RelayConfig(version: 1, relays: relays), sig: Data(repeating: 7, count: 64))
    }

    private func tempStoreDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-relay-e2e-tests-\(UUID().uuidString)", isDirectory: true)
    }

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

    /// Unlike `PairingE2ETests.makeHost`, this does NOT pin `bindAddr` to loopback and DOES pass
    /// a real `relayURLs` — the Mac's own listener needs a real, internet-routable bind so it can
    /// actually register with the relay (a loopback-bound UDP socket can never reach Frankfurt).
    @MainActor
    private func makeHost(daemon: RealDaemon, relayURL: String) async throws -> TestSetup {
        let secretStore = InMemoryEndpointSecretStore()
        let identity = try MacIdentity.loadOrCreate(store: secretStore)
        let listenerBox = ListenerBox()
        let config = RemoteHost.Config(
            storeDir: tempStoreDir(), socketPath: daemon.socketPath, hostLabel: "Relay E2E Mac",
            relayConfig: makeRelayConfig(relays: [relayURL]), relayURLs: [relayURL]
        )
        let host = RemoteHost(
            config: config,
            secretStore: secretStore,
            makeListener: {
                let listener = try await IrohListener.start(secret: identity.secret, relayURLs: [relayURL])
                listenerBox.value = listener
                return listener
            },
            makeDaemonFactory: {
                NormaClient(makeTransport: { UnixSocketTransport(path: daemon.socketPath) }, token: daemon.remoteToken, clientName: "iphone-gateway")
            }
        )
        _ = try await host.openPairingWindow()
        guard let irohListener = listenerBox.value else {
            throw RelayE2EError("makeListener never ran — RemoteHost.start() didn't bind a listener")
        }
        return TestSetup(host: host, irohListener: irohListener)
    }

    /// Runs one full pairing ceremony forced through `relayURL`: the phone's dialer is
    /// relay-enabled (`PhonePairingClient.pairInternal`'s `relayURLs` seam, added by this task)
    /// and its peer address carries ONLY the relay URL — no direct addresses at all.
    @MainActor
    private func pairPhoneViaRelay(setup: TestSetup, secret: Data, relayURL: String, label: String = "iPhone (relay)") async throws -> PairAccepted {
        guard let manager = setup.host.pairingManager else {
            throw RelayE2EError("pairPhoneViaRelay requires an already-open pairing window")
        }
        let qr = await manager.beginPairing()
        var events = manager.events.makeAsyncIterator()

        let macAddr = try EndpointAddr(id: EndpointId.fromString(s: qr.macEndpointID), relayUrl: relayURL, addresses: [])
        async let phoneResult = PhonePairingClient.pairInternal(
            qr: qr, bindAddr: nil, secret: secret, addrOverride: macAddr, relayURLs: [relayURL],
            onWords: { _ in }
        )

        guard case .requestReceived(let macWords, _) = await events.next() else {
            throw RelayE2EError("expected requestReceived")
        }
        await manager.confirm(label: label)
        guard case .completed = await events.next() else {
            throw RelayE2EError("expected completed")
        }

        let (accepted, phoneWords, _) = try await phoneResult
        XCTAssertEqual(phoneWords, macWords, "SAS words must match even over a relay-forced ceremony")

        await setup.host.closePairingWindow()
        return accepted
    }

    /// Polls `conn.paths()` for a SELECTED path that IS a relay path, bounded by `timeoutSeconds`
    /// — deliberately checked SOON after connect (short poll interval, modest deadline) rather
    /// than after a long soak, so a same-machine direct-upgrade race (see this file's header
    /// comment) has as little time as possible to have already happened.
    private func awaitRelayPath(_ conn: Connection, timeoutSeconds: Double = 5) async throws -> PathSnapshot {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var lastSnapshot: [PathSnapshot] = []
        while Date() < deadline {
            let paths = conn.paths()
            lastSnapshot = paths
            if let relaySelected = paths.first(where: { $0.isSelected && $0.isRelay }) {
                return relaySelected
            }
            try await Task.sleep(for: .milliseconds(200))
        }
        throw RelayE2EError("no selected relay path within \(timeoutSeconds)s — last paths() snapshot: \(lastSnapshot)")
    }

    // MARK: - The scenario

    func testForcedRelay_FullCeremony_AttachStream_RevokeMidStream() async throws {
        let url = relayURL()
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() }
        let setup = try await makeHost(daemon: daemon, relayURL: url)

        let secret = SecretKey.generate().toBytes()
        let accepted = try await pairPhoneViaRelay(setup: setup, secret: secret, relayURL: url)
        XCTAssertEqual(accepted.epoch, 1)
        XCTAssertEqual(accepted.grantedCaps, ["sessions"])

        let phoneEndpointID = try SecretKey.fromBytes(bytes: secret).public().description
        let phone = try await RelayPhone.dial(
            macEndpointID: setup.host.macEndpointID ?? "", relayURL: url, epoch: accepted.epoch, secret: secret
        )
        defer { phone.close() }

        // Full ceremony -> attach -> stream (mirrors PairingE2ETests scenario A, over the relay).
        try await phone.sendHello(clientInstanceID: "relay-e2e-phone", resumes: [])
        let ack = try await phone.expectFrame()
        XCTAssertEqual(ack.kind, .helloAck)

        try await phone.sendRpcRequest(id: 1, method: "session.list", params: nil)
        let resp = try await phone.expectFrame()
        XCTAssertEqual(resp.kind, .rpcResponse)

        // The connection-type proof: the SELECTED path for this connection is a relay path.
        let relayPath = try await awaitRelayPath(phone.connection)
        XCTAssertTrue(relayPath.isRelay)
        XCTAssertEqual(relayPath.remoteAddr, url, "the selected relay path's remote address should be the relay URL we forced")

        // Revoke mid-stream, over the relay — the live connection must drop.
        try await setup.host.revoke(phoneEndpointID: phoneEndpointID)
        let closedResult = try await phone.readNext(timeout: 15)
        guard case .closed = closedResult else {
            return XCTFail("revoke over the relay must drop the phone's live connection, got \(closedResult)")
        }
    }
}

private struct RelayE2EError: Error, CustomStringConvertible {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { "RelayE2EError: \(message)" }
}

// MARK: - RelayPhone: a relay-forced in-process iroh "phone" for the post-ceremony attach

/// A per-file, minimal relay-forced dialer + `WireEnvelope` speaker — deliberately NOT sharing
/// `IrohE2ETests`' `PhoneConn` (whose `connection`/dialer are `private` to that file, and whose
/// `dial` hardcodes a loopback, relay-disabled dialer anyway): this codebase's established
/// convention for these small per-file test dialers is to duplicate rather than thread private
/// state across files (`norma-fake-phone`'s own attach dance duplicates this exact plumbing
/// independently). Exposes `connection` (not private) so `awaitRelayPath` above can call
/// `connection.paths()` directly.
private final class RelayPhone: @unchecked Sendable {
    let connection: Connection
    private let dialerEndpoint: Endpoint
    private let sendStream: SendStream
    private let recvStream: RecvStream
    private let epoch: Int
    private var buffer = Data()

    static func dial(macEndpointID: String, relayURL: String, epoch: Int, secret: Data) async throws -> RelayPhone {
        try await withTimeout(30, "RelayPhone.dial") {
            let dialer = try await Endpoint.bind(options: EndpointOptions(
                preset: presetN0(), secretKey: secret, relayMode: try RelayMode.customFromUrls(urls: [relayURL])
            ))
            // No direct addresses at all — only the relay URL. See this file's header comment.
            let macAddr = try EndpointAddr(id: EndpointId.fromString(s: macEndpointID), relayUrl: relayURL, addresses: [])
            let conn = try await dialer.connect(addr: macAddr, alpn: Data(IrohListener.defaultALPN.utf8))
            guard conn.remoteId().description == macEndpointID else {
                try? conn.close(errorCode: 0, reason: Data())
                throw RelayE2EError("mac identity mismatch on relay attach dial")
            }
            let bi = try await conn.openBi()
            return RelayPhone(dialerEndpoint: dialer, connection: conn, bi: bi, epoch: epoch)
        }
    }

    private init(dialerEndpoint: Endpoint, connection: Connection, bi: BiStream, epoch: Int) {
        self.dialerEndpoint = dialerEndpoint
        self.connection = connection
        self.sendStream = bi.send()
        self.recvStream = bi.recv()
        self.epoch = epoch
    }

    func close() {
        try? connection.close(errorCode: 0, reason: Data())
        Task { [dialerEndpoint] in try? await dialerEndpoint.close() }
    }

    private func sendFrame(_ envelope: WireEnvelope) async throws {
        let framed = LengthPrefix.wrap(try WireFrame.encode(envelope))
        try await withTimeout(10, "RelayPhone.send") { [self] in try await sendStream.writeAll(buf: framed) }
    }

    func sendHello(clientInstanceID: String, resumes: [StreamResume]) async throws {
        let hello = ClientHello(protocolVersions: [1], appBuild: "relay-e2e-phone", clientInstanceID: clientInstanceID, pairingEpoch: epoch, resumes: resumes)
        let payload = try JSONEncoder().encode(hello)
        try await sendFrame(WireEnvelope(
            v: 1, pairingEpoch: epoch, hostID: "phone-relay-e2e", sessionID: nil, streamID: nil, seq: nil,
            kind: .hello, timestamp: 0, payload: payload
        ))
    }

    func sendRpcRequest(id: Int, method: String, params: JSONValue?) async throws {
        var obj: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": .number(Double(id)), "method": .string(method)]
        if let params { obj["params"] = params }
        let payload = try JSONEncoder().encode(JSONValue.object(obj))
        try await sendFrame(WireEnvelope(
            v: 1, pairingEpoch: epoch, hostID: "phone-relay-e2e", sessionID: nil, streamID: nil, seq: nil,
            kind: .rpcRequest, timestamp: 0, payload: payload
        ))
    }

    enum ReadResult { case frame(WireEnvelope); case closed }

    func expectFrame(timeout: Double = 15) async throws -> WireEnvelope {
        guard case .frame(let envelope) = try await readNext(timeout: timeout) else {
            throw RelayE2EError("expected a frame, got closed")
        }
        return envelope
    }

    func readNext(timeout: Double = 15) async throws -> ReadResult {
        try await withTimeout(timeout, "RelayPhone.readNext") { [self] in
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
}

/// Per-file copy of this codebase's established `withTimeout` idiom (iroh-ffi's generated async
/// calls ignore Swift task cancellation) — a first-wins race between two UNSTRUCTURED tasks.
private func withTimeout<T>(_ seconds: Double, _ context: String = "", _ op: @escaping @Sendable () async throws -> T) async throws -> T {
    let resumed = OSAllocatedUnfairLock(initialState: false)
    let result: Result<T, Error> = await withCheckedContinuation { cont in
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: .failure(RelayE2EError("timed out: \(context)")))
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
