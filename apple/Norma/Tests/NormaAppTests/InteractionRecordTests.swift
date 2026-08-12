import XCTest
import NormaProtocol
@testable import Norma

/// mac-chat-parity Task 3 — the REDUCER half of "cards inline, permanent, and correct".
///
/// Drives the pure `SessionReducer` directly with wire-shaped JSON decoded through the real
/// `SessionEvent` decoder, the same convention as `ActivityCaptureTests`/`SessionModelTests`.
///
/// **What this file does NOT cover, at all:** anything rendered. Whether the frozen card is
/// legible, whether its accent fill is visible, whether a click actually lands on nothing — those
/// are pixels and hit-testing, and the user's live gate is the only thing that settles them. What
/// is pinned here is the DATA the view draws from: that a resolved ask keeps its outcome in the
/// transcript instead of being deleted, that the outcome is the one the daemon reported, and that
/// `interactionIsPending` (the single predicate the view branches on) goes false the moment the ask
/// is no longer outstanding.
final class InteractionRecordTests: XCTestCase {

    // MARK: Event factory (mirrors ActivityCaptureTests' idioms — wire JSON, real decoder)

    /// A bad fixture is a RED, not a runner abort — see `ActivityCaptureTests.ev` for why this is
    /// fail-and-substitute rather than `XCTUnwrap` in a `throws` helper (whole-branch review, M-9).
    private func ev(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> SessionEvent {
        do {
            return try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        } catch {
            XCTFail("undecodable SessionEvent fixture: \(error)\n\(json)", file: file, line: line)
            return .turnStarted(.init(seq: 0, sessionId: "s", ts: 0, threadId: "main"))
        }
    }
    private func userMessage(_ text: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"user_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","text":"\#(text)","clientName":"cli"}"#)
    }
    private func turnStarted(seq: Int = 2) -> SessionEvent {
        ev(#"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main"}"#)
    }
    private func turnCompleted(seq: Int = 90, stopReason: String = "end_turn") -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","stopReason":"\#(stopReason)","inputTokens":1,"outputTokens":1}"#)
    }
    private func agentError(_ message: String = "boom", seq: Int = 91) -> SessionEvent {
        ev(#"{"type":"agent_error","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","message":"\#(message)"}"#)
    }
    private func approvalRequested(summary: String = "rm -rf x", tool: String = "bash", callId: String = "a1", seq: Int = 3) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","toolName":"\#(tool)","summary":"\#(summary)"}"#)
    }
    private func approvalResolved(approved: Bool, by: String = "orb", callId: String = "a1", seq: Int = 4) -> SessionEvent {
        ev(#"{"type":"approval_resolved","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","approved":\#(approved),"by":"\#(by)"}"#)
    }
    /// One single-select question with two options — the shape a frozen card has to mark a choice on.
    private func questionAsked(_ question: String = "Which port?", callId: String = "q1", seq: Int = 3) -> SessionEvent {
        ev(#"""
        {"type":"question_asked","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","questions":[{"question":"\#(question)","header":"Port","options":[{"label":"3000"},{"label":"8080"}],"multiSelect":false}]}
        """#)
    }
    private func questionResolved(_ question: String = "Which port?", answer: String = "8080", note: String? = nil, by: String = "orb", callId: String = "q1", seq: Int = 4) -> SessionEvent {
        let notes = note.map { #","notes":{"\#(question)":"\#($0)"}"# } ?? ""
        return ev(#"""
        {"type":"question_resolved","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","answers":{"\#(question)":"\#(answer)"},"by":"\#(by)"\#(notes)}
        """#)
    }
    private func planPresented(callId: String = "p1", seq: Int = 3) -> SessionEvent {
        ev(#"{"type":"plan_presented","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","plan":"the plan"}"#)
    }
    private func planResolved(approved: Bool, autoAccept: Bool = false, feedback: String? = nil, by: String = "orb", callId: String = "p1", seq: Int = 4) -> SessionEvent {
        let fb = feedback.map { #","feedback":"\#($0)"# + "\"" } ?? ""
        return ev(#"{"type":"plan_resolved","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","approved":\#(approved),"autoAccept":\#(autoAccept),"by":"\#(by)"\#(fb)}"#)
    }

    private func openTurnState() -> OrbSessionState {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi"))
        s = SessionReducer.reduce(s, turnStarted())
        return s
    }

    /// Every `InteractionRecord` anywhere in the transcript, oldest first.
    private func records(_ s: OrbSessionState) -> [InteractionRecord] {
        s.exchanges.flatMap { $0.activity.compactMap(\.interactionRecord) }
    }

    // MARK: The record survives resolution (defect 1 — the record-keeping gap)

    /// THE headline pin: a resolved approval is still in the transcript, carrying its decision.
    /// Before Task 3 the only trace of an approval was `pendingInteractions`, which `resolvePending`
    /// empties — so after this exact event pair the Mac knew nothing about what had been approved.
    func testResolvedApprovalStaysInTheTranscriptWithItsDecision() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested(summary: "rm -rf x", tool: "bash"))
        s = SessionReducer.reduce(s, approvalResolved(approved: true, by: "orb"))

        // Gone from the OUTSTANDING list — that behaviour is unchanged and must stay unchanged.
        XCTAssertTrue(s.pendingInteractions.isEmpty)
        // But still in scrollback, with what was asked AND what was decided.
        XCTAssertEqual(records(s).count, 1)
        guard let record = records(s).first else { return XCTFail("the resolved approval was deleted from the transcript") }
        XCTAssertEqual(record.callId, "a1")
        XCTAssertEqual(record.ask, .approval(toolName: "bash", summary: "rm -rf x"))
        XCTAssertEqual(record.outcome, .approval(approved: true, by: "orb"))
        XCTAssertFalse(interactionIsPending(record))
    }

    func testResolvedDenialRecordsTheDenial() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested())
        s = SessionReducer.reduce(s, approvalResolved(approved: false, by: "orb"))
        XCTAssertEqual(records(s).first?.outcome, .approval(approved: false, by: "orb"))
    }

    /// The fail-closed timeout is a real, user-visible outcome (`ApprovalBroker`'s
    /// `resolve({approved:false, by:"timeout"})`, `packages/core/src/agent/approvals.ts`) — it must
    /// read as a denial nobody made, not as a denial the user made.
    func testTimedOutApprovalRecordsTimeoutAsItsProvenance() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested())
        s = SessionReducer.reduce(s, approvalResolved(approved: false, by: "timeout"))
        XCTAssertEqual(records(s).first?.outcome, .approval(approved: false, by: "timeout"))
    }

    /// A resolved question keeps the questions it asked AND the answers dict, keyed the way the wire
    /// keys it (by question text) — which is what lets the frozen card mark the chosen option.
    func testResolvedQuestionStaysInTheTranscriptWithItsAnswer() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, questionAsked("Which port?"))
        s = SessionReducer.reduce(s, questionResolved("Which port?", answer: "8080", note: "prod only", by: "orb"))

        XCTAssertTrue(s.pendingInteractions.isEmpty)
        guard let record = records(s).first else { return XCTFail("the resolved question was deleted from the transcript") }
        guard case .question(let questions) = record.ask else { return XCTFail("expected a question ask") }
        XCTAssertEqual(questions.map(\.question), ["Which port?"])
        XCTAssertEqual(questions[0].options.map(\.label), ["3000", "8080"])
        XCTAssertEqual(record.outcome, .question(answers: ["Which port?": "8080"], notes: ["Which port?": "prod only"], by: "orb"))
    }

    /// `question_resolved.notes` is optional on the wire; a note-less resolution must normalize to
    /// an empty dict, never leave the outcome un-recorded.
    func testResolvedQuestionWithoutNotesRecordsEmptyNotes() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, questionAsked())
        s = SessionReducer.reduce(s, questionResolved())
        XCTAssertEqual(records(s).first?.outcome, .question(answers: ["Which port?": "8080"], notes: [:], by: "orb"))
    }

    func testResolvedPlanRecordsApprovalAutoAcceptAndFeedback() {
        var approved = openTurnState()
        approved = SessionReducer.reduce(approved, planPresented())
        approved = SessionReducer.reduce(approved, planResolved(approved: true, autoAccept: true))
        XCTAssertEqual(records(approved).first?.outcome, .plan(approved: true, autoAccept: true, feedback: nil, by: "orb"))

        var changes = openTurnState()
        changes = SessionReducer.reduce(changes, planPresented())
        changes = SessionReducer.reduce(changes, planResolved(approved: false, feedback: "use bun"))
        XCTAssertEqual(records(changes).first?.outcome, .plan(approved: false, autoAccept: false, feedback: "use bun", by: "orb"))
    }

    /// A `turn_completed` no longer wipes the transcript's record of what happened during the turn —
    /// it only empties the OUTSTANDING list. This is the case the old code got wrong twice over:
    /// `resolvePending` deleted the card on resolve, and `turn_completed` deleted whatever survived.
    func testTurnCompletionLeavesResolvedRecordsInPlace() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested())
        s = SessionReducer.reduce(s, approvalResolved(approved: true))
        s = SessionReducer.reduce(s, turnCompleted())
        XCTAssertEqual(records(s).first?.outcome, .approval(approved: true, by: "orb"))
    }

    // MARK: Pending, and the freeze that must follow it

    func testAnUnresolvedAskIsPending() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested())
        XCTAssertNil(records(s).first?.outcome)
        XCTAssertEqual(records(s).first.map(interactionIsPending), true)
        XCTAssertEqual(s.pendingInteractions.map(\.callId), ["a1"])
    }

    /// A turn that ends with an ask still outstanding must FREEZE it, not leave it live. The daemon
    /// has stopped waiting; a card still offering Approve/Deny would be a button that does nothing,
    /// forever, and it would survive every relaunch because the transcript is rebuilt by replay.
    func testTurnCompletionFreezesAnAskThatWasNeverAnswered() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested())
        XCTAssertEqual(records(s).first.map(interactionIsPending), true)

        s = SessionReducer.reduce(s, turnCompleted())
        XCTAssertTrue(s.pendingInteractions.isEmpty)
        XCTAssertEqual(records(s).first?.outcome, .ended)
        XCTAssertEqual(records(s).first.map(interactionIsPending), false)
    }

    /// The same for a turn that DIED. `agent_error` clears the outstanding list too, so it owes the
    /// same stamp — the two clear sites go through one helper precisely so neither can be forgotten.
    func testAgentErrorFreezesAnAskThatWasNeverAnswered() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, questionAsked())
        s = SessionReducer.reduce(s, agentError())
        XCTAssertTrue(s.pendingInteractions.isEmpty)
        XCTAssertEqual(records(s).first?.outcome, .ended)
    }

    /// The invariant, stated with the scope it actually has: for NATIVE asks, an interaction is
    /// pending in the transcript exactly when its callId is still in `pendingInteractions`.
    ///
    /// Deliberately scoped to native asks. A mirrored child ask is exempt on purpose — it stays
    /// pending in the transcript after the parent's turn empties the outstanding list, because the
    /// parent's turn end is no evidence about the child (see `interactionEndsWithItsTurn` and
    /// `testAMirroredChildAskSurvivesTheParentsTurnEndStillPending`). The two sets agreeing was
    /// never the goal; "the card is live iff the daemon is still waiting" is, and for a mirror the
    /// outstanding list is the one that goes wrong.
    func testPendingRecordsAndOutstandingListNeverDisagreeForNativeAsks() {
        var s = openTurnState()
        let stream: [SessionEvent] = [
            approvalRequested(callId: "a1", seq: 3),
            questionAsked(callId: "q1", seq: 4),
            planPresented(callId: "p1", seq: 5),
            approvalResolved(approved: true, callId: "a1", seq: 6),
            questionResolved(callId: "q1", seq: 7),
            turnCompleted(seq: 8),   // p1 was never resolved — the clear must freeze it
        ]
        for event in stream {
            s = SessionReducer.reduce(s, event)
            let pendingInTranscript = Set(records(s).filter(interactionIsPending).map(\.callId))
            XCTAssertEqual(pendingInTranscript, Set(s.pendingInteractions.map(\.callId)),
                           "transcript's pending set diverged from pendingInteractions")
        }
        XCTAssertEqual(records(s).map(\.outcome), [
            .approval(approved: true, by: "orb"),
            .question(answers: ["Which port?": "8080"], notes: [:], by: "orb"),
            .ended,
        ])
    }

    // MARK: The dispatch mirror — a child's ask does not end with the PARENT's turn

    /// A tracked child's `approval_requested` mirrored into the dispatch session's stream, preserving
    /// the child's `threadId: "main"` and carrying `childSessionId` — exactly what
    /// `packages/core/src/agent/dispatch-children.ts`'s `mirror()` emits.
    private func mirroredApprovalRequested(callId: String = "c1", child: String = "sess_child", seq: Int = 3) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","toolName":"bash","summary":"child wants rm","childSessionId":"\#(child)"}"#)
    }
    private func mirroredApprovalResolved(approved: Bool, callId: String = "c1", child: String = "sess_child", by: String = "iphone-gateway", seq: Int = 9) -> SessionEvent {
        ev(#"{"type":"approval_resolved","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","approved":\#(approved),"by":"\#(by)","childSessionId":"\#(child)"}"#)
    }

    /// THE bug this fix round exists for, traced end to end. The parent's turn ending is not
    /// evidence about a child that is designed to still be blocked — the relay is a hub-wide
    /// observer over tracked children with no scoping to the parent's turn. Stamping `.ended` here
    /// wrote "Ended with no response" into a permanent, replay-durable record for an approval the
    /// child was actively waiting on, AND closed the Mac's only door to answering it.
    func testAMirroredChildAskSurvivesTheParentsTurnEndStillPending() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, mirroredApprovalRequested())
        s = SessionReducer.reduce(s, turnCompleted(seq: 4))

        XCTAssertNil(records(s).first?.outcome, "the child is still blocked — nothing has ended")
        XCTAssertEqual(records(s).first.map(interactionIsPending), true,
                       "the card must stay answerable: onApproval already threads childSessionId")
    }

    /// And the resolution that arrives afterwards — minutes later, after any number of parent turns —
    /// still lands, because the record was never frozen shut.
    func testAMirroredChildResolutionArrivingAfterTheParentsTurnStillLands() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, mirroredApprovalRequested())
        s = SessionReducer.reduce(s, turnCompleted(seq: 4))
        // A whole further parent turn runs and ends while the child sits blocked.
        s = SessionReducer.reduce(s, userMessage("carry on", seq: 5))
        s = SessionReducer.reduce(s, turnStarted(seq: 6))
        s = SessionReducer.reduce(s, turnCompleted(seq: 7))

        s = SessionReducer.reduce(s, mirroredApprovalResolved(approved: true, seq: 9))
        XCTAssertEqual(records(s).first?.outcome, .approval(approved: true, by: "iphone-gateway"))
    }

    /// Belt-and-braces on the same class: even if a record HAS been stamped `.ended`, a real
    /// resolution must overwrite it. `.ended` is a local inference this app draws from its own turn
    /// ending; the daemon reporting what actually happened outranks a guess that nothing would.
    func testARealResolutionOverwritesTheLocalEndedInference() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested())     // native — DOES get stamped
        s = SessionReducer.reduce(s, agentError(seq: 4))
        XCTAssertEqual(records(s).first?.outcome, .ended)

        // The broker's fail-closed timeout fires after the turn died.
        s = SessionReducer.reduce(s, approvalResolved(approved: false, by: "timeout", seq: 5))
        XCTAssertEqual(records(s).first?.outcome, .approval(approved: false, by: "timeout"),
                       "the daemon's truth must replace the app's guess")
    }

    /// …but that permission is scoped to `.ended` alone. A real outcome is still first-wins, so the
    /// record of what the user chose can never be rewritten.
    func testTheOverwritePermissionIsScopedToEndedAlone() {
        XCTAssertTrue(interactionOutcomeMayBeReplaced(current: nil, with: .approval(approved: true, by: "orb")))
        XCTAssertTrue(interactionOutcomeMayBeReplaced(current: .ended, with: .approval(approved: true, by: "orb")))
        XCTAssertFalse(interactionOutcomeMayBeReplaced(current: .ended, with: .ended))
        XCTAssertFalse(interactionOutcomeMayBeReplaced(current: .approval(approved: true, by: "orb"), with: .ended),
                       "a late turn end must never erase a real decision")
        XCTAssertFalse(interactionOutcomeMayBeReplaced(current: .approval(approved: true, by: "orb"),
                                                       with: .approval(approved: false, by: "timeout")))
    }

    /// The exemption is keyed on `childSessionId`, which is exactly what distinguishes a mirrored
    /// ask from a native one on the wire.
    func testOnlyMirroredAsksAreExemptFromTheTurnEndStamp() {
        let ask = InteractionRecord.Ask.approval(toolName: "bash", summary: "rm x")
        XCTAssertTrue(interactionEndsWithItsTurn(InteractionRecord(callId: "a1", ask: ask)))
        XCTAssertFalse(interactionEndsWithItsTurn(InteractionRecord(callId: "c1", ask: ask, childSessionId: "sess_child")))
    }

    /// Mirrored QUESTIONS take the same path — `dispatch-children.ts` mirrors `question_asked`/
    /// `question_resolved` identically. (`plan_presented` is not mirrored at all.)
    func testAMirroredChildQuestionIsAlsoExempt() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, ev(#"""
        {"type":"question_asked","seq":3,"sessionId":"s","ts":0,"threadId":"main","callId":"cq1","questions":[{"question":"Which port?","header":"Port","options":[{"label":"3000"},{"label":"8080"}],"multiSelect":false}],"childSessionId":"sess_child"}
        """#))
        s = SessionReducer.reduce(s, turnCompleted(seq: 4))
        XCTAssertNil(records(s).first?.outcome)

        s = SessionReducer.reduce(s, ev(#"""
        {"type":"question_resolved","seq":9,"sessionId":"s","ts":0,"threadId":"main","callId":"cq1","answers":{"Which port?":"8080"},"by":"iphone-gateway","childSessionId":"sess_child"}
        """#))
        XCTAssertEqual(records(s).first?.outcome, .question(answers: ["Which port?": "8080"], notes: [:], by: "iphone-gateway"))
    }

    // MARK: The scan is unbounded — a far-back ask must not stay clickable forever

    /// A native ask sitting more than a few exchanges back must STILL be stamped when its turn ends.
    /// The stamp used to go through a depth-4 scan while `pendingInteractions` was emptied
    /// unbounded, so the stamped set was a strict subset of the cleared set — and on a miss the card
    /// kept live Approve/Deny buttons forever, which is the exact failure `.ended` exists to
    /// prevent. Six exchanges deep: comfortably past the old bound.
    func testAnAskManyExchangesBackIsStillFrozenWhenItsTurnEnds() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested(seq: 3))
        // Six steer-opened exchanges pile up on top of it (each needs a reply first, or the
        // userMessage folds into the open exchange instead of opening a new one).
        var seq = 4
        for i in 0..<6 {
            s = SessionReducer.reduce(s, ev(#"{"type":"assistant_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","text":"round \#(i)"}"#))
            seq += 1
            s = SessionReducer.reduce(s, userMessage("more \(i)", seq: seq))
            seq += 1
        }
        XCTAssertGreaterThan(s.exchanges.count, 5)

        s = SessionReducer.reduce(s, turnCompleted(seq: seq))
        XCTAssertTrue(s.pendingInteractions.isEmpty)
        XCTAssertEqual(records(s).first?.outcome, .ended,
                       "the stamp must reach as far back as the clear does")
        XCTAssertEqual(records(s).first.map(interactionIsPending), false)
    }

    /// The same bound governed the replay-dedupe: a re-seen ask beyond the window appended a SECOND,
    /// permanently-pending card for one callId.
    func testAFarBackAskIsStillDedupedOnReplay() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested(seq: 3))
        var seq = 4
        for i in 0..<6 {
            s = SessionReducer.reduce(s, ev(#"{"type":"assistant_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","text":"round \#(i)"}"#))
            seq += 1
            s = SessionReducer.reduce(s, userMessage("more \(i)", seq: seq))
            seq += 1
        }
        s = SessionReducer.reduce(s, approvalRequested(seq: seq))
        XCTAssertEqual(records(s).count, 1, "one ask, one card, however far back it sits")
    }

    // MARK: Fold mechanics

    /// A duplicated `approval_requested` (a replay re-seeing the log) must not append a second card —
    /// the same replay guard `appendPending` already applies to the outstanding list. Pinned AFTER
    /// the resolution because that is the case `appendActivity`'s adjacent-dupe collapse cannot
    /// catch: the re-seen record differs from the folded one, so value equality would let it through.
    func testDuplicateAskAfterResolutionDoesNotAppendASecondCard() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested(seq: 3))
        s = SessionReducer.reduce(s, approvalResolved(approved: true, seq: 4))
        s = SessionReducer.reduce(s, approvalRequested(seq: 5))
        XCTAssertEqual(records(s).count, 1)
        XCTAssertEqual(records(s).first?.outcome, .approval(approved: true, by: "orb"))
    }

    /// First-resolution-wins, matching the daemon's own brokers (`ApprovalBroker.resolve` returns
    /// `alreadyResolved` rather than re-resolving). A late duplicate must not rewrite the record of
    /// what the user actually chose.
    func testASecondResolutionDoesNotOverwriteTheFirst() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested())
        s = SessionReducer.reduce(s, approvalResolved(approved: true, by: "orb", seq: 4))
        s = SessionReducer.reduce(s, approvalResolved(approved: false, by: "timeout", seq: 5))
        XCTAssertEqual(records(s).first?.outcome, .approval(approved: true, by: "orb"))
    }

    /// A resolution whose ask straddled an exchange boundary still lands. A main-thread steer's
    /// `user_message` is persisted at SEND time, so it can open a NEW exchange between the ask and
    /// its answer — the same case `foldToolResult` scans backwards for.
    func testResolutionFoldsIntoAnEarlierExchangeWhenASteerOpenedANewOne() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested(seq: 3))
        // A reply lands, so the next user_message opens a fresh exchange rather than folding in.
        s = SessionReducer.reduce(s, ev(#"{"type":"assistant_message","seq":4,"sessionId":"s","ts":0,"threadId":"main","text":"thinking"}"#))
        s = SessionReducer.reduce(s, userMessage("also do y", seq: 5))
        XCTAssertEqual(s.exchanges.count, 2)

        s = SessionReducer.reduce(s, approvalResolved(approved: true, seq: 6))
        XCTAssertEqual(s.exchanges[0].activity.compactMap(\.interactionRecord).first?.outcome,
                       .approval(approved: true, by: "orb"))
    }

    /// A `*_resolved` for a callId this transcript never saw is a no-op, not a crash and not a
    /// phantom record. Reachable in normal use: the resolve cases are deliberately not thread-gated,
    /// so a CHILD thread's own resolution reaches this reducer.
    func testResolutionForAnUnknownCallIdIsANoOp() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested(callId: "a1"))
        s = SessionReducer.reduce(s, approvalResolved(approved: true, callId: "somebody-elses", seq: 4))
        XCTAssertEqual(records(s).first?.outcome, nil)
        XCTAssertEqual(records(s).count, 1)
    }

    /// The card is the ONLY door to answering now that the pinned band is gone, so an ask arriving
    /// before any `user_message` must open an exchange to live in rather than being dropped by
    /// `appendActivity`'s "no open exchange → drop" rule. Dropping it would make the ask both
    /// invisible and unanswerable.
    func testAnAskWithNoOpenExchangeOpensOneRatherThanBeingDropped() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, approvalRequested())
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.exchanges[0].prompt, "")
        XCTAssertEqual(records(s).count, 1)
        XCTAssertEqual(records(s).first?.callId, "a1")
    }

    // MARK: Derived summary

    /// `summary` is derived from the ask rather than stored beside it, so it can never describe a
    /// different ask than the one it sits on. These are the three strings the pre-Task-3 reducer
    /// stored — the fallback activity line reads the same words it always did.
    func testSummaryIsDerivedFromTheAsk() {
        XCTAssertEqual(InteractionRecord(callId: "a", ask: .approval(toolName: "bash", summary: "rm -rf x")).summary, "rm -rf x")
        XCTAssertEqual(InteractionRecord(callId: "p", ask: .plan(plan: "the plan")).summary, "plan presented")
        var s = openTurnState()
        s = SessionReducer.reduce(s, questionAsked("Which port?"))
        XCTAssertEqual(records(s).first?.summary, "Which port?")
    }

    /// A question ask with no questions at all cannot come off the wire (the schema requires
    /// `.min(1)`), but `summary` must still name something rather than render an empty line.
    func testSummaryOfAnEmptyQuestionAskFallsBackToAWord() {
        XCTAssertEqual(InteractionRecord(callId: "q", ask: .question(questions: [])).summary, "question")
    }
}
