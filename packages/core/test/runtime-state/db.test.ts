import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapWinterDir } from "../../src/winter-dir";
import { openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, RuntimeStateUnavailableError } from "../../src/runtime-state/db";

const homes: string[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), "winter-8a-")); homes.push(h); bootstrapWinterDir(h); return h; };
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const CURRENT_TABLES = ["directory_cursors", "directory_entries", "global_message_receipts", "global_messages", "held_messages", "idle_subscriptions", "memory_key_manifest", "name_leases", "projection_applied", "runtime_children", "runtime_generations", "runtime_handoffs", "runtime_projection_cursors", "runtime_recovery_attempts", "runtime_sessions", "runtime_sink_calls", "schema_meta", "transcript_dialects"].sort();

describe("runtime-state.db", () => {
  test("opens, migrates to the current schema, and reports integrity", () => {
    const h = home();
    const rs = openRuntimeStateDb(h);
    expect(rs.path).toBe(join(h, "runtimes", "runtime-state.db"));
    expect(rs.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
    const report = rs.integrity();
    expect(report.ok).toBe(true);
    // Fix round 1, minor (c): exact set equality (sorted) rather than 17 separate `toContain`
    // checks — a stray extra table would previously pass unnoticed.
    expect([...report.tables].sort()).toEqual(CURRENT_TABLES);
    expect(rs.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    rs.close();
  });
  // P8b-29: schema v2 re-shapes `memory_key_manifest` to one row per moved ENTRY, because the
  // destination directory is shared with the Winter SDK's transcripts and only an entry-level move
  // can merge into it reversibly. A v1 file must migrate IN PLACE, and the one thing a v1 row can
  // carry forward — where a tree went — must survive, or a relocated tree would lose its way back.
  describe("the v1 -> v2 memory-key manifest migration", () => {
    /** A schema-v1 database, written exactly as 8a's build would have left it. */
    function writeV1(h: string, rows: Array<{ old_key: string; new_key: string; status: string }> = []): string {
      const path = join(h, "runtimes", "runtime-state.db");
      const db = new Database(path, { create: true });
      db.run("PRAGMA journal_mode = WAL");
      db.run(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      db.run(`CREATE TABLE memory_key_manifest (old_key TEXT PRIMARY KEY, new_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('planned','moved','rolled-back')), planned_at TEXT NOT NULL, moved_at TEXT)`);
      // Winter Phase 8c: schema v5 adds a column to `runtime_sessions`, and a REAL v1 database always
      // has this table (migration 1 creates it) — this fixture omitted it because no migration
      // between v1 and v4 ever touched it, which stopped being true the moment one did. Minimal but
      // faithful: same columns/constraints as migration 1's own CREATE TABLE, no rows.
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
      for (const r of rows) db.run("INSERT INTO memory_key_manifest (old_key, new_key, status, planned_at, moved_at) VALUES (?, ?, ?, ?, NULL)", [r.old_key, r.new_key, r.status, "2026-09-01T00:00:00.000Z"]);
      db.run("PRAGMA user_version = 1");
      db.close();
      return path;
    }

    test("a v1 file opens, migrates in place, and keeps every other table's data", () => {
      const h = home();
      writeV1(h);
      const first = new Database(join(h, "runtimes", "runtime-state.db"));
      first.run("INSERT INTO schema_meta(key, value) VALUES ('probe', 'kept')");
      first.close();

      const rs = openRuntimeStateDb(h);
      try {
        expect(rs.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
        expect(rs.integrity().ok).toBe(true);
        expect(rs.db.query("SELECT value FROM schema_meta WHERE key='probe'").get()).toEqual({ value: "kept" });
        // The new shape: one row per entry, keyed by the pair.
        const cols = (rs.db.query("PRAGMA table_info(memory_key_manifest)").all() as Array<{ name: string }>).map((c) => c.name);
        expect(cols).toContain("entry");
        // And the v1 table is gone rather than left shadowing the new one.
        expect(rs.integrity().tables).not.toContain("memory_key_manifest_v1");
      } finally {
        rs.close();
      }
    });

    test("a v1 row survives as the `memory` entry — the one a torn apply's repair and a rollback both need", () => {
      const h = home();
      writeV1(h, [
        { old_key: "old-a", new_key: "new-a", status: "moved" },
        { old_key: "old-b", new_key: "new-b", status: "planned" },
      ]);
      const rs = openRuntimeStateDb(h);
      try {
        expect(rs.db.query("SELECT old_key, entry, new_key, status FROM memory_key_manifest ORDER BY old_key").all()).toEqual([
          { old_key: "old-a", entry: "memory", new_key: "new-a", status: "moved" },
          { old_key: "old-b", entry: "memory", new_key: "new-b", status: "planned" },
        ]);
      } finally {
        rs.close();
      }
    });
  });

  test("a second open is idempotent (no re-migration, same version)", () => {
    const h = home(); openRuntimeStateDb(h).close();
    const rs = openRuntimeStateDb(h); expect(rs.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION); rs.close();
  });
  test("backup writes a consistent copy that opens on its own", () => {
    const h = home(); const rs = openRuntimeStateDb(h);
    rs.db.run("INSERT INTO schema_meta(key, value) VALUES ('probe', 'x')");
    const copy = rs.backup();
    expect(copy.startsWith(join(h, "runtimes", "backups"))).toBe(true);
    const b = new Database(copy, { readonly: true });
    expect(b.query("SELECT value FROM schema_meta WHERE key='probe'").get()).toEqual({ value: "x" });
    b.close(); rs.close();
  });
  test("two immediate backups produce two distinct files", () => {
    // Fix round 1, minor (b): the timestamp alone collides within the same millisecond.
    const h = home(); const rs = openRuntimeStateDb(h);
    const b1 = rs.backup();
    const b2 = rs.backup();
    expect(b1).not.toBe(b2);
    expect(existsSync(b1)).toBe(true);
    expect(existsSync(b2)).toBe(true);
    // Minors follow-up (re-review): pin the actual disambiguator (pid + base36 sequence) rather
    // than just "the two strings differ" — a test that only checks inequality would still pass if
    // the millisecond timestamp had simply ticked over between the two calls, which doesn't
    // exercise the same-millisecond collision this fix addresses.
    const suffixRe = /-(\d+)-([0-9a-z]+)\.db$/;
    const m1 = b1.match(suffixRe);
    const m2 = b2.match(suffixRe);
    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();
    expect(m1![2]).not.toBe(m2![2]);
    rs.close();
  });
  test("an immediate transaction takes the write lock up front; a deferred one does not", () => {
    // Review r1 finding 2: a read-then-write transaction (a lease claim) must not lose its snapshot
    // to a concurrent writer and surface SQLITE_BUSY_SNAPSHOT. The discriminating, deterministic
    // probe is a SECOND connection writing from inside the window: under `deferred` (nothing locked
    // yet, this transaction has only read) it succeeds; under `immediate`/`exclusive` the RESERVED
    // lock is already held, so it fails with "database is locked" once its own busy_timeout expires
    // — set to 50 ms on that connection so the test costs milliseconds, not the daemon's 5 s.
    const h = home();
    const rs = openRuntimeStateDb(h);
    const other = new Database(rs.path);
    other.run("PRAGMA busy_timeout = 50");
    const otherWrites = (): string => {
      try {
        other.run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('probe', 'other')");
        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    };
    const readThenProbe = () => {
      rs.db.query("SELECT value FROM schema_meta WHERE key = 'created_at'").get();
      return otherWrites();
    };

    expect(rs.transaction(readThenProbe)).toBe("ok");
    expect(rs.transaction(readThenProbe, { mode: "deferred" })).toBe("ok");
    expect(rs.transaction(readThenProbe, { mode: "immediate" })).toMatch(/locked/);
    expect(rs.transaction(readThenProbe, { mode: "exclusive" })).toMatch(/locked/);
    // the mode never changes what a transaction returns or its rollback-on-throw contract
    expect(rs.transaction(() => 42, { mode: "immediate" })).toBe(42);
    expect(() =>
      rs.transaction(() => {
        rs.db.run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('rolled', 'back')");
        throw new Error("boom");
      }, { mode: "immediate" }),
    ).toThrow("boom");
    expect(rs.db.query("SELECT value FROM schema_meta WHERE key = 'rolled'").get()).toBeNull();

    other.close();
    rs.close();
  });

  test("a corrupt file is a typed refusal, never a silent recreate", () => {
    const h = home(); writeFileSync(join(h, "runtimes", "runtime-state.db"), "not a database");
    expect(() => openRuntimeStateDb(h)).toThrow(RuntimeStateUnavailableError);
    expect(() => openRuntimeStateDb(h)).toThrow(/corrupt/);
  });
  test("a corrupt file opened twice never leaks the failed attempt's handle", () => {
    // Fix round 1, finding 3: a leaked handle from the first failed open used to keep the file
    // locked/in a WAL-adjacent state; the second open must fail identically, and no -wal sidecar
    // should linger from either attempt.
    // NOTE: this fixture (garbage text from byte 0) fails header validation inside the very first
    // PRAGMA, before WAL is ever engaged — no -wal file is created whether or not the handle leaks,
    // so the sidecar assertions below hold regardless of the fix. It still checks a real property
    // (repeated opens on the same broken file fail identically), but it does NOT discriminate the
    // handle-leak fix — see the header-valid/body-corrupt test below for that.
    const h = home();
    const path = join(h, "runtimes", "runtime-state.db");
    writeFileSync(path, "not a database");
    expect(() => openRuntimeStateDb(h)).toThrow(/corrupt/);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(() => openRuntimeStateDb(h)).toThrow(/corrupt/);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });
  test("a corrupt (header-valid, body-scribbled) file: the failed open's handle is closed exactly once", () => {
    // Minors follow-up (re-review): unlike the garbage-text fixture above, this one has an intact
    // header — `new Database()` opens it, `PRAGMA journal_mode = WAL` succeeds (a real WAL
    // connection is established), and only `PRAGMA quick_check` (which reads every page) trips over
    // the scribbled page 2. This is the fixture that actually discriminates the `db?.close()` fix:
    // with the fixture above, no WAL connection is ever live, so there's nothing for the leak to
    // leak. Originally asserted `existsSync(path + "-wal")` is false after the failed open, but that
    // proved flaky exactly as anticipated — closing a connection to a database whose body is
    // corrupt does not necessarily get to checkpoint (and hence remove) the WAL file, so the
    // assertion failed even WITH the fix applied. Falling back to spying on
    // `Database.prototype.close` and counting calls instead, per the fallback the review specified.
    // Verified this discriminates by temporarily reverting the `db?.close()` line locally (that run
    // asserts 0 calls, not 1) — both runs' output are in task-1-report.md "Minors follow-up".
    const h = home();
    const path = join(h, "runtimes", "runtime-state.db");
    openRuntimeStateDb(h).close(); // a real v1 db — valid header, WAL already engaged once
    const fd = openSync(path, "r+");
    writeSync(fd, Buffer.alloc(256, 0x41), 0, 256, 4096); // scribble page 2 (page size 4096); header untouched
    closeSync(fd);
    let closeCalls = 0;
    const originalClose = Database.prototype.close;
    Database.prototype.close = function (this: Database, ...args: unknown[]) {
      closeCalls++;
      return (originalClose as (...a: unknown[]) => void).apply(this, args);
    };
    try {
      expect(() => openRuntimeStateDb(h)).toThrow(/corrupt/);
    } finally {
      Database.prototype.close = originalClose;
    }
    expect(closeCalls).toBe(1);
  });
  test("a missing file with createIfMissing:false is a typed refusal", () => {
    const h = home();
    expect(() => openRuntimeStateDb(h, { createIfMissing: false })).toThrow(/missing/);
    expect(existsSync(join(h, "runtimes", "runtime-state.db"))).toBe(false);
  });
  test("a newer schema is refused (never downgraded)", () => {
    const h = home(); const rs = openRuntimeStateDb(h); rs.db.run("PRAGMA user_version = 99"); rs.close();
    expect(() => openRuntimeStateDb(h)).toThrow(/newer-schema/);
  });
  test("a readonly open of a not-yet-migrated file is a typed refusal, not a silent v0 handle", () => {
    // Fix round 1, minor (a): readonly can never run the v1 migration, so handing back a
    // schemaVersion-0 handle with none of the v1 tables would be a worse trap than refusing.
    const h = home();
    const path = join(h, "runtimes", "runtime-state.db");
    new Database(path, { create: true }).close(); // valid sqlite file, never migrated (version 0)
    expect(() => openRuntimeStateDb(h, { readonly: true })).toThrow(RuntimeStateUnavailableError);
    expect(() => openRuntimeStateDb(h, { readonly: true })).toThrow(/unmigrated/);
  });
  test("backup on a readonly handle still copies but skips the schema_meta write", () => {
    // Fix round 1, minor (a): VACUUM INTO works on a readonly connection; writing back the
    // last_backup_path marker into the source does not, and must not be attempted.
    const h = home();
    openRuntimeStateDb(h).close(); // migrate to v1 first
    const rs = openRuntimeStateDb(h, { readonly: true });
    const copy = rs.backup();
    const b = new Database(copy, { readonly: true });
    expect(b.query("SELECT value FROM schema_meta WHERE key='last_backup_path'").get()).toBeNull();
    b.close();
    expect(rs.db.query("SELECT value FROM schema_meta WHERE key='last_backup_path'").get()).toBeNull();
    rs.close();
  });
});
