import Foundation

struct ClickableCandidate: Equatable {
    let center: CGPoint
    let frame: CGRect
}

enum StickinessConstants {
    static let scanRadius: CGFloat = 220        // v1 ClickableStickiness.swift:84
    static let captureRadius: CGFloat = 80      // v1 ClickableStickiness.swift:520
    static let releaseRadius: CGFloat = 96      // NEW: hysteresis so the hold doesn't flap
    static let switchRadius: CGFloat = 40       // captureRadius/2: deliberate-switch threshold
    static let scanDeadline: TimeInterval = 0.15
    static let maxVisitedNodes = 2000
    static let maxConsecutiveFailures = 3
    static let rescanInterval: TimeInterval = 0.05 // v1 20 Hz cadence, now event-driven
    static let degradedProbeInterval: TimeInterval = 1.0 // slow recovery probe while degraded
}

/// PURE sticky-target policy (D1: policy on main, scanning elsewhere).
func stickyTarget(cursor: CGPoint, current: CGPoint?, candidates: [ClickableCandidate]) -> CGPoint? {
    func dist(_ p: CGPoint) -> CGFloat { hypot(p.x - cursor.x, p.y - cursor.y) }
    let nearest = candidates.min(by: { dist($0.center) < dist($1.center) })

    if let held = current, dist(held) <= StickinessConstants.releaseRadius {
        // Hysteresis hold — but a candidate RIGHT under the cursor wins deliberately.
        if let n = nearest, dist(n.center) <= StickinessConstants.switchRadius,
           n.center != held, dist(n.center) < dist(held) {
            return n.center
        }
        return held
    }
    if let n = nearest, dist(n.center) <= StickinessConstants.captureRadius {
        return n.center
    }
    return nil
}
