import XCTest
import WinterProtocol
import WinterSessionKit

/// The thinking pill's shared fold (2026-10-05) — used by the Mac app's `SessionReducer` and the phone's
/// transcript builder alike: deltas build one item per `blockId`, the persisted block replaces it, and
/// the label reads title → "Thinking" (live) → "Thought" (done).
final class ThinkingItemTests: XCTestCase {
    private func delta(_ phase: String, kind: String = "summary", text: String? = nil, title: String? = nil,
                       block: String = "rb_1", thread: String = "main") -> SessionEvent.ThinkingDelta {
        SessionEvent.ThinkingDelta(seq: 3, sessionId: "s1", ts: 0, threadId: thread, blockId: block, kind: kind,
                                   phase: phase, text: text, title: title)
    }

    func testStartOpensALiveUntitledPill() {
        let item = ThinkingItem.folding(nil, delta: delta("start"))
        XCTAssertTrue(item.isLive)
        XCTAssertEqual(item.blockId, "rb_1")
        XCTAssertEqual(item.text, "")
        XCTAssertNil(item.title)
        XCTAssertEqual(item.label(turnIsLive: true), "Thinking")
        XCTAssertTrue(item.isRunning(turnIsLive: true))
        // A turn that ended without the block's record reads past tense, never a shimmer forever.
        XCTAssertEqual(item.label(turnIsLive: false), "Thought")
        XCTAssertFalse(item.isRunning(turnIsLive: false))
    }

    func testDeltasAppendTextAndTheTitleChangesOnlyWhenCarried() {
        var item = ThinkingItem.folding(nil, delta: delta("start"))
        item = ThinkingItem.folding(item, delta: delta("delta", text: "**Plan"))
        XCTAssertEqual(item.label(turnIsLive: true), "Thinking")
        item = ThinkingItem.folding(item, delta: delta("delta", text: "ning**\n\nbody", title: "Planning"))
        XCTAssertEqual(item.label(turnIsLive: true), "Planning")
        item = ThinkingItem.folding(item, delta: delta("delta", text: "\n\n**Next"))
        XCTAssertEqual(item.title, "Planning", "an absent title means unchanged, never cleared")
        XCTAssertEqual(item.text, "**Planning**\n\nbody\n\n**Next")
        XCTAssertEqual(item.label(turnIsLive: false), "Planning", "a titled pill keeps its title when done")
    }

    func testHiddenToUpdateFollowsTheLastKind() {
        var item = ThinkingItem.folding(nil, delta: delta("start", kind: "hidden"))
        item = ThinkingItem.folding(item, delta: delta("delta", kind: "update", text: "Reading the schema.", title: "Reading the schema."))
        XCTAssertEqual(item.kind, "update")
        XCTAssertEqual(item.label(turnIsLive: true), "Reading the schema.")
    }

    func testTheBlockReplacesTheLiveItemAndALateDeltaIsIgnored() {
        var item = ThinkingItem.folding(nil, delta: delta("delta", text: "partial"))
        let block = SessionEvent.ThinkingBlock(seq: 9, sessionId: "s1", ts: 0, threadId: "main", blockId: "rb_1", kind: "summary",
                                               title: "Planning", text: "**Planning**\n\nall of it", truncated: nil,
                                               provider: "openai", model: "gpt-5.6-terra", durationMs: 1200)
        item = ThinkingItem(block: block)
        XCTAssertFalse(item.isLive)
        XCTAssertEqual(item.text, "**Planning**\n\nall of it")
        XCTAssertEqual(item.durationMs, 1200)
        XCTAssertEqual(item.label(turnIsLive: true), "Planning")
        let late = ThinkingItem.folding(item, delta: delta("delta", text: "late", title: "Other"))
        XCTAssertEqual(late, item)
    }

    func testAnUntitledDoneBlockSaysThought() {
        let block = SessionEvent.ThinkingBlock(seq: 9, sessionId: "s1", ts: 0, threadId: "main", blockId: "rb_2", kind: "hidden", text: "")
        let item = ThinkingItem(block: block)
        XCTAssertEqual(item.label(turnIsLive: true), "Thought")
        XCTAssertFalse(item.isRunning(turnIsLive: true))
    }

    func testLiveTextIsCapped() {
        var item = ThinkingItem.folding(nil, delta: delta("delta", text: String(repeating: "a", count: ThinkingItem.maxTextLength - 2)))
        item = ThinkingItem.folding(item, delta: delta("delta", text: "bcdef"))
        XCTAssertEqual(item.text.count, ThinkingItem.maxTextLength)
        XCTAssertTrue(item.truncated)
        XCTAssertTrue(item.text.hasSuffix("bc"))
    }

    // MARK: - Opaque JSON (the phone's envelopes)

    private func json(_ object: [String: Any]) throws -> SessionEvent.JSONValue {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(SessionEvent.JSONValue.self, from: data)
    }

    func testJSONFoldMatchesTheTypedFold() throws {
        let start = try json(["type": "thinking_delta", "seq": 3, "sessionId": "s1", "ts": 0, "threadId": "main",
                              "blockId": "rb_1", "kind": "summary", "phase": "start"])
        XCTAssertEqual(ThinkingItem.blockId(of: start), "rb_1")
        var item = try XCTUnwrap(ThinkingItem.folding(nil, json: start))
        let d = try json(["type": "thinking_delta", "seq": 3, "sessionId": "s1", "ts": 0, "threadId": "main",
                          "blockId": "rb_1", "kind": "summary", "phase": "delta", "text": "**Plan**", "title": "Plan"])
        item = try XCTUnwrap(ThinkingItem.folding(item, json: d))
        XCTAssertEqual(item.label(turnIsLive: true), "Plan")
        let block = try json(["type": "thinking_block", "seq": 4, "sessionId": "s1", "ts": 0, "threadId": "main",
                              "blockId": "rb_1", "kind": "summary", "title": "Plan", "text": "**Plan**", "durationMs": 10])
        item = try XCTUnwrap(ThinkingItem.folding(item, json: block))
        XCTAssertFalse(item.isLive)
        XCTAssertEqual(item.durationMs, 10)
    }

    func testJSONFoldIgnoresOtherEvents() throws {
        let other = try json(["type": "assistant_message", "seq": 3, "sessionId": "s1", "ts": 0, "threadId": "main", "text": "hi"])
        XCTAssertNil(ThinkingItem.folding(nil, json: other))
        XCTAssertNil(ThinkingItem.blockId(of: other))
    }
}
