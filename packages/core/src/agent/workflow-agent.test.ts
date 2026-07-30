import { expect, spyOn, test } from "bun:test";
// Harness: build an AgentEngine with a FakeProvider whose child turn emits one assistant_message,
// wired with SubagentManager + AgentStore (mirror the setup in agent/spawn.test.ts / engine tests).
import { makeWorkflowAgentHarness } from "./workflow-agent.testkit"; // small local testkit (see step 3)

test("runWorkflowAgent reaches the real spawn machinery and returns the child's final report", async () => {
  const { engine, sessionId } = await makeWorkflowAgentHarness({ childReply: "child says hi" });
  const out = await engine.runWorkflowAgent(sessionId, "do a thing", undefined, new AbortController().signal);
  expect(out).toEqual({ ok: true, result: "child says hi" });
});

test("the spawned agent runs at accept-edits and does NOT have the Workflow tool", async () => {
  const { engine, sessionId, toolsSeenByChild } = await makeWorkflowAgentHarness({ childReply: "ok", recordChildTools: true });
  await engine.runWorkflowAgent(sessionId, "edit a file", undefined, new AbortController().signal);
  expect(toolsSeenByChild()).not.toContain("Workflow");
  // policy assertion: the harness's FakeProvider records meta.approvalPolicy handed to the child turn
  expect(toolsSeenByChild.policy?.()).toBe("accept-edits");
});

// M3 (review fix): a workflow-spawned agent must not itself be able to call spawn_agent — nesting a
// grandchild subtree would count against the global SubagentManager pool but escape the run's OWN
// semaphore + totalCap, since only the workflow's direct agent() fan-out is counted there. Unlike
// the "Workflow" tool check above, this can't ride toolsSeenByChild()/specs(): the testkit's stub
// registry never registers anything named "spawn_agent" (only "Workflow" is stubbed — see the
// testkit's own doc comment), so a specs()-filter assertion would pass vacuously whether or not
// runWorkflowAgent excludes it. Instead, spy on runThread directly (same TS-private-is-a-plain-
// method-at-runtime trick the testkit uses) and read the real `excludeTools` Set it was built with
// — the exact mechanism the engine's own specs() filter reads (`.filter((s) =>
// !excludeTools?.has(s.name))`), so this genuinely fails if "spawn_agent" is ever dropped from it.
test("the spawned agent's tool set excludes spawn_agent (nested fan-out must not escape the run's caps)", async () => {
  const { engine, sessionId } = await makeWorkflowAgentHarness({ childReply: "ok" });
  const runThreadSpy = spyOn(engine as unknown as { runThread: (...args: unknown[]) => unknown }, "runThread");
  await engine.runWorkflowAgent(sessionId, "do a thing", undefined, new AbortController().signal);
  const call = runThreadSpy.mock.calls[0] as [{ excludeTools?: Set<string> }];
  expect(call[0].excludeTools?.has("spawn_agent")).toBe(true);
});

// B1-T3 fix round 2, Minor 2: a workflow-spawned agent only ever exists inside a CODE session
// (Workflow is never offered to chat/dispatch), so it must never carry a chat-only tool either —
// the same reasoning `runWorkflowAgent`'s own `childExcludeTools` literal already applies to
// `ask_user` (excluded unconditionally). Pins `registry.namesNotForMode("code")`'s presence in
// that literal (engine.ts, `runWorkflowAgent`) the same way the test above pins `spawn_agent` —
// nothing previously caught a future edit silently dropping that spread from this specific Set.
//
// R-T2 fix-round-1: the testkit NOW registers AskQuestion/Search (matching the real daemon), so
// `registry.namesNotForMode("code")` here is a REAL derived value — {AskQuestion, Search} — not
// read off the old CHAT_ONLY_TOOLS constant (now deleted). Reading it off the SAME registry
// instance the child bridge itself consulted is a stronger check than the old hardcoded import.
test("the spawned agent's tool set excludes every chat-only tool name too (chat-only tools never reach a workflow-spawned child)", async () => {
  const { engine, sessionId, registry } = await makeWorkflowAgentHarness({ childReply: "ok" });
  const runThreadSpy = spyOn(engine as unknown as { runThread: (...args: unknown[]) => unknown }, "runThread");
  await engine.runWorkflowAgent(sessionId, "do a thing", undefined, new AbortController().signal);
  const call = runThreadSpy.mock.calls[0] as [{ excludeTools?: Set<string> }];
  for (const name of registry.namesNotForMode("code")) {
    expect(call[0].excludeTools?.has(name)).toBe(true);
  }
});

// I3 review fix (Chat Slice D task 1): runWorkflowAgent used to resolve its child's model off the
// raw BOOT snapshot (`this.cfg.provider.model`), a THIRD model-resolution path bypassing both
// `live()` and a per-session override — unlike turn()/sendToAgent(), which both route through
// AgentEngine's resolveSel(). Now it does too, so a workflow-spawned agent honors the same
// per-session override the rest of the feature promises.
test("runWorkflowAgent routes model resolution through resolveSel — honors a per-session override (I3 review fix)", async () => {
  const { engine, sessionId, store, provider } = await makeWorkflowAgentHarness({ childReply: "ok" });
  store.setModel(sessionId, "session-override-model");
  await engine.runWorkflowAgent(sessionId, "do a thing", undefined, new AbortController().signal);
  expect(provider.requests[0]!.model).toBe("session-override-model");
});

// Control: an explicit `opts.model` (the workflow script's OWN model arg) still wins over a
// per-session override — resolveSel is only consulted as the FALLBACK, exactly mirroring how
// turn()'s own explicit tool-arg overrides (spawn_agent's modelOverride) already take precedence
// over the inherited session default.
test("runWorkflowAgent's own explicit opts.model still wins over a per-session override", async () => {
  const { engine, sessionId, store, provider } = await makeWorkflowAgentHarness({ childReply: "ok" });
  store.setModel(sessionId, "session-override-model");
  await engine.runWorkflowAgent(sessionId, "do a thing", { model: "explicit-workflow-model" }, new AbortController().signal);
  expect(provider.requests[0]!.model).toBe("explicit-workflow-model");
});

// Control: no per-session override at all → falls back to the live/boot default exactly as
// before this fix (byte-identical behavior for the untouched case).
test("runWorkflowAgent falls back to the live/boot default when there is no per-session override (control, unchanged)", async () => {
  const { engine, sessionId, provider } = await makeWorkflowAgentHarness({ childReply: "ok" });
  await engine.runWorkflowAgent(sessionId, "do a thing", undefined, new AbortController().signal);
  expect(provider.requests[0]!.model).toBe("fake-1"); // this harness's boot model (workflow-agent.testkit.ts)
});
