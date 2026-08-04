import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * working-directories T4: the delivery-folder primitive — the user's standing output channel,
 * `<normaHome>/outputs/<sessionId>`. A blessed, agent-writable exception under `~/.norma`, added to
 * the session's own write-fence roots the EXACT SAME WAY the per-project MEMDIR already is
 * (daemon.ts's `sessionDirs` closure, mirroring `memory-dir.ts`'s `memoryDirFor`): once folded into
 * `SessionDirectories.roots(sessionId)`, a write there is in-root for THIS session's own tool calls
 * (no grant card, no `grantDenied` hard error) and never reachable for any OTHER session — the
 * blessing is keyed by sessionId, not by the bare `~/.norma/outputs/` prefix, so
 * `grantDeniedPrefixes: [normaHome]` still refuses every path under `~/.norma` this session's own
 * roots don't happen to include.
 *
 * `sessionId` is validated by the SAME regex `session-tmp.ts`'s `sessionTmpDir` already enforces —
 * a path-component injection through a crafted sessionId (`../..`, an absolute path, a `/`) is the
 * exact attack class both guards exist to close.
 */
export function outdirPath(home: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`invalid sessionId for outputs dir: ${sessionId}`);
  }
  return join(home, "outputs", sessionId);
}

/**
 * mkdir -p + return the path — lazy, idempotent, "create on demand, every call" (the same
 * precedent `sessionTmpDir`/`memoryDirFor`'s callers already set: cheap relative to whatever else
 * the call site is doing, and never invoked for every session up front at daemon boot).
 */
export function ensureOutdir(home: string, sessionId: string): string {
  const dir = outdirPath(home, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
