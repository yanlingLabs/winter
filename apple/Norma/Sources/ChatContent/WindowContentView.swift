import SwiftUI

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
    @ViewBuilder let headerAccessory: () -> Accessory

    /// Task 4 (2d-iii): the ⋯ menu's popover presentation state — local to this view (not the
    /// adapter), same convention as any other purely-presentational SwiftUI `@State` here; the
    /// adapter only owns the DATA the menu reads/writes (`sessionPolicy`/`policyChangeInFlight`).
    @State private var showingPolicyMenu = false

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

            TranscriptView(adapter: adapter, tint: tint)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Task 3 (2d-iii): the pending-interaction cards — mounted here, between the
            // transcript and the pinned-tasks section, in BOTH windows (the morph window's
            // `.window` surface and every native `DetachedWindowController`, since both render
            // this shared `WindowContentView`).
            if !adapter.pendingInteractions.isEmpty {
                PendingCardsView(
                    interactions: adapter.pendingInteractions,
                    inFlight: adapter.interactionInFlight,
                    errorLines: adapter.interactionErrors,
                    onApproval: adapter.onApprovalRespond,
                    onQuestion: adapter.onQuestionRespond,
                    onPlan: adapter.onPlanRespond
                )
            }

            if !adapter.pinnedTasks.isEmpty && !rightVisible {
                pinnedTasksSection(adapter.pinnedTasks)
            }

            if let queued = adapter.queuedText {
                Text(queued).font(.system(size: 11)).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ComposerTextView(
                text: adapter.draftBinding,
                onSubmit: { adapter.onSubmit(adapter.composerDraft) },
                usesAdaptiveColors: true
            )
            .frame(height: 88)

            if !adapter.liveSubagents.isEmpty && !rightVisible {
                subagentSection(adapter.liveSubagents)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, topInset)
        .padding(.bottom, 16)
    }

    // MARK: - Task 6 (2e-iii): width-responsive sidebar layout

    /// Wraps `contentColumn` in the HStack of inline sidebars + a ZStack of edge chevrons and
    /// overlay panels. The Task-4 width engine (`resolveSidebars`) decides, off `measuredWidth`,
    /// which sides are inline vs overlay vs hidden; below the both-fit width AT MOST ONE side shows
    /// (mutual exclusion, right-first). `measuredWidth == 0` (pre-first-layout) resolves to nothing
    /// visible so a stale zero never flashes the right overlay open.
    @ViewBuilder
    private func sidebarLayout(_ sidebars: SidebarWiring) -> some View {
        let resolved = measuredWidth > 0
            ? resolveSidebars(width: measuredWidth,
                              leftExpanded: sidebar.leftExpanded, rightExpanded: sidebar.rightExpanded,
                              leftOverlayOpen: sidebar.leftOverlayOpen, rightOverlayOpen: sidebar.rightOverlayOpen)
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
                if !resolved.leftVisible {
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
            rowFilter: sidebars.rowFilter
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
            // Task 6 (2e-iii): the row body is shared with the WorkSidebar's Options block via
            // `policyPickerRow` (WorkSidebar.swift) — one implementation for both surfaces.
            ForEach(sessionPolicyModes, id: \.self) { policy in
                policyPickerRow(policy)
            }
        }
        .padding(12)
        .frame(minWidth: 160)
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
