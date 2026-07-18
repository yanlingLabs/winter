import Foundation
import os
import NormaProtocol

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
    /// Resume-signal side channel: a `GapSignal` is yielded when a stream's seq skips past
    /// `cursor + 1`. The consumer reacts by re-handshaking with a snapshot resume. Kept separate
    /// from `events` so the event feed stays pure content and multiple streams don't interfere.
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
        liveBufferCap: Int = 10_000
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

    /// A mutating request carrying a fresh idempotency `commandId` (top-level, for the daemon's
    /// dedup). With a fixed `idgen`, a retried call reuses the same `commandId` — the daemon returns
    /// the original result rather than re-executing.
    public func send(method: String, params: SessionEvent.JSONValue) async throws -> SessionEvent.JSONValue {
        try await rpcCall(method: method, params: params, commandID: idgen())
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
        let params = SessionEvent.JSONValue.object([
            "sessionId": .string(a.sessionID),
            "callId": .string(a.callID),
            "approved": .bool(a.approved),
        ])
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
        if let params { obj["params"] = params }
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
    }

    private func handleFrame(_ frame: Data) {
        // A malformed / stale-epoch frame is skipped (the connection stays usable) — the gateway is
        // the authority on framing; a corrupt inbound frame is not this client's to surface.
        guard let env = try? WireFrame.decode(frame, expectedEpoch: epoch) else { return }
        switch env.kind {
        case .helloAck: handleHelloAck(env)
        case .event: handleEvent(env)
        case .rpcResponse: handleRpcResponse(env)
        case .error: handleErrorFrame(env)
        case .hello, .rpcRequest: break // phone→host kinds; never inbound
        }
    }

    private func handleClose() {
        guard !closed else { return }
        closed = true
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
            cont.resume(throwing: SessionClientError.rpcError(
                code: err["code"]?.intValue ?? -1,
                message: err["message"]?.stringValue ?? "rpc error"
            ))
        } else {
            cont.resume(returning: body["result"] ?? .null)
        }
    }

    /// A gateway-level `.error` frame (envelope validation / allowlist rejection) — fails the
    /// correlated in-flight request if it carries a matching id; otherwise ignored.
    private func handleErrorFrame(_ env: WireEnvelope) {
        guard let body = try? JSONDecoder().decode(SessionEvent.JSONValue.self, from: env.payload),
              let id = body["id"]?.intValue,
              let cont = pending.removeValue(forKey: id) else { return }
        let err = body["error"]
        cont.resume(throwing: SessionClientError.rpcError(
            code: err?["code"]?.intValue ?? -32000,
            message: err?["message"]?.stringValue ?? "gateway error"
        ))
    }

    // MARK: - Event application (dedup / gap / replay→live handoff)

    private func handleEvent(_ env: WireEnvelope) {
        guard let session = env.sessionID, let seq = env.seq else { return }
        let stream = env.streamID ?? session
        let key = StreamKey(session: session, stream: stream)
        var st = streams[key] ?? StreamState(replaying: false, highWatermark: 0)
        defer { streams[key] = st }

        guard !st.gapped, !st.needsSnapshot else { return }

        // Replay→live handoff: a live event (past the replay ceiling) arriving mid-replay is held,
        // not applied — it would otherwise read as a gap against the still-replaying cursor.
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
            st.liveBuffer.append((seq: seq, env: decode(env, session: session)))
            return
        }

        applyEvent(session: session, stream: stream, seq: seq, decoded: decode(env, session: session), state: &st)

        // Replay complete → drain the held live events, in seq order, through the same apply path.
        if st.replaying, !st.gapped, currentCursor(session, stream) >= st.highWatermark {
            st.replaying = false
            let buffered = st.liveBuffer.sorted { $0.seq < $1.seq }
            st.liveBuffer = []
            for item in buffered {
                guard !st.gapped else { break }
                applyEvent(session: session, stream: stream, seq: item.seq, decoded: item.env, state: &st)
            }
        }
    }

    /// The dedup/gap/advance core. `seq <= cursor` → duplicate, ignored. `seq == cursor + 1` → yield
    /// THEN advance the cursor (durable-apply-then-advance). `seq > cursor + 1` → gap: surface a
    /// `GapSignal`, mark the stream, apply nothing (no out-of-order yield, no advance).
    private func applyEvent(session: String, stream: String, seq: Int, decoded: SessionEnvelope, state: inout StreamState) {
        let cursor = currentCursor(session, stream)
        if seq <= cursor { return }
        if seq == cursor + 1 {
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
            return
        }
        gapsCont.yield(GapSignal(sessionID: session, streamID: stream, expectedSeq: cursor + 1, receivedSeq: seq))
        state.gapped = true
    }

    private func currentCursor(_ session: String, _ stream: String) -> Int {
        cursors.cursor(host: hostID, session: session, stream: stream) ?? 0
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
