import Testing
import Foundation
import CryptoKit
@testable import NormaProtocol

/// SP2b Task 2: signed relay config with anti-rollback. `RelayConfig.swift` was implemented
/// alongside `Pairing.swift` (Step 6) rather than strictly after this file, because
/// `QRPayload`'s CBOR shape nests a `SignedRelayConfig` per the brief's own interfaces — so the
/// type had to exist before `PairingCryptoTests.qrPayloadRoundTripsBase64URL` could even
/// compile. This file still exercises it fresh, independent of that dependency.
struct RelayConfigTests {
    @Test func signVerifyAndAntiRollback() throws {
        let key = Curve25519.Signing.PrivateKey()
        let pub = key.publicKey.rawRepresentation
        let v2 = try RelayConfigSigner.sign(config: RelayConfig(version: 2, relays: ["https://relay-1.yanlinglabs.com."]), privateKey: key.rawRepresentation)
        #expect(v2.verify(publicKey: pub))
        #expect(!v2.verify(publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation))
        // fresh accept
        #expect(RelayConfigStore.accept(v2, current: nil, publicKey: pub) == v2.config)
        // higher version accepted
        let v3 = try RelayConfigSigner.sign(config: RelayConfig(version: 3, relays: ["https://relay-2.yanlinglabs.com."]), privateKey: key.rawRepresentation)
        #expect(RelayConfigStore.accept(v3, current: v2.config, publicKey: pub) == v3.config)
        // ROLLBACK refused
        #expect(RelayConfigStore.accept(v2, current: v3.config, publicKey: pub) == nil)
        // bad sig refused
        var forged = v3 // struct copy — tamper relays via a rebuilt value
        forged = SignedRelayConfig(config: RelayConfig(version: 4, relays: ["https://evil"]), sig: v3.sig)
        #expect(RelayConfigStore.accept(forged, current: nil, publicKey: pub) == nil)
    }

    // MARK: - Additional coverage (beyond the brief's literal vector — same spirit)

    @Test func equalVersionIsRollback() throws {
        // Anti-rollback is strict: `version > current`, not `>=` — a replay of the SAME
        // version (even with a valid signature) must be refused, not silently accepted again.
        let key = Curve25519.Signing.PrivateKey()
        let pub = key.publicKey.rawRepresentation
        let v2 = try RelayConfigSigner.sign(config: RelayConfig(version: 2, relays: ["https://relay-1.yanlinglabs.com."]), privateKey: key.rawRepresentation)
        #expect(RelayConfigStore.accept(v2, current: v2.config, publicKey: pub) == nil)
    }

    @Test func negativeVersionAcceptedOnFreshStoreOnlyIfNonNegative() throws {
        // current: nil is treated as version -1, so version 0 is the lowest fresh-accept case.
        let key = Curve25519.Signing.PrivateKey()
        let pub = key.publicKey.rawRepresentation
        let v0 = try RelayConfigSigner.sign(config: RelayConfig(version: 0, relays: []), privateKey: key.rawRepresentation)
        #expect(RelayConfigStore.accept(v0, current: nil, publicKey: pub) == v0.config)
    }

    /// Step 10: a `SignedRelayConfig` produced by `scripts/sign-relay-config.ts --test-vector`
    /// (the hardcoded 0xD4 test seed), pasted verbatim — proves a TS-signed blob verifies under
    /// Swift's CryptoKit Ed25519, i.e. the cross-language signing scheme actually agrees.
    ///
    /// Produced by: `bun run scripts/sign-relay-config.ts --test-vector`, output:
    /// ```json
    /// {
    ///   "config": { "version": 1, "relays": ["https://relay-1.yanlinglabs.com."] },
    ///   "sig": "DDA55Ohlc5DPwT0bvp77IUrvFg80XYRAW5iBjHXHmQX1iXKOxe96gwZpQO0msC4Ct2kAM3a6igXenOzLTKmkCw==",
    ///   "publicKey": "7TI0snbUztpX1ZutFPuvWnc8DzGMmZ3jpg1TxaWzTAU="
    /// }
    /// ```
    @Test func crossLanguageVectorFromTSVerifiesInSwift() throws {
        let publicKeyB64 = "7TI0snbUztpX1ZutFPuvWnc8DzGMmZ3jpg1TxaWzTAU="
        let sigB64 = "DDA55Ohlc5DPwT0bvp77IUrvFg80XYRAW5iBjHXHmQX1iXKOxe96gwZpQO0msC4Ct2kAM3a6igXenOzLTKmkCw=="
        let config = RelayConfig(version: 1, relays: ["https://relay-1.yanlinglabs.com."])
        let signed = SignedRelayConfig(config: config, sig: try #require(Data(base64Encoded: sigB64)))
        let publicKey = try #require(Data(base64Encoded: publicKeyB64))
        #expect(signed.verify(publicKey: publicKey))

        // Also exercise it through the full anti-rollback store, not just raw `verify`.
        #expect(RelayConfigStore.accept(signed, current: nil, publicKey: publicKey) == config)
    }
}
