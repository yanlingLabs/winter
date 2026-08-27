import Foundation
import Combine
import SwiftUI
import NormaKit

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

                // panel-shell T10b review fix (Minor 3): prune `pendingCardDrafts` to exactly
                // what's still live — the resolve-path sweep `pendingCardDrafts`'s own doc points
                // to. An entry survives only if its composite key still names a callId present in
                // `newState.pendingInteractions`; everything else is stale, whether from THIS
                // session's own resolve (the reducer's `removeAll` on respond, or its wholesale
                // clear on `turnCompleted`/`agentError` — SessionModel.swift) or a leftover from a
                // session this adapter no longer names (a structural backstop for the explicit
                // per-site clears, not a replacement for them).
                //
                // Safe against pruning a still-genuinely-open card: `pendingInteractions` is
                // append-once/remove-once per callId (SessionModel.swift's `.append` on a new
                // interaction, `.removeAll { $0.callId == callId }` on resolve) and only ever
                // wholesale-reset via `session.reset()` (called ONLY from `SessionFeed.repin`/
                // `AppModel.refocus`) — it never transiently empties and refills for a callId
                // that is still open. Review round 3 correction: the idempotency guard against a
                // same-session no-op does NOT live inside `repin` itself (its only internal guard
                // is `guard case .pinned = mode else { return }` — a MODE check, not a session
                // check; it unconditionally resets on every call it doesn't bounce). The guard
                // lives one level up, in `repin`'s two callers — `DetachedWindowController.
                // selectSession`'s `guard sessionId != self.sessionId else { return }` and
                // `ShellSessionHost.hop`'s upstream `shellAttachmentAction` gate (`attached ==
                // selection ? .none : .hop(...)`) — both of which stop a redundant same-session
                // call before it ever reaches `repin`. `AppModel.refocus` is the one of the two
                // that DOES guard internally (`sessionId == focusedSessionId && attachedSession
                // == sessionId`). Either way, `session.reset()` is never reached for a
                // same-session no-op — verified by reading `repin` and both its callers directly,
                // not assumed from the outcome. And every switch path that calls
                // `session.reset()` runs one of the three explicit `pendingCardDrafts = [:]`
                // clears above no later than — in two of three call sites, strictly before —
                // that reset's own synchronous publish, so by the time THIS sink turn sees the
                // switch, the dictionary this sweep would prune is already empty. Neither race
                // destroys a live draft.
                let liveKeys = Set(newState.pendingInteractions.map {
                    self.pendingCardDraftKey(sessionId: self.boundSessionId() ?? "", callId: $0.callId)
                })
                if !self.pendingCardDrafts.isEmpty {
                    let pruned = self.pendingCardDrafts.filter { liveKeys.contains($0.key) }
                    if pruned.count != self.pendingCardDrafts.count {
                        self.pendingCardDrafts = pruned
                    }
                }

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

                // provider-correctness T6: THE TURN BOUNDARY, and the only place the picker
                // probation is ever resolved. Edge-detected on `turnRunning` true→false — the same
                // edge-detector idiom as `lastTurnAborted` just above — so exactly ONE turn's
                // outcome is ever consulted, and the probation ends either way. A revert CLEARS the
                // override (`onSetModel(nil)`/`onSetEffort(nil)`); it never writes the fallback,
                // which would sever the precedence chain and pin the session past future changes.
                if self.previousTurnRunning && !newState.turnRunning {
                    switch self.resolveProbation(turnError: newState.lastTurnError) {
                    case .model: self.onSetModel(nil)
                    case .effort: self.onSetEffort(nil)
                    case .none: break
                    }
                }
                self.previousTurnRunning = newState.turnRunning
            }
            .store(in: &cancellables)
    }

    /// provider-correctness T6: the second edge-detection memory for the sink above —
    /// `OrbSessionState.turnRunning`'s last observed value. View-layer bookkeeping, same as
    /// `previousLastTurnAborted` below and for the same reason (an edge is not reducer state).
    private var previousTurnRunning: Bool = false

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

    /// Whether the main turn is running RIGHT NOW (mac-chat-parity Task 2). The transcript's tool
    /// rows need it to tell "still running" from "no result ever arrived": a tool call the user
    /// ESC'd never receives a `tool_result`, so its stored output is `nil` permanently, and a
    /// running glyph derived from `nil` alone would leave a replayed aborted turn spinning forever.
    /// Deliberately NOT `liveStreamingText != nil` — that is false for the entire time a tool runs,
    /// which is exactly when this has to be true.
    var turnRunning: Bool { session.state.turnRunning }

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

    /// The transcript cards' pending set (`TranscriptInteractionCard`, mounted inline by
    /// `TranscriptExchangeRow` in both windows) — a thin
    /// read-through onto the reducer's own ordered (oldest-first) list, same convention as
    /// `pinnedTasks`/`transcript` above.
    var pendingInteractions: [PendingInteraction] { session.state.pendingInteractions }

    /// callIds with a respond RPC currently awaiting — `InteractionCardWiring.inFlight`, which puts
    /// that card into its "Sending…" state (the buttons are replaced, not merely disabled). Mutated ONLY by whichever surface wires the
    /// three respond callbacks below (`GlassRootView.wireCallbacks()` for the orb/window,
    /// `DetachedWindowController.init` for a detached window) — never by this adapter itself.
    @Published var interactionInFlight: Set<String> = []

    /// callId → inline error text (`InteractionCardWiring.errorLines`) — set on a failed respond RPC,
    /// cleared at the START of the next attempt for that callId (never lingers across a retry).
    /// A SUCCESSFUL respond does nothing here beyond removing the in-flight entry above — the
    /// card itself disappears once the daemon's `*_resolved` event removes it from
    /// `pendingInteractions` via the reducer; there is no optimistic dismiss.
    @Published var interactionErrors: [String: String] = [:]

    /// panel-shell T10b: a pending question/plan card's typed-but-unsubmitted answer, keyed by
    /// `pendingCardDraftKey(sessionId:callId:)` — NOT bare callId (`pendingInteractions` is a
    /// list — more than one card can be open at once, and callIds can repeat across sessions; see
    /// that key helper's own doc). Lives HERE, mirroring `composerDraft` above (the "MARK: -
    /// Composer draft" section), so it survives `ShellRootView`'s `if mode != .maximized { detail
    /// }` teardown — `PendingQuestionBody`/`PendingPlanBody` used to hold this as view-local
    /// `@State`, which does not survive `detail` being torn down and rebuilt.
    ///
    /// Bounded two ways, both genuinely hygiene now that composite keying (not callId uniqueness)
    /// is what prevents a cross-session mis-display: (1) explicit per-site clears on a SESSION
    /// switch — `ShellSessionHost.hop`, `DetachedWindowController.selectSession`,
    /// `OrbWindowController.updateIsChatSession` — each wipe this wholesale, which also bounds
    /// growth across a switch; (2) the resolve-path sweep in `init`'s `session.$state` sink below,
    /// which prunes an entry the moment its callId leaves `pendingInteractions` (an ordinary
    /// same-session resolve, or the reducer's own wholesale clear on `turnCompleted`/
    /// `agentError`) — this is what bounds the orb's `fieldAdapter` (Important 1: app-lifetime,
    /// never hops, never torn down — the one surface (1) alone cannot bound). Dies with the whole
    /// adapter on detach, same as everything else on it.
    @Published var pendingCardDrafts: [String: PendingCardDraft] = [:]

    /// review fix (Important 1+2): composite key, mirroring the daemon's own
    /// `imageKey(sessionId, threadId, callId)` precedent (`packages/core/src/agent/engine.ts`) for
    /// the identical reason — callIds are provider-minted with no cross-session uniqueness
    /// guarantee, so a bare-callId key risks draining one session's draft into another session's
    /// card the moment both sessions' entries ever coexist here. No `threadId` component, unlike
    /// the daemon's three-part key: `PendingInteraction` (`SessionModel.swift`) carries no
    /// threadId in any of its cases, and the reducer's own `appendPending`/`appendInteraction`
    /// callId guards already assume callId-uniqueness WITHIN one session's list — a pre-existing
    /// invariant this key reuses rather than adds a new dimension to.
    ///
    /// `sessionId` defaults `""` via `boundSessionId() ?? ""` at both call sites (this key helper
    /// takes it as a plain parameter and stores nothing itself) — the resolve-path sweep in
    /// `init`'s `session.$state` sink above, and `pendingCardDraftBinding` right below. Never
    /// defaulted here — every PRODUCTION adapter wires `boundSessionId` (`GlassRootView`,
    /// `ShellSessionHost`, `DetachedWindowController`); it is only ever unwired in a test that
    /// constructs a bare `FieldStateAdapter` directly, where a stable shared `""` namespace, used
    /// identically by both call sites, keeps every such
    /// existing test's read-your-own-write behavior unchanged.
    private func pendingCardDraftKey(sessionId: String, callId: String) -> String {
        "\(sessionId)|\(callId)"
    }

    /// A live `Binding` into `pendingCardDrafts[pendingCardDraftKey(...)]`, defaulting a fresh
    /// `PendingCardDraft()` for a callId with no entry yet — mirrors `draftBinding` above exactly
    /// (same file, the "MARK: - Composer draft" section). The getter/setter close over `self`, so
    /// every Binding this mints — however many times a caller asks for the SAME callId across
    /// however many separately-constructed views — reads and writes the one live dictionary on
    /// this adapter, never a value captured at construction time.
    func pendingCardDraftBinding(for callId: String) -> Binding<PendingCardDraft> {
        let key = pendingCardDraftKey(sessionId: boundSessionId() ?? "", callId: callId)
        return Binding(
            get: { self.pendingCardDrafts[key] ?? PendingCardDraft() },
            set: { self.pendingCardDrafts[key] = $0 }
        )
    }

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

    /// The approval-policy readout every picker on this screen renders — `WindowContentView`'s ⋯
    /// menu, the WorkSidebar Options block, and (since mac-chat-parity T6) the composer's permissions
    /// row, which reads it through `composerPolicyControl` below. One implementation for all three:
    /// `PolicyPickerRow`.
    ///
    /// **mac-chat-parity T4 gave this a wire source.** It used to be a last-known-WRITE value: there
    /// was no `approvalPolicy` anywhere in `SessionListResult`/`SessionAttachResult`, so the only
    /// thing that ever moved it was this surface's own successful `onSetPolicy`. A session left at
    /// `bypass` by the CLI, the phone, or another window therefore read "Auto" for the whole
    /// attachment. Tolerable in a popover you open, glance at and change; a standing lie in a
    /// persistent row, where it inverts the danger styling's entire purpose.
    ///
    /// Now written from three methods, and only three: `seedSessionPolicy(for:in:)` at ALL THREE
    /// session-switch sites (`ShellSessionHost.attachFresh`/`hop`,
    /// `DetachedWindowController.selectSession`, `OrbWindowController.updateIsChatSession`),
    /// `healSessionPolicyIfUnknown(for:in:)` when the row lands late, and
    /// `adoptSessionPolicy(_:)` after a successful `session.setPolicy`. Still not a LIVE read — the
    /// daemon emits no policy-changed event, so a change made elsewhere after this was seeded is not
    /// learned until the next switch.
    ///
    /// The initial `"auto"` is unchanged (the orb-created-session default, see
    /// `AppModel.ensureFocusedSession`'s doc) but it is a PLACEHOLDER, not an answer — read
    /// `sessionPolicyKnown` below before presenting it as one. Values are raw wire strings and may
    /// be outside `sessionPolicyModes`: a chat session's is the internal `"chat"`.
    @Published var sessionPolicy: String = "auto"

    /// mac-chat-parity T4: whether `sessionPolicy` above is the DAEMON's answer or merely this
    /// adapter's placeholder. `true` once a `session.list` row supplied it or this surface's own
    /// `setPolicy` succeeded; `false` before that, and again after a switch onto a session whose row
    /// says nothing.
    ///
    /// It exists because the two halves of "degrade gracefully" are otherwise contradictory: an
    /// older daemon (or a row that has not loaded) must leave behaviour exactly as it was — which
    /// means keeping `"auto"` — while `"auto"` is itself a claim about how much the agent may do
    /// unattended. Both are satisfiable only if the unknown case is REPRESENTABLE. The surface that
    /// makes a standing claim — T6's permissions row — renders no policy label while this is `false`
    /// (it reads `composerPolicyControl` below, which is where the two are collapsed into one
    /// Optional); the two transient popovers keep showing the placeholder, which is what they have
    /// always done.
    ///
    /// Deliberately NOT an `Optional<String>` in place of `sessionPolicy`: every existing consumer
    /// compares a plain `String` (`PolicyPickerRow`'s checkmark), and T4's remit was to seed that
    /// value, not to re-plumb the pickers. T6 then moved the shared row out of
    /// `extension WindowContentView` — a move, not a re-plumb — and left this pair alone.
    @Published var sessionPolicyKnown: Bool = false

    /// The value `sessionPolicy` carries while nothing has told us otherwise — the same `"auto"` it
    /// has been seeded with since Task 4 (2d-iii), named so the seed's reset path and the property's
    /// initial value can never drift apart.
    static let unknownSessionPolicyPlaceholder = "auto"

    /// True while a `session.setPolicy` RPC is in flight — the picker's rows disable themselves on
    /// this. One session-wide flag (not keyed by id like `interactionInFlight`): only one policy
    /// change can be in flight at a time. Set synchronously before the RPC, cleared once it
    /// settles — same insert/remove discipline as `interactionInFlight`.
    @Published var policyChangeInFlight: Bool = false

    /// mac-chat-parity T4: seed the policy readout for `sessionId` off the directory's rows. Called
    /// at ALL THREE session-SWITCH sites — `ShellSessionHost.attachFresh`/`hop`,
    /// `DetachedWindowController.selectSession`, and `OrbWindowController.updateIsChatSession` —
    /// the same places that already re-derive `isChatSession` and clear the departed session's
    /// pendings. Three is the whole set, and the codebase says so in
    /// `OrbWindowController.updateIsChatSession`'s own doc; a sweep that stops at two leaves the
    /// orb's APP-LIFETIME adapter latching one session's policy over every session picked after it.
    ///
    /// ALWAYS writes, including when the row says nothing: a switch that left the previous value in
    /// place would show the DEPARTED session's policy over the arriving one, the exact "a refusal is
    /// about the session it was refused FOR" mistake those call sites guard against for
    /// `dirsRefusal`/`activityRefusal`. The reset restores the placeholder plus `known == false`,
    /// which is byte-for-byte the state a freshly constructed adapter is in — so on an older daemon
    /// this reproduces the pre-T4 behaviour exactly.
    func seedSessionPolicy(for sessionId: String, in rows: [SessionSummary]) {
        let wire = wireApprovalPolicy(sessionId, in: rows)
        sessionPolicy = wire ?? Self.unknownSessionPolicyPlaceholder
        sessionPolicyKnown = wire != nil
    }

    /// mac-chat-parity T4: fill in a policy that was UNKNOWN at switch time, once the row arrives.
    /// Wired to `directory.$rows` by the surface that owns this adapter, for the race
    /// `reconcileIsChatSession` documents as "the fourth door": a session can be attached before its
    /// row has loaded (the New-Chat hop always is), and nothing would otherwise ever read the row
    /// again for the rest of that attachment.
    ///
    /// ONE-WAY on purpose — it declines to touch a value that is already known. That is what makes
    /// it safe to run on every rows change: a `session.list` issued before a `setPolicy` and
    /// resolving after it carries the pre-change policy, and a two-way reconcile would let that
    /// stale answer silently undo the user's change. The cost is that a policy changed by ANOTHER
    /// client after this one was seeded is not picked up — the same standing limitation
    /// `sessionPolicy`'s own doc records, not a new one.
    func healSessionPolicyIfUnknown(for sessionId: String, in rows: [SessionSummary]) {
        guard !sessionPolicyKnown, let wire = wireApprovalPolicy(sessionId, in: rows) else { return }
        sessionPolicy = wire
        sessionPolicyKnown = true
    }

    /// mac-chat-parity T4: adopt the policy a `session.setPolicy` round trip just CONFIRMED. Called
    /// only on success — a failed flip must leave the picker showing the still-true previous value
    /// rather than lying about the new one (the discipline every `onSetPolicy` wirer already had;
    /// this replaces their bare `adapter.sessionPolicy = policy` so the value and its known-ness can
    /// never be set apart). The daemon accepting the write IS an answer, so this marks it known.
    func adoptSessionPolicy(_ policy: String) {
        sessionPolicy = policy
        sessionPolicyKnown = true
    }

    /// Wired by whichever surface owns this adapter (`GlassRootView.wireCallbacks()` for the orb/
    /// window, `DetachedWindowController.init` for a detached window) to `session.setPolicy` — the
    /// same onSubmit-precedent chain as `onSubmit`/the three respond callbacks above.
    var onSetPolicy: (String) -> Void = { _ in }

    /// mac-chat-parity T6: this adapter's policy state as the composer's permissions row takes it
    /// (spec §4) — the value `WindowContentView.composerCard` hands `NormaComposerCard`.
    ///
    /// The placeholder never crosses this boundary: `policy` is `nil` unless `sessionPolicyKnown`.
    /// That is `sessionPolicyKnown`'s own doc being obeyed — "a surface that makes a standing claim
    /// should render no policy label while this is `false`; the two transient popovers may keep
    /// showing the placeholder, which is what they have always done" — and collapsing the pair into
    /// one Optional here is what stops the row from having to remember it.
    ///
    /// `onSet` forwards rather than handing over today's `onSetPolicy` value, so a card built before
    /// its surface wired its callbacks still reaches the real one when the row is finally tapped —
    /// the same tap-time read the two pickers' own buttons do.
    var composerPolicyControl: ComposerPolicyControl {
        ComposerPolicyControl(policy: sessionPolicyKnown ? sessionPolicy : nil,
                              changeInFlight: policyChangeInFlight,
                              onSet: { [weak self] policy in self?.onSetPolicy(policy) })
    }

    // MARK: - Task 10 (Chat Slice D): the header's model menu — `session.setModel`, ALL modes

    /// True while a `session.setModel` RPC is in flight — the model menu's rows disable themselves
    /// on this, mirroring `policyChangeInFlight` exactly. A SEPARATE flag (not shared with
    /// `policyChangeInFlight`): the model and policy menus are independent affordances — a policy
    /// change in flight must never disable the model menu, and vice versa.
    @Published var modelChangeInFlight: Bool = false

    /// Wired by whichever surface owns this adapter to `session.setModel` — `nil` clears the
    /// override (the wire itself sends a literal `null`, `NormaClient.setModel`'s own doc). UNLIKE
    /// `onSetPolicy`, there is no adapter-cached "current value" this callback bumps on success:
    /// `session.list` already carries `model` per-row (T1) — the wirer refreshes that row's
    /// directory entry instead of keeping a second source of truth here (see `WindowContentView`'s
    /// model-menu content, which reads the row directly via `currentSidebarSessionSummary`).
    var onSetModel: (String?) -> Void = { _ in }

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

    // MARK: - working-directories T8: the header's working-folders chip — `session.setDirs`

    /// True while a `session.setDirs` RPC is in flight — the chip's action rows disable themselves on
    /// this. A SEPARATE flag from `modelChangeInFlight`/`effortChangeInFlight`/`policyChangeInFlight`
    /// for the same reason those three are separate from each other: independent affordances.
    @Published var dirsChangeInFlight: Bool = false

    /// The daemon's OWN refusal sentence for the last `session.setDirs` attempt, shown VERBATIM in
    /// the chip's menu, or `nil` when the last attempt succeeded (or none has been made).
    ///
    /// Verbatim is the whole point. `set-dirs.ts` writes one sentence per rule — "that directory is
    /// locked for this session", "that directory can never be a working directory", "working
    /// directories apply to code and cowork sessions only", and the remove-primary refusal that names
    /// `setPrimary` as the way out. Each names the rule it enforced; a client-side "couldn't set
    /// folder" erases exactly the sentence that teaches the rule. Set by the WIRER (never by this
    /// adapter), same convention as `interactionErrors`.
    @Published var dirsRefusal: String?

    /// Wired to `session.setDirs` for an action on a path ALREADY KNOWN (the menu's per-entry
    /// "Remove") — op + path. The wirer runs the RPC, refreshes the directory row on success (the
    /// dirs set lives on `session.list`'s row, exactly like `model`, so there is no second source of
    /// truth here to bump), and publishes any refusal into `dirsRefusal`.
    var onSetDirs: (SessionDirsOp, String) -> Void = { _, _ in }

    /// Wired to "pick a folder, confirm, then `session.setDirs`" — the menu's "Add folder…" and
    /// "Change primary folder…" rows. A SEPARATE callback from `onSetDirs` because the panel and the
    /// confirm alert are AppKit, which belongs to the window controller: a SwiftUI body must never
    /// run an `NSOpenPanel`. The confirm is the user's explicit ruling — a manual add is SELECTION +
    /// CONFIRM, never a one-click widening of what Norma may write to.
    var onPickWorkingDir: (SessionDirsOp) -> Void = { _ in }

    // MARK: - app-shell T3: the header's `/background` affordance — `session.setActivity`

    /// Wired to `session.setActivity` by whichever surface can service it — the ACTIVITY TARGET
    /// verbatim (`"background"`, `"unbackground"`, `"archived"`, or `nil` for resume; see
    /// `NormaClient.setActivity`). The whole vocabulary, not just the one verb T3 offers, so the
    /// roster verbs landing on the mode landings (T4) reach the same seam rather than a second one.
    ///
    /// **OPTIONAL, defaulting `nil`, and that is the visibility gate** — the same opt-in shape
    /// `SidebarWiring.onSummonApp` uses, for the same reason. Every PRE-EXISTING surface (the orb's
    /// morph window, every detached window) leaves it nil and therefore renders no affordance, so
    /// nothing about those windows changes; the shell's host wires it. A non-optional closure with a
    /// no-op default would instead have grown a button on every surface whose every click did
    /// nothing — the shown-but-broken shape this codebase keeps closing.
    var onSetActivity: ((String?) -> Void)?

    /// office-live-ux Job 1 — **stop the running turn** (`session.interrupt`). Both of Job 1's two
    /// surfaces come through here: the composer's Esc (`ComposerTextView.onEscape`) and the send
    /// button's stop role (`NormaComposerCard`), so the two cannot end up calling different things.
    ///
    /// **OPTIONAL, defaulting `nil`, and that is the affordance gate** — the same opt-in shape
    /// `onSetActivity` just above uses, for the same reason it gives. A surface that does not wire
    /// this shows no stop button and consumes no Esc: the orb's morph window and every detached
    /// window already own their Esc through `NSEvent` monitors of their own
    /// (`OrbWindowController.swift:567`, `DetachedWindowController.swift:499`), and a second,
    /// responder-scoped door on the same key in the same window is exactly the double-interrupt
    /// this default rules out.
    ///
    /// **`turnRunning` is the single source of truth for whether it is offered**, and it is read at
    /// call time in both places rather than mirrored into a second flag — see that property.
    var onInterrupt: (() -> Void)?

    /// True while a `session.setActivity` RPC is in flight — the affordance's rows disable on it.
    /// A SEPARATE flag from the other four for the same reason those are separate from each other.
    @Published var activityChangeInFlight: Bool = false

    /// The daemon's OWN refusal sentence for the last `session.setActivity` attempt, shown VERBATIM,
    /// or `nil` when the last attempt succeeded (or none has been made). Same reasoning as
    /// `dirsRefusal` above, on a state machine with the same discipline: `set-activity.ts` writes one
    /// sentence per rule ("activity states apply to code and cowork sessions only", "session is
    /// archived — resume it first", "stop or background it first") and each names the rule it
    /// enforced. Set by the WIRER, never by this adapter.
    @Published var activityRefusal: String?

    // MARK: - provider-correctness T6: the catalogue-driven model/effort pickers

    /// The daemon's synced model catalogue (`sync.config`) — the pickers' ONLY source of slugs and
    /// effort levels, replacing the hardcoded three-slug mirror that used to live in
    /// `WindowContentView`. Populated by whichever surface owns this adapter (its own `NormaClient`
    /// calls `NormaClient.syncConfig()`); `.empty` until then, which the pickers render as "no rows
    /// offered" rather than as a fallback lineup — a derived catalogue is precisely the bug the
    /// field exists to kill.
    @Published var modelCatalogue: SyncConfigSnapshot = .empty

    /// Re-reads the catalogue into `modelCatalogue`. Wired by whichever surface owns this adapter;
    /// called when a picker MENU OPENS, which is the honest refresh point for a value that is a
    /// SNAPSHOT rather than a subscription — `sync.config` re-resolves the model and effort on every
    /// call, so a `norma model --effort` edit made while a window sat open lands the next time the
    /// user actually looks. Deliberately NOT on a session switch: the catalogue is daemon-wide, so a
    /// switch cannot change it, and firing an RPC there perturbs the create/attach sequence every
    /// switch test asserts on for no benefit.
    var onRefreshModelCatalogue: () -> Void = {}

    /// True while a `session.setEffort` RPC is in flight. A SEPARATE flag from `modelChangeInFlight`
    /// for the same reason that one is separate from `policyChangeInFlight`: model and effort are
    /// independent axes and independent affordances ("two different things, just like the CLI").
    @Published var effortChangeInFlight: Bool = false

    /// Wired to `session.setEffort` — `nil` CLEARS the override (the wire sends a literal null).
    /// Same wirer-owns-the-bookkeeping convention as `onSetModel`.
    var onSetEffort: (String?) -> Void = { _ in }

    /// The model selection applied OPTIMISTICALLY — rendered ahead of the RPC's answer, and reverted
    /// to `.none` if the daemon refuses. See `OptimisticSelection` for why the revert is a revert of
    /// the OVERLAY and never a write of the fallback.
    @Published var pendingModel: OptimisticSelection = .none
    /// The effort half of `pendingModel`.
    @Published var pendingEffort: OptimisticSelection = .none

    /// mac-chat-parity T7: **the pair every model row fires**, wherever it is rendered — flip the
    /// optimistic overlay, then fire the RPC. Extracted (from the inline body of the header's own
    /// row) because the composer's chip is now a SECOND surface that must apply it, and two copies of
    /// "flip the overlay, then fire" is exactly how one surface ends up not flipping it: the chip and
    /// the header would then disagree about what is selected for the whole round trip.
    ///
    /// `nil` is the "Default" row — a CLEAR, which is a distinct overlay state from "no overlay"
    /// (see `OptimisticSelection`). The rest of the bookkeeping (the in-flight flag, the revert, the
    /// probation) stays with the wirer, unchanged.
    func applyModelSelection(_ model: String?) {
        pendingModel = model.map { OptimisticSelection.value($0) } ?? .clear
        onSetModel(model)
    }

    /// The effort half of `applyModelSelection`, for the same reason and on the same terms.
    func applyEffortSelection(_ effort: String?) {
        pendingEffort = effort.map { OptimisticSelection.value($0) } ?? .clear
        onSetEffort(effort)
    }

    /// The selection currently ON PROBATION — applied, accepted by the daemon, and awaiting the
    /// verdict of the ONE turn that runs next. Nil the rest of the time. In memory only: a probation
    /// cannot survive a relaunch, which is half of why the transcript-wide-scan bug it replaces
    /// cannot recur here.
    @Published var selectionProbation: SelectionProbation?

    /// The session this adapter is currently bound to. Wired by whichever surface owns it
    /// (`DetachedWindowController` → its own `sessionId`; the orb → `AppModel.focusedSessionId`).
    ///
    /// I1 (review): this exists because a probation must be able to say WHICH session it belongs to.
    /// The revert goes out through `AppModel.setSessionModel`/`setSessionEffort`, which resolve
    /// `focusedSessionId` AT REVERT TIME — so an unstamped probation armed on session A and resolved
    /// while B is focused clears B's override and leaves A's in place.
    var boundSessionId: () -> String? = { nil }

    /// Called by the pickers' wirer when the RPC SUCCEEDS — arms the probation on what was just
    /// accepted, stamped with the session it was accepted FOR.
    ///
    /// Both parameters are DOUBLY optional, and the middle case is the point (M2, review):
    ///   * `.none`        → this axis is not part of this call. Leave whatever it holds.
    ///   * `.some(nil)`   → the user picked "Default" on this axis. Disarm THAT AXIS ONLY — clearing
    ///                      an override can never be the thing that breaks a turn. The old flat
    ///                      `String?` signature made this indistinguishable from "not arming", so
    ///                      `armProbation(model: nil)` wiped a live EFFORT probation as a side
    ///                      effect of the user touching the model menu.
    ///   * `.some(value)` → arm this axis.
    func armProbation(model: String?? = nil, effort: String?? = nil) {
        guard let sid = boundSessionId(), !sid.isEmpty else { selectionProbation = nil; return }
        // A probation stamped for a DIFFERENT session is stale — never merge a new axis onto it.
        let existing = selectionProbation?.sessionId == sid ? selectionProbation : nil
        let nextModel = model ?? existing?.model
        let nextEffort = effort ?? existing?.effort
        guard nextModel != nil || nextEffort != nil else { selectionProbation = nil; return }
        selectionProbation = SelectionProbation(
            sessionId: sid, model: nextModel, effort: nextEffort,
            // M1 (review): a selection applied MID-TURN cannot have affected the turn already
            // running — the daemon resolves model/effort at turn start — so that turn's outcome
            // says nothing about it. Consume the in-flight turn's boundary without a verdict and
            // judge the NEXT one. Chosen over the doc-line option because the passive-failure
            // argument cuts both ways: the wrong verdict here CLEARS a deliberate user choice.
            skipsInFlightTurn: existing?.skipsInFlightTurn ?? session.state.turnRunning)
    }

    /// Resolves the probation against the turn that just ran. Returns what the caller must clear.
    ///
    /// The revert a caller performs is `onSetModel(nil)` / `onSetEffort(nil)` — a CLEAR, never a
    /// write of the previous value. Writing the fallback would sever the precedence chain (session
    /// override → daemon default) and silently pin the session past every future change; clearing
    /// restores it.
    ///
    /// Three refusals, in order:
    ///   1. SESSION MISMATCH (I1) — the probation belongs to a session this adapter is no longer
    ///      bound to. Its verdict could only ever be applied to the WRONG session, since the revert
    ///      resolves the focused session at revert time. Dropped, never acted on. The per-surface
    ///      clear in `DetachedWindowController.selectSession` stays as belt-and-braces; this is the
    ///      guard that also covers the orb, whose only session-switch hook
    ///      (`OrbWindowController.updateIsChatSession`) touches nothing else.
    ///   2. IN-FLIGHT TURN (M1) — armed while a turn was already running. Consume this boundary
    ///      without a verdict; the probation survives for the next turn, which is the first one that
    ///      actually ran on the new selection.
    ///   3. Otherwise: one turn, one verdict, and the probation ends either way.
    @discardableResult
    func resolveProbation(turnError: String?) -> SelectionRevert {
        guard let probation = selectionProbation else { return .none }
        guard probation.sessionId == boundSessionId() else {
            selectionProbation = nil
            return .none
        }
        if probation.skipsInFlightTurn {
            selectionProbation?.skipsInFlightTurn = false
            return .none
        }
        defer { selectionProbation = nil }
        return selectionRevert(probation, turnErrorMessage: turnError)
    }
}

/// provider-correctness T6: a picker selection applied ahead of its RPC's answer.
///
/// Three cases, not `String?`, because "no optimistic value" and "optimistically cleared" are
/// different states that `nil` cannot tell apart — and conflating them is how an optimistic UI ends
/// up showing a cleared override that the daemon actually refused to clear.
enum OptimisticSelection: Equatable {
    /// No optimistic value — render the daemon's own row. This is also the REVERT state: an RPC
    /// refusal returns here, which shows the user exactly what the daemon still holds. It is
    /// deliberately NOT "write the previous value back": the daemon never changed anything, so there
    /// is nothing to write, and writing would be the fallback-severs-precedence bug in miniature.
    case none
    /// The user picked "Default" — render as no override.
    case clear
    case value(String)
}

/// provider-correctness T6: what a picker is rendering right now — the optimistic overlay when there
/// is one, the daemon's row otherwise.
func effectiveSelection(row: String?, optimistic: OptimisticSelection) -> String? {
    switch optimistic {
    case .none: return row
    case .clear: return nil
    case .value(let v): return v
    }
}

/// A just-applied selection awaiting the verdict of exactly ONE turn.
struct SelectionProbation: Equatable {
    /// I1 (review): WHICH session this probation belongs to. Load-bearing, not bookkeeping — the
    /// revert resolves its target session at revert time, so an unstamped probation armed on session
    /// A and resolved while B is focused clears B's override and leaves A's untouched.
    var sessionId: String
    var model: String?
    var effort: String?
    /// M1 (review): armed while a turn was ALREADY running, so the first boundary that follows
    /// belongs to a turn that ran on the OLD selection and must be consumed without a verdict.
    var skipsInFlightTurn: Bool = false
}

enum SelectionRevert: Equatable {
    case none
    case model
    case effort
}

/// Does the turn that just ran implicate the selection on probation?
///
/// **Scoped to ONE turn by construction, and that is the load-bearing property.** `turnErrorMessage`
/// is `OrbSessionState.lastTurnError`, which the reducer sets on a main-thread `agent_error` and
/// clears on the next `turn_started` and on any clean `turn_completed`. There is no transcript to
/// scan and no history to accumulate: an earlier implementation of this idea scanned the whole
/// transcript, which made a model choice unholdable forever after one bad turn — and, because the
/// transcript is durable, that survived relaunch. Neither is expressible here.
///
/// **Conservative on purpose, and I4 (review) made it more so.** A revert throws away a choice the
/// user deliberately made, so the message must name BOTH the value and the axis before this fires.
/// The residual case it exists for is narrow: set-time validation (`session.setEffort`/
/// `session.setModel`, T1/T4/T5) already refuses anything the daemon's own catalogue rejects, so
/// what reaches here is a selection the catalogue accepted and the ENDPOINT did not — a BYOK
/// provider, or a per-model divergence the daemon has not learned yet.
///
/// The value must appear QUOTED (see `mentionsQuoted`). Plain `contains` clears a deliberate choice
/// on an incidental substring: `"low"` sits inside "allowed", `"high"` inside "xhigh", `"max"`
/// inside "maximum". The review offered quoting OR a word-boundary regex; quoting is the stricter of
/// the two and is the only one that survives `"none"`, which is an ordinary English word with
/// perfectly good boundaries around it ("…; none of the retries succeeded"). The bias is deliberate:
/// a false NEGATIVE just means no auto-revert (the user still sees a failing turn and can act), while
/// a false POSITIVE silently destroys a setting they chose on purpose.
///
/// **A NORMA-LEVEL TIER NEVER REVERTS HERE, AND THAT IS A PERMANENT FALSE NEGATIVE, NOT A BUG TO
/// PATCH LOCALLY** (whole-branch review M1). `probation.effort` holds what the user SELECTED —
/// `SessionListResult.effort` reports a tier verbatim, so `"ultra"` — while the endpoint's rejection
/// quotes what was actually SENT, the wire translation (`"max"`). The two never match, so the
/// `.effort` branch below is structurally dead for a tier.
///
/// It is left that way on purpose. Closing it needs the tier→wire table (`CLIENT_EFFORT_WIRE`,
/// packages/core/src/settings.ts) on this side, and `sync.config` deliberately does not serve it —
/// `clientEfforts` is a list of tiers, not a mapping. Hand-copying the table here would recreate
/// precisely the client-side mirror of a daemon constant that this whole branch exists to delete,
/// and it would drift the first time a tier's translation changes, silently, in the direction that
/// destroys a user's setting. The honest fix is daemon-side (serve the translation, or have the
/// error name the tier it came from); until then this is exactly the false negative the bias above
/// already declares acceptable — the user sees the failing turn and clears the effort themselves.
/// The residual is narrow twice over: a tier is code-sessions-only, and since the whole-branch I1
/// fix the picker offers no tier at all unless the daemon reported real wire levels beside it.
func selectionRevert(_ probation: SelectionProbation?, turnErrorMessage: String?) -> SelectionRevert {
    guard let probation, let raw = turnErrorMessage else { return .none }
    let message = raw.lowercased()
    // Effort first: an effort rejection names the model too (`unsupported_value` errors quote the
    // slug), so checking the model first would misattribute it and clear the wrong axis.
    if let effort = probation.effort, mentionsQuoted(effort, in: message),
       message.contains("effort") || message.contains("reasoning") {
        return .effort
    }
    if let model = probation.model, mentionsQuoted(model, in: message), message.contains("model") {
        return .model
    }
    return .none
}

/// Does `message` name `value` as a QUOTED token — `'value'`, `"value"` or `` `value` ``?
///
/// Every provider rejection this function exists to recognise quotes the offending value
/// (`unsupported_value: 'reasoning.effort' does not support 'minimal'`, `The model 'x' does not
/// exist`), and requiring the quotes is what makes "xhigh" fail to match "high": the character
/// before `high` inside `'xhigh'` is `x`, not a quote. `message` is expected pre-lowercased;
/// `value` is lowercased here so callers cannot get that wrong.
func mentionsQuoted(_ value: String, in message: String) -> Bool {
    guard !value.isEmpty else { return false }
    let needle = value.lowercased()
    return ["'", "\"", "`"].contains { message.contains("\($0)\(needle)\($0)") }
}
