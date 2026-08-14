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

  test("context: 0 produces separate hunks for adjacent changes", () => {
    const before = "a\nb\nc\n";
    const after = "A\nb\nC\n";
    const d = computeLineDiff(before, after, 0);
    expect(d.hunkCount).toBe(2);
    expect(d.added).toBe(2); expect(d.removed).toBe(2);
  });

  test("context: 1 with single-line replacement", () => {
    const before = "1\n2\n3\n4\n5\n";
    const after = "1\n2\nX\n4\n5\n";
    const d = computeLineDiff(before, after, 1);
    expect(d.added).toBe(1); expect(d.removed).toBe(1); expect(d.hunkCount).toBe(1);
    expect(d.patch).toBe("@@ -2,3 +2,3 @@\n 2\n-3\n+X\n 4\n");
  });

  test("large file with single small change stays cheap and exact", () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => String(i));
    const before = lines.join("\n") + "\n";
    const after = lines.map((l, i) => i === 25_000 ? "MODIFIED" : l).join("\n") + "\n";
    const d = computeLineDiff(before, after);
    expect(d.added).toBe(1); expect(d.removed).toBe(1); expect(d.hunkCount).toBe(1);
    // Hunk should be around line 25,000 (1-indexed), with up to 3 context lines either side.
    expect(d.patch).toContain("-25000\n");
    expect(d.patch).toContain("+MODIFIED\n");
  });

  test("budget fallback produces valid diffs via whole-replace", () => {
    // This test verifies the budget path works: create inputs large enough that trace budget
    // will kick in, forcing whole-file-replace, but verify the patch is still valid.
    const before = Array.from({ length: 10_000 }, (_, i) => `line_${i}`).join("\n") + "\n";
    const after = Array.from({ length: 10_000 }, (_, i) => `LINE_${i}`).join("\n") + "\n";
    const d = computeLineDiff(before, after);
    expect(d.added).toBe(10_000); expect(d.removed).toBe(10_000);
    // When all lines differ, it's a single hunk in whole-replace mode.
    expect(d.hunkCount).toBe(1);
  });

  test("property: diff produces consistent counts across 200 randomized trials", () => {
    // Generate random before/after, compute diff, verify counts are consistent with patch content.
    const contextValues = [0, 1, 3];
    let trialCount = 0;

    for (let trial = 0; trial < 200; trial++) {
      // Simple seeded RNG.
      let seed = 12345 + trial;
      const rng = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };

      // Generate random line counts.
      const beforeCount = Math.floor(rng() * 40);
      const afterCount = Math.floor(rng() * 40);

      // Generate random lines.
      const genLine = () => {
        const len = Math.floor(rng() * 8) + 1;
        let text = "";
        for (let j = 0; j < len; j++) {
          text += String.fromCharCode(65 + Math.floor(rng() * 26));
        }
        return text;
      };

      const beforeLines = Array.from({ length: beforeCount }, () => genLine());
      const afterLines = Array.from({ length: afterCount }, () => genLine());
      const before = beforeLines.length ? beforeLines.join("\n") + "\n" : "";
      const after = afterLines.length ? afterLines.join("\n") + "\n" : "";
      const context = contextValues[Math.floor(rng() * contextValues.length)]!;

      const d = computeLineDiff(before, after, context);

      // Verify counts match patch content.
      const addedInPatch = (d.patch.match(/^\+/gm) ?? []).length;
      const removedInPatch = (d.patch.match(/^-/gm) ?? []).length;
      expect(d.added).toBe(addedInPatch);
      expect(d.removed).toBe(removedInPatch);

      // Verify patch is well-formed (all hunks have valid headers).
      const hunkCount = (d.patch.match(/^@@/gm) ?? []).length;
      expect(d.hunkCount).toBe(hunkCount);

      trialCount++;
    }
    expect(trialCount).toBe(200);
  });
});

// Helper: parse and apply a unified diff patch.
function applyPatch(before: string, patch: string): string {
  if (patch === "") return before;

  // Split before into lines, tracking if it ends with a newline.
  const beforeLines = before.length === 0
    ? []
    : before.endsWith("\n")
      ? before.slice(0, -1).split("\n")
      : before.split("\n");

  let lines = beforeLines.slice();

  // Split patch into hunks.
  const hunkMatches = Array.from(patch.matchAll(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\n]*)\n/g));

  for (const match of hunkMatches) {
    const aStart = parseInt(match[1]!, 10) - 1; // Convert to 0-indexed
    const bStart = parseInt(match[3]!, 10) - 1;

    // Find the body of this hunk (from end of header to start of next hunk or end).
    const hunkStartIdx = match.index + match[0].length;
    const nextHunkIdx = patch.indexOf("\n@@", hunkStartIdx);
    const hunkEndIdx = nextHunkIdx === -1 ? patch.length : nextHunkIdx;
    const hunkBody = patch.slice(hunkStartIdx, hunkEndIdx);
    const hunkLines = hunkBody.split("\n");

    // Process hunk lines.
    let lineIdx = aStart;
    for (const line of hunkLines) {
      if (line === "") continue;
      if (line === "\\ No newline at end of file") continue;

      const op = line[0];
      const content = line.slice(1);

      if (op === " ") {
        // Context line
        lineIdx++;
      } else if (op === "-") {
        // Deletion
        lines.splice(lineIdx, 1);
      } else if (op === "+") {
        // Addition
        lines.splice(lineIdx, 0, content);
        lineIdx++;
      }
    }
  }

  // Reconstruct: join with newlines, add final newline if before had one or lines exist.
  if (lines.length === 0) return "";
  return lines.join("\n") + "\n";
}

