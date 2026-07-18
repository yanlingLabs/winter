import Foundation
import Security

public enum KeychainError: Error, Equatable {
    case notFound
    case unreadable(OSStatus)
}

public enum KeychainToken {
    /// Reads the daemon's harness token — the SAME Keychain item the CLI uses.
    /// Bun.secrets({service:"com.norma.core", name:"harness-token"}) → generic password with
    /// kSecAttrService/kSecAttrAccount. If this read fails at the live gate, inspect with
    /// `security find-generic-password -s com.norma.core` and adjust; norma-probe --token
    /// overrides for unblocked testing. First read triggers one "allow access" prompt.
    public static func readHarnessToken() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.norma.core",
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
    /// different Keychain account under the same service.
    public static func readRemoteToken() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.norma.core",
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
