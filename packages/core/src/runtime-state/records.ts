// WS-16 §4's `RuntimeSessionRecord` and the repository over `runtime-state.db` that owns it: the
// durable mapping between a product session (`s_<hex>`) and the runtime that is (or was) executing
// it. Everything here is metadata about an execution boundary — provider, model ref, roots, project
// keys, versions, state. NO transcript content and NO credential material ever lands in these
// tables: `authRef` is a locator string (`keychain:<account>`), which is what makes a raw dump of
// `runtime_sessions` safe to attach to a bug report.
//
// TABLE OWNERSHIP INSIDE THIS PACKAGE. `runtime_generations` has two writers by design: this class
// owns every column except the `lease_*` four, which belong to `RuntimeLeases` (leases.ts, WS-16
// §11). Both sides UPDATE only their own columns — never a whole-row rewrite — so a lease renewal
// can never clobber a generation's end reason, and closing a generation can never drop a live
// holder. `runtime_handoffs` is append-only on purpose (WS-16 §4: "never overwrite the only evidence
// of the previous producer") and therefore has no update or delete door at all.
import type { RuntimeKind, RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import type { RuntimeStateDb } from "./db";

/** WS-16 §4's lifecycle. `unavailable` is the honest "we cannot revalidate this right now" state
 *  startup recovery parks live sessions in; `archived` is a user-visible retirement, never a delete. */
export type RuntimeSessionState = "creating" | "ready" | "running" | "idle" | "exited" | "failed" | "unavailable" | "archived";

/**
 * The state machine, spelled once. `archived` re-enters only through a deliberate unarchive
 * (WS-16 §16 — "archive is not delete"), which is why it keeps an outbound edge at all; `creating`
 * has exactly two exits, so a session that never finished its mapping commit can only become
 * `ready` or `failed` — never a visible running session (WS-16 §14 row: "before runtime mapping
 * commit → no visible ready session").
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RuntimeSessionState, readonly RuntimeSessionState[]>> = Object.freeze({
  creating: ["ready", "failed"],
  ready: ["running", "idle", "exited", "failed", "unavailable", "archived"],
  running: ["idle", "exited", "failed", "unavailable"],
  idle: ["running", "exited", "failed", "unavailable", "archived"],
  exited: ["running", "archived", "unavailable"],
  failed: ["archived", "unavailable"],
  unavailable: ["ready", "running", "idle", "exited", "failed", "archived"],
  archived: ["idle", "exited"],
} as const);

export interface RuntimeSessionRecord {
  winterSessionId: string;
  runtimeKind: RuntimeKind;
  backendSessionId?: string;
  providerId: string;
  modelRef: string;
  connectionRef?: string;
  /** Opaque locator (`keychain:openai-api-key`), never credential material — WS-16 §4. */
  authRef?: string;
  backendRoot: string;
  activeLocalWriteRoot?: string;
  activeLocalWriteRootKind?: "official-spool" | "sdk-resume-staging";
  effectiveTempDir?: string;
  transcriptProjectKey: string;
  memoryProjectKey: string;
  tempProjectKey: string;
  transcriptDialect: "claude-code-jsonl";
  transcriptHealth: "clean" | "mirror-lagging" | "repair-required" | "unsupported";
  compatibilityLevel: "conversation" | "agent-state" | "full-filesystem";
  conformanceCorpusVersion: string;
  lastVerifiedClaudeConsumer?: string;
  lastVerifiedWinterConsumer?: string;
  sdkVersion?: string;
  engineVersion?: string;
  providerCatalogVersion?: string;
  providerAdapterVersion?: string;
  versionProvenance: "recorded" | "legacy-unknown";
  createdAt: string;
  updatedAt: string;
  lastProjectedCursor?: string;
  parentWinterSessionId?: string;
  capabilities: string[];
  state: RuntimeSessionState;
  generation: number;
  selection: RuntimeSelection;
}

/** What a caller supplies: the record minus everything `create` stamps itself. */
export type NewRuntimeSessionRecord = Omit<RuntimeSessionRecord, "createdAt" | "updatedAt" | "state" | "generation" | "transcriptDialect"> & {
  transcriptDialect?: "claude-code-jsonl";
};

/** The fields `transition` may patch alongside the state change — deliberately a short list: the
 *  facts that change WHEN a session changes state. An absent key leaves the column exactly as it
 *  was; an explicit `undefined` CLEARS a nullable column (that is how `activeLocalWriteRoot` is
 *  dropped "after verified cleanup", WS-16 §4) and means "no change" for the two whose columns are
 *  NOT NULL (`transcriptHealth`, `capabilities` — see `NON_NULLABLE_PATCH_KEYS`). To empty the
 *  capability list, pass `capabilities: []`; there is no way to clear `transcriptHealth`, which
 *  always holds one of the four health values. */
export type RuntimeSessionPatch = Partial<
  Pick<
    RuntimeSessionRecord,
    | "backendSessionId"
    | "activeLocalWriteRoot"
    | "activeLocalWriteRootKind"
    | "effectiveTempDir"
    | "transcriptHealth"
    | "lastProjectedCursor"
    | "capabilities"
    | "lastVerifiedClaudeConsumer"
    | "lastVerifiedWinterConsumer"
  >
>;

/** One live attach: WS-16 §4's "`generation` increments whenever a new live backend process/handle
 *  attaches". `startedAt` defaults to now. The lease columns are absent by construction — see the
 *  ownership note at the top of this file. */
export interface GenerationInput {
  runtimeKind: RuntimeKind;
  backendSessionId?: string;
  localWriteRoot?: string;
  localWriteRootKind?: "official-spool" | "sdk-resume-staging";
  configDir?: string;
  startedAt?: string;
}

export interface GenerationRow {
  winterSessionId: string;
  generation: number;
  runtimeKind: RuntimeKind;
  backendSessionId?: string;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  localWriteRoot?: string;
  localWriteRootKind?: "official-spool" | "sdk-resume-staging";
  configDir?: string;
}

export interface HandoffHistoryEntry {
  winterSessionId: string;
  from: RuntimeKind;
  to: RuntimeKind;
  fromGeneration: number;
  toGeneration?: number;
  outcome: "resumed" | "lossy-fork-offered" | "blocked" | "failed";
  /** Free-form context (ids, counts, reasons). Read back as `{}` when nothing was recorded. */
  detail?: Record<string, unknown>;
}

/** WS-16 §4: "ambiguous backend-ID mappings are rejected, never resolved by picking a file." */
export class DuplicateBackendSessionError extends Error {
  constructor(public readonly backendSessionId: string, public readonly existingWinterSessionId: string) {
    super(`backend session ${backendSessionId} is already mapped to ${existingWinterSessionId}`);
    this.name = "DuplicateBackendSessionError";
  }
}

export class UnknownRuntimeSessionError extends Error {
  constructor(public readonly winterSessionId: string) {
    super(`unknown runtime session: ${winterSessionId}`);
    this.name = "UnknownRuntimeSessionError";
  }
}

/** No such row in `runtime_generations`. Declared here because this class owns that table's
 *  lifecycle (`bumpGeneration` is the only door that creates a row); `leases.ts` imports it rather
 *  than declaring a second one, so both halves of the shared table answer "no such generation" with
 *  the same type. */
export class UnknownRuntimeGenerationError extends Error {
  constructor(public readonly winterSessionId: string, public readonly generation: number, message?: string) {
    super(message ?? `runtime generation ${generation} of ${winterSessionId} does not exist`);
    this.name = "UnknownRuntimeGenerationError";
  }
}

export class IllegalStateTransitionError extends Error {
  constructor(public readonly from: RuntimeSessionState, public readonly to: RuntimeSessionState) {
    super(`illegal runtime session transition: ${from} → ${to}`);
    this.name = "IllegalStateTransitionError";
  }
}

/** WS-16 §4: both versions are mandatory when provenance is `recorded`; omission is reserved for
 *  `legacy-unknown` and must never be read as "current". */
export class VersionProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionProvenanceError";
  }
}

function assertProvenance(r: NewRuntimeSessionRecord): void {
  if (r.versionProvenance !== "recorded") return;
  if (!r.sdkVersion || !r.engineVersion) throw new VersionProvenanceError("recorded provenance requires sdkVersion and engineVersion");
  if (r.runtimeKind === "winter-agent" && (!r.providerCatalogVersion || !r.providerAdapterVersion))
    throw new VersionProvenanceError("a recorded winter-agent record requires providerCatalogVersion and providerAdapterVersion");
}

interface SessionRow {
  winter_session_id: string;
  runtime_kind: string;
  backend_session_id: string | null;
  provider_id: string;
  model_ref: string;
  connection_ref: string | null;
  auth_ref: string | null;
  backend_root: string;
  active_local_write_root: string | null;
  active_local_write_root_kind: string | null;
  effective_temp_dir: string | null;
  transcript_project_key: string;
  memory_project_key: string;
  temp_project_key: string;
  transcript_dialect: string;
  transcript_health: string;
  compatibility_level: string;
  conformance_corpus_version: string;
  last_verified_claude_consumer: string | null;
  last_verified_winter_consumer: string | null;
  sdk_version: string | null;
  engine_version: string | null;
  provider_catalog_version: string | null;
  provider_adapter_version: string | null;
  version_provenance: string;
  created_at: string;
  updated_at: string;
  last_projected_cursor: string | null;
  parent_winter_session_id: string | null;
  capabilities_json: string;
  state: string;
  generation: number;
  selection_json: string;
}

interface GenerationDbRow {
  winter_session_id: string;
  generation: number;
  runtime_kind: string;
  backend_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  local_write_root: string | null;
  local_write_root_kind: string | null;
  config_dir: string | null;
}

interface HandoffDbRow {
  id: number;
  winter_session_id: string;
  from_runtime_kind: string;
  to_runtime_kind: string;
  from_generation: number;
  to_generation: number | null;
  outcome: string;
  detail_json: string;
}

/** SQLite hands back `null` for an absent value; the record type spells absence as `undefined`. */
const opt = (v: string | null): string | undefined => v ?? undefined;

const SESSION_COLUMNS =
  "winter_session_id, runtime_kind, backend_session_id, provider_id, model_ref, connection_ref, auth_ref, backend_root, active_local_write_root, " +
  "active_local_write_root_kind, effective_temp_dir, transcript_project_key, memory_project_key, temp_project_key, transcript_dialect, transcript_health, " +
  "compatibility_level, conformance_corpus_version, last_verified_claude_consumer, last_verified_winter_consumer, sdk_version, engine_version, " +
  "provider_catalog_version, provider_adapter_version, version_provenance, created_at, updated_at, last_projected_cursor, parent_winter_session_id, " +
  "capabilities_json, state, generation, selection_json";

/** `?, ?, …` for every column in `SESSION_COLUMNS` — derived rather than counted by hand so the
 *  placeholder list can never drift from the column list. */
const SESSION_PLACEHOLDERS = SESSION_COLUMNS.split(",")
  .map(() => "?")
  .join(", ");

const PATCH_COLUMNS: ReadonlyArray<readonly [keyof RuntimeSessionPatch, string]> = [
  ["backendSessionId", "backend_session_id"],
  ["activeLocalWriteRoot", "active_local_write_root"],
  ["activeLocalWriteRootKind", "active_local_write_root_kind"],
  ["effectiveTempDir", "effective_temp_dir"],
  ["transcriptHealth", "transcript_health"],
  ["lastProjectedCursor", "last_projected_cursor"],
  ["capabilities", "capabilities_json"],
  ["lastVerifiedClaudeConsumer", "last_verified_claude_consumer"],
  ["lastVerifiedWinterConsumer", "last_verified_winter_consumer"],
];

const DUPLICATE_BACKEND_ID = /UNIQUE constraint failed: runtime_sessions\.backend_session_id/;

/** Patch keys whose column is NOT NULL, where "clear it" is not a state the column can be in. An
 *  explicit `undefined` for one of these therefore means "no change" rather than a write — for
 *  `transcriptHealth` a NULL is a refusal the schema would raise, and for `capabilities` an
 *  undefined used to serialise as `[]`, which silently emptied a list the caller never mentioned.
 *  Emptying the list is still available, and says so: `capabilities: []`. */
const NON_NULLABLE_PATCH_KEYS: ReadonlySet<keyof RuntimeSessionPatch> = new Set<keyof RuntimeSessionPatch>(["transcriptHealth", "capabilities"]);

function fromRow(row: SessionRow): RuntimeSessionRecord {
  return {
    winterSessionId: row.winter_session_id,
    runtimeKind: row.runtime_kind as RuntimeKind,
    backendSessionId: opt(row.backend_session_id),
    providerId: row.provider_id,
    modelRef: row.model_ref,
    connectionRef: opt(row.connection_ref),
    authRef: opt(row.auth_ref),
    backendRoot: row.backend_root,
    activeLocalWriteRoot: opt(row.active_local_write_root),
    activeLocalWriteRootKind: opt(row.active_local_write_root_kind) as RuntimeSessionRecord["activeLocalWriteRootKind"],
    effectiveTempDir: opt(row.effective_temp_dir),
    transcriptProjectKey: row.transcript_project_key,
    memoryProjectKey: row.memory_project_key,
    tempProjectKey: row.temp_project_key,
    transcriptDialect: row.transcript_dialect as RuntimeSessionRecord["transcriptDialect"],
    transcriptHealth: row.transcript_health as RuntimeSessionRecord["transcriptHealth"],
    compatibilityLevel: row.compatibility_level as RuntimeSessionRecord["compatibilityLevel"],
    conformanceCorpusVersion: row.conformance_corpus_version,
    lastVerifiedClaudeConsumer: opt(row.last_verified_claude_consumer),
    lastVerifiedWinterConsumer: opt(row.last_verified_winter_consumer),
    sdkVersion: opt(row.sdk_version),
    engineVersion: opt(row.engine_version),
    providerCatalogVersion: opt(row.provider_catalog_version),
    providerAdapterVersion: opt(row.provider_adapter_version),
    versionProvenance: row.version_provenance as RuntimeSessionRecord["versionProvenance"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastProjectedCursor: opt(row.last_projected_cursor),
    parentWinterSessionId: opt(row.parent_winter_session_id),
    capabilities: JSON.parse(row.capabilities_json) as string[],
    state: row.state as RuntimeSessionState,
    generation: row.generation,
    selection: JSON.parse(row.selection_json) as RuntimeSelection,
  };
}

function generationFromRow(row: GenerationDbRow): GenerationRow {
  return {
    winterSessionId: row.winter_session_id,
    generation: row.generation,
    runtimeKind: row.runtime_kind as RuntimeKind,
    backendSessionId: opt(row.backend_session_id),
    startedAt: row.started_at,
    endedAt: opt(row.ended_at),
    endReason: opt(row.end_reason),
    localWriteRoot: opt(row.local_write_root),
    localWriteRootKind: opt(row.local_write_root_kind) as GenerationRow["localWriteRootKind"],
    configDir: opt(row.config_dir),
  };
}

export class RuntimeSessionRecords {
  constructor(private readonly rs: RuntimeStateDb, private readonly now: () => string = () => new Date().toISOString()) {}

  create(input: NewRuntimeSessionRecord): RuntimeSessionRecord {
    assertProvenance(input);
    const at = this.now();
    return this.rs.transaction(() => {
      try {
        this.rs.db
          .query(`INSERT INTO runtime_sessions (${SESSION_COLUMNS}) VALUES (${SESSION_PLACEHOLDERS})`)
          .run(
            input.winterSessionId,
            input.runtimeKind,
            input.backendSessionId ?? null,
            input.providerId,
            input.modelRef,
            input.connectionRef ?? null,
            input.authRef ?? null,
            input.backendRoot,
            input.activeLocalWriteRoot ?? null,
            input.activeLocalWriteRootKind ?? null,
            input.effectiveTempDir ?? null,
            input.transcriptProjectKey,
            input.memoryProjectKey,
            input.tempProjectKey,
            input.transcriptDialect ?? "claude-code-jsonl",
            input.transcriptHealth,
            input.compatibilityLevel,
            input.conformanceCorpusVersion,
            input.lastVerifiedClaudeConsumer ?? null,
            input.lastVerifiedWinterConsumer ?? null,
            input.sdkVersion ?? null,
            input.engineVersion ?? null,
            input.providerCatalogVersion ?? null,
            input.providerAdapterVersion ?? null,
            input.versionProvenance,
            at,
            at,
            input.lastProjectedCursor ?? null,
            input.parentWinterSessionId ?? null,
            JSON.stringify(input.capabilities ?? []),
            "creating",
            0,
            JSON.stringify(input.selection),
          );
      } catch (e) {
        throw this.mapDuplicate(e, input.backendSessionId);
      }
      return this.require(input.winterSessionId);
    });
  }

  get(winterSessionId: string): RuntimeSessionRecord | undefined {
    const row = this.rs.db.query(`SELECT ${SESSION_COLUMNS} FROM runtime_sessions WHERE winter_session_id = ?`).get(winterSessionId) as SessionRow | null;
    return row ? fromRow(row) : undefined;
  }

  byBackendSessionId(uuid: string): RuntimeSessionRecord | undefined {
    const row = this.rs.db.query(`SELECT ${SESSION_COLUMNS} FROM runtime_sessions WHERE backend_session_id = ?`).get(uuid) as SessionRow | null;
    return row ? fromRow(row) : undefined;
  }

  list(filter: { state?: RuntimeSessionState | RuntimeSessionState[]; runtimeKind?: RuntimeKind; parentWinterSessionId?: string } = {}): RuntimeSessionRecord[] {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (filter.state !== undefined) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state];
      where.push(`state IN (${states.map(() => "?").join(", ")})`);
      values.push(...states);
    }
    if (filter.runtimeKind !== undefined) {
      where.push("runtime_kind = ?");
      values.push(filter.runtimeKind);
    }
    if (filter.parentWinterSessionId !== undefined) {
      where.push("parent_winter_session_id = ?");
      values.push(filter.parentWinterSessionId);
    }
    const sql =
      `SELECT ${SESSION_COLUMNS} FROM runtime_sessions` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY created_at, winter_session_id`;
    return (this.rs.db.query(sql).all(...values) as SessionRow[]).map(fromRow);
  }

  transition(winterSessionId: string, to: RuntimeSessionState, patch: RuntimeSessionPatch = {}): RuntimeSessionRecord {
    return this.rs.transaction(() => {
      const current = this.require(winterSessionId);
      if (!ALLOWED_TRANSITIONS[current.state].includes(to)) throw new IllegalStateTransitionError(current.state, to);
      const sets = ["state = ?", "updated_at = ?"];
      const values: (string | number | null)[] = [to, this.now()];
      for (const [key, column] of PATCH_COLUMNS) {
        if (!(key in patch)) continue;
        if (patch[key] === undefined && NON_NULLABLE_PATCH_KEYS.has(key)) continue;
        sets.push(`${column} = ?`);
        values.push(key === "capabilities" ? JSON.stringify(patch.capabilities ?? []) : (patch[key] as string | undefined) ?? null);
      }
      values.push(winterSessionId);
      try {
        this.rs.db.query(`UPDATE runtime_sessions SET ${sets.join(", ")} WHERE winter_session_id = ?`).run(...values);
      } catch (e) {
        throw this.mapDuplicate(e, patch.backendSessionId);
      }
      return this.require(winterSessionId);
    });
  }

  /** A new live backend process/handle attached: append its generation row and move the record's
   *  `generation` forward. Never touches the `lease_*` columns (leases.ts owns those). */
  bumpGeneration(winterSessionId: string, input: GenerationInput): { record: RuntimeSessionRecord; generation: number } {
    return this.rs.transaction(() => {
      const current = this.require(winterSessionId);
      const generation = current.generation + 1;
      const at = this.now();
      this.rs.db
        .query(
          `INSERT INTO runtime_generations (winter_session_id, generation, runtime_kind, backend_session_id, started_at, local_write_root, local_write_root_kind, config_dir)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          winterSessionId,
          generation,
          input.runtimeKind,
          input.backendSessionId ?? null,
          input.startedAt ?? at,
          input.localWriteRoot ?? null,
          input.localWriteRootKind ?? null,
          input.configDir ?? null,
        );
      this.rs.db.query(`UPDATE runtime_sessions SET generation = ?, updated_at = ? WHERE winter_session_id = ?`).run(generation, at, winterSessionId);
      return { record: this.require(winterSessionId), generation };
    });
  }

  endGeneration(winterSessionId: string, generation: number, endReason: string): void {
    // Read-then-write, so it begins IMMEDIATE for the same reason a lease claim does: the existence
    // check and the UPDATE must not be separated by another writer's commit.
    this.rs.transaction(
      () => {
        // Review r1 minor 10: a zero-row UPDATE reported as success is the same silent lie the lease
        // half of this table already refuses — and it is the same refusal type there.
        if (!this.generationExists(winterSessionId, generation)) throw new UnknownRuntimeGenerationError(winterSessionId, generation);
        this.rs.db
          .query(`UPDATE runtime_generations SET ended_at = ?, end_reason = ? WHERE winter_session_id = ? AND generation = ?`)
          .run(this.now(), endReason, winterSessionId, generation);
      },
      { mode: "immediate" },
    );
  }

  generations(winterSessionId: string): GenerationRow[] {
    const rows = this.rs.db
      .query(
        `SELECT winter_session_id, generation, runtime_kind, backend_session_id, started_at, ended_at, end_reason, local_write_root, local_write_root_kind, config_dir
         FROM runtime_generations WHERE winter_session_id = ? ORDER BY generation`,
      )
      .all(winterSessionId) as GenerationDbRow[];
    return rows.map(generationFromRow);
  }

  /** Append one ownership transition to the handoff history and return its row id. There is
   *  deliberately no update and no delete: this table is the only evidence of a previous producer. */
  recordHandoff(entry: HandoffHistoryEntry): number {
    const row = this.rs.db
      .query(
        `INSERT INTO runtime_handoffs (winter_session_id, from_runtime_kind, to_runtime_kind, from_generation, to_generation, outcome, detail_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        entry.winterSessionId,
        entry.from,
        entry.to,
        entry.fromGeneration,
        entry.toGeneration ?? null,
        entry.outcome,
        JSON.stringify(entry.detail ?? {}),
        this.now(),
      ) as { id: number } | null;
    return row?.id ?? 0;
  }

  handoffs(winterSessionId: string): HandoffHistoryEntry[] {
    const rows = this.rs.db
      .query(
        `SELECT id, winter_session_id, from_runtime_kind, to_runtime_kind, from_generation, to_generation, outcome, detail_json
         FROM runtime_handoffs WHERE winter_session_id = ? ORDER BY id`,
      )
      .all(winterSessionId) as HandoffDbRow[];
    return rows.map((row) => ({
      winterSessionId: row.winter_session_id,
      from: row.from_runtime_kind as RuntimeKind,
      to: row.to_runtime_kind as RuntimeKind,
      fromGeneration: row.from_generation,
      toGeneration: row.to_generation ?? undefined,
      outcome: row.outcome as HandoffHistoryEntry["outcome"],
      detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    }));
  }

  setTranscriptHealth(winterSessionId: string, health: RuntimeSessionRecord["transcriptHealth"]): void {
    this.rs.transaction(() => {
      this.require(winterSessionId);
      this.rs.db.query(`UPDATE runtime_sessions SET transcript_health = ?, updated_at = ? WHERE winter_session_id = ?`).run(health, this.now(), winterSessionId);
    });
  }

  /** The last observed dialect/corpus for a session — one row per session, replaced wholesale so a
   *  stale producer/consumer can never linger beside a fresh observation. */
  recordDialect(winterSessionId: string, dialect: { dialect: string; corpusVersion: string; producer?: string; consumer?: string }): void {
    this.rs.db
      .query(`INSERT OR REPLACE INTO transcript_dialects (winter_session_id, dialect, corpus_version, producer, consumer, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(winterSessionId, dialect.dialect, dialect.corpusVersion, dialect.producer ?? null, dialect.consumer ?? null, this.now());
  }

  private generationExists(winterSessionId: string, generation: number): boolean {
    return (
      this.rs.db.query(`SELECT 1 AS ok FROM runtime_generations WHERE winter_session_id = ? AND generation = ?`).get(winterSessionId, generation) !== null
    );
  }

  private require(winterSessionId: string): RuntimeSessionRecord {
    const record = this.get(winterSessionId);
    if (!record) throw new UnknownRuntimeSessionError(winterSessionId);
    return record;
  }

  /** SQLite's UNIQUE violation on `backend_session_id` is the ambiguous-mapping refusal WS-16 §4
   *  demands — typed here, with the existing owner named, so a caller never has to parse SQL text.
   *
   *  When the owner cannot be looked up the RAW error is rethrown untouched: `existingWinterSessionId`
   *  is an id callers render and compare, so it must never carry prose (review r1 minor 7), and a
   *  UNIQUE violation with no owner behind it means the invariant is already broken — that deserves
   *  to surface as what it is rather than be dressed up as a mapping. */
  private mapDuplicate(e: unknown, backendSessionId: string | undefined): unknown {
    if (!backendSessionId || !(e instanceof Error) || !DUPLICATE_BACKEND_ID.test(e.message)) return e;
    const owner = this.byBackendSessionId(backendSessionId);
    return owner ? new DuplicateBackendSessionError(backendSessionId, owner.winterSessionId) : e;
  }
}
