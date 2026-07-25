import XCTest
import NormaProtocol
@testable import NormaKit

/// SP2b Task 6 Step 4: proves the bundled, committed `relay-config.signed.json` actually verifies
/// against `RelayConfigTrust.productionPublicKey` — i.e. `RemoteAccessCoordinator` (apple/Norma)
/// will NOT silently fall back to direct-only relays at runtime because of a signing mistake.
///
/// Uses ONLY public data: the signed config and its embedded signature are exactly what ships in
/// the app bundle and what any phone's QR carries — none of this is secret. The private signing
/// key itself is never read here (it lives only in the login Keychain of the machine that ran
/// `scripts/sign-relay-config.ts --generate`).
final class RelayConfigTrustTests: XCTestCase {

    /// `apple/NormaKit/Tests/NormaKitTests/RelayConfigTrustTests.swift` -> repo root -> the app's
    /// bundled resource. Mirrors `RealDaemon.cliPackageDir`'s own `#filePath`-relative technique
    /// for finding a path outside this package without hardcoding an absolute one.
    private static var bundledResourceURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // .../NormaKitTests/RelayConfigTrustTests.swift -> .../NormaKitTests
            .deletingLastPathComponent() // .../NormaKitTests -> .../Tests
            .deletingLastPathComponent() // .../Tests -> .../NormaKit
            .deletingLastPathComponent() // .../NormaKit -> .../apple
            .deletingLastPathComponent() // .../apple -> repo root
            .appendingPathComponent("apple/Norma/Resources/relay-config.signed.json")
    }

    private func loadBundledSignedConfig() throws -> SignedRelayConfig {
        let data = try Data(contentsOf: Self.bundledResourceURL)
        return try JSONDecoder().decode(SignedRelayConfig.self, from: data)
    }

    func testBundledConfigVerifiesAgainstProductionPublicKey() throws {
        let signed = try loadBundledSignedConfig()
        XCTAssertTrue(
            signed.verify(publicKey: RelayConfigTrust.productionPublicKey),
            "the committed relay-config.signed.json must verify against RelayConfigTrust.productionPublicKey"
        )
    }

    func testRelayConfigStoreAcceptsTheBundledConfigOnFirstPairing() throws {
        let signed = try loadBundledSignedConfig()
        let accepted = RelayConfigStore.accept(signed, current: nil, publicKey: RelayConfigTrust.productionPublicKey)
        XCTAssertEqual(accepted, signed.config)
    }

    /// ND-T1: the relay fleet has no launch capacity (Oracle drought) — the bundled config is a
    /// deliberate version-2 bump to an EMPTY relay list, so `RemoteHost` homes on iroh's public n0
    /// relays via the designed silent path (empty `relayURLs` -> `.n0Default`, already pinned by
    /// `RemoteHostTests`). The own fleet returns later via another config version bump alone — no
    /// code change. The signing key itself does NOT rotate for this bump (still
    /// `RelayConfigTrust.productionPublicKey`), which the sibling verify test above already covers.
    func testBundledConfigIsVersionTwoWithEmptyRelays() throws {
        let signed = try loadBundledSignedConfig()
        XCTAssertEqual(signed.config.version, 2)
        XCTAssertTrue(signed.config.relays.isEmpty)
    }

    /// A tampered config (even a single byte) must NOT verify — the negative-space complement to
    /// the "it verifies" test above, so a future regression that makes `verify` vacuously `true`
    /// (e.g. an accidentally-inverted boolean) would be caught here.
    func testTamperedConfigFailsVerification() throws {
        let signed = try loadBundledSignedConfig()
        let tampered = SignedRelayConfig(
            config: RelayConfig(version: signed.config.version, relays: signed.config.relays + ["https://evil.example./"]),
            sig: signed.sig
        )
        XCTAssertFalse(tampered.verify(publicKey: RelayConfigTrust.productionPublicKey))
    }
}
