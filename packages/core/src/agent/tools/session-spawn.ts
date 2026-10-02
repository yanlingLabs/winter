import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolRegistry } from "./registry";

/** What a `session_spawn` call is handed: the parsed arguments and the caller's context
 *  (`ctx.sessionId` is the dispatch session that called it). Resolves to the result text; a throw is
 *  the tool's error result (the registry turns it into `isError`). */
export type SessionSpawner = (
  args: { dir: string; prompt: string; model?: string; type?: "code" | "cowork"; title?: string },
  ctx: ToolContext,
) => Promise<string>;

/** Dispatch (Phase 7) Task 4: session_spawn — the coordinator's delegation tool.
 *
 *  `run()` calls the daemon's spawner (`agent/dispatch-children.ts`'s `DispatchChildren.spawn`,
 *  wired through the `sessions` capability server, `capabilities/sessions.ts`) when one is given.
 *  The engine-era bridge that intercepted the call before the registry ran went with the engine; on
 *  the Winter leg the capability server's `callTool` IS the door. Without a spawner (a door nobody
 *  wired, a test) the call answers the fixed "only available in the dispatch session" line — a
 *  plain-string return, which `registry.ts`'s `execute()` wraps as `{output, isError:false}`.
 *
 *  The schema enum on `model` is steering only (defense-in-depth): it is a boot snapshot of the
 *  picker list, and the spawner's own LIVE picker check is the authoritative gate. WS-20: the enum is
 *  the picker's own tag list (`pickerModels()`, ipc/picker-models.ts) — a provider-qualified tag like
 *  `codex-oauth/gpt-5.6-terra`, never a bare id or a short alias. */
export function registerSessionSpawnTool(r: ToolRegistry, opts: { models?: string[]; spawn?: SessionSpawner } = {}): void {
  for (const def of sessionSpawnToolDefs(opts)) r.register(def);
}

/** P8b Task 6 — THE definitions, extracted verbatim from `registerSessionSpawnTool`'s body so the
 *  daemon's shared `ToolRegistry` and the `sessions` capability server (`capabilities/sessions.ts`)
 *  drive the SAME `ToolDefinition` object rather than two copies of one. */
export function sessionSpawnToolDefs(opts: { models?: string[]; spawn?: SessionSpawner } = {}): ToolDefinition[] {
  const hasModels = !!opts.models && opts.models.length > 0;
  const modelField = hasModels ? z.enum(opts.models as [string, ...string[]]).optional() : z.string().optional();
  const modelClause = hasModels
    ? `model: optional override, a provider-qualified model tag, e.g. codex-oauth/gpt-5.6-terra — one of: ${opts.models!.join(", ")} (omit to inherit the default model)`
    : "model: optional override, a provider-qualified model tag, e.g. codex-oauth/gpt-5.6-terra";
  return [{
    name: "session_spawn",
    // R-T2: dispatch's own orchestration verb — the single declaration site of its eligibility.
    // Dispatch-only: `capabilityServer` filters the defs by the session's mode (P8b-37), so a code or
    // chat session's `sessions` server never advertises or serves it.
    modes: ["dispatch"],
    description: [
      "Spawn a full, first-class work session in a directory. The child is an ordinary code session:",
      "own transcript, visible in the session list, full tools. It runs asynchronously — this returns at once,",
      "and you are woken with a <child_update> when it finishes. Write the prompt self-contained: the child cannot see this conversation.",
      `dir: absolute directory the session works in. ${modelClause}.`,
      "type: 'code' (default). 'cowork' is not yet available. title: short roster label.",
    ].join(" "),
    args: z.object({
      dir: z.string().min(1),
      prompt: z.string().min(1),
      model: modelField,
      type: z.enum(["code", "cowork"]).optional(),
      title: z.string().optional(),
    }),
    async run(args, ctx) {
      if (opts.spawn === undefined) return "SpawnSession is only available in the dispatch session.";
      // The schema above has validated `args` (its `model` field's type depends on the enum).
      return await opts.spawn(args as Parameters<SessionSpawner>[0], ctx);
    },
  }];
}
