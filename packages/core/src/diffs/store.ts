// diff-tabs task 2: the on-disk store for patches `myers.ts` (task 1) computes. One file per
// (sessionId, diffId): line 1 is `JSON.stringify(header)`, everything after the first newline is
// the unified patch verbatim (or a capped prefix of it — see truncatePatch below). Sibling of
// sessions/outdir.ts's outputs box: same shape (a session-scoped directory tree under `home`,
// created lazily on first write, deleted in bulk on session teardown), same path-safety discipline.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const DIFF_PATCH_MAX_BYTES = 1024 * 1024;

/** Wire shape for a minted diff id: 32 lowercase hex chars (see mintDiffId), but the regex is
 *  deliberately looser than that — it is also the path-safety gate `readStoredDiff`/`writeDiff`
 *  run an untrusted diffId through before it ever touches `join()`. */
export const DIFF_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Mirrors sessions/outdir.ts's `outdirPath` / agent/session-tmp.ts's `sessionTmpDir`: the shared
 *  discipline for a sessionId used as a raw filesystem path component. NOT the sessions store's
 *  own `SCOPE_RE`/`SYNCED_SESSION_ID_RE` (packages/core/src/sessions/store.ts:12,28) — those
 *  validate a session *scope* and a phone-synced session's *id* respectively, two narrower and
 *  unrelated shapes (lowercase-only; UUID-only) that a daemon-minted `s_<hex>` id doesn't even
 *  satisfy itself. This is the same permissive-but-path-safe char class already duplicated at the
 *  two call sites above for exactly this "sessionId as directory name" purpose — mirrored a third
 *  time here rather than imported, matching that existing precedent (neither prior site exports
 *  its copy either).
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface DiffHeader {
  path: string;
  added: number;
  removed: number;
  truncated: boolean;
}

/** crypto-random diffId — 32 lowercase hex chars, well inside DIFF_ID_RE. */
export function mintDiffId(): string {
  return randomUUID().replace(/-/g, "");
}

/** Pure path builder: `<home>/diffs/<sessionId>`. Never creates the directory (callers that need
 *  it to exist call this then `mkdirSync`, same split as outdir.ts's `outdirPath`/`ensureOutdir`) —
 *  load-bearing for `removeSessionDiffs`'s post-delete `existsSync` check, which must observe an
 *  absent directory rather than one this function silently recreated. */
export function diffDirPath(home: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid sessionId for diffs dir: ${sessionId}`);
  }
  return join(home, "diffs", sessionId);
}

function diffFilePath(home: string, sessionId: string, diffId: string): string {
  return join(diffDirPath(home, sessionId), `${diffId}.diff`);
}

/** tmp-then-rename so a reader never observes a half-written file (mirrors sessions/store.ts's and
 *  agent/permission-rules.ts's own repair-write idiom). A fixed `.tmp` suffix is fine: every write
 *  to a given diff path is one-shot (a diffId is minted fresh per capture, never overwritten). */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const TRUNCATION_MARKER = "[patch truncated]\n";

/** Truncate at a hunk boundary (`@@ ` line starts — the exact shape `myers.ts`'s `computeLineDiff`
 *  emits) so a truncated patch is still a valid, parseable prefix: whole hunks are kept up to the
 *  byte cap, and the first hunk that would overflow is dropped entirely — UNLESS it is the very
 *  first hunk, in which case dropping it would leave nothing, so that one hunk alone is hard-cut at
 *  the last full line under the cap instead. Either way the result ends with the marker line and
 *  never exceeds DIFF_PATCH_MAX_BYTES. */
function truncatePatch(patch: string): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, "utf8") <= DIFF_PATCH_MAX_BYTES) {
    return { patch, truncated: false };
  }
  const budget = Math.max(0, DIFF_PATCH_MAX_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  const hunks = patch.split(/^(?=@@ )/m);
  let acc = "";
  let accBytes = 0;
  for (const hunk of hunks) {
    const hunkBytes = Buffer.byteLength(hunk, "utf8");
    if (accBytes + hunkBytes <= budget) {
      acc += hunk;
      accBytes += hunkBytes;
      continue;
    }
    if (acc === "") acc = cutAtLastFullLine(hunk, budget); // first hunk alone overflows: hard-cut it
    break; // hunk boundary reached (or just hard-cut) — never straddle into the next hunk
  }
  return { patch: acc + TRUNCATION_MARKER, truncated: true };
}

/** Cut `text` at the last `\n` boundary whose cumulative byte length is still <= maxBytes, so the
 *  result never ends mid-line. */
function cutAtLastFullLine(text: string, maxBytes: number): string {
  let acc = "";
  let accBytes = 0;
  let idx = 0;
  while (idx < text.length) {
    const nl = text.indexOf("\n", idx);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    const line = text.slice(idx, lineEnd);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (accBytes + lineBytes > maxBytes) break;
    acc += line;
    accBytes += lineBytes;
    idx = lineEnd;
  }
  return acc;
}

/** Validates both ids against their path-safety shape BEFORE either touches `join()` (never build
 *  a path from an unvalidated id, then find out it was `../..`), lazily creates the session's diff
 *  dir, computes truncation, and writes header+patch as ONE atomic file — the header line is built
 *  AFTER truncation is known, so `truncated` in the stored header always matches the stored patch
 *  (no write-then-rewrite: a reader never observes the header claiming untruncated while the body
 *  is already cut, or vice versa). */
export async function writeDiff(
  home: string,
  sessionId: string,
  diffId: string,
  header: Omit<DiffHeader, "truncated">,
  patch: string,
): Promise<{ truncated: boolean }> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid sessionId for diffs dir: ${sessionId}`);
  }
  if (!DIFF_ID_RE.test(diffId)) {
    throw new Error(`invalid diffId: ${diffId}`);
  }
  const dir = diffDirPath(home, sessionId);
  mkdirSync(dir, { recursive: true });

  const { patch: storedPatch, truncated } = truncatePatch(patch);
  const fullHeader: DiffHeader = { path: header.path, added: header.added, removed: header.removed, truncated };
  const content = `${JSON.stringify(fullHeader)}\n${storedPatch}`;
  writeFileAtomic(join(dir, `${diffId}.diff`), content);

  return { truncated };
}

/** Read side fails soft: an id that doesn't even pass its shape check, or a path that passes but
 *  doesn't exist on disk, both read as `null` rather than throwing — a diff tab opening for a
 *  capture that was since cleaned up (or a stale/tampered id) is a normal "nothing to show", not an
 *  error. */
export async function readStoredDiff(
  home: string,
  sessionId: string,
  diffId: string,
): Promise<{ header: DiffHeader; patch: string } | null> {
  if (!SESSION_ID_RE.test(sessionId) || !DIFF_ID_RE.test(diffId)) return null;
  const filePath = diffFilePath(home, sessionId, diffId);
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf8");
  const nl = content.indexOf("\n");
  const headerLine = nl === -1 ? content : content.slice(0, nl);
  const patch = nl === -1 ? "" : content.slice(nl + 1);
  return { header: JSON.parse(headerLine) as DiffHeader, patch };
}

/** Bulk teardown for a whole session's captured diffs (the session-delete path). `force: true`
 *  makes a second call, or a call for a session that never wrote a diff, a no-op rather than an
 *  ENOENT throw. */
export async function removeSessionDiffs(home: string, sessionId: string): Promise<void> {
  const dir = diffDirPath(home, sessionId); // throws on an invalid sessionId shape, same as writeDiff
  rmSync(dir, { recursive: true, force: true });
}
