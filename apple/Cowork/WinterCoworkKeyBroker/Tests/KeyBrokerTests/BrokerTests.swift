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
    func testEveryIdentityDimensionAndPurposeSeparatesKeys() throws {
        let vault=SyntheticVault(),base=try identity();let first=try vault.provisionForFixture(base),original=try fingerprint(first,vault)
        for change:[String:Any] in [["homeId":"00000000-0000-0000-0000-000000000006"],["homePath":"/fixture/other"],["homeDevice":9],["homeInode":9],
            ["workspaceId":"00000000-0000-0000-0000-000000000006"],["volumeId":"00000000-0000-0000-0000-000000000006"],
            ["creationId":"00000000-0000-0000-0000-000000000006"],["keyVersion":2],["purpose":"environment"]] {
            let next=try vault.provisionForFixture(identity(change));XCTAssertNotEqual(try fingerprint(next,vault),original)
        }
    }
    func testSealTamperAndChangedIdentityAreRefused() throws {
        let vault=SyntheticVault(),record=try vault.provisionForFixture(identity())
        try vault.validate(record)
        XCTAssertThrowsError(try vault.validate(.init(identity:record.identity,authentication:Data(repeating:0,count:32))))
        for change:[String:Any] in [["keyVersion":2],["creationId":"00000000-0000-0000-0000-000000000006"],["purpose":"environment"],["homeInode":3]] {
            XCTAssertThrowsError(try vault.validate(.init(identity:identity(change),authentication:record.authentication)))
        }
    }
    func testOldValidSealNeedsCurrentVersionNotOnlyMAC() throws {
        let vault=SyntheticVault(),old=try vault.provisionForFixture(identity())
        _=try vault.provisionForFixture(identity(["keyVersion":2]))
        XCTAssertThrowsError(try vault.validate(old)){XCTAssertEqual($0 as? BrokerFailure,.staleRecord)}
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
