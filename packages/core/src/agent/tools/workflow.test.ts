import { expect, test } from "bun:test";
import { ToolRegistry } from "./registry";
import { registerWorkflowTool } from "./workflow";

test("Workflow registers deferred and its description carries the authoring guide", () => {
  const r = new ToolRegistry();
  registerWorkflowTool(r, { deferred: true });
  expect(r.has("Workflow")).toBe(true);
  // deferred: hidden from a builtin-deferral specs() unless loaded
  const visible = r.specs("/x", { builtinDeferral: true, loaded: new Set() }).map((s) => s.name);
  expect(visible).not.toContain("Workflow");
  const spec = r.specFor("Workflow", "/x")!;
  expect(spec.description).toMatch(/agent\(/);
  expect(spec.description).toMatch(/parallel\(/);
  expect(spec.description).toMatch(/return/);
});
