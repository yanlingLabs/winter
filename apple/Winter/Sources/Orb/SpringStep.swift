import Foundation

/// v1's tuned spring constants (PointerFollower.swift:30-34, 161, 178) — the "feel".
struct SpringConfig {
    var stiffness: Double
    var damping: Double
    var snapDistance: CGFloat
    var snapSpeed: CGFloat
    var glideDistance: CGFloat
    var glideSpeed: CGFloat
    /// Per-spring dt clamp ceiling. v1 tunes this per spring, not globally: the orb-following
    /// spring (PointerFollower.swift:154) clamps to 1/30, while the field's window-origin
    /// tracking spring (GlassFieldWindow.swift:1957) clamps to 1/20. Defaults to 1/30 so
    /// `.v1` doesn't need to restate it.
    var dtClampMax: TimeInterval = 1.0 / 30.0

    static let v1 = SpringConfig(
        stiffness: 120.0, damping: 22.0,
        snapDistance: 0.35, snapSpeed: 18,
        glideDistance: 8, glideSpeed: 80
    )

    /// v1's window-origin tracking spring (GlassFieldWindow.swift:1960-1961, snap/glide
    /// thresholds 1949/1972) — softer than `.v1`'s orb-following spring: the panel trails the
    /// glass anchor rather than snapping to it, so the field doesn't fight the morph. Its dt
    /// clamp is also wider on top (1/20 vs `.v1`'s 1/30) — GlassFieldWindow.swift:1957.
    static let tracking = SpringConfig(
        stiffness: 75.0, damping: 18.0,
        snapDistance: 0.35, snapSpeed: 18,
        glideDistance: 8, glideSpeed: 80,
        dtClampMax: 1.0 / 20.0
    )
}

enum SpringTier: Equatable {
    case active   // v1: 1/120 interval
    case glide    // v1: 1/30 interval
    case settled  // NEW (D9): display link pauses — 0 fps
}

struct SpringState: Equatable {
    var position: CGPoint
    var velocity: CGPoint
}

/// One physics step — semantics identical to v1 PointerFollower.step()/GlassFieldWindow's
/// track step, extracted pure. The dt clamp ceiling is per-`config`, not hardcoded: v1's
/// orb-following spring (PointerFollower.swift:154) clamps to [1/240, 1/30], while v1's field
/// window-origin tracking spring (GlassFieldWindow.swift:1957) clamps to [1/240, 1/20] —
/// `SpringConfig.v1` vs `SpringConfig.tracking` carry those two ceilings respectively via
/// `dtClampMax`.
func springStep(_ state: SpringState, target: CGPoint, dt rawDt: TimeInterval, config: SpringConfig) -> (state: SpringState, tier: SpringTier) {
    var s = state
    let dt = max(1.0 / 240.0, min(rawDt, config.dtClampMax))

    let dx = target.x - s.position.x
    let dy = target.y - s.position.y
    let distance = hypot(dx, dy)
    let speed = hypot(s.velocity.x, s.velocity.y)
    if distance < config.snapDistance, speed < config.snapSpeed {
        s.position = target
        s.velocity = .zero
        return (s, .settled)
    }

    let ax = config.stiffness * dx - config.damping * s.velocity.x
    let ay = config.stiffness * dy - config.damping * s.velocity.y
    s.velocity.x += ax * dt
    s.velocity.y += ay * dt
    s.position.x += s.velocity.x * dt
    s.position.y += s.velocity.y * dt

    let tier: SpringTier = (distance < config.glideDistance && speed < config.glideSpeed) ? .glide : .active
    return (s, tier)
}

/// Pure morph-progress spring step (v1 GlassFieldWindow.swift:1811-1822): the same semi-
/// implicit Euler integration as `springStep`, over a scalar 0…1 progress instead of a
/// CGPoint. Default stiffness 140 / damping 22 (the core orb↔field morph's own tuning,
/// deliberately underdamped so an expand overshoots progress slightly above 1 — the "liquid
/// merge" bounce is the point, not a bug) — kept as defaulted parameters, NOT hardcoded, so
/// `ChatWindowController`'s window-grow animation (Fix D, anim-fidelity restore) can drive the
/// SAME integrator at its own tuning (140/18, ζ≈0.76 — a slightly softer, ~2-3%-overshoot
/// "organic settle") without touching this call site's own 140/22 (`OrbWindowController.
/// morphTick()`, which relies on the default). The dt clamp is v1's own [1/240, 1/20] — wider
/// on the top end than the position spring's [1/240, 1/30]; verbatim, not a typo.
func morphStep(
    progress: Double,
    velocity: Double,
    target: Double,
    dt rawDt: TimeInterval,
    stiffness: Double = 140.0,
    damping: Double = 22.0
) -> (progress: Double, velocity: Double) {
    let dt = max(1.0 / 240.0, min(rawDt, 1.0 / 20.0))

    let accel = stiffness * (target - progress) - damping * velocity
    let nextVelocity = velocity + accel * dt
    let nextProgress = progress + nextVelocity * dt
    return (nextProgress, nextVelocity)
}
