import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The per-session scratch directory's path AS SPELLED (not created, not resolved) — `sessionTmpDir`
 *  below creates and resolves it. Exported for `stage-image.ts`, which must `lstat` the directory
 *  itself (a sandboxed agent can write inside it) before the daemon writes anything under it. */
export function sessionTmpDirPath(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`invalid sessionId for temp dir: ${sessionId}`);
  }
  // CC-parity with CLAUDE_CODE_TMPDIR; empty/unset → os.tmpdir(). See spec. fix-wave D: a
  // whitespace-only value (" ") is truthy and was previously used verbatim — treat blank
  // (trim().length === 0) as unset too, using the RAW (untrimmed) value once it has real content.
  const envTmp = process.env.WINTER_TMPDIR;
  const base = envTmp && envTmp.trim().length > 0 ? envTmp : tmpdir();
  return join(base, `winter-session-${sessionId}`);
}

/** A stable, per-session scratch directory that is a sandbox writable root. */
export function sessionTmpDir(sessionId: string): string {
  const dir = sessionTmpDirPath(sessionId);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}
