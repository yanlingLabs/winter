import { z } from "zod";
import type { ToolRegistry } from "./registry";
import { guardAgentName, type BackgroundAgentRegistry } from "../bg-agent-registry";
import type { BackgroundTaskRegistry } from "../bg-registry";

/**
 * task_stop (CC parity: Agent.TaskStop) — stop a RUNNING background agent (by agentId or `name`,
 * BackgroundAgentRegistry.get's own dual resolution) or a background bash task (by taskId,
 * BackgroundTaskRegistry). A PLAIN TOOL, not an engine bridge (unlike spawn_agent/send_message):
 * everything it needs — resolve, abort, mark notified, kill — is a synchronous call on the two
 * registries it's handed, so there is nothing for the engine's dispatch loop to intercept.
 *
 * Resolution order mirrors CC: (1) a bg AGENT match wins — running → stop it; terminal → report
 * its status (idempotent-friendly, NOT an error, same as calling TaskStop twice in CC). (2) else a
 * bg bash TASK match — kill it via the SAME BackgroundTaskRegistry.kill() call the (now-removed)
 * standalone `bash_kill` tool used to make; this tool's bash-unify path is a convenience alias for
 * a caller that doesn't know/care which kind of background work `task_id` refers to, and is the
 * ONLY way to stop a background bash task (CC parity: one generic stop tool, not two). (3) else a
 * typed not-found error.
 *
 * `entry.notified = true` (mirrors the sync-spawn `complete(..., {notified:true})` reasoning in
 * bg-agent-registry.ts): the CALLER of task_stop receives this tool_result directly, in the SAME
 * turn — the detached chain's own eventual settle-time claim (`takeForNotification`, engine.ts's
 * `notifyBgCompletion`, built for `run_in_background`'s DETACHED completions) must never persist a
 * task_notification for an agent the caller just stopped itself. Set directly on the live entry
 * object (register()'d/returned by the SAME Map) — no new BackgroundAgentRegistry method needed;
 * the entry is a live reference, not a copy.
 */
export function registerTaskStopTool(
  r: ToolRegistry,
  deps: {
    bgAgents?: BackgroundAgentRegistry;
    bgRegistry?: BackgroundTaskRegistry;
    deferred?: boolean;
    // Dispatch (Phase 7) Task 5: the dispatch session's own children are ALSO stoppable via
    // task_stop — inserted between the bgAgents and bgRegistry branches (agent ids keep
    // precedence over a dispatch child id; bash tasks stay last). Only the live dispatch session
    // may stop one of its own children (see DispatchChildren.stopChild); every other caller, or an
    // id that isn't a tracked child, resolves to undefined here and falls through unchanged.
    dispatch?: { stopChild(callerSessionId: string, id: string): string | undefined };
  } = {},
): void {
  const { bgAgents, bgRegistry, deferred, dispatch } = deps;
  r.register({
    name: "task_stop",
    description:
      "Stop a running background agent (by agentId or name) or a background bash task (by taskId). " +
      "Stopping an already-finished agent is not an error — it just reports its current status. " +
      "In the dispatch session, child session ids are also stoppable.",
    args: z.object({ task_id: z.string().min(1) }),
    modes: ["code", "dispatch"], // R-T2: was DISPATCH_ALLOW_TOOLS's literal membership
    deferred,
    run({ task_id }, { sessionId }) {
      const entry = bgAgents?.get(task_id, sessionId);
      if (entry) {
        // 4h-ii-b Task 5 (stale-name guard, CC v2.1.199 parity) — same rule as the send_message
        // bridge (engine.ts): only a BY-NAME resolution is checked/tracked; by-ID stop calls bypass
        // this entirely. Stopping the WRONG agent under a stale name is worse than messaging it, so
        // task_stop gets the same guard. child-transcript-view T1: factored into `guardAgentName`
        // (bg-agent-registry.ts), shared with the send_message bridge and the thread.send/agent.stop
        // RPCs, so this guard can't drift across its four call sites.
        const guard = guardAgentName(bgAgents!, sessionId, task_id, entry);
        if (!guard.ok) throw new Error(guard.error);
        if (entry.status === "running") {
          bgAgents!.stop(entry.agentId);
          entry.notified = true;
          return `stopped agent '${task_id}'`;
        }
        return `agent '${task_id}' already ${entry.status}`;
      }
      const stopped = dispatch?.stopChild(sessionId, task_id);
      if (stopped) return stopped;
      if (bgRegistry?.has(sessionId, task_id)) {
        bgRegistry.kill(sessionId, task_id);
        return `killed ${task_id}`;
      }
      throw new Error(`no running agent, dispatch child, or background task '${task_id}'`);
    },
  });
}
