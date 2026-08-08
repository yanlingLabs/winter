import AppKit
import SwiftUI

/// panel-shell T2: MEASURED from the reference at @2x (halve pixels for points). The tab row and
/// the URL row share ONE continuous band — there is no hairline between them, and adding one reads
/// as visibly wrong. The only hairline is where content begins.
let panelChromeBandHeight: CGFloat = 85

/// panel-shell T8: MEASURED at @2x from the reference
/// (docs/research/reference/chatgpt-panel-titlebar-band-2026-08-08.png). The pill is a capsule —
/// the radius is DERIVED from the height so the two can never drift apart.
let panelTabPillSize = CGSize(width: 156, height: 28)
let panelTabPillInset: CGFloat = 9
let panelTabPillRadius: CGFloat = panelTabPillSize.height / 2
let panelNewTabButtonGap: CGFloat = 18

/// panel-shell T8: the window's top band, SHARED by every column — the panel's slice of it holds
/// the tab strip, at the window top, level with the traffic lights (not below a titlebar). See
/// `ShellPanel`'s `.ignoresSafeArea` for what makes that literally true rather than aspirational.
let panelTitlebarBandHeight: CGFloat = 45

/// The rest of the chrome band, below the tab strip. This is Plan B's URL row (CEF's browser
/// chrome) — rendered blank here. Still no hairline between the two rows; see
/// `panelChromeBandHeight`'s own doc comment.
let panelUrlRowHeight: CGFloat = panelChromeBandHeight - panelTitlebarBandHeight

/// The panel mirrors the detail card: that card rounds its LEADING corners, this rounds its
/// TRAILING ones. Derived, so the two can never drift apart.
let panelCornerRadius: CGFloat = shellDetailCardCornerRadius

let panelDividerWidth: CGFloat = shellSidebarHairlineWidth

/// The panel's rounded shape — trailing corners only, for the reason above.
let panelShape = UnevenRoundedRectangle(
    topLeadingRadius: 0,
    bottomLeadingRadius: 0,
    bottomTrailingRadius: panelCornerRadius,
    topTrailingRadius: panelCornerRadius,
    style: .continuous
)

/// The panel column. Owns the chrome band and the content area. panel-shell T8 fills the chrome
/// band's top 45pt (`panelTitlebarBandHeight`) with the tab strip; the rest of the band
/// (`panelUrlRowHeight`, Plan B's URL row) and the per-kind content slot below the hairline are
/// later work.
struct ShellPanel: View {
    @ObservedObject var store: PanelStore
    /// `nil` for a shell built without one (`ShellSidebar`'s own `host` property takes the
    /// identical fallback posture) — the strip's controls then fire nothing (each host method's
    /// own `attachedSessionId` guard).
    var host: ShellSessionHost? = nil

    var body: some View {
        VStack(spacing: 0) {
            // The chrome band: one continuous surface, no internal divider. Two vertical slices —
            // the tab strip (top `panelTitlebarBandHeight`) and Plan B's blank URL row below it —
            // but still ONE surface: nothing here draws a line between them.
            VStack(spacing: 0) {
                PanelTabStrip(
                    store: store,
                    onOpenTab: { host?.openPanelTab(kind: .web) },
                    onActivateTab: { tabId in host?.activatePanelTab(tabId) },
                    onCloseTab: { tabId in host?.closePanelTab(tabId) }
                )
                .frame(height: panelTitlebarBandHeight)

                Color.clear
                    .frame(height: panelUrlRowHeight)
            }
            .frame(height: panelChromeBandHeight)

            Divider()
                .frame(height: panelDividerWidth)
                .overlay(Theme.hairline)

            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        // review round 2, Important 2 (Task 2, plan-mandated fix, adjudicated by the user): a
        // BACKGROUND LAYER that ignores the safe area, not a clip on the content — `ShellSidebar
        // .swift` documents the trap this avoided on `detail`'s own card. That fix was correct for
        // the SHAPE (the corners reach the true window edge) but, carried into Task 8
        // (`.superpowers/sdd/2026-08-08-panel-shell-a-frame-and-tab-state/progress.md`, "Task 2:
        // CARRY TO TASK 8"), incomplete for the CONTENT: the background ignored the top safe area
        // while this VStack did not, so the chrome band still rendered ~28pt below the true window
        // top and every metric above measured from the wrong origin.
        //
        // Task 8 supersedes that treatment with the one `ShellSidebar` itself uses for its own
        // pane (`ShellSidebar.swift`, its `.background(...).ignoresSafeArea(.container, edges:
        // .top)` chained directly on the pane's content, not nested inside the background
        // closure): the background loses its OWN internal `.ignoresSafeArea()` and instead
        // `.ignoresSafeArea(.container, edges: .top)` is chained AFTER `.background` below, so it
        // applies to the composite (this VStack plus the shape attached to it), not the shape
        // alone. That is required now, not merely tidy — the user's reference decision for this
        // task (docs/research/reference/chatgpt-panel-titlebar-band-2026-08-08.png) puts the tab
        // strip's pill AT the window top, level with the traffic lights, and every measured offset
        // in `PanelTabStrip` below is taken from that same top edge.
        //
        // `Theme.cardSurface` IS `Color("CardSurface")` (see `Theme.swift`) — going through the
        // named layer rather than a raw asset lookup, matching every other consumer of it in
        // `ShellSidebar.swift`.
        .background {
            panelShape
                .fill(Theme.cardSurface)
        }
        .ignoresSafeArea(.container, edges: .top)
    }
}

// MARK: - panel-shell T8: the tab strip

/// The chrome band's top 45pt (`panelTitlebarBandHeight`) — every open tab as a pill, then `+`.
/// Tabs come from `PanelStore` (Task 7): this view only ever READS `store.tabs`/`store.activeTabId`
/// and reports taps outward through its three closures — see the type's own doc below for why it
/// never mutates the store itself.
///
/// Reserves trailing space (a flexible `Spacer`) for Task 10's expand/bottom-bar/sidebar cluster —
/// this task lays the row out to fit them but does not add, move or restyle any of the three.
struct PanelTabStrip: View {
    @ObservedObject var store: PanelStore
    var onOpenTab: () -> Void = {}
    var onActivateTab: (String) -> Void = { _ in }
    var onCloseTab: (String) -> Void = { _ in }

    var body: some View {
        HStack(spacing: panelNewTabButtonGap) {
            ForEach(store.tabs) { tab in
                PanelTabPill(
                    tab: tab,
                    isActive: tab.tabId == store.activeTabId,
                    onActivate: { onActivateTab(tab.tabId) },
                    onClose: { onCloseTab(tab.tabId) }
                )
            }
            newTabButton
            // Task 10's three buttons land here — reserved, not built. The minimum is DERIVED
            // from the existing trailing cluster's own metrics (`ShellSidebar.swift`), never a
            // literal: the inset from the panel's trailing edge plus three buttons plus the two
            // gaps between them. Review fix (round 1, Important 1): `minLength: 0` reserved
            // nothing at all — a comment claiming space was reserved when the code reserved zero
            // is the same "asserts a property the code doesn't have" class this file is careful
            // about elsewhere.
            Spacer(minLength: shellTitlebarTrailingInset
                             + 3 * shellTitlebarButtonSize
                             + 2 * shellTitlebarClusterSpacing)
        }
        .padding(.leading, panelTabPillInset)
        .padding(.top, panelTabPillInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var newTabButton: some View {
        Button(action: onOpenTab) {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
                .frame(width: panelTabPillSize.height, height: panelTabPillSize.height)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("New tab")
        .accessibilityLabel("New tab")
    }
}

/// One tab pill. Only the ACTIVE tab is filled — `Theme.rowHover`, the brief's "RowHover register"
/// — so there is exactly one filled pill at a time; an inactive tab sits flush on the strip's own
/// background. Every offset below is measured from the PILL's own leading or trailing edge (the
/// brief's "+9.5pt from the pill's leading edge" etc.), not from a neighbouring element, which is
/// why each piece is positioned by its own absolute padding inside a leading-aligned `ZStack`
/// (favicon, label) or a trailing `.overlay` (the close button) rather than by `HStack` spacing.
///
/// **Fires two RPCs, applies neither locally.** Both closures only report the tap outward
/// (`onActivate`/`onClose`); see `ShellSessionHost`'s panel-tab-strip section for why they end at
/// the wire and never touch `PanelStore` themselves.
private struct PanelTabPill: View {
    let tab: PanelTab
    let isActive: Bool
    let onActivate: () -> Void
    let onClose: () -> Void

    var body: some View {
        Button(action: onActivate) {
            ZStack(alignment: .leading) {
                if isActive {
                    RoundedRectangle(cornerRadius: panelTabPillRadius, style: .continuous)
                        .fill(Theme.rowHover)
                }
                Image(systemName: panelTabFaviconSystemImage(tab.kind))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.leading, 9.5)
                Text(panelTabDisplayTitle(tab))
                    .font(.system(size: 12))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 33)
                    .padding(.trailing, 30) // stop clear of the close button, overlaid below
            }
            .frame(width: panelTabPillSize.width, height: panelTabPillSize.height, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: panelTabPillRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.trailing, 15)
            .accessibilityLabel("Close \(panelTabDisplayTitle(tab))")
        }
        .help(panelTabDisplayTitle(tab))
        .accessibilityLabel(panelTabDisplayTitle(tab))
    }
}

/// A placeholder favicon keyed off the tab's kind, not a fetched site icon — Plan A never loads
/// real content (a page's own favicon is Plan B/CEF's), so the kind is the only signal there is.
/// Exhaustive on purpose, no `default:` — `PanelTabKind`'s own doc comment (`PanelTab.swift`)
/// explains why a future case must fail this to compile rather than fall back silently.
func panelTabFaviconSystemImage(_ kind: PanelTabKind) -> String {
    switch kind {
    case .web: return "globe"
    case .document: return "doc.text"
    case .code: return "chevron.left.forwardslash.chevron.right"
    case .note: return "note.text"
    }
}

/// A tab's display title before the daemon has reported one (`panel_tab_navigated` hasn't landed
/// yet, or never will for a non-web kind) — never a blank pill. Same exhaustiveness discipline as
/// `panelTabFaviconSystemImage` above.
func panelTabDisplayTitle(_ tab: PanelTab) -> String {
    if let title = tab.title, !title.isEmpty { return title }
    switch tab.kind {
    case .web: return "New Tab"
    case .document: return "Document"
    case .code: return "Code"
    case .note: return "Note"
    }
}

/// The draggable divider. Dragging CLAMPS — it never promotes to `.maximized`.
struct PanelDivider: View {
    @Binding var width: CGFloat
    let contentWidth: CGFloat

    /// `DragGesture.Value.translation` is the CUMULATIVE offset since the gesture began, not a
    /// per-event delta — SwiftUI's own contract for it. Recomputing against the live `width`
    /// binding on every event (as opposed to the width the drag STARTED from) would re-subtract
    /// that same growing cumulative translation on top of an already-shifted base each time,
    /// compounding into a runaway drag (a 10 pt mouse move would not move the divider 10 pt, and
    /// the error would grow with every event the gesture fires). Anchoring on the first event of
    /// each gesture and clearing on release keeps every computation relative to ONE fixed base.
    @State private var dragStartWidth: CGFloat?

    var body: some View {
        Rectangle()
            .fill(Theme.hairline)
            .frame(width: panelDividerWidth)
            .contentShape(Rectangle().inset(by: -4))   // a 1pt line is not a grabbable target
            .onHover { $0 ? NSCursor.resizeLeftRight.push() : NSCursor.pop() }
            .gesture(
                DragGesture(coordinateSpace: .global)
                    .onChanged { value in
                        // review round 2, Important 1: anchor on the CLAMPED (on-screen) width,
                        // not the raw stored `width`. `width` can be stale relative to the
                        // current `contentWidth` — e.g. after the window narrows without a drag
                        // happening — and `ShellPanel`'s own render already clamps on read
                        // (`ShellSidebar.swift`), so anchoring on the unclamped value would start
                        // the drag from a point that is not where the divider is actually drawn,
                        // making it dead until a compensating drag closes the gap.
                        let base = dragStartWidth ?? panelClampWidth(width, contentWidth: contentWidth)
                        dragStartWidth = base
                        width = panelClampWidth(base - value.translation.width,
                                                contentWidth: contentWidth)
                    }
                    .onEnded { _ in
                        dragStartWidth = nil
                    }
            )
    }
}
