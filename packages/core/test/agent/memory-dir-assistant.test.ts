import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assistantMemoryDirFor, memoryDirFor } from "../../src/agent/memory-dir";
import { storeProjectsDir } from "../../src/agent/paths";

describe("assistantMemoryDirFor", () => {
  test("resolves the reserved bucket and ignores the relocation override", () => {
    expect(assistantMemoryDirFor({ winterHome: "/tmp/nh" })).toBe(join(storeProjectsDir("/tmp/nh"), "_assistant", "memory")) // the store home: sdk/ on a run-home build;
    // memory.directory override relocates project memory but NOT the assistant bucket —
    // otherwise code sessions (which follow the override) would load dream memories.
    const overridden = memoryDirFor("/tmp/anywhere", { winterHome: "/tmp/nh", directory: "/tmp/custom" });
    expect(overridden).toBe("/tmp/custom");
    expect(assistantMemoryDirFor({ winterHome: "/tmp/nh" })).not.toBe("/tmp/custom");
  });
});
