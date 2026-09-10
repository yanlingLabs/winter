// WS-16 §14's crash matrix — the rows that are implementable against the 8a storage spine.
//
// SCOPE, STATED HONESTLY. Each row names an END STATE the system must be in after a particular
// crash. Three of the four rows here are DRIVEN by startup recovery and diagnostics
// (`recoverRuntimeState`, `diagnoseRuntimeState`, `repairRuntimeState`), which land in a sibling
// lane of this same phase. This file pins the end state itself, composed from the spine primitives
// that produce it — so the invariant is under test now, and the driver gets bound to it when
// recovery lands (see the per-row notes). What is NOT deferred is the substance: a dead pid must
// break a lease, an unknown identity must not, a `creating` record must never surface as live, and a
// re-projection after a lost cursor commit must not double-append.
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_TRANSITIONS, ProjectionCheckpoints, RuntimeLeases, RuntimeSessionRecords,
  RuntimeStateUnavailableError, openRuntimeStateDb, type LeaseProbe, type RuntimeStateDb,
} from "../../src/runtime-state";
import { SessionStore } from "../../src/sessions/store";
import { ISO, withTempHome } from "./support";

const SELF = { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" };
const DEAD = { pid: 999_001, startedAt: "2026-01-01T00:00:00.000Z" };

function seedRecord(rs: RuntimeStateDb, id: string): RuntimeSessionRecords {
  const records = new RuntimeSessionRecords(rs);
  records.create({
    winterSessionId: id, runtimeKind: "winter-agent", providerId: "codex-oauth", modelRef: "gpt-5.4",
    backendRoot: `/tmp/${id}`, transcriptProjectKey: `-tmp-${id}`, memoryProjectKey: `tmp-${id}`, tempProjectKey: `-tmp-${id}`,
    transcriptHealth: "clean", compatibilityLevel: "conversation", conformanceCorpusVersion: "legacy",
    versionProvenance: "legacy-unknown", capabilities: [],
    selection: { runtimeKind: "winter-agent", providerId: "codex-oauth", modelRef: "gpt-5.4", family: "legacy", authFamily: "custom", sdkVersion: "unknown", reason: "test", decidedAt: ISO() },
  });
  return records;
}

/** A probe that describes a machine without spawning anything on it. */
const probeOf = (alive: boolean, startedAt: string): LeaseProbe => ({ alive: () => alive, startedAt: () => startedAt });

describe("crash row (a) — runtime-state.db missing or corrupt refuses runtime routing until repaired", () => {
  test("a corrupt database refuses to open, typed, rather than handing back a half-usable handle", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      seedRecord(rs, "s_a");
      const path = rs.path;
      rs.close();

      writeFileSync(path, "this is not a sqlite file, it is a bug report someone pasted over it");
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });

      // The refusal is typed and names the reason: a caller must never have to parse SQL text to
      // learn that routing has to stop.
      let caught: unknown;
      try { openRuntimeStateDb(home); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(RuntimeStateUnavailableError);
      expect((caught as RuntimeStateUnavailableError).reason).toBe("corrupt");
      expect((caught as RuntimeStateUnavailableError).path).toBe(path);
    });
  });

  test("a missing database refuses a read-only open instead of inventing an empty one", async () => {
    await withTempHome(async (home) => {
      const path = join(home, "runtimes", "runtime-state.db");
      expect(existsSync(path)).toBe(false);
      let caught: unknown;
      try { openRuntimeStateDb(home, { readonly: true }); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(RuntimeStateUnavailableError);
      expect((caught as RuntimeStateUnavailableError).reason).toBe("missing");
    });
  });

  test("restoring a backup over the corrupt file makes it open again, with its rows intact", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      seedRecord(rs, "s_a");
      const backup = rs.backup();
      const path = rs.path;
      rs.close();

      writeFileSync(path, "corrupt");
      // THE SIDE-CAR TRAP, and why the repair op must do this too: a stale `-wal`/`-shm` beside a
      // restored main file is its own corruption — SQLite would replay a journal that describes a
      // database that no longer exists.
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      copyFileSync(backup, path);

      const reopened = openRuntimeStateDb(home);
      try {
        expect(reopened.integrity().ok).toBe(true);
        expect(new RuntimeSessionRecords(reopened).get("s_a")!.state).toBe("creating");
      } finally {
        reopened.close();
      }
    });
  });
});

describe("crash row (b) — machine restart with sessions running: reclassify after revalidation, never trust persisted liveness", () => {
  test("a lease whose holder is provably gone is broken and its session becomes unavailable", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = seedRecord(rs, "s_a");
        records.transition("s_a", "ready");
        const { generation } = records.bumpGeneration("s_a", { runtimeKind: "winter-agent" });
        // The lease was written by a process that no longer exists — the machine rebooted under it.
        new RuntimeLeases(rs, DEAD).acquire("s_a", generation);
        records.transition("s_a", "running");

        const leases = new RuntimeLeases(rs, SELF);
        const persisted = leases.holder("s_a")!;
        expect(persisted.holder.pid).toBe(DEAD.pid);
        // Persisted liveness is never trusted: the verdict comes from revalidating the process.
        expect(leases.revalidate(persisted, probeOf(false, "unknown"))).toBe("stale");
        expect(leases.breakStale("s_a", generation, "machine restart")).toBe(true);
        expect(leases.holder("s_a")).toBeUndefined();

        // The end state startup recovery must produce (step 2 of WS-16 §13; bound to
        // `recoverRuntimeState` when the recovery lane lands).
        expect(records.transition("s_a", "unavailable").state).toBe("unavailable");
        expect(records.list({ state: ["ready", "running", "idle"] })).toEqual([]);
      } finally {
        rs.close();
      }
    });
  });

  test("a lease whose holder is alive but unidentifiable is KEPT, and reported rather than broken", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = seedRecord(rs, "s_a");
        records.transition("s_a", "ready");
        const { generation } = records.bumpGeneration("s_a", { runtimeKind: "winter-agent" });
        // A LIVE pid whose recorded start time is `"unknown"` — the OS would not say when it
        // started. This process is the only pid a test can honestly claim is alive, and using it is
        // what makes `breakStale`'s own (uninjected, live) probe reach the "unknown" verdict rather
        // than the "dead pid" one a made-up number would produce.
        new RuntimeLeases(rs, { pid: process.pid, startedAt: "unknown" }).acquire("s_a", generation);
        records.transition("s_a", "running");

        const leases = new RuntimeLeases(rs, SELF);
        const persisted = leases.holder("s_a")!;
        // Alive, but the OS would not say when it started: neither proven live nor proven stale.
        expect(leases.revalidate(persisted, probeOf(true, "unknown"))).toBe("unknown");
        expect(leases.breakStale("s_a", generation, "machine restart")).toBe(false);
        expect(leases.holder("s_a")!.holder.startedAt).toBe("unknown");

        // The session is still parked as unavailable — we cannot revalidate it — but the lease that
        // might still have a live writer behind it is left exactly where it was.
        expect(records.transition("s_a", "unavailable").state).toBe("unavailable");
        expect(leases.holder("s_a")).toBeDefined();
      } finally {
        rs.close();
      }
    });
  });

  test("a pid reused by an unrelated process is stale, never adopted", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = seedRecord(rs, "s_a");
        records.transition("s_a", "ready");
        const { generation } = records.bumpGeneration("s_a", { runtimeKind: "winter-agent" });
        new RuntimeLeases(rs, DEAD).acquire("s_a", generation);

        const leases = new RuntimeLeases(rs, SELF);
        // The pid is alive again — but it started hours after the lease was written, so it is a
        // DIFFERENT process wearing the same number.
        expect(leases.revalidate(leases.holder("s_a")!, probeOf(true, "2026-01-01T06:00:00.000Z"))).toBe("stale");
      } finally {
        rs.close();
      }
    });
  });
});

describe("crash row (c) — a crash before the runtime mapping commit leaves no visible ready session", () => {
  test("a record stranded in creating settles as failed and is invisible to a live-session listing", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      try {
        const records = seedRecord(rs, "s_torn");
        expect(records.get("s_torn")!.state).toBe("creating");
        // It was never live and never can be reported as live, at any point before it settles.
        expect(records.list({ state: ["ready", "running", "idle"] })).toEqual([]);

        // Recovery's own transition (WS-16 §13; the driver binds when the recovery lane lands).
        expect(records.transition("s_torn", "failed").state).toBe("failed");
        expect(records.list({ state: ["ready", "running", "idle"] })).toEqual([]);
      } finally {
        rs.close();
      }
    });
  });

  test("the lifecycle makes a half-created session structurally unable to appear as running", () => {
    // The stronger statement, straight off the state machine: `creating` has exactly two exits, and
    // neither is a live state. No recovery bug can produce a visible running session from a torn
    // mapping commit, because there is no edge that would allow it.
    expect(ALLOWED_TRANSITIONS.creating).toEqual(["ready", "failed"]);
    expect(ALLOWED_TRANSITIONS.creating).not.toContain("running");
    expect(ALLOWED_TRANSITIONS.creating).not.toContain("idle");
  });
});

describe("crash row (d) — a crash after the event append but before the cursor commit re-projects without duplicating", () => {
  const lines = (path: string): number => readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;

  test("a pending mark whose events ARE in the product log commits, and nothing is appended twice", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const sessionId = store.createSession("work", {});
      const rs = openRuntimeStateDb(home);
      try {
        const checkpoints = new ProjectionCheckpoints(rs);
        const key = { winterSessionId: sessionId, generation: 1, sourceId: "call-42" };

        // Step 1 claimed the source, step 2 appended the product event — and then the process died
        // before step 3 could commit the mark and advance the cursor.
        expect(checkpoints.begin(key)).toBe("begun");
        store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "call-42", name: "read", argsJson: "{}" });
        const logPath = store.transcriptPath(sessionId);
        const linesAfterAppend = lines(logPath);

        const pending = checkpoints.pending(sessionId);
        expect(pending.length).toBe(1);
        // The product log tail is the only witness that can tell "the append landed" from "neither
        // step ran" — it is the thing the append actually wrote.
        const tailContains = (mark: { sourceId: string }): boolean =>
          store.read(sessionId).some((e) => e.type === "tool_call" && e.callId === mark.sourceId);
        expect(checkpoints.resolvePending(pending[0]!, tailContains)).toBe("committed");

        // The projector now asks again — and is told to skip, which is what prevents the duplicate.
        expect(checkpoints.begin(key)).toBe("already-committed");
        expect(lines(logPath)).toBe(linesAfterAppend);
        expect(store.read(sessionId).filter((e) => e.type === "tool_call").length).toBe(1);
      } finally {
        rs.close();
      }
    });
  });

  test("a pending mark whose events never landed resets, so the projector re-applies exactly once", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const sessionId = store.createSession("work", {});
      const rs = openRuntimeStateDb(home);
      try {
        const checkpoints = new ProjectionCheckpoints(rs);
        const key = { winterSessionId: sessionId, generation: 1, sourceId: "call-7" };
        expect(checkpoints.begin(key)).toBe("begun");
        // The crash landed between step 1 and step 2: nothing was appended.
        const pending = checkpoints.pending(sessionId);
        expect(checkpoints.resolvePending(pending[0]!, () => false)).toBe("reset");

        expect(checkpoints.begin(key)).toBe("begun");
        store.append(sessionId, { type: "tool_call", sessionId, threadId: "main", callId: "call-7", name: "read", argsJson: "{}" });
        checkpoints.complete(key, { runtimeKind: "winter-agent", backendCursor: "1", lastWinterSeq: 2 }, { first: 2, last: 2 });

        expect(checkpoints.begin(key)).toBe("already-committed");
        expect(store.read(sessionId).filter((e) => e.type === "tool_call").length).toBe(1);
      } finally {
        rs.close();
      }
    });
  });

  test("resolving a mark that has already been resolved reports it and changes nothing", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const sessionId = store.createSession("work", {});
      const rs = openRuntimeStateDb(home);
      try {
        const checkpoints = new ProjectionCheckpoints(rs);
        const key = { winterSessionId: sessionId, generation: 1, sourceId: "call-1" };
        checkpoints.begin(key);
        const [mark] = checkpoints.pending(sessionId);
        expect(checkpoints.resolvePending(mark!, () => true)).toBe("committed");
        // A second sweep holding the same stale VALUE must not erase the committed mark — that is
        // exactly the double-append this class exists to prevent.
        expect(checkpoints.resolvePending(mark!, () => false)).toBe("already-resolved");
        expect(checkpoints.begin(key)).toBe("already-committed");
      } finally {
        rs.close();
      }
    });
  });
});
