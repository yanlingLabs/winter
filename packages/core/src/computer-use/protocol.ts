// ComputerV2 (2026-10-08) — the daemon ↔ "Winter Computer Use" helper contract: identities, the socket, and
// the JSON-RPC method shapes. NDJSON, one JSON-RPC 2.0 object per line; requests from the daemon, three
// notifications from the helper. The helper is a SEPARATE signed app with its own TCC grants (R5): the daemon
// never spawns it (TCC would attribute it to the parent) — it is launched through LaunchServices by bundle id.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WINTER_TEAM_ID } from "../auth/app-token-acl";
import type { WinterProfile } from "../profile";

export const HELPER_PROTOCOL = 1;

/** The helper's bundle id per profile: dist `com.winter.computeruse`, dev `com.winter.computeruse.dev`. */
export function helperBundleIdFor(profile: WinterProfile): string {
  return profile === "dev" ? "com.winter.computeruse.dev" : "com.winter.computeruse";
}

/** The helper app's display name per profile (its bundle's file name). */
export function helperAppNameFor(profile: WinterProfile): string {
  return profile === "dev" ? "Winter Computer Use Dev.app" : "Winter Computer Use.app";
}

/**
 * WHERE the helper app is, so the daemon can launch it BY PATH (`open -g -a <path>` — spine, after L1a): a
 * bundle-id launch can resolve to any registered copy, a path cannot.
 *   - dist: `Winter.app/Contents/Helpers/Winter Computer Use.app` — `winter-core` lives in `Contents/MacOS`;
 *   - dev: `<repo>/dist/dev/Winter Computer Use Dev.app`, beside the signed dev daemon `dist/dev/winter-core`
 *     (built by `bun run dev:helper`); a daemon run from source under `bun` finds the repo from this file.
 * `$WINTER_COMPUTER_USE_APP` overrides both (a test, an unusual layout). The helper is verified by its code
 * signature after it answers, so a wrong path can only fail, never impersonate it.
 */
export function helperAppPathFor(profile: WinterProfile, env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string {
  const override = env.WINTER_COMPUTER_USE_APP;
  if (override !== undefined && override.trim().length > 0) return override;
  if (profile === "dist") return join(dirname(execPath), "..", "Helpers", helperAppNameFor("dist"));
  const compiled = typeof Bun !== "undefined" && (Bun.main.startsWith("/$bunfs/") || Bun.main.includes("/$bunfs/"));
  if (compiled) return join(dirname(execPath), helperAppNameFor("dev"));
  return fileURLToPath(new URL(`../../../../dist/dev/${helperAppNameFor("dev")}`, import.meta.url));
}

/** The designated requirement the daemon holds the helper to (identifier + Winter's team), checked on the
 *  pid the helper reports in `hello` (`helper-verify.ts`). */
export function helperRequirementFor(profile: WinterProfile, teamId: string = WINTER_TEAM_ID): string {
  return `identifier "${helperBundleIdFor(profile)}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

/** `<WINTER_HOME>/run/computer-use.sock` — created by the helper, mode 0600. */
export function helperSocketPath(home: string): string {
  return join(home, "run", "computer-use.sock");
}

/** Winter's own apps: never a target (the "Winter never controls itself" floor), and blacked out of shots. */
export const WINTER_OWN_BUNDLE_IDS: readonly string[] = ["com.winter.app", "com.winter.app.dev", "com.winter.computeruse", "com.winter.computeruse.dev"];

export interface HelperPermissions { accessibility: boolean; screenRecording: boolean }

/** `error.data.code` values (spine §2.3). */
export type HelperErrorCode =
  | "protocol_mismatch" | "home_mismatch" | "permission_missing" | "target_lost" | "stale_ref" | "needs_foreground"
  | "not_allowed" | "refused" | "wait_timeout" | "cancelled" | "invalid_params" | "unsupported" | "busy"
  // The app runs, but its window is on another Space / in full screen, or it has no open window (→ `NoWindow`).
  | "window_elsewhere" | "no_window";

/** A helper's JSON-RPC error, by its `data.code`. */
export class HelperRpcError extends Error {
  constructor(readonly code: string, message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
    this.name = "HelperRpcError";
  }
  get retryable(): boolean { return this.data.retryable === true || this.code === "busy"; }
}

/** The helper could not be reached, launched or verified — the typed `helper_unavailable` (retryable). */
export class HelperUnavailableError extends Error {
  readonly code = "helper_unavailable" as const;
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = "HelperUnavailableError";
  }
}

export type Rect = [x: number, y: number, w: number, h: number];

export interface HelloResult { protocol: number; helperVersion: string; pid: number }
export interface StatusResult { helperVersion: string; permissions: HelperPermissions }
export interface AppsListResult { apps: Array<{ name: string; bundleId: string; running: boolean; pid?: number }> }
export interface ScreenWindowsResult { windows: Array<{ app: string; bundleId: string; pid: number; windowId: number; title: string; frame: Rect; onScreen: boolean }> }
export interface TargetBindResult {
  targetId: string;
  app: { name: string; bundleId: string; pid: number };
  window: { id: number; title: string; frame: Rect };
  /** What the bind had to do to reach a usable window (another Space, moved here, a new one opened). */
  detail?: string;
}
export interface TargetUseWindowResult { window: { id: number; title: string; frame: Rect }; detail?: string }
export interface SnapshotResult { snapshotId: string; text: string; isDiff: boolean; changedRatio: number; settled: boolean; waitedMs: number }
export interface FindResult { elements: Array<{ ref: number; role: string; name?: string; value?: string; states?: string[] }> }
export interface ScreenshotBudget { maxLongEdge: number; tile?: number; maxTiles?: number; quality: number }
export interface ScreenshotResult {
  imageBase64: string; mime: "image/jpeg"; width: number; height: number; shotId: string; settled?: boolean; waitedMs?: number;
  /** `target.screenshot`: what the image is when it is not a live capture, e.g. a window on another desktop's last drawn content. */
  detail?: string;
}
export interface ActResult { rung: 1 | 2 | 3 | 4; detail?: string }
export interface WaitIdleResult { settled: boolean; waitedMs: number }
export interface WaitForResult { met: true; waitedMs: number }
export interface AppAtResult { app: string; bundleId: string; windowId: number }
/** The target app's windows — those on other Spaces or in full screen included (unfocused, no separate flag). */
export interface TargetWindowsResult { windows: Array<{ id: number; title: string; focused: boolean }> }

export type ActAction =
  | { kind: "click"; ref?: number; point?: [number, number]; shotId?: string; button?: "left" | "right" | "middle"; count?: 1 | 2 | 3; modifiers?: string[] }
  | { kind: "setValue"; ref: number; value: string }
  | { kind: "type"; text: string; into?: number }
  | { kind: "paste"; text: string; into?: number; format?: "text" | "html" | "markdown" }
  | { kind: "key"; combo: string; into?: number; repeat?: number }
  | { kind: "scroll"; ref?: number; point?: [number, number]; shotId?: string; direction: "up" | "down" | "left" | "right"; pages?: number }
  | { kind: "drag"; from: { ref?: number; point?: [number, number] }; to: { ref?: number; point?: [number, number] }; shotId?: string }
  | { kind: "select"; ref: number; text: string; before?: string; after?: string; caret?: "start" | "end" }
  | { kind: "action"; ref: number; name: string }
  | { kind: "menu"; path: string[] };

/** The three notifications the helper sends (spine §2.2). */
export type HelperNotification =
  | { method: "escPressed"; params: { sessionIds: string[] } }
  | { method: "targetLost"; params: { targetId: string; reason: "app_quit" | "window_closed" | "helper_restart" } }
  | { method: "permissionsChanged"; params: { permissions: HelperPermissions } };

/** One request line is at most 1 MiB; one response line at most 16 MiB (images). */
export const HELPER_MAX_REQUEST_LINE = 1024 * 1024;
export const HELPER_MAX_RESPONSE_LINE = 16 * 1024 * 1024;
