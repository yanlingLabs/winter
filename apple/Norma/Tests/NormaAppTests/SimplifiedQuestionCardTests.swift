import XCTest
import NormaProtocol
@testable import Norma

/// Chat mode Slice B1, Task 4: `header == nil` is the wire signal for chat's simplified
/// `AskQuestion` card (Task 2 made `SessionEvent.Question.header` optional) — no chip, no
/// per-option descriptions, no notes affordance. These pin the pure helpers the simplified card
/// depends on: `questionShowsHeaderChip`'s "gate on BOTH count AND header, not count alone" fix
/// (previously `questions.count > 1` alone happened to suppress the chip for `AskQuestion`'s
/// single-question batch — by ARITHMETIC, not by intent), the new `questionAllowsNotes` predicate,
/// and (branch review FIX 2) `showsCardTitleRow` — whether the card's title ROW renders at all.
/// Mirrors `PendingCardsTests`'s `questions(_ json:)` JSON-decode convention — `Question`/
/// `QuestionOption` are cross-module `Codable` structs with no public memberwise initializer.
///
/// Branch review FIX 2 history: the shipped card rendered the question TWICE — once via
/// `cardTitle`'s header-less fallback in the title row, once via `QuestionBlock`'s unconditional
/// `Text(question.question)` in the body. The isolated-helper tests below each passed the whole
/// time (`cardTitle` was doing exactly what its OLD doc comment asked), because none of them
/// composed the title row with the body the way the real card does — that's why nobody saw it.
/// The fix suppresses the title row entirely for a simplified card (`showsCardTitleRow == false`);
/// `cardTitle` itself is UNCHANGED and stays correct, it just has no reachable caller for this
/// card type anymore.
final class SimplifiedQuestionCardTests: XCTestCase {
    func questions(_ json: String) -> [SessionEvent.Question] {
        try! JSONDecoder().decode([SessionEvent.Question].self, from: Data(json.utf8))
    }

    private let simplifiedQuestionText = "Which tier should I compare against?"

    private var simplified: [SessionEvent.Question] {
        questions(#"[{"question":"Which tier should I compare against?","options":[{"label":"Free","description":null},{"label":"Pro","description":null}],"multiSelect":false}]"#)
    }

    private var headered: [SessionEvent.Question] {
        questions(#"[{"question":"Which tier?","header":"Tier","options":[{"label":"Free","description":null},{"label":"Pro","description":null}],"multiSelect":false}]"#)
    }

    // MARK: - showsCardTitleRow (branch review FIX 2 — the title ROW, not just its text)

    func testSimplifiedQuestionCardSuppressesTheTitleRowEntirely() {
        let interaction = PendingInteraction.question(callId: "call_1", questions: simplified)
        // The approved design: question once, option labels, "Other" — nothing else. The title
        // row (glyph + cardTitle) must not render at all for a simplified card.
        XCTAssertFalse(showsCardTitleRow(interaction))
    }

    func testCodeQuestionCardTitleRowStillShows() {
        let interaction = PendingInteraction.question(callId: "call_1", questions: headered)
        // Code mode (headered) must be visually UNCHANGED — the title row still renders.
        XCTAssertTrue(showsCardTitleRow(interaction))
    }

    func testApprovalAndPlanCardsAlwaysShowTheirTitleRow() {
        let approval = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x")
        let plan = PendingInteraction.plan(callId: "p1", plan: "the plan")
        XCTAssertTrue(showsCardTitleRow(approval))
        XCTAssertTrue(showsCardTitleRow(plan))
    }

    // MARK: - cardTitle stays CORRECT even though this call site is now unreachable for the
    // simplified card (its header-less fallback must never regress to an empty title bar for
    // some future caller).

    func testCardTitleHeaderlessFallbackStillReturnsTheQuestion() {
        let interaction = PendingInteraction.question(callId: "call_1", questions: simplified)
        XCTAssertEqual(cardTitle(interaction), simplifiedQuestionText)
    }

    func testCodeQuestionCardStillUsesItsHeader() {
        let interaction = PendingInteraction.question(callId: "call_1", questions: headered)
        XCTAssertEqual(cardTitle(interaction), "Tier")
    }

    // MARK: - Composed: the question text renders EXACTLY ONCE across the whole card
    //
    // The isolated-helper tests above each passed even while the shipped card rendered the
    // question TWICE — nobody composed them. This mirrors PendingCard.body's ACTUAL composition
    // (gate the title row with showsCardTitleRow, always render question.question in the body) so
    // this class of duplication cannot silently come back.

    func testComposedSimplifiedCardRendersTheQuestionExactlyOnce() {
        let qs = simplified
        let interaction = PendingInteraction.question(callId: "call_1", questions: qs)

        var rendered: [String] = []
        if showsCardTitleRow(interaction) { rendered.append(cardTitle(interaction)) }
        rendered.append(qs[0].question) // QuestionBlock's unconditional Text(question.question)

        XCTAssertEqual(rendered.filter { $0 == simplifiedQuestionText }.count, 1,
                       "the question must render exactly once across the whole card")
    }

    func testComposedCodeModeCardShowsHeaderInTitleAndQuestionInBodySeparately() {
        let qs = headered
        let interaction = PendingInteraction.question(callId: "call_1", questions: qs)

        var rendered: [String] = []
        if showsCardTitleRow(interaction) { rendered.append(cardTitle(interaction)) }
        rendered.append(qs[0].question)

        // Code mode is visually UNCHANGED: title row shows the header chip text ("Tier"), body
        // shows the full question ("Which tier?") — two DIFFERENT strings, not a duplication.
        XCTAssertEqual(rendered, ["Tier", "Which tier?"])
    }

    // MARK: - questionShowsHeaderChip (gate on BOTH count and header, not count alone)

    func testHeaderChipIsSuppressedByIntentNotByCount() {
        let headerless = questions(#"[{"question":"A?","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        let headeredQ = questions(#"[{"question":"B?","header":"Bee","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        // Even in a multi-question card, a header-less question shows no chip.
        XCTAssertFalse(questionShowsHeaderChip(headerless, questionCount: 2))
        XCTAssertTrue(questionShowsHeaderChip(headeredQ, questionCount: 2))
        XCTAssertFalse(questionShowsHeaderChip(headeredQ, questionCount: 1))
    }

    // MARK: - questionAllowsNotes (simplified card has no notes affordance)

    func testSimplifiedCardOffersNoNotesAffordance() {
        let headerless = questions(#"[{"question":"A?","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        let headeredQ = questions(#"[{"question":"B?","header":"Bee","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        XCTAssertFalse(questionAllowsNotes(headerless))
        XCTAssertTrue(questionAllowsNotes(headeredQ))
    }

    // MARK: - questionIsSimplified (the underlying signal both helpers above read)

    func testQuestionIsSimplifiedReadsHeaderNilness() {
        let headerless = questions(#"[{"question":"A?","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        let headeredQ = questions(#"[{"question":"B?","header":"Bee","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        XCTAssertTrue(questionIsSimplified(headerless))
        XCTAssertFalse(questionIsSimplified(headeredQ))
    }
}
