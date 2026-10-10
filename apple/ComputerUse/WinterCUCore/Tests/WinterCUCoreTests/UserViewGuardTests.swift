import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The user-view guard: an act in the background leaves the user on their desktop, in their app. What the
/// target moves is put back and said; a background step that ever moved the view is not used again; the
/// consented foreground rung is left alone; and nothing raises the target's window.
final class UserViewGuardTests: XCTestCase {
    let pid: pid_t = 5353
    let window = fakeElement(97_001)
    let button = fakeElement(97_002)
    let userWindow = fakeElement(97_003)
    let bar = fakeElement(97_010), fileItem = fakeElement(97_011), fileMenu = fakeElement(97_012), newItem = fakeElement(97_013)

    var ax: FakeAX!
    var sys: FakeSystem!
    var core: CUCore!
    var target: CUTarget!

    override func setUp() {
        FocusSPI.reset()
        FocusSPI.frontPid = 1
        FocusSPI.onFocus = nil
    }

    /// Safari (pid 5353) in the background on this desktop (Space 1), behind the user's app (pid 1, key window 31).
    private func safari() {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window], kAXMenuBarAttribute: bar])
        ax.add(window, role: kAXWindowRole, title: "Start", frame: CGRect(x: 100, y: 100, width: 900, height: 600),
               extra: [kAXChildrenAttribute: [button]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.setActions(window, [kAXRaiseAction])
        ax.makeSettable(window, kAXMainAttribute)
        ax.add(button, role: kAXButtonRole, title: "Reload", frame: CGRect(x: 120, y: 120, width: 40, height: 24))
        ax.setActions(button, [kAXPressAction])
        ax.put(ax.application(1), [kAXFocusedWindowAttribute: userWindow])
        ax.windowIDs[AXIdentity(element: userWindow)] = 31
        ax.put(bar, [kAXChildrenAttribute: [fileItem]])
        ax.add(fileItem, role: "AXMenuBarItem", title: "File", extra: [kAXChildrenAttribute: [fileMenu]])
        ax.add(fileMenu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [newItem]])
        ax.add(newItem, role: kAXMenuItemRole, title: "New Tab")
        ax.setActions(newItem, [kAXPressAction])

        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.apple.Safari"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 900, height: 600), owner: "Safari")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1
        sys.space = 1

        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: focusSkyLight(), poster: RecordingPoster(), ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.apple.Safari", appName: "Safari",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Start")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }
    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    @discardableResult
    private func act(_ a: CUAction, foreground: Bool = false) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: foreground, privatePath: true))
    }

    // MARK: the act's check

    func testATargetThatActivatesItselfAndSwitchesDesktopsIsPutBackAndSaid() async throws {
        safari()
        // A click in Safari's address field: Safari activates itself, and macOS follows it to its desktop.
        ax.onPerform = { [unowned self] what in
            guard what.hasSuffix(":AXPress") else { return }
            sys.front = pid
            sys.space = 2
        }
        // Raising the user's key window and activating their app takes macOS back to that window's desktop.
        sys.onActivate = { [unowned self] p in if p == 1, ax.performed.contains("\(token(userWindow)):AXRaise") { sys.space = 1 } }
        let r = try await act(.click(CUClickAction(ref: ref(button))))
        XCTAssertEqual(sys.activated, [1])
        XCTAssertEqual(ax.performed, ["\(token(button)):AXPress", "\(token(userWindow)):AXRaise"])
        XCTAssertEqual([sys.space, sys.front.map(UInt64.init)], [1, 1])
        XCTAssertEqual(r.detail, "Safari activated itself and macOS switched desktops — the user's desktop and app were put back")
    }

    func testADesktopThatCannotBeSwitchedBackIsSaidSo() async throws {
        safari()
        ax.onPerform = { [unowned self] what in
            guard what.hasSuffix(":AXPress") else { return }
            sys.front = pid
            sys.space = 2
        }
        let r = try await act(.click(CUClickAction(ref: ref(button))))
        XCTAssertEqual(sys.activated, [1])
        XCTAssertEqual(r.detail, "Safari activated itself and macOS switched desktops — the user's app was put back in front, but macOS "
            + "stayed on the other desktop (switching back needs the user)")
    }

    func testAnotherAppComingForwardIsSaidButNotUndone() async throws {
        safari()
        ax.onPerform = { [unowned self] _ in sys.front = 42 }  // the user clicked another app meanwhile
        let r = try await act(.click(CUClickAction(ref: ref(button))))
        XCTAssertTrue(sys.activated.isEmpty, "not the target's doing: the user's choice stands")
        XCTAssertEqual(r.detail, "the frontmost app changed during the action")
    }

    func testAQuietActSaysNothing() async throws {
        safari()
        let r = try await act(.click(CUClickAction(ref: ref(button))))
        XCTAssertNil(r.detail)
        XCTAssertTrue(sys.activated.isEmpty)
    }

    func testTheConsentedForegroundRungIsLeftAlone() async throws {
        safari()
        ax.put(newItem, [kAXEnabledAttribute: true])
        sys.onActivate = { [unowned self] p in sys.space = p == pid ? 2 : 1 }
        let r = try await act(.menu(CUMenuAction(path: ["File", "New Tab"])), foreground: true)
        XCTAssertEqual(r.rung, 4)
        XCTAssertEqual(sys.activated, [pid, 1], "forward with consent, then the front given back — nothing more")
        XCTAssertFalse(r.detail?.contains("activated itself") ?? false, r.detail ?? "")
    }

    func testALateActivationIsUndoneAndSaidWithTheNextResult() async throws {
        safari()
        try await act(.click(CUClickAction(ref: ref(button))))
        // 300 ms on, Safari brought itself forward.
        sys.front = pid
        core.lateCheck(CUUserView(space: 1, front: 1), target, seq: target.actSeq, route: "click (AX)")
        XCTAssertEqual(sys.activated, [1])
        let next = try await act(.click(CUClickAction(ref: ref(button))))
        XCTAssertEqual(next.detail, "after the previous action, Safari activated itself — the user's app was put back")
        // A newer act owns the view: an old late check does nothing.
        sys.front = pid
        core.lateCheck(CUUserView(space: 1, front: 1), target, seq: target.actSeq - 1, route: "click (AX)")
        XCTAssertEqual(sys.activated, [1])
    }

    func testABindThatBringsTheAppForwardIsPutBack() {
        safari()
        let before = core.userView()
        sys.front = pid  // launched, it activated itself
        let note = core.viewNoteAfterBind(before, app: "Safari", pid: pid, route: "bind")
        XCTAssertEqual(note, "Safari activated itself — the user's app was put back")
        XCTAssertEqual(sys.activated, [1])
        XCTAssertNil(core.viewNoteAfterBind(core.userView(), app: "Safari", pid: pid, route: "bind"), "a quiet bind says nothing")
    }

    // MARK: background steps, checked every time

    func testFocusRecordsThatMoveTheViewAreUndoneAndNeverUsedAgain() async throws {
        safari()
        core.keyTapInstaller = FakeKeyTapInstaller()  // the blip's reroute (the focus records never run without it)
        core.blipSchedule = { _, _ in }
        ax.put(newItem, [kAXEnabledAttribute: false])  // disabled in the background: the focus blip is tried
        FocusSPI.onFocus = { [unowned self] in
            guard FocusSPI.calls.last == "focus pid \(pid) window 77" else { return }
            sys.front = pid  // Safari takes the front on key focus
            ax.put(newItem, [kAXEnabledAttribute: true])
        }
        let r = try await act(.menu(CUMenuAction(path: ["File", "New Tab"])))
        XCTAssertEqual(FocusSPI.calls, ["defocus pid 1 window 77", "focus pid \(pid) window 77",
                                        "defocus pid \(pid) window 77", "focus pid 1 window 31"], "undone at once")
        XCTAssertEqual(sys.activated, [1])
        XCTAssertTrue(r.detail?.contains("Safari activated itself — the user's app was put back (key focus without raise (focus records) is no longer used)") ?? false,
                      r.detail ?? "")
        XCTAssertTrue(ax.performed.contains("\(token(newItem)):AXPress"), "the command still ran, over AX")
        FocusSPI.reset()
        ax.put(newItem, [kAXEnabledAttribute: false])
        _ = try? await act(.menu(CUMenuAction(path: ["File", "New Tab"])))
        XCTAssertTrue(FocusSPI.calls.isEmpty, "retired for the helper's life")
    }

    func testAnAXMainWriteThatSwitchesDesktopsIsUndoneAndNeverUsedAgain() async throws {
        safari()
        ax.put(newItem, [kAXEnabledAttribute: true])
        ax.onSet = { [unowned self] what in if what.hasSuffix(":AXMain") { sys.space = 2 } }
        sys.onActivate = { [unowned self] p in if p == 1 { sys.space = 1 } }
        let r = try await act(.menu(CUMenuAction(path: ["File", "New Tab"])))
        XCTAssertTrue(r.detail?.contains("macOS switched desktops during the action — the user's desktop and app were put back (AXMain on the bound window is no longer used)") ?? false,
                      r.detail ?? "")
        XCTAssertEqual(sys.space, 1)
        ax.put(window, [kAXMainAttribute: false])
        let writes = ax.written.filter { $0.hasSuffix(":AXMain") }.count
        try await act(.menu(CUMenuAction(path: ["File", "New Tab"])))
        XCTAssertEqual(ax.written.filter { $0.hasSuffix(":AXMain") }.count, writes, "retired")
    }

    // MARK: never raised

    func testRaisingTheWindowIsRefused() async throws {
        safari()
        let windowRef = ref(window)
        do {
            try await act(.action(CUAXAction(ref: windowRef, name: "raise")))
            XCTFail("expected a refusal")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
            XCTAssertTrue(e.message.contains("raising a window brings it in front of the user's work"), e.message)
        }
        XCTAssertFalse(ax.performed.contains { $0.hasSuffix(":AXRaise") })
        XCTAssertTrue(sys.activated.isEmpty)
    }

    func testTheFrontVariantIsGone() {
        XCTAssertNil(CUSkyLight.resolve { _ in nil }.frontProcessPid())
        // Only reads remain: the front process and the active Space; nothing that sets either.
        let sky = focusSkyLight()
        XCTAssertTrue(sky.canFocusWithoutRaise)
    }

    func testAShortcutComboComesFromTheMenuItem() {
        XCTAssertEqual(CUCore.shortcutCombo(char: "", virtualKey: 0x33, modifiers: 0), "cmd+delete")
        XCTAssertEqual(CUCore.shortcutCombo(char: "T", virtualKey: nil, modifiers: 1), "cmd+shift+t")
        XCTAssertEqual(CUCore.shortcutCombo(char: "N", virtualKey: nil, modifiers: 2 | 4), "cmd+ctrl+option+n")
        XCTAssertNil(CUCore.shortcutCombo(char: "x", virtualKey: nil, modifiers: 8), "no command, no modifier: not a shortcut")
        XCTAssertNil(CUCore.shortcutCombo(char: nil, virtualKey: nil, modifiers: 0))
    }
}
