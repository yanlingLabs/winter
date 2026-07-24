import XCTest
import os
import NormaProtocol
import NormaSessionKit
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
    private func makeHost(
        storeDir: URL,
        relayURLs: [String] = [],
        relayProbe: @escaping @Sendable (String) async -> Bool = RemoteHost.defaultRelayProbe
    ) -> RemoteHost {
        let config = RemoteHost.Config(
            storeDir: storeDir, socketPath: "/tmp/norma-remote-host-tests-unused.sock",
            hostLabel: "Test Mac", relayConfig: makeRelayConfig(), relayURLs: relayURLs, relayProbe: relayProbe
        )
        return RemoteHost(
            config: config,
            secretStore: InMemoryEndpointSecretStore(),
            makeListener: { LoopbackListener() },
            makeDaemonFactory: { NormaClient(makeTransport: { ScriptedTransport() }, token: "test-token", clientName: "iphone-gateway") }
        )
    }

    /// `RelaySelection` (NormaSessionKit) isn't `Equatable` — these two pattern-match instead of
    /// `XCTAssertEqual`, matching every other enum-with-payload assertion idiom in this test target.
    private func assertN0Default(_ selection: RelaySelection?, file: StaticString = #filePath, line: UInt = #line) {
        guard case .n0Default = selection else {
            XCTFail("expected .n0Default, got \(String(describing: selection))", file: file, line: line)
            return
        }
    }

    private func assertCustom(_ selection: RelaySelection?, urls: [String], file: StaticString = #filePath, line: UInt = #line) {
        guard case .custom(let got) = selection else {
            XCTFail("expected .custom(\(urls)), got \(String(describing: selection))", file: file, line: line)
            return
        }
        XCTAssertEqual(got, urls, file: file, line: line)
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

        try await host.revoke(phoneEndpointID: "peer-1")
        let devices = await host.pairedDevices()
        XCTAssertTrue(devices.isEmpty, "revoke must empty the paired-device list")
        let stillRunningMacID = await host.macEndpointID
        XCTAssertNotNil(stillRunningMacID, "revoke itself must not auto-stop — the caller decides when to re-check idleness")

        await host.stopIfIdle()
        let macIDAfterStop = await host.macEndpointID
        XCTAssertNil(macIDAfterStop, "now that the store is empty, the NEXT stopIfIdle must actually stop")
    }

    /// T4 review fix 5: a failed STORE revoke must throw and must NOT half-revoke — the gateway is
    /// left untouched (the device is still authorized while its record survives; see
    /// `RemoteHost.revoke`'s own doc comment). Store failure is induced the same way
    /// `PairingManagerTests`' failing-persist test does: a read-only parent directory makes
    /// `PairingStore.persist()`'s temp-file creation fail (and the store rolls back in-memory).
    func test_revoke_storePersistFailure_throwsAndDeviceStaysPaired() async throws {
        let storeDir = tempStoreDir()
        try await seedOneDevice(storeDir: storeDir, peerID: "peer-1")
        let host = await makeHost(storeDir: storeDir)
        try await host.startIfNeeded()
        let runningMacID = await host.macEndpointID
        XCTAssertNotNil(runningMacID)

        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: storeDir.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: storeDir.path) }

        do {
            try await host.revoke(phoneEndpointID: "peer-1")
            XCTFail("revoke must rethrow the store's persist failure")
        } catch {
            // expected — any persist error propagates
        }
        let devices = await host.pairedDevices()
        XCTAssertEqual(devices.map(\.phoneEndpointID), ["peer-1"],
                       "a failed revoke must leave the device fully paired (the store rolled back)")
    }

    // MARK: - Re-entrancy: overlapping start calls bind exactly ONE listener (T4 review fix 1)

    /// Two overlapping `openPairingWindow()` calls (the exact shape of the reviewed race:
    /// app-launch `startIfNeeded()` vs. a user opening the QR sheet — both funnel into `start()`):
    /// both suspend past the `listener == nil` gate (at `store.all()`), so without the in-flight
    /// `startTask` guard BOTH would proceed to bind a listener from the same secret, leaking the
    /// first gateway/runTask. The counting factory proves exactly one listener is ever created.
    func test_concurrentStartCalls_bindExactlyOneListener() async throws {
        let listenerCount = OSAllocatedUnfairLock(initialState: 0)
        let config = RemoteHost.Config(
            storeDir: tempStoreDir(), socketPath: "/tmp/norma-remote-host-tests-unused.sock",
            hostLabel: "Test Mac", relayConfig: makeRelayConfig(), relayURLs: []
        )
        let host = await RemoteHost(
            config: config,
            secretStore: InMemoryEndpointSecretStore(),
            makeListener: {
                listenerCount.withLock { $0 += 1 }
                return LoopbackListener()
            },
            makeDaemonFactory: { NormaClient(makeTransport: { ScriptedTransport() }, token: "test-token", clientName: "iphone-gateway") }
        )

        async let first: QRPayload = host.openPairingWindow()
        async let second: QRPayload = host.openPairingWindow()
        let (qr1, qr2) = try await (first, second)

        XCTAssertEqual(listenerCount.withLock { $0 }, 1, "overlapping start calls must share ONE in-flight start — never bind a second listener")
        XCTAssertEqual(qr1.macEndpointID, qr2.macEndpointID, "both callers see the same (single) host identity")
        let macID = await host.macEndpointID
        XCTAssertNotNil(macID)
    }

    // MARK: - Relay selection (CN-T1): probe reachability, emergency n0 fallback

    /// Contract (a): every custom relay unreachable -> the listener starts on `.n0Default`
    /// (the EMERGENCY fallback), never silently hanging on a dead custom fleet. Every URL must
    /// actually have been probed (not just the first) — `openPairingWindow()` force-starts at
    /// zero paired devices, matching `test_openPairingWindow_forceStartsAtZeroDevices`'s own idiom.
    func test_start_allCustomRelaysUnreachable_fallsBackToN0Default() async throws {
        let calls = OSAllocatedUnfairLock<[String]>(initialState: [])
        let relayURLs = ["https://relay-a.example/", "https://relay-b.example/"]
        let host = await makeHost(storeDir: tempStoreDir(), relayURLs: relayURLs, relayProbe: { url in
            calls.withLock { $0.append(url) }
            return false
        })

        _ = try await host.openPairingWindow()

        let selection = await host.lastRelaySelection
        assertN0Default(selection)
        XCTAssertEqual(Set(calls.withLock { $0 }), Set(relayURLs), "every custom relay must have been probed before declaring the fleet dead")
    }

    /// Contract (b): even ONE reachable custom relay wins the whole fleet — selection is
    /// `.custom(all)`, not just the reachable URL. iroh itself handles per-relay failure among
    /// customs; this probe's only job is "is the whole fleet dead," not picking a survivor.
    func test_start_oneCustomRelayReachable_selectsAllCustomURLsNotJustTheReachableOne() async throws {
        let relayURLs = ["https://relay-a.example/", "https://relay-b.example/", "https://relay-c.example/"]
        let host = await makeHost(storeDir: tempStoreDir(), relayURLs: relayURLs, relayProbe: { url in
            url == "https://relay-b.example/"
        })

        _ = try await host.openPairingWindow()

        let selection = await host.lastRelaySelection
        assertCustom(selection, urls: relayURLs)
    }

    /// Contract (c): no custom relays configured (Debug builds never embed the signed Oracle
    /// config) -> `.n0Default`, and — critically — the probe closure is NEVER invoked. This is
    /// the byte-identical-to-today path: a config with an empty `relayURLs` must not gain any new
    /// network activity just because `relayProbe` now exists.
    func test_start_noCustomRelays_usesN0DefaultAndNeverInvokesProbe() async throws {
        let calls = OSAllocatedUnfairLock<Int>(initialState: 0)
        let host = await makeHost(storeDir: tempStoreDir(), relayURLs: [], relayProbe: { _ in
            calls.withLock { $0 += 1 }
            return true
        })

        _ = try await host.openPairingWindow()

        let selection = await host.lastRelaySelection
        assertN0Default(selection)
        XCTAssertEqual(calls.withLock { $0 }, 0, "empty relayURLs must stay byte-identical to today — the probe must never run")
    }
}
