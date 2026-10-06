import XCTest
import WinterProtocol
@testable import Winter

/// Opening pills into themselves (2026-10-06): the copy button only on a turn's final reply, a search
/// pill's websites, the Mac's live reasoning text, and which pills are open.
@MainActor
final class PillExpansionTests: XCTestCase {
    private func ev(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> SessionEvent {
        do {
            return try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        } catch {
            XCTFail("undecodable SessionEvent fixture: \(error)\n\(json)", file: file, line: line)
            return .turnStarted(.init(seq: 0, sessionId: "s", ts: 0, threadId: "main"))
        }
    }
    private func userMessage(_ text: String = "go") -> SessionEvent {
        ev(#"{"type":"user_message","seq":1,"sessionId":"s","ts":0,"threadId":"main","text":"\#(text)","clientName":"cli"}"#)
    }
    private func turnStarted() -> SessionEvent { ev(#"{"type":"turn_started","seq":2,"sessionId":"s","ts":0,"threadId":"main"}"#) }
    private func turnCompleted() -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":9,"sessionId":"s","ts":0,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#)
    }
    private func toolCall(_ name: String = "bash", callId: String) -> SessionEvent {
        ev(#"{"type":"tool_call","seq":3,"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","name":"\#(name)","argsJson":"{}"}"#)
    }
    private func reply(_ text: String) -> SessionEvent {
        ev(#"{"type":"assistant_message","seq":8,"sessionId":"s","ts":0,"threadId":"main","text":"\#(text)"}"#)
    }
    private func delta(_ phase: String, block: String = "rb_1", kind: String = "exposed", text: String? = nil,
                       thread: String = "main") -> SessionEvent {
        var fields = #""type":"thinking_delta","seq":2,"sessionId":"s","ts":0,"threadId":"\#(thread)","blockId":"\#(block)","kind":"\#(kind)","phase":"\#(phase)""#
        if let text { fields += #","text":"\#(text)""# }
        return ev("{\(fields)}")
    }
    private func block(_ id: String = "rb_1", kind: String = "exposed", text: String = "") -> SessionEvent {
        ev(#"{"type":"thinking_block","seq":5,"sessionId":"s","ts":0,"threadId":"main","blockId":"\#(id)","kind":"\#(kind)","text":"\#(text)","durationMs":900}"#)
    }
    private func exchange(_ events: [SessionEvent]) -> Exchange {
        let session = SessionModel()
        session.apply(contentsOf: events)
        return session.state.exchanges.last!
    }

    // MARK: - Copy button: the final reply only

    func testADoneTurnCopiesOnlyItsFinalReply() {
        let x = exchange([userMessage(), turnStarted(), reply("Looking."), toolCall(callId: "c1"),
                          reply("Still looking."), toolCall(callId: "c2"), reply("Here is the answer."), turnCompleted()])
        XCTAssertEqual(x.replies.count, 3)
        XCTAssertEqual(exchangeFinalReplyIndex(x, isStreaming: false), 2)
    }

    func testALiveTurnCopiesNoReplyWithActivityAfterIt() {
        let x = exchange([userMessage(), turnStarted(), reply("Looking."), toolCall(callId: "c1")])
        XCTAssertNil(exchangeFinalReplyIndex(x, isStreaming: false), "a tool call follows the only reply")
    }

    func testALiveTurnsNewestReplyCopiesOnlyWhileNothingFollowsIt() {
        let x = exchange([userMessage(), turnStarted(), toolCall(callId: "c1"), reply("Done, I think.")])
        XCTAssertEqual(exchangeFinalReplyIndex(x, isStreaming: false), 0)
        XCTAssertNil(exchangeFinalReplyIndex(x, isStreaming: true), "a reply streaming in after it follows it")
    }

    func testThinkingAfterAReplyCountsAsFollowingIt() {
        let x = exchange([userMessage(), turnStarted(), reply("Let me think."), block("b1", kind: "summary", text: "hmm")])
        XCTAssertNil(exchangeFinalReplyIndex(x, isStreaming: false))
    }

    func testActivityThatDrawsNothingDoesNotCountAsFollowing() {
        var x = Exchange(prompt: "p", reply: "")
        x.appendReply("Final words.")
        x.appendActivityItem(ActivityItem(kind: .task(subject: "t", status: "completed")))
        XCTAssertEqual(exchangeFinalReplyIndex(x, isStreaming: false), 0)
    }

    func testAnExchangeWithNoReplyHasNoCopyButton() {
        let x = exchange([userMessage(), turnStarted(), toolCall(callId: "c1"), turnCompleted()])
        XCTAssertNil(exchangeFinalReplyIndex(x, isStreaming: false))
    }

    // MARK: - A search's websites

    private func call(detail: String? = "swift layout", output: String? = nil, isError: Bool = false,
                      icons: [(String, String)] = []) -> ToolCallRecord {
        ToolCallRecord(callId: UUID().uuidString, detail: detail, output: output, isError: isError,
                       siteIcons: icons.map { SiteIconRef(url: $0.0, iconUrl: $0.1) })
    }

    func testSitesComeFromSiteIconsWithTheirIcons() {
        let sites = pillSearchSites([call(icons: [("https://www.apple.com/swift/", "https://www.apple.com/favicon.ico"),
                                                  ("https://developer.apple.com/documentation/swiftui/layout?lang=swift",
                                                   "https://developer.apple.com/icon.png")])])
        XCTAssertEqual(sites.map(\.displayHost), ["apple.com", "developer.apple.com"])
        XCTAssertEqual(sites[0].host, "www.apple.com")
        XCTAssertEqual(sites[0].path, "/swift/")
        XCTAssertEqual(sites[0].iconURL, "https://www.apple.com/favicon.ico")
        XCTAssertEqual(sites[1].path, "/documentation/swiftui/layout?lang=swift")
    }

    func testSitesFallBackToHTTPSURLsInTheOutput() {
        let output = "Results:\n1. [Layout](https://example.com/a/b). See also https://news.ycombinator.com/item?id=1, "
            + "and http://insecure.example.org/x and <https://swift.org/>."
        let sites = pillSearchSites([call(output: output)])
        XCTAssertEqual(sites.map(\.url.absoluteString),
                       ["https://example.com/a/b", "https://news.ycombinator.com/item?id=1", "https://swift.org/"])
        XCTAssertNil(sites[0].iconURL)
        XCTAssertEqual(sites[2].path, "", "a site's root shows only its host")
    }

    func testSiteIconsWinOverTheOutputForTheSameCall() {
        let sites = pillSearchSites([call(output: "https://other.com/x", icons: [("https://a.com/1", "https://a.com/i.png")])])
        XCTAssertEqual(sites.map(\.displayHost), ["a.com"])
    }

    func testSitesAreDedupedByPageInOrderAcrossCalls() {
        let sites = pillSearchSites([
            call(icons: [("https://a.com/x", "https://a.com/i.png"), ("https://b.com/", "https://b.com/i.png")]),
            call(output: "https://A.com/x/ again, https://a.com/y, https://b.com#top"),
        ])
        XCTAssertEqual(sites.map { $0.displayHost + $0.path }, ["a.com/x", "b.com", "a.com/y"])
    }

    func testOnlyPublicHTTPSSitesAreKept() {
        let sites = pillSearchSites([call(icons: [("http://plain.com/", "https://plain.com/i.png"),
                                                  ("https://10.0.0.1/admin", ""),
                                                  ("https://localhost/x", ""),
                                                  ("https://ok.com/", "http://ok.com/insecure.png")])])
        XCTAssertEqual(sites.map(\.displayHost), ["ok.com"])
        XCTAssertNil(sites[0].iconURL, "an icon that is not public https is dropped (the host's favicon.ico stands in)")
    }

    func testAFailedCallsOutputNamesNoSites() {
        XCTAssertTrue(pillSearchSites([call(output: "error fetching https://a.com/", isError: true)]).isEmpty)
    }

    func testQueriesAreEachCallsDetailOnceInOrder() {
        XCTAssertEqual(pillSearchQueries([call(detail: "one"), call(detail: " two "), call(detail: "one"), call(detail: nil)]),
                       ["one", "two"])
    }

    func testOnlySearchPillsOpenInPlace() {
        XCTAssertTrue(PillToolRunHeader.opensInPlace(ToolRunEntry(name: "WebSearch", calls: [])))
        XCTAssertTrue(PillToolRunHeader.opensInPlace(ToolRunEntry(name: "web_search", calls: [])))
        XCTAssertTrue(PillToolRunHeader.opensInPlace(ToolRunEntry(name: "Search", calls: [])))
        XCTAssertFalse(PillToolRunHeader.opensInPlace(ToolRunEntry(name: "bash", calls: [])))
        XCTAssertFalse(PillToolRunHeader.opensInPlace(ToolRunEntry(name: "WebFetch", calls: [])))
    }

    // MARK: - The Mac's live reasoning text

    func testDeltasAppendAndBumpTheRevision() {
        let live = ThinkingLiveText()
        live.fold(delta("start"))
        XCTAssertNil(live.block(for: "rb_1"), "a start carries no text")
        live.fold(delta("delta", text: "Let me "))
        live.fold(delta("delta", text: "read the files."))
        XCTAssertEqual(live.text(for: "rb_1"), "Let me read the files.")
        XCTAssertEqual(live.block(for: "rb_1")?.revision, 2)
        XCTAssertEqual(live.block(for: "rb_1")?.length, "Let me read the files.".utf16.count)
        live.fold(delta("delta", text: ""))
        XCTAssertEqual(live.block(for: "rb_1")?.revision, 2, "an empty increment is no change")
    }

    func testThePersistedBlockReplacesTheLiveText() {
        let live = ThinkingLiveText()
        live.fold(delta("delta", text: "partial"))
        live.fold(block(text: "the whole thing"))
        XCTAssertNil(live.text(for: "rb_1"))
        live.fold(delta("delta", text: " late"))
        XCTAssertNil(live.text(for: "rb_1"), "a delta after the record is ignored")
    }

    func testOnlyTheMainThreadIsKept() {
        let live = ThinkingLiveText()
        live.fold(delta("delta", text: "child", thread: "t_child"))
        XCTAssertNil(live.text(for: "rb_1"))
    }

    func testTheBufferIsCappedAndSaysSo() {
        let live = ThinkingLiveText()
        let chunk = String(repeating: "a", count: 6_000)
        for _ in 0..<4 { live.fold(delta("delta", text: chunk)) }
        XCTAssertEqual(live.block(for: "rb_1")?.length, ThinkingItem.maxTextLength)
        XCTAssertEqual(live.text(for: "rb_1")?.utf16.count, ThinkingItem.maxTextLength)
        XCTAssertEqual(live.block(for: "rb_1")?.truncated, true)
    }

    func testOldBlocksAreDroppedPastTheBound() {
        let live = ThinkingLiveText()
        for i in 0..<(ThinkingLiveText.maxBlocks + 3) { live.fold(delta("delta", block: "b\(i)", text: "x")) }
        XCTAssertEqual(live.countForTesting, ThinkingLiveText.maxBlocks)
        XCTAssertNil(live.text(for: "b0"))
        XCTAssertEqual(live.text(for: "b\(ThinkingLiveText.maxBlocks + 2)"), "x")
    }

    func testTheSessionModelFeedsTheBufferAndTheItemCountsIt() {
        let session = SessionModel()
        session.apply(contentsOf: [userMessage(), turnStarted(), delta("start")])
        session.apply(delta("delta", text: "Let me read "))
        session.apply(contentsOf: [delta("delta", text: "the files.")])
        let adapter = FieldStateAdapter(session: session)
        XCTAssertEqual(adapter.liveThinkingText("rb_1"), "Let me read the files.")
        let item = session.state.exchanges.last!.activity.compactMap(\.thinkingItem).first!
        XCTAssertTrue(item.isLive)
        XCTAssertEqual(item.text, "", "the shared item still carries no live text")
        XCTAssertEqual(item.liveTextLength, "Let me read the files.".utf16.count)
        XCTAssertEqual(thinkingDisplayText(item, liveText: adapter.liveThinkingText(item.blockId)), "Let me read the files.")

        session.apply(block(text: "**Reading** the persisted text"))
        let done = session.state.exchanges.last!.activity.compactMap(\.thinkingItem).first!
        XCTAssertNil(adapter.liveThinkingText("rb_1"))
        XCTAssertEqual(thinkingDisplayText(done, liveText: nil), "**Reading** the persisted text")

        session.reset()
        XCTAssertEqual(session.liveThinking.countForTesting, 0)
    }

    func testAHiddenOrEmptyBlockHasNothingToOpen() {
        let hidden = ThinkingItem(blockId: "b", threadId: "main", kind: "hidden", isLive: false)
        XCTAssertFalse(thinkingHasReadableText(hidden))
        let blank = ThinkingItem(blockId: "b", threadId: "main", kind: "summary", text: "  \n", isLive: false)
        XCTAssertFalse(thinkingHasReadableText(blank))
        let liveNoText = ThinkingItem(blockId: "b", threadId: "main", kind: "exposed", isLive: true)
        XCTAssertFalse(thinkingHasReadableText(liveNoText))
        let liveText = ThinkingItem(blockId: "b", threadId: "main", kind: "exposed", isLive: true, liveTextLength: 4)
        XCTAssertTrue(thinkingHasReadableText(liveText))
        XCTAssertNil(thinkingDisplayText(liveText, liveText: nil), "no buffer (attached mid-block): nothing to show yet")
        let liveHidden = ThinkingItem(blockId: "b", threadId: "main", kind: "hidden", isLive: true, liveTextLength: 4)
        XCTAssertFalse(thinkingHasReadableText(liveHidden))
    }

    func testTheBodyDropsALeadingHeadingThatRepeatsTheTitle() {
        XCTAssertEqual(thinkingBodyText("**Reading files**\n\nI read them.", title: "Reading files"), "I read them.")
        XCTAssertEqual(thinkingBodyText("  **Reading files**  \nI read them.", title: "Reading files"), "I read them.")
        XCTAssertEqual(thinkingBodyText("**Other heading**\n\nBody", title: "Reading files"), "**Other heading**\n\nBody")
        XCTAssertEqual(thinkingBodyText("Let me read **Reading files**", title: "Reading files"), "Let me read **Reading files**")
        XCTAssertEqual(thinkingBodyText("**Reading files**", title: "Reading files"), "**Reading files**",
                       "a block that is ONLY its heading keeps it rather than showing nothing")
        XCTAssertEqual(thinkingBodyText("**Reading files**\n\nx", title: nil), "**Reading files**\n\nx")
    }

    func testOnlyAnObviouslyLongTextGoesStraightIntoTheScrollBox() {
        XCTAssertFalse(pillThinkingTextIsLong("short"))
        XCTAssertTrue(pillThinkingTextIsLong(String(repeating: "word ", count: 600)))
        XCTAssertTrue(pillThinkingTextIsLong(String(repeating: "line\n", count: 30)))
    }

    // MARK: - Which pills are open

    func testExpansionTogglesPerKey() {
        var expansion = TranscriptExpansion()
        expansion.toggle(thinkingExpansionKey("b1"))
        expansion.toggle("call:c1")
        XCTAssertTrue(expansion.contains("thinking:b1"))
        XCTAssertTrue(expansion.contains("call:c1"))
        expansion.toggle("call:c1")
        XCTAssertFalse(expansion.contains("call:c1"))
        XCTAssertTrue(expansion.contains("thinking:b1"), "closing one pill leaves the others")
        expansion.removeAll()
        XCTAssertTrue(expansion.keys.isEmpty)
    }

    func testExpansionKeysAreItemIdentitiesNotPositions() {
        // The same item keeps its key wherever it moves (the reducer's cap shifts positions).
        let entry = ToolRunEntry(name: "WebSearch", calls: [call()])
        let early = transcriptExpansionKey(toolRunExpansionKey([entry], fallbackIndex: 0), exchangeIndex: 3)
        let late = transcriptExpansionKey(toolRunExpansionKey([entry], fallbackIndex: 7), exchangeIndex: 3)
        XCTAssertEqual(early, late)
        // A positional fallback is scoped by its exchange, so two exchanges' "index:0" never collide.
        XCTAssertNotEqual(transcriptExpansionKey("index:0", exchangeIndex: 1), transcriptExpansionKey("index:0", exchangeIndex: 2))
    }

    func testAnOpenPillTakesALineOfItsOwn() {
        let sizes = [CGSize(width: 100, height: 34), CGSize(width: 100, height: 34), CGSize(width: 500, height: 200),
                     CGSize(width: 100, height: 34), CGSize(width: 100, height: 34)]
        XCTAssertEqual(PillFlowLayout.rows(sizes, fullWidth: [false, false, true, false, false], width: 500, spacing: 8),
                       [[0, 1], [2], [3, 4]])
        XCTAssertEqual(PillFlowLayout.rows(sizes.map { _ in CGSize(width: 100, height: 34) },
                                           fullWidth: Array(repeating: false, count: 5), width: 500, spacing: 8),
                       [[0, 1, 2, 3], [4]])
    }
}
