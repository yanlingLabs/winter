import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWinterHome } from "../winter-dir";
import { nextRunAt, parseSpec } from "./spec";

export interface Routine {
  id: string;
  spec: string;
  prompt: string;
  policy: "auto" | "plan";
  cwd: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number;
  createdAt: number;
  lastResult: string | null;
  deferAttempts: number;
}

export interface CreateRoutineInput {
  spec: string;
  prompt: string;
  /** Validated at runtime, not just by the type — untrusted callers (CLI/tool/RPC) can pass
   *  an arbitrary string here, and "ask" must be rejected even though TS narrows it out. */
  policy?: string;
  cwd?: string;
  enabled?: boolean;
}

export interface UpdateRoutinePatch {
  spec?: string;
  prompt?: string;
  policy?: string;
  cwd?: string;
  enabled?: boolean;
}

const THIRTY_MIN_MS = 30 * 60_000;
const FOUR_HOUR_MS = 4 * 60 * 60_000;

interface RoutineRow {
  id: string;
  spec: string;
  prompt: string;
  policy: string;
  cwd: string;
  enabled: number;
  lastRunAt: number | null;
  nextRunAt: number;
  createdAt: number;
  lastResult: string | null;
  deferAttempts: number;
}

function rowToRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    spec: row.spec,
    prompt: row.prompt,
    policy: row.policy === "plan" ? "plan" : "auto",
    cwd: row.cwd,
    enabled: row.enabled === 1,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    lastResult: row.lastResult,
    deferAttempts: row.deferAttempts,
  };
}

/** "ask" would hang a headless routine turn forever waiting for an approval nobody will ever
 *  answer, so it's rejected here at the store boundary — the one place every creation/update
 *  path (CLI, `schedule` tool, RPC) funnels through. */
function validatePolicy(policy: string): "auto" | "plan" {
  if (policy === "ask") {
    throw new TypeError(
      `invalid routine policy "ask": routines run headless (unattended) — "ask" would hang forever ` +
        `waiting for an approval nobody can answer; use "auto" or "plan" instead`,
    );
  }
  if (policy !== "auto" && policy !== "plan") {
    throw new TypeError(`invalid routine policy "${policy}": must be "auto" or "plan"`);
  }
  return policy;
}

export class RoutineStore {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      spec TEXT NOT NULL,
      prompt TEXT NOT NULL,
      policy TEXT NOT NULL,
      cwd TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      lastRunAt INTEGER,
      nextRunAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      lastResult TEXT,
      deferAttempts INTEGER NOT NULL DEFAULT 0
    )`);
  }

  /** Validates the spec (parseSpec throws TypeError on invalid input) and rejects policy
   *  "ask" before ever touching sqlite. Generates a short random hex id via crypto.randomUUID
   *  (never Math.random — this id is not just a display label, it's a lookup key). */
  create(input: CreateRoutineInput): Routine {
    const parsed = parseSpec(input.spec);
    const policy = validatePolicy(input.policy ?? "auto");
    const now = Date.now();
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const cwd = input.cwd ?? process.cwd();
    const enabled = input.enabled ?? true;
    const initialNextRunAt = nextRunAt(parsed, now);

    this.db.run(
      `INSERT INTO routines (id, spec, prompt, policy, cwd, enabled, lastRunAt, nextRunAt, createdAt, lastResult, deferAttempts)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0)`,
      [id, input.spec, input.prompt, policy, cwd, enabled ? 1 : 0, initialNextRunAt, now],
    );
    return this.get(id)!;
  }

  get(id: string): Routine | undefined {
    const row = this.db.query("SELECT * FROM routines WHERE id = ?").get(id) as RoutineRow | null;
    return row ? rowToRoutine(row) : undefined;
  }

  list(): Routine[] {
    const rows = this.db.query("SELECT * FROM routines ORDER BY createdAt").all() as RoutineRow[];
    return rows.map(rowToRoutine);
  }

  /** Returns undefined for an unknown id (never throws — routines are managed by CLI/tool/RPC
   *  callers that need a clean "not found" signal, not a caught exception). Changing the spec
   *  re-validates it via parseSpec and recomputes nextRunAt from the current time. */
  update(id: string, patch: UpdateRoutinePatch): Routine | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    let spec = existing.spec;
    let recomputedNextRunAt: number | undefined;
    if (patch.spec !== undefined) {
      const parsed = parseSpec(patch.spec);
      spec = patch.spec;
      recomputedNextRunAt = nextRunAt(parsed, Date.now());
    }
    const policy = patch.policy !== undefined ? validatePolicy(patch.policy) : existing.policy;
    const prompt = patch.prompt ?? existing.prompt;
    const cwd = patch.cwd ?? existing.cwd;
    const enabled = patch.enabled ?? existing.enabled;
    const nextRun = recomputedNextRunAt ?? existing.nextRunAt;

    this.db.run(
      `UPDATE routines SET spec = ?, prompt = ?, policy = ?, cwd = ?, enabled = ?, nextRunAt = ? WHERE id = ?`,
      [spec, prompt, policy, cwd, enabled ? 1 : 0, nextRun, id],
    );
    return this.get(id);
  }

  /** true if a row was deleted, false if the id was already gone — never throws. */
  delete(id: string): boolean {
    const res = this.db.run("DELETE FROM routines WHERE id = ?", [id]);
    return res.changes > 0;
  }

  due(nowMs: number): Routine[] {
    const rows = this.db
      .query("SELECT * FROM routines WHERE enabled = 1 AND nextRunAt <= ? ORDER BY nextRunAt")
      .all(nowMs) as RoutineRow[];
    return rows.map(rowToRoutine);
  }

  /** Records a successful fire: lastRunAt/lastResult, nextRunAt recomputed from the routine's
   *  own spec, and deferAttempts reset to 0 (a success clears any prior quota-defer backoff). */
  recordRun(id: string, opts: { resultText: string; nowMs: number }): Routine | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next = nextRunAt(parseSpec(existing.spec), opts.nowMs);
    this.db.run(
      `UPDATE routines SET lastRunAt = ?, lastResult = ?, nextRunAt = ?, deferAttempts = 0 WHERE id = ?`,
      [opts.nowMs, opts.resultText, next, id],
    );
    return this.get(id);
  }

  /** Records a quota-deferred fire (does NOT count as a run): backs off nextRunAt by
   *  min(30min * 2^attemptsSoFar, 4h), then increments deferAttempts. Progression starting
   *  from 0 prior attempts: 30m, 1h, 2h, 4h, 4h (capped), ... */
  recordDefer(id: string, opts: { nowMs: number }): Routine | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const delay = Math.min(THIRTY_MIN_MS * 2 ** existing.deferAttempts, FOUR_HOUR_MS);
    const next = opts.nowMs + delay;
    this.db.run(
      `UPDATE routines SET nextRunAt = ?, lastResult = ?, deferAttempts = ? WHERE id = ?`,
      [next, "deferred: quota", existing.deferAttempts + 1, id],
    );
    return this.get(id);
  }

  close(): void {
    this.db.close();
  }
}

export function openRoutineStore(path?: string): RoutineStore {
  // P9b-12: routed through the resolver rather than hardcoding `~/.winter` — a `WINTER_HOME`
  // override must move this file with everything else.
  return new RoutineStore(path ?? join(resolveWinterHome(), "routines.db"));
}
