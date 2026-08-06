/** `<CommittedTranscript>` (Phase 3b Task 3; Phase 3c Task 4 — the `<Static>` scrollback path
 *  RETIRED). Renders `Block[]` with the Claude-Code transcript grammar (binding reference:
 *  `.superpowers/sdd/cc-ui-study-transcript.md` §2, ADAPTED not copied): every assistant action is a
 *  `⏺`-gutter line, tool results hang a dim `  ⎿  `-gutter continuation underneath, user turns get a
 *  `❯ ` pointer, and system one-liners (notes/turn-summary/interrupted) get a dim `✻ ` (or the `⎿`
 *  continuation glyph for "interrupted", since it always follows the turn it belongs to).
 *
 *  Phase 3c Task 4 note: the FULLSCREEN app (`app.tsx`) no longer renders scrollback through this
 *  component or Ink's `<Static>`. The production transcript is now a JS-windowed line log
 *  (`flatten-blocks.ts` → `scroll-model.ts` → `<TranscriptViewport>` below, one `<Text>` per
 *  visible line) so the alt-screen frame height stays a hard `rows - 1` (Ink's `<Static>` was
 *  fundamentally incompatible with that: its write-once scrollback + the alt-screen buffer discard
 *  could silently lose committed lines). What survives here alongside the viewport is the per-block
 *  Ink GRAMMAR renderers (`TranscriptEntry`/`ToolResult`/`CollapsedEntry`), still exercised by
 *  `test/tui/components.test.tsx` as the canonical rendering spec that `flatten-blocks.ts`'s string
 *  builders mirror for visible-text parity. `formatArgsHead` and `MAX_RESULT_LINES` live in the
 *  React-free `format.ts` now; `formatArgsHead` is re-exported here so existing importers of the
 *  transcript module keep resolving.
 *
 *  INK CONSTRAINT NOTE: Ink 5's `<Box>` has no `backgroundColor` prop (only `<Text>` does); the
 *  study's "solid full-width highlight block" for user messages is approximated as `backgroundColor`
 *  on the `<Text>` node itself.
 *
 *  Pure presentational: no client, no side effects. */

import React from "react";
import { Box, Text } from "ink";
import type { Block } from "./state";
import { theme } from "./theme";
import { renderMarkdown, type Highlighter } from "./markdown";
import { pickVerb, TURN_VERBS } from "./spinner-verbs";
import { formatElapsed, formatTokens } from "../task-display";
import { groupBlocks, type DisplayItem } from "./group-blocks";
import { formatArgsHead, MAX_RESULT_LINES } from "./format";
import { visibleSlice, type ScrollState } from "./scroll-model";

// Re-export for existing importers of the transcript module (the args-head cap now lives in the
// React-free format.ts, its single definition; see this file's header).
export { formatArgsHead };

function ToolResult({ output, isError }: { output: string; isError?: boolean }) {
  if (output.length === 0) return null;
  const lines = output.split("\n");
  const shown = lines.slice(0, MAX_RESULT_LINES);
  const hiddenCount = lines.length - shown.length;
  return (
    <Box flexDirection="row">
      <Box minWidth={5}>
        <Text dimColor>{"  ⎿  "}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {shown.map((line, i) => (
          <Text key={i} color={isError ? theme.error : undefined}>
            {line}
          </Text>
        ))}
        {hiddenCount > 0 ? <Text dimColor>{`… +${hiddenCount} lines (ctrl+o to expand)`}</Text> : null}
      </Box>
    </Box>
  );
}

function TranscriptEntry({ block, highlight }: { block: Block; highlight?: Highlighter }) {
  switch (block.kind) {
    case "user":
      return (
        <Box>
          <Text backgroundColor={theme.userMessageBackground}>
            {"❯ "}
            {block.text}
          </Text>
        </Box>
      );

    case "assistant":
      return (
        <Box flexDirection="row">
          <Box minWidth={2}>
            <Text color={theme.text}>⏺</Text>
          </Box>
          <Box flexGrow={1}>
            <Text>{renderMarkdown(block.text, highlight)}</Text>
          </Box>
        </Box>
      );

    case "tool": {
      const argsHead = formatArgsHead(block.argsJson);
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Box minWidth={2}>
              <Text color={block.isError ? theme.error : theme.success}>⏺</Text>
            </Box>
            <Box flexGrow={1}>
              <Text>
                <Text bold>{block.name}</Text>
                {argsHead ? <Text>({argsHead})</Text> : null}
              </Text>
            </Box>
          </Box>
          <ToolResult output={block.output ?? ""} isError={block.isError} />
        </Box>
      );
    }

    case "skill":
      return (
        <Text dimColor>
          {"✻ Skill: "}
          {block.name}
        </Text>
      );

    case "note":
      return (
        <Text dimColor>
          {"✻ "}
          {block.text}
        </Text>
      );

    case "turn-summary": {
      const verb = pickVerb(TURN_VERBS, block.durationMs);
      return (
        <Text dimColor>
          {"✻ "}
          {verb} for {formatElapsed(block.durationMs)} · ↑{formatTokens(block.inTokens)} ↓{formatTokens(block.outTokens)}{" "}
          tokens
        </Text>
      );
    }

    case "interrupted":
      return <Text dimColor>{"  ⎿  Interrupted · What should Norma do instead?"}</Text>;

    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

/** A collapsed run renders as ONE dim `⏺`-gutter line: the summary text plus a dim
 *  " (ctrl+o to expand)" hint — same gutter layout as the assistant/tool cases, uncolored (dim). */
function CollapsedEntry({ summary }: { summary: string }) {
  return (
    <Box flexDirection="row">
      <Box minWidth={2}>
        <Text dimColor>⏺</Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor>
          {summary}
          {" (ctrl+o to expand)"}
        </Text>
      </Box>
    </Box>
  );
}

function DisplayEntry({ item, highlight }: { item: DisplayItem; highlight?: Highlighter }) {
  return item.kind === "collapsed" ? <CollapsedEntry summary={item.summary} /> : <TranscriptEntry block={item.block} highlight={highlight} />;
}

/** `<TranscriptViewport>` (TUI renderer T2) — the production transcript window: renders ONLY the
 *  `visibleSlice` of the pre-wrapped line log (`flatten-blocks.ts` output — each entry is already
 *  one physical terminal row, wrapped at `columns`; see the wrap-model note below), never the whole
 *  log, so tree size and repaint work are bounded by the viewport, not transcript length
 *  (mechanism report Q5, adapted). `viewportRows` is the app-computed budget: terminal rows minus
 *  the pinned chrome (`bottomBarRows` in app.tsx owns that subtraction — the chrome's height model
 *  lives with the chrome's state, not here).
 *
 *  PAINT OVERSCAN IS 0, DELIBERATELY: the alt-screen frame is hard-capped at `rows - 1` (app.tsx
 *  HARD CONSTRAINT 1) and Yoga overflow-clipping is banned (HARD CONSTRAINT 2), so a single row
 *  beyond the budget would corrupt the frame math — `OVERSCAN_ROWS` (scroll-model.ts) is for
 *  consumers that PREPARE row neighborhoods rather than paint them.
 *
 *  THE HONESTY LINE: while scrolled back with content hidden below (`!follow` and the window's end
 *  short of the log's), the viewport's BOTTOM row becomes a dim `↓ N newer lines` indicator — the
 *  top edge (where the user is reading) stays put, the newest visible row yields the slot, and `N`
 *  counts every hidden row INCLUDING the one the indicator displaced. No indicator while followed
 *  (nothing is hidden) or when an unfollowed view still shows the bottom (N would be a lie at 0).
 *
 *  WRAP MODEL (why slicing by array index is exact): rows here are not logical lines — they are the
 *  post-wrap physical lines `flatten-blocks.ts`/`welcomeLines` emit (wrap-ansi, hard:true, at the
 *  live `columns`), so 1 array entry = 1 terminal row BY CONSTRUCTION and the slice math never
 *  drifts from rendered height. The residual error bound is a width-measurement disagreement
 *  between `string-width` (wrap-ansi's ruler) and the terminal's own cell count for exotic
 *  graphemes — shared by every other height model in this app (composerRows, activeTurnLines). */
export function TranscriptViewport({ lines, scroll, viewportRows }: {
  lines: string[];
  scroll: ScrollState;
  viewportRows: number;
}) {
  const { start, end } = visibleSlice(lines, scroll, viewportRows, 0);
  const showIndicator = viewportRows > 0 && !scroll.follow && end < lines.length;
  const contentEnd = showIndicator ? Math.max(start, end - 1) : end;
  const newerCount = lines.length - contentEnd;
  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {lines.slice(start, contentEnd).map((line, i) => (
        <Text key={start + i}>{line.length > 0 ? line : " "}</Text>
      ))}
      {showIndicator ? <Text dimColor>{`↓ ${newerCount} newer line${newerCount === 1 ? "" : "s"}`}</Text> : null}
    </Box>
  );
}

/** Renders `TuiState.committed` with the CC grammar, `groupBlocks`-collapsed. Recomputed fresh every
 *  render (no `<Static>` write-once index to keep sound anymore) — a still-open trailing collapsible
 *  run therefore updates its summary live as later blocks arrive, no holdback needed. */
export function CommittedTranscript({ items, highlight }: { items: Block[]; highlight?: Highlighter }) {
  const displayItems = groupBlocks(items);
  return (
    <Box flexDirection="column">
      {displayItems.map((item, i) => (
        <Box key={i}>
          <DisplayEntry item={item} highlight={highlight} />
        </Box>
      ))}
    </Box>
  );
}
