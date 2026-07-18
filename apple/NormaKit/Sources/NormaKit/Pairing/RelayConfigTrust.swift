import Foundation

/// The production relay-config signing key's PUBLIC half (SP2b Task 6). The private half was
/// generated ONCE via `bun scripts/sign-relay-config.ts --generate` and lives only in the login
/// Keychain (service `com.norma.config-key`, account `relay-config`) on the machine that ran
/// it -- never in this repo, never anywhere else.
///
/// `RemoteAccessCoordinator` verifies the bundled `relay-config.signed.json` app resource against
/// EXACTLY this key (`RelayConfigStore.accept`, NormaProtocol) before trusting ANY relay URL from
/// it -- a config that doesn't verify against this key (wrong signature, or a version that
/// doesn't strictly exceed whatever was last accepted) is rejected outright and the app falls
/// back to `relays: []` (direct-only), never a half-trusted partial config.
///
/// This is PUBLIC data (an Ed25519 public key, not a secret) -- safe to commit, safe to reference
/// from a test (`RelayConfigTrustTests` verifies the bundled resource against it using only
/// public data).
public enum RelayConfigTrust {
    // Generated ONCE via `bun scripts/sign-relay-config.ts --generate` (SP2b Task 6 Step 3) --
    // printed to stdout at generation time, never re-derivable from anything in this repo (the
    // private half lives only in the generating machine's login Keychain). Matches the `publicKey`
    // field inside the committed `apple/Norma/Resources/relay-config.signed.json` /
    // `infra/relay/relay-config.signed.json`.
    public static let productionPublicKey = Data(
        base64Encoded: "BVlZ2wxJtDMWXo+9O8SE/6F9/+ggV5yhE0mL+EuSb5Y="
    )!
}
