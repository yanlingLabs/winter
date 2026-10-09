import CoreGraphics

/// Everything the cursor looks like at one instant, in the target window's local space (points, top-left origin). The
/// timeline computes it; the rig draws it. Values, not views, so a frame can be tested, rendered offscreen, or mapped
/// into the mirror's smaller space.
struct CursorFrame: Equatable {
    var visible = false
    /// The whole cursor's opacity (body, badge, caption): the appear and fade ramps.
    var opacity: CGFloat = 0
    /// Where the arrow points.
    var tip: CGPoint = .zero
    /// Lean into motion, radians, positive clockwise (y-down space).
    var tilt: CGFloat = 0
    /// Squash on press, appear and fade scale. 1 at rest.
    var scale: CGFloat = 1
    /// The arrow's own opacity: 0 while the real mouse is in use (rung 4), so two pointers never sit on one spot.
    var bodyOpacity: CGFloat = 1
    /// The halo around the arrow, 0…1.
    var glow: CGFloat = 0
    /// 0 = Winter's ice tone, 1 = the warm foreground tone.
    var warmth: CGFloat = 0
    /// 0…1 rose tint of the rim during a refusal.
    var refusal: CGFloat = 0
    var rings: [Ring] = []
    var reticle: Reticle?
    var path: DragPath?
    var badge: Badge?
    var caption: Caption?
    /// The warm ring around the real pointer while the foreground is in use.
    var foreground: ForegroundHalo?

    static let hidden = CursorFrame()

    enum RingStyle: Equatable {
        /// A single left click.
        case click
        /// The second ring of a double click: tighter, a beat later.
        case double
        /// A right click: dashed, beside the menu badge.
        case context
        /// The drop at the end of a drag.
        case release
    }

    struct Ring: Equatable {
        var center: CGPoint
        var radius: CGFloat
        var opacity: CGFloat
        var style: RingStyle
        var warm: Bool
    }

    /// Corner brackets settling on the element about to be touched.
    struct Reticle: Equatable {
        var rect: CGRect
        /// How far the brackets still sit outside the rect (they close in as they settle).
        var outset: CGFloat
        var opacity: CGFloat
    }

    /// The faint path a drag will follow.
    struct DragPath: Equatable {
        var from: CGPoint
        var control: CGPoint
        var to: CGPoint
        var opacity: CGFloat
    }

    enum BadgeKind: Equatable {
        case caret
        case key(String)
        case scroll(CUScrollDirection?)
        case grip
        case menu
        case no
        case spinner
    }

    /// The small pill riding beside the tip.
    struct Badge: Equatable {
        var kind: BadgeKind
        var opacity: CGFloat
        /// The badge's own animation phase, 0…1 per cycle (caret blink, scroll flow, spinner sweep).
        var phase: CGFloat
        /// False under Reduce Motion: draw the resting pose.
        var animated: Bool
        /// The spinner's closing beat when a wait ends, 0…1.
        var converge: CGFloat = 0
    }

    struct Caption: Equatable {
        var text: String
        var opacity: CGFloat
    }

    struct ForegroundHalo: Equatable {
        var center: CGPoint
        var radius: CGFloat
        var opacity: CGFloat
    }
}

/// How much redrawing the cursor needs right now. The driver runs its display link at a matching rate, or stops.
enum CursorAnimationNeed: Comparable {
    case none
    /// Only slow, low-amplitude change (breathing): a low frame rate is enough.
    case low
    case full
}
