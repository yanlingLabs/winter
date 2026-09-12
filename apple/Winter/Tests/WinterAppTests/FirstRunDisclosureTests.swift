import XCTest
@testable import Winter

/// BYOK T2 (spec §3): the first-run disclosure's UserDefaults gate — a seam-testable pure helper
/// pair (`shouldShowFirstRunDisclosure`/`markFirstRunDisclosureShown`) rather than driving
/// `AppDelegate` directly for the "shown once, suppressed after" contract, same
/// injectable-`defaults` convention as `LoginItemTests.swift`'s own `freshDefaults(_:)` helper.
@MainActor
final class FirstRunDisclosureTests: XCTestCase {
    private func freshDefaults(_ name: String) -> (defaults: UserDefaults, cleanup: () -> Void) {
        let suiteName = "FirstRunDisclosureTests.\(name).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        return (defaults, { defaults.removePersistentDomain(forName: suiteName) })
    }

    func testFreshInstallShowsUntilMarkedShown() {
        let (defaults, cleanup) = freshDefaults("gate")
        defer { cleanup() }

        XCTAssertTrue(shouldShowFirstRunDisclosure(defaults: defaults), "a fresh install must show the disclosure")
        markFirstRunDisclosureShown(defaults: defaults)
        XCTAssertFalse(shouldShowFirstRunDisclosure(defaults: defaults), "must never show again once marked")
    }

    /// Sanity on the underlying key itself — a fresh suite has no value stored yet, and
    /// `shouldShowFirstRunDisclosure` correctly reads that absence as "should show", not as `false`.
    func testUnsetKeyReadsAsShouldShow() {
        let (defaults, cleanup) = freshDefaults("fresh")
        defer { cleanup() }
        XCTAssertFalse(defaults.bool(forKey: firstRunDisclosureShownKey))
        XCTAssertTrue(shouldShowFirstRunDisclosure(defaults: defaults))
    }

    /// Marking shown is idempotent — calling it twice must not somehow flip back to "should show".
    func testMarkingShownTwiceStaysSuppressed() {
        let (defaults, cleanup) = freshDefaults("idempotent")
        defer { cleanup() }
        markFirstRunDisclosureShown(defaults: defaults)
        markFirstRunDisclosureShown(defaults: defaults)
        XCTAssertFalse(shouldShowFirstRunDisclosure(defaults: defaults))
    }

    // MARK: - AppDelegate.boot() wiring: never presented under unit tests

    /// `boot()`'s real-launch gate (`!Self.isRunningUnitTests`) must skip the first-run disclosure
    /// entirely under the xctest host, regardless of `UserDefaults.standard`'s own gate state —
    /// same "never under tests" contract every other real-side-effect construction in `boot()`
    /// already honors (helper registration, login-item default-on, the updater controller).
    func testBootNeverPresentsFirstRunDisclosureUnderUnitTests() {
        UserDefaults.standard.removeObject(forKey: firstRunDisclosureShownKey)
        defer { UserDefaults.standard.removeObject(forKey: firstRunDisclosureShownKey) }

        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())

        XCTAssertNil(delegate.firstRunDisclosureWindow, "must never present under unit tests")
        XCTAssertFalse(
            UserDefaults.standard.bool(forKey: firstRunDisclosureShownKey),
            "a skipped presentation must not mark the flag shown either — the real launch still owes the user one showing")
    }
}
