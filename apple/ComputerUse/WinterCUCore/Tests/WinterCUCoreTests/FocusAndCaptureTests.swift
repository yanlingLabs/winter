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
    private func electron(editorFocused: Bool = true, extra: [AXUIElement] = [], onScreen: Bool = true,
                          privatePath: Bool = true) {
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
                          isChromium: true, mirror: false, windowID: 77, windowTitle: "game.js", privatePath: privatePath)
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

    /// A solid image (`alpha` 0 → nothing drawn, what an undrawn window comes back as).
    private func solid(_ w: Int, _ h: Int, alpha: CGFloat = 1) -> CGImage {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.9, alpha: alpha))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()!
    }

    /// Records the private captures; answers with `answer`.
    private func privateCapture(_ answer: CGImage?) -> () -> [CGRect] {
        var rects: [CGRect] = []
        core.privateCaptureOverride = { id, rect in
            XCTAssertEqual(id, 77)
            rects.append(rect)
            return answer
        }
        return { rects }
    }

    func testAWindowOffThisDesktopIsTakenFromTheWindowServerWithoutScreenCaptureKitOrAMove() async throws {
        electron(onScreen: false)
        sys.moveSucceeds = true
        var streamCalls = 0
        core.windowCaptureOverride = { [unowned self] _, _, _ in streamCalls += 1; return image() }
        let rects = privateCapture(solid(2400, 1600))
        let r = try await core.targetScreenshot(shotParams())
        XCTAssertEqual(streamCalls, 0, "off screen goes straight to the window server")
        XCTAssertEqual(rects(), [CGRect(x: 0, y: 0, width: 1200, height: 800)], "the window's whole frame, global points")
        XCTAssertEqual([r.width, r.height], [800, 533], "fitted to the budget like any capture")
        XCTAssertEqual(r.mime, "image/jpeg")
        XCTAssertNotNil(Data(base64Encoded: r.imageBase64).flatMap { CGImageSourceCreateWithData($0 as CFData, nil) })
        XCTAssertEqual(r.detail, "captured Code's window on another desktop (another Space or full screen): it is hidden there, so Code "
            + "may not be redrawing it and this image can be older than what was just done; to see what is really there, read it "
            + "(state() or find() text, or something the app counts, such as a word count), or take a screenshot once the user shows the window")
        XCTAssertTrue(sys.moved.isEmpty, "never moved here for a picture")
    }

    func testAnOffScreenImageUnchangedThroughInputSentSinceIsCalledStale() async throws {
        electron(onScreen: false)
        _ = privateCapture(solid(2400, 1600))
        let first = try await core.targetScreenshot(shotParams())
        XCTAssertFalse(first.detail?.contains("likely stale") ?? true, "nothing to compare with yet")
        let again = try await core.targetScreenshot(shotParams())
        XCTAssertFalse(again.detail?.contains("likely stale") ?? true, "no input since: the same picture is no news")
        target.lastActionMs = CUSystemClock().nowMs() + 1  // input sent after the last shot
        let after = try await core.targetScreenshot(shotParams())
        XCTAssertTrue(after.detail?.contains("unchanged since the screenshot 0 s ago although input was sent since, so it is likely stale") ?? false,
                      after.detail ?? "")
    }

    func testARegionOfAWindowElsewhereIsTheGlobalRectOfThatRegion() async throws {
        electron(onScreen: false)
        sys.windows[77]?.frame = CGRect(x: 100, y: 50, width: 1200, height: 800)
        core.windowCaptureOverride = { _, _, _ in XCTFail("no ScreenCaptureKit"); throw CUError.cancelled }
        let rects = privateCapture(solid(600, 400))
        let r = try await core.targetScreenshot(TargetScreenshotParams(targetId: "t1", region: [10, 20, 300, 200],
                                                                      budget: CUImageBudget(maxLongEdge: 800, quality: 0.7)))
        XCTAssertEqual(rects(), [CGRect(x: 110, y: 70, width: 300, height: 200)])
        XCTAssertEqual([r.width, r.height], [600, 400])
        // The shot maps onto the region inside the window, like a ScreenCaptureKit region.
        let shot = try target.shot(r.shotId)
        XCTAssertEqual(shot.anchor, .window(windowID: 77, regionOrigin: CGPoint(x: 10, y: 20)))
        XCTAssertEqual([shot.pointsWidth, shot.pointsHeight], [300, 200])
        await expect("invalid_params") {
            _ = try await self.core.targetScreenshot(TargetScreenshotParams(
                targetId: "t1", region: [5000, 5000, 10, 10], budget: CUImageBudget(maxLongEdge: 800, quality: 0.7)))
        }
    }

    func testABlankOrMissingImageOfAWindowElsewhereIsWindowElsewhere() async throws {
        electron(onScreen: false)
        var streamCalls = 0
        core.windowCaptureOverride = { [unowned self] _, _, _ in streamCalls += 1; throw streamFailure }
        for answer in [solid(400, 300, alpha: 0), nil] {
            _ = privateCapture(answer)
            let e = await expect("window_elsewhere") { _ = try await self.core.targetScreenshot(self.shotParams()) }
            XCTAssertTrue(e?.message.contains("can't take a screenshot of Code's window while it is on another desktop") ?? false,
                          e?.message ?? "")
        }
        XCTAssertEqual(streamCalls, 0)
        XCTAssertTrue(sys.moved.isEmpty)
    }

    func testWithThePrivatePathOffAWindowElsewhereIsWindowElsewhere() async throws {
        electron(onScreen: false, privatePath: false)
        sys.moveSucceeds = true
        core.windowCaptureOverride = { [unowned self] _, _, _ in throw streamFailure }
        let rects = privateCapture(solid(400, 300))
        let e = await expect("window_elsewhere") { _ = try await self.core.targetScreenshot(self.shotParams()) }
        XCTAssertFalse(e?.message.contains("Failed to start stream") ?? true, "never the raw ScreenCaptureKit failure")
        XCTAssertTrue(rects().isEmpty, "no private capture with the private path off")
        XCTAssertTrue(sys.moved.isEmpty)
    }

    func testAScreenshotFailureOnThisDesktopIsLeftAlone() async throws {
        electron()
        sys.moveSucceeds = true
        core.windowCaptureOverride = { [unowned self] _, _, _ in throw streamFailure }
        let rects = privateCapture(solid(400, 300))
        await expect("unsupported") { _ = try await self.core.targetScreenshot(self.shotParams()) }
        XCTAssertTrue(sys.moved.isEmpty)
        XCTAssertTrue(rects().isEmpty)
    }

    func testAWindowThatLeavesDuringTheCaptureIsTakenFromTheWindowServer() async throws {
        electron()
        core.windowCaptureOverride = { [unowned self] _, _, _ in
            // The user switched Spaces while ScreenCaptureKit was starting.
            sys.windows[77]?.onScreen = false
            ax.put(ax.application(pid), [kAXWindowsAttribute: [AXUIElement]()])
            throw streamFailure
        }
        let rects = privateCapture(solid(1200, 800))
        let r = try await core.targetScreenshot(shotParams())
        XCTAssertEqual(rects().count, 1)
        XCTAssertTrue(r.detail?.contains("captured Code's window on another desktop") ?? false, r.detail ?? "")
    }

    func testAMinimizedWindowTriesTheWindowServerThenScreenCaptureKit() async throws {
        electron(onScreen: true)
        sys.windows[77]?.onScreen = false  // minimized: off screen, still listed by AX
        var streamCalls = 0
        core.windowCaptureOverride = { [unowned self] _, _, _ in streamCalls += 1; return image() }
        _ = privateCapture(solid(1200, 800))
        let fromServer = try await core.targetScreenshot(shotParams())
        XCTAssertEqual(streamCalls, 0)
        XCTAssertTrue(fromServer.detail?.contains("captured Code's window while it is not on screen (minimized or hidden)") ?? false,
                      fromServer.detail ?? "")
        _ = privateCapture(solid(1200, 800, alpha: 0))
        let fromStream = try await core.targetScreenshot(shotParams())
        XCTAssertEqual(streamCalls, 1, "nothing from the window server: ScreenCaptureKit may still have it")
        XCTAssertNil(fromStream.detail)
    }

    func testAWholeWindowImageIsCroppedOnlyWhenItIsTheWholeFrame() {
        let frame = CGRect(x: -33, y: 144, width: 920, height: 464)
        let whole = solid(1840, 928)
        let part = CUSkyLight.crop(wholeWindow: whole, frame: frame, to: CGRect(x: 0, y: 200, width: 100, height: 50))
        XCTAssertEqual(part.map { [$0.width, $0.height] }, [200, 100])
        XCTAssertTrue(CUSkyLight.crop(wholeWindow: whole, frame: frame, to: frame) === whole)
        // Clipped at the display's left edge (887 of 920 points): cannot be mapped onto the window.
        XCTAssertNil(CUSkyLight.crop(wholeWindow: solid(1774, 928), frame: frame, to: frame))
        XCTAssertNil(CUSkyLight.crop(wholeWindow: whole, frame: frame, to: CGRect(x: 5000, y: 0, width: 10, height: 10)))
        XCTAssertTrue(CUSkyLight.none.captureWithSkyLight(windowIDs: [77]).isEmpty, "nothing without the symbols")
        XCTAssertFalse(CUSkyLight.none.canCaptureWindows)
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
