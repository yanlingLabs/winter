// P8b Task 16 — THE PER-SESSION DRIVER for a Winter session running on the Winter leg.
//
// One `WinterSession` per Winter session (`s_<hex>`), owning a sequence of INCARNATIONS: each is one
// spawned `winter` child (`runtime.sdk.query({ prompt: queue, options })`), one host prompt queue
// (P8b-6: the streaming prompt is the only thing that keeps a session reachable by messaging), one
// projector (P8b-14: the SDK→SessionEvent fold, keyed by the 8a generation the incarnation bumped),
// and one messaging attachment (Task 12). The driver is what the `session.*` RPC handlers in
// `ipc/server.ts` route to when the session's record says "winter".
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE STATE MACHINE (ruling P8b-24, corrected by measurement against `dist/winter` at v0.0.4)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
//   live       a child is running (an incarnation is open). Sends push into its queue.
//   resumable  no child; the backend transcript (if any) is on disk. The next `send`/`steer`/
//              delivery opens a NEW incarnation — `options.resume = backendSessionId` when the
//              transcript exists, a FRESH start under the SAME uuid when it does not (see below).
//   ended      the session cannot be resumed (the error class said the store is corrupt).
//
//   open()               resumable/new → live        (`open`, below)
//   iteration finally    live → resumable | ended    (`run`'s finally — the ONLY place state leaves live)
//   end()                live → (queue close, bounded wait, abort) → the finally above
//   idle timeout         live, no turn running, `winterIdleTimeoutSec` elapsed → end()
//
// THREE THINGS THE BRIEF ASSUMED THAT THE BINARY DOES NOT DO (measured 2026-09-11, recorded in the
// Task 16 report; every one of them shapes the code below):
//
//  1. **`interrupt()` does NOT end the child.** It ends the RUNNING TURN — the wire emits
//     `result/success` with `interrupted: true`, the projector maps it to `turn_completed(aborted)`
//     (never an `agent_error`) — and the child stays alive and pushable; repeated interrupts work;
//     with no turn running it is a no-op. So an interrupted session stays `live`. The digest's
//     "the generator's finally closes stdin and the child exits" describes an older runtime.
//  2. **No transcript exists until the first turn completes**, and `resume` on a transcript that
//     was never written hangs ~10 s and dies "before init". Whether to resume is therefore a
//     question the transcript answers (`deps.hasTranscript`, the SDK's own `getSessionInfo`), not
//     the record: a session that idled out before its first turn is leg=winter AND transcript-less,
//     and starts fresh under the same uuid.
//  3. **A live predecessor holds the transcript's `.lock`**, and a resume racing it dies before
//     init. `open()` therefore awaits the previous incarnation's `done` — state alone is not enough.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PUSHES (P8b-5 / P8b-38 / P8b-39) — every PUSH begins a turn; the session LOG is the queue
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `send(text)` appends `user_message` immediately (as `hub.send` does today). If no turn is running
// it calls `projector.beginTurn`, persists ITS batch (the `turn_started` — never one of the host's
// own) and pushes. If a turn IS running the text is HELD: its `user_message` is in the log and
// NOTHING else is — `beginTurn` runs only when the text is actually pushed (P8b-39), so a held
// message looks in the log exactly as a queued one does on the engine: a `user_message` with no
// turn until it runs. The host's `pending` list is a cache of that log, never the source of truth:
//
//   - after a normal `result` the next held text is pushed (and its turn begun) automatically;
//   - after an INTERRUPT the held texts are NOT auto-run — they stay in the log until the next
//     inbound action: a `send`, a `steer`, or a messaging delivery (the engine's own rule,
//     engine.ts `interrupt`: a queued `user_message` waits for the next user action);
//   - on resume (and so at boot, since a daemon resumes a session on its first RPC) `open()` asks
//     the log (`deps.unconsumed`: every host-appended main-thread `user_message` with no
//     `turn_started` after it) and re-pushes them in order — the first now, the rest one per
//     `result` — so a held send survives a restart with exactly ONE `turn_started`, appended when
//     it runs. Nothing is held only in memory.
//
// `steer(text)` appends, begins a turn, and pushes IMMEDIATELY. A delivery (`deliver`, the
// messaging push sink) is a steer with `clientName: "messaging"`. Task 11's STEER MEASUREMENT
// (P8b-38) is why a steer begins a turn too: a mid-turn push yields its OWN `result` on this wire,
// and a turn that was not begun has its terminal dropped.
//
// "A turn is running" is a HOST-SIDE count (`inFlight` = pushes − results), never the projector's
// `turnRunning`: `beginTurn` opens a projector turn before the push, so reading the projector after
// it would always say "running".
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// `end()` AND THE SHUTDOWN BUDGET (P8b-32)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `dispose()` wraps this session's `end()` in `SHUTDOWN_QUERY_GRACE_MS` (300 ms) and then closes
// the session store and `runtime-state.db`. An idle child ends ~12 ms after its queue closes; a
// child mid-turn never will, and `abort()` kills it ~50 ms later — so `end()` closes the queue,
// waits `endGraceMs` (120), aborts, and waits `endGraceMs` again: ≤ 240 ms, inside the 300. Every
// append the iteration's tail performs is guarded, because a closed store must never throw out of
// the driver. `end()` NEVER resolves with the session still `live`: a child that outlives the
// second wait is already aborted and its iteration will close its own books, but the session is
// `resumable` from the moment `end()` returns — the next `open()` awaits that iteration before it
// spawns (finding 3), and no push can reach the closed queue in between.
import type { Options, Query } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent, SessionEvent } from "@yanlinglabs/winter-protocol";
import { MAIN_THREAD, ProjectorRefusedError, classifyThrown, type ProjectedBatch, type Projector, type ProtocolSdkMessage } from "../projector";
import { PROJECTOR_PASSTHROUGH_CLIENT } from "../projector/index";
import { asInitFrame, asResultFrame } from "../projector/conversation";
import { ALLOWED_TRANSITIONS, type RuntimeSessionState } from "../runtime-state/records";
import type { WinterRuntimeSdk, SessionMode } from "./create";
import type { attachWinterSession, WinterSessionAttachHandle, WinterSessionAttachment } from "./messaging";
import { createHostPromptQueue, type HostPromptQueue } from "./prompt-queue";
import { permissionModeFor } from "./mode-options";
import type { SessionApprovalPolicy } from "../agent/gate";

export type WinterSessionState = "live" | "resumable" | "ended";

/** The pre-abort budget inside `end()`, spent TWICE (close-then-wait, abort-then-wait): 2 × 120 =
 *  240 ms < `SHUTDOWN_QUERY_GRACE_MS` (300), so `end()` resolves before `dispose()`'s own deadline
 *  aborts the same controller a second time. `create.test.ts` pins the outer number; this one is
 *  pinned beside it in `winter-session.test.ts`. */
export const WINTER_SESSION_END_GRACE_MS = 120;

/** What one incarnation is told about itself. `generation` is the 8a record's, ALREADY BUMPED
 *  (a projector built on the previous generation replays its first frames into
 *  `already-committed` and projects nothing — projector `ProjectorDeps.generation`'s own doc). */
export interface WinterIncarnation {
  generation: number;
  /** `true` ⇒ `Options.resume = backendSessionId`; `false` ⇒ `Options.sessionId = backendSessionId`. */
  resume: boolean;
  /** The incarnation's own `AbortController` — the one its `Options` carry and `trackQuery` gets. */
  abort: AbortController;
}

/** What the options thunk is handed: the incarnation BEFORE its generation exists. The 8a
 *  generation is bumped only after the options were built (a refused executable must not leave a
 *  generation row with no child behind it), so the thunk cannot see it — and needs nothing but
 *  the resume decision and the abort controller. */
export type WinterIncarnationShape = Pick<WinterIncarnation, "resume" | "abort">;

/** The last `system/init` the child reported — the id proves a resume landed on the same backend
 *  session, and `tools` is the integration tripwire's subject (Task 16's e2e). */
export interface WinterInitFacts {
  sessionId?: string;
  model?: string;
  tools: string[];
}

/** The structural subset of 8a's `RuntimeSessionRecords` the driver writes. Optional as a whole
 *  (the record is the daemon's; a unit test hands in a counting fake or nothing). */
export interface WinterSessionRecords {
  bumpGeneration(winterSessionId: string, input: { runtimeKind: "winter-agent"; backendSessionId: string }): { generation: number };
  endGeneration(winterSessionId: string, generation: number, endReason: string): void;
  transition(winterSessionId: string, to: RuntimeSessionState): unknown;
  get(winterSessionId: string): { state: RuntimeSessionState; generation: number } | undefined;
}

export interface WinterSessionDeps {
  /** Winter's own session id — what every persisted event is stamped with. */
  sessionId: string;
  /** The BACKEND uuid allocated by the creation transaction: `Options.sessionId` on a fresh start,
   *  `Options.resume` afterwards, the messaging address, the name of the child's transcript. */
  backendSessionId: string;
  mode: SessionMode;
  runtime: WinterRuntimeSdk;
  /** `Options` for ONE incarnation. Re-reads the session's LIVE facts (model, effort, policy) and
   *  re-resolves the spawn hook, so a `session.setModel` while resumable is honoured on resume. May
   *  throw a typed refusal (an executable that has gone away) — `open()` surfaces it. */
  options: (incarnation: WinterIncarnationShape) => Options | Promise<Options>;
  /**
   * WS-19 (W19-7, fix round 2): a PRE-TURN gate, run before anything a turn does — before `open()`
   * spawns an incarnation and before the `user_message` is appended — so a refusal leaves no orphan
   * log entry and no child. May throw a typed refusal (`WinterLegRefusal`); `send`/`steer` surface
   * it to their caller unchanged.
   *
   * It lives HERE rather than in the options thunk because `options` runs at every `open()`,
   * including the one `session.create`/`session.dispatch` do eagerly — and a session with no
   * credential must still be CREATABLE (a fresh install has no key yet, and the Mac app dispatches a
   * session at launch). What must not happen is a TURN against a provider Winter has no credential
   * for, and this is the one place every turn passes.
   *
   * `deliver` is deliberately NOT gated: it never opens an incarnation of its own (a delivery with
   * no live child is HELD, not pushed), so it can never be what spawns one.
   */
  beforeTurn?: () => Promise<void>;
  /** A projector for ONE incarnation, built on ITS generation. */
  projector: (incarnation: WinterIncarnation) => Projector;
  /** A fresh queue per incarnation (a closed queue cannot be reused). */
  queue?: () => HostPromptQueue;
  /** Persist one event and broadcast it (the hub's `append`). Returns the stamped event. */
  append: (event: NewSessionEvent) => SessionEvent;
  /** Broadcast one TRANSIENT (the hub's `broadcastTransient`). Never persisted. */
  broadcast: (event: NewSessionEvent) => void;
  messaging: {
    /** Task 12's door. */
    attach: typeof attachWinterSession;
    /** Attachment facts beyond the pinned four, read at attach time (title, cwd, selection…). */
    facts?: () => Partial<Pick<WinterSessionAttachment, "displayName" | "title" | "cwd" | "selection">>;
  };
  records?: WinterSessionRecords;
  /** Does the backend transcript exist? Decides `resume` vs a fresh start under the same uuid. */
  hasTranscript: () => boolean | Promise<boolean>;
  /** P8b-39: the LOG's unconsumed user texts — `unconsumedUserMessages(store.read(sessionId))` —
   *  re-pushed in order by every `open()`. Absent, the driver falls back to what it held in memory
   *  (a unit harness with no log). */
  unconsumed?: () => string[];
  /** HOT: `winterOptionsFromSettings(settings()).idleTimeoutSec * 1000`, read when the timer is armed. */
  idleTimeoutMs: () => number;
  /** Test seam for `WINTER_SESSION_END_GRACE_MS`. */
  endGraceMs?: number;
  /** The idle timer's clock (a test hands in a fake it fires by hand). Default: `setTimeout`, unref'd. */
  timers?: WinterTimers;
  /** Task 17 (P8b-15): the persisted child roster. The projector opens a child thread with the
   *  spawning `tool_use.id` (`thread_started`), the child's own frames follow on that thread, and
   *  the spawning call's `tool_result` closes it (`thread_completed`); the driver relays the three
   *  moments so `runtime_children` and the progress watchdog see every Winter child. */
  children?: WinterChildrenSink;
  /** Fired when the incarnation goes idle after a turn (the activity enforcement's re-check hook). */
  onTurnSettled?: () => void;
  log?: (line: string) => void;
}

export interface WinterChildrenSink {
  started(child: { threadId: string; agentType: string; prompt: string; description?: string }): void;
  /** A frame on the child's thread — the resettable progress window's feed (no wall clock). */
  progress(threadId: string): void;
  completed(threadId: string, stopReason: string): void;
}

export interface WinterTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: WinterTimers = {
  set(fn, ms) { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/**
 * P8b-39 / P8b-40 — the log as the durable queue. Every host-appended main-thread `user_message` is
 * a text the host owes the child; every main-thread `turn_started` is one it has pushed (the
 * projector's `beginTurn` is the ONLY producer, and the driver calls it exactly once per push, at
 * the push — `beginAndPush` appends the `turn_started` RIGHT AFTER the message it runs, except for
 * a held send released later, whose `turn_started` lands after younger messages).
 *
 * PAIRING IS BY ADJACENCY, NEVER FIFO (P8b-40): a `turn_started` pairs with the NEAREST PRECEDING
 * unpaired `user_message`. A steer or a delivery pushes immediately while an older send is still
 * held, so its `turn_started` must claim ITS OWN message, not the oldest debt — a FIFO scan would
 * re-push the text that already ran and silently drop the held one (Task 16 re-review N1). A
 * message is owed iff no `turn_started` pairs with it; the owed texts come back in log order.
 *
 * A push whose `turn_started` never got appended (a crash between the push and the append) is
 * therefore RE-PUSHED on resume: the persisted contract is the pair, and a push without its half
 * never reached it. The projector's own pass-through `user_message` (`clientName: "winter"`, a
 * `user` frame the host never pushed) is not a debt.
 */
export function unconsumedUserMessages(events: readonly SessionEvent[]): string[] {
  const owed: string[] = [];
  for (const e of events) {
    if ((e as { threadId?: string }).threadId !== undefined && (e as { threadId?: string }).threadId !== MAIN_THREAD) continue;
    if (e.type === "user_message") {
      if ((e as { clientName?: string }).clientName === PROJECTOR_PASSTHROUGH_CLIENT) continue;
      owed.push((e as { text: string }).text);
    } else if (e.type === "turn_started") {
      owed.pop();   // the nearest preceding unpaired message is this turn's
    }
  }
  return owed;
}

export interface WinterSession {
  readonly sessionId: string;
  readonly backendSessionId: string;
  readonly mode: SessionMode;
  readonly state: WinterSessionState;
  /** The 8a generation of the current (or last) incarnation; 0 before the first opens. */
  readonly generation: number;
  /** Whether the current (or last) incarnation opened under `Options.resume` (true) or started
   *  fresh under the same uuid (false). The resume proof's subject. */
  readonly resumed: boolean;
  /** The live `Query`, or undefined while `resumable`/`ended`. */
  readonly query: Query | undefined;
  readonly init: WinterInitFacts | undefined;
  /** A host-side fact: pushes minus results, for the current incarnation. */
  readonly turnRunning: boolean;
  /** When the running turn's first push happened (epoch ms); undefined while idle. */
  readonly turnStartedAt: number | undefined;
  /** Resolves when the CURRENT incarnation's iteration has returned (and its teardown ran).
   *  Already resolved while `resumable`/`ended`. */
  readonly done: Promise<void>;
  /** Texts held while a turn ran (P8b-5) — a cache of the log's unconsumed `user_message`s
   *  (P8b-39), pushed one per `result`, or on the next `send`/`steer` after an interrupt. */
  readonly pendingSends: readonly string[];
  /** Deliveries that reached the push sink while `resumable` (P8b-24), pushed first on resume. */
  readonly heldDeliveries: readonly string[];
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
  steer(text: string, clientName?: string): Promise<{ seq: number; injected: boolean }>;
  interrupt(): Promise<{ wasRunning: boolean }>;
  /** Winter's `Query` has no compaction control at 0.0.4 — a typed `WinterLegUnsupported`, never a silent no-op. */
  compact(): Promise<never>;
  setModel(model?: string): Promise<void>;
  /** Task 17 Step 0(b): `session.setPolicy` reaches a LIVE child as `Query.setPermissionMode`
   *  (the 1:1 map of P8b-7); the bridge's policy getter is live already, and a resumable session
   *  re-reads the stored policy when it reopens. */
  setPolicy(policy: SessionApprovalPolicy): Promise<void>;
  /** Close the queue, wait, abort stragglers; `resumable` afterwards. Idempotent; never rejects. */
  end(): Promise<void>;
  /** The messaging push sink: a delivered envelope becomes this session's next user turn. */
  deliver(text: string): void;
  /** Open an incarnation if none is live (the creation transaction's start; `send`/`steer`/`deliver`
   *  call it implicitly). Rejects with the options thunk's typed refusal when the child cannot be
   *  spawned, and with `WinterSessionEnded` when the session can never run again. */
  open(): Promise<void>;
  /** Resolves when no turn is in flight on the current incarnation (at once while idle, resumable
   *  or ended; when the incarnation ends with a turn open, at that end). A headless caller's
   *  "run one turn" = `send` then `idle`. */
  idle(): Promise<void>;
}

/** A driver operation the Winter leg cannot perform. Carried to the RPC layer as `data.code`. */
export class WinterLegUnsupported extends Error {
  readonly code = "not_supported_on_winter_leg" as const;
  constructor(what: string) {
    super(`${what} is not supported on the Winter leg (SDK 0.0.4 carry: Winter's Query has no compaction control)`);
    this.name = "WinterLegUnsupported";
  }
}

/** A push to a session that can never run again. */
export class WinterSessionEnded extends Error {
  readonly code = "winter_session_ended" as const;
  constructor(sessionId: string, reason: string) {
    super(`session ${sessionId} has ended on the Winter leg and cannot be resumed: ${reason}`);
    this.name = "WinterSessionEnded";
  }
}

interface Incarnation extends WinterIncarnation {
  queue: HostPromptQueue;
  projector: Projector;
  query: Query;
  done: Promise<void>;
  attachment: WinterSessionAttachHandle | undefined;
  /** Frames seen — a child that never reached init is a spawn failure, not a turn failure. */
  sawInit: boolean;
}

const sleep = (ms: number): Promise<"timeout"> => new Promise((r) => { const t = setTimeout(() => r("timeout"), ms); (t as { unref?: () => void }).unref?.(); });

/** The error kinds a DELIBERATE end produces with no turn in flight (measured): a zero-turn session
 *  whose queue closes exits "without a terminal result" (`ProcessError`), and an aborted one throws
 *  `AbortError`. Neither is a failure of anything. */
const isExpectedEndError = (err: unknown): boolean => {
  const name = err instanceof Error ? err.name : "";
  return name === "ProcessError" || name === "AbortError" || name === "CLIConnectionError";
};

export function startWinterSession(deps: WinterSessionDeps): WinterSession {
  return new WinterSessionImpl(deps);
}

class WinterSessionImpl implements WinterSession {
  readonly sessionId: string;
  readonly backendSessionId: string;
  readonly mode: SessionMode;
  private stateValue: WinterSessionState = "resumable";
  private inc: Incarnation | undefined;
  private lastDone: Promise<void> = Promise.resolve();
  private gen = 0;
  private resumedValue = false;
  private initFacts: WinterInitFacts | undefined;
  private inFlight = 0;
  private ending = false;
  private endingPromise: Promise<void> | undefined;
  private idleTimer: unknown;
  private readonly timers: WinterTimers;
  private readonly pending: string[] = [];
  /** Set by an interrupt: the held texts wait for the next `send`/`steer` instead of the next
   *  `result` (engine parity). Cleared by those two doors and by every `open()`. */
  private drainPaused = false;
  private readonly held: string[] = [];
  private endedReason: string | undefined;
  /** The open() in flight, so two concurrent sends resume ONE child, not two. */
  private opening: Promise<void> | undefined;
  private idleWaiters: Array<() => void> = [];
  private turnStart: number | undefined;

  constructor(private readonly deps: WinterSessionDeps) {
    this.sessionId = deps.sessionId;
    this.backendSessionId = deps.backendSessionId;
    this.mode = deps.mode;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  get state(): WinterSessionState { return this.stateValue; }
  get generation(): number { return this.gen; }
  get resumed(): boolean { return this.resumedValue; }
  get query(): Query | undefined { return this.inc?.query; }
  get init(): WinterInitFacts | undefined { return this.initFacts; }
  get turnRunning(): boolean { return this.inFlight > 0; }
  get turnStartedAt(): number | undefined { return this.inFlight > 0 ? this.turnStart : undefined; }
  get done(): Promise<void> { return this.inc?.done ?? this.lastDone; }
  get pendingSends(): readonly string[] { return this.pending; }
  get heldDeliveries(): readonly string[] { return this.held; }

  // ── the doors ──────────────────────────────────────────────────────────────────────────────

  async send(text: string, clientName = "session"): Promise<{ seq: number; queued: boolean }> {
    this.assertNotEnded();
    // WS-19 (W19-7): the pre-turn gate, BEFORE the open and before the append — a refusal here
    // leaves the session exactly as it was, with no child and no orphan `user_message`.
    await this.deps.beforeTurn?.();
    // Open FIRST: a refused open (the binary is gone) then leaves no orphan `user_message`, and a
    // delivery held while resumable is appended by `open()` BEFORE this text — chronological.
    await this.open();
    this.drainPaused = false;
    if (this.inFlight === 0 && this.pending.length > 0) {
      // Idle with texts still owed (an interrupt paused the drain): the log's order rules — the
      // oldest runs now (its `turn_started` lands BEFORE this text's `user_message`, so a reader
      // of the log pairs them the way they ran) and this one waits its turn.
      this.beginAndPush(this.pending.shift()!, this.inc!);
    }
    const seq = this.appendUser(text, clientName);
    if (this.inFlight > 0) {
      // P8b-5/39: held until the running turn's `result` arrives. Its `user_message` is in the log;
      // its turn is begun when it is pushed, not now.
      this.pending.push(text);
      return { seq, queued: true };
    }
    this.beginAndPush(text, this.inc!);
    return { seq, queued: false };
  }

  async steer(text: string, clientName = "steer"): Promise<{ seq: number; injected: boolean }> {
    this.assertNotEnded();
    await this.deps.beforeTurn?.();
    await this.open();
    const seq = this.appendUser(text, clientName);
    const wasRunning = this.inFlight > 0;
    this.drainPaused = false;
    // P8b-38: a steered-in message yields its OWN result on this wire, so it is a begun turn too.
    this.beginAndPush(text, this.inc!);
    return { seq, injected: wasRunning };
  }

  deliver(text: string): void {
    if (this.stateValue === "ended") {
      this.log(`a delivery reached ${this.sessionId} after it ended — dropped`);
      return;
    }
    if (this.stateValue !== "live" || this.inc === undefined || this.ending || this.inc.queue.closed) {
      // P8b-24: a delivery that reached the sink was already receipted by the router; holding it
      // host-side (rather than throwing, which the wrapper would report as `delivery_uncertain`)
      // is what avoids a re-delivery. Pushed first on resume. The ENDING window counts too (re-review
      // N2): the queue is already closed while the state is still `live`, and a push would throw
      // out of the sink after an orphan `user_message`/`turn_started` pair had been appended.
      this.held.push(text);
      return;
    }
    // Step 0(c): a delivery is the next INBOUND action too — it re-arms the post-interrupt drain,
    // so the texts held before the interrupt run after this one's result (P8b-39).
    this.drainPaused = false;
    this.appendUser(text, "messaging");
    this.beginAndPush(text, this.inc);
  }

  async interrupt(): Promise<{ wasRunning: boolean }> {
    const inc = this.inc;
    if (this.stateValue !== "live" || inc === undefined || this.inFlight === 0) return { wasRunning: false };
    // Engine parity: whatever was held stays in the log until the next `send`/`steer` — the
    // interrupted `result` must not start it. Set BEFORE the interrupt so its result sees it.
    this.drainPaused = true;
    try {
      await inc.query.interrupt();
    } catch (err) {
      this.log(`interrupt failed for ${this.sessionId}: ${err instanceof Error ? err.name : "unknown"}`);
    }
    return { wasRunning: true };
  }

  compact(): Promise<never> {
    return Promise.reject(new WinterLegUnsupported("session.compact"));
  }

  idle(): Promise<void> {
    if (this.inFlight === 0 || this.stateValue !== "live") return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }

  private settleIdle(): void {
    for (const w of this.idleWaiters.splice(0)) w();
    try { this.deps.onTurnSettled?.(); } catch (err) { this.log(`turn-settled hook failed for ${this.sessionId}: ${err instanceof Error ? err.name : "unknown"}`); }
  }

  async setModel(model?: string): Promise<void> {
    // A resumable session re-reads its model from the store when it reopens (`deps.options`), so
    // only a live child needs telling.
    if (this.stateValue === "live" && this.inc !== undefined) await this.inc.query.setModel(model);
  }

  async setPolicy(policy: SessionApprovalPolicy): Promise<void> {
    if (this.stateValue === "live" && this.inc !== undefined) await this.inc.query.setPermissionMode(permissionModeFor(policy));
  }

  end(): Promise<void> {
    if (this.endingPromise !== undefined) return this.endingPromise;
    const inc = this.inc;
    if (this.stateValue !== "live" || inc === undefined) return this.done;
    this.ending = true;
    this.clearIdleTimer();
    const grace = this.deps.endGraceMs ?? WINTER_SESSION_END_GRACE_MS;
    this.endingPromise = (async () => {
      try {
        try { inc.queue.close(); } catch { /* already closed */ }
        // An idle child EOFs its stdout microseconds after `end_input`; a child mid-turn never does.
        if ((await Promise.race([inc.done.then(() => "done" as const), sleep(grace)])) === "done") return;
        try { inc.abort.abort(); } catch { /* an already-aborted controller is the outcome we wanted */ }
        if ((await Promise.race([inc.done.then(() => "done" as const), sleep(grace)])) === "done") return;
        // The child outlived the abort by more than the grace (measured ~50 ms; this is the tail).
        // It IS aborted and its iteration WILL close its books; the session is `resumable` NOW, so
        // nothing can push into the closed queue meanwhile — the next `open()` awaits `lastDone`.
        this.log(`the winter child for ${this.sessionId} outlived abort by ${grace} ms — resumable now, its iteration closes later`);
        if (this.inc === inc) { this.inc = undefined; this.stateValue = "resumable"; }
      } finally {
        this.endingPromise = undefined;
      }
    })();
    return this.endingPromise;
  }

  // ── incarnations ───────────────────────────────────────────────────────────────────────────

  /**
   * Open an incarnation if none is live. Awaits a live predecessor's `done` first (finding 3),
   * decides resume-vs-fresh from the transcript (finding 2), bumps the 8a generation, builds the
   * options and projector for THIS incarnation, and replays what was held: pending sends first
   * (their turns are already begun and logged — only the push was waiting), then deliveries that
   * arrived while resumable (appended and begun now).
   */
  async open(): Promise<void> {
    // An incarnation that is ENDING is not one to push into: fall through and await its `done`.
    if (this.stateValue === "live" && this.inc !== undefined && !this.ending) return;
    if (this.opening !== undefined) return this.opening;
    this.opening = (async () => {
      this.assertNotEnded();
      await this.lastDone;
      // WS-19 (review N2): A REPLAY IS A TURN, so it passes the same gate `send`/`steer` do.
      //
      // `open()` re-pushes what the log still OWES (`deps.unconsumed`) and any delivery HELD while
      // the session was resumable — real turns, on a child this call is about to spawn. `send` gates
      // itself before calling `open()`, but this path is reached with the driver table EMPTY (a
      // daemon restart, an idle reap, or the credential eviction `credential.set`/`remove` now
      // performs), which is exactly the window in which a credential can have changed underneath.
      // Without this, an owed text ran ungated against a provider whose key had been removed, and
      // only the NEXT text was refused.
      //
      // Nothing is owed on a fresh `create()`, so this costs that path nothing.
      const owedAtOpen = this.deps.unconsumed !== undefined ? this.deps.unconsumed() : this.pending;
      if (owedAtOpen.length + this.held.length > 0) await this.deps.beforeTurn?.();
      const abort = new AbortController();
      const resume = await this.deps.hasTranscript();
      // Options FIRST: a refused executable throws here and leaves NO generation row behind it.
      const options = await this.deps.options({ resume, abort });
      const generation = this.deps.records?.bumpGeneration(this.sessionId, { runtimeKind: "winter-agent", backendSessionId: this.backendSessionId }).generation ?? this.gen + 1;
      const shape: WinterIncarnation = { generation, resume, abort };
      const queue = (this.deps.queue ?? createHostPromptQueue)();
      const projector = this.deps.projector(shape);
      const query = this.deps.runtime.sdk.query({ prompt: queue, options });
      const inc: Incarnation = { ...shape, queue, projector, query, attachment: undefined, sawInit: false, done: Promise.resolve() };
      this.inc = inc;
      this.gen = generation;
      this.resumedValue = resume;
      this.ending = false;
      this.drainPaused = false;
      this.inFlight = 0;
      this.stateValue = "live";
      this.recordState(resume ? "running" : "idle");
      // Tracked BEFORE the iteration starts, so a shutdown that lands between the spawn and the
      // first frame still ends this child (`end` must be idempotent: it is).
      this.deps.runtime.trackQuery(this.sessionId, abort, () => this.end());
      inc.done = this.run(inc);
      this.lastDone = inc.done;
      // Replay (P8b-39): what the LOG says is still owed, in its order — the first is pushed now
      // (`deps.unconsumed` reads the whole session log: O(log) per RESUME, never per push) —
      // (its `turn_started` appended now, the only one it will ever get), the rest wait one per
      // `result` (P8b-5). The in-memory list is only a cache of the same facts and is discarded.
      const cached = this.pending.splice(0);
      const owed = this.deps.unconsumed !== undefined ? this.deps.unconsumed() : cached;
      if (owed.length > 0) {
        this.beginAndPush(owed[0]!, inc);
        this.pending.push(...owed.slice(1));
      }
      // Deliveries that arrived while resumable: appended and begun now, after the owed texts
      // (they are younger than every one of them — `send` cannot append while resumable).
      for (const text of this.held.splice(0)) {
        this.appendUser(text, "messaging");
        this.beginAndPush(text, inc);
      }
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async run(inc: Incarnation): Promise<void> {
    let ended: "ended" | undefined;
    try {
      for await (const raw of inc.query) {
        const msg = raw as unknown as ProtocolSdkMessage;
        const init = asInitFrame(msg);
        if (init !== undefined) {
          inc.sawInit = true;
          this.initFacts = {
            ...(typeof init.session_id === "string" ? { sessionId: init.session_id } : {}),
            ...(typeof init.model === "string" ? { model: init.model } : {}),
            tools: Array.isArray(init.tools) ? init.tools.filter((t): t is string => typeof t === "string") : [],
          };
          this.attachMessaging(inc);
          if (this.inFlight === 0) this.armIdleTimer();
        }
        let batch: ProjectedBatch;
        try {
          batch = inc.projector.accept(msg);
        } catch (err) {
          if (err instanceof ProjectorRefusedError || (err as { code?: unknown })?.code === "projector_refused") {
            // Typed, never a crash: the refusal is a bookkeeping conflict only 8a's recovery can
            // settle. Say so in the log, end this incarnation (`resumable`), and let the next open
            // — which runs on a fresh generation — start clean.
            this.safeAppend({ type: "agent_error", sessionId: this.sessionId, threadId: MAIN_THREAD, message: (err as Error).message, code: "projector_refused" });
            void this.end();
            continue;
          }
          throw err;
        }
        this.emit(batch);
        if (asResultFrame(msg) !== undefined) this.onResult(inc);
      }
    } catch (err) {
      if (this.ending && this.inFlight === 0 && isExpectedEndError(err)) {
        // A deliberate end with nothing running: the child left exactly as asked.
      } else if (!inc.sawInit && isExpectedEndError(err)) {
        // The child never reached init (a bad resume, a spawn refused before the first frame). No
        // turn can be open, so nothing is owed to the projector; the log carries the class.
        this.log(`the winter child for ${this.sessionId} exited before init (${(err as Error).name})`);
        if (this.inFlight > 0) this.emit(inc.projector.acceptError(err));
      } else {
        this.emit(inc.projector.acceptError(err));
        const cls = classifyThrown(err);
        if (cls.code === "store_error") { ended = "ended"; this.endedReason = cls.message; }
        if (!this.ending) this.log(`the winter child for ${this.sessionId} stopped: ${cls.code}`);
      }
    } finally {
      try { inc.projector.flush(); } catch { /* the checkpoint store may already be closed */ }
      this.clearIdleTimer();
      try { inc.attachment?.detach(); } catch { /* detach never throws by contract; belt only */ }
      inc.attachment = undefined;
      this.deps.runtime.untrack(this.sessionId);
      // A held text never pushed is still owed — its `user_message` is in the log with no turn, and
      // the next `open()` re-reads it from there (P8b-39).
      this.inFlight = 0;
      this.settleIdle();
      try { this.deps.records?.endGeneration(this.sessionId, inc.generation, ended ?? (this.ending ? "ended" : "exited")); } catch { /* the db may be closed at shutdown */ }
      this.recordState(ended === "ended" ? "failed" : "exited");
      if (this.inc === inc) this.inc = undefined;
      this.stateValue = ended ?? "resumable";
    }
  }

  private onResult(inc: Incarnation): void {
    if (this.inFlight > 0) this.inFlight--;
    // An ending incarnation's queue is closed: a push would throw inside the iteration and cost
    // the held text a spurious `agent_error`. It stays owed (it is in the log) for the next one.
    if (this.ending || inc.queue.closed) return;
    if (!this.drainPaused) {
      // P8b-5: one held text per result; its turn is begun as it is pushed (P8b-39).
      const next = this.pending.shift();
      if (next !== undefined) { this.beginAndPush(next, inc); return; }
    }
    if (this.inFlight === 0) {
      this.recordState("idle");
      inc.attachment?.refresh();
      this.armIdleTimer();
      this.settleIdle();
    }
  }

  // ── the small pieces ───────────────────────────────────────────────────────────────────────

  /** THE one push door: `beginTurn`'s batch appended (its `turn_started`), then the push. */
  private beginAndPush(text: string, inc: Incarnation): void {
    this.emit(inc.projector.beginTurn({ text }));
    this.push(text, inc);
  }

  private push(text: string, inc: Incarnation | undefined = this.inc): void {
    if (inc === undefined) throw new Error(`no live winter incarnation for ${this.sessionId}`);
    inc.queue.push(text);
    if (this.inFlight === 0) this.turnStart = Date.now();
    this.inFlight++;
    this.clearIdleTimer();
    this.recordState("running");
    inc.attachment?.refresh();
  }

  private appendUser(text: string, clientName: string): number {
    return this.deps.append({ type: "user_message", sessionId: this.sessionId, threadId: MAIN_THREAD, text, clientName }).seq;
  }

  private emit(batch: ProjectedBatch): void {
    for (const e of batch.persist) {
      this.safeAppend(e);
      this.relayChild(e);
    }
    for (const e of batch.broadcast) {
      try { this.deps.broadcast(e); } catch (err) { this.log(`broadcast failed for ${this.sessionId}: ${err instanceof Error ? err.name : "unknown"}`); }
      // Fix wave (review F10): a TRANSIENT frame on a child's thread — an `assistant_delta` — is
      // progress too. The roster's stall window was reset only by PERSISTED child events, so a
      // child streaming a long answer with no tool call past the window was killed as "stalled";
      // the engine's window was reset by every provider frame. Deltas feed it now.
      this.relayChild(e);
    }
  }

  /** The child roster's three moments, read off the persisted events — and `progress` off the
   *  broadcast ones too (never thrown out of the iteration). */
  private relayChild(e: NewSessionEvent): void {
    const sink = this.deps.children;
    if (sink === undefined) return;
    const threadId = (e as { threadId?: string }).threadId;
    if (threadId === undefined || threadId === MAIN_THREAD) return;
    try {
      if (e.type === "thread_started") {
        const t = e as { threadId: string; agentType: string; prompt: string; description?: string };
        sink.started({ threadId: t.threadId, agentType: t.agentType, prompt: t.prompt, ...(t.description === undefined ? {} : { description: t.description }) });
      } else if (e.type === "thread_completed") {
        sink.completed(threadId, (e as { stopReason: string }).stopReason);
      } else {
        sink.progress(threadId);
      }
    } catch (err) {
      this.log(`child roster relay failed for ${this.sessionId} (${e.type}): ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  private safeAppend(e: NewSessionEvent): void {
    try { this.deps.append(e); } catch (err) {
      // A closed store at shutdown, or a session deleted underneath a draining child. The frame is
      // lost to the product log and the log line says so; the driver never throws for it.
      // ⚠️ With the log as the queue (P8b-39/40) a LOST `turn_started` is not only a rendering gap:
      // its `user_message` stays unpaired, so the next resume re-pushes a text the child already
      // ran — one duplicated turn. Narrow (a store that fails mid-turn) and deliberately left as
      // the lesser cost; do not widen this swallow.
      this.log(`append failed for ${this.sessionId} (${e.type}): ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  private attachMessaging(inc: Incarnation): void {
    if (inc.attachment !== undefined) return;
    try {
      inc.attachment = this.deps.messaging.attach(this.deps.runtime, {
        sessionId: this.sessionId,
        backendSessionId: this.backendSessionId,
        query: inc.query,
        push: (text) => this.deliver(text),
        mode: this.mode,
        generation: inc.generation,
        status: () => (this.inFlight > 0 ? "running" : "idle"),
        log: (line) => this.log(line),
        ...(this.deps.messaging.facts?.() ?? {}),
      });
    } catch (err) {
      this.log(`messaging attach failed for ${this.sessionId}: ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.stateValue !== "live" || this.ending) return;
    const ms = this.deps.idleTimeoutMs();
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.idleTimer = this.timers.set(() => {
      this.idleTimer = undefined;
      if (this.stateValue === "live" && this.inFlight === 0 && !this.ending) {
        this.log(`session ${this.sessionId} idle for ${ms} ms — ending its winter child (resumable)`);
        void this.end();
      }
    }, ms);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) { this.timers.clear(this.idleTimer); this.idleTimer = undefined; }
  }

  /** Mirror the driver's state onto the 8a record, WITHOUT ever throwing: only a transition the
   *  state machine allows is attempted, and a store that will not answer costs the mirror alone. */
  private recordState(to: RuntimeSessionState): void {
    const records = this.deps.records;
    if (records === undefined) return;
    try {
      const current = records.get(this.sessionId)?.state;
      if (current === undefined || current === to) return;
      if (!ALLOWED_TRANSITIONS[current].includes(to)) return;
      records.transition(this.sessionId, to);
    } catch (err) {
      this.log(`record transition ${to} failed for ${this.sessionId}: ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  private assertNotEnded(): void {
    if (this.stateValue === "ended") throw new WinterSessionEnded(this.sessionId, this.endedReason ?? "the backend store refused it");
  }

  private log(line: string): void { this.deps.log?.(line); }
}
