/** `<PendingCards>` (Phase 3a Task 5) — the approval / ask_user-question / plan cards that TAKE
 *  OVER input while `TuiState.pending` is set (the App mounts this component instead of, and
 *  passes the composer `disabled` alongside, `<Composer>` — Task 4's `disabled` wiring already
 *  covers the composer side of that hand-off). Each card owns its OWN `useInput` buffer (Task 4's
 *  same pattern: buffer/backspace/printable-char state, Enter cooks the line) since there is no
 *  `readLine()` to `await` in Ink's render-driven world — main.ts's async per-card loops
 *  (packages/cli/src/main.ts:531-616) are reproduced here as per-card state machines instead.
 *
 *  Byte-parity source of truth is main.ts's three branches:
 *   - approval (main.ts:532): `approve {toolName}? {summary} [y/N] ` — Enter cooks
 *     `onApprove(callId, line.trim().toLowerCase() === "y")` (main.ts:724 — case-insensitive "y"
 *     only; "n"/"yes"/anything else is false).
 *   - plan (main.ts:609-614): "Plan" header, the plan text, the fixed 3-line menu, then
 *     `onPlan(callId, parsePlanResponse(line))` — parsePlanResponse (plan-response.ts) already
 *     encodes the "1"/"2"/"3 <reason>"/free-text-as-rejection rules; not re-derived here.
 *   - question / ask_user (main.ts:557-602): the one non-trivial card. Legacy loops
 *     `for (const q of e.questions)` with THREE sequential readLine()s per question (answer,
 *     optionally re-prompted as "Other" free text, then an optional note) and calls
 *     `askUserRespond` exactly once after the LAST question's note. Reproduced below as a
 *     3-phase-per-question state machine (`qi` + `phase`) so the same three prompts/transitions
 *     fire in the same order for however many questions the array holds, and `onAnswer` fires
 *     exactly once, at the very end — never per-question. */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PendingCard } from "./state";
import { formatOptionLines, isOtherChoice, parseQuestionAnswer } from "../questions";
import { parsePlanResponse } from "../plan-response";
import { theme } from "./theme";

export interface AnswerPayload {
  answers: Record<string, string>;
  notes?: Record<string, string>;
}

export interface PendingCardsProps {
  pending: PendingCard;
  // optionId (SP-approvals T7): set only when the human picked a numbered rule-bearing option
  // (never for the "y"/Enter/"n" paths) — see ApprovalCard below.
  onApprove: (callId: string, yes: boolean, optionId?: string) => void;
  onAnswer: (callId: string, payload: AnswerPayload) => void;
  onPlan: (callId: string, resp: ReturnType<typeof parsePlanResponse>) => void;
}

/** Shared "cooked line" input handling every card below uses identically: printable chars append
 *  to the buffer, backspace/delete pops the last char (safe on empty), Enter is handled by the
 *  caller. Factored out once rather than re-typed per card (approval/plan/question all need it). */
function useBufferedInput(onEnter: (line: string) => void) {
  const [buffer, setBuffer] = useState("");
  useInput((input, key) => {
    if (key.return) {
      onEnter(buffer);
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
  });
  return [buffer, setBuffer] as const;
}

// Phase 5e T5: reviewer text is model-summarized input riding a NEW client-facing surface — already
// newline-stripped + capped at 300 on the wire (engine.ts's sanitizeReviewText), but treated as
// tainted for LAYOUT here too: a defensive second newline-strip plus a much tighter single-line cap
// (the wire limit is a payload cap, not a terminal-width one) — same "cap + trailing ellipsis on
// truncation" convention as format.ts's `formatArgsHead`. Exported for the pure-helper unit tests
// (pending-cards.test.tsx) — the exact-boundary cases can't be pinned through a rendered frame
// (Ink wraps at terminal width), matching the Swift twin's unit-tested capReviewerReason.
const REVIEWER_REASON_MAX_CHARS = 100;
export function capReviewerReason(reason: string): string {
  const oneLine = reason.replace(/\r?\n/g, " ");
  return oneLine.length > REVIEWER_REASON_MAX_CHARS ? `${oneLine.slice(0, REVIEWER_REASON_MAX_CHARS)}…` : oneLine;
}

type ApprovalCardPending = Extract<PendingCard, { kind: "approval" }>;

// SP-approvals T7: of the daemon's `options` (events.ts's `ApprovalOption[]`, Task 5's
// `approvalOptionsFor`), only the RULE-BEARING ones (a `rule` string attached — the
// allow_project/allow_global shapes) get a numbered `[N]` menu line. `allow_once`/`deny` are the
// CLI's own fixed `[y]`/`[n]` vocabulary regardless of the daemon's id/label for those two — same
// division as today's plain y/N, which was never driven by a protocol-supplied label either.
function ruleBearingOptions(options: ApprovalCardPending["options"]): NonNullable<ApprovalCardPending["options"]> {
  return options?.filter((o) => o.rule !== undefined) ?? [];
}

function ApprovalCard({ pending, onApprove }: { pending: ApprovalCardPending; onApprove: PendingCardsProps["onApprove"] }) {
  const ruleOptions = ruleBearingOptions(pending.options);

  const [buffer, setBuffer] = useBufferedInput((line) => {
    if (pending.options === undefined) {
      // Byte-identical legacy parse (regression-pinned by (d1a)/(a1-4) below): only a bare "y"
      // (case-insensitive) is true; anything else — including a bare Enter — denies.
      onApprove(pending.callId, line.trim().toLowerCase() === "y");
      setBuffer("");
      return;
    }
    const trimmed = line.trim();
    // Strict digit gate (SP-approvals T7 review): only a bare run of 0-9 counts as a menu index —
    // "1.0"/"1e1"/"0x1" etc. must deny, not silently coerce through `Number()`.
    const isDigits = /^\d+$/.test(trimmed);
    const asIndex = Number(trimmed);
    if (isDigits && asIndex >= 1 && asIndex <= ruleOptions.length) {
      onApprove(pending.callId, true, ruleOptions[asIndex - 1]!.id);
    } else if (trimmed.toLowerCase() === "y") {
      onApprove(pending.callId, true);
    } else {
      // "n", bare Enter, out-of-range/non-numeric, or anything else — deny, no optionId; only
      // explicit "y" or an in-range digit allows — the CLI's rule is unrecognized/blank never
      // allows; spec §5's CLI bullet has no Enter mandate (only the Mac bullet does, and a GUI
      // default button is a different affordance) — fail-safe deny wins here, same as the
      // no-options card above and the out-of-range-digit case just above.
      onApprove(pending.callId, false);
    }
    setBuffer("");
  });

  // Phase 3b T7 restyle (theme colors only — no behavior/parse change): the approval prompt line is
  // rendered in `theme.permission` (CC's approval-request hue); the summary keeps its dim de-emphasis.
  if (pending.options === undefined) {
    const actionRow = (
      <Text color={theme.permission}>
        approve {pending.toolName}? <Text dimColor>{pending.summary}</Text> [y/N] {buffer}
      </Text>
    );

    // Phase 5e T5: reviewerReason absent → the EXACT SAME single <Text> returned before this field
    // existed (no wrapping Box) — byte-identical regression pin (pending-cards.test.tsx). Present →
    // one distinct dim `⚠ reviewer: …` line ABOVE the action row.
    if (pending.reviewerReason === undefined) return actionRow;

    return (
      <Box flexDirection="column">
        <Text dimColor>⚠ reviewer: {capReviewerReason(pending.reviewerReason)}</Text>
        {actionRow}
      </Box>
    );
  }

  // SP-approvals T7: options present — a numbered allow-rule menu replaces the bare [y/N]
  // indicator, one choice per line (same convention as PlanCard's fixed menu / QuestionCard's
  // numbered options below it in this file), buffer echoing on the final [n] line.
  return (
    <Box flexDirection="column">
      {pending.reviewerReason !== undefined && (
        <Text dimColor>⚠ reviewer: {capReviewerReason(pending.reviewerReason)}</Text>
      )}
      <Text color={theme.permission}>
        approve {pending.toolName}? <Text dimColor>{pending.summary}</Text>
      </Text>
      <Text>[y] allow once</Text>
      {ruleOptions.map((o, i) => (
        <Text key={o.id}>{`[${i + 1}] ${o.label}`}</Text>
      ))}
      <Text>[n] deny {buffer}</Text>
    </Box>
  );
}

function PlanCard({ pending, onPlan }: { pending: Extract<PendingCard, { kind: "plan" }>; onPlan: PendingCardsProps["onPlan"] }) {
  const [buffer, setBuffer] = useBufferedInput((line) => {
    onPlan(pending.callId, parsePlanResponse(line));
    setBuffer("");
  });

  // Phase 3b T7 restyle (theme colors only): the "Plan" header takes the Norma accent; the plan body
  // and the fixed menu are unchanged.
  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>Plan</Text>
      <Text>{pending.plan}</Text>
      <Text>{"  1) approve — I'll approve each edit"}</Text>
      <Text>{"  2) approve + auto-accept edits"}</Text>
      <Text>{"  3) reject (type: 3 <reason>)"}</Text>
      <Text>choose (number or text): {buffer}</Text>
    </Box>
  );
}

// Legacy `ask_user` question shape (main.ts's `e.questions` elements) — narrowed from the
// PendingCard's `questions: unknown[]` at render time, not re-declared in the protocol.
interface LegacyOption {
  label: string;
  description?: string;
  preview?: string;
}
interface LegacyQuestion {
  // Optional since Chat mode Slice B1 — chat's `AskQuestion` omits it for its simplified card
  // (`header === undefined` is the wire signal; see `packages/protocol/src/events.ts`'s
  // `QuestionSchema`). code mode's `ask_user` always sends one.
  header?: string;
  question: string;
  options: LegacyOption[];
  multiSelect: boolean;
}

type QuestionPhase = "answer" | "otherAnswer" | "note";

function QuestionCard({ pending, onAnswer }: { pending: Extract<PendingCard, { kind: "question" }>; onAnswer: PendingCardsProps["onAnswer"] }) {
  const questions = pending.questions as LegacyQuestion[];
  const [qi, setQi] = useState(0);
  const [phase, setPhase] = useState<QuestionPhase>("answer");
  const [buffer, setBuffer] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const q = questions[qi];

  useInput(
    (input, key) => {
      if (!q) return;
      if (key.return) {
        if (phase === "answer") {
          if (isOtherChoice(buffer, q.options.length)) {
            setPhase("otherAnswer");
            setBuffer("");
            return;
          }
          const answer = parseQuestionAnswer(buffer, q.options.map((o) => o.label), q.multiSelect);
          setAnswers((a) => ({ ...a, [q.question]: answer }));
          setPhase("note");
          setBuffer("");
          return;
        }
        if (phase === "otherAnswer") {
          setAnswers((a) => ({ ...a, [q.question]: buffer.trim() }));
          setPhase("note");
          setBuffer("");
          return;
        }
        // phase === "note": optional free-text note, then advance (or finish).
        const trimmedNote = buffer.trim();
        const nextNotes = trimmedNote !== "" ? { ...notes, [q.question]: trimmedNote } : notes;
        if (trimmedNote !== "") setNotes(nextNotes);

        const nextQi = qi + 1;
        if (nextQi < questions.length) {
          setQi(nextQi);
          setPhase("answer");
          setBuffer("");
        } else {
          onAnswer(pending.callId, {
            answers,
            ...(Object.keys(nextNotes).length > 0 ? { notes: nextNotes } : {}),
          });
        }
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
    },
    { isActive: !!q },
  );

  if (!q) return null;

  const optionLines = q.options
    .flatMap((o, i) => formatOptionLines(i + 1, o))
    .map((line) => line.replace(/\n$/, ""));
  const otherLine = `  ${q.options.length + 1}) Other (type your answer)`;
  const promptText =
    phase === "answer"
      ? q.multiSelect
        ? "choose (comma-separated numbers or text): "
        : "choose (number or text): "
      : phase === "otherAnswer"
        ? "your answer: "
        : "note (enter to skip): ";

  return (
    <Box flexDirection="column">
      <Text>
        {q.header !== undefined ? `${q.header} — ` : ""}{q.question}
      </Text>
      {optionLines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      <Text>{otherLine}</Text>
      <Text>
        {promptText}
        {buffer}
      </Text>
    </Box>
  );
}

export function PendingCards({ pending, onApprove, onAnswer, onPlan }: PendingCardsProps) {
  switch (pending.kind) {
    case "approval":
      return <ApprovalCard pending={pending} onApprove={onApprove} />;
    case "question":
      return <QuestionCard pending={pending} onAnswer={onAnswer} />;
    case "plan":
      return <PlanCard pending={pending} onPlan={onPlan} />;
    default: {
      const _exhaustive: never = pending;
      return _exhaustive;
    }
  }
}
