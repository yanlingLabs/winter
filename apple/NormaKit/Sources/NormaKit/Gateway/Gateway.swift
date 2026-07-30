import Foundation
import NormaProtocol
import NormaSessionKit

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
/// constructs a real `RemoteListener` — only `GatewayTests` builds a `LoopbackListener`. SP2a wires
/// the real iroh-backed listener at the exact seam `Gateway.init` takes (`listener:` param). SP2b
/// (Task 4) finishes the job: `PairingStub` is gone, `listener:` is always a `PairingRouter`
/// wrapping the real `IrohListener` in production (`RemoteHost` is the composition root — see
/// `RemoteHost.swift`), and `directory:` is the real `PairingStore` instead of a fixed constant.
public actor Gateway {
    /// Mirrors the daemon's own `REMOTE_ALLOWED_METHODS` (packages/core/src/ipc/server.ts) as an
    /// independent Swift constant — defense in depth: the gateway rejects an off-list method
    /// BEFORE it ever reaches the daemon, which enforces the identical 16-method allowlist itself.
    /// SP3 T4b added `approval.list` (10th). SP3.4 added `session.create` (11th). Session history
    /// (design 2026-07-23) added `session.history` (12th) — a pure passthrough, no special-casing.
    /// Chat Slice D task 1 added `session.setModel` (13th) — the phone sets the model on a
    /// remote-driven code/dispatch/chat session; also a pure passthrough.
    /// Chat Slice D task 2 added `sync.heads`/`sync.pull`/`sync.push` (14th–16th) — chat-session
    /// log replication; also pure passthroughs (the daemon owns the chat-only gate, the byte
    /// paging, and the divergence check).
    /// Chat Slice D task 3 added `sync.config`/`sync.memory` (17th–18th) — the phone's OWN
    /// standalone-chat bootstrap config (Exa key + user dangerous domains + default model) and its
    /// read-only `_assistant` memory-bucket replica. Neither carries a sessionId; both are pure
    /// passthroughs, same as every other sync verb.
    static let remoteAllowedMethods: Set<String> = [
        "protocol.hello", "session.list", "session.attach", "session.send",
        "session.dispatch", "approval.respond", "ask_user.respond",
        "session.interrupt", "engine.activity", "approval.list",
        // SP3.4: the phone may START a Code session (sidebar "+ New").
        "session.create",
        // Session history (design 2026-07-23): the phone reads past events over a paged RPC.
        "session.history",
        // Chat Slice D task 1: the phone sets the model on a remote-driven session.
        "session.setModel",
        // Chat Slice D task 2: the phone replicates its own chat-session logs both ways.
        "sync.heads", "sync.pull", "sync.push",
        // Chat Slice D task 3: the phone's standalone-chat config bundle + memory-bucket replica.
        "sync.config", "sync.memory",
    ]

    /// Session-map cap (SP2b Task 4) — see `evictIfNeeded()`.
    private static let maxSessions = 32

    private let listener: RemoteListener
    private let daemonFactory: @Sendable () -> NormaClient
    /// This Mac's identity, stamped into every outgoing `WireEnvelope.hostID`/`ServerHello.hostID`
    /// — one value for the whole gateway (unlike `pairingEpoch`, which is per-phone).
    private let hostID: String
    /// The real allowlist (SP2b Task 4 — replaces the SP1/SP2a `PairingStub`): looked up by
    /// `RemoteConn.peerID` on every handshake AND every live frame, so a mid-session revoke+re-pair
    /// (which bumps the record's epoch) is enforced from the CURRENT record, never a cached one.
    private let directory: any PairingDirectory

    /// Inbound `rpcRequest` rate-limit budget (SP2a gate G4a), one bucket minted per phone. Default
    /// 50/s sustained with 200 burst — generous for a human-driven phone, a firm ceiling on a
    /// runaway/hostile one. Injectable so tests can shrink the burst to a couple of tokens.
    private let rateLimit: (perSec: Int, burst: Int)
    /// Injected wall clock feeding each `RateLimiter.allow(now:)` (and, SP2b Task 4, each
    /// `PhoneSession.lastActiveAt` touch) — real time in production, a frozen/hand-advanced value in
    /// tests so both the limiter and eviction are exercised deterministically.
    private let now: @Sendable () -> TimeInterval

    /// Per-phone state, keyed by `ClientHello.clientInstanceID` — see this type's own header
    /// comment on daemon-connection lifetime.
    private var sessions: [String: PhoneSession] = [:]

    /// `clientInstanceID`s that `revoke(_:)` has torn down (SP2a gate G5). A revoked phone's
    /// reconnect is refused at the handshake, even though `sessions` no longer holds its (dropped)
    /// entry — the set outlives the entry so a pairing revocation stays enforced.
    private var revoked: Set<String> = []

    /// SP2b Task 4: every `clientInstanceID` ever seen (at hello time) from a given authenticated
    /// `RemoteConn.peerID` — lets `revoke(peerID:)` (a `PairingStore`-level revocation, keyed by the
    /// phone's iroh identity) fan out to every one of THIS gateway's own per-`clientInstanceID`
    /// sessions that peer ever drove, without the store needing to know anything about
    /// `clientInstanceID`s at all.
    private var peerToClients: [String: Set<String>] = [:]

    /// `RemoteHost` (the composition root) constructs the real thing:
    /// `Gateway(listener: PairingRouter(...), daemonFactory: { NormaClient(makeTransport: {
    /// UnixSocketTransport(...) }, token: try KeychainToken.readRemoteToken(), clientName:
    /// "iphone-gateway") }, hostID: macEndpointID, directory: pairingStore)` — nothing else calls
    /// this initializer outside of tests.
    public init(
        listener: RemoteListener,
        daemonFactory: @escaping @Sendable () -> NormaClient,
        hostID: String,
        directory: any PairingDirectory,
        rateLimit: (perSec: Int, burst: Int) = (perSec: 50, burst: 200),
        now: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) {
        self.listener = listener
        self.daemonFactory = daemonFactory
        self.hostID = hostID
        self.directory = directory
        self.rateLimit = rateLimit
        self.now = now
    }

    public func run() async {
        for await conn in listener.connections {
            Task { [weak self] in await self?.handle(conn) }
        }
    }

    // MARK: - Per-connection handshake + live loop

    private func handle(_ conn: RemoteConn) async {
        // SP2b Task 4 — the real allowlist check, defense-in-depth: `PairingRouter` is the
        // PRIMARY gate (it never forwards a non-member conn here at all), but this guard means
        // `Gateway` is safe even if something someday constructs it without a router in front, or
        // a revoke races the router's own accept-time check. A non-member gets the SAME
        // `sendNotPairedRejection` a phone would see from the router — which peeks the first frame
        // and gives a SESSION dialer a `WireEnvelope` error carrying `HandshakeRejection(not_paired)`
        // (a `NormaSessionClient` decodes it into a typed `.handshakeRejected`), a PAIRING dialer the
        // raw JSON `PairRejected` (SP3.1 Task 1).
        guard let rec = await directory.record(forPeer: conn.peerID) else {
            await sendNotPairedRejection(conn)
            return
        }
        let epoch = rec.pairingEpoch

        var iter = conn.inbound.makeAsyncIterator()
        guard let firstFrame = await iter.next() else { return } // conn closed before ever sending hello

        let helloEnvelope: WireEnvelope
        do {
            helloEnvelope = try WireFrame.decode(firstFrame, expectedEpoch: epoch)
        } catch WireError.staleEpoch {
            // The hello carried an OLD epoch — the phone paired, was revoked, and re-paired (which
            // bumped the record's epoch) while still holding a connection stamped at the old one.
            // A distinct, machine-readable code so the app can surface "re-pair required" rather
            // than a transient failure (SP3.1 T1).
            await sendHandshakeRejection(conn, epoch: epoch, code: .staleEpoch, message: "stale pairing epoch at hello")
            conn.close()
            return
        } catch {
            await sendHandshakeRejection(conn, epoch: epoch, code: .protocolError, message: "invalid hello frame: \(error)")
            conn.close()
            return
        }
        guard helloEnvelope.kind == .hello else {
            await sendHandshakeRejection(conn, epoch: epoch, code: .protocolError, message: "expected hello-first frame, got \(helloEnvelope.kind)")
            conn.close()
            return
        }
        guard let clientHello = try? JSONDecoder().decode(ClientHello.self, from: helloEnvelope.payload) else {
            await sendHandshakeRejection(conn, epoch: epoch, code: .protocolError, message: "malformed ClientHello")
            conn.close()
            return
        }

        // SP2b whole-branch review fix: a stale revocation must not outlive a RE-PAIR. Reaching
        // this line means the peer IS a current directory member (the guard at the top of this
        // method) AND its hello carried the CURRENT epoch (`WireFrame.decode(expectedEpoch:)`
        // above) — that phone is re-authorized by definition, so clear any leftover `revoked`
        // entry for its (stable) `clientInstanceID`. Without this, the set — which lives as long
        // as the gateway, and the gateway outlives a revoke whenever ANOTHER device is still
        // paired (`RemoteHost.stopIfIdle` won't tear it down) — locked a revoked-then-re-paired
        // phone out forever: valid record, valid epoch, same clientInstanceID → "pairing revoked"
        // until an app reinstall minted a new id. SP2a gate G5 is NOT weakened: a still-revoked
        // (not-re-paired) phone has NO directory record and is refused as `not_paired` at the
        // router/membership gate before ever reaching here. The per-connection `session.revoked`
        // guard in `handleLiveFrame` (frames already in flight on a just-revoked conn) is a
        // separate, still-correct mechanism and stays untouched.
        revoked.remove(clientHello.clientInstanceID)

        // SP2a gate G5's handshake guard — post-fix a conn that got this far is never still
        // marked revoked (membership + current epoch just cleared it above); kept as a safety net
        // for future paths rather than as the live enforcement point (that's the membership gate).
        guard !revoked.contains(clientHello.clientInstanceID) else {
            await sendHandshakeRejection(conn, epoch: epoch, code: .revoked, message: "pairing revoked")
            conn.close()
            return
        }

        // SP2b Task 4: record the peer -> clientInstanceID mapping `revoke(peerID:)` fans out
        // through — done once the hello is known-legitimate (past the revoked check above).
        peerToClients[conn.peerID, default: []].insert(clientHello.clientInstanceID)

        let session = await phoneSession(for: clientHello.clientInstanceID)
        // SP2b Task 4: this connection's epoch is now the session's own — every later live frame
        // (`handleLiveFrame`) and every asynchronously-routed daemon event (`routeDaemonEvent`,
        // driven by the persistent pump task, entirely outside THIS function's call stack) reads it
        // from here rather than needing it threaded through as a parameter.
        session.epoch = epoch
        session.lastActiveAt = now()
        if !session.connected {
            do {
                try await session.daemonClient.connect(role: "remote")
            } catch {
                await sendHandshakeRejection(conn, epoch: epoch, code: .daemonUnavailable, message: "daemon connect failed: \(error)")
                conn.close()
                return
            }
            session.connected = true
        }

        session.connGeneration += 1
        let myGeneration = session.connGeneration
        session.currentConn = conn
        startPumpIfNeeded(session)

        // SP2a gates G1/G2/G3 (+ review follow-up 2) — the handshake is four ordered phases with
        // NO event frame emitted until after the ack, and NO live frame until the replay flushed:
        //   1. HOLD live forwarding for the whole handshake: on a real async transport every
        //      `conn.send` suspends this actor, so an unheld live forward could land BETWEEN the
        //      helloAck and the still-unflushed lower-seq replay (out-of-order wire delivery) —
        //      and on a reconnect `liveSessionID` is already set before the ack is even built.
        //      Held events queue on `session.heldLive` (see `routeDaemonEvent`) instead of racing.
        //   2. attach + collect each resume's replay, compute the HONEST (content-only) verdict,
        //      and BUFFER the filtered replay events; register the (last) resumed session as live
        //      so mid-handshake daemon events are captured (G2) — queued, per phase 1.
        //   3. send `helloAck`/`ServerHello` FIRST (G3), THEN flush the buffered replay frames.
        //   4. drain the held live queue (already in seq order — single pump) and lift the hold:
        //      replay and live can never interleave, in that order: ack → replay → live.
        session.holdLiveEvents = true
        var verdicts: [ResumeVerdict] = []
        var pendingReplay: [SessionEvent] = []
        for resume in clientHello.resumes {
            let (verdict, _, buffered) = await attachAndReplay(session: session, resume: resume)
            verdicts.append(verdict)
            pendingReplay.append(contentsOf: buffered)
        }
        #if DEBUG
        signalAttachResolvedForTesting()
        #endif
        // Only the LAST resumed session is truly live-forwardable (one daemon connection, one
        // attach at a time — see `PhoneSession.liveSessionID`). Set once, after the loop, so an
        // earlier resume's session can never leak a live frame ahead of the ack.
        if let last = clientHello.resumes.last {
            session.liveSessionID = last.sessionID
        }

        let serverHello = ServerHello(chosenVersion: 1, hostID: hostID, verdicts: verdicts)
        if let payload = try? JSONEncoder().encode(serverHello) {
            await send(conn, epoch: session.epoch, kind: .helloAck, sessionID: nil, streamID: nil, seq: nil, payload: payload)
        }
        for event in pendingReplay {
            await sendEventFrame(conn, epoch: session.epoch, event: event)
        }
        await drainHeldLive(session: session, conn: conn, generation: myGeneration)

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

    private func phoneSession(for clientInstanceID: String) async -> PhoneSession {
        if let existing = sessions[clientInstanceID] { return existing }
        await evictIfNeeded()
        let fresh = PhoneSession(
            clientInstanceID: clientInstanceID,
            daemonClient: daemonFactory(),
            rateLimiter: RateLimiter(ratePerSec: rateLimit.perSec, burst: rateLimit.burst)
        )
        sessions[clientInstanceID] = fresh
        return fresh
    }

    /// SP2b Task 4: bounds `sessions`' growth from phone churn (e.g. an app reinstall minting a
    /// fresh `clientInstanceID` for the same physical phone, or a peer that's never actually
    /// revoked but keeps generating new instance ids). Only runs on a `phoneSession(for:)` cache
    /// MISS, i.e. right before a new entry would push the map to/past the cap: evicts currently
    /// disconnected sessions (`currentConn == nil`), oldest `lastActiveAt` first, until the map is
    /// back under the cap or no more evictable entries remain (a session with a live `currentConn`
    /// is never evicted, even if that leaves the map above the cap).
    ///
    /// Unlike `revoke(_:)`, eviction is NOT a revocation — no `revoked` insert, so an evicted
    /// phone's next connection just gets a fresh `PhoneSession`, same as any other new phone.
    private func evictIfNeeded() async {
        guard sessions.count >= Self.maxSessions else { return }
        let candidates = sessions.values
            .filter { $0.currentConn == nil }
            .sorted { $0.lastActiveAt < $1.lastActiveAt }
        for stale in candidates {
            guard sessions.count >= Self.maxSessions else { break }
            // T4 review-2 fix 1 (hazard b): the `candidates` snapshot — including its
            // `currentConn == nil` filter — was taken ONCE, before any suspension, but every
            // earlier iteration's `close()` await lets `handle` interleave: a LATER candidate can
            // have acquired a live connection since the snapshot. Re-check at the top of each
            // iteration — a session with a live conn must never be evicted, no matter what the
            // stale snapshot says.
            guard stale.currentConn == nil else { continue }
            // T4 review-2 fix 1 (hazard a): every synchronous mutation (map removal, peer-map
            // prune, pump cancel) happens BEFORE the suspending `close()` below. Removing the
            // entry FIRST means a same-id reconnect landing during the close-await MISSES the
            // cache in `phoneSession(for:)` and mints a fresh, fully-functional session (new
            // daemon client, new pump). The pre-fix order (close, THEN remove) left the stale
            // entry findable mid-close: `phoneSession(for:)` cache-HIT it, `handle` set
            // `currentConn` on it, skipped the daemon reconnect (`connected` still true), and the
            // phone got a helloAck on a dead session — cancelled pump, closing daemon client —
            // which eviction's resume then removed DESPITE the now-live connection. (The previous
            // `sessions[key] === stale` guard here protected against a fresh session under the
            // key — an interleave that can never happen while the stale entry is still cached.)
            sessions[stale.clientInstanceID] = nil
            // T4 review fix 2: prune the evicted id from `peerToClients` in the SAME synchronous
            // section — without this, a churning paired device (fresh `clientInstanceID` per
            // reinstall/reconnect, same peerID) grows its peer's set without bound even though
            // eviction keeps `sessions` itself capped. Drop the whole key once its set empties so
            // the map stays bounded by LIVE state, not ever-seen ids. Revocation-correctness is
            // unaffected: `revoke(peerID:)` only needs the ids that still have gateway state to
            // tear down — an evicted id has none, and its future reconnect is re-gated by the
            // router/directory check, not by this map.
            for (peer, var clients) in peerToClients where clients.contains(stale.clientInstanceID) {
                clients.remove(stale.clientInstanceID)
                peerToClients[peer] = clients.isEmpty ? nil : clients
            }
            stale.pumpTask?.cancel()
            #if DEBUG
            // Test-only synchronization hook (see `setEvictionGateForTesting`): parking here holds
            // eviction exactly inside the suspension window the re-entrancy test races a same-id
            // reconnect into — the candidate is already removed/pruned, its daemon client not yet
            // closed, precisely `close()`'s own suspension point.
            if let gate = evictionGateForTesting {
                await gate(stale.clientInstanceID)
            }
            #endif
            await stale.daemonClient.close()
        }
    }

    // MARK: - Revocation (SP2a gate G5; SP2b Task 4 peer-level fan-out)

    /// Tears down a paired phone's gateway footprint: cancels its persistent daemon-event pump,
    /// closes its daemon `NormaClient` (releasing the `remote` connection), CLOSES its current
    /// transport connection (if any — SP2a Task 4 E2E fix, see below), drops its `PhoneSession`,
    /// and records the `clientInstanceID` as revoked so both any in-flight live loop AND a future
    /// reconnect are refused. Idempotent; safe to call for an unknown id (the id is still marked
    /// revoked, pre-empting a first connection).
    ///
    /// **Task 4 fix:** the original SP2a Task 2 implementation never closed `session.currentConn`
    /// — a revoked phone's transport connection stayed open indefinitely; only its FUTURE frames
    /// got a "pairing revoked" error (via `handleLiveFrame`'s `session.revoked` guard, kept below as
    /// defense-in-depth for a frame already in flight when this runs). Only visible against a real
    /// transport (`ScriptedRemoteConn`'s `isClosed` was never asserted for the conn revoke() itself
    /// was called on, only for a POST-revoke reconnect attempt) — the E2E's scenario F (real iroh)
    /// caught it: a real phone's connection must actually drop, not just get ignored going forward.
    public func revoke(clientInstanceID: String) async {
        revoked.insert(clientInstanceID)
        // T4 review-2 fix 3: prune this id from `peerToClients` — the last path that could leave
        // a dead id mapped, breaking the bounded-by-live-state invariant eviction now maintains.
        // Done in the synchronous section BEFORE the close-await below (and before the
        // no-session early return — a direct revoke of an id whose session is already gone must
        // still unmap it). No re-add race: `handle` checks `revoked` BEFORE its `peerToClients`
        // insert, and the `revoked.insert` above is already visible. `revoke(peerID:)` removing
        // the whole key first just makes this loop a no-op for that peer.
        for (peer, var clients) in peerToClients where clients.contains(clientInstanceID) {
            clients.remove(clientInstanceID)
            peerToClients[peer] = clients.isEmpty ? nil : clients
        }
        guard let session = sessions[clientInstanceID] else { return }
        session.revoked = true
        session.pumpTask?.cancel()
        await session.daemonClient.close()
        session.currentConn?.close()
        session.currentConn = nil
        sessions[clientInstanceID] = nil
    }

    /// SP2b Task 4: `RemoteHost.revoke(phoneEndpointID:)`'s gateway-side half — a `PairingStore`
    /// revocation is keyed by the phone's iroh identity (`peerID`), but every OTHER piece of
    /// gateway state (`sessions`, `revoked`, the daemon-event pump) is keyed by `clientInstanceID`.
    /// `peerToClients` (recorded at hello time) bridges the two: fan out to
    /// `revoke(clientInstanceID:)` for every client this peer ever drove, tearing each down exactly
    /// as a direct per-client revoke would. Idempotent (an unknown/already-clean peerID is a no-op)
    /// and safe to call even for a peer this gateway never actually saw a hello from — there's
    /// simply nothing to fan out to.
    public func revoke(peerID: String) async {
        let clients = peerToClients.removeValue(forKey: peerID) ?? []
        for clientInstanceID in clients {
            await revoke(clientInstanceID: clientInstanceID)
        }
    }

    // SP2b Task 1: every hook below exists solely for `@testable` test-target observation/
    // synchronization — none is ever called from production code (the two call sites that DO
    // feed one, in `handle`/`handleLiveFrame`, are themselves `#if DEBUG`-gated). `#if DEBUG`
    // keeps them out of a Release build of the app entirely, matching `swift test`'s own debug
    // configuration (so tests keep seeing them unchanged).
    #if DEBUG
    /// Test-only inspection hook (`@testable`): the live pump `Task` for a phone, captured BEFORE
    /// `revoke` removes the session so a test can assert it ends up cancelled.
    func pumpTaskForTesting(_ clientInstanceID: String) -> Task<Void, Never>? {
        sessions[clientInstanceID]?.pumpTask
    }

    /// Test-only inspection hook (`@testable`, T4 review fix 2): the `clientInstanceID`s currently
    /// mapped for a peer — the eviction test asserts this stays bounded (pruned in lockstep with
    /// `sessions`) for a churning device instead of growing with every ever-seen id.
    func peerClientsForTesting(_ peerID: String) -> Set<String> {
        peerToClients[peerID] ?? []
    }

    /// Test-only synchronization hook (`@testable`, T4 review-2 fix 1): awaited by `evictIfNeeded`
    /// for each evicted candidate AFTER its synchronous removal (session entry gone, peer map
    /// pruned, pump cancelled) and BEFORE its daemon client's `close()` — a test-controlled park
    /// here is a deterministic stand-in for `close()`'s own suspension, letting the re-entrancy
    /// test drive a same-id reconnect (and a live-conn acquisition by a later candidate) into
    /// exactly that window with no sleeps. Never set in production code.
    private var evictionGateForTesting: (@Sendable (String) async -> Void)?

    func setEvictionGateForTesting(_ gate: (@Sendable (String) async -> Void)?) {
        evictionGateForTesting = gate
    }

    /// Test-only synchronization hook (`@testable`, SP2a Task 4's E2E): resumed once the
    /// handshake's (or live re-attach's) `attachAndReplay` calls have all resolved — i.e., the
    /// daemon-side attach is now registered and the CONTENT verdict is fixed, but the
    /// ack/replay/drain flush hasn't happened yet. A test that awaits this before firing a
    /// concurrent live event is guaranteed that event lands strictly INSIDE the hold-and-drain
    /// window (review-follow-up-2's fix), landing precisely in the gap between attach resolving
    /// and the flush completing — proving the fix over the REAL async transport instead of
    /// guessing at wall-clock timing (confirmed necessary empirically: firing a concurrent send at
    /// dial-time, or even right as the hold flag raises, still let the gateway's own attach call
    /// win the race often enough to land as ordinary replay rather than a genuinely live event —
    /// see `IrohE2ETests`' scenario C for the full account).
    private var attachResolvedContinuations: [CheckedContinuation<Void, Never>] = []

    func waitForNextAttachResolvedForTesting() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            attachResolvedContinuations.append(cont)
        }
    }

    private func signalAttachResolvedForTesting() {
        guard !attachResolvedContinuations.isEmpty else { return }
        let toResume = attachResolvedContinuations
        attachResolvedContinuations = []
        for c in toResume { c.resume() }
    }
    #endif

    /// A `harness_attached`/`harness_detached` event is connection-lifecycle NOISE, never phone
    /// content (SP2a gate G1) — the gateway filters it out of both replay and live forwarding, and
    /// excludes it from the honest content high-watermark.
    private func isHarnessNoise(_ e: SessionEvent) -> Bool {
        switch e {
        case .harnessAttached, .harnessDetached: return true
        default: return false
        }
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
        // SP2a gate G1: the same harness-noise filter that guards replay guards live forwarding —
        // the phone never sees a `harness_attached`/`harness_detached` frame.
        guard !isHarnessNoise(e) else { return }
        // Review follow-up 2: a handshake (or live re-attach) is mid-flush — queue instead of
        // sending, so this live frame can never interleave ahead of lower-seq replay frames on a
        // suspending transport. Drained, in order, by `drainHeldLive` once the flush completes.
        if session.holdLiveEvents {
            session.heldLive.append(e)
            return
        }
        await sendEventFrame(conn, epoch: session.epoch, event: e)
    }

    /// Review follow-up 2 (the drain half — see `handle`'s phase comment): sends the live events
    /// queued while the hold was up, then lifts the hold. The single pump appends in seq order, so
    /// FIFO drain IS seq order. The loop re-checks emptiness after every (suspending) send and the
    /// flag flips synchronously after the LAST check — no `await` between — so no event can slip
    /// past both the queue and the flag. `generation`: if a newer connection for this phone took
    /// over mid-drain, stop and leave the hold + queue to THAT handshake's own drain — never lift
    /// a hold someone else now owns (its sends belong on the newer conn anyway).
    private func drainHeldLive(session: PhoneSession, conn: RemoteConn, generation: Int) async {
        while session.connGeneration == generation, !session.heldLive.isEmpty {
            let e = session.heldLive.removeFirst()
            guard e.sessionId == session.liveSessionID else { continue } // resumed a different session mid-queue
            await sendEventFrame(conn, epoch: session.epoch, event: e)
        }
        if session.connGeneration == generation {
            session.holdLiveEvents = false
        }
    }

    /// Attaches the daemon client to `resume.sessionID` at `resume.lastAppliedSeq`, collects the
    /// replay batch the daemon streams, and returns `(verdict, contentHighWatermark, buffered)` —
    /// the FILTERED replay events to send, but does NOT send them itself. The caller decides
    /// ordering (the handshake sends `helloAck` first, then flushes; the live `session.attach`
    /// re-attach flushes then answers with its `lastSeq`).
    ///
    /// **Honest content watermark (SP2a gate G1).** The daemon's `attach()` return is NOT a usable
    /// high-watermark: `hub.attach` appends a `harness_attached` for THIS very attach and returns
    /// its seq, so the raw return is always `> fromSeq` — which made `.upToDate` unreachable and
    /// leaked that `harness_attached` as a phone-bound frame. Instead we collect the batch, DROP
    /// the `harness_attached`/`harness_detached` noise, and take the high-watermark as the max
    /// CONTENT seq we'll actually deliver (falling back to `fromSeq` when the only thing replayed
    /// was noise — the genuinely-caught-up case, which now correctly yields `.upToDate`).
    private func attachAndReplay(session: PhoneSession, resume: StreamResume) async -> (ResumeVerdict, Int, [SessionEvent]) {
        // Pre-arm the collector BEFORE sending `session.attach` — the daemon (real or faked) may
        // emit the replay's `event` lines strictly before the attach's own RPC response (hub.ts's
        // `hub.attach` delivers synchronously, before the handler returns), so the collector must
        // already be registered when those lines land — mirrors `NormaClient.attach()`'s own
        // "seed lastSeq before the request" trick, one level up.
        session.waiterGeneration += 1
        let myGeneration = session.waiterGeneration
        session.waiter = Waiter(sessionID: resume.sessionID, generation: myGeneration)

        let rawHighWatermark: Int
        do {
            rawHighWatermark = try await session.daemonClient.attach(sessionId: resume.sessionID, fromSeq: resume.lastAppliedSeq)
        } catch {
            session.waiter = nil
            return (.snapshotRequired(sessionID: resume.sessionID, reason: "attach failed: \(error)", oldestAvailableSeq: 0), resume.lastAppliedSeq, [])
        }

        // Collect whenever the daemon's raw return moved past the client's cursor — which, for any
        // LEGITIMATE cursor, is always (the attach's own `harness_attached` bumps it). We must SEE
        // the batch to compute the content-only watermark, even when the client turns out to be
        // caught up (the batch then holds nothing but the terminal `harness_attached`).
        var batch: [SessionEvent] = []
        if rawHighWatermark > resume.lastAppliedSeq {
            batch = await awaitReplayBatch(session: session, sessionID: resume.sessionID, generation: myGeneration, target: rawHighWatermark)
        } else {
            // Cursor-ahead (SP2a review follow-up 1): `rawHighWatermark` is the seq of the
            // `harness_attached` the attach JUST appended — strictly newer than any event the
            // phone could have legitimately applied, so every legitimate cursor sits BELOW it and
            // takes the branch above. A cursor at/beyond it is impossible/corrupt (e.g. a phone
            // that outlived a session wipe). Reporting `.upToDate(fromSeq)` here — the pre-review
            // behavior — would wedge the phone: every real live event (whose seq is far lower)
            // would be silently dropped as stale. The daemon's newest possible CONTENT is
            // `raw - 1`, so feed ResumePlanner exactly that: its cursor-ahead branch
            // (`fromSeq > highWatermark`) fires and demands the snapshot that breaks the wedge.
            session.waiter = nil
            let verdict = ResumePlanner.verdict(fromSeq: resume.lastAppliedSeq, highWatermark: rawHighWatermark - 1, sessionID: resume.sessionID)
            return (verdict, rawHighWatermark - 1, [])
        }

        let content = batch.filter { !isHarnessNoise($0) }
        let toSend = ResumePlanner.replaySlice(events: content, fromSeq: resume.lastAppliedSeq, seqOf: { $0.seq })
        let contentHighWatermark = toSend.map { $0.seq }.max() ?? resume.lastAppliedSeq
        let verdict = ResumePlanner.verdict(fromSeq: resume.lastAppliedSeq, highWatermark: contentHighWatermark, sessionID: resume.sessionID)
        return (verdict, contentHighWatermark, toSend)
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
        session.lastActiveAt = now()
        // SP2a gate G5: once revoked, this conn's in-flight read loop keeps draining frames — every
        // one is refused, none reaches the (now-closed) daemon client.
        guard !session.revoked else {
            await sendGatewayError(conn, epoch: session.epoch, id: .null, sessionID: nil, message: "pairing revoked")
            return
        }
        let envelope: WireEnvelope
        do {
            // SP2b Task 4: `session.epoch` (fixed for this connection at hello time from the
            // directory record then current) — see `handle`'s own comment on why this is a stored
            // session property rather than the OLD global `pairing.epoch` constant.
            envelope = try WireFrame.decode(frame, expectedEpoch: session.epoch)
        } catch WireError.staleEpoch {
            await sendGatewayError(conn, epoch: session.epoch, id: .null, sessionID: nil, message: "stale pairing epoch")
            conn.close()
            return
        } catch {
            // Recoverable: an oversize/malformed/unknown-kind frame gets an error frame, but the
            // connection stays open — the phone can just retry (task brief scenario C).
            await sendGatewayError(conn, epoch: session.epoch, id: .null, sessionID: nil, message: "invalid envelope: \(error)")
            return
        }

        // Transport keepalive (KA-T2): answer pings before any rpc machinery — cheap, un-throttled
        // (never reaches the token bucket), and proof-of-path for the phone's liveness watchdog.
        // Inbound .pong is nonsensical (gateway never pings) — ignore, don't error.
        if envelope.kind == .ping {
            await send(conn, epoch: session.epoch, kind: .pong, sessionID: nil, streamID: nil, seq: nil, payload: Data())
            return
        }
        if envelope.kind == .pong { return }

        guard envelope.kind == .rpcRequest else {
            await sendGatewayError(conn, epoch: session.epoch, id: .null, sessionID: envelope.sessionID, message: "expected rpcRequest frame, got \(envelope.kind)")
            return
        }
        // SP2a gate G4a: throttle inbound rpcRequests BEFORE parse/allowlist — a phone flooding
        // past its token bucket gets a gateway error, and the frame never touches the daemon.
        guard session.rateLimiter.allow(now: now()) else {
            await sendGatewayError(conn, epoch: session.epoch, id: .null, sessionID: envelope.sessionID, message: "rate limit exceeded")
            return
        }
        // SP2a gate G4b: the outer-frame decode above bounds the ENVELOPE's depth, but the inner
        // JSON-RPC payload rode as a base64 string there — validate ITS nesting BEFORE
        // `parseRpcRequest` (the recursive decoder this tripwire protects), so a nesting-bomb
        // payload is refused before it can stress the parser, let alone reach the daemon.
        do {
            try WireFrame.validateJSONDepth(envelope.payload, maxDepth: 32)
        } catch {
            await sendGatewayError(conn, epoch: session.epoch, id: .null, sessionID: envelope.sessionID, message: "payload nesting too deep")
            return
        }
        guard let rpc = parseRpcRequest(envelope.payload) else {
            await sendGatewayError(conn, epoch: session.epoch, id: .null, sessionID: envelope.sessionID, message: "malformed JSON-RPC payload")
            return
        }
        guard Gateway.remoteAllowedMethods.contains(rpc.method) else {
            // Off-list: rejected here, BEFORE the daemon ever sees it (defense in depth — the
            // daemon enforces the identical allowlist independently).
            await sendGatewayError(conn, epoch: session.epoch, id: rpc.id, sessionID: envelope.sessionID, message: "remote role may not call \(rpc.method)")
            return
        }

        // `session.attach` is special-cased to go through the SAME resume/replay machinery as a
        // hello-time `ClientHello.resumes` entry, rather than a bare passthrough — a live
        // re-attach still needs the gateway to know which session is now "live" for event
        // forwarding, and to correctly seed the replay collector.
        if rpc.method == "session.attach", let sessionId = rpc.params?["sessionId"]?.stringValue {
            let fromSeq = rpc.params?["fromSeq"]?.intValue ?? 0
            let resume = StreamResume(sessionID: sessionId, streamID: sessionId, lastAppliedSeq: fromSeq)
            // Same hold-and-drain as the handshake (review follow-up 2): a live event landing
            // while the replay flush below suspends on send must queue behind it, not interleave.
            let myGeneration = session.connGeneration
            session.holdLiveEvents = true
            let (_, contentHighWatermark, buffered) = await attachAndReplay(session: session, resume: resume)
            #if DEBUG
            signalAttachResolvedForTesting()
            #endif
            // Register live-forwarding BEFORE flushing the replay (G2), then answer with the
            // content-only `lastSeq` (G1) — the phone's cursor tracks what it actually received,
            // not the raw attach return that counts the filtered `harness_attached`. Order is
            // replay → response → drained live: monotonic for the phone's cursor (replay ≤ lastSeq
            // in the response ≤ every drained live seq).
            session.liveSessionID = sessionId
            for event in buffered {
                await sendEventFrame(conn, epoch: session.epoch, event: event)
            }
            await sendRpcResult(conn, epoch: session.epoch, id: rpc.id, sessionID: envelope.sessionID, streamID: envelope.streamID, result: .object(["lastSeq": .number(Double(contentHighWatermark))]))
            await drainHeldLive(session: session, conn: conn, generation: myGeneration)
            return
        }

        do {
            // Transparent relay — `rpc.commandId` (if any) passes through untouched; the daemon
            // dedups, the gateway never does (this type's own header comment).
            let result = try await session.daemonClient.request(rpc.method, params: rpc.params, commandId: rpc.commandId)
            await sendRpcResult(conn, epoch: session.epoch, id: rpc.id, sessionID: envelope.sessionID, streamID: envelope.streamID, result: result)
        } catch let e as RpcError {
            // `data` rides along (WB-C1): the relay is transparent for the whole JSON-RPC error
            // object, not just its two required members. `sync.push`'s DIVERGED carries the
            // daemon's `lastSeq` there and the phone's reconcile is unreachable without it.
            await sendRpcError(conn, epoch: session.epoch, id: rpc.id, sessionID: envelope.sessionID, code: e.code, message: e.message, data: e.data)
        } catch {
            await sendRpcError(conn, epoch: session.epoch, id: rpc.id, sessionID: envelope.sessionID, code: -1, message: "\(error)")
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

    /// `epoch`: SP2b Task 4 — per-connection now (the phone's CURRENT `PairRecord.pairingEpoch`,
    /// resolved at hello time and cached on its `PhoneSession`), never the old fixed
    /// `PairingStub.epoch` constant. `hostID` stays the one Gateway-wide constant (`self.hostID`).
    private func send(_ conn: RemoteConn, epoch: Int, kind: WireKind, sessionID: String?, streamID: String?, seq: Int?, payload: Data) async {
        let envelope = WireEnvelope(
            v: 1, pairingEpoch: epoch, hostID: hostID, sessionID: sessionID,
            streamID: streamID, seq: seq, kind: kind, timestamp: nowMs(), payload: payload
        )
        guard let frame = try? WireFrame.encode(envelope) else { return }
        await conn.send(frame)
    }

    private func sendEventFrame(_ conn: RemoteConn, epoch: Int, event: SessionEvent) async {
        guard let payload = try? JSONEncoder().encode(event) else { return }
        await send(conn, epoch: epoch, kind: .event, sessionID: event.sessionId, streamID: event.sessionId, seq: event.seq, payload: payload)
    }

    /// Gateway-level protocol error (envelope validation failures, hello-first violations, the
    /// allowlist rejection) — distinct from `sendRpcError`, which wraps a genuine daemon RESPONSE
    /// (the request DID reach the daemon and it answered with a JSON-RPC error).
    private func sendGatewayError(_ conn: RemoteConn, epoch: Int, id: JSONValue, sessionID: String?, message: String) async {
        let body = JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "error": .object(["code": .number(-32000), "message": .string(message)])])
        guard let payload = try? JSONEncoder().encode(body) else { return }
        await send(conn, epoch: epoch, kind: .error, sessionID: sessionID, streamID: nil, seq: nil, payload: payload)
    }

    /// SP3.1 Task 1: a HANDSHAKE refusal, carried as a structured `HandshakeRejection` payload inside
    /// an `.error` frame — distinct from `sendGatewayError`'s JSON-RPC-error body. The difference is
    /// load-bearing: a `NormaSessionClient` parked on its `helloAck` recognizes THIS payload and
    /// throws a typed `.handshakeRejected(code:)` (which the app maps to its honest `.revoked`
    /// state), whereas the id-less `sendGatewayError` frame its handshake never even looked at
    /// collapsed every refusal to a bare close / `.macUnavailable`. Every refusal site in `handle`
    /// (the per-connection handshake) uses this; the live-loop `sendGatewayError` sites
    /// (rate-limit/allowlist/etc., correlated by rpc id) are unchanged — those are genuine rpc
    /// errors, not handshake refusals. The caller `close()`s AFTER this returns (send-then-close,
    /// so the frame lands before the close — SP2b T1's deterministic-close guarantee).
    private func sendHandshakeRejection(_ conn: RemoteConn, epoch: Int, code: HandshakeRejectionCode, message: String) async {
        let rejection = HandshakeRejection(code: code.rawValue, message: message)
        guard let payload = try? JSONEncoder().encode(rejection) else { return }
        await send(conn, epoch: epoch, kind: .error, sessionID: nil, streamID: nil, seq: nil, payload: payload)
    }

    private func sendRpcResult(_ conn: RemoteConn, epoch: Int, id: JSONValue, sessionID: String?, streamID: String?, result: JSONValue) async {
        let body = JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "result": result])
        guard let payload = try? JSONEncoder().encode(body) else { return }
        await send(conn, epoch: epoch, kind: .rpcResponse, sessionID: sessionID, streamID: streamID, seq: nil, payload: payload)
    }

    /// `data`: the daemon's OPTIONAL structured error payload, forwarded verbatim (Chat Slice D
    /// whole-branch Critical WB-C1). Omitted from the body when absent, so every error that doesn't
    /// carry one stays byte-identical on the wire to what this relay sent before.
    private func sendRpcError(_ conn: RemoteConn, epoch: Int, id: JSONValue, sessionID: String?, code: Int, message: String, data: JSONValue? = nil) async {
        var error: [String: JSONValue] = ["code": .number(Double(code)), "message": .string(message)]
        if let data { error["data"] = data }
        let body = JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "error": .object(error)])
        guard let payload = try? JSONEncoder().encode(body) else { return }
        await send(conn, epoch: epoch, kind: .rpcResponse, sessionID: sessionID, streamID: nil, seq: nil, payload: payload)
    }
}

/// Per-phone state, keyed by `ClientHello.clientInstanceID` — see `Gateway`'s own header comment
/// on daemon-connection lifetime.
///
/// `@unchecked Sendable`: every read/mutation happens only from within `Gateway`-actor-isolated
/// code (this class never escapes to any other actor/thread), so access is already serialized by
/// the actor even though the compiler can't prove it for a plain reference type.
private final class PhoneSession: @unchecked Sendable {
    /// The `ClientHello.clientInstanceID` this session is keyed by — carried on the object so
    /// revocation/inspection paths can round-trip it without a reverse lookup.
    let clientInstanceID: String
    let daemonClient: NormaClient
    /// Inbound-rpcRequest token bucket (SP2a gate G4a), one per phone — a flood from one phone
    /// never spends another's budget.
    let rateLimiter: RateLimiter
    /// Set by `Gateway.revoke` (SP2a gate G5): the in-flight live loop checks it to refuse every
    /// subsequent frame after the daemon client has been closed and the session dropped.
    var revoked = false
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

    /// Review follow-up 2 (replay/live ordering): while `true`, `routeDaemonEvent` QUEUES
    /// live-forwardable events on `heldLive` instead of sending — raised for the span of a
    /// handshake (or live re-attach) so a live frame can never interleave ahead of lower-seq
    /// replay frames when a real async transport's `send` suspends the actor. Lowered by
    /// `Gateway.drainHeldLive` once the replay flush completes and the queue is drained.
    var holdLiveEvents = false
    /// The events queued while `holdLiveEvents` was up — appended by the single pump, so already
    /// in seq order; drained FIFO after the replay flush.
    var heldLive: [SessionEvent] = []

    /// Started lazily on first connect and never restarted — the sole consumer of
    /// `daemonClient.events` for this phone's entire lifetime.
    var pumpTask: Task<Void, Never>?

    /// SP2b Task 4: this phone's `PairRecord.pairingEpoch` as of its most recent successful
    /// handshake (`Gateway.handle`) — stamped into every outgoing `WireEnvelope` for this session
    /// (including ones sent by the daemon-event pump, which runs entirely outside any single
    /// `handle`/`handleLiveFrame` call) and used to validate every subsequent live frame's own
    /// epoch. Default `1` is a placeholder overwritten before this session is ever used for I/O —
    /// `handle` always sets it immediately after `phoneSession(for:)` returns, before any send.
    var epoch = 1
    /// SP2b Task 4: wall-clock time (from `Gateway`'s injected `now()`) of the last frame this
    /// session either received (`handle`'s hello, `handleLiveFrame`) — the eviction cursor
    /// `evictIfNeeded()` sorts disconnected sessions by, oldest first.
    var lastActiveAt: TimeInterval = 0

    init(clientInstanceID: String, daemonClient: NormaClient, rateLimiter: RateLimiter) {
        self.clientInstanceID = clientInstanceID
        self.daemonClient = daemonClient
        self.rateLimiter = rateLimiter
    }
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
