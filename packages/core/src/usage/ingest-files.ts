import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// The shared half of the external ingests (`docs/claude/usage.md`): find JSONL files under a root, and read ONLY the
// bytes appended since the last read — from a stored byte offset, consuming whole lines only (a partial last line is
// left for the next read), restarting from 0 when the file's inode changed (rotated, replaced) or it shrank below the
// offset (truncated). Nothing here keeps a path: the read state is keyed by a hash of it (`fileKey`).

export interface FoundFile {
  path: string;
  inode: number;
  size: number;
  mtimeMs: number;
}

/** A stable, non-reversible key for a path (the plaintext path names the user's project). */
export function fileKey(source: string, path: string): string {
  return `${source}:${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
}

/** Every file under `root` (to `maxDepth`) whose name passes `accept`; a missing or unreadable root is none. */
export async function findFiles(root: string, accept: (name: string) => boolean, maxDepth = 6): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(p, depth + 1);
      } else if (e.isFile() && accept(e.name)) {
        try {
          const s = await stat(p);
          out.push({ path: p, inode: s.ino, size: s.size, mtimeMs: s.mtimeMs });
        } catch { /* vanished */ }
      }
    }
  };
  await walk(root, 0);
  return out;
}

export interface ReadResult {
  /** The new offset (end of the last whole line consumed). */
  offset: number;
  /** True when the stored state was discarded (inode changed, or the file shrank). */
  reset: boolean;
  /** True when the byte budget stopped the read before the end. */
  more: boolean;
  /** True when the read stopped INSIDE an over-long line being skipped: `offset` is past what was read of it, and the
   *  next read (handed this back) goes on skipping to its newline — so the offset always advances. */
  skipping: boolean;
}

const CHUNK = 1 << 20;
const NL = 0x0a;

/**
 * Read whole lines appended to `file` since `prev` (`undefined` = from the start), handing each to `onLine` in order.
 * Lines longer than `maxLine` bytes are skipped whole (still consumed). At most `budget` bytes are read per call.
 */
export async function readNewLines(
  file: FoundFile, prev: { inode: number; offset: number; skipping?: boolean } | undefined, onLine: (line: string) => void,
  opts: { budget?: number; maxLine?: number } = {},
): Promise<ReadResult> {
  const reset = prev !== undefined && (prev.inode !== file.inode || file.size < prev.offset);
  let offset = prev === undefined || reset ? 0 : prev.offset;
  if (offset >= file.size) return { offset, reset, more: false, skipping: !reset && prev?.skipping === true };
  const budget = opts.budget ?? 64 * CHUNK;
  const maxLine = opts.maxLine ?? 16 * CHUNK;
  const decoder = new TextDecoder();
  let fh: import("node:fs/promises").FileHandle;
  try { fh = await open(file.path, "r"); } catch { return { offset: prev?.offset ?? 0, reset: false, more: false, skipping: prev?.skipping === true }; }
  try {
    let pos = offset;
    let carry: Buffer[] = [];
    let carryLen = 0;
    let skipping = !reset && prev?.skipping === true;
    const end = Math.min(file.size, offset + budget);
    while (pos < end) {
      const want = Math.min(CHUNK, end - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      for (let i = chunk.indexOf(NL); i !== -1; i = chunk.indexOf(NL, start)) {
        const piece = chunk.subarray(start, i);
        if (!skipping && carryLen + piece.length <= maxLine) {
          const line = carryLen === 0 ? piece : Buffer.concat([...carry, piece], carryLen + piece.length);
          if (line.length > 0) {
            try { onLine(decoder.decode(line)); } catch { /* one bad line never stops the read */ }
          }
        }
        carry = [];
        carryLen = 0;
        skipping = false;
        start = i + 1;
        offset = pos + start;
      }
      if (start < chunk.length && !skipping) {
        const rest = Buffer.from(chunk.subarray(start));
        carry.push(rest);
        carryLen += rest.length;
        if (carryLen > maxLine) { skipping = true; carry = []; carryLen = 0; }
      }
      pos += bytesRead;
    }
    // Inside an over-long line at the end: everything read of it is consumed (never re-read), and the skip goes on.
    if (skipping) offset = pos;
    return { offset, reset, more: end < file.size, skipping };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Scan `path` BACKWARDS from its end, handing each whole line (last first) to `onLine` until it returns true or
 * `maxBytes` have been read. Only the tail is read.
 */
export async function scanLinesBackward(path: string, onLine: (line: string) => boolean, maxBytes = 8 * CHUNK): Promise<boolean> {
  let fh: import("node:fs/promises").FileHandle;
  try { fh = await open(path, "r"); } catch { return false; }
  try {
    const size = (await fh.stat()).size;
    const decoder = new TextDecoder();
    let pos = size;
    let tail: Buffer = Buffer.alloc(0);
    let read = 0;
    while (pos > 0 && read < maxBytes) {
      const want = Math.min(256 * 1024, pos);
      pos -= want;
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      read += bytesRead;
      let data = Buffer.concat([buf.subarray(0, bytesRead), tail]);
      // Every complete line after the first newline in `data` (the part before it may be cut).
      let end = data.length;
      for (let i = data.lastIndexOf(NL, end - 1); i !== -1; i = data.lastIndexOf(NL, end - 1)) {
        const line = data.subarray(i + 1, end);
        end = i;
        if (line.length > 0 && onLine(decoder.decode(line))) return true;
        if (i === 0) break;
      }
      tail = data.subarray(0, end);
      if (pos === 0 && tail.length > 0 && onLine(decoder.decode(tail))) return true;
      data = Buffer.alloc(0);
    }
    return false;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** PURE: an ISO timestamp (or epoch number) as epoch ms. */
export function timeOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string" && v.length > 0) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export const tokenCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
