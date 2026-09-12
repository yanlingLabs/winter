// WS-16 §14's crash matrix — the rows that are implementable against the 8a storage spine.
//
// SCOPE. Each row names an END STATE the system must be in after a particular crash. Three of the
// four rows are DRIVEN by startup recovery and diagnostics (`recoverRuntimeState`,
// `diagnoseRuntimeState`, `repairRuntimeState`) — and as of Task 12 every one of those rows CALLS
// its driver rather than performing the transition by hand. The substance under test: a dead pid
// must break a lease, an unknown identity must not, a `creating` record must never surface as live,
// and a re-projection after a lost cursor commit must not double-append.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_TRANSITIONS, ProjectionCheckpoints, RuntimeLeases, RuntimeSessionRecords,
  RuntimeStateUnavailableError, diagnoseRuntimeState, openRuntimeStateDb, recoverRuntimeState,
  repairRuntimeState, type LeaseProbe, type RuntimeStateDb,
} from "../../src/runtime-state";
import { SessionStore } from "../../src/sessions/store";
import { ISO, withTempHome } from "./support";

const SELF = { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" };
const DEAD = { pid: 999_001, startedAt: "2026-01-01T00:00:00.000Z" };

/** A recovery run over a temp home, with step 8's scan (AND, Major 1, its `claude-resume-*` staging
 *  sweep) pointed at that home rather than at the developer's real `/private/tmp/norma-<uid>`.
 *  This file calls `recoverRuntimeState` directly rather than through `startRuntimeState`, so
 *  `support.ts`'s `NORMA_CLAUDE_RESUME_SCAN_ROOT` env seam is never consulted here — the explicit
 *  dep is the only thing that keeps this file off the real machine's tmpdir. `probe` describes the
 *  machine the leases claim. */
const recover = (home: string, rs: RuntimeStateDb, store: SessionStore, probe?: LeaseProbe) =>
  recoverRuntimeState({ home, rs, store, self: SELF, probe, tempScanRoot: join(home, "tmp-scan"), claudeResumeScanRoot: join(home, "claude-resume-scan") });

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
  test("a corrupt database refuses to open, typed, and `norma doctor` reports it as the ONLY finding", async () => {
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

      // §14: an authoritative store that will not open refuses routing and NOTHING further is
      // inferred from the rebuildable index — so the diagnosis is exactly one finding.
      const findings = await diagnoseRuntimeState(home);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("db-corrupt");
      expect(findings[0]!.repairable).toContain("restore-backup");
    });
  });

  test("a missing database refuses a read-only open, and the doctor reports db-missing", async () => {
    await withTempHome(async (home) => {
      const path = join(home, "runtimes", "runtime-state.db");
      expect(existsSync(path)).toBe(false);
      let caught: unknown;
      try { openRuntimeStateDb(home, { readonly: true }); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(RuntimeStateUnavailableError);
      expect((caught as RuntimeStateUnavailableError).reason).toBe("missing");

      const findings = await diagnoseRuntimeState(home);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("db-missing");
    });
  });

  test("`repairRuntimeState` restores a backup over the corrupt file, sidecars and all", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      seedRecord(rs, "s_a");
      const backup = rs.backup();
      const path = rs.path;
      rs.close();

      writeFileSync(path, "corrupt");
      // THE SIDE-CAR TRAP: a stale `-wal`/`-shm` beside a restored main file is its own corruption
      // — SQLite would replay a journal that describes a database that no longer exists. The repair
      // op has to clear them itself; this test leaves them in place so that it must.
      expect(existsSync(`${path}-wal`)).toBe(true);

      const result = await repairRuntimeState(home, { kind: "restore-backup", backupPath: backup });
      expect(result.applied).toBe(true);
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);

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
  test("a lease whose holder is provably gone is broken by recovery and its session becomes unavailable", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const rs = openRuntimeStateDb(home);
      try {
        const records = seedRecord(rs, "s_a");
        records.transition("s_a", "ready");
        const { generation } = records.bumpGeneration("s_a", { runtimeKind: "winter-agent" });
        // The lease was written by a process that no longer exists — the machine rebooted under it.
        new RuntimeLeases(rs, DEAD).acquire("s_a", generation);
        records.transition("s_a", "running");

        const leases = new RuntimeLeases(rs, SELF);
        expect(leases.holder("s_a")!.holder.pid).toBe(DEAD.pid);

        // THE DRIVER: startup recovery, not a hand-written transition. Persisted liveness is never
        // trusted — the verdict comes from revalidating the process behind the lease.
        const report = await recover(home, rs, store, probeOf(false, "unknown"));

        expect(report.ok).toBe(true);
        expect(report.markedUnavailable).toBe(1);
        expect(report.steps.find((s) => s.step === 4)?.detail).toMatchObject({ checked: 1, stale: 1 });
        expect(report.steps.find((s) => s.step === 5)?.detail).toMatchObject({ broken: 1 });
        expect(leases.holder("s_a")).toBeUndefined();
        expect(records.get("s_a")!.state).toBe("unavailable");
        expect(records.list({ state: ["ready", "running", "idle"] })).toEqual([]);
      } finally {
        rs.close();
        store.close();
      }
    });
  });

  test("a lease whose holder is alive but unidentifiable is KEPT, and reported rather than broken", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
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

        const report = await recover(home, rs, store, probeOf(true, "unknown"));

        // Neither proven live nor proven stale: the session is still parked (we cannot revalidate
        // it), but the lease that might still have a live writer behind it is left exactly where it
        // was — breaking it is how two writers reach one transcript.
        expect(report.steps.find((s) => s.step === 4)?.detail).toMatchObject({ checked: 1, unknown: 1, stale: 0 });
        expect(report.steps.find((s) => s.step === 5)?.detail).toMatchObject({ broken: 0, unknownLeft: 1 });
        expect(records.get("s_a")!.state).toBe("unavailable");
        expect(new RuntimeLeases(rs, SELF).holder("s_a")!.holder.startedAt).toBe("unknown");
      } finally {
        rs.close();
        store.close();
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
  test("recovery settles a record stranded in creating as failed, and it is never live in between", async () => {
    await withTempHome(async (home) => {
      const store = new SessionStore(home);
      const rs = openRuntimeStateDb(home);
      try {
        const records = seedRecord(rs, "s_torn");
        expect(records.get("s_torn")!.state).toBe("creating");
        // It was never live and never can be reported as live, at any point before it settles.
        expect(records.list({ state: ["ready", "running", "idle"] })).toEqual([]);

        // THE DRIVER: §13 step 2 settles what a torn creation left behind. Without it the record
        // would sit in `creating` forever — reported `alreadyPresent` by every later backfill and
        // repaired by nothing.
        const report = await recover(home, rs, store);

        expect(report.steps.find((s) => s.step === 2)?.detail).toMatchObject({ stranded: 1, settled: 1 });
        expect(records.get("s_torn")!.state).toBe("failed");
        expect(records.list({ state: ["ready", "running", "idle"] })).toEqual([]);
      } finally {
        rs.close();
        store.close();
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
