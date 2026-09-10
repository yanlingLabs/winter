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
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "../../sessions/store";
import type { RuntimeStateDb } from "../db";
import { RuntimeSessionRecords } from "../records";

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
  /** Records whose session cwd could not be read (the record outlived its product session), so no
   *  destination could be derived. Skipped rather than guessed at — a wrong destination here would
   *  move somebody's memory somewhere nothing looks. */
  unresolved: string[];
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
export function planMemoryKeyMigration(deps: { rs: RuntimeStateDb; home: string; records: RuntimeSessionRecords; store: SessionStore }): MemoryKeyPlan {
  const { rs, home, store } = deps;
  const plan: MemoryKeyPlan = { moves: [], collisions: [], preserved: [...RESERVED_PROJECT_KEYS], unreferenced: [], unchanged: [], unresolved: [] };

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
      plan.unresolved.push(record.winterSessionId);
      continue;
    }
    const newKey = compatibilityKeys(cwd).memoryProjectKey;
    referenced.add(newKey);
    if (oldKey === newKey) {
      if (!plan.unchanged.includes(oldKey)) plan.unchanged.push(oldKey);
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

  // Rows whose rename landed but whose manifest commit did not — see `reconcile` below.
  const reconcile: MemoryKeyMove[] = [];

  for (const [newKey, oldKeys] of byNewKey) {
    if (oldKeys.length > 1) continue;
    const oldKey = oldKeys[0]!;
    const sourceExists = existsSync(projectDir(home, oldKey));
    const targetExists = existsSync(projectDir(home, newKey));
    // Source gone AND target present is not a conflict — the tree is already where it belongs. It
    // is, however, the TORN-APPLY WINDOW: `apply` renames and then commits, so a crash between the
    // two leaves exactly this shape with the manifest row still `planned`. Left alone, that row
    // would stay `planned` forever — `rollback` only reads `moved`, so the tree would have no
    // recorded way back, which is the one state this manifest exists to prevent. So the row is
    // reconciled here instead: the rename landed, and the manifest is made to say so.
    if (!sourceExists) {
      if (targetExists) reconcile.push({ oldKey, newKey });
      continue;
    }
    if (targetExists) {
      plan.collisions.push({ newKey, oldKeys: [oldKey], reason: "target-exists" });
      continue;
    }
    const cwd = cwdFor.get(`${oldKey}\u0000${newKey}`);
    plan.moves.push({ oldKey, newKey, ...(cwd === undefined ? {} : { cwd }) });
  }
  plan.moves.sort((a, b) => a.oldKey.localeCompare(b.oldKey));
  plan.unchanged.sort();

  if (existsSync(projectsDir(home))) {
    plan.unreferenced = readdirSync(projectsDir(home), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !RESERVED_PROJECT_KEYS.includes(e.name) && !referenced.has(e.name))
      .map((e) => e.name)
      .sort();
  }

  const at = new Date().toISOString();
  const records = deps.records;
  rs.transaction(() => {
    for (const move of plan.moves) {
      rs.db.run(
        `INSERT INTO memory_key_manifest (old_key, new_key, status, planned_at, moved_at) VALUES (?, ?, 'planned', ?, NULL)
         ON CONFLICT(old_key) DO UPDATE SET new_key = excluded.new_key, status = 'planned', planned_at = excluded.planned_at, moved_at = NULL
         WHERE memory_key_manifest.status <> 'moved'`,
        [move.oldKey, move.newKey, at],
      );
    }
    // Keyed on `new_key` as well: a row is only reconciled when the manifest agrees about WHERE the
    // tree went. A `planned` row naming some other destination is a different, unresolved move, and
    // marking it `moved` would send a later rollback after the wrong directory.
    for (const move of reconcile) {
      const changed = rs.db.run(
        `UPDATE memory_key_manifest SET status = 'moved', moved_at = ? WHERE old_key = ? AND new_key = ? AND status = 'planned'`,
        [at, move.oldKey, move.newKey],
      ).changes;
      // The record follows the directory here too. Without it the manifest would say `moved` while
      // the record still named the old key, and a later rollback would move the tree back under a
      // key its own record had already stopped agreeing with.
      if (changed > 0) records.rekeyMemoryProjectKey(move.oldKey, move.newKey);
    }
  }, { mode: "immediate" });

  return plan;
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
 * the reconciliation branch there. The tolerant `else if (!existsSync(target))` below covers only
 * the narrower case of re-passing the SAME in-memory plan twice.
 */
export function applyMemoryKeyMigration(deps: { rs: RuntimeStateDb; home: string }, plan: MemoryKeyPlan): { moved: number } {
  if (plan.collisions.length > 0) throw new MemoryKeyCollisionError(plan.collisions);
  const { rs, home } = deps;
  // Constructed from the handle we already hold rather than taken as a dependency: `runtime_sessions`
  // belongs to `RuntimeSessionRecords`, so the record-side write goes through its owner instead of a
  // raw UPDATE from a migration, and the pinned `{ rs, home }` signature is left alone.
  const records = new RuntimeSessionRecords(rs);
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
 */
export function rollbackMemoryKeyMigration(deps: { rs: RuntimeStateDb; home: string }): { rolledBack: number } {
  const { rs, home } = deps;
  const records = new RuntimeSessionRecords(rs);
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
      // Back to the old key, in the same transaction and for the same reason `apply` re-keys forward.
      records.rekeyMemoryProjectKey(row.new_key, row.old_key);
    }, { mode: "immediate" });
    rolledBack += 1;
  }
  return { rolledBack };
}
