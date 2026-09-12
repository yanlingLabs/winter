import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDirectories } from "../../src/agent/dirs";

function realDir() { return realpathSync(mkdtempSync(join(tmpdir(), "winter-dirs-"))); }

describe("SessionDirectories", () => {
  test("roots = base + runtime-added, deduped/realpath'd", () => {
    const cwd = realDir(); const extra = realDir(); const added = realDir();
    const sd = new SessionDirectories(() => [cwd, extra]);
    expect(sd.roots("s1").sort()).toEqual([cwd, extra].sort());
    sd.add("s1", added);
    expect(sd.roots("s1")).toContain(added);
    expect(sd.has("s1", added)).toBe(true);
    // per-session isolation:
    expect(sd.roots("s2")).not.toContain(added);
    // dedup:
    sd.add("s1", extra);
    expect(sd.roots("s1").filter((r) => r === extra)).toHaveLength(1);
  });

  test("base dirs come first — roots[0] is the primary cwd even after adding dirs (invariant)", () => {
    const cwd = realDir(); const extra = realDir(); const added = realDir();
    const sd = new SessionDirectories(() => [cwd, extra]);
    expect(sd.roots("s1")[0]).toBe(cwd);      // base-first, unsorted
    sd.add("s1", added);
    expect(sd.roots("s1")[0]).toBe(cwd);      // still cwd after add
    expect(sd.roots("s1").indexOf(added)).toBeGreaterThan(sd.roots("s1").indexOf(extra)); // added AFTER base
  });

  test("a non-existent base/added dir passes through without crashing roots()/has()", () => {
    const cwd = realDir();
    const ghost = "/tmp/winter-nonexistent-" + "zzz9999";
    const sd = new SessionDirectories(() => [cwd, ghost]);
    expect(() => sd.roots("s1")).not.toThrow();
    expect(sd.roots("s1")).toContain(ghost); // canon() falls back to the literal path
    sd.add("s1", "/tmp/winter-nonexistent-added-zzz");
    expect(() => sd.has("s1", "/tmp/winter-nonexistent-added-zzz")).not.toThrow();
  });

  // Regression (S1): exit_worktree {remove} deletes the worktree dir from disk but, without a
  // remove() method, it lingered forever in the `added` set — resolveWithinAny then had to
  // realpath a since-deleted root on every subsequent fs call.
  test("remove() undoes a prior add() — the dir no longer appears in roots()/has()", () => {
    const cwd = realDir(); const added = realDir();
    const sd = new SessionDirectories(() => [cwd]);
    sd.add("s1", added);
    expect(sd.roots("s1")).toContain(added);
    sd.remove("s1", added);
    expect(sd.roots("s1")).not.toContain(added);
    expect(sd.has("s1", added)).toBe(false);
  });

  test("remove() still works after the added dir was deleted from disk (the worktree {remove} case)", () => {
    const cwd = realDir();
    const gone = join(realDir(), "will-be-removed");
    mkdirSync(gone);
    const sd = new SessionDirectories(() => [cwd]);
    sd.add("s1", gone); // canonicalized while it still exists
    expect(sd.roots("s1")).toContain(gone);
    rmSync(gone, { recursive: true });
    expect(() => sd.remove("s1", gone)).not.toThrow();
    expect(sd.roots("s1")).not.toContain(gone);
  });

  test("remove() on a dir that was never added is a harmless no-op", () => {
    const cwd = realDir(); const notAdded = realDir();
    const sd = new SessionDirectories(() => [cwd]);
    expect(() => sd.remove("s1", notAdded)).not.toThrow();
    expect(sd.roots("s1")).not.toContain(notAdded);
  });
});
