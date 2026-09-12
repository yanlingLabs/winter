#!/usr/bin/env bun
// Winter Phase 9b — the Norma→Winter codemod (P9b-1). The ONLY tool that performs the mechanical
// mass rename; fix lanes do semantic work afterwards.
//
//   bun scripts/rename/codemod.ts [--root <repo>] [--apply] [--content-only|--paths-only]
//                                  [--report <md>] [--json <json>]
//
// Universe: `git ls-files -z` of the root (tracked files only; symlinks skipped). Binaries (by
// extension or a NUL byte in the first 8 KiB) get PATH renames only. The content pass, per file:
//   1. protect every allowlisted literal with a placeholder (`allowlist.ts` RENAME_ALLOWLIST),
//   2. apply the explicit whole-token map (EXPLICIT_TOKEN_MAP — host/runtime vocabulary, SDK-export
//      collisions, the two string values),
//   3. the generic case-preserving replace `norma→winter` / `Norma→Winter` / `NORMA→WINTER`, never
//      when followed by `l`/`L` (normal*, abnormal) or `tiv` (normative),
//   4. restore the placeholders.
// The path pass renames every path component by the generic rule with `git mv` (directories
// shallowest-first, so ignored/untracked contents travel with their directory; then files),
// asserting the destination does not exist.
//
// Gates (computed BEFORE anything is written in --apply): every surviving `norma` match must be
// permitted by an allowlist entry (or sit in an EXEMPT path); no `winter[-_]?winter` /
// `WinterWinter` may exist in rewritten CONTENT outside scripts/rename/ nor in any planned
// destination PATH; no destination may already exist; the top-level `norma/` scaffold must already
// be deleted (P9b-2). A second run over the output reports zero changes (idempotent).
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BINARY_EXTENSIONS,
  DOUBLE_WINTER,
  EXEMPT_PATHS,
  EXPLICIT_TOKEN_MAP,
  RENAME_ALLOWLIST,
  TRAP_LOOKAHEAD,
  type AllowlistEntry,
} from "./allowlist";

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const GENERIC = new RegExp(`(norma|Norma|NORMA)${TRAP_LOOKAHEAD}`, "g");
const CASE_MAP: Record<string, string> = { norma: "winter", Norma: "Winter", NORMA: "WINTER" };
const PH_OPEN = "";
const PH_CLOSE = "";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-token regex for an explicit-map key: identifier boundaries, widened for dotted/hyphenated keys. */
export function explicitTokenRegex(from: string): RegExp {
  const plain = /^[A-Za-z0-9_]+$/.test(from);
  return plain
    ? new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(from)}(?![A-Za-z0-9_])`, "g")
    : new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegex(from)}(?![A-Za-z0-9_])`, "g"); // a trailing `-` is allowed: `norma-winter-<suffix>` test dirs → `winter-<suffix>`
}

/** Simple glob: `**` = any path, `*` = one segment; anchored. */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else re += escapeRegex(c);
  }
  return new RegExp(`^${re}$`);
}

export function entryAppliesTo(entry: AllowlistEntry, relPath: string): boolean {
  if (!entry.files) return true;
  return entry.files.some((g) => globToRegex(g).test(relPath));
}

export function isExemptPath(relPath: string): boolean {
  return EXEMPT_PATHS.some((p) => (p.endsWith("/") ? relPath.startsWith(p) : relPath === p));
}

export function isBinaryPath(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export interface Residue {
  line: number;
  col: number;
  match: string;
  context: string;
  permittedBy: string | "UNPERMITTED" | "EXEMPT";
}

export interface RewriteResult {
  out: string;
  changed: boolean;
  explicit: number;
  generic: number;
  protectedCount: number;
  residue: Residue[];
  doubleWinter: { line: number; match: string; context: string }[];
}

function lineCol(text: string, index: number): { line: number; col: number; context: string } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  const end = text.indexOf("\n", index);
  const context = text.slice(last, end < 0 ? undefined : end).trim().slice(0, 160);
  return { line, col: index - last + 1, context };
}

/** The content pass for one file. Pure; the caller decides whether to write. */
export function rewriteText(text: string, relPath: string): RewriteResult {
  const exempt = isExemptPath(relPath);
  const applicable = RENAME_ALLOWLIST.filter((e) => entryAppliesTo(e, relPath));
  let out = text;
  let explicit = 0;
  let generic = 0;
  let protectedCount = 0;

  if (!exempt) {
    // 1. protect
    const stash: string[] = [];
    for (const entry of applicable) {
      out = out.replace(entry.regex, (m) => {
        stash.push(m);
        protectedCount++;
        return `${PH_OPEN}${stash.length - 1}${PH_CLOSE}`;
      });
    }
    // 2. explicit map (longest keys first so a shorter key never eats a longer one)
    const ordered = [...EXPLICIT_TOKEN_MAP].sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of ordered) {
      out = out.replace(explicitTokenRegex(from), () => {
        explicit++;
        return to;
      });
    }
    // 3. generic
    out = out.replace(GENERIC, (m) => {
      generic++;
      return CASE_MAP[m] ?? m;
    });
    // 4. restore
    out = out.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"), (_m, n) => stash[Number(n)] ?? "");
  }

  // residue: every surviving norma, and what permits it
  const residue: Residue[] = [];
  const permittedRanges: { start: number; end: number; id: string }[] = [];
  for (const entry of applicable) {
    entry.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    const re = new RegExp(entry.regex.source, entry.regex.flags.includes("g") ? entry.regex.flags : entry.regex.flags + "g");
    while ((m = re.exec(out)) !== null) {
      permittedRanges.push({ start: m.index, end: m.index + m[0].length, id: entry.id });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  const survivors = /norma|Norma|NORMA/g;
  let s: RegExpExecArray | null;
  while ((s = survivors.exec(out)) !== null) {
    const idx = s.index;
    // trap tokens are not brand residue
    const after = out.slice(idx + 5, idx + 8);
    if (/^[lL]/.test(after) || after.startsWith("tiv")) continue;
    const hit = permittedRanges.find((r) => idx >= r.start && idx < r.end);
    const { line, col, context } = lineCol(out, idx);
    residue.push({ line, col, match: s[0], context, permittedBy: hit ? hit.id : exempt ? "EXEMPT" : "UNPERMITTED" });
  }

  const doubleWinter: RewriteResult["doubleWinter"] = [];
  if (!relPath.startsWith("scripts/rename/")) {
    const dw = new RegExp(DOUBLE_WINTER.source, "g");
    let d: RegExpExecArray | null;
    while ((d = dw.exec(out)) !== null) {
      const { line, context } = lineCol(out, d.index);
      doubleWinter.push({ line, match: d[0], context });
    }
  }

  return { out, changed: out !== text, explicit, generic, protectedCount, residue, doubleWinter };
}

/** One path component by the generic rule (explicit-map tokens are never path components). */
export function renameComponent(component: string): string {
  return component.replace(GENERIC, (m) => CASE_MAP[m] ?? m);
}

export function renamePath(relPath: string): string {
  return relPath.split("/").map(renameComponent).join("/");
}

/** P9b-2: the Phase-0 `norma/` scaffold is DELETED, never renamed — a paths run refuses while it is tracked. */
export function scaffoldPresent(paths: string[]): boolean {
  return paths.some((p) => p === "norma" || p.startsWith("norma/"));
}

/**
 * Plans the `git mv` sequence for a set of tracked paths: directories shallowest-first (each move
 * carries its subtree, tracked or not), re-deriving names after every move; then files whose
 * basename changes. Pure — returns the ordered moves.
 */
export function planMoves(paths: string[]): { from: string; to: string; kind: "dir" | "file" }[] {
  const moves: { from: string; to: string; kind: "dir" | "file" }[] = [];
  let current = [...paths];
  // directories
  for (;;) {
    const dirs = new Set<string>();
    for (const p of current) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    const candidates = [...dirs]
      .filter((d) => {
        const last = d.slice(d.lastIndexOf("/") + 1);
        return renameComponent(last) !== last;
      })
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    if (candidates.length === 0) break;
    const from = candidates[0]!;
    const to = `${from.slice(0, from.lastIndexOf("/") + 1)}${renameComponent(from.slice(from.lastIndexOf("/") + 1))}`;
    moves.push({ from, to, kind: "dir" });
    current = current.map((p) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p));
  }
  // files
  for (const p of current.sort()) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    const nb = renameComponent(base);
    if (nb !== base) moves.push({ from: p, to: `${p.slice(0, p.lastIndexOf("/") + 1)}${nb}`, kind: "file" });
  }
  return moves;
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

function git(root: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function trackedFiles(root: string): string[] {
  return git(root, ["ls-files", "-z"]).split("\0").filter((p) => p.length > 0);
}

function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

interface FileStat {
  path: string;
  kind: "text" | "binary" | "symlink" | "undecodable";
  explicit: number;
  generic: number;
  protectedCount: number;
  changed: boolean;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = resolve(opt("--root") ?? ".");
  const apply = argv.includes("--apply");
  const contentOnly = argv.includes("--content-only");
  const pathsOnly = argv.includes("--paths-only");
  const reportPath = opt("--report");
  const jsonPath = opt("--json");
  if (contentOnly && pathsOnly) throw new Error("--content-only and --paths-only are exclusive");

  const files = trackedFiles(root);
  const stats: FileStat[] = [];
  const residue: (Residue & { path: string })[] = [];
  const doubleWinter: { path: string; line: number; match: string; context: string }[] = [];
  const pendingWrites: { abs: string; out: string }[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  if (!pathsOnly) {
    for (const rel of files) {
      const abs = join(root, rel);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        stats.push({ path: rel, kind: "symlink", explicit: 0, generic: 0, protectedCount: 0, changed: false });
        continue;
      }
      if (isBinaryPath(rel)) {
        stats.push({ path: rel, kind: "binary", explicit: 0, generic: 0, protectedCount: 0, changed: false });
        continue;
      }
      const buf = readFileSync(abs);
      if (looksBinary(buf)) {
        stats.push({ path: rel, kind: "binary", explicit: 0, generic: 0, protectedCount: 0, changed: false });
        continue;
      }
      let text: string;
      try {
        text = decoder.decode(buf);
      } catch {
        stats.push({ path: rel, kind: "undecodable", explicit: 0, generic: 0, protectedCount: 0, changed: false });
        continue;
      }
      const r = rewriteText(text, rel);
      stats.push({ path: rel, kind: "text", explicit: r.explicit, generic: r.generic, protectedCount: r.protectedCount, changed: r.changed });
      for (const x of r.residue) residue.push({ ...x, path: rel });
      for (const d of r.doubleWinter) doubleWinter.push({ ...d, path: rel });
      if (r.changed) pendingWrites.push({ abs, out: r.out });
    }
  }

  const moves = contentOnly ? [] : planMoves(files);

  // Gates — evaluated before anything is written.
  const unpermitted = residue.filter((r) => r.permittedBy === "UNPERMITTED");
  const gateFailures: string[] = [];
  if (unpermitted.length > 0) gateFailures.push(`${unpermitted.length} UNPERMITTED residue match(es)`);
  if (doubleWinter.length > 0) gateFailures.push(`${doubleWinter.length} double-winter match(es)`);
  for (const m of moves) {
    if (existsSync(join(root, m.to))) gateFailures.push(`move destination exists: ${m.to}`);
    if (new RegExp(DOUBLE_WINTER.source).test(m.to)) gateFailures.push(`double-winter in a destination path: ${m.to}`);
  }
  if (!contentOnly && scaffoldPresent(files)) gateFailures.push("the top-level `norma/` scaffold is still tracked — `git rm -r norma` first (P9b-2); the tool never renames it");

  // Report
  const changedFiles = stats.filter((s) => s.changed);
  const totals = {
    tracked: files.length,
    text: stats.filter((s) => s.kind === "text").length,
    binary: stats.filter((s) => s.kind === "binary").length,
    symlink: stats.filter((s) => s.kind === "symlink").length,
    undecodable: stats.filter((s) => s.kind === "undecodable").length,
    changedFiles: changedFiles.length,
    explicit: stats.reduce((a, s) => a + s.explicit, 0),
    generic: stats.reduce((a, s) => a + s.generic, 0),
    protectedCount: stats.reduce((a, s) => a + s.protectedCount, 0),
    residue: residue.length,
    unpermitted: unpermitted.length,
    doubleWinter: doubleWinter.length,
    moves: moves.length,
    dirMoves: moves.filter((m) => m.kind === "dir").length,
  };
  const byEntry = new Map<string, number>();
  for (const r of residue) byEntry.set(r.permittedBy, (byEntry.get(r.permittedBy) ?? 0) + 1);
  const md: string[] = [];
  md.push(`# Norma→Winter codemod report — ${apply ? "APPLY" : "DRY-RUN"} (${new Date().toISOString()})`);
  md.push("");
  md.push(`root: \`${root}\`  mode: ${contentOnly ? "content-only" : pathsOnly ? "paths-only" : "content+paths"}`);
  md.push("");
  md.push("| total | value |\n| --- | --- |");
  for (const [k, v] of Object.entries(totals)) md.push(`| ${k} | ${v} |`);
  md.push("");
  md.push(`## Gates: ${gateFailures.length === 0 ? "PASS" : "FAIL — " + gateFailures.join("; ")}`);
  md.push("");
  md.push("## Residue by permitting entry");
  for (const [k, v] of [...byEntry.entries()].sort()) md.push(`- ${k}: ${v}`);
  md.push("");
  if (unpermitted.length > 0) {
    md.push("## UNPERMITTED residue");
    for (const r of unpermitted) md.push(`- ${r.path}:${r.line}:${r.col} \`${r.context}\``);
    md.push("");
  }
  if (doubleWinter.length > 0) {
    md.push("## Double-winter");
    for (const d of doubleWinter) md.push(`- ${d.path}:${d.line} \`${d.match}\` — \`${d.context}\``);
    md.push("");
  }
  md.push("## Permitted residue (full list)");
  for (const r of residue.filter((x) => x.permittedBy !== "UNPERMITTED")) md.push(`- [${r.permittedBy}] ${r.path}:${r.line} \`${r.context}\``);
  md.push("");
  md.push(`## Planned moves (${moves.length}; ${totals.dirMoves} directories)`);
  for (const m of moves) md.push(`- ${m.kind}: ${m.from} → ${m.to}`);
  md.push("");
  md.push("## Changed files (explicit/generic/protected)");
  for (const s of changedFiles) md.push(`- ${s.path} (${s.explicit}/${s.generic}/${s.protectedCount})`);
  const report = md.join("\n") + "\n";
  if (reportPath) writeFileSync(reportPath, report);
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ totals, gateFailures, residue, doubleWinter, moves, stats }, null, 2));
  console.log(md.slice(0, 22).join("\n"));

  if (gateFailures.length > 0) {
    console.error(`GATES FAILED: ${gateFailures.join("; ")}${apply ? " — nothing written" : ""}`);
    process.exit(1);
  }
  if (!apply) {
    console.log(`dry-run: ${pendingWrites.length} files would change; ${moves.length} moves planned`);
    process.exit(0);
  }

  // Apply: content first, then moves (the moves run on the same tree state the plan was computed from).
  for (const w of pendingWrites) writeFileSync(w.abs, w.out); // writeFileSync keeps the existing mode
  for (const m of moves) {
    if (existsSync(join(root, m.to))) throw new Error(`destination appeared during apply: ${m.to}`);
    git(root, ["mv", m.from, m.to]);
  }
  console.log(`applied: ${pendingWrites.length} files rewritten; ${moves.length} moves`);
}
