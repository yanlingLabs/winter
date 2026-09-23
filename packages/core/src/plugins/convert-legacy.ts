// WS-21 (spec §8 step 6): converts every plugin at the legacy `<home>/plugins/<id>` layout into a
// claude-shaped install under `<home>/sdk/plugins/marketplaces/winter-legacy/plugins/<id>/`,
// registered through the Contract B adapter (`plugins/sdk-plugin-api.ts`) as one directory
// marketplace ("winter-legacy") with one plugin entry per converted id.
//
// COPIES, NEVER MOVES: the legacy `<home>/plugins/<id>` directory is left exactly as it was — a
// downgrade to an older Winter still finds it there (spec §2.1/§8's own "originals kept for
// downgrade" rule). Migration C (`winter migrate --sdk-home`, L3-owned) calls this function as its
// step 6; this module has no daemon-boot call site of its own.
//
// Field/event mapping (spec §5.1):
//  - a legacy `winter-plugin.json`'s `contributes.mcpServers` becomes the converted plugin's own
//    `.mcp.json` (claude's own project-MCP shape, `{mcpServers: {<name>: {command,args?,env?}}}`);
//    an EXISTING `.mcp.json` the legacy plugin already shipped is preserved and the manifest's own
//    servers are overlaid onto it (manifest wins on a name clash — the pre-WS-21 daemon's own rule,
//    `agent/mcp/manager.ts`'s header);
//  - `contributes.hooks` becomes `hooks/hooks.json` (claude's own shape,
//    `{<Event>: [{hooks:[{type:"command",command,timeout?}]}]}`), one event group per legacy hook,
//    `timeoutMs` converted to `timeout` in SECONDS (claude's own unit — measured off the pinned
//    binary via lane L1b's own `from-config.ts`: `timeoutMs: timeout * 1000`), and the four legacy
//    event names mapped to claude's own: `session-start`→`SessionStart`, `pre-tool`→`PreToolUse`,
//    `post-tool`→`PostToolUse`, `turn-end`→`Stop`;
//  - `contributes.{skills,agents}` need no field mapping — a legacy plugin's `skills/`/`agents/`
//    directories are already claude-shaped (the same `skills/<name>/SKILL.md` layout WS-11 already
//    used) and simply come along in the directory copy;
//  - the narrowed extras (tier, permissions, contributes.{tools,shortcuts,tile,provider}, entry) are
//    rewritten into a fresh `winter-plugin.json` at the converted plugin's root, dropping the four
//    legacy `contributes` keys the new schema no longer carries (`agent/plugin-manifest.ts`);
//  - a `.claude-plugin/plugin.json` (claude's own optional manifest, F15) is written from
//    name/description/version/author so the plugin is recognizable without Winter's own extras file.
//
// Enabled state (spec §4.1's `plugins.enabled/disabled → enabledPlugins` row, deferred to this
// lane — see `settings.ts`'s `MOVED_SETTINGS_KEYS` doc comment): a legacy plugin's enabled state was
// `settings.plugins.enabled.includes(id) && !settings.plugins.disabled.includes(id)`; the converted
// plugin's `enabledPlugins["<id>@winter-legacy"]` is set to the SAME boolean, through the adapter's
// own `setPluginEnabled`/`installPlugin` (install's own default `enabled:true`, corrected to `false`
// when the legacy state was off). Consent records (`settings.json`'s `plugins.consents`, which
// itself STAYS — spec §4.1's "plugins.consents | stays (extras only)") are RE-KEYED in place, same
// file, same top-level field, from the bare legacy id to the qualified `"<id>@winter-legacy"` spec —
// required because `PluginStore#list()` (agent/plugins.ts) looks consent records up by the
// qualified key; leaving them bare would silently strip every Tier-2 plugin's consent on upgrade.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sdkPluginsRoot, sdkHomeFor } from "../agent/paths";
import { loadManifest, requiredConsentClasses } from "../agent/plugin-manifest";
import { writeJsonAtomic } from "../sdk-files";
import { pluginConsentFingerprint } from "./consent-fingerprint";
import { addMarketplace, installPlugin, setPluginEnabled, type PluginManagerOptions } from "./sdk-plugin-api";

const LEGACY_MARKETPLACE_NAME = "winter-legacy";

const HOOK_EVENT_MAP: Record<string, string> = {
  "session-start": "SessionStart",
  "pre-tool": "PreToolUse",
  "post-tool": "PostToolUse",
  "turn-end": "Stop",
};

interface LegacyMcpServer { name: string; command: string; args?: string[]; env?: Record<string, string> }
interface LegacyHook { event: string; command: string; timeoutMs?: number }
interface LegacyWinterManifest {
  id?: string; name?: string; description?: string; version?: string; author?: string;
  tier?: "capability" | "platform";
  permissions?: { exec?: boolean; tcc?: string[]; hardware?: string[] };
  contributes?: {
    skills?: true; agents?: true;
    mcpServers?: LegacyMcpServer[];
    hooks?: LegacyHook[];
    tools?: true;
    shortcuts?: Array<{ id: string; description?: string; default?: string }>;
    tile?: true; provider?: true;
  };
  entry?: { command: string; args?: string[]; cwd?: string };
  signature?: string;
}
interface LegacyPluginJson { name?: string; description?: string; version?: string; author?: string }

export interface ConvertLegacyPluginsResult {
  converted: Array<{ id: string; installPath: string; enabled: boolean }>;
  skipped: Array<{ id: string; reason: string }>;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function readJsonIfPresent<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

/** Reads a legacy plugin's OWN metadata — `winter-plugin.json` (pre-WS-21 superset shape) preferred,
 *  `plugin.json` (Tier-1 metadata-only) as the fallback — WITHOUT going through
 *  `agent/plugin-manifest.ts#loadManifest` (that reader now applies the NARROWED schema, which
 *  silently drops `contributes.{skills,mcpServers,agents,hooks}` — exactly the fields this converter
 *  needs to read). No zod validation here: these files were already validated once, by the Winter
 *  version that wrote them; a malformed one degrades to "no manifest" (metadata-only conversion)
 *  rather than failing the whole plugin. */
function readLegacyManifest(dir: string): { manifest?: LegacyWinterManifest; meta?: LegacyPluginJson } {
  const manifest = readJsonIfPresent<LegacyWinterManifest>(join(dir, "winter-plugin.json"));
  if (manifest) return { manifest };
  const meta = readJsonIfPresent<LegacyPluginJson>(join(dir, "plugin.json"));
  return { meta };
}

function convertHooksJson(hooks: LegacyHook[]): Record<string, Array<{ hooks: Array<{ type: "command"; command: string; timeout?: number }> }>> {
  const out: Record<string, Array<{ hooks: Array<{ type: "command"; command: string; timeout?: number }> }>> = {};
  for (const h of hooks) {
    const event = HOOK_EVENT_MAP[h.event];
    if (!event) continue; // an unknown legacy event name is dropped, never crashes the conversion
    const entry: { type: "command"; command: string; timeout?: number } = { type: "command", command: h.command };
    if (typeof h.timeoutMs === "number" && h.timeoutMs > 0) entry.timeout = Math.round(h.timeoutMs / 1000);
    (out[event] ??= []).push({ hooks: [entry] });
  }
  return out;
}

/** Copies `<home>/plugins/<id>` into the converted plugin's install dir, then overlays the
 *  claude-shaped files this converter derives (`.claude-plugin/plugin.json`, `.mcp.json`,
 *  `hooks/hooks.json`, a narrowed `winter-plugin.json`) — the copy first so any file the legacy
 *  plugin already shipped that this converter has no opinion about (skills/, agents/, other assets)
 *  comes along unchanged. */
function convertOnePlugin(legacyDir: string, targetDir: string, id: string): void {
  cpSync(legacyDir, targetDir, { recursive: true });
  const { manifest, meta } = readLegacyManifest(legacyDir);

  // The legacy `winter-plugin.json`/`plugin.json` themselves are superseded by the files below —
  // remove the stale copies so a reader never finds two conflicting manifests.
  for (const stale of ["winter-plugin.json", "plugin.json"]) {
    const p = join(targetDir, stale);
    if (existsSync(p)) rmSync(p);
  }

  const name = manifest?.name ?? meta?.name ?? id;
  const description = manifest?.description ?? meta?.description;
  const version = manifest?.version ?? meta?.version;
  const author = manifest?.author ?? meta?.author;
  mkdirSync(join(targetDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(targetDir, ".claude-plugin", "plugin.json"), `${JSON.stringify({
    name, ...(description !== undefined ? { description } : {}), ...(version !== undefined ? { version } : {}), ...(author !== undefined ? { author } : {}),
  }, null, 2)}\n`);

  const declaredServers = manifest?.contributes?.mcpServers;
  if (declaredServers && declaredServers.length > 0) {
    const existingMcpPath = join(targetDir, ".mcp.json");
    const existing = readJsonIfPresent<{ mcpServers?: Record<string, unknown> }>(existingMcpPath);
    const servers: Record<string, unknown> = { ...(existing?.mcpServers ?? {}) };
    for (const s of declaredServers) {
      servers[s.name] = { command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
    }
    writeFileSync(existingMcpPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  }

  const declaredHooks = manifest?.contributes?.hooks;
  if (declaredHooks && declaredHooks.length > 0) {
    mkdirSync(join(targetDir, "hooks"), { recursive: true });
    // Post-merge round: WRAPPED in claude's own top-level "hooks" key — plugins/plugin-hooks.ts's
    // own reader (readHookSource) expects `{hooks: {<Event>: [...]}}` at this file's root, not the
    // bare event map; writing the bare shape (as this line used to) meant a converted legacy
    // plugin's hooks silently read back as `[]` over plugin.list, never as an absent/malformed
    // field either — a genuinely undetectable data-loss bug until this fix.
    writeFileSync(join(targetDir, "hooks", "hooks.json"), `${JSON.stringify({ hooks: convertHooksJson(declaredHooks) }, null, 2)}\n`);
  }

  if (manifest && (manifest.tier || manifest.permissions || manifest.entry || manifest.contributes?.tools || manifest.contributes?.shortcuts || manifest.contributes?.tile || manifest.contributes?.provider)) {
    const narrowed: Record<string, unknown> = { id };
    if (manifest.tier) narrowed.tier = manifest.tier;
    if (manifest.permissions) narrowed.permissions = manifest.permissions;
    const contributes: Record<string, unknown> = {};
    if (manifest.contributes?.tools) contributes.tools = true;
    if (manifest.contributes?.shortcuts) contributes.shortcuts = manifest.contributes.shortcuts;
    if (manifest.contributes?.tile) contributes.tile = true;
    if (manifest.contributes?.provider) contributes.provider = true;
    if (Object.keys(contributes).length > 0) narrowed.contributes = contributes;
    if (manifest.entry) narrowed.entry = manifest.entry;
    if (manifest.signature) narrowed.signature = manifest.signature;
    writeFileSync(join(targetDir, "winter-plugin.json"), `${JSON.stringify(narrowed, null, 2)}\n`);
  }
}

/** Reads `<home>/settings.json`'s LEGACY `plugins.enabled`/`plugins.disabled`/`plugins.consents` —
 *  raw, not through the `Settings` zod schema (this converter runs at Migration C time, alongside,
 *  not after, the settings split — see this module's own header) — and never throws: a missing or
 *  unparseable file degrades to "nothing enabled, no consents", the same conservative-off posture
 *  `PluginStore` itself takes on a bad read. */
function readLegacyPluginSettings(home: string): { enabled: Set<string>; disabled: Set<string>; consents: Record<string, unknown> } {
  const raw = readJsonIfPresent<{ plugins?: { enabled?: string[]; disabled?: string[]; consents?: Record<string, unknown> } }>(join(home, "settings.json"));
  return {
    enabled: new Set(raw?.plugins?.enabled ?? []),
    disabled: new Set(raw?.plugins?.disabled ?? []),
    consents: raw?.plugins?.consents ?? {},
  };
}

/** Consent classes carried forward verbatim from a legacy record — `exec` is deliberately excluded
 *  (I3 fix round 1, ruling): before WS-21 it was granted because a plugin shipped skills, and
 *  enabling a plugin now covers that (native content, spec §5.4) — the ONLY thing an `exec` record
 *  still gates post-conversion is the Tier-2 entry process, which never had this specific consent
 *  evaluated against it before, so carrying it forward would grant something nobody actually
 *  consented to. The plugin's first entry-process run prompts fresh instead. */
const CARRIED_LEGACY_CONSENT_CLASSES = ["tcc", "hardware"] as const;

/** Re-keys `<home>/settings.json`'s `plugins.consents` from bare legacy ids to the qualified
 *  `"<id>@winter-legacy"` spec (see this module's header), DROPPING `exec` from each record on the
 *  way (see `CARRIED_LEGACY_CONSENT_CLASSES`'s own doc) — a plain read-modify-write of the ONE
 *  `plugins.consents` field; every other top-level key is preserved verbatim, never re-serialized
 *  through the `Settings` schema (which could drop a field this converter doesn't know about). A
 *  no-op (never even opens the file for a write) when there is nothing to re-key. M5: atomic
 *  temp-then-rename (`writeJsonAtomic`, Contract C), the same write discipline every other file this
 *  module produces already uses — never a plain `writeFileSync`.
 *
 *  C1 fix round 2: a carried-forward record is now written FINGERPRINTED, `{classes, fingerprint}}`
 *  (`plugins/consent-fingerprint.ts`) — the bare per-class-timestamp shape this converter used to
 *  write would read back as NOT consented under the new gate (a deliberate rule for every OTHER
 *  pre-fix record, but this converter runs AT conversion time, when it already knows exactly which
 *  install path + entry the plugin converted to, so it can write a record that's valid from the
 *  start rather than forcing a needless re-consent). `idToFingerprint` is built by the caller, off
 *  the SAME converted `targetDir` + freshly-written `winter-plugin.json` each id ended up with. */
function rekeyConsents(home: string, idToKey: Map<string, string>, idToFingerprint: Map<string, string>): void {
  const path = join(home, "settings.json");
  const raw = readJsonIfPresent<Record<string, unknown>>(path);
  if (!raw || typeof raw.plugins !== "object" || raw.plugins === null) return;
  const plugins = raw.plugins as Record<string, unknown>;
  const consents = plugins.consents;
  if (typeof consents !== "object" || consents === null) return;
  const rekeyed: Record<string, unknown> = {};
  let changed = false;
  for (const [id, record] of Object.entries(consents as Record<string, unknown>)) {
    const key = idToKey.get(id);
    if (key === undefined) { rekeyed[id] = record; continue; }
    changed = true;
    const classes: string[] = [];
    if (record && typeof record === "object") {
      for (const cls of CARRIED_LEGACY_CONSENT_CLASSES) {
        if ((record as Record<string, unknown>)[cls] !== undefined) classes.push(cls);
      }
    }
    const fingerprint = idToFingerprint.get(id) ?? "";
    rekeyed[key] = { classes, fingerprint };
  }
  if (!changed) return;
  writeJsonAtomic(path, { ...raw, plugins: { ...plugins, consents: rekeyed } });
}

/**
 * Converts every plugin at `<home>/plugins/<id>` (COPY, never move — see this module's header) into
 * a claude-shaped install under one directory marketplace, `winter-legacy`, registered through the
 * Contract B adapter. Idempotent in the sense that a re-run overwrites the SAME converted target
 * dirs and re-registers the SAME marketplace/install records — it does not detect "already
 * converted" itself (Migration C's own manifest tracks step completion, spec §8).
 */
export async function convertLegacyPlugins(home: string): Promise<ConvertLegacyPluginsResult> {
  const legacyRoot = join(home, "plugins");
  const result: ConvertLegacyPluginsResult = { converted: [], skipped: [] };
  let ids: string[] = [];
  try {
    ids = readdirSync(legacyRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return result; // no legacy plugins directory at all — nothing to convert
  }
  if (ids.length === 0) return result;

  const marketplaceDir = join(sdkPluginsRoot(home), "marketplaces", LEGACY_MARKETPLACE_NAME);
  mkdirSync(join(marketplaceDir, "plugins"), { recursive: true });
  mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });

  const manifestEntries: Array<{ name: string; source: string }> = [];
  const okIds: string[] = [];
  for (const id of ids) {
    const legacyDir = join(legacyRoot, id);
    if (!isDirectory(legacyDir)) continue;
    const targetDir = join(marketplaceDir, "plugins", id);
    try {
      convertOnePlugin(legacyDir, targetDir, id);
      manifestEntries.push({ name: id, source: `./plugins/${id}` });
      okIds.push(id);
    } catch (err) {
      result.skipped.push({ id, reason: (err as Error).message });
      rmSync(targetDir, { recursive: true, force: true });
    }
  }
  if (manifestEntries.length === 0) return result;

  writeFileSync(join(marketplaceDir, ".claude-plugin", "marketplace.json"), `${JSON.stringify({
    name: LEGACY_MARKETPLACE_NAME, owner: { name: "winter" }, plugins: manifestEntries,
  }, null, 2)}\n`);

  const options: PluginManagerOptions = {
    pluginsRoot: sdkPluginsRoot(home),
    settingsPathFor: () => join(sdkHomeFor(home), "settings.json"),
  };
  await addMarketplace(options, marketplaceDir);

  const legacySettings = readLegacyPluginSettings(home);
  const idToKey = new Map<string, string>();
  // C1 fix round 2: a fingerprint per converted id, computed off the SAME `installed.installPath` +
  // the freshly-written `winter-plugin.json` at that path (re-read via `loadManifest`, which this
  // converter's own `convertOnePlugin` already wrote) — `rekeyConsents` below needs this to write a
  // carried-forward consent record that reads as consented from the start (see its own doc).
  const idToFingerprint = new Map<string, string>();
  for (const id of okIds) {
    const spec = `${id}@${LEGACY_MARKETPLACE_NAME}`;
    idToKey.set(id, spec);
    const enabled = legacySettings.enabled.has(id) && !legacySettings.disabled.has(id);
    try {
      const installed = await installPlugin(options, spec, "user");
      if (!enabled) await setPluginEnabled(options, spec, "user", false);
      const { manifest } = loadManifest(installed.installPath, id);
      idToFingerprint.set(id, pluginConsentFingerprint(installed.installPath, {
        entry: manifest?.entry,
        tcc: manifest?.permissions?.tcc,
        hardware: manifest?.permissions?.hardware,
        requiredConsents: manifest ? requiredConsentClasses(manifest) : [],
      }));
      result.converted.push({ id, installPath: installed.installPath, enabled });
    } catch (err) {
      result.skipped.push({ id, reason: (err as Error).message });
    }
  }

  rekeyConsents(home, idToKey, idToFingerprint);
  return result;
}

/**
 * Post-merge round (BLOCKING): the adapter Migration C's own `MigrationCDeps.convertLegacyPlugins`
 * seam expects (`migration/migrate-c.ts`) — `(home) => Promise<{converted: string[], unconvertible:
 * {name, reason}[]}>`, a plain-strings shape its manifest recording (`record("convert-plugins", ...,
 * {converted, unconvertible})`) and CLI summary printer both already assume. `convertLegacyPlugins`
 * itself returns richer per-plugin records (`{id, installPath, enabled}` / `{id, reason}`) that this
 * lane's own RPCs and tests use directly; this reshapes them into the migration step's plain form
 * without changing `convertLegacyPlugins`'s own return type. Wired in at the two real call sites
 * (`daemon.ts`'s boot hook, `cli/src/commands/migrate.ts`'s `winter migrate --sdk-home`), both via
 * `packages/core/src/index.ts`'s export of this function.
 */
export async function convertLegacyPluginsForMigration(home: string): Promise<{ converted: string[]; unconvertible: { name: string; reason: string }[] }> {
  const result = await convertLegacyPlugins(home);
  return {
    converted: result.converted.map((c) => c.id),
    unconvertible: result.skipped.map((s) => ({ name: s.id, reason: s.reason })),
  };
}
