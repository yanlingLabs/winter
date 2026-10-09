import XCTest
@testable import Winter
import WinterKit

/// The watchdog that explains a stalled main thread: the beat, the one fault line per stall with the context from
/// before it, the line when the main thread answers, and — end to end, on the real thread and the real main queue —
/// a main thread actually blocked for longer than the threshold (the beat is one second, so it takes a few).
@MainActor
final class HangWatchdogTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var _t: TimeInterval = 1_000
        var t: TimeInterval { get { lock.withLock { _t } } set { lock.withLock { _t = newValue } } }
    }

    private final class Lines: @unchecked Sendable {
        private let lock = NSLock()
        private var _items: [(line: String, fault: Bool)] = []
        var items: [(line: String, fault: Bool)] { lock.withLock { _items } }
        func add(_ line: String, _ fault: Bool) { lock.withLock { _items.append((line, fault)) } }
        var faults: [String] { items.filter(\.fault).map(\.line) }
    }

    private final class Pings: @unchecked Sendable {
        private let lock = NSLock()
        private var blocks: [@Sendable () -> Void] = []
        func add(_ block: @escaping @Sendable () -> Void) { lock.withLock { blocks.append(block) } }
        var count: Int { lock.withLock { blocks.count } }
        /// The main thread answering the oldest ping.
        func answer() { let block = lock.withLock { blocks.isEmpty ? nil : blocks.removeFirst() }; block?() }
    }

    private let context = HangContext(attachedSessions: 3, anyTurnLive: true, reducerBacklog: 1_240, oldestEventAge: 4.5, frontmostWindow: "shell")

    private func make(_ clock: Clock, _ lines: Lines, _ pings: Pings) -> HangWatchdog {
        HangWatchdog(now: { clock.t }, gather: { [context] in context }, ping: { pings.add($0) }, report: { lines.add($0, $1) })
    }

    func testAHealthyMainThreadReportsNothingHoweverLongItRuns() {
        let clock = Clock(), lines = Lines(), pings = Pings()
        let dog = make(clock, lines, pings)
        for _ in 0..<200 {
            dog.tick()      // sends a ping
            clock.t += 0.01
            pings.answer()  // the main thread answers at once
            clock.t += 0.24
        }
        XCTAssertTrue(lines.items.isEmpty)
        XCTAssertEqual(dog.lastContext, context, "and each answer refreshed what the report would say")
    }

    func testAStallPastTwoSecondsIsOneFaultLineWithTheContextThenOneLineWhenItEnds() {
        let clock = Clock(), lines = Lines(), pings = Pings()
        let dog = make(clock, lines, pings)
        dog.tick(); pings.answer() // one healthy beat: the context is known
        clock.t += 0.25
        dog.tick()                 // a ping goes out — and the main thread never gets to it
        for _ in 0..<7 { clock.t += 0.25; dog.tick() }
        XCTAssertTrue(lines.faults.isEmpty, "1.75 s is not yet a stall")
        clock.t += 0.25; dog.tick() // 2.0 s
        XCTAssertEqual(lines.faults.count, 1)
        let line = lines.faults[0]
        XCTAssertTrue(line.contains("stalled 2.0 s"), line)
        XCTAssertTrue(line.contains("attachedSessions=3"), line)
        XCTAssertTrue(line.contains("anyTurnLive=true"), line)
        XCTAssertTrue(line.contains("reducerBacklog=1240"), line)
        XCTAssertTrue(line.contains("frontmostWindow=shell"), line)
        for _ in 0..<20 { clock.t += 0.25; dog.tick() }
        XCTAssertEqual(lines.faults.count, 1, "one line per stall, however long it goes on")

        pings.answer() // the main thread comes back
        let recovery = lines.items.last!
        XCTAssertFalse(recovery.fault)
        XCTAssertTrue(recovery.line.contains("answering again after 7.0 s"), recovery.line)

        // …and the next stall is its own line.
        dog.tick(); clock.t += 2.5; dog.tick()
        XCTAssertEqual(lines.faults.count, 2)
    }

    /// A livelocked main thread answers every ping — a beat late. That never trips the stall line, so it has its own:
    /// one notice per episode, after enough late answers in a row.
    func testAMainThreadThatAnswersEveryPingLateIsOneSluggishNoticeNotAStall() {
        let clock = Clock(), lines = Lines(), pings = Pings()
        let dog = make(clock, lines, pings)
        for _ in 0..<(HangWatchdog.sluggishAfter - 1) {
            dog.tick(); clock.t += 0.3; pings.answer()
        }
        XCTAssertTrue(lines.items.isEmpty, "not yet")
        dog.tick(); clock.t += 0.3; pings.answer()
        XCTAssertEqual(lines.items.count, 1)
        XCTAssertFalse(lines.items[0].fault, "a notice: nothing was blocked")
        XCTAssertTrue(lines.items[0].line.contains("main thread sluggish"), lines.items[0].line)
        XCTAssertTrue(lines.items[0].line.contains("frontmostWindow=shell"), lines.items[0].line)
        for _ in 0..<20 { dog.tick(); clock.t += 0.3; pings.answer() }
        XCTAssertEqual(lines.items.count, 1, "one per episode")
        XCTAssertTrue(lines.faults.isEmpty)

        dog.tick(); clock.t += 0.01; pings.answer() // an answer on time ends the episode
        for _ in 0..<HangWatchdog.sluggishAfter { dog.tick(); clock.t += 0.3; pings.answer() }
        XCTAssertEqual(lines.items.count, 2, "and the next episode is its own line")
    }

    func testOnlyTheMainThreadsAnswerGathersTheContext() {
        let clock = Clock(), lines = Lines(), pings = Pings()
        var gathers = 0
        let dog = HangWatchdog(now: { clock.t }, gather: { gathers += 1; return HangContext() }, ping: { pings.add($0) }, report: { lines.add($0, $1) })
        for _ in 0..<5 { dog.tick() } // one ping out, the rest are beats waiting for it
        XCTAssertEqual(pings.count, 1, "never a second ping while one is out")
        XCTAssertEqual(gathers, 0, "the watchdog's own thread reads nothing of the app's")
        pings.answer()
        XCTAssertEqual(gathers, 1)
    }

    /// The real thing: its own thread, the real main queue, a main thread blocked for 2.8 s.
    func testARealBlockedMainThreadIsReported() async {
        let lines = Lines()
        let dog = HangWatchdog(gather: { HangContext(attachedSessions: 1, anyTurnLive: false, reducerBacklog: 0, oldestEventAge: 0, frontmostWindow: "test") },
                               report: { lines.add($0, $1) })
        dog.start()
        defer { dog.stop() }
        try? await Task.sleep(nanoseconds: 2_300_000_000) // a couple of healthy beats
        XCTAssertTrue(lines.faults.isEmpty, "\(lines.items)")
        Thread.sleep(forTimeInterval: 4.2) // the main thread, stuck across at least one beat past the 2 s threshold
        try? await Task.sleep(nanoseconds: 1_500_000_000) // it gets to answer
        XCTAssertEqual(lines.faults.count, 1, "\(lines.items)")
        XCTAssertTrue(lines.faults.first?.contains("frontmostWindow=test") == true)
        XCTAssertTrue(lines.items.contains { !$0.fault && $0.line.contains("answering again") }, "\(lines.items)")
    }

    func testTheContextNamesTheAttachedSessionsTheirTurnsAndTheirBacklog() {
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { AppScriptedTransport() }, token: "t", clientName: "test",
                               mode: .pinned(sessionId: "s_hang_report"), session: session)
        session.applyForTesting { $0.turnRunning = true }
        feed.extraBacklog = { 7 }
        let mine = FeedRegistry.shared.snapshot.first { $0.sessionId == "s_hang_report" }
        XCTAssertEqual(mine?.turnLive, true)
        XCTAssertEqual(mine?.backlog, 7)
        let gathered = HangContext.gather(frontmostWindow: { "detached" })
        XCTAssertGreaterThanOrEqual(gathered.attachedSessions, 1)
        XCTAssertTrue(gathered.anyTurnLive)
        XCTAssertGreaterThanOrEqual(gathered.reducerBacklog, 7)
        XCTAssertEqual(gathered.frontmostWindow, "detached")
        withExtendedLifetime(feed) {}
    }
}
