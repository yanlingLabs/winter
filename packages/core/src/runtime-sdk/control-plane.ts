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
 * The tool names whose input this fence inspects — the WRITE class, in both vocabularies.
 *
 * **Reads are deliberately absent.** CLAUDE.md's tool-surface rule is that read/glob/grep/ls have
 * no path fence at all (the sole read denial is `~/.norma/run`, which the daemon applies through
 * its own denylist); P8b-27(b)'s "any tool input naming a path" is about what a call can WRITE, and
 * widening it to `Read` would quietly reverse a deliberate, documented product decision.
 *
 * `MultiEdit` has no Norma counterpart (Norma's `edit` is single-file) but is a Winter built-in that
 * writes, so it is fenced under its Winter name alone.
 */
export const WRITE_CLASS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write", "edit", "notebook_edit",                 // Norma
  "Write", "Edit", "MultiEdit", "NotebookEdit",     // Winter
]);

/** Every field a write-class tool might name its target in, across both vocabularies: Norma's
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
 *  - **project-INDEPENDENT.** The agent must never write ANY `<any>/.norma/permissions.local.json`,
 *    whichever project owns it: a broad `Edit(<parent>)` grant folds a SIBLING project's tree into
 *    the writable set, and a check anchored to this session's own project returned "not my store".
 *  - **case-folded on both spellings.** macOS's default volume is case-insensitive but
 *    case-preserving, so `.norma/Permissions.Local.json` and `.NORMA/...` reach the same file the
 *    reader opens. The PRE-resolution parent is tested first (catches a write through a symlink
 *    NAMED `.norma`, which canonicalization would resolve away), then the canonicalized one
 *    (catches a real `.../.norma/...` reached through a differently-named link or `..` games).
 *  - **matches by FILENAME, never by directory** — `.norma/` itself stays writable, which is what
 *    keeps the MEMDIR (`<home>/projects/<key>/memory/*.md`) and `$OUTDIR` (`<home>/outputs/<sid>`)
 *    agent-writable. Both are deliberate, shipped, agent-writable exceptions under NORMA_HOME.
 *
 * `null` for a malformed/unresolvable path — the caller decides from there.
 */
export function controlPlaneFileTarget(path: string, cwd: string): { path: string; canonical: string } | null {
  if (!path) return null;
  const raw0 = isAbsolute(path) ? resolve(path) : resolve(cwd || "/", path);
  // Cheap, syscall-free early-out: a target whose filename isn't SOME casing of a control-plane
  // filename can never be one, whatever its parent resolves to.
  if (!CONTROL_PLANE_FILENAMES.has(basename(raw0).toLowerCase())) return null;
  if (basename(dirname(raw0)).toLowerCase() === ".norma") {
    try { return { path, canonical: canonicalizeForWrite(resolveLeafSymlinks(raw0)) }; }
    catch { return { path, canonical: raw0 }; }   // still a confirmed match; report the raw target
  }
  try {
    const canonical = canonicalizeForWrite(resolveLeafSymlinks(raw0));
    return basename(dirname(canonical)).toLowerCase() === ".norma" ? { path, canonical } : null;
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
 * covers what its pattern covers: it is Norma's own invariant, enforced in Norma's own vocabulary,
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
): { path: string; canonical: string } | null {
  if (!WRITE_CLASS_TOOL_NAMES.has(toolName)) return null;
  for (const p of writeTargetPathsIn(input)) {
    const hit = controlPlaneFileTarget(p, cwd);
    if (hit) return hit;
  }
  return null;
}

/** The message a fenced call hands back to the model — `engine.ts:4370`'s own text, with the tool
 *  named as the model called it. */
export function controlPlaneDenialMessage(toolName: string, path: string): string {
  return `cannot ${toolName} ${path}: the permission rules store can only be changed by answering an approval card (or editing it yourself)`;
}
