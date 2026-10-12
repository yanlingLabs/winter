import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

// The wake triggers' watches (PROTOCOL.md §4.13): the pure decisions, the engine over fakes, and the live seams over a
// fake accessibility tree — never a real app, tap or observer.

final class WatchClock: CUClock, @unchecked Sendable {
    private let lock = NSLock()
    private var _now: Double = 10_000
    var now: Double { get { lock.withLock { _now } } set { lock.withLock { _now = newValue } } }
    func nowMs() -> Double { now }
    func sleep(ms: Double) async throws { now += ms }
    func pause(ms: Double) { now += ms }
}

final class FakeWatchNotifier: CUWatchNotifying, @unchecked Sendable {
    var onNotification: (@Sendable (pid_t) -> Void)?
    private(set) var watched: [pid_t] = []
    private(set) var unwatched: [pid_t] = []
    func watch(pid: pid_t) -> Bool { watched.append(pid); return true }
    func unwatch(pid: pid_t) { unwatched.append(pid) }
}

final class FakeWatchTap: CUWatchTapping, @unchecked Sendable {
    private(set) var starts = 0
    private(set) var stops = 0
    var handler: (@Sendable (CGPoint, Int64, Int64) -> Void)?
    var running: Bool { handler != nil }
    func start(onMouseDown: @escaping @Sendable (CGPoint, Int64, Int64) -> Void) -> Bool {
        starts += 1
        handler = onMouseDown
        return true
    }
    func stop() { stops += 1; handler = nil }
}

final class FakeWatchTimers: CUWatchScheduling, @unchecked Sendable {
    final class Item: CUWatchCancellable {
        let ms: Double
        let work: @Sendable () -> Void
        var cancelled = false
        init(_ ms: Double, _ work: @escaping @Sendable () -> Void) { self.ms = ms; self.work = work }
        func cancel() { cancelled = true }
    }
    private let lock = NSLock()
    private var items: [Item] = []
    func after(ms: Double, _ work: @escaping @Sendable () -> Void) -> CUWatchCancellable {
        let i = Item(ms, work)
        lock.withLock { items.append(i) }
        return i
    }
    var pending: [Item] { lock.withLock { items.filter { !$0.cancelled } } }
    /// Runs every pending timer once (in order), those of `ms` only when given.
    func fire(ms: Double? = nil) {
        let due: [Item] = lock.withLock {
            let d = items.filter { !$0.cancelled && (ms == nil || $0.ms == ms) }
            items.removeAll { item in item.cancelled || d.contains { $0 === item } }
            return d
        }
        for i in due { i.work() }
    }
}

final class WatchSink: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [CUWatchEvent] = []
    private var _counts: [Int] = []
    private var _shown: [[CUWatchShown]] = []
    var events: [CUWatchEvent] { lock.withLock { _events } }
    var counts: [Int] { lock.withLock { _counts } }
    var shown: [[CUWatchShown]] { lock.withLock { _shown } }
    func event(_ e: CUWatchEvent) { lock.withLock { _events.append(e) } }
    func count(_ n: Int) { lock.withLock { _counts.append(n) } }
    func show(_ s: [CUWatchShown]) { lock.withLock { _shown.append(s) } }
}

func eventually(_ what: String = "", timeout: Double = 2, _ condition: () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline { try? await Task.sleep(nanoseconds: 5_000_000) }
    XCTAssertTrue(condition(), "never happened: \(what)")
}

final class WatchJudgeTests: XCTestCase {
    func testParseEachKindAndRefusals() throws {
        XCTAssertEqual(try CUWatchCondition.parse(.init(kind: "clicked", ref: 4)), .clicked(ref: 4))
        XCTAssertEqual(try CUWatchCondition.parse(.init(kind: "appeared", text: "Sent")), .appeared(text: "Sent"))
        XCTAssertEqual(try CUWatchCondition.parse(.init(kind: "gone", ref: 3)), .goneRef(ref: 3))
        XCTAssertEqual(try CUWatchCondition.parse(.init(kind: "gone", text: "Uploading")), .goneText(text: "Uploading"))
        XCTAssertEqual(try CUWatchCondition.parse(.init(kind: "changed", ref: 9)), .changed(ref: 9, settleMs: 1_500))
        XCTAssertEqual(try CUWatchCondition.parse(.init(kind: "changed", ref: 9, settleMs: 300)), .changed(ref: 9, settleMs: 300))
        XCTAssertEqual(try CUWatchCondition.parse(.init(kind: "titled", title: "Done")), .titled(title: "Done"))
        for bad in [CUWatchConditionWire(kind: "clicked"), .init(kind: "appeared", text: "  "), .init(kind: "gone", ref: 1, text: "x"),
                    .init(kind: "nope"), .init(kind: "changed", ref: 0)] {
            XCTAssertThrowsError(try CUWatchCondition.parse(bad)) { XCTAssertEqual(($0 as? CUError)?.code, "invalid_params") }
        }
        XCTAssertThrowsError(try CUWatchCondition.parse(.init(kind: "submitted"))) {
            XCTAssertTrue(($0 as? CUError)?.message.contains("browser tabs only") ?? false)
        }
        XCTAssertThrowsError(try CUWatchCondition.parse(.init(kind: "appeared", text: String(repeating: "a", count: 501))))
    }

    func testAStateConditionFiresOnlyOnATransitionWinterDidNotCause() {
        var j = CUWatchJudge(.appeared(text: "Sent"))
        XCTAssertEqual(j.judge(.init(met: false), ownInput: false, nowMs: 0), .none)
        // Winter's own input explains it: the new state is the baseline, nothing fires.
        XCTAssertEqual(j.judge(.init(met: true), ownInput: true, nowMs: 1), .none)
        XCTAssertEqual(j.judge(.init(met: true), ownInput: false, nowMs: 2), .none, "still true: no new transition")
        XCTAssertEqual(j.judge(.init(met: false), ownInput: false, nowMs: 3), .none)
        XCTAssertEqual(j.judge(.init(met: true), ownInput: false, nowMs: 4), .fire(detail: "appeared"))
        XCTAssertEqual(j.judge(.init(met: false), ownInput: false, nowMs: 5), .none, "one-shot")
    }

    func testTitledSaysTheNewTitleAndGoneTextSaysGone() {
        var t = CUWatchJudge(.titled(title: "Done"))
        XCTAssertEqual(t.judge(.init(met: true, title: "Build — Done\n"), ownInput: false, nowMs: 0),
                       .fire(detail: "title now \u{201C}Build — Done\u{201D}"))
        var g = CUWatchJudge(.goneText(text: "Uploading"))
        XCTAssertEqual(g.judge(.init(met: true), ownInput: false, nowMs: 0), .fire(detail: "gone"))
    }

    func testLossesComeFirst() {
        var j = CUWatchJudge(.appeared(text: "x"))
        XCTAssertEqual(j.judge(.init(appRunning: false, met: true), ownInput: false, nowMs: 0), .lost(reason: "the app quit"))
        var w = CUWatchJudge(.titled(title: "x"))
        XCTAssertEqual(w.judge(.init(windowAlive: false), ownInput: false, nowMs: 0), .lost(reason: "the window closed"))
        var c = CUWatchJudge(.clicked(ref: 1))
        XCTAssertEqual(c.judge(.init(elementAlive: false), ownInput: false, nowMs: 0), .lost(reason: CUWatchJudge.elementGone))
    }

    func testGoneRefFiresUnlessWinterRemovedIt() {
        var j = CUWatchJudge(.goneRef(ref: 2))
        XCTAssertEqual(j.judge(.init(elementAlive: true), ownInput: false, nowMs: 0), .none)
        XCTAssertEqual(j.judge(.init(elementAlive: false), ownInput: false, nowMs: 1), .fire(detail: "gone"))
        var own = CUWatchJudge(.goneRef(ref: 2))
        XCTAssertEqual(own.judge(.init(elementAlive: false), ownInput: true, nowMs: 1), .lost(reason: CUWatchJudge.elementGoneOwnInput))
    }

    func testAClickFiresOnlyAClickWatchAndNeverOnWintersOwnInput() {
        var j = CUWatchJudge(.clicked(ref: 1))
        XCTAssertEqual(j.clicked(ownInput: true), .none)
        XCTAssertEqual(j.clicked(ownInput: false), .fire(detail: "clicked"))
        XCTAssertEqual(j.clicked(ownInput: false), .none, "one-shot")
        var c = CUWatchJudge(.changed(ref: 1, settleMs: 100), baselineValue: 1)
        XCTAssertEqual(c.clicked(ownInput: false), .none)
    }

    func testChangedNeedsTheUsersInputAndSettles() {
        var j = CUWatchJudge(.changed(ref: 5, settleMs: 1_000), baselineValue: 100)
        // A change no input of the user's explains (the app's own, or Winter's) becomes the baseline.
        XCTAssertEqual(j.judge(.init(elementAlive: true, valueDigest: 101), ownInput: false, nowMs: 0), .none)
        XCTAssertEqual(j.judge(.init(elementAlive: true, valueDigest: 102, userEvidence: true), ownInput: true, nowMs: 100), .none)
        // The user's change: settles for 1 s after the last change.
        XCTAssertEqual(j.judge(.init(elementAlive: true, valueDigest: 103, userEvidence: true), ownInput: false, nowMs: 200),
                       .lookAgain(atMs: 1_200))
        XCTAssertEqual(j.judge(.init(elementAlive: true, valueDigest: 104, userEvidence: true), ownInput: false, nowMs: 700),
                       .lookAgain(atMs: 1_700))
        XCTAssertEqual(j.judge(.init(elementAlive: true, valueDigest: 104, userEvidence: true), ownInput: false, nowMs: 1_000),
                       .lookAgain(atMs: 1_700))
        XCTAssertEqual(j.judge(.init(elementAlive: true, valueDigest: 104, userEvidence: true), ownInput: false, nowMs: 1_700),
                       .fire(detail: "changed"))
    }

    func testChangedBackToTheBaselineIsNoChange() {
        var j = CUWatchJudge(.changed(ref: 5, settleMs: 500), baselineValue: 1)
        _ = j.judge(.init(elementAlive: true, valueDigest: 2, userEvidence: true), ownInput: false, nowMs: 0)
        XCTAssertEqual(j.judge(.init(elementAlive: true, valueDigest: 1, userEvidence: true), ownInput: false, nowMs: 100), .none)
        XCTAssertEqual(j.judge(.init(elementAlive: true, valueDigest: 1, userEvidence: true), ownInput: false, nowMs: 5_000), .none)
    }

    func testAChangeSettlingWhenItsFieldGoesStillFires() {
        var j = CUWatchJudge(.changed(ref: 5, settleMs: 1_500), baselineValue: 1)
        _ = j.judge(.init(elementAlive: true, valueDigest: 2, userEvidence: true), ownInput: false, nowMs: 0)
        XCTAssertEqual(j.judge(.init(elementAlive: false), ownInput: false, nowMs: 300), .fire(detail: "changed"))
        var idle = CUWatchJudge(.changed(ref: 5, settleMs: 1_500), baselineValue: 1)
        XCTAssertEqual(idle.judge(.init(elementAlive: false), ownInput: false, nowMs: 300), .lost(reason: CUWatchJudge.elementGone))
    }

    func testOnlyHardwareInputIsTheUsersAndTheTestStampOnlyOnALiveTestInstance() {
        XCTAssertTrue(CUWatchInput.isUsers(sourcePid: 0, userData: 0, countsTestInput: false))
        XCTAssertFalse(CUWatchInput.isUsers(sourcePid: 0, userData: CUEventStamp.value, countsTestInput: true), "the helper's own")
        XCTAssertFalse(CUWatchInput.isUsers(sourcePid: 312, userData: 0, countsTestInput: true), "another process's synthetic event")
        XCTAssertFalse(CUWatchInput.isUsers(sourcePid: 312, userData: CUWatchTestStamp.value, countsTestInput: false))
        XCTAssertTrue(CUWatchInput.isUsers(sourcePid: 312, userData: CUWatchTestStamp.value, countsTestInput: true))
        // The tap's mask: the three mouse-down buttons and nothing else.
        let m = CUWatchInput.tapMask
        for t: CGEventType in [.leftMouseDown, .rightMouseDown, .otherMouseDown] { XCTAssertNotEqual(m & (1 << t.rawValue), 0) }
        for t: CGEventType in [.keyDown, .keyUp, .mouseMoved, .leftMouseUp, .scrollWheel, .flagsChanged] { XCTAssertEqual(m & (1 << t.rawValue), 0) }
    }

    func testTheOwnInputLedger() {
        let l = CUOwnInputLedger()
        XCTAssertFalse(l.touched(7, fromMs: 1_000))
        l.begin(7, nowMs: 1_000)
        XCTAssertTrue(l.touched(7, fromMs: 2_000), "in flight")
        XCTAssertFalse(l.touched(8, fromMs: 2_000), "another app")
        l.end(7, nowMs: 1_200)
        XCTAssertTrue(l.touched(7, fromMs: 1_600), "within the 500 ms grace of its end")
        XCTAssertFalse(l.touched(7, fromMs: 1_800), "after it")
        l.begin(nil, nowMs: 3_000)
        XCTAssertTrue(l.touched(8, fromMs: 3_100), "a request whose app is not known yet counts for every app")
        l.end(nil, nowMs: 3_100)
        XCTAssertFalse(l.touched(8, fromMs: 3_700))
    }

    func testTheAlreadyMetSentences() {
        XCTAssertEqual(CUWatchJudge.alreadyMet(.appeared(text: "Saved"), app: "Mail"),
                       "\u{201C}Saved\u{201D} is already shown in Mail — nothing to wait for; check state()")
        XCTAssertNotNil(CUWatchJudge.alreadyMet(.goneText(text: "x"), app: "Mail"))
        XCTAssertNotNil(CUWatchJudge.alreadyMet(.titled(title: "x"), app: "Mail"))
        XCTAssertNil(CUWatchJudge.alreadyMet(.clicked(ref: 1), app: "Mail"))
        XCTAssertEqual(CUWatchText.targetLabel(app: "Mail", title: "Inbox\u{202E} — 3"), "Mail — Inbox — 3")
        XCTAssertEqual(CUWatchText.targetLabel(app: "Mail", title: ""), "Mail")
    }
}

/// The engine over fakes: every seam injected.
final class WatcherEngineTests: XCTestCase {
    var clock: WatchClock!
    var notifier: FakeWatchNotifier!
    var tap: FakeWatchTap!
    var timers: FakeWatchTimers!
    var sink: WatchSink!
    var watcher: CUWatcher!
    /// What the next arm probe answers, and every look.
    var met: Bool? = false
    var observation = CUWatchObservation()
    var hit: CUWatchHit = .element
    var under: (pid: pid_t, windowID: UInt32)? = (42, 7)
    var shown: CUWatchShown?

    override func setUp() {
        clock = WatchClock()
        notifier = FakeWatchNotifier()
        tap = FakeWatchTap()
        timers = FakeWatchTimers()
        sink = WatchSink()
        watcher = CUWatcher(
            clock: clock, wallMs: { 1_700_000_000_000 }, notifier: notifier, tap: tap, scheduler: timers,
            prepare: { [unowned self] p, c in
                CUWatcher.Prepared(pid: 42, windowID: 7, appName: "Mail", sessionId: "s1", target: nil,
                                   elementInfo: c.ref == nil ? nil : CUWatchElement(role: "button", name: "Send"),
                                   targetLabel: "Mail — Inbox", met: c.ref == nil ? met : nil,
                                   valueDigest: { if case .changed = c { return 1 } else { return nil } }())
            },
            read: { [unowned self] _ in observation },
            windowAt: { [unowned self] _ in under },
            hit: { [unowned self] _, _ in hit },
            present: { [unowned self] _ in shown },
            pidOfTarget: { $0 == "t1" ? 42 : nil })
        watcher.onEvent = { [sink] in sink!.event($0) }
        watcher.onArmedCount = { [sink] in sink!.count($0) }
        watcher.onPresent = { [sink] in sink!.show($0) }
    }

    func arm(_ id: String, _ c: CUWatchConditionWire, connection: Int = 1) async throws -> WatchArmResult {
        try await watcher.arm(WatchArmParams(targetId: "t1", watchId: id, condition: c, expiresAt: 1_700_000_000_000 + 60_000),
                              connection: connection)
    }

    func testArmAnswersTheLabelsAndObservesTheApp() async throws {
        let r = try await arm("wk_a", .init(kind: "clicked", ref: 3))
        XCTAssertEqual(r, WatchArmResult(element: CUWatchElement(role: "button", name: "Send"), targetLabel: "Mail — Inbox"))
        XCTAssertEqual(notifier.watched, [42])
        XCTAssertEqual(watcher.armedIds, ["wk_a"])
        XCTAssertEqual(sink.counts.last, 1)
        XCTAssertTrue(tap.running, "a click watch runs the tap")
        await XCTAssertThrowsErrorAsync(try await self.arm("wk_a", .init(kind: "clicked", ref: 3)))
    }

    func testAConditionAlreadyTrueIsRefusedAndArmsNothing() async throws {
        met = true
        do {
            _ = try await arm("wk_b", .init(kind: "appeared", text: "Saved"))
            XCTFail("armed")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "not_allowed")
            XCTAssertEqual(e.data?["reason"], .string("already_met"))
            XCTAssertEqual(e.message, "\u{201C}Saved\u{201D} is already shown in Mail — nothing to wait for; check state()")
        }
        XCTAssertEqual(watcher.armedCount, 0)
        XCTAssertTrue(notifier.watched.isEmpty)
    }

    func testTheTapRunsOnlyWhileAClickOrChangeWatchIsArmed() async throws {
        _ = try await arm("wk_t", .init(kind: "titled", title: "Done"))
        XCTAssertFalse(tap.running)
        _ = try await arm("wk_c", .init(kind: "changed", ref: 2))
        XCTAssertTrue(tap.running)
        watcher.cancel(watchId: "wk_c")
        XCTAssertFalse(tap.running)
        XCTAssertEqual(tap.stops, 1)
        watcher.cancel(watchId: "wk_c")  // idempotent
        watcher.cancel(watchId: "wk_t")
        XCTAssertEqual(notifier.unwatched, [42])
        XCTAssertEqual(sink.counts.last, 0)
        XCTAssertTrue(timers.pending.isEmpty, "no timer outlives the last watch")
    }

    func testTheUsersClickOnTheElementFiresOnceAndDropsTheWatch() async throws {
        _ = try await arm("wk_a", .init(kind: "clicked", ref: 3))
        tap.handler?(CGPoint(x: 10, y: 10), 0, 0)
        await eventually("fired") { sink.events.count == 1 }
        XCTAssertEqual(sink.events.first, CUWatchEvent(watchId: "wk_a", outcome: .fired, at: 1_700_000_000_000, detail: "clicked"))
        XCTAssertEqual(watcher.armedCount, 0)
        XCTAssertFalse(tap.running)
    }

    func testClicksThatAreNotTheUsersOrMissTheElementDoNothing() async throws {
        _ = try await arm("wk_a", .init(kind: "clicked", ref: 3))
        // The helper's own click, another process's synthetic one: never looked at.
        tap.handler?(.zero, 0, CUEventStamp.value)
        tap.handler?(.zero, 999, 0)
        hit = .window
        await watcher.judgeClick(at: .zero, nowMs: clock.now, wall: 1)
        under = (43, 9)  // another app's window there
        hit = .element
        await watcher.judgeClick(at: .zero, nowMs: clock.now, wall: 1)
        // Winter's own input to the app in flight: not the user's.
        under = (42, 7)
        let token = watcher.ownInputBegan(targetId: "t1")
        await watcher.judgeClick(at: .zero, nowMs: clock.now, wall: 1)
        watcher.ownInputEnded(token)
        clock.now += 400
        await watcher.judgeClick(at: .zero, nowMs: clock.now, wall: 1)  // within the grace
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(sink.events.isEmpty)
        clock.now += 200
        await watcher.judgeClick(at: .zero, nowMs: clock.now, wall: 1)
        XCTAssertEqual(sink.events.map(\.outcome), [.fired])
    }

    func testTheLiveTestSwitchCountsOnlyTheTestStamp() async throws {
        _ = try await arm("wk_a", .init(kind: "clicked", ref: 3))
        tap.handler?(.zero, 312, CUWatchTestStamp.value)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(sink.events.isEmpty)
        watcher.countsTestInput = true
        tap.handler?(.zero, 312, CUWatchTestStamp.value)
        await eventually("fired by the live suite's click") { sink.events.count == 1 }
    }

    func testANotificationIsDebouncedThenLookedAt() async throws {
        _ = try await arm("wk_s", .init(kind: "appeared", text: "Sent"))
        observation = CUWatchObservation(met: true)
        notifier.onNotification?(42)
        notifier.onNotification?(42)
        XCTAssertEqual(timers.pending.filter { $0.ms == 250 }.count, 1, "one debounce per app")
        clock.now += 300
        timers.fire(ms: 250)
        await eventually("fired") { sink.events.count == 1 }
        XCTAssertEqual(sink.events.first?.detail, "appeared")
    }

    func testAChangeOfWintersOwnBecomesTheBaseline() async throws {
        _ = try await arm("wk_s", .init(kind: "appeared", text: "Sent"))
        let token = watcher.ownInputBegan(targetId: "t1")
        observation = CUWatchObservation(met: true)
        await watcher.evaluate(pid: 42)
        watcher.ownInputEnded(token)
        clock.now += 2_000
        await watcher.evaluate(pid: 42)
        XCTAssertTrue(sink.events.isEmpty, "still true since Winter's own input: no new transition")
        observation = CUWatchObservation(met: false)
        await watcher.evaluate(pid: 42)
        observation = CUWatchObservation(met: true)
        clock.now += 1_000
        await watcher.evaluate(pid: 42)
        XCTAssertEqual(sink.events.map(\.detail), ["appeared"])
    }

    func testAnUnknownTargetsInputCountsNowhereAndABindCountsEverywhere() {
        let none = watcher.ownInputBegan(targetId: "t9")
        XCTAssertFalse(watcher.ledger.touched(42, fromMs: clock.now))
        watcher.ownInputEnded(none)
        let any = watcher.ownInputBegan(targetId: nil)
        XCTAssertTrue(watcher.ledger.touched(42, fromMs: clock.now))
        watcher.ownInputEnded(any)
    }

    func testChangedWaitsForTheValueToSettle() async throws {
        _ = try await arm("wk_c", .init(kind: "changed", ref: 2, settleMs: 1_000))
        observation = CUWatchObservation(elementAlive: true, valueDigest: 5, userEvidence: true)
        await watcher.evaluate(pid: 42)
        XCTAssertEqual(timers.pending.filter { $0.ms == 1_000 }.count, 1, "a look again at the settle's end")
        clock.now += 1_000
        await watcher.evaluate(pid: 42)
        XCTAssertEqual(sink.events.map(\.detail), ["changed"])
    }

    func testAUsersClickOnTheFieldIsEvidenceForChanged() async throws {
        _ = try await arm("wk_c", .init(kind: "changed", ref: 2, settleMs: 0))
        await watcher.judgeClick(at: .zero, nowMs: clock.now, wall: 1)  // the user clicked the check box
        observation = CUWatchObservation(elementAlive: true, valueDigest: 5, userEvidence: false)
        clock.now += 100
        await watcher.evaluate(pid: 42)
        XCTAssertEqual(sink.events.map(\.detail), ["changed"])
    }

    func testTheConnectionClosingDropsItsWatchesSilently() async throws {
        _ = try await arm("wk_1", .init(kind: "clicked", ref: 3), connection: 1)
        _ = try await arm("wk_2", .init(kind: "titled", title: "x"), connection: 2)
        watcher.connectionClosed(1)
        XCTAssertEqual(watcher.armedIds, ["wk_2"])
        XCTAssertTrue(sink.events.isEmpty)
        XCTAssertFalse(tap.running)
    }

    func testTheBackstopDropsAWatchPastItsExpirySilently() async throws {
        _ = try await arm("wk_e", .init(kind: "titled", title: "x"))
        clock.now += 60_000 + CUWatcher.expiryBackstopMs - 1
        await watcher.tick()
        XCTAssertEqual(watcher.armedCount, 1, "the daemon's own expiry comes first")
        clock.now += 2
        await watcher.tick()
        XCTAssertEqual(watcher.armedCount, 0)
        XCTAssertTrue(sink.events.isEmpty)
    }

    func testTheFallbackLooksAgainAndReportsALoss() async throws {
        _ = try await arm("wk_l", .init(kind: "titled", title: "x"))
        XCTAssertEqual(timers.pending.filter { $0.ms == CUWatcher.fallbackMs }.count, 1)
        observation = CUWatchObservation(appRunning: false)
        timers.fire(ms: CUWatcher.fallbackMs)
        await eventually("lost") { sink.events.count == 1 }
        XCTAssertEqual(sink.events.first?.outcome, .lost)
        XCTAssertEqual(sink.events.first?.reason, "the app quit")
    }

    func testTheRingIsDrawnWhileTheWindowIsInFrontAndGoesWithTheWatch() async throws {
        shown = CUWatchShown(watchId: "wk_a", kind: "clicked", label: "Send", elementFrame: CGRect(x: 1, y: 2, width: 3, height: 4),
                             windowFrame: CGRect(x: 0, y: 0, width: 100, height: 100))
        _ = try await arm("wk_a", .init(kind: "clicked", ref: 3))
        await eventually("drawn") { sink.shown.last?.count == 1 }
        XCTAssertEqual(timers.pending.filter { $0.ms == CUWatcher.presentPollMs }.count, 1, "it follows the element while shown")
        watcher.cancel(watchId: "wk_a")
        await eventually("cleared") { sink.shown.last?.isEmpty == true }
    }
}

func XCTAssertThrowsErrorAsync<T>(_ body: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
    do { _ = try await body(); XCTFail("no error", file: file, line: line) } catch {}
}

/// The live seams over a fake accessibility tree and window server: arming's floors, the baseline, and — the
/// controller's rule — a watch outlives `target.release` and `session.ended` and ends only by its own causes.
final class WatcherLiveSeamTests: XCTestCase {
    let pid: pid_t = 4_100
    var ax: FakeAX!
    var sys: FakeSystem!
    var core: CUCore!
    var target: CUTarget!
    var watcher: CUWatcher!
    var sink: WatchSink!
    let window = fakeElement(4_101)
    let button = fakeElement(4_102)
    let password = fakeElement(4_103)
    let field = fakeElement(4_104)

    override func setUp() {
        ax = FakeAX()
        ax.add(window, role: kAXWindowRole, title: "Inbox", frame: CGRect(x: 0, y: 0, width: 800, height: 600),
               extra: [kAXChildrenAttribute: [button, password, field]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(button, role: kAXButtonRole, title: "Send", frame: CGRect(x: 10, y: 10, width: 60, height: 20), extra: [kAXParentAttribute: window])
        ax.add(password, role: kAXTextFieldRole, subrole: "AXSecureTextField", frame: CGRect(x: 10, y: 40, width: 60, height: 20),
               extra: [kAXParentAttribute: window])
        ax.add(field, role: kAXTextFieldRole, frame: CGRect(x: 10, y: 70, width: 60, height: 20),
               extra: [kAXParentAttribute: window, kAXValueAttribute: "a", kAXPlaceholderValueAttribute: "Subject"])
        sys = FakeSystem()
        sys.running = [pid]
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 600), owner: "Mail")
        sys.windows[77] = w
        sys.stack = [w]
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s1", pid: pid, bundleId: "com.apple.mail", appName: "Mail", isChromium: false,
                          mirror: false, windowID: 77, windowTitle: "Inbox")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
        sink = WatchSink()
        watcher = CUWatcher.live(core: core, notifier: FakeWatchNotifier(), tap: FakeWatchTap(), scheduler: FakeWatchTimers(),
                                 workspace: false, wallMs: { 5 })
        watcher.liveState?.treeRead = { _ in [] }
        watcher.onEvent = { [sink] in sink!.event($0) }
    }

    func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    func arm(_ id: String, _ c: CUWatchConditionWire) async throws -> WatchArmResult {
        try await watcher.arm(WatchArmParams(targetId: "t1", watchId: id, condition: c, expiresAt: nil), connection: 1)
    }

    func testArmNamesTheElementAndTheWindow() async throws {
        let r = try await arm("wk_1", .init(kind: "clicked", ref: ref(button)))
        XCTAssertEqual(r.element, CUWatchElement(role: "button", name: "Send"))
        XCTAssertEqual(r.targetLabel, "Mail — Inbox")
        let f = try await arm("wk_2", .init(kind: "changed", ref: ref(field)))
        XCTAssertEqual(f.element?.name, "Subject", "named like state(): its placeholder when it has no title")
    }

    func testASecureFieldIsNeverWatched() async throws {
        do {
            _ = try await arm("wk_p", .init(kind: "changed", ref: ref(password)))
            XCTFail("armed on a password field")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "refused")
            XCTAssertEqual(e.data?["reason"], .string("secure_field"))
        }
        XCTAssertEqual(watcher.armedCount, 0)
    }

    func testACaptureOnlyWindowAndAnUnknownTargetAreRefused() async throws {
        target.accessible = false
        await XCTAssertThrowsErrorAsync(try await self.arm("wk_c", .init(kind: "titled", title: "x")))
        do {
            _ = try await watcher.arm(WatchArmParams(targetId: "t9", watchId: "wk_u", condition: .init(kind: "titled", title: "x")), connection: 1)
        } catch let e as CUError { XCTAssertEqual(e.code, "target_lost") }
    }

    func testATitleAlreadyThereIsRefused() async throws {
        do {
            _ = try await arm("wk_t", .init(kind: "titled", title: "inbox"))
            XCTFail("armed")
        } catch let e as CUError {
            XCTAssertEqual(e.message, "Mail's window title already contains \u{201C}inbox\u{201D} — nothing to wait for; check state()")
        }
    }

    func testTheWatchOutlivesTheScriptsBindingAndEndsOnlyByItsOwnCauses() async throws {
        _ = try await arm("wk_1", .init(kind: "clicked", ref: ref(button)))
        _ = try await arm("wk_2", .init(kind: "appeared", text: "Sent"))
        // A reset or a worker restart releases the target; the worker's idle end ends the session helper-side.
        _ = try await core.targetRelease(TargetReleaseParams(targetId: "t1"))
        _ = try await core.sessionEnded(SessionEndedParams(sessionId: "s1"))
        XCTAssertThrowsError(try core.target("t1"), "the script's binding is gone")
        await watcher.evaluate(pid: pid)
        XCTAssertEqual(watcher.armedIds, ["wk_1", "wk_2"], "the watches are not")
        XCTAssertTrue(sink.events.isEmpty)
        // Its own causes still reach it: the text appears (not Winter's doing), then the element goes.
        watcher.liveState?.treeRead = { _ in [CUNode(ref: 1, role: "AXStaticText", name: "Message Sent")] }
        await watcher.evaluate(pid: pid)
        XCTAssertEqual(sink.events.map(\.detail), ["appeared"])
        ax.dead.insert(AXIdentity(element: button))
        await watcher.evaluate(pid: pid)
        XCTAssertEqual(sink.events.last?.outcome, .lost)
        XCTAssertEqual(watcher.armedCount, 0)
    }

    func testATitleWatchReadsTheTitleAloneNeverTheTree() async throws {
        var reads = 0
        watcher.liveState?.treeRead = { _ in reads += 1; return [] }
        _ = try await arm("wk_t", .init(kind: "titled", title: "Sent"))
        await watcher.evaluate(pid: pid)
        XCTAssertTrue(sink.events.isEmpty)
        ax.put(window, [kAXTitleAttribute: "Inbox — Message Sent"])
        await watcher.evaluate(pid: pid)
        XCTAssertEqual(sink.events.map(\.detail), ["title now \u{201C}Inbox — Message Sent\u{201D}"])
        XCTAssertEqual(reads, 0)
    }

    func testTheAppQuittingLosesTheWatch() async throws {
        _ = try await arm("wk_q", .init(kind: "titled", title: "Done"))
        sys.running = []
        await watcher.evaluate(pid: pid)
        XCTAssertEqual(sink.events.first, CUWatchEvent(watchId: "wk_q", outcome: .lost, at: 5, reason: "the app quit"))
    }

    func testTheWindowClosingLosesTheWatch() async throws {
        _ = try await arm("wk_w", .init(kind: "titled", title: "Done"))
        ax.dead.insert(AXIdentity(element: window))
        sys.windows[77] = nil
        await watcher.evaluate(pid: pid)
        XCTAssertEqual(sink.events.first?.reason, "the window closed")
    }

    func testTheRingIsDrawnOnlyWhileTheBoundWindowIsFrontmost() async throws {
        _ = try await arm("wk_1", .init(kind: "clicked", ref: ref(button)))
        let subject = CUWatcher.Subject(watchId: "wk_1", connection: 1, sessionId: "s1", pid: pid, windowID: 77, appName: "Mail",
                                        condition: .clicked(ref: 1), target: target, element: button, label: "Send")
        sys.front = 1
        var shown = await core.presentWatch(subject, state: watcher.liveState!)
        XCTAssertNil(shown, "the user is in another app")
        sys.front = pid
        shown = await core.presentWatch(subject, state: watcher.liveState!)
        XCTAssertEqual(shown?.elementFrame, CGRect(x: 10, y: 10, width: 60, height: 20))
        XCTAssertEqual(shown?.label, "Send")
        let other = FakeSystem.window(78, pid: pid, CGRect(x: 0, y: 0, width: 10, height: 10), owner: "Mail")
        sys.stack = [other, sys.windows[77]!]
        shown = await core.presentWatch(subject, state: watcher.liveState!)
        XCTAssertNil(shown, "another window of the app is in front of it")
    }
}
