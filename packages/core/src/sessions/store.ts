import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { SessionEvent, type NewSessionEvent } from "@norma/protocol";
import type { SessionApprovalPolicy } from "../agent/gate";

// Keep in sync with SessionCreateParams scope regex (packages/protocol/src/methods.ts).
const SCOPE_RE = /^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$/;

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
      parent_session_id TEXT
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
    opts: { cwd?: string; approvalPolicy?: SessionApprovalPolicy; origin?: string; mode?: "code" | "dispatch"; parentSessionId?: string } = {},
  ): string {
    if (!SCOPE_RE.test(scope)) throw new Error(`invalid scope: ${scope}`);
    const sessionId = `s_${randomBytes(6).toString("hex")}`;
    mkdirSync(join(this.homeDir, "sessions", scope), { recursive: true });
    this.db.run(
      "INSERT INTO sessions (session_id, scope, created_at, last_seq, cwd, approval_policy, origin, mode, parent_session_id) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)",
      [sessionId, scope, Date.now(), opts.cwd ?? null, opts.approvalPolicy ?? "ask", opts.origin ?? null, opts.mode ?? null, opts.parentSessionId ?? null],
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
      this.db.run("UPDATE sessions SET title = ? WHERE session_id = ?", [event.title, sessionId]);
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
    return (this.db.query("SELECT session_id, scope, created_at, last_seq, title, first_message, cwd, origin, mode, parent_session_id FROM sessions ORDER BY created_at").all() as
      { session_id: string; scope: string; created_at: number; last_seq: number; title: string | null; first_message: string | null; cwd: string | null; origin: string | null; mode: string | null; parent_session_id: string | null }[])
      .map((r) => ({
        sessionId: r.session_id,
        scope: r.scope,
        createdAt: r.created_at,
        lastSeq: r.last_seq,
        title: r.title ?? fallbackTitle(r.first_message),
        cwd: r.cwd ?? undefined,
        origin: r.origin ?? undefined,
        mode: r.mode ?? undefined,
        parentSessionId: r.parent_session_id ?? undefined,
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

  meta(sessionId: string): {
    sessionId: string; scope: string; cwd: string | null; approvalPolicy: SessionApprovalPolicy;
    origin?: string; mode?: string; parentSessionId?: string;
  } {
    const row = this.db.query("SELECT scope, cwd, approval_policy, origin, mode, parent_session_id FROM sessions WHERE session_id = ?").get(sessionId) as
      | { scope: string; cwd: string | null; approval_policy: string; origin: string | null; mode: string | null; parent_session_id: string | null } | null;
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const p = row.approval_policy;
    const approvalPolicy: SessionApprovalPolicy =
      (["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"] as const).includes(p as SessionApprovalPolicy)
        ? (p as SessionApprovalPolicy)
        : "ask";
    return {
      sessionId, scope: row.scope, cwd: row.cwd, approvalPolicy,
      origin: row.origin ?? undefined, mode: row.mode ?? undefined, parentSessionId: row.parent_session_id ?? undefined,
    };
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
