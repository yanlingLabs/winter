/** `<Spinner>` (Phase 3b Task 5) — the CC-shaped animated in-progress indicator: a 6-glyph
 *  asterisk cycle (`· ✢ ✳ ✶ ✻ ✽`) played forward-then-reverse, an ever-changing whimsical verb
 *  (the current in-progress task's subject when one exists, else a deterministic pick from
 *  `SPINNER_VERBS` seeded by `turnStartMs`), and a dim byline that progressively reveals elapsed
 *  time and (once non-zero) output-token count. Hidden entirely while `!running`.
 *
 *  Pure — no `Date.now()`/timers in here; `nowMs`/`turnStartMs` are the caller's injected clock
 *  (the App ticks it), matching `task-list.tsx`'s existing convention. The frame
 *  index math is exposed as the standalone pure helper `spinnerFrame(elapsedMs)` per the brief, so
 *  tests can assert the cycle without mounting the component. */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme";
import { pickVerb, SPINNER_VERBS, spinnerFrame } from "./spinner-verbs";
import { formatElapsed, formatTokens, type TaskRow } from "../task-display";

// TUI renderer T5: the glyph cycle + `spinnerFrame` moved to spinner-verbs.ts (the pure module) so
// `statusChromeModel` (state.ts) can share the frame math without an Ink import; re-exported here
// so this module's existing import surface (spinner.test.tsx and any future consumer) is unchanged.
export { spinnerFrame };

export interface SpinnerProps {
  running: boolean;
  turnStartMs?: number;
  nowMs: number;
  outTokens: number;
  tasks: TaskRow[];
}

export function Spinner({ running, turnStartMs, nowMs, outTokens, tasks }: SpinnerProps) {
  if (!running) return null;
  const elapsedMs = nowMs - (turnStartMs ?? nowMs);
  const glyph = spinnerFrame(elapsedMs);
  const inProgress = tasks.find((t) => t.status === "in_progress");
  const verb = inProgress ? inProgress.subject : pickVerb(SPINNER_VERBS, turnStartMs ?? 0);
  const tokenSuffix = outTokens > 0 ? ` · ↓ ${formatTokens(outTokens)} tokens` : "";

  return (
    <Box flexDirection="row">
      <Text color={theme.accent}>{glyph}</Text>
      <Text>
        {" "}
        {verb}…{" "}
        <Text dimColor>
          (esc to interrupt · {formatElapsed(elapsedMs)}
          {tokenSuffix})
        </Text>
      </Text>
    </Box>
  );
}
