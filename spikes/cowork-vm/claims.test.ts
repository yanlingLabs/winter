import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOrchestrator, assertOrchestrator } from "./claims";

test("staging claim excludes competing runner and direct probe until proven stop", () => {
  const root = mkdtempSync(join(tmpdir(), "cowork-claim-unit-"));
  try {
    expect(() => assertOrchestrator(root)).toThrow();
    const first = acquireOrchestrator(root);
    expect(() => acquireOrchestrator(root)).toThrow();
    expect(() => assertOrchestrator(root)).toThrow();
    expect(() => assertOrchestrator(root, "wrong")).toThrow();
    assertOrchestrator(root, first.token);
    first.release(false);
    expect(() => acquireOrchestrator(root)).toThrow();
    first.release(true);
    const second = acquireOrchestrator(root);
    expect(second.token).not.toBe(first.token);
    second.release(true);
  } finally { rmSync(root, { recursive: true }); } // No VM exists in this unit test.
});
