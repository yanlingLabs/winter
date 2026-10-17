import XCTest
import AppKit
import SwiftUI
import WinterProtocol
@testable import Winter

/// The Dispatch pill as a card (user, 2026-10-17): the pill morphs INTO the oldest pending ask and back. The queue
/// (`DispatchPillCardQueue`), the card's size and words, the question card's ✓, Esc on a card, and the controller
/// driving pill → card → pill from the session's own state.
@MainActor
final class DispatchPillCardTests: XCTestCase {
    private let visible = CGRect(x: 0, y: 70, width: 1440, height: 830)

    // MARK: - The queue: pill → card → pill

    func testTheOldestPendingAskBecomesTheCardAndAnsweringItReturnsThePill() {
        var q = DispatchPillCardQueue()
        XCTAssertNil(q.front, "nothing pending: the pill is a pill")
        q.update(pending: ["a1"], typing: false)
        XCTAssertEqual(q.front, "a1", "an ask arrives: the pill becomes its card")
        XCTAssertEqual(q.waiting, 0)
        q.update(pending: [], typing: false)
        XCTAssertNil(q.front, "answered: back to the pill")
        XCTAssertEqual(q.waiting, 0)
    }

    func testASecondAskQueuesBehindTheCardOnThePillAndTakesItsPlaceWhenItIsAnswered() {
        var q = DispatchPillCardQueue()
        q.update(pending: ["a1"], typing: false)
        q.update(pending: ["a1", "q2"], typing: false)
        XCTAssertEqual(q.front, "a1", "a card on the pill is never replaced while it is pending")
        XCTAssertEqual(q.waiting, 1, "the newcomer waits, counted on the card")
        q.update(pending: ["q2"], typing: false)
        XCTAssertEqual(q.front, "q2", "the next ask morphs in — card to card")
        XCTAssertEqual(q.waiting, 0)
    }

    func testAnAskAnsweredElsewhereLeavesThePillEvenWhenItIsNotTheOneShown() {
        var q = DispatchPillCardQueue()
        q.update(pending: ["a1", "a2", "a3"], typing: false)
        // The phone answers a2 (behind the card), then the island answers a1 (the card).
        q.update(pending: ["a1", "a3"], typing: false)
        XCTAssertEqual(q.front, "a1")
        XCTAssertEqual(q.waiting, 1)
        q.update(pending: ["a3"], typing: false)
        XCTAssertEqual(q.front, "a3")
        q.update(pending: [], typing: false)
        XCTAssertNil(q.front)
    }

    func testANewerAskOlderInTheListNeverDisplacesTheCard() {
        var q = DispatchPillCardQueue()
        q.update(pending: ["b"], typing: false)
        // A transcript record for an older ask surfaces later (the live list and the transcript can disagree on order).
        q.update(pending: ["a", "b"], typing: false)
        XCTAssertEqual(q.front, "b", "the card the user may be answering stays")
    }

    func testTypingSetsEveryCardAsideAndAnEmptyComposerBringsThemBack() {
        var q = DispatchPillCardQueue()
        q.update(pending: ["a1", "a2"], typing: false)
        q.setAllAside()
        XCTAssertNil(q.front, "a keystroke under the card: the pill is the typing pill again")
        XCTAssertEqual(q.setAside, ["a1", "a2"], "every pending card steps aside, not just the front one")
        XCTAssertEqual(q.waiting, 2)
        q.update(pending: ["a1", "a2"], typing: true)
        XCTAssertNil(q.front, "a re-read while typing keeps them aside")
        q.bringBack()
        XCTAssertEqual(q.front, "a1", "sent or cleared (or the waiting pill clicked): the oldest comes back")
        XCTAssertTrue(q.setAside.isEmpty)
    }

    func testAnAskArrivingWhileTheUserTypesWaitsAside() {
        var q = DispatchPillCardQueue()
        q.update(pending: ["a1"], typing: true)
        XCTAssertNil(q.front, "a card never takes over a composer being written in")
        XCTAssertEqual(q.setAside, ["a1"])
        q.update(pending: ["a1", "a2"], typing: false)
        XCTAssertEqual(q.front, "a2", "one arriving after the typing stopped shows — the set-aside one still waits")
        q.bringBack()
        XCTAssertEqual(q.front, "a2", "bringing the others back never displaces the card on the pill")
    }

    func testASetAsideAskAnsweredElsewhereIsForgotten() {
        var q = DispatchPillCardQueue()
        q.update(pending: ["a1"], typing: false)
        q.setAllAside()
        q.update(pending: [], typing: true)
        XCTAssertTrue(q.setAside.isEmpty, "answered on the phone while aside: nothing waits any more")
        XCTAssertNil(q.front)
    }

    // MARK: - Countdown cards are never hidden

    func testACountdownCardArrivingWhileTheUserTypesStaysOnThePill() {
        var q = DispatchPillCardQueue()
        q.update(pending: ["switch"], urgent: ["switch"], typing: true)
        XCTAssertEqual(q.front, "switch", "a card that acts by itself at a deadline is never set aside")
        XCTAssertTrue(q.setAside.isEmpty)
    }

    func testTypingKeepsACountdownCardOnThePill() {
        var q = DispatchPillCardQueue()
        q.update(pending: ["a1", "switch"], urgent: ["switch"], typing: false)
        q.setAllAside()
        XCTAssertEqual(q.front, "switch", "the plain card steps aside, the countdown card stays")
        XCTAssertEqual(q.setAside, ["a1"])
    }

    func testACountdownCardGoesAheadOfAnOlderPlainCard() {
        var q = DispatchPillCardQueue()
        q.update(pending: ["a1"], typing: false)
        XCTAssertEqual(q.front, "a1")
        q.update(pending: ["a1", "switch"], urgent: ["switch"], typing: false)
        XCTAssertEqual(q.front, "switch", "it would run out behind \"+1 waiting\"")
        XCTAssertEqual(q.waiting, 1)
        q.update(pending: ["a1"], typing: false)
        XCTAssertEqual(q.front, "a1", "answered (or run out): the plain card comes back")
    }

    func testOnlyADefaultAllowApprovalIsACountdownCard() {
        let records = [
            InteractionRecord(callId: "s", ask: .approval(toolName: "ComputerV2", summary: "switch", defaultAllowAt: 1_900_000_000_000)),
            InteractionRecord(callId: "a", ask: .approval(toolName: "Bash", summary: "ls")),
            InteractionRecord(callId: "q", ask: .question(questions: [])),
        ]
        XCTAssertEqual(dispatchPillCountdownCardIds(records), ["s"])
        XCTAssertEqual(dispatchPillCountdownText(defaultAllowAt: 10_500, now: Date(timeIntervalSince1970: 0)),
                       "Switching in 11 s unless you press ✕", "the card's own refuse is the ✕")
        XCTAssertEqual(dispatchPillCountdownText(defaultAllowAt: 0, now: Date(timeIntervalSince1970: 1)), "Switching…")
    }

    // MARK: - The question card's ✓

    private func question(_ text: String, multi: Bool = false) -> SessionEvent.Question {
        SessionEvent.Question(question: text, header: "Pick", options: [
            SessionEvent.QuestionOption(label: "Alpha", description: nil),
            SessionEvent.QuestionOption(label: "Beta", description: nil),
        ], multiSelect: multi)
    }

    func testSendIsDisabledUntilAnOptionIsChosenOrOtherHasText() {
        let qs = [question("Which?")]
        var draft = PendingCardDraft()
        XCTAssertEqual(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: false).action, .send)
        XCTAssertFalse(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: false).enabled,
                       "nothing chosen: ✓ is there, and disabled")
        draft.selectSingle(1, forQuestion: 0)
        XCTAssertTrue(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: false).enabled,
                      "a single choice: ✓ sends it (the click itself sends nothing)")
        draft = PendingCardDraft()
        draft.setOtherText("   ", forQuestion: 0)
        XCTAssertFalse(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: false).enabled,
                       "blank Other text is no answer")
        draft.setOtherText("Gamma", forQuestion: 0)
        XCTAssertTrue(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: false).enabled)
        XCTAssertFalse(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: true).enabled,
                       "never while a send is in flight")
    }

    func testAMultipleChoiceQuestionSendsOnlyWithSomethingTicked() {
        let qs = [question("Which ones?", multi: true)]
        var draft = PendingCardDraft()
        draft.toggleMulti(0, forQuestion: 0)
        draft.toggleMulti(1, forQuestion: 0)
        XCTAssertTrue(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: false).enabled)
        XCTAssertEqual(questionAnswers(for: qs, selections: draft.selections, otherTexts: draft.otherTexts),
                       ["Which ones?": "Alpha, Beta"])
        draft.toggleMulti(0, forQuestion: 0)
        draft.toggleMulti(1, forQuestion: 0)
        XCTAssertFalse(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: false).enabled,
                       "unticked again: nothing to send")
    }

    func testAMultiQuestionAskWalksWithNextAndSendsOnlyWhenEveryQuestionIsAnswered() {
        let qs = [question("First?"), question("Second?")]
        var draft = PendingCardDraft()
        var step = dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: false)
        XCTAssertEqual(step.action, .next)
        XCTAssertFalse(step.enabled, "Next waits for this question's answer")
        draft.selectSingle(0, forQuestion: 0)
        step = dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 0, inFlight: false)
        XCTAssertTrue(step.enabled)
        step = dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 1, inFlight: false)
        XCTAssertEqual(step.action, .send)
        XCTAssertFalse(step.enabled)
        draft.setOtherText("my own", forQuestion: 1)
        XCTAssertTrue(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 1, inFlight: false).enabled)
        // Clearing the first answer (going back and typing then deleting Other) disables Send again.
        draft.setOtherText("", forQuestion: 0)
        XCTAssertFalse(dispatchPillQuestionAdvance(questions: qs, draft: draft, index: 1, inFlight: false).enabled)
    }

    // MARK: - Words and size

    func testTheHeaderNamesWhoIsAsking() {
        let own = InteractionRecord(callId: "a", ask: .approval(toolName: "Bash", summary: "ls"))
        XCTAssertEqual(dispatchPillCardHeader(own, childTitle: nil), "Dispatch · Bash")
        let child = InteractionRecord(callId: "q", ask: .question(questions: []), childSessionId: "c1")
        XCTAssertEqual(dispatchPillCardHeader(child, childTitle: "release"), "release asks")
        XCTAssertEqual(dispatchPillCardHeader(child, childTitle: nil), "A session asks")
        let link = InteractionRecord(callId: "e", ask: .urlElicitation(serverName: "GitHub", message: "", host: "github.com",
                                                                     origin: "https://github.com", expiresAt: 0))
        XCTAssertEqual(dispatchPillCardHeader(link, childTitle: nil), "GitHub · github.com")
    }

    func testTheTrailingWordsCountQuestionsAndWaitingAsks() {
        XCTAssertNil(dispatchPillCardTrailing(questionIndex: 0, questionCount: 1, waiting: 0))
        XCTAssertEqual(dispatchPillCardTrailing(questionIndex: 1, questionCount: 3, waiting: 0), "2 of 3")
        XCTAssertEqual(dispatchPillCardTrailing(questionIndex: 0, questionCount: 1, waiting: 2), "+2 waiting")
        XCTAssertEqual(dispatchPillCardTrailing(questionIndex: 0, questionCount: 2, waiting: 1), "1 of 2 · +1 waiting")
        XCTAssertEqual(dispatchPillSetAsideLabel(1), "1 waiting for you")
        XCTAssertEqual(dispatchPillSetAsideLabel(3), "3 waiting for you")
    }

    func testTheCardIsSizedToItsMeasuredContentAndKeepsATypingPillsWidth() {
        let compact = dispatchPillCardSize(presentation: .compact, measuredHeight: 214.3, visibleFrame: visible)
        XCTAssertEqual(compact, CGSize(width: DispatchPillMetrics.cardWidth, height: 215))
        let typing = dispatchPillCardSize(presentation: .expanded, measuredHeight: 180, visibleFrame: visible)
        XCTAssertEqual(typing.width, DispatchPillMetrics.expandedWidth, "a card never narrows the typing pill")
        let unmeasured = dispatchPillCardSize(presentation: .compact, measuredHeight: 0, visibleFrame: visible)
        XCTAssertEqual(unmeasured.height, DispatchPillMetrics.cardEstimatedHeight)
        let huge = dispatchPillCardSize(presentation: .compact, measuredHeight: 5000, visibleFrame: visible)
        XCTAssertEqual(huge.height, DispatchPillMetrics.maxCardHeight)
        let shortScreen = dispatchPillCardSize(presentation: .compact, measuredHeight: 5000,
                                               visibleFrame: CGRect(x: 0, y: 0, width: 1024, height: 500))
        XCTAssertEqual(shortScreen.height, 350, "never taller than the screen leaves room for")
    }

    func testASwapsNewContentStaysHiddenUntilTheShapeIsNearlyThereThenFadesIn() {
        let pill = CGSize(width: 316, height: 44)
        let card = CGSize(width: 440, height: 244)
        XCTAssertEqual(dispatchPillContentReveal(origin: pill, size: pill, target: card), 0, "nothing at the start")
        XCTAssertEqual(dispatchPillContentReveal(origin: pill, size: CGSize(width: 390, height: 160), target: card), 0,
                       "still hidden past half way (58 % of the height)")
        let late = dispatchPillContentReveal(origin: pill, size: CGSize(width: 430, height: 214), target: card)
        XCTAssertGreaterThan(late, 0)
        XCTAssertLessThan(late, 1, "fading in over the last stretch")
        XCTAssertEqual(dispatchPillContentReveal(origin: pill, size: card, target: card), 1, "whole at rest")
        XCTAssertEqual(dispatchPillContentReveal(origin: card, size: card, target: card), 1, "a swap with nowhere to go")
        // The collapse is the same rule the other way: the pill's own content comes back near the end.
        XCTAssertEqual(dispatchPillContentReveal(origin: card, size: CGSize(width: 380, height: 150), target: pill), 0)
        XCTAssertEqual(dispatchPillContentBlur(visibility: 0), DispatchPillMetrics.maxMorphBlur)
        XCTAssertEqual(dispatchPillContentBlur(visibility: 1), 0)
    }

    func testEscOnACardLetsGoOfTheKeyboardAndNeverInterrupts() {
        var interrupted = false
        let action = dispatchPillEscAction(cardFront: true, presentation: .compact, previewing: false,
                                           escConsumed: { interrupted = true; return true })
        XCTAssertEqual(action, .rest)
        XCTAssertFalse(interrupted, "Esc on a card neither answers it nor stops the turn")
        XCTAssertEqual(dispatchPillEscAction(cardFront: false, presentation: .compact, previewing: false,
                                             escConsumed: { true }), .interrupt)
    }

    // MARK: - The controller: the session's own state drives the morph

    private func pill(_ seed: (inout OrbSessionState) -> Void = { _ in }) -> (DispatchPillController, SessionModel) {
        let session = SessionModel()
        session.applyForTesting { s in
            s.status = .idle
            seed(&s)
        }
        // A throwaway suite, never written: the test host is the app, and `.standard` is the dev app's preferences.
        let settings = DispatchPillSettings(defaults: UserDefaults(suiteName: "WinterTests.DispatchPill.cards")!)
        let pill = DispatchPillController(session: session, settings: settings)
        pill.visibleFrameOverrideForTesting = visible
        pill.setPresentationForTesting(.compact)
        return (pill, session)
    }

    private func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }

    private func approvalItem(_ callId: String, outcome: InteractionRecord.Outcome? = nil) -> ActivityItem {
        ActivityItem(kind: .interaction(InteractionRecord(callId: callId, ask: .approval(toolName: "bash", summary: "git push"),
                                                          childSessionId: "c1", outcome: outcome)))
    }

    func testThePillMorphsIntoTheCardAndBackWhenTheAskIsAnsweredElsewhere() {
        let (p, session) = pill()
        XCTAssertEqual(p.morph.target, CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight))
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [self.approvalItem("a1")])]
        }
        settle()
        XCTAssertEqual(p.cardQueue.front, "a1")
        XCTAssertTrue(p.cardShowsOnPill)
        XCTAssertEqual(p.morph.target.width, DispatchPillMetrics.cardWidth, "the main pill's own shape is the card")
        p.setCardContentHeightForTesting(176)
        XCTAssertEqual(p.morph.target, CGSize(width: DispatchPillMetrics.cardWidth, height: 176))
        // A second ask queues behind it.
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [self.approvalItem("a1"), self.approvalItem("a2")])]
        }
        settle()
        XCTAssertEqual(p.cardQueue.front, "a1")
        XCTAssertEqual(p.cardQueue.waiting, 1)
        // The island answers a1: a2 takes the pill.
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [
                self.approvalItem("a1", outcome: .approval(approved: true, by: "island")), self.approvalItem("a2")])]
        }
        settle()
        XCTAssertEqual(p.cardQueue.front, "a2")
        // The phone answers a2: the pill is a pill again.
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [
                self.approvalItem("a1", outcome: .approval(approved: true, by: "island")),
                self.approvalItem("a2", outcome: .approval(approved: false, by: "iphone-gateway"))])]
        }
        settle()
        XCTAssertNil(p.cardQueue.front)
        XCTAssertFalse(p.cardShowsOnPill)
        XCTAssertEqual(p.morph.target, CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight))
    }

    func testTypingUnderTheCardSetsItAsideAndSendingBringsItBack() {
        let (p, session) = pill()
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [self.approvalItem("a1")])]
        }
        settle()
        XCTAssertTrue(p.cardShowsOnPill)
        p.adapter.composerDraft = "w"
        settle()
        XCTAssertFalse(p.cardShowsOnPill, "the keystroke landed in the composer under the card")
        XCTAssertEqual(p.presentation, .expanded, "and the pill is the typing pill")
        XCTAssertEqual(p.setAsideCardCount, 1, "the card waits above the pill")
        p.adapter.composerDraft = ""
        settle()
        XCTAssertTrue(p.cardShowsOnPill, "an empty composer brings the card back")
        XCTAssertEqual(p.setAsideCardCount, 0)
    }

    func testFullScreenNeverMorphsIntoTheCard() {
        let (p, session) = pill()
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [self.approvalItem("a1")])]
        }
        settle()
        p.setPresentationForTesting(.fullScreen)
        XCTAssertFalse(p.cardShowsOnPill, "full screen draws the ask inline in its transcript")
        XCTAssertGreaterThan(p.morph.target.width, DispatchPillMetrics.expandedWidth)
        p.setPresentationForTesting(.compact)
        XCTAssertTrue(p.cardShowsOnPill, "leaving full screen with the ask pending: the pill becomes its card")
    }

    // MARK: - Return under a card never sends the hidden draft (a real, shown pill)

    private var shown: [DispatchPillController] = []

    override func tearDown() async throws {
        shown.forEach { $0.hide() }
        shown.removeAll()
        try await super.tearDown()
    }

    private func shownPill() -> (DispatchPillController, SessionModel, () -> [String]) {
        let (p, session) = pill()
        shown.append(p)
        let sent = SentBox()
        p.onSubmit = { text in await sent.add(text); return true }
        p.show()
        return (p, session, { sent.texts })
    }

    @MainActor private final class SentBox {
        var texts: [String] = []
        func add(_ text: String) { texts.append(text) }
    }

    private func waitUntil(_ timeout: TimeInterval = 3, _ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    }

    /// The card holds the pill over a non-empty draft: Return (the composer's submit) sends nothing, the draft stays,
    /// and the composer cannot take the keyboard.
    private func assertReturnSendsNothing(_ p: DispatchPillController, sent: () -> [String], draft: String,
                                          file: StaticString = #filePath, line: UInt = #line) {
        waitUntil { p.cardShowsOnPill }
        XCTAssertTrue(p.cardShowsOnPill, file: file, line: line)
        XCTAssertEqual(p.adapter.composerDraft, draft, file: file, line: line)
        p.submit(p.adapter.composerDraft)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertTrue(sent().isEmpty, "Return under a card must not send the hidden draft", file: file, line: line)
        XCTAssertEqual(p.adapter.composerDraft, draft, "the draft is kept", file: file, line: line)
        waitUntil { p.composerTextViewForTesting != nil }
        if let textView = p.composerTextViewForTesting {
            XCTAssertFalse(textView.acceptsFirstResponder, "the composer refuses the keyboard under a card",
                           file: file, line: line)
            XCTAssertFalse(textView.window?.firstResponder === textView, file: file, line: line)
        }
    }

    func testBringingSetAsideCardsBackOverADraftNeverSendsIt() {
        let (p, session, sent) = shownPill()
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [self.approvalItem("a1")])]
        }
        waitUntil { p.cardShowsOnPill }
        p.adapter.composerDraft = "half a message"
        waitUntil { p.setAsideCardCount == 1 && !p.cardShowsOnPill }
        XCTAssertEqual(p.setAsideCardCount, 1, "typing set the card aside")
        p.bringBackCards()
        assertReturnSendsNothing(p, sent: sent, draft: "half a message")
    }

    func testAPillShownWithARestoredDraftUnderACardNeverSendsIt() {
        let (p, session, sent) = shownPill()
        p.adapter.composerDraft = "restored later"
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        p.hide() // stashes the draft
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [self.approvalItem("a1")])]
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        p.show() // restores it — no typing sink runs — with the card already waiting
        assertReturnSendsNothing(p, sent: sent, draft: "restored later")
    }

    func testLeavingFullScreenWithADraftUnderACardNeverSendsIt() {
        let (p, session, sent) = shownPill()
        p.adapter.composerDraft = "typed before full screen"
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        p.requestFullScreen()
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [self.approvalItem("a1")])]
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertFalse(p.cardShowsOnPill, "full screen draws the ask inline")
        p.closeFullScreen()
        XCTAssertEqual(p.presentation, .expanded, "back to the typing pill, its draft kept")
        assertReturnSendsNothing(p, sent: sent, draft: "typed before full screen")
    }

    func testWithTheCardAnsweredReturnSendsTheDraftAgain() {
        let (p, session, sent) = shownPill()
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [self.approvalItem("a1")])]
        }
        waitUntil { p.cardShowsOnPill }
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [
                self.approvalItem("a1", outcome: .approval(approved: true, by: "island"))])]
        }
        waitUntil { !p.cardHoldsPill }
        p.adapter.composerDraft = "now it can go"
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        p.submit(p.adapter.composerDraft)
        waitUntil { !sent().isEmpty }
        XCTAssertEqual(sent(), ["now it can go"])
    }
}
