import {
  THINKING_ID_MAX_LENGTH, THINKING_TEXT_MAX_LENGTH, type ThinkingKind,
} from "@yanlinglabs/winter-protocol";
import { threadIdOf } from "./conversation";
import { ActivityTitleTracker, clipTitle, collapse, decideTitle, scanHeadings, sliceUnits, type Placed } from "./thinking-title";
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
 *  - `summary` / `exposed` (any provider) → from the LATEST part (user ruling 2026-10-05,
 *    `thinking-title.ts`): its headings — a `**…**` line standing alone, never a label, a lone file
 *    name or a lone code span — and its ACTIVITY title ("Let me read the files." → "Reading the
 *    files", no model call), weighed by `decideTitle`: a provider-written summary (one that OPENS with a
 *    heading — OpenAI, Gemini) keeps its latest heading; raw reasoning takes its activity title over a
 *    heading, except an opening heading over its own body.
 *  - `update`  → the update's own text (an Anthropic progress update is a sentence or two),
 *    whitespace-collapsed and trimmed.
 *  - `hidden` → none: a hidden block has no text.
 *
 * `final` (default: the whole text has arrived) lets a heading on the last line and the trailing
 * sentence count; `final: false` reads only CLOSED lines and complete sentences — what a block shows
 * while it streams. Capped at `THINKING_TITLE_MAX_LENGTH` with an ellipsis.
 */
export function deriveThinkingTitle(kind: ThinkingKind, parts: readonly string[], opts: { final?: boolean } = {}): string | undefined {
  const final = opts.final ?? true;
  switch (kind) {
    case "summary":
    case "exposed": {
      const latest = parts[parts.length - 1];
      if (latest === undefined) return undefined;
      const rule = new ActivityTitleTracker();
      rule.push(latest);
      return decideTitle(kind, scanHeadings(latest, final), rule.placed(final));
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
  /** Units pushed to this part so far. */
  total: number;
  /** The last valid heading on a closed line seen in this part, with its offset — kept once it scrolls
   *  out of the window. */
  heading: Placed | undefined;
  /** Where the part's opening heading's body ends (the next heading-shaped line), once seen. */
  protectEnd: number | undefined;
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
  /** The last NON-EMPTY title derived from CLOSED text — sticky; what deltas carry and the block
   *  persists (see `retitle`). */
  title: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  /** epoch ms of the `start` frame; `undefined` for a block first seen at a `delta`/`end`. */
  startedAt: number | undefined;
}

/** A part's tail window and its offset in the part, its partial first line dropped once the window has
 *  lost its start (a `**` there could be mid-line in the real text). */
function scanWindow(p: { tail: string; tailCut: boolean; total: number }): { text: string; start: number } {
  const start = p.total - p.tail.length;
  if (!p.tailCut) return { text: p.tail, start };
  const nl = p.tail.indexOf("\n");
  return nl < 0 ? { text: "", start: p.total } : { text: p.tail.slice(nl + 1), start: start + nl + 1 };
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
      if (newPart) b.parts.push({ part: partNo, head: "", tail: "", tailCut: false, total: 0, heading: undefined, protectEnd: undefined, rule: new ActivityTitleTracker() });
      const current = b.parts[b.parts.length - 1]!;
      if (current.head.length < TITLE_HEAD_CHARS) current.head += sliceUnits(raw, TITLE_HEAD_CHARS - current.head.length);
      current.tail += raw;
      current.total += raw.length;
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

    const before = b.title;
    this.retitle(b, "delta");
    const titleChanged = b.title !== undefined && b.title !== before;
    if (increment.length === 0 && !titleChanged && !kindChanged) return [];
    // The CURRENT title rides every delta that carries text (review r1), not only a change: a client
    // that joins mid-block (a reattach, the phone) learns it from the next delta it sees.
    const title = titleChanged || increment.length > 0 ? b.title : undefined;
    return [{
      type: "thinking_delta", sessionId: this.sessionId, threadId: b.threadId, blockId: b.blockId, kind: b.kind, phase: "delta",
      ...(increment.length > 0 ? { text: increment } : {}),
      ...(title === undefined ? {} : { title }),
    }];
  }

  /**
   * The block's title — `deriveThinkingTitle`'s answer, kept incrementally (review r2: no provisional
   * titles — a title read off text still to come could be refuted and would stick on screen).
   *
   *  - `"delta"` / `"cut"` (closed without its `end`: the round's end, an error, an interrupt): CLOSED
   *    text only — headings on closed lines (the latest kept once it scrolls out of the window),
   *    complete sentences — so what a block stores when cut is the last title it showed.
   *  - `"end"` (the block's own `end`): the whole text counts, so the stored title is exactly the
   *    whole-text derivation.
   *
   * Sticky: an `undefined` answer keeps the last title.
   */
  private retitle(b: OpenBlock, mode: "delta" | "end" | "cut"): void {
    if (b.kind === "update") {
      const derived = deriveThinkingTitle("update", b.parts.map((p) => p.head));
      if (derived !== undefined) b.title = derived;
      return;
    }
    const p = b.parts[b.parts.length - 1];
    if (b.kind === "hidden" || p === undefined) return;
    const final = mode === "end";
    const win = scanWindow(p);
    const scanned = scanHeadings(win.text, final, win.start);
    const closed = final ? scanHeadings(win.text, false, win.start) : scanned;
    if (closed.latest !== undefined || !p.tailCut) p.heading = closed.latest;
    const latest = final ? scanned.latest ?? p.heading : p.heading;
    // The opening heading sits in the part's first line, always inside `head`.
    const opening = scanHeadings(p.head, final && p.total === p.head.length).opening;
    let protectEnd = p.protectEnd;
    if (opening !== undefined && protectEnd === undefined) {
      const firstClosed = closed.lines.find((x) => x > opening.pos);
      if (firstClosed !== undefined) p.protectEnd = protectEnd = firstClosed;
      else if (final) protectEnd = scanned.lines.find((x) => x > opening.pos);
    }
    const derived = decideTitle(b.kind, { latest, opening, protectEnd, lines: [] }, p.rule.placed(final));
    if (derived !== undefined) b.title = derived;
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
