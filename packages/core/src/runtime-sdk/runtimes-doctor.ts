// Winter Phase 8d — `winter doctor`'s "runtimes" section (Lane 1 fills; Lane 4 prints). Diagnoses
// where each runtime executable resolves from (or the typed reason it does not) and, when the
// bundle rung's VERSIONS.json exists, the parsed record. READ-ONLY: never spawns a runtime, never
// touches a store, safe beside a live daemon — every resolver this composes is itself pure/typed,
// and every remaining throw surface (the platform-package door's version-mismatch throw) is caught
// here so a doctor run can NEVER crash `winter doctor`, only report an `error` string.
import { existsSync, readFileSync } from "node:fs";
import { winterOptionsFromSettings, type Settings } from "../settings";
import { bundleRuntimePath, parseVersionsJson, type VersionsJson } from "./bundle-layout";
import { resolveWinterExecutable } from "./executable";
import { ClaudeExecutableUnavailable, resolveClaudeAgentSdkPackageDir, resolveClaudeExecutable } from "./official-executable";
import { installedClaudeAgentSdkVersion } from "./versions";

export interface RuntimesReport {
  winter: { resolved?: { path: string; source: string }; error?: string };
  claude: { resolved?: { path: string; source: string }; error?: string; installedWrapper?: string; platformPackage?: string };
  bundle?: { versions?: VersionsJson; error?: string };
}

/** `existsSync`, but a doctor run must never crash on a permissions error mid-stat. */
function safeExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export async function diagnoseRuntimes(input: {
  execPath: string;
  home: string;
  env: Record<string, string | undefined>;
  settings: Settings | undefined;
  /** P9a fix wave (M1 collateral): test seam for the P9a-9 platform-package rung, threaded
   *  straight through to `resolveWinterExecutable`; defaults to its own default
   *  (`resolvePlatformPackageWinter`) — never a behaviour change for the real `winter doctor`
   *  route, which never sets this. */
  resolvePlatformPackageBin?: () => string | undefined;
}): Promise<RuntimesReport> {
  // The SAME settings door every real Winter-leg/official-leg consumer reads
  // (`create.ts`'s own `winterOptionsFromSettings(deps.settings()).{winterExecutable,claudeExecutable}`)
  // — the doctor's "setting" rung must be the identical value a live session would actually use, not
  // a re-derived guess at `settings.runtimes.*`.
  const options = winterOptionsFromSettings(input.settings);

  // --- winter -----------------------------------------------------------------------------------
  const winter: RuntimesReport["winter"] = {};
  try {
    const resolution = resolveWinterExecutable({
      setting: options.winterExecutable,
      env: input.env,
      execPath: input.execPath,
      home: input.home,
      exists: safeExists,
      ...(input.resolvePlatformPackageBin === undefined ? {} : { resolvePlatformPackageBin: input.resolvePlatformPackageBin }),
    });
    if (resolution.ok) winter.resolved = { path: resolution.path, source: resolution.source };
    else winter.error = resolution.error.message;
  } catch (err) {
    // resolveWinterExecutable never throws by construction — this is belt-only, matching the
    // "never throws" contract this function promises regardless of what its composed pieces do.
    winter.error = err instanceof Error ? err.message : String(err);
  }

  // --- claude -------------------------------------------------------------------------------------
  const claude: RuntimesReport["claude"] = {};
  try {
    const resolution = resolveClaudeExecutable({
      setting: options.claudeExecutable,
      env: input.env,
      execPath: input.execPath,
      exists: safeExists,
    });
    if (resolution instanceof ClaudeExecutableUnavailable) claude.error = resolution.message;
    else claude.resolved = { path: resolution.path, source: resolution.source };
  } catch (err) {
    claude.error = err instanceof Error ? err.message : String(err);
  }
  // Two READ-ONLY diagnostics, independent of which rung actually resolved above (a session might
  // be running off an explicit setting/env override while the dev-only package door underneath it
  // is stale or version-mismatched — worth surfacing either way, never fatal to the doctor run).
  claude.installedWrapper = installedClaudeAgentSdkVersion();
  try {
    const platformDir = resolveClaudeAgentSdkPackageDir();
    if (platformDir !== undefined) claude.platformPackage = platformDir;
  } catch {
    // A version-mismatch throw here is exactly the ladder's own package-door failure mode
    // (WS-02 §6) — already surfaced via `claude.error` when the ladder itself reached that door;
    // this optional diagnostic field simply stays unset rather than duplicating that message or
    // crashing the doctor over an optional field.
  }

  // --- bundle VERSIONS.json — independent of whether the claude ladder resolved via "bundle" -----
  // (a bundle rung that itself refused on a pin mismatch is exactly the case a doctor reader most
  // wants the record for, same reasoning as `runtimes-probe.ts`'s own independent read).
  let bundle: RuntimesReport["bundle"];
  const versionsPath = bundleRuntimePath(input.execPath, "versions");
  if (safeExists(versionsPath)) {
    try {
      bundle = { versions: parseVersionsJson(readFileSync(versionsPath, "utf8")) };
    } catch (err) {
      bundle = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { winter, claude, ...(bundle === undefined ? {} : { bundle }) };
}
