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
import { setMcpServerEntry, removeMcpServerEntry } from "../../settings";
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
