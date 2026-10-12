// ComputerV2 Phase 4 — what the headless pool's memory guard reads: the helper's whole process tree's physical
// footprint (Activity Monitor's "Memory", summed), never a resident-size sum that counts shared pages once per process.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { libprocAvailable, libprocReader, processTreeFootprint, processTreeRss, treeFootprint, type TreeReader } from "../../src/computer-use/browser/headless/memory";

function fakeTree(rows: Record<number, { fp?: number; kids?: number[] }>): TreeReader {
  return {
    footprint: (pid) => rows[pid]?.fp,
    children: (pid) => (rows[pid] === undefined ? undefined : rows[pid]!.kids ?? []),
  };
}

describe("the tree's footprint", () => {
  test("sums the root and every process under it, at any depth", () => {
    const reader = fakeTree({ 1: { fp: 100, kids: [2, 3] }, 2: { fp: 20, kids: [4] }, 3: { fp: 30 }, 4: { fp: 4 }, 9: { fp: 1_000 } });
    expect(treeFootprint(1, reader)).toBe(154);
    expect(treeFootprint(2, reader)).toBe(24);
  });

  test("a process that exits mid-walk counts nothing; a root that is gone reads undefined", () => {
    expect(treeFootprint(1, fakeTree({ 1: { fp: 100, kids: [2, 3] }, 3: { fp: 30 } }))).toBe(130);
    expect(treeFootprint(7, fakeTree({ 1: { fp: 100 } }))).toBeUndefined();
  });

  test("never loops on a cycle or counts a process twice", () => {
    expect(treeFootprint(1, fakeTree({ 1: { fp: 10, kids: [2, 2] }, 2: { fp: 5, kids: [1] } }))).toBe(15);
  });
});

describe("the real reading (libproc over bun:ffi)", () => {
  test("is reachable on macOS", () => {
    expect(libprocAvailable()).toBe(process.platform === "darwin");
  });

  test("reads this process and the children it spawned; a child's footprint is in the tree's", async () => {
    if (!libprocAvailable()) return;
    const child = spawn("/bin/sleep", ["30"], { stdio: "ignore", env: { ...process.env } });
    try {
      await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
      const pid = child.pid!;
      expect(libprocReader.children(process.pid)).toContain(pid);
      const own = libprocReader.footprint(process.pid)!;
      const kid = libprocReader.footprint(pid)!;
      expect(own).toBeGreaterThan(1024 * 1024);
      expect(kid).toBeGreaterThan(0);
      const tree = processTreeFootprint(process.pid)!;
      // Other children may come and go meanwhile (the test runner's own), so the bound is one-sided.
      expect(tree).toBeGreaterThanOrEqual(kid);
      expect(tree).toBeGreaterThan(own / 2);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("a pid with no process reads undefined", () => {
    if (!libprocAvailable()) return;
    expect(libprocReader.footprint(0x7ffffff0)).toBeUndefined();
    expect(processTreeFootprint(0x7ffffff0)).toBeUndefined();
  });

  test("the resident-size stand-in still reads this process", () => {
    expect(processTreeRss(process.pid)).toBeGreaterThan(1024 * 1024);
  });
});
