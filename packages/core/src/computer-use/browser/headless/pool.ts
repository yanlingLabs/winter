// ComputerV2 Phase 4 — the HEADLESS POOL: the `headless` backend (family `headless`, one instance, "Winter
// (headless)"). Winter's private, invisible browser for background reading: every tab is an agent tab of the session
// that opened it, in that session's own in-memory browser context, and nothing of it is ever shown to anyone.
//
// The pool implements the pinned `CdpTransport` and runs its ENGINE — Winter Headless, the windowless CEF helper
// (`winter-engine.ts`, `engines.ts`) — on demand:
//   - started by the first tab (`createTab`), never by a listing (`listTabs` answers `[]` with nothing running);
//   - at most 8 open tabs per session and 24 in all, and no new tab while the helper's memory is over 3 GB (the user's
//     ruling on the budget) — its processes' physical footprint summed, what Activity Monitor shows (`memory.ts`), read
//     afresh for every new tab and only once the closes still in flight have finished: running out answers `capacity`
//     (the engine reads it as `TargetBusy`); nothing is closed for the model. A helper over it with NO tab open is
//     restarted instead (a fresh one is cheap: its components are kept) — the guard never stays tripped with nothing
//     left to close;
//   - gone after 5 minutes with no tab, at daemon stop, and when `computerUse.headless.enabled` turns off (read live,
//     at every command and every 10 s);
//   - a crash loses every tab (`tabGone(crashed)`; the next `browsers.open` starts a fresh helper). 3 commands in a
//     row that time out: the helper is asked `tabs.live`, which its main thread answers without any page — answered,
//     only the tabs those commands named are lost (a page busy-looping in its renderer); not answered within 3 s, the
//     helper is wedged and killed, every tab with it;
//   - `<home>/run/headless.pid` names the running helper (pid + start time) and `<home>/cache/headless-cef/<random>`
//     is its own cache root, so the next daemon's boot sweep (`sweepHeadless`) can clear what a dead one left;
//   - only the browser's COMPONENTS (the root store, the CRLSet, …) outlive a run: kept in
//     `<home>/cache/headless-components`, cloned into each fresh cache root and taken back when the helper ends
//     (`components.ts`) — never its cookies, cache or anything else.
// A session's context (its cookies) outlives its tabs while the helper runs, and goes when the session's runtime ends
// (`disposeSession`) or the helper exits.
//
// PRESENTATION (lane H3, the helper's feature `present` and the browser link's feature `headless`): a live headless
// tab can be SHOWN in Winter.app's panel — the same page, drawn from the helper's own GPU frames; nothing is reloaded or
// moved — for the `waitForUser` hand-off (`present`, the person in control) or for the person to watch (`watch`) and take
// over (`takeOver`) from the panel. While the person holds CONTROL, every agent command on that tab (attach, send,
// subscribe) is refused `capacity` ("the user has this tab", which the engine reads as `TargetBusy`); taking control
// first stops new agent commands and lets the ones in flight finish (`HEADLESS_DRAIN_MS` at most). The CDP events keep
// flowing, so the engine still follows the page. A presentation nobody connected to within `HEADLESS_PRESENT_START_MS`
// (Winter.app not there, its viewer refused) is ended here. A tab the turn's end closes while the person holds it is
// closed when they let it go.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStartSeconds } from "../../../auth/credential-migration-lock";
import { AutomationFailure } from "../../errors";
import type { PrimitiveMetric } from "../../telemetry";
import { CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS } from "../cdp-allowlist";
import type { HeadlessShowParams, HeadlessTabRow } from "../cef-link/cef-transport";
import type { HeadlessViewer } from "../cef-link/rpc";
import { TransportError, type CdpEvent, type CdpTransport, type TransportTab } from "../transport";
import { harvestHeadlessComponents, headlessComponentsDir, seedHeadlessComponents } from "./components";
import { DEFAULT_HEADLESS_ENGINE, HEADLESS_ENGINES, type ResolvedEngine } from "./engines";
import { processTreeFootprint } from "./memory";
import {
  HEADLESS_AGENT_VIEW, HEADLESS_PIPE_PROTOCOL, HEADLESS_TIMEOUTS, spawnEngineProcess, WinterHeadlessProcess, type HeadlessNoticeKind, type HeadlessOp, type HeadlessPresentationEvent,
  type SpawnEngine,
} from "./winter-engine";

/** The open-tab budget and the memory guard (the user's ruling). The guard reads the helper's processes' physical
 *  footprint summed (`memory.ts`). Measured (M-series, 2026-10-12): the helper with no tab ~220 MiB; 24 plain pages
 *  ~1.4 GiB; 24 of the live drill's media-heavy pages (WebGL, canvas, big SVGs, ~130 MiB each, ~37 of it in the GPU
 *  process) ~3.3 GiB — so pages that heavy meet the guard at about 22 tabs, before the 24-tab cap. */
export const HEADLESS_TABS_PER_SESSION = 8;
export const HEADLESS_TABS_GLOBAL = 24;
export const HEADLESS_MEMORY_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;
/** Over the limit while tabs are still closing: the guard waits this long for them before it reads again and decides. */
export const HEADLESS_CLOSE_SETTLE_MS = 2_000;
/** A presentation whose viewer has not been accepted this long after it was asked for is ended (nobody came). */
export const HEADLESS_PRESENT_START_MS = 10_000;
/** Taking control waits this long at most for the agent's commands in flight on the tab to finish. */
export const HEADLESS_DRAIN_MS = 5_000;
/** The model's sentence while the person holds a headless tab. */
export const HEADLESS_USER_HAS_TAB = "the user has this tab in Winter's panel — it is theirs until they hand it back; work in another tab meanwhile";
/** The helper exits after this long with no headless tab open anywhere. */
export const HEADLESS_IDLE_EXIT_MS = 5 * 60_000;
/** How often a running helper re-reads `computerUse.headless.enabled`. */
export const HEADLESS_ENABLED_POLL_MS = 10_000;
/** This many commands in a row that time out and the helper is probed (`tabs.live`): stuck itself, it is killed and
 *  every tab it held is lost; answering, only the tabs those commands named are lost. */
export const HEADLESS_WEDGED_AFTER_TIMEOUTS = 3;

export const HEADLESS_NAME = "Winter (headless)";
export const HEADLESS_DISABLED_REASON = "turned off in Settings";

const STOPPED = "Winter's headless browser stopped — open the page again";

/** The daemon's line for a refusal the helper reported, once per tab and kind. */
const NOTICE_LINES: Record<HeadlessNoticeKind, string> = {
  popup: "computer-use: a page in Winter's headless browser tried to open a window — refused",
  "local-network": "computer-use: a page in Winter's headless browser tried to reach the local network — refused before anything was sent",
};

export interface HeadlessPoolDeps {
  home: string;
  /** `computerUse.headless.enabled` (read live). */
  enabled(): boolean;
  /** The engine to run, or why there is none (`resolveWinterHeadless`). */
  resolve(): ResolvedEngine | { missing: string };
  spawn?: SpawnEngine;
  /** Does the spawned process satisfy the engine's designated requirement (`processSatisfiesRequirement`)? */
  verify?(pid: number, requirement: string): boolean;
  /** The memory of a process and every process under it, bytes (`processTreeFootprint`). */
  memoryOf?(rootPid: number): number | undefined;
  /** How long the guard waits for closes in flight before it decides (`HEADLESS_CLOSE_SETTLE_MS`). */
  closeSettleMs?: number;
  /** Presentation: Winter.app's panel as a viewer (the browser link's feature `headless`), or why there is none. */
  viewer?(): HeadlessViewer | undefined;
  viewerMissing?(): string | undefined;
  /** The code requirement the viewer (Winter.app) must satisfy (`winterAppRequirementFor`). */
  viewerRequirement?(): string;
  presentStartMs?: number;
  drainMs?: number;
  /** `headless.launch` / `headless.exit` metric lines. */
  metric?(m: PrimitiveMetric): void;
  now?(): number;
  idleExitMs?: number;
  enabledPollMs?: number;
  timeouts?: Partial<Record<keyof typeof HEADLESS_TIMEOUTS, number>>;
  log?(line: string): void;
}

interface PoolTab {
  tabKey: string; sessionId: string; proc: WinterHeadlessProcess; url: string; title: string; noticed: Set<HeadlessNoticeKind>; localNetworkAt?: number;
  /** The agent's commands on this tab in flight (attach, send, subscribe, detach) — a take-over waits for them. */
  inflight: number;
  /** Shown in Winter's panel. */
  presentation?: Presentation;
  /** A window the page opened while the person held this tab's opener (a sign-in window): the person's alone — never
   *  listed to the agent, shown beside its opener, closed when the person lets the opener go. */
  openerTabKey?: string;
  /** The size the page is laid out in, as the helper applied it (`headless.viewChanged`; absent: the agent's own,
   *  `HEADLESS_AGENT_VIEW`) and how many times it changed: a shown tab follows the panel's size, and gets the agent's
   *  back after. */
  view?: { width: number; height: number };
  viewEpoch?: number;
}

/** One headless tab shown in Winter's panel. */
interface Presentation {
  nonce: string;
  service: string;
  purpose: "handoff" | "watch" | "popup";
  /** The person holds control: the agent's commands are refused. */
  control: boolean;
  /** Control is being taken (the agent's commands in flight finishing): new ones are refused already. */
  taking: boolean;
  /** The viewer was accepted. */
  started: boolean;
  startWaiters: Set<(started: boolean) => void>;
  /** A `waitForUser` waits on this tab: the panel's Done / Stop waiting answer it. */
  handoffPending: boolean;
  /** The turn's end closed the tab while the person held it: closed when they let it go. */
  closeWhenReleased: boolean;
}

type ExitReason = "idle" | "stop" | "crash" | "disabled" | "memory";

/** `<home>/run/headless.pid`. */
export function headlessPidPath(home: string): string { return join(home, "run", "headless.pid"); }
/** `<home>/cache/headless-cef`: one random directory per helper run below it. */
export function headlessCacheRoot(home: string): string { return join(home, "cache", "headless-cef"); }
/** `<home>/cache/headless-uploads`: copies of files the person chose for a presented page's file chooser — the only folder
 *  Winter Headless reads a chosen file from. Removed when the helper exits and at boot. */
export function headlessUploadDir(home: string): string { return join(home, "cache", "headless-uploads"); }

/**
 * The boot sweep: a helper the previous daemon left (named in the pid file, still alive, and started when the file
 * says — never a pid reused since) is killed, and every leftover cache directory removed. Nothing here can be in use:
 * the daemon is starting, and only it starts the helper.
 */
export function sweepHeadless(home: string, deps: { startOf?: (pid: number) => number | undefined; kill?: (pid: number) => void; log?: (line: string) => void } = {}): void {
  const pidFile = headlessPidPath(home);
  try {
    const rec = JSON.parse(readFileSync(pidFile, "utf8")) as { pid?: unknown; startSec?: unknown };
    if (typeof rec.pid === "number" && Number.isInteger(rec.pid) && rec.pid > 1 && typeof rec.startSec === "number") {
      const started = (deps.startOf ?? processStartSeconds)(rec.pid);
      if (started !== undefined && started === rec.startSec) {
        try { (deps.kill ?? ((pid) => process.kill(pid, "SIGKILL")))(rec.pid); deps.log?.("computer-use: stopped a headless browser an earlier daemon left running"); } catch { /* gone */ }
      }
    }
  } catch { /* no pid file, or unreadable: nothing to stop */ }
  try { rmSync(pidFile, { force: true }); } catch { /* best effort */ }
  try { rmSync(headlessCacheRoot(home), { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(headlessUploadDir(home), { recursive: true, force: true }); } catch { /* best effort */ }
}

export class HeadlessPool implements CdpTransport {
  readonly backend = "headless";
  readonly family = "headless" as const;
  private proc: WinterHeadlessProcess | undefined;
  private launching: Promise<WinterHeadlessProcess> | undefined;
  /** Each helper run's own cache directory, removed when it exits (and again, for a stop, at once). */
  private readonly runDirs = new Map<WinterHeadlessProcess, string>();
  /** Commands in a row that timed out, for the running helper, and the tabs they named. */
  private timeoutStreak = 0;
  private readonly streakTabs = new Set<string>();
  /** A wedge probe in flight (one at a time). */
  private probing = false;
  private readonly tabs = new Map<string, PoolTab>();
  /** Slots taken by `createTab` calls still in flight (so two at once cannot both pass the budget). */
  private readonly reserved = new Map<string, number>();
  private readonly eventListeners = new Set<(e: CdpEvent) => void>();
  private readonly goneListeners = new Set<(tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user") => void>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private enabledTimer: ReturnType<typeof setInterval> | undefined;
  private exitReason: ExitReason | undefined;
  private launchedAt = 0;
  private stopped = false;
  private resolved: { at: number; value: ResolvedEngine | { missing: string } } | undefined;
  /** `tab.close` / `context.dispose` commands still in flight (their renderers are still there), and who waits for them
   *  to finish. */
  private closing = 0;
  private readonly closeWaiters = new Set<() => void>();
  /** `tab.ensure` commands of new tabs still in flight (a restart must never cut one off). */
  private ensuring = 0;
  /** A restart for memory in flight (shared by every new tab that finds the helper over the guard with no tab open). */
  private recycling: Promise<void> | undefined;
  /** The hand-off's Done / Stop waiting from the panel (the engine's `waitForUser` listens). */
  private readonly userDoneListeners = new Set<(tabKey: string, done: boolean) => void>();
  /** Sessions whose tab list the panel should hear about (debounced). */
  private readonly tabsPush = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: HeadlessPoolDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  // ── what the registry and the engine read ─────────────────────────────────────────────────────

  /** Offered: the setting is on and an engine is there to run (it starts lazily; an idle exit keeps this true). */
  get connected(): boolean {
    if (this.stopped) return false;
    try { if (!this.deps.enabled()) return false; } catch { return false; }
    return !("missing" in this.engineFor());
  }

  /** Why it is not offered, when it is not (`browsers.list()`'s reason). */
  get reason(): string | undefined {
    if (this.stopped) return "Winter is shutting down";
    try { if (!this.deps.enabled()) return HEADLESS_DISABLED_REASON; } catch { return HEADLESS_DISABLED_REASON; }
    const r = this.engineFor();
    return "missing" in r ? r.missing : undefined;
  }

  /** The engines this pool can run now (`browsers.list()`'s `engines`, once installed engines exist to choose from). */
  engines(): string[] { return "missing" in this.engineFor() ? [] : [DEFAULT_HEADLESS_ENGINE]; }

  /** Is the helper running now (for tests and status)? */
  get running(): boolean { return this.proc?.alive === true; }
  get pid(): number | undefined { return this.proc?.alive === true ? this.proc.pid : undefined; }
  /** Open headless tabs, in all or for one session. */
  tabCount(sessionId?: string): number {
    if (sessionId === undefined) return this.tabs.size;
    let n = 0;
    for (const t of this.tabs.values()) if (t.sessionId === sessionId) n++;
    return n;
  }

  private engineFor(): ResolvedEngine | { missing: string } {
    const now = this.now();
    if (this.resolved !== undefined && now - this.resolved.at < 5_000) return this.resolved.value;
    let value: ResolvedEngine | { missing: string };
    try { value = this.deps.resolve(); } catch { value = { missing: "Winter's headless browser is missing — reinstall Winter" }; }
    this.resolved = { at: now, value };
    return value;
  }

  // ── the engine's life ───────────────────────────────────────────────────────────────────────────

  private engine(): Promise<WinterHeadlessProcess> {
    // A launch in flight first: its process exists before it is ready.
    if (this.launching !== undefined) return this.launching;
    if (this.proc?.alive === true) return Promise.resolve(this.proc);
    const launch = this.launch();
    this.launching = launch;
    void launch.then(() => { this.launching = undefined; }, () => { this.launching = undefined; });
    return launch;
  }

  private async launch(): Promise<WinterHeadlessProcess> {
    const r = this.engineFor();
    if ("missing" in r) throw new AutomationFailure("BrowserUnavailable", `${HEADLESS_NAME} can't be reached: ${r.missing}`);
    const t0 = this.now();
    const runDir = join(headlessCacheRoot(this.deps.home), randomBytes(8).toString("hex"));
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    // The kept components first, so the browser starts on them and its updater only checks them.
    seedHeadlessComponents(headlessComponentsDir(this.deps.home), runDir, this.deps.log);
    const child = (this.deps.spawn ?? spawnEngineProcess)(r.executable, [`--winter-cache-root=${runDir}`]);
    const proc = new WinterHeadlessProcess(child, { ...(this.deps.timeouts === undefined ? {} : { timeouts: this.deps.timeouts }), ...(this.deps.log === undefined ? {} : { log: this.deps.log }) });
    this.proc = proc;
    this.runDirs.set(proc, runDir);
    this.exitReason = undefined;
    this.timeoutStreak = 0;
    this.streakTabs.clear();
    proc.onExit((code, signal) => this.exited(proc, code, signal));
    proc.onEvent((e) => this.event(proc, e));
    proc.onTabGone((tabKey, reason) => this.helperTabGone(proc, tabKey, reason));
    proc.onNotice((tabKey, kind) => this.notice(proc, tabKey, kind));
    proc.onPresentation((e) => this.presentationEvent(proc, e));
    this.writePidFile(proc.pid);
    // The process this daemon just spawned must be Winter's own before anything is sent to it.
    if (this.deps.verify !== undefined && !this.deps.verify(proc.pid, r.requirement)) {
      throw this.abandon(proc, "Winter's headless browser is not signed by Winter — reinstall Winter");
    }
    let hello;
    try { hello = await proc.ready(); } catch (err) {
      throw this.abandon(proc, `Winter's headless browser did not start (${err instanceof Error ? err.message : "error"})`);
    }
    if (hello.protocol !== HEADLESS_PIPE_PROTOCOL) {
      throw this.abandon(proc, "Winter's headless browser is from another version of Winter — reinstall Winter");
    }
    this.launchedAt = this.now();
    this.deps.log?.(`computer-use: Winter's headless browser started (pid ${proc.pid}, ${this.launchedAt - t0} ms)`);
    this.metric("headless.launch", this.launchedAt - t0, { headlessEngine: r.engine, ...(hello.version === undefined ? {} : { headlessVersion: hello.version }) });
    this.watchEnabled();
    return proc;
  }

  /** A launch that failed: the process killed, everything of the run removed — and why, for the model. */
  private abandon(proc: WinterHeadlessProcess, why: string): AutomationFailure {
    if (this.proc === proc) this.proc = undefined;
    proc.kill();
    this.clearTimers();
    this.cleanupRun(proc);
    this.deps.log?.(`computer-use: ${why}`);
    return new AutomationFailure("BrowserUnavailable", why);
  }

  private writePidFile(pid: number): void {
    try {
      mkdirSync(join(this.deps.home, "run"), { recursive: true });
      const startSec = processStartSeconds(pid);
      writeFileSync(headlessPidPath(this.deps.home), JSON.stringify({ pid, ...(startSec === undefined ? {} : { startSec }) }), { mode: 0o600 });
    } catch { /* the sweep is a belt; the pipe's EOF is what ends the helper */ }
  }

  /** The helper's process ended — asked (idle, stop, disabled) or not (a crash): every tab it held is gone. */
  private exited(proc: WinterHeadlessProcess, code: number | null, signal: string | null): void {
    // Its cache directory goes now, whatever else happened: a stop removed it already, but the helper may have written
    // to it while it died.
    const dir = this.runDirs.get(proc);
    this.runDirs.delete(proc);
    if (dir !== undefined) {
      harvestHeadlessComponents(dir, headlessComponentsDir(this.deps.home), this.deps.log);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* the next boot sweeps it */ }
    }
    if (this.proc !== proc) return;
    const reason: ExitReason = this.exitReason ?? "crash";
    this.proc = undefined;
    this.clearTimers();
    const lost = [...this.tabs.values()].filter((t) => t.proc === proc);
    for (const t of lost) { this.tabs.delete(t.tabKey); this.forgetPresentation(t, "the headless browser stopped"); }
    // Copies of files the person chose for a page live only as long as the browser that might upload them.
    try { rmSync(headlessUploadDir(this.deps.home), { recursive: true, force: true }); } catch { /* the next boot sweeps it */ }
    // A crash, or the setting turned off: the tabs the model still holds read why.
    if (reason === "crash" || reason === "disabled") for (const t of lost) this.emitGone(t.tabKey, reason === "crash" ? "crashed" : "closed");
    if (reason === "crash") this.deps.log?.(`computer-use: Winter's headless browser exited unexpectedly (${signal ?? `exit ${code ?? "?"}`}); ${lost.length} tab(s) lost`);
    this.metric("headless.exit", this.launchedAt === 0 ? 0 : this.now() - this.launchedAt, { headlessEngine: DEFAULT_HEADLESS_ENGINE, exitReason: reason });
    try { rmSync(headlessPidPath(this.deps.home), { force: true }); } catch { /* best effort */ }
  }

  /** The pid file and `proc`'s cache directory, removed now (`exited` removes the directory again when it really ends). */
  private cleanupRun(proc: WinterHeadlessProcess | undefined): void {
    try { rmSync(headlessPidPath(this.deps.home), { force: true }); } catch { /* best effort */ }
    const dir = proc === undefined ? undefined : this.runDirs.get(proc);
    if (dir !== undefined) {
      harvestHeadlessComponents(dir, headlessComponentsDir(this.deps.home), this.deps.log);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* the next boot sweeps it */ }
    }
  }

  private shutdown(reason: Exclude<ExitReason, "crash" | "memory">): void {
    const proc = this.proc;
    if (proc === undefined || !proc.alive) return;
    this.exitReason = reason;
    if (reason === "stop") proc.kill(); else proc.close();
  }

  private clearTimers(): void {
    if (this.idleTimer !== undefined) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    if (this.enabledTimer !== undefined) { clearInterval(this.enabledTimer); this.enabledTimer = undefined; }
  }

  /** No tab anywhere: the helper goes after the idle time (a new tab cancels it). */
  private armIdle(): void {
    if (this.tabs.size > 0 || this.reserved.size > 0 || this.proc?.alive !== true) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.tabs.size === 0 && this.reserved.size === 0) this.shutdown("idle");
    }, this.deps.idleExitMs ?? HEADLESS_IDLE_EXIT_MS);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private watchEnabled(): void {
    if (this.enabledTimer !== undefined) clearInterval(this.enabledTimer);
    this.enabledTimer = setInterval(() => { this.stillEnabled(); }, this.deps.enabledPollMs ?? HEADLESS_ENABLED_POLL_MS);
    (this.enabledTimer as { unref?: () => void }).unref?.();
  }

  /** `computerUse.headless.enabled`, read now: off stops a running helper (its tabs read why). */
  private stillEnabled(): boolean {
    let on = true;
    try { on = this.deps.enabled(); } catch { on = false; }
    if (!on && this.proc?.alive === true && this.exitReason === undefined) {
      this.deps.log?.("computer-use: Winter's headless browser was turned off in Settings — stopping it");
      this.shutdown("disabled");
    }
    return on;
  }

  /**
   * One command to the helper. A timeout counts toward the wedge: `HEADLESS_WEDGED_AFTER_TIMEOUTS` in a row and the
   * helper is probed (`probeWedge`). Any answer resets it.
   */
  private async command(proc: WinterHeadlessProcess, op: HeadlessOp, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    try {
      const r = await proc.command(op, params, timeoutMs);
      if (this.proc === proc) this.resetStreak();
      return r;
    } catch (err) {
      if (this.proc === proc) {
        if (err instanceof TransportError && err.code === "timeout") {
          if (typeof params.tabId === "string") this.streakTabs.add(params.tabId);
          if (++this.timeoutStreak >= HEADLESS_WEDGED_AFTER_TIMEOUTS && proc.alive) void this.probeWedge(proc);
        } else if (err instanceof TransportError && err.code !== "tab_gone") {
          this.resetStreak();
        }
      }
      throw err;
    }
  }

  private resetStreak(): void {
    this.timeoutStreak = 0;
    this.streakTabs.clear();
  }

  /**
   * Commands in a row timed out: is it the HELPER that is stuck, or a page? `tabs.live` is answered on the helper's
   * own main thread, asking no page. Answered: the helper is fine and a page is not (a renderer busy-looping) — only the
   * tabs those commands named are lost (closed in the helper, `crashed` to the engine), every other session's tabs
   * stay. Not answered within the probe's time: the helper is wedged and killed (a crash: every tab it held is lost,
   * the next open starts a fresh one).
   */
  private async probeWedge(proc: WinterHeadlessProcess): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    const streak = this.timeoutStreak;
    const suspects = [...this.streakTabs];
    const probeMs = this.deps.timeouts?.probe ?? HEADLESS_TIMEOUTS.probe;
    let answered = true;
    try {
      await proc.command("tabs.live", {}, probeMs);
    } catch (err) {
      // An answer that is a failure is still an answer; only silence is the wedge.
      answered = !(err instanceof TransportError && err.code === "timeout");
    } finally {
      this.probing = false;
    }
    if (this.proc !== proc || !proc.alive) return;
    if (!answered) {
      this.deps.log?.(`computer-use: Winter's headless browser stopped answering (${streak} commands in a row timed out, and it did not answer a check of itself) — restarting it`);
      proc.kill();
      return;
    }
    this.resetStreak();
    const lost = suspects.map((k) => this.tabs.get(k)).filter((t): t is PoolTab => t !== undefined && t.proc === proc);
    for (const t of lost) {
      this.tabs.delete(t.tabKey);
      this.forgetPresentation(t, "the page stopped answering");
      void this.closingWhile(proc.command("tab.close", { tabId: t.tabKey }, probeMs)).catch(() => { /* the helper closes it with its context at the latest */ });
      this.emitGone(t.tabKey, "crashed");
    }
    this.deps.log?.(lost.length > 0
      ? `computer-use: a page in Winter's headless browser stopped answering (${streak} commands in a row timed out) — its tab closed (${lost.length}); the browser itself still answers`
      : `computer-use: ${streak} commands to Winter's headless browser timed out, but it still answers — nothing closed`);
    this.armIdle();
  }

  private metric(primitive: string, ms: number, extra: Partial<PrimitiveMetric>): void {
    try { this.deps.metric?.({ ts: this.now(), sessionId: "", callId: "", primitive, ms, helperMs: 0, backend: "headless", ...extra }); } catch { /* never fails anything */ }
  }

  /** Daemon stop: the helper is killed at once (its tabs go with it). */
  stop(): void {
    this.stopped = true;
    const proc = this.proc;
    this.shutdown("stop");
    this.clearTimers();
    // The daemon may be gone before the exit is reported: what this run made goes now.
    this.cleanupRun(proc);
  }

  /** The session's runtime ended (idle, deleted): its tabs are forgotten and its context (its cookies) disposed. */
  disposeSession(sessionId: string): void {
    const mine = [...this.tabs.values()].filter((t) => t.sessionId === sessionId);
    for (const t of mine) { this.tabs.delete(t.tabKey); this.forgetPresentation(t, "the session ended"); this.emitGone(t.tabKey, "closed"); }
    const proc = this.proc;
    if (proc?.alive === true) {
      void this.closingWhile(this.command(proc, "context.dispose", { sessionId })).catch((err: unknown) => this.deps.log?.(`computer-use: disposing a headless context failed (${err instanceof Error ? err.message : "error"})`));
    }
    this.armIdle();
  }

  // ── tabs ────────────────────────────────────────────────────────────────────────────────────────

  private capacity(message: string): TransportError { return new TransportError("capacity", message); }

  /** The helper's memory now (`memory.ts`'s footprint sum) — never a reading kept from before: tabs come and go. */
  private memoryNow(pid: number): number | undefined {
    try { return (this.deps.memoryOf ?? processTreeFootprint)(pid); } catch { return undefined; }
  }

  /** A close or a context's disposal, counted while its command is in flight: until the helper answers, the pages it
   *  ends are still there, so the memory guard waits for it before it refuses anything. */
  private async closingWhile<T>(p: Promise<T>): Promise<T> {
    this.closing++;
    try { return await p; } finally {
      this.closing--;
      if (this.closing === 0) for (const w of [...this.closeWaiters]) w();
    }
  }

  /** Every close in flight finished, or `ms` passed. */
  private closesSettled(ms: number): Promise<void> {
    if (this.closing === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); this.closeWaiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.closeWaiters.add(done);
    });
  }

  /**
   * The memory guard, before a new tab: over the limit, it waits for the closes still in flight and reads again; still
   * over with no tab open (nothing a close could free), the helper is restarted (`recycle`); still over with tabs open,
   * the new tab is refused. A reading that can't be made (the helper just went) refuses nothing.
   */
  private async guardMemory(): Promise<void> {
    // A restart in flight: the new tab waits for the old helper to be gone and goes to the fresh one.
    if (this.recycling !== undefined) { await this.recycling; return; }
    const proc = this.proc?.alive === true && this.exitReason === undefined ? this.proc : undefined;
    if (proc === undefined) return;
    const limit = HEADLESS_MEMORY_LIMIT_BYTES;
    let bytes = this.memoryNow(proc.pid);
    if (bytes === undefined || bytes <= limit) return;
    if (this.closing > 0) {
      await this.closesSettled(this.deps.closeSettleMs ?? HEADLESS_CLOSE_SETTLE_MS);
      if (this.proc !== proc || !proc.alive) return;
      bytes = this.memoryNow(proc.pid);
      if (bytes === undefined || bytes <= limit) return;
    }
    if (this.tabs.size === 0 && this.closing === 0 && this.ensuring === 0) {
      await this.recycle(proc, bytes);
      return;
    }
    throw this.capacity("Winter's headless browser is using too much memory — close some tabs with tab.close()");
  }

  /**
   * The helper holds more than the guard allows with no tab open: nothing a close could free, so it is ended (its pipe
   * closed, killed after the grace) and the tab that found it starts a fresh one — cheap, since its components are kept.
   * Every session's context (cookies) goes with it, as at the idle exit. The old run's exit still takes back its
   * components and removes its cache before the new run is seeded.
   */
  private recycle(proc: WinterHeadlessProcess, bytes: number): Promise<void> {
    if (this.recycling !== undefined) return this.recycling;
    const run = (async () => {
      if (this.proc !== proc || !proc.alive) return;
      this.deps.log?.(`computer-use: Winter's headless browser used ${Math.round(bytes / (1024 * 1024))} MiB with no tab open — starting a fresh one`);
      // From here the pool no longer knows it: a new tab launches anew, and its exit is not reported a second time.
      this.proc = undefined;
      this.clearTimers();
      this.resetStreak();
      this.metric("headless.exit", this.launchedAt === 0 ? 0 : this.now() - this.launchedAt, { headlessEngine: DEFAULT_HEADLESS_ENGINE, exitReason: "memory" });
      try { rmSync(headlessPidPath(this.deps.home), { force: true }); } catch { /* best effort */ }
      await new Promise<void>((resolve) => { proc.onExit(() => resolve()); proc.close(); });
    })();
    this.recycling = run.finally(() => { this.recycling = undefined; });
    return this.recycling;
  }

  async createTab(opts: { sessionId: string; sessionTitle?: string; url: string; tabKey?: string; engine?: string }): Promise<TransportTab> {
    if (this.stopped) throw new TransportError("disconnected", "Winter is shutting down");
    const engine = opts.engine ?? DEFAULT_HEADLESS_ENGINE;
    if (!(HEADLESS_ENGINES as readonly string[]).includes(engine)) throw new TransportError("not_allowed", `no headless engine "${engine}" — the engines are: ${HEADLESS_ENGINES.join(", ")}`);
    if (!this.connected) throw new TransportError("disconnected", this.reason ?? "unavailable");
    // The budget, counted with the creations still in flight — checked and taken at once, before anything waits.
    const mine = this.tabCount(opts.sessionId) + (this.reserved.get(opts.sessionId) ?? 0);
    const all = this.tabs.size + [...this.reserved.values()].reduce((a, b) => a + b, 0);
    if (mine >= HEADLESS_TABS_PER_SESSION) throw this.capacity(`this session already has ${HEADLESS_TABS_PER_SESSION} headless tabs open — close one with tab.close()`);
    if (all >= HEADLESS_TABS_GLOBAL) throw this.capacity(`Winter's headless browser already has ${HEADLESS_TABS_GLOBAL} tabs open — close one with tab.close()`);
    this.reserved.set(opts.sessionId, (this.reserved.get(opts.sessionId) ?? 0) + 1);
    if (this.idleTimer !== undefined) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    try {
      await this.guardMemory();
      if (this.stopped) throw new TransportError("disconnected", "Winter is shutting down");
      const proc = await this.engine();
      const tabKey = `w-${randomBytes(6).toString("hex")}`;
      this.ensuring++;
      let r: { url?: unknown; title?: unknown };
      try {
        r = await this.command(proc, "tab.ensure", { sessionId: opts.sessionId, tabId: tabKey, url: opts.url }, this.deps.timeouts?.ensure ?? HEADLESS_TIMEOUTS.ensure) as { url?: unknown; title?: unknown };
      } finally {
        this.ensuring--;
      }
      const url = typeof r?.url === "string" ? r.url : opts.url;
      const title = typeof r?.title === "string" ? r.title : "";
      this.tabs.set(tabKey, { tabKey, sessionId: opts.sessionId, proc, url, title, noticed: new Set(), inflight: 0 });
      this.pushTabs(opts.sessionId);
      return { tabKey, url, title, active: false, agent: true, sessionId: opts.sessionId };
    } finally {
      const left = (this.reserved.get(opts.sessionId) ?? 1) - 1;
      if (left <= 0) this.reserved.delete(opts.sessionId); else this.reserved.set(opts.sessionId, left);
      this.armIdle();
    }
  }

  async closeTab(tabKey: string): Promise<void> {
    const t = this.tabs.get(tabKey);
    if (t === undefined) return;
    // The person holds it in Winter's panel: it closes when they let it go (`releaseControl`, `endPresentation`).
    if (t.presentation?.control === true) {
      t.presentation.closeWhenReleased = true;
      return;
    }
    this.tabs.delete(tabKey);
    if (t.presentation !== undefined) void this.endPresentation(t, "closed");
    this.pushTabs(t.sessionId);
    try {
      if (t.proc.alive) await this.closingWhile(this.command(t.proc, "tab.close", { tabId: tabKey }));
    } finally {
      this.armIdle();
    }
  }

  /** A headless tab is never handed to anyone (the engine refuses `keep()` first). */
  async keepTab(): Promise<void> {}

  /** Every headless tab is silent already (the helper runs with `--mute-audio`): muting is a no-op, and the engine
   *  refuses unmuting first. */
  async setMuted(): Promise<void> {}

  /** The open headless tabs — `[]`, and nothing started, while the helper is not running. */
  async listTabs(opts?: { sessionId?: string }): Promise<TransportTab[]> {
    const mine = await this.liveTabs(opts?.sessionId);
    // A tab the turn's end closed while the person held it is no longer the agent's to find; a window the person opened
    // never was.
    return mine.filter((t) => t.presentation?.closeWhenReleased !== true && t.openerTabKey === undefined)
      .map((t) => ({ tabKey: t.tabKey, url: t.url, title: t.title, active: false, agent: true, sessionId: t.sessionId }));
  }

  /** The open tabs (of one session), their URL and title read fresh from the helper when it answers. */
  private async liveTabs(sessionId?: string): Promise<PoolTab[]> {
    const proc = this.proc;
    if (proc?.alive !== true) return [];
    const mine = [...this.tabs.values()].filter((t) => t.proc === proc && (sessionId === undefined || t.sessionId === sessionId));
    if (mine.length === 0) return [];
    try {
      const r = await this.command(proc, "tabs.live", {}) as { tabs?: Array<{ tabId?: unknown; url?: unknown; title?: unknown }> };
      for (const row of r?.tabs ?? []) {
        const t = typeof row.tabId === "string" ? this.tabs.get(row.tabId) : undefined;
        if (t === undefined) continue;
        if (typeof row.url === "string") t.url = row.url;
        if (typeof row.title === "string") t.title = row.title;
      }
    } catch { /* the last known url and title */ }
    return mine;
  }

  /** The tab, for a command — the setting read now (off stops the helper at once, not at its next poll). */
  private live(tabKey: string): PoolTab {
    if (!this.stillEnabled()) throw new TransportError("disconnected", HEADLESS_DISABLED_REASON);
    const t = this.tabs.get(tabKey);
    if (t === undefined || !t.proc.alive) throw new TransportError("tab_gone", t === undefined ? "the headless tab is gone" : STOPPED);
    return t;
  }

  /** The tab, for one of the AGENT's commands: refused while the person holds it (or is taking it). */
  private agentTab(tabKey: string): PoolTab {
    const t = this.live(tabKey);
    if (t.presentation?.control === true || t.presentation?.taking === true) throw new TransportError("capacity", HEADLESS_USER_HAS_TAB, { userHasTab: true });
    return t;
  }

  /** One agent command on `t`, counted while it is in flight (a take-over waits for it). */
  private async agentCommand<T>(t: PoolTab, run: () => Promise<T>): Promise<T> {
    t.inflight++;
    try { return await run(); } finally {
      t.inflight--;
      if (t.inflight === 0) for (const w of [...this.drainWaiters]) w();
    }
  }

  /** When a page in this tab last tried to reach the local network and the helper refused it (undefined: never). */
  localNetworkRefusedAt(tabKey: string): number | undefined { return this.tabs.get(tabKey)?.localNetworkAt; }

  async attach(tabKey: string, opts: { sessionId: string }): Promise<{ viewport: [w: number, h: number]; dpr: number }> {
    const t = this.agentTab(tabKey);
    if (t.sessionId !== opts.sessionId) throw new TransportError("not_allowed", "that headless tab belongs to another session");
    const r = await this.agentCommand(t, () => this.command(t.proc, "tab.ensure", { sessionId: t.sessionId, tabId: tabKey }, this.deps.timeouts?.ensure ?? HEADLESS_TIMEOUTS.ensure)) as { viewport?: unknown; dpr?: unknown };
    const vp = Array.isArray(r?.viewport) && r.viewport.length === 2 ? r.viewport : [0, 0];
    return { viewport: [Number(vp[0]) || 0, Number(vp[1]) || 0], dpr: typeof r?.dpr === "number" && r.dpr > 0 ? r.dpr : 1 };
  }

  async detach(tabKey: string): Promise<void> {
    const t = this.tabs.get(tabKey);
    if (t === undefined || !t.proc.alive) return;
    await this.agentCommand(t, () => this.command(t.proc, "tab.release", { tabId: tabKey }));
  }

  async send<T = unknown>(tabKey: string, method: string, params: Record<string, unknown> = {}, opts: { cdpSessionId?: string; timeoutMs?: number } = {}): Promise<T> {
    if (!CDP_ALLOWED_METHODS.includes(method)) throw new TransportError("not_allowed", `${method} is not on the allowlist`);
    const t = this.agentTab(tabKey);
    const timeout = opts.timeoutMs ?? (method === "Page.captureScreenshot" ? (this.deps.timeouts?.screenshot ?? HEADLESS_TIMEOUTS.screenshot) : (this.deps.timeouts?.send ?? HEADLESS_TIMEOUTS.send));
    const r = await this.agentCommand(t, () => this.command(t.proc, "cdp.send", { tabId: tabKey, method, params, ...(opts.cdpSessionId === undefined ? {} : { cdpSessionId: opts.cdpSessionId }) }, timeout)) as { result?: unknown };
    return (r?.result ?? {}) as T;
  }

  async subscribe(tabKey: string, events: readonly string[]): Promise<void> {
    const bad = events.find((e) => !CDP_ALLOWED_EVENTS.includes(e));
    if (bad !== undefined) throw new TransportError("not_allowed", `${bad} is not an allowed event`);
    const t = this.agentTab(tabKey);
    await this.agentCommand(t, () => this.command(t.proc, "cdp.subscribe", { tabId: tabKey, events: [...events] }));
  }

  // ── presentation: a headless tab shown in Winter's panel (lane H3) ─────────────────────────────────────────────

  /** Why a headless tab can't be shown in Winter's panel now (the model's sentence), or undefined when it can. */
  presentMissing(): string | undefined {
    const missing = this.deps.viewerMissing?.() ?? (this.deps.viewer === undefined ? "this Winter can't show a headless tab" : undefined);
    if (missing !== undefined) return missing;
    if (this.deps.viewer?.() === undefined) return "Winter isn't running — ask the user to open Winter";
    const proc = this.proc;
    if (proc?.alive === true && proc.version !== undefined && !proc.has("present")) return "Winter's headless browser is too old to show a tab — ask the user to update Winter";
    return undefined;
  }

  /** The `waitForUser` hand-off (`CdpTransport.present`): the tab shown in Winter's panel with the person in control. */
  async present(tabKey: string, opts: { sessionId: string }): Promise<void> {
    const t = this.live(tabKey);
    if (t.sessionId !== opts.sessionId) throw new TransportError("not_allowed", "that headless tab belongs to another session");
    if (t.presentation !== undefined && t.presentation.started && t.presentation.control) {
      // The person already holds it (they took over a watched tab): the same view, now the agent's hand-off.
      this.setPurpose(t, "handoff");
      t.presentation.handoffPending = true;
      return;
    }
    if (t.presentation !== undefined) await this.endPresentation(t, "shown again");
    await this.startPresentation(t, "handoff", true);
    if (t.presentation !== undefined) t.presentation.handoffPending = true;
  }

  /** The hand-off is over and the agent takes the tab back (after the person's Done): control returns, the panel's view
   *  goes. */
  async handBack(tabKey: string): Promise<void> {
    const t = this.tabs.get(tabKey);
    if (t?.presentation === undefined) return;
    t.presentation.handoffPending = false;
    await this.endPresentation(t, "done");
  }

  /** The hand-off's wait ended without the person's Done (Stop waiting, no answer): the tab stays with them — still
   *  shown, still theirs — until they hand it back or close it in the panel. */
  handoffOver(tabKey: string): void {
    const t = this.tabs.get(tabKey);
    const p = t?.presentation;
    if (t === undefined || p === undefined) return;
    p.handoffPending = false;
    // Nobody waits any more: the panel offers Hand back instead of Done / Stop waiting.
    if (p.purpose === "handoff") this.setPurpose(t, "watch");
  }

  /** Why `t`'s view is shown changed: the app hears it (its chrome's buttons follow) once the view is up. */
  private setPurpose(t: PoolTab, purpose: "handoff" | "watch"): void {
    const p = t.presentation;
    if (p === undefined || p.purpose === purpose) return;
    p.purpose = purpose;
    if (p.started) this.deps.viewer?.()?.update({ sessionId: t.sessionId, tabId: t.tabKey, purpose });
  }

  /** The panel's Done / Stop waiting for a hand-off (the engine's `waitForUser` listens). */
  onUserDone(listener: (tabKey: string, done: boolean) => void): () => void { this.userDoneListeners.add(listener); return () => { this.userDoneListeners.delete(listener); }; }

  /** The person's action in the panel on one of a session's headless tabs (`browserLink.headless`). */
  async panelAction(sessionId: string, tabKey: string, action: "watch" | "takeOver" | "handBack" | "done" | "stopWaiting" | "close"): Promise<void> {
    const t = this.tabs.get(tabKey);
    if (t === undefined || t.sessionId !== sessionId || !t.proc.alive) throw new AutomationFailure("TargetLost", "that headless tab is gone");
    const p = t.presentation;
    switch (action) {
      case "watch":
        if (p !== undefined) await this.endPresentation(t, "shown again");
        await this.startPresentation(t, "watch", false);
        return;
      case "takeOver":
        if (p === undefined) throw new AutomationFailure("NotAllowed", "the tab is not shown — watch it first");
        await this.grantControl(t);
        return;
      case "handBack":
        if (p === undefined) return;
        if (p.handoffPending) { this.userDone(tabKey, true); return; }
        await this.releaseControl(t);
        return;
      case "done":
        // Answering a hand-off: the engine takes the tab back (`handBack`). Nobody waiting any more: the same, here.
        if (p?.handoffPending === true) { this.userDone(tabKey, true); return; }
        if (p !== undefined) await this.endPresentation(t, "done");
        return;
      case "stopWaiting":
        if (p?.handoffPending === true) this.userDone(tabKey, false);
        return;
      case "close":
        if (p === undefined) return;
        if (p.handoffPending) this.userDone(tabKey, false);
        await this.endPresentation(t, "closed in the panel", { hide: false });
        // A window the person opened is closed with its view: it was theirs alone.
        if (t.openerTabKey !== undefined && this.tabs.get(t.tabKey) === t) {
          this.tabs.delete(t.tabKey);
          void this.closingWhile(this.command(t.proc, "tab.close", { tabId: t.tabKey })).catch(() => undefined).finally(() => this.armIdle());
          this.pushTabs(t.sessionId);
        }
        return;
    }
  }

  /** The session's headless tabs, for the panel's list. */
  async panelTabs(sessionId: string): Promise<HeadlessTabRow[]> {
    return (await this.liveTabs(sessionId)).filter((t) => t.openerTabKey === undefined).map((t) => this.row(t));
  }

  private row(t: PoolTab): HeadlessTabRow {
    return { tabId: t.tabKey, url: t.url, title: t.title, presented: t.presentation?.started === true, control: t.presentation?.control === true };
  }

  private userDone(tabKey: string, done: boolean): void {
    for (const l of [...this.userDoneListeners]) {
      try { l(tabKey, done); } catch { /* a listener never breaks the pool */ }
    }
  }

  /** The panel hears the session's tab list (debounced; best effort). */
  private pushTabs(sessionId: string): void {
    if (this.deps.viewer === undefined || this.tabsPush.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.tabsPush.delete(sessionId);
      const viewer = this.deps.viewer?.();
      if (viewer === undefined) return;
      const rows = [...this.tabs.values()].filter((t) => t.sessionId === sessionId && t.presentation?.closeWhenReleased !== true && t.openerTabKey === undefined)
        .map((t) => this.row(t));
      viewer.tabs({ sessionId, tabs: rows });
    }, 100);
    (timer as { unref?: () => void }).unref?.();
    this.tabsPush.set(sessionId, timer);
  }

  /**
   * Show `t` in the panel: the helper checks in a presentation service for it (accepting only Winter.app, by code
   * signature, naming a fresh nonce), the app is told to connect to it, and the viewer's acceptance is awaited. Nobody
   * accepted in time: the presentation is ended and the call fails, typed. `control`: the person holds the tab from the
   * start (the agent's commands in flight finish first).
   */
  private async startPresentation(t: PoolTab, purpose: "handoff" | "watch" | "popup", control: boolean): Promise<void> {
    const missing = this.presentMissing();
    if (missing !== undefined) throw new AutomationFailure("BrowserUnavailable", `Winter can't show the headless tab: ${missing}`);
    const viewer = this.deps.viewer?.();
    const engine = this.engineFor();
    if (viewer === undefined || "missing" in engine) throw new AutomationFailure("BrowserUnavailable", "Winter can't show the headless tab right now");
    if (!t.proc.has("present")) throw new AutomationFailure("BrowserUnavailable", "Winter's headless browser is too old to show a tab — ask the user to update Winter");
    const nonce = randomBytes(8).toString("hex");
    const p: Presentation = {
      nonce, service: "", purpose, control: false, taking: control, started: false, startWaiters: new Set(), handoffPending: false, closeWhenReleased: false,
    };
    t.presentation = p;
    try {
      if (control) {
        await this.drain(t);
        // A window the person opened was never the agent's: nothing to undo.
        if (t.openerTabKey === undefined) await this.yieldToPerson(t);
      }
      if (t.presentation !== p) throw new AutomationFailure("TargetBusy", "the tab's presentation changed meanwhile — try again");
      const r = await this.command(t.proc, "headless.present", {
        tabId: t.tabKey, nonce, viewerRequirement: this.deps.viewerRequirement?.() ?? "", control, scale: 1,
      }) as { service?: unknown };
      if (typeof r?.service !== "string" || r.service.length === 0) throw new Error("the headless browser named no presentation service");
      p.service = r.service;
      p.control = control;
      p.taking = false;
      const show: HeadlessShowParams = {
        sessionId: t.sessionId, tabId: t.tabKey, service: r.service, nonce, producerRequirement: engine.requirement, control, purpose,
        url: t.url, title: t.title, uploadDir: headlessUploadDir(this.deps.home),
      };
      await viewer.show(show);
      if (!(await this.waitStarted(p))) throw new Error("Winter's panel did not connect to it in time");
      this.pushTabs(t.sessionId);
    } catch (err) {
      if (t.presentation === p) await this.endPresentation(t, "not shown");
      if (err instanceof AutomationFailure) throw err;
      throw new AutomationFailure("BrowserUnavailable", `Winter could not show the headless tab (${err instanceof Error ? err.message : "error"})`);
    }
  }

  /** The viewer's acceptance (`headless.presentationStarted`), or false after `HEADLESS_PRESENT_START_MS`. */
  private waitStarted(p: Presentation): Promise<boolean> {
    if (p.started) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (started: boolean): void => { clearTimeout(timer); p.startWaiters.delete(done); resolve(started); };
      const timer = setTimeout(() => done(false), this.deps.presentStartMs ?? HEADLESS_PRESENT_START_MS);
      p.startWaiters.add(done);
    });
  }

  private readonly drainWaiters = new Set<() => void>();

  /** No new agent command on `t` from now (`taking`), and the ones in flight finish — `HEADLESS_DRAIN_MS` at most. */
  private async drain(t: PoolTab): Promise<void> {
    if (t.presentation !== undefined) t.presentation.taking = true;
    if (t.inflight === 0) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        if (t.inflight > 0 && !timedOut) return;
        clearTimeout(timer); this.drainWaiters.delete(done); resolve();
      };
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; done(); }, this.deps.drainMs ?? HEADLESS_DRAIN_MS);
      this.drainWaiters.add(done);
    });
  }

  /**
   * Before the person gets control: what the agent's attachment turned on that a person would trip over goes — the
   * file chooser it intercepts (the page's file input then opens Winter's picker), its emulated focus and viewport — and
   * the engine is told the tab "stopped", so it attaches afresh (turning them back on) at its next command after the
   * hand-back. Best effort: a tab the agent never attached has nothing to undo.
   */
  private async yieldToPerson(t: PoolTab): Promise<void> {
    const undo: Array<[string, Record<string, unknown>]> = [
      ["Page.setInterceptFileChooserDialog", { enabled: false }], ["Emulation.setFocusEmulationEnabled", { enabled: false }], ["Emulation.clearDeviceMetricsOverride", {}],
    ];
    for (const [method, params] of undo) {
      try { await this.command(t.proc, "cdp.send", { tabId: t.tabKey, method, params }, 2_000); } catch { /* not attached: nothing to undo */ }
    }
    for (const l of [...this.goneListeners]) {
      try { l(t.tabKey, "stopped"); } catch { /* a listener never breaks the pool */ }
    }
  }

  /** The person takes over a shown tab: the agent's commands in flight finish, then control is theirs. */
  private async grantControl(t: PoolTab): Promise<void> {
    const p = t.presentation;
    if (p === undefined || p.control) return;
    await this.drain(t);
    if (t.presentation !== p) return;
    await this.yieldToPerson(t);
    try {
      await this.command(t.proc, "headless.control", { tabId: t.tabKey, control: true });
      p.control = true;
    } finally {
      p.taking = false;
    }
    this.pushTabs(t.sessionId);
  }

  /** Control goes back to the agent; the tab stays shown, watch only. A close the turn's end asked for happens now. */
  private async releaseControl(t: PoolTab): Promise<void> {
    const p = t.presentation;
    if (p === undefined) return;
    p.taking = false;
    if (p.control) {
      p.control = false;
      try { await this.command(t.proc, "headless.control", { tabId: t.tabKey, control: false }); } catch { /* the presentation may be gone */ }
    }
    await this.closeWindowsOf(t);
    if (p.closeWhenReleased) { await this.endPresentation(t, "closed"); return; }
    this.pushTabs(t.sessionId);
  }

  /** The windows the person opened from `t` (sign-in windows) close when they let `t` go: they were theirs alone. */
  private async closeWindowsOf(t: PoolTab): Promise<void> {
    for (const w of [...this.tabs.values()].filter((x) => x.openerTabKey === t.tabKey)) {
      this.tabs.delete(w.tabKey);
      if (w.presentation !== undefined) await this.endPresentation(w, "closed");
      if (w.proc.alive) void this.closingWhile(this.command(w.proc, "tab.close", { tabId: w.tabKey })).catch(() => undefined).finally(() => this.armIdle());
    }
  }

  /**
   * A window the page opened while the person held `opener` in the panel (`headless.popupOpened` — a sign-in window, as
   * a rule): a tab of the opener's session that only the person uses, shown in the panel beside its opener with them in
   * control. The opener no longer held, or the budget spent: closed at once.
   */
  private async adoptWindow(proc: WinterHeadlessProcess, e: { tabKey: string; openerTabKey: string; url: string }): Promise<void> {
    const opener = this.tabs.get(e.openerTabKey);
    const refuse = (why: string): void => {
      this.deps.log?.(`computer-use: a window a page in Winter's headless browser opened was closed (${why})`);
      void this.closingWhile(this.command(proc, "tab.close", { tabId: e.tabKey })).catch(() => undefined);
    };
    if (opener === undefined || opener.proc !== proc || opener.presentation?.control !== true) { refuse("its opener is no longer the person's"); return; }
    if (this.tabCount(opener.sessionId) >= HEADLESS_TABS_PER_SESSION || this.tabs.size >= HEADLESS_TABS_GLOBAL) { refuse("too many headless tabs are open"); return; }
    const w: PoolTab = { tabKey: e.tabKey, sessionId: opener.sessionId, proc, url: e.url, title: "", noticed: new Set(), inflight: 0, openerTabKey: opener.tabKey };
    this.tabs.set(w.tabKey, w);
    try {
      await this.startPresentation(w, "popup", true);
    } catch (err) {
      this.deps.log?.(`computer-use: a window the person opened could not be shown (${err instanceof Error ? err.message : "error"}) — closed`);
      if (this.tabs.get(w.tabKey) === w) {
        this.tabs.delete(w.tabKey);
        void this.closingWhile(this.command(proc, "tab.close", { tabId: w.tabKey })).catch(() => undefined);
      }
    }
  }

  /** End `t`'s presentation: the helper stops it (the viewer is told), the panel's view goes, control returns to the
   *  agent, and a close the turn's end asked for happens now. */
  private async endPresentation(t: PoolTab, reason: string, o: { hide?: boolean } = {}): Promise<void> {
    const p = t.presentation;
    if (p === undefined) return;
    t.presentation = undefined;
    await this.closeWindowsOf(t);
    for (const w of [...p.startWaiters]) w(false);
    if (t.proc.alive) {
      try { await this.command(t.proc, "headless.unpresent", { tabId: t.tabKey }); } catch { /* it may have ended already */ }
    }
    if (o.hide !== false) {
      try { await this.deps.viewer?.()?.hide({ sessionId: t.sessionId, tabId: t.tabKey, reason }); } catch { /* the panel may be gone */ }
    }
    if (p.closeWhenReleased && this.tabs.get(t.tabKey) === t) {
      this.tabs.delete(t.tabKey);
      if (t.proc.alive) void this.closingWhile(this.command(t.proc, "tab.close", { tabId: t.tabKey })).catch(() => undefined).finally(() => this.armIdle());
      this.emitGone(t.tabKey, "closed");
    }
    this.pushTabs(t.sessionId);
  }

  /** A tab gone (closed, crashed, the helper stopped): its presentation is over; the panel's view goes. */
  private forgetPresentation(t: PoolTab, reason: string): void {
    const p = t.presentation;
    if (p === undefined) return;
    t.presentation = undefined;
    for (const w of [...p.startWaiters]) w(false);
    if (p.handoffPending) this.userDone(t.tabKey, false);
    void Promise.resolve(this.deps.viewer?.()?.hide({ sessionId: t.sessionId, tabId: t.tabKey, reason })).catch(() => undefined);
    this.pushTabs(t.sessionId);
  }

  /** The helper says a presentation's viewer was accepted, or that the viewer ended it, or that a tab's view changed. */
  private presentationEvent(proc: WinterHeadlessProcess, e: HeadlessPresentationEvent): void {
    if (e.kind === "popup") { void this.adoptWindow(proc, e); return; }
    if (e.kind === "view") { this.viewChanged(proc, e); return; }
    const t = this.tabs.get(e.tabKey);
    if (t === undefined || t.proc !== proc || t.presentation === undefined) return;
    const p = t.presentation;
    if (e.kind === "started") {
      p.started = true;
      for (const w of [...p.startWaiters]) w(true);
      return;
    }
    // The viewer went away (the person closed it, Winter.app quit): the presentation is over and control returns to the
    // agent. A hand-off it was answering reads as not done.
    t.presentation = undefined;
    for (const w of [...p.startWaiters]) w(false);
    if (p.handoffPending) this.userDone(t.tabKey, false);
    if (p.closeWhenReleased && this.tabs.get(t.tabKey) === t) {
      this.tabs.delete(t.tabKey);
      void this.closingWhile(this.command(proc, "tab.close", { tabId: t.tabKey })).catch(() => undefined).finally(() => this.armIdle());
      this.emitGone(t.tabKey, "closed");
    }
    this.pushTabs(t.sessionId);
  }

  /** The page was laid out in another size (the panel's while the person looks, the agent's after). A scale alone
   *  moves nothing on the page and is not counted. */
  private viewChanged(proc: WinterHeadlessProcess, e: { tabKey: string; width: number; height: number }): void {
    const t = this.tabs.get(e.tabKey);
    if (t === undefined || t.proc !== proc) return;
    const now = t.view ?? HEADLESS_AGENT_VIEW;
    if (now.width === e.width && now.height === e.height) return;
    t.view = { width: e.width, height: e.height };
    t.viewEpoch = (t.viewEpoch ?? 0) + 1;
  }

  /** Lane H3: the size a headless tab's page is laid out in, once it has changed from the agent's own — how many times,
   *  and whether a person watches it now (the engine says so once, and refuses a Point of an earlier screenshot). */
  view(tabKey: string): { epoch: number; width: number; height: number; watched: boolean } | undefined {
    const t = this.tabs.get(tabKey);
    if (t?.view === undefined) return undefined;
    return { epoch: t.viewEpoch ?? 0, width: t.view.width, height: t.view.height, watched: t.presentation?.started === true };
  }

  onEvent(listener: (e: CdpEvent) => void): () => void { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener); }; }
  onTabGone(listener: (tabKey: string, reason: "closed" | "crashed" | "stopped" | "detached_by_user") => void): () => void { this.goneListeners.add(listener); return () => { this.goneListeners.delete(listener); }; }
  /** Nobody can see a headless tab: no cursor, no glow. */
  overlay(): void {}
  onStop(): () => void { return () => {}; }

  private event(proc: WinterHeadlessProcess, e: CdpEvent): void {
    if (this.tabs.get(e.tabKey)?.proc !== proc) return;
    for (const l of [...this.eventListeners]) {
      try { l(e); } catch { /* a listener never breaks the pool */ }
    }
  }

  /** A page tried something the helper refused: one daemon line per tab and kind (never the page's address). */
  private notice(proc: WinterHeadlessProcess, tabKey: string, kind: HeadlessNoticeKind): void {
    const t = this.tabs.get(tabKey);
    if (t === undefined || t.proc !== proc) return;
    if (kind === "local-network") t.localNetworkAt = this.now();
    if (t.noticed.has(kind)) return;
    t.noticed.add(kind);
    this.deps.log?.(NOTICE_LINES[kind]);
  }

  /** The helper lost a tab by itself (its renderer crashed). */
  private helperTabGone(proc: WinterHeadlessProcess, tabKey: string, reason: "closed" | "crashed" | "stopped"): void {
    const t = this.tabs.get(tabKey);
    if (t === undefined || t.proc !== proc) return;
    this.tabs.delete(tabKey);
    this.forgetPresentation(t, reason === "closed" ? "the tab closed" : "the page crashed");
    this.emitGone(tabKey, reason === "stopped" ? "crashed" : reason);
    this.armIdle();
  }

  private emitGone(tabKey: string, reason: "closed" | "crashed"): void {
    for (const l of [...this.goneListeners]) {
      try { l(tabKey, reason); } catch { /* a listener never breaks the pool */ }
    }
  }
}
