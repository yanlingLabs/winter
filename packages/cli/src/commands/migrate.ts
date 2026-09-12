// `winter migrate` (P9c Task M step 8) — thin on purpose, same precedent as `agents-cli.ts`'s own
// header: `main.ts`'s argv switch can't be driven by a unit test, so everything provable lives here
// and `main.ts`'s `case "migrate"` stays a thin wrapper over real deps.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MigrationRefused,
  isPristineHome,
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

/** Returns a process exit code (0 success, 1 refusal) — `main.ts`'s wrapper calls `process.exit`. */
export async function runMigrateCommand(deps: MigrateCommandDeps): Promise<number> {
  const yes = deps.argv.includes("--yes");

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
