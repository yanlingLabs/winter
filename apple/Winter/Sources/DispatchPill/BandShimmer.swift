import AppKit
import SwiftUI

/// A bright band passing through a white view, left to right, then resting a beat (user,
/// 2026-10-04): the running tool pill's label, and the Winter mark a session window shows while its
/// history loads. The view is drawn ONCE and masked — never duplicated, so a climbing count or a
/// rotating name inside it stays single. While `active`, the view sits at `rest` opacity and the band
/// lifts it towards full; otherwise, and always under Reduce Motion, it is still at `inactive`.
///
/// The band is a CoreAnimation animation on a layer (`BandMaskView`), not a SwiftUI one: it runs on the render
/// server, so a running pill costs the main thread nothing per frame — no `TimelineView`, no `GeometryReader`, no
/// body re-evaluation, and no layout pass through the lazy transcript it sits in (a display-rate SwiftUI ticker
/// inside a long `LazyVStack` was the thing a hung main thread kept relaying out).
struct BandShimmer: ViewModifier {
    let active: Bool
    /// The view's opacity away from the band.
    let rest: Double
    /// The view's opacity when not shimmering.
    let inactive: Double
    /// The band's opacity at its centre, laid over `rest`.
    var peak: Double = 1
    /// The band's narrowest, and its width as a share of the view's.
    var minBand: CGFloat = 60
    var bandShare: CGFloat = 0.6

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let period: TimeInterval = 2.0
    /// The share of a period the band takes to cross; the rest is the pause before the next pass.
    static let sweepShare: Double = 0.7

    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content
                .foregroundStyle(Color.white)
                .mask { BandMask(rest: rest, peak: peak, minBand: minBand, bandShare: bandShare) }
        } else {
            content.foregroundStyle(Color.white.opacity(inactive))
        }
    }
}

/// The mask: a layer-backed view that never takes a click.
private struct BandMask: NSViewRepresentable {
    let rest: Double
    let peak: Double
    let minBand: CGFloat
    let bandShare: CGFloat

    func makeNSView(context: Context) -> BandMaskView {
        let view = BandMaskView()
        view.configure(rest: rest, peak: peak, minBand: minBand, bandShare: bandShare)
        return view
    }

    func updateNSView(_ view: BandMaskView, context: Context) {
        view.configure(rest: rest, peak: peak, minBand: minBand, bandShare: bandShare)
    }
}

/// `rest` black everywhere, and over it a horizontal gradient band (clear → `peak` → clear) crossing the view in
/// `sweepShare` of each `period` and resting for the remainder. The crossing is ONE keyframe animation repeated
/// forever, begun on a shared clock so every shimmer on screen is in step.
final class BandMaskView: NSView {
    private let restLayer = CALayer()
    private let bandLayer = CAGradientLayer()
    private var rest = 0.5
    private var peak = 1.0
    private var minBand: CGFloat = 60
    private var bandShare: CGFloat = 0.6
    /// The width the installed animation was built for.
    private var animatedWidth: CGFloat = 0

    static let animationKey = "band"

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(restLayer)
        layer?.addSublayer(bandLayer)
        bandLayer.startPoint = CGPoint(x: 0, y: 0.5)
        bandLayer.endPoint = CGPoint(x: 1, y: 0.5)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// A mask is a picture: it takes no mouse events, so the pill's button under it keeps working.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func configure(rest: Double, peak: Double, minBand: CGFloat, bandShare: CGFloat) {
        guard rest != self.rest || peak != self.peak || minBand != self.minBand || bandShare != self.bandShare else { return }
        self.rest = rest
        self.peak = peak
        self.minBand = minBand
        self.bandShare = bandShare
        animatedWidth = 0 // rebuild at the next layout
        needsLayout = true
    }

    var bandWidth: CGFloat { max(minBand, bounds.width * bandShare) }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        restLayer.frame = bounds
        restLayer.backgroundColor = NSColor.black.withAlphaComponent(rest).cgColor
        let band = bandWidth
        bandLayer.frame = CGRect(x: -band, y: 0, width: band, height: bounds.height)
        bandLayer.colors = [NSColor.black.withAlphaComponent(0).cgColor, NSColor.black.withAlphaComponent(peak).cgColor,
                            NSColor.black.withAlphaComponent(0).cgColor]
        CATransaction.commit()
        installAnimationIfNeeded()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Core Animation drops a layer's animations when it leaves a window; put the band back.
        animatedWidth = 0
        needsLayout = true
    }

    private func installAnimationIfNeeded() {
        guard bounds.width > 0, window != nil else { return }
        if bandLayer.animation(forKey: Self.animationKey) != nil, animatedWidth == bounds.width { return }
        animatedWidth = bounds.width
        bandLayer.removeAnimation(forKey: Self.animationKey)
        bandLayer.add(Self.sweep(width: bounds.width, band: bandWidth, now: CACurrentMediaTime()), forKey: Self.animationKey)
    }

    /// The band's centre travels from just off the left edge (its right edge at 0) to just off the right (its left
    /// edge at `width`) in `sweepShare` of the period, then waits there for the rest of it.
    static func sweep(width: CGFloat, band: CGFloat, now: CFTimeInterval) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: "position.x")
        animation.values = [-band / 2, width + band / 2, width + band / 2]
        animation.keyTimes = [0, NSNumber(value: BandShimmer.sweepShare), 1]
        animation.calculationMode = .linear
        animation.duration = BandShimmer.period
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        // A shared clock: every shimmer starts each period together, wherever and whenever it appeared.
        animation.beginTime = now - now.truncatingRemainder(dividingBy: BandShimmer.period)
        return animation
    }
}

// MARK: - A slow opacity breath, on the render server

/// A view's opacity breathing between `low` and `high`, forever — the quiet "Thinking" line in a transcript that is
/// not pill-themed. It used to be a display-rate `TimelineView` wrapped around the row, which re-evaluated the row
/// (and let its lazy stack re-measure) every frame for as long as the client believed the block was streaming.
/// Now it is a mask whose layer's opacity is animated by Core Animation: nothing runs on the main thread.
struct OpacityBreath: ViewModifier {
    let active: Bool
    var low: Double = 0.55
    var high: Double = 1
    /// Seconds from `low` to `high` (one way).
    var halfPeriod: TimeInterval = 1

    func body(content: Content) -> some View {
        if active {
            content.mask { OpacityBreathMask(low: low, high: high, halfPeriod: halfPeriod) }
        } else {
            content
        }
    }
}

private struct OpacityBreathMask: NSViewRepresentable {
    let low: Double
    let high: Double
    let halfPeriod: TimeInterval

    func makeNSView(context: Context) -> OpacityBreathView {
        let view = OpacityBreathView()
        view.configure(low: low, high: high, halfPeriod: halfPeriod)
        return view
    }

    func updateNSView(_ view: OpacityBreathView, context: Context) {
        view.configure(low: low, high: high, halfPeriod: halfPeriod)
    }
}

/// One solid black layer whose `opacity` goes `low` ↔ `high` (ease in and out, which a cosine is) for as long as the
/// view is in a window. At rest — before the animation, or if it never runs — the layer is at `high`: the line shows
/// in full rather than dimmed.
final class OpacityBreathView: NSView {
    static let animationKey = "breath"
    private let solid = CALayer()
    private var low = 0.55
    private var high = 1.0
    private var halfPeriod: TimeInterval = 1

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        solid.backgroundColor = NSColor.black.cgColor
        layer?.addSublayer(solid)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func configure(low: Double, high: Double, halfPeriod: TimeInterval) {
        guard low != self.low || high != self.high || halfPeriod != self.halfPeriod else { return }
        self.low = low
        self.high = high
        self.halfPeriod = halfPeriod
        solid.removeAnimation(forKey: Self.animationKey)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        solid.frame = bounds
        solid.opacity = Float(high)
        CATransaction.commit()
        guard window != nil, solid.animation(forKey: Self.animationKey) == nil else { return }
        solid.add(Self.breath(low: low, high: high, halfPeriod: halfPeriod), forKey: Self.animationKey)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        solid.removeAnimation(forKey: Self.animationKey)
        needsLayout = true
    }

    static func breath(low: Double, high: Double, halfPeriod: TimeInterval) -> CABasicAnimation {
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = low
        animation.toValue = high
        animation.duration = halfPeriod
        animation.autoreverses = true
        animation.repeatCount = .infinity
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        animation.isRemovedOnCompletion = false
        return animation
    }
}
