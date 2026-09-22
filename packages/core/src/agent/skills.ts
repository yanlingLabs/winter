import { readFileSync, readdirSync, readlinkSync, lstatSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SdkPluginConfig } from "@yanlinglabs/winter-agent-sdk";
import type { TrustStore } from "./trust";
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
 * warning on its stderr), so it is never put in `Options.skills` — naming an unindexed skill there
 * fails the option's validation for the whole list.
 */
const SDK_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SDK_PLUGIN_NAME_PATTERN = /^\.?[a-z0-9][a-z0-9-]{0,63}$/;

/** Where the daemon keeps the skills-only plugin views it hands a child (`childSkillSurface`). */
export function skillPluginViewsRoot(winterHome: string): string {
  return join(winterHome, "runtimes", "skill-plugins");
}

/**
 * Build (or repair) the skills-only view of ONE plugin: `<views>/<plugin>/` holding exactly one
 * entry, `skills` — a symlink to `<home>/plugins/<plugin>/skills`. Returns the view root.
 *
 * WHY A VIEW AND NOT THE PLUGIN'S OWN DIRECTORY. The SDK's `loadPlugins` takes a plugin whole: its
 * manifest's `hooks` (command hooks run by the child, outside the Bash sandbox), `agents/*.md`,
 * `commands/*.md` and — unless `skipMcpDiscovery` — its MCP config, and it NAMES the plugin by the
 * manifest's `name` when there is one. The daemon's plugin model grants none of that without the
 * user's consent (`winter-plugin.json`'s exec class) and qualifies skills by DIRECTORY name. A view
 * with no manifest and nothing but `skills` gives the child exactly the daemon's skills, under
 * exactly the daemon's names, and nothing else.
 *
 * UNDER `<home>/runtimes`, deliberately: that tree is fenced from every tool on both legs (the
 * `Write`/`Edit` deny rules and the Bash sandbox's `denyWrite`, `mode-options.ts`), so a session
 * cannot plant a manifest in a view and have the NEXT incarnation's child run its hooks. The child
 * itself reads the files, not a tool, so the matching read fence does not get in the Skill tool's way.
 * Rebuilt on every call anyway — anything but the one `skills` link is removed and a re-pointed
 * link is replaced — so the view is a function of `<home>/plugins`, never of what was left in it.
 * Removal never follows a link (measured on Bun: `rmSync(…, { recursive: true })` unlinks a symlink,
 * nested or not, and leaves its target alone; the `skills` link itself is `unlinkSync`ed).
 *
 * Synchronous from first line to last: the daemon is the only writer and a single JS thread, so two
 * incarnations opening together can never interleave inside it. `null` when the filesystem refuses.
 */
function ensureSkillPluginView(winterHome: string, plugin: string): string | null {
  const root = join(skillPluginViewsRoot(winterHome), plugin);
  const link = join(root, "skills");
  const target = join(winterHome, "plugins", plugin, "skills");
  try {
    mkdirSync(root, { recursive: true });
    for (const entry of readdirSync(root)) {
      if (entry !== "skills") rmSync(join(root, entry), { recursive: true, force: true });
    }
    let current: string | undefined;
    try { current = readlinkSync(link); } catch { /* absent, or not a symlink */ }
    if (current === target) return root;
    // A stale LINK is unlinked (never followed — the directory it points at is the user's own
    // plugin); anything else under that name is not the daemon's and is removed outright.
    let stale: ReturnType<typeof lstatSync> | undefined;
    try { stale = lstatSync(link); } catch { /* absent */ }
    if (stale?.isSymbolicLink()) unlinkSync(link);
    else if (stale !== undefined) rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
    return root;
  } catch {
    return null;
  }
}

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
  private readonly disabledPlugins: () => readonly string[];

  /**
   * `plugins.disabled` may be a LIVE getter (production: `settings.plugins.disabled` over the daemon's
   * reassignable settings holder), so disabling a plugin reaches the skill list — and the next child's
   * `Options.plugins` — with no daemon restart. A bare array (every older caller) is a fixed list.
   */
  constructor(deps: { winterHome: string; trust: TrustStore; caps?: { bodyBytes?: number }; plugins?: { disabled?: readonly string[] | (() => readonly string[]) } }) {
    this.winterHome = deps.winterHome;
    this.trust = deps.trust;
    this.bodyBytes = deps.caps?.bodyBytes ?? 32768;
    const disabled = deps.plugins?.disabled;
    this.disabledPlugins = typeof disabled === "function" ? disabled : () => disabled ?? [];
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
    const disabledPlugins = this.disabledPlugins();
    for (const plugin of plugins) {
      if (disabledPlugins.includes(plugin)) continue;
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

  /**
   * **The skills a Winter-leg CHILD can load, as the agent SDK's own two doors** — `Options.plugins`
   * (where the skills come from) and `Options.skills` (which of them the session may invoke).
   *
   * The child runs with `settingSources: []` (`mode-options.ts`, and it must: at SDK 0.0.17 a
   * `"user"` source would also make the child parse `<home>/settings.json` — the daemon's own file —
   * as a settings tier). That switches the SDK's user/project skill discovery off, and a local plugin
   * is the one skill source it does not gate. So every plugin whose skills THIS store resolves is
   * handed over as a skills-only view (`ensureSkillPluginView`), which the SDK indexes as
   * `<directory>:<skill>` — exactly the names `list()` gives them — and `skills` is this store's own
   * plugin-tier list minus every `Skill(<name>)` deny rule, so a denied skill is neither listed to the
   * model nor invocable (claude's documented meaning of the option). The deny rule itself still rides
   * `permissions.deny` as well; this only keeps the listing from naming a skill that will be refused.
   *
   * WHAT IS NOT HERE, and why: the user, self, trusted-project and builtin tiers. The SDK exposes no
   * door for bare-named skills from a host (its builtin tier is internal, and a local plugin always
   * qualifies its skills), so they cannot reach the child without an SDK change — see the lane report.
   * They are therefore also absent from `skills`, which may name only what the child can index.
   *
   * Empty (`{ plugins: [], skills: [] }`) when no plugin contributes a skill, so a caller can leave
   * both options off entirely. The views are (re)built here, which is the one side effect.
   */
  childSkillSurface(input: { cwd: string | null; deny?: readonly string[] }): { plugins: SdkPluginConfig[]; skills: string[] } {
    const denied = new Set(input.deny ?? []);
    const plugins: SdkPluginConfig[] = [];
    const skills: string[] = [];
    const viewed = new Map<string, boolean>();
    for (const meta of this.list({ cwd: input.cwd })) {
      if (meta.source !== "plugin") continue;
      const colon = meta.name.indexOf(":");
      const plugin = meta.name.slice(0, colon);
      const skill = meta.name.slice(colon + 1);
      if (!viewed.has(plugin)) {
        const root = ensureSkillPluginView(this.winterHome, plugin);
        viewed.set(plugin, root !== null);
        if (root !== null) plugins.push({ type: "local", path: root, skipMcpDiscovery: true });
      }
      if (!viewed.get(plugin)) continue;
      // A name either SDK jail refuses is still handed over inside its plugin (the child then says on
      // its stderr why it did not load) but never named here, where one unknown name fails the list.
      if (!SDK_PLUGIN_NAME_PATTERN.test(plugin) || !SDK_SKILL_NAME_PATTERN.test(skill)) continue;
      if (denied.has(skillDenyRule(meta.name))) continue;
      skills.push(meta.name);
    }
    return { plugins, skills };
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
