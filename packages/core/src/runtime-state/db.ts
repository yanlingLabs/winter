import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const RUNTIME_STATE_SCHEMA_VERSION = 1;

export class RuntimeStateUnavailableError extends Error {
  constructor(public readonly path: string, public readonly reason: "missing" | "corrupt" | "newer-schema", cause?: unknown) {
    super(`runtime-state.db ${reason}: ${path}`, { cause }); this.name = "RuntimeStateUnavailableError";
  }
}
export interface IntegrityReport { ok: boolean; checks: string[]; schemaVersion: number; tables: string[] }
export interface RuntimeStateDb { readonly path: string; readonly db: Database; schemaVersion(): number; integrity(): IntegrityReport; backup(destDir?: string): string; transaction<T>(fn: () => T): T; close(): void }

// Schema v1. Every column that holds a router-owned or product-owned JSON blob is named *_json;
// opaque provider state never lands here (WS-16 §7).
const MIGRATIONS: ReadonlyArray<{ version: number; up: (db: Database) => void }> = [
  { version: 1, up: (db) => {
    db.run(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`CREATE TABLE runtime_sessions (
      winter_session_id TEXT PRIMARY KEY, runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('winter-agent','claude-agent')),
      backend_session_id TEXT UNIQUE, provider_id TEXT NOT NULL, model_ref TEXT NOT NULL, connection_ref TEXT, auth_ref TEXT,
      backend_root TEXT NOT NULL, active_local_write_root TEXT, active_local_write_root_kind TEXT CHECK (active_local_write_root_kind IN ('official-spool','sdk-resume-staging')),
      effective_temp_dir TEXT, transcript_project_key TEXT NOT NULL, memory_project_key TEXT NOT NULL, temp_project_key TEXT NOT NULL,
      transcript_dialect TEXT NOT NULL DEFAULT 'claude-code-jsonl', transcript_health TEXT NOT NULL CHECK (transcript_health IN ('clean','mirror-lagging','repair-required','unsupported')),
      compatibility_level TEXT NOT NULL CHECK (compatibility_level IN ('conversation','agent-state','full-filesystem')), conformance_corpus_version TEXT NOT NULL,
      last_verified_claude_consumer TEXT, last_verified_winter_consumer TEXT, sdk_version TEXT, engine_version TEXT, provider_catalog_version TEXT, provider_adapter_version TEXT,
      version_provenance TEXT NOT NULL CHECK (version_provenance IN ('recorded','legacy-unknown')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_projected_cursor TEXT,
      parent_winter_session_id TEXT, capabilities_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL CHECK (state IN ('creating','ready','running','idle','exited','failed','unavailable','archived')), generation INTEGER NOT NULL DEFAULT 0, selection_json TEXT NOT NULL)`);
    db.run(`CREATE INDEX runtime_sessions_state ON runtime_sessions(state)`);
    db.run(`CREATE TABLE runtime_generations (winter_session_id TEXT NOT NULL REFERENCES runtime_sessions(winter_session_id), generation INTEGER NOT NULL, runtime_kind TEXT NOT NULL,
      backend_session_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT, lease_holder_pid INTEGER, lease_holder_started_at TEXT, lease_renewed_at TEXT, lease_released_at TEXT,
      local_write_root TEXT, local_write_root_kind TEXT, config_dir TEXT, PRIMARY KEY (winter_session_id, generation))`);
    db.run(`CREATE TABLE runtime_children (parent_winter_session_id TEXT NOT NULL, child_id TEXT NOT NULL, name TEXT, agent_type TEXT NOT NULL, provider_id TEXT NOT NULL, model_ref TEXT NOT NULL,
      connection_ref TEXT, provider_catalog_version TEXT NOT NULL, provider_adapter_version TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running','interrupted','completed','failed','stopped','timeout')),
      transcript_ref TEXT NOT NULL, resume_context_ref TEXT, worktree_ref TEXT, started_at TEXT NOT NULL, completed_at TEXT, generation INTEGER NOT NULL,
      requested_model TEXT, effective_model TEXT, effective_provider TEXT, slot_json TEXT, permission_json TEXT, PRIMARY KEY (parent_winter_session_id, child_id))`);
    db.run(`CREATE TABLE runtime_projection_cursors (winter_session_id TEXT NOT NULL, generation INTEGER NOT NULL, runtime_kind TEXT NOT NULL, backend_session_id TEXT,
      backend_cursor TEXT NOT NULL, last_winter_seq INTEGER NOT NULL, source_digest TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (winter_session_id, generation))`);
    db.run(`CREATE TABLE projection_applied (winter_session_id TEXT NOT NULL, generation INTEGER NOT NULL, source_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','committed')),
      first_winter_seq INTEGER, last_winter_seq INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (winter_session_id, generation, source_id))`);
    db.run(`CREATE TABLE runtime_recovery_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, daemon_pid INTEGER NOT NULL, daemon_started_at TEXT NOT NULL,
      step INTEGER NOT NULL, winter_session_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}')`);
    db.run(`CREATE TABLE runtime_handoffs (id INTEGER PRIMARY KEY AUTOINCREMENT, winter_session_id TEXT NOT NULL, from_runtime_kind TEXT NOT NULL, to_runtime_kind TEXT NOT NULL,
      from_generation INTEGER NOT NULL, to_generation INTEGER, outcome TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', recorded_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE transcript_dialects (winter_session_id TEXT PRIMARY KEY, dialect TEXT NOT NULL, corpus_version TEXT NOT NULL, producer TEXT, consumer TEXT, recorded_at TEXT NOT NULL)`);
    // The router's sinks (R-7b-2): dumb tables, JSON verbatim, no policy.
    db.run(`CREATE TABLE directory_entries (address TEXT PRIMARY KEY, entry_json TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE directory_cursors (address TEXT PRIMARY KEY, cursor TEXT NOT NULL)`);
    db.run(`CREATE TABLE held_messages (receiver TEXT NOT NULL, message_id TEXT NOT NULL, reason TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('default','explicit')), held_at INTEGER NOT NULL, expires_at INTEGER, message_json TEXT NOT NULL, PRIMARY KEY (receiver, message_id))`);
    db.run(`CREATE TABLE global_messages (message_id TEXT PRIMARY KEY, message_json TEXT NOT NULL, to_generation INTEGER NOT NULL, claimed_by TEXT, outcome_json TEXT, receipted_at TEXT, updated_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE global_message_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, outcome_json TEXT NOT NULL, receipted_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE idle_subscriptions (message_id TEXT PRIMARY KEY, subscriber TEXT NOT NULL, target TEXT NOT NULL, target_generation INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    db.run(`CREATE TABLE name_leases (name TEXT NOT NULL, address TEXT NOT NULL, generation INTEGER NOT NULL, claimed_at TEXT NOT NULL, released_at TEXT, PRIMARY KEY (name, address, claimed_at))`);
    db.run(`CREATE INDEX name_leases_name ON name_leases(name)`);
    db.run(`CREATE TABLE memory_key_manifest (old_key TEXT PRIMARY KEY, new_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('planned','moved','rolled-back')), planned_at TEXT NOT NULL, moved_at TEXT)`);
    db.run(`INSERT INTO schema_meta(key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  } },
];

export function openRuntimeStateDb(home: string, opts: { readonly?: boolean; createIfMissing?: boolean } = {}): RuntimeStateDb {
  const dir = join(home, "runtimes"); const path = join(dir, "runtime-state.db");
  const createIfMissing = opts.createIfMissing ?? !opts.readonly;
  if (!existsSync(path) && !createIfMissing) throw new RuntimeStateUnavailableError(path, "missing");
  mkdirSync(dir, { recursive: true });
  let db: Database;
  try {
    db = new Database(path, opts.readonly ? { readonly: true } : { create: true });
    db.run("PRAGMA journal_mode = WAL"); db.run("PRAGMA synchronous = NORMAL"); db.run("PRAGMA foreign_keys = ON"); db.run("PRAGMA busy_timeout = 5000");
    const quick = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
    if (quick?.quick_check !== "ok") throw new RuntimeStateUnavailableError(path, "corrupt", quick);
  } catch (e) {
    if (e instanceof RuntimeStateUnavailableError) throw e;
    throw new RuntimeStateUnavailableError(path, "corrupt", e);
  }
  const version = () => (db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
  if (version() > RUNTIME_STATE_SCHEMA_VERSION) { db.close(); throw new RuntimeStateUnavailableError(path, "newer-schema"); }
  if (!opts.readonly) for (const m of MIGRATIONS) if (version() < m.version) db.transaction(() => { m.up(db); db.run(`PRAGMA user_version = ${m.version}`); })();
  return {
    path, db,
    schemaVersion: version,
    integrity() {
      const checks = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all().map((r) => r.integrity_check);
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
      return { ok: checks.length === 1 && checks[0] === "ok", checks, schemaVersion: version(), tables };
    },
    backup(destDir = join(dir, "backups")) {
      mkdirSync(destDir, { recursive: true });
      const dest = join(destDir, `runtime-state-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      db.run(`VACUUM INTO ?`, [dest]);
      db.run(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('last_backup_path', ?)`, [dest]);
      return dest;
    },
    transaction: (fn) => db.transaction(fn)(),
    close: () => db.close(),
  };
}
