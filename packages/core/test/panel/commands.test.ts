import { describe, expect, test } from "bun:test";
import type { NewSessionEvent } from "@norma/protocol";
import { PanelCommandRegistry } from "../../src/panel/commands";

type NewPanelCommand = Extract<NewSessionEvent, { type: "panel_command" }>;

// ================================================================================================
// B2 Task 2 — the pending-command registry. Plan A shipped `panel_command` with no producer and no
// answer channel at all; this is both, plus the dedup obligation Plan A explicitly deferred
// ("result returns via panel.commandResult, FIRST RESULT PER commandId WINS — closing the
// broadcast-dedup obligation", spec §3).
//
// Deadlines here are single-digit milliseconds on purpose: no timer may outlive its test case (the
// HardwareBroker precedent's injectable timeout, for the same reason).
// ================================================================================================

/** Collects everything the registry emits + logs, so a test can assert on either. */
function harness(over: { emit?: (e: NewSessionEvent) => void } = {}) {
  const emitted: NewPanelCommand[] = [];
  const logs: string[] = [];
  const registry = new PanelCommandRegistry({
    emit: over.emit ?? ((e) => { emitted.push(e as NewPanelCommand); }),
    log: (line) => { logs.push(line); },
  });
  return { registry, emitted, logs };
}

const dispatchArgs = { sessionId: "s1", action: "click", deadlineMs: 25 } as const;

describe("PanelCommandRegistry.dispatch", () => {
  test("emits one panel_command carrying a daemon-minted commandId, and registers it pending", () => {
    const { registry, emitted } = harness();
    const { commandId } = registry.dispatch({ ...dispatchArgs, tabId: "t1", args: { selector: "#buy" } });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "panel_command", sessionId: "s1", commandId, tabId: "t1",
      action: "click", args: { selector: "#buy" }, deadlineMs: 25,
    });
    expect(commandId.length).toBeGreaterThan(0);
    expect(registry.pendingCount).toBe(1);
  });

  test("two dispatches never share a commandId", () => {
    const { registry } = harness();
    const a = registry.dispatch(dispatchArgs).commandId;
    const b = registry.dispatch(dispatchArgs).commandId;
    expect(a).not.toBe(b);
  });

  // An emit that throws (hub.broadcastTransient rejects an unknown session, and re-validates the
  // event against the grown schema) must not strand a pending entry that nothing can ever resolve.
  test("an emit failure unwinds the pending entry instead of stranding it", () => {
    const { registry } = harness({ emit: () => { throw new Error("unknown session"); } });
    expect(() => registry.dispatch(dispatchArgs)).toThrow("unknown session");
    expect(registry.pendingCount).toBe(0);
  });
});

describe("PanelCommandRegistry.resolve — first result wins", () => {
  test("the first result settles the command; the second is DROPPED with a log line", async () => {
    const { registry, logs } = harness();
    const { commandId, settled } = registry.dispatch({ ...dispatchArgs, deadlineMs: 5000 });

    expect(registry.resolve({ sessionId: "s1", commandId, ok: true, result: "clicked" })).toBe("accepted");
    expect(await settled).toEqual({ kind: "result", ok: true, result: "clicked" });

    expect(registry.resolve({ sessionId: "s1", commandId, ok: false, result: "second opinion" })).toBe("dropped");
    // The outcome the agent already saw is the FIRST one, unchanged by the loser.
    expect(await settled).toEqual({ kind: "result", ok: true, result: "clicked" });
    expect(logs.some((l) => l.includes(commandId) && /dropped/.test(l))).toBe(true);
  });

  test("a failure verdict resolves just as decisively as a success", async () => {
    const { registry } = harness();
    const { commandId, settled } = registry.dispatch({ ...dispatchArgs, deadlineMs: 5000 });
    registry.resolve({ sessionId: "s1", commandId, ok: false, result: "no element matched #buy" });
    expect(await settled).toEqual({ kind: "result", ok: false, result: "no element matched #buy" });
  });

  test("a screenshot's image rides the outcome verbatim", async () => {
    const { registry } = harness();
    const { commandId, settled } = registry.dispatch({ ...dispatchArgs, action: "screenshot", deadlineMs: 5000 });
    registry.resolve({ sessionId: "s1", commandId, ok: true, imageBase64: "iVBORw0KG" });
    expect(await settled).toEqual({ kind: "result", ok: true, imageBase64: "iVBORw0KG" });
  });

  test("a commandId the daemon has never seen is rejected, not crashed on", () => {
    const { registry, logs } = harness();
    expect(registry.resolve({ sessionId: "s1", commandId: "never_minted", ok: true })).toBe("unknown");
    expect(registry.pendingCount).toBe(0);
    expect(logs.some((l) => l.includes("never_minted"))).toBe(true);
  });

  // commandId is a daemon-minted UUID so a collision isn't realistic — but without this check the
  // sessionId the RPC carries would be decorative, and a buggy harness could settle another
  // session's command.
  test("a result whose sessionId does not match the pending command is treated as unknown", async () => {
    const { registry } = harness();
    const { commandId, settled } = registry.dispatch({ ...dispatchArgs, deadlineMs: 5000 });
    expect(registry.resolve({ sessionId: "s_other", commandId, ok: true, result: "x" })).toBe("unknown");
    expect(registry.pendingCount).toBe(1);
    // The real owner can still settle it.
    expect(registry.resolve({ sessionId: "s1", commandId, ok: true, result: "mine" })).toBe("accepted");
    expect(await settled).toEqual({ kind: "result", ok: true, result: "mine" });
  });
});

describe("PanelCommandRegistry — deadline expiry", () => {
  test("expiry resolves as a TIMEOUT shape, distinguishable from an ok:false failure", async () => {
    const { registry } = harness();
    const { settled } = registry.dispatch({ ...dispatchArgs, deadlineMs: 5 });
    const outcome = await settled;
    expect(outcome).toEqual({ kind: "timeout", deadlineMs: 5 });
    // The distinction the tool depends on: a timeout is NOT an `ok: false` result.
    expect(outcome.kind === "timeout").toBe(true);
    expect(registry.pendingCount).toBe(0);
  });

  // Spec §3: "a timed-out command's late result is dropped by the dedup". Expiry must therefore
  // leave a RECORD, not just delete the entry — otherwise the late result reads as "unknown
  // commandId" and the app gets an RPC error for doing nothing wrong.
  test("a result arriving after expiry is dropped-as-late, never mistaken for unknown", async () => {
    const { registry, logs } = harness();
    const { commandId, settled } = registry.dispatch({ ...dispatchArgs, deadlineMs: 5 });
    await settled;
    expect(registry.resolve({ sessionId: "s1", commandId, ok: true, result: "too late" })).toBe("dropped");
    expect(logs.some((l) => l.includes(commandId) && /dropped/.test(l))).toBe(true);
  });

  test("the settled memory is bounded — it can never grow with session length", async () => {
    const { registry } = harness({ emit: () => {} });
    const ids: string[] = [];
    for (let i = 0; i < PanelCommandRegistry.SETTLED_MEMORY + 5; i++) {
      const { commandId } = registry.dispatch({ ...dispatchArgs, deadlineMs: 5000 });
      registry.resolve({ sessionId: "s1", commandId, ok: true });
      ids.push(commandId);
    }
    expect(registry.settledCount).toBe(PanelCommandRegistry.SETTLED_MEMORY);
    // The OLDEST settled ids were evicted (they now read as unknown); the newest are still known.
    expect(registry.resolve({ sessionId: "s1", commandId: ids[0]!, ok: true })).toBe("unknown");
    expect(registry.resolve({ sessionId: "s1", commandId: ids[ids.length - 1]!, ok: true })).toBe("dropped");
  });
});
