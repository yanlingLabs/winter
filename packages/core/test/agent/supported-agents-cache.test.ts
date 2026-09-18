import { describe, expect, test } from "bun:test";
import { SupportedAgentsCache } from "../../src/agent/supported-agents-cache";

describe("SupportedAgentsCache", () => {
  test("nothing observed yet -> null, never an invented list", () => {
    expect(new SupportedAgentsCache().get()).toBeNull();
  });

  test("observe() then get() returns the exact agents + sessionId, with an observedAt timestamp", () => {
    const c = new SupportedAgentsCache();
    const before = Date.now();
    c.observe("s_1", [{ name: "Explore", description: "read-only search" }]);
    const snap = c.get();
    expect(snap?.sessionId).toBe("s_1");
    expect(snap?.agents).toEqual([{ name: "Explore", description: "read-only search" }]);
    expect(snap?.observedAt).toBeGreaterThanOrEqual(before);
  });

  test("a later observe() from a DIFFERENT session overwrites — the most recent answer wins, never merged", () => {
    const c = new SupportedAgentsCache();
    c.observe("s_1", [{ name: "Explore", description: "d1" }]);
    c.observe("s_2", [{ name: "Plan", description: "d2" }]);
    expect(c.get()).toEqual({ sessionId: "s_2", agents: [{ name: "Plan", description: "d2" }], observedAt: expect.any(Number) });
  });
});
