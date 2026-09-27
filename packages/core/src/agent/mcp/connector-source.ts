// WS-26 — the DAEMON's `ConnectorPermissionSource` (`connector-permissions.ts`): the live facts the
// connector-permission hook, the approval bridge and `mcp.tools` all decide on. Both answers are synchronous
// and neither ever waits on a probe.
//
// THE TABLE: the daemon's in-memory settings (`settings.mcp.toolPermissions`, swapped by the settings
// watcher), except that a write through `mcp.setToolPermission` is held here (`noteWritten`) until the
// watcher swaps the settings object — the watcher debounces (150 ms), and a flip must reach the very next
// call. The held write is keyed on the settings object's identity, so the watcher's swap (or a hand edit it
// picks up) always supersedes it.
//
// WHICH LISTING answers "read-only" (review r1, minor 6): the one of the scope the server name RESOLVES to
// for the session's cwd — local > project > user, the runtime's own precedence:
//  - a name the LOCAL scope defines (`sdk/.winter.json` `projects[<root>]`) — never probed by the daemon —
//    has no answer: toward ask;
//  - a name the TRUSTED project's `.winter/mcp.json` defines answers from that project's listing only, and
//    has none until something lists the project (`mcp.list`/`mcp.tools` with that cwd, `winter mcp
//    permissions` run there) — never borrowed from a same-named user server;
//  - anything else, from the user scope's listing.
// The STORED permissions stay keyed by name alone, like `mcp.disabled`: a project's `cf` takes the same
// settings as the user's `cf`. WS-27: when the runtime states which server a call belongs to
// (`winter_mcp_server` / `mcpServer`, `connectorFactsFor`'s `stated`), that fact wins over every guess here —
// a SUBAGENT definition's inline `cf` renamed `cf_2` inside the child is keyed by its config name `cf`, and
// read-only comes from the runtime's own listing. Without it (an older runtime) a renamed action takes
// `cf_2`'s values, if any. An inline server the daemon can see — a user, trusted-project or plugin agent
// definition (`server-names.ts`) — counts as `configured`, as do the plugins a trusted project enables.
//
// THE BACKGROUND KICK (review r1, minor 7): on a user-scope miss, at most once a minute per server, an
// http/sse USER server with no recorded status is probed in the background (such a server is otherwise
// probed only when something calls `mcp.list`/`mcp.tools`). Deliberately nothing else: a stdio probe starts
// a process, and a project's servers are repository-provided commands — a model's tool call must never make
// the daemon spawn one (the Library tab keeps the same rule). Such a miss stays toward ask until a human
// lists the servers.
import type { ConnectorPermissionSource, ConnectorPermissionTable } from "./connector-permissions";
import type { McpManager, McpServerConfig } from "./manager";
import { readRawProjectMcpConfig } from "./project-file";
import type { TrustStore } from "../trust";
import { connectorPermissionTable, sdkLocalMcpServers, sdkUserMcpServers, type Settings } from "../../settings";
import { localScopeKeyFor, projectScopeRootFor, projectScopeTrusted } from "../../runtime-sdk/run-home-input";
import { agentInlineMcpServers, pluginMcpServerNames, trustedProjectRoots } from "./server-names";

export interface DaemonConnectorSourceDeps {
  home: string;
  trust: TrustStore;
  /** The daemon's live settings (its identity changes on every watcher swap). */
  settings: () => Settings | null | undefined;
  manager: () => McpManager | null | undefined;
  now?: () => number;
}

export type ConnectorListingScope = "local" | "user" | { project: string };

export interface DaemonConnectorSource extends ConnectorPermissionSource {
  /** `mcp.setToolPermission` just wrote `next`: serve its table until the watcher swaps the settings. */
  noteWritten(next: Settings): void;
  /** Which scope's listing answers read-only for `server` in a session at `cwd`. */
  scopeFor(server: string, cwd: string | undefined): ConnectorListingScope;
}

const KICK_INTERVAL_MS = 60_000;
/** How long a read of the plugins' and subagent definitions' server names is reused (a handful of small files per read). */
const PLUGIN_NAMES_TTL_MS = 5_000;

/** Moved to `server-names.ts` (WS-27); re-exported for existing callers. */
export { pluginMcpServerNames } from "./server-names";

export function daemonConnectorSource(deps: DaemonConnectorSourceDeps): DaemonConnectorSource {
  const now = deps.now ?? (() => Date.now());
  let written: { basis: Settings | null | undefined; table: ConnectorPermissionTable } | undefined;
  const kicks = new Map<string, number>();

  const kick = (manager: McpManager, server: string): void => {
    if (!manager.probesRemote || manager.hasUserStatus(server)) return;
    const t = now();
    if (t - (kicks.get(server) ?? -Infinity) < KICK_INTERVAL_MS) return;
    kicks.set(server, t);
    try {
      const entry = sdkUserMcpServers(deps.home)[server];
      const disabled = new Set(deps.settings()?.mcp?.disabled ?? []);
      if (entry !== undefined && entry.type !== "stdio" && !disabled.has(server)) {
        void manager.ensureRemote({ [server]: entry as McpServerConfig }).catch(() => { /* reported by the probe itself */ });
      }
    } catch { /* a background kick never fails a decision */ }
  };

  // WS-27: per project root (a trusted project's own enabled plugins and agent definitions count), so the
  // cache is keyed by the roots the cwd contributes.
  const nameCache = new Map<string, { at: number; names: ReadonlySet<string> }>();
  const otherNames = (cwd: string | undefined): ReadonlySet<string> => {
    const roots = trustedProjectRoots({ cwd, trust: deps.trust });
    const key = roots.join("\u0000");
    const t = now();
    const hit = nameCache.get(key);
    if (hit !== undefined && t - hit.at <= PLUGIN_NAMES_TTL_MS) return hit.names;
    const names = new Set(pluginMcpServerNames(deps.home, roots));
    for (const s of agentInlineMcpServers(deps.home, roots, cwd)) names.add(s.name);
    if (nameCache.size > 64) nameCache.clear();
    nameCache.set(key, { at: t, names });
    return names;
  };

  const scopeFor = (server: string, cwd: string | undefined): ConnectorListingScope => {
    if (!cwd) return "user";
    try {
      if (Object.hasOwn(sdkLocalMcpServers(deps.home, localScopeKeyFor(cwd)), server)) return "local";
      if (projectScopeTrusted(cwd, deps.trust)) {
        const read = readRawProjectMcpConfig(projectScopeRootFor(cwd));
        if (read.kind === "ok" && Object.hasOwn(read.servers, server)) return { project: cwd };
      }
    } catch { /* unreadable: the user scope, which the runtime would fall back to as well */ }
    return "user";
  };

  return {
    table: () => {
      const current = deps.settings();
      return written !== undefined && written.basis === current ? written.table : connectorPermissionTable(current);
    },
    readOnly: (server, tool, cwd) => {
      const manager = deps.manager();
      if (manager === null || manager === undefined) return undefined;
      const scope = scopeFor(server, cwd);
      if (scope === "local") return undefined;
      const hint = manager.readOnlyHintIn(scope, server, tool);
      if (hint === undefined && scope === "user") kick(manager, server);
      return hint;
    },
    // Configured for this session: the local or trusted project scope defines it, the user scope does, a
    // plugin the session can load ships it, or a subagent definition declares it inline (`server-names.ts`).
    configured: (server, cwd) => {
      const scope = scopeFor(server, cwd);
      if (scope !== "user") return true;
      try {
        if (Object.hasOwn(sdkUserMcpServers(deps.home), server)) return true;
        return otherNames(cwd).has(server);
      } catch { return false; }
    },
    noteWritten: (next) => { written = { basis: deps.settings(), table: connectorPermissionTable(next) }; },
    scopeFor,
  };
}
