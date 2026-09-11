// P8b Task 17 Step 0(a) — NORMA'S VOICE ON THE WINTER LEG, pinned byte-for-byte per mode against the
// ENGINE'S OWN composed instructions (a real `AgentEngine` turn over the fake provider, which records
// the `instructions` it was handed). The two sides share the one `ContextAssembler`; what is under
// test is `winterSystemPromptFor`'s argument mapping (engine.ts `turn()`'s `assemble({...})` call).
//
// The engine here runs with no ToolSearch config and under `auto`, so `buildInstructionsFull` adds
// nothing (no deferred index, no plan paragraph, no /ultracode reminder) and the comparison is
// EQUALITY, not prefix — see system-prompt.ts's header for why those three appendices are not
// ported.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "../../src/agent/approvals";
import { Compactor } from "../../src/agent/compactor";
import { ContextAssembler } from "../../src/agent/context";
import { SessionDirectories } from "../../src/agent/dirs";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { PermissionGate } from "../../src/agent/gate";
import type { ResolvedStyle } from "../../src/agent/output-styles";
import { SkillStore } from "../../src/agent/skills";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { TrustStore } from "../../src/agent/trust";
import type { ProviderEvent } from "../../src/providers/types";
import { buildWinterOptions } from "../../src/runtime-sdk/mode-options";
import { winterSystemPromptFor } from "../../src/runtime-sdk/system-prompt";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";

const reply: ProviderEvent[] = [{ type: "text_delta", delta: "ok" }, { type: "usage", inputTokens: 1, outputTokens: 1 }, { type: "done", stopReason: "end_turn" }];

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

/** One real engine turn; returns the instructions the provider was handed. */
async function engineInstructions(w: ReturnType<typeof world>, session: { mode?: "code" | "dispatch" | "chat"; origin?: string; cwd?: string; effort?: string }): Promise<string> {
  const provider = new FakeProvider([reply]);
  const engine = new AgentEngine({
    store: w.store, hub: w.hub, registry: new ToolRegistry(), broker: new ApprovalBroker(), gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs: new SessionDirectories(() => (session.cwd === undefined ? [] : [session.cwd])),
    assembler: w.assembler,
    compactor: new Compactor({ provider: { provider, model: "fake-1" }, store: w.store, hub: w.hub }),
  });
  const sessionId = w.store.createSession("global", { approvalPolicy: "auto", ...session });
  w.hub.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hello", clientName: "test" });
  await engine.runTurn(sessionId);
  return provider.requests[0]!.instructions ?? "";
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
    const { sessionTmpDir } = await import("../../src/agent/session-tmp");
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
    const store = w.store;
    const provider = new FakeProvider([reply]);
    const engine = new AgentEngine({
      store, hub: w.hub, registry: new ToolRegistry(), broker: new ApprovalBroker(), gate: new PermissionGate(),
      provider: { provider, model: "fake-1" }, dirs: new SessionDirectories(() => []), assembler: w.assembler,
      compactor: new Compactor({ provider: { provider, model: "fake-1" }, store, hub: w.hub }),
    });
    const sessionId = store.createSession("global", { approvalPolicy: "auto" });
    w.hub.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hello", clientName: "test" });
    await engine.runTurn(sessionId);
    const { sessionTmpDir } = await import("../../src/agent/session-tmp");
    const ours = winterSystemPromptFor(w.assembler, { mode: "code", primary: undefined, cwd: sessionTmpDir(sessionId) });
    expect(ours).toBe(provider.requests[0]!.instructions ?? "");
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
