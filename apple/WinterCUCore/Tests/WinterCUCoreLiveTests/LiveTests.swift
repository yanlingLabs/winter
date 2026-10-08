import AppKit
import ApplicationServices
import XCTest
@testable import WinterCUCore

/// Live AX, capture and input paths against real apps. EVERY test here skips unless
/// `WINTER_CU_LIVE_TESTS=1` is set: the process running `swift test` may inherit the terminal's
/// Accessibility grant, and these tests launch apps, type and click. They are meant for a controller-run
/// session on a machine where that is wanted (and where the grants exist — they skip without them too).
final class LiveTests: XCTestCase {
    private var core: CUCore!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["WINTER_CU_LIVE_TESTS"] == "1",
                          "live tests drive the real desktop; set WINTER_CU_LIVE_TESTS=1 to run them")
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .system, startMonitors: false)
    }

    private func requireAccessibility() throws {
        try XCTSkipUnless(AXIsProcessTrusted(), "needs the Accessibility grant")
    }

    private func requireScreenRecording() throws {
        try XCTSkipUnless(CGPreflightScreenCaptureAccess(), "needs the Screen Recording grant")
    }

    func testStatusAndDiscovery() async throws {
        let s = try await core.status()
        XCTAssertFalse(s.helperVersion.isEmpty)
        let apps = try await core.appsList()
        XCTAssertFalse(apps.apps.isEmpty)
        XCTAssertTrue(apps.apps.contains { $0.bundleId == "com.apple.TextEdit" })
        _ = try await core.screenWindows()
    }

    func testSkyLightResolvesOnThisMacOS() {
        // Resolution only; nothing is posted.
        let s = CUSkyLight.system
        XCTAssertTrue(s.isAvailable, "SLEventPostToPid did not resolve — rung 3 will fall back to rung 2")
    }

    /// Bind TextEdit, read its state, type, diff, find, select, screenshot, release.
    func testTextEditRoundTrip() async throws {
        try requireAccessibility()
        let bound = try await core.targetBind(TargetBindParams(sessionId: "live", app: "TextEdit", mirror: false))
        defer { Task { _ = try? await core.targetRelease(TargetReleaseParams(targetId: bound.targetId)) } }
        let first = try await core.targetSnapshot(TargetSnapshotParams(targetId: bound.targetId, settle: CUSettleOption(maxMs: 1500)))
        XCTAssertFalse(first.isDiff)
        XCTAssertTrue(first.text.hasPrefix("TextEdit"))

        let areas = try await core.targetFind(TargetFindParams(targetId: bound.targetId,
                                                               query: .fields(role: "text area", name: nil, text: nil)))
        let area = try XCTUnwrap(areas.elements.first)
        let typed = try await core.targetAct(TargetActParams(
            targetId: bound.targetId, sessionId: "live", callId: "c1",
            action: .type(CUTypeAction(text: "winter live test", into: area.ref)),
            access: .full, allowForeground: false, privatePath: true))
        XCTAssertLessThanOrEqual(typed.rung, 3)

        let diff = try await core.targetSnapshot(TargetSnapshotParams(
            targetId: bound.targetId, since: first.snapshotId, settle: CUSettleOption(maxMs: 1500)))
        XCTAssertTrue(diff.text.contains("winter live test"))

        _ = try await core.targetAct(TargetActParams(
            targetId: bound.targetId, sessionId: "live", callId: "c2",
            action: .select(CUSelectAction(ref: area.ref, text: "live")),
            access: .full, allowForeground: false, privatePath: true))

        try requireScreenRecording()
        let shot = try await core.targetScreenshot(TargetScreenshotParams(
            targetId: bound.targetId, budget: CUImageBudget(maxLongEdge: 1280, quality: 0.8)))
        XCTAssertLessThanOrEqual(max(shot.width, shot.height), 1280)
        XCTAssertNotNil(Data(base64Encoded: shot.imageBase64))
    }

    func testStaleRefAfterRelease() async throws {
        try requireAccessibility()
        let bound = try await core.targetBind(TargetBindParams(sessionId: "live", app: "TextEdit", mirror: false))
        _ = try await core.targetSnapshot(TargetSnapshotParams(targetId: bound.targetId))
        _ = try await core.targetRelease(TargetReleaseParams(targetId: bound.targetId))
        do {
            _ = try await core.targetSnapshot(TargetSnapshotParams(targetId: bound.targetId))
            XCTFail("a released target must read as lost")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "target_lost")
        }
    }

    func testWholeScreenExcludesTheHelper() async throws {
        try requireScreenRecording()
        let r = try await core.screenScreenshot(ScreenScreenshotParams(
            display: nil, excludeBundleIds: [], budget: CUImageBudget(maxLongEdge: 1280, quality: 0.7)))
        XCTAssertLessThanOrEqual(max(r.width, r.height), 1280)
        let mid = try await core.screenAppAt(ScreenAppAtParams(shotId: r.shotId, point: [Double(r.width) / 2, Double(r.height) / 2]))
        XCTAssertFalse(CUFloors.winterBundleIds.contains(mid.bundleId))
    }

    func testFloorsRefuseWinterAndAuthAgents() async throws {
        try requireAccessibility()
        do {
            _ = try await core.targetBind(TargetBindParams(sessionId: "live", app: "com.apple.keychainaccess", mirror: false))
            XCTFail("Keychain Access must be refused")
        } catch let e as CUError {
            XCTAssertTrue(e.code == "refused" || e.code == "invalid_params", e.description)
        }
    }
}
