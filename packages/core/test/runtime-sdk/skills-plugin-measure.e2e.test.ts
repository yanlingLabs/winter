// B1 MEASUREMENT (2026-09-22) — does a REAL, spawned `winter` child (the pinned 0.0.17 binary) index
// and list exactly the skills `SkillStore.childSkillSurface` hands it, and nothing else?
//
// The unit tests pin what the daemon PUTS in `Options`; only the binary can say what the runtime DOES
// with it. Three facts, each one a way the fix could be wrong without any daemon test noticing:
//   1. `settingSources: []` + a skills-only local-plugin view ⇒ the child's index holds
//      `<directory>:<skill>` — the DIRECTORY name, even though the plugin's own manifest calls itself
//      something else (the name the daemon's `Skill(<name>)` deny rules and `skills.list` use);
//   2. `Options.skills` hides a denied skill from `system/init.skills` AND from the model-facing
//      `skill_listing` (read back through the scripted `winter-test/reflect` double, which answers
//      with the exact messages its provider was called with);
//   3. nothing but skills crosses: the real plugin's manifest hook and its `agents/*.md` do not.
//
// HERMETIC like every sibling measurement: `env` REPLACES the child's environment, the home is a fresh
// mkdtemp, the model is a scripted double — nothing reaches the network, `~/.winter` or a Keychain.
// SKIPS without a binary (`describeWithWinterBinary`); `WINTER_RUNTIME_REQUIRE_BINARY=1` makes that a failure.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { buildWinterOptions } from "../../src/runtime-sdk/mode-options";
import type { ModelTag } from "../../src/runtime-sdk/model-tag";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { query as claudeQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { anthropicFake, startFake } from "@yanlinglabs/winter-provider-conformance";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID } from "../helpers/claude-runtime";

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBODY OF ${name}\n`);
}

describeWithWinterBinary("B1 measurement — the daemon's plugin skills inside a real winter child", (bin) => {
  test("the child indexes and lists exactly the handed-over skills, under the daemon's names, and nothing else", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-b1-measure-home-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-b1-measure-cwd-")));
    const marker = join(home, "HOOK_RAN");
    try {
      const plugin = join(home, "plugins", "superpowers");
      writeSkill(join(plugin, "skills", "using-superpowers"), "using-superpowers", "USING_SENTINEL");
      writeSkill(join(plugin, "skills", "brainstorming"), "brainstorming", "BRAINSTORM_SENTINEL");
      // What must NOT cross: a manifest that renames the plugin and declares a command hook, and an agent.
      mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
      writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "renamed-by-manifest",
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] },
      }));
      mkdirSync(join(plugin, "agents"), { recursive: true });
      writeFileSync(join(plugin, "agents", "plugin-agent.md"), "---\nname: plugin-agent\ndescription: PLUGIN_AGENT_SENTINEL\n---\nbody\n");

      const store = new SkillStore({ winterHome: home, trust: new TrustStore(join(home, "trust.json")) });
      const surface = store.childSkillSurface({ cwd, deny: ["Skill(superpowers:brainstorming)"] });
      expect(surface.skills).toEqual(["superpowers:using-superpowers"]);

      const queue = createHostPromptQueue();
      const messages: Array<Record<string, unknown>> = [];
      // THE DAEMON'S OWN OPTIONS, not a hand-built subset: `buildWinterOptions` is what production
      // spawns with, so the measurement runs under the same `settingSources: []`, the same Bash sandbox
      // and the same deny rules — including the WRITE fence on the views' own subtree
      // (`<home>/cache/skill-plugins`), which the child's own plugin loading must not trip.
      const options = buildWinterOptions({
        mode: "code", policy: "auto", sessionId: "00000000-0000-4000-8000-0000000000b1", home, cwd,
        model: "winter-test/reflect" as ModelTag, credentials: { byProvider: {} } as unknown as CredentialPresence,
        systemPrompt: "You are a measurement.", exaKeyPresent: false,
        spawn: { pathToClaudeCodeExecutable: bin },
        canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
        abort: new AbortController(),
        baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home },
        plugins: surface.plugins, skills: surface.skills,
      });
      expect(options.settingSources).toEqual([]);
      expect(surface.plugins[0]!.path.startsWith(join(home, "cache", "skill-plugins") + "/")).toBe(true);
      expect(options.sandbox?.filesystem?.denyWrite).toContain(join(home, "cache", "skill-plugins"));
      expect(options.permissions?.deny?.some((r) => r.startsWith("Write(") && r.includes(join(home, "cache", "skill-plugins")))).toBe(true);
      const q = query({ prompt: queue, options });
      queue.push("list your skills");
      try {
        for await (const m of q) {
          messages.push(m as Record<string, unknown>);
          if ((m as { type?: string }).type === "result") break;
        }
      } finally {
        if (!queue.closed) queue.close();
      }

      const init = messages.find((m) => m.type === "system" && m.subtype === "init") as { skills?: string[]; plugins?: Array<{ name: string }>; agents?: string[] } | undefined;
      expect(init).toBeDefined();
      // (1) + (2): the index, by the daemon's names, minus the denied skill.
      expect(init!.skills).toEqual(["superpowers:using-superpowers"]);
      expect((init!.plugins ?? []).map((p) => p.name)).toEqual(["superpowers"]);
      // (3): no plugin agent, and the manifest's hook never ran.
      expect(JSON.stringify(init!.agents ?? [])).not.toContain("plugin-agent");

      // (2), model-facing: what the provider was called with — the reflect double's own answer.
      const reply = messages.filter((m) => m.type === "assistant")
        .flatMap((m) => ((m as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content ?? []))
        .filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      expect(reply).toContain("The following skills are available for use with the Skill tool:");
      expect(reply).toContain("superpowers:using-superpowers");
      expect(reply).toContain("USING_SENTINEL");
      expect(reply).not.toContain("superpowers:brainstorming");
      expect(reply).not.toContain("BRAINSTORM_SENTINEL");
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const dir of [home, cwd]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }, 60_000);
});

// Router 0.0.11 (lane B, 2026-09-23): the SAME skills-only view, handed to the REAL pinned `claude`
// (0.3.250) exactly as the router's `plugins` policy forwards it — `{local, <abs view>,
// skipMcpDiscovery: true}`, `settingSources: []`. claude names a manifest-less plugin by its directory
// and its skills `<plugin>:<skill dir>`, which is the daemon's own spelling for these fixtures.
describeWithClaudeRuntime("official leg: the skills-only view inside a real claude child", () => {
  test("claude indexes the view's skills under the daemon's names, and nothing of the plugin besides", async () => {
    const bed = claudeRuntimeForTests()!;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-b1-claude-")));
    const home = join(root, "home"), cfg = join(root, "cfg"), cwd = join(root, "cwd"), winterHome = join(root, "winter");
    for (const d of [home, cfg, cwd, join(home, "tmp"), winterHome]) mkdirSync(d, { recursive: true });
    const marker = join(root, "HOOK_RAN");
    const plugin = join(winterHome, "plugins", "superpowers");
    writeSkill(join(plugin, "skills", "brainstorming"), "brainstorming", "BRAINSTORM_SENTINEL");
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] } }));
    const store = new SkillStore({ winterHome, trust: new TrustStore(join(winterHome, "trust.json")), plugins: { sessionEligible: () => new Set(["superpowers"]) } });
    const surface = store.childSkillSurface({ cwd });
    const fake = await startFake({ routes: [{ path: "*", handler: async (_req, recorded) => {
      if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
    } }] });
    try {
      const q = claudeQuery({
        prompt: "hi",
        options: {
          pathToClaudeCodeExecutable: bed.executable, model: LOOPBACK_MODEL_ID, cwd, settingSources: [], maxTurns: 1,
          plugins: surface.plugins.map((p) => ({ type: "local" as const, path: p.path, skipMcpDiscovery: true })),
          env: {
            HOME: home, USER: "m", LOGNAME: "m", SHELL: "/bin/zsh", LANG: "en_US.UTF-8", TMPDIR: `${join(home, "tmp")}/`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "sk-ant-fake-b1-measure-0000",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_MAX_RETRIES: "0",
          },
        },
      });
      let init: { skills?: string[]; plugins?: Array<{ name: string }> } | undefined;
      for await (const m of q as AsyncIterable<SDKMessage>) {
        const t = m as { type: string; subtype?: string };
        if (t.type === "system" && t.subtype === "init") init = m as never;
        if (t.type === "result") break;
      }
      expect(init?.skills).toContain("superpowers:brainstorming");
      expect((init?.plugins ?? []).map((p) => p.name)).toEqual(["superpowers"]);
      // The real plugin's hooks.json is NOT in the view, so it never runs.
      expect(existsSync(marker)).toBe(false);
    } finally {
      await fake.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
