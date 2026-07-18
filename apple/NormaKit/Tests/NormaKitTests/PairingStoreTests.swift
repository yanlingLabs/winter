import XCTest
@testable import NormaKit

/// SP2b Task 3: `PairingStore` is the Mac's persisted paired-device allowlist — a JSON file under
/// a temp dir for every test in this file (CLAUDE.md: tests must never touch the live `~/.norma`).
final class PairingStoreTests: XCTestCase {

    private func tempFileURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-pairing-store-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("paired-devices.json")
    }

    private func makeRecord(peer: String = "phone-1", epoch: Int = 1, at: Int = 1_000) -> PairRecord {
        PairRecord(phoneEndpointID: peer, label: "iPhone", createdAt: at, caps: ["sessions"], pairingEpoch: epoch, lastSeenAt: at)
    }

    func test_addAndAll_roundTripsThroughTempDirFile() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)
        let record = makeRecord()

        try await store.add(record)

        let all = await store.all()
        XCTAssertEqual(all, [record])
        let fetched = await store.record(forPeer: "phone-1")
        XCTAssertEqual(fetched, record)
    }

    func test_add_capReachedAt10() async throws {
        let store = PairingStore(fileURL: tempFileURL())
        for i in 0..<10 {
            try await store.add(makeRecord(peer: "phone-\(i)"))
        }
        do {
            try await store.add(makeRecord(peer: "phone-overflow"))
            XCTFail("expected capReached")
        } catch PairingStoreError.capReached {
            // expected
        }
        // A re-pair (same peer already present) never trips the cap.
        try await store.add(makeRecord(peer: "phone-0", epoch: 2))
        let updated = await store.record(forPeer: "phone-0")
        XCTAssertEqual(updated?.pairingEpoch, 2)
    }

    func test_revoke_removesRecordAndBumpsEpoch_persistedAcrossFreshInstance() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)
        try await store.add(makeRecord(peer: "phone-1", epoch: 1))

        let next = await store.revoke(phoneEndpointID: "phone-1")
        XCTAssertEqual(next, 2)
        let afterRevoke = await store.record(forPeer: "phone-1")
        XCTAssertNil(afterRevoke)

        // A fresh actor instance over the SAME file must see the revoke (removed record) and the
        // bumped epoch memory — proves the write was actually persisted, not just in-memory.
        let reloaded = PairingStore(fileURL: url)
        let reloadedAll = await reloaded.all()
        XCTAssertTrue(reloadedAll.isEmpty)
        let reloadedNextEpoch = await reloaded.nextEpoch(forPeer: "phone-1")
        XCTAssertEqual(reloadedNextEpoch, 2)
    }

    func test_nextEpoch_startsAt1ForNeverPairedPeer() async throws {
        let store = PairingStore(fileURL: tempFileURL())
        let next = await store.nextEpoch(forPeer: "never-seen")
        XCTAssertEqual(next, 1)
    }

    func test_fileMode_is0600() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)
        try await store.add(makeRecord())

        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        let perms = attrs[.posixPermissions] as? Int
        XCTAssertEqual(perms, 0o600)
    }

    func test_atomicWrite_reloadFreshActor_equal() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)
        let r1 = makeRecord(peer: "phone-1", epoch: 1)
        let r2 = makeRecord(peer: "phone-2", epoch: 1)
        try await store.add(r1)
        try await store.add(r2)

        let reloaded = PairingStore(fileURL: url)
        let reloadedAll = await reloaded.all()
        XCTAssertEqual(reloadedAll.sorted { $0.phoneEndpointID < $1.phoneEndpointID }, [r1, r2])
    }

    func test_touch_updatesLastSeenAt_persisted() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)
        try await store.add(makeRecord(peer: "phone-1", at: 1_000))

        await store.touch(peer: "phone-1", at: 2_000)
        let touched = await store.record(forPeer: "phone-1")
        XCTAssertEqual(touched?.lastSeenAt, 2_000)

        let reloaded = PairingStore(fileURL: url)
        let reloadedRecord = await reloaded.record(forPeer: "phone-1")
        XCTAssertEqual(reloadedRecord?.lastSeenAt, 2_000)
    }
}
