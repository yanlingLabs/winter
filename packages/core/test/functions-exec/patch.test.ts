import { describe, expect, test } from "bun:test";
import { parseCodexPatch } from "../../src/functions-exec/patch";

describe("functions-exec raw Codex patch grammar", () => {
  test("parses an add, update, and delete into bounded canonical operations", () => {
    expect(parseCodexPatch([
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+one",
      "*** Update File: existing.txt",
      "@@ heading",
      " old",
      "-before",
      "+after",
      "*** Delete File: obsolete.txt",
      "*** End Patch",
    ].join("\n"))).toEqual([
      { type: "add", path: "new.txt", content: "one\n" },
      { type: "update", path: "existing.txt", hunks: [{ context: "heading", oldLines: ["old", "before"], newLines: ["old", "after"], endOfFile: false }] },
      { type: "delete", path: "obsolete.txt" },
    ]);
  });

  test("rejects paths that could escape the later transaction root or ambiguous operations", () => {
    for (const path of ["../outside.txt", "/outside.txt", "C:/outside.txt", "same.txt"]) {
      const source = path === "same.txt"
        ? ["*** Begin Patch", "*** Delete File: same.txt", "*** Delete File: same.txt", "*** End Patch"].join("\n")
        : ["*** Begin Patch", "*** Delete File: " + path, "*** End Patch"].join("\n");
      expect(() => parseCodexPatch(source)).toThrow(/path|duplicate/i);
    }
  });
});
