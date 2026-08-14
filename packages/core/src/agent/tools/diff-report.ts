import { computeLineDiff } from "../../diffs/myers";
import { mintDiffId } from "../../diffs/store";
import type { ToolContext, ToolRunResult } from "./registry";

/**
 * diff-tabs Task 6: the shared "compute → mint → persist → report" tail for edit/write/
 * notebook_edit (fs-write.ts, notebook.ts) — one implementation so the three tools can't drift on
 * the fail-soft contract (design spec `docs/superpowers/specs/2026-08-14-diff-tabs-design.md`
 * §2). Deliberately NOT a registered tool (page-core.ts precedent: a shared building block that
 * lives in this directory without being a `register*` entry point) — called AFTER a tool's
 * mutation has already landed on disk.
 *
 * `plain` is the tool's own today-shaped confirmation string (no counts suffix yet). `path` is
 * the SAME string already embedded in `plain` — the raw arg the tool received, exactly as its
 * confirmation echoes it (NOT `resolveWithinAny`'s resolved/realpath'd target) — and becomes
 * `fileDiff.path` verbatim; see the task-6 report for why "as the tool saw it" reads as
 * as-received rather than as-resolved.
 *
 * Returns `plain` unmodified — no `fileDiff`, no patch file ever written — whenever:
 *  - `diffSink` is absent (no engine wiring: every pre-Task-6 test, and any bare
 *    `registry.execute()` caller — see ToolContext.diffSink's own doc comment),
 *  - `path` exceeds the wire schema's cap (`FileDiffSummary.path`, protocol/events.ts:
 *    `.max(1024)`, counted the same way — UTF-16 code units, i.e. `.length`) — skipped entirely
 *    rather than truncated, per the brief's explicit rule for that case,
 *  - the computed diff is empty (`added === 0 && removed === 0` — a true no-op, e.g. `write`
 *    given byte-identical content, or `edit` with old_string === new_string), or
 *  - ANYTHING throws (`computeLineDiff`, `mintDiffId`, or the sink's underlying `writeDiff` call)
 *    — caught, logged, swallowed.
 *
 * **The mutation has ALWAYS already happened by the time this runs — diff bookkeeping must never
 * turn a successful edit into a tool error.** None of the branches above ever throw outward.
 */
export async function withFileDiff(
  plain: string,
  path: string,
  before: string,
  after: string,
  diffSink: ToolContext["diffSink"],
): Promise<ToolRunResult> {
  if (!diffSink || path.length > 1024) return plain;
  try {
    const { patch, added, removed } = computeLineDiff(before, after);
    if (added === 0 && removed === 0) return plain; // no-op — no chip, no patch file
    const diffId = mintDiffId();
    await diffSink(diffId, { path, added, removed }, patch);
    return { output: `${plain} (-${removed} +${added})`, fileDiff: { path, added, removed, diffId } };
  } catch (err) {
    console.error(`diff-tabs: failed to compute/persist a diff for ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return plain;
  }
}
