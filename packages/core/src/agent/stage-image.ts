// Image input for code (2026-09-29; raw image paths 2026-10-10) and dispatch (2026-10-19) sessions:
// `session.stageImage`'s file half, and its bounded cleanup (`pruneStagedImages`). An
// image with no file of its own (clipboard data) is written, AS IT IS, into the session's temp
// directory — `sessionTmpDir(sessionId)/images/image_<k>.<ext>`; the client names that path beside its
// `[Image #n]` placeholder on send, and the model reads it. Nothing here downscales or re-encodes: the
// runtime's Read tool prepares any image for the model itself. A dragged or picked FILE is never staged —
// the client names its own path, and `validateImageRefs` (bottom) accepts it as an ORIGINAL file.
//
// That directory is HOSTILE. It is a sandbox writable root, so the session's agent can create
// anything inside it (an `images` symlink pointing anywhere), and the sandboxed shell can also write
// direct children of the per-user temp dir — so it can REPLACE `winter-session-<sid>` itself with a
// symlink, at any moment. The daemon is unsandboxed, so:
//   - the session directory's own name is NEVER resolved: the root is `realpath(<its parent>)` joined
//     with its basename, and every later step goes through that name, so a swap of the directory
//     at any point is caught by the final check rather than silently followed;
//   - the session directory and `images/` must be REAL directories (`lstat`, never followed);
//   - the file is created with O_CREAT|O_EXCL|O_NOFOLLOW (never over, or through, anything that
//     exists as the final component) and mode 0600;
//   - the bytes are written only AFTER the created file is proved to be the one at
//     `<root>/images/<name>` — its realpath is exactly that path and it has the descriptor's inode.
// So a directory swapped between the checks and the open costs at most one EMPTY new file (and, if
// the swap landed before the `images/` mkdir, one empty `images` directory) inside a directory the
// agent could already write, and the file is unlinked; nothing is ever WRITTEN there.
// The bytes are never logged, and no refusal message carries any of them.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  IMAGE_DATA_INVALID, IMAGE_FILE_EXTENSIONS, IMAGE_FILE_MAX_BYTES, IMAGE_FILE_TOO_LARGE_MESSAGE, IMAGE_FILE_UNREADABLE, IMAGE_REFERENCE_INVALID, IMAGE_STAGE_FAILED, USER_MESSAGE_IMAGES_MAX, USER_MESSAGE_IMAGES_MAX_MESSAGE, type UserMessageImageRef, IMAGE_TOO_LARGE, IMAGE_TOO_LARGE_MESSAGE, IMAGE_TYPE_MISMATCH, IMAGE_TYPE_UNSUPPORTED,
  STAGE_IMAGE_B64_MAX_LENGTH, STAGE_IMAGE_MAX_BYTES, type STAGE_IMAGE_MEDIA_TYPES,
  FILE_REFERENCE_INVALID, FILE_UNREADABLE, USER_MESSAGE_FILES_MAX, USER_MESSAGE_FILES_MAX_MESSAGE, type UserMessageFileRef, type SessionEvent,
} from "@yanlinglabs/winter-protocol";
import { sandboxConfigFor } from "../runtime-sdk/mode-options";
import { protectedReadDenial } from "../runtime-sdk/protected-paths";
import { fileTokenNumbers, imageTokenNumbers } from "../sessions/model-text";
import { sessionTmpDirPath } from "./session-tmp";

export type StageImageMediaType = (typeof STAGE_IMAGE_MEDIA_TYPES)[number];

/** A typed `session.stageImage` refusal — `code` is the wire's `data.code`; `internal` marks a
 *  daemon-side failure (`ERR.INTERNAL`) rather than the caller's input (`ERR.INVALID_PARAMS`). */
export class StageImageRefusal extends Error {
  /** `n`: the `[Image #n]` a send-side refusal is about (`validateImageRefs`), carried in the wire error's
   *  `data.n` so a client can act on that one attachment (the Mac stages an unreadable file itself). */
  constructor(public readonly code: string, message: string, public readonly internal = false, public readonly n?: number) {
    super(message);
    this.name = "StageImageRefusal";
  }
}

// The extension decides how the runtime's Read tool treats the file, so each type gets the one Read
// maps back to its own media type (`IMAGE_MIME` in the agent runtime's `tools/impl/read.ts`).
const EXTENSION: Record<StageImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
};

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

// The `ftyp` brands the runtime reads as a HEIC (`sniffImageType` in the agent runtime's
// `tools/image-prep.ts`) — keep the two lists equal.
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"];

/** How many leading bytes `sniffImageMediaType` needs to name any type (HEIC's `ftyp` brand ends at 12). */
export const IMAGE_SNIFF_BYTES = 12;

/**
 * The media type the MAGIC BYTES name, or `undefined` for anything outside the seven the runtime's Read
 * tool can prepare. A port of the runtime's own `sniffImageType` (PNG, JPEG, GIF, WebP, BMP, TIFF,
 * HEIC), so the daemon and the Read tool can never disagree about what a file is.
 */
export function sniffImageMediaType(bytes: Uint8Array): StageImageMediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("BM"))) return "image/bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (bytes.length >= 12 && startsWith(bytes, ascii("ftyp"), 4)) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (HEIC_BRANDS.includes(brand)) return "image/heic";
  }
  return undefined;
}

/**
 * An image's pixel dimensions, read from its HEADER bytes only (nothing is decoded): PNG's IHDR,
 * GIF's logical screen, WebP's VP8/VP8L/VP8X header, JPEG's first SOF marker. `undefined` for any other
 * type, or when the header cannot be read. (The daemon no longer refuses on a size — the runtime's Read
 * tool scales an oversize image itself; clients use this to decide whether THEY must downscale.)
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const b = bytes;
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const type = sniffImageMediaType(b);
  if (type === "image/png") {
    if (b.length < 24 || !startsWith(b, ascii("IHDR"), 12)) return undefined;
    const u32 = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
    return { width: u32(16), height: u32(20) };
  }
  if (type === "image/gif") return b.length < 10 ? undefined : { width: u16le(6), height: u16le(8) };
  if (type === "image/webp") {
    if (b.length < 30) return undefined;
    if (startsWith(b, ascii("VP8X"), 12)) return { width: 1 + u24le(24), height: 1 + u24le(27) };
    if (startsWith(b, ascii("VP8L"), 12)) {
      return { width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) };
    }
    if (startsWith(b, ascii("VP8 "), 12)) return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    return undefined;
  }
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 3 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i += 1; continue; } // fill byte
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // no length
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return i + 8 < b.length ? { width: u16be(i + 7), height: u16be(i + 5) } : undefined;
      i += 2 + u16be(i + 2);
    }
    return undefined;
  }
  return undefined;
}

const IMAGE_TYPES_MESSAGE = "Only PNG, JPEG, GIF, WebP, HEIC, TIFF and BMP images are supported";

const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict standard base64 — `Buffer.from(s, "base64")` silently SKIPS characters it does not know,
 *  so the alphabet, the padding and the length are checked first. `undefined` on anything else. */
export function decodeStrictBase64(s: string): Uint8Array | undefined {
  if (s.length === 0 || s.length % 4 !== 0 || !STRICT_BASE64.test(s)) return undefined;
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Decode, check and sniff — every input refusal, before anything touches the disk. */
export function validateStagedImage(mediaType: StageImageMediaType, dataBase64: string): { bytes: Uint8Array; ext: string } {
  // Too long to be within the cap whatever it decodes to — refused from the length alone, so an
  // oversize image is never decoded at all.
  if (dataBase64.length > STAGE_IMAGE_B64_MAX_LENGTH) throw new StageImageRefusal(IMAGE_TOO_LARGE, IMAGE_TOO_LARGE_MESSAGE);
  const bytes = decodeStrictBase64(dataBase64);
  if (bytes === undefined || bytes.length === 0) {
    throw new StageImageRefusal(IMAGE_DATA_INVALID, "the image data is not valid base64");
  }
  if (bytes.length > STAGE_IMAGE_MAX_BYTES) {
    throw new StageImageRefusal(IMAGE_TOO_LARGE, IMAGE_TOO_LARGE_MESSAGE);
  }
  const sniffed = sniffImageMediaType(bytes);
  if (sniffed === undefined) {
    throw new StageImageRefusal(IMAGE_TYPE_UNSUPPORTED, IMAGE_TYPES_MESSAGE);
  }
  if (sniffed !== mediaType) {
    throw new StageImageRefusal(IMAGE_TYPE_MISMATCH, `the image data is ${sniffed}, not the declared ${mediaType}`);
  }
  // No pixel limit: the bytes are stored as they are, and the runtime's Read tool shrinks anything
  // over 1568 px (and refuses only a source declaring over 100 megapixels) when the model reads it.
  return { bytes, ext: EXTENSION[sniffed] };
}

/** The session directory as the daemon names it: the parent (the OS or `$WINTER_TMPDIR` temp dir) is
 *  resolved; the session directory's own name never is — see the module header. */
function sessionRootOf(sessionDir: string): string {
  try { return join(realpathSync(dirname(sessionDir)), basename(sessionDir)); } catch {
    throw new StageImageRefusal(IMAGE_STAGE_FAILED, "the session's temp directory is unavailable", true);
  }
}

function requireRealDirectory(path: string): void {
  let st;
  try { st = lstatSync(path); } catch { throw new StageImageRefusal(IMAGE_STAGE_FAILED, "the session's temp directory is unavailable", true); }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new StageImageRefusal(IMAGE_STAGE_FAILED, "the session's temp directory is not a plain directory", true);
  }
}

// At most 9 digits: a planted `image_9007199254740991.png` (or any index past what `k + 1` can still
// represent exactly) would otherwise pin `k` at a value that never increments, and every later
// stage would retry the same taken name until it gave up.
const NAME_RE = /^image_(\d{1,9})\.[a-z]+$/;

/** The next `k` after every `image_<k>.*` already in the folder — the O_EXCL open below is what
 *  actually guarantees "never overwrite"; this only keeps the numbers climbing. */
function nextIndex(dir: string): number {
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = NAME_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** How long a staged copy is kept (2026-10-19): `stageSessionImage` lets go of this session's staged copies
 *  older than this — by the file's own mtime, written once when it was staged — unless a message in the
 *  session's recent log still names it (`pruneStagedImages`). Nothing else ever removes the session's temp
 *  folder, and Dispatch is ONE session that lives for months: without this every pasted screenshot would stay
 *  on disk for as long as it does. Generous on purpose: a staged copy is the model's to read in its turn (or to
 *  move, to keep — `IMAGE_PATH_GUIDANCE`), and two weeks covers coming back to it. */
export const STAGED_IMAGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Every `images` path a `user_message` in `events` names — consumed or still owed, any thread. What
 *  `pruneStagedImages` keeps: a superset of the staged copies the session's unconsumed messages need (a resume
 *  re-pushes those with their paths, `unconsumedUserMessages`), with no turn pairing to get wrong. A staged ref is
 *  stored spelled as its realpath (`validateImageRefs`), the same spelling the prune lists, so the comparison is
 *  exact. */
export function stagedPathsNamedBy(events: readonly SessionEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type !== "user_message" || e.images === undefined) continue;
    for (const ref of e.images) out.add(ref.path);
  }
  return out;
}

/** `lstat` says `path` is still the same real directory (not a symlink) as `was`. */
function sameRealDirectory(path: string, was: { dev: number; ino: number }): boolean {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink() && st.isDirectory() && st.dev === was.dev && st.ino === was.ino;
  } catch {
    return false;
  }
}

/**
 * The bounded cleanup of a session's staged copies (2026-10-19, for Dispatch's one long-lived session; it runs for
 * every session that stages). Removes each `image_<k>.<ext>` REGULAR file directly in `imagesDir` whose mtime is
 * older than `STAGED_IMAGE_RETENTION_MS`, unless `keep()` names it — `keep` is read only when there is a candidate
 * (a bounded tail of the session's log, `stagedPathsNamedBy`), and a `keep` that throws removes nothing. Answers how
 * many it removed; NEVER throws (a stage is never refused over its cleanup) and never logs a path.
 *
 * `imagesDir` is HOSTILE (the module header): the daemon is unsandboxed and the session's agent can swap
 * `winter-session-<sid>` or `images/` for a symlink at any moment, which would aim an `unlink` at a same-named file
 * elsewhere. So, right before EACH unlink: both directories are re-`lstat`ed as the same real directories (dev +
 * inode) they were when listed, the candidate is re-`lstat`ed as the same regular file (dev + inode), and its
 * `realpath` is exactly `<imagesDir>/<name>`. A swap landing between those checks and the `unlink` itself — a few
 * system calls — is the residual (images.md); a symlink planted IN the folder is never followed (`lstat`, and
 * `unlink` removes a link, not its target).
 */
export function pruneStagedImages(
  root: string,
  imagesDir: string,
  keep: () => Iterable<string>,
  nowMs: number = Date.now(),
  /** TEST-ONLY: runs right before a candidate's re-checks — the window a swap would use. */
  hooks: { beforeUnlink?: (path: string) => void } = {},
): number {
  try {
    const rootSt = lstatSync(root);
    const dirSt = lstatSync(imagesDir);
    if (rootSt.isSymbolicLink() || !rootSt.isDirectory() || dirSt.isSymbolicLink() || !dirSt.isDirectory()) return 0;
    const cutoff = nowMs - STAGED_IMAGE_RETENTION_MS;
    const candidates: { path: string; dev: number; ino: number }[] = [];
    for (const name of readdirSync(imagesDir)) {
      if (!NAME_RE.test(name)) continue;
      const path = join(imagesDir, name);
      let st;
      try { st = lstatSync(path); } catch { continue; }
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      candidates.push({ path, dev: st.dev, ino: st.ino });
    }
    if (candidates.length === 0) return 0;
    let kept: Set<string>;
    try { kept = new Set(keep()); } catch { return 0; }
    let removed = 0;
    for (const c of candidates) {
      if (kept.has(c.path)) continue;
      hooks.beforeUnlink?.(c.path);
      // The folders moved: nothing more is removed this time.
      if (!sameRealDirectory(root, rootSt) || !sameRealDirectory(imagesDir, dirSt)) return removed;
      let st;
      try { st = lstatSync(c.path); } catch { continue; }
      if (!st.isFile() || st.dev !== c.dev || st.ino !== c.ino) continue;
      let real: string;
      try { real = realpathSync(c.path); } catch { continue; }
      if (real !== c.path) continue;
      try { unlinkSync(c.path); removed++; } catch { /* gone already, or not ours to remove */ }
    }
    return removed;
  } catch {
    return 0;
  }
}

/**
 * Stage one image for `sessionId` and return its realpath. Every input check runs first
 * (`validateStagedImage`); then the file is created safely (see the module header). The folder is
 * `sessionTmpDirPath(sessionId)` — `$WINTER_TMPDIR` or the OS temp dir, exactly `sessionTmpDir`'s.
 * With `keep`, the session's stale staged copies are let go of first (`pruneStagedImages`); the new file's
 * number is taken before that, so numbers keep climbing and a pruned name is never reused.
 */
export function stageSessionImage(
  input: { sessionId: string; mediaType: StageImageMediaType; dataBase64: string },
  opts: {
    /** The staged paths the session's recent messages still name — never pruned. Absent: nothing is pruned. */
    keep?: () => Iterable<string>;
    /** TEST-ONLY: the prune's clock. */
    nowMs?: number;
    /** TEST-ONLY: runs right after the session directory's own check — the window a swap of that
     *  directory for a symlink would use. */
    afterSessionDirCheck?: () => void;
  } = {},
): string {
  const { bytes, ext } = validateStagedImage(input.mediaType, input.dataBase64);
  const sessionDir = sessionTmpDirPath(input.sessionId);
  try { mkdirSync(sessionDir, { recursive: true, mode: 0o700 }); } catch { /* lstat below reports it */ }
  const root = sessionRootOf(sessionDir);
  requireRealDirectory(root);
  opts.afterSessionDirCheck?.();
  const imagesDir = join(root, "images");
  try { mkdirSync(imagesDir, { mode: 0o700 }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new StageImageRefusal(IMAGE_STAGE_FAILED, "could not create the session's image folder", true);
  }
  requireRealDirectory(imagesDir);

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let k = nextIndex(imagesDir);
  if (opts.keep !== undefined) pruneStagedImages(root, imagesDir, opts.keep, opts.nowMs);
  for (let attempt = 0; attempt < 1000; attempt++, k++) {
    const path = join(imagesDir, `image_${k}.${ext}`);
    let fd: number;
    try { fd = openSync(path, flags, 0o600); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new StageImageRefusal(IMAGE_STAGE_FAILED, "could not create the image file", true);
    }
    try {
      // Prove the descriptor is the file at `<root>/images/<name>` before a single byte is written.
      const opened = fstatSync(fd);
      let real: string;
      try { real = realpathSync(path); } catch { real = ""; }
      const here = real === "" ? undefined : (() => { try { return statSync(real); } catch { return undefined; } })();
      const inside = real.startsWith(imagesDir + sep) && real === path;
      if (!inside || here === undefined || here.ino !== opened.ino || here.dev !== opened.dev) {
        closeSync(fd);
        try { unlinkSync(path); } catch { /* best effort — it is empty */ }
        throw new StageImageRefusal(IMAGE_STAGE_FAILED, "the session's image folder changed while the image was being saved", true);
      }
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
      closeSync(fd);
      return real;
    } catch (err) {
      if (err instanceof StageImageRefusal) throw err;
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(path); } catch { /* best effort */ }
      throw new StageImageRefusal(IMAGE_STAGE_FAILED, "could not write the image file", true);
    }
  }
  throw new StageImageRefusal(IMAGE_STAGE_FAILED, "could not pick a free image file name", true);
}

/** What `validateImageRefs` needs to know beyond the session. */
export interface ImageRefContext {
  /** The daemon's `<WINTER_HOME>`, which locates the paths the runtime's Read tool is itself denied
   *  (`readDeniedByRuntime`). Absent (a server built without one — most tests): that rule cannot be
   *  applied and is skipped. */
  winterHome?: string | undefined;
}

/** `home` and, when it differs, its realpath — the spellings a path under it can arrive in. */
function homeSpellings(home: string): string[] {
  const out = new Set<string>([resolve(home)]);
  try { out.add(realpathSync(home)); } catch { /* a home that does not exist yet has only its spelling */ }
  return [...out];
}

/**
 * Whether the runtime's own Read tool refuses `path` — the read-DENY set, reused from where it is defined
 * rather than listed again: the Bash sandbox's literal `denyRead` (`sandboxConfigFor`: `<home>/run`,
 * `<home>/runtimes`, `sdk/.winter.json`) and the path-fence hook's read row (`protectedReadDenial`: a run
 * folder's or a `claude-resume-*` staging root's generated `.winter.json` / `.claude.json` /
 * `.credentials.json` and their `backups/**`, and `sdk/.winter.json` again). Nothing else under the home is
 * refused: `<home>/outputs/<session>/…`, the agent's own outbox, is an ordinary place to drag an image from.
 * Compared case-folded, like the hook, and for every spelling of the home.
 */
function readDeniedByRuntime(path: string, home: string): boolean {
  const lower = path.toLowerCase();
  for (const h of homeSpellings(home)) {
    if (protectedReadDenial("Read", { file_path: path }, { home: h }) !== undefined) return true;
    for (const denied of sandboxConfigFor(h).filesystem?.denyRead ?? []) {
      const d = resolve(denied).toLowerCase();
      if (lower === d || lower.startsWith(`${d}/`)) return true;
    }
  }
  return false;
}

/** Characters no original path may carry: C0 controls, DEL and the C1 controls, the line/paragraph
 *  separators, the directional marks and the bidi embedding/override/isolate controls (U+200E/200F,
 *  U+202A–202E, U+2066–2069) — the set the elicitation cards already refuse to show (`url-elicitation.ts`'s
 *  `BIDI_CONTROLS`, here refused rather than stripped, since a stripped path names a different file). */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const FILE_EXTENSIONS: ReadonlySet<string> = new Set(IMAGE_FILE_EXTENSIONS);

/**
 * The ORIGINAL-file half of `validateImageRefs`: the user's own image file, named by its absolute path.
 * Never copied, never rewritten — the path is stored and handed to the model as the client spelled it.
 *
 * The path as SPELLED must be absolute, free of control and direction-changing characters (and of leading or
 * trailing whitespace, which Read trims off the path the model types) and end in an extension the runtime's
 * Read tool opens as an image (`IMAGE_FILE_EXTENSIONS`): Read dispatches on `extname(resolve(path))`, never on
 * content, so `shot.dng` or a name with no extension would reach the model as binary text. The extension is
 * judged AS SPELLED — a symlink `link.png → x.dng` is fine, `a.dng → real.png` is not, because Read does not
 * follow the link to pick the reader. Its `realpath` (a symlink is fine — the TARGET is judged) is then a
 * REGULAR file that the Read tool itself may read (not in its read-deny set, `readDeniedByRuntime` — the path
 * as spelled AND the resolved one), whose first bytes are an image type the Read tool can prepare, and that
 * weighs at most `IMAGE_FILE_MAX_BYTES`. Only a dozen header bytes are read — never the file — and the
 * descriptor is the one that is `fstat`ed, so a file swapped for a FIFO or a link after the resolve is refused
 * rather than followed or waited on. A file that cannot be resolved, opened or read at all is
 * `image_file_unreadable` (carrying `n`). Every refusal names the placeholder, never the path.
 */
function checkOriginalImage(ref: UserMessageImageRef, home: string | undefined): void {
  const invalid = (why: string): never => { throw new StageImageRefusal(IMAGE_REFERENCE_INVALID, `[Image #${ref.n}] ${why}`, false, ref.n); };
  const unreadable = (): never => {
    throw new StageImageRefusal(
      IMAGE_FILE_UNREADABLE,
      `[Image #${ref.n}] could not be read — it may have moved, or macOS may be keeping its folder from Winter (System Settings ▸ Privacy & Security ▸ Files & Folders)`,
      false, ref.n,
    );
  };
  if (!isAbsolute(ref.path)) invalid("is not an absolute path to an image file");
  if (UNSAFE_PATH_CHARS.test(ref.path)) invalid("has a path with control or direction-changing characters");
  if (ref.path !== ref.path.trim()) invalid("has a path with leading or trailing whitespace, which the Read tool trims away");
  const spelled = resolve(ref.path);
  if (!FILE_EXTENSIONS.has(extname(spelled).toLowerCase())) {
    throw new StageImageRefusal(
      IMAGE_TYPE_UNSUPPORTED,
      `[Image #${ref.n}] must end in ${IMAGE_FILE_EXTENSIONS.join(", ")} for the Read tool to open it as an image — copy or convert it first`,
      false, ref.n,
    );
  }
  const denied = "is one of Winter's own run, runtime or configuration files, which sessions cannot read";
  if (home !== undefined && readDeniedByRuntime(spelled, home)) invalid(denied);
  let real: string;
  try { real = realpathSync(ref.path); } catch { return unreadable(); }
  if (home !== undefined && readDeniedByRuntime(real, home)) invalid(denied);
  let fd: number;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); } catch { return unreadable(); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) invalid("is not a regular image file");
    const header = Buffer.alloc(IMAGE_SNIFF_BYTES);
    let filled = 0;
    try {
      while (filled < header.length) {
        const n = readSync(fd, header, filled, header.length - filled, filled);
        if (n === 0) break;
        filled += n;
      }
    } catch { unreadable(); }
    if (sniffImageMediaType(header.subarray(0, filled)) === undefined) {
      throw new StageImageRefusal(IMAGE_TYPE_UNSUPPORTED, `[Image #${ref.n}] is not an image: ${IMAGE_TYPES_MESSAGE}`, false, ref.n);
    }
    if (st.size > IMAGE_FILE_MAX_BYTES) throw new StageImageRefusal(IMAGE_TOO_LARGE, IMAGE_FILE_TOO_LARGE_MESSAGE, false, ref.n);
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * `session.send`/`session.steer`'s `images` check — every entry, before anything is appended. Each `path`
 * is one of two things, told apart by its SHAPE alone:
 *   - a STAGED image: directly inside THIS session's `<root>/images/` and named `image_<k>.<ext>` — held to
 *     the strict rules `stageSessionImage` writes by (a regular file, never a symlink, `lstat`; the root
 *     derived exactly as staging derives it, both directories real; spelled as its own realpath). A
 *     path of that shape that fails them is refused, never re-judged as an original;
 *   - anything else: the user's ORIGINAL file (`checkOriginalImage`).
 * Each `n` is unique and its `[Image #n]` appears in `text`; at most `USER_MESSAGE_IMAGES_MAX` entries.
 * Answers the refs to store (`undefined` for none — an empty array is "no images"), or throws a
 * `StageImageRefusal` whose message never echoes a path.
 */
export function validateImageRefs(
  sessionId: string,
  text: string,
  images: readonly UserMessageImageRef[] | undefined,
  ctx: ImageRefContext = {},
): UserMessageImageRef[] | undefined {
  if (images === undefined || images.length === 0) return undefined;
  const refuse = (why: string): never => { throw new StageImageRefusal(IMAGE_REFERENCE_INVALID, why); };
  if (images.length > USER_MESSAGE_IMAGES_MAX) refuse(USER_MESSAGE_IMAGES_MAX_MESSAGE);
  const inText = new Set(imageTokenNumbers(text));
  const seen = new Set<number>();
  for (const ref of images) {
    if (seen.has(ref.n)) refuse(`[Image #${ref.n}] is named more than once`);
    seen.add(ref.n);
    if (!inText.has(ref.n)) refuse(`[Image #${ref.n}] does not appear in the message`);
  }
  // Where a staged image would live — computed WITHOUT requiring the folder to exist (a draft of only
  // original files has no `images/` yet); the folder is checked only when a ref actually names it.
  let stagedRoot: string | undefined;
  try { stagedRoot = sessionRootOf(sessionTmpDirPath(sessionId)); } catch { stagedRoot = undefined; }
  const stagedDir = stagedRoot === undefined ? undefined : join(stagedRoot, "images");
  let stagedDirsChecked = false;
  for (const ref of images) {
    const staged = stagedDir !== undefined && dirname(ref.path) === stagedDir && NAME_RE.test(basename(ref.path));
    if (!staged) { checkOriginalImage(ref, ctx.winterHome === "" ? undefined : ctx.winterHome); continue; }
    const notStaged = `[Image #${ref.n}] is not an image staged for this session`;
    if (!stagedDirsChecked) {
      try {
        requireRealDirectory(stagedRoot!);
        requireRealDirectory(stagedDir!);
      } catch {
        return refuse("this session has no staged images");
      }
      stagedDirsChecked = true;
    }
    let st;
    try { st = lstatSync(ref.path); } catch { return refuse(notStaged); }
    if (st.isSymbolicLink() || !st.isFile()) refuse(notStaged);
    let real: string;
    try { real = realpathSync(ref.path); } catch { return refuse(notStaged); }
    if (real !== ref.path) refuse(notStaged);
  }
  return images.map((i) => ({ n: i.n, path: i.path }));
}

/**
 * `session.send`/`session.steer`'s `files` check (code-mode file attachments, 2026-10-13) — every entry,
 * before anything is appended. A `[File #n]` names the user's OWN file or folder, of any type, by its absolute
 * path; the model is given the path and reads it with its own tools, so the daemon reads nothing here — it
 * only proves the path is one the model could be meant to see:
 *   - as SPELLED: absolute, free of control and direction-changing characters (`UNSAFE_PATH_CHARS`) and of
 *     leading or trailing whitespace — refused, never stripped (a stripped path names a different file);
 *   - not in the runtime Read tool's read-deny set (`readDeniedByRuntime`), as spelled AND resolved;
 *   - its `realpath` resolves (else `file_unreadable`, carrying `n`) to a regular file or a directory —
 *     `stat`, never `open`, so a FIFO or socket is refused without ever being waited on.
 * Each `n` is unique and its `[File #n]` appears in `text`; at most `USER_MESSAGE_FILES_MAX` entries. Answers
 * the refs to store, as spelled (`undefined` for none), or throws a `StageImageRefusal` whose message names
 * the placeholder, never the path.
 */
export function validateFileRefs(
  text: string,
  files: readonly UserMessageFileRef[] | undefined,
  ctx: ImageRefContext = {},
): UserMessageFileRef[] | undefined {
  if (files === undefined || files.length === 0) return undefined;
  const home = ctx.winterHome === "" ? undefined : ctx.winterHome;
  const refuse = (why: string, n?: number): never => { throw new StageImageRefusal(FILE_REFERENCE_INVALID, why, false, n); };
  if (files.length > USER_MESSAGE_FILES_MAX) refuse(USER_MESSAGE_FILES_MAX_MESSAGE);
  const inText = new Set(fileTokenNumbers(text));
  const seen = new Set<number>();
  for (const ref of files) {
    if (seen.has(ref.n)) refuse(`[File #${ref.n}] is named more than once`, ref.n);
    seen.add(ref.n);
    if (!inText.has(ref.n)) refuse(`[File #${ref.n}] does not appear in the message`, ref.n);
  }
  const denied = "is one of Winter's own run, runtime or configuration files, which sessions cannot read";
  for (const ref of files) {
    const invalid = (why: string): never => refuse(`[File #${ref.n}] ${why}`, ref.n);
    if (!isAbsolute(ref.path)) invalid("is not an absolute path");
    if (UNSAFE_PATH_CHARS.test(ref.path)) invalid("has a path with control or direction-changing characters");
    if (ref.path !== ref.path.trim()) invalid("has a path with leading or trailing whitespace");
    const spelled = resolve(ref.path);
    if (home !== undefined && readDeniedByRuntime(spelled, home)) invalid(denied);
    let real: string;
    try { real = realpathSync(ref.path); } catch {
      throw new StageImageRefusal(
        FILE_UNREADABLE,
        `[File #${ref.n}] could not be found — it may have moved, or macOS may be keeping its folder from Winter (System Settings ▸ Privacy & Security ▸ Files & Folders)`,
        false, ref.n,
      );
    }
    if (home !== undefined && readDeniedByRuntime(real, home)) invalid(denied);
    let st;
    try { st = statSync(real); } catch { return invalid("could not be checked"); }
    if (!st.isFile() && !st.isDirectory()) invalid("is neither a file nor a folder");
  }
  return files.map((f) => ({ n: f.n, path: f.path }));
}
