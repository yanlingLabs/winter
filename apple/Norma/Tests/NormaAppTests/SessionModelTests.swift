import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

final class SessionModelTests: XCTestCase {
    // Event factory helpers — one place builds wire-shaped JSON and decodes it,
    // so tests construct any variant tersely and stay honest to the protocol.
    func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    func turnStarted(seq: Int = 1, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)"}"#)
    }
    func toolCall(_ name: String, seq: Int = 2, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"tool_call","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"c\#(seq)","name":"\#(name)","argsJson":"{}"}"#)
    }
    func toolResult(seq: Int = 3, callId: String = "c2", thread: String = "main") -> SessionEvent {
        ev(#"{"type":"tool_result","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"\#(callId)","output":"ok","isError":false}"#)
    }
    func approvalRequested(callId: String, seq: Int = 4) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","toolName":"bash","summary":"rm x"}"#)
    }
    func approvalResolved(callId: String, seq: Int = 5) -> SessionEvent {
        ev(#"{"type":"approval_resolved","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","approved":true,"by":"cli"}"#)
    }
    func turnCompleted(seq: Int = 9, stopReason: String = "end_turn") -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","stopReason":"\#(stopReason)","inputTokens":1,"outputTokens":1}"#)
    }
    func taskUpdated(id: String, subject: String, status: String, seq: Int = 6) -> SessionEvent {
        ev(#"{"type":"task_updated","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","task":{"id":"\#(id)","subject":"\#(subject)","status":"\#(status)"}}"#)
    }
    func delta(_ text: String, seq: Int = 2, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"assistant_delta","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","delta":"\#(text)"}"#)
    }
    func assistantMessage(_ text: String, seq: Int = 5, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"assistant_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","text":"\#(text)"}"#)
    }
    func userMessage(_ text: String, seq: Int = 1, thread: String = "main", clientName: String = "cli") -> SessionEvent {
        ev(#"{"type":"user_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","text":"\#(text)","clientName":"\#(clientName)"}"#)
    }
    func harnessAttached(_ clientName: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"harness_attached","seq":\#(seq),"sessionId":"s","ts":0,"clientName":"\#(clientName)"}"#)
    }
    func harnessDetached(_ clientName: String, seq: Int = 2) -> SessionEvent {
        ev(#"{"type":"harness_detached","seq":\#(seq),"sessionId":"s","ts":0,"clientName":"\#(clientName)"}"#)
    }
    // task-30: `ts` defaults to "now" (ms) so a bare `notificationRequested()` call reads as a
    // genuinely LIVE event without every call site having to compute a fresh timestamp itself;
    // tests that specifically want a STALE (replayed) event pass an old `ts` explicitly.
    func notificationRequested(title: String = "Norma", message: String = "done", ts: Int = Int(Date().timeIntervalSince1970 * 1000), seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"notification_requested","seq":\#(seq),"sessionId":"s","ts":\#(ts),"threadId":"main","title":"\#(title)","message":"\#(message)"}"#)
    }

    func testTurnLifecycleDrivesStatus() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        XCTAssertEqual(s.status, .thinking)
        XCTAssertTrue(s.turnRunning)
        s = SessionReducer.reduce(s, toolCall("bash"))
        XCTAssertEqual(s.status, .toolRunning(name: "bash"))
        s = SessionReducer.reduce(s, toolResult())
        XCTAssertEqual(s.status, .thinking)
        s = SessionReducer.reduce(s, turnCompleted())
        XCTAssertEqual(s.status, .idle)
        XCTAssertFalse(s.turnRunning)
    }

    // MARK: Interrupt feedback (gate polish): `turn_completed(main)`'s `stopReason` drives
    // `lastTurnAborted` — an Esc-interrupt ("aborted") sets it, a normal finish ("end_turn")
    // doesn't, and the NEXT turn starting always clears it regardless of how the previous one
    // ended.

    func testAbortedStopReasonSetsLastTurnAborted() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        XCTAssertFalse(s.lastTurnAborted)
        s = SessionReducer.reduce(s, turnCompleted(stopReason: "aborted"))
        XCTAssertTrue(s.lastTurnAborted)
    }

    func testEndTurnStopReasonDoesNotSetLastTurnAborted() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, turnCompleted(stopReason: "end_turn"))
        XCTAssertFalse(s.lastTurnAborted)
    }

    func testNextTurnStartedClearsLastTurnAborted() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, turnCompleted(stopReason: "aborted"))
        XCTAssertTrue(s.lastTurnAborted)
        s = SessionReducer.reduce(s, turnStarted(seq: 10))
        XCTAssertFalse(s.lastTurnAborted)
    }

    func testApprovalCycleCountsAndRestores() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "c1"))
        s = SessionReducer.reduce(s, approvalRequested(callId: "c2", seq: 5))
        XCTAssertEqual(s.status, .approvalNeeded(count: 2))
        s = SessionReducer.reduce(s, approvalResolved(callId: "c1", seq: 6))
        XCTAssertEqual(s.status, .approvalNeeded(count: 1))
        s = SessionReducer.reduce(s, approvalResolved(callId: "c2", seq: 7))
        XCTAssertEqual(s.status, .thinking) // turn still running
    }

    func testChildThreadEventsDoNotChangeStatusButTasksApply() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, toolCall("read", seq: 7, thread: "th_child"))
        XCTAssertEqual(s.status, .thinking) // child tool never surfaces as main status
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "port orb", status: "in_progress"))
        XCTAssertEqual(s.tasks.count, 1)
    }

    func testTaskUpsertAndCounts() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "in_progress", seq: 7))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "completed", seq: 8))
        XCTAssertEqual(s.tasks.count, 2)
        XCTAssertEqual(s.taskCounts.done, 1)
        XCTAssertEqual(s.taskCounts.total, 2)
    }

    // MARK: Task deletion removes instead of phantoming (T3 review fix wave 1) — a task_updated
    // carrying status "deleted" (protocol/src/events.ts's TaskSchema, packages/core's
    // task_update deleted branch) must remove the task from `s.tasks`, not upsert it.

    func testTaskDeletedRemovesFromTasksAndRecountsCorrectly() {
        var s = OrbSessionState()
        // Realistic ordering (create pending, THEN complete) — creating "3" pending while "1" is
        // the only (already-completed) task must NOT hit the unrelated "new batch" reset (see
        // testNewTaskAfterFullCompletionResetsCounts below): task 1 only becomes completed AFTER
        // 2 and 3 already exist, so no new-id arrival ever sees an all-completed list.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "pending", seq: 7))
        s = SessionReducer.reduce(s, taskUpdated(id: "3", subject: "c", status: "pending", seq: 8))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "completed", seq: 9))
        XCTAssertEqual(s.taskCounts.total, 3)

        s = SessionReducer.reduce(s, taskUpdated(id: "3", subject: "c", status: "deleted", seq: 10))
        XCTAssertEqual(s.tasks.map(\.id), ["1", "2"])
        XCTAssertEqual(s.taskCounts.done, 1)
        XCTAssertEqual(s.taskCounts.total, 2) // recounted, not carrying the deleted task's slot
    }

    /// Deleting an unknown/already-gone id is a no-op on `s.tasks` (nothing to remove) — the
    /// reducer must not crash or insert a phantom entry for it either.
    func testTaskDeletedForUnknownIdIsNoOp() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        s = SessionReducer.reduce(s, taskUpdated(id: "999", subject: "ghost", status: "deleted", seq: 7))
        XCTAssertEqual(s.tasks.map(\.id), ["1"])
    }

    /// A deleted task must not be resurrected by the "brand-new task id" append path — once
    /// removed, a later event about a DIFFERENT new id must not somehow reintroduce it.
    func testTaskDeletedThenUnrelatedNewTaskDoesNotResurrectIt() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "deleted", seq: 7))
        XCTAssertEqual(s.tasks.count, 0)
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "pending", seq: 8))
        XCTAssertEqual(s.tasks.map(\.id), ["2"])
    }

    // MARK: Task list current-run scoping (gate wave-4 item 2 — "tasks never clear")

    /// (a) A brand-new task id arriving right after the current list finished completely (no
    /// in_progress, everything completed) is the start of a new batch — the finished batch's
    /// counts must not carry forward and inflate the new list's total.
    func testNewTaskAfterFullCompletionResetsCounts() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "pending", seq: 7))
        s = SessionReducer.reduce(s, taskUpdated(id: "3", subject: "c", status: "pending", seq: 8))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "completed", seq: 9))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "completed", seq: 10))
        s = SessionReducer.reduce(s, taskUpdated(id: "3", subject: "c", status: "completed", seq: 11))
        XCTAssertEqual(s.taskCounts.done, 3)
        XCTAssertEqual(s.taskCounts.total, 3)

        // Next run's first task_create (a brand-new, never-seen id) arrives — must reset, not
        // accumulate onto the finished 3/3 batch.
        s = SessionReducer.reduce(s, taskUpdated(id: "4", subject: "d", status: "pending", seq: 12))
        XCTAssertEqual(s.tasks.map(\.id), ["4"])
        XCTAssertEqual(s.taskCounts.done, 0)
        XCTAssertEqual(s.taskCounts.total, 1)

        // The rest of the new batch arriving doesn't resurrect the old one either.
        s = SessionReducer.reduce(s, taskUpdated(id: "5", subject: "e", status: "pending", seq: 13))
        s = SessionReducer.reduce(s, taskUpdated(id: "6", subject: "f", status: "pending", seq: 14))
        XCTAssertEqual(s.taskCounts.done, 0)
        XCTAssertEqual(s.taskCounts.total, 3)
    }

    /// (b) Once the turn that finished the tasks actually completes (idle), the "☑ n/m working…"
    /// pill must disappear entirely, not linger at "n/n". `FieldStateAdapter.statusText` is the
    /// thing the collapsed orb's pill visibility (`hasStatusPill`) actually reads.
    @MainActor
    func testIdleAfterFullCompletionHasNoWorkingPillText() {
        let session = SessionModel()
        session.markConnected()
        session.apply(turnStarted())
        session.apply(taskUpdated(id: "1", subject: "a", status: "pending"))
        session.apply(taskUpdated(id: "1", subject: "a", status: "in_progress", seq: 7))
        session.apply(taskUpdated(id: "1", subject: "a", status: "completed", seq: 8))
        let adapter = FieldStateAdapter(session: session)
        // Still turnRunning (turn_completed hasn't arrived yet), but the only task already
        // completed and NOTHING is in_progress any more — wave-6 item 2 hides the "☑ n/m" suffix
        // in exactly this situation, so only the bare working verb shows (not "<verb>… ☑ 1/1").
        XCTAssertEqual(adapter.statusText, "\(session.state.workingVerb)…")

        session.apply(turnCompleted(seq: 9))
        XCTAssertEqual(adapter.statusText, "")
    }

    /// (c) A new task created MID-RUN (something from the current batch still in_progress) must
    /// NOT be treated as a new batch — it just grows the current list normally.
    func testMidRunTaskAddDoesNotResetCounts() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "b", status: "pending", seq: 7))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "in_progress", seq: 8))
        s = SessionReducer.reduce(s, taskUpdated(id: "3", subject: "c", status: "pending", seq: 9))
        XCTAssertEqual(s.tasks.map(\.id), ["1", "2", "3"])
        XCTAssertEqual(s.taskCounts.done, 0)
        XCTAssertEqual(s.taskCounts.total, 3)

        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "completed", seq: 10))
        // Task 1 done, task 2 still merely pending (not in_progress) — NOT "no task in_progress
        // AND all completed" (task 2/3 aren't completed), so a new id here still must not reset.
        s = SessionReducer.reduce(s, taskUpdated(id: "4", subject: "d", status: "pending", seq: 11))
        XCTAssertEqual(s.tasks.map(\.id), ["1", "2", "3", "4"])
        XCTAssertEqual(s.taskCounts.done, 1)
        XCTAssertEqual(s.taskCounts.total, 4)
    }

    func testTurnCompletedClearsPendingApprovals() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "c1"))
        s = SessionReducer.reduce(s, turnCompleted())
        XCTAssertEqual(s.status, .idle)
        XCTAssertTrue(s.pendingInteractions.isEmpty)
    }

    func testConnectionStatesOverrideAndRestore() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduceConnection(s, .disconnected)
        XCTAssertEqual(s.status, .disconnected)
        s = SessionReducer.reduceConnection(s, .reconnecting(attempt: 1))
        XCTAssertEqual(s.status, .disconnected)
        s = SessionReducer.reduceConnection(s, .connected)
        XCTAssertEqual(s.status, .thinking) // turnRunning was true
    }

    func testReconnectPreservesPendingApprovalStatus() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, approvalRequested(callId: "c1"))
        s = SessionReducer.reduceConnection(s, .disconnected)
        XCTAssertEqual(s.status, .disconnected)
        s = SessionReducer.reduceConnection(s, .connected)
        XCTAssertEqual(s.status, .approvalNeeded(count: 1)) // pending survives the reconnect
    }

    // MARK: Whimsical working verb (wave 6 gate item 1: CC-style random verb per turn replaces
    // the static "thinking…"/tool name) + task counts gated on in-progress (wave 6 gate item 2)

    /// (a) Tasks may exist (even all pending) but nothing is `.in_progress` yet — bare verb, no
    /// "☑ n/m" suffix at all.
    func testWorkingPillTextIsBareVerbWhenNoTaskActive() {
        XCTAssertEqual(workingPillText(verb: "Reticulating", hasActiveTask: false, done: 0, total: 0), "Reticulating…")
        XCTAssertEqual(workingPillText(verb: "Reticulating", hasActiveTask: false, done: 0, total: 3), "Reticulating…")
    }

    /// (b) At least one task `.in_progress` — verb plus the "☑ n/m" suffix (n = completed + 1,
    /// clamped to total).
    func testWorkingPillTextAppendsCountsWhenTaskActive() {
        XCTAssertEqual(workingPillText(verb: "Noodling", hasActiveTask: true, done: 0, total: 4), "Noodling… ☑ 1/4")
        XCTAssertEqual(workingPillText(verb: "Noodling", hasActiveTask: true, done: 3, total: 4), "Noodling… ☑ 4/4")
        XCTAssertEqual(workingPillText(verb: "Noodling", hasActiveTask: true, done: 4, total: 4), "Noodling… ☑ 4/4")
    }

    func testHasActiveTaskTracksInProgressStatus() {
        var s = OrbSessionState()
        XCTAssertFalse(s.hasActiveTask)
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "pending"))
        XCTAssertFalse(s.hasActiveTask)
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "in_progress", seq: 7))
        XCTAssertTrue(s.hasActiveTask)
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "completed", seq: 8))
        XCTAssertFalse(s.hasActiveTask)
    }

    /// The reducer stays PURE — it must never roll a verb itself (that would make `reduce`
    /// nondeterministic given identical inputs). Only `SessionModel.apply` does, right after
    /// calling `reduce` — see its seam comment.
    func testReducerNeverRollsWorkingVerb() {
        var s = OrbSessionState()
        XCTAssertEqual(s.workingVerb, "")
        s = SessionReducer.reduce(s, turnStarted())
        XCTAssertEqual(s.workingVerb, "")
    }

    /// (d) Two turns can carry different verbs — tested via directly injected `workingVerb`
    /// values (not real randomness, which could flake by coincidentally repeating), proving the
    /// composition just reflects whatever `workingVerb` currently holds rather than memoizing or
    /// staling the first turn's word.
    func testDifferentInjectedVerbsAcrossTurnsProduceDifferentPillText() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s.workingVerb = "Reticulating" // stand-in for turn 1's store-side roll
        XCTAssertEqual(
            workingPillText(verb: s.workingVerb, hasActiveTask: s.hasActiveTask, done: s.taskCounts.done, total: s.taskCounts.total),
            "Reticulating…"
        )

        s = SessionReducer.reduce(s, turnCompleted(seq: 9))
        s = SessionReducer.reduce(s, turnStarted(seq: 10))
        s.workingVerb = "Noodling" // stand-in for turn 2's (different) roll
        XCTAssertEqual(
            workingPillText(verb: s.workingVerb, hasActiveTask: s.hasActiveTask, done: s.taskCounts.done, total: s.taskCounts.total),
            "Noodling…"
        )
    }

    /// Sanity on the extracted list itself: a real, sizeable, duplicate-free word set, and
    /// `random()` only ever returns members of it.
    func testWorkingVerbsListIsSizeableAndDuplicateFree() {
        XCTAssertGreaterThanOrEqual(WorkingVerbs.all.count, 40)
        XCTAssertEqual(Set(WorkingVerbs.all).count, WorkingVerbs.all.count)
        for _ in 0..<20 {
            XCTAssertTrue(WorkingVerbs.all.contains(WorkingVerbs.random()))
        }
    }

    /// End-to-end store wiring: `turnStarted(main)` rolls a real verb (member of the curated
    /// list), it stays STABLE across mid-turn tool activity (not re-rolled per event), and
    /// `FieldStateAdapter.statusText` shows exactly that verb with no tool name and no "☑ n/m"
    /// suffix while no task is `.in_progress` — this is item 1's "tool names no longer shown"
    /// requirement, exercised through a real `toolCall`.
    @MainActor
    func testTurnStartedRollsWorkingVerbStableWithinTurnAndHidesToolName() {
        let session = SessionModel()
        session.markConnected()
        session.apply(turnStarted())
        let verb = session.state.workingVerb
        XCTAssertTrue(WorkingVerbs.all.contains(verb))

        session.apply(toolCall("bash"))
        XCTAssertEqual(session.state.workingVerb, verb) // no re-roll mid-turn
        let adapter = FieldStateAdapter(session: session)
        XCTAssertEqual(adapter.statusText, "\(verb)…") // NOT "⚙ bash" — tool name no longer shown

        session.apply(toolResult())
        XCTAssertEqual(session.state.workingVerb, verb)
    }

    /// (a) Tasks exist (all pending, none in_progress) — the pill shows only the verb.
    @MainActor
    func testStatusTextShowsVerbOnlyWhileTasksPendingNotActive() {
        let session = SessionModel()
        session.markConnected()
        session.apply(turnStarted())
        session.apply(taskUpdated(id: "1", subject: "a", status: "pending"))
        session.apply(taskUpdated(id: "2", subject: "b", status: "pending", seq: 7))
        let adapter = FieldStateAdapter(session: session)
        XCTAssertEqual(adapter.statusText, "\(session.state.workingVerb)…")
    }

    /// (b) One task in_progress — the pill appends "☑ n/m".
    @MainActor
    func testStatusTextAppendsCountsWhileTaskInProgress() {
        let session = SessionModel()
        session.markConnected()
        session.apply(turnStarted())
        session.apply(taskUpdated(id: "1", subject: "a", status: "pending"))
        session.apply(taskUpdated(id: "2", subject: "b", status: "in_progress", seq: 7))
        let adapter = FieldStateAdapter(session: session)
        XCTAssertEqual(adapter.statusText, "\(session.state.workingVerb)… ☑ 1/2")
    }

    // MARK: - Wave-7 gate item 2: FieldStateAdapter.isWorkingVerb (animated spinner/sheen gate)

    /// A running turn with no override pill (`.thinking`) is exactly the "working verb" branch of
    /// `statusText` — the animated spinner + sheen (`NormaFieldView`) should apply.
    @MainActor
    func testIsWorkingVerbTrueWhileTurnRunningWithNoOverridePill() {
        let session = SessionModel()
        session.markConnected()
        session.apply(turnStarted())
        let adapter = FieldStateAdapter(session: session)
        XCTAssertTrue(adapter.isWorkingVerb)
    }

    /// `.approvalNeeded` overrides `statusText` "even mid-turn" (per its own doc) — the turn is
    /// still running (`testApprovalCycleCountsAndRestores`'s "turn still running" comment) but the
    /// pill shown is the static "needs approval" text, not the verb, so the animation must NOT
    /// apply here.
    @MainActor
    func testIsWorkingVerbFalseWhenApprovalNeededEvenWhileTurnRunning() {
        let session = SessionModel()
        session.markConnected()
        session.apply(turnStarted())
        session.apply(approvalRequested(callId: "c1"))
        XCTAssertTrue(session.state.turnRunning) // still running — override wins regardless
        let adapter = FieldStateAdapter(session: session)
        XCTAssertFalse(adapter.isWorkingVerb)
        XCTAssertEqual(adapter.statusText, "needs approval")
    }

    /// True idle (never connected, or connected with nothing running) — no pill at all, so
    /// obviously nothing to animate.
    @MainActor
    func testIsWorkingVerbFalseWhenIdle() {
        let session = SessionModel()
        session.markConnected()
        let adapter = FieldStateAdapter(session: session)
        XCTAssertFalse(adapter.isWorkingVerb)
    }

    /// Disconnected (the other override pill) — same "static override, no animation" contract as
    /// `.approvalNeeded` above.
    @MainActor
    func testIsWorkingVerbFalseWhenDisconnected() {
        let session = SessionModel() // markConnected() never called: status stays .disconnected
        let adapter = FieldStateAdapter(session: session)
        XCTAssertFalse(adapter.isWorkingVerb)
        XCTAssertEqual(adapter.statusText, "disconnected")
    }

    @MainActor
    func testSessionModelStorePublishesAndMarksConnected() {
        let m = SessionModel()
        XCTAssertEqual(m.state.status, .disconnected) // before markConnected: not connected yet
        m.markConnected() // M2: initial connect success IS the signal
        XCTAssertEqual(m.state.status, .idle)
        m.apply(turnStarted())
        XCTAssertEqual(m.state.status, .thinking)
    }

    func testDeltasAccumulateAndFinalSwaps() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, delta("Hel"))
        s = SessionReducer.reduce(s, delta("lo", seq: 3))
        XCTAssertEqual(s.streamingText, "Hello")
        s = SessionReducer.reduce(s, assistantMessage("Hello there"))
        XCTAssertEqual(s.lastReply, "Hello there")
        XCTAssertEqual(s.streamingText, "")
    }

    func testNewTurnClearsStreamingKeepsLastReply() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, delta("old"))
        s = SessionReducer.reduce(s, assistantMessage("old answer"))
        s = SessionReducer.reduce(s, turnCompleted())
        s = SessionReducer.reduce(s, turnStarted(seq: 10))
        XCTAssertEqual(s.streamingText, "")
        XCTAssertEqual(s.lastReply, "old answer") // visible until the new reply streams
    }

    func testChildThreadDeltasIgnored() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, delta("child", thread: "th_1"))
        XCTAssertEqual(s.streamingText, "")
    }

    func testAbortedTurnClearsStreamingText() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted())
        s = SessionReducer.reduce(s, delta("partial"))
        s = SessionReducer.reduce(s, turnCompleted()) // abort/end without assistant_message
        XCTAssertEqual(s.streamingText, "")
        XCTAssertFalse(s.turnRunning)

        s = SessionReducer.reduce(s, turnStarted(seq: 10))
        s = SessionReducer.reduce(s, delta("more", seq: 11))
        s = SessionReducer.reduce(s, ev(#"{"type":"agent_error","seq":12,"sessionId":"s","ts":0,"threadId":"main","message":"boom"}"#))
        XCTAssertEqual(s.streamingText, "")
    }

    // MARK: Exchange pairing (2c wave 2 task 3 — inline response reads exchanges, not lastReply)

    func testUserAndAssistantMessagePairIntoOneExchange() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi there"))
        s = SessionReducer.reduce(s, assistantMessage("hello!", seq: 2))
        XCTAssertEqual(s.exchanges, [Exchange(prompt: "hi there", reply: "hello!")])
    }

    func testAssistantMessageWithoutPriorUserMessageCreatesEmptyPromptExchange() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, assistantMessage("orphan reply"))
        XCTAssertEqual(s.exchanges, [Exchange(prompt: "", reply: "orphan reply")])
    }

    func testTwoTurnsProduceTwoOrderedExchanges() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("first", seq: 1))
        s = SessionReducer.reduce(s, assistantMessage("first reply", seq: 2))
        s = SessionReducer.reduce(s, userMessage("second", seq: 3))
        s = SessionReducer.reduce(s, assistantMessage("second reply", seq: 4))
        XCTAssertEqual(s.exchanges, [
            Exchange(prompt: "first", reply: "first reply"),
            Exchange(prompt: "second", reply: "second reply"),
        ])
    }

    /// Real wire order (send appends the user_message BEFORE the turn starts): user_message("A")
    /// arrives while turnRunning is still false (idle from the previous turn), so it correctly
    /// starts a fresh exchange. Then turn_started flips turnRunning true. A steer mid-turn is a
    /// SECOND user_message(main) with no intervening turn_started — it must fold into the SAME
    /// exchange (grow the prompt) rather than open a second one, so the eventual reply lands on
    /// the exchange the user was actually looking at.
    func testMidTurnSteerFoldsIntoSameExchange() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("A", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, userMessage("B", seq: 3)) // steer: turnRunning already true
        s = SessionReducer.reduce(s, assistantMessage("done", seq: 4))
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.exchanges[0].prompt, "A\n↳ B")
        XCTAssertEqual(s.exchanges[0].reply, "done")
    }

    /// Regression: two sequential (non-steer) turns — each user_message arrives with turnRunning
    /// false (the prior turn already completed) — still produce two separate exchanges.
    func testSequentialTurnsAfterCompletionStillProduceTwoExchanges() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("first", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, assistantMessage("first reply", seq: 3))
        s = SessionReducer.reduce(s, turnCompleted(seq: 4))
        s = SessionReducer.reduce(s, userMessage("second", seq: 5))
        s = SessionReducer.reduce(s, turnStarted(seq: 6))
        s = SessionReducer.reduce(s, assistantMessage("second reply", seq: 7))
        XCTAssertEqual(s.exchanges, [
            Exchange(prompt: "first", reply: "first reply"),
            Exchange(prompt: "second", reply: "second reply"),
        ])
    }

    // MARK: Multi-round turns (mac-chat-parity Task 1 — the per-round overwrite)
    //
    // The engine emits one `assistant_message` PER ROUND whenever that round produced text
    // (`if (textBuf.length > 0)`, packages/core/src/agent/engine.ts). This used to ASSIGN to a
    // single `reply` string, so every round but the last was silently discarded before it reached
    // any view — data loss, not a styling gap.

    func testMultiRoundTurnKeepsEveryAssistantMessageInOrder() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("do a big thing", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, assistantMessage("first, I'll look around", seq: 3))
        s = SessionReducer.reduce(s, toolCall("bash", seq: 4))
        s = SessionReducer.reduce(s, assistantMessage("now I'll fix it", seq: 5))
        s = SessionReducer.reduce(s, turnCompleted(seq: 6))
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.exchanges[0].replies, ["first, I'll look around", "now I'll fix it"])
    }

    /// Three rounds, to prove the append is not a two-slot special case.
    func testEveryRoundOfALongTurnSurvives() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("go", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        for (i, text) in ["r1", "r2", "r3"].enumerated() {
            s = SessionReducer.reduce(s, assistantMessage(text, seq: 3 + i))
        }
        XCTAssertEqual(s.exchanges[0].replies, ["r1", "r2", "r3"])
    }

    /// The single-bubble surfaces (`FieldStateAdapter.visibleResponse`, the orb's reveal gates)
    /// read `Exchange.reply`, which is deliberately still "the latest assistant message" —
    /// exactly what the old overwritten `reply` held. Task 1 changes the transcript, not them.
    func testReplyAccessorStillReadsTheLatestRound() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("go", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, assistantMessage("round one", seq: 3))
        s = SessionReducer.reduce(s, assistantMessage("round two", seq: 4))
        XCTAssertEqual(s.exchanges[0].reply, "round two")
        XCTAssertEqual(s.lastReply, "round two")
    }

    /// An empty-text `assistant_message` adds no row. The daemon never emits one (the emission is
    /// guarded on `textBuf.length > 0`), so this is defence against a second producer — and it
    /// matters because appending an empty entry would both draw a blank transcript row and blank
    /// out `reply` for the surfaces that read it.
    func testEmptyAssistantMessageAddsNoRow() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("go", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, assistantMessage("real text", seq: 3))
        s = SessionReducer.reduce(s, assistantMessage("", seq: 4))
        XCTAssertEqual(s.exchanges[0].replies, ["real text"])
    }

    /// An errored turn (agent_error, no assistant_message) fills the still-empty exchange's
    /// reply with the error message instead of leaving it blank forever.
    func testAgentErrorFillsEmptyReplyOnLastExchange() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("do the thing", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, ev(#"{"type":"agent_error","seq":3,"sessionId":"s","ts":0,"threadId":"main","message":"boom"}"#))
        XCTAssertEqual(s.exchanges, [Exchange(prompt: "do the thing", reply: "⚠︎ boom")])
    }

    // MARK: Queued steer indicator (wave-5 gate item 2 — the mid-turn fold above was silent;
    // this surfaces it separately so the UI can show "queued" instead of appearing to swallow it)

    func testMidTurnSteerAppendsToQueuedSteers() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("A", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        XCTAssertTrue(s.queuedSteers.isEmpty) // nothing queued yet, still just the original prompt
        s = SessionReducer.reduce(s, userMessage("B", seq: 3)) // steer
        XCTAssertEqual(s.queuedSteers, ["B"])
        s = SessionReducer.reduce(s, userMessage("C", seq: 4)) // a second steer in the same turn
        XCTAssertEqual(s.queuedSteers, ["B", "C"])
        // The fold into the exchange prompt still happens too — this is additive, not a replacement.
        XCTAssertEqual(s.exchanges[0].prompt, "A\n↳ B\n↳ C")
    }

    func testTurnCompletedClearsQueuedSteers() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("A", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, userMessage("B", seq: 3))
        s = SessionReducer.reduce(s, turnCompleted(seq: 4))
        XCTAssertTrue(s.queuedSteers.isEmpty)
    }

    func testAgentErrorClearsQueuedSteers() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("A", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, userMessage("B", seq: 3))
        s = SessionReducer.reduce(s, ev(#"{"type":"agent_error","seq":4,"sessionId":"s","ts":0,"threadId":"main","message":"boom"}"#))
        XCTAssertTrue(s.queuedSteers.isEmpty)
    }

    /// `FieldStateAdapter.queuedText` is what `NormaFieldView`'s queued-line actually reads —
    /// covers the "queued: <text>" join format directly, through a live `SessionModel`.
    @MainActor
    func testQueuedTextReflectsQueuedSteersAndClearsOnCompletion() {
        let session = SessionModel()
        session.markConnected()
        session.apply(userMessage("A", seq: 1))
        session.apply(turnStarted(seq: 2))
        let adapter = FieldStateAdapter(session: session)
        XCTAssertNil(adapter.queuedText) // nothing queued yet

        session.apply(userMessage("B", seq: 3))
        XCTAssertEqual(adapter.queuedText, "queued: B")

        session.apply(userMessage("C", seq: 4))
        XCTAssertEqual(adapter.queuedText, "queued: B; C")

        session.apply(turnCompleted(seq: 5))
        XCTAssertNil(adapter.queuedText)
    }

    // MARK: - gate-feedback-1 FIX A: harness attach/detach reducer state (`attachedClients`,
    // `cliAttached`) — previously ignored entirely by the `default:` branch.

    func testHarnessAttachedAppendsClientName() {
        var s = OrbSessionState()
        XCTAssertTrue(s.attachedClients.isEmpty)
        XCTAssertFalse(s.cliAttached)
        s = SessionReducer.reduce(s, harnessAttached("cli-chat"))
        XCTAssertEqual(s.attachedClients, ["cli-chat"])
        XCTAssertTrue(s.cliAttached)
    }

    func testHarnessDetachedRemovesFirstMatchOnly() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, harnessAttached("cli-chat", seq: 1))
        s = SessionReducer.reduce(s, harnessAttached("cli-chat", seq: 2)) // two concurrent attaches, same name
        XCTAssertEqual(s.attachedClients, ["cli-chat", "cli-chat"])
        s = SessionReducer.reduce(s, harnessDetached("cli-chat", seq: 3))
        // Only ONE entry removed — the other cli-chat client is still attached.
        XCTAssertEqual(s.attachedClients, ["cli-chat"])
        XCTAssertTrue(s.cliAttached)
        s = SessionReducer.reduce(s, harnessDetached("cli-chat", seq: 4))
        XCTAssertTrue(s.attachedClients.isEmpty)
        XCTAssertFalse(s.cliAttached)
    }

    /// A detach for a clientName that was never attached (or already fully detached) is a no-op —
    /// must not crash or remove an unrelated entry.
    func testHarnessDetachedForUnknownClientIsNoOp() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, harnessAttached("cli-chat"))
        s = SessionReducer.reduce(s, harnessDetached("cli-status", seq: 2))
        XCTAssertEqual(s.attachedClients, ["cli-chat"])
    }

    /// `cliAttached` requires the "cli" PREFIX specifically — an app-side or other non-CLI client
    /// name must not flip it true (mirrors the "cli-" prefix every `connect()` call site in
    /// `packages/cli/src/main.ts` actually uses).
    func testCliAttachedRequiresCliPrefixNotJustAnyClient() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, harnessAttached("app-dashboard"))
        XCTAssertFalse(s.cliAttached)
        s = SessionReducer.reduce(s, harnessAttached("cli-ping", seq: 2))
        XCTAssertTrue(s.cliAttached)
    }

    /// Replay-safety (the daemon replays its full event log on reconnect/refocus): a historical
    /// attach/detach PAIR for the same clientName must cancel out to the SAME state a fresh live
    /// stream (which only ever sees the currently-attached client) would produce — not double-count
    /// or leak a phantom entry.
    func testReplayedAttachDetachPairCancelsOut() {
        var s = OrbSessionState()
        // Replayed history: an earlier client attached and detached before the current one arrived.
        s = SessionReducer.reduce(s, harnessAttached("cli-p", seq: 1))
        s = SessionReducer.reduce(s, harnessDetached("cli-p", seq: 2))
        s = SessionReducer.reduce(s, harnessAttached("cli-chat", seq: 3)) // the currently-live client
        XCTAssertEqual(s.attachedClients, ["cli-chat"])
        XCTAssertTrue(s.cliAttached)
    }

    /// Multiple interleaved attach/detach pairs across different client names all net out
    /// correctly, replay-order preserved.
    func testMultipleInterleavedAttachDetachPairsNetOutCorrectly() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, harnessAttached("cli-chat", seq: 1))
        s = SessionReducer.reduce(s, harnessAttached("cli-status", seq: 2))
        s = SessionReducer.reduce(s, harnessDetached("cli-chat", seq: 3))
        s = SessionReducer.reduce(s, harnessAttached("cli-quota", seq: 4))
        s = SessionReducer.reduce(s, harnessDetached("cli-quota", seq: 5))
        XCTAssertEqual(s.attachedClients, ["cli-status"])
        XCTAssertTrue(s.cliAttached)
        s = SessionReducer.reduce(s, harnessDetached("cli-status", seq: 6))
        XCTAssertTrue(s.attachedClients.isEmpty)
        XCTAssertFalse(s.cliAttached)
    }

    // MARK: - orb-scope Part 2: `lastTurnOriginClientName`/`lastTurnWasOrbInitiated` — which
    // client's `user_message` started the most recently begun turn.

    func testNewExchangeStampsOriginClientName() {
        var s = OrbSessionState()
        XCTAssertNil(s.lastTurnOriginClientName)
        XCTAssertFalse(s.lastTurnWasOrbInitiated)
        s = SessionReducer.reduce(s, userMessage("hi", seq: 1, clientName: "orb"))
        XCTAssertEqual(s.lastTurnOriginClientName, "orb")
        XCTAssertTrue(s.lastTurnWasOrbInitiated)
    }

    /// The phone's dispatch mode relays through the Mac's own gateway harness, clientName
    /// "iphone-gateway" (`RemoteHost.swift`) — never "orb", so never orb-initiated.
    func testPhoneRelayedOriginIsNotOrbInitiated() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi from phone", seq: 1, clientName: "iphone-gateway"))
        XCTAssertEqual(s.lastTurnOriginClientName, "iphone-gateway")
        XCTAssertFalse(s.lastTurnWasOrbInitiated)
    }

    /// A scheduled routine's turn (`packages/core/src/routines/runner.ts` stamps clientName
    /// "routine") is likewise never orb-initiated.
    func testRoutineOriginIsNotOrbInitiated() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("scheduled run", seq: 1, clientName: "routine"))
        XCTAssertEqual(s.lastTurnOriginClientName, "routine")
        XCTAssertFalse(s.lastTurnWasOrbInitiated)
    }

    /// A mid-turn steer (turn already running, current exchange's reply still empty) folds into
    /// the OPEN exchange rather than starting a new one — it must NOT overwrite the turn's
    /// original origin, even when the steer carries a different clientName (steers are actually
    /// always attributed the engine's fixed "steer" sentinel regardless of caller, but the
    /// reducer's own fold condition — not clientName — is what decides this, so a differently
    /// named steer proves the fold path itself is what's guarding the field, not a clientName
    /// coincidence).
    func testMidTurnSteerDoesNotOverwriteOrigin() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted(seq: 1)) // turnRunning = true, no reply yet
        s = SessionReducer.reduce(s, userMessage("first", seq: 2, clientName: "orb"))
        XCTAssertEqual(s.lastTurnOriginClientName, "orb")
        s = SessionReducer.reduce(s, userMessage("steer text", seq: 3, clientName: "iphone-gateway"))
        // Still folded into the same open exchange, origin untouched.
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.lastTurnOriginClientName, "orb")
        XCTAssertTrue(s.lastTurnWasOrbInitiated)
    }

    /// The field is read at `turn_completed` time (`GlassRootView.handleTurnCompleted()`) — it
    /// must still hold the ORIGINATING clientName once the turn finishes, not get cleared.
    func testOriginSurvivesTurnCompleted() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi", seq: 1, clientName: "orb"))
        s = SessionReducer.reduce(s, turnCompleted(seq: 2))
        XCTAssertEqual(s.lastTurnOriginClientName, "orb")
        XCTAssertTrue(s.lastTurnWasOrbInitiated)
    }

    /// A brand-new turn's user_message OVERWRITES the previous turn's origin — each turn is judged
    /// on its own initiator, not whoever started an earlier one.
    func testNextTurnOverwritesPreviousOrigin() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("first turn", seq: 1, clientName: "orb"))
        s = SessionReducer.reduce(s, turnCompleted(seq: 2))
        XCTAssertTrue(s.lastTurnWasOrbInitiated)
        s = SessionReducer.reduce(s, userMessage("second turn", seq: 3, clientName: "routine"))
        XCTAssertEqual(s.lastTurnOriginClientName, "routine")
        XCTAssertFalse(s.lastTurnWasOrbInitiated)
    }

    // MARK: - Important-2 fix (orb-scope review): engine-sentinel clientNames must never overwrite
    // the stamped turn origin.

    /// The exact reported defect, reproduced: the engine emits `assistant_message` PER ROUND
    /// (`packages/core/src/agent/engine.ts:2152`), so a multi-round tool-using turn already has a
    /// non-empty `exchanges.last.reply` mid-turn. `testMidTurnSteerDoesNotOverwriteOrigin` above
    /// only covers the reply-still-empty case (steer before any round's assistant text arrives);
    /// this covers the reply-already-non-empty case, where the reducer's fold guard
    /// (`reply.isEmpty`) takes the "new exchange" branch instead — the ONLY thing that then
    /// prevents `"steer"` (the engine's own sentinel, stamped unconditionally by `engine.steer()`,
    /// regardless of who actually typed the steer) from clobbering the real origin is the sentinel
    /// guard on the stamp itself.
    func testMultiRoundTurnSteerSentinelDoesNotOverwriteOrigin() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, turnStarted(seq: 1))
        s = SessionReducer.reduce(s, userMessage("first", seq: 2, clientName: "orb"))
        XCTAssertEqual(s.lastTurnOriginClientName, "orb")
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolResult(seq: 4, callId: "c3"))
        // Round 1's own assistant text lands — reply is now non-empty mid-turn, the exact
        // precondition the reported bug depends on.
        s = SessionReducer.reduce(s, assistantMessage("partial round 1", seq: 5))
        XCTAssertFalse(s.exchanges.last?.reply.isEmpty ?? true, "precondition: reply must be non-empty for the fold guard to actually take the buggy branch")
        // User steers mid-turn — the ENGINE stamps this "steer" regardless of who actually typed it.
        s = SessionReducer.reduce(s, userMessage("steer text", seq: 6, clientName: "steer"))
        XCTAssertEqual(s.lastTurnOriginClientName, "orb", "an engine sentinel clientName must never overwrite the stamped turn origin")
        s = SessionReducer.reduce(s, assistantMessage("final round 2", seq: 7))
        s = SessionReducer.reduce(s, turnCompleted(seq: 8))
        XCTAssertEqual(s.lastTurnOriginClientName, "orb")
        XCTAssertTrue(s.lastTurnWasOrbInitiated, "the auto-reveal gate must still see this turn as orb-initiated once it completes")
    }

    /// A genuine cross-client send — NOT an engine sentinel — after a completed turn DOES overwrite,
    /// exactly like `testNextTurnOverwritesPreviousOrigin` above but pinned to the specific
    /// clientName the brief calls out (`"iphone-gateway"`, the phone's Mac-side gateway harness).
    func testGenuinePhoneSendAfterCompletedTurnStillOverwritesOrigin() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("orb turn", seq: 1, clientName: "orb"))
        s = SessionReducer.reduce(s, turnCompleted(seq: 2))
        XCTAssertTrue(s.lastTurnWasOrbInitiated)
        s = SessionReducer.reduce(s, userMessage("phone turn", seq: 3, clientName: "iphone-gateway"))
        XCTAssertEqual(s.lastTurnOriginClientName, "iphone-gateway", "a genuine cross-client send must still overwrite — only engine sentinels are guarded")
        XCTAssertFalse(s.lastTurnWasOrbInitiated)
    }

    /// Defense-in-depth coverage for the two sentinels that, per `engine.ts`'s own doc comments,
    /// are stamped ONLY on child-thread events and so can never reach this `mainThread`-scoped
    /// branch today (`"send_message"` — `runThread`'s child-thread steer drain; `"resume"` —
    /// `resumeAgent`). Guarded anyway so a future engine change that ever did surface one here
    /// fails closed instead of silently corrupting the origin — this test exercises that guard
    /// directly rather than trusting it by inspection alone.
    func testSendMessageAndResumeSentinelsAreGuardedDefenseInDepth() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("first", seq: 1, clientName: "orb"))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        s = SessionReducer.reduce(s, assistantMessage("partial", seq: 3))
        s = SessionReducer.reduce(s, userMessage("hypothetical send_message on main", seq: 4, clientName: "send_message"))
        XCTAssertEqual(s.lastTurnOriginClientName, "orb")
        s = SessionReducer.reduce(s, assistantMessage("partial 2", seq: 5))
        s = SessionReducer.reduce(s, userMessage("hypothetical resume on main", seq: 6, clientName: "resume"))
        XCTAssertEqual(s.lastTurnOriginClientName, "orb")
    }

    /// `engine.steer()`'s idle idiom (`packages/core/src/agent/engine.ts:1047-1054`): steer()
    /// unconditionally stamps `"steer"` and persists the user_message BEFORE checking whether a
    /// turn is running — when the session is IDLE, that same user_message is what starts the fresh
    /// turn (the reducer's own `turnRunning == false` takes the "new exchange" branch, exactly as a
    /// genuine new-turn userMessage would). Decided behavior: the sentinel guard applies here too —
    /// the origin field KEEPS whatever it already held (the prior turn's origin, or `nil` if there
    /// has never been one) rather than being corrupted to `"steer"`. This is a deliberate "don't
    /// know, don't guess" choice: the sentinel carries no real caller identity, so there is nothing
    /// honest to stamp from it.
    func testIdleSteerStartingATurnKeepsPriorOrigin() {
        var s = OrbSessionState()
        // An earlier, unrelated turn already completed, orb-initiated.
        s = SessionReducer.reduce(s, userMessage("earlier orb turn", seq: 1, clientName: "orb"))
        s = SessionReducer.reduce(s, turnCompleted(seq: 2))
        XCTAssertTrue(s.lastTurnWasOrbInitiated)

        // Session is IDLE (turnRunning false) when a steer arrives and starts a fresh turn.
        s = SessionReducer.reduce(s, userMessage("typed while idle", seq: 3, clientName: "steer"))
        XCTAssertEqual(s.exchanges.count, 2, "still opens its own new exchange — only the origin STAMP is guarded, not the fold/new-exchange decision")
        XCTAssertEqual(s.lastTurnOriginClientName, "orb", "an idle-starting steer keeps the prior turn's origin rather than being corrupted to the sentinel")
    }

    // MARK: - task-30 (push-notification track): `SessionModel.apply`'s notification-posting seam.
    //
    // `SessionReducer.reduce` itself does nothing special for `notificationRequested` (it falls to
    // the reducer's `default: break`, same as assistant_delta/checkpoint/etc.) — the real behavior
    // lives entirely in `SessionModel.apply`'s impurity seam, tested here via an injected fake so
    // the real `UNUserNotificationCenter` is never touched.

    final class FakeNotificationPoster: NotificationPosting {
        private(set) var posts: [(title: String, body: String)] = []
        func post(title: String, body: String) { posts.append((title, body)) }
    }

    @MainActor
    func testFreshNotificationRequestedPostsANativeAlert() {
        let poster = FakeNotificationPoster()
        let session = SessionModel(notifier: poster)
        session.apply(notificationRequested(title: "Build", message: "finished"))
        XCTAssertEqual(poster.posts.count, 1)
        XCTAssertEqual(poster.posts[0].title, "Build")
        XCTAssertEqual(poster.posts[0].body, "finished")
    }

    /// Replay-safety: a session reattach/refocus/relaunch replays its ENTIRE history from seq 0
    /// (AppModel.refocus/SessionFeed.repin) — an OLD `notification_requested` (from, say, an hour
    /// ago) must NOT re-fire as a brand-new native banner just because it's being replayed now.
    @MainActor
    func testStaleReplayedNotificationRequestedDoesNotPost() {
        let poster = FakeNotificationPoster()
        let session = SessionModel(notifier: poster)
        let anHourAgo = Int(Date().timeIntervalSince1970 * 1000) - 3_600_000
        session.apply(notificationRequested(message: "old news", ts: anHourAgo))
        XCTAssertTrue(poster.posts.isEmpty)
    }

    /// Pins the exact freshness boundary (`SessionModel.notificationFreshnessMs`) both directions —
    /// just inside it posts, just outside it doesn't — rather than only testing comfortably-fresh/
    /// comfortably-stale cases that would pass even if the boundary math were off by a lot.
    @MainActor
    func testNotificationFreshnessBoundary() {
        let now = Date().timeIntervalSince1970 * 1000
        let justFresh = Int(now - SessionModel.notificationFreshnessMs + 500)
        let justStale = Int(now - SessionModel.notificationFreshnessMs - 500)

        let freshPoster = FakeNotificationPoster()
        SessionModel(notifier: freshPoster).apply(notificationRequested(ts: justFresh))
        XCTAssertEqual(freshPoster.posts.count, 1)

        let stalePoster = FakeNotificationPoster()
        SessionModel(notifier: stalePoster).apply(notificationRequested(ts: justStale))
        XCTAssertTrue(stalePoster.posts.isEmpty)
    }

    /// `SessionReducer.reduce` itself is a pure no-op for `notificationRequested` (falls to
    /// `default: break`, same as `turnStarted` does for `workingVerb` above) — the posting
    /// happens ONLY in `SessionModel.apply`'s impurity seam, never inside the reducer.
    func testReducerAloneNeverActsOnNotificationRequested() {
        var s = OrbSessionState()
        let before = s
        s = SessionReducer.reduce(s, notificationRequested())
        XCTAssertEqual(s, before)
    }

    /// A non-notification event must never touch the poster at all.
    @MainActor
    func testUnrelatedEventNeverPosts() {
        let poster = FakeNotificationPoster()
        let session = SessionModel(notifier: poster)
        session.apply(turnStarted())
        session.apply(taskUpdated(id: "1", subject: "a", status: "pending"))
        XCTAssertTrue(poster.posts.isEmpty)
    }
}
