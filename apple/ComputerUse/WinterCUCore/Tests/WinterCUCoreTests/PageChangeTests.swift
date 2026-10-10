import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// An act that changes the bound window's page (a link navigated, a tab switched) says so — its refs are gone —
/// and a `state({ within })` on a gone ref answers with the whole window instead of an error.
final class PageChangeTests: XCTestCase {
    let pid: pid_t = 6060
    let window = fakeElement(93_501)
    let web = fakeElement(93_502)
    let link = fakeElement(93_503)
    let otherTab = fakeElement(93_504)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    private func world() {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window], kAXFocusedWindowAttribute: window])
        ax.add(window, role: kAXWindowRole, title: "Page One", frame: CGRect(x: 0, y: 0, width: 900, height: 700),
               extra: [kAXChildrenAttribute: [web]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(web, role: "AXWebArea", title: "Page One", frame: CGRect(x: 0, y: 40, width: 900, height: 660),
               extra: [kAXChildrenAttribute: [link], kAXParentAttribute: window, "AXURL": URL(string: "https://example.test/one")! as CFURL])
        ax.add(link, role: "AXLink", title: "Next", frame: CGRect(x: 20, y: 60, width: 60, height: 20), extra: [kAXParentAttribute: web])
        ax.setActions(link, [kAXPressAction])
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
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Page One")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func click(_ e: AXUIElement) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .click(CUClickAction(ref: target.refs.ref(for: AXIdentity(element: e)))), access: .full,
            allowForeground: false, privatePath: false))
    }

    func testALinkThatNavigatesSaysThePageChanged() async throws {
        world()
        ax.onPerform = { [unowned self] _ in
            ax.put(web, ["AXURL": URL(string: "https://example.test/two")! as CFURL, kAXTitleAttribute: "Page Two"])
            ax.put(window, [kAXTitleAttribute: "Page Two"])
        }
        let r = try await click(link)
        XCTAssertEqual(r.pageNow, "Page Two")
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseDown }.isEmpty, "the press took effect (the page changed): no click as well")
    }

    func testATabSwitchSaysThePageChanged() async throws {
        world()
        ax.add(otherTab, role: "AXWebArea", title: "Other Tab", frame: CGRect(x: 0, y: 40, width: 900, height: 660),
               extra: [kAXParentAttribute: window, "AXURL": URL(string: "https://example.test/tab")! as CFURL])
        ax.onPerform = { [unowned self] _ in
            ax.dead.insert(AXIdentity(element: web))  // the shown web area is another tab's
            ax.put(window, [kAXChildrenAttribute: [otherTab], kAXTitleAttribute: "Other Tab"])
        }
        let r = try await click(link)
        XCTAssertEqual(r.pageNow, "Other Tab")
    }

    func testAnInPageAnchorJumpIsNotAPageChangeButAFragmentRouteIs() async throws {
        world()
        ax.onPerform = { [unowned self] _ in ax.put(web, ["AXURL": URL(string: "https://example.test/one#faq")! as CFURL]) }
        let jumped = try await click(link)
        XCTAssertNil(jumped.pageNow, "#providers → #faq: the same page")
        XCTAssertTrue(CUCore.samePage("https://a.test/p#x", "https://a.test/p#y"))
        XCTAssertFalse(CUCore.samePage("https://a.test/app#/inbox", "https://a.test/app#/sent"), "a page that routes by its fragment")
        XCTAssertFalse(CUCore.samePage("https://a.test/p#!a", "https://a.test/p#!b"))
        XCTAssertFalse(CUCore.samePage("https://a.test/p", "https://a.test/q#x"))
    }

    func testANavigationDropsTheFocusLineItReadOnTheOldPage() async throws {
        world()
        let field = fakeElement(93_510)
        ax.add(field, role: kAXTextFieldRole, title: "Search", frame: CGRect(x: 20, y: 100, width: 200, height: 20),
               extra: [kAXParentAttribute: web])
        ax.focus(pid: pid, on: field)
        ax.onPerform = { [unowned self] _ in
            ax.focus(pid: pid, on: link)
            ax.put(web, ["AXURL": URL(string: "https://example.test/two")! as CFURL])
            ax.put(window, [kAXTitleAttribute: "Page Two"])
        }
        let r = try await click(link)
        XCTAssertEqual(r.pageNow, "Page Two")
        XCTAssertNil(r.focusNow, "it named the old page")
    }

    func testANewTabIsSaidWhetherOrNotItIsShowing() async throws {
        world()
        let bar = fakeElement(93_520), tab1 = fakeElement(93_521), tab2 = fakeElement(93_522)
        ax.add(bar, role: kAXTabGroupRole, extra: [kAXChildrenAttribute: [tab1], kAXParentAttribute: window])
        ax.add(tab1, role: kAXRadioButtonRole, subrole: "AXTabButton", title: "Page One")
        ax.add(tab2, role: kAXRadioButtonRole, subrole: "AXTabButton", title: "Docs")
        ax.put(window, [kAXChildrenAttribute: [bar, web]])
        ax.onPerform = { [unowned self] _ in ax.put(bar, [kAXChildrenAttribute: [tab1, tab2]]) }
        let r = try await click(link)
        XCTAssertNil(r.pageNow)
        XCTAssertTrue(r.detail?.contains("a new tab opened in Browser (\u{201C}Docs\u{201D}) — the window still shows the tab it showed; click the new tab to work in it") ?? false, r.detail ?? "")
        XCTAssertEqual(CUCore.newTabNote(["A"], ["A", "B"], showing: true, app: "Safari"), "a new tab opened in Safari (\u{201C}B\u{201D}), and it is the one showing now")
        XCTAssertNil(CUCore.newTabNote(["A", "B"], ["A"], showing: false, app: "Safari"), "a closed tab is no new tab")
    }

    func testAWithinRefInATabThatIsNotShowingIsSaid() {
        world()
        let hiddenTab = fakeElement(93_530), cell = fakeElement(93_531)
        ax.add(hiddenTab, role: "AXWebArea", title: "Decider", frame: CGRect(x: 0, y: 40, width: 900, height: 660),
               extra: [kAXChildrenAttribute: [cell]])
        ax.add(cell, role: kAXGroupRole, title: "rows", frame: CGRect(x: 10, y: 50, width: 50, height: 20),
               extra: [kAXParentAttribute: hiddenTab, kAXChildrenAttribute: [AXUIElement]()])
        let ref = target.refs.ref(for: AXIdentity(element: cell))
        // (The tree read itself is the real accessibility API; the note it is prefixed with is checked here.)
        let note = core.notShowingNote(cell, ref: ref, target)
        XCTAssertTrue(note?.hasPrefix("[\(ref)] is in a page the window is not showing (\u{201C}Decider\u{201D}) — a tab in the background") ?? false, note ?? "nil")
        XCTAssertNil(core.notShowingNote(link, ref: 3, target), "the page the window shows: nothing to say")
    }

    func testAnActThatLeavesThePageSaysNothingEvenIfTheTitleTicks() async throws {
        world()
        ax.onPerform = { [unowned self] _ in ax.put(window, [kAXTitleAttribute: "(1) Page One"]) }  // an unread count
        let r = try await click(link)
        XCTAssertNil(r.pageNow, "same URL: the same page")
    }

    func testAWindowWithNoWebPageIsNotWalkedEveryAct() {
        world()
        ax.put(window, [kAXChildrenAttribute: [AXUIElement]()])
        XCTAssertNil(core.pageSignature(target))
        var reads = 0
        ax.onRead = { what in if what.hasSuffix(":\(kAXChildrenAttribute)") { reads += 1 } }
        XCTAssertNil(core.pageSignature(target))
        XCTAssertEqual(reads, 0, "remembered for a while")
    }

    func testAGoneWithinRefShowsTheWholeWindowAnyOtherErrorStays() {
        XCTAssertEqual(CUCore.goneWithinNote(CUError.staleRef(676), within: 676, pageChanged: true),
                       "[676] is gone (the page changed) — showing the whole window")
        XCTAssertEqual(CUCore.goneWithinNote(CUError.staleRef(676), within: 676, pageChanged: false),
                       "[676] is no longer in the window (a menu, panel or section it was in closed or was redrawn) — showing the whole window",
                       "never blames the page when it did not change")
        XCTAssertNil(CUCore.goneWithinNote(CUError.staleRef(676), within: nil), "a whole-window read: no fallback")
        XCTAssertNil(CUCore.goneWithinNote(CUError.busy(), within: 676), "only a gone ref")
    }
}
