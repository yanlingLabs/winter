import XCTest
import SwiftUI
import AppKit
@testable import Winter

/// The shimmer and the review glow run on Core Animation (the render server), not as SwiftUI tickers: what the
/// layers are, that the animation is installed once and rebuilt only when the view's width changes, that they never
/// take a click, and that the mask really masks. (That the band MOVES on screen is the live gate's — an offscreen
/// bitmap shows the layers' model values, which is the band parked off the left edge.)
@MainActor
final class RenderServerAnimationTests: XCTestCase {
    private func inWindow(_ view: NSView, width: CGFloat = 200, height: CGFloat = 24) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: true)
        view.frame = NSRect(x: 0, y: 0, width: width, height: height)
        window.contentView = view
        view.layoutSubtreeIfNeeded()
        return window
    }

    // MARK: - The band

    func testTheSweepIsOneForeverKeyframeAnimationThatCrossesThenRests() {
        let animation = BandMaskView.sweep(width: 200, band: 120, now: 1_000.3)
        XCTAssertEqual(animation.keyPath, "position.x")
        XCTAssertEqual(animation.values as? [CGFloat], [-60, 260, 260], "from just off the left edge to just off the right, then held")
        XCTAssertEqual(animation.keyTimes?.map(\.doubleValue), [0, BandShimmer.sweepShare, 1])
        XCTAssertEqual(animation.duration, BandShimmer.period)
        XCTAssertEqual(animation.repeatCount, .infinity)
        XCTAssertFalse(animation.isRemovedOnCompletion)
        XCTAssertEqual(animation.beginTime, 1_000, accuracy: 0.0001, "begun on the period's clock, so every shimmer is in step")
    }

    func testTheBandIsInstalledOnceAndRebuiltOnlyWhenTheWidthChanges() {
        let view = BandMaskView()
        view.configure(rest: 0.5, peak: 1, minBand: 60, bandShare: 0.6)
        let window = inWindow(view)
        let layer = view.layer!.sublayers!.compactMap { $0 as? CAGradientLayer }.first!
        let first = layer.animation(forKey: BandMaskView.animationKey)
        XCTAssertNotNil(first, "a view in a window is animating")
        XCTAssertEqual(view.bandWidth, 120)
        view.layoutSubtreeIfNeeded(); view.needsLayout = true; view.layoutSubtreeIfNeeded()
        XCTAssertTrue(layer.animation(forKey: BandMaskView.animationKey) === first, "another layout pass leaves the running animation alone")
        view.frame.size.width = 400
        view.layoutSubtreeIfNeeded()
        XCTAssertFalse(layer.animation(forKey: BandMaskView.animationKey) === first, "a new width crosses a new distance")
        XCTAssertEqual(view.bandWidth, 240)
        withExtendedLifetime(window) {}
    }

    func testAMaskTakesNoClicks() {
        let view = BandMaskView()
        _ = inWindow(view)
        XCTAssertNil(view.hitTest(NSPoint(x: 10, y: 10)))
        let breath = PillReviewBreathView()
        _ = inWindow(breath)
        XCTAssertNil(breath.hitTest(NSPoint(x: 10, y: 10)))
    }

    private func brightness(_ rep: NSBitmapImageRep) -> Double {
        var sum = 0.0
        for x in 0..<rep.pixelsWide { for y in 0..<rep.pixelsHigh { sum += Double(rep.colorAt(x: x, y: y)?.brightnessComponent ?? 0) } }
        return sum
    }

    /// A SwiftUI view rendered to a bitmap, offscreen.
    private func render<V: View>(_ view: V) -> NSBitmapImageRep {
        let host = NSHostingView(rootView: view.frame(width: 160, height: 30).background(Color.black))
        host.frame = NSRect(x: 0, y: 0, width: 160, height: 30)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
        host.cacheDisplay(in: host.bounds, to: rep)
        withExtendedLifetime(window) {}
        return rep
    }

    /// The mask really masks (the representable's layers act as the SwiftUI mask, not as a view laid over it): with
    /// the band parked off the left edge — its model position — the label shows at the `rest` opacity.
    func testTheShimmeringLabelShowsAtRestOpacityAndAStillOneAtItsOwn() {
        let label = Text("Running 3 commands").font(.system(size: 13, weight: .medium))
        let plain = brightness(render(label.foregroundStyle(Color.white)))
        let shimmering = brightness(render(label.modifier(BandShimmer(active: true, rest: 0.5, inactive: 0.9))))
        let still = brightness(render(label.modifier(BandShimmer(active: false, rest: 0.5, inactive: 0.9))))
        XCTAssertGreaterThan(plain, 100, "the label drew")
        XCTAssertEqual(shimmering / plain, 0.5, accuracy: 0.08, "masked at the rest opacity, band off to the left")
        XCTAssertEqual(still / plain, 0.9, accuracy: 0.08)
    }

    // MARK: - The review glow

    func testTheReviewGlowBreathesBetweenItsWeakestAndStrongestForever() {
        let dim = PillReviewBreathView.colors(level: 0), bright = PillReviewBreathView.colors(level: 1)
        let group = PillReviewBreathView.breath(dim: dim, bright: bright)
        XCTAssertEqual(group.duration, pillReviewPulsePeriod / 2, "half a breath each way")
        XCTAssertTrue(group.autoreverses)
        XCTAssertEqual(group.repeatCount, .infinity)
        let fill = group.animations?.compactMap { $0 as? CABasicAnimation }.first { $0.keyPath == "backgroundColor" }
        let rim = group.animations?.compactMap { $0 as? CABasicAnimation }.first { $0.keyPath == "borderColor" }
        XCTAssertNotNil(fill)
        XCTAssertNotNil(rim)
        XCTAssertEqual(NSColor(cgColor: dim.fill)?.alphaComponent ?? 0, 0.08, accuracy: 0.001, "the SwiftUI glow's numbers")
        XCTAssertEqual(NSColor(cgColor: bright.fill)?.alphaComponent ?? 0, 0.22, accuracy: 0.001)
        XCTAssertEqual(NSColor(cgColor: dim.rim)?.alphaComponent ?? 0, 0.35, accuracy: 0.001)
        XCTAssertEqual(NSColor(cgColor: bright.rim)?.alphaComponent ?? 0, 0.80, accuracy: 0.001)
    }

    func testTheBreathIsInstalledOnceInAWindowAndShapedLikeThePill() {
        let view = PillReviewBreathView()
        view.configure(cornerRadius: 16, continuous: true)
        let window = inWindow(view, width: 300, height: 36)
        let glow = view.layer!.sublayers!.first!
        XCTAssertNotNil(glow.animation(forKey: PillReviewBreathView.animationKey))
        XCTAssertEqual(glow.cornerRadius, 16)
        XCTAssertEqual(glow.cornerCurve, .continuous)
        XCTAssertEqual(glow.frame.size, CGSize(width: 300, height: 36))
        let first = glow.animation(forKey: PillReviewBreathView.animationKey)
        view.needsLayout = true; view.layoutSubtreeIfNeeded()
        XCTAssertTrue(glow.animation(forKey: PillReviewBreathView.animationKey) === first, "a layout pass does not restart the breath")
        withExtendedLifetime(window) {}
    }

    // MARK: - The thinking line's breath

    func testTheThinkingLineBreathesOnTheRenderServerAndShowsInFullAtRest() {
        let animation = OpacityBreathView.breath(low: 0.55, high: 1, halfPeriod: 1)
        XCTAssertEqual(animation.keyPath, "opacity")
        XCTAssertEqual(animation.fromValue as? Double, 0.55)
        XCTAssertEqual(animation.toValue as? Double, 1)
        XCTAssertEqual(animation.duration, 1)
        XCTAssertTrue(animation.autoreverses)
        XCTAssertEqual(animation.repeatCount, .infinity)

        let view = OpacityBreathView()
        view.configure(low: 0.55, high: 1, halfPeriod: 1)
        let window = inWindow(view)
        let solid = view.layer!.sublayers!.first!
        XCTAssertNotNil(solid.animation(forKey: OpacityBreathView.animationKey))
        XCTAssertEqual(solid.opacity, 1, "at rest the line shows in full")
        let first = solid.animation(forKey: OpacityBreathView.animationKey)
        view.needsLayout = true; view.layoutSubtreeIfNeeded()
        XCTAssertTrue(solid.animation(forKey: OpacityBreathView.animationKey) === first)
        XCTAssertNil(view.hitTest(NSPoint(x: 3, y: 3)))
        withExtendedLifetime(window) {}

        let label = Text("Thinking").font(.system(size: 13)).foregroundStyle(Color.white)
        let plain = brightness(render(label))
        let pulsing = brightness(render(label.modifier(OpacityBreath(active: true))))
        let idle = brightness(render(label.modifier(OpacityBreath(active: false))))
        XCTAssertEqual(pulsing / plain, 1, accuracy: 0.05, "the model value is full opacity")
        XCTAssertEqual(idle / plain, 1, accuracy: 0.05)
    }
}
