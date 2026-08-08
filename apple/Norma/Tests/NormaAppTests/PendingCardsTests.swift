import XCTest
import SwiftUI
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

    // MARK: - approvalAdditionalOptions (working-directories T7/T8: the quiet row's contents)

    /// Same `[SessionEvent.ApprovalOption]` construction trick as `questions(_:)` above — the type
    /// is a cross-module `Codable` struct with no public memberwise initializer.
    func options(_ json: String) -> [SessionEvent.ApprovalOption] {
        try! JSONDecoder().decode([SessionEvent.ApprovalOption].self, from: Data(json.utf8))
    }

    /// The with-dirs dirGrant card, verbatim from the daemon (engine.ts, T6.5): FOUR options, of
    /// which `allow_add_dir` carries NO `rule` — it adopts a directory into the session's working
    /// set rather than persisting a permission rule. The old `rule != nil` filter dropped exactly
    /// that one, making the app's only fence-widening card option unreachable.
    func testDirGrantAllowAddDirReachesTheQuietRow() {
        let dirGrant = options(#"""
        [{"id":"allow_once","label":"Allow once","rule":null,"scope":null},
         {"id":"allow_add_dir","label":"Allow and add as working directory","rule":null,"scope":null},
         {"id":"allow_project","label":"Allow Write(/repo/**) in this project","rule":"Write(/repo/**)","scope":"project"},
         {"id":"deny","label":"Deny","rule":null,"scope":null}]
        """#)
        XCTAssertEqual(approvalAdditionalOptions(dirGrant).map(\.id), ["allow_add_dir", "allow_project"],
                       "every option except the two the primary buttons already are")
    }

    /// The pre-existing rule-bearing shapes are untouched — the widening is additive, and the
    /// primary Approve/Deny row keeps its exact contents.
    func testRuleBearingOptionsAreUnchangedAndPrimariesNeverDuplicate() {
        let ruleOnly = options(#"""
        [{"id":"allow_once","label":"Allow once","rule":null,"scope":null},
         {"id":"allow_project","label":"Allow Bash(ls:*) in this project","rule":"Bash(ls:*)","scope":"project"},
         {"id":"allow_global","label":"Allow Bash(ls:*) everywhere","rule":"Bash(ls:*)","scope":"global"},
         {"id":"deny","label":"Deny","rule":null,"scope":null}]
        """#)
        XCTAssertEqual(approvalAdditionalOptions(ruleOnly).map(\.id), ["allow_project", "allow_global"])

        XCTAssertEqual(approvalAdditionalOptions(options(#"[{"id":"allow_once","label":"Allow once","rule":null,"scope":null},{"id":"deny","label":"Deny","rule":null,"scope":null}]"#)), [],
                       "a card carrying only the two primaries renders no quiet row at all")
        XCTAssertEqual(approvalAdditionalOptions(nil), [], "no options at all is the pre-T6 card, byte-identical")
    }

    // MARK: - panel-shell T10b: PendingCardDraft — the hoisted, externally-owned per-card answer
    //
    // Mirrors `FieldStateAdapter.composerDraft`'s precedent: `PendingQuestionBody`/
    // `PendingPlanBody` used to hold a question/plan card's typed-but-unsubmitted answer as
    // view-local `@State`, destroyed whenever `ShellRootView`'s `detail` subtree is torn down and
    // rebuilt (the panel's `.maximized` toggle — see `ShellSidebar.swift`'s own comment on the
    // `if mode != .maximized` branch). Mutation now lives on `PendingCardDraft` itself, not buried
    // in view closures, so the mutual-exclusion rules (selecting an option clears that question's
    // Other text, and typing Other text clears that question's selection) are independently
    // unit-testable without mounting any view — the same "PURE logic, tested directly" convention
    // this whole file already follows for `questionAnswers`/`questionCardComplete` etc. above.
    //
    // `PendingCardDraft` itself is a brand-new type as of this task — every test below fails to
    // compile against unmodified code (`Cannot find 'PendingCardDraft' in scope`), which is the
    // RED evidence for this half of the fix (Task 10's own TDD evidence in
    // `task-10-report.md` establishes a "cannot find X in scope" compile failure as legitimate RED
    // in this plan; runtime RED is unreachable here pre-fix because `PendingQuestionBody`/
    // `PendingPlanBody` are `private` to `PendingCards.swift` today — see the Mirror-based tests
    // further below, and this file's own task-10b report for the full reasoning).

    func testSelectSingleClearsThatQuestionsOtherText() {
        var draft = PendingCardDraft()
        draft.otherTexts[0] = "typed something"
        draft.selectSingle(1, forQuestion: 0)
        XCTAssertEqual(draft.selections[0], [1])
        XCTAssertEqual(draft.otherTexts[0], "", "selecting an option clears that question's Other text")
    }

    func testToggleMultiAddsAndRemovesClearingOtherTextEachTime() {
        var draft = PendingCardDraft()
        draft.otherTexts[0] = "typed something"
        draft.toggleMulti(1, forQuestion: 0)
        XCTAssertEqual(draft.selections[0], [1])
        XCTAssertEqual(draft.otherTexts[0], "", "toggling an option on also clears Other text")

        draft.otherTexts[0] = "typed again"
        draft.toggleMulti(2, forQuestion: 0)
        XCTAssertEqual(draft.selections[0], [1, 2])

        draft.toggleMulti(1, forQuestion: 0)
        XCTAssertEqual(draft.selections[0], [2], "toggling an already-selected option removes it")
    }

    func testSetOtherTextClearsThatQuestionsSelection() {
        var draft = PendingCardDraft()
        draft.selections[0] = [1]
        draft.setOtherText("SQLite", forQuestion: 0)
        XCTAssertEqual(draft.otherTexts[0], "SQLite")
        XCTAssertEqual(draft.selections[0], [], "typing Other text clears that question's selection")
    }

    func testExpandOtherOnlyAffectsTheGivenQuestion() {
        var draft = PendingCardDraft()
        draft.expandOther(forQuestion: 1)
        XCTAssertEqual(draft.otherExpanded, [1])
        XCTAssertFalse(draft.otherExpanded.contains(0))
    }

    func testSetNoteIsIndependentOfSelectionAndOtherText() {
        var draft = PendingCardDraft()
        draft.selections[0] = [1]
        draft.setNote("prefer the managed one", forQuestion: 0)
        XCTAssertEqual(draft.notes[0], "prefer the managed one")
        XCTAssertEqual(draft.selections[0], [1], "a note never disturbs the selection")
    }

    /// The per-question dictionaries are genuinely keyed by question index — a mutation on one
    /// question in a multi-question card must never leak onto another's entry. (Self-caught while
    /// running this test for the first time: an earlier draft of it asserted `nil` on the SAME
    /// question each call had just cleared as its own mutual-exclusion side effect — e.g.
    /// `selectSingle(forQuestion: 0)` legitimately leaves `otherTexts[0] == ""`, not absent — which
    /// is correct behavior, not cross-contamination. Rewritten to check question 1 BEFORE it is
    /// ever touched, and question 0's earlier answer AFTER a later mutation on question 1.)
    func testMutationsOnOneQuestionNeverTouchAnother() {
        var draft = PendingCardDraft()
        draft.selectSingle(0, forQuestion: 0)
        XCTAssertEqual(draft.selections[0], [0])
        XCTAssertNil(draft.selections[1], "a mutation on question 0 must never create an entry for question 1")
        XCTAssertNil(draft.otherTexts[1])

        draft.setOtherText("custom", forQuestion: 1)
        XCTAssertEqual(draft.otherTexts[1], "custom")
        XCTAssertEqual(draft.selections[0], [0], "question 0's earlier answer survives a later mutation on question 1")
    }

    /// The plan card's own two fields — independent of the question fields above (a `PendingCardDraft`
    /// is one shape shared by both card kinds; `PendingPlanBody` only ever touches these two).
    func testPlanDraftFieldsDefaultEmptyAndAreIndependentlySettable() {
        var draft = PendingCardDraft()
        XCTAssertFalse(draft.isRequestingChanges)
        XCTAssertEqual(draft.feedback, "")
        draft.isRequestingChanges = true
        draft.feedback = "use postgres instead"
        XCTAssertTrue(draft.isRequestingChanges)
        XCTAssertEqual(draft.feedback, "use postgres instead")
    }

    // MARK: - panel-shell T10b: FieldStateAdapter.pendingCardDraftBinding — the survive-teardown proof

    /// The direct proof of the actual requirement: an in-progress answer, written through the
    /// EXACT mechanism the real view will use (`adapter.pendingCardDraftBinding(for:)`, mirroring
    /// `FieldStateAdapter.draftBinding` for the composer), must still be there when a SECOND,
    /// independently-constructed Binding is pulled from the SAME adapter — which is precisely what
    /// happens when `ShellRootView` rebuilds `detail` (and so `PendingCardsView` → `PendingCard` →
    /// `PendingQuestionBody`) after leaving `.maximized`: a brand-new view struct, the same
    /// long-lived `FieldStateAdapter` underneath it (`WindowContentView`'s `@ObservedObject var
    /// adapter`, itself owned by `ShellSessionAttachment`, outside `detail` entirely).
    @MainActor
    func testPendingCardDraftSurvivesSimulatedViewReconstruction() {
        let adapter = FieldStateAdapter(session: SessionModel())
        // Simulate the FIRST PendingQuestionBody instance: the user types Other text — exactly
        // what its onOtherTextChange closure does once wired to `pendingCardDraftBinding(for:)`.
        adapter.pendingCardDraftBinding(for: "q1").wrappedValue.setOtherText("SQLite", forQuestion: 0)

        // Simulate `.maximized` tearing `detail` down and `ShellRootView` rebuilding a BRAND NEW
        // PendingQuestionBody when the panel returns to `.side` — a fresh Binding pulled from the
        // SAME adapter, exactly what WindowContentView's call site constructs on every re-render.
        let rebuilt = adapter.pendingCardDraftBinding(for: "q1")

        XCTAssertEqual(rebuilt.wrappedValue.otherTexts[0], "SQLite",
                       "typed-but-unsubmitted card input must survive the view being torn down and rebuilt")
    }

    /// `pendingInteractions` is a LIST — more than one card can be open — so drafts must be kept
    /// strictly per-callId, never shared or cross-contaminated.
    @MainActor
    func testPendingCardDraftIsPerCallIdNeverSharedAcrossCards() {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.pendingCardDraftBinding(for: "q1").wrappedValue.setOtherText("A", forQuestion: 0)
        adapter.pendingCardDraftBinding(for: "q2").wrappedValue.setOtherText("B", forQuestion: 0)
        XCTAssertEqual(adapter.pendingCardDraftBinding(for: "q1").wrappedValue.otherTexts[0], "A")
        XCTAssertEqual(adapter.pendingCardDraftBinding(for: "q2").wrappedValue.otherTexts[0], "B")
    }

    /// A callId with no draft yet reads as a fresh, empty `PendingCardDraft()` — never a crash or
    /// an implicit optional the view would have to unwrap.
    @MainActor
    func testPendingCardDraftBindingDefaultsEmptyForAnUnseenCallId() {
        let adapter = FieldStateAdapter(session: SessionModel())
        XCTAssertEqual(adapter.pendingCardDraftBinding(for: "never-seen").wrappedValue, PendingCardDraft())
    }

    // MARK: - panel-shell T10b: PendingQuestionBody / PendingPlanBody hold no view-local @State
    //
    // Structural regression guard, the same technique as `AppShellTests.
    // testNewChatPageDraftIsNotViewLocalState`: construct the view directly (a plain struct init —
    // no `.body` ever evaluated) and inspect its stored properties via `Mirror`, which reflects
    // the compiler-synthesized backing storage for any `@State` property regardless of Swift's
    // compile-time access control. UNLIKE that test, this pair can only compile once
    // `PendingQuestionBody`/`PendingPlanBody` stop being `private` to `PendingCards.swift` and
    // accept the externally-owned `draft` Binding — so today, the whole file fails to compile
    // against these two ("'PendingQuestionBody' initializer is inaccessible due to 'private'
    // protection level"), which IS this pair's RED evidence; a genuine pre-fix RUNTIME failure is
    // unreachable (there is nothing constructible to reflect on). Once fixed, this becomes a
    // permanent tripwire: a future edit that reintroduces even one local `@State` var on either
    // view (bypassing the externally-owned draft) fails the suite forever after.
    /// Catches BOTH `@State` (`"State<...>"`) and `@StateObject` (`"StateObject<...>"`) — a locally
    /// OWNED reference-type store would be the identical bug in a different property-wrapper
    /// costume (still destroyed on `detail`'s teardown; SwiftUI-owned storage keyed to view
    /// identity either way). The two checks are independent substring tests rather than one
    /// `.contains("State")`, so this never accidentally flags an unrelated type that merely
    /// contains the letters "State" somewhere in its name (`OrbSessionState`, etc.).
    private func hasAnyStateBackedStorage<T>(_ value: T) -> Bool {
        Mirror(reflecting: value).children.contains {
            let typeName = String(describing: type(of: $0.value))
            return typeName.contains("State<") || typeName.contains("StateObject<")
        }
    }

    @MainActor
    func testPendingQuestionBodyHoldsNoViewLocalState() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"A","description":null}],"multiSelect":false}]"#)
        var stored = PendingCardDraft()
        let binding = Binding<PendingCardDraft>(get: { stored }, set: { stored = $0 })
        let view = PendingQuestionBody(callId: "q1", questions: qs, childSessionId: nil, isInFlight: false,
                                        onQuestion: { _, _, _, _ in }, draft: binding)
        XCTAssertFalse(hasAnyStateBackedStorage(view),
            "PendingQuestionBody must hold no view-local @State for the answer — it must read/write " +
            "through the externally-owned `draft` Binding so an in-progress answer survives detail's " +
            ".maximized teardown")
    }

    @MainActor
    func testPendingPlanBodyHoldsNoViewLocalState() {
        var stored = PendingCardDraft()
        let binding = Binding<PendingCardDraft>(get: { stored }, set: { stored = $0 })
        let view = PendingPlanBody(callId: "p1", plan: "the plan", isInFlight: false,
                                    onPlan: { _, _, _, _ in }, draft: binding)
        XCTAssertFalse(hasAnyStateBackedStorage(view),
            "PendingPlanBody must hold no view-local @State for its feedback — same externally-owned " +
            "draft requirement as PendingQuestionBody")
    }
}
