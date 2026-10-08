import XCTest
import WinterKit
@testable import Winter

/// The live mirror inside Winter's windows (spine §11b): the rules that decide where it shows, the
/// coordinator's subscriptions and connection policy against a fake helper, and the per-session model of
/// bound targets, frames, cursors and turn ends. No window and no socket is created — the child panel
/// itself is AppKit and is the live gate's.
@MainActor
final class MirrorTests: XCTestCase {
    /// `eventually` as an assertion (an `await` cannot sit inside XCTAssert's autoclosure).
    private func expect(_ condition: @MainActor () -> Bool, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) async {
        let ok = await eventually(2, condition)
        XCTAssertTrue(ok, message, file: file, line: line)
    }

    // MARK: - The rule table

    private func window(_ kind: MirrorWindowKind, session: String? = "s1", width: CGFloat = 900, id: String = "w1") -> MirrorWindow {
        MirrorWindow(id: id, kind: kind, sessionId: session, width: width)
    }

    func testTheMainWindowShowsItWhenItHasASessionAtAnyWidth() {
        for width in [320, 480, 900, 2000] as [CGFloat] {
            XCTAssertTrue(MirrorRules.isEligible(window(.shell, width: width), wasEligible: false), "\(width)")
        }
        XCTAssertFalse(MirrorRules.isEligible(window(.shell, session: nil), wasEligible: false), "no session open: nothing shows")
        XCTAssertFalse(MirrorRules.isEligible(window(.shell, session: ""), wasEligible: true))
    }

    func testADetachedWindowNeedsSevenHundredTwentyPoints() {
        XCTAssertFalse(MirrorRules.isEligible(window(.detached, width: 719), wasEligible: false))
        XCTAssertTrue(MirrorRules.isEligible(window(.detached, width: 720), wasEligible: false))
        XCTAssertTrue(MirrorRules.isEligible(window(.detached, width: 1400), wasEligible: false))
        XCTAssertFalse(MirrorRules.isEligible(window(.detached, session: nil, width: 1400), wasEligible: true))
    }

    /// Dragging an edge across the line must not subscribe and unsubscribe on every pixel.
    func testADetachedWindowKeepsItUntilItIsClearlyNarrower() {
        XCTAssertTrue(MirrorRules.isEligible(window(.detached, width: 719), wasEligible: true))
        XCTAssertTrue(MirrorRules.isEligible(window(.detached, width: 700), wasEligible: true))
        XCTAssertFalse(MirrorRules.isEligible(window(.detached, width: 699), wasEligible: true))
        XCTAssertFalse(MirrorRules.isEligible(window(.detached, width: 710), wasEligible: false), "it must first reach 720")
    }

    func testThePillNeverShowsIt() {
        for width in [300, 720, 2000] as [CGFloat] {
            XCTAssertFalse(MirrorRules.isEligible(window(.pill, width: width), wasEligible: true))
            XCTAssertFalse(MirrorRules.isEligible(window(.pill, width: width), wasEligible: false))
        }
    }

    func testSubscriptionsAreTheSessionsOfEligibleWindows() {
        let windows = [window(.shell, session: "a", id: "1"), window(.detached, session: "a", id: "2"), window(.detached, session: "b", id: "3")]
        XCTAssertEqual(MirrorRules.subscriptions(eligible: windows), ["a", "b"])
        XCTAssertEqual(MirrorRules.subscriptions(eligible: []), [])
    }

    // MARK: - The panel's geometry

    func testThePanelFollowsTheWindowsAspectWithinBounds() {
        XCTAssertEqual(mirrorPanelSize(windowSize: CGSize(width: 800, height: 600)).width, 320)
        XCTAssertEqual(mirrorPanelSize(windowSize: CGSize(width: 800, height: 600)).height, ((320 - 16) * 0.75 + 40).rounded())
        XCTAssertEqual(mirrorPanelSize(windowSize: CGSize(width: 1000, height: 100)).height, mirrorPanelMinHeight, "a thin window is not thinner than the floor")
        XCTAssertEqual(mirrorPanelSize(windowSize: CGSize(width: 300, height: 900)).height, mirrorPanelMaxHeight, "a tall one is capped")
        XCTAssertEqual(mirrorPanelSize(windowSize: .zero), CGSize(width: 320, height: mirrorPanelMinHeight))
    }

    func testThePanelSitsAtTheWindowsTopLeft() {
        let parent = NSRect(x: 100, y: 200, width: 900, height: 700)
        let frame = mirrorPanelFrame(parent: parent, size: CGSize(width: 320, height: 240))
        XCTAssertEqual(frame.minX, parent.minX + mirrorPanelInset)
        XCTAssertEqual(frame.maxY, parent.maxY - mirrorPanelInset, "its top edge is just under the window's top")
        XCTAssertEqual(frame.size, CGSize(width: 320, height: 240))
    }

    // MARK: - Targets

    func testTheMostRecentlyBoundTargetIsTheOneShown() {
        var tracker = MirrorTargetTracker()
        tracker.seed([.fake("a"), .fake("b")])
        XCTAssertEqual(tracker.shown?.targetId, "b", "subscribe's targets are read oldest first")
        tracker.bound(.fake("c"))
        XCTAssertEqual(tracker.shown?.targetId, "c")
        tracker.bound(.fake("a"))
        XCTAssertEqual(tracker.shown?.targetId, "a", "binding a target again makes it the most recent")
        XCTAssertEqual(tracker.targets.map(\.targetId), ["b", "c", "a"])
        XCTAssertFalse(tracker.released("zzz"))
        XCTAssertTrue(tracker.released("a"))
        XCTAssertEqual(tracker.shown?.targetId, "c", "a released shown target falls back to the previous one")
        tracker.reset()
        XCTAssertNil(tracker.shown)
    }

    // MARK: - One session's model

    private func state(running: Bool = true, targets: [HelperTarget] = []) -> (MirrorSessionState, RecordingSink) {
        let sink = RecordingSink()
        let state = MirrorSessionState(sessionId: "s1", sink: sink)
        state.setTurnRunning(running)
        state.seed(targets)
        return (state, sink)
    }

    func testTheMirrorComesUpWhenATargetIsBoundAndTheTurnRuns() {
        let (state, sink) = state(running: true)
        XCTAssertFalse(state.isVisible)
        state.bound(.fake("t1", app: "Notes"))
        XCTAssertTrue(state.isVisible)
        XCTAssertEqual(sink.log, ["show:Notes:800x600"])
    }

    func testFramesAndCursorsForTheShownTargetAreAppliedAndOthersDropped() {
        let (state, sink) = state(targets: [.fake("old", app: "Mail"), .fake("new", app: "Notes")])
        XCTAssertEqual(sink.log, ["show:Notes:800x600"], "the last of the seeded targets is the one shown")
        state.frame(.fake("s1", "new", bytes: 9))
        state.cursor(HelperCursor(sessionId: "s1", targetId: "new", kind: "press", point: CGPoint(x: 5, y: 6)))
        state.frame(.fake("s1", "old", bytes: 7))
        state.cursor(HelperCursor(sessionId: "s1", targetId: "old", kind: "move", point: CGPoint(x: 1, y: 1)))
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "frame:9:720x540", "cursor:press:5,6"])
    }

    func testReleasingTheShownTargetFallsBackThenClears() {
        let (state, sink) = state(targets: [.fake("a", app: "Mail"), .fake("b", app: "Notes")])
        state.released("b")
        XCTAssertEqual(state.shownTarget?.targetId, "a")
        XCTAssertTrue(state.isVisible)
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "show:Mail:800x600"], "the previous target takes over")
        state.released("a")
        XCTAssertFalse(state.isVisible)
        XCTAssertEqual(sink.log.last, "clear")
        state.released("a")
        XCTAssertEqual(sink.log.filter { $0 == "clear" }.count, 1, "releasing nothing changes nothing")
    }

    func testReleasingAnotherTargetLeavesTheShownOne() {
        let (state, sink) = state(targets: [.fake("a"), .fake("b")])
        state.released("a")
        XCTAssertEqual(state.shownTarget?.targetId, "b")
        XCTAssertEqual(sink.log, ["show:Notes:800x600"])
    }

    func testTheTurnEndingHidesItAndTheNextTurnBringsItBack() {
        let (state, sink) = state(targets: [.fake("a")])
        state.setTurnRunning(false)
        XCTAssertFalse(state.isVisible)
        XCTAssertEqual(sink.log, ["show:Notes:800x600", "clear"])
        state.frame(.fake("s1", "a"))
        XCTAssertEqual(sink.log.count, 2, "a frame while the mirror is down is dropped")
        state.setTurnRunning(true)
        XCTAssertTrue(state.isVisible)
        XCTAssertEqual(sink.log.last, "show:Notes:800x600")
        state.setTurnRunning(true)
        XCTAssertEqual(sink.log.count, 3, "no change, no call")
    }

    func testABoundTargetWithNoRunningTurnShowsNothing() {
        let (state, sink) = state(running: false, targets: [.fake("a")])
        XCTAssertFalse(state.isVisible)
        XCTAssertNotNil(state.shownTarget)
        XCTAssertTrue(sink.log.isEmpty)
    }

    func testAFramesNewWindowSizeResizesThePanel() {
        let (state, _) = state(targets: [.fake("a", size: CGSize(width: 800, height: 600))])
        let before = state.panelSize
        state.frame(.fake("s1", "a", size: CGSize(width: 800, height: 300)))
        XCTAssertEqual(state.shownTarget?.windowSize, CGSize(width: 800, height: 300))
        XCTAssertNotEqual(state.panelSize, before)
    }

    func testResetClearsTheMirror() {
        let (state, sink) = state(targets: [.fake("a")])
        state.reset()
        XCTAssertNil(state.shownTarget)
        XCTAssertFalse(state.isVisible)
        XCTAssertEqual(sink.log.last, "clear")
    }

    // MARK: - The coordinator

    private struct Rig {
        let coordinator: MirrorCoordinator
        let client: FakeHelperClient
        let sinks: SinkBook
        let sleeps: SleepLog
    }

    private final class SinkBook {
        var byId: [String: RecordingSink] = [:]
    }

    private final class SleepLog: @unchecked Sendable {
        private let lock = NSLock()
        private var _delays: [Double] = []
        var delays: [Double] { lock.withLock { _delays } }
        func add(_ d: Double) { lock.withLock { _delays.append(d) } }
    }

    private func rig() -> Rig {
        let client = FakeHelperClient()
        let sinks = SinkBook()
        let sleeps = SleepLog()
        let coordinator = MirrorCoordinator(
            client: client,
            makeSink: { id in let sink = RecordingSink(); sinks.byId[id] = sink; return sink },
            sleep: { duration in
                let (s, a) = duration.components
                sleeps.add(Double(s) + Double(a) / 1e18)
                await Task.yield()
            })
        return Rig(coordinator: coordinator, client: client, sinks: sinks, sleeps: sleeps)
    }

    func testAnOpenWindowSubscribesOnceAndNothingIsConnectedBefore() async {
        let r = rig()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(r.client.calls.isEmpty, "no window, no connection")

        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        let done = await eventually { r.client.calls == ["connect", "subscribe:s1"] }
        XCTAssertTrue(done, "\(r.client.calls)")
        XCTAssertTrue(r.coordinator.isConnected)
        XCTAssertEqual(r.coordinator.applied, ["s1"])
    }

    func testTwoWindowsOnOneSessionShareOneSubscriptionAndTheLastCloseDisconnects() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        r.coordinator.setWindow(window(.detached, session: "s1", width: 900, id: "det"))
        await expect({ r.client.count("subscribe:s1") == 1 })
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(r.client.count("subscribe:s1"), 1)
        XCTAssertEqual(r.client.count("connect"), 1)

        r.coordinator.removeWindow(id: "det")
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(r.client.count("unsubscribe:s1"), 0, "another window still shows the session")
        XCTAssertTrue(r.coordinator.isConnected)

        r.coordinator.removeWindow(id: "shell")
        await expect({ r.client.calls.contains("disconnect") }, "\(r.client.calls)")
        XCTAssertFalse(r.coordinator.isConnected)
        XCTAssertTrue(r.coordinator.applied.isEmpty)
    }

    func testSwitchingSessionUnsubscribesTheOldAndSubscribesTheNew() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        await expect({ r.client.count("subscribe:a") == 1 })
        r.coordinator.setWindow(window(.shell, session: "b", id: "shell"))
        await expect({ r.client.count("subscribe:b") == 1 && r.client.count("unsubscribe:a") == 1 }, "\(r.client.calls)")
        XCTAssertEqual(r.coordinator.applied, ["b"])
        XCTAssertEqual(r.client.count("connect"), 1, "a switch keeps the connection")

        r.coordinator.setWindow(window(.shell, session: nil, id: "shell"))
        await expect({ r.client.count("unsubscribe:b") == 1 && r.client.count("disconnect") == 1 })
    }

    func testResizingADetachedWindowAcrossTheThresholdSubscribesAndUnsubscribes() async {
        let r = rig()
        r.coordinator.setWindow(window(.detached, session: "s1", width: 600, id: "det"))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertTrue(r.client.calls.isEmpty, "too narrow: nothing is even connected")

        r.coordinator.setWindow(window(.detached, session: "s1", width: 720, id: "det"))
        await expect({ r.client.count("subscribe:s1") == 1 })

        r.coordinator.setWindow(window(.detached, session: "s1", width: 705, id: "det"))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.client.count("unsubscribe:s1"), 0, "inside the hysteresis band it holds")

        r.coordinator.setWindow(window(.detached, session: "s1", width: 699, id: "det"))
        await expect({ r.client.count("unsubscribe:s1") == 1 && r.client.count("disconnect") == 1 })

        r.coordinator.setWindow(window(.detached, session: "s1", width: 715, id: "det"))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.client.count("subscribe:s1"), 1, "and it must reach 720 again")
        r.coordinator.setWindow(window(.detached, session: "s1", width: 720, id: "det"))
        await expect({ r.client.count("subscribe:s1") == 2 })
    }

    func testThePillNeverSubscribes() async {
        let r = rig()
        r.coordinator.setWindow(window(.pill, session: "s1", width: 1200, id: "pill"))
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertTrue(r.client.calls.isEmpty)
        XCTAssertFalse(r.coordinator.isEligible(windowId: "pill"))
    }

    func testAMissingSocketIsRetriedQuietlyWithBackoffAndNeverLaunchesAnything() async {
        let r = rig()
        r.client.scriptConnect([.socketMissing, .socketMissing, .socketMissing, .socketMissing, .socketMissing, .socketMissing, .socketMissing, .socketMissing, nil])
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.client.count("subscribe:s1") == 1 }, "\(r.client.calls)")
        XCTAssertEqual(r.client.count("connect"), 9)
        XCTAssertEqual(r.sleeps.delays.prefix(8).map { $0 }, [0.5, 1, 2, 4, 8, 10, 10, 10], "doubling, capped at ten seconds")
        XCTAssertEqual(r.client.count("subscribe:s1"), 1, "nothing is subscribed before the connection")
    }

    func testRetryingStopsWhenTheWindowGoesAway() async {
        let r = rig()
        r.client.scriptConnect(Array(repeating: HelperClientError.socketMissing, count: 500))
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.client.count("connect") >= 3 })
        r.coordinator.removeWindow(id: "shell")
        try? await Task.sleep(nanoseconds: 100_000_000)
        let settled = r.client.count("connect")
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(r.client.count("connect"), settled, "no window wants the mirror: no more attempts")
    }

    func testAMismatchIsNotRetried() async {
        let r = rig()
        r.client.scriptConnect([.protocolMismatch])
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.coordinator.isBlocked })
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(r.client.count("connect"), 1)
        XCTAssertTrue(r.sleeps.delays.isEmpty, "a mismatch is not waited out")
        XCTAssertEqual(r.client.count("subscribe:s1"), 0)
    }

    func testALostConnectionReconnectsAndSubscribesEverythingAgain() async {
        let r = rig()
        r.client.setTargets([.fake("t1", app: "Notes")], for: "a")
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        r.coordinator.setWindow(window(.detached, session: "b", width: 900, id: "det"))
        await expect({ r.coordinator.applied == ["a", "b"] })
        r.coordinator.setTurnRunning(sessionId: "a", running: true)
        XCTAssertEqual(r.sinks.byId["a"]?.log, ["show:Notes:800x600"])

        r.client.push(.connectionLost)
        await expect({ r.client.count("connect") == 2 && r.coordinator.applied == ["a", "b"] }, "\(r.client.calls)")
        XCTAssertEqual(r.client.count("subscribe:a"), 2)
        XCTAssertEqual(r.client.count("subscribe:b"), 2)
        // The helper re-sent its bound targets with the new subscription, so the mirror is back.
        XCTAssertEqual(r.sinks.byId["a"]?.log, ["show:Notes:800x600", "clear", "show:Notes:800x600"])
    }

    func testASubscribeFailureStartsOverFromTheConnection() async {
        let r = rig()
        r.client.failSubscribe(with: .notConnected)
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.client.count("connect") >= 2 }, "\(r.client.calls)")
        r.client.failSubscribe(with: nil)
        await expect({ r.coordinator.applied == ["s1"] })
    }

    // MARK: - Frames only while the mirror is visible

    private func upAndRunning(_ r: Rig, session: String = "s1", windowVisible: Bool = true) async {
        r.client.setTargets([.fake("t1")], for: session)
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: session, width: 900, isVisible: windowVisible))
        await expect({ r.coordinator.applied == [session] })
    }

    func testAnIdleSessionIsSubscribedWithoutFrames() async {
        let r = rig()
        await upAndRunning(r)
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [false], "a target is bound but no turn runs: bound and cursor only")
        XCTAssertFalse(r.coordinator.isReceivingFrames(sessionId: "s1"))
    }

    func testFramesStartWhenATurnRunsWithATargetAndStopWhenItEnds() async {
        let r = rig()
        await upAndRunning(r)
        r.coordinator.setTurnRunning(sessionId: "s1", running: true)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [false, true])
        XCTAssertEqual(r.client.count("connect"), 1, "a flag change is a re-subscribe, not a reconnect")

        r.coordinator.setTurnRunning(sessionId: "s1", running: false)
        await expect({ !r.coordinator.isReceivingFrames(sessionId: "s1") })
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [false, true, false])
    }

    func testNoTargetMeansNoFramesEvenWhileTheTurnRuns() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "s1", id: "shell"))
        await expect({ r.coordinator.applied == ["s1"] })
        r.coordinator.setTurnRunning(sessionId: "s1", running: true)
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [false], "nothing to look at yet")

        r.client.push(.bound(sessionId: "s1", target: .fake("t1")))
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        r.client.push(.released(sessionId: "s1", targetId: "t1"))
        await expect({ !r.coordinator.isReceivingFrames(sessionId: "s1") })
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [false, true, false])
    }

    func testAHiddenWindowGetsNoFramesAndAnExposedOneDoes() async {
        let r = rig()
        await upAndRunning(r, windowVisible: false)
        r.coordinator.setTurnRunning(sessionId: "s1", running: true)
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertFalse(r.coordinator.isReceivingFrames(sessionId: "s1"), "minimized, ordered out or covered: no frames")

        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "s1", width: 900, isVisible: true))
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "s1", width: 900, isVisible: false))
        await expect({ !r.coordinator.isReceivingFrames(sessionId: "s1") })
        XCTAssertEqual(r.client.count("connect"), 1)
    }

    func testOneVisibleWindowAmongSeveralIsEnough() async {
        let r = rig()
        await upAndRunning(r, windowVisible: false)
        r.coordinator.setWindow(MirrorWindow(id: "det", kind: .detached, sessionId: "s1", width: 900, isVisible: true))
        r.coordinator.setTurnRunning(sessionId: "s1", running: true)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        // A narrow detached window is not eligible, so its visibility counts for nothing.
        r.coordinator.setWindow(MirrorWindow(id: "det", kind: .detached, sessionId: "s1", width: 400, isVisible: true))
        await expect({ !r.coordinator.isReceivingFrames(sessionId: "s1") })
    }

    func testFramesThatArriveWhileTheMirrorIsDownAreDropped() async {
        let r = rig()
        await upAndRunning(r)
        r.client.push(.frame(.fake("s1", "t1", bytes: 9)))
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(r.sinks.byId["s1"]?.log ?? [], [], "no turn: nothing reaches the mirror")
    }

    func testAReconnectAsksForFramesOnlyWhereTheMirrorIsUp() async {
        let r = rig()
        await upAndRunning(r)
        r.coordinator.setTurnRunning(sessionId: "s1", running: true)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        r.client.push(.connectionLost)
        await expect({ r.client.count("connect") == 2 && r.coordinator.applied == ["s1"] })
        XCTAssertEqual(r.client.frameFlags(for: "s1").suffix(1), [true], "the mirror is up again (the targets were re-seeded), so frames resume")
    }

    // MARK: - Events through the coordinator

    func testEventsReachTheRightSessionsMirror() async {
        let r = rig()
        r.client.setTargets([.fake("t1", app: "Notes")], for: "a")
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        r.coordinator.setWindow(window(.detached, session: "b", width: 900, id: "det"))
        await expect({ r.coordinator.applied == ["a", "b"] })
        r.coordinator.setTurnRunning(sessionId: "a", running: true)
        r.coordinator.setTurnRunning(sessionId: "b", running: true)

        r.client.push(.frame(.fake("a", "t1", bytes: 11)))
        r.client.push(.frame(.fake("b", "nope", bytes: 5)))
        r.client.push(.bound(sessionId: "b", target: .fake("tb", app: "Finder")))
        r.client.push(.cursor(HelperCursor(sessionId: "b", targetId: "tb", kind: "move", point: CGPoint(x: 3, y: 4))))
        r.client.push(.released(sessionId: "a", targetId: "t1"))
        await expect({ r.sinks.byId["a"]?.log.last == "clear" })
        XCTAssertEqual(r.sinks.byId["a"]?.log, ["show:Notes:800x600", "frame:11:720x540", "clear"])
        XCTAssertEqual(r.sinks.byId["b"]?.log, ["show:Finder:800x600", "cursor:move:3,4"], "b's stray frame for an unknown target was dropped")
    }

    func testAnEventForASessionNoWindowShowsIsIgnored() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        await expect({ r.coordinator.applied == ["a"] })
        r.client.push(.bound(sessionId: "ghost", target: .fake("t")))
        r.client.push(.frame(.fake("ghost", "t")))
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertNil(r.sinks.byId["ghost"], "no state is made for a session nobody shows")
    }

    func testAClosedWindowsSessionStateIsDropped() async {
        let r = rig()
        r.coordinator.setWindow(window(.shell, session: "a", id: "shell"))
        await expect({ r.coordinator.applied == ["a"] })
        let first = r.sinks.byId["a"]
        XCTAssertNotNil(first)
        r.coordinator.removeWindow(id: "shell")
        await expect({ r.client.calls.contains("disconnect") })
        _ = r.coordinator.state(for: "a")
        XCTAssertFalse(r.sinks.byId["a"] === first, "the old state was dropped; asking again made a fresh one")
    }
}
