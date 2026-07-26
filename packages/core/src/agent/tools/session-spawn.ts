import { z } from "zod";
import type { ToolRegistry } from "./registry";

/** Dispatch (Phase 7) Task 4: session_spawn — the coordinator's delegation tool. Registered with a
 *  placeholder run(): the engine BRIDGE intercepts session_spawn calls in a dispatch session's
 *  main thread BEFORE registry execution (spawn_agent precedent, engine.ts's dispatch loop) — this
 *  placeholder only fires when the bridge isn't active for the call (a code session, where
 *  session_spawn is also excluded from the tool list entirely — turn()'s isDispatch ternary — or a
 *  dispatch session with cfg.dispatch unwired), mirroring spawn.ts's own placeholder-vs-bridge
 *  split and its plain-string return (registry.ts's execute() wraps a returned string as
 *  {output, isError:false} — same shape spawn_agent's own placeholder uses).
 *
 *  The schema enum on `model` is steering only (defense-in-depth, same two-layer shape as
 *  spawn.ts's own `model` field, see its doc comment) — the bridge's own models() check (with
 *  resolveModelAlias) is the authoritative runtime gate. */
export function registerSessionSpawnTool(r: ToolRegistry, opts: { models?: string[] } = {}): void {
  const hasModels = !!opts.models && opts.models.length > 0;
  const modelField = hasModels ? z.enum(opts.models as [string, ...string[]]).optional() : z.string().optional();
  const modelClause = hasModels
    ? `model: optional override, one of: ${opts.models!.join(", ")} (omit to inherit the default model)`
    : "model: optional model override";
  r.register({
    name: "session_spawn",
    // R-T2: dispatch's own orchestration verb — was DISPATCH_ALLOW_TOOLS's literal membership,
    // now the single declaration site. Code eligibility is vestigial (SESSION_SPAWN_TOOL is
    // ALWAYS added to code's excludeTools unconditionally in engine.ts, independent of this field)
    // but kept for consistency with every other former-DISPATCH_ALLOW_TOOLS member.
    modes: ["code", "dispatch"],
    description: [
      "Spawn a full, first-class work session in a directory. The child is an ordinary code session:",
      "own transcript, visible in the session list, full tools. It runs asynchronously — you get a",
      "child_update when it finishes. Write the prompt self-contained: the child cannot see this conversation.",
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
    run() {
      return "session_spawn is only available in the dispatch session.";
    },
  });
}
