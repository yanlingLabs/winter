import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoutineStore, type Routine, type RoutineStore } from "../../src/routines/store";
import { makeRoutineScheduler, type RoutineRunner } from "../../src/routines/scheduler";

type RunResult = { ok: boolean; quotaLimited?: boolean; resultText?: string; error?: string };
type PendingCall = {
  opts: { prompt: string; policy: "auto" | "plan"; cwd: string; origin: string };
  resolve: (r: RunResult) => void;
  reject: (e: unknown) => void;
};

/** A RoutineRunner whose runHeadless() never resolves on its own — each call is captured in
 *  `calls` so the test can resolve/reject it at a chosen moment, to pin down ordering
 *  (parallel-start, cap-serialization, overlapping-tick) precisely. */
function makeControllableRunner(): { runner: RoutineRunner; calls: PendingCall[] } {
  const calls: PendingCall[] = [];
  const runner: RoutineRunner = {
    runHeadless(opts) {
      return new Promise<RunResult>((resolve, reject) => {
        calls.push({ opts, resolve, reject });
      });
    },
  };
  return { runner, calls };
}

function makeStore(): { store: RoutineStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "winter-scheduler-"));
  return { store: openRoutineStore(join(dir, "routines.db")), dir };
}

function makeAudit(): { audit: (line: object) => void; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return { audit: (line: object) => { lines.push(line as Record<string, unknown>); }, lines };
}

describe("makeRoutineScheduler — due-fire", () => {
  test("fires a due routine: calls runner with prompt/policy/cwd/origin, records the run on success", async () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 1s", prompt: "check inbox", policy: "auto", cwd: "/tmp/proj" });
    const now = routine.nextRunAt + 10;
    const { runner, calls } = makeControllableRunner();
    const { audit, lines } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now });

    const tickPromise = sched.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toEqual({ prompt: "check inbox", policy: "auto", cwd: "/tmp/proj", origin: `routine/${routine.id}` });
    expect(sched.runningCount()).toBe(1);

    calls[0]!.resolve({ ok: true, resultText: "done: 3 unread" });
    await tickPromise;

    expect(sched.runningCount()).toBe(0);
    const updated = store.get(routine.id)!;
    expect(updated.lastRunAt).toBe(now);
    expect(updated.lastResult).toBe("done: 3 unread");
    expect(updated.deferAttempts).toBe(0);

    expect(lines).toHaveLength(1); // fire only — success adds no extra audit line
    expect(lines[0]).toEqual({ op: "fire", id: routine.id, spec: "every 1s", origin: `routine/${routine.id}` });
  });

  test("a routine not yet due is not fired", async () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 1h", prompt: "x" });
    const { runner, calls } = makeControllableRunner();
    const { audit } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => routine.nextRunAt - 1000 });

    await sched.tick();
    expect(calls).toHaveLength(0);
  });
});

describe("makeRoutineScheduler — parallel fires", () => {
  test("two due routines both start before either resolves (no serialization)", async () => {
    const { store } = makeStore();
    const r1 = store.create({ spec: "every 1s", prompt: "a" });
    const r2 = store.create({ spec: "every 1s", prompt: "b" });
    const now = Math.max(r1.nextRunAt, r2.nextRunAt) + 10;
    const { runner, calls } = makeControllableRunner();
    const { audit } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now });

    const tickPromise = sched.tick();
    // Both fires must have been dispatched synchronously — neither is waiting on the other.
    expect(calls).toHaveLength(2);
    expect(sched.runningCount()).toBe(2);

    calls[0]!.resolve({ ok: true, resultText: "1" });
    calls[1]!.resolve({ ok: true, resultText: "2" });
    await tickPromise;

    expect(store.get(r1.id)!.lastResult).toBe("1");
    expect(store.get(r2.id)!.lastResult).toBe("2");
  });

  test("maxConcurrent=1 fires only one this tick; the other waits for the NEXT tick (not chained)", async () => {
    const { store } = makeStore();
    const r1 = store.create({ spec: "every 1s", prompt: "a" });
    const r2 = store.create({ spec: "every 1s", prompt: "b" });
    const now = Math.max(r1.nextRunAt, r2.nextRunAt) + 10;
    const { runner, calls } = makeControllableRunner();
    const { audit } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now, maxConcurrent: () => 1 });

    const tick1 = sched.tick();
    expect(calls).toHaveLength(1); // only one fired this tick
    calls[0]!.resolve({ ok: true, resultText: "done" });
    await tick1;
    // The second routine was NOT chained/fired automatically once the slot freed up mid-tick.
    expect(calls).toHaveLength(1);

    // A later, separate tick() picks up the still-due second routine.
    const tick2 = sched.tick();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ ok: true, resultText: "done2" });
    await tick2;
    expect(store.get(r2.id)!.lastResult).toBe("done2");
  });
});

describe("makeRoutineScheduler — quota-defer", () => {
  test("a quotaLimited result calls recordDefer (not recordRun) and audits a defer line", async () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 30m", prompt: "a" });
    const now = routine.nextRunAt + 10;
    const { runner, calls } = makeControllableRunner();
    const { audit, lines } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now });

    const tickPromise = sched.tick();
    calls[0]!.resolve({ ok: false, quotaLimited: true, error: "HTTP 429" });
    await tickPromise;

    const updated = store.get(routine.id)!;
    expect(updated.lastResult).toBe("deferred: quota");
    expect(updated.deferAttempts).toBe(1);
    expect(updated.nextRunAt).toBe(now + 30 * 60_000);
    expect(updated.lastRunAt).toBeNull(); // a defer does NOT count as a run

    expect(lines).toEqual([
      { op: "fire", id: routine.id, spec: "every 30m", origin: `routine/${routine.id}` },
      { op: "defer", id: routine.id, reason: "quota" },
    ]);
  });
});

describe("makeRoutineScheduler — error path", () => {
  test("a non-quota failure records a normal run (no defer-backoff) and audits an error line", async () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 30m", prompt: "a" });
    const now = routine.nextRunAt + 10;
    const { runner, calls } = makeControllableRunner();
    const { audit, lines } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now });

    const tickPromise = sched.tick();
    calls[0]!.resolve({ ok: false, error: "HTTP 500 — server error" });
    await tickPromise;

    const updated = store.get(routine.id)!;
    expect(updated.lastRunAt).toBe(now); // DOES count as a run — no quota backoff
    expect(updated.lastResult).toBe("HTTP 500 — server error");
    expect(updated.deferAttempts).toBe(0);
    expect(updated.nextRunAt).toBe(now + 30 * 60_000); // normal next schedule, not a backoff delay

    expect(lines).toEqual([
      { op: "fire", id: routine.id, spec: "every 30m", origin: `routine/${routine.id}` },
      { op: "error", id: routine.id, error: "HTTP 500 — server error" },
    ]);
  });

  test("a thrown/rejected runner promise is treated the same as ok:false (never throws out of tick)", async () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 30m", prompt: "a" });
    const now = routine.nextRunAt + 10;
    const { runner, calls } = makeControllableRunner();
    const { audit, lines } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now });

    const tickPromise = sched.tick();
    calls[0]!.reject(new Error("boom"));
    await expect(tickPromise).resolves.toBeUndefined();

    const updated = store.get(routine.id)!;
    expect(updated.lastResult).toBe("boom");
    expect(updated.deferAttempts).toBe(0);
    expect(lines.at(-1)).toEqual({ op: "error", id: routine.id, error: "boom" });
  });

  test("tick() never throws even when store.due() itself throws", async () => {
    const { store } = makeStore();
    const brokenStore = { ...store, due: () => { throw new Error("db is gone"); } } as unknown as RoutineStore;
    const { runner } = makeControllableRunner();
    const { audit } = makeAudit();
    const sched = makeRoutineScheduler({ store: brokenStore, runner, audit });
    await expect(sched.tick()).resolves.toBeUndefined();
  });
});

describe("makeRoutineScheduler — disabled mid-flight", () => {
  test("a routine disabled while its fire is in flight still records the result normally", async () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 30m", prompt: "a" });
    const now = routine.nextRunAt + 10;
    const { runner, calls } = makeControllableRunner();
    const { audit } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now });

    const tickPromise = sched.tick();
    store.update(routine.id, { enabled: false }); // disabled mid-flight
    calls[0]!.resolve({ ok: true, resultText: "done anyway" });
    await tickPromise;

    const updated = store.get(routine.id)!;
    expect(updated.enabled).toBe(false);
    expect(updated.lastResult).toBe("done anyway"); // still recorded
    expect(updated.lastRunAt).toBe(now);

    // But it no longer shows up as due (disabled keeps it out of due()) regardless of nextRunAt.
    expect(store.due(updated.nextRunAt + 1).map((r) => r.id)).not.toContain(routine.id);
  });
});

describe("makeRoutineScheduler — overlapping ticks", () => {
  test("an in-flight routine is not double-fired by a second, overlapping tick()", async () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 1s", prompt: "a" });
    const now = routine.nextRunAt + 10;
    const { runner, calls } = makeControllableRunner();
    const { audit } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now });

    const tick1 = sched.tick(); // fires, still pending — routine.nextRunAt in the store hasn't moved yet
    expect(calls).toHaveLength(1);

    const tick2 = sched.tick(); // due() would still return this routine, but the in-flight guard must skip it
    await tick2;
    expect(calls).toHaveLength(1); // still just the one call

    calls[0]!.resolve({ ok: true, resultText: "done" });
    await tick1;
    expect(calls).toHaveLength(1);
  });
});

describe("makeRoutineScheduler — start/stop", () => {
  test("start() ticks on an interval; stop() halts it (idempotent)", async () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 1s", prompt: "a" });
    let now = routine.nextRunAt + 10;
    let resolveMode: "auto" = "auto";
    const { audit } = makeAudit();
    // Auto-resolving runner (real setInterval ticks — no manual promise plumbing needed here).
    let callCount = 0;
    const runner: RoutineRunner = { runHeadless: async () => { callCount++; return { ok: true, resultText: "x" }; } };
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now });

    sched.start(5);
    await new Promise((r) => setTimeout(r, 40));
    sched.stop();
    const countAtStop = callCount;
    expect(countAtStop).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 40));
    expect(callCount).toBe(countAtStop); // no further fires after stop()

    // Idempotent: calling stop() again does not throw.
    expect(() => sched.stop()).not.toThrow();
    void resolveMode;
  });
});

describe("makeRoutineScheduler — audit line shapes", () => {
  test("fire/defer/error lines carry exactly the documented fields", async () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 30m", prompt: "a" });
    const now = routine.nextRunAt + 10;
    const { runner, calls } = makeControllableRunner();
    const { audit, lines } = makeAudit();
    const sched = makeRoutineScheduler({ store, runner, audit, now: () => now });

    const tickPromise = sched.tick();
    calls[0]!.resolve({ ok: false, quotaLimited: true });
    await tickPromise;

    expect(lines[0]).toEqual({ op: "fire", id: routine.id, spec: "every 30m", origin: `routine/${routine.id}` });
    expect(lines[1]).toEqual({ op: "defer", id: routine.id, reason: "quota" });
  });
});
