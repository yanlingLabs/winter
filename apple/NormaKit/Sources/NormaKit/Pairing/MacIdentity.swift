import Foundation
import Security
import os

/// Where the Mac's 32-byte endpoint-identity secret lives between launches. Two implementations:
/// the real Keychain (production) and an in-memory stand-in (every test in this package —
/// CLAUDE.md's hard rule is that tests must never touch the live Keychain).
///
/// Deliberately synchronous (not `async`) — Keychain access is itself synchronous, and keeping
/// this protocol non-async means `InMemoryEndpointSecretStore` can be a plain lock-guarded struct
/// rather than an actor (an actor's isolated methods can't satisfy a synchronous, non-async
/// protocol requirement).
public protocol EndpointSecretStore: Sendable {
    func load() throws -> Data?
    func save(_ secret: Data) throws
}

/// The real Keychain-backed store: service `com.norma.remote`, account `endpoint-secret`,
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (readable once the user has unlocked since
/// boot; never synced to iCloud/other devices — `kSecAttrSynchronizable` is simply omitted, which
/// defaults to false). NEVER logs the secret it loads or saves (CLAUDE.md: no print/os_log of
/// pairSecret/endpoint secrets anywhere).
///
/// Deliberately thin and NOT unit-tested (per the task brief) — exercising it would touch the
/// real Keychain, which every test in this package must avoid. It's exercised at the live gate
/// instead; kept short enough here to review by eye.
public struct KeychainEndpointSecretStore: EndpointSecretStore {
    private static let service = "com.norma.remote"
    private static let account = "endpoint-secret"

    public init() {}

    public func load() throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw KeychainError.unreadable(status)
        }
        return data
    }

    public func save(_ secret: Data) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
        // Delete-then-add rather than SecItemUpdate: this is a write-once-in-practice path
        // (`MacIdentity.loadOrCreate` only calls `save` the first time `load` finds nothing), so
        // the extra branching an update-if-exists path would need isn't worth it.
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = secret
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unreadable(status) }
    }
}

/// Test double standing in for the Keychain — every `MacIdentity`/`PairingManager` test in this
/// package uses this, never `KeychainEndpointSecretStore`. A plain lock-guarded struct (not an
/// actor: see `EndpointSecretStore`'s header comment on why) using the same
/// `OSAllocatedUnfairLock` pattern as `ScriptedRemoteConn` (RemoteTransport.swift) — the lock
/// guards only the synchronous read/write, never held across an `await`.
public struct InMemoryEndpointSecretStore: EndpointSecretStore {
    private let box = OSAllocatedUnfairLock<Data?>(initialState: nil)
    public init() {}
    public func load() throws -> Data? { box.withLock { $0 } }
    public func save(_ secret: Data) throws { box.withLock { $0 = secret } }
}

/// This Mac's endpoint identity: 32 random bytes, generated once and persisted thereafter. NOT a
/// Curve25519 keypair — iroh derives the endpoint's actual node id/public key from this raw
/// secret when the endpoint is bound (Task 4's `IrohListener.start(secret:...)` takes exactly
/// this `secret` as its `secretKey:` argument). Task 3's job is only to generate and persist it.
public struct MacIdentity: Sendable {
    public let secret: Data

    /// Loads the persisted secret from `store`, or generates a fresh 32 random bytes (via
    /// `SecRandomCopyBytes`) and persists them the first time there's nothing to load. Idempotent
    /// — every subsequent call against the same store returns the same secret.
    public static func loadOrCreate(store: EndpointSecretStore) throws -> MacIdentity {
        if let existing = try store.load() {
            return MacIdentity(secret: existing)
        }
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes { buf in
            SecRandomCopyBytes(kSecRandomDefault, 32, buf.baseAddress!)
        }
        guard status == errSecSuccess else { throw KeychainError.unreadable(status) }
        try store.save(bytes)
        return MacIdentity(secret: bytes)
    }
}
