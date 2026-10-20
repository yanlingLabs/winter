import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// A point click into a background browser (live 2026-10-20, Dispatch on Safari): the ref click on the page worked (an
/// accessibility press), two point clicks on the same page went out as bare pid events — no "believe active" step, the
/// make-key step declined without a word — and WebKit dropped both. A point on a web element in a browser is now clicked
/// as that element; a background point click with no make-key step posts the activation and re-sends a first click the
/// window took as its activation; and an area already changing before a point click proves nothing by changing after it.
final class PointClickTests: XCTestCase {
    let pid: pid_t = 5959
    let window = fakeElement(97_001)
    let web = fakeElement(97_002)
    let link = fakeElement(97_003)
    let linkText = fakeElement(97_004)
    let field = fakeElement(97_005)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!
    var enforcer: FakeFocusEnforcer!

    /// A browser (or not) in the background behind the user's app (pid 1), its window on this desktop: a page with a
    /// link (its text inside it) and a text field. 1 screenshot pixel = 1 point, the window at the screen's origin.
    private func world(browser: Bool = true, skyLight: CUSkyLight = .none) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window], kAXFocusedWindowAttribute: window])
        ax.add(window, role: kAXWindowRole, title: "Page", frame: CGRect(x: 0, y: 0, width: 900, height: 700),
               extra: [kAXChildrenAttribute: [web]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(web, role: "AXWebArea", frame: CGRect(x: 0, y: 40, width: 900, height: 660),
               extra: [kAXChildrenAttribute: [link, field], kAXParentAttribute: window])
        ax.add(link, role: "AXLink", title: "Providers", frame: CGRect(x: 100, y: 100, width: 120, height: 20),
               extra: [kAXChildrenAttribute: [linkText], kAXParentAttribute: web])
        ax.setActions(link, [kAXPressAction, kAXShowMenuAction])
        ax.add(linkText, role: kAXStaticTextRole, title: "Providers", frame: CGRect(x: 105, y: 102, width: 60, height: 16),
               extra: [kAXParentAttribute: link])
        ax.add(field, role: kAXTextFieldRole, title: "Search", frame: CGRect(x: 100, y: 200, width: 200, height: 24),
               extra: [kAXParentAttribute: web])
        ax.setActions(field, [kAXPressAction])
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.example.browser"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 900, height: 700), owner: "Browser")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: skyLight, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.browser", appName: "Browser",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Page")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        core.isWebBrowserOverride = { _ in browser }
        core.treeReadOverride = { [unowned self] _ in [tree()] }
        enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { [unowned self] _ in enforcer }
        let steady = WebPressTests.image(gray: 200)
        core.privateCaptureOverride = { _, _ in steady }
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }
    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

    private func tree() -> CUNode {
        CUNode(ref: ref(window), role: kAXWindowRole, frame: CGRect(x: 0, y: 0, width: 900, height: 700), children: [
            CUNode(ref: ref(web), role: "AXWebArea", frame: CGRect(x: 0, y: 40, width: 900, height: 660), children: [
                CUNode(ref: ref(link), role: "AXLink", name: "Providers", actions: [kAXPressAction, kAXShowMenuAction],
                       frame: CGRect(x: 100, y: 100, width: 120, height: 20), children: [
                    CUNode(ref: ref(linkText), role: kAXStaticTextRole, name: "Providers", frame: CGRect(x: 105, y: 102, width: 60, height: 16)),
                ]),
                CUNode(ref: ref(field), role: kAXTextFieldRole, name: "Search", actions: [kAXPressAction],
                       frame: CGRect(x: 100, y: 200, width: 200, height: 24)),
            ]),
        ])
    }

    private func shot() -> String {
        target.registerShot(anchor: .window(windowID: 77, regionOrigin: .zero), imageWidth: 900, imageHeight: 700,
                            points: CGSize(width: 900, height: 700)).id
    }

    @discardableResult
    private func click(_ px: [Double], button: CUMouseButton? = nil, count: Int? = nil, privatePath: Bool = true) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .click(CUClickAction(point: px, shotId: shot(), button: button, count: count)), access: .full,
            allowForeground: false, privatePath: privatePath))
    }

    private var downs: [RecordingPoster.Entry] { poster.entries.filter { $0.type == .leftMouseDown || $0.type == .rightMouseDown } }

    /// The page takes a press on the link (a navigation: the focus moves to the new page).
    private func linkNavigatesOnPress() {
        ax.onPerform = { [unowned self] what in
            if what == "\(token(link)):AXPress" { ax.put(ax.application(pid), [kAXFocusedUIElementAttribute: fakeElement(97_500)]) }
        }
    }

    // MARK: a point on a web element in a browser

    func testAPointOnALinksTextInABrowserIsPressedAsTheLink() async throws {
        world()
        linkNavigatesOnPress()
        let r = try await click([110, 110])  // the link's text
        XCTAssertEqual(ax.performed, ["\(token(link)):AXPress"], "the text climbs to its link, which lists press")
        XCTAssertTrue(downs.isEmpty, "no pid events: the press took effect")
        XCTAssertEqual(r.rung, 1)
        XCTAssertTrue(r.detail?.hasPrefix("the point is on [\(ref(link))] \u{201C}Providers\u{201D} of the page, so that element was clicked (as click(\(ref(link))) would)") ?? false, r.detail ?? "")
    }

    func testAPressThePageIgnoredIsFollowedByOneClickOnTheElement() async throws {
        world()
        poster.onPost = { [unowned self] e in
            if e.type == .leftMouseUp { ax.put(ax.application(pid), [kAXFocusedUIElementAttribute: fakeElement(97_501)]) }
        }
        let r = try await click([110, 110])
        XCTAssertEqual(ax.performed, ["\(token(link)):AXPress"])
        XCTAssertEqual(downs.count, 1, "one click, after the press did nothing")
        XCTAssertEqual(downs.first?.location, CGPoint(x: 160, y: 110), "at the element's centre")
        XCTAssertTrue(r.detail?.contains("the accessibility press did nothing; clicked it instead") ?? false, r.detail ?? "")
    }

    func testAPointNotOnAPressableWebElementIsClickedAsAPoint() async throws {
        world()
        try await click([600, 500])  // the page itself
        XCTAssertTrue(ax.performed.isEmpty, "the page itself is never pressed")
        XCTAssertEqual(downs.map(\.location), [CGPoint(x: 600, y: 500)])
        world()
        try await click([150, 210])  // a text field: a point there places the caret
        XCTAssertTrue(ax.performed.isEmpty)
        XCTAssertEqual(downs.map(\.location), [CGPoint(x: 150, y: 210)])
    }

    func testOnlyABrowserAndOnlyAPlainSingleLeftClickTakeTheElementRoute() async throws {
        world(browser: false)
        try await click([110, 110])
        XCTAssertTrue(ax.performed.isEmpty, "not a browser: the point is clicked")
        XCTAssertEqual(downs.count, 1)
        world()
        try await click([110, 110], count: 2)
        try await click([110, 110], button: .right)
        XCTAssertTrue(ax.performed.isEmpty, "a double or right click at a point stays a point click")
        XCTAssertEqual(downs.count, 3)
    }

    // MARK: the background click's "believe active" step

    func testABackgroundPointClickWithNoMakeKeyStepPostsTheActivationFirst() async throws {
        world(browser: false)  // no SkyLight focus calls here: the make-key step does not apply
        XCTAssertEqual(core.keyForClick(target, privatePath: true, clickWindow: 77), .notApplied)
        var enforcedAtDown: [UInt32]?
        poster.onPost = { [unowned self] e in if enforcedAtDown == nil, e.type == .leftMouseDown { enforcedAtDown = enforcer.enforced } }
        let r = try await click([600, 500])
        XCTAssertEqual(enforcedAtDown, [77], "the synthetic activation went out before the click")
        XCTAssertEqual(downs.count, 1)
        XCTAssertEqual(r.rung, 2)
    }

    func testAFirstClickTheWindowTookAsItsActivationIsSentOnceMore() async throws {
        world(browser: false)
        var keyFocus: pid_t = 1  // the user's app holds the key focus
        core.keyFocusPidOverride = { keyFocus }
        poster.onPost = { [unowned self] e in if e.type == .leftMouseUp { keyFocus = pid } }  // the click only made it key
        let r = try await click([600, 500])
        XCTAssertEqual(downs.count, 2, "resent once")
        XCTAssertTrue(r.detail?.contains("resent once — the first click only made the window key") ?? false, r.detail ?? "")
    }

    func testNoResendIntoAWindowAlreadyKeyOrForAnythingButAPlainLeftClick() async throws {
        world(browser: false)
        var keyFocus: pid_t = 5959
        core.keyFocusPidOverride = { keyFocus }
        try await click([600, 500])
        XCTAssertEqual(downs.count, 1, "the window was key already: the click was not swallowed")
        keyFocus = 1
        poster.onPost = { [unowned self] e in if e.type == .rightMouseUp || e.type == .leftMouseUp { keyFocus = pid } }
        try await click([600, 500], button: .right)
        keyFocus = 1
        try await click([600, 500], count: 2)
        XCTAssertEqual(downs.filter { $0.type == .rightMouseDown }.count, 1, "a right click is never sent twice")
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 1 + 2, "a double click's two downs, never four")
        XCTAssertFalse(CUCore.mayResendFirstClick(privatePath: false, button: .left, count: 1, flags: [], wasKey: false))
        XCTAssertFalse(CUCore.mayResendFirstClick(privatePath: true, button: .left, count: 1, flags: .maskCommand, wasKey: false))
        XCTAssertTrue(CUCore.mayResendFirstClick(privatePath: true, button: .left, count: 1, flags: [], wasKey: false))
    }

    func testWithThePrivatePathOffNoActivationAndNoKeyFocusRead() async throws {
        world(browser: false)
        core.keyFocusPidOverride = { XCTFail("the key focus is read through the private path"); return nil }
        try await click([600, 500], privatePath: false)
        XCTAssertTrue(enforcer.enforced.isEmpty)
        XCTAssertEqual(downs.count, 1)
    }

    // MARK: why the make-key step declined

    func testTheMakeKeyStepSaysWhichGuardDeclined() {
        world(browser: false, skyLight: focusSkyLight())
        XCTAssertNil(core.makeKeyDecline(target))
        sys.front = pid
        XCTAssertEqual(core.makeKeyDecline(target), "the app is in front (really active)")
        sys.front = 1
        var w = sys.windows[77]!
        w.onScreen = false
        sys.windows[77] = w
        XCTAssertEqual(core.makeKeyDecline(target), "the bound window is not on screen on this desktop")
        sys.windows[77] = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 900, height: 700))
        let chrome = CUTarget(id: "tc", sessionId: "s", pid: pid, bundleId: "com.google.Chrome", appName: "Chrome",
                              isChromium: true, mirror: false, windowID: 77, windowTitle: "Page")
        XCTAssertEqual(core.makeKeyDecline(chrome), "a Chromium-based app keeps the routes it had")
        let captureOnly = CUTarget(id: "tx", sessionId: "s", pid: pid, bundleId: "com.example.browser", appName: "Browser",
                                   isChromium: false, mirror: false, windowID: 77, windowTitle: "Page", accessible: false)
        XCTAssertEqual(core.makeKeyDecline(captureOnly), "the bind is capture-only (no accessibility)")
        world(browser: false)
        XCTAssertEqual(core.makeKeyDecline(target), "the make-key records can't be posted here (the private focus calls are missing)")
    }

    // MARK: an area already changing proves nothing

    func testAnAreaAlreadyChangingBeforeTheClickIsNotProofOfAnEffect() async throws {
        world(browser: false)
        var n = 0
        core.privateCaptureOverride = { _, _ in n += 1; return WebPressTests.image(gray: n % 2 == 0 ? 40 : 220) }  // a video
        let r = try await click([600, 500])
        XCTAssertEqual(downs.count, 1)
        XCTAssertTrue(r.detail?.contains("the area around that point was already changing before the click (an animation or video), so whether the click took effect can't be told from the picture") ?? false, r.detail ?? "")
        XCTAssertFalse(r.detail?.contains("had no visible effect") ?? false)
    }

    func testASteadyAreaStillSaysAClickChangedNothingOrTookEffect() async throws {
        world(browser: false)
        let r = try await click([600, 500])
        XCTAssertTrue(r.detail?.contains("the click at that point had no visible effect") ?? false, r.detail ?? "")
        world(browser: false)
        var clicked = false
        poster.onPost = { e in if e.type == .leftMouseUp { clicked = true } }
        core.privateCaptureOverride = { _, _ in WebPressTests.image(gray: clicked ? 90 : 200) }
        let r2 = try await click([600, 500])
        XCTAssertNil(r2.detail, "its pixels changed after the click: nothing to say")
    }
}
