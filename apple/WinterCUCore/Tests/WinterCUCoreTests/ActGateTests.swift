import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// `targetAct`'s safety gates driven end to end against a fake AX tree, a fake window server, a recording
/// event poster and an in-memory clipboard: click-only, the secure-field floor (per character), the save
/// floor, paste through menus, rung-4 consent and hit-testing, cancellation in the queue, and AX timeouts.
final class ActGateTests: XCTestCase {
    let pid: pid_t = 4242
    let window = fakeElement(50_001)
    let field = fakeElement(50_002)
    let secure = fakeElement(50_003)
    let button = fakeElement(50_004)
    let pasteItem = fakeElement(50_005)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var pb: PasteAndQueueTests.FakePasteboard!
    var core: CUCore!
    var target: CUTarget!

    private func world(bundle: String = "com.example.app") {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 100, y: 100, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.put(app, [kAXWindowsAttribute: [window]])
        ax.put(window, [kAXChildrenAttribute: [field, secure, button]])
        ax.add(field, role: kAXTextFieldRole, frame: CGRect(x: 150, y: 150, width: 200, height: 24), extra: [kAXValueAttribute: "hello"])
        ax.add(secure, role: kAXTextFieldRole, subrole: kAXSecureTextFieldSubrole, frame: CGRect(x: 150, y: 200, width: 200, height: 24))
        ax.add(button, role: kAXButtonRole, title: "Send", frame: CGRect(x: 150, y: 250, width: 80, height: 24))
        ax.setActions(button, [kAXPressAction])
        ax.add(pasteItem, role: kAXMenuItemRole, title: "Paste", extra: [kAXMenuItemCmdCharAttribute: "V"])
        ax.setActions(pasteItem, [kAXPressAction])
        ax.focus(pid: pid, on: field)

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = bundle
        let win = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 800, height: 600))
        sys.windows[77] = win
        sys.stack = [win]
        sys.front = 1

        poster = RecordingPoster()
        let clip = PasteAndQueueTests.FakePasteboard([[NSPasteboard.PasteboardType.string.rawValue: Data("user's own".utf8)]])
        pb = clip
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { clip }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: bundle, appName: "App", isChromium: false,
                          mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    @discardableResult
    private func act(_ a: CUAction, access: CUAccess = .full, foreground: Bool = false, callId: String = "c") async throws
        -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: callId, action: a, access: access,
                                                 allowForeground: foreground, privatePath: true))
    }

    private func expect(_ code: String, reason: String? = nil, _ body: () async throws -> Void,
                        file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await body()
            XCTFail("expected \(code)", file: file, line: line)
        } catch let e as CUError {
            XCTAssertEqual(e.code, code, e.message, file: file, line: line)
            if let reason { XCTAssertEqual(e.data?["reason"], .string(reason), file: file, line: line) }
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
    }

    // MARK: click-only

    func testClickOnlyAllowsClicksScrollsAndActionsOnly() async throws {
        world()
        await expect("not_allowed", reason: "click_only") { try await self.act(.type(CUTypeAction(text: "x")), access: .click) }
        await expect("not_allowed", reason: "click_only") { try await self.act(.menu(CUMenuAction(path: ["Edit", "Paste"])), access: .click) }
        await expect("not_allowed", reason: "click_only") { try await self.act(.key(CUKeyAction(combo: "return")), access: .click) }
        XCTAssertTrue(poster.entries.isEmpty)
        let r = try await act(.click(CUClickAction(ref: ref(button))), access: .click)
        XCTAssertEqual(r.rung, 1)
        XCTAssertEqual(ax.performed, ["50004:AXPress"])
    }

    // MARK: secure fields and unknown focus (C1)

    func testTextNeverGoesToASecureOrUnknownFocus() async throws {
        world()
        await expect("refused", reason: "secure_field") { try await self.act(.type(CUTypeAction(text: "x", into: self.ref(self.secure)))) }
        ax.focus(pid: pid, on: secure)
        await expect("refused", reason: "secure_field") { try await self.act(.type(CUTypeAction(text: "x"))) }
        await expect("refused", reason: "secure_field") { try await self.act(.key(CUKeyAction(combo: "a"))) }
        await expect("refused", reason: "secure_field") { try await self.act(.key(CUKeyAction(combo: "cmd+v"))) }
        ax.focus(pid: pid, on: nil)
        await expect("refused", reason: "secure_field") { try await self.act(.type(CUTypeAction(text: "x"))) }
        await expect("refused", reason: "secure_field") { try await self.act(.paste(CUPasteAction(text: "x"))) }
        await expect("refused", reason: "secure_field") { try await self.act(.key(CUKeyAction(combo: "shift+a"))) }
        XCTAssertTrue(poster.entries.isEmpty, "nothing was typed")
        XCTAssertTrue(pb.log.isEmpty, "the clipboard was never touched")
        // Navigation keys are not text: Tab still works with focus unknown.
        try await act(.key(CUKeyAction(combo: "tab")))
        XCTAssertEqual(poster.keyDowns.map(\.keycode), [48])
    }

    func testTabIntoAPasswordFieldStopsTypingBeforeTheNextCharacter() async throws {
        world()
        poster.onPost = { [unowned self] e in
            if e.type == .keyDown, e.keycode == 48 { ax.focus(pid: pid, on: secure) }
        }
        await expect("refused", reason: "secure_field") { try await self.act(.type(CUTypeAction(text: "alice\thunter2"))) }
        let downs = poster.keyDowns
        XCTAssertEqual(downs.prefix(5).map(\.unicode), ["a", "l", "i", "c", "e"])
        XCTAssertEqual(downs.count, 6, "five letters and the tab — not one character of the password")
        XCTAssertEqual(downs.last?.keycode, 48)
    }

    // MARK: AX timeouts (I3)

    func testAnAXTimeoutNeverFallsBackToEvents() async throws {
        world()
        ax.performError = CUError.busy()
        await expect("busy") { try await self.act(.click(CUClickAction(ref: self.ref(self.button)))) }
        XCTAssertTrue(poster.entries.isEmpty, "no second click by events")
        ax.performError = nil
        ax.makeSettable(field, kAXSelectedTextAttribute)
        ax.setError = CUError.busy()
        await expect("busy") { try await self.act(.type(CUTypeAction(text: "x", into: self.ref(self.field)))) }
        XCTAssertTrue(poster.entries.isEmpty, "no second insert by keys")
        XCTAssertTrue(pb.log.isEmpty, "nor by paste")
    }

    func testARefusedAXActionFallsBackToEvents() async throws {
        world()
        ax.performError = CUError.unsupported("no")
        let r = try await act(.click(CUClickAction(ref: ref(button))))
        XCTAssertEqual(r.rung, 2)
        XCTAssertEqual(poster.entries.map(\.type), [.leftMouseDown, .leftMouseUp])
    }

    // MARK: cancel (I2)

    func testCancelReachesAnActWaitingInTheQueue() async throws {
        world()
        let gate = DispatchSemaphore(value: 0)
        let core = self.core!, pid = self.pid
        let blocker = Task { try await core.queues.run(pid) { gate.wait() } }
        for _ in 0..<200 where core.queues.pendingCount(pid) < 1 { try await Task.sleep(nanoseconds: 2_000_000) }
        let buttonRef = ref(button)
        let pending = Task { try await self.act(.click(CUClickAction(ref: buttonRef)), callId: "c9") }
        for _ in 0..<200 where core.queues.pendingCount(pid) < 2 { try await Task.sleep(nanoseconds: 2_000_000) }
        _ = try await core.cancel(CancelParams(callId: "c9"))
        gate.signal()
        try await blocker.value
        do {
            _ = try await pending.value
            XCTFail("expected cancelled")
        } catch {
            XCTAssertEqual((error as? CUError)?.code, "cancelled")
        }
        XCTAssertTrue(ax.performed.isEmpty)
    }

    // MARK: save panels (I4)

    private func openSaveSheet(name: String, folder: String = "Documents") -> (sheet: AXUIElement, name: AXUIElement, save: AXUIElement) {
        let sheet = fakeElement(50_010), nameField = fakeElement(50_011), save = fakeElement(50_012), where_ = fakeElement(50_013)
        ax.put(window, [kAXChildrenAttribute: [field, secure, button, sheet]])
        ax.add(sheet, role: kAXSheetRole, extra: [kAXChildrenAttribute: [nameField, where_, save]])
        ax.add(nameField, role: kAXTextFieldRole, frame: CGRect(x: 300, y: 130, width: 200, height: 22),
               extra: [kAXIdentifierAttribute: "saveAsNameTextField", kAXValueAttribute: name])
        ax.makeSettable(nameField, kAXValueAttribute)
        ax.add(where_, role: kAXPopUpButtonRole, extra: [kAXValueAttribute: folder])
        ax.add(save, role: kAXButtonRole, title: "Save", frame: CGRect(x: 600, y: 300, width: 60, height: 22))
        ax.setActions(save, [kAXPressAction])
        return (sheet, nameField, save)
    }

    func testAProtectedSavePanelBlocksEveryActButCancelAndRename() async throws {
        world()
        let panel = openSaveSheet(name: ".zshrc")
        await expect("refused", reason: "save_path") { try await self.act(.click(CUClickAction(ref: self.ref(panel.save)))) }
        await expect("refused", reason: "save_path") { try await self.act(.key(CUKeyAction(combo: "space"))) }
        await expect("refused", reason: "save_path") { try await self.act(.key(CUKeyAction(combo: "return"))) }
        await expect("refused", reason: "save_path") { try await self.act(.action(CUAXAction(ref: self.ref(panel.name), name: "AXConfirm"))) }
        await expect("refused", reason: "save_path") {
            try await self.act(.setValue(CUSetValueAction(ref: self.ref(panel.name), value: ".bashrc")))
        }
        XCTAssertTrue(ax.performed.isEmpty)
        // Escape cancels; renaming to something harmless is allowed.
        try await act(.key(CUKeyAction(combo: "escape")))
        try await act(.setValue(CUSetValueAction(ref: ref(panel.name), value: "notes.txt")))
        XCTAssertTrue(ax.written.contains("50011:AXValue"))
    }

    func testAProtectedFolderBlocksSaving() async throws {
        world()
        let panel = openSaveSheet(name: "id_ed25519", folder: ".ssh")
        await expect("refused", reason: "save_path") { try await self.act(.click(CUClickAction(ref: self.ref(panel.save)))) }
    }

    func testAnOrdinarySavePanelIsFine() async throws {
        world()
        let panel = openSaveSheet(name: "Report.pdf")
        let r = try await act(.click(CUClickAction(ref: ref(panel.save))))
        XCTAssertEqual(r.rung, 1)
    }

    // MARK: paste through menus (I5)

    private func addEditMenu() {
        let bar = fakeElement(50_020), appleItem = fakeElement(50_021), editItem = fakeElement(50_022), editMenu = fakeElement(50_023)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.put(bar, [kAXChildrenAttribute: [appleItem, editItem]])
        ax.add(appleItem, role: "AXMenuBarItem", title: "Apple")
        ax.add(editItem, role: "AXMenuBarItem", title: "Edit", extra: [kAXChildrenAttribute: [editMenu]])
        ax.add(editMenu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [pasteItem]])
    }

    func testPasteThroughMenusNeedsASafeFocus() async throws {
        world()
        addEditMenu()
        ax.focus(pid: pid, on: secure)
        await expect("refused", reason: "secure_field") { try await self.act(.menu(CUMenuAction(path: ["Edit", "Paste"]))) }
        await expect("refused", reason: "secure_field") { try await self.act(.click(CUClickAction(ref: self.ref(self.pasteItem)))) }
        await expect("refused", reason: "secure_field") { try await self.act(.action(CUAXAction(ref: self.ref(self.pasteItem), name: "press"))) }
        ax.focus(pid: pid, on: nil)
        await expect("refused", reason: "secure_field") { try await self.act(.menu(CUMenuAction(path: ["Edit", "Paste"]))) }
        XCTAssertTrue(ax.performed.isEmpty)
        // Click-only never pastes, even by clicking the menu item.
        ax.focus(pid: pid, on: field)
        await expect("not_allowed", reason: "click_only") {
            try await self.act(.click(CUClickAction(ref: self.ref(self.pasteItem))), access: .click)
        }
        try await act(.menu(CUMenuAction(path: ["Edit", "Paste"])))
        XCTAssertEqual(ax.performed, ["50005:AXPress"])
    }

    func testPasteRestoresTheClipboardOnceThePasteShows() async throws {
        world()
        poster.onPost = { [unowned self] e in
            if e.type == .keyDown, e.keycode == 9 { ax.put(field, [kAXValueAttribute: "hello pasted"]) }
        }
        let r = try await act(.paste(CUPasteAction(text: " pasted")))
        XCTAssertEqual(r.rung, 2)
        XCTAssertNil(r.detail, "confirmed and restored")
        XCTAssertEqual(pb.readString(), "user's own")
        XCTAssertEqual(poster.keyDowns.first?.flags.contains(.maskCommand), true)
    }

    // MARK: rung 4 (I1)

    private func shot() -> String {
        target.registerShot(anchor: .window(windowID: 77, regionOrigin: .zero), imageWidth: 800, imageHeight: 600,
                            points: CGSize(width: 800, height: 600)).id
    }

    func testForegroundNeedsConsent() async throws {
        world(bundle: "org.blenderfoundation.blender")
        let s = shot()
        await expect("needs_foreground") { try await self.act(.click(CUClickAction(point: [50, 60], shotId: s))) }
        // A ref without an AX press in a foreground-only app needs the pointer too.
        await expect("needs_foreground") { try await self.act(.click(CUClickAction(ref: self.ref(self.field)))) }
        XCTAssertTrue(sys.activated.isEmpty)
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testForegroundClicksHitTestEveryEvent() async throws {
        world(bundle: "org.blenderfoundation.blender")
        let s = shot()
        let point = CGPoint(x: 150, y: 160)  // window origin (100,100) + (50,60)
        // Another app's window covers the point.
        let other = FakeSystem.window(91, pid: 555, CGRect(x: 120, y: 120, width: 100, height: 100), owner: "Slack")
        sys.stack = [other, sys.windows[77]!]
        await expect("unsupported") { try await self.act(.click(CUClickAction(point: [50, 60], shotId: s)), foreground: true) }
        XCTAssertTrue(poster.entries.isEmpty)
        XCTAssertEqual(sys.activated, [pid, 1], "activated, then the user's app came back")
        XCTAssertEqual(sys.warpedTo, [CGPoint(x: 5, y: 5)], "and the pointer")
        // A permission prompt (a high-level window of another process) covers it.
        sys.bundles[777] = "com.apple.SecurityAgent"
        sys.stack = [FakeSystem.window(92, pid: 777, CGRect(x: 0, y: 0, width: 2000, height: 2000), owner: "SecurityAgent", layer: 1000),
                     sys.windows[77]!]
        await expect("refused", reason: "auth_dialog") { try await self.act(.click(CUClickAction(point: [50, 60], shotId: s)), foreground: true) }
        // The helper's own (click-through) windows are ignored; the target is on top.
        sys.stack = [FakeSystem.window(93, pid: getpid(), CGRect(x: 100, y: 100, width: 300, height: 200), owner: "Winter Computer Use"),
                     sys.windows[77]!]
        let r = try await act(.click(CUClickAction(point: [50, 60], shotId: s)), foreground: true)
        XCTAssertEqual(r.rung, 4)
        XCTAssertEqual(poster.entries.map(\.type), [.leftMouseDown, .leftMouseUp])
        XCTAssertTrue(poster.entries.allSatisfy { $0.route == .hid && $0.location == point })
    }

    func testAForegroundDragStopsAndReleasesWhenSomethingCoversThePath() async throws {
        world(bundle: "org.blenderfoundation.blender")
        let s = shot()
        // Something covers the far half of the drag path.
        let cover = FakeSystem.window(94, pid: 556, CGRect(x: 500, y: 100, width: 400, height: 600), owner: "Notes")
        sys.stack = [cover, sys.windows[77]!]
        await expect("unsupported") {
            try await self.act(.drag(CUDragAction(from: CUDragEnd(point: [10, 10]), to: CUDragEnd(point: [700, 10]), shotId: s)),
                               foreground: true)
        }
        let types = poster.entries.map(\.type)
        XCTAssertEqual(types.first, .mouseMoved)
        XCTAssertEqual(types.last, .leftMouseUp, "the button is never left down")
        XCTAssertTrue(poster.entries.allSatisfy { $0.location.x < 500 }, "nothing was posted over the covering window")
    }

    // MARK: routing (I10, I11)

    func testEventsGoToTheWindowUnderThePointWithCleanFlags() async throws {
        world()
        let s = shot()
        // A sheet (its own window) of the same app over part of the bound window.
        let sheet = FakeSystem.window(88, pid: pid, CGRect(x: 300, y: 100, width: 400, height: 300))
        sys.stack = [sheet, sys.windows[77]!]
        try await act(.click(CUClickAction(point: [250, 50], shotId: s)))   // (350, 150): inside the sheet
        try await act(.click(CUClickAction(point: [10, 500], shotId: s)))   // (110, 600): only the window
        let downs = poster.entries.filter { $0.type == .leftMouseDown }
        XCTAssertEqual(downs.map(\.window), [88, 77])
        let modifierBits: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl, .maskSecondaryFn]
        XCTAssertTrue(poster.entries.allSatisfy { $0.flags.intersection(modifierBits).isEmpty })
    }

    // MARK: refs after useWindow

    func testANewWindowStartsNewRefsAndDropsTheDiffBase() {
        world()
        let old = ref(button)
        target.store(CUSnapshot(id: "t1.s1", scope: nil, header: CUStateHeader(appName: "A", windowTitle: nil, focusedRef: nil, settle: nil),
                                roots: []))
        target.resetForNewWindow()
        XCTAssertNil(target.refs.key(for: old), "an old window's ref reads stale")
        XCTAssertNil(target.snapshot("t1.s1"), "and the diff base is gone")
        XCTAssertGreaterThan(ref(button), old, "numbers never repeat")
    }
}
