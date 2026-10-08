import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Live-gate bugs, against fakes: an Electron editor that reports no focused element (typing was refused as
/// a "password field"), the payment-field floor, a window screenshot of a window on another Space, and an
/// AX action the app lists but refuses (Finder's AXOpen).
final class FocusAndCaptureTests: XCTestCase {
    let pid: pid_t = 4545
    let window = fakeElement(70_001)
    let webArea = fakeElement(70_002)
    let editor = fakeElement(70_003)
    let button = fakeElement(70_004)
    let password = fakeElement(70_005)
    let card = fakeElement(70_006)
    let icon = fakeElement(70_007)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    /// VS Code, shaped like the live run: the editor's hidden text area says it is focused (`AXFocused`), but
    /// neither the app nor the window reports a focused element.
    private func electron(editorFocused: Bool = true, extra: [AXUIElement] = [], onScreen: Bool = true) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: onScreen ? [window] : [AXUIElement]()])
        ax.add(window, role: kAXWindowRole, title: "game.js", frame: CGRect(x: 0, y: 0, width: 1200, height: 800))
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.put(window, [kAXChildrenAttribute: [webArea]])
        ax.add(webArea, role: "AXWebArea", title: "game.js", extra: [kAXChildrenAttribute: [editor, button] + extra])
        ax.add(editor, role: kAXTextAreaRole,
               title: "The editor is not accessible at this time. To enable screen reader optimized mode, use Shift+Option+F1",
               frame: CGRect(x: 300, y: 200, width: 1, height: 18), extra: [kAXFocusedAttribute: editorFocused])
        ax.setActions(editor, [kAXShowMenuAction])
        ax.add(button, role: kAXButtonRole, title: "Run", frame: CGRect(x: 10, y: 10, width: 40, height: 20))
        ax.setActions(button, [kAXPressAction, kAXShowMenuAction])
        ax.add(password, role: kAXTextFieldRole, subrole: kAXSecureTextFieldSubrole, title: "Token",
               frame: CGRect(x: 10, y: 100, width: 200, height: 20))
        ax.add(card, role: kAXTextFieldRole, title: "Card number", frame: CGRect(x: 10, y: 140, width: 200, height: 20))
        ax.add(icon, role: kAXImageRole, title: "minecraft luna", frame: CGRect(x: 400, y: 400, width: 64, height: 64))
        ax.setActions(icon, ["AXOpen", kAXShowMenuAction])

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.microsoft.VSCode"
        var w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 1200, height: 800), owner: "Code")
        w.onScreen = onScreen
        sys.windows[77] = w
        sys.stack = onScreen ? [w] : []
        sys.front = 1

        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.microsoft.VSCode", appName: "Code",
                          isChromium: true, mirror: false, windowID: 77, windowTitle: "game.js")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    @discardableResult
    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: true))
    }

    @discardableResult
    private func expect(_ code: String, reason: String? = nil, file: StaticString = #filePath, line: UInt = #line,
                        _ body: () async throws -> Void) async -> CUError? {
        do {
            try await body()
            XCTFail("expected \(code)", file: file, line: line)
        } catch let e as CUError {
            XCTAssertEqual(e.code, code, e.message, file: file, line: line)
            if let reason { XCTAssertEqual(e.data?["reason"], .string(reason), e.message, file: file, line: line) }
            return e
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
        return nil
    }

    // MARK: 1. focus

    func testAnElectronEditorThatReportsNoFocusStillTakesTyping() async throws {
        electron()
        XCTAssertNil(ax.focusedElement(pid: pid), "the app reports no focused element, as VS Code did")
        try await act(.type(CUTypeAction(text: "// winter been here")))
        XCTAssertEqual(poster.keyDowns.count, 19)
        try await act(.key(CUKeyAction(combo: "/")))
        try await act(.key(CUKeyAction(combo: "space")))
        try await act(.key(CUKeyAction(combo: "cmd+v")))
        XCTAssertEqual(poster.keyDowns.count, 22)
    }

    func testTheElementTheScriptClickedStandsInForTheFocus() async throws {
        electron(editorFocused: false)
        ax.makeSettable(editor, kAXSelectedTextAttribute)
        try await act(.click(CUClickAction(ref: ref(editor))))
        try await act(.type(CUTypeAction(text: "abc")))
        XCTAssertEqual(ax.written.last, "70003:AXSelectedText", "inserted over AX into the clicked text area")
    }

    func testTheWindowsReportedFocusComesBeforeAnyGuess() async throws {
        electron(extra: [password])
        ax.put(window, [kAXFocusedUIElementAttribute: password])
        await expect("refused", reason: "secure_field") { try await self.act(.type(CUTypeAction(text: "x"))) }
        ax.put(window, [kAXFocusedUIElementAttribute: editor])
        try await act(.type(CUTypeAction(text: "x")))
    }

    func testAnUnknownFocusIsRefusedOnlyWhenTheWindowHoldsASecureField() async throws {
        electron(extra: [password])
        let e = await expect("refused", reason: "focus_unknown") { try await self.act(.type(CUTypeAction(text: "x"))) }
        XCTAssertFalse(e?.message.contains("password field") ?? true, e?.message ?? "")
        XCTAssertTrue(e?.message.contains("doesn't report which field has keyboard focus") ?? false, e?.message ?? "")
        await expect("refused", reason: "focus_unknown") { try await self.act(.key(CUKeyAction(combo: "a"))) }
        XCTAssertTrue(poster.entries.isEmpty)
        // Naming the field works, until a tab could have carried the focus to the secure one.
        try await act(.type(CUTypeAction(text: "ok", into: ref(editor))))
        XCTAssertEqual(poster.keyDowns.count, 2)
        await expect("refused", reason: "focus_unknown") {
            try await self.act(.type(CUTypeAction(text: "a\tb", into: self.ref(self.editor))))
        }
        XCTAssertEqual(poster.keyDowns.suffix(2).map(\.keycode), [0, 48], "'a' and the tab, never the 'b'")
    }

    func testAPaymentFieldIsRefusedLikeAPasswordField() async throws {
        electron(extra: [card])
        ax.focus(pid: pid, on: card)
        await expect("refused", reason: "secure_field") { try await self.act(.type(CUTypeAction(text: "4242"))) }
        await expect("refused", reason: "secure_field") { try await self.act(.setValue(CUSetValueAction(ref: self.ref(self.card), value: "4242"))) }
        ax.focus(pid: pid, on: nil)
        await expect("refused", reason: "focus_unknown") { try await self.act(.type(CUTypeAction(text: "4242"))) }
        XCTAssertTrue(poster.entries.isEmpty)
        XCTAssertTrue(ax.written.isEmpty)
    }

    func testPaymentFieldClassifier() {
        func pay(_ texts: [String?], role: String = kAXTextFieldRole) -> Bool { CUFloors.isPaymentField(role: role, texts: texts) }
        XCTAssertTrue(pay(["Card number"]))
        XCTAssertTrue(pay([nil, nil, "1234 1234 1234 1234", nil, "cc-number"]))
        XCTAssertTrue(pay(["CVV"]))
        XCTAssertTrue(pay(["Security code (CVC)"]))
        XCTAssertTrue(pay(["Kartennummer"]))
        XCTAssertTrue(pay(["Numéro de carte"]))
        XCTAssertTrue(pay([nil, nil, nil, "cc-exp"]))
        XCTAssertFalse(pay(["Search"]))
        XCTAssertFalse(pay(["Password expiry"]))
        XCTAssertFalse(pay(["Discover more"]))
        XCTAssertFalse(pay(["The editor is not accessible at this time"], role: kAXTextAreaRole))
        XCTAssertFalse(pay(["Card number"], role: kAXStaticTextRole), "a label is not the input")
        XCTAssertTrue(CUNode(ref: 1, role: kAXTextFieldRole, payment: true).isSecure)
        XCTAssertFalse(CUNode(ref: 1, role: kAXTextAreaRole).isSecure)
    }

    func testTheWindowScanIsBoundedAndSaysWhenItCouldNotFinish() {
        electron(extra: [password])
        let partial = CUFloorScan.sensitiveScan(roots: [window], ax: ax, maxElements: 2)
        XCTAssertFalse(partial.complete)
        XCTAssertFalse(partial.clear, "an unfinished scan never clears typing blind")
        let full = CUFloorScan.sensitiveScan(roots: [window], ax: ax)
        XCTAssertTrue(full.sensitive)
        electron()
        let clean = CUFloorScan.sensitiveScan(roots: [window], ax: ax)
        XCTAssertTrue(clean.clear)
        XCTAssertEqual(clean.focused.count, 1)
    }

    // MARK: 2. screenshots of a window on another Space

    private func shotParams() -> TargetScreenshotParams {
        TargetScreenshotParams(targetId: "t1", budget: CUImageBudget(maxLongEdge: 800, quality: 0.7))
    }

    private func image() -> CUCapturedImage {
        CUCapturedImage(jpeg: Data([0xFF, 0xD8, 0xFF]), width: 800, height: 533, pointsRect: CGRect(x: 0, y: 0, width: 1200, height: 800))
    }

    private let streamFailure = CUError.unsupported("capture failed: Failed to start stream due to audio/video capture failure")

    func testAScreenshotThatFailsOffThisDesktopMovesTheWindowHereFirst() async throws {
        electron(onScreen: false)
        sys.moveSucceeds = true
        var calls = 0
        core.windowCaptureOverride = { [unowned self] _, _, _ in
            calls += 1
            if calls == 1 { throw streamFailure }
            return image()
        }
        let r = try await core.targetScreenshot(shotParams())
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(sys.moved, [77])
        XCTAssertTrue(r.detail?.contains("moved Code's window to this desktop") ?? false, r.detail ?? "")
    }

    func testAScreenshotOfAWindowThatCannotBeMovedIsWindowElsewhere() async throws {
        electron(onScreen: false)
        core.windowCaptureOverride = { [unowned self] _, _, _ in throw streamFailure }
        let e = await expect("window_elsewhere") { _ = try await self.core.targetScreenshot(self.shotParams()) }
        XCTAssertTrue(e?.message.contains("can't take a screenshot of Code's window while it is on another desktop") ?? false,
                      e?.message ?? "")
        XCTAssertFalse(e?.message.contains("Failed to start stream") ?? true, "never the raw ScreenCaptureKit failure")
    }

    func testAScreenshotFailureOnThisDesktopIsLeftAlone() async throws {
        electron()
        sys.moveSucceeds = true
        core.windowCaptureOverride = { [unowned self] _, _, _ in throw streamFailure }
        await expect("unsupported") { _ = try await self.core.targetScreenshot(self.shotParams()) }
        XCTAssertTrue(sys.moved.isEmpty)
    }

    // MARK: 3. an action the app lists but refuses

    private let refusedByApp = CUError(code: "unsupported", message: "AXOpen is not supported by this element",
                                       data: ["axError": .int(Int(AXError.actionUnsupported.rawValue))])

    func testAListedOpenTheAppRefusesBecomesADoubleClick() async throws {
        electron()
        ax.performError = refusedByApp
        let r = try await act(.action(CUAXAction(ref: ref(icon), name: "open")))
        XCTAssertEqual(r.rung, 2)
        XCTAssertTrue(r.detail?.contains("refused “open” over accessibility, so [\(ref(icon))] was double-clicked") ?? false,
                      r.detail ?? "")
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 2)
        XCTAssertEqual(ax.performed.count, 1)
        // Known now: the second time goes straight to the double-click.
        try await act(.action(CUAXAction(ref: ref(icon), name: "open")))
        XCTAssertEqual(ax.performed.count, 1)
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 4)
    }

    func testARefusedActionWithNoEquivalentLeavesTheState() async throws {
        electron()
        ax.setActions(icon, ["AXOpen", "AXCancel"])
        ax.performError = refusedByApp
        let e = await expect("unsupported") { try await self.act(.action(CUAXAction(ref: self.ref(self.icon), name: "cancel"))) }
        XCTAssertTrue(e?.message.contains("no longer listed") ?? false, e?.message ?? "")
        let hidden = CUCore.hiddenActions(target.refusedActions)
        XCTAssertEqual(hidden, [kAXImageRole: ["AXCancel"]])
        let node = CUNode(ref: 1, role: kAXGroupRole, children: [
            CUNode(ref: 2, role: kAXImageRole, actions: ["AXOpen", "AXCancel", kAXShowMenuAction]),
            CUNode(ref: 3, role: kAXButtonRole, actions: ["AXCancel"]),
        ])
        let shown = CUCore.removing(hidden, from: node)
        XCTAssertEqual(shown.children[0].actions, ["AXOpen", kAXShowMenuAction], "open still works, as a double-click")
        XCTAssertEqual(shown.children[1].actions, ["AXCancel"], "only for the role that refused it")
    }

    func testATimeoutIsNotARefusal() async throws {
        electron()
        ax.performError = CUError.busy()
        await expect("busy") { try await self.act(.action(CUAXAction(ref: self.ref(self.icon), name: "open"))) }
        XCTAssertTrue(target.refusedActions.isEmpty)
        XCTAssertTrue(poster.entries.isEmpty, "an AX action that may still land is never repeated as events")
    }
}
