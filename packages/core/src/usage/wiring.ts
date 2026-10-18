import { homedir } from "node:os";
import { join } from "node:path";
import type { IslandUsageRegistry } from "../island/usage";
import { usageTrackingFrom, type Settings } from "../settings";
import { UsageDb } from "./db";
import { UsagePricer } from "./pricing";
import { UsageService } from "./service";
import { resolveExecutable } from "./spawn-lines";

// Boot wiring for usage tracking (`docs/claude/usage.md`). Where the user's other apps keep their files:
//  - Codex: `$WINTER_USAGE_CODEX_HOME` (tests) → `$CODEX_HOME` → `~/.codex`;
//  - Claude Code: `$WINTER_USAGE_CLAUDE_HOME` (tests) → `$CLAUDE_CONFIG_DIR` → `~/.claude`, and its `.claude.json`
//    (`$WINTER_USAGE_CLAUDE_JSON` → `$CLAUDE_CONFIG_DIR/.claude.json` → `~/.claude.json`);
//  - the executables: `$WINTER_USAGE_CODEX_EXECUTABLE` / `$WINTER_USAGE_CLAUDE_EXECUTABLE` (authoritative: a missing
//    path or "off" means none) → `$PATH` → the usual install places.
// Both test preloads point every `WINTER_USAGE_*` at nothing, so no test daemon ever reads or spawns the real ones.

export interface UsageInjection {
  codexHome?: string | null;
  claudeHome?: string | null;
  claudeJsonPath?: string | null;
  codexExecutable?: string | null;
  claudeExecutable?: string | null;
  now?: () => number;
}

/** The usual absolute install places, tried before `$PATH` (Homebrew, /usr/local, ~/.local, npm-global, the app bundle). */
export const CODEX_INSTALLS = [
  "/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(homedir(), ".local/bin/codex"), join(homedir(), ".npm-global/bin/codex"),
  "/Applications/Codex.app/Contents/Resources/codex",
];
export const CLAUDE_INSTALLS = [
  "/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(homedir(), ".local/bin/claude"), join(homedir(), ".claude/local/claude"),
  join(homedir(), ".npm-global/bin/claude"),
];

function pick(injected: string | null | undefined, env: string | undefined, fallback: () => string | undefined): string | undefined {
  if (injected !== undefined) return injected ?? undefined;
  if (env !== undefined && env.length > 0) return env;
  return fallback();
}

export function createUsageService(opts: {
  home: string;
  settings: () => Settings | null | undefined;
  islandUsage?: IslandUsageRegistry;
  version?: string;
  injection?: UsageInjection;
  log?: { warn?: (msg: string, meta?: Record<string, unknown>) => void; info?: (msg: string, meta?: Record<string, unknown>) => void };
}): { service: UsageService; close(): void } | undefined {
  const env = process.env;
  const inj = opts.injection ?? {};
  let db: UsageDb;
  try {
    db = new UsageDb(join(opts.home, "usage", "usage.db"));
  } catch (err) {
    console.error(`[usage] usage.db unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;
  const codexHome = pick(inj.codexHome, env.WINTER_USAGE_CODEX_HOME, () => env.CODEX_HOME || join(homedir(), ".codex"));
  const claudeHome = pick(inj.claudeHome, env.WINTER_USAGE_CLAUDE_HOME, () => claudeConfigDir ?? join(homedir(), ".claude"));
  const claudeJsonPath = pick(inj.claudeJsonPath, env.WINTER_USAGE_CLAUDE_JSON, () => claudeConfigDir !== undefined ? join(claudeConfigDir, ".claude.json") : join(homedir(), ".claude.json"));
  const explicit = (injected: string | null | undefined, envValue: string | undefined): string | undefined =>
    injected !== undefined ? (injected ?? "off") : envValue;
  const probeRoot = join(opts.home, "usage");
  const pricer = new UsagePricer();
  const service = new UsageService({
    db, pricer,
    tracking: () => usageTrackingFrom(opts.settings()),
    ...(codexHome === undefined ? {} : { codexHome }),
    ...(claudeHome === undefined ? {} : { claudeHome }),
    ...(claudeJsonPath === undefined ? {} : { claudeJsonPath }),
    codexExecutable: () => resolveExecutable("codex", explicit(inj.codexExecutable, env.WINTER_USAGE_CODEX_EXECUTABLE), CODEX_INSTALLS),
    claudeExecutable: () => resolveExecutable("claude", explicit(inj.claudeExecutable, env.WINTER_USAGE_CLAUDE_EXECUTABLE), CLAUDE_INSTALLS),
    winterCodexWindows: () => (opts.islandUsage?.windowsFor("codex-oauth") ?? []).map((w) => ({
      ...(w.rateLimitType === undefined ? {} : { rateLimitType: w.rateLimitType }), status: w.status,
      ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }), at: w.at,
    })),
    probeRoot: () => probeRoot,
    ...(opts.version === undefined ? {} : { version: opts.version }),
    ...(inj.now === undefined ? {} : { now: inj.now }),
    log: opts.log ?? {
      warn: (msg, meta) => console.error(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`),
      info: (msg, meta) => console.error(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`),
    },
  });
  return { service, close: () => db.close() };
}
