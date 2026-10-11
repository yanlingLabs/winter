import Foundation
import CryptoKit

public enum BrokerFailure: String, Error { case invalidIdentity, invalidSeal, staleRecord, unauthorizedChannel, replay, forbiddenField, imageMismatch, processFailure, sandboxRequired, productionBlocked, recordAlreadyExists, invalidTransition }
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
public struct SealedRecord: Codable, Equatable, Sendable {
    public let identity: VolumeIdentity
    /// AES-GCM nonce, ciphertext and tag. Never a plaintext data-encryption key.
    public let wrappedKey: Data
}

/// Synthetic volatile store only. No Keychain/storage implementation exists.
/// This type lives only in the native broker process, never the client protocol.
public final class SyntheticVault {
    private var wrappingKey = SymmetricKey(size: .bits256)
    private var current: [String: SealedRecord] = [:]
    public init() {}

    private func seal(_ material: Data, identity: VolumeIdentity, using key: SymmetricKey) throws -> SealedRecord {
        guard material.count == 32 else { throw BrokerFailure.invalidSeal }
        let box = try AES.GCM.seal(material, using: key, authenticating: identity.canonical(domain: "wrapped-volume-dek"))
        guard let combined = box.combined else { throw BrokerFailure.invalidSeal }
        return SealedRecord(identity: identity, wrappedKey: combined)
    }
    private func verifiedMaterial(_ record: SealedRecord) throws -> Data {
        try record.identity.validate()
        var material: Data
        do {
            material = try AES.GCM.open(AES.GCM.SealedBox(combined: record.wrappedKey), using: wrappingKey,
                authenticating: record.identity.canonical(domain: "wrapped-volume-dek"))
        } catch { throw BrokerFailure.invalidSeal }
        guard material.count == 32, current[record.identity.volumeId] == record else {
            wipe(&material)
            throw BrokerFailure.staleRecord
        }
        return material
    }
    public func provisionForFixture(_ identity: VolumeIdentity) throws -> SealedRecord {
        try identity.validate()
        // Re-provisioning an existing identity must never silently replace its
        // disk key. Relocation/KEK rotation use explicit re-sealing below.
        guard current[identity.volumeId] == nil else { throw BrokerFailure.recordAlreadyExists }
        var material = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        defer { wipe(&material) }
        let record = try seal(material, identity: identity, using: wrappingKey)
        current[identity.volumeId] = record
        return record
    }
    public func validate(_ record: SealedRecord) throws {
        var material = try verifiedMaterial(record)
        wipe(&material)
    }
    // Internal, so client/worker targets cannot expose a generic unwrap RPC.
    func unlockMaterial(_ record: SealedRecord) throws -> Data { try verifiedMaterial(record) }

    /// An explicitly authorized native relocation would re-seal the SAME DEK.
    /// This fixture method does not implement the production authorization or
    /// persistent transaction. No JSON/client request can invoke it.
    public func rebindForFixture(_ record: SealedRecord, to identity: VolumeIdentity) throws -> SealedRecord {
        try identity.validate()
        let old = record.identity
        guard old.keyVersion < UInt64.max, identity.keyVersion == old.keyVersion + 1,
              identity.homeId == old.homeId,
              identity.workspaceId == old.workspaceId, identity.volumeId == old.volumeId,
              identity.creationId == old.creationId, identity.purpose == old.purpose,
              identity.formatVersion == old.formatVersion else { throw BrokerFailure.invalidTransition }
        var material = try verifiedMaterial(record)
        defer { wipe(&material) }
        let rebound = try seal(material, identity: identity, using: wrappingKey)
        current[identity.volumeId] = rebound
        return rebound
    }
    /// In-memory atomic replacement only: durable crash/rollback recovery and
    /// Keychain KEK custody remain production gates. Disk keys do not rotate.
    public func rotateWrappingKeyForFixture() throws -> [SealedRecord] {
        let nextKey = SymmetricKey(size: .bits256)
        var next: [String: SealedRecord] = [:]
        for old in current.values {
            let value = old.identity
            guard value.keyVersion < UInt64.max else { throw BrokerFailure.invalidTransition }
            let identity = try VolumeIdentity(homeId: value.homeId, homePath: value.homePath,
                homeDevice: value.homeDevice, homeInode: value.homeInode, workspaceId: value.workspaceId,
                volumeId: value.volumeId, creationId: value.creationId, keyVersion: value.keyVersion + 1,
                formatVersion: value.formatVersion, purpose: value.purpose)
            var material = try verifiedMaterial(old)
            defer { wipe(&material) }
            next[identity.volumeId] = try seal(material, identity: identity, using: nextKey)
        }
        wrappingKey = nextKey
        current = next
        return next.values.sorted { $0.identity.volumeId < $1.identity.volumeId }
    }
    public func proofMatches(_ proof: Data, record: SealedRecord, challenge: Data) throws -> Bool {
        var material = try verifiedMaterial(record)
        defer { wipe(&material) }
        return HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: challenge, using: SymmetricKey(data: material))
    }
    public func fixtureKeysDistinct(_ records: [SealedRecord]) throws -> Bool {
        let fingerprints = try records.map { record in
            var material = try verifiedMaterial(record)
            defer { wipe(&material) }
            return Data(SHA256.hash(data: material))
        }
        return Set(fingerprints).count == fingerprints.count
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
