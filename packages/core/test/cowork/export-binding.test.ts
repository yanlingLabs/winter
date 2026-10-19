import { afterEach, expect, test } from "bun:test";
import { SqliteExportContentBinding } from "../../src/cowork/export-binding";
import { CoworkLifecycleError } from "../../src/cowork/storage-lifecycle";
import { RUNTIME_STATE_SCHEMA_VERSION } from "../../src/runtime-state/db";
import { COWORK_TABLES } from "../../src/cowork/schema";
import { PROOF, fixture, runCleanup } from "./export-fixture";

afterEach(runCleanup);
// The real tables: migration 20 (cowork/schema.ts, DOOR's #114), not a copy of its DDL.
async function prepared() {
  const f = await fixture();
  const p = f.exportsRecords.prepare(f.workspaceId, PROOF);
  return { f, exportId: p.exportId, binding: new SqliteExportContentBinding(f.db) };
}
const D = "a".repeat(64), O1 = `s${"1".repeat(16)}`, O2 = `s${"2".repeat(16)}`;
const refuses = (fn: () => unknown) => { try { fn(); } catch (error) { expect(error).toBeInstanceOf(CoworkLifecycleError); return; } throw new Error("expected a refusal"); };

test("a binding records once on a prepared generation and reads back; before that, and for an unknown id, it reads null", async () => {
  const { exportId, binding } = await prepared();
  expect(binding.read(exportId)).toBeNull(); expect(binding.read("export_unknown")).toBeNull();
  binding.record(exportId, { contentDigest: D, outputIds: { [O1]: "session-one", [O2]: "session-two" } });
  expect(binding.read(exportId)).toEqual({ contentDigest: D, outputIds: { [O1]: "session-one", [O2]: "session-two" } });
  refuses(() => binding.record(exportId, { contentDigest: "b".repeat(64), outputIds: {} })); // never rewritten
  expect(binding.read(exportId)!.contentDigest).toBe(D);
});

test("a binding for a completed or failed generation, or with a malformed digest, id or duplicate session, is refused and writes nothing", async () => {
  const { f, exportId, binding } = await prepared();
  for (const bad of [{ contentDigest: "A".repeat(64), outputIds: {} }, { contentDigest: "a".repeat(63), outputIds: {} }, { contentDigest: D, outputIds: { s1: "x" } },
    { contentDigest: D, outputIds: { [O1]: "" } }, { contentDigest: D, outputIds: { [O1]: "same", [O2]: "same" } }, { contentDigest: D, outputIds: { [`S${"1".repeat(16)}`]: "x" } }])
    refuses(() => binding.record(exportId, bad));
  expect(binding.read(exportId)).toBeNull(); expect(f.db.db.query("SELECT count(*) AS n FROM cowork_export_output_ids").get()).toEqual({ n: 0 });
  f.exportsRecords.fail(exportId, PROOF);
  refuses(() => binding.record(exportId, { contentDigest: D, outputIds: {} }));
  refuses(() => binding.record("export_unknown", { contentDigest: D, outputIds: {} }));
});

test("the map is written with the digest or not at all", async () => {
  const { f, exportId, binding } = await prepared();
  f.db.db.run("INSERT INTO cowork_export_output_ids VALUES(?,?,?)", [exportId, O1, "taken"]); // a stray row makes the second insert collide
  expect(() => binding.record(exportId, { contentDigest: D, outputIds: { [O1]: "session-one" } })).toThrow(); // the PRIMARY KEY collision rolls the UPDATE back
  expect(f.db.db.query<{ content_digest: string | null }, [string]>("SELECT content_digest FROM cowork_exports WHERE export_id=?").get(exportId)!.content_digest).toBeNull();
});

test("the tables are the ones migration 20 creates, and the database refuses what the class would never write", async () => {
  const { f, exportId, binding } = await prepared();
  expect(RUNTIME_STATE_SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
  expect(COWORK_TABLES).toContain("cowork_export_output_ids");
  expect(f.db.db.query<{ name: string }, []>("PRAGMA table_info(cowork_exports)").all().map(column => column.name)).toContain("content_digest");
  // The CHECKs and keys are the database's own, independent of the class's validation.
  expect(() => f.db.db.run("UPDATE cowork_exports SET content_digest=? WHERE export_id=?", ["A".repeat(64), exportId])).toThrow();
  expect(() => f.db.db.run("INSERT INTO cowork_export_output_ids VALUES(?,?,?)", [exportId, "s1", "x"])).toThrow();
  expect(() => f.db.db.run("INSERT INTO cowork_export_output_ids VALUES(?,?,?)", ["export_unknown", O1, "x"])).toThrow();
  binding.record(exportId, { contentDigest: D, outputIds: { [O1]: "session-one" } });
  expect(() => f.db.db.run("INSERT INTO cowork_export_output_ids VALUES(?,?,?)", [exportId, O2, "session-one"])).toThrow(); // UNIQUE(export_id, session_id)
});
