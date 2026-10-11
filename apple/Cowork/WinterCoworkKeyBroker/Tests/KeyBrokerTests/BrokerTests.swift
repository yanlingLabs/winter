import XCTest
import Foundation
import CryptoKit
@testable import KeyBrokerCore

final class BrokerTests: XCTestCase {
    private func identity(_ changes: [String:Any] = [:]) throws -> VolumeIdentity {
        var value:[String:Any]=["homeId":"00000000-0000-0000-0000-000000000001","homePath":"/fixture/home","homeDevice":1,"homeInode":2,
            "workspaceId":"00000000-0000-0000-0000-000000000003","volumeId":"00000000-0000-0000-0000-000000000004",
            "creationId":"00000000-0000-0000-0000-000000000005","keyVersion":1,"formatVersion":1,"purpose":"data"]
        value.merge(changes){_,new in new};let result=try JSONDecoder().decode(VolumeIdentity.self,from:JSONSerialization.data(withJSONObject:value));try result.validate();return result
    }
    private func fingerprint(_ record: SealedRecord, _ vault: SyntheticVault) throws -> Data {
        var material=try vault.unlockMaterial(record);defer { wipe(&material) }
        return Data(SHA256.hash(data:material)) // Tests never print raw material.
    }
    func testProvisionUsesRandomKeysAndNeverReplacesAnExistingVolume() throws {
        let vault = SyntheticVault(), base = try identity()
        let first = try vault.provisionForFixture(base), original = try fingerprint(first, vault)
        let second = try vault.provisionForFixture(identity(["volumeId": "00000000-0000-0000-0000-000000000006"]))
        XCTAssertNotEqual(try fingerprint(second, vault), original)
        let independentVault = SyntheticVault()
        XCTAssertNotEqual(try fingerprint(independentVault.provisionForFixture(base), independentVault), original)
        XCTAssertThrowsError(try vault.provisionForFixture(base)) { XCTAssertEqual($0 as? BrokerFailure, .recordAlreadyExists) }
        XCTAssertEqual(try fingerprint(first, vault), original)
    }
    func testWrappedKeyTamperAndEveryIdentityDimensionAreRefused() throws {
        let vault = SyntheticVault(), record = try vault.provisionForFixture(identity())
        try vault.validate(record)
        var modified = record.wrappedKey
        modified[0] ^= 1
        XCTAssertThrowsError(try vault.validate(.init(identity: record.identity, wrappedKey: modified)))
        for change: [String: Any] in [["homeId": "00000000-0000-0000-0000-000000000006"], ["homePath": "/fixture/other"],
            ["homeDevice": 9], ["homeInode": 9], ["workspaceId": "00000000-0000-0000-0000-000000000006"],
            ["volumeId": "00000000-0000-0000-0000-000000000006"], ["creationId": "00000000-0000-0000-0000-000000000006"],
            ["keyVersion": 2], ["purpose": "environment"]] {
            XCTAssertThrowsError(try vault.validate(.init(identity: identity(change), wrappedKey: record.wrappedKey)))
        }
        try vault.validate(record)
    }
    func testExplicitHomeRelocationPreservesDiskKeyAndInvalidatesOldRecord() throws {
        let vault = SyntheticVault(), original = try vault.provisionForFixture(identity())
        let before = try fingerprint(original, vault)
        let moved = try identity(["homePath": "/restored/home", "homeDevice": 99, "homeInode": 101, "keyVersion": 2])
        let rebound = try vault.rebindForFixture(original, to: moved)
        XCTAssertEqual(try fingerprint(rebound, vault), before)
        XCTAssertNotEqual(rebound.wrappedKey, original.wrappedKey)
        XCTAssertEqual(rebound.identity, moved)
        XCTAssertThrowsError(try vault.validate(original)) { XCTAssertEqual($0 as? BrokerFailure, .staleRecord) }
        // A valid old seal cannot be used to rebind again after ownership moved.
        XCTAssertThrowsError(try vault.rebindForFixture(original, to: identity(["keyVersion": 2])))
    }
    func testRebindingCannotChangeVolumeWorkspacePurposeOrSkipVersion() throws {
        let vault = SyntheticVault(), original = try vault.provisionForFixture(identity())
        let before = try fingerprint(original, vault)
        for change: [String: Any] in [["homeId": "00000000-0000-0000-0000-000000000006", "keyVersion": 2],
            ["workspaceId": "00000000-0000-0000-0000-000000000006", "keyVersion": 2],
            ["volumeId": "00000000-0000-0000-0000-000000000006", "keyVersion": 2],
            ["creationId": "00000000-0000-0000-0000-000000000006", "keyVersion": 2],
            ["purpose": "environment", "keyVersion": 2], ["keyVersion": 1], ["keyVersion": 3]] {
            XCTAssertThrowsError(try vault.rebindForFixture(original, to: identity(change))) {
                XCTAssertEqual($0 as? BrokerFailure, .invalidTransition)
            }
        }
        XCTAssertEqual(try fingerprint(original, vault), before)
    }
    func testWrappingKeyRotationPreservesEveryDiskKey() throws {
        let vault = SyntheticVault()
        var records = [try vault.provisionForFixture(identity()), try vault.provisionForFixture(identity([
            "volumeId": "00000000-0000-0000-0000-000000000006", "purpose": "environment"]))]
        let original = try Dictionary(uniqueKeysWithValues: records.map { ($0.identity.volumeId, try fingerprint($0, vault)) })
        for expectedVersion: UInt64 in [2, 3] {
            let old = records
            records = try vault.rotateWrappingKeyForFixture()
            XCTAssertEqual(records.count, 2)
            for record in records {
                XCTAssertEqual(record.identity.keyVersion, expectedVersion)
                XCTAssertEqual(try fingerprint(record, vault), original[record.identity.volumeId])
                XCTAssertFalse(old.contains { $0.wrappedKey == record.wrappedKey })
            }
            for record in old { XCTAssertThrowsError(try vault.validate(record)) }
        }
    }
    func testFailedRotationDoesNotPartiallyReplaceCurrentRecords() throws {
        let vault = SyntheticVault()
        let records = [try vault.provisionForFixture(identity()), try vault.provisionForFixture(identity([
            "volumeId": "00000000-0000-0000-0000-000000000006", "keyVersion": UInt64.max]))]
        let before = try records.map { try fingerprint($0, vault) }
        XCTAssertThrowsError(try vault.rotateWrappingKeyForFixture()) { XCTAssertEqual($0 as? BrokerFailure, .invalidTransition) }
        XCTAssertEqual(try records.map { try fingerprint($0, vault) }, before)
    }
    func testChannelUsesOwnedPIDNonceRecordAndConsumesOnFailure() throws {
        let vault=SyntheticVault(),record=try vault.provisionForFixture(identity()),permit=OneShotAdmission(record:record,launchedPID:100)
        let bytes=try JSONEncoder().encode(permit.bootstrap())
        XCTAssertThrowsError(try permit.consume(bytes,kernelPeerPID:101,vault:vault)){XCTAssertEqual($0 as? BrokerFailure,.unauthorizedChannel)}
        XCTAssertThrowsError(try permit.consume(bytes,kernelPeerPID:100,vault:vault)){XCTAssertEqual($0 as? BrokerFailure,.replay)}
        let allowed=OneShotAdmission(record:record,launchedPID:100)
        XCTAssertEqual(try allowed.consume(JSONEncoder().encode(allowed.bootstrap()),kernelPeerPID:100,vault:vault).identity,record.identity)
    }
    func testUnknownPIDExecutableAndKeyRequestFieldsAreNotIgnored() throws {
        let record=try SyntheticVault().provisionForFixture(identity()),permit=OneShotAdmission(record:record,launchedPID:100)
        let encoded=try JSONEncoder().encode(permit.bootstrap())
        for field in ["pid","executable","derive","decrypt"] {
            var object=try JSONSerialization.jsonObject(with:encoded) as! [String:Any];object[field]="forged"
            XCTAssertThrowsError(try LaunchRequest.decode(JSONSerialization.data(withJSONObject:object))){XCTAssertEqual($0 as? BrokerFailure,.forbiddenField)}
        }
        var object=try JSONSerialization.jsonObject(with:encoded) as! [String:Any]
        var nested=object["identity"] as! [String:Any];nested["masterKey"]=true;object["identity"]=nested
        XCTAssertThrowsError(try LaunchRequest.decode(JSONSerialization.data(withJSONObject:object)))
    }
    func testCanonicalIdentityRefusesAlternateSpellingAndUnknownFormat() throws {
        for change:[String:Any] in [["homePath":"/fixture/../home"],["homePath":"/fixture//home"],["homePath":"/fixture/\0home"],["keyVersion":0],["formatVersion":2],["homeInode":0],["workspaceId":"not-an-id"]] { XCTAssertThrowsError(try identity(change)) }
    }
    func testProductionLaunchAlwaysBlockedWithoutFixtureSecrets() {
        XCTAssertThrowsError(try ProductionKeyBroker.launch()){XCTAssertEqual($0 as? BrokerFailure,.productionBlocked)}
    }
}
