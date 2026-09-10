// WS-16 §17's Migration A, phase 5: move each project's memory directory from TODAY's key to the
// compatibility key, through a manifest that can undo it.
//
// TWO KEY ALGORITHMS, ONE DIRECTORY. Today a project's memory lives at
// `<home>/projects/<sanitizeProjectKey(repoRootFor(cwd))>/memory` (`agent/memory-dir.ts`); the
// compatibility layout keys off `transcriptProjectKey(cwd)` (WS-05 §3.1). Task 9 already recorded
// BOTH for every session — `memoryProjectKey` is where the memory is, `transcriptProjectKey` is
// where it must end up — so this phase reads the mapping out of the records rather than re-deriving
// it, and the two can never drift apart between the phases.
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
//   old-key-fans-out  one directory has two destinations. Today's key is the REPO ROOT's and the
//                     compatibility key is the CWD's, so two sessions in one repo at different cwds
//                     produce exactly this; picking either destination loses the other's memory.
//   target-exists     the destination directory is already occupied by something else.
//
// A refusal costs a re-run. Guessing costs somebody's notes.
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeStateDb } from "../db";
import type { RuntimeSessionRecords } from "../records";

/** The buckets that are NOT a project and are never migrated: `_global` (facts that map to no
 *  project) and `_assistant` (the Dreaming bucket). `sanitizeProjectKey` cannot emit a leading
 *  underscore, so neither can ever be a real project's key — the guard is explicit anyway, because
 *  a migration that renamed one of these would silently detach memory from the only code that
 *  reads it. */
export const RESERVED_PROJECT_KEYS: readonly string[] = Object.freeze(["_global", "_assistant"]);

export type MemoryKeyCollisionReason = "many-old-keys" | "old-key-fans-out" | "target-exists";

export interface MemoryKeyMove {
  oldKey: string;
  newKey: string;
  /** Absent here by construction: a `RuntimeSessionRecord` carries project KEYS, never the cwd they
   *  were derived from. Kept on the shape because the plan's consumer (an operator-facing report)
   *  may be handed one from elsewhere. */
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

interface ManifestRow { old_key: string; new_key: string; status: string }

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
export function planMemoryKeyMigration(deps: { rs: RuntimeStateDb; home: string; records: RuntimeSessionRecords }): MemoryKeyPlan {
  const { rs, home } = deps;
  const plan: MemoryKeyPlan = { moves: [], collisions: [], preserved: [...RESERVED_PROJECT_KEYS], unreferenced: [] };

  // The distinct (oldKey → newKey) pairs the records ask for, in a stable order.
  const wanted = new Map<string, Set<string>>();
  const referenced = new Set<string>();
  for (const record of deps.records.list()) {
    referenced.add(record.memoryProjectKey);
    referenced.add(record.transcriptProjectKey);
    const oldKey = record.memoryProjectKey;
    if (RESERVED_PROJECT_KEYS.includes(oldKey) || oldKey === record.transcriptProjectKey) continue;
    (wanted.get(oldKey) ?? wanted.set(oldKey, new Set()).get(oldKey)!).add(record.transcriptProjectKey);
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
    const sourceExists = existsSync(projectDir(home, oldKey));
    const targetExists = existsSync(projectDir(home, newKey));
    // Source gone AND target present is not a conflict — it is a move this migration already made
    // (or one an operator made by hand). Neither a move nor a collision: there is nothing to do.
    if (!sourceExists) continue;
    if (targetExists) {
      plan.collisions.push({ newKey, oldKeys: [oldKey], reason: "target-exists" });
      continue;
    }
    plan.moves.push({ oldKey, newKey });
  }
  plan.moves.sort((a, b) => a.oldKey.localeCompare(b.oldKey));

  if (existsSync(projectsDir(home))) {
    plan.unreferenced = readdirSync(projectsDir(home), { withFileTypes: true })
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
 * Perform the plan's moves. Refuses outright — before touching a single directory — when the plan
 * carries any collision, so a partially-applied ambiguous migration is not a state that exists.
 *
 * The rename and the manifest row are two different stores and cannot share a transaction, so the
 * rename goes FIRST and the row is committed after: a crash in between leaves the directory moved
 * and the row still `planned`, which the idempotent re-run below resolves (source gone, target
 * present → the move already happened, mark it). The other order would leave a `moved` row for a
 * directory that never went anywhere, and rollback would then chase a tree that was never there.
 */
export function applyMemoryKeyMigration(deps: { rs: RuntimeStateDb; home: string }, plan: MemoryKeyPlan): { moved: number } {
  if (plan.collisions.length > 0) throw new MemoryKeyCollisionError(plan.collisions);
  const { rs, home } = deps;
  let moved = 0;
  for (const move of plan.moves) {
    const source = projectDir(home, move.oldKey);
    const target = projectDir(home, move.newKey);
    if (existsSync(source)) {
      // Re-checked under the same call rather than trusted from plan time: `rename` onto an
      // existing directory is the one outcome that could destroy memory.
      if (existsSync(target)) throw new MemoryKeyCollisionError([{ newKey: move.newKey, oldKeys: [move.oldKey], reason: "target-exists" }]);
      renameSync(source, target);
    } else if (!existsSync(target)) {
      continue; // Nothing at either end: nothing to record.
    }
    rs.transaction(() => {
      rs.db.run(`UPDATE memory_key_manifest SET status = 'moved', moved_at = ? WHERE old_key = ? AND status = 'planned'`,
        [new Date().toISOString(), move.oldKey]);
    }, { mode: "immediate" });
    moved += 1;
  }
  return { moved };
}

/**
 * Put every applied move back. Byte-identical by construction: a rename moves the tree, it does not
 * copy or rewrite it, so what comes back is the same inodes with the same contents.
 *
 * Tolerant in the same direction `apply` is: a row whose new directory is already gone and whose old
 * directory is already present has been rolled back by hand, and is recorded rather than re-fought.
 */
export function rollbackMemoryKeyMigration(deps: { rs: RuntimeStateDb; home: string }): { rolledBack: number } {
  const { rs, home } = deps;
  const rows = rs.db.query(`SELECT old_key, new_key, status FROM memory_key_manifest WHERE status = 'moved' ORDER BY old_key`).all() as ManifestRow[];
  let rolledBack = 0;
  for (const row of rows) {
    const source = projectDir(home, row.new_key);
    const target = projectDir(home, row.old_key);
    if (existsSync(source)) {
      if (existsSync(target)) throw new MemoryKeyCollisionError([{ newKey: row.old_key, oldKeys: [row.new_key], reason: "target-exists" }]);
      renameSync(source, target);
    } else if (!existsSync(target)) {
      continue;
    }
    rs.transaction(() => {
      rs.db.run(`UPDATE memory_key_manifest SET status = 'rolled-back' WHERE old_key = ? AND status = 'moved'`, [row.old_key]);
    }, { mode: "immediate" });
    rolledBack += 1;
  }
  return { rolledBack };
}
