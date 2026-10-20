import XCTest
import WinterProtocol
@testable import Winter

// MARK: - Free-text questions (2026-10-20)

/// AskUserQuestion's `options` became optional: no options = a question answered by typing alone, and a menu always has
/// a free-text box under it. These pin the shared rules every Mac surface (code window, Dispatch pill, island) answers
/// by — the views are thin over them.
final class FreeTextQuestionTests: XCTestCase {
    private func questions(_ json: String) -> [SessionEvent.Question] {
        try! JSONDecoder().decode([SessionEvent.Question].self, from: Data(json.utf8))
    }

    private var freeText: SessionEvent.Question {
        questions(#"[{"question":"Branch name?","header":"Branch","options":[],"multiSelect":false,"placeholder":"e.g. feature/login"}]"#)[0]
    }

    func testAQuestionWithNoOptionsKeyIsFreeTextAndAnOldPayloadStillDecodes() {
        let noKey = questions(#"[{"question":"Name?","multiSelect":false}]"#)[0]
        XCTAssertEqual(noKey.options, [])
        XCTAssertTrue(noKey.isFreeText)
        XCTAssertNil(noKey.placeholder)
        let old = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"A","description":null},{"label":"B","description":null}],"multiSelect":false}]"#)[0]
        XCTAssertFalse(old.isFreeText)
        XCTAssertNil(old.placeholder)
    }

    func testTheFieldsHintIsThePlaceholderElseWordsForEachShape() {
        XCTAssertEqual(questionFieldPlaceholder(freeText), "e.g. feature/login")
        let bare = questions(#"[{"question":"Name?","options":[],"multiSelect":false}]"#)[0]
        XCTAssertEqual(questionFieldPlaceholder(bare), "Type your answer…")
        let menu = questions(#"[{"question":"Which?","options":[{"label":"A"},{"label":"B"}],"multiSelect":false}]"#)[0]
        XCTAssertEqual(questionFieldPlaceholder(menu), "Something else…")
        let hinted = questions(#"[{"question":"Which?","options":[{"label":"A"},{"label":"B"}],"multiSelect":false,"placeholder":"Another city"}]"#)[0]
        XCTAssertEqual(questionFieldPlaceholder(hinted), "Another city")
        let blank = questions(#"[{"question":"Which?","options":[],"multiSelect":false,"placeholder":"   "}]"#)[0]
        XCTAssertEqual(questionFieldPlaceholder(blank), "Type your answer…", "a blank hint is no hint")
    }

    func testOnlyAFreeTextQuestionTakesTheKeyboard() {
        XCTAssertTrue(questionFieldTakesFocus(freeText))
        let menu = questions(#"[{"question":"Which?","options":[{"label":"A"},{"label":"B"}],"multiSelect":false}]"#)[0]
        XCTAssertFalse(questionFieldTakesFocus(menu))
    }

    func testAFreeTextQuestionIsAnsweredByItsTypedTextAndNothingElse() {
        let qs = [freeText]
        var draft = PendingCardDraft()
        XCTAssertFalse(questionCardComplete(questions: qs, selections: draft.selections, otherTexts: draft.otherTexts),
                       "empty box: send stays disabled")
        draft.setOtherText("   ", forQuestion: 0)
        XCTAssertFalse(questionIsAnswered(freeText, at: 0, draft: draft), "blank text is no answer")
        draft.setOtherText("  feature/login-retry ", forQuestion: 0)
        XCTAssertTrue(questionIsAnswered(freeText, at: 0, draft: draft))
        XCTAssertEqual(questionAnswers(for: qs, selections: draft.selections, otherTexts: draft.otherTexts),
                       ["Branch name?": "feature/login-retry"], "the typed text, trimmed — sent exactly like a label")
    }

    func testAMultipleChoiceQuestionSendsItsPicksThenTheTypedText() {
        let multi = questions(#"[{"question":"Which targets?","header":"T","options":[{"label":"macOS"},{"label":"iOS"},{"label":"tvOS"}],"multiSelect":true}]"#)
        var draft = PendingCardDraft()
        draft.toggleMulti(2, forQuestion: 0)
        draft.setOtherText("watchOS", forQuestion: 0, multiSelect: true)
        draft.toggleMulti(0, forQuestion: 0)
        XCTAssertEqual(draft.selections[0], [0, 2], "typing never clears a multiple-choice question's picks")
        XCTAssertEqual(questionAnswers(for: multi, selections: draft.selections, otherTexts: draft.otherTexts),
                       ["Which targets?": "macOS, tvOS, watchOS"], "labels in option order, then the typed text")
        // Typed text alone answers it too.
        XCTAssertEqual(questionAnswers(for: multi, selections: [:], otherTexts: [0: "watchOS"]), ["Which targets?": "watchOS"])
        // And the frozen card reads the mix back: the picks, then the words.
        XCTAssertEqual(resolvedAnswer(for: multi[0], answer: "macOS, tvOS, watchOS"), .optionsAndText([0, 2], "watchOS"))
        XCTAssertEqual(resolvedAnswer(for: multi[0], answer: "macOS, tvOS"), .options([0, 2]), "picks alone are unchanged")
    }

    func testASingleChoiceQuestionKeepsItsMutualExclusion() {
        let single = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"Postgres"},{"label":"MySQL"}],"multiSelect":false}]"#)
        var draft = PendingCardDraft()
        draft.selectSingle(0, forQuestion: 0)
        draft.setOtherText("SQLite", forQuestion: 0, multiSelect: false)
        XCTAssertEqual(draft.selections[0], [], "typing clears a single choice")
        XCTAssertEqual(questionAnswers(for: single, selections: draft.selections, otherTexts: draft.otherTexts), ["Which db?": "SQLite"])
        // A typed answer the menu did not offer reads back as free text on a single-choice question, whatever its commas.
        XCTAssertEqual(resolvedAnswer(for: single[0], answer: "Postgres, tuned"), .freeText("Postgres, tuned"))
    }

    func testAFreeTextQuestionRecordReadsBackAsFreeText() {
        XCTAssertEqual(resolvedAnswer(for: freeText, answer: "feature/login"), .freeText("feature/login"))
    }

    /// The Dispatch pill's ✓ follows the same rule: disabled on an empty free-text question, enabled once typed.
    func testThePillsSendWaitsForTypedTextOnAFreeTextQuestion() {
        var draft = PendingCardDraft()
        XCTAssertFalse(dispatchPillQuestionAdvance(questions: [freeText], draft: draft, index: 0, inFlight: false).enabled)
        draft.setOtherText("feature/login", forQuestion: 0)
        let advance = dispatchPillQuestionAdvance(questions: [freeText], draft: draft, index: 0, inFlight: false)
        XCTAssertEqual(advance.action, .send)
        XCTAssertTrue(advance.enabled)
    }

    /// The island's Needs-you and on-top cards read the question straight out of `island.pending`'s event — a free-text
    /// one (no options key at all) comes through with its hint.
    func testTheIslandCardCarriesAFreeTextQuestion() throws {
        let json = #"{"type":"question_asked","sessionId":"s1","threadId":"main","seq":3,"ts":1,"callId":"q1","questions":[{"question":"Branch name?","header":"Branch","multiSelect":false,"placeholder":"e.g. feature/login"}]}"#
        let event = try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        guard case .questionAsked(let asked) = event else { return XCTFail("not a question") }
        XCTAssertEqual(asked.questions[0].options, [])
        XCTAssertEqual(questionFieldPlaceholder(asked.questions[0]), "e.g. feature/login")
    }
}
