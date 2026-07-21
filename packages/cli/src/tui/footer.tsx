/** `<Footer>` (Phase 3b Task 5; Phase 3c Task 5 — exit-armed override; SP-policies Task 13 — 6-mode
 *  render) — the CC-shaped single dim hint line beneath the composer: an approval-policy mode
 *  indicator for every non-`ask` policy (`plan`/`dont-ask`/`accept-edits`/`auto`/`bypass`, colored
 *  per `theme.planMode`/`theme.warning`/`theme.autoAccept`(×2)/`theme.dangerMode` respectively;
 *  `ask` renders no special segment — it's the unmarked default), an `esc to interrupt` hint while a
 *  turn runs, and an agents pill (`N agent(s) · ctrl+a`) when any subagents are live — segments
 *  joined with `" · "`.
 *  Live child-transcript view T3: the pill's hint changed from `ctrl+t` to `ctrl+a` — `ctrl+t`
 *  never opened/selected an agent, it toggles the (unrelated) task-list view; the roster's own
 *  select-mode toggle (app.tsx) is `ctrl+a`, so this is a truthfulness fix, not a rebind (`ctrl+t`
 *  keeps its existing task-list behavior, unchanged, just no longer misattributed here).
 *  When none of those render, a fallback `? for shortcuts · shift+tab to cycle modes` hint keeps
 *  the line non-empty (cc-ui-study-chrome.md §1's `PromptInputFooterLeftSide` empty-state hint,
 *  adapted; Phase 3d T4 adds the `? for shortcuts` half, pointing at the composer's own `?`-on-
 *  empty -> `/help` shortcut — composer.tsx).
 *
 *  T5: while the double-ctrl+C/ctrl+D exit window is armed (`exitArmed` carries WHICH key armed it —
 *  whole-branch review item 3), this REPLACES the whole line with the exact key-specific dim hint
 *  ("Press Ctrl-C again to exit" / "Press Ctrl-D again to exit", reference behavior) — no other
 *  segment renders alongside it, so the line reads unambiguously as "press again to exit" rather
 *  than getting lost among mode/agents chrome.
 *
 *  Pure — no client, no timers; `policy`/`running`/`agents`/`exitArmed` are all caller-supplied
 *  snapshots. */

import React from "react";
import { Text } from "ink";
import type { ApprovalPolicy } from "@norma/protocol";
import { theme } from "./theme";
import type { AgentRow } from "./state";

/** Which key armed the T5 double-press exit window — declared here (the component that renders the
 *  distinction) and imported by app.tsx (the component that tracks it). */
export type ExitKey = "ctrl-c" | "ctrl-d";

export interface FooterProps {
  policy: ApprovalPolicy;
  running: boolean;
  agents: AgentRow[];
  /** T5 double-ctrl+C/ctrl+D exit flow: the key that armed the ~800ms window on its FIRST press;
   *  `undefined` when not armed. Optional so every pre-T5 call site (and non-Ink test) stays
   *  byte-identical. */
  exitArmed?: ExitKey;
}

export function Footer({ policy, running, agents, exitArmed }: FooterProps) {
  if (exitArmed) {
    return <Text dimColor>{exitArmed === "ctrl-d" ? "Press Ctrl-D again to exit" : "Press Ctrl-C again to exit"}</Text>;
  }

  const segments: React.ReactNode[] = [];

  if (policy === "plan") {
    segments.push(
      <Text key="mode" color={theme.planMode}>
        ⏸ plan mode on (shift+tab to cycle)
      </Text>,
    );
  } else if (policy === "dont-ask") {
    segments.push(
      <Text key="mode" color={theme.warning}>
        ✕ dont-ask — auto-declines prompts (shift+tab to cycle)
      </Text>,
    );
  } else if (policy === "accept-edits") {
    segments.push(
      <Text key="mode" color={theme.autoAccept}>
        ✎ accept edits (shift+tab to cycle)
      </Text>,
    );
  } else if (policy === "auto") {
    segments.push(
      <Text key="mode" color={theme.autoAccept}>
        ⏵⏵ auto mode on (shift+tab to cycle)
      </Text>,
    );
  } else if (policy === "bypass") {
    segments.push(
      <Text key="mode" color={theme.dangerMode}>
        ⚠ bypass — all actions auto-approved (shift+tab to cycle)
      </Text>,
    );
  }

  if (running) segments.push(<Text key="interrupt">esc to interrupt</Text>);

  if (agents.length > 0) {
    const noun = agents.length === 1 ? "agent" : "agents";
    segments.push(
      <Text key="agents">
        {agents.length} {noun} · ctrl+a
      </Text>,
    );
  }

  if (segments.length === 0) {
    segments.push(<Text key="fallback">? for shortcuts · shift+tab to cycle modes</Text>);
  }

  return (
    <Text dimColor>
      {segments.map((segment, i) => (
        <Text key={`slot-${i}`}>
          {i > 0 ? " · " : ""}
          {segment}
        </Text>
      ))}
    </Text>
  );
}
