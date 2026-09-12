// P8b-2: where the daemon finds the `winter` runtime binary it spawns for every session on the
// Winter leg.
//
// WHY A PATH IS ALWAYS PASSED. The SDK's own `resolveRuntimeExecutable` falls back to the
// platform package `@yanlinglabs/winter-agent-sdk-darwin-arm64`, which is `private` and NOT on npm
// (`bun install` skips it with a 404 warning — Task 1's install output). And even if it were
// published, a compiled `$bunfs` daemon cannot `createRequire` its way to a file that only exists
// in a real `node_modules`. So the host ALWAYS passes `Options.pathToClaudeCodeExecutable`, and
// this module is how it gets one.
//
// P8d-1: the "bundle" rung moved from a bare `<dirname(execPath)>/winter` sibling to
// `<dirname(execPath)>/runtimes/winter` (`bundleRuntimePath`, the one place this layout is
// spelled) — the Release app now embeds BOTH runtimes under one `Resources/runtimes/` subtree
// rather than dropping `winter` next to `norma-core` itself.
//
// P9a-9: the ladder gains a FIFTH, LAST rung — the installed npm platform package
// (`@yanlinglabs/winter-agent-sdk-darwin-arm64`, published starting with the v0.0.5 tag; see
// `resolvePlatformPackageWinter` below) — after `<home>/runtimes/bin/winter`. A dev daemon that
// has simply run `bun install` on darwin-arm64 now needs no `dist/winter` at all; the signed
// `dist/winter` (`build:winter --sign`) stays the STABLE-identity option for anyone who wants a
// Keychain ACL that survives rebuilds (the npm binary is ad-hoc signed, and its bytes change on
// every publish, re-triggering the one-time consent dialog — CLAUDE.md's third trap).
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundleRuntimePath } from "./bundle-layout";

export type WinterExecutableSource = "setting" | "env" | "bundle" | "home" | "platform-package";

/**
 * P9a-9's package door: resolves `@yanlinglabs/winter-agent-sdk-darwin-arm64/package.json`
 * through THIS MODULE's OWN `createRequire(import.meta.url)` — unlike the official leg's
 * `resolveClaudeAgentSdkPackageDir` (which walks through the WRAPPER package's own `require` to
 * avoid a stray global-cache copy), the winter platform package is resolved directly because it
 * is installed as a plain optional dependency reachable from this file's own `node_modules`
 * ancestry under bun's installer (measured: `bun add <tarball> --optional` in `packages/core`
 * resolves here without needing the wrapper's own require as an intermediate hop). Returns
 * `undefined` when the optional dependency was not installed at all (a non-darwin/non-arm64 host,
 * or simply no `bun install` yet) — a legitimate skip, never a throw; the caller decides what an
 * absent rung means.
 */
export function resolvePlatformPackageWinter(): string | undefined {
  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(import.meta.url).resolve("@yanlinglabs/winter-agent-sdk-darwin-arm64/package.json");
  } catch {
    return undefined;
  }
  const binPath = join(dirname(packageJsonPath), "bin", "winter");
  try {
    return existsSync(binPath) && statSync(binPath).isFile() ? binPath : undefined;
  } catch {
    return undefined;
  }
}

export type WinterExecutableResolution =
  | { ok: true; path: string; source: WinterExecutableSource }
  | { ok: false; error: WinterExecutableUnavailable };

/** The typed refusal. A session on the Winter leg fails at create with this — NEVER a silent
 *  fallback to the retiring engine (P8b-2). `tried` stays PURE PATHS (an explicit path, or the two
 *  implicit filesystem rungs) — P9a-9's package door has no fixed path to report on a miss (it is
 *  a `require` resolution, not a `existsSync` probe), so it is named separately via
 *  `triedPlatformPackage` rather than smuggled into the path list. */
export class WinterExecutableUnavailable extends Error {
  readonly code = "winter_executable_unavailable" as const;
  constructor(readonly tried: string[], opts?: { triedPlatformPackage?: boolean }) {
    super(
      `winter runtime executable not found (tried: ${tried.join(", ") || "nothing configured"}` +
        `${opts?.triedPlatformPackage ? ", nor the installed platform package (@yanlinglabs/winter-agent-sdk-darwin-arm64)" : ""}); ` +
        `set settings.runtimes.winterExecutable or NORMA_WINTER_EXECUTABLE, run \`bun run build:winter\`, or install the optional ` +
        `@yanlinglabs/winter-agent-sdk-darwin-arm64 platform package (\`bun install\`)`,
    );
    this.name = "WinterExecutableUnavailable";
  }
}

/** P8b-2: an EXPLICIT path (setting or env) is authoritative — if it is set and missing, that is
 *  the failure (never fall through to a different binary than the one the user named). The
 *  implicit locations — bundle, home, then (P9a-9) the installed platform package — are probed
 *  only when nothing explicit is configured, in that order (the ladder's LAST rung, so an
 *  explicit setting/env, a Release bundle, or a `<home>/runtimes/bin/winter` drop all still win). */
export function resolveWinterExecutable(input: {
  setting?: string;
  env: Record<string, string | undefined>;
  execPath: string;
  home: string;
  exists: (p: string) => boolean;
  /** Test seam for the P9a-9 package door; defaults to `resolvePlatformPackageWinter`. Injected
   *  (never real-install-dependent) so the ladder's unit tests never need `bun add` a tarball. */
  resolvePlatformPackageBin?: () => string | undefined;
}): WinterExecutableResolution {
  const explicit: Array<[WinterExecutableSource, string | undefined]> = [["setting", input.setting?.trim() || undefined], ["env", input.env.NORMA_WINTER_EXECUTABLE?.trim() || undefined]];
  for (const [source, path] of explicit) {
    if (!path) continue;
    return input.exists(path) ? { ok: true, path, source } : { ok: false, error: new WinterExecutableUnavailable([path]) };
  }
  const implicit: Array<[WinterExecutableSource, string]> = [["bundle", bundleRuntimePath(input.execPath, "winter")], ["home", join(input.home, "runtimes", "bin", "winter")]];
  const tried: string[] = [];
  for (const [source, path] of implicit) { tried.push(path); if (input.exists(path)) return { ok: true, path, source }; }
  const resolvePlatformPackageBin = input.resolvePlatformPackageBin ?? resolvePlatformPackageWinter;
  const packagePath = resolvePlatformPackageBin();
  if (packagePath !== undefined) return { ok: true, path: packagePath, source: "platform-package" };
  return { ok: false, error: new WinterExecutableUnavailable(tried, { triedPlatformPackage: true }) };
}
