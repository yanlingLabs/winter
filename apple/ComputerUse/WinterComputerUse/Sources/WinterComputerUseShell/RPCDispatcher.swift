import Foundation
import WinterCUCore

/// Who is asking: the connection (Winter.app's view subscriptions are per connection) and its client kind.
public struct RequestContext: Sendable {
    public var connectionID: Int
    public var client: PeerClientKind

    public init(connectionID: Int, client: PeerClientKind) {
        self.connectionID = connectionID
        self.client = client
    }

    public static let daemon = RequestContext(connectionID: 0, client: .daemon)
}

/// Routes every method after `hello`. Engine methods decode `params` straight into the engine's own
/// `<Name>Params` and encode its `<Name>Result` straight back; the shell answers `script.active` and Winter.app's
/// `view.subscribe` / `view.unsubscribe` itself, and forwards `turn.ended` / `session.ended` / `cancel` to both
/// the engine and its own state. Which client may call what is the server's gate (`HelperServer.permits`).
public final class RPCDispatcher: @unchecked Sendable {
    public typealias Handler = (JSONValue?, RequestContext) async throws -> AnyEncodable

    private let core: CoreService
    private let coordinator: HelperCoordinator
    private let viewHub: ViewHub
    private let inFlight: InFlightRegistry
    private var routes: [String: Handler] = [:]

    /// `liveTest`: the helper is a live-test instance (`HelperIdentity.liveTest` — a dev helper serving a
    /// `winter-cu-live-` temp home, which accepts only the live suite's test identities). Only then does it answer the
    /// TEST-ONLY `test.activate` the suite uses to put its own "user's app" in front (`activator`).
    public init(core: CoreService, coordinator: HelperCoordinator, viewHub: ViewHub, inFlight: InFlightRegistry,
                liveTest: Bool = false, activator: (@Sendable (Int32) async -> TestActivateResult)? = nil,
                capturer: TestCapturing? = nil) {
        self.core = core
        self.coordinator = coordinator
        self.viewHub = viewHub
        self.inFlight = inFlight
        buildRoutes()
        if liveTest {
            let activate = activator ?? { pid in await MainActor.run { TestActivator.activate(pid: pid) } }
            routes["test.activate"] = { params, _ in
                let p = try RPCDispatcher.decode(TestActivateParams.self, params)
                return AnyEncodable(await activate(p.pid))
            }
            // The freshness measurement's captures (TestCapture.swift): a still through the helper's own off-Space
            // path, or the latest frame of a desktop-independent test stream.
            if let capturer {
                routes["test.capture"] = { params, _ in
                    AnyEncodable(try await capturer.capture(try RPCDispatcher.decode(TestCaptureParams.self, params)))
                }
                routes["test.stream"] = { params, _ in
                    AnyEncodable(try await capturer.stream(try RPCDispatcher.decode(TestStreamParams.self, params)))
                }
            }
        }
    }

    /// Every method this dispatcher answers (`hello` is the connection's own).
    public var methods: [String] { routes.keys.sorted() }

    public func handle(method: String, params: JSONValue?, context: RequestContext = .daemon) async throws -> AnyEncodable {
        guard let route = routes[method] else { throw RPCError.unsupported("unknown method \(method)") }
        return try await route(params, context)
    }

    /// `params` (absent = `{}`) decoded as `P`.
    static func decode<P: Decodable>(_ type: P.Type, _ params: JSONValue?) throws -> P {
        try (params ?? .object([:])).decode(P.self)
    }

    private func engine<P: Decodable, R: Encodable>(_ method: String, _ call: @escaping (CoreService, P) async throws -> R) {
        routes[method] = { [core] params, _ in
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
        engine("apps.openDocument") { try await $0.openDocuments($1 as OpenDocumentsParams) }
        engine("apps.defaultOpener") { try await $0.defaultOpener($1 as DefaultOpenerParams) }
        engine("screen.windows") { try await $0.screenWindows($1 as ScreenWindowsParams) }
        // Binding is where Winter.app's view of a session comes from: the result names the target id, bundle id
        // and window that the engine's `targetBound` event does not.
        engine("target.bind") { [viewHub] (core: CoreService, p: TargetBindParams) in
            let r = try await core.targetBind(p)
            await viewHub.bound(ViewTarget(sessionId: p.sessionId, targetId: r.targetId, pid: r.app.pid, windowId: r.window.id,
                                           appName: r.app.name, bundleId: r.app.bundleId, windowFrame: ViewTarget.rect(r.window.frame),
                                           mirror: p.mirror, privatePath: p.privatePath ?? true))
            return r
        }
        engine("target.useWindow") { [viewHub] (core: CoreService, p: TargetUseWindowParams) in
            let r = try await core.targetUseWindow(p)
            await viewHub.windowChanged(targetId: p.targetId, windowId: r.window.id, windowFrame: ViewTarget.rect(r.window.frame))
            return r
        }
        engine("target.windows") { try await $0.targetWindows($1 as TargetWindowsParams) }
        engine("target.release") { [viewHub] (core: CoreService, p: TargetReleaseParams) in
            let r = try await core.targetRelease(p)
            await viewHub.release(targetId: p.targetId, reason: "target.release from the daemon")
            return r
        }
        engine("target.snapshot") { try await $0.targetSnapshot($1 as TargetSnapshotParams) }
        engine("target.find") { try await $0.targetFind($1 as TargetFindParams) }
        engine("target.screenshot") { try await $0.targetScreenshot($1 as TargetScreenshotParams) }
        engine("target.act") { try await $0.targetAct($1 as TargetActParams) }
        engine("target.foreground") { try await $0.targetForeground($1 as TargetForegroundParams) }
        engine("target.waitIdle") { try await $0.targetWaitIdle($1 as TargetWaitIdleParams) }
        engine("target.waitFor") { try await $0.targetWaitFor($1 as TargetWaitForParams) }
        engine("target.applescript") { try await $0.targetAppleScript($1 as TargetAppleScriptParams) }
        engine("target.scriptingDictionary") { try await $0.targetScriptingDictionary($1 as TargetScriptingDictionaryParams) }
        engine("screen.screenshot") { try await $0.screenScreenshot($1 as ScreenScreenshotParams) }
        engine("screen.appAt") { try await $0.screenAppAt($1 as ScreenAppAtParams) }
        engine("visit.close") { try await $0.visitClose($1 as VisitCloseParams) }

        routes["script.active"] = { [core, coordinator] params, _ in
            let p = try RPCDispatcher.decode(ScriptActiveParams.self, params)
            await coordinator.setScriptActive(sessionId: p.sessionId, active: p.active)
            core.scriptActivity(sessionId: p.sessionId, active: p.active)
            return AnyEncodable(EmptyResult())
        }
        // The desktop-switch prompt (a long request: it answers when the user clicks, or `expired`); `cancel
        // {callId}` — the prompt's own id — closes it.
        routes["prompt.desktopVisit"] = { [coordinator] params, _ in
            let p = try RPCDispatcher.decode(PromptDesktopVisitParams.self, params)
            try p.validate()
            let answer = try await coordinator.askDesktopVisit(p)
            return AnyEncodable(PromptDesktopVisitResult(answer: answer.rawValue))
        }
        routes["turn.ended"] = { [core, coordinator] params, _ in
            let p = try RPCDispatcher.decode(TurnEndedParams.self, params)
            await coordinator.turnEnded(sessionId: try RPCDispatcher.sessionId(params))
            return AnyEncodable(try await core.turnEnded(p))
        }
        routes["session.ended"] = { [core, coordinator] params, _ in
            let p = try RPCDispatcher.decode(SessionEndedParams.self, params)
            let sessionId = try RPCDispatcher.sessionId(params)
            core.scriptActivity(sessionId: sessionId, active: false)  // an ended session runs no script
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
        routes["view.subscribe"] = { [viewHub] params, context in
            let p = try RPCDispatcher.decode(ViewSubscribeParams.self, params)
            let targets = await viewHub.subscribe(connection: context.connectionID, p)
            return AnyEncodable(JSONValue.object(["targets": .array(targets.map { .object($0.wire) })]))
        }
        routes["view.unsubscribe"] = { [viewHub] params, context in
            let p = try RPCDispatcher.decode(ViewUnsubscribeParams.self, params)
            await viewHub.unsubscribe(connection: context.connectionID, sessionId: p.sessionId)
            return AnyEncodable(EmptyResult())
        }
        routes["cancel"] = { [core, inFlight] params, _ in
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

/// `prompt.desktopVisit` — the shell's own method (the desktop-switch prompt is drawn by the presentation layer).
/// `callId` equals `promptId`: it is what the daemon's `cancel` names.
public struct PromptDesktopVisitParams: Codable, Equatable, Sendable {
    public var promptId: String
    public var callId: String
    public var sessionId: String
    public var app: String
    public var bundleId: String
    public var reason: String
    /// The fallback countdown when there is no `expiresAt`.
    public var timeoutMs: Int?
    /// The session card's own deadline (epoch ms): the panel's countdown runs to it.
    public var expiresAt: Int?

    public init(promptId: String, callId: String, sessionId: String, app: String, bundleId: String, reason: String,
                timeoutMs: Int? = nil, expiresAt: Int? = nil) {
        self.promptId = promptId
        self.callId = callId
        self.sessionId = sessionId
        self.app = app
        self.bundleId = bundleId
        self.reason = reason
        self.timeoutMs = timeoutMs
        self.expiresAt = expiresAt
    }

    func validate() throws {
        guard !promptId.isEmpty else { throw RPCError.invalidParams("params.promptId is required") }
        guard callId == promptId else { throw RPCError.invalidParams("params.callId must equal params.promptId") }
        guard !sessionId.isEmpty else { throw RPCError.invalidParams("params.sessionId is required") }
        guard expiresAt != nil || (timeoutMs ?? 0) > 0 else {
            throw RPCError.invalidParams("params.expiresAt or a positive params.timeoutMs is required")
        }
    }
}

/// `{answer: "switch" | "refuse" | "expired"}`.
public struct PromptDesktopVisitResult: Codable, Equatable, Sendable {
    public var answer: String
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
