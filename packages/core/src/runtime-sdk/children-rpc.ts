// P8b Task 17 — `thread.send` / `agent.stop` for WINTER children, over the persisted roster and the
// owning session's messaging facet. The engine answered these from its in-process thread table
// (`sendToThread`/`resumeThread`); a Winter child belongs to its session's `winter` process, so the
// only doors are the facet's `steerChild` (running) and `resumeChild` (terminal, addressable) —
// P8b-15 / surface map §8. Semantics mirror the engine's: name guard first, a running child is
// steered (`delivered: "queued"`), a finished one is resumed (`delivered: "resumed"`), a stop flips
// the roster (the facet is asked to stop; nothing is killed locally).
import type { SessionMessagingFacet } from "@yanlinglabs/winter-agent-sdk";
import { buildChildAddress, buildSessionAddress, type GlobalAgentMessage } from "@yanlinglabs/winter-agent-sdk/messaging";
import { guardAgentName, type AgentRegistry, type AgentStatus } from "../agent/bg-agent-registry";

export interface ChildrenRpc {
  send(sessionId: string, agent: string, text: string): Promise<
    | { ok: true; delivered: "queued" | "resumed"; agentId: string }
    | { ok: false; kind: "not_found" | "invalid"; error: string }
  >;
  stop(sessionId: string, agent: string): { ok: true; status: AgentStatus } | { ok: false; error: string };
}

export function createChildrenRpc(deps: {
  registry: () => AgentRegistry | undefined;
  /** The owning session's live facet (attached by the driver at init), or undefined while it is
   *  resumable/ended — a message then has no live door and is refused honestly. */
  facetFor: (sessionId: string) => SessionMessagingFacet | undefined;
  now?: () => number;
}): ChildrenRpc {
  const now = deps.now ?? (() => Date.now());
  const envelope = (parent: string, childId: string, body: string): GlobalAgentMessage => ({
    messageId: `send:${encodeURIComponent(parent)}:${encodeURIComponent(childId)}:${now()}`,
    from: buildSessionAddress(parent),
    fromGeneration: 0,
    to: buildChildAddress(parent, childId),
    toGeneration: 0,
    body,
    notifyWhenIdle: false,
    createdAt: now(),
    expiresAt: now() + 60_000,
    hopCount: 0,
    senderPermissionClass: "prompts",
  });
  return {
    async send(sessionId, agent, text) {
      const registry = deps.registry();
      if (registry === undefined) return { ok: false, kind: "not_found", error: "send_message is not available in this session" };
      const entry = registry.get(agent, sessionId);
      if (!entry) return { ok: false, kind: "not_found", error: `no agent '${agent}' to message` };
      const guard = guardAgentName(registry, sessionId, agent, entry);
      if (!guard.ok) return { ok: false, kind: "not_found", error: guard.error };
      const facet = deps.facetFor(sessionId);
      if (facet === undefined) return { ok: false, kind: "invalid", error: `session ${sessionId} has no live winter child to carry the message (resume it first)` };
      const msg = envelope(sessionId, entry.agentId, text);
      const outcome = entry.status === "running"
        ? await facet.steerChild(entry.agentId, msg)
        : await facet.resumeChild(entry.agentId, msg);
      if (outcome.status === "delivered" || outcome.status === "queued") return { ok: true, delivered: "queued", agentId: entry.agentId };
      if (outcome.status === "resumed_and_delivered") return { ok: true, delivered: "resumed", agentId: entry.agentId };
      return { ok: false, kind: "invalid", error: `the child answered ${outcome.status}${"reason" in outcome && outcome.reason ? `: ${outcome.reason}` : ""}` };
    },
    stop(sessionId, agent) {
      const registry = deps.registry();
      if (registry === undefined) return { ok: false, error: "background agents are not available in this session" };
      const entry = registry.get(agent, sessionId);
      if (!entry) return { ok: false, error: `no agent '${agent}' to stop` };
      const guard = guardAgentName(registry, sessionId, agent, entry);
      if (!guard.ok) return { ok: false, error: guard.error };
      if (entry.status === "running") {
        registry.stop(entry.agentId);
        return { ok: true, status: "stopped" };
      }
      return { ok: true, status: entry.status };
    },
  };
}
