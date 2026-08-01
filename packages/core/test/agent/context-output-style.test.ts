import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_PROMPT, ContextAssembler, ULTRA_DELEGATION_INSTRUCTION } from "../../src/agent/context";
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

// ================================================================================================
// provider-correctness T5 — the `ultra` tier's base-slot injection.
//
// A tier is the only kind of effort that changes the PROMPT, so it needs a slot of its own: it is
// ADDITIVE (it never replaces the base or an output style — both are still fully in effect) and it
// sits in the base region, ahead of the date/instructions/memory sections, because it is a posture
// statement about how to work rather than context about what to work on.
// ================================================================================================
describe("assemble() ultra-delegation injection (provider-correctness T5)", () => {
  test("RED anchor: nothing in the shipped BASE_PROMPT says anything about delegation posture", () => {
    // The premise of this whole feature. `BASE_PROMPT` tells the model how to ASK (the ask_user
    // clause); it says nothing about when to hand work to child agents, and the only guidance that
    // exists anywhere is the `spawn_agent` tool DESCRIPTION, which explains HOW to spawn, never how
    // eagerly. If this ever fails, a standing posture has landed in the base prompt and the tier's
    // "revoke the ask-first habit" line needs re-reading against it, not deleting.
    for (const word of ["delegate", "delegation", "in parallel", "child agent", "subagent"]) {
      expect(BASE_PROMPT.toLowerCase()).not.toContain(word);
    }
  });

  test("ultraDelegation:true → the posture is appended AFTER the base, BEFORE the date line", () => {
    const out = assembler().assemble({ cwd: null, ultraDelegation: true });
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain(ULTRA_DELEGATION_INSTRUCTION);
    expect(out.indexOf(ULTRA_DELEGATION_INSTRUCTION)).toBeGreaterThan(out.indexOf(BASE));
    expect(out.indexOf(ULTRA_DELEGATION_INSTRUCTION)).toBeLessThan(out.indexOf("Today's date"));
  });

  test("absent / false → BYTE-IDENTICAL to before this input existed", () => {
    const a = assembler().assemble({ cwd: null });
    const b = assembler().assemble({ cwd: null, ultraDelegation: false });
    expect(b).toBe(a);
    expect(a).not.toContain(ULTRA_DELEGATION_INSTRUCTION);
  });

  test("it is ADDITIVE to an output style, never a replacement for it (both land, style first)", () => {
    const style: ResolvedStyle = { name: "proactive", description: "", body: "OVERLAY_X", keepCodingInstructions: true };
    const out = assembler(() => style).assemble({ cwd: null, ultraDelegation: true });
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain("OVERLAY_X");
    expect(out.indexOf("OVERLAY_X")).toBeLessThan(out.indexOf(ULTRA_DELEGATION_INSTRUCTION));
    expect(out.indexOf(ULTRA_DELEGATION_INSTRUCTION)).toBeLessThan(out.indexOf("Today's date"));
  });

  test("...including a style that REPLACES the base — the posture survives the replacement", () => {
    // `keepCodingInstructions:false` swaps the whole base out. A user running a custom persona at
    // ultra still asked for ultra; the tier is orthogonal to which persona is speaking.
    const style: ResolvedStyle = { name: "mine", description: "", body: "WHOLE_PERSONA", keepCodingInstructions: false };
    const out = assembler(() => style).assemble({ cwd: null, ultraDelegation: true });
    expect(out.startsWith("WHOLE_PERSONA")).toBe(true);
    expect(out).toContain(ULTRA_DELEGATION_INSTRUCTION);
  });

  test("the posture REVOKES an ask-first habit and licenses parallel work, without re-teaching the tool", () => {
    // Content pins, not prose review: the two things the instruction must actually do (T5 brief),
    // plus the one thing it must NOT do — duplicate the `spawn_agent` description's capability text,
    // which is where the mechanics already live (and which is per-session-toolset dependent).
    const text = ULTRA_DELEGATION_INSTRUCTION.toLowerCase();
    expect(text).toContain("ultra");
    expect(text).toMatch(/do not ask|don't ask|without asking/);   // revokes the ask-first posture
    expect(text).toMatch(/parallel|at the same time|concurrently/); // licenses parallel work
    expect(text).not.toContain("spawn_agent");                      // posture, not capability text
    expect(text).not.toContain("run_in_background");
  });
});
