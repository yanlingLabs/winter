import AppKit

/// DIRECT TRANSPLANT of v1's `FieldCorner` (TextField/GlassFieldWindow.swift:2172-2284) —
/// verbatim, minus the dashboard/chat branch (see `GlassFieldSurface` below) and minus
/// `choose(anchor:interiorSize:padding:)` (see the file-bottom note: task B replaces v1's
/// per-corner switching with a continuous edge fence, by user directive).

/// Reduced port of v1's `GlassFieldSurface` (TextField/GlassFieldWindow.swift:14-18: originally
/// `case composer, dashboard, chat`) — dashboard/chat are cut for this transplant, so only the
/// one case `windowOrigin(...)` actually needs remains. Kept as a real (single-case) enum rather
/// than dropping the parameter entirely so `windowOrigin`'s signature stays verbatim per the
/// brief; task B can reintroduce `.dashboard`/`.chat` here (and in `windowOrigin`'s switch) if
/// those surfaces come back.
enum GlassFieldSurface: Sendable {
    case composer
}

// MARK: - FieldCorner

/// Which corner of the COMPOSER pill sits over the orb. The window itself is
/// a fixed size big enough to contain the composer, a gap, the nav pill, and
/// halo padding on every side. The corner just determines (a) which screen
/// quadrant the UI extends into, and (b) how the interior is laid out — top
/// corners put the composer at the top (at the orb) with the nav pill below;
/// bottom corners invert that.
enum FieldCorner {
    case topLeft, topRight, bottomLeft, bottomRight

    /// True when this corner anchors the composer along the top edge of the
    /// window (composer near the orb, nav pill underneath it).
    var composerOnTop: Bool {
        switch self {
        case .topLeft, .topRight:       return true
        case .bottomLeft, .bottomRight: return false
        }
    }

    /// True when this corner anchors to the left side of the window.
    var isLeft: Bool {
        switch self {
        case .topLeft, .bottomLeft:   return true
        case .topRight, .bottomRight: return false
        }
    }

    /// The point inside the window (SwiftUI coordinate space, y grows down)
    /// where the orb sits when the composer is docked here. This is the
    /// corner of the composer pill that touches the orb.
    ///
    /// The nav pill is always ABOVE the composer, so for top corners the
    /// composer is pushed down inside the window (to leave room for the
    /// nav pill above it). For bottom corners the composer is at the
    /// window bottom and the nav pill lives in the space above.
    func orbAnchorInWindow(windowSize: CGSize, morph: MorphModel) -> CGPoint {
        let P = morph.haloPadding
        let navOffset = morph.navPillHeight + morph.interPillGap
        switch self {
        case .topLeft:
            // Composer's top-left is at orb. Nav pill above composer, so
            // composer.top = P + navHeight + gap (nav pill occupies the top
            // of the interior).
            return CGPoint(x: P, y: P + navOffset)
        case .topRight:
            return CGPoint(x: windowSize.width - P, y: P + navOffset)
        case .bottomLeft:
            // Composer's bottom-left is at orb. Composer sits at the
            // bottom of the interior. Nav pill is above it.
            return CGPoint(x: P, y: windowSize.height - P)
        case .bottomRight:
            return CGPoint(x: windowSize.width - P, y: windowSize.height - P)
        }
    }

    /// Window origin in macOS screen space (bottom-left convention) such that
    /// the composer's chosen corner ends up at `glassAnchor`.
    func windowOrigin(
        glassAnchor: CGPoint,
        morph: MorphModel,
        windowSize: CGSize? = nil,
        surface: GlassFieldSurface
    ) -> CGPoint {
        let size = windowSize ?? morph.windowSize
        let local: CGPoint
        switch surface {
        case .composer:
            local = orbAnchorInWindow(windowSize: size, morph: morph)
        }
        return CGPoint(
            x: glassAnchor.x - local.x,
            y: glassAnchor.y - (size.height - local.y)
        )
    }
}

// MARK: - Edge fence (task B: replaces v1's `FieldCorner.choose` corner-switching)

/// User directive: `morphModel.corner` stays `.topLeft` FOREVER — v1's alternative (switch to
/// `.topRight`/`.bottomLeft`/`.bottomRight` so the interior never spills off-screen, `choose`
/// above) is gone. Instead, this function clamps the tracking spring's TARGET anchor so that
/// `.topLeft`'s own geometry (`orbAnchorInWindow`/`windowOrigin` above: the expanded frame grows
/// down-and-right from the anchor, with `haloPadding` clearance on the left/top edge and an
/// extra `navOffset` — nav pill height + inter-pill gap — above the composer) always keeps the
/// FULL EXPANDED (`expandedSize`) frame on-screen, no matter which way the collapsed orb is
/// currently sized. The orb visibly stops at the fence while the cursor keeps going past it —
/// v1's "pin" behavior (GlassFieldWindow.swift's Dynamic-Island-hover pin), reproduced here with
/// plain geometry instead of a separate pin subsystem v2 doesn't have.
///
/// PURE — no AppKit/screen lookups; `visibleFrame` is the caller's job to resolve (matching
/// `OrbFollower.currentVisibleFrame()`'s existing cursor-relative screen lookup).
func fenceAnchorForTopLeftCorner(
    _ anchor: CGPoint,
    expandedSize: CGSize,
    haloPadding: CGFloat,
    navOffset: CGFloat,
    visibleFrame: CGRect,
    margin: CGFloat = 16
) -> CGPoint {
    let bounds = visibleFrame.insetBy(dx: margin, dy: margin)

    // Derived from `FieldCorner.topLeft`'s own `orbAnchorInWindow`/`windowOrigin` math:
    //   origin.x = anchor.x - haloPadding
    //   origin.y = anchor.y - expandedSize.height + haloPadding + navOffset
    // The expanded frame spans [origin, origin + expandedSize]; solving each edge constraint
    // for `anchor` gives the bounds below. `Swift.max` on the top/right bounds keeps the range
    // non-empty (collapsing to a single point) on a screen too small to ever fit the expanded
    // frame, rather than producing an inverted min > max range.
    let minX = bounds.minX + haloPadding
    let maxX = Swift.max(minX, bounds.maxX - expandedSize.width + haloPadding)
    let minY = bounds.minY + expandedSize.height - haloPadding - navOffset
    let maxY = Swift.max(minY, bounds.maxY - haloPadding - navOffset)

    return CGPoint(
        x: Swift.min(Swift.max(anchor.x, minX), maxX),
        y: Swift.min(Swift.max(anchor.y, minY), maxY)
    )
}
