import { DIM, RESET } from "./task-block";

/** Task 3 (ask_user CC parity): formats one numbered option line plus, when the option carries a
 *  `preview` (the "visual scheme on the right" alongside the option), one additional indented
 *  line PER LINE of the — possibly multi-line — preview text, rendered on a "┆" rail 5 columns
 *  in (options are capped at 4 by QuestionOptionSchema, so "  N) " is always exactly 5 columns
 *  wide — the preview rail lines up under the label regardless of which option it belongs to).
 *  Pure and TTY-only: main.ts's question_asked handler calls this ONLY inside its existing
 *  `if (process.stdin.isTTY)` gate and emit()s every returned line verbatim, so the pinned
 *  block's erase/reprint bookkeeping (every emit() call already re-derives it) stays correct
 *  without any separate line-count tracking here — and headless (`-p`) never calls this function
 *  at all, so the preview text can never leak into non-TTY output. Extracted as a pure function
 *  (rather than inlined into the emit() loop) so this formatting is unit-testable without
 *  readline. The option line's own bytes are IDENTICAL to before this feature when no preview is
 *  present — a preview only ever appends extra lines, never changes the option line itself. */
export function formatOptionLines(index: number, option: { label: string; description?: string; preview?: string }): string[] {
  const lines = [`  ${index}) ${option.label}${option.description ? ` ${DIM}${option.description}${RESET}` : ""}\n`];
  if (option.preview) {
    for (const previewLine of option.preview.split("\n")) lines.push(`     ┆ ${previewLine}\n`);
  }
  return lines;
}

/** True when the raw input is exactly the menu number for "Other" (options.length + 1) — the
 *  digit itself is never a real answer, so the caller should re-prompt for actual free text
 *  instead of handing the model the literal number (M1: "Other" chosen BY NUMBER used to pass
 *  that digit straight through parseQuestionAnswer's out-of-range → free-text fallback below,
 *  which reads to the model as if the user's answer literally were e.g. "4"). Any other
 *  out-of-range number (not the Other index) is left to that same fallback, unchanged. */
export function isOtherChoice(input: string, optionsCount: number): boolean {
  return input.trim() === String(optionsCount + 1);
}

/** Map a menu input to an answer: a valid option number → its label; comma-separated numbers
 *  (multiSelect) → joined labels; anything else (incl. out-of-range) → free text, verbatim.
 *
 *  Free-text questions (2026-10-20): a multiSelect answer may mix option numbers with typed words
 *  ("1, 3, my own") — the chosen labels, then the typed text, `", "`-joined: the same one string
 *  every Mac surface sends (`questionAnswers`), which the runtime echoes verbatim. Only when the
 *  numbers are all in range and at least one word is not a number; an out-of-range number keeps the
 *  whole input verbatim, as before. */
export function parseQuestionAnswer(input: string, options: string[], multiSelect: boolean): string {
  const s = input.trim();
  const pick = (tok: string): string | null => {
    const n = Number(tok.trim());
    return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1]! : null;
  };
  if (multiSelect && s.includes(",")) {
    const labels = s.split(",").map(pick);
    if (labels.every((l) => l !== null)) return (labels as string[]).join(", ");
    // The mix: chosen labels first, then the typed words.
    const tokens = s.split(",").map((t) => t.trim()).filter((t) => t !== "");
    const picked = tokens.map(pick).filter((l): l is string => l !== null);
    const typed = tokens.filter((t) => pick(t) === null);
    if (picked.length > 0 && typed.every((t) => !/^\d+$/.test(t))) return [...picked, typed.join(", ")].join(", ");
    return s;
  }
  return pick(s) ?? s;
}

/** A question as the CLI reads it off the wire. `options` is always present from this daemon, but
 *  is read defensively (a question with none is a free-text question). */
export interface CliQuestion {
  header?: string;
  question: string;
  options?: { label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
  placeholder?: string;
}

/** The question's menu — empty for a free-text question. */
export function questionOptions(q: CliQuestion): NonNullable<CliQuestion["options"]> {
  return Array.isArray(q.options) ? q.options : [];
}

/** A question with no options (2026-10-20): no menu, no "Other" entry — the user types the answer. */
export function isFreeTextQuestion(q: CliQuestion): boolean {
  return questionOptions(q).length === 0;
}

/** The menu's last line, "Other": the question's own `placeholder` as its hint when it has one. */
export function otherMenuLine(q: CliQuestion): string {
  const n = questionOptions(q).length + 1;
  return `  ${n}) Other (${q.placeholder ?? "type your answer"})\n`;
}

/** The line under a free-text question: its `placeholder`, dim, or nothing. */
export function freeTextHintLine(q: CliQuestion): string | null {
  return q.placeholder ? `  ${DIM}${q.placeholder}${RESET}\n` : null;
}

/** The answer prompt: a free-text question asks for the answer straight away. */
export function answerPrompt(q: CliQuestion): string {
  if (isFreeTextQuestion(q)) return "your answer: ";
  return q.multiSelect ? "choose (comma-separated numbers or text): " : "choose (number or text): ";
}
