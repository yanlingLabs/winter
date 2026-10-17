/** N2 S6 (UNWIRED): physical free-space admission for Cowork's private raw images, a production
 * `fstatfs`/`statfs` adapter, an `fstat` allocation reader, and the admission-time Time Machine exclusion
 * re-verification.
 *
 * Nothing in `src/` imports this file. It owns no process, no timer and no persistent state; the host that
 * claims or launches a workspace calls `preflightImageAdmission` (or `assessFreeSpace`) with ports it injects.
 *
 * SPARSE IMAGES ARE NOT RESERVATIONS. A raw image is created with `ftruncate`, so its logical size
 * ("provisioned" bytes) claims no physical space: a 256 GiB image on a nearly full disk exists and works until
 * the guest writes. Admission therefore reserves the REMAINING LIABILITY of every image:
 *     remaining = provisioned - min(provisioned, allocated)      (allocated = st_blocks * 512 of the pinned fd)
 * A never-written sparse image has allocated ~ 0, so it needs its full provisioned size. Bytes the image already
 * holds are credited because they are already missing from the free-space reading; counting them again would
 * lock out a mostly written image on a disk that still has room for the rest of its growth. An unreadable
 * allocation earns NO credit (full provisioned size). Caveat: on APFS an overwrite can allocate new blocks
 * without freeing old ones (copy-on-write, clones, local snapshots), so remaining growth can exceed
 * `provisioned - allocated`; the reserve and the reactive guard in `pressure.ts` cover that, nothing here does.
 *
 * THE RULE:   min(available bytes over every observed filesystem) >= sum(remaining of every image) + reserve.
 * It is a MIN, not a per-filesystem group: on APFS several volumes share one container's free pool and each
 * reports the container's free space, so grouping by `f_fsid` would count the same bytes twice.
 *
 * CALLER OBLIGATION (S7): admission can only count the images it is given. The caller MUST pass, in
 * `outstanding`, every provisioned image of every non-released admission it knows of (other workspaces of this
 * daemon, running or draining or uncertain; never the images being admitted, which go in `images`).
 * Omitting them under-counts, because those guests may still grow into the same pool. Admissions of other
 * Winter homes are invisible to this daemon; those are covered only by the reserve and the reactive guard.
 * An export of a STOPPED workspace must not go through this admission at all, or a full disk would lock the
 * user out of their own data: S7 needs an export-while-stopped path that bypasses launch admission.
 *
 * `resource_blocked` is a RESULT here, not a `CoworkErrorCode`: the code union lives in the hot `cowork/types.ts`
 * and gains no member in this slice. The host maps the structured result later. */
import { dlopen, FFIType } from "bun:ffi";
import { fstatSync, lstatSync } from "node:fs";
import type { CoworkVolumeBackup } from "../volume-backup";

/** docs/cowork-execution-contracts.md: "Begin with a tunable 5 GiB free-space reserve". */
export const COWORK_FREE_SPACE_RESERVE_BYTES = 5 * 1024 ** 3;
/** Two images per guest across the ledger's 4096-guest cap: the bound on `images` and `outstanding` together. */
export const COWORK_FREE_SPACE_MAX_IMAGES = 8192;
/** The bound on `images` alone. One guest admits two (data and environment); four leaves room without letting a caller
 * hand over a whole machine's worth of images as "being admitted" (those belong in `outstanding`). */
export const COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES = 4;

export type SpaceTarget = { readonly kind: "fd"; readonly fd: number } | { readonly kind: "path"; readonly path: string };
export interface FilesystemSpace {
  /** `f_fsid`. Diagnostic for admission (never used to partition free space); the guard also uses it to notice
   * that a watched target now answers for a different filesystem. */
  readonly filesystemId: string;
  readonly typeName: string;
  readonly blockBytes: number;
  readonly totalBytes: number;
  /** `f_bavail * f_bsize`: what a non-privileged writer can still allocate. APFS purgeable space is NOT
   * counted, so this is the conservative reading. */
  readonly availableBytes: number;
}
/** Trusted host seam. `null` or a throw means "cannot observe", and every consumer fails closed. */
export interface FilesystemSpaceReader { read(target: SpaceTarget): FilesystemSpace | null }
/** Bytes physically allocated to the regular file behind `target`, or null when unknown. Null earns no credit. */
export interface ImageFootprintReader { allocatedBytes(target: SpaceTarget): number | null }
/** The guard's admission view. Any blocked or unobserved filesystem refuses all new write-producing work. */
export interface PressureView { admitsNewWork(): boolean }

/** Read through the port with every property access inside the try, and return a plain validated copy. A reader
 * that throws, returns garbage or hands back a hostile getter yields null, never an exception. */
export function readSpaceSafely(reader: FilesystemSpaceReader, target: SpaceTarget): FilesystemSpace | null {
  try {
    const seen = reader.read(target);
    if (!seen) return null;
    const filesystemId = seen.filesystemId, availableBytes = seen.availableBytes;
    if (typeof filesystemId !== "string" || filesystemId.length === 0 || filesystemId.length > 200 || !Number.isSafeInteger(availableBytes) || availableBytes < 0) return null;
    return { filesystemId, typeName: seen.typeName, blockBytes: seen.blockBytes, totalBytes: seen.totalBytes, availableBytes };
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------
// statfs layout (macOS arm64, 64-bit inode `struct statfs`, 2168 bytes). Verified by the real-host shape
// test: bsize@0 u32, blocks@8 u64, bfree@16, bavail@24, fsid@48 (2 x i32), fstypename@72 (char[16]).
export const STATFS_BYTES = 2168;
const STATFS_OFFSET = { blockBytes: 0, blocks: 8, available: 24, fsid: 48, typeName: 72 } as const;
const TYPE_NAME_BYTES = 16;

/** Pure and layout-only so synthetic buffers can exercise every refusal. */
export function parseStatfs(raw: Uint8Array): FilesystemSpace | null {
  if (raw.length < STATFS_BYTES) return null;
  const view = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const blockBytes = view.readUInt32LE(STATFS_OFFSET.blockBytes);
  if (blockBytes < 512 || blockBytes > 1 << 24) return null;
  const blocks = view.readBigUInt64LE(STATFS_OFFSET.blocks), available = view.readBigUInt64LE(STATFS_OFFSET.available);
  if (available > blocks) return null;
  const total = blocks * BigInt(blockBytes), free = available * BigInt(blockBytes);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || free > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const nameBytes = view.subarray(STATFS_OFFSET.typeName, STATFS_OFFSET.typeName + TYPE_NAME_BYTES), end = nameBytes.indexOf(0);
  const typeName = end < 0 ? "" : nameBytes.subarray(0, end).toString("latin1");
  if (!/^[ -~]{1,15}$/.test(typeName)) return null;
  const fsid = `${(view.readInt32LE(STATFS_OFFSET.fsid) >>> 0).toString(16)}:${(view.readInt32LE(STATFS_OFFSET.fsid + 4) >>> 0).toString(16)}`;
  return { filesystemId: `fsid:${fsid}`, typeName, blockBytes, totalBytes: Number(total), availableBytes: Number(free) };
}

export interface StatfsLibrary {
  statfs(path: Buffer, out: Buffer): number;
  fstatfs(fd: number, out: Buffer): number;
}
function loadStatfsLibrary(): StatfsLibrary {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("unsupported_topology");
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    statfs: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    fstatfs: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  return { statfs: (path, out) => lib.symbols.statfs!(path, out) as number, fstatfs: (fd, out) => lib.symbols.fstatfs!(fd, out) as number };
}
const validFd = (fd: unknown): fd is number => Number.isSafeInteger(fd) && (fd as number) >= 0 && (fd as number) <= 0x7fffffff;
const validPath = (path: unknown): path is string => typeof path === "string" && path.length > 0 && path.length <= 4096 && !path.includes("\0") && path.startsWith("/");

/** Production `FilesystemSpaceReader`. Prefer an `fd` target wherever a pinned image descriptor exists:
 * `fstatfs` never re-resolves a path, matching the volume code's "never re-resolve an image path" rule. */
export function createStatfsReader(library: StatfsLibrary = loadStatfsLibrary()): FilesystemSpaceReader {
  return {
    read(target) {
      const out = Buffer.alloc(STATFS_BYTES);
      let status: number;
      if (target?.kind === "fd") {
        if (!validFd(target.fd)) return null;
        status = library.fstatfs(target.fd, out);
      } else if (target?.kind === "path") {
        if (!validPath(target.path)) return null;
        status = library.statfs(Buffer.from(`${target.path}\0`), out);
      } else return null;
      return status === 0 ? parseStatfs(out) : null;
    },
  };
}
/** Production `ImageFootprintReader`: `st_blocks * 512` from `fstat` on a pinned descriptor (or `lstat` on a path,
 * never following a link). Only a regular file has a footprint; a directory, a link, a missing path or a bad
 * descriptor is null. Read-only. */
export function createFstatFootprintReader(): ImageFootprintReader {
  return {
    allocatedBytes(target) {
      try {
        // A bad descriptor makes fstat throw, which the catch turns into null.
        const stat = target?.kind === "fd" ? fstatSync(target.fd, { bigint: true })
          : target?.kind === "path" ? (validPath(target.path) ? lstatSync(target.path, { bigint: true }) : null) : null;
        if (!stat || !stat.isFile()) return null;
        const bytes = stat.blocks * 512n;
        return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
      } catch { return null; }
    },
  };
}

// ---------------------------------------------------------------------------------------------------
export type ResourceBlockedReason = "free_space_below_requirement" | "free_space_below_reserve" | "free_space_unavailable" | "free_space_filesystem_changed" | "pressure_guard_blocked";
/** The structured `resource_blocked` outcome. No host path, no error text. */
export interface ResourceBlocked {
  readonly outcome: "resource_blocked";
  readonly reason: ResourceBlockedReason;
  /** Null when the blocking happened before the requirement could be computed. */
  readonly requiredBytes: number | null;
  readonly availableBytes: number | null;
  readonly reserveBytes: number;
  readonly filesystemId: string | null;
}
export interface FreeSpaceAdmitted {
  readonly outcome: "admit";
  readonly requiredBytes: number;
  readonly availableBytes: number;
  readonly reserveBytes: number;
  readonly filesystemId: string;
}
export interface InvalidAdmissionRequest { readonly outcome: "invalid_request"; readonly detail: string }
export type FreeSpaceAssessment = FreeSpaceAdmitted | ResourceBlocked | InvalidAdmissionRequest;

/** `target` is where free space and the footprint are read (an fd on the pinned image when one exists). */
export interface ProvisionedImage { readonly name: string; readonly provisionedBytes: number; readonly target: SpaceTarget }
export interface FreeSpaceInput {
  /** The images being admitted: at least one. */
  readonly images: readonly ProvisionedImage[];
  /** REQUIRED, pass `[]` when there is none: every provisioned image of every OTHER non-released admission. See the
   * caller obligation in the file comment. The images being admitted must not appear here. */
  readonly outstanding: readonly ProvisionedImage[];
  readonly space: FilesystemSpaceReader;
  readonly footprint: ImageFootprintReader;
  readonly guard: PressureView;
  /** Tunable; defaults to the contract's 5 GiB. */
  readonly reserveBytes?: number;
}
const IMAGE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const invalid = (detail: string): InvalidAdmissionRequest => ({ outcome: "invalid_request", detail });
const blocked = (reason: ResourceBlockedReason, reserveBytes: number, required: number | null, available: number | null, filesystemId: string | null): ResourceBlocked =>
  ({ outcome: "resource_blocked", reason, requiredBytes: required, availableBytes: available, reserveBytes, filesystemId });
const validImage = (image: ProvisionedImage | undefined): image is ProvisionedImage =>
  !!image && typeof image.name === "string" && IMAGE_NAME.test(image.name) && Number.isSafeInteger(image.provisionedBytes) && image.provisionedBytes >= 1 && !!image.target;
/** Provisioned minus what is already allocated, never negative; an unreadable or nonsensical footprint credits nothing. */
function remainingBytes(image: ProvisionedImage, footprint: ImageFootprintReader): number {
  let allocated = 0;
  try {
    const seen = footprint.allocatedBytes(image.target);
    if (typeof seen === "number" && Number.isSafeInteger(seen) && seen > 0) allocated = Math.min(seen, image.provisionedBytes);
  } catch { allocated = 0; }
  return image.provisionedBytes - allocated;
}

/** Claim and launch use this same check: free space must cover the remaining liability of every image plus the
 * reserve. `free < required` blocks; `free == required` admits. An unreadable reading blocks (fail closed). */
export function assessFreeSpace(input: FreeSpaceInput): FreeSpaceAssessment {
  const reserve = input?.reserveBytes ?? COWORK_FREE_SPACE_RESERVE_BYTES;
  if (!input || !Array.isArray(input.images) || input.images.length < 1) return invalid("images");
  if (!Array.isArray(input.outstanding)) return invalid("outstanding");
  if (input.images.length > COWORK_FREE_SPACE_MAX_ADMITTED_IMAGES || input.images.length + input.outstanding.length > COWORK_FREE_SPACE_MAX_IMAGES) return invalid("images");
  if (!Number.isSafeInteger(reserve) || reserve < 1) return invalid("reserveBytes");
  if (typeof input.space?.read !== "function" || typeof input.footprint?.allocatedBytes !== "function" || typeof input.guard?.admitsNewWork !== "function") return invalid("ports");
  const all = [...input.images, ...input.outstanding];
  if (!all.every(validImage)) return invalid("image");
  let guardAdmits = false;
  try { guardAdmits = input.guard.admitsNewWork() === true; } catch { guardAdmits = false; }
  if (!guardAdmits) return blocked("pressure_guard_blocked", reserve, null, null, null);
  let required = reserve, limiting: FilesystemSpace | null = null;
  for (const image of all) {
    const observed = readSpaceSafely(input.space, image.target);
    if (!observed) return blocked("free_space_unavailable", reserve, null, null, null);
    required += remainingBytes(image, input.footprint);
    if (!Number.isSafeInteger(required)) return invalid("requiredBytes");
    if (limiting === null || observed.availableBytes < limiting.availableBytes) limiting = observed;
  }
  if (limiting === null || limiting.availableBytes < required) return blocked("free_space_below_requirement", reserve, required, limiting?.availableBytes ?? null, limiting?.filesystemId ?? null);
  return { outcome: "admit", requiredBytes: required, availableBytes: limiting.availableBytes, reserveBytes: reserve, filesystemId: limiting.filesystemId };
}

// ---------------------------------------------------------------------------------------------------
/** Re-verification only. The parameter type deliberately omits the enrollment member of `CoworkVolumeBackup`, so
 * this module cannot apply or change an exclusion: enrollment stays in `CoworkVolumes`. This module never runs
 * the backup tool itself; the injected backup does, and its named check must run outside any SQLite transaction. */
export type ExclusionVerifier = Pick<CoworkVolumeBackup, "verifyItemExcluded" | "verifyDescriptorExcluded">;
export interface ExcludableImage { readonly name: string; readonly path: string; readonly fd: number }
export interface BackupExclusionUnavailable { readonly outcome: "backup_exclusion_unavailable"; readonly image: string }
/** Returns the first image whose sticky exclusion cannot be confirmed (both the cheap vnode check and the
 * named check must say yes; a throw is a no), or `null` when every image is confirmed. */
export function reverifyStickyExclusion(images: readonly ExcludableImage[], backup: ExclusionVerifier): BackupExclusionUnavailable | null {
  for (const image of images) {
    let excluded = false;
    try { excluded = backup.verifyDescriptorExcluded(image.fd) === true && backup.verifyItemExcluded(image.path, image.fd) === true; } catch { excluded = false; }
    if (!excluded) return { outcome: "backup_exclusion_unavailable", image: image.name };
  }
  return null;
}

export interface PreflightImage { readonly name: string; readonly provisionedBytes: number; readonly path: string; readonly fd: number }
export interface PreflightInput {
  /** The images being admitted, as pinned descriptors: free space and allocation are read from the fd. */
  readonly images: readonly PreflightImage[];
  /** REQUIRED, pass `[]` when there is none. See the caller obligation in the file comment. */
  readonly outstanding: readonly ProvisionedImage[];
  readonly space: FilesystemSpaceReader;
  readonly footprint: ImageFootprintReader;
  readonly guard: PressureView;
  readonly backup: ExclusionVerifier;
  readonly reserveBytes?: number;
}
export type PreflightResult = FreeSpaceAssessment | BackupExclusionUnavailable;
/** Launch preflight over pinned image descriptors: pressure guard, then free space (via `fstatfs`/`fstat` on each
 * fd), then the sticky Time Machine exclusion re-verification of the images being admitted. All three must pass. */
export function preflightImageAdmission(input: PreflightInput): PreflightResult {
  if (!input || !Array.isArray(input.images) || typeof input.backup?.verifyItemExcluded !== "function" || typeof input.backup?.verifyDescriptorExcluded !== "function") return invalid("ports");
  for (const image of input.images) {
    if (!image || typeof image.path !== "string" || !image.path.startsWith("/") || image.path.includes("\0") || image.path.length > 4096 || !Number.isSafeInteger(image.fd) || image.fd < 0) return invalid("image");
  }
  const space = assessFreeSpace({
    images: input.images.map(image => ({ name: image.name, provisionedBytes: image.provisionedBytes, target: { kind: "fd", fd: image.fd } as const })),
    outstanding: input.outstanding, space: input.space, footprint: input.footprint, guard: input.guard, reserveBytes: input.reserveBytes,
  });
  if (space.outcome !== "admit") return space;
  return reverifyStickyExclusion(input.images, input.backup) ?? space;
}
