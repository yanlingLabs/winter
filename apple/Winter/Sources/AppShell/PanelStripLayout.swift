import SwiftUI

// MARK: - diff-tabs Task 11: the tab-strip kind-grouping accordion — pure math
//
// When the flat row of pills can no longer fit even at `panelTabPillMinWidth` (`ShellPanel.swift`'s
// own compression floor — below it there is nothing left to shrink, and the flat strip falls back
// to horizontal scrolling), the strip instead clusters same-kind tabs behind a collapsed "kind
// chip" and shows only ONE kind's tabs as real pills at a time. Everything in this file is pure —
// no `View`, nothing daemon-visible, nothing persisted — so it is unit-tested directly
// (`PanelStripLayoutTests.swift`); `PanelTabStrip` (`ShellPanel.swift`) is the one caller, and its
// own view assembly is live-gate territory, same as Task 10's diff renderer.

/// The strip's two rendering modes. `.flat` is every open tab as its own pill — unchanged from
/// before this task. `.grouped` clusters same-kind tabs behind collapsed chips, with exactly ONE
/// kind's tabs showing as real pills (`expandedKind`).
///
/// A single enum, not a `Bool` PLUS a separate `PanelTabKind?` — two independent properties could
/// disagree (`isGrouped == false` carrying a leftover `expandedKind`, or `isGrouped == true` with
/// no kind to expand). Modeling it as one value makes "grouped with nothing expanded" impossible to
/// express, not merely unlikely to happen at runtime.
enum PanelStripMode: Equatable {
    case flat
    case grouped(expandedKind: PanelTabKind)
}

/// PURE — do `tabCount` pills, EACH AT THE FLOOR (`panelTabPillMinWidth`), plus the strip's fixed
/// chrome (`panelTabStripOverhead(tabCount:)`, `ShellPanel.swift` — the SAME overhead
/// `panelTabPillWidth` divides its own leftover share by, so this can never reserve a different
/// amount of chrome than what actually renders), fit inside `availableWidth`?
///
/// **A genuinely different question than `panelTabPillWidth`'s, not a restatement of it —
/// `panelTabPillWidth`'s return value alone cannot answer this.** `panelTabPillWidth` clamps at the
/// floor from both directions: a share that lands exactly on the floor and a share that falls short
/// of it both return the identical floored value.
/// `testPillWidthAloneCannotDistinguishFitsFlatFromFlooredNotFitting` (`PanelStripLayoutTests.swift`)
/// proves it with the real numbers — that ambiguity is why this reimplements the boundary from the
/// raw arithmetic instead of asking what `panelTabPillWidth` returned.
///
/// Zero tabs trivially fits flat (nothing to lay out) — mirrors `panelTabPillWidth`'s own
/// `tabCount > 0` guard rather than asking `panelTabStripOverhead` to answer for a row with no
/// pills in it.
func panelStripFitsFlat(tabCount: Int, availableWidth: CGFloat) -> Bool {
    guard tabCount > 0 else { return true }
    return CGFloat(tabCount) * panelTabPillMinWidth + panelTabStripOverhead(tabCount: tabCount)
        <= availableWidth
}

/// PURE — the hysteresis half. A grouped strip does not leave grouped mode the instant
/// `panelStripFitsFlat` turns true again; it waits until there is room for ONE MORE pill than are
/// actually open (`tabCount + 1`, the identical formula) — otherwise a strip sitting exactly at the
/// flat boundary would flip in and out of grouped mode on a one-pixel resize jitter. Entering
/// grouped mode has no such buffer: the rule is asymmetric on purpose
/// (`panelStripNextMode` below is where the two combine into one transition, never evaluated as two
/// independent booleans by a caller).
func panelStripLeavesGrouped(tabCount: Int, availableWidth: CGFloat) -> Bool {
    panelStripFitsFlat(tabCount: tabCount + 1, availableWidth: availableWidth)
}

/// PURE — the state transition: given the mode BEFORE this frame, decide the mode AFTER it.
/// `PanelTabStrip` drives this from ONE `.onChange` (width or tab count moving), never computes
/// "should be grouped" as an independent fresh boolean each frame — a fresh computation has no
/// memory of which side of the hysteresis band it was already on, which is the entire reason a band
/// exists at all. `fallbackKind` supplies the kind to expand ONLY on the transition that freshly
/// ENTERS grouped mode (there is no previous `expandedKind` to keep); every other transition either
/// keeps the current one unchanged or has none to set — chip clicks and the `activeTabId`
/// auto-expand rule are separate, event-driven updates to `expandedKind` (`panelStripExpand`/
/// `panelStripAutoExpand` below), because a resize never decides WHICH kind should be expanded,
/// only whether the strip is grouped at all.
///
/// **`availableWidth <= 0` is a "no information" reading, not a "definitely doesn't fit" one, and
/// this guard is what makes the hysteresis safe to drive from `GeometryReader`.**
/// `GeometryReader`'s FIRST layout pass can report `size.width == 0` before the real size is known
/// (`ShellPanel.swift`'s `max(0, …)` comment on the scrollable frame's own `.frame(width:)` names
/// the identical fact), and `PanelTabStrip` fires this transition on exactly that first pass
/// (`.onChange(…, initial: true)`). Concretely, at 6 tabs and the app's real 600pt default width:
/// without this guard, a spurious width-0 first read makes `.flat` enter `.grouped`
/// (`!panelStripFitsFlat(6, 0)`); the real 600pt then arrives, but 600 sits INSIDE the hysteresis
/// band for 6 tabs (fits flat from 595pt, only LEAVES grouped from 665pt) —
/// `panelStripLeavesGrouped(6, 600)` is false, so the strip would stay grouped FOREVER at a width
/// where flat plainly fits, with no later event ever re-examining it. A non-positive width carries
/// no signal in EITHER direction, so the only honest answer is "no transition" — `current`,
/// unchanged — never "flat" and never "grouped".
/// `testNonPositiveWidthNeverTransitionsEitherDirection` pins exactly this scenario.
func panelStripNextMode(current: PanelStripMode, tabCount: Int, availableWidth: CGFloat,
                        fallbackKind: PanelTabKind?) -> PanelStripMode {
    guard availableWidth > 0 else { return current }
    switch current {
    case .flat:
        guard !panelStripFitsFlat(tabCount: tabCount, availableWidth: availableWidth) else { return .flat }
        guard let fallbackKind else { return .flat }  // nothing open, nothing to expand — stay flat
        return .grouped(expandedKind: fallbackKind)
    case .grouped(let expandedKind):
        guard panelStripLeavesGrouped(tabCount: tabCount, availableWidth: availableWidth) else {
            return .grouped(expandedKind: expandedKind)
        }
        return .flat
    }
}

/// One kind's cluster, in the order `panelStripKindGroups` establishes. `Identifiable` via the raw
/// string (mirrors `PanelTab.id`, `PanelTab.swift`) rather than requiring `PanelTabKind: Hashable`
/// — `PanelTabKind` deliberately conforms to `Equatable` only, and this task has no reason to widen
/// that; every lookup below is a linear `firstIndex(where:)`/`==` scan, cheap at the handful of
/// kinds and tabs a panel strip actually holds.
struct PanelStripKindGroup: Equatable, Identifiable {
    let kind: PanelTabKind
    var tabs: [PanelTab]
    var id: String { kind.rawValue }
}

/// PURE — clusters `tabs` by kind, preserving FIRST-OPEN order: the order each kind is first seen
/// while scanning `tabs` left to right. `tabs` (`store.tabs`) is already fold order —
/// `foldPanelTabs` (`PanelTab.swift`) only ever APPENDS, never reorders or sorts — so "first seen
/// while scanning" and "first opened" are the same order by construction, not by coincidence.
/// Stable within a kind too, for the identical reason: one pass, appending each tab to its kind's
/// bucket in place, never sorting. One-tab kinds fall out with no special case (the brief's own
/// uniformity requirement) — a kind seen once is a bucket of one, indistinguishable in shape from a
/// bucket of ten.
func panelStripKindGroups(tabs: [PanelTab]) -> [PanelStripKindGroup] {
    var groups: [PanelStripKindGroup] = []
    for tab in tabs {
        if let index = groups.firstIndex(where: { $0.kind == tab.kind }) {
            groups[index].tabs.append(tab)
        } else {
            groups.append(PanelStripKindGroup(kind: tab.kind, tabs: [tab]))
        }
    }
    return groups
}

/// PURE — the kind actually rendered expanded THIS frame, resolving `mode` against the CURRENT
/// `groups` rather than trusting `mode`'s own payload blindly. The two can disagree: closing the
/// last tab of the expanded kind removes that kind's group entirely (`panelStripKindGroups` never
/// emits an empty group), and nothing about closing a tab necessarily changes `mode` itself —
/// `foldPanelTabs` nils `activeTabId` only when the CLOSED tab was the active one, so closing some
/// OTHER (non-active) tab of the expanded kind leaves `mode`'s `expandedKind` pointing at a kind
/// with zero groups. Left unresolved, EVERY group would render collapsed at once — violating the
/// contract's own "exactly ONE kind expanded" the moment it happens. Falling back to the first
/// remaining group keeps that contract honest without `mode` itself needing to react to every
/// possible way a group can disappear; the underlying state heals for real on the next resize,
/// click, or `activeTabId` change.
///
/// Beyond the brief's literal list, disclosed in the task report — the same "close a real hole a
/// mechanism would otherwise leave open" shape as Task 6's ctx wiring.
func panelStripEffectiveExpandedKind(mode: PanelStripMode, groups: [PanelStripKindGroup]) -> PanelTabKind? {
    guard case .grouped(let expandedKind) = mode else { return nil }
    if groups.contains(where: { $0.kind == expandedKind }) { return expandedKind }
    return groups.first?.kind
}

/// PURE — the one predicate `PanelTabStrip`'s row-builder asks per group ("do I draw this as pills
/// or a chip?"), built on `panelStripEffectiveExpandedKind` so that decision and "which kind a
/// click actually swaps to" can never quietly disagree — there is one function that resolves
/// "expanded," not two independent readings of `mode`.
func panelStripIsExpanded(_ kind: PanelTabKind, mode: PanelStripMode, groups: [PanelStripKindGroup]) -> Bool {
    kind == panelStripEffectiveExpandedKind(mode: mode, groups: groups)
}

/// PURE — a collapsed chip's click: expand `kind`, unconditionally. There is only one
/// `expandedKind` slot in `PanelStripMode.grouped`, so setting it to a NEW kind IS collapsing
/// whatever was expanded before — nothing separate has to be told to close.
func panelStripExpand(_ kind: PanelTabKind) -> PanelStripMode {
    .grouped(expandedKind: kind)
}

/// PURE — the auto-expand rule: `store.activeTabId` moving to a tab of a collapsed kind (a
/// transcript chip click opening/activating a diff tab, a browser popup, "+", or an agent-opened
/// tab — the brief's own list) takes over the expansion, same as a chip click would. A no-op while
/// `.flat` (nothing is collapsed to auto-expand) and a no-op when the new tab's kind is ALREADY the
/// expanded one (idempotent — an active tab moving between two tabs of the SAME kind must not
/// retrigger the expand animation for no visible change). `newActiveKind` is a plain,
/// already-resolved kind rather than a tab id — the caller (the strip's `activeTabId` watcher) is
/// the one holding `store.tabs` to look it up in; this function has no reason to see the tab list.
func panelStripAutoExpand(mode: PanelStripMode, newActiveKind: PanelTabKind) -> PanelStripMode {
    guard case .grouped(let expandedKind) = mode, expandedKind != newActiveKind else { return mode }
    return panelStripExpand(newActiveKind)
}
