import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonicalizeForWrite, resolveLeafSymlinks } from "../agent/paths";

/**
 * The filenames that are NEVER an agent write target, whichever project owns them. A LITERAL copy
 * of `engine.ts:678`'s private `CONTROL_PLANE_FILENAMES` — the rules store plus the two per-project
 * settings overlays whose `permissions.allow` feeds the live gate. Writing any of them is a
 * self-grant.
 */
export const CONTROL_PLANE_FILENAMES: ReadonlySet<string> = new Set([
  "permissions.local.json",
  "settings.json",
  "settings.local.json",
]);

/**
 * WS-21 (spec §7.1): the project-scope files a runtime reads from a TRUSTED project's `.winter/` that are
 * as much a self-grant as the three above — `mcp.json` (the project's MCP servers: a command the next
 * child runs) and any `settings*.json` (claude reads `settings.json` and `settings.local.json`; the glob
 * is the spec's, so a future tier is covered before it exists). Fenced for the write TOOLS by name under
 * a `.winter` parent, exactly like `CONTROL_PLANE_FILENAMES` — but NOT added to that set, which also
 * feeds the escape floor's ANY-mention list (`ESCAPE_FENCED_FILENAMES`), where §7.1 asks for a
 * write-shaped match only (`hooks.ts`'s `PROJECT_WRITE_FENCED`).
 */
export function isProjectControlFilename(lowercasedName: string): boolean {
  return CONTROL_PLANE_FILENAMES.has(lowercasedName) || lowercasedName === "mcp.json" || /^settings[^/]*\.json$/.test(lowercasedName);
}

/**
 * The tool names whose input this fence inspects — the WRITE class, in both vocabularies.
 *
 * **Reads are deliberately absent.** CLAUDE.md's tool-surface rule is that read/glob/grep/ls have
 * no path fence at all (the sole read denial is `~/.winter/run`, which the daemon applies through
 * its own denylist); P8b-27(b)'s "any tool input naming a path" is about what a call can WRITE, and
 * widening it to `Read` would quietly reverse a deliberate, documented product decision.
 *
 * `MultiEdit` has no Winter counterpart (Winter's `edit` is single-file) but is a Winter built-in that
 * writes, so it is fenced under its Winter name alone.
 */
export const WRITE_CLASS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write", "edit", "notebook_edit",                 // Winter
  "Write", "Edit", "MultiEdit", "NotebookEdit",     // Winter
]);

/** Every field a write-class tool might name its target in, across both vocabularies: Winter's
 *  `path`/`notebook_path` and Winter/CC's `file_path`/`notebook_path`. `MultiEdit` additionally
 *  carries `edits: [{ file_path }]`, drained below. */
const PATH_FIELDS = ["file_path", "path", "notebook_path", "filePath", "notebookPath"] as const;

/** Every path a write-class call names, in the order they appear. Best-effort and never throwing:
 *  a malformed input yields no paths, which leaves the normal dispatch chain to decide — the same
 *  fail-open-to-the-next-check shape `engine.ts`'s own extraction has. */
export function writeTargetPathsIn(input: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v !== "") out.push(v); };
  if (typeof input !== "object" || input === null) return out;
  const rec = input as Record<string, unknown>;
  for (const f of PATH_FIELDS) push(rec[f]);
  // MultiEdit's per-edit targets — a batch whose FIRST edit is innocent and whose second writes the
  // rules store must not pass because only the top level was inspected.
  const edits = rec.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (typeof e !== "object" || e === null) continue;
      const er = e as Record<string, unknown>;
      for (const f of PATH_FIELDS) push(er[f]);
    }
  }
  return out;
}

/**
 * **Is this path some project's control-plane file?** A literal copy of `engine.ts:739`'s private
 * `controlPlaneFileTarget`, minus its call-shape parsing (which `writeTargetPathsIn` above now does
 * for both vocabularies). Every subtlety in the original is preserved deliberately — see that
 * function's own doc comment for the full history; the short version:
 *
 *  - **project-INDEPENDENT.** The agent must never write ANY `<any>/.winter/permissions.local.json`,
 *    whichever project owns it: a broad `Edit(<parent>)` grant folds a SIBLING project's tree into
 *    the writable set, and a check anchored to this session's own project returned "not my store".
 *  - **case-folded on both spellings.** macOS's default volume is case-insensitive but
 *    case-preserving, so `.winter/Permissions.Local.json` and `.WINTER/...` reach the same file the
 *    reader opens. The PRE-resolution parent is tested first (catches a write through a symlink
 *    NAMED `.winter`, which canonicalization would resolve away), then the canonicalized one
 *    (catches a real `.../.winter/...` reached through a differently-named link or `..` games).
 *  - **matches by FILENAME, never by directory** — `.winter/` itself stays writable, which is what
 *    keeps the MEMDIR (`<home>/projects/<key>/memory/*.md`) and `$OUTDIR` (`<home>/outputs/<sid>`)
 *    agent-writable. Both are deliberate, shipped, agent-writable exceptions under WINTER_HOME.
 *
 * `null` for a malformed/unresolvable path — the caller decides from there.
 */
export function controlPlaneFileTarget(path: string, cwd: string): { path: string; canonical: string } | null {
  if (!path) return null;
  const raw0 = isAbsolute(path) ? resolve(path) : resolve(cwd || "/", path);
  // Cheap, syscall-free early-out: a target whose filename isn't SOME casing of a control-plane
  // filename can never be one, whatever its parent resolves to.
  if (!isProjectControlFilename(basename(raw0).toLowerCase())) return null;
  if (basename(dirname(raw0)).toLowerCase() === ".winter") {
    try { return { path, canonical: canonicalizeForWrite(resolveLeafSymlinks(raw0)) }; }
    catch { return { path, canonical: raw0 }; }   // still a confirmed match; report the raw target
  }
  try {
    const canonical = canonicalizeForWrite(resolveLeafSymlinks(raw0));
    return basename(dirname(canonical)).toLowerCase() === ".winter" ? { path, canonical } : null;
  } catch { return null; }
}

/**
 * **The bridge's control-plane fence** (P8b-27b): the first control-plane target a write-class call
 * names, or `null`.
 *
 * Applied in `canUseToolFor` BEFORE the gate and under EVERY policy — `bypass` included, and
 * `auto`/`acceptEdits` especially, since those are the modes where a Winter child's write never
 * reaches a human at all.
 *
 * **Why a host-side fence at all, when `buildWinterOptions` also passes deny rules?** Not because a
 * deny rule is weak — the opposite. A matched stage-2 deny returns `decision: "deny"` outright
 * (`permissions/evaluator.ts:1350-1364` at `v0.0.3`) and runs BEFORE the mode stage (`:1008`), so it
 * binds under `bypassPermissions` too and **never reaches `canUseTool`**. (An earlier revision of
 * this comment claimed the reverse; it was wrong.) The host fence exists because a deny rule only
 * covers what its pattern covers: it is Winter's own invariant, enforced in Winter's own vocabulary,
 * on both tool-name spellings, over every path-bearing field including `MultiEdit`'s nested
 * `edits[]` — and it does not depend on Winter's rule grammar continuing to mean what it means
 * today. Two independent layers over one invariant, which is the right number for a self-grant.
 *
 * `cwd` resolves a relative target the way the call itself would.
 */
export function controlPlaneTargetForCall(
  toolName: string,
  input: unknown,
  cwd: string,
  fence?: HomeFence,
): { path: string; canonical: string; home?: true } | null {
  if (!WRITE_CLASS_TOOL_NAMES.has(toolName)) return null;
  for (const p of writeTargetPathsIn(input)) {
    const hit = controlPlaneFileTarget(p, cwd) ?? (fence === undefined ? null : homeFenceTarget(p, cwd, fence));
    if (hit) return hit;
  }
  return null;
}

/**
 * The home half of the fence (whole-branch review 2026-09-23, lane C): the SAME targets the Bash
 * sandbox's `denyWrite` names, handed in by the caller as `home-fence.ts`'s `homeFenceFor(home)` —
 * this file stays a leaf, which is why the list arrives as data. Before this, the write TOOLS were
 * fenced only on the three filenames here, with the directories left to the deny rules alone, so the
 * "two independent layers over one invariant" this file's doc claims held for the filenames only.
 */
export interface HomeFence {
  /** Absolute directories: a target equal to one, or under one, is fenced. */
  dirs: readonly string[];
  /** Absolute files, matched exactly. */
  files: readonly string[];
  /** Path segments fenced wherever they appear (`.winter/agents/`). */
  segments: readonly string[];
}

/** A write target the home fence covers, or `null`. Case-folded, and tested on the raw spelling AND
 *  the canonical one (a symlink into a fenced dir, or `..` games), like `controlPlaneFileTarget`. */
export function homeFenceTarget(path: string, cwd: string, fence: HomeFence): { path: string; canonical: string; home: true } | null {
  if (!path) return null;
  const raw = isAbsolute(path) ? resolve(path) : resolve(cwd || "/", path);
  let canonical = raw;
  try { canonical = canonicalizeForWrite(resolveLeafSymlinks(raw)); } catch { /* the raw spelling is still tested */ }
  const canonDir = (d: string): string[] => {
    const out = [resolve(d)];
    try { out.push(canonicalizeForWrite(resolve(d))); } catch { /* not creatable/resolvable: the literal spelling stands */ }
    return out.map((x) => x.toLowerCase());
  };
  const dirs = fence.dirs.flatMap(canonDir);
  const files = fence.files.flatMap(canonDir);
  for (const candidate of new Set([raw.toLowerCase(), canonical.toLowerCase()])) {
    if (dirs.some((d) => candidate === d || candidate.startsWith(`${d}/`))) return { path, canonical, home: true };
    if (files.includes(candidate)) return { path, canonical, home: true };
    const withSlash = `${candidate}/`;
    if (fence.segments.some((s) => withSlash.includes(`/${s.toLowerCase()}`))) return { path, canonical, home: true };
  }
  return null;
}

/** The message a fenced call hands back to the model — `engine.ts:4370`'s own text, with the tool
 *  named as the model called it. */
export function controlPlaneDenialMessage(toolName: string, path: string, home?: boolean): string {
  if (home === true) {
    return `cannot ${toolName} ${path}: Winter's own state (its runtimes, plugins, approved rules, cache, agent definitions and directory trust) is never written by a tool — only by Winter itself or by you`;
  }
  if (basename(path).toLowerCase() === "mcp.json") {
    return `cannot ${toolName} ${path}: a project's MCP server list is changed with \`winter mcp add --scope project\` (or by editing it yourself), never by a tool`;
  }
  return `cannot ${toolName} ${path}: the permission rules store can only be changed by answering an approval card (or editing it yourself)`;
}
