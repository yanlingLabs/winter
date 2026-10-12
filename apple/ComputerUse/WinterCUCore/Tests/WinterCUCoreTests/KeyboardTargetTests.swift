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
        XCTAssertTrue(downs.contains { $0.unicode == "ç" } && downs.contains { $0.unicode == "å" },
                      "a character a key types goes as its own event, never merged into a run")
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

    /// Round 13's dogfood item 13: a field scrolled out of view is scrolled to before the focus click — the click goes
    /// to where it is now, never to a point outside the window (it would land on something else).
    func testAFieldScrolledOutOfViewIsScrolledToBeforeTheFocusClick() async throws {
        safari(fieldOwner: pid)
        _ = searchHasFocus()
        ax.put(field, [kAXFocusedAttribute: kCFBooleanFalse])
        var below = CGPoint(x: 20, y: 1400), size = CGSize(width: 300, height: 24)
        ax.put(field, [kAXPositionAttribute: AXValueCreate(.cgPoint, &below)!, kAXSizeAttribute: AXValueCreate(.cgSize, &size)!])
        ax.refuses.insert("\(token(field)):\(kAXPressAction)")
        ax.onPerform = { [unowned self] action in
            guard action == "\(token(field)):AXScrollToVisible" else { return }
            var into = CGPoint(x: 20, y: 300)
            ax.put(field, [kAXPositionAttribute: AXValueCreate(.cgPoint, &into)!])
        }
        poster.onPost = { [unowned self] e in if e.type == .leftMouseUp { ax.focus(pid: pid, on: field) } }
        try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
        XCTAssertTrue(ax.performed.contains("\(token(field)):AXScrollToVisible"), "scrolled to first")
        let downs = poster.entries.filter { $0.type == .leftMouseDown }
        XCTAssertEqual(downs.count, 1)
        XCTAssertEqual(downs.first?.location.y ?? 0, 312, accuracy: 1, "at the field's centre where it is now")
    }

    /// Round 14 (the Material probe): Space or Return INTO a control a press acts on (a check box, a button) is ONE
    /// press — never a press to place the focus and then the key (a check box toggled twice, a button pressed twice);
    /// another key into it is refused with the way.
    /// Round 16, P1 (the live hands-off regression): a type act checked I6 at its start; the user then clicked into Name;
    /// the act's focus placement must NOT take them back to Email — and a burst in flight stops before its next key.
    func testAnActInFlightNeverMovesTheFocusOnceTheUserWorks() async throws {
        safari(fieldOwner: pid)
        sys.front = pid  // the app in front: the user works in it
        core.testUserInput(pid: pid, switching: false)  // their click into another field of it
        XCTAssertThrowsError(try core.placeFocus(field, target, ref: ref(field))) { e in
            XCTAssertEqual((e as? CUError)?.data?["reason"], .string("user_working"))
        }
        XCTAssertTrue(ax.performed.isEmpty, "no press to place the focus: \(ax.performed)")
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseDown }.isEmpty, "no focusing click")
    }

    /// Round 16's editor-target seed 51: the target stole the front mid-burst while the focus blip's reroute was on it;
    /// the user's keys went to THEIR app — no work in the target. Round 17 (the review of round 16, MEDIUM): the REROUTE's
    /// own decision marks the work — a key it lets through into the target is work there even while the guardian's place
    /// is still elsewhere (the session tap can see the key before the reroute decides it); one it sends to their place is
    /// not. Its destination changes between the two keys, as the one rule's answer does.
    func testTheReroutesOwnDecisionMarksTheWorkNeverTheFrontApp() throws {
        safari(fieldOwner: pid)
        core.guardianLock.withLock { core.guardianCore.begin(view: CUGuardedView(app: 1, space: nil)) }
        let installer = FakeKeyTapInstaller()
        var destination: pid_t = 1
        let reroute = CUKeyReroute(target: pid, victim: 1, installer: installer, post: { _, _ in }, destination: { destination })
        reroute.onPassThrough = core.passThroughWorkMarker(pid)  // as the focus blip installs it
        XCTAssertTrue(reroute.begin())
        core.activeKeyReroute = reroute
        sys.front = pid  // the target took the front by itself
        let key = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!
        // The session tap sees the key first: the reroute decides, nothing is marked from the front app.
        core.noteUserInteraction(type: .keyDown, flags: [], keycode: 0, location: nil, targetPid: Int64(pid))
        XCTAssertNil(reroute.handle(key), "sent to their place, dropped from the target")
        XCTAssertFalse(core.userIsWorking(in: pid), "their key went to their place, not into the target")
        // The one rule now says the target (their own move, heard by the rule) — while the guardian's place is still U: the
        // key goes through, and that is work in it.
        destination = pid
        core.noteUserInteraction(type: .keyDown, flags: [], keycode: 0, location: nil, targetPid: Int64(pid))
        XCTAssertNotNil(reroute.handle(key), "let through into the target")
        XCTAssertTrue(core.userIsWorking(in: pid), "a key that reached the target is work in it")
        _ = reroute.end()
    }

    func testABurstInFlightStopsBeforeItsNextKeyOnceTheUserWorks() async throws {
        safari(fieldOwner: pid)
        var downs = 0
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            downs += 1
            if downs == 2 { sys.front = pid; core.testUserInput(pid: pid, switching: false) }  // they start working after two keys
        }
        do {
            _ = try await act(.type(CUTypeAction(text: "\t\tabcd")))  // keys (a tab: never an insert)
            XCTFail("refused")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("user_working"), e.message)
            XCTAssertTrue(e.message.hasPrefix("typed 2 of 6 characters"), e.message)
        }
        XCTAssertEqual(poster.keyDowns.count, 2, "nothing after they started working")
    }

    /// Round 17 (the review of round 16, H1 — proved there with a failing test): the agent's focusing click lands, the user's
    /// own click into the app lands right after it, and `typeText`'s accessibility insert still went into the field. The
    /// act's write guard stops it: nothing written after they started working.
    func testAnAccessibilityInsertIsNeverWrittenOnceTheUserWorksAfterTheFocusClick() async throws {
        safari(fieldOwner: pid, settableText: true)
        _ = searchHasFocus()
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseUp else { return }
            ax.focus(pid: pid, on: field)
            sys.front = pid
            core.testUserInput(pid: pid, switching: false)  // their click into the app, right after the agent's
        }
        do {
            try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
            XCTFail("refused")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("user_working"), e.message)
        }
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 1, "the agent's focusing click went (before)")
        XCTAssertFalse(ax.written.contains("\(token(field)):\(kAXSelectedTextAttribute)"), "no insert after they started: \(ax.written)")
        XCTAssertTrue(poster.keyDowns.isEmpty, "no key either")
    }

    /// Round 17 (the review of round 16, H1 — proved there with a failing test): AXPress does not focus the field, the user
    /// clicks into the app during the 400 ms web wait, and the caret-placing selection write put the focus back on the field
    /// (WebKit focuses the control it selects in). Never written now.
    func testTheCaretPlacingSelectionWriteIsNeverMadeOnceTheUserWorksDuringTheWait() async throws {
        safari(fieldOwner: pid)
        _ = searchHasFocus()
        ax.setActions(field, [kAXPressAction])
        ax.makeSettable(field, kAXSelectedTextRangeAttribute)
        ax.onPerform = { [unowned self] what in
            guard what == "\(token(field)):\(kAXPressAction)" else { return }
            sys.front = pid
            core.testUserInput(pid: pid, switching: false)  // their click during the wait (the press placed nothing)
        }
        do {
            try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
            XCTFail("refused")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("user_working"), e.message)
        }
        XCTAssertTrue(ax.performed.contains("\(token(field)):\(kAXPressAction)"), "the press went (before)")
        XCTAssertFalse(ax.written.contains("\(token(field)):\(kAXSelectedTextRangeAttribute)"), "no caret write after: \(ax.written)")
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseDown }.isEmpty, "no focusing click either")
        XCTAssertTrue(poster.keyDowns.isEmpty)
    }

    /// Round 17: the guard stops what STARTS something (a key down, a click) — the up of a down already sent still goes, so
    /// nothing is left held down in the app; a lone up for a down that never went is not sent.
    func testOnceStoppedAnUpGoesOnlyForADownThatWent() async throws {
        safari(fieldOwner: pid)
        var downs = 0
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            downs += 1
            if downs == 2 { sys.front = pid; core.testUserInput(pid: pid, switching: false) }  // between key 2's down and up
        }
        do {
            _ = try await act(.type(CUTypeAction(text: "\t\tabcd")))
            XCTFail("refused")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("user_working"), e.message)
        }
        XCTAssertEqual(poster.keyDowns.count, 2)
        XCTAssertEqual(poster.entries.filter { $0.type == .keyUp }.count, 2, "each down that went has its up")
    }

    func testSpaceIntoACheckBoxIsOnePressNeverTwo() async throws {
        safari(fieldOwner: pid)
        let cb = fakeElement(93_090)
        ax.add(cb, role: kAXCheckBoxRole, title: "Accept terms", frame: CGRect(x: 20, y: 120, width: 20, height: 20),
               extra: [kAXParentAttribute: ax.element(field, kAXParentAttribute)!, kAXValueAttribute: 0])
        ax.setActions(cb, [kAXPressAction])
        let r = try await act(.key(CUKeyAction(combo: "space", into: ref(cb))))
        XCTAssertEqual(ax.performed.filter { $0.hasSuffix(":AXPress") }.count, 1, "one press: \(ax.performed)")
        XCTAssertTrue(poster.keyDowns.isEmpty, "no key sent after it")
        XCTAssertTrue(r.detail?.contains("is that one press") ?? false, r.detail ?? "")
        // Return does not toggle a check box (natively it doesn't); a key that types is refused.
        for combo in ["return", "a"] {
            do {
                _ = try await act(.key(CUKeyAction(combo: combo, into: ref(cb))))
                XCTFail("\(combo): refused")
            } catch let e as CUError {
                XCTAssertTrue(e.message.contains(combo == "return" ? "Return does not toggle" : "would press it"), e.message)
            }
        }
        XCTAssertEqual(ax.performed.filter { $0.hasSuffix(":AXPress") }.count, 1, "still one press")
    }

    /// Round 14's live run (a regression of the one-press rule): End aimed INTO a web button scrolls the page as before —
    /// sent to where the focus is, never refused, and never after a focusing press of the button.
    func testANavigationKeyIntoAButtonGoesToTheFocusWithoutPressingIt() async throws {
        safari(fieldOwner: pid)
        let button = fakeElement(93_091)
        ax.add(button, role: kAXButtonRole, title: "Web Button", frame: CGRect(x: 20, y: 160, width: 120, height: 30),
               extra: [kAXParentAttribute: ax.element(field, kAXParentAttribute)!])
        ax.setActions(button, [kAXPressAction])
        _ = try await act(.key(CUKeyAction(combo: "end", into: ref(button))))
        XCTAssertTrue(ax.performed.filter { $0.hasSuffix(":AXPress") }.isEmpty, "the button never pressed: \(ax.performed)")
        XCTAssertTrue(poster.keyDowns.contains { $0.keycode == Int64(kVK_End) }, "End sent")
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseDown }.isEmpty, "no focusing click either")
    }

    /// Review of round 15, HIGH #2: only a NAVIGATION key aimed at a button goes to where the focus is; any other key
    /// would act on whatever has it (Delete deletes in the focused field, ⇧Return submits a form) — refused, nothing sent.
    func testANonNavigationKeyIntoAButtonIsRefused() async throws {
        safari(fieldOwner: pid)
        let button = fakeElement(93_092)
        ax.add(button, role: kAXButtonRole, title: "Remove", frame: CGRect(x: 20, y: 160, width: 120, height: 30),
               extra: [kAXParentAttribute: ax.element(field, kAXParentAttribute)!])
        ax.setActions(button, [kAXPressAction])
        for (combo, rep) in [("delete", 1), ("forwarddelete", 1), ("shift+return", 1), ("alt+left", 1), ("a", 1), ("return", 2), ("cmd+down", 1)] {
            do {
                _ = try await act(.key(CUKeyAction(combo: combo, into: ref(button), repeat: rep)))
                XCTFail("\(combo) ×\(rep): refused")
            } catch let e as CUError {
                XCTAssertTrue(e.message.contains("would press it"), "\(combo): \(e.message)")
            }
        }
        XCTAssertTrue(poster.keyDowns.isEmpty, "nothing sent")
        XCTAssertTrue(ax.performed.filter { $0.hasSuffix(":AXPress") }.isEmpty, "nothing pressed")
    }

    /// Round 16, P2 (the live "scroll by keys" failure in a WKWebView): End aimed at a button while the keyboard focus is
    /// OUTSIDE its page — the page gets the focus by a click on a blank spot of it (never the button's press), then End.
    func testANavigationKeyGivesThePageTheFocusByABlankSpotFirst() async throws {
        safari(fieldOwner: pid)
        let web = ax.element(field, kAXParentAttribute)!
        let button = fakeElement(93_093)
        ax.add(button, role: kAXButtonRole, title: "Web Button", frame: CGRect(x: 20, y: 160, width: 120, height: 30),
               extra: [kAXParentAttribute: web])
        ax.setActions(button, [kAXPressAction])
        ax.put(web, [kAXChildrenAttribute: [field, button]])
        _ = searchHasFocus()  // the focus outside the page (the browser's own field)
        let r = try await act(.key(CUKeyAction(combo: "end", into: ref(button))))
        let downs = poster.entries.filter { $0.type == .leftMouseDown }
        // (A click, and one more when the fake's focus never shows it landed — a real page takes the first.)
        XCTAssertFalse(downs.isEmpty, "a click to give the page the focus")
        for d in downs {
            XCTAssertFalse(CGRect(x: 20, y: 160, width: 120, height: 30).contains(d.location), "never on the button: \(d.location)")
            XCTAssertFalse(CGRect(x: 20, y: 60, width: 300, height: 24).contains(d.location), "nor on a field: \(d.location)")
        }
        XCTAssertTrue(ax.performed.filter { $0.hasSuffix(":AXPress") }.isEmpty, "the button never pressed: \(ax.performed)")
        // The fake page never shows the focus arriving (a background WKWebView did the same, run138): End is done to the
        // page over accessibility instead — its last element brought into view.
        XCTAssertTrue(r.detail?.contains("the page had no keyboard focus, so end was done over accessibility") ?? false, r.detail ?? "")
        XCTAssertTrue(ax.performed.contains("\(token(button)):AXScrollToVisible"), "\(ax.performed)")
        XCTAssertTrue(poster.keyDowns.isEmpty, "no key into whatever has the focus")
    }

    /// Review of round 13, MEDIUM #5: a paste the field took but shows otherwise (a formatting input, a rich target, a
    /// block editor) is done and said — never Uncertain; Markdown is looked for rendered too.
    func testAPasteTheFieldReformattedIsDoneAndSaid() async throws {
        safari(fieldOwner: pid)
        ax.put(field, [kAXValueAttribute: ""])
        poster.onPost = { [unowned self] e in
            if e.type == .keyDown, e.flags.contains(.maskCommand) { ax.put(field, [kAXValueAttribute: "(555) 123-4567"]) }
        }
        let r = try await act(.paste(CUPasteAction(text: "5551234567", into: ref(field))))
        XCTAssertTrue(r.detail?.contains("does not show the text exactly as sent") ?? false, r.detail ?? "")
        XCTAssertEqual(CUPasteSequence.rendered(text: "**Note:** see [the doc](https://example.org)", format: .markdown), "Note: see the doc")
        let ev = CUEditEvidence(readValue: { "Note: see the doc" }, nowMs: { 0 }, sleepMs: { _ in })
        XCTAssertTrue(ev.wait(before: "", expect: "**Note:** see [the doc](https://example.org)", also: "Note: see the doc", capMs: 0))
    }

    /// Review of round 14, LOW #4: a field that changed WITHOUT the pasted text (a counter, an autosave) proves nothing —
    /// Uncertain; the letters and digits of the pasted text decide.
    func testAFieldThatChangedWithoutThePasteIsUncertain() async throws {
        safari(fieldOwner: pid)
        ax.put(field, [kAXValueAttribute: "draft"])
        poster.onPost = { [unowned self] e in
            if e.type == .keyDown, e.flags.contains(.maskCommand) { ax.put(field, [kAXValueAttribute: "draft (saved)"]) }
        }
        do {
            _ = try await act(.paste(CUPasteAction(text: "the report is done", into: ref(field))))
            XCTFail("Uncertain")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["uncertain"], .bool(true), e.message)
        }
        XCTAssertTrue(CUCore.holdsPasted("(555) 123-4567", was: "", texts: ["5551234567"]), "a formatting input")
        XCTAssertTrue(CUCore.holdsPasted("Note: see the doc", was: "", texts: ["**Note:** see [the doc](x)", "Note: see the doc"]))
        XCTAssertFalse(CUCore.holdsPasted("draft (saved)", was: "draft", texts: ["the report is done"]))
    }

    /// Review of round 13, MEDIUM #4: the guards come before the scroll — a focus click refused (the app in front with
    /// another of its windows key) has scrolled nothing.
    func testARefusedFocusClickScrollsNothing() async throws {
        safari(fieldOwner: pid)
        _ = searchHasFocus()
        ax.put(field, [kAXFocusedAttribute: kCFBooleanFalse])
        var below = CGPoint(x: 20, y: 1400)
        ax.put(field, [kAXPositionAttribute: AXValueCreate(.cgPoint, &below)!])
        ax.refuses.insert("\(token(field)):\(kAXPressAction)")
        sys.front = pid
        let userWindow = fakeElement(93_098)
        ax.put(ax.application(pid), [kAXWindowsAttribute: [userWindow, window], kAXFocusedWindowAttribute: userWindow])
        do {
            _ = try await act(.type(CUTypeAction(text: "hi", into: ref(field))))
            XCTFail("refused")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("app_in_front"), e.message)
        }
        XCTAssertFalse(ax.performed.contains("\(token(field)):AXScrollToVisible"), "nothing scrolled: \(ax.performed)")
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseDown }.isEmpty)
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
        // Round 13's dogfood item 12: never a success — Uncertain (sent, not confirmed; never retried).
        do {
            _ = try await act(.paste(CUPasteAction(text: "hello")))
            XCTFail("a field that shows its text and not the paste is no success")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["uncertain"], .bool(true), e.message)
            XCTAssertTrue(e.message.contains("does not show the pasted text"), e.message)
        }
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.0, "no 1.5 s wait for a web editor")
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

    func testTypingWithNoIntoStopsWhenTheFocusLeavesTheField() async throws {
        safari(fieldOwner: pid)
        let search = searchHasFocus()
        ax.focus(pid: pid, on: field)
        var n = 0
        poster.onPost = { [unowned self] e in
            guard e.type == .keyUp else { return }
            n += 1
            if n == 2 { ax.focus(pid: pid, on: search) }
        }
        do {
            try await act(.type(CUTypeAction(text: "Hello")))
            XCTFail("typing went on into the search box")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("focus_moved"))
            XCTAssertTrue(e.message.hasPrefix("typed 2 of 5 characters"), e.message)
        }
        XCTAssertEqual(poster.keyDowns.count, 2)
    }

    func testAnEditorThatReReportsItsFocusedLeafIsStillTheSameField() async throws {
        // A web editor re-reports its focused leaf (a text run) as the caret moves: the same editable element.
        safari(fieldOwner: pid)
        let leaf = fakeElement(93_095)
        ax.add(leaf, role: kAXStaticTextRole, frame: CGRect(x: 22, y: 62, width: 40, height: 20),
               extra: ["AXEditableAncestor": field!, kAXParentAttribute: fakeElement(93_096)])
        ax.put(field, ["AXEditableAncestor": field!])
        var n = 0
        poster.onPost = { [unowned self] e in
            guard e.type == .keyUp else { return }
            n += 1
            if n == 2 { ax.focus(pid: pid, on: leaf) }
        }
        _ = try await act(.type(CUTypeAction(text: "Hello", into: ref(field))))
        XCTAssertEqual(poster.keyDowns.count, 5, "not stopped")
    }

    func testOnlyWhitespaceTypedIsUnverifiableNotNoneOfIt() async throws {
        safari(fieldOwner: pid)
        let r = try await act(.type(CUTypeAction(text: " ", into: ref(field))))
        XCTAssertTrue(r.detail?.contains("received: unverifiable (only whitespace") ?? false, r.detail ?? "")
    }

    func testAMenuCommandThatWouldActOnAnotherWindowIsNotPressed() async throws {
        safari(fieldOwner: pid)
        // The user's own window of the same app stays its main window: the bound one can't be made main.
        let users = fakeElement(93_097)
        ax.add(users, role: kAXWindowRole, title: "The user's page", frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: users)] = 88
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window, users], kAXMainWindowAttribute: users])
        let bar = fakeElement(93_098), fileItem = fakeElement(93_099), fileMenu = fakeElement(93_100), open = fakeElement(93_101)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        let appleItem = fakeElement(93_105)
        ax.add(appleItem, role: "AXMenuBarItem", title: "Apple")
        ax.put(bar, [kAXChildrenAttribute: [appleItem, fileItem]])
        ax.add(fileItem, role: "AXMenuBarItem", title: "File", extra: [kAXChildrenAttribute: [fileMenu]])
        ax.add(fileMenu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [open]])
        ax.add(open, role: kAXMenuItemRole, title: "Open Location…", extra: [kAXMenuItemCmdCharAttribute: "L", kAXMenuItemCmdModifiersAttribute: 0])
        ax.setActions(open, [kAXPressAction])
        ax.ignoresWrites = ["\(token(window)):AXMain"]
        do {
            let r = try await act(.key(CUKeyAction(combo: "cmd+l")))
            XCTFail("pressed on another window: \(r.detail ?? "") \(ax.performed) \(ax.written)")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
            XCTAssertTrue(e.message.contains("“Open Location…” acts on its main window, which is another of its windows (“The user's page”)"), e.message)
        }
        XCTAssertFalse(ax.performed.contains("\(token(open)):AXPress"), "nothing pressed")
        // Once the bound window is main, the command is pressed.
        ax.put(ax.application(pid), [kAXMainWindowAttribute: window])
        _ = try await act(.key(CUKeyAction(combo: "cmd+l")))
        XCTAssertTrue(ax.performed.contains("\(token(open)):AXPress"))
    }

    func testTypingNeverGoesIntoAnotherWindowsFocus() async throws {
        safari(fieldOwner: pid)
        let users = fakeElement(93_102), usersField = fakeElement(93_103)
        ax.add(users, role: kAXWindowRole, title: "The user's page", frame: CGRect(x: 0, y: 0, width: 800, height: 600),
               extra: [kAXChildrenAttribute: [usersField]])
        ax.windowIDs[AXIdentity(element: users)] = 88
        ax.add(usersField, role: kAXTextFieldRole, title: "Address", frame: CGRect(x: 10, y: 10, width: 300, height: 20),
               extra: [kAXWindowAttribute: users, kAXParentAttribute: users, kAXValueAttribute: "example.test"])
        ax.makeSettable(usersField, kAXSelectedTextAttribute)
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window, users], kAXFocusedWindowAttribute: users])
        ax.focus(pid: pid, on: usersField)  // the app's focus: the user's window
        ax.put(window, [kAXFocusedUIElementAttribute: AXUIElement?.none as Any])
        _ = try? await act(.type(CUTypeAction(text: "https://example.com")))
        XCTAssertFalse(ax.written.contains("\(token(usersField)):\(kAXSelectedTextAttribute)"), "never inserted into the user's window")
        XCTAssertEqual(ax.string(usersField, kAXValueAttribute), "example.test")
    }

    func testReturnInAFieldOutsideThePageThatLoadsNothingSaysSo() async throws {
        safari(fieldOwner: pid)
        let address = fakeElement(93_104), toolbar = fakeElement(93_106)
        ax.add(toolbar, role: kAXToolbarRole, frame: CGRect(x: 0, y: 0, width: 900, height: 40),
               extra: [kAXParentAttribute: window, kAXChildrenAttribute: [address]])
        ax.add(address, role: kAXTextFieldRole, title: "Address", frame: CGRect(x: 100, y: 10, width: 400, height: 20),
               extra: [kAXParentAttribute: toolbar, kAXWindowAttribute: window, kAXValueAttribute: "https://example.com"])
        let kids = ax.elements(window, kAXChildrenAttribute)
        ax.put(window, [kAXChildrenAttribute: [toolbar] + kids])
        ax.focus(pid: pid, on: address)
        let r = try await act(.key(CUKeyAction(combo: "return")))
        XCTAssertTrue(r.detail?.contains("the page did not change after Return") ?? false, r.detail ?? "")
        // A Return that loads a page says nothing of the kind (the page line says it changed).
        let web = ax.elements(window, kAXChildrenAttribute).first { ax.string($0, kAXRoleAttribute) == "AXWebArea" }!
        poster.onPost = { [unowned self] e in
            if e.type == .keyUp { ax.put(web, ["AXURL": URL(string: "https://example.com/")! as CFURL, kAXTitleAttribute: "Example"]) }
        }
        let loaded = try await act(.key(CUKeyAction(combo: "return")))
        XCTAssertFalse(loaded.detail?.contains("did not change") ?? false, loaded.detail ?? "")
        XCTAssertNotNil(loaded.pageNow)
        // A find bar's field (not in the toolbar): Return finds the next match — no load is watched for.
        poster.onPost = nil
        let findBar = fakeElement(93_107)
        ax.add(findBar, role: kAXTextFieldRole, subrole: "AXSearchField", title: "Find", frame: CGRect(x: 100, y: 50, width: 200, height: 20),
               extra: [kAXParentAttribute: window, kAXWindowAttribute: window, kAXValueAttribute: "fox"])
        ax.put(window, [kAXChildrenAttribute: [findBar] + ax.elements(window, kAXChildrenAttribute)])
        ax.focus(pid: pid, on: findBar)
        let found = try await act(.key(CUKeyAction(combo: "return")))
        XCTAssertFalse(found.detail?.contains("did not change") ?? false, found.detail ?? "")
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
        // The paste lands (⌘V): the field shows it — an unshown paste is Uncertain since round 13.
        poster.onPost = { [unowned self] e in
            if e.type == .keyDown, e.flags.contains(.maskCommand) { ax.put(field, [kAXValueAttribute: "one\ntwo"]) }
        }
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

    func testAnAlreadyFocusedFieldIsLeftAlone() throws {
        let f = nativeField()
        ax.focus(pid: pid, on: f)
        ax.onSet = { _ in XCTFail("no focus write when already focused") }
        ax.onPerform = { _ in XCTFail("no press when already focused") }
        XCTAssertTrue(try core.focusField(f, target))
        XCTAssertFalse(ax.written.contains { $0.hasSuffix(":\(kAXFocusedAttribute)") })
    }

    func testANativeFieldUsesPressFirstThenTheGuardedWriteRememberedPerApp() throws {
        let f = nativeField()  // no press actions → press route fails → the guarded write
        ax.onSet = { [unowned self] what in if what.hasSuffix(":\(kAXFocusedAttribute)") { sys.front = pid } }
        sys.windows[77]?.onScreen = false  // no on-screen click either
        _ = try core.focusField(f, target)  // the write may place it (the field reads focused) — but it activated the app
        XCTAssertEqual(sys.activated, [1], "the user's app put back at once")
        XCTAssertTrue(target.takeViewNotes().contains { $0.contains("Native activated itself — the user's app was put back") })
        XCTAssertTrue(core.appActivatesOnFocusWrite(target), "remembered")
        // A later native field of the same app skips the write entirely (press route only).
        let f2 = fakeElement(93_081)
        ax.add(f2, role: kAXTextFieldRole, title: "Plain2", frame: CGRect(x: 20, y: 90, width: 200, height: 24))
        ax.put(window, [kAXChildrenAttribute: [f2]])
        ax.focus(pid: pid, on: nil)
        ax.onSet = { _ in XCTFail("no AXFocused write for a remembered app") }
        _ = try core.focusField(f2, target)
    }

    func testAWebFieldIsPressedNotWritten() throws {
        safari(fieldOwner: pid)
        ax.focus(pid: pid, on: nil)
        ax.setActions(field, [kAXPressAction])
        ax.onPerform = { [unowned self] what in if what == "\(token(field)):AXPress" { ax.focus(pid: pid, on: field) } }
        ax.onSet = { _ in XCTFail("no AXFocused write on a web field") }
        XCTAssertTrue(try core.focusField(field, target))
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

    func testAWebFieldThatCannotBePressedIsNotWritten() throws {
        safari(fieldOwner: pid)
        ax.focus(pid: pid, on: nil)   // not focused, no press actions
        sys.windows[77]?.onScreen = false  // and no click: the private path is off for this target
        target = CUTarget(id: "t2", sessionId: "s", pid: pid, bundleId: "com.apple.Safari", appName: "Safari",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Docs", privatePath: false)
        core.registerForTesting(target, windowElement: window)
        ax.onSet = { _ in XCTFail("the write is forbidden for a web field") }
        XCTAssertFalse(try core.focusField(field, target))
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
