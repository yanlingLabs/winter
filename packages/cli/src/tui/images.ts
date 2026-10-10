/** Code-mode image input (2026-09-29; raw image paths 2026-10-10) — the TUI half.
 *
 *  An image enters the draft as the plain-text placeholder `[Image #n]` (n counts per draft from 1
 *  and never repeats within one), from ctrl+v with an image on the clipboard or from a pasted /
 *  dropped path to an image file. Two kinds of attachment, neither of them ever resized or copied by
 *  default:
 *    - a FILE (a pasted or dragged path, a file copied in Finder): the ORIGINAL file's absolute path.
 *      Nothing is staged; the path itself goes in `images`, and the daemon checks it (a regular image
 *      file, at most 64 MiB, outside its home). The runtime's Read tool prepares the file for the model.
 *    - DATA with no file (a clipboard image): the RAW bytes, written by `session.stageImage` into the
 *      session's temp directory at submit. Only an image whose bytes cannot fit one request line is
 *      downscaled (`prepareDraftImage`), and only that one.
 *  The text goes out WITH its placeholders — the user's message shows `[Image #n]` — and `images` names
 *  each one's path; the daemon gives the MODEL the text with the paths in place. A daemon that
 *  predates that (a stage result without `imagesOnSend`) is sent the paths substituted into the text,
 *  as before. A placeholder the user deleted is simply not sent.
 *
 *  Pure helpers first; the clipboard reader (osascript) last, injectable so no test ever touches the
 *  user's real clipboard. */

import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  IMAGE_ATTACH_MAX_LONG_EDGE, IMAGE_FILE_MAX_BYTES, IMAGE_FILE_TOO_LARGE_MESSAGE, IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_TOO_LARGE_MESSAGE,
  STAGE_IMAGE_MAX_BYTES, USER_MESSAGE_IMAGES_MAX, USER_MESSAGE_IMAGES_MAX_MESSAGE,
} from "@yanlinglabs/winter-protocol";
import { IMAGE_SNIFF_BYTES, imageDimensions, imageTokenNumbers, sniffImageMediaType, substituteImageTokens } from "@yanlinglabs/winter-core";
import type { UserMessageImageRef } from "@yanlinglabs/winter-protocol";

// Shown when an image cannot be attached: DATA over what one request line carries even after the
// downscale (`image_too_large`), or a FILE over the runtime Read tool's 64 MiB — the daemon's refusals
// say the same, word for word.
export { IMAGE_FILE_TOO_LARGE_MESSAGE, IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_TOO_LARGE_MESSAGE };

/** One attachment: the user's own FILE (its absolute path is what the model is given), or image DATA
 *  that has no file (staged raw at submit). */
export type DraftImage =
  | { kind: "file"; path: string }
  | { kind: "data"; bytes: Uint8Array; mediaType: string };

export const imageToken = (n: number): string => `[Image #${n}]`;

/** The placeholder numbers `text` still contains, first-appearance order, each once — the daemon's
 *  own token grammar (`imageTokenNumbers`, core), so the TUI and the daemon's check never disagree. */
export const referencedImageNumbers = imageTokenNumbers;
/** Every placeholder whose number `paths` knows is replaced by that path; any other is left as typed. */
export { substituteImageTokens };

/** One draft's attachments. Numbers climb for the draft's whole life — a deleted placeholder's
 *  number is never reused, so an undo that brings it back still finds its image. */
export class DraftImages {
  private images = new Map<number, DraftImage>();
  private next = 1;

  /** Adds an image and answers its number. `draftText` is the draft as it stands: the number always
   *  lands past every `[Image #n]` already written in it — a placeholder recalled from history (↑)
   *  after the counter restarted must never bind to a DIFFERENT, newly attached image. */
  add(image: DraftImage, draftText = ""): number {
    const present = referencedImageNumbers(draftText);
    const floor = present.length === 0 ? 0 : Math.max(...present);
    const n = Math.max(this.next, floor + 1);
    this.next = n + 1;
    this.images.set(n, image);
    return n;
  }

  get(n: number): DraftImage | undefined { return this.images.get(n); }

  /** Whether `text` references any attachment this draft holds — the fast path's gate. */
  referencedIn(text: string): number[] {
    return referencedImageNumbers(text).filter((n) => this.images.has(n));
  }

  /** The number the NEXT attachment will get — taken when a submit starts staging, so its success
   *  drops only what that draft could have referenced (`clearBefore`), never an image attached to
   *  the next draft while the staging was still in flight. */
  mark(): number { return this.next; }

  /** A sent draft's attachments go with it (every number below `mark`); once none is left the next
   *  draft starts again at #1. */
  clearBefore(mark: number): void {
    for (const n of [...this.images.keys()]) if (n < mark) this.images.delete(n);
    if (this.images.size === 0) this.next = 1;
  }

  /** The attachments `text` references, as they are now — taken before a send clears them, so a send
   *  the daemon then REFUSES can hand them back (`restore`) with the draft. */
  snapshot(text: string): Array<[number, DraftImage]> {
    return this.referencedIn(text).map((n) => [n, this.images.get(n)!]);
  }

  /** Puts a refused draft's attachments back under their own numbers (the placeholders in the text
   *  handed back to the composer still name them). A number the draft has since reused is left alone;
   *  the counter stays past every restored number. */
  restore(entries: ReadonlyArray<[number, DraftImage]>): void {
    for (const [n, image] of entries) {
      if (!this.images.has(n)) this.images.set(n, image);
      this.next = Math.max(this.next, n + 1);
    }
  }
}

/** `session.stageImage`'s answer: the staged path, and whether this daemon takes `images` on
 *  `session.send`/`session.steer` (absent on a daemon that predates it). */
export interface StagedImage {
  path: string;
  imagesOnSend?: boolean;
}

/** A draft after staging: `text` as written (placeholders kept), `images` naming each staged
 *  placeholder's path, `modelText` with the paths substituted (what a daemon without
 *  `imagesOnSend`, or a child agent's `thread.send`, is sent), and whether EVERY stage answered
 *  `imagesOnSend`. */
export interface StagedDraft {
  text: string;
  images: UserMessageImageRef[];
  modelText: string;
  imagesOnSend: boolean;
}

/**
 * Resolve every attachment `text` still references into the path the model is given, in order: a FILE
 * is its own path (nothing is staged); DATA is staged raw (`stage` is `session.stageImage`). The first
 * refusal rejects with the daemon's own error, and nothing is sent by the caller. A draft referencing
 * more than `USER_MESSAGE_IMAGES_MAX` images is refused before anything is staged — the daemon would
 * refuse the send anyway, after the files were written. `imagesOnSend` says whether the daemon takes
 * `images`: false only when a stage answer said it does not (a draft of files alone stages nothing and
 * so cannot ask — it assumes a daemon that, being able to take an original path at all, takes `images`).
 */
export async function stageDraftImages(
  text: string,
  images: DraftImages,
  stage: (image: Extract<DraftImage, { kind: "data" }>) => Promise<StagedImage>,
): Promise<StagedDraft> {
  const refs: UserMessageImageRef[] = [];
  let imagesOnSend = true;
  const referenced = images.referencedIn(text);
  if (referenced.length > USER_MESSAGE_IMAGES_MAX) throw new Error(USER_MESSAGE_IMAGES_MAX_MESSAGE);
  for (const n of referenced) {
    const image = images.get(n)!;
    if (image.kind === "file") { refs.push({ n, path: image.path }); continue; }
    const staged = await stage(image);
    refs.push({ n, path: staged.path });
    if (staged.imagesOnSend !== true) imagesOnSend = false;
  }
  const modelText = substituteImageTokens(text, new Map(refs.map((r) => [r.n, r.path])));
  return { text, images: refs, modelText, imagesOnSend };
}

// The extensions the runtime Read tool maps to an image (`IMAGE_MIME` in its `tools/impl/read.ts`).
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;

/**
 * A pasted or dropped string that names ONE image file by path — Terminal/iTerm drag a file in as its
 * shell-escaped path (`/Users/me/My\ Shot.png`), some apps quote it, some hand a `file://` URL.
 * Only the SYNTAX is checked here (absolute, or `~/`, with an image extension); the caller checks the
 * file. `undefined` for anything else — which then pastes as ordinary text.
 */
export function imagePathFromPaste(input: string): string | undefined {
  let s = input.trim();
  if (s.length < 2 || /[\r\n]/.test(s)) return undefined;
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1);
  } else {
    s = s.replace(/\\(.)/g, "$1");
  }
  if (s.startsWith("file://")) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch { return undefined; }
  }
  if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
  if (!isAbsolute(s) || !IMAGE_EXT.test(s)) return undefined;
  return s;
}

export function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Only the magic bytes: is this one of the seven image types the runtime's Read tool prepares? */
export function isStageableImage(bytes: Uint8Array): boolean {
  return sniffImageMediaType(bytes) !== undefined;
}

/** What `inspectImageFile` found. */
export type ImageFileCheck = "ok" | "not-image" | "too-large";

/**
 * Whether `path` is an image file the daemon will take as it is: a regular file (a symlink is followed —
 * the daemon judges the target too), an image by its first bytes (never its name), at most
 * `IMAGE_FILE_MAX_BYTES`. Reads only `IMAGE_SNIFF_BYTES` bytes — never the file. Anything unreadable is
 * `"not-image"`, so the caller falls back to typing the pasted text as it always did.
 */
export function inspectImageFile(path: string): ImageFileCheck {
  let fd: number | undefined;
  try {
    const st = statSync(path);
    if (!st.isFile()) return "not-image";
    fd = openSync(path, "r");
    const header = Buffer.alloc(IMAGE_SNIFF_BYTES);
    const n = readSync(fd, header, 0, header.length, 0);
    if (sniffImageMediaType(header.subarray(0, n)) === undefined) return "not-image";
    return st.size > IMAGE_FILE_MAX_BYTES ? "too-large" : "ok";
  } catch {
    return "not-image";
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

const EXT_FOR: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "image/tiff": "tiff", "image/bmp": "bmp",
};
const JPEG_QUALITIES = [85, 75, 65, 50];

/**
 * Image DATA (a clipboard image — it has no file of its own) as a draft attachment, decided ONCE, at
 * attach time. The bytes stay exactly as they are — no downscale, no re-encode — whenever they fit one
 * request line (`STAGE_IMAGE_MAX_BYTES`): the runtime's Read tool prepares the image for the model
 * itself. Only an image that does NOT fit is downscaled, so that one image can be sent at all: the
 * bytes go to a PRIVATE temp copy (never the user's own file) and are `sips -Z 1568`-ed there, keeping
 * PNG as PNG and JPEG as JPEG (anything else becomes a PNG of its first frame); if the result still
 * does not fit it is re-encoded as JPEG, quality stepping 85 → 50. Only when that fails too is it
 * `"too-large"`. `"not-image"` when the magic bytes are none of the seven the Read tool prepares.
 */
export async function prepareDraftImage(bytes: Uint8Array): Promise<Extract<DraftImage, { kind: "data" }> | "not-image" | "too-large"> {
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) return "not-image";
  if (bytes.length <= STAGE_IMAGE_MAX_BYTES) return { kind: "data", bytes, mediaType };
  // Over the request budget: the existing downscale, for this one image.
  if (process.platform !== "darwin") return "too-large";
  const dims = imageDimensions(bytes);
  const longEdge = dims === undefined ? undefined : Math.max(dims.width, dims.height);
  const needsResize = longEdge === undefined || longEdge > IMAGE_ATTACH_MAX_LONG_EDGE;

  const dir = mkdtempSync(join(tmpdir(), "winter-attach-"));
  try {
    const source = join(dir, `source.${EXT_FOR[mediaType]}`);
    writeFileSync(source, bytes, { mode: 0o600 });
    const asJpeg = mediaType === "image/jpeg";
    const resized = join(dir, asJpeg ? "resized.jpg" : "resized.png");
    const args = ["-s", "format", asJpeg ? "jpeg" : "png", ...(needsResize ? ["-Z", String(IMAGE_ATTACH_MAX_LONG_EDGE)] : []), source, "--out", resized];
    if (!(await run("/usr/bin/sips", args)).ok || !existsSync(resized)) return "too-large";
    const out = new Uint8Array(readFileSync(resized));
    if (out.length <= STAGE_IMAGE_MAX_BYTES) return { kind: "data", bytes: out, mediaType: asJpeg ? "image/jpeg" : "image/png" };
    for (const quality of JPEG_QUALITIES) {
      const jpeg = join(dir, `q${quality}.jpg`);
      if (!(await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), resized, "--out", jpeg])).ok) continue;
      const encoded = new Uint8Array(readFileSync(jpeg));
      if (encoded.length <= STAGE_IMAGE_MAX_BYTES) return { kind: "data", bytes: encoded, mediaType: "image/jpeg" };
    }
    return "too-large";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(file: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000, encoding: "utf8" }, (err, stdout) => resolve({ ok: err === null, stdout: String(stdout ?? "") }));
  });
}

// AppleScript that writes one clipboard flavour to the file named by argv[1]; exits non-zero when the
// clipboard has no such flavour (the coercion throws), and always closes the file.
const WRITE_FLAVOUR = (flavour: string) => [
  "-e", "on run argv",
  "-e", "set f to open for access (POSIX file (item 1 of argv)) with write permission",
  "-e", "try",
  "-e", `write (the clipboard as ${flavour}) to f`,
  "-e", "on error e",
  "-e", "close access f",
  "-e", "error e",
  "-e", "end try",
  "-e", "close access f",
  "-e", "end run",
];

/** What the clipboard holds: an image FILE (Finder ⌘C) — its own path, nothing read — or image DATA. */
export type ClipboardImage = { kind: "file"; path: string } | { kind: "data"; bytes: Uint8Array } | null;

/**
 * The clipboard's image, or `null` when it holds none (the caller then leaves ctrl+v doing what it
 * did before — nothing). Tried in order: a copied image FILE (Finder ⌘C: `«class furl»`, when it is an
 * image by extension) — answered as that file's PATH, never read here —, PNG data, then TIFF data. The
 * data comes back RAW: no conversion, no resize (`prepareDraftImage` decides whether it fits). Every
 * flavour is written into a private `mkdtemp` directory that is removed before this returns.
 */
export async function readClipboardImage(): Promise<ClipboardImage> {
  if (process.platform !== "darwin") return null;
  const furl = await run("/usr/bin/osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"]);
  if (furl.ok) {
    const path = furl.stdout.trim();
    return IMAGE_EXT.test(path) && isRegularFile(path) ? { kind: "file", path } : null;
  }
  const dir = mkdtempSync(join(tmpdir(), "winter-clipboard-"));
  try {
    const png = join(dir, "clipboard.png");
    if ((await run("/usr/bin/osascript", [...WRITE_FLAVOUR("«class PNGf»"), png])).ok && existsSync(png)) {
      return { kind: "data", bytes: new Uint8Array(readFileSync(png)) };
    }
    const tiff = join(dir, "clipboard.tiff");
    if ((await run("/usr/bin/osascript", [...WRITE_FLAVOUR("«class TIFF»"), tiff])).ok && existsSync(tiff)) {
      return { kind: "data", bytes: new Uint8Array(readFileSync(tiff)) };
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
