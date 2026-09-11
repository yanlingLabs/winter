import { describe, expect, test } from "bun:test";
import { TRANSCRIPT_PROJECT_KEY_MAX_LENGTH, compatibilityKeys, isVendorCompliantProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { memoryDirFor, memoryDirForRecord, repoRootFor, sanitizeProjectKey, _clearRepoRootCacheForTests } from "../../src/agent/memory-dir";
import {
  MemoryKeyCollisionError, MemoryKeyNotPlannedError, RuntimeSessionRecords, applyMemoryKeyMigration,
  backfillNativeSessions, memoryKeyRelocations, openRuntimeStateDb, planMemoryKeyMigration, rollbackMemoryKeyMigration,
  type MemoryKeyFs, type RuntimeStateDb,
} from "../../src/runtime-state";
import { SessionStore } from "../../src/sessions/store";
import { withTempHome } from "./support";

/** Today's memory key for a cwd — the exact composition `agent/memory-dir.ts`'s `memoryDirFor` uses. */
const oldKeyFor = (cwd: string): string => sanitizeProjectKey(repoRootFor(cwd));
/** The compatibility memory key — the SDK's own, and root-based like today's, so the mapping is
 *  one-to-one per repo root by construction. */
const newKeyFor = (cwd: string): string => compatibilityKeys(cwd).memoryProjectKey;

/** A real git repo, so two cwds inside it share ONE repo root — the shape the whole one-to-one
 *  safety argument rests on, and the only way to reproduce it faithfully. */
function gitRepo(home: string, name: string): string {
  const root = join(home, "repos", name);
  mkdirSync(root, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", root]);
  return root;
}

function workdir(home: string, name: string): string {
  const dir = join(home, "work", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Seed the memory tree today's algorithm would have written for `cwd`. */
function seedMemory(home: string, cwd: string, body: string): string {
  const key = oldKeyFor(cwd);
  const dir = join(home, "projects", key, "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), body);
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "one.md"), `${body} — note`);
  return key;
}

/** A session with a cwd and a memory tree already written under today's key. */
function seedProject(home: string, store: SessionStore, name: string, body: string): { sessionId: string; cwd: string; oldKey: string; newKey: string } {
  const cwd = workdir(home, name);
  const sessionId = store.createSession("work", { cwd });
  return { sessionId, cwd, oldKey: seedMemory(home, cwd, body), newKey: newKeyFor(cwd) };
}

/** Every file under `root`, as `relative path -> contents`. The byte-identity witness for rollback. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function manifest(rs: RuntimeStateDb): Array<{ old_key: string; new_key: string; status: string }> {
  return rs.db.query("SELECT old_key, new_key, status FROM memory_key_manifest ORDER BY old_key").all() as
    Array<{ old_key: string; new_key: string; status: string }>;
}

/**
 * Force a record's stored memory key to something the key algorithms would never have produced for
 * its cwd.
 *
 * THE COLLISION CASES CANNOT ARISE FROM REAL INPUTS, and that is the point of the controller's
 * ruling: today's key and the compatibility key are BOTH derived from the repo root, so two records
 * sharing an old key necessarily share a root and therefore resolve to one new key. The guards below
 * must never fire in production — so the only way to test them is to corrupt the mapping by hand,
 * which is exactly what this does.
 */
function forceMemoryKey(rs: RuntimeStateDb, winterSessionId: string, key: string): void {
  rs.db.run("UPDATE runtime_sessions SET memory_project_key = ? WHERE winter_session_id = ?", [key, winterSessionId]);
}

describe("planMemoryKeyMigration", () => {
  test("plans one move per record whose keys differ, preserves the reserved buckets and reports the rest", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const b = seedProject(home, store, "b", "beta");
      mkdirSync(join(home, "projects", "_assistant", "memory"), { recursive: true });
      writeFileSync(join(home, "projects", "_assistant", "memory", "MEMORY.md"), "dreams");
      mkdirSync(join(home, "projects", "stray-project", "memory"), { recursive: true });

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });

        expect(plan.collisions).toEqual([]);
        expect(plan.moves.map((m) => m.oldKey).sort()).toEqual([a.oldKey, b.oldKey].sort());
        expect(plan.moves.find((m) => m.oldKey === a.oldKey)!.newKey).toBe(a.newKey);
        expect(plan.moves.find((m) => m.oldKey === b.oldKey)!.newKey).toBe(b.newKey);
        // The cwd each pair was derived from now rides along — it is the input to the new key.
        expect(plan.moves.find((m) => m.oldKey === a.oldKey)!.cwd).toBe(a.cwd);
        // The two reserved buckets are policy, not an observation: they are never migrated.
        expect(plan.preserved).toEqual(["_global", "_assistant"]);
        expect(plan.moves.some((m) => m.oldKey === "_assistant" || m.newKey === "_assistant")).toBe(false);
        // A directory no record names is left alone — and said so, rather than silently ignored.
        expect(plan.unreferenced).toContain("stray-project");
        expect(plan.unreferenced).not.toContain("_assistant");
        expect(plan.unchanged).toEqual([]);
        expect(plan.unresolved).toEqual([]);

        expect(manifest(rs).map((r) => r.status)).toEqual(["planned", "planned"]);
      } finally {
        rs.close();
      }
    });
  });

  test("a record already on the compatibility key is a no-op, reported as unchanged", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        // Exactly the state a completed migration leaves behind.
        forceMemoryKey(rs, a.sessionId, a.newKey);

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves).toEqual([]);
        expect(plan.collisions).toEqual([]);
        expect(plan.unchanged).toEqual([a.newKey]);
        expect(manifest(rs)).toEqual([]);
      } finally {
        rs.close();
      }
    });
  });

  test("a project with no memory directory yet is not a move", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      store.createSession("work", { cwd: workdir(home, "never-remembered") });
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves).toEqual([]);
        expect(plan.collisions).toEqual([]);
        expect(manifest(rs)).toEqual([]);
      } finally {
        rs.close();
      }
    });
  });

  test("a record whose cwd no longer exists is unresolved, never a degraded per-cwd destination", async () => {
    // THE DEGRADATION (review r1, Important 1). The old key is read from the record and was computed
    // when the directory still existed, so it is root-derived. The NEW key is derived live — and the
    // SDK's `gitCommonRoot` returns null when `git -C <cwd>` fails, including when the cwd is simply
    // gone, at which point `compatibilityKeys` falls back to the CWD's OWN key. Two sessions in one
    // repo with one deleted cwd would then present one old key with two destinations: a fan-out that
    // refuses the entire migration, from ordinary inputs rather than corruption. Legacy sessions are
    // exactly the population whose cwds are most likely gone.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const root = gitRepo(home, "one-repo");
      const alive = join(root, "alive");
      const doomed = join(root, "doomed");
      mkdirSync(alive, { recursive: true });
      mkdirSync(doomed, { recursive: true });
      store.createSession("work", { cwd: alive });
      const gone = store.createSession("work", { cwd: doomed });
      // Both cwds are in one repo, so both records carry the SAME root-derived old key.
      const sharedOldKey = seedMemory(home, alive, "shared");
      expect(oldKeyFor(doomed)).toBe(sharedOldKey);

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        expect(records.get(gone)!.memoryProjectKey).toBe(sharedOldKey);

        rmSync(doomed, { recursive: true, force: true });
        _clearRepoRootCacheForTests();

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.collisions).toEqual([]);          // no fan-out from an ordinary input
        expect(plan.unresolved).toEqual([{ winterSessionId: gone, reason: "cwd-missing" }]);
        expect(plan.moves.length).toBe(1);
        expect(plan.moves[0]!.oldKey).toBe(sharedOldKey);
        expect(plan.moves[0]!.newKey).toBe(newKeyFor(alive));   // the ROOT key, not a per-cwd one
        expect(plan.moves[0]!.cwd).toBe(alive);
      } finally {
        rs.close();
      }
    });
  });

  test("a lone record whose cwd is gone is skipped rather than stranding the repo's memory", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const root = gitRepo(home, "lonely");
      const sub = join(root, "sub");
      mkdirSync(sub, { recursive: true });
      store.createSession("work", { cwd: sub });
      const oldKey = seedMemory(home, sub, "alpha");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        rmSync(sub, { recursive: true, force: true });
        _clearRepoRootCacheForTests();

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves).toEqual([]);
        expect(plan.unresolved.map((u) => u.reason)).toEqual(["cwd-missing"]);
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 0 });
        // The tree stays exactly where the live lookup will look for it once the cwd comes back.
        expect(existsSync(join(home, "projects", oldKey, "memory"))).toBe(true);
      } finally {
        rs.close();
      }
    });
  });

  test("a surviving cwd whose repo root no longer resolves the same way is unresolved", async () => {
    // STRONGER THAN "the directory exists" (coordinator follow-up 1). EVERY git failure makes both
    // `repoRootFor` and the SDK's `gitCommonRoot` fall back to the cwd itself — git not installed, a
    // dubious-ownership refusal, or (here) a `.git` removed under a directory that is still present.
    // The directory check cannot see any of those. Comparing today's root resolution against the key
    // the record actually stores can: if they disagree, the destination this run would derive is not
    // the one the memory was filed under, and the only safe move is not to move.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const root = gitRepo(home, "derooted");
      const sub = join(root, "sub");
      mkdirSync(sub, { recursive: true });
      const id = store.createSession("work", { cwd: sub });
      const oldKey = seedMemory(home, sub, "alpha");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        expect(records.get(id)!.memoryProjectKey).toBe(oldKey);

        // The directory survives; only its repo does not.
        rmSync(join(root, ".git"), { recursive: true, force: true });
        _clearRepoRootCacheForTests();
        expect(oldKeyFor(sub)).not.toBe(oldKey);   // today's resolution now lands on the cwd

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves).toEqual([]);
        expect(plan.collisions).toEqual([]);
        expect(plan.unresolved).toEqual([{ winterSessionId: id, reason: "root-disagrees" }]);
        expect(existsSync(join(home, "projects", oldKey, "memory"))).toBe(true);
      } finally {
        rs.close();
      }
    });
  });

  test("a record whose product session is gone is skipped and reported, never guessed at", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        store.deleteSession(a.sessionId); // record outlives its session: no cwd to key off

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves).toEqual([]);
        expect(plan.unresolved).toEqual([{ winterSessionId: a.sessionId, reason: "session-gone" }]);
        expect(existsSync(join(home, "projects", a.oldKey))).toBe(true);
      } finally {
        rs.close();
      }
    });
  });
});

describe("applyMemoryKeyMigration", () => {
  test("renames the trees, re-keys the records, marks the manifest moved, and leaves the reserved buckets alone", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const b = seedProject(home, store, "b", "beta");
      mkdirSync(join(home, "projects", "_assistant", "memory"), { recursive: true });
      writeFileSync(join(home, "projects", "_assistant", "memory", "MEMORY.md"), "dreams");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 2 });

        expect(existsSync(join(home, "projects", a.oldKey))).toBe(false);
        expect(existsSync(join(home, "projects", b.oldKey))).toBe(false);
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
        expect(readFileSync(join(home, "projects", b.newKey, "memory", "notes", "one.md"), "utf8")).toBe("beta — note");
        expect(readFileSync(join(home, "projects", "_assistant", "memory", "MEMORY.md"), "utf8")).toBe("dreams");
        expect(manifest(rs).map((r) => r.status)).toEqual(["moved", "moved"]);

        // The record must follow the directory — a record still naming the old key would point at a
        // path that no longer exists, and the next memory read would silently find nothing.
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);
        expect(records.get(b.sessionId)!.memoryProjectKey).toBe(b.newKey);
      } finally {
        rs.close();
      }
    });
  });

  test("rollback restores byte-identical trees, the records' old keys, and marks the manifest rolled-back", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const b = seedProject(home, store, "b", "beta");
      mkdirSync(join(home, "projects", "_assistant", "memory"), { recursive: true });
      writeFileSync(join(home, "projects", "_assistant", "memory", "MEMORY.md"), "dreams");
      const before = snapshotTree(join(home, "projects"));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));
        expect(snapshotTree(join(home, "projects"))).not.toEqual(before);

        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 2, failures: [] });
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(manifest(rs).map((r) => r.status)).toEqual(["rolled-back", "rolled-back"]);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
        expect(records.get(b.sessionId)!.memoryProjectKey).toBe(b.oldKey);
      } finally {
        rs.close();
      }
    });
  });

  test("a rollback with nothing moved is a no-op", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 0, failures: [] });
      } finally {
        rs.close();
      }
    });
  });

  test("a corrupted record is intercepted one at a time and never refuses a healthy sibling's move", async () => {
    // THE PLAN-LEVEL COLLISION GUARDS ARE NOW UNREACHABLE, and that is an improvement rather than a
    // gap. Both `many-old-keys` and `old-key-fans-out` can only arise from a record whose stored key
    // disagrees with its own derivation — and follow-up 1's precondition catches exactly that,
    // EARLIER and BETTER: the bad record alone is reported `root-disagrees` and skipped, instead of
    // one corrupt row refusing every other project's migration. The guards stay in `plan` as defence
    // in depth (they matter again the moment the precondition is weakened), and
    // `MemoryKeyCollisionError` still fires for real on `target-exists` — see the next test.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const b = seedProject(home, store, "b", "beta");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        // The `many-old-keys` shape: b's stored key no longer describes where its memory was filed.
        forceMemoryKey(rs, b.sessionId, "impostor-old");

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.collisions).toEqual([]);
        expect(plan.unresolved).toEqual([{ winterSessionId: b.sessionId, reason: "root-disagrees" }]);
        expect(plan.moves.map((m) => m.oldKey)).toEqual([a.oldKey]);

        // The healthy project migrates; the corrupt one is left exactly as it was found.
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1 });
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
        expect(readFileSync(join(home, "projects", b.oldKey, "memory", "MEMORY.md"), "utf8")).toBe("beta");
        expect(records.get(b.sessionId)!.memoryProjectKey).toBe("impostor-old");
      } finally {
        rs.close();
      }
    });
  });

  test("the fan-out shape is intercepted by the same precondition, not by the fan-out guard", async () => {
    // Two cwds with different destinations forced to share one stored old key — the shape that made
    // the pre-ruling cwd-based destination refuse whole migrations. Both records now fail the
    // derivation check individually: one because its key was overwritten, the other because that
    // same key is not what its own root produces.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const b = seedProject(home, store, "b", "beta");
      expect(a.newKey).not.toBe(b.newKey);

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        forceMemoryKey(rs, b.sessionId, a.oldKey);
        const before = snapshotTree(join(home, "projects"));

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.collisions).toEqual([]);
        expect(plan.unresolved).toEqual([{ winterSessionId: b.sessionId, reason: "root-disagrees" }]);
        // a is untouched by b's corruption and still migrates on its own terms.
        expect(plan.moves.map((m) => m.oldKey)).toEqual([a.oldKey]);
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
      } finally {
        rs.close();
      }
    });
  });

  test("a destination directory that already exists is refused, never renamed onto", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      mkdirSync(join(home, "projects", a.newKey, "memory"), { recursive: true });
      writeFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "someone else's");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const before = snapshotTree(join(home, "projects"));

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.collisions.map((c) => c.reason)).toEqual(["target-exists"]);
        expect(plan.moves).toEqual([]);
        expect(() => applyMemoryKeyMigration({ rs, home }, plan)).toThrow(MemoryKeyCollisionError);
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
      } finally {
        rs.close();
      }
    });
  });

  test("re-planning after an applied migration finds nothing left to do and never resets the manifest", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));
        expect(manifest(rs).map((r) => r.status)).toEqual(["moved"]);

        const again = planMemoryKeyMigration({ rs, home, records, store });
        expect(again.moves).toEqual([]);
        expect(again.collisions).toEqual([]);
        // The record was re-keyed by apply, so this is now simply "already where it belongs".
        expect(again.unchanged).toEqual([a.newKey]);
        expect(again.unreferenced).toEqual([]);
        expect(manifest(rs).map((r) => r.status)).toEqual(["moved"]);
      } finally {
        rs.close();
      }
    });
  });

  test("a rename that landed without its manifest commit is reconciled by the next plan", async () => {
    // THE TORN-APPLY WINDOW. `apply` renames the tree and then commits the manifest row (and the
    // record's key) together; a crash between leaves a directory at the NEW key with its row still
    // `planned`. The next run starts with `plan`, which sees no source directory — so unless `plan`
    // reconciles, the row stays `planned` forever, `rollback` (which reads `status = 'moved'`) never
    // sees it, and the tree has no recorded way back.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const before = snapshotTree(join(home, "projects"));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves.length).toBe(1);
        expect(manifest(rs).map((r) => r.status)).toEqual(["planned"]);

        // The crash: the rename landed, the commit did not (so the record still names the old key).
        renameSync(join(home, "projects", a.oldKey), join(home, "projects", a.newKey));

        const resumed = planMemoryKeyMigration({ rs, home, records, store });
        expect(resumed.moves).toEqual([]);
        expect(resumed.collisions).toEqual([]);
        expect(manifest(rs).map((r) => r.status)).toEqual(["moved"]);
        // Reconciliation carries the record across too, or a rolled-back tree and its record would
        // disagree about where the memory is.
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);

        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 1, failures: [] });
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
      } finally {
        rs.close();
      }
    });
  });

  test("re-applying a plan whose manifest row is no longer planned is refused before anything moves", async () => {
    // REVIEW r1, IMPORTANT 2. `apply` used to rename first and only then look for a `planned` row.
    // After plan → apply → rollback the row reads `rolled-back`, so a second `apply` with the same
    // plan object moved the tree forward, matched no row, left the records on the old key and
    // reported `{moved: 0}` — a moved tree with no recorded way back, and nothing reporting it.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        applyMemoryKeyMigration({ rs, home }, plan);
        rollbackMemoryKeyMigration({ rs, home });
        const before = snapshotTree(join(home, "projects"));

        expect(() => applyMemoryKeyMigration({ rs, home }, plan)).toThrow(MemoryKeyNotPlannedError);
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(existsSync(join(home, "projects", a.oldKey))).toBe(true);
        expect(existsSync(join(home, "projects", a.newKey))).toBe(false);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
        expect(manifest(rs).map((r) => r.status)).toEqual(["rolled-back"]);
      } finally {
        rs.close();
      }
    });
  });

  test("a refusal names the status and destination the manifest actually holds", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        planMemoryKeyMigration({ rs, home, records, store });

        // A plan whose destination disagrees with the planned row: "not in the manifest at all"
        // would be a lie — the row is right there, pointing somewhere else.
        const forged = { moves: [{ oldKey: a.oldKey, newKey: "somewhere-else" }], collisions: [], preserved: [], unreferenced: [], unchanged: [], unresolved: [] };
        let caught: unknown;
        try { applyMemoryKeyMigration({ rs, home }, forged); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(MemoryKeyNotPlannedError);
        expect((caught as MemoryKeyNotPlannedError).status).toBe("planned");
        expect((caught as MemoryKeyNotPlannedError).recordedNewKey).toBe(a.newKey);
        expect((caught as Error).message).toContain(a.newKey);
        expect((caught as Error).message).not.toContain("not in the manifest at all");
      } finally {
        rs.close();
      }
    });
  });

  test("a hand-built plan with no manifest row behind it is refused the same way", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const before = snapshotTree(join(home, "projects"));
        // Both the type and the function are exported, so this is a reachable call shape.
        const forged = { moves: [{ oldKey: a.oldKey, newKey: a.newKey }], collisions: [], preserved: [], unreferenced: [], unchanged: [], unresolved: [] };
        expect(() => applyMemoryKeyMigration({ rs, home }, forged)).toThrow(MemoryKeyNotPlannedError);
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(manifest(rs)).toEqual([]);
      } finally {
        rs.close();
      }
    });
  });

  test("a rollback blocked on one tree still restores the others and reports the failure", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const b = seedProject(home, store, "b", "beta");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));

        // Something has re-occupied one of the old keys — rolling that tree back would overwrite it.
        mkdirSync(join(home, "projects", a.oldKey, "memory"), { recursive: true });
        writeFileSync(join(home, "projects", a.oldKey, "memory", "MEMORY.md"), "someone else's");

        // A rollback is an undo under pressure: one blocked tree must not deny every other tree its
        // restore, and the blockage must be reported rather than thrown mid-loop after half the
        // renames already happened.
        const result = rollbackMemoryKeyMigration({ rs, home });
        expect(result.rolledBack).toBe(1);
        expect(result.failures.length).toBe(1);
        expect(result.failures[0]!.oldKey).toBe(a.oldKey);
        expect(result.failures[0]!.reason).toBe("target-exists");

        expect(readFileSync(join(home, "projects", b.oldKey, "memory", "MEMORY.md"), "utf8")).toBe("beta");
        expect(records.get(b.sessionId)!.memoryProjectKey).toBe(b.oldKey);
        // The blocked one is untouched in every store: tree, record and manifest all still `moved`.
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);
        expect(manifest(rs).find((r) => r.old_key === a.oldKey)!.status).toBe("moved");
      } finally {
        rs.close();
      }
    });
  });

  test("a retry after a mid-apply collision reports the collision, not the already-moved row", async () => {
    // A collision thrown mid-loop leaves earlier moves applied. The operator clears the obstruction
    // and re-runs the same plan — and must be told what is still wrong, not handed a refusal about
    // the row that already succeeded. A `moved` row for the SAME pair is work already done, so it is
    // skipped; only a row in another state, or one naming a different destination, refuses.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const b = seedProject(home, store, "b", "beta");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves.map((m) => m.oldKey)).toEqual([a.oldKey, b.oldKey]);

        // Something occupies b's destination between plan and apply: a moves, then b refuses.
        mkdirSync(join(home, "projects", b.newKey, "memory"), { recursive: true });
        expect(() => applyMemoryKeyMigration({ rs, home }, plan)).toThrow(MemoryKeyCollisionError);
        expect(manifest(rs).find((r) => r.old_key === a.oldKey)!.status).toBe("moved");
        expect(manifest(rs).find((r) => r.old_key === b.oldKey)!.status).toBe("planned");

        // The retry names the ACTIONABLE problem — b's occupied destination — rather than a's
        // already-`moved` row.
        let caught: unknown;
        try { applyMemoryKeyMigration({ rs, home }, plan); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(MemoryKeyCollisionError);
        expect((caught as MemoryKeyCollisionError).collisions[0]!.oldKeys).toEqual([b.oldKey]);

        // Obstruction cleared: the retry finishes the job and does not redo a's move.
        rmSync(join(home, "projects", b.newKey), { recursive: true, force: true });
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1 });
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
        expect(readFileSync(join(home, "projects", b.newKey, "memory", "MEMORY.md"), "utf8")).toBe("beta");
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);
        expect(records.get(b.sessionId)!.memoryProjectKey).toBe(b.newKey);
      } finally {
        rs.close();
      }
    });
  });

  test("a rolled-back migration can be planned and applied again", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));
        rollbackMemoryKeyMigration({ rs, home });
        expect(manifest(rs).map((r) => r.status)).toEqual(["rolled-back"]);

        const second = planMemoryKeyMigration({ rs, home, records, store });
        expect(second.moves.length).toBe(1);
        expect(manifest(rs).map((r) => r.status)).toEqual(["planned"]);
        expect(applyMemoryKeyMigration({ rs, home }, second)).toEqual({ moved: 1 });
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);
      } finally {
        rs.close();
      }
    });
  });

  test("nothing but the memory key changes on a migrated record", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const before = records.get(a.sessionId)!;
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));
        const after = records.get(a.sessionId)!;

        expect(after.memoryProjectKey).toBe(a.newKey);
        // The row was written, so its `updatedAt` moved — that is the record saying so, not drift.
        expect(after.updatedAt >= before.updatedAt).toBe(true);
        // The transcript and temp keys are a different layout with a different algorithm; this
        // migration moves the memory tree and nothing else.
        const blank = { memoryProjectKey: "", updatedAt: "" };
        expect({ ...after, ...blank }).toEqual({ ...before, ...blank });
      } finally {
        rs.close();
      }
    });
  });
});

// ── P8b-17: the four preconditions that let the flag run at all ──────────────────────────────────
// 8a shipped this migration REFUSED because the live memory path still derived today's key. Each
// test below pins one of the four conditions the controller's ruling attaches to turning it on.
describe("memory-key migration — P8b-17's preconditions", () => {
  /** A root whose SANITIZED path overflows the SDK's 64-character cap, so the destination this run
   *  derives is the hashed form rather than the path itself — the band where 0.0.2 and 0.0.3
   *  disagree, and the only band where "regenerate the manifest against the 64-char key" means
   *  anything. */
  const OVERFLOWING = "a-project-with-a-very-long-directory-name-that-overflows-the-vendor-key-cap";

  /** The compatibility-layout siblings a project directory carries besides `memory/` (surface map
   *  §6.6): transcripts, subagent transcripts, tool results, workflow scripts. */
  function seedProjectTreeSiblings(home: string, key: string): void {
    const dir = join(home, "projects", key);
    writeFileSync(join(dir, "3f2a1c00-0000-4000-8000-000000000000.jsonl"), "{\"type\":\"user\"}\n");
    mkdirSync(join(dir, "subagents"), { recursive: true });
    writeFileSync(join(dir, "subagents", "agent-1.jsonl"), "{\"type\":\"assistant\"}\n");
    mkdirSync(join(dir, "tool-results"), { recursive: true });
    writeFileSync(join(dir, "tool-results", "call-1.json"), "{}");
    mkdirSync(join(dir, "workflows", "scripts"), { recursive: true });
    writeFileSync(join(dir, "workflows", "scripts", "plan.js"), "// script");
  }

  test("precondition 1: the destination is the SDK's 64-char capped key, and the manifest is written against it", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, OVERFLOWING, "alpha");
      // The band that matters: today's key is longer than the vendor cap, so 0.0.3's key is the
      // hashed form and an 0.0.2-era plan would have named a different directory entirely.
      expect(a.oldKey.length).toBeGreaterThan(TRANSCRIPT_PROJECT_KEY_MAX_LENGTH);
      expect(a.newKey.length).toBe(TRANSCRIPT_PROJECT_KEY_MAX_LENGTH);
      expect(isVendorCompliantProjectKey(a.newKey)).toBe(true);

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });

        expect(plan.moves).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, cwd: a.cwd }]);
        expect(manifest(rs)).toEqual([{ old_key: a.oldKey, new_key: a.newKey, status: "planned" }]);
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1 });
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
      } finally {
        rs.close();
      }
    });
  });

  test("precondition 1: a planned row naming an older algorithm's destination is REWRITTEN by the next plan", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, OVERFLOWING, "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        planMemoryKeyMigration({ rs, home, records, store });
        // An 0.0.2-era row: same source, a destination the uncapped algorithm would have chosen.
        rs.db.run("UPDATE memory_key_manifest SET new_key = ? WHERE old_key = ?", [`${a.oldKey}-uncapped`, a.oldKey]);

        const again = planMemoryKeyMigration({ rs, home, records, store });
        expect(again.moves).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, cwd: a.cwd }]);
        expect(manifest(rs)).toEqual([{ old_key: a.oldKey, new_key: a.newKey, status: "planned" }]);
        // And `apply` acts on the rewritten row, not the stale one.
        expect(applyMemoryKeyMigration({ rs, home }, again)).toEqual({ moved: 1 });
        expect(existsSync(join(home, "projects", `${a.oldKey}-uncapped`))).toBe(false);
      } finally {
        rs.close();
      }
    });
  });

  test("precondition 2: the live path returns the OLD directory before the migration and the NEW one after", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, OVERFLOWING, "alpha");
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        // The daemon's own wiring: a live resolver over the migration's manifest.
        const live = () => memoryDirFor(a.cwd, { normaHome: home, relocatedKey: (k) => memoryKeyRelocations(rs).get(k) });

        // BEFORE: nothing has moved, so the derivation stands and the file is where it says.
        expect(live()).toBe(join(home, "projects", a.oldKey, "memory"));
        expect(memoryDirForRecord(records.get(a.sessionId)!, { normaHome: home })).toBe(live());
        expect(readFileSync(join(live(), "MEMORY.md"), "utf8")).toBe("alpha");

        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));

        // AFTER: both doors move in the same breath as the tree — the record's key and the cwd-keyed
        // lookup agree, and the user's own MEMORY.md is still what the agent reads.
        expect(live()).toBe(join(home, "projects", a.newKey, "memory"));
        expect(memoryDirForRecord(records.get(a.sessionId)!, { normaHome: home })).toBe(live());
        expect(readFileSync(join(live(), "MEMORY.md"), "utf8")).toBe("alpha");

        // And a rollback takes the lookup back with the tree, in the same transaction.
        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 1, failures: [] });
        expect(memoryKeyRelocations(rs).size).toBe(0);
        expect(live()).toBe(join(home, "projects", a.oldKey, "memory"));
        expect(readFileSync(join(live(), "MEMORY.md"), "utf8")).toBe("alpha");
      } finally {
        rs.close();
      }
    });
  });

  test("precondition 3: a home that pins settings.memory.directory is declined whole — no rows, no motion", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, OVERFLOWING, "alpha");
      const pinned = join(home, "my-memdir");
      mkdirSync(pinned, { recursive: true });
      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const before = snapshotTree(join(home, "projects"));

        const plan = planMemoryKeyMigration({ rs, home, records, store, memoryDirectory: pinned });
        expect(plan.declined).toBe("memory-directory-override");
        expect(plan.moves).toEqual([]);
        // Not even a `planned` row: a row is a promise to move something.
        expect(manifest(rs)).toEqual([]);
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 0 });
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);

        // A whitespace-only value is "absent" for `memoryDirFor`, so it must be absent here too, or
        // a `"directory": "   "` in settings.json would silently decline the migration forever.
        expect(planMemoryKeyMigration({ rs, home, records, store, memoryDirectory: "   " }).declined).toBeUndefined();
        expect(manifest(rs).map((r) => r.status)).toEqual(["planned"]);
      } finally {
        rs.close();
      }
    });
  });

  test("precondition 4: the WHOLE project tree relinks — transcripts, subagents, tool results and workflow scripts, not just memory/", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, OVERFLOWING, "alpha");
      seedProjectTreeSiblings(home, a.oldKey);
      const before = snapshotTree(join(home, "projects", a.oldKey));
      expect(Object.keys(before).length).toBe(6); // memory/MEMORY.md, memory/notes/one.md + the four siblings

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));

        expect(existsSync(join(home, "projects", a.oldKey))).toBe(false);
        // Byte-identical, and NOTHING left behind at the old key: one project's state never splits
        // across two keys.
        expect(snapshotTree(join(home, "projects", a.newKey))).toEqual(before);
      } finally {
        rs.close();
      }
    });
  });
});

describe("memory-key migration — a torn apply", () => {
  /** A `fs` that performs the rename FOR REAL and then dies — the torn-apply window, which cannot be
   *  reproduced by arranging files, because the whole point is that the rename LANDED and the
   *  manifest commit did not. */
  function tornAfterRename(): MemoryKeyFs {
    return {
      existsSync,
      statSync,
      readdirSync: (p, o) => readdirSync(p, o),
      renameSync: (from, to) => { renameSync(from, to); throw new Error("simulated crash between the rename and the manifest commit"); },
    };
  }

  test("a crash between the rename and the manifest commit is detected and COMPLETED by the next boot's plan", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "torn", "alpha");
      const before = snapshotTree(join(home, "projects"));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });

        // THE CRASH: the rename lands, the process dies before the commit.
        expect(() => applyMemoryKeyMigration({ rs, home, fs: tornAfterRename() }, plan)).toThrow("simulated crash");
        expect(existsSync(join(home, "projects", a.newKey, "memory"))).toBe(true);
        expect(manifest(rs).map((r) => r.status)).toEqual(["planned"]);   // the commit never happened
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey); // nor the re-key

        // THE NEXT BOOT: `plan` runs first and settles it — the row is `moved`, the record follows,
        // and the live lookup finds the tree where it actually is.
        const resumed = planMemoryKeyMigration({ rs, home, records, store });
        expect(resumed.reconciled).toEqual([{ oldKey: a.oldKey, newKey: a.newKey }]);
        expect(resumed.moves).toEqual([]);
        expect(resumed.collisions).toEqual([]);
        expect(manifest(rs).map((r) => r.status)).toEqual(["moved"]);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);
        expect(memoryKeyRelocations(rs).get(a.oldKey)).toBe(a.newKey);
        expect(memoryDirFor(a.cwd, { normaHome: home, relocatedKey: (k) => memoryKeyRelocations(rs).get(k) }))
          .toBe(join(home, "projects", a.newKey, "memory"));

        // Completed, not stranded: it is rollback-able, byte-for-byte.
        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 1, failures: [] });
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
      } finally {
        rs.close();
      }
    });
  });

  test("a torn apply whose recorded destination is no longer the one this run derives is still settled, never stranded", async () => {
    // PRECONDITION 1's SHARP EDGE. A tree moved by an older build sits at THAT build's destination.
    // Reconciling against the pair this run would plan finds nothing — source gone, this run's
    // destination empty — and the row would stay `planned` forever with the tree unreachable by any
    // lookup. Reconciliation is therefore driven by the manifest ROW, whose `new_key` is where the
    // tree actually went.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "torn-legacy", "alpha");
      const legacyKey = `${a.oldKey}-uncapped-destination`;

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        planMemoryKeyMigration({ rs, home, records, store });
        // The older build's row, and its rename, both landing on a destination 0.0.3 would not pick.
        rs.db.run("UPDATE memory_key_manifest SET new_key = ? WHERE old_key = ?", [legacyKey, a.oldKey]);
        renameSync(join(home, "projects", a.oldKey), join(home, "projects", legacyKey));

        const resumed = planMemoryKeyMigration({ rs, home, records, store });
        expect(resumed.reconciled).toEqual([{ oldKey: a.oldKey, newKey: legacyKey }]);
        expect(manifest(rs)).toEqual([{ old_key: a.oldKey, new_key: legacyKey, status: "moved" }]);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(legacyKey);
        // Reported, not moved again: the record's key no longer matches its own derivation, which is
        // exactly the "unresolved" case — an operator sees it, and nothing is guessed at.
        expect(resumed.moves).toEqual([]);
        expect(resumed.unresolved).toEqual([{ winterSessionId: a.sessionId, reason: "root-disagrees" }]);
        // And the user's memory is READABLE the whole time, which is the only thing that matters.
        expect(memoryDirFor(a.cwd, { normaHome: home, relocatedKey: (k) => memoryKeyRelocations(rs).get(k) }))
          .toBe(join(home, "projects", legacyKey, "memory"));
        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 1, failures: [] });
        expect(readFileSync(join(home, "projects", a.oldKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
      } finally {
        rs.close();
      }
    });
  });

  test("a crash that never reached the rename leaves the row planned and the tree exactly where it was", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "torn-early", "alpha");
      const before = snapshotTree(join(home, "projects"));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        const neverRenames: MemoryKeyFs = {
          existsSync, statSync, readdirSync: (p, o) => readdirSync(p, o),
          renameSync: () => { throw new Error("simulated crash before the rename"); },
        };
        expect(() => applyMemoryKeyMigration({ rs, home, fs: neverRenames }, plan)).toThrow("before the rename");

        // Nothing moved, so the next plan simply plans it again — no reconciliation, no phantom row.
        const resumed = planMemoryKeyMigration({ rs, home, records, store });
        expect(resumed.reconciled).toEqual([]);
        expect(resumed.moves).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, cwd: a.cwd }]);
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(applyMemoryKeyMigration({ rs, home }, resumed)).toEqual({ moved: 1 });
      } finally {
        rs.close();
      }
    });
  });
});
