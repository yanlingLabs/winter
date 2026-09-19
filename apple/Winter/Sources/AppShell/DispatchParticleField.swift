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

/// The working pulse: its period, the wave's half-width, and how much it lifts, grows and pushes the
/// dots it crosses. It starts IN THE SHAPE OF THE COMPOSER — the wave is a distance from the
/// composer's rounded outline, not from a point — and grows outward until it has left the page.
let dispatchPulsePeriod: Double = 3.2
let dispatchPulseBand: CGFloat = 110
let dispatchPulseLift: Double = 0.55
let dispatchPulseGrow: CGFloat = 0.7
let dispatchPulsePush: CGFloat = 6
/// Fallback outline when the composer has not reported its frame: a composer-sized rounded rect
/// centred near the bottom of the field.
let dispatchPulseFallbackSize = CGSize(width: 640, height: 130)
let dispatchPulseCornerRadius: CGFloat = 30

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

/// PURE: a point's distance OUTSIDE a rounded rect (0 on or inside it) — the signed-distance
/// formula, clamped. The pulse measures from this, so its wave is the composer's shape, inflated.
func dispatchDistanceOutside(_ point: CGPoint, rect: CGRect, cornerRadius: CGFloat) -> CGFloat {
    let r = min(cornerRadius, rect.width / 2, rect.height / 2)
    let qx = abs(point.x - rect.midX) - (rect.width / 2 - r)
    let qy = abs(point.y - rect.midY) - (rect.height / 2 - r)
    let outside = (max(qx, 0) * max(qx, 0) + max(qy, 0) * max(qy, 0)).squareRoot()
    return max(0, outside + min(max(qx, qy), 0) - r)
}

/// PURE: the pulse's effect on one point — 0…1 — for a wave `ringRadius` out from the composer's
/// outline (`distance` is the point's own distance from it), fading as it travels (`travelled`:
/// 0 at birth → 1 at the far edge). The fade is slow at first, so the wave keeps its strength
/// most of the way across the page.
func dispatchPulseInfluence(distance: CGFloat, ringRadius: CGFloat, travelled: CGFloat) -> CGFloat {
    let x = abs(distance - ringRadius) / dispatchPulseBand
    guard x < 1 else { return 0 }
    let bump = (1 - x * x) * (1 - x * x)
    let t = min(max(travelled, 0), 1)
    return bump * (1 - t * t)
}

/// The field. `pointer` is in GLOBAL coordinates — the hover is tracked on the surface while the
/// field itself runs up under the titlebar band, so the two do not share a local space — or nil
/// when the cursor is elsewhere. `isWorking` runs the pulse.
struct DispatchParticleField: View {
    let pointer: CGPoint?
    var isWorking: Bool = false
    /// The composer face's frame in GLOBAL coordinates (`ComposerFaceFrameKey`), or nil.
    var composerFrame: CGRect? = nil

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
                // The composer's outline in this field's space — or a composer-sized stand-in.
                let shape = composerFrame.map { $0.offsetBy(dx: -frameOrigin.x, dy: -frameOrigin.y) }
                    ?? CGRect(x: (size.width - dispatchPulseFallbackSize.width) / 2,
                              y: size.height - dispatchPulseFallbackSize.height - 16,
                              width: dispatchPulseFallbackSize.width,
                              height: dispatchPulseFallbackSize.height)
                // Far enough to clear the farthest corner of the page before it fades out.
                let farthest = [CGPoint(x: 0, y: 0), CGPoint(x: size.width, y: 0),
                                CGPoint(x: 0, y: size.height), CGPoint(x: size.width, y: size.height)]
                    .map { dispatchDistanceOutside($0, rect: shape, cornerRadius: dispatchPulseCornerRadius) }
                    .max() ?? 0
                let ringRadius = phase * (farthest + dispatchPulseBand)
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
                            let distance = dispatchDistanceOutside(base, rect: shape,
                                                                   cornerRadius: dispatchPulseCornerRadius)
                            pulse = distance > 0
                                ? dispatchPulseInfluence(distance: distance, ringRadius: ringRadius,
                                                         travelled: phase) * pulseStrength
                                : 0
                            if pulse > 0 {
                                // Pushed away from the composer's centre — outward, like the wave.
                                let vx = base.x - shape.midX, vy = base.y - shape.midY
                                let len = max(0.001, (vx * vx + vy * vy).squareRoot())
                                pdx = vx / len * dispatchPulsePush * pulse
                                pdy = vy / len * dispatchPulsePush * pulse
                            }
                        }
                        let opacity = min(1, dispatchParticleRestOpacity
                            + (dispatchParticleLitOpacity - dispatchParticleRestOpacity) * Double(offset.influence)
                            + dispatchPulseLift * Double(pulse))
                        let r = dispatchParticleRadius * (1 + 0.5 * offset.influence + dispatchPulseGrow * pulse)
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
