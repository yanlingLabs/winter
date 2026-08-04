import type { SessionDirs } from "./dirs";
import { canonicalizeDirPath } from "./dirs";
import type { ActivityRow } from "./activity";
import { participatesInActivity } from "./activity";

/** The three mutations a working-directory door can ask for (design doc §1). No "clear"/"remove
 *  all" op: emptying the set back to `[]` is not a supported transition (the empty-set rule below
 *  only fires FROM an empty set, never TO one) — a session that has ever had a primary keeps one,
 *  same spirit as `dirs[0]` being a position rather than a flag. */
export type DirsOp = "setPrimary" | "add" | "remove";

/** The exact store slice this operation reads and writes — a narrow structural interface (the
 *  `SetActivityStore` precedent) so a test can drive it without a real database, and so the set of
 *  store powers this grants is visible at a glance. */
export interface SetDirsStore {
  meta(sessionId: string): ActivityRow;
  dirs(sessionId: string): SessionDirs;
  setDirsRaw(sessionId: string, dirs: SessionDirs): void;
}

export interface SetDirsDeps {
  store: SetDirsStore;
  /** THE dirGrant predicate — the SAME one the engine's approval flow consults, injected (the
   *  server wires the real one; tests fake it). Answers "is this directory forever off-limits as a
   *  working directory", independent of any per-session state — a fact about the PATH, not the
   *  session, which is why it takes a bare string rather than a session id. */
  grantDenied(dir: string): boolean;
  /** Injectable clock (the `SetActivityDeps.now`/`ReaperDeps.now` precedent). Unused by this
   *  setter today — dirs carry no timestamp — kept for signature parity with the rest of the
   *  domain-setter family so a future need (e.g. a locked-at stamp) is an additive read, not a
   *  breaking signature change at every call site. */
  now?: () => number;
}

/** `session.setDirs` and dispatch's dirGrant-adjacent doors both answer with this, verbatim, for
 *  the same reason `ACTIVITY_MODE_REFUSAL` is one constant: chat and dispatch sessions have no
 *  writable root at all (design doc §1), so every op refuses identically regardless of which door
 *  reached this state machine. Reuses `participatesInActivity` (the same code/cowork allowlist
 *  activity state gates on) rather than re-deciding the mode list a second time. */
export const DIRS_MODE_REFUSAL = "working directories apply to code and cowork sessions only";

/** A locked entry can never be changed or removed for the session's lifetime (design doc §1) — this
 *  is the one refusal that names that rule. Fires for `setPrimary` over a locked `dirs[0]` and for
 *  `remove` of a locked non-primary entry; the primary's OWN removal is refused by a different,
 *  position-based rule below (`DIR_REMOVE_PRIMARY_REFUSAL`) even when it isn't locked. */
export const DIR_LOCKED_REFUSAL = "that directory is locked for this session";

/** The dirGrant denylist's refusal — a fact about the PATH (never approvable, session-independent),
 *  distinct from `DIR_LOCKED_REFUSAL` (a fact about THIS session's history with a path it WAS
 *  allowed to use). Fires only for ops that introduce a path the session doesn't already have
 *  (`setPrimary`, and `add` past its duplicate short-circuit) — `remove` never adds a new path, so
 *  it never consults the denylist. */
export const DIR_DENIED_REFUSAL = "that directory can never be a working directory";

/** `remove`'s own refusal for index 0: the primary is a POSITION (`dirs[0]`), not a flag, so there
 *  is no such thing as "the set has secondaries but no primary" — removing it would either leave
 *  that hole or silently promote `dirs[1]` into the role, and neither is what a caller asking to
 *  REMOVE a directory meant. `setPrimary` is the one door that reassigns the primary (including
 *  re-establishing it on an empty set), so this names it as the way out. Fires regardless of lock
 *  state — even an unlocked primary can't be dropped this way — which is why it is a distinct
 *  constant from `DIR_LOCKED_REFUSAL` rather than a special case of it. */
export const DIR_REMOVE_PRIMARY_REFUSAL =
  "the primary directory can't be removed — use setPrimary to replace it instead";

/** `kind` exists so each caller (the RPC, dirGrant's approval flow, dispatch) can map a refusal into
 *  its own vocabulary without re-deciding which refusals exist — the `SetActivityResult` precedent. */
export type SetDirsResult =
  | { ok: true; dirs: SessionDirs }
  | { ok: false; kind: "not_found" | "invalid"; error: string };

/** Finds the index of the entry whose CANONICALIZED path equals `canonical` — canonicalized-to-
 *  canonicalized compare, never a raw string compare against the incoming path. The migration
 *  stores `cwd` (and every write here stores its own canonicalized form) VERBATIM, so two spellings
 *  of the same real directory (a symlink, a `~`-relative form) only compare equal once both sides
 *  are canonicalized — this is where that happens, on every read, without ever rewriting the stored
 *  entries (the alias-parity design leans on stored-verbatim; see `dirs()`'s own doc comment). */
function findByCanonical(dirs: SessionDirs, canonical: string): number {
  return dirs.findIndex((d) => canonicalizeDirPath(d.path) === canonical);
}

/**
 * THE one domain setter over a session's working-directory set (working-directories design doc §1,
 * T2). Every mutation door — the RPC (`session.setDirs`), a dirGrant approval, the TUI, the app's
 * folder picker — calls THIS rather than reimplementing the refusal matrix or touching
 * `store.setDirsRaw` directly, exactly as `setSessionActivity` is the one door onto the activity
 * flags: two doors onto one state machine is fine, two implementations of one state machine is how
 * "a locked directory can never be removed" becomes true on one door and false on another.
 *
 * `path` is always the CALLER's raw spelling — this function canonicalizes it itself, once, and
 * every comparison below (duplicate, locked, primary) goes through that canonical form.
 */
export function setSessionDirs(
  deps: SetDirsDeps,
  sessionId: string,
  op: DirsOp,
  path: string,
): SetDirsResult {
  let meta: ActivityRow;
  // NOT_FOUND is resolved FIRST, explicitly, rather than left to a store setter to report at the
  // end — the `setSessionActivity` precedent: every refusal below reads a fact about the session
  // (its mode, its current dirs), so an unknown id must come back as unknown rather than as a
  // refusal that implies it exists.
  try { meta = deps.store.meta(sessionId); }
  catch (e) { return { ok: false, kind: "not_found", error: (e as Error).message }; }
  // The participation ALLOWLIST (code + cowork + absent-means-code) — chat and dispatch sessions
  // have no writable root at all, so there is no set to mutate on them.
  if (!participatesInActivity(meta.mode)) {
    return { ok: false, kind: "invalid", error: DIRS_MODE_REFUSAL };
  }
  const canonical = canonicalizeDirPath(path);
  const dirs = deps.store.dirs(sessionId);

  switch (op) {
    case "setPrimary": {
      // Locked check first: a locked `dirs[0]` refuses regardless of what the caller wants to
      // replace it with, before the denylist is even consulted — a caller can't smuggle information
      // about the denylist's contents out of a refusal that was always going to fire on lock alone.
      if (dirs.length > 0 && dirs[0]!.locked) {
        return { ok: false, kind: "invalid", error: DIR_LOCKED_REFUSAL };
      }
      if (deps.grantDenied(canonical)) {
        return { ok: false, kind: "invalid", error: DIR_DENIED_REFUSAL };
      }
      // Replaces index 0, keeps 1..n untouched. On an empty set `dirs.slice(1)` is `[]`, so this one
      // expression establishes the primary AND replaces it — the empty-set case needs no branch of
      // its own.
      const next: SessionDirs = [{ path: canonical, locked: false }, ...dirs.slice(1)];
      deps.store.setDirsRaw(sessionId, next);
      return { ok: true, dirs: next };
    }
    case "add": {
      const existingIdx = findByCanonical(dirs, canonical);
      // Duplicate add is an idempotent success — the directory is already a working directory for
      // this session, exactly the state the caller asked for. No write, no denylist re-check (it was
      // already checked when this entry was first added), and deliberately no lock-state change even
      // if the matching entry happens to be locked: the caller asked to ADD a directory, not to touch
      // its lock. This is what makes "make sure X is a working directory" idempotent from any
      // caller's perspective.
      if (existingIdx !== -1) {
        return { ok: true, dirs };
      }
      if (deps.grantDenied(canonical)) {
        return { ok: false, kind: "invalid", error: DIR_DENIED_REFUSAL };
      }
      // The empty-set rule (pinned): a workdir-less session has no primary yet, so its first
      // directory — through EITHER door — becomes the primary. Appending to `[]` already produces a
      // single-element array, so `add` needs no special case to establish it: this is the same
      // expression whether `dirs` was empty or not.
      const next: SessionDirs = [...dirs, { path: canonical, locked: false }];
      deps.store.setDirsRaw(sessionId, next);
      return { ok: true, dirs: next };
    }
    case "remove": {
      const idx = findByCanonical(dirs, canonical);
      // Removing a directory that isn't in the set is already the requested end state — idempotent
      // success, the mirror image of the `add`-duplicate rule above, not an error.
      if (idx === -1) {
        return { ok: true, dirs };
      }
      if (idx === 0) {
        return { ok: false, kind: "invalid", error: DIR_REMOVE_PRIMARY_REFUSAL };
      }
      if (dirs[idx]!.locked) {
        return { ok: false, kind: "invalid", error: DIR_LOCKED_REFUSAL };
      }
      const next: SessionDirs = [...dirs.slice(0, idx), ...dirs.slice(idx + 1)];
      deps.store.setDirsRaw(sessionId, next);
      return { ok: true, dirs: next };
    }
    // This union just grew once, and the failure mode of the next growth is silent: an unhandled op
    // falls through to nothing and returns nothing, which is a compile error waiting to happen
    // rather than one happening now. The `never` assignment (the house pattern —
    // `setSessionActivity`, tui/transcript.tsx, flatten-blocks.ts) makes that a compile error instead.
    default: {
      const _exhaustive: never = op;
      throw new Error(`unhandled dirs op: ${String(_exhaustive)}`);
    }
  }
}

/**
 * T5's write-hook lock marker (design doc §1: "each entry locks independently the moment Norma
 * successfully writes inside it"). Idempotent both ways — an absent path or an already-locked entry
 * is a silent no-op, never a throw — because the caller is a write hook firing on every successful
 * write, not a user action: a write landing in a directory Norma has already locked (the common
 * case — most writes land in an already-active root) must cost nothing and never surface an error
 * the write itself didn't have.
 *
 * Canonicalizes before matching (the same `findByCanonical` every comparison in `setSessionDirs`
 * goes through), so a write reached through a symlinked or `~`-relative spelling of an existing
 * entry still locks that entry rather than silently no-oping.
 *
 * Deliberately bypasses `setSessionDirs`'s refusal matrix entirely — no participation check, no
 * NOT_FOUND mapping, no denylist consultation: the write already happened, so by the time this
 * fires there is a fact to record, not a mutation to approve or refuse. Callers only ever invoke
 * this for a session whose write just succeeded, i.e. one already known to exist and already known
 * to participate.
 */
export function lockDir(deps: SetDirsDeps, sessionId: string, path: string): void {
  const canonical = canonicalizeDirPath(path);
  const dirs = deps.store.dirs(sessionId);
  const idx = findByCanonical(dirs, canonical);
  if (idx === -1 || dirs[idx]!.locked) return;
  const next: SessionDirs = dirs.map((d, i) => (i === idx ? { path: d.path, locked: true } : d));
  deps.store.setDirsRaw(sessionId, next);
}
