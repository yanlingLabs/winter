import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyCodexPatch } from "../../src/functions-exec/apply-patch";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "norma-functions-patch-"));
  dirs.push(dir);
  return dir;
}

describe("functions-exec raw patch application", () => {
  test("stages add, update, and delete before committing the full Codex patch", () => {
    const root = workspace();
    writeFileSync(join(root, "update.txt"), "old\n");
    writeFileSync(join(root, "delete.txt"), "delete me\n");
    const patch = "*** Begin Patch\n*** Add File: add.txt\n+added\n*** Update File: update.txt\n@@\n-old\n+new\n*** Delete File: delete.txt\n*** End Patch";
    expect(applyCodexPatch(patch, [root])).toBe("Applied patch to 3 files");
    expect(readFileSync(join(root, "add.txt"), "utf8")).toBe("added\n");
    expect(readFileSync(join(root, "update.txt"), "utf8")).toBe("new\n");
    expect(() => readFileSync(join(root, "delete.txt"))).toThrow();
  });

  test("does not mutate any target when patch preflight cannot stage every operation", () => {
    const root = workspace();
    writeFileSync(join(root, "one.txt"), "one\n");
    const patch = "*** Begin Patch\n*** Update File: one.txt\n@@\n-one\n+two\n*** Update File: missing.txt\n@@\n-missing\n+present\n*** End Patch";
    expect(() => applyCodexPatch(patch, [root])).toThrow("update target does not exist");
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("one\n");
  });
});
