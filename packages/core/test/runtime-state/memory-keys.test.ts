import { describe, expect, test } from "bun:test";
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRootFor, sanitizeProjectKey, _clearRepoRootCacheForTests } from "../../src/agent/memory-dir";
import {
  MemoryKeyCollisionError, RuntimeSessionRecords, applyMemoryKeyMigration, backfillNativeSessions,
  openRuntimeStateDb, planMemoryKeyMigration, rollbackMemoryKeyMigration, type RuntimeStateDb,
} from "../../src/runtime-state";
import { SessionStore } from "../../src/sessions/store";
import { withTempHome } from "./support";

/** Today's memory key for a cwd — the exact composition `agent/memory-dir.ts`'s `memoryDirFor` uses. */
const oldKeyFor = (cwd: string): string => sanitizeProjectKey(repoRootFor(cwd));
/** The compatibility memory key — the SDK's own, and root-based like today's, so the mapping is
 *  one-to-one per repo root by construction. */
const newKeyFor = (cwd: string): string => compatibilityKeys(cwd).memoryProjectKey;

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
        expect(plan.unresolved).toEqual([a.sessionId]);
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

        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 2 });
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
        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 0 });
      } finally {
        rs.close();
      }
    });
  });

  test("two old keys landing on one new key are refused, and nothing moves", async () => {
    // UNREACHABLE FROM REAL INPUTS (both keys derive from the repo root, so one root gives one of
    // each) — constructed by hand-editing a record's stored key. The guard stays because "nothing
    // merges two projects' memory" must be true by refusal, not by an argument about derivations.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const cwd = workdir(home, "shared");
      const one = store.createSession("work", { cwd });
      const two = store.createSession("work", { cwd });
      seedMemory(home, cwd, "shared");
      mkdirSync(join(home, "projects", "impostor-old", "memory"), { recursive: true });
      writeFileSync(join(home, "projects", "impostor-old", "memory", "MEMORY.md"), "impostor");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        // Same cwd (so one destination), but two different stored old keys.
        forceMemoryKey(rs, two, "impostor-old");
        expect(new RuntimeSessionRecords(rs).get(one)!.memoryProjectKey).toBe(oldKeyFor(cwd));
        const before = snapshotTree(join(home, "projects"));

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.collisions.length).toBe(1);
        expect(plan.collisions[0]!.newKey).toBe(newKeyFor(cwd));
        expect(plan.collisions[0]!.oldKeys.sort()).toEqual([oldKeyFor(cwd), "impostor-old"].sort());
        expect(plan.collisions[0]!.reason).toBe("many-old-keys");
        expect(plan.moves).toEqual([]);

        expect(() => applyMemoryKeyMigration({ rs, home }, plan)).toThrow(MemoryKeyCollisionError);
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(manifest(rs).every((r) => r.status !== "moved")).toBe(true);
      } finally {
        rs.close();
      }
    });
  });

  test("one old key fanning out to two new keys is refused too", async () => {
    // ALSO UNREACHABLE FROM REAL INPUTS after the controller's ruling — this is the case the old
    // cwd-based destination made routine (two sessions in one repo at different cwds) and the
    // root-based destination makes impossible. Constructed by hand-editing, and kept as a guard.
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
        // Two different cwds (so two destinations) forced to share one stored old key.
        forceMemoryKey(rs, b.sessionId, a.oldKey);
        const before = snapshotTree(join(home, "projects"));

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.collisions.map((c) => c.reason)).toEqual(["old-key-fans-out", "old-key-fans-out"]);
        expect(plan.collisions.map((c) => c.newKey).sort()).toEqual([a.newKey, b.newKey].sort());
        expect(plan.collisions.every((c) => c.oldKeys.length === 1 && c.oldKeys[0] === a.oldKey)).toBe(true);
        expect(plan.moves).toEqual([]);
        expect(() => applyMemoryKeyMigration({ rs, home }, plan)).toThrow(MemoryKeyCollisionError);
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

        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 1 });
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
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
