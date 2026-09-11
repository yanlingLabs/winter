import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { openRoutineStore, type RoutineStore } from "../../src/routines/store";
import { makeRoutineScheduler } from "../../src/routines/scheduler";
import { makeDaemonRoutineRunner, type WinterTurnRunner } from "../../src/routines/runner";
import { RoutineAuditLog } from "../../src/routines/audit";

/** The driver table's headless door, faked over the real hub: the driver appends the `user_message`
 *  itself (P8b-39) and then the scripted "turn" writes what a child would have. */
const winterOver = (hub: SessionHub, turn: (sessionId: string) => Promise<void>): WinterTurnRunner => ({
  async runTurn(sessionId, text, clientName) {
    hub.append(sessionId, { type: "user_message", sessionId, threadId: "main", text, clientName });
    await turn(sessionId);
  },
});

// =================================================================================================
// Phase 5 routines T5 — THE PHASE GATE ("a routine fires headless on schedule") + the quota-defer
// e2e. Unlike scheduler.test.ts (fake RoutineRunner) and runner.test.ts (real SessionStore/Hub +
// fake WinterTurnRunner, but the scheduler itself is never involved), this file wires ALL THREE real
// pieces together — the real RoutineStore (temp sqlite), the real makeRoutineScheduler, and the
// real makeDaemonRoutineRunner against a real SessionStore/SessionHub (temp sqlite + jsonl logs) —
// with only the Winter driver table's headless door (the child's turn) stubbed, exactly the "fake
// provider/engine seam" the brief calls for. This is the closest thing to the live daemon wiring that a unit test
// can exercise without standing up startDaemon()/a real provider.
// =================================================================================================

function makeHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** Polls a synchronous predicate until it's true or the deadline passes — used only for the
 *  real-timer (`start()`) leg below; every other assertion in this file is driven by manually
 *  calling `tick()` against a fake clock, per the brief's "prefer deterministic tick-driving over
 *  real timers" guidance. Kept tiny (small interval, small deadline) and condition-polled, never a
 *  fixed sleep as the only synchronization. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!predicate()) throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
}

interface RealHarness {
  sessionStore: SessionStore;
  hub: SessionHub;
  routineStore: RoutineStore;
  auditPath: string;
  audit: RoutineAuditLog;
  close(): void;
}

/** Assembles the real store+hub+routine-store+audit trio (mirrors exactly what daemon.ts
 *  constructs), leaving only the WinterTurnRunner to be supplied per-test. */
function buildHarness(): RealHarness {
  const sessionsHome = makeHome("norma-e2e-routines-sessions-");
  const sessionStore = new SessionStore(sessionsHome);
  const hub = new SessionHub(sessionStore);

  const routinesDir = makeHome("norma-e2e-routines-store-");
  const routineStore = openRoutineStore(join(routinesDir, "routines.db"));
  const auditPath = join(routinesDir, "routines-audit.jsonl");
  const audit = new RoutineAuditLog(auditPath);

  return {
    sessionStore, hub, routineStore, auditPath, audit,
    close() { routineStore.close(); sessionStore.close(); },
  };
}

describe("Phase 5 routines — e2e: THE PHASE GATE (a routine fires headless on schedule)", () => {
  test("a real store + real scheduler + the daemon's real runner seam: a due `every 2s` routine fires headless — session origin+title stamped, lastRunAt/lastResult recorded, nextRunAt advances", async () => {
    const h = buildHarness();
    let firedSessionId: string | undefined;
    let sawPrompt: string | undefined;
    const winter = winterOver(h.hub, async (sessionId) => {
        firedSessionId = sessionId;
        const events = h.sessionStore.read(sessionId);
        const userMsg = events.find((e) => e.type === "user_message");
        sawPrompt = userMsg && "text" in userMsg ? userMsg.text : undefined;
        h.hub.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "3 unread emails" });
        h.hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 12, outputTokens: 6 });
    });
    const runner = makeDaemonRoutineRunner({ store: h.sessionStore, hub: h.hub, winter });

    const routine = h.routineStore.create({ spec: "every 2s", prompt: "check inbox", policy: "auto", cwd: "/tmp/routine-e2e" });
    let now = routine.nextRunAt + 10; // already due
    const sched = makeRoutineScheduler({ store: h.routineStore, runner, audit: (l) => h.audit.append(l), now: () => now });

    try {
      await sched.tick();

      // (a) a session was created with meta origin: "routine/<id>" (T3's field) AND the stamped title.
      expect(firedSessionId).toBeDefined();
      expect(sawPrompt).toBe("check inbox");
      const listed = h.sessionStore.list().find((s) => s.sessionId === firedSessionId);
      expect(listed).toBeDefined();
      expect(listed?.origin).toBe(`routine/${routine.id}`);
      expect(listed?.title).toBe(`routine/${routine.id}`);
      expect(listed?.cwd).toBe("/tmp/routine-e2e");

      // (b) the routine's lastRunAt/lastResult recorded.
      const updated = h.routineStore.get(routine.id)!;
      expect(updated.lastRunAt).toBe(now);
      expect(updated.lastResult).toBe("3 unread emails");
      expect(updated.deferAttempts).toBe(0);

      // (c) nextRunAt advanced (interval spec: fire-time + 2s).
      expect(updated.nextRunAt).toBe(now + 2000);

      // Real audit trail: a "fire" line actually landed in the real jsonl file (not just a fake
      // in-memory collector — this uses the same RoutineAuditLog class daemon.ts constructs).
      const lines = readJsonl(h.auditPath);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ op: "fire", id: routine.id, spec: "every 2s", origin: `routine/${routine.id}` });
      expect(typeof lines[0]!.ts).toBe("number");
    } finally {
      h.close();
    }
  });

  test("start(): the SAME real wiring fires on an actual (tiny) schedule via start(), not a manually-driven tick() — condition-polled, no fixed sleep as the only sync", async () => {
    const h = buildHarness();
    const winter = winterOver(h.hub, async (sessionId) => {
        h.hub.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "pong" });
        h.hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 1, outputTokens: 1 });
    });
    const runner = makeDaemonRoutineRunner({ store: h.sessionStore, hub: h.hub, winter });

    // `every 1s`, real wall clock (no `now` override) — nextRunAt is ~1s in the future at
    // creation time, so start()'s own tiny tick interval (well under 1s) is what actually
    // catches it once real time passes it, proving the periodic-firing wiring itself, not just
    // the fire logic.
    const routine = h.routineStore.create({ spec: "every 1s", prompt: "ping", policy: "auto", cwd: "/tmp/routine-e2e-2" });
    const sched = makeRoutineScheduler({ store: h.routineStore, runner, audit: (l) => h.audit.append(l) });

    try {
      sched.start(50);
      await waitUntil(() => h.routineStore.get(routine.id)!.lastRunAt !== null, 3000);
    } finally {
      sched.stop();
    }

    const updated = h.routineStore.get(routine.id)!;
    expect(updated.lastResult).toBe("pong");
    expect(updated.deferAttempts).toBe(0);
    expect(updated.nextRunAt).toBeGreaterThan(updated.lastRunAt!);

    const firedOrigin = `routine/${routine.id}`;
    expect(h.sessionStore.list().some((s) => s.origin === firedOrigin)).toBe(true);

    h.close();
  });
});

describe("Phase 5 routines — e2e: quota-defer", () => {
  test("a quota-shaped agent_error (code: \"rate_limit\") defers the routine (deferAttempts=1, nextRunAt = now+30min, lastResult 'deferred: quota', audit defer line); a later successful fire resets attempts", async () => {
    const h = buildHarness();
    let mode: "quota" | "success" = "quota";
    const winter = winterOver(h.hub, async (sessionId) => {
        if (mode === "quota") {
          h.hub.append(sessionId, { type: "agent_error", sessionId, threadId: "main", message: "rate limited, try later", code: "rate_limit" });
          h.hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "error", inputTokens: 0, outputTokens: 0 });
        } else {
          h.hub.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "back online" });
          h.hub.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 });
        }
    });
    const runner = makeDaemonRoutineRunner({ store: h.sessionStore, hub: h.hub, winter });

    const routine = h.routineStore.create({ spec: "every 30m", prompt: "poll status", policy: "auto", cwd: "/tmp/routine-e2e-3" });
    let now = routine.nextRunAt + 10;
    const sched = makeRoutineScheduler({ store: h.routineStore, runner, audit: (l) => h.audit.append(l), now: () => now });

    try {
      await sched.tick();

      let updated = h.routineStore.get(routine.id)!;
      expect(updated.deferAttempts).toBe(1);
      expect(updated.lastResult).toBe("deferred: quota");
      expect(updated.lastRunAt).toBeNull(); // a defer does NOT count as a run
      expect(updated.nextRunAt).toBe(now + 30 * 60_000);

      let lines = readJsonl(h.auditPath);
      expect(lines.map((l) => l.op)).toEqual(["fire", "defer"]);
      expect(lines[1]).toMatchObject({ op: "defer", id: routine.id, reason: "quota" });

      // Next fire (once its deferred nextRunAt is due) succeeds — attempts reset to 0.
      mode = "success";
      now = updated.nextRunAt + 10;
      await sched.tick();

      updated = h.routineStore.get(routine.id)!;
      expect(updated.deferAttempts).toBe(0);
      expect(updated.lastRunAt).toBe(now);
      expect(updated.lastResult).toBe("back online");
      expect(updated.nextRunAt).toBe(now + 30 * 60_000);

      lines = readJsonl(h.auditPath);
      expect(lines.map((l) => l.op)).toEqual(["fire", "defer", "fire"]); // success adds no extra audit line
    } finally {
      h.close();
    }
  });
});
