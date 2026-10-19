import { readdirSync } from "node:fs";
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
//  - the executables: `$WINTER_USAGE_CODEX_EXECUTABLE` / `$WINTER_USAGE_CLAUDE_EXECUTABLE` /
//    `$WINTER_USAGE_AGY_EXECUTABLE` / `$WINTER_USAGE_OPENCODE_EXECUTABLE` (authoritative: a missing path or "off" means none) → the usual install places
//    → `$PATH`.
// Both test preloads point every `WINTER_USAGE_*` at nothing, so no test daemon ever reads or spawns the real ones, and
// switch the background plan checks off (`WINTER_USAGE_BACKGROUND=off`).

export interface UsageInjection {
  codexHome?: string | null;
  claudeHome?: string | null;
  claudeJsonPath?: string | null;
  codexExecutable?: string | null;
  claudeExecutable?: string | null;
  agyExecutable?: string | null;
  opencodeExecutable?: string | null;
  now?: () => number;
  /** The background catch-up: false = off (tests); its timings. */
  catchUp?: boolean;
  catchUpFirstMs?: number;
  catchUpEveryMs?: number;
  /** The background plan checks and the alarms' fast beats (`UsageService.startBackground`): false = off; its timings. */
  background?: boolean;
  backgroundEveryMs?: number;
  alarmBeatMs?: { codex?: number; "claude-code"?: number; antigravity?: number };
}

// The usual absolute install places, tried before `$PATH` (Homebrew, /usr/local, ~/.local, npm-global, the app bundle).
// Functions, never module constants: every process of the `winter-core` binary loads this module — the sandboxed
// automation worker too, whose environment has no HOME and whose seatbelt refuses the user lookup, so a `homedir()`
// at load throws there and the worker never starts.
export const codexInstalls = (home = homedir()): string[] => [
  "/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(home, ".local/bin/codex"), join(home, ".npm-global/bin/codex"),
  "/Applications/Codex.app/Contents/Resources/codex",
];
export const claudeInstalls = (home = homedir()): string[] => [
  "/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(home, ".local/bin/claude"), join(home, ".claude/local/claude"),
  join(home, ".npm-global/bin/claude"),
];
/** Antigravity's CLI (Homebrew installs it as `agy`). */
export const agyInstalls = (home = homedir()): string[] => [
  "/opt/homebrew/bin/agy", "/usr/local/bin/agy", join(home, ".local/bin/agy"), join(home, ".npm-global/bin/agy"),
];
/** OpenCode (Homebrew, its own install script's `~/.opencode/bin`, npm). */
export const opencodeInstalls = (home = homedir()): string[] => [
  "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode", join(home, ".opencode/bin/opencode"), join(home, ".local/bin/opencode"),
  join(home, ".npm-global/bin/opencode"),
];

/** The JS package managers' global bins (bun, volta, pnpm, every nvm node): a CLI installed through one of them is
 *  still "on this Mac" when the app's `$PATH` is the bare launchd one. */
export function packageManagerBins(name: string, home = homedir()): string[] {
  const out = [join(home, ".bun/bin", name), join(home, ".volta/bin", name), join(home, "Library/pnpm", name)];
  try {
    for (const v of readdirSync(join(home, ".nvm/versions/node"))) out.push(join(home, ".nvm/versions/node", v, "bin", name));
  } catch { /* no nvm */ }
  return out;
}

/**
 * A daemon that must never read or spawn the user's own apps — every one booted OUTSIDE the tests and the real
 * daemon (the probes, the verify gates, the live and e2e suites, `check:idle-wakeups`): every root and executable is
 * none, the background plan beat and the catch-up off. `test/usage/script-daemons.test.ts` pins every such entry.
 */
export const USAGE_INERT: UsageInjection = Object.freeze({
  codexHome: null, claudeHome: null, claudeJsonPath: null, codexExecutable: null, claudeExecutable: null, agyExecutable: null,
  opencodeExecutable: null, catchUp: false, background: false,
});

/** The same for a daemon spawned as a process (`winter daemon run`, a compiled `winter-core`): its environment. */
export const USAGE_INERT_ENV: Readonly<Record<string, string>> = Object.freeze({
  WINTER_USAGE_CODEX_HOME: "off", WINTER_USAGE_CLAUDE_HOME: "off", WINTER_USAGE_CLAUDE_JSON: "off",
  WINTER_USAGE_CODEX_EXECUTABLE: "off", WINTER_USAGE_CLAUDE_EXECUTABLE: "off", WINTER_USAGE_AGY_EXECUTABLE: "off",
  WINTER_USAGE_OPENCODE_EXECUTABLE: "off", WINTER_USAGE_BACKGROUND: "off", WINTER_USAGE_CATCH_UP: "off",
});

function pick(injected: string | null | undefined, env: string | undefined, fallback: () => string | undefined): string | undefined {
  if (injected !== undefined) return injected ?? undefined;
  // "off" names no directory (as for the executables): authoritative, never a fall-through.
  if (env === "off") return undefined;
  if (env !== undefined && env.length > 0) return env;
  return fallback();
}

export function createUsageService(opts: {
  home: string;
  settings: () => Settings | null | undefined;
  islandUsage?: IslandUsageRegistry;
  version?: string;
  injection?: UsageInjection;
  /** The fired alarms waiting for an acknowledgement changed (the island's notifications). */
  onAlarmNotices?: () => void;
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
    codexExecutable: () => resolveExecutable("codex", explicit(inj.codexExecutable, env.WINTER_USAGE_CODEX_EXECUTABLE), [...codexInstalls(), ...packageManagerBins("codex")]),
    claudeExecutable: () => resolveExecutable("claude", explicit(inj.claudeExecutable, env.WINTER_USAGE_CLAUDE_EXECUTABLE), [...claudeInstalls(), ...packageManagerBins("claude")]),
    agyExecutable: () => resolveExecutable("agy", explicit(inj.agyExecutable, env.WINTER_USAGE_AGY_EXECUTABLE), [...agyInstalls(), ...packageManagerBins("agy")]),
    opencodeExecutable: () => resolveExecutable("opencode", explicit(inj.opencodeExecutable, env.WINTER_USAGE_OPENCODE_EXECUTABLE), [...opencodeInstalls(), ...packageManagerBins("opencode")]),
    winterCodexWindows: () => (opts.islandUsage?.windowsFor("codex-oauth") ?? []).map((w) => ({
      ...(w.rateLimitType === undefined ? {} : { rateLimitType: w.rateLimitType }), status: w.status,
      ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }), at: w.at,
    })),
    probeRoot: () => probeRoot,
    ...(opts.version === undefined ? {} : { version: opts.version }),
    ...(inj.now === undefined ? {} : { now: inj.now }),
    ...(opts.onAlarmNotices === undefined ? {} : { onAlarmNotices: opts.onAlarmNotices }),
    ...(inj.backgroundEveryMs === undefined ? {} : { backgroundEveryMs: inj.backgroundEveryMs }),
    ...(inj.alarmBeatMs === undefined ? {} : { alarmBeatMs: inj.alarmBeatMs }),
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
  // The background plan checks (user 2026-10-18): every installed and tracked plan every 30 min, and a plan with an
  // alarm on its own throttle. Unref'd; off with the env switch (both test preloads) or the injection.
  if (inj.background !== false && env.WINTER_USAGE_BACKGROUND !== "off") service.startBackground();
  return {
    service,
    close: () => {
      service.stopBackground();
      for (const t of timers) clearTimeout(t);
      db.close();
    },
  };
}

/** The background catch-up's first run after boot, and its period. */
export const USAGE_CATCH_UP_FIRST_MS = 3 * 60_000;
export const USAGE_CATCH_UP_EVERY_MS = 6 * 3_600_000;
