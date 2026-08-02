/** Pure child-thread tracking for the CLI's live subagent block (2e-ii, extended 2e-iii-b) — the
 *  CLI column of the spec's §2 table: lifecycle, TOKEN counters, active-time spans, tool-call
 *  counts, and current-activity text (the CLI now shows BOTH time and tokens, mirroring the
 *  Swift twin's span-tracking in SessionModel.swift). Reducer-style like stream-state.ts:
 *  `updateSubagents(items, event)` returns a NEW array on change and the SAME reference on a
 *  no-op, so callers can cheaply skip repaints. */

import { extractToolDetail, subagentLabel } from "./subagent-display";

export interface CliSubagent {
  threadId: string;
  agentType: string;
  label: string;
  status: string; // "queued" | "working" | "done"
  // Roster honesty (no-timeout task): HOW the thread finished, derived from the wire's own
  // thread_completed.stopReason (end_turn → "done", error → "failed", aborted → "stopped",
  // stalled → "stalled" — task-16, CC-parity follow-up). ADDITIVE alongside `status` — `status`
  // stays "done" for EVERY terminal thread on purpose: it is the single terminal marker all the
  // prune/footer filters (`status !== "done"`) and the Swift-lockstep helpers (subagent-display.ts
  // subagentGlyph/anySubagentAlive) key off, and those must not fork per finish kind. Renderers
  // that want the honest verb (agent-list.tsx's continuation row, tui/state.ts's finish note)
  // read `finish` instead. A stall-killed child now arrives as its OWN distinct stopReason
  // ("stalled") rather than being folded into "error" — it's resumable and carries partial
  // output, unlike a genuine crash.
  finish?: "done" | "failed" | "stopped" | "stalled";
  inputTokens?: number; // latest child turn_completed.inputTokens — unknown until the first
  outputTokens: number; // banked sum of child turn_completed.outputTokens
  liveOutputChars: number; // child assistant_delta chars since the last reconcile (↓ estimate /4)
  activeMs: number; // banked active time from completed turn windows (event-ts deltas, never Date.now())
  activeSince?: number; // event ts the current turn window opened; undefined while not mid-turn
  toolCalls: number; // count of child tool_call events
  activity?: string; // extractToolDetail() of the most recent tool_call that yielded a detail
  // ---- LIVE stall hint (task-5) -------------------------------------------------------------
  // `finish: "stalled"` above is a POST-MORTEM: it only exists once the daemon's progress-stall
  // watchdog has already aborted the child (600s of provider silence by default,
  // packages/core/src/agent/subagents.ts). Until then the roster row shows its last activity verb
  // and a wedged child is indistinguishable from a busy one. These three fields are what
  // `subagentStalled()` below turns into a PRE-KILL verdict, and they are deliberately the same
  // three the `norma -p` headless watchdog (src/watchdog.ts's `WatchdogState`) already keeps:
  // last-event time plus the two kinds of legitimate silence.
  //
  // All three are OPTIONAL and spread-omitted until something actually sets them, so a row built
  // from ts-less events (only ever a hand-built fixture — every real wire event carries `ts`)
  // stays byte-identical to the pre-task shape.
  lastEventAt?: number; // event-ts of the last wire event this row saw — never Date.now()
  toolsInFlight?: number; // child tool_calls without their tool_result yet (a long bash is WORKING)
  approvalsPending?: number; // child approval_requesteds awaiting a human (waiting is not stalling)
}

/** Default silence window before the roster calls a live child stalled. Much shorter than the
 *  daemon's own 600s kill window on purpose: this is a HINT the user reads, not a kill decision,
 *  and it only ever fires when nothing is in flight — i.e. the child is waiting on the provider,
 *  which normally takes seconds. The daemon's window is not visible to the CLI (it's a daemon-side
 *  setting), so this is a local constant rather than a derived one. */
export const ROSTER_STALL_MS = 60_000;

type WireEvent = { type: string; threadId?: string; [k: string]: unknown };

function patch(items: CliSubagent[], threadId: string, f: (s: CliSubagent) => CliSubagent): CliSubagent[] {
  const idx = items.findIndex((s) => s.threadId === threadId);
  if (idx === -1) return items; // ghost threadId (attached mid-batch) — no-op
  const next = items.slice();
  next[idx] = f(items[idx]!);
  return next;
}

/** Live stall hint (task-5): `{ lastEventAt: e.ts }` when the event carries a usable `ts`, else an
 *  empty patch that leaves the previous stamp standing. Spread into every child-event branch below
 *  so "which events count as this row showing signs of life" is one decision in one place — the
 *  CLI-side mirror of the daemon's single `onProgress` chokepoint (engine.ts's per-provider-event
 *  stall reset). What the wire gives us is a SUBSET of what that chokepoint sees (no reasoning or
 *  usage events reach the roster), which only ever makes this hint more conservative, never less. */
function stamp(e: WireEvent): { lastEventAt?: number } {
  return typeof e.ts === "number" ? { lastEventAt: e.ts } : {};
}

export function updateSubagents(items: CliSubagent[], e: WireEvent): CliSubagent[] {
  const threadId = typeof e.threadId === "string" ? e.threadId : "";
  switch (e.type) {
    case "thread_started": {
      if (items.some((s) => s.threadId === threadId)) return items; // replay dedupe
      return [...items, {
        threadId,
        agentType: typeof e.agentType === "string" ? e.agentType : "",
        label: subagentLabel(typeof e.description === "string" ? e.description : undefined,
          typeof e.prompt === "string" ? e.prompt : ""),
        status: "queued",
        outputTokens: 0,
        liveOutputChars: 0,
        activeMs: 0,
        toolCalls: 0,
        ...stamp(e),
      }];
    }
    case "turn_started":
      if (threadId === "main") return items;
      return patch(items, threadId, (s) => ({ ...s, status: "working", activeSince: typeof e.ts === "number" ? e.ts : s.activeSince, ...stamp(e) }));
    case "assistant_delta":
      if (threadId === "main") return items;
      return patch(items, threadId, (s) => ({ ...s, liveOutputChars: s.liveOutputChars + String(e.delta ?? "").length, ...stamp(e) }));
    case "turn_completed":
      if (threadId === "main") return items.length ? [] : items; // prune: children finish first
      return patch(items, threadId, (s) => ({
        ...s,
        inputTokens: typeof e.inputTokens === "number" ? e.inputTokens : s.inputTokens,
        outputTokens: s.outputTokens + (typeof e.outputTokens === "number" ? e.outputTokens : 0),
        liveOutputChars: 0, // reconciled — the banked outputTokens now carries this turn's output
        ...closeSpan(s, e),
        ...stamp(e),
      }));
    case "thread_completed":
      // status is ALWAYS "done" (the terminal marker — see the `finish` field's doc comment);
      // `finish` carries the honest verdict off the event's own stopReason.
      return patch(items, threadId, (s) => ({
        ...s,
        status: "done",
        finish: e.stopReason === "error" ? "failed"
          : e.stopReason === "aborted" ? "stopped"
          : e.stopReason === "stalled" ? "stalled"
          : "done",
        ...closeSpan(s, e),
        ...stamp(e),
      }));
    case "tool_call": {
      if (threadId === "main") return items;
      const name = typeof e.name === "string" ? e.name : "";
      const argsJson = typeof e.argsJson === "string" ? e.argsJson : "";
      return patch(items, threadId, (s) => ({
        ...s,
        toolCalls: s.toolCalls + 1,
        activity: extractToolDetail(name, argsJson) ?? s.activity,
        // live stall hint: the call is now executing — silence from here until its tool_result is
        // the tool doing its job (a 9-minute `bun test`), never a stall.
        toolsInFlight: (s.toolsInFlight ?? 0) + 1,
        ...stamp(e),
      }));
    }
    // Live stall hint (task-5) — the three branches below exist ONLY to keep the two
    // legitimate-silence counters and the freshness stamp honest; none of them touches any
    // pre-existing field, so every counter/label/token aggregate is unchanged by their addition.
    // (In the TUI these reach here via tui/state.ts's `feedAgents` routing; `norma -p`'s main.ts
    // already fed every event through this reducer.)
    case "tool_result":
      if (threadId === "main") return items;
      return patch(items, threadId, (s) => ({ ...s, toolsInFlight: Math.max(0, (s.toolsInFlight ?? 0) - 1), ...stamp(e) }));
    case "approval_requested":
      if (threadId === "main") return items;
      return patch(items, threadId, (s) => ({ ...s, approvalsPending: (s.approvalsPending ?? 0) + 1, ...stamp(e) }));
    case "approval_resolved":
      if (threadId === "main") return items;
      return patch(items, threadId, (s) => ({ ...s, approvalsPending: Math.max(0, (s.approvalsPending ?? 0) - 1), ...stamp(e) }));
    case "agent_error":
      if (threadId === "main") return items.length ? [] : items; // defensive prune
      return items;
    default:
      return items;
  }
}

/** Banks the open `activeSince` span (event-ts delta, clamped ≥ 0) into `activeMs` and clears
 *  `activeSince` — shared by `turn_completed`'s normal close and `thread_completed`'s defensive
 *  close (e.g. an aborted child that never got a matching `turn_completed`). A no-op patch
 *  (`{}`-spread-safe) when there's no open span or no usable `ts`. */
function closeSpan(s: CliSubagent, e: WireEvent): Pick<CliSubagent, "activeMs" | "activeSince"> {
  const ts = typeof e.ts === "number" ? e.ts : undefined;
  if (s.activeSince === undefined || ts === undefined) return { activeMs: s.activeMs, activeSince: undefined };
  return { activeMs: s.activeMs + Math.max(0, ts - s.activeSince), activeSince: undefined };
}

/** How long this row has shown no sign of life, in ms — the daemon-stamped `lastEventAt` against
 *  the caller's `nowMs` (the same mixed-clock idiom `subagent-display.ts`'s `subagentElapsedMs`
 *  already uses for `activeSince`; daemon and CLI share a machine). Clamped ≥ 0 so clock skew
 *  never reads negative, and 0 when nothing was ever stamped. */
export function subagentSilentMs(s: CliSubagent, nowMs: number): number {
  return s.lastEventAt === undefined ? 0 : Math.max(0, nowMs - s.lastEventAt);
}

/**
 * Live stall verdict for ONE roster row (task-5) — pure, `now` injected, no timers, exactly the
 * shape `src/watchdog.ts`'s `isStalled` already uses for the `norma -p` turn watchdog, per-child:
 *
 *   working, nothing in flight, no approval awaiting a human, and silent past `thresholdMs`.
 *
 * The two exclusions are the whole point of the honesty: a child mid-`bash` streams no events for
 * as long as the command runs (subagents.ts's own header says so — it is why the daemon's stall
 * window is pinned to bash's max timeout), and a child parked on an approval card is waiting on a
 * PERSON. Calling either one "Stalled" would be crying wolf on the roster's most-read line.
 *
 * Never true for a terminal row: once `thread_completed` lands, `finish` owns the verb (a
 * watchdog-killed child reads "Stalled" there already — task-16); a "queued" row is waiting on a
 * SubagentManager slot, which is legitimate waiting, not silence.
 */
export function subagentStalled(s: CliSubagent, nowMs: number, thresholdMs: number = ROSTER_STALL_MS): boolean {
  if (s.status !== "working") return false;
  if ((s.toolsInFlight ?? 0) > 0) return false;
  if ((s.approvalsPending ?? 0) > 0) return false;
  if (s.lastEventAt === undefined) return false;
  return nowMs - s.lastEventAt > thresholdMs;
}
