import XCTest
import os
import NormaProtocol
import NormaSessionKit
@testable import NormaKit

/// SP2b Task 3: `PairingManager` is the ceremony engine driving `beginPairing` ->
/// `handleConnection` (proof verify) -> `confirm`/`deny` (or timeout). Exercised against
/// `ScriptedRemoteConn` (RemoteTransport.swift, shared with `GatewayTests`) standing in for the
/// phone's transport, and a test-controlled clock/sleep-hook so the 5-minute offer TTL and
/// 2-minute confirm timeout are driven deterministically with zero real wall-clock delay.
final class PairingManagerTests: XCTestCase {

    /// Thread-safe mutable "now" the test advances explicitly — mirrors `Gateway`'s own injected
    /// `now: @Sendable () -> TimeInterval` seam, just `Int` seconds here.
    final class TestClock: @unchecked Sendable {
        private let box = OSAllocatedUnfairLock<Int>(initialState: 1_700_000_000)
        var now: Int {
            get { box.withLock { $0 } }
            set { box.withLock { $0 = newValue } }
        }
    }

    private func makeRelayConfig() -> SignedRelayConfig {
        SignedRelayConfig(config: RelayConfig(version: 1, relays: ["relay1.norma.dev"]), sig: Data(repeating: 7, count: 64))
    }

    /// A no-op, immediate `sleepHook` — the confirm-timeout watchdog's poll loop spins through
    /// this instantly (yielding, never actually pausing), so a test drives the 2-minute timeout
    /// purely by advancing `clock`, with no real wall-clock delay whatsoever. A free-standing
    /// closure constant (not a bound instance method) so it's trivially `@Sendable` — capturing
    /// nothing, unlike a method on this non-`Sendable` `XCTestCase` subclass.
    private let instantSleepHook: @Sendable (Duration) async -> Void = { _ in await Task.yield() }

    private func makeManager(store: PairingStore, clock: @escaping @Sendable () -> Int) -> PairingManager {
        PairingManager(
            store: store, macEndpointID: "mac-1", hostLabel: "Test Mac",
            relayConfig: makeRelayConfig(), clock: clock, rng: { Data(repeating: 0xAB, count: $0) },
            sleepHook: instantSleepHook
        )
    }

    /// The phone-side half of the ceremony: given the QR the Mac displayed, builds the
    /// `PairRequest` a legitimate phone would send (transcript + proof over its own chosen
    /// endpoint id/nonce/caps). Deliberately inline here (per the brief) rather than a shared
    /// helper in NormaKit — this is test-only, throwaway phone-side crypto.
    private func phonePairRequest(
        qr: QRPayload, phoneEndpointID: String = "phone-endpoint-1",
        phoneInstallNonce: Data = Data(repeating: 0x11, count: 16), caps: [String] = ["sessions"]
    ) -> PairRequest {
        let transcript = PairingCrypto.transcript(
            v: qr.v, pairID: qr.pairID, macEndpointID: qr.macEndpointID,
            phoneEndpointID: phoneEndpointID, phoneInstallNonce: phoneInstallNonce, caps: caps
        )
        let proof = PairingCrypto.proof(pairSecret: qr.pairSecret, transcript: transcript)
        return PairRequest(
            type: "pair_request", pairID: qr.pairID, phoneEndpointID: phoneEndpointID,
            phoneInstallNonce: phoneInstallNonce, caps: caps, proof: proof
        )
    }

    private func tempStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-pairing-manager-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("paired-devices.json")
    }

    // MARK: - Happy path

    func test_happyPath_confirmPersistsRecordAndSendsPairAccepted() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        let qr = await manager.beginPairing()
        let conn = ScriptedRemoteConn()
        let request = phonePairRequest(qr: qr)
        conn.enqueueInbound(try JSONEncoder().encode(request))

        await manager.handleConnection(conn)

        guard case .requestReceived(let words, let requestedLabel) = await events.next() else {
            return XCTFail("expected requestReceived")
        }
        XCTAssertEqual(words.count, 4)
        XCTAssertEqual(requestedLabel, "")

        await manager.confirm(label: "iPhone")

        guard case .completed(let record) = await events.next() else {
            return XCTFail("expected completed")
        }
        XCTAssertEqual(record.phoneEndpointID, "phone-endpoint-1")
        XCTAssertEqual(record.label, "iPhone")
        XCTAssertEqual(record.pairingEpoch, 1)

        let stored = await store.record(forPeer: "phone-endpoint-1")
        XCTAssertEqual(stored, record)

        XCTAssertEqual(conn.outbound.count, 1)
        let accepted = try JSONDecoder().decode(PairAccepted.self, from: conn.outbound[0])
        XCTAssertEqual(accepted.epoch, 1)
        XCTAssertEqual(accepted.grantedCaps, ["sessions"])
        XCTAssertEqual(accepted.phoneEndpointID, "phone-endpoint-1")

        // Terminal path: the offer (and its pairSecret) must not linger past the ceremony.
        let liveOffer = await manager.hasLiveOfferForTesting
        XCTAssertFalse(liveOffer)
    }

    // MARK: - Expired QR

    func test_expiredQR_rejectsAndEmitsFailed() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        let qr = await manager.beginPairing()
        clock.now += 301 // past the 300s offer TTL

        let conn = ScriptedRemoteConn()
        conn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr)))
        await manager.handleConnection(conn)

        guard case .failed(let reason) = await events.next() else {
            return XCTFail("expected failed")
        }
        XCTAssertEqual(reason, "expired")
        XCTAssertTrue(conn.isClosed)
        let rejected = try JSONDecoder().decode(PairRejected.self, from: conn.outbound[0])
        XCTAssertEqual(rejected.code, "expired")
        // SP3 T5 carry-in gate: the rejection echoes back this ceremony's own pairID.
        XCTAssertEqual(rejected.pairID, qr.pairID)
    }

    // MARK: - Reused (second request after consume)

    func test_secondRequestAfterConsume_isExpired() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        let qr = await manager.beginPairing()
        let firstConn = ScriptedRemoteConn(peerID: "first")
        firstConn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr)))
        await manager.handleConnection(firstConn)
        guard case .requestReceived = await events.next() else { return XCTFail("expected requestReceived") }

        let secondConn = ScriptedRemoteConn(peerID: "second")
        secondConn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr, phoneEndpointID: "phone-endpoint-2")))
        await manager.handleConnection(secondConn)

        guard case .failed(let reason) = await events.next() else { return XCTFail("expected failed") }
        XCTAssertEqual(reason, "expired")
        XCTAssertTrue(secondConn.isClosed)
    }

    // MARK: - Bad proof x5

    func test_badProofFiveTimes_fourBadProofThenRateLimited() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        let qr = await manager.beginPairing()
        var badRequest = phonePairRequest(qr: qr)
        badRequest = PairRequest(
            type: badRequest.type, pairID: badRequest.pairID, phoneEndpointID: badRequest.phoneEndpointID,
            phoneInstallNonce: badRequest.phoneInstallNonce, caps: badRequest.caps,
            proof: Data(repeating: 0xFF, count: badRequest.proof.count) // wrong proof
        )

        for i in 0..<5 {
            let conn = ScriptedRemoteConn(peerID: "attempt-\(i)")
            conn.enqueueInbound(try JSONEncoder().encode(badRequest))
            await manager.handleConnection(conn)
            let rejected = try JSONDecoder().decode(PairRejected.self, from: conn.outbound[0])
            XCTAssertEqual(rejected.code, "bad_proof", "attempt \(i) wire code")
            XCTAssertEqual(rejected.pairID, qr.pairID, "attempt \(i) pairID")
            XCTAssertTrue(conn.isClosed)

            guard case .failed(let reason) = await events.next() else { return XCTFail("expected failed at attempt \(i)") }
            if i < 4 {
                XCTAssertEqual(reason, "bad_proof", "attempt \(i) event reason")
            } else {
                XCTAssertEqual(reason, "rate_limited", "final attempt event reason")
            }
        }

        // Offer is dead — the secret dropped with it — and even a CORRECT proof against the same
        // pairID is now refused.
        let liveOffer = await manager.hasLiveOfferForTesting
        XCTAssertFalse(liveOffer)
        let goodConn = ScriptedRemoteConn(peerID: "post-kill")
        goodConn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr)))
        await manager.handleConnection(goodConn)
        guard case .failed(let reason) = await events.next() else { return XCTFail("expected failed") }
        XCTAssertEqual(reason, "expired")
        let postKillRejected = try JSONDecoder().decode(PairRejected.self, from: goodConn.outbound[0])
        XCTAssertEqual(postKillRejected.pairID, qr.pairID)
    }

    // MARK: - Deny

    func test_deny_rejectsAndPersistsNothing() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        let qr = await manager.beginPairing()
        let conn = ScriptedRemoteConn()
        conn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr)))
        await manager.handleConnection(conn)
        guard case .requestReceived = await events.next() else { return XCTFail("expected requestReceived") }

        await manager.deny()

        guard case .failed(let reason) = await events.next() else { return XCTFail("expected failed") }
        XCTAssertEqual(reason, "denied")
        XCTAssertTrue(conn.isClosed)
        let rejected = try JSONDecoder().decode(PairRejected.self, from: conn.outbound[0])
        XCTAssertEqual(rejected.code, "denied")
        XCTAssertEqual(rejected.pairID, qr.pairID)

        let all = await store.all()
        XCTAssertTrue(all.isEmpty)
        // Terminal path: the offer (and its pairSecret) must not linger past the ceremony.
        let liveOffer = await manager.hasLiveOfferForTesting
        XCTAssertFalse(liveOffer)
    }

    // MARK: - Timeout

    func test_confirmTimeout_afterDeadline_rejectsWithTimeout() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        let qr = await manager.beginPairing()
        let conn = ScriptedRemoteConn()
        conn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr)))
        await manager.handleConnection(conn)
        guard case .requestReceived = await events.next() else { return XCTFail("expected requestReceived") }

        clock.now += 120 // past the 2-minute confirm TTL; the watchdog's own poll loop notices

        guard case .failed(let reason) = await events.next() else { return XCTFail("expected failed") }
        XCTAssertEqual(reason, "timeout")
        XCTAssertTrue(conn.isClosed)
        let rejected = try JSONDecoder().decode(PairRejected.self, from: conn.outbound[0])
        XCTAssertEqual(rejected.code, "timeout")
        XCTAssertEqual(rejected.pairID, qr.pairID)

        let all = await store.all()
        XCTAssertTrue(all.isEmpty)
        // Terminal path: the offer (and its pairSecret) must not linger past the ceremony.
        let liveOffer = await manager.hasLiveOfferForTesting
        XCTAssertFalse(liveOffer)
    }

    // MARK: - Re-pair after revoke -> epoch bump

    func test_rePairSamePhoneAfterRevoke_epochBumpsToTwo() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        // First pairing -> epoch 1.
        let qr1 = await manager.beginPairing()
        let conn1 = ScriptedRemoteConn(peerID: "conn1")
        conn1.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr1)))
        await manager.handleConnection(conn1)
        guard case .requestReceived = await events.next() else { return XCTFail("expected requestReceived") }
        await manager.confirm(label: "iPhone")
        guard case .completed(let firstRecord) = await events.next() else { return XCTFail("expected completed") }
        XCTAssertEqual(firstRecord.pairingEpoch, 1)

        try await store.revoke(phoneEndpointID: "phone-endpoint-1")

        // Re-pair the SAME phone -> epoch must bump to 2.
        let qr2 = await manager.beginPairing()
        let conn2 = ScriptedRemoteConn(peerID: "conn2")
        conn2.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr2)))
        await manager.handleConnection(conn2)
        guard case .requestReceived = await events.next() else { return XCTFail("expected requestReceived") }
        await manager.confirm(label: "iPhone (re-paired)")
        guard case .completed(let secondRecord) = await events.next() else { return XCTFail("expected completed") }
        XCTAssertEqual(secondRecord.pairingEpoch, 2)

        let accepted = try JSONDecoder().decode(PairAccepted.self, from: conn2.outbound[0])
        XCTAssertEqual(accepted.epoch, 2)
    }

    // MARK: - Supersession (fix 1: beginPairing during a pending confirm)

    func test_beginPairingDuringPendingConfirm_rejectsOrphanedConn_newOfferWorks() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        // First ceremony reaches pending-confirm...
        let qr1 = await manager.beginPairing()
        let oldConn = ScriptedRemoteConn(peerID: "orphaned")
        oldConn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr1)))
        await manager.handleConnection(oldConn)
        guard case .requestReceived = await events.next() else { return XCTFail("expected requestReceived") }

        // ...then the user opens a fresh QR sheet. The orphaned phone must be told, not left
        // hanging: PairRejected("expired") then close, with `.failed("expired")` emitted AFTER
        // the reject lands (that ordering is the test's synchronization point).
        let qr2 = await manager.beginPairing()
        guard case .failed(let reason) = await events.next() else { return XCTFail("expected failed") }
        XCTAssertEqual(reason, "expired")
        XCTAssertTrue(oldConn.isClosed)
        let rejected = try JSONDecoder().decode(PairRejected.self, from: oldConn.outbound[0])
        XCTAssertEqual(rejected.code, "expired")
        // SP3 T5 carry-in gate: the orphaned rejection must carry the OLD ceremony's pairID
        // (qr1), never the new offer's (qr2) — this is exactly the disambiguation the gate exists
        // for: a reducer watching both ceremonies must be able to tell them apart.
        XCTAssertEqual(rejected.pairID, qr1.pairID)
        XCTAssertNotEqual(rejected.pairID, qr2.pairID)

        // The NEW offer works end-to-end.
        let newConn = ScriptedRemoteConn(peerID: "fresh")
        newConn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr2)))
        await manager.handleConnection(newConn)
        guard case .requestReceived = await events.next() else { return XCTFail("expected requestReceived on new offer") }
        await manager.confirm(label: "iPhone")
        guard case .completed(let record) = await events.next() else { return XCTFail("expected completed") }
        XCTAssertEqual(record.pairingEpoch, 1)
        let accepted = try JSONDecoder().decode(PairAccepted.self, from: newConn.outbound[0])
        XCTAssertEqual(accepted.epoch, 1)
    }

    // MARK: - Confirm-time store failures (fix 2: cap_reached vs internal_error)

    func test_confirmAtDeviceCap_rejectsCapReached() async throws {
        let store = PairingStore(fileURL: tempStoreURL())
        // Fill the store to its 10-device cap directly.
        for i in 0..<10 {
            try await store.add(phoneEndpointID: "filler-\(i)", label: "Phone \(i)", caps: ["sessions"], at: 1_000)
        }

        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        let qr = await manager.beginPairing()
        let conn = ScriptedRemoteConn()
        conn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr, phoneEndpointID: "phone-endpoint-11")))
        await manager.handleConnection(conn)
        guard case .requestReceived = await events.next() else { return XCTFail("expected requestReceived") }

        await manager.confirm(label: "one too many")

        guard case .failed(let reason) = await events.next() else { return XCTFail("expected failed") }
        XCTAssertEqual(reason, "cap_reached")
        XCTAssertTrue(conn.isClosed)
        let rejected = try JSONDecoder().decode(PairRejected.self, from: conn.outbound[0])
        XCTAssertEqual(rejected.code, "cap_reached")
        XCTAssertEqual(rejected.pairID, qr.pairID)
        let notPersisted = await store.record(forPeer: "phone-endpoint-11")
        XCTAssertNil(notPersisted)
        let liveOffer = await manager.hasLiveOfferForTesting
        XCTAssertFalse(liveOffer)
    }

    func test_confirmWithFailingPersist_rejectsInternalError_notCapReached() async throws {
        // A store whose persist always fails: fileURL's parent is a read-only dir, so the
        // temp-file creation inside `persist()` fails with a non-capReached error.
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-pairing-manager-ro-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path) }
        let store = PairingStore(fileURL: dir.appendingPathComponent("paired-devices.json"))

        let clock = TestClock()
        let manager = makeManager(store: store, clock: { clock.now })
        var events = manager.events.makeAsyncIterator()

        let qr = await manager.beginPairing()
        let conn = ScriptedRemoteConn()
        conn.enqueueInbound(try JSONEncoder().encode(phonePairRequest(qr: qr)))
        await manager.handleConnection(conn)
        guard case .requestReceived = await events.next() else { return XCTFail("expected requestReceived") }

        await manager.confirm(label: "iPhone")

        guard case .failed(let reason) = await events.next() else { return XCTFail("expected failed") }
        XCTAssertEqual(reason, "internal_error")
        XCTAssertTrue(conn.isClosed)
        let rejected = try JSONDecoder().decode(PairRejected.self, from: conn.outbound[0])
        XCTAssertEqual(rejected.code, "internal_error")
        XCTAssertEqual(rejected.pairID, qr.pairID)
        // Nothing persisted — the store rolled back its in-memory state too.
        let all = await store.all()
        XCTAssertTrue(all.isEmpty)
        let liveOffer = await manager.hasLiveOfferForTesting
        XCTAssertFalse(liveOffer)
    }

    // MARK: - MacIdentity (folded in per brief step 4)

    func test_macIdentity_loadOrCreate_createsOnceReturnsStableSecret() throws {
        let store = InMemoryEndpointSecretStore()
        let first = try MacIdentity.loadOrCreate(store: store)
        XCTAssertEqual(first.secret.count, 32)

        let second = try MacIdentity.loadOrCreate(store: store)
        XCTAssertEqual(first.secret, second.secret)
    }
}
