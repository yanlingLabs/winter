import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stable, per-session scratch directory that is a sandbox writable root. */
export function sessionTmpDir(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`invalid sessionId for temp dir: ${sessionId}`);
  }
  // CC-parity with CLAUDE_CODE_TMPDIR; empty/unset → os.tmpdir(). See spec.
  const base = process.env.NORMA_TMPDIR ? process.env.NORMA_TMPDIR : tmpdir();
  const dir = join(base, `norma-session-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}
