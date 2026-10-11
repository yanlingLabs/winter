import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 4 of the live gate: an act that moves the focus says where it went (`focusNow`), and an act's keys name
/// the element they went into (`input`) — read where the app answers. Live (2026-10-11, the fixture's Docs page):
/// Tab moved the focus Find → Replace with, and the result said "the app reports no focused element, so where it
/// went is unknown": after the blip handed the key focus back the app held NO key window and answered no focused
/// element. Two reads fix it — the page's own focus when the app holds no key window, and the app's own answer
/// taken INSIDE the blip, while it holds the bound window key (a native window that is not key answers none).
final class FocusNowTests: XCTestCase {
    let pid: pid_t = 5858
    let window = fakeElement(96_001)
    let web = fakeElement(96_002)
    let first = fakeElement(96_003)
    let second = fakeElement(96_004)
    let userWindow = fakeElement(96_005)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    override func setUp() {
        FocusSPI.reset()
        FocusSPI.frontPid = 1
        FocusSPI.onFocus = nil
    }

    override func tearDown() { FocusSPI.onFocus = nil }

    /// The app in the background (the user's app, pid 1, in front) holding NO key window: it answers no focused
    /// element, its `AXFocusedWindow` still names the bound window, which says it is not key. `webPage`: the two
    /// fields are inputs of a web page (Find / Replace with); else native fields of the window.
    private func world(webPage: Bool) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window], kAXFocusedWindowAttribute: window])
        let fields = [first, second]
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 0, y: 0, width: 900, height: 700),
               extra: [kAXChildrenAttribute: webPage ? [web] : fields, kAXFocusedAttribute: false])
        ax.windowIDs[AXIdentity(element: window)] = 77
        if webPage {
            ax.add(web, role: "AXWebArea", frame: CGRect(x: 0, y: 40, width: 900, height: 660),
                   extra: [kAXChildrenAttribute: fields, kAXParentAttribute: window, kAXWindowAttribute: window])
        }
        let parent = webPage ? web : window
        ax.add(first, role: kAXTextFieldRole, title: webPage ? "Find" : "First", frame: CGRect(x: 40, y: 80, width: 300, height: 24),
               extra: [kAXParentAttribute: parent, kAXWindowAttribute: window])
        ax.add(second, role: kAXTextFieldRole, title: webPage ? "Replace with" : "Second", frame: CGRect(x: 40, y: 120, width: 300, height: 24),
               extra: [kAXParentAttribute: parent, kAXWindowAttribute: window])
        ax.setActions(first, [kAXPressAction])
        ax.put(ax.application(1), [kAXFocusedWindowAttribute: userWindow])
        ax.windowIDs[AXIdentity(element: userWindow)] = 31

        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.example.app"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 900, height: 700), owner: "App")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: focusSkyLight(), poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.app", appName: "App",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        core.keyTapInstaller = FakeKeyTapInstaller()
        core.blipSchedule = { _, _ in }
        core.keyReroutePost = { _, _ in }
    }

    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: true))
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    /// Tab moves the page's (DOM) focus from the first field to the second.
    private func tabMovesThePagesFocus() {
        ax.put(first, [kAXFocusedAttribute: true])
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown, e.keycode == 48 else { return }
            ax.put(first, [kAXFocusedAttribute: false])
            ax.put(second, [kAXFocusedAttribute: true])
        }
    }

    /// The Docs case: the app answers no focused element before, during or after the act — the page's own focus is
    /// what the result names, on both sides of the Tab.
    func testATabInAWebPageOfAnAppWithNoKeyWindowSaysWhereTheFocusWent() async throws {
        world(webPage: true)
        tabMovesThePagesFocus()
        let r = try await act(.key(CUKeyAction(combo: "tab")))
        XCTAssertEqual(poster.keyDowns.map(\.keycode), [48])
        XCTAssertNil(r.inputUnknown, "never “the app reports no focused element” — the page names it")
        XCTAssertTrue(r.input?.contains("\"Find\"") ?? false, r.input ?? "nil")
        XCTAssertTrue(r.focusNow?.contains("\"Replace with\"") ?? false, r.focusNow ?? "nil")
        XCTAssertNil(r.focusLost)
    }

    /// A click on web content (no blip) that places the focus: named, never "unknown (the app reports none)".
    func testAClickThatFocusesAWebFieldSaysSo() async throws {
        world(webPage: true)
        ax.onPerform = { [unowned self] what in
            if what.hasSuffix(":AXPress") { ax.put(first, [kAXFocusedAttribute: true]) }
        }
        let r = try await act(.click(CUClickAction(ref: ref(first))))
        XCTAssertNil(r.focusLost, "the page shows where the focus is")
        XCTAssertTrue(r.focusNow?.contains("\"Find\"") ?? false, r.focusNow ?? "nil")
    }

    /// The native case: the app answers for the bound window only while the blip holds it key — the focus is read
    /// there (set during the blip, nil after the hand-back): the keys went into the first field and left the focus in
    /// the second.
    func testTheFocusReadInsideTheBlipNamesWhereTheKeysWentAndWhereTheyLeftIt() async throws {
        world(webPage: false)
        var current = first
        var inBlip = false
        FocusSPI.onFocus = { [unowned self] in
            if FocusSPI.calls.last == "focus pid \(pid) window 77" {
                inBlip = true
                ax.focus(pid: pid, on: current)  // the window is key: the app answers for it
                ax.put(window, [kAXFocusedAttribute: true])
            } else if FocusSPI.calls.last == "focus pid 1 window 31" {
                inBlip = false
                ax.focus(pid: pid, on: nil)      // handed back: no key window, no answer
                ax.put(window, [kAXFocusedAttribute: false])
            }
        }
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown, e.keycode == 48 else { return }
            current = second
            if inBlip { ax.focus(pid: pid, on: second) }
        }
        let r = try await act(.key(CUKeyAction(combo: "tab")))
        XCTAssertNil(ax.focusedElement(pid: pid), "after the hand-back the app answers no focused element")
        XCTAssertEqual(Array(FocusSPI.calls.suffix(2)), ["defocus pid \(pid) window 77", "focus pid 1 window 31"], "handed back")
        XCTAssertNil(r.inputUnknown)
        XCTAssertTrue(r.input?.contains("\"First\"") ?? false, r.input ?? "nil")
        XCTAssertTrue(r.focusNow?.contains("\"Second\"") ?? false, r.focusNow ?? "nil")
        // And the next act starts from there: a second Tab names the second field as where its key went.
        poster.onPost = nil
        let r2 = try await act(.key(CUKeyAction(combo: "shift+tab")))
        XCTAssertTrue(r2.input?.contains("\"Second\"") ?? false, r2.input ?? "nil")
    }

    /// Never a focus nobody read: an app that answers nothing, even in the blip, with no page to ask, stays unknown.
    func testWithNothingToReadTheFocusStaysUnknown() async throws {
        world(webPage: false)
        let r = try await act(.key(CUKeyAction(combo: "tab")))
        XCTAssertEqual(r.inputUnknown, true)
        XCTAssertNil(r.input)
        XCTAssertNil(r.focusNow)
    }

    /// A Tab in typed text moves the focus as a person's would: keys, never an accessibility insert (measured on a
    /// probe app of ours: an insert of "hi\t" put a literal tab into the field and left the focus where it was).
    func testTypedTextWithATabGoesAsKeysNeverAsAnInsert() async throws {
        world(webPage: false)
        ax.focus(pid: pid, on: first)
        ax.makeSettable(first, kAXSelectedTextAttribute)
        _ = try await act(.type(CUTypeAction(text: "a\tb")))
        XCTAssertFalse(ax.written.contains { $0.hasSuffix(":AXSelectedText") }, "no insert")
        XCTAssertEqual(poster.keyDowns.map(\.keycode), [0, 48, 11], "a, Tab, b")
        // Without a tab the insert stays the first route.
        _ = try await act(.type(CUTypeAction(text: "plain")))
        XCTAssertTrue(ax.written.contains { $0.hasSuffix(":AXSelectedText") })
    }

    /// Review of round 4 (LOW): the answer read inside the blip (before its hand-back) replaced ANY read after the act
    /// that was not the app's own — a page that moved its focus after the keys got the stale one, which became the next
    /// act's "before". It stands in only when nothing is readable after the act.
    func testAFreshReadOfThePageWinsOverTheBlipsOlderAnswer() async throws {
        world(webPage: true)
        ax.put(first, [kAXFocusedAttribute: true])
        FocusSPI.onFocus = { [unowned self] in
            if FocusSPI.calls.last == "focus pid \(pid) window 77" { ax.focus(pid: pid, on: first) }  // the app's answer in the blip
            else if FocusSPI.calls.last == "focus pid 1 window 31" {
                ax.focus(pid: pid, on: nil)
                // The page moves its focus after the keys (its own script): the fresh read names the second field.
                ax.put(first, [kAXFocusedAttribute: false])
                ax.put(second, [kAXFocusedAttribute: true])
            }
        }
        let r = try await act(.key(CUKeyAction(combo: "x")))
        XCTAssertTrue(r.focusNow?.contains("\"Replace with\"") ?? false, "the page's own focus now: \(r.focusNow ?? "nil")")
    }
}
