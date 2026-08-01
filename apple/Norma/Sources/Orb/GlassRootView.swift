import SwiftUI

/// Task B (v1 field transplant, the swap): hosts the transplanted FieldKit view
/// (`NormaFieldView`) instead of the old orb/field morph approximation (`OrbView`+`FieldView`,
/// both deleted) — `NormaFieldView` owns its own `GlassEffectContainer` and renders the whole
/// orb↔field morph itself off `morphModel.progress`, so this view no longer needs one either.
///
/// What SURVIVES here from the pre-transplant version, moved onto `FieldStateAdapter` instead of
/// a local `@State draft`: draft ownership (stash on collapse / restore on expand via
/// `DraftCache`), the submit() chain (draft clear gated on `controller.onSubmit`'s success so a
/// failed send never loses the composed text — spec §6), and `exchangeIndex` reset rules (a new
/// turn starting, or the exchange list shrinking under a stale pin) that used to live in
/// `Field/FieldView.swift`.
struct GlassRootView: View {
    @ObservedObject var session: SessionModel
    @ObservedObject var controller: OrbWindowController
    @ObservedObject var morphModel: MorphModel
    /// Task-3 fix wave: deliberately NOT `@ObservedObject` — same reason as `NormaFieldView.fluid`
    /// (see `FluidModel`'s doc, `FieldKit/FluidOrbView.swift`). Held only to pass down to
    /// `NormaFieldView`, which itself only passes it further down to `FluidOrbSlot`.
    let fluidModel: FluidModel
    // NOTE: owned by `OrbWindowController.fieldAdapter` (Task 2d-i.2), not here — the chat
    // window shares this same instance for drafts/replies/focus. Injected as `@ObservedObject`,
    // so the memberwise init suffices (no custom init needed).
    @ObservedObject var adapter: FieldStateAdapter
    private let draftCache = DraftCache()

    /// Idempotent callback wiring onto the INSTALLED adapter (see init NOTE).
    private func wireCallbacks() {
        adapter.onSubmit = { [self] text in submit(text) }
        adapter.onClearMessage = { [adapter] in adapter.composerDraft = "" }
        adapter.onCollapse = { [controller] in controller.collapseToOrb() }
        adapter.onExpandToWindow = { [controller] in controller.requestExpandToWindow() }
        // Dispatch (Phase 7), Task 8: the field's own child-status circles — tapping one asks
        // upward via `controller.onOpenChild` (`AppDelegate.boot()` wires the real detached-window
        // spawn), same seam as `onExpandToWindow` just above.
        adapter.onOpenChild = { [controller] sessionId in controller.onOpenChild?(sessionId) }
        // Gate r7 (same-panel window morph): the window's traffic lights / zoom route back to the
        // controller — red collapses to the orb, green toggles zoom. Esc + the 4-finger tap use
        // `collapseWindowToOrb()` directly (key monitor / AppDelegate summon router).
        adapter.onWindowClose = { [controller] in controller.collapseWindowToOrb() }
        adapter.onWindowZoom = { [controller] in controller.zoomToggleWindow() }
        // Task 4: the yellow light detaches into a native window instead of collapsing — see
        // `OrbWindowController.requestWindowDetach()`'s doc for the full ordering it owns.
        adapter.onWindowDetach = { [controller] in controller.requestWindowDetach() }
        // Wave-5 gate item 4: the composer-hop seam — `OrbWindowController.handleAcceptedSwipe`
        // needs to read/write `adapter.showingDraft` but can't reach the adapter directly (see
        // `OrbWindowController.isShowingDraft`'s doc).
        controller.isShowingDraft = { [adapter] in adapter.showingDraft }
        controller.setShowingDraft = { [adapter] value in adapter.showingDraft = value }

        // Task 3 (2d-iii): the three pending-interaction respond callbacks — exact same
        // strong-`[adapter]`-capture idiom as `onClearMessage` above (a self-cycle through the
        // adapter's own stored closure property, harmless here because this is the ORB's single
        // app-lifetime `fieldAdapter`, never torn down — see `DetachedWindowController.init`'s
        // `[weak adapter]` for the one-adapter-per-window case where that same cycle IS a real
        // leak). `controller` (not `model`) is the reach — `GlassRootView` stays model-free,
        // mirroring `submit(_:)`'s own `controller.onSubmit` chain exactly. In-flight/error
        // discipline: insert + clear any stale error SYNCHRONOUSLY (before the await), remove
        // in-flight once the RPC settles, set an error line ONLY on failure — a success does
        // nothing further, the resolved event removes the card via the reducer.
        adapter.onApprovalRespond = { [adapter, controller] callId, approved, optionId, childSessionId in
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor in
                let ok = await controller.onApprovalRespond?(callId, approved, optionId, childSessionId) ?? false
                adapter.interactionInFlight.remove(callId)
                if !ok { adapter.interactionErrors[callId] = "couldn't send — try again" }
            }
        }
        adapter.onQuestionRespond = { [adapter, controller] callId, answers, notes, childSessionId in
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor in
                let ok = await controller.onQuestionRespond?(callId, answers, notes, childSessionId) ?? false
                adapter.interactionInFlight.remove(callId)
                if !ok { adapter.interactionErrors[callId] = "couldn't send — try again" }
            }
        }
        adapter.onPlanRespond = { [adapter, controller] callId, approved, autoAccept, feedback in
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor in
                let ok = await controller.onPlanRespond?(callId, approved, autoAccept, feedback) ?? false
                adapter.interactionInFlight.remove(callId)
                if !ok { adapter.interactionErrors[callId] = "couldn't send — try again" }
            }
        }

        // Task 4 (2d-iii): the ⋯ menu's approval-mode picker — same seam/discipline as the three
        // respond callbacks above (in-flight flipped SYNCHRONOUSLY, cleared once the RPC settles),
        // except `sessionPolicy` itself is bumped to the new value ONLY on success — a failed flip
        // leaves the picker showing the still-true last-known value instead of lying about it.
        adapter.onSetPolicy = { [adapter, controller] policy in
            adapter.policyChangeInFlight = true
            Task { @MainActor in
                let ok = await controller.onSetPolicy?(policy) ?? false
                adapter.policyChangeInFlight = false
                if ok { adapter.sessionPolicy = policy }
            }
        }

        // Task 10 (Chat Slice D): the model menu — same seam/discipline as `onSetPolicy` just
        // above, EXCEPT there's no adapter-side cache to bump: the menu reads the current session's
        // `model` straight off `controller.sidebars`' own directory row (`session.list` already
        // carries it, T1), so a successful change just refreshes THAT row. Refresh happens BEFORE
        // clearing `modelChangeInFlight` so the re-render its `@Published` flip forces already sees
        // the fresh row (same ordering as `DetachedWindowController`'s twin wiring).
        adapter.onSetModel = { [adapter, controller] model in
            adapter.modelChangeInFlight = true
            Task { @MainActor in
                let ok = await controller.onSetModel?(model) ?? false
                if ok { await controller.sidebars?.directory.refresh() }
                // provider-correctness T6: the RPC's answer is no longer swallowed — see the twin
                // wiring in `DetachedWindowController.init` for the full rationale (success retires
                // the overlay and arms a one-turn probation; refusal reverts the overlay to `.none`,
                // which is a revert of the OVERLAY, never a write of the fallback).
                adapter.pendingModel = .none
                if ok { adapter.armProbation(model: .some(model)) }
                adapter.modelChangeInFlight = false
            }
        }

        // provider-correctness T6: the effort menu — the model wiring's twin on the other axis.
        adapter.onSetEffort = { [adapter, controller] effort in
            adapter.effortChangeInFlight = true
            Task { @MainActor in
                let ok = await controller.onSetEffort?(effort) ?? false
                if ok { await controller.sidebars?.directory.refresh() }
                adapter.pendingEffort = .none
                if ok { adapter.armProbation(effort: .some(effort)) }
                adapter.effortChangeInFlight = false
            }
        }

        // provider-correctness T6: seed the pickers' catalogue. `sync.config` is a snapshot, so this
        // is a fetch, not a subscription; a failure leaves `.empty` and the pickers offer no rows
        // rather than a guessed lineup.
        adapter.onRefreshModelCatalogue = { [adapter, controller] in
            Task { @MainActor in
                if let snapshot = await controller.onFetchModelCatalogue?() { adapter.modelCatalogue = snapshot }
            }
        }
        // I1 (review): the orb has its OWN adapter and its only session-switch hook
        // (`OrbWindowController.updateIsChatSession`) touches nothing else — so the probation's own
        // session stamp, not a per-site clear, is what keeps a verdict off the wrong session. Read
        // fresh through the sidebar wiring, which AppDelegate points at `AppModel.focusedSessionId`.
        adapter.boundSessionId = { [controller] in controller.sidebars?.currentSessionId() }
        // I2 (review): NO NETWORK I/O HERE. This function is called unconditionally from `body`, and
        // every other line in it is an idempotent closure assignment. A fetch here fanned out into a
        // burst of concurrent `sync.config` calls on the first render, and — because a failed fetch
        // leaves the snapshot `.empty` — became an unbounded RPC storm against a daemon that was
        // down. The seed now rides `.task {}` in `body`, which runs once per appearance.
    }

    var body: some View {
        wireCallbacks()
        return NormaFieldView(adapter: adapter, morph: morphModel, fluid: fluidModel, sidebars: controller.sidebars)
            // I2 (review): the catalogue seed — a LIFECYCLE hook, not a `body` side effect. Runs
            // once per appearance regardless of how many times `body` re-evaluates, so a daemon
            // that is down costs one failed fetch rather than one per render. The pickers refresh
            // again on menu-open (`adapter.onRefreshModelCatalogue`), which is what recovers a
            // catalogue this seed failed to fetch.
            .task {
                if adapter.modelCatalogue == .empty { adapter.onRefreshModelCatalogue() }
            }
            .onChange(of: controller.surface) { _, newSurface in
                switch newSurface {
                case .orb:
                    draftCache.stash(adapter.composerDraft)
                    adapter.composerDraft = ""
                    // Task 6 (FieldFocus): virtual focus never survives a surface change — a
                    // collapse must not leave the chevron (or any future 2d-iii element) latched
                    // focused for the NEXT summon.
                    adapter.focusedElement = .composer
                case .field:
                    // Task 6 (FieldFocus): every fresh summon starts on the composer — same
                    // "focus never survives a surface change" rule as the `.orb` case above.
                    adapter.focusedElement = .composer
                    // Wave-9 gate fix: every fresh expand starts the reply scrolled to its top —
                    // matches v1 (a freshly re-morphed composer never remembered a stale scroll
                    // position either) and avoids a jarring mid-reply reopen if the content
                    // changed while collapsed.
                    morphModel.responseScrollOffset = 0
                    // Wave-3 gate item 2c: any summon path clears the unread blink — the field
                    // is about to show the reply (either the composer's home-state rule below
                    // yields to the answer-reveal one-shot, or there was never an unread reply
                    // to clear in the first place).
                    adapter.hasUnread = false
                    adapter.composerDraft = draftCache.restore() ?? ""
                    // Wave-3 gate item 2b: this expand is our OWN auto-expand revealing a
                    // just-finished answer (armed by the turn-completion handler below, right
                    // before it called `expandToField()`) — the summon-home-state rule just
                    // below would otherwise flip `showingDraft` back to `true` here, since by
                    // definition the turn has already finished (`turnRunning == false`), hiding
                    // the very answer this auto-expand exists to reveal.
                    if controller.consumeExpandForAnswerReveal() {
                        adapter.showingDraft = false
                    } else if summonShowsComposer(
                        // GATE-3 FIX (round 3, F4 — root cause): the composer is v1's HOME state
                        // on every summon, not whatever reply happened to occupy the shell when
                        // the field was last collapsed — without this, re-summoning a session
                        // that already has a reply reopened straight into the (non-editable)
                        // inline response view, so the ComposerTextView never mounted and typing
                        // went nowhere (empirically confirmed: zero AXTextArea/AXTextField in the
                        // AX tree post-expand). The one exception mirrors the response's own
                        // "takes the shell over" trigger below (`session.state.turnRunning`
                        // flip): a turn that's ACTIVELY STREAMING (running, with text already
                        // arriving) keeps the response view rather than yanking it away for an
                        // empty composer.
                        turnRunning: session.state.turnRunning,
                        streamingText: session.state.streamingText
                    ) {
                        adapter.showingDraft = true
                    }
                case .window:
                    // Gate r7 (same-panel window morph): `presentWindowSurface()` flips
                    // `.field` → `.window` on the SAME panel — the window branch (`WindowSurfaceView`)
                    // renders off this SAME `adapter`, so the in-progress draft must survive the
                    // handoff untouched, not get stashed-and-cleared like a real collapse-to-orb
                    // (that happens on the `.orb` case when the window later collapses back). Nothing
                    // to reset here.
                    break
                }
            }
            .onChange(of: controller.exchangeIndex) { _, newValue in
                adapter.exchangeIndex = newValue
                // Wave-9 gate fix: swiping to a different historical exchange swaps in different
                // reply text entirely — start that reply scrolled to its top rather than
                // carrying over wherever the PREVIOUS exchange happened to be scrolled to.
                morphModel.responseScrollOffset = 0
            }
            .onChange(of: session.state.turnRunning) { _, running in
                if running {
                    // A NEW turn starting is the only reliable "browsing history is over" signal
                    // (v1 parity, ported from the pre-transplant `Field/FieldView.swift`) — the
                    // live/streaming reply takes the shell back over from whatever was pinned
                    // AND from the composer (showingDraft flip lost in the transplant: without it
                    // the shell stayed on the emptied composer and replies never appeared).
                    controller.resetExchangeIndex()
                    adapter.showingDraft = false
                    // Wave-9 gate fix: the new turn's reply starts empty and grows from the top —
                    // don't carry over a scroll offset from whatever the shell showed before.
                    morphModel.responseScrollOffset = 0
                    // Wave-3 gate item 2a: auto-collapse to the orb ONLY when this turn-start
                    // followed the field's own submit (`collapseOnTurnStart`, armed in
                    // `submit(_:)` below) — a turn that started for some other reason while the
                    // field happens to be open (e.g. summoned mid-turn to watch/steer) never
                    // arms the flag, so `consumeCollapseOnTurnStart()` returns false and nothing
                    // here collapses it. Always consume first (one-shot) so a stale arm never
                    // survives to affect a later, unrelated turn-start.
                    if controller.consumeCollapseOnTurnStart(), controller.surface == .field {
                        OrbDebug.log("auto-collapse on submit-turn")
                        controller.collapseToOrb()
                    }
                } else {
                    handleTurnCompleted()
                }
            }
            .onChange(of: session.state.exchanges.count) { _, newCount in
                // Session refocus/reset shrinks (or swaps) the history — a stale pin must not
                // survive pointing past the end of the (new, shorter) exchange list.
                if let index = controller.exchangeIndex, index >= newCount {
                    controller.resetExchangeIndex()
                }
            }
    }

    private func submit(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        // Wave-3 gate item 2a: captured BEFORE the send, not after awaiting it — by the time the
        // await returns, `session.state.turnRunning` may already reflect a `turn_started` event
        // that arrived during the round trip, which would make an idle-at-submit-time check
        // unreliable. `wasIdle` distinguishes a genuine new-turn submit (arms auto-collapse) from
        // a mid-turn steer (must NOT arm it — the user has the field open to watch/steer, and no
        // false→true flip will even occur for a steer, but a stale arm here could otherwise
        // survive to wrongly auto-collapse a LATER, unrelated turn-start).
        let wasIdle = !session.state.turnRunning
        Task { @MainActor in
            if await controller.onSubmit?(text) == true {
                adapter.composerDraft = ""
                draftCache.clear()
                // A successful send means the user is composing again, not browsing — drop any
                // swipe-pinned historical exchange so the shell is free to pick up the new
                // turn's reply (belt-and-suspenders alongside the turnRunning-flip reset above:
                // this fires the instant success is known, not only once `turn_started` lands).
                controller.resetExchangeIndex()
                if wasIdle {
                    controller.collapseOnTurnStart = true
                }
            }
            // failure: text stays in the composer — the draft is never lost (spec §6)
        }
    }

    /// Wave-3 gate item 2b/2c: a turn just finished (`session.state.turnRunning` flipped to
    /// `false`). Only relevant while collapsed — an already-expanded field is already showing
    /// whatever the shell settles on (the composer-vs-response logic elsewhere handles that);
    /// there is nothing extra to arrive for a field the user is already looking at.
    private func handleTurnCompleted() {
        guard controller.surface == .orb else { return }
        let cliAttachedToFocused = session.state.cliAttached
        let frontmostIsTerminal = frontmostApplicationIsTerminal()
        // orb-scope Part 2: was the turn that just finished initiated by THIS orb's own submit
        // path, or somewhere else (the phone's dispatch mode, a scheduled routine)? See
        // `SessionModel.lastTurnWasOrbInitiated`'s doc for the daemon-carried `clientName` signal
        // this reads.
        let orbInitiated = session.state.lastTurnWasOrbInitiated
        // gate-feedback-1 FIX A: suppressed OUTRIGHT — no expand, no unread-blink either — when a
        // CLI harness is attached to THIS orb's own focused session AND the frontmost app is a
        // terminal. Rationale: the user is chatting with this exact session from their terminal
        // right now, so the reply is already visible there; auto-expanding the orb (or even
        // flipping the passive unread-blink) on top of that is pure noise. Checked BEFORE the
        // hidden-panel branch below so it also suppresses THAT branch's `hasUnread` flip, not just
        // the visible-panel calm-gate. Manual summon (`OrbWindowController.toggleField()` — 4-finger
        // tap / hotkey / menu, `AppDelegate.swift`) never calls this method at all, so it is
        // completely unaffected by this guard.
        //
        // orb-scope Part 2: `isAutoRevealSuppressed` now ORs a SECOND, independent reason in
        // (`!orbInitiated`) — a dispatch turn started elsewhere never auto-expands either. The two
        // reasons diverge on the unread mark though: the CLI/terminal case is TOTAL silence
        // (unchanged from before Part 2 — nothing here even looks at `hasUnread`, exactly as
        // before), while a merely-not-orb-initiated turn has nothing else showing its reply on the
        // Mac, so the unread indicator must still fire — it's the user's only signal, per the
        // explicit product decision behind this fix. That distinction can't live inside the single
        // suppressed Bool the predicate returns (by design — the whole point of the predicate is
        // one testable outcome), so it's re-derived from the same two locals right below, not a
        // second suppression check.
        guard !isAutoRevealSuppressed(
            cliAttachedToFocused: cliAttachedToFocused,
            frontmostIsTerminal: frontmostIsTerminal,
            orbInitiated: orbInitiated
        ) else {
            // Minor 5 (orb-scope review): which of the two suppression reasons applies is now its
            // own extracted predicate (`suppressionMarksUnread`) instead of re-deriving
            // `cliAttachedToFocused && frontmostIsTerminal` inline here — see that function's doc.
            if suppressionMarksUnread(
                cliAttachedToFocused: cliAttachedToFocused,
                frontmostIsTerminal: frontmostIsTerminal,
                orbInitiated: orbInitiated
            ) {
                // Minor 4 (orb-scope review): only mark unread when there's actually reply text to
                // notify about — the SAME non-empty-reply gate the visible-panel expand path below
                // enforces (`hasReadableReply`). Without this, an interrupt/agent_error/tool-only
                // dispatch turn completing with no assistant text would still blink the orb over an
                // empty reply. Scoped to ONLY this not-orb-initiated path — the hidden-panel branch
                // just below is a DIFFERENT, pre-existing case (Final-review I1) with its own
                // legitimate reason to mark unread regardless of reply content (see its own doc);
                // left untouched.
                if hasReadableReply(in: session.state.exchanges) {
                    adapter.hasUnread = true
                    OrbDebug.log("answer arrived: suppressed (turn not orb-initiated) — marked unread")
                } else {
                    OrbDebug.log("answer arrived: suppressed (turn not orb-initiated) — reply empty, nothing to mark unread")
                }
            } else {
                OrbDebug.log("answer arrived: suppressed (CLI attached to focused session + frontmost terminal)")
            }
            return
        }
        // Final-review I1: never auto-expand a HIDDEN panel (menu "Hide Orb") — expanding an
        // ordered-out panel re-creates the b8e1f8b wedge (surface=.field while invisible, next
        // summon collapses instead of opening). A hidden orb marks the answer unread instead —
        // UNCONDITIONALLY (deliberately NOT gated on `hasReadableReply` below, unlike the
        // not-orb-initiated branch above): this fires only for a turn that IS orb-initiated (the
        // suppressed-branch guard above already returned otherwise), i.e. the user's own
        // summon→type→answer loop, just while the panel happens to be hidden — the hidden orb is
        // the user's ONLY signal that their own turn finished at all, so it must blink even on an
        // empty reply (Minor 4 (orb-scope review): read this branch before touching it; scope stays
        // the not-orb-initiated path only).
        guard controller.isVisible else {
            adapter.hasUnread = true
            return
        }
        guard hasReadableReply(in: session.state.exchanges) else { return }
        if controller.follower.isCursorCalm() {
            OrbDebug.log("answer arrived: expanding")
            controller.expandForAnswerReveal = true
            controller.expandToField()
        } else {
            OrbDebug.log("answer arrived: cursor busy → unread")
            adapter.hasUnread = true
        }
    }
}

/// gate-feedback-1 FIX A / orb-scope Part 2: the pure suppression table behind
/// `handleTurnCompleted()`'s auto-expand guard above, extracted so `AutoRevealSuppressionTests`
/// can drive it directly. Suppressed when EITHER holds:
///   - `!orbInitiated` (orb-scope Part 2): the turn that just completed wasn't started from this
///     orb's own submit path (phone dispatch, a scheduled routine, ...) — auto-reveal is reserved
///     for the user's own summon→type→answer loop, not turns they started somewhere else.
///   - BOTH `cliAttachedToFocused` and `frontmostIsTerminal` (gate-feedback-1 FIX A, pre-existing,
///     untouched): a CLI harness attached to the orb's focused session is not enough on its own
///     (the user might be looking at something else entirely), and a terminal being frontmost is
///     not enough on its own (nothing attached there means no redundant reply visible) — only
///     together do they mean the reply is already visible in the terminal chat.
func isAutoRevealSuppressed(cliAttachedToFocused: Bool, frontmostIsTerminal: Bool, orbInitiated: Bool) -> Bool {
    !orbInitiated || (cliAttachedToFocused && frontmostIsTerminal)
}

/// Minor 5 (orb-scope review): the pure predicate behind `handleTurnCompleted()`'s
/// suppressed-branch decision of WHICH of the two suppression reasons applies — extracted because
/// it used to duplicate half of `isAutoRevealSuppressed`'s own formula
/// (`cliAttachedToFocused && frontmostIsTerminal`) inline at the call site: if that clause ever
/// changed, the truth-table tests over `isAutoRevealSuppressed`/`shouldAutoExpand` would stay green
/// while the inline copy silently drifted out of sync. Call ONLY when
/// `isAutoRevealSuppressed(cliAttachedToFocused:frontmostIsTerminal:orbInitiated:)` is already true
/// for these same three inputs (the two truth tables are meant to travel together — this stays a
/// plain pure function rather than asserting that precondition, mirroring
/// `isAutoRevealSuppressed`'s own shape). Returns:
///   - `false` — total silence, no expand AND no unread-blink (the CLI/terminal case,
///     gate-feedback-1 FIX A, unchanged since before orb-scope Part 2): the reply is already visible
///     in the user's own terminal chat, so even the passive blink would be noise.
///   - `true` — everywhere else, i.e. whenever suppression is due to `!orbInitiated` (a dispatch
///     turn started elsewhere): nothing else on the Mac shows the reply, so the unread indicator is
///     the user's only signal (still further gated by `hasReadableReply` at the call site — Minor
///     4 — there is no separate reply-emptiness dimension in THIS predicate).
func suppressionMarksUnread(cliAttachedToFocused: Bool, frontmostIsTerminal: Bool, orbInitiated: Bool) -> Bool {
    !(cliAttachedToFocused && frontmostIsTerminal)
}

/// Minor 4 (orb-scope review): true when the most recently completed exchange actually has reply
/// text — false for an interrupt/agent_error/tool-only turn whose reply never arrived. Extracted so
/// both `handleTurnCompleted()` call sites that need "is there anything to notify about" (the
/// not-orb-initiated unread mark, and the pre-existing visible-panel expand guard) share the exact
/// same check instead of re-deriving the optional-chain inline at each site, and so it is directly
/// unit-testable (`[Exchange]` is a plain value array — no SwiftUI/AppKit environment needed).
func hasReadableReply(in exchanges: [Exchange]) -> Bool {
    !(exchanges.last?.reply.isEmpty ?? true)
}

/// gate-feedback-1 FIX A: `shouldAutoExpand` composes the suppression table above with the
/// pre-existing calm-gate (`OrbFollower.isCursorCalm()`) into the single boolean
/// `handleTurnCompleted()`'s calm-check used to branch on — kept as its own pure function (rather
/// than inlining `!isAutoRevealSuppressed(...) && calm`) so a test can assert the composed
/// decision directly without re-deriving the `&&`. Suppression wins outright: `calm` is never even
/// consulted once suppressed.
func shouldAutoExpand(calm: Bool, cliAttachedToFocused: Bool, frontmostIsTerminal: Bool, orbInitiated: Bool) -> Bool {
    guard !isAutoRevealSuppressed(cliAttachedToFocused: cliAttachedToFocused, frontmostIsTerminal: frontmostIsTerminal, orbInitiated: orbInitiated) else {
        return false
    }
    return calm
}

/// GATE-3 FIX (round 3, F4) — the summon home-state rule, extracted pure so it's unit-testable
/// (`SummonHomeStateTests`): on every orb→field expand the COMPOSER is the home state (v1
/// semantics — the response occupies the shell only after a submit / while streaming), EXCEPT
/// when a turn is actively streaming (running with reply text already arriving), in which case
/// the in-flight response keeps the shell. `turnRunning` alone (no streamed text yet — the
/// shimmer-only "thinking" state) still summons into the composer: nothing readable would be
/// yanked away, and the user summoning mid-think almost certainly wants to type.
func summonShowsComposer(turnRunning: Bool, streamingText: String) -> Bool {
    !(turnRunning && !streamingText.isEmpty)
}
