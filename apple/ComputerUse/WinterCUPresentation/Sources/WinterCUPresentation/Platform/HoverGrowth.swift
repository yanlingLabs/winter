import CoreGraphics
import SwiftUI

/// How much a floating panel grows under the pointer: the SAME few points for every panel, whatever its size
/// (user ruling 2026-10-17: a relative 3 % made a large card grow far more than the pill it came from).
///
/// The reference is the COMPACT Dispatch pill (316 × 44 pt) and its 3 % grow — 9.48 pt wider (and 1.32 pt taller).
/// Every panel's WIDTH grows by exactly those 9.48 pt; its height grows in proportion, so the scale is uniform (no
/// stretched text) and the compact pill grows exactly as it always did (316 → 1.03 on both axes). A larger panel grows
/// by a smaller factor: a 440 pt card by 2.15 %, a 560 pt one by 1.69 %. Winter.app pins the reference against
/// `DispatchPillMetrics` (`HoverGrowthTests`); the helper's desktop-switch pill and the island use it as well.
public enum HoverGrowth {
    /// The compact Dispatch pill: the panel whose grow everything else matches.
    public static let referenceSize = CGSize(width: 316, height: 44)
    /// The compact pill's own grow under the pointer.
    public static let referenceScale: CGFloat = 1.03
    /// The points every panel's width grows by: the compact pill's 3 % (9.48 pt).
    public static let points: CGFloat = referenceSize.width * (referenceScale - 1)
    /// The spring the grow rides (the Dispatch pill's).
    public static let animation = Animation.spring(response: 0.3, dampingFraction: 0.7)

    /// PURE: the per-axis scale for a panel of `size` under the pointer — `1 + points / width` on both axes (equal by
    /// design: the width grows by `points`, the height in proportion). 1 for an empty size.
    public static func scale(for size: CGSize) -> CGSize {
        let s = factor(forWidth: size.width)
        return CGSize(width: s, height: s)
    }

    /// PURE: the uniform factor for a panel this wide.
    public static func factor(forWidth width: CGFloat) -> CGFloat {
        width > 0 ? 1 + points / width : 1
    }

    /// PURE: `rect` grown about `anchor` (a unit point of the rect: `.top` for the island's panels, `.bottom` for the
    /// Dispatch pill's stack) — what a hovered panel covers, and so its hit area while hovered.
    public static func grown(_ rect: CGRect, anchor: UnitPoint) -> CGRect {
        grown(rect, about: CGPoint(x: rect.minX + rect.width * anchor.x, y: rect.minY + rect.height * anchor.y),
              scale: scale(for: rect.size))
    }

    /// PURE: `rect` scaled by `scale` about the point `pivot` (any rect drawn inside a scaled view, e.g. the Dispatch
    /// pill's floating layers scaled with the whole stack).
    public static func grown(_ rect: CGRect, about pivot: CGPoint, scale: CGSize) -> CGRect {
        CGRect(x: pivot.x + (rect.minX - pivot.x) * scale.width, y: pivot.y + (rect.minY - pivot.y) * scale.height,
               width: rect.width * scale.width, height: rect.height * scale.height)
    }
}

extension View {
    /// Grows by `HoverGrowth.scale(for: size)` about `anchor` while `hovered`; the animation is scoped to the scale
    /// alone (a container-wide one would also ease a layout something else drives frame by frame).
    public func hoverGrowth(_ hovered: Bool, size: CGSize, anchor: UnitPoint) -> some View {
        let s = HoverGrowth.scale(for: size)
        return animation(HoverGrowth.animation) { view in
            view.scaleEffect(x: hovered ? s.width : 1, y: hovered ? s.height : 1, anchor: anchor)
        }
    }
}
