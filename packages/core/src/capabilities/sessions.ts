// The `sessions` capability server (P8b-12) — dispatch's orchestration and fleet-management
// surface: `session_spawn`, `list_sessions`, `manage_session`.
//
// All three are `modes: ["dispatch"]` today and stay that way (`WINTER_CAPABILITY_TOOLS`), and since
// P8b-36 made the session — and therefore its mode — part of the server, that is ENFORCED HERE
// rather than delegated: `capabilityServer` filters the defs by the session's mode (P8b-37), so a
// chat or code session's `sessions` server advertises nothing and serves nothing. Task 9's per-mode
// `disallowedTools` remains the other half, belt and braces.
//
// THAT MATTERS MOST FOR `manage_session`, which can background, archive or interrupt any session by
// id. Delegating its scoping to a STRING list was the arrangement C1 showed can be silently wrong:
// a `disallowedTools` entry that does not match the name the child registered denies nothing.
//
// ⚠️ `session_spawn` IS A PLACEHOLDER ON BOTH DOORS, and that is the honest port rather than an
// oversight. On the engine the real work is a BRIDGE: `engine.ts`'s per-round loop intercepts
// `session_spawn` calls in a dispatch session's main thread BEFORE registry execution, does its own
// pre-flight rejections and calls `DispatchChildren.spawnChild`, so the registered tool's `run()`
// has always been the fallback that fires when the bridge is not active ("session_spawn is only
// available in the dispatch session."). That bridge is entangled in the engine's `spawnOutcomes`
// map and its call-order consumption — it is not a function this file could call — and P8b-15
// replaces the whole mechanism with `PersistedWinterChild` in Task 13. So: one implementation, two
// doors is satisfied (both doors run the SAME def), and the consequence is recorded — a Winter-leg
// dispatch session cannot delegate until Task 13 rebuilds the bridge on the SDK's child messaging.
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { listSessionsToolDefs, type ListSessionsDeps, type ManageSessionDeps } from "../agent/tools/list-sessions";
import { sessionSpawnToolDefs } from "../agent/tools/session-spawn";
import { capabilityServer, type CapabilitySession } from "./server";

export interface SessionsCapabilityDeps {
  /** The `session_spawn` schema's `model` enum — the SAME list `registerSessionSpawnTool` gets in
   *  `daemon.ts` (known model ids + their unambiguous short aliases). Steering only, exactly as it
   *  is on the registry door: the bridge's own `models()` check is the authoritative gate. A
   *  daemon with no agent provider has no model list, and the field falls back to a free string. */
  models?: string[];
  /** `list_sessions`/`manage_session`'s deps — the SAME `store`/`derive`/`interrupt`/`emit`
   *  closures `daemon.ts` hands `registerListSessionsTools`. Handing this server its own store or
   *  hub would make it disagree with the session list about what is running (the T7 finding). */
  sessions: ListSessionsDeps & ManageSessionDeps;
}

export function sessionsCapability(session: CapabilitySession, deps: SessionsCapabilityDeps): McpSdkServerConfigWithInstance {
  return capabilityServer(
    {
      key: "sessions",
      defs: [
        ...sessionSpawnToolDefs({ models: deps.models }),
        ...listSessionsToolDefs(deps.sessions),
      ],
    },
    session,
  );
}
