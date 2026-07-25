import XCTest
import AppKit
@testable import Norma

/// DEFECT FIX regression helper: records every transport `AppModel`'s `makeTransport` factory
/// constructs. A fresh `AppScriptedTransport` per call (rather than always the SAME shared
/// instance) keeps `testOpenStandaloneNormaWindowNoOpsWhenPriorFocusExistsAndSessionCreateFails`
/// below safe even against the PRE-FIX buggy code path it's designed to catch red-handed: that
/// path spawns a SECOND `SessionFeed`/`NormaClient` (`AppModel.makeDetachedFeed`) which would
/// otherwise contend with the first client's already-live pump over one shared transport.
/// `AppScriptedTransport` itself is `AppModelTests`' local double — same test target/module, no
/// re-declaration needed.
final class RecordingTransportFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var _made: [AppScriptedTransport] = []
    var made: [AppScriptedTransport] { lock.lock(); defer { lock.unlock() }; return _made }
    func make() -> AppScriptedTransport {
        let t = AppScriptedTransport()
        lock.lock(); _made.append(t); lock.unlock()
        return t
    }
}

/// Task 2 (2e-iv): "Open Norma App" — the pure centering geometry (`centeredStandaloneFrame`) plus
/// a wiring-level smoke test for `AppDelegate.openStandaloneNormaWindow()`. The successful spawn
/// path itself (feed → controller → native window) is already covered end-to-end by
/// `DetachedWindowTests` — deliberately not duplicated here.
@MainActor
final class StandaloneWindowTests: XCTestCase {
    func waitUntilSent(_ t: AppScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }
    // MARK: - centeredStandaloneFrame (PURE)

    func testCenteredStandaloneFrame() {
        let f = centeredStandaloneFrame(visibleFrame: NSRect(x: 0, y: 0, width: 2000, height: 1200))
        XCTAssertEqual(f.size, chatWindowDefaultSize)
        XCTAssertEqual(f.midX, 1000, accuracy: 1)
        XCTAssertEqual(f.midY, 600, accuracy: 1)
    }

    /// A non-origin visible frame (secondary monitor / menu-bar inset) must still center correctly
    /// — proves the math uses midX/midY of the given rect, not a bare width/height halving from
    /// (0, 0).
    func testCenteredStandaloneFrameOffsetVisibleFrame() {
        let f = centeredStandaloneFrame(visibleFrame: NSRect(x: 500, y: 100, width: 1600, height: 1000))
        XCTAssertEqual(f.size, chatWindowDefaultSize)
        XCTAssertEqual(f.midX, 1300, accuracy: 1)
        XCTAssertEqual(f.midY, 600, accuracy: 1)
    }

    // MARK: - AppDelegate.openStandaloneNormaWindow() wiring

    /// Defensive-guard precedent (matches `openSessionInNewDetachedWindow`'s line-58 guard): never
    /// booted → no `appModel` → log + no-op, no crash, no window.
    func testOpenStandaloneNormaWindowNoOpsWithoutAppModel() {
        let delegate = AppDelegate()
        delegate.openStandaloneNormaWindow()
        XCTAssertTrue(delegate.detachedWindows.isEmpty)
    }

    /// Booted but degraded (unit-test boot never starts the feed, so `client.transport` stays nil):
    /// `startFreshSession()`'s `dispatchSession` RPC (Dispatch, Phase 7 — was `createSession`)
    /// throws immediately, its `nil` return catches it,
    /// and no window spawns — the whole chain (create → guard → would-be spawn) runs end-to-end
    /// without crashing or hanging.
    ///
    /// SCOPE NOTE (was overclaiming — DEFECT FIX): this only covers the fresh-boot, NO-PRIOR-FOCUS
    /// case (`boot()`'s degraded unit-test path never attaches anything, so `focusedSessionId` is
    /// nil going in). It does NOT exercise a prior focus surviving a failed create — see
    /// `testOpenStandaloneNormaWindowNoOpsWhenPriorFocusExistsAndSessionCreateFails` below for that
    /// (the actual reviewed defect: a STALE prior focus wrongly driving the spawn decision).
    func testOpenStandaloneNormaWindowNoOpsWhenSessionCreateFails() async throws {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        XCTAssertNotNil(delegate.appModel, "boot() must produce an AppModel even in the degraded (no-token) test path")
        XCTAssertNil(delegate.appModel?.focusedSessionId, "fresh boot: no prior focus going in")

        delegate.openStandaloneNormaWindow()
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(delegate.detachedWindows.isEmpty, "a failed session-create must never spawn a window")
    }

    /// DEFECT FIX regression (reviewed defect): `AppDelegate.openStandaloneNormaWindow()` used to
    /// await the void `startFreshSessionAfterDetach()` and then read `model.focusedSessionId` —
    /// which, on a `createSession` RPC failure, silently stayed whatever it already was WITHOUT
    /// being cleared. So when a PRIOR focused session already exists (the orb's normal running
    /// state — not the fresh-boot case above) and the create RPC then fails, the old code's guard
    /// wrongly read the STALE pre-existing id and spawned the standalone window on it anyway,
    /// violating "Open Norma App = ALWAYS a fresh session."
    ///
    /// `testOpenStandaloneNormaWindowNoOpsWhenSessionCreateFails` above never actually covered
    /// this: `boot()`'s degraded (no-token) unit-test path can never reach a REAL prior focus — its
    /// transport never opens, so even the FIRST createSession call fails, same as every other RPC.
    /// This test wires a scripted-transport `AppModel` directly (`setAppModelForTesting`,
    /// bypassing `boot()`) so a real prior focus ("s_old") can be established before a LATER
    /// createSession call fails — the exact scenario the fix (`AppModel.startFreshSession()`
    /// returning the created id explicitly, `nil` on failure, instead of
    /// `openStandaloneNormaWindow()` inferring success from `focusedSessionId`) closes.
    func testOpenStandaloneNormaWindowNoOpsWhenPriorFocusExistsAndSessionCreateFails() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]

        // hello
        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        // session.list: ONE prior session already exists
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        // orb-scope fix: s_old tagged dispatch so `focusNewestSession()`'s connect-time filtering
        // still auto-attaches it here — this test's subject is the create/attach-failure handling,
        // not mode-filtering.
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        // session.attach(s_old) — establishes the REAL prior focus
        await waitUntilSent(t, 3)
        let attachOld = lineJSON(t.sent[2])
        XCTAssertEqual(attachOld["method"] as? String, "session.attach")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachOld["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_old" }
        XCTAssertEqual(model.focusedSessionId, "s_old", "a prior focused session exists going into the spawn attempt — this is the normal running orb state")

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        delegate.openStandaloneNormaWindow()
        await waitUntilSent(t, 4)
        let create = lineJSON(t.sent[3])
        // Dispatch (Phase 7): `startFreshSession()` (the orb's own AppModel) now dispatches the
        // ONE permanent singleton rather than creating a brand-new session.
        XCTAssertEqual(create["method"] as? String, "session.dispatch")
        // The RPC FAILS — the exact scenario the old code silently mishandled.
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"error":{"code":1,"message":"boom"}}"#)

        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(delegate.detachedWindows.isEmpty, "a failed session-create must never spawn a window on a STALE prior focus")
        XCTAssertEqual(model.focusedSessionId, "s_old", "the failed create must not silently corrupt the existing focus either")
    }

    /// DEFECT FIX (residual leg, final-review Medium): `AppModel.startFreshSession()` used to
    /// return `focusedSessionId` unconditionally after `refocus(onto: created.sessionId)` — but
    /// if `session.create` SUCCEEDS and the FOLLOW-UP `session.attach` then fails, `refocus`'s
    /// catch reconciles focus back to the PREVIOUS session (`NormaClient.attach` rolls
    /// `attachedSessionId` back to its pre-call value on throw). The old code then returned that
    /// stale, non-nil PREVIOUS session id as if it were the fresh one, and
    /// `openStandaloneNormaWindow()` spawned its standalone window on the OLD session — the same
    /// "Open Norma App = always fresh session" violation `testOpenStandaloneNormaWindowNoOpsWhenPriorFocusExistsAndSessionCreateFails`
    /// above closes for a failed CREATE, but for a failed ATTACH after a successful create.
    ///
    /// This test establishes a real prior focus ("s_old"), then scripts `session.create` to
    /// SUCCEED (returning "s_new") while the following `session.attach("s_new")` FAILS. The
    /// fix (`startFreshSession()` returning `created.sessionId` only when the post-refocus
    /// `focusedSessionId` actually landed on it, `nil` otherwise) must produce NO spawned window
    /// and must leave `focusedSessionId` on "s_old" — the pre-fix code spawns a window on "s_old"
    /// instead.
    func testOpenStandaloneNormaWindowNoOpsWhenSessionCreateSucceedsButAttachFails() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]

        // hello
        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        // session.list: ONE prior session already exists
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        // orb-scope fix: s_old tagged dispatch so `focusNewestSession()`'s connect-time filtering
        // still auto-attaches it here — this test's subject is the create/attach-failure handling,
        // not mode-filtering.
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        // session.attach(s_old) — establishes the REAL prior focus
        await waitUntilSent(t, 3)
        let attachOld = lineJSON(t.sent[2])
        XCTAssertEqual(attachOld["method"] as? String, "session.attach")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachOld["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_old" }
        XCTAssertEqual(model.focusedSessionId, "s_old", "a prior focused session exists going into the spawn attempt — this is the normal running orb state")

        let delegate = AppDelegate()
        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        delegate.openStandaloneNormaWindow()
        await waitUntilSent(t, 4)
        let create = lineJSON(t.sent[3])
        XCTAssertEqual(create["method"] as? String, "session.dispatch")
        // session.dispatch SUCCEEDS this time — the singleton really is (re)created server-side.
        t.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_new","created":true}}"#)

        // refocus(onto: "s_new") now fires session.attach("s_new") — THIS is the RPC that fails.
        await waitUntilSent(t, 5)
        let attachNew = lineJSON(t.sent[4])
        XCTAssertEqual(attachNew["method"] as? String, "session.attach")
        XCTAssertEqual((attachNew["params"] as? [String: Any])?["sessionId"] as? String, "s_new")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachNew["id"] as! Int),"error":{"code":1,"message":"boom"}}"#)

        // refocus's catch reconciles focus to attachedSessionId (rolled back to "s_old" by
        // NormaClient.attach's own throw handling), then calls listSessions() to look for a
        // newer survivor to retry onto. "s_new" (the just-failed target) IS the newest — the
        // create really did succeed server-side — so the retry is correctly skipped.
        await waitUntilSent(t, 6)
        let relist = lineJSON(t.sent[5])
        XCTAssertEqual(relist["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0},{"sessionId":"s_new","scope":"global","createdAt":2,"lastSeq":0}]}}"#)

        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(delegate.detachedWindows.isEmpty, "a successful create whose follow-up attach fails must never spawn a window on the reverted-to prior session")
        XCTAssertEqual(model.focusedSessionId, "s_old", "reconciled focus after the failed attach must be the rolled-back prior session, not the never-attached new one")
    }

    // MARK: - Important-1 fix (orb-scope review): refocus(onto:)'s catch/error-recovery fallback
    // is a THIRD focus-acquisition site and was mode-blind. The relist fixture two tests above
    // (line ~220) already feeds this exact catch path two UNMODED (= code, "absent means code")
    // sessions — it just never happened to prove the mode filter itself, since neither of that
    // scenario's candidates was tagged "dispatch". These two tests drive `refocus`'s catch path
    // directly (via the public `focusSession(_:)` wrapper, bypassing the standalone-window/
    // session.dispatch machinery entirely — orthogonal to what's under test here) and pin the mode
    // filter's two required outcomes.

    /// A daemon restart / transport hiccup mid-refocus (`session.attach` throws) must NEVER fall
    /// back onto a CODE session, even when that code session is the NEWEST one overall by
    /// `createdAt` — the exact shape of the pre-fix bug (`sessions.max(by: createdAt)` with no mode
    /// filter at all).
    func testRefocusCatchPathNeverFallsBackToCodeSession() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]

        // hello
        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        // session.list: one prior DISPATCH session already exists.
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        // session.attach(s_old) — establishes the real prior focus.
        await waitUntilSent(t, 3)
        let attachOld = lineJSON(t.sent[2])
        XCTAssertEqual(attachOld["method"] as? String, "session.attach")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachOld["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_old" }

        // Drive refocus(onto:) directly, targeting a session that will fail to attach — the exact
        // scenario ("target vanished or transport hiccuped") the catch path exists for.
        let refocusTask = Task { await model.focusSession("s_target") }
        await waitUntilSent(t, 4)
        let attachTarget = lineJSON(t.sent[3])
        XCTAssertEqual(attachTarget["method"] as? String, "session.attach")
        XCTAssertEqual((attachTarget["params"] as? [String: Any])?["sessionId"] as? String, "s_target")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachTarget["id"] as! Int),"error":{"code":1,"message":"boom"}}"#)

        // catch: reconcile to attachedSession (rolled back to "s_old"), then re-list. The re-list's
        // NEWEST OVERALL session is a CODE-mode one ("s_phone_code", createdAt 99) — the pre-fix
        // bug would attach onto THIS. The only DISPATCH-mode entry left is "s_old" itself.
        await waitUntilSent(t, 5)
        let relist = lineJSON(t.sent[4])
        XCTAssertEqual(relist["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_phone_code","scope":"global","createdAt":99,"lastSeq":0,"mode":"code"}]}}"#)

        // Filtered-to-dispatch newest is "s_old" itself (the already-reconciled focus, but not
        // equal to the failed target "s_target") — refocus's own pre-existing, untouched-by-this-fix
        // retry logic re-attaches it. The assertion that matters: it targets "s_old", never
        // "s_phone_code".
        await waitUntilSent(t, 6)
        let retryAttach = lineJSON(t.sent[5])
        XCTAssertEqual(retryAttach["method"] as? String, "session.attach")
        XCTAssertEqual((retryAttach["params"] as? [String: Any])?["sessionId"] as? String, "s_old", "must retry onto the surviving DISPATCH session, never the newer CODE one")
        t.feed(#"{"jsonrpc":"2.0","id":\#(retryAttach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        await refocusTask.value
        XCTAssertEqual(model.focusedSessionId, "s_old", "must never land on the newer CODE session after a failed attach")
    }

    /// Companion to the above: when the catch path's dispatch-filtered newest is a genuinely
    /// DIFFERENT surviving session (not just the already-reconciled prior focus), the retry must
    /// still land there — the mode filter fails closed only against CODE sessions, it must never
    /// break the legitimate recovery path onto a real surviving DISPATCH session.
    func testRefocusCatchPathRecoversOntoSurvivingDispatchSession() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]

        // hello
        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        // session.list: one prior DISPATCH session already exists.
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        // session.attach(s_old) — establishes the real prior focus.
        await waitUntilSent(t, 3)
        let attachOld = lineJSON(t.sent[2])
        XCTAssertEqual(attachOld["method"] as? String, "session.attach")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachOld["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_old" }

        let refocusTask = Task { await model.focusSession("s_target") }
        await waitUntilSent(t, 4)
        let attachTarget = lineJSON(t.sent[3])
        XCTAssertEqual((attachTarget["params"] as? [String: Any])?["sessionId"] as? String, "s_target")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachTarget["id"] as! Int),"error":{"code":1,"message":"boom"}}"#)

        // Re-list: "s_old" (the reconciled focus) is GONE from this list entirely now — only a
        // DIFFERENT surviving dispatch session ("s_dispatch2") and a newer CODE session remain.
        await waitUntilSent(t, 5)
        let relist = lineJSON(t.sent[4])
        XCTAssertEqual(relist["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_dispatch2","scope":"global","createdAt":5,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_code_newer","scope":"global","createdAt":99,"lastSeq":0,"mode":"code"}]}}"#)

        await waitUntilSent(t, 6)
        let retryAttach = lineJSON(t.sent[5])
        XCTAssertEqual(retryAttach["method"] as? String, "session.attach")
        XCTAssertEqual((retryAttach["params"] as? [String: Any])?["sessionId"] as? String, "s_dispatch2", "must recover onto the surviving DISPATCH session, ignoring the newer CODE one")
        t.feed(#"{"jsonrpc":"2.0","id":\#(retryAttach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        await refocusTask.value
        XCTAssertEqual(model.focusedSessionId, "s_dispatch2", "recovery must land on the surviving dispatch session")
    }

    /// Chat Mode Slice A (CM-T3): site 3's mode filter is the SAME `mode == "dispatch"` positive
    /// match as sites 1/2 — a CHAT session, even the newest overall by `createdAt`, must never win
    /// the catch path's fallback either. Same shape as `testRefocusCatchPathNeverFallsBackToCodeSession`
    /// just above, chat instead of code — evidence that all three orb-scope gates hold unchanged
    /// for the new mode value.
    func testRefocusCatchPathNeverFallsBackToChatSession() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]

        // hello
        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        // session.list: one prior DISPATCH session already exists.
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]}}"#)
        // session.attach(s_old) — establishes the real prior focus.
        await waitUntilSent(t, 3)
        let attachOld = lineJSON(t.sent[2])
        XCTAssertEqual(attachOld["method"] as? String, "session.attach")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachOld["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.focusedSessionId == "s_old" }

        // Drive refocus(onto:) directly, targeting a session that will fail to attach.
        let refocusTask = Task { await model.focusSession("s_target") }
        await waitUntilSent(t, 4)
        let attachTarget = lineJSON(t.sent[3])
        XCTAssertEqual(attachTarget["method"] as? String, "session.attach")
        XCTAssertEqual((attachTarget["params"] as? [String: Any])?["sessionId"] as? String, "s_target")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachTarget["id"] as! Int),"error":{"code":1,"message":"boom"}}"#)

        // catch: reconcile to attachedSession (rolled back to "s_old"), then re-list. The re-list's
        // NEWEST OVERALL session is a CHAT-mode one ("s_chat_newer", createdAt 99) — a mode-blind
        // bug would attach onto THIS. The only DISPATCH-mode entry left is "s_old" itself.
        await waitUntilSent(t, 5)
        let relist = lineJSON(t.sent[4])
        XCTAssertEqual(relist["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(relist["id"] as! Int),"result":{"sessions":[{"sessionId":"s_old","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"},{"sessionId":"s_chat_newer","scope":"global","createdAt":99,"lastSeq":0,"mode":"chat"}]}}"#)

        await waitUntilSent(t, 6)
        let retryAttach = lineJSON(t.sent[5])
        XCTAssertEqual(retryAttach["method"] as? String, "session.attach")
        XCTAssertEqual((retryAttach["params"] as? [String: Any])?["sessionId"] as? String, "s_old", "must retry onto the surviving DISPATCH session, never the newer CHAT one")
        t.feed(#"{"jsonrpc":"2.0","id":\#(retryAttach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        await refocusTask.value
        XCTAssertEqual(model.focusedSessionId, "s_old", "must never land on the newer CHAT session after a failed attach")
    }
}
