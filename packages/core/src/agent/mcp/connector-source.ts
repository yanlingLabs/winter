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
// settings as the user's `cf`. And a SUBAGENT definition's own inline `mcpServers` entry that collides with
// a session server is renamed by the runtime inside the child (`<name>_2`, its `allocateChildScopedServers`);
// the hook sees only the renamed tool (`mcp__cf_2__…`) and the daemon cannot see the mapping, so such an
// action takes the stored values of `cf_2`, if any — none, ordinarily: it gets the default (toward ask).
// A subagent's inline server is also invisible to `configured` (agent definitions are the runtime's to
// resolve, per subagent): an inline `cf__prod` weighs in an ambiguous `__` split only once stored or
// listed — and it is never listed, since the daemon never probes one.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectorPermissionTable, sdkEnabledPlugins, sdkLocalMcpServers, sdkUserMcpServers, type Settings } from "../../settings";
import { sdkPluginsRoot } from "../paths";
import { localScopeKeyFor, projectScopeRootFor, projectScopeTrusted } from "../../runtime-sdk/run-home-input";

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
/** How long a read of the plugins' server names is reused (a handful of small files per read). */
const PLUGIN_NAMES_TTL_MS = 5_000;

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The MCP server names plugins ship (final review), read SYNCHRONOUSLY the way the runtime's own plugin
 * loader reads them (`collectMcpServers`: the first of `.mcp.json`/`mcp.json` in the plugin root —
 * its `mcpServers` block or the bare map — plus the manifest's `mcpServers` object), from:
 *  - every plugin in `<home>/sdk/plugins/installed_plugins.json`, at every scope, ENABLED OR NOT — a
 *    deliberate SUPERSET: enablement is per scope and per project, and an extra name only ever makes an
 *    ambiguous `__` split ask instead of being skipped (the conservative direction);
 *  - the user scope's enabled keys a directory marketplace resolves (`known_marketplaces.json`), which the
 *    runtime loads without an install record.
 * A project- or local-scope enabled key of a NOT-installed directory-marketplace plugin is not seen (such a
 * name is weighed only when stored or listed). Never throws.
 */
export function pluginMcpServerNames(home: string): ReadonlySet<string> {
  const names = new Set<string>();
  const root = sdkPluginsRoot(home);
  const addFrom = (installPath: string): void => {
    for (const file of [".mcp.json", "mcp.json"]) {
      const parsed = readJsonObject(join(installPath, file));
      if (parsed === undefined) continue;
      const block = isObject(parsed["mcpServers"]) ? parsed["mcpServers"] : parsed;
      for (const name of Object.keys(block)) names.add(name);
      break;
    }
    for (const manifest of [join(installPath, ".claude-plugin", "plugin.json"), join(installPath, "plugin.json")]) {
      const declared = readJsonObject(manifest)?.["mcpServers"];
      if (isObject(declared)) for (const name of Object.keys(declared)) names.add(name);
    }
  };
  const installed = readJsonObject(join(root, "installed_plugins.json"))?.["plugins"];
  const installedIds = new Set<string>();
  if (isObject(installed)) {
    for (const [id, entries] of Object.entries(installed)) {
      installedIds.add(id);
      if (!Array.isArray(entries)) continue;
      for (const e of entries) if (isObject(e) && typeof e["installPath"] === "string" && e["installPath"] !== "") addFrom(e["installPath"]);
    }
  }
  let marketplaces: Record<string, unknown> | undefined;
  for (const [key, on] of Object.entries(sdkEnabledPlugins(home))) {
    if (!on || installedIds.has(key)) continue;
    const at = key.lastIndexOf("@");
    if (at <= 0 || at === key.length - 1) continue;
    marketplaces ??= readJsonObject(join(root, "known_marketplaces.json")) ?? {};
    const rec = marketplaces[key.slice(at + 1)];
    if (!isObject(rec) || !isObject(rec["source"]) || rec["source"]["source"] !== "directory" || typeof rec["installLocation"] !== "string") continue;
    const manifest = readJsonObject(join(rec["installLocation"], ".claude-plugin", "marketplace.json"));
    const entry = Array.isArray(manifest?.["plugins"]) ? (manifest!["plugins"] as unknown[]).find((p) => isObject(p) && p["name"] === key.slice(0, at)) : undefined;
    const source = isObject(entry) ? entry["source"] : undefined;
    // The common case, a relative directory source; anything else is left to the stored/listed rule.
    if (typeof source === "string") addFrom(join(rec["installLocation"], source));
  }
  return names;
}

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

  let pluginCache: { at: number; names: ReadonlySet<string> } | undefined;
  const pluginNames = (): ReadonlySet<string> => {
    const t = now();
    if (pluginCache === undefined || t - pluginCache.at > PLUGIN_NAMES_TTL_MS) pluginCache = { at: t, names: pluginMcpServerNames(deps.home) };
    return pluginCache.names;
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
    // Configured for this session: the local or trusted project scope defines it, the user scope does, or an
    // installed plugin ships it (`pluginMcpServerNames`).
    configured: (server, cwd) => {
      const scope = scopeFor(server, cwd);
      if (scope !== "user") return true;
      try {
        if (Object.hasOwn(sdkUserMcpServers(deps.home), server)) return true;
        return pluginNames().has(server);
      } catch { return false; }
    },
    noteWritten: (next) => { written = { basis: deps.settings(), table: connectorPermissionTable(next) }; },
    scopeFor,
  };
}
