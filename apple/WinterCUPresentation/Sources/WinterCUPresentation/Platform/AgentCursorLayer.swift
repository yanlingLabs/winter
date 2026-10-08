import AppKit
import QuartzCore

/// Winter's agent cursor: a black arrow with a faint white rim and a soft shadow, gliding between action points, with a
/// ring that spreads from the tip when it presses. Used both in the overlay above the target window and, smaller, inside
/// the mirror. Coordinates are those of `parent`, which must be geometry-flipped (top-left origin, y down).
@MainActor final class AgentCursorLayer {
    let root = CALayer()
    private let arrow = CAShapeLayer()
    private weak var parent: CALayer?
    private let scale: CGFloat
    private(set) var position: CGPoint?

    init(parent: CALayer, scale: CGFloat) {
        self.parent = parent
        self.scale = scale
        root.anchorPoint = .zero // the arrow's tip is the layer's origin, so `position` is the point it points at
        root.bounds = CGRect(x: 0, y: 0, width: 16 * scale, height: 22 * scale)
        root.opacity = 0
        root.zPosition = 10

        arrow.path = Self.arrowPath(scale: scale)
        arrow.fillColor = NSColor(white: 0.04, alpha: 0.94).cgColor
        arrow.strokeColor = NSColor(white: 1, alpha: 0.78).cgColor
        arrow.lineWidth = max(1, 1.4 * scale)
        arrow.lineJoin = .round
        arrow.shadowColor = NSColor.black.cgColor
        arrow.shadowOpacity = 0.35
        arrow.shadowRadius = 3 * scale
        arrow.shadowOffset = CGSize(width: 0, height: 1)
        root.addSublayer(arrow)
        parent.addSublayer(root)
    }

    /// Glide to `point` and show `kind` there; for a drag, press at `point`, glide to `dragTo` and release.
    func show(at point: CGPoint, kind: CUCursorKind, dragTo: CGPoint?) {
        glide(to: point) { [weak self] in
            guard let self else { return }
            switch kind {
            case .move:
                break
            case .press:
                self.ring(at: point, radius: 15, strong: true)
            case .type, .scroll:
                self.ring(at: point, radius: 10, strong: false)
            case .drag:
                guard let end = dragTo else { return }
                self.setPressed(true)
                self.glide(to: end) { [weak self] in
                    self?.setPressed(false)
                    self?.ring(at: end, radius: 12, strong: false)
                }
            }
        }
    }

    func setVisible(_ visible: Bool) {
        CATransaction.begin()
        CATransaction.setAnimationDuration(visible ? 0.15 : 0.35)
        root.opacity = visible ? 1 : 0
        CATransaction.commit()
    }

    /// Forget the last point, so the next show appears in place instead of gliding from far away.
    func reset() {
        position = nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        root.opacity = 0
        CATransaction.commit()
    }

    private func glide(to point: CGPoint, then completion: @escaping @MainActor () -> Void) {
        let duration = CursorMotion.duration(from: position, to: point)
        let first = position == nil
        position = point
        CATransaction.begin()
        if first || duration == 0 {
            CATransaction.setDisableActions(true)
            root.position = point
            CATransaction.commit()
            setVisible(true)
            completion()
            return
        }
        CATransaction.setAnimationDuration(duration)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.215, 0.61, 0.355, 1))
        CATransaction.setCompletionBlock { MainActor.assumeIsolated { completion() } }
        root.position = point
        root.opacity = 1
        CATransaction.commit()
    }

    private func setPressed(_ pressed: Bool) {
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.08)
        arrow.setAffineTransform(pressed ? CGAffineTransform(scaleX: 0.86, y: 0.86) : .identity)
        CATransaction.commit()
    }

    /// A ring that spreads from the tip and fades.
    private func ring(at point: CGPoint, radius: CGFloat, strong: Bool) {
        guard let parent else { return }
        let r = radius * scale
        let ring = CAShapeLayer()
        ring.bounds = CGRect(x: 0, y: 0, width: 2 * r, height: 2 * r)
        ring.position = point
        ring.path = CGPath(ellipseIn: ring.bounds, transform: nil)
        ring.fillColor = NSColor(white: 1, alpha: strong ? 0.14 : 0.08).cgColor
        ring.strokeColor = NSColor(white: 1, alpha: strong ? 0.85 : 0.6).cgColor
        ring.lineWidth = max(1, (strong ? 2 : 1.5) * scale)
        ring.zPosition = 9
        parent.addSublayer(ring)

        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.35
        grow.toValue = 1.45
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = strong ? 0.95 : 0.7
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = CursorMotion.pulseDuration
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        CATransaction.begin()
        CATransaction.setCompletionBlock { ring.removeFromSuperlayer() }
        ring.opacity = 0
        ring.add(group, forKey: "pulse")
        CATransaction.commit()
    }

    /// The arrow outline, tip at (0, 0), drawn for a y-down space.
    private static func arrowPath(scale s: CGFloat) -> CGPath {
        let points: [CGPoint] = [
            CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 16.5), CGPoint(x: 4.2, y: 12.7), CGPoint(x: 7, y: 19),
            CGPoint(x: 9.9, y: 17.8), CGPoint(x: 7.2, y: 11.7), CGPoint(x: 12.6, y: 11.7),
        ]
        let path = CGMutablePath()
        path.addLines(between: points.map { CGPoint(x: $0.x * s, y: $0.y * s) })
        path.closeSubpath()
        return path
    }
}
