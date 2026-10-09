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

    func testAFocusWriteThatActivatesTheAppIsPutBackAtOnceAndSaid() async throws {
        safari(fieldOwner: pid)
        ax.onSet = { [unowned self] what in if what.hasSuffix(":\(kAXFocusedAttribute)") { sys.front = pid } }
        let r = try await act(.type(CUTypeAction(text: "ab", into: ref(field))))
        XCTAssertEqual(sys.activated, [1])
        XCTAssertTrue(r.detail?.contains("Safari activated itself — the user's app was put back") ?? false, r.detail ?? "")
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
