import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CoworkImagePins } from "../../src/cowork/images";
import { COWORK_CONFINED_POSTURE_CAPABILITY, coworkAllocateAuthority, coworkGuestRuntimeOffer, createCoworkProvisioningPort, type CoworkVerifiedGuestImage } from "../../src/cowork/host-env/provisioning";
import { CoworkRepository } from "../../src/cowork/repository";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { RAW_VOLUME_MIN_BYTES } from "../../src/cowork/volumes";
import { lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { CoworkGuestRecords } from "../../src/cowork/host-env/guest-records";
import type { CoworkProvisioningPort } from "../../src/cowork/session-ports";
import { tmpdir } from "node:os";
import type { CoworkVolumeBackup } from "../../src/cowork/volume-backup";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const backup: CoworkVolumeBackup = { excludeItem: () => {}, verifyItemExcluded: () => true, verifyDescriptorExcluded: () => true };
const IMAGE: CoworkVerifiedGuestImage = { baseImageDigest: "b".repeat(64), runtimeImageDigest: "d".repeat(64), runtimeCapability: { protocolVersion: 1, capabilities: [COWORK_CONFINED_POSTURE_CAPABILITY, "host-query-v1"], supportsConfinedGuestExecution: true } };

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-provision-"))); roots.push(root);
  const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
  const db = openRuntimeStateDb(home), records = new CoworkRepository(db);
  const made = records.create({ principalId: "fixture-user", requestId: "create" }, { ownership: "project", title: "Fixture", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "g", rootIdentity: "r" } }], ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" } });
  const pins = new CoworkImagePins(db, { authorize: () => true }, { compatible: () => true });
  return { root, home, db, workspaceId: made.workspaceId, pins };
}

describe("the guest offer", () => {
  test("it is derived from the verified image: protocol 1 and the confined posture offer the guest compartment, anything less offers nothing", () => {
    expect(coworkGuestRuntimeOffer(IMAGE)).toEqual({ profile: "host-query-v1", readiness: ["guest-compartment"], runtimeCapability: { protocolVersion: 1, capabilities: [COWORK_CONFINED_POSTURE_CAPABILITY, "host-query-v1"], supportsConfinedGuestExecution: true } });
    expect(coworkGuestRuntimeOffer(null)).toBeNull();
    const cap = IMAGE.runtimeCapability;
    for (const bad of [{ ...cap, protocolVersion: 2 }, { ...cap, supportsConfinedGuestExecution: false }, { ...cap, capabilities: ["host-query-v1"] }, { ...cap, capabilities: "confined-guest-posture-v1" as never }])
      expect(coworkGuestRuntimeOffer({ ...IMAGE, runtimeCapability: bad })).toBeNull();
  });
});

describe("the provisioning port", () => {
  test("the allocate authority permits allocate and nothing else", () => {
    const request = { workspaceId: "w", owner: { controllerInstanceId: "c", workerInstanceId: "w", incarnationId: "i", leaseEpoch: 1, runtimeImageDigest: "d".repeat(64) }, proof: {} };
    expect(["allocate", "claim", "open", "release"].map(action => coworkAllocateAuthority.authorize(action as never, request, "home"))).toEqual([true, false, false, false]);
    expect(coworkAllocateAuthority.verifyStopped(request as never, {} as never, [])).toBe(false);
  });
  test("it is unavailable until the environment is active AND the image is verified, and admit then refuses unsupported_topology", () => {
    const f = fixture();
    let active = false, image: CoworkVerifiedGuestImage | null = IMAGE;
    const port = createCoworkProvisioningPort({ db: f.db, home: f.home, backup, environmentActive: () => active, image: () => image, pin: (id, digests) => f.pins.pin(id, digests, {}) });
    expect(port.available()).toBe(false);
    expect(() => port.admit({ kind: "local-user", id: "u" } as never)).toThrow(expect.objectContaining({ code: "unsupported_topology" }));
    active = true; image = null;
    expect(port.available()).toBe(false);
    image = IMAGE;
    expect(port.available()).toBe(true);
    expect(() => port.admit({ kind: "local-user", id: "u" } as never)).not.toThrow();
    const throwing = createCoworkProvisioningPort({ db: f.db, home: f.home, backup, environmentActive: () => { throw new Error("x"); }, image: () => IMAGE, pin: () => {} });
    expect(throwing.available()).toBe(false);
  });
  test("provision allocates both images (backup-excluded), pins the digests, and a retry is idempotent", async () => {
    const f = fixture();
    const excluded: string[] = [];
    const port = createCoworkProvisioningPort({ db: f.db, home: f.home, backup: { ...backup, excludeItem: (path: string) => { excluded.push(path); } }, environmentActive: () => true, image: () => IMAGE, pin: (id, digests) => f.pins.pin(id, digests, {}), capacities: { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES } });
    expect(await port.provision(f.workspaceId, "op-1")).toEqual({ status: "applied" });
    const dir = join(f.home, "cowork", "workspaces", f.workspaceId);
    expect(statSync(join(dir, "data.ext4")).size).toBe(RAW_VOLUME_MIN_BYTES);
    expect(existsSync(join(dir, "env.ext4"))).toBe(true);
    expect(excluded.length).toBeGreaterThanOrEqual(2);
    expect(f.pins.get(f.workspaceId)).toMatchObject({ baseImageDigest: IMAGE.baseImageDigest, runtimeImageDigest: IMAGE.runtimeImageDigest });
    expect(await port.provision(f.workspaceId, "op-1")).toEqual({ status: "applied" });
    expect(f.db.db.query("SELECT COUNT(*) AS n FROM cowork_volumes WHERE workspace_id=?").get(f.workspaceId)).toEqual({ n: 2 });
  });
  test("a failure is reported with a code, never thrown; an unavailable port refuses and creates nothing; a different image digest cannot re-pin quietly", async () => {
    const f = fixture();
    const off = createCoworkProvisioningPort({ db: f.db, home: f.home, backup, environmentActive: () => false, image: () => IMAGE, pin: () => {} });
    expect(await off.provision(f.workspaceId, "op")).toEqual({ status: "failed", reason: "unsupported_topology" });
    expect(existsSync(join(f.home, "cowork", "workspaces", f.workspaceId))).toBe(false);
    const bad = createCoworkProvisioningPort({ db: f.db, home: f.home, backup, environmentActive: () => true, image: () => IMAGE, pin: () => { throw new Error("boom"); }, capacities: { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES } });
    expect(await bad.provision(f.workspaceId, "op")).toEqual({ status: "failed", reason: "provision_failed" });
    const wrong = createCoworkProvisioningPort({ db: f.db, home: f.home, backup, environmentActive: () => true, image: () => ({ ...IMAGE, runtimeImageDigest: "e".repeat(64) }), pin: (id, digests) => f.pins.pin(id, digests, {}), capacities: { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES } });
    f.pins.pin(f.workspaceId, { baseImageDigest: IMAGE.baseImageDigest, runtimeImageDigest: IMAGE.runtimeImageDigest }, {});
    expect((await wrong.provision(f.workspaceId, "op-2")).status).toBe("failed");
  });
  test("it is the session door's port, and provision makes the shared directories and keeps the data volume's uuid once", async () => {
    const f = fixture();
    const records = new CoworkGuestRecords(f.db);
    const port: CoworkProvisioningPort = createCoworkProvisioningPort({ db: f.db, home: f.home, backup, environmentActive: () => true, image: () => IMAGE, pin: (id, digests) => f.pins.pin(id, digests, {}), guestRecords: records, capacities: { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES } });
    expect(await port.provision(f.workspaceId, "op-1")).toEqual({ status: "applied" });
    const shared = join(f.home, "cowork", "workspaces", f.workspaceId, "shared");
    for (const name of ["guidance", "memory", "outputs"]) { const info = lstatSync(join(shared, name)); expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true); expect(info.mode & 0o777).toBe(0o700); }
    const data = f.db.db.query<{ filesystem_uuid: string }, [string]>("SELECT filesystem_uuid FROM cowork_volumes WHERE workspace_id=? AND purpose='data'").get(f.workspaceId)!;
    expect(records.storeVolumeUuid(f.workspaceId)).toBe(data.filesystem_uuid);
    expect(await port.provision(f.workspaceId, "op-1")).toEqual({ status: "applied" }); // idempotent
  });
  test("a recorded uuid that is not the data volume's, or a shared directory that is a symlink, fails the provisioning with a code and pins nothing", async () => {
    const f = fixture();
    const records = new CoworkGuestRecords(f.db);
    f.db.db.run("UPDATE cowork_workspaces SET store_volume_uuid=? WHERE workspace_id=?", ["11111111-1111-4111-8111-111111111111", f.workspaceId]);
    const pinned: string[] = [];
    const port = createCoworkProvisioningPort({ db: f.db, home: f.home, backup, environmentActive: () => true, image: () => IMAGE, pin: id => { pinned.push(id); }, guestRecords: records, capacities: { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES } });
    expect(await port.provision(f.workspaceId, "op")).toEqual({ status: "failed", reason: "store_volume_mismatch" });
    expect(pinned).toEqual([]);
    const g = fixture();
    const second = createCoworkProvisioningPort({ db: g.db, home: g.home, backup, environmentActive: () => true, image: () => IMAGE, pin: id => { pinned.push(id); }, capacities: { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES } });
    expect((await second.provision(g.workspaceId, "first")).status).toBe("applied");
    const outputs = join(g.home, "cowork", "workspaces", g.workspaceId, "shared", "outputs");
    rmSync(outputs, { recursive: true }); symlinkSync(g.home, outputs);
    expect(await second.provision(g.workspaceId, "again")).toEqual({ status: "failed", reason: "not_directory" });
  });
});
