import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The arrival gate (CUCore+CursorArrival; WinterCUPresentation's DESIGN-cursor.md, "Arrival"): an act's input waits for
/// the on-screen agent cursor to arrive — the shell's answer, asked behind the act's own cursor event — and never longer
/// than the cap per place it lands on. Against fakes and a simulated clock: the pauses are the clock's, not real time.
final class CursorArrivalGateTests: XCTestCase {
    /// Simulated milliseconds: a pause advances it and is recorded.
    final class ArrivalClock: CUClock, @unchecked Sendable {
        private let lock = NSLock()
        private var _now: Double = 50_000
        private var _pauses: [Double] = []
        var now: Double { lock.withLock { _now } }
        var pauses: [Double] { lock.withLock { _pauses } }
        func nowMs() -> Double { now }
        func sleep(ms: Double) async throws { pause(ms: ms) }
        func pause(ms: Double) {
            guard ms > 0 else { return }
            lock.withLock { _now += ms; _pauses.append(ms) }
        }
    }

    /// The shell's side: each cursor event, and the arrival it answers for the last one (by its kind).
    @MainActor final class Shell: CUCoreEvents {
        let clock: ArrivalClock
        var arrivalFor: [String: TimeInterval] = [:]
        var lastKind: String?
        /// (the kind it was asked about, the clock then).
        var asks: [(kind: String, atMs: Double)] = []
        var kinds: [String] = []
        init(clock: ArrivalClock) { self.clock = clock }
        func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool) {}
        func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID) {}
        func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?,
                      frame: CGRect?, text: String?, count: Int?, button: String?) {
            lastKind = kind
            kinds.append(kind)
        }
        func cursorArrival(sessionId: String, pid: pid_t, windowID: CGWindowID) -> TimeInterval {
            let kind = lastKind ?? "?"
            asks.append((kind, clock.now))
            return arrivalFor[kind] ?? 0
        }
        func targetLost(targetId: String, reason: String) {}
        func permissionsChanged(accessibility: Bool, screenRecording: Bool) {}
        func willSendEscape() {}
    }

    let pid: pid_t = 4747
    let window = fakeElement(81_001)
    let ok = fakeElement(81_002)
    let okFrame = CGRect(x: 300, y: 250, width: 60, height: 24)

    var ax: FakeAX!
    var sys: FakeSystem!
    var clock: ArrivalClock!
    var shell: Shell!
    var core: CUCore!
    var target: CUTarget!
    /// The clock when the AX press went out.
    var pressedAtMs: Double?

    @MainActor private func world(capMs: Double = 400, events: Bool = true) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 100, y: 100, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.put(app, [kAXWindowsAttribute: [window]])
        ax.put(window, [kAXChildrenAttribute: [ok]])
        ax.add(ok, role: kAXButtonRole, title: "OK", frame: okFrame)
        ax.setActions(ok, [kAXPressAction])
        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.example.app"
        let win = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 800, height: 600))
        sys.windows[77] = win
        sys.stack = [win]
        sys.front = 1
        clock = ArrivalClock()
        shell = Shell(clock: clock)
        core = CUCore(events: events ? shell : nil, clock: clock, skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.cursorArrivalCapMs = capMs
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.app", appName: "App", isChromium: false,
                          mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        let clock = self.clock!
        ax.onPerform = { [unowned self] what in if what.hasSuffix(":AXPress") { pressedAtMs = clock.now } }
    }

    private func pressOK() async throws {
        let ref = target.refs.ref(for: AXIdentity(element: ok))
        _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: .click(CUClickAction(ref: ref)),
                                                     access: .full, allowForeground: false, privatePath: true))
    }

    @MainActor func testThePressGoesOutNoEarlierThanTheCursorArrives() async throws {
        world()
        // The glide to the button takes 0.2 s and the reticle's dwell 0.05 s more (the press follows it).
        shell.arrivalFor = ["target": 0.2, "press": 0.05]
        let start = clock.now
        try await pressOK()
        XCTAssertEqual(shell.kinds, ["target", "press"])
        XCTAssertEqual(shell.asks.map(\.kind), ["target", "press"], "asked behind each of the act's own events, in order")
        XCTAssertEqual(clock.pauses, [200, 50])
        let pressed = try XCTUnwrap(pressedAtMs)
        XCTAssertEqual(pressed - start, 250, accuracy: 0.001, "the press lands when the arrow does")
        XCTAssertGreaterThanOrEqual(pressed, try XCTUnwrap(shell.asks.last).atMs + 50)
    }

    @MainActor func testNoWaitWhenNoCursorIsDrawn() async throws {
        world()
        // An overlay hidden (off screen, another desktop, covered), Reduce Motion, or the cursor already resting there:
        // the presentation answers 0.
        try await pressOK()
        XCTAssertEqual(shell.asks.count, 2, "still asked")
        XCTAssertEqual(clock.pauses, [], "nothing waited for")
        XCTAssertNotNil(pressedAtMs)
    }

    @MainActor func testTheCapHoldsForAReticleAndItsPressTogether() async throws {
        world()
        shell.arrivalFor = ["target": 2.0, "press": 2.0]  // a cursor far behind (a queue of glides)
        let start = clock.now
        try await pressOK()
        XCTAssertEqual(clock.pauses, [400], "the reticle's wait spends the whole budget; its press is not held again")
        XCTAssertEqual(shell.asks.map(\.kind), ["target"], "a spent budget asks nothing")
        XCTAssertEqual(try XCTUnwrap(pressedAtMs) - start, 400, accuracy: 0.001)

        // The next act has its own budget.
        try await pressOK()
        XCTAssertEqual(clock.pauses, [400, 400])
    }

    @MainActor func testTheBudgetIsSharedWithinOnePlace() async throws {
        world()
        shell.arrivalFor = ["target": 0.3, "press": 0.3]
        try await pressOK()
        XCTAssertEqual(clock.pauses, [300, 100], "the press waits only what the reticle left of the 0.4 s")
    }

    @MainActor func testNoGateInTestCoresOrWithoutAShell() async throws {
        world(capMs: 0)
        shell.arrivalFor = ["target": 0.3, "press": 0.3]
        try await pressOK()
        XCTAssertTrue(shell.asks.isEmpty, "a core with no cap never asks")
        XCTAssertEqual(clock.pauses, [])

        world(events: false)
        try await pressOK()
        XCTAssertEqual(clock.pauses, [], "no shell, no cursor, no wait")
        XCTAssertNotNil(pressedAtMs)
    }

    func testOnlyPlaceBoundKindsAreGated() {
        XCTAssertEqual(CUCore.arrivalGated, ["target", "press", "type", "key", "scroll", "drag"])
        for kind in ["caption", "waitBegin", "waitEnd", "refused", "foreground", "done", "move", "idle"] {
            XCTAssertFalse(CUCore.arrivalGated.contains(kind), kind)
        }
    }
}
