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
    // now the single declaration site.
    // R-T3 review finding 1: this used to read `["code", "dispatch"]` — "code eligibility is
    // vestigial (SESSION_SPAWN_TOOL is ALWAYS added to code's excludeTools unconditionally in
    // engine.ts, independent of this field) but kept for consistency" — which was exactly the
    // class of drift this whole slice exists to remove: eligibility stated in two places that
    // could disagree. Declared truthfully as dispatch-only now. engine.ts's hardcoded
    // SESSION_SPAWN_TOOL exclusion for code stays as belt-and-braces: if a later task ever moves
    // code from exclude-shaped toolAccess to an allow-shaped `namesForMode("code")` (chat and
    // dispatch already are), this field alone would no longer keep session_spawn off code's
    // toolset — the hardcoded exclusion is what still would.
    modes: ["dispatch"],
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
