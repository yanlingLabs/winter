import ApplicationServices
import Carbon
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 17 (the review of round 16): I6 in flight at one chokepoint.
final class Round17Tests: XCTestCase {
    /// An Apple Event to `pid`: `core/getd` (get data) — one the policy allows for the bound app.
    private func getDataEvent(to pid: pid_t) -> AppleEvent {
        var p = pid
        var addr = AEAddressDesc()
        XCTAssertEqual(AECreateDesc(DescType(typeKernelProcessID), &p, MemoryLayout<pid_t>.size, &addr), OSErr(noErr))
        defer { AEDisposeDesc(&addr) }
        var event = AppleEvent()
        XCTAssertEqual(AECreateAppleEvent(AEEventClass(kAECoreSuite), AEEventID(kAEGetData), &addr, AEReturnID(kAutoGenerateReturnID),
                                          AETransactionID(kAnyTransactionID), &event), OSErr(noErr))
        return event
    }

    private static let sentNothing: OSASendProcPtr = { _, _, _, _, _, _, _, _ in OSErr(noErr) }

    /// H1 (AppleScript): the user's work was checked only at the run's start; the send hook now asks before EVERY event —
    /// once they work in the bound app, the next event is not sent, and the run says why. Not the policy's refusal: the
    /// same event passes with nobody working.
    func testAnAppleScriptsNextEventIsNotSentOnceTheUserWorksInTheApp() {
        var working = false
        let state = CUAppleScriptRunner.HookState(boundPid: 4242, boundName: "Notes", deadline: Date().addingTimeInterval(5),
                                                  stop: { working ? "the user started working in Notes" : nil })
        state.original = Self.sentNothing
        var event = getDataEvent(to: 4242)
        defer { AEDisposeDesc(&event) }
        var reply = AppleEvent()
        let refCon = Unmanaged.passUnretained(state).toOpaque()
        let send = { () -> OSErr in
            withUnsafePointer(to: &event) { ev in
                CUAppleScriptRunner.sendHook(ev, &reply, AESendMode(kAEWaitReply), AESendPriority(kAENormalPriority), 60, nil, nil, refCon)
            }
        }
        XCTAssertEqual(send(), OSErr(noErr), "allowed while nobody works in the app")
        XCTAssertNil(state.stopped)
        working = true
        XCTAssertEqual(send(), OSErr(errAEEventNotPermitted), "not sent once they work in it")
        XCTAssertEqual(state.stopped, "the user started working in Notes")
        XCTAssertNil(state.refused, "the policy allowed it — the user's work stopped it")
    }

    /// H1's chokepoint, directly: outside an act nothing is guarded (a restore, the guardian); inside one, once the user
    /// works in the target, a write to one of ITS elements is refused while a write to another app's (a restore of the
    /// user's app inside the act) still goes.
    func testTheWriteGuardRefusesOnlyTheTargetsWritesOnlyInsideAnAct() throws {
        let ax = FakeAX()
        let sys = FakeSystem()
        let pid: pid_t = 5454, user: pid_t = 1
        sys.running = [pid, user]
        sys.front = pid
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let t = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.editor", appName: "Editor",
                         isChromium: false, mirror: false, windowID: 77, windowTitle: "Doc")
        let field = fakeElement(93_002)
        core.testUserInput(pid: pid, switching: false)
        XCTAssertTrue(core.userIsWorking(in: pid))
        try core.ax.set(field, kAXSelectedTextRangeAttribute, kCFBooleanTrue)  // no act: not guarded
        XCTAssertEqual(ax.written.count, 1)
        XCTAssertThrowsError(try core.withActWriteGuard(t) {
            try? core.ax.set(core.ax.application(user), kAXFrontmostAttribute, kCFBooleanTrue)  // the user's app: goes
            XCTAssertThrowsError(try core.ax.set(field, kAXSelectedTextRangeAttribute, kCFBooleanTrue))  // the target's: refused
            XCTAssertThrowsError(try core.ax.perform(core.ax.application(pid), kAXRaiseAction))
        }) { e in XCTAssertEqual((e as? CUError)?.data?["reason"], .string("user_working")) }
        XCTAssertEqual(ax.written, ["93002:\(kAXSelectedTextRangeAttribute)", "\(user):\(kAXFrontmostAttribute)"])
        XCTAssertTrue(ax.performed.isEmpty)
    }
    /// The poster's guard stops what STARTS something; once it stopped one, an up goes only for a down that went (a key down
    /// sent before the user started keeps its up — nothing held down in the app), and a lone up or drag for a click whose
    /// down never went is not sent.
    func testThePosterGuardPairsUpsWithTheDownsThatWent() throws {
        let poster = RecordingPoster()
        let sys = FakeSystem()
        let pid: pid_t = 5454
        sys.running = [pid, 1]
        sys.front = pid
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let t = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.editor", appName: "Editor",
                         isChromium: false, mirror: false, windowID: 77, windowTitle: "Doc")
        func post(_ type: CGEventType) {
            let e = CGEvent(source: nil)!
            e.type = type
            core.poster.post(e, pid: pid, route: .publicPid, authenticate: false)
        }
        XCTAssertThrowsError(try core.withActWriteGuard(t) {
            post(.keyDown)                                   // before they work: goes
            core.testUserInput(pid: pid, switching: false)   // they start working in it
            post(.keyUp)                                     // its up: goes
            post(.leftMouseDown)                             // a click: stopped
            post(.leftMouseDragged)                          // its drag and up: never sent alone
            post(.leftMouseUp)
            post(.keyDown)                                   // another key: stopped, and its up with it
            post(.keyUp)
        }) { e in XCTAssertEqual((e as? CUError)?.data?["reason"], .string("user_working")) }
        XCTAssertEqual(poster.entries.map(\.type), [.keyDown, .keyUp])
    }
}
