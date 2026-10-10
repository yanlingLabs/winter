import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Desktop visits (user rulings 2026-10-10): the helper never moves the user to another desktop without their
/// say (`needs_desktop_visit`), tries every background route first even with it, and with it takes the user to the
/// window's desktop ONCE for the whole stretch of work that needs it — every later primitive there runs with no
/// further switch — and brings them back right after the last one (a grace after it, the script's end, a cancel,
/// `visit.close`, another desktop needed), verified, retried, said when it failed, never fighting a user who moved
/// somewhere of their own. Driven on fakes: Space 1 is the user's; the target's window 77 is on Space 2, a second
/// app's window 88 on Space 3, a third app's window 99 on the user's own Space 1.
final class DesktopVisitTests: XCTestCase {
    let pid: pid_t = 6060
    let pid2: pid_t = 7070
    let pid3: pid_t = 8080
    let user: pid_t = 1
    let window = fakeElement(96_001)
    let button = fakeElement(96_002)
    let window2 = fakeElement(96_011)
    let window3 = fakeElement(96_021)
    let userWindow = fakeElement(96_100)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!
    var target2: CUTarget!
    var target3: CUTarget!
    var recorder: VisitRecorder!
    /// Whether bringing a window forward takes macOS to its desktop, and bringing the user's back returns them.
    var arrives = true
    var returns = true
    /// Another app's window covering the visited window's point (rung 4's hit test).
    var cover: CUWindowServerWindow?

    private let frame = CGRect(x: 100, y: 100, width: 800, height: 600)
    /// Each window's desktop.
    private let spaceOf: [UInt32: UInt64] = [77: 2, 88: 3, 99: 1]
    private func pidOf(_ wid: UInt32) -> pid_t { wid == 77 ? pid : wid == 88 ? pid2 : pid3 }

    @MainActor final class VisitRecorder: CUCoreEvents {
        var visits: [CUDesktopVisitEvent] = []
        nonisolated init() {}
        func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool) {}
        func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID) {}
        func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?,
                      frame: CGRect?, text: String?, count: Int?, button: String?) {}
        func targetLost(targetId: String, reason: String) {}
        func permissionsChanged(accessibility: Bool, screenRecording: Bool) {}
        func willSendEscape() {}
        func desktopVisited(_ visit: CUDesktopVisitEvent) { visits.append(visit) }
    }

    private func world(bundle: String = "org.blenderfoundation.blender", privatePath: Bool = true, accessible: Bool = true) {
        ax = FakeAX()
        for (el, wid) in [(window, UInt32(77)), (window2, 88), (window3, 99)] {
            ax.add(el, role: kAXWindowRole, title: "Doc", frame: frame)
            ax.windowIDs[AXIdentity(element: el)] = wid
        }
        ax.put(window, [kAXChildrenAttribute: [button]])
        ax.add(button, role: kAXButtonRole, title: "Send", frame: CGRect(x: 150, y: 250, width: 80, height: 24),
               extra: [kAXParentAttribute: window])
        ax.setActions(button, [kAXPressAction])
        ax.add(userWindow, role: kAXWindowRole, title: "Mine", frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        ax.put(ax.application(user), [kAXFocusedWindowAttribute: userWindow])
        ax.windowIDs[AXIdentity(element: userWindow)] = 500

        sys = FakeSystem()
        sys.running = [pid, pid2, pid3, user]
        sys.bundles[pid] = bundle
        sys.bundles[pid2] = "com.example.second"
        sys.bundles[pid3] = "com.example.third"
        for wid: UInt32 in [77, 88, 99] {
            sys.windows[wid] = FakeSystem.window(wid, pid: pidOf(wid), frame, owner: "App")
        }
        sys.front = user
        show(1)
        sys.onActivate = { [unowned self] activated in
            if activated == user { if returns { show(1) } } else if arrives, let wid = spaceOf.keys.first(where: { pidOf($0) == activated }) {
                show(spaceOf[wid]!)
            }
        }
        // macOS 26 (measured 2026-10-10): a window's element raised, then its app made frontmost, takes macOS to the
        // window's desktop; the app alone gets there only when it has no window on the user's desktop.
        sys.onFrontWindow = { [unowned self] p, wid, raised in
            if p == user { if returns { show(1) } } else if arrives, let space = spaceOf[wid], raised || !appHasWindowOnScreen(p) {
                show(space)
            }
        }

        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        // The HID idle state says "input just now" throughout: the visit's rules never read it (it counts synthetic
        // events too — the helper's own rung-4 clicks).
        core.secondsSinceUserInputOverride = { 0 }
        // Closes are said by `visit.close` or a test's own wait; the grace is long unless a test wants it.
        core.visitGraceMs = 30_000
        recorder = VisitRecorder()
        core.events = recorder
        func make(_ id: String, _ p: pid_t, _ b: String, _ wid: UInt32, _ el: AXUIElement) -> CUTarget {
            let t = CUTarget(id: id, sessionId: "s", pid: p, bundleId: b, appName: id == "t1" ? "App" : id == "t2" ? "Second" : "Third",
                             isChromium: false, mirror: false, windowID: wid, windowTitle: "Doc", privatePath: privatePath,
                             accessible: accessible)
            core.registerForTesting(t, windowElement: el)
            t.refs.beginGeneration()
            return t
        }
        target = make("t1", pid, bundle, 77, window)
        target2 = make("t2", pid2, "com.example.second", 88, window2)
        target3 = make("t3", pid3, "com.example.third", 99, window3)
        // A point hits no element (the hit test reads this tree): pointer input, not an AX press.
        core.treeReadOverride = { [unowned self] t in
            [CUNode(ref: t.refs.ref(for: AXIdentity(element: t.id == "t1" ? window : t.id == "t2" ? window2 : window3)),
                    role: kAXWindowRole, frame: frame)]
        }
    }

    /// An app with a window on screen (on the user's desktop) besides its bound one.
    private func appHasWindowOnScreen(_ p: pid_t) -> Bool {
        sys.windows.values.contains { $0.pid == p && $0.onScreen && spaceOf[$0.id] == nil }
    }

    /// macOS showing desktop `space`: its windows on screen and in their apps' AX lists, the others not.
    private func show(_ space: UInt64) {
        sys.space = space
        for (wid, s) in spaceOf { sys.windows[wid]?.onScreen = s == space }
        sys.stack = (space == 2 ? [cover].compactMap { $0 } : []) + spaceOf.filter { $0.value == space }.keys.sorted().compactMap { sys.windows[$0] }
        for (el, wid) in [(window, UInt32(77)), (window2, 88), (window3, 99)] {
            ax.put(ax.application(pidOf(wid)), [kAXWindowsAttribute: spaceOf[wid] == space ? [el] : [AXUIElement]()])
        }
    }

    private func shot(_ t: CUTarget? = nil) -> String {
        (t ?? target).registerShot(anchor: .window(windowID: (t ?? target).windowID, regionOrigin: .zero), imageWidth: 800,
                                   imageHeight: 600, points: CGSize(width: 800, height: 600)).id
    }

    /// A point click. With the private path on and no window-location setter (`.none`), an off-screen window can't
    /// be reached from here, so a visit is what would do it.
    private func click(_ t: CUTarget? = nil, visit: Bool? = nil, privatePath: Bool = true, callId: String = "c",
                       visitMaxMs: Int? = nil) async throws -> TargetActResult {
        let t = t ?? target!
        let s = shot(t)
        return try await core.targetAct(TargetActParams(targetId: t.id, sessionId: "s", callId: callId,
                                                        action: .click(CUClickAction(point: [50, 60], shotId: s)), access: .full,
                                                        allowForeground: false, privatePath: privatePath, desktopVisit: visit,
                                                        visitMaxMs: visitMaxMs))
    }

    private func close() async throws -> [CUVisitReport] {
        try await core.visitClose(VisitCloseParams(sessionId: "s")).visits
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

    /// Waits (polling) until `done`, at most `seconds`; true when it came.
    private func until(_ seconds: Double, _ done: () -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if done() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return done()
    }

    /// The visits announced so far (the main queue delivers them a moment after each close).
    private func visitEvents(_ count: Int) async -> [CUDesktopVisitEvent] {
        let end = Date().addingTimeInterval(2)
        while Date() < end {
            let got = await MainActor.run { recorder.visits }
            if got.count >= count { return got }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return await MainActor.run { recorder.visits }
    }

    /// No visit outlives its test (its grace and cap timers find nothing to close).
    override func tearDown() async throws {
        await core?.closeAllVisits()
    }

    private var fronted: [String] { sys.frontedWindows.map { "\($0.pid):\($0.windowID)" } }
    private var userView: CUUserView { CUUserView(space: sys.space, front: sys.front) }
    private let usersPlace = CUUserView(space: 1, front: 1)
    private var isOpen: Bool { core.visitLock.withLock { core.openVisit != nil } }

    // MARK: never without the user's say

    func testAnActThatCantLandFromHereAsksForAVisitAndMovesNobody() async throws {
        world()
        let e = await expect("needs_desktop_visit") { _ = try await self.click(privatePath: false) }
        XCTAssertEqual(e?.data?["why"], .string("act"))
        XCTAssertTrue(e?.message.contains("App's window is on another desktop") ?? false, e?.message ?? "")
        // With the foreground agreed — the rung-4 card's yes, or bypass — still not: that would move the desktop.
        await expect("needs_desktop_visit") {
            _ = try await self.core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "m",
                                                              action: .menu(CUMenuAction(path: ["File", "Save"])), access: .full,
                                                              allowForeground: true, privatePath: true))
        }
        XCTAssertTrue(sys.activated.isEmpty && sys.frontedWindows.isEmpty, "nobody was moved")
        XCTAssertEqual(userView, usersPlace)
        XCTAssertTrue(poster.entries.isEmpty)
        XCTAssertFalse(isOpen)
    }

    func testAnAppHeldInFrontWhoseWindowWentToAnotherDesktopIsNotFollowedThere() async throws {
        world()
        arrives = false
        sys.windows[77]?.onScreen = true  // on the user's desktop for the hold
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])
        let held = try await core.targetForeground(TargetForegroundParams(targetId: "t1"))
        XCTAssertTrue(held.front)
        show(1)  // its window goes to its own desktop
        sys.front = pid
        await expect("needs_desktop_visit") {
            _ = try await self.core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "m",
                                                              action: .menu(CUMenuAction(path: ["File", "Save"])), access: .full,
                                                              allowForeground: false, privatePath: true))
        }
        XCTAssertEqual(sys.activated, [pid], "only the hold's own activation, on the user's desktop")
    }

    func testWithTheUsersSayAnActThatWorksInTheBackgroundNeverVisits() async throws {
        world()
        let r = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                         action: .click(CUClickAction(ref: target.refs.ref(for: AXIdentity(element: button)))),
                                                         access: .full, allowForeground: true, privatePath: true, desktopVisit: true))
        XCTAssertEqual(r.rung, 1, "pressed over accessibility where it is")
        XCTAssertNil(r.inVisit)
        XCTAssertTrue(sys.activated.isEmpty && sys.frontedWindows.isEmpty, "nobody was moved")
        XCTAssertFalse(isOpen)
    }

    // MARK: one open visit for the whole stretch

    func testThreeBackToBackActsAreOneSwitchAndOneReturn() async throws {
        world()
        var seenDuring: [CUUserView] = []
        poster.onPost = { [unowned self] _ in seenDuring.append(userView) }
        for i in 0..<3 {
            let r = try await click(visit: true, callId: "c\(i)")
            XCTAssertEqual(r.rung, 4, "the real pointer on the window's own desktop (the foreground implied there)")
            XCTAssertEqual(r.inVisit, true)
            XCTAssertEqual(userView, CUUserView(space: 2, front: pid), "still there between the acts")
        }
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 3)
        XCTAssertTrue(seenDuring.allSatisfy { $0 == CUUserView(space: 2, front: pid) })
        XCTAssertEqual(fronted, ["6060:77"], "ONE switch there")
        let reports = try await close()
        XCTAssertEqual(fronted, ["6060:77", "1:500"], "and ONE return, by the user's own window")
        XCTAssertEqual(userView, usersPlace)
        XCTAssertEqual(reports.count, 1)
        XCTAssertEqual(reports.first?.actions, 3)
        XCTAssertEqual(reports.first?.returned, true)
        XCTAssertEqual(reports.first?.why, "act")
        XCTAssertEqual(reports.first?.targetId, "t1")
        XCTAssertTrue(reports.first?.visitId.hasPrefix("v") ?? false)
        let _v1 = try await close()
        XCTAssertEqual(_v1, [], "each report once")
        let events = await visitEvents(1)
        XCTAssertEqual(events.map(\.report), reports, "announced once, at the close")
        XCTAssertEqual(events.first?.callId, "c0", "named by the request that opened it")
    }

    func testTheVisitClosesAGraceAfterItsLastAction() async throws {
        world()
        core.visitGraceMs = CUCore.visitCloseGraceMs
        XCTAssertEqual(CUCore.visitCloseGraceMs, 1000)
        _ = try await click(visit: true)
        let done = Date()
        XCTAssertTrue(isOpen)
        let _v2 = await until(3) { userView == usersPlace && !isOpen }
        XCTAssertTrue(_v2, "brought back after the grace")
        let after = Date().timeIntervalSince(done)
        XCTAssertGreaterThan(after, 0.8, "not before the grace")
        XCTAssertLessThan(after, 2.0, "about a second after the last action")
        let _v3 = try await close().count
        XCTAssertEqual(_v3, 1)
    }

    func testANewActionInsideTheGraceKeepsTheVisitOpen() async throws {
        world()
        core.visitGraceMs = 400
        _ = try await click(visit: true, callId: "a")
        try await Task.sleep(nanoseconds: 250_000_000)
        _ = try await click(visit: true, callId: "b")
        try await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertTrue(isOpen, "the grace counts from the LAST action")
        let _v4 = await until(2) { !isOpen }
        XCTAssertTrue(_v4)
        XCTAssertEqual(fronted, ["6060:77", "1:500"])
        let _v5 = try await close().first?.actions
        XCTAssertEqual(_v5, 2)
    }

    func testReadsOfTheVisitedWindowRunThereAndKeepItOpen() async throws {
        world()
        core.privateCaptureOverride = { _, _ in nil }
        var captures: [Bool] = []
        core.windowCaptureOverride = { [unowned self] _, _, _ in
            captures.append(sys.windows[77]?.onScreen == true)
            return image()
        }
        _ = try await click(visit: true)
        // A live shot of the visited window is an on-screen capture there: no prompt, no further switch.
        let r = try await core.targetScreenshot(liveParams(visit: nil))
        XCTAssertEqual(r.inVisit, true)
        XCTAssertEqual(captures, [true])
        XCTAssertEqual(fronted, ["6060:77"])
        let _v6 = try await close().first?.actions
        XCTAssertEqual(_v6, 2)
    }

    func testTheScriptsEndAndACancelCloseTheVisit() async throws {
        world()
        _ = try await click(visit: true, callId: "c1")
        core.scriptActivity(sessionId: "s", active: false)
        let _v7 = await until(1) { userView == usersPlace && !isOpen }
        XCTAssertTrue(_v7, "the script ended: back at once")
        _ = try await click(visit: true, callId: "c2")
        XCTAssertTrue(isOpen)
        _ = try await core.cancel(CancelParams(callId: "c2"))
        let _v8 = await until(1) { userView == usersPlace && !isOpen }
        XCTAssertTrue(_v8, "a cancel of a request in it: back at once")
        _ = try await core.cancel(CancelParams(callId: "c2"))
        let _v9 = try await close().map(\.returned)
        XCTAssertEqual(_v9, [true, true])
    }

    func testTheSessionsEndClosesTheVisitAndDropsItsReports() async throws {
        world()
        _ = try await click(visit: true)
        _ = try await core.sessionEnded(SessionEndedParams(sessionId: "s"))
        XCTAssertEqual(userView, usersPlace)
        XCTAssertFalse(isOpen)
        let _v10 = try await close()
        XCTAssertEqual(_v10, [])
    }

    func testEscClosesEveryOpenVisit() async throws {
        world()
        _ = try await click(visit: true)
        await core.closeAllVisits()
        XCTAssertEqual(userView, usersPlace)
        XCTAssertFalse(isOpen)
    }

    func testTwoAppsOnTwoOtherDesktopsAreCloseThenOpen() async throws {
        world()
        let a = try await click(visit: true, callId: "a")
        XCTAssertEqual(a.inVisit, true)
        let b = try await click(target2, visit: true, callId: "b")
        XCTAssertEqual(b.inVisit, true)
        XCTAssertEqual(fronted, ["6060:77", "1:500", "7070:88"], "back home before the next desktop, never desktop to desktop")
        XCTAssertEqual(userView.space, 3)
        let reports = try await close()
        XCTAssertEqual(reports.map(\.targetId), ["t1", "t2"])
        XCTAssertEqual(reports.map(\.returned), [true, true])
        XCTAssertEqual(userView, usersPlace)
    }

    func testAPrimitiveNeedingTheUsersOwnDesktopClosesTheVisitFirstWithNoPrompt() async throws {
        world()
        _ = try await click(visit: true)
        XCTAssertEqual(userView.space, 2)
        // The third app's window is on the user's OWN desktop: no desktopVisit, and no needs_desktop_visit either.
        let r = try await click(target3, visit: nil, callId: "own")
        XCTAssertNil(r.inVisit)
        XCTAssertEqual(userView.space, 1, "the visit closed first; done where the user is")
        XCTAssertFalse(isOpen)
        XCTAssertFalse(fronted.contains("8080:99"), "never visited")
        let _v11 = try await close().count
        XCTAssertEqual(_v11, 1)
    }

    func testNeedsDesktopVisitIsNeverAnsweredWhileTheSessionSitsOnAnotherDesktop() async throws {
        world()
        _ = try await click(visit: true)
        var placeAtAnswer: CUUserView?
        do {
            _ = try await click(target2, visit: nil, callId: "other")
            XCTFail("needs its desktop")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "needs_desktop_visit")
            placeAtAnswer = userView
        }
        XCTAssertEqual(placeAtAnswer, usersPlace, "the open visit was closed before the answer (the daemon prompts meanwhile)")
        let _v12 = try await close().count
        XCTAssertEqual(_v12, 1)
    }

    // MARK: the way there and back

    func testAWindowThatNeverComesOnScreenBringsTheUserBackAndDoesNothing() async throws {
        world()
        arrives = false
        let e = await expect("unsupported") { _ = try await self.click(visit: true) }
        XCTAssertTrue(e?.message.contains("macOS did not show App's desktop — nothing was done there") ?? false, e?.message ?? "")
        guard case .object(let v)? = e?.data?["visit"] else { return XCTFail("the visit rides the error: \(String(describing: e?.data))") }
        XCTAssertEqual(v["returned"], .bool(true))
        XCTAssertTrue(poster.entries.isEmpty, "nothing was done")
        XCTAssertEqual(userView, usersPlace)
        XCTAssertFalse(isOpen)
        let _v13 = try await close().map(\.actions)
        XCTAssertEqual(_v13, [0], "reported like any visit")
        // The gate was given back: the next visit opens.
        arrives = true
        _ = try await click(visit: true)
        XCTAssertTrue(isOpen)
    }

    func testAReturnThatFailsIsTriedOnceMoreThenSaidLoudly() async throws {
        world()
        returns = false
        _ = try await click(visit: true)
        let closedNow = try await close()
        let report = try XCTUnwrap(closedNow.first)
        XCTAssertFalse(report.returned)
        XCTAssertTrue(report.detail?.contains("Winter could not bring the user back from App's desktop") ?? false, report.detail ?? "")
        XCTAssertEqual(fronted.filter { $0 == "1:500" }.count, 2, "two attempts")
    }

    func testAFailureInsideTheVisitLeavesItOpenAndTheCloseStillReturns() async throws {
        world()
        _ = try await click(visit: true)
        // Something covers the point on the window's desktop: rung 4's hit test refuses.
        cover = FakeSystem.window(91, pid: 555, CGRect(x: 120, y: 120, width: 100, height: 100), owner: "Other")
        show(2)
        let e = await expect("unsupported") { _ = try await self.click(visit: true, callId: "covered") }
        XCTAssertEqual(e?.data?["inVisit"], .bool(true))
        let _v14 = try await close().first?.returned
        XCTAssertEqual(_v14, true)
        XCTAssertEqual(userView, usersPlace)
    }

    func testTheVisitTargetsTheBoundWindowEvenWhenTheAppHasAWindowHere() async throws {
        world()
        sys.onActivate = { [unowned self] activated in
            // macOS activates the app in place (its other window is here): no Space switch for the app.
            if activated == user, returns { show(1) }
        }
        sys.windows[66] = FakeSystem.window(66, pid: pid, CGRect(x: 0, y: 0, width: 400, height: 300))  // its window here
        let r = try await click(visit: true)
        XCTAssertEqual(r.rung, 4)
        XCTAssertEqual(fronted.first, "6060:77", "the bound window")
        XCTAssertEqual(sys.frontedWindows.first?.raised, true, "its element raised (the app alone would stay here)")
        XCTAssertEqual(sys.frontedWindows.first?.main, true)
        _ = try await close()
        XCTAssertEqual(fronted.last, "1:500", "and back to the user's own window")
        XCTAssertEqual(userView, usersPlace)
    }

    func testWithThePrivatePathOffTheWindowIsStillBroughtForwardOverAccessibility() async throws {
        world(privatePath: false)
        core.privateCaptureOverride = { _, _ in nil }
        core.windowCaptureOverride = { [unowned self] _, _, _ in
            XCTAssertEqual(sys.space, 2)
            return image()
        }
        let r = try await core.targetScreenshot(liveParams(visit: true))
        XCTAssertEqual(r.inVisit, true, "no private call is needed: the element raised, the app made frontmost")
        XCTAssertEqual(sys.frontedWindows.first?.raised, true)
        _ = try await close()
        XCTAssertEqual(userView, usersPlace)
    }

    /// The live gate (2026-10-10): the Offspace window bound capture-only earlier, shown on its desktop since — its
    /// element is found now and raised (bringing the app forward alone would keep the user on their own desktop:
    /// the app has a window there).
    func testACaptureOnlyWindowIsRaisedByTheElementFoundNow() async throws {
        world(accessible: false)
        ax.remoteWindows[77] = window  // macOS exposes it now (by remote token, off this desktop)
        sys.windows[66] = FakeSystem.window(66, pid: pid, CGRect(x: 0, y: 0, width: 400, height: 300))  // its window here
        core.privateCaptureOverride = { _, _ in nil }
        core.windowCaptureOverride = { [unowned self] _, _, _ in
            XCTAssertTrue(sys.windows[77]?.onScreen == true)
            return image()
        }
        let r = try await core.targetScreenshot(liveParams(visit: true))
        XCTAssertEqual(r.inVisit, true)
        XCTAssertEqual(sys.frontedWindows.first.map { "\($0.pid):\($0.windowID):\($0.raised):\($0.main)" }, "6060:77:true:true",
                       "the window's own element, made main and raised")
        _ = try await close()
        XCTAssertEqual(userView, usersPlace)
    }

    func testACaptureOnlyWindowWithNoElementIsReachedOnlyWhenItsAppHasNoWindowHere() async throws {
        // No element anywhere, and the app has no window on the user's desktop: the app alone takes macOS there.
        world(accessible: false)
        core.privateCaptureOverride = { _, _ in nil }
        core.windowCaptureOverride = { [unowned self] _, _, _ in image() }
        let r = try await core.targetScreenshot(liveParams(visit: true))
        XCTAssertEqual(r.inVisit, true)
        XCTAssertEqual(sys.frontedWindows.first?.raised, false, "nothing to raise: the app alone")
        _ = try await close()
        XCTAssertEqual(userView, usersPlace)

        // With a window of the app on the user's desktop it would stay here: refused before anything moves.
        world(accessible: false)
        core.windowCaptureOverride = { [unowned self] _, _, _ in image() }
        sys.windows[66] = FakeSystem.window(66, pid: pid, CGRect(x: 0, y: 0, width: 400, height: 300))
        let e = await expect("unsupported") { _ = try await self.core.targetScreenshot(self.liveParams(visit: true)) }
        XCTAssertTrue(e?.message.contains("can't be brought forward on its desktop") ?? false, e?.message ?? "")
        XCTAssertTrue(e?.message.contains("nothing was moved") ?? false)
        XCTAssertTrue(sys.activated.isEmpty && sys.frontedWindows.isEmpty, "nothing was moved")
        XCTAssertEqual(userView, usersPlace)
        XCTAssertFalse(isOpen)
        // The gate was given back.
        sys.windows[66] = nil
        _ = try await core.targetScreenshot(liveParams(visit: true))
        XCTAssertTrue(isOpen)
    }

    func testAMacThatDoesNotFollowAnAppToItsDesktopIsNeverVisited() async throws {
        world()
        sys.followsActivation = false
        let e = await expect("unsupported") { _ = try await self.click(visit: true) }
        XCTAssertTrue(e?.message.contains("Desktop & Dock") ?? false, e?.message ?? "")
        XCTAssertTrue(sys.activated.isEmpty && sys.frontedWindows.isEmpty, "nothing was moved")
        XCTAssertEqual(userView, usersPlace)
        XCTAssertFalse(isOpen)
        // Unreadable is not "off".
        sys.followsActivation = nil
        _ = try await click(visit: true)
        XCTAssertTrue(isOpen)
    }

    func testTheWayBackRaisesTheUsersWindowAndPostsNothingIntoIt() async throws {
        world()
        _ = try await click(visit: true)
        _ = try await close()
        XCTAssertEqual(sys.frontedWindows.last.map { "\($0.pid):\($0.windowID):\($0.raised):\($0.main)" }, "1:500:true:true",
                       "the user's recorded window raised and made main again, their app made frontmost")
        XCTAssertTrue(poster.entries.allSatisfy { $0.pid != user }, "no event — no key-window record — ever reaches the user's app")
        XCTAssertEqual(userView, usersPlace)
    }

    func testArrivalNeedsTheDesktopToChange() async throws {
        world()
        core.visitArriveMs = 200
        sys.onFrontWindow = { [unowned self] p, wid, _ in
            if p == pid, wid == 77 { sys.windows[77]?.onScreen = true }  // on screen, but no Space switch
            if p == user, wid == 500 { show(1) }
        }
        core.windowCaptureOverride = { _, _, _ in XCTFail("not there"); throw CUError.cancelled }
        core.privateCaptureOverride = { _, _ in nil }
        await expect("unsupported") { _ = try await self.core.targetScreenshot(self.liveParams(visit: true)) }
        XCTAssertEqual(userView, usersPlace)
        XCTAssertEqual(fronted.filter { $0 == "6060:77" }.count, 2, "brought forward once more halfway, then given up")
    }

    func testASecondBringForwardHalfwayIsWhatGetsThere() async throws {
        world()
        core.visitArriveMs = 400
        var tries = 0
        sys.onFrontWindow = { [unowned self] p, wid, _ in
            if p == pid, wid == 77 { tries += 1; if tries == 2 { show(2) } }  // the first one leaves the app here
            if p == user { show(1) }
        }
        core.privateCaptureOverride = { _, _ in nil }
        core.windowCaptureOverride = { [unowned self] _, _, _ in image() }
        let r = try await core.targetScreenshot(liveParams(visit: true))
        XCTAssertEqual(r.inVisit, true)
        XCTAssertEqual(tries, 2)
        _ = try await close()
        XCTAssertEqual(userView, usersPlace)
    }

    // MARK: review of round 1 — late switches, the user's own window, an anchorless return

    func testASwitchThatLandsAfterTheArrivalDeadlineIsStillBroughtBack() async throws {
        world()
        core.visitArriveMs = 150
        core.visitLateSwitchMs = 1000
        let lock = NSLock()
        var calls = 0
        sys.onFrontWindow = { [unowned self] p, wid, _ in
            if p == pid, wid == 77 {
                // A busy app answers its AX calls late: the switch lands ~350 ms on, past the deadline (once).
                let first = lock.withLock { calls += 1; return calls == 1 }
                if first {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.35) { [unowned self] in sys.space = 2; sys.front = pid }
                }
            }
            if p == user { show(1) }
        }
        let e = await expect("unsupported") { _ = try await self.click(visit: true) }
        XCTAssertTrue(e?.message.contains("macOS did not show App's desktop") ?? false, e?.message ?? "")
        guard case .object(let v)? = e?.data?["visit"] else { return XCTFail("no visit on the error") }
        XCTAssertEqual(v["returned"], .bool(true))
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(userView, usersPlace, "the late switch was watched for and undone, never left standing")
        XCTAssertTrue(fronted.contains("1:500"), "brought back by the user's own window")
    }

    /// Review of round 2 (MEDIUM): the late-switch watch undid ANY change of the user's view for 1.2 s after a
    /// never-arrived visit's return — a ⌘-Tab of their own included. Their move is left alone and adopted.
    func testTheUserMovingDuringTheLateSwitchWatchIsLeftAlone() async throws {
        world()
        core.visitArriveMs = 150
        core.visitLateSwitchMs = 1000
        let mail: pid_t = 4242
        let lock = NSLock()
        var returned = false
        sys.onFrontWindow = { [unowned self] p, _, _ in
            guard p == user else { return }
            show(1)
            let first = lock.withLock { () -> Bool in defer { returned = true }; return !returned }
            if first {
                // 200 ms after being brought back the user ⌘-Tabs to Mail (a key: a hardware action).
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { [unowned self] in
                    core.noteHardwareInput(now: core.clock.nowSeconds())
                    sys.front = mail
                }
            }
        }
        let e = await expect("unsupported") { _ = try await self.click(visit: true) }
        guard case .object(let v)? = e?.data?["visit"] else { return XCTFail("no visit on the error") }
        XCTAssertEqual(v["userMoved"], .bool(true))
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(userView, CUUserView(space: 1, front: mail), "left where they went")
        XCTAssertEqual(fronted.filter { $0.hasPrefix("\(user):") }.count, 1, "brought back once, never again over their own move")
    }

    func testOnlyTheTargetsOwnLateSwitchIsUndone() {
        let before = CUUserView(space: 1, front: 1)
        XCTAssertTrue(CUCore.lateSwitchIsTheTarget(CUUserView(space: 2, front: pid), before: before, targetPid: pid,
                                                   targetWindowOnScreen: true, userActed: false))
        XCTAssertTrue(CUCore.lateSwitchIsTheTarget(CUUserView(space: 2, front: 1), before: before, targetPid: pid,
                                                   targetWindowOnScreen: true, userActed: false), "its window's desktop shown")
        XCTAssertFalse(CUCore.lateSwitchIsTheTarget(CUUserView(space: 1, front: 4242), before: before, targetPid: pid,
                                                    targetWindowOnScreen: false, userActed: false), "another app: not the target's switch")
        XCTAssertFalse(CUCore.lateSwitchIsTheTarget(CUUserView(space: 2, front: pid), before: before, targetPid: pid,
                                                    targetWindowOnScreen: true, userActed: true), "the user acted: theirs")
    }

    /// Review of round 2 (LOW): a recorded window of the user's that closed, or a newer one they opened during the
    /// visit, made the visit read "not back" and the return raise the OLD window over the new one.
    func testTheReturnNeverRaisesAClosedWindowOrOneOverTheUsersNewerWindow() async throws {
        world()
        _ = try await click(visit: true)
        XCTAssertTrue(isOpen)
        ax.dead.insert(AXIdentity(element: userWindow))  // the window the user was in closed meanwhile
        ax.drop(ax.application(user), kAXFocusedWindowAttribute)
        var closed = try await close()
        var report = try XCTUnwrap(closed.first)
        XCTAssertTrue(report.returned, report.detail ?? "")
        XCTAssertEqual(userView, usersPlace)
        XCTAssertEqual(fronted.filter { $0.hasPrefix("\(user):") }, ["\(user):0"], "their app brought back, no dead window raised, once")

        world()
        _ = try await click(visit: true)
        let newer = fakeElement(96_102)
        ax.add(newer, role: kAXWindowRole, title: "New", frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        ax.windowIDs[AXIdentity(element: newer)] = 502
        ax.put(ax.application(user), [kAXFocusedWindowAttribute: newer])  // a window the user's app opened meanwhile
        closed = try await close()
        report = try XCTUnwrap(closed.first)
        XCTAssertTrue(report.returned, report.detail ?? "")
        XCTAssertEqual(fronted.filter { $0.hasPrefix("\(user):") }, ["\(user):0"], "the old window never raised over the new one")
        XCTAssertFalse(ax.performed.contains("\(AXIdentity(element: userWindow)):AXRaise"))
    }

    func testTheReturnPutsTheUsersOwnWindowBackWhenTheirAppIsTheTarget() async throws {
        world()
        // The user is in the TARGET app, in its window 66 on their desktop; the visit is to its window 77 elsewhere.
        let mine = fakeElement(96_066)
        ax.add(mine, role: kAXWindowRole, title: "Mine too", frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        ax.windowIDs[AXIdentity(element: mine)] = 66
        sys.windows[66] = FakeSystem.window(66, pid: pid, CGRect(x: 0, y: 0, width: 400, height: 300))
        sys.front = pid
        ax.put(ax.application(pid), [kAXFocusedWindowAttribute: mine])
        let before = CUUserView(space: 1, front: pid)
        sys.onActivate = { _ in }  // activating the app alone moves nothing (it has a window on each desktop)
        sys.onFrontWindow = { [unowned self] p, wid, _ in
            guard p == pid else { return }
            if wid == 77 { show(2); ax.put(ax.application(pid), [kAXFocusedWindowAttribute: window]) }
            // The app's own window becomes its focused one again (and its desktop shows) only when it is made main.
            if wid == 66, sys.frontedWindows.last?.main == true { show(1); ax.put(ax.application(pid), [kAXFocusedWindowAttribute: mine]) }
        }
        _ = try await click(visit: true)
        XCTAssertEqual(userView, CUUserView(space: 2, front: pid))
        let closed = try await close()
        let report = try XCTUnwrap(closed.first)
        XCTAssertTrue(report.returned, report.detail ?? "")
        XCTAssertEqual(userView, before)
        XCTAssertEqual(ax.element(ax.application(pid), kAXFocusedWindowAttribute).flatMap { ax.windowID($0) }, 66,
                       "back in the window they were in, not merely in the app")
        XCTAssertEqual(sys.frontedWindows.last.map { "\($0.pid):\($0.windowID):\($0.main)" }, "\(pid):66:true")
    }

    func testAVisitWithNothingToAnchorTheReturnIsRefusedWhenTheUsersAppHasWindowsElsewhere() async throws {
        world()
        ax.drop(ax.application(user), kAXFocusedWindowAttribute)  // Finder showing only the Desktop, say
        var elsewhere = FakeSystem.window(501, pid: user, CGRect(x: 0, y: 0, width: 400, height: 300))
        elsewhere.onScreen = false
        sys.windows[501] = elsewhere
        sys.onSpace = true
        let e = await expect("unsupported") { _ = try await self.click(visit: true) }
        XCTAssertTrue(e?.message.contains("nothing was moved") ?? false, e?.message ?? "")
        XCTAssertTrue(sys.activated.isEmpty && sys.frontedWindows.isEmpty, "nothing was moved")
        XCTAssertEqual(userView, usersPlace)
        XCTAssertFalse(isOpen)
        // No window of the user's app anywhere else: the visit goes ahead.
        sys.windows[501] = nil
        _ = try await click(visit: true)
        XCTAssertTrue(isOpen)
    }

    /// Fix 8b: with the user's front app unreadable there is nowhere to bring them back — so nothing moves.
    func testAnUnreadableFrontAppIsNeverVisited() async throws {
        world()
        sys.front = nil
        let e = await expect("refused") { _ = try await self.click(visit: true) }
        XCTAssertEqual(e?.data?["reason"], .string("front_unknown"))
        XCTAssertTrue(e?.message.contains("Winter can't tell which app you are in") ?? false, e?.message ?? "")
        XCTAssertTrue(sys.activated.isEmpty && sys.frontedWindows.isEmpty, "nothing was moved")
        XCTAssertFalse(isOpen)
        let _v15 = try await close()
        XCTAssertEqual(_v15, [])
        // The gate was given back.
        sys.front = user
        _ = try await click(visit: true)
        XCTAssertTrue(isOpen)
    }

    // MARK: fix 3 — the user moving by themselves, and only then

    func testTheVisitsOwnSyntheticClickThatMovesTheViewNeverStrandsTheUser() async throws {
        world()
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseUp else { return }
            // The rung-4 click itself switches app and desktop (and the HID state counts it as input).
            sys.space = 3
            sys.front = 555
            core.onActivation(pid: 555)
            core.onSpaceChange()
        }
        _ = try await click(visit: true)
        let closedNow = try await close()
        let report = try XCTUnwrap(closedNow.first)
        XCTAssertTrue(report.returned)
        XCTAssertNil(report.userMoved)
        XCTAssertEqual(userView, usersPlace)
    }

    func testPointerMovesAloneNeverCountAsTheUserMoving() async throws {
        world()
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseUp else { return }
            core.noteHardwareInput(now: core.clock.nowSeconds() + 0.01, move: true)
            sys.space = 3
            sys.front = 555
            core.onSpaceChange()
        }
        _ = try await click(visit: true)
        XCTAssertTrue(isOpen, "a pointer move closes nothing")
        let closedNow = try await close()
        let report = try XCTUnwrap(closedNow.first)
        XCTAssertTrue(report.returned)
        XCTAssertEqual(userView, usersPlace)
    }

    func testAHardwareBackedSpaceChangeDuringTheVisitIsTheUsersAndClosesIt() async throws {
        world()
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseUp else { return }
            // The user swipes to a third desktop and is in another app there.
            core.noteHardwareInput(now: core.clock.nowSeconds() + 0.01)
            sys.space = 3
            sys.front = 555
            core.onSpaceChange()
        }
        _ = try await click(visit: true)
        let _v16 = await until(1) { !isOpen }
        XCTAssertTrue(_v16, "closed by the user's own move")
        let closedNow = try await close()
        let report = try XCTUnwrap(closedNow.first)
        XCTAssertEqual(report.userMoved, true)
        XCTAssertFalse(report.returned)
        XCTAssertEqual(userView, CUUserView(space: 3, front: 555), "never fought")
        XCTAssertFalse(fronted.contains("1:500"), "the user's window was not pulled back")
        XCTAssertEqual(core.guardianLock.withLock { core.guardianCore.view }, CUGuardedView(app: 555, space: 3), "their place now")
    }

    func testAVisitThatNeverArrivedAlwaysReturnsWhateverTheInput() async throws {
        world()
        arrives = false
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        sys.onFrontWindow = { [unowned self] p, wid, _ in
            if p == pid, wid == 77 {
                core.noteHardwareInput(now: core.clock.nowSeconds() + 0.01)
                sys.space = 3
                sys.front = 555
                core.onSpaceChange()
            }
            if p == user, wid == 500 { show(1) }
        }
        let e = await expect("unsupported") { _ = try await self.click(visit: true) }
        guard case .object(let v)? = e?.data?["visit"] else { return XCTFail("no visit on the error") }
        XCTAssertEqual(v["returned"], .bool(true))
        XCTAssertEqual(userView, usersPlace)
    }

    func testInputThatOnlyAllowedTheVisitNeverCountsAsTheUserMoving() async throws {
        world()
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        // The user clicked "Switch now" a moment before (hardware input BEFORE the visit began).
        core.noteHardwareInput(now: core.clock.nowSeconds() - 0.05)
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseUp else { return }
            core.onSpaceChange()
        }
        _ = try await click(visit: true)
        XCTAssertTrue(isOpen)
        let _v17 = try await close().first?.returned
        XCTAssertEqual(_v17, true)
    }

    func testTheLiveGuardianNeitherFightsNorAdoptsTheVisit() async throws {
        world()
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        var midVisit: [CUUserView] = []
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseDown else { return }
            core.onActivation(pid: pid)
            core.onSpaceChange()
            midVisit.append(userView)
        }
        _ = try await click(visit: true)
        XCTAssertEqual(midVisit, [CUUserView(space: 2, front: pid)], "not restored mid-visit")
        XCTAssertEqual(core.guardianLock.withLock { core.guardianCore.view }, CUGuardedView(app: user, space: 1),
                       "the user's place was never moved to the window's desktop")
        let _v18 = try await close().first?.returned
        XCTAssertEqual(_v18, true)
        XCTAssertFalse(core.guardianLock.withLock { core.guardianCore.visiting(now: core.clock.nowSeconds()) })
        XCTAssertTrue(core.takeGuardianNotes().isEmpty, "no theft was noted")
    }

    // MARK: A — the visit mode lasts the primitive's own deadline

    func testTheGuardianVisitModeCoversALongPrimitive() async throws {
        world()
        XCTAssertEqual(CUCore.visitModeSeconds(maxMs: nil), 10)
        XCTAssertEqual(CUCore.visitModeSeconds(maxMs: 5_000), 10)
        XCTAssertEqual(CUCore.visitModeSeconds(maxMs: 200_000), 200)
        XCTAssertEqual(CUCore.visitModeSeconds(maxMs: 10_000_000), 330)
        var during: [Bool] = []
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseDown else { return }
            let now = core.clock.nowSeconds()
            during.append(core.guardianLock.withLock { core.guardianCore.visiting(now: now + 150) })
        }
        _ = try await click(visit: true, visitMaxMs: 200_000)
        XCTAssertEqual(during, [true], "a 200 s primitive is the agent's own all the way")
        let now = core.clock.nowSeconds()
        XCTAssertFalse(core.guardianLock.withLock { core.guardianCore.visiting(now: now + 150) }, "idle again: the 60 s cap")
        XCTAssertTrue(core.guardianLock.withLock { core.guardianCore.visiting(now: now + 30) })
        _ = try await close()
    }

    // MARK: D — every visit announced at its close

    func testEveryVisitIsAnnouncedWhateverItsOutcome() async throws {
        world()
        _ = try await click(visit: true, callId: "ok")
        _ = try await close()
        _ = try await click(visit: true, callId: "cancelled")
        _ = try await core.cancel(CancelParams(callId: "cancelled"))
        _ = await until(1) { !isOpen }
        arrives = false
        _ = try? await click(visit: true, callId: "never")
        let events = await visitEvents(3)
        XCTAssertEqual(events.map(\.callId), ["ok", "cancelled", "never"])
        XCTAssertEqual(events.map(\.report.returned), [true, true, true])
        XCTAssertEqual(Set(events.map(\.report.visitId)).count, 3, "helper-unique ids")
    }

    // MARK: E — a cancellation still says it ran in the visit

    func testACancelledCaptureInsideTheVisitIsTheCancelledErrorWithItsVisit() async throws {
        world()
        core.privateCaptureOverride = { _, _ in nil }
        core.windowCaptureOverride = { _, _, _ in throw CancellationError() }
        let e = await expect("cancelled") { _ = try await self.core.targetScreenshot(self.liveParams(visit: true)) }
        XCTAssertEqual(e?.data?["inVisit"], .bool(true))
        let _v19 = try await close().first?.returned
        XCTAssertEqual(_v19, true)
        XCTAssertEqual(userView, usersPlace)
    }

    // MARK: 5c — the return refreshes the off-screen baseline

    func testTheCloseRefreshesTheBaselineSoOnlyAChangedPictureIsServedLive() async throws {
        world()
        var gray: CGFloat = 0.4
        core.privateCaptureOverride = { [unowned self] _, _ in solid(gray: gray) }
        core.windowCaptureOverride = { [unowned self] _, _, _ in image() }
        _ = try await core.targetScreenshot(liveParams(visit: true))
        _ = try await close()
        // The window server's copy changed since the close's baseline: the app draws there — served, no visit.
        gray = 0.7
        let live = try await core.targetScreenshot(liveParams(visit: nil))
        XCTAssertTrue(live.detail?.hasPrefix("live:") ?? false, live.detail ?? "")
        XCTAssertNil(live.inVisit)
        // Unchanged since: not known live — it needs the desktop again.
        await expect("needs_desktop_visit") { _ = try await self.core.targetScreenshot(self.liveParams(visit: nil)) }
        XCTAssertEqual(fronted, ["6060:77", "1:500"], "one visit only")
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
        show(2)
        sys.space = 1
        var streamCalls = 0
        core.windowCaptureOverride = { [unowned self] _, _, _ in streamCalls += 1; return image() }
        let r = try await core.targetScreenshot(liveParams())
        XCTAssertEqual(streamCalls, 1)
        XCTAssertNil(r.inVisit)
        XCTAssertTrue(sys.activated.isEmpty)
    }

    func testALiveShotOfAWindowElsewhereWhosePictureChangedThereNeedsNoVisit() async throws {
        world()
        var gray: CGFloat = 0.2
        core.privateCaptureOverride = { [unowned self] _, _ in solid(gray: gray) }
        core.windowCaptureOverride = { _, _, _ in XCTFail("no visit, no ScreenCaptureKit"); throw CUError.cancelled }
        _ = try await core.targetScreenshot(TargetScreenshotParams(targetId: "t1", budget: CUImageBudget(maxLongEdge: 800, quality: 0.7)))
        gray = 0.7
        let r = try await core.targetScreenshot(liveParams())
        XCTAssertTrue(r.detail?.hasPrefix("live:") ?? false, r.detail ?? "")
        XCTAssertNil(r.inVisit)
        XCTAssertTrue(sys.activated.isEmpty && sys.frontedWindows.isEmpty)
    }

    func testALiveShotOfAWindowElsewhereNotKnownLiveAsksForAVisit() async throws {
        world()
        core.privateCaptureOverride = { [unowned self] _, _ in solid(gray: 0.4) }
        core.windowCaptureOverride = { _, _, _ in XCTFail("no capture without the user's say"); throw CUError.cancelled }
        let first = await expect("needs_desktop_visit") { _ = try await self.core.targetScreenshot(self.liveParams()) }
        XCTAssertEqual(first?.data?["why"], .string("live"), "freshness unknown is not live")
        let again = await expect("needs_desktop_visit") { _ = try await self.core.targetScreenshot(self.liveParams()) }
        XCTAssertEqual(again?.data?["why"], .string("live"), "unchanged is not live either")
        XCTAssertTrue(sys.activated.isEmpty && sys.frontedWindows.isEmpty)
    }

    func testWithTheUsersSayALiveShotIsTakenOnItsDesktop() async throws {
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
        XCTAssertEqual(r.inVisit, true)
        XCTAssertTrue(r.detail?.contains("on its own desktop, just now (live)") ?? false, r.detail ?? "")
        XCTAssertNoThrow(try target.shot(r.shotId))
        let closedNow = try await close()
        let report = try XCTUnwrap(closedNow.first)
        XCTAssertEqual(report.why, "live")
        XCTAssertTrue(report.returned)
        XCTAssertEqual(userView, usersPlace)
        XCTAssertEqual(fronted, ["6060:77", "1:500"])
        XCTAssertFalse(sys.activated.contains(pid), "the app was never merely activated")
    }

    func testAMinimizedWindowIsNotVisitedForALiveShot() async throws {
        world()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])  // off screen but in this desktop's AX list
        core.privateCaptureOverride = { [unowned self] _, _ in solid(gray: 0.4) }
        let r = try await core.targetScreenshot(liveParams(visit: true))
        XCTAssertNil(r.inVisit)
        XCTAssertTrue(sys.activated.isEmpty && sys.frontedWindows.isEmpty)
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

    func testHardwareInputIsToldFromMovesAndFromSyntheticEvents() {
        let stamp = CUEventStamp.value
        XCTAssertEqual(CUHardwareInput.classify(type: .mouseMoved, sourcePid: 0, userData: 0), .move)
        XCTAssertEqual(CUHardwareInput.classify(type: .leftMouseDown, sourcePid: 0, userData: 0), .action)
        XCTAssertEqual(CUHardwareInput.classify(type: .keyDown, sourcePid: 0, userData: 0), .action)
        XCTAssertEqual(CUHardwareInput.classify(type: .scrollWheel, sourcePid: 0, userData: 0), .action)
        XCTAssertEqual(CUHardwareInput.classify(type: .leftMouseDown, sourcePid: 0, userData: stamp), .none, "the helper's own")
        XCTAssertEqual(CUHardwareInput.classify(type: .leftMouseDown, sourcePid: 4242, userData: 0), .none, "another process posted it")
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
