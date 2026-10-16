import AppKit
import WinterCUPresentation

// The Winter island's geometry (`docs/claude/island.md`). Points, top-left origin, x measured from the screen's
// horizontal centre (the island is always centred under the housing). Pure — `IslandLayoutTests`.

/// The top of the island's screen: its camera housing (nil without one) and its menu bar's height.
struct IslandScreenShape: Equatable {
    var housing: CGSize?
    var menuBarHeight: CGFloat

    /// What everything is born from and hangs below: the housing's height, or the menu bar's without one.
    var topInset: CGFloat { housing.map(\.height) ?? max(menuBarHeight, 22) }
    var hasHousing: Bool { housing != nil }
}

enum IslandLayout {
    // The slim strip.
    /// Each side of the housing the strip extends it by (where its icon and count sit).
    static let stripWing: CGFloat = 46
    /// Without a housing: a short black tab hanging from the top centre.
    static let stripWidthWithoutHousing: CGFloat = 112
    static let stripCorner: CGFloat = 10

    // A card on top.
    static let cardWidth: CGFloat = 400
    static let cardCorner: CGFloat = 24
    static let cardPadding: CGFloat = 16

    // The waiting pill under a hovered card, and the badge hugging the housing.
    static let waitingHeight: CGFloat = 32
    static let waitingWidth: CGFloat = 280
    static let waitingGap: CGFloat = 8
    static let badgeHeight: CGFloat = 26
    /// The badge tucks this far up under the strip's edge, so it reads as hanging from it.
    static let badgeTuck: CGFloat = 4

    // The open island.
    static let islandWidth: CGFloat = 520
    static let islandMaxHeight: CGFloat = 560
    static let islandCorner: CGFloat = 32

    /// The strip's rect (x from the centre).
    static func strip(_ shape: IslandScreenShape) -> CGRect {
        if let housing = shape.housing {
            let width = housing.width + 2 * stripWing
            return CGRect(x: -width / 2, y: 0, width: width, height: housing.height)
        }
        let height = max(shape.menuBarHeight, 22)
        return CGRect(x: -stripWidthWithoutHousing / 2, y: 0, width: stripWidthWithoutHousing, height: height)
    }

    /// The liquid geometry for a card of `size` resting below the housing: the desktop-switch pill's own (`make`),
    /// with a rectangle's height and corners for an approval or question.
    static func cardGeometry(_ shape: IslandScreenShape, size: CGSize, rounded: Bool) -> DesktopIslandGeometry {
        var g = DesktopIslandGeometry.make(housing: shape.housing, menuBarHeight: shape.menuBarHeight,
                                           pillWidth: size.width, slot: 0)
        g.pill.size.height = size.height
        g.panelSize.height = g.pill.maxY + DesktopIslandGeometry.margin
        g.bodyCornerRadius = rounded ? cardCorner : nil
        return g
    }

    /// The waiting pill's rect inside a card's panel: just below the card.
    static func waitingRect(below geometry: DesktopIslandGeometry) -> CGRect {
        CGRect(x: geometry.pill.midX - waitingWidth / 2, y: geometry.pill.maxY + waitingGap, width: waitingWidth,
               height: waitingHeight)
    }

    /// The badge's rect (x from the centre): hanging from the housing (or the strip without one).
    static func badge(_ shape: IslandScreenShape, width: CGFloat) -> CGRect {
        CGRect(x: -width / 2, y: shape.topInset - badgeTuck, width: width, height: badgeHeight)
    }

    /// The open island's rect (x from the centre): its top is the screen's top — it grows out of the housing.
    static func island(_ shape: IslandScreenShape, contentHeight: CGFloat) -> CGRect {
        let height = min(islandMaxHeight, shape.topInset + contentHeight)
        return CGRect(x: -islandWidth / 2, y: 0, width: islandWidth, height: height)
    }

    /// Which screen the island lives on: the one with a camera housing, else the main screen (never the screen the
    /// pointer happens to be on — the island is a fixed place, unlike the desktop-switch prompt of the helper).
    @MainActor static func islandScreen(_ screens: [NSScreen] = NSScreen.screens) -> NSScreen? {
        screens.first { CUScreenHousing.size(of: $0) != nil } ?? NSScreen.main ?? screens.first
    }

    @MainActor static func shape(of screen: NSScreen) -> IslandScreenShape {
        IslandScreenShape(housing: CUScreenHousing.size(of: screen),
                          menuBarHeight: screen.frame.maxY - screen.visibleFrame.maxY)
    }
}
