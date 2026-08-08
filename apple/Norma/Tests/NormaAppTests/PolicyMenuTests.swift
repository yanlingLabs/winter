import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Task 4 (2d-iii): the ⋯ menu's approval-mode picker. Covers `FieldStateAdapter.sessionPolicy`'s
/// seed/update-on-success discipline (mirrors `CardWiringTests.testAdapterInFlightLifecycle`'s
/// in-flight idiom for the three respond callbacks, simplified to a single session-wide flag — see
/// `policyChangeInFlight`'s doc) and the `AppModel.setSessionPolicy` → wire shape (mirrors
/// `CardWiringTests.testAppModelRespondApprovalWireShape`). Nothing here drives the live popover/
/// `Button` UI — same posture as `CardWiringTests`' own note: that isn't independently
/// unit-testable, only the plumbing behind it is.
final class PolicyMenuTests: XCTestCase {
    // MARK: - Adapter seed / in-flight / update-on-success

    @MainActor
    func testSessionPolicySeededAuto() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        XCTAssertEqual(adapter.sessionPolicy, "auto", "orb-created-session default (AppModel.ensureFocusedSession) — no wire read seeds this; session.list/session.attach don't expose approvalPolicy (see sessionPolicy's doc)")
        XCTAssertFalse(adapter.policyChangeInFlight)
    }

    @MainActor
    func testSessionPolicyUpdatesOnlyOnSuccess() async throws {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        var stubSucceeds = true

        // Exact wiring shape the brief specifies for GlassRootView/DetachedWindowController — a
        // STUB (not a real AppModel/NormaClient) so this test locks down the discipline itself:
        // in-flight flipped SYNCHRONOUSLY, cleared once the stub resolves, and `sessionPolicy`
        // bumped to the new value ONLY on success.
        adapter.onSetPolicy = { [adapter] policy in
            adapter.policyChangeInFlight = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 20_000_000)
                let ok = stubSucceeds
                adapter.policyChangeInFlight = false
                if ok { adapter.sessionPolicy = policy }
            }
        }

        adapter.onSetPolicy("ask")
        XCTAssertTrue(adapter.policyChangeInFlight, "must flip in-flight SYNCHRONOUSLY, before the RPC resolves")
        await waitUntil { !adapter.policyChangeInFlight }
        XCTAssertEqual(adapter.sessionPolicy, "ask", "a successful flip updates the last-known value")

        stubSucceeds = false
        adapter.onSetPolicy("plan")
        XCTAssertTrue(adapter.policyChangeInFlight)
        await waitUntil { !adapter.policyChangeInFlight }
        XCTAssertEqual(adapter.sessionPolicy, "ask", "a FAILED flip must not lie about the new value — stays at the last-known-good one")
    }

    // MARK: - AppModel → wire shape

    /// Local copy of `AppModelTests`' scripted-transport handshake helpers — see
    /// `CardWiringTests`' identical copy for why each test file keeps its own instance-method
    /// versions (`AppScriptedTransport`/`lineJSON`/`waitUntil` are target-wide free/internal
    /// symbols; `answerHandshake`/`waitUntilSent` are not).
    func waitUntilSent(_ t: AppScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    func answerHandshake(_ t: AppScriptedTransport, sessions: String) async {
        await waitUntilSent(t, 1)
        let hello = lineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":\#(sessions)}}"#)
    }

    @MainActor
    func testAppModelSetSessionPolicyWireShape() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        // orb-scope fix: s_1 tagged dispatch so the initial connect-time focus (unrelated to this
        // test's subject) still lands as before.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let responded = model.setSessionPolicy("plan")
        await waitUntilSent(t, 4)
        let setPolicy = lineJSON(t.sent[3])
        XCTAssertEqual(setPolicy["method"] as? String, "session.setPolicy")
        let params = setPolicy["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "s_1")
        XCTAssertEqual(params?["policy"] as? String, "plan")
        t.feed(#"{"jsonrpc":"2.0","id":\#(setPolicy["id"] as! Int),"result":{"ok":true}}"#)
        let ok = await responded
        XCTAssertTrue(ok)
    }

    /// No focused session yet: `setSessionPolicy` must fail closed (false), never crash / send with
    /// an empty sessionId — mirrors `sendOrSteer`'s/the three respond methods' own guard.
    @MainActor
    func testAppModelSetSessionPolicyFailsWithoutFocusedSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let ok = await model.setSessionPolicy("auto")
        XCTAssertFalse(ok)
        XCTAssertTrue(t.sent.isEmpty, "no RPC should go out with no focused session")
    }

    // MARK: - SP-policies Task 14: six-mode list + bypass danger

    /// The picker's offered modes — wire-identical to the CLI's `POLICY_ORDER`
    /// (`packages/cli/src/tui/app.tsx`) and the protocol's `ApprovalPolicy` enum
    /// (`packages/protocol/src/methods.ts`), in restrictiveness order.
    func testSessionPolicyModesIsSixValuesInRestrictivenessOrder() {
        XCTAssertEqual(sessionPolicyModes, ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"])
    }

    /// `bypass` is the only mode that auto-approves everything (including dangerous-domain
    /// calls, SP-policies Task 10) — the picker row's danger treatment must key off exactly this.
    func testBypassIsTheOnlyDangerousMode() {
        for policy in sessionPolicyModes {
            XCTAssertEqual(isPolicyDangerous(policy), policy == "bypass", "\(policy)'s danger flag")
        }
    }

    /// Every mode gets a readable label — not a bare `.capitalized` (which would render the
    /// hyphenated modes as "Dont-Ask"/"Accept-Edits").
    func testPolicyDisplayLabelsAreReadableForEveryMode() {
        let labels = sessionPolicyModes.map(policyDisplayLabel)
        XCTAssertEqual(labels, ["Plan", "Don't Ask", "Ask", "Accept Edits", "Auto", "Bypass"])
    }

    // MARK: - Plan-immunity (2026-07-28 design; fix round 1, review finding "door 3"):
    // OrbWindowController.updateIsChatSession — the orb's OWN adapter, separate from any
    // DetachedWindowController's own, must also stop lying about whether the picker is editable.

    /// Local copy of `AppModelTests`' `waitUntilMethod` — polls for the Nth occurrence of a
    /// specific RPC method rather than a fixed `t.sent[n]` index, tolerant of the directory's own
    /// unawaited `session.list` re-fetch racing on the wire alongside whatever this test is
    /// waiting for (same rationale as that file's own doc comment on the method).
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

    /// `AppDelegate.boot()`'s own `AppModel` can never be given a scripted transport in a unit test
    /// (its `isRunningUnitTests` gate always falls back to a token-missing model whose
    /// `makeDetachedFeed` — and, by extension, every RPC — fails immediately), so the ACTUAL
    /// `orb.sidebars.onSelect` closure isn't independently end-to-end testable. This proves the
    /// method that closure delegates to instead (`OrbWindowController.updateIsChatSession`) against
    /// a REAL `model.directory.rows`, populated via a genuine scripted-transport round trip (not a
    /// hand-fed array) — the same "session_created kicks the directory's own re-list" mechanism
    /// `AppModelTests.testSessionCreatedChatModeNeverRefocusesButDirectorySeesIt` already proves
    /// populates chat rows correctly. The `onSelect` closure itself is now a one-line, obviously-
    /// correct delegate to this method plus the pre-existing `focusSession` call (see
    /// `AppDelegate.swift`'s own doc comment at that call site).
    @MainActor
    func testOrbUpdateIsChatSessionTracksARealDirectoryRoundTrip() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await answerHandshake(t, sessions: #"[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        // A chat session appears (e.g. created from another window) — kicks the directory's own
        // unconditional re-list, same mechanism AppModelTests' chat-mode test already proves.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_chat","ts":5,"scope":"global","mode":"chat"}}"#)
        let relist = await waitUntilMethod(t, "session.list", occurrence: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_a","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_chat","scope":"global","createdAt":5,"lastSeq":0,"mode":"chat"}]}}"#)
        await waitUntil { model.directory.rows.contains { $0.sessionId == "s_chat" } }

        let orb = OrbWindowController(session: SessionModel())
        XCTAssertFalse(orb.fieldAdapter.isChatSession, "a fresh orb adapter starts non-chat")

        // panel-shell T10b review fix (Important 1): this method is the orb's own
        // in-place-session-switch site — same sibling as `ShellSessionHost.hop`/
        // `DetachedWindowController.selectSession`, both of which already clear
        // `pendingCardDrafts` on switch. Doubly important here: `fieldAdapter` lives for the
        // WHOLE APP LIFETIME (a `let`, never torn down), so a forgotten clear on this one path
        // doesn't just leak one switch's entries — it accumulates for as long as the app runs.
        orb.fieldAdapter.pendingCardDrafts["stale"] = PendingCardDraft(feedback: "leftover")

        orb.updateIsChatSession(for: "s_chat", rows: model.directory.rows)
        XCTAssertTrue(orb.fieldAdapter.isChatSession, "selecting a REAL chat row (from an actual directory round trip) must flip the orb's OWN adapter")
        XCTAssertTrue(orb.fieldAdapter.pendingCardDrafts.isEmpty,
            "switching session in place must clear pendingCardDrafts — same discipline as the other two switch sites, and the ONE adapter that never dies to bound it any other way")

        orb.updateIsChatSession(for: "s_a", rows: model.directory.rows)
        XCTAssertFalse(orb.fieldAdapter.isChatSession, "switching back to a non-chat row must flip it back off")
    }

    /// CONTROL: an id the directory hasn't loaded (yet) resolves non-chat — matches
    /// `DetachedWindowController.isChatSession`'s own documented "not found -> false" behavior
    /// (the SAME pure helper this method calls).
    @MainActor
    func testOrbUpdateIsChatSessionDefaultsFalseForAnUnknownId() {
        let orb = OrbWindowController(session: SessionModel())
        orb.updateIsChatSession(for: "s_missing", rows: [])
        XCTAssertFalse(orb.fieldAdapter.isChatSession)
    }

    /// Review round 3 (new Important): the clear above had no same-session guard, so a REDUNDANT
    /// reselect silently discarded a live draft even though nothing about the session actually
    /// changed. Reachable end-to-end: `SessionSidebarRow.onTapGesture`
    /// (`SessionSidebar.swift`) calls `onSelect(row.sessionId)` UNCONDITIONALLY — no `isCurrent`
    /// check — so re-clicking the already-highlighted row reaches `updateIsChatSession` again
    /// with the SAME sessionId; `AppModel.refocus`'s own idempotency guard then makes the
    /// subsequent `focusSession` call a genuine no-op, so `session.reset()` never runs and
    /// `pendingInteractions` is untouched — the ONLY thing that changed was the (now-guarded)
    /// clear itself. `boundSessionId` is wired to a fixed value here (unlike this file's other
    /// two `updateIsChatSession` tests, which leave it at the default `{ nil }`) because the
    /// guard compares against it — an unwired `{ nil }` would make every call read as
    /// "different" (`nil` never equals a real sessionId string) and this test would pass even
    /// against a still-broken, unguarded implementation.
    @MainActor
    func testUpdateIsChatSessionOnTheAlreadyDisplayedSessionNeverClearsALiveDraft() {
        let orb = OrbWindowController(session: SessionModel())
        orb.fieldAdapter.boundSessionId = { "s_chat" }

        orb.updateIsChatSession(for: "s_chat", rows: [])
        orb.fieldAdapter.pendingCardDraftBinding(for: "q1").wrappedValue.setOtherText("Postgres", forQuestion: 0)

        // The redundant reselect: same sessionId, nothing about the session changed.
        orb.updateIsChatSession(for: "s_chat", rows: [])

        XCTAssertEqual(orb.fieldAdapter.pendingCardDraftBinding(for: "q1").wrappedValue.otherTexts[0], "Postgres",
            "a redundant reselect of the session already displayed must never discard a live, typed-but-unsubmitted draft")
    }
}
