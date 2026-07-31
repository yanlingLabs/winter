import Foundation
import os
import NormaProtocol

/// Transport-keepalive tuning (KA-T3). The client pings the host after `quietMs` of silence; if
/// that first ping draws no inbound frame within `secondWindowMs`, it pings again; if THAT also
/// draws nothing within `graceMs`, the path is declared dead. `tickMs` is just the watchdog's poll
/// cadence — production wakes once a second to check elapsed quiet time against a wall clock, not
/// a per-tick deadline of its own. `.disabled` parks the watchdog at an effectively-never-fires
/// cadence for tests that want zero heartbeat noise without threading `isActive: { false }`
/// through every call site.
public struct HeartbeatConfig: Sendable {
    public let quietMs: Int
    public let secondWindowMs: Int
    public let graceMs: Int
    public let tickMs: Int

    public static let production = HeartbeatConfig(quietMs: 5000, secondWindowMs: 5000, graceMs: 2000, tickMs: 1000)
    public static let disabled = HeartbeatConfig(quietMs: .max, secondWindowMs: .max, graceMs: .max, tickMs: 60_000)

    public init(quietMs: Int, secondWindowMs: Int, graceMs: Int, tickMs: Int) {
        self.quietMs = quietMs
        self.secondWindowMs = secondWindowMs
        self.graceMs = graceMs
        self.tickMs = tickMs
    }
}

/// The phone-side session client (SP3 Task 4): the resume / idempotency / approval state machine
/// the `norma-fake-phone` CLI currently hand-rolls, promoted to a tested, reusable actor. It owns
/// one `RemoteConn`, drives the `ClientHello` → `helloAck` → stream wire dance, and turns the raw
/// frame stream into an ordered, deduplicated, gap-aware `SessionEnvelope` feed the UI consumes.
///
/// **Why an actor.** Swift 6 strict concurrency: every piece of mutable state (the rpc-correlation
/// table, the per-stream replay bookkeeping, the inbound iterator) lives behind the actor's
/// isolation, so there is never a lock held across an `await`. A single background read loop is the
/// SOLE owner of the inbound iterator and mutates all frame-derived state in frame order; the public
/// `send`/`answerApproval`/`pendingApprovals`/`handshake` methods only register continuations the
/// read loop later resumes. Emitted values (`SessionEnvelope`, `GapSignal`, `ServerHello`) are
/// immutable.
///
/// **Framing.** `RemoteConn` is frame-oriented — one whole `WireFrame`-encoded envelope per
/// `inbound` element / `send(_:)` call. The concrete iroh conn owns the `LengthPrefix` byte framing
/// internally; this client never touches it (matching the gateway's own posture).
public actor NormaSessionClient {
    // MARK: - Injected dependencies

    private let conn: RemoteConn
    /// The identity of the host (Mac) this client talks to — the `host` component of every cursor
    /// key. Distinct from `clientInstanceID` (this phone's own id, stamped into outgoing envelopes).
    private let hostID: String
    private let epoch: Int
    private let cursors: CursorStore
    private let clientInstanceID: String
    private let clock: @Sendable () -> Int
    private let idgen: @Sendable () -> String
    /// The first-frame read deadline: `handshake`'s wait for `helloAck` fails after this many
    /// seconds rather than blocking forever on a silent conn (SP2b carry-in gate). Injectable short
    /// for tests.
    private let firstFrameDeadline: Double

    /// The `liveBuffer` bound (T4 review minor 2b): live events held during a replay batch that
    /// never completes (e.g. the exact-watermark event lost on the wire) must not grow without
    /// limit — on overflow the stream surfaces a gap (forcing a snapshot resume) instead.
    /// Injectable small for tests; production default 10_000.
    private let liveBufferCap: Int

    /// Transport-keepalive tuning (KA-T3) — see `HeartbeatConfig`. Defaults to `.production` so
    /// every pre-existing call site keeps behaving exactly as before (a frozen/no-op test clock
    /// never crosses `quietMs`, so no spurious ping ever fires).
    private let heartbeat: HeartbeatConfig
    /// Gates whether the watchdog is allowed to ping/close at all — background app state is
    /// conn-keep's domain, not this client's; a backgrounded phone must never ping or declare its
    /// own path dead. Defaults to always-active.
    private let isActive: @Sendable () -> Bool

    /// Informational `ClientHello.appBuild` — a fixed module identifier (the gateway never keys on
    /// it; a real app would thread its build string through).
    private static let appBuild = "NormaSessionKit"

    /// Diagnostics only — identifiers and error descriptions, NEVER payload/transcript content
    /// (the hard privacy rule for this module).
    private static let logger = Logger(subsystem: "com.norma.sessionkit", category: "NormaSessionClient")

    /// Method name for the pending-approval query. SP3 T4b implemented this on the daemon side:
    /// `approval.list {sessionId} → {pending: [{callId, toolName, summary, issuedAt, expiresAt}]}`
    /// is on the gateway's `remoteAllowedMethods` and handled by `ApprovalBroker.list()`.
    /// `pendingApprovals(sessionID:)` QUERIES this live state rather than reconstructing pending
    /// approvals from replayed events (which age out of the retained log).
    public static let approvalListMethod = "approval.list"

    // MARK: - Public streams

    /// Replayed-then-live events in applied order. Deduped and gap-checked against the cursor;
    /// advanced only after each event is yielded. Live events that arrive during a replay batch are
    /// held and released in-order once the batch completes (replay→live handoff). Finishes when the
    /// connection closes.
    ///
    /// (Exposed as `nonisolated let` rather than the brief's `var`: it is created once in `init` and
    /// never reassigned, and `AsyncStream` is `Sendable`, so consumers iterate it without `await` —
    /// functionally identical to a get-only `var`, and safer.)
    public nonisolated let events: AsyncStream<SessionEnvelope>
    /// Resume-signal side channel: a `GapSignal` is yielded when a stream's `liveBuffer` overflows
    /// (a replay batch that can no longer complete — a genuine "too far behind" condition). The
    /// consumer reacts by re-handshaking with a snapshot resume. NOT fired for benign forward seq
    /// jumps: the gateway filters harness bookkeeping events that still consume daemon seqs, so
    /// holes between received content seqs are normal (see `applyEvent`'s contract comment). Kept
    /// separate from `events` so the event feed stays pure content.
    public nonisolated let gaps: AsyncStream<GapSignal>
    /// Cursor-durability diagnostic channel (T4 review minor 1): a `CursorPersistFailure` is
    /// yielded when `CursorStore.advance` throws AFTER its event was yielded. Safe direction (the
    /// stale cursor re-delivers, never skips) but a persistent write failure must be observable —
    /// T8 watches this for a health warning. Deliberately separate from `gaps`: a gap demands a
    /// snapshot resume, a persist failure does not (re-handshaking would not fix a full disk).
    public nonisolated let persistErrors: AsyncStream<CursorPersistFailure>

    private let eventsCont: AsyncStream<SessionEnvelope>.Continuation
    private let gapsCont: AsyncStream<GapSignal>.Continuation
    private let persistErrorsCont: AsyncStream<CursorPersistFailure>.Continuation

    // MARK: - Read-loop-owned mutable state

    /// The single background reader Task (sole consumer of `conn.inbound`).
    private var readLoopTask: Task<Void, Never>?
    private var closed = false

    /// KA-T3 liveness watchdog state. `lastInboundAt` is stamped from ANY inbound frame (even one
    /// that fails to decode) at the TOP of `handleFrame`, before decode — arrival of bytes on the
    /// wire is liveness proof regardless of what they turn out to mean. Initialized properly when
    /// the read loop starts (see `startReadLoopIfNeeded`); the `0` here is never observed since the
    /// watchdog task only ever starts alongside the read loop.
    private var lastInboundAt: Int = 0
    /// How many un-answered pings have gone out since the last inbound frame of ANY kind. Reset to
    /// 0 the instant anything arrives (see `handleFrame`).
    private var pingsSinceInbound = 0
    /// The watchdog Task — same lifecycle as `readLoopTask` (started beside it in
    /// `startReadLoopIfNeeded`, cancelled in `handleClose`).
    private var heartbeatTask: Task<Void, Never>?

    /// Parked `handshake` waiter, resumed by the read loop on `helloAck` (or by the deadline).
    private var helloWaiter: CheckedContinuation<ServerHello, Error>?
    /// The resumes `handshake` sent — read when recording verdicts to recover each stream's id.
    private var pendingResumes: [StreamResume] = []

    /// In-flight rpc requests keyed by JSON-RPC id, resumed by the read loop on the matching
    /// `rpcResponse`/`error`.
    private var pending: [Int: CheckedContinuation<SessionEvent.JSONValue, Error>] = [:]
    private var nextRpcID = 1

    /// Per-stream replay/dedup bookkeeping, keyed by `(session, stream)`.
    private var streams: [StreamKey: StreamState] = [:]

    private struct StreamKey: Hashable { let session: String; let stream: String }

    private struct StreamState {
        /// True while a `.replayBegin` batch is still draining (cursor < highWatermark).
        var replaying: Bool
        /// The replay batch's ceiling: events with `seq <= highWatermark` are replay, `> ` are live.
        var highWatermark: Int
        /// The verdict was `.snapshotRequired` — the caller must snapshot; drop this stream's events.
        var needsSnapshot = false
        /// A gap was surfaced on this stream — drop further events until a fresh handshake.
        var gapped = false
        /// Live events (`seq > highWatermark`) arriving during replay, released in seq order after.
        var liveBuffer: [(seq: Int, env: SessionEnvelope)] = []
    }

    // MARK: - Init

    public init(
        conn: RemoteConn,
        hostID: String,
        epoch: Int,
        cursors: CursorStore,
        clientInstanceID: String,
        clock: @escaping @Sendable () -> Int,
        idgen: @escaping @Sendable () -> String,
        firstFrameDeadline: Double = 10,
        liveBufferCap: Int = 10_000,
        heartbeat: HeartbeatConfig = .production,
        isActive: @escaping @Sendable () -> Bool = { true }
    ) {
        self.conn = conn
        self.hostID = hostID
        self.epoch = epoch
        self.cursors = cursors
        self.clientInstanceID = clientInstanceID
        self.clock = clock
        self.idgen = idgen
        self.firstFrameDeadline = firstFrameDeadline
        self.liveBufferCap = liveBufferCap
        self.heartbeat = heartbeat
        self.isActive = isActive

        var ec: AsyncStream<SessionEnvelope>.Continuation!
        self.events = AsyncStream { ec = $0 }
        self.eventsCont = ec
        var gc: AsyncStream<GapSignal>.Continuation!
        self.gaps = AsyncStream { gc = $0 }
        self.gapsCont = gc
        var pc: AsyncStream<CursorPersistFailure>.Continuation!
        self.persistErrors = AsyncStream { pc = $0 }
        self.persistErrorsCont = pc
    }

    // MARK: - Handshake

    /// Sends `ClientHello` and returns the host's `ServerHello`, waiting for the `helloAck` under
    /// the first-frame read deadline (throws `.handshakeTimeout` rather than hanging on a silent
    /// conn). Records each stream's resume verdict so the event loop knows its replay watermark.
    ///
    /// **Ordering (load-bearing).** The waiter is parked and the read loop started SYNCHRONOUSLY
    /// inside the continuation, BEFORE the (async) hello send — otherwise a pre-buffered `helloAck`
    /// could be read and dropped (no waiter yet) while `handshake` was still suspended on the send,
    /// then time out. First-wins deadline: whichever of the read loop's `helloAck` handler or the
    /// deadline timer clears `helloWaiter` first owns the resume; the loser is a guarded no-op.
    /// (A `Task` timer, not a task-group race — the codebase convention, since the real iroh
    /// transport ignores Swift cancellation; here it also avoids ever cancelling/finishing the shared
    /// inbound iterator.)
    public func handshake(resumes: [StreamResume]) async throws -> ServerHello {
        pendingResumes = resumes
        let hello = ClientHello(
            protocolVersions: [1],
            appBuild: Self.appBuild,
            clientInstanceID: clientInstanceID,
            pairingEpoch: epoch,
            resumes: resumes
        )
        let payload = try JSONEncoder().encode(hello)

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ServerHello, Error>) in
            guard !closed else {
                cont.resume(throwing: SessionClientError.connectionClosed)
                return
            }
            helloWaiter = cont
            startReadLoopIfNeeded()
            let deadline = firstFrameDeadline
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(deadline * 1_000_000_000))
                await self?.timeoutHelloAck()
            }
            Task { await self.sendEnvelope(kind: .hello, sessionID: nil, streamID: nil, seq: nil, payload: payload) }
        }
    }

    private func timeoutHelloAck() {
        guard let w = helloWaiter else { return }
        helloWaiter = nil
        w.resume(throwing: SessionClientError.handshakeTimeout)
    }

    /// Handles the `helloAck` frame inside the read loop: decode `ServerHello`, record per-stream
    /// verdicts SYNCHRONOUSLY (happens-before any subsequent event frame the loop will process),
    /// then resume the parked handshake. Guarded so a `helloAck` racing in after the deadline fired
    /// is a no-op.
    private func handleHelloAck(_ env: WireEnvelope) {
        guard let w = helloWaiter else { return }
        helloWaiter = nil
        guard let serverHello = try? JSONDecoder().decode(ServerHello.self, from: env.payload) else {
            w.resume(throwing: SessionClientError.handshakeFailed("undecodable ServerHello"))
            return
        }
        recordVerdicts(serverHello)
        w.resume(returning: serverHello)
    }

    private func recordVerdicts(_ hello: ServerHello) {
        for verdict in hello.verdicts {
            switch verdict {
            case .replayBegin(let session, _, let hw):
                let stream = streamID(for: session)
                // T4 review minor 2a: if the local cursor already sits at/past the announced
                // watermark, there is NO replay event left that could ever complete the batch —
                // entering `replaying` would buffer every live event forever (silent stall). Mark
                // the stream live immediately instead. (Recorded synchronously in the helloAck
                // handler, strictly before any event frame is processed, so no drain is needed —
                // the liveBuffer is necessarily empty here.)
                let cursor = cursors.cursor(host: hostID, session: session, stream: stream) ?? 0
                streams[StreamKey(session: session, stream: stream)] = StreamState(replaying: cursor < hw, highWatermark: hw)
            case .upToDate(let session, let hw):
                let stream = streamID(for: session)
                streams[StreamKey(session: session, stream: stream)] = StreamState(replaying: false, highWatermark: hw)
            case .snapshotRequired(let session, _, _):
                let stream = streamID(for: session)
                var st = StreamState(replaying: false, highWatermark: 0)
                st.needsSnapshot = true
                streams[StreamKey(session: session, stream: stream)] = st
            }
        }
    }

    /// The stream id for a resumed session — recovered from the resume the client sent (wire events
    /// carry `streamID == sessionID` today, but the resume is authoritative). Falls back to the
    /// session id for a stream never explicitly resumed.
    private func streamID(for session: String) -> String {
        pendingResumes.first(where: { $0.sessionID == session })?.streamID ?? session
    }

    // MARK: - Requests (idempotent)

    /// A mutating request carrying an idempotency `commandId` (top-level, for the daemon's dedup).
    ///
    /// `commandID` (SP3 T4b review fix, Important #2): a caller that RETRIES a send (T9's prompt
    /// resend) must reuse ONE stable id across attempts so the daemon dedups instead of
    /// re-executing — pass it explicitly and it is used verbatim across every retry. Omitted
    /// (`nil`), a fresh id is minted via `idgen()` — the pre-existing behavior for one-shot sends.
    /// (`answerApproval` already takes its caller-owned `ApprovalAnswer.commandID` — unchanged.)
    ///
    /// orb-regressions fix round 1 (2026-07-29): `params` is now OPTIONAL with a `nil` default, so
    /// a no-argument RPC (`engine.activity`, `session.dispatch` — both remote-allowed) can be
    /// called without inventing an empty object at the call site. Source-compatible: every existing
    /// caller passes a value. `rpcCall` normalizes `nil` to `{}` on the wire — see its own note for
    /// why an OMITTED `params` key is a daemon-side `-32602`, and why that mattered here more than
    /// anywhere else (this, not NormaKit, is the target `norma-ios` consumes).
    public func send(method: String, params: SessionEvent.JSONValue? = nil, commandID: String? = nil) async throws -> SessionEvent.JSONValue {
        try await rpcCall(method: method, params: params, commandID: commandID ?? idgen())
    }

    /// Answers a remote approval in the daemon's REAL `approval.respond` shape (SP3 T4b):
    /// `{sessionId, callId, approved}` → `{ok, alreadyResolved}`. Maps the reply to `ApprovalState`:
    /// `.hostAccepted` when the answer counted (`alreadyResolved: false`), `.resolvedElsewhere` when
    /// it was already resolved by someone/something else (`alreadyResolved: true`). Reuses
    /// `a.commandID` as the idempotency key so a retried answer is deduped by the daemon.
    ///
    /// `.expired` is a phone-DERIVED state, not a daemon reply code: if the approval's `expiresAt`
    /// is already in the past on the client clock, the host will have failed it closed
    /// (`by:"timeout"`), so we short-circuit to `.expired` WITHOUT sending. (Racing that check: if we
    /// send anyway and the host reports `alreadyResolved`, that surfaces as `.resolvedElsewhere` —
    /// acceptable per the T4b brief.) The UI derives `.expired` for a card it is watching the same
    /// way, or from an observed `approval_resolved {by:"timeout"}` event on the stream.
    ///
    /// When it does send, this NEVER returns before the host acks (it awaits the correlated
    /// `rpcResponse`).
    public func answerApproval(_ a: ApprovalAnswer) async throws -> ApprovalState {
        if let expiresAt = a.expiresAt, Date().timeIntervalSince1970 * 1000 >= Double(expiresAt) {
            return .expired
        }
        var obj: [String: SessionEvent.JSONValue] = [
            "sessionId": .string(a.sessionID),
            "callId": .string(a.callID),
            "approved": .bool(a.approved),
        ]
        // SP-approvals T4: only present when the caller chose an offered option — omitted (not
        // sent as null) for a plain approve/deny, matching every other optional-param convention
        // on this client (see `commandID`'s own doc comment above).
        if let optionId = a.optionId { obj["optionId"] = .string(optionId) }
        let params = SessionEvent.JSONValue.object(obj)
        let result = try await rpcCall(method: "approval.respond", params: params, commandID: a.commandID)
        if result["alreadyResolved"]?.boolValue == true { return .resolvedElsewhere }
        return .hostAccepted
    }

    /// Queries the host's currently-pending approvals for a session (live STATE, not reconstructed
    /// from events — pending approvals age out of the retained log). Returns the `pending` array from
    /// `approval.list {sessionId}`; each element is `{callId, toolName, summary, issuedAt, expiresAt}`
    /// (read `["expiresAt"]?.intValue` for the deadline, e.g. to render "expires in Ns"). See
    /// `approvalListMethod`.
    public func pendingApprovals(sessionID: String) async throws -> [SessionEvent.JSONValue] {
        let result = try await rpcCall(
            method: Self.approvalListMethod,
            params: .object(["sessionId": .string(sessionID)]),
            commandID: idgen())
        return result["pending"]?.arrayValue ?? []
    }

    /// Fetches one page of past events for a session. Built on the generic
    /// `send` + the opaque `SessionEvent.JSONValue` decode path — NEVER the strict `SessionEvent`
    /// enum, which throws on an unmodeled type; a page is retained verbatim as `SessionEnvelope`s so
    /// an unknown/future event type never fails the decode (the daemon also filters, this is defense
    /// in depth). `beforeSeq` (EXCLUSIVE) / `limit` are omitted from the params when nil. Read-only:
    /// a fresh idempotency id per call is fine (the daemon dedups WRITES; a repeated read is safe).
    ///
    /// Swift label is `sessionID:` (matching this file's universal convention, e.g.
    /// `pendingApprovals(sessionID:)`); the wire param key stays `"sessionId"` below — that's the TS
    /// contract (`session.history`, methods.ts) and is unaffected by this Swift-only naming choice.
    public func history(sessionID: String, beforeSeq: Int? = nil, limit: Int? = nil) async throws -> HistoryPage {
        var params: [String: SessionEvent.JSONValue] = ["sessionId": .string(sessionID)]
        if let beforeSeq { params["beforeSeq"] = .number(Double(beforeSeq)) }
        if let limit { params["limit"] = .number(Double(limit)) }
        let result = try await send(method: "session.history", params: .object(params))
        let raw = result["events"]?.arrayValue ?? []
        let envelopes: [SessionEnvelope] = raw.compactMap { ev in
            guard let sessionID = ev["sessionId"]?.stringValue, let seq = ev["seq"]?.intValue else { return nil }
            return SessionEnvelope(sessionID: sessionID, streamID: sessionID, seq: seq, kind: .event, json: ev)
        }
        return HistoryPage(
            envelopes: envelopes,
            hasMore: result["hasMore"]?.boolValue ?? false,
            oldestSeq: result["oldestSeq"]?.intValue)
    }

    /// Registers the response continuation BEFORE the async send, so a fast reply is never lost, then
    /// awaits the read-loop-delivered `rpcResponse`/`error` correlated by JSON-RPC id.
    private func rpcCall(method: String, params: SessionEvent.JSONValue?, commandID: String) async throws -> SessionEvent.JSONValue {
        startReadLoopIfNeeded()
        let id = nextRpcID
        nextRpcID += 1
        var obj: [String: SessionEvent.JSONValue] = [
            "jsonrpc": .string("2.0"),
            "id": .number(Double(id)),
            "method": .string(method),
            "commandId": .string(commandID),
        ]
        // orb-regressions fix round 1 (2026-07-29): `nil` params send an EMPTY OBJECT, never an
        // omitted key. JSON-RPC 2.0 permits omitting `params`, but the daemon validates each method
        // against its zod schema (`parseParams`, packages/core/src/ipc/server.ts) and every
        // no-argument method's schema is `z.object({})` — `z.object({}).safeParse(undefined)` FAILS,
        // so an omitted key returns `-32602 invalid params: (root)`. That exact defect (the same
        // `if let params` line, in NormaKit's `NormaClient`) killed the orb's Enter and yellow-light
        // detach. It was latent here — the public `send` took a NON-optional `params`, so nothing
        // could reach the nil branch — which is precisely the shape that makes a future
        // no-argument call a silent trap. Closed rather than left dead, because THIS target (not
        // NormaKit) is what `norma-ios` consumes, and a version-skewed phone is exactly where a
        // client-side-only fix cannot be shipped quickly. The daemon normalizes too now, but this
        // client must hold against an older/skewed daemon on its own.
        obj["params"] = params ?? .object([:])
        let payload = try JSONEncoder().encode(SessionEvent.JSONValue.object(obj))

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<SessionEvent.JSONValue, Error>) in
            guard !closed else {
                cont.resume(throwing: SessionClientError.connectionClosed)
                return
            }
            pending[id] = cont
            Task { await self.sendEnvelope(kind: .rpcRequest, sessionID: nil, streamID: nil, seq: nil, payload: payload) }
        }
    }

    // MARK: - Read loop

    private func startReadLoopIfNeeded() {
        guard readLoopTask == nil, !closed else { return }
        // The watchdog measures quiet time from THIS moment, not from init — a client constructed
        // well before its first `handshake`/`send` call must not appear instantly stale.
        lastInboundAt = clock()
        // The reader Task owns a local iterator (`for await`) over `conn.inbound` — the sole
        // consumer — and hops to the actor per frame. Keeping the iterator out of actor storage
        // sidesteps the "mutating async next() on actor-isolated property" restriction.
        let stream = conn.inbound
        readLoopTask = Task { [weak self] in
            for await frame in stream {
                await self?.handleFrame(frame)
            }
            await self?.handleClose()
        }
        startHeartbeatIfNeeded()
    }

    /// KA-T3: the client-initiated liveness watchdog. Same lifecycle as `readLoopTask` — started
    /// here (this method's only caller is `startReadLoopIfNeeded`, itself called from every place
    /// that used to start the read loop alone) and cancelled in `handleClose`.
    private func startHeartbeatIfNeeded() {
        guard heartbeatTask == nil, !closed else { return }
        let tickMs = heartbeat.tickMs // immutable config — capture once, no actor hop in the loop
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(tickMs) * 1_000_000)
                await self?.heartbeatTick()
            }
        }
    }

    /// One watchdog poll. Silent while backgrounded (`!isActive()`) or already closed — background
    /// app state is conn-keep's domain, not this client's. Two un-answered pings past `graceMs`
    /// declares the path dead by closing OUR side: `conn.close()` ends `conn.inbound`, the read
    /// loop's `for await` exits, `handleClose()` runs — EXACTLY the shape of an ordinary socket
    /// death, so the caller's existing reconnect/backoff path recovers it with no new signal.
    private func heartbeatTick() {
        guard !closed, isActive() else { return }
        let quiet = clock() - lastInboundAt
        let cfg = heartbeat

        // Overflow-proof threshold math (branch review): compare by SUBTRACTING the
        // already-elapsed budget stage from `quiet` instead of SUMMING config fields into the
        // comparison — a legal custom config may hold `.max` (e.g. `secondWindowMs: .max` to ping
        // once and never escalate), and `cfg.quietMs + cfg.secondWindowMs` traps on Int overflow
        // the moment both operands are anywhere near that range. `quiet` is real elapsed
        // wall-clock ms — always non-negative and small — so `quiet - cfg.quietMs` never
        // overflows (worst case `0 - .max`, which is representable: `Int.min` has one MORE
        // magnitude than `-Int.max`). Every subsequent subtraction only fires once its guard has
        // proven the left-hand side is itself bounded and non-negative, so a possibly-`.max`
        // config value is only ever compared against, never added to another possibly-`.max`
        // value.
        let pastQuiet = quiet - cfg.quietMs

        if pingsSinceInbound >= 2, pastQuiet >= cfg.secondWindowMs, pastQuiet - cfg.secondWindowMs >= cfg.graceMs {
            conn.close()
            return
        }
        if (pingsSinceInbound == 0 && quiet >= cfg.quietMs)
            || (pingsSinceInbound == 1 && pastQuiet >= cfg.secondWindowMs) {
            pingsSinceInbound += 1
            Task { await self.sendEnvelope(kind: .ping, sessionID: nil, streamID: nil, seq: nil, payload: Data()) }
        }
    }

    private func handleFrame(_ frame: Data) {
        // KA-T3: liveness = ANY inbound frame, decoded or not — stamped BEFORE decode so even an
        // undecodable frame proves the path is alive (this is how an OLD gateway's invalid-envelope
        // error-frame reply to our `.ping` still counts, same as a real `.pong` would).
        lastInboundAt = clock()
        pingsSinceInbound = 0

        // Strict decode is the common path: live/replay/rpc/helloAck frames are all stamped with
        // OUR epoch. A malformed / stale-epoch frame here is otherwise skipped (the connection stays
        // usable) — the gateway is the authority on framing; a corrupt inbound frame is not this
        // client's to surface.
        if let env = try? WireFrame.decode(frame, expectedEpoch: epoch) {
            switch env.kind {
            case .helloAck: handleHelloAck(env)
            case .event: handleEvent(env)
            case .rpcResponse: handleRpcResponse(env)
            case .error: handleErrorFrame(env)
            case .hello, .rpcRequest: break // phone→host kinds; never inbound
            case .ping: break // the host never pings the phone today; inert if it ever did
            case .pong: break // arrival already counted above (liveness); never surfaces on `events`
            }
            return
        }

        // Strict decode failed. The ONE thing we still act on: a HANDSHAKE-REJECTION `.error` frame
        // (SP3.1 T1) stamped with the MAC's epoch — which, in the `stale_epoch` case, is exactly WHY
        // our own epoch didn't match. Decode epoch-lenient, and surface it ONLY while we're still
        // awaiting the `helloAck` (the handshake window). Every other frame keeps strict-epoch
        // validation: a stale live/replay/rpc frame is still dropped, unchanged.
        guard helloWaiter != nil,
              let env = try? WireFrame.decodeLenient(frame),
              env.kind == .error else { return }
        handleHandshakeRejectionFrame(env)
    }

    private func handleClose() {
        guard !closed else { return }
        closed = true
        heartbeatTask?.cancel()
        let waiters = pending
        pending = [:]
        for (_, cont) in waiters { cont.resume(throwing: SessionClientError.connectionClosed) }
        if let w = helloWaiter {
            helloWaiter = nil
            w.resume(throwing: SessionClientError.connectionClosed)
        }
        eventsCont.finish()
        gapsCont.finish()
        persistErrorsCont.finish()
    }

    // MARK: - Response correlation

    private func handleRpcResponse(_ env: WireEnvelope) {
        guard let body = try? JSONDecoder().decode(SessionEvent.JSONValue.self, from: env.payload),
              let id = body["id"]?.intValue,
              let cont = pending.removeValue(forKey: id) else { return }
        if let err = body["error"] {
            // `data` rides along verbatim (WB-C1). `sync.push`'s DIVERGED carries the daemon's
            // `lastSeq` there and `SyncClient`'s whole reconcile is unreachable without it — see
            // `SessionClientError.rpcError`'s own doc comment.
            cont.resume(throwing: SessionClientError.rpcError(
                code: err["code"]?.intValue ?? -1,
                message: err["message"]?.stringValue ?? "rpc error",
                data: err["data"]
            ))
        } else {
            cont.resume(returning: body["result"] ?? .null)
        }
    }

    /// A gateway-level `.error` frame. Two distinct meanings, told apart by WHEN it arrives:
    ///   - During the HANDSHAKE (`helloWaiter` still parked): a structured `HandshakeRejection`
    ///     refusing the connection (SP3.1 T1) — no rpc request is in flight yet, so an `.error` here
    ///     can only be the Mac turning the handshake away. Surface it as a typed
    ///     `.handshakeRejected` (this handles the SAME-epoch refusal frames — `not_paired`/`revoked`/
    ///     `protocol`/`daemon_unavailable`, stamped with the current record's epoch, which decode
    ///     STRICTLY and land here; the `stale_epoch` frame decodes leniently via `handleFrame`'s
    ///     fallback and lands in `handleHandshakeRejectionFrame` directly).
    ///   - POST-handshake (live loop): an envelope-validation / allowlist rejection of an in-flight
    ///     request — fail the correlated request if it carries a matching id; otherwise ignore.
    private func handleErrorFrame(_ env: WireEnvelope) {
        if helloWaiter != nil {
            handleHandshakeRejectionFrame(env)
            return
        }
        guard let body = try? JSONDecoder().decode(SessionEvent.JSONValue.self, from: env.payload),
              let id = body["id"]?.intValue,
              let cont = pending.removeValue(forKey: id) else { return }
        let err = body["error"]
        cont.resume(throwing: SessionClientError.rpcError(
            code: err?["code"]?.intValue ?? -32000,
            message: err?["message"]?.stringValue ?? "gateway error",
            data: err?["data"]
        ))
    }

    /// Resumes the parked `handshake` with a typed `.handshakeRejected` decoded from the `.error`
    /// frame's `HandshakeRejection` payload (SP3.1 T1). Guarded so a rejection racing in after the
    /// deadline fired (or after a `helloAck` already won) is a no-op — same first-wins discipline as
    /// `handleHelloAck`/`timeoutHelloAck`. A payload that doesn't decode as `HandshakeRejection`
    /// still counts as a refusal (the Mac sent an `.error` during the handshake) — surfaced with the
    /// transient `protocol` code rather than silently parking until timeout.
    private func handleHandshakeRejectionFrame(_ env: WireEnvelope) {
        guard let w = helloWaiter else { return }
        helloWaiter = nil
        let rejection = try? JSONDecoder().decode(HandshakeRejection.self, from: env.payload)
        let code = rejection?.code ?? HandshakeRejectionCode.protocolError.rawValue
        let message = rejection?.message ?? "handshake rejected"
        w.resume(throwing: SessionClientError.handshakeRejected(code: code, message: message))
    }

    // MARK: - Event application (dedup / gap / replay→live handoff)

    private func handleEvent(_ env: WireEnvelope) {
        guard let session = env.sessionID, let seq = env.seq else { return }
        let stream = env.streamID ?? session
        let key = StreamKey(session: session, stream: stream)
        var st = streams[key] ?? StreamState(replaying: false, highWatermark: 0)
        defer { streams[key] = st }

        guard !st.gapped, !st.needsSnapshot else { return }

        let decoded = decode(env, session: session)

        // TRANSIENTS BYPASS THE REPLAY HOLD (the third and last exemption — see
        // `transientEventTypes`). The hold below exists for ONE reason, stated in its own comment:
        // cursor safety. A transient never touches the cursor (`applyEvent` yields and returns
        // before both the dedupe check and `cursors.advance`), so parking one protects nothing and
        // costs the exact symptom the exemption exists to kill — the deltas of a turn in flight go
        // silent while a replay batch drains, then arrive in a burst. It also keeps them off
        // `liveBufferCap`, whose overflow does not merely drop the buffer: it marks the stream
        // `gapped`, killing every further event on it until a fresh handshake. A burst of deltas
        // must never be able to raise that alarm.
        //
        // Nothing downstream is skipped by returning here. The drain check at the bottom fires on
        // `currentCursor >= highWatermark`, which only a cursor-advancing (i.e. non-transient) event
        // can newly satisfy: `recordVerdicts` enters `replaying` only when `cursor < hw`, and a
        // replay event can advance the cursor at most to `hw` — at which point that same call drains
        // and clears the flag. A transient can therefore never be the event that completes a batch.
        if isTransient(decoded) {
            eventsCont.yield(decoded)
            return
        }

        // Replay→live handoff: a live event (past the replay ceiling) arriving mid-replay is held,
        // not applied — applying it immediately would advance the cursor past the still-pending
        // replay events, which would then all be dropped as duplicates (replay lost, reordered
        // delivery). Held events are released in seq order once the batch completes.
        if st.replaying && seq > st.highWatermark {
            // T4 review minor 2b: bound the hold. A replay batch that never completes (the
            // exact-watermark event lost on the wire) would otherwise buffer live events without
            // limit. On overflow, surface a gap — the snapshot resume it forces is exactly the
            // recovery for a replay that can no longer complete — and drop the buffer.
            guard st.liveBuffer.count < liveBufferCap else {
                Self.logger.warning("live buffer overflow session=\(session, privacy: .public) stream=\(stream, privacy: .public) cap=\(self.liveBufferCap)")
                gapsCont.yield(GapSignal(
                    sessionID: session, streamID: stream,
                    expectedSeq: currentCursor(session, stream) + 1, receivedSeq: seq
                ))
                st.gapped = true
                st.liveBuffer = []
                return
            }
            st.liveBuffer.append((seq: seq, env: decoded))
            return
        }

        applyEvent(session: session, stream: stream, seq: seq, decoded: decoded)

        // Replay complete → drain the held live events, in seq order, through the same apply path.
        if st.replaying, currentCursor(session, stream) >= st.highWatermark {
            st.replaying = false
            let buffered = st.liveBuffer.sorted { $0.seq < $1.seq }
            st.liveBuffer = []
            for item in buffered {
                applyEvent(session: session, stream: stream, seq: item.seq, decoded: item.env)
            }
        }
    }

    /// The dedup/advance core. `seq <= cursor` → duplicate/already-applied, dropped. `seq > cursor`
    /// → yield THEN advance the cursor to `seq` (durable-apply-then-advance), TOLERATING forward
    /// jumps past `cursor + 1`. TRANSIENT events (`transientEventTypes`) skip the whole core —
    /// always yielded, never deduped, never cursor-advancing.
    ///
    /// **Why forward jumps are never gaps (T5 conformance fix — aligns with the gateway's
    /// documented contract).** The gateway filters `harness_attached`/`harness_detached`
    /// bookkeeping events from the wire (SP2a gate G1), but those events still CONSUME real daemon
    /// seqs — so received content legitimately has holes (seq 1 then seq 3, because seq 2 was a
    /// filtered harness event; every attach mints one, so the very first content event after ANY
    /// attach jumps). And the transport is a single reliable, ordered QUIC bi-stream: every seq the
    /// phone receives was sent by the gateway in order, so a missing seq between two received
    /// events is ALWAYS a gateway-filtered event, never mid-stream loss. Real loss/staleness is
    /// handled at the HANDSHAKE (the `.snapshotRequired` verdict when the cursor is older than
    /// retention), not in-stream — per SP2a G1's own contract: "cursors stay exclusive-> over what
    /// the phone actually received (filtered seq gaps are fine)." The earlier strict `cursor + 1`
    /// rule turned that benign hole into a PERMANENT false gap (snapshot resume → re-attach →
    /// fresh `harness_attached` → new hole → repeat). The `gaps` stream therefore now fires only
    /// on `liveBuffer` overflow (a genuine "too far behind, snapshot" signal).
    private func applyEvent(session: String, stream: String, seq: Int, decoded: SessionEnvelope) {
        // TRANSIENT events bypass the dedupe/advance core entirely — see `transientEventTypes`.
        // Kept even though `handleEvent` now short-circuits transients one level up (so nothing
        // reaches here or the liveBuffer drain with a transient today): this is the dedupe core's
        // OWN invariant, and it must stay true of any future caller rather than depend on one
        // caller's filtering. Two set lookups on a path that costs a file write is not a cost.
        if isTransient(decoded) {
            eventsCont.yield(decoded)
            return
        }
        let cursor = currentCursor(session, stream)
        if seq <= cursor { return }
        eventsCont.yield(decoded)
        do {
            try cursors.advance(host: hostID, session: session, stream: stream, to: seq)
        } catch {
            // T4 review minor 1: a persist failure must never be silent. The direction is safe
            // (the stale cursor re-delivers this event on the next resume; dedup absorbs it —
            // never a skip), but a PERSISTENT failure (disk full, bad perms) silently defeats
            // crash-durability, so surface it on the diagnostic channel + os log. Identifiers
            // and the error description only — never payload content.
            Self.logger.warning("cursor persist failed session=\(session, privacy: .public) stream=\(stream, privacy: .public) seq=\(seq) error=\(String(describing: error), privacy: .public)")
            persistErrorsCont.yield(CursorPersistFailure(
                sessionID: session, streamID: stream, seq: seq, message: String(describing: error)
            ))
        }
    }

    private func currentCursor(_ session: String, _ stream: String) -> Int {
        cursors.cursor(host: hostID, session: session, stream: stream) ?? 0
    }

    /// The seven broadcast-only TRANSIENT event types, mirroring the Mac client's exemption list
    /// (`NormaKit.NormaClient.route`) exactly — assistant_delta streaming, the peripheral-lease v1
    /// events, plugin_tool_invoke, hardware_requested and plugin_tile_updated. All are runtime-only:
    /// the daemon fans them out WITHOUT appending them to the session log, so they are absent from
    /// replay and must never be resurrected by it.
    ///
    /// **Why they must bypass the dedupe/advance core.** A transient carries `seq = the store's
    /// lastSeq at broadcast time` — the seq of the last event the daemon actually APPENDED, not one
    /// of its own (`packages/core/src/sessions/hub.ts` `broadcastTransient`). The contract is stated
    /// in `packages/protocol/src/events.ts`: clients "MUST exempt assistant_delta from seq-based
    /// dedupe and lastSeq updates". On a caught-up client that seq is by construction `<= cursor`,
    /// so the plain `seq <= cursor` drop killed EVERY one — no streaming at all on a remote session,
    /// the whole reply landing at once when the turn ended.
    ///
    /// Both halves of the exemption are load-bearing:
    ///  - skipping the dedupe check is what lets the event reach the UI at all;
    ///  - skipping the cursor advance is what keeps the REAL event at that borrowed seq alive. A
    ///    transient can legitimately outrun the cursor (its seq belongs to a persisted event still
    ///    in flight — mid-replay, or behind a gateway-filtered hole); advancing to it would swallow
    ///    that genuine event as a duplicate the moment it arrived. Exempting only the dedupe trades
    ///    dropped streaming for a silently truncated transcript.
    ///
    /// Matched on the wire discriminator rather than a typed decode: this client handles event
    /// payloads OPAQUELY (`SessionEnvelope.json`) so an unknown/future type never throws.
    ///
    /// The list itself is `SessionEvent.transientTypes` (NormaProtocol) — the ONE cross-language
    /// definition, mirroring the daemon's `TRANSIENT_EVENT_TYPES`. It was a private literal here,
    /// hand-copied from `NormaClient`'s case list; the daemon's new remote live-stream filter would
    /// have made that hand-mirrored copy #4 on the same axis, and a filter missing a type it should
    /// carry drops that event silently, forever, one hop upstream of this client. Derive, never
    /// re-list.
    private static let transientEventTypes: Set<String> = SessionEvent.transientTypes

    private func isTransient(_ decoded: SessionEnvelope) -> Bool {
        guard let type = decoded.json["type"]?.stringValue else { return false }
        return Self.transientEventTypes.contains(type)
    }

    private func decode(_ env: WireEnvelope, session: String) -> SessionEnvelope {
        let json = (try? JSONDecoder().decode(SessionEvent.JSONValue.self, from: env.payload)) ?? .null
        return SessionEnvelope(sessionID: session, streamID: env.streamID, seq: env.seq, kind: env.kind, json: json)
    }

    // MARK: - Envelope send

    private func sendEnvelope(kind: WireKind, sessionID: String?, streamID: String?, seq: Int?, payload: Data) async {
        let env = WireEnvelope(
            v: 1, pairingEpoch: epoch, hostID: clientInstanceID, sessionID: sessionID,
            streamID: streamID, seq: seq, kind: kind, timestamp: clock(), payload: payload
        )
        guard let frame = try? WireFrame.encode(env) else { return }
        await conn.send(frame)
    }
}
