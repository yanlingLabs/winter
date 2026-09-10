// WS-16 §12's `PersistedWinterChild`: the durable roster of a session's Winter children, which is
// what replaces the in-memory `BackgroundAgentRegistry` a daemon restart used to lose wholesale.
//
// EVERY VALUE HERE IS A LOCATOR OR AN EFFECTIVE FACT — never a live handle. `resumeContextRef`
// points at what Winter needs to reconstruct the child through its own engine ("only what Winter
// needs… never an in-memory closure or `AbortController`"), so a closure reaching `upsert` is a
// programming error caught here rather than a row that silently stores `[object Function]` and
// resurrects nothing. `providerId`/`modelRef`/`slot`/`permission` are the child's POST-inheritance
// resolution: what it actually ran as, not what was requested.
//
// The other §12 rule this file enforces is negative: a restart never rewrites a child that already
// finished. `running` becomes `interrupted` only for children whose process/thread the caller has
// PROVEN gone — the proof is the caller's (`isGone`), because only the runtime that owned the child
// can establish it.
import type { RuntimeStateDb } from "./db";

export type ChildStatus = "running" | "interrupted" | "completed" | "failed" | "stopped" | "timeout";

export interface PersistedWinterChild {
  parentWinterSessionId: string;
  childId: string;
  name?: string;
  agentType: string;
  providerId: string;
  modelRef: string;
  connectionRef?: string;
  providerCatalogVersion: string;
  providerAdapterVersion: string;
  status: ChildStatus;
  transcriptRef: string;
  /** A locator under the session's durable child profile — never a closure (WS-16 §12). */
  resumeContextRef?: string;
  worktreeRef?: string;
  startedAt: string;
  completedAt?: string;
  generation: number;
  requestedModel?: string;
  effectiveModel?: string;
  effectiveProvider?: string;
  slot?: { family: string; name: string; source: string };
  permission?: { effectiveMode: string; parentPolicyHash: string };
}

/** Which child a result line is about. Two parents may mint the same `childId`, so a bare id cannot
 *  say whose child was interrupted — the pair can (review r1 minor 8). */
export interface ChildRef {
  parent: string;
  childId: string;
}

/** The statuses that mean "this child is over", i.e. the ones that stamp `completedAt`.
 *  `interrupted` is deliberately absent: WS-16 §12 calls it "interrupted/recoverable". */
const TERMINAL: ReadonlySet<ChildStatus> = new Set<ChildStatus>(["completed", "failed", "stopped", "timeout"]);

/** WS-16 §12: a child that already finished is evidence of what happened, not state to rewrite. An
 *  `upsert` that would push a terminal row back to `running` (a restart re-registering children off
 *  a stale roster is exactly how that happens) is refused rather than silently dropping the row's
 *  outcome and its `completedAt`. */
export class ChildAlreadyTerminalError extends Error {
  constructor(public readonly parentWinterSessionId: string, public readonly childId: string, public readonly status: ChildStatus) {
    super(`child ${childId} of ${parentWinterSessionId} already finished as ${status}`);
    this.name = "ChildAlreadyTerminalError";
  }
}

const CHILD_COLUMNS =
  "parent_winter_session_id, child_id, name, agent_type, provider_id, model_ref, connection_ref, provider_catalog_version, provider_adapter_version, " +
  "status, transcript_ref, resume_context_ref, worktree_ref, started_at, completed_at, generation, requested_model, effective_model, effective_provider, " +
  "slot_json, permission_json";

/** Derived from `CHILD_COLUMNS` so the placeholder count can never drift from the column list. */
const CHILD_PLACEHOLDERS = CHILD_COLUMNS.split(",")
  .map(() => "?")
  .join(", ");

interface ChildDbRow {
  parent_winter_session_id: string;
  child_id: string;
  name: string | null;
  agent_type: string;
  provider_id: string;
  model_ref: string;
  connection_ref: string | null;
  provider_catalog_version: string;
  provider_adapter_version: string;
  status: string;
  transcript_ref: string;
  resume_context_ref: string | null;
  worktree_ref: string | null;
  started_at: string;
  completed_at: string | null;
  generation: number;
  requested_model: string | null;
  effective_model: string | null;
  effective_provider: string | null;
  slot_json: string | null;
  permission_json: string | null;
}

const opt = (v: string | null): string | undefined => v ?? undefined;

/**
 * Review r1 (Important 1): a damaged JSON column must not be able to hide a whole roster.
 *
 * `slot`/`permission` are DESCRIPTIVE metadata — which family slot resolved, what the effective
 * permission mode was. Nothing decides a child's STATUS from them, and `reclassifyAfterRestart` maps
 * every running child in ONE transaction, so a single unparseable `slot_json` used to throw before
 * `isGone` was consulted even once: the transaction rolled back and NO child anywhere was
 * reclassified, at every boot, forever. A row that cannot describe its slot is still a row that
 * knows whether it was running, so the field is dropped and the child is let through.
 */
const optJson = <T>(v: string | null): T | undefined => {
  if (v === null) return undefined;
  try {
    return JSON.parse(v) as T;
  } catch {
    return undefined;
  }
};

function fromRow(row: ChildDbRow): PersistedWinterChild {
  return {
    parentWinterSessionId: row.parent_winter_session_id,
    childId: row.child_id,
    name: opt(row.name),
    agentType: row.agent_type,
    providerId: row.provider_id,
    modelRef: row.model_ref,
    connectionRef: opt(row.connection_ref),
    providerCatalogVersion: row.provider_catalog_version,
    providerAdapterVersion: row.provider_adapter_version,
    status: row.status as ChildStatus,
    transcriptRef: row.transcript_ref,
    resumeContextRef: opt(row.resume_context_ref),
    worktreeRef: opt(row.worktree_ref),
    startedAt: row.started_at,
    completedAt: opt(row.completed_at),
    generation: row.generation,
    requestedModel: opt(row.requested_model),
    effectiveModel: opt(row.effective_model),
    effectiveProvider: opt(row.effective_provider),
    slot: optJson<NonNullable<PersistedWinterChild["slot"]>>(row.slot_json),
    permission: optJson<NonNullable<PersistedWinterChild["permission"]>>(row.permission_json),
  };
}

export class RuntimeChildren {
  constructor(private readonly rs: RuntimeStateDb, private readonly now: () => string = () => new Date().toISOString()) {}

  upsert(child: PersistedWinterChild): void {
    if (child.resumeContextRef !== undefined && typeof child.resumeContextRef !== "string")
      throw new TypeError("resumeContextRef must be a locator string — never a closure or handle (WS-16 §12)");
    // Read-then-write (the terminal-status check decides the write), so it begins IMMEDIATE: a
    // deferred BEGIN could lose its snapshot between the check and the INSERT.
    this.rs.transaction(
      () => {
        const existing = this.get(child.parentWinterSessionId, child.childId);
        if (existing && TERMINAL.has(existing.status) && !TERMINAL.has(child.status))
          throw new ChildAlreadyTerminalError(child.parentWinterSessionId, child.childId, existing.status);
        this.rs.db
          .query(`INSERT OR REPLACE INTO runtime_children (${CHILD_COLUMNS}) VALUES (${CHILD_PLACEHOLDERS})`)
          .run(
            child.parentWinterSessionId,
            child.childId,
            child.name ?? null,
            child.agentType,
            child.providerId,
            child.modelRef,
            child.connectionRef ?? null,
            child.providerCatalogVersion,
            child.providerAdapterVersion,
            child.status,
            child.transcriptRef,
            child.resumeContextRef ?? null,
            child.worktreeRef ?? null,
            child.startedAt,
            child.completedAt ?? null,
            child.generation,
            child.requestedModel ?? null,
            child.effectiveModel ?? null,
            child.effectiveProvider ?? null,
            child.slot ? JSON.stringify(child.slot) : null,
            child.permission ? JSON.stringify(child.permission) : null,
          );
      },
      { mode: "immediate" },
    );
  }

  get(parent: string, childId: string): PersistedWinterChild | undefined {
    const row = this.rs.db
      .query(`SELECT ${CHILD_COLUMNS} FROM runtime_children WHERE parent_winter_session_id = ? AND child_id = ?`)
      .get(parent, childId) as ChildDbRow | null;
    return row ? fromRow(row) : undefined;
  }

  list(parent: string, filter: { status?: ChildStatus | ChildStatus[] } = {}): PersistedWinterChild[] {
    const values: string[] = [parent];
    let where = "parent_winter_session_id = ?";
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
      values.push(...statuses);
    }
    const rows = this.rs.db
      .query(`SELECT ${CHILD_COLUMNS} FROM runtime_children WHERE ${where} ORDER BY started_at, child_id`)
      .all(...values) as ChildDbRow[];
    return rows.map(fromRow);
  }

  /** `completedAt` defaults to now for a terminal status and is left untouched otherwise — an
   *  interrupted child has not completed. Unknown (parent, childId) is a no-op. */
  setStatus(parent: string, childId: string, status: ChildStatus, completedAt?: string): void {
    const at = completedAt ?? (TERMINAL.has(status) ? this.now() : undefined);
    if (at === undefined) {
      this.rs.db.query(`UPDATE runtime_children SET status = ? WHERE parent_winter_session_id = ? AND child_id = ?`).run(status, parent, childId);
      return;
    }
    this.rs.db
      .query(`UPDATE runtime_children SET status = ?, completed_at = ? WHERE parent_winter_session_id = ? AND child_id = ?`)
      .run(status, at, parent, childId);
  }

  /**
   * WS-16 §12: on restart, `running` becomes `interrupted` only after the process/thread is proven
   * gone. `isGone` carries that proof — this class never guesses it, and never touches a child that
   * already reached a terminal status (that row is evidence of what happened, not state to rewrite).
   * Returns the children it interrupted and the still-running ones it left alone, as
   * `{parent, childId}` pairs — a bare id cannot say whose child it was.
   */
  reclassifyAfterRestart(
    isGone: (child: PersistedWinterChild) => boolean,
    // Review r1 (Important 1): the whole sweep is ONE transaction, so its blast radius is whatever
    // it enumerates. Scoping it to a single parent is what lets startup recovery bound step 7 per
    // session — a parent whose roster (or whose `isGone` proof) throws costs that parent's children
    // and nobody else's. Absent = every parent, which is what a caller with no bound wants.
    opts: { parent?: string } = {},
  ): { interrupted: ChildRef[]; kept: ChildRef[] } {
    return this.rs.transaction(() => {
      const where = opts.parent === undefined ? "" : " AND parent_winter_session_id = ?";
      const args = opts.parent === undefined ? [] : [opts.parent];
      const running = (
        this.rs.db.query(`SELECT ${CHILD_COLUMNS} FROM runtime_children WHERE status = 'running'${where} ORDER BY started_at, child_id`).all(...args) as ChildDbRow[]
      ).map(fromRow);
      const interrupted: ChildRef[] = [];
      const kept: ChildRef[] = [];
      for (const child of running) {
        const ref: ChildRef = { parent: child.parentWinterSessionId, childId: child.childId };
        if (!isGone(child)) {
          kept.push(ref);
          continue;
        }
        this.rs.db
          .query(`UPDATE runtime_children SET status = 'interrupted' WHERE parent_winter_session_id = ? AND child_id = ?`)
          .run(child.parentWinterSessionId, child.childId);
        interrupted.push(ref);
      }
      return { interrupted, kept };
    });
  }
}
