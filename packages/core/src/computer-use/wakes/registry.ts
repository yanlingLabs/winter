// ComputerV2 wake triggers — THE REGISTRY (spine §3): every armed trigger lives here, in the daemon, from the script
// that arms it (`target.wakeWhen(…)`) until it ends. It outlives the script, the turn, the session's automation worker
// (a reset, a crash, the 30-minute idle end) and the incarnation: a trigger's life is the SESSION's, never the
// worker's. It ends one way, once:
//   - `fired` / `lost`   — its backend's one event (the user did it; the target went);
//   - `expired`          — its own timer;
//   - `cancelled`        — the model (`wake.cancel()`, `wakes.cancel(id)`) or the user (the Mac's [Stop waiting]);
//   - `disabled`         — `computerUse.wakes` or `computerUse.enabled` turned off, or the session archived or deleted;
//   - `restart`          — the daemon stopped while it was armed (said at the next boot, from `wakes.json`).
// Every ending appends `wake_ended` to the session's log (the Mac's pill); `fired`, `lost`, `restart` — and `expired`
// with `notifyOnTimeout` — also WAKE the session (`delivery.ts`). `cancelled` and `disabled` never do.
//
// The registry routes nothing itself: the service names the backend (a tab binding → the browser engine's backend,
// anything else → the helper's), and the backends — lanes B and C — implement `WakeBackend` (`types.ts`).
import { randomBytes } from "node:crypto";
import { WAKE_LABEL_MAX, type NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { computerUseEnabledFrom, computerUseWakesFrom, type Settings } from "../../settings";
import { AutomationFailure } from "../errors";
import type { HelperNotification } from "../protocol";
import type { PrimitiveMetric } from "../telemetry";
import { WakeDelivery, type WakeDeliveryDeps, type WakeNews, type WakeSessionState } from "./delivery";
import { WakeStore, type WakeRecord } from "./persist";
import { WAKE_LIMITS, type WakeArmed, type WakeBackend, type WakeBackendEvent, type WakeCondition, type WakeEndReason } from "./types";

/** What a backend may also want from the helper connection (lane C's app backend): its notifications and its loss. */
export interface WakeBackendHelperHooks {
  handleNotification?(n: HelperNotification): void;
  helperDisconnected?(): void;
}
export type WakeBackendKind = "tab" | "app";
/** The two backends, by target kind. Either may be absent (this daemon cannot watch that kind: arming says so). */
export interface WakeBackends {
  tab?: WakeBackend & WakeBackendHelperHooks;
  app?: WakeBackend & WakeBackendHelperHooks;
}

/** How often armed triggers re-read `computerUse.wakes`/`.enabled` (a write through the app's own toggle is checked at
 *  once; a hand-edited settings file within this). Runs only while something is armed. */
export const WAKE_SETTINGS_POLL_MS = 10_000;

export interface WakeArmInput {
  sessionId: string;
  targetId: string;
  backend: WakeBackendKind;
  condition: WakeCondition;
  timeoutMs: number;
  note?: string;
  notifyOnTimeout?: boolean;
  /** For the audit line: the app (its name) or the site (a host) — never screen text. */
  audit?: { app?: string; site?: string };
}

/** What the service reports once armed — the labels already sanitized and cut. */
export interface ArmedWake {
  wakeId: string;
  expiresAt: number;
  targetLabel: string;
  elementLabel?: string;
  elementRole?: string;
  rebind: string;
  /** The backend's own daemon-written sentence about how it waits (`WakeArmed.note`) — printed unfenced. */
  backendNote?: string;
}

export interface WakeListRow { id: string; target: string; condition: string; element?: string; expiresAt: number; expiresInMin: number; note?: string }

export interface WakeRegistryDeps {
  /** Read at every use (lanes B and C plug in later; a test injects fakes). */
  backends(): WakeBackends;
  settings(): Settings | null | undefined;
  /** `hub.append` — the `wake_armed`/`wake_ended` pair. */
  append(sessionId: string, event: NewSessionEvent): void;
  sessionState(sessionId: string): WakeSessionState;
  sessions: WakeDeliveryDeps["sessions"];
  /** Dispatch: is a turn of this session being followed by its coordinator NOW (`DispatchChildren.followingTurn`)? */
  followedNow?(sessionId: string): boolean;
  /** Dispatch: follow the child's wake turn (`DispatchChildren.expectWake`). */
  followWake?(sessionId: string, text: string): (() => void) | undefined;
  /** The `wakes.json` store (`persist.ts`). */
  store: WakeStore;
  telemetry?(metric: PrimitiveMetric): void;
  audit?(line: Record<string, unknown>): void;
  now?(): number;
  /** Timers (a test drives them): returns the canceller. */
  schedule?(fn: () => void, ms: number): () => void;
  pollMs?: number;
  coalesceMs?: number;
  retryDelaysMs?: readonly number[];
  tag?(): string;
  clock?(at: number): string;
  log?(line: string): void;
}

interface Trigger {
  wakeId: string;
  sessionId: string;
  targetId: string;
  backend: WakeBackendKind;
  condition: WakeCondition;
  armedAt: number;
  expiresAt: number;
  note?: string;
  notifyOnTimeout: boolean;
  targetLabel: string;
  elementLabel?: string;
  elementRole?: string;
  rebind: string;
  followed: boolean;
  audit?: { app?: string; site?: string };
  cancelTimer: () => void;
}

/** One line, no control or bidi characters, cut — a label from the screen goes into a log, a pill and a message. */
export function wakeLabel(v: unknown, max: number = WAKE_LABEL_MAX): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const one = v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The label a condition's own text gets (a text, URL or title the model gave): quoted. */
const quoted = (s: string, max = WAKE_LABEL_MAX): string => `“${wakeLabel(s, max - 2)}”`;

export class WakeRegistry {
  private readonly triggers = new Map<string, Trigger>();
  /** Arms in flight per session (counted against the limits until they resolve). */
  private readonly arming = new Map<string, number>();
  readonly delivery: WakeDelivery;
  private draining = false;
  private stopped = false;
  private started = false;
  private cancelPoll?: () => void;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: WakeRegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, Math.max(0, ms));
      (t as { unref?: () => void }).unref?.();
      return () => clearTimeout(t);
    });
    this.delivery = new WakeDelivery({
      sessions: deps.sessions,
      sessionState: (sid) => deps.sessionState(sid),
      ...(deps.followWake === undefined ? {} : { followWake: (sid, text) => deps.followWake!(sid, text) }),
      onDelivered: (_sid, ids) => deps.store.remove(ids),
      onDropped: (_sid, ids) => deps.store.remove(ids),
      draining: () => this.draining,
      schedule: this.schedule,
      ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
      ...(deps.retryDelaysMs === undefined ? {} : { retryDelaysMs: deps.retryDelaysMs }),
      ...(deps.tag === undefined ? {} : { tag: deps.tag }),
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      log: this.log,
    });
  }

  /** Is arming on now (`computerUse.enabled` and `computerUse.wakes`)? */
  enabled(): boolean {
    const s = this.deps.settings();
    return (s === null || s === undefined ? true : computerUseEnabledFrom(s)) && computerUseWakesFrom(s);
  }

  /** Arm one trigger. Throws an `AutomationFailure` with its one sentence, and arms nothing then. */
  async arm(input: WakeArmInput): Promise<ArmedWake> {
    if (this.stopped || this.draining) throw new AutomationFailure("HelperUnavailable", "Winter is shutting down — no wake trigger can be armed now");
    if (!this.enabled()) throw new AutomationFailure("NotAllowed", "wake triggers are turned off in Settings → Computer Use — ask the user to do the step and tell you, or wait with waitFor() in this call");
    const mine = this.countFor(input.sessionId) + (this.arming.get(input.sessionId) ?? 0);
    if (mine >= WAKE_LIMITS.perSession) {
      throw new AutomationFailure("TargetBusy", `this session already has ${WAKE_LIMITS.perSession} wake triggers armed — cancel one with wakes.cancel(id) (wakes.list() shows them) before arming another`);
    }
    const all = this.triggers.size + [...this.arming.values()].reduce((a, b) => a + b, 0);
    if (all >= WAKE_LIMITS.perDaemon) {
      throw new AutomationFailure("TargetBusy", `Winter already has ${WAKE_LIMITS.perDaemon} wake triggers armed across its sessions — cancel one of this session's with wakes.cancel(id), or try again later`);
    }
    const backend = this.deps.backends()[input.backend];
    if (backend === undefined) {
      throw new AutomationFailure("NotAllowed", input.backend === "tab"
        ? "this Winter cannot watch a browser tab for a wake trigger — ask the user to tell you when they are done"
        : "this Winter cannot watch an app for a wake trigger — ask the user to tell you when they are done");
    }
    const timeoutMs = Math.min(WAKE_LIMITS.maxTimeoutMs, Math.max(1_000, Math.floor(input.timeoutMs)));
    const wakeId = this.mintId();
    const armedAt = this.now();
    const expiresAt = armedAt + timeoutMs;
    this.arming.set(input.sessionId, (this.arming.get(input.sessionId) ?? 0) + 1);
    // A backend may report its one event before `arm` resolves: held, and handled once the trigger exists.
    let trigger: Trigger | undefined;
    const early: WakeBackendEvent[] = [];
    const onEvent = (e: WakeBackendEvent): void => {
      if (e === null || typeof e !== "object" || e.wakeId !== wakeId) return;
      if (trigger === undefined) { early.push(e); return; }
      this.backendEvent(trigger, e);
    };
    let armed: WakeArmed;
    try {
      armed = await backend.arm({ wakeId, sessionId: input.sessionId, targetId: input.targetId, condition: input.condition, expiresAt }, onEvent);
    } finally {
      const n = (this.arming.get(input.sessionId) ?? 1) - 1;
      if (n <= 0) this.arming.delete(input.sessionId); else this.arming.set(input.sessionId, n);
    }
    // Armed while the daemon began stopping, the setting turned off or the session went: given straight back.
    if (this.stopped || this.draining || !this.enabled() || this.deps.sessionState(input.sessionId) !== "live") {
      try { backend.disarm(wakeId); } catch { /* never throws by contract */ }
      throw new AutomationFailure(this.enabled() ? "HelperUnavailable" : "NotAllowed", this.enabled() ? "Winter is shutting down — the wake trigger was not kept" : "wake triggers were turned off — the trigger was not kept");
    }
    const labels = this.labelsFor(input.condition, armed);
    const t: Trigger = {
      wakeId, sessionId: input.sessionId, targetId: input.targetId, backend: input.backend, condition: input.condition,
      armedAt, expiresAt, notifyOnTimeout: input.notifyOnTimeout === true, ...labels,
      rebind: wakeLabel(armed?.rebind, 300),
      followed: this.deps.followedNow?.(input.sessionId) === true,
      ...(input.note === undefined || input.note.trim().length === 0 ? {} : { note: wakeLabel(input.note, WAKE_LIMITS.noteMaxChars) }),
      ...(input.audit === undefined ? {} : { audit: input.audit }),
      cancelTimer: () => {},
    };
    trigger = t;
    this.triggers.set(wakeId, t);
    t.cancelTimer = this.schedule(() => { if (this.triggers.get(wakeId) === t) this.end(t, "expired", { at: this.now() }); }, expiresAt - armedAt);
    this.deps.store.put(this.recordOf(t));
    this.safeAppend(t.sessionId, {
      type: "wake_armed", sessionId: t.sessionId, threadId: "main", wakeId, condition: t.condition.kind,
      targetLabel: t.targetLabel, ...(t.elementLabel === undefined ? {} : { elementLabel: t.elementLabel }), expiresAt,
    } as NewSessionEvent);
    this.ensurePoll();
    if (early.length > 0) { const first = early[0]!; queueMicrotask(() => { if (this.triggers.get(wakeId) === t) this.backendEvent(t, first); }); }
    const backendNote = wakeLabel(armed?.note, 300);
    return {
      wakeId, expiresAt, targetLabel: t.targetLabel, ...(t.elementLabel === undefined ? {} : { elementLabel: t.elementLabel }),
      ...(t.elementRole === undefined ? {} : { elementRole: t.elementRole }), rebind: t.rebind, ...(backendNote.length > 0 ? { backendNote } : {}),
    };
  }

  /** End one of the session's triggers, `cancelled` (no wake). False when it is not armed (ended, or not this session's). */
  cancel(sessionId: string, wakeId: string, by: "model" | "user"): boolean {
    const t = this.triggers.get(wakeId);
    if (t === undefined || t.sessionId !== sessionId) return false;
    this.end(t, "cancelled", { at: this.now(), by });
    return true;
  }

  /** The session's armed triggers (`wakes.list()`). */
  list(sessionId: string): WakeListRow[] {
    const now = this.now();
    return [...this.triggers.values()].filter((t) => t.sessionId === sessionId).map((t) => ({
      id: t.wakeId, target: t.targetLabel, condition: t.condition.kind,
      ...(t.elementLabel === undefined ? {} : { element: t.elementLabel }),
      expiresAt: t.expiresAt, expiresInMin: Math.max(0, Math.ceil((t.expiresAt - now) / 60_000)),
      ...(t.note === undefined ? {} : { note: t.note }),
    }));
  }

  /** How many triggers the session has armed (the session list's "waiting for you" mark). */
  countFor(sessionId: string): number {
    let n = 0;
    for (const t of this.triggers.values()) if (t.sessionId === sessionId) n++;
    return n;
  }

  get armedCount(): number { return this.triggers.size; }

  /** The session was archived or deleted: its triggers end `disabled` (no wake). */
  sessionEnded(sessionId: string): void {
    for (const t of [...this.triggers.values()]) if (t.sessionId === sessionId) this.end(t, "disabled", { at: this.now() });
  }

  /** `computerUse.wakes` / `.enabled` turned off: every armed trigger ends `disabled`. Cheap; called by the poll and
   *  at once by the app's own toggle. */
  checkSettings(): void {
    if (this.triggers.size === 0 || this.enabled()) return;
    for (const t of [...this.triggers.values()]) this.end(t, "disabled", { at: this.now() });
  }

  /** The helper's notifications and its loss, for the backends that need them (lane C's app backend). */
  handleNotification(n: HelperNotification): void {
    const b = this.deps.backends();
    for (const backend of [b.app, b.tab]) { try { backend?.handleNotification?.(n); } catch { /* a backend never breaks the helper's stream */ } }
  }

  helperDisconnected(): void {
    const b = this.deps.backends();
    for (const backend of [b.app, b.tab]) { try { backend?.helperDisconnected?.(); } catch { /* best effort */ } }
  }

  /**
   * The boot sweep (spine §5), once the session drivers exist: what the last daemon left in `wakes.json`. A trigger
   * still armed then ends `restart` and its session is woken once ("Winter restarted, so these waits ended"); one that
   * had already ended — but whose message never went out (a wake during the stop) — is delivered as what it was; one
   * past its expiry is dropped silently, or delivered as `expired` when it asked. Every record whose trigger was still
   * armed gets its `wake_ended` (the Mac's pill clears).
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    let records: WakeRecord[];
    try { records = this.deps.store.load(); } catch { return; }
    const now = this.now();
    const drop: string[] = [];
    for (const r of records) {
      if (this.deps.sessionState(r.sessionId) !== "live") { drop.push(r.wakeId); continue; }
      if (r.ended !== undefined) {
        this.delivery.enqueue(r.sessionId, this.newsOf(r, r.ended.outcome, r.ended.at, r.ended));
        continue;
      }
      if (r.expiresAt <= now) {
        this.safeAppend(r.sessionId, { type: "wake_ended", sessionId: r.sessionId, threadId: "main", wakeId: r.wakeId, reason: "expired", at: r.expiresAt } as NewSessionEvent);
        if (r.notifyOnTimeout === true) {
          this.deps.store.put({ ...r, ended: { outcome: "expired", at: r.expiresAt } });
          this.delivery.enqueue(r.sessionId, this.newsOf(r, "expired", r.expiresAt));
        } else drop.push(r.wakeId);
        continue;
      }
      this.safeAppend(r.sessionId, { type: "wake_ended", sessionId: r.sessionId, threadId: "main", wakeId: r.wakeId, reason: "restart", at: now } as NewSessionEvent);
      this.metricEnd(r.sessionId, r.kind, "restart", now - r.armedAt, undefined);
      this.deps.audit?.({ kind: "automation-wake", sessionId: r.sessionId, condition: r.kind, outcome: "restart" });
      this.delivery.enqueue(r.sessionId, this.newsOf(r, "restart", now));
    }
    if (drop.length > 0) this.deps.store.remove(drop);
  }

  /** Daemon stop, step one: nothing is delivered from now on (the records stay for the next boot). */
  beginShutdown(): void { this.draining = true; }

  /** Daemon stop: every backend lets go (no events, no `wake_ended` — the records in `wakes.json` are the next boot's
   *  `restart`), and no timer outlives it. */
  stop(): void {
    this.draining = true;
    this.stopped = true;
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    const b = this.deps.backends();
    for (const t of this.triggers.values()) {
      t.cancelTimer();
      try { b[t.backend]?.disarm(t.wakeId); } catch { /* never throws by contract */ }
    }
    this.triggers.clear();
    this.delivery.stop();
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────

  private mintId(): string {
    for (;;) {
      const id = `wk_${randomBytes(6).toString("hex")}`;
      if (!this.triggers.has(id) && this.deps.store.get(id) === undefined) return id;
    }
  }

  /** The labels the user and the model see. `elementLabel` is what the pill quotes: the element's name (quoted), or
   *  the condition's own text, URL or title (quoted) — never the model's note. */
  private labelsFor(c: WakeCondition, armed: WakeArmed): { targetLabel: string; elementLabel?: string; elementRole?: string } {
    const targetLabel = wakeLabel(armed?.targetLabel) || "the target";
    const name = wakeLabel(armed?.element?.name, WAKE_LABEL_MAX - 2);
    const role = wakeLabel(armed?.element?.role, 64);
    const fromElement = { ...(name.length > 0 ? { elementLabel: `“${name}”` } : {}), ...(role.length > 0 ? { elementRole: role } : {}) };
    switch (c.kind) {
      case "clicked": case "changed": return { targetLabel, ...fromElement };
      case "submitted": return { targetLabel, ...(c.ref === undefined ? {} : fromElement) };
      case "navigated": return { targetLabel, ...(c.url === undefined ? {} : { elementLabel: quoted(c.url) }) };
      case "appeared": return { targetLabel, elementLabel: quoted(c.text) };
      case "gone": return { targetLabel, ...(c.ref !== undefined ? fromElement : c.text !== undefined ? { elementLabel: quoted(c.text) } : {}) };
      case "titled": return { targetLabel, elementLabel: quoted(c.title) };
    }
  }

  private backendEvent(t: Trigger, e: WakeBackendEvent): void {
    if (this.triggers.get(t.wakeId) !== t) return;
    const at = typeof e.at === "number" && Number.isFinite(e.at) && e.at > 0 ? Math.floor(e.at) : this.now();
    if (e.outcome === "fired") this.end(t, "fired", { at, ...(typeof e.detail === "string" && e.detail.trim() ? { detail: wakeLabel(e.detail, 300) } : {}) });
    else if (e.outcome === "lost") this.end(t, "lost", { at, ...(typeof e.reason === "string" && e.reason.trim() ? { reason: wakeLabel(e.reason, 300) } : {}) });
  }

  private end(t: Trigger, reason: Exclude<WakeEndReason, "restart">, info: { at: number; detail?: string; reason?: string; by?: "model" | "user" }): void {
    if (this.triggers.get(t.wakeId) !== t) return;
    this.triggers.delete(t.wakeId);
    t.cancelTimer();
    // Idempotent and a no-op after the trigger's own event (the backend's contract).
    try { this.deps.backends()[t.backend]?.disarm(t.wakeId); } catch { /* never throws by contract */ }
    this.safeAppend(t.sessionId, { type: "wake_ended", sessionId: t.sessionId, threadId: "main", wakeId: t.wakeId, reason, at: info.at } as NewSessionEvent);
    this.metricEnd(t.sessionId, t.condition.kind, reason, info.at - t.armedAt, t.backend);
    this.deps.audit?.({
      kind: "automation-wake", sessionId: t.sessionId, ...(t.audit?.app === undefined ? {} : { app: t.audit.app }), ...(t.audit?.site === undefined ? {} : { site: t.audit.site }),
      condition: t.condition.kind, outcome: reason, ...(info.by === undefined ? {} : { by: info.by }),
    });
    const wakes = reason === "fired" || reason === "lost" || (reason === "expired" && t.notifyOnTimeout);
    if (!wakes) { this.deps.store.remove([t.wakeId]); this.stopPollIfIdle(); return; }
    const ended = { outcome: reason, at: info.at, ...(info.detail === undefined ? {} : { detail: info.detail }), ...(info.reason === undefined ? {} : { reason: info.reason }) };
    const record = this.recordOf(t);
    this.deps.store.put({ ...record, ended });
    this.delivery.enqueue(t.sessionId, this.newsOf(record, reason, info.at, ended));
    this.stopPollIfIdle();
  }

  private recordOf(t: Trigger): WakeRecord {
    return {
      sessionId: t.sessionId, wakeId: t.wakeId, kind: t.condition.kind, targetLabel: t.targetLabel,
      ...(t.elementLabel === undefined ? {} : { elementLabel: t.elementLabel }), ...(t.elementRole === undefined ? {} : { elementRole: t.elementRole }),
      armedAt: t.armedAt, expiresAt: t.expiresAt, ...(t.note === undefined ? {} : { note: t.note }),
      ...(t.notifyOnTimeout ? { notifyOnTimeout: true as const } : {}), ...(t.rebind.length > 0 ? { rebind: t.rebind } : {}),
      ...(t.followed ? { followed: true as const } : {}),
    };
  }

  private newsOf(r: WakeRecord, outcome: WakeNews["outcome"], at: number, ended?: { detail?: string; reason?: string }): WakeNews {
    return {
      wakeId: r.wakeId, outcome, at, armedAt: r.armedAt, kind: r.kind, targetLabel: r.targetLabel,
      ...(r.elementLabel === undefined ? {} : { elementLabel: r.elementLabel }), ...(r.elementRole === undefined ? {} : { elementRole: r.elementRole }),
      ...(ended?.detail === undefined ? {} : { detail: ended.detail }), ...(ended?.reason === undefined ? {} : { reason: ended.reason }),
      ...(r.note === undefined ? {} : { note: r.note }), ...(r.rebind === undefined ? {} : { rebind: r.rebind }),
      ...(r.followed === true ? { followed: true } : {}),
    };
  }

  private metricEnd(sessionId: string, kind: string, outcome: string, armedMs: number, backend: WakeBackendKind | undefined): void {
    this.deps.telemetry?.({
      ts: this.now(), sessionId, callId: "", primitive: "wake.end", ms: Math.max(0, Math.round(armedMs)), helperMs: 0,
      wake: { kind, ...(backend === undefined ? {} : { backend }), outcome, armedMs: Math.max(0, Math.round(armedMs)) },
    });
  }

  private ensurePoll(): void {
    if (this.cancelPoll !== undefined || this.stopped) return;
    const tick = (): void => {
      this.cancelPoll = undefined;
      this.checkSettings();
      if (this.triggers.size > 0 && !this.stopped) this.cancelPoll = this.schedule(tick, this.deps.pollMs ?? WAKE_SETTINGS_POLL_MS);
    };
    this.cancelPoll = this.schedule(tick, this.deps.pollMs ?? WAKE_SETTINGS_POLL_MS);
  }

  private stopPollIfIdle(): void {
    if (this.triggers.size > 0) return;
    this.cancelPoll?.();
    this.cancelPoll = undefined;
  }

  private safeAppend(sessionId: string, event: NewSessionEvent): void {
    try { this.deps.append(sessionId, event); } catch (err) {
      this.log(`computer-use: could not append ${event.type} to ${sessionId} (${err instanceof Error ? err.name : "error"})`);
    }
  }
}
