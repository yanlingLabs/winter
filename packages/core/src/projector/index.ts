import { TRANSIENT_EVENT_TYPES, type SessionEvent } from "@norma/protocol";
import {
  MAIN_THREAD, asAssistantFrame, asInitFrame, asResultFrame, asStreamEventFrame, asUserFrame,
  assistantText, deltaText, hasToolResults, threadIdOf, toolCalls, toolResults, userText,
} from "./conversation";
import { applyTaskPatch, childFromSpawn, isSpawnTool, seedTask, threadCompletedFrom, threadStarted, type ChildRecord, type TaskRow } from "./children";
import { createEchoWindow, type EchoWindow } from "./dedupe";
import { classifyThrown } from "./errors";
import { isKnownUnpersistedKind, kindOf, summarize } from "./hooks";
import { isQuestionTool } from "./questions";
import { projectTerminal, totalsOf, type UsageTotals } from "./terminal";
import { normaToolNameFor } from "./tool-names";
import type { CheckpointStore, ProjectedEvent, Projector, ProjectorDeps, ProjectorRefusal, ProtocolSdkMessage } from "./types";

export { PROJECTED_EVENT_COVERAGE, SUBAGENT_TRANSCRIPT_INCLUDE } from "./event-coverage";
export { createEchoWindow, ECHO_WINDOW, type EchoWindow } from "./dedupe";
export { projectTerminal, totalsOf, type UsageTotals } from "./terminal";
export {
  AGENT_ERROR_CODES, classifyResult, classifyThrown, codeForHttpStatus, sanitizeDetail,
  type AgentErrorCode, type ClassifiedError,
} from "./errors";
export {
  TASK_STATUS_MAP, applyTaskPatch, childFromSpawn, isSpawnTool, seedTask, threadCompletedFrom,
  threadStarted, type ChildRecord, type NormaTaskStatus, type TaskRow, type WinterTaskStatus,
} from "./children";
export { UNPERSISTED_KINDS, isKnownUnpersistedKind, kindOf, summarize } from "./hooks";
export { QUESTION_TOOLS, isQuestionTool } from "./questions";
export { MAIN_THREAD, threadIdOf } from "./conversation";
export { normaToolNameFor } from "./tool-names";
export type {
  CheckpointStore, Logger, ProjectedEvent, ProjectionCursorInput, ProjectionKey, Projector,
  ProjectorDeps, ProjectorRefusal, ProtocolSdkMessage, SessionMode,
} from "./types";

/**
 * ── THE SDK → SessionEvent PROJECTOR, part 1: conversation + terminal + idempotency ─────────────
 *
 * One projector per live Winter session. It is driven by the host's `for await (const m of query)`
 * loop: every wire message goes through `accept`, and whatever comes back is appended (or, for a
 * transient, broadcast) by the caller, in order.
 *
 * WHAT IT DOES NOT DO, on purpose:
 *  - It never appends. The caller owns the store, so the projector can be unit-tested with no
 *    filesystem, and the one place events reach disk stays the one place it already was.
 *  - It never produces a variant `PROJECTED_EVENT_COVERAGE` marks `false`, and there is no branch
 *    that can emit `reasoning_item` — opaque provider state has exactly one sink and the projector
 *    is not it.
 *  - It never appends `user_message` for a turn the host pushed (P8b-5). On the 0.0.3 wire it never
 *    even sees one; see `dedupe.ts` for the measurement.
 *
 * ── IDEMPOTENCY (P8b-14 item: "replaying a prefix twice duplicates no tool_call/tool_result/
 *    approval/terminal") ─────────────────────────────────────────────────────────────────────────
 *
 * Every message that yields a PERSISTED event is claimed in 8a's `ProjectionCheckpoints` before it
 * is projected, and the claim is committed once the caller has had a chance to append. 8a's
 * documented ordering is begin → append → complete, and `accept` returning the events IS the
 * append's opportunity — so the commit of message N happens at the top of `accept(N+1)`, and
 * `flush()` closes the last one when the stream ends. An uncommitted mark is safe, not corrupt: it
 * stays `pending` and 8a's recovery sweep resolves it against the product log's tail.
 *
 * `stream_event` is deliberately NOT checkpointed. Transients are never persisted, so a replay of a
 * backend transcript contains none of them, and there is nothing for a second pass to duplicate —
 * P8b-14's idempotency list is `tool_call`/`tool_result`/approval/terminal, and the test filters to
 * non-transient variants for exactly this reason.
 *
 * THE SOURCE ID, and why it is not the brief's `msg.uuid`. Measured against `dist/winter`:
 * `assistant`, `user` and `result` frames carry **no `uuid` and no `session_id`** — only `system/*`
 * frames do. So the key is derived, deterministically, from what IS on the wire:
 *
 *   assistant with tool_use   `tu:<first tool_use id>`    (stable across a replay — it is the model's own id)
 *   assistant, text only      `as:<turn>:<round>`         (position; the frame carries nothing else)
 *   user with tool_result     `tr:<first tool_use_id>`    (stable)
 *   user, text only           `um:<turn>:<round>`         (position)
 *   result                    `rs:<backend session>:<turn>`
 *
 * Position-derived keys are correct for a replay that starts at the beginning of a generation,
 * which is what 8a's cursor + generation pair guarantees: a resume bumps the generation, and the
 * key includes it.
 */
export function createProjector(deps: ProjectorDeps): Projector {
  return new ProjectorImpl(deps);
}

interface PendingMark { sourceId: string; first: number; last: number; cursor: string }

/** `totalsOf`'s parameter, narrowed to what it actually reads. */
type ResultFrameLike = Parameters<typeof totalsOf>[0];

class ProjectorImpl implements Projector {
  private readonly checkpoint: CheckpointStore;
  private readonly winterSessionId: string;
  private readonly generation: number;
  private readonly echo: EchoWindow;

  /** The last seq handed out. Transients are stamped with it rather than consuming a new one —
   *  `assistant_delta` carries "the store's lastSeq at broadcast time, NOT its own seq"
   *  (`protocol/events.ts`), and a client that deduped it by seq would drop every one. The hub
   *  re-stamps on `broadcastTransient` anyway; this keeps the value honest in between. */
  private lastSeq = 0;
  private turnIndex = 0;
  private roundIndex = 0;
  /** `assistant` frames seen in the current turn — 1 is what makes `contextTokens` exact. */
  private roundsThisTurn = 0;
  private totals: UsageTotals | undefined;
  private pending: PendingMark | undefined;
  private messageIndex = 0;
  private backendSessionId: string | undefined;
  private running = false;
  private resultAt: string | undefined;
  /** One log line per unknown wire `type`, not one per message. */
  private readonly loggedTypes = new Set<string>();
  /** One log line per unmapped tool name, not one per call. */
  private readonly loggedToolNames = new Set<string>();
  /** ONE line per session when the catalog row is unpriced, not one per turn (P8b-30). */
  private loggedUnpricedUsage = false;
  /** Child threads opened by a spawning `tool_use`, keyed by that block's id (= the threadId). */
  private readonly children = new Map<string, ChildRecord>();
  /** Winter's task graph, mirrored so a `task_updated` patch has a subject to carry. */
  private readonly tasks = new Map<string, TaskRow>();
  /** Every refusal this projector made, in order — surfaced rather than dropped. */
  private readonly refused: ProjectorRefusal[] = [];
  /** True once this turn's terminal has been emitted, so an "error-result-then-throw" ResultError
   *  is recognised as the pair of a result already projected rather than projected twice. */
  private terminalEmitted = false;

  constructor(private readonly deps: ProjectorDeps) {
    this.checkpoint = deps.checkpoint;
    this.winterSessionId = deps.winterSessionId ?? deps.sessionId;
    this.generation = deps.generation ?? 1;
    this.echo = createEchoWindow();
  }

  get turnRunning(): boolean { return this.running; }
  get lastResultAt(): string | undefined { return this.resultAt; }

  accept(msg: ProtocolSdkMessage): SessionEvent[] {
    this.commitPending();
    this.messageIndex++;

    // ── transient: never checkpointed, never persisted ──────────────────────────────────────────
    const stream = asStreamEventFrame(msg);
    if (stream !== undefined) {
      const delta = deltaText(stream);
      if (delta === undefined) return [];
      this.running = true;
      return this.stamp([{ type: "assistant_delta", sessionId: this.deps.sessionId, threadId: threadIdOf(stream), delta }]);
    }

    // ── consumed, nothing persisted ─────────────────────────────────────────────────────────────
    const init = asInitFrame(msg);
    if (init !== undefined) {
      this.backendSessionId = typeof init.session_id === "string" ? init.session_id : undefined;
      this.deps.log.debug?.("[projector] session init", {
        sessionId: this.deps.sessionId, mode: this.deps.mode,
        model: typeof init.model === "string" ? init.model : undefined,
        tools: Array.isArray(init.tools) ? init.tools.length : 0,
      });
      return [];
    }

    const claim = (sourceId: string, produce: () => ProjectedEvent[]): SessionEvent[] => {
      const key = { winterSessionId: this.winterSessionId, generation: this.generation, sourceId };
      const verdict = this.checkpoint.begin(key);
      if (verdict === "already-committed") {
        this.deps.log.debug?.("[projector] replay: source already projected", { sourceId });
        return [];
      }
      if (verdict === "pending-elsewhere") return this.refuse(sourceId);
      const produced = produce();
      const stamped = this.stamp(produced);
      const persisted = stamped.filter((e) => !TRANSIENT_EVENT_TYPES.has(e.type));
      const first = persisted[0]?.seq ?? this.lastSeq;
      const last = persisted[persisted.length - 1]?.seq ?? this.lastSeq;
      this.pending = { sourceId, first, last, cursor: `${this.turnIndex}:${this.messageIndex}` };
      return stamped;
    };

    const assistant = asAssistantFrame(msg);
    if (assistant !== undefined) {
      this.running = true;
      this.roundIndex++;
      this.roundsThisTurn++;
      const threadId = threadIdOf(assistant);
      const firstToolUse = assistant.message.content.find((b) => b.type === "tool_use" && typeof b.id === "string");
      const sourceId = firstToolUse !== undefined ? `tu:${firstToolUse.id as string}` : `as:${this.turnIndex}:${this.roundIndex}`;
      return claim(sourceId, () => {
        const out: ProjectedEvent[] = [];
        const text = assistantText(assistant);
        if (text.length > 0) out.push({ type: "assistant_message", sessionId: this.deps.sessionId, threadId, text });
        out.push(...toolCalls(assistant, this.deps.sessionId, threadId, (n) => this.renameTool(n)));
        // A spawning call opens a child thread. `thread_started` follows its own `tool_call` so the
        // transcript reads parent-call-then-child, and the child's threadId IS the tool_use id —
        // the same identifier its completing `tool_result` carries, which is what lets
        // `thread_completed` be derived with no registry lookup (see children.ts).
        for (const b of assistant.message.content) {
          if (b.type !== "tool_use" || typeof b.name !== "string") continue;
          if (isQuestionTool(b.name) && !this.loggedToolNames.has(`?${b.name}`)) {
            this.loggedToolNames.add(`?${b.name}`);
            this.deps.log.debug?.("[projector] a question tool call — its question_asked/question_resolved pair is the question bridge's, joined on callId", {
              sessionId: this.deps.sessionId, tool: b.name,
            });
          }
          if (!isSpawnTool(b.name)) continue;
          const child = childFromSpawn(b, threadId);
          if (child === undefined || this.children.has(child.threadId)) continue;
          this.children.set(child.threadId, child);
          out.push(threadStarted(child, this.deps.sessionId));
        }
        return out;
      });
    }

    const userFrame = asUserFrame(msg);
    if (userFrame !== undefined) {
      this.running = true;
      this.roundIndex++;
      const threadId = threadIdOf(userFrame);
      if (hasToolResults(userFrame)) {
        const firstResult = userFrame.message.content.find((b) => b.type === "tool_result" && typeof b.tool_use_id === "string");
        const sourceId = `tr:${(firstResult?.tool_use_id as string | undefined) ?? `${this.turnIndex}:${this.roundIndex}`}`;
        return claim(sourceId, () => {
          const out = toolResults(userFrame, this.deps.sessionId, threadId);
          for (const b of userFrame.message.content) {
            if (b.type !== "tool_result") continue;
            const childId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
            if (childId === undefined || !this.children.has(childId)) continue;
            this.children.delete(childId);
            const completed = threadCompletedFrom(b, this.deps.sessionId);
            if (completed !== undefined) out.push(completed);
          }
          return out;
        });
      }
      // A text-only `user` frame is NOT an echo of a host push on the 0.0.3 wire (measured: the
      // runtime never re-emits the host's input frames) — it is an inbound delivery rendered into
      // the child's input. The echo window is consulted anyway, so a future echo is dropped here
      // rather than double-appended; see dedupe.ts.
      const text = userText(userFrame).trim();
      if (text.length === 0) return [];
      if (this.echo.shouldDropEcho(text)) {
        this.deps.log.debug?.("[projector] dropped an echoed host push", { sessionId: this.deps.sessionId });
        return [];
      }
      return claim(`um:${this.turnIndex}:${this.roundIndex}`, () => [
        { type: "user_message", sessionId: this.deps.sessionId, threadId, text, clientName: "winter" },
      ]);
    }

    const resultFrame = asResultFrame(msg);
    if (resultFrame !== undefined) {
      if (!this.running && this.turnIndex > 0) {
        // §4.9: exactly one result per user envelope. A second one with no turn in between is a
        // protocol violation — logged and dropped, never projected, because a second terminal would
        // end a turn nobody started and duplicate the phone's spinner transition.
        this.deps.log.warn?.("[projector] a second result arrived with no turn running — dropped", {
          sessionId: this.deps.sessionId, subtype: resultFrame.subtype,
        });
        return [];
      }
      const turn = this.turnIndex;
      const sourceId = `rs:${this.backendSessionId ?? this.winterSessionId}:${turn}`;
      const rounds = this.roundsThisTurn;
      // P8b-30: an UNPRICED catalog row emits no `modelUsage` at all (the measured case for every
      // `winter-test/*` double, and real for any row Winter cannot price). `turn_completed`'s
      // schema makes `inputTokens`/`outputTokens` REQUIRED and `contextTokens` OPTIONAL, so the
      // required pair reports 0 and the optional field is OMITTED rather than zero-filled — an
      // absent field reads as "not known", a zero reads as "measured, and it was nothing", and
      // `engine.ts:1689`'s compaction trigger skips a zero either way. Logged ONCE per session:
      // an unpriced row is a property of the model, so one line per turn would be noise.
      if (totalsOf(msg as ResultFrameLike) === undefined && !this.loggedUnpricedUsage) {
        this.loggedUnpricedUsage = true;
        this.deps.log.debug?.("[projector] the result carries no modelUsage (unpriced catalog row) — token counts report 0 and contextTokens is omitted", {
          sessionId: this.deps.sessionId,
        });
      }
      const events = claim(sourceId, () => {
        const out = projectTerminal({
          result: resultFrame, sessionId: this.deps.sessionId, threadId: MAIN_THREAD,
          previous: this.totals, rounds,
        });
        this.totals = out.totals ?? this.totals;
        return out.events;
      });
      // The turn closes whether or not the result projected (a replayed prefix must still advance
      // the turn counter, or every later source id would collide with the first pass's).
      this.turnIndex++;
      this.roundIndex = 0;
      this.roundsThisTurn = 0;
      this.running = false;
      this.terminalEmitted = true;
      this.resultAt = this.deps.now();
      return events;
    }

    const task = this.acceptTaskFrame(msg);
    if (task !== undefined) return task;

    this.logSkipped(msg);
    return [];
  }

  /**
   * Winter's task graph (§4.4). `task_started` seeds a row (so a later patch has a subject to
   * carry); `task_updated` and `task_notification` patch it. `task_progress` and
   * `background_tasks_changed` carry nothing Norma's `task_updated` can express beyond what the
   * patches already say, and `local_command_output` is not a task at all — all three fall through
   * to the debug log.
   *
   * Returns `undefined` (not `[]`) when the message is not a task frame, so `accept` can tell "not
   * mine" from "mine, and it projected nothing".
   */
  private acceptTaskFrame(msg: ProtocolSdkMessage): SessionEvent[] | undefined {
    const kind = kindOf(msg);
    const m = msg as Record<string, unknown>;
    const taskId = typeof m.task_id === "string" && m.task_id.length > 0 ? m.task_id : undefined;
    if (taskId === undefined) return undefined;

    if (kind === "system/task_started") {
      seedTask(this.tasks, taskId, m.description);
      this.logSkipped(msg);   // the row is now tracked; the FRAME still persists nothing
      return [];
    }
    if (kind === "system/task_updated") {
      const patch = typeof m.patch === "object" && m.patch !== null ? (m.patch as Record<string, unknown>) : {};
      return this.claimTask(`tk:${taskId}:${this.messageIndex}`, () => {
        const ev = applyTaskPatch(this.tasks, taskId, patch, this.deps.sessionId);
        return ev === undefined ? [] : [ev];
      });
    }
    if (kind === "system/task_notification") {
      // A background task's own terminal. Its three statuses are a SUBSET of the patch vocabulary
      // (`completed | failed | stopped`), and `stopped` is the patch's `killed` under another name
      // — mapped here rather than widening children.ts's table with a value `patch.status` can
      // never hold.
      const status = m.status === "stopped" ? "killed" : typeof m.status === "string" ? m.status : undefined;
      if (status === undefined) return [];
      return this.claimTask(`tk:${taskId}:${this.messageIndex}`, () => {
        const ev = applyTaskPatch(this.tasks, taskId, { status, ...(typeof m.summary === "string" ? { description: m.summary } : {}) }, this.deps.sessionId);
        return ev === undefined ? [] : [ev];
      });
    }
    return undefined;
  }

  flush(): void { this.commitPending(); }

  get refusals(): readonly ProjectorRefusal[] { return this.refused; }

  /**
   * The door for an exception the driver's `for await` caught.
   *
   * §4.8 item 3: an error result is yielded AND THEN thrown (`ResultError`, `query.ts:1084`), so a
   * driver that does not wrap its iteration gets an unhandled rejection. It wraps, and hands the
   * error here. Two things this must get right:
   *
   *  - A `ResultError` whose result was ALREADY projected must not be projected twice — that is the
   *    "error-result-then-throw" pair, one fact with two deliveries. `terminalEmitted` is the test.
   *  - A turn that is still open gets a terminal, because the driver's loop has ended and no
   *    `result` is coming: without one the Mac's spinner runs forever and the phone's turn never
   *    closes. An already-closed turn gets nothing.
   */
  acceptError(err: unknown): SessionEvent[] {
    this.commitPending();
    const classified = classifyThrown(err);
    const name = err instanceof Error ? err.name : "";
    if (name === "ResultError" && this.terminalEmitted) {
      this.deps.log.debug?.("[projector] ResultError for a result already projected — the error-result-then-throw pair", {
        sessionId: this.deps.sessionId, code: classified.code,
      });
      return [];
    }
    if (!this.running) {
      this.deps.log.warn?.("[projector] the stream failed with no turn running", { sessionId: this.deps.sessionId, code: classified.code });
      return [];
    }
    this.running = false;
    this.resultAt = this.deps.now();
    this.turnIndex++;
    this.roundIndex = 0;
    this.roundsThisTurn = 0;
    // An abort is a TURN BOUNDARY, never an error (ruling P8b-24) — the same rule `terminal.ts`
    // applies to `result.interrupted`, applied here so a thrown AbortError cannot smuggle an
    // `agent_error` past it.
    const aborted = classified.code === "aborted";
    return this.stamp(aborted
      ? [{ type: "turn_completed", sessionId: this.deps.sessionId, threadId: MAIN_THREAD, stopReason: "aborted", inputTokens: 0, outputTokens: 0 }]
      : [
          { type: "agent_error", sessionId: this.deps.sessionId, threadId: MAIN_THREAD, message: classified.message, code: classified.code },
          { type: "turn_completed", sessionId: this.deps.sessionId, threadId: MAIN_THREAD, stopReason: "error", inputTokens: 0, outputTokens: 0 },
        ]);
  }

  /** A task frame's claim: same contract as `claim`, but `accept`'s closure is out of scope here. */
  private claimTask(sourceId: string, produce: () => ProjectedEvent[]): SessionEvent[] {
    const key = { winterSessionId: this.winterSessionId, generation: this.generation, sourceId };
    const verdict = this.checkpoint.begin(key);
    if (verdict === "already-committed") return [];
    if (verdict === "pending-elsewhere") return this.refuse(sourceId);
    const stamped = this.stamp(produce());
    const first = stamped[0]?.seq ?? this.lastSeq;
    const last = stamped[stamped.length - 1]?.seq ?? this.lastSeq;
    this.pending = { sourceId, first, last, cursor: `${this.turnIndex}:${this.messageIndex}` };
    return stamped;
  }

  /**
   * A TYPED, RECORDED refusal (controller answer to Task 10 concern 8) — never a silent drop.
   *
   * A `pending-elsewhere` verdict means a mark is open for this source: another projector holds it
   * right now, or one died between its append and its commit. Re-projecting could double-append, so
   * this projector declines — but declining invisibly is how a session quietly loses a tool call.
   * The refusal is appended to `refusals`, handed to `deps.onRefusal` if the driver wired one, and
   * warned. Task 16 surfaces it; 8a's recovery sweep (`pending()` + `resolvePending`, the only code
   * that can read the product log's tail) is what resolves it.
   *
   * It is a returned marker rather than a thrown `ProjectorRefusedError` deliberately: throwing out
   * of `accept` would abort the driver's iteration over the rest of a turn that is otherwise fine,
   * turning a bookkeeping conflict into a dead session.
   */
  private refuse(sourceId: string): SessionEvent[] {
    const refusal: ProjectorRefusal = {
      reason: "pending-elsewhere", sourceId, sessionId: this.deps.sessionId,
      winterSessionId: this.winterSessionId, generation: this.generation, at: this.deps.now(),
    };
    this.refused.push(refusal);
    this.deps.log.warn?.("[projector] source mark is pending elsewhere — refusing to re-project; run the 8a recovery sweep", {
      sessionId: this.deps.sessionId, sourceId,
    });
    try { this.deps.onRefusal?.(refusal); } catch { /* a driver's own handler must never break the fold */ }
    return [];
  }

  /**
   * Winter's tool name → Norma's (ruling P8b-25). An unknown name passes through unchanged and is
   * logged once: a tool row with an unfamiliar label is a cosmetic surprise, whereas dropping the
   * call or inventing a name would corrupt the transcript and break the `callId` linkage the Mac
   * and iOS renderers fold on. The table is `projector/tool-names.ts` TODAY and moves to the
   * policy lane's canonical `runtime-sdk/tool-names.ts` in Task 11.
   */
  private renameTool(winterName: string): string {
    const norma = normaToolNameFor(winterName);
    if (norma !== undefined) return norma;
    if (!this.loggedToolNames.has(winterName)) {
      this.loggedToolNames.add(winterName);
      this.deps.log.debug?.("[projector] no Norma name for a Winter tool — passing it through", {
        sessionId: this.deps.sessionId, tool: winterName,
      });
    }
    return winterName;
  }

  /** Commit the previous message's mark — by now the caller has had its chance to append. */
  private commitPending(): void {
    const mark = this.pending;
    if (mark === undefined) return;
    this.pending = undefined;
    try {
      this.checkpoint.complete(
        { winterSessionId: this.winterSessionId, generation: this.generation, sourceId: mark.sourceId },
        {
          runtimeKind: this.deps.runtimeKind ?? "winter-agent",
          ...(this.backendSessionId === undefined ? {} : { backendSessionId: this.backendSessionId }),
          backendCursor: mark.cursor,
          lastWinterSeq: mark.last,
        },
        { first: mark.first, last: mark.last },
      );
    } catch (err) {
      // A failed commit leaves the mark `pending`, which recovery resolves against the log tail.
      // Throwing here would abort the caller's iteration over a bookkeeping failure, losing the
      // rest of a turn that is otherwise fine.
      this.deps.log.warn?.("[projector] checkpoint commit failed — left pending for recovery", {
        sourceId: mark.sourceId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Hook rows, `rate_limit_event`, `auth_status`, status/compaction rows and every Winter-only
   * extension message (P8b-8, P8b-21): observed, never persisted, and logged through
   * `hooks.ts`'s PER-FAMILY FIELD ALLOWLIST — a type, a subtype and a handful of named scalars.
   * Never `JSON.stringify(msg)`: `system/reasoning_summary` carries a foreign model's reasoning
   * text, `model_refusal_*` carries an explanation §4.7 marks display-only and never to be parsed,
   * and `continuity_warning.detail` is prose about identity. None of it is cleared for a log line.
   * One line per distinct kind keeps a 429 storm from filling the log.
   */
  private logSkipped(msg: ProtocolSdkMessage): void {
    const kind = kindOf(msg);
    if (this.loggedTypes.has(kind)) return;
    this.loggedTypes.add(kind);
    const fields = { sessionId: this.deps.sessionId, ...summarize(msg) };
    if (isKnownUnpersistedKind(kind)) this.deps.log.debug?.("[projector] observed, deliberately not persisted", fields);
    else this.deps.log.debug?.("[projector] unrecognised wire message — nothing projected", fields);
  }

  /** Assign `seq`/`ts`. A transient reuses `lastSeq`; everything else consumes the next one. */
  private stamp(events: ProjectedEvent[]): SessionEvent[] {
    const ts = Date.parse(this.deps.now());
    return events.map((e) => {
      const transient = TRANSIENT_EVENT_TYPES.has(e.type);
      const seq = transient ? this.lastSeq : (this.lastSeq = this.deps.nextSeq());
      return { ...e, seq, ts: Number.isFinite(ts) ? ts : Date.now() } as SessionEvent;
    });
  }
}
