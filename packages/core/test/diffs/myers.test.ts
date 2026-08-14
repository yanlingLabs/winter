import { describe, expect, test } from "bun:test";
import { computeLineDiff } from "../../src/diffs/myers";

describe("computeLineDiff", () => {
  test("equal inputs produce the empty diff", () => {
    const d = computeLineDiff("a\nb\n", "a\nb\n");
    expect(d).toEqual({ patch: "", added: 0, removed: 0, hunkCount: 0 });
  });
  test("empty → content is all-added (the write-new-file case)", () => {
    const d = computeLineDiff("", "x\ny\n");
    expect(d.added).toBe(2); expect(d.removed).toBe(0); expect(d.hunkCount).toBe(1);
    expect(d.patch).toBe("@@ -0,0 +1,2 @@\n+x\n+y\n");
  });
  test("content → empty is all-removed", () => {
    const d = computeLineDiff("x\ny\n", "");
    expect(d.added).toBe(0); expect(d.removed).toBe(2);
    expect(d.patch).toBe("@@ -1,2 +0,0 @@\n-x\n-y\n");
  });
  test("single replacement carries 3 context lines and correct numbers", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    const after  = "1\n2\n3\n4\nX\n6\n7\n8\n9\n";
    const d = computeLineDiff(before, after);
    expect(d.added).toBe(1); expect(d.removed).toBe(1); expect(d.hunkCount).toBe(1);
    expect(d.patch).toBe("@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+X\n 6\n 7\n 8\n");
  });
  test("distant changes produce two hunks", () => {
    const before = Array.from({ length: 30 }, (_, i) => String(i)).join("\n") + "\n";
    const after = before.replace(/^2$/m, "TWO").replace(/^27$/m, "TWENTYSEVEN");
    const d = computeLineDiff(before, after);
    expect(d.hunkCount).toBe(2); expect(d.added).toBe(2); expect(d.removed).toBe(2);
  });
  test("no trailing newline gets the marker", () => {
    const d = computeLineDiff("a\n", "a\nb");
    expect(d.patch.endsWith("+b\n\\ No newline at end of file\n")).toBe(true);
  });
  test("unicode lines survive byte-identically", () => {
    const d = computeLineDiff("héllo\n", "héllo wörld 🌍\n");
    expect(d.patch).toContain("-héllo\n");
    expect(d.patch).toContain("+héllo wörld 🌍\n");
  });
  test("CRLF is preserved as-is inside lines", () => {
    const d = computeLineDiff("a\r\n", "b\r\n");
    expect(d.patch).toContain("-a\r\n"); expect(d.patch).toContain("+b\r\n");
  });
  test("counts always match the patch body", () => {
    const d = computeLineDiff("a\nb\nc\n", "a\nB\nc\nd\n");
    const plus = (d.patch.match(/^\+/gm) ?? []).length;
    const minus = (d.patch.match(/^-/gm) ?? []).length;
    expect(d.added).toBe(plus); expect(d.removed).toBe(minus);
  });
  test("oversized input falls back to whole-file replace, counts intact", () => {
    const big = "x\n".repeat(30_001);
    const d = computeLineDiff(big, "y\n".repeat(30_001));
    expect(d.removed).toBe(30_001); expect(d.added).toBe(30_001); expect(d.hunkCount).toBe(1);
  });
});
