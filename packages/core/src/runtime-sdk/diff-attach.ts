// Phase 8c (controller-owned shared seam; pre-flight scan L2 × L3): the `fileDiff` hand-off between the
// hooks lane's PostToolUse producer (`attachFileDiff`) and the projector's `tool_result` emission
// (`takeFileDiff`). In-memory, per session, keyed by the tool-use id; a take is destructive so a replayed
// `tool_result` never re-attaches a diff. `clearSession` runs when a session ends or is evicted.
import type { FileDiffSummary } from "@norma/protocol";

const pending = new Map<string, Map<string, FileDiffSummary>>();

export function attachFileDiff(sessionId: string, toolUseId: string, summary: FileDiffSummary): void {
  let bySession = pending.get(sessionId);
  if (bySession === undefined) { bySession = new Map(); pending.set(sessionId, bySession); }
  bySession.set(toolUseId, summary);
}

export function takeFileDiff(sessionId: string, toolUseId: string): FileDiffSummary | undefined {
  const bySession = pending.get(sessionId);
  if (bySession === undefined) return undefined;
  const summary = bySession.get(toolUseId);
  if (summary !== undefined) bySession.delete(toolUseId);
  if (bySession.size === 0) pending.delete(sessionId);
  return summary;
}

export function clearSession(sessionId: string): void { pending.delete(sessionId); }

/** Test-only: the number of sessions with pending diffs. */
export function pendingDiffSessions(): number { return pending.size; }
