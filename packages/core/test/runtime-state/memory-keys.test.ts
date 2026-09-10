import { describe, expect, test } from "bun:test";
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRootFor, sanitizeProjectKey, _clearRepoRootCacheForTests } from "../../src/agent/memory-dir";
import {
  MemoryKeyCollisionError, RuntimeSessionRecords, applyMemoryKeyMigration, backfillNativeSessions,
  openRuntimeStateDb, planMemoryKeyMigration, rollbackMemoryKeyMigration, type RuntimeStateDb,
} from "../../src/runtime-state";
import { SessionStore } from "../../src/sessions/store";
import { ISO, withTempHome } from "./support";

function workdir(home: string, name: string): string {
  const dir = join(home, "work", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Seed the memory tree today's algorithm would have written for `cwd`. */
function seedMemory(home: string, cwd: string, body: string): string {
  const key = sanitizeProjectKey(repoRootFor(cwd));
  const dir = join(home, "projects", key, "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), body);
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "one.md"), `${body} — note`);
  return key;
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

/** A record whose two project keys are stated outright — the collision cases cannot be produced by
 *  the backfill, which derives both keys from one cwd. */
function seedRecord(rs: RuntimeStateDb, id: string, memoryProjectKey: string, transcriptProjectKey: string): void {
  new RuntimeSessionRecords(rs).create({
    winterSessionId: id, runtimeKind: "winter-agent", providerId: "codex-oauth", modelRef: "m",
    backendRoot: "/tmp/backend", transcriptProjectKey, memoryProjectKey, tempProjectKey: transcriptProjectKey,
    transcriptHealth: "unsupported", compatibilityLevel: "conversation", conformanceCorpusVersion: "legacy",
    versionProvenance: "legacy-unknown", capabilities: ["import-conversation"],
    selection: {
      runtimeKind: "winter-agent", providerId: "codex-oauth", modelRef: "m", family: "legacy",
      authFamily: "custom", sdkVersion: "unknown", reason: "backfill", decidedAt: ISO(),
    },
  });
}

describe("planMemoryKeyMigration", () => {
  test("plans one move per record whose keys differ, preserves the reserved buckets and reports the rest", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const cwdA = workdir(home, "a");
      const cwdB = workdir(home, "b");
      store.createSession("work", { cwd: cwdA });
      store.createSession("work", { cwd: cwdB });
      const oldA = seedMemory(home, cwdA, "alpha");
      const oldB = seedMemory(home, cwdB, "beta");
      mkdirSync(join(home, "projects", "_assistant", "memory"), { recursive: true });
      writeFileSync(join(home, "projects", "_assistant", "memory", "MEMORY.md"), "dreams");
      mkdirSync(join(home, "projects", "stray-project", "memory"), { recursive: true });

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records });

        expect(plan.collisions).toEqual([]);
        expect(plan.moves.map((m) => m.oldKey).sort()).toEqual([oldA, oldB].sort());
        expect(plan.moves.find((m) => m.oldKey === oldA)!.newKey).toBe(transcriptProjectKey(cwdA));
        expect(plan.moves.find((m) => m.oldKey === oldB)!.newKey).toBe(transcriptProjectKey(cwdB));
        // The two reserved buckets are policy, not an observation: they are never migrated.
        expect(plan.preserved).toEqual(["_global", "_assistant"]);
        expect(plan.moves.some((m) => m.oldKey === "_assistant" || m.newKey === "_assistant")).toBe(false);
        // A directory no record names is left alone — and said so, rather than silently ignored.
        expect(plan.unreferenced).toContain("stray-project");
        expect(plan.unreferenced).not.toContain("_assistant");

        expect(manifest(rs).map((r) => r.status)).toEqual(["planned", "planned"]);
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
        const plan = planMemoryKeyMigration({ rs, home, records });
        expect(plan.moves).toEqual([]);
        expect(plan.collisions).toEqual([]);
        expect(manifest(rs)).toEqual([]);
      } finally {
        rs.close();
      }
    });
  });
});

describe("applyMemoryKeyMigration", () => {
  test("renames the trees, marks the manifest moved, and leaves the reserved buckets alone", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const cwdA = workdir(home, "a");
      const cwdB = workdir(home, "b");
      store.createSession("work", { cwd: cwdA });
      store.createSession("work", { cwd: cwdB });
      const oldA = seedMemory(home, cwdA, "alpha");
      const oldB = seedMemory(home, cwdB, "beta");
      mkdirSync(join(home, "projects", "_assistant", "memory"), { recursive: true });
      writeFileSync(join(home, "projects", "_assistant", "memory", "MEMORY.md"), "dreams");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records });
        expect(applyMemoryKeyMigration({ rs, home }, plan)).toEqual({ moved: 2 });

        expect(existsSync(join(home, "projects", oldA))).toBe(false);
        expect(existsSync(join(home, "projects", oldB))).toBe(false);
        expect(readFileSync(join(home, "projects", transcriptProjectKey(cwdA), "memory", "MEMORY.md"), "utf8")).toBe("alpha");
        expect(readFileSync(join(home, "projects", transcriptProjectKey(cwdB), "memory", "notes", "one.md"), "utf8")).toBe("beta — note");
        expect(readFileSync(join(home, "projects", "_assistant", "memory", "MEMORY.md"), "utf8")).toBe("dreams");
        expect(manifest(rs).map((r) => r.status)).toEqual(["moved", "moved"]);
      } finally {
        rs.close();
      }
    });
  });

  test("rollback restores byte-identical trees and marks the manifest rolled-back", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const cwdA = workdir(home, "a");
      const cwdB = workdir(home, "b");
      store.createSession("work", { cwd: cwdA });
      store.createSession("work", { cwd: cwdB });
      seedMemory(home, cwdA, "alpha");
      seedMemory(home, cwdB, "beta");
      mkdirSync(join(home, "projects", "_assistant", "memory"), { recursive: true });
      writeFileSync(join(home, "projects", "_assistant", "memory", "MEMORY.md"), "dreams");
      const before = snapshotTree(join(home, "projects"));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records });
        applyMemoryKeyMigration({ rs, home }, plan);
        expect(snapshotTree(join(home, "projects"))).not.toEqual(before);

        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 2 });
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
        expect(manifest(rs).map((r) => r.status)).toEqual(["rolled-back", "rolled-back"]);
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
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        seedRecord(rs, "s_one", "one-old", "shared-new");
        seedRecord(rs, "s_two", "two-old", "shared-new");
        for (const key of ["one-old", "two-old"]) {
          mkdirSync(join(home, "projects", key, "memory"), { recursive: true });
          writeFileSync(join(home, "projects", key, "memory", "MEMORY.md"), key);
        }
        const before = snapshotTree(join(home, "projects"));

        const plan = planMemoryKeyMigration({ rs, home, records: new RuntimeSessionRecords(rs) });
        expect(plan.collisions.length).toBe(1);
        expect(plan.collisions[0]!.newKey).toBe("shared-new");
        expect(plan.collisions[0]!.oldKeys.sort()).toEqual(["one-old", "two-old"]);
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
    // Today's memory key is the REPO ROOT's; the compatibility key is the CWD's. Two sessions in
    // one repo at different cwds therefore share one memory dir and want two destinations — one
    // directory cannot be renamed to two places, and guessing which would lose a project's memory.
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        seedRecord(rs, "s_one", "repo-old", "repo-new");
        seedRecord(rs, "s_two", "repo-old", "repo-sub-new");
        mkdirSync(join(home, "projects", "repo-old", "memory"), { recursive: true });
        writeFileSync(join(home, "projects", "repo-old", "memory", "MEMORY.md"), "shared");
        const before = snapshotTree(join(home, "projects"));

        const plan = planMemoryKeyMigration({ rs, home, records: new RuntimeSessionRecords(rs) });
        expect(plan.collisions.map((c) => c.reason)).toEqual(["old-key-fans-out", "old-key-fans-out"]);
        expect(plan.collisions.map((c) => c.newKey).sort()).toEqual(["repo-new", "repo-sub-new"]);
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
      const rs = openRuntimeStateDb(home);
      try {
        seedRecord(rs, "s_one", "occupied-old", "occupied-new");
        mkdirSync(join(home, "projects", "occupied-old", "memory"), { recursive: true });
        writeFileSync(join(home, "projects", "occupied-old", "memory", "MEMORY.md"), "mine");
        mkdirSync(join(home, "projects", "occupied-new", "memory"), { recursive: true });
        writeFileSync(join(home, "projects", "occupied-new", "memory", "MEMORY.md"), "someone else's");
        const before = snapshotTree(join(home, "projects"));

        const plan = planMemoryKeyMigration({ rs, home, records: new RuntimeSessionRecords(rs) });
        expect(plan.collisions.map((c) => c.reason)).toEqual(["target-exists"]);
        expect(plan.moves).toEqual([]);
        expect(() => applyMemoryKeyMigration({ rs, home }, plan)).toThrow(MemoryKeyCollisionError);
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
      } finally {
        rs.close();
      }
    });
  });

  test("re-planning after an applied migration finds nothing left to do and never resets the manifest", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const cwd = workdir(home, "a");
      store.createSession("work", { cwd });
      seedMemory(home, cwd, "alpha");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records }));
        expect(manifest(rs).map((r) => r.status)).toEqual(["moved"]);

        const again = planMemoryKeyMigration({ rs, home, records });
        expect(again.moves).toEqual([]);
        expect(again.collisions).toEqual([]);
        // The already-migrated directory is not "unreferenced" either — a record names it.
        expect(again.unreferenced).toEqual([]);
        expect(manifest(rs).map((r) => r.status)).toEqual(["moved"]);
      } finally {
        rs.close();
      }
    });
  });

  test("a rename that landed without its manifest commit is reconciled by the next plan", async () => {
    // THE TORN-APPLY WINDOW. `apply` renames the tree and then commits the manifest row; a crash
    // between the two leaves a directory at the NEW key with its row still `planned`. The next run
    // starts with `plan`, which sees no source directory — so unless `plan` reconciles, the row
    // stays `planned` forever, `rollback` (which reads `status = 'moved'`) never sees it, and the
    // tree has no recorded way back. That is the one state the manifest exists to prevent.
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const cwd = workdir(home, "a");
      store.createSession("work", { cwd });
      const oldKey = seedMemory(home, cwd, "alpha");
      const before = snapshotTree(join(home, "projects"));

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const plan = planMemoryKeyMigration({ rs, home, records });
        expect(plan.moves.length).toBe(1);
        expect(manifest(rs).map((r) => r.status)).toEqual(["planned"]);

        // The crash: the rename landed, the commit did not.
        renameSync(join(home, "projects", oldKey), join(home, "projects", plan.moves[0]!.newKey));

        const resumed = planMemoryKeyMigration({ rs, home, records });
        expect(resumed.moves).toEqual([]);
        expect(resumed.collisions).toEqual([]);
        expect(manifest(rs).map((r) => r.status)).toEqual(["moved"]);

        // And the tree can still be put back, byte for byte.
        expect(rollbackMemoryKeyMigration({ rs, home })).toEqual({ rolledBack: 1 });
        expect(snapshotTree(join(home, "projects"))).toEqual(before);
      } finally {
        rs.close();
      }
    });
  });

  test("a rolled-back migration can be planned and applied again", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const cwd = workdir(home, "a");
      store.createSession("work", { cwd });
      seedMemory(home, cwd, "alpha");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records }));
        rollbackMemoryKeyMigration({ rs, home });
        expect(manifest(rs).map((r) => r.status)).toEqual(["rolled-back"]);

        // The second pass re-plans over the rolled-back row rather than leaving a stale terminal
        // status beside a directory that is plainly back at its old key.
        const second = planMemoryKeyMigration({ rs, home, records });
        expect(second.moves.length).toBe(1);
        expect(manifest(rs).map((r) => r.status)).toEqual(["planned"]);
        expect(applyMemoryKeyMigration({ rs, home }, second)).toEqual({ moved: 1 });
        expect(readFileSync(join(home, "projects", transcriptProjectKey(cwd), "memory", "MEMORY.md"), "utf8")).toBe("alpha");
      } finally {
        rs.close();
      }
    });
  });

  test("project memory is the only thing touched — no runtime record is rewritten", async () => {
    await withTempHome(async (home) => {
      _clearRepoRootCacheForTests();
      const store = new SessionStore(home);
      const cwd = workdir(home, "a");
      const id = store.createSession("work", { cwd });
      seedMemory(home, cwd, "alpha");

      const rs = openRuntimeStateDb(home);
      try {
        const records = new RuntimeSessionRecords(rs);
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const before = records.get(id)!;
        applyMemoryKeyMigration({ rs, home }, planMemoryKeyMigration({ rs, home, records }));
        // The manifest is the record of the move; the session record still states the key the
        // memory was written under, and re-keying it is a later phase's decision, not this one's.
        expect(records.get(id)).toEqual(before);
      } finally {
        rs.close();
      }
    });
  });
});
