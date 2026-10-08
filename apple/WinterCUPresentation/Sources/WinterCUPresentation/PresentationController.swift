import CoreGraphics
import Foundation

/// The `CUPresentation` the helper uses. It keeps `PresentationState`, reads window geometry on a short timer while
/// anything is on screen, and tells the surfaces where to be. Each target's agent cursor is a `CursorTimeline` in the
/// window's local space; a display-rate driver samples it and hands the frame to the overlay and the mirror alike.
/// All AppKit work is behind `CUSurfaceFactory`.
@MainActor final class PresentationController: CUPresentation {
    private var state: PresentationState
    private let tuning: PresentationTuning
    private let windows: CUWindowSource
    private let surfaces: CUSurfaceFactory
    private let clock: CUClock
    private let ticker: CUTicker
    private let frames: CUFrameDriver
    private let accessibility: CUAccessibilitySource

    /// Each target's cursor, in its window's local space.
    private var cursors: [TargetKey: CursorTimeline] = [:]
    /// The last known frame of each target's window, for mapping points and sizing the mirror's cursor.
    private var windowFrames: [TargetKey: CGRect] = [:]
    private var driverNeed: CursorAnimationNeed = .none
    /// Whether each overlay's cursor is currently covered by another window.
    private var occluded: [TargetKey: Bool] = [:]
    private var lastOcclusionCheck: TimeInterval = -.infinity
    private let ownPID: pid_t
    /// Targets whose cursor events were announced (first event) or dropped (no geometry), so each is logged once.
    private var announced: Set<TargetKey> = []
    private var dropped: Set<TargetKey> = []
    /// Why each overlay is hidden, as last logged.
    private var hiddenReason: [TargetKey: String] = [:]

    /// Mirror panels that exist (shown, or hidden but still wanted so they can come back quickly).
    private var mirrors: [TargetKey: MirrorSurface] = [:]
    private var shownMirrors: Set<TargetKey> = []
    /// The on-screen mirrors, newest first, as last ordered.
    private var mirrorOrder: [TargetKey] = []
    private var overlays: [TargetKey: CursorOverlaySurface] = [:]
    private var shownOverlays: Set<TargetKey> = []
    private var lastReorder: [TargetKey: TimeInterval] = [:]

    init(windows: CUWindowSource, surfaces: CUSurfaceFactory, clock: CUClock, ticker: CUTicker,
         frames: CUFrameDriver, accessibility: CUAccessibilitySource, ownPID: pid_t = getpid(),
         tuning: PresentationTuning = .standard) {
        self.ownPID = ownPID
        self.windows = windows
        self.surfaces = surfaces
        self.clock = clock
        self.ticker = ticker
        self.frames = frames
        self.accessibility = accessibility
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
        let now = clock.now
        guard let frame = windows.snapshot(of: target.windowID)?.frame ?? windowFrames[key] else {
            // Nowhere to put it yet; the event still counts as activity on the target.
            if dropped.insert(key).inserted {
                PresentationLog.notice("cursor for \(target.appName) window \(target.windowID) (pid \(target.pid)) not drawn: "
                    + "the window server has no geometry for that window")
            }
            if kind != .done { state.noteCursor(key, fraction: nil, now: now) }
            refresh()
            return
        }
        dropped.remove(key)
        if announced.insert(key).inserted {
            PresentationLog.notice("cursor for \(target.appName) window \(target.windowID) (pid \(target.pid)): first event "
                // The case name only: a caption's text can carry an element's label.
                + "\(String(describing: kind).prefix { $0 != "(" }) at \(point), window frame \(frame)")
        }
        windowFrames[key] = frame
        let local = { (p: CGPoint) in CGPoint(x: p.x - frame.minX, y: p.y - frame.minY) }
        var timeline = cursors[key] ?? CursorTimeline()
        timeline.options.reduceMotion = accessibility.reduceMotion
        timeline.receive(kind.mapped(local), at: local(point), now: now)
        cursors[key] = timeline
        if kind != .done { state.noteCursor(key, fraction: MirrorLayout.fraction(of: point, in: frame), now: now) }
        lastOcclusionCheck = -.infinity // the cursor moved: look again now
        refresh()
    }

    func turnEnded(sessionId: String) {
        state.turnEnded(sessionId: sessionId)
        refresh()
    }

    func sessionEnded(sessionId: String) {
        for key in state.sessionEnded(sessionId: sessionId) { discard(key) }
        // Surfaces of the session that had no entry left (already pruned) go too.
        for key in Array(mirrors.keys) + Array(overlays.keys) + Array(cursors.keys) where key.sessionId == sessionId {
            discard(key)
        }
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

        // Cursors whose time is up (turn end, 30 s idle) play their fade; faded ones are dropped.
        let active = Set(state.activeCursors(now: now))
        for (key, timeline) in cursors {
            if !active.contains(key), !timeline.isFadingOrHidden {
                var t = timeline
                t.receive(.done, at: t.restPosition ?? .zero, now: now)
                cursors[key] = t
            } else if !active.contains(key), timeline.isHidden(at: now) {
                cursors[key] = nil
            }
        }

        // Overlay cursors: only over a window that is showing, while the cursor is not hidden.
        let live = Set(cursors.filter { !$0.value.isHidden(at: now) }.keys)
        for key in live {
            let p = presence(of: key)
            if let f = p.frame { windowFrames[key] = f }
            guard case .visible(let frame) = p else {
                let reason: String
                if case .hidden(let last) = p, last != nil {
                    reason = (windows.snapshot(of: key.target.windowID)?.isOnScreen ?? false)
                        ? "the window is off every screen" : "the window is minimized or on another Space"
                } else {
                    reason = "the window server has no geometry for the window"
                }
                logHidden(key, reason)
                if shownOverlays.remove(key) != nil {
                    overlays[key]?.setShown(false)
                    occluded[key] = nil
                }
                continue
            }
            if let was = hiddenReason.removeValue(forKey: key) {
                PresentationLog.notice("cursor overlay for \(key.target.appName) window \(key.target.windowID) showing again "
                    + "at \(frame) (was hidden: \(was))")
            }
            let overlay = overlays[key] ?? surfaces.makeOverlay(target: key.target)
            overlays[key] = overlay
            let reorder = now - (lastReorder[key] ?? -.infinity) >= tuning.overlayReorderInterval
            if reorder { lastReorder[key] = now }
            overlay.place(windowFrame: frame, aboveWindow: key.target.windowID, reorder: reorder || !shownOverlays.contains(key))
            if shownOverlays.insert(key).inserted { overlay.setShown(true) }
        }
        for key in shownOverlays where !live.contains(key) {
            logHidden(key, "the cursor faded out (turn ended, idle or done)")
            overlays[key]?.setShown(false)
            shownOverlays.remove(key)
            occluded[key] = nil
        }
        for (key, overlay) in overlays where state.entries[key] == nil && cursors[key] == nil {
            overlay.close()
            overlays[key] = nil
            lastReorder[key] = nil
            occluded[key] = nil
        }
        updateOcclusion(now: now)
        pushCursorFrames(now: now)

        let busy = !shownMirrors.isEmpty || !shownOverlays.isEmpty || state.hasPendingTimers
        if busy, !ticker.isRunning {
            ticker.start(interval: tuning.trackingInterval) { [weak self] in self?.refresh() }
        } else if !busy, ticker.isRunning {
            ticker.stop()
        }
    }

    /// The overlay floats above every app, so a covered target would show its cursor on top of the covering window.
    /// Look at the windows above the target (a cached list, refreshed off the main thread at most every 150 ms; read
    /// here at most every `occlusionInterval`, and at once after an action) and fade the cursor out where one of them
    /// covers the cursor's point.
    private func updateOcclusion(now: TimeInterval) {
        guard !shownOverlays.isEmpty else { return }
        let firstLook = shownOverlays.contains { occluded[$0] == nil }
        guard firstLook || now - lastOcclusionCheck >= tuning.occlusionInterval else { return }
        lastOcclusionCheck = now
        for key in shownOverlays {
            guard let timeline = cursors[key], let frame = windowFrames[key],
                  let above = windows.windowsAbove(key.target.windowID) else { continue }
            let tip = timeline.frame(at: now).tip
            let point = CGPoint(x: frame.minX + tip.x, y: frame.minY + tip.y)
            let cover = CursorOcclusion.coveringWindow(at: point, above: above, ownPID: ownPID, targetPID: key.target.pid,
                                                       targetFrame: frame)
            let covered = cover != nil
            if occluded[key] != covered {
                occluded[key] = covered
                overlays[key]?.setOccluded(covered)
                if let cover {
                    PresentationLog.notice("cursor for \(key.target.appName) window \(key.target.windowID) hidden at \(point): "
                        + "covered by \(cover.ownerName ?? "?") window \(cover.id) (pid \(cover.pid), layer \(cover.layer), "
                        + "\(cover.bounds))")
                } else {
                    PresentationLog.notice("cursor for \(key.target.appName) window \(key.target.windowID) visible at \(point) "
                        + "(\(above.count) windows above, none covering)")
                }
            }
        }
    }

    /// Logs why a target's overlay is hidden, once per reason.
    private func logHidden(_ key: TargetKey, _ reason: String) {
        guard hiddenReason[key] != reason else { return }
        hiddenReason[key] = reason
        PresentationLog.notice("cursor overlay for \(key.target.appName) window \(key.target.windowID) hidden: \(reason)")
    }

    /// Hands every cursor's current frame to its overlay and mirror, and runs the frame driver at the rate the
    /// cursors need (or stops it).
    private func pushCursorFrames(now: TimeInterval) {
        let style = CursorStyle(increaseContrast: accessibility.increaseContrast)
        var need = CursorAnimationNeed.none
        for (key, timeline) in cursors {
            let frame = timeline.frame(at: now)
            if shownOverlays.contains(key) { overlays[key]?.apply(cursor: frame, style: style) }
            if shownMirrors.contains(key), let size = windowFrames[key]?.size {
                mirrors[key]?.apply(cursor: frame, style: style, windowSize: size)
            }
            need = max(need, timeline.animationNeed(at: now))
        }
        if need == .none {
            if frames.isRunning { frames.stop() }
        } else if !frames.isRunning || need != driverNeed {
            frames.start(need) { [weak self] in self?.animationTick() }
        }
        driverNeed = need
    }

    /// One display frame: draw, and tidy up once a cursor has faded out.
    private func animationTick() {
        let now = clock.now
        if cursors.contains(where: { $0.value.isHidden(at: now) && shownOverlays.contains($0.key) }) {
            refresh()
        } else {
            pushCursorFrames(now: now)
        }
    }

    private func discard(_ key: TargetKey) {
        mirrors.removeValue(forKey: key)?.close()
        shownMirrors.remove(key)
        overlays.removeValue(forKey: key)?.close()
        shownOverlays.remove(key)
        lastReorder[key] = nil
        mirrorOrder.removeAll { $0 == key }
        cursors[key] = nil
        windowFrames[key] = nil
        occluded[key] = nil
        announced.remove(key)
        dropped.remove(key)
        hiddenReason[key] = nil
    }

    // MARK: - Test hooks

    var debugShownMirrors: [TargetKey] { mirrorOrder.filter { shownMirrors.contains($0) } }
    var debugShownOverlays: Set<TargetKey> { shownOverlays }
    func debugCursorFrame(_ key: TargetKey) -> CursorFrame? { cursors[key]?.frame(at: clock.now) }
}

extension CUCursorKind {
    /// The same kind with its positional payloads moved by `f` (screen → window-local).
    func mapped(_ f: (CGPoint) -> CGPoint) -> CUCursorKind {
        switch self {
        case .drag(let to): return .drag(to: f(to))
        case .target(let rect): return .target(frame: CGRect(origin: f(rect.origin), size: rect.size))
        default: return self
        }
    }
}
