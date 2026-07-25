import XCTest
import NormaProtocol
@testable import Norma

/// Chat mode Slice B1, Task 4: `header == nil` is the wire signal for chat's simplified
/// `AskQuestion` card (Task 2 made `SessionEvent.Question.header` optional) — no chip, no
/// per-option descriptions, no notes affordance. These pin the three pure helpers the simplified
/// card depends on: `cardTitle`'s header-less fallback (a header-less card must not render an
/// EMPTY title bar), `questionShowsHeaderChip`'s "gate on BOTH count AND header, not count alone"
/// fix (previously `questions.count > 1` alone happened to suppress the chip for `AskQuestion`'s
/// single-question batch — by ARITHMETIC, not by intent), and the new `questionAllowsNotes`
/// predicate. Mirrors `PendingCardsTests`'s `questions(_ json:)` JSON-decode convention —
/// `Question`/`QuestionOption` are cross-module `Codable` structs with no public memberwise
/// initializer.
final class SimplifiedQuestionCardTests: XCTestCase {
    func questions(_ json: String) -> [SessionEvent.Question] {
        try! JSONDecoder().decode([SessionEvent.Question].self, from: Data(json.utf8))
    }

    // MARK: - cardTitle header-less fallback

    func testSimplifiedQuestionCardTitleFallsBackToTheQuestion() {
        let qs = questions(#"[{"question":"Which tier should I compare against?","options":[{"label":"Free","description":null},{"label":"Pro","description":null}],"multiSelect":false}]"#)
        let interaction = PendingInteraction.question(callId: "call_1", questions: qs)
        // A header-less card must not render an EMPTY title bar.
        XCTAssertEqual(cardTitle(interaction), "Which tier should I compare against?")
    }

    func testCodeQuestionCardStillUsesItsHeader() {
        let qs = questions(#"[{"question":"Which tier?","header":"Tier","options":[{"label":"Free","description":null},{"label":"Pro","description":null}],"multiSelect":false}]"#)
        let interaction = PendingInteraction.question(callId: "call_1", questions: qs)
        XCTAssertEqual(cardTitle(interaction), "Tier")
    }

    // MARK: - questionShowsHeaderChip (gate on BOTH count and header, not count alone)

    func testHeaderChipIsSuppressedByIntentNotByCount() {
        let headerless = questions(#"[{"question":"A?","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        let headered = questions(#"[{"question":"B?","header":"Bee","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        // Even in a multi-question card, a header-less question shows no chip.
        XCTAssertFalse(questionShowsHeaderChip(headerless, questionCount: 2))
        XCTAssertTrue(questionShowsHeaderChip(headered, questionCount: 2))
        XCTAssertFalse(questionShowsHeaderChip(headered, questionCount: 1))
    }

    // MARK: - questionAllowsNotes (simplified card has no notes affordance)

    func testSimplifiedCardOffersNoNotesAffordance() {
        let headerless = questions(#"[{"question":"A?","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        let headered = questions(#"[{"question":"B?","header":"Bee","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        XCTAssertFalse(questionAllowsNotes(headerless))
        XCTAssertTrue(questionAllowsNotes(headered))
    }

    // MARK: - questionIsSimplified (the underlying signal both helpers above read)

    func testQuestionIsSimplifiedReadsHeaderNilness() {
        let headerless = questions(#"[{"question":"A?","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        let headered = questions(#"[{"question":"B?","header":"Bee","options":[{"label":"x","description":null},{"label":"y","description":null}],"multiSelect":false}]"#)[0]
        XCTAssertTrue(questionIsSimplified(headerless))
        XCTAssertFalse(questionIsSimplified(headered))
    }
}
