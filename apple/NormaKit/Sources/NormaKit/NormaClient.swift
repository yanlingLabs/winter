import Foundation
import NormaProtocol

public actor NormaClient {
    public static let protocolVersion = 0

    private let makeTransport: @Sendable () -> NormaTransport
    private let token: String
    private let clientName: String
    private let requestTimeout: Duration

    // internal (not private): NormaClient+Reconnect.swift needs to close a stale transport when a
    // deliberate close() lands mid-reconnect (Task 9 review fix 2).
    var transport: NormaTransport?
    private var decoder = LineDecoder()
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var pumpTask: Task<Void, Never>?

    // Task 9 reconnect flags: `everConnected` gates startReconnect() (never reconnect before the
    // first successful connect); `deliberatelyClosed` distinguishes a user-initiated close() from
    // an unexpected transport drop (the latter triggers reconnectLoop, the former must not).
    var everConnected = false
    var deliberatelyClosed = false
    // Remote Gateway Task 5: the hello `role` this client authenticates as ("harness" by default,
    // "remote" for the gateway's daemon-facing bridge client). Not `private`: NormaClient+
    // Reconnect.swift's reconnectLoop() must re-send the SAME role on every reconnect attempt —
    // reconnecting with the default would silently downgrade a `remote` connection back to
    // `harness` (wrong principal, and the daemon's REMOTE_ALLOWED_METHODS gate would then admit
    // methods it shouldn't).
    var currentRole = "harness"
    // Task 9 review fix 1: guards startReconnect() against re-entrancy — a transport drop that
    // lands WHILE a reconnectLoop is already running (e.g. the replacement transport itself drops
    // mid-handshake) must not spawn a second concurrent loop. reconnectLoop() clears this on every
    // exit path (defer), so a later, genuinely-new disconnect can still trigger reconnection.
    var reconnecting = false

    public nonisolated let events: AsyncStream<NormaEvent>
    nonisolated let eventsCont: AsyncStream<NormaEvent>.Continuation // internal: Task 9's reconnect extension yields states

    // Attach/resync state (used by Task 8/9): the session this client is attached to and the
    // last PERSISTED seq it has seen. assistant_delta is exempt (transient; carries lastSeq).
    var attachedSessionId: String?
    var lastSeq: Int = 0

    /// The session this client is currently attached to (nil when detached).
    public var attachedSession: String? { attachedSessionId }

    // Phase 4d-ii Task 3: live plugin tile state, keyed by pluginId — updated in `route()` on
    // every `plugin_tile_updated` event (transient, bypasses the session-attach gate below, same
    // as assistant_delta/hardwareRequested/etc.). A plugin's entry is REMOVED (not set to nil) the
    // moment its `tile` field is null on the wire — a plugin disconnect or explicit clear — so
    // `tiles.keys` is always exactly "plugins with something to show right now", which is what the
    // 4d-iii PluginManagerView will render as tile cards. Actor-isolated storage (read via
    // `await client.tiles`), same access pattern as `attachedSession` above; the existing `events`
    // stream is the change-signal a UI observes to know when to re-read this snapshot.
    private var tilesStore: [String: [String: SessionEvent.JSONValue]] = [:]

    /// Snapshot of every plugin's current live tile (Phase 4d-ii Task 3). See `tilesStore` above.
    public var tiles: [String: [String: SessionEvent.JSONValue]] { tilesStore }

    public init(
        makeTransport: @escaping @Sendable () -> NormaTransport,
        token: String,
        clientName: String,
        requestTimeout: Duration = .seconds(5)
    ) {
        self.makeTransport = makeTransport
        self.token = token
        self.clientName = clientName
        self.requestTimeout = requestTimeout
        var c: AsyncStream<NormaEvent>.Continuation!
        self.events = AsyncStream { c = $0 }
        self.eventsCont = c
    }

    /// Open the transport, start the read pump, authenticate. Throws on transport or hello failure.
    /// CONTRACT: a successful return IS the "connected" signal — no `.connection(.connected)`
    /// event is yielded for the INITIAL connect (AsyncStream pre-iterator buffering would make
    /// it the first value every consumer sees). Reconnects DO yield `.connection` states.
    ///
    /// `role` (Remote Gateway Task 5): defaults to `"harness"` so every existing caller is
    /// unaffected; the gateway's daemon-facing bridge client calls `connect(role: "remote")` to
    /// authenticate as the least-privileged phone principal (Task 1's REMOTE_ALLOWED_METHODS
    /// gate). Stored in `currentRole` so a later automatic reconnect (Task 9) re-sends the SAME
    /// role rather than silently reverting to the default.
    public func connect(role: String = "harness") async throws {
        currentRole = role
        let t = makeTransport()
        transport = t
        decoder = LineDecoder()
        try await t.open()
        startPump(t)
        _ = try await request("protocol.hello", params: .object([
            "protocolVersion": .number(Double(Self.protocolVersion)),
            "role": .string(role),
            "token": .string(token),
            "clientName": .string(clientName),
        ]))
        everConnected = true
    }

    public func close() {
        deliberatelyClosed = true
        // AMENDMENT 3 (carried from Task 7 review): fail pending requests immediately rather than
        // leaving them to linger until their per-request timeout. ScriptedTransport.close()/most
        // real transports don't synchronously re-deliver .closed through the pump, so without this
        // a caller awaiting a request across close() would otherwise wait out the full timeout.
        failAllPending(RpcError(code: -1, message: "connection closed"))
        transport?.close()
        transport = nil
        eventsCont.finish() // deliberate close: the event stream ENDS — consumers' for-await loops exit
    }

    private func startPump(_ t: NormaTransport) {
        pumpTask?.cancel()
        pumpTask = Task { [weak self] in
            for await ev in t.incoming {
                guard let self else { return }
                await self.handleTransportEvent(ev)
            }
        }
    }

    private func handleTransportEvent(_ ev: TransportEvent) {
        switch ev {
        case .data(let chunk):
            guard let lines = try? decoder.push(chunk) else {
                // oversized line: hostile or broken peer — drop the connection
                transport?.close()
                return
            }
            for line in lines { route(parseServerLine(line)) }
        case .closed:
            failAllPending(RpcError(code: -1, message: "connection closed"))
            eventsCont.yield(.connection(.disconnected))
            onDisconnected() // Task 9 reconnect hook; no-op until then
        }
    }

    /// Task 9: backoff + reconnect + re-attach (NormaClient+Reconnect.swift). Kept separate so
    /// the pump logic never changes when reconnection lands.
    func onDisconnected() { startReconnect() }

    private func route(_ msg: ServerMessage) {
        switch msg {
        case .response(let id, let result):
            guard let cont = pending.removeValue(forKey: id) else { return }
            switch result {
            case .success(let v): cont.resume(returning: v)
            case .failure(let e): cont.resume(throwing: e)
            }
        case .event(let e):
            // Transient events bypass dedupe/lastSeq entirely (their seq = server lastSeq at
            // broadcast time, not their own; a naive `seq <= lastSeq` drop would kill every one
            // of these — assistant_delta streaming, the peripheral-lease v1 events, (Phase 4b
            // Task 1) plugin_tool_invoke, (Phase 4c Task 1) hardware_requested, and (Phase 4d-i,
            // routed app-side by Phase 4d-ii Task 3) plugin_tile_updated, all runtime-only and
            // must never be resurrected by replay — plugin_tile_updated also carries the
            // `sessionId:"$system"` sentinel, never a real attached session).
            switch e {
            case .assistantDelta, .leaseGranted, .leaseLost, .peripheralCallRequested, .pluginToolInvoke, .hardwareRequested, .pluginTileUpdated:
                // Update the tiles store BEFORE yielding, so a consumer that reads `tiles`
                // immediately after observing this event via `events` sees the mutation already
                // applied (no race between the two).
                if case .pluginTileUpdated(let v) = e {
                    if let tile = v.tile {
                        tilesStore[v.pluginId] = tile
                    } else {
                        tilesStore.removeValue(forKey: v.pluginId)
                    }
                }
                eventsCont.yield(.session(e))
                return
            default:
                break
            }
            // The seq dedupe/lastSeq bookkeeping is scoped to the currently attached session
            // ONLY. `lastSeq` is a per-session cursor; applying it globally would drop a
            // cross-session event (e.g. a new session's session_created, seq 1, broadcast while
            // attached to an older/higher-seq session) as a false "already seen" duplicate.
            // Events for any other session (or when nothing is attached) bypass the gate.
            guard let attached = attachedSessionId, e.sessionId == attached else {
                eventsCont.yield(.session(e))
                return
            }
            let seq = e.seq
            if seq <= lastSeq { return } // replay overlap after resync — already seen
            lastSeq = seq
            eventsCont.yield(.session(e))
        case .unknownEvent(let raw):
            eventsCont.yield(.unknown(raw: raw))
        case .unrecognized:
            break // non-protocol noise; ignore
        }
    }

    private func failAllPending(_ error: RpcError) {
        let waiting = pending
        pending = [:]
        for (_, cont) in waiting { cont.resume(throwing: error) }
    }

    /// `commandId` (Remote Gateway Task 5): an optional top-level sibling of `id`/`method`/
    /// `params` (NOT nested inside `params`) — the daemon's remote-role idempotency gate (Task 2)
    /// keys its per-connection dedup cache on this. Defaulted to `nil` so every existing call
    /// site (harness/local — never generates one) is unaffected; only the gateway's live-loop
    /// passthrough (forwarding a phone's `rpcRequest` payload verbatim) ever supplies one, and it
    /// forwards whatever the phone sent UNCHANGED — the gateway is a transparent relay for
    /// `commandId`, the daemon is the one that dedups (see Gateway.swift's own header comment).
    public func request(_ method: String, params: JSONValue?, commandId: String? = nil) async throws -> JSONValue {
        guard let t = transport else { throw RpcError(code: -1, message: "not connected") }
        let id = nextId
        nextId += 1
        var obj: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": .number(Double(id)), "method": .string(method)]
        if let params { obj["params"] = params }
        if let commandId { obj["commandId"] = .string(commandId) }
        let data = try JSONEncoder().encode(JSONValue.object(obj))
        // timeout watchdog: resumes the continuation with an error if the response never lands
        let timeout = requestTimeout
        let watchdog = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            await self?.timeOut(id: id, method: method)
        }
        defer { watchdog.cancel() }
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            Task {
                do { try await t.send(data + Data([0x0a])) }
                catch { self.sendFailed(id: id, method: method) }
            }
        }
    }

    private func timeOut(id: Int, method: String) {
        guard let cont = pending.removeValue(forKey: id) else { return }
        cont.resume(throwing: RpcError(code: -2, message: "request timed out: \(method)"))
    }

    // AMENDMENT 4 (carried from Task 7 review): send failures get their own error/message instead
    // of reusing the timeout path's "timed out" wording. Mirrors timeOut's exactly-once guard
    // (remove from `pending` before resuming, so a late timeout/response can't double-resume).
    private func sendFailed(id: Int, method: String) {
        guard let cont = pending.removeValue(forKey: id) else { return }
        cont.resume(throwing: RpcError(code: -5, message: "transport send failed: \(method)"))
    }
}

extension SessionEvent {
    /// Uniform accessors across all variants (Swift analog of the TS Base fields).
    public var seq: Int {
        switch self {
        case .sessionCreated(let v): return v.seq
        case .harnessAttached(let v): return v.seq
        case .harnessDetached(let v): return v.seq
        case .userMessage(let v): return v.seq
        case .turnStarted(let v): return v.seq
        case .assistantMessage(let v): return v.seq
        case .assistantDelta(let v): return v.seq
        case .toolCall(let v): return v.seq
        case .toolResult(let v): return v.seq
        case .approvalRequested(let v): return v.seq
        case .approvalResolved(let v): return v.seq
        case .turnCompleted(let v): return v.seq
        case .agentError(let v): return v.seq
        case .directoryAdded(let v): return v.seq
        case .bgTaskStarted(let v): return v.seq
        case .bgTaskOutput(let v): return v.seq
        case .bgTaskExited(let v): return v.seq
        case .checkpoint(let v): return v.seq
        case .questionAsked(let v): return v.seq
        case .questionResolved(let v): return v.seq
        case .taskUpdated(let v): return v.seq
        case .planPresented(let v): return v.seq
        case .planResolved(let v): return v.seq
        case .worktreeEntered(let v): return v.seq
        case .worktreeExited(let v): return v.seq
        case .threadStarted(let v): return v.seq
        case .threadCompleted(let v): return v.seq
        case .sessionTitled(let v): return v.seq
        case .leaseGranted(let v): return v.seq
        case .leaseLost(let v): return v.seq
        case .peripheralCallRequested(let v): return v.seq
        case .pluginToolInvoke(let v): return v.seq
        case .hardwareRequested(let v): return v.seq
        case .pluginTileUpdated(let v): return v.seq
        case .shortcutInvoke(let v): return v.seq
        case .tileAction(let v): return v.seq
        case .toolReview(let v): return v.seq
        case .notificationRequested(let v): return v.seq
        case .childUpdate(let v): return v.seq
        }
    }

    /// Uniform sessionId accessor across all variants (sibling of `seq`).
    public var sessionId: String {
        switch self {
        case .sessionCreated(let v): return v.sessionId
        case .harnessAttached(let v): return v.sessionId
        case .harnessDetached(let v): return v.sessionId
        case .userMessage(let v): return v.sessionId
        case .turnStarted(let v): return v.sessionId
        case .assistantMessage(let v): return v.sessionId
        case .assistantDelta(let v): return v.sessionId
        case .toolCall(let v): return v.sessionId
        case .toolResult(let v): return v.sessionId
        case .approvalRequested(let v): return v.sessionId
        case .approvalResolved(let v): return v.sessionId
        case .turnCompleted(let v): return v.sessionId
        case .agentError(let v): return v.sessionId
        case .directoryAdded(let v): return v.sessionId
        case .bgTaskStarted(let v): return v.sessionId
        case .bgTaskOutput(let v): return v.sessionId
        case .bgTaskExited(let v): return v.sessionId
        case .checkpoint(let v): return v.sessionId
        case .questionAsked(let v): return v.sessionId
        case .questionResolved(let v): return v.sessionId
        case .taskUpdated(let v): return v.sessionId
        case .planPresented(let v): return v.sessionId
        case .planResolved(let v): return v.sessionId
        case .worktreeEntered(let v): return v.sessionId
        case .worktreeExited(let v): return v.sessionId
        case .threadStarted(let v): return v.sessionId
        case .threadCompleted(let v): return v.sessionId
        case .sessionTitled(let v): return v.sessionId
        case .leaseGranted(let v): return v.sessionId
        case .leaseLost(let v): return v.sessionId
        case .peripheralCallRequested(let v): return v.sessionId
        case .pluginToolInvoke(let v): return v.sessionId
        case .hardwareRequested(let v): return v.sessionId
        case .pluginTileUpdated(let v): return v.sessionId
        case .shortcutInvoke(let v): return v.sessionId
        case .tileAction(let v): return v.sessionId
        case .toolReview(let v): return v.sessionId
        case .notificationRequested(let v): return v.sessionId
        case .childUpdate(let v): return v.sessionId
        }
    }
}
