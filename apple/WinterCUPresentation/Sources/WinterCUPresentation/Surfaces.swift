import CoreGraphics

// The seams between the controller's decisions and what AppKit draws. The real implementations live in Platform/;
// tests use recording fakes, so no window is ever created by a unit test.

/// Window and screen geometry, read fresh on every call.
@MainActor protocol CUWindowSource: AnyObject {
    func snapshot(of windowID: CGWindowID) -> WindowSnapshot?
    func screens() -> [ScreenInfo]
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
    /// Draw the agent cursor inside the mirror at `fraction` of the window (0…1 from the top-left).
    func showCursor(atFraction fraction: CGPoint, kind: CUCursorKind, dragToFraction: CGPoint?)
    /// Tear down for good (session ended, or the mirror is no longer wanted).
    func close()
}

/// The click-through overlay above one target window that carries the agent cursor.
@MainActor protocol CursorOverlaySurface: AnyObject {
    /// Cover `windowFrame` (top-left global points), ordered just above window `windowID`.
    func place(windowFrame: CGRect, aboveWindow windowID: CGWindowID, reorder: Bool)
    func setShown(_ shown: Bool)
    /// Glide the cursor to `point` (window-local, top-left origin) and show the action.
    func moveCursor(to point: CGPoint, kind: CUCursorKind, dragTo: CGPoint?)
    func close()
}

@MainActor protocol CUSurfaceFactory {
    func makeMirror(target: CUWindowRef) -> MirrorSurface
    func makeOverlay(target: CUWindowRef) -> CursorOverlaySurface
}
