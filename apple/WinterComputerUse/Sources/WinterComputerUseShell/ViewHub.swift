import CoreGraphics
import Foundation
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

/// Where a window is now, in screen points, top-left origin.
public protocol WindowGeometry: AnyObject {
    func frame(of windowID: CGWindowID) -> CGRect?
}

/// The window server's answer (`kCGWindowBounds` is already top-left screen points).
public final class LiveWindowGeometry: WindowGeometry {
    public init() {}

    public func frame(of windowID: CGWindowID) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]],
              let bounds = list.first?[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary)
    }
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

    public init(sessionId: String, targetId: String, pid: Int32, windowId: UInt32, appName: String, bundleId: String,
                windowFrame: CGRect, mirror: Bool) {
        self.sessionId = sessionId
        self.targetId = targetId
        self.pid = pid
        self.windowId = windowId
        self.appName = appName
        self.bundleId = bundleId
        self.windowFrame = windowFrame
        self.mirror = mirror
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

    private struct Capture {
        let handle: FrameCapture
        let windowId: UInt32
        let maxFps: Int
        let maxWidth: Int
        let generation: Int
    }

    private let capture: FrameCaptureFactory
    private let geometry: WindowGeometry
    private let clock: ViewClock
    /// An event line for one connection.
    public var sendEvent: (Int, Data) -> Void = { _, _ in }
    /// A frame line for one connection, coalesced per `key` (target) by the server: a slow reader gets the
    /// newest frame, never a growing queue.
    public var sendFrame: (Int, String, Data) -> Void = { _, _, _ in }
    public var log: (String) -> Void = { _ in }

    public private(set) var targets: [String: ViewTarget] = [:]
    private var subscriptions: [Int: [String: ViewSubscription]] = [:]
    private var captures: [String: Capture] = [:]
    private var seqs: [String: Int] = [:]
    private var generation = 0
    /// Targets that had an engine action in the last `idleAfter` seconds, with the timer that ends it.
    private var active: [String: IdleCancellable] = [:]
    /// Per target: the digest of the last frame sent (an identical one is not sent again) and its line (what a
    /// new frames subscriber gets at once, since an unchanged window sends no new frame).
    private var lastFrame: [String: (digest: Int, line: Data)] = [:]
    private var origins: [UInt32: (origin: CGPoint, at: TimeInterval)] = [:]

    public init(capture: FrameCaptureFactory, geometry: WindowGeometry, clock: ViewClock) {
        self.capture = capture
        self.geometry = geometry
        self.clock = clock
    }

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
        refreshCaptures()
        let bound = targets.values.filter { $0.sessionId == p.sessionId }.sorted { $0.targetId < $1.targetId }
        // A window that is not changing sends no new frame: a new frames subscriber gets the last one at once.
        if p.frames, previous?.frames != true {
            for target in bound { if let last = lastFrame[target.targetId] { sendFrame(connection, target.targetId, last.line) } }
        }
        return bound
    }

    public func unsubscribe(connection: Int, sessionId: String) {
        subscriptions[connection]?.removeValue(forKey: sessionId)
        if subscriptions[connection]?.isEmpty == true { subscriptions.removeValue(forKey: connection) }
        refreshCaptures()
    }

    public func connectionClosed(_ connection: Int) {
        guard subscriptions.removeValue(forKey: connection) != nil else { return }
        refreshCaptures()
    }

    private func subscribers(of sessionId: String) -> [(connection: Int, subscription: ViewSubscription)] {
        subscriptions.compactMap { connection, bySession in bySession[sessionId].map { (connection, $0) } }
            .sorted { $0.connection < $1.connection }
    }

    // MARK: Targets (the daemon's binds, the engine's events)

    /// A `target.bind` (or `target.useWindow`) result: (re)announced to the session's subscribers.
    public func bound(_ target: ViewTarget) {
        let previous = targets[target.targetId]
        targets[target.targetId] = target
        if previous?.windowId != target.windowId {
            stopCapture(target.targetId)
            lastFrame.removeValue(forKey: target.targetId)
        }
        markActive(target.targetId) // a bind is the first action on its window
        emit(sessionId: target.sessionId, method: "view.bound",
             params: target.wire.merging(["sessionId": .string(target.sessionId)]) { a, _ in a })
        refreshCaptures()
    }

    /// `target.useWindow`: the same target, another window.
    public func windowChanged(targetId: String, windowId: UInt32, windowFrame: CGRect) {
        guard var target = targets[targetId] else { return }
        target.windowId = windowId
        target.windowFrame = windowFrame
        bound(target)
    }

    /// A release from any door (`target.release`, the engine's `targetReleased`/`targetLost`, `session.ended`,
    /// the daemon's connection closing). Idempotent: a second release of the same target says nothing.
    public func release(targetId: String) {
        guard let target = targets.removeValue(forKey: targetId) else { return }
        stopCapture(targetId)
        seqs.removeValue(forKey: targetId)
        lastFrame.removeValue(forKey: targetId)
        active.removeValue(forKey: targetId)?.cancel()
        emit(sessionId: target.sessionId, method: "view.released",
             params: ["sessionId": .string(target.sessionId), "targetId": .string(targetId)])
    }

    /// The engine's `targetReleased`, which names the window rather than the target.
    public func released(sessionId: String, pid: pid_t, windowId: CGWindowID) {
        for id in matching(sessionId: sessionId, pid: pid, windowId: windowId) { release(targetId: id) }
    }

    public func sessionEnded(sessionId: String) {
        for id in targets.values.filter({ $0.sessionId == sessionId }).map(\.targetId).sorted() { release(targetId: id) }
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
            guard target.mirror, let wanted = wanting.map(\.maxFps).min(), let width = wanting.map(\.maxWidth).min() else {
                stopCapture(id)
                continue
            }
            let fps = active[id] != nil ? wanted : min(wanted, Self.idleFps)
            if let running = captures[id], running.windowId == target.windowId, running.maxFps == fps, running.maxWidth == width { continue }
            stopCapture(id)
            generation += 1
            let current = generation
            let handle = capture.start(windowID: CGWindowID(target.windowId), maxFps: fps, maxWidth: width, onFrame: { [weak self] frame in
                self?.deliver(frame, targetId: id, generation: current)
            }, onError: { [weak self] error in
                self?.captureFailed(targetId: id, generation: current, error: error)
            })
            captures[id] = Capture(handle: handle, windowId: target.windowId, maxFps: fps, maxWidth: width, generation: current)
        }
        for id in captures.keys where targets[id] == nil { stopCapture(id) }
    }

    private func stopCapture(_ targetId: String) {
        captures.removeValue(forKey: targetId)?.handle.stop()
    }

    /// One frame: dropped when its pixels are the ones last sent (a restarted stream's first frame, a window that
    /// redrew the same thing), otherwise encoded into ONE line that every frames subscriber is sent.
    private func deliver(_ frame: ViewFrame, targetId: String, generation: Int) {
        guard captures[targetId]?.generation == generation, let target = targets[targetId] else { return }
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
        log("view: capture of target \(targetId) failed (\(String(describing: type(of: error)))) — stopped")
        captures.removeValue(forKey: targetId)
        running.handle.stop()
    }

    private func emit(sessionId: String, method: String, params: [String: JSONValue]) {
        let targets = subscribers(of: sessionId)
        guard !targets.isEmpty, let line = RPCOutbound.notification(method: method, params: AnyEncodable(JSONValue.object(params))) else { return }
        for (connection, _) in targets { sendEvent(connection, line) }
    }
}
