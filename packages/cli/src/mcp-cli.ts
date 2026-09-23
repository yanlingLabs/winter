// Pure/isolatable logic behind `winter mcp add|add-json|remove|get` — CLI parity with
// `claude mcp add|add-json|remove|get` (reference clone: `src/commands/mcp/addCommand.ts`,
// `src/cli/handlers/mcp.tsx`, `src/services/mcp/utils.ts`). Split out of main.ts the same way
// `model-cli.ts`/`plugin-cli.ts` are: main.ts owns argv slicing + printing + `process.exit`; this
// file owns parsing, scope/transport validation, and the actual read-modify-write.
//
// WS-21 (spec §4.4, `winter mcp add` = `claude mcp add`): all three of claude's scopes, claude's
// names and claude's default —
//   local    (the DEFAULT, as in claude)  sdk/.winter.json -> projects[<abs project root>].mcpServers
//   user                                  sdk/.winter.json -> mcpServers
//   project                               <project root>/.winter/mcp.json (claude's .mcp.json
//                                         format; loaded only when the project is trusted; the
//                                         repo-root .mcp.json is no longer read at all)
//
// DOOR VS. DIRECT: `user` scope's write goes through the daemon when it's live (`mcp.add`/
// `mcp.remove` RPC, already wired to sdk/.winter.json — protocol/methods.ts's own header) and
// directly through Contract C's `addSdkUserMcpServer`/`removeSdkUserMcpServer` when it's not — the
// SAME validated-write functions the daemon's own RPC handler calls, so the two paths can never
// accept a write the other would refuse.
//
// `local` and `project` are ALWAYS direct, never routed through the door, on THIS branch:
//   - `local`'s daemon-side RPC handler still refuses the scope typed (protocol/methods.ts's own
//     doc: "Local and project MCP scopes are refused typed until L3.5" — a FUTURE daemon-side task,
//     not this lane's). `sdk/.winter.json` is a plain, atomically-written file the daemon's own
//     SdkFilesWatcher picks up live regardless of who writes it (the "no daemon restart for
//     settings" hard rule) — writing it directly works today and needs no daemon coordination, the
//     same reasoning `user` scope's own no-daemon fallback already relies on.
//   - `local`-scope servers are, unlike `user`-scope ones, never a live in-daemon connection to
//     begin with — they're folded into a run folder's `.winter.json` at spawn time by the ROUTER
//     (spec §3.4.5), not started/managed by the daemon's own `McpManager` the way `user` servers
//     are. There is no "hot-start" a door call could buy that a direct write doesn't already give.
//   - `project` has always been direct (this file's own precedent, pre-WS-21): `.winter/mcp.json`
//     isn't daemon state either — no watcher, no settings-schema validation, just a project file the
//     router reads live off disk when trusted (spec §3.4.5).
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  addSdkUserMcpServer, removeSdkUserMcpServer, sdkUserMcpServers, sdkLocalMcpServers,
  readSdkGlobalConfig, updateSdkGlobalConfig, sdkGlobalConfigPath, validateMcpServerEntryForWrite, validateMcpServerName,
  parseProjectMcpServers, TrustStore,
  stripCredentialShapedMcpHeaders, readRawSettings,
  localScopeKeyFor,
  type McpServerSettingsEntry, type ProjectMcpServerEntry,
} from "@yanlinglabs/winter-core";
import { McpAddEntrySchema } from "@yanlinglabs/winter-protocol";

export type McpScope = "local" | "user" | "project";
export type McpTransport = "stdio" | "http" | "sse";

/** Structural — matches exactly the three `WinterClient` methods this file calls, so a test can
 *  hand in a plain fake instead of a real socket connection. USER scope only (see this file's own
 *  header for why `local`/`project` never reach this door on this branch). */
export interface McpDoor {
  mcpAdd(name: string, entry: McpServerSettingsEntry): Promise<{ ok: true; name: string; transport: McpTransport; started: boolean }>;
  mcpRemove(name: string): Promise<{ ok: true; name: string; removed: boolean }>;
  mcpGet(name: string): Promise<{
    ok: true; name: string; found: boolean; transport?: McpTransport;
    command?: string; args?: string[]; env?: Record<string, string>;
    url?: string; headers?: Record<string, string>; disabled?: boolean; strippedHeaders?: string[];
  }>;
}

export interface McpRouteDeps {
  cwd: string;
  winterHome: string;
  /** `undefined` when no daemon answered — the USER-scope route falls back to a direct, in-process
   *  write; `local`/`project` never use this at all (see this file's own header). */
  door?: McpDoor;
}

// ------------------------------------------------------------------------------------------------
// Scope / transport / header / env parsing (pure, no I/O)
// ------------------------------------------------------------------------------------------------

export type ScopeResolution = { kind: "ok"; scope: McpScope } | { kind: "invalid"; message: string };

/** Default scope is "local" (claude's own default, WS-21). */
export function ensureMcpScope(raw?: string): ScopeResolution {
  if (!raw) return { kind: "ok", scope: "local" };
  if (raw === "local" || raw === "user" || raw === "project") return { kind: "ok", scope: raw };
  return { kind: "invalid", message: `invalid scope: ${raw}. Must be one of: local, user, project` };
}

export function ensureMcpTransport(raw?: string): { kind: "ok"; transport: McpTransport } | { kind: "invalid"; message: string } {
  if (!raw) return { kind: "ok", transport: "stdio" };
  if (raw === "stdio" || raw === "http" || raw === "sse") return { kind: "ok", transport: raw };
  return { kind: "invalid", message: `invalid transport type: ${raw}. Must be one of: stdio, sse, http` };
}

/** Mirrors claude's own `-H "Name: value"` parsing (`services/mcp/utils.ts`'s `parseHeaders`). */
export function parseMcpHeaders(headerArgs: string[]): { kind: "ok"; headers: Record<string, string> } | { kind: "invalid"; message: string } {
  const headers: Record<string, string> = {};
  for (const header of headerArgs) {
    const colonIndex = header.indexOf(":");
    if (colonIndex === -1) return { kind: "invalid", message: `Invalid header format: "${header}". Expected format: "Header-Name: value"` };
    const key = header.slice(0, colonIndex).trim();
    const value = header.slice(colonIndex + 1).trim();
    if (!key) return { kind: "invalid", message: `Invalid header: "${header}". Header name cannot be empty.` };
    headers[key] = value;
  }
  return { kind: "ok", headers };
}

/** Mirrors claude's own `-e KEY=value` parsing (`utils/envUtils.ts`'s `parseEnvVars`) — the value
 *  half may itself contain `=` (only the FIRST `=` splits). */
export function parseMcpEnv(envArgs: string[]): { kind: "ok"; env: Record<string, string> } | { kind: "invalid"; message: string } {
  const env: Record<string, string> = {};
  for (const raw of envArgs) {
    const eq = raw.indexOf("=");
    if (eq <= 0) return { kind: "invalid", message: `Invalid environment variable format: ${raw}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2` };
    env[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return { kind: "ok", env };
}

/** Mirrors claude's own "did you mean --transport http/sse" heuristic (`addCommand.ts`). */
export function looksLikeMcpUrl(commandOrUrl: string): boolean {
  return commandOrUrl.startsWith("http://") || commandOrUrl.startsWith("https://") || commandOrUrl.startsWith("localhost")
    || commandOrUrl.endsWith("/sse") || commandOrUrl.endsWith("/mcp");
}

// ------------------------------------------------------------------------------------------------
// `winter mcp add` argv parsing
// ------------------------------------------------------------------------------------------------

export interface McpAddParsed {
  name: string;
  commandOrUrl: string;
  trailingArgs: string[];
  scopeRaw?: string;
  transportRaw?: string;
  envArgs: string[];
  headerArgs: string[];
}
export type McpAddParseResult = { kind: "ok"; parsed: McpAddParsed } | { kind: "usageError"; message: string };

const ADD_USAGE = "usage: winter mcp add [-s local|user|project] [-t stdio|sse|http] [-e KEY=value...] [-H \"Name: value\"...] <name> <commandOrUrl> [-- args...]";

/** Flags may appear anywhere before the positionals; a bare `--` (commander's own convention, kept
 *  identical here) stops FLAG parsing only — positional consumption continues across it exactly as
 *  commander's `<name> <commandOrUrl> [args...]` would (`claude mcp add -e API_KEY=xxx my-server --
 *  npx my-mcp-server`: `npx` still fills `commandOrUrl`, only `my-mcp-server` is left over as an
 *  arg). Every token after `--` is a positional verbatim, even one that is flag-shaped
 *  (`--some-flag`) — that is the ENTIRE reason `--` exists: to stop THIS command's own flags from
 *  swallowing a token meant for the child command. `-e`/`-H` are repeatable single-value flags
 *  (`-e A=1 -e B=2`), matching every example in claude's own `addCommand.ts` doc comment — never a
 *  variadic `-e A=1 B=2`. */
export function parseMcpAddArgs(args: string[]): McpAddParseResult {
  let scopeRaw: string | undefined;
  let transportRaw: string | undefined;
  const envArgs: string[] = [];
  const headerArgs: string[] = [];
  const positionals: string[] = [];
  let afterSeparator = false;

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (!afterSeparator && tok === "--") { afterSeparator = true; continue; }
    if (!afterSeparator) {
      if (tok === "-s" || tok === "--scope") { scopeRaw = args[++i]; continue; }
      if (tok === "-t" || tok === "--transport") { transportRaw = args[++i]; continue; }
      if (tok === "-e" || tok === "--env") { const v = args[++i]; if (v !== undefined) envArgs.push(v); continue; }
      if (tok === "-H" || tok === "--header") { const v = args[++i]; if (v !== undefined) headerArgs.push(v); continue; }
    }
    positionals.push(tok);
  }

  const name = positionals[0];
  const commandOrUrl = positionals[1];
  if (!name) return { kind: "usageError", message: `Error: Server name is required.\n${ADD_USAGE}` };
  if (!commandOrUrl) return { kind: "usageError", message: `Error: Command is required when server name is provided.\n${ADD_USAGE}` };
  const trailingArgs = positionals.slice(2);
  return { kind: "ok", parsed: { name, commandOrUrl, trailingArgs, scopeRaw, transportRaw, envArgs, headerArgs } };
}

// ------------------------------------------------------------------------------------------------
// `winter mcp add-json` argv parsing
// ------------------------------------------------------------------------------------------------

export interface McpAddJsonParsed { name: string; json: string; scopeRaw?: string }
export type McpAddJsonParseResult = { kind: "ok"; parsed: McpAddJsonParsed } | { kind: "usageError"; message: string };

const ADD_JSON_USAGE = "usage: winter mcp add-json [-s local|user|project] <name> <json>";

export function parseMcpAddJsonArgs(args: string[]): McpAddJsonParseResult {
  let scopeRaw: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "-s" || tok === "--scope") { scopeRaw = args[++i]; continue; }
    positionals.push(tok);
  }
  const name = positionals[0];
  const json = positionals[1];
  if (!name || json === undefined) return { kind: "usageError", message: ADD_JSON_USAGE };
  return { kind: "ok", parsed: { name, json, scopeRaw } };
}

// ------------------------------------------------------------------------------------------------
// `winter mcp remove` / `winter mcp get` argv parsing
// ------------------------------------------------------------------------------------------------

export interface McpRemoveParsed { name: string; scopeRaw?: string }
export type McpRemoveParseResult = { kind: "ok"; parsed: McpRemoveParsed } | { kind: "usageError"; message: string };

export function parseMcpRemoveArgs(args: string[]): McpRemoveParseResult {
  let scopeRaw: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "-s" || tok === "--scope") { scopeRaw = args[++i]; continue; }
    positionals.push(tok);
  }
  const name = positionals[0];
  if (!name) return { kind: "usageError", message: "usage: winter mcp remove <name> [-s local|user|project]" };
  return { kind: "ok", parsed: { name, scopeRaw } };
}

export function parseMcpGetArgs(args: string[]): { kind: "ok"; name: string } | { kind: "usageError"; message: string } {
  const name = args[0];
  if (!name) return { kind: "usageError", message: "usage: winter mcp get <name>" };
  return { kind: "ok", name };
}

// ------------------------------------------------------------------------------------------------
// Entry-building (pure)
// ------------------------------------------------------------------------------------------------

export type McpEntryBuildResult = { kind: "ok"; entry: McpServerSettingsEntry } | { kind: "error"; message: string };

/** Builds the entry `winter mcp add`'s flags describe, validating just enough to give a specific
 *  error (a URL required for http/sse, `-e`/`-H` used on the wrong transport) — mirrors
 *  `addCommand.ts`'s own per-transport branching. Does NOT check project scope's stdio-only WRITE
 *  rule (a narrower choice of the write door, not of what the file format accepts — see this file's
 *  own header); that's the route's job (it knows the scope, this function doesn't need to). */
export function buildMcpEntry(parsed: McpAddParsed, transport: McpTransport): McpEntryBuildResult {
  if (transport === "http" || transport === "sse") {
    const headersR = parseMcpHeaders(parsed.headerArgs);
    if (headersR.kind === "invalid") return { kind: "error", message: headersR.message };
    return { kind: "ok", entry: { type: transport, url: parsed.commandOrUrl, ...(Object.keys(headersR.headers).length > 0 ? { headers: headersR.headers } : {}) } };
  }
  const envR = parseMcpEnv(parsed.envArgs);
  if (envR.kind === "invalid") return { kind: "error", message: envR.message };
  return {
    kind: "ok",
    entry: {
      type: "stdio", command: parsed.commandOrUrl,
      ...(parsed.trailingArgs.length > 0 ? { args: parsed.trailingArgs } : {}),
      ...(Object.keys(envR.env).length > 0 ? { env: envR.env } : {}),
    },
  };
}

/** claude's own stdio branch warns (never refuses) when an OAuth-only flag was given on stdio
 *  (`addCommand.ts:240-249`, reference clone) — same idea here for `-H`/`-e` on the WRONG
 *  transport: `buildMcpEntry` only ever reads `headerArgs` for http/sse and `envArgs` for stdio, so
 *  the other one is silently dropped with NO signal at all otherwise — a user who typed `-H
 *  "Authorization: …"` on a stdio add would have no way to know it never reached the entry. */
function wrongTransportFlagWarnings(parsed: McpAddParsed, transport: McpTransport): string[] {
  const warnings: string[] = [];
  if (transport === "stdio" && parsed.headerArgs.length > 0) {
    warnings.push("-H/--header is only used for http/sse servers and was ignored for this stdio entry");
  }
  if (transport !== "stdio" && parsed.envArgs.length > 0) {
    warnings.push(`-e/--env is only used for stdio servers and was ignored for this ${transport} entry`);
  }
  return warnings;
}

// ------------------------------------------------------------------------------------------------
// sdk/.winter.json LOCAL scope (projects[<root>].mcpServers) — always direct, see this file's own
// header. No Contract C writer exists for this yet (only the `user`-scope one, `mcp-write.ts`'s
// `addSdkUserMcpServer`/`removeSdkUserMcpServer`), so this file carries its own — the SAME
// validation (`validateMcpServerName`/`validateMcpServerEntryForWrite`) and the SAME
// read-modify-write door (`updateSdkGlobalConfig`) Contract C's own writer uses.
// ------------------------------------------------------------------------------------------------

function addSdkLocalMcpServer(home: string, root: string, name: string, entry: unknown): McpServerSettingsEntry {
  const nameErr = validateMcpServerName(name);
  if (nameErr) throw new Error(nameErr);
  const valid = validateMcpServerEntryForWrite(entry);
  updateSdkGlobalConfig(home, (config) => {
    const projects = { ...(config.projects ?? {}) };
    const existing = projects[root] ?? {};
    const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
    if (Object.hasOwn(servers, name)) {
      throw new Error(`MCP server "${name}" already exists in local config for ${root} — remove it first ("winter mcp remove ${name} --scope local") or edit sdk/.winter.json directly`);
    }
    projects[root] = { ...existing, mcpServers: { ...servers, [name]: valid } };
    return { ...config, projects };
  });
  return valid;
}

function removeSdkLocalMcpServer(home: string, root: string, name: string): boolean {
  const current = readSdkGlobalConfig(home);
  const currentServers = current.projects?.[root]?.mcpServers as Record<string, unknown> | undefined;
  if (!currentServers || !Object.hasOwn(currentServers, name)) return false;
  let removed = false;
  updateSdkGlobalConfig(home, (config) => {
    const projects = { ...(config.projects ?? {}) };
    const existing = projects[root];
    const servers = existing?.mcpServers as Record<string, unknown> | undefined;
    if (!existing || !servers || !Object.hasOwn(servers, name)) return config;
    removed = true;
    const rest = { ...servers };
    delete rest[name];
    projects[root] = { ...existing, mcpServers: rest };
    return { ...config, projects };
  });
  return removed;
}

function sdkLocalServer(home: string, root: string, name: string): McpServerSettingsEntry | undefined {
  const servers = readSdkGlobalConfig(home).projects?.[root]?.mcpServers as Record<string, McpServerSettingsEntry> | undefined;
  return servers?.[name];
}

// ------------------------------------------------------------------------------------------------
// <root>/.winter/mcp.json PROJECT scope — claude's `.mcp.json` shape, at the WINTER-named path
// (spec §4.4: "the repo-root .mcp.json is no longer read at all"). Reuses `parseProjectMcpServers`
// (the per-entry validator — a pure function of the parsed JSON, not tied to any path) but never
// `agent/mcp/project-file.ts`'s own path/read/write helpers, which are hardcoded to `.mcp.json`.
// ------------------------------------------------------------------------------------------------

export function winterMcpConfigPath(root: string): string {
  return join(root, ".winter", "mcp.json");
}

type RawWinterMcpConfig =
  | { kind: "absent" }
  | { kind: "malformed" }
  | { kind: "ok"; raw: Record<string, unknown>; servers: Record<string, unknown> };

function readRawWinterMcpConfig(root: string): RawWinterMcpConfig {
  const path = winterMcpConfigPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "malformed" };
  const raw = parsed as Record<string, unknown>;
  const servers = typeof raw.mcpServers === "object" && raw.mcpServers !== null && !Array.isArray(raw.mcpServers)
    ? (raw.mcpServers as Record<string, unknown>)
    : {};
  return { kind: "ok", raw, servers };
}

/** Atomic write: temp file beside the target, then rename — same discipline
 *  `agent/mcp/project-file.ts`'s own `.mcp.json` writer uses, for the same reason (a team-shared
 *  file another process/editor may read mid-write). */
function writeRawWinterMcpConfig(root: string, raw: Record<string, unknown>, servers: Record<string, unknown>): void {
  const path = winterMcpConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const next = { ...raw, mcpServers: servers };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
}

function addProjectMcpServer(servers: Record<string, unknown>, name: string, entry: ProjectMcpServerEntry): Record<string, unknown> {
  const nameErr = validateMcpServerName(name);
  if (nameErr) throw new Error(nameErr);
  if (Object.hasOwn(servers, name)) {
    throw new Error(`MCP server "${name}" already exists in project config — remove it first ("winter mcp remove ${name} --scope project") or edit .winter/mcp.json directly`);
  }
  return { ...servers, [name]: entry };
}

function removeProjectMcpServerEntry(servers: Record<string, unknown>, name: string): { servers: Record<string, unknown>; removed: boolean } {
  if (!Object.hasOwn(servers, name)) return { servers, removed: false };
  const next = { ...servers };
  delete next[name];
  return { servers: next, removed: true };
}

// ------------------------------------------------------------------------------------------------
// Route functions — the full round trip (I/O via the injected door and `@yanlinglabs/winter-core`),
// returning a plain outcome object. Nothing here prints or exits; `main.ts`'s `case "mcp"` does.
// ------------------------------------------------------------------------------------------------

export type McpAddOutcome =
  | { ok: true; scope: "user"; name: string; transport: McpTransport; via: "daemon" | "local"; started?: boolean; warning?: string }
  | { ok: true; scope: "local"; name: string; transport: McpTransport; root: string; warning?: string }
  | { ok: true; scope: "project"; name: string; transport: "stdio"; cwd: string; trusted: boolean; warning?: string }
  | { ok: false; message: string };

function isTrustedDir(winterHome: string, dir: string): boolean {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* the trust store falls back to the given path too */ }
  return new TrustStore(join(winterHome, "trust.json")).isTrusted(real);
}

// Post-merge round: `projectRootFor` (a plain `realpathSync(cwd)`, no git awareness — this file's own
// prior stand-in, DECISION 6 in the lane report) retired in favor of core's own `localScopeKeyFor`
// (`runtime-sdk/run-home-input.ts`) — the SAME canonical-git-root rule (F17) every daemon-side reader
// and writer of the local MCP scope already uses, so a CLI write and a daemon read of the identical
// project can never land under two different keys. Falls back to `realpathSync(cwd)` outside a git
// repository, matching this file's old behavior exactly in that case.

async function addUserScope(deps: McpRouteDeps, name: string, entry: McpServerSettingsEntry, transport: McpTransport): Promise<McpAddOutcome> {
  if (deps.door) {
    try {
      const r = await deps.door.mcpAdd(name, entry);
      return { ok: true, scope: "user", name: r.name, transport: r.transport, via: "daemon", started: r.started };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
  try {
    addSdkUserMcpServer(deps.winterHome, name, entry);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  return { ok: true, scope: "user", name, transport, via: "local" };
}

function addLocalScope(deps: McpRouteDeps, name: string, entry: McpServerSettingsEntry, transport: McpTransport): McpAddOutcome {
  const root = localScopeKeyFor(deps.cwd);
  try {
    addSdkLocalMcpServer(deps.winterHome, root, name, entry);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  return { ok: true, scope: "local", name, transport, root };
}

/** A message shared by every project-scope write that finds `.winter/mcp.json` unreadable —
 *  REFUSES rather than silently replaces it: this file has no watcher/keep-last-good the way
 *  settings.json does, so "degrade to empty and write anyway" would delete every server a human or
 *  claude configured there. */
function malformedProjectFileMessage(cwd: string, verb: string): string {
  return `${winterMcpConfigPath(cwd)} is not valid JSON — fix it before ${verb} (Winter refuses to overwrite a project file it cannot parse)`;
}

function addProjectScope(deps: McpRouteDeps, name: string, entry: ProjectMcpServerEntry): McpAddOutcome {
  const root = localScopeKeyFor(deps.cwd);
  const read = readRawWinterMcpConfig(root);
  if (read.kind === "malformed") return { ok: false, message: malformedProjectFileMessage(root, `adding "${name}"`) };
  const servers = read.kind === "ok" ? read.servers : {};
  let next: Record<string, unknown>;
  try {
    next = addProjectMcpServer(servers, name, entry);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  writeRawWinterMcpConfig(root, read.kind === "ok" ? read.raw : {}, next);
  return { ok: true, scope: "project", name, transport: "stdio", cwd: root, trusted: isTrustedDir(deps.winterHome, root) };
}

/** `winter mcp add` — the full route. Refuses `--transport http|sse` at PROJECT scope: not because
 *  the reader can't handle it any more (it accepts http/sse too, per-entry — this file's own
 *  header), but because THIS write door hasn't been asked to grow a new transport; use `-s user`
 *  or `-s local`, or hand-edit `.winter/mcp.json` directly for a project-scope http/sse entry.
 *  LOCAL scope has the same restriction, same reasoning. */
export async function runMcpAddRoute(args: string[], deps: McpRouteDeps): Promise<McpAddOutcome> {
  const parseResult = parseMcpAddArgs(args);
  if (parseResult.kind === "usageError") return { ok: false, message: parseResult.message };
  const { parsed } = parseResult;

  const scopeResult = ensureMcpScope(parsed.scopeRaw);
  if (scopeResult.kind !== "ok") return { ok: false, message: scopeResult.message };

  const transportResult = ensureMcpTransport(parsed.transportRaw);
  if (transportResult.kind !== "ok") return { ok: false, message: transportResult.message };
  const { transport } = transportResult;

  if ((scopeResult.scope === "project" || scopeResult.scope === "local") && transport !== "stdio") {
    return { ok: false, message: `winter mcp add --scope ${scopeResult.scope} only writes a stdio entry today — use "-s user" to add an http/sse server, or edit ${scopeResult.scope === "project" ? ".winter/mcp.json" : "sdk/.winter.json"} directly for one at this scope` };
  }

  const entryResult = buildMcpEntry(parsed, transport);
  if (entryResult.kind === "error") return { ok: false, message: entryResult.message };

  // Mirrors claude's own "did you mean --transport http/sse" heuristic (`addCommand.ts`): only
  // when the transport was NOT given explicitly — an explicit `-t stdio` on a URL-shaped command is
  // the user's own deliberate choice, never second-guessed. Combined with the wrong-transport-flag
  // warnings above (`-H` on stdio, `-e` on http/sse) — either, both, or neither may fire.
  const warnings = [
    ...(parsed.transportRaw === undefined && looksLikeMcpUrl(parsed.commandOrUrl)
      ? [`the command "${parsed.commandOrUrl}" looks like a URL, but is being added as a stdio server because --transport was not specified — for an http server use "-t http", for sse use "-t sse"`]
      : []),
    ...wrongTransportFlagWarnings(parsed, transport),
  ];
  const warning = warnings.length > 0 ? warnings.join("\n") : undefined;

  let outcome: McpAddOutcome;
  if (scopeResult.scope === "project") {
    const stdioEntry = entryResult.entry as Extract<McpServerSettingsEntry, { type: "stdio" }>;
    outcome = addProjectScope(deps, parsed.name, { command: stdioEntry.command, ...(stdioEntry.args ? { args: stdioEntry.args } : {}), ...(stdioEntry.env ? { env: stdioEntry.env } : {}) });
  } else if (scopeResult.scope === "local") {
    outcome = addLocalScope(deps, parsed.name, entryResult.entry, transport);
  } else {
    outcome = await addUserScope(deps, parsed.name, entryResult.entry, transport);
  }
  return outcome.ok && warning ? { ...outcome, warning } : outcome;
}

/** `winter mcp add-json` — validates the JSON's SHAPE against the same wire schema `mcp.add`'s RPC
 *  params use (`McpAddEntrySchema`, `@yanlinglabs/winter-protocol`) before ever reaching a scope's
 *  write door, mirroring claude's own `McpServerConfigSchema().safeParse(config)` gate. */
export async function runMcpAddJsonRoute(args: string[], deps: McpRouteDeps): Promise<McpAddOutcome> {
  const parseResult = parseMcpAddJsonArgs(args);
  if (parseResult.kind === "usageError") return { ok: false, message: parseResult.message };
  const { parsed } = parseResult;

  const scopeResult = ensureMcpScope(parsed.scopeRaw);
  if (scopeResult.kind !== "ok") return { ok: false, message: scopeResult.message };

  let json: unknown;
  try {
    json = JSON.parse(parsed.json);
  } catch (err) {
    return { ok: false, message: `Invalid JSON: ${(err as Error).message}` };
  }
  // A pre-item-3b entry (no `type` field at all) is stdio — the same normalization
  // `settings.ts`'s own `McpServerSettingsEntry` preprocess applies to a settings.json entry, and
  // claude's own `.mcp.json`/`add`/`add-json` shapes have never required a `type` key on a stdio
  // entry either (`addCommand.ts`'s own stdio branch never writes one). Applied BEFORE the
  // discriminated-union parse below, since that union requires an explicit literal on every branch.
  if (json && typeof json === "object" && !Array.isArray(json) && !("type" in json) && "command" in json) {
    json = { ...(json as object), type: "stdio" };
  }
  const shaped = McpAddEntrySchema.safeParse(json);
  if (!shaped.success) {
    const formatted = shaped.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    return { ok: false, message: `Invalid configuration: ${formatted}` };
  }

  if ((scopeResult.scope === "project" || scopeResult.scope === "local") && shaped.data.type !== "stdio") {
    return { ok: false, message: `winter mcp add --scope ${scopeResult.scope} only writes a stdio entry today — use "-s user" to add an http/sse server, or edit ${scopeResult.scope === "project" ? ".winter/mcp.json" : "sdk/.winter.json"} directly for one at this scope` };
  }
  if (scopeResult.scope === "project") {
    const e = shaped.data as Extract<McpServerSettingsEntry, { type: "stdio" }>;
    return addProjectScope(deps, parsed.name, { command: e.command, ...(e.args ? { args: e.args } : {}), ...(e.env ? { env: e.env } : {}) });
  }
  if (scopeResult.scope === "local") {
    return addLocalScope(deps, parsed.name, shaped.data, shaped.data.type);
  }
  return addUserScope(deps, parsed.name, shaped.data, shaped.data.type);
}

export type McpRemoveOutcome =
  | { ok: true; scope: "user"; name: string; removed: boolean }
  | { ok: true; scope: "local"; name: string; removed: boolean; root: string }
  | { ok: true; scope: "project"; name: string; removed: boolean; cwd: string }
  | { ok: false; message: string }
  | { ok: false; multi: true; name: string; scopes: McpScope[] };

async function userScopeHasServer(deps: McpRouteDeps, name: string): Promise<boolean> {
  if (deps.door) {
    try { return (await deps.door.mcpGet(name)).found; } catch { return false; }
  }
  try { return Object.hasOwn(readSdkGlobalConfig(deps.winterHome).mcpServers ?? {}, name); } catch { return false; }
}

function localScopeHasServer(deps: McpRouteDeps, name: string): boolean {
  try { return sdkLocalServer(deps.winterHome, localScopeKeyFor(deps.cwd), name) !== undefined; } catch { return false; }
}

/** Tri-state, not a boolean: a malformed project `.winter/mcp.json` must never be silently read as
 *  "not there" — the ambient (no `-s`) branch surfaces the parse error instead, the same way
 *  `mcp get` already does. */
type ProjectScopeCheck = { kind: "found" } | { kind: "absent" } | { kind: "malformed"; message: string };

function projectScopeHasServer(deps: McpRouteDeps, name: string): ProjectScopeCheck {
  const root = localScopeKeyFor(deps.cwd);
  const read = readRawWinterMcpConfig(root);
  if (read.kind === "malformed") return { kind: "malformed", message: malformedProjectFileMessage(root, `checking for "${name}"`) };
  if (read.kind === "absent") return { kind: "absent" };
  return { kind: Object.hasOwn(read.servers, name) ? "found" : "absent" };
}

async function removeUserScope(deps: McpRouteDeps, name: string): Promise<{ removed: boolean }> {
  if (deps.door) {
    const r = await deps.door.mcpRemove(name);
    return { removed: r.removed };
  }
  return { removed: removeSdkUserMcpServer(deps.winterHome, name) };
}

function removeLocalScope(deps: McpRouteDeps, name: string): { removed: boolean; root: string } {
  const root = localScopeKeyFor(deps.cwd);
  return { removed: removeSdkLocalMcpServer(deps.winterHome, root, name), root };
}

type ProjectRemoveResult = { ok: true; removed: boolean } | { ok: false; message: string };

function removeProjectScope(deps: McpRouteDeps, name: string): ProjectRemoveResult {
  const root = localScopeKeyFor(deps.cwd);
  const read = readRawWinterMcpConfig(root);
  if (read.kind === "malformed") return { ok: false, message: malformedProjectFileMessage(root, `removing "${name}"`) };
  if (read.kind === "absent") return { ok: true, removed: false };
  const { servers: next, removed } = removeProjectMcpServerEntry(read.servers, name);
  if (removed) writeRawWinterMcpConfig(root, read.raw, next);
  return { ok: true, removed };
}

/** `winter mcp remove` — with an explicit `-s`, removes from just that scope (a "not found there"
 *  still reports `removed: false`, never an error, matching `mcp.remove`'s own idempotent RPC
 *  posture). With NO `-s`, mirrors claude's own ambiguity handling (`mcpRemoveHandler`): check all
 *  three scopes, remove from whichever ONE has it, refuse typed if it's in none, and hand back the
 *  "which scope did you mean" listing if it's in more than one. */
export async function runMcpRemoveRoute(args: string[], deps: McpRouteDeps): Promise<McpRemoveOutcome> {
  const parseResult = parseMcpRemoveArgs(args);
  if (parseResult.kind === "usageError") return { ok: false, message: parseResult.message };
  const { parsed } = parseResult;

  if (parsed.scopeRaw) {
    const scopeResult = ensureMcpScope(parsed.scopeRaw);
    if (scopeResult.kind !== "ok") return { ok: false, message: scopeResult.message };
    if (scopeResult.scope === "user") {
      const { removed } = await removeUserScope(deps, parsed.name);
      return { ok: true, scope: "user", name: parsed.name, removed };
    }
    if (scopeResult.scope === "local") {
      const { removed, root } = removeLocalScope(deps, parsed.name);
      return { ok: true, scope: "local", name: parsed.name, removed, root };
    }
    const projectResult = removeProjectScope(deps, parsed.name);
    if (!projectResult.ok) return { ok: false, message: projectResult.message };
    return { ok: true, scope: "project", name: parsed.name, removed: projectResult.removed, cwd: localScopeKeyFor(deps.cwd) };
  }

  const [inUser, inLocal, projectCheck] = await Promise.all([
    userScopeHasServer(deps, parsed.name),
    Promise.resolve(localScopeHasServer(deps, parsed.name)),
    Promise.resolve(projectScopeHasServer(deps, parsed.name)),
  ]);
  // A malformed project file is NEVER silently read as "not there" — this command can't tell
  // whether the name is ALSO in project scope, so it surfaces the parse error rather than guess.
  if (projectCheck.kind === "malformed") return { ok: false, message: projectCheck.message };
  const inProject = projectCheck.kind === "found";
  const foundIn: McpScope[] = [...(inLocal ? (["local"] as const) : []), ...(inUser ? (["user"] as const) : []), ...(inProject ? (["project"] as const) : [])];
  if (foundIn.length > 1) return { ok: false, multi: true, name: parsed.name, scopes: foundIn };
  if (inLocal) {
    const { removed, root } = removeLocalScope(deps, parsed.name);
    return { ok: true, scope: "local", name: parsed.name, removed, root };
  }
  if (inUser) {
    const { removed } = await removeUserScope(deps, parsed.name);
    return { ok: true, scope: "user", name: parsed.name, removed };
  }
  if (inProject) {
    const projectResult = removeProjectScope(deps, parsed.name);
    if (!projectResult.ok) return { ok: false, message: projectResult.message };
    return { ok: true, scope: "project", name: parsed.name, removed: projectResult.removed, cwd: localScopeKeyFor(deps.cwd) };
  }
  return { ok: false, message: `No MCP server found with name: "${parsed.name}"` };
}

export type McpGetOutcome =
  | { ok: true; found: false; name: string }
  | {
      ok: true; found: true; name: string; scope: McpScope; transport: McpTransport;
      command?: string; args?: string[]; env?: Record<string, string>;
      url?: string; headers?: Record<string, string>; disabled?: boolean; strippedHeaders?: string[];
      cwd?: string;
      /** Set ONLY for a project-scope entry that is PRESENT in `.winter/mcp.json` but does not
       *  validate against any recognized shape (`parseProjectMcpServers`' own skip reason). */
      unrecognized?: string;
    }
  | { ok: false; message: string };

/** `winter mcp get <name>` — no `-s` flag (claude's own `get` has none either): checks LOCAL scope
 *  first, then USER, then PROJECT — local shadows user shadows project, mirroring claude's own
 *  merge-order precedence (F17: arrays/tiers layer local-most-specific-wins). Project-scope reads
 *  go through the SAME per-entry parser (`parseProjectMcpServers`) the daemon's own readers use —
 *  a present-but-invalid entry is reported as `found: true` with `unrecognized` set, never silently
 *  treated as absent. */
export async function runMcpGetRoute(args: string[], deps: McpRouteDeps): Promise<McpGetOutcome> {
  const parseResult = parseMcpGetArgs(args);
  if (parseResult.kind === "usageError") return { ok: false, message: parseResult.message };
  const { name } = parseResult;

  // WS-21: reads through the SAME credential-shaped-header-stripping map `settings.ts`'s own
  // `sdkLocalMcpServers`/`sdkUserMcpServers` readers use (`parseMcpServerMap`), never the raw
  // `readSdkGlobalConfig` passthrough — that reader is `sdk-files.ts`'s own Contract C surface and
  // knows nothing about this header rule (it's a `settings.ts`-level concern). `strippedHeaders`
  // below is computed separately, off the RAW file, since the cleaned entry can no longer say what
  // it lost.
  const local = sdkLocalMcpServers(deps.winterHome, localScopeKeyFor(deps.cwd))[name];
  if (local) {
    return {
      ok: true, found: true, name, scope: "local", transport: local.type,
      ...(local.type === "stdio" ? { command: local.command, args: local.args, env: local.env } : { url: local.url, headers: local.headers }),
    };
  }

  if (deps.door) {
    try {
      const r = await deps.door.mcpGet(name);
      if (r.found) {
        return {
          ok: true, found: true, name, scope: "user", transport: r.transport!,
          command: r.command, args: r.args, env: r.env, url: r.url, headers: r.headers,
          disabled: r.disabled, strippedHeaders: r.strippedHeaders,
        };
      }
    } catch { /* fall through to project scope below */ }
  } else {
    try {
      const entry = sdkUserMcpServers(deps.winterHome)[name];
      if (entry) {
        // Read-door correction, matching the RPC handler's own `mcp.get` exactly: which
        // credential-shaped headers were silently stripped for THIS server, read fresh off the
        // RAW file — `entry` above, by construction, can no longer say what it lost.
        const strippedHeaders = stripCredentialShapedMcpHeaders(readRawSettings(sdkGlobalConfigPath(deps.winterHome)) ?? {})[name];
        return {
          ok: true, found: true, name, scope: "user", transport: entry.type,
          ...(entry.type === "stdio" ? { command: entry.command, args: entry.args, env: entry.env } : { url: entry.url, headers: entry.headers }),
          ...(strippedHeaders && strippedHeaders.length > 0 ? { strippedHeaders } : {}),
        };
      }
    } catch { /* no sdk/.winter.json yet — fall through */ }
  }

  const root = localScopeKeyFor(deps.cwd);
  const read = readRawWinterMcpConfig(root);
  if (read.kind === "malformed") return { ok: false, message: malformedProjectFileMessage(root, `reading "${name}"`) };
  if (read.kind === "ok") {
    const { servers, skipped } = parseProjectMcpServers(read.servers);
    const entry = servers[name];
    if (entry) {
      return {
        ok: true, found: true, name, scope: "project", transport: entry.type, cwd: root,
        ...(entry.type === "stdio" ? { command: entry.command, args: entry.args, env: entry.env } : { url: entry.url, headers: entry.headers }),
      };
    }
    const skippedEntry = skipped.find((s) => s.name === name);
    if (skippedEntry) {
      return { ok: true, found: true, name, scope: "project", transport: "stdio", cwd: root, unrecognized: skippedEntry.reason };
    }
  }
  return { ok: true, found: false, name };
}

// ------------------------------------------------------------------------------------------------
// Rendering (pure) — main.ts prints exactly what these return.
// ------------------------------------------------------------------------------------------------

function scopeLabel(scope: McpScope, location?: string): string {
  if (scope === "user") return "user config (sdk/.winter.json)";
  if (scope === "local") return `local config (sdk/.winter.json${location ? `, ${location}` : ""})`;
  return `project config (.winter/mcp.json${location ? `, ${location}` : ""})`;
}

export function renderMcpAddOutcome(outcome: McpAddOutcome): string {
  if (!outcome.ok) return outcome.message;
  // `outcome.warning` may carry more than one warning, newline-joined (`runMcpAddRoute`) — each
  // gets its own "Warning: " line rather than only the first.
  const warningLine = outcome.warning ? `${outcome.warning.split("\n").map((w) => `Warning: ${w}`).join("\n")}\n` : "";
  if (outcome.scope === "project") {
    const trustNote = outcome.trusted ? "" : ` — not yet loaded: this project is not trusted yet (run \`winter trust ${outcome.cwd}\` to trust it)`;
    return `${warningLine}Added ${outcome.transport} MCP server "${outcome.name}" to ${scopeLabel("project", outcome.cwd)}${trustNote}`;
  }
  if (outcome.scope === "local") {
    return `${warningLine}Added ${outcome.transport} MCP server "${outcome.name}" to ${scopeLabel("local", outcome.root)}`;
  }
  const effectNote = outcome.via === "daemon"
    ? (outcome.transport === "stdio"
        ? (outcome.started
            ? " — started in the daemon's own registry now; an already-running session picks it up at its next incarnation"
            : " — left stopped (disabled)")
        : " — the child connects to it directly at session start (no in-daemon client for this transport)")
    : " — takes effect the next time a daemon starts";
  return `${warningLine}Added ${outcome.transport} MCP server "${outcome.name}" to ${scopeLabel("user")}${effectNote}`;
}

export function renderMcpRemoveOutcome(outcome: McpRemoveOutcome): string {
  if (!outcome.ok) {
    if ("multi" in outcome) {
      const lines = [`MCP server "${outcome.name}" exists in multiple scopes:`];
      for (const s of outcome.scopes) lines.push(`  - ${scopeLabel(s)}`);
      lines.push("", "To remove from a specific scope, use:");
      for (const s of outcome.scopes) lines.push(`  winter mcp remove "${outcome.name}" -s ${s}`);
      return lines.join("\n");
    }
    return outcome.message;
  }
  const location = outcome.scope === "project" ? outcome.cwd : outcome.scope === "local" ? outcome.root : undefined;
  return outcome.removed
    ? `Removed MCP server "${outcome.name}" from ${scopeLabel(outcome.scope, location)}`
    : `no MCP server named "${outcome.name}" in ${scopeLabel(outcome.scope, location)} — nothing removed`;
}

export function renderMcpGetOutcome(outcome: McpGetOutcome): string {
  if (!outcome.ok) return outcome.message;
  if (!outcome.found) return `No MCP server found with name: "${outcome.name}"`;
  if (outcome.unrecognized) {
    // Present in the file, but failed EVERY recognized shape (stdio/http/sse) —
    // `parseProjectMcpServers`' own reason, the same per-branch message `settings.mcpServers`
    // itself would raise for the identical malformed entry.
    return [
      `${outcome.name}:`,
      `  Scope: ${scopeLabel(outcome.scope, outcome.cwd)}`,
      `  (not recognized: ${outcome.unrecognized})`,
      "",
      `To remove this server, run: winter mcp remove "${outcome.name}" -s ${outcome.scope}`,
    ].join("\n");
  }
  const lines = [`${outcome.name}:`, `  Scope: ${scopeLabel(outcome.scope, outcome.cwd)}`, `  Type: ${outcome.transport}`];
  if (outcome.transport === "stdio") {
    lines.push(`  Command: ${outcome.command}`);
    if (outcome.args?.length) lines.push(`  Args: ${outcome.args.join(" ")}`);
    if (outcome.env && Object.keys(outcome.env).length > 0) {
      lines.push("  Environment:");
      for (const [k, v] of Object.entries(outcome.env)) lines.push(`    ${k}=${v}`);
    }
  } else {
    lines.push(`  URL: ${outcome.url}`);
    if (outcome.headers && Object.keys(outcome.headers).length > 0) {
      lines.push("  Headers:");
      for (const [k, v] of Object.entries(outcome.headers)) lines.push(`    ${k}: ${v}`);
    }
  }
  if (outcome.strippedHeaders?.length) lines.push(`  (dropped credential-shaped header(s) at read time: ${outcome.strippedHeaders.join(", ")} — sdk/.winter.json is model-readable; see CLAUDE.md)`);
  if (outcome.disabled) lines.push("  Disabled: yes (winter mcp add ran, but this name is in settings.mcp.disabled)");
  lines.push("", `To remove this server, run: winter mcp remove "${outcome.name}" -s ${outcome.scope}`);
  return lines.join("\n");
}
