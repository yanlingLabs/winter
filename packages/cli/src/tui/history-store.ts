/** Disk-backed prompt history (Phase 3c Task 3) — one JSON line per submitted/steered/cleared
 *  entry at `~/.winter/history.jsonl` by default (the composer injects the path; tests always pass
 *  a temp file so nothing here ever touches a real `~/.winter`). Every read/write is best-effort:
 *  a missing file, an unwritable directory, or a corrupt line degrades to "no history" rather than
 *  crashing the TUI — prompt history is a convenience, never load-bearing. */

import { appendFileSync, readFileSync } from "node:fs";

export interface HistoryEntry {
  display: string;
  ts: number;
  sessionId: string;
}

/** Appends one entry as a JSON line. Never throws — a full disk, a missing parent directory, or a
 *  read-only filesystem just silently drops the entry (the in-memory composer state is unaffected
 *  either way, since the buffer itself isn't sourced from disk). */
export function appendHistory(path: string, entry: HistoryEntry): void {
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // best-effort: swallow fs errors (missing dir, permissions, full disk, ...)
  }
}

/** Loads up to `max` (default 100) prompt strings, THIS session's entries first (newest-first
 *  within each group), then every other session's (also newest-first). Tolerates a missing file
 *  (returns `[]`) and tolerates corrupt/malformed lines (skips them) — one bad line never sinks the
 *  rest of the file. */
export function loadHistory(path: string, sessionId: string, max = 100): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // missing file (or unreadable) — no history yet
  }

  const mine: string[] = [];
  const others: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // corrupt line — tolerate and skip
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Partial<HistoryEntry>).display !== "string"
    ) {
      continue; // malformed entry (wrong shape) — tolerate and skip
    }
    const entry = parsed as HistoryEntry;
    (entry.sessionId === sessionId ? mine : others).push(entry.display);
  }

  // File is oldest-first (append-only); reverse each group to newest-first, this session first.
  mine.reverse();
  others.reverse();
  return [...mine, ...others].slice(0, max);
}

export interface HistoryNav {
  /** Called on ↑. `draft` is the live (not-yet-submitted) input text — saved on the FIRST call (the
   *  move from live input into history), ignored on subsequent calls (already navigating). Returns
   *  the recalled entry, or `null` if there's nowhere older to go (including "no entries at all"). */
  up(draft: string): string | null;
  /** Called on ↓. Walks back toward the live input; once past the newest entry, returns the saved
   *  draft (one more step "down"); calling again from there (already at the live draft) returns
   *  `null` — there's nowhere to go. */
  down(): string | null;
}

/** Builds a stateful walker over a FIXED (newest-first) history list, closing over a mutable index
 *  and the saved draft — a plain closure rather than a class since it's the whole of this type's
 *  behavior. `entries` never changes for the lifetime of a returned nav (the composer creates a new
 *  one only when the underlying history list itself changes, which in practice is "never", since
 *  history is loaded once per composer mount). */
export function makeHistoryNav(entries: string[]): HistoryNav {
  let index = -1; // -1 == at the live draft, not navigating history
  let draft = "";
  return {
    up(currentDraft: string): string | null {
      if (entries.length === 0) return null;
      if (index === -1) {
        draft = currentDraft;
        index = 0;
        return entries[0] ?? null;
      }
      if (index + 1 >= entries.length) return null; // already at the oldest entry
      index += 1;
      return entries[index] ?? null;
    },
    down(): string | null {
      if (index === -1) return null; // not navigating — nowhere to go
      if (index === 0) {
        index = -1;
        return draft;
      }
      index -= 1;
      return entries[index] ?? null;
    },
  };
}
