import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../src/agent/tools/registry";
import {
  FUNCTIONS_EXEC_TOOL,
  FUNCTIONS_WAIT_TOOL,
  functionsExecArgs,
  registerFunctionsExecTools,
} from "../../../src/agent/tools/functions-exec";
import { registerToolSearchTool } from "../../../src/agent/tools/toolsearch";

describe("functions.exec tool registration", () => {
  test("is a deferred code-only catalog entry when Seatbelt support is present", () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerFunctionsExecTools(registry, true);

    expect(registry.specs(undefined, { builtinDeferral: true, mode: "code" }).map((spec) => spec.name)).toEqual(["ToolSearch"]);
    expect(registry.specFor(FUNCTIONS_EXEC_TOOL, undefined, "code")?.name).toBe(FUNCTIONS_EXEC_TOOL);
    expect(registry.specFor(FUNCTIONS_WAIT_TOOL, undefined, "code")?.name).toBe(FUNCTIONS_WAIT_TOOL);
    expect(registry.namesForMode("dispatch", { builtinDeferral: true })).toEqual(new Set());
    expect(registry.namesForMode("chat", { builtinDeferral: true })).toEqual(new Set());
  });

  test("does not advertise unsupported worker execution", () => {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    registerFunctionsExecTools(registry, false);
    expect(registry.specFor(FUNCTIONS_EXEC_TOOL, undefined, "code")).toBeUndefined();
    expect(registry.specFor(FUNCTIONS_WAIT_TOOL, undefined, "code")).toBeUndefined();
  });

  test("accepts a meaningful bounded source budget for raw patch calls", () => {
    expect(functionsExecArgs.safeParse({ source: "x".repeat(2_048) }).success).toBe(true);
    expect(functionsExecArgs.safeParse({ source: "x".repeat(8_193) }).success).toBe(false);
  });
});
