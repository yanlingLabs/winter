import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { SessionEvent, SESSION_TITLE_MAX_CHARS, type NewSessionEvent } from "@norma/protocol";
import type { SessionApprovalPolicy } from "../agent/gate";

// Keep in sync with SessionCreateParams scope regex (packages/protocol/src/methods.ts).
const SCOPE_RE = /^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$/;

/** Chat Slice D task 2 (session sync): the ONLY session-id shape `createSynced` will accept from a
 *  remote client. Two jobs, both load-bearing:
 *   1. PATH SAFETY. `logPath()` joins the id straight into `<home>/sessions/<scope>/<id>.jsonl`, so
 *      a caller-supplied id is a filesystem path component. This regex admits nothing but hex and
 *      hyphens — no `/`, no `.`, no `..`, so traversal is impossible by construction rather than by
 *      a separate sanitizer that could be forgotten.
 *   2. NAMESPACE SEPARATION. Daemon-minted ids are `s_<12 hex>` (see `createSession`); a phone mints
 *      a UUID. Requiring a UUID here means a synced session can never collide with, or be mistaken
 *      for, one this daemon created itself. Any UUID version/variant is accepted — the phone's
 *      generator is not this daemon's business. */
const SYNCED_SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Chat Slice D task 2: fork provenance — mirrors the protocol's `SessionForkRef`. */
export interface SessionForkRef { sessionId: string; atSeq: number }

/** Chat Slice D task 2: one raw log line plus the event it parses to. `appendSynced` writes the
 *  RAW bytes and uses the parsed event only for validation and index derivation — see its own doc
 *  comment for why a re-serialization would be wrong. */
export interface SyncedEntry { raw: string; event: SessionEvent }

export interface SessionRow {
  sessionId: string;
  scope: string;
  createdAt: number;
  lastSeq: number;
  title?: string;
  cwd?: string;
  /** Phase 5 routines T3 (design doc §3): a machine-readable "who/what created this session" tag
   *  (e.g. `routine/<id>`) — set at createSession, index-only metadata (like `cwd`/approvalPolicy
   *  below, NOT derived from the event log the way title/first_message are), so it resets to
   *  undefined on a full index rebuild (see recoverAll's pass-2 INSERT). */
  origin?: string;
  // Dispatch (Phase 7): unlike origin/cwd (index-only, reset on full index rebuild — see
  // recoverAll's pass-2 INSERT), mode ALSO rides the session_created event (SessionCreatedEvent's
  // optional `mode`, durability follow-up) and IS restored on a full index rebuild — required so
  // the dispatch-singleton invariant (dispatchSessionId's SELECT WHERE mode='dispatch') survives
  // a complete index.db loss.
  mode?: string;
  parentSessionId?: string;
  /** Chat Slice D task 1: a per-session model override (`session.setModel`/`store.setModel`).
   *  Index-only metadata — like `cwd`/`approvalPolicy` (NOT `mode`, which ALSO rides the
   *  session_created event so the dispatch-singleton invariant survives an index rebuild): this
   *  does NOT ride the event log, so it resets to undefined on a full index.db loss, same as
   *  `cwd`/`origin`/`approvalPolicy`'s own reset-to-default behavior in recoverAll's pass-2
   *  INSERT below. Absent means "use the live/boot default" — AgentEngine.resolveSel's own rule. */
  model?: string;
  /** Chat Slice D task 2 (session sync): where this session was branched from, when a syncing
   *  client says so (`sync.push`'s `meta.forkedFrom`). Index-only metadata with the same
   *  reset-on-rebuild caveat as `model` above — the phone re-sends it on its next push, which is
   *  how it heals. Absent for every session that isn't a fork (almost all of them). */
  forkedFrom?: SessionForkRef;
}

/** Chat Slice D task 2 fix round (review I2): bounds a title at `SESSION_TITLE_MAX_CHARS`.
 *
 *  Applied at BOTH ends — where a title enters the index (`append`/`appendSynced`'s `session_titled`
 *  derivation) and where it leaves it (`list()`, the single read point behind both `session.list`
 *  and `sync.heads`). Clamping on READ is what makes the bound structural rather than write-path
 *  only: a row written before this existed — or by any future writer that forgets — still cannot
 *  produce a response too large for the phone transport to deliver. See `SESSION_TITLE_MAX_CHARS`
 *  for the failure it prevents. Returns the SAME reference when already within budget (the
 *  overwhelmingly common case — every daemon-side writer caps at 60).
 *
 *  The ellipsis is part of the budget, not extra (whole-branch WB-I1). Emitting `MAX + 1` made the
 *  daemon's own clamped output UN-PUSHABLE through its own wire: `SyncPushParams.meta.title` is
 *  `z.string().max(SESSION_TITLE_MAX_CHARS)`, enforced by `parseParams` BEFORE `validateSyncMeta`'s
 *  clamp can run, and the phone echoes daemon-served titles verbatim into every push — so a single
 *  over-long title wedged that session's replication with INVALID_PARAMS on every pass, healing only
 *  if the title changed. A clamp whose output its own schema rejects is a contradiction regardless
 *  of who is reachable today. */
function capTitle(title: string): string {
  return title.length <= SESSION_TITLE_MAX_CHARS ? title : `${title.slice(0, SESSION_TITLE_MAX_CHARS - 1)}…`;
}

/** Derives a fallback title from the first line of the session's first main-thread
 *  user_message, when no explicit session_titled event has set one. */
function fallbackTitle(firstMessage: string | null): string | undefined {
  if (!firstMessage) return undefined;
  const line = (firstMessage.split("\n", 1)[0] ?? "").trim();
  if (!line) return undefined;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Event payload before the store assigns seq/ts. Uses the protocol's exported
 *  NewSessionEvent (DistributedOmit over the union) so variant-specific fields type-check. */
export type EventInput = NewSessionEvent;

export class SessionStore {
  private db: Database;

  constructor(private readonly homeDir: string) {
    mkdirSync(join(homeDir, "sessions"), { recursive: true });
    this.db = new Database(join(homeDir, "sessions", "index.db"));
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      cwd TEXT,
      approval_policy TEXT NOT NULL DEFAULT 'ask',
      mode TEXT,
      parent_session_id TEXT,
      model TEXT,
      forked_from_session_id TEXT,
      forked_from_at_seq INTEGER
    )`);
    // Handle pre-existing index.db files by adding missing columns
    for (const ddl of [
      "ALTER TABLE sessions ADD COLUMN cwd TEXT",
      "ALTER TABLE sessions ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'ask'",
      "ALTER TABLE sessions ADD COLUMN title TEXT",
      "ALTER TABLE sessions ADD COLUMN first_message TEXT",
      "ALTER TABLE sessions ADD COLUMN origin TEXT",
      "ALTER TABLE sessions ADD COLUMN mode TEXT",
      "ALTER TABLE sessions ADD COLUMN parent_session_id TEXT",
      // Chat Slice D task 1: additive migration, same pattern as approval_policy/cwd above.
      "ALTER TABLE sessions ADD COLUMN model TEXT",
      // Chat Slice D task 2 (session sync): fork provenance, two plain columns rather than a JSON
      // blob so the pair is queryable and can never be half-parseable.
      "ALTER TABLE sessions ADD COLUMN forked_from_session_id TEXT",
      "ALTER TABLE sessions ADD COLUMN forked_from_at_seq INTEGER",
    ]) {
      try { this.db.run(ddl); }
      catch (e) {
        // Idempotent migration: only a re-added column is expected. Anything else is a real failure.
        if (!String((e as Error).message ?? e).includes("duplicate column")) throw e;
      }
    }
    // Phase 4b Task 2 (spec §3 "Plugin role tokens"): a brand-new table, so CREATE TABLE IF NOT
    // EXISTS alone is enough — no column-migration loop needed (unlike `sessions` above, which
    // predates several of its columns). One row per plugin id; re-minting upserts (rotates).
    this.db.run(`CREATE TABLE IF NOT EXISTS plugin_tokens (
      plugin_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      minted_at INTEGER NOT NULL
    )`);
    this.recoverAll();
  }

  /** Derives the index's title/first_message columns from a session's parsed event log:
   *  title = the LAST session_titled event's title (undo-able if a later one is appended);
   *  first_message = the FIRST main-thread user_message's text (first only, never overwritten). */
  private deriveIndexFields(events: SessionEvent[]): { title: string | null; firstMessage: string | null } {
    let title: string | null = null;
    let firstMessage: string | null = null;
    for (const e of events) {
      if (e.type === "session_titled") title = e.title;
      if (e.type === "user_message" && e.threadId === "main" && firstMessage === null) firstMessage = e.text;
    }
    return { title, firstMessage };
  }

  /** Index is disposable (spec §4.4): on open, scan log files on disk to rebuild the index,
   *  then resync last_seq for all known sessions. Corrupt lines are skipped (not stopped at);
   *  logs are rewritten only when bad lines were found, using a temp+rename atomic swap. */
  private recoverAll(): void {
    // Pass 1: resync sessions already in sqlite
    const rows = this.db.query("SELECT session_id, scope FROM sessions").all() as { session_id: string; scope: string }[];
    const known = new Set<string>();
    for (const r of rows) {
      known.add(r.session_id);
      const path = this.logPath(r.scope, r.session_id);
      if (!existsSync(path)) continue;
      const { good, parsed, sawBad } = this.readGoodLines(path);
      if (sawBad) {
        const tmp = path + ".repair";
        writeFileSync(tmp, good.map((l) => l + "\n").join(""));
        renameSync(tmp, path); // atomic: a crash never leaves a partial log
      }
      const lastSeq = good.length ? (JSON.parse(good[good.length - 1]!) as SessionEvent).seq : 0;
      const { title, firstMessage } = this.deriveIndexFields(parsed);
      this.db.run(
        "UPDATE sessions SET last_seq = ?, title = ?, first_message = ? WHERE session_id = ?",
        [lastSeq, title, firstMessage, r.session_id],
      );
    }

    // Pass 2: scan filesystem for sessions not yet in sqlite (index rebuild from logs)
    const sessionsDir = join(this.homeDir, "sessions");
    let scopeDirs: string[];
    try { scopeDirs = readdirSync(sessionsDir); } catch { return; }
    for (const entry of scopeDirs) {
      if (entry === "index.db" || entry.startsWith("index.db")) continue;
      const scopeDir = join(sessionsDir, entry);
      let files: string[];
      try { files = readdirSync(scopeDir); } catch { continue; } // skip non-directories
      const scope = entry;
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.slice(0, -6); // strip .jsonl
        if (known.has(sessionId)) continue;
        const path = join(scopeDir, file);
        const { good, parsed, sawBad } = this.readGoodLines(path);
        if (good.length === 0) continue;
        if (sawBad) {
          const tmp = path + ".repair";
          writeFileSync(tmp, good.map((l) => l + "\n").join(""));
          renameSync(tmp, path);
        }
        const firstEvent = JSON.parse(good[0]!) as SessionEvent;
        const createdAt = firstEvent.ts;
        const lastSeq = (JSON.parse(good[good.length - 1]!) as SessionEvent).seq;
        const { title, firstMessage } = this.deriveIndexFields(parsed);
        // mode (Phase 7 durability follow-up): unlike cwd/approval_policy (never carried by the
        // event log, so they reset to defaults below), mode rides the session_created event
        // (parsed[0], already validated by readGoodLines above) specifically so the
        // dispatch-singleton invariant (dispatchSessionId's SELECT WHERE mode='dispatch') survives
        // a full index rebuild. Absent on old-format logs → NULL, same as before this feature.
        const firstParsed = parsed[0];
        const mode = firstParsed?.type === "session_created" ? (firstParsed.mode ?? null) : null;
        // cwd/approval_policy are index-only metadata: after index loss they reset to defaults.
        this.db.run(
          "INSERT INTO sessions (session_id, scope, created_at, last_seq, cwd, approval_policy, mode, title, first_message) VALUES (?, ?, ?, ?, NULL, 'ask', ?, ?, ?)",
          [sessionId, scope, createdAt, lastSeq, mode, title, firstMessage],
        );
        known.add(sessionId);
      }
    }
  }

  /** Parse all lines, skipping (not stopping at) unparseable ones. Returns both the raw
   *  good lines (used by recoverAll to rewrite the log verbatim) and the already-parsed
   *  events (used by read(), so callers don't have to re-parse JSON they already parsed here). */
  private readGoodLines(path: string): { good: string[]; parsed: SessionEvent[]; sawBad: boolean } {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    const good: string[] = [];
    const parsed: SessionEvent[] = [];
    let sawBad = false;
    for (const line of lines) {
      try {
        const event = SessionEvent.parse(JSON.parse(line));
        good.push(line);
        parsed.push(event);
      }
      catch { sawBad = true; } // skip: a parseable line is a valid event regardless of position
    }
    return { good, parsed, sawBad };
  }

  private logPath(scope: string, sessionId: string): string {
    return join(this.homeDir, "sessions", scope, `${sessionId}.jsonl`);
  }

  createSession(
    scope: string,
    opts: { cwd?: string; approvalPolicy?: SessionApprovalPolicy; origin?: string; mode?: "code" | "dispatch" | "chat"; parentSessionId?: string; model?: string } = {},
  ): string {
    if (!SCOPE_RE.test(scope)) throw new Error(`invalid scope: ${scope}`);
    const sessionId = `s_${randomBytes(6).toString("hex")}`;
    mkdirSync(join(this.homeDir, "sessions", scope), { recursive: true });
    this.db.run(
      "INSERT INTO sessions (session_id, scope, created_at, last_seq, cwd, approval_policy, origin, mode, parent_session_id, model) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
      [sessionId, scope, Date.now(), opts.cwd ?? null, opts.approvalPolicy ?? "ask", opts.origin ?? null, opts.mode ?? null, opts.parentSessionId ?? null, opts.model ?? null],
    );
    this.append(sessionId, { type: "session_created", sessionId, scope, ...(opts.mode ? { mode: opts.mode } : {}) });
    return sessionId;
  }

  append(sessionId: string, input: EventInput): SessionEvent {
    const row = this.db.query("SELECT scope, last_seq FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string; last_seq: number } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const event = SessionEvent.parse({ ...input, seq: row.last_seq + 1, ts: Date.now() });
    appendFileSync(this.logPath(row.scope, sessionId), JSON.stringify(event) + "\n");
    this.db.run("UPDATE sessions SET last_seq = ? WHERE session_id = ?", [event.seq, sessionId]);
    if (event.type === "session_titled") {
      this.db.run("UPDATE sessions SET title = ? WHERE session_id = ?", [capTitle(event.title), sessionId]);
    }
    if (event.type === "user_message" && event.threadId === "main") {
      this.db.run(
        "UPDATE sessions SET first_message = ? WHERE session_id = ? AND first_message IS NULL",
        [event.text, sessionId],
      );
    }
    return event;
  }

  /** Current last persisted seq for the session (used to stamp transient broadcast-only events). */
  lastSeq(sessionId: string): number {
    const row = this.db.query("SELECT last_seq FROM sessions WHERE session_id = ?").get(sessionId) as
      | { last_seq: number } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    return row.last_seq;
  }

  read(sessionId: string, fromSeq = 0): SessionEvent[] {
    const row = this.db.query("SELECT scope FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const path = this.logPath(row.scope, sessionId);
    if (!existsSync(path)) return [];
    return this.readGoodLines(path).parsed.filter((e) => e.seq > fromSeq);
  }

  list(): SessionRow[] {
    return (this.db.query("SELECT session_id, scope, created_at, last_seq, title, first_message, cwd, origin, mode, parent_session_id, model, forked_from_session_id, forked_from_at_seq FROM sessions ORDER BY created_at").all() as
      { session_id: string; scope: string; created_at: number; last_seq: number; title: string | null; first_message: string | null; cwd: string | null; origin: string | null; mode: string | null; parent_session_id: string | null; model: string | null; forked_from_session_id: string | null; forked_from_at_seq: number | null }[])
      .map((r) => ({
        sessionId: r.session_id,
        scope: r.scope,
        createdAt: r.created_at,
        lastSeq: r.last_seq,
        // capTitle on READ (review I2): the one place both remote title consumers converge, so a
        // row written before the write-path caps existed still cannot brick the phone transport.
        title: r.title !== null ? capTitle(r.title) : fallbackTitle(r.first_message),
        cwd: r.cwd ?? undefined,
        origin: r.origin ?? undefined,
        mode: r.mode ?? undefined,
        parentSessionId: r.parent_session_id ?? undefined,
        model: r.model ?? undefined,
        // Both columns are written together (applySyncMeta) — but read defensively as a PAIR so a
        // half-written row (hand-edited db, an interrupted future migration) reports "not a fork"
        // rather than a `{sessionId: null}` shaped object that would fail the wire schema.
        forkedFrom: r.forked_from_session_id !== null && r.forked_from_at_seq !== null
          ? { sessionId: r.forked_from_session_id, atSeq: r.forked_from_at_seq }
          : undefined,
      }));
  }

  /** Returns the GENERATED title only (never the fallback-from-first-message) — callers that
   *  need a once-only "generate a title" guard (Task 3) must not treat a fallback as already-titled. */
  getTitle(sessionId: string): string | null {
    const row = this.db.query("SELECT title FROM sessions WHERE session_id = ?").get(sessionId) as
      | { title: string | null } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    return row.title;
  }

  setCwd(sessionId: string, cwd: string): void {
    this.db.run("UPDATE sessions SET cwd = ? WHERE session_id = ?", [cwd, sessionId]);
  }

  /** Deterministic on an unknown session: throws so the IPC server can map it to NOT_FOUND
   *  (unlike setCwd, which silently no-ops — approval policy changes must not fail silently). */
  setApprovalPolicy(sessionId: string, policy: SessionApprovalPolicy): void {
    const res = this.db.run("UPDATE sessions SET approval_policy = ? WHERE session_id = ?", [policy, sessionId]);
    if (res.changes === 0) throw new Error(`unknown session: ${sessionId}`);
  }

  /** Chat Slice D task 1: per-session model override — `model: null` CLEARS it (falls back to the
   *  live/boot default at the next resolution, AgentEngine.resolveSel). Deterministic on an
   *  unknown session, same precedent as setApprovalPolicy (throws, mapped to NOT_FOUND by the IPC
   *  layer) — unlike setCwd's silent no-op, an explicit model change must not fail silently.
   *  Idempotent: setting the same value (including re-clearing an already-clear one) is a no-op
   *  UPDATE that still reports success (SQLite's `changes` counts the matched row regardless of
   *  whether the value actually differs). */
  setModel(sessionId: string, model: string | null): void {
    const res = this.db.run("UPDATE sessions SET model = ? WHERE session_id = ?", [model, sessionId]);
    if (res.changes === 0) throw new Error(`unknown session: ${sessionId}`);
  }

  meta(sessionId: string): {
    sessionId: string; scope: string; cwd: string | null; approvalPolicy: SessionApprovalPolicy;
    origin?: string; mode?: string; parentSessionId?: string; model?: string;
  } {
    const row = this.db.query("SELECT scope, cwd, approval_policy, origin, mode, parent_session_id, model FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string; cwd: string | null; approval_policy: string; origin: string | null; mode: string | null; parent_session_id: string | null; model: string | null } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const p = row.approval_policy;
    // Plan-immunity (2026-07-28, USER-REVISED design): "chat" (gate.ts's SessionApprovalPolicy)
    // is a first-class recognized value here — session.create's chat-seam coercion persists it
    // verbatim for every chat-mode session (server.ts). Without it in this list, a stored "chat"
    // row would silently fall through to the "ask" default below, THE SAME TRAP the "plan must not
    // read back as ask" precedent above already guards against, just for the newest value.
    const approvalPolicy: SessionApprovalPolicy =
      (["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass", "chat"] as const).includes(p as SessionApprovalPolicy)
        ? (p as SessionApprovalPolicy)
        : "ask";
    return {
      sessionId, scope: row.scope, cwd: row.cwd, approvalPolicy,
      origin: row.origin ?? undefined, mode: row.mode ?? undefined, parentSessionId: row.parent_session_id ?? undefined,
      model: row.model ?? undefined,
    };
  }

  // -----------------------------------------------------------------------------------------
  // Session sync (Chat Slice D task 2) — the three store primitives behind `sync.pull`/`sync.push`.
  // These are REPLICATION operations, deliberately distinct from `createSession`/`append`:
  //   * they preserve the CLIENT's seq/ts/bytes instead of minting new ones, and
  //   * they never invent an event (`createSynced` writes NO session_created — the pushed batch's
  //     own seq-1 event is that record, which is what keeps the client's and the daemon's copies
  //     byte-identical and their seq numbering identical).
  // -----------------------------------------------------------------------------------------

  /** Creates the INDEX ROW (and its scope directory) for a session a syncing client already owns.
   *  Writes NO event — unlike `createSession`, which appends `session_created` as seq 1. The whole
   *  point is that the client's log ALREADY has its own seq-1 `session_created`; minting a second
   *  one would shift every subsequent seq and permanently desynchronize the two copies. The row
   *  therefore starts at `last_seq = 0` and only becomes non-empty when `appendSynced` lands the
   *  client's batch — callers MUST do both, in that order, in the same synchronous block.
   *
   *  `origin` is stamped `"sync"` — the same machine-readable "who created this" tag routines use
   *  (`routine/<id>`), so a synced session is identifiable as one without inspecting its log.
   *
   *  DEPENDENCY WORTH KNOWING: after a full index.db rebuild this row's `approval_policy` reads
   *  back as the `ask` default (recoverAll pass 2 restores only `mode`, from the log's first
   *  event). That is harmless ONLY because plan-immunity re-resolves a chat session's policy at
   *  turn time from `mode` (`AgentEngine`: `if (isChat) meta.approvalPolicy = "chat"`). If that
   *  coercion ever moves, a rebuilt synced chat would silently start asking for approvals.
   *
   *  Throws (never silently coerces) on a non-UUID id (see `SYNCED_SESSION_ID_RE` — path safety),
   *  an invalid scope, or an id that already exists. */
  createSynced(
    sessionId: string,
    opts: { scope: string; cwd?: string; approvalPolicy?: SessionApprovalPolicy; mode?: "chat"; model?: string; forkedFrom?: SessionForkRef },
  ): void {
    if (!SYNCED_SESSION_ID_RE.test(sessionId)) throw new Error(`invalid synced session id (expected a UUID): ${sessionId}`);
    if (!SCOPE_RE.test(opts.scope)) throw new Error(`invalid scope: ${opts.scope}`);
    const existing = this.db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId);
    if (existing) throw new Error(`session already exists: ${sessionId}`);
    mkdirSync(join(this.homeDir, "sessions", opts.scope), { recursive: true });
    this.db.run(
      "INSERT INTO sessions (session_id, scope, created_at, last_seq, cwd, approval_policy, origin, mode, parent_session_id, model, forked_from_session_id, forked_from_at_seq) VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?)",
      [
        sessionId, opts.scope, Date.now(), opts.cwd ?? null, opts.approvalPolicy ?? "ask", "sync",
        opts.mode ?? null, opts.model ?? null,
        opts.forkedFrom?.sessionId ?? null, opts.forkedFrom?.atSeq ?? null,
      ],
    );
  }

  /** Appends a syncing client's events VERBATIM, preserving their `seq` and `ts`.
   *
   *  Writes `entry.raw` — the client's exact line bytes — NOT `JSON.stringify(entry.event)`. Zod
   *  rebuilds a parsed object in SCHEMA key order, so re-serializing would silently rewrite every
   *  line and break the one property this whole surface rests on: that `sync.pull` returns what
   *  `sync.push` sent, byte for byte (see the protocol's SyncPull/SyncPush doc comments). The
   *  parsed `event` is used only to validate and to derive the index columns.
   *
   *  Re-validates contiguity and ownership INSIDE the store rather than trusting the IPC layer —
   *  this is the last gate before bytes hit an append-only log that has no undo. Throws before
   *  writing anything, so the append is all-or-nothing; the batch is a SINGLE `appendFileSync`. */
  appendSynced(sessionId: string, entries: SyncedEntry[]): number {
    const row = this.db.query("SELECT scope, last_seq FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string; last_seq: number } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    if (entries.length === 0) throw new Error("appendSynced: empty batch");
    const expectedFirst = row.last_seq + 1;
    for (let i = 0; i < entries.length; i++) {
      const { raw, event } = entries[i]!;
      if (event.sessionId !== sessionId) throw new Error(`event ${i} belongs to session ${event.sessionId}, not ${sessionId}`);
      if (event.seq !== expectedFirst + i) throw new Error(`event ${i} has seq ${event.seq}, expected ${expectedFirst + i}`);
      if (raw.includes("\n")) throw new Error(`event ${i} raw line contains a newline`); // would forge extra log lines
    }
    appendFileSync(this.logPath(row.scope, sessionId), entries.map((e) => e.raw + "\n").join(""));
    const lastSeq = expectedFirst + entries.length - 1;
    this.db.run("UPDATE sessions SET last_seq = ? WHERE session_id = ?", [lastSeq, sessionId]);
    // Mirror append()'s index derivations for the replicated events — otherwise a synced session
    // would show no title in session.list/sync.heads even though its log carries session_titled.
    for (const { event } of entries) {
      if (event.type === "session_titled") {
        // The LOG keeps the client's bytes verbatim (byte-identity); only the INDEX column — the
        // thing heads/list actually serialize into a phone frame — is bounded. Clamping the event
        // itself would break replication of a legitimately long title AND fail the whole push.
        this.db.run("UPDATE sessions SET title = ? WHERE session_id = ?", [capTitle(event.title), sessionId]);
      }
      if (event.type === "user_message" && event.threadId === "main") {
        this.db.run(
          "UPDATE sessions SET first_message = ? WHERE session_id = ? AND first_message IS NULL",
          [event.text, sessionId],
        );
      }
    }
    return lastSeq;
  }

  /** Applies a `sync.push`'s index-only `meta` — the session facts that have no event of their own.
   *  Each field is optional and only the PRESENT ones are written (an omitted field is "unchanged",
   *  never "clear"), so an incremental push that carries only a new title can't wipe the model. */
  applySyncMeta(sessionId: string, meta: { title?: string; model?: string; forkedFrom?: SessionForkRef }): void {
    if (meta.title !== undefined) this.db.run("UPDATE sessions SET title = ? WHERE session_id = ?", [capTitle(meta.title), sessionId]);
    if (meta.model !== undefined) this.db.run("UPDATE sessions SET model = ? WHERE session_id = ?", [meta.model, sessionId]);
    if (meta.forkedFrom !== undefined) {
      this.db.run(
        "UPDATE sessions SET forked_from_session_id = ?, forked_from_at_seq = ? WHERE session_id = ?",
        [meta.forkedFrom.sessionId, meta.forkedFrom.atSeq, sessionId],
      );
    }
  }

  /** Byte-slices the session log for `sync.pull`: the raw JSONL lines with `seq > fromSeq`, then
   *  `maxBytes` of that tail starting at byte offset `cursor`.
   *
   *  Deliberately does NOT re-serialize: each line is returned as the exact bytes on disk, so the
   *  replica a client builds from successive pages is identical to the daemon's file. Lines ARE
   *  cheaply `JSON.parse`d to read their `seq` (there is no other way to find where the tail
   *  begins) and an unparseable line is dropped from the tail entirely — a client must never be
   *  handed a line it cannot fold. That mirrors `readGoodLines`'s own skip-don't-stop policy, which
   *  has additionally already repaired any such line at daemon start.
   *
   *  O(file) per page, the same cost `readHistoryPage` already accepts. Throws on an unknown
   *  session (mapped to NOT_FOUND by the IPC layer) and on a `cursor` past the end of the tail —
   *  a stale cursor is a client bug and must not masquerade as "you're up to date". */
  readRawTail(sessionId: string, fromSeq: number, cursor: number, maxBytes: number): { bytes: Buffer; nextCursor?: number } {
    const row = this.db.query("SELECT scope FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const path = this.logPath(row.scope, sessionId);
    let tail = Buffer.alloc(0);
    if (existsSync(path)) {
      const kept: string[] = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.length === 0) continue;
        let seq: unknown;
        try { seq = (JSON.parse(line) as { seq?: unknown }).seq; } catch { continue; } // unparseable: never replicate
        if (typeof seq === "number" && seq > fromSeq) kept.push(line);
      }
      if (kept.length > 0) tail = Buffer.from(kept.join("\n") + "\n", "utf8");
    }
    if (cursor > tail.length) throw new RangeError(`cursor ${cursor} is past the end of the tail (${tail.length} bytes)`);
    const bytes = tail.subarray(cursor, cursor + maxBytes);
    const end = cursor + bytes.length;
    return end < tail.length ? { bytes, nextCursor: end } : { bytes };
  }

  /** Dispatch (Phase 7): the ONE dispatch session, if it exists. session.dispatch's lookup. */
  dispatchSessionId(): string | undefined {
    const r = this.db.query("SELECT session_id FROM sessions WHERE mode = 'dispatch' LIMIT 1").get() as { session_id: string } | null;
    return r?.session_id;
  }

  /** Dispatch (Phase 7): children of a dispatch session, creation order. */
  childrenOf(parentSessionId: string): SessionRow[] {
    return this.list().filter((r) => r.parentSessionId === parentSessionId);
  }

  // -----------------------------------------------------------------------------------------
  // Plugin role tokens (Phase 4b Task 2, spec §3): minted daemon-side (at supervisor spawn —
  // Task 3 — or lazily by whatever caller needs one; the CLI never opens this sqlite directly,
  // see plugin.revokeToken in ipc/server.ts), delivered to the plugin process via env only, and
  // verified id-bound on the socket hello. Only the sha256 HASH is ever persisted; the raw value
  // is returned exactly once by mintPluginToken and is never logged.
  // -----------------------------------------------------------------------------------------

  /** Mints a fresh 32-byte-random hex token for `pluginId` and persists ONLY its sha256 hash
   *  (upsert — re-minting an already-minted id rotates the token, invalidating any previously
   *  issued raw value). Returns the RAW token — the one and only time it is ever observable. */
  mintPluginToken(pluginId: string): string {
    const raw = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(raw).digest("hex");
    this.db.run(
      `INSERT INTO plugin_tokens (plugin_id, token_hash, minted_at) VALUES (?, ?, ?)
       ON CONFLICT(plugin_id) DO UPDATE SET token_hash = excluded.token_hash, minted_at = excluded.minted_at`,
      [pluginId, hash, Date.now()],
    );
    return raw;
  }

  /** sha256(raw) compared against the id's stored hash — length-guarded timingSafeEqual, same
   *  precedent as TokenAuthority.verify (auth/tokens.ts:30-31). Id-bound: a token minted for one
   *  plugin id never verifies for a different id. An unknown (never-minted or revoked) id fails
   *  closed rather than throwing. */
  verifyPluginToken(pluginId: string, raw: string): boolean {
    const row = this.db.query("SELECT token_hash FROM plugin_tokens WHERE plugin_id = ?").get(pluginId) as
      | { token_hash: string } | null;
    if (!row) return false;
    const hash = createHash("sha256").update(raw).digest("hex");
    const a = Buffer.from(row.token_hash);
    const b = Buffer.from(hash);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Deletes the token record so subsequent verifyPluginToken calls fail closed. A no-op (not a
   *  throw) when nothing was ever minted for this id — disable/remove call this unconditionally. */
  revokePluginToken(pluginId: string): void {
    this.db.run("DELETE FROM plugin_tokens WHERE plugin_id = ?", [pluginId]);
  }

  close(): void { this.db.close(); }
}
