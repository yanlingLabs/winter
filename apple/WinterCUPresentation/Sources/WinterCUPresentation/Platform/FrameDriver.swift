import AppKit
import QuartzCore

/// Drives the cursor at display rate with a `CADisplayLink`: about 20 Hz while it only breathes, up to 60–120 Hz while
/// it moves, and not at all when nothing changes.
@MainActor final class DisplayLinkDriver: NSObject, CUFrameDriver {
    private var link: CADisplayLink?
    private var timer: Timer?
    private var tick: (@MainActor () -> Void)?

    var isRunning: Bool { link != nil || timer != nil }

    func start(_ need: CursorAnimationNeed, _ tick: @escaping @MainActor () -> Void) {
        self.tick = tick
        let range = need == .low
            ? CAFrameRateRange(minimum: 10, maximum: 24, preferred: 20)
            : CAFrameRateRange(minimum: 30, maximum: 120, preferred: 60)
        if let link {
            link.preferredFrameRateRange = range
            return
        }
        if timer != nil { return }
        if let screen = NSScreen.main {
            let l = screen.displayLink(target: self, selector: #selector(step(_:)))
            l.preferredFrameRateRange = range
            l.add(to: .main, forMode: .common)
            link = l
        } else {
            let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick?() }
            }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
    }

    @objc private func step(_ link: CADisplayLink) {
        tick?()
    }

    func stop() {
        link?.invalidate()
        link = nil
        timer?.invalidate()
        timer = nil
        tick = nil
    }
}

/// Reduce Motion and Increase Contrast, as the user set them in System Settings › Accessibility › Display.
@MainActor final class SystemAccessibility: CUAccessibilitySource {
    var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    var increaseContrast: Bool { NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast }
}
