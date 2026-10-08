import XCTest
import Combine
import WinterProtocol
@testable import Winter

/// A dispatch child's window kept showing "working" (its plume, a live stop circle) after the user had
/// stopped it, although the session log showed the turn had ended. Two things were behind it:
///
/// 1. the window folded every `thinking_delta` ONE AT A TIME — one publish, one re-render of a
///    120-pill transcript per delta — so on a 60-call reasoning session it ran minutes behind the stream
///    and showed state from before the stop; and
/// 2. nothing on screen said the stop had landed, so the stale picture looked like a stop that failed.
///
/// This file replays the log's real tail through the fold, pins the stop button's state, and measures the
/// cost of the old and new paths on a session shaped like that log.
@MainActor
final class StopAndLagTests: XCTestCase {
    // MARK: - Events

    private func event(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> SessionEvent {
        do {
            return try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        } catch {
            XCTFail("undecodable SessionEvent fixture: \(error)\n\(json)", file: file, line: line)
            return .turnStarted(.init(seq: 0, sessionId: "s", ts: 0, threadId: "main"))
        }
    }

    private let sid = "s_14f93f20ccfd"

    private func json(_ fields: [String: Any]) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: fields.merging(["sessionId": sid]) { a, _ in a }), encoding: .utf8)!
    }

    private func main(_ type: String, seq: Int, ts: Int, _ extra: [String: Any] = [:]) -> SessionEvent {
        event(json(["type": type, "seq": seq, "ts": ts, "threadId": "main"].merging(extra) { a, _ in a }))
    }

    private func harness(_ type: String, seq: Int, ts: Int) -> SessionEvent {
        event(json(["type": type, "seq": seq, "ts": ts, "clientName": "orb"]))
    }

    /// The log `s_14f93f20ccfd`, shape-for-shape (seq and ts are the real ones; text is shortened):
    /// one long turn, 60 ComputerV2 calls, the user's Stop → an aborted terminal, Dispatch re-sending the
    /// task through SendMessage, a turn that started and was aborted 97 ms later, and the orb's brief attach.
    private func realLogEvents(calls: Int = 8) -> [SessionEvent] {
        var events: [SessionEvent] = []
        events.append(main("user_message", seq: 3, ts: 1_791_456_000_000, ["text": "Check the editor toggle.", "clientName": "dispatch"]))
        events.append(main("turn_started", seq: 4, ts: 1_791_456_000_001))
        events.append(harness("harness_attached", seq: 5, ts: 1_791_456_000_002))
        var seq = 6
        for i in 0..<calls {
            events.append(main("thinking_block", seq: seq, ts: 1_791_456_100_000 + i, ["blockId": "b\(i)", "kind": "summary", "text": "Reasoning \(i)."])); seq += 1
            events.append(main("tool_call", seq: seq, ts: 1_791_456_100_000 + i, ["callId": "call_\(i)", "name": "computer_v2",
                                                                                "argsJson": #"{"code":"const code = await apps.open(\"Code\"); await code.click(12);"}"#])); seq += 1
            events.append(main("tool_result", seq: seq, ts: 1_791_456_100_000 + i, ["callId": "call_\(i)", "output": "state text", "isError": i == calls - 1])); seq += 1
        }
        // The real tail: 188 …195.
        events.append(main("thinking_block", seq: 188, ts: 1_791_456_184_225, ["blockId": "b_last", "kind": "summary", "text": "S"]))
        events.append(main("turn_completed", seq: 189, ts: 1_791_456_184_229, ["stopReason": "aborted", "inputTokens": 4_574_834, "outputTokens": 49_152]))
        events.append(harness("harness_detached", seq: 190, ts: 1_791_456_184_423))
        events.append(main("user_message", seq: 191, ts: 1_791_456_191_969,
                           ["text": "Your turn stopped before completing anything. Please continue the original task now.", "clientName": "messaging"]))
        events.append(main("turn_started", seq: 192, ts: 1_791_456_191_970))
        events.append(main("turn_completed", seq: 193, ts: 1_791_456_192_067, ["stopReason": "aborted", "inputTokens": 0, "outputTokens": 0]))
        events.append(harness("harness_attached", seq: 194, ts: 1_791_456_192_341))
        events.append(harness("harness_detached", seq: 195, ts: 1_791_456_192_342))
        return events
    }

    // MARK: - The tail, replayed

    private func assertIdle(_ s: OrbSessionState, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(s.turnRunning, "the turn ended — the window must not read as working", file: file, line: line)
        XCTAssertEqual(s.status, .idle, file: file, line: line)
        XCTAssertTrue(s.lastTurnAborted, file: file, line: line)
        XCTAssertEqual(s.completedTurns, 2, "the stopped turn and the re-sent one that was aborted at once", file: file, line: line)
        XCTAssertTrue(s.reviewingCallIds.isEmpty, file: file, line: line)
        XCTAssertNil(s.runningTurnExchange, file: file, line: line)
        XCTAssertTrue(s.queuedSteers.isEmpty, file: file, line: line)
    }

    func testTheRealTailEndsIdleEventByEvent() {
        var s = OrbSessionState()
        var running: [Int: Bool] = [:]
        for e in realLogEvents() {
            s = SessionReducer.reduce(s, e)
            running[e.seq] = s.turnRunning
        }
        XCTAssertEqual(running[188], true)
        XCTAssertEqual(running[189], false, "the aborted terminal ends the long turn")
        XCTAssertEqual(running[191], false, "a message alone starts nothing")
        XCTAssertEqual(running[192], true, "…the turn it starts runs")
        XCTAssertEqual(running[193], false, "…and its aborted terminal 97 ms later ends it")
        assertIdle(s)
        XCTAssertEqual(s.exchanges.count, 2, "the re-sent task opened its own exchange")
    }

    func testTheRealTailEndsIdleWhenReplayedAsAttach() {
        let model = SessionModel(notifier: SilentNotifier())
        model.apply(replay: realLogEvents())
        assertIdle(model.state)
        XCTAssertFalse(FieldStateAdapter(session: model).turnRunning, "so the plume (turnRunning && empty draft) is gone")
    }

    func testTheRealTailEndsIdleWhenFoldedAsOneBatchOrLive() {
        let batched = SessionModel(notifier: SilentNotifier())
        batched.apply(contentsOf: realLogEvents())
        assertIdle(batched.state)

        let live = SessionModel(notifier: SilentNotifier())
        for e in realLogEvents() { live.apply(e) }
        assertIdle(live.state)
        XCTAssertEqual(live.state.exchanges, batched.state.exchanges)
    }

    /// A window that LOST the first terminal (it was behind, or a frame dropped) takes the restart as a
    /// continuation of the turn it thinks is open — and the second aborted terminal still ends it.
    func testALostFirstTerminalIsStillEndedByTheSecond() {
        var s = OrbSessionState()
        for e in realLogEvents() where e.seq != 189 { s = SessionReducer.reduce(s, e) }
        XCTAssertFalse(s.turnRunning)
        XCTAssertEqual(s.completedTurns, 1)
        XCTAssertEqual(s.status, .idle)
    }

    /// A terminal AND a restart landing in one fold: the stop is over, the new turn runs.
    func testAStopThatEndsInTheSameFoldAsARestartIsNotStillStopping() {
        let model = SessionModel(notifier: SilentNotifier())
        model.apply(replay: Array(realLogEvents().prefix { $0.seq < 189 }))
        let adapter = FieldStateAdapter(session: model)
        XCTAssertTrue(model.state.turnRunning)
        adapter.beginStop()
        XCTAssertTrue(adapter.isStopping)

        let terminalAndRestart = realLogEvents().filter { (189...192).contains($0.seq) }
        model.apply(contentsOf: terminalAndRestart)
        XCTAssertTrue(model.state.turnRunning, "the re-sent turn is running")
        XCTAssertFalse(adapter.isStopping, "…but it is not the turn that was stopped")
    }

    // MARK: - The stop button

    func testAStopIsPendingUntilTheTurnEnds() {
        let model = SessionModel(notifier: SilentNotifier())
        let adapter = FieldStateAdapter(session: model)

        adapter.beginStop()
        XCTAssertFalse(adapter.isStopping, "nothing is running: there is nothing to stop and nothing to wait for")

        model.apply(contentsOf: [main("user_message", seq: 1, ts: 1, ["text": "go", "clientName": "cli"]), main("turn_started", seq: 2, ts: 2)])
        XCTAssertFalse(adapter.isStopping, "running, not stopping")
        adapter.beginStop()
        XCTAssertTrue(adapter.isStopping)

        model.apply(main("tool_call", seq: 3, ts: 3, ["callId": "c", "name": "bash", "argsJson": "{}"]))
        XCTAssertTrue(adapter.isStopping, "still stopping while the turn works on")

        model.apply(main("turn_completed", seq: 4, ts: 4, ["stopReason": "aborted", "inputTokens": 1, "outputTokens": 1]))
        XCTAssertFalse(adapter.isStopping, "the terminal ends it")
        XCTAssertFalse(adapter.turnRunning)
    }

    func testAnErrorEndsAPendingStopToo() {
        let model = SessionModel(notifier: SilentNotifier())
        model.apply(contentsOf: [main("user_message", seq: 1, ts: 1, ["text": "go", "clientName": "cli"]), main("turn_started", seq: 2, ts: 2)])
        let adapter = FieldStateAdapter(session: model)
        adapter.beginStop()
        model.apply(main("agent_error", seq: 3, ts: 3, ["message": "boom"]))
        XCTAssertFalse(adapter.isStopping)
    }

    func testTheButtonStateTable() {
        XCTAssertEqual(pillStopPhase(isRunning: false, isStopping: false), .idle)
        XCTAssertEqual(pillStopPhase(isRunning: false, isStopping: true), .idle, "a stale flag means nothing without a running turn")
        XCTAssertEqual(pillStopPhase(isRunning: true, isStopping: false), .running)
        XCTAssertEqual(pillStopPhase(isRunning: true, isStopping: true), .stopping)
        XCTAssertEqual(pillStoppingLabel, "Stopping…")
    }

    /// A stop nothing confirmed in time clears itself and asks the surface to re-read the session.
    func testAStalledStopClearsAndAsksForAResync() {
        let model = SessionModel(notifier: SilentNotifier())
        model.apply(contentsOf: [main("user_message", seq: 1, ts: 1, ["text": "go", "clientName": "cli"]), main("turn_started", seq: 2, ts: 2)])
        let adapter = FieldStateAdapter(session: model)
        adapter.stopStallTimeout = 0.05
        let stalled = expectation(description: "resync requested")
        adapter.onStopStalled = { stalled.fulfill() }
        adapter.beginStop()
        XCTAssertTrue(adapter.isStopping)
        wait(for: [stalled], timeout: 2)
        XCTAssertFalse(adapter.isStopping)
        XCTAssertNil(adapter.stopRequestedAfterTurns)
    }

    func testAStopThatIsConfirmedNeverResyncs() {
        let model = SessionModel(notifier: SilentNotifier())
        model.apply(contentsOf: [main("user_message", seq: 1, ts: 1, ["text": "go", "clientName": "cli"]), main("turn_started", seq: 2, ts: 2)])
        let adapter = FieldStateAdapter(session: model)
        adapter.stopStallTimeout = 0.05
        var resyncs = 0
        adapter.onStopStalled = { resyncs += 1 }
        adapter.beginStop()
        model.apply(main("turn_completed", seq: 3, ts: 3, ["stopReason": "aborted", "inputTokens": 1, "outputTokens": 1]))
        let settle = expectation(description: "watchdog window passes")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { settle.fulfill() }
        wait(for: [settle], timeout: 2)
        XCTAssertEqual(resyncs, 0)
    }

    func testEndStopClearsWithoutAResync() {
        let model = SessionModel(notifier: SilentNotifier())
        model.apply(contentsOf: [main("user_message", seq: 1, ts: 1, ["text": "go", "clientName": "cli"]), main("turn_started", seq: 2, ts: 2)])
        let adapter = FieldStateAdapter(session: model)
        var resyncs = 0
        adapter.onStopStalled = { resyncs += 1 }
        adapter.beginStop()
        adapter.endStop()
        XCTAssertFalse(adapter.isStopping)
        XCTAssertEqual(resyncs, 0)
    }

    // MARK: - Streamed chunks

    private func delta(_ i: Int, block: String = "rb_1", seq: Int = 5) -> SessionEvent {
        .thinkingDelta(.init(seq: seq, sessionId: sid, ts: i, threadId: "main", blockId: block, kind: "summary", phase: "delta", text: "w\(i) "))
    }

    /// Thinking deltas are batched like reply chunks — and a different event folds the waiting ones first,
    /// so the session sees everything in order.
    func testThinkingDeltasAreFoldedInBatchesInOrder() {
        var folds: [[Int]] = []
        let queue = StreamedChunkQueue { events in folds.append(events.map(\.seq)) }
        for i in 0..<500 { queue.append(delta(i, seq: i)) }
        XCTAssertTrue(folds.isEmpty, "nothing is folded per delta")
        XCTAssertEqual(queue.count, 500)

        queue.flush()
        XCTAssertEqual(folds.count, 1)
        XCTAssertEqual(folds[0], Array(0..<500), "in arrival order")
        queue.flush()
        XCTAssertEqual(folds.count, 1, "an empty flush folds nothing")
    }

    func testTheQueueFoldsOnItsOwnWithinTheIntervalAndAReplyChunkIsNotKeptWaiting() {
        let queue: StreamedChunkQueue
        let folded = expectation(description: "folded")
        var count = 0
        var batches = 0
        queue = StreamedChunkQueue { events in count += events.count; batches += 1; if count >= 41 { folded.fulfill() } }
        for i in 0..<40 { queue.append(delta(i)) }
        // A reply chunk wants the shorter frame interval; it must not wait on the reasoning interval.
        queue.append(.assistantDelta(.init(seq: 9, sessionId: sid, ts: 0, threadId: "main", delta: "hi")))
        wait(for: [folded], timeout: 2)
        XCTAssertEqual(count, 41)
        XCTAssertLessThanOrEqual(batches, 2)
        XCTAssertEqual(StreamedChunkQueue.interval(for: delta(0)), StreamedChunkQueue.thinkingInterval)
        XCTAssertEqual(StreamedChunkQueue.interval(for: .assistantDelta(.init(seq: 1, sessionId: sid, ts: 0, threadId: "main", delta: "x"))),
                       StreamedChunkQueue.assistantInterval)
        XCTAssertTrue(delta(0).isStreamedChunk)
        XCTAssertFalse(main("turn_started", seq: 1, ts: 1).isStreamedChunk)
    }

    func testBatchedAndOneAtATimeFoldsEndInTheSameState() {
        var events: [SessionEvent] = [main("user_message", seq: 1, ts: 1, ["text": "go", "clientName": "cli"]), main("turn_started", seq: 2, ts: 2)]
        for i in 0..<300 { events.append(delta(i)) }
        events.append(main("thinking_block", seq: 6, ts: 9, ["blockId": "rb_1", "kind": "summary", "text": "done"]))
        let one = SessionModel(notifier: SilentNotifier())
        for e in events { one.apply(e) }
        let batch = SessionModel(notifier: SilentNotifier())
        batch.apply(contentsOf: Array(events[0..<2]))
        batch.apply(contentsOf: Array(events[2..<150]))
        batch.apply(contentsOf: Array(events[150...]))
        let verb = one.state.workingVerb // one random roll per turn start, outside the pure fold
        batch.applyForTesting { $0.workingVerb = verb }
        XCTAssertEqual(one.state, batch.state)
        XCTAssertEqual(one.liveThinking.countForTesting, batch.liveThinking.countForTesting)
    }

    // MARK: - The cheaper pieces

    func testAFinishedPillNeedsNoClockAndARotatingOrSearchingOneDoes() {
        let plain = PillToolLabel(lead: "Notes · click")
        XCTAssertFalse(pillHeaderNeedsClock(label: plain, running: false, isSearch: false, hasSiteDiscs: false))
        XCTAssertFalse(pillHeaderNeedsClock(label: plain, running: true, isSearch: false, hasSiteDiscs: false), "running alone rotates nothing")
        let rotating = PillToolLabel(lead: "", rotation: [PillRotatingName(text: "a", disc: nil), PillRotatingName(text: "b", disc: nil)])
        XCTAssertTrue(pillHeaderNeedsClock(label: rotating, running: true, isSearch: false, hasSiteDiscs: false))
        XCTAssertTrue(pillHeaderNeedsClock(label: plain, running: true, isSearch: true, hasSiteDiscs: true), "a running search cycles its sites")
        XCTAssertFalse(pillHeaderNeedsClock(label: plain, running: false, isSearch: true, hasSiteDiscs: true), "a finished one does not")
    }

    func testTheFailureSummaryReadsOnlyTheHeadOfALongResult() {
        let big = "Error: ref 14 is gone\n" + String(repeating: "line of state text that nobody needs here\n", count: 3_000)
        let entries = [ToolRunEntry(name: "computer_v2", calls: [ToolCallRecord(callId: "c", detail: nil, output: big, isError: true)])]
        XCTAssertEqual(toolRunFailureSummary(entries), "Error: ref 14 is gone")
    }

    func testTheInPlaceFoldIsTheSameFoldAsTheCopyingOne() {
        var inPlace = OrbSessionState()
        var copying = OrbSessionState()
        for e in realLogEvents() {
            SessionReducer.reduceInPlace(&inPlace, e)
            copying = SessionReducer.reduce(copying, e)
        }
        XCTAssertEqual(inPlace, copying)
    }
}

/// A notifier that posts nothing — these tests fold `notification_requested`-free logs, but the model
/// wants one.
private final class SilentNotifier: NotificationPosting {
    func post(title: String, body: String) {}
}
