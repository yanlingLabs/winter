import { z } from "zod";
import { readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { getDocumentProxy, extractText } from "unpdf";
import { canonAncestor, resolveWithinAny } from "../paths";
import type { ToolContext, ToolRegistry } from "./registry";
import { IMAGE_MAX_BYTES, attachImageGuarded, humanSize } from "./attach-image";

const LS_MAX_ENTRIES = 1000;

const DENY_MESSAGE = "this path is Norma's own credential store and is never readable";

// --- multimodal read (T1/T2): images, notebooks, PDFs -----------------------------------------
//
// `read` dispatches on the (lowercased) file extension. Images and PDFs/notebooks are handled by
// the helpers below; everything else falls through to the original plain-text path unchanged.
// IMAGE_MAX_BYTES + humanSize moved to attach-image.ts (parity-tail review): the size cap is now
// shared with every other base64-image attach path (notebook outputs below, MCP resource blobs).

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".heic"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".tiff": "image/tiff", ".heic": "image/heic",
};
const IMAGE_RECOMPRESS_BYTES = 500 * 1024; // above this, re-encode even if dimensions are fine
const IMAGE_MAX_DIM = 1600; // mirrors the CU screenshotMaxDim precedent (computer-use.ts)
const IMAGE_JPEG_QUALITY = 80;

/** Shells out to stock macOS `sips -g` to read pixel dimensions — no image-decoding dependency
 *  needed in-process. Throws a clean message (never a raw spawn/stderr blob) on failure. */
function sipsDims(path: string): { width: number; height: number } {
  const p = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path]);
  if (p.exitCode !== 0) {
    throw new Error(`could not read image dimensions (sips): ${p.stderr.toString().trim() || "unknown error"}`);
  }
  const out = p.stdout.toString();
  const w = /pixelWidth:\s*(\d+)/.exec(out)?.[1];
  const h = /pixelHeight:\s*(\d+)/.exec(out)?.[1];
  if (!w || !h) throw new Error(`could not parse image dimensions from sips output for ${path}`);
  return { width: Number(w), height: Number(h) };
}

/** Downscales/re-encodes `src` into `dst` as a JPEG via `sips`. `resize` gates whether `-Z` (max
 *  dimension) is passed at all — sips's `-Z` UPSCALES an image smaller than the target (verified:
 *  a 500×500 source became 1600×1600 output), so it must only be given when the source genuinely
 *  exceeds IMAGE_MAX_DIM; a big-file-but-small-dimensions image is re-encoded at its own size
 *  (recompression only, no resize) to avoid that upscale trap. */
function sipsDownscale(src: string, dst: string, resize: boolean): void {
  const args = ["sips"];
  if (resize) args.push("-Z", String(IMAGE_MAX_DIM));
  args.push("-s", "format", "jpeg", "-s", "formatOptions", String(IMAGE_JPEG_QUALITY), src, "--out", dst);
  const p = Bun.spawnSync(args);
  if (p.exitCode !== 0) {
    throw new Error(`could not downscale image (sips): ${p.stderr.toString().trim() || "unknown error"}`);
  }
}

/** Images: vision gate → size cap → dimension/size-triggered downscale (into the session tmp dir,
 *  cleaned up immediately after) → base64 data URL → ctx.attachImage → a short text note (the
 *  `computer` tool's exact "the image follows this result as the next message" pattern). The
 *  image bytes themselves NEVER touch the returned string — they ride ctx.attachImage's own
 *  side channel, so this bypasses the registry's 64KB MAX_OUTPUT cap exactly like a CU screenshot. */
function readImage(target: string, ext: string, ctx: ToolContext): string {
  if (ctx.visionCapable === false) {
    throw new Error(`this model cannot view images — ${basename(target)} was not read; switch to a vision-capable model or read a different kind of file`);
  }
  const size = statSync(target).size;
  if (size > IMAGE_MAX_BYTES) {
    throw new Error(`image ${basename(target)} is ${humanSize(size)} — exceeds the ${humanSize(IMAGE_MAX_BYTES)} read limit`);
  }
  const { width, height } = sipsDims(target);
  const needsResize = width > IMAGE_MAX_DIM || height > IMAGE_MAX_DIM;
  const needsRecompress = needsResize || size > IMAGE_RECOMPRESS_BYTES;

  let bytes: Buffer;
  let mime: string;
  let scaledNote = "";
  if (needsRecompress) {
    const dst = join(ctx.tmpDir ?? tmpdir(), `read-image-${randomUUID()}.jpg`);
    try {
      sipsDownscale(target, dst, needsResize);
      bytes = readFileSync(dst);
      const finalDims = sipsDims(dst);
      scaledNote = ` — downscaled to ${finalDims.width}×${finalDims.height} JPEG, ${humanSize(bytes.length)}`;
    } finally {
      try { unlinkSync(dst); } catch { /* best-effort scratch cleanup */ }
    }
    mime = "image/jpeg";
  } else {
    bytes = readFileSync(target);
    mime = IMAGE_MIME[ext] ?? "application/octet-stream";
  }
  ctx.attachImage?.(`data:${mime};base64,${bytes.toString("base64")}`);
  return `Image ${basename(target)}: ${width}×${height}, ${humanSize(size)}${scaledNote}. The image follows this result as the next message.`;
}

// --- notebooks (.ipynb) -------------------------------------------------------------------------

interface NbOutput {
  output_type?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
interface NbCell { cell_type?: string; source?: string | string[]; outputs?: NbOutput[] }
interface NbNotebook { cells?: NbCell[] }

const NB_OUTPUT_CAP = 4000; // per-output cap; the registry's overall 64KB cap still applies on top

function nbText(source: string | string[] | undefined): string {
  if (source === undefined) return "";
  return Array.isArray(source) ? source.join("") : source;
}

function nbCap(s: string): string {
  return s.length <= NB_OUTPUT_CAP ? s : s.slice(0, NB_OUTPUT_CAP) + `\n[output truncated at ${NB_OUTPUT_CAP} chars]`;
}

/** Renders one cell output. `image/png` outputs attach as a vision image (ctx.attachImage,
 *  gated purely on its OWN presence — the engine only wires it for a vision-capable model, so
 *  this can't disagree with the model's actual capability) or are honestly noted as omitted.
 *  The attach rides attachImageGuarded (parity-tail review): an output whose decoded size
 *  exceeds IMAGE_MAX_BYTES renders the guard's "[image omitted: ...]" note instead — nothing
 *  that large is ever staged into the model's input, from any attach path. */
function nbRenderOutput(out: NbOutput, ctx: ToolContext): string {
  if (out.output_type === "stream") return nbCap(nbText(out.text));
  if (out.output_type === "execute_result" || out.output_type === "display_data") {
    const data = out.data ?? {};
    const png = data["image/png"];
    if (typeof png === "string") {
      if (ctx.attachImage) {
        const note = attachImageGuarded(ctx, { mime: "image/png", base64: png });
        if (note) return note;
        return "[image output (image/png) — attached as the next message]";
      }
      return "[image output omitted — model cannot view images]";
    }
    const text = data["text/plain"];
    if (typeof text === "string" || Array.isArray(text)) return nbCap(nbText(text as string | string[]));
    return "";
  }
  if (out.output_type === "error") {
    const tb = Array.isArray(out.traceback) ? out.traceback.join("\n") : "";
    return nbCap(`${out.ename ?? "Error"}: ${out.evalue ?? ""}${tb ? "\n" + tb : ""}`);
  }
  return "";
}

function nbRenderCell(cell: NbCell, idx: number, ctx: ToolContext): string {
  const type = cell.cell_type ?? "code";
  const parts = [`[cell ${idx} — ${type}]`, nbText(cell.source)];
  if (type === "code" && Array.isArray(cell.outputs)) {
    for (const out of cell.outputs) {
      const rendered = nbRenderOutput(out, ctx);
      if (rendered) parts.push(rendered);
    }
  }
  return parts.filter((p) => p.length > 0).join("\n");
}

/** Renders ALL cells + their outputs, or `undefined` when the JSON is malformed (or valid JSON
 *  without a `cells` array) — the caller (the `read` tool's dispatch) falls straight through to
 *  the plain-text path for `undefined`, so a malformed notebook is read exactly like any other
 *  text file (offset/limit included), not a special-cased whole-file dump. */
function renderNotebook(raw: string, ctx: ToolContext): string | undefined {
  let nb: NbNotebook;
  try { nb = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(nb.cells)) return undefined;
  return nb.cells.map((c, i) => nbRenderCell(c, i + 1, ctx)).join("\n\n");
}

// --- PDFs ----------------------------------------------------------------------------------------

const PDF_WHOLE_MAX_PAGES = 10; // ≤ this many pages, and no `pages` given → read the whole document
const PDF_RANGE_MAX_PAGES = 20; // a `pages` range may span at most this many pages per request

/** Parses the `pages` arg ("5" or "1-5") against the PDF's real page count. Every rejection names
 *  the actual total so the model can retry with a valid range instead of guessing. */
function parsePageRange(pagesStr: string, totalPages: number): { start: number; end: number } {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(pagesStr);
  if (!m) throw new Error(`invalid pages "${pagesStr}" — expected a page number or range like "1-5"`);
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (start < 1 || end < start) throw new Error(`invalid pages "${pagesStr}" — expected a page number or range like "1-5"`);
  if (end > totalPages) {
    throw new Error(`pages "${pagesStr}" is out of range — this PDF has ${totalPages} page${totalPages === 1 ? "" : "s"}`);
  }
  if (end - start + 1 > PDF_RANGE_MAX_PAGES) {
    throw new Error(`pages "${pagesStr}" spans ${end - start + 1} pages — max ${PDF_RANGE_MAX_PAGES} pages per request`);
  }
  return { start, end };
}

/** PDFs: text-extract per page via `unpdf` (a self-contained, zero-runtime-dependency pdf.js
 *  build — see the task report for why this was chosen over a hand-rolled parser or a compiled
 *  Swift/PDFKit helper). ≤10 pages with no `pages` arg reads the whole document; a bigger PDF
 *  requires `pages` (error names the real page count); a `pages` range is capped at 20 pages per
 *  request. Per-page `— page N —` headers. All-blank extracted text (every requested page) reports
 *  the honest scanned/no-text message instead of a wall of empty headers. */
async function readPdf(target: string, pagesStr: string | undefined): Promise<string> {
  const bytes = new Uint8Array(readFileSync(target));
  let totalPages: number;
  let allText: string[];
  try {
    const pdf = await getDocumentProxy(bytes);
    ({ totalPages, text: allText } = await extractText(pdf, { mergePages: false }));
  } catch (e) {
    throw new Error(`could not parse PDF ${basename(target)}: ${(e as Error).message}`);
  }

  let start: number, end: number;
  if (pagesStr !== undefined) {
    ({ start, end } = parsePageRange(pagesStr, totalPages));
  } else if (totalPages > PDF_WHOLE_MAX_PAGES) {
    throw new Error(
      `${basename(target)} has ${totalPages} pages — pass \`pages\` (e.g. "1-10") to read up to ${PDF_RANGE_MAX_PAGES} pages at a time`,
    );
  } else {
    start = 1;
    end = totalPages;
  }

  const slice = allText.slice(start - 1, end);
  if (slice.every((t) => t.trim() === "")) {
    return `no extractable text in ${basename(target)} (scanned image PDF?); page-image rendering is a follow-up`;
  }
  const body = slice.map((t, i) => `— page ${start + i} —\n${t}`).join("\n\n");
  return pagesStr !== undefined ? `Showing pages ${start}-${end} of ${totalPages}:\n\n${body}` : body;
}

/**
 * Reads-unrestricted (user rule, memory/reads-unrestricted.md, task-10): read/ls/glob/grep have NO
 * path fence — the write fence (fs-write.ts) is a completely separate, unchanged mechanism. The
 * ONE carve-out is this denylist: a small set of real, realpath-resolved directory prefixes that
 * hold Norma's OWN credential/runtime material, so a prompt-injected turn can't read the daemon's
 * own keys through the tool the daemon itself hosts. Everything else under ~/.norma (sessions,
 * settings, memory, logs, skills, ...) is readable by design — this is NOT a general sandbox.
 */
export interface ReadToolsConfig {
  /** Directories to deny, checked via a symlink-hardened prefix match (canonAncestor) so a symlink
   *  can't route around the block either. Callers pass raw paths — canonicalized once here at
   *  registration (realpathSync; falls back to path.resolve if the directory doesn't exist yet).
   *  Empty/absent (the default, and every existing test) means no denylist at all — daemon.ts is
   *  the sole production caller and always supplies normaHome's runDir (see daemon.ts). */
  deniedPrefixes?: string[];
}

// Bun's Glob.scan ignores `cwd` for absolute patterns and yields absolute
// paths directly — join()-ing those onto `root` would silently fabricate a
// bogus in-root path, so only join relative matches; pass absolute matches
// through as-is.
function combine(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

// The session tmp dir (where web_fetch saves full pages, bg-task output lives, etc.) is a
// Norma-managed, session-private, sandbox-writable location that is NOT in the write-fence `roots`.
// glob/grep's RELATIVE-pattern scanning additionally walks it (unchanged from before this task) so
// the agent can find what its own tools wrote there via a relative pattern. read/ls don't need it
// listed at all anymore: an absolute path is unrestricted (denylist aside) regardless of whether it
// happens to be tmpDir.
function readRootsOf(roots: string[], tmpDir?: string): string[] {
  return tmpDir ? [...roots, tmpDir] : roots;
}

function canonicalizeDenylist(prefixes: string[]): string[] {
  return prefixes.map((p) => {
    try { return realpathSync(p); } catch { return resolve(p); }
  });
}

function isDenied(deniedPrefixes: string[], target: string): boolean {
  if (deniedPrefixes.length === 0) return false;
  const probe = canonAncestor(target);
  return deniedPrefixes.some((d) => probe === d || probe.startsWith(d + sep));
}

// Shared by glob/grep: resolves one Bun.Glob.scan match to its final absolute path, or null if it
// should never be surfaced. Two regimes, keyed off whether `p` (the RAW yielded match, before
// combine()) is itself absolute — i.e. whether the ORIGINATING pattern was absolute (Bun ignores
// `cwd` and walks the real filesystem for those) or relative (even a ".."-escaping one, which Bun
// still yields as a non-absolute string like "../sibling" — see combine()'s own comment):
//   - absolute-origin: may point ANYWHERE on disk (that's the point — a laptop-wide scan) — only
//     the denylist gates it, no containment check.
//   - relative-origin: keeps THE SAME scoped-to-scanRoots containment this had before this task
//     (via resolveWithinAny, which is also symlink-hardened) — a plain relative pattern must never
//     silently open up the whole disk just because it happened to climb out with "..".
function resolveMatch(scanRoots: string[], deniedPrefixes: string[], root: string, p: string): string | null {
  const candidate = combine(root, p);
  let resolved: string;
  if (isAbsolute(p)) {
    resolved = resolve(candidate);
  } else {
    try { resolved = resolveWithinAny(scanRoots, candidate); } catch { return null; }
  }
  return isDenied(deniedPrefixes, resolved) ? null : resolved;
}

export function registerReadTools(r: ToolRegistry, opts: ReadToolsConfig = {}): void {
  const deniedPrefixes = canonicalizeDenylist(opts.deniedPrefixes ?? []);

  r.register({
    name: "read",
    description:
      "Read a file's contents. Path may be relative to the session directory or an absolute path anywhere on disk. Optional offset (1-based start line) and limit (line count) read part of a large text file — outputs over 64KB truncate, so page large files with offset/limit. " +
      "Type-aware: image files (.png/.jpg/.jpeg/.gif/.webp/.bmp/.tiff/.heic) are shown to the model as an image (needs a vision-capable model); .ipynb notebooks render all cells with their outputs (image outputs shown as images too); .pdf files extract text per page — pass `pages` (e.g. \"1-5\") for PDFs over 10 pages, at most 20 pages per request. Everything else returns plain text without line numbers.",
    args: z.object({
      path: z.string().min(1),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().positive().optional(),
      pages: z.string().min(1).optional(),
    }),
    modes: ["code", "dispatch"], // R-T2: was DISPATCH_ALLOW_TOOLS's literal membership
    async run({ path, offset = 1, limit, pages }, ctx) {
      const { roots } = ctx;
      const target = isAbsolute(path) ? resolve(path) : resolve(roots[0]!, path);
      if (isDenied(deniedPrefixes, target)) throw new Error(DENY_MESSAGE);
      const ext = extname(target).toLowerCase();

      if (IMAGE_EXTS.has(ext)) return readImage(target, ext, ctx);
      if (ext === ".pdf") return await readPdf(target, pages);

      const content = readFileSync(target, "utf8");
      if (ext === ".ipynb") {
        const rendered = renderNotebook(content, ctx);
        if (rendered !== undefined) return rendered;
        // malformed JSON / no cells array → fall through to the plain-text path below, unchanged.
      }

      // Plain text — byte-identical to the pre-dispatch behavior.
      if (offset === 1 && limit === undefined) {
        return content;
      }
      const lines = content.split("\n");
      const endIdx = limit === undefined ? lines.length : offset - 1 + limit;
      const sliced = lines.slice(offset - 1, endIdx);
      return sliced.join("\n");
    },
  });

  r.register({
    name: "ls",
    description:
      "Lists files and directories in a given path (non-recursive, one level deep), anywhere on disk. `path` must be an absolute path, not a relative path. Optionally pass `ignore`, an array of glob patterns matched against entry names to exclude from the listing. Prefer `glob` or `grep` when you already know what you're looking for and want a targeted search rather than a full directory listing.",
    args: z.object({ path: z.string().min(1), ignore: z.array(z.string()).optional() }),
    modes: ["code", "dispatch"], // R-T2: was DISPATCH_ALLOW_TOOLS's literal membership
    run({ path, ignore }) {
      if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
      const target = resolve(path);
      if (isDenied(deniedPrefixes, target)) throw new Error(DENY_MESSAGE);
      let st;
      try {
        st = statSync(target);
      } catch {
        throw new Error(`path does not exist: ${path}`);
      }
      if (!st.isDirectory()) throw new Error(`path is not a directory: ${path}`);

      const patterns = (ignore ?? []).map((p: string) => new Bun.Glob(p));
      const dirs: string[] = [];
      const files: string[] = [];
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (patterns.some((g: InstanceType<typeof Bun.Glob>) => g.match(entry.name))) continue;
        // Denylisted entries simply don't appear (parity with glob/grep's silent skip) — without
        // this, listing the denied dir's PARENT would leak the bare entry name (task-10 review).
        if (isDenied(deniedPrefixes, join(target, entry.name))) continue;
        if (entry.isDirectory()) dirs.push(entry.name + "/");
        else files.push(entry.name);
      }
      dirs.sort();
      files.sort();
      const all = [...dirs, ...files];
      const shown = all.slice(0, LS_MAX_ENTRIES);
      let out = shown.join("\n");
      if (all.length > LS_MAX_ENTRIES) {
        out += (shown.length ? "\n" : "") + `… (+${all.length - LS_MAX_ENTRIES} more truncated)`;
      }
      return out;
    },
  });

  r.register({
    name: "glob",
    description: "List files matching a glob pattern (newline-separated, absolute paths). A relative pattern scans the session's directories; an absolute pattern (e.g. \"/Users/me/**/*.mp4\") may target anywhere on disk.",
    args: z.object({ pattern: z.string().min(1), budgetMs: z.number().int().positive().max(10_000).default(2000) }),
    modes: ["code", "dispatch"], // R-T2: was DISPATCH_ALLOW_TOOLS's literal membership
    async run({ pattern, budgetMs }, { roots, tmpDir }) {
      const out = new Set<string>();
      const deadline = Date.now() + budgetMs;
      const scanRoots = readRootsOf(roots, tmpDir);
      for (const root of scanRoots) {
        const glob = new Bun.Glob(pattern);
        try {
          for await (const p of glob.scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
            if (Date.now() > deadline) {
              return [...out].sort().join("\n") + (out.size ? "\n" : "") + "[scan time budget reached]";
            }
            const resolved = resolveMatch(scanRoots, deniedPrefixes, root, p);
            if (resolved) out.add(resolved); // denylisted/escaped-relative matches are skipped silently, never abort the scan
          }
        } catch {
          // Iterator threw mid-walk (e.g. EACCES from a genuinely-unreadable OS directory): never
          // surface a raw OS error/path — stop scanning this root, keep whatever was collected.
          continue;
        }
      }
      return [...out].sort().join("\n");
    },
  });

  r.register({
    name: "grep",
    description: "Search file contents with a regular expression. Returns file:line:text matches. `glob` scopes the search — a relative pattern stays within the session's directories; an absolute pattern may target anywhere on disk.",
    args: z.object({ pattern: z.string().min(1).max(256), glob: z.string().default("**/*"), budgetMs: z.number().int().positive().max(10_000).default(2000) }),
    modes: ["code", "dispatch"], // R-T2: was DISPATCH_ALLOW_TOOLS's literal membership
    async run({ pattern, glob: g, budgetMs }, { cwd, roots, tmpDir }) {
      // Pattern is model-controlled: length-capped as a cheap ReDoS bound.
      // Full guard (linear-time engine or scan timeout) tracked in phase-1 carryover.
      const re = new RegExp(pattern);
      const hits: string[] = [];
      const deadline = Date.now() + budgetMs;
      const scanRoots = readRootsOf(roots, tmpDir);
      for (const root of scanRoots) {
        const scanner = new Bun.Glob(g);
        try {
          for await (const p of scanner.scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
            if (Date.now() > deadline) { hits.push("[scan time budget reached]"); return hits.join("\n"); }
            const abs = resolveMatch(scanRoots, deniedPrefixes, root, p);
            if (!abs) continue; // denylisted/escaped-relative match: skip silently, don't abort the scan
            let text: string;
            try { text = readFileSync(abs, "utf8"); } catch { continue; }
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (Date.now() > deadline) { hits.push("[scan time budget reached]"); return hits.join("\n"); }
              if (re.test(lines[i]!)) hits.push(`${relative(cwd, abs)}:${i + 1}:${lines[i]}`);
              if (hits.length >= 200) return hits.join("\n") + "\n[match cap reached]";
            }
          }
        } catch {
          // Iterator threw mid-walk (e.g. EACCES from a genuinely-unreadable OS directory) — same
          // tolerance as glob above. Stop scanning this root rather than leak the raw OS error.
          continue;
        }
      }
      return hits.join("\n");
    },
  });
}
