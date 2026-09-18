import SwiftUI
import WinterKit

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
    /// (`WinterComposerCard`). `nil` keeps the plain 88 pt `ComposerTextView` this view has always
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
    /// diff-tabs Task 9: **the first transcript→panel door, and it crosses this boundary as a plain
    /// closure.**
    ///
    /// A diff chip on an edit/write/notebook row calls it with its own `FileDiffRef`; the SHELL
    /// decides what that means (`ShellSessionHost.openDiffTab` — dedupe by `diffId`, else mint a
    /// `.diff` tab, and reveal the panel either way). Nothing in `ChatContent/` imports, names or
    /// knows about `ShellSessionHost`, `PanelStore` or the panel — pinned by a source scan
    /// (`ToolRowTests.testChatContentNeverReachesForTheShellHost`), because the natural shortcut
    /// here is to reach for the host directly and that shortcut is what would make this shared view
    /// unusable in its other two homes.
    ///
    /// **Opt-in, exactly like `composerCardMode` above, and for the same reason: this view has THREE
    /// homes and only one of them has a panel.** The shell's chat page passes it; the orb's morph
    /// window and every detached window do not, and their chips render as plain text (see
    /// `TranscriptDiffChip`) rather than as buttons that would do nothing.
    ///
    /// Declared BEFORE `headerAccessory` so the memberwise init keeps the `@ViewBuilder` accessory
    /// last — the same ordering constraint `sidebars`' own doc records.
    var onOpenDiff: ((FileDiffRef) -> Void)? = nil
    /// editor-product Task 6: **the SECOND transcript→panel door, crossing this boundary exactly
    /// like `onOpenDiff` immediately above.**
    ///
    /// A clickable path on a read/edit/write/notebook_edit row calls it with the path exactly as
    /// the row would draw it; the SHELL decides what that means
    /// (`ShellSessionHost.openFileOrDocumentTab` since office-plumbing Task 7 — dedupe by absolute
    /// path, mint a `.document` tab for an office extension or `.code` otherwise, reveal the panel
    /// either way). Nothing in `ChatContent/` imports, names or knows about `ShellSessionHost`,
    /// `PanelStore` or the panel — the SAME source-scan pin `onOpenDiff` is covered by
    /// (`ToolRowTests.testChatContentNeverReachesForTheShellHost`) is extended to name this door's
    /// own producer too.
    ///
    /// Same opt-in as `onOpenDiff`, for the same reason: `nil` on the orb's morph window and every
    /// detached window, where a clickable path would be a click that does nothing.
    var onOpenFile: ((String) -> Void)? = nil
    /// editor-product Task 6: **the row-level clickability gate's one dynamic input** — whether the
    /// ATTACHED session currently carries a working directory to resolve a RELATIVE path against
    /// (`ToolRunCallDetailText`/`toolDetailIsClickablePath`). An ABSOLUTE path is clickable
    /// regardless of this flag for a CODE extension (reads carry no path fence), so for those paths
    /// this only ever WIDENS what a relative path may do, never narrows an absolute one.
    ///
    /// **office-plumbing Task 7 correction: an office extension is the one exception.** It needs
    /// this flag `true` even when absolute — `toolDetailIsClickablePath`'s own doc, gate 4. Product
    /// policy, not a path-fence question: office rides working directories, so this flag NARROWS an
    /// absolute office path the way it always narrowed a relative one.
    ///
    /// A plain value, not a closure — like `composerCardMode` above and unlike `onOpenDiff`/
    /// `onOpenFile`: this answers a DISPLAY-time question ("what should this render as right now"),
    /// not a click-time one, so it needs no read-fresh-at-call-time discipline. The one call site
    /// that sets it true (`ShellSessionView`) recomputes it on every render from the live
    /// `directory.rows`, the same "read fresh from the directory" convention `composerCardMode`
    /// itself already follows.
    var sessionHasWorkingDirectory: Bool = false
    /// How far this view runs UP under a titlebar band it has been laid out beneath (2026-09-19,
    /// the shell only; zero everywhere else). The transcript then scrolls up under the band and
    /// fades out there instead of being cut at a hard line — the empty strip at the top of the page
    /// the user named. Everything else keeps its old position: it is offset by exactly this much.
    var topBleed: CGFloat = 0
    @ViewBuilder let headerAccessory: () -> Accessory






    /// Task 3 (2e-i): whether the "… +N completed" tail is expanded to the full completed list.
    /// Local presentational state, same convention as the other local presentational flags — resets whenever
    /// this view is recreated (e.g. a new session), which is fine: there's nothing worth
    /// preserving about a stale expand/collapse choice across sessions.
    @State private var expandedCompleted = false

    /// Task 6 (2e-iii): the outer container's measured width, fed by `.onGeometryChange` (2c lesson:
    /// NEVER GeometryReader-in-ScrollView). `0` until the first layout pass — treated as "not yet
    /// measured" (no sidebars resolved) so a stale zero never briefly opens the right overlay.
    @Environment(\.displayScale) private var displayScale
    /// The work panel's visibility — the titlebar toggle writes the same key (`ShellRootView`).
    @AppStorage(workPanelVisibleKey) private var workPanelVisible = true

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
    @State private var sidebar = SidebarState(leftExpanded: true, rightExpanded: false,
                                              leftOverlayOpen: false, rightOverlayOpen: false)

    /// Asks the user has CLOSED out of the composer (2026-08-13). Closing hands the composer back
    /// and returns that question to the transcript, where it stays pending and answerable — "not
    /// now", never "never", because the daemon is still waiting on a reply either way.
    ///
    /// View-local `@State`, deliberately: it is a presentation preference for THIS window, not an
    /// answer. A second window on the same session should still be offered the ask in its own
    /// composer, and a closed ask should come back on relaunch rather than staying hidden forever on
    /// the strength of one click. It also cannot go stale — a resolved ask leaves
    /// `pendingInteractions`, so a lingering id in here selects nothing.
    @State private var closedAsks: Set<String> = []

    var body: some View {
        Group {
            if let sidebars {
                sidebarLayout(sidebars)
            } else {
                pageColumns
            }
        }
        // Winter Phase 8d (Task 4.2, WS-13 §8.2); Winter Phase 10b (D1-4, W18-23): the lossy-switch
        // confirm dialog — ONE modifier on this shared view covers all three of
        // `WindowContentView`'s homes (the shell's live chat page, a detached window, the orb's
        // morph window), because `adapter.onSetModel`'s wiring at each of those homes populates the
        // SAME `adapter.pendingModelConfirmation` rather than each home drawing its own dialog.
        // "Switch anyway" resends through `adapter.onConfirmModelSwitch` with `confirmLossy: true`;
        // "Cancel" (and any other dismissal) simply drops the pending request — the session stays
        // on its prior selection, exactly as if the picker had never been touched. Retitled from
        // "Switch runtime?" for 10b: this dialog now fires for SAME-leg family-crossing switches
        // too (gpt → deepseek on Winter, not only a cross-runtime move), and R-10b-4/W18-23 forbid
        // naming which SDK or runtime serves a model anywhere in the UI.
        .confirmationDialog(
            "Switch model?",
            isPresented: Binding(
                get: { adapter.pendingModelConfirmation != nil },
                set: { if !$0 { adapter.pendingModelConfirmation = nil } }
            ),
            presenting: adapter.pendingModelConfirmation
        ) { pending in
            Button("Switch anyway", role: .destructive) {
                adapter.onConfirmModelSwitch(pending.model)
                adapter.pendingModelConfirmation = nil
            }
            Button("Cancel", role: .cancel) { adapter.pendingModelConfirmation = nil }
        } message: { pending in
            Text(modelSwitchConfirmMessage(warnings: pending.warnings, portable: pending.portable))
        }
        // The remaining three outcomes (`.disabled`/`.lossyFork`/`.blocked`/`.failed`, collapsed by
        // `onSetModel`'s wiring into one string) — a one-line explanation, dismissed with a plain
        // OK. Never a sheet: there is nothing actionable to offer beyond "read this".
        .alert("Couldn't switch model", isPresented: Binding(
            get: { adapter.modelChangeError != nil },
            set: { if !$0 { adapter.modelChangeError = nil } }
        ), presenting: adapter.modelChangeError) { _ in
            Button("OK") { adapter.modelChangeError = nil }
        } message: { reason in
            Text(reason)
        }
    }

    /// The chat window's content column (header → transcript → floating task list → queued line →
    /// composer), with the floating subagents block overlaid top-trailing.
    @ViewBuilder
    private var contentColumn: some View {
        VStack(spacing: 10) {
            // The header row survives only where a caller injects an accessory — the orb's morph
            // window draws its traffic lights here. Its status text and its folders / background /
            // model / effort / policy buttons were removed 2026-09-17 (ChatGPT has no such row;
            // model and effort live in the composer).
            if Accessory.self != EmptyView.self {
                HStack(spacing: 12) {
                    headerAccessory()
                    Spacer()
                }
                .frame(height: chatWindowHeaderHeight)
            }

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
                // The mirror of the composer's `excluding:` just below. One set, read twice: the
                // transcript draws exactly the pending questions the composer is NOT holding.
                closedAsks: closedAsks,
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
            ), onOpenDiff: onOpenDiff, onOpenFile: onOpenFile,
            sessionHasWorkingDirectory: sessionHasWorkingDirectory)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .modifier(TranscriptTopBleed(bleed: topBleed, inset: topInset))
            // The composer FLOATS over the transcript (user call, 2026-08-12: "the composer should
            // float over the transcript and not have that hard background"). It used to be the next
            // sibling in this `VStack`, which reserved it a strip the transcript stopped above —
            // that reserved strip IS the hard edge; nothing was ever painting a background there.
            //
            // `safeAreaInset` is the macOS analogue of the `safeAreaBar` iOS uses for exactly this
            // (`norma-ios` `CodeSessionView`): the bottom cluster is laid out over the transcript,
            // and the ScrollView inside `TranscriptView` inherits the inset — so content SCROLLS
            // UNDER the composer and still comes fully clear of it at the end, which a plain
            // `overlay` would not do (the last message would sit permanently behind the card).
            //
            // The pinned tasks and live subagents ride along deliberately: they are the same class
            // of thing as the composer — current state, not transcript — and leaving them in the
            // flow would just move the hard edge up by their height.
            .safeAreaInset(edge: .bottom, spacing: 10) {
                VStack(spacing: 10) {
                    // The task list FLOATS just above the composer (2026-09-17), as its own card at
                    // the composer's width.
                    if !adapter.pinnedTasks.isEmpty {
                        floatingCard { pinnedTasksSection(adapter.pinnedTasks) }
                            .frame(maxWidth: newChatCardWidth)
                    }

                    if let queued = adapter.queuedText {
                        Text(queued).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    // While a question is waiting, the composer's SLOT is the question box — the
                    // composer does not appear below it, beside it, or greyed out; it becomes it
                    // (user call, 2026-08-12; iOS `CodeSessionView`'s SP-ask-morph). Answering
                    // restores the composer and the question reappears in the transcript, frozen.
                    //
                    // `.blurReplace` in both directions is iOS's own transition here
                    // (`CodeSessionView.swift:142`/`:152`) — and it is a BLUR CROSS-FADE, not a
                    // geometric morph: nothing interpolates the shape. What sells it is staging,
                    // not animation — one slot, one surface colour, a radius that grows. Checked in
                    // the iOS source rather than assumed; the only true glass-morph API in that app
                    // is in `SessionListView`, not here.
                    //
                    // `.id(callId)` gives each question block its own view identity, so a second
                    // ask arriving as the first is answered gets a fresh box (and fresh draft
                    // state) instead of inheriting the outgoing one's.
                    if let pending = composerMorphQuestion(adapter.pendingInteractions,
                                                          excluding: closedAsks) {
                        ComposerQuestionBox(
                            callId: pending.callId,
                            questions: pending.questions,
                            childSessionId: pending.childSessionId,
                            isInFlight: adapter.interactionInFlight.contains(pending.callId),
                            onQuestion: adapter.onQuestionRespond,
                            onClose: { closedAsks.insert(pending.callId) },
                            draft: adapter.pendingCardDraftBinding(for: pending.callId)
                        )
                        .id(pending.callId)
                        .transition(.blurReplace)
                    } else if let card = composerCard {
                        card.frame(maxWidth: .infinity)
                            .transition(.blurReplace)
                    } else {
                        ComposerTextView(
                            text: adapter.draftBinding,
                            onSubmit: { adapter.onSubmit(adapter.composerDraft) },
                            usesAdaptiveColors: true
                        )
                        .frame(height: 88)
                        .transition(.blurReplace)
                    }

                }
                // The driver. A `.transition` is inert without one — the branches above would swap
                // instantly and the blur would never render. Keyed on the ASK'S IDENTITY rather than
                // on a Bool, so question-to-question (a second ask arriving as the first resolves)
                // animates too instead of snapping between two states that are both "a box".
                .animation(.smooth(duration: 0.3),
                           value: composerMorphQuestion(adapter.pendingInteractions)?.callId)
            }
        }
        .padding(.horizontal, 16)
        // With a bleed, the TRANSCRIPT carries the top offset as a scroll margin (see
        // `TranscriptTopBleed`) so its content can scroll up under the band; nothing else in this
        // column sits at the top.
        .padding(.top, topBleed > 0 ? 0 : topInset)
        .padding(.bottom, 16)
    }

    /// The page: the chat column, and — for a non-chat session in the app shell, while the
    /// titlebar toggle has it on — the work panel as a real column beside it (2026-09-17, ChatGPT's
    /// layout). Being a column rather than an overlay, it takes its width out of the transcript's.
    @ViewBuilder
    private var pageColumns: some View {
        HStack(alignment: .top, spacing: 0) {
            contentColumn
            if showsWorkPanel {
                floatingCard { workPanelBlock }
                    .frame(width: floatingSubagentBlockWidth)
                    .padding(.top, topBleed + topInset + 8)
                    .padding(.trailing, 16)
                    .transition(.move(edge: .trailing))
            }
        }
    }

    /// The panel belongs to the app shell's session page (the one surface with the titlebar toggle,
    /// `composerCardMode != nil`) and never to a chat session.
    private var showsWorkPanel: Bool {
        workPanelVisible && composerCardMode != nil && !adapter.isChatSession
    }

    /// What the work panel shows: a DISPATCH session's running managed sessions (2026-09-19 — the
    /// sessions it dispatched are its real workers), every other session's subagents.
    @ViewBuilder
    private var workPanelBlock: some View {
        if let sidebars, let row = currentSidebarSessionSummary, row.mode == "dispatch" {
            DispatchManagedSessionsBlock(directory: sidebars.directory,
                                         dispatchSessionId: row.sessionId,
                                         onSelect: sidebars.onSelect)
        } else {
            subagentBlock
        }
    }

    /// The floating subagents block's body: a header, the live rows, or an empty line.
    @ViewBuilder
    private var subagentBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Subagents")
                .font(Typography.caption(.semibold))
                .foregroundStyle(.secondary)
            if adapter.liveSubagents.isEmpty {
                Text("None running")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
            } else {
                subagentSection(adapter.liveSubagents)
            }
        }
    }

    /// ChatGPT's floating-card radius (its Outputs card, measured 2026-09-17).
    private let floatingCardCornerRadius: CGFloat = 20

    /// A floating surface — `paletteSurface` (the "floats above content" token) with the elevated
    /// hairline rim and a soft shadow. Shared by the subagents block and the task list.
    private func floatingCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: floatingCardCornerRadius, style: .continuous)
                    .fill(Theme.paletteSurface)
                    .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
            )
            .overlay(
                RoundedRectangle(cornerRadius: floatingCardCornerRadius, style: .continuous)
                    .strokeBorder(Theme.hairlineElevated, lineWidth: 1 / displayScale)
            )
    }

    /// The SHARED composer card (user call, 2026-08-07: the live page's composer "should be the same
    /// as the one of the new chat page"), or `nil` for a surface that opted into no card — the
    /// detached window and the orb's morph window, which keep the plain `ComposerTextView` below on
    /// the ruling `composerCardMode`'s own doc records.
    ///
    /// Its strip emerges from the TOP here: this composer sits at the bottom of the window, where
    /// "below" is off-screen. The mode segment is NOT selectable — a session's mode is fixed at
    /// creation and Winter has no mode-switch, so a live segment would offer something it cannot do.
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
    var composerCard: WinterComposerCard? {
        guard let cardMode = composerCardMode else { return nil }
        return WinterComposerCard(
            text: adapter.draftBinding,
            onSubmit: { adapter.onSubmit(adapter.composerDraft) },
            mode: .constant(cardMode),
            modeIsSelectable: false,
            policy: adapter.composerPolicyControl,
            model: composerModelControl,
            stripEdge: .above,
            workingDirectory: currentSidebarSessionSummary?.cwd,
            sendBlockedReason: adapter.composerDraft
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : nil,
            stop: composerStopControl
        )
    }

    /// office-live-ux Job 1 — the card's stop wiring, or `nil` when this surface offers none.
    ///
    /// **`onInterrupt == nil` is the gate**, not `turnRunning`: a surface that never wired an
    /// interrupt must render no stop button AND leave Esc alone, at every turn state. The orb's
    /// morph window and every detached window are exactly that surface — both already own Esc
    /// through `NSEvent` monitors of their own (`OrbWindowController.swift:567`,
    /// `DetachedWindowController.swift:499`), and neither renders this card today anyway
    /// (`composerCardMode` is nil for both), so this is belt as well as gate.
    ///
    /// `isRunning` is a SNAPSHOT taken at render, deliberately: the button has to draw one, and
    /// giving Esc a live closure while the button drew a snapshot is precisely the disagreement this
    /// task exists to prevent. It cannot go stale in practice — `FieldStateAdapter.init` republishes
    /// `SessionModel.objectWillChange` as its own, so this view re-renders on the turn boundary that
    /// flips the value. Both stale directions are harmless anyway: a stale `true` sends an interrupt
    /// the daemon answers `wasRunning: false`; a stale `false` hands Esc back to AppKit.
    ///
    /// **Hoisted out of `composerCard` for the tests' sake**, the same reason that property was
    /// hoisted out of `contentColumn`: the whole path from adapter to rendered button is a value
    /// here, so "a running turn shows stop" is assertable without rendering anything.
    var composerStopControl: ComposerStopControl? {
        guard let onInterrupt = adapter.onInterrupt else { return nil }
        return ComposerStopControl(isRunning: adapter.turnRunning, onStop: onInterrupt)
    }

    /// mac-chat-parity Task 7 (spec §5): a LIVE session's model/effort wiring, as the composer's chip
    /// takes it — the same values the header's two menus read, from the same two places, so the two
    /// doors onto `session.setModel`/`session.setEffort` can never show different answers.
    ///
    /// The current selection is the session ROW's (`session.list`, via `currentSidebarSessionSummary`)
    /// overlaid with any optimistic pick — `effectiveSelection`, exactly as the composer's menus compute it. Unlike the policy, none of this is cached on the
    /// adapter: `session.list` already carries `model`/`effort` per row, and a second source of truth
    /// here is what `onSetModel`'s own doc rules out.
    ///
    /// The three closures FORWARD rather than capturing today's values, the same tap-time read the
    /// menus' own buttons do — a card built before its surface wired its callbacks still reaches the
    /// real ones.
    var composerModelControl: ComposerModelControl {
        let row = currentSidebarSessionSummary
        return ComposerModelControl(
            model: effectiveSelection(row: row?.model, optimistic: adapter.pendingModel),
            effort: effectiveSelection(row: row?.effort, optimistic: adapter.pendingEffort),
            catalogue: adapter.modelCatalogue,
            modelChangeInFlight: adapter.modelChangeInFlight,
            effortChangeInFlight: adapter.effortChangeInFlight,
            runtimeKind: row?.runtimeKind,
            // Winter Phase 8d (fix round 1): `onOpen` now refreshes advisorModel TOO —
            // `FieldStateAdapter.advisorModel` is a CACHE (`refreshAdvisorModel()`'s own doc),
            // never read from settings.json synchronously here. Fixes the review finding that this
            // computed property (evaluated on every `body` pass) used to do a blocking file read
            // on every render, not just when the menu was actually about to be shown.
            onOpen: { adapter.onRefreshModelCatalogue(); adapter.refreshAdvisorModel() },
            onSetModel: { adapter.applyModelSelection($0) },
            onSetEffort: { adapter.applyEffortSelection($0) },
            advisorModel: adapter.advisorModel,
            onSetAdvisorModel: { adapter.applyAdvisorModelSelection($0) })
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
            // The right work sidebar was retired 2026-09-17 (its subagents float over the content,
            // its tasks float above the composer, its approval picker lives in the composer), so
            // the engine only ever resolves the left side.
            ? resolveSidebars(width: measuredWidth,
                              leftExpanded: state.leftExpanded, rightExpanded: false,
                              leftOverlayOpen: state.leftOverlayOpen, rightOverlayOpen: false)
            : EffectiveSidebars(leftVisible: false, rightVisible: false, leftOverlay: false, rightOverlay: false)
        ZStack {
            HStack(spacing: 0) {
                if resolved.leftVisible && !resolved.leftOverlay {
                    sessionSidebarColumn(sidebars)
                    sidebarHairline
                }
                pageColumns
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
            }

            // Overlay panels + a tap-to-dismiss scrim BEHIND each (the scrim is added first so the
            // panel draws over it; the panel slides in from its edge). `Theme.paletteSurface` is the
            // panel's face — the brand's token for a surface that FLOATS above content, which is
            // exactly what an overlay column is (mac-chat-parity Task 8; it was `.ultraThinMaterial`,
            // a blur of whatever it happened to be over rather than a colour anyone chose).
            if resolved.leftOverlay {
                sidebarScrim { sidebar = dismissLeftOverlay(sidebar) }
                HStack(spacing: 0) {
                    sessionSidebarColumn(sidebars).background(Theme.paletteSurface)
                    Spacer(minLength: 0)
                }
                .transition(.move(edge: .leading))
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

    /// A full-height 16pt-wide edge chevron (`.secondary`), the hit-target for opening a hidden
    /// side. gate-feedback-1 FIX C: the GLYPH is now top-anchored (`sidebarChevronTopOffset` below
    /// `topInset`) instead of vertically centered — visual only, the hit target itself still spans
    /// the FULL column height (`.frame(maxHeight: .infinity, alignment: .top)` + `.contentShape`
    /// covers the same full-height/16pt-wide rectangle as before; only where the icon renders
    /// within it moved).
    /// The inline sidebars' divider — ONE device pixel of `hairlineElevated` (this surface's rule
    /// token, `TranscriptBrandTests`). It was a system `Divider` — a full point of the system
    /// separator — which read far heavier than every other rule in the window.
    private var sidebarHairline: some View {
        Rectangle()
            .fill(Theme.hairlineElevated)
            .frame(width: 1 / displayScale)
    }

    private func sidebarChevron(_ systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(Typography.caption(.medium))
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

    @ViewBuilder
    func pinnedTasksSection(_ tasks: [TaskItem]) -> some View {
        let built = buildTaskSection(tasks)
        VStack(alignment: .leading, spacing: 4) {
            // Expanded state rebuilds WITHOUT the 2-completed cap (brief: "rebuild without the
            // cap") rather than reusing `built.rows`, which is always capped.
            let displayedRows = expandedCompleted ? sortedTaskRows(tasks) : built.rows
            ForEach(displayedRows, id: \.id) { row in
                taskRowView(row, activeStartedTs: built.activeStartedTs)
            }
            if built.collapsedCompleted > 0 && !expandedCompleted {
                Text("… +\(built.collapsedCompleted) completed")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .onTapGesture { expandedCompleted = true }
            } else if expandedCompleted && built.collapsedCompleted > 0 {
                Text("… collapse")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .onTapGesture { expandedCompleted = false }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The tint for the single in_progress row — the same role the task-3 brief gave its
    /// `Color(red:0.45, green:0.75, blue:1.0)`: draw the eye to what is actively running. It is
    /// `Theme.accent` since mac-chat-parity Task 8, because that literal was a hex in code, which
    /// `docs/brand.md` § 3.1's anti-rule forbids outright — it had no dark variant and no way to be
    /// tuned. Named rather than inlined so both the task rows and the subagent rows below keep
    /// reading one value; the name says "the running tint" now, not "blue".
    private var taskInProgressTint: Color { Theme.accent }

    /// Row text color: in_progress → the running tint, pending → `.primary`, completed →
    /// `Theme.textMuted` (the glyph itself is tinted separately — green for completed).
    ///
    /// Pending was `.secondary` and completed `.tertiary` — two greys, one step apart. Moving the
    /// faint one onto `Theme.textMuted` (mac-chat-parity Task 8) would have collapsed them into the
    /// same colour, since `.secondary` measures #7D7D7C against textMuted's #7A7974. So pending
    /// takes the OTHER register instead of a third grey that does not exist: a task still to do is
    /// outstanding work, and reading stronger than a finished one is the right way round.
    private func rowTextStyle(_ status: String) -> AnyShapeStyle {
        switch status {
        case "in_progress": return AnyShapeStyle(taskInProgressTint)
        case "completed": return AnyShapeStyle(Theme.textMuted)
        default: return AnyShapeStyle(.primary) // pending, or any unrecognized status
        }
    }

    /// Glyph color — same as the row text EXCEPT completed, whose `✓` is tinted green while its
    /// subject stays `Theme.textMuted`.
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
        .font(Typography.caption(row.status == "in_progress" ? .bold : .regular))
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
            ForEach(built.rows, id: \.threadId) { row in
                subagentRowView(row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The task rows' ladder, applied to subagents — see `rowTextStyle` for why queued is
    /// `.primary` rather than a second grey beside done's `Theme.textMuted`.
    private func subagentRowStyle(_ status: String) -> AnyShapeStyle {
        switch status {
        case "working": return AnyShapeStyle(taskInProgressTint)
        case "done": return AnyShapeStyle(Theme.textMuted)
        default: return AnyShapeStyle(.primary) // queued
        }
    }

    @ViewBuilder
    private func subagentRowView(_ row: SubagentItem) -> some View {
        HStack(spacing: 6) {
            Text(subagentGlyph(row.status))
                .foregroundStyle(row.status == "done" ? AnyShapeStyle(.green) : subagentRowStyle(row.status))
            Text(row.label)
            Text("(\(row.agentType))").foregroundStyle(Theme.textMuted)
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
        .font(Typography.caption(row.status == "working" ? .bold : .regular))
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

// MARK: - mac-chat-parity T7 (spec §5): the model/effort menus, shared by the header and the composer

/// One model-menu row — `model: nil` is the "Default" row (clears the override).
///
/// **A MOVE, not a rewrite** (Task 6's `PolicyPickerRow` precedent, one task on): the body below is
/// `extension WindowContentView`'s own, with the `adapter.` reads it closed over turned into
/// parameters. It is a type at file scope for the one reason that precedent had — the composer's
/// model/effort chip renders these rows too, and a per-mode composer chrome is not a
/// `WindowContentView` and could not reach a method on its extension.
///
/// Selecting a row applies OPTIMISTICALLY (the overlay flips before the RPC) and fires the surface's
/// own set — the wirer owns the in-flight flag, the revert, and the probation, the same "the wirer
/// owns the bookkeeping" convention `PolicyPickerRow` keeps. `onSelect` forwards rather than being
/// handed the adapter, so a row built before its surface wired its callbacks still reaches the real
/// one at TAP time.
struct ModelPickerRow: View {
    let model: String?
    /// The session's current selection, for the checkmark.
    let current: String?
    /// True while a `session.setModel` is in flight — one change at a time.
    let isDisabled: Bool
    /// WS-20: the synced catalogue, for the label (`modelDisplayLabel`) and the provider tooltip —
    /// a picker row never shows the raw `<providerId>/<modelId>` tag to the user.
    let catalogue: SyncConfigSnapshot
    let onSelect: (String?) -> Void

    /// The catalogue row this tag names, when there is one. `nil` for the "Default" row and for a
    /// tag not (or not yet) in the catalogue.
    private var row: SyncConfigModelInfo? {
        guard let model else { return nil }
        return catalogue.models.first { $0.id == model }
    }
    /// WS-20: the provider tooltip — spec §7's "provider shown as the menu row's secondary text /
    /// tooltip only".
    private var providerId: String? { row?.providerId }

    var body: some View {
        Button {
            onSelect(model)
        } label: {
            HStack {
                // WS-20 review fix (Nit 2): the catalog row's own human displayName as the row's
                // SECONDARY text (spec §7) — distinct from the primary label, which stays the
                // facing-name-or-modelId `modelDisplayLabel` (never the raw tag either way).
                VStack(alignment: .leading, spacing: 1) {
                    Text(modelDisplayLabel(model, catalogue: catalogue))
                    if let displayName = row?.displayName {
                        Text(displayName)
                            .font(Typography.caption())
                            .foregroundStyle(Theme.textMuted)
                    }
                }
                Spacer()
                if selectionIsCurrent(model, current: current) {
                    Image(systemName: "checkmark")
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .padding(.vertical, 4)
        .help(providerId ?? "")
    }
}

/// The model menu: "Default" (clears the override) first, then the SYNCED CATALOGUE grouped by
/// provider (WS-20 review fix, Nit 2 — spec §7's sectioned picker, wired into production: a
/// section per provider, headed by `modelPickerSections`' `title`, each row's secondary text the
/// catalog row's `displayName`).
///
/// An UNLISTED current model still gets a row of its own — a stale slug from a provider change is
/// still the thing this session is pinned to, and a selection the user cannot see is a selection
/// they cannot clear.
///
/// It draws no padding or width of its own: each popover frames it (the header's two do it exactly
/// as they always did; the composer's stacks this and `EffortMenuContent` and frames the pair).
struct ModelMenuContent: View {
    let current: String?
    let isDisabled: Bool
    /// WS-20: the synced catalogue — the source `modelPickerSections` groups, and every row reads
    /// for its facing-name label and provider tooltip. Defaulted to `.empty` so a test double with
    /// no catalogue to offer keeps compiling; an empty catalogue renders no sections at all (just
    /// the "Default" row), never a crash.
    var catalogue: SyncConfigSnapshot = .empty
    let onSelect: (String?) -> Void

    var body: some View {
        let sections = modelPickerSections(catalogue)
        VStack(alignment: .leading, spacing: 2) {
            Text("Model")
                .font(Typography.caption(.semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
            ModelPickerRow(model: nil, current: current, isDisabled: isDisabled, catalogue: catalogue, onSelect: onSelect)
            ForEach(sections, id: \.providerId) { section in
                Text(section.title)
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
                    .padding(.bottom, 2)
                ForEach(section.entries, id: \.tag) { entry in
                    ModelPickerRow(model: entry.tag, current: current, isDisabled: isDisabled, catalogue: catalogue, onSelect: onSelect)
                }
            }
            if let current, !sections.contains(where: { section in section.entries.contains { $0.tag == current } }) {
                ModelPickerRow(model: current, current: current, isDisabled: isDisabled, catalogue: catalogue, onSelect: onSelect)
            }
        }
    }
}

/// One effort-menu row. Same move, same reasons, same shape as `ModelPickerRow` above.
struct EffortPickerRow: View {
    let effort: String?
    let current: String?
    let isDisabled: Bool
    let onSelect: (String?) -> Void

    var body: some View {
        Button {
            onSelect(effort)
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
        .disabled(isDisabled)
        .padding(.vertical, 4)
    }
}

/// The effort menu: "Default", then the WIRE levels the session's model accepts, then — when the
/// caller's own gate says so — the Winter-level tiers under their own heading.
///
/// The two sections are never merged (see `effortPickerOptions`), and the tier section is simply
/// ABSENT rather than shown-and-refused wherever it does not apply: a mode that may not select one
/// (chat/dispatch), and a catalogue that reported no wire levels at all (a BYOK Mac, or nothing
/// fetched yet — whole-branch review I1). In that second case the menu is "Default" alone, which is
/// the honest rendering of "this daemon has told me nothing about efforts for this model". A tier the
/// user ALREADY pinned still gets its row via the `.unknown` branch below, so a selection made before
/// the catalogue emptied out stays visible and clearable.
///
/// **Both lists arrive decided.** This view does not re-derive them — the caller does, via
/// `effortPickerOptions`, which is where the mode/Bool gate and the no-wire-levels rule live. That is
/// deliberate: the header asks by mode, the composer asks by its chrome's Bool, and both must reach
/// one answer (`ModelPickerTests` pins the two doors against each other).
struct EffortMenuContent: View {
    let wire: [String]
    let tiers: [String]
    let current: String?
    let isDisabled: Bool
    let onSelect: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Reasoning effort")
                .font(Typography.caption(.semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
            EffortPickerRow(effort: nil, current: current, isDisabled: isDisabled, onSelect: onSelect)
            ForEach(wire, id: \.self) { level in
                EffortPickerRow(effort: level, current: current, isDisabled: isDisabled, onSelect: onSelect)
            }
            if !tiers.isEmpty {
                Text("Winter")
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
                    .padding(.bottom, 4)
                ForEach(tiers, id: \.self) { tier in
                    EffortPickerRow(effort: tier, current: current, isDisabled: isDisabled, onSelect: onSelect)
                }
            }
            // A current selection in NEITHER list still needs a row — see `selectionOrigin`.
            if selectionOrigin(current, wire: wire, tiers: tiers) == .unknown, let current {
                EffortPickerRow(effort: current, current: current, isDisabled: isDisabled, onSelect: onSelect)
            }
        }
    }
}

// MARK: - Task 10 (Chat Slice D): the model picker's pure decisions — `ModelPickerTests` drives
// these directly, same "SwiftUI body isn't unit-testable, the decision behind it is" posture as
// `buildTaskSection`/`buildSubagentSection` above.

/// provider-correctness T6: the model menu's offered slugs, read from the SYNCED CATALOGUE
/// (`sync.config`'s `models`, reached through `WinterClient.syncConfig()` and held on
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

/// WS-20: `id`'s own `<providerId>/` prefix, stripped for DISPLAY only — splitting at the FIRST
/// `/` (an id may itself contain more, e.g. an openrouter-style nested slug), and a no-op when the
/// value is not tag-shaped at all (a pre-migration bare model, or a stray non-catalog string) —
/// never throws, this is a label helper, not a validator. Shared by every picker/status surface in
/// this file so the "strip the provider for display" rule lives in exactly one place.
func modelIdPortion(of tag: String) -> String {
    guard let slash = tag.firstIndex(of: "/") else { return tag }
    return String(tag[tag.index(after: slash)...])
}

/// WS-20: one row in a `modelPickerSections` group — `tag` is the wire value (`session.setModel`
/// sends it verbatim), `label` is what the row shows.
struct ModelPickerEntry: Equatable {
    let tag: String
    let label: String
}

/// WS-20: one provider's rows in the picker — `providerId` for identity/grouping, `title` for the
/// section header.
struct ModelPickerSection: Equatable {
    let providerId: String
    let title: String
    let entries: [ModelPickerEntry]
}

/// WS-20 (Interim presentation, spec §7): the picker's catalogue GROUPED BY PROVIDER — the picker
/// no longer shows a flat list of provider-qualified tags verbatim (a Mac-native menu is not a
/// terminal listing; a section per provider is the direct visual translation of the CLI's
/// `renderModelListing` grouping). First-appearance provider order, matching `catalogue.models`'
/// own (daemon) order — never re-sorted, same "the daemon decides the order" rule
/// `modelPickerOptions` already keeps.
///
/// `title` is the provider's human-facing name when the caller has one cached (e.g. from
/// `credential.list`'s own `displayName` rows) — `providerNames` defaults to `[:]` so every
/// existing call site keeps compiling and simply shows the bare providerId until a caller is
/// wired to supply better names (a follow-up, not a blocker: the id is still an honest, never-
/// wrong label).
///
/// `label` is the family-slot facing name (capitalized, e.g. "Terra") when the row fills one, else
/// the bare modelId (`modelIdPortion`) — mirrors the CLI's `renderModelListing` exactly.
func modelPickerSections(_ catalogue: SyncConfigSnapshot, providerNames: [String: String] = [:]) -> [ModelPickerSection] {
    var order: [String] = []
    var byProvider: [String: [ModelPickerEntry]] = [:]
    for m in catalogue.models {
        if byProvider[m.providerId] == nil {
            order.append(m.providerId)
            byProvider[m.providerId] = []
        }
        let label = m.facingName.map { $0.capitalized } ?? modelIdPortion(of: m.id)
        byProvider[m.providerId]?.append(ModelPickerEntry(tag: m.id, label: label))
    }
    return order.map { providerId in
        ModelPickerSection(providerId: providerId, title: providerNames[providerId] ?? providerId, entries: byProvider[providerId] ?? [])
    }
}

/// provider-correctness T6: the effort menu's two sections — WIRE levels for the session's model,
/// and WINTER-LEVEL tiers.
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
    effortPickerOptions(catalogue: catalogue, model: model, offersTiers: effortTiersAreOffered(mode: mode))
}

/// mac-chat-parity T7: the same function, asked the tier question as a BOOLEAN.
///
/// The composer's chip cannot ask by mode string: since Task 5 the mode → composer decision is made
/// once (`composerChrome(_:)`) and each mode's chrome answers for itself, and the shared shell that
/// draws the chip holds no mode conditional at all — a `mode`-shaped argument threaded through it
/// would be one, in the one shape the shell's source scan cannot see (a helper taking a mode). So the
/// chrome answers `offersClientEffortTiers` and this door takes the answer.
///
/// **One decision, two doors.** Everything else — the model precedence, the "not told" empty, the
/// no-wire-levels rule — is written once, here; the mode-taking overload above is now a one-line
/// forwarder. `ModelPickerTests` pins the two against each other for every mode so they cannot drift.
func effortPickerOptions(catalogue: SyncConfigSnapshot, model: String?, offersTiers: Bool) -> (wire: [String], tiers: [String]) {
    // The session's EFFECTIVE model, by AgentEngine.resolveSel's own precedence: its override first,
    // the daemon's live default second. A model the catalogue doesn't list contributes no levels —
    // "I have not been told", not "none exist".
    let effective = model ?? catalogue.defaultModel
    let wire = catalogue.models.first { $0.id == effective }?.efforts ?? []
    // Both gates, and the sections stand or fall together: no wire list ⇒ no tier section either.
    let tiers = (!wire.isEmpty && offersTiers) ? catalogue.clientEfforts : []
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
/// `SessionSummary.effort` may report a Winter-level TIER verbatim (`"ultra"`) rather than its wire
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

/// The model menu's current-selection LABEL — "Default" when unset (brief's own wording: labeled
/// so the user can tell inherited-from-default apart from explicitly-pinned), else the CATALOGUE
/// entry's own label (facing name, capitalized) when the tag is present in it, else the bare
/// modelId (`modelIdPortion`) — WS-20's "model-portion badge": a picker/chip/tooltip never shows
/// the raw `<providerId>/<modelId>` tag to the user, catalogue-known or not.
func modelDisplayLabel(_ model: String?, catalogue: SyncConfigSnapshot) -> String {
    guard let model else { return "Default" }
    if let row = catalogue.models.first(where: { $0.id == model }) {
        return row.facingName.map { $0.capitalized } ?? modelIdPortion(of: model)
    }
    return modelIdPortion(of: model)
}

/// The effort menu's current-selection LABEL — same "Default" wording and same reason as
/// `modelDisplayLabel` above: no override must READ as inherited-from-default, never as blank.
/// "Default" is deliberately NOT "none": an unset effort omits the request's `reasoning` block
/// entirely, while `"none"` is a real, distinct level the endpoint honours, and it appears in the
/// wire list as its own row.
func effortDisplayLabel(_ effort: String?) -> String {
    effort ?? "Default"
}

/// Winter Phase 10b (D1-4, W18-23): the lossy-switch confirm dialog's body — `warnings` joined
/// verbatim (the matrix's own prose, `classifySwitch`'s `warned-lossy` class), plus a trailing line
/// naming what STILL carries when the review found some (`portable`, additive — `[]` until D1-6
/// fills it from the router's own `reviewSwitch`). A kept, top-level pure function (this file's own
/// idiom — see `modelDisplayLabel`/`modelMenuIsVisible` above) so `ModelPickerTests` can pin its
/// exact wording without mounting the dialog. Never names an SDK or runtime (R-10b-4): the
/// no-warnings fallback is defensive only — `classifySwitch`'s `warned-lossy` class always carries
/// at least one warning — and says nothing more specific than "some of the conversation's carried
/// state".
func modelSwitchConfirmMessage(warnings: [String], portable: [String]) -> String {
    var lines = warnings.isEmpty
        ? ["This model change may lose some of the conversation's carried state."]
        : warnings
    if !portable.isEmpty {
        lines.append("Still carries over: \(portable.joined(separator: ", "))")
    }
    return lines.joined(separator: "\n")
}

// MARK: - Dispatch's work panel (2026-09-19)

/// PURE: the sessions a dispatch session is running — its children (`parentSessionId`) that are
/// active or backgrounded, active first, newest first within each.
func dispatchManagedRunningSessions(_ rows: [SessionSummary], dispatchSessionId: String) -> [SessionSummary] {
    let rank = ["active": 0, "background": 1]
    return rows
        .filter { $0.parentSessionId == dispatchSessionId && rank[$0.activity ?? ""] != nil }
        .sorted {
            let a = rank[$0.activity ?? ""] ?? 2, b = rank[$1.activity ?? ""] ?? 2
            return a != b ? a < b : $0.createdAt > $1.createdAt
        }
}

/// The dispatch session's work panel: its running managed sessions, each a door to that session.
/// Its own view so it OBSERVES the directory — the window view holds the wiring unobserved.
struct DispatchManagedSessionsBlock: View {
    @ObservedObject var directory: SessionDirectory
    let dispatchSessionId: String
    let onSelect: (String) -> Void

    var body: some View {
        let running = dispatchManagedRunningSessions(directory.rows, dispatchSessionId: dispatchSessionId)
        VStack(alignment: .leading, spacing: 6) {
            Text("Running sessions")
                .font(Typography.caption(.semibold))
                .foregroundStyle(.secondary)
            if running.isEmpty {
                Text("None running")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
            } else {
                ForEach(running) { row in
                    Button { onSelect(row.sessionId) } label: {
                        HStack(spacing: 6) {
                            Text(sessionDisplayTitle(row.title))
                                .font(Typography.caption())
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer(minLength: 4)
                            ActivityChip(activity: row.activity)
                        }
                        .padding(.horizontal, 6)
                        .frame(height: 26)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(ShellSidebarRowStyle(isSelected: false))
                }
            }
        }
    }
}

// MARK: - The transcript under the titlebar band (2026-09-19)

/// Lets the transcript scroll up under the titlebar band and fade out there, instead of stopping at
/// a hard line below an empty strip. No-op at `bleed == 0` (every surface but the shell).
///
/// The content keeps its old resting place — a scroll MARGIN of `bleed + inset` — so nothing moves
/// until you scroll; the fade is a mask over the band plus a short ramp below it, eased so the
/// text dissolves rather than being wiped (the same idea as the sidebar's top fade).
struct TranscriptTopBleed: ViewModifier {
    let bleed: CGFloat
    let inset: CGFloat

    func body(content: Content) -> some View {
        if bleed > 0 {
            content
                .contentMargins(.top, bleed + inset, for: .scrollContent)
                .mask {
                    VStack(spacing: 0) {
                        LinearGradient(stops: [
                            .init(color: .clear, location: 0),
                            .init(color: .black.opacity(0.08), location: 0.45),
                            .init(color: .black.opacity(0.55), location: 0.8),
                            .init(color: .black, location: 1),
                        ], startPoint: .top, endPoint: .bottom)
                        .frame(height: bleed + transcriptTopFadeRamp)
                        Color.black
                    }
                }
        } else {
            content
        }
    }
}

/// How far below the band the fade finishes.
let transcriptTopFadeRamp: CGFloat = 18
