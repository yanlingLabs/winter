// WS-21 (spec §5.2, Contract B): the daemon's door onto the agent SDK's plugin-management API
// (`@yanlinglabs/winter-agent-sdk`'s `plugins/manage.ts`: `winter plugin` = `claude plugin`).
//
// Everything here IS the SDK's: the same functions, types and `PluginManagerError` class, re-exported
// so every daemon/CLI call site imports one module. Two things are the daemon's own and are layered
// on top, because the SDK deliberately leaves them to its host:
//
//  1. F21 — a `local`-scope write lands in `<root>/.winter/settings.local.json`, a PERSONAL overlay
//     that must never be committed (claude parity; `agent/git-exclude.ts`'s own header). The SDK's
//     `manage.ts` says outright that it does not do this ("F21 … is NOT implemented here"), so every
//     local-scope `installPlugin`/`uninstallPlugin`/`setPluginEnabled` is followed here by the same
//     best-effort `ensureGlobalGitExclude(root)` L3's `agent/saved-answers.ts` uses. `project` scope
//     writes the team-shared `.winter/settings.json` (meant to be committed) and `user` scope never
//     touches a project tree, so neither needs it.
//
//  2. A pure LIST never fails over a scope it cannot resolve. `listPlugins` reads every installed
//     record's `enabled` through `settingsPathFor(record.scope)`; the daemon's and the CLI's
//     `settingsPathFor` THROW for `project`/`local` when the caller has no `cwd` in hand (a mutation
//     without a cwd must refuse, never write to the wrong tier). The SDK calls it unguarded, so a
//     list with a project-scope record anywhere would throw. Here such a scope reads as "not
//     enabled" — the same degrade a missing settings file gets — and mutations keep the throw.
import { dirname, join } from "node:path";
import * as sdk from "@yanlinglabs/winter-agent-sdk";
import type { InstalledPlugin, PluginListing, PluginManagerOptions, PluginScope } from "@yanlinglabs/winter-agent-sdk";
import { ensureGlobalGitExclude } from "../agent/git-exclude";

export {
  PluginManagerError, addMarketplace, listMarketplaces, removeMarketplace, updateMarketplace, updatePlugin,
} from "@yanlinglabs/winter-agent-sdk";
export type { InstalledPlugin, MarketplaceInfo, PluginListing, PluginManagerOptions, PluginScope } from "@yanlinglabs/winter-agent-sdk";

/** F21: after a successful `local`-scope write, keep `<root>/.winter/settings.local.json` out of git.
 *  `dirname(dirname(path))` recovers `<root>` from the two-level `.winter/settings.local.json` suffix
 *  every `settingsPathFor` implementation uses. Best-effort, never throws (`ensureGlobalGitExclude`'s
 *  own contract): a cosmetic excludes write never fails the plugin operation. */
function excludeLocalSettings(o: PluginManagerOptions, scope: PluginScope): void {
  if (scope !== "local") return;
  try {
    ensureGlobalGitExclude(dirname(dirname(o.settingsPathFor("local"))));
  } catch { /* best-effort, as above */ }
}

/**
 * WS-24: the marketplace half of a spec (`"<name>@<marketplace>"`) is now part of a plugin's IDENTITY in the
 * daemon — its supervisor key, the token it is minted, its PID file name (`<runDir>/plugins/<spec>.pid`)
 * and its tools' namespace (`plugin__<spec>__<tool>`). A name that could climb out of that PID directory
 * or truncate a C string is refused before anything is installed: a `/` or `\`, a `..`, a NUL. (The SDK
 * validates no marketplace name of its own; `__`, which only confuses the tool-name split, is warned about
 * by `PluginStore`, not refused.) `undefined` when acceptable or when the spec names no marketplace.
 */
export function marketplaceNameError(spec: string): string | undefined {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return undefined;
  const name = spec.slice(at + 1);
  if (name.length === 0) return `"${spec}" names an empty marketplace`;
  if (/[/\\\0]/.test(name) || name.includes("..")) return `marketplace name "${name.replace(/\0/g, "\\0")}" may not contain "/", "\\", ".." or a NUL`;
  return undefined;
}

export async function installPlugin(o: PluginManagerOptions, spec: string, scope: PluginScope): Promise<InstalledPlugin> {
  const refused = marketplaceNameError(spec);
  if (refused !== undefined) throw new sdk.PluginManagerError(refused);
  const installed = await sdk.installPlugin(o, spec, scope);
  excludeLocalSettings(o, scope);
  return installed;
}

export async function uninstallPlugin(o: PluginManagerOptions, spec: string, scope: PluginScope): Promise<void> {
  await sdk.uninstallPlugin(o, spec, scope);
  excludeLocalSettings(o, scope);
}

export async function setPluginEnabled(o: PluginManagerOptions, spec: string, scope: PluginScope, enabled: boolean): Promise<void> {
  await sdk.setPluginEnabled(o, spec, scope, enabled);
  excludeLocalSettings(o, scope);
}

export async function listPlugins(o: PluginManagerOptions): Promise<PluginListing[]> {
  const unresolved = new Set<PluginScope>();
  const listOptions: PluginManagerOptions = {
    pluginsRoot: o.pluginsRoot,
    settingsPathFor(scope) {
      try {
        return o.settingsPathFor(scope);
      } catch {
        unresolved.add(scope);
        // A path that names no settings file, so the SDK's read takes its "no such file" branch;
        // every listing at this scope is forced to `enabled: false` below regardless.
        return join(o.pluginsRoot, ".no-settings-for-unresolved-scope", scope, "settings.json");
      }
    },
  };
  const listed = await sdk.listPlugins(listOptions);
  return unresolved.size === 0 ? listed : listed.map((p) => (unresolved.has(p.scope) ? { ...p, enabled: false } : p));
}
