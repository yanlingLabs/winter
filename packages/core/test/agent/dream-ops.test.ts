import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILES, MAX_FILE_BYTES, MAX_OPS, RESERVED_FILES, applyOps, validateOps, type DreamOp } from "../../src/agent/dream-ops";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-dreamops-"))); }

describe("dream-ops: validateOps", () => {
  test("valid mixed list parses", () => {
    const raw = [
      { op: "write", file: "coffee-pref.md", content: "Likes oat milk." },
      { op: "delete", file: "old-note.md" },
      { op: "tombstone", text: "removed stale advice" },
    ];
    const res = validateOps(raw, ["old-note.md"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.ops).toEqual(raw as DreamOp[]);
  });

  test("13 ops -> error mentioning 12", () => {
    const raw = Array.from({ length: 13 }, (_, i) => ({ op: "tombstone", text: `t${i}` }));
    const res = validateOps(raw, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("12");
  });

  test("content 8193 bytes -> error mentioning 8KB/8192", () => {
    const raw = [{ op: "write", file: "big-note.md", content: "a".repeat(8193) }];
    const res = validateOps(raw, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/8KB|8192/);
  });

  test("write creating a 65th file -> error mentioning 64; write to an existing name at 64 is OK", () => {
    const existing = Array.from({ length: 64 }, (_, i) => `existing-${i}.md`);

    const growing = validateOps([{ op: "write", file: "new-name.md", content: "hi" }], existing);
    expect(growing.ok).toBe(false);
    if (!growing.ok) expect(growing.error).toContain("64");

    const overwrite = validateOps([{ op: "write", file: "existing-0.md", content: "hi" }], existing);
    expect(overwrite.ok).toBe(true);
  });

  test("reserved files are rejected", () => {
    for (const file of ["MEMORY.md", "tombstones.md", "dream-state.json"]) {
      expect(RESERVED_FILES.has(file)).toBe(true);
      const res = validateOps([{ op: "write", file, content: "hi" }], []);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("reserved");
    }
  });

  test("non-kebab-case / non-.md file names are rejected", () => {
    for (const file of ["Notes.md", "a_b.md", "sub/dir.md", "x.txt"]) {
      const res = validateOps([{ op: "write", file, content: "hi" }], []);
      expect(res.ok).toBe(false);
    }
  });

  test("non-array raw -> error", () => {
    const res = validateOps({ not: "an array" }, []);
    expect(res.ok).toBe(false);
  });

  test("missing fields -> error", () => {
    const res = validateOps([{ op: "write" }], []);
    expect(res.ok).toBe(false);
  });

  test("unknown op -> error", () => {
    const res = validateOps([{ op: "frobnicate", file: "a.md" }], []);
    expect(res.ok).toBe(false);
  });

  test("tombstone with empty text -> error", () => {
    const res = validateOps([{ op: "tombstone", text: "   " }], []);
    expect(res.ok).toBe(false);
  });
});

describe("dream-ops: applyOps", () => {
  test("write creates file with exact content; MEMORY.md gains one line referencing it", () => {
    const dir = realDir();
    applyOps(dir, [{ op: "write", file: "coffee-pref.md", content: "Likes oat milk lattes." }]);
    expect(readFileSync(join(dir, "coffee-pref.md"), "utf8")).toBe("Likes oat milk lattes.");
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(index).toContain("- [coffee-pref](coffee-pref.md) — Likes oat milk lattes.");
  });

  test("re-write of same file updates content and does not duplicate the index line", () => {
    const dir = realDir();
    applyOps(dir, [{ op: "write", file: "coffee-pref.md", content: "Likes oat milk." }]);
    applyOps(dir, [{ op: "write", file: "coffee-pref.md", content: "Likes almond milk now." }]);
    expect(readFileSync(join(dir, "coffee-pref.md"), "utf8")).toBe("Likes almond milk now.");
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    const lines = index.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toHaveLength(1);
    expect(index).toContain("Likes almond milk now.");
  });

  test("hook line skips frontmatter and headings, trims, caps at 120 chars", () => {
    const dir = realDir();
    const long = "x".repeat(200);
    applyOps(dir, [{ op: "write", file: "long-note.md", content: `---\nname: long-note\n---\n# Heading\n\n  ${long}  \n` }]);
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    const line = index.split("\n").find((l) => l.startsWith("- [long-note]"));
    expect(line).toBeDefined();
    const hook = line!.split(" — ")[1]!;
    expect(hook).toHaveLength(120);
    expect(hook).toBe(long.slice(0, 120));
  });

  test("delete removes file and its MEMORY.md line; deleting a nonexistent file is a no-op", () => {
    const dir = realDir();
    applyOps(dir, [{ op: "write", file: "coffee-pref.md", content: "Likes oat milk." }]);
    applyOps(dir, [{ op: "delete", file: "coffee-pref.md" }]);
    expect(existsSync(join(dir, "coffee-pref.md"))).toBe(false);
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).not.toContain("coffee-pref");

    // deleting a file that never existed should not throw
    expect(() => applyOps(dir, [{ op: "delete", file: "ghost.md" }])).not.toThrow();
  });

  test("tombstone appends '- <text>' to tombstones.md, creating it and preserving prior lines", () => {
    const dir = realDir();
    applyOps(dir, [{ op: "tombstone", text: "first fact removed" }]);
    applyOps(dir, [{ op: "tombstone", text: "second fact removed" }]);
    const tombstones = readFileSync(join(dir, "tombstones.md"), "utf8");
    expect(tombstones).toBe("- first fact removed\n- second fact removed\n");
  });

  test("atomicity: after applyOps, no *.tmp files remain in dir", () => {
    const dir = realDir();
    applyOps(dir, [
      { op: "write", file: "a.md", content: "alpha" },
      { op: "write", file: "b.md", content: "beta" },
      { op: "tombstone", text: "gone" },
      { op: "delete", file: "a.md" },
    ]);
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  test("creates dir if needed", () => {
    const dir = join(realDir(), "nested", "dream");
    expect(existsSync(dir)).toBe(false);
    applyOps(dir, [{ op: "write", file: "a.md", content: "alpha" }]);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("alpha");
  });
});
