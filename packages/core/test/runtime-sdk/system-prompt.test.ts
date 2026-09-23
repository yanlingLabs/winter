// P8b Task 17 Step 0(a) — WINTER'S VOICE ON THE WINTER LEG, pinned byte-for-byte per mode against
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
import { chatSystemPrompt } from "../../src/agent/chat-prompt";
import { ContextAssembler } from "../../src/agent/context";
import { dispatchSystemPrompt } from "../../src/agent/dispatch-prompt";
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-voice-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-voice-cwd-")));
  const trust = new TrustStore(join(home, "trust.json"));
  trust.trust(cwd);
  writeFileSync(join(cwd, "WINTER.md"), "PROJECT_RULE_SENTINEL");
  mkdirSync(join(home, "memory", "_assistant"), { recursive: true });
  writeFileSync(join(home, "memory", "_assistant", "MEMORY.md"), "- ASSISTANT_MEMORY_SENTINEL\n");
  const skills = new SkillStore({ winterHome: home, trust });
  const assembler = new ContextAssembler({
    winterHome: home, trust, skills,
    memory: { enabled: () => true, dirFor: () => join(home, "memory", "project"), assistantDir: () => join(home, "memory", "_assistant") },
    ...(style === undefined ? {} : { styleResolver: () => style }),
  });
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  return { home, cwd, assembler, store, hub };
}



/** engine.ts `turn()` (at 4c8319ba) → `this.cfg.assembler.assemble({...})`, verbatim in meaning. */
function engineAssemble(assembler: ContextAssembler, meta: { mode?: "code" | "dispatch" | "chat"; origin?: string; cwd?: string; effort?: string; exaKeyPresent?: boolean }, sessionId: string): string {
  const isDispatch = meta.mode === "dispatch";
  const isChat = meta.mode === "chat";
  const primary = meta.cwd;                                  // `primaryDir`: the cwd column, else dirs[0] (none here)
  const cwd = primary ?? sessionTmpDir(sessionId);
  const ultra = isClientEffort(meta.effort) && clientEffortEligible(meta.mode);   // `resolveSel(meta).ultra`
  const skillToolOffered = isDispatch ? false : isChat ? false : true;            // `registry.namesForMode(...).has("Skill")`: never for chat/dispatch
  return assembler.assemble({
    cwd,
    loadedSkills: [],
    // 2026-09-18: both base prompts are BUILDERS now — chat's and dispatch's web paragraph names the
    // search tool the session actually has, which follows the Exa key. Absent reads as present.
    basePromptOverride: isDispatch ? dispatchSystemPrompt({ exaKeyPresent: meta.exaKeyPresent !== false })
      : isChat ? chatSystemPrompt({ exaKeyPresent: meta.exaKeyPresent !== false }) : undefined,
    memoryBucket: isDispatch || isChat ? "assistant" : "project",
    skipOutputStyle: meta.origin === "dispatch-child",
    ultraDelegation: ultra,
    skillToolOffered,
    // B1 (2026-09-22): the ONE deliberate departure from the retired engine's call. The engine ran its
    // own `Skill` tool over this same SkillStore, so listing the store here was listing what the model
    // could load. A runtime child loads only what its Options hand it and lists THAT itself (claude's
    // `skill_listing` attachment), so the daemon's copy would be a second listing — and, for every
    // tier the child cannot reach yet, a list of skills that answer "unknown skill".
    skillListing: false,
    outDir: undefined,
    workdirLess: primary === undefined,
    extraDirs: primary === undefined ? [] : [],
  });
}

/** The engine's composed instructions for a session shaped like `session`. */
function engineInstructions(w: ReturnType<typeof world>, session: { mode?: "code" | "dispatch" | "chat"; origin?: string; cwd?: string; effort?: string; exaKeyPresent?: boolean }): string {
  const sessionId = w.store.createSession("global", { approvalPolicy: "auto", ...session });
  return engineAssemble(w.assembler, session, sessionId);
}
describe("winterSystemPromptFor — the engine's composed instructions, per mode", () => {
  test("chat: Winter's chat persona + the _assistant bucket, byte-identical to the engine's turn", async () => {
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

  test("code with a cwd: the base prompt, the TRUSTED project WINTER.md, the project bucket", async () => {
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

  // B1 (2026-09-22): the dist session was told about skills in the SYSTEM PROMPT that its child could
  // not load ("unknown skill … Available: (none)"). The child lists what it CAN load as claude's
  // `skill_listing` attachment, so the daemon's own listing is gone from every mode — one listing.
  test("B1: no skill listing in any mode — the child's own `skill_listing` is the one the model sees", () => {
    const w = world();
    mkdirSync(join(w.home, "skills", "greet"), { recursive: true });
    writeFileSync(join(w.home, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: GREET_SKILL_SENTINEL\n---\nhi\n");
    mkdirSync(join(w.home, "plugins", "superpowers", "skills", "brainstorming"), { recursive: true });
    writeFileSync(join(w.home, "plugins", "superpowers", "skills", "brainstorming", "SKILL.md"), "---\nname: brainstorming\ndescription: PLUGIN_SKILL_SENTINEL\n---\nx\n");
    for (const mode of ["chat", "dispatch", "code"] as const) {
      const text = winterSystemPromptFor(w.assembler, { mode, primary: w.cwd, cwd: w.cwd });
      expect(text).not.toContain("### Skills");
      expect(text).not.toContain("GREET_SKILL_SENTINEL");
      expect(text).not.toContain("PLUGIN_SKILL_SENTINEL");
      expect(text).not.toContain("No skills are installed.");
      expect(text).not.toContain("## Available capabilities");
    }
    // The assembler itself still renders it for a caller that owns the Skill tool (byte-identical default).
    // WS-21 (L4 request 2): the legacy `<home>/plugins` tier is gone from the store, so only the user skill.
    expect(w.assembler.assemble({ cwd: w.cwd })).toContain("GREET_SKILL_SENTINEL");
    expect(w.assembler.assemble({ cwd: w.cwd })).not.toContain("PLUGIN_SKILL_SENTINEL");
  });

  test("output styles: UNSET is byte-identical (no resolver ≡ a resolver answering null), and Options.outputStyle stays unset", () => {
    const a = world();
    const b = world();
    const nullStyle = new ContextAssembler({
      winterHome: b.home, trust: new TrustStore(join(b.home, "trust.json")), skills: new SkillStore({ winterHome: b.home, trust: new TrustStore(join(b.home, "trust.json")) }),
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

// ------------------------------------------------------------------------------------------------
// 2026-09-18 (the web-tools ruling): the base prompts NAME the search tool the session HAS
// ------------------------------------------------------------------------------------------------

describe("chat/dispatch base prompts follow the Exa key", () => {
  // The property: whichever search tool `disallowedToolsFor` withheld must not be NAMED in the prompt.
  // A prompt that names a tool the session was not given is how a model ends up reporting a tool as
  // broken, or apologising for a failure that never happened, with nothing failing anywhere in tests.
  test("with a key: chat and dispatch are told about Search, never about WebSearch", () => {
    for (const text of [chatSystemPrompt({ exaKeyPresent: true }), dispatchSystemPrompt({ exaKeyPresent: true })]) {
      expect(text).toContain("Search");
      expect(text).not.toContain("WebSearch");
      expect(text).toContain("WebFetch"); // the page-reading half is there either way
    }
  });

  test("with NO key: they are told about WebSearch, and Search is only ever named as unavailable", () => {
    for (const text of [chatSystemPrompt({ exaKeyPresent: false }), dispatchSystemPrompt({ exaKeyPresent: false })]) {
      expect(text).toContain("WebSearch");
      expect(text).toContain("WebFetch");
      // `Search` appears only inside the sentence that says it is NOT available and how to turn it on —
      // never as an instruction to use it.
      expect(text).toContain("winter login --exa-key");
    }
  });

  test("ABSENT reads as PRESENT — the same convention every other Exa door keeps", () => {
    expect(chatSystemPrompt()).toBe(chatSystemPrompt({ exaKeyPresent: true }));
    expect(dispatchSystemPrompt()).toBe(dispatchSystemPrompt({ exaKeyPresent: true }));
  });

  test("neither prompt mentions a retired tool", () => {
    for (const build of [chatSystemPrompt, dispatchSystemPrompt]) {
      for (const key of [true, false]) {
        const text = build({ exaKeyPresent: key });
        for (const gone of ["ReadPage", "web_fetch", "web_search", "lineStart"]) expect(text).not.toContain(gone);
      }
    }
  });

  test("winterSystemPromptFor threads it through, and code mode is unaffected either way", () => {
    const w = world();
    const chatWith = winterSystemPromptFor(w.assembler, { mode: "chat", primary: w.cwd, cwd: w.cwd, exaKeyPresent: true });
    const chatWithout = winterSystemPromptFor(w.assembler, { mode: "chat", primary: w.cwd, cwd: w.cwd, exaKeyPresent: false });
    expect(chatWith).not.toBe(chatWithout);
    expect(chatWithout).toContain("WebSearch");
    expect(winterSystemPromptFor(w.assembler, { mode: "chat", primary: w.cwd, cwd: w.cwd })).toBe(chatWith);
    // Code mode has no base-prompt override at all, so the key changes nothing there.
    expect(winterSystemPromptFor(w.assembler, { mode: "code", primary: w.cwd, cwd: w.cwd, exaKeyPresent: false }))
      .toBe(winterSystemPromptFor(w.assembler, { mode: "code", primary: w.cwd, cwd: w.cwd, exaKeyPresent: true }));
  });
});
