import { z } from "zod";
import type { ToolRegistry } from "./registry";
import type { AgentRegistry } from "../bg-agent-registry";
import type { SessionStore } from "../../sessions/store";

/**
 * agent_list + agent_output (phase 5a Task 1) — the read-only "collect your subagents" half of
 * the run_in_background surface (spawn_agent/send_message/task_stop are the write/control half).
 * Both are PLAIN TOOLS like task_stop (task-stop.ts is the model: deps closure at registration,
 * `ctx.sessionId` at run time) — nothing here needs the engine's dispatch loop, so there is no
 * bridge to intercept these calls. `deferred: true` unconditionally (unlike task_stop, whose
 * deferral is caller-supplied) — daemon.ts always registers these behind ToolSearch, same as
 * bash_output/task_stop.
 *
 * Deliberately READ-ONLY: neither tool ever writes `entry.notified` — task_stop and the detached
 * chain's own `takeForNotification` claim (engine.ts's settle-time completion-notice persistence)
 * are the ONLY writers of that flag. A model peeking at a result via agent_output must not affect
 * whether a LATER settle-time claim still finds the entry unnotified.
 */
export function registerAgentQueryTools(
  r: ToolRegistry,
  deps: {
    bgAgents: AgentRegistry;
    store: Pick<SessionStore, "read">;
    // Subagent transcript files (CC parity) — threaded through like `store`/`bgAgents` above.
    // Optional/absent (e.g. a test harness that never wires it) → agent_output simply never shows
    // a transcript line, matching every other transcript-path surface's "undefined = omit" rule.
    transcriptPathFor?: (sessionId: string, threadId: string) => string | undefined;
  },
): void {
  const { bgAgents, store, transcriptPathFor } = deps;

  r.register({
    name: "agent_list",
    description:
      "List your background subagents in this session — status, elapsed time, and description. " +
      "Message or re-task one with send_message; fetch its output with agent_output; stop it with task_stop.",
    args: z.object({}),
    deferred: true,
    run(_args, { sessionId }) {
      const entries = bgAgents.list(sessionId);
      if (entries.length === 0) return "no background agents in this session";
      const lines = entries.map((e) => {
        const elapsedS = Math.floor((Date.now() - e.startedAt) / 1000);
        const namePart = e.name ? ` (${e.name})` : "";
        const descPart = e.resume?.description ? ` — ${e.resume.description}` : "";
        return `${e.agentId}${namePart} — ${e.status}, elapsed ${elapsedS}s${descPart}`;
      });
      lines.push("Message or re-task an agent with send_message; fetch results with agent_output; stop with task_stop.");
      return lines.join("\n");
    },
  });

  r.register({
    name: "agent_output",
    description:
      "Fetch a background subagent's output by agentId or name (BackgroundAgentRegistry.get's own dual resolution) — " +
      "its final result once finished, or its latest assistant message while still running. " +
      "Also shows the path to its full transcript file, when available — that file can be large; grep it or read it with offset/limit rather than reading it whole.",
    args: z.object({ agent: z.string().min(1) }),
    deferred: true,
    run({ agent }, { sessionId }) {
      const entry = bgAgents.get(agent, sessionId);
      if (!entry) throw new Error(`no such agent '${agent}' in this session — agent_list shows them`);
      const transcript = transcriptPathFor?.(sessionId, entry.threadId);
      const transcriptLine = transcript ? `\ntranscript: ${transcript}` : "";
      if (entry.status !== "running") {
        // Terminal (completed/failed/stopped/timeout) — deliberately readable even when
        // `notified` is already true (a settle-time completion notice and an on-demand
        // agent_output peek are independent readers of the SAME result string).
        const result = entry.result ?? "(no result recorded)";
        // Dedupe (task-9 review, Minor 2): a SYNC-completed agent's stored result already ends
        // with the engine's syncTrailer, whose own `transcript: <path>` clause would make the
        // appended line here a SECOND mention of the same path — skip it then. A bg-completed
        // agent's result is the raw finalText (no trailer), so it still gets the line.
        const dedupedLine = result.includes("transcript:") ? "" : transcriptLine;
        return `agent '${agent}' ${entry.status}\n${result}${dedupedLine}`;
      }
      const elapsedS = Math.floor((Date.now() - entry.startedAt) / 1000);
      let latest: string | undefined;
      for (const e of store.read(sessionId)) {
        if (e.type === "assistant_message" && e.threadId === entry.threadId) latest = e.text;
      }
      return `agent '${agent}' running (${elapsedS}s elapsed)\n${latest ? `latest: ${latest}` : "no output yet"}${transcriptLine}`;
    },
  });
}
