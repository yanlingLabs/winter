import XCTest
import NormaProtocol
@testable import NormaKit

/// SP2b Task 4: `RemoteHost` (RemoteHost.swift) is the composition root — these tests exercise ONLY
/// its start/stop lifecycle policy (device count / pairing-window-requested gating), never real
/// networking or a real daemon: `makeListener` injects a `LoopbackListener` nobody ever dials into,
/// and `makeDaemonFactory` injects a `NormaClient` over a `ScriptedTransport` nobody ever drives
/// (CLAUDE.md: tests must never touch the live Keychain — production `RemoteHost.start()` reads
/// `KeychainToken.readRemoteToken()`, which these tests never exercise at all). The full-stack proof
/// against a REAL daemon + REAL iroh lives in `PairingE2ETests`.
final class RemoteHostTests: XCTestCase {

    private func makeRelayConfig() -> SignedRelayConfig {
        SignedRelayConfig(config: RelayConfig(version: 1, relays: ["relay1.norma.dev"]), sig: Data(repeating: 7, count: 64))
    }

    private func tempStoreDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-remote-host-tests-\(UUID().uuidString)", isDirectory: true)
    }

    @MainActor
    private func makeHost(storeDir: URL) -> RemoteHost {
        let config = RemoteHost.Config(
            storeDir: storeDir, socketPath: "/tmp/norma-remote-host-tests-unused.sock",
            hostLabel: "Test Mac", relayConfig: makeRelayConfig(), relayURLs: []
        )
        return RemoteHost(
            config: config,
            secretStore: InMemoryEndpointSecretStore(),
            makeListener: { LoopbackListener() },
            makeDaemonFactory: { NormaClient(makeTransport: { ScriptedTransport() }, token: "test-token", clientName: "iphone-gateway") }
        )
    }

    /// Seeds a device directly into the SAME on-disk store `RemoteHost` will construct its own
    /// `PairingStore` against (a fresh `PairingStore` instance pointed at the same file loads
    /// whatever's already persisted — same precedent as `PairingStoreTests`' own "persisted across
    /// a fresh instance" tests).
    private func seedOneDevice(storeDir: URL, peerID: String = "peer-1") async throws {
        let seedStore = PairingStore(fileURL: storeDir.appendingPathComponent("paired-devices.json"))
        try await seedStore.add(phoneEndpointID: peerID, label: "iPhone", caps: ["sessions"], at: 1_000)
    }

    // MARK: - startIfNeeded

    func test_startIfNeeded_staysStoppedAtZeroDevices() async throws {
        let host = await makeHost(storeDir: tempStoreDir())
        try await host.startIfNeeded()
        let macID = await host.macEndpointID
        let manager = await host.pairingManager
        XCTAssertNil(macID, "zero paired devices, no pairing window requested — must stay stopped")
        XCTAssertNil(manager)
    }

    func test_startIfNeeded_startsWhenADeviceExists() async throws {
        let storeDir = tempStoreDir()
        try await seedOneDevice(storeDir: storeDir)

        let host = await makeHost(storeDir: storeDir)
        try await host.startIfNeeded()
        let macID = await host.macEndpointID
        let manager = await host.pairingManager
        XCTAssertNotNil(macID, "an already-paired device is reason enough to start")
        XCTAssertNotNil(manager)
    }

    // MARK: - openPairingWindow force-starts

    func test_openPairingWindow_forceStartsAtZeroDevices() async throws {
        let host = await makeHost(storeDir: tempStoreDir())
        let qr = try await host.openPairingWindow()
        let macID = await host.macEndpointID
        XCTAssertNotNil(macID, "opening a pairing window must force-start even with zero devices")
        XCTAssertEqual(qr.hostLabel, "Test Mac")
        XCTAssertEqual(qr.macEndpointID, macID)
    }

    // MARK: - stopIfIdle

    func test_stopIfIdle_afterClosePairingWindowWithEmptyStore_stops() async throws {
        let host = await makeHost(storeDir: tempStoreDir())
        _ = try await host.openPairingWindow()
        let runningMacID = await host.macEndpointID
        XCTAssertNotNil(runningMacID, "sanity: the window forced it running")

        await host.closePairingWindow()
        await host.stopIfIdle()
        let macID = await host.macEndpointID
        let manager = await host.pairingManager
        XCTAssertNil(macID, "empty store + closed window — stopIfIdle must actually stop")
        XCTAssertNil(manager)
    }

    func test_stopIfIdle_doesNotStopWhileWindowStillOpen() async throws {
        let host = await makeHost(storeDir: tempStoreDir())
        _ = try await host.openPairingWindow()
        await host.stopIfIdle()
        let macID = await host.macEndpointID
        XCTAssertNotNil(macID, "the pairing window is still open — stopIfIdle must be a no-op")
    }

    func test_stopIfIdle_doesNotStopWithPairedDevices() async throws {
        let storeDir = tempStoreDir()
        try await seedOneDevice(storeDir: storeDir)
        let host = await makeHost(storeDir: storeDir)
        try await host.startIfNeeded()

        await host.stopIfIdle()
        let macID = await host.macEndpointID
        XCTAssertNotNil(macID, "a device is still paired — stopIfIdle must be a no-op")
    }

    // MARK: - revoke empties the store -> next stopIfIdle stops

    func test_revoke_emptiesStore_thenNextStopIfIdleStops() async throws {
        let storeDir = tempStoreDir()
        try await seedOneDevice(storeDir: storeDir, peerID: "peer-1")
        let host = await makeHost(storeDir: storeDir)
        try await host.startIfNeeded()
        let runningMacID = await host.macEndpointID
        XCTAssertNotNil(runningMacID)

        await host.revoke(phoneEndpointID: "peer-1")
        let devices = await host.pairedDevices()
        XCTAssertTrue(devices.isEmpty, "revoke must empty the paired-device list")
        let stillRunningMacID = await host.macEndpointID
        XCTAssertNotNil(stillRunningMacID, "revoke itself must not auto-stop — the caller decides when to re-check idleness")

        await host.stopIfIdle()
        let macIDAfterStop = await host.macEndpointID
        XCTAssertNil(macIDAfterStop, "now that the store is empty, the NEXT stopIfIdle must actually stop")
    }
}
