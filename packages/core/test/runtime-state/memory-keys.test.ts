import { describe, expect, test } from "bun:test";
import { TRANSCRIPT_PROJECT_KEY_MAX_LENGTH, compatibilityKeys, isVendorCompliantProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { memoryDirFor, memoryDirForRecord, repoRootFor, sanitizeProjectKey, _clearRepoRootCacheForTests } from "../../src/agent/memory-dir";
import {
  MemoryKeyNotPlannedError, RuntimeSessionRecords, applyMemoryKeyMigration,
  RUNTIME_STATE_SCHEMA_VERSION, backfillNativeSessions, memoryKeyRelocations, openRuntimeStateDb, planMemoryKeyMigration, reconcileMemoryKeyManifest, rollbackMemoryKeyMigration,
  type MemoryKeyFs, type RuntimeStateDb,
} from "../../src/runtime-state";
import { SessionStore } from "../../src/sessions/store";
import { ISO, withTempHome } from "./support";

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

/** Every file AND directory under `root`, as `relative path -> contents` (a directory maps to the
 *  sentinel `<dir>`). The byte-identity witness for rollback — directories included, so a tree that
 *  lost an EMPTY directory on the way out and back does not compare equal to one that kept it
 *  (review r1, N-2). */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { out[relative(root, p)] = "<dir>"; walk(p); }
      else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function manifest(rs: RuntimeStateDb): Array<{ old_key: string; new_key: string; status: string }> {
  return rs.db.query("SELECT old_key, new_key, status FROM memory_key_manifest ORDER BY old_key, entry").all() as
    Array<{ old_key: string; new_key: string; status: string }>;
}

/** The manifest AS IT IS SHAPED SINCE P8b-29 — one row per moved ENTRY, which is what makes a
 *  merge into the SDK's own project directory reversible. */
function manifestEntries(rs: RuntimeStateDb): Array<{ old_key: string; entry: string; new_key: string; status: string }> {
  return rs.db.query("SELECT old_key, entry, new_key, status FROM memory_key_manifest ORDER BY old_key, entry").all() as
    Array<{ old_key: string; entry: string; new_key: string; status: string }>;
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
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 0, movedEntries: 0, refused: [] });
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
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 2, movedEntries: 2, refused: [] });

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
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1, movedEntries: 1, refused: [] });
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

  test("a destination ENTRY that already exists is refused, never renamed onto", async () => {
    // P8b-29: the destination DIRECTORY existing is not a collision (it is where the SDK writes this
    // repo's transcripts). An entry of the SAME NAME at both ends is — `rename` onto an existing
    // file replaces it silently, which is the one outcome that could destroy somebody's memory.
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
        expect(plan.collisions).toEqual([{ newKey: a.newKey, oldKeys: [a.oldKey], reason: "target-exists", entries: ["memory"] }]);
        expect(plan.moves).toEqual([]);
        // The refusal is DATA, not an exception: it is a fact about the user's disk that the next
        // run can find again, and it must not stop any other project from migrating.
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 0, movedEntries: 0, refused: [] });
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
        expect(manifest(rs)).toEqual([]); // a refused project promises nothing
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

  test("a collision appearing between plan and apply refuses THAT project only — the other one still migrates", async () => {
    // P8b-29's whole point. The obstruction is b's; a must not pay for it, and the operator must be
    // told what is still wrong rather than handed a complaint about the move that succeeded.
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

        // Something occupies b's destination entry between plan and apply: a moves, b refuses.
        mkdirSync(join(home, "projects", b.newKey, "memory"), { recursive: true });
        const first = applyMemoryKeyMigration({ rs, home }, plan);
        expect(first.moved).toBe(1);
        expect(first.refused).toEqual([{ newKey: b.newKey, oldKeys: [b.oldKey], reason: "target-exists", entries: ["memory"] }]);
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
        expect(readFileSync(join(home, "projects", b.oldKey, "memory", "MEMORY.md"), "utf8")).toBe("beta");
        expect(manifest(rs).find((r) => r.old_key === a.oldKey)!.status).toBe("moved");
        expect(manifest(rs).find((r) => r.old_key === b.oldKey)!.status).toBe("planned");

        // The retry names the ACTIONABLE problem — b's occupied destination — and never re-reports
        // a's already-`moved` row.
        const retry = applyMemoryKeyMigration({ rs, home }, plan);
        expect(retry).toEqual({ moved: 0, movedEntries: 0, refused: [{ newKey: b.newKey, oldKeys: [b.oldKey], reason: "target-exists", entries: ["memory"] }] });

        // Obstruction cleared: the retry finishes the job and does not redo a's move.
        rmSync(join(home, "projects", b.newKey), { recursive: true, force: true });
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1, movedEntries: 1, refused: [] });
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
        expect(applyMemoryKeyMigration({ rs, home }, second)).toEqual({ moved: 1, movedEntries: 1, refused: [] });
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

        expect(plan.moves).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, cwd: a.cwd, entries: ["memory"] }]);
        expect(manifest(rs)).toEqual([{ old_key: a.oldKey, new_key: a.newKey, status: "planned" }]);
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1, movedEntries: 1, refused: [] });
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
        expect(again.moves).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, cwd: a.cwd, entries: ["memory"] }]);
        expect(manifest(rs)).toEqual([{ old_key: a.oldKey, new_key: a.newKey, status: "planned" }]);
        // And `apply` acts on the rewritten row, not the stale one.
        expect(applyMemoryKeyMigration({ rs, home }, again)).toEqual({ moved: 1, movedEntries: 1, refused: [] });
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
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 0, movedEntries: 0, refused: [] });
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
      // 6 files (memory/MEMORY.md, memory/notes/one.md + the four siblings) and the 6 directories
      // holding them — `snapshotTree` records both, so an empty directory lost in transit shows up.
      expect(Object.keys(before).length).toBe(12);

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
      mkdirSync: (p, o) => { mkdirSync(p, o); },
      rmdirSync: (p) => { rmdirSync(p); },
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
        expect(resumed.reconciled).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, entries: ["memory"] }]);
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
        expect(resumed.reconciled).toEqual([{ oldKey: a.oldKey, newKey: legacyKey, entries: ["memory"] }]);
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
      const before = { [a.oldKey]: snapshotTree(join(home, "projects", a.oldKey)) };

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        const neverRenames: MemoryKeyFs = {
          existsSync, statSync, readdirSync: (p, o) => readdirSync(p, o),
          mkdirSync: (p, o) => { mkdirSync(p, o); }, rmdirSync: (p) => { rmdirSync(p); },
          renameSync: () => { throw new Error("simulated crash before the rename"); },
        };
        expect(() => applyMemoryKeyMigration({ rs, home, fs: neverRenames }, plan)).toThrow("before the rename");

        // Nothing moved, so the next plan simply plans it again — no reconciliation, no phantom row.
        const resumed = planMemoryKeyMigration({ rs, home, records, store });
        expect(resumed.reconciled).toEqual([]);
        expect(resumed.moves).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, cwd: a.cwd, entries: ["memory"] }]);
        // The user's tree is untouched. The ONE mark the failed attempt leaves is an empty
        // destination directory — `apply` creates it before the first rename, and the retry below
        // moves into it. Nothing of the user's is in it, and no entry is recorded as moved.
        expect(snapshotTree(join(home, "projects", a.oldKey))).toEqual(before[a.oldKey] as never);
        expect(readdirSync(join(home, "projects", a.newKey))).toEqual([]);
        expect(applyMemoryKeyMigration({ rs, home }, resumed)).toEqual({ moved: 1, movedEntries: 1, refused: [] });
      } finally {
        rs.close();
      }
    });
  });
});

// ── P8b-29: the destination is SHARED with the Winter SDK, so the move is per ENTRY ──────────────
//
// `<home>/projects/<key>/` is not Norma's alone: it is where the SDK writes this repo's transcripts,
// and for a session opened at the repo root the transcript key and the compatibility memory key are
// the same string. A whole-directory rename could therefore only ever refuse on a home that has run
// a Winter session — permanently, and taking every other project in that home with it.
describe("memory-key migration — merging into the SDK's own project directory", () => {
  /** What the SDK leaves in `projects/<transcriptKey>/`: a transcript, its subagents, its tool
   *  results. None of it is Norma's to move, and none of it is in the way. */
  function seedSdkTranscripts(home: string, key: string): void {
    mkdirSync(join(home, "projects", key, "subagents"), { recursive: true });
    writeFileSync(join(home, "projects", key, "3f2a1c00-0000-4000-8000-000000000000.jsonl"), "{\"type\":\"user\"}\n");
    writeFileSync(join(home, "projects", key, "subagents", "agent-1.jsonl"), "{\"type\":\"assistant\"}\n");
  }

  test("memory merges INTO the pre-existing destination, and the SDK's transcripts are untouched", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      seedSdkTranscripts(home, a.newKey);
      const sdkBefore = snapshotTree(join(home, "projects", a.newKey));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });

        const plan = planMemoryKeyMigration({ rs, home, records, store });
        // The destination DIRECTORY existing is not a collision — only a shared entry name would be.
        expect(plan.collisions).toEqual([]);
        expect(plan.moves).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, cwd: a.cwd, entries: ["memory"] }]);
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1, movedEntries: 1, refused: [] });

        // Norma's memory arrived beside the SDK's files; not one of the SDK's files moved or changed.
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
        for (const [path, body] of Object.entries(sdkBefore)) {
          expect(snapshotTree(join(home, "projects", a.newKey))[path]).toBe(body);
        }
        // The emptied source is gone rather than left as a key nothing files anything under.
        expect(existsSync(join(home, "projects", a.oldKey))).toBe(false);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);
        expect(manifestEntries(rs)).toEqual([{ old_key: a.oldKey, entry: "memory", new_key: a.newKey, status: "moved" }]);
      } finally {
        rs.close();
      }
    });
  });

  test("rollback after a merge takes back ONLY what this migration moved", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      seedSdkTranscripts(home, a.newKey);
      const before = snapshotTree(join(home, "projects"));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));

        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 1, failures: [] });
        // Byte-identical AND structurally identical: the memory tree is back under the old key, the
        // SDK's transcript directory is exactly as it was, and nothing was dragged with it.
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
        expect(manifestEntries(rs).map((r) => r.status)).toEqual(["rolled-back"]);
      } finally {
        rs.close();
      }
    });
  });

  test("a project with several entries and a destination that already holds a DIFFERENT one merges all of them", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      mkdirSync(join(home, "projects", a.oldKey, "workflows", "scripts"), { recursive: true });
      writeFileSync(join(home, "projects", a.oldKey, "workflows", "scripts", "plan.js"), "// script");
      seedSdkTranscripts(home, a.newKey);

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves[0]!.entries).toEqual(["memory", "workflows"]);
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1, movedEntries: 2, refused: [] });

        expect(readFileSync(join(home, "projects", a.newKey, "workflows", "scripts", "plan.js"), "utf8")).toBe("// script");
        expect(readFileSync(join(home, "projects", a.newKey, "subagents", "agent-1.jsonl"), "utf8")).toBe("{\"type\":\"assistant\"}\n");
        expect(manifestEntries(rs).map((r) => r.entry)).toEqual(["memory", "workflows"]);
      } finally {
        rs.close();
      }
    });
  });

  test("one project's entry collision never costs another project its migration", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const blocked = seedProject(home, store, "blocked", "blocked-memory");
      const fine = seedProject(home, store, "fine", "fine-memory");
      // Something already sits at `blocked`'s destination under the SAME entry name.
      mkdirSync(join(home, "projects", blocked.newKey, "memory"), { recursive: true });
      writeFileSync(join(home, "projects", blocked.newKey, "memory", "MEMORY.md"), "someone else's");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });

        expect(plan.collisions).toEqual([{ newKey: blocked.newKey, oldKeys: [blocked.oldKey], reason: "target-exists", entries: ["memory"] }]);
        expect(plan.moves.map((m) => m.oldKey)).toEqual([fine.oldKey]);
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1, movedEntries: 1, refused: [] });

        // The healthy project is relocated; the blocked one is exactly as it was found, in every store.
        expect(readFileSync(join(home, "projects", fine.newKey, "memory", "MEMORY.md"), "utf8")).toBe("fine-memory");
        expect(readFileSync(join(home, "projects", blocked.oldKey, "memory", "MEMORY.md"), "utf8")).toBe("blocked-memory");
        expect(readFileSync(join(home, "projects", blocked.newKey, "memory", "MEMORY.md"), "utf8")).toBe("someone else's");
        expect(records.get(blocked.sessionId)!.memoryProjectKey).toBe(blocked.oldKey);
        expect(memoryKeyRelocations(rs).get(blocked.oldKey)).toBeUndefined();
        expect(memoryKeyRelocations(rs).get(fine.oldKey)).toBe(fine.newKey);

        // CLEARED AND RE-PLANNED: no restart, no manual manifest surgery — the refusal left nothing
        // behind to undo.
        rmSync(join(home, "projects", blocked.newKey, "memory"), { recursive: true, force: true });
        const second = planMemoryKeyMigration({ rs, home, records, store });
        expect(second.collisions).toEqual([]);
        expect(applyMemoryKeyMigration({ rs, home }, second)).toEqual({ moved: 1, movedEntries: 1, refused: [] });
        expect(readFileSync(join(home, "projects", blocked.newKey, "memory", "MEMORY.md"), "utf8")).toBe("blocked-memory");
      } finally {
        rs.close();
      }
    });
  });

  test("a torn apply part-way through a multi-entry project is repaired per row, and the live path follows the MEMORY entry", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      mkdirSync(join(home, "projects", a.oldKey, "workflows"), { recursive: true });
      writeFileSync(join(home, "projects", a.oldKey, "workflows", "plan.js"), "// script");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves[0]!.entries).toEqual(["memory", "workflows"]);

        // The crash: the FIRST entry's rename lands, then the process dies before its commit.
        let renames = 0;
        const tornOnFirst: MemoryKeyFs = {
          existsSync, statSync, readdirSync: (p, o) => readdirSync(p, o),
          mkdirSync: (p, o) => { mkdirSync(p, o); }, rmdirSync: (p) => { rmdirSync(p); },
          renameSync: (from, to) => { renameSync(from, to); if (++renames === 1) throw new Error("simulated crash mid-project"); },
        };
        expect(() => applyMemoryKeyMigration({ rs, home, fs: tornOnFirst }, plan)).toThrow("simulated crash");
        expect(manifestEntries(rs).map((r) => r.status)).toEqual(["planned", "planned"]);

        // The next boot's repair settles the entry that landed, per row, and leaves the other alone.
        const resumed = planMemoryKeyMigration({ rs, home, records, store });
        expect(resumed.reconciled).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, entries: ["memory"] }]);
        expect(manifestEntries(rs).map((r) => [r.entry, r.status])).toEqual([["memory", "moved"], ["workflows", "planned"]]);
        // THE LIVE PATH FOLLOWS `memory`, not the whole set: it is what `memoryDirFor` resolves, and
        // in this half-moved window it is the difference between the agent finding its own
        // MEMORY.md and starting a second one.
        expect(memoryDirFor(a.cwd, { normaHome: home, relocatedKey: (k) => memoryKeyRelocations(rs).get(k) }))
          .toBe(join(home, "projects", a.newKey, "memory"));
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);

        // And the run finishes the rest without redoing the part that landed — planned from the
        // MANIFEST, since the re-keyed record can no longer ask for this pair at all.
        expect(resumed.moves).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, entries: ["workflows"] }]);
        expect(applyMemoryKeyMigration({ rs, home }, resumed)).toEqual({ moved: 1, movedEntries: 1, refused: [] });
        expect(readFileSync(join(home, "projects", a.newKey, "workflows", "plan.js"), "utf8")).toBe("// script");
        expect(existsSync(join(home, "projects", a.oldKey))).toBe(false);
      } finally {
        rs.close();
      }
    });
  });
});

describe("memory-key migration — a home that was migrated by a schema-v1 build", () => {
  /** Take a fully-built v2 database back to v1's manifest shape and version, so the next open runs
   *  the real migration over real data. Cheaper and more faithful than hand-writing all seventeen v1
   *  tables: everything else in the file is exactly what this build creates. */
  function downgradeManifestToV1(home: string, rows: Array<{ old_key: string; new_key: string; status: string }>): void {
    const rs = openRuntimeStateDb(home);
    try {
      rs.db.run("DROP TABLE memory_key_manifest");
      rs.db.run(`CREATE TABLE memory_key_manifest (old_key TEXT PRIMARY KEY, new_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('planned','moved','rolled-back')), planned_at TEXT NOT NULL, moved_at TEXT)`);
      for (const r of rows) {
        rs.db.run("INSERT INTO memory_key_manifest (old_key, new_key, status, planned_at, moved_at) VALUES (?, ?, ?, ?, NULL)", [r.old_key, r.new_key, r.status, ISO()]);
      }
      rs.db.run("PRAGMA user_version = 1");
    } finally {
      rs.close();
    }
  }

  test("a torn apply left by a v1 build is still repaired after the schema migration, and the live path finds the tree", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "v1-torn", "alpha");
      {
        const rs = openRuntimeStateDb(home);
        try { backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" }); } finally { rs.close(); }
      }
      // The v1 world: one row for the whole tree, `planned`, and the whole directory already renamed
      // — the exact state a v1 build's crash between its rename and its commit would leave.
      downgradeManifestToV1(home, [{ old_key: a.oldKey, new_key: a.newKey, status: "planned" }]);
      renameSync(join(home, "projects", a.oldKey), join(home, "projects", a.newKey));

      const rs = openRuntimeStateDb(home);
      try {
        expect(rs.schemaVersion()).toBe(RUNTIME_STATE_SCHEMA_VERSION);
        const records = new RuntimeSessionRecords(rs);
        // The row came across as the `memory` entry, and the per-entry repair settles it: source
        // entry gone, destination entry present.
        expect(reconcileMemoryKeyManifest({ rs, home, records })).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, entries: ["memory"] }]);
        expect(manifestEntries(rs)).toEqual([{ old_key: a.oldKey, entry: "memory", new_key: a.newKey, status: "moved" }]);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);
        expect(memoryDirFor(a.cwd, { normaHome: home, relocatedKey: (k) => memoryKeyRelocations(rs).get(k) }))
          .toBe(join(home, "projects", a.newKey, "memory"));
        // And it is rollback-able, which is the whole reason the row was carried forward.
        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 1, failures: [] });
        expect(readFileSync(join(home, "projects", a.oldKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
      } finally {
        rs.close();
      }
    });
  });
});

// ── Fix round 2: which RECORDS a move owns, and what a race-window refusal leaves behind ─────────
describe("memory-key migration — record scoping and the race window", () => {
  /** A record filed AT the compatibility key from birth — what a Winter session's own record is
   *  (Task 16), and the thing a blanket by-key re-key would drag around. */
  function seedNativeAtDestination(home: string, store: SessionStore, key: string): string {
    const cwd = workdir(home, `native-${key.slice(-8)}`);
    const sessionId = store.createSession("work", { cwd });
    const rs = openRuntimeStateDb(home);
    try {
      backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
      rs.db.run("UPDATE runtime_sessions SET memory_project_key = ? WHERE winter_session_id = ?", [key, sessionId]);
    } finally {
      rs.close();
    }
    return sessionId;
  }

  test("a half-moved project never drags a record that was natively at the destination key", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      // A `<uuid>.jsonl` sorts BEFORE "memory", so the project is genuinely half-moved (its `memory`
      // entry still at the old key) at the moment the first entry commits.
      writeFileSync(join(home, "projects", a.oldKey, "0f2a1c00-0000-4000-8000-000000000000.jsonl"), "{}\n");
      const native = seedNativeAtDestination(home, store, a.newKey);

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves[0]!.entries).toEqual(["0f2a1c00-0000-4000-8000-000000000000.jsonl", "memory"]);

        // Stop after the FIRST entry: the project is half-moved and `syncRecordKey` runs with
        // `pairRelocated` still false — the branch that used to re-key by key.
        let renames = 0;
        const tornOnSecond: MemoryKeyFs = {
          existsSync, statSync, readdirSync: (p, o) => readdirSync(p, o),
          mkdirSync: (p, o) => { mkdirSync(p, o); }, rmdirSync: (p) => { rmdirSync(p); },
          renameSync: (from, to) => { if (++renames === 2) throw new Error("simulated crash mid-project"); renameSync(from, to); },
        };
        expect(() => applyMemoryKeyMigration({ rs, home, fs: tornOnSecond }, plan)).toThrow("simulated crash");

        // The record that was always at the destination is exactly where it was.
        expect(records.get(native)!.memoryProjectKey).toBe(a.newKey);
        // And the migration's own record has not moved forward yet — its `memory` entry has not.
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
      } finally {
        rs.close();
      }
    });
  });

  test("a rollback puts back only the records this migration moved", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      {
        const rs0 = openRuntimeStateDb(home);
        try { backfillNativeSessions({ rs: rs0, store, home, providerId: "codex-oauth" }); } finally { rs0.close(); }
      }
      const native = seedNativeAtDestination(home, store, a.newKey);

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.newKey);
        expect(records.get(native)!.memoryProjectKey).toBe(a.newKey);

        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 1, failures: [] });
        // The migrated record goes back; the one that was born at the destination STAYS there — the
        // blanket `rekey(newKey → oldKey)` used to file it under a key it had never lived at, for good.
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
        expect(records.get(native)!.memoryProjectKey).toBe(a.newKey);
      } finally {
        rs.close();
      }
    });
  });

  test("a refusal in the race window leaves the project where it started — nothing split across two keys", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      writeFileSync(join(home, "projects", a.oldKey, "0f2a1c00-0000-4000-8000-000000000000.jsonl"), "{}\n");
      const before = snapshotTree(join(home, "projects", a.oldKey));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });

        // Something occupies the SECOND entry's destination between the first rename and the second
        // — the window the batch pre-check cannot see.
        let renames = 0;
        const racy: MemoryKeyFs = {
          statSync, readdirSync: (p, o) => readdirSync(p, o),
          mkdirSync: (p, o) => { mkdirSync(p, o); }, rmdirSync: (p) => { rmdirSync(p); },
          renameSync: (from, to) => { renameSync(from, to); if (++renames === 1) mkdirSync(join(home, "projects", a.newKey, "memory"), { recursive: true }); },
          existsSync,
        };
        const result = applyMemoryKeyMigration({ rs, home, fs: racy }, plan);
        expect(result.refused).toEqual([{ newKey: a.newKey, oldKeys: [a.oldKey], reason: "target-exists", entries: ["memory"] }]);
        expect(result.moved).toBe(0);
        expect(result.movedEntries).toBe(0);

        // Everything of the user's is back under the old key, and every row is `planned` again.
        expect(snapshotTree(join(home, "projects", a.oldKey))).toEqual(before);
        expect(manifestEntries(rs).map((r) => r.status)).toEqual(["planned", "planned"]);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
        expect(memoryKeyRelocations(rs).size).toBe(0);
      } finally {
        rs.close();
      }
    });
  });
});

// ── Fix round 3 (re-review NEW-8): the undo is a recorded, repairable operation ──────────────────
//
// `apply` puts back the entries it had already renamed when a collision appears mid-pass, so a
// refused project moves nothing at all. That undo is a rename-then-commit pair exactly as the move
// is, and its torn window is the mirror image — the entry back at the OLD key with a row still
// saying `moved`, which nothing read. An `undoing` row is what the boot repair can finish.
describe("memory-key migration — a torn UNDO", () => {
  /** A project with two entries, the second of which will collide mid-pass. */
  function twoEntryProject(home: string, store: SessionStore, name: string) {
    const p = seedProject(home, store, name, "alpha");
    writeFileSync(join(home, "projects", p.oldKey, "0f2a1c00-0000-4000-8000-000000000000.jsonl"), "{}\n");
    return p;
  }

  test("a crash mid-undo leaves an `undoing` row, and the next boot finishes the undo", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = twoEntryProject(home, store, "a");
      const before = snapshotTree(join(home, "projects", a.oldKey));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(plan.moves[0]!.entries).toEqual(["0f2a1c00-0000-4000-8000-000000000000.jsonl", "memory"]);

        // The first entry moves; the second's destination appears; the UNDO of the first then dies
        // between its declaration and its rename-back.
        let renames = 0;
        const dieMidUndo: MemoryKeyFs = {
          existsSync, statSync, readdirSync: (p, o) => readdirSync(p, o),
          mkdirSync: (p, o) => { mkdirSync(p, o); }, rmdirSync: (p) => { rmdirSync(p); },
          renameSync: (from, to) => {
            if (renames === 1) throw new Error("simulated crash mid-undo");   // the rename-BACK
            renameSync(from, to);
            renames += 1;
            if (renames === 1) mkdirSync(join(home, "projects", a.newKey, "memory"), { recursive: true });
          },
        };
        // NOT A THROW: a rename-back that fails is a recorded state, not a fatal one — `finishUndo`
        // leaves the row `undoing` for the next boot rather than guessing, and the collision is still
        // reported as the refusal it is.
        const result = applyMemoryKeyMigration({ rs, home, fs: dieMidUndo }, plan);
        expect(result.moved).toBe(0);
        expect(result.refused).toEqual([{ newKey: a.newKey, oldKeys: [a.oldKey], reason: "target-exists", entries: ["memory"] }]);

        // The declared-but-unfinished state: the row says `undoing`, the entry is still at the new
        // key, and — crucially — the live map does NOT claim the project is relocated.
        expect(manifestEntries(rs).map((r) => [r.entry, r.status])).toEqual([
          ["0f2a1c00-0000-4000-8000-000000000000.jsonl", "undoing"],
          ["memory", "planned"],
        ]);
        expect(memoryKeyRelocations(rs).size).toBe(0);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);

        // THE NEXT BOOT finishes it: the entry comes home, the row is `planned` again, and the
        // project is exactly where it started — the invariant the undo exists to keep. And it SAYS
        // so (re-review NEW-13): the one operation the repair performs on somebody's files is never
        // the one it does not mention — one line per rename-back, naming both ends.
        const lines: string[] = [];
        expect(reconcileMemoryKeyManifest({ rs, home, records, log: (l) => { lines.push(l); } })).toEqual([]);
        expect(lines).toEqual([
          `memory-key repair: finished an undo a previous run left in flight — moved projects/${a.newKey}/0f2a1c00-0000-4000-8000-000000000000.jsonl back to projects/${a.oldKey}/0f2a1c00-0000-4000-8000-000000000000.jsonl`,
        ]);
        expect(manifestEntries(rs).map((r) => r.status)).toEqual(["planned", "planned"]);
        // a second repair has nothing to move and says nothing (idempotent, and silent when idle)
        const again: string[] = [];
        expect(reconcileMemoryKeyManifest({ rs, home, records, log: (l) => { again.push(l); } })).toEqual([]);
        expect(again).toEqual([]);
        expect(snapshotTree(join(home, "projects", a.oldKey))).toEqual(before);
        expect(memoryDirFor(a.cwd, { normaHome: home, relocatedKey: (k) => memoryKeyRelocations(rs).get(k) }))
          .toBe(join(home, "projects", a.oldKey, "memory"));

        // And the project migrates normally once the obstruction is cleared — no row is skipped
        // forever, and nothing needed a hand.
        rmSync(join(home, "projects", a.newKey, "memory"), { recursive: true, force: true });
        const second = planMemoryKeyMigration({ rs, home, records, store });
        expect(applyMemoryKeyMigration({ rs, home }, second)).toEqual({ moved: 1, movedEntries: 2, refused: [] });
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
      } finally {
        rs.close();
      }
    });
  });

  test("an undo whose old name has been re-taken settles as `moved` — the row describes the disk, never an intention", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));
        // Hand-forge the torn-undo shape, then re-occupy the old name before the repair runs.
        rs.db.run("UPDATE memory_key_manifest SET status = 'undoing' WHERE entry = 'memory'");
        mkdirSync(join(home, "projects", a.oldKey, "memory"), { recursive: true });
        writeFileSync(join(home, "projects", a.oldKey, "memory", "MEMORY.md"), "someone else's");

        reconcileMemoryKeyManifest({ rs, home, records });
        // Both ends occupied: the undo cannot complete, so the row goes back to the truth.
        expect(manifestEntries(rs).map((r) => r.status)).toEqual(["moved"]);
        expect(memoryKeyRelocations(rs).get(a.oldKey)).toBe(a.newKey);
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
        expect(readFileSync(join(home, "projects", a.oldKey, "memory", "MEMORY.md"), "utf8")).toBe("someone else's");
      } finally {
        rs.close();
      }
    });
  });

  test("a leftover `undoing` row never denies another project its migration", async () => {
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
        // A row the repair could not settle (both ends of a's entry occupied, say) must not turn
        // apply's stale-row pre-check into a refusal for everybody — the NEW-4(b) shape.
        rs.db.run("UPDATE memory_key_manifest SET status = 'undoing' WHERE old_key = ?", [a.oldKey]);

        const result = applyMemoryKeyMigration({ rs, home }, plan);
        expect(result.moved).toBe(1);
        expect(readFileSync(join(home, "projects", b.newKey, "memory", "MEMORY.md"), "utf8")).toBe("beta");
        expect(readFileSync(join(home, "projects", a.oldKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
      } finally {
        rs.close();
      }
    });
  });
});

// ── P8d-11: the memory-key rollback door (the 8b M-4 obligations) ──────────────────────────────────
describe("memory-key migration — the rollback door's own torn window (a′)", () => {
  /** A `fs` whose rename-BACK (the Nth one) performs the real rename and then dies — the rollback
   *  door's own mirror of `tornAfterRename()` above, for the direction `rollbackMemoryKeyMigration`
   *  runs in. */
  function dieAfterNthRenameBack(n: number): MemoryKeyFs {
    let renames = 0;
    return {
      existsSync, statSync, readdirSync: (p, o) => readdirSync(p, o),
      mkdirSync: (p, o) => { mkdirSync(p, o); }, rmdirSync: (p) => { rmdirSync(p); },
      renameSync: (from, to) => {
        renameSync(from, to);
        renames += 1;
        if (renames === n) throw new Error("simulated crash between the rollback's rename-back and its manifest commit");
      },
    };
  }

  test("a crash mid-rollback leaves an `undoing` row (never a bare `moved` one), and the next boot's repair FINISHES IT AS A ROLLBACK", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));
        expect(manifestEntries(rs).map((r) => r.status)).toEqual(["moved"]);

        // THE CRASH: the rename-back lands for real, the process dies before `rolled-back` commits.
        // `rollbackMemoryKeyMigration` itself never throws (unlike `applyMemoryKeyMigration`'s own
        // torn-apply window) — `finishUndo`'s try/catch is what makes the rest of the rollback safe
        // to keep running over other projects, so the crash surfaces as a report, not an exception.
        const result = rollbackMemoryKeyMigration({ rs, home, fs: dieAfterNthRenameBack(1) });
        expect(result).toEqual({ rolledBack: 0, failures: [] });

        // The declared-but-unfinished state, and it says WHICH direction: `undo_target` is
        // `'rolled-back'`, never `undoEntries`' own `'planned'` — this is the fact a′ exists to
        // record. The file is already home; the row has not caught up yet.
        expect(existsSync(join(home, "projects", a.oldKey, "memory", "MEMORY.md"))).toBe(true);
        const row = rs.db.query<{ status: string; undo_target: string | null }, []>(
          "SELECT status, undo_target FROM memory_key_manifest WHERE entry = 'memory'",
        ).get();
        expect(row).toEqual({ status: "undoing", undo_target: "rolled-back" });

        // THE NEXT BOOT'S REPAIR settles it — AS A COMPLETED ROLLBACK, not as `undoEntries`' own
        // `planned` resting state (which would silently re-arm the project for the next `apply`).
        expect(reconcileMemoryKeyManifest({ rs, home, records })).toEqual([]); // nothing left to rename
        expect(manifestEntries(rs).map((r) => r.status)).toEqual(["rolled-back"]);
        expect(records.get(a.sessionId)!.memoryProjectKey).toBe(a.oldKey);
        expect(memoryKeyRelocations(rs).size).toBe(0);
      } finally {
        rs.close();
      }
    });
  });

  test("a′ ruling: the rollback completes and `runtimes.migrations.memoryKeys` is left exactly as the user set it — this door never writes settings, only files and manifest rows", async () => {
    // Not a settings test (this file never reads settings.json at all) — a structural pin that
    // `rollbackMemoryKeyMigration`'s deps carry nothing settings-shaped for the door to touch, so
    // the ruling holds by construction rather than by a convention someone could forget.
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const result = rollbackMemoryKeyMigration({ rs, home });
        expect(Object.keys(result)).toEqual(["rolledBack", "failures"]);
      } finally {
        rs.close();
      }
    });
  });
});

describe("memory-key migration — a shrunk entry set after a rollback (b)", () => {
  test("(b) a re-plan after a rollback whose entry set SHRANK drops the vanished entry's `rolled-back` row before apply's stale-row pre-check", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");
      const vanishing = "0f2a1c00-0000-4000-8000-000000000000.jsonl";
      writeFileSync(join(home, "projects", a.oldKey, vanishing), "{}\n");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));
        expect(manifestEntries(rs).map((r) => r.entry).sort()).toEqual([vanishing, "memory"]);

        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 2, failures: [] });
        expect(manifestEntries(rs).map((r) => r.status)).toEqual(["rolled-back", "rolled-back"]);

        // THE SHRINK: the user deletes the vanishing entry's rolled-back copy by hand — it is gone
        // from both ends now (never migrated again, never restored).
        rmSync(join(home, "projects", a.oldKey, vanishing));

        // Without the fix, `apply`'s stale-row pre-check throws `MemoryKeyNotPlannedError` for the
        // WHOLE project — including `memory`, which this re-plan handles perfectly well — because
        // `manifestRowsFor(oldKey)` still returns the vanished entry's `rolled-back` row alongside
        // it. `pruneVanishedRollbacks` runs at the TOP of `planMemoryKeyMigration`, before it derives
        // anything else, so the row is gone by the time THIS SAME CALL returns.
        const plan = planMemoryKeyMigration({ rs, home, records, store });
        expect(manifestEntries(rs).find((r) => r.entry === vanishing)).toBeUndefined();
        expect(plan.moves).toEqual([{ oldKey: a.oldKey, newKey: a.newKey, cwd: a.cwd, entries: ["memory"] }]);
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 1, movedEntries: 1, refused: [] });
        expect(readFileSync(join(home, "projects", a.newKey, "memory", "MEMORY.md"), "utf8")).toBe("alpha");
      } finally {
        rs.close();
      }
    });
  });

  test("(b) a `rolled-back` row still present at the NEW key (mid-flight, not truly vanished) is left alone", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const a = seedProject(home, store, "a", "alpha");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records, store }));
        rs.db.run("UPDATE memory_key_manifest SET status = 'rolled-back' WHERE entry = 'memory'");
        // Gone from the OLD side (never actually renamed back — a hand-forged row) but STILL at the
        // new key: `pruneVanishedRollbacks` must not discard the only record of where it is.
        expect(existsSync(join(home, "projects", a.newKey, "memory"))).toBe(true);

        planMemoryKeyMigration({ rs, home, records, store });
        expect(manifestEntries(rs).find((r) => r.entry === "memory")?.status).toBe("rolled-back");
      } finally {
        rs.close();
      }
    });
  });
});
