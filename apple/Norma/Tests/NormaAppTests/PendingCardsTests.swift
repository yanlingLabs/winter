import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Task 2 (2d-iii): the two PURE helpers behind the pending-interaction cards —
/// `questionAnswers(for:selections:otherTexts:)` (UI selection state → the answers dict the
/// daemon expects) and `cardTitle(_:)` (per-kind header text). Views themselves aren't rendered
/// here (nothing mounts `PendingCardsView` yet — that's Task 3); this only locks down the pure
/// mapping logic, same convention as `ActivityRowTests`/`PendingInteractionTests`.
final class PendingCardsTests: XCTestCase {
    /// Builds `[SessionEvent.Question]` the same wire-shaped-JSON way `PendingInteractionTests`
    /// does — `Question`/`QuestionOption` are cross-module `Codable` structs with no public
    /// memberwise initializer.
    func questions(_ json: String) -> [SessionEvent.Question] {
        try! JSONDecoder().decode([SessionEvent.Question].self, from: Data(json.utf8))
    }

    func testQuestionAnswersSingleSelect() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null},{"label":"MySQL","description":null}],"multiSelect":false}]"#)
        let answers = questionAnswers(for: qs, selections: [0: [0]], otherTexts: [:])
        XCTAssertEqual(answers, ["Which db?": "Postgres"])
    }

    func testQuestionAnswersMultiSelectJoins() {
        let qs = questions(#"[{"question":"Which ports?","header":"Ports","options":[{"label":"80","description":null},{"label":"443","description":null},{"label":"8080","description":null}],"multiSelect":true}]"#)
        let answers = questionAnswers(for: qs, selections: [0: [0, 2]], otherTexts: [:])
        XCTAssertEqual(answers, ["Which ports?": "80, 8080"])
    }

    func testOtherTextWinsOverSelection() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null},{"label":"MySQL","description":null}],"multiSelect":false}]"#)
        let answers = questionAnswers(for: qs, selections: [0: [0]], otherTexts: [0: "SQLite"])
        XCTAssertEqual(answers, ["Which db?": "SQLite"])
    }

    func testAnswersKeyedByQuestionText() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null},{"label":"MySQL","description":null}],"multiSelect":false},{"question":"Which port?","header":"Port","options":[{"label":"80","description":null},{"label":"443","description":null}],"multiSelect":false}]"#)
        let answers = questionAnswers(for: qs, selections: [0: [0], 1: [1]], otherTexts: [:])
        XCTAssertEqual(answers, ["Which db?": "Postgres", "Which port?": "443"])
        XCTAssertEqual(answers.count, 2)
    }

    func testQuestionAnswersCountReflectsPartialAnswers() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false},{"question":"Which port?","header":"Port","options":[{"label":"80","description":null}],"multiSelect":false}]"#)
        let partial = questionAnswers(for: qs, selections: [0: [0]], otherTexts: [:])
        XCTAssertEqual(partial.count, 1)
        XCTAssertLessThan(partial.count, qs.count)

        let full = questionAnswers(for: qs, selections: [0: [0], 1: [0]], otherTexts: [:])
        XCTAssertEqual(full.count, qs.count)
    }

    // MARK: - questionCardComplete (whole-card Submit gate)

    func testQuestionCardCompleteFalseWhenUnanswered() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionCardComplete(questions: qs, selections: [:], otherTexts: [:]))
    }

    func testQuestionCardCompleteFalseWhenPartiallyAnswered() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false},{"question":"Which port?","header":"Port","options":[{"label":"80","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionCardComplete(questions: qs, selections: [0: [0]], otherTexts: [:]))
    }

    func testQuestionCardCompleteTrueWhenAllAnsweredBySelection() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false},{"question":"Which port?","header":"Port","options":[{"label":"80","description":null}],"multiSelect":false}]"#)
        XCTAssertTrue(questionCardComplete(questions: qs, selections: [0: [0], 1: [0]], otherTexts: [:]))
    }

    func testQuestionCardCompleteTrueWhenAnsweredByOtherText() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertTrue(questionCardComplete(questions: qs, selections: [:], otherTexts: [0: "SQLite"]))
    }

    func testQuestionCardCompleteFalseWhenOtherTextIsWhitespaceOnly() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionCardComplete(questions: qs, selections: [:], otherTexts: [0: "   "]))
    }

    func testQuestionCardCompleteSingleQuestionMatchesOneAnswerGate() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionCardComplete(questions: qs, selections: [:], otherTexts: [:]))
        XCTAssertTrue(questionCardComplete(questions: qs, selections: [0: [0]], otherTexts: [:]))
    }

    // MARK: - questionNotes (Task 4: CC AskUserQuestion parity — per-question notes)

    func testQuestionNotesOmitsEmptyAndWhitespaceOnly() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false},{"question":"Which port?","header":"Port","options":[{"label":"80","description":null}],"multiSelect":false}]"#)
        let notes = questionNotes(for: qs, notes: [0: "prefer the managed one", 1: "   "])
        XCTAssertEqual(notes, ["Which db?": "prefer the managed one"])
    }

    func testQuestionNotesKeyedByQuestionTextLikeAnswers() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        let notes = questionNotes(for: qs, notes: [0: "  a note  "])
        XCTAssertEqual(notes, ["Which db?": "a note"])
    }

    func testQuestionNotesEmptyWhenNoNotesGiven() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertEqual(questionNotes(for: qs, notes: [:]), [:])
    }

    func testQuestionNotesNeverGateSubmit() {
        // A note alone (no answer) does NOT satisfy questionCardComplete — notes ride alongside
        // an answer, they never substitute for one.
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionCardComplete(questions: qs, selections: [:], otherTexts: [:]))
        // (the note itself isn't threaded through questionCardComplete at all — it takes no notes
        // param — which is the point: there is no way for a note to affect the gate.)
    }

    // MARK: - questionShowsPreviewPane / questionFocusedPreview (Task 4: side-by-side preview)

    func testSingleSelectWithPreviewsShowsPreviewPane() {
        let qs = questions(#"[{"question":"Which scheme?","header":"Scheme","options":[{"label":"Light","description":null,"preview":"bg: #fff"},{"label":"Dark","description":null,"preview":"bg: #000"}],"multiSelect":false}]"#)
        XCTAssertTrue(questionShowsPreviewPane(qs[0]))
    }

    func testFocusedPreviewUsesSelectedOption() {
        let qs = questions(#"[{"question":"Which scheme?","header":"Scheme","options":[{"label":"Light","description":null,"preview":"bg: #fff"},{"label":"Dark","description":null,"preview":"bg: #000"}],"multiSelect":false}]"#)
        XCTAssertEqual(questionFocusedPreview(qs[0], selected: [1]), "bg: #000")
    }

    func testFocusedPreviewFallsBackToFirstOptionWhenNoneSelected() {
        let qs = questions(#"[{"question":"Which scheme?","header":"Scheme","options":[{"label":"Light","description":null,"preview":"bg: #fff"},{"label":"Dark","description":null,"preview":"bg: #000"}],"multiSelect":false}]"#)
        XCTAssertEqual(questionFocusedPreview(qs[0], selected: []), "bg: #fff")
    }

    func testQuestionWithNoPreviewsDoesNotShowPreviewPane() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null},{"label":"MySQL","description":null}],"multiSelect":false}]"#)
        XCTAssertFalse(questionShowsPreviewPane(qs[0]))
        XCTAssertNil(questionFocusedPreview(qs[0], selected: [0]))
    }

    func testMultiSelectQuestionIgnoresPreviewsEvenWhenPresent() {
        let qs = questions(#"[{"question":"Which ports?","header":"Ports","options":[{"label":"80","description":null,"preview":"http"},{"label":"443","description":null,"preview":"https"}],"multiSelect":true}]"#)
        XCTAssertFalse(questionShowsPreviewPane(qs[0]))
        XCTAssertNil(questionFocusedPreview(qs[0], selected: [0, 1]))
    }

    func testFocusedPreviewIgnoresOutOfRangeSelection() {
        let qs = questions(#"[{"question":"Which scheme?","header":"Scheme","options":[{"label":"Light","description":null,"preview":"bg: #fff"}],"multiSelect":false}]"#)
        // A stale/out-of-range selection index falls back to the first option rather than crashing.
        XCTAssertEqual(questionFocusedPreview(qs[0], selected: [5]), "bg: #fff")
    }

    func testCardTitles() {
        let approval = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x")
        XCTAssertEqual(cardTitle(approval), "Approval needed — bash")

        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres","description":null},{"label":"MySQL","description":null}],"multiSelect":false}]"#)
        let question = PendingInteraction.question(callId: "q1", questions: qs)
        XCTAssertEqual(cardTitle(question), "DB")

        let plan = PendingInteraction.plan(callId: "p1", plan: "the plan")
        XCTAssertEqual(cardTitle(plan), "Plan for approval")
    }

    // MARK: - capReviewerReason (Phase 5e T5: reviewer-rationale card line)

    func testCapReviewerReasonPassesShortReasonThrough() {
        XCTAssertEqual(capReviewerReason("recursive delete outside the session cwd"), "recursive delete outside the session cwd")
    }

    func testCapReviewerReasonStripsNewlines() {
        // Defensive second pass: the wire value is already newline-stripped at emission
        // (engine.ts's sanitizeReviewText), but this must not trust that blindly.
        XCTAssertEqual(capReviewerReason("line one\nline two\r\nline three"), "line one line two line three")
    }

    func testCapReviewerReasonTruncatesLongReasonWithEllipsis() {
        let longReason = String(repeating: "x", count: 250)
        let capped = capReviewerReason(longReason)
        XCTAssertTrue(capped.count <= 101, "capped text (100 chars + ellipsis) must not carry the full 250-char reason")
        XCTAssertTrue(capped.hasSuffix("…"))
        XCTAssertFalse(capped.contains(longReason))
    }

    func testCapReviewerReasonExactlyAtThresholdIsUnchanged() {
        let atThreshold = String(repeating: "y", count: 100)
        XCTAssertEqual(capReviewerReason(atThreshold), atThreshold, "exactly at the cap must not gain a trailing ellipsis")
    }

    // MARK: - PendingInteraction.approval reviewerReason threading (enum shape)

    func testApprovalReviewerReasonDefaultsNilAndIsPreservedWhenSet() {
        let withoutReason = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x")
        guard case .approval(_, _, _, let reviewerReason, _, _) = withoutReason else { return XCTFail("expected .approval") }
        XCTAssertNil(reviewerReason)

        let withReason = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x", reviewerReason: "reviewer says no")
        guard case .approval(_, _, _, let reviewerReason2, _, _) = withReason else { return XCTFail("expected .approval") }
        XCTAssertEqual(reviewerReason2, "reviewer says no")
    }

    // MARK: - PendingInteraction childSessionId threading (Dispatch, Phase 7)

    func testApprovalAndQuestionChildSessionIdDefaultsNilAndIsPreservedWhenSet() {
        let nativeApproval = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x")
        guard case .approval(_, _, _, _, let childId, _) = nativeApproval else { return XCTFail("expected .approval") }
        XCTAssertNil(childId)

        let relayedApproval = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x", childSessionId: "child_1")
        guard case .approval(_, _, _, _, let childId2, _) = relayedApproval else { return XCTFail("expected .approval") }
        XCTAssertEqual(childId2, "child_1")

        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"A","description":null}],"multiSelect":false}]"#)
        let relayedQuestion = PendingInteraction.question(callId: "q1", questions: qs, childSessionId: "child_2")
        guard case .question(_, _, let questionChildId) = relayedQuestion else { return XCTFail("expected .question") }
        XCTAssertEqual(questionChildId, "child_2")
    }
}
