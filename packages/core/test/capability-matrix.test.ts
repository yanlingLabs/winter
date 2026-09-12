// Winter Phase 8d (P8d-15, WS-17 §6 row 9): the drift tripwire for `capability-matrix.json`.
// Regenerates the matrix from `buildCapabilityMatrix()` (the SAME function
// `scripts/capability-matrix.ts` calls at its own `import.meta.main` door) and diffs it against
// the committed file — a change to any of the three predicates the generator cites (decideRuntime's
// bail-outs, the CLI/remote surface-reachability literals, the mode tool registry) must show up
// here as a failing diff, never a silent staleness.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCapabilityMatrix } from "../scripts/capability-matrix";

const COMMITTED_PATH = join(import.meta.dir, "..", "capability-matrix.json");

describe("capability-matrix.json (P8d-15)", () => {
  test("the committed file is byte-identical to a fresh regeneration", () => {
    const fresh = buildCapabilityMatrix();
    const committedRaw = readFileSync(COMMITTED_PATH, "utf8");
    const committed = JSON.parse(committedRaw);
    expect(committed).toEqual(fresh);
    // Byte-identical too (not just structurally equal) — a formatting drift (key order, spacing)
    // is exactly the kind of "someone hand-edited the JSON" mistake this test also catches.
    expect(committedRaw).toBe(JSON.stringify(fresh, null, 2) + "\n");
  });

  test("covers every mode x runtime x surface combination exactly once (18 rows, no gaps/dupes)", () => {
    const { rows } = buildCapabilityMatrix();
    expect(rows.length).toBe(18);
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.mode}|${r.runtime}|${r.surface}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(18);
  });

  test("every row has a non-empty one-line reason (never a bare verdict)", () => {
    const { rows } = buildCapabilityMatrix();
    for (const r of rows) {
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.reason).not.toContain("\n");
    }
  });

  // Winter Phase 8d (P8d-15): the three pinned facts the generator's own header cites. These are
  // NOT re-derivations of the router's internal logic (out of this package's reach — see the
  // generator's header) — they pin the LITERAL predicates this generator was told to encode, so a
  // future edit that silently drops one of them (rather than deliberately changing it) fails loud.

  test("the official (claude-agent) leg is correctly-unavailable for every dispatch/chat cell, every surface", () => {
    const { rows } = buildCapabilityMatrix();
    const officialNonCode = rows.filter((r) => r.runtime === "claude-agent" && r.mode !== "code");
    expect(officialNonCode.length).toBe(6); // 2 modes x 3 surfaces
    for (const r of officialNonCode) expect(r.cell).toBe("correctly-unavailable");
  });

  test("the official (claude-agent) leg is implemented for every code cell, every surface", () => {
    const { rows } = buildCapabilityMatrix();
    const officialCode = rows.filter((r) => r.runtime === "claude-agent" && r.mode === "code");
    expect(officialCode.length).toBe(3); // 3 surfaces
    for (const r of officialCode) expect(r.cell).toBe("implemented");
  });

  test("the CLI surface is correctly-unavailable for dispatch/chat regardless of runtime (session-mode.ts: code-only)", () => {
    const { rows } = buildCapabilityMatrix();
    const cliNonCode = rows.filter((r) => r.surface === "cli" && r.mode !== "code");
    expect(cliNonCode.length).toBe(4); // 2 modes x 2 runtimes
    for (const r of cliNonCode) expect(r.cell).toBe("correctly-unavailable");
  });

  test("the Winter leg is implemented on every reachable (mode, surface) pair", () => {
    const { rows } = buildCapabilityMatrix();
    const winterRows = rows.filter((r) => r.runtime === "winter-agent");
    for (const r of winterRows) {
      const cliCodeOnly = r.surface === "cli" && r.mode !== "code";
      expect(r.cell).toBe(cliCodeOnly ? "correctly-unavailable" : "implemented");
    }
  });

  test("row shape is exactly the four documented fields, no stray keys", () => {
    const { rows } = buildCapabilityMatrix();
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["cell", "mode", "reason", "runtime", "surface"]);
    }
  });
});
