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
        XCTAssertLessThanOrEqual(after, before * 1.2, "the cheaper failure line never costs more")
    }
}

private final class Silent: NotificationPosting {
    func post(title: String, body: String) {}
}
