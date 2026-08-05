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

/// Task 2 (2e-iv): the pure centering geometry `centeredStandaloneFrame` — still load-bearing as
/// `AppDelegate.openSessionInNewDetachedWindow`'s frame-less fallback, even though its original
/// motivating caller, `openStandaloneNormaWindow()`, was retired by App shell T6 (that menu item
/// summons the app shell instead; its own wiring tests died with it — see that task's report).
/// Also: `AppModel.refocus`'s catch-path mode filter (site 3 of three — `AppModelTests` covers
/// sites 1/2), which this file's `RecordingTransportFactory` helper predates and still backs. The
/// successful detached-window spawn path itself (feed → controller → native window) is already
/// covered end-to-end by `DetachedWindowTests` — deliberately not duplicated here.
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

    // App shell T6 (the menu-bar retarget's funeral): four `openStandaloneNormaWindow()` wiring
    // tests that lived here — testOpenStandaloneNormaWindowNoOpsWithoutAppModel,
    // …NoOpsWhenSessionCreateFails, …NoOpsWhenPriorFocusExistsAndSessionCreateFails,
    // …NoOpsWhenSessionCreateSucceedsButAttachFails — are deleted with their subject. "Open Norma
    // App" summons the app shell now (App shell T1); the method they tested had no other caller.

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
