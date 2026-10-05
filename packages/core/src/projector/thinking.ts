import {
  THINKING_ID_MAX_LENGTH, THINKING_TEXT_MAX_LENGTH, type ThinkingKind,
} from "@yanlinglabs/winter-protocol";
import { threadIdOf } from "./conversation";
import { ActivityTitleTracker, activityTitleOf, clipTitle, collapse, lastValidHeading, scanHeadings, sliceUnits } from "./thinking-title";
import type { ProjectedEvent, ProtocolSdkMessage } from "./types";

export { gerundOf, sliceUnits } from "./thinking-title";

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

/**
 * PURE: a reasoning block's pill title, from its kind and the text of its parts so far (oldest
 * first). The one place a title is derived — clients render no title as "Thinking"/"Thought".
 *
 *  - `summary` / `exposed` (any provider) → from the LATEST part, in this order (user ruling
 *    2026-10-05, `thinking-title.ts`):
 *      1. the provider's own heading: the LAST valid `**…**` heading standing alone at the START OF A
 *         LINE (OpenAI-style summaries open each part with `**Heading**\n\nbody`; Gemini's adapter sends
 *         no part numbers, so a whole block is ONE part whose chunks each open with their own heading —
 *         the last one wins). A heading still missing its closing `**` does not count (the one before
 *         it still does); a bold word mid-line is not a heading, nor is a file name or a label
 *         (`**src/calc.js:**`);
 *      2. otherwise the ACTIVITY rule over the prose ("Let me read the files." → "Reading the files"),
 *         no model call. `final` (the block has ended) lets the trailing sentence count whatever it
 *         ends with; while streaming only complete sentences do.
 *  - `update`  → the update's own text (an Anthropic progress update is a sentence or two),
 *    whitespace-collapsed and trimmed.
 *  - `hidden` → none: a hidden block has no text.
 *
 * Capped at `THINKING_TITLE_MAX_LENGTH` with an ellipsis.
 */
export function deriveThinkingTitle(kind: ThinkingKind, parts: readonly string[], opts: { final?: boolean } = {}): string | undefined {
  switch (kind) {
    case "summary":
    case "exposed": {
      const latest = parts[parts.length - 1];
      if (latest === undefined) return undefined;
      return lastValidHeading(latest) ?? activityTitleOf(latest, opts.final ?? false);
    }
    case "update": {
      const text = collapse(parts.join(" "));
      return text.length > 0 ? clipTitle(text) : undefined;
    }
    case "hidden":
      return undefined;
  }
}

// ── the open blocks ────────────────────────────────────────────────────────────────────────────

/** How much of each part's START is kept for an update's title (an update is a sentence or two; the
 *  title is cut at 200 anyway). */
const TITLE_HEAD_CHARS = 600;
/** How much of each part's END is scanned for a heading — the per-delta cost stays bounded (a window,
 *  never the whole part). A heading that scrolled out of the window stays the part's heading until a
 *  newer one arrives (`TitlePart.heading`). The activity rule needs no window: its tracker sees each
 *  unit once (`ActivityTitleTracker`). All are bounded separately from the persisted text, so a block
 *  whose text is already at its cap still titles what comes later. */
const TITLE_TAIL_CHARS = 4096;

/** One part's title state. */
interface TitlePart {
  /** The frame's part number (`undefined` = the frame named none). */
  part: number | undefined;
  /** The head of its text (an update's title), and its tail window (`tailCut`: the window lost its
   *  start, so its first line is partial). */
  head: string;
  tail: string;
  tailCut: boolean;
  /** The last valid heading seen in this part — kept once it scrolls out of the window, so the rule
   *  never takes over from a provider's own heading. */
  heading: string | undefined;
  /** The activity rule over the part's whole text, incremental. */
  rule: ActivityTitleTracker;
}

interface OpenBlock {
  blockId: string;
  threadId: string;
  kind: ThinkingKind;
  /** The persisted text so far: parts joined with "\n\n", at most `THINKING_TEXT_MAX_LENGTH`. */
  body: string;
  truncated: boolean;
  /** Each part's title state, oldest first. */
  parts: TitlePart[];
  /** The last NON-EMPTY COMMITTED title — sticky, and what the block persists (see `retitle`). */
  title: string | undefined;
  /** The last title a delta carried (live; may be provisional) — sticky too. */
  shown: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  /** epoch ms of the `start` frame; `undefined` for a block first seen at a `delta`/`end`. */
  startedAt: number | undefined;
}

/** A part's tail window, its partial first line dropped once the window has lost its start (a `**`
 *  there could be mid-line in the real text). */
function scanWindow(p: { tail: string; tailCut: boolean }): string {
  if (!p.tailCut) return p.tail;
  const nl = p.tail.indexOf("\n");
  return nl < 0 ? "" : p.tail.slice(nl + 1);
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
      title: undefined, shown: undefined, provider: boundedName(f.provider), model: boundedName(f.model),
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
   * `delta`: the increment, and the current title. A new `part` number starts a new part,
   * joined to the previous one with "\n\n" — the separator rides the increment, so a client that
   * concatenates every increment holds exactly the text the persisted block will carry.
   *
   * Once the text reaches `THINKING_TEXT_MAX_LENGTH` no more text is forwarded (the live stream is
   * bounded like the persisted block), but the title still follows the latest part.
   *
   * The current title rides every delta that carries text, and any delta where it changed.
   *
   * TITLE STICKINESS (a decision): an absent field cannot say "cleared" — so when a new summary part
   * opens and its heading has not closed yet (or it has none), the pill keeps the last title rather
   * than falling back to "Thinking" mid-block. The persisted block carries the same last non-empty
   * title.
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
      if (newPart) b.parts.push({ part: partNo, head: "", tail: "", tailCut: false, heading: undefined, rule: new ActivityTitleTracker() });
      const current = b.parts[b.parts.length - 1]!;
      if (current.head.length < TITLE_HEAD_CHARS) current.head += sliceUnits(raw, TITLE_HEAD_CHARS - current.head.length);
      current.tail += raw;
      current.rule.push(raw);
      if (current.tail.length > TITLE_TAIL_CHARS) {
        current.tail = current.tail.slice(-TITLE_TAIL_CHARS);
        current.tailCut = true;
      }
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

    const live = this.retitle(b, "delta");
    const titleChanged = live !== undefined && live !== b.shown;
    if (titleChanged) b.shown = live;
    if (increment.length === 0 && !titleChanged && !kindChanged) return [];
    // The CURRENT title rides every delta that carries text (review r1), not only a change: a client
    // that joins mid-block (a reattach, the phone) learns it from the next delta it sees.
    const title = titleChanged || increment.length > 0 ? b.shown : undefined;
    return [{
      type: "thinking_delta", sessionId: this.sessionId, threadId: b.threadId, blockId: b.blockId, kind: b.kind, phase: "delta",
      ...(increment.length > 0 ? { text: increment } : {}),
      ...(title === undefined ? {} : { title }),
    }];
  }

  /**
   * The block's titles — `deriveThinkingTitle`'s answer, kept incrementally — returning the LIVE one.
   *
   *  - COMMITTED (`b.title`, what the block persists): the update's head; or the latest part's last
   *    heading on a CLOSED line (its window scanned; kept once it scrolls out), else its activity rule
   *    over COMPLETE sentences. Sticky: an `undefined` answer keeps the last committed title.
   *  - LIVE (the delta's `title`): the same, but also reading what the text still to come may change —
   *    a heading on the open last line, the trailing sentence once it ends with `.`/`!`/`?` — so the
   *    pill does not wait for the next sentence. It is shown, never persisted (review r1: a streamed
   *    title must never persist what the whole text would not produce).
   *  - `"end"` (the block's own `end`): everything counts — the committed title is then exactly the
   *    whole-text derivation.
   *  - `"cut"` (the block closed WITHOUT its `end`: the turn's result, an error, an interrupt): no more
   *    text is coming, so the live title is committed — what the user saw last — but a trailing
   *    sentence without its end punctuation still does not count (it may be cut mid-word).
   */
  private retitle(b: OpenBlock, mode: "delta" | "end" | "cut"): string | undefined {
    if (b.kind === "update") {
      const derived = deriveThinkingTitle("update", b.parts.map((p) => p.head));
      if (derived !== undefined) b.title = derived;
      return b.title;
    }
    const p = b.parts[b.parts.length - 1];
    if (b.kind === "hidden" || p === undefined) return b.title;
    const scanned = scanHeadings(scanWindow(p));
    if (scanned.closed !== undefined || !p.tailCut) p.heading = scanned.closed;
    const heading = scanned.latest ?? p.heading;
    const liveTitle = heading ?? p.rule.title(mode === "end");
    const committed = mode === "delta" ? p.heading ?? p.rule.committedTitle() : liveTitle;
    if (committed !== undefined) b.title = committed;
    return mode === "delta" ? liveTitle ?? b.title : b.title;
  }

  /** `end`: the block closes — its persisted record, titled with its trailing sentence counted (a
   *  block's last sentence may end with no punctuation). Nothing for a block already closed. */
  end(f: ReasoningProgressFrame): ProjectedEvent[] {
    if (this.ended.has(f.block_id)) return [];
    const b = this.openBlock(f);
    b.kind = f.kind;
    if (b.provider === undefined) b.provider = boundedName(f.provider);
    if (b.model === undefined) b.model = boundedName(f.model);
    this.retitle(b, "end");
    return [this.close(b)];
  }

  /** Close every open block a predicate selects (by thread) — the turn's or the child's end with a
   *  block still open. Oldest first (insertion order). */
  closeWhere(select: (threadId: string) => boolean): ProjectedEvent[] {
    const out: ProjectedEvent[] = [];
    for (const b of [...this.open.values()]) {
      if (!select(b.threadId)) continue;
      this.retitle(b, "cut");
      out.push(this.close(b));
    }
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
