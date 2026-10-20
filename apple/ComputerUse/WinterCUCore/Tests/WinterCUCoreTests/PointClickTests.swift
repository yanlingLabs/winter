import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// A point click into a background browser (live 2026-10-20, Dispatch on Safari): the ref click on the page worked (an
/// accessibility press), two point clicks on the same page went out as bare pid events — no "believe active" step, the
/// make-key step declined without a word — and WebKit dropped both. Now: a point on a control of a browser's page is
/// pressed as that control (strictly: the app's own hit test, the bound window on top, control-sized, at most one step
/// up), any click after the press goes to the model's own point; a background point click with no make-key step posts
/// the activation, is sent ONCE, and hands the user's key focus back if it took it; a point click's pixel check tells an
/// effect that holds from an area that keeps changing, a blinking caret aside; and find() reads deeper once per page.
final class PointClickTests: XCTestCase {
    let pid: pid_t = 5959
    let window = fakeElement(97_001)
    let web = fakeElement(97_002)
    let link = fakeElement(97_003)
    let linkText = fakeElement(97_004)
    let field = fakeElement(97_005)
    let card = fakeElement(97_006)
    let cardText = fakeElement(97_007)
    let map = fakeElement(97_008)
    let header = fakeElement(97_009)
    let headerButton = fakeElement(97_010)
    let content = fakeElement(97_011)
    let iconButton = fakeElement(97_012)
    let iconImage = fakeElement(97_013)
    let row = fakeElement(97_014)
    let rowText = fakeElement(97_015)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!
    var enforcer: FakeFocusEnforcer!

    /// A browser (or not) in the background behind the user's app (pid 1), its window on this desktop, at the screen's
    /// origin (1 screenshot pixel = 1 point). The page: a link (its text inside it), a text field, a large clickable card
    /// with text in it, a map image, a sticky header with a button drawn over a content link that comes later in the tree.
    private func world(browser: Bool = true, skyLight: CUSkyLight = .none) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window], kAXFocusedWindowAttribute: window])
        ax.add(window, role: kAXWindowRole, title: "Page", frame: CGRect(x: 0, y: 0, width: 900, height: 700),
               extra: [kAXChildrenAttribute: [web]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(web, role: "AXWebArea", frame: CGRect(x: 0, y: 40, width: 900, height: 660),
               extra: [kAXChildrenAttribute: [header, link, field, card, map, content, iconButton, row], kAXParentAttribute: window])
        ax.setActions(web, [kAXPressAction])
        ax.add(link, role: "AXLink", title: "Providers", frame: CGRect(x: 100, y: 100, width: 120, height: 20),
               extra: [kAXChildrenAttribute: [linkText], kAXParentAttribute: web])
        ax.setActions(link, [kAXPressAction, kAXShowMenuAction])
        ax.add(linkText, role: kAXStaticTextRole, title: "Providers", frame: CGRect(x: 105, y: 102, width: 60, height: 16),
               extra: [kAXParentAttribute: link])
        ax.add(field, role: kAXTextFieldRole, title: "Search", frame: CGRect(x: 100, y: 200, width: 200, height: 24),
               extra: [kAXParentAttribute: web])
        ax.setActions(field, [kAXPressAction])
        // A whole card that takes clicks: a press acts at its centre, not where the point is.
        ax.add(card, role: kAXGroupRole, title: "Offer", frame: CGRect(x: 100, y: 300, width: 600, height: 200),
               extra: [kAXChildrenAttribute: [cardText], kAXParentAttribute: web])
        ax.setActions(card, [kAXPressAction])
        ax.add(cardText, role: kAXStaticTextRole, title: "Terms", frame: CGRect(x: 120, y: 470, width: 60, height: 16),
               extra: [kAXParentAttribute: card])
        ax.add(map, role: kAXImageRole, title: "Map", frame: CGRect(x: 750, y: 300, width: 80, height: 60),
               extra: [kAXParentAttribute: web])
        ax.setActions(map, [kAXPressAction])
        // The sticky header comes FIRST in the tree but is drawn over the content scrolled under it.
        ax.add(header, role: kAXGroupRole, frame: CGRect(x: 0, y: 40, width: 900, height: 40),
               extra: [kAXChildrenAttribute: [headerButton], kAXParentAttribute: web])
        ax.add(headerButton, role: kAXButtonRole, title: "Menu", frame: CGRect(x: 400, y: 45, width: 80, height: 30),
               extra: [kAXParentAttribute: header])
        ax.setActions(headerButton, [kAXPressAction])
        ax.add(content, role: "AXLink", title: "Hidden under the header", frame: CGRect(x: 380, y: 50, width: 200, height: 20),
               extra: [kAXParentAttribute: web])
        ax.setActions(content, [kAXPressAction])
        // An icon-only button (its glyph an image), and a sidebar row that takes presses (pressed at its centre it could hit
        // another of its children).
        ax.add(iconButton, role: kAXButtonRole, title: "Close", frame: CGRect(x: 600, y: 100, width: 30, height: 30),
               extra: [kAXChildrenAttribute: [iconImage], kAXParentAttribute: web])
        ax.setActions(iconButton, [kAXPressAction])
        ax.add(iconImage, role: kAXImageRole, frame: CGRect(x: 605, y: 105, width: 20, height: 20), extra: [kAXParentAttribute: iconButton])
        ax.add(row, role: kAXRowRole, title: "Drafts", frame: CGRect(x: 100, y: 600, width: 220, height: 30),
               extra: [kAXChildrenAttribute: [rowText], kAXParentAttribute: web])
        ax.setActions(row, [kAXPressAction])
        ax.add(rowText, role: kAXStaticTextRole, title: "Drafts", frame: CGRect(x: 110, y: 605, width: 50, height: 16),
               extra: [kAXParentAttribute: row])
        ax.setActions(rowText, [kAXPressAction])
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
        enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { [unowned self] _ in enforcer }
        let steady = WebPressTests.image(gray: 200)
        core.privateCaptureOverride = { _, _ in steady }
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }
    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

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

    /// The page takes a press on `e` (a navigation: the focus moves to the new page).
    private func navigatesOnPress(_ e: AXUIElement) {
        ax.onPerform = { [unowned self] what in
            if what == "\(token(e)):AXPress" { ax.put(ax.application(pid), [kAXFocusedUIElementAttribute: fakeElement(97_500)]) }
        }
    }

    // MARK: a point on a control of a browser's page

    func testAPointOnALinksTextIsPressedAsTheLink() async throws {
        world()
        navigatesOnPress(link)
        let r = try await click([110, 110])  // the link's text
        XCTAssertEqual(ax.performed, ["\(token(link)):AXPress"], "one step up, to its link")
        XCTAssertTrue(downs.isEmpty, "no pid events: the press took effect")
        XCTAssertEqual(r.rung, 1)
        XCTAssertTrue(r.detail?.hasPrefix("the point is on [\(ref(link))] \u{201C}Providers\u{201D} of the page, so that element was clicked (as click(\(ref(link))) would)") ?? false, r.detail ?? "")
    }

    func testAPressThePageIgnoredIsFollowedByOneClickAtTheModelsOwnPoint() async throws {
        world()
        poster.onPost = { [unowned self] e in
            if e.type == .leftMouseUp { ax.put(ax.application(pid), [kAXFocusedUIElementAttribute: fakeElement(97_501)]) }
        }
        let r = try await click([110, 110])
        XCTAssertEqual(ax.performed, ["\(token(link)):AXPress"])
        XCTAssertEqual(downs.map(\.location), [CGPoint(x: 110, y: 110)], "one click, at the point the model gave — not the link's centre (160, 110)")
        XCTAssertTrue(r.detail?.contains("the accessibility press did nothing; clicked it instead") ?? false, r.detail ?? "")
    }

    func testThePageAFieldAContainerAndAnImageAreNeverPressedForAPoint() async throws {
        for (point, what) in [([850.0, 650.0], "the page itself"), ([150, 210], "a text field: a point there places the caret"),
                              ([600, 350], "a card larger than a control: its press would act at its centre"),
                              ([130, 478], "a card's text: the climb goes only to a link or button"),
                              ([780, 320], "an image (a map, a canvas)")] {
            world()
            try await click(point)
            XCTAssertTrue(ax.performed.isEmpty, what)
            XCTAssertEqual(downs.map(\.location), [CGPoint(x: point[0], y: point[1])], what)
        }
    }

    /// Review LOW 1: an icon-only button is hit on its image, which is never pressed — the image climbs one step to it.
    func testAnIconOnlyButtonsImageClimbsToTheButton() async throws {
        world()
        navigatesOnPress(iconButton)
        try await click([615, 115])
        XCTAssertEqual(ax.performed, ["\(token(iconButton)):AXPress"])
        XCTAssertTrue(downs.isEmpty)
    }

    /// Review LOW 2: only a control's role is pressed for a point on it — a pressable row (a sidebar's) is not, nor is its
    /// text (it climbs only to a link or button).
    func testAPressableRowOrItsTextIsClickedAsAPoint() async throws {
        for point in [[280.0, 615.0], [120, 612]] {
            world()
            try await click(point)
            XCTAssertTrue(ax.performed.isEmpty, "\(point)")
            XCTAssertEqual(downs.map(\.location), [CGPoint(x: point[0], y: point[1])])
        }
        XCTAssertEqual(CUCore.pointPressRoles, ["AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXTab", "AXMenuItem"])
    }

    func testTheAppsHitTestDecidesNotTheTreesOrder() async throws {
        world()
        navigatesOnPress(headerButton)
        try await click([420, 60])  // the sticky header's button, drawn over a content link that comes later in the tree
        XCTAssertEqual(ax.performed, ["\(token(headerButton)):AXPress"])
        XCTAssertFalse(ax.performed.contains("\(token(content)):AXPress"))
    }

    func testAWindowOverThePointTakesItAsAPoint() async throws {
        world()
        // A popover of the app over the link (its own window, drawn on top).
        let popover = FakeSystem.window(88, pid: pid, CGRect(x: 90, y: 90, width: 200, height: 100))
        sys.stack = [popover, sys.windows[77]!]
        try await click([110, 110])
        XCTAssertTrue(ax.performed.isEmpty, "the bound window is not the one on top there")
        XCTAssertEqual(downs.map(\.window), [88])
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

    func testAControlsSizeIsBounded() {
        XCTAssertTrue(CUCore.controlSized(CGRect(x: 0, y: 0, width: 120, height: 30)))
        XCTAssertFalse(CUCore.controlSized(CGRect(x: 0, y: 0, width: 600, height: 30)))
        XCTAssertFalse(CUCore.controlSized(CGRect(x: 0, y: 0, width: 120, height: 200)))
    }

    // MARK: the background click: the activation first, ONE click, the user's key focus handed back

    func testABackgroundPointClickWithNoMakeKeyStepPostsTheActivationFirst() async throws {
        world(browser: false)  // no SkyLight focus calls here: the make-key step does not apply
        XCTAssertEqual(core.keyForClick(target, privatePath: true, clickWindow: 77), .notApplied)
        var enforcedAtDown: [UInt32]?
        poster.onPost = { [unowned self] e in if enforcedAtDown == nil, e.type == .leftMouseDown { enforcedAtDown = enforcer.enforced } }
        let r = try await click([600, 600])
        XCTAssertEqual(enforcedAtDown, [77], "the synthetic activation went out before the click")
        XCTAssertEqual(downs.count, 1)
        XCTAssertEqual(r.rung, 2)
    }

    /// Review of this branch (HIGH): "not key before, key after" was read as "the first click was swallowed" and the click
    /// went again — but Chromium and Electron take the first click AND become key: a Place order would go twice.
    func testAClickThatMadeTheWindowKeyIsSentExactlyOnceAndTheKeyFocusHandedBack() async throws {
        world(browser: false)
        var keyFocus: pid_t = 1  // the user's app holds the key focus
        core.keyFocusPidOverride = { [unowned self] in sys.activated.contains(1) ? 1 : keyFocus }
        poster.onPost = { [unowned self] e in if e.type == .leftMouseUp { keyFocus = pid } }  // the click made the window key
        let r = try await click([600, 600])
        XCTAssertEqual(downs.count, 1, "never sent again")
        XCTAssertEqual(sys.activated, [1], "the user's app re-activated: it takes its key focus back")
        XCTAssertTrue(r.detail?.contains("the click took the keyboard focus into Browser; it was handed back to the user's app (the click was sent once)") ?? false, r.detail ?? "")
    }

    func testAPressThenItsFallbackClickIsNeverClickedTwice() async throws {
        world()
        var keyFocus: pid_t = 1
        core.keyFocusPidOverride = { keyFocus }
        poster.onPost = { [unowned self] e in if e.type == .leftMouseUp { keyFocus = pid } }
        try await click([110, 110])  // the press does nothing; one click follows
        XCTAssertEqual(ax.performed.count, 1)
        XCTAssertEqual(downs.count, 1, "press + one click, never press + click + click")
    }

    func testNothingIsHandedBackWhenTheKeyFocusStayedOrTheFrontChanged() async throws {
        world(browser: false)
        core.keyFocusPidOverride = { 1 }
        let r = try await click([600, 600])
        XCTAssertTrue(sys.activated.isEmpty)
        XCTAssertFalse(r.detail?.contains("keyboard focus") ?? false, r.detail ?? "")
        world(browser: false)
        var keyFocus: pid_t = 1
        core.keyFocusPidOverride = { keyFocus }
        poster.onPost = { [unowned self] e in if e.type == .leftMouseUp { keyFocus = pid; sys.front = 4242 } }  // another app came forward
        try await click([600, 600])
        XCTAssertTrue(sys.activated.isEmpty, "a front change is the guardian's to judge")
        XCTAssertEqual(downs.count, 1)
    }

    func testWithThePrivatePathOffNoActivationAndNoKeyFocusRead() async throws {
        world(browser: false)
        core.keyFocusPidOverride = { XCTFail("the key focus is read through the private path"); return nil }
        try await click([600, 600], privatePath: false)
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

    // MARK: an effect that holds, an area that keeps changing, a caret

    func testAnAreaThatKeepsChangingIsNotProofOfAnEffect() async throws {
        world(browser: false)
        core.webPressWatchMs = 400
        var n = 0
        core.privateCaptureOverride = { _, _ in n += 1; return WebPressTests.image(gray: n % 2 == 0 ? 40 : 220) }  // a video
        let r = try await click([600, 600])
        XCTAssertEqual(downs.count, 1)
        XCTAssertTrue(r.detail?.contains("the area around that point kept changing after the click (an animation or video), so whether the click took effect can't be told from the picture") ?? false, r.detail ?? "")
    }

    func testAChangeThatHoldsIsTheEffectAndNoChangeIsSaid() async throws {
        world(browser: false)
        core.webPressWatchMs = 400
        var clicked = false
        poster.onPost = { e in if e.type == .leftMouseUp { clicked = true } }
        core.privateCaptureOverride = { _, _ in WebPressTests.image(gray: clicked ? 90 : 200) }
        let r = try await click([600, 600])
        XCTAssertNil(r.detail, "its pixels changed after the click and held: nothing to say")
        world(browser: false)
        core.webPressWatchMs = 400
        let r2 = try await click([600, 600])
        XCTAssertTrue(r2.detail?.contains("the click at that point had no visible effect") ?? false, r2.detail ?? "")
    }

    func testABlinkingCaretIsNotMovement() {
        let plain = WebPressTests.image(gray: 200, width: 240, height: 160)
        let caret = Self.image(gray: 200, width: 240, height: 160, darken: CGRect(x: 100, y: 40, width: 2, height: 40))
        let banner = Self.image(gray: 200, width: 240, height: 160, darken: CGRect(x: 20, y: 20, width: 160, height: 80))
        XCTAssertFalse(CUImageTools.moving(plain, caret), "a 2 px column")
        XCTAssertTrue(CUImageTools.moving(plain, banner))
    }

    static func image(gray: CGFloat, width: Int, height: Int, darken: CGRect) -> CGImage {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(red: gray / 255, green: gray / 255, blue: gray / 255, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
        ctx.fill(darken)
        return ctx.makeImage()!
    }

    // MARK: find() — the deeper read once per page, and the cut-short read reused

    func testFindReadsDeeperOncePerPageAndReusesWhatItRead() async throws {
        world()
        var reads: [Int] = []
        let shallow = CUNode(ref: ref(window), role: kAXWindowRole, children: [CUNode(ref: ref(link), role: "AXLink", name: "Providers")])
        let deep = CUNode(ref: ref(window), role: kAXWindowRole, children: [
            CUNode(ref: ref(link), role: "AXLink", name: "Providers"), CUNode(ref: ref(content), role: "AXLink", name: "Pricing"),
        ])
        core.fullReadOverride = { _, maxNodes in
            reads.append(maxNodes)
            return maxNodes > AXTreeReader.defaultMaxNodes ? ([deep], nil) : ([shallow], 40)
        }
        let r = try await core.targetFind(TargetFindParams(targetId: "t1", query: .text("Pricing")))
        XCTAssertEqual(r.elements.map(\.ref), [ref(content)], "found past the ordinary read")
        XCTAssertEqual(reads, [AXTreeReader.defaultMaxNodes, CUCore.findDeepMaxNodes])
        XCTAssertNil(r.note)
        // Right after: the deeper read answers (no read at all).
        _ = try await core.targetFind(TargetFindParams(targetId: "t1", query: .text("Nothing")))
        XCTAssertEqual(reads.count, 2)
        // Later, same page, cut short again with no match: no second deeper read — said cut short instead.
        target.lastFullRead = nil
        let r3 = try await core.targetFind(TargetFindParams(targetId: "t1", query: .text("Nothing")))
        XCTAssertEqual(reads, [AXTreeReader.defaultMaxNodes, CUCore.findDeepMaxNodes, AXTreeReader.defaultMaxNodes])
        XCTAssertTrue(r3.note?.contains("the read was cut short (at least 40 elements not read)") ?? false, r3.note ?? "")
        // The cut-short read is reused by the next find, its note with it.
        let r4 = try await core.targetFind(TargetFindParams(targetId: "t1", query: .text("Nothing")))
        XCTAssertEqual(reads.count, 3, "reused")
        XCTAssertTrue(r4.note?.contains("the read was cut short (at least 40 elements not read)") ?? false, r4.note ?? "")
    }

    func testTheDeeperReadStopsWhenTheCallIsCancelled() {
        world()
        var reader = AXTreeReader()
        reader.shouldStop = { true }
        let r = reader.read(roots: [window], cache: target.refs, now: { 0 })
        XCTAssertTrue(r.truncated)
        XCTAssertTrue(r.roots.isEmpty)
    }
}
