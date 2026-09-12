// Winter Phase 8d — the compiled-binary probe behind `norma-core __runtimes-probe`. It runs
// OUTSIDE a daemon (no settings, no store — mirrors `resolveWinterExecutable`/
// `resolveClaudeExecutable`'s own `setting: undefined`, exactly as a fresh boot with nothing
// configured would see them), resolves both executable ladders from the given execPath/home/env,
// and reports what it found. It NEVER spawns `winter` (the pinned build has no version flag —
// controller measurement M2) and never calls `resolveNormaHome()` — `home` is exactly what the
// caller passed, so `scripts/verify-runtimes-compiled.ts` can point it at a mkdtemp dir and prove
// the real user's homes are never touched.
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { bundleRuntimePath, parseVersionsJson, type VersionsJson } from "./bundle-layout";
import { resolveWinterExecutable } from "./executable";
import { ClaudeExecutableUnavailable, resolveClaudeExecutable } from "./official-executable";

export interface RuntimesProbeResult {
  ok: boolean;
  winter: { path?: string; source?: string; executable: boolean; signature?: string };
  claude: { path?: string; source?: string; executable: boolean; version?: string; teamIdentifier?: string };
  versions?: VersionsJson;
  errors: string[];
}

/** `X_OK` check, best-effort — never throws (a permissions probe on a path that doesn't even
 *  exist, or that this process can't stat, both read as "not executable", never a crash). */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface CodesignInfo { identifier?: string; teamIdentifier?: string; flags?: string }

/** `codesign -dvv <path>` (writes to stderr, not stdout), parsed for the three fields the release
 *  gate and controller measurement M1 care about. Best-effort: a missing `codesign` binary, an
 *  unsigned file, or any other failure returns `undefined` rather than throwing — this is a
 *  diagnostic enrichment, never load-bearing for `ok`. */
function codesignInfo(path: string): CodesignInfo | undefined {
  let out: string;
  try {
    const r = spawnSync("codesign", ["-dvv", path], { encoding: "utf8", timeout: 10_000 });
    out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  } catch {
    return undefined;
  }
  if (!out) return undefined;
  const identifier = out.match(/^Identifier=(.+)$/m)?.[1];
  const teamIdentifier = out.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const flags = out.match(/^flags=(.+)$/m)?.[1];
  if (identifier === undefined && teamIdentifier === undefined && flags === undefined) return undefined;
  return { identifier, teamIdentifier, flags };
}

function formatSignature(info: CodesignInfo | undefined): string | undefined {
  if (info === undefined) return undefined;
  const parts: string[] = [];
  if (info.identifier !== undefined) parts.push(`Identifier=${info.identifier}`);
  if (info.teamIdentifier !== undefined) parts.push(`TeamIdentifier=${info.teamIdentifier}`);
  if (info.flags !== undefined) parts.push(`flags=${info.flags}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** `claude --version` (controller measurement M1: `"2.1.250 (Claude Code)"`), 10s timeout,
 *  best-effort — NEVER `winter` (M2: the pinned build has no version flag and would hang/error). */
function claudeVersion(path: string): string | undefined {
  try {
    const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0) return undefined;
    return r.stdout?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function runRuntimesProbe(input: {
  execPath: string;
  home: string;
  env: Record<string, string | undefined>;
  /** P9a fix wave (M1 collateral): test seam for the P9a-9 platform-package rung, threaded
   *  straight through to `resolveWinterExecutable`; defaults to its own default
   *  (`resolvePlatformPackageWinter`) — never a behaviour change for the real `__runtimes-probe`
   *  route, which never sets this. */
  resolvePlatformPackageBin?: () => string | undefined;
}): Promise<RuntimesProbeResult> {
  const errors: string[] = [];
  const exists = (p: string): boolean => existsSync(p);

  // --- winter ---------------------------------------------------------------------------------
  const winterResolution = resolveWinterExecutable({
    setting: undefined,
    env: input.env,
    execPath: input.execPath,
    home: input.home,
    exists,
    ...(input.resolvePlatformPackageBin === undefined ? {} : { resolvePlatformPackageBin: input.resolvePlatformPackageBin }),
  });
  const winter: RuntimesProbeResult["winter"] = { executable: false };
  if (winterResolution.ok) {
    winter.path = winterResolution.path;
    winter.source = winterResolution.source;
    winter.executable = isExecutable(winterResolution.path);
    if (!winter.executable) errors.push(`winter at ${winterResolution.path} exists but is not executable`);
    winter.signature = formatSignature(codesignInfo(winterResolution.path));
  } else {
    errors.push(winterResolution.error.message);
  }

  // --- claude (P8d-1: the bundle rung is gated on VERSIONS.json — see official-executable.ts) --
  const claudeResolution = resolveClaudeExecutable({ setting: undefined, env: input.env, execPath: input.execPath, exists });
  const claude: RuntimesProbeResult["claude"] = { executable: false };
  if (!(claudeResolution instanceof ClaudeExecutableUnavailable)) {
    claude.path = claudeResolution.path;
    claude.source = claudeResolution.source;
    claude.executable = isExecutable(claudeResolution.path);
    if (!claude.executable) errors.push(`claude at ${claudeResolution.path} exists but is not executable`);
    claude.version = claudeVersion(claudeResolution.path);
    if (claude.version === undefined) errors.push(`claude at ${claudeResolution.path} did not report a version (claude --version)`);
    claude.teamIdentifier = codesignInfo(claudeResolution.path)?.teamIdentifier;
  } else {
    errors.push(claudeResolution.message);
  }

  // --- versions.json (independent of whether the claude ladder resolved through the bundle rung
  // — a bundle claude that itself refused on a mismatched VERSIONS.json is exactly the case a
  // diagnostic reader most wants to see the record for) -----------------------------------------
  let versions: VersionsJson | undefined;
  const versionsPath = bundleRuntimePath(input.execPath, "versions");
  if (exists(versionsPath)) {
    try {
      versions = parseVersionsJson(readFileSync(versionsPath, "utf8"));
    } catch (err) {
      errors.push(`${versionsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ok = winter.executable && claude.executable;
  return { ok, winter, claude, ...(versions === undefined ? {} : { versions }), errors };
}
