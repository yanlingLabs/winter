import AppKit
import ApplicationServices
import ImageIO
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

    /// The whole-screen image must not contain the helper's own windows. The test process plays the helper:
    /// it shows a small magenta window, captures the screen, and checks the pixels where that window sits
    /// show something else (the exclusion is by pid and by bundle id).
    @MainActor func testWholeScreenImageLeavesOutTheHelpersOwnWindows() async throws {
        try requireScreenRecording()
        let frame = NSRect(x: 40, y: 40, width: 160, height: 120)  // AppKit coordinates, bottom-left of the main screen
        let window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.backgroundColor = NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1)
        window.level = .floating
        window.isReleasedWhenClosed = false
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        try await Task.sleep(nanoseconds: 300_000_000)

        let r = try await core.screenScreenshot(ScreenScreenshotParams(
            display: .index(0), excludeBundleIds: [], budget: CUImageBudget(maxLongEdge: 4000, quality: 0.95)))
        let data = try XCTUnwrap(Data(base64Encoded: r.imageBase64))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        // The window's centre in global top-left points, then in image pixels.
        let main = CGDisplayBounds(CGMainDisplayID())
        let center = CGPoint(x: frame.midX, y: main.height - frame.midY)
        let px = Int(center.x / main.width * Double(r.width)), py = Int(center.y / main.height * Double(r.height))
        let rgb = try XCTUnwrap(Self.pixel(image, px, py))
        let magenta = rgb.0 > 230 && rgb.1 < 30 && rgb.2 > 230
        XCTAssertFalse(magenta, "the helper's own window showed up in the whole-screen image")
    }

    private static func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (Int, Int, Int)? {
        guard x >= 0, y >= 0, x < image.width, y < image.height else { return nil }
        var buf = [UInt8](repeating: 0, count: 4)
        guard let ctx = CGContext(data: &buf, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
        return (Int(buf[0]), Int(buf[1]), Int(buf[2]))
    }

    /// The login window is always running; binding it must be refused by the auth-dialog floor — not merely
    /// fail to resolve.
    func testBindingAnAuthAgentIsRefused() async throws {
        try requireAccessibility()
        do {
            _ = try await core.targetBind(TargetBindParams(sessionId: "live", app: "com.apple.loginwindow", mirror: false))
            XCTFail("the login window must be refused")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "refused", e.description)
            XCTAssertEqual(e.data?["reason"], .string("auth_dialog"))
        }
    }
}
