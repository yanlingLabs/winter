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
        XCTAssertEqual(CUCore.goneWithinNote(CUError.staleRef(676), within: 676),
                       "[676] is gone (the page changed) — showing the whole window")
        XCTAssertNil(CUCore.goneWithinNote(CUError.staleRef(676), within: nil), "a whole-window read: no fallback")
        XCTAssertNil(CUCore.goneWithinNote(CUError.busy(), within: 676), "only a gone ref")
    }
}
