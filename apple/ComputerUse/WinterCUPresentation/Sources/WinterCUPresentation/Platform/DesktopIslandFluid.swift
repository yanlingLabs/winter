import CoreGraphics
import Foundation

/// The pill's birth as a liquid, frame by frame (user ruling 2026-10-14: "the morphing feeling of water"). A drop
/// swells out of the source and falls on a spring, stretching with its speed; a tapering tail of smaller drops trails
/// it, so the neck stretches, thins and snaps like a drip; once free, the drop spreads into the pill on an
/// underdamped spring — overshooting and squashing, then settling like jelly. Drawn through a blur and an alpha
/// threshold, the shapes melt into one surface. Pure: a function of the seconds since the birth began.
struct DesktopIslandFluid {
    let geometry: DesktopIslandGeometry

    /// One mass at a moment: an ellipse, or a capsule (the pill).
    struct Blob: Equatable {
        enum Kind: Equatable { case ellipse, capsule, roundedRect(CGFloat) }
        var rect: CGRect
        var kind: Kind
    }

    /// One frame: the masses, the melt's blur, how much of the crisp pill and of the words show.
    struct Frame: Equatable {
        var blobs: [Blob]
        var blur: CGFloat
        /// The crisp pill (an anti-aliased capsule over the melt), at `pill`.
        var crisp: Double
        var pill: CGRect
        var content: Double
    }

    /// The birth is over (the wobble has settled) after this many seconds.
    static let settle: Double = 1.35
    /// The way back up (answered on the pill) plays the birth backwards this much faster.
    static let returnSpeed: Double = 1.8

    // Timings, in seconds.
    // The drip snaps first (the tail gone, the melt's blur thinned so the free drop and the housing can't join
    // again); only then does the drop spread into the pill, already crisp, wobbling.
    static let fallStart = 0.08
    static let tailFade = (from: 0.18, to: 0.42)
    static let spreadStart = 0.42
    static let meltEnd = (from: 0.32, to: 0.5)
    static let crispIn = (from: 0.44, to: 0.52)
    static let contentIn = (from: 0.62, to: 0.92)

    func frame(at seconds: Double) -> Frame {
        let t = max(0, seconds)
        let g = geometry
        let pillHeight = g.pill.height
        let drop = max(min(g.floating ? 26 : g.source.height * 1.15, 40), 26)

        // The drop's fall: from just inside the source to the pill's middle, on a gently bouncy spring.
        let startY = g.floating ? g.pill.midY : g.source.maxY - drop * 0.3
        let fall = Self.spring(t - Self.fallStart, response: 0.42, damping: 0.68)
        let y = Self.lerp(startY, g.pill.midY, fall)
        // Its speed (points per second), for the stretch while it falls.
        let speed = abs(Self.lerp(startY, g.pill.midY, Self.spring(t + 0.008 - Self.fallStart, response: 0.42, damping: 0.68)) - y) / 0.008
        // It swells out of the source first.
        let swell = Self.easeOut(Self.phase(t, 0, 0.22))

        // The spread into the pill: an underdamped spring, so it overshoots and wobbles; the height answers the width
        // (wider than its rest → thinner), the way a liquid keeps its volume.
        let spread = Self.spring(t - Self.spreadStart, response: 0.5, damping: 0.52)
        let lift = Self.spring(t - Self.spreadStart, response: 0.34, damping: 0.8)
        var w = Self.lerp(drop, g.pill.width, spread)
        var h = Self.lerp(drop, pillHeight, min(lift, 1))
        // Squash past the rest width, a little stretch before it — eased in so the drop's own shape never jumps.
        h *= 1 - 0.55 * CGFloat(spread - 1) * CGFloat(Self.phase(t, Self.spreadStart, Self.spreadStart + 0.3))
        let stretch = CGFloat(min(speed / 900, 0.35)) * CGFloat(1 - min(spread, 1))
        h *= 1 + stretch
        w /= 1 + stretch * 0.5
        w *= CGFloat(swell)
        h *= CGFloat(swell)
        h = max(h, 0)
        let body = CGRect(x: g.pill.midX - w / 2, y: y - h / 2, width: w, height: h)

        var blobs: [Blob] = []
        if !g.floating {
            // The source: the housing itself (run up past the top so the blur never thins its edge), or, without
            // one, a bead of liquid hanging from the top edge that swells and is drawn back.
            let above: CGFloat = 40
            if g.sourceIsHousing {
                blobs.append(Blob(rect: CGRect(x: g.source.minX, y: -above, width: g.source.width,
                                               height: g.source.maxY + above), kind: .roundedRect(9)))
            } else {
                let bead = 18 * CGFloat(Self.bump(t, up: 0.16, down: 0.62))
                if bead > 0.5 {
                    blobs.append(Blob(rect: CGRect(x: g.source.midX - 60, y: -above, width: 120, height: bead + above),
                                      kind: .roundedRect(14)))
                }
            }
            // The tail: drops strung between the source and the falling drop, each later along the fall and smaller,
            // all shrinking away — the neck thins until it parts.
            let fade = 1 - Self.easeIn(Self.phase(t, Self.tailFade.from, Self.tailFade.to))
            if fade > 0 {
                for i in 1...5 {
                    let lag = 0.045 * Double(i)
                    let k = Self.spring(t - Self.fallStart - lag, response: 0.42, damping: 0.68)
                    let along = CGFloat(Double(5 - i + 1) / 6.5)
                    let ty = Self.lerp(g.source.maxY - 4, Self.lerp(startY, g.pill.midY, k), along)
                    let r = drop * 0.5 * (0.92 - 0.1 * CGFloat(i)) * CGFloat(fade * swell)
                    if r > 0.5 {
                        blobs.append(Blob(rect: CGRect(x: g.pill.midX - r, y: ty - r, width: 2 * r, height: 2 * r),
                                          kind: .ellipse))
                    }
                }
            }
        }
        let round = h >= w * 0.92 ? Blob.Kind.ellipse : .capsule
        if body.width > 0.5, body.height > 0.5 { blobs.append(Blob(rect: body, kind: round)) }

        let blur = 11 * CGFloat(1 - Self.easeInOut(Self.phase(t, Self.meltEnd.from, Self.meltEnd.to)))
        return Frame(blobs: blobs, blur: blur,
                     crisp: Self.phase(t, Self.crispIn.from, Self.crispIn.to), pill: body,
                     content: Self.easeOut(Self.phase(t, Self.contentIn.from, Self.contentIn.to)))
    }

    // MARK: curves

    /// A spring's travel from 0 to 1 `t` seconds after it starts (SwiftUI's response and damping fraction).
    static func spring(_ t: Double, response: Double, damping: Double) -> Double {
        guard t > 0 else { return 0 }
        let w0 = 2 * Double.pi / response
        if damping >= 1 { return 1 - exp(-w0 * t) * (1 + w0 * t) }
        let wd = w0 * (1 - damping * damping).squareRoot()
        return 1 - exp(-damping * w0 * t) * (cos(wd * t) + damping * w0 / wd * sin(wd * t))
    }

    /// Rises 0→1 by `up`, back to 0 by `down`.
    static func bump(_ t: Double, up: Double, down: Double) -> Double {
        t < up ? easeOut(phase(t, 0, up)) : 1 - easeInOut(phase(t, up, down))
    }

    static func phase(_ t: Double, _ a: Double, _ b: Double) -> Double { min(max((t - a) / (b - a), 0), 1) }
    static func lerp(_ a: CGFloat, _ b: CGFloat, _ k: Double) -> CGFloat { a + (b - a) * CGFloat(k) }
    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
    static func easeIn(_ x: Double) -> Double { x * x }
    static func easeInOut(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
}
