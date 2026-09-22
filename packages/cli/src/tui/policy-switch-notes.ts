import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";

/** Lane B (2026-09-23): what a `session.setPolicy` result says beyond "ok", as the lines a policy
 *  switch prints — one for `replaced`, one for `warning`, nothing for an ordinary switch. Crossing the
 *  BYPASS boundary on a live session replaces its runtime child (resumably): at once when it was idle
 *  (`"now"`), at the running turn's end otherwise (`"at-idle"`); `warning` is set when a running turn
 *  could not leave bypass and keeps bypassing approvals until it ends. Takes the result as `unknown`
 *  (the TUI's `AppClient.setPolicy` is loosely typed so tests can pass recording fakes) and reads
 *  only well-formed fields. Its own zero-dep module (a type import only) so the Ink app AND
 *  `main.ts`'s raw cycler share one wording without `main.ts` loading the Ink graph. */
export function policySwitchNotes(next: ApprovalPolicy, result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];
  const { replaced, warning } = result as { replaced?: unknown; warning?: unknown };
  const lines: string[] = [];
  if (replaced === "now") lines.push(`${next} mode is in force — the session's runtime restarted to apply it`);
  else if (replaced === "at-idle") lines.push(`${next} mode applies when the running turn ends — the session's runtime restarts then`);
  if (typeof warning === "string" && warning.length > 0) lines.push(`warning: ${warning}`);
  return lines;
}
