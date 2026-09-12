import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMemoryDir, readMemoryDir, writeMemoryDir, deleteMemoryDir, auditTailMemDir, type MemDirAuditLine } from "../../src/agent/memory-file-ops";
import type { MemoryFact } from "../../src/agent/memory";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "winter-memfileops-"))); }

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return { name: "coffee-pref", description: "Likes oat milk lattes", type: "user", body: "Prefers oat milk.", ...overrides };
}

describe("memory-file-ops: listMemoryDir", () => {
  test("missing directory -> empty list, no throw", () => {
    const dir = join(realDir(), "does-not-exist");
    expect(listMemoryDir(dir)).toEqual([]);
  });

  test("lists valid facts, skips MEMORY.md and a non-.md .audit.jsonl", () => {
    const dir = realDir();
    writeFileSync(join(dir, "a.md"), "---\nname: a\ndescription: da\ntype: user\n---\nbody-a");
    writeFileSync(join(dir, "b.md"), "---\nname: b\ndescription: db\ntype: reference\n---\nbody-b");
    writeFileSync(join(dir, "MEMORY.md"), "# Memory index\n\n- [a](a.md) — da\n- [b](b.md) — db\n");
    writeFileSync(join(dir, ".audit.jsonl"), JSON.stringify({ ts: 1, op: "delete", name: "x" }) + "\n");
    const facts = listMemoryDir(dir).sort((x, y) => x.name.localeCompare(y.name));
    expect(facts).toEqual([
      { name: "a", description: "da", type: "user" },
      { name: "b", description: "db", type: "reference" },
    ]);
  });

  test("corrupt/invalid-name files are skipped, never thrown", () => {
    const dir = realDir();
    writeFileSync(join(dir, "corrupt.md"), "not frontmatter at all");
    writeFileSync(join(dir, "Not_A_Slug.md"), "---\nname: Not_A_Slug\ndescription: d\ntype: user\n---\nbody");
    expect(listMemoryDir(dir)).toEqual([]);
  });
});

describe("memory-file-ops: readMemoryDir", () => {
  test("reads a fact written by writeMemoryDir (round trip)", () => {
    const dir = realDir();
    writeMemoryDir(dir, fact());
    const res = readMemoryDir(dir, "coffee-pref");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(fact());
  });

  test("unknown name -> ok:false, kind:not_found", () => {
    const res = readMemoryDir(realDir(), "ghost");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("not_found");
  });

  test("invalid slug name -> ok:false, kind:invalid", () => {
    const res = readMemoryDir(realDir(), "Not A Slug");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("invalid");
  });
});

describe("memory-file-ops: writeMemoryDir", () => {
  test("write -> exact on-disk frontmatter shape (matches MemoryStore's own format)", () => {
    const dir = realDir();
    const res = writeMemoryDir(dir, fact());
    expect(res.ok).toBe(true);
    const raw = readFileSync(join(dir, "coffee-pref.md"), "utf8");
    expect(raw).toBe("---\nname: coffee-pref\ndescription: Likes oat milk lattes\ntype: user\n---\n\nPrefers oat milk.");
  });

  test("write creates/updates the MEMORY.md index line", () => {
    const dir = realDir();
    writeMemoryDir(dir, fact());
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(index).toContain("- [coffee-pref](coffee-pref.md) — Likes oat milk lattes");
  });

  test("overwriting the same name updates the file and index in place (no duplicate index line)", () => {
    const dir = realDir();
    writeMemoryDir(dir, fact());
    writeMemoryDir(dir, fact({ description: "Now likes almond milk" }));
    const index = readFileSync(join(dir, "MEMORY.md"), "utf8");
    const indexLines = index.split("\n").filter((l) => l.startsWith("- ["));
    expect(indexLines).toHaveLength(1);
    expect(index).toContain("Now likes almond milk");
  });

  test("reserved name 'memory' is rejected", () => {
    const res = writeMemoryDir(realDir(), fact({ name: "memory" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("reserved name");
  });

  test("whitespace-only description -> ok:false, fs untouched", () => {
    const dir = realDir();
    const res = writeMemoryDir(dir, fact({ description: "  " }));
    expect(res.ok).toBe(false);
    expect(existsSync(join(dir, "coffee-pref.md"))).toBe(false);
  });

  test("creates the directory on demand", () => {
    const dir = join(realDir(), "nested", "memory");
    expect(existsSync(dir)).toBe(false);
    const res = writeMemoryDir(dir, fact());
    expect(res.ok).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("memory-file-ops: deleteMemoryDir", () => {
  test("deletes the fact file and its MEMORY.md index line", () => {
    const dir = realDir();
    writeMemoryDir(dir, fact());
    const res = deleteMemoryDir(dir, "coffee-pref");
    expect(res.ok).toBe(true);
    expect(existsSync(join(dir, "coffee-pref.md"))).toBe(false);
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).not.toContain("coffee-pref");
  });

  test("unknown name -> ok:false, kind:not_found, nothing written", () => {
    const dir = realDir();
    const res = deleteMemoryDir(dir, "ghost");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("not_found");
    expect(existsSync(join(dir, ".audit.jsonl"))).toBe(false);
  });

  test("appends a minimal (ts/op/name) line to <dir>/.audit.jsonl", () => {
    const dir = realDir();
    writeMemoryDir(dir, fact());
    const res = deleteMemoryDir(dir, "coffee-pref", () => 1234567);
    expect(res.ok).toBe(true);
    const lines = readFileSync(join(dir, ".audit.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as MemDirAuditLine;
    expect(parsed).toEqual({ ts: 1234567, op: "delete", name: "coffee-pref" });
  });

  test("multiple deletes append multiple audit lines, oldest first", () => {
    const dir = realDir();
    writeMemoryDir(dir, fact({ name: "a" }));
    writeMemoryDir(dir, fact({ name: "b" }));
    deleteMemoryDir(dir, "a", () => 1);
    deleteMemoryDir(dir, "b", () => 2);
    const lines = readFileSync(join(dir, ".audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { ts: 1, op: "delete", name: "a" },
      { ts: 2, op: "delete", name: "b" },
    ]);
  });

  test("no audit line on a failed (not_found) delete", () => {
    const dir = realDir();
    mkdirSync(dir, { recursive: true });
    deleteMemoryDir(dir, "ghost");
    expect(existsSync(join(dir, ".audit.jsonl"))).toBe(false);
  });
});

// T3 (design doc follow-up / task-23): `auditTailMemDir` is the per-directory twin of
// `MemoryStore.auditTail` — same newest-LAST/limit contract (memory-store.test.ts's own
// "auditTail(limit)" test is mirrored here), used by ipc/server.ts's memory.audit handler once
// files-mode + a resolved directory (dirFor(cwd) or globalDir()) are in play.
describe("memory-file-ops: auditTailMemDir", () => {
  test("missing .audit.jsonl -> [], no throw", () => {
    const dir = join(realDir(), "does-not-exist");
    expect(auditTailMemDir(dir)).toEqual([]);
  });

  test("reads back lines written by deleteMemoryDir, newest LAST (file order), corrupt lines skipped", () => {
    const dir = realDir();
    writeMemoryDir(dir, fact({ name: "a" }));
    writeMemoryDir(dir, fact({ name: "b" }));
    deleteMemoryDir(dir, "a", () => 1000);
    deleteMemoryDir(dir, "b", () => 1001);

    // inject a corrupt line between the two valid ones
    const auditPath = join(dir, ".audit.jsonl");
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    writeFileSync(auditPath, [lines[0], "not json at all", lines[1]].join("\n") + "\n");

    const tail = auditTailMemDir(dir);
    expect(tail).toEqual([
      { ts: 1000, op: "delete", name: "a" },
      { ts: 1001, op: "delete", name: "b" },
    ]);
  });

  test("limit: 1 -> last 1 newest-last; 0 -> [] (slice(-0) trap); undefined -> all", () => {
    const dir = realDir();
    for (let i = 0; i < 5; i++) writeMemoryDir(dir, fact({ name: `f${i}` }));
    for (let i = 0; i < 5; i++) deleteMemoryDir(dir, `f${i}`, () => i);

    expect(auditTailMemDir(dir, 1)).toEqual([{ ts: 4, op: "delete", name: "f4" }]);
    expect(auditTailMemDir(dir, 0)).toEqual([]);
    expect(auditTailMemDir(dir, undefined)).toHaveLength(5);
    expect(auditTailMemDir(dir)).toHaveLength(5);
  });
});
