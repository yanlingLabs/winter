// `winter migrate-project` (P9c Task M step 9) — converts ONE project's legacy instructions file /
// project directory to their Winter-named counterparts. Content is untouched prose EXCEPT the
// legacy project directory's own `settings.json`, whose string values go through `rekeySettings`
// (same as the daemon-home migrator). Uses `git mv` when the paths are tracked inside a git work
// tree (so history/blame survive the rename); a plain `fs.renameSync` otherwise.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { LEGACY_INSTRUCTIONS_FILE, LEGACY_PROJECT_DIR } from "../legacy-names";
import { rekeySettings, type RekeyChange } from "./rekey-settings";

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
  kind: "instructions" | "dir";
  from: string;
  to: string;
  method: "git-mv" | "rename";
}

export interface ProjectMigrationPlan {
  dir: string;
  gitTracked: boolean;
  steps: ProjectMigrationStep[];
  /** Preview of what `.norma/settings.json`'s string values would rewrite to — computed even when
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
export function planProjectMigration(dir: string): ProjectMigrationPlan {
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

  return { dir, gitTracked, steps, settingsChanges };
}

/** Executes a plan from `planProjectMigration`. Throws `ProjectMigrationRefused("nothing_to_migrate")`
 *  for an empty plan (nothing here to convert) rather than silently succeeding. */
export function runProjectMigration(plan: ProjectMigrationPlan): void {
  if (plan.steps.length === 0) {
    throw new ProjectMigrationRefused("nothing_to_migrate", `nothing to migrate in ${plan.dir} — no ${LEGACY_INSTRUCTIONS_FILE} or ${LEGACY_PROJECT_DIR} found`);
  }
  for (const step of plan.steps) {
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
}
