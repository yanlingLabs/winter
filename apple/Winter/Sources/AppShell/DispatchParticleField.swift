import SwiftUI

// -----------------------------------------------------------------------------------------------
// The Dispatch thread's own background (2026-09-19, user call): particles sitting on an invisible
// grid that lean gently away from the cursor as it crosses them, and brighten a touch. Dispatch is
// the coordinator's surface — it should not look like every other conversation — but it is still a
// place to read, so the field is faint, and it rests completely still when the pointer is away.
//
// Cost: one `Canvas` pass per frame over ~1–2k dots, and ONLY while the pointer is over the page or
// the dots are still settling back — the `TimelineView` is paused otherwise.
// -----------------------------------------------------------------------------------------------

/// The grid's pitch, the dot size, and how the cursor's influence falls off.
let dispatchParticleSpacing: CGFloat = 26
let dispatchParticleRadius: CGFloat = 1.1
/// Within this distance of the cursor a dot is displaced; beyond it, untouched.
let dispatchParticleReach: CGFloat = 130
/// The largest push, at the cursor itself.
let dispatchParticleMaxPush: CGFloat = 9
/// Resting and nearest-to-cursor opacity.
let dispatchParticleRestOpacity: Double = 0.10
let dispatchParticleLitOpacity: Double = 0.38

/// PURE: how far (and which way) one grid point moves for a cursor at `pointer`, scaled by
/// `strength` (0 = no cursor, 1 = fully present). A smooth, zero-slope-at-the-edge falloff so the
/// disturbed region has no visible rim.
func dispatchParticleOffset(point: CGPoint, pointer: CGPoint, strength: CGFloat) -> (dx: CGFloat, dy: CGFloat, influence: CGFloat) {
    let vx = point.x - pointer.x
    let vy = point.y - pointer.y
    let distance = (vx * vx + vy * vy).squareRoot()
    guard strength > 0, distance < dispatchParticleReach, distance > 0.001 else { return (0, 0, 0) }
    let t = 1 - distance / dispatchParticleReach
    let influence = t * t * (3 - 2 * t) * strength           // smoothstep
    let push = dispatchParticleMaxPush * influence
    return (vx / distance * push, vy / distance * push, influence)
}

/// The field. `pointer` is in this view's own coordinate space, or nil when the cursor is elsewhere.
struct DispatchParticleField: View {
    let pointer: CGPoint?

    /// The cursor the dots actually respond to — it trails the real one, and `strength` fades in and
    /// out, so the field eases rather than snapping when the pointer enters, moves or leaves.
    @State private var follow = CGPoint.zero
    @State private var strength: CGFloat = 0
    @State private var lastTick: Date?

    private var isSettled: Bool { pointer == nil && strength < 0.001 }

    var body: some View {
        TimelineView(.animation(paused: isSettled)) { timeline in
            Canvas { context, size in
                let columns = Int(size.width / dispatchParticleSpacing) + 1
                let rows = Int(size.height / dispatchParticleSpacing) + 1
                // Centre the grid so the margins match on both sides.
                let originX = (size.width - CGFloat(columns - 1) * dispatchParticleSpacing) / 2
                let originY = (size.height - CGFloat(rows - 1) * dispatchParticleSpacing) / 2
                for row in 0..<rows {
                    for column in 0..<columns {
                        let base = CGPoint(x: originX + CGFloat(column) * dispatchParticleSpacing,
                                           y: originY + CGFloat(row) * dispatchParticleSpacing)
                        let offset = dispatchParticleOffset(point: base, pointer: follow, strength: strength)
                        let opacity = dispatchParticleRestOpacity
                            + (dispatchParticleLitOpacity - dispatchParticleRestOpacity) * Double(offset.influence)
                        let r = dispatchParticleRadius * (1 + 0.5 * offset.influence)
                        let rect = CGRect(x: base.x + offset.dx - r, y: base.y + offset.dy - r,
                                          width: r * 2, height: r * 2)
                        context.fill(Path(ellipseIn: rect), with: .color(Theme.textPrimary.opacity(opacity)))
                    }
                }
            }
            .onChange(of: timeline.date) { _, now in step(now) }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// Advance the trailing cursor and the presence fade by one frame (frame-rate independent).
    private func step(_ now: Date) {
        let dt = min(0.05, lastTick.map { now.timeIntervalSince($0) } ?? 1 / 60)
        lastTick = now
        let ease = CGFloat(1 - exp(-dt * 10))
        if let pointer {
            if strength < 0.001 { follow = pointer }          // enter where the cursor is, not a slide
            follow.x += (pointer.x - follow.x) * ease
            follow.y += (pointer.y - follow.y) * ease
            strength += (1 - strength) * ease
        } else {
            strength += (0 - strength) * ease
            if strength < 0.001 { strength = 0; lastTick = nil }
        }
    }
}
