// ComputerV2 (2026-10-08) — ONE `ComputerV2` call, end to end, and the per-session state between calls.
//
//   the capability server (`capabilities/computer-v2.ts`)
//     → `run()`: serialize per session, ensure the session's sandboxed worker (`worker-host.ts`), run the script
//       → every API call the script makes arrives here as a primitive: POLICY (`policy.ts`: floors, the user's
//         per-app setting, the per-app card), the per-target LOCK (`locks.ts`), the HELPER request
//         (`helper-client.ts`), the DIFF BASE (`diff-base.ts`), the screenshot BUDGET (`budget.ts`), TELEMETRY
//     → the RESULT (`result.ts`): ordered text and images, capped, fenced when the call read the screen.
//
// Runs of one session are SERIALIZED (one persistent runtime — a notebook kernel runs one cell at a time); runs of
// different sessions run at once and meet only at the locks. A run's timeout (default 30 s, at most 300 s) is
// PAUSED while a card waits for its human. A timeout or an interrupt cancels the run: the in-flight primitive
// rejects `Cancelled` (and the helper is told to stop that work by call id), every later primitive throws, and a
// script that has not settled 1 s later loses its worker (the SDK's cancel bound is 5 s).
import { randomBytes } from "node:crypto";
import { computerUsePrivateEventPathFrom, computerUseMirrorFrom, computerUseScreenshotMaxDimFrom, type Settings } from "../settings";
import { nextScreenshotQuality, screenshotBudgetFor, SCREENSHOT_BYTE_CAP, SCREENSHOT_QUALITY } from "./budget";
import { DiffBases } from "./diff-base";
import { AutomationFailure, isAutomationFailure } from "./errors";
import type { HelperClient } from "./helper-client";
import { FOREGROUND_LOCK_KEY, LOCK_WAIT_MS, TargetLocks } from "./locks";
import { ACT_PRIMITIVES, newRunGrants, type AppRef, type ComputerPolicy, type RunGrants } from "./policy";
import {
  HelperRpcError, HelperUnavailableError, WINTER_OWN_BUNDLE_IDS,
  type ActAction, type ActResult, type AppAtResult, type AppsListResult, type FindResult, type HelperNotification,
  type ScreenWindowsResult, type ScreenshotResult, type SnapshotResult, type TargetBindResult, type TargetWindowsResult,
  type WaitForResult, type WaitIdleResult,
} from "./protocol";
import type { RecentApps } from "./recent-apps";
import { ResultBuilder, type ResultContent } from "./result";
import type { AutomationTelemetry, PrimitiveMetric } from "./telemetry";
import { AutomationWorker, AutomationWorkerUnavailable, type AutomationWorkerOptions, type CallMessage } from "./worker-host";
import type { AppHandle, ImageHandle } from "./worker/bridge";

export const SCRIPT_TIMEOUT_DEFAULT_MS = 30_000;
export const SCRIPT_TIMEOUT_MIN_MS = 1_000;
export const SCRIPT_TIMEOUT_MAX_MS = 300_000;
/** A cancelled script that has not settled after this long loses its worker. */
export const CANCEL_KILL_MS = 1_000;
/** A session's worker ends after this long without a call (spec §4). */
export const WORKER_IDLE_MS = 30 * 60_000;
/** `state()`/`screenshot()` settle for at most this long after an action in the same call (spec §7). */
export const SETTLE_CAP_MS = 1_500;
export const WAIT_FOR_DEFAULT_MS = 10_000;
const IMAGES_KEPT = 16;

export interface ScriptInput { code: string; timeoutMs?: number; reset?: boolean; title?: string }
export interface ScriptCall {
  sessionId: string;
  /** The session's model tag (the screenshot budget). */
  model?: string;
  /** Does the model accept images? `false` refuses screenshot, show and Points with `NotAllowed`. */
  vision: boolean;
  /** The call's signal: the incarnation ending, or the runtime cancelling this call (an interrupt). */
  signal?: AbortSignal;
}
export interface ScriptResult { content: ResultContent[]; isError: boolean }

export interface ComputerV2ServiceDeps {
  helper: HelperClient;
  policy: ComputerPolicy;
  settings(): Settings | null | undefined;
  locks?: TargetLocks;
  diffBases?: DiffBases;
  telemetry?: AutomationTelemetry;
  /** The daemon's `audit.jsonl` sink. */
  audit?(line: Record<string, unknown>): void;
  recentApps?: RecentApps;
  worker?: AutomationWorkerOptions;
  /** Test seam: replaces `AutomationWorker.start`. */
  startWorker?(): Promise<AutomationWorker>;
  /** Interrupt a session's running turn, as `session.interrupt` does (the helper's Esc). */
  interrupt?(sessionId: string): void;
  idleMs?: number;
  now?(): number;
  log?(line: string): void;
}

interface TargetInfo { targetId: string; bundleId: string; name: string; pid: number; lost?: string }
interface StoredImage { data: string; mime: string; width: number; height: number }

interface SessionState {
  worker?: AutomationWorker;
  /** A worker existed in this session — a missing one next time is a RESTART the model is told about. */
  hadWorker: boolean;
  chain: Promise<void>;
  targets: Map<string, TargetInfo>;
  images: Map<string, StoredImage>;
  lastTargetShot: Map<string, string>;
  lastScreenShot?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  active?: RunCtx;
}

/** A timer that stops counting while a card waits for a human. */
class PausableTimer {
  private remaining: number;
  private startedAt = 0;
  private handle: ReturnType<typeof setTimeout> | undefined;
  private paused = 0;
  private done = false;
  constructor(ms: number, private readonly fire: () => void, private readonly now: () => number) {
    this.remaining = ms;
    this.start();
  }
  private start(): void {
    if (this.done) return;
    this.startedAt = this.now();
    this.handle = setTimeout(() => { this.done = true; this.fire(); }, Math.max(0, this.remaining));
  }
  pause(): void {
    if (this.done || this.paused++ > 0) return;
    if (this.handle !== undefined) clearTimeout(this.handle);
    this.remaining -= this.now() - this.startedAt;
  }
  resume(): void {
    if (this.done || this.paused === 0 || --this.paused > 0) return;
    this.start();
  }
  left(): number { return this.paused > 0 ? this.remaining : this.remaining - (this.now() - this.startedAt); }
  clear(): void { this.done = true; if (this.handle !== undefined) clearTimeout(this.handle); }
}

interface RunCtx {
  sessionId: string;
  runId: string;
  callId: string;
  call: ScriptCall;
  state: SessionState;
  worker: AutomationWorker;
  builder: ResultBuilder;
  grants: RunGrants;
  abort: AbortController;
  timer: PausableTimer;
  locks: Map<string, () => void>;
  acted: Set<string>;
  chains: Map<string, Promise<unknown>>;
  primitives: Map<string, number>;
  apps: Set<string>;
  appCache?: AppsListResult["apps"];
  cancelled?: string;
  timedOut: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  scriptActiveTold: boolean;
}

const isRef = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bad = (message: string): Error => Object.assign(new TypeError(message), { name: "TypeError" });

/** "this model can't see images" — the vision gate's one sentence (spec §12). */
const NO_VISION = "this model can't see images — use state()";

export class ComputerV2Service {
  private readonly sessions = new Map<string, SessionState>();
  readonly locks: TargetLocks;
  readonly diffBases: DiffBases;
  private stopped = false;

  constructor(private readonly deps: ComputerV2ServiceDeps) {
    this.locks = deps.locks ?? new TargetLocks();
    this.diffBases = deps.diffBases ?? new DiffBases();
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private log(line: string): void { this.deps.log?.(line); }

  private stateFor(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (s === undefined) {
      s = { hadWorker: false, chain: Promise.resolve(), targets: new Map(), images: new Map(), lastTargetShot: new Map() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // ── one call ───────────────────────────────────────────────────────────────────────────────────

  async run(call: ScriptCall, input: ScriptInput): Promise<ScriptResult> {
    if (this.stopped) return failure("HelperUnavailable", "Winter is shutting down");
    if (typeof input.code !== "string" || input.code.trim().length === 0) return failure("TypeError", "code is empty — pass the script to run");
    const timeoutMs = Math.min(SCRIPT_TIMEOUT_MAX_MS, Math.max(SCRIPT_TIMEOUT_MIN_MS, Math.floor(input.timeoutMs ?? SCRIPT_TIMEOUT_DEFAULT_MS)));
    const state = this.stateFor(call.sessionId);
    if (state.idleTimer !== undefined) { clearTimeout(state.idleTimer); state.idleTimer = undefined; }
    // One run at a time per session: wait for the previous one (or for this call to be cancelled).
    const previous = state.chain;
    let release!: () => void;
    state.chain = new Promise<void>((r) => { release = r; });
    try {
      const go = await waitUnlessAborted(previous, call.signal);
      if (!go) return failure("Cancelled", "the call was cancelled before its script started");
      return await this.runNow(call, input, state, timeoutMs);
    } finally {
      release();
      this.armIdle(call.sessionId);
    }
  }

  private async runNow(call: ScriptCall, input: ScriptInput, state: SessionState, timeoutMs: number): Promise<ScriptResult> {
    const { sessionId } = call;
    const builder = new ResultBuilder();
    if (input.reset === true) {
      this.resetSession(sessionId, state);
      builder.notice("The automation runtime was reset: earlier variables and bindings are gone (apps stay open).");
    } else if (state.worker === undefined || !state.worker.alive) {
      if (state.hadWorker) builder.notice("The automation runtime restarted; earlier variables and bindings are gone.");
      this.forgetBindings(sessionId, state);
    }
    if (state.worker === undefined || !state.worker.alive) {
      try {
        state.worker = await (this.deps.startWorker?.() ?? AutomationWorker.start({ ...this.deps.worker, log: (l) => this.log(l) }));
        state.hadWorker = true;
      } catch (err) {
        const message = err instanceof AutomationWorkerUnavailable ? err.message : `the automation runtime could not start (${err instanceof Error ? err.message : "error"})`;
        return builder.build({ error: { name: "HelperUnavailable", message } });
      }
    }
    const worker = state.worker;
    const runId = `run_${randomBytes(6).toString("hex")}`;
    const started = this.now();
    // The timer and the grants reference each other (a card pauses the timer): built in two steps.
    const ctxRef: { ctx?: RunCtx } = {};
    const timer = new PausableTimer(timeoutMs, () => { if (ctxRef.ctx) { ctxRef.ctx.timedOut = true; this.cancel(ctxRef.ctx, `the script timed out after ${timeoutMs} ms`); } }, () => this.now());
    const grants = newRunGrants(sessionId, (waiting) => (waiting ? timer.pause() : timer.resume()));
    const ctx: RunCtx = {
      sessionId, runId, callId: `cv2_${randomBytes(6).toString("hex")}`, call, state, worker, builder, grants,
      abort: new AbortController(), timer, locks: new Map(), acted: new Set(), chains: new Map(), primitives: new Map(),
      apps: new Set(), timedOut: false, scriptActiveTold: false,
    };
    ctxRef.ctx = ctx;
    state.active = ctx;
    const onAbort = (): void => this.cancel(ctx, "the turn was interrupted");
    if (call.signal?.aborted) onAbort();
    else call.signal?.addEventListener("abort", onAbort, { once: true });

    const outcome = await worker.run(runId, input.code, {
      onCall: (msg) => { void this.answer(ctx, msg); },
      onPrint: (text) => builder.text(text),
      onShow: (image) => {
        const img = state.images.get(image);
        if (img === undefined) { builder.text("[show(): that image is no longer available]"); return; }
        builder.image(img.data, img.mime);
      },
    });

    timer.clear();
    call.signal?.removeEventListener("abort", onAbort);
    if (ctx.killTimer !== undefined) clearTimeout(ctx.killTimer);
    ctx.abort.abort(); // any primitive still in flight belongs to a finished script
    for (const releaseLock of ctx.locks.values()) releaseLock();
    ctx.locks.clear();
    if (ctx.scriptActiveTold) this.deps.helper.tell("script.active", { sessionId, active: false });
    if (state.active === ctx) state.active = undefined;

    let error: { name: string; message: string; line?: number } | undefined;
    let outcomeWord: string;
    if (outcome.kind === "exited") {
      state.worker = undefined;
      this.forgetBindings(sessionId, state);
      error = ctx.cancelled !== undefined
        ? { name: "Cancelled", message: `${ctx.cancelled}; the script did not stop, so the runtime was restarted (its variables and bindings are gone)` }
        : { name: "Error", message: outcome.refused ? "the automation runtime refused to run outside its sandbox" : "the automation runtime stopped unexpectedly; its variables and bindings are gone" };
      outcomeWord = ctx.timedOut ? "timeout" : ctx.cancelled !== undefined ? "cancelled" : "runtime-stopped";
    } else {
      error = outcome.error;
      if (outcome.note === "declarations-not-kept") builder.notice("This script's top-level declarations could not be kept for later calls.");
      outcomeWord = ctx.timedOut ? "timeout" : ctx.cancelled !== undefined ? "cancelled" : error === undefined ? "ok" : `error:${error.name}`;
    }
    this.deps.audit?.({
      kind: "automation", sessionId, apps: [...ctx.apps], primitives: Object.fromEntries(ctx.primitives),
      durationMs: this.now() - started, outcome: outcomeWord,
    });
    return builder.build(error === undefined ? {} : { error });
  }

  /** Interrupt or timeout: stop the in-flight primitive and every later one; kill a script that will not stop. */
  private cancel(ctx: RunCtx, reason: string): void {
    if (ctx.cancelled !== undefined) return;
    ctx.cancelled = reason;
    ctx.worker.cancel(ctx.runId, reason);
    ctx.abort.abort();
    ctx.killTimer = setTimeout(() => { ctx.worker.kill(); }, CANCEL_KILL_MS);
  }

  private async answer(ctx: RunCtx, msg: CallMessage): Promise<void> {
    const metric: PrimitiveMetric = { ts: this.now(), sessionId: ctx.sessionId, callId: ctx.callId, primitive: msg.primitive, ms: 0, helperMs: 0 };
    const t0 = this.now();
    try {
      const value = await this.dispatch(ctx, msg, metric);
      ctx.worker.reply(msg.id, { ok: true, ...(value === undefined ? {} : { value }) });
    } catch (err) {
      const wire = this.toWire(ctx, err, msg);
      metric.error = wire.kind;
      ctx.worker.reply(msg.id, { ok: false, error: wire });
    } finally {
      metric.ms = this.now() - t0;
      this.deps.telemetry?.primitive(metric);
    }
  }

  // ── primitives ─────────────────────────────────────────────────────────────────────────────────

  private async dispatch(ctx: RunCtx, msg: CallMessage, metric: PrimitiveMetric): Promise<unknown> {
    if (ctx.cancelled !== undefined) throw new AutomationFailure("Cancelled", ctx.cancelled);
    const args = (msg.args ?? {}) as Record<string, unknown>;
    ctx.primitives.set(msg.primitive, (ctx.primitives.get(msg.primitive) ?? 0) + 1);
    switch (msg.primitive) {
      case "apps.list": return await this.appsList(ctx, args, metric);
      case "apps.open": {
        const app = str(args.app)?.trim();
        if (!app) throw bad("apps.open() takes an app name or bundle id");
        const window = typeof args.window === "string" || typeof args.window === "number" ? args.window : undefined;
        return await this.bind(ctx, { app, ...(window === undefined ? {} : { window }) }, metric);
      }
      case "screen.screenshot": return await this.screenScreenshot(ctx, args, metric);
      case "screen.windows": return await this.screenWindows(ctx, args, metric);
      case "screen.appAt": return await this.screenAppAt(ctx, args, metric);
      default: break;
    }
    const targetId = msg.target ?? "";
    // Primitives on one target run in call order; on different targets they may run at once (spec §14).
    const prev = ctx.chains.get(targetId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.targetPrimitive(ctx, targetId, msg.primitive, args, metric));
    ctx.chains.set(targetId, run);
    return await run;
  }

  private async targetPrimitive(ctx: RunCtx, targetId: string, primitive: string, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<unknown> {
    if (ctx.cancelled !== undefined) throw new AutomationFailure("Cancelled", ctx.cancelled);
    const t = this.target(ctx, targetId);
    const app: AppRef = { bundleId: t.bundleId, name: t.name };
    if (ACT_PRIMITIVES.has(primitive)) {
      await this.deps.policy.authorize(ctx.grants, app, { kind: "act", primitive }, ctx.abort.signal);
    } else {
      await this.deps.policy.authorize(ctx.grants, app, { kind: "observe" }, ctx.abort.signal);
    }
    await this.ensureLock(ctx, t);
    switch (primitive) {
      case "state": return await this.state(ctx, t, args, metric);
      case "find": return await this.find(ctx, t, args, metric);
      case "screenshot": return await this.targetScreenshot(ctx, t, args, metric);
      case "windows": {
        const res = await this.helperCall<TargetWindowsResult>(ctx, "target.windows", { targetId }, metric);
        ctx.builder.markScreenRead();
        return res.windows;
      }
      case "useWindow": {
        const w = args.window;
        if (typeof w !== "string" && typeof w !== "number") throw bad("useWindow() takes a window title or id");
        await this.helperCall(ctx, "target.useWindow", { targetId, window: w }, metric);
        this.diffBases.clearTarget(ctx.sessionId, targetId); // a different window: the next state() is full
        return undefined;
      }
      case "waitFor": return await this.waitFor(ctx, t, args, metric);
      case "waitForIdle": {
        const quietMs = typeof args.quietMs === "number" ? Math.max(30, Math.floor(args.quietMs)) : 150;
        const timeout = this.clampWait(ctx, typeof args.timeoutMs === "number" ? args.timeoutMs : 3_000);
        const res = await this.helperCall<WaitIdleResult>(ctx, "target.waitIdle", { targetId, quietMs, timeoutMs: timeout }, metric, timeout + 5_000);
        metric.settleMs = res.waitedMs;
        metric.settleExit = res.settled ? "quiet" : "cap";
        return { settled: res.settled, waitedMs: res.waitedMs };
      }
      default:
        if (ACT_PRIMITIVES.has(primitive)) return await this.act(ctx, t, primitive, this.actionFor(ctx, t, primitive, args), metric);
        throw bad(`unknown primitive ${primitive}`);
    }
  }

  private target(ctx: RunCtx, targetId: string): TargetInfo {
    const t = ctx.state.targets.get(targetId);
    if (t === undefined) throw new AutomationFailure("TargetLost", "that app is no longer bound (the runtime or Winter Computer Use restarted) — bind it again with apps.open()");
    if (t.lost !== undefined) throw new AutomationFailure("TargetLost", `${t.name} is gone (${lostWords(t.lost)}) — bind it again with apps.open()`);
    return t;
  }

  /** The per-target lock, taken on a script's first primitive for the target and held until the script ends. */
  private async ensureLock(ctx: RunCtx, t: TargetInfo): Promise<void> {
    const key = `${t.bundleId}:${t.pid}`;
    if (ctx.locks.has(key)) return;
    const waitMs = Math.min(LOCK_WAIT_MS, Math.max(500, ctx.timer.left() - 500));
    const release = await this.locks.acquire(key, { runId: ctx.runId, sessionId: ctx.sessionId }, { waitMs, signal: ctx.abort.signal, label: t.name });
    if (ctx.locks.has(key)) { release(); return; }
    ctx.locks.set(key, release);
  }

  private clampWait(ctx: RunCtx, requested: number): number {
    const left = Math.max(0, ctx.timer.left() - 200);
    return Math.max(0, Math.min(Math.floor(requested), left));
  }

  private async helperCall<T>(ctx: RunCtx, method: string, params: Record<string, unknown>, metric: PrimitiveMetric, timeoutMs?: number): Promise<T> {
    const t0 = this.now();
    try {
      const res = await this.deps.helper.request<T>(method, params, { signal: ctx.abort.signal, callId: ctx.callId, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      // The helper arms its Esc tap while any session has a script running (spine §2.1 `script.active`).
      if (!ctx.scriptActiveTold) {
        ctx.scriptActiveTold = true;
        this.deps.helper.tell("script.active", { sessionId: ctx.sessionId, active: true });
      }
      return res;
    } finally {
      metric.helperMs += this.now() - t0;
    }
  }

  private async resolveApp(ctx: RunCtx, app: string, metric: PrimitiveMetric): Promise<AppRef | undefined> {
    if (ctx.appCache === undefined) {
      const res = await this.helperCall<AppsListResult>(ctx, "apps.list", {}, metric);
      ctx.appCache = res.apps;
    }
    const want = app.toLowerCase().replace(/\.app$/, "");
    const hit = ctx.appCache.find((a) => a.bundleId.toLowerCase() === want) ?? ctx.appCache.find((a) => a.name.toLowerCase() === want);
    return hit === undefined ? undefined : { bundleId: hit.bundleId, name: hit.name };
  }

  private async appsList(ctx: RunCtx, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<unknown> {
    const res = await this.helperCall<AppsListResult>(ctx, "apps.list", {}, metric);
    ctx.appCache = res.apps;
    const apps = res.apps.filter((a) => !WINTER_OWN_BUNDLE_IDS.includes(a.bundleId)).map((a) => ({ name: a.name, bundleId: a.bundleId, running: a.running }));
    ctx.builder.markScreenRead();
    if (args.emit !== false) ctx.builder.text(apps.length === 0 ? "(no apps)" : apps.map((a) => `${a.name} (${a.bundleId})${a.running ? " — running" : ""}`).join("\n"), { screen: true });
    return apps;
  }

  /** `apps.open` / `screen.appAt`: policy BEFORE the helper launches anything, bind, lock, print the full state. */
  private async bind(ctx: RunCtx, req: { app: string; window?: string | number; known?: AppRef }, metric: PrimitiveMetric): Promise<AppHandle> {
    const known = req.known ?? await this.resolveApp(ctx, req.app, metric);
    if (known !== undefined) await this.deps.policy.authorize(ctx.grants, known, { kind: "bind" }, ctx.abort.signal);
    const settings = this.deps.settings();
    const res = await this.helperCall<TargetBindResult>(ctx, "target.bind", {
      sessionId: ctx.sessionId, app: known?.bundleId ?? req.app, ...(req.window === undefined ? {} : { window: req.window }), mirror: computerUseMirrorFrom(settings),
    }, metric);
    const app: AppRef = { bundleId: res.app.bundleId, name: res.app.name };
    const info: TargetInfo = { targetId: res.targetId, bundleId: app.bundleId, name: app.name, pid: res.app.pid };
    try {
      // The helper resolved a name or a path we could not: the policy sees the real bundle id now.
      if (known === undefined || known.bundleId !== app.bundleId) await this.deps.policy.authorize(ctx.grants, app, { kind: "bind" }, ctx.abort.signal);
      ctx.state.targets.set(info.targetId, info);
      await this.ensureLock(ctx, info);
    } catch (err) {
      ctx.state.targets.delete(info.targetId);
      this.deps.helper.tell("target.release", { targetId: info.targetId });
      throw err;
    }
    ctx.apps.add(app.name);
    this.deps.recentApps?.note(app.bundleId, app.name);
    const snap = await this.helperCall<SnapshotResult>(ctx, "target.snapshot", { targetId: info.targetId, full: true, settle: { maxMs: SETTLE_CAP_MS } }, metric);
    metric.settleMs = snap.waitedMs;
    metric.settleExit = snap.settled ? "quiet" : "cap";
    ctx.builder.text(snap.text, { screen: true });
    this.diffBases.set(ctx.sessionId, info.targetId, snap.snapshotId);
    return { targetId: info.targetId, name: app.name, bundleId: app.bundleId };
  }

  private async state(ctx: RunCtx, t: TargetInfo, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<string> {
    const full = args.full === true;
    const within = isRef(args.within) ? args.within : undefined;
    const since = full || within !== undefined ? undefined : this.diffBases.get(ctx.sessionId, t.targetId);
    const settle = args.settle !== false && ctx.acted.has(t.targetId) ? { maxMs: SETTLE_CAP_MS } : undefined;
    const snap = await this.helperCall<SnapshotResult>(ctx, "target.snapshot", {
      targetId: t.targetId, ...(since === undefined ? {} : { since }), ...(full ? { full: true } : {}),
      ...(within === undefined ? {} : { within }), ...(settle === undefined ? {} : { settle }),
    }, metric);
    if (settle !== undefined) { metric.settleMs = snap.waitedMs; metric.settleExit = snap.settled ? "quiet" : "cap"; }
    ctx.builder.markScreenRead();
    if (args.emit !== false) {
      ctx.builder.text(snap.text, { screen: true });
      // Only a printed WHOLE-target state becomes the base: a subtree (`within`) is not what a diff compares to.
      if (within === undefined) this.diffBases.set(ctx.sessionId, t.targetId, snap.snapshotId);
    }
    return snap.text;
  }

  private async find(ctx: RunCtx, t: TargetInfo, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<unknown> {
    const q = args.query;
    let query: string | Record<string, string>;
    if (typeof q === "string" && q.length > 0) query = q;
    else if (q !== null && typeof q === "object" && !Array.isArray(q)) {
      const o = q as Record<string, unknown>;
      query = Object.fromEntries(["role", "name", "text"].filter((k) => typeof o[k] === "string").map((k) => [k, o[k] as string]));
      if (Object.keys(query).length === 0) throw bad("find() takes text, or { role, name, text }");
    } else throw bad("find() takes text, or { role, name, text }");
    const res = await this.helperCall<FindResult>(ctx, "target.find", { targetId: t.targetId, query }, metric);
    ctx.builder.markScreenRead();
    if (args.emit !== false) {
      ctx.builder.text(res.elements.length === 0 ? `(nothing in ${t.name} matches)` : res.elements.map(elementLine).join("\n"), { screen: true });
    }
    return res.elements;
  }

  private requireVision(ctx: RunCtx): void {
    if (!ctx.call.vision) throw new AutomationFailure("NotAllowed", NO_VISION);
  }

  /** One screenshot, at the budget for this session's model, re-taken at a lower quality while over 3 MiB. */
  private async shoot(ctx: RunCtx, method: string, params: Record<string, unknown>, metric: PrimitiveMetric): Promise<ScreenshotResult & { bytes: number }> {
    const maxDim = computerUseScreenshotMaxDimFrom(this.deps.settings());
    let quality: number = SCREENSHOT_QUALITY;
    for (;;) {
      const res = await this.helperCall<ScreenshotResult>(ctx, method, { ...params, budget: screenshotBudgetFor(ctx.call.model, maxDim, quality) }, metric);
      const bytes = Math.floor((res.imageBase64.length * 3) / 4);
      const next = nextScreenshotQuality(quality);
      if (bytes <= SCREENSHOT_BYTE_CAP || next === undefined) { metric.imageBytes = bytes; return { ...res, bytes }; }
      quality = next;
    }
  }

  private keepImage(ctx: RunCtx, res: ScreenshotResult): ImageHandle {
    const id = `img_${randomBytes(6).toString("hex")}`;
    const images = ctx.state.images;
    images.set(id, { data: res.imageBase64, mime: res.mime ?? "image/jpeg", width: res.width, height: res.height });
    while (images.size > IMAGES_KEPT) images.delete(images.keys().next().value!);
    return { image: id, width: res.width, height: res.height };
  }

  private async targetScreenshot(ctx: RunCtx, t: TargetInfo, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<ImageHandle> {
    this.requireVision(ctx);
    const region = Array.isArray(args.region) && args.region.length === 4 && args.region.every((n) => typeof n === "number") ? args.region : undefined;
    const settle = args.settle !== false && ctx.acted.has(t.targetId) ? { maxMs: SETTLE_CAP_MS } : undefined;
    const res = await this.shoot(ctx, "target.screenshot", { targetId: t.targetId, ...(region === undefined ? {} : { region }), ...(settle === undefined ? {} : { settle }) }, metric);
    ctx.state.lastTargetShot.set(t.targetId, res.shotId);
    const handle = this.keepImage(ctx, res);
    if (args.emit !== false) ctx.builder.image(res.imageBase64, res.mime ?? "image/jpeg");
    else ctx.builder.markScreenRead();
    return handle;
  }

  private async waitFor(ctx: RunCtx, t: TargetInfo, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<unknown> {
    const c = args.cond;
    if (c === null || typeof c !== "object" || Array.isArray(c)) throw bad("waitFor() takes { text, ref, gone, title }");
    const o = c as Record<string, unknown>;
    const cond: Record<string, unknown> = {};
    if (typeof o.text === "string") cond.text = o.text;
    if (isRef(o.ref)) cond.ref = o.ref;
    if (isRef(o.gone) || typeof o.gone === "string") cond.gone = o.gone;
    if (typeof o.title === "string") cond.title = o.title;
    if (Object.keys(cond).length === 0) throw bad("waitFor() needs one of text, ref, gone or title");
    const timeout = this.clampWait(ctx, typeof args.timeoutMs === "number" ? args.timeoutMs : WAIT_FOR_DEFAULT_MS);
    const res = await this.helperCall<WaitForResult>(ctx, "target.waitFor", { targetId: t.targetId, cond, timeoutMs: timeout }, metric, timeout + 5_000);
    return { waitedMs: res.waitedMs };
  }

  /** The helper's `action` for one act primitive, from the script's arguments (validated here). */
  private actionFor(ctx: RunCtx, t: TargetInfo, primitive: string, a: Record<string, unknown>): ActAction {
    const pointTarget = (v: unknown, what: string): { ref?: number; point?: [number, number] } => {
      if (isRef(v)) return { ref: v };
      if (isPoint(v)) {
        this.requireVision(ctx);
        return { point: [v[0], v[1]] };
      }
      throw bad(`${what} takes an element ref${ctx.call.vision ? " or a [x, y] point" : ""}`);
    };
    const shotFor = (uses: boolean): { shotId?: string } => {
      if (!uses) return {};
      const shotId = ctx.state.lastTargetShot.get(t.targetId);
      if (shotId === undefined) throw new AutomationFailure("NotAllowed", `a point is pixels in ${t.name}'s latest screenshot — take app.screenshot() first, or use an element ref`);
      return { shotId };
    };
    const into = isRef(a.into) ? { into: a.into } : {};
    switch (primitive) {
      case "click": {
        const target = pointTarget(a.target, "click()");
        const button = a.button === "right" || a.button === "middle" || a.button === "left" ? { button: a.button as "left" | "right" | "middle" } : {};
        const count = a.count === 1 || a.count === 2 || a.count === 3 ? { count: a.count as 1 | 2 | 3 } : {};
        const modifiers = Array.isArray(a.modifiers) && a.modifiers.every((m) => typeof m === "string") ? { modifiers: a.modifiers as string[] } : {};
        return { kind: "click", ...target, ...shotFor(target.point !== undefined), ...button, ...count, ...modifiers };
      }
      case "setValue":
        if (!isRef(a.ref) || typeof a.value !== "string") throw bad("setValue() takes an element ref and a string");
        return { kind: "setValue", ref: a.ref, value: a.value };
      case "type":
        if (typeof a.text !== "string") throw bad("type() takes a string");
        return { kind: "type", text: a.text, ...into };
      case "paste": {
        if (typeof a.text !== "string") throw bad("paste() takes a string");
        const format = a.format === "text" || a.format === "html" || a.format === "markdown" ? { format: a.format as "text" | "html" | "markdown" } : {};
        return { kind: "paste", text: a.text, ...into, ...format };
      }
      case "key": {
        if (typeof a.combo !== "string" || a.combo.length === 0) throw bad("key() takes a combo such as \"cmd+s\"");
        const repeat = typeof a.repeat === "number" && Number.isInteger(a.repeat) && a.repeat > 0 ? { repeat: Math.min(a.repeat, 100) } : {};
        return { kind: "key", combo: a.combo, ...into, ...repeat };
      }
      case "scroll": {
        const target = pointTarget(a.target, "scroll()");
        if (a.direction !== "up" && a.direction !== "down" && a.direction !== "left" && a.direction !== "right") throw bad("scroll() takes a direction: up, down, left or right");
        const pages = typeof a.pages === "number" && a.pages > 0 ? { pages: a.pages } : {};
        return { kind: "scroll", ...target, ...shotFor(target.point !== undefined), direction: a.direction, ...pages };
      }
      case "drag": {
        const from = pointTarget(a.from, "drag()");
        const to = pointTarget(a.to, "drag()");
        return { kind: "drag", from, to, ...shotFor(from.point !== undefined || to.point !== undefined) };
      }
      case "select": {
        if (!isRef(a.ref) || typeof a.text !== "string") throw bad("select() takes an element ref and the text to select");
        const caret = a.caret === "start" || a.caret === "end" ? { caret: a.caret as "start" | "end" } : {};
        return { kind: "select", ref: a.ref, text: a.text, ...(typeof a.before === "string" ? { before: a.before } : {}), ...(typeof a.after === "string" ? { after: a.after } : {}), ...caret };
      }
      case "action":
        if (!isRef(a.ref) || typeof a.name !== "string" || a.name.length === 0) throw bad("action() takes an element ref and an action name");
        return { kind: "action", ref: a.ref, name: a.name };
      case "menu":
        if (!Array.isArray(a.path) || a.path.length === 0 || !a.path.every((p) => typeof p === "string")) throw bad("menu() takes a path such as [\"File\", \"Export…\"]");
        return { kind: "menu", path: a.path as string[] };
      default:
        throw bad(`unknown action ${primitive}`);
    }
  }

  /** One action, through the input ladder; rung 4 (the foreground) only after the user agreed. */
  private async act(ctx: RunCtx, t: TargetInfo, primitive: string, action: ActAction, metric: PrimitiveMetric): Promise<undefined> {
    const settings = this.deps.settings();
    const params = {
      targetId: t.targetId, sessionId: ctx.sessionId, callId: ctx.callId, action,
      access: this.deps.policy.accessFor(t.bundleId) === "click" ? "click" : "full",
      privatePath: computerUsePrivateEventPathFrom(settings),
    };
    let res: ActResult;
    try {
      res = await this.helperCall<ActResult>(ctx, "target.act", { ...params, allowForeground: false }, metric);
    } catch (err) {
      if (!(err instanceof HelperRpcError) || err.code !== "needs_foreground") throw err;
      const app: AppRef = { bundleId: t.bundleId, name: t.name };
      if (!(await this.deps.policy.allowForeground(ctx.grants, app, ctx.abort.signal))) {
        throw new AutomationFailure("NeedsForeground", `${t.name} only accepts this ${primitive} in the foreground, and Winter may not take the pointer now — try an element ref or another action, or ask the user`);
      }
      const release = await this.locks.acquire(FOREGROUND_LOCK_KEY, { runId: ctx.runId, sessionId: ctx.sessionId }, {
        waitMs: Math.min(LOCK_WAIT_MS, Math.max(500, ctx.timer.left() - 500)), signal: ctx.abort.signal, label: "The screen's foreground",
      });
      try {
        res = await this.helperCall<ActResult>(ctx, "target.act", { ...params, allowForeground: true }, metric);
      } finally { release(); }
    }
    ctx.acted.add(t.targetId);
    metric.rung = res.rung;
    return undefined;
  }

  private async screenScreenshot(ctx: RunCtx, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<ImageHandle> {
    this.requireVision(ctx);
    const display = args.display === "all" || (typeof args.display === "number" && Number.isInteger(args.display)) ? { display: args.display } : {};
    // Whole-screen shots and rung-4 input take turns on the one foreground (spec §14).
    const release = await this.locks.acquire(FOREGROUND_LOCK_KEY, { runId: ctx.runId, sessionId: ctx.sessionId }, {
      waitMs: Math.min(LOCK_WAIT_MS, Math.max(500, ctx.timer.left() - 500)), signal: ctx.abort.signal, label: "The screen",
    });
    let res: ScreenshotResult & { bytes: number };
    try {
      res = await this.shoot(ctx, "screen.screenshot", { ...display, excludeBundleIds: this.deps.policy.excludedFromScreen() }, metric);
    } finally { release(); }
    ctx.state.lastScreenShot = res.shotId;
    const handle = this.keepImage(ctx, res);
    if (args.emit !== false) ctx.builder.image(res.imageBase64, res.mime ?? "image/jpeg");
    else ctx.builder.markScreenRead();
    return handle;
  }

  private async screenWindows(ctx: RunCtx, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<unknown> {
    const res = await this.helperCall<ScreenWindowsResult>(ctx, "screen.windows", {}, metric);
    const excluded = new Set(this.deps.policy.excludedFromScreen());
    const windows = res.windows.filter((w) => !excluded.has(w.bundleId)).map((w) => ({ app: w.app, title: w.title, frame: w.frame }));
    ctx.builder.markScreenRead();
    if (args.emit !== false) {
      ctx.builder.text(windows.length === 0 ? "(no windows)" : windows.map((w) => `${w.app} — "${w.title}" [${w.frame.join(", ")}]`).join("\n"), { screen: true });
    }
    return windows;
  }

  private async screenAppAt(ctx: RunCtx, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<AppHandle> {
    this.requireVision(ctx);
    if (typeof args.x !== "number" || typeof args.y !== "number") throw bad("screen.appAt() takes x and y");
    const shotId = ctx.state.lastScreenShot;
    if (shotId === undefined) throw new AutomationFailure("NotAllowed", "screen.appAt() reads a point of the latest screen.screenshot() — take one first");
    const at = await this.helperCall<AppAtResult>(ctx, "screen.appAt", { shotId, point: [args.x, args.y] }, metric);
    return await this.bind(ctx, { app: at.bundleId, window: at.windowId, known: { bundleId: at.bundleId, name: at.app } }, metric);
  }

  // ── errors ─────────────────────────────────────────────────────────────────────────────────────

  /** Any failure → the `{kind, message}` the worker throws as its class, with one actionable sentence. */
  private toWire(ctx: RunCtx, err: unknown, msg: CallMessage): { kind: string; message: string } {
    if (isAutomationFailure(err)) return { kind: err.kind, message: err.message };
    if (err instanceof TypeError) return { kind: "TypeError", message: err.message };
    if (err instanceof HelperUnavailableError) {
      return { kind: "HelperUnavailable", message: `${err.message}${err.retryable ? " — try again; if it keeps failing, ask the user to check Settings → Computer Use" : ""}` };
    }
    if (err instanceof HelperRpcError) {
      const t = msg.target === undefined ? undefined : ctx.state.targets.get(msg.target);
      const name = t?.name ?? "the app";
      const data = err.data;
      switch (err.code) {
        case "stale_ref": return { kind: "StaleRef", message: `${typeof data.ref === "number" ? `[${data.ref}]` : "that element"} is gone — call state()` };
        case "target_lost":
          if (t !== undefined) { t.lost = typeof data.reason === "string" ? data.reason : "app_quit"; this.diffBases.clearTarget(ctx.sessionId, t.targetId); }
          return { kind: "TargetLost", message: `${name} is gone (the app quit or its window closed) — bind it again with apps.open()` };
        case "needs_foreground": return { kind: "NeedsForeground", message: `${name} needs the foreground for that — try an element ref, or ask the user` };
        case "not_allowed": return { kind: "NotAllowed", message: typeof data.reason === "string" ? `not allowed: ${data.reason}` : `not allowed in ${name}` };
        case "refused": return { kind: "Refused", message: refusedWords(typeof data.reason === "string" ? data.reason : "", name) };
        case "wait_timeout": {
          ctx.builder.markScreenRead();
          const seen = typeof data.seen === "string" && data.seen.length > 0 ? ` — seen: ${data.seen.slice(0, 2_000)}` : "";
          return { kind: "WaitTimeout", message: `the wait timed out without the condition being met${seen}` };
        }
        case "cancelled": return { kind: "Cancelled", message: ctx.cancelled ?? "the call was cancelled" };
        case "permission_missing": {
          const which = data.permission === "screenRecording" ? "Screen Recording" : "Accessibility";
          return { kind: "PermissionMissing", message: `Winter Computer Use needs the ${which} permission — ask the user to grant it in Settings → Computer Use` };
        }
        case "busy": return { kind: "HelperUnavailable", message: "Winter Computer Use is busy — try again in a moment" };
        case "invalid_params": return { kind: "TypeError", message: err.message };
        default: return { kind: "Error", message: `${err.code}: ${err.message}` };
      }
    }
    return { kind: "Error", message: err instanceof Error ? err.message : String(err) };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────────

  /** Forget the session's bindings and diff bases (a reset, a worker restart): the old handles are gone. */
  private forgetBindings(sessionId: string, state: SessionState): void {
    for (const t of state.targets.values()) this.deps.helper.tell("target.release", { targetId: t.targetId });
    state.targets.clear();
    state.images.clear();
    state.lastTargetShot.clear();
    state.lastScreenShot = undefined;
    this.diffBases.clearSession(sessionId);
  }

  private resetSession(sessionId: string, state: SessionState): void {
    state.worker?.kill();
    state.worker = undefined;
    this.forgetBindings(sessionId, state);
  }

  private armIdle(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined || this.stopped) return;
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => this.endSession(sessionId), this.deps.idleMs ?? WORKER_IDLE_MS);
    (state.idleTimer as { unref?: () => void }).unref?.();
  }

  /** The session's driver ended, the session is gone, or its worker idled out: end its runtime. */
  endSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    if (state.active !== undefined) this.cancel(state.active, "the session ended");
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.worker?.kill();
    this.diffBases.clearSession(sessionId);
    this.deps.policy.clearSession(sessionId);
    this.deps.helper.tell("session.ended", { sessionId });
    this.sessions.delete(sessionId);
  }

  /** A main-thread turn ended: the helper fades that session's mirrors. */
  turnEnded(sessionId: string): void {
    if (this.sessions.has(sessionId)) this.deps.helper.tell("turn.ended", { sessionId });
  }

  /** The helper's notifications (spine §2.2). */
  handleNotification(n: HelperNotification): void {
    switch (n.method) {
      case "escPressed":
        for (const sessionId of n.params?.sessionIds ?? []) {
          const active = this.sessions.get(sessionId)?.active;
          if (active !== undefined) this.cancel(active, "the user pressed Esc");
          try { this.deps.interrupt?.(sessionId); } catch { /* best effort */ }
        }
        return;
      case "targetLost":
        for (const [sessionId, state] of this.sessions) {
          const t = state.targets.get(n.params?.targetId);
          if (t === undefined) continue;
          t.lost = n.params.reason;
          this.diffBases.clearTarget(sessionId, t.targetId);
        }
        return;
      case "permissionsChanged":
        return; // the client keeps the latest; `computerUse.status` reads it
    }
  }

  /** The helper connection closed: every target it held is gone (`TargetLost` on next use). */
  helperDisconnected(): void {
    for (const [sessionId, state] of this.sessions) {
      for (const t of state.targets.values()) t.lost = "helper_restart";
      this.diffBases.clearSession(sessionId);
    }
  }

  /** Daemon stop: no worker outlives it. */
  stop(): void {
    this.stopped = true;
    for (const sessionId of [...this.sessions.keys()]) this.endSession(sessionId);
  }

  /** Tests and diagnostics: the session's live worker pid. */
  workerPid(sessionId: string): number | undefined { return this.sessions.get(sessionId)?.worker?.pid; }
}

function failure(name: string, message: string): ScriptResult {
  return new ResultBuilder().build({ error: { name, message } });
}

async function waitUnlessAborted(p: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal === undefined) { await p; return true; }
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    void p.then(() => { signal.removeEventListener("abort", onAbort); resolve(true); });
  });
}

function elementLine(e: { ref: number; role: string; name?: string; value?: string }): string {
  return `[${e.ref}] ${e.role}${e.name === undefined ? "" : ` "${e.name}"`}${e.value === undefined ? "" : ` value="${e.value.slice(0, 200)}"`}`;
}

function lostWords(reason: string): string {
  return reason === "window_closed" ? "its window closed" : reason === "helper_restart" ? "Winter Computer Use restarted" : "the app quit";
}

function refusedWords(reason: string, name: string): string {
  switch (reason) {
    case "secure_field": return "that is a password or payment field — Winter never reads or types into one; ask the user to fill it in";
    case "auth_dialog": return "that is a system authentication dialog — ask the user to handle it";
    case "privacy_pane": return "System Settings' Privacy & Security panes are off limits — ask the user to change them";
    case "winter_itself": return "Winter never controls itself";
    case "save_path": return "that save location is protected (shell startup files, ~/.ssh, LaunchAgents) — choose another";
    default: return `${name} refused that action${reason ? ` (${reason})` : ""}`;
  }
}
