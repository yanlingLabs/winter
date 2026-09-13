import WinterKit

/// Hand-written `AnthropicAuthClient` test double — Winter Phase 10a Tasks A1/A2. Shared by
/// `AnthropicAuthSectionModelTests` and `AnthropicLoginSheetModelTests`. Scripts every call by hand
/// (no socket/transport involved) — `AnthropicAuthSectionModel`/`AnthropicLoginSheetModel` are
/// built around the `AnthropicAuthClient` PROTOCOL precisely so they don't need
/// `ProviderPaneModelTests`'s `FeedScriptedTransport` machinery (that's `WinterClient`'s own seam).
///
/// `@unchecked Sendable` mirrors this target's existing fake-double posture (`AppScriptedTransport`,
/// `DetachedScriptedTransport`, `NeverOpensTransport`, …) — every mutation happens on the main actor
/// under `await`, cooperatively, same as those.
final class FakeAnthropicAuthClient: AnthropicAuthClient, @unchecked Sendable {
    struct SimpleError: Error, Equatable {}

    // status()
    var statusResult: Result<AnthropicAuthStatus, Error> = .success(
        AnthropicAuthStatus(apiKey: false, consoleProfile: false, auth: "auto", effective: "none")
    )
    private(set) var statusCallCount = 0

    // configureAuth(_:)
    var configureAuthResult: Result<Void, Error> = .success(())
    private(set) var configureAuthCalls: [AnthropicAuthMode] = []

    // login()
    var loginResult: Result<Void, Error> = .success(())
    private(set) var loginCallCount = 0

    // submitLoginCode(_:)
    var submitLoginCodeResult: Result<Void, Error> = .success(())
    private(set) var submitLoginCodeCalls: [String] = []

    // logout()
    var logoutResult: Result<Void, Error> = .success(())
    private(set) var logoutCallCount = 0

    // loginUpdates() — one continuation, matching the real client's "one live stream" shape.
    private var updatesContinuation: AsyncStream<AnthropicLoginEvent>.Continuation?

    func status() async throws -> AnthropicAuthStatus {
        statusCallCount += 1
        return try statusResult.get()
    }

    func configureAuth(_ mode: AnthropicAuthMode) async throws {
        configureAuthCalls.append(mode)
        try configureAuthResult.get()
    }

    func login() async throws {
        loginCallCount += 1
        try loginResult.get()
    }

    func submitLoginCode(_ code: String) async throws {
        submitLoginCodeCalls.append(code)
        try submitLoginCodeResult.get()
    }

    func logout() async throws {
        logoutCallCount += 1
        try logoutResult.get()
    }

    func loginUpdates() -> AsyncStream<AnthropicLoginEvent> {
        AsyncStream { continuation in
            self.updatesContinuation = continuation
        }
    }

    /// Test helper: push a fake update to whatever subscribed via `loginUpdates()`. A no-op if
    /// nothing has subscribed yet — callers that need the emit to land should await a beat after
    /// `start()`/`loginUpdates()` first (mirrors how a real daemon's events would simply not have a
    /// listener yet either).
    func emit(_ event: AnthropicLoginEvent) {
        updatesContinuation?.yield(event)
    }

    func finishUpdates() {
        updatesContinuation?.finish()
    }
}
