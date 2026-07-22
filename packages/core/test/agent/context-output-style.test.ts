import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import type { ResolvedStyle } from "../../src/agent/output-styles";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "ctx-os-")));
const trustStub = { isTrusted: (_d: string) => true } as any;
const skillsStub = { list: () => [], loadBody: () => null } as any; // ContextAssembler only calls skills for capabilities; a no-op stub is enough
const BASE = "BASE_PROMPT_MARKER";

function assembler(styleResolver?: (cwd: string | null) => ResolvedStyle | null) {
  return new ContextAssembler({ normaHome: tmp(), trust: trustStub, skills: skillsStub, basePrompt: BASE, styleResolver });
}

describe("assemble() output-style injection", () => {
  test("no styleResolver → sections[0] is the base prompt (byte-identical anchor)", () => {
    const out = assembler().assemble({ cwd: null });
    expect(out.startsWith(BASE)).toBe(true);
  });
  test("resolver returns null → base prompt unchanged", () => {
    const out = assembler(() => null).assemble({ cwd: null });
    expect(out.startsWith(BASE)).toBe(true);
  });
  test("keepCodingInstructions:true → base kept AND overlay appended right after it", () => {
    const style: ResolvedStyle = { name: "proactive", description: "", body: "OVERLAY_X", keepCodingInstructions: true };
    const out = assembler(() => style).assemble({ cwd: null });
    expect(out.startsWith(BASE)).toBe(true);
    expect(out.indexOf("OVERLAY_X")).toBeGreaterThan(out.indexOf(BASE));
    expect(out.indexOf("OVERLAY_X")).toBeLessThan(out.indexOf("Today's date")); // before the date line
  });
  test("keepCodingInstructions:false → base REPLACED by the body", () => {
    const style: ResolvedStyle = { name: "mine", description: "", body: "WHOLE_PERSONA", keepCodingInstructions: false };
    const out = assembler(() => style).assemble({ cwd: null });
    expect(out.startsWith("WHOLE_PERSONA")).toBe(true);
    expect(out.includes(BASE)).toBe(false);
  });
  test("empty-body style → treated as no-op (base unchanged)", () => {
    const style: ResolvedStyle = { name: "default", description: "", body: "", keepCodingInstructions: true };
    expect(assembler(() => style).assemble({ cwd: null }).startsWith(BASE)).toBe(true);
  });
  test("basePromptOverride (dispatch) wins — style resolver is NOT consulted", () => {
    let called = false;
    const out = assembler(() => { called = true; return { name: "x", description: "", body: "OVERLAY", keepCodingInstructions: false }; })
      .assemble({ cwd: null, basePromptOverride: "DISPATCH_BASE" });
    expect(out.startsWith("DISPATCH_BASE")).toBe(true);
    expect(called).toBe(false);
  });
  test("skipOutputStyle (dispatch child) → base prompt, resolver NOT consulted", () => {
    let called = false;
    const out = assembler(() => { called = true; return { name: "x", description: "", body: "OVERLAY", keepCodingInstructions: true }; })
      .assemble({ cwd: null, skipOutputStyle: true });
    expect(out.startsWith(BASE)).toBe(true);      // normal base kept (NOT a dispatch override)
    expect(out.includes("OVERLAY")).toBe(false);  // no style applied
    expect(called).toBe(false);                   // resolver never called
  });
});
