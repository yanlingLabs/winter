// WS-21 L3.4 (spec §6.1; F10, F22): once the router APPLIES a run home, the daemon stops building what the
// run folder carries — agents, plugins, skills, configured MCP servers, the SAVED allow rules, the home
// variable, the empty setting sources, the instructions, the output style and a code session's memory
// text. It keeps its floor: Winter's fixed allow rules, every deny rule, the sandbox, the capability
// servers, the hooks, the base prompt, the workspace block, the date, and chat's/dispatch's `_assistant`
// memory injection. With the router not applying one (0.0.11), every input is built exactly as before.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import { RUN_HOME_DECIDED_OPTIONS } from "../../src/runtime-sdk/mode-options";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { storeHomeFor } from "../../src/agent/paths";
import { SkillStore } from "../../src/agent/skills";
import { OutputStyleStore } from "../../src/agent/output-styles";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { assistantMemoryDirFor, memoryDirFor, _clearRepoRootCacheForTests } from "../../src/agent/memory-dir";
import { buildWinterOptions, controlPlaneDenyRules, GLOBAL_READ_ALLOW_RULES, type WinterOptionsInput } from "../../src/runtime-sdk/mode-options";
import { officialInputFor, type OfficialInputDeps, type OfficialSessionInput } from "../../src/runtime-sdk/official-options";
import { winterSystemPromptFor } from "../../src/runtime-sdk/system-prompt";

const real = (p: string): string => realpathSync(p);
const tmp = (prefix: string): string => real(mkdtempSync(join(tmpdir(), prefix)));

// ── the planted world: every input a run folder carries, once ─────────────────────────────────────
const MARK = {
  userInstr: "USER-INSTRUCTIONS-MARK",
  projInstr: "PROJECT-INSTRUCTIONS-MARK",
  rule: "PROJECT-RULE-MARK",
  style: "OUTPUT-STYLE-MARK",
  projMemory: "PROJECT-MEMORY-MARK",
  assistantMemory: "ASSISTANT-MEMORY-MARK",
};

function world() {
  const home = tmp("winter-nohome-h-");
  const cwd = tmp("winter-nohome-cwd-");
  writeFileSync(join(home, "WINTER.md"), MARK.userInstr);
  writeFileSync(join(cwd, "WINTER.md"), MARK.projInstr);
  mkdirSync(join(cwd, ".winter", "rules"), { recursive: true });
  writeFileSync(join(cwd, ".winter", "rules", "r.md"), MARK.rule);
  // the user tier of output styles is read from the store home (`storeHomeFor`: `sdk/` on a run-home build)
  mkdirSync(join(storeHomeFor(home), "output-styles"), { recursive: true });
  writeFileSync(join(storeHomeFor(home), "output-styles", "mine.md"), `---\nname: mine\ndescription: d\nkeep-coding-instructions: true\n---\n${MARK.style}`);
  const trust = new TrustStore(join(home, "trust.json"));
  trust.trust(cwd);
  const projMem = memoryDirFor(cwd, { winterHome: home });
  mkdirSync(projMem, { recursive: true });
  writeFileSync(join(projMem, "MEMORY.md"), `- ${MARK.projMemory}`);
  const asstMem = assistantMemoryDirFor({ winterHome: home });
  mkdirSync(asstMem, { recursive: true });
  writeFileSync(join(asstMem, "MEMORY.md"), `- ${MARK.assistantMemory}`);
  const skills = new SkillStore({ winterHome: home, trust });
  const styles = new OutputStyleStore({ winterHome: home, trust });
  const assembler = new ContextAssembler({
    winterHome: home, trust, skills,
    memory: { enabled: () => true, dirFor: (c) => memoryDirFor(c, { winterHome: home }), assistantDir: () => asstMem },
    styleResolver: (c) => styles.resolve("mine", c),
  });
  return { home, cwd, assembler };
}

beforeEach(() => _clearRepoRootCacheForTests());

const promptFor = (w: ReturnType<typeof world>, mode: "code" | "chat" | "dispatch", runHomeApplied: boolean, primary: string | undefined = w.cwd): string =>
  winterSystemPromptFor(w.assembler, { mode, primary, cwd: primary ?? w.cwd, outDir: join(w.home, "outputs", "s"), ...(runHomeApplied ? { runHomeApplied: true } : {}) });

describe("the system prompt (context.ts / system-prompt.ts)", () => {
  test("flag OFF: every planted input is composed, as today", () => {
    const w = world();
    const code = promptFor(w, "code", false);
    for (const m of [MARK.userInstr, MARK.projInstr, MARK.rule, MARK.style, MARK.projMemory]) expect(code).toContain(m);
    expect(promptFor(w, "chat", false)).toContain(MARK.assistantMemory);
  });

  test("flag ON, code: no instructions, rules, output style or project memory text — base, workspace and date kept", () => {
    const w = world();
    const code = promptFor(w, "code", true);
    for (const m of Object.values(MARK)) expect(code).not.toContain(m);
    expect(code).toContain("Today's date is");
    expect(code).toContain(join(w.home, "outputs", "s")); // the workspace block ($OUTDIR)
    expect(code).not.toContain("NO dedicated memory tools"); // no memory protocol block either
  });

  test("flag ON, a workdir-less code session: its memory is the runtime's too (no _assistant text)", () => {
    const w = world();
    expect(promptFor(w, "code", true, undefined)).not.toContain(MARK.assistantMemory);
  });

  test("flag ON, chat and dispatch: the _assistant memory injection stays exactly as today (r3)", () => {
    const w = world();
    for (const mode of ["chat", "dispatch"] as const) {
      const on = promptFor(w, mode, true);
      expect(on).toContain(MARK.assistantMemory);
      expect(on).not.toContain(MARK.userInstr);
      expect(on).not.toContain(MARK.projInstr);
      expect(on).toBe(promptFor(w, mode, false).replace(/\n\n## User instructions[^]*?(?=\n\n)/, "").replace(/\n\n## Project instructions[^]*?(?=\n\n)/, "").replace(/\n\n## Project rules[^]*?(?=\n\n<system-reminder>)/, ""));
    }
  });
});

// ── the Winter leg's Options ─────────────────────────────────────────────────────────────────────
function winterInput(over: Partial<WinterOptionsInput> = {}): WinterOptionsInput {
  return {
    mode: "code", policy: "ask", sessionId: "11111111-2222-3333-4444-555555555555", home: "/tmp/winter-home", cwd: "/repo",
    credentials: { byProvider: {} } as never,
    spawn: { pathToClaudeCodeExecutable: "/opt/winter" },
    canUseTool: (async () => ({ behavior: "allow" as const })) as CanUseTool,
    abort: new AbortController(),
    baseEnv: { PATH: "/usr/bin", HOME: "/Users/x" },
    env: { WINTER_HOME: "/caller/supplied" },
    agents: { reviewer: { description: "d", prompt: "p" } },
    plugins: [{ type: "local", path: "/h/cache/skill-plugins/sp" }],
    skills: ["sp:one"],
    userAllow: ["Edit", "mcp__srv__tool"],
    persistedAllow: ["Bash(git status)"],
    userDeny: ["Skill(denied)"],
    capabilities: { winter__computer: { type: "sdk", name: "winter__computer", instance: {} } } as never,
    ...over,
  };
}

describe("buildWinterOptions", () => {
  test("flag OFF: today's Options — agents, plugins, skills, saved allow rules, WINTER_HOME, settingSources []", () => {
    const o = buildWinterOptions(winterInput());
    expect(o.agents).toBeDefined();
    expect(o.plugins).toHaveLength(1);
    expect(o.skills).toEqual(["sp:one"]);
    expect(o.permissions!.allow).toEqual(expect.arrayContaining(["Edit", "mcp__srv__tool", "Bash(git status)"]));
    expect(o.env!.WINTER_HOME).toBe("/tmp/winter-home");
    expect(o.settingSources).toEqual([]);
  });

  test("flag ON: none of the run folder's inputs; Winter's fixed allow rules, every deny rule and the capability servers stay", () => {
    const off = buildWinterOptions(winterInput());
    const on = buildWinterOptions(winterInput({ runHomeApplied: true }));
    expect("agents" in on).toBe(false);
    expect("plugins" in on).toBe(false);
    expect("skills" in on).toBe(false);
    expect(on.permissions!.allow).toEqual(expect.arrayContaining([...GLOBAL_READ_ALLOW_RULES]));
    for (const saved of ["Edit", "mcp__srv__tool", "Bash(git status)"]) expect(on.permissions!.allow).not.toContain(saved);
    expect(on.permissions!.deny).toEqual(off.permissions!.deny); // the floor is never thinned
    expect(on.permissions!.deny).toContain("Skill(denied)");
    expect(on.sandbox).toEqual(off.sandbox);
    expect(on.mcpServers).toEqual(off.mcpServers);
    expect("WINTER_HOME" in on.env!).toBe(false); // the router pins it — a caller's value never survives
    expect(on.settingSources).toEqual(["user"]);  // stated, never absent (absent = every tier)
  });

  // L2's contract: beside a run home the router REFUSES (`router_owned_variable`) — never overwrites —
  // any of its five variables in `Options.env`, so none may survive from anywhere.
  // L2 fix round 1 (M1): beside a run home the router refuses (`run_home_option_refused`) a caller's
  // `plugins`, `skills`, `agents`, `outputStyle` or `brand` — none may reach the Options, whatever the input.
  test("flag ON: none of the options a run home decides are stated, even when the input carries them", () => {
    const on = buildWinterOptions(winterInput({
      runHomeApplied: true, outputStyle: "terse",
      agents: { reviewer: { description: "d", prompt: "p" } } as never,
      plugins: [{ type: "local", path: "/h/cache/skill-plugins/p" }] as never, skills: ["p:a"] as never,
    })) as Record<string, unknown>;
    for (const key of RUN_HOME_DECIDED_OPTIONS) expect(key in on).toBe(false);
    const off = buildWinterOptions(winterInput({ outputStyle: "terse" })) as Record<string, unknown>;
    expect(off.outputStyle).toBe("terse"); // today's behaviour without a run home
  });

  test("flag ON: none of the five router-owned variables survive, even from a caller's env", () => {
    const owned = { WINTER_HOME: "/x", WINTER_STORE_HOME: "/x", WINTER_PLUGIN_CACHE_DIR: "/x", WINTER_PROVIDER_MANAGED_BY_HOST: "1", WINTER_DISABLE_CRON: "1" };
    const on = buildWinterOptions(winterInput({ runHomeApplied: true, env: owned }));
    for (const key of Object.keys(owned)) expect(key in on.env!).toBe(false);
    expect(on.env!.WINTER_PROFILE).toBeDefined(); // the daemon's own pins stay
  });
});

// ── the official leg's input ─────────────────────────────────────────────────────────────────────
function officialDeps(assembler: OfficialInputDeps["assembler"], over: Partial<OfficialInputDeps> = {}): OfficialInputDeps {
  const selection: RuntimeSelection = {
    runtimeKind: "claude-agent", providerId: "test", modelRef: "claude-test/echo", family: "claude",
    authFamily: "custom", sdkVersion: "0.0.3", reason: "unit test", decidedAt: new Date(0).toISOString(),
  };
  return {
    home: "/Users/x/.winter-test-home", selection, explicitCredentials: [], explicitConnectionEnv: {},
    officialPeer: undefined, claudeExecutableFor: () => ({ path: "/usr/bin/true" }),
    assembler, capabilities: {},
    canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy: "auto", emit: () => {} },
    policy: "auto", consoleProfileExists: () => true,
    configuredMcpServers: { user_srv: { type: "stdio", command: "node" } } as never,
    agents: { reviewer: { description: "d", prompt: "p" } },
    persistedAllow: ["Bash(git status)"],
    userAllow: ["Edit"],
    userDeny: ["Skill(denied)"],
    skillPlugins: [{ type: "local", path: "/h/cache/skill-plugins/sp" }],
    ...over,
  };
}

describe("officialInputFor", () => {
  const optionsOf = (r: ReturnType<typeof officialInputFor>) => {
    if (!("input" in r)) throw new Error("officialInputFor refused");
    return r.input.options as { agents?: unknown; plugins?: unknown; systemPrompt?: unknown; appendSystemPrompt?: string; settings?: { permissions?: { allow?: string[]; deny?: string[] } } } & Record<string, unknown>;
  };
  const inputOf = (r: ReturnType<typeof officialInputFor>) => { if (!("input" in r)) throw new Error("refused"); return r.input; };

  test("flag ON: no agents, no plugins, no configured MCP server, no saved allow rule, no instructions — deny unchanged", () => {
    const w = world();
    const input: OfficialSessionInput = { sessionId: "s_1", mode: "code", cwd: w.cwd, primary: w.cwd, spendEffort: undefined };
    const off = officialInputFor(input, officialDeps(w.assembler));
    const on = officialInputFor(input, officialDeps(w.assembler, { runHomeApplied: true }));
    expect(optionsOf(off).agents).toBeDefined();
    expect(optionsOf(off).plugins).toBeDefined();
    expect("agents" in optionsOf(on)).toBe(false);
    expect("plugins" in optionsOf(on)).toBe(false);
    for (const key of RUN_HOME_DECIDED_OPTIONS) expect(key in optionsOf(on)).toBe(false); // L2 fix round 1, M1
    expect(Object.keys(inputOf(on).mcpServers ?? {})).not.toContain("user_srv");
    const allowOn = optionsOf(on).settings!.permissions!.allow!;
    expect(allowOn).toEqual(expect.arrayContaining([...GLOBAL_READ_ALLOW_RULES]));
    expect(allowOn).not.toContain("Edit");
    expect(allowOn).not.toContain("Bash(git status)");
    expect(optionsOf(on).settings!.permissions!.deny).toEqual(optionsOf(off).settings!.permissions!.deny);
    expect(optionsOf(on).settings!.permissions!.deny).toEqual(expect.arrayContaining([...controlPlaneDenyRules("/Users/x/.winter-test-home"), "Skill(denied)"]));
    // L2's contract: beside a run home `spool`/`stagingRoot` are refused and the memory dir is the router's.
    expect(inputOf(off).spool).toBeDefined();
    expect(inputOf(off).autoMemoryDirectory).toBeDefined();
    expect("spool" in inputOf(on)).toBe(false);
    expect("stagingRoot" in inputOf(on)).toBe(false);
    expect("autoMemoryDirectory" in inputOf(on)).toBe(false);
    const promptOn = JSON.stringify(optionsOf(on));
    for (const m of [MARK.userInstr, MARK.projInstr, MARK.rule, MARK.style, MARK.projMemory]) expect(promptOn).not.toContain(m);
    const promptOff = JSON.stringify(optionsOf(off));
    expect(promptOff).toContain(MARK.projInstr);
  });
});
