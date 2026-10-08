import AppKit
import QuartzCore

/// A borderless panel that never takes key or main status and never activates the helper.
final class PassivePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init(contentRect: CGRect, clickThrough: Bool) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isMovable = false
        ignoresMouseEvents = clickThrough
        animationBehavior = .none
        // Keep the helper's own drawings out of other apps' captures, so they never land in a model's screenshot.
        sharingType = .none
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
    }
}

/// A view whose content lives in one geometry-flipped layer, so everything inside uses top-left coordinates like the
/// rest of the package.
final class FlippedLayerView: NSView {
    let canvas = CALayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        wantsLayer = true
        canvas.isGeometryFlipped = true
        canvas.frame = bounds
        canvas.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        layer?.addSublayer(canvas)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }
}

/// The click-through overlay that carries the agent cursor above one target window.
@MainActor final class AppKitCursorOverlay: CursorOverlaySurface {
    private let panel: PassivePanel
    private let view: FlippedLayerView
    private let cursor: AgentCursorLayer
    private var shown = false

    init(target: CUWindowRef) {
        panel = PassivePanel(contentRect: CGRect(x: 0, y: 0, width: 10, height: 10), clickThrough: true)
        panel.hasShadow = false
        // Normal level, ordered just above the target: windows covering the target also cover its cursor.
        panel.level = .normal
        view = FlippedLayerView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
        panel.contentView = view
        cursor = AgentCursorLayer(parent: view.canvas, scale: 1.1)
    }

    func place(windowFrame: CGRect, aboveWindow windowID: CGWindowID, reorder: Bool) {
        let frame = AppKitScreens.appKitFrame(windowFrame)
        if panel.frame != frame { panel.setFrame(frame, display: false) }
        if shown, reorder { panel.order(.above, relativeTo: Int(windowID)) }
        pendingWindow = windowID
    }

    private var pendingWindow: CGWindowID = 0

    func setShown(_ shown: Bool) {
        guard shown != self.shown else { return }
        self.shown = shown
        if shown {
            panel.order(.above, relativeTo: Int(pendingWindow))
        } else {
            cursor.reset()
            panel.orderOut(nil)
        }
    }

    func moveCursor(to point: CGPoint, kind: CUCursorKind, dragTo: CGPoint?) {
        cursor.show(at: point, kind: kind, dragTo: dragTo)
    }

    func close() {
        cursor.reset()
        panel.orderOut(nil)
        panel.close()
    }
}

/// The live mirror: a small black panel with a faint white rim, the window's live image, the agent cursor drawn over
/// it, and the app's name underneath.
@MainActor final class AppKitMirror: MirrorSurface {
    private let target: CUWindowRef
    private let tuning: PresentationTuning
    private let panel: PassivePanel
    private let view: FlippedLayerView
    private let image = CALayer()
    private let caption = CATextLayer()
    private let cursor: AgentCursorLayer
    private let cursorPlane = CALayer()
    private var stream: MirrorStream?
    private var shown = false
    private var contentSize: CGSize = .zero
    private var pixelSize: CGSize = .zero
    private var streamState: String?
    private var windowAspect: CGFloat?

    init(target: CUWindowRef, tuning: PresentationTuning) {
        self.target = target
        self.tuning = tuning
        panel = PassivePanel(contentRect: CGRect(x: 0, y: 0, width: 10, height: 10), clickThrough: false)
        // Above ordinary windows, so the mirror shows the window's live content even while the window is covered.
        panel.level = .floating
        panel.hasShadow = true
        panel.alphaValue = 0
        view = FlippedLayerView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
        panel.contentView = view

        let canvas = view.canvas
        canvas.backgroundColor = NSColor(white: 0, alpha: 0.92).cgColor
        canvas.cornerRadius = 12
        canvas.cornerCurve = .continuous
        canvas.borderWidth = 1
        canvas.borderColor = NSColor(white: 1, alpha: 0.14).cgColor
        canvas.masksToBounds = true

        image.backgroundColor = NSColor(white: 0.08, alpha: 1).cgColor
        image.cornerRadius = 9
        image.cornerCurve = .continuous
        image.masksToBounds = true
        image.contentsGravity = .resizeAspect
        canvas.addSublayer(image)

        // The cursor plane matches the image's letterboxed content rect, so fractions map straight onto it.
        cursorPlane.masksToBounds = true
        canvas.addSublayer(cursorPlane)
        cursor = AgentCursorLayer(parent: cursorPlane, scale: 0.7)

        caption.fontSize = 11
        caption.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        caption.foregroundColor = NSColor(white: 1, alpha: 0.62).cgColor
        caption.alignmentMode = .center
        caption.truncationMode = .end
        caption.contentsScale = 2
        canvas.addSublayer(caption)
        updateCaption()
    }

    func place(frame: CGRect, contentSize: CGSize, windowAspect: CGFloat?, stackIndex: Int) {
        if let windowAspect { self.windowAspect = windowAspect }
        let appKit = AppKitScreens.appKitFrame(frame)
        if panel.frame != appKit { panel.setFrame(appKit, display: false) }
        let scale = AppKitScreens.backingScale(for: frame)
        caption.contentsScale = scale
        // The stream follows both the size and the backing scale (a window dragged to a 1× display).
        let pixels = CGSize(width: (contentSize.width * scale).rounded(), height: (contentSize.height * scale).rounded())
        if pixels != pixelSize {
            pixelSize = pixels
            stream?.resize(pixelSize: pixels)
        }
        guard contentSize != self.contentSize else { return }
        self.contentSize = contentSize
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let pad = tuning.mirrorPadding
        let imageRect = CGRect(x: pad, y: pad, width: contentSize.width, height: contentSize.height)
        image.frame = imageRect
        cursorPlane.frame = imageRect
        caption.frame = CGRect(x: pad + 6, y: imageRect.maxY + 4, width: contentSize.width - 12,
                               height: tuning.mirrorCaptionHeight - 6)
        CATransaction.commit()
    }

    func setShown(_ shown: Bool) {
        guard shown != self.shown else { return }
        self.shown = shown
        if shown {
            panel.orderFrontRegardless()
            startStream()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.25
                panel.animator().alphaValue = 1
            }
        } else {
            stopStream()
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.4
                panel.animator().alphaValue = 0
            }, completionHandler: { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, !self.shown else { return }
                    self.cursor.reset()
                    self.panel.orderOut(nil)
                }
            })
        }
    }

    func bringToFront() {
        if shown { panel.orderFrontRegardless() }
    }

    func showCursor(atFraction fraction: CGPoint, kind: CUCursorKind, dragToFraction: CGPoint?) {
        let rect = MirrorLayout.aspectFit(aspect: imageAspect, in: CGRect(origin: .zero, size: cursorPlane.bounds.size))
        let point = MirrorLayout.point(atFraction: fraction, in: rect)
        let drag = dragToFraction.map { MirrorLayout.point(atFraction: $0, in: rect) }
        cursor.show(at: point, kind: kind, dragTo: drag)
    }

    func close() {
        shown = false
        stopStream()
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.3
            panel.animator().alphaValue = 0
        }, completionHandler: { [panel] in
            MainActor.assumeIsolated {
                panel.orderOut(nil)
                panel.close()
            }
        })
    }

    // MARK: - Stream

    /// The window's aspect, which is where its pixels sit inside the (possibly letterboxed) image.
    private var imageAspect: CGFloat {
        if let windowAspect, windowAspect > 0 { return windowAspect }
        return contentSize.height > 0 ? contentSize.width / contentSize.height : 1.6
    }

    private func startStream() {
        guard stream == nil else { return }
        let stream = MirrorStream(windowID: target.windowID, framesPerSecond: tuning.framesPerSecond)
        stream.onFrame = { [weak self] surface in
            guard let self else { return }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            self.image.contents = surface
            CATransaction.commit()
            self.setStreamState(nil)
        }
        stream.onFailure = { [weak self] reason in
            self?.setStreamState(reason)
        }
        self.stream = stream
        stream.start(pixelSize: pixelSize == .zero ? CGSize(width: 720, height: 450) : pixelSize)
    }

    private func stopStream() {
        stream?.stop()
        stream = nil
    }

    private func setStreamState(_ state: String?) {
        guard state != streamState else { return }
        streamState = state
        updateCaption()
    }

    private func updateCaption() {
        if let streamState {
            caption.string = "\(target.appName) — \(streamState)"
        } else {
            caption.string = target.appName
        }
    }
}

@MainActor struct AppKitSurfaceFactory: CUSurfaceFactory {
    var tuning: PresentationTuning = .standard

    func makeMirror(target: CUWindowRef) -> MirrorSurface {
        AppKitMirror(target: target, tuning: tuning)
    }

    func makeOverlay(target: CUWindowRef) -> CursorOverlaySurface {
        AppKitCursorOverlay(target: target)
    }
}
