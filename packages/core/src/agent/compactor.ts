import type { SessionEvent } from "@winter/protocol";
import type { Provider, TurnInputItem } from "../providers/types";
import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";

/** Task 17: moved here from the retired engine (its context-overflow trigger fraction) — the codex
 *  model-drift test pins the catalogue against it. */
export const DEFAULT_COMPACT_THRESHOLD_FRAC = 0.75;

export const SUMMARIZE_INSTRUCTION =
  "You are compacting a conversation so it can continue with less context. " +
  "Summarize the messages below. " +
  "Write the summary as clear DECLARATIVE statements of what is true and what was decided — e.g. 'The user's lucky number is 4242.' — NOT as a paraphrase of the most recent message or an echo of an acknowledgement. " +
  "Preserve all specifics (numbers, names, paths, identifiers, exact values) verbatim. Be concise but complete; do not sacrifice a fact for brevity. Output only the summary text.";

const DEFAULT_KEEP_TAIL = 6;
const MAIN_THREAD = "main";

type Message = Extract<SessionEvent, { type: "user_message" | "assistant_message" }>;
type Checkpoint = Extract<SessionEvent, { type: "checkpoint" }>;
type ToolCall = Extract<SessionEvent, { type: "tool_call" }>;
type ToolResult = Extract<SessionEvent, { type: "tool_result" }>;

function isMessage(e: SessionEvent): e is Message {
  return e.type === "user_message" || e.type === "assistant_message";
}
function isCheckpoint(e: SessionEvent): e is Checkpoint {
  return e.type === "checkpoint";
}
function isToolCall(e: SessionEvent): e is ToolCall {
  return e.type === "tool_call";
}
function isToolResult(e: SessionEvent): e is ToolResult {
  return e.type === "tool_result";
}
function hasThreadId(e: SessionEvent): e is SessionEvent & { threadId: string } {
  return "threadId" in e;
}

/** Walks BACKWARD from a main-thread tool_call (by seq, over the already seq-ordered main-thread
 *  event list) to find where its "round" opens, so the clamp below can protect a reasoning item
 *  from being folded away while its function_call still replays bare. `reasoning_item` is
 *  persisted at STREAM time (engine.ts's collector fires the instant the item arrives) while its
 *  function_call is persisted only later, at DISPATCH time — and `AgentEngine.steer()` appends
 *  `user_message` events immediately, mid-turn, so a steer flood can land in seq BETWEEN a
 *  reasoning item and the function_call it belongs to. A `user_message` therefore does NOT close
 *  a round on its own (only the round-closing `assistant_message` does) and is walked straight
 *  through here, same as `reasoning_item`/`tool_call`/`tool_result` from earlier rounds of the
 *  same turn. Returns `tcSeq` unchanged when nothing but a message directly precedes the call
 *  (T1's original clamp target — no reasoning item to protect). */
function spanStartSeq(mainEvents: SessionEvent[], tcSeq: number): number {
  const idx = mainEvents.findIndex((e) => e.seq === tcSeq);
  let start = tcSeq;
  for (let i = idx - 1; i >= 0; i--) {
    const e = mainEvents[i]!;
    if (e.type === "assistant_message") break; // only an assistant message closes a round
    if (e.type === "reasoning_item" || e.type === "tool_call" || e.type === "tool_result") start = e.seq;
    // user_message (including a mid-round steer) never closes a round — pass straight through
    // without moving `start`, so it can't break the reasoning-item/function_call link.
  }
  return start;
}

const NOT_COMPACTED = { compacted: false, uptoSeq: 0, summaryChars: 0 } as const;

/** Folds older turns into a checkpoint summary, keeping only the most recent `keepTail`
 *  messages verbatim. Re-compacting an already-checkpointed session NEVER re-feeds the prior
 *  checkpoint's summary to the model — under repeated re-compression the model reliably drops
 *  facts from a folded-in summary. Instead the prior summary is carried forward VERBATIM and
 *  concatenated with a fresh summary of only the newest "older" messages, so every fact
 *  survives every re-compaction. */
export class Compactor {
  private readonly provider: { provider: Provider; model: string };
  private readonly store: SessionStore;
  private readonly hub: SessionHub;
  private readonly keepTail: number;

  constructor(deps: { provider: { provider: Provider; model: string }; store: SessionStore; hub: SessionHub; keepTail?: number }) {
    this.provider = deps.provider;
    this.store = deps.store;
    this.hub = deps.hub;
    this.keepTail = deps.keepTail ?? DEFAULT_KEEP_TAIL;
  }

  async compact(sessionId: string, signal?: AbortSignal): Promise<{ compacted: boolean; uptoSeq: number; summaryChars: number }> {
    const events = this.store.read(sessionId);
    const lastCp = [...events].reverse().find(isCheckpoint);
    const msgs = events.filter(isMessage);
    const afterCp = lastCp ? msgs.filter((m) => m.seq > lastCp.uptoSeq) : msgs;
    if (afterCp.length <= this.keepTail) return NOT_COMPACTED;

    const older = afterCp.slice(0, afterCp.length - this.keepTail);
    const candidateUptoSeq = older[older.length - 1]!.seq;

    // Clamp the candidate so it never lands strictly INSIDE an unresolved main-thread
    // tool_call/tool_result pair, AND never strands a reasoning item without the function_call it
    // belongs to. Both are reachable in production, not just theoretical:
    // AgentEngine.steer() appends `user_message` events to the store IMMEDIATELY, even while a
    // tool call sits mid-flight awaiting approval (default approval timeout is 5 minutes). If a
    // steer flood of more than `keepTail` messages lands during that window and a manual
    // `compact` IPC call (a live method, callable mid-turn — see AgentEngine.compact) fires in
    // it, the naive candidate above — derived purely from MESSAGE seqs — can sit strictly between
    // the pending tool_call's seq and its (not-yet-emitted, or never-emitted) tool_result's seq.
    // historyInput's `seq <= uptoSeq` would then fold the function_call but keep the later
    // tool_result, orphaning it in the provider input on replay -> hard reject (T1's rule below).
    // Separately (history-parity T3 review): `reasoning_item` is persisted at STREAM time while
    // its function_call is persisted only later, at DISPATCH time, so the SAME steer flood can
    // land in seq between a reasoning item and the function_call it belongs to — the naive
    // candidate can then fold the reasoning item away while the function_call still replays bare
    // (graceful degradation, not a hard reject, but wrong). `spanStartSeq` above walks a tool_call
    // back past any reasoning_item/tool_call/tool_result/user_message to find where its round
    // actually opens, so the boundary below always keeps a reasoning item and its function_call on
    // the same side of the clamp. So: find the EARLIEST main-thread tool_call that is an offender
    // under EITHER rule — (a) at or before the candidate with its matching tool_result (same
    // callId) missing or landing AFTER the candidate [T1], or (b) its walked-back round-opening
    // seq is at or before the candidate while the call itself is after it [T3 — reasoning span
    // would be split even though the pair is fully resolved] — and pull the boundary back to the
    // last message strictly before that round's opening. Scoped to the MAIN thread only,
    // consistent with historyInput's own thread filter (child-thread tool events never enter main
    // replay, so they can never be split by a main checkpoint either).
    const mainEvents = events.filter(hasThreadId).filter((e) => e.threadId === MAIN_THREAD);
    const mainToolCalls = mainEvents.filter(isToolCall);
    const mainToolResultSeqByCallId = new Map<string, number>();
    for (const e of mainEvents) {
      if (isToolResult(e)) mainToolResultSeqByCallId.set(e.callId, e.seq);
    }
    let earliestOffenderTcSeq: number | null = null;
    let earliestOffenderSpanStart: number | null = null;
    for (const tc of mainToolCalls) {
      const resultSeq = mainToolResultSeqByCallId.get(tc.callId);
      const spanStart = spanStartSeq(mainEvents, tc.seq);
      const pairSplit = tc.seq <= candidateUptoSeq && (resultSeq === undefined || resultSeq > candidateUptoSeq);
      const reasoningSpanSplit = spanStart <= candidateUptoSeq && candidateUptoSeq < tc.seq;
      if (pairSplit || reasoningSpanSplit) {
        if (earliestOffenderTcSeq === null || tc.seq < earliestOffenderTcSeq) {
          earliestOffenderTcSeq = tc.seq;
          earliestOffenderSpanStart = spanStart;
        }
      }
    }
    let uptoSeq = candidateUptoSeq;
    if (earliestOffenderSpanStart !== null) {
      const safeOlder = afterCp.filter((m) => m.seq < earliestOffenderSpanStart!);
      if (safeOlder.length === 0) return NOT_COMPACTED; // nothing safely foldable before the pending round
      uptoSeq = safeOlder[safeOlder.length - 1]!.seq;
    }
    const olderClamped = afterCp.filter((m) => m.seq <= uptoSeq);

    // Only the new "older" messages go to the model — the prior summary is never re-fed, so it
    // can never be eroded by re-summarization.
    const input: TurnInputItem[] = olderClamped.map((m) => ({
      type: "message",
      role: m.type === "user_message" ? "user" : "assistant",
      content: m.text,
    }));

    let newPartial = "";
    try {
      for await (const ev of this.provider.provider.streamTurn({
        model: this.provider.model,
        instructions: SUMMARIZE_INSTRUCTION,
        input,
        tools: [],
        signal,
      })) {
        if (ev.type === "text_delta") newPartial += ev.delta;
        else if (ev.type === "done" && ev.stopReason === "aborted") return NOT_COMPACTED;
      }
    } catch {
      return NOT_COMPACTED;
    }
    if (signal?.aborted || newPartial.trim().length === 0) return NOT_COMPACTED;

    // Carry the prior summary forward VERBATIM and append the freshly summarized section, so the
    // cumulative summary only ever grows and never re-erodes earlier facts.
    const summary = lastCp ? lastCp.summary + "\n\n" + newPartial : newPartial;

    this.hub.append(sessionId, { type: "checkpoint", sessionId, threadId: MAIN_THREAD, summary, uptoSeq });
    return { compacted: true, uptoSeq, summaryChars: summary.length };
  }
}
