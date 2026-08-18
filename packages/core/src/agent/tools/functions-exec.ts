import { z } from "zod";
import { MAX_CELL_ID_CHARS, MAX_FUNCTIONS_EXEC_SOURCE_CHARS } from "../../functions-exec/protocol";
import { functionsExecSandboxAvailable } from "../../functions-exec/sandbox";
import type { ToolRegistry } from "./registry";

export const FUNCTIONS_EXEC_TOOL = "functions.exec";
export const FUNCTIONS_WAIT_TOOL = "functions.wait";

export const functionsExecArgs = z.object({
  source: z.string().min(1).max(MAX_FUNCTIONS_EXEC_SOURCE_CHARS),
  timeoutMs: z.number().int().min(1).max(60_000).optional(),
}).strict();

export const functionsWaitArgs = z.object({
  cellId: z.string().min(1).max(MAX_CELL_ID_CHARS),
}).strict();

/**
 * Registers only the model-facing handles. AgentEngine owns cell state and runs both through its
 * normal dispatch path; the worker itself never gains a direct filesystem or network capability.
 */
export function registerFunctionsExecTools(registry: ToolRegistry, supported = functionsExecSandboxAvailable()): void {
  if (!supported) return;
  registry.register({
    name: FUNCTIONS_EXEC_TOOL,
    description: "Run bounded JavaScript in an isolated worker. Load this deferred tool with ToolSearch first. JavaScript has no direct filesystem, process, or network access; use tools.bash, tools.edit, tools.read, tools.web_fetch, or tools.web_search, which each use Norma's normal permission path. Use tools.text(), tools.image(), tools.audio(), tools.notify(), and await tools.yield().",
    args: functionsExecArgs,
    modes: ["code"],
    deferred: true,
    run() { throw new Error("functions.exec requires the AgentEngine runtime bridge"); },
  });
  registry.register({
    name: FUNCTIONS_WAIT_TOOL,
    description: "Wait for the next checkpoint from a yielded functions.exec cell. This deferred tool is available only while a cell has yielded or has a pending terminal result.",
    args: functionsWaitArgs,
    modes: ["code"],
    deferred: true,
    run() { throw new Error("functions.wait requires the AgentEngine runtime bridge"); },
  });
}
