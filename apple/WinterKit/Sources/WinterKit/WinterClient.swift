import Foundation
import WinterProtocol

public actor WinterClient {
    public static let protocolVersion = 0

    /// The longest NDJSON line the daemon accepts on an authenticated connection — `NDJSON_MAX_LINE_BYTES` (8 MiB,
    /// `packages/protocol/src/ndjson.ts`), newline included. A longer request does not fail: the daemon ENDS the
    /// connection. So a request is measured here, ENCODED, before it is sent.
    public static let maxRequestLineBytes = 8 * 1024 * 1024

    /// `session.stageImage`'s longest `dataBase64` — `STAGE_IMAGE_B64_MAX_LENGTH` (the line cap less 256 KiB of
    /// headroom, in whole 4-character groups). Mirrored by hand; the protocol constant is the source.
    public static let stageImageMaxBase64Length = (maxRequestLineBytes - 256 * 1024) / 4 * 4

    /// What the daemon said it can do in its `hello` answer (`features`); empty from a daemon that predates the
    /// field. Re-read on every (re)connect.
    public private(set) var daemonFeatures: Set<String> = []

    /// `hello.features`' name for "`images` accepts the user's ORIGINAL image file by its own path"
    /// (`DAEMON_FEATURE_IMAGE_ORIGINAL_PATHS`).
    public static let featureImageOriginalPaths = "image-original-paths"

    /// Whether this daemon takes a FILE attachment's own path in `session.send`/`steer`'s `images`. False from a
    /// daemon that did not announce it: the composer then puts the path in the text instead, as it always did
    /// for an older daemon (which drops `images`, or refuses a path it did not stage).
    public var supportsOriginalImagePaths: Bool { daemonFeatures.contains(Self.featureImageOriginalPaths) }

    /// One request, encoded exactly as it goes on the wire: compact JSON, and — the part that matters — slashes
    /// NOT escaped. `JSONEncoder` writes every `/` as `\/` by default, and base64 is full of them: a 5.76 MB
    /// white TIFF (all 0xFF bytes, so all slashes) encoded to a 15.36 MB line and the daemon dropped the
    /// connection. A strict-JSON decoder reads `/` and `\/` alike, so nothing else changes.
    static func encodeLine(_ value: JSONValue) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    private let makeTransport: @Sendable () -> WinterTransport
    private let token: String
    private let clientName: String
    private let requestTimeout: Duration
    /// How a request's timeout passes. Production sleeps for real; a test hands in a clock it releases by hand, so the
    /// timeout path never depends on how long the test happens to take to get a request onto the wire. (`init` takes it
    /// as an optional, not a default-argument closure: Swift 6.3.1 miscompiles a default `async` closure here — every
    /// request then died with "freed pointer was not the last allocation".)
    private let sleep: @Sendable (Duration) async throws -> Void

    // internal (not private): WinterClient+Reconnect.swift needs to close a stale transport when a
    // deliberate close() lands mid-reconnect (Task 9 review fix 2).
    var transport: WinterTransport?
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
    // "remote" for the gateway's daemon-facing bridge client). Not `private`: WinterClient+
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

    /// The client's event stream. **It has exactly ONE consumer** (the feed's reader, the Gateway's pump, a probe's
    /// loop): an `AsyncStream` hands each element to whichever consumer asks first, so a second `for await` over this
    /// property steals events from the first — and cancelling ANY consumer's task while it waits on `next()` cancels
    /// the stream for all of them, which ends the first one's loop for good. A caller that wants a few kinds of event
    /// beside the reader takes its own stream from `observe(where:)`.
    public nonisolated let events: AsyncStream<WinterEvent>
    nonisolated let eventsCont: AsyncStream<WinterEvent>.Continuation // internal: Task 9's reconnect extension yields states
    /// How many events the stream holds that its consumer has not taken yet (a hang report's "backlog").
    public nonisolated let traffic: EventTraffic
    /// The side streams `observe(where:)` has handed out.
    nonisolated let observers = EventObservers()

    /// Every event reaches the stream through here, so `traffic` sees each one — and only the ones the stream took:
    /// a yield onto a stream that has ended (a deliberate `close()` is followed by the pump's own `.closed`, which
    /// becomes a `.connection(.disconnected)` AFTER the stream finished) is handed back to `traffic`, because nothing
    /// will ever take it off. The note goes in BEFORE the yield, never after: once the element is on the stream the
    /// consumer may take it at any moment, and a count that arrives late is a count that never balances.
    nonisolated func emit(_ event: WinterEvent) {
        let ticket = traffic.noteYielded()
        switch eventsCont.yield(event) {
        case .enqueued:
            break
        default: // .terminated (the stream is over) or .dropped (a bounded buffer let it go): never to be taken
            if let ticket { traffic.undo(ticket) }
        }
        observers.broadcast(event)
    }

    /// A stream of the events `include` accepts, apart from `events` and without taking anything from it: it sees
    /// every event the client emits from now on (an earlier one is not replayed), so a caller that must not miss an
    /// event asks BEFORE it sends the request that makes the daemon emit it. It ends when the client is closed, and
    /// cancelling or dropping it affects nothing else.
    public nonisolated func observe(where include: @escaping @Sendable (WinterEvent) -> Bool) -> AsyncStream<WinterEvent> {
        observers.add(include)
    }

    /// The side streams `notifications(method:)` has handed out.
    nonisolated let notificationObservers = NotificationObservers()

    /// The `params` of every JSON-RPC notification named `method` the daemon sends from now on — the
    /// non-event notifications (`browserLink.command`, `browserLink.detached`), which never become a
    /// `WinterEvent` and so never reach `events` or `observe(where:)`. Like `observe(where:)` it sees
    /// only what arrives after it is asked for (ask BEFORE the request that makes the daemon send
    /// one), it ends when the client is closed, and dropping it affects nothing else. A notification
    /// no stream asked for is dropped, exactly as every non-event line was before these existed.
    public nonisolated func notifications(method: String) -> AsyncStream<JSONValue> {
        notificationObservers.add(method: method)
    }

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
        makeTransport: @escaping @Sendable () -> WinterTransport,
        token: String,
        clientName: String,
        requestTimeout: Duration = .seconds(5),
        sleep: (@Sendable (Duration) async throws -> Void)? = nil
    ) {
        self.makeTransport = makeTransport
        self.token = token
        self.clientName = clientName
        self.requestTimeout = requestTimeout
        self.sleep = sleep ?? { duration in try await Task.sleep(for: duration) }
        let traffic = EventTraffic()
        var c: AsyncStream<WinterEvent>.Continuation!
        self.events = AsyncStream { c = $0 }
        // A stream that is CANCELLED (its consumer's task was cancelled while it read, which cancels the stream for every
        // consumer) takes nothing more, and what it still held is left behind for a reader that is no longer there:
        // whatever `traffic` still counts as waiting never will be taken.
        c.onTermination = { [traffic] termination in
            if case .cancelled = termination { traffic.retire() }
        }
        self.eventsCont = c
        self.traffic = traffic
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
        let hello = try await request("protocol.hello", params: .object([
            "protocolVersion": .number(Double(Self.protocolVersion)),
            "role": .string(role),
            "token": .string(token),
            "clientName": .string(clientName),
        ]))
        // An older daemon sends no `features`: it then has none, and a feature-gated path falls back.
        if case .array(let names)? = hello["features"] {
            daemonFeatures = Set(names.compactMap { $0.stringValue })
        } else {
            daemonFeatures = []
        }
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
        observers.finishAll()
        notificationObservers.finishAll()
    }

    /// Test seam: returns once the read pump has ended — the transport's `incoming` stream finished — so every
    /// transport event it was going to turn into a client event (a deliberate `close()` is followed by the
    /// transport's own `.closed`, which becomes a `.connection(.disconnected)`) has been handled. Nothing else says when.
    func pumpFinishedForTesting() async {
        await pumpTask?.value
    }

    private func startPump(_ t: WinterTransport) {
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
            emit(.connection(.disconnected))
            onDisconnected() // Task 9 reconnect hook; no-op until then
        }
    }

    /// Task 9: backoff + reconnect + re-attach (WinterClient+Reconnect.swift). Kept separate so
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
            //
            // The membership test is `SessionEvent.isTransient` (WinterProtocol) — the ONE
            // cross-language definition of the transient set, mirroring the daemon's own
            // `TRANSIENT_EVENT_TYPES`. It used to be a literal case list here, hand-copied into
            // the phone client and the daemon's live filter; the phone's copy was simply missing,
            // which killed 100% of iOS streaming with a green suite. Derive, never re-list.
            if e.isTransient {
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
                emit(.session(e))
                return
            }
            // The seq dedupe/lastSeq bookkeeping is scoped to the currently attached session
            // ONLY. `lastSeq` is a per-session cursor; applying it globally would drop a
            // cross-session event (e.g. a new session's session_created, seq 1, broadcast while
            // attached to an older/higher-seq session) as a false "already seen" duplicate.
            // Events for any other session (or when nothing is attached) bypass the gate.
            guard let attached = attachedSessionId, e.sessionId == attached else {
                emit(.session(e))
                return
            }
            let seq = e.seq
            if seq <= lastSeq { return } // replay overlap after resync — already seen
            lastSeq = seq
            emit(.session(e))
        case .unknownEvent(let raw):
            emit(.unknown(raw: raw))
        case .notification(let method, let params):
            notificationObservers.broadcast(method: method, params: params)
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
        // orb-regressions (2026-07-29): `nil` params send an EMPTY OBJECT, never an omitted key.
        // JSON-RPC 2.0 allows omitting `params`, but the daemon validates each method against its
        // zod schema (`parseParams`, ipc/server.ts) and the no-argument methods' schemas are
        // `z.object({})` — `z.object({}).safeParse(undefined)` FAILS, so every wrapper that passed
        // `nil` (session.dispatch, daemon.status, engine.activity, quota.state, trust.list) came
        // back `-32602 invalid params: (root)` against a real daemon. `session.dispatch`'s failure
        // was user-visible: `AppModel.ensureFocusedSession()` returned nil on any Winter home with
        // no dispatch session yet, so orb Enter silently no-op'd and the yellow-light detach bailed
        // on a permanently-nil `focusedSessionId`. Fixed HERE rather than at the five call sites so
        // the whole CLASS is closed — a future `params: nil` wrapper can't reintroduce it — and
        // rather than in the daemon so the fix holds against an already-installed older daemon too.
        // `{}` is inert for every handler that ignores params (verified live on session.list).
        obj["params"] = params ?? .object([:])
        if let commandId { obj["commandId"] = .string(commandId) }
        let data = try Self.encodeLine(JSONValue.object(obj))
        // Budget the ENCODED line (plus its newline) before anything is sent: past the daemon's line cap it would
        // not answer an error, it would end the connection — taking every other request on it down too.
        guard data.count + 1 <= Self.maxRequestLineBytes else {
            throw RpcError(code: -6, message: "request too large to send: \(method) (\(data.count + 1) bytes; the daemon takes at most \(Self.maxRequestLineBytes))")
        }
        // timeout watchdog: resumes the continuation with an error if the response never lands
        let timeout = requestTimeout
        let sleep = self.sleep
        let watchdog = Task { [weak self] in
            try? await sleep(timeout)
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
        case .providerRetry(let v): return v.seq
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
        case .toolReviewProgress(let v): return v.seq
        case .notificationRequested(let v): return v.seq
        case .hookNotice(let v): return v.seq
        case .elicitationRequested(let v): return v.seq
        case .elicitationResolved(let v): return v.seq
        case .continuityWarning(let v): return v.seq
        case .thinkingBlock(let v): return v.seq
        case .thinkingDelta(let v): return v.seq
        case .childUpdate(let v): return v.seq
        case .workflowStarted(let v): return v.seq
        case .workflowProgress(let v): return v.seq
        case .workflowCompleted(let v): return v.seq
        case .workflowFailed(let v): return v.seq
        case .sessionActivity(let v): return v.seq
        case .panelTabOpened(let v): return v.seq
        case .panelTabClosed(let v): return v.seq
        case .panelTabActivated(let v): return v.seq
        case .panelTabNavigated(let v): return v.seq
        case .panelCommand(let v): return v.seq
        case .providerLoginProgress(let v): return v.seq
        case .providerLoginFinished(let v): return v.seq
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
        case .providerRetry(let v): return v.sessionId
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
        case .toolReviewProgress(let v): return v.sessionId
        case .notificationRequested(let v): return v.sessionId
        case .hookNotice(let v): return v.sessionId
        case .elicitationRequested(let v): return v.sessionId
        case .elicitationResolved(let v): return v.sessionId
        case .continuityWarning(let v): return v.sessionId
        case .thinkingBlock(let v): return v.sessionId
        case .thinkingDelta(let v): return v.sessionId
        case .childUpdate(let v): return v.sessionId
        case .workflowStarted(let v): return v.sessionId
        case .workflowProgress(let v): return v.sessionId
        case .workflowCompleted(let v): return v.sessionId
        case .workflowFailed(let v): return v.sessionId
        case .sessionActivity(let v): return v.sessionId
        case .panelTabOpened(let v): return v.sessionId
        case .panelTabClosed(let v): return v.sessionId
        case .panelTabActivated(let v): return v.sessionId
        case .panelTabNavigated(let v): return v.sessionId
        case .panelCommand(let v): return v.sessionId
        case .providerLoginProgress(let v): return v.sessionId
        case .providerLoginFinished(let v): return v.sessionId
        }
    }
}

/// Counts the events a client has put on its stream and the ones its consumer has taken off it, so the
/// difference — the backlog a slow consumer has built up — and how long the oldest has waited can be read from
/// any thread. (An `AsyncStream` does not say how many elements it is holding.)
///
/// The count balances only if every note is matched by a take or by an `undo`/`retire`: `noteYielded` before the
/// yield, `undo` when the stream did not take the element, `retire` when the consumer is gone for good.
public final class EventTraffic: @unchecked Sendable {
    /// Past this many timestamps held, the older half is dropped: a client whose events nobody counts off (the
    /// Gateway's, the phone's) must not grow this forever. A diagnostic, so `backlog` then reads as a floor.
    static let cap = 65_536

    /// One `noteYielded`, so `undo` can take back exactly that note and no other.
    struct Ticket: Equatable, Sendable { fileprivate let id: UInt64 }
    private struct Entry { let id: UInt64; let at: TimeInterval }

    private let lock = NSLock()
    private var entries: [Entry] = []
    private var head = 0
    private var nextId: UInt64 = 0
    private var retired = false
    private let clock: @Sendable () -> TimeInterval

    public init(clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) { self.clock = clock }

    /// An event is about to go onto the stream. Nil once the traffic is retired (nothing is counted any more).
    @discardableResult
    func noteYielded() -> Ticket? {
        lock.lock(); defer { lock.unlock() }
        guard !retired else { return nil }
        nextId += 1
        entries.append(Entry(id: nextId, at: clock()))
        if entries.count - head > Self.cap {
            entries.removeFirst(entries.count - Self.cap / 2)
            head = 0
        }
        return Ticket(id: nextId)
    }

    /// The stream did not take the event `ticket` was noted for (it had ended, or let it go): take the note back. Only
    /// that note — the consumer takes from the other end, so this never costs it one of its own — and nothing at all
    /// if it is no longer held (retired, or trimmed past `cap`).
    func undo(_ ticket: Ticket) {
        lock.lock(); defer { lock.unlock() }
        var i = entries.count - 1
        while i >= head {
            if entries[i].id == ticket.id { entries.remove(at: i); return }
            i -= 1
        }
    }

    /// The consumer is gone for good — its loop ended, or the stream was cancelled under it — so what is still counted
    /// as waiting never will be taken: forget it, and count nothing more. A hang report then reads 0, not the stale
    /// remains of a stream nobody reads.
    public func retire() {
        lock.lock(); defer { lock.unlock() }
        retired = true
        entries.removeAll()
        head = 0
    }

    public var isRetired: Bool { lock.lock(); defer { lock.unlock() }; return retired }

    /// The consumer took one event off the stream. Returns how long that event had been waiting on it, in seconds
    /// (0 when nothing was counted as waiting).
    @discardableResult
    public func noteConsumed() -> TimeInterval {
        lock.lock(); defer { lock.unlock() }
        guard head < entries.count else { return 0 }
        let waited = max(clock() - entries[head].at, 0)
        head += 1
        if head == entries.count { entries.removeAll(keepingCapacity: true); head = 0 }
        else if head > 4096 { entries.removeFirst(head); head = 0 }
        return waited
    }

    /// Events on the stream not yet taken (a floor, once `cap` has been passed).
    public var backlog: Int { lock.lock(); defer { lock.unlock() }; return entries.count - head }

    /// How long the oldest event not yet taken has been waiting, in seconds (0 when none is).
    public var oldestAge: TimeInterval {
        lock.lock(); defer { lock.unlock() }
        guard head < entries.count else { return 0 }
        return max(clock() - entries[head].at, 0)
    }

    /// Timestamps held (tests: bounded however many events nobody counts off).
    var storedCount: Int { lock.lock(); defer { lock.unlock() }; return entries.count }
}

/// The side streams of `WinterClient.observe(where:)`: each gets the events its filter accepts, independently of the
/// client's own `events` stream (and of each other), so a second reader of the client's events never has to be a second
/// consumer of that one stream.
final class EventObservers: @unchecked Sendable {
    private struct Observer { let include: @Sendable (WinterEvent) -> Bool; let continuation: AsyncStream<WinterEvent>.Continuation }

    private let lock = NSLock()
    private var observers: [Int: Observer] = [:]
    private var nextId = 0
    private var finished = false

    func add(_ include: @escaping @Sendable (WinterEvent) -> Bool) -> AsyncStream<WinterEvent> {
        var continuation: AsyncStream<WinterEvent>.Continuation!
        let stream = AsyncStream<WinterEvent> { continuation = $0 }
        lock.lock()
        if finished { lock.unlock(); continuation.finish(); return stream }
        nextId += 1
        let id = nextId
        observers[id] = Observer(include: include, continuation: continuation)
        lock.unlock()
        continuation.onTermination = { [weak self] _ in self?.remove(id) }
        return stream
    }

    func broadcast(_ event: WinterEvent) {
        lock.lock(); let current = observers; lock.unlock()
        for (id, observer) in current where observer.include(event) {
            if case .terminated = observer.continuation.yield(event) { remove(id) }
        }
    }

    /// The client closed: every side stream ends, and none is handed out afterwards that would not.
    func finishAll() {
        lock.lock(); finished = true; let all = observers; observers = [:]; lock.unlock()
        for observer in all.values { observer.continuation.finish() }
    }

    private func remove(_ id: Int) {
        lock.lock(); observers[id] = nil; lock.unlock()
    }
}

/// The side streams of `WinterClient.notifications(method:)`: each gets the `params` of every notification with its
/// method, independently of the event streams and of each other. Same lifetime rules as `EventObservers`.
final class NotificationObservers: @unchecked Sendable {
    private struct Observer { let method: String; let continuation: AsyncStream<JSONValue>.Continuation }

    private let lock = NSLock()
    private var observers: [Int: Observer] = [:]
    private var nextId = 0
    private var finished = false

    func add(method: String) -> AsyncStream<JSONValue> {
        var continuation: AsyncStream<JSONValue>.Continuation!
        let stream = AsyncStream<JSONValue> { continuation = $0 }
        lock.lock()
        if finished { lock.unlock(); continuation.finish(); return stream }
        nextId += 1
        let id = nextId
        observers[id] = Observer(method: method, continuation: continuation)
        lock.unlock()
        continuation.onTermination = { [weak self] _ in self?.remove(id) }
        return stream
    }

    func broadcast(method: String, params: JSONValue) {
        lock.lock(); let current = observers; lock.unlock()
        for (id, observer) in current where observer.method == method {
            if case .terminated = observer.continuation.yield(params) { remove(id) }
        }
    }

    func finishAll() {
        lock.lock(); finished = true; let all = observers; observers = [:]; lock.unlock()
        for observer in all.values { observer.continuation.finish() }
    }

    private func remove(_ id: Int) {
        lock.lock(); observers[id] = nil; lock.unlock()
    }
}
