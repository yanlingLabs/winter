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
//
// P9a fix wave, C1: the platform package arrives as an OPTIONAL DEPENDENCY OF THE WRAPPER
// (`@yanlinglabs/winter-agent-sdk`), not as a dependency of `packages/core` itself. Bun's isolated
// linker nests such a package under the WRAPPER's own store entry
// (`node_modules/.bun/@yanlinglabs+winter-agent-sdk@<ver>/node_modules/@yanlinglabs/<platform-pkg>`)
// and links it only into the wrapper's own `node_modules` — never hoisted to `packages/core`'s own
// `node_modules`, never to the workspace root. A single `createRequire(import.meta.url).resolve(...)`
// rooted at THIS module walks straight past it (measured: proven identical to the claude leg's
// `@anthropic-ai/claude-agent-sdk-darwin-arm64`/`-sdk` relationship). So this mirrors
// `official-executable.ts`'s `resolveClaudeAgentSdkPackageDir` exactly: resolve the wrapper's own
// `package.json` first, then `createRequire` THROUGH THAT to reach the platform package as a
// dependency of the wrapper — falling back to the single hop only for a DIRECT install (e.g. a dev
// `bun add <tarball> --optional` in `packages/core` itself, which is top-level-resolvable).
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundleRuntimePath } from "./bundle-layout";
import { REQUIRED_WINTER_AGENT_SDK } from "./versions";

export type WinterExecutableSource = "setting" | "env" | "bundle" | "home" | "platform-package";

const WINTER_WRAPPER_PACKAGE = "@yanlinglabs/winter-agent-sdk";
const WINTER_PLATFORM_PACKAGE = "@yanlinglabs/winter-agent-sdk-darwin-arm64";

/**
 * P9a-9's package door, fixed by the P9a fix wave's C1: resolves
 * `@yanlinglabs/winter-agent-sdk-darwin-arm64/package.json` with a DUAL `createRequire` hop —
 * first resolve the wrapper's own `package.json` from `fromUrl` (default `import.meta.url`, so a
 * test can root the whole resolution in a fixture directory instead), then resolve the platform
 * package AS A DEPENDENCY OF THE WRAPPER via `createRequire(wrapperPackageJsonPath)`. Falls back
 * to a single hop rooted at `fromUrl` when the wrapper itself cannot be resolved that way or does
 * not carry the platform package as its own dependency — the direct-install dev shape (`bun add
 * <tarball> --optional` in `packages/core`) is still top-level-resolvable and must keep working.
 *
 * Returns `undefined` when the optional dependency was not installed at all through either hop (a
 * non-darwin/non-arm64 host, or simply no `bun install` yet) — a legitimate skip, never a throw;
 * the caller decides what an absent rung means. A platform package whose OWN version disagrees
 * with this build's pin (`REQUIRED_WINTER_AGENT_SDK`) THROWS instead (P9a fix wave, M2) — a mixed
 * pair is not the pinned artifact (WS-02 §6), mirroring the claude leg's
 * `resolveClaudeAgentSdkPackageDir`; staying silent about it would let a session run against an
 * unpinned binary.
 */
export function resolvePlatformPackageWinter(fromUrl: string = import.meta.url): string | undefined {
  const req = createRequire(fromUrl);
  let packageJsonPath: string | undefined;
  try {
    const wrapperPackageJson = req.resolve(`${WINTER_WRAPPER_PACKAGE}/package.json`);
    packageJsonPath = createRequire(wrapperPackageJson).resolve(`${WINTER_PLATFORM_PACKAGE}/package.json`);
  } catch {
    packageJsonPath = undefined;
  }
  if (packageJsonPath === undefined) {
    try {
      packageJsonPath = req.resolve(`${WINTER_PLATFORM_PACKAGE}/package.json`);
    } catch {
      return undefined;
    }
  }
  const version = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }).version;
  if (version !== REQUIRED_WINTER_AGENT_SDK) {
    throw new Error(
      `the installed platform package is winter ${version} but this build is pinned to ${REQUIRED_WINTER_AGENT_SDK} — a mixed pair is not the pinned artifact (WS-02 §6)`,
    );
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
  constructor(readonly tried: string[], opts?: { triedPlatformPackage?: boolean; detail?: string }) {
    super(
      `winter runtime executable not found (tried: ${tried.join(", ") || "nothing configured"}` +
        `${opts?.triedPlatformPackage ? ", nor the installed platform package (@yanlinglabs/winter-agent-sdk-darwin-arm64)" : ""})` +
        `${opts?.detail ? `: ${opts.detail}` : ""}; ` +
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
  let packagePath: string | undefined;
  try {
    packagePath = resolvePlatformPackageBin();
  } catch (err) {
    // M2: a version-mismatched platform package throws rather than resolving silently — surfaced
    // here, on the ladder's last rung, as the typed refusal naming both versions.
    return { ok: false, error: new WinterExecutableUnavailable(tried, { triedPlatformPackage: true, detail: err instanceof Error ? err.message : String(err) }) };
  }
  if (packagePath !== undefined) return { ok: true, path: packagePath, source: "platform-package" };
  return { ok: false, error: new WinterExecutableUnavailable(tried, { triedPlatformPackage: true }) };
}
