import { expect, test } from "bun:test";
import { makeGatingHarness, makeSpawnGatingHarness } from "./workflow-gating.testkit"; // builds engines for code/dispatch-child sessions with configurable workflowsEnabled

test("Workflow is offered (deferred index) in a top-level code session when enabled", async () => {
  const { deferredIndexFor } = await makeGatingHarness({ workflowsEnabled: true });
  expect(await deferredIndexFor({ origin: undefined, mode: "code" })).toContain("Workflow");
});

test("Workflow is NOT offered when workflows.enabled is false", async () => {
  const { deferredIndexFor } = await makeGatingHarness({ workflowsEnabled: false });
  expect(await deferredIndexFor({ origin: undefined, mode: "code" })).not.toContain("Workflow");
});

test("Workflow is NOT offered to a dispatch-child session", async () => {
  const { deferredIndexFor } = await makeGatingHarness({ workflowsEnabled: true });
  expect(await deferredIndexFor({ origin: "dispatch-child", mode: "code" })).not.toContain("Workflow");
});

// CM-T2b: chat's own base prompt tells the model "you have no access to this machine" (chat-prompt.ts's
// CHAT_SYSTEM_PROMPT) — the "# Deferred tools" text must not contradict that by listing Workflow.
// isChatOrCowork(meta) is the ONE predicate excludeWorkflow depends on for this; a chat session must
// exclude it from the deferred index the same way a dispatch-child session already does, above.
test("Workflow is NOT offered (deferred index) in a chat session, even when workflows.enabled", async () => {
  const { deferredIndexFor } = await makeGatingHarness({ workflowsEnabled: true });
  expect(await deferredIndexFor({ origin: undefined, mode: "chat" })).not.toContain("Workflow");
});

// Task B-gatefix Part 3 (from B3's own report, "concern" #1): `workflowToolAllowed` is a
// SESSION-level predicate (keyed on `meta`), which a plain `spawn_agent` CHILD THREAD shares
// byte-for-byte with its parent — so even inside a top-level, workflows-enabled CODE session (where
// the MAIN thread genuinely gets Workflow, asserted below as a sanity contrast), a spawned child
// must NOT see the tool in its own specs()/tools list. `deferred:false` (mirrors
// workflow-bridge.testkit.ts) is deliberate: it puts Workflow in specs() unconditionally unless
// excludeTools-excluded, so this test genuinely exercises childExcludeTools — a deferred:true tool
// no thread has "loaded" yet would ALSO be absent from specs() for an unrelated reason (nothing
// loaded it), which would pass even without this task's fix and prove nothing.
test("a spawn_agent child thread does NOT have Workflow in its tool set, even in a workflows-enabled top-level session", async () => {
  const { mainRequest, childRequest } = await makeSpawnGatingHarness({ workflowsEnabled: true, deferred: false });
  expect((mainRequest.tools ?? []).map((t) => t.name)).toContain("Workflow"); // sanity: the MAIN thread genuinely gets it
  expect((childRequest.tools ?? []).map((t) => t.name)).not.toContain("Workflow"); // the CHILD thread must not
});

// Companion, using the REAL B2 registration shape (deferred:true + ToolSearch on) to prove the
// OTHER half of the Part 3 fix: the child isn't even told the tool EXISTS via the "# Deferred
// tools" text (buildInstructionsFull's `excludeDeferred`), not just excluded from specs().
test("a spawn_agent child thread's instructions do NOT advertise Workflow via the deferred-tools index either", async () => {
  const { mainRequest, childRequest } = await makeSpawnGatingHarness({ workflowsEnabled: true, deferred: true, toolSearchEnabled: true });
  expect(mainRequest.instructions ?? "").toContain("Workflow"); // sanity: the MAIN thread's own index still advertises it
  expect(childRequest.instructions ?? "").not.toContain("Workflow");
});
