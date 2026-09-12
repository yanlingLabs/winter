import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrustStore } from "./trust";

// Phase 5c Task 3: `author?` mirrors T1's `author: winter` frontmatter stamp (writeSelf below) back
// out through list()/load() — additive on every interface (undefined for any skill written before
// this parse existed, or one that never carried the field, e.g. a project/user/plugin/builtin
// skill nobody stamped).
export interface SkillMeta { name: string; description: string; source: "project" | "user" | "self" | "plugin" | "builtin"; path: string; claudeFormat?: boolean; author?: string }
interface ParsedSkill { name: string; description: string; body: string; author?: string }
interface ScannedSkill extends ParsedSkill { source: SkillMeta["source"]; path: string; claudeFormat?: boolean }
/** Structural failure class, mirroring memory.ts's `MemoryErrorKind`/`MemoryResult` — no "trust"
 *  kind here: self-write is always against the local user's own store, never gated by project
 *  trust. Named (not inline) so ipc/server.ts's `skillErrorCode` can import it by type, same
 *  precedent as `MemoryErrorKind`. */
export type SkillErrorKind = "not_found" | "invalid";
export type SkillResult<T = void> = { ok: true; value: T } | { ok: false; error: string; kind?: SkillErrorKind };

const TRUNC = "\n[…truncated]";

/** Slug jail — same discipline as memory.ts's `nameError`, checked BEFORE any fs op touches a
 *  skill name: lowercase alnum + dash, 1-64 chars, no path separators/dots — rules out `../x`
 *  traversal, `a/b` nesting, `A_B` (case/underscore), over-length names, and "" in one shot.
 *  Unlike memory.ts, there is no reserved-name analog to "memory" (which collides with the
 *  MEMORY.md index): each skill lives in its own directory under self/, so there is no shared
 *  index file a skill name could clobber — this checks slug validity ONLY. */
function skillNameError(name: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? null : `invalid skill name "${name}"`;
}

/**
 * Root of the skills shipped in-repo, resolved relative to THIS module (not cwd, so it works
 * regardless of where the daemon is launched from). `fileURLToPath` — not `.pathname` — is
 * deliberate: `.pathname` percent-encodes reserved characters (this very repo lives under a path
 * containing spaces), and a raw `%20` in a filesystem path never matches the literal directory.
 * Depth is fixed at build time by this file's location (src/agent/skills.ts): two levels up
 * reaches packages/core/, alongside the shipped skills/ dir.
 */
const BUILTIN_ROOT = fileURLToPath(new URL("../../skills", import.meta.url));

/** Parse a SKILL.md: frontmatter (name, description) between the first ---…--- fence, then the body. null if invalid. */
function parseSkill(path: string, fallbackName: string): ParsedSkill | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null; // missing, or a directory named SKILL.md
    raw = readFileSync(path, "utf8");
  } catch { return null; } // missing / permission-denied / unreadable
  if (!raw.startsWith("---")) return null; // no frontmatter fence
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null; // unterminated fence
  const fm = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  let name = "";
  let description = "";
  let author = "";
  for (const line of fm.split("\n")) {
    const m = /^\s*(name|description|author)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (m[1] === "name") name = v; else if (m[1] === "description") description = v; else author = v;
  }
  if (!name) name = fallbackName;
  if (!name || !description) return null; // both required
  return { name, description, body, ...(author ? { author } : {}) };
}

/** Cap `s` to `maxBytes` UTF-8 bytes on a byte boundary, appending a truncation marker when cut. Mirrors context.ts's capBytes. */
function capBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  return buf.byteLength <= maxBytes ? s : buf.subarray(0, maxBytes).toString("utf8") + TRUNC;
}

/**
 * Spec §8 (Phase 4): skills from claude-format plugins are written for Claude Code's tool names.
 * The mapping is CONTEXT for the agent — Winter's permission gate, not the plugin tier, contains
 * what the skill convinces the agent to do. Prepended AFTER capBytes so it can never truncate.
 */
function compatPreamble(skillDir: string): string {
  return [
    "[compat] This skill was written for Claude Code. You are running under Winter — the equivalent tools are:",
    "- TodoWrite / TaskCreate / TaskUpdate → `task_create` / `task_update` / `task_list`",
    "- AskUserQuestion → `ask_user`",
    "- Task (subagent dispatch) → `spawn_agent`",
    "- EnterWorktree / ExitWorktree → `enter_worktree` / `exit_worktree`",
    "- NotebookEdit → `notebook_edit`",
    "- Skill → `Skill` (same name)",
    // Honest, not "(same behavior)" — the parity audit (docs/superpowers/research/
    // 2026-07-10-cc-tool-parity-audit.md P1-1) caught that overclaim: these are reduced variants,
    // and a skill relying on the differences must know.
    "- Read / Glob / Grep / Bash → `read` / `glob` / `grep` / `bash` — similar but NOT identical: `bash` runs SANDBOXED (no network; writes confined to approved directories), `read` returns plain text (no line numbers; very large files truncate), `grep` uses JS regex syntax",
    `Base directory for this skill: ${skillDir} — its scripts/ and relative references resolve against this path; run skill-internal scripts via bash as-is.`,
    "",
    "",
  ].join("\n");
}

/** Scan `<root>/<dir>/SKILL.md` for every immediate subdirectory of `root`, skipping names in `exclude`. Skips anything invalid; never throws. */
function scanRoot(root: string, source: SkillMeta["source"], exclude?: Set<string>): ScannedSkill[] {
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; } // root missing / unreadable
  const out: ScannedSkill[] = [];
  for (const dir of dirs) {
    if (exclude?.has(dir)) continue;
    const path = join(root, dir, "SKILL.md");
    const parsed = parseSkill(path, dir);
    if (parsed) out.push({ ...parsed, source, path });
  }
  return out;
}

const USER_ROOT_EXCLUDE = new Set(["self"]); // the self/ subdir is scanned separately, as source "self"

/**
 * Discovers SKILL.md skills from five sources, in precedence order (first occurrence of a name wins):
 *  - project: `<cwd>/.winter/skills/*`   — TRUST-GATED (only when `trust.isTrusted(cwd)`)
 *  - user:    `~/.winter/skills/*`       — always (excludes the reserved `self/` subdir)
 *  - self:    `~/.winter/skills/self/*`  — always; written by `writeSelf`/`deleteSelf` below
 *  - plugin:  `~/.winter/plugins/<plugin>/skills/<skill>` — always, namespaced `<plugin>:<skill>`
 *  - builtin: `<repo>/packages/core/skills/*` — always, shipped in-repo; LAST, so any of the
 *    above can shadow a builtin of the same name (e.g. a user override of `writing-skills`)
 * Defensive throughout: malformed/missing/permission-denied skills are skipped, never thrown.
 */
export class SkillStore {
  private readonly winterHome: string;
  private readonly trust: TrustStore;
  private readonly bodyBytes: number;
  private readonly disabledPlugins: string[];

  constructor(deps: { winterHome: string; trust: TrustStore; caps?: { bodyBytes?: number }; plugins?: { disabled?: string[] } }) {
    this.winterHome = deps.winterHome;
    this.trust = deps.trust;
    this.bodyBytes = deps.caps?.bodyBytes ?? 32768;
    this.disabledPlugins = deps.plugins?.disabled ?? [];
  }

  /** All discovered skills (parsed, unfiltered by name), in precedence order: project, user, self, plugin, builtin. */
  private discover(cwd: string | null): ScannedSkill[] {
    const all: ScannedSkill[] = [];

    if (cwd && this.trust.isTrusted(cwd)) {
      all.push(...scanRoot(join(cwd, ".winter", "skills"), "project"));
    }

    all.push(...scanRoot(join(this.winterHome, "skills"), "user", USER_ROOT_EXCLUDE));
    all.push(...scanRoot(join(this.winterHome, "skills", "self"), "self"));

    let plugins: string[] = [];
    try {
      plugins = readdirSync(join(this.winterHome, "plugins"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* no plugins dir */ }
    for (const plugin of plugins) {
      if (this.disabledPlugins.includes(plugin)) continue;
      const claudeFormat = existsSync(join(this.winterHome, "plugins", plugin, ".claude-plugin", "plugin.json")) || undefined;
      for (const s of scanRoot(join(this.winterHome, "plugins", plugin, "skills"), "plugin")) {
        all.push({ ...s, name: `${plugin}:${s.name}`, ...(claudeFormat ? { claudeFormat } : {}) }); // the one place plugin names get namespaced
      }
    }

    all.push(...scanRoot(BUILTIN_ROOT, "builtin")); // last: shadowable by any other source above

    return all;
  }

  /** Lists all visible skills for `cwd` (project skills only when trusted). First occurrence wins on name collisions. */
  list(input: { cwd: string | null }): SkillMeta[] {
    const seen = new Set<string>();
    const out: SkillMeta[] = [];
    for (const s of this.discover(input.cwd)) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({
        name: s.name, description: s.description, source: s.source, path: s.path,
        ...(s.claudeFormat ? { claudeFormat: s.claudeFormat } : {}),
        ...(s.author ? { author: s.author } : {}),
      });
    }
    return out;
  }

  /** Loads a skill's body (frontmatter stripped, byte-capped) by name, respecting the same trust gate and precedence as `list`. */
  load(name: string, input: { cwd: string | null }): { name: string; body: string } | null {
    for (const s of this.discover(input.cwd)) {
      if (s.name === name) {
        const body = capBytes(s.body, this.bodyBytes);
        return { name: s.name, body: s.claudeFormat ? compatPreamble(dirname(s.path)) + body : body };
      }
    }
    return null;
  }

  /** Root of the self-authored scope: `~/.winter/skills/self` — the same path `discover` scans as source "self". */
  private selfRoot(): string {
    return join(this.winterHome, "skills", "self");
  }

  /**
   * Writes (or overwrites) a self-authored skill at `self/<name>/SKILL.md`. Overwrite-is-edit: an
   * existing dir is written in place, no merge. The frontmatter (`name`, `description`,
   * `author: winter`) is stamped by the STORE and written FIRST; `body` is concatenated verbatim
   * AFTER that block's closing fence — so a body containing frontmatter-looking text (an
   * author-spoof attempt) can never override the stamp: `parseSkill` stops at the FIRST closing
   * fence it finds, which is always this one, never something embedded later in the body.
   */
  async writeSelf(input: { name: string; description: string; body: string }): Promise<SkillResult> {
    const invalid = skillNameError(input.name);
    if (invalid) return { ok: false, error: invalid, kind: "invalid" };
    // Same normalization + reject-if-empty-after as memory.ts's doWrite: a raw description of " "
    // or "\n" passes a wire schema's min(1) but collapses to "" here, and an empty description is
    // exactly what `parseSkill` treats as invalid (returns null) — so list()/load() would silently
    // drop the skill this call just reported ok:true for.
    const description = input.description.split(/\r?\n/).join(" ").trim();
    if (!description) return { ok: false, error: `skill "${input.name}" needs a non-empty description`, kind: "invalid" };
    const dir = join(this.selfRoot(), input.name);
    try {
      mkdirSync(dir, { recursive: true });
      const content = `---\nname: ${input.name}\ndescription: ${description}\nauthor: winter\n---\n\n${input.body}`;
      writeFileSync(join(dir, "SKILL.md"), content, "utf8");
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: `failed to write skill "${input.name}": ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Removes a self-authored skill's entire directory (recursive — SKILL.md plus any scripts/
   * assets it owns). The prefix check re-verifies the resolved `dir` actually lands under self/
   * even though the slug jail above already forbids "/" and "." in `name` (so `dir` can only ever
   * be a direct child of `selfRoot()`) — a RECURSIVE delete is unforgiving of a future regex
   * loosening in a way memory.ts's single-file `unlinkSync` is not, so this is the one guard
   * standing between that and an `rm -rf` outside self/.
   */
  async deleteSelf(name: string): Promise<SkillResult> {
    const invalid = skillNameError(name);
    if (invalid) return { ok: false, error: invalid, kind: "invalid" };
    const root = this.selfRoot();
    const dir = join(root, name);
    if (dir !== root && !dir.startsWith(root + sep)) return { ok: false, error: `invalid skill name "${name}"`, kind: "invalid" };
    if (!existsSync(dir)) return { ok: false, error: `skill "${name}" not found`, kind: "not_found" };
    try {
      rmSync(dir, { recursive: true, force: true });
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: `failed to delete skill "${name}": ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
