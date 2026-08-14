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

  test("context: 5 respects requested context at trim boundaries", () => {
    // 20-line shared prefix + 1 changed line + 20-line shared suffix
    const prefix = Array.from({ length: 20 }, (_, i) => `pre_${i}`).join("\n") + "\n";
    const before = prefix + "CHANGE\n" + Array.from({ length: 20 }, (_, i) => `post_${i}`).join("\n") + "\n";
    const after = prefix + "MODIFIED\n" + Array.from({ length: 20 }, (_, i) => `post_${i}`).join("\n") + "\n";
    const d = computeLineDiff(before, after, 5);
    expect(d.added).toBe(1); expect(d.removed).toBe(1); expect(d.hunkCount).toBe(1);
    // Hunk header should show exactly 5 context lines before and after the change.
    // Change is at line 21 (1-indexed), so with 5 context: lines 16-26 = 11 lines total
    expect(d.patch).toBe("@@ -16,11 +16,11 @@\n pre_15\n pre_16\n pre_17\n pre_18\n pre_19\n-CHANGE\n+MODIFIED\n post_0\n post_1\n post_2\n post_3\n post_4\n");
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

  test("property: diff round-trips correctly across 200 randomized trials", () => {
    // Generate random before/after, compute diff, apply patch, verify reconstruction equals after.
    const contextValues = [0, 1, 3, 5];
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

      // Round-trip: apply patch to before and verify we get after.
      const applied = applyPatch(before, d.patch);
      expect(applied).toBe(after);

      trialCount++;
    }
    expect(trialCount).toBe(200);
  });
});

// Helper: parse and apply a unified diff patch, reconstructing the target.
// Properly handles zero-count headers, cumulative offsets across hunks, and per-line eol flags.
function applyPatch(before: string, patch: string): string {
  if (patch === "") return before;

  // Split before into lines. Lines preserve their text; we track eol separately.
  interface LineData { text: string; eol: boolean }
  const beforeLines: LineData[] = [];
  if (before.length > 0) {
    let start = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] === "\n") {
        beforeLines.push({ text: before.slice(start, i), eol: true });
        start = i + 1;
      }
    }
    if (start < before.length) {
      beforeLines.push({ text: before.slice(start), eol: false });
    }
  }

  let lines = beforeLines.slice();
  let cumOffset = 0; // Cumulative offset across hunks due to adds/removes.

  // Parse and apply each hunk.
  const hunkMatches = Array.from(patch.matchAll(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g));

  for (const match of hunkMatches) {
    const a = parseInt(match[1]!, 10);
    const aCount = parseInt(match[2] || "1", 10);
    const cCount = parseInt(match[4] || "1", 10);

    // Determine the starting index for this hunk in the current working copy.
    // If aCount === 0, it's an insertion after line a (0-indexed: position = a + cumOffset).
    // Otherwise, start at line a (0-indexed: position = (a - 1) + cumOffset).
    const startIdx = (aCount === 0 ? a : a - 1) + cumOffset;

    // Extract hunk body (from end of header to start of next hunk or end).
    const hunkEndInPatch = match.index + match[0].length;
    const nextHunkMatch = hunkMatches[hunkMatches.indexOf(match) + 1];
    const nextHunkIdx = nextHunkMatch ? patch.indexOf("@@", nextHunkMatch.index) : patch.length;
    const bodyEndIdx = nextHunkIdx === -1 ? patch.length : patch.lastIndexOf("\n", nextHunkIdx - 1);
    const hunkBodyStr = patch.slice(hunkEndInPatch, bodyEndIdx).trimEnd();
    const bodyLines = hunkBodyStr.split("\n");

    // Apply hunk lines to the working copy.
    let lineIdx = startIdx;
    let hunkAdded = 0, hunkRemoved = 0;
    let lastLineHasNoEol = false;

    for (let i = 0; i < bodyLines.length; i++) {
      const bodyLine = bodyLines[i]!;
      if (bodyLine === "") continue;
      if (bodyLine === "\\ No newline at end of file") {
        lastLineHasNoEol = true;
        continue;
      }

      const op = bodyLine[0];
      const content = bodyLine.slice(1);

      if (op === " ") {
        // Context line: must match the working copy.
        if (lineIdx < lines.length) {
          const workingLine = lines[lineIdx]!;
          // Context line text must match (eol flag handled separately).
          if (workingLine.text !== content) {
            throw new Error(`Context mismatch at line ${lineIdx + 1}: expected "${content}", got "${workingLine.text}"`);
          }
        }
        lineIdx++;
      } else if (op === "-") {
        // Deletion: remove from working copy.
        if (lineIdx < lines.length) {
          const workingLine = lines[lineIdx]!;
          if (workingLine.text !== content) {
            throw new Error(`Deletion mismatch at line ${lineIdx + 1}: expected "${content}", got "${workingLine.text}"`);
          }
          lines.splice(lineIdx, 1);
          hunkRemoved++;
        }
      } else if (op === "+") {
        // Insertion: add to working copy.
        const eol = !(lastLineHasNoEol && i === bodyLines.length - 2);
        lines.splice(lineIdx, 0, { text: content, eol });
        lineIdx++;
        hunkAdded++;
      }
    }

    // Apply the "no newline at end of file" marker to the previous line if present.
    if (lastLineHasNoEol && lineIdx > 0) {
      lines[lineIdx - 1]!.eol = false;
    }

    // Update cumulative offset for the next hunk.
    cumOffset += (hunkAdded - hunkRemoved);
  }

  // Reconstruct the final string from the lines, respecting eol flags.
  let result = "";
  for (const lineData of lines) {
    result += lineData.text;
    if (lineData.eol) result += "\n";
  }
  return result;
}

