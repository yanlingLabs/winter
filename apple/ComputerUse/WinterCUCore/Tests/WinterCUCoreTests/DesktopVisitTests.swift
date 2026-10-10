import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Desktop visits (user ruling 2026-10-10): the helper never moves the user to another desktop without their
/// say (`needs_desktop_visit`), tries every background route first even with it, and with it does EXACTLY one
/// primitive on the window's desktop and brings the user back at once — verified, retried, said when it failed,
/// and never fighting a user who moved somewhere of their own. Driven on fakes: Space 1 is the user's, the
/// target's window 77 is on Space 2; activating the target takes macOS there, activating the user's app back.
final class DesktopVisitTests: XCTestCase {
    let pid: pid_t = 6060
    let user: pid_t = 1
    let window = fakeElement(96_001)
    let button = fakeElement(96_002)
    let userWindow = fakeElement(96_100)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!
    /// Whether activating the target brings its desktop forward, and activating the user's app takes it back.
    var arrives = true
    var returns = true

    private let frame = CGRect(x: 100, y: 100, width: 800, height: 600)

    private func world(bundle: String = "org.blenderfoundation.blender", privatePath: Bool = true) {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [AXUIElement]()])  // not in this desktop's AX list
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: frame)
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.put(window, [kAXChildrenAttribute: [button]])
        ax.add(button, role: kAXButtonRole, title: "Send", frame: CGRect(x: 150, y: 250, width: 80, height: 24),
               extra: [kAXParentAttribute: window])
        ax.setActions(button, [kAXPressAction])
        ax.add(userWindow, role: kAXWindowRole, title: "Mine", frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        ax.put(ax.application(user), [kAXFocusedWindowAttribute: userWindow])

        sys = FakeSystem()
        sys.running = [pid, user]
        sys.bundles[pid] = bundle
        var w = FakeSystem.window(77, pid: pid, frame, owner: "App")
        w.onScreen = false
        sys.windows[77] = w
        sys.stack = []
        sys.front = user
        sys.space = 1
        sys.onActivate = { [unowned self] activated in
            if activated == pid, arrives { onTargetsDesktop(true) }
            if activated == user, returns { onTargetsDesktop(false) }
        }

        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.secondsSinceUserInputOverride = { 1_000 }  // no physical input unless a test says so
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: bundle, appName: "App", isChromium: false,
                          mirror: false, windowID: 77, windowTitle: "Doc", privatePath: privatePath)
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        // A point hits no element (the hit test reads this tree): pointer input, not an AX press.
        core.treeReadOverride = { [unowned self] _ in
            [CUNode(ref: target.refs.ref(for: AXIdentity(element: window)), role: kAXWindowRole, frame: frame)]
        }
    }

    /// macOS showing the window's desktop (true) or the user's again (false).
    private func onTargetsDesktop(_ there: Bool) {
        sys.space = there ? 2 : 1
        sys.windows[77]?.onScreen = there
        sys.stack = there ? [sys.windows[77]!] : []
        ax.put(ax.application(pid), [kAXWindowsAttribute: there ? [window] : [AXUIElement]()])
    }

    private func shot() -> String {
        target.registerShot(anchor: .window(windowID: 77, regionOrigin: .zero), imageWidth: 800, imageHeight: 600,
                            points: CGSize(width: 800, height: 600)).id
    }

    private func click(_ s: String, foreground: Bool = false, visit: Bool? = nil, privatePath: Bool = false,
                       callId: String = "c") async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: callId,
                                                 action: .click(CUClickAction(point: [50, 60], shotId: s)), access: .full,
                                                 allowForeground: foreground, privatePath: privatePath, desktopVisit: visit))
    }

    @discardableResult
    private func expect(_ code: String, file: StaticString = #filePath, line: UInt = #line,
                        _ body: () async throws -> Void) async -> CUError? {
        do {
            try await body()
            XCTFail("expected \(code)", file: file, line: line)
        } catch let e as CUError {
            XCTAssertEqual(e.code, code, e.message, file: file, line: line)
            return e
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
        return nil
    }

    private var userView: CUUserView { CUUserView(space: sys.space, front: sys.front) }
    private let usersPlace = CUUserView(space: 1, front: 1)

    // MARK: never without the user's say

    func testAnActThatCantLandFromHereAsksForAVisitAndMovesNobody() async throws {
        world()
        let s = shot()
        // Pointer input that can't be addressed to a window off screen (the private event path off).
        let e = await expect("needs_desktop_visit") { _ = try await self.click(s) }
        XCTAssertEqual(e?.data?["why"], .string("act"))
        XCTAssertTrue(e?.message.contains("App's window is on another desktop") ?? false, e?.message ?? "")
        // With the foreground agreed — the rung-4 card's yes, or bypass — still not: that would move the desktop.
        await expect("needs_desktop_visit") {
            _ = try await self.core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "m",
                                                              action: .menu(CUMenuAction(path: ["File", "Save"])), access: .full,
                                                              allowForeground: true, privatePath: true))
        }
        XCTAssertTrue(sys.activated.isEmpty, "nobody was moved")
        XCTAssertEqual(userView, usersPlace)
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testAnAppHeldInFrontWhoseWindowWentToAnotherDesktopIsNotFollowedThere() async throws {
        world()
        onTargetsDesktop(true)
        sys.space = 1  // the window is here, on the user's desktop
        let held = try await core.targetForeground(TargetForegroundParams(targetId: "t1"))
        XCTAssertTrue(held.front)
        // Its window moves to another desktop meanwhile: the hold's implied foreground does not follow it there.
        onTargetsDesktop(false)
        sys.front = pid
        await expect("needs_desktop_visit") {
            _ = try await self.core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "m",
                                                              action: .menu(CUMenuAction(path: ["File", "Save"])), access: .full,
                                                              allowForeground: false, privatePath: true))
        }
        XCTAssertEqual(sys.activated, [pid], "only the hold's own activation, on the user's desktop")
    }

    // MARK: background first

    func testWithTheUsersSayAnActThatWorksInTheBackgroundNeverVisits() async throws {
        world()
        let r = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                         action: .click(CUClickAction(ref: target.refs.ref(for: AXIdentity(element: button)))),
                                                         access: .full, allowForeground: true, privatePath: true, desktopVisit: true))
        XCTAssertEqual(r.rung, 1, "pressed over accessibility where it is")
        XCTAssertNil(r.visit)
        XCTAssertTrue(sys.activated.isEmpty, "nobody was moved")
        XCTAssertEqual(ax.performed.filter { $0.hasSuffix(":AXPress") }.count, 1)
    }

    // MARK: the visit

    func testWithTheUsersSayTheActRunsOnceOnItsDesktopAndTheUserIsBroughtBack() async throws {
        world()
        let s = shot()
        var seenDuring: [CUUserView] = []
        poster.onPost = { [unowned self] _ in seenDuring.append(userView) }
        let r = try await click(s, visit: true)
        // Exactly the one primitive, with the real pointer on the window's own desktop (rung 4: the app is in front
        // there, the foreground implied inside the visit), hit-tested like any rung-4 click.
        XCTAssertEqual(r.rung, 4)
        XCTAssertEqual(poster.entries.map(\.type), [.leftMouseDown, .leftMouseUp])
        XCTAssertTrue(poster.entries.allSatisfy { $0.route == .hid && $0.location == CGPoint(x: 150, y: 160) })
        XCTAssertTrue(seenDuring.allSatisfy { $0 == CUUserView(space: 2, front: pid) }, "done on the window's desktop")
        // Back where the user was, verified: their own window raised (recorded before the visit), their app front.
        XCTAssertEqual(userView, usersPlace)
        XCTAssertEqual(sys.activated.first, pid)
        XCTAssertEqual(sys.activated.last, user)
        XCTAssertTrue(ax.performed.contains("\(96_100):AXRaise"), "the user's own window, recorded before: \(ax.performed)")
        XCTAssertTrue(ax.performed.contains("\(96_001):AXRaise"), "the target's window raised to reach its desktop")
        let visit = try XCTUnwrap(r.visit)
        XCTAssertTrue(visit.returned)
        XCTAssertNil(visit.userMoved)
        XCTAssertGreaterThanOrEqual(visit.ms, 0)
        XCTAssertFalse(core.isVisiting(target), "the visit is over")
        XCTAssertNil(core.visitStart())
    }

    func testAWindowThatNeverComesOnScreenBringsTheUserBackAndDoesNothing() async throws {
        world()
        arrives = false
        let s = shot()
        let e = await expect("unsupported") { _ = try await self.click(s, visit: true) }
        XCTAssertTrue(e?.message.contains("macOS did not show App's desktop — nothing was done there") ?? false, e?.message ?? "")
        guard case .object(let v)? = e?.data?["visit"] else { return XCTFail("the visit rides the error: \(String(describing: e?.data))") }
        XCTAssertEqual(v["returned"], .bool(true))
        XCTAssertTrue(poster.entries.isEmpty, "nothing was done")
        XCTAssertEqual(userView, usersPlace, "the activation was taken back")
        XCTAssertEqual(sys.activated, [pid, user])
    }

    func testAReturnThatFailsIsTriedOnceMoreThenSaidLoudly() async throws {
        world()
        returns = false
        let s = shot()
        let r = try await click(s, visit: true)
        let visit = try XCTUnwrap(r.visit)
        XCTAssertFalse(visit.returned)
        XCTAssertTrue(visit.detail?.contains("Winter could not bring the user back from App's desktop") ?? false, visit.detail ?? "")
        XCTAssertEqual(sys.activated.filter { $0 == user }.count, 2, "two attempts")
    }

    func testAUserWhoMovesSomewhereElseDuringTheVisitIsLeftThere() async throws {
        world()
        let s = shot()
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseUp else { return }
            // The user swipes to a third desktop and clicks into another app while the visit runs.
            core.noteHardwareInput(now: core.clock.nowSeconds() + 0.01)
            sys.space = 3
            sys.front = 555
        }
        let r = try await click(s, visit: true)
        let visit = try XCTUnwrap(r.visit)
        XCTAssertEqual(visit.userMoved, true)
        XCTAssertFalse(visit.returned)
        XCTAssertEqual(userView, CUUserView(space: 3, front: 555), "never fought")
        XCTAssertFalse(sys.activated.contains(user), "the user's app was not pulled back")
    }

    func testInputThatOnlyAllowedTheVisitNeverCountsAsTheUserMoving() async throws {
        world()
        // The user clicked "Switch now" a moment before (hardware input BEFORE the visit began).
        core.noteHardwareInput(now: core.clock.nowSeconds() - 0.05)
        let r = try await click(shot(), visit: true)
        XCTAssertEqual(r.visit?.returned, true)
        XCTAssertNil(r.visit?.userMoved)
        XCTAssertEqual(userView, usersPlace)
    }

    func testAFailureInsideTheVisitStillBringsTheUserBackAndCarriesTheVisit() async throws {
        world()
        let s = shot()
        // Something covers the point on the window's desktop: rung 4's hit test refuses.
        sys.onActivate = { [unowned self] activated in
            if activated == pid {
                onTargetsDesktop(true)
                sys.stack = [FakeSystem.window(91, pid: 555, CGRect(x: 120, y: 120, width: 100, height: 100), owner: "Other"),
                             sys.windows[77]!]
            }
            if activated == user { onTargetsDesktop(false) }
        }
        let e = await expect("unsupported") { _ = try await self.click(s, visit: true) }
        guard case .object(let v)? = e?.data?["visit"] else { return XCTFail("no visit on the error") }
        XCTAssertEqual(v["returned"], .bool(true))
        XCTAssertEqual(userView, usersPlace)
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testAVisitForgetsTheOffScreenPictureBaseline() async throws {
        world()
        _ = target.noteOffScreenShot(digest: 42, at: 1)
        _ = try await click(shot(), visit: true)
        XCTAssertNil(target.noteOffScreenShot(digest: 43, at: 2), "repainted on its desktop: freshness unknown again")
    }

    // MARK: the live picture

    private func liveParams(visit: Bool? = nil) -> TargetScreenshotParams {
        TargetScreenshotParams(targetId: "t1", budget: CUImageBudget(maxLongEdge: 800, quality: 0.7), live: true, desktopVisit: visit)
    }

    private func image() -> CUCapturedImage {
        CUCapturedImage(jpeg: Data([0xFF, 0xD8, 0xFF]), width: 800, height: 600, pointsRect: CGRect(x: 0, y: 0, width: 800, height: 600))
    }

    private func solid(gray: CGFloat) -> CGImage {
        let ctx = CGContext(data: nil, width: 80, height: 60, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: gray, green: gray, blue: gray, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 80, height: 60))
        return ctx.makeImage()!
    }

    func testALiveShotOfAWindowOnScreenIsAnOrdinaryCapture() async throws {
        world()
        onTargetsDesktop(true)
        sys.space = 1
        var streamCalls = 0
        core.windowCaptureOverride = { [unowned self] _, _, _ in streamCalls += 1; return image() }
        let r = try await core.targetScreenshot(liveParams())
        XCTAssertEqual(streamCalls, 1)
        XCTAssertNil(r.visit)
        XCTAssertTrue(sys.activated.isEmpty)
    }

    func testALiveShotOfAWindowElsewhereWhosePictureChangedThereNeedsNoVisit() async throws {
        world()
        var gray: CGFloat = 0.2
        core.privateCaptureOverride = { [unowned self] _, _ in solid(gray: gray) }
        core.windowCaptureOverride = { _, _, _ in XCTFail("no visit, no ScreenCaptureKit"); throw CUError.cancelled }
        // An earlier picture of it, different from now: the app draws there, so the picture is live.
        _ = try await core.targetScreenshot(TargetScreenshotParams(targetId: "t1", budget: CUImageBudget(maxLongEdge: 800, quality: 0.7)))
        gray = 0.7
        let r = try await core.targetScreenshot(liveParams())
        XCTAssertTrue(r.detail?.hasPrefix("live:") ?? false, r.detail ?? "")
        XCTAssertNil(r.visit)
        XCTAssertTrue(sys.activated.isEmpty)
    }

    func testALiveShotOfAWindowElsewhereNotKnownLiveAsksForAVisit() async throws {
        world()
        core.privateCaptureOverride = { [unowned self] _, _ in solid(gray: 0.4) }
        core.windowCaptureOverride = { _, _, _ in XCTFail("no capture without the user's say"); throw CUError.cancelled }
        let first = await expect("needs_desktop_visit") { _ = try await self.core.targetScreenshot(self.liveParams()) }
        XCTAssertEqual(first?.data?["why"], .string("live"), "freshness unknown is not live")
        let again = await expect("needs_desktop_visit") { _ = try await self.core.targetScreenshot(self.liveParams()) }
        XCTAssertEqual(again?.data?["why"], .string("live"), "unchanged is not live either")
        XCTAssertTrue(sys.activated.isEmpty)
    }

    func testWithTheUsersSayALiveShotIsTakenOnItsDesktopAndTheUserIsBroughtBack() async throws {
        world()
        core.privateCaptureOverride = { [unowned self] _, _ in solid(gray: 0.4) }
        var capturedOnScreen: [Bool] = []
        core.windowCaptureOverride = { [unowned self] id, _, _ in
            XCTAssertEqual(id, 77)
            capturedOnScreen.append(sys.windows[77]?.onScreen == true && sys.space == 2)
            return image()
        }
        let r = try await core.targetScreenshot(liveParams(visit: true))
        XCTAssertEqual(capturedOnScreen, [true], "captured once, there, on screen")
        let visit = try XCTUnwrap(r.visit)
        XCTAssertTrue(visit.returned)
        XCTAssertTrue(r.detail?.contains("on its own desktop, just now (live)") ?? false, r.detail ?? "")
        XCTAssertEqual(userView, usersPlace)
        XCTAssertEqual(sys.activated, [pid, user])
        // The shot maps clicks like any window shot.
        XCTAssertNoThrow(try target.shot(r.shotId))
    }

    func testAFailedLiveCaptureStillBringsTheUserBack() async throws {
        world()
        core.privateCaptureOverride = { [unowned self] _, _ in solid(gray: 0.4) }
        core.windowCaptureOverride = { _, _, _ in throw CUError.unsupported("capture failed") }
        let e = await expect("unsupported") { _ = try await self.core.targetScreenshot(self.liveParams(visit: true)) }
        guard case .object(let v)? = e?.data?["visit"] else { return XCTFail("no visit on the error") }
        XCTAssertEqual(v["returned"], .bool(true))
        XCTAssertEqual(userView, usersPlace)
    }

    func testAMinimizedWindowIsNotVisitedForALiveShot() async throws {
        world()
        // Off screen but in this desktop's AX list (minimized): a visit would not help.
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])
        core.privateCaptureOverride = { [unowned self] _, _ in solid(gray: 0.4) }
        let r = try await core.targetScreenshot(liveParams(visit: true))
        XCTAssertNil(r.visit)
        XCTAssertTrue(sys.activated.isEmpty)
    }

    // MARK: the fresh frame

    func testTheFreshFrameWaitEndsOnARepaintOrAStablePicture() {
        world()
        core.visitFreshMaxMs = 2_000
        core.visitFrameIntervalMs = 5
        core.visitFreshStableMs = 60
        var digests = [1, 1, 2]
        core.visitFrameDigestOverride = { _ in digests.isEmpty ? 2 : digests.removeFirst() }
        XCTAssertEqual(core.waitForFreshFrame(target), "repainted")
        core.visitFrameDigestOverride = { _ in 7 }
        let t0 = Date()
        XCTAssertEqual(core.waitForFreshFrame(target), "unchanged")
        XCTAssertLessThan(Date().timeIntervalSince(t0), 1.5, "an unchanged picture never waits for the bound")
        core.visitFrameDigestOverride = { _ in nil }
        XCTAssertEqual(core.waitForFreshFrame(target), "no sample")
    }

    func testTheSampledDigestSeesAChangeAnywhereOnItsStride() {
        var a = Data(repeating: 9, count: 10_000), b = a
        b[61 * 50] = 1
        XCTAssertNotEqual(CUCore.sampledDigest(a), CUCore.sampledDigest(b))
        a[61 * 50] = 1
        XCTAssertEqual(CUCore.sampledDigest(a), CUCore.sampledDigest(b))
    }

    // MARK: one at a time

    func testTheGateLetsOneVisitAtATime() async {
        let gate = CUVisitGate()
        await gate.acquire()
        let order = OrderBox()
        let second = Task {
            await gate.acquire()
            order.add("second")
            gate.release()
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
        order.add("first done")
        gate.release()
        await second.value
        XCTAssertEqual(order.items, ["first done", "second"])
    }
}

private final class OrderBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _items: [String] = []
    func add(_ s: String) { lock.withLock { _items.append(s) } }
    var items: [String] { lock.withLock { _items } }
}

extension DesktopVisitTests {
    /// The live guardian, running (a script is active, the private path on), sees the visit's own activation and
    /// Space change mid-visit: it neither yanks the user back before the primitive nor adopts the window's desktop
    /// as theirs — and after a failed return it still knows where they belong.
    func testTheLiveGuardianNeitherFightsNorAdoptsTheVisit() async throws {
        world()
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        let s = shot()
        var midVisit: [CUUserView] = []
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseDown else { return }
            core.onActivation(pid: pid)
            core.onSpaceChange()
            midVisit.append(userView)
        }
        let r = try await click(s, visit: true)
        XCTAssertEqual(midVisit, [CUUserView(space: 2, front: pid)], "not restored mid-visit")
        XCTAssertEqual(r.visit?.returned, true)
        XCTAssertEqual(core.guardianLock.withLock { core.guardianCore.view }, CUGuardedView(app: user, space: 1),
                       "the user's place was never moved to the window's desktop")
        XCTAssertFalse(core.guardianLock.withLock { core.guardianCore.visiting(now: core.clock.nowSeconds()) })
        XCTAssertTrue(core.takeGuardianNotes().isEmpty, "no theft was noted")
    }
}
