import Foundation

// -----------------------------------------------------------------------------------------------
// The browser link's connection: one per Winter.app process, kept for the app's life, working with
// no window open. It owns everything about the WIRE — the handshake, the reconnects, the order things
// leave in, the event batches — and nothing about browsers: every command is handed, in arrival order,
// to a `BrowserLinkHandler` on the main actor (Winter.app's `BrowserLinkHost`), which answers through
// the `BrowserLinkReplier` it is given and reports events and gone tabs through `BrowserLinkOutput`.
// -----------------------------------------------------------------------------------------------

/// The app's executor. Every method runs on the main actor, where CEF lives.
@MainActor
public protocol BrowserLinkHandler: AnyObject {
    /// The link is up under `linkId`. Commands may follow at once.
    func browserLinkAttached(linkId: String)
    /// The link is gone — the connection dropped, or another attach replaced this one. Every
    /// automation hold the link took must be dropped; no answer for an earlier command will be read.
    func browserLinkLost()
    /// One command, in the order the daemon sent it. Called synchronously and in order, so a
    /// handler that hands each command to CEF before returning keeps the daemon's order (a mouse press
    /// before its release). Answer exactly once, now or later, through `reply`.
    func browserLinkCommand(_ command: BrowserLinkCommand, reply: BrowserLinkReplier)
}

/// The answer door for ONE command. A second answer is ignored, so a late completion racing a
/// failure can never answer a command twice.
public struct BrowserLinkReplier: Sendable {
    private let deliver: @Sendable (BrowserLinkReply) -> Void

    public init(_ deliver: @escaping @Sendable (BrowserLinkReply) -> Void) {
        let once = ReplyOnce()
        self.deliver = { reply in if once.claim() { deliver(reply) } }
    }

    public func callAsFunction(_ reply: BrowserLinkReply) { deliver(reply) }
}

/// What the app sends on its own: CDP events and tabs that went away. Calls are ordered with each
/// other and with replies exactly as they are made (one queue), and are dropped when no link is up.
public protocol BrowserLinkOutput: AnyObject, Sendable {
    /// One CDP event for the daemon. `params` is the event's JSON params as the browser wrote them;
    /// `stripNetworkParams` cuts them to `CDPAllowlist.networkEventParams` before they leave.
    func emitEvent(tabId: String, method: String, params: Data, cdpSessionId: String?, stripNetworkParams: Bool)
    func tabGone(tabId: String, reason: BrowserLinkProtocol.TabGoneReason)
}

public final class BrowserLinkClient: BrowserLinkOutput, @unchecked Sendable {
    public struct Configuration: Sendable {
        public var appVersion: String
        public var pid: Int32
        public var backoffInitial: Duration = BrowserLinkProtocol.reconnectBackoffInitial
        public var backoffMax: Duration = BrowserLinkProtocol.reconnectBackoffMax
        public var flushWindow: Duration = BrowserLinkProtocol.eventFlushWindow
        public var batchMax: Int = BrowserLinkProtocol.eventBatchMax
        /// Every wait the link makes. Injected so a test can run a reconnect without waiting a second.
        public var sleep: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
        public var log: @Sendable (String) -> Void = { _ in }

        public init(appVersion: String, pid: Int32) {
            self.appVersion = appVersion
            self.pid = pid
        }
    }

    /// Builds a fresh, unconnected `WinterClient` for one connection attempt. `refreshCredentials` is
    /// true when the previous attempt's `protocol.hello` was refused, so a factory that caches the
    /// harness token reads it again.
    public typealias ClientFactory = @Sendable (_ refreshCredentials: Bool) throws -> WinterClient

    private let configuration: Configuration
    private let makeClient: ClientFactory
    private let handlerBox: HandlerBox
    private let outbox = BrowserLinkOutbox()

    private let lock = NSLock()
    private var stopped = false
    private var activeClient: WinterClient?
    private var connection: (client: WinterClient, linkId: String)?
    private var runTask: Task<Void, Never>?
    private var drainTask: Task<Void, Never>?

    @MainActor
    public init(configuration: Configuration, makeClient: @escaping ClientFactory, handler: BrowserLinkHandler) {
        self.configuration = configuration
        self.makeClient = makeClient
        self.handlerBox = HandlerBox(handler)
    }

    /// The link that is up right now, if any.
    public var linkId: String? { lock.withLock { connection?.linkId } }

    /// Start connecting; reconnects on its own until `stop()`. Calling it twice does nothing.
    public func start() {
        lock.lock()
        guard runTask == nil, !stopped else { lock.unlock(); return }
        runTask = Task { [weak self] in await self?.runLoop() }
        drainTask = Task { [weak self] in await self?.drainLoop() }
        lock.unlock()
    }

    /// Close the link for good. The handler is told the link was lost if one was up.
    public func stop() {
        lock.lock()
        stopped = true
        let client = activeClient
        let tasks = [runTask, drainTask]
        lock.unlock()
        Task { await client?.close() }
        for task in tasks { task?.cancel() }
        outbox.close()
    }

    private var isStopped: Bool { lock.withLock { stopped } }

    // MARK: - BrowserLinkOutput

    public func emitEvent(tabId: String, method: String, params: Data, cdpSessionId: String?, stripNetworkParams: Bool) {
        guard let linkId else { return }
        outbox.push(.event(linkId: linkId,
                           event: .init(tabId: tabId, method: method, params: params, cdpSessionId: cdpSessionId,
                                        strip: stripNetworkParams),
                           at: ContinuousClock.now))
    }

    public func tabGone(tabId: String, reason: BrowserLinkProtocol.TabGoneReason) {
        guard let linkId else { return }
        outbox.push(.tabGone(linkId: linkId, tabId: tabId, reason: reason.rawValue))
    }

    private func replier(linkId: String, cmdId: String) -> BrowserLinkReplier {
        BrowserLinkReplier { [weak self] reply in
            self?.outbox.push(.result(linkId: linkId, cmdId: cmdId, reply: reply))
        }
    }

    // MARK: - The connection

    private enum SessionEnding: Sendable { case disconnected, replaced, stopped }

    private func runLoop() async {
        var backoff = configuration.backoffInitial
        var refreshCredentials = false
        var saidNoMethod = false
        func grow() { backoff = min(backoff * 2, configuration.backoffMax) }

        while !isStopped {
            let client: WinterClient
            do {
                client = try makeClient(refreshCredentials)
            } catch {
                configuration.log("browser link: no credentials yet (\(error)) — retrying")
                refreshCredentials = true
                await configuration.sleep(backoff)
                grow()
                continue
            }
            lock.withLock { activeClient = client }
            if isStopped { await client.close(); return }
            let watcher = ConnectionWatcher(client)

            do {
                try await client.connect()
                refreshCredentials = false
            } catch {
                if let rpc = error as? RpcError, rpc.code <= -32000 { refreshCredentials = true }
                await teardown(client, watcher)
                await configuration.sleep(backoff)
                grow()
                continue
            }

            // Asked for BEFORE the attach, so not one command sent the moment it answers is missed.
            let commands = client.notifications(method: BrowserLinkProtocol.Method.command)
            let detaches = client.notifications(method: BrowserLinkProtocol.Method.detached)

            let linkId: String
            do {
                let answer = try await client.request(BrowserLinkProtocol.Method.attach, params: .object([
                    "protocol": .number(Double(BrowserLinkProtocol.version)),
                    "appVersion": .string(configuration.appVersion),
                    "pid": .number(Double(configuration.pid)),
                ]))
                guard let id = answer["linkId"]?.stringValue, !id.isEmpty else {
                    throw RpcError(code: -3, message: "browserLink.attach answered no linkId")
                }
                if let spoken = answer["protocol"]?.intValue, spoken != BrowserLinkProtocol.version {
                    throw RpcError(code: -3, message: "browserLink.attach answered protocol \(spoken)",
                                   data: .object(["code": .string("protocol_mismatch")]))
                }
                linkId = id
            } catch {
                let rpc = error as? RpcError
                if rpc?.isMethodNotFound == true {
                    // An older daemon. Not an incident: a Release app routinely runs ahead of it.
                    if !saidNoMethod { configuration.log("browser link: this daemon has no browserLink — backing off") }
                    saidNoMethod = true
                } else if rpc?.data?["code"]?.stringValue == "protocol_mismatch" {
                    configuration.log("browser link: protocol mismatch (app speaks \(BrowserLinkProtocol.version)) — update Winter")
                    backoff = configuration.backoffMax
                } else {
                    configuration.log("browser link: attach failed (\(error))")
                }
                await teardown(client, watcher)
                await configuration.sleep(backoff)
                grow()
                continue
            }

            backoff = configuration.backoffInitial
            saidNoMethod = false
            lock.withLock { connection = (client, linkId) }
            configuration.log("browser link: attached (\(linkId))")
            await MainActor.run { handlerBox.handler?.browserLinkAttached(linkId: linkId) }

            let ending = await session(client: client, linkId: linkId, commands: commands, detaches: detaches,
                                       watcher: watcher)

            lock.withLock { if connection?.linkId == linkId { connection = nil } }
            await MainActor.run { handlerBox.handler?.browserLinkLost() }
            switch ending {
            case .replaced:
                // Another attach took the link (a second Winter on this home). Re-attaching now would
                // start an attach war that fails both sides' in-flight commands; this one yields until
                // its daemon connection drops — a daemon restart — and then competes again.
                configuration.log("browser link: replaced by another attach — idle until the daemon reconnects")
                await watcher.disconnected()
            case .disconnected:
                configuration.log("browser link: connection lost — reconnecting")
            case .stopped:
                break
            }
            await teardown(client, watcher)
            if !isStopped { await configuration.sleep(backoff); grow() }
        }
    }

    private func session(client: WinterClient, linkId: String, commands: AsyncStream<JSONValue>,
                         detaches: AsyncStream<JSONValue>, watcher: ConnectionWatcher) async -> SessionEnding {
        await withTaskGroup(of: SessionEnding.self) { group in
            group.addTask { [weak self] in
                for await params in commands {
                    guard let self, !self.isStopped else { return .stopped }
                    await self.handle(params, linkId: linkId)
                }
                return .disconnected
            }
            group.addTask {
                for await params in detaches where params["linkId"]?.stringValue == linkId {
                    return .replaced
                }
                return .disconnected
            }
            group.addTask {
                await watcher.disconnected()
                return .disconnected
            }
            let first = await group.next() ?? .disconnected
            group.cancelAll()
            return isStopped ? .stopped : first
        }
    }

    private func handle(_ params: JSONValue, linkId: String) async {
        switch BrowserLinkCommand.parse(params) {
        case .failure(let unreadable):
            configuration.log("browser link: unreadable command — \(unreadable.reason)")
            if let commandLink = unreadable.linkId, let cmdId = unreadable.cmdId, commandLink == linkId {
                outbox.push(.result(linkId: linkId, cmdId: cmdId,
                                    reply: .failure(code: .notAllowed, message: unreadable.reason)))
            }
        case .success(let command):
            guard command.linkId == linkId else { return }
            let reply = replier(linkId: linkId, cmdId: command.cmdId)
            await MainActor.run {
                if let handler = handlerBox.handler {
                    handler.browserLinkCommand(command, reply: reply)
                } else {
                    reply(.failure(code: .notLive, message: "Winter's built-in browser is not available"))
                }
            }
        }
    }

    private func teardown(_ client: WinterClient, _ watcher: ConnectionWatcher) async {
        lock.withLock { if activeClient === client { activeClient = nil } }
        await client.close()
        watcher.cancel()
    }

    // MARK: - The outbox: what leaves, in the order it was produced

    private var currentConnection: (client: WinterClient, linkId: String)? { lock.withLock { connection } }

    private func drainLoop() async {
        while !Task.isCancelled {
            guard let head = await outbox.waitForHead() else { return }
            if case .event = head {
                var batch = outbox.takeEvents(max: configuration.batchMax)
                guard let start = batch.first?.at else { continue }
                // Hold the batch open for more events — but never past the window, never past the
                // cap, and never once something that is NOT an event is queued behind it (a result
                // waits for nothing).
                while batch.count < configuration.batchMax, !outbox.headIsNonEvent {
                    let remaining = configuration.flushWindow - (ContinuousClock.now - start)
                    if remaining <= .zero { break }
                    let seen = outbox.pushCount
                    await outbox.waitForPush(after: seen, timeout: remaining, sleep: configuration.sleep)
                    if Task.isCancelled { return }
                    batch += outbox.takeEvents(max: configuration.batchMax - batch.count)
                }
                await send(events: batch)
            } else if let item = outbox.takeFirst() {
                await send(item)
            }
        }
    }

    private func send(events batch: [BrowserLinkOutbox.QueuedEvent]) async {
        guard let (client, linkId) = currentConnection else { return }
        let events: [JSONValue] = batch.compactMap { queued in
            guard queued.linkId == linkId else { return nil }
            let event = queued.event
            var params = (try? JSONDecoder().decode(JSONValue.self, from: event.params)) ?? .object([:])
            if case .object = params {} else { params = .object([:]) }
            if event.strip { params = CDPTabGate.strippedNetworkParams(params) }
            var entry: [String: JSONValue] = ["tabId": .string(event.tabId), "method": .string(event.method), "params": params]
            if let session = event.cdpSessionId { entry["cdpSessionId"] = .string(session) }
            return .object(entry)
        }
        guard !events.isEmpty else { return }
        await request(client, BrowserLinkProtocol.Method.events,
                      ["linkId": .string(linkId), "events": .array(events)])
    }

    private func send(_ item: BrowserLinkOutbox.Item) async {
        guard let (client, linkId) = currentConnection else { return }
        switch item {
        case .result(let itemLink, let cmdId, let reply):
            guard itemLink == linkId else { return }
            var params: [String: JSONValue] = ["linkId": .string(linkId), "cmdId": .string(cmdId)]
            switch Self.resolve(reply) {
            case .ok(let value):
                params["ok"] = .bool(true)
                params["result"] = value
            case .okRaw:
                break // resolve never returns it
            case .failure(let code, let message, let data):
                params["ok"] = .bool(false)
                var error: [String: JSONValue] = ["code": .string(code.rawValue), "message": .string(message)]
                if let data { error["data"] = data }
                params["error"] = .object(error)
            }
            await request(client, BrowserLinkProtocol.Method.result, params)
        case .tabGone(let itemLink, let tabId, let reason):
            guard itemLink == linkId else { return }
            await request(client, BrowserLinkProtocol.Method.tabGone,
                          ["linkId": .string(linkId), "tabId": .string(tabId), "reason": .string(reason)])
        case .event:
            break // events leave in batches, above
        }
    }

    /// `.okRaw` becomes `.ok` here, off the main thread — or a failure, when the payload would not fit
    /// in one line the daemon accepts, or is not JSON.
    static func resolve(_ reply: BrowserLinkReply) -> BrowserLinkReply {
        guard case .okRaw(let key, let json) = reply else { return reply }
        let bytes = json.utf8.count
        if bytes + BrowserLinkProtocol.resultEnvelopeAllowance > BrowserLinkProtocol.resultLineCap {
            return .failure(code: .cdpError,
                            message: "the browser's answer (\(bytes) bytes) is over the browser link's \(BrowserLinkProtocol.resultLineCap / (1024 * 1024)) MiB line cap",
                            data: .object(["cdpCode": .number(-32603), "cdpMessage": .string("result too large for the browser link")]))
        }
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) else {
            return .failure(code: .cdpError, message: "the browser's answer was not JSON",
                            data: .object(["cdpCode": .number(-32603), "cdpMessage": .string("unreadable result")]))
        }
        return .ok(.object([key: value]))
    }

    /// One request at a time, each answered before the next leaves — which is what keeps the daemon's
    /// view in the order things happened here. A failure is dropped: a closed connection is noticed by
    /// the session's own watcher, and nothing here is worth a retry.
    private func request(_ client: WinterClient, _ method: String, _ params: [String: JSONValue]) async {
        do {
            _ = try await client.request(method, params: .object(params))
        } catch {
            configuration.log("browser link: \(method) failed (\(error))")
        }
    }
}

// MARK: - Pieces

/// The handler, held weakly on the main actor where it lives.
@MainActor
private final class HandlerBox {
    weak var handler: BrowserLinkHandler?
    init(_ handler: BrowserLinkHandler) { self.handler = handler }
}

/// True for the first `claim()` only.
final class ReplyOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    func claim() -> Bool { lock.withLock { if claimed { return false }; claimed = true; return true } }
}

/// Consumes a client's event stream for the client's whole life (it is the stream's one consumer, so
/// nothing piles up unread) and says when the connection dropped.
private final class ConnectionWatcher: @unchecked Sendable {
    private let lock = NSLock()
    private var dropped = false
    private var waiters: [UInt64: CheckedContinuation<Void, Never>] = [:]
    private var cancelled: Set<UInt64> = []
    private var nextWaiter: UInt64 = 0
    private var task: Task<Void, Never>?

    init(_ client: WinterClient) {
        task = Task { [weak self] in
            for await event in client.events {
                if case .connection(.disconnected) = event { self?.markDropped() }
            }
            self?.markDropped()
        }
    }

    private func markDropped() {
        let woken: [CheckedContinuation<Void, Never>] = lock.withLock {
            dropped = true
            defer { waiters = [:] }
            return Array(waiters.values)
        }
        for waiter in woken { waiter.resume() }
    }

    /// Returns once the connection has dropped (or the client was closed) — or the waiting task is
    /// cancelled, which is how the session's task group ends this wait when something else ended it.
    func disconnected() async {
        let id: UInt64 = lock.withLock { nextWaiter &+= 1; return nextWaiter }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let now: Bool = lock.withLock {
                    if dropped || cancelled.contains(id) { return true }
                    waiters[id] = continuation
                    return false
                }
                if now { continuation.resume() }
            }
        } onCancel: {
            let waiter: CheckedContinuation<Void, Never>? = lock.withLock {
                cancelled.insert(id)
                return waiters.removeValue(forKey: id)
            }
            waiter?.resume()
        }
        lock.withLock { _ = cancelled.remove(id) }
    }

    func cancel() {
        task?.cancel()
        markDropped()
    }
}

/// The one queue everything the app sends goes through, in the order it was produced.
final class BrowserLinkOutbox: @unchecked Sendable {
    struct PendingEvent: Sendable {
        let tabId: String
        let method: String
        let params: Data
        let cdpSessionId: String?
        let strip: Bool
    }

    struct QueuedEvent: Sendable {
        let linkId: String
        let event: PendingEvent
        let at: ContinuousClock.Instant
    }

    enum Item: Sendable {
        case result(linkId: String, cmdId: String, reply: BrowserLinkReply)
        case event(linkId: String, event: PendingEvent, at: ContinuousClock.Instant)
        case tabGone(linkId: String, tabId: String, reason: String)
    }

    private let lock = NSLock()
    private var items: [Item] = []
    private var head = 0
    private var pushes: UInt64 = 0
    private var closed = false
    private var waiter: (generation: UInt64, continuation: CheckedContinuation<Void, Never>)?
    private var generation: UInt64 = 0

    func push(_ item: Item) {
        let woken: CheckedContinuation<Void, Never>? = lock.withLock {
            guard !closed else { return nil }
            items.append(item)
            pushes &+= 1
            defer { waiter = nil }
            return waiter?.continuation
        }
        woken?.resume()
    }

    func close() {
        let woken: CheckedContinuation<Void, Never>? = lock.withLock {
            closed = true
            items = []
            head = 0
            defer { waiter = nil }
            return waiter?.continuation
        }
        woken?.resume()
    }

    var pushCount: UInt64 { lock.withLock { pushes } }

    var headIsNonEvent: Bool {
        lock.withLock {
            guard head < items.count else { return false }
            if case .event = items[head] { return false }
            return true
        }
    }

    /// Waits for something to send and returns it without taking it; `nil` once closed.
    func waitForHead() async -> Item? {
        while true {
            if let item = peek() { return item }
            if lock.withLock({ closed }) { return nil }
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let ready: Bool = lock.withLock {
                    if closed || head < items.count { return true }
                    generation &+= 1
                    waiter = (generation, continuation)
                    return false
                }
                if ready { continuation.resume() }
            }
            if Task.isCancelled { return nil }
        }
    }

    /// Waits until something new is pushed after `seen`, or `timeout` passes.
    func waitForPush(after seen: UInt64, timeout: Duration, sleep: @escaping @Sendable (Duration) async -> Void) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let mine: UInt64? = lock.withLock {
                if closed || pushes != seen { return nil }
                generation &+= 1
                waiter = (generation, continuation)
                return generation
            }
            guard let mine else { continuation.resume(); return }
            Task { [weak self] in
                await sleep(timeout)
                self?.wake(generation: mine)
            }
        }
    }

    private func wake(generation mine: UInt64) {
        let woken: CheckedContinuation<Void, Never>? = lock.withLock {
            guard let current = waiter, current.generation == mine else { return nil }
            waiter = nil
            return current.continuation
        }
        woken?.resume()
    }

    private func peek() -> Item? {
        lock.withLock { head < items.count ? items[head] : nil }
    }

    func takeFirst() -> Item? {
        lock.withLock {
            guard head < items.count else { return nil }
            let item = items[head]
            advance(by: 1)
            return item
        }
    }

    /// The events at the head of the queue, up to `max`, stopping at the first thing that is not one.
    func takeEvents(max: Int) -> [QueuedEvent] {
        lock.withLock {
            var taken: [QueuedEvent] = []
            while taken.count < max, head < items.count, case .event(let linkId, let event, let at) = items[head] {
                taken.append(QueuedEvent(linkId: linkId, event: event, at: at))
                advance(by: 1)
            }
            return taken
        }
    }

    /// Caller holds the lock.
    private func advance(by count: Int) {
        head += count
        if head == items.count {
            items.removeAll(keepingCapacity: true)
            head = 0
        } else if head > 1024 {
            items.removeFirst(head)
            head = 0
        }
    }
}
