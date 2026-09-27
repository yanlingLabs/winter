// WS-25 (spec §1.3, §3): after a sign-in or a sign-out, LIVE sessions reconnect the server -- a Keychain
// write never evicts or restarts a child (COMMON-DAEMON, binding). A needs-auth server then lists its
// tools in the session that is already open (sign-in), or turns needs-auth and hides them (sign-out).
//
// WHICH CHILDREN, WHICH NAMES. A sign-in is keyed by the server's CANONICAL URL, and each session names
// its servers itself. The session answers that itself (`WinterSession.mcpServerNamesFor`): the names under
// which its LIVE incarnation configured an http/sse server at that URL -- the fold the child was actually
// spawned with (kept with the incarnation by `session-driver.ts`, plugin servers included on a run-home
// build), not a re-derivation from today's settings, which may have moved since the spawn. The spec's
// wording is "live children whose mcp_status shows the server needs-auth/signed-in"; the SDK's `Query`
// exposes no `mcp_status` read, and the configured-URL match is the same set (a child reports a status
// for exactly the servers its configuration names). A session that is not live answers `[]`: its next
// incarnation reads the Keychain afresh. Reconnecting a server that was already connected is harmless (a
// fresh connection with the fresh token).
//
// TURN-SAFE, like `evictSessionsForCredential`: a child mid-turn is reconnected at its next idle boundary,
// so a tool call running on that server is never cut off.
//
// Both methods are optional on the driver table's `LegSession` (a test double need not implement them); a
// session without them is skipped. `reconnectMcpServer` itself refuses typed (`WinterLegUnsupported`) when
// the child ended meanwhile or its SDK has no reconnect control -- one log line, like any other rejection.

export interface ReconnectableSession {
  readonly sessionId: string;
  readonly turnRunning: boolean;
  idle(): Promise<void>;
  /** `WinterSession.mcpServerNamesFor`: the live incarnation's names for an http/sse server at a URL. */
  mcpServerNamesFor?(serverUrl: string): string[];
  /** `WinterSession.reconnectMcpServer`: the runtime's `mcp_reconnect` control on the live child. */
  reconnectMcpServer?(name: string): Promise<void>;
}

export interface ReconnectDeps {
  /** Every live driver (the daemon's `WinterSessionDrivers.list()`). */
  list(): ReadonlyArray<ReconnectableSession>;
  log?: (line: string) => void;
}

/**
 * Asks every live child that configures `serverUrl` to reconnect it. Resolves once the idle children
 * have been asked (and answered); a mid-turn child is asked at its idle boundary, in the background.
 * Never throws: a reconnect that rejects (after a sign-out the server IS needs-auth now -- expected) is
 * one log line. Returns the session ids it acted on (now or scheduled).
 */
export async function reconnectLiveSessionsFor(deps: ReconnectDeps, serverUrl: string): Promise<string[]> {
  const acted: string[] = [];
  const now: Promise<void>[] = [];
  for (const session of deps.list()) {
    const reconnect = session.reconnectMcpServer?.bind(session);
    if (session.mcpServerNamesFor === undefined || reconnect === undefined) continue;
    let names: string[];
    try {
      names = session.mcpServerNamesFor(serverUrl);
    } catch {
      continue;
    }
    if (names.length === 0) continue;
    acted.push(session.sessionId);
    const run = async (): Promise<void> => {
      for (const name of names) {
        try {
          await reconnect(name);
          deps.log?.(`mcp: ${session.sessionId} reconnected '${name}'`);
        } catch (err) {
          // After a sign-out this is the expected answer (the server is needs-auth now); a
          // `WinterLegUnsupported` means the child ended meanwhile -- its next incarnation reads the Keychain.
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
