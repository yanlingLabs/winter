// Code-mode image input (2026-09-29): `session.stageImage`'s file half. A composer image is written
// into the session's own temp directory — `sessionTmpDir(sessionId)/images/image_<k>.<ext>` — so the
// client can replace its `[Image #n]` placeholder with the absolute path and the model reads it.
//
// That directory is a sandbox WRITABLE root: the session's agent can create anything inside it,
// including an `images` symlink pointing anywhere. The daemon is unsandboxed, so every step below
// assumes the directory is hostile:
//   - the session directory and `images/` must be REAL directories (`lstat`, never followed);
//   - the file is created with O_CREAT|O_EXCL|O_NOFOLLOW (never over, or through, anything that
//     exists) and mode 0600;
//   - the bytes are written only AFTER the created file is proved to be the one at
//     `<realpath(session dir)>/images/<name>` (same inode as the descriptor), so a directory swapped
//     between the checks and the open costs at most one EMPTY new file elsewhere, which is unlinked.
// The bytes are never logged, and no refusal message carries any of them.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join, sep } from "node:path";
import {
  IMAGE_DATA_INVALID, IMAGE_STAGE_FAILED, IMAGE_TOO_LARGE, IMAGE_TOO_LARGE_MESSAGE, IMAGE_TYPE_MISMATCH, IMAGE_TYPE_UNSUPPORTED,
  STAGE_IMAGE_B64_MAX_LENGTH, STAGE_IMAGE_MAX_BYTES, STAGE_IMAGE_MAX_DIMENSION, type STAGE_IMAGE_MEDIA_TYPES,
} from "@yanlinglabs/winter-protocol";
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

const EXTENSION: Record<StageImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** The media type the MAGIC BYTES name, or `undefined` for anything outside the four allowed. */
export function sniffImageMediaType(bytes: Uint8Array): StageImageMediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return undefined;
}

/**
 * An image's pixel dimensions, read from its HEADER bytes only (nothing is decoded): PNG's IHDR,
 * GIF's logical screen, WebP's VP8/VP8L/VP8X header, JPEG's first SOF marker. `undefined` when the
 * header cannot be read — the caller then has no dimension to refuse on.
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
    throw new StageImageRefusal(IMAGE_TYPE_UNSUPPORTED, "Only PNG, JPEG, GIF and WebP images are supported");
  }
  if (sniffed !== mediaType) {
    throw new StageImageRefusal(IMAGE_TYPE_MISMATCH, `the image data is ${sniffed}, not the declared ${mediaType}`);
  }
  // The runtime Read tool refuses an image past 8000 px on either edge; so does staging, from the
  // header alone. (Clients downscale to 1568 px before they get here — this is the backstop.)
  const dims = imageDimensions(bytes);
  if (dims !== undefined && (dims.width > STAGE_IMAGE_MAX_DIMENSION || dims.height > STAGE_IMAGE_MAX_DIMENSION)) {
    throw new StageImageRefusal(IMAGE_TOO_LARGE, IMAGE_TOO_LARGE_MESSAGE);
  }
  return { bytes, ext: EXTENSION[sniffed] };
}

function requireRealDirectory(path: string): void {
  let st;
  try { st = lstatSync(path); } catch { throw new StageImageRefusal(IMAGE_STAGE_FAILED, "the session's temp directory is unavailable", true); }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new StageImageRefusal(IMAGE_STAGE_FAILED, "the session's temp directory is not a plain directory", true);
  }
}

const NAME_RE = /^image_(\d+)\.[a-z]+$/;

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
export function stageSessionImage(input: { sessionId: string; mediaType: StageImageMediaType; dataBase64: string }): string {
  const { bytes, ext } = validateStagedImage(input.mediaType, input.dataBase64);
  const sessionDir = sessionTmpDirPath(input.sessionId);
  try { mkdirSync(sessionDir, { recursive: true, mode: 0o700 }); } catch { /* lstat below reports it */ }
  requireRealDirectory(sessionDir);
  const root = realpathSync(sessionDir);
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
