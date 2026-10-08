import XCTest
import WinterProtocol
@testable import Winter

/// The held replay (`ReplayBuffer`) and the orb feed that uses it (`AppModel`): a long history arrives held and is
/// folded once, with one publish, never one copy and one publish per event.
@MainActor
final class ReplayBufferTests: XCTestCase {
    static func event(_ fields: [String: Any], session: String = "s_r") -> SessionEvent {
        let json = String(data: try! JSONSerialization.data(withJSONObject: fields.merging(["sessionId": session]) { a, _ in a }), encoding: .utf8)!
        return try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    private func turn(_ n: Int) -> [SessionEvent] {
        [Self.event(["type": "user_message", "seq": n * 10 + 1, "ts": 1, "threadId": "main", "text": "do \(n)", "clientName": "orb"]),
         Self.event(["type": "turn_started", "seq": n * 10 + 2, "ts": 2, "threadId": "main"]),
         Self.event(["type": "tool_call", "seq": n * 10 + 3, "ts": 3, "threadId": "main", "callId": "c\(n)", "name": "bash", "argsJson": #"{"command":"ls"}"#]),
         Self.event(["type": "tool_result", "seq": n * 10 + 4, "ts": 4, "threadId": "main", "callId": "c\(n)", "output": "ok", "isError": false]),
         Self.event(["type": "turn_completed", "seq": n * 10 + 5, "ts": 5, "threadId": "main", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1])]
    }

    func testEventsAreHeldUntilTheCeilingArrivesThenHandedOverOnceInOrder() {
        let buffer = ReplayBuffer()
        var finished: [[Int]] = []
        buffer.onFinish = { finished.append($0.map(\.seq)) }
        let events = (1...4).flatMap(turn)
        XCTAssertFalse(buffer.hold(events[0]), "nothing is held when no replay is expected")
        buffer.begin()
        for event in events.dropLast() { XCTAssertTrue(buffer.hold(event)) }
        XCTAssertEqual(buffer.count, events.count - 1)
        buffer.arm(ceiling: events.last!.seq)
        XCTAssertTrue(finished.isEmpty, "the ceiling has not come")
        XCTAssertTrue(buffer.hold(events.last!))
        XCTAssertEqual(finished, [events.map(\.seq)], "everything, once, in order")
        XCTAssertFalse(buffer.isReplaying)
        XCTAssertFalse(buffer.hold(events[0]), "and live events apply as they come again")
    }

    func testACeilingAlreadyInHandAFailedAttachAndATransientAreAllHandledRight() {
        let buffer = ReplayBuffer()
        var finished = 0
        buffer.onFinish = { _ in finished += 1 }
        let events = turn(1)
        buffer.begin()
        for event in events { _ = buffer.hold(event) }
        buffer.arm(ceiling: events.last!.seq)
        XCTAssertEqual(finished, 1, "the ceiling event was already held")

        buffer.begin()
        buffer.arm(ceiling: nil)
        XCTAssertEqual(finished, 2, "a failed attach has no replay coming")

        buffer.begin()
        buffer.arm(ceiling: 50)
        let transient = Self.event(["type": "assistant_delta", "seq": 99, "ts": 1, "threadId": "main", "delta": "hi"])
        XCTAssertTrue(buffer.hold(transient))
        XCTAssertEqual(finished, 2, "a transient carries the store's last seq: it can never be the ceiling")
        buffer.finish()
        XCTAssertEqual(finished, 3)
    }

    func testTheFallbackFoldsWhatIsHeldWhenTheCeilingNeverComes() async {
        let buffer = ReplayBuffer(fallback: 0.05)
        var finished: [Int] = []
        buffer.onFinish = { finished.append($0.count) }
        buffer.begin()
        _ = buffer.hold(turn(1)[0])
        buffer.arm(ceiling: 1_000)
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(finished, [1])
    }

    // MARK: - The orb feed

    private func handshake(_ t: AppScriptedTransport) async -> Int {
        await waitUntil { t.sent.count >= 1 }
        let hello = lineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntil { t.sent.count >= 2 }
        let list = lineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_r","scope":"global","createdAt":1,"lastSeq":1000,"mode":"dispatch"}]}}"#)
        await waitUntil { t.sent.count >= 3 }
        return lineJSON(t.sent[2])["id"] as! Int
    }

    private func wire(_ event: SessionEvent) -> String {
        let data = try! JSONEncoder().encode(event)
        return #"{"jsonrpc":"2.0","method":"event","params":\#(String(decoding: data, as: UTF8.self))}"#
    }

    /// A long Dispatch history, replayed into the orb feed at launch (the events wait on the stream while the attach
    /// is answered, then the pump takes them): one fold, one publish for the whole of it.
    func testALongReplayIsOneFoldOnTheOrbFeed() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        let attachId = await handshake(t)

        let history = (1...120).flatMap(turn) // 600 events
        var publishes = 0
        let watch = model.session.$state.dropFirst().sink { _ in publishes += 1 }
        for event in history { t.feed(wire(event)) }
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachId),"result":{"ok":true,"lastSeq":\#(history.last!.seq)}}"#)
        await waitUntil { model.session.state.completedTurns == 120 }
        XCTAssertEqual(model.session.state.completedTurns, 120)
        XCTAssertEqual(model.session.state.exchanges.count, 120)
        XCTAssertLessThanOrEqual(publishes, 4, "the markConnected flip and the fold — not 600 (published \(publishes))")
        XCTAssertFalse(model.replay.isReplaying)

        // After the fold, live events apply one by one again.
        let before = publishes
        t.feed(wire(Self.event(["type": "turn_started", "seq": 5_000, "ts": 9, "threadId": "main"])))
        await waitUntil { model.session.state.turnRunning }
        XCTAssertTrue(model.session.state.turnRunning)
        XCTAssertGreaterThan(publishes, before)
        withExtendedLifetime(watch) {}
    }

    /// The pump already running and a refocus asked for from outside it (the sidebar's click): the replay arrives
    /// live, is HELD as it comes, and folds once when the attach answers.
    func testARefocusHoldsTheReplayAsItArrivesAndFoldsItOnce() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        let first = await handshake(t)
        t.feed(#"{"jsonrpc":"2.0","id":\#(first),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        let refocus = Task { await model.focusSession("s_b") }
        defer { refocus.cancel() }
        var attach: [String: Any] = [:]
        for _ in 0..<100 {
            attach = t.sent.map(lineJSON).last { $0["method"] as? String == "session.attach" } ?? [:]
            if (attach["params"] as? [String: Any])?["sessionId"] as? String == "s_b" { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "s_b")

        let events = (1...80).flatMap(turn).map { e -> SessionEvent in
            let data = try! JSONEncoder().encode(e)
            var dict = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
            dict["sessionId"] = "s_b"
            return try! JSONDecoder().decode(SessionEvent.self, from: JSONSerialization.data(withJSONObject: dict))
        }
        var publishes = 0
        let watch = model.session.$state.dropFirst().sink { _ in publishes += 1 }
        for event in events { t.feed(wire(event)) }
        await waitUntil { model.replay.count >= events.count }
        XCTAssertEqual(model.replay.count, events.count, "held as it arrives, none folded")
        XCTAssertEqual(model.session.state.completedTurns, 0)
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":\#(events.last!.seq)}}"#)
        await waitUntil { model.session.state.completedTurns == 80 }
        XCTAssertEqual(model.session.state.completedTurns, 80)
        XCTAssertLessThanOrEqual(publishes, 3, "the reset and the fold (published \(publishes))")
        XCTAssertEqual(model.replay.count, 0)
        withExtendedLifetime(watch) {}
    }

    func testTheMenuBarActivityIsDerivedFromTheStateAFoldedReplayLeavesBehind() {
        var state = OrbSessionState()
        XCTAssertEqual(MenuBarActivity.derived(from: state), .idle)
        let events = turn(1).dropLast() // a turn that is still running, its call answered
        for event in events { state = SessionReducer.reduce(state, event) }
        XCTAssertEqual(MenuBarActivity.derived(from: state), .thinking)
        state = SessionReducer.reduce(OrbSessionState(), turn(2)[0])
        for event in turn(2).dropFirst().prefix(2) { state = SessionReducer.reduce(state, event) }
        XCTAssertEqual(MenuBarActivity.derived(from: state), .working, "a call with no result yet")
        for event in turn(2).suffix(2) { state = SessionReducer.reduce(state, event) }
        XCTAssertEqual(MenuBarActivity.derived(from: state), .idle)
    }
}
