import AppKit
import Combine
import Foundation

/// What Winter.app's in-window mirror shows for one bound target: the app's name, the window's size, the latest live
/// frame and the agent cursor. Fed from the helper's `view.*` notifications (`show` on `view.bound`, `apply(frame:)` on
/// `view.frame`, `applyCursor` on `view.cursor`, `clear` on `view.released`); drawn by `CUMirrorView`.
@MainActor public final class CUMirrorModel: ObservableObject {
    @Published public private(set) var appName: String?
    /// The window's size in points.
    @Published public private(set) var windowSize: CGSize = .zero
    /// How many OTHER targets the session has bound beside this one; the caption shows "+N" when it is not zero.
    @Published public private(set) var otherTargets = 0
    /// The latest decoded frame; nil until the first one (the view shows a calm placeholder).
    @Published private(set) var image: CGImage?
    /// The latest frame's size in pixels.
    @Published private(set) var imageSize: CGSize?
    /// The cursor's redraw need; the view runs its timeline at a matching rate.
    @Published private(set) var cursorNeed: CursorAnimationNeed = .none

    /// The cursor, in the WINDOW's space (window-relative points), exactly as on the overlay.
    private(set) var timeline = CursorTimeline()
    private let clock: CUClock
    /// The rig that draws the cursor, at the mirror's size; the view renders it into its canvas.
    let rig: CursorRig
    private var rigGeometry: (CGRect, CGSize)?
    private var needCheckPending = false
    /// What has been logged for the current target (first frame, first cursor), so each is logged once.
    private var loggedFrame = false
    private var loggedCursor = false

    /// Reduce Motion, from the view's environment.
    var reduceMotion = false {
        didSet { timeline.options.reduceMotion = reduceMotion }
    }
    var increaseContrast = false

    public convenience init() {
        self.init(clock: SystemClock())
    }

    init(clock: CUClock) {
        self.clock = clock
        rig = CursorRig(mapping: CursorRig.Mapping(sizeScale: CUCursorGallery.mirrorScale, showsCaption: false))
        rig.uprightTextInFlippedContext = true // the canvas draws in a top-left (flipped) context
    }

    public var isActive: Bool { appName != nil }

    /// A target was bound: show its mirror (a placeholder until the first frame).
    public func show(appName: String, windowSize: CGSize) {
        if self.appName != appName {
            PresentationLog.notice("in-app mirror shown for \(appName), window \(windowSize)")
            loggedFrame = false
            loggedCursor = false
        }
        self.appName = appName
        if windowSize.width > 0, windowSize.height > 0 { self.windowSize = windowSize }
    }

    /// The session has `count` other targets bound beside the one on show (the caption's "+N").
    public func setOtherTargets(_ count: Int) {
        let count = max(count, 0)
        if otherTargets != count { otherTargets = count }
    }

    /// A new frame (`view.frame`). An undecodable frame is skipped; the last good one stays.
    public func apply(frame jpeg: Data, width: Int, height: Int, windowSize: CGSize) {
        guard let decoded = JPEGCodec.decode(jpeg) else {
            PresentationLog.notice("in-app mirror: a frame could not be decoded (\(jpeg.count) bytes)")
            return
        }
        if !loggedFrame {
            loggedFrame = true
            PresentationLog.notice("in-app mirror for \(appName ?? "?"): first frame \(decoded.width)×\(decoded.height)")
        }
        image = decoded
        imageSize = CGSize(width: width > 0 ? width : decoded.width, height: height > 0 ? height : decoded.height)
        if windowSize.width > 0, windowSize.height > 0, windowSize != self.windowSize { self.windowSize = windowSize }
    }

    /// A cursor event (`view.cursor`), with the core's kind strings (`CUCursorKind(core:…)`). Every position is
    /// window-relative points. Unknown kinds are ignored.
    public func applyCursor(kind: String, point: CGPoint, dragTo: CGPoint?, frame: CGRect?, text: String?,
                            count: Int?, button: String?) {
        guard let cursorKind = CUCursorKind(core: kind, dragTo: dragTo, frame: frame, text: text, count: count,
                                            button: button) else {
            PresentationLog.notice("in-app mirror: cursor kind \"\(kind)\" ignored (unknown, or missing its payload)")
            return
        }
        if !loggedCursor {
            loggedCursor = true
            PresentationLog.notice("in-app mirror for \(appName ?? "?"): first cursor event \(kind) at \(point) "
                + "(window \(windowSize))")
        }
        timeline.receive(cursorKind, at: point, now: clock.now)
        updateNeed()
    }

    /// The target was released: nothing to show.
    public func clear() {
        if appName != nil { PresentationLog.notice("in-app mirror cleared (\(appName ?? "?"))") }
        appName = nil
        windowSize = .zero
        otherTargets = 0
        image = nil
        imageSize = nil
        timeline = CursorTimeline(options: .init(reduceMotion: reduceMotion))
        rigGeometry = nil
        cursorNeed = .none
    }

    // MARK: - Drawing support (used by the view)

    func cursorFrame() -> CursorFrame {
        let frame = timeline.frame(at: clock.now)
        scheduleNeedCheck()
        return frame
    }

    /// The rect the window's pixels occupy in a content area of `size`.
    func windowRect(in size: CGSize) -> CGRect {
        MirrorGeometry.windowRect(content: CGRect(origin: .zero, size: size), imageSize: imageSize, windowSize: windowSize)
    }

    /// Draws the cursor into `context` (top-left space, the canvas's own) over a content area of `size`.
    func renderCursor(into context: CGContext, size: CGSize, scale: CGFloat) {
        let frame = cursorFrame()
        guard frame.visible else { return }
        let windowRect = windowRect(in: size)
        if rigGeometry?.0 != windowRect || rigGeometry?.1 != windowSize {
            rigGeometry = (windowRect, windowSize)
            var mapping = rig.mapping
            let ws = windowSize
            mapping.point = { MirrorGeometry.map($0, windowRect: windowRect, windowSize: ws) }
            rig.mapping = mapping
        }
        rig.style = CursorStyle(increaseContrast: increaseContrast)
        rig.contentsScale = scale
        rig.root.frame = CGRect(origin: .zero, size: size)
        rig.apply(frame)
        rig.root.render(in: context)
    }

    /// Re-reads the cursor's redraw need after the current view update, so the view can slow down or stop its timeline.
    private func scheduleNeedCheck() {
        guard !needCheckPending else { return }
        needCheckPending = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.needCheckPending = false
                self?.updateNeed()
            }
        }
    }

    private func updateNeed() {
        let need = timeline.animationNeed(at: clock.now)
        if need != cursorNeed { cursorNeed = need }
    }
}
