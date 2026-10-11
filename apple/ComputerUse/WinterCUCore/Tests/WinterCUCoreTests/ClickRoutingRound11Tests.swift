import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 11 (live, the Chrome Web Store page): a window-targeted click goes to the BOUND window wherever another of
/// the app's document windows covers the point — never to the window on top, which is often the user's own. What is
/// drawn over the bound window as part of it (a menu, a popover, a sheet, a page's popup) still takes the click.
final class ClickRoutingRound11Tests: XCTestCase {
    let pid: pid_t = 5151
    let bound = fakeElement(98_001)
    let other = fakeElement(98_002)
    let field = fakeElement(98_003)
    let webArea = fakeElement(98_004)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!
    /// What the background opener was asked to open (never the real NSWorkspace from a unit test).
    var opened: [[String]] = []

    /// The bound window 77 at (0,0) 800×600, and another document window 78 of the app on top of it at (100,100)
    /// 800×600; `menu`: a pop-up menu window 79 (layer 101) over both; `sheet`: a sheet window 80 inside the bound one.
    private func world(menu: Bool = false, sheet: Bool = false, accessible: Bool = true, web: Bool = false, order: [UInt32]? = nil,
                       axWindows: Bool = true) {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: axWindows ? [other, bound] : [AXUIElement]()])
        ax.add(bound, role: kAXWindowRole, subrole: kAXStandardWindowSubrole, frame: CGRect(x: 0, y: 0, width: 800, height: 600),
               extra: [kAXChildrenAttribute: [web ? webArea : field]])
        if web {
            ax.add(webArea, role: "AXWebArea", frame: CGRect(x: 0, y: 40, width: 800, height: 560),
                   extra: [kAXParentAttribute: bound, kAXChildrenAttribute: [field]])
        }
        ax.add(other, role: kAXWindowRole, subrole: kAXStandardWindowSubrole, frame: CGRect(x: 100, y: 100, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: bound)] = 77
        ax.windowIDs[AXIdentity(element: other)] = 78
        ax.add(field, role: "AXGroup", title: "Pane", frame: CGRect(x: 300, y: 300, width: 100, height: 40),
               extra: [kAXParentAttribute: web ? webArea : bound])

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.example.browser"
        let w77 = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 600))
        let w78 = FakeSystem.window(78, pid: pid, CGRect(x: 100, y: 100, width: 800, height: 600))
        sys.windows[77] = w77
        sys.windows[78] = w78
        var stack = [w78, w77]
        if menu { stack.insert(FakeSystem.window(79, pid: pid, CGRect(x: 250, y: 250, width: 200, height: 200), layer: 101), at: 0) }
        if sheet {
            let s = FakeSystem.window(80, pid: pid, CGRect(x: 200, y: 0, width: 400, height: 300))
            sys.windows[80] = s
            stack.insert(s, at: 0)
        }
        if let order {
            let all = Dictionary(uniqueKeysWithValues: stack.map { ($0.id, $0) })
            stack = order.compactMap { all[$0] }
        }
        sys.stack = stack
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: recordingSkyLight(), poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        opened = []
        core.openDocumentsOverride = { [unowned self] p in
            opened.append(p.urls)
            return OpenDocumentsResult(app: CUBoundApp(name: "Browser", bundleId: "com.example.default", pid: 9), windowID: nil)
        }
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.browser", appName: "Browser", isChromium: false,
                          mirror: false, windowID: 77, windowTitle: "Store")
        target.accessible = accessible
        core.registerForTesting(target, windowElement: bound)
        target.refs.beginGeneration()
    }

    func testAPointAnotherDocumentWindowCoversGoesToTheBoundWindow() {
        world()
        let windowFor = core.windowFor(target)
        XCTAssertEqual(windowFor(CGPoint(x: 320, y: 320)), 77, "the other window on top is not where the click goes")
        XCTAssertEqual(windowFor(CGPoint(x: 50, y: 50)), 77)
        XCTAssertEqual(core.otherDocumentWindows(target), [78])
    }

    func testAMenuOrASheetOverTheBoundWindowStillTakesTheClick() {
        // The bound window in front of the other one; its menu and its sheet above it.
        world(menu: true, sheet: true, order: [79, 80, 77, 78])
        let windowFor = core.windowFor(target)
        XCTAssertEqual(windowFor(CGPoint(x: 300, y: 300)), 79, "the pop-up menu over the point")
        XCTAssertEqual(windowFor(CGPoint(x: 220, y: 20)), 80, "the sheet over the point")
        XCTAssertEqual(windowFor(CGPoint(x: 700, y: 500)), 77)
    }

    func testWithNoAccessibilityAWindowNotInsideTheBoundOneIsAnotherDocument() {
        // The other window in front; the bound window's sheet travels with it, right above it.
        world(sheet: true, accessible: false, order: [78, 80, 77])
        let windowFor = core.windowFor(target)
        XCTAssertEqual(windowFor(CGPoint(x: 700, y: 500)), 77, "window 78 does not lie within the bound one")
        XCTAssertEqual(windowFor(CGPoint(x: 220, y: 20)), 80, "a window inside the bound one (a sheet) still does")
    }

    func testAClickByRefUnderAnotherWindowIsPostedToTheBoundWindow() async throws {
        world()
        let ref = target.refs.ref(for: AXIdentity(element: field))
        _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                     action: .click(CUClickAction(ref: ref)), access: .full,
                                                     allowForeground: false, privatePath: true))
        let clicks = poster.entries.filter { $0.type == .leftMouseDown || $0.type == .leftMouseUp }
        let windows = Set(clicks.map(\.window))
        XCTAssertEqual(clicks.count, 2, "a click went out")
        XCTAssertEqual(windows, [77], "every event names the bound window, none the window on top")
    }

    /// A web element clicked with events (it lists no press) that showed no effect: said, never a silent no-op.
    func testAWebClickThatChangedNothingSaysSo() async throws {
        world(web: true)
        let ref = target.refs.ref(for: AXIdentity(element: field))
        let r = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                         action: .click(CUClickAction(ref: ref)), access: .full,
                                                         allowForeground: false, privatePath: true))
        XCTAssertEqual(r.detail, "the click on [\(ref)] “Pane” had no visible effect (nothing changed that accessibility can see) — check with state() or a screenshot before clicking again")
    }

    /// The same click with an effect (the element's value changed when the button came up): nothing said.
    func testAWebClickThatTookEffectSaysNothing() async throws {
        world(web: true)
        poster.onPost = { [ax, field] e in
            if e.type == .leftMouseUp { ax!.put(field, [kAXValueAttribute: "on"]) }
        }
        let ref = target.refs.ref(for: AXIdentity(element: field))
        let r = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                         action: .click(CUClickAction(ref: ref)), access: .full,
                                                         allowForeground: false, privatePath: true))
        XCTAssertNil(r.detail)
    }

    /// Queue item 1: a check box's or radio's state is claimed only from 1/0 (true/false) — a value that is not a state
    /// (a web radio's own value, a label) or a mixed box claims nothing.
    func testACheckedStateIsClaimedOnlyFromAStateValue() {
        XCTAssertEqual(AXTreeReader.checkedState("1"), true)
        XCTAssertEqual(AXTreeReader.checkedState("0"), false)
        XCTAssertEqual(AXTreeReader.checkedState("true"), true)
        XCTAssertEqual(AXTreeReader.checkedState("false"), false)
        XCTAssertNil(AXTreeReader.checkedState("2"))
        XCTAssertNil(AXTreeReader.checkedState("non-trader"))
        XCTAssertNil(AXTreeReader.checkedState(""))
    }

    /// Review of round 11, MEDIUM #3: the bound app is in FRONT with another of its windows key (the user works there) —
    /// no pointer event goes to the bound window (it would raise it over the user's window and take their keys); with the
    /// bound window the key one, the click goes.
    func testAFrontAppsCoveredBoundWindowTakesNoClick() async throws {
        world()
        sys.front = pid
        ax.put(ax.application(pid), [kAXWindowsAttribute: [other, bound], kAXFocusedWindowAttribute: other])
        let ref = target.refs.ref(for: AXIdentity(element: field))
        do {
            _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                         action: .click(CUClickAction(ref: ref)), access: .full,
                                                         allowForeground: false, privatePath: true))
            XCTFail("refused")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("app_in_front"), e.message)
        }
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseDown || $0.type == .leftMouseUp }.isEmpty, "no click sent")
        ax.put(ax.application(pid), [kAXWindowsAttribute: [other, bound], kAXFocusedWindowAttribute: bound])
        _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c2",
                                                     action: .click(CUClickAction(ref: ref)), access: .full,
                                                     allowForeground: false, privatePath: true))
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 1, "the key bound window takes it")
    }

    /// Review of round 11, MEDIUM #4: a popup or sheet of the USER's window (above it, which is above the bound window)
    /// never takes the bound window's click — the first document window below it is the user's.
    func testAPopupOfTheUsersWindowNeverTakesTheClick() {
        world(menu: true, sheet: true, order: [79, 78, 80, 77])
        let windowFor = core.windowFor(target)
        XCTAssertEqual(windowFor(CGPoint(x: 300, y: 300)), 77, "the user's window's menu is not the bound window's")
        XCTAssertEqual(windowFor(CGPoint(x: 220, y: 20)), 80, "the bound window's own sheet, right above it, still is")
    }

    /// An empty accessibility answer (a timeout) falls back to the capture-only rule — never "every window takes it".
    func testAnEmptyAccessibilityAnswerFallsBackToTheCaptureOnlyRule() {
        world(axWindows: false)
        XCTAssertEqual(core.windowFor(target)(CGPoint(x: 320, y: 320)), 77)
    }

    /// Round 10's MEDIUM #7: a link to another site is rerouted in an Electron/CEF app too (no blanket exemption), and
    /// "the same site" is the registrable domain (files.slack.com from app.slack.com stays in the app).
    func testSameSiteIsTheRegistrableDomain() {
        XCTAssertEqual(CUCore.registrableDomain("files.slack.com"), "slack.com")
        XCTAssertEqual(CUCore.registrableDomain("app.slack.com"), "slack.com")
        XCTAssertEqual(CUCore.registrableDomain("www.bbc.co.uk"), "bbc.co.uk")
        XCTAssertEqual(CUCore.registrableDomain("localhost"), "localhost")
        world()
        let page = fakeElement(98_010), same = fakeElement(98_011), away = fakeElement(98_012)
        ax.add(page, role: "AXWebArea", extra: ["AXURL": URL(string: "https://app.slack.com/client")! as CFURL])
        ax.add(same, role: "AXLink", extra: ["AXURL": URL(string: "https://files.slack.com/x")! as CFURL, kAXParentAttribute: page])
        ax.add(away, role: "AXLink", extra: ["AXURL": URL(string: "https://example.org/a")! as CFURL, kAXParentAttribute: page])
        XCTAssertNil(core.linkURL(same, ElementInfo(same, ax)))
        XCTAssertEqual(core.linkURL(away, ElementInfo(away, ax))?.host, "example.org")
        let electron = CUTarget(id: "t9", sessionId: "s", pid: pid, bundleId: "com.tinyspeck.slackmacgap", appName: "Slack",
                                isChromium: true, mirror: false, windowID: 77, windowTitle: "Slack")
        XCTAssertFalse(core.isWebBrowser(electron), "an Electron app declares no http/https: not a browser")
    }

    /// Round 10's MEDIUM #7: action(ref, "press") on a link in an app that is not a browser opens it in the background too.
    func testAnAccessibilityPressOnALinkIsRerouted() async throws {
        world(web: true)
        core.isWebBrowserOverride = { _ in false }
        let link = fakeElement(98_013)
        ax.put(webArea, ["AXURL": URL(string: "https://mail.example.com/inbox")! as CFURL, kAXChildrenAttribute: [field, link]])
        ax.add(link, role: "AXLink", title: "Story", frame: CGRect(x: 300, y: 400, width: 80, height: 20),
               extra: ["AXURL": URL(string: "https://news.example.org/a")! as CFURL, kAXParentAttribute: webArea])
        ax.setActions(link, [kAXPressAction])
        let ref = target.refs.ref(for: AXIdentity(element: link))
        _ = try? await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                      action: .action(CUAXAction(ref: ref, name: "press")), access: .full,
                                                      allowForeground: false, privatePath: true))
        XCTAssertTrue(ax.performed.isEmpty, "the link is not pressed")
        XCTAssertEqual(opened, [["https://news.example.org/a"]], "opened in the background instead")
    }

    /// Round 10's MEDIUM #7, its daemon half (1.11.0): with `linkOpensViaDaemon`, the link is neither pressed nor opened
    /// by the helper — its URL goes back to the daemon, which opens it through its own door.
    func testALinkIsHandedToTheDaemonWhenItAsks() async throws {
        world(web: true)
        core.isWebBrowserOverride = { _ in false }
        let link = fakeElement(98_014)
        ax.put(webArea, ["AXURL": URL(string: "https://mail.example.com/inbox")! as CFURL, kAXChildrenAttribute: [field, link]])
        ax.add(link, role: "AXLink", title: "Story", frame: CGRect(x: 300, y: 400, width: 80, height: 20),
               extra: ["AXURL": URL(string: "https://news.example.org/a")! as CFURL, kAXParentAttribute: webArea])
        ax.setActions(link, [kAXPressAction])
        let ref = target.refs.ref(for: AXIdentity(element: link))
        let r = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                         action: .click(CUClickAction(ref: ref)), access: .full,
                                                         allowForeground: false, privatePath: true, linkOpensViaDaemon: true))
        XCTAssertEqual(r.linkOpen, "https://news.example.org/a")
        XCTAssertTrue(opened.isEmpty, "the helper opened nothing")
        XCTAssertTrue(ax.performed.isEmpty, "nothing pressed")
    }

    /// Review of round 12, MEDIUM #4: with the bound app in front and another of its windows key, a menu command is
    /// refused BEFORE anything is aimed or written (it would act on the user's window).
    func testAMenuCommandInAFrontAppWithTheUsersWindowKeyIsRefusedBeforeAiming() async throws {
        world()
        sys.front = pid
        ax.put(ax.application(pid), [kAXWindowsAttribute: [other, bound], kAXFocusedWindowAttribute: other])
        do {
            _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                         action: .menu(CUMenuAction(path: ["File", "Close"])), access: .full,
                                                         allowForeground: false, privatePath: true))
            XCTFail("refused")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("app_in_front"), e.message)
            XCTAssertTrue(e.message.contains("a menu command would act on the window the user is in"), e.message)
        }
        XCTAssertTrue(ax.written.isEmpty, "nothing aimed or written: \(ax.written)")
        XCTAssertTrue(ax.performed.isEmpty)
    }
}
