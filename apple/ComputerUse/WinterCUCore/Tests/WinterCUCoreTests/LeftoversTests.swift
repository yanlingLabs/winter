import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The Web Store dogfood's leftovers, on a Material-LIKE page of our own (Chromium-shaped accessibility: a select-only
/// combo box read as a pop-up button beside its zero-size text input, a list of options that appears once it is
/// pressed, check boxes under a wrapper with a text label, radios), a file chooser's button, keys that changed nothing,
/// and an off-desktop picture taken right after an act.
final class LeftoversTests: XCTestCase {
    let pid: pid_t = 6161
    let window = fakeElement(98_001)
    let web = fakeElement(98_002)
    let form = fakeElement(98_003)
    let select = fakeElement(98_004)
    let hiddenInput = fakeElement(98_005)
    let list = fakeElement(98_006)
    let options = [fakeElement(98_007), fakeElement(98_008), fakeElement(98_009)]
    let optionNames = ["Productivity", "Developer Tools", "Education"]
    let boxRow = fakeElement(98_010)
    let box = fakeElement(98_011)
    let boxLabel = fakeElement(98_012)
    let radioRow = fakeElement(98_013)
    let radios = [fakeElement(98_014), fakeElement(98_015)]
    let fileButton = fakeElement(98_016)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }
    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    /// A browser in the background (its window on this desktop): a web page with a form holding a Material-like select
    /// and its hidden text input, a check box row, two radios and a "Select file" button.
    private func world() {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window], kAXFocusedWindowAttribute: window])
        ax.add(window, role: kAXWindowRole, title: "Dashboard", frame: CGRect(x: 0, y: 0, width: 1000, height: 800),
               extra: [kAXChildrenAttribute: [web]])
        ax.windowIDs[AXIdentity(element: window)] = 88
        ax.add(web, role: "AXWebArea", frame: CGRect(x: 0, y: 40, width: 1000, height: 760),
               extra: [kAXChildrenAttribute: [form], kAXParentAttribute: window])
        ax.add(form, role: kAXGroupRole, frame: CGRect(x: 40, y: 80, width: 600, height: 400),
               extra: [kAXChildrenAttribute: [select, hiddenInput, boxRow, radioRow, fileButton], kAXParentAttribute: web])
        ax.add(select, role: kAXPopUpButtonRole, title: "Category", frame: CGRect(x: 60, y: 100, width: 240, height: 40),
               extra: [kAXParentAttribute: form, kAXValueAttribute: "Choose one", kAXExpandedAttribute: false])
        ax.setActions(select, [kAXPressAction])
        ax.add(hiddenInput, role: kAXTextFieldRole, frame: CGRect(x: 60, y: 100, width: 0, height: 0),
               extra: [kAXParentAttribute: form, kAXValueAttribute: ""])
        ax.add(boxRow, role: kAXGroupRole, frame: CGRect(x: 60, y: 160, width: 400, height: 40),
               extra: [kAXParentAttribute: form, kAXChildrenAttribute: [box, boxLabel]])
        ax.setActions(boxRow, [kAXPressAction])
        ax.add(box, role: kAXCheckBoxRole, frame: CGRect(x: 60, y: 170, width: 20, height: 20),
               extra: [kAXParentAttribute: boxRow, kAXValueAttribute: 0, kAXTitleUIElementAttribute: boxLabel])
        ax.setActions(box, [kAXPressAction])
        ax.add(boxLabel, role: kAXStaticTextRole, frame: CGRect(x: 90, y: 170, width: 300, height: 20),
               extra: [kAXParentAttribute: boxRow, kAXValueAttribute: "Mature content"])
        ax.setActions(boxLabel, [kAXPressAction])
        ax.add(radioRow, role: kAXGroupRole, frame: CGRect(x: 60, y: 220, width: 400, height: 40),
               extra: [kAXParentAttribute: form, kAXChildrenAttribute: radios])
        ax.setActions(radioRow, [kAXPressAction])
        for (i, r) in radios.enumerated() {
            ax.add(r, role: kAXRadioButtonRole, title: i == 0 ? "Public" : "Private",
                   frame: CGRect(x: 60 + CGFloat(i) * 120, y: 230, width: 100, height: 20),
                   extra: [kAXParentAttribute: radioRow, kAXValueAttribute: 0])
            ax.setActions(r, [kAXPressAction])
        }
        ax.add(fileButton, role: kAXButtonRole, title: "Select file", frame: CGRect(x: 60, y: 300, width: 120, height: 32),
               extra: [kAXParentAttribute: form])
        ax.setActions(fileButton, [kAXPressAction])
        // The select's list appears at the end of the page (an overlay) when it is pressed; an option pressed shows in it.
        ax.add(list, role: kAXListRole, frame: CGRect(x: 60, y: 140, width: 240, height: 120), extra: [kAXParentAttribute: web])
        for (i, o) in options.enumerated() {
            ax.add(o, role: kAXStaticTextRole, frame: CGRect(x: 60, y: 140 + CGFloat(i) * 40, width: 240, height: 40),
                   extra: [kAXParentAttribute: list, kAXValueAttribute: optionNames[i]])
            ax.setActions(o, [kAXPressAction])
        }
        ax.put(list, [kAXChildrenAttribute: options])
        ax.onPerform = { [unowned self] what in
            if what == "\(token(select)):AXPress" { open(true) }
            if what == "\(token(box)):AXPress" {
                let v = (ax.attribute(box, kAXValueAttribute) as? NSNumber)?.intValue ?? 0
                ax.put(box, [kAXValueAttribute: v == 0 ? 1 : 0])
            }
            for (i, o) in options.enumerated() where what == "\(token(o)):AXPress" {
                ax.put(select, [kAXValueAttribute: optionNames[i]])
                open(false)
            }
        }
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.example.browser"
        let w = FakeSystem.window(88, pid: pid, CGRect(x: 0, y: 0, width: 1000, height: 800), owner: "Browser")
        sys.windows[88] = w
        sys.stack = [w]
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.browser", appName: "Browser",
                          isChromium: true, mirror: false, windowID: 88, windowTitle: "Dashboard")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        let steady = WebPressTests.image(gray: 200)
        core.privateCaptureOverride = { _, _ in steady }
    }

    private func open(_ yes: Bool) {
        ax.put(web, [kAXChildrenAttribute: yes ? [form, list] : [form]])
        ax.put(select, [kAXExpandedAttribute: yes])
    }

    @discardableResult
    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: false))
    }

    private var mouseDowns: Int { poster.entries.filter { $0.type == .leftMouseDown }.count }

    // MARK: the select

    func testTheSelectIsNeverThePagesHiddenInputAndItsHiddenInputIsNamedByIt() {
        world()
        XCTAssertNil(core.hiddenInputWords(select, target), "a pop-up button (Chromium's select-only combo box) is a control")
        XCTAssertTrue(core.isWebSelect(select))
        let words = core.hiddenInputWords(hiddenInput, target) ?? ""
        XCTAssertTrue(words.hasPrefix("the hidden text input of the select [\(ref(select))] \u{201C}Category\u{201D}"), words)
    }

    func testAClickOnTheSelectPressesItAndItsOptionsAppear() async throws {
        world()
        let r = try await act(.click(CUClickAction(ref: ref(select))))
        XCTAssertTrue(ax.performed.contains("\(token(select)):AXPress"))
        XCTAssertNil(r.detail, "the list opened: the press is confirmed")
        XCTAssertEqual(ax.elements(web, kAXChildrenAttribute).count, 2, "the options are in the page now")
        XCTAssertEqual(mouseDowns, 0)
    }

    func testAClickOnItsHiddenInputPressesTheSelect() async throws {
        world()
        let r = try await act(.click(CUClickAction(ref: ref(hiddenInput))))
        XCTAssertTrue(ax.performed.contains("\(token(select)):AXPress"), "\(ax.performed)")
        XCTAssertTrue(r.detail?.contains("[\(ref(hiddenInput))] is the hidden text input of the select [\(ref(select))] \u{201C}Category\u{201D} — the select was pressed; setValue(\(ref(select)), \"<option>\") chooses an option") ?? false,
                      r.detail ?? "")
    }

    func testSetValueOpensTheSelectAndPressesTheOptionNamed() async throws {
        world()
        let r = try await act(.setValue(CUSetValueAction(ref: ref(select), value: "developer tools")))
        XCTAssertEqual(ax.performed, ["\(token(select)):AXPress", "\(token(options[1])):AXPress"])
        XCTAssertEqual(ax.string(select, kAXValueAttribute), "Developer Tools")
        XCTAssertTrue(ax.written.isEmpty, "no value written to the select: \(ax.written)")
        XCTAssertEqual(r.detail, "chose \u{201C}Developer Tools\u{201D} in [\(ref(select))] \u{201C}Category\u{201D} (opened it, pressed the option; it shows it now)")
    }

    func testSetValueOnTheHiddenInputChoosesInTheSelect() async throws {
        world()
        _ = try await act(.setValue(CUSetValueAction(ref: ref(hiddenInput), value: "Educ")))
        XCTAssertEqual(ax.string(select, kAXValueAttribute), "Education", "a unique prefix")
        XCTAssertFalse(ax.written.contains { $0.hasPrefix(token(hiddenInput)) }, "nothing typed into the hidden input")
    }

    func testNoMatchingOptionFailsNamingTheOptions() async throws {
        world()
        do {
            try await act(.setValue(CUSetValueAction(ref: ref(select), value: "Games")))
            XCTFail("no option is Games")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "invalid_params")
            XCTAssertTrue(e.message.contains("no single option of [\(ref(select))] \u{201C}Category\u{201D} matches \u{201C}Games\u{201D} — its options: \u{201C}Productivity\u{201D}, \u{201C}Developer Tools\u{201D}, \u{201C}Education\u{201D} (the list is open now; state() shows it)"), e.message)
        }
        XCTAssertEqual(ax.performed, ["\(token(select)):AXPress"], "no option pressed")
    }

    func testAnAlreadyShownOptionIsNotPressedAgain() async throws {
        world()
        ax.put(select, [kAXValueAttribute: "Education"])
        let r = try await act(.setValue(CUSetValueAction(ref: ref(select), value: "education")))
        XCTAssertTrue(ax.performed.isEmpty)
        XCTAssertTrue(r.detail?.hasSuffix("already shows \u{201C}Education\u{201D} — nothing was pressed") ?? false, r.detail ?? "")
    }

    func testAListThatNeverOpensIsSaidPlainly() async throws {
        world()
        ax.onPerform = nil  // the press does nothing the page shows
        core.privateCaptureOverride = { _, _ in nil }
        do {
            try await act(.setValue(CUSetValueAction(ref: ref(select), value: "Education")))
            XCTFail("no list")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
            XCTAssertTrue(e.message.contains("[\(ref(select))] \u{201C}Category\u{201D}'s list of options did not appear after it was pressed"), e.message)
        }
    }

    /// A page's own <select>: its options are inside it, closed — the option is pressed where it is, the select never
    /// opened (its pop-up is the browser's own menu).
    func testANativeSelectsOptionIsPressedWithoutOpeningIt() async throws {
        world()
        let menu = fakeElement(98_040), items = [fakeElement(98_041), fakeElement(98_042)]
        ax.put(select, [kAXChildrenAttribute: [menu]])
        ax.add(menu, role: kAXMenuRole, extra: [kAXParentAttribute: select, kAXChildrenAttribute: items])
        for (i, m) in items.enumerated() {
            ax.add(m, role: kAXMenuItemRole, title: ["English", "French"][i], frame: CGRect(x: 60, y: 100, width: 240, height: 40),
                   extra: [kAXParentAttribute: menu, kAXSelectedAttribute: i == 0])
            ax.setActions(m, [kAXPressAction])
        }
        ax.put(select, [kAXValueAttribute: "English"])
        ax.onPerform = { [unowned self] what in
            if what == "\(token(items[1])):AXPress" {
                ax.put(select, [kAXValueAttribute: "French"])
                ax.put(items[0], [kAXSelectedAttribute: false]); ax.put(items[1], [kAXSelectedAttribute: true])
            }
        }
        let r = try await act(.setValue(CUSetValueAction(ref: ref(select), value: "french")))
        XCTAssertEqual(ax.performed, ["\(token(items[1])):AXPress"], "never the select itself")
        XCTAssertEqual(r.detail, "chose \u{201C}French\u{201D} in [\(ref(select))] \u{201C}Category\u{201D} (pressed its option; it shows it now)")
    }

    func testTheTextInsideACheckBoxPressesTheCheckBox() async throws {
        world()
        let inner = fakeElement(98_050)
        ax.put(box, [kAXChildrenAttribute: [inner]])
        ax.add(inner, role: kAXStaticTextRole, frame: CGRect(x: 62, y: 172, width: 16, height: 16),
               extra: [kAXParentAttribute: box, kAXValueAttribute: "Mature"])
        XCTAssertTrue(core.toggleFor(inner).map { CFEqual($0, box) } ?? false)
    }

    func testOptionMatchingRules() {
        let opts = ["Productivity", "Developer Tools", "Education", "Developer Tools (beta)"]
        XCTAssertEqual(CUCore.matchOption("developer  tools", opts), 1, "equal first, case and spacing aside")
        XCTAssertEqual(CUCore.matchOption("Prod", opts), 0)
        XCTAssertNil(CUCore.matchOption("Developer", opts), "two begin with it")
        XCTAssertEqual(CUCore.matchOption("beta", opts), 3)
        XCTAssertNil(CUCore.matchOption("  ", opts))
    }

    // MARK: check boxes and radios

    func testAClickOnACheckBoxsWrapperPressesTheCheckBox() async throws {
        world()
        let r = try await act(.click(CUClickAction(ref: ref(boxRow))))
        XCTAssertEqual(ax.performed, ["\(token(box)):AXPress"], "never the wrapper")
        XCTAssertEqual((ax.attribute(box, kAXValueAttribute) as? NSNumber)?.intValue, 1, "checked")
        XCTAssertTrue(r.detail?.hasPrefix("[\(ref(boxRow))] holds the check box [\(ref(box))]") ?? false, r.detail ?? "")
    }

    func testAClickOnACheckBoxsLabelPressesTheCheckBox() async throws {
        world()
        let r = try await act(.click(CUClickAction(ref: ref(boxLabel))))
        XCTAssertEqual(ax.performed, ["\(token(box)):AXPress"])
        XCTAssertEqual((ax.attribute(box, kAXValueAttribute) as? NSNumber)?.intValue, 1)
        XCTAssertTrue(r.detail?.contains("that check box was pressed") ?? false, r.detail ?? "")
    }

    func testAGroupOfTwoRadiosIsNoOnesWrapper() {
        world()
        XCTAssertNil(core.toggleFor(radioRow), "two radios: which one is not said")
        XCTAssertNil(core.toggleFor(form), "a form with other controls")
        XCTAssertTrue(core.toggleFor(boxRow).map { CFEqual($0, box) } ?? false)
    }

    func testACardHoldingOneCheckBoxIsNotItsRow() {
        world()
        var o = CGPoint(x: 60, y: 160), s = CGSize(width: 400, height: 300)
        ax.put(boxRow, [kAXPositionAttribute: AXValueCreate(.cgPoint, &o)!, kAXSizeAttribute: AXValueCreate(.cgSize, &s)!])
        XCTAssertNil(core.toggleFor(boxRow))
    }

    func testCheckedStatesReadFromAnyValueShape() {
        XCTAssertEqual(AXTreeReader.checkedState("1"), true)
        XCTAssertEqual(AXTreeReader.checkedState("true"), true)
        XCTAssertEqual(AXTreeReader.checkedState(" 0 "), false)
        XCTAssertNil(AXTreeReader.checkedState("2"), "mixed claims nothing")
        XCTAssertEqual(AX.stringValue(NSNumber(value: 1)), "1")
        XCTAssertEqual(AX.stringValue(kCFBooleanTrue), "1")
    }

    /// Item 5: a value past what `state({ within })` reads whole says how much it shows.
    func testAValueLongerThanAWithinReadSaysHowMuchItShows() {
        XCTAssertEqual(CUStateFormatter.wholeHint(ref: 5, count: 250), "state({within:5}) shows it whole")
        XCTAssertEqual(CUStateFormatter.wholeHint(ref: 5, count: 9000), "state({within:5}) shows its first 8000")
        let node = CUNode(ref: 5, role: "AXTextArea", value: String(repeating: "a", count: 9000))
        XCTAssertTrue(CUFinder.summary(node).value?.hasSuffix("(9000 characters — state({within:5}) shows its first 8000)") ?? false)
    }

    // MARK: review fixes

    /// H1: an option whose text another option's contains is chosen only when the select shows EXACTLY it.
    private func sizes(_ names: [String], shows: String, pageIgnores: Bool, pageShows: String? = nil) {
        world()
        for (i, o) in options.enumerated() { ax.put(o, [kAXValueAttribute: i < names.count ? names[i] : "Other \(i)"]) }
        ax.put(select, [kAXValueAttribute: shows])
        ax.onPerform = { [unowned self] what in
            if what == "\(token(select)):AXPress" { open(true) }
            for o in options where what == "\(token(o)):AXPress" {
                if !pageIgnores { ax.put(select, [kAXValueAttribute: pageShows ?? ax.string(o, kAXValueAttribute)!]) }
                open(false)
            }
        }
    }

    func testAnIgnoredPressIsNotTakenForSmallInExtraSmall() async throws {
        sizes(["Small", "Extra Small"], shows: "Extra Small", pageIgnores: true)
        let r = try await act(.setValue(CUSetValueAction(ref: ref(select), value: "small")))
        XCTAssertTrue(r.detail?.contains("pressed the option \u{201C}Small\u{201D} of [\(ref(select))] \u{201C}Category\u{201D}, but the select did not change to it (it reads \u{201C}Extra Small\u{201D})") ?? false, r.detail ?? "")
    }

    func testASelectShowingALongerOptionIsNotTheShorterOne() async throws {
        sizes(["Small", "Small Print"], shows: "Choose one", pageIgnores: false, pageShows: "Small Print")
        let r = try await act(.setValue(CUSetValueAction(ref: ref(select), value: "Small")))
        XCTAssertTrue(r.detail?.contains("but the select did not change to it (it reads \u{201C}Small Print\u{201D})") ?? false, r.detail ?? "")
        sizes(["Small", "Extra Small"], shows: "Choose one", pageIgnores: false)
        let ok = try await act(.setValue(CUSetValueAction(ref: ref(select), value: "Extra Small")))
        XCTAssertTrue(ok.detail?.hasPrefix("chose \u{201C}Extra Small\u{201D}") ?? false, ok.detail ?? "")
    }

    /// M5: text beside a check box that is not its own label presses nothing else.
    func testTextBesideACheckBoxThatIsNotItsLabelIsNotRedirected() async throws {
        world()
        ax.drop(box, kAXTitleUIElementAttribute)
        XCTAssertNil(core.toggleFor(boxLabel))
        XCTAssertTrue(core.toggleFor(boxRow).map { CFEqual($0, box) } ?? false, "the wrapper still holds it")
        // Linked either way counts.
        ax.put(boxLabel, ["AXLinkedUIElements": [box]])
        XCTAssertTrue(core.toggleFor(boxLabel).map { CFEqual($0, box) } ?? false)
    }

    /// M5: a document's stand-in input (parked off the window, or in another container) is never a select's.
    func testADocumentStandInIsNotASelectsHiddenInput() {
        world()
        XCTAssertTrue(core.selectBeside(hiddenInput).map { CFEqual($0, select) } ?? false)
        var o = CGPoint(x: -9999, y: 100), z = CGSize(width: 1, height: 1)
        ax.put(hiddenInput, [kAXPositionAttribute: AXValueCreate(.cgPoint, &o)!])
        XCTAssertNil(core.selectBeside(hiddenInput), "not on the select")
        o = CGPoint(x: 60, y: 100); z = CGSize(width: 300, height: 1)
        ax.put(hiddenInput, [kAXPositionAttribute: AXValueCreate(.cgPoint, &o)!, kAXSizeAttribute: AXValueCreate(.cgSize, &z)!])
        XCTAssertTrue(core.selectBeside(hiddenInput) != nil)
        // In another container than the select (a document's input target inside its own group).
        let editor = fakeElement(98_060)
        ax.add(editor, role: kAXGroupRole, frame: CGRect(x: 40, y: 80, width: 600, height: 400),
               extra: [kAXParentAttribute: form, kAXChildrenAttribute: [hiddenInput]])
        ax.put(hiddenInput, [kAXParentAttribute: editor])
        XCTAssertNil(core.selectBeside(hiddenInput))
        XCTAssertEqual(core.hiddenInputWords(hiddenInput, target), "the page's hidden text input (it types into the document)")
    }

    /// M3: an arrow key that moved the panel's selected row is a change — no note.
    func testAnArrowThatMovedThePanelsSelectionGetsNoNote() async throws {
        world()
        let sheet = fakeElement(98_070), table = fakeElement(98_071), rows = [fakeElement(98_072), fakeElement(98_073)]
        ax.put(window, [kAXChildrenAttribute: [web, sheet]])
        ax.add(sheet, role: kAXSheetRole, frame: CGRect(x: 100, y: 40, width: 600, height: 400),
               extra: [kAXParentAttribute: window, kAXChildrenAttribute: [table]])
        ax.add(table, role: kAXOutlineRole, frame: CGRect(x: 120, y: 80, width: 560, height: 300),
               extra: [kAXParentAttribute: sheet, kAXChildrenAttribute: rows, kAXSelectedRowsAttribute: [rows[0]]])
        for (i, r) in rows.enumerated() {
            ax.add(r, role: kAXRowRole, frame: CGRect(x: 120, y: 80 + CGFloat(i) * 20, width: 560, height: 20), extra: [kAXParentAttribute: table])
        }
        ax.focus(pid: pid, on: table)
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            ax.put(table, [kAXSelectedRowsAttribute: [rows[1]]])
        }
        let r = try await act(.key(CUKeyAction(combo: "down", into: ref(table))))
        XCTAssertFalse(r.detail?.contains("nothing new appeared") ?? false, r.detail ?? "")
    }

    /// L5: the after-act wait stops on the call's cancel.
    func testTheAfterActWaitStopsOnCancel() throws {
        world()
        sys.windows[88]?.onScreen = false
        let budget = CUImageBudget(maxLongEdge: 400, quality: 0.8)
        let first = try XCTUnwrap(core.offScreenStill(target, nil, budget))
        let clock = CUSystemClock()
        _ = target.noteOffScreenShot(digest: CUCore.contentDigest(first.jpeg), at: clock.nowMs() - 50)
        target.lastActionMs = clock.nowMs()
        let token = CUCancellation.Token()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) { token.cancel() }
        let start = clock.nowMs()
        XCTAssertThrowsError(try core.offScreenAfterAct(target, nil, budget, token: token)) { e in
            XCTAssertEqual((e as? CUError)?.code, "cancelled")
        }
        XCTAssertLessThan(clock.nowMs() - start, 400, "not the whole 700 ms")
        // A first picture's wait too.
        let t2 = CUCancellation.Token(); t2.cancel()
        target.lastActionMs = clock.nowMs()
        _ = target.noteOffScreenShot(digest: 1, at: clock.nowMs() + 10)  // a picture after the act: no comparison
        XCTAssertThrowsError(try core.offScreenAfterAct(target, nil, budget, token: t2))
    }

    /// L6: a Tab the field took itself is not called ignored.
    func testATabTheFieldTookItselfIsSaidAsThat() async throws {
        world()
        let area = fakeElement(98_080)
        ax.put(form, [kAXChildrenAttribute: ax.elements(form, kAXChildrenAttribute) + [area]])
        ax.add(area, role: kAXTextAreaRole, frame: CGRect(x: 60, y: 400, width: 300, height: 60),
               extra: [kAXParentAttribute: form, kAXValueAttribute: "code", kAXFocusedAttribute: true])
        ax.focus(pid: pid, on: area)
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            ax.put(area, [kAXValueAttribute: "code\t"])
        }
        let r = try await act(.key(CUKeyAction(combo: "tab")))
        let d = r.detail ?? ""
        XCTAssertFalse(d.contains("may not have taken the key"), d)
        XCTAssertTrue(d.contains("the keyboard focus stayed in its field after tab, and the field's text changed (it took the key itself, as a tab character or an indent)"), d)
    }

    // MARK: a file chooser's button

    func testANoEffectClickOnAFileButtonSaysWhatMayWork() async throws {
        world()
        core.privateCaptureOverride = { _, _ in nil }  // no capture: no fallback click, the press stands
        let r = try await act(.click(CUClickAction(ref: ref(fileButton))))
        let d = r.detail ?? ""
        XCTAssertTrue(d.contains("had no effect accessibility can see"), d)
        XCTAssertTrue(d.hasSuffix("a page button that opens a file chooser or another system picker may need real keyboard input — once [\(ref(fileButton))] holds the keyboard focus, key(\"return\", { into: \(ref(fileButton)) }) sends it one"), d)
        // Focused: Return now.
        ax.focus(pid: pid, on: fileButton)
        ax.put(fileButton, [kAXFocusedAttribute: true])
        let again = try await act(.click(CUClickAction(ref: ref(fileButton))))
        XCTAssertTrue(again.detail?.hasSuffix("[\(ref(fileButton))] holds the keyboard focus now, so key(\"return\", { into: \(ref(fileButton)) }) sends it one") ?? false, again.detail ?? "")
    }

    func testPickerWords() {
        XCTAssertTrue(CUCore.opensPicker(["Select file"]))
        XCTAssertTrue(CUCore.opensPicker(["Upload new package"]))
        XCTAssertTrue(CUCore.opensPicker([nil, "Choose an image"]))
        XCTAssertFalse(CUCore.opensPicker(["Select all"]))
        XCTAssertFalse(CUCore.opensPicker(["Close"]))
    }

    // MARK: keys that changed nothing

    func testATabThatLeftTheFocusWhereItWasSaysSo() async throws {
        world()
        ax.focus(pid: pid, on: radios[0])
        ax.put(radios[0], [kAXFocusedAttribute: true])
        let r = try await act(.key(CUKeyAction(combo: "tab")))
        XCTAssertTrue(r.detail?.contains("the keyboard focus did not move after tab (the page may not have taken the key) — click the field you mean, or pass { into }") ?? false, r.detail ?? "")
    }

    func testATabThatMovedTheFocusSaysNothingOfIt() async throws {
        world()
        ax.focus(pid: pid, on: radios[0])
        ax.put(radios[0], [kAXFocusedAttribute: true])
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            ax.put(radios[0], [kAXFocusedAttribute: false])
            ax.put(radios[1], [kAXFocusedAttribute: true])
            ax.focus(pid: pid, on: radios[1])
        }
        let r = try await act(.key(CUKeyAction(combo: "tab")))
        XCTAssertFalse(r.detail?.contains("did not move") ?? false, r.detail ?? "")
    }

    func testASpaceThatLeftTheFocusedCheckBoxAsItWasSaysSo() async throws {
        world()
        ax.focus(pid: pid, on: box)
        ax.put(box, [kAXFocusedAttribute: true])
        let r = try await act(.key(CUKeyAction(combo: "space")))
        XCTAssertTrue(r.detail?.contains("the focused check box did not change after space") ?? false, r.detail ?? "")
    }

    // MARK: a key into an open panel

    func testAKeyIntoAPanelThatOpenedNothingSaysSo() async throws {
        world()
        let sheet = fakeElement(98_030), files = fakeElement(98_031)
        ax.put(window, [kAXChildrenAttribute: [web, sheet]])
        ax.add(sheet, role: kAXSheetRole, frame: CGRect(x: 100, y: 40, width: 600, height: 400),
               extra: [kAXParentAttribute: window, kAXChildrenAttribute: [files]])
        ax.add(files, role: kAXListRole, frame: CGRect(x: 120, y: 80, width: 560, height: 300), extra: [kAXParentAttribute: sheet])
        ax.focus(pid: pid, on: files)
        ax.put(files, [kAXFocusedAttribute: true])
        let r = try await act(.key(CUKeyAction(combo: "/", into: ref(files))))
        XCTAssertTrue(r.detail?.contains("nothing new appeared in the panel after / (no sheet or window opened, its focus did not move) — the panel may not take keys from here") ?? false, r.detail ?? "")
        // A sheet that opened (Go to folder) is a change: nothing said.
        let goTo = fakeElement(98_032)
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            ax.add(goTo, role: kAXSheetRole, frame: CGRect(x: 150, y: 60, width: 400, height: 120), extra: [kAXParentAttribute: sheet])
            ax.put(sheet, [kAXChildrenAttribute: [files, goTo]])
        }
        let again = try await act(.key(CUKeyAction(combo: "/", into: ref(files))))
        XCTAssertFalse(again.detail?.contains("nothing new appeared") ?? false, again.detail ?? "")
    }

    // MARK: an off-desktop picture right after an act

    func testAPictureUnchangedSinceBeforeTheActIsTakenAgainUntilItChanges() throws {
        world()
        sys.windows[88]?.onScreen = false
        let before = WebPressTests.image(gray: 200), after = WebPressTests.image(gray: 60)
        var shots = 0
        core.privateCaptureOverride = { _, _ in shots += 1; return shots <= 2 ? before : after }
        let budget = CUImageBudget(maxLongEdge: 400, quality: 0.8)
        let first = try XCTUnwrap(core.offScreenStill(target, nil, budget))
        _ = target.noteOffScreenShot(digest: CUCore.contentDigest(first.jpeg), at: CUSystemClock().nowMs() - 50)
        target.lastActionMs = CUSystemClock().nowMs()
        let shot = try XCTUnwrap(core.offScreenAfterAct(target, nil, budget))
        XCTAssertNotEqual(CUCore.contentDigest(shot.jpeg), CUCore.contentDigest(first.jpeg), "waited for the act's picture")
        XCTAssertEqual(shots, 3, "taken again once, 100 ms later")
    }

    func testAPictureThatNeverChangesIsWaitedOnABoundedTime() throws {
        world()
        sys.windows[88]?.onScreen = false
        let budget = CUImageBudget(maxLongEdge: 400, quality: 0.8)
        let first = try XCTUnwrap(core.offScreenStill(target, nil, budget))
        let clock = CUSystemClock()
        _ = target.noteOffScreenShot(digest: CUCore.contentDigest(first.jpeg), at: clock.nowMs() - 50)
        target.lastActionMs = clock.nowMs()
        let start = clock.nowMs()
        _ = try core.offScreenAfterAct(target, nil, budget)
        let took = clock.nowMs() - start
        XCTAssertGreaterThanOrEqual(took, CUCore.offScreenAfterActWaitMs - 50)
        XCTAssertLessThan(took, CUCore.offScreenAfterActWaitMs + 400)
    }

    func testNoActLatelyMeansNoWait() throws {
        world()
        sys.windows[88]?.onScreen = false
        let budget = CUImageBudget(maxLongEdge: 400, quality: 0.8)
        target.lastActionMs = CUSystemClock().nowMs() - 5000
        var shots = 0
        core.privateCaptureOverride = { _, _ in shots += 1; return WebPressTests.image(gray: 200) }
        _ = try core.offScreenAfterAct(target, nil, budget)
        XCTAssertEqual(shots, 1)
    }

    func testTheLabelSaysAPictureMayPredateTheLastAction() {
        let stale = CUCore.afterActFreshness("stale since 3 s ago: …", app: "Chrome", previous: (7, 1000, 1000), digest: 7,
                                             now: 2500, actedMs: 2000)
        XCTAssertEqual(stale, "stale since 3 s ago: … — this picture may predate the last action: Chrome may not redraw a window on another desktop until it is seen; screenshot({ live: true, reason }) takes one where the window is (the user is asked first)")
        let first = CUCore.afterActFreshness("freshness unknown: …", app: "Chrome", previous: nil, digest: 7, now: 2400, actedMs: 2000)
        XCTAssertEqual(first, "freshness unknown: … — taken 400 ms after the last action, with no earlier picture to compare: it may predate the action; screenshot({ live: true, reason }) takes one where the window is (the user is asked first)")
        XCTAssertEqual(CUCore.afterActFreshness("live: …", app: "Chrome", previous: (7, 1000, 1000), digest: 8, now: 2500, actedMs: 2000), "live: …")
        XCTAssertEqual(CUCore.afterActFreshness("likely current: …", app: "Chrome", previous: (7, 1000, 1000), digest: 7, now: 60_000, actedMs: 2000),
                       "likely current: …", "an act long ago: as it was")
    }
}
