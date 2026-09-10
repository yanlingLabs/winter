import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { RuntimeSessionRecords, type NewRuntimeSessionRecord } from "../../src/runtime-state/records";
import { RuntimeLeases, processStartedAt, type ProcessIdentity } from "../../src/runtime-state/leases";
import { RuntimeChildren, type PersistedWinterChild } from "../../src/runtime-state/children";
import { recoverRuntimeState, type RecoveryDeps, type RecoveryReport } from "../../src/runtime-state/recovery";
import { SessionStore } from "../../src/sessions/store";
import { ISO, withTempHome } from "./support";

/** A pid the kernel cannot have handed out: macOS caps pids at 99999, so `kill(pid, 0)` is ESRCH
 *  forever. That matters beyond convenience — `breakStale` re-proves staleness with the LIVE probe
 *  (it is deliberately not injectable), so a lease seeded with a *genuinely* dead holder is the only
 *  fixture where recovery's verdict and the break can agree without faking either. */
const DEAD_PID = 4194304;

const SELF = (): ProcessIdentity => ({ pid: process.pid, startedAt: processStartedAt(process.pid) });

const selection = (): RuntimeSelection => ({
  runtimeKind: "winter-agent",
  providerId: "openai",
  modelRef: "gpt-5.6-sol",
  family: "openai",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "test",
  decidedAt: ISO(),
});

const newRecord = (home: string, id: string, over: Partial<NewRuntimeSessionRecord> = {}): NewRuntimeSessionRecord => ({
  winterSessionId: id,
  runtimeKind: "winter-agent",
  providerId: "openai",
  modelRef: "gpt-5.6-sol",
  backendRoot: join(home, "projects", "-tmp-work"),
  transcriptProjectKey: "-tmp-work",
  memoryProjectKey: "-tmp-work",
  tempProjectKey: "-tmp-work",
  transcriptHealth: "clean",
  compatibilityLevel: "conversation",
  conformanceCorpusVersion: "2026-09",
  versionProvenance: "recorded",
  sdkVersion: "0.0.2",
  engineVersion: "0.0.2",
  providerCatalogVersion: "0.0.2",
  providerAdapterVersion: "0.0.2",
  capabilities: [],
  selection: selection(),
  ...over,
});

const newChild = (parent: string, childId: string, over: Partial<PersistedWinterChild> = {}): PersistedWinterChild => ({
  parentWinterSessionId: parent,
  childId,
  agentType: "general-purpose",
  providerId: "openai",
  modelRef: "gpt-5.6-sol",
  providerCatalogVersion: "0.0.2",
  providerAdapterVersion: "0.0.2",
  status: "running",
  transcriptRef: "agent-1.jsonl",
  startedAt: ISO(),
  generation: 1,
  ...over,
});

interface AttemptRow {
  step: number;
  winter_session_id: string | null;
  outcome: string;
  detail_json: string;
  daemon_pid: number;
}

interface Harness {
  home: string;
  rs: RuntimeStateDb;
  store: SessionStore;
  records: RuntimeSessionRecords;
  leases: RuntimeLeases;
  children: RuntimeChildren;
  /** EVERY run goes through here, so no test can forget `tempScanRoot` and send step 8's scan at
   *  the real `/private/tmp/norma-<uid>` on the developer's machine. */
  run(over?: Partial<RecoveryDeps>): Promise<RecoveryReport>;
  attempts(): AttemptRow[];
}

/** One temp home, one db handle, one store — all closed on the way out even when an assertion
 *  throws (a leaked handle keeps -wal sidecars alive under the home being rm'd). */
const withHarness = (fn: (h: Harness) => Promise<void>): Promise<void> =>
  withTempHome(async (home) => {
    const rs = openRuntimeStateDb(home);
    const store = new SessionStore(home);
    try {
      await fn({
        home,
        rs,
        store,
        records: new RuntimeSessionRecords(rs),
        leases: new RuntimeLeases(rs, SELF()),
        children: new RuntimeChildren(rs),
        run: (over = {}) => recoverRuntimeState({ home, rs, store, self: SELF(), tempScanRoot: join(home, "tmp-scan"), ...over }),
        attempts: () =>
          rs.db
            .query<AttemptRow, []>("SELECT step, winter_session_id, outcome, detail_json, daemon_pid FROM runtime_recovery_attempts ORDER BY id")
            .all(),
      });
    } finally {
      store.close();
      rs.close();
    }
  });

/** A record parked in one of the three live states, with a generation to hang a lease on. */
const seedLive = (h: Harness, id: string, state: "running" | "ready" | "idle"): void => {
  h.records.create(newRecord(h.home, id));
  h.records.transition(id, "ready");
  if (state !== "ready") h.records.transition(id, state);
  h.records.bumpGeneration(id, { runtimeKind: "winter-agent" });
};

describe("recoverRuntimeState — WS-16 §13's twelve steps", () => {
  test("live records park unavailable, a stale lease breaks, a running child is interrupted", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_live", "running");
      seedLive(h, "s_idle", "idle");
      h.records.create(newRecord(h.home, "s_done"));
      h.records.transition("s_done", "ready");
      h.records.transition("s_done", "exited");

      // A lease recorded by a process that is provably gone.
      new RuntimeLeases(h.rs, { pid: DEAD_PID, startedAt: ISO() }).acquire("s_live", 1);
      h.children.upsert(newChild("s_live", "c1"));

      const report = await h.run();

      expect(h.records.get("s_live")?.state).toBe("unavailable");
      expect(h.records.get("s_idle")?.state).toBe("unavailable");
      expect(h.records.get("s_done")?.state).toBe("exited");
      expect(h.leases.holder("s_live")).toBeUndefined();
      expect(h.children.get("s_live", "c1")?.status).toBe("interrupted");

      expect(report.ok).toBe(true);
      expect(report.sessionsSeen).toBe(3);
      expect(report.markedUnavailable).toBe(2);
      expect(report.reclassified).toEqual([{ parent: "s_live", childId: "c1" }]);
      expect(report.corrupt).toEqual([]);
      expect(report.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(new Date(report.finishedAt).getTime()).toBeGreaterThanOrEqual(new Date(report.startedAt).getTime());

      const rows = h.attempts();
      expect(rows.length).toBeGreaterThanOrEqual(12);
      expect(rows.every((r) => r.daemon_pid === process.pid)).toBe(true);
    });
  });

  test("a corrupt record is reported and every other session is still processed", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_bad", "running");
      seedLive(h, "s_good", "running");
      // Beyond every typed door: the row can no longer be read back as a record at all.
      h.rs.db.run("UPDATE runtime_sessions SET selection_json = ? WHERE winter_session_id = ?", ["{not json", "s_bad"]);

      const report = await h.run();

      expect(report.corrupt).toEqual(["s_bad"]);
      // Bounded: the sweep continued past the throw…
      expect(h.records.get("s_good")?.state).toBe("unavailable");
      // …and parked the unreadable session anyway, through the raw fallback.
      const raw = h.rs.db.query("SELECT state FROM runtime_sessions WHERE winter_session_id = ?").get("s_bad") as { state: string };
      expect(raw.state).toBe("unavailable");
      // `ok` means "every step completed", and a handled per-session throw is the boundedness
      // guarantee working — never a reason to refuse the daemon its boot.
      expect(report.ok).toBe(true);
      expect(report.steps.length).toBe(12);

      const failed = h.attempts().filter((r) => r.winter_session_id === "s_bad");
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0]!.outcome).toBe("failed");
      // The error MESSAGE is never recorded — a JSON parse error echoes the payload it choked on.
      expect(JSON.parse(failed[0]!.detail_json)).toEqual({ step: 2, errorName: "SyntaxError" });
    });
  });

  test("recovery diagnostics carry counts, ids and paths only — never bodies or secrets", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_live", "running");
      h.rs.db.run(
        "INSERT INTO global_messages (message_id, message_json, to_generation, claimed_by, updated_at) VALUES (?, ?, 1, 'winter-agent', ?)",
        ["m1", JSON.stringify({ body: "here is my key sk-live-1234 please use it" }), ISO()],
      );
      h.rs.db.run(
        "INSERT INTO held_messages (receiver, message_id, reason, kind, held_at, message_json) VALUES (?, ?, 'idle', 'default', 1, ?)",
        ["s_live", "m2", JSON.stringify({ body: "ANTHROPIC_API_KEY=abc", encrypted_content: "opaque", itemJson: "{}" })],
      );

      await h.run();

      const serialized = h.attempts().map((r) => r.detail_json).join("\n");
      for (const secret of ["sk-live-1234", "ANTHROPIC_", "encrypted_content", "itemJson"]) {
        expect(serialized).not.toContain(secret);
      }
      // Step 10 still SAW them: it reports how many, never what.
      const step10 = h.attempts().find((r) => r.step === 10 && r.winter_session_id === null);
      expect(JSON.parse(step10!.detail_json)).toMatchObject({ heldMessages: 1, claimedWithoutReceipt: 1 });
    });
  });

  test("a reattach hook keeps its record ready: running → unavailable → ready", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_live", "running");
      const seen: string[] = [];

      const report = await h.run({
        hooks: {
          reattach: async (record, generation) => {
            // Step 2 has already run, so the hook observes the parked state — that observation IS
            // the middle of the `running → unavailable → ready` path.
            seen.push(h.records.get(record.winterSessionId)!.state);
            expect(generation.generation).toBe(1);
            return "reattached";
          },
        },
      });

      expect(seen).toEqual(["unavailable"]);
      expect(h.records.get("s_live")?.state).toBe("ready");
      expect(report.steps.find((s) => s.step === 5)?.detail).toMatchObject({ reattached: 1 });
    });
  });

  test("no auto-resume: recovery never transitions anything back to running", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_a", "running");
      seedLive(h, "s_b", "idle");

      const report = await h.run({ hooks: { reattach: async () => "reattached" } });

      const running = h.rs.db.query("SELECT COUNT(*) AS n FROM runtime_sessions WHERE state = 'running'").get() as { n: number };
      expect(running.n).toBe(0);
      expect(report.steps.find((s) => s.step === 9)?.detail).toMatchObject({ autoResumed: 0, running: 0 });
    });
  });

  test("a lease whose holder is alive but unidentifiable is left in place and reported", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_live", "running");
      // Live pid, no start identity: WS-16 §11's third answer. Never stale, never broken.
      new RuntimeLeases(h.rs, { pid: process.pid, startedAt: "unknown" }).acquire("s_live", 1);

      const report = await h.run();

      expect(h.leases.holder("s_live")?.holder.pid).toBe(process.pid);
      expect(report.steps.find((s) => s.step === 4)?.detail).toMatchObject({ checked: 1, unknown: 1, stale: 0, live: 0 });
      expect(report.steps.find((s) => s.step === 5)?.detail).toMatchObject({ broken: 0, unknownLeft: 1 });
    });
  });

  test("an injected probe governs the verdict, but a break is still proved against the live machine", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_live", "running");
      new RuntimeLeases(h.rs, { pid: process.pid, startedAt: processStartedAt(process.pid) }).acquire("s_live", 1);

      // The probe LIES: it calls this very process gone. `breakStale` re-proves with the live probe
      // and refuses — an injected fiction can never take a live writer's lease away.
      const report = await h.run({ probe: { alive: () => false, startedAt: () => "unknown" } });

      expect(report.steps.find((s) => s.step === 4)?.detail).toMatchObject({ stale: 1 });
      expect(report.steps.find((s) => s.step === 5)?.detail).toMatchObject({ broken: 0, breakRefused: 1 });
      expect(h.leases.holder("s_live")?.holder.pid).toBe(process.pid);
    });
  });

  test("a child the hook proves still alive is kept running", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_live", "running");
      h.children.upsert(newChild("s_live", "alive"));
      h.children.upsert(newChild("s_live", "gone"));

      const report = await h.run({ hooks: { isChildGone: (child) => child.childId === "gone" } });

      expect(h.children.get("s_live", "alive")?.status).toBe("running");
      expect(h.children.get("s_live", "gone")?.status).toBe("interrupted");
      expect(report.reclassified).toEqual([{ parent: "s_live", childId: "gone" }]);
      expect(report.steps.find((s) => s.step === 7)?.detail).toMatchObject({ interrupted: 1, kept: 1 });
    });
  });

  test("step 8 reports temp orphans and deletes nothing", async () => {
    await withHarness(async (h) => {
      const scanRoot = join(h.home, "tmp-scan");
      const known = join(scanRoot, "-tmp-work", "11111111-2222-4333-8444-555555555555");
      const orphan = join(scanRoot, "-tmp-abandoned");
      mkdirSync(known, { recursive: true });
      mkdirSync(orphan, { recursive: true });
      mkdirSync(join(scanRoot, ".runtime", "resume-staging"), { recursive: true });

      h.records.create(newRecord(h.home, "s_live"));
      h.records.transition("s_live", "ready");
      h.records.bumpGeneration("s_live", { runtimeKind: "winter-agent", localWriteRoot: known });

      const report = await h.run();

      const step8 = report.steps.find((s) => s.step === 8)!;
      expect(step8.detail.orphans).toEqual([orphan]);
      expect(step8.detail.known).toBe(1);
      // Report only: 8a never deletes, and never opens a file under the scan root.
      expect(existsSync(orphan)).toBe(true);
      expect(existsSync(known)).toBe(true);
    });
  });

  test("step 6's repair-required verdict marks the record's transcript health", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_live", "running");

      await h.run({ hooks: { reconcileLocalWriteRoot: async () => "repair-required" } });

      expect(h.records.get("s_live")?.transcriptHealth).toBe("repair-required");
    });
  });

  test("a transcript-tail hook is consulted per record, and the open projection window is reported", async () => {
    await withHarness(async (h) => {
      seedLive(h, "s_live", "running");
      h.rs.db.run(
        "INSERT INTO projection_applied (winter_session_id, generation, source_id, state, updated_at) VALUES (?, 1, 'call_1', 'pending', ?)",
        ["s_live", ISO()],
      );

      const asked: string[] = [];
      const report = await h.run({
        hooks: {
          reconcileTranscriptTail: async (record) => {
            asked.push(record.winterSessionId);
            return "quarantined";
          },
        },
      });

      expect(asked).toEqual(["s_live"]);
      expect(report.steps.find((s) => s.step === 3)?.detail).toMatchObject({ quarantined: 1, pendingMarks: 1 });
    });
  });
});
