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

    private func questions(_ json: String) -> [SessionEvent.Question] {
        try! JSONDecoder().decode([SessionEvent.Question].self, from: Data(json.utf8))
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

    /// Non-interactivity is structural, not a disabled flag: the resolved bodies are separate view
    /// types from the pending ones, and they declare no `Button`/`TextField` at all. This asserts
    /// the source says so, by reading the file — the only way to make the claim without a UI test
    /// harness, and honest about being exactly that.
    ///
    /// It does NOT prove SwiftUI refuses a click (that is the live gate), and it does not cover the
    /// shared chrome in `TranscriptInteractionCard` — which is why the check is scoped to the three
    /// `Resolved*Body` declarations rather than the whole file.
    func testFrozenBodiesContainNoInteractiveAffordance() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/ChatContent/PendingCards.swift")
        let source = try String(contentsOf: url, encoding: .utf8)

        for name in ["ResolvedApprovalBody", "ResolvedQuestionBody", "ResolvedPlanBody"] {
            guard let start = source.range(of: "private struct \(name): View {") else {
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
