// P8b Task 16 — the two integration tripwires the caps and policy lanes could not run alone.
//
// (b) Task 9's `CAPABILITY_TOOL_MODES` (what `disallowedTools` is built from) and Task 7's
//     `NORMA_CAPABILITY_TOOLS` (what the servers actually serve, and P8b-37's structural filter)
//     landed in different lanes. A name in one and not the other is a `disallowedTools` entry that
//     denies nothing, or a tool served to a mode that never sees it — silently, in either direction.
// (n9) The projector opens a child thread with the spawning `tool_use.id`, and Task 13's registry
//     addresses the same child by `RegisterInput.threadId`. Nothing asserted the two agreed.
import { expect, test } from "bun:test";
import { CAPABILITY_TOOL_MODES } from "../../src/runtime-sdk/mode-options";
import { NORMA_CAPABILITY_TOOLS } from "../../src/capabilities";
import { BackgroundAgentRegistry } from "../../src/agent/bg-agent-registry";
import { createProjector } from "../../src/projector";
import { FakeCheckpoints } from "../projector/harness";

const MODES = ["code", "dispatch", "chat"] as const;

test("CAPABILITY_TOOL_MODES (policy) and NORMA_CAPABILITY_TOOLS (caps) name the SAME tools", () => {
  expect(Object.keys(CAPABILITY_TOOL_MODES).sort()).toEqual(Object.keys(NORMA_CAPABILITY_TOOLS).sort());
});

test("…and expose each to the SAME modes", () => {
  for (const name of Object.keys(NORMA_CAPABILITY_TOOLS)) {
    const policy: readonly string[] = CAPABILITY_TOOL_MODES[name]?.modes ?? [];
    const caps: readonly string[] = NORMA_CAPABILITY_TOOLS[name as keyof typeof NORMA_CAPABILITY_TOOLS].modes;
    for (const mode of MODES) {
      expect({ name, mode, policy: policy.includes(mode), caps: caps.includes(mode) })
        .toEqual({ name, mode, policy: caps.includes(mode), caps: caps.includes(mode) });
    }
  }
});

test("a child's threadId is the spawning tool_use.id on BOTH sides: the projector's thread_started and the registry's RegisterInput.threadId", () => {
  const projector = createProjector({
    sessionId: "s_p", mode: "code", generation: 1, nextSeq: (() => { let n = 0; return () => ++n; })(),
    checkpoint: new FakeCheckpoints(), now: () => new Date().toISOString(), log: {},
  });
  projector.beginTurn({ text: "spawn one" });
  const batch = projector.accept({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_spawn_01", name: "Agent", input: { prompt: "do it", description: "worker" } }] },
  } as never);
  const started = batch.persist.find((e) => e.type === "thread_started") as { threadId: string; type: string } | undefined;
  expect(started).toBeDefined();
  expect(started!.threadId).toBe("toolu_spawn_01");

  // Task 13's contract (`AgentRegistry`, which `PersistedWinterChild` implements): the child is
  // registered under the SAME id, so `steerChild`/`resumeChild` and the transcript agree.
  const registry = new BackgroundAgentRegistry();
  const res = registry.register({ agentId: "agent-1", sessionId: "s_p", threadId: started!.threadId, name: "worker", abort: new AbortController() });
  expect(res).toEqual({ ok: true });
  expect(registry.get("agent-1", "s_p")?.threadId).toBe("toolu_spawn_01");
});
