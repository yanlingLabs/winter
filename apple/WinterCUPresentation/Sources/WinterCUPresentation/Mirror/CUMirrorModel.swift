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

    /// How long a resting cursor keeps breathing before the mirror's timeline stops redrawing it: the picture
    /// stays, the redraws (a 20 fps canvas, in a Debug build a measurable share of the main thread) do not.
    static let restingCursorStillAfter: TimeInterval = 5
    /// The time of the last cursor event the mirror took; nil before the first.
    private var lastCursorAt: TimeInterval?

    /// Decodes frames: off the main thread, newest first (an older frame still waiting is skipped, never decoded).
    private let decode: @Sendable (Data) -> CGImage?
    private let decodeInline: Bool
    private let decodeSlot = DecodeSlot()
    private static let decodeQueue = DispatchQueue(label: "com.winter.mirror.decode", qos: .userInitiated)
    /// Bumped whenever what is on show changes, so a frame decoded for the previous picture is dropped.
    private var epoch = 0

    public convenience init() {
        self.init(clock: SystemClock(), decodeInline: false)
    }

    /// - Parameters:
    ///   - decode: JPEG bytes → image; the real codec unless a test counts calls.
    ///   - decodeInline: decode on the caller (tests that assert on `image` right after `apply`).
    init(clock: CUClock, decode: @escaping @Sendable (Data) -> CGImage? = { JPEGCodec.decode($0) }, decodeInline: Bool = true) {
        self.clock = clock
        self.decode = decode
        self.decodeInline = decodeInline
        rig = CursorRig(mapping: CursorRig.Mapping(sizeScale: CUCursorGallery.mirrorScale, showsCaption: false))
        rig.uprightTextInFlippedContext = true // the canvas draws in a top-left (flipped) context
    }

    public var isActive: Bool { appName != nil }

    /// A target was bound: show its mirror (a placeholder until the first frame). The same app and size again
    /// changes nothing — and publishes nothing.
    public func show(appName: String, windowSize: CGSize) {
        if self.appName != appName {
            PresentationLog.notice("in-app mirror shown for \(appName), window \(windowSize)")
            loggedFrame = false
            loggedCursor = false
            epoch += 1
            self.appName = appName
        }
        if windowSize.width > 0, windowSize.height > 0, self.windowSize != windowSize { self.windowSize = windowSize }
    }

    /// Another target takes over on the same panel: the previous picture and cursor are not its. The panel stays up
    /// (never `clear()`): the new target's own newest frame follows at once if there is one, a grey placeholder if not.
    public func resetPicture() {
        epoch += 1
        loggedFrame = false
        loggedCursor = false
        if image != nil { image = nil }
        if imageSize != nil { imageSize = nil }
        timeline = CursorTimeline(options: .init(reduceMotion: reduceMotion))
        rigGeometry = nil
        lastCursorAt = nil
        if cursorNeed != .none { cursorNeed = .none }
    }

    /// The session has `count` other targets bound beside the one on show (the caption's "+N").
    public func setOtherTargets(_ count: Int) {
        let count = max(count, 0)
        if otherTargets != count { otherTargets = count }
    }

    /// A new frame (`view.frame`). It is decoded off the main thread and only the finished image is set here; an
    /// undecodable frame is skipped (the last good one stays), and a frame still waiting when a newer one arrives is
    /// never decoded.
    public func apply(frame jpeg: Data, width: Int, height: Int, windowSize: CGSize) {
        let job = DecodeSlot.Job(epoch: epoch, jpeg: jpeg, width: width, height: height, windowSize: windowSize)
        if decodeInline {
            finish(job, decoded: decode(jpeg))
            return
        }
        guard decodeSlot.submit(job) else { return } // a drain is running and will take it
        let slot = decodeSlot, decode = self.decode
        Self.decodeQueue.async { [weak self] in
            while let next = slot.take() {
                let decoded = decode(next.jpeg)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.finish(next, decoded: decoded) }
                }
            }
        }
    }

    private func finish(_ job: DecodeSlot.Job, decoded: CGImage?) {
        guard job.epoch == epoch else { return } // the picture it was for is gone
        guard let decoded else {
            PresentationLog.notice("in-app mirror: a frame could not be decoded (\(job.jpeg.count) bytes)")
            return
        }
        if !loggedFrame {
            loggedFrame = true
            PresentationLog.notice("in-app mirror for \(appName ?? "?"): first frame \(decoded.width)×\(decoded.height)")
        }
        image = decoded
        let size = CGSize(width: job.width > 0 ? job.width : decoded.width, height: job.height > 0 ? job.height : decoded.height)
        if imageSize != size { imageSize = size }
        let windowSize = job.windowSize
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
        lastCursorAt = clock.now
        timeline.receive(cursorKind, at: point, now: clock.now)
        updateNeed()
    }

    /// The target was released: nothing to show.
    public func clear() {
        if appName != nil { PresentationLog.notice("in-app mirror cleared (\(appName ?? "?"))") }
        epoch += 1
        lastCursorAt = nil
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
        var need = timeline.animationNeed(at: clock.now)
        // A cursor that merely rests (breathing) stops being redrawn a few seconds after its last event; the next
        // event starts it again.
        if need == .low, let last = lastCursorAt, clock.now - last > Self.restingCursorStillAfter { need = .none }
        if need != cursorNeed { cursorNeed = need }
    }
}

/// The newest frame waiting for the decoder: a newer one replaces an unstarted older one.
private final class DecodeSlot: @unchecked Sendable {
    struct Job: Sendable {
        var epoch: Int
        var jpeg: Data
        var width: Int
        var height: Int
        var windowSize: CGSize
    }

    private let lock = NSLock()
    private var pending: Job?
    private var draining = false

    /// Stores the job; returns whether the caller must start a drain (none is running).
    func submit(_ job: Job) -> Bool {
        lock.lock(); defer { lock.unlock() }
        pending = job
        if draining { return false }
        draining = true
        return true
    }

    /// The newest waiting job, or nil — and then no drain is running any more.
    func take() -> Job? {
        lock.lock(); defer { lock.unlock() }
        if let job = pending { pending = nil; return job }
        draining = false
        return nil
    }
}
