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
    static func pid(_ psn: UnsafeRawPointer) -> pid_t { pid_t(psn.load(fromByteOffset: 4, as: UInt32.self)) }
}

private let fakePostRecord: CUSkyLight.PostEventRecordTo = { psn, bytes in
    let wid = UInt32(bytes[0x3C]) | UInt32(bytes[0x3D]) << 8 | UInt32(bytes[0x3E]) << 16 | UInt32(bytes[0x3F]) << 24
    FocusSPI.calls.append("\(bytes[0x8A] == 1 ? "focus" : "defocus") pid \(FocusSPI.pid(psn)) window \(wid)")
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

    override func setUp() {
        FocusSPI.calls = []
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
        ax.add(field, role: kAXTextFieldRole, frame: CGRect(x: 120, y: 120, width: 200, height: 24))
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
    }

    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

    @discardableResult
    private func act(_ a: CUAction, privatePath: Bool = true, foreground: Bool = false) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: foreground, privatePath: privatePath))
    }

    // MARK: 1. focus without raise

    func testAMenuCommandMakesTheBoundWindowKeyInTheBackgroundAndGivesEverythingBack() async throws {
        finder()
        XCTAssertEqual(sys.frontmostPid(), 1)
        var during: [String] = []
        ax.onPerform = { _ in during = FocusSPI.calls }
        let r = try await act(.menu(CUMenuAction(path: ["File", "Move to Trash"])))
        XCTAssertEqual(during, ["defocus pid 1 window 77", "focus pid 5252 window 77"], "yabai: key without raise")
        XCTAssertEqual(Array(FocusSPI.calls.dropFirst(2)), ["defocus pid 5252 window 77", "focus pid 1 window 31"],
                       "the user's key window handed back")
        XCTAssertFalse(FocusSPI.calls.contains { $0.hasPrefix("front ") }, "never the front process: that switches Spaces")
        XCTAssertEqual(ax.performed, ["\(token(trash)):AXPress"])
        XCTAssertEqual(sys.frontmostPid(), 1, "the user's app stayed frontmost")
        XCTAssertTrue(sys.activated.isEmpty, "nothing was activated")
        XCTAssertEqual(r.detail, "Finder's window was made key in the background for the command")
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

    func testShortcutsAndTypingGetKeyFocusNeverTheFront() async throws {
        finder(focusedField: true)
        try await act(.key(CUKeyAction(combo: "cmd+delete")))
        XCTAssertTrue(FocusSPI.calls.contains("focus pid 5252 window 77"), "a shortcut: the bound window made key")
        XCTAssertFalse(FocusSPI.calls.contains { $0.hasPrefix("front ") }, "never the front process")
        XCTAssertEqual(poster.keyDowns.last?.keycode, 51)
        FocusSPI.calls = []
        try await act(.type(CUTypeAction(text: "ab")))
        XCTAssertTrue(FocusSPI.calls.contains("focus pid 5252 window 77"))
        XCTAssertFalse(FocusSPI.calls.contains { $0.hasPrefix("front ") }, "typing never takes the front")
        XCTAssertEqual(sys.frontmostPid(), 1)
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
        XCTAssertTrue(r.detail?.contains("can't be confirmed") ?? false, r.detail ?? "")
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
        XCTAssertFalse(r.detail?.contains("can't be confirmed") ?? false)
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
