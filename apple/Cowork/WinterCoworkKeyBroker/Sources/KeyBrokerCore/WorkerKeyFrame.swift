import Foundation

public enum WorkerKeyFrame {
    public static let version: UInt32 = 2
    private static let magic = Data([0x57, 0x4b, 0x42, 0x02])
    private static let prefixSize = 10
    private static let headerLimit = 2048
    public struct Decoded {
        public let bootstrap: WorkerBootstrap
        public var material: Data
    }

    public static func encode(_ bootstrap: WorkerBootstrap, material: Data) throws -> Data {
        try bootstrap.validate()
        try bootstrap.identity.keyFormat.validateMaterial(material)
        let header = try JSONEncoder().encode(bootstrap)
        guard header.count < headerLimit else { throw BrokerFailure.invalidFrame }
        var headerLength = UInt32(header.count).bigEndian
        var keyLength = UInt16(material.count).bigEndian
        return magic + withUnsafeBytes(of: &headerLength) { Data($0) } +
            withUnsafeBytes(of: &keyLength) { Data($0) } + header + material
    }

    public static func decode(_ frame: Data) throws -> Decoded {
        guard frame.count >= prefixSize, frame.prefix(4) == magic else { throw BrokerFailure.invalidFrame }
        let headerLength = frame[4..<8].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let keyLength = frame[8..<10].reduce(UInt16(0)) { ($0 << 8) | UInt16($1) }
        guard headerLength > 0, headerLength < headerLimit, Set(VolumeKeyFormat.allCases.map(\.byteCount)).contains(Int(keyLength)),
              frame.count == prefixSize + Int(headerLength) + Int(keyLength) else { throw BrokerFailure.invalidFrame }
        let end = prefixSize + Int(headerLength)
        let bootstrap = try WorkerBootstrap.decode(Data(frame[prefixSize..<end]))
        guard keyLength == bootstrap.keyByteCount,
              Int(keyLength) == bootstrap.identity.keyFormat.byteCount else { throw BrokerFailure.invalidFrame }
        var material = Data(frame[end...])
        do { try bootstrap.identity.keyFormat.validateMaterial(material) }
        catch { wipe(&material);throw error }
        return Decoded(bootstrap: bootstrap, material: material)
    }
}
