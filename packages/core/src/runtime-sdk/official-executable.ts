// P8c-3: where the daemon finds the `claude` runtime executable it hands the router as
// `vendoredOfficialRuntime` for a session on the official leg.
//
// MIRRORS `executable.ts` (P8b-2), with two differences the official leg's own contract forces:
//
//  1. WS-14 §5.1 is explicit that the official branch is isolated from the user's own Claude Code
//     install — "`pathToClaudeCodeExecutable` is always the explicit vendored/platform path (never a
//     bare command name; the router refuses both)". So a configured value with no path separator is
//     refused HERE, before it ever reaches the router's own (stricter) refusal — the daemon's error
//     should name the setting that is wrong, not the router's generic one.
//  2. There is no `winterLeg`-style "user's home" rung: a session's own credential lives in Keychain,
//     never on disk, so there is nothing under `NORMA_HOME` this ladder would ever find. The two
//     implicit rungs are the P8d-1 bundle drop (`<dirname(execPath)>/runtimes/claude-official/claude`,
//     `bundleRuntimePath` — the one place this layout is spelled) and, for every dev checkout, the
//     optional platform package `bun install` already resolved — found THROUGH THE WRAPPER PACKAGE'S
//     OWN `require` (never this file's), exactly as the router's own `test/official/support.ts`
//     `officialRuntimeBed` resolves it, so a stray version in a global bun cache can never be picked
//     up ahead of the pinned wrapper (WS-02 §6).
//
// P8d-1/P8d-2: a `claude` binary resolved through the BUNDLE rung is only as trustworthy as the
// `VERSIONS.json` staged beside it — a mismatched embed (an old `claude` re-embedded next to a
// newer `winter`, or vice versa) is not the pinned artifact this daemon was written against. So
// the bundle rung ALSO reads and validates that file (`parseVersionsJson`, which already checks
// EVERY pin — `officialSdk` included — against this build's `REQUIRED_*` constants) before
// returning a path; any failure (missing file, bad JSON, a pin mismatch) is the typed refusal,
// with the underlying reason as `detail`, never a silent pass-through of an unpinned binary. The
// package door (dev only) carries no such file and is unaffected.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { bundleRuntimePath, parseVersionsJson } from "./bundle-layout";

export type ClaudeExecutableSource = "setting" | "env" | "bundle" | "package";

/** The typed refusal. A session on the official leg fails at create with this — NEVER a silent
 *  fallback to the Winter leg (a family/runtime substitution is exactly what P8c-12 forbids). */
export class ClaudeExecutableUnavailable extends Error {
  readonly code = "claude_executable_unavailable" as const;
  constructor(readonly tried: string[], detail?: string) {
    super(
      `claude runtime executable not found (tried: ${tried.join(", ") || "nothing configured"})` +
        `${detail ? `: ${detail}` : ""}; set settings.runtimes.claudeExecutable or NORMA_CLAUDE_EXECUTABLE, ` +
        `or install the optional @anthropic-ai/claude-agent-sdk platform package (\`bun install\`)`,
    );
    this.name = "ClaudeExecutableUnavailable";
  }
}

/** WS-14 §5.1: an explicit configured value is a PATH, never a bare command name the shell would
 *  resolve off `$PATH` — that is exactly the user's own install this branch must never touch. */
function isBareName(value: string): boolean {
  return !value.includes("/");
}

/**
 * THE PACKAGE DOOR (dev only — the P8d-1 bundle rung is checked first in a Release build): the
 * optional platform package, resolved THROUGH THE WRAPPER'S OWN `require` rather than this file's
 * — the wrapper's `package.json` is found first via `createRequire(import.meta.url)`, and the
 * platform package is then resolved AS A DEPENDENCY OF THAT PACKAGE
 * (`createRequire(wrapperPackageJsonPath)`), so a different platform build sitting in some other
 * `node_modules` on the machine can never be picked up ahead of the pinned wrapper.
 *
 * Returns the platform package's directory, or `undefined` when the optional dependency was not
 * installed (`bun install` skips an optional dependency for the wrong platform/arch, and a Linux CI
 * runner has no darwin package at all — a LEGITIMATE skip, never a throw). A platform package whose
 * OWN version disagrees with the wrapper's THROWS instead — a mixed pair is not the pinned artifact
 * (WS-02 §6), and staying silent about it would let a session run against an unpinned binary.
 *
 * Exported (not just used as this file's own default) so `scripts/stage-runtimes.ts` can resolve
 * the SAME binary through the SAME `createRequire(import.meta.url)` — rooted at THIS module's own
 * location, `packages/core/src/runtime-sdk/`, which is what lets it find
 * `packages/core/node_modules/@anthropic-ai/claude-agent-sdk` regardless of where the CALLING
 * script sits (bun's isolated linker nests this optional dependency under `packages/core`'s own
 * `node_modules`, never hoisted to the repo root — a `createRequire` rooted in a repo-root script
 * would walk right past it).
 */
export function resolveClaudeAgentSdkPackageDir(): string | undefined {
  const req = createRequire(import.meta.url);
  let wrapperPackageJson: string;
  try {
    wrapperPackageJson = req.resolve("@anthropic-ai/claude-agent-sdk/package.json");
  } catch {
    return undefined;
  }
  const insideWrapper = createRequire(wrapperPackageJson);
  const platformName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  let platformPackageJson: string;
  try {
    platformPackageJson = insideWrapper.resolve(`${platformName}/package.json`);
  } catch {
    return undefined;
  }
  const platformVersion = (JSON.parse(readFileSync(platformPackageJson, "utf8")) as { version: string }).version;
  const wrapperVersion = (JSON.parse(readFileSync(wrapperPackageJson, "utf8")) as { version: string }).version;
  if (platformVersion !== wrapperVersion) {
    throw new Error(`the platform runtime is ${platformVersion} but the wrapper is ${wrapperVersion} — a mixed pair is not the pinned artifact (WS-02 §6)`);
  }
  return dirname(platformPackageJson);
}

/**
 * P8d-1/P8d-2's gate on the bundle rung: reads `VERSIONS.json` beside the resolved `claude`
 * binary and validates every pin (`parseVersionsJson` already checks `officialSdk` — and every
 * other field — against this build's `REQUIRED_*` constants). Returns the parse/validation
 * error message on failure, `undefined` on success. A seam (`readVersions`) so tests never touch
 * the real filesystem; defaults to a real `readFileSync`.
 */
function checkBundleVersions(execPath: string, readVersions: (p: string) => string): string | undefined {
  const versionsPath = bundleRuntimePath(execPath, "versions");
  try {
    parseVersionsJson(readVersions(versionsPath));
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * P8d-1's ladder: `settings.runtimes.claudeExecutable` → env `NORMA_CLAUDE_EXECUTABLE` →
 * `<dirname(execPath)>/runtimes/claude-official/claude` (the Release bundle drop, gated on a
 * valid `VERSIONS.json`) → the platform package under `node_modules` (dev only) → the typed
 * refusal.
 *
 * An EXPLICIT path (setting or env) is authoritative — if it is set and missing, or if it is a bare
 * name, that IS the failure (never fall through to a different binary than the one configured). The
 * two implicit locations are probed only when nothing explicit is configured, exactly like
 * `resolveWinterExecutable`'s own ladder.
 */
export function resolveClaudeExecutable(input: {
  setting?: string;
  env: Record<string, string | undefined>;
  execPath: string;
  exists: (p: string) => boolean;
  /** Test seam for the package door; defaults to the real dual-`createRequire` resolution. */
  resolvePackage?: () => string | undefined;
  /** Test seam for the bundle rung's VERSIONS.json read; defaults to a real `readFileSync`. */
  readVersions?: (p: string) => string;
}): { path: string; source: ClaudeExecutableSource } | ClaudeExecutableUnavailable {
  const explicit: Array<[ClaudeExecutableSource, string | undefined]> = [
    ["setting", input.setting?.trim() || undefined],
    ["env", input.env.NORMA_CLAUDE_EXECUTABLE?.trim() || undefined],
  ];
  for (const [source, path] of explicit) {
    if (!path) continue;
    if (isBareName(path)) return new ClaudeExecutableUnavailable([path], "a bare command name is refused — the official leg never resolves the user's own install (WS-14 §5.1)");
    return input.exists(path) ? { path, source } : new ClaudeExecutableUnavailable([path]);
  }
  const bundlePath = bundleRuntimePath(input.execPath, "claude");
  if (input.exists(bundlePath)) {
    const readVersions = input.readVersions ?? ((p: string) => readFileSync(p, "utf8"));
    const versionsError = checkBundleVersions(input.execPath, readVersions);
    if (versionsError !== undefined) {
      return new ClaudeExecutableUnavailable([bundlePath], `bundled claude at ${bundlePath} is not the pinned artifact: ${versionsError}`);
    }
    return { path: bundlePath, source: "bundle" };
  }
  const resolvePackage = input.resolvePackage ?? resolveClaudeAgentSdkPackageDir;
  let platformDir: string | undefined;
  try {
    platformDir = resolvePackage();
  } catch (err) {
    return new ClaudeExecutableUnavailable([bundlePath], err instanceof Error ? err.message : String(err));
  }
  if (platformDir === undefined) return new ClaudeExecutableUnavailable([bundlePath]);
  const packagePath = join(platformDir, "claude");
  return input.exists(packagePath) ? { path: packagePath, source: "package" } : new ClaudeExecutableUnavailable([bundlePath, packagePath]);
}

/** Belt-only re-export so a caller need not import `node:fs` just to build the `exists` seam. */
export const realExists = existsSync;
