import { describe, expect, test } from "bun:test";
import { restrictPolicy, mapSpawnMode } from "../../src/agent/engine";

describe("restrictPolicy over 6 modes (SP-policies)", () => {
  test("child may restrict, never widen", () => {
    expect(restrictPolicy("ask", "bypass")).toBe("ask");      // requested widens → parent wins
    expect(restrictPolicy("auto", "ask")).toBe("ask");        // requested restricts → requested wins
    expect(restrictPolicy("bypass", "plan")).toBe("plan");    // most→least
    expect(restrictPolicy("dont-ask", "accept-edits")).toBe("dont-ask"); // widen → parent wins
    expect(restrictPolicy("accept-edits", "dont-ask")).toBe("dont-ask"); // restrict → requested
  });
});

describe("mapSpawnMode → the six modes", () => {
  test("CC modes map to their real policies (no collapse to auto)", () => {
    expect(mapSpawnMode("plan")).toBe("plan");
    expect(mapSpawnMode("acceptEdits")).toBe("accept-edits");
    expect(mapSpawnMode("dontAsk")).toBe("dont-ask");
    expect(mapSpawnMode("bypassPermissions")).toBe("bypass");
    expect(mapSpawnMode("default")).toBeUndefined();
    expect(mapSpawnMode(undefined)).toBeUndefined();
  });
});
