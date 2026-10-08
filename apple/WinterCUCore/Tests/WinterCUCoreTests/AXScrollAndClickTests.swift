import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The AX routes the Codex analysis of ChatGPT's helper turned up: scrolling by the scroll bar's page buttons
/// (and an element's own page action) when its value can't be moved, `AXPick` for elements that take no press,
/// and scrolling an element into view before a pointer click instead of clicking outside the window.
final class AXScrollAndClickTests: XCTestCase {
    let pid: pid_t = 4949
    let window = fakeElement(97_001)
    let area = fakeElement(97_002)
    let page = fakeElement(97_003)
    let bar = fakeElement(97_004)
    let incPage = fakeElement(97_005)
    let decPage = fakeElement(97_006)
    let pickable = fakeElement(97_007)
    let below = fakeElement(97_008)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    /// A window at (100,100) 800×600 holding a scroll area whose page (2400 tall) has a vertical bar with page
    /// buttons; `elsewhere`: the window is on another Space.
    private func world(barValue: Double = 0, settable: Bool = true, withBar: Bool = true, elsewhere: Bool = false) {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: elsewhere ? [AXUIElement]() : [window]])
        ax.add(window, role: kAXWindowRole, frame: CGRect(x: 100, y: 100, width: 800, height: 600),
               extra: [kAXChildrenAttribute: [area]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(area, role: kAXScrollAreaRole, frame: CGRect(x: 100, y: 100, width: 800, height: 600),
               extra: [kAXChildrenAttribute: withBar ? [page, bar] : [page]])
        ax.add(page, role: "AXWebArea", frame: CGRect(x: 100, y: 100, width: 800, height: 2400),
               extra: [kAXParentAttribute: area, kAXChildrenAttribute: [pickable, below]])
        if withBar {
            ax.put(area, [kAXVerticalScrollBarAttribute: bar])
            ax.add(bar, role: kAXScrollBarRole, extra: [kAXValueAttribute: barValue, kAXChildrenAttribute: [decPage, incPage]])
            if settable { ax.makeSettable(bar, kAXValueAttribute) }
            ax.add(incPage, role: kAXButtonRole, subrole: "AXIncrementPage")
            ax.add(decPage, role: kAXButtonRole, subrole: "AXDecrementPage")
            ax.setActions(incPage, [kAXPressAction])
            ax.setActions(decPage, [kAXPressAction])
        }
        ax.add(pickable, role: kAXMenuItemRole, title: "Large", frame: CGRect(x: 150, y: 150, width: 100, height: 20),
               extra: [kAXParentAttribute: page])
        ax.setActions(pickable, [kAXPickAction])
        ax.add(below, role: kAXStaticTextRole, title: "Footer", frame: CGRect(x: 150, y: 900, width: 80, height: 20),
               extra: [kAXParentAttribute: page])

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.example.app"
        var w = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 800, height: 600))
        w.onScreen = !elsewhere
        sys.windows[77] = w
        sys.stack = elsewhere ? [] : [w]
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: recordingSkyLight(), poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.app", appName: "App", isChromium: false,
                          mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }
    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

    @discardableResult
    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: true))
    }

    // MARK: scroll

    func testAScrollBarValueThatMovesIsEnough() async throws {
        world()
        let r = try await act(.scroll(CUScrollAction(ref: ref(page), direction: .down, pages: 1)))
        XCTAssertEqual(r.rung, 1)
        XCTAssertTrue(ax.written.contains("\(token(bar)):AXValue"))
        XCTAssertTrue(ax.performed.isEmpty, "no page button")
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testAValueTheAppIgnoresFallsBackToThePageButtons() async throws {
        world()
        ax.ignoresWrites = ["\(token(bar)):AXValue"]
        let r = try await act(.scroll(CUScrollAction(ref: ref(page), direction: .down, pages: 2)))
        XCTAssertEqual(ax.performed, ["\(token(incPage)):AXPress", "\(token(incPage)):AXPress"])
        XCTAssertEqual(r.detail, "it was scrolled with the scroll bar's page button ×2 over accessibility")
        XCTAssertTrue(poster.entries.isEmpty, "no wheel")
    }

    func testAnUnsettableBarScrollsUpWithTheDecrementPageButton() async throws {
        world(barValue: 0.5, settable: false)
        try await act(.scroll(CUScrollAction(ref: ref(page), direction: .up, pages: 1)))
        XCTAssertEqual(ax.performed, ["\(token(decPage)):AXPress"])
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testOnAnotherDesktopThePageButtonsComeBeforeTheWheel() async throws {
        world(settable: false, elsewhere: true)
        let r = try await act(.scroll(CUScrollAction(ref: ref(page), direction: .down, pages: 1)))
        XCTAssertEqual(ax.performed, ["\(token(incPage)):AXPress"])
        XCTAssertEqual(r.detail, "App's window is on another desktop, so it was scrolled with the scroll bar's page button ×1 over accessibility")
        XCTAssertTrue(poster.entries.isEmpty, "no wheel events and no Page Down")
    }

    func testWithNoBarAListedPageActionScrolls() async throws {
        world(withBar: false, elsewhere: true)
        ax.setActions(page, ["AXScrollDownByPage", "AXScrollUpByPage"])
        try await act(.scroll(CUScrollAction(ref: ref(page), direction: .down, pages: 3)))
        XCTAssertEqual(ax.performed, Array(repeating: "\(token(page)):AXScrollDownByPage", count: 3))
        XCTAssertTrue(poster.entries.isEmpty)
    }

    // MARK: click

    func testAnElementThatTakesPickIsPicked() async throws {
        world()
        let r = try await act(.click(CUClickAction(ref: ref(pickable))))
        XCTAssertEqual(r.rung, 1)
        XCTAssertEqual(ax.performed, ["\(token(pickable)):AXPick"])
        XCTAssertTrue(poster.entries.isEmpty)
        XCTAssertEqual(CUCore.elsewhereClickRoute(button: .left, count: 1, modified: false, actions: [kAXPickAction]), .ax(kAXPickAction))
    }

    func testAnElementOutsideTheWindowIsScrolledIntoViewBeforeAPointerClick() async throws {
        world()
        ax.onPerform = { [unowned self] what in
            guard what == "\(token(below)):AXScrollToVisible" else { return }
            var p = CGPoint(x: 150, y: 600)
            ax.put(below, [kAXPositionAttribute: AXValueCreate(.cgPoint, &p)!])
        }
        try await act(.click(CUClickAction(ref: ref(below))))
        XCTAssertEqual(ax.performed, ["\(token(below)):AXScrollToVisible"])
        let down = try XCTUnwrap(poster.entries.first { $0.type == .leftMouseDown })
        XCTAssertEqual(down.location, CGPoint(x: 190, y: 610), "its centre after scrolling into view")
    }

    func testAnElementThatStaysOutsideTheWindowIsNotClicked() async throws {
        world()
        do {
            try await act(.click(CUClickAction(ref: ref(below))))
            XCTFail("expected unsupported")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
            XCTAssertTrue(e.message.contains("outside the window and could not be scrolled into view"), e.message)
        }
        XCTAssertFalse(poster.entries.contains { $0.type == .leftMouseDown }, "never a click outside the window")
    }
}
