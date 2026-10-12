import { afterEach, expect, test } from "bun:test";
import { fstatSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkVolumes, RAW_VOLUME_MIN_BYTES, type CoworkVolumeRequest } from "../../src/cowork/volumes";
import type { CoworkVolumeFilesystemAuthority, VolumeFilesystemPlan, VolumeFilesystemReceipt } from "../../src/cowork/volume-filesystem";
import { migrateCoworkVolumeSchema } from "../../src/cowork/schema";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";

const homes: string[] = [], dbs: RuntimeStateDb[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
function fixture(port = true, checkpoint?: (phase: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "winter-filesystem-journal-")); homes.push(home);
  const db = openRuntimeStateDb(home); dbs.push(db); const records = new CoworkRepository(db); records.homeIdentity();
  const { workspaceId } = records.create({ principalId: "fixture", requestId: "create" }, { ownership: "project", title: "fixture", sources: [{ kind: "folder", label: "fixture", access: "read-only", detail: { grantRef: "fixture", rootIdentity: "fixture" } }], ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" } });
  const request: CoworkVolumeRequest = { workspaceId, proof: {}, owner: { controllerInstanceId: "controller", workerInstanceId: "worker", incarnationId: "boot", leaseEpoch: 1, runtimeImageDigest: "b".repeat(64) } };
  const excluded = new Set<string>(), key = (fd: number) => { const st = fstatSync(fd); return `${st.dev}:${st.ino}`; };
  const backup = { excludeItem: (_: string, fd: number) => { excluded.add(key(fd)); }, verifyItemExcluded: (_: string, fd: number) => excluded.has(key(fd)), verifyDescriptorExcluded: (fd: number) => excluded.has(key(fd)) };
  const authority = { authorize: (_: unknown, r: CoworkVolumeRequest) => r.proof === request.proof, verifyStopped: () => true };
  const sealedProof = {}, native: CoworkVolumeFilesystemAuthority = { authorize: r => r.proof === request.proof, verifyReceipt: (_r, _plan, _receipt, proof) => proof === sealedProof };
  const store = new CoworkVolumes(db, home, authority, backup, checkpoint, port ? native : undefined);
  store.allocate(request, { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES }); store.claim(request);
  return { home, db, store, request, native, sealedProof, reopen: (nextDb = db) => new CoworkVolumes(nextDb, home, authority, backup, undefined, native) };
}
const receipt = (plan: VolumeFilesystemPlan): VolumeFilesystemReceipt => ({ ...plan, volumes: plan.volumes.map(v => ({ ...v, filesystemFeatures: [...plan.ext4Features], transientFilesystemFeatures: [], fullReadOnlyCheck: plan.checkMode === "full-read-only", filesystemType: "ext4", filesystemUUID: v.expectedFilesystemUUID, flushConfirmed: true, checked: true })) });

test("formatting is a consumed pair intent; mandatory protected receipt alone confirms both ready", () => {
  const f = fixture(), plan = f.store.prepareFilesystems(f.request);
  expect(plan.volumes.map(v => v.action)).toEqual(["format-new", "format-new"]); expect(new Set(plan.volumes.map(v => v.expectedFilesystemUUID)).size).toBe(2);
  expect(f.store.records(f.request.workspaceId).map(v => [v.filesystemState, v.formatEligible])).toEqual([["formatting", false], ["formatting", false]]);
  expect(f.store.filesystemsReady(f.request)).toBe(false); expect(() => f.store.prepareFilesystems(f.request)).toThrow("recovery_required");
  expect(() => f.store.confirmFilesystems(f.request, receipt(plan), {})).toThrow("authority_denied");
  expect(f.store.confirmFilesystems(f.request, receipt(plan), f.sealedProof).map(v => v.filesystemState)).toEqual(["ready", "ready"]);
  expect(f.store.filesystemsReady(f.request)).toBe(true); expect(() => f.store.confirmFilesystems(f.request, receipt(plan), f.sealedProof)).toThrow("recovery_required");
});
test("absent native filesystem port refuses intent and ready admission without effects", () => {
  const f = fixture(false), before = f.store.records(f.request.workspaceId);
  expect(() => f.store.prepareFilesystems(f.request)).toThrow("authority_denied"); expect(f.store.filesystemsReady(f.request)).toBe(false);
  expect(f.store.records(f.request.workspaceId)).toEqual(before);
});
test("writable descriptor exposure before consumed intent destroys virgin format eligibility", () => {
  const f = fixture(), handle = f.store.open(f.request, "data"); writeSync(handle.fd, Buffer.from("nonsecret preserved data"), 0, 23, 8192); handle.close();
  const before = readFileSync(join(f.home, "cowork", "workspaces", f.request.workspaceId, "data.ext4"));
  expect(() => f.store.prepareFilesystems(f.request)).toThrow("recovery_required");
  expect(readFileSync(join(f.home, "cowork", "workspaces", f.request.workspaceId, "data.ext4"))).toEqual(before);
  expect(f.store.records(f.request.workspaceId).find(v => v.purpose === "data")!.formatEligible).toBe(false);
});
test("crash after format intent commit survives reopen with owner held and never retries", () => {
  const f = fixture(true, phase => { if (phase === "filesystem-intent-committed") throw new Error("crash"); });
  expect(() => f.store.prepareFilesystems(f.request)).toThrow("crash"); const reopened = f.reopen();
  expect(reopened.records(f.request.workspaceId).every(v => v.filesystemState === "formatting" && v.owner?.workerInstanceId === "worker")).toBe(true);
  expect(() => reopened.prepareFilesystems(f.request)).toThrow("recovery_required"); const op = reopened.records(f.request.workspaceId)[0]!.filesystemJournal!.plan.operationId;
  reopened.failFilesystems(f.request, op); expect(reopened.records(f.request.workspaceId).every(v => v.filesystemState === "recovery-required" && v.owner !== null)).toBe(true);
  expect(() => reopened.prepareFilesystems(f.request)).toThrow("recovery_required");
});
test("new owner must probe ready volumes; stale old receipt never acknowledges fresh incarnation", () => {
  const f = fixture(), initial = f.store.prepareFilesystems(f.request); f.store.confirmFilesystems(f.request, receipt(initial), f.sealedProof);
  f.store.release(f.request, { confirmationId: "confirmed-stop", proof: {} }); const next = { ...f.request, owner: { ...f.request.owner, workerInstanceId: "new-worker", incarnationId: "new-boot", leaseEpoch: 2 } }; f.store.claim(next);
  expect(f.store.filesystemsReady(next)).toBe(false); const probe = f.store.prepareFilesystems(next);
  expect(probe.volumes.map(v => v.action)).toEqual(["probe-existing", "probe-existing"]); expect(probe.volumes.map(v => v.expectedFilesystemUUID)).toEqual(initial.volumes.map(v => v.expectedFilesystemUUID));
  expect(() => f.store.confirmFilesystems(next, receipt(initial), f.sealedProof)).toThrow("recovery_required");
  f.store.confirmFilesystems(next, receipt(probe), f.sealedProof); expect(f.store.filesystemsReady(next)).toBe(true);
});
for (const field of ["filesystemUUID", "creationId", "identity", "capacityBytes", "flushConfirmed", "owner", "extra"] as const) test(`mismatched receipt ${field} preserves formatting owner and never acknowledges readiness`, () => {
  const f = fixture(), plan = f.store.prepareFilesystems(f.request), bad = structuredClone(receipt(plan));
  if (field === "owner") bad.owner.leaseEpoch++;
  else if (field === "extra") (bad as any).unexpected = "untrusted extension";
  else if (field === "identity") bad.volumes[0]!.identity.inode = "changed";
  else if (field === "capacityBytes") bad.volumes[0]!.capacityBytes += 4096;
  else if (field === "flushConfirmed") (bad.volumes[0] as any).flushConfirmed = false;
  else (bad.volumes[0] as any)[field] = "mismatch";
  expect(() => f.store.confirmFilesystems(f.request, bad, f.sealedProof)).toThrow("authority_denied"); expect(f.store.filesystemsReady(f.request)).toBe(false);
  expect(f.store.records(f.request.workspaceId).every(v => v.filesystemState === "formatting" && v.owner !== null)).toBe(true);
});
test("outer transactions cannot erase consumed format intent or confirmed readiness", () => {
  const f = fixture(); f.db.transaction(() => { expect(() => f.store.prepareFilesystems(f.request)).toThrow("invalid_request"); });
  const plan = f.store.prepareFilesystems(f.request);
  f.db.transaction(() => { expect(() => f.store.confirmFilesystems(f.request, receipt(plan), f.sealedProof)).toThrow("invalid_request"); expect(() => f.store.failFilesystems(f.request, plan.operationId)).toThrow("invalid_request"); expect(f.store.filesystemsReady(f.request)).toBe(false); });
  expect(f.store.records(f.request.workspaceId).every(v => v.filesystemState === "formatting")).toBe(true);
});
test("schema9 migration preserves identity and owner but never invents virgin or UUID provenance", () => {
  const f = fixture(), before = f.store.records(f.request.workspaceId), raw = f.db.db.query("SELECT * FROM cowork_volumes").all() as Record<string, any>[];
  f.db.db.run("DROP TABLE cowork_volumes"); migrateCoworkVolumeSchema(f.db.db);
  const keys = Object.keys(raw[0]!).filter(k => !["filesystem_uuid", "format_eligible", "filesystem_journal_json"].includes(k));
  for (const row of raw) f.db.db.run(`INSERT INTO cowork_volumes(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`, keys.map(k => row[k]));
  f.db.db.run("PRAGMA user_version=9"); f.db.close(); dbs.splice(dbs.indexOf(f.db), 1);
  const upgraded = openRuntimeStateDb(f.home); dbs.push(upgraded); const reopened = f.reopen(upgraded), after = reopened.records(f.request.workspaceId);
  expect(upgraded.schemaVersion()).toBe(11); expect(after.map(v => [v.volumeId, v.creationId, v.identity, v.owner])).toEqual(before.map(v => [v.volumeId, v.creationId, v.identity, v.owner]));
  expect(after.every(v => v.filesystemState === "recovery-required" && v.filesystemUUID === null && !v.formatEligible)).toBe(true);
  expect(() => reopened.prepareFilesystems(f.request)).toThrow("recovery_required"); expect(upgraded.integrity().ok).toBe(true);
});

test("drift after a ready receipt refuses readiness without replacing or repairing an image", () => {
  const f = fixture(), plan = f.store.prepareFilesystems(f.request); f.store.confirmFilesystems(f.request, receipt(plan), f.sealedProof);
  const name = join(f.home, "cowork", "workspaces", f.request.workspaceId, "data.ext4"); f.db.db.run("UPDATE cowork_volumes SET inode='0' WHERE purpose='data'");
  expect(() => f.store.filesystemsReady(f.request)).toThrow("recovery_required"); expect(readFileSync(name).length).toBe(RAW_VOLUME_MIN_BYTES);
});
test("malformed canonical journal and ready-without-receipt refuse as recovery, not autoformat", () => {
  const f = fixture(), plan = f.store.prepareFilesystems(f.request);
  f.db.db.run("UPDATE cowork_volumes SET filesystem_journal_json=?", [JSON.stringify({ plan: { ...plan, volumes: [null, null] } })]); expect(() => f.store.records(f.request.workspaceId)).toThrow("recovery_required");
  f.db.db.run("UPDATE cowork_volumes SET filesystem_state='ready',filesystem_journal_json=?", [JSON.stringify({ plan })]); expect(() => f.store.prepareFilesystems(f.request)).toThrow("recovery_required");
});
test("current bootstrap authority denial cannot consume a virgin intent", () => {
  const f = fixture(); f.native.authorize = () => false; const before = f.store.records(f.request.workspaceId);
  expect(() => f.store.prepareFilesystems(f.request)).toThrow("authority_denied"); expect(f.store.records(f.request.workspaceId)).toEqual(before);
});

test("failed or interrupted ready probe keeps confirmed history and safely reprobes with a fresh nonce", () => {
  const f = fixture(), formatted = f.store.prepareFilesystems(f.request); f.store.confirmFilesystems(f.request, receipt(formatted), f.sealedProof);
  const firstProbe = f.store.prepareFilesystems(f.request); expect(f.store.filesystemsReady(f.request)).toBe(false);
  const cold = f.reopen(); const secondProbe = cold.prepareFilesystems(f.request);
  expect(secondProbe.operationId).not.toBe(firstProbe.operationId); expect(secondProbe.volumes.map(v => v.action)).toEqual(["probe-existing", "probe-existing"]);
  expect(() => cold.confirmFilesystems(f.request, receipt(firstProbe), f.sealedProof)).toThrow("recovery_required");
  cold.failFilesystems(f.request, secondProbe.operationId);
  const afterFailure = cold.records(f.request.workspaceId);
  expect(afterFailure.every(v => v.filesystemState === "ready" && !v.formatEligible && v.owner !== null && !v.filesystemJournal?.receipt && v.filesystemJournal?.previousReady?.plan.operationId === formatted.operationId)).toBe(true);
  expect(cold.filesystemsReady(f.request)).toBe(false);
  const retry = cold.prepareFilesystems(f.request); expect(retry.volumes.map(v => v.action)).toEqual(["probe-existing", "probe-existing"]);
  cold.confirmFilesystems(f.request, receipt(retry), f.sealedProof); expect(cold.filesystemsReady(f.request)).toBe(true);
});
test("v1 formatted history stays readable but cannot inherit sparse zero provenance or new features", () => {
  const f = fixture(), v2 = f.store.prepareFilesystems(f.request), oldReceipt: any = receipt(v2), oldPlan: any = structuredClone(v2);
  for (const value of [oldPlan, oldReceipt]) { value.protocolVersion = 1; delete value.ext4Features; delete value.requiredMountOptions; delete value.checkMode; delete value.virginZeroProvenance; }
  for (const target of oldReceipt.volumes) { delete target.filesystemFeatures; delete target.transientFilesystemFeatures; delete target.fullReadOnlyCheck; }
  f.db.db.run("UPDATE cowork_volumes SET filesystem_state='ready',filesystem_journal_json=?", [JSON.stringify({ plan: oldPlan, receipt: oldReceipt })]);
  const before = f.store.records(f.request.workspaceId); expect(f.store.filesystemsReady(f.request)).toBe(false);
  expect(() => f.store.prepareFilesystems(f.request)).toThrow("filesystem_compatibility_required"); expect(f.store.records(f.request.workspaceId)).toEqual(before);
  expect(before.every(v => v.owner !== null && !v.formatEligible && v.filesystemState === "ready")).toBe(true);
});
test("required exact feature and mount contract is enforced on protected receipts", () => {
  const f = fixture(), plan = f.store.prepareFilesystems(f.request);
  expect(plan.protocolVersion).toBe(2); expect(plan.requiredMountOptions).toEqual(["noinit_itable"]); expect(plan.virginZeroProvenance).toBe("new-sparse-creation");
  for (const mutation of ["missing-feature", "extra-feature", "mount", "zero", "check"] as const) {
    const bad = structuredClone(receipt(plan));
    if (mutation === "missing-feature") bad.volumes[0]!.filesystemFeatures.pop();
    else if (mutation === "extra-feature") bad.volumes[0]!.filesystemFeatures.push("unknown-feature");
    else if (mutation === "mount") bad.requiredMountOptions = [];
    else if (mutation === "zero") (bad as any).virginZeroProvenance = "imported";
    else bad.volumes[0]!.fullReadOnlyCheck = true;
    expect(() => f.store.confirmFilesystems(f.request, bad, f.sealedProof)).toThrow("authority_denied");
  }
});
test("full read-only checking is explicit host authority and has a matching receipt", () => {
  const f = fixture(); const modes: string[] = []; f.native.authorize = (_r, _home, _volumes, mode) => { modes.push(mode); return true; };
  const plan = f.store.prepareFilesystems(f.request, "full-read-only"); expect(plan.checkMode).toBe("full-read-only");
  const wrong = receipt(plan); wrong.volumes[0]!.fullReadOnlyCheck = false;
  expect(() => f.store.confirmFilesystems(f.request, wrong, f.sealedProof)).toThrow("authority_denied");
  f.store.confirmFilesystems(f.request, receipt(plan), f.sealedProof); expect(f.store.filesystemsReady(f.request)).toBe(true); expect(modes.every(v => v === "full-read-only")).toBe(true);
});

test("retained history cannot lend another disk its zero-provenance or mount contract", () => {
  const f = fixture(), made = f.store.prepareFilesystems(f.request); f.store.confirmFilesystems(f.request, receipt(made), f.sealedProof);
  const probe = f.store.prepareFilesystems(f.request), history = f.store.records(f.request.workspaceId)[0]!.filesystemJournal!.previousReady!;
  history.plan.volumes[0]!.creationId = "different-creation"; history.receipt.volumes[0]!.creationId = "different-creation";
  f.db.db.run("UPDATE cowork_volumes SET filesystem_journal_json=?", [JSON.stringify({ plan: probe, previousReady: history })]);
  expect(() => f.store.prepareFilesystems(f.request)).toThrow("recovery_required");
});

test("transient recovery observations never confirm ready and preserve a fresh explicit check route", () => {
  const f = fixture(), initial = f.store.prepareFilesystems(f.request); f.store.confirmFilesystems(f.request, receipt(initial), f.sealedProof);
  const normal = f.store.prepareFilesystems(f.request), pending = receipt(normal); pending.volumes[0]!.transientFilesystemFeatures = ["needs_recovery"];
  expect(() => f.store.confirmFilesystems(f.request, pending, f.sealedProof)).toThrow("journal_recovery_required");
  expect(f.store.filesystemsReady(f.request)).toBe(false);
  expect(f.store.records(f.request.workspaceId).every(v => v.filesystemState === "probing" && v.owner !== null && !v.formatEligible)).toBe(true);
  f.store.failFilesystems(f.request, normal.operationId);
  const full = f.store.prepareFilesystems(f.request, "full-read-only"), checked = receipt(full); checked.volumes[0]!.transientFilesystemFeatures = ["needs_recovery"];
  expect(full.volumes.every(v => v.action === "probe-existing")).toBe(true);
  expect(() => f.store.confirmFilesystems(f.request, checked, f.sealedProof)).toThrow("journal_recovery_required");
  expect(f.store.filesystemsReady(f.request)).toBe(false); f.store.failFilesystems(f.request, full.operationId);
  // Stand-in for a later approved native replay; only a fresh clean observation can acknowledge.
  const clean = f.store.prepareFilesystems(f.request);
  expect(() => f.store.confirmFilesystems(f.request, receipt(full), f.sealedProof)).toThrow("recovery_required");
  f.store.confirmFilesystems(f.request, receipt(clean), f.sealedProof); expect(f.store.filesystemsReady(f.request)).toBe(true);
});
test("unknown, duplicate or missing transient state cannot masquerade as a current clean receipt", () => {
  const f = fixture(), plan = f.store.prepareFilesystems(f.request);
  for (const flags of [["unknown-transient"], ["needs_recovery", "needs_recovery"]]) {
    const bad = receipt(plan); bad.volumes[0]!.transientFilesystemFeatures = flags;
    expect(() => f.store.confirmFilesystems(f.request, bad, f.sealedProof)).toThrow("authority_denied");
  }
  const missing: any = receipt(plan); delete missing.volumes[0].transientFilesystemFeatures;
  expect(() => f.store.confirmFilesystems(f.request, missing, f.sealedProof)).toThrow("authority_denied");
});
test("earlier v2 receipts keep confirmed format history but require a fresh explicit state observation", () => {
  const f = fixture(), plan = f.store.prepareFilesystems(f.request), old: any = receipt(plan);
  for (const target of old.volumes) delete target.transientFilesystemFeatures;
  f.db.db.run("UPDATE cowork_volumes SET filesystem_state='ready',filesystem_journal_json=?", [JSON.stringify({ plan, receipt: old })]);
  expect(f.store.records(f.request.workspaceId).every(v => v.filesystemState === "ready")).toBe(true);
  expect(f.store.filesystemsReady(f.request)).toBe(false);
  const probe = f.store.prepareFilesystems(f.request); expect(probe.volumes.every(v => v.action === "probe-existing")).toBe(true);
  f.store.confirmFilesystems(f.request, receipt(probe), f.sealedProof); expect(f.store.filesystemsReady(f.request)).toBe(true);
});
