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
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ExportIoError, hashDescriptor, listDirectoryAt, openAt, openDirectoryNoFollow, stampDescriptor } from "./export-io";
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

// ---------------------------------------------------------------------------------------------------- opaque output ids

/**
 * `shared/outputs/<sessionId>/…` would put session ids into a bundle whose manifest deliberately omits them. The bundle names
 * each session folder `s<16 random hex>` (minted per export, never derived from the session id, never reused) and each file
 * directly under `outputs/` `f/<name>`; the reverse table is kept in the database next to the content digest, never in the bundle.
 */
export const OPAQUE_OUTPUT_ID = /^s[0-9a-f]{16}$/;
export class OutputIdMapper {
  private readonly table = new Map<string, string>();
  private readonly used = new Set<string>();
  constructor(private readonly mint: () => string = () => `s${randomBytes(8).toString("hex")}`) {}
  /** `rest` is the path under `outputs/`. */
  toBundle(rest: string): string {
    const parts = rest.split("/");
    if (parts.length === 1) return `f/${parts[0]}`;
    let id = this.table.get(parts[0]!);
    if (id === undefined) {
      do { id = this.mint(); } while (this.used.has(id) || !OPAQUE_OUTPUT_ID.test(id));
      this.used.add(id); this.table.set(parts[0]!, id);
    }
    return [id, ...parts.slice(1)].join("/");
  }
  /** opaque id -> session id. */
  get reverse(): Record<string, string> { return Object.fromEntries([...this.table].map(([session, id]) => [id, session])); }
}
/** The path under `outputs/` a bundle path stands for, or null when it names an id the table does not hold. */
export function outputFromBundle(rest: string, reverse: Readonly<Record<string, string>>): string | null {
  const parts = rest.split("/");
  if (parts[0] === "f") return parts.length === 2 ? parts[1]! : null;
  const session = OPAQUE_OUTPUT_ID.test(parts[0]!) && Object.hasOwn(reverse, parts[0]!) ? reverse[parts[0]!] : undefined;
  return session === undefined || parts.length < 2 ? null : [session, ...parts.slice(1)].join("/");
}

// ---------------------------------------------------------------------------------------------------- safe tree walk (descriptor-relative)

export interface TreeFile { readonly path: string; readonly bytes: number; readonly dev: bigint; readonly ino: bigint }
export interface WalkBudget { files: number; bytes: number }
const unsafe = (): never => lifecycleFail("bundle_unsafe");
/** Open one child of a held directory without following a link; every refusal is `bundle_unsafe`. */
function child(directoryFd: number, name: string, flags: number): number {
  try { return openAt(directoryFd, name, flags | constants.O_NONBLOCK); } catch { return unsafe(); }
}
/**
 * Every regular file beneath a HELD directory, sorted bytewise, as paths relative to it. Each step is `openat` on a held
 * descriptor with no-follow, so swapping a path component for a link cannot redirect the walk. Symlinks, hard links (nlink
 * above 1), FIFOs, sockets and devices REFUSE the whole walk (`bundle_unsafe`): a guest-authored link in a shared folder is
 * never followed and never silently dropped. Empty directories are not recorded.
 */
export function walkRegularFilesAt(rootFd: number, limits: BundleLimits, budget: WalkBudget = { files: 0, bytes: 0 }): TreeFile[] {
  const out: TreeFile[] = [];
  const visit = (directoryFd: number, relative: string[], depth: number): void => {
    if (depth > limits.depth) unsafe();
    let names: string[];
    try { names = listDirectoryAt(directoryFd); } catch { return unsafe(); }
    for (const name of names) {
      if (!validBundleComponent(name)) unsafe();
      const fd = child(directoryFd, name, constants.O_RDONLY);
      try {
        const st = fstatSync(fd, { bigint: true });
        if (st.isDirectory()) { visit(fd, [...relative, name], depth + 1); continue; }
        if (!st.isFile() || st.nlink !== 1n) unsafe();
        budget.files++; budget.bytes += Number(st.size);
        if (budget.files > limits.files || budget.bytes > limits.sharedBytes) unsafe();
        out.push({ path: [...relative, name].join("/"), bytes: Number(st.size), dev: st.dev, ino: st.ino });
      } finally { closeSync(fd); }
    }
  };
  visit(rootFd, [], 0);
  return out.sort((a, b) => comparePaths(a.path, b.path));
}
/** Open a regular file by a relative path from a held directory, component by component, no-follow; confirm it is the file the walk saw. */
export function openRegularAt(rootFd: number, relative: string, expected?: { readonly dev: bigint; readonly ino: bigint }): number {
  const parts = relative.split("/");
  if (parts.length === 0 || !parts.every(validBundleComponent)) return unsafe();
  let current = rootFd, fd = -1;
  try {
    for (const part of parts.slice(0, -1)) { const next = child(current, part, constants.O_RDONLY | constants.O_DIRECTORY); if (current !== rootFd) closeSync(current); current = next; }
    fd = child(current, parts.at(-1)!, constants.O_RDONLY);
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || (expected && (st.dev !== expected.dev || st.ino !== expected.ino))) unsafe();
    return fd;
  } catch (error) { if (fd >= 0) closeSync(fd); throw error; }
  finally { if (current !== rootFd) closeSync(current); }
}
/** A held directory beneath `directoryFd`, no-follow; null when it is absent. A link, a file or anything else refuses. */
export function openSubdirectoryAt(directoryFd: number, name: string): number | null {
  try { return openAt(directoryFd, name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK); }
  catch (error) { if (error instanceof ExportIoError && error.errno === 2) return null; return unsafe(); }
}

// ---------------------------------------------------------------------------------------------------- verifying a bundle

export interface InspectedBundle {
  /** The realpath of the bundle folder, and a HELD descriptor of it: every later read is relative to this descriptor. */
  readonly root: string;
  readonly rootFd: number;
  readonly manifestText: string;
  readonly integrity: BundleIntegrity;
  /** sha256 of the exact bytes of integrity.json: what the database binds. */
  readonly integrityDigest: string;
  readonly files: ReadonlyMap<string, BundleFileEntry>;
  close(): void;
}
function readBounded(rootFd: number, relative: string, max: number): Buffer {
  const fd = openRegularAt(rootFd, relative);
  try {
    const size = Number(fstatSync(fd).size);
    if (size > max) return lifecycleFail("bundle_invalid");
    const out = Buffer.alloc(size);
    for (let at = 0; at < size;) { const got = readSync(fd, out, at, size - at, at); if (got <= 0) return lifecycleFail("bundle_invalid"); at += got; }
    return out;
  } finally { closeSync(fd); }
}
const statAt = (rootFd: number, name: string): BigIntStats => { const fd = child(rootFd, name, constants.O_RDONLY); try { return fstatSync(fd, { bigint: true }); } finally { closeSync(fd); } };

/**
 * Structure and index only: NOTHING is hashed here. A closed set of top-level names, only regular files, a canonical sorted
 * index of whitelisted paths naming exactly the files present, the manifest's bytes. The caller judges authority, the database
 * binding and the manifest's sizes BEFORE `hashBundleFiles` reads a byte of a (possibly multi-GiB) image.
 */
export function inspectBundle(presented: string, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): InspectedBundle {
  if (typeof presented !== "string" || !presented.endsWith(BUNDLE_SUFFIX) || !presented.startsWith("/") || presented.includes("\0")) return lifecycleFail("bundle_invalid");
  let root: string;
  try { if (lstatSync(presented).isSymbolicLink()) return lifecycleFail("bundle_unsafe"); root = realpathSync(presented); }
  catch (error) { if (error instanceof CoworkLifecycleError) throw error; return lifecycleFail("bundle_invalid"); }
  let rootFd: number;
  try { rootFd = openDirectoryNoFollow(root); } catch { return lifecycleFail("bundle_invalid"); }
  try {
    const top = listDirectoryAt(rootFd);
    const allowed = new Set(["manifest.json", "integrity.json", ...BUNDLE_IMAGE_FILES, "shared"]);
    if (top.some(name => !allowed.has(name)) || !["manifest.json", "integrity.json", ...BUNDLE_IMAGE_FILES].every(name => top.includes(name))) return lifecycleFail("bundle_invalid");
    const actual = new Map<string, TreeFile>();
    for (const name of ["manifest.json", ...BUNDLE_IMAGE_FILES]) {
      const st = statAt(rootFd, name);
      if (!st.isFile() || st.nlink !== 1n) return unsafe();
      actual.set(name, { path: name, bytes: Number(st.size), dev: st.dev, ino: st.ino });
    }
    if (top.includes("shared")) {
      const sharedFd = openSubdirectoryAt(rootFd, "shared");
      if (sharedFd === null) return unsafe();
      try {
        if (listDirectoryAt(sharedFd).some(name => !(BUNDLE_SHARED_ROOTS as readonly string[]).includes(name))) return lifecycleFail("bundle_invalid");
        const budget: WalkBudget = { files: 0, bytes: 0 };
        for (const name of BUNDLE_SHARED_ROOTS) {
          const dirFd = openSubdirectoryAt(sharedFd, name);
          if (dirFd === null) continue;
          try { for (const file of walkRegularFilesAt(dirFd, limits, budget)) actual.set(`shared/${name}/${file.path}`, { ...file, path: `shared/${name}/${file.path}` }); } finally { closeSync(dirFd); }
        }
      } finally { closeSync(sharedFd); }
    }
    const integrityBytes = readBounded(rootFd, "integrity.json", limits.integrityBytes), integrityText = integrityBytes.toString("utf8");
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
    // The index and the folder name exactly the same files, with the same sizes.
    if (files.size !== actual.size || [...files.keys()].some(path => !actual.has(path))) return lifecycleFail("bundle_invalid");
    for (const [path, entry] of files) if (actual.get(path)!.bytes !== entry.bytes) return lifecycleFail("bundle_invalid");
    const manifestBytes = readBounded(rootFd, "manifest.json", EXPORT_MANIFEST_MAX_BYTES);
    let open = true;
    return { root, rootFd, manifestText: manifestBytes.toString("utf8"), integrity, integrityDigest: sha256Hex(integrityText), files, close: () => { if (open) { open = false; closeSync(rootFd); } } };
  } catch (error) { closeSync(rootFd); throw error; }
}
/** Hash every file against the index and the manifest against its digest. Reads relative to the held root descriptor. */
export async function hashBundleFiles(bundle: InspectedBundle, signal?: AbortSignal): Promise<void> {
  if (sha256Hex(bundle.manifestText) !== bundle.integrity.manifestDigest || bundle.files.get("manifest.json")?.sha256 !== bundle.integrity.manifestDigest) return lifecycleFail("bundle_invalid");
  for (const [path, entry] of bundle.files) {
    const fd = openRegularAt(bundle.rootFd, path);
    try { if (await hashDescriptor(fd, entry.bytes, signal) !== entry.sha256) return lifecycleFail("bundle_invalid"); } finally { closeSync(fd); }
  }
}
/** Inspect then hash. The caller closes the result. */
export async function verifyBundle(presented: string, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS, signal?: AbortSignal): Promise<InspectedBundle> {
  const bundle = inspectBundle(presented, limits);
  try { await hashBundleFiles(bundle, signal); return bundle; } catch (error) { bundle.close(); throw error; }
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
 * Copy an OPEN regular file into a NEW file (`wx`, 0600), hashing as it goes. Refuses (`generation_stale`) when the source
 * changed while it was read or does not hold the expected number of bytes. Returns what was actually copied.
 */
export async function copyFdHashed(fd: number, destination: string, expected: { readonly bytes?: number; readonly signal?: AbortSignal } = {}): Promise<{ bytes: number; sha256: string }> {
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
  } finally { if (out >= 0) closeSync(out); }
}
