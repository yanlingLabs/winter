import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CoworkImagePins } from "../../src/cowork/images";
import { COWORK_CONFINED_POSTURE_CAPABILITY, coworkAllocateAuthority, coworkGuestRuntimeOffer, createCoworkProvisioningPort, type CoworkVerifiedGuestImage } from "../../src/cowork/host-env/provisioning";
import { CoworkRepository } from "../../src/cowork/repository";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { RAW_VOLUME_MIN_BYTES } from "../../src/cowork/volumes";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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
});
