import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Where keyboard input goes in the BOUND window (an app answers its focused element for its key window only),
/// the guards for text with no `into`, and the focus line after an act that moved it.
final class FocusTargetTests: XCTestCase {
    let pid: pid_t = 5959
    let window = fakeElement(94_001)       // the bound window: a document in a browser
    let toolbar = fakeElement(94_002)
    let address = fakeElement(94_003)      // the browser's own address/search field
    let web = fakeElement(94_004)
    let menubar = fakeElement(94_005)      // the page's own menu bar
    let docArea = fakeElement(94_006)      // the page's editable document
    let hidden = fakeElement(94_007)       // the page's hidden, zero-size input
    let other = fakeElement(94_010)        // another window of the app (its key window)
    let otherField = fakeElement(94_011)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    private func world(title: String = "Report - Editor", boundIsKey: Bool, pageFocus: AXUIElement? = nil) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window, other], kAXFocusedWindowAttribute: boundIsKey ? window : other])
        ax.add(window, role: kAXWindowRole, title: title, frame: CGRect(x: 0, y: 0, width: 1000, height: 800),
               extra: [kAXChildrenAttribute: [toolbar, web]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(toolbar, role: kAXToolbarRole, frame: CGRect(x: 0, y: 0, width: 1000, height: 40),
               extra: [kAXChildrenAttribute: [address], kAXParentAttribute: window])
        ax.add(address, role: kAXTextFieldRole, subrole: "AXSearchField", title: "smart search field",
               frame: CGRect(x: 200, y: 8, width: 500, height: 24), extra: [kAXParentAttribute: toolbar, kAXValueAttribute: "docs.example"])
        ax.add(web, role: "AXWebArea", title: title, frame: CGRect(x: 0, y: 40, width: 1000, height: 760),
               extra: [kAXChildrenAttribute: [menubar, docArea, hidden], kAXParentAttribute: window])
        ax.add(menubar, role: kAXMenuBarRole, title: "docs-menubar", frame: CGRect(x: 0, y: 40, width: 1000, height: 30),
               extra: [kAXParentAttribute: web])
        ax.add(docArea, role: kAXTextAreaRole, title: "Document content", frame: CGRect(x: 100, y: 100, width: 800, height: 600),
               extra: [kAXParentAttribute: web, kAXValueAttribute: "Hello", "AXEditableAncestor": docArea])
        ax.add(hidden, role: kAXTextAreaRole, frame: CGRect(x: 0, y: 0, width: 1, height: 1),
               extra: [kAXParentAttribute: web, kAXValueAttribute: "\u{200B}", "AXEditableAncestor": hidden])
        if let pageFocus { ax.put(pageFocus, [kAXFocusedAttribute: true]) }
        ax.add(other, role: kAXWindowRole, title: "Other", frame: CGRect(x: 50, y: 50, width: 800, height: 600),
               extra: [kAXChildrenAttribute: [otherField]])
        ax.windowIDs[AXIdentity(element: other)] = 88
        ax.add(otherField, role: kAXTextFieldRole, title: "Other field", frame: CGRect(x: 60, y: 60, width: 200, height: 24),
               extra: [kAXParentAttribute: other, kAXWindowAttribute: other])
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.example.browser"
        var w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 1000, height: 800), owner: "Browser")
        w.title = title
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.browser", appName: "Browser",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: title)
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    @discardableResult
    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: false))
    }

    private func refusal(_ a: CUAction) async -> CUError? {
        do { try await act(a); return nil } catch { return error as? CUError }
    }

    // MARK: the bound window's own focus

    func testABackgroundWindowsFocusIsFoundInsideItsWebArea() {
        world(boundIsKey: false, pageFocus: docArea)
        ax.focus(pid: pid, on: otherField)  // the app answers for its key window: another one
        let f = core.windowFocus(target)
        XCTAssertTrue(f.element.map { CFEqual($0, docArea) } ?? false)
        XCTAssertEqual(f.source, .webArea)
    }

    func testTheAppsAnswerWinsForItsKeyWindowEvenOverThePagesFocus() {
        world(boundIsKey: true, pageFocus: docArea)
        ax.focus(pid: pid, on: address)  // ⌘R left the keys in the address bar
        let f = core.windowFocus(target)
        XCTAssertTrue(f.element.map { CFEqual($0, address) } ?? false, "where the keys really go")
        XCTAssertEqual(f.source, .app)
    }

    func testAKeyWindowWithNoReportedFocusIsUnknownNotAGuess() {
        world(boundIsKey: true, pageFocus: docArea)
        let f = core.windowFocus(target)
        XCTAssertNil(f.element)
        XCTAssertNil(f.elsewhere)
    }

    func testTheKeyboardPathAndTheStateNameTheSameFocus() {
        // The app answers for its key window (another window's field); the bound window's page holds its own focus.
        // One resolver: what type() checks is what state() says, never the other window's field.
        world(boundIsKey: false, pageFocus: docArea)
        ax.focus(pid: pid, on: otherField)
        let keys = core.reportedFocus(target)
        let state = core.windowFocus(target, fresh: true).element
        XCTAssertTrue(keys.map { CFEqual($0, docArea) } ?? false, "not the other window's field")
        XCTAssertTrue(keys.flatMap { k in state.map { CFEqual(k, $0) } } ?? false)
    }

    func testAHiddenZeroSizeInputIsNamedAsThePagesInputOnAnySite() async throws {
        world(boundIsKey: false, pageFocus: hidden)
        ax.focus(pid: pid, on: otherField)
        let f = core.windowFocus(target)
        XCTAssertEqual(f.element.flatMap { core.hiddenInputWords($0, target) }, "the page's hidden text input (it types into the document)")
        let r = try await act(.type(CUTypeAction(text: "hello")))
        XCTAssertEqual(r.input, "the page's hidden text input (it types into the document)")
        XCTAssertTrue(r.detail?.contains("can't be read back here") ?? false, r.detail ?? "")
    }

    func testAClickOnThePagesHiddenInputSaysWhatWorksInstead() async throws {
        world(boundIsKey: false, pageFocus: hidden)
        ax.setActions(hidden, [kAXPressAction])
        let e = await refusal(.click(CUClickAction(ref: ref(hidden))))
        XCTAssertEqual(e?.code, "unsupported")
        XCTAssertTrue(e?.message.contains("is the page's hidden text input (it types into the document): it has no place on screen to click — type or paste into it with type(text, { into: \(ref(hidden)) })") ?? false, e?.message ?? "")
        XCTAssertFalse(e?.message.contains("scroll to it first") ?? true)
        XCTAssertTrue(ax.performed.isEmpty)
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testSelectAllIsNeverARangeOverAHiddenInputsOwnFiller() async throws {
        world(boundIsKey: false, pageFocus: hidden)
        ax.focus(pid: pid, on: otherField)
        ax.makeSettable(hidden, kAXSelectedTextRangeAttribute)
        _ = try? await act(.key(CUKeyAction(combo: "cmd+a")))
        XCTAssertFalse(ax.written.contains { $0.hasSuffix(":\(kAXSelectedTextRangeAttribute)") },
                       "a range over the proxy's filler selects nothing of the document")
        XCTAssertTrue(poster.keyDowns.contains { $0.flags.contains(.maskCommand) }, "the real ⌘A instead")
        XCTAssertNil(core.textLength(hidden, target))
        XCTAssertEqual(core.textLength(docArea, target), 5)
    }

    // MARK: guards for text with no `into`

    func testTextIntoAFocusThatIsNotEditableIsRefused() async throws {
        world(boundIsKey: true)
        ax.focus(pid: pid, on: menubar)
        let e = await refusal(.paste(CUPasteAction(text: "body")))
        XCTAssertEqual(e?.code, "refused")
        XCTAssertEqual(e?.data?["reason"], .string("focus_not_editable"))
        XCTAssertEqual(e?.message, "the focus is [\(ref(menubar))] menu bar \"docs-menubar\", not a text field — click the field or pass { into }")
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testSeveralLinesForTheBrowsersOwnFieldAreRefusedNamingThePage() async throws {
        world(boundIsKey: true, pageFocus: docArea)
        ax.focus(pid: pid, on: address)
        let e = await refusal(.paste(CUPasteAction(text: "line one\nline two\nline three")))
        XCTAssertEqual(e?.data?["reason"], .string("wrong_field_shape"))
        XCTAssertEqual(e?.message, "the focus is in Browser's own [\(ref(address))] search field \"smart search field\", not the page, and the text has 3 lines — the page's editable element is [\(ref(docArea))] text area \"Document content\"; pass { into } for the field you mean")
    }

    func testSeveralLinesForASingleLineFieldAreRefused() async throws {
        world(boundIsKey: false)
        // Not a browser page: the other window's field, bound.
        target = CUTarget(id: "t2", sessionId: "s", pid: pid, bundleId: "com.example.browser", appName: "Browser",
                          isChromium: false, mirror: false, windowID: 88, windowTitle: "Other")
        core.registerForTesting(target, windowElement: other)
        sys.windows[88] = FakeSystem.window(88, pid: pid, CGRect(x: 50, y: 50, width: 800, height: 600), owner: "Browser")
        ax.focus(pid: pid, on: otherField)
        let long = String(repeating: "x", count: 250)
        do {
            _ = try await core.targetAct(TargetActParams(targetId: "t2", sessionId: "s", callId: "c", action: .type(CUTypeAction(text: long)),
                                                         access: .full, allowForeground: false, privatePath: false))
            XCTFail("refused")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("wrong_field_shape"))
            XCTAssertEqual(e.message, "the focus is [\(target.refs.ref(for: AXIdentity(element: otherField)))] a single-line field (\"Other field\") but the text is 250 characters long — pass { into } for the field you mean")
        }
    }

    func testShortTextIntoTheAddressFieldAndAnyTextWithIntoAreLeftAlone() async throws {
        world(boundIsKey: true, pageFocus: docArea)
        ax.focus(pid: pid, on: address)
        let r = try await act(.type(CUTypeAction(text: "query")))
        XCTAssertEqual(r.input, "[\(ref(address))] search field \"smart search field\"")
        // `into` names the field: no guard, whatever the shape (the model chose it).
        _ = try await act(.type(CUTypeAction(text: "a\nb", into: ref(address))))
    }

    // MARK: the focus line after an act

    func testAShortcutThatMovesTheFocusSaysWhereItIsNow() async throws {
        world(boundIsKey: true, pageFocus: docArea)
        ax.focus(pid: pid, on: docArea)
        poster.onPost = { [unowned self] e in if e.type == .keyUp { ax.focus(pid: pid, on: address) } }
        let r = try await act(.key(CUKeyAction(combo: "cmd+r")))
        XCTAssertEqual(r.focusNow, "[\(ref(address))] search field \"smart search field\"")
        XCTAssertNil(r.focusLost)
        let again = try await act(.key(CUKeyAction(combo: "end")))
        XCTAssertNil(again.focusNow, "nothing when it did not change")
    }

    func testAFocusThatWentAwaySaysUnknown() async throws {
        world(boundIsKey: true)
        ax.focus(pid: pid, on: docArea)
        poster.onPost = { [unowned self] e in if e.type == .keyUp { ax.focus(pid: pid, on: nil) } }
        let r = try await act(.key(CUKeyAction(combo: "escape")))
        XCTAssertEqual(r.focusLost, true)
        XCTAssertNil(r.focusNow)
    }

    func testTheFocusLineNamesNoValueOfASecureField() async throws {
        world(boundIsKey: true)
        ax.put(address, [kAXSubroleAttribute: kAXSecureTextFieldSubrole, kAXTitleAttribute: "Password", kAXValueAttribute: "hunter2"])
        ax.focus(pid: pid, on: docArea)
        poster.onPost = { [unowned self] e in if e.type == .keyUp { ax.focus(pid: pid, on: address) } }
        let r = try await act(.key(CUKeyAction(combo: "tab")))
        XCTAssertEqual(r.focusNow, "[\(ref(address))] secure text field \"Password\"")
        XCTAssertFalse(r.focusNow?.contains("hunter2") ?? true)
    }
}
