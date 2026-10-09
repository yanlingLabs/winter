import CoreGraphics
import Foundation

// The seams between the controller's decisions and what AppKit draws. The real implementations live in Platform/;
// tests use recording fakes, so no window is ever created by a unit test.

/// Window and screen geometry. Reads must be cheap: the real source answers from a cache a background queue keeps
/// fresh (`WindowTracker`), never by listing windows on the main thread.
@MainActor protocol CUWindowSource: AnyObject {
    func snapshot(of windowID: CGWindowID) -> WindowSnapshot?
    func screens() -> [ScreenInfo]
    /// The on-screen windows above `windowID`, front to back, as last fetched; nil before the first fetch.
    func windowsAbove(_ windowID: CGWindowID) -> [StackWindow]?
    /// How often the controller reads the cache now: the source need not refresh it more often than that.
    func setFollowInterval(_ seconds: TimeInterval)
}

extension CUWindowSource {
    func setFollowInterval(_ seconds: TimeInterval) {}
}

/// One entry of the on-screen window list.
struct StackWindow: Equatable, Sendable {
    var id: CGWindowID
    var pid: pid_t
    /// The window server's layer: 0 for ordinary app windows.
    var layer: Int
    /// Top-left global points.
    var bounds: CGRect
    var alpha: CGFloat = 1
    var isOnScreen = true
    /// The owning app's name (needs no permission), for the logs.
    var ownerName: String?
}

/// Whether the cursor would be seen at its point: true unless a window above the target covers the point. The overlay
/// floats above every app, so this is what keeps "windows covering the target also cover its cursor".
enum CursorOcclusion {
    /// The window that hides the point, if any.
    ///
    /// Never counted: the helper's own panels (overlay, mirror); the menu bar, the Dock, menus, palettes and every other
    /// non-zero level; see-through windows; and the target app's ATTACHMENTS — the parts an app draws as separate windows
    /// over its main one (a tab bar or toolbar strip, a status bar, a sheet, a popover; `isAttachment`). The agent acts
    /// on exactly those parts, and they never hide the target from the user. Another window of the same app (a second
    /// browser window in front) does count: the target is not visible there.
    ///
    /// - Parameters:
    ///   - above: the on-screen windows above the target, front to back (only those can cover it).
    ///   - targetFrame: the target window's frame (top-left global points).
    static func coveringWindow(at point: CGPoint, above: [StackWindow], ownPID: pid_t, targetPID: pid_t,
                               targetFrame: CGRect) -> StackWindow? {
        above.first { window in
            guard window.pid != ownPID, window.layer == 0, window.alpha >= 0.05,
                  window.bounds.width > 1, window.bounds.height > 1, window.bounds.contains(point) else { return false }
            if window.pid == targetPID, isAttachment(window.bounds, of: targetFrame) { return false }
            return true
        }
    }

    static func isVisible(at point: CGPoint, above: [StackWindow], ownPID: pid_t, targetPID: pid_t,
                          targetFrame: CGRect) -> Bool {
        coveringWindow(at: point, above: above, ownPID: ownPID, targetPID: targetPID, targetFrame: targetFrame) == nil
    }

    /// How far outside the target an attachment may reach (a tab strip above the content, a popover's overhang).
    static let attachmentMargin: CGFloat = 48
    /// A same-app window thinner than this on either side is a strip (tab bar, status bar), never a window of its own.
    static let stripThickness: CGFloat = 120

    /// Whether a window of the target's own app is part of the target rather than a window in front of it: a strip
    /// (thinner than `stripThickness` on a side), or one lying within the target's frame (give or take
    /// `attachmentMargin`) while smaller than it (a sheet, a popover).
    static func isAttachment(_ bounds: CGRect, of target: CGRect) -> Bool {
        if min(bounds.width, bounds.height) < stripThickness { return true }
        guard !target.isEmpty else { return false }
        let inside = target.insetBy(dx: -attachmentMargin, dy: -attachmentMargin).contains(bounds)
        let smaller = bounds.width * bounds.height < target.width * target.height * 0.9
        return inside && smaller
    }
}

/// One mirror on screen. Frames are top-left global points.
@MainActor protocol MirrorSurface: AnyObject {
    /// Position and size the panel. `contentSize` is the live image's size inside it; `windowAspect` (width / height)
    /// is the window's own, when known (the image is letterboxed when the two differ); `stackIndex` 0 is the newest.
    func place(frame: CGRect, contentSize: CGSize, windowAspect: CGFloat?, stackIndex: Int)
    /// Fade in (start streaming) or fade out (stop streaming).
    func setShown(_ shown: Bool)
    /// Put this mirror above the other mirrors.
    func bringToFront()
    /// Draw the agent cursor inside the mirror. `frame` is in the window's local space; `windowSize` lets the mirror
    /// map it into its live image.
    func apply(cursor frame: CursorFrame, style: CursorStyle, windowSize: CGSize)
    /// Tear down for good (session ended, or the mirror is no longer wanted).
    func close()
}

/// The click-through overlay above one target window that carries the agent cursor.
@MainActor protocol CursorOverlaySurface: AnyObject {
    /// Cover `windowFrame` (top-left global points), the overlay of window `windowID`; `reorder` re-asserts it in front.
    func place(windowFrame: CGRect, aboveWindow windowID: CGWindowID, reorder: Bool)
    func setShown(_ shown: Bool)
    /// Another window covers the cursor's point: fade the cursor out, and back in when it is seen again.
    func setOccluded(_ occluded: Bool)
    /// Draw the cursor as `frame` says (window-local, top-left origin).
    func apply(cursor frame: CursorFrame, style: CursorStyle)
    func close()
}

/// Calls back once per display frame while the cursor animates, at a rate matched to what it needs.
@MainActor protocol CUFrameDriver: AnyObject {
    var isRunning: Bool { get }
    func start(_ need: CursorAnimationNeed, _ tick: @escaping @MainActor () -> Void)
    func stop()
}

/// The system's accessibility display preferences, read fresh on every use.
@MainActor protocol CUAccessibilitySource: AnyObject {
    var reduceMotion: Bool { get }
    var increaseContrast: Bool { get }
}

@MainActor protocol CUSurfaceFactory {
    func makeMirror(target: CUWindowRef) -> MirrorSurface
    func makeOverlay(target: CUWindowRef) -> CursorOverlaySurface
}
