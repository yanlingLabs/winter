/*
 * The `.winterworkspace` folder bundle: its exact shape, the integrity index, the safe tree walk both the writer and the
 * restore flow use, and the full verification of a bundle that is presented for restore.
 *
 * A bundle is a plain folder (owner decision 2026-10-16; docs/cowork-storage-security.md "Owner decision ... export format"):
 *
 *   <name>.winterworkspace/
 *     manifest.json     the recorded manifest, byte for byte (`cowork_exports.manifest_json`); its sha256 is the recorded digest
 *     integrity.json    canonical JSON: the export id, the manifest digest, and {path, bytes, sha256} for every other file
 *     data.ext4  env.ext4
 *     shared/{instructions,memory,outputs}/**    regular files only
 *
 * The contents are a WHITELIST. Nothing outside it is ever read into a bundle: no authority database, no bookmark, no
 * credential, no Keychain item, nothing from `~/.winter*` beyond the workspace's own two images and three shared roots.
 *
 * WHAT THE INTEGRITY INDEX IS AND IS NOT. It detects corruption and truncation of any file. It does NOT detect a deliberate
 * rewrite of the whole bundle (an attacker can recompute the index), because nothing in the database binds it: the closed v1
 * manifest has no field for it and `cowork_exports` has no column. Restore therefore rests on `validateImport` (the manifest
 * must be the recorded, completed generation of a workspace this home owns) for authority, and on this index for integrity.
 * Binding the index needs one column (`content_digest`) and a migration; that is listed in the lane report, not done here.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ExportIoError, hashDescriptor, stampDescriptor } from "./export-io";
import { EXPORT_MANIFEST_MAX_BYTES } from "./exports";
import { CoworkLifecycleError, canonicalJson, lifecycleFail, sha256Hex } from "./storage-lifecycle";

export const BUNDLE_SUFFIX = ".winterworkspace";
export const BUNDLE_IMAGE_FILES = Object.freeze(["data.ext4", "env.ext4"] as const);
export const BUNDLE_SHARED_ROOTS = Object.freeze(["instructions", "memory", "outputs"] as const);
export interface BundleLimits { readonly files: number; readonly depth: number; readonly sharedBytes: number; readonly integrityBytes: number }
export const DEFAULT_BUNDLE_LIMITS: BundleLimits = Object.freeze({ files: 50_000, depth: 32, sharedBytes: 16 * 1024 ** 3, integrityBytes: 16 * 1024 ** 2 });

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const Entry = z.object({ path: z.string().min(1).max(4096), bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), sha256: Digest }).strict();
export type BundleFileEntry = z.infer<typeof Entry>;
export const BundleIntegrity = z.object({ formatVersion: z.literal(1), kind: z.literal("cowork-workspace-export-integrity"), exportId: Id, manifestDigest: Digest,
  files: z.array(Entry).max(DEFAULT_BUNDLE_LIMITS.files + 3) }).strict();
export type BundleIntegrity = z.infer<typeof BundleIntegrity>;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** One path component of anything that goes into a bundle or comes out of one. */
export function validBundleComponent(part: string): boolean {
  return typeof part === "string" && part.length > 0 && part !== "." && part !== ".." && part.isWellFormed() && !CONTROL.test(part) && !part.includes("/") && Buffer.byteLength(part, "utf8") <= 255;
}
/** The only paths a bundle may name. */
export function validBundlePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || Buffer.byteLength(path, "utf8") > 4096) return false;
  if (path === "manifest.json" || (BUNDLE_IMAGE_FILES as readonly string[]).includes(path)) return true;
  const parts = path.split("/");
  return parts[0] === "shared" && parts.length >= 3 && (BUNDLE_SHARED_ROOTS as readonly string[]).includes(parts[1]!) && parts.slice(1).every(validBundleComponent);
}
export const comparePaths = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const serializeIntegrity = (integrity: BundleIntegrity): string => canonicalJson(integrity);

// ---------------------------------------------------------------------------------------------------- safe tree walk

export interface TreeFile { readonly path: string; readonly bytes: number; readonly dev: bigint; readonly ino: bigint }
const identity = (st: { dev: bigint; ino: bigint }) => `${st.dev}:${st.ino}`;
/**
 * Every regular file beneath `root`, sorted bytewise, as paths relative to `root`. Symlinks, hard links (nlink above 1),
 * FIFOs, sockets and devices REFUSE the whole walk (`bundle_unsafe`): a guest-authored link in a shared folder is never
 * followed and never silently dropped. Empty directories are not recorded. A directory swapped while it is listed refuses.
 */
export function walkRegularFiles(root: string, limits: BundleLimits): TreeFile[] {
  const out: TreeFile[] = []; let total = 0;
  const visit = (dir: string, relative: string[], depth: number): void => {
    if (depth > limits.depth) lifecycleFail("bundle_unsafe");
    const before = lstatSync(dir, { bigint: true });
    if (!before.isDirectory()) lifecycleFail("bundle_unsafe");
    const names = readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const name of names) {
      if (!validBundleComponent(name)) lifecycleFail("bundle_unsafe");
      const path = join(dir, name), st = lstatSync(path, { bigint: true });
      if (st.isDirectory()) { visit(path, [...relative, name], depth + 1); continue; }
      if (!st.isFile() || st.nlink !== 1n) lifecycleFail("bundle_unsafe");
      const bytes = Number(st.size);
      total += bytes;
      if (out.length >= limits.files || total > limits.sharedBytes) lifecycleFail("bundle_unsafe");
      out.push({ path: [...relative, name].join("/"), bytes, dev: st.dev, ino: st.ino });
    }
    const after = lstatSync(dir, { bigint: true });
    if (identity(before) !== identity(after)) lifecycleFail("bundle_unsafe");
  };
  visit(root, [], 0);
  return out.sort((a, b) => comparePaths(a.path, b.path));
}
/** Open a regular file by path without following a final symlink, then confirm it is still the file the walk saw. */
export function openRegularFile(path: string, expected?: { readonly dev: bigint; readonly ino: bigint }): number {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || (expected && (st.dev !== expected.dev || st.ino !== expected.ino))) lifecycleFail("bundle_unsafe");
    return fd;
  } catch (error) { if (fd >= 0) closeSync(fd); if (error instanceof CoworkLifecycleError) throw error; return lifecycleFail("bundle_unsafe"); }
}

// ---------------------------------------------------------------------------------------------------- verifying a bundle

export interface VerifiedBundle {
  /** The realpath of the bundle folder. */
  readonly root: string;
  readonly manifestText: string;
  readonly integrity: BundleIntegrity;
  readonly files: ReadonlyMap<string, BundleFileEntry>;
}
function readBounded(path: string, max: number): Buffer {
  const fd = openRegularFile(path);
  try {
    const size = Number(fstatSync(fd).size);
    if (size > max) return lifecycleFail("bundle_invalid");
    const out = Buffer.alloc(size);
    for (let at = 0; at < size;) { const got = readSync(fd, out, at, size - at, at); if (got <= 0) return lifecycleFail("bundle_invalid"); at += got; }
    return out;
  } finally { closeSync(fd); }
}

/**
 * Judge a presented bundle completely BEFORE anything of it is used: structure (a closed set of top-level names, only
 * regular files), the integrity index (canonical, sorted, every path whitelisted, the file set EXACTLY the index's), the
 * manifest bytes against the index's digest, then every file's size and sha256. Reads only; creates nothing.
 */
export async function verifyBundle(presented: string, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS, signal?: AbortSignal): Promise<VerifiedBundle> {
  if (typeof presented !== "string" || !presented.endsWith(BUNDLE_SUFFIX) || !presented.startsWith("/") || presented.includes("\0")) return lifecycleFail("bundle_invalid");
  let root: string;
  try { if (lstatSync(presented).isSymbolicLink()) return lifecycleFail("bundle_unsafe"); root = realpathSync(presented); }
  catch (error) { if (error instanceof CoworkLifecycleError) throw error; return lifecycleFail("bundle_invalid"); }
  if (!lstatSync(root).isDirectory()) return lifecycleFail("bundle_invalid");
  const top = readdirSync(root).sort();
  const allowed = new Set(["manifest.json", "integrity.json", ...BUNDLE_IMAGE_FILES, "shared"]);
  if (top.some(name => !allowed.has(name)) || !["manifest.json", "integrity.json", ...BUNDLE_IMAGE_FILES].every(name => top.includes(name))) return lifecycleFail("bundle_invalid");
  const actual = new Map<string, TreeFile>();
  for (const name of ["manifest.json", ...BUNDLE_IMAGE_FILES]) {
    const st = lstatSync(join(root, name), { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) return lifecycleFail("bundle_unsafe");
    actual.set(name, { path: name, bytes: Number(st.size), dev: st.dev, ino: st.ino });
  }
  if (top.includes("shared")) {
    const shared = join(root, "shared");
    if (!lstatSync(shared).isDirectory()) return lifecycleFail("bundle_unsafe");
    if (readdirSync(shared).some(name => !(BUNDLE_SHARED_ROOTS as readonly string[]).includes(name))) return lifecycleFail("bundle_invalid");
    for (const file of walkRegularFiles(shared, limits)) actual.set(`shared/${file.path}`, { ...file, path: `shared/${file.path}` });
  }
  const integrityText = readBounded(join(root, "integrity.json"), limits.integrityBytes).toString("utf8");
  let integrity: BundleIntegrity;
  try {
    const parsed = BundleIntegrity.safeParse(JSON.parse(integrityText));
    if (!parsed.success || serializeIntegrity(parsed.data) !== integrityText) return lifecycleFail("bundle_invalid");
    integrity = parsed.data;
  } catch (error) { if (error instanceof CoworkLifecycleError) throw error; return lifecycleFail("bundle_invalid"); }
  const files = new Map<string, BundleFileEntry>();
  let previous: string | null = null;
  for (const entry of integrity.files) {
    if (!validBundlePath(entry.path) || files.has(entry.path) || (previous !== null && comparePaths(previous, entry.path) >= 0)) return lifecycleFail("bundle_invalid");
    files.set(entry.path, entry); previous = entry.path;
  }
  // The index and the folder name exactly the same files.
  if (files.size !== actual.size || [...files.keys()].some(path => !actual.has(path))) return lifecycleFail("bundle_invalid");
  for (const [path, entry] of files) if (actual.get(path)!.bytes !== entry.bytes) return lifecycleFail("bundle_invalid");
  const manifestBytes = readBounded(join(root, "manifest.json"), EXPORT_MANIFEST_MAX_BYTES);
  if (sha256Hex(manifestBytes.toString("utf8")) !== integrity.manifestDigest || files.get("manifest.json")?.sha256 !== integrity.manifestDigest) return lifecycleFail("bundle_invalid");
  for (const [path, entry] of files) {
    const fd = openRegularFile(join(root, path), actual.get(path));
    try { if (await hashDescriptor(fd, entry.bytes, signal) !== entry.sha256) return lifecycleFail("bundle_invalid"); } finally { closeSync(fd); }
  }
  return { root, manifestText: manifestBytes.toString("utf8"), integrity, files };
}

// ---------------------------------------------------------------------------------------------------- small file helpers

export const lstatOrNull = (path: string) => { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } };
export function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** A NEW file (`wx`: create-exclusive, never truncating), mode 0600, fsynced. */
export function writeNewFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try { for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at); fsyncSync(fd); } finally { closeSync(fd); }
}
/** Create each missing directory of `relativeFile`'s parent chain under `root`, mode 0700; `made` remembers what exists. */
export function ensureDirectories(root: string, relativeFile: string, made: Set<string>): void {
  const parts = relativeFile.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join("/");
    if (made.has(rel)) continue;
    mkdirSync(join(root, rel), { mode: 0o700 }); made.add(rel);
  }
}
/**
 * Copy one regular file into a NEW file through a no-follow descriptor, hashing as it goes. Refuses (`generation_stale`) when the
 * source changed while it was read, or does not hold the expected number of bytes. Returns what was actually copied.
 */
export async function copyFileHashed(source: string, destination: string,
  expected: { readonly identity?: { readonly dev: bigint; readonly ino: bigint }; readonly bytes?: number; readonly signal?: AbortSignal } = {}): Promise<{ bytes: number; sha256: string }> {
  const fd = openRegularFile(source, expected.identity);
  let out = -1;
  try {
    out = openSync(destination, "wx", 0o600);
    const first = stampDescriptor(fd), hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (let blocks = 0;; blocks++) {
      if (expected.signal?.aborted) throw new ExportIoError("cancelled");
      const got = readSync(fd, buffer, 0, buffer.length, total);
      if (got === 0) break;
      hash.update(buffer.subarray(0, got)); for (let at = 0; at < got;) at += writeSync(out, buffer, at, got - at);
      total += got;
      if (blocks % 16 === 15) await new Promise<void>(resolve => setImmediate(resolve));
    }
    fsyncSync(out);
    if ((expected.bytes !== undefined && total !== expected.bytes) || stampDescriptor(fd) !== first) return lifecycleFail("generation_stale");
    return { bytes: total, sha256: hash.digest("hex") };
  } finally { closeSync(fd); if (out >= 0) closeSync(out); }
}
