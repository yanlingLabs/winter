import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/**
 * Working directories (2026-08-03 design, §1): one code/cowork session's ordered set of writable
 * roots — the model that REPLACES today's single optional `cwd`. `dirs[0]` is the PRIMARY by
 * POSITION (not a flag): today's `cwd` — the shell's starting directory, the recents anchor,
 * SP4's "move to CLI opens here". Entries `1..n` are ADDED directories. Each entry locks
 * independently the moment Norma successfully writes inside it (spec §1) — reading never locks,
 * and a locked entry can never be changed or removed for the session's lifetime (enforced at the
 * T2 domain setter, not here — this file is the data shape and path canonicalization only).
 */
export interface SessionDir {
  path: string;
  locked: boolean;
}

export type SessionDirs = SessionDir[];

/** Tilde-expansion — mirrors `memory-dir.ts`'s own private `expandTilde` (same two forms: bare
 *  `~` and a `~/`-prefixed path). Reimplemented locally rather than imported: this foundation
 *  module (the types + canonicalization every later task builds the setter/fence on) has no
 *  reason to depend on `agent/memory-dir.ts`, which isn't exported there either. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Canonicalizes a working-directory path so two different spellings of the same directory
 * compare equal — the T2 setter's dedup/lock/denylist checks all depend on this being stable and
 * deterministic.
 *
 * Two steps: (1) tilde-expansion, (2) `realpathSync` to resolve symlinks. `realpathSync` alone
 * throws on a path that doesn't exist yet, but a working directory can legitimately be
 * approved/added before its first write ever creates it (a dirGrant approval is exactly this —
 * spec §1: "the approved write is its first write", i.e. the directory need not exist at approval
 * time) — so a not-yet-existing LEAF must still canonicalize STABLY rather than throw. This walks
 * up to the deepest EXISTING ancestor, realpaths only that, and rejoins the non-existent remainder
 * verbatim.
 *
 * Mirrors the SHAPE (not the code) of the engine fence's own `canonAncestor`/`canonicalizeForWrite`
 * (agent/paths.ts): same ancestor-walk idea, reimplemented locally so this module carries no
 * dependency on engine/fence internals. Deliberately DIFFERENT in one respect: this throws on a
 * relative path instead of resolving it against the daemon's own cwd (`canonicalizeForWrite`'s
 * behavior) — every caller here (the T2 setter, the migration) already has an absolute path in
 * hand, and silently resolving against an ambiguous "current directory" would make the same input
 * canonicalize differently depending on the daemon process's own cwd at call time, which is
 * exactly the instability this function exists to prevent.
 */
export function canonicalizeDirPath(p: string): string {
  const expanded = expandTilde(p);
  if (!isAbsolute(expanded)) {
    throw new Error(`canonicalizeDirPath: path must be absolute, got a relative path: ${p}`);
  }
  let probe = expanded;
  const missing: string[] = [];
  while (true) {
    try {
      const real = realpathSync(probe);
      return missing.length > 0 ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return expanded; // defensive only: `/` always exists on a real filesystem
      missing.push(basename(probe));
      probe = parent;
    }
  }
}
