import { readFileSync, readdirSync, realpathSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrustStore } from "./trust";
import { storeHomeFor } from "./paths";
import { repoRootFor } from "./memory-dir";
import { linkedRouterSupportsRunHome } from "../runtime-sdk/run-home-support";
import { homedir } from "node:os";

/**
 * WS-21 (spec §3.4.2): the trusted project's `.winter/skills` dirs from `cwd` up to the repo root
 * (`repoRootFor`), NEAREST first, never above `$HOME` — the walk the router's run-home builder makes,
 * so `skills.list` names the same winners the run folder links.
 */
function projectSkillDirsNearestFirst(cwd: string): string[] {
  let dir: string;
  try { dir = realpathSync(cwd); } catch { dir = cwd; }
  let root: string;
  try { root = repoRootFor(dir); } catch { root = dir; }
  let home: string;
  try { home = realpathSync(homedir()); } catch { home = homedir(); }
  const out: string[] = [];
  for (let i = 0; i < 64; i++) {
    out.push(join(dir, ".winter", "skills"));
    if (dir === root || dir === home) break;
    const parent = dirname(dir);
    if (parent === dir || !(dir + sep).startsWith(root + sep)) break;
    dir = parent;
  }
  return out;
}
import { skillDenyRule } from "../settings";

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
 * The agent SDK's own name jails (`runtime/src/skills/frontmatter.ts`, pinned 0.0.17): a skill's
 * resolved name, and a plugin name. A name failing either is REFUSED by the child's index (with a
 * warning on its stderr), so it is never put in `Options.skills`: the SDK answers an unknown name
 * there with a warning and drops only that name (`validateSkillsOption`), which would be noise for a
 * skill the daemon already knows the child cannot index.
 */
const SDK_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SDK_PLUGIN_NAME_PATTERN = /^\.?[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Human names for the tiers the agent runtime cannot load yet — the subject of `sessionNote`.
 * `builtin` is the Winter-shipped tier (`packages/core/skills`).
 */
const UNDELIVERABLE_TIER_LABEL: Readonly<Record<Exclude<SkillMeta["source"], "plugin">, string>> = {
  project: "Project",
  user: "Your own",
  self: "Self-authored",
  builtin: "Built-in",
};

/**
 * Discovers SKILL.md skills from four sources, in precedence order (first occurrence of a name wins):
 *  - project: `<cwd>/.winter/skills/*`   — TRUST-GATED (only when `trust.isTrusted(cwd)`)
 *  - user:    `<store home>/skills/*`      — always (excludes the reserved `self/` subdir)
 *  - self:    `<store home>/skills/self/*` — always; written by `writeSelf`/`deleteSelf` below
 *    (the store home is `storeHomeFor(winterHome)`: `~/.winter/sdk` on a run-home build, WS-21)
 *  (WS-21, L4 request 2: the old `<home>/plugins/<plugin>/skills` tier is gone — a plugin's skills are
 *   claude-native content the runtimes load themselves, and `skills.list`'s plugin half comes from the
 *   plugin manager, lane L4's `plugins/plugin-skills.ts`)
 *  - builtin: `<repo>/packages/core/skills/*` — always, shipped in-repo; LAST, so any of the
 *    above can shadow a builtin of the same name (e.g. a user override of `writing-skills`)
 * Defensive throughout: malformed/missing/permission-denied skills are skipped, never thrown.
 */
export class SkillStore {
  private readonly winterHome: string;
  private readonly trust: TrustStore;
  private readonly bodyBytes: number;

  constructor(deps: { winterHome: string; trust: TrustStore; caps?: { bodyBytes?: number } }) {
    this.winterHome = deps.winterHome;
    this.trust = deps.trust;
    this.bodyBytes = deps.caps?.bodyBytes ?? 32768;
  }

  /**
   * All discovered skills (parsed, unfiltered by name), in precedence order.
   *
   * WS-21 (spec §3.4.1, F8): on a run-home build `skills.list` reports what a run folder carries, with
   * claude's clash rules — user, then self, then the trusted project's skill dirs walked from the cwd up
   * to the repo root (stopping at `$HOME`), NEAREST first; then builtin. Before that build (router
   * 0.0.11) the daemon's own order stands: project, user, self, builtin.
   */
  private discover(cwd: string | null): ScannedSkill[] {
    const all: ScannedSkill[] = [];
    const trustedProject = cwd !== null && this.trust.isTrusted(cwd);
    // WS-21: user and self skills live in the store home (`storeHomeFor`: `<home>/sdk/skills` on a
    // run-home build, `<home>/skills` before it).
    const userAndSelf = (): void => {
      all.push(...scanRoot(join(storeHomeFor(this.winterHome), "skills"), "user", USER_ROOT_EXCLUDE));
      all.push(...scanRoot(this.selfRoot(), "self"));
    };

    if (linkedRouterSupportsRunHome()) {
      userAndSelf();
      if (trustedProject) for (const dir of projectSkillDirsNearestFirst(cwd)) all.push(...scanRoot(dir, "project"));
    } else {
      if (trustedProject) all.push(...scanRoot(join(cwd, ".winter", "skills"), "project"));
      userAndSelf();
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

  /**
   * **Can a session actually load this skill?** — what `skills.list` reports per skill
   * (`loadsInSessions`/`sessionNote`), so no surface calls a skill usable that no session can load.
   * Independent of `Skill(<name>)` deny rules, which `skills.list` reports on their own (`denied`).
   *
   * WS-21: on a build whose router applies run homes, the run folder carries exactly the tiers the router
   * stages (`run-home/items.ts`): the user tier (`sdk/skills`), the self tier (`sdk/skills/self`) and a
   * TRUSTED project's `.winter/skills` (`skills.list` lists a project skill only for a trusted project) —
   * those load in Code sessions. The BUILTIN tier (`packages/core/skills/`, shipped with the daemon) is
   * staged by nobody: the router does not link it and neither runtime ships it, so it does not load, and
   * says so (R.1 ruling 3; staging builtins into run homes is a follow-up — pre-WS-21 they did not load in
   * sessions either). Before run homes (router 0.0.11), neither runtime has a door for bare-named host
   * skills, and the old plugin-view handover is retired (L4 request 2), so no tier reaches a child. A
   * `plugin` entry (lane L4's plugin half builds those) loads when its names pass the agent SDK's own
   * jails. One argument — the plugin eligibility set it used to take is gone with the handover.
   */
  sessionAvailability(meta: Pick<SkillMeta, "name" | "source">): { loadsInSessions: boolean; sessionNote?: string } {
    if (meta.source === "plugin") {
      const colon = meta.name.indexOf(":");
      const plugin = meta.name.slice(0, colon);
      if (colon <= 0 || !SDK_PLUGIN_NAME_PATTERN.test(plugin) || !SDK_SKILL_NAME_PATTERN.test(meta.name.slice(colon + 1))) {
        return { loadsInSessions: false, sessionNote: "The agent runtime refuses this name — plugin and skill names must be lowercase letters, digits and dashes." };
      }
      return { loadsInSessions: true };
    }
    if (linkedRouterSupportsRunHome()) {
      if (meta.source === "builtin") {
        return { loadsInSessions: false, sessionNote: "Built-in skills aren't staged into a session's run folder yet — a session can't load them." };
      }
      return { loadsInSessions: true };
    }
    return { loadsInSessions: false, sessionNote: `${UNDELIVERABLE_TIER_LABEL[meta.source]} skills can't be loaded by a session on this build — its runtimes have no door for them.` };
  }

  /** Root of the self-authored scope: `~/.winter/skills/self` — the same path `discover` scans as source "self". */
  private selfRoot(): string {
    return join(storeHomeFor(this.winterHome), "skills", "self");
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
