// Code-mode image input (2026-09-29; raw image paths 2026-10-10): `session.stageImage`'s file half. An
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
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  IMAGE_DATA_INVALID, IMAGE_FILE_MAX_BYTES, IMAGE_FILE_TOO_LARGE_MESSAGE, IMAGE_REFERENCE_INVALID, IMAGE_STAGE_FAILED, USER_MESSAGE_IMAGES_MAX, USER_MESSAGE_IMAGES_MAX_MESSAGE, type UserMessageImageRef, IMAGE_TOO_LARGE, IMAGE_TOO_LARGE_MESSAGE, IMAGE_TYPE_MISMATCH, IMAGE_TYPE_UNSUPPORTED,
  STAGE_IMAGE_B64_MAX_LENGTH, STAGE_IMAGE_MAX_BYTES, type STAGE_IMAGE_MEDIA_TYPES,
} from "@yanlinglabs/winter-protocol";
import { imageTokenNumbers } from "../sessions/model-text";
import { sessionTmpDirPath } from "./session-tmp";

export type StageImageMediaType = (typeof STAGE_IMAGE_MEDIA_TYPES)[number];

/** A typed `session.stageImage` refusal — `code` is the wire's `data.code`; `internal` marks a
 *  daemon-side failure (`ERR.INTERNAL`) rather than the caller's input (`ERR.INVALID_PARAMS`). */
export class StageImageRefusal extends Error {
  constructor(public readonly code: string, message: string, public readonly internal = false) {
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

/**
 * Stage one image for `sessionId` and return its realpath. Every input check runs first
 * (`validateStagedImage`); then the file is created safely (see the module header). The folder is
 * `sessionTmpDirPath(sessionId)` — `$WINTER_TMPDIR` or the OS temp dir, exactly `sessionTmpDir`'s.
 */
export function stageSessionImage(
  input: { sessionId: string; mediaType: StageImageMediaType; dataBase64: string },
  /** TEST-ONLY: runs right after the session directory's own check — the window a swap of that
   *  directory for a symlink would use. */
  hooks: { afterSessionDirCheck?: () => void } = {},
): string {
  const { bytes, ext } = validateStagedImage(input.mediaType, input.dataBase64);
  const sessionDir = sessionTmpDirPath(input.sessionId);
  try { mkdirSync(sessionDir, { recursive: true, mode: 0o700 }); } catch { /* lstat below reports it */ }
  const root = sessionRootOf(sessionDir);
  requireRealDirectory(root);
  hooks.afterSessionDirCheck?.();
  const imagesDir = join(root, "images");
  try { mkdirSync(imagesDir, { mode: 0o700 }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new StageImageRefusal(IMAGE_STAGE_FAILED, "could not create the session's image folder", true);
  }
  requireRealDirectory(imagesDir);

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let k = nextIndex(imagesDir);
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
  /** The daemon's `<WINTER_HOME>`: no original image may live under it (its `run/` and `runtimes/`
   *  are read-denied to the agent, and the rest is the daemon's own state). Absent (a server built
   *  without one — most tests): the home rule cannot be applied and is skipped. */
  winterHome?: string | undefined;
}

/** `home` and its realpath (when it resolves), each as a prefix an original file must not sit under. */
function homePrefixes(home: string | undefined): string[] {
  if (home === undefined || home === "") return [];
  const out = new Set<string>([resolve(home)]);
  try { out.add(realpathSync(home)); } catch { /* a home that does not exist yet has only its spelling */ }
  return [...out];
}

const underPrefix = (path: string, prefix: string): boolean => path === prefix || path.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);

/**
 * The ORIGINAL-file half of `validateImageRefs`: the user's own image file, named by its absolute path.
 * Never copied, never rewritten — the path is stored and handed to the model as the client spelled it.
 * It must be an absolute path whose `realpath` (a symlink is fine — the TARGET is judged) is a REGULAR
 * file, outside the daemon's home (the path as spelled AND the resolved one), whose first bytes are an
 * image type the runtime's Read tool can prepare, and that weighs at most `IMAGE_FILE_MAX_BYTES`. Only a
 * dozen header bytes are read — never the file — and the descriptor is the one that is `fstat`ed, so a
 * file swapped for a FIFO or a link after the resolve is refused rather than followed or waited on.
 * Every refusal names the placeholder, never the path.
 */
function checkOriginalImage(ref: UserMessageImageRef, prefixes: readonly string[]): void {
  const invalid = (why: string): never => { throw new StageImageRefusal(IMAGE_REFERENCE_INVALID, `[Image #${ref.n}] ${why}`); };
  if (!isAbsolute(ref.path) || ref.path.includes("\0")) invalid("is not an absolute path to an image file");
  const spelled = resolve(ref.path);
  if (prefixes.some((p) => underPrefix(spelled, p))) invalid("is inside Winter's own data folder, which sessions cannot read — copy it somewhere else first");
  let real: string;
  try { real = realpathSync(ref.path); } catch { return invalid("is not an image file that exists"); }
  if (prefixes.some((p) => underPrefix(real, p))) invalid("is inside Winter's own data folder, which sessions cannot read — copy it somewhere else first");
  let fd: number;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); } catch { return invalid("is not an image file that can be read"); }
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
    } catch { invalid("is not an image file that can be read"); }
    if (sniffImageMediaType(header.subarray(0, filled)) === undefined) {
      throw new StageImageRefusal(IMAGE_TYPE_UNSUPPORTED, `[Image #${ref.n}] is not an image: ${IMAGE_TYPES_MESSAGE}`);
    }
    if (st.size > IMAGE_FILE_MAX_BYTES) throw new StageImageRefusal(IMAGE_TOO_LARGE, IMAGE_FILE_TOO_LARGE_MESSAGE);
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
  const prefixes = homePrefixes(ctx.winterHome);
  for (const ref of images) {
    const staged = stagedDir !== undefined && dirname(ref.path) === stagedDir && NAME_RE.test(basename(ref.path));
    if (!staged) { checkOriginalImage(ref, prefixes); continue; }
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
