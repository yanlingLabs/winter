// WS-27 — WHICH MCP SERVER NAMES EXIST OUTSIDE THE THREE CONFIG SCOPES, read synchronously off disk for the
// connector permissions (`connector-permissions.ts`): the servers enabled plugins ship, and the servers a
// subagent definition declares inline. Three readers use them:
//  - `connector-source.ts`'s `configured()` — a name one of these defines may be the server an ambiguous
//    `mcp__a__b__c` call goes to, so it votes the default (never skipped);
//  - `mcp.list`/`mcp.tools` (`ipc/server.ts`) — an inline subagent server gets a row, so its values can be
//    listed and set under its config name;
//  - `mcpServerNameDefined` below — `mcp.remove`/`mcp.rename` keep a name's stored permissions while anything
//    still defines a server of that name (permissions are keyed by name across scopes).
//
// PLUGINS, as the runtime's own loader finds them (`resolveEnabledPlugins`, `collectMcpServers`): every
// `installed_plugins.json` record at every scope, enabled or not (a deliberate SUPERSET — an extra name only
// ever makes an ambiguous split ask, the conservative direction), plus every ENABLED key with no install
// record that a DIRECTORY marketplace in `known_marketplaces.json` resolves — from the user's
// `sdk/settings.json` and, for a trusted project, its `.winter/settings.json` and `.winter/settings.local.json`
// (the files `plugin.enable --scope project|local` writes). The marketplace source is resolved with the SDK's
// own `resolveMarketplacePluginPath` (it refuses a source that escapes the marketplace), and a plugin's names
// are the first of `.mcp.json`/`mcp.json` (its `mcpServers` block or the bare map) plus its manifest's.
//
// SUBAGENT DEFINITIONS: `agents/*.md` frontmatter `mcpServers` — claude's list of server-name references and
// `{ <name>: <config> }` objects; only the objects declare a server (a string names one the session already
// has). From the user tier (`<home>/sdk/agents`, and `<home>/agents` when it is a directory of its own), a
// trusted project's `.winter/agents` (at its project root, and at the cwd when that differs) and each plugin's
// `agents/`. The name is the CONFIG name: a clash inside a session renames the server (`cf` → `cf_2`), and
// the runtime states the config name beside each call (`winter_mcp_server.config_name`), which is what the
// stored values are keyed by. NOTE: agent SDK 0.0.32's own file parser does not read `mcpServers` from an
// agent file yet (only a programmatic definition carries them), so these rows anticipate the runtime.
//
// Never throws: an unreadable file or directory is simply not there.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { resolveMarketplacePluginPath } from "@yanlinglabs/winter-agent-sdk";
import { sdkEnabledPlugins, sdkLocalMcpServers, sdkUserMcpServers } from "../../settings";
import { readSdkGlobalConfig } from "../../sdk-files";
import { sdkHomeFor, sdkPluginsRoot } from "../paths";
import { readRawProjectMcpConfig } from "./project-file";
import { projectScopeRootFor, projectScopeTrusted } from "../../runtime-sdk/run-home-input";
import type { TrustStore } from "../trust";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * The project roots whose project-scope files count: the cwd's own project root when it is trusted (`cwd`),
 * and — for `allTrusted` — every root the trust store lists (a project-scope server only ever loads in a
 * trusted project, so these are every project whose server can be one).
 */
export function trustedProjectRoots(opts: { cwd?: string | undefined; trust?: Pick<TrustStore, "isTrusted" | "list"> | undefined; allTrusted?: boolean }): string[] {
  const roots = new Set<string>();
  const { cwd, trust } = opts;
  if (trust === undefined) return [];
  if (cwd !== undefined && cwd !== "") {
    try { if (projectScopeTrusted(cwd, trust)) roots.add(canonical(projectScopeRootFor(cwd))); } catch { /* not a project */ }
  }
  if (opts.allTrusted === true) for (const dir of trust.list()) roots.add(canonical(dir));
  return [...roots];
}

/** Every plugin directory whose servers a session could load (this file's header). */
export function pluginInstallPaths(home: string, projectRoots: readonly string[] = []): string[] {
  const out = new Set<string>();
  const root = sdkPluginsRoot(home);
  const installed = readJsonObject(join(root, "installed_plugins.json"))?.["plugins"];
  const installedIds = new Set<string>();
  if (isObject(installed)) {
    for (const [id, entries] of Object.entries(installed)) {
      installedIds.add(id);
      if (!Array.isArray(entries)) continue;
      for (const e of entries) if (isObject(e) && typeof e["installPath"] === "string" && e["installPath"] !== "") out.add(e["installPath"]);
    }
  }
  const enabled = new Set<string>();
  const addEnabled = (map: unknown): void => {
    if (!isObject(map)) return;
    for (const [key, on] of Object.entries(map)) if (on === true) enabled.add(key);
  };
  try { addEnabled(sdkEnabledPlugins(home)); } catch { /* unreadable: none */ }
  for (const project of projectRoots) {
    addEnabled(readJsonObject(join(project, ".winter", "settings.json"))?.["enabledPlugins"]);
    addEnabled(readJsonObject(join(project, ".winter", "settings.local.json"))?.["enabledPlugins"]);
  }
  let marketplaces: Record<string, unknown> | undefined;
  for (const key of enabled) {
    if (installedIds.has(key)) continue;
    const at = key.lastIndexOf("@");
    if (at <= 0 || at === key.length - 1) continue;
    marketplaces ??= readJsonObject(join(root, "known_marketplaces.json")) ?? {};
    const rec = marketplaces[key.slice(at + 1)];
    if (!isObject(rec) || !isObject(rec["source"]) || rec["source"]["source"] !== "directory" || typeof rec["installLocation"] !== "string") continue;
    const location = rec["installLocation"];
    const manifest = readJsonObject(join(location, ".claude-plugin", "marketplace.json"));
    const entry = Array.isArray(manifest?.["plugins"]) ? (manifest!["plugins"] as unknown[]).find((p) => isObject(p) && p["name"] === key.slice(0, at)) : undefined;
    if (!isObject(entry)) continue;
    const metadata = isObject(manifest!["metadata"]) ? manifest!["metadata"] : undefined;
    try {
      const path = resolveMarketplacePluginPath(location, metadata?.["pluginRoot"], entry["source"]);
      if (path !== undefined) out.add(path);
    } catch { /* a refused source: not loaded by the runtime either */ }
  }
  return [...out];
}

/** The MCP server names the plugins at these paths ship (this file's header). */
function pluginServerNamesAt(paths: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const installPath of paths) {
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
  }
  return names;
}

/** The MCP server names plugins ship — for a session at `projectRoots` (the trusted project's own enabled keys count). */
export function pluginMcpServerNames(home: string, projectRoots: readonly string[] = []): ReadonlySet<string> {
  return pluginServerNamesAt(pluginInstallPaths(home, projectRoots));
}

export type AgentInlineScope = "user" | "project" | "plugin";
export interface AgentInlineMcpServer {
  /** The server's CONFIG name — the key its definition gives it. */
  name: string;
  scope: AgentInlineScope;
  /** The agent definition file that declares it. */
  file: string;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** The inline server names one agent file's frontmatter declares (`mcpServers` object entries). */
export function agentFileInlineServerNames(raw: string): string[] {
  const match = FRONTMATTER.exec(raw);
  if (match === null) return [];
  let attrs: unknown;
  try { attrs = Bun.YAML.parse(match[1] ?? ""); } catch { return []; }
  if (!isObject(attrs)) return [];
  const declared = attrs["mcpServers"];
  const names: string[] = [];
  if (Array.isArray(declared)) {
    for (const spec of declared) if (isObject(spec)) names.push(...Object.keys(spec));
  } else if (isObject(declared)) {
    names.push(...Object.keys(declared));   // a bare name → config map: read leniently, like a plugin's `.mcp.json`
  }
  return names.filter((n) => n !== "");
}

function agentDirServers(dir: string, scope: AgentInlineScope, out: AgentInlineMcpServer[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const file = join(dir, entry);
    try {
      if (!statSync(file).isFile()) continue;
      for (const name of agentFileInlineServerNames(readFileSync(file, "utf8"))) out.push({ name, scope, file });
    } catch { /* unreadable: not there */ }
  }
}

/**
 * Every inline MCP server a subagent definition declares — the user tier, the given (trusted) project roots
 * (plus `cwd`'s own `.winter/agents` when it is inside one of them and differs) and the plugins those roots
 * enable (this file's header).
 */
export function agentInlineMcpServers(home: string, projectRoots: readonly string[] = [], cwd?: string): AgentInlineMcpServer[] {
  const out: AgentInlineMcpServer[] = [];
  const seen = new Set<string>();
  const dir = (path: string, scope: AgentInlineScope): void => {
    const key = canonical(path);
    if (seen.has(key)) return;
    seen.add(key);
    agentDirServers(path, scope, out);
  };
  dir(join(sdkHomeFor(home), "agents"), "user");
  dir(join(home, "agents"), "user");
  for (const root of projectRoots) dir(join(root, ".winter", "agents"), "project");
  if (cwd !== undefined && cwd !== "" && projectRoots.some((r) => canonical(cwd).startsWith(r.endsWith(sep) ? r : r + sep))) dir(join(cwd, ".winter", "agents"), "project");
  for (const plugin of pluginInstallPaths(home, projectRoots)) dir(join(plugin, "agents"), "plugin");
  return out;
}

/**
 * Does anything still define an MCP server named `name` — the user scope, ANY project's local scope, the
 * `.winter/mcp.json` of the cwd's trusted project or of any trusted project, a plugin, or a subagent
 * definition? `mcp.remove`/`mcp.rename` keep the name's connector permissions while it does. Unreadable
 * files count as "not defined there" — except `sdk/.winter.json`, which a remove has just rewritten.
 */
export function mcpServerNameDefined(home: string, name: string, opts: { cwd?: string | undefined; trust?: Pick<TrustStore, "isTrusted" | "list"> | undefined } = {}): boolean {
  try { if (Object.hasOwn(sdkUserMcpServers(home), name)) return true; } catch { /* unreadable */ }
  try {
    const projects = readSdkGlobalConfig(home).projects ?? {};
    for (const key of Object.keys(projects)) if (Object.hasOwn(sdkLocalMcpServers(home, key), name)) return true;
  } catch { /* unreadable */ }
  const roots = trustedProjectRoots({ cwd: opts.cwd, trust: opts.trust, allTrusted: true });
  for (const root of roots) {
    const read = readRawProjectMcpConfig(root);
    if (read.kind === "ok" && Object.hasOwn(read.servers, name)) return true;
  }
  if (pluginMcpServerNames(home, roots).has(name)) return true;
  return agentInlineMcpServers(home, roots, opts.cwd).some((s) => s.name === name);
}
