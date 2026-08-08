import XCTest
import AppKit
@testable import Norma

/// Rider 2: pins for the dock-ghost teardown observer (`HarnessTeardownObserver`).
///
/// Two layers: the PURE decisions (restore? sweep?) as plain matrices, and the registration proof.
/// `XCTestObservationCenter` exposes no public observer list, so the registration pin is
/// deliberately BEHAVIORAL — stronger than membership introspection. Dock seam retarget: `test2…`
/// used to raw-promote the REAL host and leak it (the observer's restore was the subject); with
/// the seam that raw write would trip the observer's own tripwire, and the host must never really
/// promote at all — so `test2…` now promotes through `DockPolicy.apply` (proving the seam applier
/// IS the recorder and the real Dock stays untouched) and deliberately leaks the RECORDER entry,
/// and `test3…` proves the observer actually fired between the two cases by finding the recorder
/// cleared. XCTest runs a class's methods alphabetically on one host, so the `test1/test2/test3`
/// names carry a real ordering dependency — rename them together or not at all.
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

    /// Dock seam: promotes through the SEAM (the only legal door) and deliberately leaks the
    /// recorder entry — `test3…` is this case's real assertion. Also the structural pin itself:
    /// the applied policy lands in the recorder and the REAL Dock never moves — the host cannot
    /// promote through the seam, which is what makes a killed/cancelled host ghost-tile-proof.
    func test2_PromoteThroughTheSeamAndDeliberatelyLeakTheRecorderEntry() {
        DockPolicy.apply(.regular)
        XCTAssertEqual(HarnessTeardownObserver.recordedPolicies, [.regular], "under test the seam applier must be the observer's recorder — promotion DURING a case is legal and captured…")
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "…but the REAL activation policy never moves: the host cannot actually promote through the seam")
    }

    /// Proves the observer is genuinely REGISTERED and FIRING: the previous case returned with its
    /// `.regular` entry still in the recorder, and the only thing between it and this case is the
    /// observer's `testCaseDidFinish` (the ONLY clearer of the recorder). (Also passes standalone
    /// under `-only-testing` filters — the recorder starts empty — so filtering can't strand it;
    /// it only gains meaning after `test2…`.)
    func test3_TheObserverClearedTheLeakedRecorderEntryBetweenCases() {
        XCTAssertEqual(HarnessTeardownObserver.recordedPolicies, [], "testCaseDidFinish must have cleared the recorder after the previous case leaked a .regular entry")
        XCTAssertEqual(NSApp.activationPolicy(), .accessory, "the real policy was never touched to begin with")
    }
}
