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

    /// The bound window 77 at (0,0) 800×600, and another document window 78 of the app on top of it at (100,100)
    /// 800×600; `menu`: a pop-up menu window 79 (layer 101) over both; `sheet`: a sheet window 80 inside the bound one.
    private func world(menu: Bool = false, sheet: Bool = false, accessible: Bool = true, web: Bool = false) {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [other, bound]])
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
        sys.stack = stack
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: recordingSkyLight(), poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
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
        world(menu: true, sheet: true)
        let windowFor = core.windowFor(target)
        XCTAssertEqual(windowFor(CGPoint(x: 300, y: 300)), 79, "the pop-up menu over the point")
        XCTAssertEqual(windowFor(CGPoint(x: 220, y: 20)), 80, "the sheet over the point")
        XCTAssertEqual(windowFor(CGPoint(x: 700, y: 500)), 77)
    }

    func testWithNoAccessibilityAWindowNotInsideTheBoundOneIsAnotherDocument() {
        world(sheet: true, accessible: false)
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
}
