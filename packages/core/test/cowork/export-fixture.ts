// Shared fixture for the export writer and restore tests: a REAL runtime-state db, a real `CoworkVolumes` over two sparse
// images in a temp home, a pinned workspace at rest, a populated shared tree, and the test-side ports (the read-only image
// door, the identity re-recorder) that production does not supply. Nothing here touches a real home or the real Keychain.
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkVolumes, RAW_VOLUME_MIN_BYTES, type CoworkVolumeAuthority, type CoworkVolumeRequest, type VolumePurpose } from "../../src/cowork/volumes";
import type { CoworkVolumeFilesystemAuthority, VolumeFilesystemPlan, VolumeFilesystemReceipt } from "../../src/cowork/volume-filesystem";
import type { CoworkVolumeBackup } from "../../src/cowork/volume-backup";
import { CoworkImagePins } from "../../src/cowork/images";
import { CoworkExports } from "../../src/cowork/exports";
import { SqliteExportContentBinding } from "../../src/cowork/export-binding";
import { CoworkWorkspaceExporter, type CoworkExportContentBinding, type CoworkExportImageDoor, type CoworkExportWriterPorts } from "../../src/cowork/export-writer";
import { createCoworkWorkspaceRestorer, type CoworkRestoreApproval, type CoworkRestoreConfirmation, type CoworkRestoreIdentityPort, type CoworkRestorePorts } from "../../src/cowork/restore-bundle";
import { CoworkLifecycleError, type CoworkLifecycleAuthority, type LifecycleFailure } from "../../src/cowork/storage-lifecycle";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";

export const PROOF = {};
export const A = "a".repeat(64), B = "b".repeat(64);
const cleanup: Array<() => void> = [];
export function runCleanup(): void { cleanup.splice(0).reverse().forEach(fn => { try { fn(); } catch { /* best effort */ } }); }
export const onCleanup = (fn: () => void): void => { cleanup.push(fn); };

export const SECRET = "SECRET-DECOY-must-never-be-exported";
export const BACKUP_XATTR = "com.apple.metadata:com_apple_backup_excludeItem";

export function setXattr(path: string, name: string, value: string): void {
  const result = spawnSync("/usr/bin/xattr", ["-w", name, value, path]);
  if (result.status !== 0) throw new Error("xattr failed");
}
export function listXattrs(path: string): string[] {
  const result = spawnSync("/usr/bin/xattr", [path], { encoding: "utf8" });
  return result.stdout.split("\n").map(line => line.trim()).filter(Boolean);
}
/** Write `text` into an image at an offset, without changing its length. */
export function poke(path: string, offset: number, text: string): void {
  const fd = openSync(path, constants.O_RDWR); try { writeSync(fd, Buffer.from(text), 0, text.length, offset); } finally { closeSync(fd); }
}

const receiptFor = (plan: VolumeFilesystemPlan): VolumeFilesystemReceipt => ({ ...plan, volumes: plan.volumes.map(v => ({ ...v, journalReplayed: false, journalReplay: "none", filesystemFeatures: [...plan.ext4Features], transientFilesystemFeatures: [], fullReadOnlyCheck: plan.checkMode === "full-read-only", filesystemType: "ext4", filesystemUUID: v.expectedFilesystemUUID, flushConfirmed: true, checked: true })) });

export async function fixture(options: { ready?: boolean; pin?: boolean; backupFails?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "winter-content-out-")));
  const home = join(base, "home"); mkdirSync(home, { mode: 0o700 });
  const destination = join(base, "exports"); mkdirSync(destination, { mode: 0o700 });
  const db: RuntimeStateDb = openRuntimeStateDb(home), repo = new CoworkRepository(db);
  cleanup.push(() => { db.close(); rmSync(base, { recursive: true, force: true }); });
  const homeId = repo.homeIdentity();
  const made = repo.create({ principalId: "fixture-user", requestId: "create" }, {
    ownership: "project", title: "Content-out fixture", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }],
    ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" },
  });
  const workspaceId = made.workspaceId;
  const excluded = new Set<string>(), key = (fd: number) => { const st = fstatSync(fd); return `${st.dev}:${st.ino}`; };
  let backupFails = options.backupFails === true;
  const backup: CoworkVolumeBackup = {
    excludeItem: (_p, fd) => { excluded.add(key(fd)); },
    verifyItemExcluded: (_p, fd) => !backupFails && excluded.has(key(fd)),
    verifyDescriptorExcluded: fd => !backupFails && excluded.has(key(fd)),
  };
  const volumeAuthority: CoworkVolumeAuthority = { authorize: (_a, input) => input.proof === PROOF, verifyStopped: () => true };
  const request: CoworkVolumeRequest = { workspaceId, proof: PROOF, owner: { controllerInstanceId: "c1", workerInstanceId: "w1", incarnationId: "i1", leaseEpoch: 1, runtimeImageDigest: A } };
  const sealed = {}, native: CoworkVolumeFilesystemAuthority = { authorize: r => r.proof === PROOF, authorizeJournalReplay: r => r.proof === PROOF, verifyPreviousReplayStopped: () => true, verifyReceipt: (_r, _plan, _receipt, proof) => proof === sealed };
  const volumes = new CoworkVolumes(db, home, volumeAuthority, backup, undefined, native);
  volumes.plan(request, { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES }); volumes.materialize(request);
  if (options.ready !== false) {
    // The real path to a ready, unowned pair: claim, format and confirm through the volume layer, then a confirmed stop.
    volumes.claim(request);
    const plan = volumes.prepareFilesystems(request);
    volumes.confirmFilesystems(request, receiptFor(plan), sealed);
    volumes.release(request, { confirmationId: "stop-fixture", proof: PROOF });
  }
  db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [workspaceId]);
  const dir = join(home, "cowork", "workspaces", workspaceId);
  const image = (purpose: VolumePurpose) => join(dir, purpose === "data" ? "data.ext4" : "env.ext4");
  // Distinct, recognisable bytes in each image, a hole in the middle, and the sticky exclusion + a second xattr on the source.
  poke(image("data"), 8192, "DATA-IMAGE-BYTES"); poke(image("data"), RAW_VOLUME_MIN_BYTES - 64, "DATA-TAIL");
  poke(image("environment"), 4096, "ENV-IMAGE-BYTES");
  for (const purpose of ["data", "environment"] as const) { setXattr(image(purpose), BACKUP_XATTR, "bplist-fixture"); setXattr(image(purpose), "com.example.fixture", "x"); }

  const shared = join(dir, "shared");
  const put = (relative: string, body: string | Buffer) => { const path = join(shared, relative); mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, body, { mode: 0o600 }); return path; };
  put("instructions/WINTER.md", "# guidance\n"); put("memory/notes.md", "- remembered\n"); put("memory/deep/er/fact.txt", "deep\n");
  put("outputs/session-one/report.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3])); put("outputs/session-one/empty.txt", "");
  // Decoys that must never reach a bundle: not in the whitelist, whatever their names.
  put("secret.txt", SECRET); put("notes/outside-roots.txt", SECRET);
  writeFileSync(join(dir, "bookmark.bin"), SECRET); writeFileSync(join(dir, "credentials.json"), JSON.stringify({ token: SECRET }));
  writeFileSync(join(home, "runtimes", "decoy-secret.txt"), SECRET);

  const authority: CoworkLifecycleAuthority = { authorize: (_action, _ws, _home, proof) => proof === PROOF };
  const pins = new CoworkImagePins(db, authority, { compatible: () => true });
  if (options.pin !== false) pins.pin(workspaceId, { baseImageDigest: A, runtimeImageDigest: B }, PROOF);
  let tick = 0, n = 0;
  const exportsRecords = new CoworkExports(db, authority, () => `2026-10-18T00:00:${String(tick++ % 60).padStart(2, "0")}.000Z`, () => `export_fixture_${++n}`);

  const opened: string[] = [];
  const door: CoworkExportImageDoor = {
    // What the production door will do on a pinned descriptor: identity, 0600, one link, the recorded size, the sticky exclusion.
    openStopped(id, purpose, proof) {
      if (proof !== PROOF) throw new Error("denied");
      const row = db.db.query<Record<string, any>, [string, string]>("SELECT * FROM cowork_volumes WHERE workspace_id=? AND purpose=?").get(id, purpose)!;
      if (row.owner_json !== null) throw new Error("owned");
      const fd = openSync(image(purpose), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd, { bigint: true });
      if (String(st.dev) !== row.device || String(st.ino) !== row.inode || st.nlink !== 1n || Number(st.mode & 0o7777n) !== 0o600 || Number(st.size) !== row.capacity_bytes || !backup.verifyDescriptorExcluded(fd)) { closeSync(fd); throw new Error("not the recorded image"); }
      opened.push(purpose);
      return { fd, capacityBytes: row.capacity_bytes, close: () => closeSync(fd) };
    },
  };
  let identityCalls = 0, identityFails = false;
  const identity: CoworkRestoreIdentityPort = {
    // The diff the volume owner will write as `CoworkVolumes.reidentifyRestored`: compare-and-swap on the old identity.
    rerecord(change) {
      identityCalls++;
      if (identityFails) throw new Error("identity store down");
      const result = db.db.run("UPDATE cowork_volumes SET device=?,inode=?,uid=?,mode=?,updated_at=? WHERE volume_id=? AND device IS ? AND inode IS ?",
        [change.next.device, change.next.inode, change.next.uid, change.next.mode, new Date().toISOString(), change.volumeId, change.expected?.device ?? null, change.expected?.inode ?? null]);
      if (result.changes !== 1) throw new Error("identity compare-and-swap lost");
      // The ready history in the filesystem journal is bound to the file's identity (volumes.ts `record`), so a stand-in must
      // rebind it or `CoworkVolumes` refuses every call with recovery_required. WHICH the real method does (rebind, or force a
      // fresh read-only probe of the restored image) is the volume owner's call; the lane report recommends the probe.
      const row = db.db.query<Record<string, any>, [string]>("SELECT filesystem_journal_json AS j FROM cowork_volumes WHERE volume_id=?").get(change.volumeId)!;
      const journal = JSON.parse(row.j);
      const rebind = (document: any) => { for (const volume of document?.volumes ?? []) if (volume.volumeId === change.volumeId) volume.identity = { ...change.next }; };
      rebind(journal.plan); rebind(journal.receipt); rebind(journal.previousReady?.plan); rebind(journal.previousReady?.receipt);
      db.db.run("UPDATE cowork_volumes SET filesystem_journal_json=? WHERE volume_id=?", [JSON.stringify(journal), change.volumeId]);
    },
  };
  const proofs = { PROOF };
  const checkpoints: Array<(phase: string) => void | Promise<void>> = [];
  const checkpoint = async (phase: string) => { for (const fn of checkpoints) await fn(phase); };
  const syncCheckpoint = (phase: string) => { for (const fn of checkpoints) fn(phase); };
  // The real binding over migration 20's tables. `bound` lets a test read or tamper with what the database holds.
  const binding: CoworkExportContentBinding = new SqliteExportContentBinding(db);
  const bound = {
    get: (id: string) => binding.read(id),
    set: (id: string, value: { contentDigest: string; outputIds: Record<string, string> }) => {
      db.db.run("DELETE FROM cowork_export_output_ids WHERE export_id=?", [id]); db.db.run("UPDATE cowork_exports SET content_digest=? WHERE export_id=?", [value.contentDigest, id]);
      for (const [opaque, session] of Object.entries(value.outputIds)) db.db.run("INSERT INTO cowork_export_output_ids VALUES(?,?,?)", [id, opaque, session]);
    },
    clear: () => { db.db.run("DELETE FROM cowork_export_output_ids"); db.db.run("UPDATE cowork_exports SET content_digest=NULL"); },
  };
  const writerPorts: CoworkExportWriterPorts = { exports: exportsRecords, rs: db, home, images: door, binding, checkpoint };
  const confirmations: CoworkRestoreConfirmation[] = [];
  let answer: boolean | (() => boolean | Promise<boolean>) = true;
  const approval: CoworkRestoreApproval = { confirm: async request => { confirmations.push(request); return typeof answer === "function" ? answer() : answer; } };
  const restorePorts: CoworkRestorePorts = { exports: exportsRecords, rs: db, home, backup, identity, approval, binding, checkpoint, syncCheckpoint };
  return {
    base, home, homeId, db, repo, workspaceId, dir, destination, image, shared, volumes, request, backup, excluded, authority, pins, exportsRecords, door, opened,
    writerPorts, restorePorts, identity, binding, bound, confirmations, proofs, checkpoints,
    exporter: (extra: Partial<CoworkExportWriterPorts> = {}) => new CoworkWorkspaceExporter({ ...writerPorts, ...extra }),
    restorer: (extra: Partial<CoworkRestorePorts> = {}) => createCoworkWorkspaceRestorer({ ...restorePorts, ...extra }),
    setAnswer: (value: typeof answer) => { answer = value; },
    failIdentity: (value: boolean) => { identityFails = value; },
    identityCalls: () => identityCalls,
    breakBackup: (value: boolean) => { backupFails = value; },
    put, read: (path: string) => readFileSync(path),
    exportOnce: (name?: string) => new CoworkWorkspaceExporter({ ...writerPorts }).export({ workspaceId, destinationParent: destination, name, proof: PROOF }),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function failsWith(promise: Promise<unknown> | (() => unknown), code: LifecycleFailure): Promise<void> {
  let error: unknown;
  try { await (typeof promise === "function" ? promise() : promise); } catch (caught) { error = caught; }
  if (!(error instanceof CoworkLifecycleError) || error.code !== code) throw new Error(`expected ${code}, got ${error instanceof CoworkLifecycleError ? error.code : String(error)}`);
}
