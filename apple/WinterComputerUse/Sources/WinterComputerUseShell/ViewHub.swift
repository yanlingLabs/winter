import CoreGraphics
import Foundation
import WinterCUCore
import WinterCUPresentation

// The in-window mirror's stream (the ComputerV2 contract's "mirror moves INTO Winter.app" section): the helper
// keeps the Screen Recording grant and captures the bound window; Winter.app, connected as the second client,
// subscribes per session and draws what arrives — `view.bound` / `view.released` / `view.cursor` for every
// subscriber of the session, `view.frame` for those that asked for frames. Frames go only to authenticated
// Winter.app connections (the server refuses `view.*` to anyone else) and are never logged.

/// One encoded window frame, as the hub hands it on.
public struct ViewFrame: Sendable, Equatable {
    public var jpeg: Data
    public var width: Int
    public var height: Int
    public var windowSize: CGSize

    public init(jpeg: Data, width: Int, height: Int, windowSize: CGSize) {
        self.jpeg = jpeg
        self.width = width
        self.height = height
        self.windowSize = windowSize
    }
}

/// A running window capture.
@MainActor public protocol FrameCapture: AnyObject {
    /// A new rate or width applied to the running capture in place — never a restart (a restart gaps the frames and
    /// its first one can be blank).
    func update(maxFps: Int, maxWidth: Int)
    func stop()
}

/// Starts window captures. Injected so the start/stop rules are tested without ScreenCaptureKit.
@MainActor public protocol FrameCaptureFactory: AnyObject {
    func start(windowID: CGWindowID, maxFps: Int, maxWidth: Int,
               onFrame: @escaping @MainActor (ViewFrame) -> Void, onError: @escaping @MainActor (Error) -> Void) -> FrameCapture
}

/// The live captures: the presentation package's `CUWindowFrameSource`.
@MainActor public final class LiveFrameCaptureFactory: FrameCaptureFactory {
    private final class Running: FrameCapture {
        let source: CUWindowFrameSource
        init(_ source: CUWindowFrameSource) { self.source = source }
        func update(maxFps: Int, maxWidth: Int) { source.update(maxFps: maxFps, maxWidth: maxWidth) }
        func stop() { source.stop() }
    }

    public init() {}

    public func start(windowID: CGWindowID, maxFps: Int, maxWidth: Int,
                      onFrame: @escaping @MainActor (ViewFrame) -> Void, onError: @escaping @MainActor (Error) -> Void) -> FrameCapture {
        let source = CUWindowFrameSource(windowID: windowID, maxFps: maxFps, maxWidth: maxWidth, onFrame: { frame in
            onFrame(ViewFrame(jpeg: frame.jpeg, width: frame.width, height: frame.height, windowSize: frame.windowSize))
        }, onError: onError)
        source.start()
        return Running(source)
    }
}

/// Where a window is now, in screen points, top-left origin, and whether it is on screen.
public protocol WindowGeometry: AnyObject {
    func frame(of windowID: CGWindowID) -> CGRect?
    /// False for a window on another Space, minimized or hidden; nil when the window server does not know it.
    func isOnScreen(_ windowID: CGWindowID) -> Bool?
}

/// The window server's answer (`kCGWindowBounds` is already top-left screen points).
public final class LiveWindowGeometry: WindowGeometry {
    public init() {}

    // The engine's lookup: a full-screen window on another Space is missing from the one-window query, and
    // would read as gone (never snapshotted) without its fallback to the full listing.
    public func frame(of windowID: CGWindowID) -> CGRect? { CUWindowLookup.frame(of: windowID) }

    public func isOnScreen(_ windowID: CGWindowID) -> Bool? { CUWindowLookup.isOnScreen(windowID) }
}

/// The hub's clock: what time it is, and a way to be called back. Injected so the idle throttle is tested
/// without waiting.
@MainActor public protocol ViewClock: AnyObject {
    var now: TimeInterval { get }
    func schedule(after seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> IdleCancellable
}

/// The real clock: system uptime and the main queue.
@MainActor public final class LiveViewClock: ViewClock {
    private let scheduler = MainQueueIdleScheduler()
    public init() {}
    public var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
    public func schedule(after seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> IdleCancellable {
        scheduler.schedule(after: seconds, fire)
    }
}

/// A bound target as Winter.app sees it.
public struct ViewTarget: Equatable, Sendable {
    public var sessionId: String
    public var targetId: String
    public var pid: Int32
    public var windowId: UInt32
    public var appName: String
    public var bundleId: String
    /// The window's frame when bound (screen points): its size is `windowSize`; its origin is the fallback for
    /// window-relative points when the window server cannot say where the window is now.
    public var windowFrame: CGRect
    /// The bind's `mirror` flag (the daemon passes `computerUse.mirror`): false → never any frames.
    public var mirror: Bool
    /// The bind's `privatePath` (`computerUse.privateEventPath`, absent → on): off-screen stills may come from the
    /// window server's own image of the window.
    public var privatePath: Bool

    public init(sessionId: String, targetId: String, pid: Int32, windowId: UInt32, appName: String, bundleId: String,
                windowFrame: CGRect, mirror: Bool, privatePath: Bool = true) {
        self.sessionId = sessionId
        self.targetId = targetId
        self.pid = pid
        self.windowId = windowId
        self.appName = appName
        self.bundleId = bundleId
        self.windowFrame = windowFrame
        self.mirror = mirror
        self.privatePath = privatePath
    }

    /// `[x, y, w, h]` from the engine's results; anything else is an empty rect.
    public static func rect(_ frame: [Double]) -> CGRect {
        frame.count == 4 ? CGRect(x: frame[0], y: frame[1], width: frame[2], height: frame[3]) : .zero
    }

    var wire: [String: JSONValue] {
        ["targetId": .string(targetId), "pid": .number(Double(pid)), "windowId": .number(Double(windowId)),
         "appName": .string(appName), "bundleId": .string(bundleId),
         "windowSize": .array([.number(Double(windowFrame.width)), .number(Double(windowFrame.height))])]
    }
}

/// `view.subscribe` params.
public struct ViewSubscribeParams: Codable, Equatable, Sendable {
    public var sessionId: String
    public var frames: Bool
    public var maxFps: Int?
    public var maxWidth: Int?

    public init(sessionId: String, frames: Bool, maxFps: Int? = nil, maxWidth: Int? = nil) {
        self.sessionId = sessionId
        self.frames = frames
        self.maxFps = maxFps
        self.maxWidth = maxWidth
    }
}

/// `view.unsubscribe` params.
public struct ViewUnsubscribeParams: Codable, Equatable, Sendable {
    public var sessionId: String
}

/// One Winter.app subscription to one session.
public struct ViewSubscription: Equatable, Sendable {
    public var frames: Bool
    public var maxFps: Int
    public var maxWidth: Int
}

/// Window-relative geometry for `view.cursor`: the engine reports screen points; the app draws inside a
/// picture of the window.
public enum WindowRelative {
    public static func point(_ p: CGPoint, origin: CGPoint) -> CGPoint {
        CGPoint(x: p.x - origin.x, y: p.y - origin.y)
    }

    public static func rect(_ r: CGRect, origin: CGPoint) -> CGRect {
        CGRect(origin: point(r.origin, origin: origin), size: r.size)
    }
}

@MainActor public final class ViewHub {
    public static let defaultMaxFps = 10
    public static let defaultMaxWidth = 720
    /// Bounds on what a subscriber may ask for (not pinned): at most 30 fps, a frame 64…2560 px wide.
    public static let fpsRange = 1...30
    public static let widthRange = 64...2560
    /// A target with no engine action for this long is captured at `idleFps` until its next action: a window
    /// nobody is working in does not need 10 encoded frames a second (measured: the helper sat at ~76% CPU
    /// streaming an idle window).
    public static let idleAfter: TimeInterval = 3
    public static let idleFps = 1
    /// How long a window's on-screen origin (for window-relative cursor points) is trusted before it is asked for
    /// again: the window server's answer costs real time on the main thread, and cursor events come in bursts.
    public static let originTTL: TimeInterval = 0.5
    /// How often the bound windows of watched sessions are checked for being on screen. A window on another
    /// Space or display that is off every screen (or minimized) gets no frames from a live stream: its view is
    /// KEPT (the agent still drives it, and Winter.app still shows it), the live capture pauses, and one-shot
    /// snapshots are taken instead — twice a second while it is being worked in, once a second otherwise (the
    /// window server's image of a window on another Space is current for an app that keeps drawing there:
    /// measured live, a working full-screen Terminal changed in every 2 s capture), every 30 s after three in a
    /// row came back empty. With none, the last frame stays; an unchanged one is not sent again.
    public static let visibilityPollInterval: TimeInterval = 1
    public static let offScreenSnapshotActive: TimeInterval = 0.5
    public static let offScreenSnapshotIdle: TimeInterval = 1
    public static let offScreenSnapshotBackoff: TimeInterval = 30
    public static let offScreenSnapshotFailuresBeforeBackoff = 3

    private struct Capture {
        let handle: FrameCapture
        let windowId: UInt32
        var maxFps: Int
        var maxWidth: Int
        let generation: Int
    }

    /// How long a capture nobody watches any more is kept before it stops: a subscription that goes away and comes
    /// back (a window re-laid out, a reconnect) reuses the running stream instead of stopping and starting one.
    public static let stopGrace: TimeInterval = 5
    /// How often, while anything is captured, one line counts the stream starts, restarts and in-place updates.
    public static let statsInterval: TimeInterval = 60

    private struct SnapshotState {
        var nextAt: TimeInterval = 0
        /// When the one in flight (or the last one) was asked for: the cadence counts from there.
        var startedAt: TimeInterval = 0
        var failures = 0
        var inFlight = false
        var loggedEmpty = false
    }

    private let capture: FrameCaptureFactory
    private let geometry: WindowGeometry
    private let snapshotter: WindowSnapshotter
    private let clock: ViewClock
    /// An event line for one connection.
    public var sendEvent: (Int, Data) -> Void = { _, _ in }
    /// A frame line for one connection, coalesced per `key` (target) by the server: a slow reader gets the
    /// newest frame, never a growing queue.
    public var sendFrame: (Int, String, Data) -> Void = { _, _, _ in }
    /// View lifecycle lines (subscriptions, binds, releases, captures, off-screen pauses) — persisted by the app's
    /// wiring (`.notice`, public): ids, app names, sizes and reasons only, never frame content.
    public var log: (String) -> Void = { _ in }

    public private(set) var targets: [String: ViewTarget] = [:]
    private var subscriptions: [Int: [String: ViewSubscription]] = [:]
    private var captures: [String: Capture] = [:]
    private var seqs: [String: Int] = [:]
    private var generation = 0
    /// Targets that had an engine action in the last `idleAfter` seconds, with the timer that ends it.
    private var active: [String: IdleCancellable] = [:]
    /// When each target last had an engine action (or a bind): the idle drop waits `idleAfter` from it.
    private var lastActionAt: [String: TimeInterval] = [:]
    private var pendingStops: [String: IdleCancellable] = [:]
    private var stats = (starts: 0, restarts: 0, updates: 0)
    private var statsTimer: IdleCancellable?
    /// Per target: the digest of the last frame sent (an identical one is not sent again) and its line (what a
    /// new frames subscriber gets at once, since an unchanged window sends no new frame).
    private var lastFrame: [String: (digest: Int, line: Data)] = [:]
    private var origins: [UInt32: (origin: CGPoint, at: TimeInterval)] = [:]
    /// Targets whose window is off every screen (another Space or display, minimized): no live capture.
    private var offScreen: Set<String> = []
    private var snapshots: [String: SnapshotState] = [:]
    private var visibilityTimer: IdleCancellable?
    /// The next off-screen snapshot due (its own timer: the cadence is finer than the visibility poll).
    private var snapshotTimer: (cancellable: IdleCancellable, due: TimeInterval)?

    public init(capture: FrameCaptureFactory, geometry: WindowGeometry, snapshotter: WindowSnapshotter, clock: ViewClock) {
        self.capture = capture
        self.geometry = geometry
        self.snapshotter = snapshotter
        self.clock = clock
    }

    /// Whether a target's window is known to be off every screen (its live capture paused, its view kept).
    public func isOffScreen(_ targetId: String) -> Bool { offScreen.contains(targetId) }

    /// Stream starts, restarts (another window) and in-place updates since the last stats line. For tests.
    public var captureStats: (starts: Int, restarts: Int, updates: Int) { stats }

    /// Whether a target is captured at full rate (an engine action within `idleAfter`).
    public func isActive(_ targetId: String) -> Bool { active[targetId] != nil }

    /// What is being captured now: target → (window, fps, width). For tests and logs.
    public var capturing: [String: (windowId: UInt32, maxFps: Int, maxWidth: Int)] {
        captures.mapValues { ($0.windowId, $0.maxFps, $0.maxWidth) }
    }

    // MARK: Subscriptions (Winter.app)

    /// Subscribes `connection` to `sessionId` (a repeat replaces its options) and answers the session's bound
    /// targets.
    public func subscribe(connection: Int, _ p: ViewSubscribeParams) -> [ViewTarget] {
        let fps = min(max(p.maxFps ?? Self.defaultMaxFps, Self.fpsRange.lowerBound), Self.fpsRange.upperBound)
        let width = min(max(p.maxWidth ?? Self.defaultMaxWidth, Self.widthRange.lowerBound), Self.widthRange.upperBound)
        let previous = subscriptions[connection]?[p.sessionId]
        subscriptions[connection, default: [:]][p.sessionId] = ViewSubscription(frames: p.frames, maxFps: fps, maxWidth: width)
        log("view: connection \(connection) subscribed to \(p.sessionId) (frames \(p.frames), \(fps) fps, \(width) px)")
        refreshCaptures()
        let bound = targets.values.filter { $0.sessionId == p.sessionId }.sorted { $0.targetId < $1.targetId }
        // A window that is not changing sends no new frame: a new frames subscriber gets the last one at once.
        if p.frames, previous?.frames != true {
            for target in bound { if let last = lastFrame[target.targetId] { sendFrame(connection, target.targetId, last.line) } }
        }
        return bound
    }

    public func unsubscribe(connection: Int, sessionId: String) {
        guard subscriptions[connection]?.removeValue(forKey: sessionId) != nil else { return }
        log("view: connection \(connection) unsubscribed from \(sessionId)")
        if subscriptions[connection]?.isEmpty == true { subscriptions.removeValue(forKey: connection) }
        refreshCaptures()
    }

    public func connectionClosed(_ connection: Int) {
        guard subscriptions.removeValue(forKey: connection) != nil else { return }
        log("view: connection \(connection) closed — its subscriptions end")
        refreshCaptures()
    }

    private func subscribers(of sessionId: String) -> [(connection: Int, subscription: ViewSubscription)] {
        subscriptions.compactMap { connection, bySession in bySession[sessionId].map { (connection, $0) } }
            .sorted { $0.connection < $1.connection }
    }

    // MARK: Targets (the daemon's binds, the engine's events)

    /// A `target.bind` (or `target.useWindow`) result: (re)announced to the session's subscribers.
    public func bound(_ boundTarget: ViewTarget) {
        var target = boundTarget
        // Winter.app sizes the mirror from this: never announce a window of no size (an off-Space window's
        // reported frame can come back empty) when the window server knows the real one.
        if !Self.hasSize(target.windowFrame.size), let real = geometry.frame(of: CGWindowID(target.windowId)), Self.hasSize(real.size) {
            target.windowFrame = real
        }
        // The same target on the same window again — every script re-binds the app it works in. Nothing is
        // re-announced (a `view.bound` per call made the mirror flash): the facts are refreshed where they stand, a
        // new size travels in place on the next `view.frame` (Winter.app resizes the shown mirror from it), and the
        // bind counts as an action.
        if let known = targets[target.targetId], known.windowId == target.windowId, known.sessionId == target.sessionId {
            var kept = target
            if !Self.hasSize(target.windowFrame.size) { kept.windowFrame = known.windowFrame }
            targets[target.targetId] = kept
            if kept.windowFrame.size != known.windowFrame.size {
                log("view: \(target.targetId) re-bound — window resized to \(Int(kept.windowFrame.width))×\(Int(kept.windowFrame.height)) (in place)")
            }
            markActive(target.targetId)
            refreshCaptures()
            return
        }
        let previous = targets[target.targetId]
        targets[target.targetId] = target
        if previous?.windowId != target.windowId {
            // (A running capture of the old window is restarted on the new one by `refreshCaptures`.)
            lastFrame.removeValue(forKey: target.targetId)
            offScreen.remove(target.targetId)
            snapshots.removeValue(forKey: target.targetId)
        }
        log("view: \(target.targetId) bound — \(target.appName) window \(target.windowId) "
            + "\(Int(target.windowFrame.width))×\(Int(target.windowFrame.height)), session \(target.sessionId), mirror \(target.mirror)")
        updateVisibility(target.targetId)
        markActive(target.targetId) // a bind is the first action on its window
        emit(sessionId: target.sessionId, method: "view.bound",
             params: target.wire.merging(["sessionId": .string(target.sessionId)]) { a, _ in a })
        refreshCaptures()
    }

    /// `target.useWindow`: the same target, another window.
    public func windowChanged(targetId: String, windowId: UInt32, windowFrame: CGRect) {
        guard var target = targets[targetId] else { return }
        if target.windowId != windowId { log("view: \(targetId) moved to window \(windowId)") }
        target.windowId = windowId
        target.windowFrame = windowFrame
        bound(target)
    }

    /// A release from any door (`target.release`, the engine's `targetReleased`/`targetLost`, `session.ended`,
    /// the daemon's connection closing). Idempotent: a second release of the same target says nothing.
    public func release(targetId: String, reason: String = "released") {
        guard let target = targets.removeValue(forKey: targetId) else { return }
        log("view: \(targetId) (\(target.appName)) released — \(reason)")
        stopCapture(targetId, reason: "released")
        seqs.removeValue(forKey: targetId)
        lastFrame.removeValue(forKey: targetId)
        active.removeValue(forKey: targetId)?.cancel()
        offScreen.remove(targetId)
        snapshots.removeValue(forKey: targetId)
        lastActionAt.removeValue(forKey: targetId)
        pendingStops.removeValue(forKey: targetId)?.cancel()
        emit(sessionId: target.sessionId, method: "view.released",
             params: ["sessionId": .string(target.sessionId), "targetId": .string(targetId)])
    }

    /// The engine's `targetReleased`, which names the window rather than the target.
    public func released(sessionId: String, pid: pid_t, windowId: CGWindowID) {
        for id in matching(sessionId: sessionId, pid: pid, windowId: windowId) { release(targetId: id, reason: "the engine released it") }
    }

    public func sessionEnded(sessionId: String) {
        for id in targets.values.filter({ $0.sessionId == sessionId }).map(\.targetId).sorted() { release(targetId: id, reason: "the session ended") }
    }

    private func matching(sessionId: String, pid: pid_t, windowId: CGWindowID) -> [String] {
        targets.values.filter { $0.sessionId == sessionId && $0.pid == pid && $0.windowId == windowId }.map(\.targetId).sorted()
    }

    // MARK: Cursor

    /// The engine's cursor event, in window-relative points (the engine's `kind` and payload passed through —
    /// Winter.app maps them with the same table the on-screen cursor uses).
    public func cursor(sessionId: String, pid: pid_t, windowId: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?,
                       frame: CGRect?, text: String?, count: Int?, button: String?) {
        let ids = matching(sessionId: sessionId, pid: pid, windowId: windowId)
        for id in ids { markActive(id) } // every engine action wakes its window's capture
        guard !subscribers(of: sessionId).isEmpty else { return }
        for id in ids {
            guard let target = targets[id] else { continue }
            let origin = windowOrigin(target)
            func pair(_ p: CGPoint) -> JSONValue { .array([.number(Double(p.x)), .number(Double(p.y))]) }
            let at = WindowRelative.point(point, origin: origin)
            var params: [String: JSONValue] = [
                "sessionId": .string(sessionId), "targetId": .string(id), "kind": .string(kind), "point": pair(at),
            ]
            if let dragTo { params["dragTo"] = pair(WindowRelative.point(dragTo, origin: origin)) }
            if let frame {
                let r = WindowRelative.rect(frame, origin: origin)
                params["frame"] = .array([.number(Double(r.minX)), .number(Double(r.minY)), .number(Double(r.width)), .number(Double(r.height))])
            }
            if let text { params["text"] = .string(text) }
            if let count { params["count"] = .number(Double(count)) }
            if let button { params["button"] = .string(button) }
            emit(sessionId: sessionId, method: "view.cursor", params: params)
        }
    }

    /// Where the window is now (cached for `originTTL`), else where it was bound.
    private func windowOrigin(_ target: ViewTarget) -> CGPoint {
        let now = clock.now
        if let cached = origins[target.windowId], now - cached.at < Self.originTTL { return cached.origin }
        let origin = geometry.frame(of: CGWindowID(target.windowId))?.origin ?? target.windowFrame.origin
        origins[target.windowId] = (origin, now)
        return origin
    }

    // MARK: Activity (the idle throttle)

    /// An engine action on a target: full rate now, and for `idleAfter` seconds after the last one.
    private func markActive(_ targetId: String) {
        guard targets[targetId] != nil else { return }
        let wasActive = active[targetId] != nil
        if !wasActive {
            // Waking up: is the window where a live capture can see it? (Off screen, a snapshot is due now.)
            updateVisibility(targetId)
            if offScreen.contains(targetId) {
                snapshots[targetId, default: SnapshotState()].nextAt = clock.now
                scheduleSnapshots()
            }
        }
        lastActionAt[targetId] = clock.now
        active[targetId]?.cancel()
        active[targetId] = clock.schedule(after: Self.idleAfter) { [weak self] in
            guard let self else { return }
            self.active.removeValue(forKey: targetId)
            self.refreshCaptures()
        }
        if !wasActive { refreshCaptures() }
    }

    // MARK: Frames

    /// Captures run exactly for the bound targets with `mirror` whose session has a `frames:true` subscriber, at
    /// the lowest `maxFps` and `maxWidth` those subscribers asked for — or `idleFps` while the target has had no
    /// action for `idleAfter` seconds; a change restarts, anything else stops.
    private func refreshCaptures() {
        for (id, target) in targets {
            let wanting = subscribers(of: target.sessionId).map(\.subscription).filter(\.frames)
            guard target.mirror else {
                stopCapture(id, reason: "the bind said mirror false")
                continue
            }
            guard let wanted = wanting.map(\.maxFps).min(), let width = wanting.map(\.maxWidth).min() else {
                stopLater(id) // nobody watches: kept a moment, in case a subscription comes straight back
                continue
            }
            pendingStops.removeValue(forKey: id)?.cancel()
            // Hysteresis: full rate from an action until `idleAfter` without one, then the idle rate — never down
            // sooner, whatever asked for the refresh.
            let quietFor = clock.now - (lastActionAt[id] ?? -.infinity)
            let fps = active[id] != nil || quietFor < Self.idleAfter ? wanted : min(wanted, Self.idleFps)
            // Off every screen a live stream delivers nothing: no stream; snapshots (`takeDueSnapshots`) instead.
            if offScreen.contains(id) {
                stopCapture(id, reason: "the window is off screen")
                continue
            }
            if var running = captures[id], running.windowId == target.windowId {
                // A healthy stream is never restarted: a new rate or width is applied in place.
                if running.maxFps != fps || running.maxWidth != width {
                    running.handle.update(maxFps: fps, maxWidth: width)
                    running.maxFps = fps
                    running.maxWidth = width
                    captures[id] = running
                    stats.updates += 1
                }
                continue
            }
            let restart = captures[id] != nil
            stopCapture(id, reason: "its target moved to window \(target.windowId)")
            if restart { stats.restarts += 1 } else { stats.starts += 1 }
            generation += 1
            let current = generation
            log("view: capture of \(id) (\(target.appName) window \(target.windowId)) started at \(fps) fps, \(width) px")
            let handle = capture.start(windowID: CGWindowID(target.windowId), maxFps: fps, maxWidth: width, onFrame: { [weak self] frame in
                self?.deliver(frame, targetId: id, generation: current)
            }, onError: { [weak self] error in
                self?.captureFailed(targetId: id, generation: current, error: error)
            })
            captures[id] = Capture(handle: handle, windowId: target.windowId, maxFps: fps, maxWidth: width, generation: current)
        }
        for id in captures.keys where targets[id] == nil { stopCapture(id, reason: "no target") }
        scheduleStats()
        scheduleVisibilityPoll()
        scheduleSnapshots()
    }

    private func stopCapture(_ targetId: String, reason: String) {
        pendingStops.removeValue(forKey: targetId)?.cancel()
        guard let running = captures.removeValue(forKey: targetId) else { return }
        running.handle.stop()
        log("view: capture of \(targetId) stopped — \(reason)")
    }

    /// Stops a capture nobody watches after `stopGrace`, unless a frames subscription comes back first.
    private func stopLater(_ targetId: String) {
        guard captures[targetId] != nil, pendingStops[targetId] == nil else { return }
        pendingStops[targetId] = clock.schedule(after: Self.stopGrace) { [weak self] in
            guard let self else { return }
            self.pendingStops.removeValue(forKey: targetId)
            self.stopCapture(targetId, reason: "no frames subscriber for \(Int(Self.stopGrace)) s")
        }
    }

    /// One `.notice` line a minute while anything is captured: how often streams started, restarted (another
    /// window) and were updated in place — the numbers a live gate checks for flapping.
    private func scheduleStats() {
        guard statsTimer == nil, !captures.isEmpty else { return }
        statsTimer = clock.schedule(after: Self.statsInterval) { [weak self] in
            guard let self else { return }
            self.statsTimer = nil
            self.log("view: in the last \(Int(Self.statsInterval)) s — \(self.stats.starts) stream start(s), \(self.stats.restarts) restart(s), "
                + "\(self.stats.updates) in-place update(s); \(self.captures.count) capturing now")
            self.stats = (0, 0, 0)
            self.scheduleStats()
        }
    }

    /// The targets a frames subscriber is watching (a capture or snapshots are wanted for them).
    private var watched: [String] {
        targets.values.filter { target in
            target.mirror && subscribers(of: target.sessionId).contains { $0.subscription.frames }
        }.map(\.targetId).sorted()
    }

    // MARK: Off screen (another Space or display, minimized)

    /// Reads whether the target's window is on screen and records a change (the view is never released for it).
    /// Returns true when it changed.
    @discardableResult
    private func updateVisibility(_ targetId: String) -> Bool {
        guard let target = targets[targetId], let onScreen = geometry.isOnScreen(CGWindowID(target.windowId)) else { return false }
        if !onScreen, !offScreen.contains(targetId) {
            offScreen.insert(targetId)
            snapshots[targetId] = SnapshotState(nextAt: clock.now)
            log("view: \(targetId) (\(target.appName) window \(target.windowId)) is off screen (another Space or display, "
                + "or minimized) — its view stays; live frames paused, keeping the last frame and trying snapshots")
            return true
        }
        if onScreen, offScreen.contains(targetId) {
            offScreen.remove(targetId)
            snapshots.removeValue(forKey: targetId)
            log("view: \(targetId) (\(target.appName)) is back on screen — live capture resumes")
            return true
        }
        return false
    }

    /// Runs while anything is watched: re-reads the watched windows' visibility, then takes the snapshots due.
    private func scheduleVisibilityPoll() {
        guard visibilityTimer == nil, !watched.isEmpty else { return }
        visibilityTimer = clock.schedule(after: Self.visibilityPollInterval) { [weak self] in
            guard let self else { return }
            self.visibilityTimer = nil
            self.visibilityTick()
        }
    }

    private func visibilityTick() {
        var changed = false
        for id in watched where updateVisibility(id) { changed = true }
        if changed { refreshCaptures() }
        takeDueSnapshots()
        scheduleVisibilityPoll()
    }

    /// Asks for every off-screen snapshot that is due, then arms the timer for the next one.
    private func takeDueSnapshots() {
        let now = clock.now
        for id in watched where offScreen.contains(id) {
            guard let target = targets[id], var state = snapshots[id], !state.inFlight, now >= state.nextAt else { continue }
            let width = subscribers(of: target.sessionId).map(\.subscription).filter(\.frames).map(\.maxWidth).min() ?? Self.defaultMaxWidth
            state.inFlight = true
            state.startedAt = now
            snapshots[id] = state
            snapshotter.snapshot(windowID: CGWindowID(target.windowId), maxWidth: width,
                                 privatePath: target.privatePath) { [weak self] frame in
                self?.snapshotDone(targetId: id, windowId: target.windowId, frame: frame)
            }
        }
        scheduleSnapshots()
    }

    /// Arms one timer for the earliest snapshot due among watched off-screen targets (none in flight, none due:
    /// no timer). A timer already armed for that time or earlier is kept.
    private func scheduleSnapshots() {
        let due = watched.filter { offScreen.contains($0) }
            .compactMap { id in snapshots[id].flatMap { $0.inFlight ? nil : $0.nextAt } }.min()
        guard let due else {
            snapshotTimer?.cancellable.cancel()
            snapshotTimer = nil
            return
        }
        if let armed = snapshotTimer, armed.due <= due { return }
        snapshotTimer?.cancellable.cancel()
        let cancellable = clock.schedule(after: max(0, due - clock.now)) { [weak self] in
            guard let self else { return }
            self.snapshotTimer = nil
            self.takeDueSnapshots()
        }
        snapshotTimer = (cancellable, due)
    }

    private func snapshotDone(targetId: String, windowId: UInt32, frame: ViewFrame?) {
        guard var state = snapshots[targetId], targets[targetId]?.windowId == windowId else { return }
        state.inFlight = false
        let now = clock.now
        let cadence = active[targetId] != nil ? Self.offScreenSnapshotActive : Self.offScreenSnapshotIdle
        if let frame {
            state.failures = 0
            state.loggedEmpty = false
            state.nextAt = max(now, state.startedAt + cadence)
            snapshots[targetId] = state
            if offScreen.contains(targetId) { publish(frame, targetId: targetId) }
            scheduleSnapshots()
            return
        }
        state.failures += 1
        if !state.loggedEmpty {
            state.loggedEmpty = true
            log("view: no snapshot of \(targetId)'s off-screen window — the last frame stays up")
        }
        state.nextAt = state.failures >= Self.offScreenSnapshotFailuresBeforeBackoff ? now + Self.offScreenSnapshotBackoff
            : max(now, state.startedAt + cadence)
        snapshots[targetId] = state
        scheduleSnapshots()
    }

    /// One frame: dropped when its pixels are the ones last sent (a restarted stream's first frame, a window that
    /// redrew the same thing), otherwise encoded into ONE line that every frames subscriber is sent.
    private func deliver(_ frame: ViewFrame, targetId: String, generation: Int) {
        guard captures[targetId]?.generation == generation else { return }
        publish(frame, targetId: targetId)
    }

    private func publish(_ captured: ViewFrame, targetId: String) {
        guard let target = targets[targetId] else { return }
        var frame = captured
        frame.windowSize = realSize(of: target, reported: captured.windowSize)
        let digest = Self.digest(frame)
        if lastFrame[targetId]?.digest == digest { return }
        let seq = (seqs[targetId] ?? 0) + 1
        seqs[targetId] = seq
        guard let line = Self.frameLine(sessionId: target.sessionId, targetId: targetId, seq: seq, frame: frame) else { return }
        lastFrame[targetId] = (digest, line)
        for (connection, subscription) in subscribers(of: target.sessionId) where subscription.frames {
            sendFrame(connection, targetId, line)
        }
    }

    static func hasSize(_ size: CGSize) -> Bool { size.width >= 1 && size.height >= 1 }

    /// The window's size for a frame: what the capture reported, else the window server's bounds, else the size it
    /// was bound with — a zero size makes Winter.app's mirror a panel of nothing.
    private func realSize(of target: ViewTarget, reported: CGSize) -> CGSize {
        if Self.hasSize(reported) { return reported }
        if let real = geometry.frame(of: CGWindowID(target.windowId))?.size, Self.hasSize(real) { return real }
        return target.windowFrame.size
    }

    /// A cheap fingerprint of a frame: its size and its encoded bytes (the encoder is deterministic, so the same
    /// pixels give the same bytes).
    static func digest(_ frame: ViewFrame) -> Int {
        var hasher = Hasher()
        hasher.combine(frame.width)
        hasher.combine(frame.height)
        frame.jpeg.withUnsafeBytes { hasher.combine(bytes: $0) }
        return hasher.finalize()
    }

    /// The `view.frame` line, built by hand around the base64 payload: JSONEncoder would scan ~100 KB of base64 for
    /// characters to escape on every frame (measured as the shell's own hot spot), and base64 has none.
    public static func frameLine(sessionId: String, targetId: String, seq: Int, frame: ViewFrame) -> Data? {
        struct Head: Encodable {
            let sessionId: String
            let targetId: String
            let seq: Int
            let width: Int
            let height: Int
            let windowSize: [Double]
        }
        guard var head = try? JSONEncoder().encode(Head(sessionId: sessionId, targetId: targetId, seq: seq, width: frame.width,
                                                         height: frame.height,
                                                         windowSize: [Double(frame.windowSize.width), Double(frame.windowSize.height)])),
              head.last == UInt8(ascii: "}") else { return nil }
        head.removeLast()
        var line = Data("{\"jsonrpc\":\"2.0\",\"method\":\"view.frame\",\"params\":".utf8)
        line.reserveCapacity(line.count + head.count + frame.jpeg.count * 4 / 3 + 32)
        line.append(head)
        line.append(contentsOf: Array(",\"jpeg\":\"".utf8))
        line.append(frame.jpeg.base64EncodedData())
        line.append(contentsOf: Array("\"}}\n".utf8))
        return line
    }

    /// A capture that failed stays stopped until the subscriptions or the target change (no retry loop).
    private func captureFailed(targetId: String, generation: Int, error: Error) {
        guard let running = captures[targetId], running.generation == generation else { return }
        log("view: capture of \(targetId) failed (\(String(describing: error))) — stopped until the next action or subscription change")
        captures.removeValue(forKey: targetId)
        running.handle.stop()
    }

    private func emit(sessionId: String, method: String, params: [String: JSONValue]) {
        let targets = subscribers(of: sessionId)
        guard !targets.isEmpty, let line = RPCOutbound.notification(method: method, params: AnyEncodable(JSONValue.object(params))) else { return }
        for (connection, _) in targets { sendEvent(connection, line) }
    }
}
