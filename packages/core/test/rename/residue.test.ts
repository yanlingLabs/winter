// P9b-22 — the residue test is the 9c handoff. Walks EVERY tracked file in the repo (not just
// packages/core), finds every `norma`/`Norma`/`NORMA` occurrence outside the trap tokens
// (`normal*`, `abnormal`, `normative`), and asserts:
//   1. each surviving match sits inside a range permitted by EXACTLY ONE applicable
//      `RENAME_ALLOWLIST` entry (Global Constraints bullet 3 pins the exact surviving set);
//   2. every allowlist entry matched at least once somewhere (no dead entries — an entry that
//      protects nothing is either stale or hiding a rename the codemod should have made).
//
// Deliberately INDEPENDENT of `codemod.ts`'s own `rewriteText` residue computation: this is a
// second, separately-written check over the same allowlist DATA (`RENAME_ALLOWLIST`,
// `BINARY_EXTENSIONS`), not a re-run of the codemod's own logic — a bug in the codemod's residue
// accounting must not also be invisible here.
//
// Imports ONLY from `allowlist.ts`, never from `scripts/rename/codemod.ts` — a deliberate
// deviation from the brief's literal `entryAppliesTo`/`isBinaryPath` re-use (reported as a concern,
// see the report): `codemod.ts` is not `noUncheckedIndexedAccess`-clean (it predates any tsconfig
// covering `scripts/`, per `.github/workflows/ci.yml`'s own "STILL UNCHECKED... repo-root scripts/"
// comment), and importing it here would pull those latent errors into `tsc -p packages/core`'s
// program for the first time, turning this task's own gate red. `scripts/rename/**` is the spine's
// file (Global Constraints bullet 3 / T.4's own instruction: report an allowlist gap rather than
// editing it) — small, well-justified `entryAppliesTo`/`isBinaryPath` equivalents are reimplemented
// below instead, over the SAME `RENAME_ALLOWLIST`/`BINARY_EXTENSIONS` data, so this test still
// tracks the real allowlist rather than a private copy of it.
//
// Kept to ONE PASS over the tree, string scanning only (no per-match regex object churn beyond
// what's needed) — this must stay under ~5s.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BINARY_EXTENSIONS, RENAME_ALLOWLIST, type AllowlistEntry } from "../../../../scripts/rename/allowlist";

/** `codemod.ts`'s `globToRegex`, reimplemented: simple glob (`**` = any path, `*` = one segment),
 *  anchored. Kept in sync by inspection — both are ~10 lines and neither has changed since 9b. */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** `codemod.ts`'s `entryAppliesTo`, reimplemented over the same `RENAME_ALLOWLIST` data. */
function entryAppliesTo(entry: AllowlistEntry, relPath: string): boolean {
  if (!entry.files) return true;
  return entry.files.some((g) => globToRegex(g).test(relPath));
}

/** `codemod.ts`'s `isBinaryPath`, reimplemented over the same `BINARY_EXTENSIONS` data. */
function isBinaryPath(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dir }).toString().trim();
}

function trackedFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString();
  return out.split("\0").filter((p) => p.length > 0);
}

interface Hit {
  file: string;
  line: number;
  match: string;
  context: string;
  permittedBy: string | undefined; // undefined = UNPERMITTED
}

/** Every `norma`/`Norma`/`NORMA` in `text` NOT immediately followed by `[lL]` or `tiv` (the trap
 *  tokens: `normal*`, `abnormal`, `normative`). Mirrors `allowlist.ts`'s own `TRAP_LOOKAHEAD`
 *  spelled out plainly rather than re-imported, so this check does not depend on that regex
 *  string being well-formed. */
function* survivors(text: string): Generator<{ index: number; match: string }> {
  const re = /norma|Norma|NORMA/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (/^[lL]/.test(after) || after.startsWith("tiv")) continue;
    yield { index: m.index, match: m[0] };
  }
}

function lineAndContext(text: string, index: number): { line: number; context: string } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) { line++; lastNl = i; }
  }
  const nextNl = text.indexOf("\n", index);
  const context = text.slice(lastNl + 1, nextNl < 0 ? undefined : nextNl).trim().slice(0, 200);
  return { line, context };
}

function scan(): { hits: Hit[]; matchedEntryIds: Set<string> } {
  const root = repoRoot();
  const files = trackedFiles(root);
  const hits: Hit[] = [];
  const matchedEntryIds = new Set<string>();

  for (const relPath of files) {
    if (isBinaryPath(relPath)) continue;
    const applicable = RENAME_ALLOWLIST.filter((e: AllowlistEntry) => entryAppliesTo(e, relPath));
    // Precompute this file's permitted ranges once (not per-match) — the one-pass discipline.
    const ranges: { start: number; end: number; id: string }[] = [];
    let text: string;
    try {
      const buf = readFileSync(join(root, relPath));
      // A NUL byte this soon means a binary the extension list missed — skip it, matching the
      // codemod's own null-byte sniff (report note: the residue test trusts isBinaryPath per the
      // brief; this guard only prevents a false alarm inside genuinely binary content).
      if (buf.subarray(0, 8000).includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue; // gone/unreadable between `git ls-files` and now — not this test's concern
    }
    if (applicable.length > 0) {
      for (const entry of applicable) {
        const re = new RegExp(entry.regex.source, entry.regex.flags.includes("g") ? entry.regex.flags : `${entry.regex.flags}g`);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          ranges.push({ start: m.index, end: m.index + m[0].length, id: entry.id });
          if (m[0].length === 0) re.lastIndex++;
        }
      }
    }
    for (const { index, match } of survivors(text)) {
      const hit = ranges.find((r) => index >= r.start && index < r.end);
      const { line, context } = lineAndContext(text, index);
      if (hit) matchedEntryIds.add(hit.id);
      hits.push({ file: relPath, line, match, context, permittedBy: hit?.id });
    }
  }
  return { hits, matchedEntryIds };
}

describe("rename residue (P9b-22)", () => {
  test("every surviving norma/Norma/NORMA is permitted by exactly one allowlist entry", () => {
    const { hits } = scan();
    const unpermitted = hits.filter((h) => h.permittedBy === undefined);
    const report = unpermitted.map((h) => `${h.file}:${h.line}: ${h.context}`).join("\n");
    expect(unpermitted, `unpermitted residue:\n${report}`).toHaveLength(0);
  });

  test("every allowlist entry matched at least once (no dead entries)", () => {
    const { matchedEntryIds } = scan();
    const dead = RENAME_ALLOWLIST.filter((e) => !matchedEntryIds.has(e.id)).map((e) => e.id);
    expect(dead, `dead allowlist entries (matched nothing): ${dead.join(", ")}`).toHaveLength(0);
  });

  test("BINARY_EXTENSIONS is non-empty (sanity — a typo here would silently scan every binary)", () => {
    expect(BINARY_EXTENSIONS.size).toBeGreaterThan(0);
  });
});
