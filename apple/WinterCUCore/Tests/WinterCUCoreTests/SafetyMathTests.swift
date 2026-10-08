import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Pure pieces behind the review fixes: the rung-4 hit test, display choice, paste detection, the SkyLight
/// record-pointer check, and drags that stop cleanly.
final class SafetyMathTests: XCTestCase {
    private func w(_ id: UInt32, _ pid: pid_t, _ r: CGRect, owner: String = "X", alpha: Double = 1) -> CUWindowServerWindow {
        CUWindowServerWindow(id: id, pid: pid, ownerName: owner, title: "", frame: r, layer: 0, onScreen: true, alpha: alpha)
    }

    func testHitTestTopWindow() {
        let target = w(1, 10, CGRect(x: 0, y: 0, width: 500, height: 500))
        let mine = w(2, 99, CGRect(x: 0, y: 0, width: 100, height: 100))
        let invisible = w(3, 20, CGRect(x: 0, y: 0, width: 500, height: 500), alpha: 0)
        let other = w(4, 30, CGRect(x: 200, y: 200, width: 100, height: 100), owner: "Slack")
        let stack = [mine, invisible, other, target]
        XCTAssertEqual(CUHitTest.topWindow(at: CGPoint(x: 50, y: 50), stack: stack, ownPid: 99)?.id, 1,
                       "the helper's own windows and invisible ones are skipped")
        XCTAssertEqual(CUHitTest.topWindow(at: CGPoint(x: 250, y: 250), stack: stack, ownPid: 99)?.id, 4)
        XCTAssertNil(CUHitTest.topWindow(at: CGPoint(x: 900, y: 900), stack: stack, ownPid: 99))
    }

    func testHitTestVerdicts() {
        let target = w(1, 10, CGRect(x: 0, y: 0, width: 500, height: 500))
        func check(_ stack: [CUWindowServerWindow], bundles: [pid_t: String] = [:]) throws {
            try CUHitTest.check(point: CGPoint(x: 50, y: 50), targetPid: 10, appName: "Figma", stack: stack, ownPid: 99,
                                bundleId: { bundles[$0] }, processName: { _ in nil })
        }
        XCTAssertNoThrow(try check([target]))
        XCTAssertThrowsError(try check([])) { XCTAssertEqual(($0 as? CUError)?.code, "unsupported") }
        let winter = w(5, 40, CGRect(x: 0, y: 0, width: 300, height: 300))
        XCTAssertThrowsError(try check([winter, target], bundles: [40: "com.winter.app"])) {
            XCTAssertEqual(($0 as? CUError)?.data?["reason"], .string("winter_itself"))
        }
        let prompt = w(6, 50, CGRect(x: 0, y: 0, width: 300, height: 300), owner: "UserNotificationCenter")
        XCTAssertThrowsError(try check([prompt, target])) {
            XCTAssertEqual(($0 as? CUError)?.data?["reason"], .string("auth_dialog"), "matched by owner name too")
        }
    }

    func testDisplayChoice() throws {
        let ordered: [CGDirectDisplayID] = [1, 7, 3]  // main first
        XCTAssertEqual(try CUCapturer.choose(ordered, display: nil, displayId: nil), [1])
        XCTAssertEqual(try CUCapturer.choose(ordered, display: .index(1), displayId: nil), [7], "an index, never an id")
        XCTAssertEqual(try CUCapturer.choose(ordered, display: .all, displayId: nil), [1, 7, 3])
        XCTAssertEqual(try CUCapturer.choose(ordered, display: .index(0), displayId: 3), [3], "displayId wins")
        XCTAssertThrowsError(try CUCapturer.choose(ordered, display: .index(3), displayId: nil))
        XCTAssertThrowsError(try CUCapturer.choose(ordered, display: nil, displayId: 42))
        XCTAssertThrowsError(try CUCapturer.choose(ordered, display: .index(-1), displayId: nil))
    }

    func testWindowFrameComparison() {
        XCTAssertTrue(CUCapturer.sameFrame(CGRect(x: 0, y: 0, width: 10, height: 10), CGRect(x: 0.2, y: 0, width: 10, height: 10)))
        XCTAssertFalse(CUCapturer.sameFrame(CGRect(x: 0, y: 0, width: 10, height: 10), CGRect(x: 0, y: 0, width: 12, height: 10)))
    }

    func testPasteMenuDetection() {
        XCTAssertTrue(CUPasteMenu.isPasteItem(title: "Paste", cmdChar: nil, cmdModifiers: nil))
        XCTAssertTrue(CUPasteMenu.isPasteItem(title: "Paste and Match Style", cmdChar: "V", cmdModifiers: 3))
        XCTAssertTrue(CUPasteMenu.isPasteItem(title: "Einsetzen", cmdChar: "V", cmdModifiers: 0), "localised: by its shortcut")
        XCTAssertFalse(CUPasteMenu.isPasteItem(title: "Copy", cmdChar: "C", cmdModifiers: 0))
        XCTAssertFalse(CUPasteMenu.isPasteItem(title: "View", cmdChar: "V", cmdModifiers: 8), "no command key")
        XCTAssertFalse(CUPasteMenu.isPasteItem(title: "Pastel colours", cmdChar: nil, cmdModifiers: nil))
    }

    func testSkyLightRecordPointerCheck() {
        let block = malloc(64)!
        defer { free(block) }
        XCTAssertTrue(CUSkyLight.isHeapBlock(block))
        var onStack = 0
        withUnsafeMutablePointer(to: &onStack) { XCTAssertFalse(CUSkyLight.isHeapBlock($0)) }
        XCTAssertFalse(CUSkyLight.isHeapBlock(UnsafeRawPointer(bitPattern: 0x1234)!))
        XCTAssertFalse(CUSkyLight.isHeapBlock(block.advanced(by: 3)), "unaligned")
    }

    func testDragStopsAtAFailedCheckAndReleases() throws {
        let r = RecordingPoster()
        var s = CUEventSynth(poster: r, skyLight: .none)
        s.sleep = { _ in }
        XCTAssertThrowsError(try s.drag(pid: 1, windowFor: { _ in 3 }, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 100, y: 0),
                                        route: .publicPid, steps: 4) { type, p in
            if type == .leftMouseDragged, p.x > 60 { throw CUError.cancelled }
        })
        XCTAssertEqual(r.entries.map(\.type), [.mouseMoved, .leftMouseDown, .leftMouseDragged, .leftMouseDragged, .leftMouseUp])
        XCTAssertEqual(r.entries.last?.location, CGPoint(x: 50, y: 0), "released where it stopped")
    }

    func testAForegroundClickChecksEveryPressAndRelease() throws {
        let r = RecordingPoster()
        var s = CUEventSynth(poster: r, skyLight: .none)
        s.sleep = { _ in }
        var checked: [CGEventType] = []
        try s.click(pid: 1, windowFor: { _ in 3 }, at: .zero, button: .left, count: 2, flags: [], route: .hid) { t, _ in
            checked.append(t)
        }
        XCTAssertEqual(checked, [.leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp])
    }

    /// The permission request's registration step is time-boxed: a hung system call never holds the reply.
    /// (The request itself is never called in tests — it would register the test runner with TCC.)
    func testPermissionRegistrationIsBounded() async {
        let start = Date()
        let finished = await CUPermissionsProbe.bounded(seconds: 0.1) {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
        }
        XCTAssertFalse(finished)
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
        let quick = await CUPermissionsProbe.bounded(seconds: 5) {}
        XCTAssertTrue(quick)
    }
}
