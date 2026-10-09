import AppKit
import QuartzCore

/// Draws a `CursorFrame` with Core Animation layers. One rig type serves the overlay above the target window (scale 1),
/// the mirror (smaller, positions mapped into the live image) and the offscreen gallery, so what the gallery proves is
/// what the user sees. `apply` sets layer properties with actions off; the motion comes from the timeline, frame by
/// frame, never from Core Animation's implicit animations.
///
/// The rig's coordinates are top-left: add `root` to a geometry-flipped layer (or render it flipped).
@MainActor final class CursorRig {
    struct Mapping {
        /// Window-local point → the rig's space.
        var point: (CGPoint) -> CGPoint = { $0 }
        /// Scales the arrow, badges, rings and strokes (the mirror draws everything smaller).
        var sizeScale: CGFloat = 1
        /// The mirror has no room for captions.
        var showsCaption = true
    }

    let root = CALayer()
    var style: CursorStyle { didSet { if style != oldValue { restyle() } } }
    var mapping: Mapping { didSet { restyle() } }
    var contentsScale: CGFloat = 2 { didSet { applyContentsScale() } }
    /// Offscreen only: `render(in:)` ignores geometry flipping, so the gallery flips its context instead and the text
    /// layers must flip back to read upright. On screen the flipped host layer takes care of text.
    var uprightTextInFlippedContext = false {
        didSet {
            let t = uprightTextInFlippedContext ? CGAffineTransform(scaleX: 1, y: -1) : .identity
            keyText.setAffineTransform(t)
            captionText.setAffineTransform(t)
        }
    }

    private let pathUnder = CAShapeLayer(), pathOver = CAShapeLayer(), pathEnd = CAShapeLayer()
    private let reticleUnder = CAShapeLayer(), reticleOver = CAShapeLayer()
    private var ringLayers: [(under: CAShapeLayer, over: CAShapeLayer)] = []
    private let haloFill = CAShapeLayer(), haloUnder = CAShapeLayer(), haloOver = CAShapeLayer()
    private let arrowGroup = CALayer()
    /// The halo: the arrow's outline stroked wide three times at falling opacity — a soft glow drawn from plain
    /// strokes, so it renders the same on screen and offscreen (layer shadows are not relied on for it).
    private let glowRings = [CAShapeLayer(), CAShapeLayer(), CAShapeLayer()]
    private static let glowWidths: [CGFloat] = [4, 8, 13]
    private static let glowAlphas: [CGFloat] = [0.42, 0.2, 0.08]
    private let body = CAShapeLayer()
    private let frost = CAShapeLayer()
    private let badgeGroup = CALayer()
    private let badgePill = CAShapeLayer()
    private let caret = CAShapeLayer()
    private let keyText = CATextLayer()
    private let glyphStroke = CAShapeLayer()
    private let glyphFill = CAShapeLayer()
    private var rays: [CAShapeLayer] = []
    private let captionGroup = CALayer()
    private let captionPill = CAShapeLayer()
    private let captionText = CATextLayer()

    private var arrow: CGPath = CursorStyle.arrowPath(scale: 1)

    static let ringPool = 4
    static let rayCount = 12

    init(style: CursorStyle = CursorStyle(), mapping: Mapping = Mapping()) {
        self.style = style
        self.mapping = mapping
        root.anchorPoint = .zero
        root.masksToBounds = false

        for layer in [pathUnder, pathOver, pathEnd, reticleUnder, reticleOver] { root.addSublayer(layer) }
        for _ in 0..<Self.ringPool {
            let pair = (under: CAShapeLayer(), over: CAShapeLayer())
            root.addSublayer(pair.under)
            root.addSublayer(pair.over)
            ringLayers.append(pair)
        }
        for layer in [haloFill, haloUnder, haloOver] { root.addSublayer(layer) }

        arrowGroup.anchorPoint = .zero
        arrowGroup.bounds = CGRect(x: 0, y: 0, width: 1, height: 1)
        for ring in glowRings.reversed() { arrowGroup.addSublayer(ring) }
        arrowGroup.addSublayer(body)
        arrowGroup.addSublayer(frost)
        root.addSublayer(arrowGroup)

        badgeGroup.anchorPoint = .zero
        badgeGroup.addSublayer(badgePill)
        badgeGroup.addSublayer(caret)
        badgeGroup.addSublayer(keyText)
        badgeGroup.addSublayer(glyphFill)
        badgeGroup.addSublayer(glyphStroke)
        for _ in 0..<Self.rayCount {
            let ray = CAShapeLayer()
            ray.lineCap = .round
            badgeGroup.addSublayer(ray)
            rays.append(ray)
        }
        root.addSublayer(badgeGroup)

        captionGroup.anchorPoint = .zero
        captionGroup.addSublayer(captionPill)
        captionGroup.addSublayer(captionText)
        root.addSublayer(captionGroup)

        for layer in [pathUnder, pathOver, pathEnd, reticleUnder, reticleOver, haloFill, haloUnder, haloOver,
                      glyphStroke, caret] {
            layer.fillColor = nil
            layer.lineCap = .round
            layer.lineJoin = .round
        }
        for pair in ringLayers {
            pair.under.fillColor = nil
            pair.over.fillColor = nil
        }
        for text in [keyText, captionText] {
            text.alignmentMode = .center
            text.truncationMode = .end
            text.isWrapped = false
        }
        restyle()
        applyContentsScale()
        apply(.hidden)
    }

    // MARK: - Styling that only changes with the style or the scale

    private func restyle() {
        let s = mapping.sizeScale
        arrow = CursorStyle.arrowPath(scale: s * CursorStyle.arrowScale)
        body.path = arrow
        body.lineWidth = style.rimWidth * s
        body.lineJoin = .round
        body.shadowColor = CursorStyle.black.cg()
        body.shadowOpacity = style.shadowAlpha
        body.shadowRadius = 2.2 * s
        body.shadowOffset = CGSize(width: 0, height: 1.2 * s)
        for (i, ring) in glowRings.enumerated() {
            ring.path = arrow
            ring.fillColor = nil
            ring.lineJoin = .round
            ring.lineWidth = Self.glowWidths[i] * s
        }
        frost.path = CursorStyle.frostPath(scale: s * CursorStyle.arrowScale)
        frost.fillColor = nil
        frost.lineCap = .round
        frost.lineWidth = 1.15 * s
        frost.strokeColor = CursorStyle.ice.cg(style.increaseContrast ? 1 : 0.95)

        badgePill.fillColor = CursorStyle.ink.cg(style.pillFaceAlpha)
        badgePill.strokeColor = CursorStyle.white.cg(style.pillRimAlpha)
        badgePill.lineWidth = 1
        badgePill.shadowColor = CursorStyle.black.cg()
        badgePill.shadowOpacity = 0.3
        badgePill.shadowRadius = 3 * s
        badgePill.shadowOffset = CGSize(width: 0, height: 1 * s)
        captionPill.fillColor = CursorStyle.ink.cg(style.pillFaceAlpha)
        captionPill.strokeColor = CursorStyle.white.cg(style.pillRimAlpha)
        captionPill.lineWidth = 1
        captionPill.shadowColor = CursorStyle.black.cg()
        captionPill.shadowOpacity = 0.32
        captionPill.shadowRadius = 4
        captionPill.shadowOffset = CGSize(width: 0, height: 1.5)

        let font = NSFont.systemFont(ofSize: 11, weight: .medium)
        for text in [keyText, captionText] {
            text.font = font
            text.foregroundColor = CursorStyle.white.cg(style.increaseContrast ? 1 : 0.94)
        }
        keyText.fontSize = 11 * s
        captionText.fontSize = 11
    }

    private func applyContentsScale() {
        for layer in [keyText, captionText] as [CALayer] { layer.contentsScale = contentsScale }
        root.contentsScale = contentsScale
    }

    // MARK: - Frames

    func apply(_ frame: CursorFrame) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        root.isHidden = !frame.visible
        guard frame.visible else { return }
        let s = mapping.sizeScale
        let tip = mapping.point(frame.tip)

        applyArrow(frame, tip: tip, scale: s)
        applyRings(frame, scale: s)
        applyReticle(frame, scale: s)
        applyPath(frame, scale: s)
        applyHalo(frame, scale: s)
        applyBadge(frame, tip: tip, scale: s)
        applyCaption(frame, tip: tip)
    }

    private func applyArrow(_ frame: CursorFrame, tip: CGPoint, scale s: CGFloat) {
        arrowGroup.position = tip
        arrowGroup.setAffineTransform(CGAffineTransform(rotationAngle: frame.tilt).scaledBy(x: frame.scale, y: frame.scale))
        arrowGroup.opacity = Float(frame.opacity * frame.bodyOpacity)
        let rim = CursorStyle.white.mixed(with: CursorStyle.rose, frame.refusal)
        body.fillColor = CursorStyle.ink.cg(style.faceAlpha)
        body.strokeColor = rim.cg(style.rimAlpha)
        frost.opacity = Float(1 - frame.refusal)
        let glowTone = frame.warmth > 0.5 ? CursorStyle.amber : (frame.refusal > 0.5 ? CursorStyle.rose : CursorStyle.ice)
        for (i, ring) in glowRings.enumerated() {
            ring.strokeColor = glowTone.cg(Self.glowAlphas[i])
            ring.opacity = Float(min(1, frame.glow))
        }
    }

    private func applyRings(_ frame: CursorFrame, scale s: CGFloat) {
        for (i, pair) in ringLayers.enumerated() {
            guard i < frame.rings.count else {
                pair.under.isHidden = true
                pair.over.isHidden = true
                continue
            }
            let ring = frame.rings[i]
            let c = mapping.point(ring.center)
            let r = ring.radius * s
            let path = CGPath(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r), transform: nil)
            let tone: CursorStyle.RGBA = ring.warm ? CursorStyle.amber : (ring.style == .release ? CursorStyle.ice : CursorStyle.white)
            pair.under.isHidden = false
            pair.over.isHidden = false
            pair.under.path = path
            pair.over.path = path
            pair.under.lineWidth = style.underWidth * s
            pair.over.lineWidth = style.overWidth * s
            pair.under.strokeColor = CursorStyle.black.cg(style.underAlpha * 0.9)
            pair.over.strokeColor = tone.cg(0.95)
            let dash: [NSNumber]? = ring.style == .context ? [NSNumber(value: 3.2 * s), NSNumber(value: 2.6 * s)] : nil
            pair.under.lineDashPattern = dash
            pair.over.lineDashPattern = dash
            pair.under.opacity = Float(ring.opacity * frame.opacity)
            pair.over.opacity = Float(ring.opacity * frame.opacity)
        }
    }

    private func applyReticle(_ frame: CursorFrame, scale s: CGFloat) {
        guard let reticle = frame.reticle else {
            reticleUnder.isHidden = true
            reticleOver.isHidden = true
            return
        }
        let a = mapping.point(CGPoint(x: reticle.rect.minX, y: reticle.rect.minY))
        let b = mapping.point(CGPoint(x: reticle.rect.maxX, y: reticle.rect.maxY))
        let o = reticle.outset * s + 2 * s
        let rect = CGRect(x: a.x - o, y: a.y - o, width: b.x - a.x + 2 * o, height: b.y - a.y + 2 * o)
        let path = CursorStyle.bracketsPath(rect, length: 9 * s)
        reticleUnder.isHidden = false
        reticleOver.isHidden = false
        reticleUnder.path = path
        reticleOver.path = path
        reticleUnder.lineWidth = style.underWidth * s
        reticleOver.lineWidth = style.overWidth * s
        reticleUnder.strokeColor = CursorStyle.black.cg(style.underAlpha)
        reticleOver.strokeColor = (frame.warmth > 0.5 ? CursorStyle.amber : CursorStyle.ice).cg()
        reticleUnder.opacity = Float(reticle.opacity)
        reticleOver.opacity = Float(reticle.opacity)
    }

    private func applyPath(_ frame: CursorFrame, scale s: CGFloat) {
        guard let drag = frame.path else {
            pathUnder.isHidden = true
            pathOver.isHidden = true
            pathEnd.isHidden = true
            return
        }
        let a = mapping.point(drag.from), c = mapping.point(drag.control), b = mapping.point(drag.to)
        let path = CGMutablePath()
        path.move(to: a)
        path.addQuadCurve(to: b, control: c)
        for layer in [pathUnder, pathOver, pathEnd] { layer.isHidden = false }
        pathUnder.path = path
        pathOver.path = path
        pathUnder.lineWidth = 2.8 * s
        pathOver.lineWidth = 1.4 * s
        pathUnder.strokeColor = CursorStyle.black.cg(style.underAlpha * 0.35)
        pathOver.strokeColor = CursorStyle.ice.cg(style.increaseContrast ? 1 : 0.85)
        let dash = [NSNumber(value: 2.5 * s), NSNumber(value: 5 * s)]
        pathOver.lineDashPattern = dash
        pathUnder.lineDashPattern = dash
        let r = 3.2 * s
        pathEnd.path = CGPath(ellipseIn: CGRect(x: b.x - r, y: b.y - r, width: 2 * r, height: 2 * r), transform: nil)
        pathEnd.lineWidth = 1.5 * s
        pathEnd.strokeColor = CursorStyle.ice.cg()
        let o = Float(drag.opacity * frame.opacity)
        pathUnder.opacity = o * 0.7
        pathOver.opacity = o * 0.7
        pathEnd.opacity = o * 0.9
    }

    private func applyHalo(_ frame: CursorFrame, scale s: CGFloat) {
        guard let halo = frame.foreground else {
            for layer in [haloFill, haloUnder, haloOver] { layer.isHidden = true }
            return
        }
        let c = mapping.point(halo.center)
        let r = halo.radius * s
        let path = CGPath(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r), transform: nil)
        for layer in [haloFill, haloUnder, haloOver] {
            layer.isHidden = false
            layer.path = path
        }
        haloFill.fillColor = CursorStyle.amber.cg(0.1)
        haloUnder.lineWidth = style.underWidth * s
        haloUnder.strokeColor = CursorStyle.black.cg(style.underAlpha)
        haloOver.lineWidth = (style.overWidth + 0.4) * s
        haloOver.strokeColor = CursorStyle.amber.cg()
        let o = Float(halo.opacity * frame.opacity)
        haloFill.opacity = o
        haloUnder.opacity = o
        haloOver.opacity = o
    }

    private func applyBadge(_ frame: CursorFrame, tip: CGPoint, scale s: CGFloat) {
        caret.isHidden = true
        keyText.isHidden = true
        glyphStroke.isHidden = true
        glyphFill.isHidden = true
        for ray in rays { ray.isHidden = true }
        guard let badge = frame.badge else {
            badgeGroup.isHidden = true
            return
        }
        badgeGroup.isHidden = false
        let h = CursorStyle.badgeHeight * s
        var w = 22 * s
        if case .key(let text) = badge.kind {
            w = max(22 * s, Self.textWidth(text, size: 11 * s) + 12 * s)
        }
        badgeGroup.position = Self.keepInside(root.bounds, size: CGSize(width: w, height: h),
                                              preferred: CGPoint(x: tip.x + CursorStyle.badgeOffset.x * s,
                                                                 y: tip.y + CursorStyle.badgeOffset.y * s),
                                              flipped: CGPoint(x: tip.x - w - 4 * s, y: tip.y - h - 6 * s))
        badgeGroup.bounds = CGRect(x: 0, y: 0, width: w, height: h)
        badgeGroup.opacity = Float(badge.opacity * frame.opacity)
        badgePill.path = CGPath(roundedRect: CGRect(x: 0, y: 0, width: w, height: h), cornerWidth: h / 2, cornerHeight: h / 2,
                                transform: nil)
        let c = CGPoint(x: w / 2, y: h / 2)
        let ink = CursorStyle.white.cg(style.increaseContrast ? 1 : 0.9)

        switch badge.kind {
        case .caret:
            caret.isHidden = false
            let p = CGMutablePath()
            p.move(to: CGPoint(x: c.x, y: c.y - 5 * s))
            p.addLine(to: CGPoint(x: c.x, y: c.y + 5 * s))
            caret.path = p
            caret.lineWidth = 1.7 * s
            caret.strokeColor = CursorStyle.ice.cg()
            caret.opacity = badge.animated ? (badge.phase < 0.5 ? 1 : 0.2) : 1
        case .key(let text):
            keyText.isHidden = false
            keyText.string = text
            keyText.frame = CGRect(x: 0, y: (h - 14 * s) / 2, width: w, height: 14 * s)
        case .scroll(let direction):
            glyphStroke.isHidden = false
            glyphStroke.lineWidth = 1.5 * s
            glyphStroke.strokeColor = ink
            glyphStroke.opacity = 1
            let p = CGMutablePath()
            let flow = badge.animated ? CGFloat(sin(2 * .pi * Double(badge.phase))) * 1.1 * s : 0
            if let d = direction {
                let (dx, dy): (CGFloat, CGFloat) = d == .up ? (0, -1) : d == .down ? (0, 1) : d == .left ? (-1, 0) : (1, 0)
                for k in [-1.0, 1.0] as [CGFloat] {
                    let center = CGPoint(x: c.x + dx * (k * 2.4 * s + flow), y: c.y + dy * (k * 2.4 * s + flow))
                    p.addPath(CursorStyle.chevron(d, at: center, size: 7 * s))
                }
            } else {
                p.addPath(CursorStyle.chevron(.up, at: CGPoint(x: c.x, y: c.y - 2.8 * s - abs(flow) * 0.5), size: 7 * s))
                p.addPath(CursorStyle.chevron(.down, at: CGPoint(x: c.x, y: c.y + 2.8 * s + abs(flow) * 0.5), size: 7 * s))
            }
            glyphStroke.path = p
        case .grip:
            glyphFill.isHidden = false
            glyphFill.fillColor = ink
            let p = CGMutablePath()
            for row in 0..<3 {
                for col in 0..<2 {
                    let x = c.x + (CGFloat(col) - 0.5) * 4.4 * s
                    let y = c.y + (CGFloat(row) - 1) * 4 * s
                    p.addEllipse(in: CGRect(x: x - 1.15 * s, y: y - 1.15 * s, width: 2.3 * s, height: 2.3 * s))
                }
            }
            glyphFill.path = p
        case .menu:
            glyphStroke.isHidden = false
            glyphStroke.lineWidth = 1.5 * s
            glyphStroke.strokeColor = ink
            let p = CGMutablePath()
            for (i, len) in [8.0, 6.0, 8.0].enumerated() {
                let y = c.y + (CGFloat(i) - 1) * 3.6 * s
                p.move(to: CGPoint(x: c.x - 4 * s, y: y))
                p.addLine(to: CGPoint(x: c.x - 4 * s + CGFloat(len) * s, y: y))
            }
            glyphStroke.path = p
        case .no:
            glyphStroke.isHidden = false
            glyphStroke.lineWidth = 1.6 * s
            glyphStroke.strokeColor = CursorStyle.rose.cg()
            let r = 4.8 * s
            let p = CGMutablePath()
            p.addEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
            p.move(to: CGPoint(x: c.x + r * 0.7, y: c.y - r * 0.7))
            p.addLine(to: CGPoint(x: c.x - r * 0.7, y: c.y + r * 0.7))
            glyphStroke.path = p
        case .spinner:
            let inner = 2.6 * s * (1 - 0.6 * badge.converge)
            let outer = 6.6 * s * (1 - 0.6 * badge.converge)
            let head = Int((badge.phase * CGFloat(Self.rayCount)).rounded(.down)) % Self.rayCount
            for (i, ray) in rays.enumerated() {
                ray.isHidden = false
                let angle = CGFloat(i) / CGFloat(Self.rayCount) * 2 * .pi - .pi / 2
                let p = CGMutablePath()
                p.move(to: CGPoint(x: c.x + cos(angle) * inner, y: c.y + sin(angle) * inner))
                p.addLine(to: CGPoint(x: c.x + cos(angle) * outer, y: c.y + sin(angle) * outer))
                ray.path = p
                ray.lineWidth = 1.5 * s
                let behind = (head - i + Self.rayCount) % Self.rayCount
                let level: CGFloat = badge.animated ? 0.2 + 0.8 * max(0, 1 - CGFloat(behind) / 5) : 0.6
                ray.strokeColor = (behind == 0 && badge.animated ? CursorStyle.ice : CursorStyle.white).cg()
                ray.opacity = Float(level)
            }
        }
    }

    private func applyCaption(_ frame: CursorFrame, tip: CGPoint) {
        guard mapping.showsCaption, let caption = frame.caption else {
            captionGroup.isHidden = true
            return
        }
        captionGroup.isHidden = false
        let text = CursorStyle.captionText(caption.text)
        let h = CursorStyle.captionHeight
        let w = min(CursorStyle.captionMaxWidth, Self.textWidth(text, size: 11) + 20)
        captionGroup.position = Self.keepInside(root.bounds, size: CGSize(width: w, height: h),
                                                preferred: CGPoint(x: tip.x + CursorStyle.captionOffset.x,
                                                                   y: tip.y + CursorStyle.captionOffset.y),
                                                flipped: CGPoint(x: tip.x - w - 10, y: tip.y - h - 8))
        captionGroup.bounds = CGRect(x: 0, y: 0, width: w, height: h)
        captionGroup.opacity = Float(caption.opacity * frame.opacity)
        captionPill.path = CGPath(roundedRect: CGRect(x: 0, y: 0, width: w, height: h), cornerWidth: h / 2,
                                  cornerHeight: h / 2, transform: nil)
        captionText.string = text
        captionText.frame = CGRect(x: 8, y: (h - 14) / 2, width: w - 16, height: 14)
    }

    /// Where a badge or caption goes: beside the tip as designed, or flipped to the tip's other side on an axis where
    /// it would leave `bounds` (the window's edge), then clamped inside.
    static func keepInside(_ bounds: CGRect, size: CGSize, preferred: CGPoint, flipped: CGPoint) -> CGPoint {
        guard bounds.width > 0, bounds.height > 0 else { return preferred }
        var p = preferred
        if p.x + size.width > bounds.maxX - 2 { p.x = flipped.x }
        if p.y + size.height > bounds.maxY - 2 { p.y = flipped.y }
        p.x = min(max(p.x, bounds.minX + 2), max(bounds.minX + 2, bounds.maxX - size.width - 2))
        p.y = min(max(p.y, bounds.minY + 2), max(bounds.minY + 2, bounds.maxY - size.height - 2))
        return p
    }

    static func textWidth(_ text: String, size: CGFloat) -> CGFloat {
        let font = NSFont.systemFont(ofSize: size, weight: .medium)
        return ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }
}
