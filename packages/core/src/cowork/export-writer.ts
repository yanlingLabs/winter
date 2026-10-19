/*
 * The `.winterworkspace` WRITER: the byte-copying half of an export, on top of the record half in `exports.ts`.
 *
 * Document sentences followed:
 *  - cowork-execution-contracts.md: "Explicit exports require a consistent quiescent generation and disclose that exported
 *    images are plaintext."; "Provide a consistent export of stopped/checkpointed volumes plus manifest, shared-file snapshot
 *    and required image/runtime digests, bound to one recorded export generation".
 *  - cowork-storage-security.md (owner decisions 2026-10-16): an export is a `.winterworkspace` FOLDER bundle, plaintext;
 *    "export is the backup path" (the VM disks stay out of Time Machine, so the export itself must be backup-eligible).
 *  - exports.ts `prepare()`: "the future byte copy must re-verify, per image and on a pinned descriptor, identity
 *    (device/inode/owner), exact 0600 mode and the sticky backup exclusion ... before reading a byte".
 *  - cowork-execution-contracts.md: "Do not mount a live writable ext4 volume a second time on the Mac".
 *
 * Order: prepare (records the generation) -> copy into a sibling `.partial` folder -> two-pass shared snapshot -> write the
 * manifest bytes the record holds -> integrity index -> fsync -> bind the contents in the record -> an EXCLUSIVE atomic rename to
 * the final name -> only THEN `complete()` (refuses when canonical state moved, and the bundle is taken back). A generation is
 * never `complete` for a bundle that does not exist: any earlier failure marks it failed and removes only its own folder.
 *
 * PORT. The images are read through `CoworkExportImageDoor`, a read-only, pinned-descriptor opener for a stopped, unowned
 * workspace. Production supplies none: `CoworkVolumes.open` requires a running owner and opens `O_RDWR`, so the real door is
 * a new method on that class (the exact diff is in the lane report). Nothing here opens an image by path.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RuntimeStateDb } from "../runtime-state/db";
import {
  BUNDLE_SHARED_ROOTS, BUNDLE_SUFFIX, DEFAULT_BUNDLE_LIMITS, OutputIdMapper, comparePaths, copyFdHashed, ensureDirectories, lstatOrNull, openRegularAt, openSubdirectoryAt, serializeIntegrity,
  syncDirectory, walkRegularFilesAt, writeNewFile, type BundleFileEntry, type BundleLimits, type WalkBudget,
} from "./export-bundle";
import { ExportIoError, copyImageFile, hasWritableAcl, hashDescriptor, openDirectoryNoFollow, renameDirect, stampDescriptor, type CopyMethod } from "./export-io";
import type { CoworkExportRecord, CoworkExports, PreparedExport } from "./exports";
import { CoworkLifecycleError, lifecycleFail, lifecycleId, sha256Hex } from "./storage-lifecycle";

export interface CoworkExportOpenImage { readonly fd: number; readonly capacityBytes: number; close(): void }
/** Read-only, pinned, verified opener for one image of a STOPPED, UNOWNED workspace. Production supplies none. */
export interface CoworkExportImageDoor {
  openStopped(workspaceId: string, purpose: "data" | "environment", proof: unknown): CoworkExportOpenImage;
}
/**
 * What the database binds about a generation's bundle contents. Production: two columns on the `cowork_exports` row
 * (`content_digest TEXT`, `output_map_json TEXT`, both NULL until the writer records them), written before `complete()` and
 * read by restore. Nothing supplies it today; without it a restore is unbuildable (see `createCoworkWorkspaceRestorer`).
 */
export interface CoworkExportContentBinding {
  record(exportId: string, binding: { readonly contentDigest: string; readonly outputIds: Readonly<Record<string, string>> }): void;
  read(exportId: string): { readonly contentDigest: string; readonly outputIds: Readonly<Record<string, string>> } | null;
}
export interface CoworkExportWriterPorts {
  readonly exports: CoworkExports;
  readonly rs: RuntimeStateDb;
  readonly home: string;
  readonly images: CoworkExportImageDoor;
  readonly binding: CoworkExportContentBinding;
  readonly allowClone?: boolean;
  readonly limits?: Partial<BundleLimits>;
  /** Isolated fault testing only, never serialized or supplied by an RPC (as in `CoworkVolumes`). */
  readonly checkpoint?: (phase: string) => void | Promise<void>;
}
export interface ExportInput { readonly workspaceId: string; readonly destinationParent: string; readonly name?: string; readonly proof: unknown; readonly signal?: AbortSignal }
export interface ExportResult {
  readonly path: string; readonly exportId: string; readonly generation: number; readonly files: number; readonly bytes: number; readonly contentDigest: string;
  readonly imageCopy: Readonly<Record<"data" | "environment", CopyMethod>>; readonly disclosure: string;
}

const PURPOSE_FILE = { data: "data.ext4", environment: "env.ext4" } as const;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
type Row = Record<string, unknown>;

/** Everything canonical that would differ if the workspace were claimed, run, or changed between two looks. */
function canonicalStamp(rs: RuntimeStateDb, workspaceId: string): string {
  const workspace = rs.db.query<Row, [string]>("SELECT state,power,incarnation_id,lease_epoch,config_revision FROM cowork_workspaces WHERE workspace_id=?").get(workspaceId);
  const volumes = rs.db.query<Row, [string]>("SELECT volume_id,purpose,state,filesystem_state,filesystem_uuid,owner_json,last_stop_id,updated_at,device,inode FROM cowork_volumes WHERE workspace_id=? ORDER BY purpose").all(workspaceId);
  return JSON.stringify([workspace, volumes]);
}

export class CoworkWorkspaceExporter {
  private readonly limits: BundleLimits;
  private readonly active = new Set<string>();
  constructor(private readonly ports: CoworkExportWriterPorts) { this.limits = { ...DEFAULT_BUNDLE_LIMITS, ...ports.limits }; }

  /** A crash between `prepare` and `complete` leaves a generation `prepared`, which blocks every later export. This fails
   * it, but only when THIS exporter is not the one working on it. Returns the failed record, or null when none was stuck. */
  abandonInterrupted(workspaceId: string, proof: unknown): CoworkExportRecord | null {
    const stuck = this.ports.exports.inFlight(lifecycleId(workspaceId));
    if (!stuck) return null;
    if (this.active.has(stuck.exportId)) return lifecycleFail("export_in_progress");
    return this.ports.exports.fail(stuck.exportId, proof);
  }

  async export(input: ExportInput): Promise<ExportResult> {
    const workspaceId = lifecycleId(input.workspaceId);
    const parent = this.destination(input.destinationParent);
    const name = input.name === undefined ? undefined : (NAME.test(input.name) ? input.name : lifecycleFail("destination_invalid"));
    // A named target that exists is refused before a generation is even prepared.
    if (name !== undefined && lstatOrNull(join(parent, `${name}${BUNDLE_SUFFIX}`))) return lifecycleFail("bundle_exists");
    const prepared = this.ports.exports.prepare(workspaceId, input.proof);
    this.active.add(prepared.exportId);
    let owned: string | undefined;
    try {
      const finalPath = join(parent, `${name ?? `winter-workspace-g${prepared.generation}-${prepared.exportId}`}${BUNDLE_SUFFIX}`);
      if (lstatOrNull(finalPath)) return lifecycleFail("bundle_exists");
      const partial = join(parent, `.${randomUUID()}.partial`);
      mkdirSync(partial, { mode: 0o700 });
      owned = partial;
      const built = await this.build(workspaceId, prepared, partial, input);
      await this.ports.checkpoint?.("before-rename");
      try { renameDirect(partial, finalPath, "exclusive"); }
      catch (error) { if (error instanceof ExportIoError && error.errno === 17) return lifecycleFail("bundle_exists"); throw error; }
      owned = finalPath; // our own just-created folder: if the record then refuses to complete, it is taken back
      await this.ports.checkpoint?.("before-complete");
      this.ports.exports.complete(prepared.exportId, input.proof);
      owned = undefined; syncDirectory(parent);
      return { ...built, path: finalPath };
    } catch (error) {
      try { this.ports.exports.fail(prepared.exportId, input.proof); } catch { /* already failed: nothing to retract */ }
      if (owned) { try { rmSync(owned, { recursive: true, force: true }); } catch { /* a leftover dot-folder is inert and never listed as a bundle */ } }
      if (error instanceof CoworkLifecycleError) throw error;
      if (error instanceof ExportIoError && error.reason === "cancelled") throw error;
      return lifecycleFail("export_not_ready");
    } finally { this.active.delete(prepared.exportId); }
  }

  /** A user-chosen existing folder: owned by this user, not group/world writable, no ACL granting writes, and never inside Cowork's own storage. */
  private destination(raw: string): string {
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.includes("\0")) return lifecycleFail("destination_invalid");
    let real: string, home: string;
    try { real = realpathSync(raw); home = realpathSync(this.ports.home); } catch { return lifecycleFail("destination_invalid"); }
    const st = lstatSync(real);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o022) !== 0) return lifecycleFail("destination_invalid");
    // chmod bits alone do not exclude an ACL entry that lets another principal add files or delete children here.
    if (hasWritableAcl(real)) return lifecycleFail("destination_invalid");
    const inside = relative(join(home, "cowork"), real);
    if (!(inside === ".." || inside.startsWith(`..${sep}`))) return lifecycleFail("destination_invalid"); // Cowork's own storage tree, or the folder itself
    return real;
  }

  private async build(workspaceId: string, prepared: PreparedExport, partial: string, input: ExportInput): Promise<Omit<ExportResult, "path">> {
    const { rs } = this.ports, signal = input.signal;
    const before = canonicalStamp(rs, workspaceId);
    const entries: BundleFileEntry[] = [], methods = {} as Record<"data" | "environment", CopyMethod>;
    const partialFd = openDirectoryNoFollow(partial);
    try {
      for (const volume of [...prepared.manifest.volumes].sort((a, b) => comparePaths(a.relativePath, b.relativePath))) {
        const purpose = volume.purpose, file = PURPOSE_FILE[purpose];
        const image = this.ports.images.openStopped(workspaceId, purpose, input.proof);
        try {
          // The door re-verified identity, mode and the sticky exclusion on this pinned descriptor; the size is the record's.
          if (image.capacityBytes !== volume.capacityBytes || Number(fstatSync(image.fd).size) !== volume.capacityBytes) return lifecycleFail("recovery_required");
          const first = stampDescriptor(image.fd);
          methods[purpose] = await copyImageFile(image.fd, join(partial, file), { allowClone: this.ports.allowClone, signal });
          await this.ports.checkpoint?.(`image-copied:${purpose}`);
          // A byte written into the source during the copy changes its change time even when the size does not.
          if (stampDescriptor(image.fd) !== first) return lifecycleFail("generation_stale");
          const copy = openRegularAt(partialFd, file);
          try {
            if (Number(fstatSync(copy).size) !== volume.capacityBytes) return lifecycleFail("export_not_ready");
            entries.push({ path: file, bytes: volume.capacityBytes, sha256: await hashDescriptor(copy, volume.capacityBytes, signal) });
          } finally { closeSync(copy); }
        } finally { image.close(); }
      }
    } finally { closeSync(partialFd); }
    const mapper = new OutputIdMapper();
    entries.push(...await this.snapshotShared(workspaceId, partial, mapper, signal));
    await this.ports.checkpoint?.("shared-snapshotted");
    const manifestBytes = Buffer.from(prepared.manifestJson, "utf8");
    writeNewFile(join(partial, "manifest.json"), manifestBytes);
    entries.push({ path: "manifest.json", bytes: manifestBytes.length, sha256: sha256Hex(prepared.manifestJson) });
    entries.sort((a, b) => comparePaths(a.path, b.path));
    const integrityText = serializeIntegrity({ formatVersion: 1, kind: "cowork-workspace-export-integrity", exportId: prepared.exportId, manifestDigest: prepared.manifestDigest, files: entries });
    writeNewFile(join(partial, "integrity.json"), Buffer.from(integrityText, "utf8"));
    syncDirectory(partial);
    // Nothing canonical may have moved: a claim, a run, a release or a configuration change all differ here.
    if (canonicalStamp(rs, workspaceId) !== before) return lifecycleFail("generation_stale");
    // Bind the contents to the generation's record before the bundle can appear. A restore refuses a bundle this does not match.
    const contentDigest = sha256Hex(integrityText);
    this.ports.binding.record(prepared.exportId, { contentDigest, outputIds: mapper.reverse });
    return { exportId: prepared.exportId, generation: prepared.generation, files: entries.length + 1, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), contentDigest, imageCopy: methods, disclosure: prepared.disclosure };
  }

  /** The three whitelisted shared roots, walked on HELD descriptors with no-follow opens and a second full pass that must agree. */
  private async snapshotShared(workspaceId: string, partial: string, mapper: OutputIdMapper, signal?: AbortSignal): Promise<BundleFileEntry[]> {
    const expected = join(realpathSync(this.ports.home), "cowork", "workspaces", workspaceId, "shared");
    let shared: string;
    try { shared = realpathSync(expected); } catch { return []; } // no shared folder yet: nothing to export
    if (shared !== expected) return lifecycleFail("bundle_unsafe");
    let sharedFd: number;
    try { sharedFd = openDirectoryNoFollow(shared); } catch { return lifecycleFail("bundle_unsafe"); }
    const held: Array<{ root: string; fd: number }> = [];
    try {
      for (const root of BUNDLE_SHARED_ROOTS) { const fd = openSubdirectoryAt(sharedFd, root); if (fd !== null) held.push({ root, fd }); }
      const bundlePath = (root: string, path: string) => root === "outputs" ? `shared/outputs/${mapper.toBundle(path)}` : `shared/${root}/${path}`;
      const walk = () => { const budget: WalkBudget = { files: 0, bytes: 0 }; return held.map(({ root, fd }) => ({ root, fd, files: walkRegularFilesAt(fd, this.limits, budget) })); };
      const first: BundleFileEntry[] = [], made = new Set<string>();
      for (const { root, fd, files } of walk()) {
        for (const file of files) {
          const path = bundlePath(root, file.path);
          ensureDirectories(partial, path, made);
          const source = openRegularAt(fd, file.path, file);
          try { const copied = await copyFdHashed(source, join(partial, path), { bytes: file.bytes, signal }); first.push({ path, bytes: copied.bytes, sha256: copied.sha256 }); } finally { closeSync(source); }
        }
      }
      await this.ports.checkpoint?.("shared-pass-1");
      // Pass 2: the same tree, listed and hashed again from the source. A file that changed, appeared or vanished refuses.
      const second: BundleFileEntry[] = [];
      for (const { root, fd, files } of walk()) {
        for (const file of files) {
          const source = openRegularAt(fd, file.path, file);
          try { second.push({ path: bundlePath(root, file.path), bytes: file.bytes, sha256: await hashDescriptor(source, file.bytes, signal) }); } finally { closeSync(source); }
        }
      }
      if (JSON.stringify(first) !== JSON.stringify(second)) return lifecycleFail("generation_stale");
      return first;
    } finally { for (const { fd } of held) closeSync(fd); closeSync(sharedFd); }
  }
}
