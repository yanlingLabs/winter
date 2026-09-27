import Foundation
import Security

public enum KeychainError: Error, Equatable {
    case notFound
    case unreadable(OSStatus)
}

public enum KeychainToken {
    /// Reads the daemon's harness token — the SAME Keychain item the daemon it's paired with
    /// wrote (per-profile: `com.winter.core` for the dist daemon, `com.winter.core.dev` for the dev
    /// daemon — see `service`'s doc below). Bun.secrets({service, name:"harness-token"}) → generic
    /// password with kSecAttrService/kSecAttrAccount. If this read fails at the live gate, inspect
    /// with `security find-generic-password -s <service>` and adjust; winter-probe --token
    /// overrides for unblocked testing. First read triggers one "allow access" prompt.
    ///
    /// - Parameter service: the Keychain service the token was stored under — must match the
    ///   TARGET daemon's `packages/core/src/profile.ts` `keychainService()` (dist `"com.winter.core"`
    ///   vs. dev `"com.winter.core.dev"`). Defaults to the dist literal so every caller that predates
    ///   the dev/dist split keeps its exact byte-for-byte behavior.
    public static func readHarnessToken(service: String = "com.winter.core") throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "harness-token",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status != errSecItemNotFound else { throw KeychainError.notFound }
        guard status == errSecSuccess, let data = item as? Data,
              let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            throw KeychainError.unreadable(status)
        }
        return token
    }

    /// Reads the daemon's `remote` principal token (packages/core/src/auth/tokens.ts's
    /// `TOKEN_NAMES.remote`) — the local gateway process's own credential for connecting to the
    /// daemon as the least-privileged phone-gateway role. Identical to `readHarnessToken`, just a
    /// different Keychain account under the same (per-profile) service — see its `service`
    /// parameter doc for the dev/dist contract.
    public static func readRemoteToken(service: String = "com.winter.core") throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "remote-token",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status != errSecItemNotFound else { throw KeychainError.notFound }
        guard status == errSecSuccess, let data = item as? Data,
              let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            throw KeychainError.unreadable(status)
        }
        return token
    }

    /// Bounded retry around a token read that may have raced the daemon's own once-per-boot ACL
    /// refresh: `winter-core` deletes and re-adds `harness-token`/`remote-token` with a new ACL (so
    /// the app can read them without a consent prompt) once per daemon boot. A read landing in that
    /// brief window sees `.notFound` even though the daemon has run, or is seconds from finishing —
    /// without this, `AppModel.production()`/`AppDelegate.boot()` and `RemoteHost`'s gateway-token
    /// read both took that as "the daemon has never run" and degraded (`tokenMissing` / a pairing
    /// failure) with no retry short of relaunching.
    ///
    /// Retries ONLY `KeychainError.notFound`. `.unreadable` (a malformed item, a denied ACL) is a
    /// REAL problem blind retrying will not fix, and propagates immediately, same as any other
    /// thrown error `read` produces — this function never widens what it catches.
    ///
    /// **Never mints or creates a token.** `read` is the caller's own `readHarnessToken`/
    /// `readRemoteToken` (or a fake in a test) — every attempt is a plain re-read of whatever the
    /// daemon itself already wrote; this function adds patience, not material.
    ///
    /// `delays` defaults to five backoffs summing to ~5 seconds (item's own "a few times over ~5 s
    /// with backoff") — six reads in total (the first attempt plus five retries) before giving up
    /// and rethrowing `.notFound`, at which point the caller's EXISTING "no token yet" fallback
    /// applies unchanged. `sleep` is synchronous and BLOCKING by default
    /// (`Thread.sleep(forTimeInterval:)`) rather than `Task.sleep` — this helper is called from both
    /// a fully synchronous site (`AppModel.production()`, itself called from `AppDelegate.boot()`,
    /// which is not `async`) and an `async` one (`RemoteHost`'s gateway start), and a single
    /// synchronous implementation is what both can share without `AppModel`/`AppDelegate.boot()`
    /// growing an async boot path just for this one, rare, bounded race. Injectable so a test never
    /// blocks real wall-clock time.
    public static func readWithBoundedRetry<T>(
        delays: [TimeInterval] = [0.25, 0.5, 1.0, 1.5, 1.75],
        sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
        read: () throws -> T
    ) throws -> T {
        var attempt = 0
        while true {
            do {
                return try read()
            } catch KeychainError.notFound {
                guard attempt < delays.count else { throw KeychainError.notFound }
                sleep(delays[attempt])
                attempt += 1
            }
        }
    }
}
