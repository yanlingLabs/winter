/** `<ChoiceMenu>` (bugfix-pass B2) — the bottom PICKER for commands whose no-arg reply is a list
 *  the user is expected to PICK FROM (`/model`, `/output-style`) — the fix for the user-reported
 *  bug where `/model`'s model list landed in the TRANSCRIPT as note lines. It follows
 *  `<CompletionMenu>`'s interaction grammar and render conventions exactly (R4: that component's
 *  behavior is byte-pinned, so this is a SIBLING, not a modification): purely presentational — it
 *  takes the request's already-built `options` and the App's `selected` index and renders them; ALL
 *  key handling (↑/↓ move, Enter pick, Esc dismiss) lives in the App's `useInput` (the single actor
 *  while the picker is open — the composer is disabled for the duration, same discipline as roster
 *  select mode). No stdin listener, no mouse handling (a click-free keyboard surface like the
 *  completion menu — T1's mouse decode already keeps stray bytes out).
 *
 *  Row budget mirrors the completion menu's: ONE dim title row + at most `maxRows` (default 6)
 *  option rows, every visible row exactly one terminal line (overlong text JS-hard-truncated,
 *  ellipsis-terminated — never Yoga wrap), the render window sliding to keep `selected` visible.
 *  `choiceMenuRows` is the exported accounting twin: `bottomBarLayout`'s `pickerRows` input reads
 *  it, so the layout model's number IS the rendered height (HARD CONSTRAINT 2, app.tsx).
 *
 *  The pure selection/navigation model (`initialChoiceSelection`, `moveChoice`) is hoisted here and
 *  exported for direct unit tests — the non-TTY harness can't reach real key handling, so the
 *  App-side branch stays a thin dispatch over these. */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme";

/** One pickable row. `current` marks the value that is active TODAY (`*` in the render — the same
 *  marker the old transcript dump used) and seeds the initial selection. */
export interface ChoiceOption {
  value: string;
  label: string;
  hint?: string;
  current?: boolean;
}

/** What a command runner hands the App (via `CommandCtx.openChoice`) to open the picker. `onPick`
 *  runs on Enter with the chosen option's `value` — for `/model`/`/output-style` it is the SAME
 *  settings write path the direct typed form takes; Esc dismisses without calling it. Declared here
 *  (beside the component that renders it) and type-imported by commands.ts — a type-only import,
 *  so that module stays free of any runtime React dependency. */
export interface ChoiceRequest {
  title: string;
  options: ChoiceOption[];
  onPick(value: string): void | Promise<void>;
}

/** Same fixed ceiling as the completion menu's `MAX_MENU_ROWS` — its own constant (not an import)
 *  because the two menus' budgets are independent knobs that happen to share a value today. */
export const MAX_CHOICE_ROWS = 6;
const DEFAULT_COLUMNS = 80;

/** Where the picker's highlight starts: on the CURRENT option when one is marked (so Enter with no
 *  navigation is a no-op-shaped confirm), else the first row. */
export function initialChoiceSelection(options: readonly ChoiceOption[]): number {
  const idx = options.findIndex((o) => o.current === true);
  return idx === -1 ? 0 : idx;
}

/** One ↑/↓ step: re-bounds a stale `selected` into `[0, count-1]` first (the completion menu's own
 *  bounded-then-step shape in composer.tsx), then clamps the step at both ends. `count <= 0` → 0. */
export function moveChoice(selected: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const bounded = Math.min(Math.max(0, selected), count - 1);
  return Math.min(count - 1, Math.max(0, bounded + delta));
}

/** The picker's rendered row count — the accounting twin `bottomBarLayout`'s `pickerRows` input
 *  reads (1 title row + the windowed option rows; 0 when there is nothing to pick and the
 *  component renders null). */
export function choiceMenuRows(optionCount: number, maxRows: number = MAX_CHOICE_ROWS): number {
  if (optionCount <= 0) return 0;
  return 1 + Math.min(Math.max(1, maxRows), optionCount);
}

/** Same math as the completion menu's window: first visible index of a `rows`-tall window over
 *  `total` options keeping `selected` inside it — centered when there's room, clamped at the edges. */
function windowStart(selected: number, total: number, rows: number): number {
  if (total <= rows) return 0;
  const centered = selected - Math.floor(rows / 2);
  return Math.max(0, Math.min(centered, total - rows));
}

/** Hard JS truncation (never Yoga wrap — see the file doc): the assembled
 *  `"{marker+label} — {hint}"` line never exceeds `columns` cells; the hint is dropped/truncated
 *  first, the label only in the very-narrow-terminal case. Mirrors the completion menu's rule. */
function truncateRow(label: string, hint: string | undefined, columns: number): { label: string; hint: string } {
  const cols = Math.max(1, columns);
  if (label.length > cols) {
    return { label: cols > 1 ? `${label.slice(0, cols - 1)}…` : label.slice(0, cols), hint: "" };
  }
  if (!hint) return { label, hint: "" };
  const sep = " — ";
  const available = cols - label.length - sep.length;
  if (available <= 0) return { label, hint: "" };
  if (hint.length <= available) return { label, hint };
  return { label, hint: available > 1 ? `${hint.slice(0, available - 1)}…` : "" };
}

/** One physical line, truncated (for the title row). */
function truncateLine(text: string, columns: number): string {
  const cols = Math.max(1, columns);
  if (text.length <= cols) return text;
  return cols > 1 ? `${text.slice(0, cols - 1)}…` : text.slice(0, cols);
}

export interface ChoiceMenuProps {
  title: string;
  options: ChoiceOption[];
  selected: number;
  /** Ever-present ceiling on visible OPTION rows (the title row is extra — `choiceMenuRows`). */
  maxRows?: number;
  /** Terminal width for the hard JS truncation; defaults to 80 like the completion menu. */
  columns?: number;
}

export function ChoiceMenu({ title, options, selected, maxRows = MAX_CHOICE_ROWS, columns = DEFAULT_COLUMNS }: ChoiceMenuProps) {
  if (options.length === 0) return null;
  const rows = Math.min(Math.max(1, maxRows), options.length);
  const start = windowStart(selected, options.length, rows);
  const visible = options.slice(start, start + rows);

  return (
    <Box flexDirection="column">
      {/* The one-line dim heading: what is being picked + the interaction grammar (the completion
       *  menu needs no such line — its trigger is the text being typed; a command-opened picker
       *  has no other affordance naming its keys). */}
      <Text dimColor>{truncateLine(`${title} — ↑↓ · enter select · esc cancel`, columns)}</Text>
      {visible.map((opt, i) => {
        const idx = start + i;
        const isSelected = idx === selected;
        // Two marker cells: the `❯` selection pointer (plain-text — the accent inverse below is
        // invisible to the non-TTY harness AND to no-color terminals) + the `*` current marker
        // (the same glyph the old transcript dump used).
        const { label, hint } = truncateRow(`${isSelected ? "❯" : " "}${opt.current ? "*" : " "} ${opt.label}`, opt.hint, columns);
        return (
          <Box key={`${idx}-${opt.value}`} flexDirection="row">
            <Text inverse={isSelected} color={isSelected ? theme.accent : undefined}>
              {label}
            </Text>
            {hint ? <Text dimColor>{` — ${hint}`}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
