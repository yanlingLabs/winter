import Foundation
import CryptoKit

/// The list of relay endpoints a phone falls back to when it can't reach the Mac directly.
/// `version` is a strictly-increasing anti-rollback counter — see `RelayConfigStore.accept`.
public struct RelayConfig: Codable, Equatable {
    public let version: Int
    public let relays: [String]

    public init(version: Int, relays: [String]) {
        self.version = version
        self.relays = relays
    }
}

/// A `RelayConfig` plus an Ed25519 signature over it. This is what actually ships to a phone
/// (embedded in the pairing QR code, or pushed later as a config update) — the phone never
/// trusts a bare `RelayConfig`.
public struct SignedRelayConfig: Codable, Equatable {
    public let config: RelayConfig
    public let sig: Data

    public init(config: RelayConfig, sig: Data) {
        self.config = config
        self.sig = sig
    }

    /// Verifies `sig` against `config` under `publicKey`. Returns `false` (never throws) for
    /// any failure — a malformed public key is just another way to fail verification.
    public func verify(publicKey: Data) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else {
            return false
        }
        return key.isValidSignature(sig, for: RelayConfigSigner.signingPayload(for: config))
    }
}

/// Signs a `RelayConfig` with the Norma relay-config Ed25519 key (the private half lives in the
/// login Keychain in production — see `scripts/sign-relay-config.ts` — and only as a hardcoded
/// test seed in this package's tests).
public enum RelayConfigSigner {
    /// Domain-separates relay-config signatures from every other signature/MAC in the system.
    static let domain = Data("norma-relay-config/1".utf8)

    /// The canonical-CBOR map `{relays: [tstr], version: uint}` — this is BOTH what gets signed
    /// (domain-prefixed) AND the exact shape `QRPayload` nests as its `relayConfig.config`
    /// field, so the two can never quietly drift apart.
    static func canonicalMap(_ config: RelayConfig) -> CBORValue {
        .map([
            ("relays", .array(config.relays.map { .text($0) })),
            ("version", .uint(UInt64(config.version))),
        ])
    }

    static func signingPayload(for config: RelayConfig) -> Data {
        domain + CanonicalCBOR.encode(canonicalMap(config))
    }

    public static func sign(config: RelayConfig, privateKey: Data) throws -> SignedRelayConfig {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKey)
        let sig = try key.signature(for: signingPayload(for: config))
        return SignedRelayConfig(config: config, sig: sig)
    }
}

/// Guards the one config a phone (or Mac) keeps on disk: a new `SignedRelayConfig` is only
/// adopted if its signature checks out AND its version is strictly greater than the config
/// currently in effect — an attacker (or a bug) that replays an old, validly-signed config
/// can never roll a device back to stale/compromised relays.
public enum RelayConfigStore {
    /// Returns the new config to persist, or `nil` if `new` should be rejected (bad signature,
    /// or `new.config.version` doesn't strictly exceed `current`'s — `current: nil` is treated
    /// as version `-1`, so any non-negative version is accepted on first pairing).
    public static func accept(_ new: SignedRelayConfig, current: RelayConfig?, publicKey: Data) -> RelayConfig? {
        guard new.verify(publicKey: publicKey) else { return nil }
        guard new.config.version > (current?.version ?? -1) else { return nil }
        return new.config
    }
}
