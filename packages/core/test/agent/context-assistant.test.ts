import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { assistantMemoryDirFor } from "../../src/agent/memory-dir";

// Dreaming (Phase 7b, Task 1): ContextAssembler's `memoryBucket: "assistant"` branch — the
// _assistant bucket is loaded INSTEAD of the cwd-resolved project MEMDIR, with NO memory-protocol
// block (assistant-mode sessions have no write tools; see context.ts's branch comment). Mirrors
// context-memory-dir.test.ts's setup pattern (the T1 MEMDIR suite) for the "project" bucket.

// Stable, distinctive substring from memoryProtocol()'s actual text (context.ts) — proves the
// protocol block is/isn't present without depending on its full wording.
const PROTOCOL_MARKER = "NO dedicated memory tools";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-ctx-asst-"))); }

function setup() {
  const home = realDir();
  mkdirSync(join(home, "memory"), { recursive: true });
  const trust = new TrustStore(join(home, "trust.json"));
  const skills = new SkillStore({ normaHome: home, trust });
  return { home, trust, skills };
}

describe("ContextAssembler + _assistant bucket (Dreaming Task 1)", () => {
  test('memoryBucket: "assistant" — loads the _assistant index, no protocol block, no project MEMORY.md leakage', () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const assistantDir = assistantMemoryDirFor({ normaHome: home });
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(join(assistantDir, "MEMORY.md"), "- [Alex](alex.md) — builds Norma\n");

    const projectDir = join(home, "projects", "some-project-key", "memory");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "MEMORY.md"), "PROJECT_ONLY_LINE_MUST_NOT_LEAK\n");

    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => projectDir, assistantDir: () => assistantDir },
    });
    const out = a.assemble({ cwd, memoryBucket: "assistant" });

    expect(out).toContain("Assistant memory index");
    expect(out).toContain("Alex");
    expect(out).toContain("builds Norma");
    expect(out).not.toContain(PROTOCOL_MARKER);
    expect(out).not.toContain("PROJECT_ONLY_LINE_MUST_NOT_LEAK");
  });

  test('memoryBucket omitted ("project"): today\'s behavior unchanged — project index + protocol block, _assistant absent', () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const assistantDir = assistantMemoryDirFor({ normaHome: home });
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(join(assistantDir, "MEMORY.md"), "- [Alex](alex.md) — builds Norma\n");

    const projectDir = join(home, "projects", "some-project-key", "memory");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "MEMORY.md"), "- [coffee-pref](coffee-pref.md) — Likes oat milk lattes\n");

    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => projectDir, assistantDir: () => assistantDir },
    });
    const out = a.assemble({ cwd });

    expect(out).toContain(PROTOCOL_MARKER);
    expect(out).toContain("Project memory index");
    expect(out).toContain("coffee-pref");
    expect(out).not.toContain("Assistant memory index");
    expect(out).not.toContain("builds Norma");
  });

  test("memory disabled: assistant branch loads nothing — no index, no protocol", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const assistantDir = assistantMemoryDirFor({ normaHome: home });
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(join(assistantDir, "MEMORY.md"), "- [Alex](alex.md) — builds Norma\n");

    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => false, dirFor: () => join(home, "projects", "x", "memory"), assistantDir: () => assistantDir },
    });
    const out = a.assemble({ cwd, memoryBucket: "assistant" });

    expect(out).not.toContain("Assistant memory index");
    expect(out).not.toContain(PROTOCOL_MARKER);
    expect(out).not.toContain("builds Norma");
  });

  test("caps: assistant index respects the same MEMDIR_INDEX_MAX_LINES/BYTES caps as the project bucket", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const assistantDir = assistantMemoryDirFor({ normaHome: home });
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(join(assistantDir, "MEMORY.md"), Array.from({ length: 300 }, (_, i) => `line${i}`).join("\n"));

    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => join(home, "projects", "x", "memory"), assistantDir: () => assistantDir },
    });
    const out = a.assemble({ cwd, memoryBucket: "assistant" });

    expect(out).toContain("line0");
    expect(out).toContain("line199");
    expect(out).not.toContain("line200"); // 300 lines, capped at the first 200 (0-indexed 0..199)
    expect(out).toContain("[…truncated]");
  });
});
