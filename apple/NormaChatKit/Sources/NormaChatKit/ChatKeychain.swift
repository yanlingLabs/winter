import Foundation
import Security

/// Where the phone keeps its OWN chat credentials: the ChatGPT tokens it minted itself (never the
/// Mac's) and the Exa key the Mac syncs down (Task 12).
///
/// Three separate Keychain services keep three unrelated credentials from ever being confused for
/// one another: `com.norma.core` is the daemon/pairing identity (NormaKit's `Keychain.swift`),
/// `com.norma.chat.openai` is this device's ChatGPT session, `com.norma.chat.exa` is the search
/// key. Signing out of ChatGPT must not throw away the search key, so `clear()` is scoped.

/// The SecItem seam. Real Keychain access is signing- and ACL-dependent, so every behavioural test
/// drives an in-memory double through this protocol and only one opt-in test touches the real
/// Keychain (`ChatKeychainTests.testRealKeychainRoundTrip`).
public protocol KeychainStore: Sendable {
    func set(service: String, account: String, data: Data) throws
    func get(service: String, account: String) throws -> Data?
    func delete(service: String, account: String) throws
}

public enum ChatKeychainError: Error, Equatable {
    case unwritable(OSStatus)
    case unreadable(OSStatus)
}

public struct SystemKeychainStore: KeychainStore {
    public init() {}

    /// Delete-then-add: `SecItemAdd` fails with `errSecDuplicateItem` on an existing account, and
    /// an update path would leave a stale `kSecAttrAccessible` behind.
    public func set(service: String, account: String, data: Data) throws {
        SecItemDelete(Self.identityQuery(service: service, account: account) as CFDictionary)
        let status = SecItemAdd(Self.addQuery(service: service, account: account, data: data) as CFDictionary, nil)
        guard status == errSecSuccess else { throw ChatKeychainError.unwritable(status) }
    }

    public func get(service: String, account: String) throws -> Data? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(
            Self.lookupQuery(service: service, account: account) as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw ChatKeychainError.unreadable(status)
        }
        return data
    }

    public func delete(service: String, account: String) throws {
        let status = SecItemDelete(Self.identityQuery(service: service, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ChatKeychainError.unwritable(status)
        }
    }

    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: reachable by background work once the
    /// user has unlocked since boot, and — the part that matters — NEVER carried to another device
    /// by an encrypted backup or a device transfer. A synced OAuth token is a second signed-in
    /// device nobody chose.
    static func addQuery(service: String, account: String, data: Data) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
    }

    static func lookupQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
    }

    /// The item's identity only — what `SecItemDelete` matches on.
    static func identityQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

public struct ChatKeychain: Sendable {
    public static let openAIService = "com.norma.chat.openai"
    public static let exaService = "com.norma.chat.exa"
    public static let tokensAccount = "codex-tokens"
    public static let exaKeyAccount = "exa-api-key"

    private let store: KeychainStore
    private let openAIService: String
    private let exaService: String

    /// The service overrides exist for the opt-in integration test, which writes under a throwaway
    /// service name so it can never disturb the real items.
    public init(store: KeychainStore = SystemKeychainStore(),
                openAIService: String = ChatKeychain.openAIService,
                exaService: String = ChatKeychain.exaService) {
        self.store = store
        self.openAIService = openAIService
        self.exaService = exaService
    }

    // MARK: - ChatGPT tokens

    public func storeTokens(_ tokens: TokenState) throws {
        try store.set(service: openAIService, account: Self.tokensAccount,
                      data: try JSONEncoder().encode(tokens))
    }

    /// `nil` means "not signed in". A blob we cannot parse reads the same way ON PURPOSE: the
    /// recovery for a corrupt item is to sign in again, and throwing here would strand the app on
    /// a credential the user has no way to inspect. A Keychain FAILURE (as opposed to a missing or
    /// unreadable item) still propagates — that is a condition the caller must see.
    public func loadTokens() throws -> TokenState? {
        guard let data = try store.get(service: openAIService, account: Self.tokensAccount) else {
            return nil
        }
        return try? JSONDecoder().decode(TokenState.self, from: data)
    }

    /// Signs out of ChatGPT. Deliberately scoped to the tokens — `clearExaKey()` is separate.
    public func clear() throws {
        try store.delete(service: openAIService, account: Self.tokensAccount)
    }

    // MARK: - Exa key (Task 12 consumes)

    public func storeExaKey(_ key: String) throws {
        try store.set(service: exaService, account: Self.exaKeyAccount, data: Data(key.utf8))
    }

    public func loadExaKey() throws -> String? {
        guard let data = try store.get(service: exaService, account: Self.exaKeyAccount) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    public func clearExaKey() throws {
        try store.delete(service: exaService, account: Self.exaKeyAccount)
    }
}
