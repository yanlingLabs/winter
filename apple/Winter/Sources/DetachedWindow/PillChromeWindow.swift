import AppKit

/// A detached session window drawn entirely by Winter, in the dispatch pill's material (user,
/// 2026-10-02): no macOS frame — so no system rim, corner radius or titlebar — just the black rounded
/// shape the SwiftUI root draws (`DetachedWindowRootView`) with the pill's corner radius — no rim, and
/// no system shadow (whose edge read as one); the window is transparent outside that shape.
///
/// A frameless window gives up what the frame used to do, so this class does it:
/// - it can become key and main (a borderless window refuses both by default);
/// - Cmd-W / Cmd-M / the self-drawn traffic lights close, minimise and zoom it (the stock
///   `perform…` versions beep without native buttons to press);
/// - resizing is `PillWindowResizeHandles`, laid over the content (AppKit's own edge tracking is a
///   feature of the system frame);
/// - moving is the SwiftUI root's drag band along the top.
final class PillChromeWindow: NSPanel {
    /// The rounded shape's radius — the dispatch pill's own (`DispatchPillMetrics.maxCornerRadius`).
    static let cornerRadius: CGFloat = DispatchPillMetrics.maxCornerRadius

    /// The frame to restore when a zoomed window is zoomed again.
    private var unzoomedFrame: NSRect?

    init(contentRect: NSRect) {
        // A PANEL, non-activating — the dispatch pill's own kind. Measured 2026-10-02 with the user's
        // Terminal full screen: macOS lets another app's ordinary WINDOW onto a full-screen app's Space
        // once at most (the second session window went to the regular desktop, invisible), and
        // activating Winter to show one jumped the user to a desktop with Winter's windows. A
        // non-activating auxiliary panel is what full-screen Spaces admit, as many as are opened, and it
        // takes the keyboard without activating Winter — no jump.
        super.init(contentRect: contentRect,
                   styleMask: [.borderless, .resizable, .closable, .miniaturizable, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isFloatingPanel = false          // an ordinary window's level, not always-on-top
        hidesOnDeactivate = false        // a panel's default would hide it whenever Winter is inactive
        becomesKeyOnlyIfNeeded = false   // a click anywhere in it takes the keyboard
        isOpaque = false
        backgroundColor = .clear
        // Opens on the Space the user is on — a full-screen app's included — and stays there.
        collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        // No system shadow: on a dark window the window server's shadow carries its own thin light
        // edge — the rim the user saw even with no stroke drawn (2026-10-02). The black shape stands
        // on its own, like the dispatch pill does.
        hasShadow = false
    }

    /// Cmd-W / Cmd-M straight to the window: a non-activating panel's keys do not reach the app's
    /// menu while Winter is not the active app.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == .command, let key = event.charactersIgnoringModifiers?.lowercased() {
            switch key {
            case "w": performClose(nil); return true
            case "m": performMiniaturize(nil); return true
            default: break
            }
        }
        return super.performKeyEquivalent(with: event)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    /// Cmd-W and the red light: ask the delegate, then close.
    override func performClose(_ sender: Any?) {
        if let delegate, delegate.responds(to: #selector(NSWindowDelegate.windowShouldClose(_:))),
           delegate.windowShouldClose?(self) == false {
            return
        }
        close()
    }

    /// Cmd-M and the yellow light.
    override func performMiniaturize(_ sender: Any?) {
        miniaturize(sender)
    }

    /// The green light: fill the screen's visible frame, and back again.
    override func performZoom(_ sender: Any?) {
        guard let visible = screen?.visibleFrame else { return }
        if let unzoomedFrame, frame == visible {
            setFrame(unzoomedFrame, display: true, animate: true)
            self.unzoomedFrame = nil
        } else {
            unzoomedFrame = frame
            setFrame(visible, display: true, animate: true)
        }
    }

    override var isZoomed: Bool { unzoomedFrame != nil }
}

// MARK: - Resizing (pure — `DetachedWindowTests`)

/// Which edges a resize drag moves. A corner moves two.
struct PillWindowResizeEdges: OptionSet, Hashable {
    let rawValue: Int
    static let left = PillWindowResizeEdges(rawValue: 1 << 0)
    static let right = PillWindowResizeEdges(rawValue: 1 << 1)
    static let bottom = PillWindowResizeEdges(rawValue: 1 << 2)
    static let top = PillWindowResizeEdges(rawValue: 1 << 3)
}

/// PURE: the window frame a resize drag produces. `start` is the frame when the drag began, `delta`
/// the mouse's movement since then in SCREEN coordinates (y-up). The opposite edge stays put, and the
/// frame never shrinks below `minSize` (the moving edge stops instead).
func pillWindowResizedFrame(start: NSRect, delta: CGPoint, edges: PillWindowResizeEdges, minSize: NSSize) -> NSRect {
    var frame = start
    if edges.contains(.right) {
        frame.size.width = max(minSize.width, start.width + delta.x)
    }
    if edges.contains(.left) {
        let width = max(minSize.width, start.width - delta.x)
        frame.origin.x = start.maxX - width
        frame.size.width = width
    }
    if edges.contains(.top) {
        frame.size.height = max(minSize.height, start.height + delta.y)
    }
    if edges.contains(.bottom) {
        let height = max(minSize.height, start.height - delta.y)
        frame.origin.y = start.maxY - height
        frame.size.height = height
    }
    return frame
}

/// PURE: the edges a point (view coordinates, y-up, origin bottom-left) is close enough to grab, in a
/// view `size` big — `edge` points from a side, `corner` points from a corner (corners are easier to
/// hit). Empty for the interior: those clicks belong to the content.
func pillWindowResizeEdges(at point: CGPoint, in size: CGSize, edge: CGFloat = 5, corner: CGFloat = 14) -> PillWindowResizeEdges {
    let nearLeft = point.x < corner, nearRight = point.x > size.width - corner
    let nearBottom = point.y < corner, nearTop = point.y > size.height - corner
    if nearLeft && nearBottom { return [.left, .bottom] }
    if nearLeft && nearTop { return [.left, .top] }
    if nearRight && nearBottom { return [.right, .bottom] }
    if nearRight && nearTop { return [.right, .top] }
    var edges: PillWindowResizeEdges = []
    if point.x < edge { edges.insert(.left) }
    if point.x > size.width - edge { edges.insert(.right) }
    if point.y < edge { edges.insert(.bottom) }
    if point.y > size.height - edge { edges.insert(.top) }
    return edges
}

/// The resize grips of a `PillChromeWindow`: an invisible view over the whole content that claims
/// ONLY the thin band along each edge and the corners (`hitTest` passes every other point through to
/// the content), shows the matching resize cursor there, and drags the window's frame.
final class PillWindowResizeHandles: NSView {
    private var dragEdges: PillWindowResizeEdges = []
    private var dragStartFrame: NSRect = .zero
    private var dragStartMouse: CGPoint = .zero

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard bounds.contains(local), !pillWindowResizeEdges(at: local, in: bounds.size).isEmpty else { return nil }
        return self
    }

    override func resetCursorRects() {
        let s = bounds.size
        let e: CGFloat = 5, c: CGFloat = 14
        addCursorRect(NSRect(x: 0, y: c, width: e, height: max(0, s.height - 2 * c)), cursor: .frameResize(position: .left, directions: .all))
        addCursorRect(NSRect(x: s.width - e, y: c, width: e, height: max(0, s.height - 2 * c)), cursor: .frameResize(position: .right, directions: .all))
        addCursorRect(NSRect(x: c, y: 0, width: max(0, s.width - 2 * c), height: e), cursor: .frameResize(position: .bottom, directions: .all))
        addCursorRect(NSRect(x: c, y: s.height - e, width: max(0, s.width - 2 * c), height: e), cursor: .frameResize(position: .top, directions: .all))
        addCursorRect(NSRect(x: 0, y: 0, width: c, height: c), cursor: .frameResize(position: .bottomLeft, directions: .all))
        addCursorRect(NSRect(x: s.width - c, y: 0, width: c, height: c), cursor: .frameResize(position: .bottomRight, directions: .all))
        addCursorRect(NSRect(x: 0, y: s.height - c, width: c, height: c), cursor: .frameResize(position: .topLeft, directions: .all))
        addCursorRect(NSRect(x: s.width - c, y: s.height - c, width: c, height: c), cursor: .frameResize(position: .topRight, directions: .all))
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        dragEdges = pillWindowResizeEdges(at: convert(event.locationInWindow, from: nil), in: bounds.size)
        dragStartFrame = window.frame
        dragStartMouse = NSEvent.mouseLocation
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, !dragEdges.isEmpty else { return }
        let now = NSEvent.mouseLocation
        let frame = pillWindowResizedFrame(start: dragStartFrame,
                                           delta: CGPoint(x: now.x - dragStartMouse.x, y: now.y - dragStartMouse.y),
                                           edges: dragEdges, minSize: window.minSize)
        window.setFrame(frame, display: true)
    }

    override func mouseUp(with event: NSEvent) {
        dragEdges = []
        window?.invalidateShadow()
    }
}
