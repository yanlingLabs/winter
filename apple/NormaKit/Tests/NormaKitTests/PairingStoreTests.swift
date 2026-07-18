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

    @discardableResult
    private func addPeer(
        _ store: PairingStore, peer: String = "phone-1", label: String = "iPhone", at now: Int = 1_000
    ) async throws -> PairRecord {
        try await store.add(phoneEndpointID: peer, label: label, caps: ["sessions"], at: now)
    }

    func test_addAndAll_roundTripsThroughTempDirFile() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)

        let record = try await addPeer(store)

        XCTAssertEqual(record.phoneEndpointID, "phone-1")
        XCTAssertEqual(record.label, "iPhone")
        XCTAssertEqual(record.caps, ["sessions"])
        XCTAssertEqual(record.pairingEpoch, 1)
        XCTAssertEqual(record.createdAt, 1_000)
        XCTAssertEqual(record.lastSeenAt, 1_000)

        let all = await store.all()
        XCTAssertEqual(all, [record])
        let fetched = await store.record(forPeer: "phone-1")
        XCTAssertEqual(fetched, record)
    }

    func test_add_capReachedAt10() async throws {
        let store = PairingStore(fileURL: tempFileURL())
        for i in 0..<10 {
            try await addPeer(store, peer: "phone-\(i)")
        }
        do {
            try await addPeer(store, peer: "phone-overflow")
            XCTFail("expected capReached")
        } catch PairingStoreError.capReached {
            // expected
        }
        // A re-pair (same peer already present) never trips the cap; without an intervening
        // revoke it deliberately reuses the same epoch.
        let rePaired = try await addPeer(store, peer: "phone-0", label: "renamed")
        XCTAssertEqual(rePaired.label, "renamed")
        XCTAssertEqual(rePaired.pairingEpoch, 1)
    }

    func test_revoke_removesRecordAndBumpsEpoch_persistedAcrossFreshInstance() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)
        try await addPeer(store, peer: "phone-1")

        let next = try await store.revoke(phoneEndpointID: "phone-1")
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

    /// Fix 3 (epoch race): the epoch is now assigned inside `add` itself — one actor call, so
    /// no interleaving between "pick the epoch" and "persist the record" is possible by
    /// construction. Revoke-then-add yields prior+1; a further revoke-then-add yields +2 over
    /// the original pairing.
    func test_epochAssignment_revokeThenAddBumps_addRevokeAddBumpsAgain() async throws {
        let store = PairingStore(fileURL: tempFileURL())

        let first = try await addPeer(store, peer: "phone-1")
        XCTAssertEqual(first.pairingEpoch, 1)

        try await store.revoke(phoneEndpointID: "phone-1")
        let second = try await addPeer(store, peer: "phone-1")
        XCTAssertEqual(second.pairingEpoch, 2)

        try await store.revoke(phoneEndpointID: "phone-1")
        let third = try await addPeer(store, peer: "phone-1")
        XCTAssertEqual(third.pairingEpoch, 3)
    }

    func test_nextEpoch_startsAt1ForNeverPairedPeer() async throws {
        let store = PairingStore(fileURL: tempFileURL())
        let next = await store.nextEpoch(forPeer: "never-seen")
        XCTAssertEqual(next, 1)
    }

    func test_fileMode_is0600() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)
        try await addPeer(store)

        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        let perms = attrs[.posixPermissions] as? Int
        XCTAssertEqual(perms, 0o600)
    }

    func test_atomicWrite_reloadFreshActor_equal() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)
        let r1 = try await addPeer(store, peer: "phone-1")
        let r2 = try await addPeer(store, peer: "phone-2")

        let reloaded = PairingStore(fileURL: url)
        let reloadedAll = await reloaded.all()
        XCTAssertEqual(reloadedAll.sorted { $0.phoneEndpointID < $1.phoneEndpointID }, [r1, r2])
    }

    func test_touch_updatesLastSeenAt_persisted() async throws {
        let url = tempFileURL()
        let store = PairingStore(fileURL: url)
        try await addPeer(store, peer: "phone-1", at: 1_000)

        await store.touch(peer: "phone-1", at: 2_000)
        let touched = await store.record(forPeer: "phone-1")
        XCTAssertEqual(touched?.lastSeenAt, 2_000)

        let reloaded = PairingStore(fileURL: url)
        let reloadedRecord = await reloaded.record(forPeer: "phone-1")
        XCTAssertEqual(reloadedRecord?.lastSeenAt, 2_000)
    }

    /// Fix 5: `revoke` must not silently swallow a persist failure — it throws AND rolls back
    /// both in-memory mutations, so memory and disk stay consistent (the record survives both in
    /// this instance and across a reload).
    func test_revoke_failingPersist_throwsAndRollsBack() async throws {
        let url = tempFileURL()
        let dir = url.deletingLastPathComponent()
        let store = PairingStore(fileURL: url)
        let record = try await addPeer(store, peer: "phone-1")

        // Make the parent dir read-only so persist's temp-file creation fails.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path) }

        do {
            try await store.revoke(phoneEndpointID: "phone-1")
            XCTFail("expected revoke to throw on persist failure")
        } catch {
            // expected — the persist error surfaces instead of being swallowed
        }

        // In-memory state rolled back: record present, epoch memory untouched.
        let stillThere = await store.record(forPeer: "phone-1")
        XCTAssertEqual(stillThere, record)
        let epoch = await store.nextEpoch(forPeer: "phone-1")
        XCTAssertEqual(epoch, 1)

        // On-disk state never changed: a fresh instance still sees the record.
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        let reloaded = PairingStore(fileURL: url)
        let reloadedRecord = await reloaded.record(forPeer: "phone-1")
        XCTAssertEqual(reloadedRecord, record)
    }
}
