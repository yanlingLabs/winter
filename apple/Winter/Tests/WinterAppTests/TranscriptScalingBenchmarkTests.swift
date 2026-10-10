import XCTest
import SwiftUI
import AppKit
import WinterProtocol
import WinterKit
@testable import Winter

// -----------------------------------------------------------------------------------------------
// What one streamed update costs the main thread, against how much transcript is already in the window — and whether the
// window goes quiet when the stream stops.
//
// The live freeze (2026-10-10): a detached window on a long computer-use session (3 turns, 85 calls with 4–38 KB
// results, 88 reasoning blocks, 68 replies) sat at 100% CPU, minutes after the session's last event. The main thread
// never left SwiftUI's run-loop commit observer: `LazyLayoutViewCache.signalPrefetch` asking the hosting view for another
// update after every update (`Update.end` → `dispatchActions` → `requestUpdate(after:)`), `updatePrefetchPhases` copying
// and destroying arrays of `Update.Action` on each pass, and every sample inside the transcript's lazy stack.
//
// These tests host the REAL pill-themed window content (`WindowContentView`: the transcript, the composer) — and, for the
// shared-feed one, the real `DetachedWindowController` — in a window the window server shows (fully transparent), fold a
// generated history into the session, and stream into it. Generated text only: the shapes come from the frozen session's
// statistics (event types, sizes, kinds, timings), nothing from its content.
// -----------------------------------------------------------------------------------------------

private final class QuietNotifier: NotificationPosting {
    func post(title: String, body: String) {}
}

final class PingLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [Double] = []
    private var _done = false
    func add(_ v: Double) { lock.lock(); _values.append(v); lock.unlock() }
    func finish() { lock.lock(); _done = true; lock.unlock() }
    var done: Bool { lock.lock(); defer { lock.unlock() }; return _done }
    var values: [Double] { lock.lock(); defer { lock.unlock() }; return _values }
}

/// The window content in a host, driven by hand.
@MainActor
final class TranscriptHarness {
    let session = SessionModel(notifier: QuietNotifier())
    let adapter: FieldStateAdapter
    let host: NSHostingView<AnyView>
    let window: NSWindow

    /// `onScreen`: the window is ordered in (fully transparent, no activation) — SwiftUI prefetches and animates only for
    /// a window the window server shows, and the live freeze was in one.
    init(size: CGSize = CGSize(width: 900, height: 800), onScreen: Bool = false) {
        adapter = FieldStateAdapter(session: session)
        let content = WindowContentView(adapter: adapter, tint: .white, topInset: 8, sidebars: nil, topBleed: 54, pillChrome: true) { EmptyView() }
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
            .environment(\.transcriptUserMessageStyle, .ruled)
            .environment(\.transcriptToolRowStyle, .pill)
            .environment(\.transcriptMarkerTint, .white)
            .background(Color.black)
            .environment(\.colorScheme, .dark)
        host = NSHostingView(rootView: AnyView(content))
        host.frame = CGRect(origin: .zero, size: size)
        window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        if onScreen {
            window.alphaValue = 0.01
            window.ignoresMouseEvents = true
            window.orderFrontRegardless()
        }
        host.layoutSubtreeIfNeeded()
    }

    deinit {
        MainActor.assumeIsolated { window.contentView = NSView() }
    }

    /// What the display cycle does after a publish: lay the window out and draw it.
    func settle() {
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
    }

    /// Main-thread CPU milliseconds `body` plus the settle after it cost.
    @discardableResult
    func cost(_ body: () -> Void) -> Double {
        let cpu = currentThreadCPUSeconds()
        body()
        settle()
        // SwiftUI's own transaction runs from a run-loop observer: let it, then settle what it scheduled.
        RunLoop.main.run(until: Date().addingTimeInterval(0.001))
        settle()
        return (currentThreadCPUSeconds() - cpu) * 1000
    }

    /// The transcript's scroll view (the first one with a document).
    var scrollView: NSScrollView? {
        func find(_ view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView, scroll.documentView != nil { return scroll }
            for sub in view.subviews { if let found = find(sub) { return found } }
            return nil
        }
        return find(host)
    }

    /// Reads the whole transcript the way a user does over an hour: from the bottom to the top and back, a step at a time,
    /// laying out (and drawing) after each, so every cell the stack can hold has been built.
    func walkTheTranscript(steps: Int = 60) {
        guard let scroll = scrollView, let document = scroll.documentView else { return }
        for pass in 0..<2 {
            guard document.frame.height > scroll.contentView.bounds.height else { return }
            for i in 0...steps {
                let t = Double(i) / Double(steps)
                let fraction = pass == 0 ? 1 - t : t
                scroll.contentView.scroll(to: NSPoint(x: 0, y: (document.frame.height - scroll.contentView.bounds.height) * fraction))
                scroll.reflectScrolledClipView(scroll.contentView)
                settle()
                RunLoop.main.run(until: Date().addingTimeInterval(0.004))
            }
        }
    }

    static func decode(_ events: [[String: Any]]) -> [SessionEvent] {
        events.compactMap { dict in
            guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
            return try? JSONDecoder().decode(SessionEvent.self, from: data)
        }
    }
}

@MainActor
final class TranscriptScalingBenchmarkTests: XCTestCase {
    override func setUp() {
        super.setUp()
        PlumeLayerView.runsInUnshownWindows = true
    }

    override func tearDown() {
        PlumeLayerView.runsInUnshownWindows = false
        super.tearDown()
    }

    // MARK: - The window of cells (pure)

    /// How far back the window reaches: whole exchanges, until they hold enough cells.
    func testTheWindowReachesBackInWholeExchangesUntilItHoldsEnoughCells() {
        let cells = [10, 50, 3, 40, 100] // the exchanges' cell counts, oldest first
        func start(holding: Int, before end: Int = 5) -> Int {
            TranscriptView.exchangeIndex(holding: holding, endingBefore: end) { cells[$0] }
        }
        XCTAssertEqual(start(holding: 80), 4, "the newest exchange alone holds 100: an exchange is never cut")
        XCTAssertEqual(start(holding: 100), 4)
        XCTAssertEqual(start(holding: 101), 3, "one more exchange once the newest is not enough")
        XCTAssertEqual(start(holding: 140), 3)
        XCTAssertEqual(start(holding: 141), 2)
        XCTAssertEqual(start(holding: 10_000), 0, "a transcript that fits is held whole")
        XCTAssertEqual(start(holding: 80, before: 0), 0, "nothing to hold")
        XCTAssertEqual(start(holding: 5, before: 3), 1, "'Show earlier' reaches back from the first exchange held")
    }

    // MARK: - The window stays put under a reader

    /// Three 57-cell turns in a window (the newest two fit the 80-cell window, so exchange 1 is the first held), and the
    /// next two turns, to arrive one at a time.
    private func threeTurnsAndTwoMore() throws -> (history: [SessionEvent], fourth: [SessionEvent], fifth: [SessionEvent]) {
        let all = SyntheticSession.completedTurns(5)
        let starts = all.indices.filter { all[$0]["type"] as? String == "user_message" }
        XCTAssertEqual(starts.count, 5)
        return (TranscriptHarness.decode(Array(all[..<starts[3]])),
                TranscriptHarness.decode(Array(all[starts[3]..<starts[4]])),
                TranscriptHarness.decode(Array(all[starts[4]...])))
    }

    private func arrive(_ events: [SessionEvent], in harness: TranscriptHarness) async throws {
        harness.session.apply(contentsOf: events)
        harness.settle()
        try await Task.sleep(nanoseconds: 600_000_000)
    }

    /// A reader at the bottom follows the tail: the window moves on with each new turn.
    func testTheWindowFollowsTheTailForAReaderAtTheBottom() async throws {
        let (history, fourth, fifth) = try threeTurnsAndTwoMore()
        let harness = TranscriptHarness(onScreen: true)
        harness.session.apply(replay: history)
        harness.settle()
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(transcriptFirstExchangeHeld, 1)
        try await arrive(fourth, in: harness)
        XCTAssertEqual(transcriptFirstExchangeHeld, 2, "the newest two exchanges")
        try await arrive(fifth, in: harness)
        XCTAssertEqual(transcriptFirstExchangeHeld, 3)
    }

    /// A reader who scrolls up to a turn keeps it: a later turn does not push its exchange out of the window (it would turn
    /// into "Show earlier turns" under their eyes). The window had already moved on once, with the reader at the bottom.
    func testTheWindowStaysWhereAReaderScrolledUpTo() async throws {
        let (history, fourth, fifth) = try threeTurnsAndTwoMore()
        let harness = TranscriptHarness(onScreen: true)
        harness.session.apply(replay: history)
        harness.settle()
        try await Task.sleep(nanoseconds: 1_500_000_000)
        try await arrive(fourth, in: harness)
        XCTAssertEqual(transcriptFirstExchangeHeld, 2)
        let scroll = try XCTUnwrap(harness.scrollView)
        // The user drags the view up: a live scroll.
        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
        harness.settle()
        try await Task.sleep(nanoseconds: 300_000_000)
        try await arrive(fifth, in: harness)
        XCTAssertEqual(transcriptFirstExchangeHeld, 2, "the exchange they scrolled up to is still held")
    }

    // MARK: - Per-update cost against length

    struct Sample {
        var turns: Int
        var items: Int
        var openMs: Double
        var updateP50: Double
        var updateP95: Double
    }

    /// A window holding `turns` completed turns (28 calls each), then a new turn streaming into it a chunk at a time.
    func measure(turns: Int, chunks: Int = 45) -> Sample {
        let history = SyntheticSession.completedTurns(turns)
        let events = TranscriptHarness.decode(history)
        let harness = TranscriptHarness()
        let open = harness.cost { harness.session.apply(replay: events) }
        let lastSeq = history.last.flatMap { ($0["seq"] as? NSNumber)?.intValue } ?? 0
        let stream = TranscriptHarness.decode(SyntheticSession.streamingTurn(after: lastSeq, chunks: chunks))
        var costs: [Double] = []
        for (index, event) in stream.enumerated() {
            let ms = harness.cost { harness.session.apply(event) }
            if index >= 2 { costs.append(ms) } // the user message and the turn start open the exchange: not a chunk
        }
        costs.sort()
        return Sample(turns: turns, items: harness.session.state.exchanges.reduce(0) { $0 + $1.activity.count }, openMs: open,
                      updateP50: costs[costs.count / 2], updateP95: costs[Int(Double(costs.count - 1) * 0.95)])
    }

    /// The best of a few runs: CPU time inflates under contention, and what is asked here is how it scales.
    func best(turns: Int, runs: Int = 3) -> Sample {
        (0..<runs).map { _ in measure(turns: turns) }.min { $0.updateP50 < $1.updateP50 }!
    }

    func report(_ samples: [Sample]) {
        print("SCALING  turns  items |  open ms | per-update ms: p50   p95")
        for s in samples {
            print(String(format: "SCALING  %5d  %5d | %8.0f | %19.1f %5.1f", s.turns, s.items, s.openMs, s.updateP50, s.updateP95))
        }
    }

    /// THE GUARD: a streamed update costs the same in a window holding 170 items as in one holding 1,700. (Before the stack
    /// held a window of cells, the same update cost 3× as much at the longer length: 1.4 → 4.1 ms.)
    func testPerUpdateCostIsFlatFromOneHundredToTwoThousandItems() throws {
        let short = best(turns: 3)   // ~170 items
        let long = best(turns: 30)   // ~1,700 items
        report([short, long])
        XCTAssertGreaterThan(long.items, 1_500)
        XCTAssertLessThan(long.updateP50, short.updateP50 * 1.6 + 0.3,
                          "a publish into a 10× longer transcript must not cost more: \(short.updateP50) ms → \(long.updateP50) ms")
    }

    /// However long the transcript, the stack holds about a window of it, even after the reader has been through all of it
    /// (a window open for an hour). Before, every cell the reader had passed stayed built: 2,261 cells for 1,680 items.
    func testTheStackHoldsAboutAWindowOfCellsHoweverLongTheTranscript() throws {
        let history = SyntheticSession.completedTurns(30)
        let harness = TranscriptHarness()
        let before = transcriptCellBodyEvaluations
        harness.session.apply(replay: TranscriptHarness.decode(history))
        harness.settle()
        harness.walkTheTranscript()
        let built = transcriptCellBodyEvaluations - before
        print("WINDOW cells built after walking a 1,680-item transcript: \(built)")
        // The window (80 cells) plus the rest of the exchange it ends in (a turn of 28 calls is ~45 cells) — a literal, so
        // that raising the window cannot raise the bar with it.
        XCTAssertLessThan(built, 250)
        XCTAssertGreaterThan(built, 20, "the walk did build the cells it passed")
    }

    // MARK: - Quiet after the last event

    /// The turn that froze the user's window, event for event (types, kinds, lengths and timings — the text generated): a
    /// reviewer's question from `winter -p`, 4 s of silence, a HIDDEN reasoning block (no text, 652 ms), 7 s more, then a
    /// 6 KB reply.
    static func hiddenReasoningTurn(after seq: Int) -> [(delayMs: Int, event: [String: Any])] {
        let session = SyntheticSession.sessionId
        let ts = 1_791_496_518_000.0 + 20_000_000
        func event(_ type: String, _ n: Int, _ fields: [String: Any]) -> [String: Any] {
            var e: [String: Any] = ["type": type, "seq": seq + n, "sessionId": session, "ts": ts + Double(n), "threadId": "main"]
            e.merge(fields) { _, new in new }
            return e
        }
        let prose = String(repeating: "A reviewer question about the diff and whether the guardian undoes the right change. ", count: 5).prefix(420)
        var reply = ""
        while reply.count < 5_983 { reply += "The guardian only undoes a change that happens within a second and a half of the agent's own act, so a user move is kept. " }
        return [
            (0, event("user_message", 1, ["text": String(prose), "clientName": "cli-p"])),
            (1, event("turn_started", 2, [:])),
            (4_000, event("thinking_delta", 2, ["blockId": "hid", "kind": "hidden", "phase": "start"])),
            (650, event("thinking_block", 3, ["blockId": "hid", "kind": "hidden", "text": "", "provider": "openai", "model": "m", "durationMs": 652])),
            (7_100, event("assistant_message", 4, ["text": String(reply.prefix(5_983))])),
            (3, event("turn_completed", 5, ["stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1])),
        ]
    }

    /// One second at a time after the turn's last event: the main thread's busy share and what the followers did.
    func watchTheTranscriptGoQuiet(seconds: Int = 8) async throws -> [(busy: Double, steps: Int, applies: Int, bodies: Int)] {
        var out: [(busy: Double, steps: Int, applies: Int, bodies: Int)] = []
        var previous = transcriptFollowStats
        var bodies = transcriptCellBodyEvaluations
        for _ in 0..<seconds {
            let cpu = currentThreadCPUSeconds()
            let wall = DispatchTime.now().uptimeNanoseconds
            try await Task.sleep(nanoseconds: 1_000_000_000)
            let busy = (currentThreadCPUSeconds() - cpu) / (Double(DispatchTime.now().uptimeNanoseconds - wall) / 1e9)
            let now = transcriptFollowStats
            out.append((busy, now.steps - previous.steps, now.applies - previous.applies, transcriptCellBodyEvaluations - bodies))
            previous = now
            bodies = transcriptCellBodyEvaluations
        }
        return out
    }

    func assertQuiet(_ seconds: [(busy: Double, steps: Int, applies: Int, bodies: Int)], file: StaticString = #filePath, line: UInt = #line) {
        for (index, second) in seconds.enumerated() {
            print(String(format: "QUIET second %d | main busy %3.0f%% | follower steps %d applies %d | cell bodies %d", index + 1, second.busy * 100,
                         second.steps, second.applies, second.bodies))
        }
        // From the third second on there is nothing left to do: the main thread is idle and the followers' links are paused.
        for second in seconds.dropFirst(2) {
            XCTAssertLessThan(second.busy, 0.05, "the transcript is still busy after the stream stopped", file: file, line: line)
            XCTAssertEqual(second.steps, 0, "a follower is still stepping", file: file, line: line)
            XCTAssertEqual(second.bodies, 0, "cells are still being rebuilt", file: file, line: line)
        }
    }

    /// The freeze's signature was a transcript that never stopped working. After the last event of a live turn into a window
    /// with history, nothing may keep ticking.
    func testTheTranscriptGoesQuietAfterTheTurnsLastEvent() async throws {
        let history = SyntheticSession.completedTurns(3)
        let harness = TranscriptHarness(onScreen: true)
        harness.session.apply(replay: TranscriptHarness.decode(history))
        harness.settle()
        try await Task.sleep(nanoseconds: 2_500_000_000)
        let lastSeq = history.last.flatMap { ($0["seq"] as? NSNumber)?.intValue } ?? 0
        for (delay, dict) in Self.hiddenReasoningTurn(after: lastSeq) {
            try await Task.sleep(nanoseconds: UInt64(min(delay, 800)) * 1_000_000)
            for event in TranscriptHarness.decode([dict]) { harness.session.apply(contentsOf: [event]) }
        }
        assertQuiet(try await watchTheTranscriptGoQuiet())
    }

    /// The same through a real `DetachedWindowController` on a shared feed — the Dispatch pill's child feed holds the session
    /// first and the window joins it late — with the history arriving as the daemon sends it (an attach and a replay).
    func testARealDetachedWindowOnASharedFeedGoesQuietAfterTheTurnsLastEvent() async throws {
        let history = SyntheticSession.completedTurns(3)
        let lastSeq = history.last.flatMap { ($0["seq"] as? NSNumber)?.intValue } ?? 0
        var transports: [FeedScriptedTransport] = []
        let hub = SessionFeedHub { sessionId in
            let transport = FeedScriptedTransport()
            transports.append(transport)
            let model = SessionModel(notifier: QuietNotifier())
            return (SessionFeed(makeTransport: { transport }, token: "tok", clientName: "orb", mode: .pinned(sessionId: sessionId), session: model), model)
        }
        func line(_ dict: [String: Any]) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: dict)) ?? Data()
            return #"{"jsonrpc":"2.0","method":"event","params":"# + String(decoding: data, as: UTF8.self) + "}"
        }
        let holder = try XCTUnwrap(hub.lease(sessionId: SyntheticSession.sessionId))
        defer { holder.release() }
        let t = transports[0]
        await feedWaitUntil { t.sent.contains { feedLineJSON($0)["method"] as? String == "protocol.hello" } }
        if let hello = t.sent.map({ feedLineJSON($0) }).first(where: { $0["method"] as? String == "protocol.hello" }) {
            t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        }
        await feedWaitUntil { t.sent.contains { feedLineJSON($0)["method"] as? String == "session.attach" } }
        if let attach = t.sent.map({ feedLineJSON($0) }).first(where: { $0["method"] as? String == "session.attach" }) {
            t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":\#(lastSeq)}}"#)
        }
        for dict in history { t.feed(line(dict)) }
        await feedWaitUntil(8) { holder.session.isLoadingHistory == false && holder.session.state.exchanges.count == 3 }
        let windowLease = try XCTUnwrap(hub.lease(sessionId: SyntheticSession.sessionId))
        let windowModel = SessionModel(notifier: QuietNotifier())
        windowModel.follow(windowLease.session)
        let controller = DetachedWindowController(lease: windowLease, session: windowModel,
                                                  frame: NSRect(x: 100, y: 100, width: 900, height: 800), title: "t")
        controller.show()
        controller.windowForTesting?.alphaValue = 0.01
        defer { controller.close() }
        try await Task.sleep(nanoseconds: 2_500_000_000)
        for (delay, dict) in Self.hiddenReasoningTurn(after: lastSeq) {
            try await Task.sleep(nanoseconds: UInt64(min(delay, 800)) * 1_000_000)
            t.feed(line(dict))
        }
        assertQuiet(try await watchTheTranscriptGoQuiet())
    }

    // MARK: - Diagnosis aids (skipped unless asked for)

    /// For attaching `sample` to the test host: streams for a long while into a window with history. Skipped unless
    /// `WINTER_PROFILE_SECONDS` is set.
    func testStreamForProfiling() async throws {
        guard let seconds = ProcessInfo.processInfo.environment["WINTER_PROFILE_SECONDS"].flatMap(Double.init) else { throw XCTSkip("profiling aid") }
        let history = SyntheticSession.completedTurns(3)
        let harness = TranscriptHarness(onScreen: true)
        harness.session.apply(replay: TranscriptHarness.decode(history))
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let lastSeq = history.last.flatMap { ($0["seq"] as? NSNumber)?.intValue } ?? 0
        let stream = TranscriptHarness.decode(SyntheticSession.streamingTurn(after: lastSeq, chunks: Int(seconds * 30)))
        var next = Date()
        for event in stream {
            harness.session.apply(contentsOf: [event])
            next = next.addingTimeInterval(1.0 / 30)
            let wait = next.timeIntervalSinceNow
            if wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
        }
    }

    /// DIAGNOSIS ONLY, skipped unless `WINTER_REPLAY_LOG` names a session log: the user's own log up to its last turn, then
    /// that turn's own events at their own pace, into a window on a shared feed. Read where it is, never copied or printed —
    /// only timings.
    func testAUsersOwnLastTurnGoesQuiet() async throws {
        guard let path = ProcessInfo.processInfo.environment["WINTER_REPLAY_LOG"], !path.isEmpty,
              let persisted = ReplayScript.persisted(fromLog: path) else { throw XCTSkip("set WINTER_REPLAY_LOG to a session .jsonl") }
        func seq(_ e: [String: Any]) -> Int { (e["seq"] as? NSNumber)?.intValue ?? 0 }
        func ts(_ e: [String: Any]) -> Double { (e["ts"] as? NSNumber)?.doubleValue ?? 0 }
        let lastUserMessage = persisted.last { ($0["type"] as? String) == "user_message" }.map(seq) ?? Int.max
        let history = persisted.filter { seq($0) < lastUserMessage }
        let live = persisted.filter { seq($0) >= lastUserMessage && ["user_message", "turn_started", "thinking_block", "assistant_message", "turn_completed", "tool_call", "tool_result"].contains($0["type"] as? String ?? "") }
        let harness = TranscriptHarness(onScreen: true)
        harness.session.apply(replay: TranscriptHarness.decode(history))
        harness.settle()
        try await Task.sleep(nanoseconds: 2_500_000_000)
        var previous = ts(live.first ?? [:])
        for dict in live {
            try await Task.sleep(nanoseconds: UInt64(min(max(ts(dict) - previous, 0), 6_000)) * 1_000_000)
            previous = ts(dict)
            if (dict["type"] as? String) == "thinking_block" {
                let start: [String: Any] = ["type": "thinking_delta", "seq": seq(dict) - 1, "sessionId": dict["sessionId"] ?? "", "threadId": "main",
                                            "blockId": dict["blockId"] ?? "b", "kind": dict["kind"] ?? "hidden", "phase": "start", "ts": ts(dict)]
                for event in TranscriptHarness.decode([start]) { harness.session.apply(contentsOf: [event]) }
                try await Task.sleep(nanoseconds: 600_000_000)
            }
            for event in TranscriptHarness.decode([dict]) { harness.session.apply(contentsOf: [event]) }
        }
        assertQuiet(try await watchTheTranscriptGoQuiet())
    }
}
