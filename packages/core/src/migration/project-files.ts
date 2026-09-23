// `winter migrate-project` (P9c Task M step 9) — converts ONE project's legacy instructions file /
// project directory to their Winter-named counterparts. Content is untouched prose EXCEPT the
// legacy project directory's own `settings.json`, whose string values go through `rekeySettings`
// (same as the daemon-home migrator). Uses `git mv` when the paths are tracked inside a git work
// tree (so history/blame survive the rename); a plain `fs.renameSync` otherwise.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { LEGACY_INSTRUCTIONS_FILE, LEGACY_PROJECT_DIR } from "../legacy-names";
import { rekeySettings, type RekeyChange } from "./rekey-settings";
import { ApprovedProjectRules } from "../agent/approved-project-rules";
import { repoRootFor } from "../agent/memory-dir";
import { SavedAnswerRefused, saveAnswerInProject } from "../agent/saved-answers";
import { gitRootFor } from "../runtime-sdk/run-home-input";

export const WINTER_INSTRUCTIONS_FILE = "WINTER.md";
export const WINTER_PROJECT_DIR = ".winter";

export class ProjectMigrationRefused extends Error {
  constructor(
    public readonly code: "both_exist" | "nothing_to_migrate",
    message: string,
  ) {
    super(message);
    this.name = "ProjectMigrationRefused";
  }
}

export interface ProjectMigrationStep {
  /** WS-21 (spec §8, "repos are never touched automatically"): `mcp` moves the repo-root `.mcp.json` to
   *  `.winter/mcp.json` (the only project MCP file read now); `approved-rules` writes the daemon's old
   *  "Allow … in this project" record for this project, and `local-rules` the legacy
   *  `.winter/permissions.local.json`, into `.winter/settings.local.json` in claude's grammar. */
  kind: "instructions" | "dir" | "mcp" | "approved-rules" | "local-rules";
  from: string;
  to: string;
  method: "git-mv" | "rename" | "merge";
  /** `approved-rules` / `local-rules`: the Winter-grammar rules merged. */
  rules?: string[];
}

export interface ProjectMigrationPlan {
  dir: string;
  gitTracked: boolean;
  steps: ProjectMigrationStep[];
  /** The Winter home whose approved-rules record was read (the `approved-rules` step needs it to refuse
   *  saving into the home itself). */
  winterHome?: string;
  /** Where `.winter/settings.local.json` lives: the canonical git root (F17), else the project root. */
  rulesRoot?: string;
  /** Preview of what the legacy project dir's `settings.json` string values would rewrite to — computed even when
   *  `steps` is empty for neither file/dir, so `--status`-style tooling can show it independent of
   *  whether a move actually happens. Empty when no legacy settings.json exists or it fails to parse. */
  settingsChanges: RekeyChange[];
}

function isGitWorkTree(dir: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out === "true";
  } catch {
    return false;
  }
}

function isGitTracked(dir: string, relPath: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** Plans (never mutates disk) converting `dir`'s legacy instructions file / project directory to
 *  their Winter-named counterparts. Throws `ProjectMigrationRefused("both_exist")` the moment
 *  either pair has BOTH names present — resolving that is the operator's call, never automatic. */
/** The daemon's old approved-rules record for `projectRoot` — the live `<home>/permissions` record, or
 *  (after Migration C archived it) the newest archived copy. Read through `ApprovedProjectRules`, so a
 *  linked record reads as nothing. */
function approvedRulesFor(winterHome: string, projectRoot: string): { rules: string[]; file: string } | undefined {
  const live = new ApprovedProjectRules({ winterHome, log: () => {} });
  const liveRules = live.rulesFor(projectRoot);
  if (liveRules.length > 0) return { rules: liveRules, file: live.file() };
  let archives: string[] = [];
  try {
    archives = readdirSync(join(winterHome, "migration"))
      .filter((n) => n.startsWith("c-")).sort().reverse()
      .map((n) => join(winterHome, "migration", n, "archive"));
  } catch { archives = []; }
  for (const archiveHome of archives) {
    if (!existsSync(join(archiveHome, "permissions", "projects.json"))) continue;
    const archived = new ApprovedProjectRules({ winterHome: archiveHome, log: () => {} });
    const rules = archived.rulesFor(projectRoot);
    if (rules.length > 0) return { rules, file: archived.file() };
  }
  return undefined;
}

/** `.winter/permissions.local.json`'s `allow`, read without following a link; `[]` for anything else. */
function localRulesFile(root: string): string[] {
  const path = join(root, WINTER_PROJECT_DIR, "permissions.local.json");
  try {
    if (lstatSync(join(root, WINTER_PROJECT_DIR)).isSymbolicLink() || lstatSync(path).isSymbolicLink()) return [];
    const raw = JSON.parse(readFileSync(path, "utf8")) as { allow?: unknown };
    return Array.isArray(raw.allow) ? raw.allow.filter((r): r is string => typeof r === "string") : [];
  } catch { return []; }
}

export function planProjectMigration(dir: string, opts: { winterHome?: string } = {}): ProjectMigrationPlan {
  const legacyInstructions = join(dir, LEGACY_INSTRUCTIONS_FILE);
  const winterInstructions = join(dir, WINTER_INSTRUCTIONS_FILE);
  const legacyDir = join(dir, LEGACY_PROJECT_DIR);
  const winterDir = join(dir, WINTER_PROJECT_DIR);
  const gitTracked = isGitWorkTree(dir);
  const steps: ProjectMigrationStep[] = [];

  if (existsSync(legacyInstructions)) {
    if (existsSync(winterInstructions)) {
      throw new ProjectMigrationRefused("both_exist", `both ${LEGACY_INSTRUCTIONS_FILE} and ${WINTER_INSTRUCTIONS_FILE} exist in ${dir} — resolve manually, then re-run`);
    }
    const tracked = gitTracked && isGitTracked(dir, LEGACY_INSTRUCTIONS_FILE);
    steps.push({ kind: "instructions", from: legacyInstructions, to: winterInstructions, method: tracked ? "git-mv" : "rename" });
  }

  if (existsSync(legacyDir)) {
    if (existsSync(winterDir)) {
      throw new ProjectMigrationRefused("both_exist", `both ${LEGACY_PROJECT_DIR} and ${WINTER_PROJECT_DIR} exist in ${dir} — resolve manually, then re-run`);
    }
    const tracked = gitTracked && isGitTracked(dir, LEGACY_PROJECT_DIR);
    steps.push({ kind: "dir", from: legacyDir, to: winterDir, method: tracked ? "git-mv" : "rename" });
  }

  let settingsChanges: RekeyChange[] = [];
  const legacySettingsPath = join(legacyDir, "settings.json");
  if (existsSync(legacySettingsPath)) {
    try {
      settingsChanges = rekeySettings(JSON.parse(readFileSync(legacySettingsPath, "utf8"))).changes;
    } catch {
      /* unreadable/unparsable — reported as no preview changes; the move itself still proceeds, and
       * runProjectMigration carries the file across byte-for-byte via the directory git-mv/rename
       * rather than losing it. */
    }
  }

  // WS-21: the repo-root `.mcp.json` → `.winter/mcp.json` (claude's `.mcp.json` format, unchanged).
  const rootMcp = join(dir, ".mcp.json");
  const winterMcp = join(winterDir, "mcp.json");
  if (existsSync(rootMcp)) {
    if (existsSync(winterMcp) || existsSync(join(legacyDir, "mcp.json"))) {
      throw new ProjectMigrationRefused("both_exist", `both .mcp.json and ${WINTER_PROJECT_DIR}/mcp.json exist in ${dir} — resolve manually, then re-run`);
    }
    const tracked = gitTracked && isGitTracked(dir, ".mcp.json");
    steps.push({ kind: "mcp", from: rootMcp, to: winterMcp, method: tracked ? "git-mv" : "rename" });
  }

  // WS-21 (spec §4.3): saved "in this project" answers into the tier the runtimes read.
  const rulesRoot = gitRootFor(dir) ?? repoRootFor(dir);
  const settingsLocal = join(rulesRoot, WINTER_PROJECT_DIR, "settings.local.json");
  if (opts.winterHome !== undefined) {
    const approved = approvedRulesFor(opts.winterHome, repoRootFor(dir));
    if (approved !== undefined) steps.push({ kind: "approved-rules", from: approved.file, to: settingsLocal, method: "merge", rules: approved.rules });
  }
  const local = localRulesFile(rulesRoot);
  if (local.length > 0) steps.push({ kind: "local-rules", from: join(rulesRoot, WINTER_PROJECT_DIR, "permissions.local.json"), to: settingsLocal, method: "merge", rules: local });

  return { dir, gitTracked, steps, settingsChanges, rulesRoot, ...(opts.winterHome === undefined ? {} : { winterHome: opts.winterHome }) };
}

/** Executes a plan from `planProjectMigration`. Throws `ProjectMigrationRefused("nothing_to_migrate")`
 *  for an empty plan (nothing here to convert) rather than silently succeeding. */
export function runProjectMigration(plan: ProjectMigrationPlan): { skippedRules: string[] } {
  const skippedRules: string[] = [];
  if (plan.steps.length === 0) {
    throw new ProjectMigrationRefused("nothing_to_migrate", `nothing to migrate in ${plan.dir} — no ${LEGACY_INSTRUCTIONS_FILE} or ${LEGACY_PROJECT_DIR} found`);
  }
  for (const step of plan.steps) {
    if (step.method === "merge") {
      // Saved through the one door every saved answer uses: canonical root, never through a link, never
      // over an unparseable file, then the global git exclude. The user running this command in their
      // own project is the trust.
      for (const rule of step.rules ?? []) {
        try {
          saveAnswerInProject({ root: plan.rulesRoot ?? plan.dir, winterHome: plan.winterHome ?? "/nonexistent-winter-home", trusted: true }, rule);
        } catch (err) {
          if (!(err instanceof SavedAnswerRefused)) throw err;
          skippedRules.push(rule); // no claude spelling that is not wider — reported, never widened
        }
      }
      continue;
    }
    if (step.kind === "mcp") mkdirSync(join(plan.dir, WINTER_PROJECT_DIR), { recursive: true });
    if (step.method === "git-mv") execFileSync("git", ["mv", step.from, step.to], { cwd: plan.dir });
    else renameSync(step.from, step.to);
  }
  const winterSettingsPath = join(plan.dir, WINTER_PROJECT_DIR, "settings.json");
  if (existsSync(winterSettingsPath)) {
    try {
      const { out } = rekeySettings(JSON.parse(readFileSync(winterSettingsPath, "utf8")));
      writeFileSync(winterSettingsPath, `${JSON.stringify(out, null, 2)}\n`);
    } catch {
      /* unreadable/unparsable settings.json survives the move verbatim, untouched */
    }
  }
  return { skippedRules };
}
