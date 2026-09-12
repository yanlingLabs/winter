// P8c Task 1.2 — `OfficialSession`: ONE Norma session running on the official leg (a spawned
// `claude` child through the router's own official adapter). Mirrors `WinterSession`'s PUBLIC shape
// (`winter-session.ts`) closely enough that `session-driver.ts` can hold either behind one
// `LegSession` interface (that wiring is a Task 1.2 CARRY — see the lane report), but the internal
// mechanics are DELIBERATELY LEANER for this checkpoint: `WinterSession`'s own header records three
// behaviours the brief assumed and the binary did not have, discovered by repeatedly driving the
// real `dist/winter` — the honest equivalent for the official leg is NOT assumed here yet
// (steer-while-a-turn-is-running, deliver-while-resumable, multi-incarnation resume-lock races are
// UNMEASURED against the real 0.3.250 runtime and are carried rather than guessed at).
//
// WHAT THIS FILE PROVES, MEASURED AGAINST THE REAL RUNTIME (see `official-leg.e2e.test.ts`):
// open() spawns exactly one incarnation through `runtime.sdk.query()` with an `OfficialInputStream`
// (the router's own `createOfficialInputStream`, R-7b-4's "push into the input stream"); every wire
// frame folds through the SAME projector Winter sessions use (`../projector`'s `createProjector` —
// the wire shapes are structurally the same `system|assistant|user|result|stream_event` union on
// both runtimes, cast at the boundary exactly as `winter-session.ts` does); `interrupt()` calls the
// official `Query`'s own `interrupt()` and the projector's `result(interrupted)` frame is what turns
// that into `turn_completed(aborted)` — never a thrown error.
import type { NewSessionEvent, SessionEvent } from "@norma/protocol";
import { createOfficialInputStream, isOfficialQuery, type OfficialInputStream, type RouterOfficialInput, type RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { MAIN_THREAD, ProjectorRefusedError, classifyThrown, createProjector, type CheckpointStore, type ProjectedBatch, type Projector, type ProtocolSdkMessage } from "../projector";
import type { NormaRuntimeSdk, SessionMode } from "./create";
import type { SessionApprovalPolicy } from "../agent/gate";
import { OfficialCredentialPlanRefused, officialInputFor, OfficialProjectKeyTooDeep, type OfficialInputDeps, type OfficialSessionInput } from "./official-options";
import { ClaudeExecutableUnavailable } from "./official-executable";

export type OfficialSessionState = "live" | "resumable" | "ended";

/** Mirrors `WinterInitFacts` — the last `system/init` the child reported. */
export interface OfficialInitFacts {
  sessionId?: string;
  model?: string;
  tools: string[];
}

export interface OfficialSessionDeps {
  sessionId: string;
  /** The backend uuid this session's transcript is keyed under — same role as `WinterSessionDeps`'s
   *  own field, EXCEPT the official runtime allocates it itself at `system/init` on a fresh start
   *  (WS-16 §6: "the `system/init` uuid must equal the pre-allocated `backendSessionId`" is checked
   *  here — a mismatch is a typed refusal, never a silent divergence). */
  backendSessionId: string;
  mode: SessionMode;
  runtime: NormaRuntimeSdk;
  selection: RuntimeSelection;
  /** Builds `OfficialSessionInput` for the CURRENT turn — re-read live, same posture as
   *  `WinterSessionDeps.options`. */
  sessionInput: () => OfficialSessionInput;
  /** Rebuilt on EVERY incarnation (same "re-read the session's LIVE facts" posture as
   *  `WinterSessionDeps.options`) — `policy` in particular must not be a stale snapshot: a
   *  `session.setPolicy` between incarnations has to reach the NEXT open(). May be async (same
   *  `T | Promise<T>` shape as `WinterSessionDeps.options`) — a real credential-presence read is
   *  async, and this is the one door session-driver.ts has to build one per incarnation. */
  inputDeps: () => OfficialInputDeps | Promise<OfficialInputDeps>;
  projector: (generation: number) => Projector;
  append: (event: NewSessionEvent) => SessionEvent;
  broadcast: (event: NewSessionEvent) => void;
  log?: (line: string) => void;
}

export interface OfficialSession {
  readonly sessionId: string;
  readonly backendSessionId: string;
  readonly mode: SessionMode;
  readonly state: OfficialSessionState;
  readonly generation: number;
  readonly resumed: boolean;
  readonly init: OfficialInitFacts | undefined;
  readonly turnRunning: boolean;
  readonly turnStartedAt: number | undefined;
  readonly done: Promise<void>;
  readonly pendingSends: readonly string[];
  readonly heldDeliveries: readonly string[];
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
  /** UNMEASURED (see this file's header): today a steer is a `send` — it does NOT join a turn
   *  already running. Carried; `WinterSession`'s own mid-turn-steer behaviour needs the same
   *  measurement pass against the real 0.3.250 runtime before this can match it. */
  steer(text: string, clientName?: string): Promise<{ seq: number; injected: boolean }>;
  interrupt(): Promise<{ wasRunning: boolean }>;
  compact(): Promise<never>;
  /** No live model switch exists on `OfficialQuery` (WS-14's seam: `interrupt()` is its only
   *  member) — takes effect on the NEXT incarnation, via `sessionInput()`'s own live re-read. */
  setModel(model?: string): Promise<void>;
  /** Same signature as `WinterSession.setPolicy` (so both satisfy `LegSession`); a no-op today —
   *  see this member's own doc comment above `setModel` for why. A resumed incarnation re-reads
   *  the session's live policy through `sessionInput()`/`officialInputFor`'s own broker build. */
  setPolicy(policy: SessionApprovalPolicy): Promise<void>;
  end(): Promise<void>;
  /** UNMEASURED — see `steer`'s own note; today a delivery while `resumable` is simply held, same
   *  as Winter's `heldDeliveries`, but no messaging attachment exists on this leg yet (carry). */
  deliver(text: string): void;
  open(): Promise<void>;
  idle(): Promise<void>;
}

export class OfficialLegUnsupported extends Error {
  readonly code = "not_supported_on_official_leg" as const;
  constructor(what: string) {
    super(`${what} is not supported on the official leg yet`);
    this.name = "OfficialLegUnsupported";
  }
}

export class OfficialSessionEnded extends Error {
  readonly code = "official_session_ended" as const;
  constructor(sessionId: string, reason: string) {
    super(`session ${sessionId} has ended on the official leg and cannot be resumed: ${reason}`);
    this.name = "OfficialSessionEnded";
  }
}

/** WS-16 §6: the child's own `system/init` uuid must equal the pre-allocated backend id. A mismatch
 *  is a configuration fault in the router's spawn plan, never something a session should paper over. */
export class OfficialBackendIdMismatch extends Error {
  readonly code = "official_backend_id_mismatch" as const;
  constructor(expected: string, got: string) {
    super(`the official runtime reported backend session id "${got}" but this session was launched under "${expected}" (WS-16 §6)`);
    this.name = "OfficialBackendIdMismatch";
  }
}

interface Incarnation {
  stream: OfficialInputStream;
  projector: Projector;
  query: AsyncIterable<unknown> & { interrupt(): Promise<unknown> };
  /** M1: the same controller `Options.abortController` carries — `runtime.trackQuery`'s own key. */
  abort: AbortController;
  done: Promise<void>;
  sawInit: boolean;
}

const isExpectedEndError = (err: unknown): boolean => {
  const name = err instanceof Error ? err.name : "";
  return name === "ProcessError" || name === "AbortError" || name === "CLIConnectionError";
};

export function startOfficialSession(deps: OfficialSessionDeps): OfficialSession {
  return new OfficialSessionImpl(deps);
}

class OfficialSessionImpl implements OfficialSession {
  readonly sessionId: string;
  readonly backendSessionId: string;
  readonly mode: SessionMode;
  private stateValue: OfficialSessionState = "resumable";
  private inc: Incarnation | undefined;
  private lastDone: Promise<void> = Promise.resolve();
  private gen = 0;
  private initFacts: OfficialInitFacts | undefined;
  private inFlight = 0;
  private ending = false;
  private endingPromise: Promise<void> | undefined;
  private endedReason: string | undefined;
  private opening: Promise<void> | undefined;
  private idleWaiters: Array<() => void> = [];
  private turnStart: number | undefined;

  constructor(private readonly deps: OfficialSessionDeps) {
    this.sessionId = deps.sessionId;
    this.backendSessionId = deps.backendSessionId;
    this.mode = deps.mode;
  }

  get state(): OfficialSessionState { return this.stateValue; }
  get generation(): number { return this.gen; }
  get resumed(): boolean { return false; } // carried — see this file's header
  get init(): OfficialInitFacts | undefined { return this.initFacts; }
  get turnRunning(): boolean { return this.inFlight > 0; }
  get turnStartedAt(): number | undefined { return this.inFlight > 0 ? this.turnStart : undefined; }
  get done(): Promise<void> { return this.inc?.done ?? this.lastDone; }
  get pendingSends(): readonly string[] { return []; }
  get heldDeliveries(): readonly string[] { return []; }

  async send(text: string, clientName = "session"): Promise<{ seq: number; queued: boolean }> {
    this.assertNotEnded();
    await this.open();
    const seq = this.appendUser(text, clientName);
    this.beginAndPush(text, this.inc!);
    return { seq, queued: false };
  }

  async steer(text: string, clientName = "steer"): Promise<{ seq: number; injected: boolean }> {
    const { seq } = await this.send(text, clientName);
    return { seq, injected: false };
  }

  deliver(text: string): void {
    if (this.stateValue !== "live" || this.inc === undefined) { this.log(`a delivery reached ${this.sessionId} while not live — dropped (carry: no held-delivery replay yet)`); return; }
    this.appendUser(text, "messaging");
    this.beginAndPush(text, this.inc);
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
    return Promise.reject(new OfficialLegUnsupported("session.compact"));
  }

  idle(): Promise<void> {
    if (this.inFlight === 0 || this.stateValue !== "live") return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }

  private settleIdle(): void {
    for (const w of this.idleWaiters.splice(0)) w();
  }

  async setModel(_model?: string): Promise<void> {
    // No live model switch on `OfficialQuery` — the next incarnation reads `sessionInput()` live.
    return Promise.resolve();
  }

  async setPolicy(_policy: SessionApprovalPolicy): Promise<void> {
    // No live permission-mode switch on `OfficialQuery` either — same posture as `setModel`.
    return Promise.resolve();
  }

  end(): Promise<void> {
    if (this.endingPromise !== undefined) return this.endingPromise;
    const inc = this.inc;
    if (this.stateValue !== "live" || inc === undefined) return this.done;
    this.ending = true;
    this.endingPromise = (async () => {
      try {
        try { inc.stream.close(); } catch { /* already closed */ }
        await inc.done;
      } finally {
        this.endingPromise = undefined;
      }
    })();
    return this.endingPromise;
  }

  async open(): Promise<void> {
    if (this.stateValue === "live" && this.inc !== undefined && !this.ending) return;
    if (this.opening !== undefined) return this.opening;
    this.opening = (async () => {
      this.assertNotEnded();
      await this.lastDone;
      const inputDeps = await this.deps.inputDeps();
      const built = officialInputFor(this.deps.sessionInput(), inputDeps);
      if (built instanceof ClaudeExecutableUnavailable || built instanceof OfficialProjectKeyTooDeep || built instanceof OfficialCredentialPlanRefused) throw built;
      const stream = createOfficialInputStream();
      const generation = this.gen + 1;
      const projector = this.deps.projector(generation);
      // Fix round 1 (M1): ONE `AbortController` per incarnation, the SAME one Winter sessions
      // carry — `runtime.trackQuery` is what makes G-14's "every live Query ends BEFORE the
      // router disposes" true for this leg too; without it a daemon `stop()` never learns this
      // child exists and a live official turn outlives the daemon.
      const abort = new AbortController();
      const routerQuery = this.deps.runtime.sdk.query({
        prompt: stream,
        options: {
          cwd: this.deps.sessionInput().cwd,
          model: this.deps.selection.modelRef,
          pathToClaudeCodeExecutable: built.pathToClaudeCodeExecutable,
          // WS-16 §6: force the vendor to use OUR pre-allocated backend uuid on a fresh start —
          // `Options.sessionId` (must be a valid UUID; carried, never checked, for a RESUME, which
          // is a Task 1.2 carry: multi-incarnation resume is unmeasured against this runtime).
          sessionId: this.backendSessionId,
          abortController: abort,
          ...(inputDeps.provider === undefined ? {} : { provider: inputDeps.provider }),
          runtime: { selection: this.deps.selection, sessionId: this.sessionId, official: built.input },
        },
      });
      if (!isOfficialQuery(routerQuery)) throw new Error(`the router opened ${this.sessionId} on the wrong leg (expected the official leg)`);
      const inc: Incarnation = { stream, projector, query: routerQuery, abort, sawInit: false, done: Promise.resolve() };
      this.inc = inc;
      this.gen = generation;
      this.ending = false;
      this.inFlight = 0;
      this.stateValue = "live";
      // Tracked BEFORE the iteration starts (`winter-session.ts`'s own precedent) — a shutdown
      // landing between the spawn and the first frame must still end this child.
      this.deps.runtime.trackQuery(this.sessionId, abort, () => this.end());
      inc.done = this.run(inc);
      this.lastDone = inc.done;
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async run(inc: Incarnation): Promise<void> {
    try {
      for await (const raw of inc.query) {
        const msg = raw as unknown as ProtocolSdkMessage;
        if (isInitFrame(msg)) {
          inc.sawInit = true;
          const reportedId = typeof msg.session_id === "string" ? msg.session_id : undefined;
          if (reportedId !== undefined && reportedId !== this.backendSessionId) {
            this.safeAppend({ type: "agent_error", sessionId: this.sessionId, threadId: MAIN_THREAD, message: new OfficialBackendIdMismatch(this.backendSessionId, reportedId).message, code: "official_backend_id_mismatch" });
          }
          this.initFacts = {
            ...(reportedId === undefined ? {} : { sessionId: reportedId }),
            ...(typeof msg.model === "string" ? { model: msg.model } : {}),
            tools: Array.isArray(msg.tools) ? (msg.tools as unknown[]).filter((t): t is string => typeof t === "string") : [],
          };
        }
        let batch: ProjectedBatch;
        try {
          batch = inc.projector.accept(msg);
        } catch (err) {
          if (err instanceof ProjectorRefusedError || (err as { code?: unknown })?.code === "projector_refused") {
            this.safeAppend({ type: "agent_error", sessionId: this.sessionId, threadId: MAIN_THREAD, message: (err as Error).message, code: "projector_refused" });
            void this.end();
            continue;
          }
          throw err;
        }
        this.emit(batch);
        if (isResultFrame(msg)) this.onResult();
      }
    } catch (err) {
      if (this.ending && this.inFlight === 0 && isExpectedEndError(err)) {
        // deliberate end, nothing running
      } else if (!inc.sawInit && isExpectedEndError(err)) {
        this.log(`the official child for ${this.sessionId} exited before init (${(err as Error).name})`);
        if (this.inFlight > 0) this.emit(inc.projector.acceptError(err));
      } else {
        this.emit(inc.projector.acceptError(err));
        const cls = classifyThrown(err);
        if (!this.ending) this.log(`the official child for ${this.sessionId} stopped: ${cls.code}`);
      }
    } finally {
      try { inc.projector.flush(); } catch { /* checkpoint store may already be closed */ }
      this.deps.runtime.untrack(this.sessionId);
      this.inFlight = 0;
      this.settleIdle();
      if (this.inc === inc) this.inc = undefined;
      this.stateValue = "resumable";
    }
  }

  private onResult(): void {
    if (this.inFlight > 0) this.inFlight--;
    if (this.inFlight === 0) this.settleIdle();
  }

  private beginAndPush(text: string, inc: Incarnation): void {
    this.emit(inc.projector.beginTurn({ text }));
    if (this.inFlight === 0) this.turnStart = Date.now();
    this.inFlight++;
    void inc.stream.push(text).catch((err) => this.log(`push failed for ${this.sessionId}: ${err instanceof Error ? err.name : "unknown"}`));
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
      this.log(`append failed for ${this.sessionId} (${e.type}): ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  private assertNotEnded(): void {
    if (this.stateValue === "ended") throw new OfficialSessionEnded(this.sessionId, this.endedReason ?? "the backend store refused it");
  }

  private log(line: string): void { this.deps.log?.(line); }
}

function isInitFrame(msg: ProtocolSdkMessage): msg is ProtocolSdkMessage & { type: "system"; subtype: "init"; session_id?: string; model?: string; tools?: unknown } {
  const m = msg as unknown as Record<string, unknown>;
  return m["type"] === "system" && m["subtype"] === "init";
}

function isResultFrame(msg: ProtocolSdkMessage): boolean {
  return (msg as unknown as Record<string, unknown>)["type"] === "result";
}

export type { CheckpointStore };
