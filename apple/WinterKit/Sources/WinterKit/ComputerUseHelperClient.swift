import CoreGraphics
import Foundation

// -----------------------------------------------------------------------------------------------
// ComputerV2 — Winter.app as a SECOND client of the Winter Computer Use helper: the live mirror of the
// app being controlled is rendered inside Winter's own windows from frames the helper captures and
// streams here (the helper keeps the Screen Recording grant; Winter.app never captures anything).
//
// The wire is the helper's socket (`<WINTER_HOME>/run/computer-use.sock`), NDJSON JSON-RPC, the same
// framing the daemon uses to talk to it. An app client authenticates with
// `hello {protocol: 1, client: "app", home}` and may call only `hello`, `view.subscribe`,
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

/// Why a helper call failed. `protocolMismatch` and `homeMismatch` are final — retrying cannot fix
/// either; `socketMissing` means the helper is not running, which is not an error and must never launch
/// it (the daemon owns that).
public enum HelperClientError: Error, Equatable, Sendable {
    case socketMissing
    case protocolMismatch
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
    private let eventsCont: AsyncStream<HelperViewEvent>.Continuation

    private let home: String
    private let socketPath: String
    private let socketExists: @Sendable (String) -> Bool
    private let makeTransport: @Sendable (String) -> WinterTransport
    private let requestTimeout: Duration

    private var transport: WinterTransport?
    private var pump: Task<Void, Never>?
    private let decoder = LineDecoder(maxLine: 16 * 1024 * 1024)
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var deliberate = false

    public init(home: String,
                socketExists: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
                makeTransport: @escaping @Sendable (String) -> WinterTransport = { UnixSocketTransport(path: $0) },
                requestTimeout: Duration = .seconds(5)) {
        var c: AsyncStream<HelperViewEvent>.Continuation!
        events = AsyncStream { c = $0 }
        eventsCont = c
        self.home = home
        self.socketPath = HelperPaths.socketPath(home: home)
        self.socketExists = socketExists
        self.makeTransport = makeTransport
        self.requestTimeout = requestTimeout
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
        do {
            _ = try await request("hello", params: ["protocol": .number(1), "client": .string("app"), "home": .string(home)])
        } catch {
            await disconnect()
            throw error
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
        let watchdog = Task { [weak self] in
            try? await Task.sleep(for: timeout)
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
            guard let lines = try? decoder.push(chunk) else {
                transport?.close() // an oversized line: a broken or hostile peer
                return
            }
            for line in lines { route(line) }
        case .closed:
            failAllPending(HelperClientError.notConnected)
            transport = nil
            if !deliberate { eventsCont.yield(.connectionLost) }
        }
    }

    private func route(_ line: String) {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)) else { return }
        if let id = value["id"]?.intValue {
            guard let cont = pending.removeValue(forKey: id) else { return }
            if let error = value["error"] {
                cont.resume(throwing: Self.error(from: error))
            } else {
                cont.resume(returning: value["result"] ?? .object([:]))
            }
            return
        }
        guard let method = value["method"]?.stringValue, let params = value["params"] else { return }
        if let event = Self.event(method: method, params: params) { eventsCont.yield(event) }
    }

    // MARK: - Decoding (pure)

    static func error(from error: JSONValue) -> HelperClientError {
        let message = error["message"]?.stringValue ?? "helper error"
        switch error["data"]?["code"]?.stringValue {
        case "protocol_mismatch": return .protocolMismatch
        case "home_mismatch": return .homeMismatch
        case "not_allowed": return .notAllowed(message)
        default: return .rpc(code: error["code"]?.intValue ?? -1, message: message)
        }
    }

    static func target(from v: JSONValue) -> HelperTarget? {
        guard let targetId = v["targetId"]?.stringValue, let size = sizeValue(v["windowSize"]) else { return nil }
        return HelperTarget(targetId: targetId, pid: v["pid"]?.intValue ?? 0, windowId: v["windowId"]?.intValue ?? 0,
                            appName: v["appName"]?.stringValue ?? "", bundleId: v["bundleId"]?.stringValue ?? "", windowSize: size)
    }

    static func event(method: String, params p: JSONValue) -> HelperViewEvent? {
        guard let sessionId = p["sessionId"]?.stringValue else { return nil }
        switch method {
        case "view.bound":
            return target(from: p).map { .bound(sessionId: sessionId, target: $0) }
        case "view.released":
            return p["targetId"]?.stringValue.map { .released(sessionId: sessionId, targetId: $0) }
        case "view.frame":
            guard let targetId = p["targetId"]?.stringValue, let b64 = p["jpeg"]?.stringValue,
                  let jpeg = Data(base64Encoded: b64), let size = sizeValue(p["windowSize"]) else { return nil }
            return .frame(HelperFrame(sessionId: sessionId, targetId: targetId, seq: p["seq"]?.intValue ?? 0, jpeg: jpeg,
                                      width: p["width"]?.intValue ?? 0, height: p["height"]?.intValue ?? 0, windowSize: size))
        case "view.cursor":
            guard let targetId = p["targetId"]?.stringValue, let kind = p["kind"]?.stringValue, let point = pointValue(p["point"]) else { return nil }
            return .cursor(HelperCursor(sessionId: sessionId, targetId: targetId, kind: kind, point: point,
                                        dragTo: pointValue(p["dragTo"]), frame: rectValue(p["frame"]), text: p["text"]?.stringValue,
                                        count: p["count"]?.intValue, button: p["button"]?.stringValue))
        default:
            return nil
        }
    }

    private static func numbers(_ v: JSONValue?, count: Int) -> [Double]? {
        guard let items = v?.arrayValue, items.count == count else { return nil }
        let values = items.compactMap { item -> Double? in if case .number(let n) = item { return n }; return nil }
        return values.count == count ? values : nil
    }

    static func sizeValue(_ v: JSONValue?) -> CGSize? { numbers(v, count: 2).map { CGSize(width: $0[0], height: $0[1]) } }
    static func pointValue(_ v: JSONValue?) -> CGPoint? { numbers(v, count: 2).map { CGPoint(x: $0[0], y: $0[1]) } }
    static func rectValue(_ v: JSONValue?) -> CGRect? { numbers(v, count: 4).map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) } }
}
