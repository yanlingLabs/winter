import CoreGraphics
import Darwin
import Foundation
import WinterComputerUseShell
import WinterCUCore
import WinterCUPresentation
import XCTest

// Test doubles for every seam the shell has: the engine, the presentation layer, the Esc tap, the grants,
// the peer check and the idle clock. The engine fake reads and answers JSON only (never a memberwise init of
// an engine type), so these tests compile unchanged against the real `WinterCUCore` once it merges.

func json(_ text: String) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

extension JSONValue {
    var arrayCount: Int? { if case .array(let a) = self { return a.count }; return nil }
}

/// `subset` ⊆ `superset`: every key of every object in `subset` is present with an equal value.
func jsonContains(_ superset: JSONValue, _ subset: JSONValue) -> Bool {
    switch (superset, subset) {
    case (.object(let a), .object(let b)):
        return b.allSatisfy { key, value in a[key].map { jsonContains($0, value) } ?? false }
    case (.array(let a), .array(let b)):
        return a.count == b.count && zip(a, b).allSatisfy { jsonContains($0, $1) }
    default:
        return superset == subset
    }
}

/// One sample per engine method, in the helper RPC's own JSON shapes.
let engineSamples: [(method: String, params: String, result: String)] = [
    ("status", "{}", #"{"helperVersion":"0.124.0","permissions":{"accessibility":true,"screenRecording":false}}"#),
    ("permissions.request", #"{"kind":"screenRecording"}"#, #"{"opened":true}"#),
    ("apps.list", "{}", #"{"apps":[{"name":"Notes","bundleId":"com.apple.Notes","running":true,"pid":123}]}"#),
    ("screen.windows", "{}", #"{"windows":[{"app":"Notes","bundleId":"com.apple.Notes","pid":123,"windowId":77,"title":"Groceries","frame":[0,25,800,600],"onScreen":true}]}"#),
    ("target.bind", #"{"sessionId":"s_1","app":"Notes","window":"Groceries","mirror":true}"#,
     #"{"targetId":"t1","app":{"name":"Notes","bundleId":"com.apple.Notes","pid":123},"window":{"id":77,"title":"Groceries","frame":[0,25,800,600]}}"#),
    ("target.useWindow", #"{"targetId":"t1","window":78}"#, #"{"window":{"id":78,"title":"Ideas","frame":[10,10,400,300]}}"#),
    ("target.windows", #"{"targetId":"t1"}"#, #"{"windows":[{"id":77,"title":"Groceries","focused":true}]}"#),
    ("target.release", #"{"targetId":"t1"}"#, "{}"),
    ("target.snapshot", #"{"targetId":"t1","since":"snap-1","full":false,"within":41,"settle":{"maxMs":1500}}"#,
     #"{"snapshotId":"snap-2","text":"Notes — focused [14] · settled 80 ms\n+ [27] button \"Delete Note\"","isDiff":true,"changedRatio":0.1,"settled":true,"waitedMs":80}"#),
    ("target.find", #"{"targetId":"t1","query":{"role":"button","name":"Share"}}"#, #"{"elements":[{"ref":4,"role":"button","name":"Share"}]}"#),
    ("target.screenshot", #"{"targetId":"t1","region":[0,0,100,100],"budget":{"maxLongEdge":1568,"tile":28,"maxTiles":1568,"quality":0.8},"settle":{"maxMs":1500}}"#,
     #"{"imageBase64":"/9j/AA==","mime":"image/jpeg","width":100,"height":100,"shotId":"shot-1","settled":true,"waitedMs":12}"#),
    ("target.act", #"{"targetId":"t1","sessionId":"s_1","callId":"c1","action":{"kind":"click","ref":3,"button":"left","count":1},"access":"full","allowForeground":false,"privatePath":true}"#,
     #"{"rung":1}"#),
    ("target.waitIdle", #"{"targetId":"t1","quietMs":150,"timeoutMs":3000,"callId":"c2"}"#, #"{"settled":true,"waitedMs":150}"#),
    ("target.waitFor", #"{"targetId":"t1","cond":{"text":"Saved","gone":"Saving…"},"timeoutMs":10000}"#, #"{"met":true,"waitedMs":420}"#),
    ("screen.screenshot", #"{"display":"all","excludeBundleIds":["com.winter.app"],"budget":{"maxLongEdge":1440,"quality":0.8}}"#,
     #"{"imageBase64":"/9j/AA==","mime":"image/jpeg","width":1440,"height":900,"shotId":"shot-2"}"#),
    ("screen.appAt", #"{"shotId":"shot-2","point":[100,200]}"#, #"{"app":"Notes","bundleId":"com.apple.Notes","windowId":77}"#),
    ("cancel", #"{"callId":"c1"}"#, "{}"),
    ("turn.ended", #"{"sessionId":"s_1"}"#, "{}"),
    ("session.ended", #"{"sessionId":"s_1"}"#, "{}"),
]

/// The engine, recorded. Answers each method from `results` (default `{}`), throws `errors[method]`, and holds
/// a method listed in `blocking` until its task is cancelled.
final class FakeCore: CoreService, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [(method: String, params: JSONValue)] = []
    var results: [String: JSONValue] = [:]
    var errors: [String: CUError] = [:]
    var blocking: Set<String> = []
    /// Set when a blocked call notices its cancellation.
    let cancelledCalls = Counter()

    var calls: [(method: String, params: JSONValue)] {
        lock.lock(); defer { lock.unlock() }
        return _calls
    }

    func methods() -> [String] { calls.map(\.method) }

    private func answer<P: Encodable, R: Decodable>(_ method: String, _ params: P) async throws -> R {
        let recorded = try JSONValue.from(params)
        let (error, result, blocks) = lock.withLock { () -> (CUError?, JSONValue, Bool) in
            _calls.append((method, recorded))
            return (errors[method], results[method] ?? .object([:]), blocking.contains(method))
        }
        if let error { throw error }
        if blocks {
            do {
                while true { try await Task.sleep(nanoseconds: 5_000_000) }
            } catch {
                cancelledCalls.increment()
                throw error
            }
        }
        return try result.decode(R.self)
    }

    func status(_ params: StatusParams) async throws -> StatusResult { try await answer("status", params) }
    func permissionsRequest(_ params: PermissionsRequestParams) async throws -> PermissionsRequestResult { try await answer("permissions.request", params) }
    func appsList(_ params: AppsListParams) async throws -> AppsListResult { try await answer("apps.list", params) }
    func screenWindows(_ params: ScreenWindowsParams) async throws -> ScreenWindowsResult { try await answer("screen.windows", params) }
    func targetBind(_ params: TargetBindParams) async throws -> TargetBindResult { try await answer("target.bind", params) }
    func targetUseWindow(_ params: TargetUseWindowParams) async throws -> TargetUseWindowResult { try await answer("target.useWindow", params) }
    func targetWindows(_ params: TargetWindowsParams) async throws -> TargetWindowsResult { try await answer("target.windows", params) }
    func targetRelease(_ params: TargetReleaseParams) async throws -> TargetReleaseResult { try await answer("target.release", params) }
    func targetSnapshot(_ params: TargetSnapshotParams) async throws -> TargetSnapshotResult { try await answer("target.snapshot", params) }
    func targetFind(_ params: TargetFindParams) async throws -> TargetFindResult { try await answer("target.find", params) }
    func targetScreenshot(_ params: TargetScreenshotParams) async throws -> TargetScreenshotResult { try await answer("target.screenshot", params) }
    func targetAct(_ params: TargetActParams) async throws -> TargetActResult { try await answer("target.act", params) }
    func targetWaitIdle(_ params: TargetWaitIdleParams) async throws -> TargetWaitIdleResult { try await answer("target.waitIdle", params) }
    func targetWaitFor(_ params: TargetWaitForParams) async throws -> TargetWaitForResult { try await answer("target.waitFor", params) }
    func screenScreenshot(_ params: ScreenScreenshotParams) async throws -> ScreenScreenshotResult { try await answer("screen.screenshot", params) }
    func screenAppAt(_ params: ScreenAppAtParams) async throws -> ScreenAppAtResult { try await answer("screen.appAt", params) }
    func cancel(_ params: CancelParams) async throws -> CancelResult { try await answer("cancel", params) }
    func turnEnded(_ params: TurnEndedParams) async throws -> TurnEndedResult { try await answer("turn.ended", params) }
    func sessionEnded(_ params: SessionEndedParams) async throws -> SessionEndedResult { try await answer("session.ended", params) }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func increment() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
}

@MainActor final class FakePresentation: CUPresentation {
    enum Call: Equatable {
        case show(String, CUWindowRef)
        case hide(String, CUWindowRef)
        case cursor(String, CUWindowRef, CGPoint, CUCursorKind)
        case turnEnded(String)
        case sessionEnded(String)
    }

    var calls: [Call] = []
    var mirrorsEnabled = true

    func showMirror(sessionId: String, target: CUWindowRef) { calls.append(.show(sessionId, target)) }
    func hideMirror(sessionId: String, target: CUWindowRef) { calls.append(.hide(sessionId, target)) }
    func cursor(sessionId: String, target: CUWindowRef, point: CGPoint, kind: CUCursorKind) { calls.append(.cursor(sessionId, target, point, kind)) }
    func turnEnded(sessionId: String) { calls.append(.turnEnded(sessionId)) }
    func sessionEnded(sessionId: String) { calls.append(.sessionEnded(sessionId)) }
}

@MainActor final class FakeEscapeTap: CUEscapeTap {
    var armedCalls: [Bool] = []
    var syntheticWindows: [TimeInterval] = []
    var onEscape: (() -> Void)?

    func setArmed(_ armed: Bool) { armedCalls.append(armed) }
    func expectSyntheticEscape(for window: TimeInterval) { syntheticWindows.append(window) }
}

struct FakeAuthenticator: PeerAuthenticator {
    let decision: PeerAuthDecision
    func authorize(socket fd: Int32) -> PeerAuthDecision { decision }
}

/// A clock the test advances by hand.
@MainActor final class FakeIdleScheduler: IdleScheduler {
    final class Entry: IdleCancellable {
        let due: TimeInterval
        let fire: @MainActor () -> Void
        var cancelled = false
        init(due: TimeInterval, fire: @escaping @MainActor () -> Void) { self.due = due; self.fire = fire }
        func cancel() { cancelled = true }
    }

    private(set) var now: TimeInterval = 0
    private var entries: [Entry] = []

    var pendingCount: Int { entries.filter { !$0.cancelled }.count }

    func schedule(after seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> IdleCancellable {
        let entry = Entry(due: now + seconds, fire: fire)
        entries.append(entry)
        return entry
    }

    func advance(by seconds: TimeInterval) {
        now += seconds
        let due = entries.filter { !$0.cancelled && $0.due <= now }
        entries.removeAll { $0.cancelled || $0.due <= now }
        due.forEach { $0.fire() }
    }
}

/// Window captures, recorded; a test delivers frames by hand.
@MainActor final class FakeCaptureFactory: FrameCaptureFactory {
    final class Running: FrameCapture {
        let windowID: CGWindowID
        let maxFps: Int
        let maxWidth: Int
        let onFrame: @MainActor (ViewFrame) -> Void
        let onError: @MainActor (Error) -> Void
        var stopped = false
        init(windowID: CGWindowID, maxFps: Int, maxWidth: Int, onFrame: @escaping @MainActor (ViewFrame) -> Void,
             onError: @escaping @MainActor (Error) -> Void) {
            self.windowID = windowID; self.maxFps = maxFps; self.maxWidth = maxWidth; self.onFrame = onFrame; self.onError = onError
        }
        func stop() { stopped = true }
    }

    var started: [Running] = []
    var live: [Running] { started.filter { !$0.stopped } }

    func start(windowID: CGWindowID, maxFps: Int, maxWidth: Int, onFrame: @escaping @MainActor (ViewFrame) -> Void,
               onError: @escaping @MainActor (Error) -> Void) -> FrameCapture {
        let running = Running(windowID: windowID, maxFps: maxFps, maxWidth: maxWidth, onFrame: onFrame, onError: onError)
        started.append(running)
        return running
    }
}

/// Where each window is now; nil → the hub falls back to the bind-time frame.
final class FakeGeometry: WindowGeometry {
    var frames: [CGWindowID: CGRect] = [:]
    func frame(of windowID: CGWindowID) -> CGRect? { frames[windowID] }
}

/// What the hub sent, per connection: event lines and frame lines (decoded).
@MainActor final class ViewSink {
    var events: [Int: [JSONValue]] = [:]
    var frames: [Int: [JSONValue]] = [:]
    func methods(_ connection: Int) -> [String] { (events[connection] ?? []).compactMap { $0["method"]?.stringValue } }
}

/// The shell's pieces wired around fakes, the way `HelperAppDelegate` wires the real ones.
@MainActor final class Rig {
    let core = FakeCore()
    let presentation = FakePresentation()
    let tap = FakeEscapeTap()
    let capture = FakeCaptureFactory()
    let geometry = FakeGeometry()
    let viewHub: ViewHub
    let sink = ViewSink()
    let coordinator: HelperCoordinator
    let inFlight = InFlightRegistry()
    let dispatcher: RPCDispatcher
    var notifications: [HelperNotification] = []

    init() {
        viewHub = ViewHub(capture: capture, geometry: geometry)
        coordinator = HelperCoordinator(presentation: presentation, escapeTap: tap, viewHub: viewHub)
        dispatcher = RPCDispatcher(core: core, coordinator: coordinator, viewHub: viewHub, inFlight: inFlight)
        coordinator.notify = { [weak self] in self?.notifications.append($0) }
        let sink = sink
        let decode = { (line: Data) in try! JSONDecoder().decode(JSONValue.self, from: line) }
        viewHub.sendEvent = { connection, line in sink.events[connection, default: []].append(decode(line)) }
        viewHub.sendFrame = { connection, _, line in sink.frames[connection, default: []].append(decode(line)) }
    }
}

/// A short temp directory (a socket path must fit in 104 bytes), removed by the caller.
func makeTempHome() throws -> String {
    var template = Array((NSTemporaryDirectory() as NSString).appendingPathComponent("wcu-XXXXXX").utf8CString)
    guard let made = mkdtemp(&template) else { throw NSError(domain: "mkdtemp", code: Int(errno)) }
    return HelperIdentity.canonicalPath(String(cString: made))!
}

/// A blocking NDJSON client over a Unix socket, for driving the real server.
final class LineClient {
    let fd: Int32
    private var buffer = Data()

    init(path: String) throws {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
        }
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        guard result == 0 else { close(fd); throw NSError(domain: "connect", code: Int(errno)) }
    }

    deinit { close(fd) }

    func sendRaw(_ text: String) {
        let data = Data(text.utf8)
        data.withUnsafeBytes { raw in _ = write(fd, raw.baseAddress, raw.count) }
    }

    func send(id: Int, method: String, params: String = "{}") {
        sendRaw("{\"jsonrpc\":\"2.0\",\"id\":\(id),\"method\":\"\(method)\",\"params\":\(params)}\n")
    }

    /// The next line, or nil at EOF / after `timeout`.
    func readLine(timeout: TimeInterval = 5) -> JSONValue? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                return try? JSONDecoder().decode(JSONValue.self, from: Data(line))
            }
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 { return nil }
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&pfd, 1, Int32(remaining * 1000)) > 0 else { return nil }
            var chunk = [UInt8](repeating: 0, count: 65536)
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<n])
        }
    }

    /// The response to request `id`, skipping notifications.
    func response(id: Int, timeout: TimeInterval = 5) -> JSONValue? {
        let deadline = Date().addingTimeInterval(timeout)
        while deadline.timeIntervalSinceNow > 0 {
            guard let line = readLine(timeout: deadline.timeIntervalSinceNow) else { return nil }
            if line["id"] == .number(Double(id)) { return line }
        }
        return nil
    }

    /// True when the server closed the connection with nothing (more) to read within `timeout`.
    func closedWithoutData(timeout: TimeInterval = 5) -> Bool {
        guard buffer.isEmpty else { return false }
        var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        guard poll(&pfd, 1, Int32(timeout * 1000)) > 0 else { return false }
        var byte: UInt8 = 0
        return read(fd, &byte, 1) == 0
    }

    func hello(home: String, id: Int = 1) -> JSONValue? {
        send(id: id, method: "hello", params: "{\"protocol\":1,\"client\":\"daemon\",\"home\":\"\(home)\"}")
        return response(id: id)
    }
}
