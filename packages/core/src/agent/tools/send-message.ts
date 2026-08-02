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
 *  every child's tool set and the bridge is depth-0 gated).
 *
 *  D1-T4 (dispatch-toolset): `to` gains a THIRD resolution kind — a session id (a first-class
 *  session spawned via `session_spawn`), resolved as a fallback AFTER agent resolution fails (an
 *  agent-named-like-a-session-id keeps today's exact behavior). Authorization is CHILDREN ONLY:
 *  `store.meta(to).parentSessionId === callerSessionId` — a direct parent edge, not ancestry —
 *  which is what makes inter-session loops structurally impossible (spawn edges form a tree, so if
 *  A spawned B, A may message B but B can never message A). A running session-target queues via
 *  the same drain-then-persist machinery a subagent thread gets (never landing between a tool_call
 *  and its tool_result); an idle one starts a fresh turn the same way `session.send` does.
 *
 *  session-activity-hygiene T8 widens that SESSION half for ONE caller: a dispatch-mode session may
 *  target any code/cowork session, child or not (the coordinator manages the whole fleet). The
 *  parent-edge rule is untouched for every other caller, and the AGENT half is untouched entirely —
 *  see the bridge's own comments in engine.ts for why widening the singleton coordinator cannot open
 *  a cycle. The same task made an ARCHIVED target a REFUSAL at that bridge: archived is a
 *  user-visible hidden state, and only a deliberate resume (`manage_session` / `session.setActivity`)
 *  brings it back. */
export function registerSendMessageTool(r: ToolRegistry): void {
  const SendMessageArgs = z.object({
    to: z.string().min(1),
    message: z.string().min(1),
  });
  r.register({
    name: "send_message",
    description:
      "Send a message to a subagent you launched (by agentId or name) OR to a session (by session id). " +
      "SUBAGENTS are always ones YOU started — you can never message the agent that launched you. " +
      "SESSIONS: a session you spawned via session_spawn (a DIRECT child — a spawned child's own child is not yours to message); in Dispatch mode, ANY code or cowork session on this Mac (list_sessions shows them). Chat sessions can never be messaged. " +
      "An ARCHIVED session is refused: the user hid it, so resume it deliberately first (manage_session) rather than waking it with a message. " +
      "A running target receives the message at its next step; a finished agent is resumed with the message as its new instruction (it keeps its prior context); an idle session starts a fresh turn with the message. " +
      "Delivery is fire-and-forget — you get back a confirmation immediately and are notified separately when a resumed agent finishes; it never blocks your turn. " +
      "to: the target's agentId, name, or session id (required); message: the text to deliver (required).",
    args: SendMessageArgs,
    // D1-T2: deferred ONLY in dispatch — mirrors bash/task_stop/computer/AskQuestion.
    deferred: ["dispatch"],
    // D1-T4: `modes` was absent (defaulting to `["code"]`, registry.ts's own doc comment), which
    // left `deferred: ["dispatch"]` above INERT — a mode a tool isn't eligible for can never be
    // "deferred" for it either (dispatch's `namesForMode` never included this tool at all). Now
    // that session-targeting gives dispatch a real reason to call it, dispatch must be an eligible
    // mode too.
    modes: ["code", "dispatch"],
    run(_args: z.infer<typeof SendMessageArgs>) {
      return "send_message is not available in this session";
    },
  });
}
