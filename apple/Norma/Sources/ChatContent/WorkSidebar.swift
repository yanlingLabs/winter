import SwiftUI

/// 2e-iii Task 6: the callback bundle the two window construction sites hand to `WindowContentView`
/// to light up its width-responsive sidebars. `WindowContentView.sidebars` is `SidebarWiring?` —
/// `nil` reproduces today's exact zero-sidebar layout (a guard clause in `body`); BOTH call sites
/// (the morph window via `OrbWindowController`, a detached window via `DetachedWindowController`)
/// pass a real value.
///
/// `directory` is the left session-switcher's live list; `currentSessionId` is read FRESH at render
/// (a closure, not a captured value — the focused/pinned session changes over the window's life);
/// `onSelect` switches in place, `onOpenDetached` spawns a new detached window for that id, and
/// `onNewSession` creates+focuses a fresh session.
///
/// `rowFilter` (plan-immunity Task 2, mode×surface matrix): `directory` is SHARED — the orb's own
/// `SidebarWiring` and a `DetachedWindowController`'s each point at a DIFFERENT `SessionDirectory`
/// instance, but both instances carry every mode. The orb is a dispatch-only surface (it can never
/// focus a chat/cowork/code session — see `AppModel.refocus`'s own gate), so showing those rows in
/// ITS sidebar at all is the shown-but-broken shape this slice keeps closing; a detached window has
/// no such restriction and must keep showing every mode. Rather than filtering inside
/// `SessionDirectory` itself (shared — would wrongly also filter every detached window's sidebar),
/// this is the orb's own CONSUMPTION-POINT filter: default `{ _ in true }` reproduces today's exact
/// behavior for every pre-existing caller (both detached-window construction sites), and
/// `AppDelegate.boot()`'s own `orb.sidebars` is the one caller that overrides it
/// (`AppDelegate.isOrbSidebarRow`).
struct SidebarWiring {
    let directory: SessionDirectory
    let currentSessionId: () -> String?
    let onSelect: (String) -> Void
    let onOpenDetached: (String) -> Void
    let onNewSession: () -> Void
    var rowFilter: (SessionSummary) -> Bool = { _ in true }
}

/// Pure placement decision behind the relocation gates: the tasks/subagents "work" content is
/// EXCLUSIVELY either inline in the content column (no right sidebar) or in the right WorkSidebar
/// (the right side visible — inline OR overlay). Never both (would duplicate the sections), never
/// neither (would drop them). `SidebarRelocationTests` drives this directly; the `body` gates read
/// `resolved.rightVisible` (== `sidebarWork`) inline for the smallest diff.
func sidebarContentPlacement(_ e: EffectiveSidebars) -> (inlineWork: Bool, sidebarWork: Bool) {
    (!e.rightVisible, e.rightVisible)
}

/// Chevron tap = "I want to see this side", tap-only overlays (SPEC). A chevron is only ever shown
/// for a side that is NOT effectively visible, so its tap is always an OPEN, never a blind toggle:
/// - If the side FITS INLINE at the current width → set its `expanded` true (force-open in ONE tap,
///   defeating the T4 resize-drift double-tap — a stale-true `expanded` can leave the side invisible
///   after a shrink; feeding `toggleLeftSidebar` `false` makes `newLeft = !false = true` reliably
///   open), applying the below-both-fit mutual exclusion to the OTHER side, and clearing overlay state.
/// - If it DOESN'T fit inline → open it as an OVERLAY (`overlayOpen` true). Also set `expanded` true
///   so a later WIDEN renders it inline (and the symmetric dismiss clears both). Clears the other
///   side's `overlayOpen` (at most one overlay) and — below both-fit — collapses the other side
///   entirely (mutual exclusion). `!fitsInline` ⇒ width < both-fit, so that collapse always applies.
func openLeftViaChevron(_ s: SidebarState, width: CGFloat) -> SidebarState {
    let bothFit = width >= sidebarContentMinWidth + sidebarLeftWidth + sidebarRightWidth
    let leftFitsInline = width >= sidebarContentMinWidth + sidebarLeftWidth
    var out = s
    out.leftOverlayOpen = false
    if leftFitsInline {
        // Reuse the tested mutual-exclusion rule for the expanded flags (force-open: feed `false`).
        let t = toggleLeftSidebar(leftExpanded: false, rightExpanded: s.rightExpanded, width: width)
        out.leftExpanded = t.left       // == true
        out.rightExpanded = t.right     // collapsed below both-fit; untouched at both-fit
    } else {
        // Doesn't fit → overlay. `expanded` true so a later widen renders it inline (dismiss clears both).
        out.leftExpanded = true
        out.leftOverlayOpen = true
    }
    // Mutual exclusion below both-fit: opening the left collapses the right ENTIRELY — including a
    // lingering right overlay that would otherwise win the tie and hide the left. (`!leftFitsInline`
    // already implies below both-fit, so this also covers the overlay branch.)
    if !bothFit { out.rightExpanded = false; out.rightOverlayOpen = false }
    return out
}

/// Mirror of `openLeftViaChevron` for the right edge — see that function's doc.
func openRightViaChevron(_ s: SidebarState, width: CGFloat) -> SidebarState {
    let bothFit = width >= sidebarContentMinWidth + sidebarLeftWidth + sidebarRightWidth
    let rightFitsInline = width >= sidebarContentMinWidth + sidebarRightWidth
    var out = s
    out.rightOverlayOpen = false
    if rightFitsInline {
        let t = toggleRightSidebar(leftExpanded: s.leftExpanded, rightExpanded: false, width: width)
        out.leftExpanded = t.left       // collapsed below both-fit; untouched at both-fit
        out.rightExpanded = t.right     // == true
    } else {
        out.rightExpanded = true
        out.rightOverlayOpen = true
    }
    if !bothFit { out.leftExpanded = false; out.leftOverlayOpen = false }
    return out
}

/// Scrim/chevron dismiss of an open overlay clears BOTH that side's `overlayOpen` AND its `expanded`
/// so it collapses back to a chevron (stays hidden until re-tapped) rather than snapping inline.
func dismissLeftOverlay(_ s: SidebarState) -> SidebarState {
    var out = s; out.leftOverlayOpen = false; out.leftExpanded = false; return out
}

/// Mirror of `dismissLeftOverlay` for the right edge.
func dismissRightOverlay(_ s: SidebarState) -> SidebarState {
    var out = s; out.rightOverlayOpen = false; out.rightExpanded = false; return out
}

// MARK: - SP-policies Task 14: the six-mode restrictiveness order + display labels

/// The six approval-policy modes offered by both pickers (the WorkSidebar Options block and the
/// ⋯ popover's `policyMenuContent`), in restrictiveness order — wire-identical to the CLI's
/// `POLICY_ORDER` (`packages/cli/src/tui/app.tsx`) and the protocol's `ApprovalPolicy` zod enum
/// (`packages/protocol/src/methods.ts`). Raw strings only: `onSetPolicy`/`NormaClient.setPolicy`
/// are stringly-typed (no generated Swift enum mirrors `ApprovalPolicy` — the protocol's
/// three-value → six-value widening doesn't touch an exhaustive switch here), so these pass
/// straight through to the wire unchanged. `FieldStateAdapter.sessionPolicy`'s `"auto"` seed is
/// unaffected — this only widens what the PICKER offers.
let sessionPolicyModes: [String] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"]

/// Display label per mode — mirrors the CLI footer's wording (`packages/cli/src/tui/footer.tsx`)
/// rather than a bare `.capitalized`, which would render the hyphenated modes as "Dont-Ask"/
/// "Accept-Edits" instead of readable words.
func policyDisplayLabel(_ policy: String) -> String {
    switch policy {
    case "plan": return "Plan"
    case "dont-ask": return "Don't Ask"
    case "ask": return "Ask"
    case "accept-edits": return "Accept Edits"
    case "auto": return "Auto"
    case "bypass": return "Bypass"
    default: return policy.capitalized
    }
}

/// True only for `"bypass"` — the one mode that auto-approves everything, including
/// dangerous-domain calls (SP-policies Task 10). Mirrors the CLI's `theme.dangerMode` red
/// treatment (`footer.tsx`'s `⚠ bypass` segment) so the picker row carries the same danger signal.
func isPolicyDangerous(_ policy: String) -> Bool {
    policy == "bypass"
}

// MARK: - The right work sidebar (a function-family on WindowContentView, like `subagentSection`/
// `pinnedTasksSection`, so it renders them directly — brief Step 2's "smallest diff" option).

extension WindowContentView {
    /// The right WorkSidebar: an "Options" block (approval-mode picker + current-session info) over
    /// a `Divider` over a "Work" block (subagents ABOVE tasks — the relocated content). Width
    /// `sidebarRightWidth`; scrollable so a long task/subagent list never clips. Rendered inline in
    /// the HStack when the width fits, or in an `.ultraThinMaterial` overlay when it doesn't.
    @ViewBuilder
    var workSidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                sidebarOptionsBlock
                Divider().opacity(0.5)
                sidebarWorkBlock
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
        .frame(width: sidebarRightWidth)
    }

    /// One approval-mode picker row — the SHARED implementation the ⋯ popover (`policyMenuContent`)
    /// and the WorkSidebar's Options block both render (brief Step 2: "one implementation"). Reuses
    /// EXACTLY `adapter.onSetPolicy`/`sessionPolicy`/`policyChangeInFlight`. Internal (not `private`)
    /// so `policyMenuContent` in WindowContentView.swift can call it across files.
    ///
    /// SP-policies Task 14: `policy` ranges over all six `sessionPolicyModes` (not just
    /// auto/ask/plan) — `onSetPolicy` still receives the raw wire string unchanged (no enum). The
    /// `bypass` row gets a red danger treatment (`⚠` affix + red foreground), mirroring the CLI
    /// footer's `theme.dangerMode` treatment for the same mode (`packages/cli/src/tui/footer.tsx`).
    @ViewBuilder
    func policyPickerRow(_ policy: String) -> some View {
        Button {
            adapter.onSetPolicy(policy)
        } label: {
            HStack {
                Text(isPolicyDangerous(policy) ? "⚠ \(policyDisplayLabel(policy))" : policyDisplayLabel(policy))
                Spacer()
                if adapter.sessionPolicy == policy {
                    Image(systemName: "checkmark")
                }
            }
            .contentShape(Rectangle())
            .foregroundStyle(isPolicyDangerous(policy) ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
        }
        .buttonStyle(.plain)
        .disabled(adapter.policyChangeInFlight)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var sidebarOptionsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Options")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            // Plan-immunity (2026-07-28 design): the SAME gate as WindowContentView's
            // `policyMenuButton` (both surfaces render `policyPickerRow`, this file's own doc
            // comment above) — chat's policy is fixed, so the picker is hidden entirely rather than
            // shown-but-broken. `sidebarSessionInfo` below (title/scope/cwd) is still useful for
            // chat and stays visible either way.
            if !adapter.isChatSession {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(sessionPolicyModes, id: \.self) { policyPickerRow($0) }
                }
            }
            sidebarSessionInfo
        }
    }

    /// Current-session info rows: title / scope / cwd (cwd middle-truncated). Read fresh from the
    /// directory each render via `sidebars.currentSessionId()`. Hidden when the current session
    /// isn't (yet) in the directory list.
    @ViewBuilder
    private var sidebarSessionInfo: some View {
        if let row = currentSidebarSessionSummary {
            VStack(alignment: .leading, spacing: 3) {
                sidebarInfoRow("title", displaySidebarTitle(row.title), truncation: .tail)
                sidebarInfoRow("scope", row.scope, truncation: .tail)
                if let cwd = row.cwd, !cwd.isEmpty {
                    sidebarInfoRow("cwd", cwd, truncation: .middle)
                }
            }
            .padding(.top, 2)
        }
    }

    private func sidebarInfoRow(_ label: String, _ value: String, truncation: Text.TruncationMode) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .foregroundStyle(.tertiary)
            Text(value)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(truncation)
        }
        .font(.system(size: 11))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var sidebarWorkBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Work")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            // Subagents ABOVE tasks (brief Step 2). Each section already carries its own leading
            // `Divider`; they hide when empty via these gates (mirrors the content column's gates).
            if !adapter.liveSubagents.isEmpty {
                subagentSection(adapter.liveSubagents)
            }
            if !adapter.pinnedTasks.isEmpty {
                pinnedTasksSection(adapter.pinnedTasks)
            }
            if adapter.liveSubagents.isEmpty && adapter.pinnedTasks.isEmpty {
                Text("No active work")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The directory row for the currently focused/pinned session, or `nil` (no wiring / not listed
    /// yet). `sidebars` is always non-nil where the WorkSidebar renders, but read optionally here.
    private var currentSidebarSessionSummary: SessionSummary? {
        guard let sidebars, let sid = sidebars.currentSessionId() else { return nil }
        return sidebars.directory.rows.first { $0.sessionId == sid }
    }

    /// Same fallback `SessionSidebarRow` uses — an untitled session reads "New session".
    private func displaySidebarTitle(_ title: String?) -> String {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "New session" : trimmed
    }
}
