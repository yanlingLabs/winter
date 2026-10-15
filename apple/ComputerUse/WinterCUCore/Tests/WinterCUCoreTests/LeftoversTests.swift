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
    var clip: PasteAndQueueTests.FakePasteboard!

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
        clip = PasteAndQueueTests.FakePasteboard([])
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { [unowned self] in clip }, startMonitors: false)
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

    // MARK: the leftover probes on a real Chrome (2026-10-13)

    /// Chrome reads a `<div role="combobox">` select as a combo box whose value it calls settable: one with none of a
    /// text entry's attributes is a select (opened and its option pressed), never a value written that does nothing.
    func testAComboBoxThatTakesNoTypedTextIsASelectEvenWhenItsValueReadsSettable() {
        world()
        let combo = fakeElement(98_090), search = fakeElement(98_091)
        ax.put(form, [kAXChildrenAttribute: ax.elements(form, kAXChildrenAttribute) + [combo, search]])
        // As Chrome for Testing 156 gives a `<div role="combobox">` select (measured 2026-10-14): the text attributes
        // all there, its value settable, a list box pop-up — and no editable ancestor.
        let range = AXValueCreate(.cfRange, [CFRange(location: 0, length: 0)])!
        ax.add(combo, role: kAXComboBoxRole, title: "Size", frame: CGRect(x: 60, y: 420, width: 200, height: 30),
               extra: [kAXParentAttribute: form, kAXValueAttribute: "Medium", kAXNumberOfCharactersAttribute: 0,
                       kAXSelectedTextRangeAttribute: range, kAXInsertionPointLineNumberAttribute: Int.max,
                       "AXHasPopup": true, "AXPopupValue": "listbox", kAXExpandedAttribute: false])
        ax.makeSettable(combo, kAXValueAttribute)
        // An editable combo box (a search with suggestions): the same, plus its editable ancestor (itself).
        ax.add(search, role: kAXComboBoxRole, title: "Search", frame: CGRect(x: 300, y: 420, width: 200, height: 30),
               extra: [kAXParentAttribute: form, kAXValueAttribute: "", kAXNumberOfCharactersAttribute: 0,
                       kAXSelectedTextRangeAttribute: range, kAXInsertionPointLineNumberAttribute: Int.max,
                       "AXEditableAncestor": search, "AXHighestEditableAncestor": search])
        ax.makeSettable(search, kAXValueAttribute)
        XCTAssertTrue(core.isWebSelect(combo), "no editable ancestor: a select, whatever text attributes it carries")
        XCTAssertFalse(core.isWebSelect(search), "an editable combo box (a search with suggestions) is typed into")
        XCTAssertTrue(core.isWebSelect(select), "a pop-up button stays a select")
    }

    /// A failed read of the element's attribute names is unknown — retried once, and still unknown, the text-attribute
    /// rule: a field never turns into a select on a read that failed.
    func testAFailedAttributeReadNeverTurnsAFieldIntoASelect() {
        world()
        let search = fakeElement(98_095)
        ax.put(form, [kAXChildrenAttribute: ax.elements(form, kAXChildrenAttribute) + [search]])
        let range = AXValueCreate(.cfRange, [CFRange(location: 0, length: 0)])!
        ax.add(search, role: kAXComboBoxRole, title: "Search", frame: CGRect(x: 300, y: 420, width: 200, height: 30),
               extra: [kAXParentAttribute: form, kAXValueAttribute: "", kAXNumberOfCharactersAttribute: 0,
                       kAXSelectedTextRangeAttribute: range, "AXEditableAncestor": search])
        ax.makeSettable(search, kAXValueAttribute)
        let token = { () -> Int32 in var p: pid_t = 0; AXUIElementGetPid(search, &p); return p }()
        ax.namesFailures[token] = 1
        XCTAssertFalse(core.isWebSelect(search), "one failed read: retried, and the names say it is editable")
        ax.namesFailures[token] = 5
        XCTAssertFalse(core.isWebSelect(search), "still unknown: the text attributes say it takes text")
        XCTAssertEqual(ax.namesFailures[token], 3, "read twice, no more")
    }

    /// A long app name is capped in a picture's label, so the after-act tail and its pointer survive the daemon's cap.
    func testALongAppNameKeepsThePictureLabelsTail() {
        let long = String(repeating: "Very Long Browser Name ", count: 12)
        let app = CUCore.labelAppName(long)
        XCTAssertLessThanOrEqual(app.count, 60)
        let label = CUCore.freshnessLabel(app: app, where_: "on another desktop (another Space or full screen)",
                                          check: "to see what is really there, read it (state() or find() text, or something the app counts, such as a word count)",
                                          previous: (7, 1000, 1000), digest: 7, now: 2500, actedMs: 2000, appActivityMs: 2100)
        let full = CUCore.afterActFreshness(label, app: app, previous: (7, 1000, 1000), digest: 7, now: 2500, actedMs: 2000)
        XCTAssertTrue(full.hasSuffix("screenshot({ live: true, reason }) takes one where the window is (the user is asked first)"), full)
        XCTAssertLessThan(full.count, 800, "inside the daemon's SCREENSHOT_DETAIL_CAP")
        XCTAssertEqual(CUCore.labelAppName("Google Chrome"), "Google Chrome")
    }

    /// The measured trace (2026-10-14): `key("tab", { into: Title })` in a background Chrome — the app's focus on Title,
    /// then on Subtitle ~120 ms after the key (the page fired no focus event: its window was not key). The focus moved:
    /// no "did not move" note.
    func testATabIntoAFieldWhoseFocusMovesAMomentLaterGetsNoNote() async throws {
        world()
        let title = fakeElement(98_093), subtitle = fakeElement(98_094)
        ax.put(form, [kAXChildrenAttribute: ax.elements(form, kAXChildrenAttribute) + [title, subtitle]])
        ax.add(title, role: kAXTextFieldRole, title: "Title", frame: CGRect(x: 60, y: 460, width: 300, height: 24),
               extra: [kAXParentAttribute: form, kAXValueAttribute: "Hello Material probe", kAXFocusedAttribute: true, "AXEditableAncestor": title])
        ax.add(subtitle, role: kAXTextFieldRole, title: "Subtitle", frame: CGRect(x: 60, y: 500, width: 300, height: 24),
               extra: [kAXParentAttribute: form, kAXValueAttribute: "", "AXEditableAncestor": subtitle])
        ax.focus(pid: pid, on: title)
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(120)) { [unowned self] in
                ax.put(title, [kAXFocusedAttribute: false])
                ax.put(subtitle, [kAXFocusedAttribute: true])
                ax.focus(pid: pid, on: subtitle)
            }
        }
        let r = try await act(.key(CUKeyAction(combo: "tab", into: ref(title))))
        XCTAssertFalse(r.detail?.contains("did not move") ?? false, r.detail ?? "")
    }

    /// A key with `{ into }` is watched like one with the focus already there: Tab that left it where it was says so.
    func testATabIntoAFieldThatLeftTheFocusWhereItWasSaysSo() async throws {
        world()
        let title = fakeElement(98_092)
        ax.put(form, [kAXChildrenAttribute: ax.elements(form, kAXChildrenAttribute) + [title]])
        ax.add(title, role: kAXTextFieldRole, title: "Title", frame: CGRect(x: 60, y: 460, width: 300, height: 24),
               extra: [kAXParentAttribute: form, kAXValueAttribute: "Hello", kAXFocusedAttribute: true])
        ax.focus(pid: pid, on: title)
        let r = try await act(.key(CUKeyAction(combo: "tab", into: ref(title))))
        XCTAssertTrue(r.detail?.contains("the keyboard focus did not move after tab (the page may not have taken the key) — click the field you mean") ?? false, r.detail ?? "")
        XCTAssertFalse(r.detail?.contains("or pass { into }") ?? true, "into was passed: not offered again")
        // …and one that moved it says nothing of the kind.
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            ax.put(title, [kAXFocusedAttribute: false])
            ax.put(radios[0], [kAXFocusedAttribute: true])
            ax.focus(pid: pid, on: radios[0])
        }
        let moved = try await act(.key(CUKeyAction(combo: "tab", into: ref(title))))
        XCTAssertFalse(moved.detail?.contains("did not move") ?? false, moved.detail ?? "")
    }

    /// Chrome answers AXManualAccessibility as unsupported: a Chromium BROWSER whose page did not appear gets
    /// AXEnhancedUserInterface; an Electron or CEF app never does, and a page that appears stops it.
    func testChromiumAccessibilityFallsBackToEnhancedUserInterfaceForABrowserOnly() {
        var set: [String] = []
        let r = CUChromium.enableAccessibility(browser: true, enhancedBefore: { false }, set: { set.append($0) }, pageReady: { false }, pause: { _ in })
        XCTAssertEqual(r.set, ["AXManualAccessibility", "AXEnhancedUserInterface"])
        XCTAssertTrue(r.ours, "read off just before: Winter's")
        XCTAssertEqual(set, ["AXManualAccessibility", "AXEnhancedUserInterface"])
        set = []
        XCTAssertEqual(CUChromium.enableAccessibility(browser: false, set: { set.append($0) }, pageReady: { false }, pause: { _ in }).set, ["AXManualAccessibility"])
        XCTAssertEqual(set, ["AXManualAccessibility"], "Electron: never the VoiceOver switch")
        set = []
        var polls = 0
        XCTAssertEqual(CUChromium.enableAccessibility(browser: true, set: { set.append($0) }, pageReady: { polls += 1; return polls >= 3 }, pause: { _ in }).set, ["AXManualAccessibility"])
        XCTAssertEqual(set, ["AXManualAccessibility"], "a page that appeared: nothing more")
        // Unanswered before: set (the page needs it), never Winter's to turn off.
        let unknown = CUChromium.enableAccessibility(browser: true, enhancedBefore: { nil }, set: { _ in }, pageReady: { false }, pause: { _ in })
        XCTAssertEqual(unknown.set.last, "AXEnhancedUserInterface")
        XCTAssertFalse(unknown.ours)
    }

    /// One "browser" for Floor F and the accessibility switch: a known bundle, or a Chromium app that declares the web.
    func testABrowserIsAKnownBundleOrAChromiumAppThatDeclaresTheWeb() {
        XCTAssertTrue(CUChromium.isBrowser(bundleId: "com.google.chrome.for.testing", chromium: true, declaresWeb: { false }))
        XCTAssertTrue(CUChromium.isBrowser(bundleId: "com.operasoftware.OperaGX", chromium: true, declaresWeb: { true }), "Opera GX, Brave Beta, Comet…")
        XCTAssertFalse(CUChromium.isBrowser(bundleId: "com.tinyspeck.slackmacgap", chromium: true, declaresWeb: { false }), "an Electron app")
        XCTAssertFalse(CUChromium.isBrowser(bundleId: "com.apple.Safari", chromium: false, declaresWeb: { true }), "WebKit")
    }

    // MARK: a key into an open panel

    func testAKeyIntoAPanelThatOpenedNothingSaysSo() async throws {
        world()
        let sheet = fakeElement(98_030), files = fakeElement(98_031)
        ax.put(window, [kAXChildrenAttribute: [web, sheet]])
        ax.add(sheet, role: kAXSheetRole, frame: CGRect(x: 100, y: 40, width: 600, height: 400),
               extra: [kAXParentAttribute: window, kAXChildrenAttribute: [files] + filePanelShape(98_035, in: sheet)])
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
            ax.put(sheet, [kAXChildrenAttribute: ax.elements(sheet, kAXChildrenAttribute) + [goTo]])
        }
        let again = try await act(.key(CUKeyAction(combo: "/", into: ref(files))))
        XCTAssertFalse(again.detail?.contains("nothing new appeared") ?? false, again.detail ?? "")
    }

    /// The open panel (2026-10-14): Chrome's Open panel up, its file list focused, `key("cmd+shift+g")` with no `into`
    /// said only "pressed" while no Go to folder sheet opened.
    /// What every file panel has besides its files: a sidebar outline, the folder's pop-up and a search field.
    private func filePanelShape(_ base: Int32, in sheet: AXUIElement) -> [AXUIElement] {
        let sidebar = fakeElement(base), whereTo = fakeElement(base + 1), search = fakeElement(base + 2)
        ax.add(sidebar, role: kAXOutlineRole, title: "sidebar", frame: CGRect(x: 100, y: 80, width: 20, height: 300), extra: [kAXParentAttribute: sheet])
        ax.add(whereTo, role: kAXPopUpButtonRole, title: "Where:", frame: CGRect(x: 300, y: 50, width: 120, height: 20),
               extra: [kAXParentAttribute: sheet, kAXValueAttribute: "images"])
        ax.add(search, role: kAXTextFieldRole, subrole: "AXSearchField", frame: CGRect(x: 500, y: 50, width: 120, height: 20), extra: [kAXParentAttribute: sheet])
        return [sidebar, whereTo, search]
    }

    /// The open panel (2026-10-14): Chrome's Open panel up, its file list focused, `key("cmd+shift+g")` with no `into`
    /// said only "pressed" while no Go to folder sheet opened. With an Open (default) and a Cancel button.
    private func openPanel() -> (sheet: AXUIElement, files: AXUIElement) {
        let sheet = fakeElement(98_090), files = fakeElement(98_091), open = fakeElement(98_093), cancel = fakeElement(98_094)
        ax.put(window, [kAXChildrenAttribute: [web, sheet]])
        ax.add(sheet, role: kAXSheetRole, title: "open", frame: CGRect(x: 100, y: 40, width: 600, height: 400), extra: [kAXParentAttribute: window])
        ax.put(sheet, [kAXChildrenAttribute: [files, open, cancel] + filePanelShape(98_095, in: sheet),
                       kAXDefaultButtonAttribute: open, kAXCancelButtonAttribute: cancel])
        ax.add(files, role: kAXListRole, title: "icon view", frame: CGRect(x: 120, y: 80, width: 560, height: 300),
               extra: [kAXParentAttribute: sheet, kAXFocusedAttribute: true])
        ax.add(open, role: kAXButtonRole, title: "Open", frame: CGRect(x: 600, y: 410, width: 60, height: 24), extra: [kAXParentAttribute: sheet])
        ax.setActions(open, [kAXPressAction])
        ax.add(cancel, role: kAXButtonRole, title: "Cancel", frame: CGRect(x: 520, y: 410, width: 60, height: 24), extra: [kAXParentAttribute: sheet])
        ax.setActions(cancel, [kAXPressAction])
        ax.focus(pid: pid, on: files)
        return (sheet, files)
    }

    func testAShortcutWithThePanelFocusedThatOpenedNothingSaysSo() async throws {
        world()
        let (sheet, _) = openPanel()
        let r = try await act(.key(CUKeyAction(combo: "cmd+shift+g")))
        let d = r.detail ?? ""
        XCTAssertTrue(d.contains("nothing new appeared in the panel after cmd+shift+g (no sheet or window opened, its focus did not move)"), d)
        XCTAssertTrue(d.contains(CUCore.panelShortcutWords("Browser")), d)
        XCTAssertTrue(poster.entries.contains { $0.type == .keyDown }, "the key was sent")
        // A Go to folder sheet that opened is a change: nothing said.
        let goTo = fakeElement(98_092)
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            ax.add(goTo, role: kAXSheetRole, frame: CGRect(x: 150, y: 60, width: 400, height: 120), extra: [kAXParentAttribute: sheet])
            ax.put(sheet, [kAXChildrenAttribute: [ax.elements(sheet, kAXChildrenAttribute).first!, goTo]])
        }
        let again = try await act(.key(CUKeyAction(combo: "cmd+shift+g")))
        XCTAssertFalse(again.detail?.contains("nothing new appeared") ?? false, again.detail ?? "")
    }

    func testAPlainKeyWithThePanelFocusedThatChangedNothingGetsNoShortcutWords() async throws {
        world()
        _ = openPanel()
        let r = try await act(.key(CUKeyAction(combo: "/")))
        let d = r.detail ?? ""
        XCTAssertTrue(d.contains("nothing new appeared in the panel after /"), d)
        XCTAssertFalse(d.contains("a shortcut with ⌘"), d)
    }

    func testAKeyOutsideAnyPanelIsNotWatchedAsOne() async throws {
        world()
        ax.focus(pid: pid, on: select)
        let r = try await act(.key(CUKeyAction(combo: "cmd+shift+g")))
        XCTAssertFalse(r.detail?.contains("nothing new appeared in the panel") ?? false, r.detail ?? "")
    }

    func testShortcutChords() throws {
        XCTAssertTrue(CUCore.isShortcutChord(try CUKeyChord.parse("cmd+shift+g")))
        XCTAssertTrue(CUCore.isShortcutChord(try CUKeyChord.parse("ctrl+a")))
        XCTAssertTrue(CUCore.isShortcutChord(try CUKeyChord.parse("alt+left")))
        XCTAssertFalse(CUCore.isShortcutChord(try CUKeyChord.parse("shift+tab")))
        XCTAssertFalse(CUCore.isShortcutChord(try CUKeyChord.parse("/")))
    }

    /// The open panel: "/" typed into the panel's file list was answered "Google Chrome doesn't expose this editor's
    /// text" — it is a list, not an editor.
    func testTypingIntoAListIsNotCalledAnEditorThatHidesItsText() async throws {
        world()
        let (_, files) = openPanel()
        let r = try await act(.type(CUTypeAction(text: "/", into: ref(files))))
        let d = r.detail ?? ""
        XCTAssertFalse(d.contains("editor's text"), d)
        XCTAssertTrue(d.contains("received: unverifiable — [\(ref(files))] list \"icon view\" is not a text field, so the character went to it as keys and nothing can be read back (in a panel they may be its own keys: a file Open or Save panel opens Go to folder on \"/\" or \"~\")"), d)
    }

    // MARK: keys into a sheet the Open/Save panel service draws

    private func keyDownPids(since n: Int = 0) -> Set<pid_t> { Set(poster.entries.dropFirst(n).filter { $0.type == .keyDown }.map(\.pid)) }

    /// The file list's own process (its token in the fakes) is a running panel service instance: accessibility names the
    /// remote view's owner.
    private func serviceDrawn(_ files: AXUIElement, responsible: pid_t?) -> pid_t {
        var owner: pid_t = 0
        AXUIElementGetPid(files, &owner)
        sys.panelServices = [CUPanelService(pid: owner, responsible: responsible, age: 3)]
        return owner
    }

    func testKeysTypingAndPasteIntoAServiceDrawnSheetGoToThatService() async throws {
        world()
        let (_, files) = openPanel()
        let service = serviceDrawn(files, responsible: pid)
        try await act(.key(CUKeyAction(combo: "cmd+shift+g")))
        XCTAssertEqual(keyDownPids(), [service], "the chord goes to the panel's own process")
        XCTAssertEqual(poster.entries.first { $0.type == .keyDown }?.flags.contains(.maskCommand), true, "with its flags")
        var n = poster.entries.count
        try await act(.type(CUTypeAction(text: "/tmp/a.zip", into: ref(files))))
        XCTAssertEqual(keyDownPids(since: n), [service], "typing too")
        n = poster.entries.count
        _ = try? await act(.paste(CUPasteAction(text: "/tmp/b.zip", into: ref(files))))
        XCTAssertEqual(keyDownPids(since: n), [service], "a paste's cmd+v too (LOW-3)")
    }

    /// MED-1: an IN-PROCESS sheet (an alert the app draws itself) keeps its keys in the app, though a panel service runs
    /// for another of its windows; and an instance serving another app is never used.
    func testAnInProcessSheetKeepsTheAppsPidWhateverServiceRuns() async throws {
        world()
        let alert = fakeElement(98_120), field = fakeElement(98_121)
        ax.put(window, [kAXChildrenAttribute: [web, alert]])
        ax.add(alert, role: kAXSheetRole, frame: CGRect(x: 100, y: 40, width: 400, height: 200), extra: [kAXParentAttribute: window, kAXChildrenAttribute: [field]])
        ax.add(field, role: kAXTextFieldRole, frame: CGRect(x: 120, y: 80, width: 300, height: 24), extra: [kAXParentAttribute: alert, kAXValueAttribute: "", kAXFocusedAttribute: true])
        ax.focus(pid: pid, on: field)
        sys.panelServices = [CUPanelService(pid: 93_606, responsible: pid, age: 3)]  // the second window's Open panel
        try await act(.key(CUKeyAction(combo: "cmd+shift+g")))
        XCTAssertEqual(keyDownPids(), [pid])
        let n = poster.entries.count
        let (_, files) = openPanel()
        _ = serviceDrawn(files, responsible: 777)
        try await act(.key(CUKeyAction(combo: "cmd+shift+g")))
        XCTAssertEqual(keyDownPids(since: n), [pid], "another app's panel service: never")
    }

    func testKeysOutsideASheetNeverGoToAPanelService() async throws {
        world()
        sys.panelServices = [CUPanelService(pid: 93_606, responsible: pid, age: 3)]
        ax.focus(pid: pid, on: hiddenInput)
        try await act(.type(CUTypeAction(text: "ab", into: ref(hiddenInput))))
        XCTAssertFalse(keyDownPids().contains(93_606), "\(keyDownPids())")
    }

    func testWhichPanelServiceDrawsTheSheet() {
        let host: pid_t = 100
        let mine = CUPanelService(pid: 1, responsible: host, age: 50), other = CUPanelService(pid: 3, responsible: 200, age: 1)
        let unknown = CUPanelService(pid: 4, responsible: nil, age: 1)
        XCTAssertEqual(CUCore.choosePanelService([mine, other], hostPid: host, elementPids: [77, 1]), 1, "an instance accessibility names")
        XCTAssertEqual(CUCore.choosePanelService([unknown], hostPid: host, elementPids: [4]), 4, "responsibility unreadable, named")
        XCTAssertNil(CUCore.choosePanelService([mine], hostPid: host, elementPids: [host]), "the app's own element: an in-process sheet")
        XCTAssertNil(CUCore.choosePanelService([mine, unknown], hostPid: host, elementPids: []), "never by elimination")
        XCTAssertNil(CUCore.choosePanelService([other], hostPid: host, elementPids: [3]), "never another app's")
    }

    // MARK: the file panel's floors (MED-2)

    private func goToField(_ sheet: AXUIElement, value: String = "") -> AXUIElement {
        let f = fakeElement(98_130)
        ax.add(f, role: kAXTextFieldRole, frame: CGRect(x: 150, y: 60, width: 300, height: 24), extra: [kAXParentAttribute: sheet, kAXValueAttribute: value])
        ax.put(sheet, [kAXChildrenAttribute: ax.elements(sheet, kAXChildrenAttribute) + [f]])
        return f
    }

    private func refusal(_ a: CUAction) async -> String? {
        do { try await act(a); return nil } catch let e as CUError { return e.code == "refused" ? e.message : "\(e.code): \(e.message)" } catch { return "\(error)" }
    }

    func testAProtectedPathTypedIntoAnyPanelSheetIsRefusedBeforeSending() async throws {
        world()
        let (_, files) = openPanel()
        let said = await refusal(.type(CUTypeAction(text: "~/.ssh/id_ed25519", into: ref(files))))
        XCTAssertTrue(said?.contains("the text names a protected location") ?? false, said ?? "typed")
        XCTAssertTrue(poster.entries.filter { $0.type == .keyDown }.isEmpty, "nothing was typed")
    }

    func testSetValueOfAnOpenPanelsGoToFieldToAProtectedPathIsRefused() async throws {
        world()
        let (sheet, _) = openPanel()
        let field = goToField(sheet)
        ax.makeSettable(field, kAXValueAttribute)
        let said = await refusal(.setValue(CUSetValueAction(ref: ref(field), value: "~/.ssh/id_ed25519")))
        XCTAssertTrue(said?.contains("the text names a protected location") ?? false, said ?? "set")
        XCTAssertFalse(ax.written.contains { $0.hasSuffix(":AXValue") }, "nothing written")
        let aws = await refusal(.setValue(CUSetValueAction(ref: ref(field), value: NSHomeDirectory() + "/.aws/credentials")))
        XCTAssertNotNil(aws, "a hidden folder of the home too")
    }

    func testAPathAssembledOverSeveralCallsIsRefusedBeforeTheLastPartIsSent() async throws {
        world()
        let (sheet, _) = openPanel()
        let field = goToField(sheet, value: "~/Library/Key")
        ax.makeSettable(field, kAXValueAttribute)
        ax.focus(pid: pid, on: field)
        ax.put(field, [kAXFocusedAttribute: true])
        let said = await refusal(.type(CUTypeAction(text: "chains/login.keychain-db", into: ref(field))))
        XCTAssertTrue(said?.contains("the text names a protected location") ?? false, said ?? "typed")
        XCTAssertTrue(poster.entries.filter { $0.type == .keyDown }.isEmpty, "nothing was sent")
    }

    /// What the field holds AFTER the keys (an app that completes a path itself) is judged too: cleared and refused.
    func testAFieldThatEndsUpNamingAProtectedPathIsClearedAndRefused() async throws {
        world()
        let (sheet, _) = openPanel()
        let field = goToField(sheet, value: "")
        ax.makeSettable(field, kAXValueAttribute)
        ax.focus(pid: pid, on: field)
        ax.put(field, [kAXFocusedAttribute: true])
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            ax.put(field, [kAXValueAttribute: "~/.ssh/id_ed25519"])  // completed by the app
        }
        let said = await refusal(.type(CUTypeAction(text: "x", into: ref(field))))
        XCTAssertTrue(said?.contains("panel field now names a protected location") ?? false, said ?? "typed")
        XCTAssertTrue(said?.contains("it was cleared") ?? false, said ?? "")
        XCTAssertEqual(ax.string(field, kAXValueAttribute), "")
    }

    private func selectItem(in files: AXUIElement, url: String) -> AXUIElement {
        let item = fakeElement(98_140)
        ax.add(item, role: kAXImageRole, title: "item", frame: CGRect(x: 130, y: 90, width: 60, height: 60),
               extra: [kAXParentAttribute: files, kAXURLAttribute: URL(string: url)! as CFURL])
        ax.setActions(item, ["AXOpen"])
        ax.put(files, [kAXChildrenAttribute: [item], kAXSelectedChildrenAttribute: [item]])
        return item
    }

    func testPressingOpenWithAProtectedFileSelectedIsRefusedBeforeThePress() async throws {
        world()
        let (sheet, files) = openPanel()
        let item = selectItem(in: files, url: "file:///Users/someone/.ssh/id_ed25519")
        let open = ax.element(sheet, kAXDefaultButtonAttribute)!
        let viaClick = await refusal(.click(CUClickAction(ref: ref(open))))
        XCTAssertTrue(viaClick?.contains("panel would choose a protected location") ?? false, viaClick ?? "pressed")
        XCTAssertFalse(ax.performed.contains { $0.hasSuffix(":AXPress") }, "Open was not pressed")
        let viaReturn = await refusal(.key(CUKeyAction(combo: "return")))
        XCTAssertNotNil(viaReturn, "Return chooses too")
        let viaDouble = await refusal(.click(CUClickAction(ref: ref(item), count: 2)))
        XCTAssertNotNil(viaDouble, "a double-click on the item too")
        let viaOpen = await refusal(.action(CUAXAction(ref: ref(item), name: "AXOpen")))
        XCTAssertNotNil(viaOpen, "Open on the item too")
        // Cancel is never held up; a harmless file is chosen as before.
        let cancel = ax.element(sheet, kAXCancelButtonAttribute)!
        _ = await refusal(.click(CUClickAction(ref: ref(cancel))))
        XCTAssertTrue(ax.performed.contains("\(token(cancel)):AXPress"))
        ax.put(item, [kAXURLAttribute: URL(string: "file:///Users/someone/Downloads/pkg.zip")! as CFURL])
        _ = await refusal(.click(CUClickAction(ref: ref(open))))
        XCTAssertTrue(ax.performed.contains("\(token(open)):AXPress"))
    }

    func testWithNothingSelectedReadableTheFieldsValueDecides() async throws {
        world()
        let (sheet, _) = openPanel()
        _ = goToField(sheet, value: NSHomeDirectory() + "/.aws/credentials")
        let open = ax.element(sheet, kAXDefaultButtonAttribute)!
        let said = await refusal(.click(CUClickAction(ref: ref(open))))
        XCTAssertTrue(said?.contains("panel would choose a protected location") ?? false, said ?? "pressed")
    }

    // MARK: the re-review's bypasses

    /// HIGH: a path split over calls (~/Library/Key, then chains/login.keychain-db + Return) — the path assembled over calls is judged BEFORE anything is
    /// sent, with the field's value and with what was typed into the panel; in a Go to field accessibility shows, and in
    /// one it doesn't (the keys into the file list).
    func testAPathFinishedWithAReturnIsJudgedWholeBeforeSending() async throws {
        world()
        let (sheet, files) = openPanel()
        let field = goToField(sheet)
        ax.focus(pid: pid, on: field)
        ax.put(field, [kAXFocusedAttribute: true])
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown, !e.unicode.isEmpty, e.unicode != "\r", e.unicode != "\n" else { return }
            ax.put(field, [kAXValueAttribute: (ax.string(field, kAXValueAttribute) ?? "") + e.unicode])
        }
        _ = try await act(.type(CUTypeAction(text: "~/Library/Key", into: ref(field))))
        let n = poster.entries.count
        let said = await refusal(.type(CUTypeAction(text: "chains/login.keychain-db\n", into: ref(field))))
        XCTAssertTrue(said?.contains("the text names a protected location") ?? false, said ?? "typed")
        XCTAssertEqual(poster.entries.count, n, "nothing was sent")
        // The same through the file list, the Go to field unseen: what was typed into the panel decides.
        world()
        let (_, list) = openPanel()
        _ = try await act(.type(CUTypeAction(text: "~/Library/Key", into: ref(list))))
        let m = poster.entries.count
        let unseen = await refusal(.type(CUTypeAction(text: "chains/login.keychain-db\r", into: ref(list))))
        XCTAssertNotNil(unseen, "refused")
        XCTAssertEqual(poster.entries.count, m, "nothing was sent")
        let keyed = await refusal(.key(CUKeyAction(combo: "h", into: ref(list))))
        XCTAssertNil(keyed, "one harmless character")
        _ = files
    }

    func testCmdDownAndCmdOChooseLikeReturn() async throws {
        world()
        let (_, files) = openPanel()
        _ = selectItem(in: files, url: "file:///Users/someone/.ssh/id_ed25519")
        for combo in ["cmd+down", "cmd+o", "enter"] {
            let said = await refusal(.key(CUKeyAction(combo: combo)))
            XCTAssertTrue(said?.contains("panel would choose a protected location") ?? false, "\(combo): \(said ?? "pressed")")
        }
    }

    /// LOW: nothing readable to judge after text went into the panel — the choice fails closed; with nothing typed (the
    /// user's own navigation), it goes ahead.
    func testAChoiceThatCantBeReadAfterTypingFailsClosed() async throws {
        world()
        let (sheet, files) = openPanel()
        let open = ax.element(sheet, kAXDefaultButtonAttribute)!
        _ = await refusal(.click(CUClickAction(ref: ref(open))))
        XCTAssertTrue(ax.performed.contains("\(token(open)):AXPress"), "nothing typed: pressed")
        world()
        let (sheet2, files2) = openPanel()
        _ = try await act(.type(CUTypeAction(text: "pkg.zip", into: ref(files2))))
        let said = await refusal(.click(CUClickAction(ref: ref(ax.element(sheet2, kAXDefaultButtonAttribute)!))))
        XCTAssertTrue(said?.contains("can't be read after Winter typed or clicked in it") ?? false, said ?? "pressed")
        XCTAssertTrue(said?.contains("the user can pick the file themselves") ?? false)
        _ = (files, sheet)
    }

    func testADragOfAProtectedFileIsRefused() async throws {
        world()
        let (_, files) = openPanel()
        let item = selectItem(in: files, url: "file:///Users/someone/.ssh/id_ed25519")
        let said = await refusal(.drag(CUDragAction(from: CUDragEnd(ref: ref(item)), to: CUDragEnd(ref: ref(fileButton)))))
        XCTAssertTrue(said?.contains("the drag's source is a protected location") ?? false, said ?? "dragged")
        XCTAssertFalse(poster.entries.contains { $0.type == .leftMouseDown }, "nothing moved")
        ax.put(item, [kAXURLAttribute: URL(string: "file:///Users/someone/Downloads/pkg.zip")! as CFURL])
        let harmless = await refusal(.drag(CUDragAction(from: CUDragEnd(ref: ref(item)), to: CUDragEnd(ref: ref(fileButton)))))
        XCTAssertFalse(harmless?.contains("the drag's source") ?? false, harmless ?? "")
    }

    func testCanonicalFormsCantGetAroundTheFloor() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("winter-canon-\(UUID().uuidString)")
        let home = root.appendingPathComponent("u")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".aws"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("work"), withIntermediateDirectories: true)
        try "k".write(to: home.appendingPathComponent(".aws/credentials"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: home.appendingPathComponent("work/creds"), withDestinationURL: home.appendingPathComponent(".aws"))
        defer { try? FileManager.default.removeItem(at: root) }
        let h = home.path
        XCTAssertTrue(CUFloors.isProtectedPanelPath(h + "/work/creds/credentials", home: h), "a symlink into a hidden folder")
        XCTAssertTrue(CUFloors.isProtectedPanelPath(h.uppercased() + "/.AWS/CREDENTIALS", home: h), "another case")
        XCTAssertTrue(CUFloors.isProtectedPanelPath("/System/Volumes/Data" + h + "/.aws/credentials", home: h), "the Data volume's firmlink")
        XCTAssertTrue(CUFloors.isProtectedPanelPath("../.aws/credentials", home: h), "a relative climb, no folder known")
        XCTAssertTrue(CUFloors.isProtectedPanelPath("../.aws/credentials", home: h, base: h + "/Downloads"), "resolved against the panel's folder")
        XCTAssertTrue(CUFloors.isProtectedPanelPath(h + "/Downloads/../.aws/x", home: h), ". and .. resolved")
        XCTAssertFalse(CUFloors.isProtectedPanelPath("../Downloads/pkg.zip", home: h, base: h + "/Downloads"))
        XCTAssertFalse(CUFloors.isProtectedPanelPath(h + "/Downloads/pkg.zip", home: h))
        XCTAssertTrue(CUFloors.isProtectedPanelPath("/USERS/someone/.SSH/ID_RSA", home: "/Users/u"), "the save list, any case")
    }

    // MARK: the third security pass

    func testCmdVOfAProtectedClipboardIntoAPanelIsJudgedBeforeSending() async throws {
        world()
        let (_, files) = openPanel()
        clip.items = [[NSPasteboard.PasteboardType.string.rawValue: Data((NSHomeDirectory() + "/.aws/credentials").utf8)]]
        let said = await refusal(.key(CUKeyAction(combo: "cmd+v")))
        XCTAssertTrue(said?.contains("the text names a protected location") ?? false, said ?? "pasted")
        XCTAssertTrue(poster.entries.filter { $0.type == .keyDown }.isEmpty, "nothing sent")
        // A harmless start is recorded: what is typed after it is judged with it.
        clip.items = [[NSPasteboard.PasteboardType.string.rawValue: Data("~/Library/Key".utf8)]]
        _ = await refusal(.key(CUKeyAction(combo: "cmd+v")))
        let rest = await refusal(.type(CUTypeAction(text: "chains/login.keychain-db", into: ref(files))))
        XCTAssertTrue(rest?.contains("the text names a protected location") ?? false, rest ?? "typed")
        // A copied file.
        world()
        _ = openPanel()
        clip.fileURLs = ["file:///Users/someone/.ssh/id_ed25519"]
        let file = await refusal(.key(CUKeyAction(combo: "cmd+v")))
        XCTAssertTrue(file?.contains("the clipboard holds a protected location") ?? false, file ?? "pasted")
    }

    /// The agent shows hidden files (⌘⇧.) and opens a disclosure triangle, then selects an item with no URL under ".ssh":
    /// its path from its disclosing rows decides; and with nothing readable after the agent's acts, the choice fails closed.
    private func outlinePanel(parent: String?, child: String?) -> (sheet: AXUIElement, triangle: AXUIElement, open: AXUIElement) {
        let (sheet, files) = openPanel()
        let outline = fakeElement(98_160), parentRow = fakeElement(98_161), childRow = fakeElement(98_162), cell = fakeElement(98_163), triangle = fakeElement(98_164)
        ax.add(outline, role: kAXOutlineRole, title: "list view", frame: CGRect(x: 120, y: 80, width: 560, height: 300),
               extra: [kAXParentAttribute: sheet, kAXChildrenAttribute: [parentRow, childRow], kAXSelectedRowsAttribute: [childRow]])
        ax.add(parentRow, role: kAXRowRole, title: parent, frame: CGRect(x: 120, y: 80, width: 560, height: 20), extra: [kAXParentAttribute: outline, kAXChildrenAttribute: [triangle]])
        ax.add(triangle, role: kAXDisclosureTriangleRole, frame: CGRect(x: 122, y: 82, width: 12, height: 12), extra: [kAXParentAttribute: parentRow])
        ax.setActions(triangle, [kAXPressAction])
        ax.add(childRow, role: kAXRowRole, frame: CGRect(x: 120, y: 100, width: 560, height: 20),
               extra: [kAXParentAttribute: outline, kAXChildrenAttribute: [cell], kAXDisclosedByRowAttribute: parentRow])
        ax.add(cell, role: kAXCellRole, title: child, frame: CGRect(x: 140, y: 100, width: 300, height: 20), extra: [kAXParentAttribute: childRow])
        ax.put(sheet, [kAXChildrenAttribute: ax.elements(sheet, kAXChildrenAttribute).filter { !CFEqual($0, files) } + [outline]])
        ax.focus(pid: pid, on: outline)
        return (sheet, triangle, ax.element(sheet, kAXDefaultButtonAttribute)!)
    }

    func testHiddenFilesAndADisclosureTriangleThenOpenIsJudgedByTheRowsPath() async throws {
        world()
        let (_, triangle, open) = outlinePanel(parent: ".ssh", child: "id_ed25519")
        _ = await refusal(.key(CUKeyAction(combo: "cmd+shift+.")))
        _ = await refusal(.click(CUClickAction(ref: ref(triangle))))
        let said = await refusal(.click(CUClickAction(ref: ref(open))))
        XCTAssertTrue(said?.contains("panel would choose a protected location") ?? false, said ?? "pressed")
        XCTAssertTrue(said?.contains(".ssh/id_ed25519") ?? false, said ?? "")
    }

    func testAfterTheAgentsClicksAChoiceThatCantBeReadFailsClosed() async throws {
        world()
        let (_, triangle, open) = outlinePanel(parent: nil, child: nil)
        let theirs = await refusal(.click(CUClickAction(ref: ref(open))))
        XCTAssertNil(theirs, "the user's own navigation: unreadable passes")
        world()
        let (_, triangle2, open2) = outlinePanel(parent: nil, child: nil)
        _ = await refusal(.click(CUClickAction(ref: ref(triangle2))))
        let said = await refusal(.click(CUClickAction(ref: ref(open2))))
        XCTAssertTrue(said?.contains("the user can pick the file themselves") ?? false, said ?? "pressed")
        _ = (triangle, open)
    }

    func testAChoosingKeyWhoseFocusIsntShownInThePanelIsJudgedAsAChoice() async throws {
        world()
        let (_, files) = openPanel()
        _ = selectItem(in: files, url: "file:///Users/someone/.ssh/id_ed25519")
        ax.focus(pid: pid, on: select)  // the app reports a focus outside the sheet
        let said = await refusal(.key(CUKeyAction(combo: "return")))
        XCTAssertTrue(said?.contains("panel would choose a protected location") ?? false, said ?? "pressed")
    }

    func testADragByNameOrOfAFileItemWithNoPath() async throws {
        world()
        let (_, files) = openPanel()
        let item = selectItem(in: files, url: "file:///Users/someone/Downloads/pkg.zip")
        ax.drop(item, kAXURLAttribute)
        ax.put(item, [kAXTitleAttribute: ".ssh"])
        let byName = await refusal(.drag(CUDragAction(from: CUDragEnd(ref: ref(item)), to: CUDragEnd(ref: ref(fileButton)))))
        XCTAssertTrue(byName?.contains("the drag's source is a protected location") ?? false, byName ?? "dragged")
        ax.put(item, [kAXTitleAttribute: "pkg.zip"])
        let noPath = await refusal(.drag(CUDragAction(from: CUDragEnd(ref: ref(item)), to: CUDragEnd(ref: ref(fileButton)))))
        XCTAssertTrue(noPath?.contains("a file whose path can't be read") ?? false, noPath ?? "dragged")
    }

    /// The helper never stats or resolves anything in a place macOS guards with a privacy prompt.
    func testTheResolverNeverTouchesPrivacyGuardedPlaces() {
        let saved = CUFloors.resolveProbe
        var asked: [String] = []
        CUFloors.resolveProbe = { p in asked.append(p); return p.hasPrefix("/Users/u/work") ? nil : (p == "/Users/u" || p == "/Users" ? p : nil) }
        defer { CUFloors.resolveProbe = saved }
        let home = "/Users/u"
        for p in ["/Users/u/Downloads/link/creds", "/Users/u/Desktop/a/b", "/Users/u/Documents/x", "/Users/u/Library/Mobile Documents/com~apple~CloudDocs/x",
                  "/Users/u/Library/CloudStorage/Dropbox/x", "/Volumes/Backup/x", "/System/Volumes/Data/Users/u/Downloads/x", "/USERS/U/DOWNLOADS/x"] {
            _ = CUFloors.isProtectedPanelPath(p, home: home)
        }
        XCTAssertFalse(asked.isEmpty, "something outside them was resolved")
        let touched = asked.filter { CUFloors.noTouch($0, home: home) }
        XCTAssertEqual(touched, [], "\(asked)")
        // Judged lexically there: a protected name still counts.
        XCTAssertTrue(CUFloors.isProtectedPanelPath("/Users/u/Downloads/.ssh/id_rsa", home: home))
        XCTAssertTrue(CUFloors.isProtectedPanelPath("sub/.hidden/x", home: home, base: "/Users/u/Downloads"), "names-only with a folder known")
    }

    // MARK: the fourth pass: only REAL file panels

    /// An alert with a "Don't ask again" box and OK, a Print sheet, and Return with an unrelated sheet up: none is a file
    /// panel, so every act goes as on main — no floor, no fail-closed choice.
    private func alertSheet() -> (sheet: AXUIElement, box: AXUIElement, ok: AXUIElement) {
        let sheet = fakeElement(98_200), box = fakeElement(98_201), ok = fakeElement(98_202), label = fakeElement(98_203)
        ax.put(window, [kAXChildrenAttribute: [web, sheet]])
        ax.add(sheet, role: kAXSheetRole, frame: CGRect(x: 100, y: 40, width: 400, height: 200), extra: [kAXParentAttribute: window])
        ax.add(label, role: kAXStaticTextRole, frame: CGRect(x: 120, y: 60, width: 300, height: 20), extra: [kAXParentAttribute: sheet, kAXValueAttribute: "Keychains"])
        ax.add(box, role: kAXCheckBoxRole, title: "Don't ask again", frame: CGRect(x: 120, y: 100, width: 200, height: 20), extra: [kAXParentAttribute: sheet, kAXValueAttribute: 0])
        ax.setActions(box, [kAXPressAction])
        ax.add(ok, role: kAXButtonRole, title: "OK", frame: CGRect(x: 400, y: 200, width: 60, height: 24), extra: [kAXParentAttribute: sheet])
        ax.setActions(ok, [kAXPressAction])
        ax.put(sheet, [kAXChildrenAttribute: [label, box, ok], kAXDefaultButtonAttribute: ok])
        return (sheet, box, ok)
    }

    func testAnAlertsBoxAndOKActAsBefore() async throws {
        world()
        let (_, box, ok) = alertSheet()
        let r1 = await refusal(.click(CUClickAction(ref: ref(box))))
        XCTAssertNil(r1)
        let r2 = await refusal(.click(CUClickAction(ref: ref(ok))))
        XCTAssertNil(r2)
        XCTAssertTrue(ax.performed.contains("\(token(ok)):AXPress"), "OK pressed")
        XCTAssertNil(core.panelTyped[target.id], "nothing armed")
    }

    func testAPrintSheetActsAsBefore() async throws {
        world()
        let sheet = fakeElement(98_210), printer = fakeElement(98_211), presets = fakeElement(98_212), print = fakeElement(98_213)
        ax.put(window, [kAXChildrenAttribute: [web, sheet]])
        ax.add(sheet, role: kAXSheetRole, title: "Print", frame: CGRect(x: 100, y: 40, width: 500, height: 400), extra: [kAXParentAttribute: window])
        ax.add(printer, role: kAXPopUpButtonRole, title: "Printer", frame: CGRect(x: 200, y: 60, width: 200, height: 20), extra: [kAXParentAttribute: sheet, kAXValueAttribute: "Office"])
        ax.add(presets, role: kAXPopUpButtonRole, title: "Presets", frame: CGRect(x: 200, y: 90, width: 200, height: 20), extra: [kAXParentAttribute: sheet, kAXValueAttribute: ".Default"])
        ax.add(print, role: kAXButtonRole, title: "Print", frame: CGRect(x: 500, y: 400, width: 60, height: 24), extra: [kAXParentAttribute: sheet])
        ax.setActions(print, [kAXPressAction])
        ax.put(sheet, [kAXChildrenAttribute: [printer, presets, print], kAXDefaultButtonAttribute: print])
        let r3 = await refusal(.click(CUClickAction(ref: ref(print))))
        XCTAssertNil(r3)
        XCTAssertTrue(ax.performed.contains("\(token(print)):AXPress"))
    }

    func testReturnWithAnUnrelatedSheetUpGoesAsBefore() async throws {
        world()
        let (_, box, _) = alertSheet()
        ax.focus(pid: pid, on: box)
        let n = poster.entries.count
        let r4 = await refusal(.key(CUKeyAction(combo: "return")))
        XCTAssertNil(r4)
        XCTAssertTrue(poster.entries.dropFirst(n).contains { $0.type == .keyDown }, "Return was sent")
        ax.focus(pid: pid, on: select)  // the focus outside the sheet
        let r5 = await refusal(.key(CUKeyAction(combo: "return")))
        XCTAssertNil(r5, "no file panel open: no choice to judge")
    }

    /// A large folder: the selection, read from the browser itself, decides — the walk's cap never fails it closed.
    func testALargeFoldersSelectedFileIsAcceptedFromTheSelectionAlone() async throws {
        world()
        let (sheet, files) = openPanel()
        var rows: [AXUIElement] = []
        for i in 0..<200 {
            let row = fakeElement(99_000 + Int32(i) * 4)
            var kids: [AXUIElement] = []
            for k in 1...3 {
                let c = fakeElement(99_000 + Int32(i) * 4 + Int32(k))
                ax.add(c, role: kAXStaticTextRole, frame: CGRect(x: 130, y: 90, width: 10, height: 10), extra: [kAXParentAttribute: row, kAXValueAttribute: "f\(i)-\(k)"])
                kids.append(c)
            }
            ax.add(row, role: kAXRowRole, frame: CGRect(x: 120, y: 80 + CGFloat(i), width: 560, height: 1),
                   extra: [kAXParentAttribute: files, kAXChildrenAttribute: kids, kAXURLAttribute: URL(fileURLWithPath: "/Users/someone/Downloads/f\(i).zip") as CFURL])
            rows.append(row)
        }
        ax.put(files, [kAXChildrenAttribute: rows, kAXSelectedRowsAttribute: [rows[199]]])
        _ = await refusal(.click(CUClickAction(ref: ref(rows[3]))))  // the agent acted in the panel: fail-closed armed
        let open = ax.element(sheet, kAXDefaultButtonAttribute)!
        let r6 = await refusal(.click(CUClickAction(ref: ref(open))))
        XCTAssertNil(r6)
        XCTAssertTrue(ax.performed.contains("\(token(open)):AXPress"), "a normal file is chosen")
    }

    func testBareCookiesOrKeychainsIsNoProtectedName() {
        XCTAssertFalse(CUFloors.panelChoiceIsProtected("Cookies"))
        XCTAssertFalse(CUFloors.panelChoiceIsProtected("Keychains, 3 items"))
        XCTAssertFalse(CUFloors.isProtectedPanelPath("Cookies/recipe.txt"))
        XCTAssertTrue(CUFloors.isProtectedPanelPath("Library/Cookies/x"), "under Library it is")
    }

    func testEditPasteFromTheMenuJudgesTheClipboardLikeCmdV() async throws {
        world()
        _ = openPanel()
        clip.items = [[NSPasteboard.PasteboardType.string.rawValue: Data((NSHomeDirectory() + "/.aws/credentials").utf8)]]
        let said = await refusal(.menu(CUMenuAction(path: ["Edit", "Paste"])))
        XCTAssertTrue(said?.contains("the text names a protected location") ?? false, said ?? "pasted")
        let style = await refusal(.menu(CUMenuAction(path: ["Edit", "Paste and Match Style"])))
        XCTAssertNotNil(style)
    }

    // MARK: the fifth pass

    /// A real in-process Open panel can show none of a file panel's marks: the text floor still refuses a protected path.
    func testAPanelWithNoMarksStillRefusesATypedProtectedPath() async throws {
        world()
        let sheet = fakeElement(98_300), list = fakeElement(98_301)
        ax.put(window, [kAXChildrenAttribute: [web, sheet]])
        ax.add(sheet, role: kAXSheetRole, frame: CGRect(x: 100, y: 40, width: 600, height: 400), extra: [kAXParentAttribute: window, kAXChildrenAttribute: [list]])
        ax.add(list, role: kAXListRole, frame: CGRect(x: 120, y: 80, width: 560, height: 300), extra: [kAXParentAttribute: sheet, kAXFocusedAttribute: true])
        ax.focus(pid: pid, on: list)
        XCTAssertFalse(core.isFilePanel(sheet, list, target), "no marks")
        let said = await refusal(.type(CUTypeAction(text: "~/.ssh/id_ed25519\n", into: ref(list))))
        XCTAssertTrue(said?.contains("the text names a protected location") ?? false, said ?? "typed")
        XCTAssertTrue(poster.entries.filter { $0.type == .keyDown }.isEmpty, "nothing sent")
    }

    /// A Return typed into a Go to folder sheet NESTED on the panel is judged with the panel's context (what was typed
    /// into the panel before).
    func testANestedGoToSheetIsJudgedWithTheOuterPanel() async throws {
        world()
        let (sheet, files) = openPanel()
        let goTo = fakeElement(98_310), field = fakeElement(98_311)
        ax.add(goTo, role: kAXSheetRole, frame: CGRect(x: 150, y: 60, width: 400, height: 120), extra: [kAXParentAttribute: sheet, kAXChildrenAttribute: [field]])
        ax.add(field, role: kAXTextFieldRole, frame: CGRect(x: 160, y: 80, width: 300, height: 24), extra: [kAXParentAttribute: goTo, kAXValueAttribute: ""])
        ax.put(sheet, [kAXChildrenAttribute: ax.elements(sheet, kAXChildrenAttribute) + [goTo]])
        XCTAssertTrue(CFEqual(core.panelRoot(field, target)!, sheet), "the outermost sheet")
        _ = await refusal(.type(CUTypeAction(text: "~/Library/Key", into: ref(files))))
        ax.focus(pid: pid, on: field)
        ax.put(field, [kAXFocusedAttribute: true])
        let n = poster.entries.count
        let said = await refusal(.type(CUTypeAction(text: "chains/login.keychain-db\n", into: ref(field))))
        XCTAssertTrue(said?.contains("the text names a protected location") ?? false, said ?? "typed")
        XCTAssertEqual(poster.entries.count, n, "nothing sent")
    }

    func testTheFilePanelVerdictIsCachedForTheSheet() {
        world()
        let (sheet, files) = openPanel()
        XCTAssertTrue(core.isFilePanel(sheet, files, target))
        ax.put(sheet, [kAXChildrenAttribute: [files]])  // its marks gone from the tree: the verdict holds for the sheet's life
        XCTAssertTrue(core.isFilePanel(sheet, files, target))
        XCTAssertFalse(core.isFilePanelUncached(sheet, files, target))
    }

    // MARK: the sixth pass: outside recognised file panels

    /// A commit sheet (no file panel): ordinary text with dots is typed, and the field is never touched.
    private func commitSheet() -> (sheet: AXUIElement, field: AXUIElement) {
        let sheet = fakeElement(98_400), field = fakeElement(98_401)
        ax.put(window, [kAXChildrenAttribute: [web, sheet]])
        ax.add(sheet, role: kAXSheetRole, frame: CGRect(x: 100, y: 40, width: 500, height: 200), extra: [kAXParentAttribute: window, kAXChildrenAttribute: [field]])
        ax.add(field, role: kAXTextFieldRole, frame: CGRect(x: 120, y: 80, width: 400, height: 24),
               extra: [kAXParentAttribute: sheet, kAXValueAttribute: "", kAXFocusedAttribute: true])
        ax.makeSettable(field, kAXValueAttribute)
        ax.focus(pid: pid, on: field)
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown, !e.unicode.isEmpty else { return }
            ax.put(field, [kAXValueAttribute: (ax.string(field, kAXValueAttribute) ?? "") + e.unicode])
        }
        return (sheet, field)
    }

    func testOrdinaryTextWithDotsInADialogIsTypedAndNeverCleared() async throws {
        world()
        let (_, field) = commitSheet()
        var want = ""
        for text in ["Update .gitignore", " see .env.example", " wait...", " .NET 8"] {
            let said = await refusal(.type(CUTypeAction(text: text, into: ref(field))))
            XCTAssertNil(said, text)
            want += text
            XCTAssertEqual(ax.string(field, kAXValueAttribute), want, "untouched after \(text)")
        }
        XCTAssertFalse(ax.written.contains { $0.hasSuffix(":AXValue") }, "never cleared")
        // A real path or an exact secret name still counts — refused, and the field is still never cleared.
        let path = await refusal(.type(CUTypeAction(text: " ~/.ssh/id_ed25519", into: ref(field))))
        XCTAssertNotNil(path)
        let exact = await refusal(.type(CUTypeAction(text: " id_ed25519", into: ref(field))))
        XCTAssertNotNil(exact)
        XCTAssertEqual(ax.string(field, kAXValueAttribute), want)
    }

    func testAProtectedValueInADialogIsRefusedButNeverCleared() async throws {
        world()
        let (_, field) = commitSheet()
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            ax.put(field, [kAXValueAttribute: "~/.aws/credentials"])  // the app completed it
        }
        let said = await refusal(.type(CUTypeAction(text: "x", into: ref(field))))
        XCTAssertTrue(said?.contains("clear it before going on") ?? false, said ?? "typed")
        XCTAssertEqual(ax.string(field, kAXValueAttribute), "~/.aws/credentials", "not cleared outside a file panel")
        XCTAssertFalse(ax.written.contains { $0.hasSuffix(":AXValue") })
    }

    func testOutsidePanelText() {
        for ok in ["Update .gitignore", "see .env.example", "wait...", ".NET 8", "server.key", "notes credentials.txt"] {
            XCTAssertFalse(CUFloors.outsidePanelTextIsProtected(ok), ok)
        }
        for bad in ["~/.ssh/id_rsa", "copy /tmp/x.pem", ".aws", "Credentials", "src/certs/server.key", "file:///Users/u/.netrc"] {
            XCTAssertTrue(CUFloors.outsidePanelTextIsProtected(bad), bad)
        }
    }

    /// A real panel that fails the scope test, navigated by clicks into ".ssh" (no URLs): its selected item's and its
    /// folder pop-up's exact secret names refuse the choice; a Find panel's ".gitignore" goes ahead.
    private func unmarkedChooser(selected: String, folder: String, parent: String? = nil) -> AXUIElement {
        let sheet = fakeElement(98_420), list = fakeElement(98_421), row = fakeElement(98_422), popUp = fakeElement(98_423), parentRow = fakeElement(98_424)
        ax.put(window, [kAXChildrenAttribute: [web, sheet]])
        ax.add(sheet, role: kAXSheetRole, frame: CGRect(x: 100, y: 40, width: 600, height: 400), extra: [kAXParentAttribute: window, kAXChildrenAttribute: [popUp, list]])
        ax.add(popUp, role: kAXPopUpButtonRole, frame: CGRect(x: 300, y: 50, width: 120, height: 20), extra: [kAXParentAttribute: sheet, kAXValueAttribute: folder])
        var rowExtra: [String: Any] = [kAXParentAttribute: list]
        if let parent {
            ax.add(parentRow, role: kAXRowRole, title: parent, frame: CGRect(x: 120, y: 80, width: 560, height: 20), extra: [kAXParentAttribute: list])
            rowExtra[kAXDisclosedByRowAttribute] = parentRow
        }
        ax.add(row, role: kAXRowRole, title: selected, frame: CGRect(x: 120, y: 100, width: 560, height: 20), extra: rowExtra)
        ax.setActions(row, [kAXPressAction])
        ax.add(list, role: kAXListRole, frame: CGRect(x: 120, y: 80, width: 560, height: 300),
               extra: [kAXParentAttribute: sheet, kAXChildrenAttribute: parent == nil ? [row] : [parentRow, row], kAXSelectedRowsAttribute: [row], kAXFocusedAttribute: true])
        ax.focus(pid: pid, on: list)
        XCTAssertFalse(core.isFilePanel(sheet, list, target))
        return row
    }

    func testAClickOnlyNavigationIntoSSHInAnUnmarkedChooserIsRefused() async throws {
        world()
        let row = unmarkedChooser(selected: "id_ed25519", folder: ".ssh")
        _ = await refusal(.click(CUClickAction(ref: ref(row))))
        let said = await refusal(.key(CUKeyAction(combo: "return")))
        XCTAssertTrue(said?.contains("panel would choose a protected location") ?? false, said ?? "pressed")
        world()
        _ = unmarkedChooser(selected: "server", folder: "Projects", parent: ".ssh")
        let parent = await refusal(.key(CUKeyAction(combo: "return")))
        XCTAssertNotNil(parent, "its parent row named .ssh")
    }

    func testAFindPanelWithGitignoreSelectedGoesAhead() async throws {
        world()
        _ = unmarkedChooser(selected: ".gitignore", folder: "Find", parent: "proj")
        let n = poster.entries.count
        let said = await refusal(.key(CUKeyAction(combo: "return")))
        XCTAssertNil(said)
        XCTAssertTrue(poster.entries.dropFirst(n).contains { $0.type == .keyDown }, "Return was sent")
    }

    func testProtectedPanelPaths() {
        let home = "/Users/u"
        XCTAssertTrue(CUFloors.isProtectedPanelPath("~/.aws/credentials", home: home))
        XCTAssertTrue(CUFloors.isProtectedPanelPath("/Users/u/Library/Keychains/login.keychain-db", home: home))
        XCTAssertTrue(CUFloors.isProtectedPanelPath("/Volumes/x/.ssh/id_rsa", home: home), "the save floor's list anywhere")
        XCTAssertFalse(CUFloors.isProtectedPanelPath("/Users/u/Downloads/pkg.zip", home: home))
        XCTAssertTrue(CUFloors.panelChoiceIsProtected("file:///Users/u/.gnupg/secring.gpg", home: home))
        XCTAssertTrue(CUFloors.panelChoiceIsProtected(".netrc", home: home), "a bare dotfile name")
        XCTAssertTrue(CUFloors.panelChoiceIsProtected(".zshrc, 2 KB", home: home))
        XCTAssertFalse(CUFloors.panelChoiceIsProtected("screenshot.png, 1 280 × 800", home: home))
    }

    // MARK: the watch, narrowed (LOW-1)

    func testAKeyInASheetThatIsNoFilePanelIsNotWatched() async throws {
        world()
        let alert = fakeElement(98_150), list = fakeElement(98_151)
        ax.put(window, [kAXChildrenAttribute: [web, alert]])
        ax.add(alert, role: kAXSheetRole, frame: CGRect(x: 100, y: 40, width: 400, height: 200), extra: [kAXParentAttribute: window, kAXChildrenAttribute: [list]])
        ax.add(list, role: kAXListRole, frame: CGRect(x: 120, y: 80, width: 300, height: 100), extra: [kAXParentAttribute: alert, kAXFocusedAttribute: true])
        ax.focus(pid: pid, on: list)
        let r = try await act(.key(CUKeyAction(combo: "cmd+shift+g")))
        XCTAssertFalse(r.detail?.contains("nothing new appeared") ?? false, r.detail ?? "")
    }

    func testCaretMovesCopyQuickLookAndHiddenFilesAreNotJudged() async throws {
        world()
        _ = openPanel()
        for combo in ["left", "cmd+left", "cmd+c", "space", "cmd+shift+."] {
            let r = try await act(.key(CUKeyAction(combo: combo)))
            XCTAssertFalse(r.detail?.contains("nothing new appeared") ?? false, "\(combo): \(r.detail ?? "")")
        }
        XCTAssertTrue(CUCore.panelWatchExempt(try CUKeyChord.parse("cmd+right")))
        XCTAssertFalse(CUCore.panelWatchExempt(try CUKeyChord.parse("cmd+shift+g")))
    }

    func testACaretThatMovedInAPanelFieldIsAChange() async throws {
        world()
        let (sheet, _) = openPanel()
        let field = goToField(sheet, value: "/tmp")
        ax.focus(pid: pid, on: field)
        var r0 = CFRange(location: 4, length: 0)
        ax.put(field, [kAXFocusedAttribute: true, kAXSelectedTextRangeAttribute: AXValueCreate(.cfRange, &r0)!])
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            var r = CFRange(location: 0, length: 0)
            ax.put(field, [kAXSelectedTextRangeAttribute: AXValueCreate(.cfRange, &r)!])
        }
        let r = try await act(.key(CUKeyAction(combo: "ctrl+a")))
        XCTAssertFalse(r.detail?.contains("nothing new appeared") ?? false, r.detail ?? "")
    }

    func testNotATextFieldWords() {
        XCTAssertEqual(CUCore.notATextFieldWords("[4] table", chars: 3, inPanel: false),
                       "received: unverifiable — [4] table is not a text field, so the 3 characters went to it as keys and nothing can be read back (a list or table selects by typed letters; elsewhere they may be shortcuts) — check state() for what changed")
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

    // MARK: the after-act window runs from the act's return (probe 5, 2026-10-13)

    /// An act whose answer came late (Chrome activated itself and was put back): the picture right after it still waits
    /// and says it may predate the act — its window runs from the act's RETURN, not its input.
    func testTheAfterActWindowRunsFromTheActsReturn() throws {
        let label = "stale since 3 s ago: …"
        // Input at 2000, the answer returned at 5000, the picture at 5500: within the window from the return.
        XCTAssertTrue(CUCore.afterActFreshness(label, app: "Chrome", previous: (7, 1000, 1000), digest: 7, now: 5500, actedMs: 2000, returnedMs: 5000)
            .contains("this picture may predate the last action"))
        // From the input alone it would have been spent.
        XCTAssertEqual(CUCore.afterActFreshness(label, app: "Chrome", previous: (7, 1000, 1000), digest: 7, now: 5500, actedMs: 2000), label)
        // The wait itself: input long ago, returned just now — the picture is waited for.
        world()
        sys.windows[88]?.onScreen = false
        let before = WebPressTests.image(gray: 200), after = WebPressTests.image(gray: 60)
        var shots = 0
        core.privateCaptureOverride = { _, _ in shots += 1; return shots <= 2 ? before : after }
        let budget = CUImageBudget(maxLongEdge: 400, quality: 0.8)
        let first = try XCTUnwrap(core.offScreenStill(target, nil, budget))
        let now = CUSystemClock().nowMs()
        _ = target.noteOffScreenShot(digest: CUCore.contentDigest(first.jpeg), at: now - 4_000)
        target.lastActionMs = now - 3_000
        target.lastActReturnedMs = now
        let shot = try XCTUnwrap(core.offScreenAfterAct(target, nil, budget))
        XCTAssertNotEqual(CUCore.contentDigest(shot.jpeg), CUCore.contentDigest(first.jpeg), "waited for the act's picture")
    }

    func testAnActsReturnIsStampedOnTheTarget() async throws {
        world()
        XCTAssertNil(target.lastActReturnedMs)
        try await act(.click(CUClickAction(ref: ref(fileButton))))
        let returned = try XCTUnwrap(target.lastActReturnedMs)
        XCTAssertGreaterThanOrEqual(returned, try XCTUnwrap(target.lastActionMs))
        XCTAssertEqual(target.afterActFromMs, returned)
    }

    /// An act that sent nothing (refused before any input) leaves the last act's window as it was.
    func testARefusedActStampsNoReturn() async throws {
        world()
        target.lastActionMs = 1_000
        do { try await act(.key(CUKeyAction(combo: "x", into: ref(radios[0])))); XCTFail("a key into a radio is refused") } catch {}
        XCTAssertNil(target.lastActReturnedMs, "no input sent: no new window")
        XCTAssertEqual(target.lastActionMs, 1_000)
    }

    // MARK: a Chromium page on another desktop may lag (finding D)

    func testANothingChangedAnswerOffDesktopIsUnverified() {
        for d in ["clicked “Paint”, and nothing changed that accessibility can see — check with state()",
                  "the focused check box did not change after space (the page may not have taken the key) — click(ref) presses it",
                  "the keyboard focus did not move after tab (the page may not have taken the key)",
                  "pressed the option “Small” of [3] combo box “Size”, but the select did not change to it (Medium) — check state() before choosing again"] {
            let c = CUCore.offDesktopLagCaveat(d, app: "Google Chrome")
            XCTAssertEqual(c, "Google Chrome's page is on another desktop, where it may not update its accessibility until it is seen — what it reads may predate the action, so this is unverified; screenshot({ live: true, reason }) shows the window now", d)
        }
        XCTAssertNil(CUCore.offDesktopLagCaveat("pressed [4] “Submit”", app: "Google Chrome"), "a plain success claims nothing changed")
        XCTAssertNil(CUCore.offDesktopLagCaveat(nil, app: "Google Chrome"))
    }

    func testOnlyAChromiumWindowOffThisDesktopLags() {
        world()
        XCTAssertFalse(core.pageMayLagOffDesktop(target), "on this desktop")
        // Off this desktop: not on screen, and not among the windows accessibility lists here.
        sys.windows[88]?.onScreen = false
        ax.put(ax.application(pid), [kAXWindowsAttribute: [AXUIElement]()])
        XCTAssertTrue(core.pageMayLagOffDesktop(target))
        let safari = CUTarget(id: "t2", sessionId: "s", pid: pid, bundleId: "com.apple.Safari", appName: "Safari",
                              isChromium: false, mirror: false, windowID: 88, windowTitle: "Dashboard")
        XCTAssertFalse(core.pageMayLagOffDesktop(safari), "WebKit: not this rule")
    }

    // MARK: AXEnhancedUserInterface goes off with the process's last target

    func testEnhancedUserInterfaceIsTurnedOffOnlyWhenWinterTurnedItOnAndItStillReadsOn() {
        // Already on (another client's): never set, so never Winter's to turn off.
        var set: [String] = []
        let r = CUChromium.enableAccessibility(browser: true, enhancedBefore: { true }, set: { set.append($0) }, pageReady: { false }, pause: { _ in })
        XCTAssertEqual(r.set, ["AXManualAccessibility"])
        XCTAssertFalse(r.ours)
        var off: [Bool] = []
        XCTAssertFalse(CUChromium.releaseEnhanced(pid: 777_001, assistiveOn: false, readNow: { true }, set: { off.append($0) }), "not Winter's")
        // Winter's: off with the last target, once, re-read on just before; the next bind switches it on again.
        CUChromium.noteEnhancedForTesting(pid: 777_002, start: 1)
        XCTAssertTrue(CUChromium.releaseEnhanced(pid: 777_002, assistiveOn: false, readNow: { true }, set: { off.append($0) }))
        XCTAssertEqual(off, [false])
        XCTAssertFalse(CUChromium.isEnabledForTesting("777002:1.0"), "the next bind switches it on again")
        XCTAssertFalse(CUChromium.releaseEnhanced(pid: 777_002, assistiveOn: false, readNow: { true }, set: { off.append($0) }), "once")
        // An assistive client on (VoiceOver, Switch Control, Full Keyboard Access, Voice Control): left on.
        CUChromium.noteEnhancedForTesting(pid: 777_003, start: 1)
        XCTAssertFalse(CUChromium.releaseEnhanced(pid: 777_003, assistiveOn: true, readNow: { true }, set: { off.append($0) }))
        // The app does not answer the read, or reads it off already: left as it is.
        CUChromium.noteEnhancedForTesting(pid: 777_004, start: 1)
        XCTAssertFalse(CUChromium.releaseEnhanced(pid: 777_004, assistiveOn: false, readNow: { nil }, set: { off.append($0) }))
        CUChromium.noteEnhancedForTesting(pid: 777_005, start: 1)
        XCTAssertFalse(CUChromium.releaseEnhanced(pid: 777_005, assistiveOn: false, readNow: { false }, set: { off.append($0) }))
        XCTAssertEqual(off, [false])
    }

    /// The helper ending releases every flag Winter set; the record file (0600) mirrors them, so a helper that died
    /// with them set lets the next one clear them — only in THAT process (pid and start time), still on.
    func testTheFlagsAreRecordedReleasedAtTheEndAndReconciledAtTheNextStart() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cu-axflags-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("computer-use-ax-flags.json").path
        let saved = CUChromium.recordPath
        CUChromium.recordPath = path
        defer { CUChromium.recordPath = saved }
        CUChromium.noteEnhancedForTesting(pid: 778_001, start: 100)
        CUChromium.noteEnhancedForTesting(pid: 778_002, start: 200)
        XCTAssertEqual(CUChromium.loadRecords(path: path), [.init(pid: 778_001, start: 100), .init(pid: 778_002, start: 200)])
        let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
        // The end: both released (both still read on), the file gone.
        var turned: [pid_t] = []
        let off = CUChromium.releaseAll(assistiveOn: false, readNow: { _ in true }, set: { pid, _ in turned.append(pid) })
        XCTAssertEqual(Set(off), [778_001, 778_002])
        XCTAssertEqual(Set(turned), [778_001, 778_002])
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        // A helper that died: its records reconciled — the same process still on → off; a reused pid (another start) →
        // left; a process gone → left; one reading off → left.
        let left: [CUChromium.EnhancedRecord] = [.init(pid: 1, start: 10), .init(pid: 2, start: 20), .init(pid: 3, start: 30), .init(pid: 4, start: 40)]
        let starts: [pid_t: Double] = [1: 10, 2: 99, 4: 40]
        var cleared: [pid_t] = []
        let done = CUChromium.reconcile(left, startOf: { starts[$0] }, assistiveOn: false, readNow: { $0 == 4 ? false : true },
                                        set: { pid, on in XCTAssertFalse(on); cleared.append(pid) })
        XCTAssertEqual(done, [1])
        XCTAssertEqual(cleared, [1])
        XCTAssertEqual(CUChromium.reconcile(left, startOf: { starts[$0] }, assistiveOn: true, readNow: { _ in true }, set: { _, _ in XCTFail("an assistive client is on") }), [])
    }
}
