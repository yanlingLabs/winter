/** Code-mode image input (2026-09-29) — the TUI half.
 *
 *  An image enters the draft as the plain-text placeholder `[Image #n]` (n counts per draft from 1
 *  and never repeats within one), from ctrl+v with an image on the clipboard or from a pasted /
 *  dropped path to an image file. At submit, every placeholder still in the text is staged with
 *  `session.stageImage` (the daemon writes it into the session's temp directory). The text goes out
 *  WITH its placeholders — the user's message shows `[Image #n]` — and `images` names each one's
 *  staged path; the daemon gives the MODEL the text with the paths in place. A daemon that predates
 *  that (its stage result has no `imagesOnSend`) is sent the paths substituted into the text, as
 *  before. A placeholder the user deleted is simply not staged.
 *
 *  Pure helpers first; the clipboard reader (osascript) last, injectable so no test ever touches the
 *  user's real clipboard. */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { IMAGE_ATTACH_MAX_LONG_EDGE, IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_TOO_LARGE_MESSAGE, STAGE_IMAGE_MAX_BYTES } from "@yanlinglabs/winter-protocol";
import { imageDimensions, imageTokenNumbers, sniffImageMediaType, substituteImageTokens } from "@yanlinglabs/winter-core";
import type { UserMessageImageRef } from "@yanlinglabs/winter-protocol";

// Shown when an image is over the daemon's cap (the runtime Read tool's own 3.75 MiB limit) — the
// daemon's `image_too_large` refusal says the same, word for word.
export { IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_TOO_LARGE_MESSAGE };

export interface DraftImage {
  bytes: Uint8Array;
  mediaType: string;
}

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
 * Stage every attachment `text` still references (`stage` is `session.stageImage`), in order. The
 * first refusal rejects with the daemon's own error, and nothing is sent by the caller.
 */
export async function stageDraftImages(
  text: string,
  images: DraftImages,
  stage: (image: DraftImage) => Promise<StagedImage>,
): Promise<StagedDraft> {
  const refs: UserMessageImageRef[] = [];
  let imagesOnSend = true;
  for (const n of images.referencedIn(text)) {
    const staged = await stage(images.get(n)!);
    refs.push({ n, path: staged.path });
    if (staged.imagesOnSend !== true) imagesOnSend = false;
  }
  const modelText = substituteImageTokens(text, new Map(refs.map((r) => [r.n, r.path])));
  return { text, images: refs, modelText, imagesOnSend };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

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

/** Only the magic bytes: is this one of the four image types the daemon stages? */
export function isStageableImage(bytes: Uint8Array): boolean {
  return sniffImageMediaType(bytes) !== undefined;
}

const EXT_FOR: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const JPEG_QUALITIES = [85, 75, 65, 50];

/**
 * An image's bytes as a draft attachment, prepared ONCE, at attach time, so a submit never
 * re-encodes. An image within `IMAGE_ATTACH_MAX_LONG_EDGE` (1568 px — Anthropic's documented size
 * above which the service downscales anyway) and within the stage cap is attached untouched. Anything
 * else is written to a PRIVATE temp copy (never the user's own file) and `sips -Z 1568`-ed there,
 * keeping PNG as PNG and JPEG as JPEG (a GIF or WebP becomes a PNG of its first frame); if the result
 * is still over 3.75 MB it is re-encoded as JPEG, quality stepping 85 → 50. Only when that still
 * fails is it `"too-large"`. `"not-image"` when the magic bytes are none of the four the daemon takes.
 */
export async function prepareDraftImage(bytes: Uint8Array): Promise<DraftImage | "not-image" | "too-large"> {
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) return "not-image";
  const dims = imageDimensions(bytes);
  const longEdge = dims === undefined ? undefined : Math.max(dims.width, dims.height);
  const needsResize = longEdge === undefined || longEdge > IMAGE_ATTACH_MAX_LONG_EDGE;
  if (!needsResize && bytes.length <= STAGE_IMAGE_MAX_BYTES) return { bytes, mediaType };
  if (process.platform !== "darwin") return bytes.length <= STAGE_IMAGE_MAX_BYTES ? { bytes, mediaType } : "too-large";

  const dir = mkdtempSync(join(tmpdir(), "winter-attach-"));
  try {
    const source = join(dir, `source.${EXT_FOR[mediaType]}`);
    writeFileSync(source, bytes, { mode: 0o600 });
    const asJpeg = mediaType === "image/jpeg";
    const resized = join(dir, asJpeg ? "resized.jpg" : "resized.png");
    const args = ["-s", "format", asJpeg ? "jpeg" : "png", ...(needsResize ? ["-Z", String(IMAGE_ATTACH_MAX_LONG_EDGE)] : []), source, "--out", resized];
    if (!(await run("/usr/bin/sips", args)).ok || !existsSync(resized)) {
      return bytes.length <= STAGE_IMAGE_MAX_BYTES ? { bytes, mediaType } : "too-large";
    }
    const out = new Uint8Array(readFileSync(resized));
    if (out.length <= STAGE_IMAGE_MAX_BYTES) return { bytes: out, mediaType: asJpeg ? "image/jpeg" : "image/png" };
    for (const quality of JPEG_QUALITIES) {
      const jpeg = join(dir, `q${quality}.jpg`);
      if (!(await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), resized, "--out", jpeg])).ok) continue;
      const encoded = new Uint8Array(readFileSync(jpeg));
      if (encoded.length <= STAGE_IMAGE_MAX_BYTES) return { bytes: encoded, mediaType: "image/jpeg" };
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

/**
 * The clipboard's image, or `null` when it holds none (the caller then leaves ctrl+v doing what it
 * did before — nothing). Tried in order: a copied image FILE (Finder ⌘C: `«class furl»`, read only
 * when it is an image by extension), PNG data, then TIFF data converted to PNG with `sips`. Every
 * flavour is written into a private `mkdtemp` directory that is removed before this returns.
 */
export async function readClipboardImage(): Promise<Uint8Array | null> {
  if (process.platform !== "darwin") return null;
  const furl = await run("/usr/bin/osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"]);
  if (furl.ok) {
    const path = furl.stdout.trim();
    return IMAGE_EXT.test(path) && isRegularFile(path) ? new Uint8Array(readFileSync(path)) : null;
  }
  const dir = mkdtempSync(join(tmpdir(), "winter-clipboard-"));
  try {
    const png = join(dir, "clipboard.png");
    if ((await run("/usr/bin/osascript", [...WRITE_FLAVOUR("«class PNGf»"), png])).ok && existsSync(png)) {
      return new Uint8Array(readFileSync(png));
    }
    const tiff = join(dir, "clipboard.tiff");
    if ((await run("/usr/bin/osascript", [...WRITE_FLAVOUR("«class TIFF»"), tiff])).ok && existsSync(tiff)) {
      if ((await run("/usr/bin/sips", ["-s", "format", "png", tiff, "--out", png])).ok && existsSync(png)) {
        return new Uint8Array(readFileSync(png));
      }
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
