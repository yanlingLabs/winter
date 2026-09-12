import XCTest
@testable import Winter

/// An in-memory `LoginItemService` seam — never touches the real `SMAppService.mainApp`, which
/// would attempt an actual login-item registration from the xctest host process (same LIVE-GATE
/// concern `HelperClient.register()`'s doc comment raises against `SMAppService.daemon`).
final class FakeLoginItemService: LoginItemService {
    private(set) var isEnabled = false
    private(set) var enableCallCount = 0
    private(set) var disableCallCount = 0
    var enableError: Error?
    var disableError: Error?

    func enable() throws {
        enableCallCount += 1
        if let enableError { throw enableError }
        isEnabled = true
    }

    func disable() throws {
        disableCallCount += 1
        if let disableError { throw disableError }
        isEnabled = false
    }
}

@MainActor
final class LoginItemTests: XCTestCase {
    private func freshDefaults(_ name: String) -> (defaults: UserDefaults, cleanup: () -> Void) {
        let suiteName = "LoginItemTests.\(name).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        return (defaults, { defaults.removePersistentDomain(forName: suiteName) })
    }

    // MARK: - Task 4 brief, Step 1 (exact given test body — default `UserDefaults.standard`).

    func testLoginItemToggle() {
        defer { UserDefaults.standard.removeObject(forKey: "com.winter.loginItem.userChoiceMade") }
        let fake = FakeLoginItemService()
        let c = LoginItemController(service: fake)
        c.setEnabled(true);  XCTAssertTrue(fake.isEnabled)
        c.setEnabled(false); XCTAssertFalse(fake.isEnabled)
    }

    // MARK: - isEnabled mirrors the underlying service

    func testIsEnabledReflectsTheUnderlyingService() {
        let fake = FakeLoginItemService()
        let (defaults, cleanup) = freshDefaults("reflect")
        defer { cleanup() }
        let c = LoginItemController(service: fake, defaults: defaults)

        XCTAssertFalse(c.isEnabled)
        c.setEnabled(true)
        XCTAssertTrue(c.isEnabled)
        c.setEnabled(false)
        XCTAssertFalse(c.isEnabled)
    }

    // MARK: - hasUserMadeChoice: the default-on-first-launch gate

    func testHasUserMadeChoiceIsFalseUntilSetEnabledIsCalled() {
        let (defaults, cleanup) = freshDefaults("choice")
        defer { cleanup() }
        let c = LoginItemController(service: FakeLoginItemService(), defaults: defaults)

        XCTAssertFalse(c.hasUserMadeChoice, "a fresh controller must not claim a choice was ever made")
        c.setEnabled(true)
        XCTAssertTrue(c.hasUserMadeChoice)
    }

    /// The default-on first-launch call is `setEnabled(true)` gated on `!hasUserMadeChoice` — an
    /// explicit "turn it off" must be remembered too, not just "turn it on", so a later launch's
    /// default-on call never overrides a user's opt-out.
    func testExplicitlyDisablingCountsAsAChoiceToo() {
        let (defaults, cleanup) = freshDefaults("disable-choice")
        defer { cleanup() }
        let c = LoginItemController(service: FakeLoginItemService(), defaults: defaults)

        c.setEnabled(false)
        XCTAssertTrue(c.hasUserMadeChoice)
    }

    func testHasUserMadeChoicePersistsAcrossControllerInstancesForTheSameDefaults() {
        let (defaults, cleanup) = freshDefaults("persist")
        defer { cleanup() }
        let c1 = LoginItemController(service: FakeLoginItemService(), defaults: defaults)
        c1.setEnabled(false) // an explicit user "off" choice

        let c2 = LoginItemController(service: FakeLoginItemService(), defaults: defaults)
        XCTAssertTrue(c2.hasUserMadeChoice, "a fresh controller reading the SAME defaults must see the prior choice")
    }

    // MARK: - a throwing service must never crash setEnabled

    func testSetEnabledSurvivesAThrowingEnableWithoutCrashing() {
        let fake = FakeLoginItemService()
        fake.enableError = NSError(domain: "test", code: 1)
        let (defaults, cleanup) = freshDefaults("throwing-enable")
        defer { cleanup() }
        let c = LoginItemController(service: fake, defaults: defaults)

        c.setEnabled(true) // must not throw/crash
        XCTAssertFalse(fake.isEnabled, "a failed register() must not be reported as enabled")
        XCTAssertTrue(c.hasUserMadeChoice, "the choice is recorded even if the underlying call failed")
    }

    func testSetEnabledSurvivesAThrowingDisableWithoutCrashing() {
        let fake = FakeLoginItemService()
        fake.disableError = NSError(domain: "test", code: 1)
        let (defaults, cleanup) = freshDefaults("throwing-disable")
        defer { cleanup() }
        let c = LoginItemController(service: fake, defaults: defaults)
        c.setEnabled(true)

        c.setEnabled(false) // must not throw/crash
        XCTAssertTrue(fake.isEnabled, "a failed unregister() must not be reported as disabled")
    }
}
