// Pure plugin-lifecycle logic (Settings -> Settings transforms + fs helpers), shared by the CLI
// (packages/cli/src/plugin-cli.ts, which re-exports these) and, from Phase 4d-ii on, the
// over-the-wire plugin RPCs — both need this without the CLI's network-touching `installPlugin`
// (git clone), which stays CLI-only. Phase 4d-ii Task 1: pure refactor, no behavior change.
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Settings } from "../settings";

/** git-url basename minus a trailing `.git`, unless an explicit override is given. */
export function deriveInstallName(url: string, override?: string): string {
  if (override) return override;
  const last = url.replace(/\/+$/, "").split("/").pop();
  if (!last) throw new Error(`cannot derive a plugin name from ${url} — pass one explicitly`);
  return last.replace(/\.git$/, "");
}

/**
 * Resolve `<pluginsRoot>/<name>`, refusing anything that would resolve outside pluginsRoot
 * (e.g. name = "../x" or an absolute path). Throws rather than returning null so call sites
 * can't forget to check.
 */
export function resolvePluginTarget(pluginsRoot: string, name: string): string {
  const root = resolve(pluginsRoot);
  const target = resolve(root, name);
  if (!name || target === root || !target.startsWith(root + sep)) {
    throw new Error(`invalid plugin name: ${name}`);
  }
  return target;
}

export interface InstallPluginResult { name: string; target: string }

/**
 * Copy a local directory `sourceDir` into `<pluginsRoot>/<name>` — the folder-install analog of
 * the CLI's git-clone `installPlugin`, for callers (e.g. the coming plugin-install RPC) that
 * already have plugin contents on disk rather than a git URL. Like `installPlugin`, NEVER touches
 * settings.json (installing a plugin must not silently enable any MCP servers it bundles — the
 * fresh-consent rule lives in enable/disable). Throws on: invalid/traversal name, an existing
 * target dir, or a sourceDir with neither `winter-plugin.json` nor `plugin.json` (no plugin here).
 */
export function installPluginFromDir(sourceDir: string, name: string, pluginsRoot: string): InstallPluginResult {
  const target = resolvePluginTarget(pluginsRoot, name);
  if (existsSync(target)) throw new Error(`${name} already exists at ${target}`);
  const hasManifest = existsSync(resolve(sourceDir, "winter-plugin.json")) || existsSync(resolve(sourceDir, "plugin.json"));
  if (!hasManifest) throw new Error(`${sourceDir} has no winter-plugin.json or plugin.json — not a plugin`);
  cpSync(sourceDir, target, { recursive: true });
  return { name, target };
}

/** Enable: add to enabled, remove from disabled. Disable: add to disabled, remove from enabled
 *  (fresh-consent rule — re-enabling after a disable is a deliberate act, not automatic).
 *  Preserves `settings.plugins.consents` untouched (Task 3: this used to rebuild `plugins` from
 *  scratch with only {enabled, disabled}, silently dropping any consent records — callers that
 *  need to strip consents do so explicitly via `stripPluginConsents`). */
export function setPluginEnabled(settings: Settings, name: string, enabled: boolean): Settings {
  const en = new Set(settings.plugins?.enabled ?? []);
  const dis = new Set(settings.plugins?.disabled ?? []);
  if (enabled) { en.add(name); dis.delete(name); } else { dis.add(name); en.delete(name); }
  return { ...settings, plugins: { ...settings.plugins, enabled: [...en], disabled: [...dis] } };
}

/** Consent classes a plugin's manifest requires but doesn't yet have a record for — the CLI's
 *  "is the consent block needed" check (design spec §1: exec/tcc/hardware content is spawnable/
 *  loadable ONLY once every declared class has a consent record). */
export function missingConsents(requiredConsents: string[], consented: string[]): string[] {
  return requiredConsents.filter((c) => !consented.includes(c));
}

/** The shape `buildConsentBlock` needs — a structural subset of core's `PluginInfo` (and of the
 *  `plugins.list` RPC result), so callers can pass either directly. */
export interface ConsentBlockPlugin {
  name: string;
  requiredConsents: string[];
  execPayload: string[];
  tccPermissions: string[];
  hardwarePermissions: string[];
}

/**
 * Pure consent-block line builder (design spec §1: "Consent text always shows the exec payload
 * (commands to be run), never just a summary."). Header, then one line per required class in the
 * fixed exec → tcc → hardware order (matches PluginStore's CONSENT_CLASSES order):
 *   - exec: every `execPayload` line verbatim (already self-describing — "mcp: …", "hook(…): …",
 *     "entry: …" — no extra prefix).
 *   - tcc: one "will request macOS permission: <perm>" line per `tccPermissions` entry.
 *   - hardware: one "hardware access via Winter.app helper: <perm>" line per `hardwarePermissions`
 *     entry.
 * Does NOT include the trailing `type "yes" to consent:` prompt — that's printed by the caller's
 * own `readLine` call, since it's an input prompt, not a disclosure line.
 */
export function buildConsentBlock(info: ConsentBlockPlugin): string[] {
  const lines: string[] = [`plugin ${info.name} requests:`];
  // Fixed exec → tcc → hardware order (matches PluginStore's CONSENT_CLASSES), independent of
  // whatever order requiredConsents happens to list them in.
  if (info.requiredConsents.includes("exec")) lines.push(...info.execPayload);
  if (info.requiredConsents.includes("tcc")) {
    for (const perm of info.tccPermissions) lines.push(`will request macOS permission: ${perm}`);
  }
  if (info.requiredConsents.includes("hardware")) {
    for (const perm of info.hardwarePermissions) lines.push(`hardware access via Winter.app helper: ${perm}`);
  }
  return lines;
}

/** Record a fresh consent timestamp (Date.now() at grant time, per class) for `name`, merging
 *  into any existing record — for this plugin's OTHER already-granted classes, and for every
 *  OTHER plugin's records, which are left untouched. Unrecognized class strings are ignored
 *  (defensive — `classes` normally comes straight from a plugin's own `requiredConsents`). */
export function grantPluginConsents(settings: Settings, name: string, classes: string[], ts: number): Settings {
  const consents = { ...(settings.plugins?.consents ?? {}) };
  const record = { ...(consents[name] ?? {}) };
  for (const c of classes) {
    if (c === "exec" || c === "tcc" || c === "hardware") record[c] = ts;
  }
  consents[name] = record;
  return { ...settings, plugins: { ...settings.plugins, consents } };
}

/**
 * grantPluginConsents + setPluginEnabled, composed against a FRESHLY read settings snapshot
 * rather than one captured before an interactive prompt. `enable`'s consent flow reads settings
 * once just to decide whether the consent block is even needed, then waits on a human-scale
 * `readLine` for "yes" — a settings.json edit landing during that wait (e.g. `winter plugin
 * disable` run concurrently from another shell) would otherwise be silently clobbered by writing
 * back whatever object the pre-prompt read produced. `readSettings` is injected (this function
 * never opens the file itself) so the caller controls read timing — call it AFTER the prompt
 * resolves — and tests can simulate a concurrent edit without a real settings file.
 */
export function applyFreshPluginConsent(readSettings: () => Settings, name: string, classes: string[], ts: number): Settings {
  return setPluginEnabled(grantPluginConsents(readSettings(), name, classes, ts), name, true);
}

/** Delete `name`'s whole consent record (design spec: `disable` = fresh-consent semantics,
 *  generalized from today's enabled-strip — re-enabling after a disable requires consenting
 *  again). A no-op when there's nothing to delete (returns `settings` unchanged, not a copy). */
export function stripPluginConsents(settings: Settings, name: string): Settings {
  if (!settings.plugins?.consents?.[name]) return settings;
  const consents = { ...settings.plugins.consents };
  delete consents[name];
  return { ...settings, plugins: { ...settings.plugins, consents } };
}

/** Strip `name` from both the enabled and disabled lists (used when removing a plugin). Preserves
 *  other plugins' consent records and explicitly strips the removed plugin's own record
 *  (fresh-consent: reinstalling under the same name cannot inherit consents). */
export function removePluginFromSettings(settings: Settings, name: string): Settings {
  if (!settings.plugins) return settings;
  let result = {
    ...settings,
    plugins: {
      ...settings.plugins,
      enabled: (settings.plugins.enabled ?? []).filter((n) => n !== name),
      disabled: (settings.plugins.disabled ?? []).filter((n) => n !== name),
    },
  };
  return stripPluginConsents(result, name);
}

/** Validate + delete `<pluginsRoot>/<name>` (path-containment + existence checked). Returns the
 *  removed path. Does not touch settings — callers combine this with removePluginFromSettings. */
export function removePluginDir(pluginsRoot: string, name: string): string {
  const target = resolvePluginTarget(pluginsRoot, name);
  if (!existsSync(target)) throw new Error(`no such plugin: ${name}`);
  rmSync(target, { recursive: true, force: true });
  return target;
}
