import CoreGraphics
import Foundation
import ImageIO
import os
import WinterSessionKit

// -----------------------------------------------------------------------------------------------
// ComputerV2 Phase 1b — the phone mirror, Mac side.
//
// `RemoteMirrorSource` is what the Gateway relays from: Winter.app's own mirror (the app module's
// `RemoteMirrorHub`, fed by the per-session mirror state its `MirrorCoordinator` keeps). A watch is a VIEWER IN
// ITS OWN RIGHT: while it lasts, the coordinator keeps the session subscribed with pictures over its one helper
// connection — whether a Winter window on the Mac shows the session, hides it or is not open at all — ref-counted
// beside the Mac's windows. The source never launches the helper, and the helper's view capture only reads the
// bound window: nothing moves, activates or raises (the never-move-the-view rule). Its cost lasts only while a phone
// watches.
//
// `RemoteMirrorRelay` is one phone's watch of one session: it takes the source's updates on any thread and sends
// them to the phone at the phone's pace — one write in flight, only the newest picture waiting, pictures cut to
// the transport's size (`MirrorFrameFitter`) and paced (`MirrorWire.activeFps`, `idleFps` after `idleAfter`).
// All of its work (the JPEG re-encode included) runs on its own task: never on the Gateway actor (which relays
// every rpc for the phone) and never on the main actor (where the Mac's mirror runs).
// -----------------------------------------------------------------------------------------------

/// One watch of a session's mirror, as `RemoteMirrorSource.watch` hands it out.
public struct RemoteMirrorWatch: Hashable, Sendable {
    public let id: UUID
    public let sessionId: String

    public init(id: UUID = UUID(), sessionId: String) {
        self.id = id
        self.sessionId = sessionId
    }
}

/// Where the Gateway gets the mirror it relays to a phone.
public protocol RemoteMirrorSource: AnyObject, Sendable {
    /// Starts relaying `sessionId`'s mirror to `deliver`: first the state on show now (`show` and the newest
    /// picture, or `clear` when nothing is), then every change, until `unwatch`. The watch counts as a viewer of the
    /// session's mirror until then; it must never launch anything or move the user's view.
    func watch(sessionId: String, deliver: @escaping @Sendable (MirrorUpdate) -> Void) async -> RemoteMirrorWatch
    func unwatch(_ watch: RemoteMirrorWatch) async
}

// MARK: - The relay

/// One phone's watch of one session's mirror — see the file header.
///
/// What waits to be sent, and in which order:
///   1. control updates (`show`, `reset`, `clear`), in order — a `clear` drops everything older that waits, a `show`
///      or `reset` drops a waiting picture (it was the previous target's);
///   2. cursor updates, in order, at most `maxPendingCursors` (the oldest go; a run of `move`s keeps its last);
///   3. the NEWEST picture only, sent once `interval` has passed since the last picture sent: `1 / activeFps` while
///      the agent acted (a `show` or an action-kind cursor) in the last `idleAfter` seconds, `1 / idleFps` after.
/// A picture that cannot be fitted under `MirrorWire.maxJPEGBytes` is dropped, never sent.
public final class RemoteMirrorRelay: @unchecked Sendable {
    public typealias Send = @Sendable (MirrorUpdate) async -> Void

    static let maxPendingCursors = 16

    private struct State {
        var controls: [MirrorUpdate] = []
        var cursors: [MirrorUpdate] = []
        var frame: MirrorFrame?
        var lastFrameSentAt: TimeInterval?
        var lastActionAt: TimeInterval = -.infinity
        var stopped = false
        var timer: Task<Void, Never>?
        var droppedFrames = 0
    }

    private enum Next {
        case send(MirrorUpdate)
        case wait(TimeInterval)
        case idle
        case done
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let send: Send
    private let fit: @Sendable (MirrorFrame) -> MirrorFrame?
    private let now: @Sendable () -> TimeInterval
    private let sleep: @Sendable (TimeInterval) async -> Void
    private let wake: AsyncStream<Void>.Continuation
    /// The relay's own task. It holds the relay until `stop()` ends it — every owner stops what it started (the
    /// Gateway does so on every way a watch can end).
    private var loop: Task<Void, Never>?

    /// - Parameters:
    ///   - send: writes one update to the phone; awaited, so the link sets the pace.
    ///   - fit: cuts a picture to the transport's size (`MirrorFrameFitter.fit` in production).
    ///   - now / sleep: the clock and the pacing wait — real time in production, a test clock in tests.
    public init(send: @escaping Send,
                fit: @escaping @Sendable (MirrorFrame) -> MirrorFrame? = { MirrorFrameFitter.fit($0) },
                now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
                sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64(max($0, 0) * 1_000_000_000)) }) {
        self.send = send
        self.fit = fit
        self.now = now
        self.sleep = sleep
        var continuation: AsyncStream<Void>.Continuation!
        let wakes = AsyncStream<Void>(bufferingPolicy: .bufferingNewest(1)) { continuation = $0 }
        self.wake = continuation
        loop = Task.detached { [self] in await self.pump(wakes) }
    }

    /// An update from the mirror. Any thread; never blocks.
    public func push(_ update: MirrorUpdate) {
        let accepted: Bool = state.withLock { s in
            guard !s.stopped else { return false }
            let t = now()
            switch update {
            case .clear:
                s.controls = [.clear]
                s.cursors = []
                s.frame = nil
            case .show:
                s.frame = nil
                if case .show? = s.controls.last { s.controls[s.controls.count - 1] = update } else { s.controls.append(update) }
                s.lastActionAt = t
            case .reset:
                s.frame = nil
                s.cursors = []
                s.controls.append(update)
            case .frame(let f):
                s.frame = f
            case .cursor(let c):
                if MirrorWire.actionKinds.contains(c.kind) { s.lastActionAt = t }
                if c.kind == "move", case .cursor(let last)? = s.cursors.last, last.kind == "move" {
                    s.cursors[s.cursors.count - 1] = update
                } else {
                    s.cursors.append(update)
                    if s.cursors.count > Self.maxPendingCursors { s.cursors.removeFirst(s.cursors.count - Self.maxPendingCursors) }
                }
            }
            return true
        }
        if accepted { wake.yield() }
    }

    /// Ends the relay: nothing more is sent (a write already in flight finishes).
    public func stop() {
        let timer: Task<Void, Never>? = state.withLock { s in
            s.stopped = true
            s.controls = []
            s.cursors = []
            s.frame = nil
            let t = s.timer
            s.timer = nil
            return t
        }
        timer?.cancel()
        wake.finish()
    }

    var isStopped: Bool { state.withLock { $0.stopped } }
    /// Pictures dropped because they could not be fitted under the byte cap (tests, diagnostics).
    var droppedFrames: Int { state.withLock { $0.droppedFrames } }

    /// The interval between pictures right now.
    private static func interval(now: TimeInterval, lastActionAt: TimeInterval) -> TimeInterval {
        now - lastActionAt < MirrorWire.idleAfter ? 1.0 / Double(MirrorWire.activeFps) : 1.0 / Double(MirrorWire.idleFps)
    }

    private func next() -> Next {
        state.withLock { s in
            if s.stopped { return .done }
            if !s.controls.isEmpty { return .send(s.controls.removeFirst()) }
            if !s.cursors.isEmpty { return .send(s.cursors.removeFirst()) }
            guard let frame = s.frame else { return .idle }
            let t = now()
            if let last = s.lastFrameSentAt {
                let due = last + Self.interval(now: t, lastActionAt: s.lastActionAt)
                if t < due { return .wait(due - t) }
            }
            s.frame = nil
            s.lastFrameSentAt = t
            return .send(.frame(frame))
        }
    }

    /// Wakes the loop after `seconds` (a waiting picture becomes due). Replaces an earlier timer.
    private func arm(after seconds: TimeInterval) {
        let sleep = self.sleep
        let wake = self.wake
        let timer = Task {
            await sleep(seconds)
            if !Task.isCancelled { wake.yield() }
        }
        let previous: Task<Void, Never>? = state.withLock { s in
            let p = s.timer
            s.timer = s.stopped ? nil : timer
            return p
        }
        previous?.cancel()
        if isStopped { timer.cancel() }
    }

    private func pump(_ wakes: AsyncStream<Void>) async {
        var iterator = wakes.makeAsyncIterator()
        while !Task.isCancelled {
            switch next() {
            case .done:
                return
            case .send(.frame(let frame)):
                // The re-encode happens here, on the relay's own task — off every actor.
                guard let fitted = fit(frame) else {
                    state.withLock { $0.droppedFrames += 1 }
                    continue
                }
                await send(.frame(fitted))
            case .send(let update):
                await send(update)
            case .wait(let seconds):
                arm(after: seconds)
                guard await iterator.next() != nil else { return }
            case .idle:
                guard await iterator.next() != nil else { return }
            }
        }
    }
}

// MARK: - Fitting a picture to the transport

/// Cuts a mirror picture to the phone transport's size: at most `MirrorWire.maxLongEdge` pixels on its long edge and
/// `MirrorWire.maxJPEGBytes` bytes, re-encoding with ImageIO at falling qualities. A picture already within both
/// passes through untouched; one that cannot be brought under the byte cap is `nil` (dropped, never sent).
public enum MirrorFrameFitter {
    static let qualities: [Double] = [0.6, 0.45, 0.3, 0.2]

    public static func fit(_ frame: MirrorFrame) -> MirrorFrame? {
        fit(frame, maxLongEdge: MirrorWire.maxLongEdge, maxBytes: MirrorWire.maxJPEGBytes)
    }

    static func fit(_ frame: MirrorFrame, maxLongEdge: Int, maxBytes: Int) -> MirrorFrame? {
        if max(frame.width, frame.height) <= maxLongEdge, frame.width > 0, frame.height > 0, frame.jpeg.count <= maxBytes {
            return frame
        }
        guard let source = CGImageSourceCreateWithData(frame.jpeg as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxLongEdge,
                  kCGImageSourceCreateThumbnailWithTransform: true,
              ] as CFDictionary) else { return nil }
        for quality in qualities {
            guard let jpeg = encodeJPEG(image, quality: quality) else { return nil }
            if jpeg.count <= maxBytes {
                return MirrorFrame(seq: frame.seq, jpeg: jpeg, width: image.width, height: image.height, windowSize: frame.windowSize)
            }
        }
        return nil
    }

    static func encodeJPEG(_ image: CGImage, quality: Double) -> Data? {
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }
}
