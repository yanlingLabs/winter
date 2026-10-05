import Foundation
import XCTest
import WinterProtocol
@testable import WinterChatKit

/// The thinking pill (2026-10-05) on the phone's own chat engine — a SECOND producer of
/// `thinking_delta`/`thinking_block`. The title cases are the daemon's own
/// (`packages/core/test/projector/thinking.test.ts`), ported one for one: both engines must title a
/// block identically. Everything is scripted; nothing touches the network or a real model.
final class ThinkingTitleTests: XCTestCase {
    private func t(_ kind: String, _ parts: [String]) -> String? { ThinkingTitle.derive(kind: kind, parts: parts) }

    func testSummaryLatestPartsLeadingCompleteHeading() {
        XCTAssertEqual(t("summary", ["**Planning the migration**\n\nI will read the schema."]), "Planning the migration")
        XCTAssertEqual(t("summary", ["**Planning**\n\nbody", "**Checking  the tests**\n\nmore"]), "Checking the tests")
        // A heading must close on its own line.
        XCTAssertNil(t("summary", ["**Checking the\ntests**"]))
        XCTAssertEqual(t("summary", ["  \n**Leading whitespace is fine**"]), "Leading whitespace is fine")
    }

    func testSummaryLastCompleteHeadingAtLineStartAnywhereInThePart() {
        let gemini = "**Reading the schema**\n\nIt has three tables.\n\n**Planning the migration**\n\nTwo steps."
        XCTAssertEqual(t("summary", [gemini]), "Planning the migration")
        // A newer heading still missing its closing ** does not count; the one before it still does.
        XCTAssertEqual(t("summary", ["\(gemini)\n\n**Writing the te"]), "Planning the migration")
        // A bold word mid-line is not a heading, even after a heading.
        XCTAssertEqual(t("summary", ["\(gemini)\n\nthe **users** table first"]), "Planning the migration")
        XCTAssertEqual(t("summary", ["\(gemini)\n  **Indented heading**"]), "Indented heading")
    }

    func testPartialOpeningAndHeadinglessPartsYieldNothing() {
        XCTAssertNil(t("summary", ["**Planning the mig"]))
        XCTAssertNil(t("summary", ["**"]))
        XCTAssertNil(t("summary", ["Plain prose with a **bold** word later"]))
        XCTAssertNil(t("summary", ["****"]))
        XCTAssertNil(t("summary", ["**Done**", "**Next"]))   // the LATEST part decides
        XCTAssertNil(t("summary", []))
    }

    func testUpdateIsTheTextTrimmedAndCollapsed() {
        XCTAssertEqual(t("update", ["  Reading the schema\n before   changing it.  "]), "Reading the schema before changing it.")
        XCTAssertNil(t("update", ["   "]))
    }

    func testExposedTitlesLikeSummaryAndHiddenHasNoTitle() {
        XCTAssertEqual(t("exposed", ["**Looks like a heading**"]), "Looks like a heading")
        XCTAssertEqual(t("exposed", ["Small project. Let me read all the files."]), "Reading all the files")
        XCTAssertNil(t("exposed", ["Raw thoughts with no activity in them."]))
        XCTAssertNil(t("hidden", ["anything"]))
    }

    func testTitleIsCappedWithAnEllipsisInUTF16Units() {
        let long = String(repeating: "word ", count: 100)
        let title = t("update", [long])!
        XCTAssertLessThanOrEqual(title.utf16.count, ThinkingTitle.titleMaxLength)
        XCTAssertTrue(title.hasSuffix("…"))
        let bold = t("summary", ["**\(String(repeating: "x", count: 500))**"])!
        XCTAssertEqual(bold.utf16.count, ThinkingTitle.titleMaxLength)
        // UTF-16, not Characters: 150 emoji are 150 Characters but 300 units — still capped at 200.
        let emoji = t("update", [String(repeating: "😀", count: 150)])!
        XCTAssertLessThanOrEqual(emoji.utf16.count, ThinkingTitle.titleMaxLength)
        XCTAssertTrue(emoji.hasSuffix("…"))
    }

    func testSliceUnitsNeverLeavesHalfASurrogatePair() {
        XCTAssertEqual(ThinkingTitle.sliceUnits("ab😀", 3), "ab")
        XCTAssertEqual(ThinkingTitle.sliceUnits("ab😀", 4), "ab😀")
        XCTAssertEqual(ThinkingTitle.sliceUnits("abc", 10), "abc")
    }
}

/// `ThinkingBlocks` — the port of the daemon projector's block state (`ThinkingBlocks` class).
final class ThinkingBlocksTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var ms = 1_000_000
        private var head = 10
        var now: Int { lock.withLock { ms } }
        func advance(_ d: Int) { lock.withLock { ms += d } }
        var seq: Int { lock.withLock { head } }
        func next() -> Int { lock.withLock { head += 1; return head } }
    }

    private func blocks(_ clock: Clock = Clock()) -> ThinkingBlocks {
        ThinkingBlocks(sessionId: "ses_t", threadId: "main", provider: "codex-oauth", model: "gpt-5.6-terra",
                       stamp: .init(transientSeq: { clock.seq }, nextSeq: { clock.next() }, nowMs: { clock.now }))
    }

    private func p(_ id: String, _ phase: ProviderReasoningProgress.Phase, _ kind: String? = nil,
                   _ text: String? = nil, part: Int? = nil) -> ProviderReasoningProgress {
        ProviderReasoningProgress(blockId: id, phase: phase, kind: kind, text: text, part: part)
    }

    private func delta(_ events: [SessionEvent]) -> SessionEvent.ThinkingDelta? {
        guard events.count == 1, case .thinkingDelta(let d) = events[0] else { return nil }
        return d
    }

    private func block(_ events: [SessionEvent]) -> SessionEvent.ThinkingBlock? {
        guard events.count == 1, case .thinkingBlock(let b) = events[0] else { return nil }
        return b
    }

    func testStartAndDeltaAreTransientAtTheHeadAndEndIsTheOnePersistedBlock() {
        let clock = Clock()
        let b = blocks(clock)
        let start = delta(b.accept(p("rs_1", .start, "hidden")))!
        XCTAssertEqual(start.phase, "start")
        XCTAssertEqual(start.seq, 10, "a transient rides the head")
        XCTAssertNil(start.text)
        XCTAssertNil(start.title)

        let d = delta(b.accept(p("rs_1", .delta, "summary", "**Planning**\n\nI will read it.", part: 0)))!
        XCTAssertEqual(d.phase, "delta")
        XCTAssertEqual(d.kind, "summary")
        XCTAssertEqual(d.text, "**Planning**\n\nI will read it.")
        XCTAssertEqual(d.title, "Planning")
        XCTAssertEqual(d.seq, 10)

        clock.advance(1500)
        let end = block(b.accept(p("rs_1", .end)))!   // a close naming no kind keeps the last one
        XCTAssertEqual(end.seq, 11, "the persisted block advances the head")
        XCTAssertEqual(end.kind, "summary")
        XCTAssertEqual(end.title, "Planning")
        XCTAssertEqual(end.text, "**Planning**\n\nI will read it.")
        XCTAssertEqual(end.provider, "codex-oauth")
        XCTAssertEqual(end.model, "gpt-5.6-terra")
        XCTAssertEqual(end.durationMs, 1500)
        XCTAssertNil(end.truncated)
        XCTAssertEqual(end.threadId, "main")
        XCTAssertEqual(b.openCount, 0)
        // A second end, or a late delta, for a closed block projects nothing.
        XCTAssertTrue(b.accept(p("rs_1", .end)).isEmpty)
        XCTAssertTrue(b.accept(p("rs_1", .delta, "summary", "late")).isEmpty)
    }

    func testMultiPartSummariesJoinWithABlankLineAndTheTitleFollowsTheLatestPartStickily() {
        let b = blocks()
        _ = b.accept(p("rb_2", .start, "hidden"))
        let d1 = delta(b.accept(p("rb_2", .delta, "summary", "**Plan", part: 0)))!
        XCTAssertEqual(d1.text, "**Plan")
        XCTAssertNil(d1.title, "partial heading: no title yet")
        let d2 = delta(b.accept(p("rb_2", .delta, "summary", "ning**\n\nread the schema", part: 0)))!
        XCTAssertEqual(d2.title, "Planning")
        let d3 = delta(b.accept(p("rb_2", .delta, "summary", "**Check", part: 1)))!
        XCTAssertEqual(d3.text, "\n\n**Check", "the separator rides the increment")
        XCTAssertEqual(d3.title, "Planning", "the CURRENT title rides every text delta — kept, not cleared")
        let d4 = delta(b.accept(p("rb_2", .delta, "summary", "ing the tests**", part: 1)))!
        XCTAssertEqual(d4.title, "Planning", "a heading counts once its LINE is closed (review r2), or at the end")
        let end = block(b.accept(p("rb_2", .end)))!
        XCTAssertEqual(end.text, "**Planning**\n\nread the schema\n\n**Checking the tests**")
        XCTAssertEqual(end.title, "Checking the tests")
        // A client concatenating every increment holds exactly the persisted text.
        XCTAssertEqual([d1, d2, d3, d4].compactMap(\.text).joined(), end.text)
    }

    func testAPartlessBlockFollowsTheNewestHeading() {
        let b = blocks()
        XCTAssertEqual(delta(b.accept(p("rb_g", .delta, "summary", "**Reading the schema**\n\nThree tables.")))?.title, "Reading the schema")
        XCTAssertEqual(delta(b.accept(p("rb_g", .delta, "summary", "\n\n**Planning the")))?.title, "Reading the schema")
        XCTAssertEqual(delta(b.accept(p("rb_g", .delta, "summary", " migration**\n\nTwo steps.")))?.title, "Planning the migration")
        let end = block(b.accept(p("rb_g", .end)))!
        XCTAssertEqual(end.text, "**Reading the schema**\n\nThree tables.\n\n**Planning the migration**\n\nTwo steps.")
        XCTAssertNil(end.durationMs, "a block first seen at a delta has no start to measure from")
    }

    func testTheHeadingScanStaysBoundedAndStickyPastTheWindow() {
        let b = blocks()
        _ = b.accept(p("rb_w", .delta, "summary", "**First**\n\n"))
        _ = b.accept(p("rb_w", .delta, "summary", "\(String(repeating: "word ", count: 2000))\n"))
        XCTAssertEqual(delta(b.accept(p("rb_w", .delta, "summary", "**Second**\n\nmore")))?.title, "Second")
        XCTAssertEqual(delta(b.accept(p("rb_w", .delta, "summary", String(repeating: "x", count: 5000))))?.title, "Second")
    }

    func testAJoiningClientLearnsTheTitleFromTheNextTextDelta() {
        let b = blocks()
        _ = b.accept(p("rb_j", .start, "summary"))
        _ = b.accept(p("rb_j", .delta, "summary", "**Planning**\n\nfirst", part: 0))
        let joined = delta(b.accept(p("rb_j", .delta, "summary", " and more", part: 0)))!
        XCTAssertEqual(joined.text, " and more")
        XCTAssertEqual(joined.title, "Planning")
        XCTAssertTrue(b.accept(p("rb_j", .delta, "summary", "", part: 0)).isEmpty, "no text, no change → nothing")
    }

    func testTheLastKindWinsAndAKindChangeWithNoTextStillReachesThePill() {
        let b = blocks()
        _ = b.accept(p("rb_s", .start, "hidden"))
        _ = b.accept(p("rb_s", .delta, "summary", "I should read the schema first."))
        XCTAssertEqual(block(b.accept(p("rb_s", .end)))?.kind, "summary")

        _ = b.accept(p("rb_k", .start, "hidden"))
        let changed = delta(b.accept(p("rb_k", .delta, "update", "")))!
        XCTAssertEqual(changed.kind, "update")
        XCTAssertNil(changed.text)
        XCTAssertTrue(b.accept(p("rb_k", .delta, "update", "")).isEmpty)
        let update = delta(b.accept(p("rb_k", .delta, "update", "Reading the schema\nbefore changing it.")))!
        XCTAssertEqual(update.title, "Reading the schema before changing it.")
    }

    func testAHiddenBlockPersistsEmptyTextAndNoTitle() {
        let b = blocks()
        _ = b.accept(p("rb_6", .start, "hidden"))
        let hidden = block(b.accept(p("rb_6", .end)))!
        XCTAssertEqual(hidden.kind, "hidden")
        XCTAssertEqual(hidden.text, "")
        XCTAssertNil(hidden.title)
    }

    func testTextIsCappedInUTF16UnitsAndMarkedTruncatedWhileTheTitleStillFollows() throws {
        let b = blocks()
        // 9,999 emoji = 19,998 units; one more emoji would cross 20,000 mid-pair.
        let first = String(repeating: "😀", count: 9_999)
        let d1 = delta(b.accept(p("rb_c", .delta, "summary", "**A**\nz" + first, part: 0)))!
        XCTAssertEqual(d1.text?.utf16.count, 20_000 - 1, "never half a surrogate pair")
        // Cut once, the text stays the HEAD it was: a later increment with no title change is nothing.
        XCTAssertTrue(b.accept(p("rb_c", .delta, "summary", "more", part: 0)).isEmpty)
        let d3 = delta(b.accept(p("rb_c", .delta, "summary", "**B**\n\nx", part: 1)))!
        XCTAssertNil(d3.text, "no more text once the cap is reached")
        XCTAssertEqual(d3.title, "B", "but the title still follows the latest part")
        let end = block(b.accept(p("rb_c", .end)))!
        XCTAssertEqual(end.truncated, true)
        XCTAssertLessThanOrEqual(end.text.utf16.count, ThinkingTitle.textMaxLength)
        XCTAssertEqual(end.title, "B")
        // The persisted record is what the daemon's `sync.push` schema accepts: it encodes and decodes.
        let data = try JSONEncoder().encode(SessionEvent.thinkingBlock(end))
        XCTAssertNoThrow(try JSONDecoder().decode(SessionEvent.self, from: data))
    }

    func testCloseAllClosesEveryOpenBlockOldestFirst() {
        let b = blocks()
        _ = b.accept(p("a", .start, "hidden"))
        _ = b.accept(p("b", .delta, "summary", "**T**"))
        _ = b.accept(p("a", .delta, "summary", "x"))
        let closed = b.closeAll().compactMap { e -> String? in if case .thinkingBlock(let v) = e { return v.blockId } else { return nil } }
        XCTAssertEqual(closed, ["a", "b"])
        XCTAssertTrue(b.closeAll().isEmpty)
        XCTAssertEqual(b.openCount, 0)
    }
}

/// The `/responses` leg: the request asks for a summary, and the stream's reasoning events map onto
/// `ProviderReasoningProgress` the way the agent SDK's adapter maps them onto `reasoning_progress`.
final class ResponsesThinkingTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func client(_ transport: ScriptedResponsesTransport) -> ResponsesClient {
        let clock = t0
        let tokens = TokenSource(state: TokenState(accessToken: "at_1", refreshToken: "rt_1", accountId: "acct_1",
                                                   expiresAt: clock.addingTimeInterval(3600)),
                                 http: ScriptedChatHTTP(), config: AuthFixture.testConfig, now: { clock })
        return ResponsesClient(transport: transport, tokens: tokens, config: AuthFixture.testConfig)
    }

    private func collect(_ stream: AsyncStream<ProviderEvent>) async -> [ProviderEvent] {
        var out: [ProviderEvent] = []
        for await event in stream { out.append(event) }
        return out
    }

    private func progress(_ events: [ProviderEvent]) -> [ProviderReasoningProgress] {
        events.compactMap { if case .reasoningProgress(let p) = $0 { return p } else { return nil } }
    }

    private func body(effort: String?, summary: Bool) async -> [String: Any]? {
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [SSE.completed()])])
        _ = await collect(client(transport).streamTurn(ProviderTurnRequest(
            model: "gpt-5.6-terra", instructions: "sys", input: [.message(role: .user, content: "hi")], tools: [],
            reasoningEffort: effort, requestSummary: summary)))
        return transport.bodyObject()
    }

    func testASummaryIsRequestedOnlyAlongsideReasoning() async {
        let both = await body(effort: "medium", summary: true)
        XCTAssertEqual(both?["reasoning"] as? [String: String], ["effort": "medium", "summary": "auto"])
        XCTAssertEqual(both?["include"] as? [String], ["reasoning.encrypted_content"])
        let effortOnly = await body(effort: "medium", summary: false)
        XCTAssertEqual(effortOnly?["reasoning"] as? [String: String], ["effort": "medium"], "the digest pass asks for none")
        let summaryOnly = await body(effort: nil, summary: true)
        XCTAssertNil(summaryOnly?["reasoning"], "no reasoning → no summary (the daemon's rule)")
    }

    func testReasoningItemsStreamAsStartDeltaEndWithStableBlockIdsAndPerChannelParts() async {
        let transport = ScriptedResponsesTransport([.sse(status: 200, headers: [:], chunks: [
            SSE.frame(["type": "response.output_item.added", "output_index": 0, "item": ["type": "reasoning", "id": "rs_1"]]),
            SSE.frame(["type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "delta": "**Plan**\n\nA"]),
            SSE.frame(["type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "output_index": 0, "summary_index": 1, "delta": "**Check**"]),
            SSE.frame(["type": "response.reasoning_text.delta", "item_id": "rs_1", "output_index": 0, "content_index": 0, "delta": "raw"]),
            SSE.frame(["type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "output_index": 0, "summary_index": 1, "delta": " more"]),
            SSE.reasoningItem(encrypted: "OPAQUE", id: "rs_1", extra: ["summary": [["type": "summary_text", "text": "**Plan**"]]]),
            // An item with no id at all: a minted block id, stable across its events, never `#index`.
            SSE.frame(["type": "response.output_item.added", "output_index": 2, "item": ["type": "reasoning"]]),
            SSE.frame(["type": "response.reasoning_summary_text.delta", "output_index": 2, "summary_index": 0, "delta": "x"]),
            SSE.frame(["type": "response.output_item.done", "output_index": 2, "item": ["type": "reasoning"]]),
            SSE.textDelta("Answer"),
            SSE.completed(),
        ])])
        let events = await collect(client(transport).streamTurn(ProviderTurnRequest(
            model: "m", instructions: nil, input: [], tools: [], reasoningEffort: "low", requestSummary: true)))
        let steps = progress(events)
        XCTAssertEqual(steps.count, 9)
        XCTAssertEqual(steps[0], ProviderReasoningProgress(blockId: "rs_1", phase: .start, kind: "hidden"))
        XCTAssertEqual(steps[1], ProviderReasoningProgress(blockId: "rs_1", phase: .delta, kind: "summary", text: "**Plan**\n\nA", part: 0))
        XCTAssertEqual(steps[2], ProviderReasoningProgress(blockId: "rs_1", phase: .delta, kind: "summary", text: "**Check**", part: 1))
        XCTAssertEqual(steps[3].part, 2, "the text channel's index 0 is a part of its own")
        XCTAssertEqual(steps[3].kind, "summary", "codex rows are readableState: summary")
        XCTAssertEqual(steps[4].part, 1)
        XCTAssertEqual(steps[5], ProviderReasoningProgress(blockId: "rs_1", phase: .end), "the close names no kind")
        let minted = steps[6].blockId
        XCTAssertTrue(minted.hasPrefix("rb_"))
        XCTAssertEqual(steps[6].phase, .start)
        XCTAssertEqual(steps[7], ProviderReasoningProgress(blockId: minted, phase: .delta, kind: "summary", text: "x", part: 0))
        XCTAssertEqual(steps[8], ProviderReasoningProgress(blockId: minted, phase: .end))
        // The opaque item is still captured for continuity, BEFORE its block's close.
        guard let reasoningAt = events.firstIndex(where: { if case .reasoningItem = $0 { return true } else { return false } }),
              let endAt = events.firstIndex(where: { if case .reasoningProgress(let p) = $0 { return p.phase == .end } else { return false } })
        else { return XCTFail("missing events: \(events)") }
        XCTAssertLessThan(reasoningAt, endAt)
        // Nothing the progress events carry is the opaque content.
        XCTAssertFalse(steps.contains { ($0.text ?? "").contains("OPAQUE") })
        // The summary never leaks into the assistant's text.
        let text = events.compactMap { if case .textDelta(let t) = $0 { return t } else { return nil } }.joined()
        XCTAssertEqual(text, "Answer")
    }
}

/// `ChatEngine` emits the pill's events; `LocalChatSession` keeps the persisted half and none of it
/// ever reaches a provider request.
final class ChatEngineThinkingTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("winter-think-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func engine(_ provider: any ChatProvider) -> ChatEngine {
        let clock = t0
        return ChatEngine(provider: provider, now: { clock })
    }
    private func tools() -> ChatToolset {
        ChatToolset(http: ScriptedChatHTTP(), cache: WebFetchCache(), reasoningEffort: "medium")
    }
    private func rp(_ id: String, _ phase: ProviderReasoningProgress.Phase, _ kind: String? = nil,
                    _ text: String? = nil, part: Int? = nil) -> ProviderEvent {
        .reasoningProgress(ProviderReasoningProgress(blockId: id, phase: phase, kind: kind, text: text, part: part))
    }

    func testARoundsBlockStreamsLiveAndPersistsWhenItClosesBeforeTheAnswer() async {
        let provider = ScriptedChatProvider([[
            rp("rs_1", .start, "hidden"),
            rp("rs_1", .delta, "summary", "**Planning**\n\nSECRET_SUMMARY_TEXT", part: 0),
            rp("rs_1", .end),
            .reasoningItem(itemJSON: #"{"type":"reasoning","encrypted_content":"E"}"#),
            .textDelta("Hi"), .done(.endTurn),
        ]])
        let collector = EventCollector()
        let session = ScriptedLocalSession(sessionId: "ses_1", lastSeq: 0)
        await engine(provider).runTurn(session: session, userText: "q", model: "codex-oauth/gpt-5.6-terra",
                                       tools: tools(), emit: collector.callback)

        XCTAssertEqual(collector.types, ["user_message", "turn_started", "thinking_delta", "thinking_delta",
                                         "thinking_block", "assistant_delta", "assistant_message", "turn_completed"])
        XCTAssertTrue(provider.request(0).requestSummary, "the chat turn asks for a readable summary")
        let deltas = collector.all { if case .thinkingDelta(let v) = $0 { return v } else { return nil } }
        XCTAssertEqual(deltas.map(\.seq), [2, 2], "transients ride the head")
        XCTAssertEqual(deltas.map(\.phase), ["start", "delta"])
        XCTAssertEqual(deltas[1].title, "Planning")
        let block = collector.first { if case .thinkingBlock(let v) = $0 { return v } else { return nil } }!
        XCTAssertEqual(block.seq, 3)
        XCTAssertEqual(block.title, "Planning")
        XCTAssertEqual(block.kind, "summary")
        XCTAssertEqual(block.provider, "codex-oauth")
        XCTAssertEqual(block.model, "gpt-5.6-terra")
        XCTAssertEqual(block.durationMs, 0)
        // Persisted seqs stay contiguous around it: the reasoning item took 4.
        XCTAssertEqual(session.reasoningAppends.map(\.seq), [4])
        XCTAssertEqual(collector.first { if case .assistantMessage(let v) = $0 { return v.seq } else { return nil } }, 5)
        XCTAssertEqual(collector.first { if case .turnCompleted(let v) = $0 { return v.seq } else { return nil } }, 6)
        // The summary is display-only: never the assistant's text.
        XCTAssertEqual(collector.first { if case .assistantMessage(let v) = $0 { return v.text } else { return nil } }, "Hi")
    }

    func testABlockLeftOpenIsClosedWhenTheStreamEndsAndOnInterrupt() async {
        // A bare finish with a block mid-stream: its record lands before the agent_error.
        let bare = ScriptedChatProvider([[rp("rs_x", .start, "hidden"), rp("rs_x", .delta, "summary", "**Half**")]])
        let collector = EventCollector()
        await engine(bare).runTurn(session: ScriptedLocalSession(), userText: "q", model: "m",
                                   tools: tools(), emit: collector.callback)
        XCTAssertEqual(collector.types, ["user_message", "turn_started", "thinking_delta", "thinking_delta",
                                         "thinking_block", "agent_error", "turn_completed"])

        // An interrupt mid-block.
        // The heading's line is closed, so the pill showed it — and the cut block keeps it.
        let hanging = HangingProvider(prefix: [rp("rs_y", .start, "hidden"), rp("rs_y", .delta, "summary", "**Busy**\n")])
        let interrupted = EventCollector()
        let eng = engine(hanging)
        let turn = Task {
            await eng.runTurn(session: ScriptedLocalSession(), userText: "x", model: "m",
                              tools: self.tools(), emit: interrupted.callback)
        }
        try? await TestGate.poll { hanging.streaming.isOpen }
        eng.interrupt()
        await turn.value
        XCTAssertEqual(Array(interrupted.types.suffix(2)), ["thinking_block", "turn_completed"])
        XCTAssertEqual(interrupted.first { if case .thinkingBlock(let v) = $0 { return v.title } else { return nil } }, "Busy")
        XCTAssertEqual(interrupted.first { if case .turnCompleted(let v) = $0 { return v.stopReason } else { return nil } }, "aborted")
    }

    func testThinkingNeverReachesTheNextRequestNorTheLogAsATransient() async throws {
        let store = try LocalEventStore(directory: dir)
        let id = "abababab-abab-4bab-8bab-abababababab"
        let s = try await store.createSession(sessionId: id)
        let provider = ScriptedChatProvider([
            // Round 1: thinking, then a tool call (dispatched as unknown — the loop continues).
            [rp("rs_1", .start, "hidden"), rp("rs_1", .delta, "summary", "**Plan**\n\nSECRET_ONE"), rp("rs_1", .end),
             .toolCall(callId: "c1", name: "Nope", argumentsJSON: "{}"), .done(.toolCalls)],
            // Round 2: thinking left open at the answer (closed by the engine).
            [rp("rs_2", .delta, "summary", "SECRET_TWO"), .textDelta("first"), .done(.endTurn)],
            // Turn 2.
            [.textDelta("second"), .done(.endTurn)],
        ])
        let eng = engine(provider)
        await eng.runTurn(session: s, userText: "one", model: "codex-oauth/gpt-5.6-terra", tools: tools(), emit: s.emit)
        await eng.runTurn(session: s, userText: "two", model: "codex-oauth/gpt-5.6-terra", tools: tools(), emit: s.emit)

        // No request — the continued round nor the next turn — carries a byte of reasoning text.
        for i in 0..<provider.requestCount {
            let dump = provider.request(i).input.map { "\($0)" }.joined(separator: "\n")
            XCTAssertFalse(dump.contains("SECRET_ONE") || dump.contains("SECRET_TWO"), "request \(i) leaked reasoning text")
        }
        // The log holds both blocks (they are what `sync.push` replicates) and no transient, contiguous.
        let stored = await store.read(sessionId: id, fromSeq: 0)
        XCTAssertEqual(stored.map(\.seq), Array(1...stored.count))
        XCTAssertFalse(stored.contains { $0.type == "thinking_delta" })
        XCTAssertEqual(stored.filter { $0.type == "thinking_block" }.count, 2)
        XCTAssertTrue(stored.filter { $0.type == "thinking_block" }.allSatisfy { $0.decoded != nil },
                      "every persisted block decodes as the shared SessionEvent")
        // priorInput folds them away: a Mac-authored block (replicated byte-identical, text included)
        // is as invisible as the phone's own.
        s.persist(.thinkingBlock(.init(seq: s.lastSeq + 1, sessionId: id, ts: 0, threadId: "main", blockId: "rb_mac",
                                       kind: "summary", title: "Mac", text: "SECRET_MAC")))
        let prior = s.priorInput().map { "\($0)" }.joined(separator: "\n")
        XCTAssertFalse(prior.contains("SECRET"))
        XCTAssertTrue(prior.contains("first") && prior.contains("second"))
    }

    func testPersistDropsEveryTransient() async throws {
        let store = try LocalEventStore(directory: dir)
        let s = try await store.createSession(sessionId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd")
        s.persist(.thinkingDelta(.init(seq: 2, sessionId: s.sessionId, ts: 0, threadId: "main", blockId: "b",
                                       kind: "summary", phase: "delta", text: "x", title: "T")))
        XCTAssertEqual(s.lastSeq, 1)
        let stored = await store.read(sessionId: s.sessionId, fromSeq: 0)
        XCTAssertEqual(stored.map(\.type), ["session_created"])
    }
}
