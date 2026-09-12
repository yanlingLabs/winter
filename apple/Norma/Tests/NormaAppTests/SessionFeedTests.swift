import XCTest
import WinterProtocol
import WinterKit
@testable import Winter

/// Local copy of AppModelTests' scripted-transport double (AppModelTests.swift :8-27). Deliberate
/// duplication, not an oversight: extracting a shared `TestTransport.swift` helper would require
/// REMOVING these declarations from AppModelTests.swift, and the Task 1 brief's IRON RULE is that
/// AppModelTests.swift passes with ZERO edits (its wire-sequence assertions are the extraction's
/// regression net). So this file gets its own copy instead — renamed (`Feed`-prefixed) so these
/// file-scope declarations can never collide with AppModelTests.swift's copies in the same test
/// target.
final class FeedScriptedTransport: WinterTransport, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    var sent: [String] { lock.lock(); defer { lock.unlock() }; return _sent }

    init() {
        var c: AsyncStream<TransportEvent>.Continuation!
        incoming = AsyncStream { c = $0 }
        cont = c
    }
    func open() async throws {}
    func send(_ data: Data) async throws {
        lock.lock(); defer { lock.unlock() }
        _sent.append(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines))
    }
    func close() { cont.yield(.closed(nil)); cont.finish() }
    func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }
}

func feedLineJSON(_ s: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
}

@MainActor
func feedWaitUntil(_ timeout: TimeInterval = 3, _ cond: @MainActor () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !cond() && Date() < deadline {
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
}

struct FeedTimeoutError: Error {}

/// Bounded wait on an async operation — used where a real bug (e.g. stop() failing to unblock the
/// pump) would otherwise hang the test indefinitely instead of failing it.
func feedWaitWithTimeout(_ seconds: TimeInterval = 3, _ operation: @escaping () async -> Void) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask { await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw FeedTimeoutError()
        }
        try await group.next()
        group.cancelAll()
    }
}

@MainActor
final class SessionFeedTests: XCTestCase {
    func waitUntilSent(_ t: FeedScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    /// Pinned feeds skip session.list entirely: hello, then straight to attach on the pinned id.
    func answerPinnedHandshake(_ t: FeedScriptedTransport) async {
        await waitUntilSent(t, 1)
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
    }

    func testPinnedFeedAttachesItsSessionFromZero() async throws {
        let t = FeedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let startTask = Task { await feed.start() }
        defer { startTask.cancel(); feed.stop() }

        await answerPinnedHandshake(t)
        // attach must follow directly (no session.list on the wire for pinned mode)
        await waitUntilSent(t, 2)
        let attach = feedLineJSON(t.sent[1])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "S1")
        XCTAssertEqual((attach["params"] as? [String: Any])?["fromSeq"] as? Int, 0)
        XCTAssertFalse(t.sent.contains { feedLineJSON($0)["method"] as? String == "session.list" },
                        "pinned mode must never call session.list: \(t.sent)")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await feedWaitUntil { session.state.status != .disconnected }
    }

    func testPinnedFeedAppliesOnlyItsSessionsEvents() async throws {
        let t = FeedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let startTask = Task { await feed.start() }
        defer { startTask.cancel(); feed.stop() }

        await answerPinnedHandshake(t)
        await waitUntilSent(t, 2)
        let attach = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await feedWaitUntil { session.state.status != .disconnected }

        // an event for a DIFFERENT session (S2) must NOT reduce into this feed's SessionModel
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":1,"sessionId":"S2","ts":0,"threadId":"main"}}"#)
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertFalse(session.state.turnRunning, "pinned feed applied another session's event")

        // an event for the pinned session (S1) DOES reduce
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":1,"sessionId":"S1","ts":0,"threadId":"main"}}"#)
        await feedWaitUntil { session.state.turnRunning }
        XCTAssertTrue(session.state.turnRunning)
    }

    func testPinnedFeedIgnoresSessionCreated() async throws {
        let t = FeedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let startTask = Task { await feed.start() }
        defer { startTask.cancel(); feed.stop() }

        await answerPinnedHandshake(t)
        await waitUntilSent(t, 2)
        let attach = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await feedWaitUntil { session.state.status != .disconnected }

        // another harness creates S9 — unlike AppModel's followFocus mode, pinned mode must NOT
        // refocus/attach onto it: no second attach request may appear on the wire.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"S9","ts":5,"scope":"global"}}"#)
        try? await Task.sleep(nanoseconds: 200_000_000)
        let attaches = t.sent.filter { feedLineJSON($0)["method"] as? String == "session.attach" }
        XCTAssertEqual(attaches.count, 1, "pinned mode must never issue a second attach: \(t.sent)")
    }

    func testStopClosesDeliberately() async throws {
        let t = FeedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let startTask = Task { await feed.start() }

        await answerPinnedHandshake(t)
        await waitUntilSent(t, 2)
        let attach = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await feedWaitUntil { session.state.status != .disconnected }

        feed.stop()

        // the pump must exit promptly (start() returns) — bounded wait, not an indefinite await.
        try await feedWaitWithTimeout(3) { await startTask.value }

        // no reconnect attempt trails a deliberate stop: exactly one protocol.hello ever sent.
        try? await Task.sleep(nanoseconds: 200_000_000)
        let hellos = t.sent.filter { feedLineJSON($0)["method"] as? String == "protocol.hello" }
        XCTAssertEqual(hellos.count, 1, "deliberate stop must not trigger a reconnect attempt: \(t.sent)")
    }

    /// Task 5 (2e-iii): `repin(to:)` — the detached window's "switch in place" primitive. A fresh
    /// attach must go out for the NEW id, the OLD session's events must stop reducing, and the NEW
    /// session's events must start reducing — all on the SAME feed/socket (no second `protocol.hello`).
    func testRepinReattachesToNewSessionAndRoutesItsEvents() async throws {
        let t = FeedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let startTask = Task { await feed.start() }
        defer { startTask.cancel(); feed.stop() }

        await answerPinnedHandshake(t)
        await waitUntilSent(t, 2)
        let attachS1 = feedLineJSON(t.sent[1])
        XCTAssertEqual((attachS1["params"] as? [String: Any])?["sessionId"] as? String, "S1")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachS1["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await feedWaitUntil { session.state.status != .disconnected }

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":1,"sessionId":"S1","ts":0,"threadId":"main"}}"#)
        await feedWaitUntil { session.state.turnRunning }
        XCTAssertTrue(session.state.turnRunning)

        async let repinDone: Void = feed.repin(to: "S2")
        await waitUntilSent(t, 3)
        let attachS2 = feedLineJSON(t.sent[2])
        XCTAssertEqual(attachS2["method"] as? String, "session.attach")
        XCTAssertEqual((attachS2["params"] as? [String: Any])?["sessionId"] as? String, "S2")
        XCTAssertEqual((attachS2["params"] as? [String: Any])?["fromSeq"] as? Int, 0)
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachS2["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await repinDone

        XCTAssertEqual(feed.pinnedSessionId, "S2")
        // reset() dropped S1's reducer state — no stale turnRunning survives the repin.
        await feedWaitUntil { !session.state.turnRunning }
        XCTAssertFalse(session.state.turnRunning)

        // a STALE S1 event must no longer reduce — this feed only listens to S2 now.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":2,"sessionId":"S1","ts":0,"threadId":"main"}}"#)
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertFalse(session.state.turnRunning, "stale S1 event must not reduce after repin to S2")

        // a fresh S2 event DOES reduce.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":1,"sessionId":"S2","ts":0,"threadId":"main"}}"#)
        await feedWaitUntil { session.state.turnRunning }
        XCTAssertTrue(session.state.turnRunning)

        // exactly one hello ever went out — repin reuses the same socket, no reconnect.
        let hellos = t.sent.filter { feedLineJSON($0)["method"] as? String == "protocol.hello" }
        XCTAssertEqual(hellos.count, 1, "repin must not open a new connection: \(t.sent)")
    }

    /// `.followFocus` mode never re-pins — `AppModel.focusSession` uses its own `refocus` machinery
    /// instead (SessionFeed's hook composition, not this method). Guard against a caller mistake.
    func testRepinIsANoOpInFollowFocusMode() async throws {
        let t = FeedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .followFocus, session: session)

        await feed.repin(to: "S9")
        XCTAssertNil(feed.pinnedSessionId, "followFocus has no pinned id before OR after a repin() no-op")
        XCTAssertTrue(t.sent.isEmpty, "a no-op repin must never touch the wire")
    }
}
