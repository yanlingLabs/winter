import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, constants, fstatSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkVolumes, CoworkVolumeError, RAW_VOLUME_MIN_BYTES, RAW_VOLUME_MAX_BYTES, type CoworkVolumeAuthority, type CoworkVolumeRequest, type VolumeFailure } from "../../src/cowork/volumes";
import { BACKUP_EXCLUSION_MAX_BYTES, hasStickyBackupExclusion, isStickyBackupExclusion } from "../../src/cowork/volume-fs";
import { timeMachineVolumeBackup, type CoworkVolumeBackup } from "../../src/cowork/volume-backup";
import { CoworkRepository } from "../../src/cowork/repository";
import { downgradeCoworkRuntimeStateToV7, downgradeRuntimeStateToV6, openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";

const homes: string[] = [], databases: RuntimeStateDb[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
const capacities = { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES };
const proof = {}, stopProof = {};
const authority: CoworkVolumeAuthority = { authorize: (_action, input) => input.proof === proof, verifyStopped: (_input, stop) => stop.proof === stopProof };
function fixture(backup?: CoworkVolumeBackup, checkpoint?: (phase: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "winter-raw-volumes-")); homes.push(home);
  const db = openRuntimeStateDb(home); databases.push(db);
  const repository = new CoworkRepository(db); repository.homeIdentity();
  const made = repository.create({ principalId: "fixture-user", requestId: "create" }, { ownership: "project", title: "Fixture", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }], ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" } });
  const excluded = new Set<string>();
  const descriptorExcluded = (fd: number) => { const st = fstatSync(fd); return excluded.has(`${st.dev}:${st.ino}`); };
  const fakeBackup: CoworkVolumeBackup = {
    excludeItem: (_path, fd) => { expect(db.db.inTransaction).toBe(false); const st = fstatSync(fd); excluded.add(`${st.dev}:${st.ino}`); },
    verifyItemExcluded: (_path, fd) => { expect(db.db.inTransaction).toBe(false); return descriptorExcluded(fd); },
    verifyDescriptorExcluded: descriptorExcluded,
  };
  const request: CoworkVolumeRequest = { workspaceId: made.workspaceId, proof, owner: { controllerInstanceId: "controller-one", workerInstanceId: "worker-one", incarnationId: "incarnation-one", leaseEpoch: 1, runtimeImageDigest: "a".repeat(64) } };
  const store = new CoworkVolumes(db, home, authority, backup ?? fakeBackup, checkpoint);
  return { home, db, request, store, backup: backup ?? fakeBackup, excluded, image: (name = "data.ext4") => join(home, "cowork", "workspaces", request.workspaceId, name) };
}
function allocate(f: ReturnType<typeof fixture>) { f.store.plan(f.request, capacities); return f.store.materialize(f.request); }
function refusal(fn: () => unknown, code: VolumeFailure) { try { fn(); throw new Error("expected refusal"); } catch (error) { expect(error).toBeInstanceOf(CoworkVolumeError); expect((error as CoworkVolumeError).code).toBe(code); } }

test("plan has no filesystem effect; materialization produces bounded sparse private unformatted images", () => {
  const f = fixture(), planned = f.store.plan(f.request, capacities);
  expect(planned.map(v => v.state)).toEqual(["planned", "planned"]);
  expect(() => statSync(f.image())).toThrow();
  const volumes = f.store.materialize(f.request);
  expect(volumes.map(v => [v.format, v.formatVersion, v.filesystemState, v.state, v.sectorBytes, v.filesystemBlockBytes])).toEqual(Array(2).fill(["raw-ext4-v1", 1, "unformatted", "allocated", 512, 4096]));
  for (const name of ["data.ext4", "env.ext4"]) {
    const st = statSync(f.image(name)); expect(st.size).toBe(RAW_VOLUME_MIN_BYTES); expect(st.mode & 0o7777).toBe(0o600); expect(st.blocks * 512).toBeLessThan(st.size);
  }
  for (const dir of [join(f.home, "cowork"), join(f.home, "cowork", "workspaces"), join(f.home, "cowork", "workspaces", f.request.workspaceId)]) expect(statSync(dir).mode & 0o7777).toBe(0o700);
  expect(f.excluded.size).toBe(2); expect(f.db.integrity().ok).toBe(true);
});
test("geometry, purpose, format and mandatory controller authority refuse without file effects", () => {
  const f = fixture();
  for (const data of [0, RAW_VOLUME_MIN_BYTES - 4096, RAW_VOLUME_MIN_BYTES + 1, RAW_VOLUME_MAX_BYTES + 4096, Number.NaN]) refusal(() => f.store.plan(f.request, { ...capacities, data }), "invalid_request");
  refusal(() => f.store.plan({ ...f.request, proof: {} }, capacities), "authority_denied");
  allocate(f); f.store.claim(f.request);
  refusal(() => f.store.open(f.request, "bad" as any), "not_found");
  f.db.db.run("PRAGMA ignore_check_constraints=ON"); f.db.db.run("UPDATE cowork_volumes SET format='future-encrypted-v2'");
  refusal(() => f.store.claim(f.request), "unknown_format");
});
test("a cold reopen retains exact volume IDs and writable owner until native stop proof", () => {
  const f = fixture(), original = allocate(f); f.store.claim(f.request);
  const handle = f.store.open(f.request, "data"); writeSync(handle.fd, Buffer.from("durable-user-data"), 0, 17, 4096);
  refusal(() => f.store.release(f.request, { confirmationId: "stop-one", proof: stopProof }), "stop_unconfirmed");
  handle.close(); handle.close();
  const db = openRuntimeStateDb(f.home); databases.push(db); const reopened = new CoworkVolumes(db, f.home, authority, f.backup);
  expect(reopened.records(f.request.workspaceId).map(v => v.volumeId)).toEqual(original.map(v => v.volumeId));
  const next = { ...f.request, owner: { ...f.request.owner, workerInstanceId: "worker-two", incarnationId: "incarnation-two", leaseEpoch: 2 } };
  refusal(() => reopened.claim(next), "volume_busy");
  refusal(() => reopened.release(f.request, { confirmationId: "forged", proof: {} }), "stop_unconfirmed");
  reopened.release(f.request, { confirmationId: "native-stop", proof: stopProof }); reopened.claim(next);
  const newHandle = reopened.open(next, "data"); expect(readFileSync(f.image()).subarray(4096, 4113).toString()).toBe("durable-user-data"); newHandle.close();
});
test("permission, replacement, geometry, directory identity and hardlink drift refuse without repair", () => {
  const f = fixture(); allocate(f); f.store.claim(f.request);
  chmodSync(f.image(), 0o644); refusal(() => f.store.open(f.request, "data"), "recovery_required"); expect(statSync(f.image()).mode & 0o777).toBe(0o644); chmodSync(f.image(), 0o600);
  linkSync(f.image(), join(f.home, "copy-link")); refusal(() => f.store.open(f.request, "data"), "recovery_required"); rmSync(join(f.home, "copy-link"));
  renameSync(f.image(), f.image("original.ext4")); writeFileSync(f.image(), "replacement", { mode: 0o600 }); refusal(() => f.store.open(f.request, "data"), "recovery_required"); expect(readFileSync(f.image()).toString()).toBe("replacement");
  rmSync(f.image()); renameSync(f.image("original.ext4"), f.image());
  const workspace = join(f.home, "cowork", "workspaces", f.request.workspaceId); renameSync(workspace, `${workspace}-saved`); mkdirSync(workspace, { mode: 0o700 });
  refusal(() => f.store.open(f.request, "data"), "recovery_required");
});
test("geometry drift and malformed ownership refuse while data remains intact", () => {
  const f = fixture(); allocate(f); f.store.claim(f.request);
  const fd = openSync(f.image(), constants.O_RDWR | constants.O_NOFOLLOW); ftruncateSync(fd, RAW_VOLUME_MIN_BYTES - 4096); closeSync(fd);
  refusal(() => f.store.open(f.request, "data"), "recovery_required"); expect(statSync(f.image()).size).toBe(RAW_VOLUME_MIN_BYTES - 4096);
  f.db.db.run("UPDATE cowork_volumes SET owner_json='invalid-json'"); refusal(() => f.store.records(f.request.workspaceId), "recovery_required");
});
test("symlinks never follow through image or backing directory", () => {
  const f = fixture(); allocate(f); f.store.claim(f.request);
  const outside = join(f.home, "outside.txt"); writeFileSync(outside, "untouched", { mode: 0o600 });
  renameSync(f.image(), f.image("original.ext4")); symlinkSync(outside, f.image()); refusal(() => f.store.open(f.request, "data"), "recovery_required"); expect(readFileSync(outside).toString()).toBe("untouched");
  rmSync(f.image()); renameSync(f.image("original.ext4"), f.image());
  const workspaces = join(f.home, "cowork", "workspaces"); renameSync(workspaces, `${workspaces}-saved`); symlinkSync(`${workspaces}-saved`, workspaces);
  refusal(() => f.store.open(f.request, "data"), "recovery_required");
});
test("unknown existing images are preserved when exclusive creation refuses", () => {
  const f = fixture(); f.store.plan(f.request, capacities);
  mkdirSync(join(f.home, "cowork", "workspaces", f.request.workspaceId), { recursive: true, mode: 0o700 }); writeFileSync(f.image(), "existing-user-data", { mode: 0o600 });
  refusal(() => f.store.materialize(f.request), "recovery_required"); expect(readFileSync(f.image()).toString()).toBe("existing-user-data");
});
test("lost exclusion blocks future open; partial allocation retries its pinned virgin inode", () => {
  let fails = true;
  const backup: CoworkVolumeBackup = { excludeItem: () => {}, verifyItemExcluded: () => !fails, verifyDescriptorExcluded: () => !fails };
  const f = fixture(backup); f.store.plan(f.request, capacities);
  refusal(() => f.store.materialize(f.request), "backup_exclusion_unavailable");
  const first = f.store.records(f.request.workspaceId).find(v => v.purpose === "data")!;
  expect(first.state).toBe("creating"); expect(statSync(f.image()).size).toBe(0);
  fails = false; f.store.materialize(f.request); const allocated = f.store.records(f.request.workspaceId).find(v => v.purpose === "data")!;
  expect(allocated.identity).toEqual(first.identity); f.store.claim(f.request); fails = true;
  refusal(() => f.store.open(f.request, "data"), "backup_exclusion_unavailable"); expect(allocated.identity).toEqual(first.identity);
});
for (const phase of ["creation-intent", "image-created", "backup-excluded", "image-sized"] as const) test(`crash at ${phase} never loses or replaces an existing file`, () => {
  let armed = true;
  const f = fixture(undefined, reached => { if (armed && reached === phase) { armed = false; throw new Error("fixture-crash"); } });
  f.store.plan(f.request, capacities); refusal(() => f.store.materialize(f.request), "recovery_required");
  const before = f.store.records(f.request.workspaceId).find(v => v.purpose === "data")!;
  if (phase === "creation-intent" || phase === "image-created") {
    refusal(() => f.store.materialize(f.request), "recovery_required");
    expect(f.store.records(f.request.workspaceId).find(v => v.purpose === "data")!.identity).toEqual(before.identity);
  } else {
    f.store.materialize(f.request); expect(f.store.records(f.request.workspaceId).find(v => v.purpose === "data")!.identity).toEqual(before.identity);
    expect(statSync(f.image()).size).toBe(RAW_VOLUME_MIN_BYTES);
  }
});
test("backup path replacement during exclusion refuses; recorded old inode remains preserved", () => {
  let f: ReturnType<typeof fixture>;
  const backup: CoworkVolumeBackup = { excludeItem: path => { renameSync(path, `${path}-saved`); writeFileSync(path, "injected replacement", { mode: 0o600 }); }, verifyItemExcluded: () => true, verifyDescriptorExcluded: () => true };
  f = fixture(backup); f.store.plan(f.request, capacities); refusal(() => f.store.materialize(f.request), "recovery_required");
  expect(statSync(`${f.image()}-saved`).size).toBe(0); expect(readFileSync(f.image()).toString()).toBe("injected replacement");
});
test("v9 upgrades an old host-only v7 home; empty downgrade preserves native state and populated volumes refuse", () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "winter-volume-schema-")); homes.push(emptyHome);
  let db = openRuntimeStateDb(emptyHome); db.close();
  expect(downgradeCoworkRuntimeStateToV7(emptyHome)).toEqual({ from: 9, to: 7 });
  db = openRuntimeStateDb(emptyHome); expect(db.schemaVersion()).toBe(9); expect(db.db.query("SELECT count(*) AS n FROM cowork_volumes").get()).toEqual({ n: 0 }); db.close();
  expect(downgradeRuntimeStateToV6(emptyHome)).toEqual({ from: 9, to: 6 });
  const f = fixture(); allocate(f);
  expect(() => downgradeCoworkRuntimeStateToV7(f.home)).toThrow("Cowork authority"); expect(() => downgradeRuntimeStateToV6(f.home)).toThrow("Cowork authority"); expect(f.db.schemaVersion()).toBe(9); expect(statSync(f.image()).size).toBe(RAW_VOLUME_MIN_BYTES);
  const incompatible = new Database(join(emptyHome, "runtimes", "runtime-state.db")); incompatible.run("PRAGMA user_version=10"); incompatible.close();
  expect(() => openRuntimeStateDb(emptyHome)).toThrow("newer-schema");
});
test("real tmutil adapter excludes only disposable images, with sticky metadata preserved on rename", () => {
  const f = fixture(timeMachineVolumeBackup); allocate(f); f.store.claim(f.request);
  const handle = f.store.open(f.request, "data"); handle.close();
  const prior = f.image(), renamed = f.image("renamed.ext4"); renameSync(prior, renamed);
  // Renaming is a drift refusal for storage; tmutil's sticky item exclusion independently persists.
  const result = Bun.spawnSync(["/usr/bin/tmutil", "isexcluded", renamed]); expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain("[Excluded]");
  const shared = join(f.home, "cowork", "workspaces", f.request.workspaceId, "outputs"); mkdirSync(shared, { mode: 0o700 });
  // Test preload puts all disposable homes under TMPDIR, which Time Machine already excludes.
  // Verify this code applied no item marker to shared content rather than claiming global inclusion.
  const sharedFd = openSync(shared, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { expect(hasStickyBackupExclusion(sharedFd)).toBe(false); } finally { closeSync(sharedFd); }
});

test("directory creation crash and nested effect transactions fail closed without automatic adoption", () => {
  let armed = true;
  const f = fixture(undefined, phase => { if (phase === "directory-created" && armed) { armed = false; throw new Error("fixture-crash"); } });
  f.store.plan(f.request, capacities); refusal(() => f.store.materialize(f.request), "recovery_required");
  refusal(() => f.store.materialize(f.request), "recovery_required"); expect(statSync(join(f.home, "cowork")).isDirectory()).toBe(true);
  refusal(() => f.db.transaction(() => f.store.materialize(f.request)), "invalid_request");
});


test("v8 authority upgrades without reidentifying a workspace, and a genuinely empty v8 rollback remains supported", () => {
  const f = fixture(), homeId = new CoworkRepository(f.db).homeIdentity();
  f.db.db.run("DROP TABLE cowork_volumes"); f.db.db.run("DROP TABLE cowork_volume_directories"); f.db.db.run("PRAGMA user_version=8");
  const upgraded = openRuntimeStateDb(f.home); databases.push(upgraded);
  expect(upgraded.schemaVersion()).toBe(9); expect(new CoworkRepository(upgraded).homeIdentity()).toBe(homeId);
  expect(new CoworkRepository(upgraded).get(f.request.workspaceId).workspaceId).toBe(f.request.workspaceId);
  const emptyHome = mkdtempSync(join(tmpdir(), "winter-v8-volume-rollback-")); homes.push(emptyHome);
  const empty = openRuntimeStateDb(emptyHome); empty.db.run("DROP TABLE cowork_volumes"); empty.db.run("DROP TABLE cowork_volume_directories"); empty.db.run("PRAGMA user_version=8"); empty.close();
  expect(downgradeCoworkRuntimeStateToV7(emptyHome)).toEqual({ from: 8, to: 7 });
});


test("outer claim/open rollback cannot publish an uncommitted owner or writable descriptor", () => {
  const f = fixture(); allocate(f);
  let admissionCalls = 0, escaped: ReturnType<CoworkVolumes["open"]> | undefined;
  const lifecycle = new CoworkVolumes(f.db, f.home, {
    authorize: (...args) => { admissionCalls++; return authority.authorize(...args); },
    verifyStopped: (...args) => authority.verifyStopped(...args),
  }, f.backup);
  expect(() => f.db.transaction(() => {
    refusal(() => lifecycle.claim(f.request), "invalid_request");
    // Verify open itself refuses before effects even if the caller handles claim's refusal.
    refusal(() => { escaped = lifecycle.open(f.request, "data"); }, "invalid_request");
    expect(lifecycle.records(f.request.workspaceId).every(v => v.owner === null)).toBe(true);
    throw new Error("fixture-outer-rollback");
  })).toThrow("fixture-outer-rollback");
  expect(admissionCalls).toBe(0); expect(escaped).toBeUndefined();
  expect(lifecycle.records(f.request.workspaceId).every(v => v.owner === null)).toBe(true);
  lifecycle.claim(f.request);
  const first = lifecycle.open(f.request, "data");
  const next = { ...f.request, owner: { ...f.request.owner, workerInstanceId: "worker-two", incarnationId: "incarnation-two", leaseEpoch: 2 } };
  try {
    refusal(() => lifecycle.claim(next), "volume_busy");
    writeSync(first.fd, Buffer.from("committed-one"), 0, 13, 4096);
    expect(readFileSync(f.image()).subarray(4096, 4109).toString()).toBe("committed-one");
  } finally { first.close(); }
  lifecycle.release(f.request, { confirmationId: "native-stop-one", proof: stopProof });
  lifecycle.claim(next); const second = lifecycle.open(next, "data"); second.close();
});

test("outer release/claim/open rollback cannot restore one owner beside another writable descriptor", () => {
  const f = fixture(); allocate(f); f.store.claim(f.request);
  let admissionCalls = 0, stopCalls = 0, escaped: ReturnType<CoworkVolumes["open"]> | undefined;
  const lifecycle = new CoworkVolumes(f.db, f.home, {
    authorize: (...args) => { admissionCalls++; return authority.authorize(...args); },
    verifyStopped: (...args) => { stopCalls++; return authority.verifyStopped(...args); },
  }, f.backup);
  const next = { ...f.request, owner: { ...f.request.owner, workerInstanceId: "worker-two", incarnationId: "incarnation-two", leaseEpoch: 2 } };
  expect(() => f.db.transaction(() => {
    refusal(() => lifecycle.release(f.request, { confirmationId: "native-stop-one", proof: stopProof }), "invalid_request");
    refusal(() => lifecycle.claim(next), "invalid_request");
    refusal(() => { escaped = lifecycle.open(next, "data"); }, "invalid_request");
    // A previously committed matching owner must not obtain a descriptor inside an outer transaction either.
    refusal(() => { escaped = lifecycle.open(f.request, "data"); }, "invalid_request");
    throw new Error("fixture-outer-rollback");
  })).toThrow("fixture-outer-rollback");
  expect(admissionCalls).toBe(0); expect(stopCalls).toBe(0); expect(escaped).toBeUndefined();
  expect(lifecycle.records(f.request.workspaceId).map(v => v.owner)).toEqual([f.request.owner, f.request.owner]);
  const first = lifecycle.open(f.request, "data");
  try {
    writeSync(first.fd, Buffer.from("retained-one"), 0, 12, 4096);
    refusal(() => lifecycle.claim(next), "volume_busy");
  } finally { first.close(); }
  lifecycle.release(f.request, { confirmationId: "native-stop-one", proof: stopProof });
  lifecycle.claim(next); const second = lifecycle.open(next, "data");
  try {
    writeSync(second.fd, Buffer.from("committed-two"), 0, 13, 8192);
    expect(readFileSync(f.image()).subarray(4096, 4108).toString()).toBe("retained-one");
    expect(readFileSync(f.image()).subarray(8192, 8205).toString()).toBe("committed-two");
  } finally { second.close(); }
});

test("failed transaction completion closes an opened descriptor without retaining a local handle", () => {
  const f = fixture(); allocate(f); f.store.claim(f.request);
  let armed = true, observedFd: number | undefined;
  const failingDb: RuntimeStateDb = {
    ...f.db,
    transaction: (fn, options) => f.db.transaction(() => {
      const result = fn();
      if (armed) throw new Error("fixture-transaction-completion-failed");
      return result;
    }, options),
  };
  const lifecycle = new CoworkVolumes(failingDb, f.home, authority, {
    excludeItem: (...args) => f.backup.excludeItem(...args),
    verifyItemExcluded: (path, fd) => { observedFd = fd; return f.backup.verifyItemExcluded(path, fd); },
    verifyDescriptorExcluded: fd => f.backup.verifyDescriptorExcluded(fd),
  });
  let descriptorClosed = false;
  try {
    expect(() => lifecycle.open(f.request, "data")).toThrow("fixture-transaction-completion-failed");
    expect(observedFd).toBeDefined();
    try { fstatSync(observedFd!); } catch (error) { descriptorClosed = (error as NodeJS.ErrnoException).code === "EBADF"; }
    expect(lifecycle.records(f.request.workspaceId).map(v => v.owner)).toEqual([f.request.owner, f.request.owner]);
    armed = false;
    let releaseError: unknown;
    try { lifecycle.release(f.request, { confirmationId: "native-stop-after-failure", proof: stopProof }); }
    catch (error) { releaseError = error; }
    expect({ descriptorClosed, releaseError }).toEqual({ descriptorClosed: true, releaseError: undefined });
  } finally {
    // Keep the intentionally failing pre-fix run from leaking its real disposable descriptor.
    if (!descriptorClosed && observedFd !== undefined) closeSync(observedFd);
  }
  const next = { ...f.request, owner: { ...f.request.owner, workerInstanceId: "worker-two", incarnationId: "incarnation-two", leaseEpoch: 2 } };
  lifecycle.claim(next); const handle = lifecycle.open(next, "data");
  try { writeSync(handle.fd, Buffer.from("next-after-failure"), 0, 18, 4096); }
  finally { handle.close(); handle.close(); }
  expect(readFileSync(f.image()).subarray(4096, 4114).toString()).toBe("next-after-failure");
});

test("named backup helpers stay outside writer transactions while pinned checks run inside", () => {
  const f = fixture();
  let itemChecks = 0, lockedDescriptorChecks = 0;
  const lifecycle = new CoworkVolumes(f.db, f.home, authority, {
    excludeItem: (path, fd) => { expect(f.db.db.inTransaction).toBe(false); f.backup.excludeItem(path, fd); },
    verifyItemExcluded: (path, fd) => { expect(f.db.db.inTransaction).toBe(false); itemChecks++; return f.backup.verifyItemExcluded(path, fd); },
    verifyDescriptorExcluded: fd => { if (f.db.db.inTransaction) lockedDescriptorChecks++; return f.backup.verifyDescriptorExcluded(fd); },
  });
  lifecycle.allocate(f.request, capacities); lifecycle.plan(f.request, capacities);
  lifecycle.claim(f.request); const handle = lifecycle.open(f.request, "data"); handle.close();
  lifecycle.release(f.request, { confirmationId: "native-stop-outside-backup", proof: stopProof });
  expect(itemChecks).toBeGreaterThan(0); expect(lockedDescriptorChecks).toBeGreaterThan(0);
  refusal(() => f.db.transaction(() => lifecycle.plan(f.request, capacities)), "invalid_request");
});

for (const drift of ["exclusion", "replacement", "owner"] as const) test(`open revalidates ${drift} after external backup check and closes its pending descriptor`, () => {
  const f = fixture(); allocate(f); f.store.claim(f.request);
  let observedFd: number | undefined;
  const racedDb: RuntimeStateDb = {
    ...f.db,
    transaction: (fn, options) => {
      if (drift === "exclusion") f.excluded.clear();
      if (drift === "replacement") { renameSync(f.image(), `${f.image()}-saved`); writeFileSync(f.image(), "preserved-replacement", { mode: 0o600 }); }
      if (drift === "owner") f.db.db.run("UPDATE cowork_volumes SET owner_json=? WHERE workspace_id=?", [JSON.stringify({ ...f.request.owner, workerInstanceId: "worker-two" }), f.request.workspaceId]);
      return f.db.transaction(fn, options);
    },
  };
  const lifecycle = new CoworkVolumes(racedDb, f.home, authority, {
    excludeItem: (...args) => f.backup.excludeItem(...args),
    verifyItemExcluded: (path, fd) => { observedFd = fd; return f.backup.verifyItemExcluded(path, fd); },
    verifyDescriptorExcluded: fd => f.backup.verifyDescriptorExcluded(fd),
  });
  refusal(() => lifecycle.open(f.request, "data"), drift === "exclusion" ? "backup_exclusion_unavailable" : drift === "owner" ? "volume_busy" : "recovery_required");
  expect(observedFd).toBeDefined();
  try { fstatSync(observedFd!); throw new Error("descriptor-leaked"); }
  catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("EBADF"); }
  if (drift === "replacement") expect(readFileSync(f.image()).toString()).toBe("preserved-replacement");
  if (drift !== "owner") expect(lifecycle.records(f.request.workspaceId).map(v => v.owner)).toEqual([f.request.owner, f.request.owner]);
});

function markerPlist(text: string, unicode = false, offsetBytes = 1, lengthBytes = 1): Buffer {
  const encoded = unicode ? Buffer.from(text, "utf16le").swap16() : Buffer.from(text, "ascii");
  const count = Buffer.alloc(lengthBytes); count.writeUIntBE(text.length, 0, lengthBytes);
  const object = Buffer.concat([Buffer.from([unicode ? 0x6f : 0x5f, 0x10 | Math.log2(lengthBytes)]), count, encoded]);
  const offsets = Buffer.alloc(offsetBytes); offsets.writeUIntBE(8, 0, offsetBytes);
  const trailer = Buffer.alloc(32); trailer[6] = offsetBytes; trailer[7] = 1;
  trailer.writeBigUInt64BE(1n, 8); trailer.writeBigUInt64BE(BigInt(8 + object.length), 24);
  return Buffer.concat([Buffer.from("bplist00"), object, offsets, trailer]);
}
test("sticky exclusion parses bounded plist strings across equivalent binary encodings", () => {
  const text = "com.apple.backupd";
  for (const unicode of [false, true]) for (const offsetBytes of [1, 2, 4]) for (const lengthBytes of [1, 2, 4]) expect(isStickyBackupExclusion(markerPlist(text, unicode, offsetBytes, lengthBytes))).toBe(true);
  for (const other of ["", "com.apple.backup", `${text}\0`, `${text}x`, "com.apple.backup\0"]) expect(isStickyBackupExclusion(markerPlist(other))).toBe(false);
  const valid = markerPlist(text), malformed = Buffer.from(valid); malformed.writeBigUInt64BE(999n, malformed.length - 8);
  const notString = Buffer.from(valid); notString[8] = 0x4f;
  for (const value of [Buffer.alloc(0), valid.subarray(0, valid.length - 1), malformed, notString, Buffer.alloc(BACKUP_EXCLUSION_MAX_BYTES + 1), Buffer.from(`<plist><string>${text}</string></plist>`)]) expect(isStickyBackupExclusion(value)).toBe(false);
});
