// P8b Task 16 — the two integration tripwires the caps and policy lanes could not run alone.
//
// (b) Task 9's `CAPABILITY_TOOL_MODES` (what `disallowedTools` is built from) and Task 7's
//     `NORMA_CAPABILITY_TOOLS` (what the servers actually serve, and P8b-37's structural filter)
//     landed in different lanes. A name in one and not the other is a `disallowedTools` entry that
//     denies nothing, or a tool served to a mode that never sees it — silently, in either direction.
// (n9) The projector opens a child thread with the spawning `tool_use.id`, and Task 13's persisted
//     child record (`PersistedWinterChild.childId`, 8a's `runtime_children`) addresses the same
//     child. Nothing asserted the two agreed. (Task 17 Step 0(d): moved here from the deleted
//     `BackgroundAgentRegistry` adapter.)
import { expect, test } from "bun:test";
import { CAPABILITY_TOOL_MODES } from "../../src/runtime-sdk/mode-options";
import { NORMA_CAPABILITY_TOOLS } from "../../src/capabilities";
import { createProjector } from "../../src/projector";
import { openRuntimeStateDb, RuntimeChildren } from "../../src/runtime-state";
import { FakeCheckpoints } from "../projector/harness";
import { withTempHome } from "../runtime-state/support";

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

test("a child's threadId is the spawning tool_use.id on BOTH sides: the projector's thread_started and the persisted child's childId", async () => withTempHome((home) => {
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

  // Task 13's contract: the child is persisted under the SAME id (`childId` = the spawning
  // `tool_use.id`), so `steerChild`/`resumeChild`, recovery and the transcript agree.
  const rs = openRuntimeStateDb(home);
  try {
    const children = new RuntimeChildren(rs);
    children.upsert({
      parentWinterSessionId: "s_p", childId: started!.threadId, agentType: "worker", providerId: "unstated", modelRef: "unstated",
      providerCatalogVersion: "unstated", providerAdapterVersion: "unstated", status: "running",
      transcriptRef: `subagents/${started!.threadId}/transcript.jsonl`, startedAt: new Date().toISOString(), generation: 1,
    });
    expect(children.get("s_p", "toolu_spawn_01")?.childId).toBe("toolu_spawn_01");
    expect(children.locate("toolu_spawn_01")).toEqual([{ parent: "s_p", childId: "toolu_spawn_01" }]);
  } finally { rs.close(); }
}));
