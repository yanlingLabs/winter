import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
 *      generator is not this daemon's business.
 *
 *  EXPORTED for session-activity-hygiene T7 (spec §3): the cleaner's phone-synced rail is defined
 *  as "the id matches this shape". Sharing the constant rather than re-typing the regex is what
 *  keeps the rail and the admission check the same definition of "phone-minted" forever. */
export const SYNCED_SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** session-activity-hygiene T6 (spec §2): the empty-session reaper's age gate — "created ≥ 10 min
 *  ago". A session younger than this may simply be mid-composition (the user hasn't sent their
 *  first message yet), so it must never look like an abandoned empty. Exported so tests pin the
 *  exact value, mirroring `AUTO_BACKGROUND_GRACE_MS` (activity-enforcement.ts)'s own precedent.
 *  Inclusive boundary (`emptySessionIds` uses `created_at <= nowMs - EMPTY_SESSION_GRACE_MS`):
 *  exactly 10 minutes old already counts — this task's own "≥" wording, deliberately not the same
 *  strict "> 24h" convention T5's demotion sweep uses for an unrelated threshold. */
export const EMPTY_SESSION_GRACE_MS = 10 * 60_000;

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
  /** provider-correctness T4: a per-session reasoning-effort override (`session.setEffort`/
   *  `store.setEffort`). Index-only metadata on exactly the same terms as `model` above — same
   *  additive column, same reset-to-undefined on a full index rebuild. Absent means "use the global
   *  default" (`settings.provider.reasoningEffort`, AgentEngine.resolveSel's own rule); it does NOT
   *  mean "no reasoning" — an unset effort omits the provider's `reasoning` block entirely, while
   *  `"none"` is a distinct level the endpoint honours (settings.ts's REASONING_EFFORTS). */
  effort?: string;
  /** Chat Slice D task 2 (session sync): where this session was branched from, when a syncing
   *  client says so (`sync.push`'s `meta.forkedFrom`). Index-only metadata with the same
   *  reset-on-rebuild caveat as `model` above — the phone re-sends it on its next push, which is
   *  how it heals. Absent for every session that isn't a fork (almost all of them). */
  forkedFrom?: SessionForkRef;
  /** session-activity-hygiene T2 (spec §1): the "keep running unattended" flag — one of the TWO
   *  stored bits of the activity lifecycle (the rest is derived live; see `activityFor` in
   *  ./activity.ts). Index-only metadata on exactly the `model`/`effort` terms: it does NOT ride
   *  the event log, so it resets to undefined on a full index.db rebuild.
   *
   *  That reset class is a deliberate, acceptable loss here for the same reason it is for `model`:
   *  the flag is a live-session preference, and an index rebuild already returns every session to
   *  "nothing running, nothing attached" — a backgrounded session whose flag vanished reads as
   *  idle, which is exactly what it is after a daemon that lost its index. Absent means "not
   *  backgrounded"; the flag is never stored as an explicit false. */
  backgrounded?: boolean;
  /** session-activity-hygiene T2 (spec §1.4): "hidden under a dedicated tab, resumable only
   *  deliberately". The second stored bit, on identical terms to `backgrounded` above — additive
   *  index column, same reset-on-rebuild class as `model`/`effort`, absent means "not archived".
   *
   *  Independent of `backgrounded`, not a second value of one column: a session can be flagged
   *  background and later archived, and clearing one must not clear the other. */
  archived?: boolean;
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
      effort TEXT,
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
      // provider-correctness T4: per-session reasoning effort — the SAME additive index-only
      // pattern as `model` one line up, deliberately not a second shape.
      "ALTER TABLE sessions ADD COLUMN effort TEXT",
      // Chat Slice D task 2 (session sync): fork provenance, two plain columns rather than a JSON
      // blob so the pair is queryable and can never be half-parseable.
      "ALTER TABLE sessions ADD COLUMN forked_from_session_id TEXT",
      "ALTER TABLE sessions ADD COLUMN forked_from_at_seq INTEGER",
      // session-activity-hygiene T2 (spec §1): the two stored bits of the activity lifecycle. The
      // SAME additive index-only pattern as `model`/`effort` above, deliberately not a third shape.
      // Stored 1/0 (NULL on every pre-existing row) and read back as `true | undefined`.
      "ALTER TABLE sessions ADD COLUMN backgrounded INTEGER",
      "ALTER TABLE sessions ADD COLUMN archived INTEGER",
      // session-activity-hygiene T7 (spec §3): the cleaner's once-per-lifetime stamp — the epoch-ms
      // at which an LLM judgment KEPT this session, NULL for every session never judged. Same
      // additive index-only pattern as the columns above, with one consequence worth stating
      // outright: a full index.db loss (recoverAll's pass-2 rebuild, which restores only `mode`)
      // therefore clears it, and a previously-kept session becomes judgeable once more. That is the
      // same accepted loss class as `backgrounded`/`archived`/`cwd`, and the only way out of it
      // would be to put the stamp in the event log — a protocol change deliberately out of T7's
      // scope. See cleaner.ts for the permanence rule this column implements.
      "ALTER TABLE sessions ADD COLUMN judged INTEGER",
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
    // provider-correctness T6: `effort` joins `model` here — index-only metadata on identical
    // terms (same additive column, same reset-to-undefined on a full index rebuild). Validating it
    // is the CALLER's job, exactly as it is for `model`: which levels a model accepts is provider
    // knowledge, and only `session.create`'s handler knows the session's mode (the tier gate).
    opts: { cwd?: string; approvalPolicy?: SessionApprovalPolicy; origin?: string; mode?: "code" | "dispatch" | "chat"; parentSessionId?: string; model?: string; effort?: string } = {},
  ): string {
    if (!SCOPE_RE.test(scope)) throw new Error(`invalid scope: ${scope}`);
    const sessionId = `s_${randomBytes(6).toString("hex")}`;
    mkdirSync(join(this.homeDir, "sessions", scope), { recursive: true });
    this.db.run(
      "INSERT INTO sessions (session_id, scope, created_at, last_seq, cwd, approval_policy, origin, mode, parent_session_id, model, effort) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
      [sessionId, scope, Date.now(), opts.cwd ?? null, opts.approvalPolicy ?? "ask", opts.origin ?? null, opts.mode ?? null, opts.parentSessionId ?? null, opts.model ?? null, opts.effort ?? null],
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
    return (this.db.query("SELECT session_id, scope, created_at, last_seq, title, first_message, cwd, origin, mode, parent_session_id, model, effort, forked_from_session_id, forked_from_at_seq, backgrounded, archived FROM sessions ORDER BY created_at").all() as
      { session_id: string; scope: string; created_at: number; last_seq: number; title: string | null; first_message: string | null; cwd: string | null; origin: string | null; mode: string | null; parent_session_id: string | null; model: string | null; effort: string | null; forked_from_session_id: string | null; forked_from_at_seq: number | null; backgrounded: number | null; archived: number | null }[])
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
        effort: r.effort ?? undefined,
        // Both columns are written together (applySyncMeta) — but read defensively as a PAIR so a
        // half-written row (hand-edited db, an interrupted future migration) reports "not a fork"
        // rather than a `{sessionId: null}` shaped object that would fail the wire schema.
        forkedFrom: r.forked_from_session_id !== null && r.forked_from_at_seq !== null
          ? { sessionId: r.forked_from_session_id, atSeq: r.forked_from_at_seq }
          : undefined,
        // session-activity-hygiene T2: `true | undefined`, never `false` — a cleared flag must be
        // indistinguishable from one never set (that is what makes `absent = off` a single case for
        // every reader instead of two). Truthiness rather than `=== 1` so a hand-edited row or a
        // future writer that stores some other non-zero integer still reads as "on".
        backgrounded: r.backgrounded ? true : undefined,
        archived: r.archived ? true : undefined,
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

  /** provider-correctness T4: per-session reasoning-effort override — `effort: null` CLEARS it
   *  (the next resolution falls back to the global default, AgentEngine.resolveSel). Identical
   *  contract to `setModel` directly above, deliberately: throws on an unknown session so the IPC
   *  layer maps it to NOT_FOUND, and setting the same value twice (or re-clearing an already-clear
   *  one) is a successful no-op UPDATE.
   *
   *  Stores whatever it is handed — the VALUE check lives at the RPC boundary
   *  (`session.setEffort`, ipc/server.ts), which is where the session's own model is known and so
   *  where the model's effort list can be consulted. Same split as `setModel`/`session.setModel`. */
  setEffort(sessionId: string, effort: string | null): void {
    const res = this.db.run("UPDATE sessions SET effort = ? WHERE session_id = ?", [effort, sessionId]);
    if (res.changes === 0) throw new Error(`unknown session: ${sessionId}`);
  }

  /** session-activity-hygiene T2 (spec §1.2): the "keep running unattended" flag. `on: false`
   *  CLEARS it (stored NULL, so it reads back absent — see `list()`'s mapping for why a cleared
   *  flag must not become `false`). Same contract as `setModel`/`setEffort` directly above: throws
   *  on an unknown session so the IPC layer maps it to NOT_FOUND, and setting the same value twice
   *  is a successful no-op.
   *
   *  Storage only — this writes the bit and nothing else. Deciding WHEN it flips (the `/background`
   *  verb, dispatch-spawned defaults, the app's per-turn auto-background, the >24h demotion) and
   *  announcing the flip belong to their own seams, exactly as `setEffort` stores a value whose
   *  legality is checked at the RPC boundary. */
  setBackgrounded(sessionId: string, on: boolean): void {
    const res = this.db.run("UPDATE sessions SET backgrounded = ? WHERE session_id = ?", [on ? 1 : null, sessionId]);
    if (res.changes === 0) throw new Error(`unknown session: ${sessionId}`);
  }

  /** session-activity-hygiene T2 (spec §1.4): the archive flag — identical contract to
   *  `setBackgrounded` directly above, and an INDEPENDENT column: archiving a backgrounded session
   *  leaves it backgrounded, and un-archiving does not clear that. */
  setArchived(sessionId: string, on: boolean): void {
    const res = this.db.run("UPDATE sessions SET archived = ? WHERE session_id = ?", [on ? 1 : null, sessionId]);
    if (res.changes === 0) throw new Error(`unknown session: ${sessionId}`);
  }

  /** session-activity-hygiene T2: when this session's log was last appended to, from the log
   *  file's mtime (the JSONL is append-only, so its mtime IS its last event's timestamp) with
   *  `created_at` as both the floor and the fallback for a session whose log is missing.
   *
   *  Derived rather than stored on purpose: a `last_event_ts` column would be a second writer on
   *  every `append()` that a full index rebuild would then have to re-derive from the logs anyway.
   *
   *  DELIBERATELY NOT part of `list()`: that method is shared with `sync.heads` and
   *  `daemon.status`, neither of which needs a filesystem stat per session. Callers that need the
   *  value take the per-session cost — see `ActivitySignals.lastEventTs` for why a plausible
   *  stand-in (e.g. `createdAt`) is not an acceptable substitute. */
  lastEventTs(sessionId: string): number {
    const row = this.db.query("SELECT scope, created_at FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string; created_at: number } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    try { return Math.max(Math.round(statSync(this.logPath(row.scope, sessionId)).mtimeMs), row.created_at); }
    catch { return row.created_at; } // no log on disk yet (or unreadable): creation is the honest floor
  }

  /** session-activity-hygiene T8: where this session's append-only JSONL actually lives — the
   *  PUBLIC form of the private `logPath` every write/read in this class already uses, so the one
   *  surface that shows a user (or a model) that path cannot compose its own guess of it.
   *
   *  Read-only and existence-agnostic: it answers "where would this session's log be", which is a
   *  fact about the store's layout, not about the filesystem — a brand-new session whose log has
   *  not been flushed yet still has a correct path. Throws on an unknown session (the
   *  `lastEventTs`/`setApprovalPolicy` precedent): composing a path for a session that does not
   *  exist is a bug, not a blank answer. */
  transcriptPath(sessionId: string): string {
    const row = this.db.query("SELECT scope FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    return this.logPath(row.scope, sessionId);
  }

  meta(sessionId: string): {
    sessionId: string; scope: string; cwd: string | null; approvalPolicy: SessionApprovalPolicy;
    origin?: string; mode?: string; parentSessionId?: string; model?: string; effort?: string;
    backgrounded?: boolean; archived?: boolean;
  } {
    const row = this.db.query("SELECT scope, cwd, approval_policy, origin, mode, parent_session_id, model, effort, backgrounded, archived FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string; cwd: string | null; approval_policy: string; origin: string | null; mode: string | null; parent_session_id: string | null; model: string | null; effort: string | null; backgrounded: number | null; archived: number | null } | null;
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
      effort: row.effort ?? undefined,
      // session-activity-hygiene T3: the two activity flags, mapped `1 → true` / `NULL → undefined`
      // EXACTLY as `list()` maps them — a cleared flag must stay indistinguishable from one never
      // set (never coerced to `false`), or the derivation's "absent means not backgrounded" rule
      // would read differently through this door than through that one. Served here, and not left
      // to a `list()` scan, because the per-session readers that need them (`session.setActivity`'s
      // post-write derivation, `session.attach`'s resume-clears-archived check) address ONE session
      // and must not pay a full-table read plus its per-row title capping to learn one bit.
      backgrounded: row.backgrounded ? true : undefined,
      archived: row.archived ? true : undefined,
    };
  }

  /** session-activity-hygiene T6 (spec §2): candidate ids for the empty-session reaper — sessions
   *  with zero user/assistant messages, old enough that composing a first message is implausible,
   *  and not currently attached to any harness. The dispatch session (if one exists) is excluded
   *  outright: it is the daemon's one long-lived coordinator, driven by tool calls rather than chat
   *  messages, so it normally carries no main-thread `user_message` at all — without this exclusion
   *  it would look permanently empty. `deleteSession` below refuses it too (belt, not suspenders:
   *  every future caller gets the same protection independent of this exclusion).
   *
   *  `first_message IS NULL` (set by `append`/`appendSynced`'s `user_message` derivation) is the
   *  cheap indexed pre-filter, narrowing to a small candidate set in the common case — most sessions
   *  get a first message within seconds of creation. It is NOT trusted alone: it only ever tracks
   *  main-thread USER messages, so it says nothing about assistant output, and `recoverAll`'s
   *  skip-bad-lines repair (a corrupt line is dropped, not stopped at — see `readGoodLines`) can
   *  leave a log whose `user_message` line was corrupted-and-dropped while a LATER `assistant_message`
   *  line survived — `first_message` would then read NULL on a session that plainly produced real
   *  output (reaper.test.ts's "recovered log" case reproduces exactly this). So every
   *  first_message-IS-NULL candidate that survives the attached-check below gets a real scan of its
   *  parsed log (`read()`, already skip-bad-lines-safe) for ANY `user_message`/`assistant_message`
   *  event before being called empty — cheap, because the SQL filter already narrowed the set this
   *  scan ever runs against.
   *
   *  `attachedCount` is injected rather than read off a stored `SessionHub`: the store has never
   *  held a hub reference (hub depends on store, never the reverse) — mirrors
   *  `ActivityEnforcementDeps.attachedCount` (activity-enforcement.ts)'s identical shape. `nowMs` is
   *  a plain required parameter (the `activityFor`/`deriveActivity` precedent) rather than a clock
   *  dependency: this is a one-shot query with no state of its own to hold a clock across calls. */
  emptySessionIds(attachedCount: (sessionId: string) => number, nowMs: number): string[] {
    const cutoff = nowMs - EMPTY_SESSION_GRACE_MS;
    const rows = this.db.query(
      `SELECT session_id FROM sessions
       WHERE first_message IS NULL AND created_at <= ? AND (mode IS NULL OR mode != 'dispatch')`,
    ).all(cutoff) as { session_id: string }[];
    const candidates: string[] = [];
    for (const { session_id: sessionId } of rows) {
      if (attachedCount(sessionId) !== 0) continue;
      const hasContent = this.read(sessionId).some((e) => e.type === "user_message" || e.type === "assistant_message");
      if (!hasContent) candidates.push(sessionId);
    }
    return candidates;
  }

  /** session-activity-hygiene T7 (spec §3): the cleaner's cheap SQL pre-filter — every session
   *  never judged, created at or before `createdBeforeMs`, that isn't the dispatch session.
   *
   *  `created_at` (not the real gate) is deliberate and SOUND: the cleaner's gate is "last event ≥
   *  24 h old", and `lastEventTs` is `max(log mtime, created_at)` — never LESS than `created_at`.
   *  So a row created after the cutoff cannot possibly have an older last event, and filtering on
   *  `created_at` can only ever admit too many, never too few. The caller re-checks the real
   *  `lastEventTs` gate per candidate (cleaner.ts's `railFor`); this query exists so that check
   *  runs against a small set rather than every session ever created.
   *
   *  The dispatch exclusion is the BELT (`emptySessionIds`'s own precedent, and `deleteSession`
   *  refuses it besides): the cleaner rails it independently too, so the singleton is protected by
   *  three separate mechanisms. It also saves a pointless full parse of the daemon's single largest
   *  log on every pass.
   *
   *  No index backs this (the `sessions` table has none beyond the primary key), so it is a full
   *  table scan — fine at any plausible session count, and the alternative (a column index that
   *  every write then maintains) is not worth it until a real N says otherwise. */
  cleanerCandidateIds(createdBeforeMs: number): string[] {
    return (this.db.query(
      `SELECT session_id FROM sessions
       WHERE judged IS NULL AND created_at <= ? AND (mode IS NULL OR mode != 'dispatch')
       ORDER BY created_at`,
    ).all(createdBeforeMs) as { session_id: string }[]).map((r) => r.session_id);
  }

  /** session-activity-hygiene T7: when an LLM judgment KEPT this session, or null if it was never
   *  judged. The cleaner reads it twice per candidate — once through `cleanerCandidateIds`'s
   *  `judged IS NULL` filter, and once again immediately before deleting (the mid-cycle re-check).
   *  Throws on an unknown session, the `setModel`/`setEffort` precedent. */
  judgedAt(sessionId: string): number | null {
    const row = this.db.query("SELECT judged FROM sessions WHERE session_id = ?").get(sessionId) as
      | { judged: number | null } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    return row.judged;
  }

  /** session-activity-hygiene T7 (spec §3): stamps the once-per-lifetime judgment. WRITE-ONCE by
   *  construction — `COALESCE(judged, ?)` keeps whatever is already there, so a second call can
   *  never move the date and no caller has to remember to check first. That is the whole permanent-
   *  immunity rule in one SQL function: a judged-kept session is never re-examined however it later
   *  changes, and only the user can delete it thereafter.
   *
   *  There is deliberately NO un-stamp method. Throws on an unknown session (the `setModel`
   *  precedent — `changes` counts the matched row whether or not COALESCE changed the value). */
  markJudged(sessionId: string, atMs: number): void {
    const res = this.db.run("UPDATE sessions SET judged = COALESCE(judged, ?) WHERE session_id = ?", [atMs, sessionId]);
    if (res.changes === 0) throw new Error(`unknown session: ${sessionId}`);
  }

  /** session-activity-hygiene T7 (spec §3): the fork rail, BOTH directions in one query — this
   *  session is either a fork child (its own `forked_from_session_id` is set) or a fork parent
   *  (some other row points at it). The parent direction needs the reverse lookup precisely because
   *  a parent's own row records nothing about having been forked; without it, deleting a parent
   *  would orphan its child's provenance. Unknown ids answer `false` rather than throwing — a rail
   *  is a question about a session, and "no fork relationship on record" is the honest answer for a
   *  row that isn't there. */
  isForkRelated(sessionId: string): boolean {
    const row = this.db.query(
      `SELECT 1 AS hit FROM sessions
       WHERE (session_id = ? AND forked_from_session_id IS NOT NULL) OR forked_from_session_id = ?
       LIMIT 1`,
    ).get(sessionId, sessionId) as { hit: number } | null;
    return row !== null;
  }

  /** session-activity-hygiene T6 (spec §2, the amended sessions rule): FULL deletion — the JSONL
   *  log file and the index row. Refuses the dispatch session UNCONDITIONALLY: this is the belt for
   *  every caller (T7's cleaner calls this same method), not just `emptySessionIds`'s own exclusion
   *  above — a singleton this fundamental (`DispatchChildren.start()` rebuilds its child roster
   *  against `dispatchSessionId()`) must never be deletable through any path, even a future one that
   *  forgets to check first. Throws on an unknown session — the `setApprovalPolicy`/`setModel`
   *  precedent: a caller deleting a session that doesn't exist is a bug, not a silent no-op. A
   *  missing log file (already gone, somehow) is tolerated — the index row is still the correct
   *  thing to remove. */
  deleteSession(sessionId: string): void {
    const row = this.db.query("SELECT scope, mode FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string; mode: string | null } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    if (row.mode === "dispatch") throw new Error(`refusing to delete the dispatch session: ${sessionId}`);
    const path = this.logPath(row.scope, sessionId);
    if (existsSync(path)) unlinkSync(path);
    this.db.run("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
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
   *  never "clear"), so an incremental push that carries only a new title can't wipe the model.
   *
   *  provider-correctness T6 added `effort` (the T4-review I2 gap: a phone-set per-session effort
   *  reached this index for `model` and was silently dropped for `effort`, so the Mac kept resolving
   *  that session at the global default while the phone's UI showed the override). It is written
   *  here UNCONDITIONALLY, exactly like `model` beside it — the validation that decides whether a
   *  pushed effort deserves to be written lives at the CALLER (`validateSyncMeta`, ipc/sync.ts),
   *  which is where the session's model and the tier rule are both in scope. A refused effort never
   *  reaches this method at all, so there is nothing here to "also check". */
  applySyncMeta(sessionId: string, meta: { title?: string; model?: string; effort?: string | null; forkedFrom?: SessionForkRef }): void {
    if (meta.title !== undefined) this.db.run("UPDATE sessions SET title = ? WHERE session_id = ?", [capTitle(meta.title), sessionId]);
    if (meta.model !== undefined) this.db.run("UPDATE sessions SET model = ? WHERE session_id = ?", [meta.model, sessionId]);
    // T6 review (C6): `effort` is the ONE field here with three states — absent (unchanged), `null`
    // (CLEAR), a string (set). `null` binds straight through to SQL NULL, so there is no sentinel to
    // map and nothing a future writer can forget. `title`/`model` above stay two-state on purpose.
    if (meta.effort !== undefined) this.db.run("UPDATE sessions SET effort = ? WHERE session_id = ?", [meta.effort, sessionId]);
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
