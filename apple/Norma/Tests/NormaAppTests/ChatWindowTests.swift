import XCTest
import AppKit
@testable import Norma

/// Chat Mode Slice A (CM-T3): the Mac chat window — the pure open/create decision
/// (`AppDelegate.chatSessionToOpen`/`chatWindowTitle`) plus a wiring-level smoke test for
/// `AppDelegate.openChat()`/`newChat()`. Mirrors `StandaloneWindowTests`' own split (pure geometry
/// helper + `openStandaloneNormaWindow()` wiring smoke tests) — the successful spawn path itself
/// (feed → controller → native window) is already covered end-to-end by `DetachedWindowTests`,
/// deliberately not duplicated here.
@MainActor
final class ChatWindowTests: XCTestCase {
    func waitUntilSent(_ t: AppScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    // MARK: - AppDelegate.chatSessionToOpen(in:) (PURE)

    func testChatSessionToOpenPicksNewestChatRow() {
        let rows = [
            SessionSummary(sessionId: "s_a", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "chat"),
            SessionSummary(sessionId: "s_b", title: nil, createdAt: 5, scope: "global", cwd: nil, mode: "chat"),
            SessionSummary(sessionId: "s_c", title: nil, createdAt: 3, scope: "global", cwd: nil, mode: "chat"),
        ]
        XCTAssertEqual(AppDelegate.chatSessionToOpen(in: rows), "s_b")
    }

    /// The newest row OVERALL is code/dispatch — the pure helper must skip both entirely and pick
    /// the newest CHAT row instead, same "positive match only" shape as `AppModel.
    /// focusNewestSession()`'s own dispatch-only filter.
    func testChatSessionToOpenIgnoresCodeAndDispatchRows() {
        let rows = [
            SessionSummary(sessionId: "s_chat_old", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "chat"),
            SessionSummary(sessionId: "s_dispatch_new", title: nil, createdAt: 99, scope: "global", cwd: nil, mode: "dispatch"),
            SessionSummary(sessionId: "s_code_new", title: nil, createdAt: 50, scope: "global", cwd: nil, mode: "code"),
            SessionSummary(sessionId: "s_absent_new", title: nil, createdAt: 40, scope: "global", cwd: nil, mode: nil),
        ]
        XCTAssertEqual(AppDelegate.chatSessionToOpen(in: rows), "s_chat_old", "must pick the only chat row, ignoring every newer non-chat one")
    }

    func testChatSessionToOpenReturnsNilWithNoChatRows() {
        let rows = [
            SessionSummary(sessionId: "s_dispatch", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "dispatch"),
            SessionSummary(sessionId: "s_code", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "code"),
        ]
        XCTAssertNil(AppDelegate.chatSessionToOpen(in: rows))
    }

    func testChatSessionToOpenReturnsNilOnEmptyRows() {
        XCTAssertNil(AppDelegate.chatSessionToOpen(in: []))
    }

    // MARK: - AppDelegate.chatWindowTitle(_:) (PURE)

    func testChatWindowTitleFallsBackToChatWhenNilOrBlank() {
        XCTAssertEqual(AppDelegate.chatWindowTitle(nil), "Chat")
        XCTAssertEqual(AppDelegate.chatWindowTitle(""), "Chat")
        XCTAssertEqual(AppDelegate.chatWindowTitle("   \n "), "Chat")
    }

    func testChatWindowTitleUsesTrimmedSessionTitle() {
        XCTAssertEqual(AppDelegate.chatWindowTitle("  Planning the trip  "), "Planning the trip")
    }

    // MARK: - AppDelegate.openChat()/newChat() — defensive guard (no appModel)

    func testOpenChatNoOpsWithoutAppModel() {
        let delegate = AppDelegate()
        delegate.openChat()
        XCTAssertTrue(delegate.detachedWindows.isEmpty)
    }

    func testNewChatNoOpsWithoutAppModel() {
        let delegate = AppDelegate()
        delegate.newChat()
        XCTAssertTrue(delegate.detachedWindows.isEmpty)
    }

    // MARK: - AppDelegate.newChat() — always creates via session.create({mode:"chat"})

    /// "New Chat" must create a brand-new chat session UNCONDITIONALLY — never `session.dispatch`
    /// (chat sessions are not the dispatch singleton), and never gated on whether a chat session
    /// already exists (that's "Chat"'s job, tested below).
    func testNewChatCreatesViaSessionCreateWithChatModeAndOpensAWindow() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]

        // hello
        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        // session.list: a prior dispatch session already exists (irrelevant to "New Chat" itself).
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        // session.attach(s_old)
        await waitUntilSent(t, 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[2])["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_old" }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        delegate.newChat()

        // session.create({mode:"chat"}) — NOT session.dispatch, NOT session.list first.
        await waitUntilSent(t, 4)
        let create = lineJSON(t.sent[3])
        XCTAssertEqual(create["method"] as? String, "session.create")
        XCTAssertEqual((create["params"] as? [String: Any])?["mode"] as? String, "chat")
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_new_chat","trusted":true}}"#)

        await waitUntil { !delegate.detachedWindows.isEmpty }
        XCTAssertEqual(delegate.detachedWindows.count, 1)
        XCTAssertEqual(delegate.detachedWindows.first?.sessionId, "s_new_chat")
        XCTAssertEqual(delegate.detachedWindows.first?.windowForTesting?.title, "Chat", "a freshly created chat session has no title yet — falls back to 'Chat'")
    }

    // MARK: - AppDelegate.openChat() — open existing vs. create

    /// A chat session already exists: "Chat" must open THAT one (pinned via `makeDetachedFeed`,
    /// titled from its own title) and must NEVER call `session.create`.
    func testOpenChatOpensExistingNewestChatSessionWithoutCreating() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]

        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        await waitUntilSent(t, 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[2])["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_old" }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        delegate.openChat()

        // openChat() lists fresh rather than trusting `directory.rows` — answer that session.list.
        await waitUntilSent(t, 4)
        let relist = lineJSON(t.sent[3])
        XCTAssertEqual(relist["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_chat1","title":"Existing chat","scope":"global","createdAt":2,"lastSeq":0,"mode":"chat"}]}}"#)

        await waitUntil { !delegate.detachedWindows.isEmpty }
        XCTAssertEqual(delegate.detachedWindows.count, 1)
        XCTAssertEqual(delegate.detachedWindows.first?.sessionId, "s_chat1")
        XCTAssertEqual(delegate.detachedWindows.first?.windowForTesting?.title, "Existing chat")

        // settle: no session.create ever fired.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(t.sent.contains { lineJSON($0)["method"] as? String == "session.create" }, "opening an EXISTING chat session must never create a new one: \(t.sent)")
    }

    /// No chat session exists yet: "Chat" must fall back to creating one, exactly like "New Chat".
    func testOpenChatCreatesWhenNoChatSessionExists() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]

        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        await waitUntilSent(t, 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[2])["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_old" }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        delegate.openChat()

        await waitUntilSent(t, 4)
        let relist = lineJSON(t.sent[3])
        XCTAssertEqual(relist["method"] as? String, "session.list")
        // No chat rows at all — only the dispatch singleton.
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)

        await waitUntilSent(t, 5)
        let create = lineJSON(t.sent[4])
        XCTAssertEqual(create["method"] as? String, "session.create")
        XCTAssertEqual((create["params"] as? [String: Any])?["mode"] as? String, "chat")
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_fresh_chat","trusted":true}}"#)

        await waitUntil { !delegate.detachedWindows.isEmpty }
        XCTAssertEqual(delegate.detachedWindows.count, 1)
        XCTAssertEqual(delegate.detachedWindows.first?.sessionId, "s_fresh_chat")
        XCTAssertEqual(delegate.detachedWindows.first?.windowForTesting?.title, "Chat")
    }
}
