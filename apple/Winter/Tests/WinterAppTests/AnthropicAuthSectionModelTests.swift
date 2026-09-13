import XCTest
import WinterKit
@testable import Winter

/// Winter Phase 10a Task A1: `AnthropicAuthSectionModel`'s option→setting mapping, the disabled
/// "Claude subscription" row, and the status-line text across `effective`/`apiKey`/`consoleProfile`
/// combinations. Drives the model against `FakeAnthropicAuthClient` directly — no
/// `WinterClient`/transport involved, since this model depends on the `AnthropicAuthClient`
/// protocol precisely so it can be tested this way (see that file's header comment).
@MainActor
final class AnthropicAuthSectionModelTests: XCTestCase {
    private func status(apiKey: Bool = false, consoleProfile: Bool = false, auth: String = "auto", effective: String = "none") -> AnthropicAuthStatus {
        AnthropicAuthStatus(apiKey: apiKey, consoleProfile: consoleProfile, auth: auth, effective: effective)
    }

    // MARK: - option ↔ setting mapping

    /// Selecting "API key" calls `configureAuth(.apiKey)` — the wire value `provider.configure`
    /// eventually turns into `runtimes.official.auth = "api-key"` (P10a-3).
    func testSelectApiKeyCallsConfigureAuthWithApiKeyMode() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicAuthSectionModel(client: fake)

        await model.select(.apiKey)

        XCTAssertEqual(fake.configureAuthCalls, [.apiKey])
    }

    /// Selecting "Console login" calls `configureAuth(.console)`.
    func testSelectConsoleCallsConfigureAuthWithConsoleMode() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicAuthSectionModel(client: fake)

        await model.select(.console)

        XCTAssertEqual(fake.configureAuthCalls, [.console])
    }

    /// A successful `select` clears any prior error and refreshes status (one extra `status()`
    /// call beyond `init`'s zero — this model never auto-fetches on construction, only when asked).
    func testSelectRefreshesStatusOnSuccess() async {
        let fake = FakeAnthropicAuthClient()
        fake.statusResult = .success(status(apiKey: true, auth: "api-key", effective: "api-key"))
        let model = AnthropicAuthSectionModel(client: fake)

        await model.select(.apiKey)

        XCTAssertEqual(fake.statusCallCount, 1)
        XCTAssertNil(model.selectErrorText)
        XCTAssertEqual(model.statusText, "API key")
    }

    /// A thrown `configureAuth` surfaces as `selectErrorText` and never triggers a status refresh.
    func testSelectErrorSurfacesWithoutRefreshingStatus() async {
        let fake = FakeAnthropicAuthClient()
        fake.configureAuthResult = .failure(FakeAnthropicAuthClient.SimpleError())
        let model = AnthropicAuthSectionModel(client: fake)

        await model.select(.console)

        XCTAssertNotNil(model.selectErrorText)
        XCTAssertEqual(fake.statusCallCount, 0, "a failed configure must not trigger a status refresh")
    }

    // MARK: - disabled subscription

    /// "Claude subscription" is disabled (P9c-1) — selecting it must never call `configureAuth`,
    /// even if the view's own `.disabled(true)` were somehow bypassed.
    func testSelectSubscriptionNeverCallsConfigureAuth() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicAuthSectionModel(client: fake)

        await model.select(.subscription)

        XCTAssertTrue(fake.configureAuthCalls.isEmpty)
        XCTAssertEqual(fake.statusCallCount, 0)
    }

    // MARK: - selectedOption reflects the daemon's reported auth/effective

    func testSelectedOptionReflectsExplicitApiKeyAuth() async {
        let fake = FakeAnthropicAuthClient()
        fake.statusResult = .success(status(apiKey: true, auth: "api-key", effective: "api-key"))
        let model = AnthropicAuthSectionModel(client: fake)

        await model.refreshStatus()

        XCTAssertEqual(model.selectedOption, .apiKey)
    }

    func testSelectedOptionReflectsExplicitConsoleAuth() async {
        let fake = FakeAnthropicAuthClient()
        fake.statusResult = .success(status(consoleProfile: true, auth: "console", effective: "console"))
        let model = AnthropicAuthSectionModel(client: fake)

        await model.refreshStatus()

        XCTAssertEqual(model.selectedOption, .console)
    }

    /// `"auto"` (the untouched default) has no radio of its own — the brief: "'auto' is the
    /// untouched default shown as whichever is effective".
    func testSelectedOptionUnderAutoFollowsEffective() async {
        let fake = FakeAnthropicAuthClient()
        fake.statusResult = .success(status(consoleProfile: true, auth: "auto", effective: "console"))
        let model = AnthropicAuthSectionModel(client: fake)

        await model.refreshStatus()

        XCTAssertEqual(model.selectedOption, .console)
    }

    // MARK: - status text for the four `effective` × `apiKey`/`consoleProfile` combinations

    func testStatusTextWhenEffectiveIsApiKey() {
        let s = status(apiKey: true, consoleProfile: false, auth: "api-key", effective: "api-key")
        XCTAssertEqual(anthropicAuthStatusText(s), "API key")
    }

    func testStatusTextWhenEffectiveIsConsole() {
        let s = status(apiKey: false, consoleProfile: true, auth: "console", effective: "console")
        XCTAssertEqual(anthropicAuthStatusText(s), "signed in (Console)")
    }

    func testStatusTextWhenEffectiveIsNone() {
        let s = status(apiKey: false, consoleProfile: false, auth: "auto", effective: "none")
        XCTAssertEqual(anthropicAuthStatusText(s), "not configured")
    }

    /// Both credentials present at once (a user who's done both flows) — `effective` still decides
    /// the text alone, never a "both" phrasing.
    func testStatusTextWhenBothCredentialsExistFollowsEffectiveOnly() {
        let s = status(apiKey: true, consoleProfile: true, auth: "console", effective: "console")
        XCTAssertEqual(anthropicAuthStatusText(s), "signed in (Console)")
    }
}
