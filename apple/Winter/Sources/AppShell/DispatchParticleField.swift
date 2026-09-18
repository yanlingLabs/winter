import SwiftUI

// -----------------------------------------------------------------------------------------------
// The Dispatch thread's own background (2026-09-19, user call): particles sitting on an invisible
// grid that lean gently away from the cursor as it crosses them, and brighten a touch. Dispatch is
// the coordinator's surface — it should not look like every other conversation — but it is still a
// place to read, so the field is faint, and it rests completely still when nothing is happening.
//
// While Dispatch is WORKING, a soft ring leaves the composer every `dispatchPulsePeriod` seconds and
// sweeps outward across the grid — a radio wave from the thing that is broadcasting — brightening
// and nudging the dots it passes.
//
// Cost: one `Canvas` pass per frame over ~1–2k dots, and ONLY while the pointer is over the page,
// the pulse is running, or either is still settling — the `TimelineView` is paused otherwise.
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

/// The working pulse: its period, the ring's half-width, where it starts (the composer, this far
/// above the field's bottom edge), and how much it lifts and pushes the dots it crosses.
let dispatchPulsePeriod: Double = 2.8
let dispatchPulseBand: CGFloat = 80
let dispatchPulseOriginFromBottom: CGFloat = 110
let dispatchPulseLift: Double = 0.30
let dispatchPulsePush: CGFloat = 3

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

/// PURE: the pulse's effect on one point — 0…1 — for a ring at `ringRadius` around `origin`,
/// fading as it travels (`travelled`: 0 at birth → 1 at the far edge).
func dispatchPulseInfluence(point: CGPoint, origin: CGPoint, ringRadius: CGFloat, travelled: CGFloat) -> CGFloat {
    let vx = point.x - origin.x, vy = point.y - origin.y
    let d = (vx * vx + vy * vy).squareRoot()
    let x = abs(d - ringRadius) / dispatchPulseBand
    guard x < 1 else { return 0 }
    let bump = (1 - x * x) * (1 - x * x)
    return bump * max(0, 1 - travelled)
}

/// The field. `pointer` is in GLOBAL coordinates — the hover is tracked on the surface while the
/// field itself runs up under the titlebar band, so the two do not share a local space — or nil
/// when the cursor is elsewhere. `isWorking` runs the pulse.
struct DispatchParticleField: View {
    let pointer: CGPoint?
    var isWorking: Bool = false

    /// The cursor the dots actually respond to — it trails the real one, and `strength` fades in and
    /// out, so the field eases rather than snapping when the pointer enters, moves or leaves.
    @State private var follow = CGPoint.zero
    @State private var strength: CGFloat = 0
    /// The pulse's own presence, eased the same way, so it fades in and out with the work.
    @State private var pulseStrength: CGFloat = 0
    @State private var lastTick: Date?
    @State private var frameOrigin = CGPoint.zero

    private var isSettled: Bool {
        pointer == nil && strength < 0.001 && !isWorking && pulseStrength < 0.001
    }

    private var localPointer: CGPoint? {
        pointer.map { CGPoint(x: $0.x - frameOrigin.x, y: $0.y - frameOrigin.y) }
    }

    var body: some View {
        GeometryReader { geo in
            field
                .onAppear { frameOrigin = geo.frame(in: .global).origin }
                .onChange(of: geo.frame(in: .global).origin) { _, origin in frameOrigin = origin }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var field: some View {
        TimelineView(.animation(paused: isSettled)) { timeline in
            let seconds = timeline.date.timeIntervalSinceReferenceDate
            let phase = CGFloat(seconds.truncatingRemainder(dividingBy: dispatchPulsePeriod) / dispatchPulsePeriod)
            Canvas { context, size in
                let origin = CGPoint(x: size.width / 2, y: size.height - dispatchPulseOriginFromBottom)
                // Far enough to leave the top corners before it fades out.
                let farthest = ((size.width / 2) * (size.width / 2) + origin.y * origin.y).squareRoot()
                    + dispatchPulseBand
                let ringRadius = phase * farthest
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
                        var pulse: CGFloat = 0
                        var pdx: CGFloat = 0, pdy: CGFloat = 0
                        if pulseStrength > 0.001 {
                            pulse = dispatchPulseInfluence(point: base, origin: origin, ringRadius: ringRadius,
                                                           travelled: phase) * pulseStrength
                            if pulse > 0 {
                                let vx = base.x - origin.x, vy = base.y - origin.y
                                let len = max(0.001, (vx * vx + vy * vy).squareRoot())
                                pdx = vx / len * dispatchPulsePush * pulse
                                pdy = vy / len * dispatchPulsePush * pulse
                            }
                        }
                        let opacity = min(1, dispatchParticleRestOpacity
                            + (dispatchParticleLitOpacity - dispatchParticleRestOpacity) * Double(offset.influence)
                            + dispatchPulseLift * Double(pulse))
                        let r = dispatchParticleRadius * (1 + 0.5 * offset.influence + 0.35 * pulse)
                        let rect = CGRect(x: base.x + offset.dx + pdx - r, y: base.y + offset.dy + pdy - r,
                                          width: r * 2, height: r * 2)
                        context.fill(Path(ellipseIn: rect), with: .color(Theme.textPrimary.opacity(opacity)))
                    }
                }
            }
            .onChange(of: timeline.date) { _, now in step(now) }
        }
    }

    /// Advance the trailing cursor and both presence fades by one frame (frame-rate independent).
    private func step(_ now: Date) {
        let dt = min(0.05, lastTick.map { now.timeIntervalSince($0) } ?? 1 / 60)
        lastTick = now
        let ease = CGFloat(1 - exp(-dt * 10))
        // The pulse fades over about half a second either way — never a pop.
        let pulseEase = CGFloat(1 - exp(-dt * 3))
        pulseStrength += ((isWorking ? 1 : 0) - pulseStrength) * pulseEase
        if !isWorking, pulseStrength < 0.001 { pulseStrength = 0 }
        if let pointer = localPointer {
            if strength < 0.001 { follow = pointer }          // enter where the cursor is, not a slide
            follow.x += (pointer.x - follow.x) * ease
            follow.y += (pointer.y - follow.y) * ease
            strength += (1 - strength) * ease
        } else {
            strength += (0 - strength) * ease
            if strength < 0.001 { strength = 0 }
        }
        if isSettled { lastTick = nil }
    }
}
