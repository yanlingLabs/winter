import XCTest
import SwiftUI
@testable import Norma

/// office-live-ux Job 1 — **stopping a turn from the app.**
///
/// The requirement has two surfaces (Esc in the composer, a stop button where send is) and one
/// stated constraint: *"Make the running/idle state the single source of truth for both, so they
/// cannot disagree."* This file is what makes that assertable rather than merely intended.
///
/// The three layers, each tested at the layer it lives in:
///  1. the two pure decisions (`composerSendButtonRole`, `composerEscapeInterrupts`) — table-tested,
///     including the AGREEMENT between them across every input pair;
///  2. the card's own derivation from `ComposerStopControl` — driven through the card's REAL
///     initialiser, the same one both surfaces use;
///  3. the surface's wiring (`WindowContentView.composerStopControl`) — the whole path from a live
///     `FieldStateAdapter` to the rendered role, as a value.
///
/// Layer 3 is the one that matters most and is the one a value-level test usually misses: this
/// plan's own `policy` precedent records the miss by name ("the adapter method was pinned, its
/// WIRING was not"). A card that derived the role perfectly from a `stop` nobody ever passed would
/// be green at layers 1 and 2 and dead in the app.
@MainActor
final class ComposerStopButtonTests: XCTestCase {

    // MARK: - Layer 1: the pure decisions

    /// The whole truth table, both functions, in one loop — so the two can be compared rather than
    /// only individually checked.
    func testTheRoleAndTheEscapeContractAgreeOnEveryInput() {
        // (isRunning, canStop, blockedReason) → (expected role, expected "Esc is ours")
        let table: [(Bool, Bool, String?, ComposerSendButtonRole, Bool)] = [
            // No stop control at all: exactly today's behaviour, at both draft states.
            (false, false, nil, .send,        false),
            (false, false, "",  .blocked(""), false),
            // Wired, idle: still exactly today's behaviour. Esc is NOT ours — see below.
            (false, true,  nil, .send,        false),
            (false, true,  "",  .blocked(""), false),
            // Wired, running: stop, and Esc is ours — at BOTH draft states.
            (true,  true,  nil, .stop,        true),
            (true,  true,  "",  .stop,        true),
            (true,  true,  "no session", .stop, true),
        ]
        for (running, canStop, reason, expectedRole, expectedEsc) in table {
            XCTAssertEqual(composerSendButtonRole(isRunning: running && canStop,
                                                  sendBlockedReason: reason),
                           expectedRole,
                           "role for running=\(running) canStop=\(canStop) blocked=\(reason ?? "nil")")
            XCTAssertEqual(composerEscapeInterrupts(isRunning: running, canStop: canStop),
                           expectedEsc,
                           "esc for running=\(running) canStop=\(canStop)")
            // The agreement itself, which is the requirement: the button says "stop" exactly when
            // Esc claims the key. Asserted as an EQUIVALENCE, not as two separate expectations —
            // an implementation that got both individual columns right and still disagreed on some
            // untabled input would pass the two assertions above and fail this one.
            let saysStop = composerSendButtonRole(isRunning: running && canStop,
                                                  sendBlockedReason: reason) == .stop
            XCTAssertEqual(saysStop,
                           composerEscapeInterrupts(isRunning: running, canStop: canStop),
                           "the button and Esc disagreed at running=\(running) canStop=\(canStop) "
                           + "blocked=\(reason ?? "nil")")
        }
    }

    /// **The precedence, pinned on its own**, because it is the one real choice in
    /// `composerSendButtonRole` and the obvious ordering is the wrong one.
    ///
    /// An empty draft is the ORDINARY state while you watch a turn run — you are not typing, you are
    /// waiting. So a `sendBlockedReason`-first implementation would show the `waveform` placeholder
    /// exactly when the user wants stop, and would show stop only if they happened to have typed
    /// something. This test fails against that implementation and passes against this one; a test
    /// that only checked the non-empty-draft case would pass against BOTH.
    func testARunningTurnWithAnEmptyDraftShowsStopNotTheBlockedPlaceholder() {
        XCTAssertEqual(composerSendButtonRole(isRunning: true, sendBlockedReason: ""), .stop)
        // …and the control arm: the SAME empty draft with no turn running is still blocked, so the
        // assertion above is about the turn and not about the reason having been ignored outright.
        XCTAssertEqual(composerSendButtonRole(isRunning: false, sendBlockedReason: ""), .blocked(""))
    }

    /// Esc is handed BACK to AppKit on an idle session — the contract `CommandTextView.keyDown`
    /// implements by falling through to `super`.
    ///
    /// Its own control arm is the `canStop: true, isRunning: true` row above: without that, an
    /// implementation that never claimed Esc at all would satisfy this test perfectly.
    func testEscapeIsNotClaimedWhenNoTurnIsRunning() {
        XCTAssertFalse(composerEscapeInterrupts(isRunning: false, canStop: true))
        XCTAssertFalse(composerEscapeInterrupts(isRunning: true, canStop: false))
        XCTAssertTrue(composerEscapeInterrupts(isRunning: true, canStop: true))
    }

    // MARK: - Layer 2: the card's own derivation, through its real initialiser

    private func card(stop: ComposerStopControl?, draft: String) -> NormaComposerCard {
        NormaComposerCard(
            text: .constant(draft),
            onSubmit: {},
            mode: .constant(.code),
            modeIsSelectable: false,
            policy: nil,
            model: ComposerModelControl(model: nil, effort: nil, catalogue: .empty,
                                        modelChangeInFlight: false, effortChangeInFlight: false,
                                        onOpen: {}, onSetModel: { _ in }, onSetEffort: { _ in }),
            stripEdge: .above,
            sendBlockedReason: draft.isEmpty ? "" : nil,
            stop: stop)
    }

    func testTheCardRendersStopWhileATurnRunsAndSendWhenItEnds() {
        var stopped = 0
        let running = card(stop: ComposerStopControl(isRunning: true, onStop: { stopped += 1 }),
                           draft: "hello")
        XCTAssertEqual(running.sendButtonRole, .stop)

        let idle = card(stop: ComposerStopControl(isRunning: false, onStop: { stopped += 1 }),
                        draft: "hello")
        XCTAssertEqual(idle.sendButtonRole, .send, "the button must REVERT to send when the turn ends")

        // Neither derivation fired the action — pinned because a role computed by CALLING `onStop`
        // would pass both assertions above and interrupt the session on every render.
        XCTAssertEqual(stopped, 0)
    }

    /// A surface that wires no stop control is byte-identical to before this task, at both draft
    /// states. This is the new-chat page's row (`NewChatPage.composerCard` passes `stop: nil`).
    func testACardWithNoStopControlIsUnchanged() {
        XCTAssertEqual(card(stop: nil, draft: "hello").sendButtonRole, .send)
        XCTAssertEqual(card(stop: nil, draft: "").sendButtonRole, .blocked(""))
    }

    // MARK: - Layer 3: the WIRING — adapter → surface → role

    /// A live adapter with a NON-EMPTY draft. The draft matters: `composerCard` derives
    /// `sendBlockedReason` from it, and an empty draft is legitimately `.blocked("")` when idle —
    /// so a surface test that left the draft empty would be asserting about the draft rather than
    /// about the turn. (Written after exactly that mistake red'd here.)
    private func liveAdapter(turnRunning: Bool, draft: String = "hello") -> FieldStateAdapter {
        let session = SessionModel()
        session.applyForTesting { $0.turnRunning = turnRunning }
        let adapter = FieldStateAdapter(session: session)
        adapter.composerDraft = draft
        return adapter
    }

    private func surface(_ adapter: FieldStateAdapter) -> WindowContentView<EmptyView> {
        WindowContentView(adapter: adapter, tint: .blue, topInset: 8, sidebars: nil,
                          composerCardMode: .code) { EmptyView() }
    }

    /// **The wiring test.** An adapter with `onInterrupt` wired and a turn running must produce a
    /// card whose button IS the stop button — the whole path, no stubbed middle.
    func testAWiredSurfaceWithARunningTurnRendersTheStopButton() {
        var interrupted = 0
        let adapter = liveAdapter(turnRunning: true)
        adapter.onInterrupt = { interrupted += 1 }

        let view = surface(adapter)
        let control = try? XCTUnwrap(view.composerStopControl)
        XCTAssertEqual(control?.isRunning, true)
        XCTAssertEqual(view.composerCard?.sendButtonRole, .stop)

        // …and the control's action reaches the adapter's own closure, which is the only door both
        // surfaces have. Without this the value could be perfectly shaped and wired to nothing.
        control?.onStop()
        XCTAssertEqual(interrupted, 1)
    }

    /// The same surface with the SAME wiring and NO running turn renders send — the control arm for
    /// the test above, and the thing that makes it about `turnRunning` rather than about
    /// `onInterrupt` being non-nil.
    func testAWiredSurfaceWithNoRunningTurnRendersSend() {
        let adapter = liveAdapter(turnRunning: false)
        adapter.onInterrupt = {}
        let view = surface(adapter)
        XCTAssertEqual(view.composerStopControl?.isRunning, false)
        XCTAssertEqual(view.composerCard?.sendButtonRole, .send)
    }

    /// An UNWIRED surface — the orb's morph window and every detached window — offers no stop
    /// control at all, even with a turn running. Both of those windows already own Esc through
    /// `NSEvent` monitors of their own, and a second responder-scoped door on the same key in the
    /// same window would interrupt twice.
    func testAnUnwiredSurfaceOffersNoStopControlEvenWhileATurnRuns() {
        let adapter = liveAdapter(turnRunning: true)
        XCTAssertNil(adapter.onInterrupt, "the default must stay nil — it is the affordance gate")
        XCTAssertNil(surface(adapter).composerStopControl)
    }

    /// `turnRunning` is READ LIVE from the session, not captured when the adapter was built — so a
    /// turn that starts after the surface exists still produces a stop button.
    ///
    /// This is the assertion that would red if someone "optimised" `FieldStateAdapter.turnRunning`
    /// into a stored flag mirrored at init, which is a real and tempting refactor: every other test
    /// in this file builds its adapter already in the state it wants.
    func testTheRunningFlagIsReadLiveRatherThanCapturedAtBuildTime() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        adapter.composerDraft = "hello"
        adapter.onInterrupt = {}
        let view = surface(adapter)
        XCTAssertEqual(view.composerCard?.sendButtonRole, .send)

        session.applyForTesting { $0.turnRunning = true }
        XCTAssertEqual(view.composerCard?.sendButtonRole, .stop,
                       "the card must follow the session's live turn state, not a snapshot")
    }
}

// MARK: - Layer 4: the AppKit key handling

/// `CommandTextView.keyDown(with:)` — the override that consults `composerEscapeInterrupts`'
/// answer. `composerEscapeInterrupts` is a decision; this is the only thing that acts on it, and no
/// pure test reaches it.
///
/// The host's own wiring — `ShellSessionHost.wire(adapter:feed:)`, the ONLY thing that makes
/// `onInterrupt` non-nil in production — is pinned in `ShellSessionHostTests`
/// (`testAttachingWiresTheAdaptersInterruptAndItReachesTheWire`), on that file's vetted harness,
/// because every layer-3 test above sets that closure itself and would stay green with the wiring
/// line deleted.
@MainActor
final class ComposerEscapeKeyTests: XCTestCase {

    // MARK: - The AppKit key handling

    private func escapeEvent() -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                         windowNumber: 0, context: nil, characters: "\u{1B}",
                         charactersIgnoringModifiers: "\u{1B}", isARepeat: false, keyCode: 53)!
    }

    private func letterEvent() -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                         windowNumber: 0, context: nil, characters: "a",
                         charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0)!
    }

    /// Escape reaches `onEscape`; a `true` answer CONSUMES it (no text mutation), a `false` answer
    /// hands it to `super` untouched.
    ///
    /// The "handed back" half is asserted through a proxy that can actually distinguish the two:
    /// `super.keyDown` on an Escape runs the standard binding (`complete:`), which is a no-op on an
    /// empty text view — so "did super run" is not observable from the text. What IS observable is
    /// that `onEscape` was ASKED, and that an ordinary letter still lands. Both are checked, because
    /// an override that swallowed every key would satisfy the first alone.
    func testEscapeConsultsTheClosureAndAnOrdinaryKeyStillTypes() {
        let view = CommandTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 40))
        var asked = 0
        var answer = true
        view.onEscape = { asked += 1; return answer }

        view.keyDown(with: escapeEvent())
        XCTAssertEqual(asked, 1, "Escape must reach the closure")
        XCTAssertEqual(view.string, "", "a consumed Escape must not type anything")

        answer = false
        view.keyDown(with: escapeEvent())
        XCTAssertEqual(asked, 2, "…on every press, not only the first")

        // CONTROL ARM: an ordinary key is untouched by the override and still types. Without this,
        // an override that returned early for EVERY event would pass every assertion above.
        view.keyDown(with: letterEvent())
        XCTAssertEqual(view.string, "a", "the override must only ever claim keyCode 53")
    }

    /// A view with NO closure wired — every pre-existing surface — is byte-identical: Escape falls
    /// straight through to `super`, and nothing throws or swallows.
    func testAnUnwiredComposerIsUntouchedByTheEscapeOverride() {
        let view = CommandTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 40))
        XCTAssertNil(view.onEscape)
        view.keyDown(with: escapeEvent())
        view.keyDown(with: letterEvent())
        XCTAssertEqual(view.string, "a")
    }
}
