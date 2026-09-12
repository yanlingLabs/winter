import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
