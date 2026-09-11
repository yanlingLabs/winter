// WS-16 §17's Migration A, phase 5: move each project's memory directory from TODAY's key to the
// compatibility key, through a manifest that can undo it.
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
// remembers what it was. `memory_key_manifest` is that something: one row per move, `planned` →
// `moved` → `rolled-back`, so an operator who applies this and dislikes the result can put every
// directory back byte-for-byte without knowing either algorithm. Project memory is a user's own
// writing — the migration may relocate it, and may never merge, overwrite or drop any of it.
//
// WHICH IS WHY EVERY AMBIGUITY IS A REFUSAL, not a resolution. Three shapes make a mapping
// ambiguous, and all three are collisions that stop the whole run:
//
//   many-old-keys     two projects' memory would land in one directory — a silent merge.
//   old-key-fans-out  one directory has two destinations — picking either loses the other's memory.
//   target-exists     the destination directory is already occupied by something else.
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
//     `reconcileTornApplies`) — otherwise a tree moved by an older build would sit at a key nothing
//     could name.
//  2. THE LIVE PATH FOLLOWS. `agent/memory-dir.ts` reads the record's key — `memoryDirForRecord`
//     directly, and `memoryDirFor`'s cwd-keyed callers through `relocatedKey`, which the daemon
//     wires to `memoryKeyRelocations` (this file). A move and the lookup that finds it afterwards
//     commit as one fact.
//  3. A HOME THAT PINS ITS MEMDIR IS DECLINED WHOLE. `settings.memory.directory` REPLACES the
//     computed path entirely (memory-dir.ts), so relocating the key would move a tree nothing reads
//     and leave the pinned directory untouched: pointless motion on a user's own writing. Such a
//     home plans nothing — no manifest rows, no marker (see `MemoryKeyPlan.declined`).
//  4. THE WHOLE PROJECT TREE MOVES, NOT JUST `memory/`. `<home>/projects/<key>/` also holds the
//     compatibility layout's `<uuid>.jsonl`, `subagents/`, `tool-results/` and `workflows/scripts/`
//     (surface map §6.6). The unit of relocation here is therefore the PROJECT DIRECTORY — one
//     `rename` of `projects/<oldKey>` — never a `memory/`-only move that would split one project's
//     state across two keys.
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
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
 * The four filesystem calls this migration makes, as an injectable seam.
 *
 * ONLY REASON IT EXISTS: a torn apply — the process dying between the `rename` and the manifest
 * commit — is the one failure this whole manifest is built to survive, and it cannot be reproduced
 * by arranging files, only by making the rename land and the commit not. A test injects a `fs` whose
 * `renameSync` throws AFTER doing the real rename; production passes nothing and gets `node:fs`.
 */
export interface MemoryKeyFs {
  existsSync(path: string): boolean;
  renameSync(from: string, to: string): void;
  statSync(path: string): { isDirectory(): boolean };
  readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
}

const NODE_FS: MemoryKeyFs = { existsSync, renameSync, statSync, readdirSync };

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
}

export interface MemoryKeyCollision {
  newKey: string;
  oldKeys: string[];
  /** Which of the three ambiguities this is — an operator has to fix the cause, not the symptom. */
  reason: MemoryKeyCollisionReason;
}

export interface MemoryKeyPlan {
  moves: MemoryKeyMove[];
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
  /** Trees whose rename landed in an earlier run but whose manifest commit did not — found by this
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

/** `apply` refused: the mapping is ambiguous, and nothing was moved. */
export class MemoryKeyCollisionError extends Error {
  constructor(public readonly collisions: MemoryKeyCollision[]) {
    super(
      `memory key migration refused — ${collisions.length} ambiguous mapping(s): ` +
        collisions.map((c) => `${c.oldKeys.join(", ")} → ${c.newKey} (${c.reason})`).join("; "),
    );
    this.name = "MemoryKeyCollisionError";
  }
}

/**
 * `apply` refused a move because the manifest does not carry a `planned` row for it — the plan is
 * stale (already applied, or rolled back since), or it was built by hand and never planned at all.
 *
 * CHECKED BEFORE ANY RENAME, and that ordering is the whole point. Renaming first and only then
 * looking for the row is how a re-applied plan used to move a tree forward, match nothing, leave the
 * records naming the old key and report `{ moved: 0 }` — a moved tree with no recorded way back and
 * nothing reporting it (review r1, Important 2).
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

/** One tree a rollback could not restore. Reported rather than thrown — see `rollbackMemoryKeyMigration`. */
export interface MemoryKeyRollbackFailure {
  oldKey: string;
  newKey: string;
  reason: "target-exists";
}

interface ManifestRow { old_key: string; new_key: string; status: string }

/** The manifest's own row for one old key, if it holds one. Read by the PRIMARY KEY alone rather
 *  than by the whole pair, so a row that names a DIFFERENT destination is visible as what it is —
 *  a disagreement to report — instead of looking like no row at all. */
function manifestRow(rs: RuntimeStateDb, oldKey: string): { new_key: string; status: string } | undefined {
  return (rs.db.query(`SELECT new_key, status FROM memory_key_manifest WHERE old_key = ?`).get(oldKey) as { new_key: string; status: string } | null) ?? undefined;
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

/**
 * Read the old→new mapping out of the records and decide what can safely move.
 *
 * Writes the `planned` manifest rows as a side effect — that is what makes `apply` a second, cheap
 * step rather than a re-derivation, and what lets a crash between the two be resumed. An
 * already-`moved` row is never reset back to `planned`: that row is the only evidence of where a
 * directory came from, and losing it would strand the tree with no way back.
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

  // FIRST, before anything is derived from a record: a previous run may have died between its rename
  // and its commit, and the records it left behind still name the old key. Settling those here is
  // what lets the sweep below read records that agree with the disk.
  plan.reconciled = reconcileTornApplies(rs, home, fs, deps.records);

  // `compatibilityKeys` spawns `git` and, unlike Norma's own `repoRootFor`, memoises nothing — so a
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
    cwdFor.set(`${oldKey}\u0000${newKey}`, cwd);
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
    const sourceExists = fs.existsSync(projectDir(home, oldKey));
    const targetExists = fs.existsSync(projectDir(home, newKey));
    // Source gone is neither a conflict nor a move: either the tree already reached a destination —
    // the TORN-APPLY WINDOW, settled below by `reconcileTornApplies` against the row's OWN recorded
    // destination, which after an SDK key change is not necessarily the one THIS run derives
    // (precondition 1) — or this project has no tree on disk at all yet.
    if (!sourceExists) continue;
    if (targetExists) {
      plan.collisions.push({ newKey, oldKeys: [oldKey], reason: "target-exists" });
      continue;
    }
    const cwd = cwdFor.get(`${oldKey}\u0000${newKey}`);
    plan.moves.push({ oldKey, newKey, ...(cwd === undefined ? {} : { cwd }) });
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
      rs.db.run(
        `INSERT INTO memory_key_manifest (old_key, new_key, status, planned_at, moved_at) VALUES (?, ?, 'planned', ?, NULL)
         ON CONFLICT(old_key) DO UPDATE SET new_key = excluded.new_key, status = 'planned', planned_at = excluded.planned_at, moved_at = NULL
         WHERE memory_key_manifest.status <> 'moved'`,
        [move.oldKey, move.newKey, at],
      );
    }
  }, { mode: "immediate" });

  return plan;
}

/**
 * Settle every tree whose rename landed while its manifest commit did not — the TORN-APPLY WINDOW.
 *
 * Exported (the `reconcileMemoryKeyTornApplies` wrapper directly above) because it is a REPAIR, not
 * a migration: the daemon runs it at EVERY boot, flag or no flag. A user who enables the flag, loses
 * the process inside the rename/commit window and then turns the flag back off would otherwise leave
 * a tree at a key whose `planned` row nothing ever settles — invisible to `rollback` (which reads
 * `moved`) and to the relocation map the live path consults. It only ever settles rows the user
 * already opted into, and it does nothing at all — one SELECT over a table that is usually empty —
 * when there are none.
 *
 * `apply` renames and then commits (that order is deliberate: the other one would leave a `moved`
 * row for a directory that never went anywhere, and rollback would chase a tree that was never
 * there). A crash in between leaves the directory at the new key with its row still `planned` — and
 * left alone, that row stays `planned` forever: `rollback` only reads `moved`, so the tree would
 * have no recorded way back, which is the one state this manifest exists to prevent.
 *
 * DRIVEN BY THE MANIFEST ROWS, NOT BY THIS RUN'S PLAN, and that is precondition 1 in force. A row's
 * `new_key` is where the tree ACTUALLY went; the destination this run derives can differ (SDK 0.0.3
 * caps the key at 64 characters, so an 0.0.2-era row names a different directory for any overflowing
 * root). Matching on the plan's pairs would leave such a tree unreferenced by anything — source gone,
 * this run's destination empty, the row `planned` forever. Matching on the row finds it.
 *
 * A `planned` row is only ever written for a source directory that EXISTED at plan time, so "source
 * gone, destination present" cannot be a project that never had a tree.
 *
 * Runs BEFORE the plan's own record sweep so the sweep sees the re-keyed records: a settled project
 * is then reported as `unchanged` (or `root-disagrees`, when its destination is an older algorithm's)
 * rather than planned all over again.
 */
export function reconcileMemoryKeyTornApplies(deps: { rs: RuntimeStateDb; home: string; records?: RuntimeSessionRecords; fs?: MemoryKeyFs }): MemoryKeyMove[] {
  return reconcileTornApplies(deps.rs, deps.home, deps.fs ?? NODE_FS, deps.records ?? new RuntimeSessionRecords(deps.rs));
}

function reconcileTornApplies(rs: RuntimeStateDb, home: string, fs: MemoryKeyFs, records: RuntimeSessionRecords): MemoryKeyMove[] {
  const rows = rs.db.query(`SELECT old_key, new_key, status FROM memory_key_manifest WHERE status = 'planned' ORDER BY old_key`).all() as ManifestRow[];
  const landed = rows.filter((r) => !fs.existsSync(projectDir(home, r.old_key)) && fs.existsSync(projectDir(home, r.new_key)));
  if (landed.length === 0) return [];
  const at = new Date().toISOString();
  const settled: MemoryKeyMove[] = [];
  rs.transaction(() => {
    for (const row of landed) {
      const changed = rs.db.run(
        `UPDATE memory_key_manifest SET status = 'moved', moved_at = ? WHERE old_key = ? AND new_key = ? AND status = 'planned'`,
        [at, row.old_key, row.new_key],
      ).changes;
      // The record follows the directory here too. Without it the manifest would say `moved` while
      // the record still named the old key, and a later rollback would move the tree back under a
      // key its own record had already stopped agreeing with.
      if (changed > 0) {
        records.rekeyMemoryProjectKey(row.old_key, row.new_key);
        settled.push({ oldKey: row.old_key, newKey: row.new_key });
      }
    }
  }, { mode: "immediate" });
  return settled;
}

/**
 * The `old_key -> new_key` map of every relocation this home has actually performed.
 *
 * THE LIVE PATH'S HALF OF P8b-17. `agent/memory-dir.ts` is keyed by cwd and derives today's key; a
 * migrated project's tree is not there any more. This is the door that says where it went — read
 * from the same rows the re-key was committed with, so the answer is the record's own key by
 * construction, and a rollback (which sets `rolled-back`) removes it from this map in the same
 * transaction that puts the tree back.
 */
export function memoryKeyRelocations(rs: RuntimeStateDb): Map<string, string> {
  const rows = rs.db.query(`SELECT old_key, new_key FROM memory_key_manifest WHERE status = 'moved'`).all() as Array<{ old_key: string; new_key: string }>;
  return new Map(rows.map((r) => [r.old_key, r.new_key]));
}

/**
 * Perform the plan's moves. Refuses outright — before touching a single directory — when the plan
 * carries any collision, so a partially-applied ambiguous migration is not a state that exists.
 *
 * The rename and the manifest row are two different stores and cannot share a transaction, so the
 * rename goes FIRST and the row is committed after. The other order would leave a `moved` row for a
 * directory that never went anywhere, and rollback would then chase a tree that was never there.
 *
 * A crash in that window leaves the directory moved with its row still `planned`, and it is
 * `planMemoryKeyMigration` — not this function — that repairs it: a resumed run always re-plans
 * first, and by then the source directory is gone, so the pair never reaches this loop at all. See
 * the reconciliation branch there.
 *
 * Re-passing the SAME in-memory plan is handled by the pre-check instead: a pair whose row already
 * reads `moved` is skipped as done, and any other stale state refuses before a rename can happen.
 */
export function applyMemoryKeyMigration(deps: { rs: RuntimeStateDb; home: string; fs?: MemoryKeyFs }, plan: MemoryKeyPlan): { moved: number } {
  if (plan.collisions.length > 0) throw new MemoryKeyCollisionError(plan.collisions);
  const { rs, home } = deps;
  const fs = deps.fs ?? NODE_FS;
  // Constructed from the handle we already hold rather than taken as a dependency: `runtime_sessions`
  // belongs to `RuntimeSessionRecords`, so the record-side write goes through its owner instead of a
  // raw UPDATE from a migration, and the pinned `{ rs, home }` signature is left alone.
  const records = new RuntimeSessionRecords(rs);
  // EVERY row is checked before ANY rename, mirroring the collision refusal directly above: a
  // half-applied stale plan is not a state that should exist, and the check is what stops a rename
  // from happening with no manifest row to record it. See `MemoryKeyNotPlannedError`.
  //
  // A row already `moved` TO THE SAME DESTINATION is not a refusal — it is work this plan already
  // did. A collision thrown mid-loop leaves exactly that shape behind, and the operator who clears
  // the obstruction and re-runs must be told what is STILL wrong rather than handed a complaint
  // about the move that succeeded. Anything else — another status, or a row naming a different
  // destination — is a stale or forged plan and still refuses.
  const alreadyDone = new Set<string>();
  for (const move of plan.moves) {
    const row = manifestRow(rs, move.oldKey);
    if (row === undefined) throw new MemoryKeyNotPlannedError(move.oldKey, move.newKey, undefined);
    if (row.new_key !== move.newKey) throw new MemoryKeyNotPlannedError(move.oldKey, move.newKey, row.status, row.new_key);
    if (row.status === "moved") {
      alreadyDone.add(move.oldKey);
      continue;
    }
    if (row.status !== "planned") throw new MemoryKeyNotPlannedError(move.oldKey, move.newKey, row.status, row.new_key);
  }
  let moved = 0;
  for (const move of plan.moves) {
    if (alreadyDone.has(move.oldKey)) continue; // idempotent: this pair is already recorded as moved
    const source = projectDir(home, move.oldKey);
    const target = projectDir(home, move.newKey);
    if (fs.existsSync(source)) {
      // Re-checked under the same call rather than trusted from plan time: `rename` onto an
      // existing directory is the one outcome that could destroy memory.
      if (fs.existsSync(target)) throw new MemoryKeyCollisionError([{ newKey: move.newKey, oldKeys: [move.oldKey], reason: "target-exists" }]);
      // THE WHOLE PROJECT DIRECTORY, in one rename: `memory/` and every compatibility-layout sibling
      // (`<uuid>.jsonl`, `subagents/`, `tool-results/`, `workflows/scripts/`) relink together, and
      // atomically — precondition 4. A `memory/`-only move would split one project across two keys.
      fs.renameSync(source, target);
    } else if (!fs.existsSync(target)) {
      continue; // Nothing at either end: nothing to record.
    }
    // ONE TRANSACTION for the manifest row AND every record that named the old key: the directory
    // has already moved, so a commit that landed only half of this would leave records pointing at a
    // path that no longer exists (a memory read would then find nothing, silently) or a manifest
    // that disagrees with the records about where the tree went.
    //
    // `.changes`, not an unconditional increment: the count reported is the number of manifest rows
    // that actually transitioned, so a row someone else already settled is not counted twice.
    moved += rs.transaction(() => {
      const changed = rs.db.run(
        `UPDATE memory_key_manifest SET status = 'moved', moved_at = ? WHERE old_key = ? AND new_key = ? AND status = 'planned'`,
        [new Date().toISOString(), move.oldKey, move.newKey],
      ).changes;
      if (changed > 0) records.rekeyMemoryProjectKey(move.oldKey, move.newKey);
      return changed;
    }, { mode: "immediate" });
  }
  return { moved };
}

/**
 * Put every applied move back. Byte-identical by construction: a rename moves the tree, it does not
 * copy or rewrite it, so what comes back is the same inodes with the same contents.
 *
 * Tolerant in the same direction `apply` is: a row whose new directory is already gone and whose old
 * directory is already present has been rolled back by hand, and is recorded rather than re-fought.
 *
 * NEVER THROWS PART-WAY. A tree whose old location has been re-occupied is reported in `failures`
 * and left completely alone — every other tree is still restored. Throwing mid-loop would leave some
 * trees back and some forward with nothing saying which.
 */
export function rollbackMemoryKeyMigration(deps: { rs: RuntimeStateDb; home: string; fs?: MemoryKeyFs }): { rolledBack: number; failures: MemoryKeyRollbackFailure[] } {
  const { rs, home } = deps;
  const fs = deps.fs ?? NODE_FS;
  const records = new RuntimeSessionRecords(rs);
  const rows = rs.db.query(`SELECT old_key, new_key, status FROM memory_key_manifest WHERE status = 'moved' ORDER BY old_key`).all() as ManifestRow[];
  const failures: MemoryKeyRollbackFailure[] = [];
  let rolledBack = 0;
  for (const row of rows) {
    const source = projectDir(home, row.new_key);
    const target = projectDir(home, row.old_key);
    if (fs.existsSync(source)) {
      // A rollback is an undo under pressure. One blocked tree must not deny every other tree its
      // restore — and it must not throw halfway through either, which would leave some trees back
      // and some forward with no report of which. So it is COLLECTED, and this row is left entirely
      // alone: directory, record and manifest all stay `moved`, ready to retry once the obstruction
      // is cleared. (`apply` refuses up front instead, because a move can still be declined; by the
      // time rollback runs the trees have already been moved.)
      if (fs.existsSync(target)) {
        failures.push({ oldKey: row.old_key, newKey: row.new_key, reason: "target-exists" });
        continue;
      }
      fs.renameSync(source, target);
    } else if (!fs.existsSync(target)) {
      continue;
    }
    rs.transaction(() => {
      rs.db.run(`UPDATE memory_key_manifest SET status = 'rolled-back' WHERE old_key = ? AND status = 'moved'`, [row.old_key]);
      // Back to the old key, in the same transaction and for the same reason `apply` re-keys forward.
      records.rekeyMemoryProjectKey(row.new_key, row.old_key);
    }, { mode: "immediate" });
    rolledBack += 1;
  }
  return { rolledBack, failures };
}
