import { describe, expect, test } from "bun:test";
import { isStalled, applyEvent, type WatchdogState } from "../src/watchdog";

function fresh(): WatchdogState { return { turnRunning: false, toolsInFlight: 0, approvalsPending: 0, lastEventAt: 0 }; }

describe("watchdog: a message folded into the running turn (agent SDK 0.0.44)", () => {
  test("a turn_started while a turn runs keeps what is in flight — a pending approval is still legitimate silence", () => {
    const s = fresh();
    applyEvent(s, { type: "turn_started" }, 0);
    applyEvent(s, { type: "approval_requested" }, 100);
    applyEvent(s, { type: "turn_started" }, 200);        // the fold's announcement
    expect(s.approvalsPending).toBe(1);
    expect(isStalled(s, 60_000, 5000)).toBe(false);
  });
});

describe("watchdog isStalled", () => {
  test("fires only when running, no tool in-flight, no approval pending, past threshold", () => {
    const s = fresh();
    applyEvent(s, { type: "turn_started" }, 1000);
    expect(isStalled(s, 1000, 5000)).toBe(false);        // just started
    expect(isStalled(s, 6001, 5000)).toBe(true);         // 5001ms of silence, running, idle
    applyEvent(s, { type: "tool_call" }, 7000);          // a tool is now in flight
    expect(isStalled(s, 99000, 5000)).toBe(false);       // never stalls while a tool runs
    applyEvent(s, { type: "tool_result" }, 8000);        // tool done
    expect(isStalled(s, 14001, 5000)).toBe(true);        // silent again → stalls
  });

  test("does not fire while an approval is pending", () => {
    const s = fresh();
    applyEvent(s, { type: "turn_started" }, 0);
    applyEvent(s, { type: "approval_requested" }, 100);
    expect(isStalled(s, 999999, 5000)).toBe(false);      // waiting on the user, not a stall
    applyEvent(s, { type: "approval_resolved" }, 200);
    expect(isStalled(s, 6000, 5000)).toBe(true);
  });

  test("does not fire after the turn completes", () => {
    const s = fresh();
    applyEvent(s, { type: "turn_started" }, 0);
    applyEvent(s, { type: "turn_completed" }, 100);
    expect(isStalled(s, 999999, 5000)).toBe(false);
  });

  test("turn_started resets leftover counters from a prior turn (no stall suppression)", () => {
    const s = fresh();
    applyEvent(s, { type: "turn_started" }, 0);
    applyEvent(s, { type: "tool_call" }, 10);      // a tool in flight...
    applyEvent(s, { type: "turn_completed" }, 20); // ...turn ends WITHOUT a tool_result (counter left at 1)
    applyEvent(s, { type: "turn_started" }, 1000);   // new turn must reset toolsInFlight/approvalsPending to 0
    expect(isStalled(s, 6001, 5000)).toBe(true);    // silent + running + counters reset → stalls (would be suppressed if not reset)
  });

  test("exact threshold boundary is NOT a stall (strict >)", () => {
    const s = fresh();
    applyEvent(s, { type: "turn_started" }, 1000);
    expect(isStalled(s, 6000, 5000)).toBe(false);  // now-last === threshold → not yet stalled
    expect(isStalled(s, 6001, 5000)).toBe(true);   // one past → stalled
  });
});
