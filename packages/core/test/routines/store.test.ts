import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoutineStore, type RoutineStore } from "../../src/routines/store";

function makeStore(): { store: RoutineStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "winter-routines-"));
  return { store: openRoutineStore(join(dir, "routines.db")), dir };
}

describe("RoutineStore — create", () => {
  test("creates a routine, validating spec and generating an id", () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 30m", prompt: "check inbox" });
    expect(routine.id).toMatch(/^[a-f0-9]+$/);
    expect(routine.spec).toBe("every 30m");
    expect(routine.prompt).toBe("check inbox");
    expect(routine.policy).toBe("auto"); // default
    expect(routine.enabled).toBe(true); // default
    expect(routine.lastRunAt).toBeNull();
    expect(routine.lastResult).toBeNull();
    expect(routine.deferAttempts).toBe(0);
    expect(routine.nextRunAt).toBeGreaterThan(routine.createdAt);
  });

  test("generates distinct ids for successive routines (not Math.random-derived collisions)", () => {
    const { store } = makeStore();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add(store.create({ spec: "every 1h", prompt: "x" }).id);
    }
    expect(ids.size).toBe(20);
  });

  test("rejects an invalid spec (propagates parseSpec's TypeError)", () => {
    const { store } = makeStore();
    expect(() => store.create({ spec: "not a spec", prompt: "x" })).toThrow(TypeError);
  });

  test("rejects policy 'ask' — headless routines would hang waiting for approval", () => {
    const { store } = makeStore();
    expect(() => store.create({ spec: "every 30m", prompt: "x", policy: "ask" })).toThrow(TypeError);
    expect(() => store.create({ spec: "every 30m", prompt: "x", policy: "ask" })).toThrow(/headless|hang/);
  });

  test("accepts explicit policy 'plan' and cwd", () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 30m", prompt: "x", policy: "plan", cwd: "/tmp/proj" });
    expect(routine.policy).toBe("plan");
    expect(routine.cwd).toBe("/tmp/proj");
  });
});

describe("RoutineStore — CRUD", () => {
  test("get returns undefined for an unknown id (never throws)", () => {
    const { store } = makeStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  test("list returns all created routines", () => {
    const { store } = makeStore();
    store.create({ spec: "every 1h", prompt: "a" });
    store.create({ spec: "every 2h", prompt: "b" });
    expect(store.list()).toHaveLength(2);
  });

  test("update patches fields and returns undefined for unknown id", () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 1h", prompt: "a" });
    const updated = store.update(routine.id, { prompt: "b", enabled: false });
    expect(updated?.prompt).toBe("b");
    expect(updated?.enabled).toBe(false);
    expect(store.update("nonexistent", { prompt: "x" })).toBeUndefined();
  });

  test("update with a new spec re-validates and recomputes nextRunAt", () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 1h", prompt: "a" });
    const updated = store.update(routine.id, { spec: "every 5m" });
    expect(updated?.spec).toBe("every 5m");
    expect(() => store.update(routine.id, { spec: "garbage" })).toThrow(TypeError);
  });

  test("delete removes the routine and returns true; false when already gone", () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 1h", prompt: "a" });
    expect(store.delete(routine.id)).toBe(true);
    expect(store.get(routine.id)).toBeUndefined();
    expect(store.delete(routine.id)).toBe(false);
  });
});

describe("RoutineStore — due()", () => {
  test("returns only enabled routines whose nextRunAt has arrived", () => {
    const { store } = makeStore();
    const now = Date.now();
    const dueSoon = store.create({ spec: "every 1s", prompt: "a" }); // nextRunAt ~= now+1000
    const farOut = store.create({ spec: "every 1h", prompt: "b" });
    const disabled = store.create({ spec: "every 1s", prompt: "c" });
    store.update(disabled.id, { enabled: false });

    expect(store.due(now)).toEqual([]); // nothing due yet (all nextRunAt in the future)
    expect(store.due(now + 2000).map((r) => r.id)).toEqual([dueSoon.id]);
    expect(store.due(now + 2000).map((r) => r.id)).not.toContain(farOut.id);
    expect(store.due(now + 2000).map((r) => r.id)).not.toContain(disabled.id);
  });
});

describe("RoutineStore — recordRun", () => {
  test("sets lastRunAt/lastResult, recomputes nextRunAt, and resets deferAttempts", () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 30m", prompt: "a" });
    // Simulate prior defers so we can verify the reset.
    store.recordDefer(routine.id, { nowMs: Date.now() });
    store.recordDefer(routine.id, { nowMs: Date.now() });
    expect(store.get(routine.id)?.deferAttempts).toBe(2);

    const now = Date.now();
    const updated = store.recordRun(routine.id, { resultText: "done: checked inbox", nowMs: now });
    expect(updated?.lastRunAt).toBe(now);
    expect(updated?.lastResult).toBe("done: checked inbox");
    expect(updated?.nextRunAt).toBe(now + 30 * 60_000);
    expect(updated?.deferAttempts).toBe(0);
  });

  test("returns undefined for an unknown id", () => {
    const { store } = makeStore();
    expect(store.recordRun("nonexistent", { resultText: "x", nowMs: Date.now() })).toBeUndefined();
  });
});

describe("RoutineStore — recordDefer backoff progression", () => {
  test("30m, 1h, 2h, 4h, then caps at 4h", () => {
    const { store } = makeStore();
    const routine = store.create({ spec: "every 1h", prompt: "a" });
    const base = Date.now();

    const r1 = store.recordDefer(routine.id, { nowMs: base });
    expect(r1?.nextRunAt).toBe(base + 30 * 60_000);
    expect(r1?.lastResult).toBe("deferred: quota");
    expect(r1?.deferAttempts).toBe(1);

    const r2 = store.recordDefer(routine.id, { nowMs: base });
    expect(r2?.nextRunAt).toBe(base + 60 * 60_000);
    expect(r2?.deferAttempts).toBe(2);

    const r3 = store.recordDefer(routine.id, { nowMs: base });
    expect(r3?.nextRunAt).toBe(base + 2 * 60 * 60_000);
    expect(r3?.deferAttempts).toBe(3);

    const r4 = store.recordDefer(routine.id, { nowMs: base });
    expect(r4?.nextRunAt).toBe(base + 4 * 60 * 60_000);
    expect(r4?.deferAttempts).toBe(4);

    // Would be 8h uncapped; stays at the 4h ceiling.
    const r5 = store.recordDefer(routine.id, { nowMs: base });
    expect(r5?.nextRunAt).toBe(base + 4 * 60 * 60_000);
    expect(r5?.deferAttempts).toBe(5);
  });

  test("returns undefined for an unknown id", () => {
    const { store } = makeStore();
    expect(store.recordDefer("nonexistent", { nowMs: Date.now() })).toBeUndefined();
  });
});

describe("openRoutineStore — path handling", () => {
  test("creates the parent directory for an injected path", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-routines-parent-"));
    const nested = join(dir, "nested", "sub", "routines.db");
    const store = openRoutineStore(nested);
    const routine = store.create({ spec: "every 1h", prompt: "a" });
    expect(store.get(routine.id)?.id).toBe(routine.id);
  });
});
