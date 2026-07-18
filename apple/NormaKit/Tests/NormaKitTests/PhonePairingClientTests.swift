import XCTest
import os
import NormaProtocol
import IrohLib
@testable import NormaKit

/// SP2b Task 5, Step 1: proves `PhonePairingClient` runs the FULL ceremony correctly against a
/// real `PairingManager` over a real (loopback) iroh listener — the phone side now goes through
/// production code instead of the hand-rolled frames `PairingE2ETests.pairPhone` used to build
/// (that test is refactored, in this same task, to call `PhonePairingClient` too — see this file's
/// sibling `PairingE2ETests.swift`). No `RemoteHost`/`Gateway`/daemon involved here — this is
/// purely "does the phone's own ceremony implementation agree with the Mac's `PairingManager`",
/// which needs neither.
final class PhonePairingClientTests: XCTestCase {

    private func tempStoreDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-phone-pairing-tests-\(UUID().uuidString)", isDirectory: true)
    }

    private func makeRelayConfig() -> SignedRelayConfig {
        SignedRelayConfig(config: RelayConfig(version: 1, relays: []), sig: Data(repeating: 7, count: 64))
    }

    /// Binds a real (loopback, relay-disabled) `IrohListener` and a real `PairingManager` wired
    /// directly to its `connections` stream — no `PairingRouter`/`Gateway` in front, since this
    /// test only needs to prove the ceremony itself, not the post-pairing gateway.
    private func makeManager() async throws -> (listener: IrohListener, manager: PairingManager, routeTask: Task<Void, Never>) {
        let macSecret = SecretKey.generate().toBytes()
        let listener = try await IrohListener.start(secret: macSecret, relayURLs: [], bindAddr: "127.0.0.1:0")
        let macID = try SecretKey.fromBytes(bytes: macSecret).public().description
        let store = PairingStore(fileURL: tempStoreDir().appendingPathComponent("paired-devices.json"))
        let manager = PairingManager(
            store: store, macEndpointID: macID, hostLabel: "Test Mac", relayConfig: makeRelayConfig()
        )
        let routeTask = Task {
            for await conn in listener.connections {
                Task { await manager.handleConnection(conn) }
            }
        }
        return (listener, manager, routeTask)
    }

    func testFullCeremony_WordsSurfaceViaOnWords_AcceptedEpochLands() async throws {
        let (listener, manager, routeTask) = try await makeManager()
        defer { listener.stop(); routeTask.cancel() }

        let qr = await manager.beginPairing()
        var events = manager.events.makeAsyncIterator()

        let onWordsBox = OSAllocatedUnfairLock<[String]?>(initialState: nil)

        async let phoneResult = PhonePairingClient.pairInternal(
            qr: qr, bindAddr: "127.0.0.1:0", secret: SecretKey.generate().toBytes(),
            addrOverride: listener.endpointAddr,
            onWords: { words in onWordsBox.withLock { $0 = words } }
        )

        guard case .requestReceived(let macWords, let requestedLabel) = await events.next() else {
            return XCTFail("expected requestReceived")
        }
        XCTAssertEqual(requestedLabel, "", "v1: the phone sends no label of its own")

        await manager.confirm(label: "iPhone")
        guard case .completed(let record) = await events.next() else {
            return XCTFail("expected completed")
        }
        XCTAssertEqual(record.pairingEpoch, 1)

        let (accepted, phoneWords, endpointSecret) = try await phoneResult

        XCTAssertEqual(phoneWords, macWords, "the phone's own SAS computation must match the Mac's")
        XCTAssertEqual(onWordsBox.withLock { $0 }, macWords, "onWords must surface the SAME words, before the accept frame lands")
        XCTAssertEqual(accepted.epoch, 1, "the accepted epoch must land")
        XCTAssertEqual(accepted.grantedCaps, ["sessions"])
        XCTAssertEqual(accepted.phoneEndpointID, try SecretKey.fromBytes(bytes: endpointSecret).public().description)
    }

    func testDeny_SurfacesRejectedDenied() async throws {
        let (listener, manager, routeTask) = try await makeManager()
        defer { listener.stop(); routeTask.cancel() }

        let qr = await manager.beginPairing()
        var events = manager.events.makeAsyncIterator()

        async let phoneResult = PhonePairingClient.pairInternal(
            qr: qr, bindAddr: "127.0.0.1:0", secret: SecretKey.generate().toBytes(),
            addrOverride: listener.endpointAddr,
            onWords: { _ in }
        )

        guard case .requestReceived = await events.next() else {
            return XCTFail("expected requestReceived")
        }
        await manager.deny()
        guard case .failed(let reason) = await events.next() else {
            return XCTFail("expected failed")
        }
        XCTAssertEqual(reason, "denied")

        do {
            _ = try await phoneResult
            XCTFail("expected PhonePairingClient.pair to throw on denial")
        } catch PhonePairingError.rejected(let code) {
            XCTAssertEqual(code, "denied")
        }
    }

    func testMacIdentityMismatch_ThrowsRatherThanProceeding() async throws {
        let (listener, manager, routeTask) = try await makeManager()
        defer { listener.stop(); routeTask.cancel() }

        var qr = await manager.beginPairing()
        // Tamper with the QR's claimed identity — the phone must refuse to proceed even though
        // it's dialing the REAL listener (`addrOverride` still points at it), since a real dialer
        // has no such override and would otherwise be trusting an attacker-supplied macEndpointID.
        qr = QRPayload(
            v: qr.v, pairID: qr.pairID, pairSecret: qr.pairSecret, expiresAt: qr.expiresAt,
            macEndpointID: "some-other-endpoint-id", relayConfig: qr.relayConfig,
            alpn: qr.alpn, hostLabel: qr.hostLabel
        )

        do {
            _ = try await PhonePairingClient.pairInternal(
                qr: qr, bindAddr: "127.0.0.1:0", secret: SecretKey.generate().toBytes(),
                addrOverride: listener.endpointAddr,
                onWords: { _ in }
            )
            XCTFail("expected macIdentityMismatch")
        } catch PhonePairingError.macIdentityMismatch {
            // expected
        }
    }
}
