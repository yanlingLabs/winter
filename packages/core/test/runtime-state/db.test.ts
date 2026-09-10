import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapNormaDir } from "../../src/norma-dir";
import { openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, RuntimeStateUnavailableError } from "../../src/runtime-state/db";

const homes: string[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), "norma-8a-")); homes.push(h); bootstrapNormaDir(h); return h; };
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

describe("runtime-state.db", () => {
  test("opens, migrates to schema v1, and reports integrity", () => {
    const h = home();
    const rs = openRuntimeStateDb(h);
    expect(rs.path).toBe(join(h, "runtimes", "runtime-state.db"));
    expect(rs.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
    const report = rs.integrity();
    expect(report.ok).toBe(true);
    for (const t of ["runtime_sessions", "runtime_generations", "runtime_children", "runtime_projection_cursors", "runtime_recovery_attempts", "runtime_handoffs", "transcript_dialects", "global_messages", "global_message_receipts", "idle_subscriptions", "directory_entries", "directory_cursors", "held_messages", "name_leases", "projection_applied", "memory_key_manifest", "schema_meta"]) expect(report.tables).toContain(t);
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
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const b = new Database(copy, { readonly: true });
    expect(b.query("SELECT value FROM schema_meta WHERE key='probe'").get()).toEqual({ value: "x" });
    b.close(); rs.close();
  });
  test("a corrupt file is a typed refusal, never a silent recreate", () => {
    const h = home(); writeFileSync(join(h, "runtimes", "runtime-state.db"), "not a database");
    expect(() => openRuntimeStateDb(h)).toThrow(RuntimeStateUnavailableError);
    expect(() => openRuntimeStateDb(h)).toThrow(/corrupt/);
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
});
