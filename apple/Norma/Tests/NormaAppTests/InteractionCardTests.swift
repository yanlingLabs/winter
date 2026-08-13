import XCTest
import NormaProtocol
@testable import Norma

/// mac-chat-parity Task 3 — the VIEW half of "cards inline, permanent, and correct": the pure
/// decisions `TranscriptInteractionCard` and its bodies branch on.
///
/// **What this file does NOT cover.** It mounts no view and renders no pixels. It pins the
/// *decisions* — which glyph, which chrome, which options a recorded answer names, which words a
/// verdict gets — not their appearance. Whether the accent fill is actually visible against the
/// card's material, whether the selected border reads at 1.5pt on a Retina panel, whether a frozen
/// card is genuinely unclickable when the pointer is over it: those are the user's live gate, and
/// nothing here should be read as evidence about them. What CAN be established without pixels is
/// that a frozen card has no interactive affordance to click — see
/// `testFrozenBodiesContainNoInteractiveAffordance`, and its own doc for what that proof is worth.
final class InteractionCardTests: XCTestCase {

    /// A bad fixture is a RED, not a runner abort — see `ActivityCaptureTests.ev` for why this is
    /// fail-and-substitute rather than `XCTUnwrap` in a `throws` helper (whole-branch review, M-9).
    /// The fallback is deliberately ONE element, not empty: every caller here subscripts `[0]`, and
    /// an empty array would trade the decode crash for an index crash — the same runner abort by
    /// another route.
    private func questions(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> [SessionEvent.Question] {
        do {
            return try JSONDecoder().decode([SessionEvent.Question].self, from: Data(json.utf8))
        } catch {
            XCTFail("undecodable Question fixture: \(error)\n\(json)", file: file, line: line)
            return [.init(question: "", header: nil, options: [], multiSelect: false)]
        }
    }

    private var portQuestion: SessionEvent.Question {
        questions(#"[{"question":"Which port?","header":"Port","options":[{"label":"3000","description":null},{"label":"8080","description":null}],"multiSelect":false}]"#)[0]
    }

    private var toolsQuestion: SessionEvent.Question {
        questions(#"[{"question":"Which tools?","header":"Tools","options":[{"label":"bash","description":null},{"label":"read","description":null},{"label":"write","description":null}],"multiSelect":true}]"#)[0]
    }

    // MARK: - Defect 2: the single-select selected state that did not exist

    /// The headline pin for defect 2. Before Task 3 a single-select option had NO selected state at
    /// all — no glyph, no fill, no border, no weight — so the user could not see what they had
    /// picked before submitting. Every axis is asserted separately: a future edit that keeps the
    /// glyph but drops the fill still fails here.
    func testASelectedSingleSelectOptionIsVisiblyDifferentFromAnUnselectedOne() {
        let selected = optionSelectionChrome(isSelected: true)
        let resting = optionSelectionChrome(isSelected: false)

        XCTAssertGreaterThan(selected.fillOpacity, 0, "a selected option must be filled")
        XCTAssertGreaterThan(selected.strokeWidth, 0, "a selected option must be bordered")
        XCTAssertTrue(selected.isBold, "a selected option's label must be emboldened")

        XCTAssertEqual(resting.fillOpacity, 0, "an unselected option must have no resting fill")
        XCTAssertEqual(resting.strokeWidth, 0, "an unselected option must have no resting border")
        XCTAssertFalse(resting.isBold)

        XCTAssertNotEqual(selected, resting)
    }

    /// The glyph is honest about arity: pick-one is a circle, pick-any is a square — iOS's rule.
    /// Single-select's unselected glyph is the one that did not exist at all before Task 3.
    func testSelectionGlyphIsHonestAboutTheQuestionsArity() {
        XCTAssertEqual(optionSelectionGlyph(multiSelect: false, isSelected: false), "circle")
        XCTAssertEqual(optionSelectionGlyph(multiSelect: false, isSelected: true), "checkmark.circle.fill")
        XCTAssertEqual(optionSelectionGlyph(multiSelect: true, isSelected: false), "square")
        XCTAssertEqual(optionSelectionGlyph(multiSelect: true, isSelected: true), "checkmark.square.fill")
    }

    // MARK: - Defect 3: SF Symbols where literal characters were

    /// `⚠`/`?`/`☰` were literal text characters in the card headers. A symbol name is asserted here
    /// rather than a specific glyph shape: what matters is that the header draws from the symbol
    /// vocabulary the rest of the window uses, and that each kind is distinguishable.
    func testCardHeadersUseSFSymbolsNotLiteralCharacters() {
        let approval = cardGlyphSymbol(.approval(toolName: "bash", summary: "rm x"))
        let question = cardGlyphSymbol(.question(questions: [portQuestion]))
        let plan = cardGlyphSymbol(.plan(plan: "the plan"))

        for symbol in [approval, question, plan] {
            XCTAssertFalse(symbol.isEmpty)
            XCTAssertNotNil(symbol.rangeOfCharacter(from: .alphanumerics),
                            "a symbol NAME, not a literal glyph — got \(symbol)")
        }
        XCTAssertEqual(Set([approval, question, plan]).count, 3, "each kind is distinguishable")
        // iOS's own ApprovalRowView symbol — the one place the two apps can literally match.
        XCTAssertEqual(approval, "hand.raised.fill")
    }

    // MARK: - Defect 1: what a frozen card says

    /// A resolved approval reads as approved, and the one green in the card is reserved for an
    /// outcome the user affirmatively granted.
    func testApprovedApprovalFreezesAsApproved() {
        let label = outcomeLabel(.approval(approved: true, by: "orb"))
        XCTAssertEqual(label.text, "Approved")
        XCTAssertTrue(label.isAffirmative)
        XCTAssertEqual(interactionProvenance(.approval(approved: true, by: "orb")), "answered by orb")
    }

    func testDeniedApprovalFreezesAsDenied() {
        let label = outcomeLabel(.approval(approved: false, by: "orb"))
        XCTAssertEqual(label.text, "Denied")
        XCTAssertFalse(label.isAffirmative)
    }

    /// The fail-closed timeout IS a denial on the wire (`{approved:false, by:"timeout"}`,
    /// `packages/core/src/agent/approvals.ts`) but not one the user made. The card must not tell
    /// them, months later, that they denied something they never saw.
    func testATimedOutApprovalDoesNotReadAsAUserDenial() {
        let label = outcomeLabel(.approval(approved: false, by: "timeout"))
        XCTAssertNotEqual(label.text, "Denied", "a timeout must be distinguishable from a real denial")
        XCTAssertTrue(label.text.lowercased().contains("timed out"))
        XCTAssertFalse(label.isAffirmative)
        XCTAssertEqual(interactionProvenance(.approval(approved: false, by: "timeout")),
                       "no answer before the deadline — resolved by timeout")
    }

    func testResolvedPlanDistinguishesApproveAutoAcceptAndChanges() {
        XCTAssertEqual(outcomeLabel(.plan(approved: true, autoAccept: false, feedback: nil, by: "orb")).text, "Approved")
        XCTAssertEqual(outcomeLabel(.plan(approved: true, autoAccept: true, feedback: nil, by: "orb")).text,
                       "Approved — auto-accepting edits")
        let changes = outcomeLabel(.plan(approved: false, autoAccept: false, feedback: "use bun", by: "orb"))
        XCTAssertEqual(changes.text, "Changes requested")
        XCTAssertFalse(changes.isAffirmative)
    }

    /// An ask whose turn ended without any resolution says nothing was recorded — it never claims a
    /// decision, and it names nobody, because nobody decided.
    func testAnEndedAskClaimsNoDecisionAndNamesNobody() {
        let label = outcomeLabel(.ended)
        XCTAssertFalse(label.isAffirmative)
        XCTAssertFalse(label.text.lowercased().contains("approv"))
        XCTAssertFalse(label.text.lowercased().contains("denied"))
        XCTAssertNil(interactionProvenance(.ended), "nobody answered, so nobody is credited")
    }

    // MARK: - Defect 1: marking the chosen option on a frozen question

    /// The whole point of the frozen question card: from nothing but the persisted answer STRING,
    /// recover which option it was. Single-select — one label, verbatim.
    func testAResolvedSingleSelectMarksTheChosenOption() {
        XCTAssertEqual(resolvedAnswer(for: portQuestion, answer: "8080"), .options([1]))
        XCTAssertEqual(resolvedAnswer(for: portQuestion, answer: "3000"), .options([0]))
    }

    /// Multi-select — the labels `", "`-joined in option order, exactly as `questionAnswers` builds
    /// them. This test is the inverse of that function and is written against it.
    func testAResolvedMultiSelectMarksEveryChosenOption() {
        XCTAssertEqual(resolvedAnswer(for: toolsQuestion, answer: "bash, write"), .options([0, 2]))
        XCTAssertEqual(resolvedAnswer(for: toolsQuestion, answer: "bash, read, write"), .options([0, 1, 2]))
    }

    /// The "Other…" path. A typed answer matches no option, and must be shown as what it is rather
    /// than dropped — the record has to say what was actually sent.
    func testAFreeTextAnswerIsKeptVerbatimRatherThanDropped() {
        XCTAssertEqual(resolvedAnswer(for: portQuestion, answer: "whatever the proxy uses"),
                       .freeText("whatever the proxy uses"))
    }

    /// A label that itself contains ", " is matched whole rather than shredded by the split — the
    /// reason the exact-match attempt comes first.
    func testALabelContainingACommaIsMatchedWholeNotSplit() {
        let commas = questions(#"[{"question":"Which?","header":"H","options":[{"label":"a, b","description":null},{"label":"c","description":null}],"multiSelect":false}]"#)[0]
        XCTAssertEqual(resolvedAnswer(for: commas, answer: "a, b"), .options([0]))
    }

    /// A partial match is free text, not a half-marked set: "bash, sudo" names one real option and
    /// one that does not exist, and guessing which half to honour would misreport the record.
    func testAPartiallyMatchingAnswerIsFreeTextNotAHalfMarkedSet() {
        XCTAssertEqual(resolvedAnswer(for: toolsQuestion, answer: "bash, sudo"), .freeText("bash, sudo"))
    }

    /// No entry for this question in the answers dict — reachable on an `.ended` card, and on a
    /// resolution that simply did not answer this one.
    func testAnUnansweredQuestionResolvesToNone() {
        XCTAssertEqual(resolvedAnswer(for: portQuestion, answer: nil), .none)
        XCTAssertEqual(resolvedAnswer(for: portQuestion, answer: "   "), .none)
    }

    // MARK: - The composer morph (user call, 2026-08-12)

    private func q(_ text: String) -> SessionEvent.Question {
        SessionEvent.Question(question: text, header: nil,
                              options: [SessionEvent.QuestionOption(label: "yes", description: nil)],
                              multiSelect: false)
    }

    /// OLDEST first, so answering unblocks the earliest waiting turn — and questions ONLY. An
    /// approval sitting ahead of a question in the queue must not shadow it: approvals stay in the
    /// transcript, so if this scanned only the head of the list the composer would never morph
    /// while one was open.
    func testTheComposerTakesTheOldestPendingQUESTIONAndIgnoresOtherAsks() {
        let picked = composerMorphQuestion([
            .approval(callId: "ap1", toolName: "bash", summary: "rm -rf x"),
            .plan(callId: "pl1", plan: "# Plan"),
            .question(callId: "q1", questions: [q("first?")], childSessionId: "child-7"),
            .question(callId: "q2", questions: [q("second?")]),
        ])
        XCTAssertEqual(picked?.callId, "q1", "the OLDEST question, not the newest and not the head of the queue")
        XCTAssertEqual(picked?.questions.first?.question, "first?")
        XCTAssertEqual(picked?.childSessionId, "child-7", "a dispatch child's ask must carry its routing")

        XCTAssertNil(composerMorphQuestion([
            .approval(callId: "ap1", toolName: "bash", summary: "rm -rf x"),
            .plan(callId: "pl1", plan: "# Plan"),
        ]), "approvals and plans belong in the transcript — they must not take the composer's slot")
        XCTAssertNil(composerMorphQuestion([]))
    }

    /// A question whose payload has not landed yet cannot render a form, so the composer stays a
    /// composer rather than morphing into an empty box the user cannot answer or dismiss.
    func testAQuestionWithNoQuestionsYetDoesNotTakeTheComposer() {
        XCTAssertNil(composerMorphQuestion([.question(callId: "q1", questions: [])]))
        XCTAssertEqual(
            composerMorphQuestion([
                .question(callId: "q1", questions: []),
                .question(callId: "q2", questions: [q("real?")]),
            ])?.callId,
            "q2", "skip the unhealed one and take the next real question")
    }

    /// The transcript's half of the same decision. These two functions must agree: if the composer
    /// shows it and the transcript also draws it, the question renders twice; if neither does, an
    /// ask disappears and the turn hangs with nothing on screen to answer.
    func testOnlyAPendingQuestionStepsOutOfTheTranscript() {
        let question = InteractionRecord.Ask.question(questions: [q("which?")])
        XCTAssertTrue(questionMorphsTheComposer(InteractionRecord(callId: "q1", ask: question)),
                      "pending question → the composer has it")
        XCTAssertFalse(
            questionMorphsTheComposer(InteractionRecord(
                callId: "q1", ask: question,
                outcome: .question(answers: ["which?": "this"], notes: [:], by: "orb"))),
            "ANSWERED → back in the transcript, frozen: this is what keeps Task 3's scrollback record")
        XCTAssertFalse(
            questionMorphsTheComposer(InteractionRecord(callId: "q1", ask: question, outcome: .ended)),
            "ended without an answer still belongs in the transcript — it is a record of what was asked")
        for ask: InteractionRecord.Ask in [
            .approval(toolName: "bash", summary: "rm -rf x"),
            .plan(plan: "# Plan"),
        ] {
            XCTAssertFalse(questionMorphsTheComposer(InteractionRecord(callId: "a1", ask: ask)),
                           "\(ask) draws in the transcript while pending — only questions morph")
        }
    }

    // MARK: - The question card's type ladder (ported from iOS by ratio)

    /// **The question is set at the transcript's own prose size**, which is iOS's relationship
    /// (`.body` for both).
    ///
    /// Asserted as a DERIVATION, not a value. `QuestionCardType.question` reads
    /// `transcriptProseMetrics(.assistant)`, so changing the prose ladder moves the question with
    /// it; a test that said `== 15.5` would pass while the two silently drifted apart.
    ///
    /// This used to ALSO assert `question != sans body` ("specifically NOT the user's message
    /// size") — retired by the 2026-08-13 ruling, under which the two prose roles share ONE
    /// nominal size (iOS canonical: its bubble and its serif prose are both `.body`), so
    /// question == sans body is now true BY DESIGN, not a regression. The derivation half is the
    /// one that still carries meaning, and it stays.
    func testTheQuestionIsSetAtTheTranscriptsOwnProseSize() {
        XCTAssertEqual(QuestionCardType.question, transcriptProseMetrics(.assistant).bodySize,
                       "a question is Norma talking — it belongs in her prose register, not a step under it")
    }

    /// The steps under it, as iOS's ratios against `.body` (17) rather than its point values —
    /// copying 17/16/13/12 onto a 15.5 ladder would have made the card larger than its own prose.
    func testTheLadderUnderTheQuestionKeepsIOSsProportions() {
        let prose = QuestionCardType.question
        XCTAssertEqual(QuestionCardType.option / prose, 16.0 / 17.0, accuracy: 0.02,
                       "option label ≈ iOS .callout")
        XCTAssertEqual(QuestionCardType.secondary / prose, 13.0 / 17.0, accuracy: 0.02,
                       "descriptions and notes ≈ iOS .footnote")
        XCTAssertEqual(QuestionCardType.pill / prose, 12.0 / 17.0, accuracy: 0.03,
                       "header chips ≈ iOS .caption")
        // Descending, with no two steps collapsed into one — the hierarchy is the point.
        XCTAssertGreaterThan(prose, QuestionCardType.option)
        XCTAssertGreaterThan(QuestionCardType.option, QuestionCardType.secondary)
        XCTAssertGreaterThan(QuestionCardType.secondary, QuestionCardType.pill)
    }

    // MARK: - The answered-question deck (iOS SP-ask-stack)

    /// Modular in BOTH directions and with no ends — cycling past the last card returns to the
    /// first, and stepping back from the first lands on the last. The pager drives itself through
    /// this same function, so a negative index has to be as safe as an oversized one.
    func testTheDeckLoopsInBothDirectionsAndHasNoEnds() {
        XCTAssertEqual(deckDepth(index: 0, front: 0, count: 3), 0)
        XCTAssertEqual(deckDepth(index: 1, front: 0, count: 3), 1)
        XCTAssertEqual(deckDepth(index: 0, front: 1, count: 3), 2, "the front card's predecessor is BEHIND it, not ahead")
        XCTAssertEqual(deckDepth(index: -1, front: 0, count: 3), 2, "stepping back from the first lands on the last")
        XCTAssertEqual(deckDepth(index: 3, front: 0, count: 3), 0, "past the last returns to the first")
        XCTAssertEqual(deckDepth(index: 0, front: 0, count: 0), 0, "no cards, no crash")
    }

    /// The fan alternates sides so the stack spreads rather than leaning as one block, and the
    /// front card never leans at all — a tilted front card would read as a card being dragged.
    func testTheDeckFansAlternatelyAndTheFrontCardIsUpright() {
        XCTAssertEqual(deckLeanDegrees(depth: 0), 0, "the front card is upright")
        XCTAssertEqual(deckLeanDegrees(depth: 1), 2.2, accuracy: 0.001)
        XCTAssertEqual(deckLeanDegrees(depth: 2), -4.4, accuracy: 0.001, "alternating sides, not a growing lean")
        XCTAssertEqual(deckLeanDegrees(depth: 3), 6.6, accuracy: 0.001)
    }

    /// A deck is drawn for an ANSWERED block of MORE THAN ONE question, and for nothing else.
    func testOnlyAnAnsweredMultiQuestionBlockBecomesADeck() {
        let two = [q("first?"), q("second?")]
        let answered = InteractionRecord.Outcome.question(answers: ["first?": "yes"], notes: [:], by: "orb")

        XCTAssertEqual(
            questionDeckCards(InteractionRecord(callId: "q1", ask: .question(questions: two), outcome: answered))?.count,
            2, "answered, two questions → a deck")
        XCTAssertNil(
            questionDeckCards(InteractionRecord(callId: "q1", ask: .question(questions: [q("only?")]), outcome: answered)),
            "one question is an ordinary card, not a deck of one")
        XCTAssertNil(
            questionDeckCards(InteractionRecord(callId: "q1", ask: .question(questions: two))),
            "pending never decks — the composer is holding it")
        XCTAssertNil(
            questionDeckCards(InteractionRecord(callId: "q1", ask: .question(questions: two), outcome: .ended)),
            "ended unanswered stays one card: every card in that deck would read '—'")
        XCTAssertNil(
            questionDeckCards(InteractionRecord(callId: "a1", ask: .approval(toolName: "bash", summary: "x"),
                                                outcome: .approval(approved: true, by: "orb"))),
            "approvals never deck")
    }

    // MARK: - A frozen card cannot be interacted with

    /// The pending/frozen branch is `outcome == nil` and nothing else, so a card is interactive
    /// exactly while the daemon is waiting on it. Paired with the reducer's
    /// `endOutstandingInteractions` (pinned in `InteractionRecordTests`), which is what guarantees
    /// the predicate goes false even when no `*_resolved` ever arrives.
    func testTheInteractiveBranchIsExactlyTheUnresolvedOne() {
        let ask = InteractionRecord.Ask.approval(toolName: "bash", summary: "rm -rf x")
        XCTAssertTrue(interactionIsPending(InteractionRecord(callId: "a1", ask: ask)))
        for outcome: InteractionRecord.Outcome in [
            .approval(approved: true, by: "orb"),
            .approval(approved: false, by: "timeout"),
            .ended,
        ] {
            XCTAssertFalse(interactionIsPending(InteractionRecord(callId: "a1", ask: ask, outcome: outcome)),
                           "\(outcome) must not render an interactive card")
        }
    }

    /// The real guarantee, and a stronger one than the source scan: a frozen body holds no respond
    /// closure, so there is nothing in scope for it to call. `TranscriptInteractionCard.resolvedBody`
    /// constructs these three with data only — no `onApproval`/`onQuestion`/`onPlan`, no
    /// `draftBinding` — which is why a resolved card cannot re-answer its ask even by mistake. Driven
    /// through `Mirror` so it inspects the actual types rather than the file's text, and so it
    /// survives a refactor that moves the declarations.
    ///
    /// Unlike the scan below, this is immune to composition: a nested view cannot manufacture a
    /// closure its parent was never given.
    func testAFrozenCardIsHandedNoRespondClosures() {
        let approval = ResolvedApprovalBody(summary: "rm -rf x", reviewerReason: nil,
                                            outcome: .approval(approved: true, by: "orb"))
        let question = ResolvedQuestionBody(questions: [portQuestion],
                                            outcome: .question(answers: ["Which port?": "8080"], notes: [:], by: "orb"))
        let plan = ResolvedPlanBody(plan: "the plan",
                                    outcome: .plan(approved: true, autoAccept: false, feedback: nil, by: "orb"))

        for (name, body) in [("ResolvedApprovalBody", Mirror(reflecting: approval)),
                             ("ResolvedQuestionBody", Mirror(reflecting: question)),
                             ("ResolvedPlanBody", Mirror(reflecting: plan))] {
            for child in body.children {
                let type = String(describing: Swift.type(of: child.value))
                XCTAssertFalse(type.contains("->"),
                               "\(name).\(child.label ?? "?") is a closure (\(type)) — a frozen card must hold no callback")
            }
        }
    }

    /// A respond that failed and was then resolved some other way (the fail-closed timeout, the
    /// phone answering it) must not leave "couldn't send — try again" in the permanent record.
    /// Nothing clears `interactionErrors` on resolve — it is cleared only at the start of the next
    /// attempt — which was harmless while the card was deleted on resolve and is not harmless now.
    func testAFrozenCardShowsNoStaleRespondError() {
        let ask = InteractionRecord.Ask.approval(toolName: "bash", summary: "rm -rf x")
        XCTAssertTrue(showsInteractionErrorLine(InteractionRecord(callId: "a1", ask: ask), hasError: true),
                      "a pending card still reports a failed attempt")
        XCTAssertFalse(showsInteractionErrorLine(InteractionRecord(callId: "a1", ask: ask), hasError: false))
        for outcome: InteractionRecord.Outcome in [.approval(approved: false, by: "timeout"), .ended] {
            XCTAssertFalse(showsInteractionErrorLine(InteractionRecord(callId: "a1", ask: ask, outcome: outcome), hasError: true),
                           "\(outcome) must not keep a stale error line in scrollback")
        }
    }

    /// The resolved bodies are separate view types from the pending ones and declare no
    /// `Button`/`TextField` of their own. This asserts the source says so, by reading the file — the
    /// only way to make the claim without a UI test harness, and honest about being exactly that.
    ///
    /// **Three things it does not establish, all of them real:**
    ///   1. It does not prove SwiftUI refuses a click — that is the live gate.
    ///   2. **It cannot see through composition.** `ResolvedPlanBody` composes
    ///      `TranscriptAssistantMessage`, and a fenced code block inside a plan renders
    ///      `TranscriptCodeBlock`'s copy button, which nothing here gates — so a frozen plan with a
    ///      code fence DOES carry live buttons today. Accepted: copying is not re-answering.
    ///   3. It does not cover the shared chrome in `TranscriptInteractionCard`, which is why the
    ///      scope is the three `Resolved*Body` declarations rather than the whole file.
    ///
    /// What actually guarantees a frozen card cannot RE-ANSWER its ask is not this scan: it is that
    /// `TranscriptInteractionCard.resolvedBody` is handed no respond closures, so there is nothing
    /// in scope to call. That is pinned by `testAFrozenCardIsHandedNoRespondClosures` below.
    func testFrozenBodiesContainNoInteractiveAffordance() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/ChatContent/PendingCards.swift")
        let source = try String(contentsOf: url, encoding: .utf8)

        for name in ["ResolvedApprovalBody", "ResolvedQuestionBody", "ResolvedPlanBody"] {
            // Access level is not part of the claim — these are internal so `Mirror` can reach them
            // (`testAFrozenCardIsHandedNoRespondClosures`), and were `private` before that.
            guard let start = source.range(of: "\nstruct \(name): View {")
                    ?? source.range(of: "\nprivate struct \(name): View {") else {
                return XCTFail("\(name) not found — rename it here too, do not delete the check")
            }
            // The declaration runs to its closing brace at column 0.
            let rest = source[start.upperBound...]
            let end = rest.range(of: "\n}\n")?.lowerBound ?? rest.endIndex
            // CODE only — `//` lines are stripped, so a doc comment that NAMES one of these (e.g.
            // `ResolvedPlanBody`'s note about the flag that suppresses the copy button) is not a
            // false positive. Without this the check would punish writing the comment down.
            let code = rest[..<end]
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.drop(while: { $0 == " " }).hasPrefix("//") ? "" : String($0) }
                .joined(separator: "\n")

            XCTAssertFalse(code.contains("Button"), "\(name) declares a Button — a frozen card is not clickable")
            XCTAssertFalse(code.contains("TextField"), "\(name) declares a TextField — a frozen card is not editable")
            XCTAssertFalse(code.contains("onTapGesture"), "\(name) declares a tap gesture")
        }
    }
}
