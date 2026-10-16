/** N2 S6 (UNWIRED): physical free-space admission for Cowork's private raw images, a production
 * `fstatfs`/`statfs` adapter, and the admission-time Time Machine exclusion re-verification.
 *
 * Nothing in `src/` imports this file. It owns no process, no timer and no persistent state; the host
 * that claims or launches a workspace calls `preflightImageAdmission` with ports it injects.
 *
 * SPARSE IMAGES ARE NOT RESERVATIONS. A raw image is created with `ftruncate`, so its logical size
 * ("provisioned" bytes) claims no physical space at all: a 256 GiB image on a nearly full disk exists and
 * works until the guest writes. Admission therefore counts each image at its PROVISIONED size, never at
 * its on-disk (`st_blocks`) size and never with credit for blocks already written. That is deliberately
 * conservative: an image that already holds data is counted in full although its written blocks are
 * already missing from the free-space reading (see docs/research/2026-10-16-cowork-n2-pressure.md,
 * "Remaining-liability alternative", for the one-line change if the owner wants it).
 *
 * The rule: min(available bytes over every observed filesystem) >= sum(provisioned bytes of ALL images)
 * + reserve. It is a MIN, not a per-filesystem group: on APFS several volumes share one container's free
 * pool, and each reports the container's free space, so checking `f_fsid` groups independently would
 * count the same bytes twice. Images on genuinely separate disks are over-counted, which is safe.
 *
 * `resource_blocked` is a RESULT here, not a `CoworkErrorCode`: the code union lives in the hot
 * `cowork/types.ts` and gains no member in this slice. The host maps the structured result later. */
import { dlopen, FFIType } from "bun:ffi";
import type { CoworkVolumeBackup } from "../volume-backup";

/** docs/cowork-execution-contracts.md: "Begin with a tunable 5 GiB free-space reserve". */
export const COWORK_FREE_SPACE_RESERVE_BYTES = 5 * 1024 ** 3;
const MAX_IMAGES = 16;

export type SpaceTarget = { readonly kind: "fd"; readonly fd: number } | { readonly kind: "path"; readonly path: string };
export interface FilesystemSpace {
  /** `f_fsid`, diagnostic only. Never used to partition free space (see the file comment). */
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
/** The guard's admission view. Any blocked or unobserved filesystem refuses all new write-producing work. */
export interface PressureView { admitsNewWork(): boolean }

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
/** Production `FilesystemSpaceReader`. Prefer an `fd` target wherever a pinned image descriptor exists:
 * `fstatfs` never re-resolves a path, matching the volume code's "never re-resolve an image path" rule. */
export function createStatfsReader(library: StatfsLibrary = loadStatfsLibrary()): FilesystemSpaceReader {
  return {
    read(target) {
      const out = Buffer.alloc(STATFS_BYTES);
      let status: number;
      if (target?.kind === "fd") {
        if (!Number.isSafeInteger(target.fd) || target.fd < 0 || target.fd > 0x7fffffff) return null;
        status = library.fstatfs(target.fd, out);
      } else if (target?.kind === "path") {
        if (typeof target.path !== "string" || target.path.length === 0 || target.path.length > 4096 || target.path.includes("\0") || !target.path.startsWith("/")) return null;
        status = library.statfs(Buffer.from(`${target.path}\0`), out);
      } else return null;
      return status === 0 ? parseStatfs(out) : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------------
export type ResourceBlockedReason = "free_space_below_requirement" | "free_space_below_reserve" | "free_space_unavailable" | "pressure_guard_blocked";
/** The structured `resource_blocked` outcome. No host path, no error text. */
export interface ResourceBlocked {
  readonly outcome: "resource_blocked";
  readonly reason: ResourceBlockedReason;
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

/** `target` is where free space is read (an fd on the pinned image when one exists). */
export interface ProvisionedImage { readonly name: string; readonly provisionedBytes: number; readonly target: SpaceTarget }
export interface FreeSpaceInput {
  readonly images: readonly ProvisionedImage[];
  readonly space: FilesystemSpaceReader;
  readonly guard: PressureView;
  /** Tunable; defaults to the contract's 5 GiB. */
  readonly reserveBytes?: number;
}
const IMAGE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const invalid = (detail: string): InvalidAdmissionRequest => ({ outcome: "invalid_request", detail });
const blocked = (reason: ResourceBlockedReason, reserveBytes: number, required: number | null, available: number | null, filesystemId: string | null): ResourceBlocked =>
  ({ outcome: "resource_blocked", reason, requiredBytes: required, availableBytes: available, reserveBytes, filesystemId });

/** Claim and launch use this same check: free space must cover every image's provisioned size plus the
 * reserve. `free < required` blocks; `free == required` admits. An unreadable reading blocks (fail closed). */
export function assessFreeSpace(input: FreeSpaceInput): FreeSpaceAssessment {
  const reserve = input?.reserveBytes ?? COWORK_FREE_SPACE_RESERVE_BYTES;
  if (!input || !Array.isArray(input.images) || input.images.length < 1 || input.images.length > MAX_IMAGES) return invalid("images");
  if (!Number.isSafeInteger(reserve) || reserve < 1) return invalid("reserveBytes");
  if (typeof input.space?.read !== "function" || typeof input.guard?.admitsNewWork !== "function") return invalid("ports");
  let required = reserve;
  for (const image of input.images) {
    if (!image || typeof image.name !== "string" || !IMAGE_NAME.test(image.name) || !Number.isSafeInteger(image.provisionedBytes) || image.provisionedBytes < 1) return invalid("image");
    required += image.provisionedBytes;
    if (!Number.isSafeInteger(required)) return invalid("requiredBytes");
  }
  let guardAdmits = false;
  try { guardAdmits = input.guard.admitsNewWork() === true; } catch { guardAdmits = false; }
  if (!guardAdmits) return blocked("pressure_guard_blocked", reserve, required, null, null);
  let limiting: FilesystemSpace | null = null;
  for (const image of input.images) {
    let observed: FilesystemSpace | null = null;
    try { observed = input.space.read(image.target); } catch { observed = null; }
    if (!observed || !Number.isSafeInteger(observed.availableBytes) || observed.availableBytes < 0) return blocked("free_space_unavailable", reserve, required, null, null);
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
  readonly images: readonly PreflightImage[];
  readonly space: FilesystemSpaceReader;
  readonly guard: PressureView;
  readonly backup: ExclusionVerifier;
  readonly reserveBytes?: number;
}
export type PreflightResult = FreeSpaceAssessment | BackupExclusionUnavailable;
/** Claim/launch preflight over pinned image descriptors: pressure guard, then free space (via `fstatfs` on
 * each fd), then the sticky Time Machine exclusion re-verification. All three must pass. */
export function preflightImageAdmission(input: PreflightInput): PreflightResult {
  if (!input || !Array.isArray(input.images) || typeof input.backup?.verifyItemExcluded !== "function" || typeof input.backup?.verifyDescriptorExcluded !== "function") return invalid("ports");
  for (const image of input.images) {
    if (!image || typeof image.path !== "string" || !image.path.startsWith("/") || image.path.includes("\0") || image.path.length > 4096 || !Number.isSafeInteger(image.fd) || image.fd < 0) return invalid("image");
  }
  const space = assessFreeSpace({ images: input.images.map(image => ({ name: image.name, provisionedBytes: image.provisionedBytes, target: { kind: "fd", fd: image.fd } as const })), space: input.space, guard: input.guard, reserveBytes: input.reserveBytes });
  if (space.outcome !== "admit") return space;
  return reverifyStickyExclusion(input.images, input.backup) ?? space;
}
