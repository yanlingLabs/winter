import XCTest
import AppKit
@testable import Norma

/// Chat Mode Slice A (CM-T3) / Plan-immunity Task 2, surviving App shell T6's menu-bar retarget:
/// `AppDelegate.isOrbSidebarRow(_:)` (the orb's dispatch-only sidebar filter — a DIFFERENT subject
/// from the chat-open machinery this file used to also cover, never touched by that task), plus the
/// auto-derivation coverage for the two detached-window spawn doors still reachable today — the
/// ⌘-click "open in a new window" door (`registerDetachedWindow`'s `onOpenSessionDetached`) and the
/// yellow-light detach door (`handleWindowDetach`). App shell T6 deleted this file's other half —
/// `AppDelegate.chatSessionToOpen`/`chatWindowTitle` and the wiring tests for `openChat()`/
/// `newChat()` — because "Chat"/"New Chat" now summon the app shell instead of spawning a detached
/// window, and nothing else ever called those four. The successful spawn path itself
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

    // App shell T6 (the menu-bar retarget's funeral): four `chatSessionToOpen(in:)` pure tests that
    // lived here — testChatSessionToOpenPicksNewestChatRow, …IgnoresCodeAndDispatchRows,
    // …ReturnsNilWithNoChatRows, …ReturnsNilOnEmptyRows — are deleted with their subject. Nothing
    // called `chatSessionToOpen(in:)` once `openChat()` (its only caller) was retired.

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

    // App shell T6 (the menu-bar retarget's funeral): `chatWindowTitle(_:)` pure tests
    // (testChatWindowTitleFallsBackToChatWhenNilOrBlank, …UsesTrimmedSessionTitle),
    // `openChat()`'s defensive-guard test (testOpenChatNoOpsWithoutAppModel) and its open-existing/
    // create-when-absent wiring tests (testOpenChatOpensExistingNewestChatSessionWithoutCreating,
    // testOpenChatCreatesWhenNoChatSessionExists) are deleted with their subject — "Chat" now
    // browses the app shell's chat landing instead of spawning a detached window (see
    // `AppShellTests.testChatMenuItemSummonsToTheChatLanding`), and nothing else ever called
    // `chatWindowTitle`/`openChat`. `newChat()`'s tests, below, are NOT deleted — review fix:
    // the first retarget pass wrongly collapsed "New Chat" onto the same plain summon as "Chat",
    // silently dropping the create T3's own report assigned to this task. `newChat()` survives with
    // new innards (create via `model.client`'s bare RPC, no `cwd`, then summon straight onto
    // `.session(id)`) — see `AppDelegate.newChat()`'s own doc comment.

    // MARK: - AppDelegate.newChat() → the new-chat page + create-on-first-send (chatgpt-ui T2, spec §2)

    /// Defensive-guard precedent (matches every other menu-path guard in this file): no `appModel`
    /// → log + no-op, no crash, no RPC issued. T2: the guard is `summonAppWindow`'s own now
    /// (`newChat()` is a plain targeted summon) — the observable contract is unchanged.
    func testNewChatNoOpsWithoutAppModel() {
        let delegate = AppDelegate()
        delegate.newChat()
        XCTAssertNil(delegate.appWindow)
    }

    /// RETARGETED (chatgpt-ui T2 — the deferred create): the door OPENS THE PAGE with ZERO
    /// `session.create` on every transport the app has ever minted (the factory recorder is the
    /// proof), and it is the page's FIRST SEND (`ShellSessionHost.sendFirstChatMessage`, driven
    /// here through the exact seam `NewChatPage.submit` uses) that issues exactly ONE create —
    /// the same wire shape the eager door pinned before this task (`mode: "chat"`, `scope:
    /// "global"`, `approvalPolicy: "auto"`, NO `cwd` — chat sessions carry no fs tools; the
    /// original createAndOpenChat()'s `cwd: NSHomeDirectory()` staleness stays dead) on
    /// `model.client`, never an attaching harness — then navigates onto the fresh id. No
    /// self-attach on the create connection, exactly as before.
    func testNewChatOpensThePageAndOnlyTheFirstSendCreatesWithChatModeNoCwd() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]

        // hello
        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[]}}"#)
        await waitUntil { model.session.state.status == .idle }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.appWindow?.hide() }

        delegate.newChat()

        // Semantics 1's wire pin: landing on the page mints NOTHING.
        XCTAssertEqual(delegate.appWindow?.navigation.destination, .newChat, "the door opens the page — never a session")
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(
            factory.made.flatMap(\.sent).map(lineJSON).allSatisfy { $0["method"] as? String != "session.create" },
            "navigating to the new-chat page must mint ZERO session.create on every transport ever made"
        )

        // Semantics 2: the first send — the page's exact submit seam.
        guard let host = delegate.appWindow?.host else { return XCTFail("the summoned shell must carry a host") }
        host.sendFirstChatMessage("hello there") { [weak delegate] id in
            delegate?.appWindow?.navigation.navigate(to: .session(id))
        }

        let create = await waitUntilMethod(t, "session.create")
        let params = create["params"] as? [String: Any]
        XCTAssertEqual(params?["mode"] as? String, "chat")
        XCTAssertEqual(params?["scope"] as? String, "global")
        XCTAssertEqual(params?["approvalPolicy"] as? String, "auto")
        XCTAssertNil(params?["cwd"], "no cwd — chat sessions carry no fs tools (the established B4 shape)")
        let sentBeforeResponse = t.sent.count

        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_new_chat","trusted":true}}"#)

        await waitUntil { delegate.appWindow?.navigation.destination == .session("s_new_chat") }

        let afterCreate = t.sent[sentBeforeResponse...]
        XCTAssertFalse(
            afterCreate.contains { lineJSON($0)["method"] as? String == "session.attach" },
            "the create call must never self-attach on the connection it rode: \(afterCreate)"
        )
        let creates = factory.made.flatMap(\.sent).map(lineJSON).filter { $0["method"] as? String == "session.create" }
        XCTAssertEqual(creates.count, 1, "exactly ONE create for the whole page flow")
    }

    /// RETARGETED (chatgpt-ui T2 — the honesty rule): a failed create is VISIBLE on the page and
    /// never navigates — the shell stays on `.newChat` with the daemon's own sentence published
    /// verbatim (`newChatCreate == .failed("boom")`), the same verbatim-refusal discipline every
    /// other RPC seam keeps. (Before T2 the door itself created, and the failure pin was
    /// "a failed create must never summon" — this is that pin's new-flow truth.)
    func testFirstSendCreateFailureIsVisibleOnThePageAndNeverNavigates() async throws {
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
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[]}}"#)
        await waitUntil { model.session.state.status == .idle }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.appWindow?.hide() }

        delegate.newChat()
        guard let host = delegate.appWindow?.host else { return XCTFail("the summoned shell must carry a host") }

        var navigated = false
        host.sendFirstChatMessage("hello there") { _ in navigated = true }

        let create = await waitUntilMethod(t, "session.create")
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"error":{"code":1,"message":"boom"}}"#)

        await waitUntil { host.newChatCreate == .failed("boom") }
        XCTAssertEqual(host.newChatCreate, .failed("boom"), "the daemon's sentence, verbatim — a visible failure, never log-only")
        XCTAssertFalse(navigated, "a failed create must never navigate")
        XCTAssertEqual(delegate.appWindow?.navigation.destination, .newChat, "the shell stays on the page")
        XCTAssertNil(delegate.appWindow?.host?.attachedSessionId, "nothing attaches on a failed create")
    }

    /// IMP-1 fix (final whole-branch review, "the fourth door"), RETARGETED to the T2 flow: the
    /// New-Chat self-heal pin now rides page → first send → create → navigate. The race it guards
    /// is unchanged: the fresh row hasn't loaded into `model.directory` when the shell attaches
    /// (the `session_created` broadcast's own refresh round trip always loses that race), so
    /// `ShellSessionHost.attachFresh`'s one-shot derivation reads `false` and the policy picker
    /// (gated `!adapter.isChatSession`, `WindowContentView.swift`) would show for a chat session
    /// whose every tap the daemon refuses — until `reconcileIsChatSession` heals it on the row's
    /// arrival.
    ///
    /// This is ALSO the create-before-send wire pin (spec §2): the shell harness's OWN trace must
    /// read hello → attach → send, with the typed text as the send's verbatim payload — the
    /// pending first message delivers only after the attach ack (`SessionFeed.start()`'s pinned
    /// ordering), and the create already happened on the OTHER connection before this one was
    /// even minted.
    ///
    /// Answers every `session.list` call it sees (rather than a fixed occurrence index) because
    /// `newChat()` summons a REAL window here (`ShellSidebar`'s own `.task { await
    /// directory.refresh() }` can fire an untracked extra relist the instant the shell's sidebar
    /// mounts) — a fixed index would risk answering the wrong one.
    func testNewChatSelfHealsIsChatSessionOnceTheFreshRowLands() async throws {
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
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[]}}"#)
        await waitUntil { model.session.state.status == .idle }

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.appWindow?.hide() }

        delegate.newChat()
        guard let host = delegate.appWindow?.host else { return XCTFail("the summoned shell must carry a host") }
        host.sendFirstChatMessage("first message text") { [weak delegate] id in
            delegate?.appWindow?.navigation.navigate(to: .session(id))
        }

        let create = await waitUntilMethod(t, "session.create")
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_new_chat","trusted":true}}"#)
        await waitUntil { delegate.appWindow?.navigation.destination == .session("s_new_chat") }

        // The shell's own pinned harness — a SEPARATE connection (`AppModel.makeDetachedFeed`),
        // never the one `session.create` rode.
        await waitUntil { factory.made.count >= 2 }
        let shellT = factory.made[1]
        await waitUntilSent(shellT, 1)
        shellT.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(shellT.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(shellT, 2)
        let attach = lineJSON(shellT.sent[1])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        shellT.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        await waitUntil { delegate.appWindow?.host?.attachment != nil }
        // The first-message carry: the typed text is ALREADY the attached composer's draft (no
        // empty beat between the page and the live session) — cleared only when the send lands.
        XCTAssertEqual(delegate.appWindow?.host?.attachment?.adapter.composerDraft, "first message text",
                       "the composer content carries over — seeded at attach, before the send lands")

        // create → attach → SEND, on the wire: the pending first message rides THIS harness,
        // strictly after its attach ack, with the typed text verbatim.
        let send = await waitUntilMethod(shellT, "session.send")
        XCTAssertEqual((send["params"] as? [String: Any])?["text"] as? String, "first message text",
                       "the send text IS the first message payload — nothing lost, nothing rewritten")
        // `sync.config` (the catalogue fetch, a READ fired from the same post-attach hook) lands
        // asynchronously and may interleave — filtered out, the `attachmentMethods` discipline.
        let methods = shellT.sent.compactMap { lineJSON($0)["method"] as? String }.filter { $0 != "sync.config" }
        XCTAssertEqual(Array(methods.prefix(3)), ["protocol.hello", "session.attach", "session.send"],
                       "attach strictly before send on the shell harness — the create already happened on the other connection")
        shellT.feed(#"{"jsonrpc":"2.0","id":\#(send["id"] as! Int),"result":{"seq":1}}"#)
        await waitUntil { delegate.appWindow?.host?.attachment?.adapter.composerDraft == "" }
        XCTAssertEqual(delegate.appWindow?.host?.attachment?.adapter.composerDraft, "",
                       "the carried draft clears once the send actually lands")

        XCTAssertFalse(
            delegate.appWindow?.host?.attachment?.adapter.isChatSession ?? true,
            "the fresh row hasn't loaded at attach time — derives false, same as before this fix"
        )

        // The daemon's session_created broadcast lands on model's OWN connection (the create rode
        // it) — the real race this fix closes. `directory.refresh()`'s own `session.list` may
        // arrive more than once (the real window's sidebar can relist on its own) — answer every
        // one seen with the real row until the picker self-heals.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_new_chat","ts":5,"scope":"global","mode":"chat"}}"#)
        var answered = Set<Int>()
        let deadline = Date().addingTimeInterval(3)
        while delegate.appWindow?.host?.attachment?.adapter.isChatSession != true && Date() < deadline {
            for call in t.sent.map(lineJSON) where call["method"] as? String == "session.list" {
                if let id = call["id"] as? Int, !answered.contains(id) {
                    answered.insert(id)
                    t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"sessions":[{"sessionId":"s_new_chat","scope":"global","createdAt":5,"lastSeq":0,"mode":"chat"}]}}"#)
                }
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }

        XCTAssertTrue(
            delegate.appWindow?.host?.attachment?.adapter.isChatSession ?? false,
            "New Chat's fresh row landing must self-heal isChatSession — the restored pin"
        )
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
