import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { WinterProfile } from "./profile";
import { SDK_PERSISTENT_ENTRIES, sdkHomeFor } from "./agent/paths";

export interface WinterDirs {
  home: string;
  sessionsDir: string;
  runDir: string;
  logsDir: string;
  socketPath: string;
  lockPath: string;
  settingsPath: string;
  runtimesDir: string;
  runtimeStatePath: string;
}

export function resolveWinterHome(): string {
  return process.env.WINTER_HOME ?? join(homedir(), ".winter");
}

/**
 * P9c-15 (Migration B safety ruling): true iff `home` resolves — `path.resolve`, NOT a realpath
 * symlink-following stat, so a symlinked home still counts as itself — to the profile's OWN
 * default home (`~/.winter` dist, `~/.winter-dev` dev), regardless of whether `home` arrived via
 * an explicit `opts.home`, `WINTER_HOME`, or `resolveWinterHome()`'s own default. This is the ONE
 * gate Migration B's auto-migration boot hook checks IN ADDITION TO pristine-ness: a temp home, a
 * custom `WINTER_HOME`, or a CI/gate home must NEVER auto-migrate, no matter how the daemon got
 * there — `winter migrate --from <legacyHome>` stays the one explicit door for any of those.
 *
 * `homedirFn` defaults to the real `os.homedir()` (every production call site). A caller may pass a
 * fake for a pure, hermetic unit test of this predicate alone — never to make the REAL boot hook
 * skip its own real-homedir check; `daemon.ts`'s production wiring never overrides it either.
 */
export function isDefaultWinterHome(home: string, profile: WinterProfile, homedirFn: () => string = homedir): boolean {
  const defaultHome = join(homedirFn(), profile === "dev" ? ".winter-dev" : ".winter");
  return resolve(home) === resolve(defaultHome);
}

// WS-21 (spec §8 bootstrap): `skills/self`, `agents`, `plugins`, `hooks` and
// `runtimes/official-agent-spool` are no longer created — the first four live in `sdk/` now (or retired),
// and the official leg's config dir is the router's per-run folder. A fresh home is therefore never in
// the old layout (Migration C's definition: real `projects/` or `skills/` content).
//
// `runtimes/backups` is NOT the checkpoint dir: it is `runtime-state.db`'s own backup directory
// (`runtime-state/db.ts`'s `backup()`), unrelated to the runtimes' file checkpoints.
const SUBDIRS = ["sessions", "memory", "logs", "run", "runtimes", "runtimes/backups", "runtimes/handoff-leases"];

/**
 * WS-21: the shared runtime home. `sdk/` itself is 0700 (it holds `.winter.json`, whose MCP entries
 * can carry headers); `sdk/projects` and claude's persistent set are pre-created so every run folder
 * can link them (spec §3.3). Created on every build: on one whose router does not apply run homes yet,
 * the runtime-facing directories stay at `<home>` (`storeHomeFor`), and these stay empty.
 *
 * No compatibility link is planted at `<home>/projects` (or anywhere): the agent SDK's store refuses a
 * symlink at that level on every append, so a link there would break every child still writing the
 * old path. Links are Migration C's, left only after it has moved the data on a run-home build.
 */
function bootstrapSdkHome(home: string): void {
  const sdk = sdkHomeFor(home);
  mkdirSync(sdk, { recursive: true, mode: 0o700 });
  chmodSync(sdk, 0o700);
  mkdirSync(join(sdk, "projects"), { recursive: true });
  for (const entry of SDK_PERSISTENT_ENTRIES) mkdirSync(join(sdk, entry), { recursive: true });
}

export function bootstrapWinterDir(home: string = resolveWinterHome()): WinterDirs {
  for (const d of SUBDIRS) mkdirSync(join(home, d), { recursive: true });
  chmodSync(join(home, "run"), 0o700);
  bootstrapSdkHome(home);

  const settingsPath = join(home, "settings.json");
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1 }, null, 2) + "\n");
    chmodSync(settingsPath, 0o600);
  }

  return {
    home,
    sessionsDir: join(home, "sessions"),
    runDir: join(home, "run"),
    logsDir: join(home, "logs"),
    socketPath: join(home, "run", "core.sock"),
    lockPath: join(home, "run", "core.lock"),
    settingsPath,
    runtimesDir: join(home, "runtimes"),
    runtimeStatePath: join(home, "runtimes", "runtime-state.db"),
  };
}
