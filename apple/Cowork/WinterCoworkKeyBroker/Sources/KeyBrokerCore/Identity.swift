import Foundation
import CryptoKit

public enum BrokerFailure: String, Error { case invalidIdentity, invalidSeal, staleRecord, unauthorizedChannel, replay, forbiddenField, imageMismatch, processFailure, sandboxRequired, productionBlocked }
public enum VolumePurpose: String, Codable, Sendable { case data, environment }
public struct VolumeIdentity: Codable, Equatable, Sendable {
    public let homeId: String
    public let homePath: String
    public let homeDevice: UInt64
    public let homeInode: UInt64
    public let workspaceId: String
    public let volumeId: String
    public let creationId: String
    public let keyVersion: UInt64
    public let formatVersion: UInt32
    public let purpose: VolumePurpose
    public init(homeId: String, homePath: String, homeDevice: UInt64, homeInode: UInt64, workspaceId: String, volumeId: String, creationId: String, keyVersion: UInt64, formatVersion: UInt32 = 1, purpose: VolumePurpose) throws {
        self.homeId=homeId;self.homePath=homePath;self.homeDevice=homeDevice;self.homeInode=homeInode;self.workspaceId=workspaceId;self.volumeId=volumeId;self.creationId=creationId;self.keyVersion=keyVersion;self.formatVersion=formatVersion;self.purpose=purpose
        try validate()
    }
    public func validate() throws {
        for id in [homeId,workspaceId,volumeId,creationId] {
            guard let uuid=UUID(uuidString:id),uuid.uuidString.lowercased()==id else { throw BrokerFailure.invalidIdentity }
        }
        guard keyVersion>0,formatVersion==1,homeInode>0,homePath.utf8.count<=1024,!homePath.contains("\0"),homePath.hasPrefix("/"),URL(fileURLWithPath:homePath).standardizedFileURL.path==homePath else { throw BrokerFailure.invalidIdentity }
    }
    public func canonical(domain: String) throws -> Data {
        try validate()
        var output=Data()
        func field(_ bytes: Data) { var count=UInt32(bytes.count).bigEndian;withUnsafeBytes(of:&count){output.append(contentsOf:$0)};output.append(bytes) }
        for value in ["WinterCoworkKeyBroker/v1",domain,homeId,homePath,workspaceId,volumeId,creationId,purpose.rawValue] { field(Data(value.utf8)) }
        for value in [homeDevice,homeInode,keyVersion,UInt64(formatVersion)] { var number=value.bigEndian;withUnsafeBytes(of:&number){field(Data($0))} }
        return output
    }
}
public struct SealedRecord: Codable, Sendable { public let identity: VolumeIdentity; public let authentication: Data }

/// Synthetic volatile store only. No Keychain/storage implementation exists.
/// This type lives only in the native broker process, never the client protocol.
public final class SyntheticVault {
    private let master: SymmetricKey
    private var current: [String: SealedRecord] = [:]
    public init() { master=SymmetricKey(size:.bits256) }
    private func key(_ identity: VolumeIdentity, domain: String) throws -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial:master,salt:Data("WinterCowork/HKDF/SHA256/v1".utf8),info:try identity.canonical(domain:domain),outputByteCount:32)
    }
    public func provisionForFixture(_ identity: VolumeIdentity) throws -> SealedRecord {
        let record=SealedRecord(identity:identity,authentication:Data(HMAC<SHA256>.authenticationCode(for:try identity.canonical(domain:"sealed-volume-record"),using:try key(identity,domain:"record-integrity"))))
        current[identity.volumeId]=record;return record
    }
    public func validate(_ record: SealedRecord) throws {
        guard HMAC<SHA256>.isValidAuthenticationCode(record.authentication,authenticating:try record.identity.canonical(domain:"sealed-volume-record"),using:try key(record.identity,domain:"record-integrity")) else { throw BrokerFailure.invalidSeal }
        guard current[record.identity.volumeId]?.identity == record.identity else { throw BrokerFailure.staleRecord }
    }
    // Internal, so client/worker targets cannot expose a generic derivation RPC.
    func unlockMaterial(_ record: SealedRecord) throws -> Data {
        try validate(record)
        return try key(record.identity,domain:"volume-unlock").withUnsafeBytes { Data($0) }
    }
    public func proofMatches(_ proof: Data, record: SealedRecord, challenge: Data) throws -> Bool {
        try validate(record)
        return HMAC<SHA256>.isValidAuthenticationCode(proof,authenticating:challenge,using:try key(record.identity,domain:"volume-unlock"))
    }
    public func fixtureDomainSeparation(_ records: [SealedRecord]) throws -> Bool {
        let keys=try records.map { try key($0.identity,domain:"volume-unlock").withUnsafeBytes { Data($0) } }
        return Set(keys).count==keys.count
    }
}

public struct LaunchRequest: Codable, Sendable {
    public let nonce: Data
    public let identity: VolumeIdentity
    public init(nonce: Data, identity: VolumeIdentity) { self.nonce=nonce;self.identity=identity }
    public static func decode(_ data: Data) throws -> LaunchRequest {
        guard data.count<=4096,let object=try JSONSerialization.jsonObject(with:data) as? [String:Any],Set(object.keys)==["nonce","identity"] else { throw BrokerFailure.forbiddenField }
        let identityFields:Set<String>=["homeId","homePath","homeDevice","homeInode","workspaceId","volumeId","creationId","keyVersion","formatVersion","purpose"]
        guard let identity=object["identity"] as? [String:Any],Set(identity.keys)==identityFields else { throw BrokerFailure.forbiddenField }
        let request=try JSONDecoder().decode(LaunchRequest.self,from:data)
        guard request.nonce.count==32 else { throw BrokerFailure.unauthorizedChannel };try request.identity.validate();return request
    }
}
public final class OneShotAdmission {
    private let nonce: Data
    private let record: SealedRecord
    private let launchedPID: Int32
    private var consumed=false
    public init(record: SealedRecord, launchedPID: Int32) { self.record=record;self.launchedPID=launchedPID;nonce=Data(SymmetricKey(size:.bits256).withUnsafeBytes { Data($0) }) }
    public func bootstrap() -> LaunchRequest { LaunchRequest(nonce:nonce,identity:record.identity) }
    public func consume(_ bytes: Data, kernelPeerPID: Int32, vault: SyntheticVault) throws -> SealedRecord {
        guard !consumed else { throw BrokerFailure.replay };consumed=true
        let request=try LaunchRequest.decode(bytes)
        guard kernelPeerPID==launchedPID,request.nonce==nonce,request.identity==record.identity else { throw BrokerFailure.unauthorizedChannel }
        try vault.validate(record);return record
    }
}
public enum ProductionKeyBroker {
    public static func launch() throws { throw BrokerFailure.productionBlocked }
}
