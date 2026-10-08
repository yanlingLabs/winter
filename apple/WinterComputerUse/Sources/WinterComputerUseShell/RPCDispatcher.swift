import Foundation
import WinterCUCore

/// Routes every method after `hello`. Engine methods decode `params` straight into the engine's own
/// `<Name>Params` and encode its `<Name>Result` straight back; the shell answers `script.active` itself, and
/// forwards `turn.ended` / `session.ended` / `cancel` to both the engine and its own state.
public final class RPCDispatcher: @unchecked Sendable {
    public typealias Handler = (JSONValue?) async throws -> AnyEncodable

    private let core: CoreService
    private let coordinator: HelperCoordinator
    private let inFlight: InFlightRegistry
    private var routes: [String: Handler] = [:]

    public init(core: CoreService, coordinator: HelperCoordinator, inFlight: InFlightRegistry) {
        self.core = core
        self.coordinator = coordinator
        self.inFlight = inFlight
        buildRoutes()
    }

    /// Every method this dispatcher answers (`hello` is the connection's own).
    public var methods: [String] { routes.keys.sorted() }

    public func handle(method: String, params: JSONValue?) async throws -> AnyEncodable {
        guard let route = routes[method] else { throw RPCError.unsupported("unknown method \(method)") }
        return try await route(params)
    }

    /// `params` (absent = `{}`) decoded as `P`.
    static func decode<P: Decodable>(_ type: P.Type, _ params: JSONValue?) throws -> P {
        try (params ?? .object([:])).decode(P.self)
    }

    private func engine<P: Decodable, R: Encodable>(_ method: String, _ call: @escaping (CoreService, P) async throws -> R) {
        routes[method] = { [core] params in
            let decoded = try RPCDispatcher.decode(P.self, params)
            return AnyEncodable(try await call(core, decoded))
        }
    }

    private func buildRoutes() {
        // The engine owns the grants too: `status` reads them (never prompting) with the helper's version, and
        // `permissions.request` raises the system prompt or opens the Privacy pane.
        engine("status") { try await $0.status($1 as StatusParams) }
        engine("permissions.request") { try await $0.permissionsRequest($1 as PermissionsRequestParams) }
        engine("apps.list") { try await $0.appsList($1 as AppsListParams) }
        engine("screen.windows") { try await $0.screenWindows($1 as ScreenWindowsParams) }
        engine("target.bind") { try await $0.targetBind($1 as TargetBindParams) }
        engine("target.useWindow") { try await $0.targetUseWindow($1 as TargetUseWindowParams) }
        engine("target.windows") { try await $0.targetWindows($1 as TargetWindowsParams) }
        engine("target.release") { try await $0.targetRelease($1 as TargetReleaseParams) }
        engine("target.snapshot") { try await $0.targetSnapshot($1 as TargetSnapshotParams) }
        engine("target.find") { try await $0.targetFind($1 as TargetFindParams) }
        engine("target.screenshot") { try await $0.targetScreenshot($1 as TargetScreenshotParams) }
        engine("target.act") { try await $0.targetAct($1 as TargetActParams) }
        engine("target.waitIdle") { try await $0.targetWaitIdle($1 as TargetWaitIdleParams) }
        engine("target.waitFor") { try await $0.targetWaitFor($1 as TargetWaitForParams) }
        engine("screen.screenshot") { try await $0.screenScreenshot($1 as ScreenScreenshotParams) }
        engine("screen.appAt") { try await $0.screenAppAt($1 as ScreenAppAtParams) }

        routes["script.active"] = { [coordinator] params in
            let p = try RPCDispatcher.decode(ScriptActiveParams.self, params)
            await coordinator.setScriptActive(sessionId: p.sessionId, active: p.active)
            return AnyEncodable(EmptyResult())
        }
        routes["turn.ended"] = { [core, coordinator] params in
            let p = try RPCDispatcher.decode(TurnEndedParams.self, params)
            await coordinator.turnEnded(sessionId: try RPCDispatcher.sessionId(params))
            return AnyEncodable(try await core.turnEnded(p))
        }
        routes["session.ended"] = { [core, coordinator] params in
            let p = try RPCDispatcher.decode(SessionEndedParams.self, params)
            let sessionId = try RPCDispatcher.sessionId(params)
            // The shell's half (mirrors closed, Esc disarmed, targets forgotten) happens even if the engine fails.
            let result: SessionEndedResult
            do {
                result = try await core.sessionEnded(p)
            } catch {
                await coordinator.sessionEnded(sessionId: sessionId)
                throw error
            }
            await coordinator.sessionEnded(sessionId: sessionId)
            return AnyEncodable(result)
        }
        routes["cancel"] = { [core, inFlight] params in
            let p = try RPCDispatcher.decode(CancelParams.self, params)
            guard let callId = params?["callId"]?.stringValue else { throw RPCError.invalidParams("params.callId is required") }
            // Stop the shell's own tasks first, then let the engine stop its work, then answer whatever is
            // still pending for that call `cancelled` — a request the engine finished first keeps its answer.
            let pending = inFlight.cancelTasks(callId: callId)
            let result: CancelResult
            do {
                result = try await core.cancel(p)
            } catch {
                pending.forEach { $0.answer(error: .cancelled()) }
                throw error
            }
            pending.forEach { $0.answer(error: .cancelled()) }
            return AnyEncodable(result)
        }
    }

    static func sessionId(_ params: JSONValue?) throws -> String {
        guard let id = params?["sessionId"]?.stringValue, !id.isEmpty else { throw RPCError.invalidParams("params.sessionId is required") }
        return id
    }
}

/// `script.active` — the shell's own method (the Esc tap's arming), so its params live here.
public struct ScriptActiveParams: Codable, Equatable, Sendable {
    public var sessionId: String
    public var active: Bool
}

/// One request awaiting its answer. Answering is idempotent: the first answer wins, so a request answered
/// `cancelled` never sends its late result too.
public final class PendingRequest: @unchecked Sendable {
    public let id: JSONValue
    public let callId: String?
    private let lock = NSLock()
    private var answered = false
    private var task: Task<Void, Never>?
    private let send: (Data) -> Void

    public init(id: JSONValue, callId: String?, send: @escaping (Data) -> Void) {
        self.id = id
        self.callId = callId
        self.send = send
    }

    func attach(_ task: Task<Void, Never>) {
        lock.lock(); self.task = task; lock.unlock()
    }

    var isAnswered: Bool {
        lock.lock(); defer { lock.unlock() }
        return answered
    }

    func cancelTask() {
        lock.lock(); let t = task; lock.unlock()
        t?.cancel()
    }

    /// Waits for the request's task to finish.
    func finished() async {
        let t = lock.withLock { task }
        await t?.value
    }

    private func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if answered { return false }
        answered = true
        return true
    }

    func answer(result: AnyEncodable) {
        guard claim() else { return }
        send(RPCOutbound.response(id: id, result: result))
    }

    func answer(error: RPCError) {
        guard claim() else { return }
        send(RPCOutbound.error(id: id, error))
    }
}

/// Every in-flight request across every connection, so `cancel {callId}` reaches a call whichever connection
/// carried it. Any request whose params carry a `callId` is cancellable (`target.act` always does).
public final class InFlightRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var byKey: [ObjectIdentifier: (connection: Int, request: PendingRequest)] = [:]

    public init() {}

    func add(_ request: PendingRequest, connection: Int) {
        lock.lock(); byKey[ObjectIdentifier(request)] = (connection, request); lock.unlock()
    }

    func remove(_ request: PendingRequest) {
        lock.lock(); byKey.removeValue(forKey: ObjectIdentifier(request)); lock.unlock()
    }

    public var isEmpty: Bool {
        lock.lock(); defer { lock.unlock() }
        return byKey.isEmpty
    }

    func count(connection: Int) -> Int {
        lock.lock(); defer { lock.unlock() }
        return byKey.values.filter { $0.connection == connection }.count
    }

    /// Cancels the shell tasks of every unanswered request for `callId` and returns them.
    func cancelTasks(callId: String) -> [PendingRequest] {
        lock.lock()
        let matching = byKey.values.map(\.request).filter { $0.callId == callId && !$0.isAnswered }
        lock.unlock()
        matching.forEach { $0.cancelTask() }
        return matching
    }

    /// The connection is gone: cancel its requests and return them (their answers go nowhere).
    func cancelAll(connection: Int) -> [PendingRequest] {
        lock.lock()
        let matching = byKey.values.filter { $0.connection == connection }.map(\.request)
        lock.unlock()
        matching.forEach { $0.cancelTask() }
        return matching
    }
}
