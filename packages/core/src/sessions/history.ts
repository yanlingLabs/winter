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

/** Replaces a tool_result whose output exceeds `outputCap` UTF-8 bytes with the first `outputCap`
 *  bytes (backed off to a char boundary) plus a deterministic marker. Envelope shape unchanged;
 *  refetches are byte-stable. Any other event is returned as-is. */
function capToolResult(event: SessionEvent, outputCap: number): SessionEvent {
  if (event.type !== "tool_result") return event;
  const bytes = Buffer.byteLength(event.output, "utf8");
  if (bytes <= outputCap) return event;
  const buf = Buffer.from(event.output, "utf8");
  let end = outputCap;
  // Back off to a UTF-8 char boundary: 0x80-0xBF are continuation bytes.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  const head = buf.subarray(0, end).toString("utf8");
  return { ...event, output: `${head}\n…[truncated by history: ${bytes} bytes total]` };
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
  const capped = candidate.map((e) => capToolResult(e, outputCap));
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
