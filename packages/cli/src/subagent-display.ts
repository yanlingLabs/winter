/** Shared pure subagent-display logic (Phase 2e-ii/2e-iii-b) — glyph/label/alive are LOCKSTEP with
 *  `apple/Winter/Sources/ChatContent/SubagentDisplay.swift` (same fixtures both sides, like
 *  task-display.ts). `subagentTokens` is TS-ONLY: token arrows render only in the CLI (2e-iii-b
 *  corrects this — the CLI now shows BOTH time and tokens). `extractToolDetail` is a TS port of
 *  SessionModel.swift's `private static func extractToolDetail` — same field-picking rules per
 *  tool name, mirrored exactly. `subagentElapsedMs` is the CLI-side twin of Swift's
 *  `subagentActiveMs`: banked `activeMs` plus the still-open span while `status === "working"`.
 *  Pure — no ANSI, no I/O. */

import { formatTokens } from "./task-display";

export function subagentGlyph(status: string): string {
  if (status === "working") return "●";
  if (status === "done") return "✓";
  return "◌"; // queued, or any unrecognized status
}

/** description (trimmed) if non-empty, else the prompt's FIRST line capped at 40 UNICODE CODE
 *  POINTS with a trailing "…" (39 kept + ellipsis; exactly 40 fits untruncated). Code points
 *  (not UTF-16 units, not grapheme clusters) count identically in TS (`Array.from`) and Swift
 *  (`unicodeScalars`) and never split a surrogate pair. */
export function subagentLabel(description: string | undefined, prompt: string): string {
  const desc = (description ?? "").trim();
  if (desc.length > 0) return desc;
  const firstLine = prompt.split("\n", 1)[0] ?? "";
  const cps = Array.from(firstLine);
  return cps.length > 40 ? `${cps.slice(0, 39).join("")}…` : firstLine;
}

export function anySubagentAlive(statuses: string[]): boolean {
  return statuses.some((s) => s !== "done");
}

/** "↑ <in> ↓ <out>" — ↓ is banked outputTokens + ceil(liveOutputChars/4) (same live-estimate
 *  convention as the 2e-i status line); ↑ omitted until the child's first turn_completed reports
 *  inputTokens; empty string when nothing is known yet (a queued row shows no token noise). */
export function subagentTokens(inputTokens: number | undefined, outputTokens: number, liveOutputChars: number): string {
  const down = outputTokens + Math.ceil(liveOutputChars / 4);
  if (inputTokens === undefined) return down === 0 ? "" : `↓ ${formatTokens(down)}`;
  return `↑ ${formatTokens(inputTokens)} ↓ ${formatTokens(down)}`;
}

/** TS port of SessionModel.swift's `private static func extractToolDetail(name:argsJson:)`.
 *  Parses `argsJson` defensively (malformed JSON, non-object JSON, or an empty/missing field all
 *  yield `undefined` rather than throwing) and picks a per-tool detail field:
 *  - `bash` → the command's first line, capped at 100 chars
 *  - `task_create` / `task_update` → `subject`
 *  - `read` / `write` / `edit` / `glob` / `grep` / `ls` → `file_path` ?? `path` ?? `pattern`
 *  - anything else → `undefined` */
export function extractToolDetail(name: string, argsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;

  const str = (key: string): string | undefined => {
    const v = obj[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  switch (name) {
    case "bash": {
      const command = str("command");
      if (command === undefined) return undefined;
      const firstLine = command.split("\n", 1)[0] ?? command;
      return firstLine.slice(0, 100);
    }
    case "task_create":
    case "task_update":
      return str("subject");
    case "read":
    case "write":
    case "edit":
    case "glob":
    case "grep":
    case "ls":
      return str("file_path") ?? str("path") ?? str("pattern");
    default:
      return undefined;
  }
}

/** Elapsed active time for a subagent row: banked `activeMs` plus the still-open span while
 *  `status === "working"` (the open span is clamped to ≥ 0 to absorb clock skew between the
 *  daemon-stamped `activeSince` and the caller's `nowMs`). Mirrors Swift's `subagentActiveMs`. */
export function subagentElapsedMs(s: { activeMs: number; activeSince?: number; status: string }, nowMs: number): number {
  const open = s.status === "working" && s.activeSince !== undefined ? Math.max(0, nowMs - s.activeSince) : 0;
  return s.activeMs + open;
}
