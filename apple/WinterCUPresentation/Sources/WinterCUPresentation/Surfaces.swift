import CoreGraphics

// The seams between the controller's decisions and what AppKit draws. The real implementations live in Platform/;
// tests use recording fakes, so no window is ever created by a unit test.

/// Window and screen geometry. Reads must be cheap: the real source answers from a cache a background queue keeps
/// fresh (`WindowTracker`), never by listing windows on the main thread.
@MainActor protocol CUWindowSource: AnyObject {
    func snapshot(of windowID: CGWindowID) -> WindowSnapshot?
    func screens() -> [ScreenInfo]
    /// The on-screen windows above `windowID`, front to back, as last fetched; nil before the first fetch.
    func windowsAbove(_ windowID: CGWindowID) -> [StackWindow]?
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
}

/// Whether the cursor would be seen at its point: true unless an ordinary window ABOVE the target covers the point.
/// The overlay floats above every app, so this is what keeps "windows covering the target also cover its cursor".
enum CursorOcclusion {
    /// - Parameter above: the on-screen windows above the target (only those can cover it).
    static func isVisible(at point: CGPoint, above: [StackWindow], ownPID: pid_t) -> Bool {
        !above.contains { window in
            // The helper's own panels (mirrors, overlays), the menu bar, the Dock, menus and other floating levels
            // never decide it, and neither does a see-through window.
            window.pid != ownPID && window.layer == 0 && window.alpha >= 0.05 && window.bounds.contains(point)
        }
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
