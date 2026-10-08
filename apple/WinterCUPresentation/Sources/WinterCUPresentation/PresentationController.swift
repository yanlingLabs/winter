import CoreGraphics
import Foundation

/// The `CUPresentation` the helper uses. It keeps `PresentationState`, reads window geometry on a short timer while
/// anything is on screen, and tells the surfaces where to be. All AppKit work is behind `CUSurfaceFactory`.
@MainActor final class PresentationController: CUPresentation {
    private var state: PresentationState
    private let tuning: PresentationTuning
    private let windows: CUWindowSource
    private let surfaces: CUSurfaceFactory
    private let clock: CUClock
    private let ticker: CUTicker

    /// Mirror panels that exist (shown, or hidden but still wanted so they can come back quickly).
    private var mirrors: [TargetKey: MirrorSurface] = [:]
    private var shownMirrors: Set<TargetKey> = []
    /// The on-screen mirrors, newest first, as last ordered.
    private var mirrorOrder: [TargetKey] = []
    private var overlays: [TargetKey: CursorOverlaySurface] = [:]
    private var shownOverlays: Set<TargetKey> = []
    private var lastReorder: [TargetKey: TimeInterval] = [:]

    init(windows: CUWindowSource, surfaces: CUSurfaceFactory, clock: CUClock, ticker: CUTicker,
         tuning: PresentationTuning = .standard) {
        self.windows = windows
        self.surfaces = surfaces
        self.clock = clock
        self.ticker = ticker
        self.tuning = tuning
        self.state = PresentationState(tuning: tuning)
    }

    // MARK: - CUPresentation

    var mirrorsEnabled: Bool {
        get { state.mirrorsEnabled }
        set {
            guard newValue != state.mirrorsEnabled else { return }
            state.mirrorsEnabled = newValue
            refresh()
        }
    }

    func showMirror(sessionId: String, target: CUWindowRef) {
        state.showMirror(TargetKey(sessionId: sessionId, target: target), now: clock.now)
        refresh()
    }

    func hideMirror(sessionId: String, target: CUWindowRef) {
        state.hideMirror(TargetKey(sessionId: sessionId, target: target))
        refresh()
    }

    func cursor(sessionId: String, target: CUWindowRef, point: CGPoint, kind: CUCursorKind) {
        let key = TargetKey(sessionId: sessionId, target: target)
        let frame = windows.snapshot(of: target.windowID)?.frame
        let fraction = frame.map { MirrorLayout.fraction(of: point, in: $0) }
        state.noteCursor(key, fraction: fraction, now: clock.now)
        refresh()

        var dragTo: CGPoint?
        if case .drag(let to) = kind { dragTo = to }
        if let fraction, shownMirrors.contains(key), let mirror = mirrors[key] {
            let dragFraction = frame.flatMap { f in dragTo.map { MirrorLayout.fraction(of: $0, in: f) } }
            mirror.showCursor(atFraction: fraction, kind: kind, dragToFraction: dragFraction)
        }
        if let frame, shownOverlays.contains(key), let overlay = overlays[key] {
            let local = CGPoint(x: point.x - frame.minX, y: point.y - frame.minY)
            let localDrag = dragTo.map { CGPoint(x: $0.x - frame.minX, y: $0.y - frame.minY) }
            overlay.moveCursor(to: local, kind: kind, dragTo: localDrag)
        }
    }

    func turnEnded(sessionId: String) {
        state.turnEnded(sessionId: sessionId)
        refresh()
    }

    func sessionEnded(sessionId: String) {
        for key in state.sessionEnded(sessionId: sessionId) { discard(key) }
        // Surfaces of the session that had no entry left (already pruned) go too.
        for key in Array(mirrors.keys) + Array(overlays.keys) where key.sessionId == sessionId { discard(key) }
        refresh()
    }

    // MARK: - Drawing

    /// Brings every surface in line with the state and the windows' current geometry. Called on every API call and on
    /// each tick while anything is on screen or a timer is pending.
    func refresh() {
        let now = clock.now
        state.tick(now: now)
        let screens = windows.screens()
        var snapshots: [CGWindowID: WindowSnapshot?] = [:]
        func presence(of key: TargetKey) -> WindowPresence {
            let id = key.target.windowID
            if snapshots[id] == nil { snapshots[id] = .some(windows.snapshot(of: id)) }
            return WindowVisibility.classify(snapshots[id] ?? nil, screens: screens, minVisibleArea: tuning.minVisibleArea)
        }

        // Mirrors no longer wanted at all are closed; wanted-but-faded ones are only hidden.
        for (key, mirror) in mirrors where state.entries[key]?.wantsMirror != true {
            mirror.close()
            mirrors[key] = nil
            shownMirrors.remove(key)
        }
        let wanted = state.visibleMirrors()
        for key in shownMirrors where !wanted.contains(key) {
            mirrors[key]?.setShown(false)
            shownMirrors.remove(key)
        }

        let requests = wanted.map { key -> MirrorLayout.Request in
            let p = presence(of: key)
            let content = MirrorLayout.contentSize(forWindow: p.frame?.size, tuning: tuning)
            return MirrorLayout.Request(presence: p, panelSize: MirrorLayout.panelSize(content: content, tuning: tuning))
        }
        let frames = MirrorLayout.frames(for: requests, screens: screens, tuning: tuning)
        for (index, key) in wanted.enumerated() {
            let mirror = mirrors[key] ?? surfaces.makeMirror(target: key.target)
            mirrors[key] = mirror
            let windowFrame = requests[index].presence.frame
            let content = MirrorLayout.contentSize(forWindow: windowFrame?.size, tuning: tuning)
            let aspect = windowFrame.flatMap { $0.height > 0 ? $0.width / $0.height : nil }
            mirror.place(frame: frames[index], contentSize: content, windowAspect: aspect, stackIndex: index)
            if !shownMirrors.contains(key) {
                mirror.setShown(true)
                shownMirrors.insert(key)
            }
        }
        if wanted != mirrorOrder {
            // Oldest first, so the newest ends on top.
            for key in wanted.reversed() { mirrors[key]?.bringToFront() }
            mirrorOrder = wanted
        }

        // Overlay cursors: only over a window that is showing.
        let active = Set(state.activeCursors(now: now))
        for key in active {
            guard case .visible(let frame) = presence(of: key) else {
                if shownOverlays.remove(key) != nil { overlays[key]?.setShown(false) }
                continue
            }
            let overlay = overlays[key] ?? surfaces.makeOverlay(target: key.target)
            overlays[key] = overlay
            let reorder = now - (lastReorder[key] ?? -.infinity) >= tuning.overlayReorderInterval
            if reorder { lastReorder[key] = now }
            overlay.place(windowFrame: frame, aboveWindow: key.target.windowID, reorder: reorder || !shownOverlays.contains(key))
            if shownOverlays.insert(key).inserted { overlay.setShown(true) }
        }
        for key in shownOverlays where !active.contains(key) {
            overlays[key]?.setShown(false)
            shownOverlays.remove(key)
        }
        for (key, overlay) in overlays where state.entries[key] == nil {
            overlay.close()
            overlays[key] = nil
            lastReorder[key] = nil
        }

        let busy = !shownMirrors.isEmpty || !shownOverlays.isEmpty || state.hasPendingTimers
        if busy, !ticker.isRunning {
            ticker.start(interval: tuning.trackingInterval) { [weak self] in self?.refresh() }
        } else if !busy, ticker.isRunning {
            ticker.stop()
        }
    }

    private func discard(_ key: TargetKey) {
        mirrors.removeValue(forKey: key)?.close()
        shownMirrors.remove(key)
        overlays.removeValue(forKey: key)?.close()
        shownOverlays.remove(key)
        lastReorder[key] = nil
        mirrorOrder.removeAll { $0 == key }
    }

    // MARK: - Test hooks

    var debugShownMirrors: [TargetKey] { mirrorOrder.filter { shownMirrors.contains($0) } }
    var debugShownOverlays: Set<TargetKey> { shownOverlays }
}
