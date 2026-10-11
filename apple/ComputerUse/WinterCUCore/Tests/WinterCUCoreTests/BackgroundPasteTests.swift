import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// A paste into a web editor of an app in the background is the REAL paste — Edit › Paste in the focus blip,
/// else ⌘V while the window holds the key focus — never thousands of typed keys (live: a 3,000-character paste
/// into Google Docs typed for 29 s and was cancelled). Typing as keys goes at a batched pace and says how far it
/// got when stopped.
final class BackgroundPasteTests: XCTestCase {
    let pid: pid_t = 5757
    let window = fakeElement(97_001)
    let web = fakeElement(97_002)
    let doc = fakeElement(97_003)
    let userWindow = fakeElement(97_004)
    let pasteItem = fakeElement(97_014)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var pb: PasteAndQueueTests.FakePasteboard!
    var core: CUCore!
    var target: CUTarget!
    var installer: FakeKeyTapInstaller!

    override func setUp() {
        FocusSPI.reset()
        FocusSPI.frontPid = 1
        FocusSPI.onFocus = nil
    }

    override func tearDown() { FocusSPI.onFocus = nil }

    /// A browser in the background (the user's app, pid 1, in front) with a canvas-like web editor whose value
    /// reads as zero-width filler (it can't be read back), and an Edit menu whose Paste reads disabled.
    private func world(focused: Bool = true) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window], kAXFocusedWindowAttribute: window])
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 0, y: 0, width: 900, height: 700),
               extra: [kAXChildrenAttribute: [web]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(web, role: "AXWebArea", frame: CGRect(x: 0, y: 40, width: 900, height: 660),
               extra: [kAXChildrenAttribute: [doc], kAXWindowAttribute: window])
        ax.add(doc, role: kAXTextAreaRole, title: "Document", frame: CGRect(x: 40, y: 80, width: 800, height: 500),
               extra: [kAXValueAttribute: "\u{200B}\u{200B}", kAXParentAttribute: web, kAXWindowAttribute: window])
        if focused { ax.focus(pid: pid, on: doc) }
        ax.put(ax.application(1), [kAXFocusedWindowAttribute: userWindow])
        ax.windowIDs[AXIdentity(element: userWindow)] = 31
        let bar = fakeElement(97_010), apple = fakeElement(97_011), edit = fakeElement(97_012), menu = fakeElement(97_013)
        ax.put(app, [kAXMenuBarAttribute: bar])
        ax.put(bar, [kAXChildrenAttribute: [apple, edit]])
        ax.add(apple, role: "AXMenuBarItem", title: "Apple")
        ax.add(edit, role: "AXMenuBarItem", title: "Edit", extra: [kAXChildrenAttribute: [menu]])
        ax.add(menu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [pasteItem]])
        ax.add(pasteItem, role: kAXMenuItemRole, title: "Paste",
               extra: [kAXEnabledAttribute: false, kAXMenuItemCmdCharAttribute: "V", kAXMenuItemCmdModifiersAttribute: 0])
        ax.setActions(pasteItem, [kAXPressAction])

        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.example.browser"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 900, height: 700), owner: "Browser")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1
        poster = RecordingPoster()
        pb = PasteAndQueueTests.FakePasteboard([[NSPasteboard.PasteboardType.string.rawValue: Data("user's own".utf8)]])
        let shared = pb!
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: focusSkyLight(), poster: poster, ax: ax, sys: sys,
                      pasteboard: { shared }, startMonitors: false)
        core.pasteRestoreDelayMs = 50
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.browser", appName: "Browser",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        installer = FakeKeyTapInstaller()
        core.keyTapInstaller = installer
        core.blipSchedule = { _, _ in }
        core.keyReroutePost = { _, _ in }
    }

    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

    @discardableResult
    private func paste(_ text: String, foreground: Bool = false) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .paste(CUPasteAction(text: text, into: target.refs.ref(for: AXIdentity(element: doc)))),
            access: .full, allowForeground: foreground, privatePath: true))
    }

    private let long = String(repeating: "Lorem ipsum dolor sit amet.\n", count: 110)  // ~3,000 characters, multi-line

    func testALongPasteIntoABackgroundWebEditorIsTheRealPasteInTheBlip() async throws {
        world()
        var tapAtPress = false
        FocusSPI.onFocus = { [unowned self] in
            if FocusSPI.calls.last == "focus pid \(pid) window 77" { ax.put(pasteItem, [kAXEnabledAttribute: true]) }
        }
        ax.onPerform = { [unowned self] _ in tapAtPress = installer.isInstalled }
        let start = Date()
        let r = try await paste(long)
        XCTAssertLessThan(Date().timeIntervalSince(start), 2.0, "never thousands of keys")
        XCTAssertEqual(ax.performed, ["\(token(pasteItem)):AXPress"], "Edit › Paste, pressed")
        XCTAssertTrue(tapAtPress, "inside the blip, with the reroute on")
        XCTAssertTrue(poster.keyDowns.isEmpty, "no keys typed")
        XCTAssertEqual(installer.removed, installer.installed.count)
        XCTAssertTrue(r.detail?.contains("pasted through Browser's Edit › Paste") ?? false, r.detail ?? "")
        XCTAssertTrue(r.detail?.contains("unconfirmed") ?? false, "nothing to read it back by: \(r.detail ?? "")")
        XCTAssertEqual(sys.frontmostPid(), 1)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(pb.readString(), "user's own", "the clipboard restored")
    }

    func testPasteStillDisabledInTheBlipGoesAsCommandVWhileTheWindowHoldsTheKeyFocus() async throws {
        world()
        var during: [(key: Int64, flags: CGEventFlags, tap: Bool)] = []
        poster.onPost = { [unowned self] e in
            if e.type == .keyDown { during.append((e.keycode, e.flags, installer.isInstalled)) }
        }
        let r = try await paste(long)
        XCTAssertTrue(ax.performed.isEmpty)
        XCTAssertEqual(during.count, 1, "one ⌘V, not the text")
        XCTAssertEqual(during.first?.key, Int64(kVK_ANSI_V))
        XCTAssertTrue(during.first?.flags.contains(.maskCommand) ?? false)
        XCTAssertEqual(during.first?.tap, true, "inside the blip")
        XCTAssertEqual(poster.entries.first { $0.type == .keyDown }?.pid, pid, "to the app itself, which handles key equivalents")
        XCTAssertEqual(installer.installed.count, 1, "one blip, held while the page takes it")
        XCTAssertTrue(r.detail?.contains("pasted with ⌘V") ?? false, r.detail ?? "")
    }

    func testWithNoBlipALongPasteAsksForTheForegroundAndRestoresTheClipboard() async throws {
        world()
        installer.refuse = true
        do {
            try await paste(long)
            XCTFail("expected needs_foreground")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "needs_foreground")
            XCTAssertTrue(e.message.contains("characters are too many to type"), e.message)
        }
        XCTAssertTrue(poster.keyDowns.isEmpty, "nothing typed")
        XCTAssertEqual(pb.readString(), "user's own")
    }

    func testWithNoBlipAShortPasteIsTyped() async throws {
        world()
        installer.refuse = true
        let r = try await paste("short note")
        XCTAssertEqual(poster.keyDowns.map(\.unicode).joined(), "short note")
        XCTAssertTrue(r.detail?.contains("typed in") ?? false, r.detail ?? "")
    }

    func testWithTheForegroundAgreedThePasteIsCommandVInFront() async throws {
        world()
        let r = try await paste(long, foreground: true)
        XCTAssertEqual(sys.activated, [pid, 1], "forward for the paste, the front given back")
        XCTAssertEqual(poster.keyDowns.count, 1)
        XCTAssertEqual(poster.keyDowns.first?.keycode, Int64(kVK_ANSI_V))
        XCTAssertEqual(r.rung, 4)
    }

    // MARK: an editor that hides its text

    private func type(_ text: String) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .type(CUTypeAction(text: text, into: target.refs.ref(for: AXIdentity(element: doc)))),
            access: .full, allowForeground: false, privatePath: true))
    }

    func testTypingIntoAnEditorThatHidesItsTextSaysItCantBeReadBack() async throws {
        world()
        let r = try await type("hello")
        XCTAssertEqual(poster.keyDowns.map(\.unicode).joined(), "hello")
        XCTAssertTrue(r.detail?.contains("received: unverifiable — Browser doesn't expose this editor's text to accessibility, so it can't be read back here — check with something the app shows, such as its word count") ?? false,
                      r.detail ?? "")
    }

    func testSeveralLinesIntoAnEditorThatCantBeReadBackAreKeysWithReturnsNeverASilentPaste() async throws {
        world()
        let r = try await type("one\ntwo")
        XCTAssertTrue(ax.performed.isEmpty, "no Edit › Paste")
        XCTAssertFalse(poster.keyDowns.contains { $0.flags.contains(.maskCommand) }, "no ⌘V")
        XCTAssertEqual(poster.keyDowns.map(\.keycode).filter { $0 == Int64(kVK_Return) }.count, 1, "the newline is Return")
        XCTAssertEqual(poster.keyDowns.map(\.unicode).filter { !$0.isEmpty && $0.unicodeScalars.allSatisfy { $0.value >= 0x20 } }.joined(), "onetwo")
        XCTAssertTrue(r.detail?.contains("received: unverifiable") ?? false, r.detail ?? "")
    }

    func testALongLineIntoAnEditorThatCantBeReadBackIsAPasteThatSaysSo() async throws {
        world()
        let r = try await type(String(repeating: "word ", count: 50))  // 250 characters, one line
        XCTAssertTrue(r.detail?.hasPrefix("as a paste (more than 200 characters go as a paste; this field can't be read back)") ?? false, r.detail ?? "")
        XCTAssertTrue(r.detail?.contains("unconfirmed") ?? false, r.detail ?? "")
        XCTAssertFalse(r.detail?.contains("reads them back") ?? true, "never claims a read-back it can't do")
    }

    /// Review of round 4 (LOW): a long text with a Tab went as a paste — its tabs pasted as characters, while the
    /// protocol said a Tab moves the focus. Said truthfully in the result.
    func testALongTextWithTabsPastedSaysItsTabsWentInAsCharacters() async throws {
        world()
        let r = try await type(String(repeating: "cell\t", count: 50))  // 250 characters, one line
        XCTAssertTrue(r.detail?.hasPrefix("as a paste (") ?? false, r.detail ?? "")
        XCTAssertTrue(r.detail?.contains("its tabs went in as characters, moving no focus") ?? false, r.detail ?? "")
    }

    /// Another window of the app is its key window, with a File › Open Location… (⌘L) item.
    private func anotherWindowKey() -> AXUIElement {
        let other = fakeElement(97_020), file = fakeElement(97_021), fileMenu = fakeElement(97_022), open = fakeElement(97_023)
        ax.add(other, role: kAXWindowRole, title: "The user's page", frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: other)] = 88
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window, other], kAXFocusedWindowAttribute: other])
        let bar = ax.element(ax.application(pid), kAXMenuBarAttribute)!
        ax.put(bar, [kAXChildrenAttribute: ax.elements(bar, kAXChildrenAttribute) + [file]])
        ax.add(file, role: "AXMenuBarItem", title: "File", extra: [kAXChildrenAttribute: [fileMenu]])
        ax.add(fileMenu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [open]])
        ax.add(open, role: kAXMenuItemRole, title: "Open Location…", extra: [kAXMenuItemCmdCharAttribute: "L", kAXMenuItemCmdModifiersAttribute: 0])
        ax.setActions(open, [kAXPressAction])
        return open
    }

    private func key(_ combo: String) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: .key(CUKeyAction(combo: combo)),
                                                 access: .full, allowForeground: false, privatePath: true))
    }

    func testAMenuShortcutWhileAnotherWindowIsKeyIsPressedOnlyWithTheBoundWindowKey() async throws {
        world()
        let open = anotherWindowKey()
        var keyAtPress = false
        ax.onPerform = { what in if what == "\(self.token(open)):AXPress" { keyAtPress = FocusSPI.calls.last == "focus pid \(self.pid) window 77" } }
        let r = try await key("cmd+l")
        XCTAssertTrue(ax.performed.contains("\(token(open)):AXPress"))
        XCTAssertTrue(keyAtPress, "pressed inside the focus blip, the bound window key — \(FocusSPI.calls)")
        XCTAssertTrue(r.detail?.contains("with Browser's bound window key for a moment") ?? false, r.detail ?? "")
        XCTAssertTrue(poster.keyDowns.isEmpty, "never sent as keys, which would reach the other window")
    }

    func testAMenuShortcutWhileAnotherWindowIsKeyAndNoBlipIsRefused() async throws {
        world()
        let open = anotherWindowKey()
        installer.refuse = true  // no focus blip possible
        do {
            _ = try await key("cmd+l")
            XCTFail("acted on another window")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
            XCTAssertTrue(e.message.contains("acts on its key window, which is another of its windows"), e.message)
        }
        XCTAssertFalse(ax.performed.contains("\(token(open)):AXPress"))
        XCTAssertTrue(poster.keyDowns.isEmpty)
    }

    func testAKeyboardBlipHoldsTheWindowKeyUntilTheAppHasTakenItsKeys() throws {
        world()
        core.blipDrainMs = 60
        let p = TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: .key(CUKeyAction(combo: "return")),
                                access: .full, allowForeground: false, privatePath: true)
        let blips = CUKeyBlips(core, p, target, why: "keys")
        try blips.before()
        XCTAssertTrue(installer.isInstalled, "a blip began")
        let start = Date()
        blips.end()
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(start), 0.055, "held key while the app takes its queued keys")
        XCTAssertFalse(installer.isInstalled, "then ended")
        let none = Date()
        blips.end()
        XCTAssertLessThan(Date().timeIntervalSince(none), 0.02, "no blip: nothing to drain")
    }

    func testAnInputTargetThatChangedSaysTheKeysArrived() async throws {
        world()
        poster.onPost = { [unowned self] e in if e.type == .keyUp { ax.put(doc, [kAXValueAttribute: "\u{200B}\u{200B}\u{200B}"]) } }
        let r = try await type("hi")
        XCTAssertTrue(r.detail?.contains("(its input target changed, so keys arrived)") ?? false, r.detail ?? "")
    }

    // MARK: where the input went

    func testTheResultNamesTheElementThatReceivedTheInput() async throws {
        world()
        let r = try await type("hello")
        let ref = target.refs.ref(for: AXIdentity(element: doc))
        XCTAssertEqual(r.input, "[\(ref)] text area \"Document\"")
        XCTAssertNil(r.inputUnknown)
        let set = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .setValue(CUSetValueAction(ref: ref, value: "x")), access: .full, allowForeground: false, privatePath: true))
        XCTAssertEqual(set.input, "[\(ref)] text area \"Document\"")
    }

    func testKeysWithNoFocusedElementSaySoInTheResult() async throws {
        world(focused: false)
        let r = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .key(CUKeyAction(combo: "end")), access: .full, allowForeground: false, privatePath: true))
        XCTAssertNil(r.input)
        XCTAssertEqual(r.inputUnknown, true)
    }

    func testAMenuShortcutNamesNoElement() async throws {
        world()
        ax.put(pasteItem, [kAXEnabledAttribute: true, kAXMenuItemCmdCharAttribute: "T"])
        ax.put(doc, [kAXRoleAttribute: kAXButtonRole])  // not an editable focus: the chord goes to its menu item
        let r = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .key(CUKeyAction(combo: "cmd+t")), access: .full, allowForeground: false, privatePath: true))
        XCTAssertNil(r.input)
        XCTAssertNil(r.inputUnknown)
        XCTAssertTrue(r.detail?.contains("used the menu item") ?? false, r.detail ?? "")
    }

    // MARK: typing pace and progress

    func testTypingGoesInBatchesWithNoSettlePerKey() throws {
        let poster = RecordingPoster()
        var synth = CUEventSynth(poster: poster, skyLight: .none)
        var sleeps: [Double] = []
        synth.sleep = { sleeps.append($0) }
        synth.stroke = { CUKeyboardLayout.ansiStroke(for: $0) }
        var progress: [Int] = []
        try synth.type(pid: 1, text: String(repeating: "a", count: 100), route: .publicPid, between: {}, posted: { progress.append($0) })
        XCTAssertEqual(poster.keyDowns.count, 100)
        XCTAssertEqual(sleeps.count, 100 / CUEventSynth.keyBatch, "one short yield per batch, none per key")
        XCTAssertTrue(sleeps.allSatisfy { $0 == CUEventSynth.batchYieldMs })
        XCTAssertLessThanOrEqual(sleeps.reduce(0, +), 40, "≤ 0.4 ms of waiting per character")
        XCTAssertEqual(progress.last, 100)
        XCTAssertEqual(progress.count, 100, "told after every key")
    }

    func testAStoppedTypeSaysHowManyCharactersWentOut() {
        world()
        XCTAssertThrowsError(try core.typingProgress(3000, sent: { 1200 }, target) { () throws -> Int in throw CUError.cancelled }) { err in
            let e = err as? CUError
            XCTAssertEqual(e?.code, "cancelled")
            XCTAssertEqual(e?.message, "cancelled", "a cancel's words are the daemon's")
            XCTAssertEqual(e?.data?["typed"], .number(1200))
            XCTAssertEqual(e?.data?["total"], .number(3000))
        }
        XCTAssertThrowsError(try core.typingProgress(10, sent: { 4 }, target) { () throws -> Int in throw CUError.unsupported("the field went away") }) { err in
            XCTAssertEqual((err as? CUError)?.message, "the field went away — 4 of 10 characters had been typed before this")
        }
        XCTAssertThrowsError(try core.typingProgress(10, sent: { 0 }, target) { () throws -> Int in throw CUError.cancelled }) { err in
            XCTAssertNil((err as? CUError)?.data?["typed"], "nothing typed: nothing to say")
        }
    }
}
