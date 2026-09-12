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
import { join } from "node:path";
import { bundleRuntimePath } from "./bundle-layout";

export type WinterExecutableSource = "setting" | "env" | "bundle" | "home";

export type WinterExecutableResolution =
  | { ok: true; path: string; source: WinterExecutableSource }
  | { ok: false; error: WinterExecutableUnavailable };

/** The typed refusal. A session on the Winter leg fails at create with this — NEVER a silent
 *  fallback to the retiring engine (P8b-2). */
export class WinterExecutableUnavailable extends Error {
  readonly code = "winter_executable_unavailable" as const;
  constructor(readonly tried: string[]) {
    super(`winter runtime executable not found (tried: ${tried.join(", ") || "nothing configured"}); set settings.runtimes.winterExecutable or NORMA_WINTER_EXECUTABLE, or run \`bun run build:winter\``);
    this.name = "WinterExecutableUnavailable";
  }
}

/** P8b-2: an EXPLICIT path (setting or env) is authoritative — if it is set and missing, that is
 *  the failure (never fall through to a different binary than the one the user named). The two
 *  implicit locations are probed only when nothing explicit is configured. */
export function resolveWinterExecutable(input: { setting?: string; env: Record<string, string | undefined>; execPath: string; home: string; exists: (p: string) => boolean }): WinterExecutableResolution {
  const explicit: Array<[WinterExecutableSource, string | undefined]> = [["setting", input.setting?.trim() || undefined], ["env", input.env.NORMA_WINTER_EXECUTABLE?.trim() || undefined]];
  for (const [source, path] of explicit) {
    if (!path) continue;
    return input.exists(path) ? { ok: true, path, source } : { ok: false, error: new WinterExecutableUnavailable([path]) };
  }
  const implicit: Array<[WinterExecutableSource, string]> = [["bundle", bundleRuntimePath(input.execPath, "winter")], ["home", join(input.home, "runtimes", "bin", "winter")]];
  const tried: string[] = [];
  for (const [source, path] of implicit) { tried.push(path); if (input.exists(path)) return { ok: true, path, source }; }
  return { ok: false, error: new WinterExecutableUnavailable(tried) };
}
