import XCTest
import Foundation
import CryptoKit
@testable import KeyBrokerCore

final class WorkerFrameTests: XCTestCase {
    private func bootstrap(_ format: VolumeKeyFormat) throws -> WorkerBootstrap {
        let identity=try VolumeIdentity(homeId:"00000000-0000-0000-0000-000000000001",homePath:"/fixture/home",homeDevice:1,homeInode:2,
            workspaceId:"00000000-0000-0000-0000-000000000003",volumeId:"00000000-0000-0000-0000-000000000004",
            creationId:"00000000-0000-0000-0000-000000000005",keyVersion:1,keyFormat:format,purpose:.data)
        return WorkerBootstrap(identity:identity,challenge:Data(repeating:4,count:32),deniedFixturePath:"/fixture/denied")
    }
    private func material(_ format: VolumeKeyFormat) throws -> Data {
        var component=0
        return try format.generateForFixture(randomComponent:{ component+=1;return Data(repeating:UInt8(component),count:32) })
    }
    private func replacingHeader(_ frame: Data, change: (inout [String:Any])->Void) throws -> Data {
        let size=frame[4..<8].reduce(UInt32(0)){($0<<8)|UInt32($1)},end=10+Int(size)
        var object=try JSONSerialization.jsonObject(with:Data(frame[10..<end])) as! [String:Any]
        change(&object);let header=try JSONSerialization.data(withJSONObject:object)
        var length=UInt32(header.count).bigEndian
        return Data(frame.prefix(4))+withUnsafeBytes(of:&length){Data($0)}+Data(frame[8..<10])+header+Data(frame[end...])
    }
    func testActualFrameCodecPreservesBothExactMaterials() throws {
        for format in VolumeKeyFormat.allCases {
            let header=try bootstrap(format)
            var key=try material(format);defer { wipe(&key) }
            var frame=try WorkerKeyFrame.encode(header,material:key);defer { wipe(&frame) }
            var decoded=try WorkerKeyFrame.decode(frame);defer { wipe(&decoded.material) }
            XCTAssertEqual(decoded.bootstrap.identity,header.identity)
            XCTAssertEqual(decoded.bootstrap.frameVersion,2);XCTAssertEqual(decoded.material.count,format.byteCount)
            XCTAssertTrue(SHA256.hash(data:decoded.material)==SHA256.hash(data:key)) // No raw material failure output.
        }
    }
    func testOldUnknownTruncatedAndWrongDeclaredLengthsAreRejected() throws {
        var key=try material(.luks2AES256XTSHMACSHA256V1);defer { wipe(&key) }
        var frame=try WorkerKeyFrame.encode(bootstrap(.luks2AES256XTSHMACSHA256V1),material:key);defer { wipe(&frame) }
        let end=10+Int(frame[4..<8].reduce(UInt32(0)){($0<<8)|UInt32($1)})
        var legacy=Data(frame[4..<8])+Data(frame[10..<end])+key;defer { wipe(&legacy) }
        XCTAssertThrowsError(try WorkerKeyFrame.decode(legacy))
        var unknown=frame;defer { wipe(&unknown) };unknown[3]=3
        XCTAssertThrowsError(try WorkerKeyFrame.decode(unknown))
        for missing in [1,32,96] {
            var truncated=Data(frame.dropLast(missing));defer { wipe(&truncated) }
            XCTAssertThrowsError(try WorkerKeyFrame.decode(truncated))
        }
        var badLength=frame;defer { wipe(&badLength) };badLength[9]=64
        XCTAssertThrowsError(try WorkerKeyFrame.decode(badLength))
    }
    func testVersionFormatLengthAndUnknownHeaderFieldsAreRejected() throws {
        var key=try material(.luks2AES256XTSHMACSHA256V1);defer { wipe(&key) }
        var frame=try WorkerKeyFrame.encode(bootstrap(.luks2AES256XTSHMACSHA256V1),material:key);defer { wipe(&frame) }
        for mode in ["version","length","format","unknown-format","extra","extra-identity","missing-version"] {
            var changed=try replacingHeader(frame) { object in
                switch mode {
                case "version":object["frameVersion"]=3
                case "length":object["keyByteCount"]=32
                case "extra":object["decrypt"]=true
                case "missing-version":object.removeValue(forKey:"frameVersion")
                default:
                    var identity=object["identity"] as! [String:Any]
                    if mode=="extra-identity" { identity["keyLayout"]="forged" }
                    else { identity["keyFormat"]=mode=="format" ? VolumeKeyFormat.fixtureRaw256V1.rawValue:"unknown-format-v1" }
                    object["identity"]=identity
                }
            };defer { wipe(&changed) }
            XCTAssertThrowsError(try WorkerKeyFrame.decode(changed))
        }
    }
    func testWorkerRejectsEqualAESKeysEvenInCorrectSizedFrame() throws {
        var key=try material(.luks2AES256XTSHMACSHA256V1);defer { wipe(&key) }
        var frame=try WorkerKeyFrame.encode(bootstrap(.luks2AES256XTSHMACSHA256V1),material:key);defer { wipe(&frame) }
        let start=frame.count-96
        frame.replaceSubrange((start+32)..<(start+64),with:Data(frame[start..<(start+32)]))
        XCTAssertThrowsError(try WorkerKeyFrame.decode(frame)) { XCTAssertEqual($0 as? BrokerFailure,.invalidKeyMaterial) }
    }
    func testOldAndUnknownWorkerReadyShapesCannotReceiveMaterial() throws {
        for object:[String:Any] in [["sandbox":true,"bootstrapFD":3],
            ["frameVersion":1,"sandbox":true,"bootstrapFD":3],
            ["frameVersion":3,"sandbox":true,"bootstrapFD":3],
            ["frameVersion":2,"sandbox":true,"bootstrapFD":3,"extra":true]] {
            XCTAssertThrowsError(try WorkerReady.decode(JSONSerialization.data(withJSONObject:object)))
        }
        XCTAssertEqual(try WorkerReady.decode(JSONEncoder().encode(WorkerReady(sandbox:true,bootstrapFD:3))).frameVersion,2)
    }
}
