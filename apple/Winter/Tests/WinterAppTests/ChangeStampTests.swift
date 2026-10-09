import XCTest
import WinterProtocol
@testable import Winter

/// `Exchange` and `ActivityItem` carry a stamp that names their content as of the last change, so `==` —
/// which SwiftUI runs on every transcript row it re-evaluates — answers in O(1) for unchanged content
/// instead of walking every result in the exchange. These pin the contract: equal stamps are equal
/// content, every mutation replaces the stamp, copies share it, and content equality survives for values
/// that were built independently.
final class ChangeStampTests: XCTestCase {
    private func tool(_ output: String? = nil, callId: String = "c1") -> ActivityItem {
        ActivityItem(kind: .tool(name: "computer_v2", detail: "Notes · click", callId: callId, output: output))
    }

    // MARK: - ActivityItem

    func testACopyKeepsTheStampAndAMutationReplacesIt() {
        let a = tool("ok")
        var b = a
        XCTAssertEqual(a.stamp, b.stamp)
        XCTAssertEqual(a, b)

        b.kind = .tool(name: "computer_v2", detail: "Notes · click", callId: "c1", output: "different")
        XCTAssertNotEqual(a.stamp, b.stamp)
        XCTAssertNotEqual(a, b, "a changed item is not equal")
        XCTAssertEqual(a, tool("ok", callId: "c1"), "…and the original is untouched")
    }

    func testEveryFieldAnItemComparesReplacesTheStampWhenItChanges() {
        var item = tool()
        var seen: Set<UInt64> = [item.stamp]
        item.kind = .subagentDone; XCTAssertTrue(seen.insert(item.stamp).inserted)
        item.writtenLines = 12; XCTAssertTrue(seen.insert(item.stamp).inserted)
        item.scriptCode = "await n.state()"; XCTAssertTrue(seen.insert(item.stamp).inserted)
    }

    /// Two items built apart have different stamps and still compare by content — the tests' own idiom
    /// (`XCTAssertEqual(activity, [ActivityItem(kind: …)])`) and a replay compared with a live fold.
    func testIndependentlyBuiltItemsStillCompareByContent() {
        let a = tool("same text")
        let b = tool("same text")
        XCTAssertNotEqual(a.stamp, b.stamp)
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, tool("other text"))
        var withLines = tool("same text")
        withLines.writtenLines = 3
        XCTAssertNotEqual(a, withLines)
        var withScript = tool("same text")
        withScript.scriptCode = "x"
        XCTAssertNotEqual(a, withScript)
    }

    func testStampsAreNeverReused() {
        let stamps = (0..<2_000).map { _ in tool().stamp }
        XCTAssertEqual(Set(stamps).count, stamps.count)
    }

    // MARK: - Exchange

    func testAnExchangeCopyKeepsTheStampAndEveryComparedFieldReplacesIt() {
        let base = Exchange(prompt: "go", reply: "")
        var copy = base
        XCTAssertEqual(base.stamp, copy.stamp)
        XCTAssertEqual(base, copy)

        var seen: Set<UInt64> = [base.stamp]
        copy.prompt = "go on"; XCTAssertTrue(seen.insert(copy.stamp).inserted)
        copy.appendReply("hello"); XCTAssertTrue(seen.insert(copy.stamp).inserted)
        copy.appendActivityItem(tool("a")); XCTAssertTrue(seen.insert(copy.stamp).inserted)
        copy.activity[0].kind = .subagentDone; XCTAssertTrue(seen.insert(copy.stamp).inserted, "an in-place edit of an item counts")
        copy.aborted = true; XCTAssertTrue(seen.insert(copy.stamp).inserted)
        copy.removeActivityItem(at: 0); XCTAssertTrue(seen.insert(copy.stamp).inserted)
        XCTAssertNotEqual(base, copy)
    }

    func testIndependentlyBuiltExchangesStillCompareByContentAndOnlyByContent() {
        let a = Exchange(prompt: "p", reply: "r", activity: [tool("x")])
        let b = Exchange(prompt: "p", reply: "r", activity: [tool("x")])
        XCTAssertNotEqual(a.stamp, b.stamp)
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, Exchange(prompt: "p", reply: "r", activity: [tool("y")]))
        XCTAssertNotEqual(a, Exchange(prompt: "p", reply: "other", activity: [tool("x")]))
        XCTAssertNotEqual(a, Exchange(prompt: "p", reply: "r", activity: [tool("x")], aborted: true))
    }

    /// The live path walks the activity newest first and ends where the difference is; the walk must still find a
    /// difference wherever it sits, and still call independently built equal content equal.
    func testADifferenceAnywhereInALongActivityIsFoundAndEqualContentIsEqual() {
        func items(replacing index: Int? = nil) -> [ActivityItem] {
            (0..<300).map { i in tool(i == index ? "changed" : "out \(i)", callId: "c\(i)") }
        }
        let base = Exchange(prompt: "p", reply: "r", activity: items())
        XCTAssertEqual(base, Exchange(prompt: "p", reply: "r", activity: items()), "built apart, equal by content")
        for index in [0, 1, 149, 150, 298, 299] {
            XCTAssertNotEqual(base, Exchange(prompt: "p", reply: "r", activity: items(replacing: index)), "a change at item \(index)")
        }
        var longer = base
        longer.appendActivityItem(tool("one more", callId: "c300"))
        XCTAssertNotEqual(base, longer, "a different count")
        var shorter = base
        shorter.removeActivityItem(at: 5)
        XCTAssertNotEqual(base, shorter)
        XCTAssertNotEqual(base, Exchange(prompt: "other", reply: "r", activity: items()), "the prompt is compared too")
    }

    /// Two copies of one snapshot that then change in DIFFERENT ways are not equal, even though each
    /// changed once — the stamps are unique per change, not a count.
    func testDivergentCopiesAreNotEqual() {
        let base = Exchange(prompt: "p", reply: "")
        var left = base, right = base
        left.appendActivityItem(tool("left"))
        right.appendActivityItem(tool("right"))
        XCTAssertNotEqual(left.stamp, right.stamp)
        XCTAssertNotEqual(left, right)
    }

    // MARK: - What the reducer keeps

    private func event(_ fields: [String: Any]) -> SessionEvent {
        let json = String(data: try! JSONSerialization.data(withJSONObject: fields.merging(["sessionId": "s"]) { a, _ in a }), encoding: .utf8)!
        return try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    /// The cheapness the whole change is for: folding an event into the NEWEST exchange leaves every earlier
    /// exchange (and so every row SwiftUI would compare for it) with the stamp it had.
    func testFoldingAnEventLeavesEarlierExchangesStamped() {
        var s = OrbSessionState()
        func send(_ text: String, seq: Int) {
            SessionReducer.reduceInPlace(&s, event(["type": "user_message", "seq": seq, "ts": 0, "threadId": "main", "text": text, "clientName": "cli"]))
            SessionReducer.reduceInPlace(&s, event(["type": "turn_started", "seq": seq + 1, "ts": 0, "threadId": "main"]))
            SessionReducer.reduceInPlace(&s, event(["type": "tool_call", "seq": seq + 2, "ts": 0, "threadId": "main", "callId": "c\(seq)", "name": "bash", "argsJson": "{}"]))
            SessionReducer.reduceInPlace(&s, event(["type": "tool_result", "seq": seq + 3, "ts": 0, "threadId": "main", "callId": "c\(seq)", "output": String(repeating: "x", count: 60_000), "isError": false]))
            SessionReducer.reduceInPlace(&s, event(["type": "turn_completed", "seq": seq + 4, "ts": 0, "threadId": "main", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1]))
        }
        send("one", seq: 1)
        send("two", seq: 10)
        let before = s.exchanges.map(\.stamp)
        XCTAssertEqual(before.count, 2)

        SessionReducer.reduceInPlace(&s, event(["type": "user_message", "seq": 20, "ts": 0, "threadId": "main", "text": "three", "clientName": "cli"]))
        SessionReducer.reduceInPlace(&s, event(["type": "turn_started", "seq": 21, "ts": 0, "threadId": "main"]))
        SessionReducer.reduceInPlace(&s, event(["type": "tool_call", "seq": 22, "ts": 0, "threadId": "main", "callId": "c20", "name": "bash", "argsJson": "{}"]))
        XCTAssertEqual(Array(s.exchanges.map(\.stamp).prefix(2)), before, "the two finished exchanges are untouched, so they compare in O(1)")
        XCTAssertEqual(s.exchanges.count, 3)

        // The copying fold (`reduce`) keeps them too: the state SwiftUI last saw vs the one it sees now.
        let old = s
        let next = SessionReducer.reduce(s, event(["type": "tool_result", "seq": 23, "ts": 0, "threadId": "main", "callId": "c20", "output": "ok", "isError": false]))
        XCTAssertEqual(old.exchanges[0].stamp, next.exchanges[0].stamp)
        XCTAssertEqual(old.exchanges[1].stamp, next.exchanges[1].stamp)
        XCTAssertNotEqual(old.exchanges[2].stamp, next.exchanges[2].stamp)
        XCTAssertNotEqual(old.exchanges[2], next.exchanges[2])
    }
}
