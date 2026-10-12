import Foundation
import CryptoKit

/// Closed fixture registry. A format ID selects exact material semantics;
/// caller-supplied lengths/layouts cannot change it. Neither profile is a
/// production storage approval or a key-lifetime/migration policy.
public enum VolumeKeyFormat: String, Codable, Sendable, CaseIterable {
    case fixtureRaw256V1 = "fixture-raw-256-v1"
    case luks2AES256XTSHMACSHA256V1 = "luks2-aes256-xts-random-hmac-sha256-v1"

    public var byteCount: Int {
        switch self {
        case .fixtureRaw256V1: return 32
        case .luks2AES256XTSHMACSHA256V1: return 96
        }
    }
    public var layout: String {
        switch self {
        case .fixtureRaw256V1: return "fixture-direct-material:32"
        case .luks2AES256XTSHMACSHA256V1: return "aes-data:32|aes-tweak:32|hmac-sha256:32"
        }
    }
    public func validateMaterial(_ material: Data) throws {
        guard material.count == byteCount else { throw BrokerFailure.invalidKeyMaterial }
        if self == .luks2AES256XTSHMACSHA256V1 {
            let equal = material.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) -> Bool in
                var difference: UInt8 = 0
                for offset in 0..<32 { difference |= bytes[offset] ^ bytes[offset + 32] }
                return difference == 0
            }
            guard !equal else { throw BrokerFailure.invalidKeyMaterial }
        }
    }
    func generateForFixture(randomComponent: () -> Data = {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }) throws -> Data {
        var material = Data()
        do {
            for _ in 0..<(byteCount / 32) {
                var component = randomComponent()
                defer { wipe(&component) }
                guard component.count == 32 else { throw BrokerFailure.invalidKeyMaterial }
                material.append(component)
            }
            try validateMaterial(material)
            return material
        } catch {
            wipe(&material)
            throw error
        }
    }
}
