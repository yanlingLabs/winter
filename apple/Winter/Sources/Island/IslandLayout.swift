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

/// The parts of the strip a click can land on.
enum IslandStripPart: Equatable {
    /// The left wing: the amber "waiting for you" symbol and its count (every compacted card is counted here).
    case waitingWing
    /// The housing itself (or an empty wing).
    case housing
    /// The right wing: the bolt and the working sessions' count.
    case workingWing

    /// PURE: the tab a click on this part opens the island on (nil: the island's current tab).
    var tab: String? {
        switch self {
        case .waitingWing: return IslandTabRegistry.needsYou.id
        case .workingWing: return IslandTabRegistry.sessions.id
        case .housing: return nil
        }
    }

    /// What a click on the strip does. PURE.
    enum Action: Equatable {
        /// Open the island, on this tab (nil: the one it was on).
        case open(tab: String?)
        /// The island is open on another tab: show this one.
        case select(String)
        case close
    }

    /// Closed: open (on the wing's tab). Open: a wing whose tab is not showing switches to it; anything else closes.
    func action(isOpen: Bool, selectedTab: String?) -> Action {
        guard isOpen else { return .open(tab: tab) }
        if let tab, tab != selectedTab { return .select(tab) }
        return .close
    }
}

enum IslandLayout {
    // The slim strip.
    /// Each side of the housing the strip extends it by (where its icon and count sit).
    static let stripWing: CGFloat = 46
    /// Without a housing: a short black tab hanging from the top centre.
    static let stripWidthWithoutHousing: CGFloat = 112
    static let stripCorner: CGFloat = 10
    /// Around the strip's panel (the sides and below): room for its dark hover glow (`PillHoverGlowMetrics.farRadius`
    /// plus a little). Transparent while not hovered, so a click there reaches the menu bar.
    static let stripGlowMargin: CGFloat = 14

    // A card on top.
    static let cardWidth: CGFloat = 400
    static let cardCorner: CGFloat = 24
    static let cardPadding: CGFloat = 16

    // The waiting pill under a hovered card.
    static let waitingHeight: CGFloat = 32
    static let waitingWidth: CGFloat = 280
    static let waitingGap: CGFloat = 8

    // Inside the open island and on the cards: ONE corner for the rows and inner cards (a Needs-you link or view
    // request, a Watches row, a Sessions row, a Usage, Devices or Servers row, a Shelf tile), one list gap, one side
    // inset.
    static let rowCorner: CGFloat = 16
    static let rowGap: CGFloat = 8
    static let listInset: CGFloat = 14
    /// The transcript interaction card's corner: Needs you's cards (the transcript's own, a link, a view request).
    static let innerCardCorner: CGFloat = 28
    /// The open island's header (and Needs you's card headers) from the island's edge.
    static let headerInset: CGFloat = 20

    // The open island: ONE size for every tab and any content (user 2026-10-17) — each tab scrolls inside it. 560 is
    // the island family's widest (the typing Dispatch pill, the desktop-switch pill's ceiling); 168 (user: ~2/5 of the
    // first 420) keeps it a compact extension of the housing — with a housing the header sits beside it, in its band,
    // so all of it under the housing is the list. Clamped on any screen too short for it (`island(_:screenHeight:)`).
    static let islandWidth: CGFloat = 560
    static let islandHeight: CGFloat = 168
    static let islandCorner: CGFloat = 32
    /// The concave shoulders by which the open island's flat top flares into the screen's edge (`IslandEdgeShape`).
    static let islandShoulder: CGFloat = 14
    /// The most of a screen's height the open island takes on a short screen.
    static let islandMaxScreenFraction: CGFloat = 0.6

    /// The strip's rect (x from the centre), or nil when it is not there. While NOTHING waits it never covers anything
    /// the menu bar could have: with a housing it is exactly the housing (where no menu item can be — a click there
    /// still opens the island), without one there is none (an empty island has nothing to show). Its wings — and the
    /// tab without a housing — appear, and take clicks, only while they show something.
    static func strip(_ shape: IslandScreenShape, waiting: Bool) -> CGRect? {
        if !waiting {
            guard let housing = shape.housing else { return nil }
            return CGRect(x: -housing.width / 2, y: 0, width: housing.width, height: housing.height)
        }
        return strip(shape)
    }

    /// The strip with something waiting (x from the centre).
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

    /// Which part of the strip a point is over (x from the centre, y from the top), nil outside it. The waiting wing
    /// (the amber symbol and its count) and the working wing are only "there" while they show a count: an empty wing is
    /// the housing's. Without a housing the tab shows both side by side — each half is its group when both show, the
    /// whole tab when only one does.
    static func stripPart(at p: CGPoint, _ shape: IslandScreenShape, model: IslandStripModel) -> IslandStripPart? {
        guard let rect = strip(shape, waiting: model.showsWings), rect.contains(p) else { return nil }
        let waiting = model.waitingCount > 0
        let working = model.workingCount > 0
        if let housing = shape.housing {
            if p.x < -housing.width / 2 { return waiting ? .waitingWing : .housing }
            if p.x > housing.width / 2 { return working ? .workingWing : .housing }
            return .housing
        }
        switch (waiting, working) {
        case (true, true): return p.x < 0 ? .waitingWing : .workingWing
        case (true, false): return .waitingWing
        case (false, true): return .workingWing
        case (false, false): return .housing
        }
    }

    /// The open island's rect (x from the centre): its top is the screen's top — it grows out of the housing. FIXED:
    /// the same for every tab and whatever it lists (the contents scroll inside); only a screen too short for it
    /// clamps the height (`islandMaxScreenFraction`), still the same for every tab on that screen.
    static func island(_ shape: IslandScreenShape, screenHeight: CGFloat? = nil) -> CGRect {
        var height = islandHeight
        if let screenHeight, screenHeight > 0 {
            height = min(height, max(shape.topInset + 160, (screenHeight * islandMaxScreenFraction).rounded(.down)))
        }
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
