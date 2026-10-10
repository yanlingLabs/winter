// ComputerV2 Phase 2 — APP ADAPTERS, the shapes. An adapter is Winter's own, reviewed knowledge of one app: a few
// functions made for it (`app.extras.<name>(…)`), each with an ACCESS CLASS the per-app policy applies, and at most one
// short guide. Both reach the model only in a TOOL RESULT (the bind that first meets the app, again after a compaction,
// and `app.help()`), never in the tool description, which stays fixed per incarnation.
//
// THE INVARIANT: an extra is composed ONLY of helper methods a script could already reach — `target.act`, `.snapshot`,
// `.find`, `.waitFor`, `.waitIdle`, `.applescript` (AppleScript only through it), `apps.openDocument` (through the
// service, so the opener gets its own per-app card) and the read-only `target.scriptingCommands`. The floors, the access
// class, the Focus Guardian and the helper's AppleScript checks (source, decompiled text, every Apple Event) therefore
// apply by construction; there is never a new privileged path, and no extra returns an image.
import type { ActAction, ActResult, FindResult } from "../protocol";
import type { AppRef } from "../policy";
import type { PrimitiveMetric } from "../telemetry";
import type { AppHandle } from "../worker/bridge";

export type ExtraAccess = "view" | "click" | "full";

export interface AppAdapter {
  /** Exact bundle ids (aliases are more ids) — never display names. */
  bundleIds: readonly string[];
  /** `CFBundleShortVersionString` bounds, compared per dot component (absent: any version). */
  versions?: { min?: string; max?: string };
  /** At most one guide: id `"<key>@<rev>"` (a content change bumps the rev), text ≤ 2,000 UTF-8 bytes. */
  guide?: { id: string; text: string };
  extras: readonly ExtraDef[];
}

export interface ExtraDef {
  /** `/^[a-z][A-Za-z0-9]{0,39}$/` */
  name: string;
  access: ExtraAccess;
  /** Printed as is: `reveal(path: string): Promise<void>`. */
  signature: string;
  /** ≤ 120 characters. */
  summary: string;
  /** ≤ 600 bytes, for `help("<name>")`. */
  doc?: string;
  run(scope: AdapterScope, args: unknown[]): Promise<unknown>;
}

/** The bound target an adapter works on (the service's `TargetInfo`). */
export interface AdapterTarget {
  targetId: string;
  bundleId: string;
  name: string;
  pid: number;
  /** helper 1.8.0's `app.path` / `app.version` (`CFBundleShortVersionString`) at bind. */
  appPath?: string;
  appVersion?: string;
  /** The BOUND window's window-server id (from the bind, and the latest `useWindow`). */
  windowId?: number;
}

export type AuthPurpose = { kind: "bind" } | { kind: "observe" } | { kind: "act"; primitive: string; access?: "click" | "full" };

/**
 * What the SERVICE hands the adapters for one primitive (`service.ts`'s `adapterScope`): the run's helper door (its
 * call id, the busy retry, the `live()` checks, the metric), its grants, its AppleScript and document doors, and its
 * result builder.
 */
export interface AdapterRunScope {
  readonly sessionId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
  /** The primitive this scope serves (`apps.open`, `extra`, `help`, …). */
  readonly primitive: string;
  readonly metric: PrimitiveMetric;
  /** May the helper reach a window on another Space through private APIs (`computerUse.privateEventPath`)? */
  readonly privatePath: boolean;
  /** The connected helper's version (`hello`), for features newer than the daemon's minimum. */
  helperVersion(): string | undefined;
  /** One helper request on this run (call id, busy retry, `live()` after it). */
  helper<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** The per-app policy for this run (`ctx.grants`): the card, the floors, the app's access. */
  authorize(app: AppRef, purpose: AuthPurpose): Promise<void>;
  /** `app.applescript(source, { emit: false })` on a bound target — the service's own path (the consent wait, the clamp,
   *  `acted`, the fence). */
  applescript(t: AdapterTarget, source: string, o?: { timeoutMs?: number }): Promise<{ result: string | null }>;
  /** `apps.open(path, { app })`: opens a document in the background — and binds the opener's window (its own card). */
  openDocument(target: string, opener: string | undefined): Promise<AppHandle>;
  readonly builder: {
    text(text: string, o?: { screen?: boolean }): void;
    daemonLine(text: string): void;
    guide(text: string): void;
    markScreenRead(): void;
  };
  clampWait(ms: number): number;
  /** The target acted: a `state()` later in the run settles first. */
  acted(targetId: string): void;
  log(line: string): void;
}

/**
 * What ONE extra sees: the bound app and only the doors the invariant allows, all aimed at THIS target. `act` is
 * held to the extra's own class (a `view` extra cannot act; a `click` one only clicks, scrolls, presses and hovers) and
 * never takes the foreground or the user's desktop — an act the helper can do only in front fails, typed.
 */
export interface AdapterScope {
  readonly app: { name: string; bundleId: string; pid: number };
  readonly signal: AbortSignal;
  /**
   * The BOUND window's id — what every extra that works on "a window" or "the current tab/document" must address
   * (`window id <it>` in AppleScript, for an app whose scripting window id is that same window-server id). Never the
   * app's front window: the user's own window may be in front. Throws `NoWindow` when Winter does not know it.
   */
  window(): number;
  /** Winter's own AppleScript against this app; its result as AppleScript displays it. */
  applescript(source: string, o?: { timeoutMs?: number }): Promise<string | null>;
  find(query: string | { role?: string; name?: string; text?: string }): Promise<FindResult["elements"]>;
  /** The bound window's state text (full, or one subtree), printing nothing. */
  snapshot(o?: { within?: number }): Promise<string>;
  act(action: ActAction): Promise<ActResult>;
  waitFor(cond: { text?: string; ref?: number; gone?: number | string; title?: string }, timeoutMs: number): Promise<{ waitedMs: number }>;
  /** A document opened in the background (`apps.open(path, { app })`): the opener's name and bundle id. */
  openDocument(path: string, opener?: string): Promise<{ name: string; bundleId: string }>;
  /** Text read from the app, printed in place: DATA, inside the fence. */
  print(text: string): void;
  /** Winter's own words, printed in place outside the fence (never app text). */
  say(text: string): void;
  clampWait(ms: number): number;
  /** Sleep, unless the run is cancelled first (`false` then). */
  sleep(ms: number): Promise<boolean>;
}
