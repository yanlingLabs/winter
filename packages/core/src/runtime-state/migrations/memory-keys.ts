// WS-16 §17's Migration A, phase 5: move each project's memory from TODAY's key to the compatibility
// key, through a manifest that can undo it.
//
// TWO KEY ALGORITHMS, ONE DIRECTORY, AND BOTH OF THEM KEYED ON THE REPO ROOT. Today a project's
// memory lives at `<home>/projects/<sanitizeProjectKey(repoRootFor(cwd))>/memory`
// (`agent/memory-dir.ts`); the compatibility layout puts it at
// `compatibilityKeys(cwd).memoryProjectKey`, which is the SDK's own key for the same repo root
// (`transcriptProjectKey(gitCommonRoot(cwd))`). Only the SANITIZER differs — today's strips the
// leading separator and replaces separators, the SDK's replaces every non-alphanumeric character.
//
// THAT THE DESTINATION IS ROOT-BASED IS THE WHOLE SAFETY ARGUMENT (controller ruling, pre-review).
// Both sides resolve the same root for a given cwd — worktrees included, since both go through
// `--git-common-dir` — so the mapping is ONE-TO-ONE PER REPO ROOT by construction: one old key can
// only ever produce one new key, and two old keys can only collide on one new key if something has
// already corrupted a record. The three collision guards below therefore must NEVER fire on
// consistent inputs. They are kept anyway, because "nobody's memory is merged or overwritten" should
// be true by refusal rather than by an argument about derivations.
//
// THAT ARGUMENT HAS A PRECONDITION, AND IT IS ENFORCED HERE: THE CWD MUST STILL EXIST. The SDK's
// `gitCommonRoot` returns null whenever `git -C <cwd>` fails — a missing directory included — and
// `compatibilityKeys` then falls back to the CWD's OWN key, which is not root-derived. The old key
// does not degrade the same way: it was computed at backfill time, when the directory was still
// there. So a record whose cwd has since been deleted would offer a root-derived old key and a
// per-cwd destination, and two sessions in one repo with one dead cwd would present ONE old key with
// TWO destinations — a fan-out arising from ordinary inputs (legacy sessions are exactly the
// population whose cwds are most likely gone), refusing the whole migration. With no sibling it is
// worse: the repo's entire memory tree is renamed under a per-cwd key, and a later re-clone finds an
// empty memory directory. Such a record is therefore `unresolved`: skipped, reported, never moved.
//
// The old key is read from the record (Task 9 stored today's key there); the new key is derived from
// the session's CWD, which is why this phase needs the product store — a record carries project
// keys, never the cwd they came from.
//
// WHY A MANIFEST AND NOT JUST A RENAME. A rename is trivially reversible only while something
// remembers what it was. `memory_key_manifest` is that something: one row per moved ENTRY, `planned`
// → `moved` → `rolled-back`, so an operator who applies this and dislikes the result can put every
// directory back byte-for-byte without knowing either algorithm. Project memory is a user's own
// writing — the migration may relocate it, and may never merge, overwrite or drop any of it.
//
// WHICH IS WHY EVERY AMBIGUITY IS A REFUSAL, not a resolution. Three shapes make a mapping
// ambiguous, and all three refuse:
//
//   many-old-keys     two projects' memory would land in one directory — a silent merge.
//   old-key-fans-out  one directory has two destinations — picking either loses the other's memory.
//   target-exists     an ENTRY of the same name already sits at the destination.
//
// A refusal costs a re-run. Guessing costs somebody's notes.
//
// ── P8b-17: THE FOUR PRECONDITIONS THAT LET THIS RUN AT ALL ───────────────────────────────────────
// 8a shipped this file behind a flag that REFUSED (wiring.ts). 8b turns it on, and only because all
// four of its preconditions now hold:
//
//  1. THE MANIFEST IS DERIVED AGAINST THE 64-CHAR KEY. SDK 0.0.3 capped `transcriptProjectKey` (and
//     therefore `compatibilityKeys(...).memoryProjectKey`) at `TRANSCRIPT_PROJECT_KEY_MAX_LENGTH`
//     = 64 — prefix + `-` + a base-36 hash OF THE ORIGINAL PATH. Any plan built under 0.0.2 named a
//     different destination for every root whose sanitized path overflowed, so a `planned` row is
//     never trusted as a destination: `plan` re-derives and REWRITES it (the `ON CONFLICT ... DO
//     UPDATE` below), and a row whose rename already landed somewhere this run would no longer
//     choose is reconciled against ITS OWN recorded destination rather than dropped (see
//     `reconcileManifest`) — otherwise an entry moved by an older build would sit at a key nothing
//     could name.
//  2. THE LIVE PATH FOLLOWS. `agent/memory-dir.ts` reads the record's key — `memoryDirForRecord`
//     directly, and `memoryDirFor`'s cwd-keyed callers through `relocatedKey`, which the daemon
//     wires to `memoryKeyRelocations` (this file). A move and the lookup that finds it afterwards
//     commit as one fact.
//  3. A HOME THAT PINS ITS MEMDIR IS DECLINED WHOLE. `settings.memory.directory` REPLACES the
//     computed path entirely (memory-dir.ts), so relocating the key would move a tree nothing reads
//     and leave the pinned directory untouched: pointless motion on a user's own writing. Such a
//     home plans nothing — no manifest rows, no marker (see `MemoryKeyPlan.declined`).
//  4. THE WHOLE PROJECT TREE MOVES, NOT JUST `memory/` — BUT ENTRY BY ENTRY (P8b-29).
//     `<home>/projects/<key>/` also holds the compatibility layout's `<uuid>.jsonl`, `subagents/`,
//     `tool-results/` and `workflows/scripts/` (surface map §6.6), so a `memory/`-only move would
//     split one project's state across two keys. The first cut of this migration therefore renamed
//     the whole directory — and that is exactly wrong for the destination, because
//     `projects/<compatKey>/` is ALSO WHERE THE WINTER SDK WRITES TRANSCRIPTS. On any home that has
//     run a Winter session the destination already exists, so a whole-directory rename could only
//     refuse there, permanently, and take every other project in that home down with it.
//
//     So the unit of relocation is the ENTRY: every top-level entry under `projects/<oldKey>/` is
//     renamed to `projects/<newKey>/<entry>`, the destination directory MAY pre-exist, and a
//     collision is only ever "the same entry name exists at both ends". A collision refuses THAT
//     PROJECT and no other — the run continues — and because the manifest carries a row per entry,
//     a rollback puts back exactly the entries this migration moved and never the SDK's files
//     sitting beside them.
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRootFor, sanitizeProjectKey } from "../../agent/memory-dir";
import type { SessionStore } from "../../sessions/store";
import type { RuntimeStateDb } from "../db";
import { RuntimeSessionRecords } from "../records";

/** The buckets that are NOT a project and are never migrated: `_global` (facts that map to no
 *  project) and `_assistant` (the Dreaming bucket). `sanitizeProjectKey` cannot emit a leading
 *  underscore, so neither can ever be a real project's key — the guard is explicit anyway, because
 *  a migration that renamed one of these would silently detach memory from the only code that
 *  reads it. */
export const RESERVED_PROJECT_KEYS: readonly string[] = Object.freeze(["_global", "_assistant"]);

/**
 * The one entry the LIVE memory path resolves: `memoryDirFor` builds `projects/<key>/memory` and
 * nothing else. Which is why a project counts as relocated — for the record's key and for the
 * relocation map the daemon reads — exactly when THIS entry has moved (see `pairRelocated`). During
 * the one window where a project is half-moved (a torn apply, until the next boot repairs it) that
 * is the difference between the agent finding its own `MEMORY.md` and starting a second one.
 */
export const MEMORY_ENTRY = "memory";

/**
 * The filesystem calls this migration makes, as an injectable seam.
 *
 * ONLY REASON IT EXISTS: a torn apply — the process dying between a `rename` and its manifest commit
 * — is the one failure this whole manifest is built to survive, and it cannot be reproduced by
 * arranging files, only by making the rename land and the commit not. A test injects a `fs` whose
 * `renameSync` throws AFTER doing the real rename; production passes nothing and gets `node:fs`.
 */
export interface MemoryKeyFs {
  existsSync(path: string): boolean;
  renameSync(from: string, to: string): void;
  statSync(path: string): { isDirectory(): boolean };
  readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
  mkdirSync(path: string, options: { recursive: true }): void;
  /** Only ever called on a directory this migration has just emptied — never recursive. */
  rmdirSync(path: string): void;
}

const NODE_FS: MemoryKeyFs = {
  existsSync, renameSync, statSync, readdirSync,
  mkdirSync: (p, o) => { mkdirSync(p, o); },
  rmdirSync: (p) => { rmdirSync(p); },
};

export type MemoryKeyCollisionReason = "many-old-keys" | "old-key-fans-out" | "target-exists";

/**
 * Why a record was skipped.
 *
 * `session-gone`     — the record outlived its product session; there is no cwd to derive from.
 * `cwd-missing`      — the recorded cwd is not a directory any more.
 * `root-disagrees`   — the cwd is there, but today's root resolution no longer produces the key the
 *                      record stores. EVERY git failure lands here: git not installed, a
 *                      dubious-ownership refusal, a `.git` removed under a surviving directory. All
 *                      of them make `repoRootFor` AND the SDK's `gitCommonRoot` fall back to the cwd
 *                      itself, so the destination this run would derive is not the one the memory
 *                      was filed under.
 */
export type UnresolvedReason = "session-gone" | "cwd-missing" | "root-disagrees";

export interface UnresolvedRecord {
  winterSessionId: string;
  reason: UnresolvedReason;
}

export interface MemoryKeyMove {
  oldKey: string;
  newKey: string;
  /** The session cwd the new key was derived from — the actual input to the destination, so an
   *  operator reading the plan can check the derivation rather than take it on trust. Absent only
   *  when a caller builds a move by hand. */
  cwd?: string;
  /** The top-level entries under `projects/<oldKey>/` this move covers, as `plan` saw them. Absent
   *  on a hand-built move; `apply` re-reads the directory regardless, because the disk at apply time
   *  is the only honest answer. */
  entries?: readonly string[];
}

export interface MemoryKeyCollision {
  newKey: string;
  oldKeys: string[];
  /** Which of the three ambiguities this is — an operator has to fix the cause, not the symptom. */
  reason: MemoryKeyCollisionReason;
  /** For `target-exists`: the entry names that sit at BOTH ends. What the operator has to move or
   *  delete; naming the project alone would leave them looking at a directory of files with no idea
   *  which one is in the way. */
  entries?: string[];
}

export interface MemoryKeyPlan {
  moves: MemoryKeyMove[];
  /** Projects this run will not touch. Each refuses ITSELF and nothing else — the other projects in
   *  `moves` still apply (P8b-29). Nothing is written to the manifest for a refused project, so
   *  clearing the obstruction and re-planning is all it takes. */
  collisions: MemoryKeyCollision[];
  /** Always `RESERVED_PROJECT_KEYS`: a policy statement, not an observation of the disk. */
  preserved: string[];
  /** Directories under `<home>/projects/` that no record names — left completely untouched, and
   *  reported so an operator can see what the migration did not account for. */
  unreferenced: string[];
  /** Keys already equal to their destination: nothing to do. Normally the shape a completed
   *  migration leaves behind. */
  unchanged: string[];
  /** Records this migration will not touch because it cannot derive a trustworthy destination for
   *  them. Skipped rather than guessed at — a wrong destination moves somebody's memory somewhere
   *  nothing looks — and each carries the reason, because the three have different remedies:
   *  restore or re-clone the cwd, or accept that the record is orphaned. */
  unresolved: UnresolvedRecord[];
  /** Entries whose rename landed in an earlier run but whose manifest commit did not — found by this
   *  plan and settled by it (the rows are now `moved` and the records re-keyed), so `rollback` can
   *  reach them. Reported because "the previous run died mid-apply" is something an operator should
   *  read, not infer. Optional so a hand-built plan stays a valid `MemoryKeyPlan`. */
  reconciled?: MemoryKeyMove[];
  /** Set when the whole home is DECLINED rather than planned — nothing was written to the manifest
   *  and nothing will move. `memory-directory-override`: `settings.memory.directory` pins the MEMDIR
   *  to one path for every project, so the project key decides nothing and re-keying it would move a
   *  tree no live read consults (P8b-17 precondition 3). Clearing the setting re-enables the
   *  migration — which is why a declined run must never set the one-shot marker. */
  declined?: "memory-directory-override";
}

/**
 * `apply` refused a move because the manifest does not carry a row for it — the plan is stale
 * (already applied, or rolled back since), or it was built by hand and never planned at all.
 *
 * CHECKED BEFORE ANY RENAME, and that ordering is the whole point. Renaming first and only then
 * looking for the row is how a re-applied plan used to move a tree forward, match nothing, leave the
 * records naming the old key and report `{ moved: 0 }` — a moved tree with no recorded way back and
 * nothing reporting it (review r1, Important 2).
 *
 * THROWN, unlike a collision, because the two are different in kind: a collision is a fact about the
 * user's disk that the next run can find again, while a stale plan is a caller bug — there is no
 * state to describe and nothing for an operator to clear.
 */
export class MemoryKeyNotPlannedError extends Error {
  constructor(
    public readonly oldKey: string,
    public readonly newKey: string,
    public readonly status: string | undefined,
    /** The destination the manifest actually records for `oldKey`, when it holds a row at all. */
    public readonly recordedNewKey?: string,
  ) {
    super(
      `memory key migration refused — ${oldKey} → ${newKey} ` +
        (status === undefined
          ? "is not in the manifest at all"
          : recordedNewKey !== undefined && recordedNewKey !== newKey
            // Saying "not in the manifest" here would be a lie: the row is right there, pointing
            // somewhere else, and THAT is what the operator has to reconcile.
            ? `disagrees with the manifest, which records ${oldKey} → ${recordedNewKey} ('${status}')`
            : `is recorded as '${status}', which is neither 'planned' nor already 'moved'`) +
        `; re-run planMemoryKeyMigration to plan it`,
    );
    this.name = "MemoryKeyNotPlannedError";
  }
}

/** One entry a rollback could not restore. Reported rather than thrown — see `rollbackMemoryKeyMigration`. */
export interface MemoryKeyRollbackFailure {
  oldKey: string;
  newKey: string;
  entry: string;
  reason: "target-exists";
}

interface ManifestRow {
  old_key: string;
  entry: string;
  new_key: string;
  status: string;
  record_ids: string;
  /** P8d-13's schema v6 column, selected ONLY where an `undoing` row's resting state matters (the
   *  boot repair's own undoing-row query). `undefined` for any row that predates the column (there
   *  are none in production — `undoing` itself shipped in this same branch's schema v4 — but a
   *  replayed migration fixture can still produce one) and is read as `"planned"`, which is
   *  `undoEntries`' own historical behaviour. See `finishUndo`. */
  undo_target?: string | null;
}

/** The records a pair was derived from, as the manifest stored them. Tolerant of anything that is
 *  not a JSON array of strings: a row that cannot say whose records it owns owns none. */
function recordIdsOf(rows: ManifestRow[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.record_ids ?? "[]");
      if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === "string") out.add(id);
    } catch {
      /* a malformed row owns no records — never a reason to re-key by key instead */
    }
  }
  return [...out];
}

/** Every manifest row for one old key, in entry order. Read by the old key ALONE rather than by the
 *  whole pair, so a row that names a DIFFERENT destination is visible as what it is — a disagreement
 *  to report — instead of looking like no row at all. */
function manifestRowsFor(rs: RuntimeStateDb, oldKey: string): ManifestRow[] {
  return rs.db.query(`SELECT old_key, entry, new_key, status, record_ids FROM memory_key_manifest WHERE old_key = ? ORDER BY entry`).all(oldKey) as ManifestRow[];
}

function allManifestRows(rs: RuntimeStateDb): ManifestRow[] {
  return rs.db.query(`SELECT old_key, entry, new_key, status, record_ids FROM memory_key_manifest ORDER BY old_key, entry`).all() as ManifestRow[];
}

/**
 * Is this project's MEMORY at the new key right now?
 *
 * The question the live path asks, and the reason the answer is not "are all the rows moved": a torn
 * apply leaves a project half-moved, and during that window `memoryDirFor` must resolve wherever
 * `memory/` actually IS. A project with no `memory` entry at all (transcripts only) has nothing for
 * the live path to find at either key, so it follows the whole set instead — which keeps its record
 * filed alongside the entries that did move.
 */
function pairRelocated(rows: ManifestRow[]): boolean {
  const memory = rows.find((r) => r.entry === MEMORY_ENTRY);
  if (memory) return memory.status === "moved";
  return rows.length > 0 && rows.every((r) => r.status === "moved");
}

/** An EXISTING directory — `existsSync` alone would accept a file sitting at that path. */
function isDirectory(fs: MemoryKeyFs, path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const projectsDir = (home: string): string => join(home, "projects");
const projectDir = (home: string, key: string): string => join(projectsDir(home), key);
const entryPath = (home: string, key: string, entry: string): string => join(projectDir(home, key), entry);

/** The top-level entries under `projects/<key>/`, or `[]` when the directory is absent. The unit of
 *  relocation (P8b-29) and therefore the unit of collision, of the manifest, and of rollback. */
function entriesUnder(fs: MemoryKeyFs, home: string, key: string): string[] {
  const dir = projectDir(home, key);
  if (!isDirectory(fs, dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name).sort();
}

/**
 * Put the records for one old key where the manifest says its memory is.
 *
 * ALWAYS IN THE SAME TRANSACTION AS THE ROWS THAT DECIDED IT (every caller wraps this), because a
 * record that disagrees with the manifest is a memory read that silently finds nothing.
 */
function syncRecordKey(rs: RuntimeStateDb, records: RuntimeSessionRecords, oldKey: string): void {
  const rows = manifestRowsFor(rs, oldKey);
  if (rows.length === 0) return;
  const newKey = rows[0]!.new_key;
  if (rows.some((r) => r.new_key !== newKey)) return; // a corrupt pair: report nothing, move nothing
  const ids = recordIdsOf(rows);
  const relocated = pairRelocated(rows);
  // BY EXPLICIT RECORD IDS, captured at plan time (re-review NEW-3). The by-key form re-keys EVERY
  // record sitting at a key, which is right for a directory rename seen from the directory's side
  // and wrong seen from this migration's: a Winter session files its record AT the compatibility key
  // from birth, so the reverse direction below would drag those records to the old key every time a
  // multi-entry project is half-moved (entries apply in sorted order, and a `<uuid>.jsonl` sorts
  // before `memory`), and a rollback would file them there for good.
  if (ids.length > 0) {
    records.setMemoryProjectKeyFor(ids, relocated ? newKey : oldKey);
    return;
  }
  // A row with no ids is one carried up from schema v1/v2, which predate this column. FORWARD ONLY:
  // completing a relocation the disk already performed is what keeps a torn v1-era move readable,
  // while the reverse direction is the one that could capture somebody else's record — and there is
  // nothing to put back that this manifest can prove it moved.
  if (relocated) records.rekeyMemoryProjectKey(oldKey, newKey);
}

/**
 * Read the old→new mapping out of the records and decide what can safely move.
 *
 * Writes the `planned` manifest rows as a side effect — that is what makes `apply` a second, cheap
 * step rather than a re-derivation, and what lets a crash between the two be resumed. An
 * already-`moved` row is never reset back to `planned`: that row is the only evidence of where an
 * entry came from, and losing it would strand it with no way back.
 */
export function planMemoryKeyMigration(deps: {
  rs: RuntimeStateDb;
  home: string;
  records: RuntimeSessionRecords;
  store: SessionStore;
  /** `settings.memory.directory`, verbatim. Set (and not whitespace) declines the whole home —
   *  P8b-17 precondition 3. Passed rather than read from settings so this file keeps knowing
   *  nothing about the zod shape, the same convention `memory-dir.ts` follows. */
  memoryDirectory?: string;
  fs?: MemoryKeyFs;
}): MemoryKeyPlan {
  const { rs, home, store } = deps;
  const fs = deps.fs ?? NODE_FS;
  const plan: MemoryKeyPlan = { moves: [], collisions: [], preserved: [...RESERVED_PROJECT_KEYS], unreferenced: [], unchanged: [], unresolved: [], reconciled: [] };

  // PRECONDITION 3, AND IT IS CHECKED BEFORE A SINGLE ROW IS WRITTEN. A pinned MEMDIR makes the
  // project key inert for every live read (`memoryDirFor` returns the override before it computes a
  // key at all), so a relocation here would move a user's tree for no reader's benefit. Declined
  // whole, and deliberately WITHOUT a manifest row: a `planned` row is a promise to move something.
  if (deps.memoryDirectory !== undefined && deps.memoryDirectory.trim() !== "") {
    plan.declined = "memory-directory-override";
    return plan;
  }

  // (b) — whole-branch review NEW-4(b): drop any `rolled-back` row whose entry has vanished from
  // both ends BEFORE anything else runs, so a shrunk entry set from an earlier rollback can never
  // trip `apply`'s stale-row pre-check on a re-plan. See `pruneVanishedRollbacks`'s own doc comment.
  pruneVanishedRollbacks(rs, fs, home);

  // FIRST, before anything is derived from a record: a previous run may have died between a rename
  // and its commit, and the records it left behind still name the old key. Settling those here is
  // what lets the sweep below read records that agree with the disk.
  plan.reconciled = reconcileManifest(rs, home, fs, deps.records);

  // `compatibilityKeys` spawns `git` and, unlike Winter's own `repoRootFor`, memoises nothing — so a
  // migration over hundreds of records would be hundreds of subprocesses. One `Map` per plan call
  // (sessions cluster heavily on a handful of cwds) fixes that without caching across calls, which
  // would risk answering from a stale repo layout.
  const destinations = new Map<string, string>();
  const destinationFor = (cwd: string): string => {
    const cached = destinations.get(cwd);
    if (cached !== undefined) return cached;
    const key = compatibilityKeys(cwd).memoryProjectKey;
    destinations.set(cwd, key);
    return key;
  };

  // The distinct (oldKey → newKey) pairs the records ask for, in a stable order, plus the cwd each
  // destination was derived from.
  const wanted = new Map<string, Set<string>>();
  /** Which records asked for each old key — stored on the manifest rows so `syncRecordKey` can move
   *  exactly these and nothing that merely happens to sit at the same key (re-review NEW-3). */
  const recordsFor = new Map<string, Set<string>>();
  const cwdFor = new Map<string, string>();
  const referenced = new Set<string>();
  for (const record of deps.records.list()) {
    referenced.add(record.memoryProjectKey);
    referenced.add(record.transcriptProjectKey);
    const oldKey = record.memoryProjectKey;
    if (RESERVED_PROJECT_KEYS.includes(oldKey)) continue;
    // The destination is derived from the SESSION's cwd, exactly as Task 9 derived the keys it
    // stored. A record whose session is gone has no cwd to derive from, and inventing one (falling
    // back to the home directory, say) would name a destination nothing would ever look in.
    let cwd: string;
    try {
      cwd = store.meta(record.winterSessionId).cwd ?? home;
    } catch {
      plan.unresolved.push({ winterSessionId: record.winterSessionId, reason: "session-gone" });
      continue;
    }
    // See the header: a cwd that is gone silently degrades the destination to a per-cwd key.
    if (!isDirectory(fs, cwd)) {
      plan.unresolved.push({ winterSessionId: record.winterSessionId, reason: "cwd-missing" });
      continue;
    }
    const newKey = destinationFor(cwd);
    referenced.add(newKey);
    // ALREADY AT THE DESTINATION — checked FIRST, and the order matters: `apply` re-keys the record
    // to the new key, so after a completed migration the stored key is no longer what today's root
    // algorithm produces. Testing root agreement before this would report every migrated record as
    // corrupt on the next plan.
    if (oldKey === newKey) {
      if (!plan.unchanged.includes(oldKey)) plan.unchanged.push(oldKey);
      continue;
    }
    // AND THE DIRECTORY EXISTING IS NOT ENOUGH. `repoRootFor` falls back to the cwd on ANY git
    // failure — git missing, a dubious-ownership refusal, a `.git` deleted under a surviving
    // directory — and the SDK's `gitCommonRoot` fails in exactly the same conditions, so the
    // destination would degrade with nothing on disk looking wrong. The witness is the record
    // itself: it stores the key today's algorithm produced when the memory was filed. If re-running
    // that algorithm now disagrees, this run cannot derive the right destination and must not move
    // anything. (Deliberately compared through `repoRootFor`, the same memoised door the live memory
    // path uses, so this agrees with what the daemon itself would resolve.)
    //
    // THIS ALSO SUBSUMES THE TWO PLAN-LEVEL COLLISION SHAPES. A record whose stored key disagrees
    // with its own derivation is exactly the corruption `many-old-keys` and `old-key-fans-out` were
    // written to catch, and it is now intercepted here instead — one record at a time, reported, and
    // without refusing everybody else's migration. Those two guards are kept as defence in depth
    // (they would matter again the moment this precondition is weakened); `target-exists` remains
    // reachable on entirely consistent input.
    if (sanitizeProjectKey(repoRootFor(cwd)) !== oldKey) {
      plan.unresolved.push({ winterSessionId: record.winterSessionId, reason: "root-disagrees" });
      continue;
    }
    (wanted.get(oldKey) ?? wanted.set(oldKey, new Set()).get(oldKey)!).add(newKey);
    (recordsFor.get(oldKey) ?? recordsFor.set(oldKey, new Set()).get(oldKey)!).add(record.winterSessionId);
    cwdFor.set(`${oldKey}\0${newKey}`, cwd);
  }

  // One old key with more than one destination: unresolvable, and reported against every
  // destination it named so the operator sees the whole fan-out.
  const fanOut = new Set<string>();
  for (const [oldKey, newKeys] of wanted) {
    if (newKeys.size < 2) continue;
    fanOut.add(oldKey);
    for (const newKey of [...newKeys].sort()) plan.collisions.push({ newKey, oldKeys: [oldKey], reason: "old-key-fans-out" });
  }

  // More than one old key with the same destination: a silent merge if allowed through.
  const byNewKey = new Map<string, string[]>();
  for (const [oldKey, newKeys] of wanted) {
    if (fanOut.has(oldKey)) continue;
    const newKey = [...newKeys][0]!;
    (byNewKey.get(newKey) ?? byNewKey.set(newKey, []).get(newKey)!).push(oldKey);
  }
  for (const [newKey, oldKeys] of byNewKey) {
    if (oldKeys.length > 1) plan.collisions.push({ newKey, oldKeys: [...oldKeys].sort(), reason: "many-old-keys" });
  }

  for (const [newKey, oldKeys] of byNewKey) {
    if (oldKeys.length > 1) continue;
    const oldKey = oldKeys[0]!;
    const entries = entriesUnder(fs, home, oldKey);
    // Nothing at the source is neither a conflict nor a move: either the entries already reached
    // their destination (the TORN-APPLY WINDOW, settled above by `reconcileManifest` against each
    // row's OWN recorded destination, which after an SDK key change is not necessarily the one THIS
    // run derives — precondition 1), or this project has nothing on disk yet.
    if (entries.length === 0) continue;
    // P8b-29: the destination DIRECTORY may exist — it is the SDK's transcript directory for the
    // same repo. Only an entry of the same name at both ends is a collision, and it refuses this
    // project alone.
    const colliding = entries.filter((e) => fs.existsSync(entryPath(home, newKey, e)));
    if (colliding.length > 0) {
      plan.collisions.push({ newKey, oldKeys: [oldKey], reason: "target-exists", entries: colliding });
      continue;
    }
    const cwd = cwdFor.get(`${oldKey}\0${newKey}`);
    plan.moves.push({ oldKey, newKey, ...(cwd === undefined ? {} : { cwd }), entries });
  }
  // FINISH WHAT THE MANIFEST ALREADY PROMISED, even when the records can no longer ask for it.
  //
  // A torn apply part-way through a multi-entry project is settled per ROW (`reconcileManifest`),
  // which re-keys the record the moment `memory` lands — and from then on the record derives
  // `oldKey === newKey` and the sweep above reports it as `unchanged`. The entries that had not
  // moved yet would be orphaned at the old key with `planned` rows nothing ever acts on. The
  // manifest is the promise ledger, so an outstanding promise is planned from the ledger itself.
  const promised = new Map<string, string>();
  for (const row of rs.db.query(`SELECT old_key, entry, new_key, status, record_ids FROM memory_key_manifest WHERE status = 'planned'`).all() as ManifestRow[]) {
    promised.set(row.old_key, row.new_key);
  }
  for (const [oldKey, newKey] of promised) {
    referenced.add(oldKey);
    referenced.add(newKey);
    if (plan.moves.some((m) => m.oldKey === oldKey)) continue;       // the sweep already covers it
    if (plan.collisions.some((c) => c.oldKeys.includes(oldKey))) continue;
    const entries = entriesUnder(fs, home, oldKey);
    if (entries.length === 0) continue;
    const colliding = entries.filter((e) => fs.existsSync(entryPath(home, newKey, e)));
    if (colliding.length > 0) {
      plan.collisions.push({ newKey, oldKeys: [oldKey], reason: "target-exists", entries: colliding });
      continue;
    }
    plan.moves.push({ oldKey, newKey, entries });
  }

  plan.moves.sort((a, b) => a.oldKey.localeCompare(b.oldKey));
  plan.unchanged.sort();

  if (fs.existsSync(projectsDir(home))) {
    plan.unreferenced = fs.readdirSync(projectsDir(home), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !RESERVED_PROJECT_KEYS.includes(e.name) && !referenced.has(e.name))
      .map((e) => e.name)
      .sort();
  }

  const at = new Date().toISOString();
  rs.transaction(() => {
    for (const move of plan.moves) {
      for (const entry of move.entries ?? []) {
        // `record_ids` is written only when THIS run derived the pair from records. A move planned
        // from the manifest ledger alone (the torn-apply remainder) keeps whatever the row already
        // holds — overwriting it with `[]` would throw away the only record scoping that exists.
        const ids = recordsFor.get(move.oldKey);
        if (ids && ids.size > 0) {
          rs.db.run(
            `INSERT INTO memory_key_manifest (old_key, entry, new_key, status, planned_at, moved_at, record_ids) VALUES (?, ?, ?, 'planned', ?, NULL, ?)
             ON CONFLICT(old_key, entry) DO UPDATE SET new_key = excluded.new_key, status = 'planned', planned_at = excluded.planned_at, moved_at = NULL, record_ids = excluded.record_ids
             WHERE memory_key_manifest.status <> 'moved'`,
            [move.oldKey, entry, move.newKey, at, JSON.stringify([...ids].sort())],
          );
        } else {
          rs.db.run(
            `INSERT INTO memory_key_manifest (old_key, entry, new_key, status, planned_at, moved_at) VALUES (?, ?, ?, 'planned', ?, NULL)
             ON CONFLICT(old_key, entry) DO UPDATE SET new_key = excluded.new_key, status = 'planned', planned_at = excluded.planned_at, moved_at = NULL
             WHERE memory_key_manifest.status <> 'moved'`,
            [move.oldKey, entry, move.newKey, at],
          );
        }
      }
    }
  }, { mode: "immediate" });

  return plan;
}

/**
 * Settle every entry whose rename landed while its manifest commit did not — the TORN-APPLY WINDOW.
 *
 * `apply` renames and then commits (that order is deliberate: the other one would leave a `moved`
 * row for an entry that never went anywhere, and rollback would chase a file that was never there).
 * A crash in between leaves the entry at the new key with its row still `planned` — and left alone,
 * that row stays `planned` forever: `rollback` only reads `moved`, so it would have no recorded way
 * back, which is the one state this manifest exists to prevent.
 *
 * Exported (the `reconcileMemoryKeyManifest` wrapper below) because it is a REPAIR, not a
 * migration: the daemon runs it at EVERY boot, flag or no flag. A user who enables the flag, loses
 * the process inside that window and then turns the flag back off would otherwise leave entries at a
 * key whose `planned` rows nothing ever settles — invisible to `rollback` and to the relocation map
 * the live path consults. It only ever settles rows the user already opted into, and it does nothing
 * at all — one SELECT over a table that is usually empty — when there are none.
 *
 * DRIVEN BY THE MANIFEST ROWS, NOT BY THIS RUN'S PLAN, and that is precondition 1 in force. A row's
 * `new_key` is where the entry ACTUALLY went; the destination this run derives can differ (SDK 0.0.3
 * caps the key at 64 characters, so an 0.0.2-era row names a different directory for any overflowing
 * root). Matching on the plan's pairs would leave such an entry unreferenced by anything — source
 * gone, this run's destination empty, the row `planned` forever. Matching on the row finds it.
 *
 * PER ENTRY, which is also what keeps it honest (P8b-29): a row exists only for an entry THIS
 * migration planned to move, so "source gone, destination present" is evidence about that one name
 * rather than about a whole directory the SDK might have created for its own transcripts.
 *
 * Runs BEFORE the plan's own record sweep so the sweep sees the re-keyed records: a settled project
 * is then reported as `unchanged` (or `root-disagrees`, when its destination is an older algorithm's)
 * rather than planned all over again.
 */
export function reconcileMemoryKeyManifest(deps: { rs: RuntimeStateDb; home: string; records?: RuntimeSessionRecords; fs?: MemoryKeyFs; log?: (line: string) => void }): MemoryKeyMove[] {
  return reconcileManifest(deps.rs, deps.home, deps.fs ?? NODE_FS, deps.records ?? new RuntimeSessionRecords(deps.rs), deps.log);
}

function reconcileManifest(rs: RuntimeStateDb, home: string, fs: MemoryKeyFs, records: RuntimeSessionRecords, log?: (line: string) => void): MemoryKeyMove[] {
  // FIRST, THE UNDOS IN FLIGHT (re-review NEW-8). An `undoing` row is a rename-back this process —
  // or a previous one — declared and may not have finished. It is settled BEFORE the forward pass
  // below, because an undo that completes puts the entry back at the source, which is exactly what
  // the forward predicate must not then read as "already moved".
  //
  // THIS IS THE ONE PLACE THE REPAIR MOVES A FILE, and it moves only entries a row says are in
  // flight, only between the two keys that row names, and only into a name that is free.
  // NARRATED (re-review NEW-13): this is the one operation the repair performs on somebody's files,
  // and a completed undo used to contribute nothing to the return value — a directory under the
  // user's `projects/` was renamed at boot with no line in the log. Each rename-back says so.
  for (const row of rs.db
    .query(`SELECT old_key, entry, new_key, status, record_ids, undo_target FROM memory_key_manifest WHERE status = 'undoing' ORDER BY old_key, entry`)
    .all() as ManifestRow[]) {
    // a′ (P8d-11's rollback-door ruling): `undo_target` says which caller declared this undo — a
    // NULL/legacy row (every row `undoEntries` ever wrote before this column existed) means
    // "planned", `undoEntries`' own historical resting state; `rollbackMemoryKeyMigration` writes
    // `'rolled-back'` so a rollback interrupted mid-flight still settles as a completed rollback,
    // never as a project silently re-armed for the next `apply`.
    const restingStatus: "planned" | "rolled-back" = row.undo_target === "rolled-back" ? "rolled-back" : "planned";
    const outcome = finishUndo(rs, records, fs, home, row.old_key, row.new_key, row.entry, restingStatus);
    if (outcome === "renamed-back") log?.(`memory-key repair: finished an undo a previous run left in flight — moved projects/${row.new_key}/${row.entry} back to projects/${row.old_key}/${row.entry}`);
  }

  const rows = (rs.db.query(`SELECT old_key, entry, new_key, status, record_ids FROM memory_key_manifest WHERE status = 'planned' ORDER BY old_key, entry`).all() as ManifestRow[])
    .filter((r) => !fs.existsSync(entryPath(home, r.old_key, r.entry)) && fs.existsSync(entryPath(home, r.new_key, r.entry)));
  if (rows.length === 0) return [];
  const at = new Date().toISOString();
  const settled = new Map<string, MemoryKeyMove>();
  rs.transaction(() => {
    for (const row of rows) {
      const changed = rs.db.run(
        `UPDATE memory_key_manifest SET status = 'moved', moved_at = ? WHERE old_key = ? AND entry = ? AND new_key = ? AND status = 'planned'`,
        [at, row.old_key, row.entry, row.new_key],
      ).changes;
      if (changed === 0) continue;
      const key = `${row.old_key}\0${row.new_key}`;
      const move = settled.get(key) ?? { oldKey: row.old_key, newKey: row.new_key, entries: [] as string[] };
      (move.entries as string[]).push(row.entry);
      settled.set(key, move);
    }
    // The records follow the entries here too. Without it the manifest would say `moved` while a
    // record still named the old key, and a later rollback would move things back under a key its
    // own record had already stopped agreeing with.
    for (const move of settled.values()) syncRecordKey(rs, records, move.oldKey);
    for (const move of settled.values()) pruneEmptySource(fs, home, move.oldKey);
  }, { mode: "immediate" });
  return [...settled.values()];
}

/** Remove `projects/<oldKey>/` once every entry has left it. An empty leftover would otherwise be
 *  planned again (an empty move) and would keep a key alive that nothing files anything under.
 *  Best-effort by construction: anything still inside makes `rmdir` fail, which is the answer. */
function pruneEmptySource(fs: MemoryKeyFs, home: string, oldKey: string): void {
  try {
    if (entriesUnder(fs, home, oldKey).length === 0 && fs.existsSync(projectDir(home, oldKey))) fs.rmdirSync(projectDir(home, oldKey));
  } catch {
    /* still occupied, or gone already — either way there is nothing to clean up */
  }
}

/**
 * The `old_key -> new_key` map of every relocation this home has actually performed.
 *
 * THE LIVE PATH'S HALF OF P8b-17. `agent/memory-dir.ts` is keyed by cwd and derives today's key; a
 * migrated project's memory is not there any more. This is the door that says where it went — read
 * from the same rows the re-key was committed with, so the answer is the record's own key by
 * construction, and a rollback (which sets `rolled-back`) removes it from this map in the same
 * transaction that puts the entries back.
 */
export function memoryKeyRelocations(rs: RuntimeStateDb): Map<string, string> {
  const byOldKey = new Map<string, ManifestRow[]>();
  for (const row of allManifestRows(rs)) (byOldKey.get(row.old_key) ?? byOldKey.set(row.old_key, []).get(row.old_key)!).push(row);
  const out = new Map<string, string>();
  for (const [oldKey, rows] of byOldKey) {
    const newKey = rows[0]!.new_key;
    if (rows.some((r) => r.new_key !== newKey)) continue;
    if (pairRelocated(rows)) out.set(oldKey, newKey);
  }
  return out;
}

/**
 * Perform the plan's moves, ENTRY BY ENTRY (P8b-29).
 *
 * The rename and the manifest row are two different stores and cannot share a transaction, so the
 * rename goes FIRST and the row is committed after. The other order would leave a `moved` row for an
 * entry that never went anywhere, and rollback would then chase a file that was never there.
 *
 * A crash in that window leaves the entry moved with its row still `planned`, and it is
 * `planMemoryKeyMigration` — not this function — that repairs it: a resumed run always re-plans
 * first, and by then the source entry is gone. See `reconcileManifest`.
 *
 * A COLLISION REFUSES ITS OWN PROJECT AND NOTHING ELSE, and a refused project moves nothing at all —
 * a project's state never splits across two keys. Every entry is checked against the destination
 * BEFORE the first rename, which settles the ordinary case; an entry that appears DURING the pass
 * (the race window) is caught by the re-check immediately before each rename, and the entries this
 * pass already moved are put back (`undoEntries`) so the claim above holds there too. The run
 * continues with the other projects either way. The refusals come back as data rather than as an
 * exception, because they are facts about the user's disk that the next run can find again — not
 * caller bugs.
 *
 * Re-passing the SAME in-memory plan is handled by the manifest pre-check: an entry whose row
 * already reads `moved` is skipped as done, and any other stale state refuses before a rename can
 * happen.
 */
export function applyMemoryKeyMigration(
  deps: { rs: RuntimeStateDb; home: string; fs?: MemoryKeyFs },
  plan: MemoryKeyPlan,
): { moved: number; movedEntries: number; refused: MemoryKeyCollision[] } {
  const { rs, home } = deps;
  const fs = deps.fs ?? NODE_FS;
  // Constructed from the handle we already hold rather than taken as a dependency: `runtime_sessions`
  // belongs to `RuntimeSessionRecords`, so the record-side write goes through its owner instead of a
  // raw UPDATE from a migration, and the pinned `{ rs, home }` signature is left alone.
  const records = new RuntimeSessionRecords(rs);

  // EVERY project is checked before ANY rename: a half-applied stale plan is not a state that should
  // exist, and the check is what stops a rename from happening with no manifest row to record it.
  // See `MemoryKeyNotPlannedError`. (Checked per PROJECT rather than per entry because a plan that
  // disagrees with the manifest disagrees about the destination, which is a property of the pair.)
  for (const move of plan.moves) {
    const rows = manifestRowsFor(rs, move.oldKey);
    if (rows.length === 0) throw new MemoryKeyNotPlannedError(move.oldKey, move.newKey, undefined);
    const disagreeing = rows.find((r) => r.new_key !== move.newKey);
    if (disagreeing) throw new MemoryKeyNotPlannedError(move.oldKey, move.newKey, disagreeing.status, disagreeing.new_key);
    // A row already `moved` is work this plan already did — not a refusal, and neither is an
    // `undoing` row (an undo the repair could not finish): the `present` filter below moves only
    // `planned` entries, so such a row asks for nothing, and throwing over it would let ONE leftover
    // row deny every other project its migration on every retry. Anything else — a `rolled-back`
    // row, say — is a stale plan and still refuses.
    const stale = rows.find((r) => r.status !== "planned" && r.status !== "moved" && r.status !== "undoing");
    if (stale) throw new MemoryKeyNotPlannedError(move.oldKey, move.newKey, stale.status, stale.new_key);
  }

  const refused: MemoryKeyCollision[] = [];
  let moved = 0;
  let movedEntries = 0;
  for (const move of plan.moves) {
    const rows = new Map(manifestRowsFor(rs, move.oldKey).map((r) => [r.entry, r]));
    // THE DISK AT APPLY TIME IS THE AUTHORITY, not the plan's snapshot of it. An entry that appeared
    // since planning has no row and is left where it is — the next plan picks it up — rather than
    // moved without a way back.
    const present = entriesUnder(fs, home, move.oldKey).filter((e) => rows.get(e)?.status === "planned");
    if (present.length === 0) {
      pruneEmptySource(fs, home, move.oldKey);
      continue;
    }
    // Re-checked under this call rather than trusted from plan time, and for EVERY entry before the
    // first rename: `rename` onto an existing FILE replaces it silently (POSIX), which is the one
    // outcome that could destroy somebody's memory.
    const colliding = present.filter((e) => fs.existsSync(entryPath(home, move.newKey, e)));
    if (colliding.length > 0) {
      refused.push({ newKey: move.newKey, oldKeys: [move.oldKey], reason: "target-exists", entries: colliding });
      continue;
    }
    fs.mkdirSync(projectDir(home, move.newKey), { recursive: true });
    const done: string[] = [];
    for (const entry of present) {
      // The immediate-before-the-rename re-check. Cheap, and it turns a race into a refusal instead
      // of a silent replacement.
      if (fs.existsSync(entryPath(home, move.newKey, entry))) {
        // AND THE PROJECT GOES BACK TO WHERE IT STARTED (re-review NEW-5). "A refused project moves
        // nothing at all" was true of the batch check above and not of this one: breaking here left
        // the earlier entries at the new key, i.e. exactly the split across two keys the rule exists
        // to prevent. The entries this pass moved are put back, their rows returned to `planned`,
        // and the record scoping re-synced — so the state is byte-for-byte what the operator will
        // find after they clear the obstruction and re-run.
        undoEntries(rs, records, fs, home, move, done);
        refused.push({ newKey: move.newKey, oldKeys: [move.oldKey], reason: "target-exists", entries: [entry] });
        done.length = 0;
        break;
      }
      fs.renameSync(entryPath(home, move.oldKey, entry), entryPath(home, move.newKey, entry));
      done.push(entry);
      // ONE TRANSACTION for this entry's row AND the records that named the old key: the entry has
      // already moved, so a commit that landed only half of this would leave records pointing at a
      // path that no longer exists (a memory read would then find nothing, silently) or a manifest
      // that disagrees with the records about where it went.
      rs.transaction(() => {
        rs.db.run(
          `UPDATE memory_key_manifest SET status = 'moved', moved_at = ? WHERE old_key = ? AND entry = ? AND new_key = ? AND status = 'planned'`,
          [new Date().toISOString(), move.oldKey, entry, move.newKey],
        );
        syncRecordKey(rs, records, move.oldKey);
      }, { mode: "immediate" });
    }
    pruneEmptySource(fs, home, move.oldKey);
    if (done.length > 0) {
      moved += 1;
      movedEntries += done.length;
    }
  }
  return { moved, movedEntries, refused };
}

/**
 * Put back the entries THIS pass just moved, for a project that then hit a race-window refusal.
 *
 * Only ever called with entries whose rename and row-commit both landed moments earlier in this same
 * loop, so the reverse rename cannot collide with anything: the source name was ours and is still
 * free. Best-effort per entry all the same — an entry that will not come back is left where it is
 * with its row still `moved`, which is the truth, and the next plan finishes the project from the
 * ledger rather than pretending the undo was total.
 */
function undoEntries(
  rs: RuntimeStateDb,
  records: RuntimeSessionRecords,
  fs: MemoryKeyFs,
  home: string,
  move: MemoryKeyMove,
  entries: readonly string[],
): void {
  if (entries.length === 0) return;
  // DECLARED BEFORE A SINGLE RENAME-BACK (re-review NEW-8). The undo is a rename-then-commit pair
  // exactly as the move is, and its torn window is the move's mirror image: the entry back at the
  // OLD key with a row still saying `moved`. Nothing read that shape — the boot repair looks at
  // `planned` rows, and `plan`/`apply` both skip `moved` ones — so the entry stayed stranded under a
  // row that lied about it, and when the entry was `memory` the live map kept pointing at a
  // directory that had moved away (M-1's harm, through a new door). An `undoing` row says "these
  // entries are in flight, in this direction", which is a state the boot repair can finish.
  //
  // The records follow HERE rather than after the renames: `undoing` is not `moved`, so
  // `pairRelocated` is already false inside this transaction and `syncRecordKey` files them at the
  // old key — where the entries are going. A crash mid-undo then leaves records and the (finished)
  // repair agreeing, rather than a window where the map says relocated and the tree is not.
  rs.transaction(() => {
    for (const entry of entries) {
      // `undo_target = 'planned'`, explicit rather than relying on the column's NULL default: this
      // caller's own resting state has always been `planned` (an aborted forward move goes back to
      // being re-planned), and a caller that says so plainly needs no default at all.
      rs.db.run(
        `UPDATE memory_key_manifest SET status = 'undoing', undo_target = 'planned' WHERE old_key = ? AND entry = ? AND new_key = ? AND status = 'moved'`,
        [move.oldKey, entry, move.newKey],
      );
    }
    syncRecordKey(rs, records, move.oldKey);
  }, { mode: "immediate" });

  for (const entry of entries) finishUndo(rs, records, fs, home, move.oldKey, move.newKey, entry, "planned");
}

/**
 * Carry ONE `undoing` entry to rest — from `undoEntries` immediately, from
 * `rollbackMemoryKeyMigration` immediately, or from the boot repair after a crash in either. Every
 * branch is decided by where the entry actually IS, never by how it got there — the ONE thing a
 * caller supplies is `restingStatus`, where the entry lands when the undo can be considered
 * complete: `undoEntries`' own aborted-forward-move always passes `"planned"`; a full user-directed
 * rollback (a′, P8d-11's ruling) passes `"rolled-back"`, so a rollback interrupted mid-flight still
 * finishes AS a rollback rather than quietly re-arming the project for the next `apply` — the
 * rollback completes, and whatever `runtimes.migrations.memoryKeys` is set to is left exactly as the
 * user set it; this operation only ever moves files and manifest rows, never that flag.
 */
function finishUndo(
  rs: RuntimeStateDb,
  records: RuntimeSessionRecords,
  fs: MemoryKeyFs,
  home: string,
  oldKey: string,
  newKey: string,
  entry: string,
  restingStatus: "planned" | "rolled-back",
): "renamed-back" | "settled" | "left-undoing" {
  const back = entryPath(home, oldKey, entry);
  const at = entryPath(home, newKey, entry);
  let settled: "resting" | "moved" | undefined;
  let renamed = false;
  try {
    if (fs.existsSync(back)) {
      // Already home — either this call's rename landed and its commit did not, or a hand-undo.
      settled = fs.existsSync(at) ? "moved" : "resting";
    } else if (fs.existsSync(at)) {
      fs.mkdirSync(projectDir(home, oldKey), { recursive: true });
      fs.renameSync(at, back);
      renamed = true;
      settled = "resting";
    } else {
      // At neither end: the entry is gone. The RESTING status is the honest state either way —
      // `apply` moves only entries that exist at the source, so a `planned` row asks for nothing
      // until one reappears, and a `rolled-back` row simply describes a rollback of an entry that
      // is no longer anywhere to be found (task 2.1's `pruneVanishedRollbacks` is what eventually
      // clears such a row, not this function).
      settled = "resting";
    }
  } catch {
    return "left-undoing"; // the next boot's repair tries again rather than recording a guess
  }
  // BOTH ends occupied is the one shape the undo cannot complete: something re-took the old name
  // while the entry sat at the new key. The row goes back to `moved`, which is where the entry
  // really is, so the live map and the records describe the disk rather than an intention —
  // regardless of which caller declared this undo, `moved` is never a caller's own resting status.
  rs.transaction(() => {
    if (settled === "moved") {
      rs.db.run(`UPDATE memory_key_manifest SET status = 'moved' WHERE old_key = ? AND entry = ? AND new_key = ? AND status = 'undoing'`, [oldKey, entry, newKey]);
    } else if (restingStatus === "planned") {
      rs.db.run(`UPDATE memory_key_manifest SET status = 'planned', moved_at = NULL WHERE old_key = ? AND entry = ? AND new_key = ? AND status = 'undoing'`, [oldKey, entry, newKey]);
    } else {
      // `rolled-back` rows keep `moved_at` — the ORIGINAL rollback door's own convention (it never
      // clears the field either): the timestamp still answers "when was this actually moved",
      // which a rollback does not erase, only reverse.
      rs.db.run(`UPDATE memory_key_manifest SET status = 'rolled-back' WHERE old_key = ? AND entry = ? AND new_key = ? AND status = 'undoing'`, [oldKey, entry, newKey]);
    }
    syncRecordKey(rs, records, oldKey);
  }, { mode: "immediate" });
  return renamed ? "renamed-back" : "settled";
}

/**
 * Put every applied move back. Byte-identical by construction: a rename moves a file or directory,
 * it does not copy or rewrite it, so what comes back is the same inodes with the same contents.
 *
 * PER ENTRY, and that is what makes it safe on a shared destination (P8b-29): only the entries this
 * migration is recorded as having moved go back, so the SDK's transcripts sitting in the same
 * directory are never dragged under a key nothing reads.
 *
 * Tolerant in the same direction `apply` is: an entry whose new location is already gone and whose
 * old location is already present has been rolled back by hand, and is recorded rather than
 * re-fought.
 *
 * NEVER THROWS PART-WAY. An entry whose old location has been re-occupied is reported in `failures`
 * and left completely alone — every other entry is still restored. Throwing mid-loop would leave
 * some back and some forward with nothing saying which.
 */
export function rollbackMemoryKeyMigration(deps: { rs: RuntimeStateDb; home: string; fs?: MemoryKeyFs }): { rolledBack: number; failures: MemoryKeyRollbackFailure[] } {
  const { rs, home } = deps;
  const fs = deps.fs ?? NODE_FS;
  const records = new RuntimeSessionRecords(rs);
  const rows = rs.db.query(`SELECT old_key, entry, new_key, status, record_ids FROM memory_key_manifest WHERE status = 'moved' ORDER BY old_key, entry`).all() as ManifestRow[];
  const failures: MemoryKeyRollbackFailure[] = [];
  const touched = new Set<string>();
  let rolledBack = 0;
  for (const row of rows) {
    const source = entryPath(home, row.new_key, row.entry);
    const target = entryPath(home, row.old_key, row.entry);
    // A rollback is an undo under pressure. One blocked entry must not deny every other entry its
    // restore. So a collision is COLLECTED and this row is left entirely alone: file, record and
    // manifest all stay `moved`, ready to retry once the obstruction is cleared. (`apply` refuses up
    // front instead, because a move can still be declined; by the time rollback runs the entries
    // have already been moved.)
    if (fs.existsSync(source) && fs.existsSync(target)) {
      failures.push({ oldKey: row.old_key, newKey: row.new_key, entry: row.entry, reason: "target-exists" });
      continue;
    }
    // Neither end holds the entry any more — nothing to roll back (it was deleted after the
    // migration moved it). The row stays `moved`, describing the last place it truthfully was;
    // `planMemoryKeyMigration`'s `pruneVanishedRollbacks` is scoped to `rolled-back` rows only, so
    // this one is left for an operator to notice, not silently reclassified.
    if (!fs.existsSync(source) && !fs.existsSync(target)) continue;

    // a′ (P8d-11's own ruling — the rollback door's torn window). This used to rename first and
    // commit `rolled-back` second, exactly the shape `undoEntries` above was fixed for (re-review
    // NEW-8): a crash in between left the entry at the OLD key with a row still saying `moved`,
    // which nothing reads as anything but "still there" (`rollback` itself only reads `moved`; the
    // boot repair only reads `undoing`). Declaring the direction FIRST makes this window repairable
    // by the SAME `finishUndo` the forward apply's own race window uses, with `undo_target =
    // 'rolled-back'` so a resumed rollback settles to `rolled-back` — never `undoEntries`' own
    // `planned` — and the ruling this ships with: the rollback completes, and
    // `runtimes.migrations.memoryKeys` is left exactly as the user set it (this operation only ever
    // moves files and manifest rows, never that flag; whether the NEXT boot re-plans a `rolled-back`
    // row is entirely up to whatever the flag says then, same as any other boot).
    rs.transaction(() => {
      rs.db.run(
        `UPDATE memory_key_manifest SET status = 'undoing', undo_target = 'rolled-back' WHERE old_key = ? AND entry = ? AND new_key = ? AND status = 'moved'`,
        [row.old_key, row.entry, row.new_key],
      );
      syncRecordKey(rs, records, row.old_key);
    }, { mode: "immediate" });

    const outcome = finishUndo(rs, records, fs, home, row.old_key, row.new_key, row.entry, "rolled-back");
    // An I/O failure mid-rename (never reachable through the two `fs.existsSync` checks above,
    // which only test presence) leaves the row `undoing` for the next boot's repair to retry — not
    // a `target-exists` collision, so it is not reported in `failures`; a leftover `undoing` row is
    // now itself a fact `winter doctor`'s `memory-keys-migration` finding can surface.
    if (outcome === "left-undoing") continue;
    touched.add(row.new_key);
    rolledBack += 1;
  }
  // A destination this migration created and has now emptied is removed; one that still holds the
  // SDK's own files is left exactly as it is.
  for (const newKey of touched) {
    try {
      if (entriesUnder(fs, home, newKey).length === 0 && fs.existsSync(projectDir(home, newKey))) fs.rmdirSync(projectDir(home, newKey));
    } catch {
      /* still occupied — which is the answer */
    }
  }
  return { rolledBack, failures };
}

/**
 * (b) — whole-branch review NEW-4(b): a re-plan after a rollback whose entry set has SHRUNK (an
 * entry was rolled back and then deleted by hand, or never recreated) must not leave a `rolled-back`
 * row behind for it. `applyMemoryKeyMigration`'s stale-row pre-check reads EVERY row for an old key
 * it is about to move, and a `rolled-back` row is not one of the three statuses it tolerates
 * (`planned`/`moved`/`undoing`) — so one leftover row denied the WHOLE project's migration, on every
 * retry, forever. Only `rolled-back` rows are dropped, and only when the entry is gone from BOTH
 * ends: a `planned`/`moved`/`undoing` row for a missing entry is evidence something else is wrong
 * and stays for an operator to see (or for `finishUndo`/the boot repair to settle), but a
 * `rolled-back` row is CLOSED history the moment the entry it describes is gone everywhere — nothing
 * can ever roll it forward or back again.
 *
 * Called from `planMemoryKeyMigration`, BEFORE `apply` ever sees these rows.
 */
function pruneVanishedRollbacks(rs: RuntimeStateDb, fs: MemoryKeyFs, home: string): void {
  const oldKeys = (rs.db.query(`SELECT DISTINCT old_key FROM memory_key_manifest WHERE status = 'rolled-back'`).all() as Array<{ old_key: string }>).map(
    (r) => r.old_key,
  );
  if (oldKeys.length === 0) return;
  rs.transaction(() => {
    for (const oldKey of oldKeys) {
      const onOldSide = new Set(entriesUnder(fs, home, oldKey));
      for (const row of manifestRowsFor(rs, oldKey)) {
        if (row.status !== "rolled-back" || onOldSide.has(row.entry)) continue;
        // Gone from the old side (where a rollback puts an entry) — confirm it is not ALSO sitting
        // at the new key before deleting the only record of where it used to live; the new-side
        // check is what keeps this from ever discarding a row that is merely mid-flight.
        if (fs.existsSync(entryPath(home, row.new_key, row.entry))) continue;
        rs.db.run(`DELETE FROM memory_key_manifest WHERE old_key = ? AND entry = ? AND status = 'rolled-back'`, [row.old_key, row.entry]);
      }
    }
  }, { mode: "immediate" });
}
