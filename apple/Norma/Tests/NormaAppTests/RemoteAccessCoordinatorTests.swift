import XCTest
import NormaProtocol
import NormaSessionKit
@testable import Norma
@testable import NormaKit

/// Autostart follow-up (CN combined-review Important 2): `RemoteAccessCoordinator.
/// startRemoteAccessIfPaired()` is the NEW wiring `AppDelegate.boot()` calls once at launch so an
/// already-paired phone survives a Mac relaunch without a human reopening "Pair a Device…". These
/// tests exercise ONLY that method's delegation to `RemoteHost.startIfNeeded()`'s own device-count
/// gate — never real networking or the Keychain (CLAUDE.md) — using the exact same scripted
/// listener/daemon-factory seam `RemoteHostTests` (NormaKit) already proves the underlying gate
/// with (`makeListener`/`makeDaemonFactory`, reached here via `@testable import NormaKit` — this
/// test target already imports NormaKit plainly elsewhere, e.g. `AppModelTests.swift`).
/// `AppScriptedTransport` (defined in `AppModelTests.swift`, same test module) stands in for
/// `makeDaemonFactory`'s transport; never actually driven here since these tests assert only
/// lifecycle state (`macEndpointID`), never send anything over it.
@MainActor
final class RemoteAccessCoordinatorTests: XCTestCase {
    private func makeRelayConfig() -> SignedRelayConfig {
        SignedRelayConfig(config: RelayConfig(version: 1, relays: []), sig: Data())
    }

    private func tempStoreDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-remote-access-coordinator-tests-\(UUID().uuidString)", isDirectory: true)
    }

    /// Seeds a device directly into the SAME on-disk store the scripted `RemoteHost` below will
    /// construct its own `PairingStore` against — same precedent as `RemoteHostTests.seedOneDevice`.
    private func seedOneDevice(storeDir: URL, peerID: String = "peer-1") async throws {
        let seedStore = PairingStore(fileURL: storeDir.appendingPathComponent("paired-devices.json"))
        try await seedStore.add(phoneEndpointID: peerID, label: "iPhone", caps: ["sessions"], at: 1_000)
    }

    private func makeScriptedHost(storeDir: URL) -> RemoteHost {
        let config = RemoteHost.Config(
            storeDir: storeDir,
            socketPath: "/tmp/norma-remote-access-coordinator-tests-unused.sock",
            hostLabel: "Test Mac",
            relayConfig: makeRelayConfig(),
            relayURLs: []
        )
        return RemoteHost(
            config: config,
            secretStore: InMemoryEndpointSecretStore(),
            makeListener: { LoopbackListener() },
            makeDaemonFactory: { NormaClient(makeTransport: { AppScriptedTransport() }, token: "test-token", clientName: "iphone-gateway") }
        )
    }

    // MARK: - (a) never-paired: autostart is a no-op

    func test_startRemoteAccessIfPaired_neverPaired_doesNotStartTheListener() async throws {
        let host = makeScriptedHost(storeDir: tempStoreDir())
        let coordinator = RemoteAccessCoordinator(host: host)

        await coordinator.startRemoteAccessIfPaired()

        let macID = await host.macEndpointID
        let manager = await host.pairingManager
        XCTAssertNil(macID, "zero paired devices, no pairing window requested — launch-time autostart must stay a no-op")
        XCTAssertNil(manager)
    }

    // MARK: - (b) already paired: autostart actually starts the stack

    func test_startRemoteAccessIfPaired_alreadyPaired_startsTheListener() async throws {
        let storeDir = tempStoreDir()
        try await seedOneDevice(storeDir: storeDir)
        let host = makeScriptedHost(storeDir: storeDir)
        let coordinator = RemoteAccessCoordinator(host: host)

        await coordinator.startRemoteAccessIfPaired()

        let macID = await host.macEndpointID
        let manager = await host.pairingManager
        XCTAssertNotNil(macID, "an already-paired device is reason enough for launch-time autostart to actually start the stack")
        XCTAssertNotNil(manager)
    }
}
