import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapNormaDir } from "../../src/norma-dir";
import { openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, RuntimeStateUnavailableError } from "../../src/runtime-state/db";

const homes: string[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), "norma-8a-")); homes.push(h); bootstrapNormaDir(h); return h; };
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const V1_TABLES = ["directory_cursors", "directory_entries", "global_message_receipts", "global_messages", "held_messages", "idle_subscriptions", "memory_key_manifest", "name_leases", "projection_applied", "runtime_children", "runtime_generations", "runtime_handoffs", "runtime_projection_cursors", "runtime_recovery_attempts", "runtime_sessions", "schema_meta", "transcript_dialects"].sort();

describe("runtime-state.db", () => {
  test("opens, migrates to schema v1, and reports integrity", () => {
    const h = home();
    const rs = openRuntimeStateDb(h);
    expect(rs.path).toBe(join(h, "runtimes", "runtime-state.db"));
    expect(rs.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
    const report = rs.integrity();
    expect(report.ok).toBe(true);
    // Fix round 1, minor (c): exact set equality (sorted) rather than 17 separate `toContain`
    // checks — a stray extra table would previously pass unnoticed.
    expect([...report.tables].sort()).toEqual(V1_TABLES);
    expect(rs.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    rs.close();
  });
  test("a second open is idempotent (no re-migration, same version)", () => {
    const h = home(); openRuntimeStateDb(h).close();
    const rs = openRuntimeStateDb(h); expect(rs.schemaVersion()).toBe(1); rs.close();
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
    const h = home();
    const path = join(h, "runtimes", "runtime-state.db");
    writeFileSync(path, "not a database");
    expect(() => openRuntimeStateDb(h)).toThrow(/corrupt/);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(() => openRuntimeStateDb(h)).toThrow(/corrupt/);
    expect(existsSync(`${path}-wal`)).toBe(false);
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
