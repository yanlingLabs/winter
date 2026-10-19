// The stand-in TEST image must never be launchable where the production image is pinned. runtimeImageDigest = SHA-256(SHA-256(kernel) || SHA-256(initramfs.cpio)),
// so two images that share the production kernel and differ in the cpio have different digests; this file holds the daemon's pin mechanisms to that.
// Records only: nothing here builds, boots or starts a guest. The worker side (exit 71 on a recomputed mismatch) is pinned by the golden vectors in
// native/vectors/runtime-image.json and by scripts/cowork-guest-artifact/test_runtime_image_digest.py, which also keeps the stand-in digests out of every production pin file.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkVolumes, RAW_VOLUME_MIN_BYTES, type CoworkVolumeAuthority, type CoworkVolumeRequest } from "../../src/cowork/volumes";
import type { CoworkVolumeBackup } from "../../src/cowork/volume-backup";
import { CoworkImagePins, type CoworkImageDigests } from "../../src/cowork/images";
import { CoworkLifecycleError, type CoworkLifecycleAuthority, type LifecycleFailure } from "../../src/cowork/storage-lifecycle";
import { bindCoworkImagePins, readOnlyImagePins } from "../../src/cowork/native-wiring";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => { try { fn(); } catch { /* best effort */ } }); });

const sha256 = (bytes: Buffer): Buffer => createHash("sha256").update(bytes).digest();
/** The rule, written independently of the Python publisher and the C worker. */
const runtimeImageDigest = (kernelRaw: Buffer, cpioRaw: Buffer): string => createHash("sha256").update(Buffer.concat([kernelRaw, cpioRaw])).digest("hex");

// One shared kernel; two different cpios: the production image and the stand-in test image.
const KERNEL = sha256(Buffer.from("production kernel"));
const PRODUCTION = runtimeImageDigest(KERNEL, sha256(Buffer.from("production initramfs")));
const STANDIN = runtimeImageDigest(KERNEL, sha256(Buffer.from("stand-in initramfs")));
const BASE = "a".repeat(64);
const PROOF = {};
const digests = (runtime: string): CoworkImageDigests => ({ baseImageDigest: BASE, runtimeImageDigest: runtime });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "winter-image-separation-"));
  const db: RuntimeStateDb = openRuntimeStateDb(home), repo = new CoworkRepository(db);
  cleanup.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const made = repo.create({ principalId: "fixture-user", requestId: "create" }, {
    ownership: "project", title: "Separation fixture", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }],
    ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" },
  });
  const workspaceId = made.workspaceId;
  const excluded = new Set<string>(), key = (fd: number) => { const st = fstatSync(fd); return `${st.dev}:${st.ino}`; };
  const backup: CoworkVolumeBackup = { excludeItem: (_p, fd) => { excluded.add(key(fd)); }, verifyItemExcluded: (_p, fd) => excluded.has(key(fd)), verifyDescriptorExcluded: fd => excluded.has(key(fd)) };
  const volumeAuthority: CoworkVolumeAuthority = { authorize: (_a, input) => input.proof === PROOF, verifyStopped: () => true };
  const request: CoworkVolumeRequest = { workspaceId, proof: PROOF, owner: { controllerInstanceId: "c1", workerInstanceId: "w1", incarnationId: "i1", leaseEpoch: 1, runtimeImageDigest: PRODUCTION } };
  const volumes = new CoworkVolumes(db, home, volumeAuthority, backup);
  volumes.plan(request, { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES }); volumes.materialize(request);
  db.db.run("UPDATE cowork_volumes SET filesystem_state='ready',filesystem_journal_json='{}',format_eligible=0 WHERE workspace_id=?", [workspaceId]);
  db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [workspaceId]);
  const authority: CoworkLifecycleAuthority = { authorize: (_a, _w, _h, proof) => proof === PROOF };
  const owner = new CoworkImagePins(db, authority, { compatible: () => true });
  const production = readOnlyImagePins(db); // exactly the view native-wiring gives production when no pins are injected: it can read and compare, never pin or update
  return { db, workspaceId, owner, production };
}
const refuses = (fn: () => unknown, code: LifecycleFailure) => {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(CoworkLifecycleError); expect((error as CoworkLifecycleError).code).toBe(code); return; }
  throw new Error(`expected ${code}`);
};

test("the two images share a kernel and still have different digests, in both argument orders", () => {
  expect(STANDIN).not.toBe(PRODUCTION);
  expect(runtimeImageDigest(sha256(Buffer.from("production initramfs")), KERNEL)).not.toBe(PRODUCTION);
  expect(PRODUCTION).toMatch(/^[0-9a-f]{64}$/);
});

test("a workspace pinned to the production image is launched with that digest and the stand-in digest is refused by the pin check", () => {
  const f = fixture();
  f.owner.pin(f.workspaceId, digests(PRODUCTION), PROOF);
  const bound = bindCoworkImagePins(f.production);
  expect(bound.runtimeImageDigest(f.workspaceId)).toBe(PRODUCTION);
  expect(bound.runtimeImageDigest(f.workspaceId)).not.toBe(STANDIN);
  refuses(() => f.production.assertPinned(f.workspaceId, digests(STANDIN)), "image_digest_mismatch");
  f.production.assertPinned(f.workspaceId, digests(PRODUCTION));
});

test("the production pin view cannot be made to pin or update to the stand-in digest", () => {
  const f = fixture();
  f.owner.pin(f.workspaceId, digests(PRODUCTION), PROOF);
  expect(() => f.production.pin(f.workspaceId, digests(STANDIN), PROOF)).toThrow();
  expect(() => f.production.beginUpdate(f.workspaceId, digests(STANDIN), PROOF)).toThrow();
  expect(f.production.get(f.workspaceId)?.runtimeImageDigest).toBe(PRODUCTION);
  expect(bindCoworkImagePins(f.production).runtimeImageDigest(f.workspaceId)).toBe(PRODUCTION);
});

test("even the owner path cannot quietly re-pin a production workspace to the stand-in digest", () => {
  const f = fixture();
  f.owner.pin(f.workspaceId, digests(PRODUCTION), PROOF);
  refuses(() => f.owner.pin(f.workspaceId, digests(STANDIN), PROOF), "image_digest_mismatch");
});

test("a pending update to the stand-in digest is not the live pin: the launch digest stays the production one", () => {
  const f = fixture();
  f.owner.pin(f.workspaceId, digests(PRODUCTION), PROOF);
  f.owner.beginUpdate(f.workspaceId, digests(STANDIN), PROOF);
  expect(bindCoworkImagePins(f.owner).runtimeImageDigest(f.workspaceId)).toBe(PRODUCTION);
  refuses(() => f.owner.assertPinned(f.workspaceId, digests(STANDIN)), "image_digest_mismatch");
});

test("no pin at all refuses the launch digest (image_unpinned), never a default", () => {
  const f = fixture();
  refuses(() => bindCoworkImagePins(f.production).runtimeImageDigest(f.workspaceId), "image_unpinned");
});

test("the launch digest is returned only after the pin check accepts it: a pin source that refuses stops the launch", () => {
  const pin = { workspaceId: "w", baseImageDigest: BASE, runtimeImageDigest: PRODUCTION, revision: 1, pendingUpdate: null, pinnedAt: "t", updatedAt: "t" };
  const refusing = bindCoworkImagePins({ get: () => pin, assertPinned: () => { throw new CoworkLifecycleError("image_digest_mismatch"); } });
  expect(() => refusing.runtimeImageDigest("w")).toThrow();
  const accepting = bindCoworkImagePins({ get: () => pin, assertPinned: () => undefined });
  expect(accepting.runtimeImageDigest("w")).toBe(PRODUCTION);
});
