import { expect, test } from "bun:test";
import { makeGatingHarness } from "./workflow-gating.testkit"; // builds engines for code/dispatch-child sessions with configurable workflowsEnabled

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
