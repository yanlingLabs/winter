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
  /** The background catch-up: false = off (tests); its timings. */
  catchUp?: boolean;
  catchUpFirstMs?: number;
  catchUpEveryMs?: number;
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
  // The background catch-up (`UsageService.catchUp`): once a few minutes after boot, then every few hours — so Claude
  // Code's transcripts are read before its own cleanup deletes them, Usage screen open or not. Unref'd timers (never
  // hold the daemon), a handful of wakeups a day; off with the env switch (tests, the idle-wakeups gate).
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (inj.catchUp !== false && env.WINTER_USAGE_CATCH_UP !== "off") {
    const run = (): void => { void service.catchUp().catch(() => { /* logged per pass; the next catch-up retries */ }); };
    const first = setTimeout(run, inj.catchUpFirstMs ?? USAGE_CATCH_UP_FIRST_MS);
    const every = setInterval(run, inj.catchUpEveryMs ?? USAGE_CATCH_UP_EVERY_MS);
    first.unref?.();
    every.unref?.();
    timers.push(first, every);
  }
  return {
    service,
    close: () => {
      for (const t of timers) clearTimeout(t);
      db.close();
    },
  };
}

/** The background catch-up's first run after boot, and its period. */
export const USAGE_CATCH_UP_FIRST_MS = 3 * 60_000;
export const USAGE_CATCH_UP_EVERY_MS = 6 * 3_600_000;
