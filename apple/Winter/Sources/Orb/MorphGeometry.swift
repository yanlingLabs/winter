import CoreGraphics

/// v1 smoothstep (GlassFieldView.swift:2671-2674) — the easing curve behind every "reveal late"
/// opacity band in the morph (orb fade-out, field fade-in, composer content reveal).
func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
    let t = max(0, min(1, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
}

/// v1 interpolatedRect (GlassFieldView.swift:1107-1119) — linear rect lerp, used to grow the
/// composer shell out of the orb circle's rect as the morph progresses.
func interpolatedRect(from start: CGRect, to end: CGRect, progress: Double) -> CGRect {
    let t = CGFloat(max(0, min(1, progress)))
    return CGRect(
        x: start.minX + (end.minX - start.minX) * t,
        y: start.minY + (end.minY - start.minY) * t,
        width: start.width + (end.width - start.width) * t,
        height: start.height + (end.height - start.height) * t
    )
}
