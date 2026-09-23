// `winter migrate-project [dir]` (P9c Task M step 9) — thin wrapper over
// `planProjectMigration`/`runProjectMigration`; same "provable outside main.ts's argv switch"
// precedent as `migrate.ts`'s own header.
import {
  ProjectMigrationRefused,
  planProjectMigration,
  runProjectMigration,
  type ProjectMigrationPlan,
} from "@yanlinglabs/winter-core";

export interface MigrateProjectCommandDeps {
  /** `process.argv.slice(3)` — everything after `winter migrate-project`. */
  argv: string[];
  cwd: string;
  /** WS-21: the Winter home whose old approved-rules record ("Allow … in this project" answers) is folded
   *  into the project's `.winter/settings.local.json`. Absent: that step is not planned. */
  home?: string;
  log: (line: string) => void;
  error: (line: string) => void;
  confirm: (prompt: string) => Promise<boolean>;
}

function printPlan(plan: ProjectMigrationPlan, log: (line: string) => void): void {
  for (const step of plan.steps) {
    if (step.method === "merge") {
      log(`  + ${step.to}: ${step.rules?.length ?? 0} saved rule(s) from ${step.from} (claude grammar; never wider)`);
      continue;
    }
    log(`  - ${step.from} -> ${step.to} (${step.method})`);
  }
  for (const change of plan.settingsChanges) {
    log(`  ~ settings.json ${change.path}: "${change.from}" -> "${change.to}"`);
  }
}

/** Returns a process exit code (0 success, 1 refusal) — `main.ts`'s wrapper calls `process.exit`. */
export async function runMigrateProjectCommand(deps: MigrateProjectCommandDeps): Promise<number> {
  const yes = deps.argv.includes("--yes");
  // The first non-flag arg is the target directory; default to cwd.
  const dirArg = deps.argv.find((a) => !a.startsWith("--"));
  const dir = dirArg ?? deps.cwd;

  let plan: ProjectMigrationPlan;
  try {
    plan = planProjectMigration(dir, deps.home === undefined ? {} : { winterHome: deps.home });
  } catch (err) {
    if (err instanceof ProjectMigrationRefused) {
      deps.error(`winter migrate-project: ${err.message}`);
      return 1;
    }
    throw err;
  }

  if (plan.steps.length === 0) {
    deps.log(`winter migrate-project: nothing to migrate in ${dir}`);
    return 0;
  }

  deps.log(`winter migrate-project: plan for ${dir}`);
  printPlan(plan, deps.log);

  if (!yes && !(await deps.confirm("Apply this plan? [y/N] "))) {
    deps.log("aborted");
    return 1;
  }

  try {
    const { skippedRules } = runProjectMigration(plan);
    if (skippedRules.length > 0) deps.log(`winter migrate-project: ${skippedRules.length} saved rule(s) have no claude spelling that is not wider, and were left out: ${skippedRules.join(", ")}`);
  } catch (err) {
    if (err instanceof ProjectMigrationRefused) {
      deps.error(`winter migrate-project: ${err.message}`);
      return 1;
    }
    throw err;
  }
  deps.log(`winter migrate-project: done`);
  return 0;
}
