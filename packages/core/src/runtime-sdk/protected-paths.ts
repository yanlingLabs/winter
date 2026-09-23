// WS-21 (spec §7.1, §7.2): the paths a tool may not simply write (or read), decided in the daemon and
// enforced from one PreToolUse hook on both legs (`hooks.ts`'s `pathFenceHook`) plus the approval
// bridge (`approval-bridge.ts` (5e)).
//
// PROTECTED (§7.2) — instructions the runtimes load into every future session: ANY project's
// `.winter/{skills,commands,rules,output-styles}/**` at any depth, trusted or not (review C1 — the spec
// names the trusted project's; a later session loads a subdirectory's, and an untrusted project's once
// trusted), `sdk/{skills,commands,rules,output-styles}/**` and `sdk/WINTER.md`. A write is a card in code under every policy and a typed deny in chat and dispatch.
// Three layers at once: this hook's `ask`, the router's flag-layer `permissions.ask` rules (the same
// set, `protectedPathRules`), and the bridge, which never auto-allows one.
//
// STORE (§7.1) — `sdk/projects/**` is the runtimes' own transcript store: a tool never writes it,
// except each project's `memory/` directory, which is the model's MEMDIR.
//
// READ (§7.1) — `sdk/.winter.json` (the user's MCP servers, whose stdio `env` may carry a key) and
// the generated `.winter.json`/`.claude.json`/`.credentials.json` of any run folder or claude staging
// root.
//
// The sdk tier is anchored at `sdkHomeFor(home)` — `<home>/sdk`, literally the router's `sdkHome` — not
// at `storeHomeFor(home)`: the set is the router's, and on a build whose router applies no run home
// the store still lives at `<home>` and nothing loads `<home>/sdk/skills` (DECISION 11).
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { canonicalizeForWrite, resolveLeafSymlinks, sdkHomeFor } from "../agent/paths";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { RESUME_STAGING_PREFIX } from "@yanlinglabs/winter-runtime-sdk";
import { WRITE_CLASS_TOOL_NAMES, homeFenceTarget, writeTargetPathsIn } from "./control-plane";
import { fsRootAnchored } from "./mode-options";
import { PROTECTED_ITEM_DIRS } from "@yanlinglabs/winter-runtime-sdk";
import { projectWalk } from "./project-walk";

export { projectWalk };

/** The instructions file the sdk tier protects (the router's `brand.instructionsFile`). A project's own
 *  `<root>/WINTER.md` is deliberately NOT protected — claude treats `CLAUDE.md` as ordinary. */
export const SDK_INSTRUCTIONS_FILE = "WINTER.md";
/** The project dot-dir (the router's `brand.projectDirName`). */
export const PROJECT_DIR_NAME = ".winter";

/**
 * Spec §7.2's protected set in claude's ABSOLUTE rule spelling (`//` + the absolute path; a subtree is
 * `<dir>/**`), in the router's order: the four sdk item dirs, `sdk/WINTER.md`, then — for a trusted
 * project only — the four `.winter/` item dirs of every directory on the project walk from `walk.cwd`
 * (nearest first; L2 fix round 1, I2), or of the root alone when no walk is given. Built with the
 * daemon's own `fsRootAnchored` (ruling 2).
 *
 * INTERNAL TARGETS, NEVER WRITTEN AS RULES (round 4, minor 4): the daemon's own gate reads these back to
 * absolute paths (`targetsOf`) and compares paths, so they stay LITERAL — no `escapeRulePath`. The ask rules
 * a child receives are the router's (`protectedPathRules`, any depth, every path escaped).
 */
export function protectedPathsFor(home: string, trustedProjectRoot: string | null, walk?: { cwd: string; userHome?: string }): string[] {
  const sdk = sdkHomeFor(home);
  const out: string[] = PROTECTED_ITEM_DIRS.map((kind) => `${fsRootAnchored(join(sdk, kind))}/**`);
  out.push(fsRootAnchored(join(sdk, SDK_INSTRUCTIONS_FILE)));
  if (trustedProjectRoot !== null) {
    const dirs = walk === undefined ? [trustedProjectRoot] : projectWalk(walk.cwd, trustedProjectRoot, walk.userHome ?? homedir());
    for (const dir of dirs) {
      for (const kind of PROTECTED_ITEM_DIRS) out.push(`${fsRootAnchored(join(dir, PROJECT_DIR_NAME, kind))}/**`);
    }
  }
  return out;
}

/** The anchored rules back to absolute targets: `//x/**` → the directory `/x`, `//x` → the file `/x`. */
function targetsOf(rules: readonly string[]): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const rule of rules) {
    const abs = rule.startsWith("//") ? rule.slice(1) : rule;
    if (abs.endsWith("/**")) dirs.push(abs.slice(0, -3));
    else files.push(abs);
  }
  return { dirs, files };
}

/**
 * Review C1: every project's protected item directories, as path SEGMENTS matched at ANY depth and
 * regardless of trust — `<anything>/.winter/{skills,commands,rules,output-styles}/…`. The router loads the
 * `.winter/` items of every directory on a LATER session's walk (a subdirectory the model writes into
 * today, a sibling package, a project the user trusts tomorrow), so protecting only this session's walk
 * left an auto-approved write that a later session loads. The same any-depth shape `PROJECT_FENCED_SEGMENTS`
 * gives `.winter/agents`. (`protectedPathsFor` keeps the router's literal set — its ask rules are the
 * router's to widen.)
 */
export const PROTECTED_PROJECT_SEGMENTS: readonly string[] = PROTECTED_ITEM_DIRS.map((kind) => `${PROJECT_DIR_NAME}/${kind}/`);

/** The first protected path a write-class call names, raw spelling as the call gave it. */
function protectedHit(input: unknown, cwd: string, rules: readonly string[]): string | undefined {
  const fence = { ...targetsOf(rules), segments: PROTECTED_PROJECT_SEGMENTS };
  for (const p of writeTargetPathsIn(input)) {
    if (homeFenceTarget(p, cwd, fence)) return p;
  }
  return undefined;
}

export type ProtectedWriteDecision = { decision: "ask" } | { decision: "deny"; reason: string } | null;

/**
 * Spec §7.2 for one call: `null` when the call is not a write-class tool naming a protected path;
 * otherwise `ask` in code (under EVERY policy — the hook sees none, which is the point: accept-edits and
 * bypass reach this line exactly like ask does) and a typed deny in chat and dispatch. A dispatch CHILD is
 * a code session: its `ask` reaches the bridge, whose never-prompt rule turns it into the typed deny.
 *
 * Matched case-folded on the raw AND the canonical spelling of both the target and each protected path
 * (a write through a link into `.winter/skills`, or a realpath'd home), like the control-plane fence —
 * and, review C1, any project's `.winter/<kind>/` at any depth whatever `ctx.protected` names.
 */
export function protectedWriteDecision(
  toolName: string,
  input: unknown,
  ctx: { mode: SessionMode; protected: readonly string[]; cwd?: string },
): ProtectedWriteDecision {
  if (!WRITE_CLASS_TOOL_NAMES.has(toolName)) return null;
  const hit = protectedHit(input, ctx.cwd ?? "", ctx.protected);
  if (hit === undefined) return null;
  if (ctx.mode === "code") return { decision: "ask" };
  return { decision: "deny", reason: protectedWriteDeniedMessage(toolName, hit, ctx.mode) };
}

export function protectedWriteDeniedMessage(toolName: string, path: string, mode: string): string {
  return `${toolName} was not run — ${path} is a protected path (skills, commands, rules, output styles and WINTER.md are loaded into every future session), and a write to one needs the user's approval, which a ${mode} session never asks for.`;
}

/** Every spelling of a directory this module compares against: literal and realpath, lowercased. */
function spellings(dir: string): string[] {
  const out = new Set<string>([resolve(dir).toLowerCase()]);
  try { out.add(realpathSync(dir).toLowerCase()); } catch { /* not created yet: the literal spelling stands */ }
  try { out.add(canonicalizeForWrite(resolve(dir)).toLowerCase()); } catch { /* ditto */ }
  return [...out];
}

/** A target's raw and canonical spellings, lowercased. */
function targetSpellings(path: string, cwd: string): string[] {
  const raw = isAbsolute(path) ? resolve(path) : resolve(cwd || "/", path);
  const out = new Set<string>([raw.toLowerCase()]);
  try { out.add(canonicalizeForWrite(resolveLeafSymlinks(raw)).toLowerCase()); } catch { /* the raw spelling is still tested */ }
  return [...out];
}

/**
 * Spec §7.1's `sdk/projects/**` row, hook half: the runtimes' transcript store is written by the runtimes
 * only — a write-class tool naming anything at or under `<home>/sdk/projects` is denied in every mode and
 * under every policy, EXCEPT `<home>/sdk/projects/<key>/memory/**` (the MEMDIR the model maintains with
 * ordinary write/edit). Also (the table's last write row) anything inside a claude resume staging root
 * (`<tmp>/claude-resume-*`). Returns the denial message, or `undefined`.
 */
export function storeWriteDenial(toolName: string, input: unknown, ctx: { home: string; cwd?: string }): string | undefined {
  if (!WRITE_CLASS_TOOL_NAMES.has(toolName)) return undefined;
  const stores = spellings(join(sdkHomeFor(ctx.home), "projects"));
  const staging = spellings(tmpdir()).map((r) => new RegExp(`^${escapeRe(r)}/${escapeRe(RESUME_STAGING_PREFIX.toLowerCase())}[^/]*(/|$)`));
  for (const p of writeTargetPathsIn(input)) {
    for (const t of targetSpellings(p, ctx.cwd ?? "")) {
      // A claude resume staging root (spec §7.1's last write row): another generation's staged payload.
      if (staging.some((re) => re.test(t))) {
        return `${toolName} was not run — ${p} is inside a claude resume staging root, which only the runtime writes.`;
      }
      for (const store of stores) {
        if (t !== store && !t.startsWith(`${store}/`)) continue;
        const rest = t.slice(store.length + 1).split("/");
        // `<key>/memory` and below: the model's own memory directory.
        if (rest.length >= 2 && rest[0] !== "" && rest[1] === "memory") continue;
        return `${toolName} was not run — ${p} is inside sdk/projects, the runtimes' own transcript store, which no tool writes (only each project's memory/ directory is yours to edit).`;
      }
    }
  }
  return undefined;
}

/** The read-class tools, both vocabularies, and the fields each names its target in. */
const READ_CLASS_TOOL_NAMES: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "read", "glob", "grep"]);
const READ_PATH_FIELDS = ["file_path", "path", "filePath"] as const;
/** The generated config files of a run folder or a claude staging root. */
const RUN_CONFIG_FILES = [".winter.json", ".claude.json", ".credentials.json"] as const;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Spec §7.1's read row, hook half: `sdk/.winter.json`, and `.winter.json`/`.claude.json`/`.credentials.json`
 * and (round 6) anything under `backups/` in any run folder (`<home>/cache/runs/<id>/`) or claude staging
 * root (`<tmp>/claude-resume-*`). A Grep ROOTED at a run folder or staging root itself, or at `<home>/sdk`
 * itself, is refused too — it would read them — and so is a Grep or Glob rooted in `backups/`; a search rooted
 * higher (the user's home, `/`) is not, which is the documented residual (the deny RULES cover the file
 * targets on both legs; claude's own Grep also honours them). Round 6: everything else in a staging root —
 * the model's own large tool outputs (`projects/<key>/<sid>/tool-results/`) above all — is readable.
 */
export function protectedReadDenial(toolName: string, input: unknown, ctx: { home: string; cwd?: string }): string | undefined {
  if (!READ_CLASS_TOOL_NAMES.has(toolName)) return undefined;
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const targets = READ_PATH_FIELDS.map((f) => rec[f]).filter((v): v is string => typeof v === "string" && v !== "");
  if (targets.length === 0) return undefined;
  const sdkHomes = spellings(sdkHomeFor(ctx.home));
  const runsRoots = spellings(join(ctx.home, "cache", "runs"));
  const tmpRoots = spellings(tmpdir());
  const files = RUN_CONFIG_FILES.map(escapeRe).join("|");
  const containers = [
    ...runsRoots.map((r) => new RegExp(`^${escapeRe(r)}/[^/]+`)),
    ...tmpRoots.map((r) => new RegExp(`^${escapeRe(r)}/${escapeRe(RESUME_STAGING_PREFIX.toLowerCase())}[^/]*`)),
  ];
  const tool = toolName.toLowerCase();
  const isGrep = tool === "grep";
  for (const p of targets) {
    for (const t of targetSpellings(p, ctx.cwd ?? "")) {
      const denied = sdkHomes.some((s) => t === `${s}/.winter.json`)
        || containers.some((c) => new RegExp(`${c.source}/((${files})$|backups(/|$))`).test(t))
        || (isGrep && (sdkHomes.includes(t) || containers.some((c) => new RegExp(`${c.source}/?$`).test(t))));
      if (denied) {
        return `${toolName} was not run — ${p} holds a runtime's generated configuration (MCP servers and their environment, account state), which no tool reads. ${basename(p) === ".winter.json" ? "Use `winter mcp list` to see the configured servers." : ""}`.trim();
      }
    }
  }
  return undefined;
}
