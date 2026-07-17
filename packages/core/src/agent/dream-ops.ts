import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Dreaming (Phase 7b): the Dreamer's file-operation contract — the model returns a JSON list of
 *  these; validateOps is the wall between model output and the filesystem. Caps per the spec:
 *  ≤12 ops/cycle, ≤8KB/file, ≤64 files in the bucket; kebab-case .md names; reserved files
 *  (index, tombstones, state) are never valid targets. */
export type DreamOp =
  | { op: "write"; file: string; content: string }
  | { op: "delete"; file: string }
  | { op: "tombstone"; text: string };

export const RESERVED_FILES = new Set(["MEMORY.md", "tombstones.md", "dream-state.json"]);
export const MAX_OPS = 12;
export const MAX_FILE_BYTES = 8192;
export const MAX_FILES = 64;
export const FILE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*\.md$/;

export function validateOps(raw: unknown, existingFiles: string[]): { ok: true; ops: DreamOp[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "ops must be a JSON array" };
  if (raw.length > MAX_OPS) return { ok: false, error: `too many ops (${raw.length} > ${MAX_OPS})` };
  const ops: DreamOp[] = [];
  const files = new Set(existingFiles.filter((f) => !RESERVED_FILES.has(f)));
  for (const [i, item] of raw.entries()) {
    const o = item as Record<string, unknown>;
    if (o?.op === "tombstone") {
      if (typeof o.text !== "string" || !o.text.trim()) return { ok: false, error: `op ${i}: tombstone needs non-empty text` };
      ops.push({ op: "tombstone", text: o.text.trim() });
      continue;
    }
    if (o?.op !== "write" && o?.op !== "delete") return { ok: false, error: `op ${i}: unknown op '${String(o?.op)}'` };
    // Reserved-ness is checked ahead of the kebab-case format check: RESERVED_FILES holds
    // "MEMORY.md" (uppercase) and "dream-state.json" (.json), neither of which matches
    // FILE_NAME_RE — so a format-first ordering would misreport them as bad-format instead
    // of reserved. Any string is a safe Set key, so this is fine even when o.file isn't one.
    if (RESERVED_FILES.has(o.file as string)) return { ok: false, error: `op ${i}: '${String(o.file)}' is reserved` };
    if (typeof o.file !== "string" || !FILE_NAME_RE.test(o.file)) return { ok: false, error: `op ${i}: file must be kebab-case .md, got '${String(o.file)}'` };
    if (o.op === "write") {
      if (typeof o.content !== "string" || !o.content.trim()) return { ok: false, error: `op ${i}: write needs non-empty content` };
      if (Buffer.byteLength(o.content, "utf8") > MAX_FILE_BYTES) return { ok: false, error: `op ${i}: content exceeds ${MAX_FILE_BYTES} bytes` };
      files.add(o.file);
      ops.push({ op: "write", file: o.file, content: o.content });
    } else {
      files.delete(o.file);
      ops.push({ op: "delete", file: o.file });
    }
  }
  // The MAX_FILES cap is judged on the batch's NET effect, after every op is folded into the
  // set — a per-op incremental check would be order-dependent (write-then-delete rejected at
  // the cap while the equivalent delete-then-write passes), and consolidation batches
  // naturally write the merged file before deleting its sources.
  if (files.size > MAX_FILES) return { ok: false, error: `bucket would exceed ${MAX_FILES} files` };
  return { ok: true, ops };
}

/** First non-frontmatter, non-heading, non-empty line — the index hook. */
function hookLine(content: string): string {
  const lines = content.split("\n");
  let inFm = false;
  for (const [i, l] of lines.entries()) {
    const t = l.trim();
    if (i === 0 && t === "---") { inFm = true; continue; }
    if (inFm) { if (t === "---") inFm = false; continue; }
    if (!t || t.startsWith("#")) continue;
    return t.slice(0, 120);
  }
  return "";
}

export function applyOps(dir: string, ops: DreamOp[]): void {
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, "MEMORY.md");
  const index = new Map<string, string>(); // file -> index line
  if (existsSync(indexPath)) {
    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
      const m = line.match(/^- \[[^\]]*\]\(([^)]+)\)/);
      // noUncheckedIndexedAccess types m[1] as string | undefined even though the outer regex
      // guarantees the capture group matched whenever `m` is truthy — non-null assert like the
      // rest of the codebase does for the same pattern (see tools/web.ts).
      if (m) index.set(m[1]!, line);
    }
  }
  for (const op of ops) {
    if (op.op === "write") {
      const tmp = join(dir, `.${op.file}.tmp`);
      writeFileSync(tmp, op.content);
      renameSync(tmp, join(dir, op.file));
      index.set(op.file, `- [${op.file.replace(/\.md$/, "")}](${op.file}) — ${hookLine(op.content)}`);
    } else if (op.op === "delete") {
      rmSync(join(dir, op.file), { force: true });
      index.delete(op.file);
    } else {
      const tPath = join(dir, "tombstones.md");
      const prev = existsSync(tPath) ? readFileSync(tPath, "utf8").replace(/\n$/, "") + "\n" : "";
      const tmp = join(dir, ".tombstones.md.tmp");
      writeFileSync(tmp, `${prev}- ${op.text}\n`);
      renameSync(tmp, tPath);
    }
  }
  // Rebuild the index from the map + prune lines for files that no longer exist on disk.
  const onDisk = new Set(readdirSync(dir));
  const lines = [...index.entries()].filter(([f]) => onDisk.has(f)).map(([, l]) => l);
  const tmp = join(dir, ".MEMORY.md.tmp");
  writeFileSync(tmp, lines.length ? `# Assistant memory index\n\n${lines.join("\n")}\n` : `# Assistant memory index\n`);
  renameSync(tmp, indexPath);
}
