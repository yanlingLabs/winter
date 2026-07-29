import Foundation
import Security

public enum KeychainError: Error, Equatable {
    case notFound
    case unreadable(OSStatus)
}

public enum KeychainToken {
    /// Reads the daemon's harness token — the SAME Keychain item the daemon it's paired with
    /// wrote (per-profile: `com.norma.core` for the dist daemon, `com.norma.core.dev` for the dev
    /// daemon — see `service`'s doc below). Bun.secrets({service, name:"harness-token"}) → generic
    /// password with kSecAttrService/kSecAttrAccount. If this read fails at the live gate, inspect
    /// with `security find-generic-password -s <service>` and adjust; norma-probe --token
    /// overrides for unblocked testing. First read triggers one "allow access" prompt.
    ///
    /// - Parameter service: the Keychain service the token was stored under — must match the
    ///   TARGET daemon's `packages/core/src/profile.ts` `keychainService()` (dist `"com.norma.core"`
    ///   vs. dev `"com.norma.core.dev"`). Defaults to the dist literal so every caller that predates
    ///   the dev/dist split keeps its exact byte-for-byte behavior.
    public static func readHarnessToken(service: String = "com.norma.core") throws -> String {
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
    public static func readRemoteToken(service: String = "com.norma.core") throws -> String {
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
}
