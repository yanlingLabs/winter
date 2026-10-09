import XCTest
import Combine
import WinterProtocol
@testable import Winter

/// The thinking pill (2026-10-05): `thinking_delta` builds one live item per reasoning block in the
/// exchange's activity, the persisted `thinking_block` replaces it IN PLACE, a replay sees only the
/// block, and both the pill-themed window and the line transcript read "Thinking" / title / "Thought".
final class ThinkingPillTests: XCTestCase {
    private func ev(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> SessionEvent {
        do {
            return try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        } catch {
            XCTFail("undecodable SessionEvent fixture: \(error)\n\(json)", file: file, line: line)
            return .turnStarted(.init(seq: 0, sessionId: "s", ts: 0, threadId: "main"))
        }
    }
    private func userMessage(_ text: String) -> SessionEvent {
        ev(#"{"type":"user_message","seq":1,"sessionId":"s","ts":0,"threadId":"main","text":"\#(text)","clientName":"cli"}"#)
    }
    private func turnStarted() -> SessionEvent { ev(#"{"type":"turn_started","seq":2,"sessionId":"s","ts":0,"threadId":"main"}"#) }
    private func turnCompleted() -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":9,"sessionId":"s","ts":0,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#)
    }
    private func toolCall(_ name: String, callId: String) -> SessionEvent {
        ev(#"{"type":"tool_call","seq":3,"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","name":"\#(name)","argsJson":"{}"}"#)
    }
    private func reply(_ text: String) -> SessionEvent {
        ev(#"{"type":"assistant_message","seq":8,"sessionId":"s","ts":0,"threadId":"main","text":"\#(text)"}"#)
    }
    private func delta(_ phase: String, block: String = "rb_1", kind: String = "summary", text: String? = nil,
                       title: String? = nil, thread: String = "main") -> SessionEvent {
        var fields = #""type":"thinking_delta","seq":2,"sessionId":"s","ts":0,"threadId":"\#(thread)","blockId":"\#(block)","kind":"\#(kind)","phase":"\#(phase)""#
        if let text { fields += #","text":"\#(text)""# }
        if let title { fields += #","title":"\#(title)""# }
        return ev("{\(fields)}")
    }
    private func block(_ id: String = "rb_1", kind: String = "summary", title: String? = nil, text: String = "",
                       thread: String = "main") -> SessionEvent {
        let titleField = title.map { #","title":"\#($0)""# } ?? ""
        return ev(#"{"type":"thinking_block","seq":5,"sessionId":"s","ts":0,"threadId":"\#(thread)","blockId":"\#(id)","kind":"\#(kind)","text":"\#(text)"\#(titleField),"durationMs":900}"#)
    }

    private func fold(_ events: [SessionEvent]) -> OrbSessionState {
        events.reduce(OrbSessionState()) { SessionReducer.reduce($0, $1) }
    }
    private func thinking(_ s: OrbSessionState) -> [ThinkingItem] {
        (s.exchanges.last?.activity ?? []).compactMap(\.thinkingItem)
    }

    // MARK: - The reducer

    func testDeltasBuildOneLiveItemAndTheTitleArrivesWithTheHeading() {
        var s = fold([userMessage("go"), turnStarted(), delta("start")])
        XCTAssertEqual(thinking(s).count, 1)
        XCTAssertTrue(thinking(s)[0].isLive)
        XCTAssertEqual(pillThinkingLabel(thinking(s)[0], turnIsLive: s.turnRunning), "Thinking")
        s = SessionReducer.reduce(s, delta("delta", text: "**Plan"))
        XCTAssertEqual(pillThinkingLabel(thinking(s)[0], turnIsLive: s.turnRunning), "Thinking")
        s = SessionReducer.reduce(s, delta("delta", text: "ning**", title: "Planning"))
        XCTAssertEqual(thinking(s).count, 1, "one item per block, however many deltas")
        XCTAssertEqual(thinking(s)[0].text, "", "the live item carries no text — O(delta) per delta; the block brings it")
        XCTAssertEqual(thinking(s)[0].liveTextLength, "**Planning**".utf16.count)
        XCTAssertEqual(pillThinkingLabel(thinking(s)[0], turnIsLive: s.turnRunning), "Planning")
        XCTAssertEqual(s.streamingText, "", "thinking never feeds the reply's streaming row")
    }

    // MARK: - Reasoning increments that draw nothing are not published

    func testAnIncrementToABlockThatAlreadyShowsItsTitleChangesNothingAViewDraws() {
        let s = fold([userMessage("go"), turnStarted(), delta("start"), delta("delta", text: "**Plan", title: "Plan")])
        XCTAssertFalse(SessionReducer.thinkingIncrementIsInvisible(delta("start"), in: OrbSessionState()), "a block's first delta opens its pill")
        XCTAssertTrue(SessionReducer.thinkingIncrementIsInvisible(delta("delta", text: "ning"), in: s), "more text, no new title")
        XCTAssertTrue(SessionReducer.thinkingIncrementIsInvisible(delta("delta", text: "ning", title: "Plan"), in: s), "the same title again")
        XCTAssertTrue(SessionReducer.thinkingIncrementIsInvisible(delta("delta", text: "ning", title: "  "), in: s), "a blank title is no title")
        XCTAssertFalse(SessionReducer.thinkingIncrementIsInvisible(delta("delta", text: "ning", title: "Planning"), in: s), "a new title is drawn")
        XCTAssertFalse(SessionReducer.thinkingIncrementIsInvisible(delta("delta", kind: "exposed", text: "ning"), in: s), "a changed kind is drawn")
        XCTAssertFalse(SessionReducer.thinkingIncrementIsInvisible(delta("delta", block: "rb_2", text: "x"), in: s), "another block's first text")
        XCTAssertTrue(SessionReducer.thinkingIncrementIsInvisible(delta("delta", text: "x", thread: "child"), in: s), "a child thread's delta is ignored by the reducer")
        XCTAssertFalse(SessionReducer.thinkingIncrementIsInvisible(block(), in: s), "the persisted block replaces the item")
    }

    @MainActor
    func testTheSessionIsPublishedOnceForAReasoningStreamNotOncePerBatch() {
        let model = SessionModel(notifier: SilentNotifier())
        var publishes = 0
        let cancellable = model.$state.dropFirst().sink { _ in publishes += 1 }
        var liveChanges = 0
        let liveWatch = model.liveThinking.objectWillChange.sink { liveChanges += 1 }
        defer { cancellable.cancel(); liveWatch.cancel() }
        model.apply(userMessage("go"))
        model.apply(turnStarted())
        publishes = 0
        model.apply(contentsOf: [delta("start"), delta("delta", text: "**Plan", title: "Plan")])
        XCTAssertEqual(publishes, 1, "the pill opens, with its title")
        for chunk in ["ning the ", "next steps ", "for the ", "work ahead"] {
            model.apply(contentsOf: [delta("delta", text: chunk)])
        }
        XCTAssertEqual(publishes, 1, "the rest of the stream draws nothing new, so it publishes nothing")
        XCTAssertEqual(model.liveThinking.text(for: "rb_1"), "**Planning the next steps for the work ahead", "but an open pill still reads every word")
        XCTAssertEqual(liveChanges, 5, "and the buffer, which an open pill's text view observes, announced each of the five increments")
        model.apply(contentsOf: [delta("delta", text: "!", title: "Planning")])
        XCTAssertEqual(publishes, 2, "a new title does")
        model.apply(block(title: "Planning", text: "Planning the next steps"))
        XCTAssertEqual(publishes, 3, "and so does the persisted block")
        XCTAssertEqual(thinking(model.state).map(\.isLive), [false])
    }

    func testThePersistedBlockReplacesTheLiveItemInPlace() {
        var s = fold([userMessage("go"), turnStarted(), delta("start"), delta("delta", text: "Reading.", title: "Reading.")])
        s = SessionReducer.reduce(s, toolCall("read", callId: "c1"))
        s = SessionReducer.reduce(s, block(title: "Reading.", text: "Reading."))
        let activity = s.exchanges.last!.activity
        XCTAssertEqual(activity.count, 2)
        XCTAssertNotNil(activity[0].thinkingItem, "the block keeps the place where its pill started")
        XCTAssertFalse(activity[0].thinkingItem!.isLive)
        XCTAssertEqual(activity[0].thinkingItem!.durationMs, 900)
        XCTAssertEqual(activity[0].thinkingItem!.text, "Reading.", "the persisted block brings the text")
        XCTAssertEqual(activity[1].toolCallId, "c1")
        // A late delta for the closed block changes nothing.
        let after = SessionReducer.reduce(s, delta("delta", text: "late", title: "Other"))
        XCTAssertEqual(after.exchanges.last!.activity, activity)
    }

    func testAReplaySeesOnlyTheBlockAndAnUntitledOneSaysThought() {
        let s = fold([userMessage("go"), turnStarted(), block(kind: "hidden"), reply("done"), turnCompleted()])
        XCTAssertEqual(thinking(s).count, 1)
        XCTAssertEqual(pillThinkingLabel(thinking(s)[0], turnIsLive: false), "Thought")
        // The timeline keeps the block above the reply it preceded.
        XCTAssertEqual(exchangeTimeline(s.exchanges.last!).count, 2)
        if case .activity(let items) = exchangeTimeline(s.exchanges.last!)[0] {
            XCTAssertNotNil(items.first?.thinkingItem)
        } else {
            XCTFail("the thinking item should come first")
        }
    }

    func testTwoBlocksAreTwoItems() {
        let s = fold([userMessage("go"), turnStarted(), block("rb_1", title: "One"), toolCall("bash", callId: "c1"), block("rb_2", title: "Two")])
        XCTAssertEqual(thinking(s).map(\.title), ["One", "Two"])
    }

    func testASubagentsThinkingStaysOffTheMainTranscript() {
        let s = fold([userMessage("go"), turnStarted(), delta("start", thread: "toolu_child"), block(thread: "toolu_child")])
        XCTAssertTrue(thinking(s).isEmpty)
    }

    func testABlockWhoseTurnEndedWithoutItsRecordReadsDone() {
        let s = fold([userMessage("go"), turnStarted(), delta("start"), turnCompleted()])
        let item = thinking(s)[0]
        XCTAssertTrue(item.isLive)
        XCTAssertFalse(item.isRunning(turnIsLive: s.turnRunning))
        XCTAssertEqual(pillThinkingLabel(item, turnIsLive: s.turnRunning), "Thought")
    }

    func testNoExchangeNoItem() {
        let s = fold([delta("start")])
        XCTAssertTrue(s.exchanges.isEmpty)
    }

    // MARK: - Grouping and the line row

    func testGroupingKeepsThinkingAsItsOwnRowBetweenToolRuns() {
        let s = fold([userMessage("go"), turnStarted(), toolCall("read", callId: "c1"), block(title: "Plan"), toolCall("read", callId: "c2")])
        let groups = groupActivity(s.exchanges.last!.activity)
        XCTAssertEqual(groups.count, 3)
        if case .single(let item) = groups[1] { XCTAssertEqual(item.thinkingItem?.title, "Plan") } else { XCTFail("thinking is a single row") }
    }

    func testTheLineGlyphAndLabel() {
        let item = ThinkingItem(blockId: "rb", threadId: "main", kind: "update", title: "Reading the schema.", isLive: false)
        XCTAssertEqual(activityGlyphAndLabel(ActivityItem(kind: .thinking(item))).label, "Reading the schema.")
        XCTAssertEqual(activityGlyphAndLabel(ActivityItem(kind: .thinking(item))).glyph, thinkingGlyph)
        let live = ThinkingItem(blockId: "rb", threadId: "main", kind: "hidden", isLive: true)
        XCTAssertEqual(activityGlyphAndLabel(ActivityItem(kind: .thinking(live))).label, "Thinking")
    }

    func testThePillWearsATitleOnOneLineAndTheToolPillsMaterial() {
        XCTAssertEqual(pillThinkingDisc.kind, .tool(symbol: "brain"))
        let titled = ThinkingItem(blockId: "rb", threadId: "main", kind: "summary", title: "Planning the migration", isLive: true)
        XCTAssertEqual(pillThinkingLabel(titled, turnIsLive: true), "Planning the migration")
        XCTAssertEqual(pillThinkingLabel(titled, turnIsLive: false), "Planning the migration")
    }
}

private final class SilentNotifier: NotificationPosting {
    func post(title: String, body: String) {}
}
