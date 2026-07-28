import { z } from "zod";
import type { ToolRegistry } from "./registry";

/** Registers send_message with a placeholder run(). Like spawn_agent, send_message is an ENGINE
 *  BRIDGE, not a plain tool: the engine intercepts send_message tool calls in runThread's dispatch
 *  round (the `sendMessageCalls`/`sendMessageOutcomes` bridge in engine.ts, mirroring the
 *  spawn_agent bridge) BEFORE this placeholder run() would ever fire — and only for a DEPTH-0
 *  (main) thread. This run() is therefore never reached when the bridge is wired; it exists solely
 *  so the tool has a valid ToolDefinition (schema + description the model sees) and returns a clear
 *  message in the degenerate case the bridge is absent (no bgAgents wired).
 *
 *  CC parity (SendMessage): message a subagent by its agentId or `name`. A RUNNING agent receives
 *  the message at its next step (queued into its per-thread steer queue, drained at its next round
 *  boundary); a FINISHED agent is RESUMED with the message as its new instruction (reusing the same
 *  resume path spawn_agent's `resume` uses), always in the background so send_message never blocks
 *  the caller. v1 is main-thread-only: children can't message peers (send_message is excluded from
 *  every child's tool set and the bridge is depth-0 gated). */
export function registerSendMessageTool(r: ToolRegistry): void {
  const SendMessageArgs = z.object({
    to: z.string().min(1),
    message: z.string().min(1),
  });
  r.register({
    name: "send_message",
    description:
      "Send a message to a subagent you launched, addressed by its agentId or name. " +
      "A running agent receives the message at its next step; a finished agent is resumed with the message as its new instruction (it keeps its prior context). " +
      "Delivery is fire-and-forget — you get back a confirmation immediately and are notified separately when a resumed agent finishes; it never blocks your turn. " +
      "to: the target agent's agentId or name (required); message: the text to deliver (required).",
    args: SendMessageArgs,
    // D1-T2: deferred ONLY in dispatch — mirrors bash/task_stop/computer/AskQuestion. `modes` is
    // still absent here (defaults to `["code"]`, registry.ts's own doc comment), so this is
    // currently inert for dispatch (a mode a tool isn't eligible for can never be "deferred" for
    // it either) — dispatch gains eligibility in a later task (session-targeted send_message),
    // which is what actually makes this array meaningful there. Declaring it now is forward-safe:
    // it changes nothing until that task also adds "dispatch" to `modes`.
    deferred: ["dispatch"],
    run(_args: z.infer<typeof SendMessageArgs>) {
      return "send_message is not available in this session";
    },
  });
}
