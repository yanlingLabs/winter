import CoreGraphics
import Foundation
import os

/// Every number the presentation layer uses, in one place. Points are screen points.
struct PresentationTuning: Sendable {
    // Mirror size: the live image is ~360 pt wide; tall windows get a narrower image so the mirror never grows taller
    // than `mirrorMaxContentHeight`, and very wide windows are letterboxed at `mirrorMinContentHeight`.
    var mirrorContentWidth: CGFloat = 360
    var mirrorMaxContentHeight: CGFloat = 300
    var mirrorMinContentHeight: CGFloat = 90
    var mirrorMinContentWidth: CGFloat = 160
    /// The rim between the panel edge and the live image.
    var mirrorPadding: CGFloat = 3
    /// The strip under the image that names the app.
    var mirrorCaptionHeight: CGFloat = 20
    /// Offset of the mirror's top-left from the window's top-left. Small enough to cover the traffic lights.
    var anchorInset: CGFloat = 4
    /// Distance kept from a screen's visible edge (menu bar, Dock) when clamping or docking.
    var screenMargin: CGFloat = 10
    /// Gap between two mirrors docked in the same corner.
    var stackGap: CGFloat = 8
    /// At most this many mirrors on screen; the most recent is on top.
    var maxMirrors = 2
    /// A mirror fades this long after the last action on its target.
    var idleFade: TimeInterval = 30
    /// The overlay cursor fades this long after its last action.
    var cursorIdleHide: TimeInterval = 4
    /// Mirror stream rate (the ruling allows 10–15).
    var framesPerSecond: Int = 12
    /// How often windows are re-read to follow them, and timers are checked.
    var trackingInterval: TimeInterval = 1.0 / 20
    /// The overlay is re-ordered above its target window at most this often (the target can come to the front).
    var overlayReorderInterval: TimeInterval = 0.5
    /// A window must show at least this many square points on some screen to count as on-screen.
    var minVisibleArea: CGFloat = 400
    /// `expectSyntheticEscape(for:)` is clamped to this, so a caller can never switch the stop key off for long.
    var maxSyntheticEscapeWindow: TimeInterval = 2
    /// The image size used before a window's frame is known (16:10).
    var defaultWindowSize = CGSize(width: 1440, height: 900)

    static let standard = PresentationTuning()
}

/// Monotonic time in seconds. Injected so timers can be tested without waiting.
protocol CUClock {
    var now: TimeInterval { get }
}

struct SystemClock: CUClock {
    var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
}

/// Repeating main-thread callbacks, injected so tests drive ticks by hand.
@MainActor protocol CUTicker: AnyObject {
    var isRunning: Bool { get }
    func start(interval: TimeInterval, _ tick: @escaping @MainActor () -> Void)
    func stop()
}

@MainActor final class RunLoopTicker: CUTicker {
    private var timer: Timer?
    var isRunning: Bool { timer != nil }

    func start(interval: TimeInterval, _ tick: @escaping @MainActor () -> Void) {
        stop()
        let t = Timer(timeInterval: interval, repeats: true) { _ in
            MainActor.assumeIsolated { tick() }
        }
        t.tolerance = interval / 4
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }
}

/// The package's log. Tests swap `sink` to observe messages.
enum PresentationLog {
    private static let logger = Logger(subsystem: "com.winter.computeruse", category: "presentation")
    nonisolated(unsafe) static var sink: (String) -> Void = { message in
        logger.notice("\(message, privacy: .public)")
    }

    static func notice(_ message: String) { sink(message) }
}
