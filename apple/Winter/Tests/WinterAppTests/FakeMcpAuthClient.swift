import Foundation
import WinterKit

/// Hand-written `McpAuthClient` test double — WS-25 (MCP OAuth). Shared by
/// `McpSignInSheetModelTests`/`McpSignOutSheetModelTests`/`McpClientSecretSheetModelTests`/
/// `McpOAuthActionsModelTests`. Scripts every call by hand (no socket/transport involved) — the
/// owning models are built around the `McpAuthClient` PROTOCOL precisely so they don't need
/// `LiveMcpAuthClientTests`'s wire-level machinery.
///
/// `@unchecked Sendable` mirrors `FakeAnthropicAuthClient`'s own posture beside this file — every
/// mutation happens on the main actor under `await`, cooperatively.
final class FakeMcpAuthClient: McpAuthClient, @unchecked Sendable {
    struct SimpleError: Error, Equatable {}

    // login(name:)
    var loginResult: Result<McpLoginStart, Error> = .success(
        McpLoginStart(loginId: "lg_1", authUrl: URL(string: "https://example.test/authorize?state=abc")!,
                      issuerOrigin: "https://example.test")
    )
    private(set) var loginCalls: [String] = []

    // loginStatus(loginId:) — a QUEUE, so a test can script a sequence of polls.
    var loginStatusResults: [Result<McpLoginStatus, Error>] = [.success(McpLoginStatus(state: .pending))]
    private(set) var loginStatusCalls: [String] = []

    // logout(name:forgetClient:)
    var logoutResult: Result<Void, Error> = .success(())
    private(set) var logoutCalls: [(name: String, forgetClient: Bool?)] = []

    // setClientSecret(name:secret:)
    var setClientSecretResult: Result<Void, Error> = .success(())
    private(set) var setClientSecretCalls: [(name: String, secret: String)] = []

    func login(name: String) async throws -> McpLoginStart {
        loginCalls.append(name)
        return try loginResult.get()
    }

    func loginStatus(loginId: String) async throws -> McpLoginStatus {
        loginStatusCalls.append(loginId)
        // The LAST scripted result repeats once the queue runs out, so a test only has to script
        // as many distinct answers as it cares about and can still poll past them without a crash.
        let result = loginStatusResults.count > loginStatusCalls.count - 1
            ? loginStatusResults[loginStatusCalls.count - 1]
            : (loginStatusResults.last ?? .success(McpLoginStatus(state: .pending)))
        return try result.get()
    }

    func logout(name: String, forgetClient: Bool?) async throws {
        logoutCalls.append((name, forgetClient))
        try logoutResult.get()
    }

    func setClientSecret(name: String, secret: String) async throws {
        setClientSecretCalls.append((name, secret))
        try setClientSecretResult.get()
    }
}
