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
import { loadSettings, saveSettings, setConnectorToolPermission, setMcpServerEntry, removeMcpServerEntry, sdkLocalMcpServers, sdkUserMcpServers, validateMcpServerEntryForWrite } from "../../settings";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTOR_ALL_TOOLS } from "./connector-permissions";
import { mcpServerNameDefined, trustedProjectRoots } from "./server-names";
import { approvedProjectRulesDir, sdkSettingsPath } from "../paths";
import type { TrustStore } from "../trust";
import { ProjectMcpEntrySchema, parseProjectMcpServers, projectMcpConfigPath, readRawProjectMcpConfig, writeRawProjectMcpConfig } from "./project-file";
import { readSdkGlobalConfigDetailed, readSdkSettingsDetailed, updateSdkGlobalConfig, updateSdkSettings, type SdkGlobalConfigFile, type SdkSettingsFile } from "../../sdk-files";
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

// ── WS-27: rename within a scope, and the connector settings a remove or a rename leaves behind ─────
//
// `settings.json`'s `mcp.toolPermissions` and `mcp.disabled` — and claude-grammar rules in `sdk/settings.json`
// naming `mcp__<server>…` — are keyed by server NAME across every scope, so a remove or a rename cannot simply
// take the name's settings with it: another scope, a plugin, a subagent definition or a LIVE session (whose
// child keeps the servers it was spawned with until it restarts, while the table is read live) may still use
// the name. So a remove clears the row only once nothing uses the name (`mcpServerNameDefined` + the caller's
// `liveNames`), and a rename COPIES the settings to the new name first, renames the entry, and only then drops
// the old ones on the same condition — every intermediate state is at least as strict as the one before.
// A rename INTO a name something else already uses, or one that already holds stored values, is refused: the
// renamed server would silently take over another server's settings. A sign-in is keyed by the server's URL
// (`mcp-oauth:<url>`), never its name, so it follows a rename by itself and a remove leaves it for a re-add.
// Rules in files Winter does not own (a project's `.winter/settings*.json` / `permissions.local.json`) and in
// the read-only approved-rules record are never edited; a rename LISTS the ones that will not follow.

/** A rename refused before anything was written; `code` rides the RPC error's `data.code`. */
export class McpRenameRefusal extends Error {
  constructor(readonly code: "mcp_server_not_found" | "mcp_server_exists" | "mcp_server_name_in_use" | "mcp_rename_target_has_permissions" | "mcp_invalid_name", message: string) {
    super(message);
    this.name = "McpRenameRefusal";
  }
}

/** The scope's RAW server map (every entry, valid there or not). */
function rawServersInScope(t: McpScopeTarget): Record<string, unknown> {
  if (t.scope === "project") {
    const root = projectRootOf(t);
    const read = readRawProjectMcpConfig(root);
    if (read.kind === "malformed") throw new Error(`${projectMcpConfigPath(root)} is not a readable MCP config — it was left untouched`);
    return read.kind === "ok" ? read.servers : {};
  }
  const current = readSdkGlobalConfigDetailed(t.home);
  const config = current.state === "ok" ? current.value : {};
  if (t.scope === "user") return isRecord(config.mcpServers) ? config.mcpServers : {};
  const project = isRecord(config.projects) ? config.projects[projectRootOf(t)] : undefined;
  return isRecord(project) && isRecord(project.mcpServers) ? project.mcpServers : {};
}

/** Rename one server within a scope, keeping its entry byte-for-byte and its position. Throws `McpRenameRefusal`
 *  (a missing old name, a taken new one) or a plain `Error` (an unreadable file), writing nothing then. */
export function renameMcpServerInScope(t: McpScopeTarget, from: string, to: string): { type: "stdio" | "http" | "sse" } {
  const nameErr = validateMcpServerName(to);
  if (nameErr) throw new McpRenameRefusal("mcp_invalid_name", nameErr);
  const where = t.scope === "project" ? "this project's .winter/mcp.json" : t.scope === "local" ? `local config for ${projectRootOf(t)}` : "user config";
  const moveIn = (servers: Record<string, unknown>): Record<string, unknown> => {
    if (!Object.hasOwn(servers, from)) throw new McpRenameRefusal("mcp_server_not_found", `no MCP server named "${from}" in ${where}`);
    if (Object.hasOwn(servers, to)) throw new McpRenameRefusal("mcp_server_exists", `MCP server "${to}" already exists in ${where} — pick another name, or remove that one first`);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(servers)) out[k === from ? to : k] = v;   // same position, same entry
    return out;
  };
  const entry = mcpServerInScope(t, from);
  if (t.scope === "project") {
    const root = projectRootOf(t);
    const read = readRawProjectMcpConfig(root);
    if (read.kind === "malformed") throw new Error(`${projectMcpConfigPath(root)} is not a readable MCP config — it was left untouched`);
    writeRawProjectMcpConfig(root, read.kind === "ok" ? read.raw : {}, moveIn(read.kind === "ok" ? read.servers : {}));
  } else {
    updateSdkGlobalConfig(t.home, (config) => {
      if (t.scope === "user") return { ...config, mcpServers: moveIn(isRecord(config.mcpServers) ? config.mcpServers : {}) };
      const root = projectRootOf(t);
      const projects = isRecord(config.projects) ? config.projects : {};
      const project = isRecord(projects[root]) ? projects[root]! : {};
      return { ...config, projects: { ...projects, [root]: { ...project, mcpServers: moveIn(isRecord(project.mcpServers) ? project.mcpServers : {}) } } };
    });
  }
  return { type: entry?.type ?? "stdio" };
}

/** `settings` without any connector permission stored under `name` (every action and the all-actions value). */
export function forgetConnectorPermissions(settings: Settings, name: string): Settings {
  if (!Object.hasOwn(settings.mcp?.toolPermissions ?? {}, name)) return settings;
  return setConnectorToolPermission(settings, name, CONNECTOR_ALL_TOOLS, undefined, { resetTools: true });
}

/** `from`'s permission row and `mcp.disabled` membership, COPIED to `to` (never replacing a row `to` has). */
export function copyConnectorSettings(settings: Settings, from: string, to: string): { settings: Settings; carried: boolean } {
  let next = settings;
  let carried = false;
  const row = settings.mcp?.toolPermissions?.[from];
  if (row !== undefined && !Object.hasOwn(settings.mcp?.toolPermissions ?? {}, to)) {
    const table = { ...(settings.mcp?.toolPermissions ?? {}), [to]: row } as NonNullable<NonNullable<Settings["mcp"]>["toolPermissions"]>;
    next = { ...next, mcp: { ...next.mcp, toolPermissions: table } };
    carried = true;
  }
  const disabled = next.mcp?.disabled ?? [];
  if (disabled.includes(from) && !disabled.includes(to)) {
    next = { ...next, mcp: { ...next.mcp, disabled: [...disabled, to] } };
    carried = true;
  }
  return { settings: next, carried };
}

/** `from`'s permission row and `mcp.disabled` membership, dropped. */
export function dropConnectorSettings(settings: Settings, from: string): Settings {
  let next = forgetConnectorPermissions(settings, from);
  if ((next.mcp?.disabled ?? []).includes(from)) next = { ...next, mcp: { ...next.mcp, disabled: next.mcp!.disabled!.filter((n) => n !== from) } };
  return next;
}

// ── Claude-grammar rules that name a server (`mcp__<server>` or `mcp__<server>__…`) ──────────────────

/** Does a claude-grammar rule name `server` (its tool-name half is `mcp__<server>` or `mcp__<server>__…`)? */
export function ruleNamesMcpServer(rule: string, server: string): boolean {
  const open = rule.indexOf("(");
  const name = (open === -1 ? rule : rule.slice(0, open)).trim();
  const base = `mcp__${server}`;
  return name === base || name.startsWith(`${base}__`);
}

/** The rule with its server renamed (`mcp__<from>…` → `mcp__<to>…`); leading whitespace dropped. */
export function renameRuleServer(rule: string, from: string, to: string): string {
  const trimmed = rule.trimStart();
  return `mcp__${to}${trimmed.slice(`mcp__${from}`.length)}`;
}

const RULE_KINDS = ["allow", "ask", "deny"] as const;

/**
 * The OTHER servers a rule naming `mcp__<server>__<rest>` may name: a server name may itself contain `__`, so
 * `mcp__cf__prod__x` is `cf`'s `prod__x` OR `cf__prod`'s `x`, and a bare `mcp__cf__prod` may be server
 * `cf__prod` itself — one candidate `<server>__<prefix>` per `__` split of `<rest>`, plus `<server>__<rest>`.
 * Glob pieces are not candidates (no server is literally named with a `*`). `[]` for `mcp__<server>` itself.
 */
export function ruleServerCandidates(rule: string, server: string): string[] {
  const open = rule.indexOf("(");
  const name = (open === -1 ? rule : rule.slice(0, open)).trim();
  const base = `mcp__${server}__`;
  if (!name.startsWith(base)) return [];
  const rest = name.slice(base.length);
  const out: string[] = [];
  for (let sep = rest.indexOf("__"); sep !== -1; sep = rest.indexOf("__", sep + 1)) if (sep > 0) out.push(`${server}__${rest.slice(0, sep)}`);
  if (rest !== "") out.push(`${server}__${rest}`);
  return out.filter((c) => !c.includes("*"));
}

/** Is some OTHER server a rule may name in use? Returns that server (the rule is then ambiguous). */
type ServerInUse = (name: string) => boolean;
function ambiguousFor(rule: string, server: string, inUse: ServerInUse): string | undefined {
  return ruleServerCandidates(rule, server).find((c) => inUse(c));
}

const ambiguityNote = (file: string, rule: string, candidate: string): string =>
  `${file}: ${rule} (ambiguous — it may name server "${candidate}", which is in use; left as it is)`;

/**
 * `sdk/settings.json` `permissions.{allow,ask,deny}` with every rule naming `from` ALSO written for `to` —
 * except an AMBIGUOUS one (`ruleServerCandidates`: it may name another server that is in use), which is
 * neither copied nor later dropped and is reported in `ambiguous` instead.
 */
function withCopiedSdkRules(home: string, from: string, to: string, inUse: ServerInUse): { added: number; ambiguous: string[] } {
  let added = 0;
  const ambiguous: string[] = [];
  const current = readSdkSettingsDetailed(home);
  if (current.state !== "ok" || !isRecord(current.value.permissions)) return { added, ambiguous };
  const perms0 = current.value.permissions as Record<string, unknown>;
  const needs = RULE_KINDS.some((k) => Array.isArray(perms0[k]) && (perms0[k] as unknown[]).some((r) => typeof r === "string" && ruleNamesMcpServer(r, from)));
  if (!needs) return { added, ambiguous };
  updateSdkSettings(home, (settings) => {
    added = 0;
    ambiguous.length = 0;
    const perms: Record<string, unknown> = isRecord(settings.permissions) ? { ...settings.permissions } : {};
    for (const k of RULE_KINDS) {
      const list = perms[k];
      if (!Array.isArray(list)) continue;
      const next: unknown[] = [];
      for (const r of list) {
        next.push(r);
        if (typeof r !== "string" || !ruleNamesMcpServer(r, from)) continue;
        const other = ambiguousFor(r, from, inUse);
        if (other !== undefined) { ambiguous.push(ambiguityNote(sdkSettingsPath(home), r, other)); continue; }
        const renamed = renameRuleServer(r, from, to);
        if (!list.includes(renamed) && !next.includes(renamed)) { next.push(renamed); added++; }
      }
      perms[k] = next;
    }
    return { ...settings, permissions: perms as SdkSettingsFile["permissions"] };
  });
  return { added, ambiguous };
}

/**
 * `sdk/settings.json` without the rules that name `server`. With `inUse`, an AMBIGUOUS rule (it may name
 * another server in use) is kept and reported. Without it every rule naming `server` goes — used only for a
 * rename's rollback, where the new name provably had no rules before (the rename refuses otherwise), so the
 * rules naming it are exactly the ones the rename copied.
 */
function withoutSdkRules(home: string, server: string, inUse?: ServerInUse): { dropped: number; ambiguous: string[] } {
  let dropped = 0;
  const ambiguous: string[] = [];
  const current = readSdkSettingsDetailed(home);
  if (current.state !== "ok" || !isRecord(current.value.permissions)) return { dropped, ambiguous };
  const perms0 = current.value.permissions as Record<string, unknown>;
  if (!RULE_KINDS.some((k) => Array.isArray(perms0[k]) && (perms0[k] as unknown[]).some((r) => typeof r === "string" && ruleNamesMcpServer(r, server)))) return { dropped, ambiguous };
  updateSdkSettings(home, (settings) => {
    dropped = 0;
    ambiguous.length = 0;
    const perms: Record<string, unknown> = isRecord(settings.permissions) ? { ...settings.permissions } : {};
    for (const k of RULE_KINDS) {
      const list = perms[k];
      if (!Array.isArray(list)) continue;
      perms[k] = list.filter((r) => {
        if (typeof r !== "string" || !ruleNamesMcpServer(r, server)) return true;
        const other = inUse === undefined ? undefined : ambiguousFor(r, server, inUse);
        if (other !== undefined) { ambiguous.push(ambiguityNote(sdkSettingsPath(home), r, other)); return true; }
        dropped++;
        return false;
      });
    }
    return { ...settings, permissions: perms as SdkSettingsFile["permissions"] };
  });
  return { dropped, ambiguous };
}

/** Does `sdk/settings.json` hold any rule naming `server`? */
function sdkHasRulesNaming(home: string, server: string): boolean {
  const current = readSdkSettingsDetailed(home);
  if (current.state !== "ok" || !isRecord(current.value.permissions)) return false;
  const perms = current.value.permissions as Record<string, unknown>;
  return RULE_KINDS.some((k) => Array.isArray(perms[k]) && (perms[k] as unknown[]).some((r) => typeof r === "string" && ruleNamesMcpServer(r, server)));
}

/** Every string in a JSON value (bounded depth) — for LISTING rules in files Winter never edits. */
function stringsIn(value: unknown, out: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out, depth + 1);
  else if (isRecord(value)) for (const v of Object.values(value)) stringsIn(v, out, depth + 1);
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/**
 * The rules naming `from` that a rename will NOT carry: those in a trusted project's own `.winter/settings.json`,
 * `.winter/settings.local.json` and `.winter/permissions.local.json` (repository files) and in the read-only
 * approved-rules record `<home>/permissions/projects.json`. Each as `"<file>: <rule>"`.
 */
export function rulesThatWillNotFollow(home: string, from: string, ctx: McpNameContext): string[] {
  const out: string[] = [];
  const collect = (file: string, value: unknown): void => {
    if (value === undefined) return;
    const found: string[] = [];
    stringsIn(value, found);
    for (const r of new Set(found)) if (ruleNamesMcpServer(r, from)) out.push(`${file}: ${r}`);
  };
  for (const root of trustedProjectRoots({ cwd: ctx.cwd, trust: ctx.trust, allTrusted: true })) {
    for (const f of ["settings.json", "settings.local.json", "permissions.local.json"]) {
      const file = join(root, ".winter", f);
      const json = readJson(file);
      collect(file, f === "permissions.local.json" ? json : (isRecord(json) ? json.permissions : undefined));
    }
  }
  const record = join(approvedProjectRulesDir(home), "projects.json");
  const json = readJson(record);
  collect(record, isRecord(json) ? json.projects : undefined);
  return out;
}

/** `<home>/settings.json`, or `undefined` when the home has none yet (nothing is stored in it then). */
function settingsIfPresent(path: string): Settings | undefined {
  return existsSync(path) ? loadSettings(path) : undefined;
}

/** What a remove or a rename saw of the name's other users, and where to read trust. */
export interface McpNameContext {
  cwd?: string | undefined;
  trust?: Pick<TrustStore, "isTrusted" | "list"> | undefined;
  /** The daemon's LIVE sessions' server names (a child keeps its servers until it restarts). */
  liveNames?: (() => Iterable<string>) | undefined;
}

/** Is `name` still used — defined anywhere (`mcpServerNameDefined`) or connected in a live session? */
function nameInUse(home: string, name: string, ctx: McpNameContext): boolean {
  try {
    for (const live of ctx.liveNames?.() ?? []) if (live === name) return true;
  } catch { return true; }   // cannot tell: keep the settings
  return mcpServerNameDefined(home, name, ctx);
}

/** `inUse` for a rule's other candidate servers: defined or live (`nameInUse`), or holding a stored row. */
function candidateInUse(home: string, ctx: McpNameContext, settings: Settings | undefined): ServerInUse {
  const seen = new Map<string, boolean>();
  return (name) => {
    let v = seen.get(name);
    if (v === undefined) {
      v = Object.hasOwn(settings?.mcp?.toolPermissions ?? {}, name) || nameInUse(home, name, ctx);
      seen.set(name, v);
    }
    return v;
  };
}

/**
 * THE remove door with its settings half, shared by `mcp.remove` and the CLI's no-daemon path: remove `name`
 * from the scope, then — when something was removed and nothing uses the name any more — drop its connector
 * permissions and the `sdk/settings.json` rules naming it (an ambiguous rule stays and is listed, as are rules
 * in files Winter does not edit). Once the entry is removed the call reports it removed: a failure on the settings half is
 * `permissionsNote`, never an error. `settings` is the written file when it changed.
 */
export interface McpRemoveOutcomeCore {
  removed: boolean;
  permissionsCleared: boolean;
  /** Rules naming the server dropped from `sdk/settings.json` (only once the name is unused). */
  rulesDropped: number;
  /** Rules naming it that stay: in files Winter does not edit, or ambiguous in `sdk/settings.json`. */
  rulesNotFollowed: string[];
  permissionsNote?: string;
  settings?: Settings;
}

export function removeMcpServerForgettingPermissions(t: McpScopeTarget, name: string, ctx: McpNameContext): McpRemoveOutcomeCore {
  const removed = removeMcpServerInScope(t, name);
  const none = { removed, permissionsCleared: false, rulesDropped: 0, rulesNotFollowed: [] as string[] };
  if (!removed) return none;
  try {
    if (nameInUse(t.home, name, ctx)) return none;
    const path = join(t.home, "settings.json");
    const current = settingsIfPresent(path);
    // The rules first (they reference the row's server only by name), then the row.
    const rules = withoutSdkRules(t.home, name, candidateInUse(t.home, ctx, current));
    const rulesNotFollowed = [...rules.ambiguous, ...rulesThatWillNotFollow(t.home, name, ctx)];
    const base = { removed, rulesDropped: rules.dropped, rulesNotFollowed };
    if (current === undefined) return { ...base, permissionsCleared: false };
    const next = forgetConnectorPermissions(current, name);
    if (next === current) return { ...base, permissionsCleared: false };
    saveSettings(path, next);
    return { ...base, permissionsCleared: true, settings: next };
  } catch (err) {
    return { ...none, permissionsNote: `the server was removed, but its connector settings could not be cleared (${err instanceof Error ? err.message : "unknown"}) — clear them with winter mcp permissions ${name} '*' default` };
  }
}

export interface McpRenameOutcomeCore {
  type: "stdio" | "http" | "sse";
  carried: boolean;
  keptOld: boolean;
  /** Rules in `sdk/settings.json` rewritten (copied) for the new name. */
  rulesCarried: number;
  /** Rules naming the old server in files Winter does not edit (`rulesThatWillNotFollow`). */
  rulesNotFollowed: string[];
  /** A failure AFTER the rename (dropping the old name's settings) — the rename itself stands. */
  note?: string;
  settings?: Settings;
}

/**
 * THE rename door with its settings half, shared by `mcp.rename` and the CLI's no-daemon path.
 *   1. Refuse (typed, nothing written): an invalid new name, an old name the scope lacks, a new name the scope
 *      has, a new name anything else uses (`mcp_server_name_in_use`), or one that already holds stored values
 *      (`mcp_rename_target_has_permissions`).
 *   2. COPY the old name's permission row, `mcp.disabled` membership and `sdk/settings.json` rules to the new
 *      name (the old ones stay — never less strict).
 *   3. Rename the entry in the scope (a failure here takes the copies back, best effort, and rethrows).
 *   4. Drop the old name's settings and rules unless something still uses the old name (`keptOld`).
 */
export function renameMcpServerCarryingSettings(t: McpScopeTarget, from: string, to: string, ctx: McpNameContext): McpRenameOutcomeCore {
  const nameErr = validateMcpServerName(to);
  if (nameErr) throw new McpRenameRefusal("mcp_invalid_name", nameErr);
  const scopeServers = rawServersInScope(t);
  const where = t.scope === "project" ? "this project's .winter/mcp.json" : t.scope === "local" ? "local config" : "user config";
  if (!Object.hasOwn(scopeServers, from)) throw new McpRenameRefusal("mcp_server_not_found", `no MCP server named "${from}" in ${where}`);
  if (Object.hasOwn(scopeServers, to)) throw new McpRenameRefusal("mcp_server_exists", `MCP server "${to}" already exists in ${where} — pick another name, or remove that one first`);
  if (nameInUse(t.home, to, ctx)) {
    throw new McpRenameRefusal("mcp_server_name_in_use", `"${to}" is already a server's name elsewhere (another scope, a plugin, a subagent definition or a live session) — connector settings are keyed by name, so the renamed server would take over that one's; pick another name`);
  }
  const path = join(t.home, "settings.json");
  const before = settingsIfPresent(path);
  if (before !== undefined && Object.hasOwn(before.mcp?.toolPermissions ?? {}, to)) {
    throw new McpRenameRefusal("mcp_rename_target_has_permissions", `"${to}" already has connector permissions stored — clear them first (winter mcp permissions ${to} '*' default)`);
  }
  // …or leftover RULES naming it (`mcp__<to>`, `mcp__<to>__…`), in Winter's own `sdk/settings.json` or in files
  // Winter does not edit: the renamed server would silently take them over.
  const leftover = [...(sdkHasRulesNaming(t.home, to) ? [sdkSettingsPath(t.home)] : []), ...rulesThatWillNotFollow(t.home, to, ctx)];
  if (leftover.length > 0) {
    throw new McpRenameRefusal("mcp_rename_target_has_permissions", `rules already name "${to}" (${leftover.join("; ")}) — remove them first, or pick another name`);
  }
  // 2. Copy first.
  let carried = false;
  let written: Settings | undefined;
  if (before !== undefined) {
    const copy = copyConnectorSettings(before, from, to);
    if (copy.settings !== before) { saveSettings(path, copy.settings); written = copy.settings; }
    carried = copy.carried;
  }
  // 3. Rename the entry (after the rules are copied too). Any failure from here takes the copies back.
  let rulesCarried = 0;
  let ambiguous: string[] = [];
  let type: McpRenameOutcomeCore["type"];
  const inUse = candidateInUse(t.home, ctx, before);
  try {
    ({ added: rulesCarried, ambiguous } = withCopiedSdkRules(t.home, from, to, inUse));
    ({ type } = renameMcpServerInScope(t, from, to));
  } catch (err) {
    try {
      if (written !== undefined) {
        const now = loadSettings(path);
        saveSettings(path, before?.mcp?.disabled?.includes(to) === true ? forgetConnectorPermissions(now, to) : dropConnectorSettings(now, to));
        written = undefined;
      }
      // Exact: `to` provably had no rules before (refused above otherwise), so every rule naming it now is
      // one this rename copied.
      if (rulesCarried > 0) withoutSdkRules(t.home, to);
    } catch { /* best effort: settings on a name nothing defines are inert */ }
    throw err;
  }
  const rulesNotFollowed = [...ambiguous, ...rulesThatWillNotFollow(t.home, from, ctx)];
  // 4. Drop the old name's settings — unless it is still in use.
  let keptOld = true;
  let note: string | undefined;
  try {
    keptOld = nameInUse(t.home, from, ctx);
    if (!keptOld) {
      const current = settingsIfPresent(path);
      if (current !== undefined) {
        const next = dropConnectorSettings(current, from);
        if (next !== current) { saveSettings(path, next); written = next; }
      }
      // Every unambiguous rule naming `from` was copied; the ambiguous ones stay (same `inUse`).
      if (rulesCarried > 0) withoutSdkRules(t.home, from, inUse);
    }
  } catch (err) {
    note = `renamed, but the old name's connector settings could not be dropped (${err instanceof Error ? err.message : "unknown"}) — they apply to nothing now`;
  }
  return { type, carried, keptOld, rulesCarried, rulesNotFollowed, ...(note !== undefined ? { note } : {}), ...(written !== undefined ? { settings: written } : {}) };
}
