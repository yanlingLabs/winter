// Pure/isolatable logic behind `winter plugin ...`, split out of main.ts so it can be
// unit-tested without going through the top-level `if (import.meta.main)` dispatch.
//
// Phase 4d-ii Task 1: the reusable pure Settings-transform + fs helpers moved to
// `@yanlinglabs/winter-core`'s `plugins/lifecycle.ts` (so the coming plugin-lifecycle RPCs, which live in
// @yanlinglabs/winter-core and can't import from @yanlinglabs/winter-cli, can share them). They're re-exported below so
// every existing import site in this package (main.ts, tests) still resolves identically — a
// pure refactor, no behavior change. Only what's genuinely CLI-specific stays defined here:
// `installPlugin` (network — git clone), `installNeedsConsentHint`, `revokePluginTokenBestEffort`.
import { existsSync, mkdirSync } from "node:fs";
import {
  applyFreshPluginConsent,
  buildConsentBlock,
  deriveInstallName,
  grantPluginConsents,
  missingConsents,
  removePluginDir,
  removePluginFromSettings,
  resolvePluginTarget,
  setPluginEnabled,
  stripPluginConsents,
  type ConsentBlockPlugin,
} from "@yanlinglabs/winter-core";

export {
  applyFreshPluginConsent,
  buildConsentBlock,
  deriveInstallName,
  grantPluginConsents,
  missingConsents,
  removePluginDir,
  removePluginFromSettings,
  resolvePluginTarget,
  setPluginEnabled,
  stripPluginConsents,
  type ConsentBlockPlugin,
};

export interface InstallPluginResult { name: string; target: string }

/**
 * Clone `url` into `<pluginsRoot>/<name>`. NEVER touches settings.json — installing a plugin
 * must not silently enable any MCP servers it bundles (fresh-consent rule lives in enable/disable).
 * Throws on: invalid/traversal name, an existing target dir, or a failed `git clone`.
 */
export function installPlugin(opts: { url: string; name?: string; pluginsRoot: string }): InstallPluginResult {
  const name = deriveInstallName(opts.url, opts.name);
  const target = resolvePluginTarget(opts.pluginsRoot, name);
  if (existsSync(target)) throw new Error(`${name} already exists at ${target}`);
  mkdirSync(opts.pluginsRoot, { recursive: true });
  const proc = Bun.spawnSync(["git", "clone", "--depth", "1", opts.url, target]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString() || `git clone failed for ${opts.url}`);
  return { name, target };
}

/** True when `winter plugin install`'s post-install message should print the "review and consent"
 *  hint. Two independent ways a freshly installed plugin can bring in something that needs a
 *  human's consent before it runs: `hasMcp` (a legacy `.mcp.json` file) or
 *  `requiredConsents.length > 0` (a winter-plugin.json manifest declaring ANY exec/tcc/hardware
 *  content — contributes.mcpServers, contributes.hooks, an entry point, or explicit
 *  permissions.exec/tcc/hardware). requiredConsentClasses (plugin-manifest.ts) always derives
 *  "exec" whenever contributes.mcpServers is non-empty, so this subsumes a manifest-only plugin
 *  (contributes.mcpServers, no .mcp.json) — hasMcp:false but requiredConsents:["exec"] — which
 *  checking hasMcp alone missed entirely: the plugin installed with zero mention of the code it
 *  can execute (final-review fix). */
export function installNeedsConsentHint(info: { hasMcp: boolean; requiredConsents: string[] }): boolean {
  return info.hasMcp || info.requiredConsents.length > 0;
}

/**
 * Best-effort daemon-side token revoke for `disable`/`remove` (Phase 4b Task 2). `plugin_tokens`
 * lives in the daemon's own sqlite (SessionStore) — the CLI must NEVER open that database
 * directly (it risks a lock conflict with a running daemon) — so revocation goes through the
 * harness-role `plugin.revokeToken` RPC instead. A down daemon (no socket, no harness token yet,
 * a timed-out request, …) is TOLERATED, not fatal: disable/remove must keep working exactly as
 * they always have when the daemon isn't running; the caller just gets a note to surface.
 *
 * `revoke` is injected (connect + call + close, supplied by the caller) so this stays unit-
 * testable without a real socket — pass a function that resolves on success or rejects with
 * whatever error the connect/RPC layer produced.
 */
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
