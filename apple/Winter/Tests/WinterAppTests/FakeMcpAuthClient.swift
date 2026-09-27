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

    // login(name:confirmIssuerChange:) — a QUEUE, so a test can script the FIRST call refused
    // `mcp_issuer_change_requires_confirmation` and the RETRY (confirmIssuerChange: true)
    // succeeding, without the two calls sharing one scripted answer.
    var loginResults: [Result<McpLoginStart, Error>] = [.success(
        McpLoginStart(loginId: "lg_1", authUrl: URL(string: "https://example.test/authorize?state=abc")!,
                      issuerOrigin: "https://example.test", authorizeOrigin: "https://example.test")
    )]
    /// Convenience for the common one-scripted-answer case — every existing test that sets this
    /// keeps working unchanged.
    var loginResult: Result<McpLoginStart, Error> {
        get { loginResults[0] }
        set { loginResults = [newValue] }
    }
    private(set) var loginCalls: [(name: String, confirmIssuerChange: Bool)] = []

    // loginStatus(loginId:) — a QUEUE, so a test can script a sequence of polls.
    var loginStatusResults: [Result<McpLoginStatus, Error>] = [.success(McpLoginStatus(state: .pending))]
    private(set) var loginStatusCalls: [String] = []

    // logout(name:forgetClient:)
    var logoutResult: Result<Void, Error> = .success(())
    private(set) var logoutCalls: [(name: String, forgetClient: Bool?)] = []

    // clientSecretIssuer(name:)
    var clientSecretIssuerResult: Result<McpClientSecretIssuer, Error> = .success(
        McpClientSecretIssuer(name: "github", issuer: "https://github.example/issuer",
                              issuerOrigin: "https://github.example", authorizeOrigin: "https://github.example")
    )
    private(set) var clientSecretIssuerCalls: [String] = []

    // setClientSecret(name:secret:expectedIssuer:) — a QUEUE, so a test can script a refusal
    // (mcp_issuer_changed/mcp_expected_issuer_required) followed by the retry's own success.
    var setClientSecretResults: [Result<McpClientSecretSaved, Error>] = [.success(
        McpClientSecretSaved(issuer: "https://example.test/issuer", issuerOrigin: "https://example.test")
    )]
    /// Convenience for the common one-scripted-answer case.
    var setClientSecretResult: Result<McpClientSecretSaved, Error> {
        get { setClientSecretResults[0] }
        set { setClientSecretResults = [newValue] }
    }
    private(set) var setClientSecretCalls: [(name: String, secret: String, expectedIssuer: String)] = []

    func login(name: String, confirmIssuerChange: Bool) async throws -> McpLoginStart {
        let index = loginCalls.count
        loginCalls.append((name, confirmIssuerChange))
        // Same "last scripted answer repeats" posture as `loginStatus` below.
        let result = index < loginResults.count ? loginResults[index] : (loginResults.last ?? .success(
            McpLoginStart(loginId: "lg_1", authUrl: URL(string: "https://example.test/authorize")!,
                          issuerOrigin: "https://example.test", authorizeOrigin: "https://example.test")
        ))
        return try result.get()
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

    func clientSecretIssuer(name: String) async throws -> McpClientSecretIssuer {
        clientSecretIssuerCalls.append(name)
        return try clientSecretIssuerResult.get()
    }

    @discardableResult
    func setClientSecret(name: String, secret: String, expectedIssuer: String) async throws -> McpClientSecretSaved {
        let index = setClientSecretCalls.count
        setClientSecretCalls.append((name, secret, expectedIssuer))
        let result = index < setClientSecretResults.count ? setClientSecretResults[index] : (setClientSecretResults.last ?? .success(
            McpClientSecretSaved(issuer: "https://example.test/issuer", issuerOrigin: "https://example.test")
        ))
        return try result.get()
    }
}
