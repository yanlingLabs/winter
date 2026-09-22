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
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import { describeWithWinterBinary } from "../helpers/winter-binary";

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
      const q = query({
        prompt: queue,
        options: {
          pathToClaudeCodeExecutable: bin,
          model: "winter-test/reflect",
          cwd,
          settingSources: [],
          systemPrompt: "You are a measurement.",
          plugins: surface.plugins,
          skills: surface.skills,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, WINTER_HOME: home, WINTER_PROFILE: "test", WINTER_TEST_PROVIDER: "reflect" },
        },
      });
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
