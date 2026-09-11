// P8b Task 16 — THE PER-SESSION DRIVER for a Norma session running on the Winter leg.
//
// One `WinterSession` per Norma session (`s_<hex>`), owning a sequence of INCARNATIONS: each is one
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
// PUSHES (P8b-5 / P8b-38) — every push begins a turn
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `send(text)` appends `user_message`, calls `projector.beginTurn` and persists ITS batch (the
// `turn_started` — never one of the host's own), then pushes if no turn is running, else HOLDS the
// text host-side and pushes it when the current `result` arrives (queued to the next turn, as the
// engine does today). `steer(text)` appends, begins a turn, and pushes IMMEDIATELY. A delivery
// (`deliver`, the messaging push sink) is a steer with `clientName: "messaging"`. Task 11's STEER
// MEASUREMENT (P8b-38) is why a steer begins a turn too: a mid-turn push yields its OWN `result` on
// this wire, and a turn that was not begun has its terminal dropped.
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
// the driver.
import type { Options, Query } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent, SessionEvent } from "@norma/protocol";
import { MAIN_THREAD, ProjectorRefusedError, classifyThrown, type ProjectedBatch, type Projector, type ProtocolSdkMessage } from "../projector";
import { asInitFrame, asResultFrame } from "../projector/conversation";
import { ALLOWED_TRANSITIONS, type RuntimeSessionState } from "../runtime-state/records";
import type { NormaRuntimeSdk, SessionMode } from "./create";
import type { attachWinterSession, WinterSessionAttachHandle, WinterSessionAttachment } from "./messaging";
import { createHostPromptQueue, type HostPromptQueue } from "./prompt-queue";

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
  /** Norma's own session id — what every persisted event is stamped with. */
  sessionId: string;
  /** The BACKEND uuid allocated by the creation transaction: `Options.sessionId` on a fresh start,
   *  `Options.resume` afterwards, the messaging address, the name of the child's transcript. */
  backendSessionId: string;
  mode: SessionMode;
  runtime: NormaRuntimeSdk;
  /** `Options` for ONE incarnation. Re-reads the session's LIVE facts (model, effort, policy) and
   *  re-resolves the spawn hook, so a `session.setModel` while resumable is honoured on resume. May
   *  throw a typed refusal (an executable that has gone away) — `open()` surfaces it. */
  options: (incarnation: WinterIncarnation) => Options | Promise<Options>;
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
  /** HOT: `winterOptionsFromSettings(settings()).idleTimeoutSec * 1000`, read when the timer is armed. */
  idleTimeoutMs: () => number;
  /** Test seam for `WINTER_SESSION_END_GRACE_MS`. */
  endGraceMs?: number;
  log?: (line: string) => void;
}

export interface WinterSession {
  readonly sessionId: string;
  readonly backendSessionId: string;
  readonly mode: SessionMode;
  readonly state: WinterSessionState;
  /** The 8a generation of the current (or last) incarnation; 0 before the first opens. */
  readonly generation: number;
  /** The live `Query`, or undefined while `resumable`/`ended`. */
  readonly query: Query | undefined;
  readonly init: WinterInitFacts | undefined;
  /** A host-side fact: pushes minus results, for the current incarnation. */
  readonly turnRunning: boolean;
  /** Resolves when the CURRENT incarnation's iteration has returned (and its teardown ran).
   *  Already resolved while `resumable`/`ended`. */
  readonly done: Promise<void>;
  /** Texts held host-side while a turn ran (P8b-5), pushed one per `result`. */
  readonly pendingSends: readonly string[];
  /** Deliveries that reached the push sink while `resumable` (P8b-24), pushed first on resume. */
  readonly heldDeliveries: readonly string[];
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
  steer(text: string, clientName?: string): Promise<{ seq: number; injected: boolean }>;
  interrupt(): Promise<{ wasRunning: boolean }>;
  /** Winter's `Query` has no compaction control at 0.0.4 — a typed `WinterLegUnsupported`, never a silent no-op. */
  compact(): Promise<never>;
  setModel(model?: string): Promise<void>;
  /** Close the queue, wait, abort stragglers; `resumable` afterwards. Idempotent; never rejects. */
  end(): Promise<void>;
  /** The messaging push sink: a delivered envelope becomes this session's next user turn. */
  deliver(text: string): void;
  /** Open an incarnation if none is live (the creation transaction's start; `send`/`steer`/`deliver`
   *  call it implicitly). Rejects with the options thunk's typed refusal when the child cannot be
   *  spawned, and with `WinterSessionEnded` when the session can never run again. */
  open(): Promise<void>;
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
  private initFacts: WinterInitFacts | undefined;
  private inFlight = 0;
  private ending = false;
  private endingPromise: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending: string[] = [];
  private readonly held: string[] = [];
  private endedReason: string | undefined;
  /** The open() in flight, so two concurrent sends resume ONE child, not two. */
  private opening: Promise<void> | undefined;

  constructor(private readonly deps: WinterSessionDeps) {
    this.sessionId = deps.sessionId;
    this.backendSessionId = deps.backendSessionId;
    this.mode = deps.mode;
  }

  get state(): WinterSessionState { return this.stateValue; }
  get generation(): number { return this.gen; }
  get query(): Query | undefined { return this.inc?.query; }
  get init(): WinterInitFacts | undefined { return this.initFacts; }
  get turnRunning(): boolean { return this.inFlight > 0; }
  get done(): Promise<void> { return this.inc?.done ?? this.lastDone; }
  get pendingSends(): readonly string[] { return this.pending; }
  get heldDeliveries(): readonly string[] { return this.held; }

  // ── the doors ──────────────────────────────────────────────────────────────────────────────

  async send(text: string, clientName = "session"): Promise<{ seq: number; queued: boolean }> {
    this.assertNotEnded();
    // Open FIRST: a refused open (the binary is gone) then leaves no orphan `user_message`, and a
    // delivery held while resumable is appended by `open()` BEFORE this text — chronological.
    await this.open();
    const seq = this.appendUser(text, clientName);
    const wasRunning = this.inFlight > 0;
    this.emit(this.inc!.projector.beginTurn({ text }));
    if (wasRunning) {
      // P8b-5: held host-side until the running turn's `result` arrives, then pushed — the turn is
      // already begun (its `turn_started` is in the log), only the push waits.
      this.pending.push(text);
      return { seq, queued: true };
    }
    this.push(text);
    return { seq, queued: false };
  }

  async steer(text: string, clientName = "steer"): Promise<{ seq: number; injected: boolean }> {
    this.assertNotEnded();
    await this.open();
    const seq = this.appendUser(text, clientName);
    const wasRunning = this.inFlight > 0;
    // P8b-38: a steered-in message yields its OWN result on this wire, so it is a begun turn too.
    this.emit(this.inc!.projector.beginTurn({ text }));
    this.push(text);
    return { seq, injected: wasRunning };
  }

  deliver(text: string): void {
    if (this.stateValue === "ended") {
      this.log(`a delivery reached ${this.sessionId} after it ended — dropped`);
      return;
    }
    if (this.stateValue !== "live" || this.inc === undefined) {
      // P8b-24: a delivery that reached the sink was already receipted by the router; holding it
      // host-side (rather than throwing, which the wrapper would report as `delivery_uncertain`)
      // is what avoids a re-delivery. Pushed first on resume.
      this.held.push(text);
      return;
    }
    this.appendUser(text, "messaging");
    this.emit(this.inc.projector.beginTurn({ text }));
    this.push(text);
  }

  async interrupt(): Promise<{ wasRunning: boolean }> {
    const inc = this.inc;
    if (this.stateValue !== "live" || inc === undefined || this.inFlight === 0) return { wasRunning: false };
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

  async setModel(model?: string): Promise<void> {
    // A resumable session re-reads its model from the store when it reopens (`deps.options`), so
    // only a live child needs telling.
    if (this.stateValue === "live" && this.inc !== undefined) await this.inc.query.setModel(model);
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
        await Promise.race([inc.done, sleep(grace)]);
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
    if (this.stateValue === "live" && this.inc !== undefined) return;
    if (this.opening !== undefined) return this.opening;
    this.opening = (async () => {
      this.assertNotEnded();
      await this.lastDone;
      const abort = new AbortController();
      const resume = await this.deps.hasTranscript();
      const generation = this.deps.records?.bumpGeneration(this.sessionId, { runtimeKind: "winter-agent", backendSessionId: this.backendSessionId }).generation ?? this.gen + 1;
      const shape: WinterIncarnation = { generation, resume, abort };
      const options = await this.deps.options(shape);
      const queue = (this.deps.queue ?? createHostPromptQueue)();
      const projector = this.deps.projector(shape);
      const query = this.deps.runtime.sdk.query({ prompt: queue, options });
      const inc: Incarnation = { ...shape, queue, projector, query, attachment: undefined, sawInit: false, done: Promise.resolve() };
      this.inc = inc;
      this.gen = generation;
      this.ending = false;
      this.inFlight = 0;
      this.stateValue = "live";
      this.recordState(resume ? "running" : "idle");
      // Tracked BEFORE the iteration starts, so a shutdown that lands between the spawn and the
      // first frame still ends this child (`end` must be idempotent: it is).
      this.deps.runtime.trackQuery(this.sessionId, abort, () => this.end());
      inc.done = this.run(inc);
      this.lastDone = inc.done;
      // Replay, in the order the texts arrived. A pending send's `turn_started` was persisted by the
      // incarnation that held it, so `beginTurn` here only re-opens the turn in THIS projector and
      // its returned batch is deliberately dropped — two `turn_started`s for one push is the
      // double-producer failure the projector's coverage map warns about.
      for (const text of this.pending.splice(0)) { inc.projector.beginTurn({ text }); this.push(text); }
      for (const text of this.held.splice(0)) {
        this.appendUser(text, "messaging");
        this.emit(inc.projector.beginTurn({ text }));
        this.push(text);
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
      // The turns still open on this incarnation (a held send that never got its push, a turn the
      // abort cut short beyond the one `acceptError` closed) run on the next one; their
      // `user_message`/`turn_started` pairs are already in the log.
      this.inFlight = 0;
      try { this.deps.records?.endGeneration(this.sessionId, inc.generation, ended ?? (this.ending ? "ended" : "exited")); } catch { /* the db may be closed at shutdown */ }
      this.recordState(ended === "ended" ? "failed" : "exited");
      if (this.inc === inc) this.inc = undefined;
      this.stateValue = ended ?? "resumable";
    }
  }

  private onResult(inc: Incarnation): void {
    if (this.inFlight > 0) this.inFlight--;
    // P8b-5: one held send per result — the turn it belongs to was begun when it was held.
    const next = this.pending.shift();
    if (next !== undefined) { this.push(next, inc); return; }
    if (this.inFlight === 0) {
      this.recordState("idle");
      inc.attachment?.refresh();
      this.armIdleTimer();
    }
  }

  // ── the small pieces ───────────────────────────────────────────────────────────────────────

  private push(text: string, inc: Incarnation | undefined = this.inc): void {
    if (inc === undefined) throw new Error(`no live winter incarnation for ${this.sessionId}`);
    inc.queue.push(text);
    this.inFlight++;
    this.clearIdleTimer();
    this.recordState("running");
    inc.attachment?.refresh();
  }

  private appendUser(text: string, clientName: string): number {
    return this.deps.append({ type: "user_message", sessionId: this.sessionId, threadId: MAIN_THREAD, text, clientName }).seq;
  }

  private emit(batch: ProjectedBatch): void {
    for (const e of batch.persist) this.safeAppend(e);
    for (const e of batch.broadcast) {
      try { this.deps.broadcast(e); } catch (err) { this.log(`broadcast failed for ${this.sessionId}: ${err instanceof Error ? err.name : "unknown"}`); }
    }
  }

  private safeAppend(e: NewSessionEvent): void {
    try { this.deps.append(e); } catch (err) {
      // A closed store at shutdown, or a session deleted underneath a draining child. The frame is
      // lost to the product log and the log line says so; the driver never throws for it.
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
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.stateValue === "live" && this.inFlight === 0 && !this.ending) {
        this.log(`session ${this.sessionId} idle for ${ms} ms — ending its winter child (resumable)`);
        void this.end();
      }
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    this.idleTimer = timer;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
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
