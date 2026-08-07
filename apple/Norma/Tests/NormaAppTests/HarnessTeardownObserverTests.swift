import XCTest
import AppKit

/// Rider 2: pins for the dock-ghost teardown observer (`HarnessTeardownObserver`).
///
/// Two layers: the PURE decisions (restore? sweep?) as plain matrices, and the registration proof.
/// `XCTestObservationCenter` exposes no public observer list, so the registration pin is
/// deliberately BEHAVIORAL — stronger than membership introspection: `test2…` promotes the host
/// and returns WITHOUT cleaning up (exactly the leak class the observer exists for), and `test3…`
/// proves the observer actually fired between the two cases. XCTest runs a class's methods
/// alphabetically on one host, so the `test1/test2/test3` names carry a real ordering dependency —
/// rename them together or not at all.
@MainActor
final class HarnessTeardownObserverTests: XCTestCase {

    // MARK: - pure decisions

    func testShouldRestoreOnlyWhenCurrentDiffersFromLaunchPolicy() {
        // same-as-launch → leave alone, whatever the launch policy was
        XCTAssertFalse(HarnessTeardownObserver.shouldRestore(launchPolicy: .accessory, currentPolicy: .accessory))
        XCTAssertFalse(HarnessTeardownObserver.shouldRestore(launchPolicy: .regular, currentPolicy: .regular))
        XCTAssertFalse(HarnessTeardownObserver.shouldRestore(launchPolicy: .prohibited, currentPolicy: .prohibited))
        // drifted → restore, in EVERY direction — the observer restores the CAPTURED policy; it
        // never assumes the host is an accessory app
        XCTAssertTrue(HarnessTeardownObserver.shouldRestore(launchPolicy: .accessory, currentPolicy: .regular))
        XCTAssertTrue(HarnessTeardownObserver.shouldRestore(launchPolicy: .regular, currentPolicy: .accessory))
        XCTAssertTrue(HarnessTeardownObserver.shouldRestore(launchPolicy: .accessory, currentPolicy: .prohibited))
        XCTAssertTrue(HarnessTeardownObserver.shouldRestore(launchPolicy: .prohibited, currentPolicy: .regular))
    }

    func testShouldOrderOutSweepsOnlyVisibleNonInfrastructureWindows() {
        // visible test-created surfaces → sweep
        XCTAssertTrue(HarnessTeardownObserver.shouldOrderOut(windowClassName: "NSWindow", isVisible: true))
        XCTAssertTrue(HarnessTeardownObserver.shouldOrderOut(windowClassName: "NSPanel", isVisible: true))
        XCTAssertTrue(HarnessTeardownObserver.shouldOrderOut(windowClassName: "Norma.KeyableNonActivatingPanel", isVisible: true))
        // invisible → never touched, regardless of class
        XCTAssertFalse(HarnessTeardownObserver.shouldOrderOut(windowClassName: "NSWindow", isVisible: false))
        XCTAssertFalse(HarnessTeardownObserver.shouldOrderOut(windowClassName: "NSStatusBarWindow", isVisible: false))
        // host infrastructure → never swept even when visible: the menu-bar status item window,
        // menu windows, private AppKit surfaces
        XCTAssertFalse(HarnessTeardownObserver.shouldOrderOut(windowClassName: "NSStatusBarWindow", isVisible: true))
        XCTAssertFalse(HarnessTeardownObserver.shouldOrderOut(windowClassName: "NSMenuWindowManagerWindow", isVisible: true))
        XCTAssertFalse(HarnessTeardownObserver.shouldOrderOut(windowClassName: "_NSAlertPanel", isVisible: true))
    }

    // MARK: - registration (ordered triple — see the type doc)

    /// The principal-class wiring: XCTest must have instantiated the observer at bundle load
    /// (nil = the `INFOPLIST_KEY_NSPrincipalClass` plumbing broke), and the captured at-launch
    /// policy must be `.accessory` — the probed truth for this host (`LSUIElement` +
    /// `applicationDidFinishLaunching`'s own `.accessory` set, both pre-tests).
    func test1_PrincipalClassInstantiatedTheObserverWithTheAccessoryLaunchPolicy() {
        let observer = HarnessTeardownObserver.installed
        XCTAssertNotNil(observer, "the test bundle's NSPrincipalClass must have been instantiated by XCTest at bundle load")
        XCTAssertEqual(observer?.launchPolicy, .accessory, "the host launches LSUIElement/.accessory — captured before any test ran")
    }

    /// Deliberately leaves the host promoted — the EXACT leak class the observer exists to clean.
    /// `test3…` is this case's real assertion.
    func test2_PromoteAndDeliberatelyLeakThePromotion() {
        NSApp.setActivationPolicy(.regular)
        XCTAssertEqual(NSApp.activationPolicy(), .regular, "promotion DURING a case is legal — the observer must not fight it mid-case")
    }

    /// Proves the observer is genuinely REGISTERED and FIRING: the previous case returned with
    /// `.regular` still set, and the only thing between it and this case is the observer's
    /// `testCaseDidFinish`. (Also passes standalone under `-only-testing` filters — the host is
    /// `.accessory` at rest — so filtering can't strand it; it only gains meaning after `test2…`.)
    func test3_TheObserverRestoredTheLeakedPromotionBetweenCases() {
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "testCaseDidFinish must have restored the captured launch policy after the previous case leaked .regular")
    }
}
