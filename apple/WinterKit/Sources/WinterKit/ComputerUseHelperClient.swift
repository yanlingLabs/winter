import CoreGraphics
import Foundation

// -----------------------------------------------------------------------------------------------
// ComputerV2 — Winter.app as a SECOND client of the Winter Computer Use helper: the live mirror of the
// app being controlled is rendered inside Winter's own windows from frames the helper captures and
// streams here (the helper keeps the Screen Recording grant; Winter.app never captures anything).
//
// The wire is the helper's socket (`<WINTER_HOME>/run/computer-use.sock`), NDJSON JSON-RPC, the same
// framing the daemon uses to talk to it. An app client authenticates with
// `hello {protocol: ComputerUseHelperProtocol.version, client: "app", home}` and may call only `hello`, `view.subscribe`,
// `view.unsubscribe` and `status`; the helper verifies the peer against Winter.app's designated
// requirement. Notifications reach a subscriber of a session: `view.bound`, `view.released`,
// `view.frame`, `view.cursor`.
//
// A protocol so the mirror's coordinator is tested against a fake, and a live implementation over
// `WinterTransport` so it is tested at the wire with `ScriptedTransport`. It is kept free of any window
// or SwiftUI concept: the phone-streaming lane reuses it from the Gateway.
// -----------------------------------------------------------------------------------------------

/// One window of one app the session has bound with `apps.open`.
public struct HelperTarget: Equatable, Sendable {
    public let targetId: String
    public let pid: Int
    public let windowId: Int
    public let appName: String
    public let bundleId: String
    /// The window's size in points.
    public let windowSize: CGSize

    public init(targetId: String, pid: Int, windowId: Int, appName: String, bundleId: String, windowSize: CGSize) {
        self.targetId = targetId
        self.pid = pid
        self.windowId = windowId
        self.appName = appName
        self.bundleId = bundleId
        self.windowSize = windowSize
    }
}

/// A captured frame of a bound window. The JPEG is already decoded from the wire's base64 (the client's
/// pump does that off the main actor — ten frames a second of ~130 KB each is not main-thread work).
public struct HelperFrame: Equatable, Sendable {
    public let sessionId: String
    public let targetId: String
    public let seq: Int
    public let jpeg: Data
    public let width: Int
    public let height: Int
    public let windowSize: CGSize

    public init(sessionId: String, targetId: String, seq: Int, jpeg: Data, width: Int, height: Int, windowSize: CGSize) {
        self.sessionId = sessionId
        self.targetId = targetId
        self.seq = seq
        self.jpeg = jpeg
        self.width = width
        self.height = height
        self.windowSize = windowSize
    }
}

/// The agent cursor in a bound window. Points are WINDOW-RELATIVE points; `kind` is the helper's cursor
/// vocabulary (`move`, `press`, `type`, `scroll`, `drag`, …) and is passed through as the wire spells it.
public struct HelperCursor: Equatable, Sendable {
    public let sessionId: String
    public let targetId: String
    public let kind: String
    public let point: CGPoint
    public let dragTo: CGPoint?
    /// The element's frame (`[x, y, w, h]`, window-relative) when the action is on one.
    public let frame: CGRect?
    public let text: String?
    public let count: Int?
    public let button: String?

    public init(sessionId: String, targetId: String, kind: String, point: CGPoint, dragTo: CGPoint? = nil,
                frame: CGRect? = nil, text: String? = nil, count: Int? = nil, button: String? = nil) {
        self.sessionId = sessionId
        self.targetId = targetId
        self.kind = kind
        self.point = point
        self.dragTo = dragTo
        self.frame = frame
        self.text = text
        self.count = count
        self.button = button
    }
}

/// What the helper tells a subscriber, in arrival order.
public enum HelperViewEvent: Equatable, Sendable {
    case bound(sessionId: String, target: HelperTarget)
    case released(sessionId: String, targetId: String)
    case frame(HelperFrame)
    case cursor(HelperCursor)
    /// The connection to the helper ended (it quit, or the socket closed). Every subscription is gone
    /// with it; the owner reconnects and subscribes again.
    case connectionLost
}

/// The helper protocol Winter.app speaks: `apple/ComputerUse/PROTOCOL.md`'s "Protocol version", the helper's
/// `RPCWire.protocolVersion` and the daemon's `HELPER_PROTOCOL` (a repo test keeps all of them equal). WinterKit
/// never links the helper's packages, so the number is stated here.
public enum ComputerUseHelperProtocol {
    public static let version = 1

    /// The ONE sentence for a mismatch — the daemon's `helperProtocolMismatchMessage` word for word.
    public static func mismatchMessage(helperProtocol: Int?, clientProtocol: Int = version) -> String {
        guard let helperProtocol else {
            return "Winter Computer Use speaks a different helper protocol than this Winter (\(clientProtocol)) — update Winter"
        }
        let side = helperProtocol < clientProtocol ? "too old" : "too new"
        return "Winter Computer Use is \(side) for this Winter (it speaks helper protocol \(helperProtocol), Winter speaks \(clientProtocol)) — update Winter"
    }
}

/// Why a helper call failed. `protocolMismatch` and `homeMismatch` are final — retrying cannot fix
/// either; `socketMissing` means the helper is not running, which is not an error and must never launch
/// it (the daemon owns that). `protocolMismatch` carries the helper's protocol (nil when it did not say) and
/// ours; its `description` is the sentence to show.
public enum HelperClientError: Error, Equatable, Sendable, CustomStringConvertible {
    case socketMissing
    case protocolMismatch(helper: Int?, client: Int)
    case homeMismatch
    case notAllowed(String)
    case notConnected
    case rpc(code: Int, message: String)

    /// A failure no retry can change.
    public var isTerminal: Bool {
        switch self {
        case .protocolMismatch, .homeMismatch: return true
        default: return false
        }
    }

    public var description: String {
        switch self {
        case .socketMissing: return "Winter Computer Use is not running"
        case .protocolMismatch(let helper, let client):
            return ComputerUseHelperProtocol.mismatchMessage(helperProtocol: helper, clientProtocol: client)
        case .homeMismatch: return "Winter Computer Use serves a different Winter home"
        case .notAllowed(let message): return "not allowed: \(message)"
        case .notConnected: return "not connected to Winter Computer Use"
        case .rpc(let code, let message): return "helper error \(code): \(message)"
        }
    }
}

public protocol ComputerUseHelperClient: AnyObject, Sendable {
    /// The helper's notifications, plus `.connectionLost`. One stream for the client's whole life.
    var events: AsyncStream<HelperViewEvent> { get }
    /// Opens the socket and authenticates (`hello`). Throws `.socketMissing` — without trying to start
    /// anything — when there is no socket.
    func connect() async throws
    /// Subscribes to `sessionId`'s views. `frames: false` still delivers `bound`/`released`/`cursor`.
    /// Returns the targets the session has bound right now, in the helper's order.
    func subscribe(sessionId: String, frames: Bool, maxFps: Int?, maxWidth: Int?) async throws -> [HelperTarget]
    func unsubscribe(sessionId: String) async throws
    /// Ends the connection. Quiet: no `.connectionLost` for a deliberate close.
    func disconnect() async
}

public extension ComputerUseHelperClient {
    func subscribe(sessionId: String, frames: Bool) async throws -> [HelperTarget] {
        try await subscribe(sessionId: sessionId, frames: frames, maxFps: nil, maxWidth: nil)
    }
}

/// The helper's socket under a Winter home.
public enum HelperPaths {
    public static func socketPath(home: String) -> String { home + "/run/computer-use.sock" }
}

/// The production implementation, over a `WinterTransport` (a Unix socket in the app, a scripted
/// transport in tests).
public actor LiveComputerUseHelperClient: ComputerUseHelperClient {
    public nonisolated let events: AsyncStream<HelperViewEvent>
    /// Where events wait for the consumer. Frames coalesce here: a consumer that is behind sees the
    /// newest frame of a target, never a queue of stale ones.
    private let mailbox = HelperEventMailbox()

    private let home: String
    private let socketPath: String
    private let socketExists: @Sendable (String) -> Bool
    private let makeTransport: @Sendable (String) -> WinterTransport
    private let requestTimeout: Duration
    /// How a request's timeout passes (see `WinterClient`, which also says why `init` takes it as an optional): real
    /// time in production, a clock the test releases by hand in a test.
    private let sleep: @Sendable (Duration) async throws -> Void

    private var transport: WinterTransport?
    private var pump: Task<Void, Never>?
    private let decoder = LineDecoder(maxLine: 16 * 1024 * 1024)
    /// Frame lines received / decoded (JSON-parsed and base64-decoded) — a frame that a newer one in the same
    /// read superseded is received and never decoded. Read by the benchmark.
    public private(set) var framesReceived = 0
    public private(set) var framesDecoded = 0
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var deliberate = false

    public init(home: String,
                socketExists: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
                makeTransport: @escaping @Sendable (String) -> WinterTransport = { UnixSocketTransport(path: $0) },
                requestTimeout: Duration = .seconds(5),
                sleep: (@Sendable (Duration) async throws -> Void)? = nil) {
        let box = mailbox
        events = AsyncStream<HelperViewEvent>(unfolding: { await box.next() })
        self.home = home
        self.socketPath = HelperPaths.socketPath(home: home)
        self.socketExists = socketExists
        self.makeTransport = makeTransport
        self.requestTimeout = requestTimeout
        self.sleep = sleep ?? { duration in try await Task.sleep(for: duration) }
    }

    // MARK: - Connection

    public func connect() async throws {
        guard socketExists(socketPath) else { throw HelperClientError.socketMissing }
        await disconnect()
        deliberate = false
        let t = makeTransport(socketPath)
        do {
            try await t.open()
        } catch {
            t.close()
            // A socket file with nothing behind it (the helper quit and left it) is the same answer.
            throw HelperClientError.socketMissing
        }
        transport = t
        pump = Task { [weak self] in
            for await event in t.incoming {
                guard let self else { return }
                await self.handle(event)
            }
        }
        let hello: JSONValue
        do {
            hello = try await request("hello", params: ["protocol": .number(Double(ComputerUseHelperProtocol.version)),
                                                        "client": .string("app"), "home": .string(home)])
        } catch {
            await disconnect()
            throw error
        }
        // A helper that accepted but answers another number is no more usable than one that refused ours.
        if let theirs = hello["protocol"]?.intValue, theirs != ComputerUseHelperProtocol.version {
            await disconnect()
            throw HelperClientError.protocolMismatch(helper: theirs, client: ComputerUseHelperProtocol.version)
        }
    }

    public func disconnect() async {
        deliberate = true
        pump?.cancel()
        pump = nil
        failAllPending(HelperClientError.notConnected)
        transport?.close()
        transport = nil
    }

    // MARK: - Calls

    public func subscribe(sessionId: String, frames: Bool, maxFps: Int?, maxWidth: Int?) async throws -> [HelperTarget] {
        var params: [String: JSONValue] = ["sessionId": .string(sessionId), "frames": .bool(frames)]
        if let maxFps { params["maxFps"] = .number(Double(maxFps)) }
        if let maxWidth { params["maxWidth"] = .number(Double(maxWidth)) }
        let result = try await request("view.subscribe", params: params)
        return (result["targets"]?.arrayValue ?? []).compactMap { Self.target(from: $0) }
    }

    public func unsubscribe(sessionId: String) async throws {
        _ = try await request("view.unsubscribe", params: ["sessionId": .string(sessionId)])
    }

    private func request(_ method: String, params: [String: JSONValue]) async throws -> JSONValue {
        guard let t = transport else { throw HelperClientError.notConnected }
        let id = nextId
        nextId += 1
        let line = try JSONEncoder().encode(JSONValue.object([
            "jsonrpc": .string("2.0"), "id": .number(Double(id)), "method": .string(method), "params": .object(params),
        ])) + Data([0x0a])
        let timeout = requestTimeout
        let sleep = self.sleep
        let watchdog = Task { [weak self] in
            try? await sleep(timeout)
            await self?.timeOut(id: id)
        }
        defer { watchdog.cancel() }
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            Task {
                do { try await t.send(line) } catch { self.sendFailed(id: id) }
            }
        }
    }

    private func timeOut(id: Int) {
        pending.removeValue(forKey: id)?.resume(throwing: HelperClientError.rpc(code: -2, message: "request timed out"))
    }

    private func sendFailed(id: Int) {
        pending.removeValue(forKey: id)?.resume(throwing: HelperClientError.notConnected)
    }

    private func failAllPending(_ error: Error) {
        let waiting = pending
        pending = [:]
        for (_, cont) in waiting { cont.resume(throwing: error) }
    }

    // MARK: - Incoming

    private func handle(_ event: TransportEvent) {
        switch event {
        case .data(let chunk):
            guard let lines = try? decoder.pushData(chunk) else {
                transport?.close() // an oversized line: a broken or hostile peer
                return
            }
            let superseded = Self.supersededFrameLines(lines)
            for (index, line) in lines.enumerated() {
                if superseded.contains(index) { framesReceived += 1; continue }
                route(line)
            }
        case .closed:
            failAllPending(HelperClientError.notConnected)
            transport = nil
            if !deliberate { mailbox.push(.connectionLost) }
        }
    }

    /// Parsed with Foundation's `JSONSerialization`. (Measured against the generic `Codable` tree on an 80 KB
    /// frame line — one big string and a few small values — the two cost about the same, ~0.1 ms; the
    /// time that mattered was in the line splitter, not here. This runs on the client actor, never the
    /// main actor, and a frame a newer one supersedes is not parsed at all.)
    private func route(_ line: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
        if let id = (object["id"] as? NSNumber)?.intValue {
            guard let cont = pending.removeValue(forKey: id) else { return }
            if let error = object["error"] {
                cont.resume(throwing: Self.error(from: Self.jsonValue(error)))
            } else {
                cont.resume(returning: object["result"].map(Self.jsonValue) ?? .object([:]))
            }
            return
        }
        guard let method = object["method"] as? String, let params = object["params"] as? [String: Any] else { return }
        if method == "view.frame" { framesReceived += 1 }
        if let event = Self.event(method: method, params: params) {
            if case .frame = event { framesDecoded += 1 }
            mailbox.push(event)
        }
    }

    // MARK: - Superseded frames

    /// The indexes of frame lines in one read that a LATER frame line for the same session and target
    /// replaces. A consumer that is behind would only ever see the newest, so the older are never even
    /// parsed. Found with `memmem` on the raw bytes — no JSON is read to decide.
    static func supersededFrameLines(_ lines: [Data]) -> Set<Int> {
        guard lines.count > 1 else { return [] }
        var seen: Set<String> = []
        var superseded: Set<Int> = []
        for index in lines.indices.reversed() {
            guard let key = frameKey(lines[index]) else { continue }
            if !seen.insert(key).inserted { superseded.insert(index) }
        }
        return superseded
    }

    /// `"<sessionId>|<targetId>"` of a `view.frame` line, or nil for any other line.
    static func frameKey(_ line: Data) -> String? {
        line.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> String? in
            guard let base = raw.baseAddress, find(base, raw.count, "\"view.frame\"") != nil,
                  let session = stringValue(after: "\"sessionId\":\"", in: base, count: raw.count),
                  let target = stringValue(after: "\"targetId\":\"", in: base, count: raw.count) else { return nil }
            return session + "|" + target
        }
    }

    private static func find(_ base: UnsafeRawPointer, _ count: Int, _ needle: String) -> UnsafeRawPointer? {
        needle.withCString { cstring in
            let length = strlen(cstring)
            return memmem(base, count, cstring, length).map { UnsafeRawPointer($0) }
        }
    }

    private static func stringValue(after needle: String, in base: UnsafeRawPointer, count: Int) -> String? {
        guard let hit = find(base, count, needle) else { return nil }
        let start = hit + needle.utf8.count
        let remaining = count - (start - base)
        guard remaining > 0, let quote = memchr(start, 0x22, remaining) else { return nil }
        return String(decoding: UnsafeRawBufferPointer(start: start, count: UnsafeRawPointer(quote) - start), as: UTF8.self)
    }

    // MARK: - JSONSerialization → JSONValue (responses only; they are small)

    static func jsonValue(_ any: Any) -> JSONValue {
        switch any {
        case let number as NSNumber:
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
        case let string as String: return .string(string)
        case let array as [Any]: return .array(array.map(jsonValue))
        case let object as [String: Any]: return .object(object.mapValues(jsonValue))
        default: return .null
        }
    }

    // MARK: - Decoding (pure)

    static func error(from error: JSONValue) -> HelperClientError {
        let message = error["message"]?.stringValue ?? "helper error"
        switch error["data"]?["code"]?.stringValue {
        // `data.expected` is the helper's own number (absent: it could not read our hello at all).
        case "protocol_mismatch":
            return .protocolMismatch(helper: error["data"]?["expected"]?.intValue, client: ComputerUseHelperProtocol.version)
        case "home_mismatch": return .homeMismatch
        case "not_allowed": return .notAllowed(message)
        default: return .rpc(code: error["code"]?.intValue ?? -1, message: message)
        }
    }

    static func target(from v: JSONValue) -> HelperTarget? {
        guard let targetId = v["targetId"]?.stringValue else { return nil }
        // A window on another Space or display may report no size at all: still a target, of size zero.
        let size = sizeValue(json: v["windowSize"]) ?? .zero
        return HelperTarget(targetId: targetId, pid: v["pid"]?.intValue ?? 0, windowId: v["windowId"]?.intValue ?? 0,
                            appName: v["appName"]?.stringValue ?? "", bundleId: v["bundleId"]?.stringValue ?? "", windowSize: size)
    }

    static func event(method: String, params p: [String: Any]) -> HelperViewEvent? {
        guard let sessionId = p["sessionId"] as? String else { return nil }
        func int(_ key: String) -> Int? { (p[key] as? NSNumber)?.intValue }
        switch method {
        case "view.bound":
            guard let targetId = p["targetId"] as? String else { return nil }
            let size = sizeValue(p["windowSize"]) ?? .zero
            return .bound(sessionId: sessionId, target: HelperTarget(
                targetId: targetId, pid: int("pid") ?? 0, windowId: int("windowId") ?? 0,
                appName: p["appName"] as? String ?? "", bundleId: p["bundleId"] as? String ?? "", windowSize: size))
        case "view.released":
            return (p["targetId"] as? String).map { .released(sessionId: sessionId, targetId: $0) }
        case "view.frame":
            guard let targetId = p["targetId"] as? String, let b64 = p["jpeg"] as? String,
                  let jpeg = Data(base64Encoded: b64) else { return nil }
            return .frame(HelperFrame(sessionId: sessionId, targetId: targetId, seq: int("seq") ?? 0, jpeg: jpeg,
                                      width: int("width") ?? 0, height: int("height") ?? 0,
                                      windowSize: sizeValue(p["windowSize"]) ?? .zero))
        case "view.cursor":
            guard let targetId = p["targetId"] as? String, let kind = p["kind"] as? String, let point = pointValue(p["point"]) else { return nil }
            return .cursor(HelperCursor(sessionId: sessionId, targetId: targetId, kind: kind, point: point,
                                        dragTo: pointValue(p["dragTo"]), frame: rectValue(p["frame"]), text: p["text"] as? String,
                                        count: int("count"), button: p["button"] as? String))
        default:
            return nil
        }
    }

    private static func numbers(_ v: Any?, count: Int) -> [Double]? {
        guard let items = v as? [Any], items.count == count else { return nil }
        let values = items.compactMap { ($0 as? NSNumber).map { $0.doubleValue } }
        return values.count == count ? values : nil
    }

    /// A `[w, h]` out of a decoded JSON response.
    static func sizeValue(json v: JSONValue?) -> CGSize? {
        guard let items = v?.arrayValue, items.count == 2,
              case .number(let w) = items[0], case .number(let h) = items[1] else { return nil }
        return CGSize(width: w, height: h)
    }

    static func sizeValue(_ v: Any?) -> CGSize? { numbers(v, count: 2).map { CGSize(width: $0[0], height: $0[1]) } }
    static func pointValue(_ v: Any?) -> CGPoint? { numbers(v, count: 2).map { CGPoint(x: $0[0], y: $0[1]) } }
    static func rectValue(_ v: Any?) -> CGRect? { numbers(v, count: 4).map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) } }
}

/// Holds the helper's notifications until the consumer takes them, one at a time. A frame replaces an
/// older, not-yet-taken frame of the same session and target — the consumer is behind or busy, and the
/// newest picture is the only one worth drawing. Every other event keeps its place.
final class HelperEventMailbox: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [HelperViewEvent] = []
    private var waiter: CheckedContinuation<HelperViewEvent?, Never>?

    func push(_ event: HelperViewEvent) {
        lock.lock()
        if let waiter {
            self.waiter = nil
            lock.unlock()
            waiter.resume(returning: event)
            return
        }
        if case .frame(let new) = event,
           let index = queue.lastIndex(where: { if case .frame(let old) = $0 { return old.sessionId == new.sessionId && old.targetId == new.targetId }; return false }) {
            queue[index] = event
        } else {
            queue.append(event)
        }
        lock.unlock()
    }

    func next() async -> HelperViewEvent? {
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<HelperViewEvent?, Never>) in
                lock.lock()
                if !queue.isEmpty {
                    let event = queue.removeFirst()
                    lock.unlock()
                    continuation.resume(returning: event)
                } else if Task.isCancelled {
                    lock.unlock()
                    continuation.resume(returning: nil)
                } else {
                    waiter = continuation
                    lock.unlock()
                }
            }
        } onCancel: {
            lock.lock()
            let cancelled = waiter
            waiter = nil
            lock.unlock()
            cancelled?.resume(returning: nil)
        }
    }

    /// Events waiting for the consumer (tests).
    var pendingCount: Int { lock.lock(); defer { lock.unlock() }; return queue.count }
}
