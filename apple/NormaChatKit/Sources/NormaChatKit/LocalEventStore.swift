import Foundation
import CryptoKit
import NormaProtocol

// ================================================================================================
// LocalEventStore (Chat Slice D task 9) — the phone's OWN copy of the append-only session log the
// daemon otherwise owns outright. It is the Swift counterpart of `packages/core/src/sessions/store.ts`,
// stripped to exactly what a standalone phone chat needs: per-session JSONL files in a caller-supplied
// directory (the app passes its container), an atomic line append, torn-write recovery on open, and a
// per-session `lastSyncedSeq` watermark the `SyncClient` diffs against.
//
// TWO TYPES, ONE SUBSYSTEM. The engine's `LocalSession` seam (ChatEngine.swift) is SYNCHRONOUS — the
// turn-loop calls `priorInput()`/`appendReasoning()`/`lastSeq` without `await` — so the concrete
// conformer, `LocalChatSession`, is a lock-guarded `@unchecked Sendable` class, NOT an actor (an
// actor's members are async across the isolation boundary and could not satisfy the sync protocol).
// `LocalEventStore` is the `actor` coordinator over the directory and the one-handle-per-session
// registry; it delegates every file operation to the session's handle, so there is exactly ONE lock
// per log file no matter whether the engine (sync) or the SyncClient (async, via the actor) is the
// caller. That is the whole of the concurrency story: the actor serializes registry access, each
// handle's lock serializes its file. `LocalChatSession.init` is internal and every creation path
// registers into `handles`, so the app cannot mint a second handle for a live session.
//
// THE BOUND ON THAT GUARANTEE (review M8): it holds WITHIN one `LocalEventStore`. Two stores opened
// over the SAME container directory would hold two independent `NSLock`s over one file and could
// interleave appends. The app must therefore keep a single store per container for the process's
// lifetime — which is the natural shape (one container, one store, injected once), but it is a
// caller obligation, not something this type can enforce.
//
// RAW BYTES, NOT DECODED EVENTS. The log is stored and replicated as verbatim JSONL bytes, never a
// re-serialization — the byte-identity contract the whole sync surface rests on (see store.ts's
// `appendSynced` doc comment). It also lets the log carry `reasoning_item`, which is deliberately
// NOT a `NormaProtocol.SessionEvent` variant (CLAUDE.md §events: opaque, never rendered): a decoded
// store could not hold it. So indexing/folding parse each line's minimal envelope (`seq`, `sessionId`,
// `type`) with `JSONSerialization`, and `read` hands back both the raw bytes and a best-effort decode
// (nil for `reasoning_item`/unknown) so a caller can render what renders and replicate everything.
// ================================================================================================

/// Where a session was branched from — the Swift mirror of the protocol's `SessionForkRef`
/// (packages/protocol/src/methods.ts) and the daemon store's `SessionForkRef`. Index-only metadata:
/// it rides `sync.push`'s `meta` and `sync.heads`, never the event log.
public struct SessionForkRef: Codable, Equatable, Sendable {
    public let sessionId: String
    public let atSeq: Int
    public init(sessionId: String, atSeq: Int) {
        self.sessionId = sessionId
        self.atSeq = atSeq
    }
}

/// One session's index-only facts, the shape `sessions()` returns and the `SyncClient` diffs.
/// `lastSyncedSeq` is the phone's watermark: the highest seq it has confirmed the daemon holds
/// identically (0 for a session the daemon has never seen). `lastSeq` is the local head.
public struct LocalSessionMeta: Equatable, Sendable {
    public let sessionId: String
    public let scope: String
    public let title: String?
    public let model: String?
    public let lastSeq: Int
    public let lastSyncedSeq: Int
    public let forkedFrom: SessionForkRef?
}

/// One event as it sits in the log: the verbatim line bytes (no trailing newline) plus the minimal
/// envelope every line carries, and a best-effort `SessionEvent` decode. `decoded` is nil for a
/// `reasoning_item` (no Swift variant, by design) or any line a future daemon wrote that this kit
/// doesn't model yet — a renderer skips those, a replicator keeps their bytes.
public struct StoredEvent: Sendable {
    public let seq: Int
    public let sessionId: String
    public let type: String
    public let raw: Data
    public let decoded: SessionEvent?
}

/// A JSONL line that failed the minimal-envelope check is not a valid stored event — surfaced only
/// so recovery can count/rewrite.
enum LocalStoreError: Error, Equatable {
    case notContiguous(expected: Int, got: Int)
    case sessionExists(String)
    case unknownSession(String)
    /// The scoped fork rewrite did not reach every line (see `planFork`'s verification, N-M1).
    case forkRewriteIncomplete(String)
    /// A fork id already exists locally with DIFFERENT bytes — never adopt-and-discard (round 2).
    case forkBytesMismatch(String)
}

// ------------------------------------------------------------------------------------------------
// Minimal line envelope — the fields indexing/recovery/folding read WITHOUT decoding the full event.
// ------------------------------------------------------------------------------------------------

/// The `{ seq, sessionId, type }` envelope every log line carries, parsed with `JSONSerialization`
/// (never `JSONDecoder<SessionEvent>` — that would reject `reasoning_item`). `object` is the whole
/// parsed line, so a folder can read type-specific fields (`text`, `itemJson`, …) off it.
struct LineEnvelope {
    let seq: Int
    let sessionId: String
    let type: String
    let object: [String: Any]

    /// Parses one raw JSONL line, or nil if it is not a JSON object carrying a numeric `seq`, a
    /// non-empty string `sessionId`, and a string `type` — the same "a good line is a parseable,
    /// well-shaped line" posture as the daemon store's `readGoodLines`.
    init?(_ line: Data) {
        guard let any = try? JSONSerialization.jsonObject(with: line),
              let obj = any as? [String: Any],
              let seq = (obj["seq"] as? NSNumber)?.intValue,
              let sessionId = obj["sessionId"] as? String, !sessionId.isEmpty,
              let type = obj["type"] as? String, !type.isEmpty else { return nil }
        self.seq = seq
        self.sessionId = sessionId
        self.type = type
        self.object = obj
    }
}

// ================================================================================================
// LocalChatSession — the per-session file owner and the concrete `LocalSession` the engine drives.
// ================================================================================================

public final class LocalChatSession: LocalSession, @unchecked Sendable {
    public let sessionId: String
    /// Re-derived by `recover()` from the sidecar, else the log's seq-1 `session_created` (review M2:
    /// it must NOT be latched in `init`, which runs BEFORE `createSession` writes that line — the
    /// handle would then latch "global" and `persistSidecarLocked` would make the wrong value
    /// permanent). Guarded by `lock`.
    private var scopeValue: String = "global"
    var scope: String { lock.withLock { scopeValue } }
    private let logURL: URL
    private let metaURL: URL

    private let lock = NSLock()
    private var head: Int            // == lastSeq; guarded by `lock`
    private var syncedSeq: Int       // lastSyncedSeq; guarded by `lock`
    private var title: String?       // guarded by `lock`
    private var model: String?       // guarded by `lock`
    private var forkedFrom: SessionForkRef?  // guarded by `lock`

    /// A sidecar JSON of the index-only facts that have no event of their own — mirrors the columns
    /// the daemon keeps in sqlite (title/model/forkedFrom) plus the phone-only `lastSyncedSeq`.
    private struct MetaSidecar: Codable {
        var scope: String
        var title: String?
        var model: String?
        var lastSyncedSeq: Int
        var forkedFrom: SessionForkRef?
    }

    init(sessionId: String, directory: URL) {
        self.sessionId = sessionId
        self.logURL = directory.appendingPathComponent("\(sessionId).jsonl")
        self.metaURL = directory.appendingPathComponent("\(sessionId).meta.json")
        self.head = 0
        self.syncedSeq = 0
        self.title = nil
        self.model = nil
        self.forkedFrom = nil
    }

    // MARK: recovery

    /// Rebuilds `head`/`scope` from the log and loads the sidecar. Mirrors `SessionStore.recoverAll`'s
    /// posture: read every line, keep only the well-shaped ones, and if ANY line was bad (a torn
    /// final line from a crash mid-append, most commonly) rewrite the file atomically with just the
    /// good lines so a partial tail never poisons a later fold or append. Always called AFTER the log
    /// exists, which is what lets `scope` come from the real seq-1 `session_created` (review M2).
    func recover() {
        lock.withLock {
            let (goodLines, sawBad, lastSeq) = Self.scanLog(logURL)
            if sawBad { Self.atomicWrite(goodLines.isEmpty ? Data() : Self.join(goodLines), to: logURL) }
            head = lastSeq
            // The LOG is the authority for scope (it rides session_created); the sidecar is the
            // fallback for a log whose header predates this field.
            scopeValue = Self.deriveScope(logURL) ?? Self.readSidecar(metaURL)?.scope ?? "global"
            if let s = Self.readSidecar(metaURL) {
                syncedSeq = min(s.lastSyncedSeq, lastSeq) // never claim to have synced past what we hold
                title = s.title
                model = s.model
                forkedFrom = s.forkedFrom
            }
        }
    }

    // MARK: LocalSession conformance

    public var lastSeq: Int { lock.withLock { head } }

    /// Provider-input reconstruction of the persisted log — the faithful Swift port of
    /// `engine.ts`'s `historyInput` fold (the MAIN-THREAD filter + `eventToInput` +
    /// `normalizeReplayOrder`), minus only the checkpoint fast-forward (a chat session is never
    /// compacted, exactly like `childHistoryInput`, so there is no checkpoint to skip past). Reads
    /// every line at turn start; a `reasoning_item` replays VERBATIM through `.reasoning(itemJSON:)`
    /// — the T8 reasoning-replay minor, delegated here — feeding the provider the encrypted state
    /// back for continuity, never rendering it.
    ///
    /// The main-thread filter mirrors `engine.ts:1389` (`if ("threadId" in e && e.threadId !==
    /// MAIN_THREAD) continue`). The phone's own engine only ever stamps `MainThread`, but `sync.push`
    /// accepts any valid `SessionEvent` from any paired client, so a thread-scoped event CAN reach
    /// this log by replication — and it must be as invisible to the phone's context as it is to the
    /// Mac's (review M1).
    public func priorInput() -> [ProviderInputItem] {
        let lines = lock.withLock { Self.scanLog(logURL).lines }
        var input: [ProviderInputItem] = []
        for line in lines {
            guard let env = LineEnvelope(line) else { continue }
            if let threadId = env.object["threadId"] as? String, threadId != MainThread { continue }
            if let item = Self.eventToInput(env) { input.append(item) }
        }
        return Self.normalizeReplayOrder(input)
    }

    /// The only sink for an opaque reasoning item — appended to the log as a `reasoning_item` line
    /// (its ONLY sink, CLAUDE.md §events) and read back by `priorInput()`. Advances the head.
    ///
    /// Guards on an ADVANCING seq exactly as `persist` does (review M7): the log is folded in FILE
    /// order by `priorInput`/`rawTail`/`scanLog`, so writing a stale seq would put a line physically
    /// after lines that outrank it and silently desynchronize seq order from byte order — the one
    /// property replication depends on.
    public func appendReasoning(itemJSON: String, seq: Int, ts: Int) {
        let obj: [String: Any] = [
            "type": "reasoning_item", "sessionId": sessionId, "seq": seq, "ts": ts,
            "threadId": MainThread, "itemJson": itemJSON,
        ]
        guard let line = try? JSONSerialization.data(withJSONObject: obj) else { return }
        lock.withLock {
            guard seq > head else { return }
            Self.appendLine(line, to: logURL)
            head = seq
        }
    }

    // MARK: the persist-on-emit sink

    /// Persists an emitted `SessionEvent`. The daemon-faithful `emit` sink (Task 11 wires
    /// `runTurn(emit:)` to this): a TRANSIENT `assistant_delta` is dropped (its seq rides the head,
    /// it is never in the log — mirrors `hub.broadcastTransient`), every other event is appended
    /// verbatim. Trusts the engine's already-stamped seq (the engine is the single writer and stamps
    /// contiguously from `lastSeq + 1`); a non-advancing seq is ignored defensively so a double-emit
    /// can never rewind the head.
    public func persist(_ event: SessionEvent) {
        if case .assistantDelta = event { return } // transient — never persisted
        guard let data = try? JSONEncoder().encode(event) else { return }
        let seq = Self.seqOf(event)
        lock.withLock {
            guard seq > head else { return }
            Self.appendLine(data, to: logURL)
            head = seq
        }
    }

    /// A `@Sendable` closure form of `persist` for wiring straight into `runTurn(emit:)`.
    public var emit: @Sendable (SessionEvent) -> Void { { [weak self] in self?.persist($0) } }

    // MARK: reads

    /// Every stored event with `seq > fromSeq`, in order, each carrying its verbatim bytes and a
    /// best-effort decode (nil for `reasoning_item`/unknown).
    func readStored(fromSeq: Int) -> [StoredEvent] {
        let lines = lock.withLock { Self.scanLog(logURL).lines }
        var out: [StoredEvent] = []
        for line in lines {
            guard let env = LineEnvelope(line), env.seq > fromSeq else { continue }
            let decoded = try? JSONDecoder().decode(SessionEvent.self, from: line)
            out.append(StoredEvent(seq: env.seq, sessionId: env.sessionId, type: env.type, raw: line, decoded: decoded))
        }
        return out
    }

    /// The verbatim byte tail of every line with `seq > fromSeq` (newline-terminated), the exact
    /// bytes a `sync.push` replicates. Mirrors `SessionStore.readRawTail` (minus paging — the
    /// SyncClient chunks on the way out). Empty `Data` when nothing is past `fromSeq`.
    func rawTail(fromSeq: Int) -> Data {
        let lines = lock.withLock { Self.scanLog(logURL).lines }
        let kept = lines.filter { LineEnvelope($0).map { $0.seq > fromSeq } ?? false }
        return kept.isEmpty ? Data() : Self.join(kept)
    }

    /// The entire log, verbatim — the source bytes a fork copies (before the id rewrite).
    func snapshotRawLog() -> Data { lock.withLock { (try? Data(contentsOf: logURL)) ?? Data() } }

    // MARK: writes used by the sync path

    /// Appends verbatim pulled bytes onto an existing log, validating contiguity: the first pulled
    /// line's seq must be exactly `head + 1`. All-or-nothing — nothing is written if the batch does
    /// not line up. Updates the head to the last pulled seq.
    func appendPulledVerbatim(_ data: Data) throws {
        try lock.withLock {
            let incoming = Self.split(data)
            guard let firstEnv = incoming.first.flatMap({ LineEnvelope($0) }) else { return } // empty page: no-op
            guard firstEnv.seq == head + 1 else { throw LocalStoreError.notContiguous(expected: head + 1, got: firstEnv.seq) }
            var last = head
            for line in incoming {
                guard let env = LineEnvelope(line) else { continue }
                last = env.seq
            }
            Self.appendLine(Self.stripTrailingNewline(data), to: logURL)
            head = last
        }
    }

    /// Truncates the log to keep only lines with `seq <= toSeq` (atomic rewrite), resetting the head.
    /// The fork's original-session reconciliation uses this to drop the divergent tail (which now
    /// lives in the fork) before the daemon's branch is pulled in.
    func truncate(toSeq: Int) {
        lock.withLock {
            let lines = Self.scanLog(logURL).lines
            let kept = lines.filter { LineEnvelope($0).map { $0.seq <= toSeq } ?? false }
            Self.atomicWrite(kept.isEmpty ? Data() : Self.join(kept), to: logURL)
            head = kept.compactMap { LineEnvelope($0)?.seq }.max() ?? 0
            if syncedSeq > head { syncedSeq = head; persistSidecarLocked() }
        }
    }

    // MARK: meta

    func metaSnapshot() -> LocalSessionMeta {
        lock.withLock {
            LocalSessionMeta(sessionId: sessionId, scope: scopeValue, title: title, model: model,
                             lastSeq: head, lastSyncedSeq: syncedSeq, forkedFrom: forkedFrom)
        }
    }

    var lastSyncedSeq: Int { lock.withLock { syncedSeq } }

    /// Records the watermark, CLAMPED to the local head — the same fail-safe direction `recover()`
    /// applies (`min(sidecar, lastSeq)`), now applied on the write side too (review C1). The
    /// watermark means "the daemon holds these bytes identically", so it can never legitimately
    /// exceed what this log actually holds: a caller passing a daemon head that ran ahead of our
    /// copy (a racing append, or a push whose result reflects someone else's events) would otherwise
    /// record a promise the log cannot keep, and the next push would DIVERGE over bytes we never had.
    func setLastSyncedSeq(_ seq: Int) {
        lock.withLock { syncedSeq = min(seq, head); persistSidecarLocked() }
    }

    /// Applies the index-only facts a `sync.heads`/`sync.pull` reported (or a local set): each is
    /// "unchanged" when nil, mirroring `SessionStore.applySyncMeta`'s "omitted → keep" semantics.
    func setSyncedMeta(title: String?? = nil, model: String?? = nil, forkedFrom: SessionForkRef?? = nil) {
        lock.withLock {
            if let title { self.title = title }
            if let model { self.model = model }
            if let forkedFrom { self.forkedFrom = forkedFrom }
            persistSidecarLocked()
        }
    }

    private func persistSidecarLocked() {
        let sidecar = MetaSidecar(scope: scopeValue, title: title, model: model,
                                  lastSyncedSeq: syncedSeq, forkedFrom: forkedFrom)
        if let data = try? JSONEncoder().encode(sidecar) { Self.atomicWrite(data, to: metaURL) }
    }

    // MARK: - static file helpers

    private static func seqOf(_ event: SessionEvent) -> Int {
        guard let data = try? JSONEncoder().encode(event),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let seq = (obj["seq"] as? NSNumber)?.intValue else { return -1 }
        return seq
    }

    /// Scans a log file into its well-shaped lines. Returns the good lines (verbatim, no newline),
    /// whether any bad line was seen (torn/unparseable — triggers an atomic rewrite by the caller),
    /// and the head seq (the last good line's seq, 0 if none).
    static func scanLog(_ url: URL) -> (lines: [Data], sawBad: Bool, lastSeq: Int) {
        guard let raw = try? Data(contentsOf: url) else { return ([], false, 0) }
        var lines: [Data] = []
        var sawBad = false
        var lastSeq = 0
        for line in split(raw) {
            if let env = LineEnvelope(line) { lines.append(line); lastSeq = env.seq }
            else { sawBad = true } // torn/unparseable line — skip, don't stop; flag a rewrite
        }
        return (lines, sawBad, lastSeq)
    }

    /// Splits raw JSONL bytes into per-line `Data`, dropping empty lines (a stray "\n" is not a line).
    static func split(_ data: Data) -> [Data] {
        guard !data.isEmpty else { return [] }
        return data.split(separator: 0x0A, omittingEmptySubsequences: true).map { Data($0) }
    }

    static func join(_ lines: [Data]) -> Data {
        var out = Data()
        for line in lines { out.append(line); out.append(0x0A) }
        return out
    }

    static func stripTrailingNewline(_ data: Data) -> Data {
        var d = data
        while d.last == 0x0A { d.removeLast() }
        return d
    }

    /// Appends one line (no trailing newline in `line`) plus a newline, in a single write — the
    /// atomic-enough unit the daemon's `appendFileSync` also relies on, backstopped by `recover()`'s
    /// torn-line rewrite on the next open.
    static func appendLine(_ line: Data, to url: URL) {
        var payload = line
        payload.append(0x0A)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: payload)
        } else {
            // File does not exist yet (a fresh session's first line) — create it with these bytes.
            try? payload.write(to: url, options: .atomic)
        }
    }

    /// ATOMIC REPLACE — write-temp + `rename(2)`, in ONE step, exactly the posture the daemon store
    /// takes (`store.ts`'s `writeFileSync(tmp)` + `renameSync(tmp, path)`).
    ///
    /// `Foundation.Data.write(options: .atomic)` is that primitive. The earlier
    /// `removeItem` + `moveItem` spelling was NOT atomic (review I2): it unlinks the destination
    /// first, leaving a window in which the log does not exist at all — a kill inside it (iOS jetsam,
    /// force-quit, panic) destroys the whole conversation rather than leaving a torn tail `recover()`
    /// could repair. Every rewrite path routes through here — `recover`'s repair, `truncate`,
    /// `applyPull`'s create branch, `commitFork`, and the sidecar — so the reader always observes
    /// either the complete old file or the complete new one, never neither.
    static func atomicWrite(_ data: Data, to url: URL) {
        try? data.write(to: url, options: .atomic)
    }

    private static func readSidecar(_ url: URL) -> MetaSidecar? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(MetaSidecar.self, from: data)
    }

    /// The scope of an existing log, read from its seq-1 `session_created` (for a session whose
    /// sidecar was lost). nil when the log is empty/unreadable.
    static func deriveScope(_ url: URL) -> String? {
        guard let raw = try? Data(contentsOf: url), let first = split(raw).first,
              let env = LineEnvelope(first), env.type == "session_created" else { return nil }
        return env.object["scope"] as? String
    }

    // MARK: - historyInput fold (port of engine.ts)

    /// The ONE event→input mapping, faithful to `engine.ts`'s `eventToInput`. Reads the type-specific
    /// fields off the already-parsed line. Returns nil for events with no provider shape
    /// (session_created, turn_started/completed, question_asked/resolved, agent_error, …).
    static func eventToInput(_ env: LineEnvelope) -> ProviderInputItem? {
        let o = env.object
        switch env.type {
        case "user_message":
            guard let text = o["text"] as? String else { return nil }
            return .message(role: .user, content: text)
        case "assistant_message":
            guard let text = o["text"] as? String else { return nil }
            return .message(role: .assistant, content: text)
        case "tool_call":
            guard let callId = o["callId"] as? String, let name = o["name"] as? String,
                  let args = o["argsJson"] as? String else { return nil }
            return .functionCall(callId: callId, name: name, argumentsJSON: args)
        case "tool_result":
            guard let callId = o["callId"] as? String, let output = o["output"] as? String else { return nil }
            let isError = (o["isError"] as? Bool) ?? false
            return .toolResult(callId: callId, output: output, isError: isError)
        case "reasoning_item":
            guard let itemJSON = o["itemJson"] as? String else { return nil }
            return .reasoning(itemJSON: itemJSON)
        case "task_notification":
            guard let content = o["content"] as? String else { return nil }
            return .message(role: .user, content: content)
        default:
            return nil
        }
    }

    /// Replay-order normalization — the faithful port of `engine.ts`'s `normalizeReplayOrder`: any
    /// `message` items found between a `function_call` and its matching `tool_result` are deferred to
    /// immediately after that result. A no-op for a chat log today (chat never steers a user_message
    /// mid-pair), applied for parity and to guard any future mid-pair message source.
    static func normalizeReplayOrder(_ input: [ProviderInputItem]) -> [ProviderInputItem] {
        var out: [ProviderInputItem] = []
        var openCallId: String? = nil
        var buffer: [ProviderInputItem] = []
        for item in input {
            switch item {
            case .functionCall(let callId, _, _):
                if !buffer.isEmpty { out.append(contentsOf: buffer); buffer = [] }
                openCallId = callId
                out.append(item)
            case .toolResult(let callId, _, _) where openCallId != nil && callId == openCallId:
                out.append(item)
                if !buffer.isEmpty { out.append(contentsOf: buffer); buffer = [] }
                openCallId = nil
            case .message where openCallId != nil:
                buffer.append(item)
            default:
                out.append(item)
            }
        }
        if !buffer.isEmpty { out.append(contentsOf: buffer) }
        return out
    }
}

// ================================================================================================
// LocalEventStore — the actor coordinator: directory + one-handle-per-session registry.
// ================================================================================================

public actor LocalEventStore {
    private let directory: URL
    private var handles: [String: LocalChatSession] = [:]

    /// Opens (creating if needed) a store rooted at `directory`, then recovers every `*.jsonl` it
    /// finds — the phone's cold-start rebuild, mirroring `SessionStore.recoverAll` at open.
    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for entry in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            guard entry.pathExtension == "jsonl" else { continue }
            let sessionId = entry.deletingPathExtension().lastPathComponent
            let handle = LocalChatSession(sessionId: sessionId, directory: directory)
            handle.recover()
            handles[sessionId] = handle
        }
    }

    // MARK: registry

    /// The one handle for `sessionId`, or nil if this store has never seen it.
    public func session(_ sessionId: String) -> LocalChatSession? { handles[sessionId] }

    /// Creates a brand-new local chat session: writes its seq-1 `session_created` (mode "chat", so a
    /// later push satisfies the daemon's index-rebuild requirement) and returns the handle. The
    /// caller then drives turns through it and the engine appends from seq 2 upward.
    @discardableResult
    public func createSession(sessionId: String, scope: String = "global", model: String? = nil,
                              ts: Int = Int(Date().timeIntervalSince1970 * 1000)) throws -> LocalChatSession {
        if handles[sessionId] != nil { throw LocalStoreError.sessionExists(sessionId) }
        let handle = LocalChatSession(sessionId: sessionId, directory: directory)
        let created: [String: Any] = ["type": "session_created", "sessionId": sessionId, "seq": 1, "ts": ts, "scope": scope, "mode": "chat"]
        if let line = try? JSONSerialization.data(withJSONObject: created) {
            LocalChatSession.appendLine(line, to: directory.appendingPathComponent("\(sessionId).jsonl"))
        }
        handle.recover()
        if let model { handle.setSyncedMeta(model: .some(model)) }
        handles[sessionId] = handle
        return handle
    }

    // MARK: the brief's per-session surface, routed by sessionId

    /// Persists an emitted event onto its own session's log (the `emit` sink, when routed through
    /// the store rather than a captured handle). Throws for a session this store doesn't hold.
    public func append(_ event: SessionEvent) throws {
        let sid = LocalEventStore.sessionId(of: event)
        guard let handle = handles[sid] else { throw LocalStoreError.unknownSession(sid) }
        handle.persist(event)
    }

    public func read(sessionId: String, fromSeq: Int) -> [StoredEvent] {
        handles[sessionId]?.readStored(fromSeq: fromSeq) ?? []
    }

    public func lastSeq(sessionId: String) -> Int { handles[sessionId]?.lastSeq ?? 0 }

    public func lastSyncedSeq(sessionId: String) -> Int { handles[sessionId]?.lastSyncedSeq ?? 0 }

    /// Every session's index-only facts, in stable id order — the `SyncClient`'s local half of the
    /// heads diff and Task 11's sidebar source.
    public func sessions() -> [LocalSessionMeta] {
        handles.values.map { $0.metaSnapshot() }.sorted { $0.sessionId < $1.sessionId }
    }

    // MARK: sync-support surface (SyncClient consumes these)

    func rawTail(sessionId: String, fromSeq: Int) -> Data { handles[sessionId]?.rawTail(fromSeq: fromSeq) ?? Data() }

    func snapshotRawLog(sessionId: String) -> Data { handles[sessionId]?.snapshotRawLog() ?? Data() }

    /// Applies a pulled range. Creates the session from the pulled bytes when the store doesn't hold
    /// it yet (the batch opens with the daemon's own seq-1 `session_created`), else appends verbatim
    /// with a contiguity check. Then records the reported index facts and advances `lastSyncedSeq`.
    ///
    /// THE WATERMARK COMES FROM WHAT WAS ACTUALLY APPLIED, never from the caller's `sync.heads`
    /// snapshot (review C1). A `sync.pull` returns everything past `fromSeq` *as of the moment the
    /// daemon serves it*, so a Mac append landing inside the pull window makes the applied head
    /// EXCEED the head `sync.heads` reported moments earlier. Recording the stale snapshot would
    /// leave `lastSyncedSeq < lastSeq` over bytes the daemon itself authored — and the very next push
    /// would then declare a `baseSeq` behind the daemon's head, DIVERGE, and mint a spurious
    /// "(offline copy)" fork on every pass, forever. Everything applied here came FROM the daemon, so
    /// the post-apply head is exactly the right watermark. Returns it.
    @discardableResult
    func applyPull(sessionId: String, data: Data, title: String??, model: String??,
                   forkedFrom: SessionForkRef??) throws -> Int {
        let handle: LocalChatSession
        if let existing = handles[sessionId] {
            handle = existing
            try existing.appendPulledVerbatim(data)
        } else {
            handle = LocalChatSession(sessionId: sessionId, directory: directory)
            LocalChatSession.atomicWrite(LocalChatSession.stripTrailingNewline(data).isEmpty ? Data() : data, to: logURL(sessionId))
            handle.recover()
            handles[sessionId] = handle
        }
        handle.setSyncedMeta(title: title, model: model, forkedFrom: forkedFrom)
        let applied = handle.lastSeq
        handle.setLastSyncedSeq(applied)
        return applied
    }

    func setLastSyncedSeq(sessionId: String, _ seq: Int) { handles[sessionId]?.setLastSyncedSeq(seq) }

    func setSyncedMeta(sessionId: String, title: String?? = nil, model: String?? = nil, forkedFrom: SessionForkRef?? = nil) {
        handles[sessionId]?.setSyncedMeta(title: title, model: model, forkedFrom: forkedFrom)
    }

    func truncate(sessionId: String, toSeq: Int) { handles[sessionId]?.truncate(toSeq: toSeq) }

    /// A fork, computed but NOT yet written: the rewritten bytes plus the metadata the push must
    /// carry. Splitting preview from commit is what makes a failed fork push leave NOTHING behind
    /// (review I1's third trigger) — the local copy is only created once the daemon has the bytes.
    struct ForkPlan: Sendable {
        let newId: String
        let bytes: Data
        let title: String
        let model: String?
        let forkedFrom: SessionForkRef
        let lastSeq: Int
    }

    /// PURE: computes the fork of `originalId` at `atSeq` without touching the filesystem or the
    /// registry. The whole log is copied with each event's `sessionId` FIELD rewritten (seqs
    /// preserved); `forkedFrom` + a marked title are prepared for the push's `meta`.
    ///
    /// THE FORK ID IS DERIVED FROM THE BRANCH CONTENT, not just the branch point (review round 2). A
    /// point-only id (`SHA256(originalId:atSeq)`) is idempotent for a RETRY of the same branch — which
    /// is what it was introduced for — but it also collides across DIFFERENT branches forked at the
    /// same seq, and the adopt path then discarded the second one silently (PROBE4). Hashing the
    /// SOURCE log as well keeps every property intact: a genuine retry hashes identically (same bytes
    /// → same id → recognised, never duplicated), while a genuinely different branch gets a different
    /// id and therefore survives. The hash is over the pre-rewrite bytes deliberately — hashing the
    /// rewritten output would be circular, since the rewrite needs the id.
    func planFork(originalId: String, atSeq: Int,
                  titleMarker: String = LocalEventStore.forkTitleSuffix) throws -> ForkPlan {
        guard let original = handles[originalId] else { throw LocalStoreError.unknownSession(originalId) }
        let sourceBytes = original.snapshotRawLog()
        let newId = LocalEventStore.forkId(originalId: originalId, atSeq: atSeq, contentOf: sourceBytes)
        let rewritten = LocalEventStore.rewriteSessionId(sourceBytes, from: originalId, to: newId)

        // N-M1: the scoped rewrite swaps a literal token, so VERIFY it actually applied to every line
        // rather than trusting that no writer ever emits `"sessionId" : "…"` with spaces. Failing loudly
        // here beats shipping a fork whose lines still carry the original id — which the daemon would
        // reject with a confusing "event carries sessionId X, not Y". This is also the assertion the
        // whole I3 field-scoping argument rests on.
        for line in LocalChatSession.split(rewritten) {
            guard let env = LineEnvelope(line), env.sessionId == newId else {
                throw LocalStoreError.forkRewriteIncomplete(originalId)
            }
        }

        let originalMeta = original.metaSnapshot()
        return ForkPlan(newId: newId, bytes: rewritten,
                        title: (originalMeta.title ?? "Chat") + titleMarker,
                        model: originalMeta.model,
                        forkedFrom: SessionForkRef(sessionId: originalId, atSeq: atSeq),
                        lastSeq: originalMeta.lastSeq)
    }

    /// Commits a planned fork locally, AFTER its push has landed on the daemon. Idempotent for a true
    /// retry: a fork already registered whose bytes ARE the plan's just re-records its watermark, so a
    /// partially-completed reconcile converges instead of duplicating.
    ///
    /// It REFUSES to adopt an existing log whose bytes differ from the plan's (review round 2). The
    /// old unconditional adopt is what made PROBE4 lose a whole branch: it kept the existing log and
    /// silently dropped `plan.bytes`, and the caller then truncated the original — so branch two
    /// existed on neither device. Content-derived ids make a mismatch here essentially unreachable;
    /// this throw is what makes "a fork is never silently discarded" structural rather than a property
    /// of the hash.
    @discardableResult
    func commitFork(_ plan: ForkPlan, syncedSeq: Int) throws -> LocalSessionMeta {
        let handle: LocalChatSession
        if let existing = handles[plan.newId] {
            guard existing.snapshotRawLog() == plan.bytes else {
                throw LocalStoreError.forkBytesMismatch(plan.newId)
            }
            handle = existing
        } else {
            LocalChatSession.atomicWrite(plan.bytes, to: logURL(plan.newId))
            handle = LocalChatSession(sessionId: plan.newId, directory: directory)
            handle.recover()
            handles[plan.newId] = handle
        }
        handle.setSyncedMeta(title: .some(plan.title), model: .some(plan.model), forkedFrom: .some(plan.forkedFrom))
        handle.setLastSyncedSeq(syncedSeq)
        return handle.metaSnapshot()
    }

    // MARK: helpers

    private func logURL(_ sessionId: String) -> URL { directory.appendingPathComponent("\(sessionId).jsonl") }

    /// Suffix appended to a fork's title so the user can tell the divergent local copy from the
    /// daemon's canonical branch. Public so Task 11's sidebar can key on it.
    public static let forkTitleSuffix = " (offline copy)"

    /// A fork's id: deterministic in its branch POINT **and** its branch CONTENT, shaped as a
    /// v4-looking UUID because the daemon's creating-push path requires that form
    /// (`sync.ts`'s `SYNCED_SESSION_ID_RE`).
    ///
    /// Both halves are load-bearing. The branch point makes a RETRY of the same reconcile derive the
    /// same id, so a fork push that landed before a lost acknowledgement is recognised instead of
    /// duplicated (review I1). The content hash makes a DIFFERENT branch forked at the same seq derive
    /// a DIFFERENT id, so it cannot collide with — and be silently discarded in favour of — the first
    /// one (review round 2 / PROBE4).
    static func forkId(originalId: String, atSeq: Int, contentOf source: Data) -> String {
        var content = SHA256()
        content.update(data: source)
        let contentHex = content.finalize().map { String(format: "%02x", $0) }.joined()

        var hasher = SHA256()
        hasher.update(data: Data("norma-chat-fork:\(originalId):\(atSeq):\(contentHex)".utf8))
        var bytes = Array(hasher.finalize().prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x40 // version 4
        bytes[8] = (bytes[8] & 0x3F) | 0x80 // RFC 4122 variant
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let s = { (lo: Int, hi: Int) in String(hex[hex.index(hex.startIndex, offsetBy: lo)..<hex.index(hex.startIndex, offsetBy: hi)]) }
        return "\(s(0, 8))-\(s(8, 12))-\(s(12, 16))-\(s(16, 20))-\(s(20, 32))"
    }

    static func sessionId(of event: SessionEvent) -> String {
        guard let data = try? JSONEncoder().encode(event),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sid = obj["sessionId"] as? String else { return "" }
        return sid
    }

    /// Rewrites the session id of every line — SCOPED TO THE `sessionId` FIELD, never a whole-document
    /// substring swap (review I3).
    ///
    /// The naive `replacingOccurrences(of: id)` also rewrites an id that legitimately appears in event
    /// CONTENT — a user who types "why is session <uuid> stuck?" would have their own message silently
    /// edited. That is not a hypothetical rounding error: after `forkAndReconcile` the original is
    /// truncated and overwritten with the daemon's branch, so the fork is the ONLY surviving copy of
    /// the user's divergent offline conversation.
    ///
    /// The scoped token is `"sessionId":"<from>"`. That form can ONLY be the envelope's key/value
    /// pair, because inside a JSON string every quote is escaped (`\"sessionId\":\"…\"`), so the
    /// unescaped token cannot occur in content — and every writer here emits compact JSON with no
    /// space around the colon (`JSONEncoder`/`JSONSerialization` and the daemon's `JSON.stringify`
    /// all agree). A neighbouring key that merely ENDS in `sessionId` (`childSessionId`) does not
    /// match either: the leading quote must be immediately before `sessionId`. Everything outside
    /// that token is preserved byte-for-byte, so the postcondition stays literally true — the fork is
    /// the original's bytes with only the id field rewritten.
    static func rewriteSessionId(_ data: Data, from: String, to: String) -> Data {
        let text = String(decoding: data, as: UTF8.self)
        let token = "\"sessionId\":\"\(from)\""
        let replacement = "\"sessionId\":\"\(to)\""
        return Data(text.replacingOccurrences(of: token, with: replacement).utf8)
    }
}
