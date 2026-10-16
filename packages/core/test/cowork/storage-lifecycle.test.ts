// Image pins and export generations (schema 16). Records only: nothing here copies a byte, mounts a disk or
// starts a guest. Document sentences are quoted at each group; every guard has a test that fails if it is removed.
import { afterEach, expect, test } from "bun:test";
import { fstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkVolumes, RAW_VOLUME_MIN_BYTES, type CoworkVolumeAuthority, type CoworkVolumeRequest } from "../../src/cowork/volumes";
import type { CoworkVolumeBackup } from "../../src/cowork/volume-backup";
import { CoworkImagePins, type CoworkImageCompatibility, type CoworkImageDigests } from "../../src/cowork/images";
import { CoworkExports, CoworkExportManifest, EXPORT_MANIFEST_MAX_BYTES, EXPORT_PLAINTEXT_DISCLOSURE } from "../../src/cowork/exports";
import { CoworkLifecycleError, canonicalJson, sha256Hex, type CoworkLifecycleAuthority, type LifecycleAction, type LifecycleFailure } from "../../src/cowork/storage-lifecycle";
import { COWORK_TABLES } from "../../src/cowork/schema";
import { downgradeCoworkRuntimeStateToV7, openRuntimeStateDb, RUNTIME_STATE_SCHEMA_VERSION, type RuntimeStateDb } from "../../src/runtime-state/db";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => { try { fn(); } catch { /* best effort */ } }); });

const PROOF = {}, A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), D = "d".repeat(64);
const volumeAuthority: CoworkVolumeAuthority = { authorize: (_a, input) => input.proof === PROOF, verifyStopped: () => true };

function fixture(opts: { compatible?: () => boolean | Promise<boolean>; ready?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-storage-lifecycle-"));
  const db: RuntimeStateDb = openRuntimeStateDb(home), repo = new CoworkRepository(db);
  cleanup.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const homeId = repo.homeIdentity();
  const made = repo.create({ principalId: "fixture-user", requestId: "create" }, {
    ownership: "project", title: "Lifecycle fixture", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }],
    ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" },
  });
  const workspaceId = made.workspaceId;
  const excluded = new Set<string>(), key = (fd: number) => { const st = fstatSync(fd); return `${st.dev}:${st.ino}`; };
  const backup: CoworkVolumeBackup = { excludeItem: (_p, fd) => { excluded.add(key(fd)); }, verifyItemExcluded: (_p, fd) => excluded.has(key(fd)), verifyDescriptorExcluded: fd => excluded.has(key(fd)) };
  const request: CoworkVolumeRequest = { workspaceId, proof: PROOF, owner: { controllerInstanceId: "c1", workerInstanceId: "w1", incarnationId: "i1", leaseEpoch: 1, runtimeImageDigest: A } };
  const volumes = new CoworkVolumes(db, home, volumeAuthority, backup);
  volumes.plan(request, { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES }); volumes.materialize(request);
  // A checkpointed filesystem: the native format/probe receipts are exercised by volume-filesystem.test.ts; this file only needs the recorded state.
  if (opts.ready !== false) db.db.run("UPDATE cowork_volumes SET filesystem_state='ready',filesystem_journal_json='{}',format_eligible=0 WHERE workspace_id=?", [workspaceId]);
  db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [workspaceId]);
  const calls: Array<{ action: LifecycleAction; workspaceId: string; homeId: string }> = [];
  const authority: CoworkLifecycleAuthority = { authorize: (action, ws, h, proof) => { calls.push({ action, workspaceId: ws, homeId: h }); return proof === PROOF; } };
  const compatibility: CoworkImageCompatibility = { compatible: () => (opts.compatible ?? (() => true))() as boolean };
  let tick = 0;
  const now = () => `2026-10-16T00:00:${String(tick++).padStart(2, "0")}.000Z`;
  let n = 0;
  const pins = new CoworkImagePins(db, authority, compatibility, now);
  const exports = new CoworkExports(db, authority, now, () => `export_fixture_${++n}`);
  const set = (sql: string, ...args: any[]) => db.db.run(sql, args);
  return { home, homeId, db, repo, workspaceId, request, volumes, authority, calls, pins, exports, set };
}
type F = ReturnType<typeof fixture>;
const refuses = (fn: () => unknown, code: LifecycleFailure) => {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(CoworkLifecycleError); expect((error as CoworkLifecycleError).code).toBe(code); return; }
  throw new Error(`expected ${code}`);
};
const digests = (base = A, runtime = B): CoworkImageDigests => ({ baseImageDigest: base, runtimeImageDigest: runtime });
const dump = (f: F) => Object.fromEntries(COWORK_TABLES.map(table => [table, f.db.db.query(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));
const pinned = (f: F) => f.pins.pin(f.workspaceId, digests(), PROOF);

// ── Image pins ───────────────────────────────────────────────────────────────────────────────────────
// cowork-spec.md: "Pin the writable environment to its base-image digest; a new base cannot silently replace
// the lower layer beneath an old installation overlay."
test("schema 16 adds the lifecycle tables; they are Cowork authority (a populated pin blocks the rollback), and an empty store still rolls back", () => {
  const f = fixture();
  expect(RUNTIME_STATE_SCHEMA_VERSION).toBe(16);
  expect(f.db.schemaVersion()).toBe(16);
  expect(COWORK_TABLES).toContain("cowork_workspace_images"); expect(COWORK_TABLES).toContain("cowork_exports");
  for (const table of ["cowork_workspace_images", "cowork_exports"]) expect(f.db.db.query("SELECT name FROM sqlite_master WHERE name=?").get(table)).not.toBeNull();
  pinned(f);
  f.db.close();
  expect(() => downgradeCoworkRuntimeStateToV7(f.home)).toThrow("Cowork authority");
});

test("a first pin records both digests; repeating it is idempotent; a different digest is a mismatch, never a quiet re-pin", () => {
  const f = fixture();
  const first = pinned(f);
  expect(first).toMatchObject({ workspaceId: f.workspaceId, baseImageDigest: A, runtimeImageDigest: B, revision: 1, pendingUpdate: null });
  expect(pinned(f)).toEqual(first);
  refuses(() => f.pins.pin(f.workspaceId, digests(C, B), PROOF), "image_digest_mismatch");
  refuses(() => f.pins.pin(f.workspaceId, digests(A, C), PROOF), "image_digest_mismatch");
  expect(f.pins.get(f.workspaceId)).toEqual(first);
  expect(f.calls.every(call => call.homeId === f.homeId && call.workspaceId === f.workspaceId)).toBe(true);
});

test("pins need the mandatory authority, a retained or archived workspace and well-formed digests; refusals write nothing", () => {
  const f = fixture(), before = dump(f);
  refuses(() => f.pins.pin(f.workspaceId, digests(), {}), "authority_denied");
  for (const bad of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)]) refuses(() => f.pins.pin(f.workspaceId, digests(bad), PROOF), "invalid_request");
  refuses(() => f.pins.pin("../x", digests(), PROOF), "invalid_request");
  refuses(() => f.pins.pin("ws_missing", digests(), PROOF), "not_found");
  for (const state of ["deleting", "deleted"]) { f.set("UPDATE cowork_workspaces SET state=? WHERE workspace_id=?", state, f.workspaceId); refuses(() => f.pins.pin(f.workspaceId, digests(), PROOF), "authority_denied"); }
  f.set("UPDATE cowork_workspaces SET state='retained' WHERE workspace_id=?", f.workspaceId);
  expect(dump(f)).toEqual(before);
  f.set("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", f.workspaceId);
  expect(pinned(f).baseImageDigest).toBe(A); // archive preserves data and may still be pinned
});

test("assertPinned refuses an unpinned workspace and any digest that is not the confirmed one — a pending update does not count", () => {
  const f = fixture();
  refuses(() => f.pins.assertPinned(f.workspaceId, digests()), "image_unpinned");
  pinned(f);
  f.pins.assertPinned(f.workspaceId, digests());
  refuses(() => f.pins.assertPinned(f.workspaceId, digests(C, B)), "image_digest_mismatch");
  refuses(() => f.pins.assertPinned(f.workspaceId, digests(A, C)), "image_digest_mismatch");
  f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF);
  refuses(() => f.pins.assertPinned(f.workspaceId, digests(C, D)), "image_digest_mismatch");
  f.pins.assertPinned(f.workspaceId, digests());
});

// cowork-spec.md: "Image/runtime updates occur while stopped. Validate compatibility, retain the previous
// environment until migration or explicit rebuild succeeds, and preserve workspace data."
test("an update begins only while stopped and unowned, with a filesystem at rest, an unpinned-free state and a compatibility `true`", () => {
  const f = fixture();
  refuses(() => f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF), "image_unpinned");
  pinned(f);
  refuses(() => f.pins.beginUpdate(f.workspaceId, digests(), PROOF), "invalid_request"); // same digests: not an update
  refuses(() => f.pins.beginUpdate(f.workspaceId, digests(C, D), {}), "authority_denied");
  f.set("UPDATE cowork_workspaces SET power='running' WHERE workspace_id=?", f.workspaceId);
  refuses(() => f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF), "volume_busy");
  f.set("UPDATE cowork_workspaces SET power='uncertain' WHERE workspace_id=?", f.workspaceId);
  refuses(() => f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF), "volume_busy");
  f.set("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", f.workspaceId);
  f.set("UPDATE cowork_volumes SET owner_json='{}' WHERE workspace_id=? AND purpose='data'", f.workspaceId);
  refuses(() => f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF), "volume_busy"); // uncertain termination retains ownership
  f.set("UPDATE cowork_volumes SET owner_json=NULL WHERE workspace_id=?", f.workspaceId);
  for (const state of ["formatting", "probing", "recovery-required"]) {
    f.set("UPDATE cowork_volumes SET filesystem_state=? WHERE workspace_id=? AND purpose='data'", state, f.workspaceId);
    refuses(() => f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF), "recovery_required");
  }
  f.set("UPDATE cowork_volumes SET filesystem_state='ready' WHERE workspace_id=?", f.workspaceId);
  expect(f.pins.get(f.workspaceId)!.pendingUpdate).toBeNull();
  const begun = f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF);
  expect(begun).toMatchObject({ baseImageDigest: A, runtimeImageDigest: B, revision: 2, pendingUpdate: { next: digests(C, D) } });
  refuses(() => f.pins.beginUpdate(f.workspaceId, digests(D, C), PROOF), "update_pending");
});

test("compatibility is a mandatory port: anything but exactly `true` (false, a promise, a throw) refuses and leaves the pin untouched", () => {
  for (const verdict of [() => false, () => Promise.resolve(true), () => { throw new Error("image catalogue unavailable"); }] as const) {
    const f = fixture({ compatible: verdict as () => boolean }), before = f.pins.pin(f.workspaceId, digests(), PROOF);
    try { f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF); throw new Error("expected refusal"); }
    catch (error) { if (error instanceof CoworkLifecycleError) expect(error.code).toBe("incompatible_image"); else expect((error as Error).message).toBe("image catalogue unavailable"); }
    expect(f.pins.get(f.workspaceId)).toEqual(before);
  }
});

test("confirm makes the pending digests live and bumps the revision; abandon keeps the previous ones; both need a pending update and a stopped workspace", () => {
  const f = fixture();
  pinned(f);
  refuses(() => f.pins.confirmUpdate(f.workspaceId, PROOF), "no_update_pending");
  refuses(() => f.pins.abandonUpdate(f.workspaceId, PROOF), "no_update_pending");
  f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF);
  f.set("UPDATE cowork_volumes SET owner_json='{}' WHERE workspace_id=? AND purpose='environment'", f.workspaceId);
  refuses(() => f.pins.confirmUpdate(f.workspaceId, PROOF), "volume_busy"); // an owner appeared mid-update
  refuses(() => f.pins.abandonUpdate(f.workspaceId, PROOF), "volume_busy");
  expect(f.pins.get(f.workspaceId)).toMatchObject({ baseImageDigest: A, runtimeImageDigest: B });
  f.set("UPDATE cowork_volumes SET owner_json=NULL WHERE workspace_id=?", f.workspaceId);
  refuses(() => f.pins.confirmUpdate(f.workspaceId, {}), "authority_denied");
  const abandoned = f.pins.abandonUpdate(f.workspaceId, PROOF);
  expect(abandoned).toMatchObject({ baseImageDigest: A, runtimeImageDigest: B, pendingUpdate: null, revision: 3 });
  f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF);
  const confirmed = f.pins.confirmUpdate(f.workspaceId, PROOF);
  expect(confirmed).toMatchObject({ baseImageDigest: C, runtimeImageDigest: D, pendingUpdate: null, revision: 5 });
  f.pins.assertPinned(f.workspaceId, digests(C, D));
  refuses(() => f.pins.assertPinned(f.workspaceId, digests()), "image_digest_mismatch");
});

test("a pin survives closing and reopening the database, and a malformed pending record is recovery-required rather than guessed", () => {
  const f = fixture();
  pinned(f); f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF);
  const reopened = openRuntimeStateDb(f.home); cleanup.push(() => reopened.close());
  const pins = new CoworkImagePins(reopened, f.authority, { compatible: () => true });
  expect(pins.get(f.workspaceId)).toMatchObject({ baseImageDigest: A, pendingUpdate: { next: digests(C, D) } });
  reopened.db.run("UPDATE cowork_workspace_images SET pending_update_json='{\"next\":{}}' WHERE workspace_id=?", [f.workspaceId]);
  refuses(() => pins.get(f.workspaceId), "recovery_required");
  reopened.db.run("UPDATE cowork_workspace_images SET pending_update_json=? WHERE workspace_id=?", [JSON.stringify({ next: digests(C, D), startedAt: "t", extra: true }), f.workspaceId]);
  refuses(() => pins.get(f.workspaceId), "recovery_required"); // a closed record: no unknown field is tolerated
  reopened.db.run("UPDATE cowork_workspace_images SET pending_update_json=? WHERE workspace_id=?", [JSON.stringify({ next: digests(C, D), startedAt: "t" }), f.workspaceId]);
  expect(pins.get(f.workspaceId)!.pendingUpdate).toEqual({ next: digests(C, D), startedAt: "t" });
});

// ── Export generations ───────────────────────────────────────────────────────────────────────────────
// execution-contracts.md: "Explicit exports require a consistent quiescent generation and disclose that
// exported images are plaintext."
test("prepare records one generation whose closed manifest names identity, relative locations, formats and digests — and nothing authority-bearing", () => {
  const f = fixture(); pinned(f);
  const prepared = f.exports.prepare(f.workspaceId, PROOF);
  expect(prepared.generation).toBe(1); expect(prepared.exportId).toBe("export_fixture_1");
  expect(prepared.disclosure).toBe(EXPORT_PLAINTEXT_DISCLOSURE); expect(prepared.manifest.plaintextImages).toBe(true);
  expect(prepared.manifestDigest).toBe(sha256Hex(prepared.manifestJson)); expect(prepared.manifestJson).toBe(canonicalJson(prepared.manifest));
  expect(Object.keys(prepared.manifest).sort()).toEqual(["formatVersion", "generation", "homeId", "images", "kind", "plaintextImages", "volumes", "workspace"]);
  expect(prepared.manifest.volumes.map(v => [v.purpose, v.relativePath, v.format, v.formatVersion])).toEqual([["data", "data.ext4", "raw-ext4-v1", 1], ["environment", "env.ext4", "raw-ext4-v1", 1]]);
  for (const v of prepared.manifest.volumes) expect(Object.keys(v).sort()).toEqual(["capacityBytes", "creationId", "filesystemUuid", "format", "formatVersion", "purpose", "relativePath", "volumeId"]);
  expect(prepared.manifest.images).toEqual({ baseImageDigest: A, runtimeImageDigest: B });
  expect(prepared.manifest.homeId).toBe(f.homeId); expect(prepared.manifest.workspace).toEqual({ workspaceId: f.workspaceId, ownership: "project" });
  // Host-local file identity, owners, grants, sources, titles and session ids are never carried.
  const keys = (value: any): string[] => Array.isArray(value) ? value.flatMap(keys) : value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]) : [];
  for (const forbidden of ["device", "inode", "uid", "mode", "owner", "owner_json", "grants", "grantRef", "bookmark", "sources", "title", "sessionId", "policy", "ceiling"]) expect(keys(prepared.manifest)).not.toContain(forbidden);
  expect(prepared.manifestJson).not.toContain("Lifecycle fixture");
  expect(f.exports.get("export_fixture_1")).toMatchObject({ state: "prepared", generation: 1, manifestDigest: prepared.manifestDigest });
  refuses(() => f.exports.prepare(f.workspaceId, PROOF), "export_in_progress");
});

test("prepare refuses a workspace that is not stopped, unowned, ready, pinned and update-free; refusals write nothing", () => {
  const f = fixture();
  refuses(() => f.exports.prepare(f.workspaceId, PROOF), "image_unpinned");
  pinned(f); const pinnedState = dump(f);
  refuses(() => f.exports.prepare(f.workspaceId, {}), "authority_denied");
  refuses(() => f.exports.prepare("ws_missing", PROOF), "not_found");
  f.set("UPDATE cowork_workspaces SET power='running' WHERE workspace_id=?", f.workspaceId); refuses(() => f.exports.prepare(f.workspaceId, PROOF), "volume_busy");
  f.set("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", f.workspaceId);
  f.set("UPDATE cowork_volumes SET owner_json='{}' WHERE workspace_id=? AND purpose='data'", f.workspaceId); refuses(() => f.exports.prepare(f.workspaceId, PROOF), "volume_busy");
  f.set("UPDATE cowork_volumes SET owner_json=NULL WHERE workspace_id=?", f.workspaceId);
  for (const state of ["unformatted", "recovery-required"]) {
    f.set("PRAGMA ignore_check_constraints=ON"); f.set("UPDATE cowork_volumes SET filesystem_state=? WHERE workspace_id=? AND purpose='environment'", state, f.workspaceId); f.set("PRAGMA ignore_check_constraints=OFF");
    refuses(() => f.exports.prepare(f.workspaceId, PROOF), state === "recovery-required" ? "recovery_required" : "export_not_ready");
  }
  f.set("UPDATE cowork_volumes SET filesystem_state='ready' WHERE workspace_id=?", f.workspaceId);
  f.set("PRAGMA ignore_check_constraints=ON"); f.set("UPDATE cowork_volumes SET format='future-encrypted-v2' WHERE purpose='data'"); f.set("PRAGMA ignore_check_constraints=OFF");
  refuses(() => f.exports.prepare(f.workspaceId, PROOF), "unknown_format");
  f.set("PRAGMA ignore_check_constraints=ON"); f.set("UPDATE cowork_volumes SET format='raw-ext4-v1' WHERE purpose='data'"); f.set("PRAGMA ignore_check_constraints=OFF");
  f.pins.beginUpdate(f.workspaceId, digests(C, D), PROOF);
  refuses(() => f.exports.prepare(f.workspaceId, PROOF), "update_pending");
  f.pins.abandonUpdate(f.workspaceId, PROOF);
  f.set("UPDATE cowork_workspaces SET state='deleting' WHERE workspace_id=?", f.workspaceId); refuses(() => f.exports.prepare(f.workspaceId, PROOF), "authority_denied");
  f.set("UPDATE cowork_workspaces SET state='retained' WHERE workspace_id=?", f.workspaceId);
  expect(f.db.db.query("SELECT count(*) AS n FROM cowork_exports").get()).toEqual({ n: 0 });
  expect(dump(f)["cowork_volumes"]).toEqual(pinnedState["cowork_volumes"]);
  // an archived workspace — "retain it for explicit export" — may be exported
  f.set("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", f.workspaceId);
  expect(f.exports.prepare(f.workspaceId, PROOF).generation).toBe(1);
});

test("a volume pair that is missing is not exportable and nothing is invented", () => {
  const f = fixture(); pinned(f);
  f.set("DELETE FROM cowork_volumes WHERE workspace_id=? AND purpose='environment'", f.workspaceId);
  refuses(() => f.exports.prepare(f.workspaceId, PROOF), "export_not_ready");
});

test("complete requires canonical state to be exactly what the manifest described; otherwise the generation fails and numbers are never reused", () => {
  const f = fixture(); pinned(f);
  const first = f.exports.prepare(f.workspaceId, PROOF);
  expect(f.exports.complete(first.exportId, PROOF)).toMatchObject({ state: "complete", generation: 1 });
  expect(f.exports.complete(first.exportId, PROOF).state).toBe("complete"); // idempotent
  refuses(() => f.exports.fail(first.exportId, PROOF), "invalid_request"); // a completed generation is history
  const second = f.exports.prepare(f.workspaceId, PROOF);
  expect(second.generation).toBe(2);
  f.set("UPDATE cowork_volumes SET owner_json='{}' WHERE workspace_id=? AND purpose='data'", f.workspaceId); // a writer attached during capture
  refuses(() => f.exports.complete(second.exportId, PROOF), "generation_stale");
  expect(f.exports.get(second.exportId)!.state).toBe("failed");
  refuses(() => f.exports.complete(second.exportId, PROOF), "invalid_request");
  f.set("UPDATE cowork_volumes SET owner_json=NULL WHERE workspace_id=?", f.workspaceId);
  const third = f.exports.prepare(f.workspaceId, PROOF);
  expect(third.generation).toBe(3);
  // an image update while capturing also invalidates the generation
  f.set("UPDATE cowork_workspace_images SET base_image_digest=? WHERE workspace_id=?", C, f.workspaceId);
  refuses(() => f.exports.complete(third.exportId, PROOF), "generation_stale");
  refuses(() => f.exports.complete("export_missing", PROOF), "not_found");
  refuses(() => f.exports.complete(first.exportId, {}), "authority_denied");
});

test("fail abandons an in-flight generation so another can be prepared; failing twice is harmless", () => {
  const f = fixture(); pinned(f);
  const first = f.exports.prepare(f.workspaceId, PROOF);
  refuses(() => f.exports.fail(first.exportId, {}), "authority_denied");
  expect(f.exports.fail(first.exportId, PROOF).state).toBe("failed");
  expect(f.exports.fail(first.exportId, PROOF).state).toBe("failed");
  refuses(() => f.exports.fail("export_missing", PROOF), "not_found");
  expect(f.exports.prepare(f.workspaceId, PROOF).generation).toBe(2);
});

// host-protocol.md: "Imports are recovery inputs requiring validation and current user authorization, never a
// route to reconstruct permissions from JSON." / "a mismatch is recovery-required."
function exported(f: F) {
  pinned(f);
  const prepared = f.exports.prepare(f.workspaceId, PROOF); f.exports.complete(prepared.exportId, PROOF);
  return { ...prepared, json: prepared.manifestJson, edited: (edit: (m: any) => void) => { const m = JSON.parse(prepared.manifestJson); edit(m); return JSON.stringify(m); } };
}

test("a recorded, completed generation of a workspace this home owns validates, changes nothing and grants nothing", () => {
  const f = fixture(), e = exported(f), before = dump(f);
  expect(f.exports.validateImport(e.json, PROOF)).toEqual({ exportId: e.exportId, generation: 1, latest: true });
  expect(f.exports.validateImport(Buffer.from(e.json), PROOF).generation).toBe(1);
  expect(dump(f)).toEqual(before);
  expect(f.calls.at(-1)).toEqual({ action: "export.validateImport", workspaceId: f.workspaceId, homeId: f.homeId });
  const next = f.exports.prepare(f.workspaceId, PROOF); f.exports.complete(next.exportId, PROOF);
  expect(f.exports.validateImport(e.json, PROOF).latest).toBe(false); // an older generation is valid, and reported as not the latest
});

test("a descriptor that is malformed, oversized, authority-bearing or of an unknown format refuses before any state is consulted", () => {
  const f = fixture(), e = exported(f);
  refuses(() => f.exports.validateImport("not json", PROOF), "manifest_invalid");
  refuses(() => f.exports.validateImport("[]", PROOF), "manifest_invalid");
  refuses(() => f.exports.validateImport(" ".repeat(EXPORT_MANIFEST_MAX_BYTES + 1), PROOF), "manifest_invalid");
  refuses(() => f.exports.validateImport("{}", PROOF), "manifest_invalid");
  for (const edit of [
    (m: any) => { m.grants = [{ source: "x" }]; }, (m: any) => { m.policy = { defaultPolicy: "bypass" }; }, (m: any) => { m.workspace.trusted = true; },
    (m: any) => { m.volumes[0].device = "1"; }, (m: any) => { m.volumes[0].owner = {}; }, (m: any) => { delete m.images; },
    (m: any) => { m.plaintextImages = false; }, (m: any) => { m.volumes.pop(); }, (m: any) => { m.volumes[0].relativePath = "../escape.ext4"; },
    (m: any) => { m.volumes[0].relativePath = "env.ext4"; }, (m: any) => { m.volumes[1].purpose = "data"; }, (m: any) => { m.images.baseImageDigest = "xyz"; },
    (m: any) => { m.volumes[0].capacityBytes = 1; }, (m: any) => { m.volumes[0].filesystemUuid = "not-a-uuid"; },
  ]) refuses(() => f.exports.validateImport(e.edited(edit), PROOF), "manifest_invalid");
  refuses(() => f.exports.validateImport(e.edited(m => { m.formatVersion = 2; }), PROOF), "unknown_format");
  refuses(() => f.exports.validateImport(e.edited(m => { m.volumes[1].format = "luks2-aes-xts-v1"; }), PROOF), "unknown_format");
  refuses(() => f.exports.validateImport(e.edited(m => { m.volumes[1].formatVersion = 2; }), PROOF), "unknown_format");
});

test("authority is judged before anything about the workspace is revealed", () => {
  const f = fixture(), e = exported(f);
  refuses(() => f.exports.validateImport(e.json, {}), "authority_denied");
  refuses(() => f.exports.validateImport(e.edited(m => { m.workspace.workspaceId = "ws_unknown"; }), {}), "authority_denied");
  refuses(() => f.exports.validateImport(e.edited(m => { m.homeId = "home_other"; }), {}), "authority_denied");
});

test("a descriptor from another home, for an unknown or deleted workspace, or for an unrecorded or unfinished generation refuses", () => {
  const f = fixture(), e = exported(f);
  refuses(() => f.exports.validateImport(e.edited(m => { m.homeId = "home_other"; }), PROOF), "foreign_home");
  refuses(() => f.exports.validateImport(e.edited(m => { m.workspace.workspaceId = "ws_unknown"; }), PROOF), "workspace_unknown");
  refuses(() => f.exports.validateImport(e.edited(m => { m.generation.exportId = "export_unrecorded"; }), PROOF), "generation_unknown");
  refuses(() => f.exports.validateImport(e.edited(m => { m.generation.number = 7; }), PROOF), "generation_unknown");
  refuses(() => f.exports.validateImport(e.edited(m => { m.generation.preparedAt = "2000-01-01T00:00:00.000Z"; }), PROOF), "generation_unknown"); // not the recorded bytes
  const inFlight = f.exports.prepare(f.workspaceId, PROOF);
  refuses(() => f.exports.validateImport(inFlight.manifestJson, PROOF), "generation_unknown");
  f.exports.fail(inFlight.exportId, PROOF);
  refuses(() => f.exports.validateImport(inFlight.manifestJson, PROOF), "generation_unknown");
  f.set("UPDATE cowork_workspaces SET state='deleted' WHERE workspace_id=?", f.workspaceId);
  refuses(() => f.exports.validateImport(e.json, PROOF), "authority_denied");
});

test("a second owner never attaches: an owned volume refuses before identity is even compared", () => {
  const f = fixture(), e = exported(f);
  f.set("UPDATE cowork_volumes SET owner_json='{}' WHERE workspace_id=? AND purpose='data'", f.workspaceId);
  refuses(() => f.exports.validateImport(e.json, PROOF), "volume_busy");
  f.set("UPDATE cowork_volumes SET owner_json=NULL, creation_id='creation_other' WHERE workspace_id=? AND purpose='data'", f.workspaceId);
  refuses(() => f.exports.validateImport(e.json, PROOF), "recovery_required");
});

test("any difference between the descriptor and canonical records is recovery-required: volume identity, geometry, filesystem, image digests, power", () => {
  for (const drift of [
    (f: F) => f.set("UPDATE cowork_volumes SET volume_id='volume_other' WHERE workspace_id=? AND purpose='environment'", f.workspaceId),
    (f: F) => f.set("UPDATE cowork_volumes SET creation_id='creation_other' WHERE workspace_id=? AND purpose='data'", f.workspaceId),
    (f: F) => f.set("UPDATE cowork_volumes SET capacity_bytes=capacity_bytes+4096 WHERE workspace_id=? AND purpose='data'", f.workspaceId),
    (f: F) => f.set("UPDATE cowork_volumes SET filesystem_uuid='00000000-0000-4000-8000-000000000000' WHERE workspace_id=? AND purpose='data'", f.workspaceId),
    (f: F) => f.set("UPDATE cowork_workspace_images SET runtime_image_digest=? WHERE workspace_id=?", C, f.workspaceId),
    (f: F) => f.set("UPDATE cowork_workspaces SET power='running' WHERE workspace_id=?", f.workspaceId),
    (f: F) => f.set("UPDATE cowork_volumes SET filesystem_state='recovery-required' WHERE workspace_id=?", f.workspaceId),
    (f: F) => f.set("DELETE FROM cowork_volumes WHERE workspace_id=? AND purpose='environment'", f.workspaceId),
    (f: F) => f.set("DELETE FROM cowork_workspace_images WHERE workspace_id=?", f.workspaceId),
  ]) {
    const f = fixture(), e = exported(f);
    drift(f);
    refuses(() => f.exports.validateImport(e.json, PROOF), "recovery_required");
  }
});

test("a manifest alone never creates records: with the workspace's rows gone nothing is rebuilt from the descriptor", () => {
  const f = fixture(), e = exported(f);
  const other = fixture();
  // The same bytes presented to a different home are foreign; and even with the home id forged the workspace is unknown.
  refuses(() => other.exports.validateImport(e.json, PROOF), "foreign_home");
  refuses(() => other.exports.validateImport(e.edited(m => { m.homeId = other.homeId; }), PROOF), "workspace_unknown");
  expect(other.db.db.query("SELECT count(*) AS n FROM cowork_exports").get()).toEqual({ n: 0 });
  expect(other.db.db.query("SELECT count(*) AS n FROM cowork_workspace_images").get()).toEqual({ n: 0 });
});

test("the manifest schema is closed and exported for consumers", () => {
  const f = fixture(), e = exported(f);
  expect(CoworkExportManifest.safeParse(JSON.parse(e.json)).success).toBe(true);
  expect(CoworkExportManifest.safeParse({ ...JSON.parse(e.json), extra: 1 }).success).toBe(false);
});
