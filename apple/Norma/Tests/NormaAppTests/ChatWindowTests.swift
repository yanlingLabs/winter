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

    // MARK: - AppDelegate.isOrbSidebarRow(_:) (PURE) — plan-immunity Task 2, mode×surface matrix:
    // the orb's own sidebar row filter (`orb.sidebars`'s `rowFilter`, wired in `boot()`). Dispatch
    // is the ONLY mode the orb may ever show/select — chat/cowork/code rows must never even render
    // as clickable there (the model-level half of this same gate is `AppModel.refocus`'s own check,
    // covered in `AppModelTests`).

    func testIsOrbSidebarRowAcceptsDispatch() {
        let row = SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "dispatch")
        XCTAssertTrue(AppDelegate.isOrbSidebarRow(row))
    }

    func testIsOrbSidebarRowRejectsChatCoworkCodeAndAbsentMode() {
        let chat = SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "chat")
        let cowork = SessionSummary(sessionId: "s2", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "cowork")
        let code = SessionSummary(sessionId: "s3", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code")
        let absent = SessionSummary(sessionId: "s4", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: nil)
        XCTAssertFalse(AppDelegate.isOrbSidebarRow(chat))
        XCTAssertFalse(AppDelegate.isOrbSidebarRow(cowork))
        XCTAssertFalse(AppDelegate.isOrbSidebarRow(code))
        XCTAssertFalse(AppDelegate.isOrbSidebarRow(absent), "absent mode = code (R-slice convention) — never the orb's")
    }

    func testIsOrbSidebarRowFiltersAMixedRowSetToDispatchOnly() {
        let rows = [
            SessionSummary(sessionId: "s_dispatch", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "dispatch"),
            SessionSummary(sessionId: "s_chat", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "chat"),
            SessionSummary(sessionId: "s_code", title: nil, createdAt: 3, scope: "global", cwd: nil, mode: "code"),
        ]
        XCTAssertEqual(rows.filter(AppDelegate.isOrbSidebarRow).map { $0.sessionId }, ["s_dispatch"])
    }

    /// Fix round 1, Minor 2: the predicate above being correct proves nothing about whether `boot()`
    /// actually WIRES it — the reviewer deleted `rowFilter: AppDelegate.isOrbSidebarRow` from
    /// `boot()`'s `orb.sidebars = SidebarWiring(...)` call and all 897 existing tests stayed green
    /// (nothing exercised the INSTALLATION, only the predicate in isolation). This calls the LIVE
    /// closure `boot()` actually puts on a real `OrbWindowController.sidebars`, so removing the
    /// wiring again — `SidebarWiring`'s default `rowFilter` is `{ _ in true }`, which would let
    /// every row through — fails this test.
    func testBootWiresIsOrbSidebarRowAsTheOrbsSidebarFilter() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        guard let rowFilter = delegate.orbController?.sidebars?.rowFilter else {
            XCTFail("boot() must wire orb.sidebars.rowFilter")
            return
        }
        let rows = [
            SessionSummary(sessionId: "s_dispatch", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "dispatch"),
            SessionSummary(sessionId: "s_chat", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "chat"),
            SessionSummary(sessionId: "s_code", title: nil, createdAt: 3, scope: "global", cwd: nil, mode: "code"),
        ]
        XCTAssertEqual(
            rows.filter(rowFilter).map { $0.sessionId }, ["s_dispatch"],
            "boot()'s installed rowFilter must actually be the dispatch-only predicate, not SidebarWiring's default (which lets every row through)"
        )
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
        // Plan-immunity (2026-07-28 design): "New Chat" must open a window whose policy picker
        // is hidden (adapter.isChatSession true) — the fixed-policy chat window, not an ordinary one.
        XCTAssertTrue(delegate.detachedWindows.first?.adapterForTesting.isChatSession ?? false)
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
        // Plan-immunity (2026-07-28 design): reopening an EXISTING chat session must also open with
        // its policy picker hidden — not just the freshly-created path above.
        XCTAssertTrue(delegate.detachedWindows.first?.adapterForTesting.isChatSession ?? false)

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

    // MARK: - Plan-immunity (2026-07-28 design; fix round 1, review finding "door 1"):
    // registerDetachedWindow's onOpenSessionDetached (⌘-click a row in ANY window's own left
    // sidebar) now routes through openSessionInNewDetachedWindow instead of calling
    // spawnDetachedWindow directly — the ONE place `isChat` auto-derives from `model.directory.rows`
    // when the caller doesn't already know the mode. This is the SAME shared choke point door 2 (the
    // Dashboard's SessionsPane row click, `AppDelegate.swift`'s `onOpenSessionDetached: { [weak self]
    // sid in self?.openSessionInNewDetachedWindow(sid) }`) already called before this fix — that
    // closure is UNCHANGED by this round, so proving the auto-derivation here proves door 2 too, by
    // construction: same unchanged call site, same now-fixed shared function.

    /// Local copy of `AppModelTests`' `waitUntilMethod` — see that file's own doc comment.
    func waitUntilMethod(_ t: AppScriptedTransport, _ method: String, occurrence: Int = 1, timeout: TimeInterval = 3) async -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let matches = t.sent.map(lineJSON).filter { $0["method"] as? String == method }
            if matches.count >= occurrence { return matches[occurrence - 1] }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for occurrence \(occurrence) of method \(method): \(t.sent)")
        return [:]
    }

    /// ⌘-clicking a CHAT row from another window's own left sidebar must open it with the policy
    /// picker ALREADY hidden — before this fix, this door called `spawnDetachedWindow` directly with
    /// no `isChat` at all, so the spawned window always showed both pickers for a chat session,
    /// the "shown-but-broken" state this whole slice refuses to ship.
    func testOnOpenSessionDetachedAutoDerivesIsChatFromRealDirectory() async throws {
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
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        await waitUntilSent(t, 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[2])["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_a" }

        // A chat session exists elsewhere — kicks the directory's own unconditional re-list (the
        // SAME real round-trip mechanism `AppModelTests.
        // testSessionCreatedChatModeNeverRefocusesButDirectorySeesIt` proves populates chat rows).
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_chat","ts":5,"scope":"global","mode":"chat"}}"#)
        let relist = await waitUntilMethod(t, "session.list", occurrence: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_chat","scope":"global","createdAt":5,"lastSeq":0,"mode":"chat"}]}}"#)
        await waitUntil { model.directory.rows.contains { $0.sessionId == "s_chat" } }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        // The SOURCE window — whose own left sidebar the ⌘-click came from.
        guard let (sourceFeed, sourceSession) = model.makeDetachedFeed(sessionId: "s_a") else {
            XCTFail("makeDetachedFeed must succeed with a real (non-missing) token")
            return
        }
        let source = DetachedWindowController(feed: sourceFeed, session: sourceSession, frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma")
        delegate.registerDetachedWindow(source)
        XCTAssertEqual(delegate.detachedWindows.count, 1)

        source.onOpenSessionDetached?("s_chat")

        await waitUntil { delegate.detachedWindows.count == 2 }
        XCTAssertEqual(delegate.detachedWindows.last?.sessionId, "s_chat")
        XCTAssertTrue(
            delegate.detachedWindows.last?.adapterForTesting.isChatSession ?? false,
            "door 1 (⌘-click from any window's own sidebar) must open a chat row with the policy picker already hidden"
        )
    }

    /// Fix round 1 re-review Minor (closed here): door 1's derivation used to read ONLY
    /// `model.directory.rows` — AppModel's own directory, a SEPARATE `SessionDirectory` instance
    /// from the SOURCE window's own private one, synced with it only via daemon broadcast fan-out.
    /// This proves the exact race the Minor named: "s_chat" is loaded into the SOURCE's own
    /// `directory` via a REAL round trip on its OWN transport, while `model.directory` is left
    /// with NO knowledge of it at all (its transport never even mentions the id) — before this
    /// fix, `openSessionInNewDetachedWindow` would have resolved `isChat` false (SHOWING a policy
    /// picker that would immediately fire a rejected `setPolicy` against a real chat session, the
    /// exact shown-but-broken bug this slice exists to close). The fix: check the SOURCE's own
    /// rows first (`sourceRows:`, threaded from `registerDetachedWindow`'s closure).
    func testOnOpenSessionDetachedUsesSourceDirectoryWhenModelDirectoryHasntSeenTheRowYet() async throws {
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
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        await waitUntilSent(t, 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[2])["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_a" }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        // The SOURCE window — its own harness, its own private `SessionDirectory`.
        guard let (sourceFeed, sourceSession) = model.makeDetachedFeed(sessionId: "s_a") else {
            XCTFail("makeDetachedFeed must succeed with a real (non-missing) token")
            return
        }
        let source = DetachedWindowController(feed: sourceFeed, session: sourceSession, frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma")
        delegate.registerDetachedWindow(source)
        source.show()

        // The source's own pinned handshake (hello + attach), on its OWN transport (factory.made[1]).
        await waitUntil { factory.made.count >= 2 }
        let st = factory.made[1]
        await waitUntilSent(st, 1)
        st.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(st.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(st, 2)
        let sourceAttach = lineJSON(st.sent[1])
        XCTAssertEqual(sourceAttach["method"] as? String, "session.attach")
        st.feed(#"{"jsonrpc":"2.0","id":\#(sourceAttach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        // Load "s_chat" into the SOURCE's OWN directory via an explicit refresh (mirrors
        // `DetachedWindowTests.testSelectSessionUpdatesIsChatSessionFromTheDirectory`'s own
        // pattern) — model's transport (t) is never told about "s_chat" at all.
        let sourceRefresh = Task { await source.directory.refresh() }
        await waitUntilSent(st, 3)
        let sourceList = lineJSON(st.sent[2])
        XCTAssertEqual(sourceList["method"] as? String, "session.list")
        st.feed(#"{"jsonrpc":"2.0","id":\#(sourceList["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_chat","scope":"global","createdAt":5,"lastSeq":0,"mode":"chat"}]}}"#)
        await sourceRefresh.value

        XCTAssertTrue(source.directory.rows.contains { $0.sessionId == "s_chat" }, "the SOURCE window's own directory must have the row")
        XCTAssertFalse(model.directory.rows.contains { $0.sessionId == "s_chat" }, "the crux of the race: AppModel's SEPARATE directory instance must NOT have it")

        source.onOpenSessionDetached?("s_chat")

        await waitUntil { delegate.detachedWindows.count == 2 }
        XCTAssertEqual(delegate.detachedWindows.last?.sessionId, "s_chat")
        XCTAssertTrue(
            delegate.detachedWindows.last?.adapterForTesting.isChatSession ?? false,
            "must consult the SOURCE window's own rows, not just model.directory (which hasn't seen this row yet)"
        )
    }

    /// CONTROL: the same door, a NON-chat row — the spawned window's picker must stay visible
    /// (the auto-derivation must not blanket-hide it for every session). Same shape as the chat-row
    /// test above (a dispatch anchor for the initial auto-focus — `AppModel.focusNewestSession()`
    /// only ever auto-attaches a `mode:"dispatch"` row, so a session.list of all-code rows would
    /// never attach at all and this test would hang waiting for one).
    func testOnOpenSessionDetachedKeepsPickerVisibleForACodeRow() async throws {
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
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        await waitUntilSent(t, 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[2])["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_a" }

        // A plain code session exists elsewhere — kicks the directory's own unconditional re-list.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_code","ts":5,"scope":"global","mode":"code"}}"#)
        let relist = await waitUntilMethod(t, "session.list", occurrence: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_code","scope":"global","createdAt":5,"lastSeq":0,"mode":"code"}]}}"#)
        await waitUntil { model.directory.rows.contains { $0.sessionId == "s_code" } }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        guard let (sourceFeed, sourceSession) = model.makeDetachedFeed(sessionId: "s_a") else {
            XCTFail("makeDetachedFeed must succeed with a real (non-missing) token")
            return
        }
        let source = DetachedWindowController(feed: sourceFeed, session: sourceSession, frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma")
        delegate.registerDetachedWindow(source)

        source.onOpenSessionDetached?("s_code")

        await waitUntil { delegate.detachedWindows.count == 2 }
        XCTAssertEqual(delegate.detachedWindows.last?.sessionId, "s_code")
        XCTAssertFalse(delegate.detachedWindows.last?.adapterForTesting.isChatSession ?? true)
    }

    // MARK: - Plan-immunity Task 2 — "the fifth door": `orb.onWindowDetach` (the yellow traffic
    // light) used to call `spawnDetachedWindow` with NO `isChat` at all, always defaulting false.
    // Extracted into `handleWindowDetach(frame:)` (was inlined in the `boot()`-wired closure) so
    // it's directly testable the same way `OrbWindowController.updateIsChatSession` already is
    // (see `PolicyMenuTests`' own doc comment: `boot()`'s AppModel can never be scripted in a
    // test, so `boot()` first — to wire `orbController`/`onWindowDetach` — then
    // `setAppModelForTesting` swaps in a real one; the closure reads `self.appModel` fresh, so it
    // picks up the swap on its next invocation).

    /// With the orb's OTHER Task-2 gates in place (`AppModel.refocus`'s dispatch-only check,
    /// `AppDelegate.isOrbSidebarRow`'s sidebar filter), a chat session can no longer actually BE
    /// the orb's focused session THROUGH THE UI — so this reaches the case via `refocus`'s own
    /// documented "not found in the directory yet" leniency (a direct API call, not a sidebar
    /// click) specifically to prove the derivation branch this defense-in-depth fix adds is real,
    /// not dead code that merely LOOKS like it handles a chat session.
    func testHandleWindowDetachDerivesIsChatForTheActuallyFocusedSession() async throws {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot(), "boot() wires orbController/onWindowDetach even in the degraded unit-test path")

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
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[]}}"#)
        await waitUntil { model.session.state.status == .idle }
        XCTAssertNil(model.focusedSessionId, "no dispatch session exists yet")

        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        // `directory.rows` doesn't know "s_chat" yet, so `refocus`'s "not found -> allow" leniency
        // lets a direct `focusSession` call through (see that method's own doc comment) — must run
        // concurrently with answering the attach RPC (`focusSession` awaits it to completion).
        async let focused: Void = model.focusSession("s_chat")
        let attach = await waitUntilMethod(t, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "s_chat")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await focused
        XCTAssertEqual(model.focusedSessionId, "s_chat")

        // Now the directory learns "s_chat" is mode:"chat" (a session_titled broadcast never
        // auto-refocuses, so this is safe to do after the focus above).
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_titled","seq":1,"sessionId":"s_chat","ts":5,"threadId":"main","title":"Chat"}}"#)
        let relist = await waitUntilMethod(t, "session.list", occurrence: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_chat","scope":"global","createdAt":1,"lastSeq":0,"mode":"chat","title":"Chat"}]}}"#)
        await waitUntil { model.directory.rows.contains { $0.sessionId == "s_chat" && $0.mode == "chat" } }

        let spawned = delegate.orbController?.onWindowDetach?(NSRect(x: 0, y: 0, width: 560, height: 640))
        XCTAssertEqual(spawned, true)
        await waitUntil { !delegate.detachedWindows.isEmpty }
        XCTAssertEqual(delegate.detachedWindows.first?.sessionId, "s_chat")
        XCTAssertTrue(
            delegate.detachedWindows.first?.adapterForTesting.isChatSession ?? false,
            "the fifth door (yellow-light detach) must derive isChat off the actually-focused session's real mode, not default false"
        )
    }

    /// CONTROL: the ordinary (and only UI-reachable) case — a focused DISPATCH session — must open
    /// with the policy picker visible (isChat false), same as before this fix (the derivation must
    /// not blanket-hide it for every session).
    func testHandleWindowDetachKeepsPickerVisibleForADispatchFocus() async throws {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())

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
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        await waitUntilSent(t, 3)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[2])["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_a" }

        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        let spawned = delegate.orbController?.onWindowDetach?(NSRect(x: 0, y: 0, width: 560, height: 640))
        XCTAssertEqual(spawned, true)
        await waitUntil { !delegate.detachedWindows.isEmpty }
        XCTAssertEqual(delegate.detachedWindows.first?.sessionId, "s_a")
        XCTAssertFalse(delegate.detachedWindows.first?.adapterForTesting.isChatSession ?? true)
    }
}
