// WS-25 (spec §1.3, §3): after a sign-in or a sign-out, LIVE sessions reconnect the server -- a Keychain
// write never evicts or restarts a child (COMMON-DAEMON, binding). A needs-auth server then lists its
// tools in the session that is already open (sign-in), or turns needs-auth and hides them (sign-out).
//
// WHICH CHILDREN, WHICH NAMES. A sign-in is keyed by the server's CANONICAL URL, and each session names
// its servers itself (its own fold: local > trusted project > user, for its own cwd) -- so every live
// child is asked about exactly the names ITS configuration gives that URL. The spec's wording is "live
// children whose mcp_status shows the server needs-auth/signed-in"; the SDK's `Query` exposes no
// `mcp_status` read, and the configured-URL match is the same set (a child reports a status for exactly
// the servers its configuration names). Reconnecting a server that was already connected is harmless (a
// fresh connection with the fresh token).
//
// TURN-SAFE, like `evictSessionsForCredential`: a child mid-turn is reconnected at its next idle boundary,
// so a tool call running on that server is never cut off.
//
// THE QUERY IS READ STRUCTURALLY. The driver table's `LegSession` does not carry the live `Query` (the
// session driver is the daemon-credentials lane's file); the live object is a `WinterSession`, whose
// `query` is public. A child whose SDK has no `reconnectMcpServer` (or no live query) is skipped, logged.
import { canonicalMcpServerUrl } from "@yanlinglabs/winter-agent-runtime/mcp-auth";

export interface ReconnectableSession {
  readonly sessionId: string;
  readonly turnRunning: boolean;
  idle(): Promise<void>;
}

export interface ReconnectDeps {
  /** Every live driver (the daemon's `WinterSessionDrivers.list()`). */
  list(): ReadonlyArray<ReconnectableSession>;
  /** The servers ONE session configures, as its own fold names them (name -> config). */
  serversFor(sessionId: string): Record<string, { type?: string; url?: string }>;
  log?: (line: string) => void;
}

type ReconnectingQuery = { reconnectMcpServer?: (name: string) => Promise<void> };

function queryOf(session: ReconnectableSession): ReconnectingQuery | undefined {
  const query = (session as { query?: unknown }).query;
  return typeof query === "object" && query !== null ? (query as ReconnectingQuery) : undefined;
}

function sameServer(url: unknown, canonical: string): boolean {
  if (typeof url !== "string") return false;
  try {
    return canonicalMcpServerUrl(url) === canonical;
  } catch {
    return false;
  }
}

/**
 * Asks every live child that configures `serverUrl` to reconnect it. Resolves once the idle children
 * have been asked (and answered); a mid-turn child is asked at its idle boundary, in the background.
 * Never throws: a reconnect that rejects (after a sign-out the server IS needs-auth now -- expected) is
 * one log line. Returns the session ids it acted on (now or scheduled).
 */
export async function reconnectLiveSessionsFor(deps: ReconnectDeps, serverUrl: string): Promise<string[]> {
  let canonical: string;
  try {
    canonical = canonicalMcpServerUrl(serverUrl);
  } catch {
    return [];
  }
  const acted: string[] = [];
  const now: Promise<void>[] = [];
  for (const session of deps.list()) {
    let servers: Record<string, { type?: string; url?: string }>;
    try {
      servers = deps.serversFor(session.sessionId);
    } catch {
      continue;
    }
    const names = Object.entries(servers).filter(([, cfg]) => cfg.type !== "stdio" && sameServer(cfg.url, canonical)).map(([name]) => name);
    if (names.length === 0) continue;
    acted.push(session.sessionId);
    const run = async (): Promise<void> => {
      const query = queryOf(session);
      if (query?.reconnectMcpServer === undefined) {
        deps.log?.(`mcp: ${session.sessionId} has no live child that can reconnect ${names.join(", ")} — it picks the change up at its next incarnation`);
        return;
      }
      for (const name of names) {
        try {
          await query.reconnectMcpServer(name);
          deps.log?.(`mcp: ${session.sessionId} reconnected '${name}'`);
        } catch (err) {
          // After a sign-out this is the expected answer (the server is needs-auth now).
          deps.log?.(`mcp: ${session.sessionId} reconnected '${name}', which did not connect (${err instanceof Error ? err.name : "unknown"})`);
        }
      }
    };
    if (session.turnRunning) {
      deps.log?.(`mcp: ${session.sessionId} is mid-turn — it reconnects ${names.join(", ")} at its next idle boundary`);
      void session.idle().then(run, () => { /* the session ended first: nothing to reconnect */ });
    } else {
      now.push(run());
    }
  }
  await Promise.all(now);
  return acted;
}
