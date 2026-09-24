// The ONE validated-add/validated-remove door `winter mcp add/remove` writes through, on EITHER
// scope. Two call sites share every function here:
//   - USER scope (`settings.mcpServers`): `ipc/server.ts`'s `mcp.add`/`mcp.remove` RPC handlers
//     (daemon live) AND `packages/cli/src/mcp-cli.ts`'s no-daemon fallback (direct settings.json
//     write) — the same reuse precedent `writeCredentialThroughDaemonOrLocally` set for
//     `credential.set`/`credential.remove` (`packages/cli/src/main.ts`): a validated write can never
//     drift between "the daemon is live" and "it isn't" if there is only one function that decides
//     what counts as a valid write.
//   - PROJECT scope (`<cwd>/.mcp.json`): CLI-only, always local (that file isn't daemon state — no
//     watcher, no settings-schema validation, read live per session spawn by
//     `configuredMcpServersFor` — see that function's own header). There is no daemon RPC for this
//     scope at all; `mcp-cli.ts` calls `addProjectMcpServer`/`removeProjectMcpServer` directly,
//     whether or not a daemon happens to be running.
//
// Neither scope's write here ever validates the FULL settings/project-config shape — that is
// `saveSettings`'s job for user scope (the real enforcement, including the credential-shaped-header
// refusal on an http/sse entry). Project scope operates on the RAW `mcpServers` map
// (`project-file.ts`'s `readRawProjectMcpConfig`/`writeRawProjectMcpConfig`) rather than the typed
// `ProjectMcpConfig` — that schema is stdio-only and `.parse()`s the WHOLE map at once, so building
// a write on top of it would silently DROP every sibling entry it can't parse (an http/sse one, or
// even a stdio one with an extra field) the moment ANY one of them doesn't fit — see
// `readRawProjectMcpConfig`'s own doc for the exact failure this avoids. This file only owns the ONE
// thing specific to an ADD: the name rules (shape + Winter's reserved capability namespace) and
// "refuse a silent overwrite" (mirrors claude's own `addMcpConfig`, `services/mcp/config.ts` in the
// reference clone — it throws "already exists in <scope> config" rather than replace).
import type { Settings, McpServerSettingsEntry } from "../../settings";
import { setMcpServerEntry, removeMcpServerEntry, sdkLocalMcpServers, sdkUserMcpServers, validateMcpServerEntryForWrite } from "../../settings";
import { ProjectMcpEntrySchema, parseProjectMcpServers, projectMcpConfigPath, readRawProjectMcpConfig, writeRawProjectMcpConfig } from "./project-file";
import { readSdkGlobalConfigDetailed, updateSdkGlobalConfig, type SdkGlobalConfigFile } from "../../sdk-files";
import { reservedMcpServerNames } from "../../capabilities/names";
import type { ProjectMcpServerEntry } from "./project-file";

/** Mirrors claude's own `mcp add` name rule (`addMcpConfig`, the reference clone's
 *  `services/mcp/config.ts`): letters, numbers, hyphens, underscores only. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validates an MCP server NAME before either scope's add ever touches a file — shape (claude's own
 * rule) PLUS Winter's own reserved-namespace refusal (`reservedMcpServerNames`), which claude has no
 * equivalent of: it owns no daemon MCP servers to collide with. `assertNoCapabilityCollision`
 * (`capabilities/index.ts`) already refuses a colliding name, but only at SESSION SPAWN — every
 * session created after the bad write, not the write itself. Checking it here means `winter mcp add
 * winter__browser` is refused typed, on the spot, instead of silently breaking every session from
 * then on. Returns an error message, or `undefined` when the name is fine to write.
 */
export function validateMcpServerName(name: string): string | undefined {
  if (!NAME_PATTERN.test(name)) return `invalid MCP server name "${name}" — names can only contain letters, numbers, hyphens, and underscores`;
  if (reservedMcpServerNames().has(name)) return `cannot add MCP server "${name}": this name is reserved for a Winter-owned capability server`;
  return undefined;
}

/**
 * THE user-scope add door. Throws (never a typed result union — the two callers each have their
 * own error-reporting convention, an `RpcFailure` vs. a CLI stderr line, so a plain `Error` is the
 * one shape both can adapt) on a bad name or a name already present in `settings.mcpServers` — never
 * a silent overwrite (`winter mcp remove <name>` first, same as claude). Does NOT call
 * `saveSettings` itself: the caller does, so it can catch THAT door's own validation error (the
 * credential-shaped-header refusal on an http/sse entry, `refuseCredentialShapedHeaders`) and report
 * it as what it is, separately from a name-rule refusal.
 */
export function addUserMcpServer(settings: Settings, name: string, entry: McpServerSettingsEntry): Settings {
  const nameErr = validateMcpServerName(name);
  if (nameErr) throw new Error(nameErr);
  if (settings.mcpServers?.[name]) {
    throw new Error(`MCP server "${name}" already exists in user config — remove it first ("winter mcp remove ${name}") or edit settings.json directly`);
  }
  return setMcpServerEntry(settings, name, entry);
}

/** The user-scope remove door — always succeeds (idempotent, mirrors `setMcpServerDisabled`'s own
 *  posture), reporting whether anything was actually there so the caller can print an honest
 *  message rather than claim a removal that didn't happen. */
export function removeUserMcpServer(settings: Settings, name: string): { settings: Settings; removed: boolean } {
  const removed = !!settings.mcpServers?.[name];
  return { settings: removeMcpServerEntry(settings, name), removed };
}

/**
 * Project scope's mirror of `addUserMcpServer`, over the RAW `mcpServers` map
 * (`project-file.ts`'s `readRawProjectMcpConfig` result's own `servers` field) rather than a typed
 * `ProjectMcpConfig` — see this file's own header for why: the typed schema can't round-trip a
 * sibling entry it doesn't understand (an http/sse one, or a stdio one with an extra field), and a
 * write built on top of it would silently drop every one of those the moment it touched the file.
 * `servers` is otherwise untouched here except for the one name being added — every other key's
 * VALUE, whatever unknown shape it is, is copied through by reference. Stdio-only (that file's
 * format) — `mcp-cli.ts` refuses `--transport http`/`sse` at project scope before ever constructing
 * an entry to pass here, so this function never has to.
 */
export function addProjectMcpServer(servers: Record<string, unknown>, name: string, entry: ProjectMcpServerEntry): Record<string, unknown> {
  const nameErr = validateMcpServerName(name);
  if (nameErr) throw new Error(nameErr);
  if (Object.hasOwn(servers, name)) {
    throw new Error(`MCP server "${name}" already exists in this project's .mcp.json — remove it first or edit the file directly`);
  }
  return { ...servers, [name]: entry };
}

/** The project-scope remove door — same idempotent posture as `removeUserMcpServer`, over the same
 *  raw map `addProjectMcpServer` writes. */
export function removeProjectMcpServer(servers: Record<string, unknown>, name: string): { servers: Record<string, unknown>; removed: boolean } {
  if (!Object.hasOwn(servers, name)) return { servers, removed: false };
  const rest = { ...servers };
  delete rest[name];
  return { servers: rest, removed: true };
}

// ── WS-21: the user scope lives in `sdk/.winter.json` (claude's `.claude.json` shape) ─────────────
//
// `mcpServers` moved out of `settings.json` (spec §4.1). These are the daemon's user-scope doors
// now; the `Settings`-shaped pair above stays only for a caller that has not moved yet (the CLI's
// no-daemon fallback, lane L4). Same rules: the name is validated first (claude's shape + Winter's
// reserved capability namespace), a present name is never silently overwritten, and the entry is
// validated with the SAME schema — including the credential-shaped-header REFUSAL — that guarded
// `settings.mcpServers`, before anything is written. Every other key of the file is preserved.

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Add one USER-scope server to `sdk/.winter.json` `mcpServers`. Throws a plain `Error` (bad name,
 *  already present, invalid or credential-shaped entry) or `SdkFileUnreadable`; writes nothing then. */
export function addSdkUserMcpServer(home: string, name: string, entry: unknown): McpServerSettingsEntry {
  const nameErr = validateMcpServerName(name);
  if (nameErr) throw new Error(nameErr);
  const valid = validateMcpServerEntryForWrite(entry);
  updateSdkGlobalConfig(home, (config) => {
    const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
    if (Object.hasOwn(servers, name)) {
      throw new Error(`MCP server "${name}" already exists in user config — remove it first ("winter mcp remove ${name} --scope user") or edit sdk/.winter.json directly`);
    }
    return { ...config, mcpServers: { ...servers, [name]: valid } };
  });
  return valid;
}

/** Remove one USER-scope server from `sdk/.winter.json`. Idempotent: `false` when it was not there
 *  (and then the file is not rewritten at all). */
export function removeSdkUserMcpServer(home: string, name: string): boolean {
  const present = (config: SdkGlobalConfigFile): boolean => isRecord(config.mcpServers) && Object.hasOwn(config.mcpServers, name);
  const current = readSdkGlobalConfigDetailed(home);
  if (current.state === "missing" || (current.state === "ok" && !present(current.value))) return false;
  let removed = false;
  updateSdkGlobalConfig(home, (config) => {  // throws SdkFileUnreadable on an unparseable file
    if (!present(config)) return config;
    removed = true;
    const rest = { ...(config.mcpServers as Record<string, unknown>) };
    delete rest[name];
    return { ...config, mcpServers: rest };
  });
  return removed;
}

// ── WS-21 (spec §4.4): claude's three MCP scopes ────────────────────────────────────────────────────
//
//   local    (claude's default)  `sdk/.winter.json` → `projects[<canonical project root>].mcpServers`
//   user                         `sdk/.winter.json` → `mcpServers`
//   project                      `<project root>/.winter/mcp.json` (claude's `.mcp.json` format)
//
// `root` is the CANONICAL project root (`repoRootFor(cwd)`) — the key the run home's builder folds the
// local servers from and the directory it reads the project file in. The same validation as ever runs
// before anything is written: the name rule, no silent overwrite, and the entry schema — user and local
// entries live in the user's own file, so a credential-shaped header is REFUSED there (secrets never on
// disk); a project entry follows claude's own `.mcp.json` reader and forwards headers verbatim (the
// ruling in `project-file.ts`).

export type McpScope = "local" | "user" | "project";
export interface McpScopeTarget { home: string; scope: McpScope; root?: string }

/** A scope that names a project needs its root; `user` does not. */
function projectRootOf(t: McpScopeTarget): string {
  if (t.root === undefined || t.root === "") throw new Error(`the "${t.scope}" MCP scope names a project — a working directory is required`);
  return t.root;
}

/** The entry a scope holds under `name`, validated the way that scope's reader validates it, or
 *  `undefined` when absent (or not valid there). */
export function mcpServerInScope(t: McpScopeTarget, name: string): { type: "stdio" | "http" | "sse"; [key: string]: unknown } | undefined {
  if (t.scope === "user") return sdkUserMcpServers(t.home)[name];
  if (t.scope === "local") return sdkLocalMcpServers(t.home, projectRootOf(t))[name];
  const read = readRawProjectMcpConfig(projectRootOf(t));
  if (read.kind !== "ok") return undefined;
  return parseProjectMcpServers(read.servers).servers[name];
}

/** Add one server to a scope. Throws a plain `Error` (bad name, already present, invalid entry,
 *  credential-shaped header in user/local, an unreadable file) and writes nothing then. */
export function addMcpServerInScope(t: McpScopeTarget, name: string, entry: unknown): { type: "stdio" | "http" | "sse" } {
  if (t.scope === "user") return addSdkUserMcpServer(t.home, name, entry);
  const nameErr = validateMcpServerName(name);
  if (nameErr) throw new Error(nameErr);
  const root = projectRootOf(t);
  if (t.scope === "local") {
    const valid = validateMcpServerEntryForWrite(entry);
    updateSdkGlobalConfig(t.home, (config) => {
      const projects = isRecord(config.projects) ? config.projects : {};
      const project = isRecord(projects[root]) ? projects[root]! : {};
      const servers = isRecord(project.mcpServers) ? project.mcpServers : {};
      if (Object.hasOwn(servers, name)) {
        throw new Error(`MCP server "${name}" already exists in local config for ${root} — remove it first ("winter mcp remove ${name} --scope local")`);
      }
      return { ...config, projects: { ...projects, [root]: { ...project, mcpServers: { ...servers, [name]: valid } } } };
    });
    return valid;
  }
  const parsed = ProjectMcpEntrySchema.safeParse(entry);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  const read = readRawProjectMcpConfig(root);
  if (read.kind === "malformed") throw new Error(`${projectMcpConfigPath(root)} is not a readable MCP config — it was left untouched`);
  const current = read.kind === "ok" ? read : { raw: {}, servers: {} };
  if (Object.hasOwn(current.servers, name)) {
    throw new Error(`MCP server "${name}" already exists in this project's .winter/mcp.json — remove it first or edit the file directly`);
  }
  writeRawProjectMcpConfig(root, current.raw, { ...current.servers, [name]: entry });
  return parsed.data;
}

/** Remove one server from a scope. Idempotent: `false` when it was not there (nothing is rewritten). */
export function removeMcpServerInScope(t: McpScopeTarget, name: string): boolean {
  if (t.scope === "user") return removeSdkUserMcpServer(t.home, name);
  const root = projectRootOf(t);
  if (t.scope === "local") {
    const present = (c: SdkGlobalConfigFile): boolean => {
      const project = isRecord(c.projects) ? c.projects[root] : undefined;
      return isRecord(project) && isRecord(project.mcpServers) && Object.hasOwn(project.mcpServers, name);
    };
    const current = readSdkGlobalConfigDetailed(t.home);
    if (current.state === "missing" || (current.state === "ok" && !present(current.value))) return false;
    let removed = false;
    updateSdkGlobalConfig(t.home, (config) => {
      if (!present(config)) return config;
      removed = true;
      const projects = config.projects as Record<string, Record<string, unknown>>;
      const servers = { ...(projects[root]!.mcpServers as Record<string, unknown>) };
      delete servers[name];
      return { ...config, projects: { ...projects, [root]: { ...projects[root], mcpServers: servers } } };
    });
    return removed;
  }
  const read = readRawProjectMcpConfig(root);
  if (read.kind === "absent") return false;
  if (read.kind === "malformed") throw new Error(`${projectMcpConfigPath(root)} is not a readable MCP config — it was left untouched`);
  const { servers, removed } = removeProjectMcpServer(read.servers, name);
  if (removed) writeRawProjectMcpConfig(root, read.raw, servers);
  return removed;
}
