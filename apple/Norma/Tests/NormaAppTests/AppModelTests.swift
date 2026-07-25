import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Minimal scripted transport for app-level tests (NormaTransport is public;
/// NormaKit's own test helpers aren't exported, so we keep a local double).
final class AppScriptedTransport: NormaTransport, @unchecked Sendable {
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

func lineJSON(_ s: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
}

@MainActor
func waitUntil(_ timeout: TimeInterval = 3, _ cond: @MainActor () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !cond() && Date() < deadline {
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
}

@MainActor
final class AppModelTests: XCTestCase {
    /// Answers hello + session.list + session.attach as they arrive, then returns.
    func answerHandshake(_ t: AppScriptedTransport, sessions: String) async {
        // hello
        await waitUntilSent(t, 1)
        let hello = lineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        // session.list
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":\#(sessions)}}"#)
    }

    func waitUntilSent(_ t: AppScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    /// 2e-iii Task 5: `session_created`/`session_titled` now ALSO kick an unawaited
    /// `SessionDirectory` refresh (a `session.list` RPC) alongside whatever "real" RPC a test is
    /// waiting for — since that refresh races on its own `Task`, it can land on the wire at an
    /// unpredictable position relative to a fixed `t.sent[n]` index. This polls for the Nth line of
    /// a SPECIFIC method instead, tolerant of any interloping calls of other methods.
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

    func testStartAttachesNewestSessionAndReducesReplay() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        // orb-scope fix: focusNewestSession() now selects the newest DISPATCH session only — both
        // rows here are tagged "dispatch" so this test keeps exercising its original intent (pick
        // by createdAt) unchanged; the mode-filtering itself gets its own dedicated coverage below
        // (testFocusNewestSessionPicksNewestDispatchOverNewerCode / …WithNoDispatchSession).
        await answerHandshake(t, sessions: #"[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":9,"mode":"dispatch"},{"sessionId":"s_new","scope":"global","createdAt":2,"lastSeq":0,"mode":"dispatch"}]"#)
        // attach must target s_new (newest createdAt), fromSeq 0
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "s_new")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        await waitUntil { model.session.state.status != .disconnected } // markConnected happened
        XCTAssertEqual(model.session.state.status, .idle)

        // a live event for the attached session reduces
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":1,"sessionId":"s_new","ts":0,"threadId":"main"}}"#)
        await waitUntil { model.session.state.status == .thinking }
        XCTAssertEqual(model.session.state.status, .thinking)
    }

    func testSessionCreatedRefocusesToTheNewSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        // orb-scope fix: s_a is tagged dispatch so the INITIAL focus still lands here (this test's
        // subject is the SUBSEQUENT session_created-for-s_b refocus, not the initial attach).
        await answerHandshake(t, sessions: #"[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attachA = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachA["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        // another harness creates s_b → the orb follows (most-recent focus). Occurrence 2: the
        // FIRST session.attach was the initial s_a attach above — a directory-refresh session.list
        // may also land somewhere in between (2e-iii Task 5), but session.attach itself still
        // only fires twice total.
        // orb-scope fix: refocus-on-create is now gated to mode "dispatch" — this event is tagged
        // as such so this test keeps proving the (still-supported) dispatch-create refocus path;
        // the code/absent-mode "must NOT refocus" cases get their own dedicated tests below.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_b","ts":5,"scope":"global","mode":"dispatch"}}"#)
        let attachB = await waitUntilMethod(t, "session.attach", occurrence: 2)
        XCTAssertEqual((attachB["params"] as? [String: Any])?["sessionId"] as? String, "s_b")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachB["id"] as! Int),"result":{"ok":true,"lastSeq":1}}"#)

        // events for s_b now reduce; stale s_a events are ignored
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":2,"sessionId":"s_b","ts":6,"threadId":"main"}}"#)
        await waitUntil { model.session.state.status == .thinking }
        XCTAssertEqual(model.session.state.status, .thinking)

        // stale s_a event after refocus must be ignored (filter is the divergence guard)
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_completed","seq":3,"sessionId":"s_a","ts":7,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}}"#)
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(model.session.state.status, .thinking) // s_a's turn_completed did NOT flip us to idle
    }

    func testSendOrSteerCreatesSessionWhenNoneAndSends() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: "[]")
        await waitUntil { model.session.state.status == .idle }

        async let sent = model.sendOrSteer("hello")
        await waitUntilSent(t, 3)
        let create = lineJSON(t.sent[2])
        // Dispatch (Phase 7): the orb's own session-creation path is now the ONE permanent
        // dispatch singleton (`session.dispatch`, no params) rather than a fresh ask/auto session
        // per summon — see AppModelTests below for the dedicated dispatch-shape coverage.
        XCTAssertEqual(create["method"] as? String, "session.dispatch")
        // REAL daemon wire order: broadcast BEFORE the RPC response. The broadcast also kicks an
        // unawaited directory refresh (2e-iii Task 5, a session.list RPC) — `waitUntilMethod` below
        // finds the attach/send calls by METHOD rather than a fixed index, tolerant of that.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_new","ts":0,"scope":"global"}}"#)
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_new","created":true}}"#)
        // exactly ONE attach must follow (either path — never both)
        let attach = await waitUntilMethod(t, "session.attach")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":1}}"#)
        // then the send goes out
        let send = await waitUntilMethod(t, "session.send")
        t.feed(#"{"jsonrpc":"2.0","id":\#(send["id"] as! Int),"result":{"seq":2}}"#)
        let ok = await sent
        XCTAssertTrue(ok)
        // settle: no SECOND attach/reset thrash may trail in
        try? await Task.sleep(nanoseconds: 300_000_000)
        let attaches = t.sent.filter { lineJSON($0)["method"] as? String == "session.attach" }
        XCTAssertEqual(attaches.count, 1, "double refocus: \(t.sent)")
    }

    func testSendDuringRunningTurnSteers() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        // orb-scope fix: s_1 tagged dispatch so the initial focus (this test's real subject is
        // send/steer/interrupt behavior, unrelated to mode-filtering) lands as before.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":1,"sessionId":"s_1","ts":0,"threadId":"main"}}"#)
        await waitUntil { model.session.state.turnRunning }

        async let sent = model.sendOrSteer("also do X")
        // 2d-iii task 4 (force-auto removal): the steer goes straight out — no setPolicy precedes
        // it anymore (see testNoSetPolicyOnAttachOrSteer below).
        await waitUntilSent(t, 4)
        let steer = lineJSON(t.sent[3])
        XCTAssertEqual(steer["method"] as? String, "session.steer")
        t.feed(#"{"jsonrpc":"2.0","id":\#(steer["id"] as! Int),"result":{"ok":true,"injected":true}}"#)
        _ = await sent
    }

    /// 2d-iii task 4 (force-auto removal): replaces the old `testForcesAutoPolicyOnceForFollowedSession`.
    /// Attaching to an existing (daemon-created, ask-policy) session and sending/steering into it
    /// must NEVER touch `session.setPolicy` — the orb no longer force-flips a followed session's
    /// policy onto `auto`; it now has its own approval UI (pending-interaction cards, task 3), so
    /// an ask/plan-mode session simply surfaces its approvals as cards instead of being silently
    /// forced past. Attached sessions keep their own policy; the ⋯ menu's `setSessionPolicy` (see
    /// PolicyMenuTests) is the only way a policy changes now, and only on explicit user action.
    func testNoSetPolicyOnAttachOrSteer() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        // orb-scope fix: s_1 tagged dispatch so the initial focus (this test's real subject is
        // send/steer/interrupt behavior, unrelated to mode-filtering) lands as before.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let first = model.sendOrSteer("one")
        await waitUntilSent(t, 4)
        let send = lineJSON(t.sent[3])
        XCTAssertEqual(send["method"] as? String, "session.send")
        t.feed(#"{"jsonrpc":"2.0","id":\#(send["id"] as! Int),"result":{"seq":1}}"#)
        _ = await first

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":1,"sessionId":"s_1","ts":0,"threadId":"main"}}"#)
        await waitUntil { model.session.state.turnRunning }

        async let second = model.sendOrSteer("two")
        await waitUntilSent(t, 5)
        let steer = lineJSON(t.sent[4])
        XCTAssertEqual(steer["method"] as? String, "session.steer")
        t.feed(#"{"jsonrpc":"2.0","id":\#(steer["id"] as! Int),"result":{"ok":true,"injected":true}}"#)
        _ = await second

        let policyCalls = t.sent.filter { lineJSON($0)["method"] as? String == "session.setPolicy" }
        XCTAssertEqual(policyCalls.count, 0, "attached session must keep its own policy — no setPolicy on attach/send/steer: \(t.sent)")
    }

    func testInterruptTargetsFocusedSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        // orb-scope fix: s_1 tagged dispatch so the initial focus (this test's real subject is
        // send/steer/interrupt behavior, unrelated to mode-filtering) lands as before.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let _: Void = model.interruptTurn()
        await waitUntilSent(t, 4)
        let intr = lineJSON(t.sent[3])
        XCTAssertEqual(intr["method"] as? String, "session.interrupt")
        XCTAssertEqual((intr["params"] as? [String: Any])?["sessionId"] as? String, "s_1")
        t.feed(#"{"jsonrpc":"2.0","id":\#(intr["id"] as! Int),"result":{"ok":true,"wasRunning":true}}"#)
    }

    /// Task 4 (detach choreography): after a detach, the orb's next summon must never keep
    /// talking into the session that just left for a standalone window — so
    /// `startFreshSessionAfterDetach()` creates + refocuses UNCONDITIONALLY, even though a focus
    /// (the just-detached session) already exists.
    func testStartFreshSessionAfterDetachCreatesAndRefocuses() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        // orb-scope fix: s_old is tagged dispatch so the initial focus lands here as before — this
        // test's subject is the fresh-session-after-detach flow, not the initial-attach filtering.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attachOld = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachOld["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }
        XCTAssertEqual(model.focusedSessionId, "s_old", "a focus already exists going into the detach")

        async let _: Void = model.startFreshSessionAfterDetach()
        await waitUntilSent(t, 4)
        let create = lineJSON(t.sent[3])
        // Dispatch (Phase 7): "fresh" now collapses onto the ONE permanent dispatch singleton —
        // `session.dispatch`, not a brand-new `session.create` per summon.
        XCTAssertEqual(create["method"] as? String, "session.dispatch", "must dispatch unconditionally despite the existing focus")

        // REAL daemon wire order: broadcast BEFORE the RPC response. The broadcast also kicks an
        // unawaited directory refresh (2e-iii Task 5, a session.list RPC) that can interleave here
        // — `waitUntilMethod` finds the SECOND session.attach (the first was the initial s_old
        // attach above) by method rather than a fixed sent-array index.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_new","ts":0,"scope":"global"}}"#)
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_new","created":true}}"#)

        let attach = await waitUntilMethod(t, "session.attach", occurrence: 2)
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "s_new", "must attach to the NEW id, not stay on s_old")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":1}}"#)

        await waitUntil { model.focusedSessionId == "s_new" }
        XCTAssertEqual(model.focusedSessionId, "s_new")
        // settle: no SECOND attach/dispatch thrash may trail in
        try? await Task.sleep(nanoseconds: 300_000_000)
        let creates = t.sent.filter { lineJSON($0)["method"] as? String == "session.dispatch" }
        XCTAssertEqual(creates.count, 1, "double dispatch: \(t.sent)")
    }

    func testNoSessionsMeansConnectedIdleUnattached() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await answerHandshake(t, sessions: "[]")
        await waitUntil { model.session.state.status == .idle }
        XCTAssertEqual(model.session.state.status, .idle) // connected, nothing to attach
        XCTAssertEqual(t.sent.count, 2) // hello + list only, no attach
    }

    // MARK: - orb-scope: the orb/field is a DISPATCH-mode surface only. Code sessions (phone/CLI/
    // TUI) must never steal the orb's focus — the daemon broadcasts session_created to EVERY
    // authed harness, and remote/phone/CLI creates are always mode "code" (protocol contract:
    // mode ABSENT means "code", packages/protocol/src/events.ts).

    /// A CODE-mode session_created (e.g. a phone-originated Code session) must never refocus the
    /// orb away from whatever it's already following. The directory/session-list observer is
    /// composed separately in `feed.onEvent` — BEFORE `handle(ev)` even runs — so it still sees
    /// the event and refreshes; this proves the fix gates only the FOCUS action, not the side-
    /// observer fan-out the sidebar/dashboard depend on.
    func testSessionCreatedCodeModeNeverRefocusesButDirectorySeesIt() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await answerHandshake(t, sessions: #"[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attachA = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachA["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }
        XCTAssertEqual(model.focusedSessionId, "s_a")

        // A phone/CLI Code session is created elsewhere — must NOT summon the orb's field.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_phone","ts":5,"scope":"global","mode":"code"}}"#)

        // The directory's own unconditional refresh (SessionDirectory.handle's sessionCreated
        // case) still fires — answer its session.list re-fetch and confirm the row lands.
        let relist = await waitUntilMethod(t, "session.list", occurrence: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_phone","scope":"global","createdAt":5,"lastSeq":0,"mode":"code"}]}}"#)
        await waitUntil { model.directory.rows.contains { $0.sessionId == "s_phone" } }
        XCTAssertTrue(model.directory.rows.contains { $0.sessionId == "s_phone" }, "the side-observer (directory/session list) must still see the code session")

        // settle: focus must never have moved off s_a — no second session.attach.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(model.focusedSessionId, "s_a", "a code-mode session_created must never steal the orb's focus")
        let attaches = t.sent.filter { lineJSON($0)["method"] as? String == "session.attach" }
        XCTAssertEqual(attaches.count, 1, "no refocus attach for the code session: \(t.sent)")
    }

    /// Pins the subtle half of the protocol contract: mode ABSENT means "code" — must be treated
    /// identically to an explicit "code", never as an implicit dispatch. (packages/protocol/
    /// src/events.ts: "absent means code, same convention as SessionRow.mode/opts.mode elsewhere".)
    func testSessionCreatedAbsentModeNeverRefocuses() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await answerHandshake(t, sessions: #"[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attachA = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachA["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }
        XCTAssertEqual(model.focusedSessionId, "s_a")

        // No "mode" key at all in this event — unlike the explicit-"code" test above.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_absent","ts":5,"scope":"global"}}"#)

        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(model.focusedSessionId, "s_a", "mode-absent session_created must be treated as code — never refocus")
        let attaches = t.sent.filter { lineJSON($0)["method"] as? String == "session.attach" }
        XCTAssertEqual(attaches.count, 1, "no refocus attach for the mode-absent session: \(t.sent)")
    }

    /// Chat Mode Slice A (CM-T3), REGRESSION and load-bearing: a CHAT-mode `session_created` (e.g.
    /// the menu bar's "New Chat"/"Chat" creating one, or a chat session opened from elsewhere) must
    /// never refocus the orb either — same contract as the CODE-mode test above, just for the new
    /// mode value. Site 1 of the three orb-scope gates (`sessionCreated`'s `v.mode == "dispatch"`
    /// check) is a POSITIVE match on "dispatch" only, so "chat" already falls through it exactly
    /// like "code" always has — this test is the evidence, not a code change.
    func testSessionCreatedChatModeNeverRefocusesButDirectorySeesIt() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await answerHandshake(t, sessions: #"[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attachA = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachA["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }
        XCTAssertEqual(model.focusedSessionId, "s_a")

        // A chat session is created (e.g. "New Chat" from the menu bar) — must NOT summon the
        // orb's field.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_chat","ts":5,"scope":"global","mode":"chat"}}"#)

        // The directory's own unconditional refresh still fires — answer its session.list
        // re-fetch and confirm the row lands, same side-observer proof as the code-mode test.
        let relist = await waitUntilMethod(t, "session.list", occurrence: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_chat","scope":"global","createdAt":5,"lastSeq":0,"mode":"chat"}]}}"#)
        await waitUntil { model.directory.rows.contains { $0.sessionId == "s_chat" } }
        XCTAssertTrue(model.directory.rows.contains { $0.sessionId == "s_chat" }, "the side-observer (directory/session list) must still see the chat session")

        // settle: focus must never have moved off s_a — no second session.attach.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(model.focusedSessionId, "s_a", "a chat-mode session_created must never steal the orb's focus")
        let attaches = t.sent.filter { lineJSON($0)["method"] as? String == "session.attach" }
        XCTAssertEqual(attaches.count, 1, "no refocus attach for the chat session: \(t.sent)")
    }

    /// Chat Mode Slice A (CM-T3): site 2 (`focusNewestSession()`'s own `mode == "dispatch"` filter)
    /// — a chat session, even the newest overall, must never win the connect-time auto-focus. Same
    /// shape as `testFocusNewestSessionPicksNewestDispatchOverNewerCode` just above, chat instead
    /// of code.
    func testFocusNewestSessionPicksNewestDispatchOverNewerChat() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        // s_chat is NEWER overall (createdAt 9) but mode "chat" — must be skipped entirely.
        // s_dispatch is older (createdAt 3) but the only dispatch session — must win.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_dispatch","scope":"global","createdAt":3,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_chat","scope":"global","createdAt":9,"lastSeq":0,"mode":"chat"}]"#)

        let attach = await waitUntilMethod(t, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "s_dispatch", "must attach the newest DISPATCH session, not the newest overall")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_dispatch" }
        XCTAssertEqual(model.focusedSessionId, "s_dispatch")

        // settle: no second attach targeting s_chat may trail in.
        try? await Task.sleep(nanoseconds: 200_000_000)
        let attaches = t.sent.filter { lineJSON($0)["method"] as? String == "session.attach" }
        XCTAssertEqual(attaches.count, 1, "no attach to the newer chat session: \(t.sent)")
    }

    /// `focusNewestSession()` (fired from `feed.onAttach` on every connect/reconnect) must pick the
    /// newest DISPATCH session, ignoring a newer code one entirely.
    func testFocusNewestSessionPicksNewestDispatchOverNewerCode() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        // s_code is NEWER overall (createdAt 9) but mode "code" — must be skipped entirely.
        // s_dispatch is older (createdAt 3) but the only dispatch session — must win.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_dispatch","scope":"global","createdAt":3,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_code","scope":"global","createdAt":9,"lastSeq":0,"mode":"code"}]"#)

        let attach = await waitUntilMethod(t, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "s_dispatch", "must attach the newest DISPATCH session, not the newest overall")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_dispatch" }
        XCTAssertEqual(model.focusedSessionId, "s_dispatch")

        // settle: no second attach targeting s_code may trail in.
        try? await Task.sleep(nanoseconds: 200_000_000)
        let attaches = t.sent.filter { lineJSON($0)["method"] as? String == "session.attach" }
        XCTAssertEqual(attaches.count, 1, "no attach to the newer code session: \(t.sent)")
    }

    /// No dispatch session exists yet — the correct pre-first-summon state is `focusedSessionId ==
    /// nil` (never falling back to the newest CODE session). `ensureFocusedSession()` mints the
    /// dispatch singleton on the first deliberate summon/submit; that is out of scope here.
    func testFocusNewestSessionStaysUnfocusedWithNoDispatchSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await answerHandshake(t, sessions: #"[{"sessionId":"s_code1","scope":"global","createdAt":1,"lastSeq":0,"mode":"code"},{"sessionId":"s_code2","scope":"global","createdAt":2,"lastSeq":0,"mode":"code"}]"#)
        await waitUntil { model.session.state.status == .idle } // connected, nothing to attach

        XCTAssertNil(model.focusedSessionId, "no dispatch session exists yet — pre-first-summon state")
        // settle: confirm no attach ever fires.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(t.sent.count, 2, "hello + list only, no attach when no dispatch session exists: \(t.sent)")
    }
}
