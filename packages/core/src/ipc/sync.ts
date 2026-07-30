import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ERR, SessionEvent, SESSION_TITLE_MAX_CHARS, type SyncConfigResult, type SyncHeadsResult, type SyncMemoryResult, type SyncPullParams, type SyncPullResult, type SyncPushParams, type SyncPushResult } from "@norma/protocol";
import { resolveModelAlias } from "../agent/model-aliases";
import { assistantMemoryDirFor } from "../agent/memory-dir";
import { EXA_API_KEY_SECRET } from "../agent/tools/search";
import type { SessionForkRef, SessionStore, SyncedEntry } from "../sessions/store";

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
//
// WHAT A PAIRED CLIENT CAN DO HERE, stated plainly (branch-review adjudication). Replication is
// bidirectional by design, so a paired phone may push into ANY chat session on this Mac — not only
// the ones it created, but ones the user opened and authored on the Mac itself. Since a pushed
// batch may contain any valid SessionEvent, that includes forging an `assistant_message` or
// `tool_result` that `AgentEngine.historyInput` will replay into the model on the next turn: a
// prompt-injection primitive scoped to chat sessions. It is NOT an escalation — it stays inside the
// pairing trust boundary, and chat mode has no filesystem, shell or repo tools — and it is the
// unavoidable cost of byte-verbatim replication (an event-type allowlist would break both the
// reasoning_item decision below and the byte-identity contract). Recorded here so the bound is
// visible at the seam rather than only in a review document.
//
// Chat Slice D task 3 adds two READ-ONLY, session-less siblings further down this file:
// `sync.config` (the Exa key + the user's added dangerous domains + the live default model — a
// freshly-paired phone's bootstrap for its OWN standalone chat) and `sync.memory` (a paged replica
// of the shared `_assistant` memory bucket, so the phone's local assembler can inject the same
// memory a Mac chat session sees). Neither takes a `sessionId`, so neither touches the chat-only
// gate or the push buffer above at all.
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

/** The index-only metadata a push may carry, after validation. */
export interface SyncMeta { title?: string; model?: string; forkedFrom?: SessionForkRef }

/** Validates `sync.push`'s `meta` before ANY of it reaches the index.
 *
 *  `model` runs the SAME idiom `session.setModel` does (`ipc/server.ts`, itself the product of
 *  Task 1's fix round): resolve an unambiguous alias, then require membership when the provider can
 *  enumerate its models, and store freely when it can't (an arbitrary OpenAI-compatible endpoint
 *  can't validate anything, so neither can we). `sync.push` writes the very same column over the
 *  very same remote allowlist, so skipping this would re-open exactly the failure Task 1 closed:
 *  `AgentEngine.resolveSel` hands `meta.model` straight to the provider, so one unknown slug bricks
 *  EVERY subsequent turn on that session, with no UI signal and no way for the phone to clear it.
 *
 *  An unknown slug is DROPPED, not fatal. That is a deliberate policy choice between two options:
 *  failing the whole push would let a phone/Mac model mismatch block log replication indefinitely —
 *  and the events are the irreplaceable half, while the model is a hint the user can re-set. It
 *  also cannot half-apply: the batch still lands in full and the column simply keeps whatever it
 *  already had (in particular, a bad push can never overwrite a good model with a broken one).
 *
 *  `title` is clamped as defence in depth — `SyncPushParams` already rejects an over-long one at
 *  the wire, and `SessionStore` clamps on both write and read; this covers any non-RPC caller. */
export function validateSyncMeta(
  meta: { title?: string; model?: string; forkedFrom?: SessionForkRef },
  knownModelIds: string[],
  onDroppedModel?: (slug: string) => void,
): SyncMeta {
  const out: SyncMeta = {};
  if (meta.title !== undefined) {
    // Ellipsis INSIDE the budget, same as `SessionStore.capTitle` (whole-branch WB-I1) — a clamp
    // that emits MAX + 1 produces a title the wire schema above then rejects.
    out.title = meta.title.length <= SESSION_TITLE_MAX_CHARS ? meta.title : `${meta.title.slice(0, SESSION_TITLE_MAX_CHARS - 1)}…`;
  }
  if (meta.forkedFrom !== undefined) out.forkedFrom = meta.forkedFrom;
  if (meta.model !== undefined) {
    if (knownModelIds.length === 0) {
      out.model = meta.model; // provider can't enumerate — nothing to check against
    } else {
      const resolved = resolveModelAlias(meta.model, knownModelIds);
      if (knownModelIds.includes(resolved)) out.model = resolved;
      else onDroppedModel?.(meta.model);
    }
  }
  return out;
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
  /** The daemon's model catalogue, for validating a pushed `meta.model` — the SAME source
   *  `session.setModel` consults (`AgentEngine.knownModels()`). Absent, or empty, means the
   *  provider can't enumerate its models, in which case a pushed value is stored freely; see
   *  `validateSyncMeta`. */
  knownModelIds?(): string[];
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

  // Pre-flight before buffering a single byte: a client pushing at a base the daemon can't
  // possibly hold, or under an id this daemon will never accept, must be told immediately rather
  // than after streaming 32 MiB into memory. For an EXISTING session that means checking `baseSeq`
  // here rather than only on the final chunk (review M5) — a client that is already behind
  // discovers it on its first frame instead of after uploading the whole batch.
  if (!creating && p.baseSeq !== store.lastSeq(p.sessionId)) {
    const head = store.lastSeq(p.sessionId);
    throw new SyncRpcError(
      ERR.DIVERGED,
      `sync.push baseSeq ${p.baseSeq} does not match the daemon's lastSeq ${head} for session ${p.sessionId} — pull and fast-forward, or fork`,
      { lastSeq: head },
    );
  }
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

  // `Buffer.from(s, "base64")` NEVER throws — it silently discards non-alphabet characters — so a
  // try/catch here would be dead code and garbage would resurface downstream as a baffling "line 1
  // is not valid JSON" (review M1). Round-tripping the re-encode is an exact check with none of a
  // regex's padding subtleties: it accepts precisely what a standard encoder emits.
  const chunk = Buffer.from(p.data, "base64");
  if (chunk.toString("base64") !== p.data) {
    throw new SyncRpcError(ERR.INVALID_PARAMS, "sync.push data is not valid standard (padded) base64");
  }

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
  const meta = p.meta
    ? validateSyncMeta(p.meta, ctx.knownModelIds?.() ?? [], (slug) =>
        console.warn(`[sync] dropped unknown model ${JSON.stringify(slug)} pushed for session ${p.sessionId} — the log was replicated, the model override was not`))
    : undefined;
  let lastSeq: number;
  let createdEvent: SessionEvent | undefined;

  // A batch that STARTS a log (seq 1) must open with a chat `session_created`. Keyed on the seq,
  // NOT on `creating` (review M2): a row can exist at `last_seq === 0` — the narrow window where
  // `createSynced` succeeded and `appendSynced` then threw — and would otherwise take the
  // incremental branch below and skip this check entirely, admitting a headerless log. Two
  // consequences make this a hard requirement rather than a nicety:
  //   * a full index.db rebuild derives a session's `mode` from the FIRST event of its log
  //     (SessionStore.recoverAll pass 2, the dispatch-singleton durability fix), so a log that
  //     doesn't open with a chat `session_created` would silently come back as a CODE session —
  //     and would then be refused by this very surface, orphaning the conversation; and
  //   * `sync` creates chat sessions and nothing else, so a `session_created` claiming any other
  //     mode is a request this handler must not grant.
  if (first.seq === 1 && (first.type !== "session_created" || first.mode !== "chat")) {
    throw new SyncRpcError(
      ERR.INVALID_PARAMS,
      'a sync.push that starts a log (seq 1) must begin with a session_created event carrying mode:"chat" — nothing was appended',
    );
  }

  if (creating) {
    if (first.seq !== 1) {
      throw new SyncRpcError(ERR.INVALID_PARAMS, `a creating sync.push must start at seq 1 (got ${first.seq}) — nothing was appended`);
    }
    // The batch's own seq-1 event becomes the log's session_created — the daemon deliberately does
    // NOT mint one (that would shift every following seq); the guard above is what enforces that
    // the client actually supplied it.
    const header = first as Extract<SessionEvent, { type: "session_created" }>;
    try {
      store.createSynced(p.sessionId, {
        scope: header.scope,
        // The phone never picks a working directory on this Mac — the same SP3.4 hardening
        // `session.create` applies to remote callers, and the same value `session.dispatch` uses.
        cwd: homedir(),
        // Plan-immunity: a chat session's policy is the fixed internal "chat" value, coerced here
        // exactly as session.create coerces it, never taken from the client.
        approvalPolicy: "chat",
        mode: "chat",
        // Stamped at INSERT so the row is never briefly a fork-less orphan; `applySyncMeta` below
        // re-applies the same VALIDATED values idempotently (it is the only path for an INCREMENTAL
        // push, so it has to run unconditionally anyway).
        ...(meta?.model !== undefined ? { model: meta.model } : {}),
        ...(meta?.forkedFrom !== undefined ? { forkedFrom: meta.forkedFrom } : {}),
      });
    } catch (e) {
      throw new SyncRpcError(ERR.INVALID_PARAMS, `sync.push could not create session ${p.sessionId}: ${(e as Error).message}`);
    }
    // If this throws the row is left behind at last_seq 0 — harmless, because the seq-1 guard above
    // is keyed on the batch rather than on `creating`, so the only batch that can ever complete
    // that row is a properly-headed one. Surfaced as INTERNAL: every validation the store repeats
    // has already passed here, so reaching it means a real I/O failure, not caller input.
    try { lastSeq = store.appendSynced(p.sessionId, entries); }
    catch (e) { throw new SyncRpcError(ERR.INTERNAL, `sync.push could not append to ${p.sessionId}: ${(e as Error).message}`); }
    createdEvent = first;
  } else {
    // `baseSeq` was already matched against the head before buffering (review M5); re-read it here
    // because a chunked push may have spanned other work on this daemon in between.
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

  if (meta) store.applySyncMeta(p.sessionId, meta);
  // Only AFTER the events are durably on disk — a harness told about a session must be able to
  // read it. Mirrors session.create's ordering (create, then broadcast).
  if (createdEvent) ctx.broadcastCreated(createdEvent);

  return { applied: true, lastSeq, buffered: 0 };
}

// ------------------------------------------------------------------------------------------------
// sync.config (Chat Slice D task 3)
// ------------------------------------------------------------------------------------------------

/** Everything `syncConfig` needs, injected so the RPC layer (ipc/server.ts) supplies the SAME live
 *  getters every other consumer of these values already reads through — never a second,
 *  independently-stale copy. Every field is OPTIONAL, same "typed no-op, never a crash" precedent
 *  as the rest of `IpcServerOptions`: a server built without one (most existing tests) degrades
 *  that piece to its safest empty value rather than throwing. */
export interface SyncConfigContext {
  /** Same shape as `SearchToolDeps.secret` (agent/tools/search.ts) — daemon.ts wires both from the
   *  identical `SecretStore` instance, so a BYOK/Exa-key read never opens a second store. Absent,
   *  or a resolved `null`, both mean "no key stored". */
  secret?(name: string): Promise<string | null>;
  /** The user-ADDED half of the dangerous-domains list — daemon.ts's own shared
   *  `dangerousDomainsAdded` const (the SAME one Search/ReadPage/the research runner already
   *  consult for the identical live list). Called with NO cwd: `sync.config` carries no
   *  session/project context, so this resolves against the daemon's base (non-project) settings —
   *  the same "no cwd" behavior every other cwd-less caller in this codebase already gets. */
  dangerousDomainsAdded?(): string[] | undefined;
  /** The provider's live model, re-resolved at call time (mirrors `AgentEngine`'s own
   *  `provider.live?.() ?? {model: provider.model}` idiom). Absent (no agent provider configured)
   *  degrades to `""` — there is no sensible model to report, and `defaultModel` is a plain
   *  string, never nullable (see `SyncConfigResult`'s own doc comment). */
  liveModel?(): string;
}

/** Everything a freshly-paired phone needs to run its OWN standalone chat (the `phone-always-local`
 *  design decision): the Exa key, the user's additions to the dangerous-domains list, and the
 *  daemon's current default model. Every field is read HERE, at call time — nothing is cached
 *  across calls, so a Keychain rotation or a settings edit is visible on the very next
 *  `sync.config`, no daemon restart (the same "hot" contract every other settings-backed getter in
 *  this codebase already keeps). */
export async function syncConfig(ctx: SyncConfigContext): Promise<SyncConfigResult> {
  const exaKey = (await ctx.secret?.(EXA_API_KEY_SECRET)) ?? null;
  const dangerousDomains = ctx.dangerousDomainsAdded?.() ?? [];
  const defaultModel = ctx.liveModel?.() ?? "";
  return { exaKey, dangerousDomains, defaultModel };
}

// ------------------------------------------------------------------------------------------------
// sync.memory (Chat Slice D task 3)
// ------------------------------------------------------------------------------------------------

/** Appended to a single file whose bytes exceed one WHOLE page's budget, in place of everything
 *  past the truncation point. Memory files are small markdown by construction (the Dreamer caps
 *  each at ~8KB, dream-ops.ts's `MAX_FILES`/content-size doctrine), so this is a rare safety valve
 *  — never the normal path, and never a substitute for splitting a file across pages (see
 *  `syncMemory`'s own doc comment for why a single file is never split). */
export const SYNC_MEMORY_TRUNCATION_MARKER = "\n…[truncated for sync]";

/** Truncates `buf` to at most `maxBytes`, backing off from a UTF-8 continuation byte (the top two
 *  bits `10xxxxxx`) so the cut never lands mid-character and produces mojibake at the boundary.
 *  `maxBytes <= 0` truncates to the empty string. */
function truncateUtf8(buf: Buffer, maxBytes: number): string {
  let end = Math.max(0, Math.min(maxBytes, buf.length));
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** One `sync.memory` page: a read-only replica of the shared `_assistant` memory bucket
 *  (`assistantMemoryDirFor`, memory-dir.ts:146) — the SAME directory `ContextAssembler`'s
 *  `memoryBucket: "assistant"` branch reads for every dispatch/chat turn on this Mac. The phone
 *  runs its own local engine (`phone-always-local`, the design's own user decision) and needs a
 *  copy of this bucket so ITS assembler can inject the identical memory.
 *
 *  Paging is over WHOLE FILES in stable (sorted) name order, budgeted by `SYNC_PAGE_BYTES` —
 *  unlike `sync.pull`'s byte-offset cursor into ONE growing log, this bucket is many small,
 *  independent files, so the natural unit is "which files", not "which bytes of which file". A
 *  single file larger than the WHOLE budget is truncated (never split across two pages, per the
 *  marker's own doc comment) rather than left off entirely — it always lands on the page it starts,
 *  alone. Hidden/dotfile entries (`.dream-state.json.tmp`, `.MEMORY.md.tmp` — the Dreamer's own
 *  atomic-write temporaries, dreamer.ts) are excluded: they are mid-write artifacts, never durable
 *  memory, and replicating one would be a flaky accident of paging timing rather than a real memory
 *  file. A missing bucket (no dream cycle has ever run) returns `{files: [], complete: true}` —
 *  never an error, same "typed no-op" precedent as every other optional-dependency degrade in this
 *  file.
 *
 *  ONLY a MISSING bucket, though (T12 review I-2). This catch used to swallow every errno, so
 *  EACCES / EIO / ENOTDIR / a directory the Dreamer was mid-swap on all rendered as "no memory" —
 *  and an empty page set is indistinguishable on the wire from "the user has no memory yet". The
 *  phone replicates this bucket and prunes what it is not sent, so one transient read error here
 *  wiped a device's entire memory replica and every chat turn after it silently ran with no memory
 *  section. A real read failure must be an ERROR the client can see and ignore, not an empty
 *  success it will act on. (The phone also refuses to prune on an empty reply, which is what keeps
 *  it safe against a daemon older than this change — version skew guarantees it meets one.) */
/** The typed failure `syncMemory` raises when the bucket exists but cannot be read.
 *
 *  It must be a `SyncRpcError`, NOT the raw `ErrnoException` (T12 re-review I-8). The RPC pump reads
 *  `code` STRUCTURALLY off whatever was thrown (`ipc/server.ts`'s `e.code ?? ERR.INTERNAL`), and an
 *  errno's `code` is a STRING — so rethrowing put `"code":"EACCES"` on a wire whose `code` is typed
 *  `Int` at both the Mac's `InboundLine.ErrorPayload` and the phone's decode. The line then fails to
 *  decode entirely, is dropped as unrecognized, and the request hangs to its timeout instead of
 *  failing — turning a read error into a stalled connect pass. Same shape every other throw in this
 *  file already uses.
 *
 *  The errno CODE rides the message; the errno's own `message` does NOT, because it embeds the
 *  absolute path (`/Users/<name>/.norma/…`) and this error is serialized to a paired phone. The code
 *  alone is what makes the failure diagnosable. */
function memoryReadFailure(code: string | undefined): SyncRpcError {
  return new SyncRpcError(ERR.INTERNAL, `sync.memory could not read the assistant memory bucket (${code ?? "unknown"})`);
}

export function syncMemory(normaHome: string, cursor: number): SyncMemoryResult {
  const dir = assistantMemoryDirFor({ normaHome });
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    // ENOENT (and ENOTDIR for a path whose parent is a file) is the honest "bucket doesn't exist
    // yet". Anything else means the bucket may well have contents we simply could not read — throw.
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw memoryReadFailure(code);
    names = [];
  }
  if (cursor >= names.length) return { files: [], complete: true };

  const files: { name: string; content: string }[] = [];
  let budget = SYNC_PAGE_BYTES;
  let i = cursor;
  for (; i < names.length; i++) {
    const name = names[i]!;
    let raw: Buffer;
    try {
      raw = readFileSync(join(dir, name));
    } catch (e) {
      // Same distinction, one level down. A file that VANISHED between readdir and read (a
      // concurrent Dreamer delete) is genuinely gone and skipping it is correct — the client
      // pruning it is the right outcome. A file that exists but could not be read is not gone, and
      // omitting it from the page is how the client comes to delete a memory the user still has.
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") throw memoryReadFailure(code);
      continue;
    }
    if (files.length === 0 && raw.length > budget) {
      // The lone oversized file on this page: truncate to fit and move past it — never split
      // across pages (this function's own doc comment).
      const markerBytes = Buffer.byteLength(SYNC_MEMORY_TRUNCATION_MARKER, "utf8");
      const content = truncateUtf8(raw, budget - markerBytes) + SYNC_MEMORY_TRUNCATION_MARKER;
      files.push({ name, content });
      i++;
      break;
    }
    if (raw.length > budget) break; // doesn't fit alongside what's already on this page
    files.push({ name, content: raw.toString("utf8") });
    budget -= raw.length;
  }
  return i >= names.length ? { files, complete: true } : { files, nextCursor: i, complete: false };
}
