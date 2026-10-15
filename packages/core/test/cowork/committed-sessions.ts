import type { CoworkCommittedSessions } from "../../src/cowork/repository";

/** Explicit authority-unit fixture inventory, not production/session-index evidence.
 * Real outbox/RPC integration supplies its actual SessionStore instead. */
export function authorityFixtureSessions(...ids: string[]): CoworkCommittedSessions {
  const committed = new Set(ids);
  return { hasCommittedSession: id => committed.has(id) };
}
