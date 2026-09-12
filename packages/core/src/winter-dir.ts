import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { WinterProfile } from "./profile";

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

const SUBDIRS = ["sessions", "memory", "skills/self", "agents", "plugins", "hooks", "logs", "run", "runtimes", "runtimes/backups", "runtimes/official-agent-spool", "runtimes/handoff-leases"];

export function bootstrapWinterDir(home: string = resolveWinterHome()): WinterDirs {
  for (const d of SUBDIRS) mkdirSync(join(home, d), { recursive: true });
  chmodSync(join(home, "run"), 0o700);
  chmodSync(join(home, "runtimes", "official-agent-spool"), 0o700);

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
