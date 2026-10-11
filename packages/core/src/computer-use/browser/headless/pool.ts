// ComputerV2 Phase 4 — the HEADLESS POOL: the `headless` backend (family `headless`, one instance, "Winter
// (headless)"). Winter's private, invisible browser for background reading: every tab is an agent tab of the session
// that opened it, in that session's own in-memory browser context, and nothing of it is ever shown to anyone.
//
// The pool implements the pinned `CdpTransport` and runs its ENGINE — Winter Headless, the windowless CEF helper
// (`winter-engine.ts`, `engines.ts`) — on demand:
//   - started by the first tab (`createTab`), never by a listing (`listTabs` answers `[]` with nothing running);
//   - at most 8 open tabs per session and 24 in all, and no new tab while the helper's process tree holds more than
//     3 GB (D3): running out answers `capacity` (the engine reads it as `TargetBusy`); nothing is closed for the model;
//   - gone after 5 minutes with no tab, at daemon stop, and when `computerUse.headless.enabled` turns off (read live);
//   - a crash loses every tab (`tabGone(crashed)`; the next `browsers.open` starts a fresh helper);
//   - `<home>/run/headless.pid` names the running helper (pid + start time) and `<home>/cache/headless-cef/<random>`
//     is its own cache root, so the next daemon's boot sweep (`sweepHeadless`) can clear what a dead one left.
// A session's context (its cookies) outlives its tabs while the helper runs, and goes when the session's runtime ends
// (`disposeSession`) or the helper exits.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { processStartSeconds } from "../../../auth/credential-migration-lock";
import { AutomationFailure } from "../../errors";
import type { PrimitiveMetric } from "../../telemetry";
import { CDP_ALLOWED_EVENTS, CDP_ALLOWED_METHODS } from "../cdp-allowlist";
import { TransportError, type CdpEvent, type CdpTransport, type TransportTab } from "../transport";
import { DEFAULT_HEADLESS_ENGINE, HEADLESS_ENGINES, type ResolvedEngine } from "./engines";
import { HEADLESS_PIPE_PROTOCOL, HEADLESS_TIMEOUTS, spawnEngineProcess, WinterHeadlessProcess, type SpawnEngine } from "./winter-engine";

/** D3: the open-tab budget and the memory guard. */
export const HEADLESS_TABS_PER_SESSION = 8;
export const HEADLESS_TABS_GLOBAL = 24;
export const HEADLESS_RSS_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;
/** The helper exits after this long with no headless tab open anywhere. */
export const HEADLESS_IDLE_EXIT_MS = 5 * 60_000;
/** How often a running helper re-reads `computerUse.headless.enabled`. */
export const HEADLESS_ENABLED_POLL_MS = 10_000;
/** The memory reading is reused this long. */
const RSS_CACHE_MS = 1_000;

export const HEADLESS_NAME = "Winter (headless)";
export const HEADLESS_DISABLED_REASON = "turned off in Settings";

const STOPPED = "Winter's headless browser stopped — open the page again";

export interface HeadlessPoolDeps {
  home: string;
  /** `computerUse.headless.enabled` (read live). */
  enabled(): boolean;
  /** The engine to run, or why there is none (`resolveWinterHeadless`). */
  resolve(): ResolvedEngine | { missing: string };
  spawn?: SpawnEngine;
  /** Does the spawned process satisfy the engine's designated requirement (`processSatisfiesRequirement`)? */
  verify?(pid: number, requirement: string): boolean;
  /** The resident memory of a process and every process under it, bytes (`ps`). */
  rssOf?(rootPid: number): number | undefined;
  /** `headless.launch` / `headless.exit` metric lines. */
  metric?(m: PrimitiveMetric): void;
  now?(): number;
  idleExitMs?: number;
  enabledPollMs?: number;
  timeouts?: Partial<Record<keyof typeof HEADLESS_TIMEOUTS, number>>;
  log?(line: string): void;
}

interface PoolTab { tabKey: string; sessionId: string; proc: WinterHeadlessProcess; url: string; title: string }

type ExitReason = "idle" | "stop" | "crash" | "disabled";

/** `<home>/run/headless.pid`. */
export function headlessPidPath(home: string): string { return join(home, "run", "headless.pid"); }
/** `<home>/cache/headless-cef`: one random directory per helper run below it. */
export function headlessCacheRoot(home: string): string { return join(home, "cache", "headless-cef"); }

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
}

/** The whole process tree's resident memory, bytes, from one `ps` (`-A -o pid=,ppid=,rss=`). */
export function processTreeRss(rootPid: number): number | undefined {
  const r = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C" } });
  if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]); const ppid = Number(m[2]);
    rss.set(pid, Number(m[3]) * 1024);
    const list = children.get(ppid);
    if (list === undefined) children.set(ppid, [pid]); else list.push(pid);
  }
  if (!rss.has(rootPid)) return undefined;
  let total = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

export class HeadlessPool implements CdpTransport {
  readonly backend = "headless";
  readonly family = "headless" as const;
  private proc: WinterHeadlessProcess | undefined;
  private launching: Promise<WinterHeadlessProcess> | undefined;
  private runDir: string | undefined;
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
  private rss: { at: number; pid: number; bytes: number | undefined } | undefined;

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

  /** The engines this pool can run now (`browsers.list()`'s `engines`, once H2 declares it). */
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
    const child = (this.deps.spawn ?? spawnEngineProcess)(r.executable, [`--winter-cache-root=${runDir}`]);
    const proc = new WinterHeadlessProcess(child, { ...(this.deps.timeouts === undefined ? {} : { timeouts: this.deps.timeouts }), ...(this.deps.log === undefined ? {} : { log: this.deps.log }) });
    this.proc = proc;
    this.runDir = runDir;
    this.exitReason = undefined;
    proc.onExit((code, signal) => this.exited(proc, code, signal));
    proc.onEvent((e) => this.event(proc, e));
    proc.onTabGone((tabKey, reason) => this.helperTabGone(proc, tabKey, reason));
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
    this.cleanupRun();
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
    if (this.proc !== proc) return;
    const reason: ExitReason = this.exitReason ?? "crash";
    this.proc = undefined;
    this.clearTimers();
    const lost = [...this.tabs.values()].filter((t) => t.proc === proc);
    for (const t of lost) this.tabs.delete(t.tabKey);
    // A crash, or the setting turned off: the tabs the model still holds read why.
    if (reason === "crash" || reason === "disabled") for (const t of lost) this.emitGone(t.tabKey, reason === "crash" ? "crashed" : "closed");
    if (reason === "crash") this.deps.log?.(`computer-use: Winter's headless browser exited unexpectedly (${signal ?? `exit ${code ?? "?"}`}); ${lost.length} tab(s) lost`);
    this.metric("headless.exit", this.launchedAt === 0 ? 0 : this.now() - this.launchedAt, { headlessEngine: DEFAULT_HEADLESS_ENGINE, exitReason: reason });
    this.cleanupRun();
  }

  private cleanupRun(): void {
    try { rmSync(headlessPidPath(this.deps.home), { force: true }); } catch { /* best effort */ }
    if (this.runDir !== undefined) {
      try { rmSync(this.runDir, { recursive: true, force: true }); } catch { /* the next boot sweeps it */ }
      this.runDir = undefined;
    }
  }

  private shutdown(reason: Exclude<ExitReason, "crash">): void {
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
    this.enabledTimer = setInterval(() => {
      let on = true;
      try { on = this.deps.enabled(); } catch { on = false; }
      if (!on) {
        this.deps.log?.("computer-use: Winter's headless browser was turned off in Settings — stopping it");
        this.shutdown("disabled");
      }
    }, this.deps.enabledPollMs ?? HEADLESS_ENABLED_POLL_MS);
    (this.enabledTimer as { unref?: () => void }).unref?.();
  }

  private metric(primitive: string, ms: number, extra: Partial<PrimitiveMetric>): void {
    try { this.deps.metric?.({ ts: this.now(), sessionId: "", callId: "", primitive, ms, helperMs: 0, backend: "headless", ...extra }); } catch { /* never fails anything */ }
  }

  /** Daemon stop: the helper is killed at once (its tabs go with it). */
  stop(): void {
    this.stopped = true;
    this.shutdown("stop");
    this.clearTimers();
    // The daemon may be gone before the exit is reported: what this run made goes now.
    this.cleanupRun();
  }

  /** The session's runtime ended (idle, deleted): its tabs are forgotten and its context (its cookies) disposed. */
  disposeSession(sessionId: string): void {
    const mine = [...this.tabs.values()].filter((t) => t.sessionId === sessionId);
    for (const t of mine) { this.tabs.delete(t.tabKey); this.emitGone(t.tabKey, "closed"); }
    const proc = this.proc;
    if (proc?.alive === true) {
      void proc.command("context.dispose", { sessionId }).catch((err: unknown) => this.deps.log?.(`computer-use: disposing a headless context failed (${err instanceof Error ? err.message : "error"})`));
    }
    this.armIdle();
  }

  // ── tabs ────────────────────────────────────────────────────────────────────────────────────────

  private capacity(message: string): TransportError { return new TransportError("capacity", message); }

  private memoryOf(pid: number): number | undefined {
    const now = this.now();
    if (this.rss !== undefined && this.rss.pid === pid && now - this.rss.at < RSS_CACHE_MS) return this.rss.bytes;
    let bytes: number | undefined;
    try { bytes = (this.deps.rssOf ?? processTreeRss)(pid); } catch { bytes = undefined; }
    this.rss = { at: now, pid, bytes };
    return bytes;
  }

  async createTab(opts: { sessionId: string; sessionTitle?: string; url: string; tabKey?: string; engine?: string }): Promise<TransportTab> {
    if (this.stopped) throw new TransportError("disconnected", "Winter is shutting down");
    const engine = opts.engine ?? DEFAULT_HEADLESS_ENGINE;
    if (!(HEADLESS_ENGINES as readonly string[]).includes(engine)) throw new TransportError("not_allowed", `no headless engine "${engine}" — the engines are: ${HEADLESS_ENGINES.join(", ")}`);
    if (!this.connected) throw new TransportError("disconnected", this.reason ?? "unavailable");
    // The budget, counted with the creations still in flight.
    const mine = this.tabCount(opts.sessionId) + (this.reserved.get(opts.sessionId) ?? 0);
    const all = this.tabs.size + [...this.reserved.values()].reduce((a, b) => a + b, 0);
    if (mine >= HEADLESS_TABS_PER_SESSION) throw this.capacity(`this session already has ${HEADLESS_TABS_PER_SESSION} headless tabs open — close one with tab.close()`);
    if (all >= HEADLESS_TABS_GLOBAL) throw this.capacity(`Winter's headless browser already has ${HEADLESS_TABS_GLOBAL} tabs open — close one with tab.close()`);
    const running = this.proc?.alive === true ? this.proc : undefined;
    if (running !== undefined) {
      const bytes = this.memoryOf(running.pid);
      if (bytes !== undefined && bytes > HEADLESS_RSS_LIMIT_BYTES) throw this.capacity("Winter's headless browser is using too much memory — close some tabs with tab.close()");
    }
    this.reserved.set(opts.sessionId, (this.reserved.get(opts.sessionId) ?? 0) + 1);
    if (this.idleTimer !== undefined) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    try {
      const proc = await this.engine();
      const tabKey = `w-${randomBytes(6).toString("hex")}`;
      const r = await proc.command("tab.ensure", { sessionId: opts.sessionId, tabId: tabKey, url: opts.url }, this.deps.timeouts?.ensure ?? HEADLESS_TIMEOUTS.ensure) as { url?: unknown; title?: unknown };
      const url = typeof r?.url === "string" ? r.url : opts.url;
      const title = typeof r?.title === "string" ? r.title : "";
      this.tabs.set(tabKey, { tabKey, sessionId: opts.sessionId, proc, url, title });
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
    this.tabs.delete(tabKey);
    try {
      if (t.proc.alive) await t.proc.command("tab.close", { tabId: tabKey });
    } finally {
      this.armIdle();
    }
  }

  /** A headless tab is never handed to anyone (the engine refuses `keep()` first). */
  async keepTab(): Promise<void> {}

  /** The open headless tabs — `[]`, and nothing started, while the helper is not running. */
  async listTabs(opts?: { sessionId?: string }): Promise<TransportTab[]> {
    const proc = this.proc;
    if (proc?.alive !== true) return [];
    const mine = [...this.tabs.values()].filter((t) => t.proc === proc && (opts?.sessionId === undefined || t.sessionId === opts.sessionId));
    if (mine.length === 0) return [];
    try {
      const r = await proc.command("tabs.live", {}) as { tabs?: Array<{ tabId?: unknown; url?: unknown; title?: unknown }> };
      for (const row of r?.tabs ?? []) {
        const t = typeof row.tabId === "string" ? this.tabs.get(row.tabId) : undefined;
        if (t === undefined) continue;
        if (typeof row.url === "string") t.url = row.url;
        if (typeof row.title === "string") t.title = row.title;
      }
    } catch { /* the last known url and title */ }
    return mine.map((t) => ({ tabKey: t.tabKey, url: t.url, title: t.title, active: false, agent: true, sessionId: t.sessionId }));
  }

  private live(tabKey: string): PoolTab {
    const t = this.tabs.get(tabKey);
    if (t === undefined || !t.proc.alive) throw new TransportError("tab_gone", t === undefined ? "the headless tab is gone" : STOPPED);
    return t;
  }

  async attach(tabKey: string, opts: { sessionId: string }): Promise<{ viewport: [w: number, h: number]; dpr: number }> {
    const t = this.live(tabKey);
    if (t.sessionId !== opts.sessionId) throw new TransportError("not_allowed", "that headless tab belongs to another session");
    const r = await t.proc.command("tab.ensure", { sessionId: t.sessionId, tabId: tabKey }, this.deps.timeouts?.ensure ?? HEADLESS_TIMEOUTS.ensure) as { viewport?: unknown; dpr?: unknown };
    const vp = Array.isArray(r?.viewport) && r.viewport.length === 2 ? r.viewport : [0, 0];
    return { viewport: [Number(vp[0]) || 0, Number(vp[1]) || 0], dpr: typeof r?.dpr === "number" && r.dpr > 0 ? r.dpr : 1 };
  }

  async detach(tabKey: string): Promise<void> {
    const t = this.tabs.get(tabKey);
    if (t === undefined || !t.proc.alive) return;
    await t.proc.command("tab.release", { tabId: tabKey });
  }

  async send<T = unknown>(tabKey: string, method: string, params: Record<string, unknown> = {}, opts: { cdpSessionId?: string; timeoutMs?: number } = {}): Promise<T> {
    if (!CDP_ALLOWED_METHODS.includes(method)) throw new TransportError("not_allowed", `${method} is not on the allowlist`);
    const t = this.live(tabKey);
    const timeout = opts.timeoutMs ?? (method === "Page.captureScreenshot" ? (this.deps.timeouts?.screenshot ?? HEADLESS_TIMEOUTS.screenshot) : (this.deps.timeouts?.send ?? HEADLESS_TIMEOUTS.send));
    const r = await t.proc.command("cdp.send", { tabId: tabKey, method, params, ...(opts.cdpSessionId === undefined ? {} : { cdpSessionId: opts.cdpSessionId }) }, timeout) as { result?: unknown };
    return (r?.result ?? {}) as T;
  }

  async subscribe(tabKey: string, events: readonly string[]): Promise<void> {
    const bad = events.find((e) => !CDP_ALLOWED_EVENTS.includes(e));
    if (bad !== undefined) throw new TransportError("not_allowed", `${bad} is not an allowed event`);
    const t = this.live(tabKey);
    await t.proc.command("cdp.subscribe", { tabId: tabKey, events: [...events] });
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

  /** The helper lost a tab by itself (its renderer crashed). */
  private helperTabGone(proc: WinterHeadlessProcess, tabKey: string, reason: "closed" | "crashed" | "stopped"): void {
    const t = this.tabs.get(tabKey);
    if (t === undefined || t.proc !== proc) return;
    this.tabs.delete(tabKey);
    this.emitGone(tabKey, reason === "stopped" ? "crashed" : reason);
    this.armIdle();
  }

  private emitGone(tabKey: string, reason: "closed" | "crashed"): void {
    for (const l of [...this.goneListeners]) {
      try { l(tabKey, reason); } catch { /* a listener never breaks the pool */ }
    }
  }
}
