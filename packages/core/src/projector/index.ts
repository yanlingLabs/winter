import { TRANSIENT_EVENT_TYPES, type SessionEvent } from "@yanlinglabs/winter-protocol";
import {
  MAIN_THREAD, asApiRetryFrame, asAssistantFrame, asInitFrame, asMirrorErrorFrame, asResultFrame, asStreamEventFrame,
  asUserFrame, assistantText, deltaText, hasToolResults, threadIdOf, toolCalls, toolResults, userText,
} from "./conversation";
import {
  applyTodoResult, backgroundStopReason, childFromSpawn, isSpawnTool, pendingTodoFrom, spawnOutcome, threadCompleted,
  threadStarted, type ChildRecord, type PendingTodoCall, type TaskRow,
} from "./children";
import { createEchoWindow, type EchoWindow } from "./dedupe";
import { classifyThrown, sanitizeDetail } from "./errors";
import { isKnownUnpersistedKind, kindOf, summarize } from "./hooks";
import { isQuestionTool } from "./questions";
import { projectTerminal, sharesMainLedgerRow, totalsOf, turnUsageOf, type MainModelKey, type UsageTotals } from "./terminal";
import { hostToolNameFor } from "../runtime-sdk/tool-names";
import { ProjectorRefusedError } from "./types";
import type { CheckpointStore, ProjectedBatch, ProjectedEvent, Projector, ProjectorDeps, ProjectorRefusal, ProtocolSdkMessage } from "./types";

export { PROJECTED_EVENT_COVERAGE, SUBAGENT_TRANSCRIPT_INCLUDE } from "./event-coverage";
export { createEchoWindow, ECHO_WINDOW, type EchoWindow } from "./dedupe";
export { projectTerminal, sharesMainLedgerRow, totalsOf, turnUsageOf, type MainModelKey, type UsageTotals } from "./terminal";
export {
  AGENT_ERROR_CODES, classifyResult, classifyThrown, codeForHttpStatus, sanitizeDetail,
  type AgentErrorCode, type ClassifiedError,
} from "./errors";
export {
  applyTodoResult, backgroundStopReason, childFromSpawn, isSpawnTool, isTodoTool, pendingTodoFrom, spawnOutcome,
  threadCompleted, threadStarted, type ChildRecord, type HostTaskStatus, type PendingTodoCall, type SpawnOutcome,
  type TaskRow, type ThreadStopReason,
} from "./children";
export { UNPERSISTED_KINDS, isKnownUnpersistedKind, kindOf, summarize } from "./hooks";
export { QUESTION_TOOLS, isQuestionTool } from "./questions";
export { MAIN_THREAD, threadIdOf } from "./conversation";
export { hostToolNameFor } from "../runtime-sdk/tool-names";
export { ProjectorRefusedError } from "./types";
export type {
  CheckpointStore, Logger, ProjectedBatch, ProjectedEvent, ProjectionCursorInput, ProjectionKey,
  Projector, ProjectorDeps, ProjectorRefusal, ProtocolSdkMessage, SessionMode,
} from "./types";

/**
 * ── THE SDK → SessionEvent PROJECTOR ────────────────────────────────────────────────────────────
 *
 * Conversation, terminal and idempotency (Task 10); children, the task graph, error classes and the
 * observed-never-persisted families (Task 11).
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

/** A fresh empty batch. A shared frozen object would be a foot-gun the day a caller mutates one. */
const EMPTY_BATCH = (): ProjectedBatch => ({ persist: [], broadcast: [] });

/** The `clientName` the projector stamps on the ONE `user_message` it produces itself — a `user`
 *  text frame the host never pushed (a resume prompt, a send_message drain). The driver's log scan
 *  (`unconsumedUserMessages`, P8b-39) reads it to tell the child's text from the host's debts. */
export const PROJECTOR_PASSTHROUGH_CLIENT = "winter";

/** `totalsOf`'s parameter, narrowed to what it actually reads. */
type ResultFrameLike = Parameters<typeof totalsOf>[0];

const HOST_TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "deleted"]);

/**
 * `system/init` → how to find this session's own `modelUsage` row (0.0.17, P-B1).
 *
 * `winter_provider` is the Winter runtime's own init EXTENSION (`engine.ts`'s `buildSdkInitMessage`),
 * and its `modelKey` is documented to ALWAYS equal the ledger's row key. It is absent for a session
 * with no resolved provider identity (a `winter-test/*` double) and on the official leg, where
 * `init.model` and the `modelUsage` keys are the same vendor id — so `key` falls back to `init.model`
 * and that leg's behaviour is unchanged. `modelId` stays `init.model` verbatim for the suffix rung.
 */
function mainModelKeyFrom(init: Record<string, unknown>): MainModelKey | undefined {
  const model = typeof init.model === "string" && init.model.length > 0 ? init.model : undefined;
  const provider = init.winter_provider;
  const modelKey = typeof provider === "object" && provider !== null && typeof (provider as { modelKey?: unknown }).modelKey === "string"
    && ((provider as { modelKey: string }).modelKey).length > 0
    ? (provider as { modelKey: string }).modelKey
    : undefined;
  const key = modelKey ?? model;
  if (key === undefined && model === undefined) return undefined;
  return { ...(key === undefined ? {} : { key }), ...(model === undefined ? {} : { modelId: model }) };
}

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
  /** Turns the HOST has pushed and the projector has not yet terminated (M1's push-keyed rule). */
  private openTurns = 0;
  /** A frame has arrived since the last terminal — the FALLBACK half of "is a turn open?". */
  private sawFrame = false;
  private roundIndex = 0;
  /** `assistant` frames seen in the current turn — 1 is what makes `contextTokens` exact. */
  private roundsThisTurn = 0;
  private totals: UsageTotals | undefined;
  private pending: PendingMark | undefined;
  private messageIndex = 0;
  private backendSessionId: string | undefined;
  /**
   * How to find the session's own `modelUsage` row, which keys `contextTokens` (m6).
   *
   * 0.0.17 (P-B1): `init.winter_provider.modelKey` is the ROW KEY verbatim (the qualified
   * `provider/model` catalog key), while `init.model` is the BARE id the daemon passed at the spawn
   * boundary — so both are kept, and `totalsOf` tries the key first and the `/${modelId}` suffix
   * second. The official leg sends no `winter_provider`, so there `key === init.model` and the
   * behaviour is byte-identical to before this release.
   */
  private mainModel: MainModelKey | undefined;
  /**
   * 0.0.17 (P-B1 item 3): has a subagent or a web tool's inner pass been able to spend on the MAIN
   * ledger row since the previous terminal?
   *
   * DELIBERATELY NOT reset at `beginTurn`/`init` — only at a terminal. A background child finishes
   * while the session is idle and its spend lands in the cumulative ledger BETWEEN turns, so a flag
   * cleared at turn start would miss exactly the case that motivated this fix.
   */
  private sharedRowActivity = false;
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
  /** Child threads whose spawn LAUNCHED them in the background (`run_in_background`): kept open past
   *  the spawn's `tool_result`, keyed by threadId (= the spawning tool_use id), until a background-
   *  task terminal frame names them (`acceptTaskFrame`). */
  private readonly backgroundChildren = new Set<string>();
  /** Background-task id → child threadId, learned from `system/task_started.tool_use_id` and from a
   *  Winter async result's `taskId` — the only correlator a `task_updated` patch carries. */
  private readonly taskToThread = new Map<string, string>();
  /** `TaskCreate`/`TaskUpdate` calls awaiting their `tool_result`, keyed by the call's `tool_use.id`
   *  — cleared as soon as the result resolves (see `applyTodoResult`). */
  private readonly pendingTodos = new Map<string, PendingTodoCall>();
  /** The session's to-do rows, mirrored from resolved `TaskCreate`/`TaskUpdate` results. A SEPARATE
   *  map from `tasks` (above): the to-do list and the background-task registry are two distinct
   *  SDK-side stores with no shared ids, and conflating them would let one's rows silently patch
   *  the other's. */
  private readonly todos = new Map<string, TaskRow>();
  /** Whether `todos` has been seeded from `deps.priorTodos` yet (lazily, on first need). */
  private todosSeeded = false;
  /** Every refusal this projector made, in order — surfaced rather than dropped. */
  private readonly refused: ProjectorRefusal[] = [];
  /** True once this turn's terminal has been emitted, so an "error-result-then-throw" ResultError
   *  is recognised as the pair of a result already projected rather than projected twice. */
  private terminalEmitted = false;
  /**
   * C2 (2026-09-22): pushes the host made while one of its turns was still open, in PUSH order —
   * each is a turn the child will run after the ones ahead of it. `announced` is set once its
   * `turn_started` is out (early, through `announceQueuedTurns`), so its own start does not announce
   * it again. One entry is shifted per projected terminal: the turn that starts next.
   */
  private readonly queuedStarts: Array<{ announced: boolean }> = [];

  /** Seed the to-do map from the session's persisted rows, once — see `ProjectorDeps.priorTodos`.
   *  Never throws: a failed read leaves the map empty, which is today's behaviour. */
  private seedTodosOnce(): void {
    if (this.todosSeeded) return;
    this.todosSeeded = true;
    try {
      for (const t of this.deps.priorTodos?.() ?? []) {
        if (this.todos.has(t.id) || !HOST_TODO_STATUSES.has(t.status)) continue;
        this.todos.set(t.id, {
          id: t.id, subject: t.subject, status: t.status as TaskRow["status"],
          ...(t.activeForm === undefined ? {} : { activeForm: t.activeForm }),
        });
      }
    } catch (err) {
      this.deps.log.warn?.("[projector] could not seed prior to-do rows", { sessionId: this.deps.sessionId, error: String(err) });
    }
  }

  constructor(private readonly deps: ProjectorDeps) {
    this.checkpoint = deps.checkpoint;
    this.winterSessionId = deps.winterSessionId ?? deps.sessionId;
    this.generation = deps.generation;
    this.echo = createEchoWindow();
  }

  get turnRunning(): boolean { return this.openTurns > 0 || this.sawFrame; }

  /**
   * The host pushed a user turn (M1, review r1). See `Projector.beginTurn` for why this door exists
   * at all; in short, the brief's terminal rule is PUSH-keyed and a projector with no push input can
   * only approximate it frame-keyed — an approximation that silently dropped the `turn_completed` of
   * any turn whose first event was its terminal.
   *
   * It does three things: opens a turn (so exactly one `result` is expected for it), records the
   * pushed text in the echo window (the only thing that makes `dedupe.ts` reachable), and returns
   * the `turn_started` the host appends beside its own `user_message`.
   *
   * It does NOT return a `user_message`: the host appends that itself (P8b-5). It DOES return the
   * `turn_started`, and the host appends THAT event rather than one of its own — see
   * `PROJECTED_EVENT_COVERAGE.turn_started` for what two producers would cost.
   *
   * ── A MID-TURN STEER IS NOT A NEW BEGUN TURN ────────────────────────────────────────────────
   *
   * `session.send` and `session.steer` are both pushes into the same host-owned queue (P8b-5), but
   * they differ in exactly the way this door cares about: `send` starts a turn, while `steer` joins
   * the turn already running (the child drains it at its next round top). So the rule stays "ONE
   * `result` per begun turn", and **a steer must not call `beginTurn`** — under the current
   * understanding it produces no terminal of its own, and an extra `beginTurn` would leave
   * `openTurns` permanently ≥ 1, silently weakening the guard so a stray or duplicate `result` is
   * projected instead of dropped. It would also put a mid-turn `turn_started` in the log, which the
   * engine never emits.
   *
   * **THIS IS NOT MEASURED, AND IT IS A TASK 16 MEASUREMENT OBLIGATION.** Task 10's recording
   * deliberately gated its second envelope on the first `result` "so the turns stay separable", so
   * it says nothing about a mid-turn push. Drive a `steer` against the built binary and COUNT the
   * `result`s: if a steered-in message terminates on its own, the driver must call `beginTurn` for
   * the steer too — otherwise that terminal is dropped by the `openTurns === 0 && !sawFrame` guard
   * whenever the steer produced no frames first, which is the same defect this door was added to
   * fix, on the steer path.
   */
  beginTurn(input: { text: string; at?: string }): ProjectedBatch {
    this.commitPending();
    // C2 (2026-09-22): P8b-38 settled the measurement above — on the Winter wire a mid-turn push IS
    // its own turn, and the child runs it AFTER the running one ends. So its `turn_started` is held
    // and announced right after the running turn's terminal (see `announceQueuedTurns`).
    const running = this.openTurns > 0;
    this.openTurns++;
    this.echo.pushed(input.text);
    if (running && this.holdsTurnStarts) {
      this.queuedStarts.push({ announced: false });
      return EMPTY_BATCH();
    }
    return this.stampBatch([this.turnStarted()]);
  }

  announceQueuedTurns(): ProjectedBatch {
    const out: ProjectedEvent[] = [];
    for (const q of this.queuedStarts) {
      if (q.announced) continue;
      q.announced = true;
      out.push(this.turnStarted());
    }
    return out.length === 0 ? EMPTY_BATCH() : this.stampBatch(out);
  }

  private turnStarted(): ProjectedEvent {
    return { type: "turn_started", sessionId: this.deps.sessionId, threadId: MAIN_THREAD };
  }

  /**
   * Only the Winter leg holds a mid-turn push's `turn_started` (C2). The OFFICIAL leg's child is
   * claude, which folds a message that arrives mid-turn INTO the running turn (a `queued_command`
   * attachment at the next tool round — no terminal of its own), so a held announcement there would
   * be released by a terminal that is not its own and leave a `turn_started` no `turn_completed`
   * ever follows. That leg keeps the push-time announcement (its steer accounting is its own carry,
   * `official-session.ts`'s "UNMEASURED" note).
   */
  private get holdsTurnStarts(): boolean { return (this.deps.runtimeKind ?? "winter-agent") === "winter-agent"; }
  get lastResultAt(): string | undefined { return this.resultAt; }

  accept(msg: ProtocolSdkMessage): ProjectedBatch {
    this.commitPending();
    this.messageIndex++;

    // ── transient: never checkpointed, never persisted ──────────────────────────────────────────
    const stream = asStreamEventFrame(msg);
    if (stream !== undefined) {
      const delta = deltaText(stream);
      if (delta === undefined) return EMPTY_BATCH();
      this.running = true;
      this.sawFrame = true;
      return this.stampBatch([{ type: "assistant_delta", sessionId: this.deps.sessionId, threadId: threadIdOf(stream), delta }]);
    }

    // ── consumed, nothing persisted ─────────────────────────────────────────────────────────────
    const init = asInitFrame(msg);
    if (init !== undefined) {
      this.backendSessionId = typeof init.session_id === "string" ? init.session_id : undefined;
      this.mainModel = mainModelKeyFrom(init);
      this.deps.log.debug?.("[projector] session init", {
        sessionId: this.deps.sessionId, mode: this.deps.mode,
        model: typeof init.model === "string" ? init.model : undefined,
        tools: Array.isArray(init.tools) ? init.tools.length : 0,
      });
      return EMPTY_BATCH();
    }

    // 0.0.17 (P-B1): an in-runtime `session.setModel` RE-KEYS the ledger row and emits NO second
    // `system/init` (only an unsolicited turn does), so a projector that learned the row key from
    // `init` alone would keep matching the OLD row for the rest of the session — a zero delta and a
    // silently absent `contextTokens`. `system/model_switch.to_model` is the new key (the engine
    // announces both ids as catalog keys for a resolved switch; an unresolved one may still be bare,
    // which is why the bare tail is derived rather than assumed). NOT consumed here — no `return`:
    // the frame falls through to the same "known unpersisted kind" log line it has always taken.
    if (kindOf(msg) === "system/model_switch") {
      const to = (msg as Record<string, unknown>).to_model;
      if (typeof to === "string" && to.length > 0) {
        const slash = to.lastIndexOf("/");
        this.mainModel = { key: to, modelId: slash >= 0 ? to.slice(slash + 1) : to };
        // The DELTA is rebased too, and it must be: `previous.main` is the OLD row's cumulative
        // input, and the new row starts at zero from here — subtracting one from the other would
        // answer 0 for the first turn on the new model (an absent `contextTokens` at exactly the
        // moment a client most wants one) and would under-report every turn after it. The two
        // whole-ledger baselines are untouched: they sum every row, which a switch does not reset.
        if (this.totals !== undefined) this.totals = { ...this.totals, main: 0, mainExact: true };
      }
    }

    // ── the official leg's mirror error (P8c-11 / Task 2.2, provisional shape — see
    // `asMirrorErrorFrame`'s doc comment) — never persisted, never broadcast; the ONE side effect
    // the batch carries besides the two event sinks. `sanitizeDetail` is the same opaque-marker
    // filter `errors.ts` uses for `agent_error.message`: a mirror failure can in principle name a
    // provider payload, and this log line is not the session JSONL.
    // No `claimed`/checkpoint guard here (review r1, minor): the flag this sets is idempotent —
    // re-marking an already `"repair-required"` record a second time on a replay changes nothing
    // — and the wire shape itself is provisional (see `asMirrorErrorFrame`'s doc comment). Revisit
    // once the real recorded shape lands, in case it turns out NOT idempotent to re-apply.
    const mirrorError = asMirrorErrorFrame(msg);
    if (mirrorError !== undefined) {
      this.deps.log.warn?.("[projector] the official leg reported a mirror error — this session's transcript health is repair-required", {
        sessionId: this.deps.sessionId, ...(sanitizeDetail(mirrorError.detail) !== undefined ? { detail: sanitizeDetail(mirrorError.detail) } : {}),
      });
      return { persist: [], broadcast: [], transcriptHealth: "repair-required" };
    }

    const claim = (sourceId: string, produce: () => ProjectedEvent[]): ProjectedBatch => this.claimed(sourceId, produce);

    const assistant = asAssistantFrame(msg);
    if (assistant !== undefined) {
      this.running = true;
      this.sawFrame = true;
      this.roundIndex++;
      this.roundsThisTurn++;
      const threadId = threadIdOf(assistant);
      const firstToolUse = assistant.message.content.find((b) => b.type === "tool_use" && typeof b.id === "string");
      const sourceId = firstToolUse !== undefined ? `tu:${firstToolUse.id as string}` : `as:${this.turnIndex}:${this.roundIndex}`;
      // 0.0.17 (P-B1 item 3): OUTSIDE the `claim`, deliberately — a replayed prefix produces no
      // events but its calls DID spend, and this flag is about the ledger, not about the transcript.
      for (const b of assistant.message.content) {
        if (b.type !== "tool_use" || typeof b.name !== "string") continue;
        if (isSpawnTool(b.name) || sharesMainLedgerRow(b.name)) this.sharedRowActivity = true;
      }
      return claim(sourceId, () => {
        const out: ProjectedEvent[] = [];
        const text = assistantText(assistant);
        if (text.length > 0) out.push({ type: "assistant_message", sessionId: this.deps.sessionId, threadId, text });
        out.push(...toolCalls(assistant, this.deps.sessionId, threadId, (n) => this.renameTool(n)));
        // A spawning call opens a child thread. `thread_started` follows its own `tool_call` so the
        // transcript reads parent-call-then-child, and the child's threadId IS the tool_use id —
        // the same identifier its spawn's `tool_result` and its background-task frames carry
        // (`tool_use_id`), which is what closes the thread (see children.ts's `spawnOutcome`).
        for (const b of assistant.message.content) {
          if (b.type !== "tool_use" || typeof b.name !== "string") continue;
          if (isQuestionTool(b.name) && !this.loggedToolNames.has(`?${b.name}`)) {
            this.loggedToolNames.add(`?${b.name}`);
            this.deps.log.debug?.("[projector] a question tool call — its question_asked/question_resolved pair is the question bridge's, joined on callId", {
              sessionId: this.deps.sessionId, tool: b.name,
            });
          }
          // `TaskCreate`/`TaskUpdate` never appear on the wire again after this — their store emits
          // no frame of its own (`children.ts`'s module doc) — so the call's own input is stashed
          // here, keyed by this block's id, for its `tool_result` to resolve below.
          const pendingTodo = pendingTodoFrom(b);
          if (pendingTodo !== undefined && typeof b.id === "string" && b.id.length > 0) this.pendingTodos.set(b.id, pendingTodo);
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
      this.sawFrame = true;
      this.roundIndex++;
      const threadId = threadIdOf(userFrame);
      if (hasToolResults(userFrame)) {
        // C2 (2026-09-22): the child is done with these calls, so no human can still be owed an
        // answer for them — settled BEFORE this frame is stamped (see `ProjectorDeps.onToolResults`).
        this.settleCalls(userFrame.message.content
          .filter((b) => b.type === "tool_result" && typeof b.tool_use_id === "string" && b.tool_use_id.length > 0)
          .map((b) => b.tool_use_id as string));
        const firstResult = userFrame.message.content.find((b) => b.type === "tool_result" && typeof b.tool_use_id === "string");
        const sourceId = `tr:${(firstResult?.tool_use_id as string | undefined) ?? `${this.turnIndex}:${this.roundIndex}`}`;
        return claim(sourceId, () => {
          const out = toolResults(userFrame, this.deps.sessionId, threadId);
          const resultBlocks = userFrame.message.content.filter((b) => b.type === "tool_result");
          // `tool_use_result` is FRAME-level (the official leg's structured result); it can only be
          // attributed to a block when the frame carries exactly one.
          const frameToolUseResult = resultBlocks.length === 1 ? (userFrame as unknown as Record<string, unknown>).tool_use_result : undefined;
          for (const b of userFrame.message.content) {
            if (b.type !== "tool_result") continue;
            const callId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
            if (callId === undefined) continue;
            const pendingTodo = this.pendingTodos.get(callId);
            if (pendingTodo !== undefined) {
              this.pendingTodos.delete(callId);
              this.seedTodosOnce();
              const todoEvent = applyTodoResult(this.todos, pendingTodo, b, this.deps.sessionId);
              if (todoEvent !== undefined) out.push(todoEvent);
              else {
                this.deps.log.debug?.("[projector] a TaskCreate/TaskUpdate result produced no task_updated — a failed call, an untracked row, or an unparseable result", {
                  sessionId: this.deps.sessionId, callId,
                });
              }
            }
            if (!this.children.has(callId)) continue;
            const outcome = spawnOutcome(b, frameToolUseResult);
            if (outcome.kind === "background") {
              // The spawn only LAUNCHED the child: it is running now. Keep the thread open; the
              // background-task terminal frame closes it (`acceptTaskFrame`).
              this.backgroundChildren.add(callId);
              if (outcome.taskId !== undefined) this.taskToThread.set(outcome.taskId, callId);
              continue;
            }
            this.children.delete(callId);
            for (const [t, th] of this.taskToThread) if (th === callId) this.taskToThread.delete(t);
            if (outcome.failed) {
              // The wire may carry no error flag for a failed spawn (the engine drops a returned
              // `isError`), so the row that says so is corrected here too.
              for (const e of out) if (e.type === "tool_result" && e.callId === callId) e.isError = true;
            }
            out.push(threadCompleted(callId, outcome.stopReason, this.deps.sessionId));
          }
          return out;
        });
      }
      // A text-only `user` frame is NOT an echo of a host push on the 0.0.3 wire (measured: the
      // runtime never re-emits the host's input frames) — it is an inbound delivery rendered into
      // the child's input. The echo window is consulted anyway, so a future echo is dropped here
      // rather than double-appended; see dedupe.ts.
      const text = userText(userFrame).trim();
      if (text.length === 0) return EMPTY_BATCH();
      if (this.echo.shouldDropEcho(text)) {
        this.deps.log.debug?.("[projector] dropped an echoed host push", { sessionId: this.deps.sessionId });
        return EMPTY_BATCH();
      }
      return claim(`um:${this.turnIndex}:${this.roundIndex}`, () => [
        { type: "user_message", sessionId: this.deps.sessionId, threadId, text, clientName: PROJECTOR_PASSTHROUGH_CLIENT },
      ]);
    }

    const resultFrame = asResultFrame(msg);
    if (resultFrame !== undefined) {
      // ── EXACTLY ONE TERMINAL PER BEGUN TURN (M1, review r1) ──────────────────────────────────
      //
      // The rule is PUSH-keyed: one `result` per turn the host pushed. `openTurns` is that count.
      // The `sawFrame` fallback keeps a driver that has not been taught `beginTurn` — and every
      // replay harness feeding a recorded stream — working exactly as before: a turn that produced
      // frames is evidently a turn. What only `beginTurn` can rescue is a turn whose FIRST event is
      // its terminal (the user hits stop before the first token; the second envelope of the
      // recorded tooluse run), and dropping that terminal hangs the client's spinner forever with
      // every unit test green. That was the defect.
      if (this.openTurns === 0 && !this.sawFrame) {
        this.deps.log.warn?.("[projector] a result arrived with no begun turn and no frames — protocol violation, dropped", {
          sessionId: this.deps.sessionId, subtype: resultFrame.subtype,
        });
        return EMPTY_BATCH();
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
      // C1 (2026-09-22): a result with no ledger but a claude-shaped per-turn `usage` is NOT this
      // case — its figures are reported (`terminal.ts`'s `turnUsageOf`), so the line would lie.
      if (totalsOf(msg as ResultFrameLike, this.mainModel) === undefined && turnUsageOf(resultFrame) === undefined && !this.loggedUnpricedUsage) {
        this.loggedUnpricedUsage = true;
        this.deps.log.debug?.("[projector] the result carries no modelUsage (unpriced catalog row) — token counts report 0 and contextTokens is omitted", {
          sessionId: this.deps.sessionId,
        });
      }
      // 0.0.17 (P-B1 item 3): a BACKGROUND child still open at the terminal has been spending in
      // this very window whether or not a frame said so — the same reading as a `task_*` frame.
      const sawSharedRowActivity = this.sharedRowActivity || this.backgroundChildren.size > 0;
      const events = claim(sourceId, () => {
        const out = projectTerminal({
          result: resultFrame, sessionId: this.deps.sessionId, threadId: MAIN_THREAD,
          previous: this.totals, rounds, ...(this.mainModel === undefined ? {} : { mainModel: this.mainModel }),
          ...(sawSharedRowActivity ? { sawSharedRowActivity } : {}),
        });
        this.totals = out.totals ?? this.totals;
        return out.events;
      });
      // The turn closes whether or not the result projected (a replayed prefix must still advance
      // the turn counter, or every later source id would collide with the first pass's).
      this.turnIndex++;
      this.roundIndex = 0;
      this.roundsThisTurn = 0;
      // 0.0.17 (P-B1 item 3): the window this flag covers is TERMINAL-to-terminal, not turn-start to
      // terminal — see the field's own doc comment for the background child that spends between turns.
      this.sharedRowActivity = false;
      this.running = false;
      this.sawFrame = false;
      if (this.openTurns > 0) this.openTurns--;
      this.terminalEmitted = true;
      this.resultAt = this.deps.now();
      // C2: the turn queued next starts NOW — its `turn_started` follows this `turn_completed`, in
      // the same batch, unless `announceQueuedTurns` already put it out. Stamped outside the claim,
      // exactly like `beginTurn`'s own: a `turn_started` is the host's push, not a projected source.
      const next = this.queuedStarts.shift();
      if (next !== undefined && !next.announced) {
        const started = this.stampBatch([this.turnStarted()]);
        return { ...events, persist: [...events.persist, ...started.persist] };
      }
      return events;
    }

    const retry = asApiRetryFrame(msg);
    if (retry !== undefined) {
      // A retry attempt is PROGRESS, not failure (hooks.ts's "observed, never persisted" rule still
      // holds: `provider_retry` is TRANSIENT). The wire fields are the SDK's own; `error` is the class
      // word, never a body (hooks.ts's allowlist) — so nothing here can carry a secret.
      const status = typeof retry.error_status === "number" && Number.isFinite(retry.error_status) ? retry.error_status : null;
      const message = typeof retry.error === "string" ? retry.error.slice(0, 200) : "";
      return this.stampBatch([{
        type: "provider_retry", sessionId: this.deps.sessionId, threadId: MAIN_THREAD,
        attempt: Math.max(1, Math.floor(retry.attempt)), maxRetries: Math.max(0, Math.floor(retry.max_retries)),
        retryDelayMs: typeof retry.retry_delay_ms === "number" && Number.isFinite(retry.retry_delay_ms) ? Math.max(0, Math.floor(retry.retry_delay_ms)) : 0,
        status, message,
      }]);
    }
    const task = this.acceptTaskFrame(msg);
    if (task !== undefined) return task;

    this.logSkipped(msg);
    return EMPTY_BATCH();
  }

  /**
   * The background-task frames (`system/task_*`) — see `children.ts`'s "background tasks vs the
   * to-do list" doc. They NEVER produce `task_updated` (the to-do list is `applyTodoResult`'s alone).
   * Their one persisted effect is closing an open BACKGROUND child thread:
   *
   *   task_started       → learn `task_id → threadId` when its `tool_use_id` is a child we opened
   *   task_notification  → terminal: close the thread it names (`tool_use_id`, else `task_id`)
   *   task_updated       → a terminal `patch.status` closes the thread its `task_id` maps to
   *   task_progress      → observed only
   *
   * No `task_type` filter: Winter says `agent` and Claude Code says `local_agent`, and matching on
   * the projector's own child maps already excludes bash/workflow/monitor frames (and a foreground
   * agent's late notification — Claude Code emits one for sync agents too — whose thread closed at
   * its tool_result). The claim key `tc:<threadId>` is stable across a replay, so a second terminal
   * for the same thread is a no-op both in memory and in the checkpoint store.
   *
   * Returns `undefined` (not `[]`) when the message is not a task frame, so `accept` can tell "not
   * mine" from "mine, and it projected nothing".
   */
  private acceptTaskFrame(msg: ProtocolSdkMessage): ProjectedBatch | undefined {
    const kind = kindOf(msg);
    if (kind !== "system/task_started" && kind !== "system/task_updated" && kind !== "system/task_notification" && kind !== "system/task_progress") return undefined;
    const m = msg as Record<string, unknown>;
    // 0.0.17 (P-B1 item 3): a task frame of ANY kind is a child that ran — set before every early
    // return below, because a frame this projector cannot attribute to a thread (no `task_id`, an
    // unknown id, a non-terminal status) still names spend that landed in the cumulative ledger.
    this.sharedRowActivity = true;
    const taskId = typeof m.task_id === "string" && m.task_id.length > 0 ? m.task_id : undefined;
    if (taskId === undefined) return undefined;
    const toolUseId = typeof m.tool_use_id === "string" && m.tool_use_id.length > 0 ? m.tool_use_id : undefined;

    if (kind === "system/task_started") {
      if (toolUseId !== undefined && this.children.has(toolUseId)) this.taskToThread.set(taskId, toolUseId);
      this.logSkipped(msg);
      return EMPTY_BATCH();
    }
    const stopReason = kind === "system/task_notification" ? backgroundStopReason(m.status)
      : kind === "system/task_updated" && typeof m.patch === "object" && m.patch !== null ? backgroundStopReason((m.patch as Record<string, unknown>).status)
        : undefined;
    const threadId = toolUseId !== undefined && this.backgroundChildren.has(toolUseId) ? toolUseId : this.taskToThread.get(taskId);
    if (stopReason === undefined || threadId === undefined || !this.backgroundChildren.has(threadId)) {
      this.logSkipped(msg);
      return EMPTY_BATCH();
    }
    this.backgroundChildren.delete(threadId);
    this.children.delete(threadId);
    this.taskToThread.delete(taskId);
    return this.claimed(`tc:${threadId}`, () => [threadCompleted(threadId, stopReason, this.deps.sessionId)]);
  }

  flush(): void { this.commitPending(); }

  /** `deps.onToolResults`, never allowed to break the fold (a driver's own bookkeeping). */
  private settleCalls(callIds: string[]): void {
    if (callIds.length === 0 || this.deps.onToolResults === undefined) return;
    try {
      this.deps.onToolResults(callIds);
    } catch (err) {
      this.deps.log.warn?.("[projector] onToolResults threw — ignored", { sessionId: this.deps.sessionId, error: err instanceof Error ? err.name : "unknown" });
    }
  }

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
  acceptError(err: unknown): ProjectedBatch {
    this.commitPending();
    const classified = classifyThrown(err);
    const name = err instanceof Error ? err.name : "";
    if (name === "ResultError" && this.terminalEmitted) {
      this.deps.log.debug?.("[projector] ResultError for a result already projected — the error-result-then-throw pair", {
        sessionId: this.deps.sessionId, code: classified.code,
      });
      return EMPTY_BATCH();
    }
    if (!this.turnRunning) {
      this.deps.log.warn?.("[projector] the stream failed with no turn running", { sessionId: this.deps.sessionId, code: classified.code });
      return EMPTY_BATCH();
    }
    this.running = false;
    this.sawFrame = false;
    if (this.openTurns > 0) this.openTurns--;
    // C2: the stream is gone, and every push still queued behind the failed turn died with the child.
    // Nothing is announced for them — a push with no `turn_started` after its `user_message` is
    // exactly what the next incarnation's `unconsumed` scan re-pushes.
    this.queuedStarts.length = 0;
    this.resultAt = this.deps.now();
    this.turnIndex++;
    this.roundIndex = 0;
    this.roundsThisTurn = 0;
    this.sharedRowActivity = false;   // same terminal-to-terminal window as the result path above
    // An abort is a TURN BOUNDARY, never an error (ruling P8b-24) — the same rule `terminal.ts`
    // applies to `result.interrupted`, applied here so a thrown AbortError cannot smuggle an
    // `agent_error` past it.
    const aborted = classified.code === "aborted";
    return this.stampBatch(aborted
      ? [{ type: "turn_completed", sessionId: this.deps.sessionId, threadId: MAIN_THREAD, stopReason: "aborted", inputTokens: 0, outputTokens: 0 }]
      : [
          { type: "agent_error", sessionId: this.deps.sessionId, threadId: MAIN_THREAD, message: classified.message, code: classified.code },
          { type: "turn_completed", sessionId: this.deps.sessionId, threadId: MAIN_THREAD, stopReason: "error", inputTokens: 0, outputTokens: 0 },
        ]);
  }

  /**
   * Claim a source, project it, and leave the mark open for the next `accept` to commit.
   *
   * ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE (m9, review r1): `produce()` runs BEFORE `begin()`.
   * A message that yields no PERSISTED event — an empty assistant frame, a task patch that says
   * nothing this schema can express — must not write a `projection_applied` row, because such a row
   * describes a source that can never appear in the product log, and recovery would then hunt for
   * an append that was never going to happen. Producing first is what makes "claim only what will
   * be appended" expressible; `produce()` is pure enough for that (its only side effects — the
   * child map, the task-row mirror — are ones a replay should perform anyway).
   */
  private claimed(sourceId: string, produce: () => ProjectedEvent[]): ProjectedBatch {
    const produced = produce();
    const persistedCount = produced.filter((e) => !TRANSIENT_EVENT_TYPES.has(e.type)).length;
    if (persistedCount === 0) return this.stampBatch(produced);

    const key = { winterSessionId: this.winterSessionId, generation: this.generation, sourceId };
    const verdict = this.checkpoint.begin(key);
    if (verdict === "already-committed") {
      // WARN, not debug (M2, review r1). A LIVE stream should never meet a committed mark; the way
      // it happens is a resume that re-used its generation, and the symptom is a silent transcript
      // hole on exactly the path that must not lose events. A deliberate re-read (recovery, a
      // mirror catch-up) will log these too — which is the right trade: noise on an intentional
      // replay beats silence on an accidental one. The ids are here so the cause is readable.
      this.deps.log.warn?.("[projector] source already projected — skipping; on a live stream this means a resume that did not bump `generation`", {
        sessionId: this.deps.sessionId, winterSessionId: this.winterSessionId,
        generation: this.generation, sourceId,
      });
      return EMPTY_BATCH();
    }
    if (verdict === "pending-elsewhere") this.refuse(sourceId);

    const batch = this.stampBatch(produced);
    const first = batch.persist[0]?.seq ?? this.lastSeq;
    const last = batch.persist[batch.persist.length - 1]?.seq ?? this.lastSeq;
    this.pending = { sourceId, first, last, cursor: `${this.turnIndex}:${this.messageIndex}` };
    return batch;
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
   * **IT THROWS `ProjectorRefusedError`.** The refusal is also appended to `refusals` and handed to
   * `deps.onRefusal`, but the throw is the contract: a returned empty array is indistinguishable
   * from "this message produced nothing", which is how a mis-wire stays invisible in the one
   * component whose whole job is not to lose events.
   *
   * **SO THE DRIVER (Task 16) WRAPS `accept` IN A try/catch.** An uncaught `ProjectorRefusedError`
   * ends the `for await` mid-turn. The ordering that prevents it arising at all is the driver's
   * too: run 8a's recovery sweep (`pending()` + `resolvePending`) BEFORE constructing a projector
   * for a session. A driver that would rather degrade than fail may catch this and continue; what
   * it may not do is never find out.
   */
  private refuse(sourceId: string): never {
    const refusal: ProjectorRefusal = {
      reason: "pending-elsewhere", sourceId, sessionId: this.deps.sessionId,
      winterSessionId: this.winterSessionId, generation: this.generation, at: this.deps.now(),
    };
    this.refused.push(refusal);
    this.deps.log.warn?.("[projector] source mark is pending elsewhere — refusing to re-project; run the 8a recovery sweep", {
      sessionId: this.deps.sessionId, sourceId,
    });
    try { this.deps.onRefusal?.(refusal); } catch { /* a driver's own handler must never break the fold */ }
    throw new ProjectorRefusedError("pending-elsewhere", sourceId, this.deps.sessionId, this.winterSessionId, this.generation);
  }

  /**
   * The runtime's tool name → the host's (ruling P8b-25). An unknown name passes through unchanged
   * and is logged once: a tool row with an unfamiliar label is a cosmetic surprise, whereas
   * dropping the call or inventing a name would corrupt the transcript and break the `callId`
   * linkage the Mac and iOS renderers fold on.
   *
   * The table is `runtime-sdk/tool-names.ts` — the policy lane's canonical `RUNTIME_HOST_TOOL_PAIRS`,
   * shared with the approval bridge's `gateToolNameFor`. ONE table: the name the gate classifies by
   * and the name the transcript records cannot drift apart, which they could while the projector
   * carried its own copy (that private stand-in is deleted).
   */
  private renameTool(winterName: string): string {
    const host = hostToolNameFor(winterName);
    if (host !== undefined) return host;
    if (!this.loggedToolNames.has(winterName)) {
      this.loggedToolNames.add(winterName);
      this.deps.log.debug?.("[projector] no host name for a Winter tool — passing it through", {
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

  /**
   * Assign `seq`/`ts` and SPLIT BY SINK (m5, review r1). A transient reuses `lastSeq` rather than
   * consuming a new one — `assistant_delta` carries "the store's lastSeq at broadcast time, NOT its
   * own seq" (`protocol/events.ts`), and a client that deduped it by seq would drop every one.
   *
   * No call ever fills both halves: a frame produces either a transient or persisted events, never
   * a mix. `test/projector/conversation.test.ts` pins that, which is what lets a caller wanting one
   * ordered stream concatenate `persist` and `broadcast` without reordering anything.
   */
  private stampBatch(events: ProjectedEvent[]): ProjectedBatch {
    const ts = Date.parse(this.deps.now());
    const persist: SessionEvent[] = [];
    const broadcast: SessionEvent[] = [];
    for (const e of events) {
      const transient = TRANSIENT_EVENT_TYPES.has(e.type);
      const seq = transient ? this.lastSeq : (this.lastSeq = this.deps.nextSeq());
      const stamped = { ...e, seq, ts: Number.isFinite(ts) ? ts : Date.now() } as SessionEvent;
      (transient ? broadcast : persist).push(stamped);
    }
    return { persist, broadcast };
  }
}
