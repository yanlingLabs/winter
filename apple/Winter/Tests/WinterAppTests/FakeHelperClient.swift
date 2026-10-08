import Foundation
import WinterKit
@testable import Winter

/// A hand-written `ComputerUseHelperClient`: records every call in order, answers `connect()` from a
/// script, and lets a test push the helper's notifications. No socket, no real helper.
final class FakeHelperClient: ComputerUseHelperClient, @unchecked Sendable {
    let events: AsyncStream<HelperViewEvent>
    private let cont: AsyncStream<HelperViewEvent>.Continuation
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _connectScript: [HelperClientError?] = []
    private var _targets: [String: [HelperTarget]] = [:]
    private var _subscribeError: HelperClientError?
    private var _frameFlags: [String: [Bool]] = [:]

    init() {
        var c: AsyncStream<HelperViewEvent>.Continuation!
        events = AsyncStream { c = $0 }
        cont = c
    }

    /// Every call so far, as `connect`, `subscribe:<session>`, `unsubscribe:<session>`, `disconnect`.
    var calls: [String] { lock.withLock { _calls } }
    func count(_ call: String) -> Int { calls.filter { $0 == call }.count }
    /// The `frames` flag of every `subscribe` for `sessionId`, in order.
    func frameFlags(for sessionId: String) -> [Bool] { lock.withLock { _frameFlags[sessionId] ?? [] } }

    /// What the next `connect()` calls do, in order (`nil` succeeds); once the script runs out, they succeed.
    func scriptConnect(_ results: [HelperClientError?]) { lock.withLock { _connectScript = results } }
    func setTargets(_ targets: [HelperTarget], for sessionId: String) { lock.withLock { _targets[sessionId] = targets } }
    func failSubscribe(with error: HelperClientError?) { lock.withLock { _subscribeError = error } }
    func push(_ event: HelperViewEvent) { cont.yield(event) }
    func finish() { cont.finish() }

    func connect() async throws {
        let outcome: HelperClientError? = lock.withLock {
            _calls.append("connect")
            return _connectScript.isEmpty ? nil : _connectScript.removeFirst()
        }
        if let outcome { throw outcome }
    }

    func subscribe(sessionId: String, frames: Bool, maxFps: Int?, maxWidth: Int?) async throws -> [HelperTarget] {
        let (targets, error): ([HelperTarget], HelperClientError?) = lock.withLock {
            _calls.append("subscribe:\(sessionId)")
            _frameFlags[sessionId, default: []].append(frames)
            return (_targets[sessionId] ?? [], _subscribeError)
        }
        if let error { throw error }
        return targets
    }

    func unsubscribe(sessionId: String) async throws { lock.withLock { _calls.append("unsubscribe:\(sessionId)") } }
    func disconnect() async { lock.withLock { _calls.append("disconnect") } }
}

/// A `MirrorSink` that remembers what reached it.
@MainActor
final class RecordingSink: MirrorSink {
    private(set) var log: [String] = []
    func show(appName: String, windowSize: CGSize) { log.append("show:\(appName):\(Int(windowSize.width))x\(Int(windowSize.height))") }
    func apply(frame jpeg: Data, width: Int, height: Int, windowSize: CGSize) { log.append("frame:\(jpeg.count):\(width)x\(height)") }
    func applyCursor(kind: String, point: CGPoint, dragTo: CGPoint?, frame: CGRect?, text: String?, count: Int?, button: String?) {
        log.append("cursor:\(kind):\(Int(point.x)),\(Int(point.y))")
    }
    func setOtherTargets(_ count: Int) { log.append("others:\(count)") }
    func clear() { log.append("clear") }
}

extension HelperTarget {
    static func fake(_ id: String, app: String = "Notes", size: CGSize = CGSize(width: 800, height: 600)) -> HelperTarget {
        HelperTarget(targetId: id, pid: 100, windowId: 7, appName: app, bundleId: "com.example.\(app)", windowSize: size)
    }
}

extension HelperFrame {
    static func fake(_ session: String, _ target: String, seq: Int = 1, bytes: Int = 4, size: CGSize = CGSize(width: 800, height: 600)) -> HelperFrame {
        HelperFrame(sessionId: session, targetId: target, seq: seq, jpeg: Data(repeating: 0xFF, count: bytes), width: 720, height: 540, windowSize: size)
    }
}

/// Polls until `condition` holds (the coordinator syncs on its own tasks).
@MainActor
func eventually(_ timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return condition()
}
