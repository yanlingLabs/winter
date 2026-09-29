/** Code-mode image input (2026-09-29) — the TUI half.
 *
 *  An image enters the draft as the plain-text placeholder `[Image #n]` (n counts per draft from 1
 *  and never repeats within one), from ctrl+v with an image on the clipboard or from a pasted /
 *  dropped path to an image file. At submit, every placeholder still in the text is staged with
 *  `session.stageImage` (the daemon writes it into the session's temp directory) and replaced by the
 *  returned absolute path; the text then goes out exactly as before. A placeholder the user deleted
 *  is simply not staged.
 *
 *  Pure helpers first; the clipboard reader (osascript) last, injectable so no test ever touches the
 *  user's real clipboard. */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_TOO_LARGE_MESSAGE, STAGE_IMAGE_MAX_BYTES } from "@yanlinglabs/winter-protocol";
import { sniffImageMediaType } from "@yanlinglabs/winter-core";

// Shown when an image is over the daemon's cap (the runtime Read tool's own 3.75 MiB limit) — the
// daemon's `image_too_large` refusal says the same, word for word.
export { IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_TOO_LARGE_MESSAGE };

export interface DraftImage {
  bytes: Uint8Array;
  mediaType: string;
}

export const imageToken = (n: number): string => `[Image #${n}]`;

const TOKEN_RE = /\[Image #(\d+)\]/g;

/** The placeholder numbers `text` still contains, first-appearance order, each once. */
export function referencedImageNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(TOKEN_RE)) seen.add(Number(m[1]));
  return [...seen];
}

/** Every placeholder whose number `paths` knows is replaced by that path; any other is left as typed. */
export function substituteImageTokens(text: string, paths: ReadonlyMap<number, string>): string {
  return text.replace(TOKEN_RE, (whole, n: string) => paths.get(Number(n)) ?? whole);
}

/** One draft's attachments. Numbers climb for the draft's whole life — a deleted placeholder's
 *  number is never reused, so an undo that brings it back still finds its image. */
export class DraftImages {
  private images = new Map<number, DraftImage>();
  private next = 1;

  add(image: DraftImage): number {
    const n = this.next++;
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

/**
 * Stage every attachment `text` still references (`stage` is `session.stageImage`), in order, and
 * answer the text with each placeholder replaced by its staged path. The first refusal rejects with
 * the daemon's own error, and nothing is sent by the caller.
 */
export async function stageDraftImages(
  text: string,
  images: DraftImages,
  stage: (image: DraftImage) => Promise<string>,
): Promise<string> {
  const paths = new Map<number, string>();
  for (const n of images.referencedIn(text)) paths.set(n, await stage(images.get(n)!));
  return substituteImageTokens(text, paths);
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

/** An image's bytes as a draft attachment: `"not-image"` when the magic bytes are none of the four
 *  the daemon takes, `"too-large"` past the cap. The media type is the SNIFFED one — a JPEG saved as
 *  `.png` would otherwise be refused by the daemon's type check at submit. */
export function draftImageFrom(bytes: Uint8Array): DraftImage | "not-image" | "too-large" {
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) return "not-image";
  if (bytes.length > STAGE_IMAGE_MAX_BYTES) return "too-large";
  return { bytes, mediaType };
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
