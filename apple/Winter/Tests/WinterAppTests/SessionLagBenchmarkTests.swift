import XCTest
import Combine
import WinterProtocol
@testable import Winter

/// A benchmark of the detached window's work on a session shaped like the one that lagged: 60 ComputerV2
/// calls whose results are up to 64 KiB of state text, a reasoning block before each, and the thousands
/// of `thinking_delta`s a reasoning model streams. It folds the stream the OLD way (one publish per
/// delta) and the NEW way (batched), and runs the per-render work a transcript pass does (labels,
/// statuses, failure lines, discs) so the cost of the old and new code can be set side by side.
///
/// It prints its numbers (`BENCH …`) and asserts only generous ratios, never wall-clock limits, so a slow
/// machine cannot fail it. Point `WINTER_BENCH_LOG` at a COPY of a session's `.jsonl` to run it on real
/// events (reasoning deltas are synthesised from each `thinking_block`); without it a synthetic
/// session of the same shape is used. It never reads `~/.winter*`.
///
/// **What it does NOT measure: SwiftUI.** Layout and body evaluation of the rows are not run here; the
/// per-pass work is the PURE half of what each row does, and the clocks it counts are the pills whose
/// body would be re-run twice a second.
@MainActor
final class SessionLagBenchmarkTests: XCTestCase {
    private let sid = "s_bench"
    private let blocks = 60

    // MARK: - The session

    private func event(_ fields: [String: Any]) -> SessionEvent {
        let json = String(data: try! JSONSerialization.data(withJSONObject: fields.merging(["sessionId": sid]) { a, _ in a }), encoding: .utf8)!
        return try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    /// ~64 KiB of state-shaped text, different per call.
    private func stateText(_ i: Int) -> String {
        var lines: [String] = []
        lines.reserveCapacity(1_600)
        for n in 0..<1_600 { lines.append("  [\(n + i * 7)] button \"Label \(n) of call \(i)\" (enabled)") }
        let text = lines.joined(separator: "\n")
        return String(text.prefix(64 * 1024 - 1))
    }

    private func reasoningText(_ i: Int) -> String {
        String(repeating: "Testing with a single character, then checking whether the toggle took effect \(i). ", count: 22)
    }

    /// Splits a block's text into increments of about `size` characters, as a stream would send them.
    private func deltas(for blockId: String, text: String, size: Int, seq: Int) -> [SessionEvent] {
        var out: [SessionEvent] = [.thinkingDelta(.init(seq: seq, sessionId: sid, ts: 0, threadId: "main", blockId: blockId, kind: "summary", phase: "start"))]
        var index = text.startIndex
        while index < text.endIndex {
            let end = text.index(index, offsetBy: size, limitedBy: text.endIndex) ?? text.endIndex
            out.append(.thinkingDelta(.init(seq: seq, sessionId: sid, ts: 0, threadId: "main", blockId: blockId, kind: "summary",
                                            phase: "delta", text: String(text[index..<end]), title: "Testing with a single character")))
            index = end
        }
        return out
    }

    private func syntheticSession() -> [SessionEvent] {
        var events: [SessionEvent] = [
            event(["type": "user_message", "seq": 3, "ts": 1, "threadId": "main", "text": "Check the editor toggle.", "clientName": "dispatch"]),
            event(["type": "turn_started", "seq": 4, "ts": 2, "threadId": "main"]),
        ]
        var seq = 5
        for i in 0..<blocks {
            let text = reasoningText(i)
            events += deltas(for: "b\(i)", text: text, size: 5, seq: seq)
            events.append(event(["type": "thinking_block", "seq": seq, "ts": 3, "threadId": "main", "blockId": "b\(i)", "kind": "summary", "text": text])); seq += 1
            events.append(event(["type": "tool_call", "seq": seq, "ts": 3, "threadId": "main", "callId": "call_\(i)", "name": "computer_v2",
                                 "argsJson": #"{"code":"const code = await apps.open(\"Code\");\nawait code.click(12);\nawait code.paste(\"x\");\nawait code.state();"}"#])); seq += 1
            events.append(event(["type": "tool_result", "seq": seq, "ts": 4, "threadId": "main", "callId": "call_\(i)", "output": stateText(i), "isError": i % 7 == 6])); seq += 1
        }
        return events
    }

    /// The real log, when `WINTER_BENCH_LOG` names a copy of one: its events in order, with a delta stream
    /// synthesised before each reasoning block (the log keeps only the persisted block).
    private func realSession(path: String) -> [SessionEvent]? {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        var events: [SessionEvent] = []
        for line in text.split(separator: "\n") {
            guard let e = try? JSONDecoder().decode(SessionEvent.self, from: Data(line.utf8)) else { continue }
            if case .thinkingBlock(let b) = e { events += deltas(for: b.blockId, text: b.text, size: 5, seq: b.seq) }
            events.append(e)
        }
        return events
    }

    private func session() -> (events: [SessionEvent], source: String) {
        if let path = ProcessInfo.processInfo.environment["WINTER_BENCH_LOG"], let real = realSession(path: path) {
            return (real, "real log copy")
        }
        return (syntheticSession(), "synthetic, log-shaped")
    }

    // MARK: - Measuring

    private func time(_ body: () -> Void) -> Double {
        let start = DispatchTime.now().uptimeNanoseconds
        body()
        return Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }

    private func publishCount(of model: SessionModel, during body: () -> Void) -> Int {
        var count = 0
        let cancellable = model.$state.dropFirst().sink { _ in count += 1 }
        body()
        cancellable.cancel()
        return count
    }

    /// The old path: every event applied on its own — one publish each.
    private func foldOneAtATime(_ events: [SessionEvent]) -> (model: SessionModel, ms: Double, publishes: Int) {
        let model = SessionModel(notifier: Silent())
        var ms = 0.0
        let publishes = publishCount(of: model) { ms = time { for e in events { model.apply(e) } } }
        return (model, ms, publishes)
    }

    /// The new path: streamed chunks gathered and folded together, `perFlush` at a time; every other
    /// event folds what is waiting first, then goes in alone — `SessionFeed`'s rule.
    private func foldBatched(_ events: [SessionEvent], perFlush: Int) -> (model: SessionModel, ms: Double, publishes: Int) {
        let model = SessionModel(notifier: Silent())
        var ms = 0.0
        let publishes = publishCount(of: model) {
            ms = time {
                var waiting: [SessionEvent] = []
                for e in events {
                    if e.isStreamedChunk {
                        waiting.append(e)
                        if waiting.count >= perFlush { model.apply(contentsOf: waiting); waiting.removeAll(keepingCapacity: true) }
                    } else {
                        if !waiting.isEmpty { model.apply(contentsOf: waiting); waiting.removeAll(keepingCapacity: true) }
                        model.apply(e)
                    }
                }
                if !waiting.isEmpty { model.apply(contentsOf: waiting) }
            }
        }
        return (model, ms, publishes)
    }

    /// What one transcript pass computes for a session's collapsed rows (the pure half of the bodies).
    private func renderPass(_ state: OrbSessionState, failureSummary: ([ToolRunEntry]) -> String?) -> Int {
        var touched = 0
        for exchange in state.exchanges {
            _ = exchangeTimeline(exchange)
            for group in groupActivity(exchange.activity) {
                guard case .toolRun(let entries) = group else { touched += 1; continue }
                _ = toolRunSentence(entries)
                _ = toolRunStatus(entries, turnIsLive: true)
                _ = failureSummary(entries)
                _ = toolRunCollapsedDiffChips(entries)
                _ = toolRunDiscs(entries)
                for entry in entries { _ = pillToolLabel(entry, turnIsLive: true); touched += 1 }
            }
        }
        return touched
    }

    private func legacyFailureSummary(_ entries: [ToolRunEntry]) -> String? {
        guard let failed = entries.flatMap(\.calls).first(where: \.isError), let output = failed.output,
              let line = output.split(separator: "\n")
                  .map({ $0.trimmingCharacters(in: .whitespaces) })
                  .first(where: { !$0.isEmpty })
        else { return nil }
        return line.count > maxFailureSummaryCharacters ? String(line.prefix(maxFailureSummaryCharacters)) + "…" : line
    }

    // MARK: - The numbers

    func testFoldingTheStreamBatchedDoesFarFewerPublishesAndEndsInTheSameState() {
        let (events, source) = session()
        let deltaCount = events.filter(\.isStreamedChunk).count
        let old = foldOneAtATime(events)
        // 80 ms of a ~5 ms-per-chunk stream is ~16 chunks per fold.
        let new = foldBatched(events, perFlush: 16)

        print("BENCH [\(source)] events=\(events.count) thinking_deltas=\(deltaCount)")
        print(String(format: "BENCH fold one-at-a-time: %.0f ms total, %.1f µs/event, %d publishes (= %d transcript re-renders)",
                     old.ms, old.ms * 1000 / Double(events.count), old.publishes, old.publishes))
        print(String(format: "BENCH fold batched(16):    %.0f ms total, %.1f µs/event, %d publishes", new.ms, new.ms * 1000 / Double(events.count), new.publishes))

        // The working verb is one random roll per turn start (`SessionModel.apply`); everything else must match.
        let verb = old.model.state.workingVerb
        new.model.applyForTesting { $0.workingVerb = verb }
        XCTAssertEqual(old.model.state, new.model.state, "batching changes how often the window renders, never what it ends up showing")
        XCTAssertGreaterThan(deltaCount, 1_000, "a realistic reasoning stream is thousands of deltas")
        XCTAssertLessThan(new.publishes * 8, old.publishes, "at least 8× fewer re-renders")
    }

    func testAWholeStreamFoldedInPlaceBeatsFoldingItByCopy() {
        let (events, _) = session()
        let copying = time {
            var s = OrbSessionState()
            for e in events { s = SessionReducer.reduce(s, e) }
        }
        let inPlace = time {
            var s = OrbSessionState()
            for e in events { SessionReducer.reduceInPlace(&s, e) }
        }
        print(String(format: "BENCH fold %d events by copy: %.0f ms, in place: %.0f ms", events.count, copying, inPlace))
        XCTAssertLessThan(inPlace, copying * 1.2, "in place is never meaningfully slower")
    }

    /// SwiftUI runs `==` on every transcript row input it re-evaluates (`AGDispatchEquatable` → `Exchange.==`,
    /// the frames a hung Debug Winter Dev sat in). Before: the derived deep comparison of every item of
    /// the exchange. After: a stamp compare, falling back to the fields for only the item that changed.
    func testComparingTheExchangeCostsTheChangeNotTheTranscript() {
        let (events, source) = session()
        let model = foldBatched(events, perFlush: 16).model
        let a = model.state.exchanges[0]
        XCTAssertGreaterThan(a.activity.count, 100)

        func deep(_ x: Exchange, _ y: Exchange) -> Bool {
            x.prompt == y.prompt && x.promptEnvelope == y.promptEnvelope && x.replies == y.replies && x.aborted == y.aborted
                && x.activity.count == y.activity.count
                && zip(x.activity, y.activity).allSatisfy { ActivityItem.contentEquals($0, $1) }
        }
        let rounds = 400

        // 1. The same snapshot twice — every unchanged row of a render.
        let sameBefore = time { for _ in 0..<rounds { _ = deep(a, a) } } / Double(rounds)
        let sameAfter = time { for _ in 0..<rounds { _ = (a == a) } } / Double(rounds)

        // 2. One item changed — the row that just took an event.
        var changed = a
        changed.activity[changed.activity.count - 1].scriptCode = "await n.state()"
        let oneBefore = time { for _ in 0..<rounds { _ = deep(a, changed) } } / Double(rounds)
        let oneAfter = time { for _ in 0..<rounds { _ = (a == changed) } } / Double(rounds)

        // 3. The same content built twice, apart (a replay against a live fold): both walk the content.
        let rebuilt = foldBatched(events, perFlush: 16).model.state.exchanges[0]
        let apartBefore = time { for _ in 0..<rounds { _ = deep(a, rebuilt) } } / Double(rounds)
        let apartAfter = time { for _ in 0..<rounds { _ = (a == rebuilt) } } / Double(rounds)

        print("BENCH [\(source)] Exchange == over \(a.activity.count) items (µs per compare, before → after)")
        print(String(format: "BENCH   unchanged snapshot: %.1f → %.2f   one item changed: %.1f → %.1f   rebuilt apart: %.1f → %.1f",
                     sameBefore * 1000, sameAfter * 1000, oneBefore * 1000, oneAfter * 1000, apartBefore * 1000, apartAfter * 1000))

        XCTAssertTrue(a == a)
        XCTAssertFalse(a == changed)
        XCTAssertTrue(a == rebuilt, "equal content, different stamps: still equal")
        XCTAssertLessThan(sameAfter * 4, sameBefore, "an unchanged exchange compares much faster than a walk")
        XCTAssertLessThan(oneAfter, oneBefore * 1.5, "a changed one is never meaningfully slower")
    }

    func testOneTranscriptPassOverTheFinalSessionAndTheClocksItNeeds() {
        let (events, source) = session()
        let model = foldBatched(events, perFlush: 16).model
        let state = model.state
        // The turn is over in the final state; a pass is measured as if it were live (the worst case).
        let calls = state.exchanges.flatMap(\.activity).filter { if case .tool = $0.kind { return true } else { return false } }.count
        let failed = state.exchanges.flatMap(\.activity).filter { if case .tool(_, _, _, _, let isError, _, _) = $0.kind { return isError } else { return false } }.count

        _ = renderPass(state, failureSummary: legacyFailureSummary) // warm
        let rounds = 20
        let before = time { for _ in 0..<rounds { _ = renderPass(state, failureSummary: legacyFailureSummary) } } / Double(rounds)
        let after = time { for _ in 0..<rounds { _ = renderPass(state) { toolRunFailureSummary($0) } } } / Double(rounds)

        // Clocks: a pill ran a half-second TimelineView whether or not it had anything to rotate.
        var clocksBefore = 0, clocksAfter = 0
        for exchange in state.exchanges {
            for group in groupActivity(exchange.activity) {
                guard case .toolRun(let entries) = group else { continue }
                for entry in entries {
                    clocksBefore += 1
                    let label = pillToolLabel(entry, turnIsLive: false)
                    if pillHeaderNeedsClock(label: label, running: false, isSearch: PillToolRunHeader.opensInPlace(entry), hasSiteDiscs: false) { clocksAfter += 1 }
                }
            }
        }

        print("BENCH [\(source)] tool calls=\(calls) failed=\(failed) tool pills with a half-second clock: before=\(clocksBefore) after=\(clocksAfter)")
        print(String(format: "BENCH one transcript pass (pure row work): before %.2f ms, after %.2f ms; per 1,000 re-renders: before %.1f s, after %.1f s",
                     before, after, before, after))

        XCTAssertEqual(clocksAfter, 0, "no finished pill keeps a clock")
        XCTAssertGreaterThan(clocksBefore, 0)
        // The failure line now also removes the model-facing wrapper and prefers the script's error line
        // (the old one showed the wrapper's preamble); it reads only the two ends of a result and must stay
        // in the same league as the walk it replaced.
        XCTAssertLessThanOrEqual(after, before * 2, "the failure line stays cheap")
    }

    // MARK: - A long history, a backlog burst, and then nothing

    /// The persisted events of the session (what a replay carries): no streamed chunks.
    private func persisted(_ events: [SessionEvent]) -> [SessionEvent] { events.filter { !$0.isTransient && !$0.isStreamedChunk } }

    /// The orb feed used to take a session's whole history event by event; now it holds it and folds it once. The
    /// same events, both ways: publishes, wall-clock, and that they end in the same state.
    func testFoldingAHeldReplayOnceBeatsFoldingItEventByEvent() {
        let (all, source) = session()
        let events = persisted(all)
        let eachModel = SessionModel(notifier: Silent())
        var eachPublishes = 0
        let eachWatch = eachModel.$state.dropFirst().sink { _ in eachPublishes += 1 }
        let each = time { for e in events { eachModel.apply(e) } }
        let onceModel = SessionModel(notifier: Silent())
        var oncePublishes = 0
        let onceWatch = onceModel.$state.dropFirst().sink { _ in oncePublishes += 1 }
        let once = time { onceModel.apply(replay: events) }
        print(String(format: "BENCH [%@] replay of %d persisted events: event by event %.1f ms, %d publishes; held and folded once %.1f ms, %d publish",
                     source, events.count, each, eachPublishes, once, oncePublishes))
        XCTAssertEqual(oncePublishes, 1)
        XCTAssertGreaterThan(eachPublishes, 100)
        XCTAssertEqual(onceModel.state.exchanges.count, eachModel.state.exchanges.count)
        XCTAssertEqual(onceModel.state.completedTurns, eachModel.state.completedTurns)
        XCTAssertLessThan(once, each, "one fold is never slower than a copy per event")
        withExtendedLifetime((eachWatch, onceWatch)) {}
    }

    /// How far behind can a long session fall when a burst piles up? The same 150 turns (750 events) applied to a
    /// 1,000-exchange session one event at a time — a copy of the transcript's array and a publish each — and as
    /// one batch (`apply(replay:)`, which is what a live batch would be). Printed for the record; asserted only as a ratio.
    func testABurstOnAThousandExchangeSessionOneAtATimeAndAsABatch() {
        func turns(_ range: ClosedRange<Int>) -> [SessionEvent] {
            range.flatMap { n -> [SessionEvent] in
                [ReplayBufferTests.event(["type": "user_message", "seq": n * 10 + 1, "ts": 1, "threadId": "main", "text": "do \(n)", "clientName": "orb"], session: sid),
                 ReplayBufferTests.event(["type": "turn_started", "seq": n * 10 + 2, "ts": 2, "threadId": "main"], session: sid),
                 ReplayBufferTests.event(["type": "tool_call", "seq": n * 10 + 3, "ts": 3, "threadId": "main", "callId": "c\(n)", "name": "bash", "argsJson": #"{"command":"ls"}"#], session: sid),
                 ReplayBufferTests.event(["type": "tool_result", "seq": n * 10 + 4, "ts": 4, "threadId": "main", "callId": "c\(n)", "output": "ok", "isError": false], session: sid),
                 ReplayBufferTests.event(["type": "turn_completed", "seq": n * 10 + 5, "ts": 5, "threadId": "main", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1], session: sid)]
            }
        }
        let history = turns(1...1_000)
        let burst = turns(1_001...1_150)
        func longModel() -> SessionModel {
            let model = SessionModel(notifier: Silent())
            model.apply(replay: history)
            return model
        }
        let oneAtATime = longModel()
        var singlePublishes = 0
        let w1 = oneAtATime.$state.dropFirst().sink { _ in singlePublishes += 1 }
        let single = time { for e in burst { oneAtATime.apply(e) } }
        let batched = longModel()
        var batchPublishes = 0
        let w2 = batched.$state.dropFirst().sink { _ in batchPublishes += 1 }
        let batch = time { batched.apply(replay: burst) }
        print(String(format: "BENCH a %d-event burst on a %d-exchange session: one at a time %.0f ms (%d publishes), as one batch %.1f ms (%d publish)",
                     burst.count, oneAtATime.state.exchanges.count - 150, single, singlePublishes, batch, batchPublishes))
        XCTAssertEqual(oneAtATime.state.exchanges.count, batched.state.exchanges.count)
        XCTAssertEqual(batchPublishes, 1)
        XCTAssertLessThan(batch, single, "a batch is never slower than a copy per event")
        withExtendedLifetime((w1, w2)) {}
    }

    /// Counts the main run loop's trips to sleep: a thread with nothing left to do makes almost none.
    private final class RunLoopTrips {
        private(set) var count = 0
        private var observer: CFRunLoopObserver?
        init() {
            observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { [unowned self] _, _ in self.count += 1 }
            CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        }
        deinit { if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) } }
    }

    private func wire(_ event: SessionEvent) -> String {
        let data = try! JSONEncoder().encode(event)
        return #"{"jsonrpc":"2.0","method":"event","params":\#(String(decoding: data, as: UTF8.self))}"#
    }

    /// A long transcript on a pinned feed, a burst of live events that piles up behind the main thread, and then
    /// silence. The backlog drains to zero, and once it has NOTHING keeps working: no publish, no event waiting, no
    /// chunk held, and the main run loop goes to sleep and stays there.
    func testALongSessionTakesABacklogBurstAndThenSettlesToZeroWork() async throws {
        // The test host is never perfectly quiet (other suites leave tickers behind), so the run loop's trips are
        // measured against this process's own baseline before anything of the feed exists.
        let baselineTrips = RunLoopTrips()
        try await Task.sleep(nanoseconds: 500_000_000)
        let baseline = baselineTrips.count
        let (all, source) = session()
        var history = persisted(all)
        // The session's last turn is over (the synthetic one is cut mid-turn), so a burst of new turns starts clean.
        history.append(ReplayBufferTests.event(["type": "turn_completed", "seq": (history.map(\.seq).max() ?? 0) + 1, "ts": 9, "threadId": "main", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1], session: sid))
        let t = AppScriptedTransport()
        let model = SessionModel(notifier: Silent())
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "bench", mode: .pinned(sessionId: sid), session: model)
        let startTask = Task { await feed.start() }
        defer { startTask.cancel(); feed.stop() }

        await waitUntil { t.sent.count >= 1 }
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntil { t.sent.count >= 2 }
        let attachId = lineJSON(t.sent[1])["id"] as! Int
        for e in history { t.feed(wire(e)) }
        let ceiling = history.map(\.seq).max() ?? 0
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachId),"result":{"ok":true,"lastSeq":\#(ceiling)}}"#)
        await waitUntil(10) { !model.isLoadingHistory && model.state.exchanges.count > 0 }
        XCTAssertFalse(model.isLoadingHistory)
        let exchangesBefore = model.state.exchanges.count

        // The burst: 150 more turns' worth of live events, all handed over at once.
        var seq = ceiling + 1
        var burst: [SessionEvent] = []
        for n in 0..<150 {
            burst.append(ReplayBufferTests.event(["type": "user_message", "seq": seq, "ts": 1, "threadId": "main", "text": "burst \(n)", "clientName": "orb"], session: sid)); seq += 1
            burst.append(ReplayBufferTests.event(["type": "turn_started", "seq": seq, "ts": 2, "threadId": "main"], session: sid)); seq += 1
            burst.append(ReplayBufferTests.event(["type": "tool_call", "seq": seq, "ts": 3, "threadId": "main", "callId": "burst_\(n)", "name": "bash", "argsJson": #"{"command":"ls"}"#], session: sid)); seq += 1
            for k in 0..<10 {
                burst.append(.assistantDelta(.init(seq: seq, sessionId: sid, ts: 3, threadId: "main", delta: "chunk \(k) "))); 
            }
            burst.append(ReplayBufferTests.event(["type": "tool_result", "seq": seq, "ts": 4, "threadId": "main", "callId": "burst_\(n)", "output": "ok", "isError": false], session: sid)); seq += 1
            burst.append(ReplayBufferTests.event(["type": "turn_completed", "seq": seq, "ts": 5, "threadId": "main", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1], session: sid)); seq += 1
        }
        var publishes = 0
        let watch = model.$state.dropFirst().sink { _ in publishes += 1 }
        let started = DispatchTime.now().uptimeNanoseconds
        for e in burst { t.feed(wire(e)) }
        await waitUntil(20) { model.state.exchanges.count >= exchangesBefore + 150 && !model.state.turnRunning }
        let drainedMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        XCTAssertEqual(model.state.exchanges.count, exchangesBefore + 150, "the whole burst was folded")
        print(String(format: "BENCH [%@] a %d-event live burst on a %d-exchange session: drained in %.0f ms with %d publishes",
                     source, burst.count, exchangesBefore, drainedMs, publishes))

        // …and then nothing at all.
        await waitUntil(5) { feed.diagnostics.backlog == 0 }
        XCTAssertEqual(feed.diagnostics.backlog, 0, "no event on the stream, no chunk held")
        try await Task.sleep(nanoseconds: 300_000_000) // let the last timers go
        let settled = publishes
        let trips = RunLoopTrips()
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(publishes, settled, "once idle, nothing publishes")
        XCTAssertEqual(feed.diagnostics.backlog, 0)
        XCTAssertLessThanOrEqual(trips.count, baseline + max(baseline / 2, 8),
                                 "and the feed adds no ticking to the main run loop: \(trips.count) trips in half a second against a baseline of \(baseline)")
        withExtendedLifetime(watch) {}
    }
}

private final class Silent: NotificationPosting {
    func post(title: String, body: String) {}
}
