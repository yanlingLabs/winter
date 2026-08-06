/** `<Footer>` (Phase 3b Task 5; Phase 3c Task 5; SP-policies Task 13; TUI renderer T5 — rebuilt as
 *  the thin renderer over `statusChromeModel`'s output).
 *
 *  T5: ALL content decisions moved into the pure selector (`statusChromeModel`, state.ts) — which
 *  segments render (policy mode / esc-hint / agents pill / fallback / activity chip / model+effort),
 *  the running-work line, the two-line cap, and exit-armed's whole-chrome replacement. This
 *  component only lays that model out: one `<Text wrap="truncate">` per StatusLine (each line is
 *  EXACTLY one terminal row — never a wrap — so app.tsx's `bottomBarLayout` can count
 *  `lines.length` and the height model never lies), dim base with per-segment theme colors, and
 *  the line's own `sep` between segments (the established `" · "` on the status line; a plain
 *  space between the work line's spinner glyph and its summary).
 *
 *  Pure — no client, no timers; `lines` is the caller-computed snapshot (App runs the selector
 *  with its live policy/model/roster/bgTasks/activity/exit-armed state each render; byte-stability
 *  across idle renders is the SELECTOR's contract, pinned in state.test.ts + here). */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme";
import type { StatusLine, StatusTone } from "./state";

/** Which key armed the T5 double-press exit window — declared here (its historical home; app.tsx
 *  imports it) and structurally identical to `StatusChromeInput.exitArmed`'s union. */
export type ExitKey = "ctrl-c" | "ctrl-d";

export interface FooterProps {
  /** `statusChromeModel(...)`'s `lines`, rendered verbatim — one terminal row each. */
  lines: StatusLine[];
}

/** Tone → Ink color. `"dim"` returns undefined so the segment inherits the line's dim base. */
function toneColor(tone: StatusTone): string | undefined {
  switch (tone) {
    case "planMode": return theme.planMode;
    case "warning": return theme.warning;
    case "autoAccept": return theme.autoAccept;
    case "dangerMode": return theme.dangerMode;
    case "accent": return theme.accent;
    default: return undefined;
  }
}

export function Footer({ lines }: FooterProps) {
  return (
    <Box flexDirection="column">
      {lines.map((line) => (
        <Text key={line.key} dimColor wrap="truncate">
          {line.segments.map((segment, i) => {
            const color = toneColor(segment.tone);
            return (
              <Text key={`${line.key}-${i}`}>
                {i > 0 ? line.sep : ""}
                {color !== undefined ? <Text color={color}>{segment.text}</Text> : segment.text}
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}
