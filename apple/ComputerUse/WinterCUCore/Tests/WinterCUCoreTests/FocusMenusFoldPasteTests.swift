import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// What the private focus SPIs were asked to do, in order (a C function pointer can't capture, so it records
/// here). PSNs carry the pid in their low four bytes.
enum FocusSPI {
    nonisolated(unsafe) static var calls: [String] = []
    nonisolated(unsafe) static var frontPid: pid_t = 1
    /// Runs after each focus record (not a defocus), to change the fake world as an app might react.
    nonisolated(unsafe) static var onFocus: (() -> Void)?
    /// The make-key records (synthesized mouse down/up, type 1/2), apart from the focus records: "down pid 5252
    /// window 77", "up pid 5252 window 77". `order` interleaves both kinds, with the enforcer's deactivations.
    nonisolated(unsafe) static var makeKey: [String] = []
    nonisolated(unsafe) static var order: [String] = []
    static func pid(_ psn: UnsafeRawPointer) -> pid_t { pid_t(psn.load(fromByteOffset: 4, as: UInt32.self)) }
    static func reset() {
        calls = []
        makeKey = []
        order = []
    }
}

private let fakePostRecord: CUSkyLight.PostEventRecordTo = { psn, bytes in
    let wid = UInt32(bytes[0x3C]) | UInt32(bytes[0x3D]) << 8 | UInt32(bytes[0x3E]) << 16 | UInt32(bytes[0x3F]) << 24
    guard bytes[0x08] == 0x0D else {
        let entry = "\(bytes[0x08] == 0x01 ? "down" : "up") pid \(FocusSPI.pid(psn)) window \(wid)"
        FocusSPI.makeKey.append(entry)
        FocusSPI.order.append(entry)
        return 0
    }
    let entry = "\(bytes[0x8A] == 1 ? "focus" : "defocus") pid \(FocusSPI.pid(psn)) window \(wid)"
    FocusSPI.calls.append(entry)
    FocusSPI.order.append(entry)
    if bytes[0x8A] == 1 { FocusSPI.onFocus?() }
    return 0
}
private let fakeGetFront: CUSkyLight.GetFrontProcess = { buf in
    buf.storeBytes(of: UInt32(0), toByteOffset: 0, as: UInt32.self)
    buf.storeBytes(of: UInt32(FocusSPI.frontPid), toByteOffset: 4, as: UInt32.self)
    return 0
}
private let fakeProcessForPid: CUSkyLight.GetProcessForPID = { pid, buf in
    buf.storeBytes(of: UInt32(0), toByteOffset: 0, as: UInt32.self)
    buf.storeBytes(of: UInt32(pid), toByteOffset: 4, as: UInt32.self)
    return 0
}

/// SkyLight with only the focus SPIs, recording into `FocusSPI`.
func focusSkyLight() -> CUSkyLight {
    CUSkyLight.resolve { name in
        switch name {
        case "SLPSPostEventRecordTo": return unsafeBitCast(fakePostRecord, to: UnsafeMutableRawPointer.self)
        case "_SLPSGetFrontProcess": return unsafeBitCast(fakeGetFront, to: UnsafeMutableRawPointer.self)
        case "GetProcessForPID": return unsafeBitCast(fakeProcessForPid, to: UnsafeMutableRawPointer.self)
        default: return nil
        }
    }
}

/// The four follow-ups to the Finder live run: the bound window made key in the background for menus,
/// shortcuts and keys; open menus shown first; out-of-view content folded first; unconfirmable pastes that
/// return at once and restore the clipboard later.
final class FocusMenusFoldPasteTests: XCTestCase {
    let pid: pid_t = 5252
    let window = fakeElement(98_001)
    let field = fakeElement(98_002)
    let userWindow = fakeElement(98_003)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var pb: PasteAndQueueTests.FakePasteboard!
    var core: CUCore!
    var target: CUTarget!
    var trash: AXUIElement!
    var installer: FakeKeyTapInstaller!
    /// Where the reroute posted the user's keys, and the blip deadlines scheduled (delay, work).
    var posted: [pid_t] = []
    var scheduled: [(ms: Double, work: () -> Void)] = []

    override func setUp() {
        FocusSPI.reset()
        FocusSPI.frontPid = 1
        FocusSPI.onFocus = nil
    }

    /// Finder (pid 5252) in the background behind the user's app (pid 1, its key window 31); a File menu with
    /// Move to Trash, enabled or not.
    private func finder(trashEnabled: Bool = true, focusedField: Bool = false) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window]])
        ax.add(window, role: kAXWindowRole, title: "Downloads", frame: CGRect(x: 100, y: 100, width: 900, height: 500),
               extra: [kAXChildrenAttribute: [field]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.makeSettable(window, kAXMainAttribute)
        ax.add(field, role: kAXTextFieldRole, frame: CGRect(x: 120, y: 120, width: 200, height: 24),
               extra: [kAXWindowAttribute: window])
        if focusedField { ax.focus(pid: pid, on: field) }
        ax.put(ax.application(1), [kAXFocusedWindowAttribute: userWindow])
        ax.windowIDs[AXIdentity(element: userWindow)] = 31

        let bar = fakeElement(98_010), apple = fakeElement(98_011), file = fakeElement(98_012), fileMenu = fakeElement(98_013)
        trash = fakeElement(98_014)
        ax.put(app, [kAXMenuBarAttribute: bar])
        ax.put(bar, [kAXChildrenAttribute: [apple, file]])
        ax.add(apple, role: "AXMenuBarItem", title: "Apple")
        ax.add(file, role: "AXMenuBarItem", title: "File", extra: [kAXChildrenAttribute: [fileMenu]])
        ax.add(fileMenu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [trash!]])
        ax.add(trash, role: kAXMenuItemRole, title: "Move to Trash",
               extra: [kAXEnabledAttribute: trashEnabled, kAXMenuItemCmdCharAttribute: "", kAXMenuItemCmdVirtualKeyAttribute: 0x33,
                       kAXMenuItemCmdModifiersAttribute: 0])
        ax.setActions(trash, [kAXPressAction])

        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.apple.finder"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 900, height: 500), owner: "Finder")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1

        poster = RecordingPoster()
        let clip = PasteAndQueueTests.FakePasteboard([[NSPasteboard.PasteboardType.string.rawValue: Data("user's own".utf8)]])
        pb = clip
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: focusSkyLight(), poster: poster, ax: ax, sys: sys,
                      pasteboard: { clip }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.apple.finder", appName: "Finder",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Downloads")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        installer = FakeKeyTapInstaller()
        core.keyTapInstaller = installer
        posted = []
        scheduled = []
        core.keyReroutePost = { [unowned self] _, pid in posted.append(pid) }
        core.blipSchedule = { [unowned self] ms, work in scheduled.append((ms, work)) }
    }

    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

    /// The user's ⌘-Tab, as the session tap sees it: ⌘ down and up (the switcher swallows the Tab).
    private func usersSwitch() {
        core.switchInputObservableOverride = true
        let now = core.clock.nowSeconds()
        core.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: .maskCommand, now: now)
        core.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: [], now: now)
    }

    @discardableResult
    private func act(_ a: CUAction, privatePath: Bool = true, foreground: Bool = false) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: foreground, privatePath: privatePath))
    }

    // MARK: 1. focus without raise

    func testAnEnabledMenuCommandTakesNoFocusBlip() async throws {
        finder()
        let r = try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
        XCTAssertEqual(ax.performed, ["\(token(trash)):AXPress"])
        XCTAssertTrue(FocusSPI.calls.isEmpty, "no focus records: the command already reads enabled")
        XCTAssertTrue(installer.installed.isEmpty, "no reroute tap")
        XCTAssertNil(r.detail)
    }

    func testADisabledCommandIsReValidatedInTheFocusBlipWithTheRerouteOnAndEverythingGivenBack() async throws {
        finder(trashEnabled: false)
        XCTAssertEqual(sys.frontmostPid(), 1)
        var tapAtFocus = false
        FocusSPI.onFocus = { [unowned self] in
            guard FocusSPI.calls.last == "focus pid \(pid) window 77" else { return }
            tapAtFocus = installer.isInstalled
            ax.put(trash, [kAXEnabledAttribute: true])  // the app re-validates once its window holds the key focus
        }
        var during: [String] = []
        var tapAtPress = false
        ax.onPerform = { [unowned self] _ in during = FocusSPI.calls; tapAtPress = installer.isInstalled }
        let r = try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
        XCTAssertTrue(tapAtFocus, "the reroute tap is installed BEFORE the focus records")
        XCTAssertEqual(installer.installed, [pid], "a tap on the target")
        XCTAssertEqual(during, ["defocus pid 1 window 77", "focus pid 5252 window 77"], "pressed inside the blip")
        XCTAssertTrue(tapAtPress)
        XCTAssertEqual(Array(FocusSPI.calls.dropFirst(2)), ["defocus pid 5252 window 77", "focus pid 1 window 31"],
                       "the user's key window handed back")
        XCTAssertEqual(installer.removed, 1, "the tap removed once the user's app is back")
        XCTAssertFalse(FocusSPI.calls.contains { $0.hasPrefix("front ") }, "never the front process: that switches Spaces")
        XCTAssertEqual(ax.performed, ["\(token(trash)):AXPress"])
        XCTAssertEqual(sys.frontmostPid(), 1, "the user's app stayed frontmost")
        XCTAssertTrue(sys.activated.isEmpty, "nothing was activated")
        XCTAssertEqual(scheduled.count, 1, "one hard deadline")
        XCTAssertTrue(scheduled.allSatisfy { $0.ms <= 250 && $0.ms > 200 }, "250 ms from the tap's install: \(scheduled.map(\.ms))")
        XCTAssertEqual(r.detail, "Finder's window was made key for a moment to re-validate the command (your app kept the front)")
    }

    func testABlipWhoseFirstHandBackIsLostHandsItBackAgainBeforeCallingItATheft() async throws {
        finder(trashEnabled: false)
        FocusSPI.onFocus = { [unowned self] in
            if FocusSPI.calls.last == "focus pid \(pid) window 77" { ax.put(trash, [kAXEnabledAttribute: true]) }
        }
        // The window server keeps the keys with the target until the user's window is focused a SECOND time.
        core.keyFocusPidOverride = { [unowned self] in
            FocusSPI.calls.filter { $0 == "focus pid 1 window 31" }.count >= 2 ? 1 : pid
        }
        try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
        XCTAssertEqual(FocusSPI.calls.filter { $0 == "focus pid 1 window 31" }.count, 2, "handed back twice")
        XCTAssertTrue(sys.activated.isEmpty, "no guardian restore: it was back")
        XCTAssertEqual(installer.removed, 1)
    }

    func testTheBlipEndsOnAnErrorWithTheTapRemoved() async throws {
        finder(trashEnabled: false)
        FocusSPI.onFocus = { [unowned self] in ax.put(trash, [kAXEnabledAttribute: true]) }
        ax.refuses = ["\(token(trash)):AXPress"]  // the press fails
        do {
            try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
            XCTFail("the press failed")
        } catch is CUError {}
        XCTAssertEqual(installer.installed.count, 1)
        XCTAssertEqual(installer.removed, 1, "removed on the error path too")
        XCTAssertEqual(Array(FocusSPI.calls.suffix(2)), ["defocus pid 5252 window 77", "focus pid 1 window 31"], "handed back")
    }

    func testTheDeadlineEndsTheBlipAndRemovesTheTapWhateverTheActIsDoing() async throws {
        finder(trashEnabled: false)
        var removedAtDeadline: Int?
        ax.onRead = { [unowned self] what in
            // The deadline passes while the act is still reading the command.
            guard what == "\(token(trash)):\(kAXEnabledAttribute)", let deadline = scheduled.first, removedAtDeadline == nil else { return }
            deadline.work()
            removedAtDeadline = installer.removed
        }
        do {
            try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
            XCTFail("still disabled")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported", e.message)
        }
        XCTAssertEqual(removedAtDeadline, 1, "the deadline removed the tap at once")
        XCTAssertEqual(Array(FocusSPI.calls.prefix(4)), ["defocus pid 1 window 77", "focus pid 5252 window 77",
                                                         "defocus pid 5252 window 77", "focus pid 1 window 31"],
                       "and handed the key focus back")
        XCTAssertEqual(installer.removed, installer.installed.count, "every tap removed, none twice")
        XCTAssertTrue(scheduled.allSatisfy { $0.ms <= 250 }, "a hard deadline of at most 250 ms")
        XCTAssertEqual(installer.installed.count, 2, "the one retry, in a fresh blip")
    }

    func testTheUsersKeysDuringTheBlipGoToTheirAppAndTheHelpersPass() async throws {
        finder(trashEnabled: false)
        var verdicts: [Bool] = []
        FocusSPI.onFocus = { [unowned self] in
            guard FocusSPI.calls.last == "focus pid \(pid) window 77", let tap = installer.handler else { return }
            verdicts.append(tap(keyEvent(stamped: false)) == nil)        // the user's key: dropped from the target
            verdicts.append(tap(keyEvent(down: false, stamped: false)) == nil)
            verdicts.append(tap(keyEvent(stamped: true)) != nil)         // the helper's own: passes
            ax.put(trash, [kAXEnabledAttribute: true])
        }
        try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
        XCTAssertEqual(verdicts, [true, true, true])
        XCTAssertEqual(posted, [1, 1], "the user's key down and up went to their app (pid 1), never the target")
        XCTAssertEqual(installer.removed, 1)
    }

    func testTheRerouteCountsWhatItReroutedAndIsRemovedOnce() {
        let tap = FakeKeyTapInstaller()
        var sent: [pid_t] = []
        let reroute = CUKeyReroute(target: 5252, victim: 1, installer: tap, post: { _, pid in sent.append(pid) })
        XCTAssertTrue(reroute.begin())
        XCTAssertEqual(tap.installed, [5252], "on the target")
        let own = keyEvent(stamped: true)
        XCTAssertTrue(reroute.handle(own) === own, "the helper's own key passes unchanged")
        XCTAssertNil(reroute.handle(keyEvent(stamped: false)), "the user's key never reaches the target")
        XCTAssertEqual(sent, [1], "it went to the user's app")
        XCTAssertEqual(reroute.end(), 1, "one rerouted")
        XCTAssertEqual(reroute.end(), 1)
        XCTAssertEqual(tap.removed, 1, "removed once")
        XCTAssertFalse(reroute.isInstalled)
        tap.refuse = true
        XCTAssertFalse(CUKeyReroute(target: 5252, victim: 1, installer: tap, post: { _, _ in }).begin(), "no tap, no reroute")
    }

    func testWithNoRerouteTapThereIsNoBlip() async throws {
        finder(trashEnabled: false)
        installer.refuse = true
        do {
            try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
            XCTFail("disabled")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported", e.message)
        }
        XCTAssertTrue(FocusSPI.calls.isEmpty, "never the focus records without the reroute")
    }

    func testIfTheBlipDidNotHandTheFrontBackTheGuardianRestoresIt() async throws {
        finder(trashEnabled: false)
        FocusSPI.onFocus = { [unowned self] in ax.put(trash, [kAXEnabledAttribute: true]) }
        ax.onPerform = { [unowned self] _ in sys.front = pid }  // the press brings Finder forward
        _ = try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
        XCTAssertEqual(sys.activated.first, 1, "the user's app restored by the blip's end")
        XCTAssertEqual(sys.frontmostPid(), 1)
        XCTAssertEqual(installer.removed, 1)
    }

    func testADisabledMenuShortcutIsReValidatedInTheBlipAndPressed() async throws {
        finder(trashEnabled: false)
        ax.put(trash, [kAXMenuItemCmdCharAttribute: "T", kAXMenuItemCmdModifiersAttribute: 0])
        FocusSPI.onFocus = { [unowned self] in ax.put(trash, [kAXEnabledAttribute: true]) }
        let r = try await act(.key(CUKeyAction(combo: "cmd+t")))
        XCTAssertEqual(ax.performed, ["\(token(trash)):AXPress"], "the menu item, pressed")
        XCTAssertTrue(poster.keyDowns.isEmpty, "no keys")
        XCTAssertEqual(installer.installed, [pid])
        XCTAssertEqual(installer.removed, 1)
        XCTAssertTrue(r.detail?.contains("re-validated with Finder's window key for a moment") ?? false, r.detail ?? "")
    }

    func testADisabledMenuShortcutThatStaysDisabledGoesAsKeys() async throws {
        finder(trashEnabled: false)
        ax.put(trash, [kAXMenuItemCmdCharAttribute: "T", kAXMenuItemCmdModifiersAttribute: 0])
        try await act(.key(CUKeyAction(combo: "cmd+t")))
        XCTAssertTrue(ax.performed.isEmpty)
        XCTAssertEqual(poster.keyDowns.last?.keycode, Int64(CUKeyCodes.code(for: "t")!), "the keys, as before")
        XCTAssertEqual(installer.installed.count, 3, "the blip and its one retry, then the keys' own burst")
        XCTAssertEqual(installer.removed, 3)
    }

    func testIfTheTargetActivatesItselfTheUsersAppGetsTheFrontBack() async throws {
        finder()
        ax.onPerform = { [unowned self] _ in sys.front = pid }  // Finder brings itself forward
        let r = try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
        XCTAssertEqual(sys.activated, [1], "the user's app re-activated at once")
        XCTAssertEqual(sys.frontmostPid(), 1)
        XCTAssertTrue(r.detail?.hasSuffix("Finder activated itself — the user's app was put back") ?? false, r.detail ?? "")
    }

    func testADisabledCommandPointsAtTheUIRoutesFirstAndOnlyThenAsksForTheForeground() async throws {
        finder(trashEnabled: false)
        do {
            try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
            XCTFail("expected the UI routes")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported", "no foreground card yet")
            XCTAssertTrue(e.message.contains("“Move to Trash” is disabled while Finder is in the background"), e.message)
            XCTAssertTrue(e.message.contains("its context menu (action(ref, \"showMenu\") on the selected item"), e.message)
            XCTAssertTrue(e.message.contains("the window's toolbar or Action menu"), e.message)
            XCTAssertTrue(e.message.contains("key(\"cmd+delete\")"), "the item's own shortcut: \(e.message)")
            XCTAssertTrue(e.message.contains("Only if those are disabled too, call menu() again"), e.message)
        }
        // Asked again (the UI routes were disabled too): now the consented foreground card.
        do {
            try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
            XCTFail("expected needs_foreground")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "needs_foreground")
            XCTAssertTrue(e.message.contains("stays disabled while Finder is in the background, even with its window made key"), e.message)
        }
        XCTAssertTrue(ax.performed.isEmpty)
        XCTAssertEqual(sys.frontmostPid(), 1)
        XCTAssertFalse(FocusSPI.calls.contains { $0.hasPrefix("front ") })
        // With the user's consent (the daemon retries with allowForeground) Finder comes forward, then gives it back.
        do {
            try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])), foreground: true)
            XCTFail("still disabled")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
            XCTAssertTrue(e.message.contains("even with Finder in front — nothing it applies to is selected"), e.message)
        }
        XCTAssertEqual(sys.activated, [pid, 1], "forward for the command, the front given back")
    }

    func testTheContextMenuRouteWorksEndToEnd() async throws {
        finder(trashEnabled: false)
        let app = ax.application(pid)
        let icon = fakeElement(98_030), menu = fakeElement(98_031), item = fakeElement(98_032)
        ax.put(window, [kAXChildrenAttribute: [field, icon]])
        ax.add(icon, role: kAXImageRole, title: "report.pdf", frame: CGRect(x: 400, y: 300, width: 64, height: 64),
               extra: [kAXSelectedAttribute: true])
        ax.setActions(icon, [kAXShowMenuAction])
        ax.add(menu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [item]])
        ax.add(item, role: kAXMenuItemRole, title: "Move to Trash", extra: [kAXEnabledAttribute: true])
        ax.setActions(item, [kAXPressAction])
        // The context menu opens under the application element, as AppKit puts it.
        ax.onPerform = { [unowned self] what in
            if what == "\(token(icon)):AXShowMenu" { ax.put(app, [kAXChildrenAttribute: [window, menu]]) }
        }
        // (State is read by the live tree reader; here the same pieces are driven directly.)
        let iconRef = target.refs.ref(for: AXIdentity(element: icon))
        XCTAssertTrue(CUCore.openMenus(app: app, boundWindow: window, ax: ax).isEmpty)
        let shown = try await act(.action(CUAXAction(ref: iconRef, name: "showMenu")))
        XCTAssertEqual(shown.rung, 1)
        // What state() puts first: the menus open under the application, with the item in them.
        let open = CUCore.openMenus(app: app, boundWindow: window, ax: ax)
        XCTAssertEqual(open.map { token($0) }, [token(menu)])
        let found = try XCTUnwrap(open.flatMap { ax.elements($0, kAXChildrenAttribute) }
            .first { ax.string($0, kAXTitleAttribute) == "Move to Trash" && ax.bool($0, kAXEnabledAttribute) == true })
        let itemRef = target.refs.ref(for: AXIdentity(element: found))
        let r = try await act(.click(CUClickAction(ref: itemRef)))
        XCTAssertEqual(r.rung, 1)
        XCTAssertEqual(ax.performed, ["\(token(icon)):AXShowMenu", "\(token(item)):AXPress"], "the item's own menu, by AX")
        XCTAssertTrue(sys.activated.isEmpty)
        XCTAssertFalse(FocusSPI.calls.contains { $0.hasPrefix("front ") })
    }

    func testWithThePrivatePathOffNothingPrivateIsCalled() async throws {
        finder()
        try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])), privatePath: false)
        XCTAssertTrue(FocusSPI.calls.isEmpty)
        XCTAssertEqual(ax.performed, ["\(token(trash)):AXPress"])
    }

    func testClicksTakeNoFocusBlip() async throws {
        finder(focusedField: true)
        try await act(.click(CUClickAction(ref: target.refs.ref(for: AXIdentity(element: field)))))
        XCTAssertTrue(FocusSPI.calls.isEmpty, "never the focus records for a click")
        XCTAssertTrue(installer.installed.isEmpty)
    }

    func testTypingIntoAWindowWithoutTheKeyFocusTakesOneBlipWithTheRerouteOn() async throws {
        finder(focusedField: true)
        var atFirstKey: (records: [String], tap: Bool)?
        poster.onPost = { [unowned self] e in
            if atFirstKey == nil, e.type == .keyDown { atFirstKey = (FocusSPI.calls, installer.isInstalled) }
        }
        try await act(.type(CUTypeAction(text: "ab")))
        XCTAssertEqual(atFirstKey?.records, ["defocus pid 1 window 77", "focus pid 5252 window 77"], "the window made key before the first key")
        XCTAssertEqual(atFirstKey?.tap, true, "with the reroute on")
        XCTAssertEqual(poster.keyDowns.map(\.unicode), ["a", "b"])
        XCTAssertEqual(installer.installed, [pid], "one blip for the burst")
        XCTAssertEqual(installer.removed, 1)
        XCTAssertEqual(Array(FocusSPI.calls.suffix(2)), ["defocus pid 5252 window 77", "focus pid 1 window 31"], "handed back")
        XCTAssertTrue(scheduled.allSatisfy { $0.ms <= 1_500 }, "the hard bound of a keyboard blip")
        XCTAssertFalse(FocusSPI.calls.contains { $0.hasPrefix("front ") })
        XCTAssertEqual(sys.frontmostPid(), 1)
        XCTAssertTrue(sys.activated.isEmpty)
    }

    /// Review of round 2 (MEDIUM): the records went out on every blip. A window already its app's key window (the
    /// app's focused element is in it) gets none.
    func testABlipIntoAWindowAlreadyKeyInItsAppSendsNoMakeKeyRecords() async throws {
        finder(focusedField: true)
        try await act(.type(CUTypeAction(text: "ab")))
        XCTAssertEqual(poster.keyDowns.map(\.unicode), ["a", "b"])
        XCTAssertTrue(FocusSPI.makeKey.isEmpty, "already key: nothing sent")
        XCTAssertEqual(Array(FocusSPI.calls.suffix(2)), ["defocus pid 5252 window 77", "focus pid 1 window 31"], "handed back as before")
    }

    /// Live (2026-10-10): after a blip handed the key focus back, the app held NO key window, and the focus record of
    /// every later blip left it so — keys for the window went nowhere (Docs' hidden input, its Tab), and Edit › Paste
    /// read disabled and took no ⌘V (every paste after the first). The hand-back is remembered (accessibility may still
    /// name a focused element there), and the NEXT blip names the bound window with the records, before its first key.
    func testAfterABlipsHandBackTheNextBlipNamesTheBoundWindowBeforeItsFirstKey() async throws {
        finder(focusedField: true)
        try await act(.type(CUTypeAction(text: "a")))
        XCTAssertTrue(FocusSPI.makeKey.isEmpty)
        XCTAssertTrue(core.isStranded(pid), "the hand-back left the app with no key window")
        FocusSPI.reset()
        var atFirstKey: [String]?
        poster.onPost = { e in if atFirstKey == nil, e.type == .keyDown { atFirstKey = FocusSPI.order } }
        try await act(.type(CUTypeAction(text: "b")))
        XCTAssertEqual(atFirstKey, ["defocus pid 1 window 77", "focus pid 5252 window 77", "down pid 5252 window 77", "up pid 5252 window 77"])
        XCTAssertEqual(Array(FocusSPI.calls.suffix(2)), ["defocus pid 5252 window 77", "focus pid 1 window 31"], "handed back as before")
        XCTAssertTrue(sys.activated.isEmpty)
        XCTAssertEqual(sys.frontmostPid(), 1)
        sys.front = pid  // a real activation: the app in front
        core.onActivation(pid: pid)
        XCTAssertFalse(core.isStranded(pid), "a real activation of the app gives it a key window again")
    }

    /// The records only take where the app holds no key window (measured): when ANOTHER standard window of it is key,
    /// the synthetic deactivation comes first (it resigns), then the activation, then the records.
    func testAnotherKeyWindowOfTheAppResignsBeforeTheRecords() async throws {
        finder(focusedField: true)
        let other = fakeElement(98_020)
        ax.add(other, role: kAXWindowRole, title: "Other")
        ax.windowIDs[AXIdentity(element: other)] = 78
        ax.focus(pid: pid, on: other)                         // the app's focus is in its other window
        ax.put(window, [kAXFocusedUIElementAttribute: field])  // the bound window's own focus is the field
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        try await act(.type(CUTypeAction(text: "ab")))
        XCTAssertEqual(Array(FocusSPI.order.prefix(6)),
                       ["defocus pid 1 window 77", "focus pid 5252 window 77", "deactivate", "activate 77", "down pid 5252 window 77", "up pid 5252 window 77"])
        XCTAssertEqual(enforcer.deactivated, 1)
        XCTAssertEqual(poster.keyDowns.map(\.unicode), ["a", "b"])
    }

    /// Review of round 2 (MEDIUM): the records and the deactivation close the app's transient UI — a context menu, a
    /// popover (measured with a probe app of ours). With one open, nothing new is sent — and the keys go only when the
    /// app's focus is in the bound window (a popover's or context menu's element names it as its window: measured).
    func testWithAMenuOrPopoverOpenNothingIsSentAndTheKeysGoOnlyIntoTheBoundWindow() async throws {
        // The measured state (review of round 4): an app showing a menu or popover holds its key window — its focused
        // element is in the bound window — never one our hand-back stranded (a menu or popover closes with that).
        for variant in ["popover", "menu"] {
            finder(focusedField: true)
            let enforcer = FakeFocusEnforcer()
            core.focusEnforcerFactory = { _ in enforcer }
            switch variant {
            case "popover":  // an on-screen window of the app that accessibility does not list as a window
                sys.stack.append(FakeSystem.window(90, pid: pid, CGRect(x: 300, y: 300, width: 240, height: 100)))
            default:         // AppKit's menu window
                sys.stack.append(FakeSystem.window(91, pid: pid, CGRect(x: 300, y: 300, width: 60, height: 60), layer: 101))
            }
            try await act(.type(CUTypeAction(text: "a")))
            XCTAssertTrue(FocusSPI.makeKey.isEmpty, "\(variant): no records")
            XCTAssertEqual(enforcer.deactivated, 0, "\(variant): no deactivation")
            XCTAssertEqual(poster.keyDowns.map(\.unicode), ["a"], "\(variant): the focus is in the bound window — typed")
            FocusSPI.reset()
        }
    }

    /// Review of round 4 (LOW): live, an app our hand-back stranded answers NO focused element; an attached completion
    /// or autocomplete window of the bound window that opened under the first burst (an unlisted window of the app)
    /// refused the second burst. It survived the loss of the key focus, so it is no menu or popover: the window is named
    /// with the records and the keys go.
    func testAnAttachedListOfAStrandedAppNeverRefusesTheNextBurst() async throws {
        finder(focusedField: true)
        core.noteStranded(pid, true)
        ax.focus(pid: pid, on: nil)  // stranded: no focused element
        sys.stack.append(FakeSystem.window(90, pid: pid, CGRect(x: 120, y: 144, width: 240, height: 120)))  // the list
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        try await act(.type(CUTypeAction(text: "a")))
        XCTAssertEqual(FocusSPI.makeKey, ["down pid 5252 window 77", "up pid 5252 window 77"], "the window named")
        XCTAssertEqual(poster.keyDowns.map(\.unicode), ["a"])
        // A list that is open while the keys provably go to another window of the app: still refused.
        FocusSPI.reset()
        core.noteStranded(pid, true)
        let panel = fakeElement(98_021)
        ax.add(panel, role: kAXWindowRole, subrole: kAXFloatingWindowSubrole, title: "Inspector")
        ax.windowIDs[AXIdentity(element: panel)] = 92
        ax.focus(pid: pid, on: panel)
        do {
            try await act(.type(CUTypeAction(text: "b")))
            XCTFail("typed")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("focus_not_placed"))
        }
    }

    /// Review of round 3 (MEDIUM, a regression): with a panel, a dialog or another window of the app holding the keys,
    /// or where they go unknown (the window list unreadable), the blip sent nothing to make the bound window key — and
    /// then typed anyway, into the panel (round 2 had resigned it first). Now nothing is typed: `focus_not_placed`,
    /// naming what holds the keys, the key focus handed back and the reroute tap removed.
    func testWhenThePanelDialogOrUnknownHoldsTheKeysNothingIsTyped() async throws {
        for variant in ["panel", "dialog", "windows unreadable", "transient unknown"] {
            finder(focusedField: true)
            let enforcer = FakeFocusEnforcer()
            core.focusEnforcerFactory = { _ in enforcer }
            switch variant {
            case "panel", "dialog":
                let other = fakeElement(98_021)
                ax.add(other, role: kAXWindowRole, subrole: variant == "panel" ? kAXFloatingWindowSubrole : kAXDialogSubrole,
                       title: variant == "panel" ? "Inspector" : "Save changes?")
                ax.windowIDs[AXIdentity(element: other)] = 92
                ax.put(ax.application(pid), [kAXWindowsAttribute: [window, other]])
                sys.stack.append(FakeSystem.window(92, pid: pid, CGRect(x: 300, y: 300, width: 240, height: 200)))
                ax.focus(pid: pid, on: other)
                ax.put(window, [kAXFocusedUIElementAttribute: field])  // the bound window's own focus: its field
            case "windows unreadable":
                ax.drop(ax.application(pid), kAXWindowsAttribute)  // a timeout reads as no list at all
                sys.stack.append(FakeSystem.window(92, pid: pid, CGRect(x: 300, y: 300, width: 240, height: 200)))
            default:
                // A listed window whose id can't be read, and an unlisted one on screen: it may be either.
                let anon = fakeElement(98_023)
                ax.add(anon, role: kAXWindowRole, title: "?")
                ax.put(ax.application(pid), [kAXWindowsAttribute: [window, anon]])
                sys.stack.append(FakeSystem.window(92, pid: pid, CGRect(x: 300, y: 300, width: 240, height: 200)))
            }
            do {
                try await act(.type(CUTypeAction(text: "ab")))
                XCTFail("\(variant): typed")
            } catch let e as CUError {
                XCTAssertEqual(e.code, "refused", variant)
                XCTAssertEqual(e.data?["reason"], .string("focus_not_placed"), variant)
                switch variant {
                case "panel": XCTAssertTrue(e.message.contains("its floating window “Inspector”"), e.message)
                case "dialog": XCTAssertTrue(e.message.contains("its dialog “Save changes?”"), e.message)
                default: XCTAssertTrue(e.message.contains("can't be told"), e.message)
                }
            }
            XCTAssertTrue(poster.keyDowns.isEmpty, "\(variant): no key sent")
            XCTAssertTrue(FocusSPI.makeKey.isEmpty, "\(variant): no records")
            XCTAssertEqual(enforcer.deactivated, 0, "\(variant): no deactivation")
            if variant == "panel" || variant == "dialog" {
                XCTAssertEqual(Array(FocusSPI.calls.suffix(2)), ["defocus pid 5252 window 77", "focus pid 1 window 31"], "\(variant): handed back")
            } else {
                // Review of round 4: what the focus record isn't needed for is decided before it — nothing posted at all.
                XCTAssertTrue(FocusSPI.calls.isEmpty, "\(variant): refused before any record: \(FocusSPI.calls)")
            }
            XCTAssertEqual(installer.removed, installer.installed.count, "\(variant): the reroute tap removed")
            FocusSPI.reset()
        }
    }

    /// The same refusal for a menu command validated in the blip: it would act on the panel's selection.
    func testAMenuCommandIsNotValidatedWhileAPanelHoldsTheKeys() async throws {
        finder(trashEnabled: false, focusedField: true)
        let panel = fakeElement(98_021)
        ax.add(panel, role: kAXWindowRole, subrole: kAXFloatingWindowSubrole, title: "Inspector")
        ax.windowIDs[AXIdentity(element: panel)] = 92
        ax.focus(pid: pid, on: panel)
        FocusSPI.onFocus = { [unowned self] in ax.put(trash, [kAXEnabledAttribute: true]) }
        do {
            try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
            XCTFail("pressed")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("focus_not_placed"))
        }
        XCTAssertTrue(ax.performed.isEmpty, "never pressed")
    }

    /// Review of round 3 (MEDIUM, a regression): a "stranded" mark left from an earlier script skipped the key-window
    /// read; meanwhile the user had made ANOTHER window of the app key, so the records alone (which don't take over a
    /// key window) left it key and the keys went into it. The read is made every time — the other window resigns
    /// first — and the mark only ever turns a "key" answer into "no key window".
    func testAStaleStrandedMarkNeverSkipsTheKeyWindowCheck() async throws {
        finder(focusedField: true)
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        try await act(.type(CUTypeAction(text: "a")))  // script 1: the hand-back strands the app
        XCTAssertTrue(core.isStranded(pid))
        // The user makes the app's other window key — and no activation of it was seen (the mark survived).
        let other = fakeElement(98_020)
        ax.add(other, role: kAXWindowRole, title: "Other")
        ax.windowIDs[AXIdentity(element: other)] = 78
        let otherField = fakeElement(98_024)
        ax.add(otherField, role: kAXTextFieldRole, extra: [kAXWindowAttribute: other])
        ax.focus(pid: pid, on: otherField)
        FocusSPI.reset()
        try await act(.type(CUTypeAction(text: "b")))  // script 2
        XCTAssertEqual(Array(FocusSPI.order.prefix(6)),
                       ["defocus pid 1 window 77", "focus pid 5252 window 77", "deactivate", "activate 77", "down pid 5252 window 77", "up pid 5252 window 77"],
                       "the other window resigned before the records named the bound one")
        XCTAssertEqual(enforcer.deactivated, 1)
        // The app's last target lost: the mark goes with it (a pid can be reused).
        core.noteStranded(pid, true)
        core.lose(target, reason: .windowClosed)
        XCTAssertFalse(core.isStranded(pid))
    }

    /// Round 5 (live, 2026-10-11): round 4 forgot the marks when the guardian stopped, 3 s after a script — the next
    /// script's first click into the Docs page read the stale "key" answer, sent no records, and the click only made
    /// the window key (the page's Tools menu never opened). The mark outlives the guardian: it goes when the app is
    /// really activated (by anyone), its last target is lost, or its pid dies.
    func testTheMarkOutlivesTheGuardianAndTheNextScriptsClickNamesTheWindow() async throws {
        finder(focusedField: true)
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        try await act(.type(CUTypeAction(text: "a")))  // script 1: the hand-back strands the app
        XCTAssertTrue(core.isStranded(pid))
        core.startGuardian(privatePath: true)
        core.stopGuardian()                            // the turn ended; the guardian stopped 3 s later
        XCTAssertTrue(core.isStranded(pid), "the guardian's stop changes nothing about the app's key window")
        // Script 2: accessibility still names the field (the stale answer) — a click names the window first.
        FocusSPI.reset()
        var atDown: [String]?
        poster.onPost = { e in if atDown == nil, e.type == .leftMouseDown { atDown = FocusSPI.order } }
        try await act(.click(CUClickAction(ref: target.refs.ref(for: AXIdentity(element: field)))))
        XCTAssertEqual(atDown, ["activate 77", "down pid 5252 window 77", "up pid 5252 window 77"], "the records before the click")
        XCTAssertFalse(core.isStranded(pid))
    }

    /// What clears the mark: a REAL activation of the app (it is in front as the notification is handled) — never a late
    /// notification that arrives after it is back in the background (one our own focus records set off, say).
    func testOnlyARealActivationClearsTheMark() {
        finder(focusedField: true)
        core.noteStranded(pid, true)
        core.appActivated(pid: pid)  // the user's app still in front: a late notification
        XCTAssertTrue(core.isStranded(pid))
        sys.front = pid              // the user brought the app forward
        core.appActivated(pid: pid)
        XCTAssertFalse(core.isStranded(pid))
        // Between turns the user activates the app, makes its other window key and goes back: the mark went with the
        // activation, and the next blip resigns that window first (the round-3 #2 scenario).
        sys.front = 1
        let other = fakeElement(98_020)
        ax.add(other, role: kAXWindowRole, title: "Other")
        ax.windowIDs[AXIdentity(element: other)] = 78
        let otherField = fakeElement(98_024)
        ax.add(otherField, role: kAXTextFieldRole, extra: [kAXWindowAttribute: other])
        ax.focus(pid: pid, on: otherField)
        XCTAssertEqual(core.keyInApp(target), .otherKey)
    }

    func testTheMakeKeyStepAppliesOnlyToABackgroundWindowOnThisDesktopAndNotChromium() {
        finder()
        XCTAssertTrue(core.makeKeyApplies(target))
        sys.front = pid
        XCTAssertFalse(core.makeKeyApplies(target), "the app in front: it is really active")
        sys.front = 1
        var w = sys.windows[77]!
        w.onScreen = false
        sys.windows[77] = w
        XCTAssertFalse(core.makeKeyApplies(target), "a window on another desktop keeps the routes it had")
        sys.windows[77] = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 900, height: 500))
        let noSPI = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                           pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        XCTAssertFalse(noSPI.makeKeyApplies(target), "no records without the private SPIs")
        // Chromium (measured on Chrome for Testing, 2026-10-11): typing into two background windows, repeatedly and
        // switching between them, landed every time without the records — so it keeps the blip it had.
        let chrome = CUTarget(id: "tc", sessionId: "s", pid: pid, bundleId: "com.google.Chrome", appName: "Chrome",
                              isChromium: true, mirror: false, windowID: 77, windowTitle: "Downloads")
        XCTAssertFalse(core.makeKeyApplies(chrome))
    }

    func testABackgroundClickIntoAKeyWindowSendsTheActivationOnly() async throws {
        finder(focusedField: true)
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        var atDown: [String]?
        poster.onPost = { e in if atDown == nil, e.type == .leftMouseDown { atDown = FocusSPI.order } }
        try await act(.click(CUClickAction(ref: target.refs.ref(for: AXIdentity(element: field)))))
        XCTAssertEqual(atDown, ["activate 77"], "already key: no records")
        XCTAssertTrue(FocusSPI.calls.isEmpty, "no focus records: a click takes no blip")
        XCTAssertTrue(installer.installed.isEmpty)
        XCTAssertTrue(sys.activated.isEmpty)
    }

    func testABackgroundClickIntoAStrandedAppNamesTheWindowFirst() async throws {
        finder(focusedField: true)
        core.noteStranded(pid, true)
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        var atDown: [String]?
        poster.onPost = { e in if atDown == nil, e.type == .leftMouseDown { atDown = FocusSPI.order } }
        try await act(.click(CUClickAction(ref: target.refs.ref(for: AXIdentity(element: field)))))
        XCTAssertEqual(atDown, ["activate 77", "down pid 5252 window 77", "up pid 5252 window 77"])
        XCTAssertFalse(core.isStranded(pid))
    }

    /// The click's own window decides: a sheet, popover or panel of the app over the point takes the click, and the
    /// bound window is never made key under it.
    func testAClickLandingOnAnotherWindowOfTheAppSendsNoRecords() async throws {
        finder(focusedField: true)
        core.noteStranded(pid, true)
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        // A listed panel of the app in front of the field's point.
        let sheet = fakeElement(98_022)
        ax.add(sheet, role: kAXWindowRole, subrole: kAXDialogSubrole, title: "Sheet")
        ax.windowIDs[AXIdentity(element: sheet)] = 93
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window, sheet]])
        sys.stack.insert(FakeSystem.window(93, pid: pid, CGRect(x: 100, y: 100, width: 400, height: 300)), at: 0)
        try await act(.click(CUClickAction(ref: target.refs.ref(for: AXIdentity(element: field)))))
        XCTAssertTrue(FocusSPI.makeKey.isEmpty, "the click goes to the sheet: the bound window is not made key")
        XCTAssertEqual(enforcer.deactivated, 0)
    }

    /// Review of round 2 (LOW): the front was read once, before AX round trips and the 30 ms gap. It is read again
    /// right before the deactivation and before the records: the user bringing the app forward meanwhile stops them.
    func testTheUserBringingTheAppForwardMeanwhileStopsTheRecords() async throws {
        finder(focusedField: true)
        let other = fakeElement(98_020)
        ax.add(other, role: kAXWindowRole, title: "Other")
        ax.windowIDs[AXIdentity(element: other)] = 78
        ax.focus(pid: pid, on: other)
        ax.put(window, [kAXFocusedUIElementAttribute: field])
        let enforcer = FakeFocusEnforcer()
        enforcer.onDeactivate = { [unowned self] in usersSwitch(); sys.front = pid }  // the user ⌘-Tabs into the app while it resigns
        core.focusEnforcerFactory = { _ in enforcer }
        XCTAssertEqual(core.keyForClick(target, privatePath: true, clickWindow: 77), .appInFront)
        XCTAssertTrue(FocusSPI.makeKey.isEmpty, "the app came to the front: no records into the user's own app")
        sys.front = 1
        FocusSPI.reset()
        let quick = FakeFocusEnforcer()
        quick.onForce = { [unowned self] in usersSwitch(); sys.front = pid }  // forward before the decision is even taken
        core.focusEnforcerFactory = { _ in quick }
        core.noteStranded(pid, true)
        let t2 = CUTarget(id: "t2", sessionId: "s", pid: pid, bundleId: "com.apple.finder", appName: "Finder",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Downloads")
        core.registerForTesting(t2, windowElement: window)
        XCTAssertEqual(core.keyForClick(t2, privatePath: true, clickWindow: 77), .appInFront, "forward before the decision: no click")
        XCTAssertTrue(FocusSPI.makeKey.isEmpty)
        XCTAssertEqual(quick.deactivated, 0)
        // With no input of the user's that switches, the same front change is the app's own doing (the one decision).
        sys.front = 1
        core.switchInputObservableOverride = true
        let selfish = FakeFocusEnforcer()
        selfish.onForce = { [unowned self] in sys.front = pid }
        core.focusEnforcerFactory = { _ in selfish }
        let t3 = CUTarget(id: "t3", sessionId: "s", pid: pid, bundleId: "com.apple.finder", appName: "Finder",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Downloads")
        core.registerForTesting(t3, windowElement: window)
        core.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: [], now: core.clock.nowSeconds())  // ⌘ released earlier
        core.guardianLock.withLock { core.guardianCore.input = CUSwitchInput() }
        XCTAssertEqual(core.keyForClick(t3, privatePath: true, clickWindow: 77), .activatedItself)
    }

    /// Review of round 3 (LOW): the make-key step saw the app come to the front, and the click went out anyway — into
    /// what was now the user's front app. It is not sent: `app_in_front`.
    func testAClickIsNotSentWhenTheAppCameToTheFrontWhileItWasPrepared() async throws {
        finder(focusedField: true)
        let other = fakeElement(98_020)
        ax.add(other, role: kAXWindowRole, title: "Other")
        ax.windowIDs[AXIdentity(element: other)] = 78
        ax.focus(pid: pid, on: other)
        ax.put(window, [kAXFocusedUIElementAttribute: field])
        let enforcer = FakeFocusEnforcer()
        enforcer.onDeactivate = { [unowned self] in usersSwitch(); sys.front = pid }  // the user ⌘-Tabs into the app while it resigns
        core.focusEnforcerFactory = { _ in enforcer }
        core.startGuardian(privatePath: true)  // ARMED: its activation notification must not pull them back (review of round 6)
        defer { core.stopGuardian() }
        do {
            try await act(.click(CUClickAction(ref: target.refs.ref(for: AXIdentity(element: field)), button: .right)))
            XCTFail("clicked")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "refused")
            XCTAssertEqual(e.data?["reason"], .string("app_in_front"))
        }
        XCTAssertFalse(poster.entries.contains { $0.type == .rightMouseDown || $0.type == .leftMouseDown }, "no click posted")
        XCTAssertTrue(sys.activated.isEmpty, "the user is not pulled back out of the app they brought forward (review of round 4)")
        core.onActivation(pid: pid)  // the activation's notification, a moment later, right after our synthetic events
        XCTAssertTrue(sys.activated.isEmpty, "the armed guardian never restores over the move the act judged theirs")
    }

    // MARK: round 7 — one decision for whose move it is

    /// Review of round 6 (HIGH): a switch the user makes DURING a typing burst (a blip lives up to 1.5 s) was still
    /// undone — their keys posted to the app they left until the burst ended, then that app re-activated over them.
    /// Every key now asks: theirs → no reroute after it (their keys stay in the target they switched into), no hand-back,
    /// no restore, `app_in_front`.
    func testTheUserSwitchingDuringATypingBurstIsLeftThere() async throws {
        for dest in ["the target", "a third app"] {
            finder(focusedField: true)
            let third: pid_t = 7777
            sys.running.insert(third)
            let destPid = dest == "the target" ? pid : third
            var keys = 0
            var passedThrough: CGEvent?
            var handBackBefore = 0
            poster.onPost = { [unowned self] e in
                guard e.type == .keyDown else { return }
                keys += 1
                if keys == 2 {
                    handBackBefore = FocusSPI.calls.filter { $0.hasPrefix("focus pid 1 ") }.count
                    usersSwitch()
                    sys.front = destPid
                    // Their own key reaching the target's tap now: theirs to keep when the target is their front app.
                    if dest == "the target", let tap = installer.handler { passedThrough = tap(keyEvent(stamped: false)) }
                }
            }
            core.startGuardian(privatePath: true)
            do {
                try await act(.type(CUTypeAction(text: "abcdef")))
                XCTFail("\(dest): typed on")
            } catch let e as CUError {
                XCTAssertEqual(e.data?["reason"], .string("app_in_front"), "\(dest): \(e.message)")
            }
            XCTAssertEqual(poster.keyDowns.count, 2, "\(dest): nothing more sent after the switch")
            XCTAssertEqual(FocusSPI.calls.filter { $0.hasPrefix("focus pid 1 ") }.count, handBackBefore, "\(dest): no hand-back to the app they left")
            XCTAssertTrue(sys.activated.isEmpty, "\(dest): no restore over them")
            XCTAssertEqual(installer.removed, installer.installed.count, "\(dest): the reroute removed")
            if dest == "the target" {
                XCTAssertNotNil(passedThrough, "their key passed through to the target they are in")
                XCTAssertTrue(posted.isEmpty, "never posted to the app they left")
            }
            core.onActivation(pid: destPid)
            XCTAssertTrue(sys.activated.isEmpty, "\(dest): the armed guardian leaves them there")
            core.stopGuardian()
            FocusSPI.reset()
        }
    }

    /// The target activating ITSELF mid-burst (no switch of the user's): the blip ends the ordinary way, the user is put
    /// back, and nothing more is typed.
    func testTheTargetActivatingItselfMidBurstStopsTheTypingAndPutsTheUserBack() async throws {
        finder(focusedField: true)
        core.switchInputObservableOverride = true
        var keys = 0
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown else { return }
            keys += 1
            if keys == 2 { sys.front = pid }
        }
        do {
            try await act(.type(CUTypeAction(text: "abcdef")))
            XCTFail("typed on")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["uncertain"], .bool(true), e.message)
            XCTAssertTrue(e.message.contains("came to the front by itself"), e.message)
        }
        XCTAssertEqual(poster.keyDowns.count, 2)
        XCTAssertEqual(sys.activated.last, 1, "the user's app put back")
    }

    /// Review of round 6 (MEDIUM): the hand-back's window-server fallback named the user's app's frontmost layer-0
    /// window — not the one that was key (a Finder window behind other apps, over the desktop's selection). With no
    /// window accessibility names, the record names none and the app takes back its own key window.
    func testTheHandBackNamesNoWindowWhenTheUsersFocusedWindowIsUnreadable() async throws {
        finder(focusedField: true)
        ax.drop(ax.application(1), kAXFocusedWindowAttribute)
        sys.stack.insert(FakeSystem.window(33, pid: 1, CGRect(x: 0, y: 0, width: 300, height: 200)), at: 0)  // a window of theirs, not key
        try await act(.type(CUTypeAction(text: "a")))
        XCTAssertTrue(FocusSPI.calls.contains("focus pid 1 window 0"), "\(FocusSPI.calls)")
        XCTAssertFalse(FocusSPI.calls.contains("focus pid 1 window 33"), "never the frontmost window the server lists")
    }

    // MARK: round 6 — the reviewer's findings on round 4

    /// The window server's key focus, as the focus records and activations move it (a record names a process).
    private func trackKeyFocus(loseFirstHandBack: Bool = false) -> () -> pid_t {
        var keyFocus: pid_t = 1
        var lost = !loseFirstHandBack
        FocusSPI.onFocus = { [unowned self] in
            guard let last = FocusSPI.calls.last, last.hasPrefix("focus pid ") else { return }
            let p = pid_t(last.split(separator: " ")[2])!
            if p == 1, !lost { lost = true; return }  // a busy app: the first hand-back record lost
            keyFocus = p
            if p == pid { ax.put(trash, [kAXEnabledAttribute: true]) }
        }
        sys.onActivate = { p in keyFocus = p }
        core.keyFocusPidOverride = { keyFocus }
        return { keyFocus }
    }

    /// Review of round 4 (HIGH): a refusal after the focus record handed back ONCE, removed the reroute at once and threw
    /// — and posted nothing at all when the user's focused window could not be read (Finder showing only the desktop),
    /// so the target kept the user's keys (their next Return would press its dialog's default button). A refusal now
    /// ends the blip the ordinary way: the hand-back (naming no window if none is known), the wait, a second hand-back,
    /// the tap removed only then, the guardian's restore — the key focus ends with the user.
    func testARefusedBlipLeavesTheKeyFocusWithTheUser() async throws {
        for (unreadable, lose) in [(true, false), (false, true)] {
            finder(focusedField: true)
            let keyFocus = trackKeyFocus(loseFirstHandBack: lose)
            if unreadable { ax.drop(ax.application(1), kAXFocusedWindowAttribute) }  // no window of the user's to name
            let dialog = fakeElement(98_021)
            ax.add(dialog, role: kAXWindowRole, subrole: kAXDialogSubrole, title: "Save changes?")
            ax.windowIDs[AXIdentity(element: dialog)] = 92
            ax.focus(pid: pid, on: dialog)
            var tapAtLastRecord = false
            let onFocus = FocusSPI.onFocus
            FocusSPI.onFocus = { [unowned self] in onFocus?(); tapAtLastRecord = installer.isInstalled }
            do {
                try await act(.type(CUTypeAction(text: "\n")))
                XCTFail("typed")
            } catch let e as CUError {
                XCTAssertEqual(e.data?["reason"], .string("focus_not_placed"))
            }
            XCTAssertTrue(poster.keyDowns.isEmpty, "nothing pressed the dialog's default button")
            XCTAssertEqual(keyFocus(), 1, "unreadable \(unreadable), first hand-back lost \(lose): the key focus ends with the user — \(FocusSPI.calls)")
            XCTAssertTrue(tapAtLastRecord, "the reroute still on while the key focus was handed back")
            XCTAssertEqual(installer.removed, installer.installed.count, "and removed after")
            if unreadable { XCTAssertTrue(FocusSPI.calls.contains("focus pid 1 window 0"), "a hand-back with no window to name") }
            if lose { XCTAssertEqual(FocusSPI.calls.filter { $0.hasPrefix("focus pid 1 ") }.count, 2, "handed back twice") }
            FocusSPI.reset()
            FocusSPI.onFocus = nil
        }
    }

    /// Review of round 4 (MEDIUM): the user bringing the target forward during the make-key step read as the STEP moving
    /// their view — undone, the focus records retired for the helper's life, and the user pulled back to their previous
    /// app. It is their move: `app_in_front`, nothing undone, nothing retired, the key focus left in the app they chose.
    func testTheUserBringingTheTargetForwardDuringABlipIsTheirMove() async throws {
        finder(focusedField: true)
        let other = fakeElement(98_020)
        ax.add(other, role: kAXWindowRole, title: "Other")
        ax.windowIDs[AXIdentity(element: other)] = 78
        ax.focus(pid: pid, on: other)
        ax.put(window, [kAXFocusedUIElementAttribute: field])
        let enforcer = FakeFocusEnforcer()
        enforcer.onDeactivate = { [unowned self] in usersSwitch(); sys.front = pid }  // the user ⌘-Tabs into the app meanwhile
        core.focusEnforcerFactory = { _ in enforcer }
        core.startGuardian(privatePath: true)  // ARMED
        defer { core.stopGuardian() }
        do {
            try await act(.type(CUTypeAction(text: "a")))
            XCTFail("typed")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("app_in_front"))
        }
        core.onActivation(pid: pid)
        XCTAssertTrue(sys.activated.isEmpty, "the armed guardian leaves them there too")
        XCTAssertTrue(poster.keyDowns.isEmpty)
        XCTAssertTrue(sys.activated.isEmpty, "not pulled back out of the app they chose")
        XCTAssertFalse(core.isRetired(.focusRecords), "the focus records stay in use")
        XCTAssertFalse(FocusSPI.calls.contains("focus pid 1 window 31"), "the key focus never handed back to the app they left")
        XCTAssertEqual(installer.removed, installer.installed.count)
        // Back in their own app later: the next blip runs as ever.
        sys.front = 1
        core.noteTapEvent(type: .flagsChanged, sourcePid: 0, userData: 0, flags: [], now: core.clock.nowSeconds() - 5)
        core.guardianLock.withLock { core.guardianCore.input = CUSwitchInput() }
        enforcer.onDeactivate = nil
        FocusSPI.reset()
        try await act(.type(CUTypeAction(text: "b")))
        XCTAssertEqual(poster.keyDowns.map(\.unicode), ["b"])
    }

    func testTheTargetActivatingItselfDuringABlipIsUndoneAndNothingIsTyped() async throws {
        finder(focusedField: true)
        let other = fakeElement(98_020)
        ax.add(other, role: kAXWindowRole, title: "Other")
        ax.windowIDs[AXIdentity(element: other)] = 78
        ax.focus(pid: pid, on: other)
        ax.put(window, [kAXFocusedUIElementAttribute: field])
        let enforcer = FakeFocusEnforcer()
        enforcer.onDeactivate = { [unowned self] in sys.front = pid }  // the app activates itself — nobody's input
        core.focusEnforcerFactory = { _ in enforcer }
        // Review of round 6 (HIGH): the user TYPING in their own app all along is no switch — round 6 took it for one.
        core.switchInputObservableOverride = true
        core.secondsSinceUserInputOverride = { 0.05 }
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 0, now: core.clock.nowSeconds())
        core.startGuardian(privatePath: true)  // ARMED
        defer { core.stopGuardian() }
        do {
            try await act(.type(CUTypeAction(text: "a")))
            XCTFail("typed")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("focus_not_placed"))
            XCTAssertTrue(e.message.contains("activated itself"), e.message)
        }
        XCTAssertTrue(poster.keyDowns.isEmpty, "nothing typed with no blip")
        XCTAssertEqual(sys.activated.first, 1, "the user's app put back")
        XCTAssertTrue(core.isRetired(.focusRecords), "the step retired: it moved the view")
        XCTAssertEqual(installer.removed, installer.installed.count)
    }

    /// Review of round 4 (MEDIUM): the click that puts the focus in a field saw the app come to the front and returned a
    /// silent `false` — the typing carried on, into whatever window of the now-front app held the keys, and the act's
    /// check then pulled the user back out. Now the refusal stops the act, and the user is left where they went.
    func testAFocusClickRefusedAsAppInFrontStopsTheTyping() async throws {
        finder()  // the field not focused: the focus is placed with a window-targeted click
        ax.put(field, [kAXWindowAttribute: window])
        let other = fakeElement(98_020)
        ax.add(other, role: kAXWindowRole, title: "Other")
        ax.windowIDs[AXIdentity(element: other)] = 78
        let otherField = fakeElement(98_024)
        ax.add(otherField, role: kAXTextFieldRole, extra: [kAXWindowAttribute: other])
        ax.focus(pid: pid, on: otherField)
        let enforcer = FakeFocusEnforcer()
        enforcer.onDeactivate = { [unowned self] in usersSwitch(); sys.front = pid }  // the user ⌘-Tabs into the app meanwhile
        core.focusEnforcerFactory = { _ in enforcer }
        do {
            try await act(.type(CUTypeAction(text: "abc", into: target.refs.ref(for: AXIdentity(element: field)))))
            XCTFail("typed")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("app_in_front"), e.message)
        }
        XCTAssertTrue(poster.keyDowns.isEmpty, "nothing typed into the now-front app")
        XCTAssertFalse(poster.entries.contains { $0.type == .leftMouseDown }, "no click")
        XCTAssertTrue(sys.activated.isEmpty, "not pulled back out")
    }

    /// Review of round 4 (MEDIUM, a regression): a focused element with no window of its own (some Java, Qt and custom
    /// toolkits) read as "no window accessibility can name" and refused for good. The app's focused window is the bound
    /// one: the keys go.
    func testAFocusWithNoWindowOfItsOwnInTheBoundWindowTakesTheKeys() async throws {
        finder()
        let javaField = fakeElement(98_030)
        ax.add(javaField, role: kAXTextFieldRole, title: "Name")  // no AXWindow, no parent
        ax.focus(pid: pid, on: javaField)
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window])
        try await act(.key(CUKeyAction(combo: "x")))
        XCTAssertEqual(poster.keyDowns.count, 1, "typed into the bound window")
        // Its focused window another one: where the keys go can't be told — refused, nothing sent.
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: userWindow])
        do {
            try await act(.key(CUKeyAction(combo: "y")))
            XCTFail("typed")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("focus_not_placed"))
        }
        XCTAssertEqual(poster.keyDowns.count, 1)
    }

    func testADesktopSwitchDuringATypingBlipStopsTheAct() async throws {
        finder(focusedField: true)
        sys.space = 100
        poster.onPost = { [unowned self] e in if e.type == .keyUp { sys.space = 200 } }  // macOS began switching
        do {
            try await act(.type(CUTypeAction(text: "abc")))
            XCTFail("stopped")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "busy")
            XCTAssertEqual(e.data?["uncertain"], .bool(true))
            XCTAssertTrue(e.message.contains("macOS began switching desktops"), e.message)
            XCTAssertTrue(e.message.contains("1 of 3 characters had been typed"), e.message)
        }
        XCTAssertEqual(poster.keyDowns.count, 1, "nothing more was sent")
        XCTAssertEqual(installer.removed, installer.installed.count)
    }

    func testTheTimerRemovesTheTapAtTheBoundEvenIfTheActIsStillGoing() async throws {
        finder(trashEnabled: false)
        var removedByTimer: Int?
        FocusSPI.onFocus = { [unowned self] in
            guard FocusSPI.calls.last == "focus pid \(pid) window 77", let bound = scheduled.last else { return }
            bound.work()  // the bound arrives while the act is still inside the blip
            removedByTimer = installer.removed
        }
        _ = try? await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
        XCTAssertEqual(removedByTimer, 1, "the tap came off at the bound")
        XCTAssertEqual(installer.removed, installer.installed.count, "and never twice")
    }

    func testAKeyRepeatedIsOneBurst() async throws {
        finder(focusedField: true)
        try await act(.key(CUKeyAction(combo: "cmd+delete", repeat: 5)))
        XCTAssertEqual(poster.keyDowns.filter { $0.keycode == 51 }.count, 5)
        XCTAssertEqual(installer.installed.count, 1, "one blip at the start of the burst")
        XCTAssertEqual(installer.removed, 1)
    }

    func testALongBurstIsSplitIntoBlipsThatEachEndInTime() async throws {
        finder(focusedField: true)
        core.blipBurstMs = 0  // every key spends the burst: a fresh blip before each
        try await act(.type(CUTypeAction(text: "abc")))
        XCTAssertEqual(poster.keyDowns.map(\.unicode), ["a", "b", "c"])
        XCTAssertEqual(installer.installed.count, 3)
        XCTAssertEqual(installer.removed, 3, "each blip ended before the next began")
        XCTAssertEqual(FocusSPI.calls.filter { $0 == "focus pid 1 window 31" }.count, 3, "the key focus handed back each time")
    }

    func testAWindowThatHoldsTheKeyFocusTakesNoBlip() async throws {
        finder(focusedField: true)
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window])  // key in its app
        core.keyFocusPidOverride = { [unowned self] in pid }              // and the window server's key focus
        try await act(.type(CUTypeAction(text: "ab")))
        try await act(.key(CUKeyAction(combo: "cmd+delete")))
        XCTAssertTrue(FocusSPI.calls.isEmpty)
        XCTAssertTrue(installer.installed.isEmpty)
        XCTAssertEqual(poster.keyDowns.count, 3)
    }

    func testTheUsersKeysDuringATypingBlipGoToTheirApp() async throws {
        finder(focusedField: true)
        var dropped: [Bool] = []
        poster.onPost = { [unowned self] e in
            guard e.type == .keyDown, let tap = installer.handler else { return }
            dropped.append(tap(keyEvent(stamped: false)) == nil)  // the user types while the agent does
        }
        try await act(.type(CUTypeAction(text: "ab")))
        XCTAssertEqual(dropped, [true, true])
        XCTAssertEqual(posted, [1, 1], "to the user's app, never the target")
    }

    func testWithThePrivatePathOffTypingTakesNoBlip() async throws {
        finder(focusedField: true)
        try await act(.type(CUTypeAction(text: "ab")), privatePath: false)
        XCTAssertTrue(FocusSPI.calls.isEmpty)
        XCTAssertTrue(installer.installed.isEmpty)
    }

    func testAnAppAlreadyInFrontIsLeftAlone() async throws {
        finder()
        sys.front = pid
        try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
        XCTAssertTrue(FocusSPI.calls.isEmpty)
    }

    // MARK: 2. open menus first

    func testOpenMenusAreFoundUnderTheApplicationAndInMenuWindows() {
        finder()
        let app = ax.application(pid)
        let context = fakeElement(98_020), host = fakeElement(98_021), hosted = fakeElement(98_022)
        ax.add(context, role: kAXMenuRole)
        ax.add(host, role: kAXWindowRole, extra: [kAXChildrenAttribute: [hosted]])
        ax.add(hosted, role: kAXMenuRole)
        ax.put(app, [kAXChildrenAttribute: [window, context, host]])
        let menus = CUCore.openMenus(app: app, boundWindow: window, ax: ax)
        XCTAssertEqual(menus.map { token($0) }, [token(context), token(hosted)])
    }

    // MARK: 3. out-of-view first

    /// A window 800×600 whose scroll area (y 50…600) holds a page of 300 links, 20 pt apart from y 60.
    private func page() -> [CUNode] {
        var links: [CUNode] = []
        for i in 0..<300 {
            links.append(CUNode(ref: 100 + i, role: "AXLink", name: "Link \(i)", frame: CGRect(x: 20, y: 60 + 20 * i, width: 200, height: 18)))
        }
        let web = CUNode(ref: 3, role: "AXWebArea", name: "Page", frame: CGRect(x: 0, y: 50, width: 800, height: 6000), children: links)
        let scroll = CUNode(ref: 2, role: "AXScrollArea", frame: CGRect(x: 0, y: 50, width: 800, height: 550), children: [web])
        let toolbar = CUNode(ref: 4, role: "AXToolbar", frame: CGRect(x: 0, y: 0, width: 800, height: 50),
                             children: [CUNode(ref: 5, role: "AXButton", name: "Back", frame: CGRect(x: 4, y: 4, width: 30, height: 30))])
        return [CUNode(ref: 1, role: "AXWindow", name: "Docs", frame: CGRect(x: 0, y: 0, width: 800, height: 600),
                       children: [toolbar, scroll])]
    }

    func testAFoldedStateKeepsWhatIsOnScreenAndFoldsTheRestFirst() {
        let f = CUStateFormatter(lineCap: 60)
        let lines = f.body(roots: page(), focusedRef: nil, viewportFirst: true)
        XCTAssertTrue(lines.contains { $0.contains("[100] link \"Link 0\"") }, "the first visible link")
        XCTAssertTrue(lines.contains { $0.contains("[126] link \"Link 26\"") }, "the last link inside the viewport (y 580)")
        XCTAssertFalse(lines.contains { $0.contains("Link 27\"") }, "the first link below the viewport is folded")
        XCTAssertTrue(lines.contains { $0.contains("[5] button \"Back\"") }, "the toolbar survives")
        XCTAssertTrue(lines.contains("      … 273 more out of view — scroll, or state({within:3})"), lines.joined(separator: "\n"))
        XCTAssertLessThanOrEqual(lines.count, 60)
        // The old way (`within` or full) collapses the largest subtree: the whole page goes.
        let old = f.body(roots: page(), focusedRef: nil)
        XCTAssertFalse(old.contains { $0.contains("Link 0\"") })
    }

    func testTheFocusedElementIsNeverFoldedOutOfView() {
        let f = CUStateFormatter(lineCap: 60)
        let lines = f.body(roots: page(), focusedRef: 250, viewportFirst: true)
        XCTAssertTrue(lines.contains { $0.contains("[250] link \"Link 150\"") }, "kept where input goes")
    }

    func testSmallTreesAreNotFolded() {
        let lines = CUStateFormatter(lineCap: 400).body(roots: page(), focusedRef: nil, viewportFirst: true)
        XCTAssertTrue(lines.contains { $0.contains("Link 299\"") }, "nothing folds under the cap")
    }

    // MARK: 4. paste

    func testAnUnconfirmablePasteReturnsAtOnceAndRestoresTheClipboardLater() async throws {
        finder(focusedField: true)  // a field with no value and no selection: a canvas editor
        core.pasteRestoreDelayMs = 150
        let start = Date()
        let r = try await act(.paste(CUPasteAction(text: "report text")))
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.0, "no 1.5 s wait for evidence that never comes")
        XCTAssertTrue(r.detail?.contains("unconfirmed — can't be read back") ?? false, r.detail ?? "")
        XCTAssertEqual(pb.readString(), "report text", "the target can still read it")
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(pb.readString(), "user's own", "and the user's clipboard came back")
    }

    func testASecondPasteBeforeTheRestoreKeepsTheUsersClipboardAsTheOneToRestore() async throws {
        finder(focusedField: true)
        core.pasteRestoreDelayMs = 300
        try await act(.paste(CUPasteAction(text: "first")))
        try await act(.paste(CUPasteAction(text: "second")))
        XCTAssertEqual(pb.readString(), "second")
        try await Task.sleep(nanoseconds: 700_000_000)
        XCTAssertEqual(pb.readString(), "user's own", "never Winter's first text")
    }

    func testAConfirmablePasteStillWaitsForEvidence() async throws {
        finder(focusedField: true)
        ax.put(field, [kAXValueAttribute: "hello"])
        poster.onPost = { [unowned self] e in
            if e.type == .keyDown, e.keycode == 9 { ax.put(field, [kAXValueAttribute: "hello world"]) }
        }
        let r = try await act(.paste(CUPasteAction(text: " world")))
        XCTAssertFalse(r.detail?.contains("unconfirmed") ?? false)
        XCTAssertEqual(pb.readString(), "user's own", "restored right after the evidence")
    }

    func testTheTurnEndingRestoresAPendingClipboardNow() async throws {
        finder(focusedField: true)
        core.pasteRestoreDelayMs = 10_000
        try await act(.paste(CUPasteAction(text: "pending")))
        XCTAssertEqual(pb.readString(), "pending")
        _ = try await core.turnEnded(TurnEndedParams(sessionId: "s"))
        XCTAssertEqual(pb.readString(), "user's own")
    }
}
