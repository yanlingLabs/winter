import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assistantMemoryDirFor, memoryDirFor } from "../../src/agent/memory-dir";

describe("assistantMemoryDirFor", () => {
  test("resolves the reserved bucket and ignores the relocation override", () => {
    expect(assistantMemoryDirFor({ normaHome: "/tmp/nh" })).toBe(join("/tmp/nh", "projects", "_assistant", "memory"));
    // memory.directory override relocates project memory but NOT the assistant bucket —
    // otherwise code sessions (which follow the override) would load dream memories.
    const overridden = memoryDirFor("/tmp/anywhere", { normaHome: "/tmp/nh", directory: "/tmp/custom" });
    expect(overridden).toBe("/tmp/custom");
    expect(assistantMemoryDirFor({ normaHome: "/tmp/nh" })).not.toBe("/tmp/custom");
  });
});
