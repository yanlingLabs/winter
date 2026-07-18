import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { DispatchChildren } from "../../src/agent/dispatch-children";

// Task 5: DispatchChildren's registry surface — derived status, completion wake (with coalescing),
// the roster reminder, and stopChild. A REAL SessionStore+SessionHub (temp NORMA_HOME) drives
// events through the actual append/observer path; runTurn/isRunning/interrupt are FAKE recording
// stubs — this is a unit test of the registry, not an engine integration test (the engine seams
// themselves — cfg.onTurnEnd/cfg.dispatchRoster — are wired in engine.ts and exercised by whatever
// engine-level test covers dispatch mode end-to-end).
function setup() {
  const home = mkdtempSync(join(tmpdir(), "norma-dispatch-children-home-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const runTurnCalls: string[] = [];
  const interruptCalls: string[] = [];
  const running = new Set<string>();
  const registry = new DispatchChildren({
    store,
    hub,
    runTurn: async (sid: string) => { runTurnCalls.push(sid); },
    isRunning: (sid: string) => running.has(sid),
    interrupt: (sid: string) => { interruptCalls.push(sid); },
  });
  const setRunning = (sid: string, v: boolean) => { if (v) running.add(sid); else running.delete(sid); };
  return { store, hub, registry, runTurnCalls, interruptCalls, setRunning };
}

function readDispatch(store: SessionStore, dispatchId: string): SessionEvent[] {
  return store.read(dispatchId, 0);
}

describe("DispatchChildren (Task 5): status derivation", () => {
  test("1) after spawnChild, statusOf(child) === 'running'", () => {
    const { store, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    expect(registry.statusOf(childId)).toBe("running");
  });

  test("2) approval_requested → awaiting_approval; approval_resolved → running", () => {
    const { store, hub, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start(); // subscribe the observer (daemon boot precedent — start() wires hub.addObserver)

    hub.append(childId, { type: "approval_requested", sessionId: childId, threadId: "main", callId: "c1", toolName: "bash", summary: "run rm", issuedAt: 1781270000000, expiresAt: 1781270300000 });
    expect(registry.statusOf(childId)).toBe("awaiting_approval");

    hub.append(childId, { type: "approval_resolved", sessionId: childId, threadId: "main", callId: "c1", approved: true, by: "user" });
    expect(registry.statusOf(childId)).toBe("running");
  });

  test("3) question_asked → awaiting_input; question_resolved → running", () => {
    const { store, hub, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();

    hub.append(childId, {
      type: "question_asked", sessionId: childId, threadId: "main", callId: "q1",
      questions: [{ question: "which?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
    });
    expect(registry.statusOf(childId)).toBe("awaiting_input");

    hub.append(childId, { type: "question_resolved", sessionId: childId, threadId: "main", callId: "q1", answers: { "which?": "A" }, by: "user" });
    expect(registry.statusOf(childId)).toBe("running");
  });
});

describe("DispatchChildren (Task 5): completion wake", () => {
  test("4) onTurnEnd(child) with dispatch idle: appends a completed child_update with resultSummary, and wakes the dispatch (runTurn called)", () => {
    const { store, hub, registry, runTurnCalls, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();
    setRunning(dispatchId, false); // dispatch idle

    hub.append(childId, { type: "assistant_message", sessionId: childId, threadId: "main", text: "all done here" });
    registry.onTurnEnd(childId);

    const events = readDispatch(store, dispatchId);
    const update = events.find((e) => e.type === "child_update" && e.childSessionId === childId && e.status === "completed");
    expect(update).toBeDefined();
    expect((update as { resultSummary?: string }).resultSummary).toBe("all done here");
    expect(registry.statusOf(childId)).toBe("completed");
    expect(runTurnCalls).toContain(dispatchId);
  });

  test("5) onTurnEnd(child) with dispatch busy: child_update appended but runTurn NOT called; onTurnEnd(dispatchId) later drains the coalesced wake exactly once", () => {
    const { store, hub, registry, runTurnCalls, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const child1 = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work 1", title: "Task 1" });
    const child2 = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/b", prompt: "do work 2", title: "Task 2" });
    registry.start();
    setRunning(dispatchId, true); // dispatch busy

    hub.append(child1, { type: "assistant_message", sessionId: child1, threadId: "main", text: "child1 done" });
    registry.onTurnEnd(child1);
    hub.append(child2, { type: "assistant_message", sessionId: child2, threadId: "main", text: "child2 done" });
    registry.onTurnEnd(child2); // a SECOND child finishing while still busy — coalesces into the SAME pending wake

    const events = readDispatch(store, dispatchId);
    expect(events.filter((e) => e.type === "child_update" && e.status === "completed").length).toBe(2);
    expect(runTurnCalls).not.toContain(dispatchId); // dispatch never woken while busy

    // Now the dispatch session's OWN turn ends — the coalesced wake drains, exactly once.
    registry.onTurnEnd(dispatchId);
    expect(runTurnCalls.filter((id) => id === dispatchId).length).toBe(1);

    // A further onTurnEnd(dispatchId) with nothing pending must NOT re-trigger a wake.
    registry.onTurnEnd(dispatchId);
    expect(runTurnCalls.filter((id) => id === dispatchId).length).toBe(1);
  });

  test("stale-summary guard (review fix): a second turn ending with NO new assistant_message emits a child_update WITHOUT resultSummary — never the previous turn's text", () => {
    const { store, hub, registry, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();
    setRunning(dispatchId, false);

    // Turn 1: ends with an assistant_message — its child_update carries that summary.
    hub.append(childId, { type: "assistant_message", sessionId: childId, threadId: "main", text: "first result" });
    registry.onTurnEnd(childId);
    const afterTurn1 = readDispatch(store, dispatchId).findLast((e) => e.type === "child_update" && e.childSessionId === childId);
    expect((afterTurn1 as { resultSummary?: string }).resultSummary).toBe("first result");

    // Turn 2 (child resumed): ends with NO new assistant_message (pure tool-call end / error) —
    // the update must NOT resurrect turn 1's text as this turn's resultSummary.
    registry.onTurnEnd(childId);
    const afterTurn2 = readDispatch(store, dispatchId).findLast((e) => e.type === "child_update" && e.childSessionId === childId);
    expect(afterTurn2).toBeDefined();
    expect((afterTurn2 as { resultSummary?: string }).resultSummary).toBeUndefined();
  });

  test("6) error path: last event agent_error (no assistant_message) → child_update status 'error'", () => {
    const { store, hub, registry, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    registry.start();
    setRunning(dispatchId, false);

    hub.append(childId, { type: "agent_error", sessionId: childId, threadId: "main", message: "boom" });
    registry.onTurnEnd(childId);

    const events = readDispatch(store, dispatchId);
    const update = events.findLast((e) => e.type === "child_update" && e.childSessionId === childId);
    expect(update).toMatchObject({ status: "error" });
    expect(registry.statusOf(childId)).toBe("error");
  });
});

describe("DispatchChildren (Task 5): roster", () => {
  test("7) rosterFor(dispatchId) lists child id/title/dir/status; rosterFor(codeSessionId) is undefined", () => {
    const { store, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const codeSessionId = store.createSession("global", { mode: "code" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });

    const roster = registry.rosterFor(dispatchId);
    expect(roster).toBeDefined();
    expect(roster).toContain(childId);
    expect(roster).toContain("Task A");
    expect(roster).toContain("/tmp/a");
    expect(roster).toContain("running");
    expect(roster).toContain("<system-reminder>");

    expect(registry.rosterFor(codeSessionId)).toBeUndefined();
  });
});

describe("DispatchChildren (Task 5): stopChild", () => {
  test("8) stopChild(dispatchId, childId) interrupts + returns a string; wrong caller or unknown id → undefined", () => {
    const { store, registry, interruptCalls } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const otherSessionId = store.createSession("global", { mode: "code" });
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });

    const result = registry.stopChild(dispatchId, childId);
    expect(typeof result).toBe("string");
    expect(interruptCalls).toContain(childId);

    expect(registry.stopChild(otherSessionId, childId)).toBeUndefined();
    expect(registry.stopChild(dispatchId, "s_nope")).toBeUndefined();
  });
});

describe("DispatchChildren (Task 9): notifyUnattended", () => {
  // NOTE on call order: `start()` runs BEFORE `spawnChild()` in every test below (production order
  // — daemon.ts always calls `dispatchChildren.start()` once at boot, before any session_spawn can
  // possibly fire). The OLDER Task 5/6 tests above call `spawnChild()` then `start()` — harmless
  // there since they only assert `status`, which onEvent/onTurnEnd overwrite unconditionally either
  // way — but `start()`'s restart-reconstruction (`childrenOf` loop) rebuilds an ALREADY-tracked
  // child from the store's OWN title metadata (auto-derived from the opening prompt, e.g. "do
  // work" — never `opts.title`) if it runs AFTER spawnChild, silently clobbering the freshly-set
  // ChildState. That only surfaces once a test actually checks `title` (as these do), so the
  // start()-before-spawnChild order here isn't stylistic — it's required for the title assertions
  // below to reflect what spawnChild was actually called with.
  test("onTurnEnd(child, completed), nobody attached to dispatch: notification_requested {title, 'finished'}", () => {
    const { store, hub, registry, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    setRunning(dispatchId, false);

    hub.append(childId, { type: "assistant_message", sessionId: childId, threadId: "main", text: "all done" });
    registry.onTurnEnd(childId);

    const n = readDispatch(store, dispatchId).find((e) => e.type === "notification_requested");
    expect(n).toMatchObject({ sessionId: dispatchId, threadId: "main", title: "Task A", message: "finished" });
  });

  test("onTurnEnd(child, errored), nobody attached: notification_requested {title, 'hit an error'}", () => {
    const { store, hub, registry, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    setRunning(dispatchId, false);

    hub.append(childId, { type: "agent_error", sessionId: childId, threadId: "main", message: "boom" });
    registry.onTurnEnd(childId);

    const n = readDispatch(store, dispatchId).find((e) => e.type === "notification_requested");
    expect(n).toMatchObject({ title: "Task A", message: "hit an error" });
  });

  test("onEvent(approval_requested on a tracked child), nobody attached: notification_requested {title, 'needs your input'}", () => {
    const { store, hub, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });

    hub.append(childId, { type: "approval_requested", sessionId: childId, threadId: "main", callId: "c1", toolName: "bash", summary: "run rm", issuedAt: 1781270000000, expiresAt: 1781270300000 });

    const n = readDispatch(store, dispatchId).find((e) => e.type === "notification_requested");
    expect(n).toMatchObject({ title: "Task A", message: "needs your input" });
  });

  test("onEvent(question_asked on a tracked child), nobody attached: notification_requested {title, 'needs your input'}", () => {
    const { store, hub, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });

    hub.append(childId, {
      type: "question_asked", sessionId: childId, threadId: "main", callId: "q1",
      questions: [{ question: "which?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
    });

    const n = readDispatch(store, dispatchId).find((e) => e.type === "notification_requested");
    expect(n).toMatchObject({ title: "Task A", message: "needs your input" });
  });

  test("a title over NotificationRequestedEvent's 100-char bound is clamped, not thrown (session_spawn's own title arg has no length cap)", () => {
    const { store, hub, registry, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const longTitle = "x".repeat(150);
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: longTitle });
    setRunning(dispatchId, false);

    hub.append(childId, { type: "assistant_message", sessionId: childId, threadId: "main", text: "done" });
    registry.onTurnEnd(childId); // must not throw despite the 150-char title

    const n = readDispatch(store, dispatchId).find((e) => e.type === "notification_requested") as { title: string };
    expect(n.title).toBe("x".repeat(100));
  });

  test("a client IS attached to the dispatch session: neither seam emits notification_requested", () => {
    const { store, hub, registry, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    setRunning(dispatchId, false);
    hub.attach({ clientName: "watcher", deliver: () => true }, dispatchId, 0);

    // Approval seam.
    hub.append(childId, { type: "approval_requested", sessionId: childId, threadId: "main", callId: "c1", toolName: "bash", summary: "run rm", issuedAt: 1781270000000, expiresAt: 1781270300000 });
    expect(readDispatch(store, dispatchId).find((e) => e.type === "notification_requested")).toBeUndefined();
    hub.append(childId, { type: "approval_resolved", sessionId: childId, threadId: "main", callId: "c1", approved: true, by: "user" });

    // onTurnEnd (completed) seam.
    hub.append(childId, { type: "assistant_message", sessionId: childId, threadId: "main", text: "done" });
    registry.onTurnEnd(childId);
    expect(readDispatch(store, dispatchId).find((e) => e.type === "notification_requested")).toBeUndefined();
  });
});

describe("DispatchChildren (whole-branch fix wave): start() restart semantics — UPDATED", () => {
  // Old semantics (pre-fix): start() rebuilt EVERY historical child from the store as "completed",
  // so the roster/map grew forever across restarts of a session that lives forever. New semantics:
  // start() tracks NOTHING from the store — a pre-restart child is simply no longer tracked (its
  // session still lives on in the store/session list; statusOf/stopChild on the now-untracked id
  // already behave safely — see their own doc comments — so nothing downstream breaks).
  test("start() does NOT resurrect historical children from the store — rosterFor lists none of them", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-dispatch-children-restart-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    const childId = store.createSession("global", { mode: "code", parentSessionId: dispatchId, cwd: "/tmp/restart" });

    // Fresh registry (simulates a daemon restart — no in-memory state at all).
    const registry = new DispatchChildren({
      store, hub,
      runTurn: async () => {},
      isRunning: () => false,
      interrupt: () => {},
    });
    registry.start();

    // Untracked-id fallbacks stay honest/safe (unchanged contracts — see statusOf/stopChild docs).
    expect(registry.statusOf(childId)).toBe("completed");
    expect(registry.stopChild(dispatchId, childId)).toBeUndefined();
    // The roster itself must not mention a child start() never tracked — size 0 → undefined,
    // not a roster string that happens to omit it (proves it's genuinely untracked, not filtered).
    expect(registry.rosterFor(dispatchId)).toBeUndefined();
  });
});

describe("DispatchChildren (whole-branch fix wave): bounded roster — prune terminal children post-report", () => {
  // start() BEFORE spawnChild() in every test below — same call-order requirement as the Task 9
  // notifyUnattended tests above (see that describe block's own NOTE): start()-after-spawnChild
  // would have start()'s (now-removed) store reconstruction clobber the freshly-set ChildState.
  // Calling start() first sidesteps that entirely and keeps these tests isolated to ONLY the
  // onTurnEnd(dispatchId) pruning behavior under test here.
  test("a completed child survives in the roster through the wake window, then is pruned (roster AND map) once the dispatch turn that reported it ends", () => {
    const { store, hub, registry, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    setRunning(dispatchId, false); // dispatch idle — child completion wakes it immediately

    hub.append(childId, { type: "assistant_message", sessionId: childId, threadId: "main", text: "done" });
    registry.onTurnEnd(childId); // child's own turn ends → status "completed", child_update appended, dispatch woken

    // Still present DURING the wake window — the dispatch turn that was just woken hasn't ended yet.
    expect(registry.rosterFor(dispatchId)).toContain(childId);

    registry.onTurnEnd(dispatchId); // the dispatch turn that had the chance to report it now ends

    // Pruned from BOTH the roster's rendering AND the underlying map: with this the only child ever
    // tracked, an emptied map makes rosterFor fall back to undefined (its own size===0 contract) —
    // not merely a roster string that omits the (still-present) entry.
    expect(registry.rosterFor(dispatchId)).toBeUndefined();
  });

  test("coalesced path: a child completing DURING a busy dispatch turn survives into the DRAINED wake turn's roster, and is pruned only when THAT turn ends", () => {
    const { store, hub, registry, runTurnCalls, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    setRunning(dispatchId, true); // dispatch BUSY — completion coalesces into pendingWake

    hub.append(childId, { type: "assistant_message", sessionId: childId, threadId: "main", text: "done" });
    registry.onTurnEnd(childId); // terminal, but dispatch busy → pendingWake set, no immediate wake
    expect(runTurnCalls).not.toContain(dispatchId);

    registry.onTurnEnd(dispatchId); // the busy turn ends → drain fires (wake turn launched)
    expect(runTurnCalls.filter((id) => id === dispatchId).length).toBe(1);
    // The DRAINED wake turn is the one that reports this child — it reads rosterFor on a later
    // microtask (the `void runTurn(...)` launched just above), so the child must STILL be listed
    // here, not pruned out from under it by the very drain that launched the reporting turn.
    expect(registry.rosterFor(dispatchId)).toContain(childId);

    registry.onTurnEnd(dispatchId); // the drained wake turn itself ends → NOW the prune fires
    expect(registry.rosterFor(dispatchId)).toBeUndefined();
    expect(runTurnCalls.filter((id) => id === dispatchId).length).toBe(1); // no spurious re-wake either
  });

  test("an errored child is pruned the same way as a completed one", () => {
    const { store, hub, registry, setRunning } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    setRunning(dispatchId, false);

    hub.append(childId, { type: "agent_error", sessionId: childId, threadId: "main", message: "boom" });
    registry.onTurnEnd(childId);
    expect(registry.statusOf(childId)).toBe("error");
    expect(registry.rosterFor(dispatchId)).toContain(childId);

    registry.onTurnEnd(dispatchId);
    expect(registry.rosterFor(dispatchId)).toBeUndefined();
  });

  test("a RUNNING child is never pruned by a dispatch turn-end", () => {
    const { store, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });

    registry.onTurnEnd(dispatchId); // dispatch's own turn ends while the child is still "running"

    expect(registry.statusOf(childId)).toBe("running");
    expect(registry.rosterFor(dispatchId)).toContain(childId);
  });

  test("an awaiting_approval child (not yet terminal) survives a dispatch turn-end", () => {
    const { store, hub, registry } = setup();
    const dispatchId = store.createSession("global", { mode: "dispatch" });
    registry.start();
    const childId = registry.spawnChild({ dispatchSessionId: dispatchId, dir: "/tmp/a", prompt: "do work", title: "Task A" });
    hub.append(childId, { type: "approval_requested", sessionId: childId, threadId: "main", callId: "c1", toolName: "bash", summary: "run rm", issuedAt: 1781270000000, expiresAt: 1781270300000 });

    registry.onTurnEnd(dispatchId);

    expect(registry.statusOf(childId)).toBe("awaiting_approval");
    expect(registry.rosterFor(dispatchId)).toContain(childId);
  });
});
