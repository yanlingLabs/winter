import CoreGraphics
import Foundation

/// Winter's agent-cursor look, in one place. The language is the pill's: near-black faces with a faint white rim and a
/// soft shadow; Winter's ice blue (`AccentColor`, #8CCBF0) for the agent's own marks (the frost edge on the arrow, the
/// reticle, the caret, the drag path); a warm amber only when the real mouse is in use; a muted rose for "no". Every
/// stroke that must read on any background is drawn twice: a dark under-stroke and a light over-stroke.
///
/// The arrow is not the system pointer: it is a dart (no stem) with a notched back, softened corners, a black face, a
/// white rim and an ice-blue frost edge along its leading side. The waiting spinner is twelve rays, the count of rays in
/// Winter's scale-burst mark.
struct CursorStyle: Equatable {
    /// System Increase Contrast: solid faces, brighter rims, thicker strokes, stronger shadow.
    var increaseContrast = false

    // MARK: Colours (sRGB components; the package draws in Core Graphics, so no asset catalog here)

    struct RGBA: Equatable {
        var r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat
        func cg(_ alpha: CGFloat = 1) -> CGColor {
            CGColor(srgbRed: r, green: g, blue: b, alpha: a * alpha)
        }
        func mixed(with other: RGBA, _ t: CGFloat) -> RGBA {
            let u = min(max(t, 0), 1)
            return RGBA(r: r + (other.r - r) * u, g: g + (other.g - g) * u, b: b + (other.b - b) * u, a: a + (other.a - a) * u)
        }
    }

    /// Winter's ice blue, the brand accent.
    static let ice = RGBA(r: 140 / 255, g: 203 / 255, b: 240 / 255, a: 1)
    /// The warm foreground tone: the real mouse is in use.
    static let amber = RGBA(r: 242 / 255, g: 166 / 255, b: 64 / 255, a: 1)
    /// The refusal tone: muted, never alarm red.
    static let rose = RGBA(r: 232 / 255, g: 116 / 255, b: 112 / 255, a: 1)
    static let ink = RGBA(r: 11 / 255, g: 12 / 255, b: 14 / 255, a: 1)
    static let white = RGBA(r: 1, g: 1, b: 1, a: 1)
    static let black = RGBA(r: 0, g: 0, b: 0, a: 1)

    var faceAlpha: CGFloat { increaseContrast ? 1 : 0.95 }
    var rimAlpha: CGFloat { increaseContrast ? 1 : 0.92 }
    var rimWidth: CGFloat { increaseContrast ? 1.8 : 1.3 }
    var shadowAlpha: Float { increaseContrast ? 0.55 : 0.34 }
    var pillFaceAlpha: CGFloat { increaseContrast ? 1 : 0.92 }
    var pillRimAlpha: CGFloat { increaseContrast ? 0.5 : 0.16 }
    var underAlpha: CGFloat { increaseContrast ? 0.6 : 0.4 }
    var overWidth: CGFloat { increaseContrast ? 2.2 : 1.7 }
    var underWidth: CGFloat { increaseContrast ? 4.2 : 3.3 }

    // MARK: Geometry (points at scale 1, y down, the arrow's tip at the origin)

    /// The arrow's four corners: tip, lower wing, notch, right wing.
    static let tip = CGPoint(x: 0, y: 0)
    static let lowerWing = CGPoint(x: 3.6, y: 17.2)
    static let notch = CGPoint(x: 7.4, y: 11.9)
    static let rightWing = CGPoint(x: 16.4, y: 11.0)

    /// The arrow is drawn this much larger than its outline's numbers (about the system pointer's size).
    static let arrowScale: CGFloat = 1.12

    /// Where the badge pill's top-left sits relative to the tip, and the caption's.
    static let badgeOffset = CGPoint(x: 12, y: 20)
    static let captionOffset = CGPoint(x: 22, y: -1)
    static let badgeHeight: CGFloat = 18
    static let captionHeight: CGFloat = 20
    static let captionMaxWidth: CGFloat = 240
    static let captionMaxCharacters = 40

    /// The arrow, its corners softened (the tip stays sharp enough to read as a point).
    static func arrowPath(scale s: CGFloat) -> CGPath {
        func sc(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * s, y: p.y * s) }
        let t = sc(tip), l = sc(lowerWing), n = sc(notch), r = sc(rightWing)
        let p = CGMutablePath()
        p.move(to: CGPoint(x: (t.x + l.x) / 2, y: (t.y + l.y) / 2))
        p.addArc(tangent1End: l, tangent2End: n, radius: 2.0 * s)
        p.addArc(tangent1End: n, tangent2End: r, radius: 1.3 * s)
        p.addArc(tangent1End: r, tangent2End: t, radius: 2.1 * s)
        p.addArc(tangent1End: t, tangent2End: l, radius: 0.6 * s)
        p.closeSubpath()
        return p
    }

    /// The frost edge: a short ice-blue line just inside the arrow's leading (left) side.
    static func frostPath(scale s: CGFloat) -> CGPath {
        let d = CGPoint(x: lowerWing.x, y: lowerWing.y)
        let len = (d.x * d.x + d.y * d.y).squareRoot()
        let dir = CGPoint(x: d.x / len, y: d.y / len)
        let inward = CGPoint(x: dir.y, y: -dir.x) // rotate toward the arrow's body
        func at(_ along: CGFloat) -> CGPoint {
            CGPoint(x: (dir.x * along + inward.x * 1.55) * s, y: (dir.y * along + inward.y * 1.55) * s)
        }
        let p = CGMutablePath()
        p.move(to: at(2.9))
        p.addLine(to: at(12.2))
        return p
    }

    /// Corner brackets around `rect`, each `length` long.
    static func bracketsPath(_ rect: CGRect, length: CGFloat) -> CGPath {
        let p = CGMutablePath()
        let l = min(length, rect.width / 3, rect.height / 3)
        let corners: [(CGPoint, CGFloat, CGFloat)] = [
            (CGPoint(x: rect.minX, y: rect.minY), 1, 1), (CGPoint(x: rect.maxX, y: rect.minY), -1, 1),
            (CGPoint(x: rect.minX, y: rect.maxY), 1, -1), (CGPoint(x: rect.maxX, y: rect.maxY), -1, -1),
        ]
        for (c, sx, sy) in corners {
            p.move(to: CGPoint(x: c.x + sx * l, y: c.y))
            p.addLine(to: c)
            p.addLine(to: CGPoint(x: c.x, y: c.y + sy * l))
        }
        return p
    }

    /// A chevron pointing `direction`, centred on `c`, `size` across.
    static func chevron(_ direction: CUScrollDirection, at c: CGPoint, size: CGFloat) -> CGPath {
        let h = size / 2, q = size / 4
        let points: [CGPoint]
        switch direction {
        case .down: points = [CGPoint(x: c.x - h, y: c.y - q), CGPoint(x: c.x, y: c.y + q), CGPoint(x: c.x + h, y: c.y - q)]
        case .up: points = [CGPoint(x: c.x - h, y: c.y + q), CGPoint(x: c.x, y: c.y - q), CGPoint(x: c.x + h, y: c.y + q)]
        case .left: points = [CGPoint(x: c.x + q, y: c.y - h), CGPoint(x: c.x - q, y: c.y), CGPoint(x: c.x + q, y: c.y + h)]
        case .right: points = [CGPoint(x: c.x - q, y: c.y - h), CGPoint(x: c.x + q, y: c.y), CGPoint(x: c.x - q, y: c.y + h)]
        }
        let p = CGMutablePath()
        p.addLines(between: points)
        return p
    }

    /// Caption text, cut to a calm length.
    static func captionText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > captionMaxCharacters else { return trimmed }
        return String(trimmed.prefix(captionMaxCharacters - 1)) + "…"
    }
}
