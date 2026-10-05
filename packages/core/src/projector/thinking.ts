import {
  THINKING_ID_MAX_LENGTH, THINKING_TEXT_MAX_LENGTH, THINKING_TITLE_MAX_LENGTH, type ThinkingKind,
} from "@yanlinglabs/winter-protocol";
import { threadIdOf } from "./conversation";
import type { ProjectedEvent, ProtocolSdkMessage } from "./types";

/**
 * ── THE THINKING PILL (2026-10-05) ──────────────────────────────────────────────────────────────
 *
 * The agent SDK reports every reasoning block of every provider family on ONE Winter-only frame,
 * `system/reasoning_progress` (`start` → `delta`* → `end`, one `block_id` per block), so the daemon
 * needs no provider dialect. This module turns those frames into:
 *
 *   start → `thinking_delta` {phase: "start"}                         (TRANSIENT)
 *   delta → `thinking_delta` {phase: "delta", text?, title?}          (TRANSIENT)
 *   end   → `thinking_block` {text, title?, kind, durationMs, …}      (PERSISTED)
 *
 * and derives the pill's TITLE here, in one pure function (`deriveThinkingTitle`), so no client ever
 * parses reasoning text.
 *
 * Reasoning text is for the HUMAN. It never reaches a log line (the projector's only logging door is
 * `hooks.ts`'s per-kind allowlist, which names `provider` alone for this frame), a model-readable
 * transcript (`SUBAGENT_TRANSCRIPT_INCLUDE` is `false` for both events) or a daemon model call
 * (titles, dreamer, cleaner and the compactor read allowlisted event types that do not include it).
 * Opaque material (signatures, encrypted content) is never on the frame at all.
 */

/** The frame, as the SDK pins it (agent SDK 0.0.47's `SDKReasoningProgressMessage`). */
export interface ReasoningProgressFrame {
  type: "system";
  subtype: "reasoning_progress";
  block_id: string;
  phase: "start" | "delta" | "end";
  kind: ThinkingKind;
  text?: string;
  part?: number;
  provider?: string;
  model?: string;
  parent_tool_use_id?: string | null;
}

const PHASES: ReadonlySet<string> = new Set(["start", "delta", "end"]);
const KINDS: ReadonlySet<string> = new Set(["summary", "update", "exposed", "hidden"]);

/** The frame, or `undefined` — an explicit shape guard like `asApiRetryFrame` (see `conversation.ts`
 *  for why nothing here is a `switch (msg.type)`). A frame that fails it falls to `logSkipped`. */
export function asReasoningProgressFrame(m: ProtocolSdkMessage): ReasoningProgressFrame | undefined {
  const r = m as Record<string, unknown>;
  if (r.type !== "system" || r.subtype !== "reasoning_progress") return undefined;
  if (typeof r.block_id !== "string" || r.block_id.length === 0 || r.block_id.length > THINKING_ID_MAX_LENGTH) return undefined;
  if (typeof r.phase !== "string" || !PHASES.has(r.phase)) return undefined;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return undefined;
  return m as unknown as ReasoningProgressFrame;
}

// ── the title ──────────────────────────────────────────────────────────────────────────────────

/** The first `n` UTF-16 units of `s`, never ending on half of a surrogate pair — a lone surrogate
 *  would survive `JSON.stringify` as an escape that strict decoders (Swift's) refuse. */
export function sliceUnits(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, Math.max(0, n));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Whitespace collapsed to single spaces, trimmed. */
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** At most `THINKING_TITLE_MAX_LENGTH` characters, an ellipsis marking a cut. */
function clipTitle(s: string): string {
  if (s.length <= THINKING_TITLE_MAX_LENGTH) return s;
  return `${sliceUnits(s, THINKING_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/** A part's leading COMPLETE `**…**` span (after leading whitespace), collapsed — `undefined` while
 *  the closing `**` has not arrived yet, when the part does not open with one, or when it is empty. */
function leadingBold(text: string): string | undefined {
  const t = text.trimStart();
  if (!t.startsWith("**")) return undefined;
  const close = t.indexOf("**", 2);
  if (close < 0) return undefined;
  const inner = collapse(t.slice(2, close));
  return inner.length > 0 ? clipTitle(inner) : undefined;
}

/**
 * PURE: a reasoning block's pill title, from its kind and the text of its parts so far (oldest
 * first). The one place a title is derived — clients render no title as "Thinking"/"Thought".
 *
 *  - `summary` → the LATEST part's leading complete `**…**` span: OpenAI-style summaries open each
 *    part with `**Heading**\n\nbody` (Codex's `extract_first_bold`). A partial opening `**` yields
 *    nothing yet, as does a latest part with no heading.
 *  - `update`  → the update's own text (an Anthropic progress update is a sentence or two),
 *    whitespace-collapsed and trimmed.
 *  - `exposed` / `hidden` → none: raw chain of thought has no title, and a hidden block no text.
 *
 * Capped at `THINKING_TITLE_MAX_LENGTH` with an ellipsis.
 */
export function deriveThinkingTitle(kind: ThinkingKind, parts: readonly string[]): string | undefined {
  switch (kind) {
    case "summary": {
      const latest = parts[parts.length - 1];
      return latest === undefined ? undefined : leadingBold(latest);
    }
    case "update": {
      const text = collapse(parts.join(" "));
      return text.length > 0 ? clipTitle(text) : undefined;
    }
    case "exposed":
    case "hidden":
      return undefined;
  }
}

// ── the open blocks ────────────────────────────────────────────────────────────────────────────

/** How much of each part's head is kept for the title — a heading or an update sentence lives at
 *  the start, and a part whose `**` has not closed by here is not a heading. Bounded separately from
 *  the persisted text, so a block whose text is already at its cap still titles its later parts. */
const TITLE_SCAN_CHARS = 600;

interface OpenBlock {
  blockId: string;
  threadId: string;
  kind: ThinkingKind;
  /** The persisted text so far: parts joined with "\n\n", at most `THINKING_TEXT_MAX_LENGTH`. */
  body: string;
  truncated: boolean;
  /** Each part's number (`undefined` = the frame named none) and the head of its text. */
  parts: Array<{ part: number | undefined; head: string }>;
  /** The last NON-EMPTY title derived — sticky (see `delta`). */
  title: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  /** epoch ms of the `start` frame; `undefined` for a block first seen at a `delta`/`end`. */
  startedAt: number | undefined;
}

const boundedName = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? sliceUnits(v, THINKING_ID_MAX_LENGTH) || undefined : undefined;

/**
 * The projector's reasoning-block state, one per projector (= one child incarnation). Every method
 * returns UNSTAMPED events; the projector stamps them, claims the persisted ones, and sorts the
 * transients into its broadcast half.
 *
 * A `delta` or `end` for a block never `start`ed opens it implicitly (a frame lost or reordered must
 * not lose the pill); a second `end` for a block already closed is dropped quietly (`ended`), so a
 * runtime that repeats itself never appends a block twice.
 */
export class ThinkingBlocks {
  private readonly open = new Map<string, OpenBlock>();
  private readonly ended = new Set<string>();

  constructor(private readonly sessionId: string, private readonly nowMs: () => number) {}

  /** Whether a block is open on any thread — the projector's own tests read it. */
  get openCount(): number { return this.open.size; }

  private openBlock(f: ReasoningProgressFrame): OpenBlock {
    const existing = this.open.get(f.block_id);
    if (existing !== undefined) return existing;
    const block: OpenBlock = {
      blockId: f.block_id, threadId: threadIdOf(f), kind: f.kind, body: "", truncated: false, parts: [],
      title: undefined, provider: boundedName(f.provider), model: boundedName(f.model),
      startedAt: f.phase === "start" ? this.nowMs() : undefined,
    };
    this.open.set(f.block_id, block);
    return block;
  }

  /** `start`: the pill opens ("Thinking"). Nothing for a block already open or already closed. */
  start(f: ReasoningProgressFrame): ProjectedEvent[] {
    if (this.ended.has(f.block_id) || this.open.has(f.block_id)) return [];
    const b = this.openBlock(f);
    return [{ type: "thinking_delta", sessionId: this.sessionId, threadId: b.threadId, blockId: b.blockId, kind: b.kind, phase: "start" }];
  }

  /**
   * `delta`: the increment, and the title when it changed. A new `part` number starts a new part,
   * joined to the previous one with "\n\n" — the separator rides the increment, so a client that
   * concatenates every increment holds exactly the text the persisted block will carry.
   *
   * Once the text reaches `THINKING_TEXT_MAX_LENGTH` no more text is forwarded (the live stream is
   * bounded like the persisted block), but the title still follows the latest part.
   *
   * TITLE STICKINESS (a decision): the wire carries `title` only when it changed, and an absent field
   * cannot say "cleared" — so when a new summary part opens and its heading has not closed yet (or it
   * has none), the pill keeps the last title rather than falling back to "Thinking" mid-block. The
   * persisted block carries the same last non-empty title.
   */
  delta(f: ReasoningProgressFrame): ProjectedEvent[] {
    if (this.ended.has(f.block_id)) return [];
    const b = this.openBlock(f);
    const kindChanged = b.kind !== f.kind;
    b.kind = f.kind;
    if (b.provider === undefined) b.provider = boundedName(f.provider);
    if (b.model === undefined) b.model = boundedName(f.model);

    const raw = typeof f.text === "string" ? f.text : "";
    const partNo = typeof f.part === "number" && Number.isFinite(f.part) ? f.part : undefined;
    let increment = "";
    if (raw.length > 0) {
      const last = b.parts[b.parts.length - 1];
      const newPart = last === undefined || (partNo !== undefined && partNo !== last.part);
      if (newPart) b.parts.push({ part: partNo, head: "" });
      const current = b.parts[b.parts.length - 1]!;
      if (current.head.length < TITLE_SCAN_CHARS) current.head += sliceUnits(raw, TITLE_SCAN_CHARS - current.head.length);
      const piece = (newPart && b.body.length > 0 ? "\n\n" : "") + raw;
      const room = THINKING_TEXT_MAX_LENGTH - b.body.length;
      if (room <= 0 || b.truncated) {
        // Once cut, the text stays the HEAD it was: nothing later is appended after a gap.
        b.truncated = true;
      } else {
        increment = sliceUnits(piece, room);
        if (increment.length < piece.length) b.truncated = true;
        b.body += increment;
      }
    }

    const derived = deriveThinkingTitle(b.kind, b.parts.map((p) => p.head));
    const titleChanged = derived !== undefined && derived !== b.title;
    if (titleChanged) b.title = derived;
    if (increment.length === 0 && !titleChanged && !kindChanged) return [];
    return [{
      type: "thinking_delta", sessionId: this.sessionId, threadId: b.threadId, blockId: b.blockId, kind: b.kind, phase: "delta",
      ...(increment.length > 0 ? { text: increment } : {}),
      ...(titleChanged ? { title: derived } : {}),
    }];
  }

  /** `end`: the block closes — its persisted record. Nothing for a block already closed. */
  end(f: ReasoningProgressFrame): ProjectedEvent[] {
    if (this.ended.has(f.block_id)) return [];
    const b = this.openBlock(f);
    b.kind = f.kind;
    if (b.provider === undefined) b.provider = boundedName(f.provider);
    if (b.model === undefined) b.model = boundedName(f.model);
    return [this.close(b)];
  }

  /** Close every open block a predicate selects (by thread) — the turn's or the child's end with a
   *  block still open. Oldest first (insertion order). */
  closeWhere(select: (threadId: string) => boolean): ProjectedEvent[] {
    const out: ProjectedEvent[] = [];
    for (const b of [...this.open.values()]) if (select(b.threadId)) out.push(this.close(b));
    return out;
  }

  private close(b: OpenBlock): ProjectedEvent {
    this.open.delete(b.blockId);
    this.ended.add(b.blockId);
    const durationMs = b.startedAt === undefined ? undefined : Math.max(0, Math.round(this.nowMs() - b.startedAt));
    return {
      type: "thinking_block", sessionId: this.sessionId, threadId: b.threadId, blockId: b.blockId, kind: b.kind, text: b.body,
      ...(b.title === undefined ? {} : { title: b.title }),
      ...(b.truncated ? { truncated: true } : {}),
      ...(b.provider === undefined ? {} : { provider: b.provider }),
      ...(b.model === undefined ? {} : { model: b.model }),
      ...(durationMs === undefined || !Number.isFinite(durationMs) ? {} : { durationMs }),
    };
  }
}
