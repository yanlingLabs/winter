// P8b Task 17 Step 0(a) — NORMA'S VOICE ON THE WINTER LEG, pinned byte-for-byte per mode against
// the engine's `assemble({...})` mapping. Until Step 4 this file ran a REAL `AgentEngine` turn over
// the fake provider and compared its recorded `instructions` (equality, not prefix — the engine ran
// with no ToolSearch config under `auto`, so `buildInstructionsFull` added nothing); the engine is
// retired now, so the expected side is the engine's `turn()` call to the assembler, argument by
// argument (`engineAssemble` below — the literal that `git show 4c8319ba:packages/core/src/agent/
// engine.ts` `turn()` passed), over the SAME `ContextAssembler`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_SYSTEM_PROMPT } from "../../src/agent/chat-prompt";
import { ContextAssembler } from "../../src/agent/context";
import { DISPATCH_SYSTEM_PROMPT } from "../../src/agent/dispatch-prompt";
import type { ResolvedStyle } from "../../src/agent/output-styles";
import { sessionTmpDir } from "../../src/agent/session-tmp";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { clientEffortEligible, isClientEffort } from "../../src/settings";
import { buildWinterOptions } from "../../src/runtime-sdk/mode-options";
import { winterSystemPromptFor } from "../../src/runtime-sdk/system-prompt";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";

function world(style?: ResolvedStyle) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-voice-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-voice-cwd-")));
  const trust = new TrustStore(join(home, "trust.json"));
  trust.trust(cwd);
  writeFileSync(join(cwd, "NORMA.md"), "PROJECT_RULE_SENTINEL");
  mkdirSync(join(home, "memory", "_assistant"), { recursive: true });
  writeFileSync(join(home, "memory", "_assistant", "MEMORY.md"), "- ASSISTANT_MEMORY_SENTINEL\n");
  const skills = new SkillStore({ normaHome: home, trust });
  const assembler = new ContextAssembler({
    normaHome: home, trust, skills,
    memory: { enabled: () => true, dirFor: () => join(home, "memory", "project"), assistantDir: () => join(home, "memory", "_assistant") },
    ...(style === undefined ? {} : { styleResolver: () => style }),
  });
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  return { home, cwd, assembler, store, hub };
}



/** engine.ts `turn()` (at 4c8319ba) → `this.cfg.assembler.assemble({...})`, verbatim in meaning. */
function engineAssemble(assembler: ContextAssembler, meta: { mode?: "code" | "dispatch" | "chat"; origin?: string; cwd?: string; effort?: string }, sessionId: string): string {
  const isDispatch = meta.mode === "dispatch";
  const isChat = meta.mode === "chat";
  const primary = meta.cwd;                                  // `primaryDir`: the cwd column, else dirs[0] (none here)
  const cwd = primary ?? sessionTmpDir(sessionId);
  const ultra = isClientEffort(meta.effort) && clientEffortEligible(meta.mode);   // `resolveSel(meta).ultra`
  const skillToolOffered = isDispatch ? false : isChat ? false : true;            // `registry.namesForMode(...).has("Skill")`: never for chat/dispatch
  return assembler.assemble({
    cwd,
    loadedSkills: [],
    basePromptOverride: isDispatch ? DISPATCH_SYSTEM_PROMPT : isChat ? CHAT_SYSTEM_PROMPT : undefined,
    memoryBucket: isDispatch || isChat ? "assistant" : "project",
    skipOutputStyle: meta.origin === "dispatch-child",
    ultraDelegation: ultra,
    skillToolOffered,
    outDir: undefined,
    workdirLess: primary === undefined,
    extraDirs: primary === undefined ? [] : [],
  });
}

/** The engine's composed instructions for a session shaped like `session`. */
function engineInstructions(w: ReturnType<typeof world>, session: { mode?: "code" | "dispatch" | "chat"; origin?: string; cwd?: string; effort?: string }): string {
  const sessionId = w.store.createSession("global", { approvalPolicy: "auto", ...session });
  return engineAssemble(w.assembler, session, sessionId);
}
describe("winterSystemPromptFor — the engine's composed instructions, per mode", () => {
  test("chat: Norma's chat persona + the _assistant bucket, byte-identical to the engine's turn", async () => {
    const w = world();
    // the Mac app creates chat sessions with cwd = the home directory; the persona reads no
    // project instructions, but the assembler's other sections still key off the cwd
    const engine = await engineInstructions(w, { mode: "chat", cwd: w.cwd });
    const ours = winterSystemPromptFor(w.assembler, { mode: "chat", primary: w.cwd, cwd: w.cwd });
    expect(engine).toContain("ASSISTANT_MEMORY_SENTINEL");
    expect(ours).toBe(engine);
    // and a chat session WITHOUT a cwd (a phone-created one after SP3.4 gets homedir; a harness one may not)
    const bare = await engineInstructions(w, { mode: "chat" });
    const sid = w.store.list().find((r) => r.cwd === undefined && r.mode === "chat")!.sessionId;
    expect(winterSystemPromptFor(w.assembler, { mode: "chat", primary: undefined, cwd: sessionTmpDir(sid) })).toBe(bare);
  });

  test("dispatch: the coordinator's own base + the _assistant bucket", async () => {
    const w = world();
    const engine = await engineInstructions(w, { mode: "dispatch", cwd: w.cwd });
    const ours = winterSystemPromptFor(w.assembler, { mode: "dispatch", primary: w.cwd, cwd: w.cwd });
    expect(ours).toBe(engine);
  });

  test("code with a cwd: the base prompt, the TRUSTED project NORMA.md, the project bucket", async () => {
    const w = world();
    const engine = await engineInstructions(w, { mode: "code", cwd: w.cwd });
    const ours = winterSystemPromptFor(w.assembler, { mode: "code", primary: w.cwd, cwd: w.cwd });
    expect(engine).toContain("PROJECT_RULE_SENTINEL");
    expect(ours).toBe(engine);
  });

  test("code, workdir-less: the session-tmp cwd and the workdir-less lines", async () => {
    const w = world();
    const sessionId = w.store.createSession("global", { approvalPolicy: "auto" });
    const engine = engineAssemble(w.assembler, {}, sessionId);
    const ours = winterSystemPromptFor(w.assembler, { mode: "code", primary: undefined, cwd: sessionTmpDir(sessionId) });
    expect(ours).toBe(engine);
  });

  test("a dispatch CHILD (origin dispatch-child, mode code) skips the output style; a plain code session gets it; chat/dispatch never do", async () => {
    const style: ResolvedStyle = { name: "pirate", description: "arr", body: "PIRATE_STYLE_BODY", keepCodingInstructions: false };
    const w = world(style);
    const code = await engineInstructions(w, { mode: "code", cwd: w.cwd });
    expect(code).toContain("PIRATE_STYLE_BODY");
    expect(winterSystemPromptFor(w.assembler, { mode: "code", primary: w.cwd, cwd: w.cwd })).toBe(code);
    const child = await engineInstructions(w, { mode: "code", cwd: w.cwd, origin: "dispatch-child" });
    expect(child).not.toContain("PIRATE_STYLE_BODY");
    expect(winterSystemPromptFor(w.assembler, { mode: "code", origin: "dispatch-child", primary: w.cwd, cwd: w.cwd })).toBe(child);
    const chat = await engineInstructions(w, { mode: "chat", cwd: w.cwd });
    expect(chat).not.toContain("PIRATE_STYLE_BODY");
    expect(winterSystemPromptFor(w.assembler, { mode: "chat", primary: w.cwd, cwd: w.cwd })).toBe(chat);
  });

  test("ultra effort on a code session adds the delegation paragraph on both sides; on chat it is inert", async () => {
    const w = world();
    const code = await engineInstructions(w, { mode: "code", cwd: w.cwd, effort: "ultra" });
    expect(winterSystemPromptFor(w.assembler, { mode: "code", primary: w.cwd, cwd: w.cwd, effort: "ultra" })).toBe(code);
    expect(code).not.toBe(winterSystemPromptFor(w.assembler, { mode: "code", primary: w.cwd, cwd: w.cwd }));
    const chat = await engineInstructions(w, { mode: "chat", cwd: w.cwd, effort: "ultra" });
    expect(winterSystemPromptFor(w.assembler, { mode: "chat", primary: w.cwd, cwd: w.cwd, effort: "ultra" })).toBe(chat);
  });

  test("output styles: UNSET is byte-identical (no resolver ≡ a resolver answering null), and Options.outputStyle stays unset", () => {
    const a = world();
    const b = world();
    const nullStyle = new ContextAssembler({
      normaHome: b.home, trust: new TrustStore(join(b.home, "trust.json")), skills: new SkillStore({ normaHome: b.home, trust: new TrustStore(join(b.home, "trust.json")) }),
      memory: { enabled: () => true, dirFor: () => join(b.home, "memory", "project"), assistantDir: () => join(b.home, "memory", "_assistant") },
      styleResolver: () => null,
    });
    for (const mode of ["chat", "dispatch", "code"] as const) {
      const x = winterSystemPromptFor(a.assembler, { mode, primary: a.cwd, cwd: a.cwd });
      const y = winterSystemPromptFor(nullStyle, { mode, primary: b.cwd, cwd: b.cwd });
      // the two worlds differ only in their paths; normalise them out
      const norm = (text: string, w: ReturnType<typeof world>) => text.split(w.home).join("<home>").split(w.cwd).join("<cwd>");
      expect(norm(y, b)).toBe(norm(x, a));
      const options = buildWinterOptions({
        mode, policy: mode === "chat" ? "chat" : "auto", sessionId: "00000000-0000-4000-8000-000000000001", home: a.home, cwd: a.cwd,
        credentials: { byProvider: {} }, spawn: { pathToClaudeCodeExecutable: "/x/winter" }, canUseTool: async () => ({ behavior: "deny", message: "no" }),
        abort: new AbortController(), systemPrompt: x,
      });
      expect(options.systemPrompt).toBe(x);
      expect(options.outputStyle).toBeUndefined();
    }
  });
});
