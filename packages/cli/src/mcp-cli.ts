// Pure/isolatable logic behind `winter mcp add|add-json|remove|get` — CLI parity with
// `claude mcp add|add-json|remove|get` (reference clone: `src/commands/mcp/addCommand.ts`,
// `src/cli/handlers/mcp.tsx`, `src/services/mcp/utils.ts`). Split out of main.ts the same way
// `model-cli.ts`/`plugin-cli.ts` are: main.ts owns argv slicing + printing + `process.exit`; this
// file owns parsing, scope/transport validation, and the actual read-modify-write (the writes
// themselves are cheap enough, and few enough call sites, that there is no separate "pure
// transform vs. I/O" split the way `settings.ts` has one — every exported `run*Route` function
// here IS the full round trip, returning a plain result object main.ts renders and exits on,
// mirroring `runCredentialsRoute`'s own "store+args in, a plain result out, nothing printed and
// nothing exited" convention, `credentials-cli.test.ts`'s own header).
//
// SCOPE MAPPING (decided against Winter's real MCP sources, not assumed from claude's):
//   - "user"    -> `<WINTER_HOME>/settings.json`'s `mcpServers` (daemon-owned, hot-reloaded,
//                  `settings.ts`'s full schema — including the credential-shaped-header refusal on
//                  an http/sse entry). Default scope (claude defaults to "local"; Winter has no
//                  such scope — see below).
//   - "project" -> `<cwd>/.mcp.json`, claude's OWN file format, byte-identical shape. NEVER
//                  RPC-routed: this file isn't daemon state (no watcher, no settings-schema
//                  validation — `configuredMcpServersFor`/`McpManager.doEnsureProject` just read it
//                  live off disk per session spawn), so the CLI reads/writes it directly, with or
//                  without a live daemon. Stdio-only, matching every existing reader — `--transport
//                  http`/`sse` is refused at THIS door before an entry shaped that way could ever
//                  reach a reader that would silently drop it.
//   - "local"   -> REFUSED with a one-line explanation. claude's "local" scope is a project-private
//                  overlay Winter has no equivalent source for today (no per-project-private MCP
//                  config the daemon reads) — inventing one silently would be a false parity claim.
//
// `mcp add`'s USER-scope write goes through the daemon when it's live (`mcp.add`/`mcp.remove` RPC,
// `WinterClient.mcpAdd`/`mcpRemove`/`mcpGet`) and directly through `@yanlinglabs/winter-core`'s
// `addUserMcpServer`/`removeUserMcpServer` + `loadSettings`/`saveSettings` when it is not — the SAME
// validated-write functions the daemon's own RPC handler calls (`agent/mcp/mcp-write.ts`'s own
// header), so the two paths can never accept a write the other would refuse.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  loadSettings, saveSettings, addUserMcpServer, removeUserMcpServer,
  addProjectMcpServer, removeProjectMcpServer, readRawProjectMcpConfig, writeRawProjectMcpConfig,
  projectMcpConfigPath, TrustStore,
  type McpServerSettingsEntry, type ProjectMcpServerEntry,
} from "@yanlinglabs/winter-core";
import { McpAddEntrySchema } from "@yanlinglabs/winter-protocol";

export type McpScope = "user" | "project";
export type McpTransport = "stdio" | "http" | "sse";

/** Structural — matches exactly the three `WinterClient` methods this file calls, so a test can
 *  hand in a plain fake instead of a real socket connection. */
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
  /** `undefined` when no daemon answered — every route falls back to a direct, in-process write
   *  for user scope; project scope never uses this at all (see this file's own header). */
  door?: McpDoor;
}

// ------------------------------------------------------------------------------------------------
// Scope / transport / header / env parsing (pure, no I/O)
// ------------------------------------------------------------------------------------------------

export type ScopeResolution =
  | { kind: "ok"; scope: McpScope }
  | { kind: "localRefused"; message: string }
  | { kind: "invalid"; message: string };

const LOCAL_SCOPE_REFUSAL =
  "winter has no private per-project MCP scope yet (claude's own \"local\") — use \"user\" " +
  "(settings.json, available in every project; the default) or \"project\" (.mcp.json, shared with your team)";

/** Default scope is "user" (claude's own default, "local", has no Winter equivalent — see this
 *  file's header). */
export function ensureMcpScope(raw?: string): ScopeResolution {
  if (!raw) return { kind: "ok", scope: "user" };
  if (raw === "local") return { kind: "localRefused", message: LOCAL_SCOPE_REFUSAL };
  if (raw === "user" || raw === "project") return { kind: "ok", scope: raw };
  return { kind: "invalid", message: `invalid scope: ${raw}. Must be one of: user, project` };
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

const ADD_USAGE = "usage: winter mcp add [-s user|project] [-t stdio|sse|http] [-e KEY=value...] [-H \"Name: value\"...] <name> <commandOrUrl> [-- args...]";

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

const ADD_JSON_USAGE = "usage: winter mcp add-json [-s user|project] <name> <json>";

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
  if (!name) return { kind: "usageError", message: "usage: winter mcp remove <name> [-s user|project]" };
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
 *  `addCommand.ts`'s own per-transport branching. Does NOT check the project-scope stdio-only rule;
 *  that's the route's job (it knows the scope, this function doesn't need to). */
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

// ------------------------------------------------------------------------------------------------
// Route functions — the full round trip (I/O via the injected door and `@yanlinglabs/winter-core`),
// returning a plain outcome object. Nothing here prints or exits; `main.ts`'s `case "mcp"` does.
// ------------------------------------------------------------------------------------------------

export type McpAddOutcome =
  | { ok: true; scope: "user"; name: string; transport: McpTransport; via: "daemon" | "local"; started?: boolean; warning?: string }
  | { ok: true; scope: "project"; name: string; transport: "stdio"; cwd: string; trusted: boolean; warning?: string }
  | { ok: false; message: string };

function isTrustedDir(winterHome: string, dir: string): boolean {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* the trust store falls back to the given path too */ }
  return new TrustStore(join(winterHome, "trust.json")).isTrusted(real);
}

async function addUserScope(deps: McpRouteDeps, name: string, entry: McpServerSettingsEntry, transport: McpTransport): Promise<McpAddOutcome> {
  if (deps.door) {
    try {
      const r = await deps.door.mcpAdd(name, entry);
      return { ok: true, scope: "user", name: r.name, transport: r.transport, via: "daemon", started: r.started };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
  const settingsPath = join(deps.winterHome, "settings.json");
  let next;
  try {
    next = addUserMcpServer(loadSettings(settingsPath), name, entry);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  try {
    saveSettings(settingsPath, next);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  return { ok: true, scope: "user", name, transport, via: "local" };
}

/** A message shared by every project-scope write that finds `.mcp.json` unreadable — REFUSES
 *  rather than silently replaces it (`readRawProjectMcpConfig`'s own doc explains why: this file has
 *  no watcher/keep-last-good the way settings.json does, so "degrade to empty and write anyway"
 *  would delete every server a human or claude configured there). */
function malformedProjectFileMessage(cwd: string, verb: string): string {
  return `${projectMcpConfigPath(cwd)} is not valid JSON — fix it before ${verb} (Winter refuses to overwrite a project file it cannot parse)`;
}

function addProjectScope(deps: McpRouteDeps, name: string, entry: ProjectMcpServerEntry): McpAddOutcome {
  const read = readRawProjectMcpConfig(deps.cwd);
  if (read.kind === "malformed") return { ok: false, message: malformedProjectFileMessage(deps.cwd, `adding "${name}"`) };
  const servers = read.kind === "ok" ? read.servers : {};
  let next: Record<string, unknown>;
  try {
    next = addProjectMcpServer(servers, name, entry);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  writeRawProjectMcpConfig(deps.cwd, read.kind === "ok" ? read.raw : {}, next);
  return { ok: true, scope: "project", name, transport: "stdio", cwd: deps.cwd, trusted: isTrustedDir(deps.winterHome, deps.cwd) };
}

/** `winter mcp add` — the full route. Refuses `--transport http|sse` at PROJECT scope before ever
 *  building an entry (that file's reader is stdio-only; see this file's own header) rather than
 *  writing a shape `.mcp.json`'s reader would just silently drop. */
export async function runMcpAddRoute(args: string[], deps: McpRouteDeps): Promise<McpAddOutcome> {
  const parseResult = parseMcpAddArgs(args);
  if (parseResult.kind === "usageError") return { ok: false, message: parseResult.message };
  const { parsed } = parseResult;

  const scopeResult = ensureMcpScope(parsed.scopeRaw);
  if (scopeResult.kind !== "ok") return { ok: false, message: scopeResult.message };

  const transportResult = ensureMcpTransport(parsed.transportRaw);
  if (transportResult.kind !== "ok") return { ok: false, message: transportResult.message };
  const { transport } = transportResult;

  if (scopeResult.scope === "project" && transport !== "stdio") {
    return { ok: false, message: "project-scope MCP servers are stdio-only (Winter's .mcp.json reader, matching claude's own file format) — use \"-s user\" for an http/sse server" };
  }

  const entryResult = buildMcpEntry(parsed, transport);
  if (entryResult.kind === "error") return { ok: false, message: entryResult.message };

  // Mirrors claude's own "did you mean --transport http/sse" heuristic (`addCommand.ts`): only
  // when the transport was NOT given explicitly — an explicit `-t stdio` on a URL-shaped command is
  // the user's own deliberate choice, never second-guessed.
  const warning = parsed.transportRaw === undefined && looksLikeMcpUrl(parsed.commandOrUrl)
    ? `the command "${parsed.commandOrUrl}" looks like a URL, but is being added as a stdio server because --transport was not specified — for an http server use "-t http", for sse use "-t sse"`
    : undefined;

  let outcome: McpAddOutcome;
  if (scopeResult.scope === "project") {
    const stdioEntry = entryResult.entry as Extract<McpServerSettingsEntry, { type: "stdio" }>;
    outcome = addProjectScope(deps, parsed.name, { command: stdioEntry.command, ...(stdioEntry.args ? { args: stdioEntry.args } : {}), ...(stdioEntry.env ? { env: stdioEntry.env } : {}) });
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

  if (scopeResult.scope === "project" && shaped.data.type !== "stdio") {
    return { ok: false, message: "project-scope MCP servers are stdio-only (Winter's .mcp.json reader, matching claude's own file format) — use \"-s user\" for an http/sse server" };
  }
  if (scopeResult.scope === "project") {
    const e = shaped.data as Extract<McpServerSettingsEntry, { type: "stdio" }>;
    return addProjectScope(deps, parsed.name, { command: e.command, ...(e.args ? { args: e.args } : {}), ...(e.env ? { env: e.env } : {}) });
  }
  return addUserScope(deps, parsed.name, shaped.data, shaped.data.type);
}

export type McpRemoveOutcome =
  | { ok: true; scope: "user"; name: string; removed: boolean }
  | { ok: true; scope: "project"; name: string; removed: boolean; cwd: string }
  | { ok: false; message: string }
  | { ok: false; multi: true; name: string; scopes: McpScope[] };

async function userScopeHasServer(deps: McpRouteDeps, name: string): Promise<boolean> {
  if (deps.door) {
    try { return (await deps.door.mcpGet(name)).found; } catch { return false; }
  }
  try { return loadSettings(join(deps.winterHome, "settings.json")).mcpServers?.[name] !== undefined; } catch { return false; }
}

function projectScopeHasServer(deps: McpRouteDeps, name: string): boolean {
  const read = readRawProjectMcpConfig(deps.cwd);
  return read.kind === "ok" && Object.hasOwn(read.servers, name);
}

async function removeUserScope(deps: McpRouteDeps, name: string): Promise<{ removed: boolean }> {
  if (deps.door) {
    const r = await deps.door.mcpRemove(name);
    return { removed: r.removed };
  }
  const settingsPath = join(deps.winterHome, "settings.json");
  const { settings: next, removed } = removeUserMcpServer(loadSettings(settingsPath), name);
  if (removed) saveSettings(settingsPath, next);
  return { removed };
}

type ProjectRemoveResult = { ok: true; removed: boolean } | { ok: false; message: string };

function removeProjectScope(deps: McpRouteDeps, name: string): ProjectRemoveResult {
  const read = readRawProjectMcpConfig(deps.cwd);
  if (read.kind === "malformed") return { ok: false, message: malformedProjectFileMessage(deps.cwd, `removing "${name}"`) };
  if (read.kind === "absent") return { ok: true, removed: false };
  const { servers: next, removed } = removeProjectMcpServer(read.servers, name);
  if (removed) writeRawProjectMcpConfig(deps.cwd, read.raw, next);
  return { ok: true, removed };
}

/** `winter mcp remove` — with an explicit `-s`, removes from just that scope (a "not found there"
 *  still reports `removed: false`, never an error, matching `mcp.remove`'s own idempotent RPC
 *  posture). With NO `-s`, mirrors claude's own ambiguity handling (`mcpRemoveHandler`): check both
 *  scopes, remove from whichever ONE has it, refuse typed if it's in neither, and hand back the
 *  "which scope did you mean" listing if it's in both. */
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
    const projectResult = removeProjectScope(deps, parsed.name);
    if (!projectResult.ok) return { ok: false, message: projectResult.message };
    return { ok: true, scope: "project", name: parsed.name, removed: projectResult.removed, cwd: deps.cwd };
  }

  const [inUser, inProject] = await Promise.all([userScopeHasServer(deps, parsed.name), Promise.resolve(projectScopeHasServer(deps, parsed.name))]);
  if (inUser && inProject) return { ok: false, multi: true, name: parsed.name, scopes: ["user", "project"] };
  if (inUser) {
    const { removed } = await removeUserScope(deps, parsed.name);
    return { ok: true, scope: "user", name: parsed.name, removed };
  }
  if (inProject) {
    const projectResult = removeProjectScope(deps, parsed.name);
    if (!projectResult.ok) return { ok: false, message: projectResult.message };
    return { ok: true, scope: "project", name: parsed.name, removed: projectResult.removed, cwd: deps.cwd };
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
    }
  | { ok: false; message: string };

/** `winter mcp get <name>` — no `-s` flag (claude's own `get` has none either): checks USER scope
 *  first, then PROJECT — the same precedence `external-mcp.ts`'s own header documents ("a user
 *  server shadows a same-keyed project server"), so `get` shows whichever one a real session would
 *  actually run. */
export async function runMcpGetRoute(args: string[], deps: McpRouteDeps): Promise<McpGetOutcome> {
  const parseResult = parseMcpGetArgs(args);
  if (parseResult.kind === "usageError") return { ok: false, message: parseResult.message };
  const { name } = parseResult;

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
      const entry = loadSettings(join(deps.winterHome, "settings.json")).mcpServers?.[name];
      if (entry) {
        return {
          ok: true, found: true, name, scope: "user", transport: entry.type,
          ...(entry.type === "stdio" ? { command: entry.command, args: entry.args, env: entry.env } : { url: entry.url, headers: entry.headers }),
        };
      }
    } catch { /* no settings.json yet — fall through */ }
  }

  const read = readRawProjectMcpConfig(deps.cwd);
  if (read.kind === "malformed") return { ok: false, message: malformedProjectFileMessage(deps.cwd, `reading "${name}"`) };
  const projectEntryUnknown = read.kind === "ok" ? read.servers[name] : undefined;
  if (projectEntryUnknown && typeof projectEntryUnknown === "object") {
    const stdio = asStdioProjectEntry(projectEntryUnknown);
    if (stdio) return { ok: true, found: true, name, scope: "project", transport: "stdio", command: stdio.command, args: stdio.args, env: stdio.env, cwd: deps.cwd };
    // Present, but not stdio-shaped (an http/sse entry, or something this reader doesn't
    // recognize) — reported as found rather than silently treated as absent; no `command` field.
    return { ok: true, found: true, name, scope: "project", transport: "stdio", cwd: deps.cwd };
  }
  return { ok: true, found: false, name };
}

/** Duck-types a raw (untyped) project-scope entry as `{command, args?, env?}` — deliberately NOT
 *  the zod schema (`ProjectMcpServerEntry` is exported from `@yanlinglabs/winter-core` as a TYPE
 *  only, same posture as `Settings`; the CLI package never gets the runtime schema object). Used
 *  only for DISPLAY (`mcp get`) — the write door (`addProjectMcpServer`) still gets its `entry`
 *  built from an already-validated `McpServerSettingsEntry`/`McpAddEntrySchema` result, never from
 *  this best-effort reader. */
function asStdioProjectEntry(value: object): ProjectMcpServerEntry | undefined {
  const v = value as Record<string, unknown>;
  if (typeof v.command !== "string") return undefined;
  const args = Array.isArray(v.args) && v.args.every((a) => typeof a === "string") ? (v.args as string[]) : undefined;
  const env = v.env && typeof v.env === "object" && !Array.isArray(v.env) ? (v.env as Record<string, string>) : undefined;
  return { command: v.command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
}

// ------------------------------------------------------------------------------------------------
// Rendering (pure) — main.ts prints exactly what these return.
// ------------------------------------------------------------------------------------------------

function scopeLabel(scope: McpScope, cwd?: string): string {
  return scope === "user" ? "user config (settings.json)" : `project config (.mcp.json${cwd ? `, ${cwd}` : ""})`;
}

export function renderMcpAddOutcome(outcome: McpAddOutcome): string {
  if (!outcome.ok) return outcome.message;
  const warningLine = outcome.warning ? `Warning: ${outcome.warning}\n` : "";
  if (outcome.scope === "project") {
    const trustNote = outcome.trusted ? "" : ` — not yet loaded: this project is not trusted yet (run \`winter trust ${outcome.cwd}\` to trust it)`;
    return `${warningLine}Added ${outcome.transport} MCP server "${outcome.name}" to ${scopeLabel("project", outcome.cwd)}${trustNote}`;
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
  return outcome.removed
    ? `Removed MCP server "${outcome.name}" from ${scopeLabel(outcome.scope, outcome.scope === "project" ? outcome.cwd : undefined)}`
    : `no MCP server named "${outcome.name}" in ${scopeLabel(outcome.scope, outcome.scope === "project" ? outcome.cwd : undefined)} — nothing removed`;
}

export function renderMcpGetOutcome(outcome: McpGetOutcome): string {
  if (!outcome.ok) return outcome.message;
  if (!outcome.found) return `No MCP server found with name: "${outcome.name}"`;
  const lines = [`${outcome.name}:`, `  Scope: ${scopeLabel(outcome.scope, outcome.cwd)}`, `  Type: ${outcome.transport}`];
  if (outcome.transport === "stdio" && outcome.command === undefined && outcome.scope === "project") {
    // Present in the file, but not shaped like a stdio entry `{command, args?, env?}` — an http/sse
    // entry (or anything else) claude or a human put there; Winter's project-scope reader only ever
    // understands stdio, so it can't show more detail than "it's there" (`runMcpGetRoute`'s own doc).
    lines.push("  (this entry's shape isn't recognized by Winter's project-scope reader — expected {command, args?, env?}; edit .mcp.json directly to inspect it)");
  } else if (outcome.transport === "stdio") {
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
  if (outcome.strippedHeaders?.length) lines.push(`  (dropped credential-shaped header(s) at read time: ${outcome.strippedHeaders.join(", ")} — settings.json is model-readable; see CLAUDE.md)`);
  if (outcome.disabled) lines.push("  Disabled: yes (winter mcp add ran, but this name is in settings.mcp.disabled)");
  lines.push("", `To remove this server, run: winter mcp remove "${outcome.name}" -s ${outcome.scope}`);
  return lines.join("\n");
}
