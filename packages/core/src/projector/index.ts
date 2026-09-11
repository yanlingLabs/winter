import { TRANSIENT_EVENT_TYPES, type SessionEvent } from "@norma/protocol";
import {
  MAIN_THREAD, asAssistantFrame, asInitFrame, asResultFrame, asStreamEventFrame, asUserFrame,
  assistantText, deltaText, hasToolResults, threadIdOf, toolCalls, toolResults, userText,
} from "./conversation";
import { createEchoWindow, type EchoWindow } from "./dedupe";
import { projectTerminal, type UsageTotals } from "./terminal";
import type { CheckpointStore, ProjectedEvent, Projector, ProjectorDeps, ProtocolSdkMessage } from "./types";

export { PROJECTED_EVENT_COVERAGE, SUBAGENT_TRANSCRIPT_INCLUDE } from "./event-coverage";
export { createEchoWindow, ECHO_WINDOW, type EchoWindow } from "./dedupe";
export { projectTerminal, totalsOf, type UsageTotals } from "./terminal";
export { MAIN_THREAD, threadIdOf } from "./conversation";
export type {
  CheckpointStore, Logger, ProjectedEvent, ProjectionCursorInput, ProjectionKey, Projector,
  ProjectorDeps, ProtocolSdkMessage, SessionMode,
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
      if (verdict === "pending-elsewhere") {
        // A mark left open by a projector that died between append and commit, or one another
        // projector holds right now. Re-projecting could double-append, so it is refused here and
        // left to 8a's recovery sweep (`pending()` + `resolvePending`), which is the only thing
        // that can read the product log's tail and decide. Run recovery BEFORE constructing a
        // projector for a session.
        this.deps.log.warn?.("[projector] source mark is pending elsewhere — refusing to re-project", { sourceId });
        return [];
      }
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
        out.push(...toolCalls(assistant, this.deps.sessionId, threadId));
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
        return claim(sourceId, () => toolResults(userFrame, this.deps.sessionId, threadId));
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
      this.resultAt = this.deps.now();
      return events;
    }

    this.logSkipped(msg);
    return [];
  }

  flush(): void { this.commitPending(); }

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
   * `rate_limit_event`, `auth_status`, hook rows, status/compaction rows and every Winter-only
   * extension message (P8b-8, P8b-21): observed, never persisted, and logged by TYPE AND CODE ONLY.
   * No message body, no `detail`, no provider text ever reaches a log line from here — a
   * `redacted_thinking.data` or a reasoning summary is opaque provider state whose only sink is the
   * session JSONL, and an extension message's prose is not something this module has cleared for a
   * log. One line per distinct wire type keeps a 429 storm from filling the log.
   */
  private logSkipped(msg: ProtocolSdkMessage): void {
    const type = typeof (msg as { type?: unknown }).type === "string" ? (msg as { type: string }).type : "<untyped>";
    const subtype = typeof (msg as { subtype?: unknown }).subtype === "string" ? (msg as { subtype: string }).subtype : undefined;
    const kind = subtype === undefined ? type : `${type}/${subtype}`;
    if (this.loggedTypes.has(kind)) return;
    this.loggedTypes.add(kind);
    this.deps.log.debug?.("[projector] wire message not projected in part 1", { sessionId: this.deps.sessionId, kind });
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
