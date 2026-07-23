import type { SessionEvent } from "@norma/protocol";
import type { SessionStore } from "./store";

/** The 8 persisted, phone-foldable event types history is allowed to return. Allowlist, never a
 *  denylist: an unknown future type stays out until deliberately added. `reasoning_item` (opaque
 *  encrypted_content), harness_attached/detached, lifecycle, checkpoint, workflow_*, plugin/lease
 *  events are excluded by construction. assistant_delta is transient (never on disk) and so can
 *  never appear here either. */
export const HISTORY_EVENT_TYPES: ReadonlySet<SessionEvent["type"]> = new Set<SessionEvent["type"]>([
  "user_message",
  "assistant_message",
  "turn_completed",
  "tool_call",
  "tool_result",
  "approval_requested",
  "approval_resolved",
  "agent_error",
]);

/** Truncates `value` to `cap` UTF-8 bytes (backed off to a char boundary) plus a deterministic
 *  marker recording the original total byte length. Returns `value` unchanged (the same reference)
 *  when it's already within budget — the common no-op case. */
function capString(value: string, cap: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= cap) return value;
  const buf = Buffer.from(value, "utf8");
  let end = cap;
  // Back off to a UTF-8 char boundary: 0x80-0xBF are continuation bytes.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  const head = buf.subarray(0, end).toString("utf8");
  return `${head}\n…[truncated by history: ${bytes} bytes total]`;
}

/** Generalized per-event cap (branch review — replaces the old tool_result-only `capToolResult`):
 *  truncates EVERY top-level string property of `event` whose UTF-8 byte length exceeds `outputCap`
 *  via `capString`, not just `tool_result.output`. Without this, a single oversized OTHER event (a
 *  multi-MiB `user_message.text` paste, a `tool_call.argsJson` embedding a whole file,
 *  `assistant_message.text`, `agent_error.message`, …) would ride the newest-event floor (below)
 *  into an RPC frame the phone transport treats as fatal (silent connection kill, unrecoverable on
 *  refetch). Type-agnostic by design: a FUTURE allowlisted type with a large string field is
 *  automatically covered; short identifier fields (type/callId/threadId/by/toolName/etc.) are
 *  nowhere near the cap and pass through untouched. Pure and deterministic — refetches are
 *  byte-stable. Returns the SAME reference when nothing needed capping (the common case, preserving
 *  the original single-field behavior byte-for-byte); otherwise a shallow copy (object spread) — the
 *  input is never mutated. */
function capEvent(event: SessionEvent, outputCap: number): SessionEvent {
  const record = event as unknown as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const capped = capString(value, outputCap);
    if (capped === value) continue; // within budget — this field alone never triggers a copy
    if (!out) out = { ...record };
    out[key] = capped;
  }
  return (out ?? event) as unknown as SessionEvent;
}

export function readHistoryPage(
  store: SessionStore,
  opts: { sessionId: string; beforeSeq?: number; limit?: number; byteBudget?: number; outputCap?: number },
): { events: SessionEvent[]; hasMore: boolean; oldestSeq: number | null } {
  const limit = opts.limit ?? 200;
  const byteBudget = opts.byteBudget ?? 256 * 1024;
  const outputCap = opts.outputCap ?? 64 * 1024;
  const upper = opts.beforeSeq ?? Infinity;

  // O(file) per call — accepted for v1 page sizes. Throws "unknown session" for a bad id (mapped to
  // NOT_FOUND by the ipc handler).
  const all = store.read(opts.sessionId, 0); // ascending, gapless per session
  const filtered = all.filter((e) => HISTORY_EVENT_TYPES.has(e.type) && e.seq < upper);

  // Candidate = the newest `limit` of the filtered list (ascending).
  const candidate = filtered.slice(Math.max(0, filtered.length - limit));
  // Per-event cap, then byte-budget walk newest→oldest, always keeping at least the newest.
  const capped = candidate.map((e) => capEvent(e, outputCap));
  const kept: SessionEvent[] = [];
  let used = 0;
  for (let i = capped.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(capped[i]), "utf8");
    if (kept.length > 0 && used + size > byteBudget) break;
    kept.push(capped[i]!);
    used += size;
  }
  kept.reverse(); // ascending

  const oldestSeq = kept.length > 0 ? kept[0]!.seq : null;
  const hasMore = filtered.some((e) => e.seq < (oldestSeq ?? upper));
  return { events: kept, hasMore, oldestSeq };
}
