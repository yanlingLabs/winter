import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Drives the PURE reducer directly (same pattern as SessionModelTests). Helper builders
/// mirror that file's event construction — wire-shaped JSON decoded through the real
/// `SessionEvent` decoder, so tests stay honest to the protocol.
final class ActivityCaptureTests: XCTestCase {
    // MARK: Event factory helpers (mirrors SessionModelTests idioms; extended locally for the
    // thread/worktree/question events this file needs — never in production code)

    func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    func userMessage(_ text: String, seq: Int = 1, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"user_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","text":"\#(text)","clientName":"cli"}"#)
    }
    func turnStarted(seq: Int = 2, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)"}"#)
    }
    func turnCompleted(seq: Int = 9, stopReason: String = "end_turn") -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","stopReason":"\#(stopReason)","inputTokens":1,"outputTokens":1}"#)
    }
    func toolCall(_ name: String, seq: Int = 3, thread: String = "main", argsJson: String = "{}") -> SessionEvent {
        // argsJson is embedded as a JSON STRING VALUE (the wire protocol carries the tool's args
        // as a serialized string, not nested JSON) — escape backslashes FIRST, then quotes, so a
        // caller-supplied JSON escape (e.g. "\n" inside a bash command) round-trips through this
        // double-encoding intact rather than being consumed by the outer parse alone.
        let escaped = argsJson
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return ev(#"{"type":"tool_call","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"c\#(seq)","name":"\#(name)","argsJson":"\#(escaped)"}"#)
    }
    func taskUpdated(id: String, subject: String, status: String, seq: Int = 6, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"task_updated","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","task":{"id":"\#(id)","subject":"\#(subject)","status":"\#(status)"}}"#)
    }
    func threadStarted(agentType: String, seq: Int = 4, thread: String = "th_1") -> SessionEvent {
        ev(#"{"type":"thread_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","parentThreadId":"main","agentType":"\#(agentType)","prompt":"go"}"#)
    }
    func threadCompleted(seq: Int = 5, thread: String = "th_1") -> SessionEvent {
        ev(#"{"type":"thread_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","stopReason":"end_turn"}"#)
    }
    func worktreeEntered(branch: String, seq: Int = 6, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"worktree_entered","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","name":"wt","path":"/tmp/wt","branch":"\#(branch)"}"#)
    }
    func worktreeExited(name: String, seq: Int = 7, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"worktree_exited","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","name":"\#(name)","action":"merged","removed":true}"#)
    }
    func approvalRequested(summary: String, callId: String = "a1", seq: Int = 8) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","toolName":"bash","summary":"\#(summary)"}"#)
    }
    func questionAsked(_ question: String, callId: String = "q1", seq: Int = 9) -> SessionEvent {
        ev(#"{"type":"question_asked","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","questions":[{"question":"\#(question)","header":"h","options":[],"multiSelect":false}]}"#)
    }
    func planPresented(callId: String = "p1", seq: Int = 10) -> SessionEvent {
        ev(#"{"type":"plan_presented","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","plan":"the plan"}"#)
    }

    /// Build a state with one open exchange (userMessage + turnStarted), main thread.
    private func openTurnState() -> OrbSessionState {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        return s
    }

    private func lastActivity(_ s: OrbSessionState) -> [ActivityItem] {
        s.exchanges.last?.activity ?? []
    }

    // MARK: Tool capture

    func testToolCallAppendsActivity() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3"))])
        // Existing side effect preserved: .toolCall(main) still drives status.
        XCTAssertEqual(s.status, .toolRunning(name: "bash"))
    }

    // LIVE-GATE G3: adjacent-dupe collapse is REMOVED for `.tool` — each call is its own item now
    // (the VIEW's `groupActivity` merges consecutive same-name runs for display; the reducer must
    // not lose the per-call count/detail by collapsing them here).
    func testConsecutiveDuplicateToolsNoLongerCollapse() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolCall("bash", seq: 4))
        s = SessionReducer.reduce(s, toolCall("read", seq: 5))
        XCTAssertEqual(lastActivity(s), [
            ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3")),
            ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c4")),
            ActivityItem(kind: .tool(name: "read", detail: nil, callId: "c5")),
        ])
    }

    // MARK: Detail extraction (LIVE-GATE G3)

    func testBashDetailExtractsFirstLineOfCommand() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3, argsJson: #"{"command":"ls -la\ngrep foo"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "bash", detail: "ls -la", callId: "c3"))])
    }

    func testBashDetailClipsLongCommandTo100Chars() {
        var s = openTurnState()
        let longCommand = String(repeating: "x", count: 150)
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3, argsJson: #"{"command":"\#(longCommand)"}"#))
        XCTAssertEqual(lastActivity(s).first?.kind, .tool(name: "bash", detail: String(longCommand.prefix(100)), callId: "c3"))
    }

    func testTaskCreateDetailExtractsSubject() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("task_create", seq: 3, argsJson: #"{"subject":"Write tests"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "task_create", detail: "Write tests", callId: "c3"))])
    }

    func testTaskUpdateDetailExtractsSubject() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("task_update", seq: 3, argsJson: #"{"id":"1","subject":"Write tests","status":"completed"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "task_update", detail: "Write tests", callId: "c3"))])
    }

    func testReadDetailExtractsFilePath() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("read", seq: 3, argsJson: #"{"file_path":"/tmp/x.swift"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "read", detail: "/tmp/x.swift", callId: "c3"))])
    }

    func testGrepDetailExtractsPattern() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("grep", seq: 3, argsJson: #"{"pattern":"TODO"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "grep", detail: "TODO", callId: "c3"))])
    }

    func testMalformedArgsJsonYieldsNilDetail() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3, argsJson: "not json at all"))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3"))])
    }

    func testUnrecognizedFieldsYieldNilDetail() {
        var s = openTurnState()
        // Well-formed JSON, but no field this tool cares about.
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3, argsJson: #"{"unrelated":"x"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3"))])
    }

    func testUnknownToolNameYieldsNilDetail() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("mcp__foo__bar", seq: 3, argsJson: #"{"command":"ls"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "mcp__foo__bar", detail: nil, callId: "c3"))])
    }

    // MARK: Task transitions

    func testTaskTransitionAppendsOnlyOnStatusChange() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", seq: 3))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .task(subject: "Do X", status: "in_progress"))])

        // Same id + same status again → the upsert changed nothing → NO new item.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", seq: 4))
        XCTAssertEqual(lastActivity(s).count, 1)

        // Status actually transitions → append.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "completed", seq: 5))
        XCTAssertEqual(lastActivity(s), [
            ActivityItem(kind: .task(subject: "Do X", status: "in_progress")),
            ActivityItem(kind: .task(subject: "Do X", status: "completed")),
        ])
        // Existing side effect preserved: the upsert still landed in tasks. Task 2 (2e-i):
        // startedTs was stamped (event.ts, always 0 in this file's helper) the moment the task
        // entered in_progress above, then PRESERVED across the completed transition — non-
        // in_progress transitions leave startedTs as-is, they don't clear it.
        XCTAssertEqual(s.tasks, [TaskItem(id: "1", subject: "Do X", status: "completed", startedTs: 0)])
    }

    // MARK: Subagents, worktree, interactions

    func testSubagentAndWorktreeAndInteractionCapture() {
        var s = openTurnState()
        // thread_started/completed arrive with CHILD threadIds by nature — captured anyway
        // (guarded on turnRunning, not threadId).
        s = SessionReducer.reduce(s, threadStarted(agentType: "general", seq: 3))
        s = SessionReducer.reduce(s, threadCompleted(seq: 4))
        s = SessionReducer.reduce(s, worktreeEntered(branch: "fix-x", seq: 5))
        s = SessionReducer.reduce(s, worktreeExited(name: "wt", seq: 6))
        s = SessionReducer.reduce(s, approvalRequested(summary: "rm -rf x", callId: "a1", seq: 7))
        s = SessionReducer.reduce(s, questionAsked("Which port?", callId: "q1", seq: 8))
        s = SessionReducer.reduce(s, planPresented(callId: "p1", seq: 9))
        // mac-chat-parity Task 3: the three interaction items now carry the whole ask, not a bare
        // summary string — the transcript draws the card itself from these. The summaries this test
        // used to assert on are still what `InteractionRecord.summary` derives (pinned in
        // `InteractionRecordTests.testSummaryIsDerivedFromTheAsk`).
        XCTAssertEqual(lastActivity(s).count, 7)
        XCTAssertEqual(Array(lastActivity(s).prefix(4)), [
            ActivityItem(kind: .subagent(agentType: "general")),
            ActivityItem(kind: .subagentDone),
            ActivityItem(kind: .worktree(entered: true, detail: "fix-x")),
            ActivityItem(kind: .worktree(entered: false, detail: "wt")),
        ])
        XCTAssertEqual(lastActivity(s).compactMap(\.interactionRecord).map(\.summary),
                       ["rm -rf x", "Which port?", "plan presented"])
        // Existing side effects preserved: approval/question/plan still manage pendingInteractions.
        XCTAssertEqual(s.pendingInteractions.map(\.callId), ["a1", "q1", "p1"])
        XCTAssertEqual(s.status, .approvalNeeded(count: 3))
    }

    func testSubagentEventsOutsideRunningTurnIgnored() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi", seq: 1))
        // No turn_started → turnRunning false → thread events must not append.
        s = SessionReducer.reduce(s, threadStarted(agentType: "general", seq: 2))
        s = SessionReducer.reduce(s, threadCompleted(seq: 3))
        XCTAssertEqual(lastActivity(s), [])
    }

    // MARK: Aborted flag

    func testAbortedTurnFlagsExchange() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, turnCompleted(seq: 3, stopReason: "aborted"))
        XCTAssertTrue(s.exchanges.last!.aborted)

        var t = openTurnState()
        t = SessionReducer.reduce(t, turnCompleted(seq: 3, stopReason: "end_turn"))
        XCTAssertFalse(t.exchanges.last!.aborted)
    }

    // MARK: Cap (drop-oldest at 200)

    func testActivityCapAt200DropsOldest() {
        var s = openTurnState()
        for i in 1...205 {
            s = SessionReducer.reduce(s, toolCall("t\(i)", seq: i + 2))
        }
        XCTAssertEqual(lastActivity(s).count, 200)
        XCTAssertEqual(lastActivity(s).first, ActivityItem(kind: .tool(name: "t6", detail: nil, callId: "c8")))
        XCTAssertEqual(lastActivity(s).last, ActivityItem(kind: .tool(name: "t205", detail: nil, callId: "c207")))
    }

    // MARK: Main-thread-only + defensive guards

    func testChildThreadEventsIgnored() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("read", seq: 3, thread: "th_child"))
        XCTAssertEqual(lastActivity(s), [])

        // A child-thread taskUpdated still upserts (tasks are session-wide) but adds no activity.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "in_progress", seq: 4, thread: "th_child"))
        XCTAssertEqual(s.tasks.count, 1)
        XCTAssertEqual(lastActivity(s), [])

        // Child-thread worktree events don't append either.
        s = SessionReducer.reduce(s, worktreeEntered(branch: "b", seq: 5, thread: "th_child"))
        XCTAssertEqual(lastActivity(s), [])
    }

    func testNoOpenExchangeIsDefensiveNoop() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 1))
        XCTAssertTrue(s.exchanges.isEmpty) // no crash, nothing appended anywhere

        // turn_completed(aborted) with no exchanges must not crash either.
        s = SessionReducer.reduce(s, turnCompleted(seq: 2, stopReason: "aborted"))
        XCTAssertTrue(s.exchanges.isEmpty)
    }

    // MARK: Steer keeps one exchange

    func testSteerKeepsAccumulatingOnSameExchange() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, userMessage("also do Y", seq: 4)) // mid-turn steer
        s = SessionReducer.reduce(s, toolCall("read", seq: 5))
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.exchanges[0].activity, [
            ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3")),
            ActivityItem(kind: .tool(name: "read", detail: nil, callId: "c5")),
        ])
        // The steer fold itself is untouched (existing behavior byte-preserved).
        XCTAssertEqual(s.exchanges[0].prompt, "hi\n↳ also do Y")
    }

    // MARK: Purity / replay

    func testReplayRebuildsActivity() {
        let events: [SessionEvent] = [
            userMessage("go", seq: 1),
            turnStarted(seq: 2),
            toolCall("bash", seq: 3),
            taskUpdated(id: "1", subject: "Do X", status: "in_progress", seq: 4),
            threadStarted(agentType: "general", seq: 5),
            threadCompleted(seq: 6),
            worktreeEntered(branch: "fix-x", seq: 7),
            approvalRequested(summary: "rm x", callId: "a1", seq: 8),
            turnCompleted(seq: 9, stopReason: "aborted"),
        ]
        let a = events.reduce(OrbSessionState()) { SessionReducer.reduce($0, $1) }
        let b = events.reduce(OrbSessionState()) { SessionReducer.reduce($0, $1) }
        XCTAssertEqual(a.exchanges, b.exchanges) // pure/deterministic
        XCTAssertEqual(a.exchanges.count, 1)
        XCTAssertFalse(a.exchanges[0].activity.isEmpty) // the comparison covered real capture
        XCTAssertTrue(a.exchanges[0].aborted)
    }

    // MARK: tool_result fold (mac-chat-parity Task 1)
    //
    // Before this, `tool_result` folded to a status flip and NOTHING else — `output` and `isError`
    // were discarded in the reducer, so no view could ever show what a tool did or that it failed.

    /// `output` is embedded as a JSON STRING VALUE, so backslashes/quotes/newlines have to be
    /// escaped in that order (backslash first, or the escapes we add would be re-escaped).
    func toolResult(callId: String, output: String = "ok", isError: Bool = false, seq: Int = 4, thread: String = "main") -> SessionEvent {
        let escaped = output
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return ev(#"{"type":"tool_result","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"\#(callId)","output":"\#(escaped)","isError":\#(isError)}"#)
    }

    private func resultFields(_ item: ActivityItem?) -> (output: String?, isError: Bool)? {
        guard let kind = item?.kind, case .tool(_, _, _, let output, let isError) = kind else { return nil }
        return (output, isError)
    }

    func testToolResultCarriesOutputAndIsErrorOntoTheFoldedItem() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        // Before the result lands, "still running" is a nil output — not an empty string.
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, nil)
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "ENOENT: no such file", isError: true, seq: 4))
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, "ENOENT: no such file")
        XCTAssertEqual(resultFields(lastActivity(s).first)?.isError, true)
        // The name/detail the item was opened with survive the fold untouched.
        XCTAssertEqual(lastActivity(s).first?.kind, .tool(name: "bash", detail: nil, callId: "c3", output: "ENOENT: no such file", isError: true))
    }

    /// The existing side effect the fold must NOT disturb: a main-thread `tool_result` with no
    /// pending interaction still returns the orb to `.thinking`.
    func testToolResultStillFlipsStatusBackToThinking() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        XCTAssertEqual(s.status, .toolRunning(name: "bash"))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", seq: 4))
        XCTAssertEqual(s.status, .thinking)
    }

    /// The join is by `callId`, not by position: results are matched to the call that opened them
    /// even when they arrive in a different order than the calls did.
    func testToolResultJoinsByCallIdNotByPosition() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("read", seq: 3))
        s = SessionReducer.reduce(s, toolCall("bash", seq: 4))
        s = SessionReducer.reduce(s, toolResult(callId: "c4", output: "from bash", seq: 5))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "from read", seq: 6))
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, "from read")
        XCTAssertEqual(resultFields(lastActivity(s).last)?.output, "from bash")
    }

    /// A main-thread steer's `user_message` is persisted at SEND time (`AgentEngine.steer`,
    /// packages/core/src/agent/engine.ts), so it can land BETWEEN a tool_call and its tool_result —
    /// and once the exchange already holds a reply, the reducer's `userMessage` branch opens a NEW
    /// exchange for it. The result then belongs to an item one exchange back. This is the only test
    /// that discriminates the reverse scan from "look in the last exchange only".
    func testToolResultFoldsIntoAnEarlierExchangeWhenASteerOpenedANewOne() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, ev(#"{"type":"assistant_message","seq":3,"sessionId":"s","ts":0,"threadId":"main","text":"round one"}"#))
        s = SessionReducer.reduce(s, toolCall("bash", seq: 4))
        // Steer with a non-empty reply on the open exchange → the reducer opens exchange #2.
        s = SessionReducer.reduce(s, userMessage("also do Y", seq: 5))
        XCTAssertEqual(s.exchanges.count, 2, "precondition: the steer must have opened a second exchange")
        s = SessionReducer.reduce(s, toolResult(callId: "c4", output: "landed", seq: 6))
        XCTAssertEqual(resultFields(s.exchanges[0].activity.first)?.output, "landed")
    }

    func testToolResultForAnUnknownCallIdIsANoop() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        let before = s
        s = SessionReducer.reduce(s, toolResult(callId: "nope", output: "orphan", seq: 4))
        XCTAssertEqual(s.exchanges, before.exchanges) // nothing folded anywhere, no crash
    }

    /// A `tool_result` with no exchange at all (its `tool_call` was dropped by `appendActivity`'s
    /// no-open-exchange guard) must not crash the reducer either.
    func testToolResultWithNoExchangesIsANoop() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, toolResult(callId: "c3", seq: 1))
        XCTAssertTrue(s.exchanges.isEmpty)
    }

    /// Child-thread tool events never reach the main transcript — the fold inherits the existing
    /// `threadId == mainThread` guard on the case itself.
    func testChildThreadToolResultDoesNotFold() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "child output", seq: 4, thread: "th_child"))
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, nil)
    }

    // MARK: Output retention cap

    func testToolOutputIsTruncatedAtTheRetentionCap() {
        let cap = SessionReducer.maxToolOutputCharacters
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: String(repeating: "x", count: cap + 1), seq: 4))
        XCTAssertEqual(
            resultFields(lastActivity(s).first)?.output,
            String(repeating: "x", count: cap) + "\n[… truncated at \(cap) characters]"
        )
    }

    /// Exactly at the cap is NOT truncated — no marker on an output that fits.
    func testToolOutputExactlyAtTheCapIsKeptWhole() {
        let cap = SessionReducer.maxToolOutputCharacters
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: String(repeating: "x", count: cap), seq: 4))
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, String(repeating: "x", count: cap))
    }

    /// The bound itself, pinned: it must EQUAL the daemon's own `MAX_OUTPUT`
    /// (64 KiB, packages/core/src/agent/tools/registry.ts). Anything lower would discard output the
    /// daemon deliberately sent — 8-64 KiB is the normal band for `read`, not a pathological tail —
    /// which is the exact complaint this task exists to fix.
    func testRetentionCapMatchesTheDaemonsMaxOutput() {
        XCTAssertEqual(SessionReducer.maxToolOutputCharacters, 64 * 1024)
    }

    // MARK: Fold search depth (Fix round 1, Minor-2)

    /// Builds `count` completed exchanges after the one holding an unresolved `bash` call, so the
    /// call's item sits exactly `count` exchanges back when the result finally arrives.
    private func stateWithUnresolvedCall(followedByCompletedTurns count: Int) -> OrbSessionState {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))       // callId "c3", never resolved
        s = SessionReducer.reduce(s, turnCompleted(seq: 4))
        for i in 0..<count {
            let base = 5 + i * 3
            s = SessionReducer.reduce(s, userMessage("turn \(i)", seq: base))
            s = SessionReducer.reduce(s, turnStarted(seq: base + 1))
            s = SessionReducer.reduce(s, turnCompleted(seq: base + 2))
        }
        return s
    }

    /// At the edge of the bound the result still lands: 3 newer exchanges means the item's own
    /// exchange is the 4th one scanned.
    func testToolResultStillFoldsAtTheSearchDepthLimit() {
        var s = stateWithUnresolvedCall(followedByCompletedTurns: 3)
        XCTAssertEqual(s.exchanges.count, 4, "precondition: the item's exchange is the 4th scanned")
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "landed", seq: 99))
        XCTAssertEqual(resultFields(s.exchanges[0].activity.first)?.output, "landed")
    }

    /// One exchange past the bound the result is deliberately dropped rather than walking the whole
    /// transcript — the documented trade in `toolResultFoldSearchDepth`. This is only reachable at
    /// all when a call's result never arrived within a few turns, which the engine does not do.
    func testToolResultBeyondTheSearchDepthIsNotFolded() {
        var s = stateWithUnresolvedCall(followedByCompletedTurns: 4)
        XCTAssertEqual(s.exchanges.count, 5, "precondition: the item's exchange is one past the bound")
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "too far back", seq: 99))
        XCTAssertEqual(resultFields(s.exchanges[0].activity.first)?.output, nil)
    }
}
