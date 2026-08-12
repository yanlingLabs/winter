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
        // mac-chat-parity T4 corrected this assertion's REASON, not its value: a fresh adapter is
        // still "auto", but that is now the placeholder for "nobody has told us yet" rather than a
        // claim — `session.list` DOES carry `approvalPolicy` now, and `seedSessionPolicy` reads it.
        XCTAssertEqual(adapter.sessionPolicy, "auto", "the orb-created-session default (AppModel.ensureFocusedSession), unchanged — an unseeded adapter has asked nobody")
        XCTAssertFalse(adapter.sessionPolicyKnown, "and it must SAY it has asked nobody — see sessionPolicyKnown's doc")
        XCTAssertFalse(adapter.policyChangeInFlight)
    }

    // MARK: - mac-chat-parity T4: seeded from the wire, not from the default

    /// THE test this task exists for: a session running `bypass` reads `bypass` **before** anyone
    /// calls `setPolicy`. Pre-T4 the adapter had no wire source at all, so this row would have read
    /// "Auto" for the rest of the attachment — inverting the danger styling's entire purpose in the
    /// persistent row Task 6 builds.
    @MainActor
    func testSessionPolicySeededFromTheWireRowBeforeAnySetPolicy() {
        let adapter = FieldStateAdapter(session: SessionModel())
        let rows = [
            SessionSummary(sessionId: "s_other", title: nil, createdAt: 1, scope: "global", approvalPolicy: "ask"),
            SessionSummary(sessionId: "s_danger", title: nil, createdAt: 2, scope: "global", approvalPolicy: "bypass"),
        ]
        adapter.seedSessionPolicy(for: "s_danger", in: rows)
        XCTAssertEqual(adapter.sessionPolicy, "bypass", "the DAEMON's answer, read off session.list's row — no setPolicy has been called")
        XCTAssertTrue(adapter.sessionPolicyKnown)
        XCTAssertFalse(adapter.policyChangeInFlight, "seeding is a read; it must not look like a write in flight")
    }

    /// A chat row's policy is the INTERNAL `"chat"` — not one of `sessionPolicyModes`, and refused
    /// by `session.setPolicy` as an input. It must thread through verbatim: the picker is hidden for
    /// chat anyway (`isChatSession`), and a value silently rewritten to a settable mode would make
    /// the one row that explains itself look like an ordinary editable session.
    @MainActor
    func testAChatRowsInternalPolicyThreadsThroughVerbatim() {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.seedSessionPolicy(for: "s_chat", in: [
            SessionSummary(sessionId: "s_chat", title: nil, createdAt: 1, scope: "global", mode: "chat", approvalPolicy: "chat"),
        ])
        XCTAssertEqual(adapter.sessionPolicy, "chat")
        XCTAssertTrue(adapter.sessionPolicyKnown)
        XCTAssertFalse(sessionPolicyModes.contains(adapter.sessionPolicy), "the premise: no picker row will ever match it")
    }

    /// OLD DAEMON (and the not-yet-loaded row, which is the same absence): today's behaviour EXACTLY
    /// — `"auto"`, no crash — plus the one thing that makes that honest: it is flagged as not known.
    /// Coercing absence to a displayed policy is the standing lie this whole task removes; the
    /// placeholder is only safe because a consumer can tell it apart from an answer.
    @MainActor
    func testAnAbsentApprovalPolicyKeepsTodaysBehaviourAndSaysItIsUnknown() {
        let adapter = FieldStateAdapter(session: SessionModel())

        // A row from a daemon predating the field.
        adapter.seedSessionPolicy(for: "s_old", in: [
            SessionSummary(sessionId: "s_old", title: nil, createdAt: 1, scope: "global"),
        ])
        XCTAssertEqual(adapter.sessionPolicy, "auto", "unchanged from the pre-T4 seed")
        XCTAssertFalse(adapter.sessionPolicyKnown, "…but never presented as the daemon's answer")

        // A row the directory has not loaded yet — indistinguishable, and correctly so.
        adapter.seedSessionPolicy(for: "s_missing", in: [])
        XCTAssertEqual(adapter.sessionPolicy, "auto")
        XCTAssertFalse(adapter.sessionPolicyKnown)
    }

    /// An in-place session SWITCH (`ShellSessionHost.hop` / `DetachedWindowController.selectSession`)
    /// must never carry the departed session's policy onto the arriving one — the same "a refusal is
    /// about the session it was refused FOR" discipline those two call sites already apply to
    /// `dirsRefusal`/`activityRefusal`/`pendingModel`. Seeding therefore RESETS on absence rather
    /// than leaving the previous value in place.
    @MainActor
    func testSwitchingToASessionWithNoReportedPolicyNeverCarriesTheOldOne() {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.seedSessionPolicy(for: "s_danger", in: [
            SessionSummary(sessionId: "s_danger", title: nil, createdAt: 1, scope: "global", approvalPolicy: "bypass"),
        ])
        XCTAssertEqual(adapter.sessionPolicy, "bypass")

        adapter.seedSessionPolicy(for: "s_unknown", in: [
            SessionSummary(sessionId: "s_unknown", title: nil, createdAt: 2, scope: "global"),
        ])
        XCTAssertEqual(adapter.sessionPolicy, "auto", "the arriving session's UNKNOWN, not the departed session's bypass")
        XCTAssertFalse(adapter.sessionPolicyKnown)
    }

    /// The heal: a session attached BEFORE its row loaded (the New-Chat race, and any caller that
    /// attaches ahead of the directory's refresh — `reconcileIsChatSession`'s documented "fourth
    /// door") must pick the policy up the moment the row lands. Guarded to the unknown case only,
    /// which is what makes it safe to run on every `directory.$rows` change: once the value is known
    /// — seeded, or written by this surface's own successful `setPolicy` — a later list result that
    /// was already in flight can never revert it.
    @MainActor
    func testTheRowLandingLaterHealsAnUnknownPolicyAndNeverRevertsAKnownOne() {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.seedSessionPolicy(for: "s_1", in: []) // attached before the row loaded
        XCTAssertFalse(adapter.sessionPolicyKnown)

        adapter.healSessionPolicyIfUnknown(for: "s_1", in: [
            SessionSummary(sessionId: "s_1", title: nil, createdAt: 1, scope: "global", approvalPolicy: "plan"),
        ])
        XCTAssertEqual(adapter.sessionPolicy, "plan", "the row landed; the picker heals")
        XCTAssertTrue(adapter.sessionPolicyKnown)

        // A STALE list result — issued before a change, resolving after it — must not undo the
        // change. This is the whole reason the heal is one-way.
        adapter.adoptSessionPolicy("bypass")
        adapter.healSessionPolicyIfUnknown(for: "s_1", in: [
            SessionSummary(sessionId: "s_1", title: nil, createdAt: 1, scope: "global", approvalPolicy: "plan"),
        ])
        XCTAssertEqual(adapter.sessionPolicy, "bypass", "a known value is never overwritten by a heal")
    }

    /// A successful `setPolicy` is itself an answer from the daemon — the value AND its known-ness
    /// move together, so a surface that renders only known policies does not go blank the instant
    /// the user picks one.
    @MainActor
    func testAdoptingAPolicyAfterASuccessfulSetMarksItKnown() {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.adoptSessionPolicy("accept-edits")
        XCTAssertEqual(adapter.sessionPolicy, "accept-edits")
        XCTAssertTrue(adapter.sessionPolicyKnown)
    }

    /// The pure lookup both of the above ride on, tested on its own terms: it reads ONE row and
    /// answers `nil` for "no such row" and "the row said nothing" alike — the two absences a
    /// consumer must treat identically.
    func testWireApprovalPolicyReadsTheMatchingRowOnly() {
        let rows = [
            SessionSummary(sessionId: "s_a", title: nil, createdAt: 1, scope: "global", approvalPolicy: "auto"),
            SessionSummary(sessionId: "s_b", title: nil, createdAt: 2, scope: "global", approvalPolicy: "bypass"),
            SessionSummary(sessionId: "s_c", title: nil, createdAt: 3, scope: "global"),
        ]
        XCTAssertEqual(wireApprovalPolicy("s_b", in: rows), "bypass")
        XCTAssertNil(wireApprovalPolicy("s_c", in: rows), "the row exists and said nothing")
        XCTAssertNil(wireApprovalPolicy("s_missing", in: rows), "no such row — the same absence")
    }

    @MainActor
    func testSessionPolicyUpdatesOnlyOnSuccess() async throws {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        var stubSucceeds = true

        // Exact wiring shape the three real wirers use (GlassRootView / DetachedWindowController /
        // ShellSessionHost) — a STUB (not a real AppModel/NormaClient) so this test locks down the
        // discipline itself: in-flight flipped SYNCHRONOUSLY, cleared once the stub resolves, and
        // the policy adopted ONLY on success. mac-chat-parity T4 replaced the bare
        // `adapter.sessionPolicy = policy` with `adoptSessionPolicy`, which is what keeps the value
        // and its known-ness from ever being set apart; this stub tracks that change so it keeps
        // meaning "the exact shape" rather than merely resembling it.
        adapter.onSetPolicy = { [adapter] policy in
            adapter.policyChangeInFlight = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 20_000_000)
                let ok = stubSucceeds
                adapter.policyChangeInFlight = false
                if ok { adapter.adoptSessionPolicy(policy) }
            }
        }

        adapter.onSetPolicy("ask")
        XCTAssertTrue(adapter.policyChangeInFlight, "must flip in-flight SYNCHRONOUSLY, before the RPC resolves")
        await waitUntil { !adapter.policyChangeInFlight }
        XCTAssertEqual(adapter.sessionPolicy, "ask", "a successful flip updates the last-known value")
        XCTAssertTrue(adapter.sessionPolicyKnown, "the daemon accepting the write IS an answer")

        stubSucceeds = false
        adapter.onSetPolicy("plan")
        XCTAssertTrue(adapter.policyChangeInFlight)
        await waitUntil { !adapter.policyChangeInFlight }
        XCTAssertEqual(adapter.sessionPolicy, "ask", "a FAILED flip must not lie about the new value — stays at the last-known-good one")
        XCTAssertTrue(adapter.sessionPolicyKnown, "…and the still-true previous value is still an answer")
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

    // MARK: - mac-chat-parity T4: the field survives the whole path, not just the adapter

    /// The threading test, and the one the "sweep by MEANING" warning is actually about: adding a
    /// FIELD breaks no build, so a `SessionSummary(...)` construction site that forgets to pass it
    /// reports `nil` forever, silently, with every unit test above still green. This drives a REAL
    /// scripted-transport `session.list` round trip through `AppModel`'s own lister — the same
    /// mechanism `testOrbUpdateIsChatSessionTracksARealDirectoryRoundTrip` uses — so the assertion
    /// covers NormaKit's decode AND `AppModel.swift`'s map into `SessionSummary`, together.
    ///
    /// (`DetachedWindowController.swift` holds the OTHER construction site, a verbatim twin of this
    /// one built on a detached window's own feed. It has its own live round trip —
    /// `DetachedWindowTests.testSelectSessionReDerivesTheApprovalPolicyFromThisWindowsDirectory` —
    /// so neither site is left to inspection.)
    @MainActor
    func testTheDirectoryThreadsApprovalPolicyOffARealSessionListRoundTrip() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        // s_1 tagged dispatch so the connect-time focus (unrelated to this test's subject) lands as
        // it does everywhere else in this file.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        // The directory's OWN `session.list` — kicked by a `session_created` broadcast, the same
        // mechanism `testOrbUpdateIsChatSessionTracksARealDirectoryRoundTrip` above relies on. This
        // is the round trip under test: its result goes through NormaKit's decode and AppModel's
        // `SessionSummary` map before it reaches `directory.rows`.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_2","ts":5,"scope":"global"}}"#)
        let relist = await waitUntilMethod(t, "session.list", occurrence: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch","approvalPolicy":"bypass"},{"sessionId":"s_2","scope":"global","createdAt":5,"lastSeq":0,"approvalPolicy":"plan"},{"sessionId":"s_old","scope":"global","createdAt":2,"lastSeq":0}]}}"#)
        await waitUntil { model.directory.rows.count == 3 }
        // Asserted, not merely waited on: `waitUntil` does not fail on timeout, so an empty
        // directory would otherwise satisfy every `nil` expectation below for the wrong reason.
        XCTAssertEqual(model.directory.rows.count, 3, "the directory must have folded the round trip")

        XCTAssertEqual(model.directory.rows.first { $0.sessionId == "s_1" }?.approvalPolicy, "bypass",
                       "the daemon's answer must survive NormaKit's decode AND AppModel's map into SessionSummary")
        XCTAssertEqual(model.directory.rows.first { $0.sessionId == "s_2" }?.approvalPolicy, "plan")
        XCTAssertNil(model.directory.rows.first { $0.sessionId == "s_old" }?.approvalPolicy,
                     "an older daemon's row stays absent all the way through — never filled in en route")
    }
}
