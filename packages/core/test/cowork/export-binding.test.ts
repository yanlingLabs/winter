import { afterEach, expect, test } from "bun:test";
import { SqliteExportContentBinding } from "../../src/cowork/export-binding";
import { CoworkLifecycleError } from "../../src/cowork/storage-lifecycle";
import { PROOF, fixture, runCleanup, type Fixture } from "./export-fixture";

afterEach(runCleanup);
// DOOR's migration 20, copied from the header of export-binding.ts: this file exercises the class against that exact DDL.
const DDL = [
  "ALTER TABLE cowork_exports ADD COLUMN content_digest TEXT CHECK (content_digest IS NULL OR (length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'))",
  `CREATE TABLE cowork_export_output_ids (
     export_id TEXT NOT NULL REFERENCES cowork_exports(export_id),
     opaque_id TEXT NOT NULL CHECK (length(opaque_id) = 17 AND opaque_id GLOB 's*' AND substr(opaque_id, 2) NOT GLOB '*[^0-9a-f]*'),
     session_id TEXT NOT NULL,
     PRIMARY KEY (export_id, opaque_id), UNIQUE (export_id, session_id))`,
];
async function prepared() {
  const f = await fixture(); for (const sql of DDL) f.db.db.run(sql);
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
