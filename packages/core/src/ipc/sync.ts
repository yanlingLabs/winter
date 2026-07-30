import { homedir } from "node:os";
import { ERR, SessionEvent, type SyncHeadsResult, type SyncPullParams, type SyncPullResult, type SyncPushParams, type SyncPushResult } from "@norma/protocol";
import type { SessionStore, SyncedEntry } from "../sessions/store";

// ================================================================================================
// Session sync (Chat Slice D task 2) — the daemon side of `sync.heads` / `sync.pull` / `sync.push`.
//
// This is the replication seam between a phone's own chat-session logs and the daemon's. It is the
// highest-stakes surface in the slice: it is the only path by which a remote client can WRITE into
// an append-only log the daemon otherwise owns outright. Three invariants hold it up.
//
//   1. CHAT ONLY, FAIL CLOSED. Every verb resolves the target's `mode` from the index and refuses
//      anything that isn't exactly "chat" — including an ABSENT mode, which is a code session by
//      the store-wide `?? "code"` convention, and including any future mode nobody has written yet.
//      An allowlist, never a denylist (the same reasoning as `HISTORY_EVENT_TYPES` and
//      `REMOTE_ELIGIBLE_SESSION_MODES`): a new Mac-local surface is excluded for free.
//
//   2. NEVER A SILENT OVERWRITE. A push declares the `baseSeq` it believes the daemon is at. If
//      that doesn't match, the daemon refuses with `ERR.DIVERGED` and hands back its own `lastSeq`
//      so the client can fast-forward or fork. There is no code path that truncates or rewrites an
//      existing log.
//
//   3. ATOMIC. A chunked push accumulates in a per-(connection, sessionId) buffer and is validated
//      IN FULL — every line zod-parses, seqs are contiguous from `lastSeq + 1`, every event names
//      this session — before a single byte is written. Any failure discards the buffer and appends
//      nothing. The buffer is also discarded when the connection closes, so a client that vanishes
//      mid-push leaves no memory and no partial log.
//
// Paging is over RAW JSONL BYTES rather than events, which is what makes an event larger than a
// page a non-issue: it just spans pages. See the protocol's own doc comments for the wire shapes.
// ================================================================================================

/** One `sync.pull` page. A quarter of the phone transport's hard frame limit (`maxFrameBytes`,
 *  `1 << 20`, IrohListener.swift): base64 inflates by 4/3, so a full page is ~341 KiB on the wire
 *  and the remaining ~⅔ MiB is headroom for the JSON-RPC envelope — comfortably clear of the limit
 *  that would otherwise drop the connection rather than fail the call. */
export const SYNC_PAGE_BYTES = 256 * 1024;

/** Hard ceiling on ONE (connection, sessionId) reassembly buffer. A push that would exceed it is
 *  refused and the buffer discarded — an unbounded buffer on a remote-reachable verb is a
 *  memory-exhaustion primitive. 32 MiB is far above any plausible chat log (a 400-turn conversation
 *  is single-digit MiB) and far below anything that threatens the daemon. */
export const SYNC_PUSH_BUFFER_MAX_BYTES = 32 * 1024 * 1024;

/** How many DIFFERENT sessions one connection may have mid-push at the same time. The per-buffer
 *  cap above bounds each buffer but not their number; without this, a hostile client could open
 *  arbitrarily many. A real client syncs sessions one at a time (occasionally a few in parallel),
 *  so 16 is generous. */
export const SYNC_MAX_OPEN_PUSHES_PER_CONN = 16;

/** An RPC failure carrying an optional JSON-RPC `data` payload (`RpcError.data`, already part of
 *  the protocol envelope). `ipc/server.ts`'s own `RpcFailure` has no `data` field and lives in a
 *  module this one is imported BY, so this is a sibling type rather than a subclass — the server's
 *  catch reads `code`/`message`/`data` structurally off whatever was thrown. */
export class SyncRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

// ------------------------------------------------------------------------------------------------
// The reassembly buffer
// ------------------------------------------------------------------------------------------------

/** Per-connection, per-session accumulation of `sync.push` chunks. Keyed by `connId` FIRST so a
 *  closing connection can drop everything it owns in one call — and so two connections pushing the
 *  same session id can never see each other's bytes. Nothing here is persisted: a buffer that is
 *  never completed simply dies with the connection (or with the daemon). */
export class SyncPushBuffers {
  private readonly byConn = new Map<number, Map<string, { chunks: Buffer[]; size: number }>>();
  private readonly maxBytes: number;
  private readonly maxOpen: number;

  constructor(opts: { maxBytes?: number; maxOpen?: number } = {}) {
    this.maxBytes = opts.maxBytes ?? SYNC_PUSH_BUFFER_MAX_BYTES;
    this.maxOpen = opts.maxOpen ?? SYNC_MAX_OPEN_PUSHES_PER_CONN;
  }

  /** Appends a chunk and returns the running total. Throws (and DISCARDS the buffer — a client
   *  that blew the cap gets a clean slate, not a poisoned prefix that would corrupt its retry) when
   *  the cap or the open-buffer count would be exceeded. */
  append(connId: number, sessionId: string, chunk: Buffer): number {
    let perSession = this.byConn.get(connId);
    if (!perSession) { perSession = new Map(); this.byConn.set(connId, perSession); }
    let entry = perSession.get(sessionId);
    if (!entry) {
      if (perSession.size >= this.maxOpen) {
        throw new SyncRpcError(ERR.INVALID_PARAMS, `too many concurrent sync.push buffers on this connection (max ${this.maxOpen}) — finish or abandon one before starting another`);
      }
      entry = { chunks: [], size: 0 };
      perSession.set(sessionId, entry);
    }
    if (entry.size + chunk.length > this.maxBytes) {
      this.discard(connId, sessionId);
      throw new SyncRpcError(
        ERR.INVALID_PARAMS,
        `sync.push reassembly buffer would exceed the ${Math.floor(this.maxBytes / (1024 * 1024))} MiB cap for session ${sessionId} — buffer discarded`,
      );
    }
    entry.chunks.push(chunk);
    entry.size += chunk.length;
    return entry.size;
  }

  /** Drains the buffer: returns everything accumulated so far and removes the entry. Calling this
   *  BEFORE validation is deliberate — whatever happens next (success or a thrown error), the
   *  buffer is already gone, so no failure path can leave a stale prefix behind. */
  take(connId: number, sessionId: string): Buffer {
    const perSession = this.byConn.get(connId);
    const entry = perSession?.get(sessionId);
    if (!entry) return Buffer.alloc(0);
    perSession!.delete(sessionId);
    if (perSession!.size === 0) this.byConn.delete(connId);
    return Buffer.concat(entry.chunks);
  }

  discard(connId: number, sessionId: string): void {
    const perSession = this.byConn.get(connId);
    if (!perSession) return;
    perSession.delete(sessionId);
    if (perSession.size === 0) this.byConn.delete(connId);
  }

  /** Called from the socket `close()` handler: every buffer this connection owns is dropped. */
  dropConnection(connId: number): void {
    this.byConn.delete(connId);
  }
}

// ------------------------------------------------------------------------------------------------
// Shared gates
// ------------------------------------------------------------------------------------------------

/** True only for a session whose stored mode is exactly "chat". Absent mode → "code" (the
 *  store-wide convention) → false. An unrecognized future mode → false. Fail-closed by shape. */
export function isChatMode(mode: string | undefined): boolean {
  return (mode ?? "code") === "chat";
}

/** Resolves a target session for `sync.pull`/`sync.push`, or throws the right typed error:
 *  NOT_FOUND for an id the daemon has never heard of, INVALID_PARAMS for a real session that isn't
 *  a chat. Returns `null` ONLY when `allowMissing` — the `sync.push` create path, which must be
 *  able to proceed on an id that doesn't exist yet. */
function resolveChatSession(
  store: SessionStore,
  sessionId: string,
  allowMissing: boolean,
): { mode?: string } | null {
  let meta: { mode?: string } | null = null;
  try { meta = store.meta(sessionId); } catch { meta = null; }
  if (!meta) {
    if (allowMissing) return null;
    throw new SyncRpcError(ERR.NOT_FOUND, `unknown session: ${sessionId}`);
  }
  if (!isChatMode(meta.mode)) {
    throw new SyncRpcError(
      ERR.INVALID_PARAMS,
      `sync is available for chat sessions only — ${sessionId} is a ${meta.mode ?? "code"} session`,
    );
  }
  return meta;
}

// ------------------------------------------------------------------------------------------------
// sync.heads
// ------------------------------------------------------------------------------------------------

/** Every CHAT session the daemon holds, with the head the client needs to diff against. Non-chat
 *  sessions are not merely hidden from the result — they are invisible to this whole surface, so a
 *  client can't learn a code session even exists through it. */
export function syncHeads(store: SessionStore): SyncHeadsResult {
  const sessions = store.list()
    .filter((row) => isChatMode(row.mode))
    .map((row) => ({
      sessionId: row.sessionId,
      lastSeq: row.lastSeq,
      // `null`, never absent: an explicit "this session has no title" is easier for a client to
      // fold than a missing key (which is indistinguishable from an older daemon).
      title: row.title ?? null,
      ...(row.model !== undefined ? { model: row.model } : {}),
      ...(row.forkedFrom !== undefined ? { forkedFrom: row.forkedFrom } : {}),
    }));
  return { sessions };
}

// ------------------------------------------------------------------------------------------------
// sync.pull
// ------------------------------------------------------------------------------------------------

/** One page of the session's raw JSONL tail, base64-encoded.
 *
 *  SECURITY DECISION (deliberate, test-pinned in test/ipc/sync-reasoning-item-decision.test.ts):
 *  this DOES carry `reasoning_item` and the provider-opaque `encrypted_content`/`itemJson` it
 *  wraps. `session.history` — a read-for-DISPLAY surface with an event-type allowlist — still
 *  refuses it, and this task changed neither `HISTORY_EVENT_TYPES` nor its security sweep. The
 *  difference is the point: this is STORE REPLICATION to an already-paired device over the same
 *  end-to-end-encrypted link, and a filtered replica is not a replica — a phone that later pushes
 *  its copy back would rewrite the Mac's log with holes in it. */
export function syncPull(store: SessionStore, p: SyncPullParams): SyncPullResult {
  resolveChatSession(store, p.sessionId, false);
  let page: { bytes: Buffer; nextCursor?: number };
  try {
    page = store.readRawTail(p.sessionId, p.fromSeq, p.cursor ?? 0, SYNC_PAGE_BYTES);
  } catch (e) {
    // A stale cursor is caller input, not a missing session (which resolveChatSession already
    // ruled out above) — INVALID_PARAMS so the client re-pulls from a known-good offset.
    if (e instanceof RangeError) throw new SyncRpcError(ERR.INVALID_PARAMS, (e as Error).message);
    throw new SyncRpcError(ERR.NOT_FOUND, (e as Error).message);
  }
  return {
    data: page.bytes.toString("base64"),
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    complete: page.nextCursor === undefined,
  };
}

// ------------------------------------------------------------------------------------------------
// sync.push
// ------------------------------------------------------------------------------------------------

export interface SyncPushContext {
  store: SessionStore;
  buffers: SyncPushBuffers;
  /** Identifies the socket this push arrived on — the reassembly buffer's first key, and what the
   *  `close()` handler passes to `dropConnection`. */
  connId: number;
  /** Announces a freshly-created session to every authed harness — MUST be the same signal
   *  `session.create` emits (`ipc/server.ts` broadcasts the `session_created` event over
   *  `harnessConns`), so a Mac sidebar learns about a phone-created chat the moment it lands. The
   *  ledgered `session.dispatch` gap — a new session nobody was told about — is exactly what this
   *  parameter exists to avoid reproducing. */
  broadcastCreated(event: SessionEvent): void;
}

/** Parses a reassembled JSONL batch into raw-line/event pairs. Every line must be JSON AND a valid
 *  `SessionEvent`; the first failure throws, so nothing partial is ever handed to the store.
 *  Blank lines are skipped (a client that emits a stray "\n" is not a protocol violation), but
 *  everything else is strict. */
function parseBatch(buf: Buffer): SyncedEntry[] {
  const text = buf.toString("utf8");
  const entries: SyncedEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.length === 0) continue;
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch {
      throw new SyncRpcError(ERR.INVALID_PARAMS, `sync.push line ${i + 1} is not valid JSON — nothing was appended`);
    }
    const parsed = SessionEvent.safeParse(json);
    if (!parsed.success) {
      throw new SyncRpcError(
        ERR.INVALID_PARAMS,
        `sync.push line ${i + 1} is not a valid SessionEvent (${parsed.error.issues.map((iss) => iss.path.join(".") || "(root)").join(", ")}) — nothing was appended`,
      );
    }
    entries.push({ raw, event: parsed.data });
  }
  return entries;
}

/** Buffers a chunk and, on the final one, validates and applies the whole batch atomically.
 *  Returns the current head plus buffering progress; `applied` is true only once bytes are on disk. */
export function syncPush(ctx: SyncPushContext, p: SyncPushParams): SyncPushResult {
  const { store, buffers, connId } = ctx;
  const existing = resolveChatSession(store, p.sessionId, true);
  const creating = existing === null;

  // Pre-flight the CREATE path before buffering a single byte: a client pushing at a base the
  // daemon can't possibly hold, or under an id this daemon will never accept, must be told
  // immediately rather than after streaming 32 MiB into memory.
  if (creating) {
    if (p.baseSeq !== 0) {
      // The daemon has NOTHING for this id. Reported as divergence rather than NOT_FOUND because
      // it is the same situation and the same remedy as any other base mismatch — `lastSeq: 0`
      // tells the client "re-push from seq 1 and I'll create it".
      throw new SyncRpcError(
        ERR.DIVERGED,
        `unknown session ${p.sessionId}: the daemon holds no events for it, so a push must start at baseSeq 0`,
        { lastSeq: 0 },
      );
    }
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(p.sessionId)) {
      // Mirrors SessionStore's own SYNCED_SESSION_ID_RE (which is the real gate — the id becomes a
      // filesystem path component); checked here too so the caller gets INVALID_PARAMS with a
      // useful message instead of the store's raw throw.
      throw new SyncRpcError(ERR.INVALID_PARAMS, `a sync-created session id must be a UUID (got ${JSON.stringify(p.sessionId)})`);
    }
  }

  let chunk: Buffer;
  try { chunk = Buffer.from(p.data, "base64"); }
  catch { throw new SyncRpcError(ERR.INVALID_PARAMS, "sync.push data is not valid base64"); }

  if (!p.complete) {
    const buffered = buffers.append(connId, p.sessionId, chunk);
    return { applied: false, lastSeq: creating ? 0 : store.lastSeq(p.sessionId), buffered };
  }

  // Final chunk. `take` drains the buffer FIRST, so every path below — including every throw —
  // leaves nothing behind for a later push to trip over.
  const buffered = buffers.take(connId, p.sessionId);
  const batch = buffered.length > 0 ? Buffer.concat([buffered, chunk]) : chunk;
  const entries = parseBatch(batch);
  if (entries.length === 0) {
    throw new SyncRpcError(ERR.INVALID_PARAMS, "sync.push with complete:true carried no events");
  }

  // Ownership + contiguity. The store re-checks both (it is the last gate before an append-only
  // file), but checking here turns them into caller-facing INVALID_PARAMS rather than an opaque
  // INTERNAL from a raw store throw.
  for (let i = 0; i < entries.length; i++) {
    const event = entries[i]!.event;
    if (event.sessionId !== p.sessionId) {
      throw new SyncRpcError(ERR.INVALID_PARAMS, `sync.push event ${i + 1} carries sessionId ${event.sessionId}, not ${p.sessionId} — nothing was appended`);
    }
    if (i > 0 && event.seq !== entries[i - 1]!.event.seq + 1) {
      throw new SyncRpcError(ERR.INVALID_PARAMS, `sync.push seqs must be contiguous: event ${i + 1} has seq ${event.seq}, expected ${entries[i - 1]!.event.seq + 1} — nothing was appended`);
    }
  }

  const first = entries[0]!.event;
  let lastSeq: number;
  let createdEvent: SessionEvent | undefined;

  if (creating) {
    if (first.seq !== 1) {
      throw new SyncRpcError(ERR.INVALID_PARAMS, `a creating sync.push must start at seq 1 (got ${first.seq}) — nothing was appended`);
    }
    // The batch's own seq-1 event becomes the log's session_created — the daemon deliberately does
    // NOT mint one (that would shift every following seq). Two consequences make this a hard
    // requirement rather than a nicety:
    //   * a full index.db rebuild derives a session's `mode` from the FIRST event of its log
    //     (SessionStore.recoverAll pass 2, the dispatch-singleton durability fix), so a log that
    //     doesn't open with a chat `session_created` would silently come back as a CODE session —
    //     and would then be refused by this very surface, orphaning the conversation; and
    //   * `sync` creates chat sessions and nothing else, so a `session_created` claiming any other
    //     mode is a request this handler must not grant.
    if (first.type !== "session_created" || first.mode !== "chat") {
      throw new SyncRpcError(
        ERR.INVALID_PARAMS,
        'a creating sync.push must begin with a session_created event carrying mode:"chat" — nothing was appended',
      );
    }
    try {
      store.createSynced(p.sessionId, {
        scope: first.scope,
        // The phone never picks a working directory on this Mac — the same SP3.4 hardening
        // `session.create` applies to remote callers, and the same value `session.dispatch` uses.
        cwd: homedir(),
        // Plan-immunity: a chat session's policy is the fixed internal "chat" value, coerced here
        // exactly as session.create coerces it, never taken from the client.
        approvalPolicy: "chat",
        mode: "chat",
        // Stamped at INSERT so the row is never briefly a fork-less orphan; `applySyncMeta` below
        // re-applies the same values idempotently (it is the only path for an INCREMENTAL push, so
        // it has to run unconditionally anyway).
        ...(p.meta?.model !== undefined ? { model: p.meta.model } : {}),
        ...(p.meta?.forkedFrom !== undefined ? { forkedFrom: p.meta.forkedFrom } : {}),
      });
    } catch (e) {
      throw new SyncRpcError(ERR.INVALID_PARAMS, `sync.push could not create session ${p.sessionId}: ${(e as Error).message}`);
    }
    lastSeq = store.appendSynced(p.sessionId, entries);
    createdEvent = first;
  } else {
    const head = store.lastSeq(p.sessionId);
    if (p.baseSeq !== head) {
      throw new SyncRpcError(
        ERR.DIVERGED,
        `sync.push baseSeq ${p.baseSeq} does not match the daemon's lastSeq ${head} for session ${p.sessionId} — pull and fast-forward, or fork`,
        { lastSeq: head },
      );
    }
    if (first.seq !== head + 1) {
      throw new SyncRpcError(
        ERR.INVALID_PARAMS,
        `sync.push must begin at seq ${head + 1} (got ${first.seq}) — nothing was appended`,
      );
    }
    lastSeq = store.appendSynced(p.sessionId, entries);
  }

  if (p.meta) store.applySyncMeta(p.sessionId, p.meta);
  // Only AFTER the events are durably on disk — a harness told about a session must be able to
  // read it. Mirrors session.create's ordering (create, then broadcast).
  if (createdEvent) ctx.broadcastCreated(createdEvent);

  return { applied: true, lastSeq, buffered: 0 };
}
