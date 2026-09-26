// `winter migrate` (P9c Task M step 8) — thin on purpose, same precedent as `agents-cli.ts`'s own
// header: `main.ts`'s argv switch can't be driven by a unit test, so everything provable lives here
// and `main.ts`'s `case "migrate"` stays a thin wrapper over real deps.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MigrationCRefused,
  MigrationRefused,
  convertLegacyPluginsForMigration,
  downgradeRuntimeStateToV6,
  isOldLayout,
  isPristineHome,
  linkedRouterSupportsRunHome,
  migrationCManifestPath,
  migrationCState,
  planMigrationC,
  rollbackMigrationC,
  runMigrationC,
  type MigrationCManifest,
  legacyHomeFor,
  manifestFileState,
  manifestPath,
  planMigrationB,
  resumeMigrationB,
  rollbackMigrationB,
  runMigrationB,
  type MigrationManifest,
  type SecretStore,
} from "@yanlinglabs/winter-core";
import type { WinterProfile } from "@yanlinglabs/winter-core";

export interface MigrateCommandDeps {
  home: string;
  profile: WinterProfile;
  /** `process.argv.slice(3)` — everything after `winter migrate`. */
  argv: string[];
  /** The CURRENT (destination) Keychain store — real `KeychainSecretStore` in production. */
  secretsTo: SecretStore;
  /** The LEGACY (source) Keychain store — real `LegacyKeychainSecretStore` in production. */
  legacySecrets: SecretStore;
  isDaemonLockHeld: (home: string) => boolean;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Skipped entirely when `--yes` is present. */
  confirm: (prompt: string) => Promise<boolean>;
  /** WS-21 review I8: whether this build's router applies run homes (`linkedRouterSupportsRunHome`, the
   *  boot hook's own condition). Injectable for tests; absent reads the linked router. */
  routerSupportsRunHome?: () => boolean;
}

function statusLine(name: string, statuses: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  const parts = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
  return `  ${name}: ${statuses.length}${parts ? ` (${parts})` : ""}`;
}

function printManifestSummary(manifest: MigrationManifest, log: (line: string) => void): void {
  const finished = manifest.finishedAt ? ` finished ${manifest.finishedAt}` : "";
  // Review Minor: names BOTH ends of the copy — the destination home the manifest lives under,
  // not just where it came from. `--status` (and every other command that calls this) all show it.
  log(`migration: ${manifest.status}${finished} — from ${manifest.legacyHome} into ${manifest.home}`);
  log(statusLine("files", manifest.entries.map((e) => e.status)));
  log(statusLine("keychain", manifest.keychain.map((k) => k.status)));
}

function printMigrationCSummary(m: MigrationCManifest, log: (line: string) => void): void {
  const finished = m.finishedAt ? ` finished ${m.finishedAt}` : "";
  log(`migration C: ${m.status}${finished} — ${m.home}`);
  log(`  steps: ${m.steps.map((s) => `${s.step}${s.status === "skipped" ? " (skipped)" : ""}`).join(", ") || "none yet"}`);
  if (m.moved.length > 0) log(`  moved into sdk/: ${m.moved.map((mv) => mv.from).join(", ")} (links left at the old paths)`);
  if (m.reconciled.length > 0) log(`  reconciled: ${m.reconciled.map((r) => `${r.root} (${r.outcome})`).join(", ")}`);
  if (m.archived.length > 0) log(`  archived under ${m.archiveDir}: ${m.archived.length} item(s)`);
  if (m.status === "phase1-complete") log("  the legacy official working copies are reconciled — and the migration finished — at the next daemon boot");
  if (m.status === "rolling-back") log("  a rollback was interrupted — run `winter migrate --sdk-home --rollback` to finish it");
}

/**
 * WS-21 (spec §8): `winter migrate --sdk-home [--home <dir>] [--resume | --rollback | --status]`.
 *
 * The CLI has no router, so it runs Migration C's PHASE 1 (and phase 2 when there is no official
 * working copy to reconcile); a home left `phase1-complete` finishes at the next daemon boot on a build
 * whose router can reconcile. The daemon must be stopped: only the lock keeps a live daemon from having
 * `projects/` renamed under it.
 */
async function runMigrateSdkHome(deps: MigrateCommandDeps, yes: boolean): Promise<number> {
  const homeIdx = deps.argv.indexOf("--home");
  const home = homeIdx === -1 ? deps.home : deps.argv[homeIdx + 1];
  if (!home) {
    deps.error("winter migrate --sdk-home: --home requires a path");
    return 1;
  }
  if (deps.argv.includes("--status")) {
    const state = migrationCState(home);
    if (state.kind === "absent") deps.log(isOldLayout(home) ? `migration C: needed (${home} is in the old layout)` : `migration C: none (${home} is not in the old layout)`);
    else if (state.kind === "unreadable") deps.log(`migration C: unreadable — ${migrationCManifestPath(home)} does not parse`);
    else printMigrationCSummary(state.manifest, deps.log);
    return 0;
  }
  if (deps.isDaemonLockHeld(home)) {
    deps.error("winter migrate --sdk-home: the daemon is running; stop it first");
    return 1;
  }
  const supported = (deps.routerSupportsRunHome ?? linkedRouterSupportsRunHome)();
  // Review I8: only a build that can RUN a migrated home may make one — the boot hook's own condition.
  // `--status` (above) and `--rollback` (the way back to an older build) are always allowed.
  if (!supported && !deps.argv.includes("--rollback")) {
    deps.error("winter migrate --sdk-home: this build cannot run a migrated home (its router applies no run homes) — nothing was changed; use a build that does");
    return 1;
  }
  const migrationDeps = { log: deps.log, reconcileAvailable: supported, convertLegacyPlugins: convertLegacyPluginsForMigration };
  try {
    if (deps.argv.includes("--rollback")) {
      if (migrationCState(home).kind === "absent") {
        // Review I3: no Migration C to undo, but this build still left the store at schema v7, which an
        // older build refuses — step it back so a downgrade works.
        const schema = downgradeRuntimeStateToV6(home);
        deps.log(schema === "not-needed"
          ? `winter migrate --sdk-home --rollback: nothing to roll back in ${home}`
          : `winter migrate --sdk-home --rollback: no Migration C in ${home}; runtime-state.db stepped back to schema v6 for an older build`);
        return 0;
      }
      if (!yes && !(await deps.confirm(`Roll back Migration C in ${home}? The reconcile appends stay in the transcripts. [y/N] `))) {
        deps.log("aborted");
        return 1;
      }
      printMigrationCSummary(await rollbackMigrationC(home, { log: deps.log }), deps.log);
      return 0;
    }
    if (deps.argv.includes("--resume")) {
      const state = migrationCState(home);
      if (state.kind === "parsed" && state.manifest.status === "rolling-back") {
        // R.3 I-5: only the rollback goes on from a half-rolled-back home.
        deps.error(`winter migrate --sdk-home --resume: a Migration C rollback of ${home} was interrupted — run \`winter migrate --sdk-home --rollback\` to finish it`);
        return 1;
      }
      if (state.kind !== "parsed" || (state.manifest.status !== "in-progress" && state.manifest.status !== "phase1-complete")) {
        deps.error(`winter migrate --sdk-home --resume: nothing to resume in ${home}`);
        return 1;
      }
      if (!yes && !(await deps.confirm(`Resume Migration C in ${home}? [y/N] `))) {
        deps.log("aborted");
        return 1;
      }
      printMigrationCSummary(await runMigrationC(home, migrationDeps), deps.log);
      return 0;
    }
    const plan = await planMigrationC(home, migrationDeps);
    if (!plan.needed) {
      deps.log(`winter migrate --sdk-home: nothing to migrate (${home} is not in the old layout)`);
      return 0;
    }
    if (plan.refusal !== undefined) {
      deps.error(`winter migrate --sdk-home: refused — ${plan.refusal}`);
      return 1;
    }
    if (!yes && !(await deps.confirm(`Move ${home}'s runtime store, skills and agents into ${join(home, "sdk")}? [y/N] `))) {
      deps.log("aborted");
      return 1;
    }
    printMigrationCSummary(await runMigrationC(home, migrationDeps), deps.log);
    return 0;
  } catch (err) {
    if (err instanceof MigrationCRefused) {
      deps.error(`winter migrate --sdk-home: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/** Returns a process exit code (0 success, 1 refusal) — `main.ts`'s wrapper calls `process.exit`. */
export async function runMigrateCommand(deps: MigrateCommandDeps): Promise<number> {
  const yes = deps.argv.includes("--yes");
  if (deps.argv.includes("--sdk-home")) return runMigrateSdkHome(deps, yes);

  if (deps.argv.includes("--status")) {
    // Fix wave M1 (review Minor): `readMigrationManifest` reads absent AND unreadable/corrupt alike
    // as `null` (by design — see its own doc comment), which would make `--status` report an
    // unreadable manifest as "never run Migration B" — actively misleading, since a manifest DOES
    // exist there, it just doesn't parse. `manifestFileState` is the fail-closed variant that keeps
    // the two apart; `--status` is the one place that surfaces "unreadable" explicitly.
    const state = manifestFileState(deps.home);
    if (state.kind === "absent") {
      deps.log(`migration: none (${deps.home} has never run Migration B)`);
      return 0;
    }
    if (state.kind === "unreadable") {
      deps.log(`migration: unreadable — ${manifestPath(deps.home)} exists but does not parse as a migration manifest`);
      return 0;
    }
    printManifestSummary(state.manifest, deps.log);
    return 0;
  }

  // Every WRITING action below requires the daemon to be stopped — the boot path (`startDaemon`'s
  // own hook) is the normal door for an automatic migration; this command's job is resume/rollback/
  // an explicit re-run, none of which are safe beside a live daemon holding the SAME home open.
  if (deps.isDaemonLockHeld(deps.home)) {
    deps.error("winter migrate: the daemon is running; stop it first");
    return 1;
  }

  if (deps.argv.includes("--resume")) {
    if (!yes && !(await deps.confirm("Resume the in-progress migration? [y/N] "))) {
      deps.log("aborted");
      return 1;
    }
    try {
      const manifest = await resumeMigrationB(deps.home, { from: deps.legacySecrets, to: deps.secretsTo, log: deps.log });
      printManifestSummary(manifest, deps.log);
      return 0;
    } catch (err) {
      deps.error(`winter migrate: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (deps.argv.includes("--rollback")) {
    if (!yes && !(await deps.confirm("Roll back the migration, removing everything it copied? [y/N] "))) {
      deps.log("aborted");
      return 1;
    }
    try {
      const manifest = await rollbackMigrationB(deps.home, { log: deps.log });
      printManifestSummary(manifest, deps.log);
      return 0;
    } catch (err) {
      deps.error(`winter migrate: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // Default (and `--from <legacyHome>`): a fresh migration into the current home.
  const fromIdx = deps.argv.indexOf("--from");
  const legacyHome = fromIdx === -1 ? legacyHomeFor(deps.profile) : deps.argv[fromIdx + 1];
  if (!legacyHome) {
    deps.error("winter migrate: --from requires a path");
    return 1;
  }
  if (!existsSync(join(legacyHome, "settings.json"))) {
    deps.error(`winter migrate: no legacy home found at ${legacyHome} (no settings.json there)`);
    return 1;
  }
  if (!isPristineHome(deps.home)) {
    deps.error(`winter migrate: ${deps.home} is not a pristine Winter home — move it aside, e.g. \`mv ${deps.home} ${deps.home}.bak\`, then retry`);
    return 1;
  }
  if (!yes && !(await deps.confirm(`Migrate ${legacyHome} into ${deps.home}? [y/N] `))) {
    deps.log("aborted");
    return 1;
  }
  try {
    const plan = await planMigrationB({ legacyHome, home: deps.home, profile: deps.profile });
    const manifest = await runMigrationB(plan, { from: deps.legacySecrets, to: deps.secretsTo, log: deps.log });
    printManifestSummary(manifest, deps.log);
    return 0;
  } catch (err) {
    if (err instanceof MigrationRefused) {
      deps.error(`winter migrate: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
