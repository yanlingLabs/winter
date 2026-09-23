// `winter plugin` — CLI parity with `claude plugin` (WS-21 spec §5.2), over Contract B
// (`@yanlinglabs/winter-core`'s `plugins/sdk-plugin-api.ts`). Same shape as `mcp-cli.ts`: main.ts owns
// argv slicing + printing + `process.exit`; every exported `run*Route` function here IS the full
// round trip (I/O via an injected `door` when the daemon answers, the adapter directly otherwise),
// returning a plain outcome object main.ts renders and exits on.
//
// DOOR VS. ADAPTER: `winter plugin install <p>[@<m>] [--scope ...]` "goes through the daemon when
// it is live, and the SDK adapter otherwise" (this task's own brief) — every route below takes an
// optional `PluginDoor`; when absent, it builds a `PluginManagerOptions` straight off the adapter
// and calls the SAME Contract B functions the daemon's own RPC handlers call
// (`ipc/server.ts`'s `pluginManagerOptionsFor`, mirrored here so the two paths can never disagree
// on where `user`/`project`/`local` write).
//
// "install from a folder" (spec §5.2, `plugins/lifecycle.ts`'s own header: "install means
// addMarketplace + installPlugin"): a bare filesystem path (no `@marketplace`) is registered as a
// directory marketplace and its one plugin installed, in one CLI command — over the adapter
// directly when there's no daemon (`installPluginFromDirectory`), or via TWO door calls
// (`pluginMarketplaceAdd` then `pluginInstall`) when there is one: the daemon has no "read this
// marketplace's manifest before it's registered" RPC, and does not need one — `readMarketplaceNames`
// below runs on the CLI's OWN filesystem, the same machine the folder lives on, whether or not a
// daemon answers the RPC that finishes the job.
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  directoryMarketplacePluginNames,
  installPluginFromDirectory,
  PluginManagerError,
  addMarketplace, installPlugin, listMarketplaces, listPlugins, removeMarketplace,
  setPluginEnabledScoped, uninstallPlugin, updateMarketplace, updatePlugin,
  sdkPluginsRoot, sdkSettingsPath, repoRootFor,
  type PluginManagerOptions, type PluginManagerScope,
  type MarketplaceInfo, type InstalledPlugin, type PluginListing,
} from "@yanlinglabs/winter-core";

export type PluginScope = PluginManagerScope; // "user" | "project" | "local"

/** Structural — matches the `WinterClient` methods the CLI's daemon path calls, so a test can hand
 *  in a plain fake instead of a real socket connection (same precedent as `mcp-cli.ts`'s `McpDoor`). */
export interface PluginDoor {
  pluginList(cwd?: string): Promise<{ ok: true; plugins: PluginListing[] }>;
  pluginInstall(spec: string, scope: PluginScope, cwd?: string): Promise<{ ok: true; plugin: InstalledPlugin }>;
  pluginUninstall(spec: string, scope: PluginScope, cwd?: string): Promise<{ ok: true; spec: string; scope: PluginScope }>;
  pluginSetEnabled(spec: string, scope: PluginScope, enabled: boolean, cwd?: string): Promise<{ ok: true; spec: string; scope: PluginScope; enabled: boolean }>;
  pluginUpdate(spec: string): Promise<{ ok: true; plugin: InstalledPlugin }>;
  pluginMarketplaceAdd(source: string): Promise<{ ok: true; marketplace: MarketplaceInfo }>;
  pluginMarketplaceRemove(name: string): Promise<{ ok: true; name: string }>;
  pluginMarketplaceList(): Promise<{ ok: true; marketplaces: MarketplaceInfo[] }>;
  pluginMarketplaceUpdate(name?: string): Promise<{ ok: true }>;
}

export interface PluginRouteDeps {
  cwd: string;
  winterHome: string;
  /** `undefined` when no daemon answered — every route falls back to a direct, in-process call
   *  through the adapter, the SAME Contract B functions the daemon's own RPC handlers call. */
  door?: PluginDoor;
}

// ------------------------------------------------------------------------------------------------
// Scope parsing (pure, no I/O) — claude's own default is "user" for `plugin install` (unlike `mcp
// add`'s "local"; see mcp-cli.ts's own header for why MCP differs).
// ------------------------------------------------------------------------------------------------

export type PluginScopeResolution = { kind: "ok"; scope: PluginScope } | { kind: "invalid"; message: string };

export function ensurePluginScope(raw?: string): PluginScopeResolution {
  if (!raw) return { kind: "ok", scope: "user" };
  if (raw === "user" || raw === "project" || raw === "local") return { kind: "ok", scope: raw };
  return { kind: "invalid", message: `invalid scope: ${raw}. Must be one of: user, project, local` };
}

// ------------------------------------------------------------------------------------------------
// PluginManagerOptions — the SAME scope resolution `ipc/server.ts`'s `pluginManagerOptionsFor`
// uses, so the no-daemon path and the daemon path can never write a scope to different files.
// ------------------------------------------------------------------------------------------------

export function pluginManagerOptionsFor(winterHome: string, cwd: string | undefined): PluginManagerOptions {
  return {
    pluginsRoot: sdkPluginsRoot(winterHome),
    settingsPathFor: (scope) => {
      if (scope === "user") return sdkSettingsPath(winterHome);
      if (!cwd) throw new PluginManagerError(`plugin scope "${scope}" requires a project directory — run this from inside one`);
      const root = repoRootFor(cwd);
      return resolve(root, ".winter", scope === "local" ? "settings.local.json" : "settings.json");
    },
  };
}

/** A directory marketplace's own plugin names, read straight off the CLI's local filesystem
 *  (`directoryMarketplacePluginNames`, `@yanlinglabs/winter-core`) — used by BOTH the no-daemon and
 *  daemon "install from a folder" paths, so a bare-path install always resolves the same plugin. */
function readMarketplacePluginNames(dir: string): string[] | { error: string } {
  try {
    return directoryMarketplacePluginNames(dir);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** True when `specOrPath` looks like a filesystem path to install FROM (a real directory), rather
 *  than a `"<name>@<marketplace>"` spec naming an ALREADY-registered marketplace. Mirrors claude's
 *  own "a bare local path installs directly" convenience (spec §5.2). */
function looksLikeDirectory(specOrPath: string): boolean {
  if (specOrPath.includes("@")) return false;
  const resolved = isAbsolute(specOrPath) ? specOrPath : resolve(specOrPath);
  try {
    return statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------
// Route functions — the full round trip. Nothing here prints or exits; main.ts's `case "plugin"` does.
// ------------------------------------------------------------------------------------------------

export type PluginInstallOutcome = { ok: true; plugin: InstalledPlugin; via: "daemon" | "local" } | { ok: false; message: string };

export async function runPluginInstallRoute(deps: PluginRouteDeps, specOrPath: string, scopeRaw: string | undefined, cwd?: string): Promise<PluginInstallOutcome> {
  const scopeResult = ensurePluginScope(scopeRaw);
  if (scopeResult.kind !== "ok") return { ok: false, message: scopeResult.message };
  const { scope } = scopeResult;
  const via = deps.door ? "daemon" as const : "local" as const;

  try {
    if (looksLikeDirectory(specOrPath)) {
      const dir = isAbsolute(specOrPath) ? specOrPath : resolve(specOrPath);
      if (!deps.door) {
        const plugin = await installPluginFromDirectory(pluginManagerOptionsFor(deps.winterHome, cwd), dir, scope);
        return { ok: true, plugin, via };
      }
      const names = readMarketplacePluginNames(dir);
      if (!Array.isArray(names)) return { ok: false, message: names.error };
      if (names.length !== 1) {
        return { ok: false, message: `${dir}: this folder lists ${names.length} plugin(s) — add it as a marketplace first (winter plugin marketplace add ${dir}) and install "<plugin>@<marketplace>" explicitly` };
      }
      const mktRes = await deps.door.pluginMarketplaceAdd(dir);
      const spec = `${names[0]}@${mktRes.marketplace.name}`;
      const installRes = await deps.door.pluginInstall(spec, scope, cwd);
      return { ok: true, plugin: installRes.plugin, via };
    }
    if (deps.door) {
      const res = await deps.door.pluginInstall(specOrPath, scope, cwd);
      return { ok: true, plugin: res.plugin, via };
    }
    const res = await installPlugin(pluginManagerOptionsFor(deps.winterHome, cwd), specOrPath, scope);
    return { ok: true, plugin: res, via };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type PluginUninstallOutcome = { ok: true; spec: string; scope: PluginScope } | { ok: false; message: string };

export async function runPluginUninstallRoute(deps: PluginRouteDeps, spec: string, scopeRaw: string | undefined, cwd?: string): Promise<PluginUninstallOutcome> {
  const scopeResult = ensurePluginScope(scopeRaw);
  if (scopeResult.kind !== "ok") return { ok: false, message: scopeResult.message };
  const { scope } = scopeResult;
  try {
    if (deps.door) {
      const res = await deps.door.pluginUninstall(spec, scope, cwd);
      return { ok: true, spec: res.spec, scope: res.scope };
    }
    await uninstallPlugin(pluginManagerOptionsFor(deps.winterHome, cwd), spec, scope);
    return { ok: true, spec, scope };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type PluginSetEnabledOutcome = { ok: true; spec: string; scope: PluginScope; enabled: boolean } | { ok: false; message: string };

export async function runPluginSetEnabledRoute(deps: PluginRouteDeps, spec: string, scopeRaw: string | undefined, enabled: boolean, cwd?: string): Promise<PluginSetEnabledOutcome> {
  const scopeResult = ensurePluginScope(scopeRaw);
  if (scopeResult.kind !== "ok") return { ok: false, message: scopeResult.message };
  const { scope } = scopeResult;
  try {
    if (deps.door) {
      const res = await deps.door.pluginSetEnabled(spec, scope, enabled, cwd);
      return { ok: true, spec: res.spec, scope: res.scope, enabled: res.enabled };
    }
    await setPluginEnabledScoped(pluginManagerOptionsFor(deps.winterHome, cwd), spec, scope, enabled);
    return { ok: true, spec, scope, enabled };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type PluginUpdateOutcome = { ok: true; plugin: InstalledPlugin } | { ok: false; message: string };

export async function runPluginUpdateRoute(deps: PluginRouteDeps, spec: string): Promise<PluginUpdateOutcome> {
  try {
    if (deps.door) {
      const res = await deps.door.pluginUpdate(spec);
      return { ok: true, plugin: res.plugin };
    }
    const plugin = await updatePlugin(pluginManagerOptionsFor(deps.winterHome, undefined), spec);
    return { ok: true, plugin };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type PluginListOutcome = { ok: true; plugins: PluginListing[] } | { ok: false; message: string };

export async function runPluginListRoute(deps: PluginRouteDeps, cwd?: string): Promise<PluginListOutcome> {
  try {
    if (deps.door) {
      const res = await deps.door.pluginList(cwd);
      return { ok: true, plugins: res.plugins };
    }
    const plugins = await listPlugins(pluginManagerOptionsFor(deps.winterHome, cwd));
    return { ok: true, plugins };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type PluginMarketplaceAddOutcome = { ok: true; marketplace: MarketplaceInfo } | { ok: false; message: string };

export async function runPluginMarketplaceAddRoute(deps: PluginRouteDeps, source: string): Promise<PluginMarketplaceAddOutcome> {
  try {
    if (deps.door) {
      const res = await deps.door.pluginMarketplaceAdd(source);
      return { ok: true, marketplace: res.marketplace };
    }
    const marketplace = await addMarketplace(pluginManagerOptionsFor(deps.winterHome, undefined), source);
    return { ok: true, marketplace };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type PluginMarketplaceRemoveOutcome = { ok: true; name: string } | { ok: false; message: string };

export async function runPluginMarketplaceRemoveRoute(deps: PluginRouteDeps, name: string): Promise<PluginMarketplaceRemoveOutcome> {
  try {
    if (deps.door) {
      const res = await deps.door.pluginMarketplaceRemove(name);
      return { ok: true, name: res.name };
    }
    await removeMarketplace(pluginManagerOptionsFor(deps.winterHome, undefined), name);
    return { ok: true, name };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type PluginMarketplaceListOutcome = { ok: true; marketplaces: MarketplaceInfo[] } | { ok: false; message: string };

export async function runPluginMarketplaceListRoute(deps: PluginRouteDeps): Promise<PluginMarketplaceListOutcome> {
  try {
    if (deps.door) {
      const res = await deps.door.pluginMarketplaceList();
      return { ok: true, marketplaces: res.marketplaces };
    }
    const marketplaces = await listMarketplaces(pluginManagerOptionsFor(deps.winterHome, undefined));
    return { ok: true, marketplaces };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type PluginMarketplaceUpdateOutcome = { ok: true } | { ok: false; message: string };

export async function runPluginMarketplaceUpdateRoute(deps: PluginRouteDeps, name?: string): Promise<PluginMarketplaceUpdateOutcome> {
  try {
    if (deps.door) {
      await deps.door.pluginMarketplaceUpdate(name);
      return { ok: true };
    }
    await updateMarketplace(pluginManagerOptionsFor(deps.winterHome, undefined), name);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// ------------------------------------------------------------------------------------------------
// Rendering (pure) — main.ts prints exactly what these return.
// ------------------------------------------------------------------------------------------------

function scopeLabel(scope: PluginScope): string {
  if (scope === "user") return "user (sdk/settings.json)";
  if (scope === "project") return "project (.winter/settings.json)";
  return "local (.winter/settings.local.json)";
}

export function renderPluginInstallOutcome(outcome: PluginInstallOutcome): string {
  if (!outcome.ok) return outcome.message;
  const versionNote = outcome.plugin.version ? ` v${outcome.plugin.version}` : "";
  return `installed ${outcome.plugin.id}${versionNote} at ${scopeLabel(outcome.plugin.scope)} — ${outcome.plugin.installPath}`;
}

export function renderPluginUninstallOutcome(outcome: PluginUninstallOutcome): string {
  if (!outcome.ok) return outcome.message;
  return `uninstalled ${outcome.spec} (${scopeLabel(outcome.scope)})`;
}

export function renderPluginSetEnabledOutcome(outcome: PluginSetEnabledOutcome): string {
  if (!outcome.ok) return outcome.message;
  return `${outcome.spec} ${outcome.enabled ? "enabled" : "disabled"} (${scopeLabel(outcome.scope)})`;
}

export function renderPluginUpdateOutcome(outcome: PluginUpdateOutcome): string {
  if (!outcome.ok) return outcome.message;
  const versionNote = outcome.plugin.version ? ` v${outcome.plugin.version}` : "";
  return `updated ${outcome.plugin.id}${versionNote}`;
}

export function renderPluginListOutcome(outcome: PluginListOutcome): string {
  if (!outcome.ok) return outcome.message;
  if (outcome.plugins.length === 0) return "no plugins installed";
  return outcome.plugins
    .map((p) => `${p.id}@${p.marketplace}${p.version ? ` v${p.version}` : ""}  ${scopeLabel(p.scope)}  ${p.enabled ? "enabled" : "disabled"}`)
    .join("\n");
}

export function renderPluginMarketplaceAddOutcome(outcome: PluginMarketplaceAddOutcome): string {
  if (!outcome.ok) return outcome.message;
  return `added marketplace "${outcome.marketplace.name}" (${outcome.marketplace.kind}, ${outcome.marketplace.source})`;
}

export function renderPluginMarketplaceRemoveOutcome(outcome: PluginMarketplaceRemoveOutcome): string {
  if (!outcome.ok) return outcome.message;
  return `removed marketplace "${outcome.name}"`;
}

export function renderPluginMarketplaceListOutcome(outcome: PluginMarketplaceListOutcome): string {
  if (!outcome.ok) return outcome.message;
  if (outcome.marketplaces.length === 0) return "no marketplaces registered";
  return outcome.marketplaces.map((m) => `${m.name}  ${m.kind}  ${m.source}`).join("\n");
}

export function renderPluginMarketplaceUpdateOutcome(outcome: PluginMarketplaceUpdateOutcome): string {
  return outcome.ok ? "marketplace(s) updated" : outcome.message;
}

// ------------------------------------------------------------------------------------------------
// Phase 4b Task 2 (kept, unchanged): best-effort daemon-side plugin token revoke. `plugin_tokens`
// lives in the daemon's own sqlite (SessionStore) — the CLI must NEVER open that database directly
// (lock-conflict risk with a running daemon) — so revocation goes through the harness-role
// `plugin.revokeToken` RPC instead. A down daemon is TOLERATED, not fatal.
// ------------------------------------------------------------------------------------------------

export async function revokePluginTokenBestEffort(
  revoke: (pluginId: string) => Promise<unknown>,
  pluginId: string,
): Promise<{ ok: boolean; note?: string }> {
  try {
    await revoke(pluginId);
    return { ok: true };
  } catch (err) {
    return { ok: false, note: `plugin token revoke skipped (daemon unreachable?): ${(err as Error).message}` };
  }
}

