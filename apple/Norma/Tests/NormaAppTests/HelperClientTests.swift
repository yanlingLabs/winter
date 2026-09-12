import ServiceManagement
import XCTest
@testable import Winter

/// Task 4 (4c): the two pure mappings in `HelperClient.swift` — `SMAppService.Status` →
/// `HelperApprovalStatus` (the bridge init) and `HelperApprovalStatus` → `HelperStatusDisplay`
/// (the dashboard row's state text + button visibility). `HelperClient`'s real `SMAppService`/XPC
/// surface (`register`/`setChargeLimit`/`getChargeLimit`) drives a real privileged
/// daemon — a LIVE-GATE item (Task 6), not exercised here, same posture as `SMCController` in
/// `HelperSources/SMCController.swift` relative to `chargeLimitPlan`.
final class HelperClientTests: XCTestCase {
    // MARK: - SMAppService.Status → HelperApprovalStatus (the bridge init)

    func testStatusBridgeMapsEveryKnownSMAppServiceCase() {
        XCTAssertEqual(HelperApprovalStatus(.notRegistered), .notRegistered)
        XCTAssertEqual(HelperApprovalStatus(.enabled), .enabled)
        XCTAssertEqual(HelperApprovalStatus(.requiresApproval), .requiresApproval)
        XCTAssertEqual(HelperApprovalStatus(.notFound), .notFound)
    }

    // MARK: - helperStatusDisplay (the dashboard row)

    func testNotRegisteredHidesSettingsButton() {
        let d = helperStatusDisplay(.notRegistered)
        XCTAssertEqual(d.stateText, "Helper not registered")
        XCTAssertFalse(d.showsOpenSettingsButton)
    }

    func testEnabledHidesSettingsButton() {
        let d = helperStatusDisplay(.enabled)
        XCTAssertEqual(d.stateText, "Helper approved")
        XCTAssertFalse(d.showsOpenSettingsButton)
    }

    func testRequiresApprovalShowsSettingsButton() {
        let d = helperStatusDisplay(.requiresApproval)
        XCTAssertFalse(d.stateText.isEmpty)
        XCTAssertTrue(d.showsOpenSettingsButton)
    }

    func testNotFoundHidesSettingsButton() {
        // Login Items can't fix a missing bundle/plist — no button offered.
        let d = helperStatusDisplay(.notFound)
        XCTAssertFalse(d.stateText.isEmpty)
        XCTAssertFalse(d.showsOpenSettingsButton)
    }

    func testUnknownShowsSettingsButtonAsAForwardCompatSafetyNet() {
        let d = helperStatusDisplay(.unknown)
        XCTAssertFalse(d.stateText.isEmpty)
        XCTAssertTrue(d.showsOpenSettingsButton)
    }

    /// Every case gets distinct, non-empty state text — a UI regression (two statuses reading
    /// identically) would be silent otherwise.
    func testEveryStatusHasDistinctStateText() {
        let all: [HelperApprovalStatus] = [.notRegistered, .enabled, .requiresApproval, .notFound, .unknown]
        let texts = Set(all.map { helperStatusDisplay($0).stateText })
        XCTAssertEqual(texts.count, all.count)
    }
}
