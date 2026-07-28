import Foundation
import Combine
import SwiftUI

/// Task 2 (fluid orb): the three states the fluid-orb bubble can render — derived purely from
/// `SessionModel`'s turn/task/unread state by `FieldStateAdapter.fluidState` below. `.idle` means
/// no fluid view should even be mounted; the other two carry a fill `level` (0…1) the view maps to
/// the bubble's liquid height, plus a color (blue while working, amber while holding an unread
/// reply — the view owns that color choice, not this enum).
enum FluidState: Equatable {
    case idle
    case working(level: Double)
    case unread(level: Double)
}

/// The ONLY new design in this transplant (everything else in `FieldKit/` is a direct v1 port).
/// A thin, v1-shaped facade over `SessionModel` so `NormaFieldView` (copied from v1
/// `GlassFieldView`'s composer path) can read exactly the surface v1's `AppState` used to
/// provide — `statusText`, `isThinking`, `visibleResponse`, a settable composer draft, and three
/// callbacks — without `NormaFieldView` knowing our session/event model exists at all. Every
/// place the copied view used to read `appState.X` now reads `adapter.X` (see `NormaFieldView`'s
/// header comment for the full read-by-read rebind list).
///
/// Task B is expected to either keep this adapter driving a live `SessionModel` (as constructed
/// here), or fold its logic directly into whatever wires `NormaFieldView` into the running app —
/// this file is deliberately small and boring so that swap is cheap either way.
@MainActor
final class FieldStateAdapter: ObservableObject {
    private let session: SessionModel
    private var cancellable: AnyCancellable?
    private var cancellables = Set<AnyCancellable>()

    init(session: SessionModel) {
        self.session = session
        self.previousLastTurnAborted = session.state.lastTurnAborted
        // Republish the session's own changes as our own — `statusText`/`isThinking`/
        // `visibleResponse` below are computed (not `@Published`) so they always read `session`
        // live; this is what makes `@ObservedObject var adapter: FieldStateAdapter` in the view
        // actually re-render when the underlying session changes.
        cancellable = session.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }

        // Cache the task-completion fill level from the event stream (when state changes),
        // not from the getter's read-time side effect. This ensures that a fast
        // taskUpdated→turnCompleted burst hitting the same render doesn't drop the final
        // level (1.0) because the getter never ran between events.
        session.$state
            .sink { [weak self] newState in
                guard let self else { return }
                if newState.turnRunning {
                    let c = newState.taskCounts
                    self.lastWorkingLevel = c.total > 0 ? Double(c.done) / Double(c.total) : 0.5
                    // Final-review fix (IMPORTANT-1): a turn_started-driven turnRunning=true must
                    // clear any still-pending stopped-flash immediately — without this, Esc'ing a
                    // turn then resubmitting within the 2s auto-clear window renders "⏹ stopped" +
                    // the slate flash tint OVER a live, working orb (false status: the new turn is
                    // actually running, but the UI still reports the old one as stopped). Cancel
                    // the pending auto-clear `DispatchWorkItem` too (not just the flag) so it can't
                    // fire later and redundantly re-clear an already-false flag. Guarded on
                    // `showStoppedFlash` currently being true so a turn that never flashed doesn't
                    // take a spurious `@Published` publish on every single state event while
                    // running (this sink fires on every task/turn event, not just turn_started).
                    self.stoppedFlashWorkItem?.cancel()
                    self.stoppedFlashWorkItem = nil
                    if self.showStoppedFlash {
                        self.showStoppedFlash = false
                    }
                }
                // Interrupt-feedback gate polish: fire the transient "stopped" flash exactly on
                // the false→true edge of the pure reducer's `lastTurnAborted` — never on a
                // steady-state read (a re-render while it's already true must NOT restart the
                // timer) and never on the true→false clear a fresh `turn_started` produces (that
                // clear is silent by design; only the ABORT itself announces).
                if newState.lastTurnAborted && !self.previousLastTurnAborted {
                    self.triggerStoppedFlash()
                }
                self.previousLastTurnAborted = newState.lastTurnAborted
            }
            .store(in: &cancellables)
    }

    /// Edge-detection memory for the sink above — `OrbSessionState.lastTurnAborted`'s own last
    /// observed value, NOT itself part of the pure reducer state (view-layer bookkeeping only).
    private var previousLastTurnAborted: Bool

    /// Interrupt-feedback gate polish: transient, view-layer-only signal that the turn just ended
    /// via an Esc-interrupt (`OrbSessionState.lastTurnAborted` flipping false→true) — deliberately
    /// NOT part of the pure reducer (`SessionReducer`/`OrbSessionState`): a self-clearing timer is
    /// exactly the kind of impurity (wall-clock time, `DispatchQueue`) the reducer's contract
    /// forbids (see `OrbSessionState.workingVerb`'s doc for the same rule applied to randomness).
    /// `NormaFieldView`/`FluidOrbSlot` read this to swap in the "⏹ stopped" caption and a muted
    /// fluid tint for 2 seconds, then fall back to their normal state-driven rendering.
    @Published var showStoppedFlash: Bool = false

    /// The pending auto-clear for `showStoppedFlash` — cancelled and replaced (not just
    /// re-scheduled) on every re-trigger so a second interrupt within the 2s window restarts the
    /// full 2s rather than letting the first timer clear the flash early out from under it.
    private var stoppedFlashWorkItem: DispatchWorkItem?

    private func triggerStoppedFlash() {
        stoppedFlashWorkItem?.cancel()
        showStoppedFlash = true
        let workItem = DispatchWorkItem { [weak self] in
            self?.showStoppedFlash = false
        }
        stoppedFlashWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: workItem)
    }

    // MARK: - v1's composer-display surface (Core/AppState.swift:160-171's `composerDisplayText`)

    /// v1 `GlassFieldView.narrationCaption` (GlassFieldView.swift:271-275), rebound to
    /// `SessionModel`'s own pill vocabulary — v1's `appState.modelStatusText` / `.statusText`
    /// free-form narration slots have no v2 equivalent.
    ///
    /// Wave 6 gate rework: `.thinking`/`.toolRunning` no longer read `OrbStatus.pillText` (it
    /// returns nil for both now) — they compose `workingVerbText(verb:)` + `workingCountText(...)`
    /// instead, so the collapsed pill shows the turn's CC-style whimsical verb ("Reticulating…")
    /// rather than a static "thinking…"/tool name, with "☑ n/m" as a separate chip positioned left
    /// of the orb. `.approvalNeeded`/`.disconnected` are checked FIRST and win outright even
    /// mid-turn — they're the only two `OrbStatus` cases whose `pillText` is non-nil, so this
    /// two-branch shape (status override, else working-verb composition) is exhaustive without a
    /// `default`/fallback case.
    ///
    /// GATE-3 FIX (F3, preserved): only returns `""` when there is truly nothing to report
    /// (`status == .idle` and no turn running) — the collapsed-orb pill's reveal condition
    /// (`NormaFieldView`'s `hasStatusPill`) gates directly on "`statusText` non-empty," mirroring
    /// the pre-transplant `OrbView.pillText`'s contract (nil only for true idle).
    ///
    /// Gate polish: split into `verbText` (right of orb) and `countText` (left of orb) for
    /// separate positioning — this property now re-composes them for backwards compatibility.
    var statusText: String {
        let s = session.state
        let text: String
        if let pillText = s.status.pillText {
            text = pillText // .approvalNeeded / .disconnected — override even mid-turn
        } else if s.turnRunning {
            let counts = s.taskCounts
            text = workingPillText(verb: s.workingVerb, hasActiveTask: s.hasActiveTask, done: counts.done, total: counts.total)
        } else {
            text = "" // true idle: status.pillText nil (.idle) and no turn running
        }
        // Gate-3 (F3) empirical evidence hook: NORMA_ORB_DEBUG=1 traces every actual change so a
        // "disconnected" pill (or any other non-empty status) reaching the collapsed orb can be
        // observed directly from a headless launch, without a screenshot.
        if text != lastLoggedStatusText {
            lastLoggedStatusText = text
            OrbDebug.log("FieldStateAdapter.statusText → \(text.isEmpty ? "<empty>" : "\"\(text)\"")")
        }
        return text
    }

    private var lastLoggedStatusText: String?

    /// Gate polish: the animated verb text for the right-side pill ("Reticulating…", "Noodling…").
    /// Returns override status text for non-working states (.approvalNeeded, .disconnected),
    /// or the bare working verb while a turn is running, or empty string for true idle.
    var verbText: String {
        let s = session.state
        if let pillText = s.status.pillText {
            return pillText // .approvalNeeded / .disconnected — override even mid-turn
        } else if s.turnRunning {
            return workingVerbText(verb: s.workingVerb)
        } else {
            return "" // true idle
        }
    }

    /// Gate polish: the task-count chip text for the left-side chip ("☑ 1/4", "☑ 3/5").
    /// Returns the count suffix only while a task is in_progress; otherwise empty string.
    var countText: String {
        let s = session.state
        if s.turnRunning {
            let counts = s.taskCounts
            return workingCountText(hasActiveTask: s.hasActiveTask, done: counts.done, total: counts.total)
        } else {
            return ""
        }
    }

    /// Wave-7 gate item 2: true exactly when `statusText` is currently showing the CC-style
    /// working-verb composition (`workingPillText`) — i.e. the SAME branch of `statusText` above
    /// — as opposed to an override pill (`disconnected`/`needs approval`, which win outright even
    /// mid-turn) or true idle. `NormaFieldView`'s animated spinner + sheen (the star-frame glyph
    /// cycling + text sweep) is gated on this so only the actual "working" verb animates; the
    /// static override pills stay plain, unanimated text.
    var isWorkingVerb: Bool {
        let s = session.state
        return s.status.pillText == nil && s.turnRunning
    }

    /// v1's `appState.presentationMode == .thinking` seam — rebound 1:1 to `state.turnRunning`
    /// (2c/2e has no separate "presentation mode," turnRunning is the only signal there is).
    var isThinking: Bool { session.state.turnRunning }

    /// v1's `appState.composerDisplayText` swap-in (Core/AppState.swift:160-171): the live
    /// stream wins while it's non-empty; otherwise the pinned/navigated exchange's reply
    /// (`exchangeIndex`, mirroring `OrbWindowController.exchangeIndex`'s 2-finger-swipe
    /// convention) if one is set and non-empty; otherwise the most recent exchange's reply;
    /// otherwise the pre-`exchanges` `lastReply` fallback. `nil` means "nothing to show" — the
    /// view falls back to the composer draft.
    var visibleResponse: String? {
        if !session.state.streamingText.isEmpty { return session.state.streamingText }
        if let index = exchangeIndex, session.state.exchanges.indices.contains(index) {
            let reply = session.state.exchanges[index].reply
            return reply.isEmpty ? nil : reply
        }
        if let reply = session.state.exchanges.last?.reply, !reply.isEmpty { return reply }
        return session.state.lastReply
    }

    /// 2d-ii-a: the full transcript for the WINDOW's scrollback. The field keeps its single
    /// pinned pair (`visibleResponse`/`displayedPrompt` honor `exchangeIndex`); the window
    /// ignores exchangeIndex entirely — scrollback replaces swipe-history there (spec §3).
    var transcript: [Exchange] { session.state.exchanges }

    /// Live partial reply for the window's streaming row — deliberately NOT `visibleResponse`
    /// (that one is exchangeIndex-pinned for the field).
    var liveStreamingText: String? {
        session.state.streamingText.isEmpty ? nil : session.state.streamingText
    }

    /// LIVE-GATE G4: CC-parity pinned todo widget — `WindowSurfaceView.windowContent` renders a
    /// compact "what's left" list below the transcript whenever ANY task isn't done yet, mirroring
    /// Claude Code's own pinned-todo panel. Empty (hides the whole section) once every task is
    /// `.completed`, or when there are no tasks at all. The gate-4 batch-reset already living in
    /// `SessionReducer`'s `taskUpdated` case clears a finished batch's tasks before the next run's
    /// first task arrives, so a stale ALL-completed list from a prior run never lingers here either.
    var pinnedTasks: [TaskItem] {
        let tasks = session.state.tasks
        return tasks.contains(where: { $0.status != "completed" }) ? tasks : []
    }

    /// 2e-ii: the live subagent block (WindowContentView renders it below the composer). Empty —
    /// hiding the whole section — once every child is done (or none exist): the block is "what's
    /// working now", the transcript's ⌥/✓ activity rows are the durable record. The reducer prunes
    /// the list at main turn end, so this also never shows a previous turn's batch.
    var liveSubagents: [SubagentItem] {
        let subagents = session.state.subagents
        return anySubagentAlive(subagents.map(\.status)) ? subagents : []
    }

    /// Dispatch (Phase 7), Task 8: in-flight children for the field's top-row circles. Terminal
    /// children are pruned by the reducer on the next turn_started (see `OrbSessionState.children`'s
    /// own doc), so this is "what's in flight" — a straight passthrough, UNLIKE `liveSubagents`
    /// above, which additionally filters an all-done batch to empty: the reducer's own prune
    /// already keeps this list honest, no second filter needed here.
    var dispatchChildren: [ChildItem] { session.state.children }

    /// Dispatch (Phase 7), Task 9 review carry-over: the visible-cap that used to live as an
    /// inline `.prefix(5)` in `NormaFieldView`'s ForEach — hoisted here so it's a testable seam
    /// (`DispatchChildrenAdapterTests`) instead of a magic number baked into the view. Behavior is
    /// unchanged: still the first `maxVisibleDispatchChildren` of `dispatchChildren`, order
    /// preserved, no "+N" overflow badge for a 6th+ child (v1, see `dispatchChildren`'s own doc).
    static let maxVisibleDispatchChildren = 5

    var visibleDispatchChildren: [ChildItem] {
        Array(dispatchChildren.prefix(Self.maxVisibleDispatchChildren))
    }

    /// Wired by whichever surface owns this adapter (`GlassRootView.wireCallbacks()` — the orb/
    /// field's single app-lifetime adapter, the only surface that renders the circles — see
    /// `NormaFieldView`'s child-circle ForEach) to open a detached window on the tapped child's
    /// sessionId, same "controller exposes a hook, AppDelegate wires the real side effect" seam as
    /// `onExpandToWindow` below. Default no-op so a not-yet-wired adapter (previews/tests) never
    /// crashes on a stray tap.
    var onOpenChild: (String) -> Void = { _ in }

    /// Task B hook (mirrors `OrbWindowController.exchangeIndex`): which historical exchange, if
    /// any, `visibleResponse` should read instead of the live stream / most recent reply. `nil`
    /// = live/most-recent. Wired by `GlassRootView`'s `.onChange(of: controller.exchangeIndex)`
    /// (the 2-finger swipe recognizer's target lives on the controller, not here).
    @Published var exchangeIndex: Int?

    /// v1 parity restored (task B): `Field/FieldView.swift` (v2's pre-transplant approximation)
    /// showed the pinned exchange's own prompt, small, above its reply while browsing history —
    /// task A dropped this since the adapter's original spec only exposed the merged
    /// `visibleResponse` string, not exchange prompt/count. Non-`nil` only while `exchangeIndex`
    /// points at a real, non-empty prompt.
    var displayedPrompt: String? {
        guard let index = exchangeIndex, session.state.exchanges.indices.contains(index) else { return nil }
        let prompt = session.state.exchanges[index].prompt
        return prompt.isEmpty ? nil : prompt
    }

    /// v1 parity restored (task B): the subtle "n/m" position readout `Field/FieldView.swift`
    /// showed next to the draft-reveal chevron while browsing a swipe-pinned historical exchange.
    var historyPositionText: String? {
        guard let index = exchangeIndex, session.state.exchanges.indices.contains(index) else { return nil }
        return "\(index + 1)/\(session.state.exchanges.count)"
    }

    /// Wave-5 gate item 2: messages sent while a turn is running are folded silently into the
    /// current exchange's prompt (`SessionReducer`'s mid-turn-steer branch) — this surfaces them
    /// so `NormaFieldView` can render a small "⧗ queued: …" line instead of the send appearing to
    /// vanish. `nil` when nothing is queued (the common case: idle, or a turn running with no
    /// steer sent yet) so the view can gate the line's reveal on non-nil, same convention as
    /// `displayedPrompt`/`historyPositionText` above.
    var queuedText: String? {
        guard !session.state.queuedSteers.isEmpty else { return nil }
        return "queued: " + session.state.queuedSteers.joined(separator: "; ")
    }

    // MARK: - Composer draft

    /// v1's composer text (`appState.composerDisplayText` / `appState.updateComposerText`),
    /// collapsed to one settable string — paste/image/caret-navigation are all cut for this
    /// transplant (D7: text-only field). `draftBinding` below is the Binding-compatible wrapper
    /// the view actually consumes; an `ObservableObject` can't itself conform to `Binding`.
    @Published var composerDraft: String = ""

    var draftBinding: Binding<String> {
        Binding(get: { self.composerDraft }, set: { self.composerDraft = $0 })
    }

    /// GATE-3 FIX (round 3, F4): moved here (from a private `@State` inside `NormaFieldView`) so
    /// `GlassRootView` can drive it directly from `.onChange(of: controller.surface)` — the only
    /// place that knows "a fresh summon just happened." `true` = the composer/draft is what the
    /// shell shows; `false` = the inline response occupies the shell instead. v1's home-state
    /// contract: the COMPOSER is the default on every summon (see `GlassRootView`'s `.field` case
    /// for the one exception — an actively streaming turn). `NormaFieldView` still owns the two
    /// other writers: the reveal-draft chevron (`true`, user asked to see the draft again) and the
    /// turn-just-started transition (`false`, a new reply takes the shell back over).
    @Published var showingDraft: Bool = false

    /// Wave-3 gate item 2c: true when a turn finished with a reply while the cursor was moving
    /// too fast to auto-expand into (`GlassRootView`'s turn-completion handler, gated by
    /// `OrbFollower.isCursorCalm`) — signals the collapsed orb should soft-blink until the field
    /// is next summoned. Cleared unconditionally on every expand (`GlassRootView`'s
    /// `.onChange(of: controller.surface)` `.field` case) — any summon path counts as "read."
    @Published var hasUnread: Bool = false

    // MARK: - Task 2: fluid-orb state derivation

    /// Last fill level observed while `fluidState` computed `.working` — the level `.unread`
    /// holds once `hasUnread` flips true (the task/turn that produced the reply may already be
    /// gone by then: `turnCompleted` clears `turnRunning` before the wave-3 calm-check even marks
    /// the orb unread, see `OrbFollower.isCursorCalm`/`GlassRootView`'s turn-completion handler).
    /// Updated inside the `session.$state` sink (`init` above) on every state change while
    /// `turnRunning`, NOT at `fluidState`'s read time — this ensures a fast taskUpdated→
    /// turnCompleted burst hitting the same render doesn't drop the final level (1.0) because the
    /// getter never ran between events (see the sink's own doc). Defaults to 0.5 — the same "no
    /// signal yet" level `taskLevel` itself falls back to — so an (unexercised in practice)
    /// unread-before-any-work edge case still renders a sane mid-fill bubble instead of an
    /// arbitrary stale value.
    private var lastWorkingLevel: Double = 0.5

    /// Derived, not stored: `hasUnread` wins outright (the reply is waiting, regardless of
    /// whether a new turn has already started since); otherwise `turnRunning` renders the current
    /// task-completion fill; otherwise — Finding-3 — the fluid HOLDS its level while any task is
    /// still incomplete (the WORK isn't done even though this turn ended), and only drains to
    /// `.idle` once every task is complete (or there were never any tasks).
    ///
    /// Finding-3 (gate 2): the fluid represents Norma's WORK, not just the current turn. A turn
    /// finishing with an incomplete task list (the agent paused between turns, or is waiting to be
    /// told to continue) used to drain the liquid to empty, reading as "all done" when it isn't.
    /// Now it holds `.working(level)` at the task-completion fill instead. Implementation choice
    /// (per the directive's "implementer's choice"): reuse `.working` rather than add a
    /// `.pausedWork` case — the fluid sim's slosh already decays naturally once the cursor (and so
    /// the tracking-spring acceleration feeding `FluidSim`) calms, so a held-but-idle bubble reads
    /// as "paused/settled" on its own, without a distinct dimmed case. Unread still wins above.
    var fluidState: FluidState {
        if hasUnread {
            return .unread(level: lastWorkingLevel)
        }
        let s = session.state
        let counts = s.taskCounts
        let level = counts.total > 0 ? Double(counts.done) / Double(counts.total) : 0.5
        if s.turnRunning {
            return .working(level: level)
        }
        // Turn ended: hold the fill while work remains (any task not yet completed); else drain.
        if counts.total > 0 && counts.done < counts.total {
            return .working(level: level)
        }
        return .idle
    }

    /// Final-review Important-2 (D9 settled-tick freeze): true exactly in `fluidState`'s
    /// "hold" branch above — the fluid is rendering `.working(level)` because tasks remain
    /// incomplete, NOT because a turn is actively advancing it. Threaded down to
    /// `FluidOrbSlot`/`FluidOrbView` so the tick loop knows it's safe to freeze once the sim
    /// settles (a held bubble's target level isn't moving) — MUST be false while `turnRunning`
    /// (the task-completion fill is actively changing then, see `fluidState`'s own `.working`
    /// branch) and MUST be false for `.unread`/`.idle` (the synthetic breathing and drain
    /// animations both need to keep ticking; see `FluidOrbView.step`'s `.unread` wobble and the
    /// `.idle` drain-to-zero target). Computed, not stored — same convention as `fluidState`
    /// itself, always reflects a live read of `session.state`.
    var isHoldingWork: Bool {
        guard !hasUnread else { return false }
        let s = session.state
        let counts = s.taskCounts
        return !s.turnRunning && counts.total > 0 && counts.done < counts.total
    }

    // MARK: - Callbacks (task B wires real behavior)

    /// Wired by `GlassRootView` to its own `submit(_:)`, which forwards to
    /// `OrbWindowController.onSubmit` (the app-level send chain) and only clears the draft /
    /// resets `exchangeIndex` on a successful send — a failed send never loses the composed text.
    var onSubmit: (String) -> Void = { _ in }
    /// Wired by `GlassRootView` to clear `composerDraft` — the xmark button in `NormaFieldView`'s
    /// `composerContent`.
    var onClearMessage: () -> Void = {}
    /// Wired by `GlassRootView` to `OrbWindowController.collapseToOrb()`. No `NormaFieldView`
    /// affordance calls this yet (v1's own `onCollapse` was likewise driven almost entirely by
    /// Esc, which `OrbWindowController`'s key monitor already calls directly) — kept wired for
    /// parity/future use, same status as task A's unwired reset-icon slot.
    var onCollapse: () -> Void = {}

    // MARK: - Task 6: FieldFocus (virtual keyboard focus — see FieldFocus.swift's header)

    /// 2d-i keyboard focus (virtual — the composer text view keeps firstResponder; see
    /// FieldFocus.swift). Reset to .composer on every surface change.
    @Published var focusedElement: FieldFocusElement = .composer

    /// Wired by GlassRootView → OrbWindowController.requestExpandToWindow().
    var onExpandToWindow: () -> Void = {}

    // MARK: - Gate r7: window-surface controls (same-panel window morph)

    /// Wired by GlassRootView → `OrbWindowController.collapseWindowToOrb()`. The window's RED
    /// traffic light, Esc, and the 4-finger tap all route here — collapses back to the ORB (v1
    /// parity: the large surface never returns to the field). Task 4: the YELLOW light no longer
    /// routes here — see `onWindowDetach` below.
    var onWindowClose: () -> Void = {}
    /// Wired by GlassRootView → `OrbWindowController.zoomToggleWindow()`. The green traffic light.
    var onWindowZoom: () -> Void = {}
    /// Task 4: wired by GlassRootView → `OrbWindowController.requestWindowDetach()`. The window's
    /// YELLOW traffic light (minimize) — spawns a native detached window at the panel's current
    /// frame and frees the orb for a fresh session, instead of collapsing back to the orb (plain
    /// var, wired like `onWindowClose` just above).
    var onWindowDetach: () -> Void = {}

    // MARK: - Task 7: interaction-needed pulses

    /// Spec §3: the daemon needs a human — a pending approval, question, or plan (the reducer
    /// folds all three into `.approvalNeeded`). Drives the chevron's amber pulse and the
    /// fluid's action pulse; 2d-iii turns this into actual cards in the chat window.
    var interactionNeeded: Bool {
        if case .approvalNeeded = session.state.status { return true }
        return false
    }

    // MARK: - Task 3 (2d-iii): pending-interaction cards — mount + respond wiring

    /// `PendingCardsView`'s data source (`WindowContentView`'s mount, both windows) — a thin
    /// read-through onto the reducer's own ordered (oldest-first) list, same convention as
    /// `pinnedTasks`/`transcript` above.
    var pendingInteractions: [PendingInteraction] { session.state.pendingInteractions }

    /// callIds with a respond RPC currently awaiting — `PendingCardsView`'s per-card `isInFlight`
    /// (disables that card's buttons while true). Mutated ONLY by whichever surface wires the
    /// three respond callbacks below (`GlassRootView.wireCallbacks()` for the orb/window,
    /// `DetachedWindowController.init` for a detached window) — never by this adapter itself.
    @Published var interactionInFlight: Set<String> = []

    /// callId → inline error text (`PendingCard`'s `errorLine`) — set on a failed respond RPC,
    /// cleared at the START of the next attempt for that callId (never lingers across a retry).
    /// A SUCCESSFUL respond does nothing here beyond removing the in-flight entry above — the
    /// card itself disappears once the daemon's `*_resolved` event removes it from
    /// `pendingInteractions` via the reducer; there is no optimistic dismiss.
    @Published var interactionErrors: [String: String] = [:]

    /// Wired by whichever surface owns this adapter (see `interactionInFlight`'s doc) to reach
    /// the daemon's `approval.respond` — callId, approved, optionId (SP-approvals T6: the allow-rule
    /// choice tapped, `nil` for the plain Approve/Deny buttons), childSessionId (Dispatch, Phase 7:
    /// set only when this card is the mirrored copy of a CHILD session's approval — `nil` routes to
    /// whatever session this surface already targets, unchanged from before Phase 7).
    var onApprovalRespond: (String, Bool, String?, String?) -> Void = { _, _, _, _ in }
    /// callId, answers, notes (both keyed by question text — see `PendingCards.swift`'s
    /// `questionAnswers`/`questionNotes`), childSessionId (same Dispatch/Phase-7 meaning as
    /// `onApprovalRespond`'s).
    var onQuestionRespond: (String, [String: String], [String: String], String?) -> Void = { _, _, _, _ in }
    /// callId, approved, autoAccept, feedback.
    var onPlanRespond: (String, Bool, Bool, String?) -> Void = { _, _, _, _ in }

    // MARK: - Task 4 (2d-iii): ⋯ menu — per-session approval-mode policy

    /// `WindowContentView`'s ⋯ menu current-value readout — a LAST-KNOWN value, not a live daemon
    /// read: neither `session.list` nor `session.attach` returns `approvalPolicy` in its result
    /// (verified against `packages/protocol/src/methods.ts`'s `SessionListResult`/
    /// `SessionAttachResult` — neither field exists there, and `NormaClient+Methods.swift`'s
    /// `listSessions()`/`attach()` accordingly don't expose one), so there is no cheap wire read to
    /// seed this from at attach time. Seeded `"auto"` (the orb-created-session default, see
    /// `AppModel.ensureFocusedSession`'s doc) and updated ONLY on a successful `onSetPolicy` round
    /// trip (the wirer sets this, not this var itself — same convention as `interactionInFlight`/
    /// `interactionErrors` above). A session this adapter merely FOLLOWED (e.g. a daemon-default
    /// "ask" session, per the force-auto removal) shows a stale "auto" here until the user actually
    /// changes it via the menu — honest given there is currently no way to learn otherwise.
    @Published var sessionPolicy: String = "auto"

    /// True while a `session.setPolicy` RPC is in flight — the picker's rows disable themselves on
    /// this. One session-wide flag (not keyed by id like `interactionInFlight`): only one policy
    /// change can be in flight at a time. Set synchronously before the RPC, cleared once it
    /// settles — same insert/remove discipline as `interactionInFlight`.
    @Published var policyChangeInFlight: Bool = false

    /// Wired by whichever surface owns this adapter (`GlassRootView.wireCallbacks()` for the orb/
    /// window, `DetachedWindowController.init` for a detached window) to `session.setPolicy` — the
    /// same onSubmit-precedent chain as `onSubmit`/the three respond callbacks above.
    var onSetPolicy: (String) -> Void = { _ in }

    /// Plan-immunity (2026-07-28 design): true for a chat-mode session — chat's approval policy is
    /// FIXED (core's engine.ts resolves it to the internal "chat" policy every turn regardless of
    /// the stored row, and session.setPolicy rejects ANY change for a chat target), so BOTH policy
    /// pickers (`WindowContentView.policyMenuButton`'s ⋯ popover and `WorkSidebar`'s Options-block
    /// picker) are meaningless for chat and hidden while this is true — showing a picker whose every
    /// row would now come back as an RPC error is worse than no picker at all. Only a
    /// `DetachedWindowController` ever sets this true: the morph/orb window (`GlassRootView`) has no
    /// chat concept at all, so its adapter never touches this field and it stays at its `false`
    /// default (unchanged behavior for every non-chat surface). Set at window construction
    /// (`DetachedWindowController.init`'s `isChat` param) and kept in sync across an in-place
    /// session switch (`DetachedWindowController.selectSession`, which re-derives it from the
    /// session directory's own `mode` field for the newly-pinned session — the left sidebar lists
    /// every session, chat included, with no mode filter of its own).
    @Published var isChatSession: Bool = false
}
