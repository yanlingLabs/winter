// WS-21 L3.6 (spec §3.8): schema v7 — `active_local_write_root_kind` accepts the router's `run-folder`,
// and a `run_root_quarantine` table records the roots boot recovery quarantined (kept, never swept
// again, reported by `winter doctor`).
//
// THE TRAP this file exists for: `runtime_sessions` is the PARENT of `runtime_generations`' foreign
// key, and a CHECK constraint cannot be altered in place. A rename-the-old-table migration makes SQLite
// rewrite the child's REFERENCES to the renamed (then dropped) table, and `PRAGMA foreign_keys` is a
// no-op inside the migration's transaction — so the migration must follow SQLite's 12-step procedure
// (keys off OUTSIDE the transaction, new table under a temp name, copy, drop, rename the NEW one) and
// prove `foreign_key_check` clean before it commits.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION } from "../../src/runtime-state/db";

const home = () => mkdtempSync(join(tmpdir(), "winter-rs-v7-"));
const dbPath = (h: string) => join(h, "runtimes", "runtime-state.db");

const SESSION_COLS = `winter_session_id, runtime_kind, provider_id, model_ref, backend_root, transcript_project_key, memory_project_key, temp_project_key,
  transcript_health, compatibility_level, conformance_corpus_version, version_provenance, created_at, updated_at, state, selection_json, active_local_write_root, active_local_write_root_kind`;
function insertSession(db: Database, id: string, kind: string | null, root: string | null = null): void {
  db.run(`INSERT INTO runtime_sessions (${SESSION_COLS}) VALUES (?, 'claude-agent', 'anthropic', 'anthropic/claude', '/b', 'k', 'k', 'k', 'clean', 'conversation', 'c1', 'recorded', 't', 't', 'idle', '{}', ?, ?)`, [id, root, kind]);
}
function insertGeneration(db: Database, id: string, gen: number): void {
  db.run(`INSERT INTO runtime_generations (winter_session_id, generation, runtime_kind, started_at) VALUES (?, ?, 'claude-agent', 't')`, [id, gen]);
}

/** Rewind a current store to the v6 shape of `runtime_sessions` (the old CHECK), keeping its rows and
 *  its children's foreign keys pointing at `runtime_sessions` — the shape every v6 home has. */
function rewindToV6(h: string): void {
  const db = new Database(dbPath(h));
  db.run("PRAGMA foreign_keys = OFF");
  const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_sessions'").get()!.sql;
  const oldSql = sql.replace("IN ('official-spool','sdk-resume-staging','run-folder')", "IN ('official-spool','sdk-resume-staging')").replace(/^CREATE TABLE "?runtime_sessions"?/, "CREATE TABLE runtime_sessions_old");
  expect(oldSql).not.toContain("run-folder");
  db.run(oldSql);
  db.run("INSERT INTO runtime_sessions_old SELECT * FROM runtime_sessions");
  db.run("DROP TABLE runtime_sessions");
  db.run("ALTER TABLE runtime_sessions_old RENAME TO runtime_sessions");
  db.run("CREATE INDEX IF NOT EXISTS runtime_sessions_state ON runtime_sessions(state)");
  db.run("DROP TABLE IF EXISTS run_root_quarantine");
  db.run("PRAGMA user_version = 6");
  db.close();
}

describe("runtime-state schema v7 (WS-21)", () => {
  test("a fresh store is v7 and accepts run-folder; an unknown kind is still refused", () => {
    const h = home();
    const rs = openRuntimeStateDb(h);
    expect(RUNTIME_STATE_SCHEMA_VERSION).toBe(7);
    expect(rs.schemaVersion()).toBe(7);
    insertSession(rs.db, "s_1", "run-folder", "/h/cache/runs/r1");
    expect(() => insertSession(rs.db, "s_2", "somewhere-else")).toThrow();
    expect(rs.integrity().tables).toContain("run_root_quarantine");
    rs.close();
  });

  test("migrating a v6 store with generations: rows kept, the child FK still names runtime_sessions and still binds", () => {
    const h = home();
    const first = openRuntimeStateDb(h);
    insertSession(first.db, "s_a", "official-spool", "/h/spool");
    insertSession(first.db, "s_b", null);
    insertGeneration(first.db, "s_a", 1);
    insertGeneration(first.db, "s_a", 2);
    insertGeneration(first.db, "s_b", 1);
    first.close();
    rewindToV6(h);
    {
      const raw = new Database(dbPath(h));
      expect(() => insertSession(raw, "s_x", "run-folder")).toThrow(); // really the v6 CHECK
      raw.close();
    }

    const rs = openRuntimeStateDb(h);
    expect(rs.schemaVersion()).toBe(7);
    const ids = rs.db.query<{ id: string }, []>("SELECT winter_session_id AS id FROM runtime_sessions ORDER BY id").all().map((r) => r.id);
    expect(ids).toEqual(["s_a", "s_b"]);
    expect(rs.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runtime_generations").get()!.n).toBe(3);
    expect(rs.db.query<{ kind: string }, []>("SELECT active_local_write_root_kind AS kind FROM runtime_sessions WHERE winter_session_id = 's_a'").get()!.kind).toBe("official-spool");
    // the child's FK text is untouched and resolves to the NEW table
    const genSql = rs.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='runtime_generations'").get()!.sql;
    expect(genSql).toContain("REFERENCES runtime_sessions(");
    expect(genSql).not.toContain("runtime_sessions_");
    expect(rs.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => insertGeneration(rs.db, "s_missing", 1)).toThrow(); // the key still binds
    insertSession(rs.db, "s_c", "run-folder", "/h/cache/runs/r2");      // the new kind is accepted
    expect(rs.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND name='runtime_sessions_state'").get()).not.toBeNull();
    // no leftover temp table
    expect(rs.integrity().tables.filter((t) => t.startsWith("runtime_sessions"))).toEqual(["runtime_sessions"]);
    expect(rs.integrity().ok).toBe(true);
    rs.close();
  });

  test("re-running v7 over an already-v7 table (a rewound user_version) changes nothing", () => {
    const h = home();
    const first = openRuntimeStateDb(h);
    insertSession(first.db, "s_a", "run-folder", "/r");
    insertGeneration(first.db, "s_a", 1);
    first.db.run("PRAGMA user_version = 6");
    first.close();
    const rs = openRuntimeStateDb(h);
    expect(rs.schemaVersion()).toBe(7);
    expect(rs.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runtime_generations").get()!.n).toBe(1);
    expect(rs.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    rs.close();
  });

  test("the connection's foreign keys are back ON after the migration", () => {
    const h = home();
    openRuntimeStateDb(h).close();
    rewindToV6(h);
    const rs = openRuntimeStateDb(h);
    expect(rs.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    rs.close();
  });
});
