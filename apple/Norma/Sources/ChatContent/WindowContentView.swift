import SwiftUI
import NormaKit

/// The chat window's content column — header (optional leading accessory + status), transcript,
/// pinned tasks, queued line, composer. Shared by the MORPH window (which injects its self-drawn
/// `MacTrafficLights`) and DETACHED windows (native chrome — no accessory, extra top inset for the
/// native titlebar via `topInset`).
///
/// Extracted verbatim from `WindowSurfaceView.windowContent(finalRect:)` — the traffic lights slot
/// generalizes to `headerAccessory`, and the hardcoded top padding (14) generalizes to `topInset`.
struct WindowContentView<Accessory: View>: View {
    @ObservedObject var adapter: FieldStateAdapter
    let tint: Color
    let topInset: CGFloat
    /// 2e-iii Task 6: the width-responsive sidebar wiring. `nil` → today's exact zero-sidebar
    /// layout (the `body` guard clause below); both window construction sites pass a value.
    /// Declared BEFORE `headerAccessory` so the memberwise init keeps the `@ViewBuilder` accessory
    /// last (the two call sites pass it as a trailing closure).
    let sidebars: SidebarWiring?
    /// The session's mode, which OPTS THIS SURFACE INTO the shared composer card
    /// (`NormaComposerCard`). `nil` keeps the plain 88 pt `ComposerTextView` this view has always
    /// rendered.
    ///
    /// Opt-in rather than global (2026-08-07) because this view has THREE homes and they are not
    /// alike: the shell's chat page (which wants the card), the detached window, and the ORB's
    /// morph window — and that last one is a glass surface under the difference-blend law, where a
    /// cream card would read as broken. Only the shell passes a mode today; the other two keep
    /// what they have until someone decides otherwise on purpose.
    ///
    /// It carries the MODE as well as the opt-in because the mode IS the composer: since
    /// mac-chat-parity Task 5 each mode has its own dedicated composer (`ComposerChrome.swift`) and
    /// this value is what picks it. A chat session's carries no permissions band; a code or dispatch
    /// session's carries one (mac-chat-parity Task 6, spec §4 — `composerCard` below wires it);
    /// neither shows the Chat/Cowork segment, which belongs to the two modes it names.
    var composerCardMode: SessionMode? = nil
    @ViewBuilder let headerAccessory: () -> Accessory

    /// Task 4 (2d-iii): the ⋯ menu's popover presentation state — local to this view (not the
    /// adapter), same convention as any other purely-presentational SwiftUI `@State` here; the
    /// adapter only owns the DATA the menu reads/writes (`sessionPolicy`/`policyChangeInFlight`).
    @State private var showingPolicyMenu = false

    /// Task 10 (Chat Slice D): the model menu's own popover presentation state — same local,
    /// presentational-only convention as `showingPolicyMenu` above (a separate flag: the two menus
    /// are independent popovers, never shown together off one boolean).
    @State private var showingModelMenu = false

    /// provider-correctness T6: the effort menu's own popover state — a THIRD independent flag, same
    /// reasoning as `showingModelMenu` being separate from `showingPolicyMenu`: model and effort are
    /// independent affordances and must never open off one boolean.
    @State private var showingEffortMenu = false

    /// working-directories T8: the working-folders chip's own popover state — a FOURTH independent
    /// flag, same reasoning again. Internal (not `private`) so `WorkingDirsMenu.swift`'s
    /// cross-file `extension WindowContentView` can bind it, the same access widening
    /// `currentSidebarSessionSummary`/`policyPickerRow` already carry for the WorkSidebar split.
    @State var showingDirsMenu = false

    /// app-shell T3: the `/background` affordance's own popover state — a FIFTH independent flag,
    /// same reasoning as the four above. Internal (not `private`) for the same reason
    /// `showingDirsMenu` is: `ActivityMenu.swift`'s cross-file `extension WindowContentView` binds it.
    @State var showingActivityMenu = false

    /// Task 3 (2e-i): whether the "… +N completed" tail is expanded to the full completed list.
    /// Local presentational state, same convention as `showingPolicyMenu` above — resets whenever
    /// this view is recreated (e.g. a new session), which is fine: there's nothing worth
    /// preserving about a stale expand/collapse choice across sessions.
    @State private var expandedCompleted = false

    /// Task 6 (2e-iii): the outer container's measured width, fed by `.onGeometryChange` (2c lesson:
    /// NEVER GeometryReader-in-ScrollView). `0` until the first layout pass — treated as "not yet
    /// measured" (no sidebars resolved) so a stale zero never briefly opens the right overlay.
    @State private var measuredWidth: CGFloat = 0
    /// Task 6 (2e-iii): the raw sidebar flags the width engine (`resolveSidebars`) resolves against
    /// `measuredWidth`. gate-feedback-1 FIX B: BOTH default to EXPANDED (the left session switcher
    /// previously defaulted collapsed) — so each appears INLINE the moment the width fits it, and
    /// collapses to a CHEVRON (never an auto-overlay) when it doesn't. Below the both-fit width
    /// (`sidebarLayout`'s `resolveSidebars`) mutual exclusion still applies with the right winning
    /// ties, so a narrower window still shows at most one side even with both flags true — see
    /// `SidebarLayoutTests`' "default state" pins. Overlays are tap-only: `overlayOpen` is set
    /// solely by a chevron tap on a side that can't fit inline, and cleared on dismiss / once it
    /// fits inline.
    @State private var sidebar = SidebarState(leftExpanded: true, rightExpanded: true,
                                              leftOverlayOpen: false, rightOverlayOpen: false)

    var body: some View {
        // `sidebars == nil` → today's exact layout, byte-identical: `contentColumn(rightVisible:
        // false)` re-adds `&& !false` (== `&& true`) to the two relocation gates, a no-op.
        if let sidebars {
            sidebarLayout(sidebars)
        } else {
            contentColumn(rightVisible: false)
        }
    }

    /// The chat window's content column (header → transcript → pending cards → pinned tasks →
    /// queued line → composer → subagents). `rightVisible` is the RELOCATION gate: when the right
    /// WorkSidebar is showing, the pinned-tasks and subagent sections move THERE — this column drops
    /// them (`&& !rightVisible`) so they're never duplicated.
    @ViewBuilder
    private func contentColumn(rightVisible: Bool) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                headerAccessory()
                Text(adapter.statusText)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                // working-directories T8: the working-folders chip. Its gate is the DAEMON's own
                // participation answer (`dirs != nil` — see `dirsMenuIsVisible`), not a mode list
                // mirrored on this side: a chat/dispatch window gets no chip because `session.list`
                // populated no set for it, and a workdir-less code session (`[]`) DOES get one,
                // since that is exactly the session that needs the adopt door.
                if dirsMenuIsVisible(currentSidebarSessionSummary?.dirs) {
                    dirsMenuButton
                }
                // app-shell T3: the `/background` affordance. Gated the same way the folders chip
                // is — on the DAEMON's own answer for this row (its derived `activity`, absent for
                // a session with no lifecycle) — plus the wiring gate: a surface that never wired
                // `onSetActivity` renders nothing here at all (`backgroundVerbForCurrentSession`).
                if let verb = backgroundVerbForCurrentSession {
                    backgroundVerbButton(verb)
                }
                // Task 10 (Chat Slice D): the model menu — deliberately the OPPOSITE gate from the
                // policy button just below (`modelMenuIsVisible`'s own doc comment explains the
                // asymmetry: chat hides POLICY but shows MODEL). Placed beside the policy button,
                // same header slot, same plain-icon-button idiom.
                if modelMenuIsVisible(isChatSession: adapter.isChatSession) {
                    modelMenuButton
                }
                // provider-correctness T6: the effort menu, beside the model menu — the OTHER axis
                // ("effort and model are two different things, just like the CLI"), and the only
                // surface on the Mac through which a Norma-level tier is reachable at all.
                if effortMenuIsVisible(isChatSession: adapter.isChatSession) {
                    effortMenuButton
                }
                // Plan-immunity (2026-07-28 design): chat's approval policy is fixed and can never
                // be changed — the picker behind this button is meaningless (and every row's
                // onSetPolicy call would now come back as an RPC error) for a chat-pinned window, so
                // it's hidden entirely rather than shown-but-broken. Every OTHER mode is unaffected
                // (`adapter.isChatSession` defaults `false` and only a `DetachedWindowController`
                // pinned to a `mode:"chat"` session ever sets it true).
                if !adapter.isChatSession {
                    policyMenuButton
                }
            }
            .frame(height: chatWindowHeaderHeight)

            // mac-chat-parity Task 3: the approval/question/plan cards used to be a pinned band
            // MOUNTED HERE, between the transcript and the pinned-tasks section, and deleted the
            // instant the ask resolved — so the Mac kept no record anywhere in scrollback of
            // anything the user had approved or answered. They render inside the transcript now, at
            // the point they were asked, and freeze there with their outcome; this view's job is
            // reduced to handing the transcript the respond wiring the band used to hold. Both
            // windows (the morph window's `.window` surface and every native
            // `DetachedWindowController`) get it, since both render this shared view.
            TranscriptView(adapter: adapter, tint: tint, cardWiring: InteractionCardWiring(
                inFlight: adapter.interactionInFlight,
                errorLines: adapter.interactionErrors,
                // panel-shell T10b: `adapter.pendingCardDraftBinding` closes over `adapter` itself
                // (an `@ObservedObject` this view already holds live), so every Binding it mints —
                // across however many times SwiftUI reconstructs this whole call site — reads/writes
                // the SAME externally-owned dictionary. That external ownership is what lets a
                // card's typed-but-unsubmitted answer survive `ShellRootView`'s `.maximized`
                // teardown of `detail`, and now also the transcript's own `LazyVStack` recycling a
                // card that scrolls out of view.
                draftBinding: { callId in adapter.pendingCardDraftBinding(for: callId) },
                onApproval: adapter.onApprovalRespond,
                onQuestion: adapter.onQuestionRespond,
                onPlan: adapter.onPlanRespond
            ))
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if !adapter.pinnedTasks.isEmpty && !rightVisible {
                pinnedTasksSection(adapter.pinnedTasks)
            }

            if let queued = adapter.queuedText {
                Text(queued).font(.system(size: 11)).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let card = composerCard {
                card.frame(maxWidth: .infinity)
            } else {
                ComposerTextView(
                    text: adapter.draftBinding,
                    onSubmit: { adapter.onSubmit(adapter.composerDraft) },
                    usesAdaptiveColors: true
                )
                .frame(height: 88)
            }

            if !adapter.liveSubagents.isEmpty && !rightVisible {
                subagentSection(adapter.liveSubagents)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, topInset)
        .padding(.bottom, 16)
    }

    /// The SHARED composer card (user call, 2026-08-07: the live page's composer "should be the same
    /// as the one of the new chat page"), or `nil` for a surface that opted into no card — the
    /// detached window and the orb's morph window, which keep the plain `ComposerTextView` below on
    /// the ruling `composerCardMode`'s own doc records.
    ///
    /// Its strip emerges from the TOP here: this composer sits at the bottom of the window, where
    /// "below" is off-screen. The mode segment is NOT selectable — a session's mode is fixed at
    /// creation and Norma has no mode-switch, so a live segment would offer something it cannot do.
    ///
    /// `policy` is what makes the permissions row a control (mac-chat-parity Task 6, spec §4): the
    /// adapter's own seeded/healed policy plus its known-ness, so the band shows what the DAEMON
    /// reports for this session and shows nothing at all until it has said. Chat and cowork ignore
    /// it — a mode's chrome decides whether it has a band (`ComposerChrome.swift`).
    ///
    /// **Hoisted out of `contentColumn` for the tests' sake, and it is the point of the hoist:** the
    /// whole path from this view's adapter to the rendered row is a value here, so "the shell's card
    /// carries this session's real policy" is assertable without rendering anything. Pinning the
    /// adapter's rule alone would have left a card that wired no policy at all completely green —
    /// this plan's own Task 4 mutation lesson.
    var composerCard: NormaComposerCard? {
        guard let cardMode = composerCardMode else { return nil }
        return NormaComposerCard(
            text: adapter.draftBinding,
            onSubmit: { adapter.onSubmit(adapter.composerDraft) },
            mode: .constant(cardMode),
            modeIsSelectable: false,
            policy: adapter.composerPolicyControl,
            stripEdge: .above,
            sendBlockedReason: adapter.composerDraft
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : nil
        )
    }

    // MARK: - Task 6 (2e-iii): width-responsive sidebar layout

    /// Wraps `contentColumn` in the HStack of inline sidebars + a ZStack of edge chevrons and
    /// overlay panels. The Task-4 width engine (`resolveSidebars`) decides, off `measuredWidth`,
    /// which sides are inline vs overlay vs hidden; below the both-fit width AT MOST ONE side shows
    /// (mutual exclusion, right-first). `measuredWidth == 0` (pre-first-layout) resolves to nothing
    /// visible so a stale zero never flashes the right overlay open.
    @ViewBuilder
    private func sidebarLayout(_ sidebars: SidebarWiring) -> some View {
        // app-shell T3: the surface's configuration is applied to the RAW flags first — a right-only
        // surface (the shell, which brings its own outer session switcher) hands the engine
        // `leftExpanded: false`, so the left column can resolve neither inline nor as an overlay at
        // any width. The default configuration is the identity (`sidebarStateForConfiguration`), so
        // the two pre-existing surfaces feed `resolveSidebars` byte-identical inputs.
        let state = sidebarStateForConfiguration(sidebar, showsSessionSwitcher: sidebars.showsSessionSwitcher)
        let resolved = measuredWidth > 0
            ? resolveSidebars(width: measuredWidth,
                              leftExpanded: state.leftExpanded, rightExpanded: state.rightExpanded,
                              leftOverlayOpen: state.leftOverlayOpen, rightOverlayOpen: state.rightOverlayOpen)
            : EffectiveSidebars(leftVisible: false, rightVisible: false, leftOverlay: false, rightOverlay: false)
        ZStack {
            HStack(spacing: 0) {
                if resolved.leftVisible && !resolved.leftOverlay {
                    sessionSidebarColumn(sidebars)
                    Divider()
                }
                contentColumn(rightVisible: resolved.rightVisible)
                if resolved.rightVisible && !resolved.rightOverlay {
                    Divider()
                    workSidebarColumn
                }
            }

            // Edge chevron affordances for the sides that are NOT effectively visible. Tapping one
            // FORCE-OPENS its side in a single tap (CARRIED ITEM 1 — see `openLeftViaChevron`).
            HStack(spacing: 0) {
                // The left chevron is the one affordance that renders when the side is NOT visible,
                // so it needs the configuration gate explicitly: a right-only surface has no left
                // column to open, and an edge chevron that opens nothing is worse than no chevron.
                if !resolved.leftVisible && sidebars.showsSessionSwitcher {
                    sidebarChevron("chevron.right") {
                        sidebar = openLeftViaChevron(sidebar, width: measuredWidth)
                    }
                }
                Spacer(minLength: 0)
                if !resolved.rightVisible {
                    sidebarChevron("chevron.left") {
                        sidebar = openRightViaChevron(sidebar, width: measuredWidth)
                    }
                }
            }

            // Overlay panels + a tap-to-dismiss scrim BEHIND each (the scrim is added first so the
            // `.ultraThinMaterial` panel draws over it; the panel slides in from its edge).
            if resolved.leftOverlay {
                sidebarScrim { sidebar = dismissLeftOverlay(sidebar) }
                HStack(spacing: 0) {
                    sessionSidebarColumn(sidebars).background(.ultraThinMaterial)
                    Spacer(minLength: 0)
                }
                .transition(.move(edge: .leading))
            }
            if resolved.rightOverlay {
                sidebarScrim { sidebar = dismissRightOverlay(sidebar) }
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    workSidebarColumn.background(.ultraThinMaterial)
                }
                .transition(.move(edge: .trailing))
            }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { newWidth in
            measuredWidth = newWidth
            // Width growth makes an open overlay obsolete: once a side FITS INLINE it renders inline
            // (its `expanded` flag drives that — set true when the overlay was tap-opened), so drop
            // the now-irrelevant `overlayOpen`. Otherwise a later shrink back below the fit width
            // would silently re-open the overlay. Overlays are honored ONLY while the side does NOT
            // fit inline (see `resolveSidebars`), so clearing here is the simplest correct wiring.
            if newWidth >= sidebarContentMinWidth + sidebarLeftWidth { sidebar.leftOverlayOpen = false }
            if newWidth >= sidebarContentMinWidth + sidebarRightWidth { sidebar.rightOverlayOpen = false }
        })
        .animation(.easeInOut(duration: 0.18), value: resolved)
    }

    /// The left session-switcher column, aligned to the content's top inset. `SessionSidebar` owns
    /// its own `.frame(width: sidebarLeftWidth)`.
    private func sessionSidebarColumn(_ sidebars: SidebarWiring) -> some View {
        SessionSidebar(
            directory: sidebars.directory,
            currentSessionId: sidebars.currentSessionId(),
            onSelect: sidebars.onSelect,
            onOpenDetached: sidebars.onOpenDetached,
            onNewSession: sidebars.onNewSession,
            rowFilter: sidebars.rowFilter,
            onSummonApp: sidebars.onSummonApp
        )
        .padding(.top, topInset)
    }

    /// The right work column (`workSidebar` owns its own width). Top-inset-aligned like the left.
    private var workSidebarColumn: some View {
        workSidebar.padding(.top, topInset)
    }

    /// A full-height 16pt-wide edge chevron (`.secondary`), the hit-target for opening a hidden
    /// side. gate-feedback-1 FIX C: the GLYPH is now top-anchored (`sidebarChevronTopOffset` below
    /// `topInset`) instead of vertically centered — visual only, the hit target itself still spans
    /// the FULL column height (`.frame(maxHeight: .infinity, alignment: .top)` + `.contentShape`
    /// covers the same full-height/16pt-wide rectangle as before; only where the icon renders
    /// within it moved).
    private func sidebarChevron(_ systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.top, topInset + sidebarChevronTopOffset)
                .frame(width: 16)
                .frame(maxHeight: .infinity, alignment: .top)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Near-invisible full-frame tap catcher behind an open overlay — tapping outside the panel
    /// dismisses it. `0.001` opacity so it hit-tests without visibly dimming the content.
    private func sidebarScrim(_ dismiss: @escaping () -> Void) -> some View {
        Color.black.opacity(0.001)
            .contentShape(Rectangle())
            .onTapGesture(perform: dismiss)
    }

    /// Task 4 (2d-iii): the header's trailing ⋯ button — opens `policyMenuContent`'s popover.
    /// Plain-styled (no button chrome) to sit quietly in the header row next to the status text.
    @ViewBuilder
    private var policyMenuButton: some View {
        Button {
            showingPolicyMenu = true
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingPolicyMenu, arrowEdge: .bottom) {
            policyMenuContent
        }
    }

    /// The ⋯ menu's first (and currently only) item: an inline six-mode picker (SP-policies Task
    /// 14 — `sessionPolicyModes`: plan/dont-ask/ask/accept-edits/auto/bypass, restrictiveness
    /// order) for `adapter.sessionPolicy` — a checkmark marks the current value, rows disable
    /// while `adapter.policyChangeInFlight` (a change is already in flight; mirrors the
    /// pending-card buttons' own in-flight disable). Selecting a row fires `adapter.onSetPolicy`
    /// directly — the wirer (`GlassRootView`/`DetachedWindowController`) owns the
    /// in-flight/success bookkeeping, same convention as the three respond callbacks' card
    /// buttons.
    @ViewBuilder
    private var policyMenuContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Approval mode")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
            // Task 6 (2e-iii): the row body is shared with the WorkSidebar's Options block — and,
            // since mac-chat-parity T6, with the composer's permissions row — via `PolicyPickerRow`
            // (WorkSidebar.swift). One implementation for all three; `policyPickerRow(_:)` is this
            // view's forwarder, handing it this adapter's own values.
            ForEach(sessionPolicyModes, id: \.self) { policy in
                policyPickerRow(policy)
            }
        }
        .padding(12)
        .frame(minWidth: 160)
    }

    // MARK: - Task 10 (Chat Slice D): the header's model menu — `session.setModel`, ALL modes

    /// The header's model-menu button — opens `modelMenuContent`'s popover. Same plain-icon-button
    /// idiom as `policyMenuButton` above (brief: "same control style/placement conventions as the
    /// policy picker") — a different glyph ("cpu") so the two affordances are visually distinct.
    @ViewBuilder
    private var modelMenuButton: some View {
        Button {
            // T6: a snapshot, refreshed exactly when it is about to be read.
            adapter.onRefreshModelCatalogue()
            showingModelMenu = true
        } label: {
            Image(systemName: "cpu")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingModelMenu, arrowEdge: .bottom) {
            modelMenuContent
        }
    }

    /// The model menu's rows: "Default" (clears the override, `nil`) first, then every slug the
    /// SYNCED CATALOGUE reports (`modelPickerOptions`) — a checkmark on whichever matches the
    /// session's CURRENT selection, which is the optimistic overlay when one is pending and the
    /// daemon's own row otherwise (`effectiveSelection`). Read once per popover render, same "read
    /// fresh at render" convention `sidebarSessionInfo` uses for title/scope/cwd.
    ///
    /// An UNLISTED current model still gets a row of its own — a stale slug from a provider change
    /// is still the thing this session is pinned to, and a selection the user cannot see is a
    /// selection they cannot clear.
    @ViewBuilder
    private var modelMenuContent: some View {
        let current = effectiveSelection(row: currentSidebarSessionSummary?.model, optimistic: adapter.pendingModel)
        let options = modelPickerOptions(adapter.modelCatalogue)
        VStack(alignment: .leading, spacing: 2) {
            Text("Model")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
            modelPickerRow(nil, current: current)
            ForEach(options, id: \.self) { model in
                modelPickerRow(model, current: current)
            }
            if let current, !options.contains(current) {
                modelPickerRow(current, current: current)
            }
        }
        .padding(12)
        .frame(minWidth: 160)
    }

    /// One model-menu row — `model: nil` is the "Default" row (clears the override). Selecting a row
    /// applies OPTIMISTICALLY (the overlay flips before the RPC) and fires `adapter.onSetModel`;
    /// the wirer owns the in-flight flag, the revert, and the probation, same "the wirer owns the
    /// bookkeeping" convention as `policyPickerRow`.
    @ViewBuilder
    private func modelPickerRow(_ model: String?, current: String?) -> some View {
        Button {
            adapter.pendingModel = model.map { OptimisticSelection.value($0) } ?? .clear
            adapter.onSetModel(model)
            showingModelMenu = false
        } label: {
            HStack {
                Text(modelDisplayLabel(model))
                Spacer()
                if selectionIsCurrent(model, current: current) {
                    Image(systemName: "checkmark")
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(adapter.modelChangeInFlight)
        .padding(.vertical, 4)
    }

    // MARK: - provider-correctness T6: the header's effort menu — `session.setEffort`

    /// Same plain-icon-button idiom as the model/policy buttons, a different glyph ("gauge") so the
    /// three affordances stay visually distinct.
    @ViewBuilder
    private var effortMenuButton: some View {
        Button {
            // T6: a snapshot, refreshed exactly when it is about to be read.
            adapter.onRefreshModelCatalogue()
            showingEffortMenu = true
        } label: {
            Image(systemName: "gauge.with.dots.needle.33percent")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingEffortMenu, arrowEdge: .bottom) {
            effortMenuContent
        }
    }

    /// The effort menu: "Default", then the WIRE levels the session's model accepts, then — only for
    /// a CODE session whose model the catalogue actually lists — the Norma-level tiers, under their
    /// own heading. The two sections are never merged (see `effortPickerOptions`), and the tier
    /// section is simply ABSENT rather than shown-and-refused in both cases it does not apply:
    /// chat/dispatch, and a catalogue that reported no wire levels at all (a BYOK Mac, or nothing
    /// fetched yet — whole-branch review I1). In that second case the menu is "Default" alone, which
    /// is the honest rendering of "this daemon has told me nothing about efforts for this model".
    /// A tier the user ALREADY pinned still gets its row via the `.unknown` branch below, so a
    /// selection made before the catalogue emptied out stays visible and clearable.
    @ViewBuilder
    private var effortMenuContent: some View {
        let row = currentSidebarSessionSummary
        let current = effectiveSelection(row: row?.effort, optimistic: adapter.pendingEffort)
        let opts = effortPickerOptions(catalogue: adapter.modelCatalogue,
                                       model: effectiveSelection(row: row?.model, optimistic: adapter.pendingModel),
                                       mode: row?.mode)
        VStack(alignment: .leading, spacing: 2) {
            Text("Reasoning effort")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
            effortPickerRow(nil, current: current)
            ForEach(opts.wire, id: \.self) { level in
                effortPickerRow(level, current: current)
            }
            if !opts.tiers.isEmpty {
                Text("Norma")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
                    .padding(.bottom, 4)
                ForEach(opts.tiers, id: \.self) { tier in
                    effortPickerRow(tier, current: current)
                }
            }
            // A current selection in NEITHER list still needs a row — see `selectionOrigin`.
            if selectionOrigin(current, wire: opts.wire, tiers: opts.tiers) == .unknown, let current {
                effortPickerRow(current, current: current)
            }
        }
        .padding(12)
        .frame(minWidth: 180)
    }

    @ViewBuilder
    private func effortPickerRow(_ effort: String?, current: String?) -> some View {
        Button {
            adapter.pendingEffort = effort.map { OptimisticSelection.value($0) } ?? .clear
            adapter.onSetEffort(effort)
            showingEffortMenu = false
        } label: {
            HStack {
                Text(effortDisplayLabel(effort))
                Spacer()
                if selectionIsCurrent(effort, current: current) {
                    Image(systemName: "checkmark")
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(adapter.effortChangeInFlight)
        .padding(.vertical, 4)
    }

    /// LIVE-GATE G4, Task 3 (2e-i) redesign: the CC-tree-style pinned task list — blue bold `■`
    /// in_progress row (with a live elapsed suffix), dim `☐` pending rows, and `✓` completed rows
    /// pushed to the bottom and capped at 2 with a tappable "… +N completed" affordance. Hidden
    /// entirely when `adapter.pinnedTasks` is empty (the caller in `body` already gates on that).
    @ViewBuilder
    func pinnedTasksSection(_ tasks: [TaskItem]) -> some View {
        let built = buildTaskSection(tasks)
        VStack(alignment: .leading, spacing: 4) {
            Divider().opacity(0.5)
            // Expanded state rebuilds WITHOUT the 2-completed cap (brief: "rebuild without the
            // cap") rather than reusing `built.rows`, which is always capped.
            let displayedRows = expandedCompleted ? sortedTaskRows(tasks) : built.rows
            ForEach(displayedRows, id: \.id) { row in
                taskRowView(row, activeStartedTs: built.activeStartedTs)
            }
            if built.collapsedCompleted > 0 && !expandedCompleted {
                Text("… +\(built.collapsedCompleted) completed")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .onTapGesture { expandedCompleted = true }
            } else if expandedCompleted && built.collapsedCompleted > 0 {
                Text("… collapse")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .onTapGesture { expandedCompleted = false }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Norma blue for the single in_progress row — matches the brief's `Color(red:0.45,
    /// green:0.75, blue:1.0)`, distinct from the CLI's ANSI blue but the same role: draw the eye
    /// to what's actively running.
    private var taskInProgressBlue: Color { Color(red: 0.45, green: 0.75, blue: 1.0) }

    /// Row text color per the brief: in_progress → Norma blue, pending → `.secondary`,
    /// completed → `.tertiary` (the glyph itself is tinted separately — green for completed).
    private func rowTextStyle(_ status: String) -> AnyShapeStyle {
        switch status {
        case "in_progress": return AnyShapeStyle(taskInProgressBlue)
        case "completed": return AnyShapeStyle(.tertiary)
        default: return AnyShapeStyle(.secondary) // pending, or any unrecognized status
        }
    }

    /// Glyph color — same as the row text EXCEPT completed, whose `✓` is tinted green while its
    /// subject stays `.tertiary`.
    private func rowGlyphStyle(_ status: String) -> AnyShapeStyle {
        status == "completed" ? AnyShapeStyle(.green) : rowTextStyle(status)
    }

    @ViewBuilder
    private func taskRowView(_ row: TaskRow, activeStartedTs: Int?) -> some View {
        HStack(spacing: 6) {
            Text(taskGlyph(row.status))
                .foregroundStyle(rowGlyphStyle(row.status))
            Text(row.subject)
            if row.status == "in_progress", let startedTs = activeStartedTs {
                // D9: the periodic tick is mounted ONLY for the active row's elapsed suffix, and
                // only when there IS an active row with a startedTs — no idle ticking otherwise.
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    // max(0,…): startedTs is daemon-stamped; a small clock skew (or an event
                    // arriving "ahead") must never render a negative "-5s".
                    Text("· " + formatElapsed(max(0, Int(Date().timeIntervalSince1970 * 1000) - startedTs)))
                }
            }
        }
        .font(.system(size: 11))
        .fontWeight(row.status == "in_progress" ? .bold : nil)
        .foregroundStyle(rowTextStyle(row.status))
        .lineLimit(1)
        .truncationMode(.middle)
    }

    /// 2e-ii: the live subagent block — one row per child thread of the current turn, below the
    /// composer (2e-iii relocates it into the right sidebar when the window is wide). Working rows
    /// show a live active-time; queued rows show "waiting" (spawned but no SubagentManager slot
    /// yet — the timer deliberately does NOT run); done rows show their final active time and stay
    /// only while siblings are still alive (the adapter empties the list once ALL are done).
    /// NO token arrows here — tokens are CLI-only (spec §3).
    @ViewBuilder
    func subagentSection(_ items: [SubagentItem]) -> some View {
        let built = buildSubagentSection(items)
        VStack(alignment: .leading, spacing: 4) {
            Divider().opacity(0.5)
            ForEach(built.rows, id: \.threadId) { row in
                subagentRowView(row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func subagentRowStyle(_ status: String) -> AnyShapeStyle {
        switch status {
        case "working": return AnyShapeStyle(taskInProgressBlue)
        case "done": return AnyShapeStyle(.tertiary)
        default: return AnyShapeStyle(.secondary) // queued
        }
    }

    @ViewBuilder
    private func subagentRowView(_ row: SubagentItem) -> some View {
        HStack(spacing: 6) {
            Text(subagentGlyph(row.status))
                .foregroundStyle(row.status == "done" ? AnyShapeStyle(.green) : subagentRowStyle(row.status))
            Text(row.label)
            Text("(\(row.agentType))").foregroundStyle(.tertiary)
            if row.status == "working", let since = row.activeSince {
                // D9 twin: the 1s tick mounts ONLY on a working row with an open span.
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text("· " + formatElapsed(subagentActiveMs(activeMs: row.activeMs, activeSince: since, status: row.status, nowMs: Int(Date().timeIntervalSince1970 * 1000))))
                }
            } else if row.status == "queued" {
                Text("· waiting")
            } else if row.status == "done" {
                Text("· " + formatElapsed(row.activeMs))
            } else if row.status == "working" {
                // working but no open span (between child turns) — banked time, static.
                Text("· " + formatElapsed(row.activeMs))
            }
        }
        .font(.system(size: 11))
        .fontWeight(row.status == "working" ? .bold : nil)
        .foregroundStyle(subagentRowStyle(row.status))
        .lineLimit(1)
        .truncationMode(.middle)
    }
}

/// `TaskItem` (the session model's wire-shaped type) → Task 1's sorted `[TaskRow]`. Shared by
/// `buildTaskSection` and `pinnedTasksSection`'s expanded-state rebuild, so both read the SAME
/// sort order.
private func sortedTaskRows(_ tasks: [TaskItem]) -> [TaskRow] {
    sortTasksForDisplay(tasks.map { TaskRow(id: $0.id, subject: $0.subject, status: $0.status, activeForm: $0.activeForm, startedTs: $0.startedTs) })
}

/// Task 3 (2e-i): the pure decision behind `pinnedTasksSection` — SwiftUI's `body` isn't unit
/// testable, so the sort/collapse/active-row logic lives here where `WindowTaskSectionTests` can
/// drive it directly. Surfaces the in_progress row's `startedTs` as the live-elapsed timer's
/// anchor (`nil` when nothing is in_progress, so the caller mounts no `TimelineView` tick at
/// all — D9).
func buildTaskSection(_ tasks: [TaskItem]) -> (rows: [TaskRow], collapsedCompleted: Int, activeStartedTs: Int?) {
    let sorted = sortedTaskRows(tasks)
    let r = collapseCompleted(sorted)
    let active = sorted.first { $0.status == "in_progress" }
    return (r.rows, r.collapsedCompletedCount, active?.startedTs)
}

/// 2e-ii Task 4: pure decision behind `subagentSection` — rows in first-seen order; `anyWorking`
/// is the tick-mount gate (WindowSubagentSectionTests drives this directly).
func buildSubagentSection(_ items: [SubagentItem]) -> (rows: [SubagentItem], anyWorking: Bool) {
    (items, items.contains { $0.status == "working" })
}

// MARK: - Task 10 (Chat Slice D): the model picker's pure decisions — `ModelPickerTests` drives
// these directly, same "SwiftUI body isn't unit-testable, the decision behind it is" posture as
// `buildTaskSection`/`buildSubagentSection` above.

/// provider-correctness T6: the model menu's offered slugs, read from the SYNCED CATALOGUE
/// (`sync.config`'s `models`, reached through `NormaClient.syncConfig()` and held on
/// `FieldStateAdapter.modelCatalogue`).
///
/// This replaced a hardcoded three-slug Swift mirror of `CODEX_MODELS`. That mirror was wrong in a
/// way no test could catch: a picker cannot prove a slug it invented exists, and the daemon is the
/// side that already holds AND validates the list, so the daemon serves it. The identical mistake on
/// the phone — a derived lineup plus a mock effort list offering `ultra` — is what this whole plan
/// exists to remove.
///
/// **EMPTY IS A REAL ANSWER AND NEVER A LICENCE TO GUESS.** `[]` means the daemon reported no
/// catalogue: its provider cannot enumerate (an arbitrary openai-compatible endpoint — the same case
/// `session.setModel` handles by skipping its membership check), none is configured, or this client
/// has not fetched yet. The menu then offers the "Default" row alone. Substituting a remembered or
/// derived lineup is exactly the failure this field replaced.
func modelPickerOptions(_ catalogue: SyncConfigSnapshot) -> [String] {
    catalogue.models.map(\.id)
}

/// provider-correctness T6: the effort menu's two sections — WIRE levels for the session's model,
/// and NORMA-LEVEL tiers.
///
/// **TWO LISTS, NEVER ONE.** `models[].efforts` is exactly what the endpoint's request validator
/// accepts; a tier is exactly what it does not (the daemon translates `ultra` → `max` plus a
/// delegation posture before a request body exists). Concatenating them would make a picker offer a
/// level the turn would be 400'd on — the original bug, arriving through its own fix.
///
/// **THE MODE SCOPING IS THIS CLIENT'S OBLIGATION.** `sync.config` advertises `clientEfforts`
/// UNCONDITIONALLY, because a daemon serving a whole-device bootstrap cannot know which session a
/// picker is for. `session.setEffort` refuses a tier for anything but a code session, so offering
/// one on chat/dispatch would render rows whose every tap comes back an RPC error. `mode` is the
/// session row's own (`SessionSummary.mode`); ABSENT means code, the store-wide convention that
/// `clientEffortEligible` (packages/core/src/settings.ts) also applies — and this must stay an
/// allowlist, so a future mode nobody has written yet gets no tiers for free.
///
/// **AND SO IS THE NO-WIRE-LEVELS SCOPING** (whole-branch review I1). Unconditional advertisement
/// has a second consequence the mode gate does not cover: with an EMPTY `wire` list the menu
/// rendered "Default" and `ultra` and nothing else. That happens on any BYOK Mac — an arbitrary
/// openai-compatible endpoint cannot enumerate its models, so `models` is `[]` — and on any client
/// that has not fetched yet. `ultra` is the one value the daemon rewrites to `max`, the least
/// portable effort against an arbitrary endpoint, so the only real choice on offer was the worst
/// one, while the daemon itself would have accepted all six (`effortsForModel` is
/// provider-independent; the client was the only thing hiding them).
///
/// So: a daemon that has told us no wire levels has told us NOTHING about this model's efforts, and
/// a tier is not a substitute for the list we were not given. The same "empty is a real answer and
/// never a licence to guess" rule `modelPickerOptions` already keeps — the tier section was simply
/// exempt from it. Deliberately client-side and deliberately narrow: the honest fix is a
/// provider-independent effort list on `sync.config`, and this is not it.
func effortPickerOptions(catalogue: SyncConfigSnapshot, model: String?, mode: String?) -> (wire: [String], tiers: [String]) {
    // The session's EFFECTIVE model, by AgentEngine.resolveSel's own precedence: its override first,
    // the daemon's live default second. A model the catalogue doesn't list contributes no levels —
    // "I have not been told", not "none exist".
    let effective = model ?? catalogue.defaultModel
    let wire = catalogue.models.first { $0.id == effective }?.efforts ?? []
    // Both gates, and the sections stand or fall together: no wire list ⇒ no tier section either.
    let tiers = (!wire.isEmpty && effortTiersAreOffered(mode: mode)) ? catalogue.clientEfforts : []
    return (wire, tiers)
}

/// The mode gate above, as its own named symbol so `ModelPickerTests` can drive the rule directly
/// rather than only through a catalogue. CODE ONLY, absent == code, everything else refused — the
/// Swift mirror of `clientEffortEligible`.
func effortTiersAreOffered(mode: String?) -> Bool {
    mode == nil || mode == "code"
}

/// Whether a picker row is the CURRENT selection.
///
/// `SessionSummary.effort` may report a Norma-level TIER verbatim (`"ultra"`) rather than its wire
/// translation (`"max"`) — `SessionListResult`'s own doc comment says so explicitly — so matching
/// against the model's `efforts` array alone silently shows NO checkmark on a session whose effort
/// is a tier. Both lists, always.
func selectionIsCurrent(_ option: String?, current: String?) -> Bool {
    option == current
}

/// Where a current selection lives, for a picker that renders two sections. `nil` for "no override",
/// and `.unknown` for a value in NEITHER list — a stale slug from a provider change, or a tier a
/// daemon has stopped offering. Rendered as its own row rather than dropped: a selection the user
/// cannot see is a selection they cannot clear.
enum SelectionOrigin: Equatable { case none, wire, tier, unknown }

func selectionOrigin(_ current: String?, wire: [String], tiers: [String]) -> SelectionOrigin {
    guard let current else { return .none }
    if wire.contains(current) { return .wire }
    if tiers.contains(current) { return .tier }
    return .unknown
}

/// The model menu's current-selection LABEL — the row's `model` if set, else "Default" (brief's
/// own wording: labeled so the user can tell inherited-from-default apart from explicitly-pinned).
func modelDisplayLabel(_ model: String?) -> String {
    model ?? "Default"
}

/// The effort menu's current-selection LABEL — same "Default" wording and same reason as
/// `modelDisplayLabel` above: no override must READ as inherited-from-default, never as blank.
/// "Default" is deliberately NOT "none": an unset effort omits the request's `reasoning` block
/// entirely, while `"none"` is a real, distinct level the endpoint honours, and it appears in the
/// wire list as its own row.
func effortDisplayLabel(_ effort: String?) -> String {
    effort ?? "Default"
}

/// Visibility rule behind the effort-menu button — the same always-true asymmetry vs the policy
/// picker that `modelMenuIsVisible` documents, kept as its own symbol for the same reason: a
/// regression that copies `!isChatSession` here is then a one-line, obviously-wrong diff. Chat
/// sessions DO choose their effort (`session.setEffort` is mode-agnostic); what they may not choose
/// is a TIER, and that is `effortTiersAreOffered`'s job, not this one's.
func effortMenuIsVisible(isChatSession _: Bool) -> Bool {
    true
}

/// Visibility rule behind the model-menu button (`modelMenuButton`'s own `if` in `body` above) —
/// deliberately the OPPOSITE of the policy button's `!adapter.isChatSession` chat-hiding predicate:
/// chat hides POLICY (plan-immunity: the policy is fixed server-side, `engine.ts` resolves it to
/// the internal "chat" policy every turn regardless of the stored row, and the picker behind it
/// would be meaningless) but the MODEL stays user-choosable in chat — `session.setModel`'s own doc
/// comment (`ipc/server.ts`) is explicit that there is no "fixed model" concept for ANY mode, chat
/// included. Always `true` — kept as a named function (not an inlined literal in the view body) so
/// a regression that copies the policy predicate here is a one-line, obviously-wrong diff, and so
/// this asymmetry has a concrete symbol `ModelPickerTests` can assert against instead of nothing.
func modelMenuIsVisible(isChatSession _: Bool) -> Bool {
    true
}
