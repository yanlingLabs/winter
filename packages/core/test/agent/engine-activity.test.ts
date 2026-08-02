import { expect, test } from "bun:test";
import { GatedProvider, deferred } from "../../src/agent/test-providers";
import { setupEngine } from "./engine-steer.test";

// Sparkle T2: activeTurnCount() is the update-idle-gate's read on AgentEngine.runningTurns —
// 0 when no session has a turn in flight, 1 while ANY turn is running, back to 0 once it
// settles. Mirrors the isRunning(sessionId) precedent in engine-steer.test.ts, but engine-wide
// (activeTurnCount has no sessionId — it's a coarse "is the daemon idle at all" signal, not a
// per-session one).
test("activeTurnCount is 0 when idle, 1 mid-turn, 0 after", async () => {
  const gate = deferred();
  const provider = new GatedProvider(
    [[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]],
    [gate.promise], // round 0 blocks on the gate until released below
  );
  const { engine, sessionId } = setupEngine(provider);

  expect(engine.activeTurnCount()).toBe(0);

  const turn = engine.runTurn(sessionId);
  await Bun.sleep(20); // let runTurn enter streamTurn (gated)
  expect(engine.activeTurnCount()).toBe(1);

  gate.resolve();
  await turn;
  expect(engine.activeTurnCount()).toBe(0);
});

// session-activity-hygiene T8: the same `runningTurns` map, now stamped — `turnStartedAt` is the
// running-turn DURATION source dispatch's `list_sessions` shows. Undefined is the load-bearing
// half: "no turn is running" must never read as a zero-length turn that started at the epoch.
test("turnStartedAt is undefined when idle, a real start stamp mid-turn, and undefined again after", async () => {
  const gate = deferred();
  const provider = new GatedProvider(
    [[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]],
    [gate.promise],
  );
  const { engine, sessionId } = setupEngine(provider);

  expect(engine.turnStartedAt(sessionId)).toBeUndefined();

  const before = Date.now();
  const turn = engine.runTurn(sessionId);
  await Bun.sleep(20);
  const startedAt = engine.turnStartedAt(sessionId);
  expect(startedAt).toBeDefined();
  expect(startedAt!).toBeGreaterThanOrEqual(before);
  expect(startedAt!).toBeLessThanOrEqual(Date.now());
  // Same map as isRunning — the two can never disagree about whether a turn is in flight.
  expect(engine.isRunning(sessionId)).toBe(true);

  gate.resolve();
  await turn;
  expect(engine.turnStartedAt(sessionId)).toBeUndefined();
  expect(engine.isRunning(sessionId)).toBe(false);
  // A session that never ran anything is undefined too, not 0.
  expect(engine.turnStartedAt("s_never_ran")).toBeUndefined();
});
