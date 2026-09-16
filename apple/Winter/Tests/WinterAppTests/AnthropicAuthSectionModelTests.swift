import XCTest
import WinterKit
@testable import Winter

/// Winter Phase 10a Task A1; WS-20 review fix (M3): `AnthropicAuthSectionModel`'s status-line text
/// across `effective`/`apiKey`/`consoleProfile` combinations, and the Console sign-in/sign-out
/// affordance. The arm-picker (`select`/`configureAuth`/`selectedOption`/`AnthropicAuthOption`) is
/// RETIRED along with `runtimes.official.auth` — there is no standing setting left to pick; a
/// session's own tag (`anthropic/…` vs `console/…`) decides which credential it uses. Drives the
/// model against `FakeAnthropicAuthClient` directly — no `WinterClient`/transport involved, since
/// this model depends on the `AnthropicAuthClient` protocol precisely so it can be tested this way
/// (see that file's header comment).
@MainActor
final class AnthropicAuthSectionModelTests: XCTestCase {
    private func status(apiKey: Bool = false, consoleProfile: Bool = false, effective: String = "none") -> AnthropicAuthStatus {
        AnthropicAuthStatus(apiKey: apiKey, consoleProfile: consoleProfile, effective: effective)
    }

    // MARK: - refreshStatus / hasConsoleProfile

    func testRefreshStatusLoadsFromTheClient() async {
        let fake = FakeAnthropicAuthClient()
        fake.statusResult = .success(status(apiKey: true, effective: "api-key"))
        let model = AnthropicAuthSectionModel(client: fake)

        await model.refreshStatus()

        XCTAssertEqual(fake.statusCallCount, 1)
        XCTAssertNil(model.statusErrorText)
        XCTAssertEqual(model.statusText, "API key")
        XCTAssertFalse(model.hasConsoleProfile)
    }

    func testHasConsoleProfileReflectsStatus() async {
        let fake = FakeAnthropicAuthClient()
        fake.statusResult = .success(status(consoleProfile: true, effective: "console"))
        let model = AnthropicAuthSectionModel(client: fake)

        await model.refreshStatus()

        XCTAssertTrue(model.hasConsoleProfile)
    }

    func testARefreshFailureSurfacesAsStatusErrorText() async {
        let fake = FakeAnthropicAuthClient()
        fake.statusResult = .failure(FakeAnthropicAuthClient.SimpleError())
        let model = AnthropicAuthSectionModel(client: fake)

        await model.refreshStatus()

        XCTAssertNotNil(model.statusErrorText)
    }

    // MARK: - sign out

    /// A successful sign-out clears any prior error and refreshes status.
    func testSignOutRefreshesStatusOnSuccess() async {
        let fake = FakeAnthropicAuthClient()
        fake.statusResult = .success(status(apiKey: true, effective: "api-key"))
        let model = AnthropicAuthSectionModel(client: fake)

        await model.signOut()

        XCTAssertEqual(fake.logoutCallCount, 1)
        XCTAssertEqual(fake.statusCallCount, 1)
        XCTAssertNil(model.selectErrorText)
    }

    /// A thrown `logout` surfaces as `selectErrorText` and never triggers a status refresh.
    func testSignOutErrorSurfacesWithoutRefreshingStatus() async {
        let fake = FakeAnthropicAuthClient()
        fake.logoutResult = .failure(FakeAnthropicAuthClient.SimpleError())
        let model = AnthropicAuthSectionModel(client: fake)

        await model.signOut()

        XCTAssertNotNil(model.selectErrorText)
        XCTAssertEqual(fake.statusCallCount, 0, "a failed sign-out must not trigger a status refresh")
    }

    // MARK: - status text for every `effective` value (review fix M3: presence alone, incl. "both")

    func testStatusTextWhenEffectiveIsApiKey() {
        let s = status(apiKey: true, consoleProfile: false, effective: "api-key")
        XCTAssertEqual(anthropicAuthStatusText(s), "API key")
    }

    func testStatusTextWhenEffectiveIsConsole() {
        let s = status(apiKey: false, consoleProfile: true, effective: "console")
        XCTAssertEqual(anthropicAuthStatusText(s), "signed in (Console)")
    }

    func testStatusTextWhenEffectiveIsNone() {
        let s = status(apiKey: false, consoleProfile: false, effective: "none")
        XCTAssertEqual(anthropicAuthStatusText(s), "not configured")
    }

    /// Review fix (M3): both credentials present at once — `effective: "both"` is now a real,
    /// distinct wire value (not a derived/synthesized state), and reads as "API key + Console".
    func testStatusTextWhenEffectiveIsBoth() {
        let s = status(apiKey: true, consoleProfile: true, effective: "both")
        XCTAssertEqual(anthropicAuthStatusText(s), "API key + Console")
    }
}
