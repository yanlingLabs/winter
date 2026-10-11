// ComputerV2 Phase 4 — the headless pool's ENGINES and where each one is. H1 has one: `winter`, Winter Headless — the
// separate, windowless CEF helper app Winter ships (apple/Winter/Sources/HeadlessHelper). Installed browsers run
// headless are H2's, only if they pass the plug-and-play gates; until then `winter` is the only engine.
//
// THE LADDER, in the `resolveWinterExecutable` convention (an explicit path is authoritative — a missing one is the
// failure, never a fall-through to another copy):
//   1. `$WINTER_HEADLESS_APP` — tests and dev;
//   2. a dev daemon: `<repo>/dist/dev/Winter Headless Dev.app` (built by `bun run dev:headless`) — beside the signed
//      dev daemon `dist/dev/winter-core`, or found from this file when the daemon runs from source under bun;
//   3. dist: `Winter.app/Contents/Helpers/Winter Headless.app` next to the running `winter-core`.
// A daemon off its profile's own default home (a test or experiment daemon) takes ONLY rung 1: it never finds an
// installed or dev helper by itself.
// The daemon SPAWNS the app's executable directly (never through LaunchServices) and, before it sends a command,
// checks the process it spawned against Winter's stated designated requirement (`processSatisfiesRequirement`).
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WINTER_TEAM_ID } from "../../../auth/app-token-acl";
import type { WinterProfile } from "../../../profile";

/** The engines `browsers.open(url, { browser: "headless", engine })` takes, the default first. */
export const HEADLESS_ENGINES = ["winter"] as const;
export type HeadlessEngine = (typeof HEADLESS_ENGINES)[number];
export const DEFAULT_HEADLESS_ENGINE: HeadlessEngine = "winter";

/** Winter Headless's bundle id per profile: dist `com.winter.headless`, dev `com.winter.headless.dev`. */
export function headlessBundleIdFor(profile: WinterProfile): string {
  return profile === "dev" ? "com.winter.headless.dev" : "com.winter.headless";
}

/** The app's file name per profile. */
export function headlessAppNameFor(profile: WinterProfile): string {
  return profile === "dev" ? "Winter Headless Dev.app" : "Winter Headless.app";
}

/**
 * The designated requirement the spawned helper is held to: its identifier and Winter's team under Apple's anchor.
 * An app named by `$WINTER_HEADLESS_APP` may be either identity (a dev daemon's tests point at the dev build).
 */
export function headlessRequirementFor(profile: WinterProfile, override: boolean, teamId: string = WINTER_TEAM_ID): string {
  const anchor = `anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
  if (override) return `(identifier "${headlessBundleIdFor("dist")}" or identifier "${headlessBundleIdFor("dev")}") and ${anchor}`;
  return `identifier "${headlessBundleIdFor(profile)}" and ${anchor}`;
}

/** Where the Winter Headless app should be for this daemon. */
export function winterHeadlessAppPath(profile: WinterProfile, env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): { path: string; override: boolean } {
  const override = env.WINTER_HEADLESS_APP;
  if (override !== undefined && override.trim().length > 0) return { path: override.trim(), override: true };
  if (profile === "dist") return { path: join(dirname(execPath), "..", "Helpers", headlessAppNameFor("dist")), override: false };
  const compiled = typeof Bun !== "undefined" && (Bun.main.startsWith("/$bunfs/") || Bun.main.includes("/$bunfs/"));
  if (compiled) return { path: join(dirname(execPath), headlessAppNameFor("dev")), override: false };
  return { path: fileURLToPath(new URL(`../../../../../../dist/dev/${headlessAppNameFor("dev")}`, import.meta.url)), override: false };
}

/** A resolved engine: what to spawn and what its process must satisfy. */
export interface ResolvedEngine {
  engine: HeadlessEngine;
  app: string;
  executable: string;
  requirement: string;
}

/** Winter Headless for this daemon, or why it can't run. Cheap (two `stat`s); the pool caches it briefly. */
export function resolveWinterHeadless(profile: WinterProfile, o: { env?: NodeJS.ProcessEnv; execPath?: string; exists?: (p: string) => boolean; overrideOnly?: boolean } = {}): ResolvedEngine | { missing: string } {
  const exists = o.exists ?? existsSync;
  const { path: app, override } = winterHeadlessAppPath(profile, o.env ?? process.env, o.execPath ?? process.execPath);
  if (o.overrideOnly === true && !override) return { missing: "Winter's headless browser is missing — reinstall Winter" };
  // The executable is named after the bundle ("Winter Headless", "Winter Headless Dev").
  const executable = join(app, "Contents", "MacOS", basename(app).replace(/\.app$/i, ""));
  if (!exists(executable)) {
    return { missing: profile === "dev" && !override
      ? "Winter's headless browser is not built — run `bun run dev:headless`"
      : "Winter's headless browser is missing — reinstall Winter" };
  }
  return { engine: "winter", app, executable, requirement: headlessRequirementFor(profile, override) };
}
