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
import { AUTOMATION_ERROR_KINDS, AutomationFailure, isAutomationFailure } from "./errors";
import { isAppPath, isBundleIdShaped, isDocumentTarget, systemAppResolver, type AppResolver } from "./app-resolve";
import type { HelperClient } from "./helper-client";
import { FOREGROUND_LOCK_KEY, LOCK_WAIT_MS, TargetLocks } from "./locks";
import { ACT_PRIMITIVES, cardReason, desktopVisitActReason, newRunGrants, type AppRef, type ComputerPolicy, type DesktopVisitOutcome, type RunGrants } from "./policy";
import { typingEstimateMs, typingFit } from "./typing-estimate";
import {
  HelperRpcError, HelperUnavailableError, WINTER_OWN_BUNDLE_IDS,
  type ActAction, type ActResult, type AppAtResult, type AppleScriptResult, type AppsListResult, type DesktopVisitReport, type FindResult, type HelperNotification,
  type ScreenWindowsResult, type ScreenshotResult, type ScriptingDictionaryResult, type SnapshotResult, type TargetBindResult, type TargetUseWindowResult, type TargetWindowsResult,
  type WaitForResult, type WaitIdleResult,
} from "./protocol";
import type { RecentApps } from "./recent-apps";
import { ResultBuilder, type ResultContent, type ScriptError } from "./result";
import type { AutomationTelemetry, PrimitiveMetric } from "./telemetry";
import { AutomationWorker, AutomationWorkerUnavailable, type AutomationWorkerOptions, type CallMessage } from "./worker-host";
import { APP_PRIMITIVES, GLOBAL_PRIMITIVES, type AppHandle, type ImageHandle } from "./worker/bridge";

export const SCRIPT_TIMEOUT_DEFAULT_MS = 30_000;
export const SCRIPT_TIMEOUT_MIN_MS = 1_000;
export const SCRIPT_TIMEOUT_MAX_MS = 300_000;
/** The text primitives whose cancellation reports how far they got. */
const TEXT_PRIMITIVES = new Set(["type", "paste"]);
/** How long a cancelled run waits for a type/paste's answer (the helper-client's 1 s cancel grace, and a margin). */
const TEXT_ANSWER_AFTER_CANCEL_MS = 1_500;
/** A cancelled script that has not settled after this long loses its worker. */
export const CANCEL_KILL_MS = 1_000;
/** A session's worker ends after this long without a call (spec §4). */
export const WORKER_IDLE_MS = 30 * 60_000;
/** `state()`/`screenshot()` settle for at most this long after an action in the same call (spec §7). */
export const SETTLE_CAP_MS = 1_500;
export const WAIT_FOR_DEFAULT_MS = 10_000;
const IMAGES_KEPT = 16;
/** A `busy` helper answer is retried once after this long. */
export const BUSY_RETRY_MS = 200;

export interface ScriptInput { code: string; timeoutMs?: number; reset?: boolean; title?: string }
/** The longest `reason` a live screenshot may give (it is shown to the user on the desktop-switch prompt). */
export const LIVE_REASON_MAX = 200;
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
  /** Resolves a path or an unlisted bundle id to a bundle id WITHOUT launching (`app-resolve.ts`). */
  appResolver?: AppResolver;
  idleMs?: number;
  now?(): number;
  log?(line: string): void;
  /**
   * TEST SEAM (`ComputerUseInjection.screenshotSink`): every screenshot the helper returned, as encoded — wired
   * only by the live suite's own daemon (`scripts/cu-live/daemon-entry.ts`), so it can judge the capture's pixels.
   * The production daemon never sets it; the bytes otherwise never leave the daemon.
   */
  screenshotSink?(shot: { sessionId: string; primitive: string; mime: string; base64: string }): void;
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
  /** Runs queued or running in this session — the idle timer is armed only at zero, so it never fires mid-run. */
  pending: number;
  /** The runtime has read screen content since its last reset or restart: EVERY call's text is fenced until
   *  then — a value read in one call and printed in a later one stays data (the controller's ruling, review I1). */
  tainted: boolean;
}

/** A timer that stops counting while a card waits for a human. */
class PausableTimer {
  private remaining: number;
  private startedAt = 0;
  private handle: ReturnType<typeof setTimeout> | undefined;
  private paused = 0;
  private done = false;
  /** The run's whole allowance: its timeout plus every extension (≤ `SCRIPT_TIMEOUT_MAX_MS`). */
  private _budget: number;
  constructor(ms: number, private readonly fire: () => void, private readonly now: () => number) {
    this.remaining = ms;
    this._budget = ms;
    this.start();
  }
  get budget(): number { return this._budget; }
  /** Moves the deadline `ms` later (a known-long primitive, like a card's wait pauses it). */
  extend(ms: number): void {
    if (this.done || ms <= 0) return;
    this._budget += ms;
    if (this.paused > 0) { this.remaining += ms; return; }
    if (this.handle !== undefined) clearTimeout(this.handle);
    this.remaining = this.left() + ms;
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
  /** The answers of type/paste calls still in flight (see `runNow`). */
  textInFlight: Set<Promise<void>>;
  /** The last focus change per target in this run, said once at its end. */
  focusLines: Map<string, { app: string; line: string }>;
  /** Why the run's deadline was extended (a long type/paste each), for the timeout's words. */
  extensions: Array<{ primitive: "type" | "paste"; chars: number }>;
  /** Targets the user let come to the front for the rest of this run (`requestForeground`): their acts take
   *  the foreground with no second card. */
  foreground: Set<string>;
  /** THE DESKTOP SWITCH (the ruling, 2026-10-10): per app (bundle id + pid), the user's answer to moving them to
   *  its desktop for a moment, for the rest of this run — `true`: every later primitive that needs it may visit with
   *  no second prompt (each visit still returns them at once); `false`: they refused, so no re-prompt either. */
  visits: Map<string, boolean>;
  /** A desktop-switch prompt already on screen per app (concurrent primitives of one script share it). */
  visitPrompts: Map<string, Promise<DesktopVisitOutcome>>;
  /** The last primitive the script called ("type in Safari"), for a timeout's words. */
  lastPrimitive?: string;
  sessionId: string;
  runId: string;
  callId: string;
  call: ScriptCall;
  /** The script's own title (the model's words for the step) — an act's desktop-switch prompt quotes it. */
  title?: string;
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
  /** The helper connection generation `script.active` was told on — a helper relaunched mid-run is told again. */
  scriptActiveGen?: number;
  /** The script has ENDED: set before its locks are drained, and checked after every await of a primitive, so a
   *  primitive still in flight (un-awaited by the script) can never take or keep a lock afterwards (review C1). */
  ended: boolean;
  /** Targets this call bound — released at its end when their app was allowed only "once" (review I3). */
  bound: Set<string>;
  /** The failure sentences the daemon sent this call — a script error carrying one verbatim is the daemon's own
   *  words and is shown outside the DATA-ONLY fence. */
  daemonSentences: Set<string>;
}

const isRef = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
/** A helper visit report (`DesktopVisitReport`) as it arrives in an error's `data` — checked, never assumed. */
const isVisitReport = (v: unknown): v is DesktopVisitReport =>
  v !== null && typeof v === "object" && typeof (v as { ms?: unknown }).ms === "number" && typeof (v as { returned?: unknown }).returned === "boolean";
/** A desktop-switch answer's scope within a run: the app, by bundle id AND pid (a relaunched app asks again). */
const visitKey = (t: { bundleId: string; pid: number }): string => `${t.bundleId}:${t.pid}`;
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
      s = { hadWorker: false, chain: Promise.resolve(), targets: new Map(), images: new Map(), lastTargetShot: new Map(), pending: 0, tainted: false };
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
    state.pending++;
    if (state.idleTimer !== undefined) { clearTimeout(state.idleTimer); state.idleTimer = undefined; }
    // One run at a time per session: wait for the previous one (or for this call to be cancelled). The link the
    // NEXT run waits on settles only when this run is done AND its predecessor is — so a run cancelled while it
    // waited never lets the one behind it overlap the one still running (the review's run-queue minor).
    const previous = state.chain;
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    state.chain = previous.then(() => mine);
    try {
      const go = await waitUnlessAborted(previous, call.signal);
      if (!go) return failure("Cancelled", "the call was cancelled before its script started");
      return await this.runNow(call, input, state, timeoutMs);
    } finally {
      release();
      state.pending--;
      if (state.pending === 0) this.armIdle(call.sessionId);
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
    // The fence is per SESSION: a runtime that read the screen in an earlier call may print what it read now.
    if (state.tainted) builder.markScreenRead();
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
    const timer = new PausableTimer(timeoutMs, () => {
      if (ctxRef.ctx) {
        const c = ctxRef.ctx;
        c.timedOut = true;
        const calls = [...c.primitives.entries()].reduce((n, [k, v]) => (k === "timeLeft" ? n : n + v), 0);
        this.cancel(c, timeoutMessage(timeoutMs, c.timer.budget, c.extensions, { calls, ...(c.lastPrimitive === undefined ? {} : { last: c.lastPrimitive }) }));
      }
    }, () => this.now());
    const grants = newRunGrants(sessionId, (waiting) => (waiting ? timer.pause() : timer.resume()));
    const ctx: RunCtx = {
      sessionId, runId, callId: `cv2_${randomBytes(6).toString("hex")}`, call, state, worker, builder, grants,
      ...(typeof input.title === "string" && input.title.trim().length > 0 ? { title: input.title } : {}),
      abort: new AbortController(), timer, locks: new Map(), acted: new Set(), chains: new Map(), primitives: new Map(),
      apps: new Set(), timedOut: false, ended: false, bound: new Set(), daemonSentences: new Set(), textInFlight: new Set(),
      focusLines: new Map(), extensions: [], foreground: new Set(), visits: new Map(), visitPrompts: new Map(),
    };
    ctxRef.ctx = ctx;
    state.active = ctx;
    // `script.active` brackets every script run (the helper arms its Esc tap while any session is active):
    // told now when the helper is already connected, else at the run's first helper call — a print-only
    // script never launches the helper just to say so.
    if (this.deps.helper.connected) this.tellScriptActive(ctx);
    const onAbort = (): void => this.cancel(ctx, "the turn was interrupted");
    if (call.signal?.aborted) onAbort();
    else call.signal?.addEventListener("abort", onAbort, { once: true });

    const outcome = await worker.run(runId, input.code, {
      onCall: (msg) => {
        const answered = this.answer(ctx, msg);
        // A type/paste in flight when the run is cancelled is waited for (briefly) below: its answer says how many
        // characters had already been typed.
        if (TEXT_PRIMITIVES.has(msg.primitive)) {
          ctx.textInFlight.add(answered);
          void answered.finally(() => ctx.textInFlight.delete(answered));
        }
      },
      onPrint: (text) => builder.text(text),
      onShow: (image) => {
        const img = state.images.get(image);
        if (img === undefined) { builder.text("[show(): that image is no longer available]"); return; }
        builder.image(img.data, img.mime);
      },
    });

    // Cancelled with a type/paste still in flight: the worker gave the script up at once, but the helper's answer
    // (how far the typing got) is worth the wait — the helper stops within a key and answers within the client's
    // grace.
    if (ctx.cancelled !== undefined && ctx.textInFlight.size > 0) {
      let wait: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...ctx.textInFlight]), new Promise<void>((r) => { wait = setTimeout(r, TEXT_ANSWER_AFTER_CANCEL_MS); })]);
      if (wait !== undefined) clearTimeout(wait);
    }
    timer.clear();
    call.signal?.removeEventListener("abort", onAbort);
    // The focus lines (the last change per target), once: "focus: now …", named per app when several moved.
    for (const { app, line } of ctx.focusLines.values()) {
      builder.text(ctx.focusLines.size === 1 ? `focus: ${line}` : `focus in ${app}: ${line}`, { screen: true });
    }
    if (ctx.killTimer !== undefined) clearTimeout(ctx.killTimer);
    // ENDED first, then abort, then drain: a primitive still in flight (one the script never awaited) sees
    // `ended` after its next await and can neither take a lock nor keep one (review C1).
    ctx.ended = true;
    ctx.abort.abort();
    for (const releaseLock of ctx.locks.values()) releaseLock();
    ctx.locks.clear();
    // "Allow once" covers THIS call: a target bound on it is released now (the controller's ruling, review I3).
    for (const targetId of ctx.bound) {
      const t = state.targets.get(targetId);
      if (t === undefined || t.lost !== undefined || this.deps.policy.persistentlyAllowed(sessionId, t.bundleId)) continue;
      t.lost = "once";
      this.diffBases.clearTarget(sessionId, targetId);
      this.deps.helper.tell("target.release", { targetId });
    }
    if (ctx.scriptActiveGen !== undefined) this.deps.helper.tell("script.active", { sessionId, active: false });
    if (state.active === ctx) state.active = undefined;

    // The taint outlives the call (the fence is per session) — unless the runtime is gone below.
    if (builder.readScreen) state.tainted = true;
    let error: ScriptError | undefined;
    let outcomeWord: string;
    if (outcome.kind === "exited") {
      state.worker = undefined;
      this.forgetBindings(sessionId, state);
      error = ctx.cancelled !== undefined
        ? { name: "Cancelled", message: `${ctx.cancelled}; the script did not stop, so the runtime was restarted (its variables and bindings are gone)`, trusted: true }
        : { name: "Error", message: outcome.refused ? "the automation runtime refused to run outside its sandbox" : "the automation runtime stopped unexpectedly; its variables and bindings are gone", trusted: true };
      outcomeWord = ctx.timedOut ? "timeout" : ctx.cancelled !== undefined ? "cancelled" : "runtime-stopped";
    } else {
      // The worker is UNTRUSTED (the model's code shares its process): its error name is normalised to a known
      // kind or `Error` before it reaches the result or the audit line, and its message and line are bounded.
      error = outcome.error === undefined ? undefined : normaliseScriptError(outcome.error, ctx.daemonSentences);
      if (outcome.note === "declarations-not-kept") builder.notice("This script's top-level declarations could not be kept for later calls.");
      outcomeWord = ctx.timedOut ? "timeout" : ctx.cancelled !== undefined ? "cancelled" : error === undefined ? "ok" : `error:${error.name}`;
    }
    this.deps.audit?.({
      kind: "automation", sessionId, apps: [...ctx.apps], primitives: Object.fromEntries(ctx.primitives),
      durationMs: this.now() - started, outcome: outcomeWord,
    });
    return builder.build(error === undefined ? {} : { error });
  }

  /** `script.active` for this run, on the helper connection that is live now (a relaunched helper is told again). */
  private tellScriptActive(ctx: RunCtx): void {
    const gen = this.deps.helper.generation;
    if (ctx.scriptActiveGen === gen) return;
    ctx.scriptActiveGen = gen;
    this.deps.helper.tell("script.active", { sessionId: ctx.sessionId, active: true });
  }

  /** Throw `Cancelled` when the run has ended or been cancelled — after every await of a primitive (review C1). */
  private live(ctx: RunCtx): void {
    if (ctx.ended) throw new AutomationFailure("Cancelled", "the script ended before this call finished");
    if (ctx.cancelled !== undefined) throw new AutomationFailure("Cancelled", ctx.cancelled);
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
    // The worker is UNTRUSTED: a primitive outside the API is refused BEFORE it can reach telemetry or the audit
    // line under a name the script made up (review I6).
    if (typeof msg.id !== "number" || !KNOWN_PRIMITIVES.has(msg.primitive)) {
      if (typeof msg.id === "number") ctx.worker.reply(msg.id, { ok: false, error: { kind: "TypeError", message: "not a ComputerV2 function" } });
      return;
    }
    const metric: PrimitiveMetric = { ts: this.now(), sessionId: ctx.sessionId, callId: ctx.callId, primitive: msg.primitive, ms: 0, helperMs: 0 };
    const t0 = this.now();
    try {
      const value = await this.dispatch(ctx, msg, metric);
      ctx.worker.reply(msg.id, { ok: true, ...(value === undefined ? {} : { value }) });
    } catch (err) {
      // A request that failed DURING or AFTER a desktop visit (helper 1.7.0's `data.visit`): the user was still moved —
      // said and counted like any visit (the ruling: every switch is counted), a failed return loudest of all.
      if (err instanceof HelperRpcError && isVisitReport(err.data.visit)) {
        const t = msg.target === undefined ? undefined : ctx.state.targets.get(msg.target);
        if (t !== undefined) this.noteVisit(ctx, t, err.data.visit, metric);
      }
      const wire = this.toWire(ctx, err, msg);
      metric.error = wire.kind;
      // The helper's own code (`unsupported`, `window_elsewhere`, …): `Error` alone says nothing in the metrics.
      if (err instanceof HelperRpcError) metric.errorCode = err.code;
      if (wire.trusted) ctx.daemonSentences.add(wire.message);
      ctx.worker.reply(msg.id, { ok: false, error: { kind: wire.kind, message: wire.message } });
    } finally {
      metric.ms = this.now() - t0;
      this.deps.telemetry?.primitive(metric);
    }
  }

  // ── primitives ─────────────────────────────────────────────────────────────────────────────────

  private async dispatch(ctx: RunCtx, msg: CallMessage, metric: PrimitiveMetric): Promise<unknown> {
    this.live(ctx);
    const args = (msg.args ?? {}) as Record<string, unknown>;
    ctx.primitives.set(msg.primitive, (ctx.primitives.get(msg.primitive) ?? 0) + 1);
    if (msg.primitive !== "timeLeft") {
      const on = msg.target === undefined ? undefined : ctx.state.targets.get(msg.target)?.name;
      ctx.lastPrimitive = `${msg.primitive}()${on === undefined ? "" : ` in ${on}`}`;
    }
    switch (msg.primitive) {
      case "timeLeft": return Math.max(0, Math.floor(ctx.timer.left()));
      case "apps.list": return await this.appsList(ctx, args, metric);
      case "apps.open": {
        const target = str(args.app)?.trim();
        if (!target) throw bad("apps.open() takes an app name or bundle id, or a file path or URL to open");
        const opener = str((args as Record<string, unknown>).with)?.trim();
        // A file path or URL (or an explicit opener) opens a document; a name or an .app bundle binds the app.
        if (opener !== undefined || isDocumentTarget(target)) {
          return await this.openDocument(ctx, target, opener, metric);
        }
        const window = typeof args.window === "string" || typeof args.window === "number" ? args.window : undefined;
        return await this.bind(ctx, { app: target, ...(window === undefined ? {} : { window }) }, metric);
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
    this.live(ctx);
    const t = this.target(ctx, targetId);
    const app: AppRef = { bundleId: t.bundleId, name: t.name };
    if (ACT_PRIMITIVES.has(primitive) || primitive === "requestForeground") {
      await this.deps.policy.authorize(ctx.grants, app, { kind: "act", primitive }, ctx.abort.signal);
    } else {
      await this.deps.policy.authorize(ctx.grants, app, { kind: "observe" }, ctx.abort.signal);
    }
    this.live(ctx);
    await this.ensureLock(ctx, t);
    switch (primitive) {
      case "state": return await this.state(ctx, t, args, metric);
      case "find": return await this.find(ctx, t, args, metric);
      case "screenshot": return await this.targetScreenshot(ctx, t, args, metric);
      case "requestForeground": return await this.requestForeground(ctx, t, args, metric);
      case "windows": {
        const res = await this.helperCall<TargetWindowsResult>(ctx, "target.windows", { targetId }, metric);
        ctx.builder.markScreenRead();
        return res.windows;
      }
      case "useWindow": {
        const w = args.window;
        if (typeof w !== "string" && typeof w !== "number") throw bad("useWindow() takes a window title or id");
        const res = await this.helperCall<TargetUseWindowResult>(ctx, "target.useWindow", { targetId, window: w }, metric);
        this.diffBases.clearTarget(ctx.sessionId, targetId); // a different window: the next state() is full
        ctx.state.lastTargetShot.delete(targetId);
        const detail = helperDetail(res?.detail);
        if (detail !== undefined) ctx.builder.daemonLine(detail);
        return undefined;
      }
      case "waitFor": return await this.waitFor(ctx, t, args, metric);
      case "applescript": return await this.applescript(ctx, t, args, metric);
      case "scriptingDictionary": {
        const search = args.search;
        if (search !== undefined && typeof search !== "string") throw bad("scriptingDictionary() takes { search?: string }");
        const res = await this.helperCall<ScriptingDictionaryResult>(ctx, "target.scriptingDictionary", { targetId, ...(search === undefined ? {} : { search }) }, metric);
        // The dictionary is the app's own text: data, inside the fence.
        ctx.builder.markScreenRead();
        if (args.emit !== false) ctx.builder.text(res.scriptable ? res.text ?? "" : `${t.name} is not scriptable (it has no scripting dictionary)`, { screen: true });
        return { scriptable: res.scriptable, ...(res.text === undefined ? {} : { text: res.text }), ...(res.truncated === undefined ? {} : { truncated: res.truncated }) };
      }
      case "waitForIdle": {
        const quietMs = typeof args.quietMs === "number" ? Math.max(30, Math.floor(args.quietMs)) : 150;
        const timeout = this.clampWait(ctx, typeof args.timeoutMs === "number" ? args.timeoutMs : 3_000);
        const res = await this.helperCall<WaitIdleResult>(ctx, "target.waitIdle", { targetId, quietMs, timeoutMs: timeout, callId: ctx.callId }, metric, timeout + 5_000);
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
    if (t.lost !== undefined) throw new AutomationFailure("TargetLost", targetLostMessage(t.name, t.lost));
    return t;
  }

  /** The per-target lock, taken on a script's first primitive for the target and held until the script ends. */
  private async ensureLock(ctx: RunCtx, t: TargetInfo): Promise<void> {
    const key = `${t.bundleId}:${t.pid}`;
    if (ctx.locks.has(key)) return;
    this.live(ctx);
    const waitMs = Math.min(LOCK_WAIT_MS, Math.max(500, ctx.timer.left() - 500));
    const release = await this.locks.acquire(key, { runId: ctx.runId, sessionId: ctx.sessionId }, { waitMs, signal: ctx.abort.signal, label: t.name });
    // Won after the script ended (or was cancelled): give it straight back — nobody else would (review C1).
    if (ctx.ended || ctx.cancelled !== undefined) { release(); this.live(ctx); }
    if (ctx.locks.has(key)) { release(); return; }
    ctx.locks.set(key, release);
  }

  private clampWait(ctx: RunCtx, requested: number): number {
    const left = Math.max(0, ctx.timer.left() - 200);
    return Math.max(0, Math.min(Math.floor(requested), left));
  }

  private async helperCall<T>(ctx: RunCtx, method: string, params: Record<string, unknown>, metric: PrimitiveMetric, timeoutMs?: number, opts: { afterEnd?: boolean } = {}): Promise<T> {
    const t0 = this.now();
    const once = (): Promise<T> => this.deps.helper.request<T>(method, params, { signal: ctx.abort.signal, callId: ctx.callId, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    try {
      let res: T;
      try {
        res = await once();
      } catch (err) {
        // `busy` (retryable): the helper's queue was full, or the app did not answer accessibility in time.
        // One retry after ~200 ms; a second `busy` is the typed failure (spine §2.1, after L1b). An UNCERTAIN
        // busy — the action was sent and may have happened — is never retried: that would do it twice.
        if (!(err instanceof HelperRpcError) || err.code !== "busy" || err.data.uncertain === true) throw err;
        if (!(await abortableSleep(BUSY_RETRY_MS, ctx.abort.signal))) throw new AutomationFailure("Cancelled", ctx.cancelled ?? "the call was cancelled");
        try {
          res = await once();
        } catch (again) {
          if (again instanceof HelperRpcError && again.code === "busy" && again.data.uncertain !== true) {
            // The APP is busy (not the helper, which answered): TargetBusy.
            const t = typeof params.targetId === "string" ? ctx.state.targets.get(params.targetId) : undefined;
            throw new AutomationFailure("TargetBusy", `${t?.name ?? "The app"} did not answer in time (it may be busy) — try again in a moment`, true);
          }
          throw again;
        }
      }
      // A late answer belongs to a script that has ended: nothing may build on it (review C1). `bind` takes the
      // answer anyway (`afterEnd`) so it can release what the helper bound.
      if (opts.afterEnd !== true) this.live(ctx);
      // The helper arms its Esc tap while any session has a script running (spine §2.1 `script.active`) — told
      // again when the helper was relaunched mid-run (a new connection generation).
      this.tellScriptActive(ctx);
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

  /**
   * WHICH app the script named, as a bundle id, BEFORE anything is launched (review C2; the controller's ruling):
   * a name or bundle id the helper's `apps.list` names; else a PATH, by its `Contents/Info.plist`; else a bundle
   * id LaunchServices knows. Anything else is refused — never bound to find out what it is.
   */
  private async identifyApp(ctx: RunCtx, app: string, metric: PrimitiveMetric): Promise<AppRef & { path?: string }> {
    const resolver = this.deps.appResolver ?? systemAppResolver;
    if (isAppPath(app)) {
      const hit = resolver.fromPath(app);
      if (hit === undefined) throw new Error(`could not read the bundle identifier of ${app} (its Contents/Info.plist) — pass the app's name or bundle id`);
      return { bundleId: hit.bundleId, name: hit.name, ...(hit.path === undefined ? {} : { path: hit.path }) };
    }
    const listed = await this.resolveApp(ctx, app, metric);
    this.live(ctx);
    if (listed !== undefined) return listed;
    if (isBundleIdShaped(app)) {
      const hit = resolver.fromBundleId(app);
      if (hit !== undefined) return { bundleId: hit.bundleId, name: hit.name };
    }
    throw new Error(`no app named "${app.slice(0, 120)}" — call apps.list() for the names, or pass a bundle id or an .app path`);
  }

  /** Opens a file path or URL with an app, never activating it (NSWorkspace.open activates:false). The opener
   *  gets its per-app card and the save-path floors apply to the paths; the opened document's window is bound. */
  private async openDocument(ctx: RunCtx, target: string, opener: string | undefined, metric: PrimitiveMetric): Promise<AppHandle> {
    const settings = this.deps.settings();
    const urls = [target];
    // Who will open it — for the per-app card — resolved without opening anything.
    const who = await this.helperCall<{ bundleId: string; name: string; path: string }>(
      ctx, "apps.defaultOpener", { urls, ...(opener === undefined ? {} : { app: opener }) }, metric);
    this.live(ctx);
    const app: AppRef = { bundleId: who.bundleId, name: who.name };
    await this.deps.policy.authorize(ctx.grants, app, { kind: "bind" }, ctx.abort.signal);
    this.live(ctx);
    const res = await this.helperCall<{ app: { name: string; bundleId: string; pid: number }; windowID?: number }>(
      ctx, "apps.openDocument",
      { urls, ...(opener === undefined ? {} : { app: opener }), sessionId: ctx.sessionId,
        mirror: computerUseMirrorFrom(settings), privatePath: computerUsePrivateEventPathFrom(settings) }, metric, undefined, { afterEnd: true });
    this.live(ctx);
    ctx.builder.daemonLine(`opened ${target.split("/").pop()} in ${res.app.name} (in the background)`);
    // Bind the opener's document window; the per-app grant from the card above means bind does not re-ask.
    return await this.bind(ctx, { app: res.app.bundleId, known: app,
      ...(res.windowID === undefined ? {} : { window: res.windowID }) }, metric);
  }

  /** `apps.open` / `screen.appAt`: policy BEFORE the helper launches anything, bind, lock, print the full state. */
  private async bind(ctx: RunCtx, req: { app: string; window?: string | number; known?: AppRef }, metric: PrimitiveMetric): Promise<AppHandle> {
    const known: AppRef & { path?: string } = req.known ?? await this.identifyApp(ctx, req.app, metric);
    await this.deps.policy.authorize(ctx.grants, known, { kind: "bind" }, ctx.abort.signal);
    this.live(ctx);
    const settings = this.deps.settings();
    const res = await this.helperCall<TargetBindResult>(ctx, "target.bind", {
      // A path binds that exact bundle (its identity was read above); everything else binds by bundle id.
      sessionId: ctx.sessionId, app: known.path ?? known.bundleId, ...(req.window === undefined ? {} : { window: req.window }), mirror: computerUseMirrorFrom(settings),
      // May the bind reach a window on another Space or in full screen through private APIs (and move it here)?
      privatePath: computerUsePrivateEventPathFrom(settings),
    }, metric, undefined, { afterEnd: true });
    const app: AppRef = { bundleId: res.app.bundleId, name: res.app.name };
    const info: TargetInfo = { targetId: res.targetId, bundleId: app.bundleId, name: app.name, pid: res.app.pid };
    try {
      // Bound after the script ended (the helper answered inside the cancel grace) — release it at once.
      this.live(ctx);
      // The helper bound something other than what policy allowed: refuse it rather than re-ask after the fact.
      if (app.bundleId.toLowerCase() !== known.bundleId.toLowerCase()) {
        throw new AutomationFailure("Refused", `${req.app.slice(0, 120)} resolved to ${app.bundleId}, not the ${known.bundleId} that was allowed — nothing was kept bound`);
      }
      ctx.state.targets.set(info.targetId, info);
      ctx.bound.add(info.targetId);
      await this.ensureLock(ctx, info);
    } catch (err) {
      ctx.state.targets.delete(info.targetId);
      ctx.bound.delete(info.targetId);
      this.deps.helper.tell("target.release", { targetId: info.targetId });
      throw err;
    }
    ctx.apps.add(app.name);
    this.deps.recentApps?.note(app.bundleId, app.name);
    // The same window bound again (the helper hands back the same target): what changed since its last printed
    // state, not the whole tree once more (live: re-binding in every script cost ~13 KB a call).
    const base = this.diffBases.get(ctx.sessionId, info.targetId);
    const snap = await this.helperCall<SnapshotResult>(ctx, "target.snapshot", {
      targetId: info.targetId, ...(base === undefined ? { full: true } : { since: base }), settle: { maxMs: SETTLE_CAP_MS }, callId: ctx.callId,
    }, metric);
    this.live(ctx);
    metric.settleMs = snap.waitedMs;
    metric.settleExit = snap.settled ? "quiet" : "cap";
    // What the bind had to do to reach a window (another Space, a new window): the first line of its state,
    // outside the fence — the helper's fixed wording, not screen text.
    const detail = helperDetail(res.detail);
    if (detail !== undefined) ctx.builder.daemonLine(detail);
    if (base !== undefined && snap.isDiff === true) {
      ctx.builder.daemonLine(`${app.name} was already bound to this window — the same handle; what changed since its last state follows (keep the handle in a top-level const: it lasts between calls)`);
    }
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
      targetId: t.targetId, callId: ctx.callId, ...(since === undefined ? {} : { since }), ...(full ? { full: true } : {}),
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
    // The page changed since the last state(), or the read was cut short: the helper's fixed words, said even
    // with emit:false (a model reading only the value would miss it).
    const note = helperDetail(res.note, 400);
    if (note !== undefined) ctx.builder.daemonLine(note);
    if (args.emit !== false) {
      ctx.builder.text(res.elements.length === 0 ? `(nothing in ${t.name} matches)` : res.elements.map(elementLine).join("\n"), { screen: true });
    }
    return res.elements;
  }

  private requireVision(ctx: RunCtx): void {
    if (!ctx.call.vision) throw new AutomationFailure("NotAllowed", NO_VISION);
  }

  /** One screenshot, at the budget for this session's model, re-taken at a lower quality while over 3 MiB. `extra`
   *  adds params per attempt (a live shot's `desktopVisit`, once the user allowed it); every desktop visit an attempt
   *  made is returned (a re-take is another visit — each one is said). */
  private async shoot(ctx: RunCtx, method: string, params: Record<string, unknown>, metric: PrimitiveMetric,
    extra?: () => Record<string, unknown>): Promise<ScreenshotResult & { bytes: number; visits: DesktopVisitReport[] }> {
    const maxDim = computerUseScreenshotMaxDimFrom(this.deps.settings());
    let quality: number = SCREENSHOT_QUALITY;
    const visits: DesktopVisitReport[] = [];
    for (;;) {
      const res = await this.helperCall<ScreenshotResult>(ctx, method, { ...params, ...(extra?.() ?? {}), budget: screenshotBudgetFor(ctx.call.model, maxDim, quality) }, metric);
      if (res.visit !== undefined) visits.push(res.visit);
      const bytes = Math.floor((res.imageBase64.length * 3) / 4);
      const next = nextScreenshotQuality(quality);
      if (bytes <= SCREENSHOT_BYTE_CAP || next === undefined) {
        metric.imageBytes = bytes;
        if (this.deps.screenshotSink !== undefined) {
          try { this.deps.screenshotSink({ sessionId: ctx.sessionId, primitive: method, mime: res.mime ?? "image/jpeg", base64: res.imageBase64 }); } catch { /* a test sink never fails a shot */ }
        }
        return { ...res, bytes, visits };
      }
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
    // `live: true` (the desktop-switch ruling): what is on screen NOW. Its reason is shown to the user when the shot
    // needs their desktop, so it is required — and sanitized to one short line before anyone sees it.
    if (args.live !== undefined && typeof args.live !== "boolean") throw bad("screenshot({ live }) takes true or false");
    const live = args.live === true;
    let reason: string | undefined;
    if (live) {
      if (typeof args.reason !== "string" || cardReason(args.reason).length === 0) {
        throw bad("screenshot({ live: true }) takes a reason — what you need to see on screen now; the user is shown it if the picture needs their desktop");
      }
      reason = cardReason(args.reason.slice(0, 4 * LIVE_REASON_MAX));
    }
    const settle = args.settle !== false && ctx.acted.has(t.targetId) ? { maxMs: SETTLE_CAP_MS } : undefined;
    const params = { targetId: t.targetId, callId: ctx.callId, ...(region === undefined ? {} : { region }), ...(settle === undefined ? {} : { settle }), ...(live ? { live: true } : {}) };
    const res = live ? await this.liveShot(ctx, t, params, reason!, metric) : await this.shoot(ctx, "target.screenshot", params, metric);
    for (const v of res.visits) this.noteVisit(ctx, t, v, metric);
    ctx.state.lastTargetShot.set(t.targetId, res.shotId);
    const handle = this.keepImage(ctx, res);
    // What the image is when it is not an ordinary capture ("captured …'s window on another desktop …") — said
    // even for an `emit: false` read, since it bears on what the agent concludes from the image.
    const detail = helperDetail(res.detail);
    if (detail !== undefined) ctx.builder.daemonLine(detail);
    if (args.emit !== false) {
      // The coordinate frame, so the model does not guess the scale: clicks take THIS image's pixels.
      const pts = typeof res.pointsWidth === "number" && typeof res.pointsHeight === "number" && res.pointsWidth > 0
        ? ` (window ${Math.round(res.pointsWidth)}×${Math.round(res.pointsHeight)} pt)` : "";
      ctx.builder.daemonLine(`clicks take this image's pixel coordinates: ${res.width}×${res.height}${pts}`);
      ctx.builder.image(res.imageBase64, res.mime ?? "image/jpeg");
    } else {
      ctx.builder.markScreenRead();
    }
    return handle;
  }

  /** AppleScript for the bound app, run by the helper with every Apple Event checked (only the bound app; no shell,
   *  no dialogs, never `activate`). An act: full access only, the per-app card, the floors. Its result is the app's
   *  data — inside the fence. */
  private async applescript(ctx: RunCtx, t: TargetInfo, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<unknown> {
    const source = args.source;
    if (typeof source !== "string" || source.trim().length === 0) throw bad("applescript() takes the script's source as a string");
    const language = args.language;
    if (language !== undefined && language !== "applescript" && language !== "javascript") throw bad('applescript() takes { language: "applescript" | "javascript" }');
    // The run may wait on macOS's own Automation question the first time: the helper allows a minute more for it,
    // and the request waits that long too — but never past the script call's own time, so a question the user
    // answers after the call ended still takes effect for the next script, while this call reports its timeout.
    const timeoutMs = this.clampWait(ctx, typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000);
    const res = await this.helperCall<AppleScriptResult>(ctx, "target.applescript",
      { targetId: t.targetId, source, ...(language === undefined ? {} : { language }), timeoutMs, callId: ctx.callId }, metric,
      Math.min(timeoutMs + 65_000, Math.max(timeoutMs, ctx.timer.left())));
    ctx.acted.add(t.targetId);
    const detail = helperDetail(res.detail);
    if (detail !== undefined) ctx.builder.daemonLine(detail);
    ctx.builder.markScreenRead();
    if (args.emit !== false && res.result !== null && res.result !== undefined) ctx.builder.text(res.result, { screen: true });
    return { result: res.result ?? null };
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
    const res = await this.helperCall<WaitForResult>(ctx, "target.waitFor", { targetId: t.targetId, cond, timeoutMs: timeout, callId: ctx.callId }, metric, timeout + 5_000);
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
      case "hover": {
        const target = pointTarget(a.target, "hover()");
        const ms = typeof a.ms === "number" && Number.isFinite(a.ms) ? { ms: Math.max(0, Math.min(5_000, Math.round(a.ms))) } : {};
        return { kind: "hover", ...target, ...shotFor(target.point !== undefined), ...ms };
      }
      case "menu":
        if (!Array.isArray(a.path) || a.path.length === 0 || !a.path.every((p) => typeof p === "string")) throw bad("menu() takes a path such as [\"File\", \"Export…\"]");
        return { kind: "menu", path: a.path as string[] };
      default:
        throw bad(`unknown action ${primitive}`);
    }
  }

  /**
   * A type/paste's expected time against the run's time left: it fits; or the run is extended by the estimate
   * (within the 300 s maximum, like a card's wait holds the clock); or, when even that is too little, it is refused
   * before anything is typed. Returns the helper request timeout to use when the default would be too short.
   */
  private fitTyping(ctx: RunCtx, primitive: "type" | "paste", text: string): number | undefined {
    const estimate = typingEstimateMs(primitive, text);
    const fit = typingFit(estimate, ctx.timer.left(), ctx.timer.budget, SCRIPT_TIMEOUT_MAX_MS);
    if (fit.kind === "refuse") throw new AutomationFailure("Refused", fit.message);
    if (fit.kind === "extend") {
      ctx.timer.extend(fit.byMs);
      ctx.extensions.push({ primitive, chars: [...text].length });
      this.deps.log?.(`computer-use: ${primitive} of ${[...text].length} characters (~${Math.ceil(estimate / 1000)} s): the run extended by ${Math.ceil(fit.byMs / 1000)} s`);
    }
    return estimate > 60_000 ? estimate + 60_000 : undefined;
  }

  /** `app.requestForeground(reason)`: the rung-4 card, with the model's reason, for the rest of this run. On a yes
   *  the app comes to the front (the helper holds it there until the script ends, then gives the front back) and
   *  its acts need no second asking; on a no, nothing moves. `true` when it is in front. */
  private async requestForeground(ctx: RunCtx, t: TargetInfo, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<boolean> {
    const reason = args.reason;
    if (typeof reason !== "string" || reason.trim().length === 0) throw bad("requestForeground() takes a reason: what needs the app in front, for the user");
    if (ctx.foreground.has(t.targetId)) return true;
    const app: AppRef = { bundleId: t.bundleId, name: t.name };
    if (!(await this.deps.policy.allowForeground(ctx.grants, app, ctx.abort.signal, reason))) {
      ctx.builder.daemonLine(`${t.name} may not come to the front now (the user did not allow it, or this session does not ask) — keep to what works in the background, or ask the user to do this step`);
      return false;
    }
    this.live(ctx);
    if (!ctx.locks.has(FOREGROUND_LOCK_KEY)) {
      const release = await this.locks.acquire(FOREGROUND_LOCK_KEY, { runId: ctx.runId, sessionId: ctx.sessionId }, {
        waitMs: Math.min(LOCK_WAIT_MS, Math.max(500, ctx.timer.left() - 500)), signal: ctx.abort.signal, label: "The screen's foreground",
      });
      if (ctx.ended || ctx.cancelled !== undefined) { release(); this.live(ctx); }
      ctx.locks.set(FOREGROUND_LOCK_KEY, release);
    }
    // On the user's own desktop only (the desktop-switch ruling): the helper never holds a window on another
    // desktop in front — it says so, and points at the scoped visit (an act asks by itself; a live screenshot).
    const res = await this.helperCall<{ front: boolean; detail?: string }>(ctx, "target.foreground", { targetId: t.targetId }, metric);
    if (!res.front) {
      const said = helperDetail(res.detail);
      ctx.builder.daemonLine(said ?? `${t.name} could not be brought to the front`);
      return false;
    }
    ctx.foreground.add(t.targetId);
    ctx.builder.daemonLine(`${t.name} is in front until this script ends; then the front goes back to the user's app`);
    return true;
  }

  /** One action, through the input ladder; rung 4 (the foreground) only after the user agreed — or at once under `bypass`. */
  private async act(ctx: RunCtx, t: TargetInfo, primitive: string, action: ActAction, metric: PrimitiveMetric): Promise<undefined> {
    const settings = this.deps.settings();
    const params = {
      targetId: t.targetId, sessionId: ctx.sessionId, callId: ctx.callId, action,
      access: this.deps.policy.accessFor(t.bundleId) === "click" ? "click" : "full",
      privatePath: computerUsePrivateEventPathFrom(settings),
    };
    // A type or paste long enough to outlast the run's time left gets the run extended (or is refused up front)
    // — never killed halfway with the field part-filled.
    const actTimeout = action.kind === "type" || action.kind === "paste" ? this.fitTyping(ctx, action.kind, action.text) : undefined;
    const app: AppRef = { bundleId: t.bundleId, name: t.name };
    const key = visitKey(t);
    // Held in front for this run (`requestForeground`): the foreground needs no second asking.
    let allowForeground = ctx.foreground.has(t.targetId);
    let releaseForeground: (() => void) | undefined;
    let res: ActResult | undefined;
    try {
      for (let attempt = 0; res === undefined; attempt++) {
        // The user allowed a desktop visit for this app in this run: the helper still tries the background first and
        // visits only when it must — under the screen's one foreground lock, like rung 4.
        const visit = ctx.visits.get(key) === true;
        if (visit && releaseForeground === undefined) releaseForeground = await this.takeForeground(ctx);
        try {
          res = await this.helperCall<ActResult>(ctx, "target.act", { ...params, allowForeground: allowForeground || visit, ...(visit ? { desktopVisit: true } : {}) }, metric, actTimeout);
        } catch (err) {
          if (!(err instanceof HelperRpcError) || attempt >= 2) throw err;
          if (err.code === "needs_desktop_visit" && !visit) {
            // No way to do it without moving the user to the window's desktop: ask (every policy), then visit.
            if (!(await this.desktopVisitAllowed(ctx, t, desktopVisitActReason(app, primitive, ctx.title), metric))) {
              throw new AutomationFailure("NeedsForeground", `the user refused to be moved to ${t.name}'s desktop for this ${primitive} — don't retry it; keep to what works from here (element refs, state()), or ask the user to bring ${t.name}'s window to this desktop`);
            }
            continue;
          }
          if (err.code === "needs_foreground" && !allowForeground) {
            if (!(await this.deps.policy.allowForeground(ctx.grants, app, ctx.abort.signal))) {
              throw new AutomationFailure("NeedsForeground", primitive === "menu"
                // A menu command the app keeps disabled while it is in the background (Finder's Move to Trash).
                ? `${t.name} only enables that menu command while it is in front, and Winter may not bring it forward now — ask the user to choose it, or to allow foreground use`
                : `${t.name} only accepts this ${primitive} in the foreground, and Winter may not take the pointer now — try an element ref or another action, or ask the user`);
            }
            this.live(ctx);
            if (releaseForeground === undefined) releaseForeground = await this.takeForeground(ctx);
            allowForeground = true;
            continue;
          }
          throw err;
        }
      }
    } finally { releaseForeground?.(); }
    ctx.acted.add(t.targetId);
    metric.rung = res.rung;
    this.noteVisit(ctx, t, res.visit, metric);
    // What the act did, in the helper's words: for keyboard input, FIRST where it went (so the model never has
    // to guess), then the helper's detail (an unconfirmed paste, an editor that hides its text, a view put back).
    // Element names come from the screen: inside the fence.
    const line = actLine(primitive, action, res);
    if (line !== undefined) ctx.builder.text(line, { screen: true });
    // A link navigated or a tab switched: the refs read before are gone (live: `state({ within })` on one of them).
    const page = pageLine(res);
    if (page !== undefined) ctx.builder.text(page, { screen: true });
    // Where the focus went when the act moved it (⌘R into the address bar, a click into another field): the LAST
    // change per target, said once at the end of the script — twenty acts can't flood the result.
    const focus = focusLine(res);
    if (focus !== undefined) ctx.focusLines.set(t.targetId, { app: t.name, line: focus });
    return undefined;
  }

  /** The screen's one foreground lock for this primitive (rung 4, a desktop visit, a whole-screen shot) — a no-op
   *  when the run already holds it for the rest of the script (`requestForeground`). */
  private async takeForeground(ctx: RunCtx): Promise<() => void> {
    if (ctx.locks.has(FOREGROUND_LOCK_KEY)) return () => {};
    const release = await this.locks.acquire(FOREGROUND_LOCK_KEY, { runId: ctx.runId, sessionId: ctx.sessionId }, {
      waitMs: Math.min(LOCK_WAIT_MS, Math.max(500, ctx.timer.left() - 500)), signal: ctx.abort.signal, label: "The screen's foreground",
    });
    if (ctx.ended || ctx.cancelled !== undefined) { release(); this.live(ctx); }
    return release;
  }

  /**
   * THE DESKTOP SWITCH (the ruling, 2026-10-10): may this primitive move the user to `t`'s desktop for a moment?
   * Asked once per app (bundle id + pid) per run — every policy, the session's card and the helper's on-screen panel,
   * no answer within a minute allows — and the answer kept for the rest of the run: an allowance needs no second
   * prompt, a refusal is not asked again. Concurrent primitives of one script share the prompt on screen.
   */
  private async desktopVisitAllowed(ctx: RunCtx, t: TargetInfo, reason: string, metric: PrimitiveMetric): Promise<boolean> {
    const key = visitKey(t);
    const known = ctx.visits.get(key);
    if (known !== undefined) { metric.visitAnswer = known ? "run-allowance" : "run-refusal"; return known; }
    let prompt = ctx.visitPrompts.get(key);
    if (prompt === undefined) {
      prompt = this.deps.policy.askDesktopVisit(ctx.grants, { bundleId: t.bundleId, name: t.name }, reason, ctx.abort.signal)
        .finally(() => ctx.visitPrompts.delete(key));
      ctx.visitPrompts.set(key, prompt);
    }
    const outcome = await prompt;
    metric.visitAnswer = outcome.answer;
    metric.visitVia = outcome.via;
    if (outcome.answer !== "aborted") ctx.visits.set(key, outcome.allowed);
    this.live(ctx);
    return outcome.allowed;
  }

  /** A `live: true` window shot: the helper takes it from here when it can (on screen, or a still it proved live);
   *  when only the window's desktop has it, the user is asked, and the shot is retaken with the visit allowed. */
  private async liveShot(ctx: RunCtx, t: TargetInfo, params: Record<string, unknown>, reason: string, metric: PrimitiveMetric): Promise<ScreenshotResult & { bytes: number; visits: DesktopVisitReport[] }> {
    const key = visitKey(t);
    const visitParams = (): Record<string, unknown> => (ctx.visits.get(key) === true ? { desktopVisit: true } : {});
    let release: (() => void) | undefined;
    try {
      if (ctx.visits.get(key) === true) release = await this.takeForeground(ctx);
      try {
        return await this.shoot(ctx, "target.screenshot", params, metric, visitParams);
      } catch (err) {
        if (!(err instanceof HelperRpcError) || err.code !== "needs_desktop_visit" || ctx.visits.get(key) === true) throw err;
      }
      if (!(await this.desktopVisitAllowed(ctx, t, reason, metric))) {
        throw new AutomationFailure("NeedsForeground", `the user refused to be moved to ${t.name}'s desktop for a live picture — don't ask again in this script; read it with state() or find() (they are live there), use the last screenshot (its first line says how fresh it is), or ask the user`);
      }
      release ??= await this.takeForeground(ctx);
      return await this.shoot(ctx, "target.screenshot", params, metric, visitParams);
    } finally { release?.(); }
  }

  /**
   * One desktop visit, said in the result and counted in telemetry: an unfenced daemon line ("moved the user to
   * Safari's desktop for 420 ms and back"), or — when the user could not be brought back — a loud notice at the top
   * and a log line. The helper's own detail goes to the log only (the result keeps to the daemon's words).
   */
  private noteVisit(ctx: RunCtx, t: TargetInfo, v: DesktopVisitReport | undefined, metric: PrimitiveMetric): void {
    if (v === undefined) return;
    const ms = Number.isFinite(v.ms) ? Math.max(0, Math.round(v.ms)) : 0;
    const prior = metric.visit;
    metric.visit = {
      count: (prior?.count ?? 0) + 1, ms: (prior?.ms ?? 0) + ms,
      returned: (prior?.returned ?? true) && (v.returned === true || v.userMoved === true),
      ...(v.userMoved === true || prior?.userMoved === true ? { userMoved: true } : {}),
    };
    const said = helperDetail(v.detail, 300);
    if (v.userMoved === true) {
      ctx.builder.daemonLine(`moved the user to ${t.name}'s desktop for a moment; they took over during it, so Winter left them where they went`);
      this.log(`computer-use: desktop visit to ${t.bundleId} for ${ctx.sessionId}: ${ms} ms, the user took over${said === undefined ? "" : ` (${said})`}`);
      return;
    }
    if (v.returned === true) {
      ctx.builder.daemonLine(`moved the user to ${t.name}'s desktop for ${ms} ms and back`);
      this.log(`computer-use: desktop visit to ${t.bundleId} for ${ctx.sessionId}: ${ms} ms, returned`);
      return;
    }
    ctx.builder.notice(`Winter moved the user to ${t.name}'s desktop and could NOT bring them back to their own. Tell the user now, and do nothing more in ${t.name} until they are back on their desktop.`);
    this.log(`computer-use: WARNING desktop visit to ${t.bundleId} for ${ctx.sessionId}: the user was NOT returned after ${ms} ms${said === undefined ? "" : ` (${said})`}`);
  }

  private async screenScreenshot(ctx: RunCtx, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<ImageHandle> {
    this.requireVision(ctx);
    // `display` is an INDEX (0 = the main display) or "all" (spine §2.1, after the Swift review); the helper's
    // `displayId` (a CGDirectDisplayID) is not part of the script API.
    const display = args.display === "all" || (typeof args.display === "number" && Number.isInteger(args.display) && args.display >= 0) ? { display: args.display } : {};
    // Whole-screen shots and rung-4 input take turns on the one foreground (spec §14).
    const release = await this.locks.acquire(FOREGROUND_LOCK_KEY, { runId: ctx.runId, sessionId: ctx.sessionId }, {
      waitMs: Math.min(LOCK_WAIT_MS, Math.max(500, ctx.timer.left() - 500)), signal: ctx.abort.signal, label: "The screen",
    });
    let res: ScreenshotResult & { bytes: number };
    try {
      res = await this.shoot(ctx, "screen.screenshot", { ...display, excludeBundleIds: await this.screenExclusions(ctx, metric) }, metric);
    } finally { release(); }
    ctx.state.lastScreenShot = res.shotId;
    const handle = this.keepImage(ctx, res);
    if (args.emit !== false) ctx.builder.image(res.imageBase64, res.mime ?? "image/jpeg");
    else ctx.builder.markScreenRead();
    // Where Winter's own windows are in it (a picture of an app inside one is Winter's mirror, not the app).
    const detail = helperDetail(res.detail, 500);
    if (detail !== undefined) ctx.builder.daemonLine(detail);
    return handle;
  }

  /**
   * The bundle ids a whole-screen shot blacks out (`ComputerPolicy.excludedFromScreen`). With the master switch OFF
   * every running app without an allowing exception is `deny`, so the helper's `apps.list` is asked FRESH for what
   * runs now (never the run's cached list — an app launched since must not slip through); a failure fails the shot.
   */
  private async screenExclusions(ctx: RunCtx, metric: PrimitiveMetric): Promise<string[]> {
    if (this.deps.policy.allowAllApps()) return this.deps.policy.excludedFromScreen();
    const res = await this.helperCall<AppsListResult>(ctx, "apps.list", {}, metric);
    ctx.appCache = res.apps;
    return this.deps.policy.excludedFromScreen(res.apps.filter((a) => a.running).map((a) => a.bundleId));
  }

  private async screenWindows(ctx: RunCtx, args: Record<string, unknown>, metric: PrimitiveMetric): Promise<unknown> {
    const res = await this.helperCall<ScreenWindowsResult>(ctx, "screen.windows", {}, metric);
    // Every window's own app is weighed (the floors, and its effective access — `deny` under the switch off too).
    // `onScreen` is kept: without it a window on another Space reads as visible (a live run took Safari's frame
    // for proof it was on this desktop, while its screenshot said otherwise).
    const windows = res.windows.filter((w) => !this.deps.policy.hiddenFromScreen(w.bundleId))
      .map((w) => ({ app: w.app, title: w.title, frame: w.frame, onScreen: w.onScreen }));
    ctx.builder.markScreenRead();
    if (args.emit !== false) {
      ctx.builder.text(windows.length === 0 ? "(no windows)" : windows.map((w) => `${w.app} — "${w.title}" [${w.frame.join(", ")}]${w.onScreen ? "" : " (off screen)"}`).join("\n"), { screen: true });
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

  /**
   * Any failure → the `{kind, message}` the worker throws as its class, with one actionable sentence. `trusted`:
   * the sentence is the DAEMON's own words with no screen text in it — shown outside the DATA-ONLY fence when it
   * escapes the script verbatim (a `WaitTimeout`'s `seen` is screen text, so it stays inside).
   */
  private toWire(ctx: RunCtx, err: unknown, msg: CallMessage): { kind: string; message: string; trusted: boolean } {
    const w = this.toWireInner(ctx, err, msg);
    return { kind: w.kind, message: w.message, trusted: w.untrusted !== true && w.kind !== "WaitTimeout" && w.kind !== "Error" };
  }

  /** `untrusted`: the message carries the helper's own words (which may name a window), so it stays in the fence. */
  private toWireInner(ctx: RunCtx, err: unknown, msg: CallMessage): { kind: string; message: string; untrusted?: true } {
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
        case "target_lost": {
          // The helper says what it observed (`data.reason`); a closed window is never worded as a quit app.
          const reason = typeof data.reason === "string" ? data.reason : "unknown";
          if (t !== undefined) { t.lost = reason; this.diffBases.clearTarget(ctx.sessionId, t.targetId); }
          return { kind: "TargetLost", message: targetLostMessage(name, reason) };
        }
        // The app is still running — never worded as "the app quit". The helper's own message is kept (capped), with
        // what to do next; the target stays bound (the window may come back) but its diff base is reset.
        case "window_elsewhere":
        case "no_window": {
          if (t !== undefined) { this.diffBases.clearTarget(ctx.sessionId, t.targetId); ctx.state.lastTargetShot.delete(t.targetId); }
          const elsewhere = err.code === "window_elsewhere";
          const said = err.message.replace(/\s+/g, " ").trim().slice(0, 400) || (elsewhere ? "the window is on another Space or in full screen" : "the app has no open window");
          // The helper's own sentence is kept; it names the app and often says what to do — add only what is missing.
          const prefix = t === undefined || said.includes(name) ? "" : `${name}: `;
          const next = said.includes(" — ") ? "" : elsewhere
            ? " — ask the user to bring it to this desktop (or out of full screen), then try again"
            : " — open a document in it with apps.open(path or URL), which opens in the background, or ask the user to open one";
          return { kind: "NoWindow", message: `${prefix}${said}${next}`, untrusted: true };
        }
        case "needs_foreground": return { kind: "NeedsForeground", message: `${name} needs the foreground for that — try an element ref, or ask the user` };
        // The desktop switch: one that escaped the ladder (asked again after the user allowed it) — never a bare Error.
        case "needs_desktop_visit": return { kind: "NeedsForeground", message: `${name}'s window is on another desktop and this needs it on screen, which Winter could not arrange — keep to what works from here, or ask the user to bring the window to this desktop` };
        case "not_allowed": return { kind: "NotAllowed", message: typeof data.reason === "string" ? `not allowed: ${data.reason}` : `not allowed in ${name}` };
        case "refused": {
          // The helper's own sentence is KEPT — it says what it actually saw (the live gate: VS Code's "can't tell
          // which field has focus…" must not become a canned "that is a password field"). It may name screen
          // content, so it stays inside the fence. The canned words are only a fallback for a bare refusal.
          const said = err.message.replace(/\s+/g, " ").trim().slice(0, 400);
          if (said.length > 0) return { kind: "Refused", message: said, untrusted: true };
          return { kind: "Refused", message: refusedWords(typeof data.reason === "string" ? data.reason : "", name) };
        }
        case "wait_timeout": {
          ctx.builder.markScreenRead();
          const seen = typeof data.seen === "string" && data.seen.length > 0 ? ` — seen: ${data.seen.slice(0, 2_000)}` : "";
          return { kind: "WaitTimeout", message: `the wait timed out without the condition being met${seen}` };
        }
        case "cancelled": {
          // A type or paste stopped while typing keys says how far it got: the field is partly filled.
          const base = ctx.cancelled ?? "the call was cancelled";
          if (typeof data.typed !== "number" || typeof data.total !== "number") return { kind: "Cancelled", message: base };
          const partly = `${data.typed} of ${data.total} characters had already been typed${name === "the app" ? "" : ` into ${name}`} — the field is partly filled; check it before typing again`;
          ctx.builder.notice(`The cancelled ${msg.primitive}: ${partly}.`);
          return { kind: "Cancelled", message: `${base}; ${partly}` };
        }
        case "permission_missing": {
          const which = data.permission === "screenRecording" ? "Screen Recording" : "Accessibility";
          return { kind: "PermissionMissing", message: `Winter Computer Use needs the ${which} permission — ask the user to grant it in Settings → Computer Use` };
        }
        case "busy": {
          // The helper's own sentence is kept (it says what happened and what to do; it may name a control, so it
          // stays in the fence). An action that was SENT but not confirmed is `Uncertain` — check state(), never
          // simply retry; any other busy is the app (or the helper's queue for it) not answering: `TargetBusy`.
          const said = err.message.replace(/\s+/g, " ").trim().slice(0, 400);
          if (data.uncertain === true) {
            return { kind: "Uncertain", message: said || `${name} did not confirm that action — it may have happened; check state() before doing it again`, untrusted: true };
          }
          return { kind: "TargetBusy", message: said ? `${said}${/try again|retry/i.test(said) ? "" : " — try again in a moment"}` : `${name} is busy — try again in a moment`, untrusted: true };
        }
        case "unsupported": {
          // `data.axError` (the raw Accessibility error) is for the log, not the model: the helper's sentence says
          // what could not be done.
          if (data.axError !== undefined) this.deps.log?.(`computer-use: ${msg.primitive} unsupported in ${name} (AX error ${String(data.axError).slice(0, 40)})`);
          const said = err.message.replace(/\s+/g, " ").trim().slice(0, 700);
          return { kind: "Error", message: said.length > 0 ? said : `${name} does not support ${msg.primitive}` };
        }
        case "invalid_params": return { kind: "TypeError", message: err.message };
        default: return { kind: "Error", message: `${err.code}: ${err.message}` };
      }
    }
    return { kind: "Error", message: err instanceof Error ? err.message : String(err) };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────────

  /** Forget the session's bindings and diff bases (a reset, a worker restart): the old handles are gone — and so
   *  is every value the old runtime read from the screen, so the session's fence taint goes with them. */
  private forgetBindings(sessionId: string, state: SessionState): void {
    for (const t of state.targets.values()) if (t.lost === undefined) this.deps.helper.tell("target.release", { targetId: t.targetId });
    state.targets.clear();
    state.images.clear();
    state.lastTargetShot.clear();
    state.lastScreenShot = undefined;
    state.tainted = false;
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
    state.idleTimer = setTimeout(() => {
      // Never mid-run: a run that started after this timer was armed keeps the session (the review's idle minor).
      const now = this.sessions.get(sessionId);
      if (now === undefined || now.pending > 0 || now.active !== undefined) return;
      this.endSession(sessionId, "idle");
    }, this.deps.idleMs ?? WORKER_IDLE_MS);
    (state.idleTimer as { unref?: () => void }).unref?.();
  }

  /**
   * End the session's runtime and tell the helper (`session.ended` releases its targets and closes its mirrors):
   * `deleted` — the session is gone (its driver ends for good); `idle` — its worker idled out (30 minutes);
   * `stop` — the daemon stops. A child incarnation ending (idle eviction, a credential swap) is NOT this: the worker
   * keeps the session's variables and bindings across incarnations. "Allow for this session" grants live as long
   * as the SESSION, so an idle end keeps them (the review's grants minor).
   */
  endSession(sessionId: string, reason: "deleted" | "idle" | "stop" = "deleted"): void {
    if (reason !== "idle") this.deps.policy.clearSession(sessionId);
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    if (state.active !== undefined) this.cancel(state.active, "the session ended");
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.worker?.kill();
    this.diffBases.clearSession(sessionId);
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
          // Only a session running a script NOW: the helper's view of "active" can lag the daemon's (a script
          // that just ended, a late notification), and an Esc must never stop a turn that started after it —
          // e.g. a message the coordinator sent once the user's earlier stop had settled.
          const active = this.sessions.get(sessionId)?.active;
          if (active === undefined) continue;
          this.cancel(active, "the user pressed Esc");
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
    for (const sessionId of [...this.sessions.keys()]) this.endSession(sessionId, "stop");
  }

  /** Tests and diagnostics: the session's live worker pid. */
  workerPid(sessionId: string): number | undefined { return this.sessions.get(sessionId)?.worker?.pid; }
}

function failure(name: string, message: string): ScriptResult {
  return new ResultBuilder().build({ error: { name, message, trusted: true } });
}

/** The functions a script may call — anything else from the worker is refused unrecorded (review I6). */
const KNOWN_PRIMITIVES: ReadonlySet<string> = new Set<string>([...APP_PRIMITIVES, ...GLOBAL_PRIMITIVES]);

/** The error names a result (and the audit line) may carry: the ten kinds and JavaScript's own. */
const KNOWN_ERROR_NAMES: ReadonlySet<string> = new Set<string>([
  ...AUTOMATION_ERROR_KINDS, "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError",
]);
const ERROR_MESSAGE_CAP = 4_096;

/**
 * The worker's escaped error, made safe to show and to log: the name is a KNOWN kind or `Error` (a script can throw
 * an object with any `name`, of any size — review I6), the message is capped, the line a positive integer. It is
 * TRUSTED (shown outside the fence) only when its message is one the daemon itself sent in this call.
 */
/** A bind's or useWindow's `detail` from the helper, as one short line (or nothing). */
/** The words of a run's timeout: its EFFECTIVE deadline, and — when it was extended — from what and why
 *  ("the script timed out after 72 s; extended from 30 s for typing 3,000 characters"). */
export function timeoutMessage(timeoutMs: number, budgetMs: number, extensions: ReadonlyArray<{ primitive: "type" | "paste"; chars: number }>,
  progress?: { calls: number; last?: string }): string {
  const s = (ms: number): string => `${Math.round(ms / 1000)} s`;
  let head: string;
  if (extensions.length === 0 || budgetMs <= timeoutMs) {
    head = `the script timed out after ${timeoutMs} ms`;
  } else {
    const chars = extensions.reduce((n, e) => n + e.chars, 0).toLocaleString("en-US");
    const what = extensions.every((e) => e.primitive === "paste") ? "pasting" : extensions.every((e) => e.primitive === "type") ? "typing" : "typing and pasting";
    const why = extensions.length === 1 ? `${what} ${chars} characters` : `${what} ${chars} characters in ${extensions.length} calls`;
    head = `the script timed out after ${s(budgetMs)}; extended from ${s(timeoutMs)} for ${why}`;
  }
  if (progress === undefined) return head;
  // How far it got, and what to do about it: the model saw only "timed out" before (live: a 72 s loop).
  const done = progress.calls === 1 ? "1 call had run" : `${progress.calls.toLocaleString("en-US")} calls had run`;
  const suggest = Math.min(SCRIPT_TIMEOUT_MAX_MS, Math.max(timeoutMs * 2, budgetMs + 30_000));
  return `${head} — ${done}${progress.last === undefined ? "" : `, the last ${progress.last}`}; `
    + `for longer work pass timeoutMs (e.g. ${suggest}, at most ${SCRIPT_TIMEOUT_MAX_MS}), split it across calls, or have a loop check timeLeft()`;
}

/** `the page changed (now "<title>") — refs from before it are gone; call state()`, when the act changed the page. */
export function pageLine(res: ActResult): string | undefined {
  if (typeof res.pageNow !== "string" || res.pageNow.trim().length === 0) return undefined;
  const title = res.pageNow.replace(/\s+/g, " ").trim().slice(0, 160);
  return `the page changed (now "${title}") — refs from before it are gone; call state()`;
}

/** `now [226] text field "smart search field"`, or `unknown (the app reports none)`; nothing when the act did not
 *  move the focus. */
export function focusLine(res: ActResult): string | undefined {
  if (typeof res.focusNow === "string" && res.focusNow.trim().length > 0) return `now ${res.focusNow.replace(/\s+/g, " ").trim().slice(0, 200)}`;
  if (res.focusLost === true) return "unknown (the app reports none)";
  return undefined;
}

/** The line an act prints: `sent 5 characters to [14] text area "Comment"; received: verified` for type() —
 *  what was SENT, then what the field RECEIVED (the helper's detail: verified / partly / unverifiable), never
 *  "typed" for keys nobody saw land — `pasted into …` for paste(), and so on, the helper's detail after it; the
 *  detail alone for any other act; nothing when there is nothing to say. */
export function actLine(primitive: string, action: ActAction, res: ActResult): string | undefined {
  const detail = helperDetail(res.detail, 700);
  const input = typeof res.input === "string" ? res.input.replace(/\s+/g, " ").trim().slice(0, 200) : undefined;
  const verb = action.kind === "type" ? `sent ${countCharacters(action.text)} to`
    : action.kind === "paste" ? "pasted into"
    : action.kind === "key" ? `pressed ${action.combo} in`
    : action.kind === "setValue" ? "set the value of" : undefined;
  let head: string | undefined;
  if (verb !== undefined && input !== undefined) head = `${verb} ${input}`;
  else if (verb !== undefined && res.inputUnknown === true) {
    head = `${primitive}: the app reports no focused element, so where it went is unknown — click the field first, or pass { into }`;
  }
  if (head === undefined) return detail;
  if (detail === undefined) return head;
  return /^(received:|as a paste)/.test(detail) ? `${head}; ${detail}` : `${head} — ${detail}`;
}

/** "1 character" / "65 characters", counted as a person reads them (grapheme clusters — the helper's own count). */
export function countCharacters(text: string): string {
  let n = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) n += 1;
  return `${n.toLocaleString("en-US")} character${n === 1 ? "" : "s"}`;
}

function helperDetail(detail: unknown, cap = 300): string | undefined {
  if (typeof detail !== "string") return undefined;
  const line = detail.replace(/\s+/g, " ").trim().slice(0, cap);
  return line.length === 0 ? undefined : line;
}

export function normaliseScriptError(e: { name?: unknown; message?: unknown; line?: unknown }, daemonSentences: ReadonlySet<string>): ScriptError {
  const name = typeof e.name === "string" && KNOWN_ERROR_NAMES.has(e.name) ? e.name : "Error";
  const raw = typeof e.message === "string" ? e.message : String(e.message ?? "");
  const message = raw.slice(0, ERROR_MESSAGE_CAP);
  const line = typeof e.line === "number" && Number.isInteger(e.line) && e.line > 0 && e.line < 1_000_000 ? e.line : undefined;
  const trusted = (AUTOMATION_ERROR_KINDS as readonly string[]).includes(name) && daemonSentences.has(raw);
  return { name, message, ...(line === undefined ? {} : { line }), trusted };
}

/** Sleep `ms` unless `signal` aborts first; `false` when it did. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, ms);
    const onAbort = (): void => { clearTimeout(timer); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

function elementLine(e: { ref: number; role: string; name?: string; value?: string; states?: string[] }): string {
  const states = Array.isArray(e.states) && e.states.length > 0 ? ` (${e.states.join(", ")})` : "";
  return `[${e.ref}] ${e.role}${e.name === undefined ? "" : ` "${e.name}"`}${e.value === undefined ? "" : ` value="${e.value.slice(0, 200)}"`}${states}`;
}

/** What the model reads for a target that is gone, in the words of what happened to it: the helper's observed
 *  `reason` (`app_quit`, `window_closed`, `helper_restart`, `unknown` — apple/ComputerUse/PROTOCOL.md) or the
 *  daemon's own `once` (an "Allow once" binding released after its call). */
export function targetLostMessage(name: string, reason: string): string {
  switch (reason) {
    case "app_quit": return `${name} quit — open it again with apps.open()`;
    case "window_closed": return `${name}'s window closed — call apps.open or useWindow to pick another`;
    case "helper_restart": return `Winter Computer Use restarted, so ${name} is no longer bound — bind it again with apps.open()`;
    case "once": return `${name} was allowed for one call only — bind it again with apps.open()`;
    default: return `${name} is no longer bound — bind it again with apps.open()`;
  }
}

function refusedWords(reason: string, name: string): string {
  switch (reason) {
    case "secure_field": return "that is a password or payment field — Winter never reads or types into one; ask the user to fill it in";
    case "focus_unknown": return `can't tell which field has focus in ${name}, so it could be a password field — pass \`into\` or click a text field first`;
    case "focus_not_placed": return `couldn't put the keyboard focus in that field of ${name}, so nothing was typed — use setValue(ref, text) if it takes a value, or click it first and retry`;
    case "focus_not_editable": return `the focus in ${name} is not a text field, so nothing was typed — click the field or pass { into }`;
    case "focus_moved": return `the focus left the field partway in ${name}, so the rest was not typed — check state(), then type the rest with { into }`;
    case "wrong_field_shape": return `the text does not fit the field that has the focus in ${name} (several lines, or a long text, for a one-line field or the browser's own) — pass { into } for the field you mean`;
    case "auth_dialog": return "that is a system authentication dialog — ask the user to handle it";
    case "privacy_pane": return "System Settings' Privacy & Security panes are off limits — ask the user to change them";
    case "winter_itself": return "Winter never controls itself";
    case "save_path": return "that save location is protected (shell startup files, ~/.ssh, LaunchAgents) — choose another";
    default: return `${name} refused that action${reason ? ` (${reason})` : ""}`;
  }
}
