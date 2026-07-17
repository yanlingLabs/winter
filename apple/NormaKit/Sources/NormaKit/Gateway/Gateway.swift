import Foundation
import NormaProtocol

/// Remote Gateway sub-project, Task 5 (the capstone): terminate a remote (phone) transport,
/// validate envelopes, bridge to the daemon as the least-privileged `remote` principal, and
/// orchestrate resume/replay + the gateway-side allowlist.
///
/// **Design note (load-bearing for SP3):** the gateway keeps exactly ONE daemon `NormaClient` per
/// paired phone (keyed by `ClientHello.clientInstanceID`) and does NOT tear it down when the
/// phone's transport connection closes — only a pairing revocation would (out of scope for SP1,
/// no revocation exists yet). This lets the daemon's per-connection command dedup (Task 2) and
/// attach state survive a phone drop/reconnect. SP1's own tests (scenario D) only exercise dedup
/// within a single connection; the across-reconnect guarantee is exercised in SP3 (real
/// reconnects over the real iroh transport).
///
/// **Transparent relay for `commandId`:** the gateway forwards a phone's `rpcRequest` payload
/// (including any top-level `commandId`) UNCHANGED to the daemon — see `NormaClient.request
/// (_:params:commandId:)`. It never dedups a repeat itself; the daemon does (Task 2). This
/// layering is deliberate (task brief's own "deviations a reviewer should NOT flag" section) —
/// do not "optimize" by deduping here.
///
/// **No production listener in SP1:** nothing in this file (or anywhere else in the app) ever
/// constructs a real `RemoteListener` — only `GatewayTests` builds a `LoopbackListener`. SP2 wires
/// the real iroh-backed listener + a real `PairingStore` at the exact seam `Gateway.init` takes
/// today (`listener:`/`pairing:` params) — see the one-line comment there.
public actor Gateway {
    /// Fixed pairing identity for SP1 — SP2 replaces this with a real `PairingStore` (per-phone
    /// keys, epoch bumped on re-pairing, QR-exchanged hostID). Not a security gap for SP1: no
    /// production listener exists yet for this stub to protect.
    public struct PairingStub: Sendable {
        public let hostID = "host-stub"
        public let epoch = 1
        public init() {}
    }

    /// Mirrors the daemon's own `REMOTE_ALLOWED_METHODS` (packages/core/src/ipc/server.ts) as an
    /// independent Swift constant — defense in depth: the gateway rejects an off-list method
    /// BEFORE it ever reaches the daemon, which enforces the identical 9-method allowlist itself.
    static let remoteAllowedMethods: Set<String> = [
        "protocol.hello", "session.list", "session.attach", "session.send",
        "session.dispatch", "approval.respond", "ask_user.respond",
        "session.interrupt", "engine.activity",
    ]

    private let listener: RemoteListener
    private let daemonFactory: @Sendable () -> NormaClient
    private let pairing: PairingStub

    /// Per-phone state, keyed by `ClientHello.clientInstanceID` — see this type's own header
    /// comment on daemon-connection lifetime.
    private var sessions: [String: PhoneSession] = [:]

    // SP2 wires the real construction here: `Gateway(listener: IrohListener(...), daemonFactory:
    // { NormaClient(makeTransport: { UnixSocketTransport(...) }, token: pairingStore.remoteToken,
    // clientName: "iphone-gateway") }, pairing: pairingStore.current)` — nothing in SP1 calls this
    // initializer outside of tests.
    public init(listener: RemoteListener, daemonFactory: @escaping @Sendable () -> NormaClient, pairing: PairingStub) {
        self.listener = listener
        self.daemonFactory = daemonFactory
        self.pairing = pairing
    }

    public func run() async {
        for await conn in listener.connections {
            Task { [weak self] in await self?.handle(conn) }
        }
    }

    // MARK: - Per-connection handshake + live loop

    private func handle(_ conn: RemoteConn) async {
        var iter = conn.inbound.makeAsyncIterator()
        guard let firstFrame = await iter.next() else { return } // conn closed before ever sending hello

        let helloEnvelope: WireEnvelope
        do {
            helloEnvelope = try WireFrame.decode(firstFrame, expectedEpoch: pairing.epoch)
        } catch {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "invalid hello frame: \(error)")
            conn.close()
            return
        }
        guard helloEnvelope.kind == .hello else {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "expected hello-first frame, got \(helloEnvelope.kind)")
            conn.close()
            return
        }
        guard let clientHello = try? JSONDecoder().decode(ClientHello.self, from: helloEnvelope.payload) else {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "malformed ClientHello")
            conn.close()
            return
        }

        let session = phoneSession(for: clientHello.clientInstanceID)
        if !session.connected {
            do {
                try await session.daemonClient.connect(role: "remote")
            } catch {
                await sendGatewayError(conn, id: .null, sessionID: nil, message: "daemon connect failed: \(error)")
                conn.close()
                return
            }
            session.connected = true
        }

        session.connGeneration += 1
        let myGeneration = session.connGeneration
        session.currentConn = conn
        startPumpIfNeeded(session)

        var verdicts: [ResumeVerdict] = []
        for resume in clientHello.resumes {
            let (verdict, _) = await attachAndReplay(session: session, conn: conn, resume: resume)
            verdicts.append(verdict)
            session.liveSessionID = resume.sessionID
        }

        let serverHello = ServerHello(chosenVersion: 1, hostID: pairing.hostID, verdicts: verdicts)
        if let payload = try? JSONEncoder().encode(serverHello) {
            await send(conn, kind: .helloAck, sessionID: nil, streamID: nil, seq: nil, payload: payload)
        }

        while let frame = await iter.next() {
            await handleLiveFrame(frame, conn: conn, session: session)
        }

        // Phone disconnected. Per this type's header comment: do NOT tear down the daemon client
        // — only stop routing live events to this now-dead conn (unless a newer connection for
        // the same phone has already taken over, in which case leave its pointer alone).
        if session.connGeneration == myGeneration {
            session.currentConn = nil
        }
    }

    private func phoneSession(for clientInstanceID: String) -> PhoneSession {
        if let existing = sessions[clientInstanceID] { return existing }
        let fresh = PhoneSession(daemonClient: daemonFactory())
        sessions[clientInstanceID] = fresh
        return fresh
    }

    // MARK: - Daemon event routing (one persistent pump per phone, for its whole lifetime)

    /// Started lazily on first connect and NEVER restarted across reconnects — the sole consumer
    /// of `daemonClient.events` for this phone. Keeping exactly one consumer for the client's
    /// entire lifetime means a reconnect's replay-collection (`attachAndReplay`) never races a
    /// stale forwarder for a since-superseded connection.
    private func startPumpIfNeeded(_ session: PhoneSession) {
        guard session.pumpTask == nil else { return }
        session.pumpTask = Task { [weak self] in
            guard let self else { return }
            var it = session.daemonClient.events.makeAsyncIterator()
            while let ev = await it.next() {
                await self.routeDaemonEvent(ev, session: session)
            }
        }
    }

    private func routeDaemonEvent(_ ev: NormaEvent, session: PhoneSession) async {
        guard case .session(let e) = ev else { return }

        // A `StreamResume`/live `session.attach` handshake is in flight for this session — feed
        // the collector instead of live-forwarding (see `attachAndReplay`/`awaitReplayBatch`).
        if var w = session.waiter, w.sessionID == e.sessionId {
            w.collected.append(e)
            if let target = w.target, e.seq >= target, let cont = w.continuation {
                session.waiter = nil
                cont.resume(returning: w.collected)
            } else {
                session.waiter = w
            }
            return
        }

        guard e.sessionId == session.liveSessionID, let conn = session.currentConn else { return }
        await sendEventFrame(conn, event: e)
    }

    /// Attaches the daemon client to `resume.sessionID` at `resume.lastAppliedSeq`, collects
    /// exactly the replay batch (if any), forwards it as `event` frames, and returns the
    /// `ResumeVerdict` (plus the daemon's `lastSeq`, for the live `session.attach` passthrough's
    /// own raw RPC-shaped result).
    ///
    /// `highWatermark` (the ambiguity the brief flagged) = the daemon's own `attach()` return
    /// value — the newest seq the daemon reports for this session at the moment of attach. This
    /// is the cleanest available number: it's exactly what the daemon just told us, requires no
    /// separate bookkeeping, and matches `ResumePlanner`'s contract (a pure fromSeq/highWatermark
    /// decision) exactly.
    @discardableResult
    private func attachAndReplay(session: PhoneSession, conn: RemoteConn, resume: StreamResume) async -> (ResumeVerdict, Int) {
        // Pre-arm the collector BEFORE sending `session.attach` — the daemon (real or faked) may
        // emit the replay's `event` lines strictly before the attach's own RPC response (hub.ts's
        // `hub.attach` delivers synchronously, before the handler returns), so the collector must
        // already be registered when those lines land — mirrors `NormaClient.attach()`'s own
        // "seed lastSeq before the request" trick, one level up.
        session.waiterGeneration += 1
        let myGeneration = session.waiterGeneration
        session.waiter = Waiter(sessionID: resume.sessionID, generation: myGeneration)

        let highWatermark: Int
        do {
            highWatermark = try await session.daemonClient.attach(sessionId: resume.sessionID, fromSeq: resume.lastAppliedSeq)
        } catch {
            session.waiter = nil
            return (.snapshotRequired(sessionID: resume.sessionID, reason: "attach failed: \(error)", oldestAvailableSeq: 0), resume.lastAppliedSeq)
        }

        let verdict = ResumePlanner.verdict(fromSeq: resume.lastAppliedSeq, highWatermark: highWatermark, sessionID: resume.sessionID)

        var replayed: [SessionEvent] = []
        if case .replayBegin = verdict {
            replayed = await awaitReplayBatch(session: session, sessionID: resume.sessionID, generation: myGeneration, target: highWatermark)
        } else {
            session.waiter = nil // upToDate/snapshotRequired: nothing to collect
        }

        let toSend = ResumePlanner.replaySlice(events: replayed, fromSeq: resume.lastAppliedSeq, seqOf: { $0.seq })
        for e in toSend {
            await sendEventFrame(conn, event: e)
        }
        return (verdict, highWatermark)
    }

    /// Waits until the collector (pre-armed by `attachAndReplay`) has accumulated every event up
    /// to `target` (persisted per-session seq is gapless, so "seq >= target" is exactly "done").
    /// Bounded by a watchdog (mirrors `NormaClient.request`'s own timeout pattern) so a
    /// misbehaving/malformed daemon feed degrades to "replay whatever arrived" rather than a hang.
    /// `generation` (from `session.waiterGeneration`) guards against a STALE watchdog for an
    /// abandoned handshake clobbering a NEWER attach for the same session that starts within the
    /// timeout window — the two are otherwise indistinguishable by `sessionID` alone.
    private func awaitReplayBatch(session: PhoneSession, sessionID: String, generation: Int, target: Int, timeout: Duration = .seconds(5)) async -> [SessionEvent] {
        guard var w = session.waiter, w.sessionID == sessionID, w.generation == generation else { return [] }
        if let last = w.collected.last, last.seq >= target {
            session.waiter = nil
            return w.collected
        }
        return await withCheckedContinuation { (cont: CheckedContinuation<[SessionEvent], Never>) in
            w.target = target
            w.continuation = cont
            session.waiter = w
            Task { [weak self] in
                try? await Task.sleep(for: timeout)
                await self?.timeoutReplayWait(session: session, sessionID: sessionID, generation: generation)
            }
        }
    }

    private func timeoutReplayWait(session: PhoneSession, sessionID: String, generation: Int) {
        guard let w = session.waiter, w.sessionID == sessionID, w.generation == generation, let cont = w.continuation else { return }
        session.waiter = nil
        cont.resume(returning: w.collected)
    }

    // MARK: - Live loop (post-handshake)

    private func handleLiveFrame(_ frame: Data, conn: RemoteConn, session: PhoneSession) async {
        let envelope: WireEnvelope
        do {
            envelope = try WireFrame.decode(frame, expectedEpoch: pairing.epoch)
        } catch WireError.staleEpoch {
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "stale pairing epoch")
            conn.close()
            return
        } catch {
            // Recoverable: an oversize/malformed/unknown-kind frame gets an error frame, but the
            // connection stays open — the phone can just retry (task brief scenario C).
            await sendGatewayError(conn, id: .null, sessionID: nil, message: "invalid envelope: \(error)")
            return
        }

        guard envelope.kind == .rpcRequest else {
            await sendGatewayError(conn, id: .null, sessionID: envelope.sessionID, message: "expected rpcRequest frame, got \(envelope.kind)")
            return
        }
        guard let rpc = parseRpcRequest(envelope.payload) else {
            await sendGatewayError(conn, id: .null, sessionID: envelope.sessionID, message: "malformed JSON-RPC payload")
            return
        }
        guard Gateway.remoteAllowedMethods.contains(rpc.method) else {
            // Off-list: rejected here, BEFORE the daemon ever sees it (defense in depth — the
            // daemon enforces the identical allowlist independently).
            await sendGatewayError(conn, id: rpc.id, sessionID: envelope.sessionID, message: "remote role may not call \(rpc.method)")
            return
        }

        // `session.attach` is special-cased to go through the SAME resume/replay machinery as a
        // hello-time `ClientHello.resumes` entry, rather than a bare passthrough — a live
        // re-attach still needs the gateway to know which session is now "live" for event
        // forwarding, and to correctly seed the replay collector.
        if rpc.method == "session.attach", let sessionId = rpc.params?["sessionId"]?.stringValue {
            let fromSeq = rpc.params?["fromSeq"]?.intValue ?? 0
            let resume = StreamResume(sessionID: sessionId, streamID: sessionId, lastAppliedSeq: fromSeq)
            let (_, lastSeq) = await attachAndReplay(session: session, conn: conn, resume: resume)
            session.liveSessionID = sessionId
            await sendRpcResult(conn, id: rpc.id, sessionID: envelope.sessionID, streamID: envelope.streamID, result: .object(["lastSeq": .number(Double(lastSeq))]))
            return
        }

        do {
            // Transparent relay — `rpc.commandId` (if any) passes through untouched; the daemon
            // dedups, the gateway never does (this type's own header comment).
            let result = try await session.daemonClient.request(rpc.method, params: rpc.params, commandId: rpc.commandId)
            await sendRpcResult(conn, id: rpc.id, sessionID: envelope.sessionID, streamID: envelope.streamID, result: result)
        } catch let e as RpcError {
            await sendRpcError(conn, id: rpc.id, sessionID: envelope.sessionID, code: e.code, message: e.message)
        } catch {
            await sendRpcError(conn, id: rpc.id, sessionID: envelope.sessionID, code: -1, message: "\(error)")
        }
    }

    // MARK: - JSON-RPC payload parsing

    private struct ParsedRpcRequest {
        let id: JSONValue
        let method: String
        let params: JSONValue?
        let commandId: String?
    }

    private func parseRpcRequest(_ payload: Data) -> ParsedRpcRequest? {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: payload),
              let method = json["method"]?.stringValue else { return nil }
        return ParsedRpcRequest(id: json["id"] ?? .null, method: method, params: json["params"], commandId: json["commandId"]?.stringValue)
    }

    // MARK: - Envelope construction / sending

    private func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    private func send(_ conn: RemoteConn, kind: WireKind, sessionID: String?, streamID: String?, seq: Int?, payload: Data) async {
        let envelope = WireEnvelope(
            v: 1, pairingEpoch: pairing.epoch, hostID: pairing.hostID, sessionID: sessionID,
            streamID: streamID, seq: seq, kind: kind, timestamp: nowMs(), payload: payload
        )
        guard let frame = try? WireFrame.encode(envelope) else { return }
        await conn.send(frame)
    }

    private func sendEventFrame(_ conn: RemoteConn, event: SessionEvent) async {
        guard let payload = try? JSONEncoder().encode(event) else { return }
        await send(conn, kind: .event, sessionID: event.sessionId, streamID: event.sessionId, seq: event.seq, payload: payload)
    }

    /// Gateway-level protocol error (envelope validation failures, hello-first violations, the
    /// allowlist rejection) — distinct from `sendRpcError`, which wraps a genuine daemon RESPONSE
    /// (the request DID reach the daemon and it answered with a JSON-RPC error).
    private func sendGatewayError(_ conn: RemoteConn, id: JSONValue, sessionID: String?, message: String) async {
        let body = JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "error": .object(["code": .number(-32000), "message": .string(message)])])
        guard let payload = try? JSONEncoder().encode(body) else { return }
        await send(conn, kind: .error, sessionID: sessionID, streamID: nil, seq: nil, payload: payload)
    }

    private func sendRpcResult(_ conn: RemoteConn, id: JSONValue, sessionID: String?, streamID: String?, result: JSONValue) async {
        let body = JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "result": result])
        guard let payload = try? JSONEncoder().encode(body) else { return }
        await send(conn, kind: .rpcResponse, sessionID: sessionID, streamID: streamID, seq: nil, payload: payload)
    }

    private func sendRpcError(_ conn: RemoteConn, id: JSONValue, sessionID: String?, code: Int, message: String) async {
        let body = JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "error": .object(["code": .number(Double(code)), "message": .string(message)])])
        guard let payload = try? JSONEncoder().encode(body) else { return }
        await send(conn, kind: .rpcResponse, sessionID: sessionID, streamID: nil, seq: nil, payload: payload)
    }
}

/// Per-phone state, keyed by `ClientHello.clientInstanceID` — see `Gateway`'s own header comment
/// on daemon-connection lifetime.
///
/// `@unchecked Sendable`: every read/mutation happens only from within `Gateway`-actor-isolated
/// code (this class never escapes to any other actor/thread), so access is already serialized by
/// the actor even though the compiler can't prove it for a plain reference type.
private final class PhoneSession: @unchecked Sendable {
    let daemonClient: NormaClient
    var connected = false

    /// The one session currently "live" for this phone. `NormaClient` supports exactly one
    /// attach at a time (mirroring the daemon's own hub move-semantics re-attach), so only the
    /// MOST RECENT `attachAndReplay` call's session is truly live-forwarded afterward — an
    /// inherent SP1/single-daemon-connection limitation; true concurrent multi-session live
    /// streaming would need one daemon connection per attached session (out of scope here, and
    /// not exercised by the task brief's 5 scenarios, which each use one session at a time).
    var liveSessionID: String?

    /// The phone's current physical connection — where live (post-handshake) events for
    /// `liveSessionID` get forwarded. Reassigned on every (re)connect.
    var currentConn: RemoteConn?
    /// Bumped on every new connection for this phone; guards `currentConn`'s clearing on a
    /// natural disconnect from wiping out a NEWER connection that has already taken over.
    var connGeneration = 0

    /// Handshake-time replay collector — see `Gateway.attachAndReplay`/`awaitReplayBatch`/
    /// `routeDaemonEvent`. Non-nil only while a `StreamResume` (or live `session.attach`)
    /// handshake is in flight.
    var waiter: Waiter?
    /// Bumped on every new `attachAndReplay` call — stamped onto that call's `Waiter` so a stale
    /// replay-timeout watchdog (see `awaitReplayBatch`) can tell "my own abandoned handshake timed
    /// out" apart from "a NEWER handshake for the same sessionID is now in flight" and never
    /// clobbers the latter.
    var waiterGeneration = 0

    /// Started lazily on first connect and never restarted — the sole consumer of
    /// `daemonClient.events` for this phone's entire lifetime.
    var pumpTask: Task<Void, Never>?

    init(daemonClient: NormaClient) { self.daemonClient = daemonClient }
}

/// Handshake-time event collector state (see `PhoneSession.waiter`). `target` is `nil` until the
/// triggering `attach()` call has returned (its return value IS the target) — any events that
/// race ahead of that are still captured into `collected` in the meantime. `generation` pins this
/// instance to one `attachAndReplay` call (see `PhoneSession.waiterGeneration`).
private struct Waiter {
    let sessionID: String
    let generation: Int
    var target: Int?
    var collected: [SessionEvent] = []
    var continuation: CheckedContinuation<[SessionEvent], Never>?
}
