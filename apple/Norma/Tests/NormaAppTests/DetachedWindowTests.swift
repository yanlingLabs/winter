import XCTest
import AppKit
import NormaProtocol
import NormaKit
@testable import Norma

/// Local copy of `SessionFeedTests`' scripted-transport double (`FeedScriptedTransport`),
/// `Detached`-prefixed per that file's own established convention (see its header comment) — plus
/// a `closeCallCount` this suite needs to prove `feed.stop()` actually closed the transport
/// (`testCloseStopsFeedAndFiresOnClosedOnce`), which the other copies don't track.
final class DetachedScriptedTransport: NormaTransport, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    private var _closeCallCount = 0
    var sent: [String] { lock.lock(); defer { lock.unlock() }; return _sent }
    var closeCallCount: Int { lock.lock(); defer { lock.unlock() }; return _closeCallCount }

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
    func close() {
        lock.lock(); _closeCallCount += 1; lock.unlock()
        cont.yield(.closed(nil)); cont.finish()
    }
    func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }
}

@MainActor
final class DetachedWindowTests: XCTestCase {
    func waitUntilSent(_ t: DetachedScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    /// Drives a pinned feed's handshake to "connected" (hello, then attach — pinned mode skips
    /// session.list) so `client.transport` is live and RPCs (steer/send/interrupt) actually reach
    /// the wire, mirroring `SessionFeedTests.answerPinnedHandshake`.
    func answerHandshake(_ t: DetachedScriptedTransport, sessionId: String) async {
        await waitUntilSent(t, 1)
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let attach = feedLineJSON(t.sent[1])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, sessionId)
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
    }

    func testShowCreatesNativeChromeWindowAtFrame() {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let frame = NSRect(x: 120, y: 80, width: 560, height: 640)
        let controller = DetachedWindowController(feed: feed, session: session, frame: frame, title: "Test Window")
        defer { controller.close() }

        controller.show()

        guard let window = controller.windowForTesting else {
            XCTFail("show() must construct a real window")
            return
        }
        XCTAssertTrue(window.styleMask.contains(.titled))
        XCTAssertTrue(window.styleMask.contains(.miniaturizable))
        XCTAssertTrue(window.styleMask.contains(.resizable))
        XCTAssertTrue(window.styleMask.contains(.closable))
        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
        XCTAssertEqual(window.frame, frame)
    }

    func testCloseStopsFeedAndFiresOnClosedOnce() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )

        var closedCount = 0
        controller.onClosed = { _ in closedCount += 1 }

        controller.show()
        await waitUntilSent(t, 1) // a real handshake in flight — a live transport to close

        controller.close()
        XCTAssertEqual(closedCount, 1, "onClosed must fire on the programmatic close path")
        await feedWaitUntil { t.closeCallCount >= 1 }
        XCTAssertGreaterThanOrEqual(t.closeCallCount, 1, "feed.stop() must close the transport")

        controller.close() // already closed — must not double-fire onClosed
        XCTAssertEqual(closedCount, 1)
    }

    func testSubmitSteersWhenTurnRunning() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()

        await answerHandshake(t, sessionId: "S1")
        await feedWaitUntil { session.state.status != .disconnected }

        // Drive turnRunning directly (test-only mutation seam) — no need to round-trip a real
        // turn_started event through the pump just to flip one flag.
        session.applyForTesting { $0.turnRunning = true }

        controller.adapterForTesting.composerDraft = "steer me"
        controller.adapterForTesting.onSubmit("steer me")

        await waitUntilSent(t, 3)
        let steer = feedLineJSON(t.sent[2])
        XCTAssertEqual(steer["method"] as? String, "session.steer")
        XCTAssertEqual((steer["params"] as? [String: Any])?["sessionId"] as? String, "S1")
        XCTAssertEqual((steer["params"] as? [String: Any])?["text"] as? String, "steer me")

        // success clears the draft — mirrors GlassRootView.submit's gating (spec §6)
        t.feed(#"{"jsonrpc":"2.0","id":\#(steer["id"] as! Int),"result":{"injected":true}}"#)
        await feedWaitUntil { controller.adapterForTesting.composerDraft.isEmpty }
        XCTAssertTrue(controller.adapterForTesting.composerDraft.isEmpty)
    }

    /// Task 5 (2e-iii): `selectSession(_:)` — the sidebar's plain-click "switch in place" action.
    /// `sessionId` must flip SYNCHRONOUSLY (before the repin's own attach round-trip completes),
    /// and every closure that reads it live (submit, in particular) must target the NEW session —
    /// this is the exact correctness fix Task 5 needed (previously `sessionId` was a `let` captured
    /// once at construction into the respond/submit closures).
    func testSelectSessionRepinsFeedAndSubmitTargetsNewSession() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()

        await answerHandshake(t, sessionId: "S1")
        await feedWaitUntil { session.state.status != .disconnected }

        XCTAssertEqual(controller.sessionId, "S1")
        controller.selectSession("S2")
        XCTAssertEqual(controller.sessionId, "S2", "sessionId must flip synchronously, before the repin's attach round-trip")

        // the repin fires a fresh attach for S2 on the SAME socket (no second hello).
        await waitUntilSent(t, 3)
        let attach = feedLineJSON(t.sent[2])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "S2")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await feedWaitUntil { session.state.status != .disconnected }

        // a submit AFTER the repin must target S2, not the stale S1 (the closure-capture fix).
        controller.adapterForTesting.composerDraft = "hi S2"
        controller.adapterForTesting.onSubmit("hi S2")
        await waitUntilSent(t, 4)
        let send = feedLineJSON(t.sent[3])
        XCTAssertEqual(send["method"] as? String, "session.send")
        XCTAssertEqual((send["params"] as? [String: Any])?["sessionId"] as? String, "S2")

        let hellos = t.sent.filter { feedLineJSON($0)["method"] as? String == "protocol.hello" }
        XCTAssertEqual(hellos.count, 1, "repin must reuse the same socket: \(t.sent)")
    }

    /// mac-chat-parity T4: the switch-in-place must re-derive the POLICY readout too, off this
    /// window's own directory — the same re-derivation `isChatSession` gets, for the same reason.
    /// This window mounts `WorkSidebar`'s Options block, a picker that is on screen the whole time
    /// rather than a popover you open, so a readout stuck at the departed session's value (or at the
    /// `"auto"` placeholder for a session running `bypass`) is a standing claim about the wrong
    /// session.
    ///
    /// Driven through the REAL wire: the controller's directory lists over its own feed client, so
    /// answering that `session.list` is the only way its rows ever carry a policy — which also means
    /// this covers the kit decode and the controller's own `SessionSummary` map, the sibling of the
    /// one `PolicyMenuTests` pins on `AppModel`.
    func testSelectSessionReDerivesTheApprovalPolicyFromThisWindowsDirectory() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()
        await answerHandshake(t, sessionId: "S1")

        // A `session_created` broadcast kicks this window's directory into a real `session.list`
        // (`feed.onEvent` → `SessionDirectory.handle`). Deliberately not `startInitialLoad`'s own
        // list: that one fires at construction, before this feed's client has connected, and is
        // silently absorbed by `refresh()`'s `try?` — see `startInitialLoad`'s own doc comment.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"S2","ts":5,"scope":"global"}}"#)

        // Found by METHOD rather than by a fixed index, since it races the handshake's own traffic.
        let deadline = Date().addingTimeInterval(3)
        var listLine: [String: Any]?
        while listLine == nil && Date() < deadline {
            listLine = t.sent.map(feedLineJSON).first { $0["method"] as? String == "session.list" }
            if listLine == nil { try? await Task.sleep(nanoseconds: 20_000_000) }
        }
        guard let list = listLine, let listId = list["id"] as? Int else {
            return XCTFail("the detached window's directory must list on construction: \(t.sent)")
        }
        t.feed(#"{"jsonrpc":"2.0","id":\#(listId),"result":{"sessions":[{"sessionId":"S1","scope":"global","createdAt":1,"lastSeq":0,"approvalPolicy":"ask"},{"sessionId":"S2","scope":"global","createdAt":2,"lastSeq":0,"approvalPolicy":"bypass"},{"sessionId":"S3","scope":"global","createdAt":3,"lastSeq":0}]}}"#)
        await feedWaitUntil { controller.directory.rows.count == 3 }
        XCTAssertEqual(controller.directory.rows.count, 3, "the directory must have folded the list")

        controller.selectSession("S2")
        XCTAssertEqual(controller.adapterForTesting.sessionPolicy, "bypass",
                       "the switch re-derives the readout off the arriving session's row")
        XCTAssertTrue(controller.adapterForTesting.sessionPolicyKnown)

        controller.selectSession("S3")
        XCTAssertEqual(controller.adapterForTesting.sessionPolicy, "auto",
                       "a row that reports nothing resets to the placeholder — never S2's bypass")
        XCTAssertFalse(controller.adapterForTesting.sessionPolicyKnown)
    }

    /// mac-chat-parity T4 fix round 1 (Minor 1): this window's OWN `onSetPolicy` wiring, driven end
    /// to end. `PolicyMenuTests.testSessionPolicyUpdatesOnlyOnSuccess` pins the shape against a
    /// hand-written closure, which would stay green if this wirer reverted to a bare
    /// `adapter.sessionPolicy = policy` — leaving the value uncertified, and therefore fair game for
    /// a `session.list` that was already in flight when the user made the change.
    func testASuccessfulSetPolicyThroughThisWindowsOwnWiringCertifiesTheValue() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()
        await answerHandshake(t, sessionId: "S1")
        XCTAssertFalse(controller.adapterForTesting.sessionPolicyKnown, "nothing has said anything yet")

        controller.adapterForTesting.onSetPolicy("bypass")
        XCTAssertTrue(controller.adapterForTesting.policyChangeInFlight, "flipped synchronously")
        await waitUntilSent(t, 3)
        let set = feedLineJSON(t.sent[2])
        XCTAssertEqual(set["method"] as? String, "session.setPolicy")
        XCTAssertEqual((set["params"] as? [String: Any])?["sessionId"] as? String, "S1")
        XCTAssertEqual((set["params"] as? [String: Any])?["policy"] as? String, "bypass")
        t.feed(#"{"jsonrpc":"2.0","id":\#(set["id"] as! Int),"result":{"ok":true}}"#)

        await feedWaitUntil { !controller.adapterForTesting.policyChangeInFlight }
        XCTAssertEqual(controller.adapterForTesting.sessionPolicy, "bypass")
        XCTAssertTrue(controller.adapterForTesting.sessionPolicyKnown,
                      "adopting CERTIFIES the value; a bare assignment would move it and leave it uncertified")
    }

    /// A no-op re-select (the current row tapped again) must not touch the wire at all.
    func testSelectSessionIsANoOpForTheAlreadyPinnedSession() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()

        await answerHandshake(t, sessionId: "S1")
        await feedWaitUntil { session.state.status != .disconnected }

        controller.selectSession("S1")
        try? await Task.sleep(nanoseconds: 150_000_000)
        let attaches = t.sent.filter { feedLineJSON($0)["method"] as? String == "session.attach" }
        XCTAssertEqual(attaches.count, 1, "re-selecting the already-pinned session must not re-attach: \(t.sent)")
    }

    /// Task 5 (2e-iii): the sidebar's "+ New session" action — create, then re-pin onto the freshly
    /// created id (this window's own feed is `.pinned`, so it never auto-follows `session_created`
    /// broadcasts — `newSession()`'s explicit `selectSession` call is the only path).
    func testNewSessionCreatesThenRepins() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()

        await answerHandshake(t, sessionId: "S1")
        await feedWaitUntil { session.state.status != .disconnected }

        // working-directories T8: `newSession()` now OPENS the create-time folder picker (an AppKit
        // sheet, undrivable from a unit test); `startSession(with:)` is the half that reaches the
        // wire and is what the sheet's completion calls with the user's choice.
        controller.startSession(with: .folder("/tmp/proj"))
        await waitUntilSent(t, 3)
        let create = feedLineJSON(t.sent[2])
        XCTAssertEqual(create["method"] as? String, "session.create")
        let createParams = create["params"] as? [String: Any]
        XCTAssertEqual(createParams?["approvalPolicy"] as? String, "auto")
        XCTAssertEqual(createParams?["cwd"] as? String, "/tmp/proj", "the picker's folder becomes the session's cwd")
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"S2","trusted":true}}"#)

        await waitUntilSent(t, 4)
        let attach = feedLineJSON(t.sent[3])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "S2")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        await feedWaitUntil { controller.sessionId == "S2" }
        XCTAssertEqual(controller.sessionId, "S2")
    }

    /// working-directories T8: the "No folder (outputs only)" row sends NO `cwd` key AT ALL — not an
    /// empty string, and emphatically not the old hardcoded `NSHomeDirectory()`. That absence is the
    /// whole mechanism: `session.create` without a cwd is what makes the daemon write `dirs = []`
    /// (T6), i.e. a workdir-less session confined to `$OUTDIR`/`$TMPDIR`/`$MEMDIR`. A fallback here
    /// would silently adopt the user's entire home directory as a writable root.
    func testNoFolderChoiceCreatesWithoutACwd() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()

        await answerHandshake(t, sessionId: "S1")
        await feedWaitUntil { session.state.status != .disconnected }

        controller.startSession(with: .noFolder)
        await waitUntilSent(t, 3)
        let create = feedLineJSON(t.sent[2])
        XCTAssertEqual(create["method"] as? String, "session.create")
        let createParams = create["params"] as? [String: Any]
        XCTAssertNil(createParams?["cwd"], "outputs-only must omit the cwd key entirely")
        XCTAssertEqual(createParams?["approvalPolicy"] as? String, "auto")
    }

    // MARK: - Plan-immunity (2026-07-28 design): DetachedWindowController.isChatSession(_:in:) (PURE)

    func testIsChatSessionHelperMatchesTheModeField() {
        let rows = [
            SessionSummary(sessionId: "s_code", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code"),
            SessionSummary(sessionId: "s_chat", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "chat"),
            SessionSummary(sessionId: "s_dispatch", title: nil, createdAt: 3, scope: "global", cwd: nil, mode: "dispatch"),
            SessionSummary(sessionId: "s_absent", title: nil, createdAt: 4, scope: "global", cwd: nil, mode: nil),
        ]
        XCTAssertTrue(DetachedWindowController.isChatSession("s_chat", in: rows))
        XCTAssertFalse(DetachedWindowController.isChatSession("s_code", in: rows))
        XCTAssertFalse(DetachedWindowController.isChatSession("s_dispatch", in: rows))
        XCTAssertFalse(DetachedWindowController.isChatSession("s_absent", in: rows))
    }

    /// Conservative default: a row the directory hasn't loaded yet is treated as NOT chat — matches
    /// `FieldStateAdapter.isChatSession`'s own `false` default.
    func testIsChatSessionHelperDefaultsFalseForAnUnknownId() {
        XCTAssertFalse(DetachedWindowController.isChatSession("s_missing", in: []))
        XCTAssertFalse(DetachedWindowController.isChatSession("s_missing", in: [
            SessionSummary(sessionId: "s_other", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "chat"),
        ]))
    }

    // MARK: - Plan-immunity (2026-07-28 design): isChat construction + in-place switch

    /// The `isChat` construction param (defaulted `false`, matching every PRE-EXISTING caller of
    /// `DetachedWindowController.init`) seeds `adapter.isChatSession` — CONTROL: an ordinary window
    /// (the default, no `isChat` passed) stays non-chat.
    func testIsChatDefaultsFalseForAnOrdinaryWindow() {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        XCTAssertFalse(controller.adapterForTesting.isChatSession)
    }

    /// `isChat: true` (the shape a caller passes to seed a chat window's policy-picker-hidden
    /// state — today `AppDelegate.openSessionInNewDetachedWindow`'s auto-derivation and
    /// `handleWindowDetach`'s own derived value) seeds `adapter.isChatSession` true at construction.
    func testIsChatTrueSeedsAdapterIsChatSession() {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Chat", isChat: true
        )
        defer { controller.close() }
        XCTAssertTrue(controller.adapterForTesting.isChatSession)
    }

    /// `selectSession`'s in-place re-derivation: the left sidebar lists every session (chat
    /// included — a detached window's `SidebarWiring` never passes `rowFilter`, so `SessionSidebar`
    /// applies its default `{ _ in true }`, i.e. no filtering at all; only the orb's OWN sidebar
    /// wiring narrows it, via `AppDelegate.isOrbSidebarRow` — see `WorkSidebar.swift`'s doc comment
    /// on `SidebarWiring.rowFilter`), so switching a CODE window's pinned session onto an existing
    /// CHAT row (and back) must flip
    /// `adapter.isChatSession` both directions, off the directory's own `mode` field — proven via a
    /// real `directory.refresh()` round trip (not a hand-poked row), so this is what a REAL sidebar
    /// switch would actually see.
    func testSelectSessionUpdatesIsChatSessionFromTheDirectory() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()

        await answerHandshake(t, sessionId: "S1")
        await feedWaitUntil { session.state.status != .disconnected }
        XCTAssertFalse(controller.adapterForTesting.isChatSession, "S1 (code) starts non-chat")

        let refreshTask = Task { await controller.directory.refresh() }
        await waitUntilSent(t, 3)
        let list = feedLineJSON(t.sent[2])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"S1","scope":"global","createdAt":1,"lastSeq":0,"mode":"code"},{"sessionId":"S2","scope":"global","createdAt":2,"lastSeq":0,"mode":"chat"}]}}"#)
        await refreshTask.value

        controller.selectSession("S2")
        XCTAssertTrue(controller.adapterForTesting.isChatSession, "switching in-place onto a chat row must flip isChatSession on")

        controller.selectSession("S1")
        XCTAssertFalse(controller.adapterForTesting.isChatSession, "switching back off a chat row must flip isChatSession off")
    }

    /// Dispatch (Phase 7), task-7 review fix: the detached window's own respond wiring routes a
    /// relayed card's `childSessionId` to the CHILD (`childSessionId ?? self.sessionId`), proven on
    /// the wire — the DetachedWindowController leg of the same routing rule
    /// `CardWiringTests.testAppModelRespondApprovalRoutesToChildSessionId` pins for AppModel.
    /// A second respond with `nil` childSessionId pins the fallback leg (this window's own pinned
    /// session) in the same run.
    func testDetachedWindowRespondApprovalRoutesToChildSessionId() async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S_DISP"), session: session)
        let controller = DetachedWindowController(
            feed: feed, session: session,
            frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "Norma"
        )
        defer { controller.close() }
        controller.show()

        await answerHandshake(t, sessionId: "S_DISP")
        await feedWaitUntil { session.state.status != .disconnected }

        // Relayed card: childSessionId set → the RPC must target the CHILD, not S_DISP.
        controller.adapterForTesting.onApprovalRespond("call1", true, nil, "s_child_1")
        await waitUntilSent(t, 3)
        let respond = feedLineJSON(t.sent[2])
        XCTAssertEqual(respond["method"] as? String, "approval.respond")
        XCTAssertEqual((respond["params"] as? [String: Any])?["sessionId"] as? String, "s_child_1",
                       "the respond RPC must target the CHILD, not this window's pinned session")
        XCTAssertEqual((respond["params"] as? [String: Any])?["callId"] as? String, "call1")
        t.feed(#"{"jsonrpc":"2.0","id":\#(respond["id"] as! Int),"result":{"alreadyResolved":false}}"#)

        // Native card: nil childSessionId → falls back to this window's own pinned session.
        controller.adapterForTesting.onApprovalRespond("call2", false, nil, nil)
        await waitUntilSent(t, 4)
        let native = feedLineJSON(t.sent[3])
        XCTAssertEqual(native["method"] as? String, "approval.respond")
        XCTAssertEqual((native["params"] as? [String: Any])?["sessionId"] as? String, "S_DISP")
        t.feed(#"{"jsonrpc":"2.0","id":\#(native["id"] as! Int),"result":{"alreadyResolved":false}}"#)
    }

    func testAppModelMakeDetachedFeedSharesTokenAndTransport() async throws {
        let t = DetachedScriptedTransport()
        let appModel = AppModel(makeTransport: { t }, token: "shared-tok", clientName: "orb")

        guard let (feed, session) = appModel.makeDetachedFeed(sessionId: "S7") else {
            XCTFail("a real token must produce a detached feed")
            return
        }
        _ = session
        XCTAssertEqual(feed.pinnedSessionId, "S7")

        let startTask = Task { await feed.start() }
        defer { startTask.cancel(); feed.stop() }

        await waitUntilSent(t, 1)
        let hello = feedLineJSON(t.sent[0])
        XCTAssertEqual(hello["method"] as? String, "protocol.hello")
        XCTAssertEqual((hello["params"] as? [String: Any])?["token"] as? String, "shared-tok",
                       "the detached feed must share AppModel's own harness token")

        // AppDelegate.boot()'s degraded "no daemon token yet" fallback (AppDelegate.swift:40-51)
        // must never let a detached window spin up a harness that can't authenticate.
        let degraded = AppModel(makeTransport: { t }, token: AppModel.missingTokenSentinel, clientName: "orb")
        XCTAssertNil(degraded.makeDetachedFeed(sessionId: "S8"))
    }
}
