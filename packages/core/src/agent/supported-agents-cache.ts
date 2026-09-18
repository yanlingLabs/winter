// Daemon settings surface (2026-09-17 plan, item 3): the daemon-wide "last observed built-in agent
// list" cache. `Query.supportedAgents()` is Winter-leg-only and answers per LIVE session
// (`session-driver.ts`'s `WinterLegDeps.onSupportedAgents` is the one producer, fired
// fire-and-forget right after each incarnation's query is created) — a Mac Settings panel asking
// "what agent types exist" needs an answer even when nothing is live RIGHT NOW, so this is a single
// slot holding the MOST RECENT successful answer from ANY session, never a per-session map (a
// per-session map would serve nothing the moment every session ends, which defeats the whole point).
import type { AgentInfo } from "@yanlinglabs/winter-agent-sdk";

export interface SupportedAgentsSnapshot {
  agents: AgentInfo[];
  /** Winter's own session id the answer came from — attribution, not a lookup key. */
  sessionId: string;
  observedAt: number;
}

export class SupportedAgentsCache {
  private snapshot: SupportedAgentsSnapshot | null = null;

  /** Overwrites the cache with a fresh answer. Never merges — the runtime's own resolved
   *  built-in/filesystem/programmatic set is already complete per call (`Query.supportedAgents()`'s
   *  own doc comment), so there is nothing to merge with a stale prior answer. */
  observe(sessionId: string, agents: AgentInfo[]): void {
    this.snapshot = { agents, sessionId, observedAt: Date.now() };
  }

  /** `null` when nothing has EVER been observed (no Winter-leg session has ever reached the point
   *  of answering `supportedAgents()`) — the RPC reports this typed, rather than inventing a list. */
  get(): SupportedAgentsSnapshot | null {
    return this.snapshot;
  }
}
