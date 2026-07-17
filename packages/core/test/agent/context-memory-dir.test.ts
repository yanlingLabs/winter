import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";

// T1 (file-based memory / MEMDIR): ContextAssembler's NEW injection path, exercised via a
// `memory` dep — the legacy phase-5b path (unconditional when `memory` is omitted) is covered,
// UNCHANGED, by context.test.ts. This file only exercises the branch introduced by T1.

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-ctx-mem-"))); }

function setup() {
  const home = realDir();
  mkdirSync(join(home, "memory"), { recursive: true });
  const trust = new TrustStore(join(home, "trust.json"));
  const skills = new SkillStore({ normaHome: home, trust });
  return { home, trust, skills };
}

describe("ContextAssembler + MEMDIR (T1)", () => {
  test("enabled + absent MEMORY.md: protocol block present (with the absolute path), no index section", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const memDir = join(home, "projects", "some-key", "memory"); // never created
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => memDir, assistantDir: () => join(home, "projects", "_assistant", "memory") },
    });
    const out = a.assemble({ cwd });
    expect(out).toContain("## Memory");
    expect(out).toContain(memDir); // absolute path disclosed
    expect(out).toContain("NO dedicated memory tools"); // sanity: protocol mentions no dedicated tools
    expect(out).not.toContain("Project memory index");
    expect(out).not.toContain("<system-reminder>");
  });

  test("enabled + present MEMORY.md: index injected, wrapped in <system-reminder>", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const memDir = join(home, "projects", "proj", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "MEMORY.md"), "- [coffee-pref](coffee-pref.md) — Likes oat milk lattes\n");
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => memDir, assistantDir: () => join(home, "projects", "_assistant", "memory") },
    });
    const out = a.assemble({ cwd });
    expect(out).toContain("<system-reminder>");
    expect(out).toContain("</system-reminder>");
    expect(out).toContain("coffee-pref");
    expect(out).toContain("Likes oat milk lattes");
  });

  test("index cap: a 201-line MEMORY.md truncates to 200 lines", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const memDir = join(home, "projects", "proj", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "MEMORY.md"), Array.from({ length: 201 }, (_, i) => `line${i}`).join("\n"));
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => memDir, assistantDir: () => join(home, "projects", "_assistant", "memory") },
    });
    const out = a.assemble({ cwd });
    expect(out).toContain("line0");
    expect(out).toContain("line199");
    expect(out).not.toContain("line200"); // 201st line (0-indexed 200) is beyond the 200-line cap
    expect(out).toContain("[…truncated]");
  });

  test("index cap: a 26KB MEMORY.md truncates to 25KB", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const memDir = join(home, "projects", "proj", "memory");
    mkdirSync(memDir, { recursive: true });
    // 30 lines of ~900 bytes each (< 200 lines, > 25KB) so the BYTE cap fires, not the line cap.
    writeFileSync(join(memDir, "MEMORY.md"), Array.from({ length: 30 }, () => "y".repeat(900)).join("\n"));
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => memDir, assistantDir: () => join(home, "projects", "_assistant", "memory") },
    });
    const out = a.assemble({ cwd });
    expect(out).toContain("[…truncated]");
    // Isolate just the MEMORY.md content itself — strip the reminder wrapper's own descriptive
    // preamble line (e.g. "Project memory index (auto-loaded from ...):\n"), which would otherwise
    // inflate the measured byte count well past the cap on its own.
    const wrapped = (out.split("<system-reminder>")[1] ?? "").split("</system-reminder>")[0] ?? "";
    const content = wrapped.split("):\n").slice(1).join("):\n").replace(/\n$/, ""); // trailing "\n" is the wrapper template's own formatting, not file content
    expect(Buffer.byteLength(content.replace("\n[…truncated]", ""), "utf8")).toBeLessThanOrEqual(25 * 1024);
  });

  test("disabled (memory.enabled() false): falls back to the legacy phase-5b path, no protocol block", () => {
    const { home, trust, skills } = setup();
    writeFileSync(join(home, "memory", "MEMORY.md"), "LEGACY_USER_MEMORY_FACT");
    const cwd = realDir();
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => false, dirFor: () => join(home, "projects", "x", "memory"), assistantDir: () => join(home, "projects", "_assistant", "memory") },
    });
    const out = a.assemble({ cwd });
    expect(out).toContain("LEGACY_USER_MEMORY_FACT"); // legacy path ran
    expect(out).not.toContain("NO dedicated memory tools");
  });

  test("no cwd: memory config present but nothing to key a project dir off — no MEMDIR section injected", () => {
    const { home, trust, skills } = setup();
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => join(home, "projects", "x", "memory"), assistantDir: () => join(home, "projects", "_assistant", "memory") },
    });
    const out = a.assemble({ cwd: null });
    expect(out).not.toContain("NO dedicated memory tools");
  });

  test("hot toggle: the SAME assembler instance reflects a live enabled() flip on its NEXT call, no reconstruction", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const memDir = join(home, "projects", "proj", "memory");
    let enabled = true;
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => enabled, dirFor: () => memDir, assistantDir: () => join(home, "projects", "_assistant", "memory") },
    });
    expect(a.assemble({ cwd })).toContain("NO dedicated memory tools");
    enabled = false;
    expect(a.assemble({ cwd })).not.toContain("NO dedicated memory tools");
    enabled = true;
    expect(a.assemble({ cwd })).toContain("NO dedicated memory tools");
  });
});
