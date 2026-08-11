import AppKit
import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// 2d-iii task 3: mount + respond wiring (both windows) + keyboard. Covers the PURE keyboard
/// router (`cardKeyAction`, `OrbWindowController.swift`), the adapter's in-flight/error discipline
/// (the sync-insert/async-remove/error-on-failure shape every respond wiring follows — see
/// `FieldStateAdapter.swift`'s `interactionInFlight`/`interactionErrors`), and the AppModel→wire
/// shape for `respondApproval` (mirrors `AppModelTests`' own `sendOrSteer` wire-shape idiom).
/// Nothing here drives a live `NSEvent` monitor or mounts `PendingCardsView` in a real window —
/// those aren't independently unit-testable (same posture as `EscInterruptTests`, which only
/// exercises the pure `escMonitorAction`/`windowEscAction` routers plus `AppDelegate`'s wired
/// closures, never the live monitor installation itself).
final class CardWiringTests: XCTestCase {
    /// Builds `[SessionEvent.Question]` the same wire-shaped-JSON way `PendingCardsTests`/
    /// `PendingInteractionTests` do — `Question`/`QuestionOption` are cross-module `Codable`
    /// structs with no public memberwise initializer.
    func questions(_ json: String) -> [SessionEvent.Question] {
        try! JSONDecoder().decode([SessionEvent.Question].self, from: Data(json.utf8))
    }

    // MARK: - cardKeyAction (pure router)

    func testCardKeyActionApprovalYN() {
        let approval = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x")
        XCTAssertEqual(cardKeyAction(keyCode: 16, chars: "y", topmost: approval, composerDraft: ""), .approve("a1", nil))
        XCTAssertEqual(cardKeyAction(keyCode: 45, chars: "n", topmost: approval, composerDraft: ""), .deny("a1", nil))
        // uppercase (shift held) must resolve the same way
        XCTAssertEqual(cardKeyAction(keyCode: 16, chars: "Y", topmost: approval, composerDraft: ""), .approve("a1", nil))

        // Dispatch (Phase 7): a mirrored child approval's childSessionId rides straight through.
        let childApproval = PendingInteraction.approval(callId: "a2", toolName: "bash", summary: "rm y", childSessionId: "child_1")
        XCTAssertEqual(cardKeyAction(keyCode: 16, chars: "y", topmost: childApproval, composerDraft: ""), .approve("a2", "child_1"))

        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"A","description":null}],"multiSelect":false}]"#)
        let question = PendingInteraction.question(callId: "q1", questions: qs)
        XCTAssertNil(cardKeyAction(keyCode: 16, chars: "y", topmost: question, composerDraft: ""), "y/n only apply when the topmost card is an approval")
        XCTAssertNil(cardKeyAction(keyCode: 16, chars: "y", topmost: nil, composerDraft: ""), "no pending card at all")
        XCTAssertNil(cardKeyAction(keyCode: 8, chars: "c", topmost: approval, composerDraft: ""), "any other letter passes through")
    }

    func testCardKeyActionDigitsSelectOption() {
        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"A","description":null},{"label":"B","description":null},{"label":"C","description":null}],"multiSelect":false}]"#)
        let single = PendingInteraction.question(callId: "q1", questions: qs)
        XCTAssertEqual(cardKeyAction(keyCode: 19, chars: "2", topmost: single, composerDraft: ""), .selectOption("q1", 1, nil))
        XCTAssertNil(cardKeyAction(keyCode: 23, chars: "5", topmost: single, composerDraft: ""), "digit past the option count is a no-op")

        // multiSelect: stays mouse-only even for a single question.
        let multi = questions(#"[{"question":"Which ports?","header":"Ports","options":[{"label":"80","description":null},{"label":"443","description":null}],"multiSelect":true}]"#)
        let multiTop = PendingInteraction.question(callId: "q2", questions: multi)
        XCTAssertNil(cardKeyAction(keyCode: 19, chars: "2", topmost: multiTop, composerDraft: ""))

        // multi-question (even all single-select): a digit can't safely resolve the whole
        // first-response-wins ask without knowing the OTHER questions' answers, so this stays
        // mouse-only too.
        let twoQuestions = qs + qs
        let twoTop = PendingInteraction.question(callId: "q3", questions: twoQuestions)
        XCTAssertNil(cardKeyAction(keyCode: 18, chars: "1", topmost: twoTop, composerDraft: ""))

        // y/n don't apply to a question card.
        XCTAssertNil(cardKeyAction(keyCode: 16, chars: "y", topmost: single, composerDraft: ""))
    }

    func testCardKeyActionGuardedByComposerDraft() {
        // Threaded directly into the router (not just checked at the call sites) so this is
        // independently pure-testable, same as the two tests above — see cardKeyAction's doc.
        let approval = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x")
        XCTAssertNil(cardKeyAction(keyCode: 16, chars: "y", topmost: approval, composerDraft: "yes"),
                     "typing \"yes\" into the composer must never trigger the approval card")
        XCTAssertNil(cardKeyAction(keyCode: 45, chars: "n", topmost: approval, composerDraft: "no"))

        let qs = questions(#"[{"question":"Which db?","header":"DB","options":[{"label":"A","description":null}],"multiSelect":false}]"#)
        let question = PendingInteraction.question(callId: "q1", questions: qs)
        XCTAssertNil(cardKeyAction(keyCode: 18, chars: "1", topmost: question, composerDraft: "1"))

        // whitespace-only draft still counts as "non-empty" — composerDraft.isEmpty is the exact
        // guard, not a trimmed check (the card's own Submit affordances don't trim the guard
        // either; typing a single space is still "the composer is the intended target").
        XCTAssertNil(cardKeyAction(keyCode: 16, chars: "y", topmost: approval, composerDraft: " "))

        // empty draft: unaffected, falls through to the ordinary routing.
        XCTAssertEqual(cardKeyAction(keyCode: 16, chars: "y", topmost: approval, composerDraft: ""), .approve("a1", nil))
    }

    /// T4-review fix: a card's OWN text fields (notes, Other) are local `@State`, never routed
    /// through `composerDraft` — so this is a SEPARATE guard, independently threaded and tested,
    /// same convention as `testCardKeyActionGuardedByComposerDraft` above. Covers exactly the
    /// brief's three cases: digit + text-field-focused → suppressed, digit + no-text-focus →
    /// unaffected (the pre-existing shortcut), non-digit (y/n) + text-field-focused → also
    /// suppressed (typing "yes"/"no" into a note must not fire an approval either).
    func testCardKeyActionGuardedByTextFieldFocus() {
        let qs = questions(#"[{"question":"How many retries?","header":"Retries","options":[{"label":"1","description":null},{"label":"2","description":null},{"label":"3","description":null}],"multiSelect":false}]"#)
        let question = PendingInteraction.question(callId: "q1", questions: qs)

        // The bug: typing "3 retries" into the notes field — the leading digit must NOT select/
        // submit the card while a text field (the notes field) holds focus.
        XCTAssertNil(
            cardKeyAction(keyCode: 20, chars: "3", topmost: question, composerDraft: "", textFieldFocused: true),
            "a digit-leading note must not be swallowed as a card shortcut while a text field is focused"
        )

        // No text field focused: unaffected — the pre-existing digit-select contract still works
        // (default `textFieldFocused: false`, matching every call site above).
        XCTAssertEqual(
            cardKeyAction(keyCode: 20, chars: "3", topmost: question, composerDraft: ""),
            .selectOption("q1", 2, nil)
        )
        XCTAssertEqual(
            cardKeyAction(keyCode: 20, chars: "3", topmost: question, composerDraft: "", textFieldFocused: false),
            .selectOption("q1", 2, nil)
        )

        // y/n (approval cards) while a text field is focused: also suppressed — same guard, not
        // digit-specific.
        let approval = PendingInteraction.approval(callId: "a1", toolName: "bash", summary: "rm x")
        XCTAssertNil(cardKeyAction(keyCode: 16, chars: "y", topmost: approval, composerDraft: "", textFieldFocused: true))
        XCTAssertNil(cardKeyAction(keyCode: 45, chars: "n", topmost: approval, composerDraft: "", textFieldFocused: true))
    }

    // MARK: - isTextEditingFocused (live firstResponder guard)

    /// T4-review fix: the guard's own AppKit input. `isTextEditingFocused(in:)` must recognize a
    /// generic `NSTextView` (what a SwiftUI `TextField`'s shared field editor actually is — the
    /// card's notes/Other fields) as "a text field is focused," while excluding this app's own
    /// message composer (`CommandTextView`, a real `NSTextView` subclass that legitimately holds
    /// `firstResponder` at rest — see `isTextEditingFocused`'s doc for why the exclusion is
    /// required, not optional polish).
    @MainActor
    func testIsTextEditingFocusedExcludesComposerButCatchesFieldEditor() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200),
                               styleMask: [.titled], backing: .buffered, defer: false)
        // A test-constructed NSWindow is held ONLY by this local `let` — AppKit's default
        // `isReleasedWhenClosed == true` means `close()` below performs an ADDITIONAL release on
        // top of ARC's own, over-releasing the window (crashed this suite with EXC_BAD_ACCESS in
        // `objc_release` during XCTest's post-test dealloc-scope check until this was added). Same
        // fix `DetachedWindowController.swift:119` applies for the identical reason ("this
        // controller owns the window's lifetime").
        window.isReleasedWhenClosed = false
        defer { window.close() }

        // Nothing focused yet (or a non-text responder): not text-editing.
        XCTAssertFalse(isTextEditingFocused(in: window))

        // A generic NSTextView (stand-in for a SwiftUI TextField's field editor) IS text-editing.
        let plainTextView = NSTextView()
        window.contentView = NSView()
        window.contentView?.addSubview(plainTextView)
        _ = window.makeFirstResponder(plainTextView)
        XCTAssertTrue(isTextEditingFocused(in: window), "a focused generic NSTextView must count as text-editing")

        // This app's own composer view (CommandTextView) must be excluded — it holds firstResponder
        // at rest and must never suppress the digit-select shortcut.
        let composer = CommandTextView()
        window.contentView?.addSubview(composer)
        _ = window.makeFirstResponder(composer)
        XCTAssertFalse(isTextEditingFocused(in: window), "the composer itself must never count as a card's text field")
    }

    // MARK: - composerShouldClaimFirstResponder (live-gate fix D)

    /// **The composer must not pull the caret out of a text input the user is using.**
    ///
    /// `ComposerTextView.updateNSView` re-claims first responder on every SwiftUI update pass, and
    /// in the shell those are constant (the 5-second `session.list` poll, every streamed delta,
    /// `FieldStateAdapter` being an `@ObservedObject` of the view that owns it). Unconditionally,
    /// that pulled the caret into the composer while the user typed in the panel's URL field — the
    /// reported bug. The predicate is what the re-claim now consults, at both its sites.
    ///
    /// The row is built around the distinction that matters: the RESTING claim must survive
    /// untouched, because `isTextEditingFocused` above is written against "the composer holds
    /// `firstResponder` at rest" and `testCardKeyActionDigitsSelectOption` depends on it. So the
    /// window case and the field-editor case are asserted side by side; a predicate that simply
    /// answered "never claim" would pass half of this and break the other half.
    @MainActor
    func testTheComposerYieldsToAnyOtherFocusedTextInputButStillClaimsAtRest() {
        let composer = CommandTextView()

        XCTAssertTrue(composerShouldClaimFirstResponder(current: nil, composer: composer),
                      "nobody has it — the composer's whole resting behaviour")

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false   // see the row above for why this is not optional
        defer { window.close() }
        XCTAssertTrue(composerShouldClaimFirstResponder(current: window, composer: composer),
                      "the window is the resting first responder — claiming from it is the point")

        XCTAssertTrue(composerShouldClaimFirstResponder(current: NSButton(), composer: composer),
                      "a non-text responder is not somebody typing")

        XCTAssertFalse(composerShouldClaimFirstResponder(current: composer, composer: composer),
                       "already ours")

        // A SwiftUI `TextField` under focus makes its shared FIELD EDITOR the first responder, and
        // that is always an NSTextView — the panel's URL field, the card's notes/Other fields, the
        // sidebar search palette. This is the bug's own case.
        XCTAssertFalse(composerShouldClaimFirstResponder(current: NSTextView(), composer: composer),
                       "the composer stole the caret from a focused text field")

        // And a view that is only `NSTextInputClient` — which is exactly what Chromium's
        // `RenderWidgetHostViewCocoa` is, i.e. typing INTO a page.
        XCTAssertFalse(composerShouldClaimFirstResponder(current: BrowserRuntimeTests.TextInputView(),
                                                         composer: composer),
                       "the composer stole the caret from a page the user was typing in")
    }

    // MARK: - Adapter in-flight/error discipline

    @MainActor
    func testAdapterInFlightLifecycle() async throws {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        var stubSucceeds = true

        // Exact wiring shape the brief specifies for GlassRootView/DetachedWindowController —
        // wired here to a STUB (not a real AppModel/NormaClient) so this test locks down the
        // discipline itself: inFlight inserted synchronously, removed only after the async stub
        // resolves, and an error line set on failure (never on success).
        adapter.onApprovalRespond = { [adapter] callId, approved, optionId, childSessionId in
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 20_000_000)
                let ok = stubSucceeds
                adapter.interactionInFlight.remove(callId)
                if !ok { adapter.interactionErrors[callId] = "couldn't send — try again" }
                // success: nothing else — the resolved event removes the card via the reducer.
            }
        }

        adapter.onApprovalRespond("call1", true, nil, nil)
        XCTAssertTrue(adapter.interactionInFlight.contains("call1"), "inFlight must be inserted SYNCHRONOUSLY, before the RPC resolves")
        await waitUntil { !adapter.interactionInFlight.contains("call1") }
        XCTAssertFalse(adapter.interactionInFlight.contains("call1"))
        XCTAssertNil(adapter.interactionErrors["call1"], "success must not leave an error line behind")

        stubSucceeds = false
        adapter.onApprovalRespond("call2", false, nil, nil)
        XCTAssertTrue(adapter.interactionInFlight.contains("call2"))
        await waitUntil { !adapter.interactionInFlight.contains("call2") }
        XCTAssertFalse(adapter.interactionInFlight.contains("call2"))
        XCTAssertEqual(adapter.interactionErrors["call2"], "couldn't send — try again")
    }

    // MARK: - AppModel respond wire shape

    /// Local copy of `AppModelTests`' scripted-transport handshake helpers — `AppScriptedTransport`
    /// and the free `lineJSON`/`waitUntil` are reusable target-wide, but `answerHandshake`/
    /// `waitUntilSent` are instance methods on `AppModelTests` itself, so this file keeps its own
    /// minimal copies (same convention `DetachedWindowTests` already follows for its own transport
    /// double).
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
    func testAppModelRespondApprovalWireShape() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        // orb-scope fix: s_1 tagged dispatch so the initial connect-time focus (unrelated to this
        // test's subject) still lands as before.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        // TASK-3 REVIEW FIX: the respond methods now guard on the callId being pending in the
        // CURRENT session (the silent-false-success race) — seed the pending approval first,
        // exactly as the daemon would deliver it.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"approval_requested","seq":1,"sessionId":"s_1","ts":1,"threadId":"main","callId":"call1","toolName":"bash","summary":"rm -rf x"}}"#)
        await waitUntil { !model.session.state.pendingInteractions.isEmpty }

        async let responded = model.respondApproval(callId: "call1", approved: true)
        await waitUntilSent(t, 4)
        let respond = lineJSON(t.sent[3])
        XCTAssertEqual(respond["method"] as? String, "approval.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "s_1")
        XCTAssertEqual(params?["callId"] as? String, "call1")
        XCTAssertEqual(params?["approved"] as? Bool, true)
        t.feed(#"{"jsonrpc":"2.0","id":\#(respond["id"] as! Int),"result":{"alreadyResolved":false}}"#)
        let ok = await responded
        XCTAssertTrue(ok)
    }

    /// TASK-3 REVIEW FIX: a callId that is NOT pending in the currently-focused session must
    /// fail closed WITHOUT an RPC — the silent-false-success race (a refocus swapping
    /// focusedSessionId between click and dispatch would otherwise ship {new sid, old callId},
    /// which the daemon's brokers report as alreadyResolved:true = fake success).
    @MainActor
    func testAppModelRespondStaleCallIdFailsClosedWithoutRPC() async throws {
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

        let sentBefore = t.sent.count
        let ok = await model.respondApproval(callId: "ghost", approved: true)
        XCTAssertFalse(ok, "stale/unknown callId must fail closed")
        XCTAssertEqual(t.sent.count, sentBefore, "no RPC may go out for a callId not pending in the current session: \(t.sent)")
    }

    /// No focused session yet: the respond methods must fail closed (false), never crash / send
    /// with an empty sessionId — mirrors `sendOrSteer`'s own `guard ... else { return false }`.
    @MainActor
    func testAppModelRespondApprovalFailsWithoutFocusedSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let ok = await model.respondApproval(callId: "call1", approved: true)
        XCTAssertFalse(ok)
        XCTAssertTrue(t.sent.isEmpty, "no RPC should go out with no focused session")
    }

    // MARK: - Dispatch (Phase 7), task-7 review fix: childSessionId ROUTING wire proof

    /// Boots a focused session "s_disp" (the dispatch session's stand-in) exactly like
    /// `testAppModelRespondApprovalWireShape` above — shared by the two routing tests below.
    /// The `nil`-childSessionId leg of the routing rule (`childSessionId ?? focusedSessionId`)
    /// is already pinned by that wire-shape test, which never passes one and asserts the RPC
    /// targets the focused session.
    @MainActor
    private func bootFocusedDispatch(_ t: AppScriptedTransport, _ model: AppModel) async {
        // orb-scope fix: s_disp tagged dispatch so the initial connect-time focus still lands.
        await answerHandshake(t, sessions: #"[{"sessionId":"s_disp","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }
    }

    /// A MIRRORED child approval (its event carries `childSessionId`) answered via
    /// `respondApproval(childSessionId:)` must ship the outgoing `approval.respond` against the
    /// CHILD's sessionId — not the focused (dispatch) session the card physically lives in.
    @MainActor
    func testAppModelRespondApprovalRoutesToChildSessionId() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await bootFocusedDispatch(t, model)

        // The mirrored copy arrives in the DISPATCH session's own stream (sessionId "s_disp"),
        // tagged with the child it relays for — exactly what the daemon's relay emits.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"approval_requested","seq":1,"sessionId":"s_disp","ts":1,"threadId":"main","callId":"call1","toolName":"bash","summary":"rm -rf x","childSessionId":"s_child_1"}}"#)
        await waitUntil { !model.session.state.pendingInteractions.isEmpty }

        async let responded = model.respondApproval(callId: "call1", approved: true, childSessionId: "s_child_1")
        await waitUntilSent(t, 4)
        let respond = lineJSON(t.sent[3])
        XCTAssertEqual(respond["method"] as? String, "approval.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "s_child_1",
                       "the respond RPC must target the CHILD, not focusedSessionId (s_disp)")
        XCTAssertEqual(params?["callId"] as? String, "call1")
        XCTAssertEqual(params?["approved"] as? Bool, true)
        t.feed(#"{"jsonrpc":"2.0","id":\#(respond["id"] as! Int),"result":{"alreadyResolved":false}}"#)
        let ok = await responded
        XCTAssertTrue(ok)
    }

    /// Same routing proof for the question path: `respondQuestion(childSessionId:)` →
    /// `ask_user.respond` against the CHILD's sessionId.
    @MainActor
    func testAppModelRespondQuestionRoutesToChildSessionId() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await bootFocusedDispatch(t, model)

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"question_asked","seq":1,"sessionId":"s_disp","ts":1,"threadId":"main","callId":"q1","questions":[{"question":"Which port?","header":"h","options":[{"label":"80","description":null}],"multiSelect":false}],"childSessionId":"s_child_1"}}"#)
        await waitUntil { !model.session.state.pendingInteractions.isEmpty }

        async let responded = model.respondQuestion(callId: "q1", answers: ["Which port?": "80"], childSessionId: "s_child_1")
        await waitUntilSent(t, 4)
        let respond = lineJSON(t.sent[3])
        XCTAssertEqual(respond["method"] as? String, "ask_user.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "s_child_1",
                       "the respond RPC must target the CHILD, not focusedSessionId (s_disp)")
        XCTAssertEqual(params?["callId"] as? String, "q1")
        XCTAssertEqual((params?["answers"] as? [String: Any])?["Which port?"] as? String, "80")
        t.feed(#"{"jsonrpc":"2.0","id":\#(respond["id"] as! Int),"result":{"alreadyResolved":false}}"#)
        let ok = await responded
        XCTAssertTrue(ok)
    }
}
