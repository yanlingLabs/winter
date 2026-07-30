import Foundation
import Security
import XCTest
@testable import NormaChatKit

/// `ChatKeychain` — where the phone's OWN OpenAI credentials live (never the Mac's, never the
/// pairing identity's). The behavioural tests drive a `KeychainStore` spy so they are hermetic;
/// the SecItem query shapes (above all the accessibility class) are asserted directly on the
/// query builders, and exactly one opt-in test touches the real Keychain.
final class ChatKeychainTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - service identity

    /// Distinct services keep three unrelated credentials from ever colliding: the daemon/pairing
    /// identity (`com.norma.core`, NormaKit), the phone's ChatGPT tokens, and the Exa key.
    func testServiceNamesArePinned() {
        XCTAssertEqual(ChatKeychain.openAIService, "com.norma.chat.openai")
        XCTAssertEqual(ChatKeychain.exaService, "com.norma.chat.exa")
        XCTAssertNotEqual(ChatKeychain.openAIService, "com.norma.core")
    }

    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by background work after the
    /// first unlock, and NEVER migrated to another device by a backup or restore.
    func testAddQueryPinsAccessibilityAndNeverSyncs() {
        let query = SystemKeychainStore.addQuery(service: "svc", account: "acct", data: Data("x".utf8))
        XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(query[kSecAttrService as String] as? String, "svc")
        XCTAssertEqual(query[kSecAttrAccount as String] as? String, "acct")
        XCTAssertEqual(query[kSecValueData as String] as? Data, Data("x".utf8))
        XCTAssertEqual(query[kSecAttrAccessible as String] as? String,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    func testLookupQueryAsksForOneItemsData() {
        let query = SystemKeychainStore.lookupQuery(service: "svc", account: "acct")
        XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(query[kSecAttrService as String] as? String, "svc")
        XCTAssertEqual(query[kSecAttrAccount as String] as? String, "acct")
        XCTAssertEqual(query[kSecReturnData as String] as? Bool, true)
        XCTAssertEqual(query[kSecMatchLimit as String] as? String, kSecMatchLimitOne as String)
    }

    // MARK: - token round-trip

    func testTokensRoundTrip() throws {
        let spy = SpyKeychainStore()
        let keychain = ChatKeychain(store: spy)
        let tokens = TokenState(accessToken: "at_1", refreshToken: "rt_1",
                                idToken: "id_1", accountId: "acct_42",
                                expiresAt: t0.addingTimeInterval(3600))
        try keychain.storeTokens(tokens)
        XCTAssertEqual(try keychain.loadTokens(), tokens)
    }

    func testLoadTokensIsNilBeforeSignIn() throws {
        XCTAssertNil(try ChatKeychain(store: SpyKeychainStore()).loadTokens())
    }

    func testStoreTokensOverwrites() throws {
        let spy = SpyKeychainStore()
        let keychain = ChatKeychain(store: spy)
        try keychain.storeTokens(TokenState(accessToken: "at_1", expiresAt: t0))
        try keychain.storeTokens(TokenState(accessToken: "at_2", expiresAt: t0))
        XCTAssertEqual(try keychain.loadTokens()?.accessToken, "at_2")
    }

    /// The persisted blob keeps the TS store's units — `expiresAt` is epoch MILLISECONDS, the same
    /// number `codex-oauth.ts` writes, not Foundation's since-2001 default.
    func testStoredBlobUsesEpochMillisLikeTheDaemonStore() throws {
        let spy = SpyKeychainStore()
        try ChatKeychain(store: spy).storeTokens(
            TokenState(accessToken: "at_1", refreshToken: "rt_1", idToken: "id_1",
                       accountId: "acct_42", expiresAt: t0))
        let raw = try XCTUnwrap(spy.items[Key(service: "com.norma.chat.openai", account: "codex-tokens")])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(json["accessToken"] as? String, "at_1")
        XCTAssertEqual(json["refreshToken"] as? String, "rt_1")
        XCTAssertEqual(json["idToken"] as? String, "id_1")
        XCTAssertEqual(json["accountId"] as? String, "acct_42")
        XCTAssertEqual(json["expiresAt"] as? Int64, 1_700_000_000_000)
    }

    /// A blob we can't parse means "not signed in" — the app re-runs the flow rather than
    /// bricking on a corrupt item.
    func testCorruptBlobReadsAsSignedOut() throws {
        let spy = SpyKeychainStore()
        spy.items[Key(service: "com.norma.chat.openai", account: "codex-tokens")] = Data("garbage".utf8)
        XCTAssertNil(try ChatKeychain(store: spy).loadTokens())
    }

    func testClearRemovesTheTokens() throws {
        let spy = SpyKeychainStore()
        let keychain = ChatKeychain(store: spy)
        try keychain.storeTokens(TokenState(accessToken: "at_1", expiresAt: t0))
        try keychain.clear()
        XCTAssertNil(try keychain.loadTokens())
        XCTAssertTrue(spy.deletes.contains(Key(service: "com.norma.chat.openai", account: "codex-tokens")))
    }

    /// Signing out of ChatGPT must not throw away the user's Exa key (a separate credential with
    /// its own lifecycle, synced from the Mac in Task 12).
    func testClearLeavesTheExaKeyAlone() throws {
        let spy = SpyKeychainStore()
        let keychain = ChatKeychain(store: spy)
        try keychain.storeTokens(TokenState(accessToken: "at_1", expiresAt: t0))
        try keychain.storeExaKey("exa_abc")
        try keychain.clear()
        XCTAssertNil(try keychain.loadTokens())
        XCTAssertEqual(try keychain.loadExaKey(), "exa_abc")
    }

    // MARK: - Exa key

    func testExaKeyRoundTripsUnderItsOwnService() throws {
        let spy = SpyKeychainStore()
        let keychain = ChatKeychain(store: spy)
        try keychain.storeExaKey("exa_abc")
        XCTAssertEqual(try keychain.loadExaKey(), "exa_abc")
        XCTAssertNotNil(spy.items[Key(service: "com.norma.chat.exa", account: "exa-api-key")])
        XCTAssertNil(spy.items[Key(service: "com.norma.chat.openai", account: "exa-api-key")])
    }

    func testLoadExaKeyIsNilWhenUnset() throws {
        XCTAssertNil(try ChatKeychain(store: SpyKeychainStore()).loadExaKey())
    }

    func testClearExaKeyRemovesOnlyTheKey() throws {
        let spy = SpyKeychainStore()
        let keychain = ChatKeychain(store: spy)
        try keychain.storeTokens(TokenState(accessToken: "at_1", expiresAt: t0))
        try keychain.storeExaKey("exa_abc")
        try keychain.clearExaKey()
        XCTAssertNil(try keychain.loadExaKey())
        XCTAssertNotNil(try keychain.loadTokens())
    }

    // MARK: - failure propagation

    func testStoreFailurePropagates() {
        let spy = SpyKeychainStore()
        spy.setError = ChatKeychainError.unwritable(errSecIO)
        XCTAssertThrowsError(try ChatKeychain(store: spy).storeTokens(
            TokenState(accessToken: "at_1", expiresAt: t0))) { error in
            XCTAssertEqual(error as? ChatKeychainError, .unwritable(errSecIO))
        }
    }

    func testLoadFailurePropagates() {
        let spy = SpyKeychainStore()
        spy.getError = ChatKeychainError.unreadable(errSecIO)
        XCTAssertThrowsError(try ChatKeychain(store: spy).loadTokens()) { error in
            XCTAssertEqual(error as? ChatKeychainError, .unreadable(errSecIO))
        }
    }

    // MARK: - the one real-Keychain test (opt-in)

    /// Proves `SystemKeychainStore` actually talks to SecItem. OPT-IN only: an unsigned SwiftPM
    /// test binary's Keychain access depends on the machine's signing/ACL state, so this must
    /// never be able to redden a normal `swift test`. It writes under a throwaway service name and
    /// removes it again, so it can never touch the real `com.norma.chat.*` items.
    ///
    ///     NORMA_CHAT_KEYCHAIN_INTEGRATION=1 swift test --filter testRealKeychainRoundTrip
    func testRealKeychainRoundTrip() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["NORMA_CHAT_KEYCHAIN_INTEGRATION"] == "1",
                          "touches the real login Keychain — set NORMA_CHAT_KEYCHAIN_INTEGRATION=1 to run")
        let service = "com.norma.chat.test.\(UUID().uuidString)"
        let store = SystemKeychainStore()
        addTeardownBlock { try? store.delete(service: service, account: "codex-tokens") }

        let keychain = ChatKeychain(store: store, openAIService: service, exaService: service)
        XCTAssertNil(try keychain.loadTokens())
        let tokens = TokenState(accessToken: "at_1", refreshToken: "rt_1",
                                accountId: "acct_42", expiresAt: t0)
        try keychain.storeTokens(tokens)
        XCTAssertEqual(try keychain.loadTokens(), tokens)
        try keychain.storeTokens(TokenState(accessToken: "at_2", expiresAt: t0)) // overwrite path
        XCTAssertEqual(try keychain.loadTokens()?.accessToken, "at_2")
        try keychain.clear()
        XCTAssertNil(try keychain.loadTokens())
    }
}

// MARK: - spy

struct Key: Hashable {
    let service: String
    let account: String
}

final class SpyKeychainStore: KeychainStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Key: Data] = [:]
    private(set) var deletes: [Key] = []
    var setError: Error?
    var getError: Error?

    var items: [Key: Data] {
        get { lock.lock(); defer { lock.unlock() }; return storage }
        set { lock.lock(); storage = newValue; lock.unlock() }
    }

    func set(service: String, account: String, data: Data) throws {
        if let setError { throw setError }
        lock.lock(); storage[Key(service: service, account: account)] = data; lock.unlock()
    }

    func get(service: String, account: String) throws -> Data? {
        if let getError { throw getError }
        lock.lock(); defer { lock.unlock() }
        return storage[Key(service: service, account: account)]
    }

    func delete(service: String, account: String) throws {
        lock.lock()
        let key = Key(service: service, account: account)
        deletes.append(key)
        storage[key] = nil
        lock.unlock()
    }
}
