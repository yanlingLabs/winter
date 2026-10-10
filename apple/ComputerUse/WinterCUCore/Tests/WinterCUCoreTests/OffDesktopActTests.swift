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
        // The two window setters (recorded), so events can be addressed to the off-screen window.
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: recordingSkyLight(), poster: poster, ax: ax, sys: sys,
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

    /// A press the page takes (the link navigates: the focus moves) — web presses are verified by an effect.
    private func pressesTakeEffect() {
        var n: Int32 = 0
        ax.onPerform = { [unowned self] what in
            guard what.hasSuffix(":AXPress") else { return }
            n += 1
            ax.put(ax.application(pid), [kAXFocusedUIElementAttribute: fakeElement(95_500 + n)])  // a new page's focus
        }
    }

    private var downs: [RecordingPoster.Entry] {
        poster.entries.filter { [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains($0.type) }
    }

    func testAnElementThatListsPressIsPressedOverAX() async throws {
        world()
        pressesTakeEffect()
        let s = shot()
        let r = try await act(.click(CUClickAction(point: [30, 55], shotId: s)))  // (130,155): the link's text
        XCTAssertEqual(r.rung, 1)
        XCTAssertEqual(ax.performed, ["\(token(link)):AXPress"], "the text climbs to its link, which lists press")
        XCTAssertTrue(r.detail?.contains("on another desktop, so the element was sent press over accessibility") ?? false, r.detail ?? "")
        XCTAssertEqual(mouseEvents, 0)
        XCTAssertTrue(sys.moved.isEmpty)
    }

    func testListedShowMenuAndOpenGoOverAXTheRestAsWindowTargetedEvents() async throws {
        world()
        let s = shot()
        try await act(.click(CUClickAction(point: [30, 55], shotId: s, button: .right)))  // link: lists show menu
        try await act(.click(CUClickAction(point: [230, 230], shotId: s, count: 2)))      // icon: lists open
        XCTAssertEqual(ax.performed, ["\(token(link)):AXShowMenu", "\(token(icon)):AXOpen"])
        XCTAssertTrue(poster.entries.isEmpty)
        // The link lists no open: a double click is two window-targeted clicks at the point.
        let r = try await act(.click(CUClickAction(point: [30, 55], shotId: s, count: 2)))
        XCTAssertEqual(ax.performed.count, 2, "no blind AX action")
        XCTAssertEqual(downs.map(\.type), [.leftMouseDown, .leftMouseDown])
        XCTAssertEqual(r.rung, 2)
    }

    func testAnElementThatListsNoPressIsPressedUnlistedThenAncestorsThenEvents() async throws {
        world()
        pressesTakeEffect()
        try await act(.click(CUClickAction(ref: ref(linkText))))  // static text: lists nothing
        XCTAssertEqual(ax.performed, ["\(token(linkText)):AXPress"], "AX first: press, unlisted")
        ax.refuses = ["\(token(linkText)):AXPress"]
        try await act(.click(CUClickAction(ref: ref(linkText))))
        XCTAssertEqual(ax.performed.suffix(2), ["\(token(linkText)):AXPress", "\(token(link)):AXPress"], "then the link that lists it")
        XCTAssertTrue(poster.entries.isEmpty)
        // Both refuse: window-targeted events at its centre, the last attempt.
        ax.refuses = ["\(token(linkText)):AXPress", "\(token(link)):AXPress"]
        let r = try await act(.click(CUClickAction(ref: ref(linkText))))
        XCTAssertEqual(downs.count, 1)
        let down = try XCTUnwrap(downs.first)
        XCTAssertEqual(down.location, CGPoint(x: 150, y: 160), "the element's centre")
        XCTAssertEqual(down.window, 77)
        XCTAssertEqual(down.window2, 77)
        XCTAssertEqual(r.detail, "Safari's window is on another desktop: the click was sent to that window as window-targeted pid events; whether it landed can't be confirmed there — check the state")
    }

    func testASwallowedWindowTargetedClickIsResentOnce() async throws {
        world()
        ax.refuses = ["\(token(link)):AXPress"]  // force the window-targeted events route
        // The window was not key before, and becomes key after the first click (it only activated the window).
        var key: pid_t? = nil
        core.keyFocusPidOverride = { key }
        poster.onPost = { [unowned self] e in if e.type == .leftMouseDown { key = pid } }
        let r = try await act(.click(CUClickAction(ref: ref(link))))
        XCTAssertEqual(downs.count, 2, "resent once after the window became key")
        XCTAssertTrue(r.detail?.contains("resent once — the first click only made the window key") ?? false, r.detail ?? "")
    }

    func testAClickOnAnAlreadyKeyWindowIsNotResent() async throws {
        world()
        ax.refuses = ["\(token(link)):AXPress"]
        core.keyFocusPidOverride = { [unowned self] in pid }  // already key
        let r = try await act(.click(CUClickAction(ref: ref(link))))
        XCTAssertEqual(downs.count, 1, "no resend when the window was already key")
        XCTAssertFalse(r.detail?.contains("resent once") ?? false)
    }

    func testAListedPressTheAppRefusesFallsBackToEvents() async throws {
        world()
        ax.refuses = ["\(token(link)):AXPress"]
        try await act(.click(CUClickAction(ref: ref(link))))
        XCTAssertEqual(ax.performed, ["\(token(link)):AXPress"])
        XCTAssertEqual(downs.count, 1, "then one window-targeted click")
    }

    func testCanvasModifiedAndMiddleClicksElsewhereAreWindowTargetedEvents() async throws {
        world()
        let s = shot()
        let canvasClick = try await act(.click(CUClickAction(point: [500, 400], shotId: s)))
        try await act(.click(CUClickAction(point: [30, 55], shotId: s, modifiers: ["cmd"])))
        try await act(.click(CUClickAction(point: [30, 55], shotId: s, button: .middle)))
        XCTAssertTrue(ax.performed.isEmpty, "a modified click is never turned into a plain press")
        XCTAssertEqual(downs.map(\.type), [.leftMouseDown, .leftMouseDown, .otherMouseDown])
        XCTAssertEqual(downs.map(\.location), [CGPoint(x: 600, y: 500), CGPoint(x: 130, y: 155), CGPoint(x: 130, y: 155)])
        XCTAssertTrue(downs[1].flags.contains(.maskCommand))
        XCTAssertTrue(downs.allSatisfy { $0.window == 77 && $0.window2 == 77 && $0.route == .publicPid })
        XCTAssertTrue(canvasClick.detail?.contains("can't be confirmed") ?? false, "never claims it landed")
        XCTAssertTrue(sys.moved.isEmpty)
        XCTAssertTrue(sys.activated.isEmpty, "nothing brought forward")
    }

    func testWithThePrivatePathOffAnOffscreenWindowGetsNoEvents() async throws {
        world()
        let s = shot()
        // Nothing can reach it from here: a desktop visit could (with the user's say), so that is what it asks for.
        let e = await expect("needs_desktop_visit") {
            try await self.core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                           action: .click(CUClickAction(point: [500, 400], shotId: s)),
                                                           access: .full, allowForeground: false, privatePath: false))
        }
        XCTAssertTrue(e?.message.contains("the click can't be sent there with the private event path off") ?? false, e?.message ?? "")
        XCTAssertEqual(e?.data?["why"], .string("act"))
        XCTAssertTrue(sys.activated.isEmpty, "nobody was moved")
        // A scroll still works: Page Down to the app, no wheel.
        _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c2",
                                                    action: .scroll(CUScrollAction(point: [400, 300], shotId: s, direction: .down)),
                                                    access: .full, allowForeground: false, privatePath: false))
        XCTAssertEqual(poster.keyDowns.map(\.keycode), [121])
        XCTAssertFalse(poster.entries.contains { $0.type == .scrollWheel })
    }

    // MARK: scrolls

    func testAScrollElsewhereMovesTheScrollBarWhenThereIsOne() async throws {
        world(scrollBar: true)
        let r = try await act(.scroll(CUScrollAction(ref: ref(webArea), direction: .down, pages: 1)))
        XCTAssertEqual(r.rung, 1)
        XCTAssertTrue(ax.written.contains("\(token(bar)):AXValue"))
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testWithoutABarTheWheelGoesFirstAndPageKeysOnlyWhenNothingMoved() async throws {
        world()
        let s = shot()
        // The page moves when a wheel event arrives.
        poster.onPost = { [unowned self] e in
            guard e.type == .scrollWheel else { return }
            var scrolled = CGPoint(x: 100, y: -500)
            ax.put(webArea, [kAXPositionAttribute: AXValueCreate(.cgPoint, &scrolled)!])
        }
        let moved = try await act(.scroll(CUScrollAction(point: [400, 300], shotId: s, direction: .down, pages: 1)))
        XCTAssertTrue(poster.entries.contains { $0.type == .scrollWheel && $0.route == .publicPid })
        XCTAssertTrue(poster.keyDowns.isEmpty, "the wheel moved the page: no Page Down")
        XCTAssertTrue(moved.detail?.contains("its content moved") ?? false, moved.detail ?? "")
        // Now the wheel moves nothing: Page Down follows, after the page takes the focus.
        poster.onPost = nil
        try await act(.scroll(CUScrollAction(point: [400, 300], shotId: s, direction: .down, pages: 3)))
        XCTAssertEqual(poster.keyDowns.map(\.keycode), [121, 121, 121], "Page Down ×3")
        XCTAssertFalse(ax.written.contains("\(token(webArea)):AXFocused"), "web content is focused by press, never the AXFocused write")
        XCTAssertTrue(sys.moved.isEmpty)
    }

    // MARK: keyboard and drags

    func testTypingAndKeysElsewhereGoToThePid() async throws {
        world()
        ax.focus(pid: pid, on: field)
        try await act(.type(CUTypeAction(text: "jev")))
        try await act(.key(CUKeyAction(combo: "cmd+r")))
        try await act(.key(CUKeyAction(combo: "escape")))
        XCTAssertEqual(poster.keyDowns.count, 5)
        XCTAssertTrue(sys.moved.isEmpty)
    }

    func testAWebFieldOnAnotherSpaceIsFocusedByAWindowTargetedClickBeforeAnyKey() async throws {
        world()
        let comment = fakeElement(95_020)
        ax.add(comment, role: kAXTextAreaRole, title: "Comment", frame: CGRect(x: 120, y: 260, width: 300, height: 80),
               extra: [kAXParentAttribute: webArea])
        ax.focus(pid: pid, on: field)  // the page's Search field has the focus
        let order = OrderLog()
        poster.onPost = { [unowned self] e in
            if e.type == .leftMouseUp { ax.focus(pid: pid, on: comment) }  // the click focuses the textarea
            order.add(e.type == .leftMouseDown ? "click" : e.type == .keyDown ? "key" : "other")
        }
        try await act(.type(CUTypeAction(text: "ok", into: ref(comment))))
        let down = try XCTUnwrap(poster.entries.first { $0.type == .leftMouseDown })
        XCTAssertEqual(down.window, 77, "addressed to the off-Space window")
        XCTAssertEqual(down.location, CGPoint(x: 270, y: 300), "the textarea's centre")
        XCTAssertEqual(order.items.filter { $0 != "other" }, ["click", "key", "key"], "the click, then the keys")
        XCTAssertFalse(ax.written.contains { $0.hasSuffix(":\(kAXFocusedAttribute)") }, "no AXFocused write on web content")
    }

    func testAWebFieldOnAnotherSpaceThatTheClickDoesNotFocusIsRefused() async throws {
        world()
        let comment = fakeElement(95_021)
        ax.add(comment, role: kAXTextAreaRole, title: "Comment", frame: CGRect(x: 120, y: 260, width: 300, height: 80),
               extra: [kAXParentAttribute: webArea])
        ax.focus(pid: pid, on: field)  // and it stays there
        do {
            try await act(.type(CUTypeAction(text: "line one", into: ref(comment))))
            XCTFail("expected focus_not_placed")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("focus_not_placed"))
        }
        XCTAssertTrue(poster.keyDowns.isEmpty, "nothing typed into Search")
    }

    func testSetValueOnAScrollBarSetsANumberInZeroToOne() async throws {
        world(scrollBar: true)
        try await act(.setValue(CUSetValueAction(ref: ref(bar), value: "0.5")))
        let v = try XCTUnwrap(ax.attribute(bar, kAXValueAttribute) as? NSNumber)
        XCTAssertEqual(v.doubleValue, 0.5, accuracy: 0.0001, "a number, not the text \"0.5\"")
        for bad in ["2", "fifty"] {
            do {
                try await act(.setValue(CUSetValueAction(ref: ref(bar), value: bad)))
                XCTFail("expected invalid_params for \(bad)")
            } catch let e as CUError {
                XCTAssertEqual(e.code, "invalid_params", e.message)
            }
        }
    }

    func testAClosedWindowTheServerStillListsIsTargetLostNotNoWindow() async throws {
        world()
        sys.noSpaceWindows = [77]  // closed: off screen, on no Space, not in the app's list
        ax.dead.insert(AXIdentity(element: window))  // and its element no longer answers
        do {
            _ = try await core.targetFind(TargetFindParams(targetId: "t1", query: .fields(role: "button", name: nil, text: nil)))
            XCTFail("expected target_lost")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "target_lost", e.message)
            XCTAssertEqual(e.data?["reason"], .string("window_closed"), "Safari still runs: only its window closed")
        }
    }

    // MARK: a window in a full-screen transition reads as on no Space for a moment (the live gate, 2026-10-10)

    /// A capture-only target (its cached "window" is the application element), its window re-entering full screen:
    /// off screen, on NO Space and not in the app's list for a few readings, then on its new Space.
    private func transitionWorld(readingsOnNoSpace: Int?) -> NSLock {
        world()
        target.accessible = false
        core.registerForTesting(target, windowElement: ax.application(pid))
        core.windowGoneSettleMs = 800
        let lock = NSLock()
        var reads = 0
        sys.onSpaceReading = { _ in
            lock.withLock {
                reads += 1
                guard let n = readingsOnNoSpace else { return false }  // on no Space for good: closed
                return reads > n
            }
        }
        return lock
    }

    func testAWindowOnNoSpaceForAMomentIsKept() async throws {
        _ = transitionWorld(readingsOnNoSpace: 3)
        await core.checkWindows(pid: pid)  // the transition's destroyed-element notification
        XCTAssertNotNil(try? core.target("t1"), "a full-screen transition is not a closed window")
        let gone1 = try await core.windowGone(target)
        XCTAssertFalse(gone1, "on its Space again")
    }

    func testAWindowOnNoSpaceForGoodIsLostAfterTheSettle() async throws {
        _ = transitionWorld(readingsOnNoSpace: nil)
        let t0 = Date()
        await core.checkWindows(pid: pid)
        XCTAssertNil(try? core.target("t1"), "closed but still allocated: lost")
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(t0), 0.75, "only after the window was watched for the settle")
        // A window that leaves the server's listing during the watch is gone at once.
        _ = transitionWorld(readingsOnNoSpace: nil)
        sys.onSpaceReading = { [unowned self] _ in sys.windows[77] = nil; return false }
        let t1 = Date()
        let gone2 = try await core.windowGone(target)
        XCTAssertTrue(gone2)
        XCTAssertLessThan(Date().timeIntervalSince(t1), 0.6)
    }

    /// Review of round 2 (LOW): the watch held a Swift-concurrency thread for up to 1.5 s, before the call's cancel was
    /// registered, so Esc/cancel waited it out. It now suspends under the call's cancel.
    func testTheTransitionWatchEndsOnTheCallsCancel() async throws {
        _ = transitionWorld(readingsOnNoSpace: nil)
        core.windowGoneSettleMs = 5_000
        let t0 = Date()
        Task {
            try await Task.sleep(nanoseconds: 150_000_000)
            _ = try await core.cancel(CancelParams(callId: "c"))
        }
        let e = await expect("cancelled") { try await self.act(.key(CUKeyAction(combo: "escape"))) }
        XCTAssertNotNil(e)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 1.0, "stopped by the cancel, not after the watch")
        XCTAssertNotNil(try? core.target("t1"), "nothing decided: the target is kept")
    }

    /// Each check may watch for the whole settle: overlapping requests for one pid run ONE watch, then at most one more.
    func testWindowChecksForOnePidAreCoalesced() async throws {
        let lock = transitionWorld(readingsOnNoSpace: nil)
        var readings = 0
        sys.onSpaceReading = { _ in lock.withLock { readings += 1 }; return false }
        core.windowGoneSettleMs = 400
        await withTaskGroup(of: Void.self) { g in
            for _ in 0..<6 { g.addTask { [core] in await core!.checkWindows(pid: self.pid) } }
        }
        XCTAssertNil(try? core.target("t1"), "lost after the watch")
        let n = lock.withLock { readings }
        XCTAssertLessThan(n, 12, "one watch of ~6 readings (\(n)), not six overlapping ones")
    }

    // MARK: Why a target is lost (`data.reason`, and the `targetLost` notification's)

    @MainActor final class LostRecorder: CUCoreEvents {
        var lost: [String] = []
        func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool) {}
        func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID) {}
        func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?,
                      frame: CGRect?, text: String?, count: Int?, button: String?) {}
        func targetLost(targetId: String, reason: String) { lost.append("\(targetId) \(reason)") }
        func permissionsChanged(accessibility: Bool, screenRecording: Bool) {}
        func willSendEscape() {}
    }

    /// The error and the notification name what the engine saw: the app gone, or only its window.
    @MainActor func testTheReasonSaysWhetherTheAppQuitOrOnlyItsWindowClosed() async throws {
        for (quit, expected) in [(true, "app_quit"), (false, "window_closed")] {
            world()
            let recorder = LostRecorder()
            core.events = recorder
            if quit { sys.running = [] } else { sys.windows[77] = nil }
            do {
                _ = try await core.targetFind(TargetFindParams(targetId: "t1", query: .fields(role: "button", name: nil, text: nil)))
                XCTFail("expected target_lost")
            } catch let e as CUError {
                XCTAssertEqual(e.code, "target_lost", e.message)
                XCTAssertEqual(e.data?["reason"], .string(expected))
            }
            for _ in 0..<50 where recorder.lost.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
            XCTAssertEqual(recorder.lost, ["t1 \(expected)"], "the notification carries the same reason")
        }
    }

    func testAnUnknownTargetIdSaysWhetherAnEarlierHelperIssuedIt() async throws {
        world()
        do {
            _ = try await core.targetFind(TargetFindParams(targetId: "t99", query: .fields(role: "button", name: nil, text: nil)))
            XCTFail("expected target_lost")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("helper_restart"), "this run never issued t99: the helper restarted")
        }
        XCTAssertEqual(CUCore.unknownTargetReason("t3", issuedUpTo: 5), .unknown, "issued, then released or lost")
        XCTAssertEqual(CUCore.unknownTargetReason("t6", issuedUpTo: 5), .helperRestart)
        XCTAssertEqual(CUCore.unknownTargetReason("t1", issuedUpTo: 0), .helperRestart)
        for odd in ["x1", "t", "t0", "tabc", ""] { XCTAssertEqual(CUCore.unknownTargetReason(odd, issuedUpTo: 5), .unknown, odd) }
        XCTAssertEqual(CUTargetLostReason.allCases.map(\.rawValue), ["app_quit", "window_closed", "helper_restart", "unknown"])
    }

    func testAWindowOnAnotherSpaceIsNotTakenForClosed() async throws {
        world()
        sys.onSpace = true  // on another Space: on a Space
        let gone3 = try await core.windowGone(target)
        XCTAssertFalse(gone3)
        sys.onSpace = nil   // unknown: never guessed closed
        let gone4 = try await core.windowGone(target)
        XCTAssertFalse(gone4)
    }

    func testADragElsewhereIsWindowTargetedEvents() async throws {
        world()
        let r = try await act(.drag(CUDragAction(from: CUDragEnd(ref: ref(icon)), to: CUDragEnd(ref: ref(link)))))
        XCTAssertEqual(poster.entries.first?.type, .mouseMoved)
        XCTAssertEqual(poster.entries.last?.type, .leftMouseUp)
        XCTAssertEqual(poster.entries.last?.location, CGPoint(x: 170, y: 160))
        XCTAssertTrue(poster.entries.allSatisfy { $0.window == 77 })
        XCTAssertTrue(r.detail?.contains("the drag was sent to that window") ?? false, r.detail ?? "")
    }

    // MARK: Stage Manager

    func testAWindowOffStageIsActedOnWhereItIsNeverBroughtOnStage() async throws {
        world()
        // On this Space (AX lists it) but off stage: minimized, off screen, Stage Manager on.
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])
        ax.put(window, [kAXMinimizedAttribute: true])
        ax.makeSettable(window, kAXMinimizedAttribute)
        ax.setActions(window, ["AXAddToStage", kAXRaiseAction])
        sys.stageManager = true
        sys.front = 1
        pressesTakeEffect()
        let s = shot()
        let r = try await act(.click(CUClickAction(point: [30, 55], shotId: s)))  // the link's text
        XCTAssertFalse(ax.written.contains("\(token(window)):AXMinimized"), "never un-minimized: that pulls the user's view")
        XCTAssertFalse(ax.performed.contains("\(token(window)):AXAddToStage"), "never added to the stage: that activates the app")
        XCTAssertTrue(sys.activated.isEmpty)
        XCTAssertEqual(ax.performed.count, 1)
        XCTAssertTrue(ax.performed.first?.hasSuffix(":AXPress") ?? false, "the element under the point, over accessibility")
        XCTAssertTrue(poster.entries.isEmpty, "no pointer events")
        XCTAssertTrue(r.detail?.contains("Safari's window is off screen (minimized, or off stage in Stage Manager), so the element was sent")
                      ?? false, r.detail ?? "")
    }

    // MARK: event construction and route choice (pure)

    func testTheClickRouteListsBeforeEvents() {
        typealias R = CUCore.ElsewhereClick
        func route(_ actions: [String]?, _ b: CUMouseButton = .left, _ n: Int = 1, mod: Bool = false) -> R {
            CUCore.elsewhereClickRoute(button: b, count: n, modified: mod, actions: actions)
        }
        XCTAssertEqual(route([kAXPressAction]), .ax(kAXPressAction))
        XCTAssertEqual(route([]), .axUnlisted(kAXPressAction), "web content that lists no press: AX first, unlisted")
        XCTAssertEqual(route(nil), .events, "a canvas")
        XCTAssertEqual(route([kAXPressAction], mod: true), .events)
        XCTAssertEqual(route([kAXPressAction], .middle), .events)
        XCTAssertEqual(route([kAXShowMenuAction], .right), .ax(kAXShowMenuAction))
        XCTAssertEqual(route([kAXPressAction], .right), .axUnlisted(kAXShowMenuAction))
        XCTAssertEqual(route(["AXOpen", kAXPressAction], .left, 2), .ax("AXOpen"))
        XCTAssertEqual(route([kAXPressAction], .left, 2), .events)
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
