import type { SessionEvent } from "@norma/protocol";
import type { SessionStore } from "./store";

/** The 10 persisted, phone-foldable event types history is allowed to return. Allowlist, never a
 *  denylist: an unknown future type stays out until deliberately added — and adding one REQUIRES
 *  re-checking the per-event cap covers its large strings (capJson bounds strings at ANY depth,
 *  which is what admitted question_asked's nested options[].description). `reasoning_item` (opaque
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
  "question_asked",
  "question_resolved",
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

/** Recursively caps every string ANYWHERE in a JSON tree (object values, array elements, any
 *  depth) via `capString`. Returns the SAME reference when nothing under it changed (the common
 *  no-op case — preserving the original flat behavior byte-for-byte and copy-for-copy); copies
 *  only the spine that actually changed. Pure and deterministic — refetches stay byte-stable.
 *  This closes the session-history branch review's forward-warning: the old walk bounded only
 *  TOP-LEVEL strings, so a nested large string (e.g. question_asked's options[].description)
 *  could ride the newest-event floor into an oversized frame. */
function capJson(value: unknown, cap: number): unknown {
  if (typeof value === "string") return capString(value, cap);
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const capped = capJson(value[i], cap);
      if (capped !== value[i]) {
        if (!out) out = [...value];
        out[i] = capped;
      }
    }
    return out ?? value;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const key of Object.keys(record)) {
      const capped = capJson(record[key], cap);
      if (capped !== record[key]) {
        if (!out) out = { ...record };
        out[key] = capped;
      }
    }
    return out ?? value;
  }
  return value; // number | boolean | null — nothing to cap
}

/** Whole-event serialized-size ceiling, enforced AFTER the per-string cap (`capJson`/`outputCap`,
 *  e.g. 64 KiB per string). Per-string capping bounds each string but not the aggregate: a
 *  schema-valid `question_asked` can carry up to 4 questions (question+header) plus 4 options per
 *  question (label+description+preview) — dozens of independently-64-KiB-capped strings, several
 *  MiB in the worst case. `readHistoryPage`'s newest-event floor ALWAYS includes the newest
 *  allowlisted event regardless of the page byte budget, so an oversized event here bypasses that
 *  budget entirely and hits the phone transport's hard 1 MiB frame limit — silently dropping the
 *  connection right when the user opens the phone to answer a question. 160 KiB sits well under
 *  that 1 MiB limit (headroom for JSON-escaping/structural overhead) and far above the 64 KiB
 *  single-string cap, so ordinary events (a handful of strings) never trigger the second pass. */
export const WHOLE_EVENT_CEILING = 160 * 1024;

/** Counts every string leaf in a JSON tree (mirrors `capJson`'s walk) — sizes the tighter
 *  per-string cap used to bring an event under `WHOLE_EVENT_CEILING`. */
function countStrings(value: unknown): number {
  if (typeof value === "string") return 1;
  if (Array.isArray(value)) {
    let n = 0;
    for (const v of value) n += countStrings(v);
    return n;
  }
  if (value !== null && typeof value === "object") {
    let n = 0;
    for (const v of Object.values(value as Record<string, unknown>)) n += countStrings(v);
    return n;
  }
  return 0;
}

/** Default per-STRING cap. Applied first; `WHOLE_EVENT_CEILING` is the second, aggregate pass. */
export const DEFAULT_OUTPUT_CAP = 64 * 1024;

/** Brings one event under `WHOLE_EVENT_CEILING`, per-string first then aggregate. Pure and
 *  deterministic (depends only on `event` + the two constants), so the same input always yields
 *  byte-identical output.
 *
 *  **Shared with the LIVE remote stream** (`sessions/remote-stream.ts`), deliberately and with the
 *  same defaults: `session.history` and the live/replay feed hand the phone the SAME events, so a
 *  divergent cap would make a message rendered live differ from the same message re-read from a
 *  history page — the transcript would visibly flip on rebuild. That is also why the truncation
 *  marker still says "by history" on both paths: identical bytes matter more than a per-path
 *  wording, and the phone reconciles the two by seq. */
export function capEvent(event: SessionEvent, outputCap: number = DEFAULT_OUTPUT_CAP): SessionEvent {
  const capped = capJson(event, outputCap);
  const size = Buffer.byteLength(JSON.stringify(capped), "utf8");
  if (size <= WHOLE_EVENT_CEILING) return capped as SessionEvent;
  // The per-string pass left the aggregate over the ceiling (e.g. a question_asked with many
  // large options) — re-run the deep cap against the ORIGINAL event with a tighter per-string cap
  // sized to the event's string count. Pure: depends only on `event` + the two constants, so
  // refetching the same page stays byte-stable (page determinism).
  const stringCount = Math.max(1, countStrings(event));
  const tighterCap = Math.max(1, Math.floor(WHOLE_EVENT_CEILING / stringCount));
  return capJson(event, tighterCap) as SessionEvent;
}

export function readHistoryPage(
  store: SessionStore,
  opts: { sessionId: string; beforeSeq?: number; limit?: number; byteBudget?: number; outputCap?: number },
): { events: SessionEvent[]; hasMore: boolean; oldestSeq: number | null } {
  const limit = opts.limit ?? 200;
  const byteBudget = opts.byteBudget ?? 256 * 1024;
  const outputCap = opts.outputCap ?? DEFAULT_OUTPUT_CAP;
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

/** Test-only export of the deep cap (the page-level tests can't reach a nested-string event until
 *  question_asked joins the allowlist in the next commit). */
export const capEventForTest = capEvent;
