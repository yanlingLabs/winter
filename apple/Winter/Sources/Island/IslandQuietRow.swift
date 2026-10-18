import SwiftUI

// The island's quiet rows (`docs/claude/island.md`, "Island visual language"): no card behind a row — its mark, its
// main line and its muted words, over a thin line (`HoverLine`, `Sources/Usage/HoverLine.swift`) that thickens and
// speaks under the pointer. Every tab but Needs you draws its rows with these measures, so their lines start and end
// at one x and every row keeps its hovered height at rest (nothing below moves).

enum IslandQuietRow {
    /// From the island's edge to a row: the header's own inset, so a row's mark sits under the tab's title.
    static let inset: CGFloat = IslandLayout.headerInset
    /// The main line's band: the 14 pt typed text grown 12 % (`HoverLift.labelScale`) still fits.
    static let titleHeight: CGFloat = 22
    /// Between the main line and its line.
    static let lineGap: CGFloat = 4
    /// The leading mark's column (a state's symbol); the line starts after it.
    static let markWidth: CGFloat = 14

    /// PURE: a quiet row's height — the same at rest and under the pointer (the line's hovered thickness is reserved).
    static var height: CGFloat { titleHeight + lineGap + HoverLift.hoverThickness }

    /// PURE: whether a row's actions show — under the pointer, or while one of them is in the middle of something (a
    /// Stop waiting for its second click, stopping, offering a force quit) or has failed: those never hide when the
    /// pointer drifts off.
    static func showsActions(hovered: Bool, busy: Bool) -> Bool { hovered || busy }
}
