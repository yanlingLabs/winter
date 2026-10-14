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
        /// Every pause, summed (the gate waits in 20 ms steps so an Esc ends it at once).
        var waited: Double { pauses.reduce(0, +) }
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
        /// Runs on the main queue when asked about `kind` (an Esc pressed meanwhile, a main thread kept busy).
        var onAsk: [String: () -> Void] = [:]
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
            onAsk[kind]?()
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
    let label = fakeElement(81_003)
    let labelFrame = CGRect(x: 400, y: 400, width: 100, height: 20)
    let webArea = fakeElement(81_004)
    let link = fakeElement(81_005)

    var ax: FakeAX!
    var sys: FakeSystem!
    var clock: ArrivalClock!
    var poster: RecordingPoster!
    var shell: Shell!
    var core: CUCore!
    var target: CUTarget!
    /// The clock when the AX press went out, and the real time then.
    var pressedAtMs: Double?
    var pressedAtReal: DispatchTime?
    var opened: [[String]] = []

    @MainActor private func world(capMs: Double = 400, events: Bool = true, bundle: String = "com.example.app") {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 100, y: 100, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.put(app, [kAXWindowsAttribute: [window]])
        ax.put(window, [kAXChildrenAttribute: [ok, label, webArea]])
        ax.add(ok, role: kAXButtonRole, title: "OK", frame: okFrame)
        ax.setActions(ok, [kAXPressAction])
        ax.add(label, role: kAXStaticTextRole, title: "Readme", frame: labelFrame)
        ax.add(webArea, role: "AXWebArea", extra: ["AXURL": URL(string: "https://mail.example.com/inbox")! as CFURL,
                                                   kAXChildrenAttribute: [link]])
        ax.add(link, role: "AXLink", title: "Story", frame: CGRect(x: 300, y: 400, width: 80, height: 20),
               extra: ["AXURL": URL(string: "https://news.example.org/a")! as CFURL, kAXParentAttribute: webArea])
        ax.setActions(link, [kAXPressAction])
        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = bundle
        let win = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 800, height: 600))
        sys.windows[77] = win
        sys.stack = [win]
        sys.front = 1
        clock = ArrivalClock()
        shell = Shell(clock: clock)
        poster = RecordingPoster()
        core = CUCore(events: events ? shell : nil, clock: clock, skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.cursorArrivalCapMs = capMs
        opened = []
        core.openDocumentsOverride = { [unowned self] p in
            opened.append(p.urls)
            return OpenDocumentsResult(app: CUBoundApp(name: "Browser", bundleId: "com.example.default", pid: 9), windowID: nil)
        }
        core.isWebBrowserOverride = { _ in false }
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: bundle, appName: "App", isChromium: false,
                          mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        let clock = self.clock!
        ax.onPerform = { [unowned self] what in
            if what.hasSuffix(":AXPress") { pressedAtMs = clock.now; pressedAtReal = .now() }
        }
    }

    private func pressOK() async throws { try await click(ok) }

    private func click(_ e: AXUIElement, foreground: Bool = false, viaDaemon: Bool? = nil) async throws {
        let ref = target.refs.ref(for: AXIdentity(element: e))
        _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: .click(CUClickAction(ref: ref)),
                                                     access: .full, allowForeground: foreground, privatePath: true,
                                                     linkOpensViaDaemon: viaDaemon))
    }

    /// The act's call is cancelled (the user's Esc reaches the daemon, which sends `cancel`) while the cursor is on its way.
    @MainActor private func escWhenAsked(_ kind: String) {
        shell.arrivalFor[kind] = 0.3
        shell.onAsk[kind] = { [core] in core!.cancels.cancel("c") }
    }

    private func expectCancelled(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await body()
            XCTFail("the act went on after the Esc", file: file, line: line)
        } catch let e as CUError {
            XCTAssertEqual(e.code, "cancelled", file: file, line: line)
        } catch {
            XCTFail("\(error)", file: file, line: line)
        }
    }

    @MainActor func testThePressGoesOutNoEarlierThanTheCursorArrives() async throws {
        world()
        // The glide to the button takes 0.2 s and the reticle's dwell 0.05 s more (the press follows it).
        shell.arrivalFor = ["target": 0.2, "press": 0.05]
        let start = clock.now
        try await pressOK()
        XCTAssertEqual(shell.kinds, ["target", "press"])
        XCTAssertEqual(shell.asks.map(\.kind), ["target", "press"], "asked behind each of the act's own events, in order")
        XCTAssertEqual(clock.waited, 250, accuracy: 0.001)
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
        XCTAssertEqual(clock.waited, 400, accuracy: 0.001, "the reticle's wait spends the whole budget; its press is not held again")
        XCTAssertEqual(shell.asks.map(\.kind), ["target"], "a spent budget asks nothing")
        XCTAssertEqual(try XCTUnwrap(pressedAtMs) - start, 400, accuracy: 0.001)

        // The next act has its own budget.
        try await pressOK()
        XCTAssertEqual(clock.waited, 800, accuracy: 0.001)
    }

    @MainActor func testTheBudgetIsSharedWithinOnePlace() async throws {
        world()
        shell.arrivalFor = ["target": 0.3, "press": 0.3]
        try await pressOK()
        XCTAssertEqual(shell.asks.map(\.kind), ["target", "press"])
        XCTAssertEqual(clock.waited, 400, accuracy: 0.001, "the press waits only what the reticle left of the 0.4 s")
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

    // MARK: Esc during the wait

    @MainActor func testAnEscWhileTheReticleArrivesPressesNothing() async throws {
        world()
        escWhenAsked("target")
        await expectCancelled { try await pressOK() }
        XCTAssertTrue(ax.performed.isEmpty, "no press: \(ax.performed)")
        XCTAssertEqual(clock.waited, 0, "the wait ended at the Esc")
        XCTAssertEqual(shell.asks.map(\.kind), ["target"], "and nothing more was shown or asked")
    }

    /// Rung 4: an Esc while the arrow travels to the point brings nothing forward and sends no input.
    @MainActor func testAnEscBeforeARung4ClickBringsNothingForward() async throws {
        world(bundle: "org.blenderfoundation.blender")
        escWhenAsked("press")
        await expectCancelled { try await click(label, foreground: true) }
        XCTAssertEqual(shell.kinds.prefix(3), ["target", "foreground", "press"])
        XCTAssertTrue(sys.activated.isEmpty, "the app was not brought forward: \(sys.activated)")
        XCTAssertTrue(poster.entries.isEmpty, "no input: \(poster.entries.count) events")
    }

    /// A link in an app that is not a browser is opened in the background (by the helper or the daemon) — not after an Esc.
    @MainActor func testAnEscBeforeALinkOpensNothing() async throws {
        world()
        escWhenAsked("press")
        await expectCancelled { try await click(link) }
        XCTAssertTrue(opened.isEmpty, "nothing opened: \(opened)")
        world()
        escWhenAsked("press")
        await expectCancelled { try await click(link, viaDaemon: true) }
        XCTAssertTrue(opened.isEmpty, "nor handed to the daemon")
    }

    // MARK: a busy main thread, a cursor known not drawn

    /// The main queue's answer is bounded by the budget in REAL time: a main thread busy for 0.3 s holds the act at most
    /// the (here 40 ms) cap, and the act goes on without waiting for the cursor.
    @MainActor func testABusyMainThreadNeverHoldsTheAct() async throws {
        world(capMs: 40)
        var askedAt: DispatchTime?
        shell.onAsk["target"] = {
            askedAt = .now()
            usleep(300_000)  // the main thread busy past the cap
        }
        let started = DispatchTime.now()
        try await pressOK()
        let pressed = try XCTUnwrap(pressedAtReal)
        let heldMs = Double(pressed.uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
        XCTAssertLessThan(heldMs, 250, "the press went out before the busy main thread answered")
        XCTAssertNotNil(askedAt)
        XCTAssertEqual(clock.waited, 0, "an unanswered ask waits for nothing more")
        XCTAssertEqual(shell.asks.map(\.kind), ["target"], "its budget spent: the press asks nothing")
    }

    @MainActor func testNoAskWhileThePresentationSaysTheCursorIsNotDrawn() async throws {
        world()
        shell.arrivalFor = ["target": 0.2]
        core.cursorDrawn(sessionId: "s", pid: pid, windowID: 77, false)  // its window off screen, covered, Reduce Motion
        try await pressOK()
        XCTAssertTrue(shell.asks.isEmpty, "the main thread is not asked at all")
        XCTAssertEqual(clock.waited, 0)
        core.cursorDrawn(sessionId: "s", pid: pid, windowID: 77, true)
        try await pressOK()
        XCTAssertEqual(shell.asks.map(\.kind), ["target", "press"])
        XCTAssertEqual(clock.waited, 200, accuracy: 0.001)
        core.cursorDrawn(sessionId: "other", pid: pid, windowID: 77, false)
        try await pressOK()
        XCTAssertEqual(shell.asks.count, 4, "another session's word is its own")
    }

    func testOnlyPlaceBoundKindsAreGated() {
        XCTAssertEqual(CUCore.arrivalGated, ["target", "press", "type", "key", "scroll", "drag"])
        for kind in ["caption", "waitBegin", "waitEnd", "refused", "foreground", "done", "move", "idle"] {
            XCTAssertFalse(CUCore.arrivalGated.contains(kind), kind)
        }
    }
}
