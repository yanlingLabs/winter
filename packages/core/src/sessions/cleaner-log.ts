import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** session-activity-hygiene T6 (spec §2): one audit line per session the empty-session reaper (and,
 *  T7, the session cleaner) deletes — the ONLY record that a session ever existed once it's gone.
 *  `title` is the store's OWN `getTitle` result at the moment of deletion (may be absent — most
 *  reaped sessions never got far enough to be titled); omitted from the line entirely rather than
 *  written as `null` (a plain `JSON.stringify` on an `undefined` property already does this, so
 *  there's nothing extra to do here — pinned by reaper.test.ts so a future refactor can't
 *  regress it). */
export interface CleanerLogEntry {
  sessionId: string;
  title?: string;
  reason: string;
  date: string;
}

/** Appends one NDJSON line to `<home>/cleaner.jsonl`, creating the file (and `home`, defensively —
 *  the same `mkdirSync(..., {recursive:true})` precedent `SessionStore`'s own constructor uses) if
 *  missing. `home` is a parameter — never a global/normaHome import — so every caller, test
 *  included, stays temp-home-safe.
 *
 *  Deliberately NOT best-effort itself: this throws like any other fs call (ENOSPC, permissions, a
 *  read-only home, …). The CALLER decides whether a failed write should stop anything — the
 *  reaper's own rule (reaper.ts) is that it never does: the delete this logs already happened, and a
 *  missing audit line is a logged warning, not a reason to undo or retry the delete. Keeping the
 *  throw here (rather than swallowing it internally) is what lets that caller-side contract be
 *  tested on its own terms, and gives T7's cleaner the identical seam to wrap the same way. */
export function appendCleanerLog(home: string, entry: CleanerLogEntry): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, "cleaner.jsonl"), JSON.stringify(entry) + "\n");
}
