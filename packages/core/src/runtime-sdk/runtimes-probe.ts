// Winter Phase 8d — the compiled-binary probe behind `winter-core __runtimes-probe`. It runs
// OUTSIDE a daemon (no settings, no store — `setting: undefined`, exactly as a fresh boot with
// nothing configured would see it), resolves the `winter` and `ant` ladders from the given
// execPath/home/env, reads the bundle's records, and reports what it found. WS-23: the official
// `claude` ladder it also resolved is gone with the leg. It NEVER spawns `winter` (the pinned build
// has no version flag — controller measurement M2) and never calls `resolveWinterHome()` — `home` is
// exactly what the caller passed, so `scripts/verify-runtimes-compiled.ts` can point it at a mkdtemp
// dir and prove the real user's homes are never touched.
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { bundleRuntimePath, parseAntVersionsJson, parseVersionsJson, resolveAntExecutable, type AntVersionsJson, type VersionsJson } from "./bundle-layout";
import { resolveWinterExecutable } from "./executable";

export interface RuntimesProbeResult {
  ok: boolean;
  winter: { path?: string; source?: string; executable: boolean; signature?: string };
  /** Winter Phase 10a (P10a-4): OPTIONAL, unlike winter above — a miss never affects `ok`
   *  (`resolveAntExecutable` itself has no typed refusal; see bundle-layout.ts). Reported purely
   *  for `scripts/verify-runtimes-compiled.ts`'s fixture-driven proof that the bundle rung
   *  resolves ant inside a REAL compiled `$bunfs` binary, the same way it already proves this for
   *  winter. */
  ant: { path?: string; source?: string; executable: boolean; signature?: string };
  /** `runtimes/VERSIONS.json`, when staged. */
  versions?: VersionsJson;
  /** `runtimes/ant/VERSIONS.json` (WS-23: ant's own record), when staged. */
  antVersions?: AntVersionsJson;
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

export async function runRuntimesProbe(input: {
  execPath: string;
  home: string;
  env: Record<string, string | undefined>;
  /** P9a fix wave (M1 collateral): test seam for the P9a-9 platform-package rung, threaded
   *  straight through to `resolveWinterExecutable`; defaults to its own default
   *  (`resolvePlatformPackageWinter`) — never a behaviour change for the real `__runtimes-probe`
   *  route, which never sets this. */
  resolvePlatformPackageBin?: () => string | undefined;
  /** Winter Phase 10a (P10a-4): test seam for `resolveAntExecutable`'s dev-only `which ant` rung
   *  — never real-PATH-dependent in this file's own tests (M1's own lesson, applied here too);
   *  defaults to `resolveAntExecutable`'s own default (`Bun.which`) for the real probe route. */
  resolveAntWhich?: (cmd: string) => string | null;
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

  // --- ant (Winter Phase 10a, P10a-4) — OPTIONAL: a miss is recorded, never pushed into `errors`
  // or `ok`, since resolveAntExecutable has no typed refusal (an absent ant never refuses a
  // session; only the console-profile broker's own login and bearer refresh depend on it, with its
  // own failure path at that point). --------------------------------------------------------------
  const antResolution = resolveAntExecutable({
    setting: undefined,
    env: input.env,
    execPath: input.execPath,
    ...(input.resolveAntWhich === undefined ? {} : { which: input.resolveAntWhich }),
  });
  const ant: RuntimesProbeResult["ant"] = { executable: false };
  if (antResolution !== undefined) {
    ant.path = antResolution.path;
    ant.source = antResolution.source;
    ant.executable = isExecutable(antResolution.path);
    ant.signature = formatSignature(codesignInfo(antResolution.path));
  }

  // --- the two records, each independent of how its binary resolved — a record that refuses on a
  // pin mismatch is exactly the case a diagnostic reader most wants to see. -------------------------
  let versions: VersionsJson | undefined;
  const versionsPath = bundleRuntimePath(input.execPath, "versions");
  if (exists(versionsPath)) {
    try {
      versions = parseVersionsJson(readFileSync(versionsPath, "utf8"));
    } catch (err) {
      errors.push(`${versionsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let antVersions: AntVersionsJson | undefined;
  const antVersionsPath = bundleRuntimePath(input.execPath, "antVersions");
  if (exists(antVersionsPath)) {
    try {
      antVersions = parseAntVersionsJson(readFileSync(antVersionsPath, "utf8"));
    } catch (err) {
      errors.push(`${antVersionsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ok = winter.executable;
  return { ok, winter, ant, ...(versions === undefined ? {} : { versions }), ...(antVersions === undefined ? {} : { antVersions }), errors };
}
