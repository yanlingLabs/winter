/** `flatten-blocks.ts` (Phase 3c Task 2) — renders committed `Block`s (see `state.ts`) to
 *  pre-wrapped ANSI STRINGS: the unit the virtualized transcript viewport (`scroll-model.ts` +
 *  `<TranscriptViewport>`, TUI renderer T2 — superseding Task 4's `viewport.ts`) scrolls through. This SUPERSEDES `pager.tsx`'s `pagerLines` (deleted in Task 4) and re-expresses
 *  3b's `transcript.tsx` per-block Ink renderers as string builders, so the VISIBLE text (glyphs,
 *  spacing, caps, wording) matches those components exactly — see per-kind notes below. An exact
 *  byte-for-byte ANSI match with `transcript.tsx` is NOT required (Ink owns its own layout/props;
 *  this module bakes equivalent styling directly into the string via a private `chalk` instance,
 *  same determinism trick as `markdown.ts`) — only the LOOK (dim/bold/color per `theme.ts`) and the
 *  visible text need to agree.
 *
 *  `formatArgsHead` + `MAX_RESULT_LINES` are imported from the React-free `format.ts` (Task 4 moved
 *  them there out of the React-bearing `transcript.tsx`), so this module — the fullscreen line-log
 *  source — pulls in NO Ink/React graph, and the args-head/result caps have exactly one definition
 *  shared with the `transcript.tsx` grammar renderers.
 *
 *  GUTTER MODEL (why lines line up the way they do): `transcript.tsx` renders assistant/tool-head/
 *  collapsed-run rows as an Ink `flexDirection="row"` pair — a fixed-width gutter `Box` (glyph)
 *  beside a `flexGrow` content `Box` — so EVERY content row (whether from an embedded `\n` in
 *  markdown/args, or from Ink's own wrap) lines up under the content column, and the glyph only
 *  ever appears once, on the very first row. The tool RESULT body is the same two-box shape with a
 *  wider (5-column) `"  ⎿  "` gutter (transcript.tsx's own header comment documents this explicitly).
 *  `gutterRows` below reproduces that: it wraps each logical content line at `columns - gutterWidth`
 *  and prefixes only the very first physical row with the glyph, every other physical row (a later
 *  logical line OR a wrap-continuation of the same one) with an equal-width blank.
 *  User/note/skill/turn-summary/interrupted blocks are, by contrast, rendered by `transcript.tsx`
 *  as a SINGLE `<Text>` node with the prefix concatenated directly onto the text (no gutter/content
 *  box split) — so continuation lines (from an embedded `\n`, e.g. an agent-finish note's literal
 *  "\n⎿ Ran N tool calls") get NO hanging indent, they just wrap as one flowing paragraph at the
 *  FULL `columns` width. `flowLines` reproduces that simpler shape.
 *
 *  WRAP CHOICE (`wrap-ansi`, `{ hard: true, trim: false }`): the task brief's own interface comment
 *  says `hard: false`, but its "Key semantics" section requires a 300-char unbroken token (e.g. a
 *  long path in a tool result) to WRAP rather than overflow — `wordWrap`'s soft mode (`hard: false`)
 *  never breaks a single "word" longer than the column budget, so `hard: true` is the only choice
 *  that satisfies that requirement; this file follows the semantics section (see
 *  `test/tui/flatten-blocks.test.ts`'s "unbroken 300-char token" case). `trim: false` is required
 *  because `wrap-ansi`'s default `trim: true` strips LEADING whitespace off every wrapped row,
 *  which would destroy the tool-result continuation's 5-space hanging indent — `gutterRows` already
 *  supplies indentation explicitly via the blank prefix, so nothing here needs `wrap-ansi`'s own
 *  (destructive) trimming. */

import { Chalk } from "chalk";
import wrapAnsi from "wrap-ansi";
import type { Block } from "./state";
import { theme } from "./theme";
import { createStreamingMarkdown, renderMarkdown, splitStableBoundary, type Highlighter } from "./markdown";
import { pickVerb, TURN_VERBS } from "./spinner-verbs";
import { formatElapsed, formatTokens } from "../task-display";
import { groupBlocks } from "./group-blocks";
import { formatArgsHead, MAX_RESULT_LINES } from "./format";

const ansi = new Chalk({ level: 3 });

export interface FlattenOpts {
  columns: number;
  verbose: boolean;
  highlight?: (code: string, lang?: string) => string;
}

/** Wraps ONE logical text line (may itself already contain no `\n` — callers split multi-line
 *  content before calling) at `width` visible columns, ANSI-aware, hard-wrapping unbroken runs
 *  longer than `width` (see file header's WRAP CHOICE note). Always returns at least one string
 *  (an empty input yields one empty row) — `wrap-ansi` already handles that degenerate case. */
function wrapLine(line: string, width: number): string[] {
  return wrapAnsi(line, Math.max(1, width), { hard: true, trim: false }).split("\n");
}

/** The two-column "gutter + content" row group (see file header's GUTTER MODEL note): `width` is
 *  the gutter's VISIBLE column count (2 for a "⏺ " glyph gutter, 5 for a "  ⎿  " result gutter) —
 *  passed as a plain number rather than derived from `firstPrefix.length` so ANSI styling baked
 *  into the prefix strings never corrupts the wrap-width math. Only the very first physical output
 *  row (across ALL of `contentLines`, not just the first array entry) carries `firstPrefix`; every
 *  other row — a later `contentLines` entry or a wrap-continuation of the current one — carries
 *  `blankPrefix` instead, so the glyph renders exactly once. An empty `contentLines` still emits
 *  one bare-gutter row (mirrors an Ink Box rendering its gutter Text alone with an empty sibling). */
function gutterRows(width: number, firstPrefix: string, blankPrefix: string, contentLines: string[], columns: number): string[] {
  const contentWidth = Math.max(1, columns - width);
  const out: string[] = [];
  for (const raw of contentLines) {
    for (const row of wrapLine(raw, contentWidth)) {
      out.push((out.length === 0 ? firstPrefix : blankPrefix) + row);
    }
  }
  if (out.length === 0) out.push(firstPrefix);
  return out;
}

/** The single-`<Text>` shape (user/note/skill/turn-summary/interrupted): the prefix is already
 *  baked into `styled`'s first line by the caller; every line (original or wrap-forced) wraps at
 *  the FULL `columns` width with no reindent, matching a plain flowing Ink Text. `wrap-ansi`
 *  normalizes/splits on `\n` internally, so a `styled` string with embedded newlines (e.g. a note's
 *  literal `"...\n⎿ Ran 1 tool calls"`) wraps each of those segments independently at the same
 *  `columns` budget without this function needing to pre-split them itself. */
function flowLines(styled: string, columns: number): string[] {
  return wrapAnsi(styled, Math.max(1, columns), { hard: true, trim: false }).split("\n");
}

/** One committed `Block` → its wrapped ANSI lines. Grouping (collapsed read/search runs) is NOT
 *  this function's concern — it always renders `block` as its own, ungrouped kind; `makeFlattenCache`
 *  below is what applies `groupBlocks` for the non-verbose case. `opts.verbose` only affects the
 *  TOOL case's output cap (10 lines + hint vs. full output) — matching `transcript.tsx` vs.
 *  `pager.tsx`'s existing verbose/non-verbose split for that one kind. */
export function flattenBlock(block: Block, opts: FlattenOpts): string[] {
  const { columns, verbose, highlight } = opts;

  switch (block.kind) {
    case "user": {
      // transcript.tsx: `<Text backgroundColor={theme.userMessageBackground}>{"❯ "}{block.text}</Text>`
      // — one Text node, background covers the whole (prefix+text) string; only line 0 gets "❯ ".
      const logical = block.text.split("\n").map((line, i) => (i === 0 ? `❯ ${line}` : line));
      return logical.flatMap((line) => wrapLine(ansi.bgHex(theme.userMessageBackground)(line), columns));
    }

    case "assistant": {
      // transcript.tsx: 2-col "⏺" gutter Box + flexGrow content Box holding renderMarkdown(...).
      const content = renderMarkdown(block.text, highlight as Highlighter | undefined).split("\n");
      return gutterRows(2, `${ansi.hex(theme.text)("⏺")} `, "  ", content, columns);
    }

    case "tool": {
      const argsHead = formatArgsHead(block.argsJson);
      const headText = `${ansi.bold(block.name)}${argsHead ? `(${argsHead})` : ""}`;
      const glyphColor = block.isError ? theme.error : theme.success;
      const head = gutterRows(2, `${ansi.hex(glyphColor)("⏺")} `, "  ", headText.split("\n"), columns);

      const output = block.output ?? "";
      if (output.length === 0) return head; // ToolResult renders null when output is empty

      const outLines = output.split("\n");
      const shown = verbose ? outLines : outLines.slice(0, MAX_RESULT_LINES);
      const hiddenCount = verbose ? 0 : outLines.length - shown.length;
      const contentLines = shown.map((line) => (block.isError ? ansi.hex(theme.error)(line) : line));
      if (hiddenCount > 0) contentLines.push(ansi.dim(`… +${hiddenCount} lines (ctrl+o to expand)`));

      const result = gutterRows(5, ansi.dim("  ⎿  "), "     ", contentLines, columns);
      return [...head, ...result];
    }

    case "skill":
      return flowLines(ansi.dim(`✻ Skill: ${block.name}`), columns);

    case "note":
      return flowLines(ansi.dim(`✻ ${block.text}`), columns);

    case "turn-summary": {
      const verb = pickVerb(TURN_VERBS, block.durationMs);
      const text = `✻ ${verb} for ${formatElapsed(block.durationMs)} · ↑${formatTokens(block.inTokens)} ↓${formatTokens(block.outTokens)} tokens`;
      return flowLines(ansi.dim(text), columns);
    }

    case "interrupted":
      return flowLines(ansi.dim("  ⎿  Interrupted · What should Norma do instead?"), columns);

    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

/** A collapsed run's one dim summary line — `transcript.tsx`'s `<CollapsedEntry>` equivalent. Not
 *  part of `flattenBlock` (it has no single underlying `Block` to key off) — only `makeFlattenCache`
 *  calls this, after `groupBlocks` has folded a run of collapsible tool blocks into a summary. */
function flattenCollapsedSummary(summary: string, columns: number): string[] {
  return gutterRows(2, `${ansi.dim("⏺")} `, "  ", [ansi.dim(`${summary} (ctrl+o to expand)`)], columns);
}

/** TUI renderer T3 — the in-flight turn rendered as TRANSCRIPT rows (the streaming block is the
 *  line log's last row-group now, not a pinned-bar slice — mechanism report Q2/Q7 cures 1-2).
 *  Supersedes the deleted `activeTurnLines`/`<ActiveTurn>` pair (absorbed here, T3). A stateful factory (one per App mount,
 *  same lifecycle idiom as `makeFlattenCache`) because it owns a `createStreamingMarkdown`
 *  instance — the monotonic stable-boundary cache that keeps per-delta work bounded to the open
 *  markdown segment (markdown.ts's T3 pin).
 *
 *  SWAP PARITY (the no-glue guarantee's pure half, pinned by flatten-blocks.test.ts): the
 *  assistant rows are built through the IDENTICAL `gutterRows` call `flattenBlock`'s assistant
 *  case uses — same glyph, same gutter widths, same wrap — over `createStreamingMarkdown`'s
 *  output, which is itself pinned byte-equal to `renderMarkdown(text)` at every prefix. So when
 *  `assistant_message` commits the streamed text (the reducer swaps `activeAssistant` → a
 *  committed block in ONE state update), the committed block's flattened rows are byte-identical
 *  to the streamed rows of the same text: the swap repaints nothing.
 *
 *  In-flight tool rows keep the pinned-bar era's exact shape (blinking dot via `dimToolDot`, bold
 *  name + argsHead) and render AFTER the assistant rows — the same order their committed
 *  counterparts take in the transcript, so a tool_result landing mid-turn also swaps in place. */
export function makeStreamRenderer(): {
  lines(
    assistant: string,
    tools: { name: string; argsJson: string }[],
    opts: { columns: number; highlight?: Highlighter; dimToolDot: boolean },
  ): string[];
} {
  const streamingMd = createStreamingMarkdown();
  return {
    lines(assistant, tools, opts) {
      const { columns, highlight, dimToolDot } = opts;
      const out: string[] = [];
      if (assistant) {
        const rendered = streamingMd.render(assistant, highlight);
        out.push(...gutterRows(2, `${ansi.hex(theme.text)("⏺")} `, "  ", rendered.split("\n"), columns));
      }
      for (const t of tools) {
        const argsHead = formatArgsHead(t.argsJson);
        const headText = `${ansi.bold(t.name)}${argsHead ? `(${argsHead})` : ""}`;
        const dot = dimToolDot ? ansi.dim("⏺") : "⏺";
        out.push(...gutterRows(2, `${dot} `, "  ", headText.split("\n"), columns));
      }
      return out;
    },
  };
}

/** Memoizing wrapper over `flattenBlock` (+ the collapsed-run summary) across an APPEND-ONLY
 *  `Block[]` (`TuiState.committed` only ever grows — see `state.ts`). `flatten` defaults to the
 *  real `flattenBlock`; the parameter exists so tests can pass a counting wrapper and observe
 *  exactly which indices get (re-)flattened on a given call (`test/tui/flatten-blocks.test.ts`'s
 *  "incremental memoization" suite) — `makeFlattenCache()` with no argument is the real call shape
 *  every other caller uses.
 *
 *  INVALIDATION RULES:
 *   1. Whole-cache: ANY change to `opts.columns` or `opts.verbose` between calls clears both caches
 *      entirely (a rewrap or a grouping-mode flip touches everything).
 *   2. Verbose mode: no grouping — cached per BLOCK ARRAY INDEX. Since `blocks` is append-only,
 *      indices never change meaning once assigned, so a later call only computes indices at/past
 *      the previous call's `blocks.length`.
 *   3. Non-verbose mode: `groupBlocks(blocks)` is recomputed every call (cheap: a linear fold, no
 *      flattening work) to get the current `DisplayItem[]`, then each display item's underlying
 *      BLOCK-INDEX SPAN (`start-end`, walked via a running cursor in lockstep with `groupBlocks`'s
 *      own left-to-right consumption of `blocks`) is used as the cache key:
 *        - A "block" item's span is always `[i, i]`.
 *        - A "collapsed" item's span is `[i, i + run.length - 1]`.
 *      A span is SETTLED (safe to cache) unless it is the LAST display item AND that item is a
 *      collapsed run — exactly `transcript.tsx`'s `tailIsOpenRun` condition (the 3b Static-holdback
 *      lesson: a still-open run at the end of `blocks` can silently absorb a next matching block
 *      without the display-item COUNT changing, so caching it by a span that might still grow would
 *      freeze its rendered summary stale, e.g. stuck at "Read 1 file" forever). The trailing open
 *      run is therefore ALWAYS re-flattened, unconditionally, on every call — regardless of whether
 *      new blocks actually arrived — trading a cheap, single-line re-render for correctness; every
 *      OTHER (settled) span is cached and only computed once. */
export function makeFlattenCache(
  flatten: (block: Block, opts: FlattenOpts) => string[] = flattenBlock,
): { lines(blocks: Block[], opts: FlattenOpts): string[] } {
  let lastColumns: number | undefined;
  let lastVerbose: boolean | undefined;
  const blockCache = new Map<number, string[]>(); // verbose mode: block index -> lines
  const spanCache = new Map<string, string[]>(); // non-verbose mode: "b:i" | "c:start-end" -> lines

  function invalidateIfOptsChanged(opts: FlattenOpts): void {
    if (opts.columns === lastColumns && opts.verbose === lastVerbose) return;
    blockCache.clear();
    spanCache.clear();
    lastColumns = opts.columns;
    lastVerbose = opts.verbose;
  }

  return {
    lines(blocks: Block[], opts: FlattenOpts): string[] {
      invalidateIfOptsChanged(opts);

      if (opts.verbose) {
        const out: string[] = [];
        for (let i = 0; i < blocks.length; i++) {
          let cached = blockCache.get(i);
          if (!cached) {
            cached = flatten(blocks[i]!, opts);
            blockCache.set(i, cached);
          }
          out.push(...cached);
        }
        return out;
      }

      const items = groupBlocks(blocks);
      const tailOpen = items.length > 0 && items[items.length - 1]!.kind === "collapsed";
      const out: string[] = [];
      let cursor = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const isLast = i === items.length - 1;

        if (item.kind === "collapsed") {
          const start = cursor;
          const end = cursor + item.blocks.length - 1;
          cursor += item.blocks.length;

          if (isLast && tailOpen) {
            out.push(...flattenCollapsedSummary(item.summary, opts.columns)); // always fresh — never cached
            continue;
          }
          const key = `c:${start}-${end}`;
          let cached = spanCache.get(key);
          if (!cached) {
            cached = flattenCollapsedSummary(item.summary, opts.columns);
            spanCache.set(key, cached);
          }
          out.push(...cached);
        } else {
          const idx = cursor;
          cursor += 1;
          const key = `b:${idx}`;
          let cached = spanCache.get(key);
          if (!cached) {
            cached = flatten(item.block, opts);
            spanCache.set(key, cached);
          }
          out.push(...cached);
        }
      }
      return out;
    },
  };
}
