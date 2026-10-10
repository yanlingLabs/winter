import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// A press on web content is verified: Google Docs' widgets act on a real mouse press, so an accessibility press
/// (a simulated DOM click) is accepted and ignored. Nothing changed → a window-targeted click at the element's
/// centre, itself verified; never a silent success. An app whose web content ignores presses twice gets clicks.
final class WebPressTests: XCTestCase {
    let pid: pid_t = 5858
    let window = fakeElement(96_001)
    let web = fakeElement(96_002)
    let panel = fakeElement(96_003)
    let button = fakeElement(96_004)
    let native = fakeElement(96_005)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    /// A browser in the background with a find panel (a web dialog) holding a button, and a native toolbar button.
    private func world(buttonName: String = "Close") {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window], kAXFocusedWindowAttribute: window])
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 0, y: 0, width: 900, height: 700),
               extra: [kAXChildrenAttribute: [native, web]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(native, role: kAXButtonRole, title: "Reload", frame: CGRect(x: 10, y: 10, width: 30, height: 20),
               extra: [kAXParentAttribute: window])
        ax.setActions(native, [kAXPressAction])
        ax.add(web, role: "AXWebArea", frame: CGRect(x: 0, y: 40, width: 900, height: 660),
               extra: [kAXChildrenAttribute: [panel], kAXParentAttribute: window])
        ax.add(panel, role: kAXGroupRole, title: "Find and replace", frame: CGRect(x: 300, y: 100, width: 300, height: 200),
               extra: [kAXChildrenAttribute: [button], kAXParentAttribute: web])
        ax.add(button, role: kAXButtonRole, title: buttonName, frame: CGRect(x: 540, y: 110, width: 40, height: 20),
               extra: [kAXParentAttribute: panel])
        ax.setActions(button, [kAXPressAction])
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.example.browser"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 900, height: 700), owner: "Browser")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.browser", appName: "Browser",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        let steady = Self.image(gray: 200)
        core.privateCaptureOverride = { _, _ in steady }  // the element's pixels: unchanged unless a test says so
    }

    /// A small opaque image of one shade (a capture of the element's area).
    static func image(gray: CGFloat, width: Int = 80, height: Int = 40) -> CGImage {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(red: gray / 255, green: gray / 255, blue: gray / 255, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()!
    }

    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }
    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }
    private var mouseDowns: Int { poster.entries.filter { $0.type == .leftMouseDown }.count }

    @discardableResult
    private func click(_ e: AXUIElement) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .click(CUClickAction(ref: ref(e))), access: .full, allowForeground: false, privatePath: false))
    }

    /// The panel closes (leaves the tree) on whatever the app takes as a press.
    private func closesOn(press: Bool, mouse: Bool) {
        if press { ax.onPerform = { [unowned self] what in if what == "\(token(button)):AXPress" { ax.put(web, [kAXChildrenAttribute: [AXUIElement]()]) } } }
        if mouse { poster.onPost = { [unowned self] e in if e.type == .leftMouseUp { ax.put(web, [kAXChildrenAttribute: [AXUIElement]()]) } } }
    }

    func testAPressThatTookEffectIsLeftAlone() async throws {
        world()
        closesOn(press: true, mouse: false)
        let r = try await click(button)
        XCTAssertEqual(r.rung, 1)
        XCTAssertNil(r.detail)
        XCTAssertEqual(mouseDowns, 0, "no click after a press that worked")
    }

    func testAPressThatDidNothingIsClickedInsteadAndSaysSo() async throws {
        world()
        closesOn(press: false, mouse: true)
        let r = try await click(button)
        XCTAssertTrue(ax.performed.contains("\(token(button)):AXPress"))
        XCTAssertEqual(mouseDowns, 1, "one window-targeted click")
        XCTAssertEqual(poster.entries.prefix(4).map(\.type), [.mouseMoved, .mouseMoved, .mouseMoved, .leftMouseDown], "arriving by the hover path")
        XCTAssertTrue(sys.warpedTo.isEmpty, "the user's cursor never moved")
        XCTAssertEqual(poster.entries.first { $0.type == .leftMouseDown }?.location, CGPoint(x: 560, y: 120), "at its centre")
        XCTAssertTrue(r.detail?.hasPrefix("the accessibility press did nothing; clicked it instead") ?? false, r.detail ?? "")
    }

    func testNothingAfterTheClickEitherIsSaidPlainly() async throws {
        world()
        let r = try await click(button)
        XCTAssertEqual(mouseDowns, 1)
        XCTAssertTrue(r.detail?.contains("clicked [\(ref(button))] \u{201C}Close\u{201D}, and nothing changed that accessibility can see — check with state() or a screenshot") ?? false,
                      r.detail ?? "")
    }

    func testAnAppWhoseWebPageIgnoresPressesTwiceGetsClicks() async throws {
        world()
        for _ in 0..<2 {
            closesOn(press: false, mouse: true)
            try await click(button)
            ax.put(web, [kAXChildrenAttribute: [panel]])  // the panel opens again
        }
        let pressesBefore = ax.performed.filter { $0.hasSuffix(":AXPress") }.count
        closesOn(press: false, mouse: true)
        let r = try await click(button)
        XCTAssertEqual(ax.performed.filter { $0.hasSuffix(":AXPress") }.count, pressesBefore, "no press any more")
        XCTAssertEqual(mouseDowns, 3)
        XCTAssertTrue(r.detail?.hasPrefix("Browser's web page ignores accessibility presses, so [\(ref(button))] \u{201C}Close\u{201D} was clicked") ?? false, r.detail ?? "")
        // Native controls of the same app are still pressed.
        try await click(native)
        XCTAssertTrue(ax.performed.contains("\(token(native)):AXPress"))
        XCTAssertEqual(mouseDowns, 3)
    }

    func testAPressThatCouldActUnseenIsNeverClickedAsWell() async throws {
        world(buttonName: "Send")
        let r = try await click(button)
        XCTAssertEqual(mouseDowns, 0, "a repeat could send twice")
        XCTAssertTrue(r.detail?.contains("had no visible effect — a command like this may still act without showing it at once, so it was not clicked as well; check state() before pressing again") ?? false, r.detail ?? "")
    }

    func testANativePressIsNotWatched() async throws {
        world()
        let r = try await click(native)
        XCTAssertNil(r.detail)
        XCTAssertEqual(mouseDowns, 0)
    }

    func testHoverRestsOnTheElementWithoutTheUsersCursor() async throws {
        world()
        let r = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .hover(CUHoverAction(ref: ref(button), ms: 50)), access: .click, allowForeground: false, privatePath: false))
        XCTAssertEqual(poster.entries.map(\.type), [.mouseMoved, .mouseMoved, .mouseMoved], "no press, no click")
        XCTAssertEqual(poster.entries.last?.location, CGPoint(x: 560, y: 120), "resting on its centre")
        XCTAssertTrue(poster.entries.allSatisfy { $0.route != .hid }, "window-targeted only")
        XCTAssertTrue(sys.warpedTo.isEmpty)
        XCTAssertTrue(ax.performed.isEmpty)
        XCTAssertTrue(r.detail?.contains("the pointer rested on [\(ref(button))] \u{201C}Close\u{201D} for 50 ms") ?? false, r.detail ?? "")
        // Allowed under click-only access, like a click.
    }

    // MARK: a conservative fallback

    func testAPressWhoseEffectOnlyShowsInPixelsIsNeverClickedAsWell() async throws {
        world()
        var shots = 0
        let before = Self.image(gray: 200), after = Self.image(gray: 60)
        core.privateCaptureOverride = { _, _ in shots += 1; return shots == 1 ? before : after }  // it redrew
        let r = try await click(button)
        XCTAssertEqual(mouseDowns, 0, "pressed once")
        XCTAssertEqual(r.detail, "pressed [\(ref(button))] \u{201C}Close\u{201D} (the effect is visible but not to accessibility)")
    }

    func testNoCaptureToCompareMeansNoSecondAction() async throws {
        world()
        core.privateCaptureOverride = { _, _ in nil }  // no Screen Recording, say
        let r = try await click(button)
        XCTAssertEqual(mouseDowns, 0)
        XCTAssertTrue(r.detail?.contains("had no effect accessibility can see — check state() or a screenshot before pressing again") ?? false, r.detail ?? "")
    }

    func testAToggleWhoseStateCantBeReadIsNeverPressedTwice() async throws {
        world()
        ax.put(button, [kAXRoleAttribute: kAXCheckBoxRole])  // a toggle, with no value to read
        let r = try await click(button)
        XCTAssertEqual(mouseDowns, 0)
        XCTAssertTrue(r.detail?.contains("a second press could undo it") ?? false, r.detail ?? "")
    }

    func testAToggleWhoseStateReadsUnchangedMayBeClicked() async throws {
        world()
        ax.put(button, [kAXRoleAttribute: kAXCheckBoxRole, kAXValueAttribute: 0])
        closesOn(press: false, mouse: true)
        let r = try await click(button)
        XCTAssertEqual(mouseDowns, 1, "provably unchanged: the click")
        XCTAssertTrue(r.detail?.hasPrefix("the accessibility press did nothing; clicked it instead") ?? false, r.detail ?? "")
    }

    func testAWindowNotOnScreenGetsNoSecondActionUntilTheAppIsLearned() async throws {
        world()
        sys.windows[77]?.onScreen = false
        let r = try await click(button)
        XCTAssertEqual(mouseDowns, 0, "its pixels may be stale")
        XCTAssertTrue(r.detail?.contains("had no effect accessibility can see") ?? false, r.detail ?? "")
    }

    func testEvidenceSeesTheElementGoneHiddenOrChanged() {
        world()
        let before = core.webPressEvidence(button, target)
        ax.put(button, [kAXExpandedAttribute: true])
        XCTAssertNotEqual(core.webPressEvidence(button, target), before, "expanded")
        world()
        let b2 = core.webPressEvidence(button, target)
        var o = CGPoint(x: 0, y: 0), s = CGSize(width: 0, height: 0)
        ax.put(button, [kAXPositionAttribute: AXValueCreate(.cgPoint, &o)!, kAXSizeAttribute: AXValueCreate(.cgSize, &s)!])
        XCTAssertNotEqual(core.webPressEvidence(button, target), b2, "hidden")
        world()
        let b3 = core.webPressEvidence(button, target)
        ax.dead.insert(AXIdentity(element: button))
        XCTAssertNotEqual(core.webPressEvidence(button, target), b3, "gone")
    }
}
