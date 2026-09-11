import { describe, expect, test } from "bun:test";
import { NORMA_BRAND } from "../../src/runtime-sdk/brand";
import {
  CAPABILITY_SERVER_KEYS,
  NORMA_CAPABILITY_TOOLS,
  capabilityToolName,
  type CapabilityToolFacts,
} from "../../src/capabilities/names";

/**
 * P8b-12 — the canonical capability tool names.
 *
 * The literals below are PASTED, not derived: this file's whole job is to prove that the table in
 * `names.ts` and the function that builds a name agree, so deriving the expectation from the thing
 * under test would prove nothing. `mcpToolName` is two-arg (Task 5's measurement), so the
 * `<server>__<tool>` join happens in `capabilityToolName` — which is exactly the step that could
 * silently produce `mcp__norma__list_sessions` instead.
 */

/** WS-06 §5's names for the servers Task 6 builds, spelled out. */
const TASK_6_NAMES = [
  "mcp__norma__sessions__session_spawn",
  "mcp__norma__sessions__list_sessions",
  "mcp__norma__sessions__manage_session",
  "mcp__norma__computer__computer",
] as const;

describe("capabilityToolName (P8b-12)", () => {
  test("builds the literal mcp__norma__<key>__<tool> form", () => {
    expect(capabilityToolName("sessions", "session_spawn")).toBe("mcp__norma__sessions__session_spawn");
    expect(capabilityToolName("computer", "computer")).toBe("mcp__norma__computer__computer");
    expect(capabilityToolName("research", "ReadPage")).toBe("mcp__norma__research__ReadPage");
  });

  test("is branded `norma`, never `winter` (R-1)", () => {
    expect(NORMA_BRAND.mcpServerName).toBe("norma");
    for (const name of Object.keys(NORMA_CAPABILITY_TOOLS)) {
      expect(name.startsWith("mcp__norma__")).toBe(true);
      expect(name).not.toContain("winter");
    }
  });
});

describe("NORMA_CAPABILITY_TOOLS", () => {
  test("every name matches the P8b-12 shape", () => {
    for (const name of Object.keys(NORMA_CAPABILITY_TOOLS)) {
      expect(name).toMatch(/^mcp__norma__[a-z]+__[A-Za-z_]+$/);
    }
  });

  test("every key equals capabilityToolName(serverKey, tool) for a declared server key", () => {
    for (const name of Object.keys(NORMA_CAPABILITY_TOOLS)) {
      const rest = name.slice("mcp__norma__".length);
      const key = CAPABILITY_SERVER_KEYS.find((k) => rest.startsWith(`${k}__`));
      expect(key, `${name} names no declared capability server`).toBeDefined();
      const tool = rest.slice(`${key!}__`.length);
      expect(capabilityToolName(key!, tool)).toBe(name);
    }
  });

  test("carries exactly Task 6's four names so far", () => {
    expect(Object.keys(NORMA_CAPABILITY_TOOLS).sort()).toEqual([...TASK_6_NAMES].sort());
  });

  test("modes and deferral mirror today's registrations", () => {
    const t = NORMA_CAPABILITY_TOOLS as Readonly<Record<string, CapabilityToolFacts>>;
    // `modes: ["dispatch"]` on all three session tools (list-sessions.ts / session-spawn.ts).
    expect(t["mcp__norma__sessions__session_spawn"]).toEqual({ modes: ["dispatch"] });
    expect(t["mcp__norma__sessions__list_sessions"]).toEqual({ modes: ["dispatch"], deferred: true });
    expect(t["mcp__norma__sessions__manage_session"]).toEqual({ modes: ["dispatch"], deferred: true });
    // computer.ts declares `modes: ["code","dispatch"]`; daemon.ts passes `deferred: ["dispatch"]`.
    expect(t["mcp__norma__computer__computer"]).toEqual({ modes: ["code", "dispatch"], deferred: ["dispatch"] });
  });

  test("is a plain data table Task 9 can diff (no functions, no getters)", () => {
    for (const [name, facts] of Object.entries(NORMA_CAPABILITY_TOOLS as Readonly<Record<string, CapabilityToolFacts>>)) {
      expect(Object.getOwnPropertyDescriptor(NORMA_CAPABILITY_TOOLS, name)?.get).toBeUndefined();
      expect(Array.isArray(facts.modes)).toBe(true);
      for (const mode of facts.modes) expect(["code", "dispatch", "chat"]).toContain(mode);
    }
  });
});
