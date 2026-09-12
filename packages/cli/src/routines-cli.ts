// Phase 5 routines T4 — pure formatting helpers for `winter routines` (main.ts) and `/routines`
// (tui/commands.ts). Extracted here (task-display.ts's formatElapsed/formatTokens precedent:
// shared pure formatting logic, no I/O, imported by both call sites) because main.ts's argv
// switch can't be driven directly by a unit test the way commands.ts's registry can — main.test.ts
// only covers routeCliInvocation/formatResumeHint for exactly that reason (see that file's own
// header comment); everything else in main.ts's subcommand dispatch is verified by self-review +
// the gate suite instead. `RoutineLike` mirrors just the fields these formatters read (a
// structural subset of `Routine` in client.ts), so tests can build minimal fakes.
export interface RoutineLike {
  id: string;
  spec: string;
  enabled: boolean;
  nextRunAt: number;
  prompt: string;
}

const PROMPT_HEAD_LEN = 60;

/** First line of `prompt`, truncated to 60 chars with a trailing "…" only when actually cut short
 *  — mirrors `agent/tools/schedule.ts`'s own `promptHead` (core) so `winter routines`/`/routines`
 *  read the same shape as the `schedule` tool's `op:"list"` output the model itself sees. */
export function routinePromptHead(prompt: string): string {
  const line = (prompt.split("\n", 1)[0] ?? "").trim();
  return line.length > PROMPT_HEAD_LEN ? `${line.slice(0, PROMPT_HEAD_LEN - 1)}…` : line;
}

/** Everything after the id — enabled marker, spec, next-run ISO timestamp, prompt head. This is
 *  the DIM-wrapped remainder of `winter routines`' colored line (main.ts colors the id AQUA, this
 *  DIM — matching `sessions`/`bg list`'s own two-tone convention) and also the tail of
 *  `formatRoutineLine` below. */
export function formatRoutineDetail(r: RoutineLike): string {
  const marker = r.enabled ? "enabled" : "disabled";
  const nextIso = new Date(r.nextRunAt).toISOString();
  return `${marker} · ${r.spec} · next ${nextIso} — ${routinePromptHead(r.prompt)}`;
}

/** One full plain (uncolored) summary line: id + formatRoutineDetail. Printed as-is by `/routines`
 *  (no color — matches runSessions/runBg's own no-color convention for in-chat notes); `winter
 *  routines`' CLI list case wraps the id/detail pieces in AQUA/DIM around this same content. */
export function formatRoutineLine(r: RoutineLike): string {
  return `${r.id}  ${formatRoutineDetail(r)}`;
}
