import AppKit
import CoreGraphics

/// Window geometry from the window server, through `WindowTracker`'s background-refreshed cache; screens from AppKit
/// (flipped to top-left points). Reading a window's bounds and on-screen flag needs no permission.
@MainActor final class SystemWindowSource: CUWindowSource {
    private let tracker: WindowTracker

    init(tracker: WindowTracker = WindowTracker()) {
        self.tracker = tracker
    }

    func snapshot(of windowID: CGWindowID) -> WindowSnapshot? {
        tracker.snapshot(of: windowID)
    }

    func windowsAbove(_ windowID: CGWindowID) -> [StackWindow]? {
        tracker.windowsAbove(windowID)
    }

    func screens() -> [ScreenInfo] {
        AppKitScreens.all()
    }
}

/// AppKit's screens in top-left global points, the main (menu-bar) screen first.
@MainActor enum AppKitScreens {
    /// The height of the screen whose AppKit origin is (0, 0): the axis the flip turns around.
    static var primaryHeight: CGFloat {
        let screens = NSScreen.screens
        return (screens.first { $0.frame.origin == .zero } ?? screens.first)?.frame.height ?? 0
    }

    static func all() -> [ScreenInfo] {
        let h = primaryHeight
        return NSScreen.screens.map {
            ScreenInfo(frame: QuartzSpace.flip($0.frame, primaryHeight: h),
                       visibleFrame: QuartzSpace.flip($0.visibleFrame, primaryHeight: h))
        }
    }

    /// A top-left global rect as an AppKit window frame.
    static func appKitFrame(_ quartz: CGRect) -> CGRect {
        QuartzSpace.flip(quartz, primaryHeight: primaryHeight)
    }

    /// The backing scale of the screen holding most of `quartz` (2 on Retina).
    static func backingScale(for quartz: CGRect) -> CGFloat {
        let appKit = appKitFrame(quartz)
        let best = NSScreen.screens.max { a, b in
            area(a.frame.intersection(appKit)) < area(b.frame.intersection(appKit))
        }
        return (best ?? NSScreen.main)?.backingScaleFactor ?? 2
    }

    private static func area(_ r: CGRect) -> CGFloat { r.isNull ? 0 : r.width * r.height }
}
