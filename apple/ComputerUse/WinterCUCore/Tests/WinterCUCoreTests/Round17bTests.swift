import ApplicationServices
import Carbon
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 17b — the independent review of round 17: its probes, as real tests (each fails without its fix).
final class Round17bTests: XCTestCase {
    let pid: pid_t = 4646
    let window = fakeElement(80_001)
    let a = fakeElement(80_002)
    let b = fakeElement(80_003)
    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    private func world() {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 100, y: 100, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.put(app, [kAXWindowsAttribute: [window]])
        ax.put(window, [kAXChildrenAttribute: [a, b]])
        ax.add(a, role: kAXStaticTextRole, title: "A", frame: CGRect(x: 150, y: 250, width: 80, height: 24))
        ax.add(b, role: kAXStaticTextRole, title: "B", frame: CGRect(x: 400, y: 400, width: 80, height: 24))
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.example.app"
        let win = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 800, height: 600))
        sys.windows[77] = win
        sys.stack = [win]
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.app", appName: "App", isChromium: false,
                          mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    /// H1 (the review of round 17): a drag whose button went down before the user started working kept sending every
    /// move (not a "start" event) and its up — and the act said it was done. Now its next step stops it: the button is
    /// released where it stopped, nothing more moves, and the act ends user_working.
    func testADragStopsAtItsNextStepOnceTheUserWorksInTheTarget() async throws {
        world()
        var markedAt: Int?
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseDown, markedAt == nil else { return }
            sys.front = pid
            core.testUserInput(pid: pid, switching: false)  // the user clicks into T right after the agent's press
            markedAt = poster.entries.count
        }
        var threw: CUError?
        do {
            _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                         action: .drag(CUDragAction(from: CUDragEnd(ref: ref(a)), to: CUDragEnd(ref: ref(b)))),
                                                         access: .full, allowForeground: false, privatePath: false))
        } catch let e as CUError { threw = e }
        let after = Array(poster.entries.dropFirst(markedAt ?? 0))
        XCTAssertEqual(after.filter { $0.type == .leftMouseDragged }.count, 0, "no move after they started: \(after.map(\.type.rawValue))")
        XCTAssertEqual(after.map(\.type), [.leftMouseUp], "only the release, where it stopped")
        XCTAssertEqual(threw?.data?["reason"], .string("user_working"), threw?.message ?? "the act said it was done")
    }

    /// Round 17b: a click stopped between its down and its up (the user's work) still lets the up go — never a button
    /// left down in the app — and the act ends user_working.
    func testAClickStoppedBetweenItsDownAndUpStillReleasesTheButton() async throws {
        world()
        let button = fakeElement(80_004)
        ax.add(button, role: kAXGroupRole, title: "Canvas", frame: CGRect(x: 300, y: 300, width: 100, height: 100))
        ax.put(window, [kAXChildrenAttribute: [a, b, button]])
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseDown else { return }
            sys.front = pid
            core.testUserInput(pid: pid, switching: false)
        }
        do {
            _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
                                                         action: .click(CUClickAction(ref: ref(button))),
                                                         access: .full, allowForeground: false, privatePath: false))
            XCTFail("refused")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["reason"], .string("user_working"), e.message)
        }
        let downs = poster.entries.filter { $0.type == .leftMouseDown }.count
        let ups = poster.entries.filter { $0.type == .leftMouseUp }.count
        XCTAssertEqual(downs, 1)
        XCTAssertEqual(ups, downs, "the button released: \(poster.entries.map(\.type.rawValue))")
    }

    /// M1 (the review of round 17): the guard was not sticky — once it stopped a write, a later one went through when the
    /// user had left the target meanwhile. Now the rest of the act is refused.
    func testOnceStoppedTheGuardRefusesEveryLaterWriteOfTheAct() throws {
        world()
        let field = fakeElement(80_009)
        ax.owners[80_009] = pid
        XCTAssertThrowsError(try core.withActWriteGuard(target) {
            sys.front = pid
            core.testUserInput(pid: pid, switching: false)
            core.poster.post(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!, pid: pid, route: .publicPid, authenticate: false)
            XCTAssertThrowsError(try core.ax.set(field, kAXValueAttribute, "x" as CFString))
            sys.front = 1  // the user leaves T (the mark ends)
            core.poster.post(CGEvent(keyboardEventSource: nil, virtualKey: 1, keyDown: true)!, pid: pid, route: .publicPid, authenticate: false)
            XCTAssertThrowsError(try core.ax.set(field, kAXValueAttribute, "y" as CFString))
        }) { e in XCTAssertEqual((e as? CUError)?.data?["reason"], .string("user_working")) }
        XCTAssertTrue(poster.entries.isEmpty, "no key reached T: \(poster.entries.map(\.keycode))")
        XCTAssertTrue(ax.written.isEmpty, "no write reached T: \(ax.written)")
    }

    /// M1, the other half: the user works in T and LEAVES it before the act's next write — the write is still refused (they
    /// worked in it during the act), while a write in an act that began after they left goes.
    func testWorkDuringTheActStopsItsNextWriteEvenAfterTheyLeft() throws {
        world()
        let field = fakeElement(80_010)
        ax.owners[80_010] = pid
        XCTAssertThrowsError(try core.withActWriteGuard(target) {
            sys.front = pid
            core.testUserInput(pid: pid, switching: false)
            sys.front = 1  // gone again before the act wrote anything
            try core.ax.set(field, kAXValueAttribute, "x" as CFString)
        }) { e in XCTAssertEqual((e as? CUError)?.data?["reason"], .string("user_working")) }
        XCTAssertTrue(ax.written.isEmpty)
        try core.withActWriteGuard(target) { try core.ax.set(field, kAXValueAttribute, "y" as CFString) }
        XCTAssertEqual(ax.written, ["80010:\(kAXValueAttribute)"], "a new act after they left: not stopped")
    }

    /// M1 for AppleScript: once the send hook refused one event for the user's work, the rest of that run is refused too
    /// — even if the user has left the app meanwhile.
    func testAnAppleScriptStoppedOnceStaysStoppedForTheRun() {
        var working = true
        let state = CUAppleScriptRunner.HookState(boundPid: 4242, boundName: "Notes", deadline: Date().addingTimeInterval(5),
                                                  stop: { working ? "the user started working in Notes" : nil })
        state.original = { _, _, _, _, _, _, _, _ in OSErr(noErr) }
        var p: pid_t = 4242
        var addr = AEAddressDesc()
        _ = AECreateDesc(DescType(typeKernelProcessID), &p, MemoryLayout<pid_t>.size, &addr)
        defer { AEDisposeDesc(&addr) }
        var event = AppleEvent()
        _ = AECreateAppleEvent(AEEventClass(kAECoreSuite), AEEventID(kAEGetData), &addr, AEReturnID(kAutoGenerateReturnID),
                               AETransactionID(kAnyTransactionID), &event)
        defer { AEDisposeDesc(&event) }
        var reply = AppleEvent()
        let refCon = Unmanaged.passUnretained(state).toOpaque()
        let send = { () -> OSErr in
            withUnsafePointer(to: &event) { ev in
                CUAppleScriptRunner.sendHook(ev, &reply, AESendMode(kAEWaitReply), AESendPriority(kAENormalPriority), 60, nil, nil, refCon)
            }
        }
        XCTAssertEqual(send(), OSErr(errAEEventNotPermitted))
        working = false  // they left the app
        XCTAssertEqual(send(), OSErr(errAEEventNotPermitted), "the rest of the run stays refused")
    }
    /// M2 (the review of round 17): Secure Event Input was read only when a tap event came — a keyboard-only secure period
    /// (Tab into a password field, typing, Return: no event the tap sees) went unseen. The guardian's 4 Hz poll reads it
    /// with no event at all; and a synthetic event (the helper's own) reads nothing.
    func testSecureEventInputIsPolledWithNoTapEventAndNeverReadForASyntheticOne() {
        world()
        core.secureInputOverride = true
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: CUEventStamp.value, keycode: 0, now: 99)  // ours: not read
        XCTAssertFalse(core.guardianLock.withLock { core.guardianCore.secureInputMaybeOn(from: 98, to: 99.5) }, "a synthetic event reads nothing")
        core.pollSecureInput(now: 100)
        core.secureInputOverride = false
        core.pollSecureInput(now: 100.5)
        XCTAssertTrue(core.guardianLock.withLock { core.guardianCore.secureInputMaybeOn(from: 101 - 2.5, to: 101) },
                      "the poll saw the secure span with no tap event")
    }
}
