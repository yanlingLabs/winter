import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Acting on a window on another desktop (another Space, full screen) the way the live gate needs: clicks at a
/// point hit-test the window's AX tree and press over accessibility, scrolls move the scroll bar or send Page
/// Down/Up to the pid, typing and keys go to the pid, and only geometric input (drag, canvas, modified clicks)
/// is refused. Nothing is moved and no window is opened.
final class OffDesktopActTests: XCTestCase {
    let pid: pid_t = 4848
    let window = fakeElement(95_001)
    let scrollArea = fakeElement(95_002)
    let webArea = fakeElement(95_003)
    let link = fakeElement(95_004)
    let linkText = fakeElement(95_005)
    let icon = fakeElement(95_006)
    let field = fakeElement(95_007)
    let canvas = fakeElement(95_008)
    let bar = fakeElement(95_009)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    /// Safari's window 77 at (100,100) 800×600, on another Space: off screen, not in AX's window list, its
    /// element cached from a bind where it is.
    private func world(scrollBar: Bool = false) {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [AXUIElement]()])
        ax.add(window, role: kAXWindowRole, title: "Docs", frame: CGRect(x: 100, y: 100, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.put(window, [kAXChildrenAttribute: [scrollArea]])
        ax.add(scrollArea, role: kAXScrollAreaRole, frame: CGRect(x: 100, y: 100, width: 800, height: 600),
               extra: [kAXChildrenAttribute: scrollBar ? [webArea, bar] : [webArea]])
        ax.add(webArea, role: "AXWebArea", frame: CGRect(x: 100, y: 100, width: 800, height: 2400),
               extra: [kAXChildrenAttribute: [link, icon, field, canvas], kAXParentAttribute: scrollArea])
        ax.makeSettable(webArea, kAXFocusedAttribute)
        ax.add(link, role: "AXLink", title: "Providers", frame: CGRect(x: 120, y: 150, width: 100, height: 20),
               extra: [kAXParentAttribute: webArea, kAXChildrenAttribute: [linkText]])
        ax.setActions(link, [kAXPressAction, kAXShowMenuAction])
        ax.add(linkText, role: kAXStaticTextRole, title: "Providers", frame: CGRect(x: 125, y: 152, width: 50, height: 16),
               extra: [kAXParentAttribute: link])
        ax.add(icon, role: kAXImageRole, title: "logo", frame: CGRect(x: 300, y: 300, width: 64, height: 64),
               extra: [kAXParentAttribute: webArea])
        ax.setActions(icon, ["AXOpen", kAXPressAction])
        ax.add(field, role: kAXTextFieldRole, title: "Search", frame: CGRect(x: 120, y: 200, width: 200, height: 24),
               extra: [kAXParentAttribute: webArea])
        ax.makeSettable(field, kAXFocusedAttribute)
        ax.add(canvas, role: kAXGroupRole, frame: CGRect(x: 500, y: 400, width: 200, height: 200), extra: [kAXParentAttribute: webArea])
        if scrollBar {
            ax.add(bar, role: kAXScrollBarRole, extra: [kAXValueAttribute: 0.0])
            ax.makeSettable(bar, kAXValueAttribute)
            ax.put(scrollArea, [kAXVerticalScrollBarAttribute: bar])
        }

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.apple.Safari"
        var w = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 800, height: 600), owner: "Safari")
        w.onScreen = false
        sys.windows[77] = w
        sys.stack = []
        sys.front = 1
        sys.moveSucceeds = true  // even a working move is never used

        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.apple.Safari", appName: "Safari",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Docs")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        // The hit test reads this tree (the live reader walks real AX).
        core.treeReadOverride = { [unowned self] _ in [tree()] }
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }
    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

    private func tree() -> CUNode {
        CUNode(ref: ref(window), role: kAXWindowRole, frame: CGRect(x: 100, y: 100, width: 800, height: 600), children: [
            CUNode(ref: ref(scrollArea), role: kAXScrollAreaRole, frame: CGRect(x: 100, y: 100, width: 800, height: 600), children: [
                CUNode(ref: ref(webArea), role: "AXWebArea", frame: CGRect(x: 100, y: 100, width: 800, height: 2400), children: [
                    CUNode(ref: ref(link), role: "AXLink", name: "Providers", actions: [kAXPressAction, kAXShowMenuAction],
                           frame: CGRect(x: 120, y: 150, width: 100, height: 20), children: [
                        CUNode(ref: ref(linkText), role: kAXStaticTextRole, name: "Providers", frame: CGRect(x: 125, y: 152, width: 50, height: 16)),
                    ]),
                    CUNode(ref: ref(icon), role: kAXImageRole, name: "logo", actions: ["AXOpen", kAXPressAction],
                           frame: CGRect(x: 300, y: 300, width: 64, height: 64)),
                    CUNode(ref: ref(field), role: kAXTextFieldRole, name: "Search", frame: CGRect(x: 120, y: 200, width: 200, height: 24)),
                    CUNode(ref: ref(canvas), role: kAXGroupRole, frame: CGRect(x: 500, y: 400, width: 200, height: 200)),
                ]),
            ]),
        ])
    }

    /// A screenshot of the window, 1 pixel = 1 point, so a pixel (x, y) is the screen point (100 + x, 100 + y).
    private func shot() -> String {
        target.registerShot(anchor: .window(windowID: 77, regionOrigin: .zero), imageWidth: 800, imageHeight: 600,
                            points: CGSize(width: 800, height: 600)).id
    }

    @discardableResult
    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: true))
    }

    @discardableResult
    private func expect(_ code: String, file: StaticString = #filePath, line: UInt = #line,
                        _ body: () async throws -> Void) async -> CUError? {
        do {
            try await body()
            XCTFail("expected \(code)", file: file, line: line)
        } catch let e as CUError {
            XCTAssertEqual(e.code, code, e.message, file: file, line: line)
            return e
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
        return nil
    }

    private var mouseEvents: Int { poster.entries.filter { [.leftMouseDown, .rightMouseDown, .scrollWheel].contains($0.type) }.count }

    // MARK: clicks

    func testAClickAtAPointPressesTheElementThereOverAX() async throws {
        world()
        let s = shot()
        let r = try await act(.click(CUClickAction(point: [30, 55], shotId: s)))  // (130,155): the link's text
        XCTAssertEqual(r.rung, 1)
        XCTAssertEqual(ax.performed, ["\(token(link)):AXPress"], "the text climbs to its link")
        XCTAssertTrue(r.detail?.contains("on another desktop, so it was pressed over accessibility") ?? false, r.detail ?? "")
        XCTAssertEqual(mouseEvents, 0)
        XCTAssertTrue(sys.moved.isEmpty)
    }

    func testRightAndDoubleClicksElsewhereUseShowMenuAndOpen() async throws {
        world()
        let s = shot()
        try await act(.click(CUClickAction(point: [30, 55], shotId: s, button: .right)))
        try await act(.click(CUClickAction(point: [230, 230], shotId: s, count: 2)))   // the icon: AXOpen
        try await act(.click(CUClickAction(point: [30, 55], shotId: s, count: 2)))     // the link: press twice
        XCTAssertEqual(ax.performed, ["\(token(link)):AXShowMenu", "\(token(icon)):AXOpen",
                                      "\(token(link)):AXPress", "\(token(link)):AXPress"])
        XCTAssertEqual(mouseEvents, 0)
    }

    func testARefClickWhoseElementRefusesClimbsToTheOneThatTakesIt() async throws {
        world()
        ax.refuses = ["\(token(linkText)):AXPress"]
        try await act(.click(CUClickAction(ref: ref(linkText))))
        XCTAssertEqual(ax.performed, ["\(token(linkText)):AXPress", "\(token(link)):AXPress"])
        // A text field that takes no press is focused instead.
        ax.refuses = ["\(token(field)):AXPress"]
        let r = try await act(.click(CUClickAction(ref: ref(field))))
        XCTAssertTrue(r.detail?.contains("it was focused over accessibility") ?? false, r.detail ?? "")
        XCTAssertTrue(ax.written.contains("\(token(field)):AXFocused"))
        XCTAssertEqual(mouseEvents, 0)
    }

    func testACanvasClickElsewhereIsRefusedWithoutOpeningAnything() async throws {
        world()
        let s = shot()
        let e = await expect("window_elsewhere") { try await self.act(.click(CUClickAction(point: [500, 400], shotId: s))) }
        XCTAssertTrue(e?.message.contains("a click where no accessibility element is (a canvas) needs it on this desktop") ?? false,
                      e?.message ?? "")
        XCTAssertTrue(ax.performed.isEmpty)
        XCTAssertTrue(poster.entries.isEmpty, "no events and no ⌘N")
        XCTAssertTrue(sys.moved.isEmpty)
    }

    // MARK: scrolls

    func testAScrollElsewhereMovesTheScrollBarWhenThereIsOne() async throws {
        world(scrollBar: true)
        let r = try await act(.scroll(CUScrollAction(ref: ref(webArea), direction: .down, pages: 1)))
        XCTAssertEqual(r.rung, 1)
        XCTAssertTrue(ax.written.contains("\(token(bar)):AXValue"))
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testAScrollElsewhereWithoutABarSendsPageKeysToTheApp() async throws {
        world()
        let s = shot()
        try await act(.scroll(CUScrollAction(point: [400, 300], shotId: s, direction: .down, pages: 3)))
        XCTAssertEqual(poster.keyDowns.map(\.keycode), [121, 121, 121], "Page Down ×3")
        XCTAssertTrue(ax.written.contains("\(token(webArea)):AXFocused"), "the page took the focus first")
        try await act(.scroll(CUScrollAction(ref: ref(webArea), direction: .up, pages: 1)))
        XCTAssertEqual(poster.keyDowns.last?.keycode, 116, "Page Up")
        try await act(.scroll(CUScrollAction(ref: ref(webArea), direction: .left, pages: 1)))
        XCTAssertEqual(poster.keyDowns.suffix(8).map(\.keycode), Array(repeating: 123, count: 8), "← ×8")
        XCTAssertEqual(poster.entries.filter { $0.type == .scrollWheel }.count, 0, "never a wheel event")
        XCTAssertTrue(sys.moved.isEmpty)
    }

    // MARK: keyboard and geometry

    func testTypingAndKeysElsewhereGoToThePid() async throws {
        world()
        ax.focus(pid: pid, on: field)
        try await act(.type(CUTypeAction(text: "jev")))
        try await act(.key(CUKeyAction(combo: "cmd+r")))
        try await act(.key(CUKeyAction(combo: "escape")))
        XCTAssertEqual(poster.keyDowns.count, 5)
        XCTAssertTrue(sys.moved.isEmpty)
    }

    func testDraggingElsewhereIsTheOneThingRefused() async throws {
        world()
        let e = await expect("window_elsewhere") {
            try await self.act(.drag(CUDragAction(from: CUDragEnd(ref: self.ref(self.icon)), to: CUDragEnd(ref: self.ref(self.link)))))
        }
        XCTAssertTrue(e?.message.contains("dragging needs it on this desktop") ?? false, e?.message ?? "")
        XCTAssertTrue(poster.entries.isEmpty)
    }

    // MARK: the hit test (pure)

    func testTheHitTestTakesTheDeepestClickableElement() {
        func n(_ ref: Int, _ role: String, _ frame: CGRect?, actions: [String] = [], disabled: Bool = false, _ children: [CUNode] = []) -> CUNode {
            CUNode(ref: ref, role: role, states: disabled ? [.disabled] : [], actions: actions, frame: frame, children: children)
        }
        let roots = [n(1, kAXWindowRole, CGRect(x: 0, y: 0, width: 500, height: 500), [
            n(2, kAXGroupRole, nil, [                                           // no geometry: looked through
                n(3, kAXButtonRole, CGRect(x: 10, y: 10, width: 100, height: 40), [
                    n(4, kAXStaticTextRole, CGRect(x: 20, y: 20, width: 40, height: 20)),
                ]),
            ]),
            n(5, kAXButtonRole, CGRect(x: 200, y: 10, width: 100, height: 40), disabled: true),
            n(6, kAXGroupRole, CGRect(x: 0, y: 100, width: 500, height: 400), actions: [kAXShowMenuAction]),
            n(7, kAXImageRole, CGRect(x: 50, y: 150, width: 60, height: 60)),   // drawn last: on top
        ])]
        XCTAssertEqual(CUCore.clickTarget(at: CGPoint(x: 30, y: 25), in: roots)?.ref, 3, "text climbs to its button")
        XCTAssertNil(CUCore.clickTarget(at: CGPoint(x: 250, y: 30), in: roots), "a disabled button takes nothing")
        XCTAssertEqual(CUCore.clickTarget(at: CGPoint(x: 60, y: 160), in: roots)?.ref, 7)
        XCTAssertEqual(CUCore.clickTarget(at: CGPoint(x: 400, y: 400), in: roots)?.ref, 6, "a group with show menu")
        XCTAssertNil(CUCore.clickTarget(at: CGPoint(x: 900, y: 900), in: roots))
    }
}
