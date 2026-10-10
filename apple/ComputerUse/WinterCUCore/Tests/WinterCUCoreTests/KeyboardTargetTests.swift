import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Typing like a person: each character on its own real key (Shift/Option as the layout needs, the character
/// as the event's text), characters no key types as one Unicode event, keys sent to the focused field's own
/// content process (Safari's WebContent), and an accessibility insert believed only when the text reads back.
final class KeyboardTargetTests: XCTestCase {
    // MARK: keys for text

    private func typed(_ text: String) throws -> [RecordingPoster.Entry] {
        let poster = RecordingPoster()
        var synth = CUEventSynth(poster: poster, skyLight: .none)
        synth.sleep = { _ in }
        synth.stroke = { CUKeyboardLayout.ansiStroke(for: $0) }
        try synth.type(pid: 4242, text: text, route: .publicPid) {}
        return poster.entries.filter { $0.type == .keyDown }
    }

    func testEachCharacterIsItsOwnRealKeyWithItsShiftAndItsText() throws {
        let text = "Hello, World 42!"
        let downs = try typed(text)
        XCTAssertEqual(downs.count, text.count)
        XCTAssertEqual(downs.map(\.unicode), text.map(String.init), "each key carries its character")
        let ansi = CUKeyCodes.ansi
        let want: [Int64] = text.map { ch in
            let base: Character = CUKeyCodes.shiftedBase[ch] ?? Character(String(ch).lowercased())
            return Int64(ansi[base]!)
        }
        XCTAssertEqual(downs.map(\.keycode), want)
        XCTAssertEqual(downs.filter { $0.keycode == Int64(kVK_Space) }.map(\.unicode), [" ", " "], "49 only for the real spaces")
        XCTAssertFalse(downs.contains { $0.keycode == 0 && $0.unicode != "a" }, "no carrier key")
        XCTAssertTrue(downs[0].flags.contains(.maskShift), "H")
        XCTAssertFalse(downs[1].flags.contains(.maskShift), "e")
        XCTAssertTrue(downs.last!.flags.contains(.maskShift), "!")
        let ups = try { () throws -> [RecordingPoster.Entry] in
            let poster = RecordingPoster()
            var synth = CUEventSynth(poster: poster, skyLight: .none)
            synth.sleep = { _ in }
            synth.stroke = { CUKeyboardLayout.ansiStroke(for: $0) }
            try synth.type(pid: 4242, text: "Ab", route: .publicPid) {}
            return poster.entries.filter { $0.type == .keyUp }
        }()
        XCTAssertEqual(ups.map(\.keycode), [Int64(kVK_ANSI_A), Int64(kVK_ANSI_B)], "each key goes up the way it went down")
    }

    func testCharactersNoKeyTypesGoAsOneUnicodeEventPerRun() throws {
        let downs = try typed("a😀😀b")
        XCTAssertEqual(downs.map(\.unicode), ["a", "😀😀", "b"], "the run in one event, not one carrier key per character")
        XCTAssertEqual(downs[1].keycode, 0)
        let long = String(repeating: "日本", count: 10)  // 20 characters, 20 UTF-16 units
        let chunks = try typed(long)
        XCTAssertEqual(chunks.map(\.unicode).joined(), long)
        XCTAssertTrue(chunks.allSatisfy { $0.unicode.utf16.count <= CUEventSynth.unicodeChunk })
        let emoji = String(repeating: "😀", count: 10)  // surrogate pairs are never split
        XCTAssertEqual(try typed(emoji).map(\.unicode).joined(), emoji)
    }

    func testOptionLayerAndNonASCIICharactersGoAsUnicodeWithNoModifiers() throws {
        // A layout where Shift+Option+key 27 types the em dash, Option+key 0 "å", and a plain key types "ç".
        let poster = RecordingPoster()
        var synth = CUEventSynth(poster: poster, skyLight: .none)
        synth.sleep = { _ in }
        synth.stroke = { ch in
            switch ch {
            case "—": return CUKeyStroke(code: 27, shift: true, option: true)
            case "å": return CUKeyStroke(code: 0, option: true)
            case "ç": return CUKeyStroke(code: 41)
            default: return CUKeyboardLayout.ansiStroke(for: ch)
            }
        }
        try synth.type(pid: 4242, text: "A — çå b", route: .publicPid) {}
        let downs = poster.entries.filter { $0.type == .keyDown }
        XCTAssertEqual(downs.map(\.unicode).joined(), "A — çå b")
        XCTAssertFalse(poster.entries.contains { $0.flags.contains(.maskAlternate) }, "never Option: a page reads it as a shortcut")
        let dash = downs.first { $0.unicode.contains("—") }!
        XCTAssertEqual(dash.flags.intersection([.maskShift, .maskAlternate, .maskCommand, .maskControl]), [])
        XCTAssertEqual(dash.keycode, 0, "Unicode alone, no layout key")
        XCTAssertEqual(downs.first { $0.unicode.contains("ç") }?.keycode, 0, "non-ASCII: no layout key either")
        XCTAssertTrue(downs[0].flags.contains(.maskShift), "plain ASCII keeps its key and Shift")
    }

    func testReturnAndTabAreTheirKeys() throws {
        let downs = try typed("a\nb\tc")
        XCTAssertEqual(downs.map(\.keycode), [Int64(kVK_ANSI_A), Int64(kVK_Return), Int64(kVK_ANSI_B), Int64(kVK_Tab), Int64(kVK_ANSI_C)])
    }

    func testTheLayoutTableTakesTheFewestModifiers() {
        // A layout where key 27 types "-", Option gives "–" and Shift+Option "—"; key 0 types a/A/å.
        let strokes = CUKeyboardLayout.strokes { code, state in
            switch (code, state) {
            case (0, 0): return "a"
            case (0, 2): return "A"
            case (0, 8): return "å"
            case (27, 0): return "-"
            case (27, 2): return "_"
            case (27, 8): return "–"
            case (27, 10): return "—"
            case (50, 8): return "-"  // a second key typing "-" with Option loses to the plain one
            default: return nil
            }
        }
        XCTAssertEqual(strokes["a"], CUKeyStroke(code: 0))
        XCTAssertEqual(strokes["A"], CUKeyStroke(code: 0, shift: true))
        XCTAssertEqual(strokes["å"], CUKeyStroke(code: 0, option: true))
        XCTAssertEqual(strokes["-"], CUKeyStroke(code: 27))
        XCTAssertEqual(strokes["–"], CUKeyStroke(code: 27, option: true))
        XCTAssertEqual(strokes["—"], CUKeyStroke(code: 27, shift: true, option: true))
        XCTAssertEqual(CUKeyStroke(code: 27, shift: true, option: true).flags, [.maskShift, .maskAlternate])
    }

    // MARK: where keys go, and what counts as typed

    let pid: pid_t = 5454
    let content: pid_t = 7777
    let window = fakeElement(93_001)
    var field: AXUIElement!
    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    /// Safari with a web field served by `fieldOwner` (its WebContent process, or Safari itself).
    private func safari(fieldOwner: pid_t, settableText: Bool = false) {
        ax = FakeAX()
        field = fakeElement(fieldOwner == pid ? 93_002 : Int32(fieldOwner))
        let web = fakeElement(93_003)
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])
        ax.add(window, role: kAXWindowRole, title: "Docs", frame: CGRect(x: 0, y: 0, width: 900, height: 600),
               extra: [kAXChildrenAttribute: [web]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(web, role: "AXWebArea", frame: CGRect(x: 0, y: 50, width: 900, height: 550), extra: [kAXChildrenAttribute: [field!]])
        ax.add(field, role: kAXTextFieldRole, title: "Rename", frame: CGRect(x: 20, y: 60, width: 300, height: 24),
               extra: [kAXValueAttribute: "Untitled document", kAXParentAttribute: web])
        ax.makeSettable(field, kAXFocusedAttribute)
        if settableText { ax.makeSettable(field, kAXSelectedTextAttribute) }
        ax.focus(pid: pid, on: field)
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.apple.Safari"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 900, height: 600), owner: "Safari")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.apple.Safari", appName: "Safari",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Docs")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    @discardableResult
    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: false))
    }

    func testKeysGoToTheWebFieldsOwnContentProcess() async throws {
        safari(fieldOwner: content)
        sys.contentProcesses[content] = pid
        try await act(.type(CUTypeAction(text: "Test", into: ref(field))))
        let downs = poster.entries.filter { $0.type == .keyDown }
        XCTAssertEqual(downs.map(\.unicode), ["T", "e", "s", "t"])
        XCTAssertEqual(Set(downs.map(\.pid)), [content], "posted to the WebContent process, not Safari's UI")
        XCTAssertEqual(Set(downs.map(\.targetPid)), [Int64(content)])
        try await act(.key(CUKeyAction(combo: "return", into: ref(field))))
        XCTAssertEqual(poster.entries.last?.pid, content, "keys too")
    }

    func testAnotherAppOrTheAppItselfKeepsTheAppsPid() async throws {
        safari(fieldOwner: content)  // a process that is not a content process of Safari's
        try await act(.type(CUTypeAction(text: "ab", into: ref(field))))
        XCTAssertEqual(Set(poster.entries.map(\.pid)), [pid])
        safari(fieldOwner: pid)
        try await act(.type(CUTypeAction(text: "ab", into: ref(field))))
        XCTAssertEqual(Set(poster.entries.map(\.pid)), [pid])
    }

    func testEditingShortcutsIntoAWebFieldGoAsKeysNotTheAppsMenu() async throws {
        safari(fieldOwner: content)
        sys.contentProcesses[content] = pid
        // Safari lists a Select All menu item with cmd+A; it must not be used for a web field.
        let bar = fakeElement(93_050), edit = fakeElement(93_051), menu = fakeElement(93_052), all = fakeElement(93_053)
        let apple = fakeElement(93_055)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.add(apple, role: "AXMenuBarItem", title: "Apple")
        ax.put(bar, [kAXChildrenAttribute: [apple, edit]])  // the window is not key in Safari: keys, not this item
        ax.add(edit, role: "AXMenuBarItem", title: "Edit", extra: [kAXChildrenAttribute: [menu]])
        ax.add(menu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [all]])
        ax.add(all, role: kAXMenuItemRole, title: "Select All",
               extra: [kAXMenuItemCmdCharAttribute: "a", kAXMenuItemCmdModifiersAttribute: 0, kAXEnabledAttribute: true])
        ax.setActions(all, [kAXPressAction])
        let r = try await act(.key(CUKeyAction(combo: "cmd+a", into: ref(field))))
        XCTAssertEqual(r.rung, 2, "keys, not the menu item (rung 1)")
        XCTAssertTrue(ax.performed.isEmpty, "the menu item was not pressed")
        let down = poster.entries.first { $0.type == .keyDown }
        XCTAssertEqual(down?.keycode, Int64(kVK_ANSI_A))
        XCTAssertTrue(down?.flags.contains(.maskCommand) ?? false)
        XCTAssertEqual(down?.pid, content, "to the web field's content process")
    }

    func testEditingShortcutsUseTheMenuItemOnceTheFieldsWindowIsKeyInItsApp() async throws {
        let plain = nativeField()
        ax.focus(pid: pid, on: plain)
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window])  // the field's window is key in its app
        let bar = fakeElement(93_050), edit = fakeElement(93_051), menu = fakeElement(93_052), copy = fakeElement(93_054)
        let apple = fakeElement(93_055)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.add(apple, role: "AXMenuBarItem", title: "Apple")
        ax.put(bar, [kAXChildrenAttribute: [apple, edit]])
        ax.add(edit, role: "AXMenuBarItem", title: "Edit", extra: [kAXChildrenAttribute: [menu]])
        ax.add(menu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [copy]])
        ax.add(copy, role: kAXMenuItemRole, title: "Copy",
               extra: [kAXMenuItemCmdCharAttribute: "c", kAXMenuItemCmdModifiersAttribute: 0, kAXEnabledAttribute: true])
        ax.setActions(copy, [kAXPressAction])
        let r = try await act(.key(CUKeyAction(combo: "cmd+c", into: target.refs.ref(for: AXIdentity(element: plain)))))
        XCTAssertEqual(r.rung, 1, "the menu item: its action reaches the key window's focused field")
        XCTAssertTrue(ax.performed.contains("\(token(copy)):\(kAXPressAction)"))
        XCTAssertTrue(poster.keyDowns.isEmpty)
    }

    func testAFieldWithDOMFocusWhileTheWindowReportsAnotherControlIsClickedIntoPlace() async throws {
        safari(fieldOwner: pid)
        let address = searchHasFocus()  // the window's first responder: another control (Safari's address bar)
        ax.put(field, [kAXFocusedAttribute: kCFBooleanTrue])  // the page's input holds DOM focus all the same
        poster.onPost = { [unowned self] e in if e.type == .leftMouseUp { ax.focus(pid: pid, on: field) } }
        try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
        _ = address
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 1, "clicked into place, not trusted")
        XCTAssertEqual(poster.keyDowns.count, 2)
    }

    func testAMenuCommandMakesTheBoundWindowKeyThroughTheElementJustWorkedOn() async throws {
        safari(fieldOwner: pid)
        ax.makeSettable(field, kAXValueAttribute)
        try await act(.setValue(CUSetValueAction(ref: ref(field), value: "make me loud")))  // the element worked on
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: fakeElement(93_099)])  // another window is key
        let bar = fakeElement(93_070), apple = fakeElement(93_071), fixture = fakeElement(93_072), menu = fakeElement(93_073)
        let upper = fakeElement(93_074)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.add(apple, role: "AXMenuBarItem", title: "Apple")
        ax.put(bar, [kAXChildrenAttribute: [apple, fixture]])
        ax.add(fixture, role: "AXMenuBarItem", title: "Fixture", extra: [kAXChildrenAttribute: [menu]])
        ax.add(menu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [upper]])
        ax.add(upper, role: kAXMenuItemRole, title: "Uppercase Selection", extra: [kAXEnabledAttribute: true])
        ax.setActions(upper, [kAXPressAction])
        poster.onPost = { [unowned self] e in if e.type == .leftMouseUp { ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window]) } }
        try await act(.menu(CUMenuAction(path: ["Fixture", "Uppercase Selection"])))
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 1, "the field clicked so its window is key")
        XCTAssertTrue(ax.performed.contains("\(token(upper)):\(kAXPressAction)"))
    }

    /// A Fixture › Uppercase Selection menu; returns the item.
    private func uppercaseMenu(enabled: Bool) -> AXUIElement {
        let bar = fakeElement(93_075), apple = fakeElement(93_076), fixture = fakeElement(93_077), menu = fakeElement(93_078)
        let upper = fakeElement(93_079)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.add(apple, role: "AXMenuBarItem", title: "Apple")
        ax.put(bar, [kAXChildrenAttribute: [apple, fixture]])
        ax.add(fixture, role: "AXMenuBarItem", title: "Fixture", extra: [kAXChildrenAttribute: [menu]])
        ax.add(menu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [upper]])
        ax.add(upper, role: kAXMenuItemRole, title: "Uppercase Selection", extra: [kAXEnabledAttribute: enabled])
        ax.setActions(upper, [kAXPressAction])
        return upper
    }

    func testAMenuCommandClicksTheSelectionEvenWhenTheKeyWindowCantBeRead() async throws {
        safari(fieldOwner: pid)
        ax.makeSettable(field, kAXValueAttribute)
        try await act(.setValue(CUSetValueAction(ref: ref(field), value: "make me loud")))
        let upper = uppercaseMenu(enabled: true)  // no AXFocusedWindow, no AXFocused: the key window is unknown
        try await act(.menu(CUMenuAction(path: ["Fixture", "Uppercase Selection"])))
        XCTAssertGreaterThanOrEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 1, "clicked to make it certain")
        XCTAssertTrue(ax.performed.contains("\(token(upper)):\(kAXPressAction)"))
    }

    func testAMenuItemThatReadsDisabledIsReadAgainBeforeItIsCalledDisabled() async throws {
        safari(fieldOwner: pid)
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window])  // already key
        let upper = uppercaseMenu(enabled: false)
        core.menuSettleMs = 400
        var reads = 0
        ax.onRead = { [unowned self] what in
            guard what == "\(token(upper)):\(kAXEnabledAttribute)" else { return }
            reads += 1
            if reads == 2 { ax.put(upper, [kAXEnabledAttribute: true]) }  // the app re-validated
        }
        try await act(.menu(CUMenuAction(path: ["Fixture", "Uppercase Selection"])))
        XCTAssertTrue(ax.performed.contains("\(token(upper)):\(kAXPressAction)"))
    }

    /// A text area holding "make me loud please" with "loud" selected by `select`; "Uppercase Selection" is
    /// enabled exactly while that selection is 8+4 (the app re-validating on every read).
    private func selectedLoud() async throws -> AXUIElement {
        safari(fieldOwner: pid)
        ax.put(field, [kAXValueAttribute: "make me loud please"])
        ax.makeSettable(field, kAXSelectedTextRangeAttribute)
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window])  // the bound window is key
        try await act(.select(CUSelectAction(ref: ref(field), text: "loud")))
        let upper = uppercaseMenu(enabled: false)
        ax.onRead = { [unowned self] what in
            guard what == "\(token(upper)):\(kAXEnabledAttribute)" else { return }
            ax.put(upper, [kAXEnabledAttribute: core.selectionRange(field) == NSRange(location: 8, length: 4)])
        }
        return upper
    }

    func testABackgroundMenuCommandPutsBackTheSelectionALateClickMoved() async throws {
        let upper = try await selectedLoud()
        ax.put(field, [kAXSelectedTextRangeAttribute: AX.makeRange(location: 19, length: 0)!])  // a late focus click
        try await act(.menu(CUMenuAction(path: ["Fixture", "Uppercase Selection"])))
        XCTAssertEqual(core.selectionRange(field), NSRange(location: 8, length: 4), "the selection select() set, put back")
        XCTAssertTrue(ax.performed.contains("\(token(upper)):\(kAXPressAction)"))
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseDown }.isEmpty, "the window was key: no click")
    }

    /// No focus blip possible here (no reroute tap in a test core): the activation again and a settled read.
    func testAMenuCommandDisabledWithNoBlipPossibleIsReadAgainAfterAnotherActivationWithoutAClick() async throws {
        let upper = try await selectedLoud()
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        var reads = 0
        ax.onRead = { [unowned self] what in
            guard what == "\(token(upper)):\(kAXEnabledAttribute)" else { return }
            reads += 1
            ax.put(upper, [kAXEnabledAttribute: reads >= 2])  // re-validated on the second activation
        }
        let before = poster.entries.count
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                 action: .menu(CUMenuAction(path: ["Fixture", "Uppercase Selection"])),
                                                 access: .full, allowForeground: false, privatePath: true))
        XCTAssertEqual(enforcer.forced, [77, 77], "the activation posted again for the second read")
        XCTAssertTrue(poster.entries.dropFirst(before).filter { $0.type == .leftMouseDown }.isEmpty, "no click: the window was key")
        XCTAssertEqual(core.selectionRange(field), NSRange(location: 8, length: 4))
        XCTAssertTrue(ax.performed.contains("\(token(upper)):\(kAXPressAction)"))
    }

    func testTheSyntheticActivationIsPostedBeforeAMenuIsValidatedWhateverTheAppIsBelievedToBe() async throws {
        let upper = try await selectedLoud()
        let enforcer = FakeFocusEnforcer()
        enforcer.result = false  // the enforcer believes the app is active already: enforce() posts nothing
        core.focusEnforcerFactory = { _ in enforcer }
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                 action: .menu(CUMenuAction(path: ["Fixture", "Uppercase Selection"])),
                                                 access: .full, allowForeground: false, privatePath: true))
        XCTAssertEqual(enforcer.forced, [77], "posted whatever the cached belief")
        XCTAssertTrue(ax.performed.contains("\(token(upper)):\(kAXPressAction)"))
    }

    func testAppLevelCommandsStillUseTheMenuWhenFocusIsNotEditable() async throws {
        safari(fieldOwner: pid)
        ax.put(field, [kAXRoleAttribute: kAXButtonRole])  // focus is not an editable element
        let bar = fakeElement(93_060), apple = fakeElement(93_064), file = fakeElement(93_061), menu = fakeElement(93_062), nw = fakeElement(93_063)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.add(apple, role: "AXMenuBarItem", title: "Apple")
        ax.put(bar, [kAXChildrenAttribute: [apple, file]])
        ax.add(file, role: "AXMenuBarItem", title: "File", extra: [kAXChildrenAttribute: [menu]])
        ax.add(menu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [nw]])
        ax.add(nw, role: kAXMenuItemRole, title: "New Window",
               extra: [kAXMenuItemCmdCharAttribute: "n", kAXMenuItemCmdModifiersAttribute: 0, kAXEnabledAttribute: true])
        ax.setActions(nw, [kAXPressAction])
        let r = try await act(.key(CUKeyAction(combo: "cmd+n")))
        XCTAssertEqual(r.rung, 1, "an app-level command uses the menu item")
        XCTAssertEqual(ax.performed, ["\(token(nw)):AXPress"])
    }

    func testAPasteIntoAWebEditorReturnsUnconfirmedWithoutASecondWait() async throws {
        // A web field whose value is readable but the paste does not land (it reads the clipboard late).
        safari(fieldOwner: content)
        sys.contentProcesses[content] = pid
        ax.put(field, [kAXValueAttribute: "existing"])
        let start = Date()
        let r = try await act(.paste(CUPasteAction(text: "hello")))
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.0, "no 1.5 s wait for a web editor")
        XCTAssertTrue(r.detail?.contains("unconfirmed") ?? false, r.detail ?? "")
    }

    func testAnInsertThatCantBeReadBackInWebContentIsNeverTypedAgain() async throws {
        safari(fieldOwner: pid, settableText: true)
        ax.drop(field, kAXValueAttribute)  // nothing to read it back by
        let r = try await act(.type(CUTypeAction(text: "Test", into: ref(field))))
        XCTAssertTrue(ax.written.contains("\(token(field)):\(kAXSelectedTextAttribute)"), "inserted over accessibility")
        XCTAssertTrue(poster.keyDowns.isEmpty, "never typed a second time")
        XCTAssertTrue(r.detail?.contains("received: unverifiable — inserted over accessibility, but the field can't be read back, so it was not typed again") ?? false, r.detail ?? "")
    }

    func testAnAccessibilityInsertCountsOnlyWhenItsTextReadsBack() async throws {
        // The insert is taken and reverted (Google Docs' title): the value never shows the text → keys.
        safari(fieldOwner: pid, settableText: true)
        ax.ignoresWrites = ["\(token(field)):\(kAXSelectedTextAttribute)"]
        let r = try await act(.type(CUTypeAction(text: "Test", into: ref(field))))
        XCTAssertEqual(r.rung, 2, "typed as keys")
        XCTAssertEqual(poster.entries.filter { $0.type == .keyDown }.map(\.unicode), ["T", "e", "s", "t"])
        // An insert that lands: the value contains the text → done over accessibility, no keys.
        safari(fieldOwner: pid, settableText: true)
        ax.onSet = { [unowned self] what in
            if what.hasSuffix(":\(kAXSelectedTextAttribute)") { ax.put(field, [kAXValueAttribute: "Untitled documentTest"]) }
        }
        let ok = try await act(.type(CUTypeAction(text: "Test", into: ref(field))))
        XCTAssertEqual(ok.rung, 1)
        XCTAssertTrue(poster.entries.isEmpty)
    }

    // MARK: what was sent vs what the field received

    /// The field takes the first `takes` typed characters (nil: all of them) into its value.
    private func fieldTakes(_ takes: Int? = nil) {
        var n = 0
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            n += 1
            if takes.map({ n <= $0 }) ?? true {
                ax.put(field, [kAXValueAttribute: (ax.string(field, kAXValueAttribute) ?? "") + e.unicode])
            }
        }
    }

    func testTypedTextReadBackInFullIsVerified() async throws {
        safari(fieldOwner: pid)
        fieldTakes()
        let r = try await act(.type(CUTypeAction(text: " v2", into: ref(field))))
        XCTAssertEqual(ax.string(field, kAXValueAttribute), "Untitled document v2")
        XCTAssertTrue(r.detail?.contains("received: verified") ?? false, r.detail ?? "")
    }

    func testTypedTextThatOnlyPartlyLandedSaysHowMuch() async throws {
        safari(fieldOwner: pid)
        fieldTakes(3)
        let r = try await act(.type(CUTypeAction(text: " report", into: ref(field))))
        XCTAssertTrue(r.detail?.contains("received: partly (the field holds the first 3 of 7 characters; the rest differs or is missing)") ?? false, r.detail ?? "")
        XCTAssertFalse(r.detail?.contains("verified") ?? true)
    }

    func testTypedTextThatNeverLandedSaysNoneOfIt() async throws {
        safari(fieldOwner: pid)
        let r = try await act(.type(CUTypeAction(text: "abc", into: ref(field))))
        XCTAssertTrue(r.detail?.contains("received: none of it") ?? false, r.detail ?? "")
    }

    func testTypingStopsWhenTheFocusLeavesTheField() async throws {
        // The page takes a character as its shortcut and moves the focus to its own search box partway.
        safari(fieldOwner: pid)
        let search = searchHasFocus()
        ax.focus(pid: pid, on: field)
        var n = 0
        poster.onPost = { [unowned self] e in
            guard e.type == .keyUp else { return }
            n += 1
            if n == 3 { ax.focus(pid: pid, on: search) }
        }
        do {
            try await act(.type(CUTypeAction(text: "Title — more", into: ref(field))))
            XCTFail("typing went on into the search box")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "refused")
            XCTAssertEqual(e.data?["reason"], .string("focus_moved"))
            XCTAssertTrue(e.message.hasPrefix("typed 3 of 12 characters; then the focus moved from [\(ref(field))] text field \"Rename\" to [\(ref(search))] text field \"Search\" (after \u{201C}Tit\u{201D}), so the rest was not sent"), e.message)
            XCTAssertFalse(e.message.contains("had been typed before this"), "the counts once")
        }
        XCTAssertEqual(poster.keyDowns.count, 3, "nothing more went out")
    }

    func testATabMovesTheFocusOnPurpose() async throws {
        safari(fieldOwner: pid)
        let search = searchHasFocus()
        ax.focus(pid: pid, on: field)
        poster.onPost = { [unowned self] e in
            if e.type == .keyUp, e.keycode == Int64(kVK_Tab) { ax.focus(pid: pid, on: search) }
        }
        _ = try await act(.type(CUTypeAction(text: "ab\tcd", into: ref(field))))
        XCTAssertEqual(poster.keyDowns.count, 5, "all of it")
    }

    func testSeveralLinesIntoAFieldThatReadsBackGoAsAPasteAndSaySo() async throws {
        safari(fieldOwner: pid)
        let r = try await act(.type(CUTypeAction(text: "one\ntwo", into: ref(field))))
        XCTAssertTrue(r.detail?.hasPrefix("as a paste (several lines go as a paste into a field that reads them back)") ?? false, r.detail ?? "")
    }

    /// A plain native field (not under a web area) in a content-process-free app, built directly under the
    /// window, so the route choice is tested in isolation from the type pipeline.
    private func nativeField() -> AXUIElement {
        safari(fieldOwner: pid)
        sys.bundles[pid] = "com.example.Native"
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.Native", appName: "Native",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Docs")
        core.registerForTesting(target, windowElement: window)
        let plain = fakeElement(93_080)
        ax.add(plain, role: kAXTextFieldRole, title: "Plain", frame: CGRect(x: 20, y: 60, width: 200, height: 24))
        ax.makeSettable(plain, kAXFocusedAttribute)
        ax.put(window, [kAXChildrenAttribute: [plain]])  // directly under the window, no web area
        ax.focus(pid: pid, on: nil)
        return plain
    }

    func testAnAlreadyFocusedFieldIsLeftAlone() {
        let f = nativeField()
        ax.focus(pid: pid, on: f)
        ax.onSet = { _ in XCTFail("no focus write when already focused") }
        ax.onPerform = { _ in XCTFail("no press when already focused") }
        XCTAssertTrue(core.focusField(f, target))
        XCTAssertFalse(ax.written.contains { $0.hasSuffix(":\(kAXFocusedAttribute)") })
    }

    func testANativeFieldUsesPressFirstThenTheGuardedWriteRememberedPerApp() {
        let f = nativeField()  // no press actions → press route fails → the guarded write
        ax.onSet = { [unowned self] what in if what.hasSuffix(":\(kAXFocusedAttribute)") { sys.front = pid } }
        sys.windows[77]?.onScreen = false  // no on-screen click either
        _ = core.focusField(f, target)  // the write may place it (the field reads focused) — but it activated the app
        XCTAssertEqual(sys.activated, [1], "the user's app put back at once")
        XCTAssertTrue(target.takeViewNotes().contains { $0.contains("Native activated itself — the user's app was put back") })
        XCTAssertTrue(core.appActivatesOnFocusWrite(target), "remembered")
        // A later native field of the same app skips the write entirely (press route only).
        let f2 = fakeElement(93_081)
        ax.add(f2, role: kAXTextFieldRole, title: "Plain2", frame: CGRect(x: 20, y: 90, width: 200, height: 24))
        ax.put(window, [kAXChildrenAttribute: [f2]])
        ax.focus(pid: pid, on: nil)
        ax.onSet = { _ in XCTFail("no AXFocused write for a remembered app") }
        _ = core.focusField(f2, target)
    }

    func testAWebFieldIsPressedNotWritten() {
        safari(fieldOwner: pid)
        ax.focus(pid: pid, on: nil)
        ax.setActions(field, [kAXPressAction])
        ax.onPerform = { [unowned self] what in if what == "\(token(field)):AXPress" { ax.focus(pid: pid, on: field) } }
        ax.onSet = { _ in XCTFail("no AXFocused write on a web field") }
        XCTAssertTrue(core.focusField(field, target))
        XCTAssertTrue(ax.performed.contains("\(token(field)):AXPress"))
        XCTAssertTrue(sys.activated.isEmpty, "pressing does not activate")
    }

    /// The page's search field, which holds the focus while the agent means to type into the comment field.
    private func searchHasFocus() -> AXUIElement {
        let search = fakeElement(93_090)
        ax.add(search, role: kAXTextFieldRole, title: "Search", frame: CGRect(x: 400, y: 60, width: 200, height: 24),
               extra: [kAXValueAttribute: "search term"])
        ax.focus(pid: pid, on: search)
        return search
    }

    func testAWebFieldThatCannotBePressedIsNotWritten() {
        safari(fieldOwner: pid)
        ax.focus(pid: pid, on: nil)   // not focused, no press actions
        sys.windows[77]?.onScreen = false  // and no click: the private path is off for this target
        target = CUTarget(id: "t2", sessionId: "s", pid: pid, bundleId: "com.apple.Safari", appName: "Safari",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Docs", privatePath: false)
        core.registerForTesting(target, windowElement: window)
        ax.onSet = { _ in XCTFail("the write is forbidden for a web field") }
        XCTAssertFalse(core.focusField(field, target))
    }

    func testTypingIntoAFieldWhoseFocusStaysElsewhereIsRefusedAndTypesNothing() async throws {
        safari(fieldOwner: pid)
        _ = searchHasFocus()
        sys.windows[77]?.onScreen = false  // nothing places it: no press, no click with the private path off
        ax.onSet = { _ in XCTFail("no AXFocused write on a web field") }
        for action in [CUAction.type(CUTypeAction(text: "line one", into: ref(field))),
                       .paste(CUPasteAction(text: "line one", into: ref(field))),
                       .key(CUKeyAction(combo: "a", into: ref(field)))] {
            do {
                try await act(action)
                XCTFail("expected focus_not_placed for \(action)")
            } catch let e as CUError {
                XCTAssertEqual(e.code, "refused")
                XCTAssertEqual(e.data?["reason"], .string("focus_not_placed"))
                XCTAssertTrue(e.message.contains("nothing was typed"), e.message)
            }
        }
        XCTAssertTrue(poster.keyDowns.isEmpty, "not one key went to the search field")
    }

    func testAClickAtTheFieldsCentrePlacesFocusThatWebKitMovesLate() async throws {
        safari(fieldOwner: pid)
        _ = searchHasFocus()
        core.focusWaitWebMs = 300
        // The click lands; WebKit reports the new focus a few reads later.
        var clicked = false, reads = 0
        poster.onPost = { e in if e.type == .leftMouseUp { clicked = true } }
        ax.onRead = { [unowned self] what in
            guard clicked, what.hasSuffix(":\(kAXFocusedUIElementAttribute)") else { return }
            reads += 1
            if reads == 3 { ax.focus(pid: pid, on: field) }
        }
        try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
        let down = try XCTUnwrap(poster.entries.first { $0.type == .leftMouseDown })
        XCTAssertEqual(down.window, 77, "a window-targeted click")
        XCTAssertEqual(poster.keyDowns.count, 2, "typed once the field had the focus")
        XCTAssertFalse(ax.written.contains { $0.hasSuffix(":\(kAXFocusedAttribute)") })
    }

    func testASelectionWritePlacesTheCaretWhenAPressDoesNot() async throws {
        safari(fieldOwner: pid)
        _ = searchHasFocus()
        ax.setActions(field, [kAXPressAction])  // the press leaves focus in Search (a textarea)
        ax.makeSettable(field, kAXSelectedTextRangeAttribute)
        ax.onSet = { [unowned self] what in
            XCTAssertFalse(what.hasSuffix(":\(kAXFocusedAttribute)"), "never the AXFocused write")
            if what.hasSuffix(":\(kAXSelectedTextRangeAttribute)") { ax.focus(pid: pid, on: field) }
        }
        try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
        XCTAssertTrue(ax.written.contains("\(token(field)):\(kAXSelectedTextRangeAttribute)"))
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseDown }.isEmpty, "no click needed")
        XCTAssertEqual(poster.keyDowns.count, 2)
    }

    func testAClickThatOnlyMadeTheWindowKeyInItsAppIsSentOnceMore() async throws {
        safari(fieldOwner: pid)
        _ = searchHasFocus()
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: fakeElement(93_099)])  // another window is key in Safari
        var downs = 0
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseUp else { return }
            downs += 1
            if downs == 1 { ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window]) }  // only made it key
            else { ax.focus(pid: pid, on: field) }  // the second click focuses the field
        }
        try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 2)
        XCTAssertEqual(poster.keyDowns.count, 2)
    }

    func testAFocusedFieldInAWindowThatIsNotKeyInItsAppGetsAClickFirst() async throws {
        safari(fieldOwner: pid)  // the field already has WebKit focus
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: fakeElement(93_099)])  // another window is key
        ax.makeSettable(field, kAXSelectedTextRangeAttribute)
        let r = AX.makeRange(location: 3, length: 2)!
        ax.put(field, [kAXSelectedTextRangeAttribute: r])
        poster.onPost = { [unowned self] e in
            if e.type == .leftMouseUp { ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window]) }  // the click makes it key
        }
        try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
        let downs = poster.entries.filter { $0.type == .leftMouseDown }
        XCTAssertEqual(downs.count, 1, "one click on the field")
        XCTAssertEqual(downs.first?.window, 77)
        XCTAssertTrue(ax.written.contains("\(token(field)):\(kAXSelectedTextRangeAttribute)"), "its selection put back")
        XCTAssertEqual(poster.keyDowns.count, 2)
    }

    func testWhenTheKeyMakingClickLeavesTheFocusElsewhereNothingIsTyped() async throws {
        safari(fieldOwner: pid)  // the field has WebKit focus, its window is not key in Safari
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: fakeElement(93_099)])
        let other = fakeElement(93_098)
        ax.add(other, role: kAXTextFieldRole, title: "Address", frame: CGRect(x: 400, y: 10, width: 300, height: 24))
        poster.onPost = { [unowned self] e in
            // Each click makes the window key, but its first responder (the address bar) keeps the focus.
            if e.type == .leftMouseUp { ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window]); ax.focus(pid: pid, on: other) }
        }
        do {
            try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
            XCTFail("expected focus_not_placed")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("focus_not_placed"))
        }
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 2, "clicked twice")
        XCTAssertTrue(poster.keyDowns.isEmpty, "not one key into the address bar")
    }

    func testAWindowAlreadyKeyInItsAppIsLeftAlone() async throws {
        safari(fieldOwner: pid)
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window])
        try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseDown }.isEmpty, "no click")
    }

    func testAFocusedDescendantOrTheFieldsOwnFocusedFlagCounts() {
        safari(fieldOwner: pid)
        let inner = fakeElement(93_091)
        ax.add(inner, role: "AXGroup", frame: CGRect(x: 20, y: 60, width: 10, height: 10), extra: [kAXParentAttribute: field!])
        ax.focus(pid: pid, on: inner)
        XCTAssertTrue(core.isFocused(field, target), "the focus is inside the field")
        ax.focus(pid: pid, on: nil)
        ax.put(field, [kAXFocusedAttribute: kCFBooleanTrue])
        XCTAssertTrue(core.isFocused(field, target), "the field says it has the focus")
    }

    func testTextUpToTwoHundredCharactersIsTypedAsKeys() async throws {
        safari(fieldOwner: pid)
        let title = "OpenRouter Decision Models — Jev Comparison — 2026-10-09 — Repeat 3"
        XCTAssertGreaterThan(title.count, 64)
        try await act(.type(CUTypeAction(text: title, into: ref(field))))
        XCTAssertEqual(poster.entries.filter { $0.type == .keyDown }.map(\.unicode).joined(), title, "keys, not a paste")
    }

    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }
}
