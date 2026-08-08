import AppKit
import SwiftUI

/// panel-shell T2: MEASURED from the reference at @2x (halve pixels for points). The tab row and
/// the URL row share ONE continuous band — there is no hairline between them, and adding one reads
/// as visibly wrong. The only hairline is where content begins.
let panelChromeBandHeight: CGFloat = 85

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

/// The panel column. Owns the chrome band and the content area; the tab strip and the per-kind
/// chrome slot arrive in Tasks 9 and 10.
struct ShellPanel: View {
    var body: some View {
        VStack(spacing: 0) {
            // The chrome band: one continuous surface, no internal divider.
            Color.clear
                .frame(height: panelChromeBandHeight)

            Divider()
                .frame(height: panelDividerWidth)
                .overlay(Theme.hairline)

            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        // `Theme.cardSurface`/`Theme.hairline` ARE `Color("CardSurface")`/`Color("Hairline")` (see
        // `Theme.swift`) — going through the named layer rather than a raw asset lookup, matching
        // every other consumer of these two tokens in `ShellSidebar.swift`.
        .background(Theme.cardSurface)
        .clipShape(panelShape)
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
                        let base = dragStartWidth ?? width
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
