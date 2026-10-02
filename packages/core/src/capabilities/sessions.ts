// The `sessions` capability server (P8b-12) — dispatch's orchestration surface: `session_spawn` and
// `list_sessions`. (`manage_session` was REMOVED 2026-10-02, user ruling: Dispatch messages or resumes a
// session with SendMessage and stops its turn with TaskStop; the tool name keeps stripping for old
// transcripts — `CAPABILITY_TOOLS_BY_KEY` — but no server serves it.)
//
// Both are `modes: ["dispatch"]` today and stay that way (`WINTER_CAPABILITY_TOOLS`), and since
// P8b-36 made the session — and therefore its mode — part of the server, that is ENFORCED HERE
// rather than delegated: `capabilityServer` filters the defs by the session's mode (P8b-37), so a
// chat or code session's `sessions` server advertises nothing and serves nothing. Task 9's per-mode
// `disallowedTools` remains the other half, belt and braces.
//
// Delegating that scoping to a STRING list was the arrangement C1 showed can be silently wrong: a
// `disallowedTools` entry that does not match the name the child registered denies nothing.
//
// `session_spawn` runs through `deps.spawn` — the daemon's `DispatchChildren.spawn`
// (`agent/dispatch-children.ts`), which mints the child through `session.create`'s own creation
// transaction, sends it the prompt, returns at once, and then follows the child: its `child_update`s
// and relayed approval/question cards land on the dispatch session's log, and its result wakes the
// coordinator with a `<child_update>`. On the engine this was a BRIDGE in `engine.ts` that ran before
// the registry; the capability server's `callTool` is the door on the Winter leg. A server built
// without `spawn` (a test) answers the def's fixed "only available in the dispatch session" line.
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { listSessionsToolDefs, type ListSessionsDeps } from "../agent/tools/list-sessions";
import { sessionSpawnToolDefs, type SessionSpawner } from "../agent/tools/session-spawn";
import { capabilityServer, type CapabilitySession } from "./server";

export interface SessionsCapabilityDeps {
  /** The `session_spawn` schema's `model` enum — WS-20: every credentialed provider's own tag
   *  (`pickerModels()`, ipc/picker-models.ts), catalog order, snapshotted at boot. Steering only:
   *  the spawner's own LIVE picker check is the authoritative gate. A daemon with no credentials at
   *  all has no model list, and the field falls back to a free string. */
  models?: string[];
  /** `session_spawn`'s implementation (`DispatchChildren.spawn`, bound to the calling session). */
  spawn?: SessionSpawner;
  /** `list_sessions`' deps — the SAME `store`/`derive` closures `daemon.ts` uses everywhere. Handing
   *  this server its own store or hub would make it disagree with the session list about what is
   *  running (the T7 finding). */
  sessions: ListSessionsDeps;
}

export function sessionsCapability(session: CapabilitySession, deps: SessionsCapabilityDeps): McpSdkServerConfigWithInstance {
  return capabilityServer(
    {
      key: "sessions",
      defs: [
        ...sessionSpawnToolDefs({ models: deps.models, ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }) }),
        ...listSessionsToolDefs(deps.sessions),
      ],
    },
    session,
  );
}
