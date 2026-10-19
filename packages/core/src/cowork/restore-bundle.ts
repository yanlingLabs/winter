/*
 * RESTORE of a `.winterworkspace` bundle into the workspace it was exported from.
 *
 * What this is. An in-place REPLACEMENT of a stopped workspace's two VM images by an earlier, verified generation, after an
 * explicit confirmation. It is not an import into a different Winter home and not the `workspace.restore` un-archive
 * operation the docs also list. `exports.validateImport` only passes for the same home, an existing workspace and identical
 * volume ids and filesystem UUIDs, so a bundle cannot reconstruct a workspace or move one: "Distinguish relocation/ownership
 * transfer from making a second clone: copied IDs must not permit two owners to attach the same workspace"
 * (cowork-host-protocol.md). Cross-home transfer needs its own authorized operation and is out of this slice.
 *
 * Document sentences followed:
 *  - cowork-host-protocol.md: "Imports are recovery inputs requiring validation and current user authorization, never a route
 *    to reconstruct permissions from JSON."
 *  - cowork-storage-security.md: "device and inode changes after an approved move or restore must not change the DEK" and the
 *    open item "re-recording device/inode after a restore, an approved empty replacement through the existing ApprovalBroker card".
 *  - cowork-execution-contracts.md: "Missing expected memory/output/instruction storage yields unavailable/recovery state,
 *    never a new empty replacement or writes into a bare guest mountpoint."
 *
 * CONFLICT RULES (each has a test that fails without it):
 *  1. The bundle is verified completely before anything is touched (structure, integrity index, every sha256).
 *  2. `validateImport` must pass: same home, recorded and completed generation, the workspace stopped and unowned, canonical
 *     state equal to the manifest. It is judged again after the confirmation, because the confirmation awaits a human.
 *  3. An older generation than the latest completed one needs `allowOlderGeneration`.
 *  4. Replacing the images ALWAYS needs the confirmation port to answer yes; there is no default and no "empty replacement"
 *     without it. A missing live image is reported to the confirmation as such.
 *  5. Nothing is ever deleted. The replaced images move to `restore-aside-<exportId>/` beside the workspace's images; the
 *     bundle's shared files are placed in `restored-shared-<exportId>/` and NEVER merged into the live shared folders (their
 *     file identities are recorded by the instruction and output layers, which this lane does not own).
 *  6. The replacement is an atomic exchange (`renamex_np` RENAME_SWAP), not a copy over the live file. The restored image
 *     carries the sticky backup exclusion, verified, BEFORE the exchange.
 *  7. The file identity is re-recorded through the identity port after the exchange. A failure or crash between the two leaves
 *     the recorded identity different from the file, which `CoworkVolumes` already refuses as `recovery_required`: it fails closed.
 *
 * PORTS (production supplies none): `approval` (the ApprovalBroker card) and `identity` (a method on `CoworkVolumes`; the exact
 * diff is in the lane report). The backup port is the existing `CoworkVolumeBackup`.
 */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeStateDb } from "../runtime-state/db";
import {
  BUNDLE_IMAGE_FILES, DEFAULT_BUNDLE_LIMITS, copyFileHashed, ensureDirectories, lstatOrNull, openRegularFile, syncDirectory, verifyBundle, writeNewFile, type BundleLimits,
} from "./export-bundle";
import { ExportIoError, copyImageFile, hashDescriptor, renameDirect } from "./export-io";
import { CoworkExportManifest, type CoworkExports } from "./exports";
import { CoworkLifecycleError, lifecycleFail, lifecycleId } from "./storage-lifecycle";
import type { CoworkVolumeBackup } from "./volume-backup";
import type { VolumeFileIdentity, VolumePurpose } from "./volumes";

export interface CoworkRestoreConfirmation {
  readonly workspaceId: string; readonly exportId: string; readonly generation: number; readonly latest: boolean;
  /** What the exchange will replace, so the card can say it: a live image's presence and whether it is the recorded file. */
  readonly images: ReadonlyArray<{ readonly file: "data.ext4" | "env.ext4"; readonly liveExists: boolean; readonly liveMatchesRecord: boolean; readonly bytes: number }>;
  readonly sharedFiles: number;
  /** The old images are KEPT in this folder name inside the workspace directory; nothing is deleted. */
  readonly asideName: string;
}
/** The existing ApprovalBroker card, behind a port. Production supplies none; absent or false means the restore does not run. */
export interface CoworkRestoreApproval { confirm(request: CoworkRestoreConfirmation, signal?: AbortSignal): Promise<boolean> }
/** Re-records an image's device/inode/uid/mode after the exchange. Compare-and-swap on `expected`. */
export interface CoworkRestoreIdentityPort {
  rerecord(change: { readonly workspaceId: string; readonly volumeId: string; readonly purpose: VolumePurpose; readonly expected: VolumeFileIdentity | null; readonly next: VolumeFileIdentity; readonly proof: unknown }): void;
}
export interface CoworkRestorePorts {
  readonly exports: CoworkExports;
  readonly rs: RuntimeStateDb;
  readonly home: string;
  readonly backup: CoworkVolumeBackup;
  readonly identity: CoworkRestoreIdentityPort;
  readonly approval: CoworkRestoreApproval;
  readonly allowClone?: boolean;
  readonly limits?: Partial<BundleLimits>;
  readonly now?: () => string;
  /** Isolated fault testing only, never serialized or supplied by an RPC. */
  readonly checkpoint?: (phase: string) => void | Promise<void>;
}
export interface RestoreInput { readonly bundlePath: string; readonly proof: unknown; readonly allowOlderGeneration?: boolean; readonly signal?: AbortSignal }
export interface RestoreResult {
  readonly workspaceId: string; readonly exportId: string; readonly generation: number;
  readonly restored: readonly ("data.ext4" | "env.ext4")[]; readonly asideName: string; readonly sharedName: string | null;
}
const PURPOSE = { "data.ext4": "data", "env.ext4": "environment" } as const;
type Row = Record<string, any>;

export class CoworkWorkspaceRestorer {
  private readonly limits: BundleLimits;
  private readonly busy = new Set<string>();
  constructor(private readonly ports: CoworkRestorePorts) { this.limits = { ...DEFAULT_BUNDLE_LIMITS, ...ports.limits }; }

  async restore(input: RestoreInput): Promise<RestoreResult> {
    const signal = input.signal, { exports, rs } = this.ports;
    // 1. Judge the bundle completely, touching nothing.
    const bundle = await verifyBundle(input.bundlePath, this.limits, signal);
    // 2. The recorded generation (authority first, then home, workspace, generation, ownership and canonical equality). It also
    //    judges the manifest's shape and format, so an unsupported format is `unknown_format`, not a parse failure of ours.
    const validated = exports.validateImport(bundle.manifestText, input.proof);
    const manifest = CoworkExportManifest.parse(JSON.parse(bundle.manifestText));
    const workspaceId = lifecycleId(manifest.workspace.workspaceId), exportId = manifest.generation.exportId;
    if (bundle.integrity.exportId !== exportId) return lifecycleFail("bundle_invalid");
    for (const volume of manifest.volumes) if (bundle.files.get(volume.relativePath)?.bytes !== volume.capacityBytes) return lifecycleFail("bundle_invalid");
    if (this.busy.has(workspaceId)) return lifecycleFail("restore_conflict");
    this.busy.add(workspaceId);
    let staging: string | undefined, swapped = 0;
    try {
      // 3. The generation rule.
      if (!validated.latest && input.allowOlderGeneration !== true) return lifecycleFail("restore_conflict");
      const dir = this.workspaceDirectory(workspaceId), asideName = `restore-aside-${exportId}`, sharedName = `restored-shared-${exportId}`;
      if (lstatOrNull(join(dir, asideName)) || lstatOrNull(join(dir, sharedName)) || lstatOrNull(join(dir, `.restore-${exportId}`))) return lifecycleFail("restore_conflict");
      const live = this.inspectLive(workspaceId, dir);
      const sharedPaths = [...bundle.files.keys()].filter(path => path.startsWith("shared/"));
      // 4. The confirmation. It awaits a human, so everything above is judged again afterwards.
      const confirmed = await this.ports.approval.confirm({ workspaceId, exportId, generation: validated.generation, latest: validated.latest, asideName,
        images: live.map(image => ({ file: image.file, liveExists: image.exists, liveMatchesRecord: image.matchesRecord, bytes: bundle.files.get(image.file)!.bytes })), sharedFiles: sharedPaths.length }, signal);
      if (confirmed !== true) return lifecycleFail("restore_unconfirmed");
      exports.validateImport(bundle.manifestText, input.proof);
      const again = this.inspectLive(workspaceId, dir);
      if (JSON.stringify(again) !== JSON.stringify(live)) return lifecycleFail("restore_conflict");

      // 5. Stage: every byte is hashed as it is copied, and must equal the verified index (the bundle is re-read, not trusted).
      staging = join(dir, `.restore-${exportId}`);
      mkdirSync(staging, { mode: 0o700 });
      for (const image of live) {
        const entry = bundle.files.get(image.file)!, source = openRegularFile(join(bundle.root, image.file));
        try {
          if (fstatSync(source).uid !== process.geteuid?.()) return lifecycleFail("bundle_unsafe");
          await copyImageFile(source, join(staging, image.file), { allowClone: this.ports.allowClone, signal });
        } finally { closeSync(source); }
        const staged = openRegularFile(join(staging, image.file));
        try {
          if (fstatSync(staged).uid !== process.geteuid?.()) return lifecycleFail("bundle_unsafe");
          fchmodSync(staged, 0o600);
          if (Number(fstatSync(staged).size) !== entry.bytes || await hashDescriptor(staged, entry.bytes, signal) !== entry.sha256) return lifecycleFail("bundle_invalid");
          // 6a. Exclusion applied and verified on the staged vnode BEFORE it can become the live image.
          this.ports.backup.excludeItem(join(staging, image.file), staged);
          if (this.ports.backup.verifyItemExcluded(join(staging, image.file), staged) !== true || this.ports.backup.verifyDescriptorExcluded(staged) !== true) return lifecycleFail("backup_exclusion_unavailable");
        } finally { closeSync(staged); }
      }
      const made = new Set<string>();
      for (const path of sharedPaths) {
        const entry = bundle.files.get(path)!;
        ensureDirectories(staging, path, made);
        const copied = await copyFileHashed(join(bundle.root, path), join(staging, path), { signal });
        if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256) return lifecycleFail("bundle_invalid");
      }
      await this.ports.checkpoint?.("staged");

      // 6b and 7. The exchange, then the identity record. Past the first exchange nothing is cleaned up: the old images are
      // in the staging folder and a failure leaves the recorded identity different from the file (recovery_required).
      const rows = rs.db.query<Row, [string]>("SELECT volume_id,purpose,device,inode,uid,mode FROM cowork_volumes WHERE workspace_id=?").all(workspaceId);
      for (const image of live) {
        const staged = join(staging, image.file), target = join(dir, image.file);
        renameDirect(staged, target, image.exists ? "swap" : "exclusive");
        swapped++;
        await this.ports.checkpoint?.(`swapped:${image.file}`);
      }
      for (const image of live) {
        const row = rows.find(candidate => candidate.purpose === PURPOSE[image.file])!;
        const fd = openSync(join(dir, image.file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let next: VolumeFileIdentity;
        try {
          const st = fstatSync(fd, { bigint: true });
          if (!st.isFile() || st.nlink !== 1n || Number(st.mode & 0o7777n) !== 0o600 || Number(st.uid) !== process.geteuid?.()) return lifecycleFail("recovery_required");
          next = { device: String(st.dev), inode: String(st.ino), uid: Number(st.uid), mode: Number(st.mode & 0o7777n) };
        } finally { closeSync(fd); }
        this.ports.identity.rerecord({ workspaceId, volumeId: row.volume_id, purpose: PURPOSE[image.file], proof: input.proof, next,
          expected: row.device === null ? null : { device: row.device, inode: row.inode, uid: row.uid, mode: row.mode } });
      }
      await this.ports.checkpoint?.("identity-recorded");

      // 8. Keep everything that was replaced, and the bundle's shared files, under their final names. Nothing is deleted.
      let sharedKept: string | null = null;
      if (sharedPaths.length > 0) { renameDirect(join(staging, "shared"), join(dir, sharedName), "exclusive"); sharedKept = sharedName; }
      writeNewFile(join(staging, "RESTORE.json"), Buffer.from(JSON.stringify({ exportId, generation: validated.generation, restoredAt: (this.ports.now ?? (() => new Date().toISOString()))(),
        replaced: live.map(image => ({ file: image.file, hadLiveImage: image.exists })) }), "utf8"));
      renameDirect(staging, join(dir, asideName), "exclusive");
      staging = undefined; syncDirectory(dir);
      return { workspaceId, exportId, generation: validated.generation, restored: live.map(image => image.file), asideName, sharedName: sharedKept };
    } catch (error) {
      if (staging && swapped === 0) { try { rmSync(staging, { recursive: true, force: true }); } catch { /* an inert dot-folder; the next restore of this generation refuses until it is removed by hand */ } }
      if (swapped > 0 && !(error instanceof CoworkLifecycleError && error.code === "recovery_required")) throw new CoworkLifecycleError("recovery_required");
      if (error instanceof CoworkLifecycleError) throw error;
      if (error instanceof ExportIoError && error.reason === "cancelled") throw error;
      return lifecycleFail("export_not_ready");
    } finally { this.busy.delete(workspaceId); }
  }

  /** The workspace folder, resolved without a symlink in any component, owned by this user, mode 0700. */
  private workspaceDirectory(workspaceId: string): string {
    const expected = join(realpathSync(this.ports.home), "cowork", "workspaces", workspaceId);
    let real: string;
    try { real = realpathSync(expected); } catch { return lifecycleFail("recovery_required"); }
    const st = lstatSync(real);
    if (real !== expected || !st.isDirectory() || st.uid !== process.geteuid?.() || (st.mode & 0o777) !== 0o700) return lifecycleFail("recovery_required");
    return real;
  }
  private inspectLive(workspaceId: string, dir: string) {
    const rows = this.ports.rs.db.query<Row, [string]>("SELECT purpose,device,inode FROM cowork_volumes WHERE workspace_id=?").all(workspaceId);
    return BUNDLE_IMAGE_FILES.map(file => {
      let st: import("node:fs").BigIntStats | null = null;
      try { st = lstatSync(join(dir, file), { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (st && (!st.isFile() || st.nlink !== 1n)) return lifecycleFail("restore_conflict"); // a symlink or special file where an image belongs
      const row = rows.find(candidate => candidate.purpose === PURPOSE[file]);
      const matchesRecord = !!st && !!row && row.device !== null && String(st.dev) === row.device && String(st.ino) === row.inode;
      return { file, exists: !!st, matchesRecord };
    });
  }
}
