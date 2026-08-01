import Foundation
import CryptoKit
import NormaProtocol

// ================================================================================================
// SyncClient (Chat Slice D task 9) — the phone half of the replication wire, the mirror image of
// packages/core/src/ipc/sync.ts. It reconciles the phone's `LocalEventStore` with the daemon's chat
// logs over three verbs (`sync.heads` / `sync.pull` / `sync.push`), plus two session-less bootstrap
// reads (`sync.config` / `sync.memory`). It speaks through a minimal `RpcConn` the app implements
// over its EXISTING paired connection — the client owns none of the transport, so every unit test
// drives a scripted double and never opens a socket.
//
// THE ONE HARD RULE (T2 review correction, restated at the seam): a `DIVERGED` error is read off its
// `data.lastSeq`, NEVER off the bare code. `lastSeq: 0` means the daemon holds NOTHING for this id —
// the answer is "re-push from seq 1", which CREATES it, not "fork". Only a non-zero `lastSeq` is a
// real branch point that forks. A client that forks on the bare code spawns a spurious fork for
// every retry after a partial failure. See `push` below.
// ================================================================================================

/// A JSON-RPC failure surfaced from the transport. `divergedLastSeq` is `data.lastSeq` parsed out of
/// an `ERR.DIVERGED` payload (the branch point, or 0 for "daemon has nothing") — the ONE field the
/// fork logic keys on.
public struct RpcError: Error, Equatable {
    public let code: Int
    public let message: String
    public let divergedLastSeq: Int?
    public init(code: Int, message: String, divergedLastSeq: Int? = nil) {
        self.code = code
        self.message = message
        self.divergedLastSeq = divergedLastSeq
    }
}

/// What `syncAll` throws when one or more SESSIONS failed while the pass itself completed. Every
/// other session in that pass was still attempted (review N-M2) — this reports which ones didn't make
/// it, so Task 11 can surface a per-conversation state instead of a dead sync.
public struct SyncPassError: Error {
    public let failures: [(sessionId: String, error: any Error)]
    public var sessionIds: [String] { failures.map { $0.sessionId } }
}

/// The narrow seam the app fills over its paired connection. One method: send a JSON-RPC request
/// (method + already-encoded params object) and hand back the `result` value's raw JSON bytes, or
/// throw `RpcError` carrying the JSON-RPC `code` and — for `DIVERGED` — `data.lastSeq`. Keeping it
/// byte-in/byte-out (not typed) decouples the client from whatever RPC stack the app already runs.
public protocol RpcConn: Sendable {
    func call(method: String, paramsJSON: Data) async throws -> Data
}

// ------------------------------------------------------------------------------------------------
// Wire shapes — the Swift mirrors of the T2/T3 result/param schemas (packages/protocol/src/methods.ts).
// ------------------------------------------------------------------------------------------------

/// One row of `sync.heads` — a daemon chat session's head plus its index-only facts.
public struct SyncHead: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let lastSeq: Int
    public let title: String?          // `null` on the wire when the session has none
    public let model: String?
    /// provider-correctness T6: the Mac's per-session reasoning effort. Absent (never `null`) when
    /// the session has no override — the same omitted-means-unchanged shape `model` uses, and the
    /// read half of `PushMetaParams.effort` below. Optional here means BOTH "no override" and "an
    /// older daemon that predates the field"; neither is a licence to substitute a level.
    public let effort: String?
    public let forkedFrom: SessionForkRef?
}

struct SyncHeadsResult: Decodable { let sessions: [SyncHead] }
struct SyncPullResult: Decodable { let data: String; let nextCursor: Int?; let complete: Bool }
struct SyncPushResult: Decodable { let applied: Bool; let lastSeq: Int; let buffered: Int }

/// One row of the Mac's model catalogue — the mirror of `SyncConfigModel`
/// (packages/protocol/src/methods.ts).
///
/// `efforts` is per model even though every slug the Mac offers today accepts the identical six.
/// The backend validates effort in two layers that disagree — `ultra` is refused globally,
/// `minimal` is refused per model — so a future divergence is real, and carrying it per model makes
/// that divergence a Mac-side data change instead of a phone app release.
///
/// **This type REFUSES WHAT THE WIRE REFUSES, and the decode is hand-written to make that true.**
/// The zod schema is `{id: z.string().min(1), efforts: z.array(z.string().min(1))}` — both minimums
/// are load-bearing, and Swift's synthesized `Decodable` enforces neither. A row like
/// `{"id":"","efforts":[""]}` would decode cleanly into a picker whose selection is an empty slug,
/// and an empty slug reaches a `/responses` request body verbatim and comes back an opaque HTTP 400
/// — the same class of failure the never-synced rule exists to prevent, arriving by a different
/// door. No shipped daemon can produce such a row today; a proxy, a future producer, or a lenient
/// test double can, and "the current server never does that" is not a decode contract.
public struct SyncConfigModel: Codable, Equatable, Sendable {
    public let id: String
    public let efforts: [String]

    public init(id: String, efforts: [String]) {
        self.id = id
        self.efforts = efforts
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        let efforts = try c.decode([String].self, forKey: .efforts)
        // Mirrors `z.string().min(1)` on both fields. A hard throw, never a filter: silently
        // dropping a bad row would hand Task 6 a catalogue that is short by one model with nothing
        // anywhere saying so, which is the lenient-double failure this whole seam is guarded against.
        guard !id.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c,
                                                  debugDescription: "model id must not be empty (wire: z.string().min(1))")
        }
        guard !efforts.contains(where: \.isEmpty) else {
            throw DecodingError.dataCorruptedError(forKey: .efforts, in: c,
                                                  debugDescription: "effort levels must not be empty (wire: z.array(z.string().min(1)))")
        }
        self.id = id
        self.efforts = efforts
    }
}

/// `sync.config` — a freshly-paired phone's bootstrap for its OWN local chat.
///
/// **Decoding strictness is load-bearing and is deliberately NOT uniform across these six fields.**
///
/// The three ORIGINAL fields stay REQUIRED. Swift's synthesized `Decodable` cannot tell "field
/// absent" from "field present but null", so an `exaKey`-less body would decode as `nil` and
/// `ChatConfigStore.apply` would CLEAR the user's stored Exa key. What prevents that today is
/// exactly that `dangerousDomains` and `defaultModel` are non-optional: a partial body fails the
/// decode outright and `apply` is never reached. Making either optional would silently convert a
/// partial response into a credential deletion.
///
/// The three fields added by provider-correctness T3 and T5 are decoded with `decodeIfPresent`, and that is
/// a different judgement for a different reason, not a relaxation of the one above. This kit ships
/// inside the iOS app, which updates on its own schedule (App Store) while the Mac updates on
/// Sparkle's — so a phone WILL, at some point, call a daemon built before these fields existed.
/// Requiring them would make that pairing fail the whole bundle: no Exa key, no dangerous domains,
/// no model, chat unusable. Defaulting them to `[]` / `""` degrades it instead to the state a
/// never-synced phone is already designed to handle — "I have not been told a catalogue" — and the
/// never-synced rule (WAIT, never guess) is what makes that safe. `[]` and `""` are the ABSENCE of
/// a catalogue, never a fallback one; nothing here may invent slugs or levels from them.
public struct SyncConfig: Codable, Equatable, Sendable {
    public let exaKey: String?
    public let dangerousDomains: [String]
    public let defaultModel: String
    /// The Mac's whole model catalogue. EMPTY means the Mac reported no catalogue — its provider
    /// cannot enumerate its models, none is configured, or (see above) it predates this field.
    /// A consumer must wait for a real one rather than deriving a lineup from `defaultModel`, which
    /// is precisely what this field exists to stop.
    public let models: [SyncConfigModel]
    /// The Mac's live reasoning effort. `""` means UNSET, which is NOT `"none"`: unset makes a turn
    /// omit the `reasoning` block entirely, while `"none"` is an explicit level the backend honours.
    public let defaultEffort: String
    /// NORMA-LEVEL effort tiers the Mac offers (`["ultra"]` on a current daemon) — selectable in
    /// Norma, **never sent upstream**, and offered on CODE sessions only.
    ///
    /// A SEPARATE list from `models[].efforts`, and the two must never be concatenated into one
    /// picker section. `models[].efforts` is exactly what the endpoint accepts; a tier is exactly
    /// what it does not — the Mac translates it (today `ultra` → `max`) before building a request,
    /// and applies extra local behaviour of its own. Offering a tier on a chat session, or putting
    /// one on a request this device builds itself, is a 400 from a global enum on the backend.
    ///
    /// EMPTY means the Mac offers no tiers — including because it predates this field. Render
    /// exactly what you are told and invent nothing, the same never-synced rule the catalogue keeps.
    public let clientEfforts: [String]

    public init(exaKey: String?, dangerousDomains: [String], defaultModel: String,
                models: [SyncConfigModel], defaultEffort: String, clientEfforts: [String]) {
        self.exaKey = exaKey
        self.dangerousDomains = dangerousDomains
        self.defaultModel = defaultModel
        self.models = models
        self.defaultEffort = defaultEffort
        self.clientEfforts = clientEfforts
    }

    // No default arguments on the init above, deliberately: every construction site — including both
    // test doubles — must be UPDATED rather than silently keep building the old three-field shape
    // and serving an empty catalogue nobody notices. The compile error IS the sweep.

    /// Hand-written ONLY to make the two new fields absence-tolerant. The three original fields are
    /// decoded byte-for-byte as the synthesized initializer already did — `decodeIfPresent` for the
    /// optional `exaKey` (which is also what the synthesized ENCODER's `encodeIfPresent` requires,
    /// since a nil key is omitted rather than written as `null`), plain `decode` for the two
    /// non-optionals. Reproducing the old behaviour exactly is the point: those two hard decodes are
    /// what make a partial body fail outright instead of reaching `ChatConfigStore.apply` and
    /// clearing a credential, and this change must not quietly move that line.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        exaKey = try c.decodeIfPresent(String.self, forKey: .exaKey)
        dangerousDomains = try c.decode([String].self, forKey: .dangerousDomains)
        defaultModel = try c.decode(String.self, forKey: .defaultModel)
        // Tolerated-absent — an older daemon, not a malformed body.
        models = try c.decodeIfPresent([SyncConfigModel].self, forKey: .models) ?? []
        defaultEffort = try c.decodeIfPresent(String.self, forKey: .defaultEffort) ?? ""
        // provider-correctness T5, tolerated-absent for the SAME reason as the two above (this kit
        // ships in an App Store app that will meet a Sparkle-updated Mac of any vintage), and safe
        // for a stronger reason than they are: absent → no tiers offered → the phone renders only
        // the wire levels, which is precisely the pre-T5 behaviour. The failure mode leniency
        // usually risks — inventing a level — cannot occur, because `[]` is not a fallback list.
        clientEfforts = try c.decodeIfPresent([String].self, forKey: .clientEfforts) ?? []
    }
}

/// One replicated `_assistant` memory file.
///
/// The memberwise init is spelled out and PUBLIC (like `SyncConfig`'s): the phone writes these to
/// its own replica directory, and its tests have to be able to build a page without a socket.
public struct SyncMemoryFile: Decodable, Equatable, Sendable {
    public let name: String
    public let content: String
    public init(name: String, content: String) {
        self.name = name
        self.content = content
    }
}
struct SyncMemoryResult: Decodable { let files: [SyncMemoryFile]; let nextCursor: Int?; let complete: Bool }

// Param encoders. Optionals are synthesized with `encodeIfPresent`, so a nil field is ABSENT on the
// wire (never `null`) — exactly what the daemon's optional schema fields expect.
private struct HeadsParams: Encodable {}
private struct PullParams: Encodable { let sessionId: String; let fromSeq: Int; let cursor: Int? }
private struct PushMetaParams: Encodable {
    let title: String?
    let model: String?
    /// provider-correctness T6. Encoded with `encodeIfPresent` like every optional here, so `nil` is
    /// ABSENT on the wire — which the daemon reads as "unchanged", never "clear". There is
    /// deliberately no way to CLEAR an effort through `sync.push`: `applySyncMeta` writes only the
    /// fields it is given, and a replication meta that could null a column would let a phone that
    /// simply hasn't learned about an override yet wipe one the Mac just set.
    let effort: String?
    let forkedFrom: SessionForkRef?

    /// The ONE construction point, so the wire's title ceiling is enforced structurally rather than
    /// remembered at each call site (whole-branch WB-I1). `SyncPushParams.meta.title` is
    /// `z.string().max(SESSION_TITLE_MAX_CHARS)` and is checked by `parseParams` BEFORE any handler
    /// runs — an over-long title is not clamped server-side, it is a hard INVALID_PARAMS that
    /// re-fires on every pass until the title happens to change. Today's titles all come from the
    /// daemon (already bounded) or from `planFork` (bounded there too); this guard is what keeps a
    /// FUTURE local title source — T11's phone-side titler — from silently wedging a session.
    init(title: String?, model: String?, effort: String?, forkedFrom: SessionForkRef?) {
        self.title = title.map(LocalEventStore.capTitle)
        self.model = model
        self.effort = effort
        self.forkedFrom = forkedFrom
    }
}
private struct PushParams: Encodable { let sessionId: String; let baseSeq: Int; let data: String; let complete: Bool; let meta: PushMetaParams? }
private struct ConfigParams: Encodable {}
private struct MemoryParams: Encodable { let cursor: Int? }

// ------------------------------------------------------------------------------------------------
// SyncClient
// ------------------------------------------------------------------------------------------------

public actor SyncClient {
    private let store: LocalEventStore
    private let conn: RpcConn

    /// Hard ceiling on ONE `sync.push` chunk's base64 payload — the Swift mirror of the protocol's
    /// `SYNC_MAX_CHUNK_B64` (384 KiB), sized so a maximal chunk in its JSON-RPC envelope clears the
    /// phone transport's 1 MiB iroh frame with margin.
    public static let maxChunkBase64 = 384 * 1024
    /// Raw bytes per push chunk, chosen so its base64 (×4/3) stays under `maxChunkBase64` — the same
    /// 256 KiB the daemon's own `sync-core` drill uses (349,528 base64 chars, well under the cap).
    static let rawChunkBytes = 256 * 1024

    /// The base64 length of `raw` bytes — 4 characters per 3-byte group, padded. The arithmetic the
    /// `rawChunkBytes` ↔ `maxChunkBase64` relationship rests on; asserted in the suite (review M3).
    static func base64Length(ofRawBytes raw: Int) -> Int { ((raw + 2) / 3) * 4 }

    /// Raw bytes per push chunk for THIS client — `rawChunkBytes` in production; tests inject a tiny
    /// value to exercise multi-chunk reassembly without a quarter-MiB payload. CLAMPED so no caller
    /// (or future edit) can pick a size whose base64 breaches `maxChunkBase64`, which the daemon
    /// enforces hard with `data: z.string().max(SYNC_MAX_CHUNK_B64)` — over it, the push is refused
    /// outright, and on the phone transport an oversized frame ENDS the connection rather than
    /// returning an error (review M3: the ceiling was a comment, not a guard).
    private let chunkBytes: Int

    public init(store: LocalEventStore, conn: RpcConn) {
        self.init(store: store, conn: conn, chunkBytes: SyncClient.rawChunkBytes)
    }

    init(store: LocalEventStore, conn: RpcConn, chunkBytes: Int) {
        self.store = store
        self.conn = conn
        let maxRaw = (SyncClient.maxChunkBase64 / 4) * 3 // the largest raw size whose base64 still fits
        self.chunkBytes = max(1, min(chunkBytes, maxRaw))
    }

    // MARK: - syncAll

    /// One full reconcile pass: exchange heads, pull every daemon session/range the phone is behind
    /// on, then push every local-ahead session. Called at a turn boundary (never mid-turn), so the
    /// common case is a clean fast-forward in one direction; a genuine two-sided divergence resolves
    /// through the fork dance in `push`.
    /// PER-SESSION ISOLATION (review N-M2): one session's transport error used to abort the whole
    /// reconcile and leave every LATER session unsynced — a single wedged conversation silently
    /// stopping the rest. Each session is now attempted independently; failures are collected and
    /// thrown together as `SyncPassError` at the end, so nothing is swallowed but nothing is blocked
    /// either. `sync.heads` itself still throws directly: without it there is no pass to run.
    @discardableResult
    public func syncAll() async throws -> [SyncHead] {
        let heads = try await headsCall()
        var failures: [(sessionId: String, error: any Error)] = []
        for sessionId in await passSessionIds(heads: heads) {
            do { try await syncSession(sessionId, heads: heads) }
            catch { failures.append((sessionId, error)) }
        }
        if !failures.isEmpty { throw SyncPassError(failures: failures) }
        return heads
    }

    // MARK: - the per-session entry (T12 / T11-review F-8)

    /// `sync.heads` on its own — the pass's opening read, exposed so a caller that drives the pass
    /// SESSION BY SESSION can take the snapshot once and hand it to each leg.
    public func heads() async throws -> [SyncHead] { try await headsCall() }

    /// Every session one pass over `heads` would touch: the daemon's sessions first (in the order
    /// `sync.heads` served them — the pull candidates), then every LOCAL session the snapshot did
    /// not mention (the push-only candidates, in the store's stable id order). Deduped.
    public func passSessionIds(heads: [SyncHead]) async -> [String] {
        var ids: [String] = []
        var seen: Set<String> = []
        for head in heads where seen.insert(head.sessionId).inserted { ids.append(head.sessionId) }
        for meta in await store.sessions() where seen.insert(meta.sessionId).inserted { ids.append(meta.sessionId) }
        return ids
    }

    /// ONE session's leg of a pass: pull what the daemon has that we don't, then push what we have
    /// that it doesn't. `syncAll` is exactly this over `passSessionIds`, so there is one reconcile
    /// implementation and no second code path to drift.
    ///
    /// **Why this exists at all** (T11-review F-8). The phone serializes turns against sync on ONE
    /// store-wide queue, because `LocalEventStore.appendPulledVerbatim` throws `notContiguous` the
    /// moment a pull lands on a log a turn just extended. With `syncAll()` as the only entry, that
    /// queue item is a whole network-bound pass over EVERY session — so a user typing in session B
    /// watched a disabled composer for the duration of a pass that had nothing to do with B. A
    /// per-session queue plus a global barrier does not help: holding the barrier for an indivisible
    /// `syncAll()` IS the store-wide block. Splitting the pass into legs is what makes the caller's
    /// wait bounded by ONE session's reconcile: the app enqueues leg *k*, awaits it, and only then
    /// enqueues leg *k+1*, so a Send tapped mid-pass lands in the FIFO right behind the running leg
    /// instead of behind the whole pass.
    ///
    /// A leg is INDEPENDENT of every other leg: it reads and writes only this session's log and
    /// watermark, and consults `heads` (a value) rather than re-reading the daemon. The only shared
    /// object it touches is the store's registry, which is the actor itself.
    public func syncSession(_ sessionId: String, heads: [SyncHead]) async throws {
        let headsById = Dictionary(uniqueKeysWithValues: heads.map { ($0.sessionId, $0) })

        // 1. PULL: a daemon session the phone has never seen, or is strictly behind on with no local
        //    divergence. A session with local-ahead events (localLast > localSynced) falls through to
        //    the push below, where a real divergence forks rather than clobbering the local tail.
        if let head = headsById[sessionId] {
            let localLast = await store.lastSeq(sessionId: sessionId)
            let localSynced = await store.lastSyncedSeq(sessionId: sessionId)
            if head.lastSeq > localSynced && localLast == localSynced {
                try await pull(head: head, fromSeq: localSynced)
            }
        }

        // 2. PUSH: whenever the local head is ahead of what the daemon has confirmed. Re-read after
        //    the pull — a pull that just fast-forwarded this session leaves nothing to push.
        guard let meta = await store.sessions().first(where: { $0.sessionId == sessionId }),
              meta.lastSeq > meta.lastSyncedSeq else { return }
        try await push(sessionId: sessionId, headsById: headsById)
    }

    // MARK: - pull

    /// Pages `sync.pull` from `fromSeq` to the end, concatenates the base64 pages into the verbatim
    /// tail, and applies it to the store (creating the session when the phone doesn't hold it yet).
    ///
    /// The watermark is set by `applyPull` from the head it ACTUALLY applied — never from `head`,
    /// the `sync.heads` snapshot taken before the pull (review C1). A Mac append landing inside the
    /// pull window makes the pull return more than the snapshot advertised; recording the snapshot
    /// would then leave the session permanently one push away from a spurious fork.
    private func pull(head: SyncHead, fromSeq: Int) async throws {
        let bytes = try await pullBytes(sessionId: head.sessionId, fromSeq: fromSeq)
        try await store.applyPull(sessionId: head.sessionId, data: bytes,
                                  title: .some(head.title), model: .some(head.model),
                                  effort: .some(head.effort), forkedFrom: .some(head.forkedFrom))
    }

    /// Drains `sync.pull` page by page (cursor-resumed) and returns the concatenated raw JSONL bytes.
    private func pullBytes(sessionId: String, fromSeq: Int) async throws -> Data {
        var acc = Data()
        var cursor: Int? = nil
        var guardPages = 0
        while true {
            let raw = try await conn.call(method: METHODS.syncPull,
                                          paramsJSON: encode(PullParams(sessionId: sessionId, fromSeq: fromSeq, cursor: cursor)))
            let page = try JSONDecoder().decode(SyncPullResult.self, from: raw)
            if let chunk = Data(base64Encoded: page.data) { acc.append(chunk) }
            if page.complete { break }
            cursor = page.nextCursor
            guardPages += 1
            if guardPages > 10_000 { throw RpcError(code: ERR_INTERNAL, message: "sync.pull did not terminate") }
        }
        return acc
    }

    // MARK: - push (+ fork)

    /// Pushes a session's local-ahead tail. On `DIVERGED` it branches on `data.lastSeq`:
    ///   • `0`  → the daemon has nothing for this id: re-push the WHOLE log from seq 1 (a creating
    ///            push). NOT a fork — that would spawn a spurious session for a mere retry.
    ///   • `>0` → a genuine two-sided divergence: fork the local branch off and pull the daemon's.
    private func push(sessionId: String, headsById: [String: SyncHead]) async throws {
        let meta = try await metaSnapshot(sessionId)
        let baseSeq = meta.lastSyncedSeq
        let tail = await store.rawTail(sessionId: sessionId, fromSeq: baseSeq)
        if tail.isEmpty { return }
        let pushMeta = PushMetaParams(title: meta.title, model: meta.model, effort: meta.effort,
                                      forkedFrom: meta.forkedFrom)
        do {
            let result = try await pushChunked(sessionId: sessionId, baseSeq: baseSeq, data: tail, meta: pushMeta)
            await store.setLastSyncedSeq(sessionId: sessionId, result.lastSeq)
        } catch let e as RpcError where e.code == ERR_DIVERGED {
            guard let daemonLast = e.divergedLastSeq else { throw e }
            if daemonLast == 0 {
                // Re-push from seq 1 — a creating push over the whole log.
                let whole = await store.rawTail(sessionId: sessionId, fromSeq: 0)
                let result = try await pushChunked(sessionId: sessionId, baseSeq: 0, data: whole, meta: pushMeta)
                await store.setLastSyncedSeq(sessionId: sessionId, result.lastSeq)
            } else {
                try await reconcileDivergence(sessionId: sessionId, baseSeq: baseSeq,
                                              localTail: tail, pushMeta: pushMeta,
                                              daemonHead: headsById[sessionId])
            }
        }
    }

    /// `DIVERGED{lastSeq > 0}` means only that `baseSeq != daemonHead` — it is NOT proof that anything
    /// diverged (review I1). Three ordinary failures produce the identical error while the two logs
    /// agree completely:
    ///   • a push the daemon APPLIED whose acknowledgement was lost (connection drop, iOS suspending
    ///     the app mid-call — routine on this transport),
    ///   • a crash between the daemon's append and this side's sidecar write, and
    ///   • a retry after a fork push failed partway.
    /// Forking on any of them duplicates the conversation on BOTH devices, permanently, by hand-delete
    /// only. So: establish what actually differs before doing anything destructive. Pull the daemon's
    /// range from our own watermark and compare it byte-for-byte against the same local range.
    ///   • daemon ⊇ local (our bytes are a prefix of theirs) → they already HAVE our events; adopt
    ///     their remainder and fast-forward the watermark. NO fork.
    ///   • local ⊃ daemon (they are a strict prefix of us) → a plain fast-forward push from their head.
    ///   • otherwise → the branches genuinely differ: fork.
    private func reconcileDivergence(sessionId: String, baseSeq: Int, localTail: Data,
                                     pushMeta: PushMetaParams, daemonHead: SyncHead?) async throws {
        let daemonTail = try await pullBytes(sessionId: sessionId, fromSeq: baseSeq)

        // N-M3: an EMPTY daemon tail would make `localTail.starts(with: daemonTail)` trivially true
        // (every sequence starts with the empty one) and send us to re-push at the very `baseSeq` that
        // just DIVERGEd — a silent loop. Unreachable for an append-only daemon (it just told us its
        // head is past our base), so say so loudly rather than papering over it.
        guard !daemonTail.isEmpty else {
            throw RpcError(code: ERR_INTERNAL,
                           message: "sync.push DIVERGED for \(sessionId) but sync.pull from \(baseSeq) returned nothing — the daemon's head moved backwards")
        }

        if daemonTail.starts(with: localTail) {
            // Lost ACK (or a crash before the sidecar write): the daemon holds our bytes verbatim,
            // possibly plus events of its own. Append only what we are missing and adopt their head.
            let remainder = daemonTail.subdata(in: localTail.count..<daemonTail.count)
            if remainder.isEmpty {
                await store.setLastSyncedSeq(sessionId: sessionId, await store.lastSeq(sessionId: sessionId))
            } else {
                try await store.applyPull(sessionId: sessionId, data: remainder,
                                          title: .some(daemonHead?.title ?? nil), model: .some(daemonHead?.model ?? nil),
                                          effort: .some(daemonHead?.effort ?? nil),
                                          forkedFrom: .some(daemonHead?.forkedFrom ?? nil))
            }
            return
        }

        if localTail.starts(with: daemonTail) {
            // The daemon is a strict PREFIX of us — nothing diverged, we are simply further ahead
            // than our watermark claimed. Push the remainder from their real head.
            let ahead = localTail.subdata(in: daemonTail.count..<localTail.count)
            guard !ahead.isEmpty else { return }
            let daemonLast = baseSeq + LocalChatSession.split(daemonTail).count
            let result = try await pushChunked(sessionId: sessionId, baseSeq: daemonLast, data: ahead, meta: pushMeta)
            await store.setLastSyncedSeq(sessionId: sessionId, result.lastSeq)
            return
        }

        // Genuine two-sided divergence.
        try await forkAndReconcile(originalId: sessionId, atSeq: baseSeq, daemonHead: daemonHead)
    }

    /// The full reconcile for a GENUINE divergence (only ever reached once `reconcileDivergence` has
    /// byte-proved the branches differ):
    ///   1. PLAN the fork of the entire local log at a DETERMINISTIC id (bytes rewritten at the
    ///      `sessionId` field only, seqs preserved) — computed, not yet written,
    ///   2. push it as a NEW session (`baseSeq: 0`, its own `session_created` opening it), and only
    ///      once that LANDS commit the local copy,
    ///   3. truncate the original's local log back to `atSeq` (the divergent tail now lives in the
    ///      fork) and pull the daemon's branch in its place.
    /// Postcondition: both stores hold BOTH sessions; the fork's log equals the original's pre-fork
    /// log with only the id field rewritten.
    ///
    /// PUSH-THEN-COMMIT, and a deterministic id, together close review I1's third trigger. The old
    /// order (create locally, then push) left an orphaned local fork behind whenever the push failed:
    /// the next pass pushed that orphan as another creating session AND minted a second fresh UUID —
    /// a transient network error accumulating duplicates. Now a failed push leaves nothing at all,
    /// and because the retry derives the SAME id from `originalId + atSeq`, a push that actually
    /// landed before the failure is recognised rather than duplicated.
    private func forkAndReconcile(originalId: String, atSeq: Int, daemonHead: SyncHead?) async throws {
        // The id is derived by `planFork` from the branch point AND the branch content, so a retry of
        // THIS branch recomputes this id while a different branch gets its own (review round 2).
        let plan = try await store.planFork(originalId: originalId, atSeq: atSeq)
        let forkPushMeta = PushMetaParams(title: plan.title, model: plan.model, effort: plan.effort,
                                          forkedFrom: plan.forkedFrom)
        do {
            let result = try await pushChunked(sessionId: plan.newId, baseSeq: 0, data: plan.bytes, meta: forkPushMeta)
            try await store.commitFork(plan, syncedSeq: result.lastSeq)
        } catch let e as RpcError where e.code == ERR_DIVERGED {
            // This id already exists on the daemon. Because the id is content-derived, that normally
            // means THIS EXACT fork landed on an earlier attempt whose acknowledgement we lost — adopt
            // it rather than minting a duplicate. But verify the daemon's bytes really are ours before
            // trusting that: adopting a session whose content differs would mark two divergent replicas
            // "synced" and strand both forever (review round 2, second variant).
            //
            // A PREFIX relation, not equality (T9 round-2 M1, promoted to must-fix by the whole-branch
            // review). `reconcileDivergence` two functions up already settled the semantics for exactly
            // this question: daemon ⊇ local means the daemon HAS our bytes. Once the ack is lost the
            // "(offline copy)" is a live session on the Mac too — one message typed into it makes
            // `remote` our bytes PLUS theirs, which equality read as "different branch" and refused on
            // every pass thereafter (PROBE5: `[threw, threw, threw]`, the original stuck at
            // head=2/synced=1). Adopting the plan's bytes is safe and complete: they are provably the
            // daemon's own prefix, and the next pass's PULL phase fast-forwards the rest.
            guard let head = e.divergedLastSeq, head > 0 else { throw e }
            let remote = try await pullBytes(sessionId: plan.newId, fromSeq: 0)
            guard remote.starts(with: plan.bytes) else {
                throw RpcError(code: ERR_INTERNAL,
                               message: "fork \(plan.newId) exists on the daemon with different bytes — refusing to adopt it and discard this branch")
            }
            try await store.commitFork(plan, syncedSeq: min(head, plan.lastSeq))
        }

        // Reconcile the original: drop the divergent tail, then pull the daemon's branch. The
        // watermark again comes from what was applied, not from the heads snapshot (C1). Ordering is
        // deliberate: the fork is durable on BOTH devices before the original's tail is dropped, so a
        // failure anywhere above leaves the divergent branch recoverable.
        await store.truncate(sessionId: originalId, toSeq: atSeq)
        let branch = try await pullBytes(sessionId: originalId, fromSeq: atSeq)
        try await store.applyPull(sessionId: originalId, data: branch,
                                  title: .some(daemonHead?.title ?? nil), model: .some(daemonHead?.model ?? nil),
                                  effort: .some(daemonHead?.effort ?? nil),
                                  forkedFrom: .some(daemonHead?.forkedFrom ?? nil))
    }

    /// Splits `data` into base64 chunks under `maxChunkBase64` and pushes them in order. `meta` rides
    /// the FINAL (complete) chunk only — the daemon applies it alongside a successful complete
    /// (`syncPush` reads `p.meta` on the final frame). Returns the final result.
    private func pushChunked(sessionId: String, baseSeq: Int, data: Data, meta: PushMetaParams) async throws -> SyncPushResult {
        var offset = 0
        var last: SyncPushResult? = nil
        repeat {
            let end = min(offset + chunkBytes, data.count)
            let slice = data.subdata(in: offset..<end)
            let complete = end >= data.count
            let raw = try await conn.call(method: METHODS.syncPush, paramsJSON: encode(PushParams(
                sessionId: sessionId, baseSeq: baseSeq, data: slice.base64EncodedString(),
                complete: complete, meta: complete ? meta : nil)))
            last = try JSONDecoder().decode(SyncPushResult.self, from: raw)
            offset = end
        } while offset < data.count
        return last!
    }

    // MARK: - config / memory bootstrap (session-less)

    /// `sync.config` — the Exa key, the user's added dangerous domains, the daemon's live default
    /// model AND effort, and its whole model catalogue, for a phone bootstrapping its OWN standalone
    /// chat. See `SyncConfig` for what an empty catalogue or an empty effort means (both are honest
    /// "not told" answers, never a licence to derive one).
    public func fetchConfig() async throws -> SyncConfig {
        let raw = try await conn.call(method: METHODS.syncConfig, paramsJSON: encode(ConfigParams()))
        return try JSONDecoder().decode(SyncConfig.self, from: raw)
    }

    /// `sync.memory` — the full (paged) replica of the shared `_assistant` memory bucket, so the
    /// phone's own context assembler can inject the same memory a Mac chat sees.
    public func fetchMemory() async throws -> [SyncMemoryFile] {
        var files: [SyncMemoryFile] = []
        var cursor: Int? = nil
        var guardPages = 0
        while true {
            let raw = try await conn.call(method: METHODS.syncMemory, paramsJSON: encode(MemoryParams(cursor: cursor)))
            let page = try JSONDecoder().decode(SyncMemoryResult.self, from: raw)
            files.append(contentsOf: page.files)
            if page.complete { break }
            cursor = page.nextCursor
            guardPages += 1
            if guardPages > 10_000 { throw RpcError(code: ERR_INTERNAL, message: "sync.memory did not terminate") }
        }
        return files
    }

    // MARK: - helpers

    private func headsCall() async throws -> [SyncHead] {
        let raw = try await conn.call(method: METHODS.syncHeads, paramsJSON: encode(HeadsParams()))
        return try JSONDecoder().decode(SyncHeadsResult.self, from: raw).sessions
    }

    private func metaSnapshot(_ sessionId: String) async throws -> LocalSessionMeta {
        for meta in await store.sessions() where meta.sessionId == sessionId { return meta }
        throw RpcError(code: ERR_INTERNAL, message: "push: local session \(sessionId) vanished")
    }

    private func encode<T: Encodable>(_ value: T) -> Data { (try? JSONEncoder().encode(value)) ?? Data("{}".utf8) }
}

// JSON-RPC error codes the client branches on (mirror packages/protocol/src/jsonrpc.ts's `ERR`).
let ERR_DIVERGED = -32006
let ERR_INTERNAL = -32603

// `METHODS` string constants the client sends. Kept as a tiny local mirror so NormaChatKit does not
// take a source dependency on the TS protocol's method table for five strings.
enum METHODS {
    static let syncHeads = "sync.heads"
    static let syncPull = "sync.pull"
    static let syncPush = "sync.push"
    static let syncConfig = "sync.config"
    static let syncMemory = "sync.memory"
}
