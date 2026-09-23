import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { execPayloadLines, loadManifest, requiredConsentClasses, type WinterManifest } from "./plugin-manifest";
import type { HookRegistryPlugin } from "../plugins/hook-registry";
import { sdkPluginsRoot } from "./paths";
import { sdkEnabledPlugins } from "../settings";

export const PluginManifest = z.object({
  name: z.string().optional(), description: z.string().optional(),
  version: z.string().optional(), author: z.string().optional(),
});

export interface PluginInfo {
  name: string; description?: string; version?: string; skills: string[]; hasMcp: boolean; mcpEnabled: boolean; disabled: boolean;
  /** WS-21: the plugin's real install path, straight off `installed_plugins.json`'s own record
   *  (Contract B) — NOT a `<home>/plugins/<name>` convention, which no longer holds (a plugin can
   *  install anywhere a directory marketplace's manifest names). Callers that need the plugin's
   *  on-disk root (the Tier-2 supervisor's spawn `cwd`, a manifest re-read) use this field rather
   *  than reconstructing a path themselves — see the lane report's REQUEST FOR L3 for the one L3
   *  call site (`daemon.ts`'s `spawnablePlugins` builder) still hardcoding the old convention. */
  installPath: string;
  /** WS-21: the marketplace this plugin installed from (`installed_plugins.json`'s own compound key
   *  is `"<name>@<marketplace>"`, F15) — callers that need to write a qualified spec back (consent
   *  records, `setPluginEnabled`) use `${name}@${marketplace}` rather than re-deriving it. */
  marketplace: string;
  /** winter-plugin.json tier, when a valid manifest was found. undefined for legacy (plugin.json-only) plugins. */
  tier?: "capability" | "platform";
  /** Consent classes ("exec"|"tcc"|"hardware") the manifest requires, per plugin-manifest.ts#requiredConsentClasses. [] for legacy plugins. */
  requiredConsents: string[];
  /** Consent classes actually granted, filled from settings.plugins.consents[name] (a class counts
   *  as consented when its key is present in the record, regardless of the timestamp value). []
   *  when there's no consents dep or no record for this plugin. See consentComplete/pluginMcpEligible below. */
  consented: string[];
  /** true when no valid winter-plugin.json was found (missing OR present-but-malformed) and the plugin loaded via the legacy plugin.json path. */
  legacy: boolean;
  /** WS-21: always false. A plugin's `.mcp.json`/`contributes.mcpServers` is claude-native content
   *  now — both runtimes load it themselves (spec §5.3), so the daemon no longer starts an MCP
   *  server for a plugin, and this field (and `pluginMcpEligible` below) is kept ONLY because
   *  `daemon.ts`/`ipc/server.ts` (L3-owned) still read it; see this file's own header note on why
   *  those call sites are left compiling-but-inert rather than edited. REQUEST FOR L3 in the lane
   *  report: delete the dead consumers at daemon.ts:2018-2047/1002-1004 and ipc/server.ts:1426. */
  hasManifestMcp: boolean;
  /** Always undefined — see `hasManifestMcp`'s own doc. Typed to match the shape
   *  `agent/mcp/manager.ts`'s (L3-owned) plugin-MCP starter still declares for its own input. */
  manifestServers?: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>;
  /** Always undefined — WS-21: a plugin's hooks are claude-native `hooks/hooks.json` content, loaded
   *  by both runtimes themselves (spec §5.1/§5.3); the daemon's own HookRegistry no longer executes
   *  plugin-contributed hooks. Kept only because `hookRegistryPlugins` below still has to typecheck
   *  against `daemon.ts`'s/`ipc/server.ts`'s (L3-owned) existing call sites — see this file's header. */
  manifestHooks?: Array<{ event: string; command: string; timeoutMs?: number }>;
  /** Display data for the CLI consent block — `plugin-manifest.ts#execPayloadLines` verbatim (WS-21:
   *  at most one line, the Tier-2 entry command; mcpServer/hook lines are gone, see that module's
   *  own doc). [] for legacy plugins or manifests with no entry point. */
  execPayload: string[];
  /** manifest.permissions.tcc verbatim (e.g. "accessibility") — one consent-block line per entry. [] when tcc isn't required. */
  tccPermissions: string[];
  /** manifest.permissions.hardware verbatim (e.g. "battery") — one consent-block line per entry. [] when hardware isn't required. */
  hardwarePermissions: string[];
  /** winter-plugin.json's `entry` verbatim — what the PluginSupervisor spawns for a Tier-2 platform
   *  plugin. undefined for legacy plugins and manifest plugins that declare no entry point. */
  entry?: NonNullable<WinterManifest["entry"]>;
}

/** Consent record shape for one plugin: settings.plugins.consents[id] (settings.ts). */
export type PluginConsentRecord = { exec?: number; tcc?: number; hardware?: number };

const CONSENT_CLASSES = ["exec", "tcc", "hardware"] as const;

// WS-21 (spec §5): claude's own `installed_plugins.json` V2 shape (F15) — the SAME shape
// `plugins/sdk-plugin-api.ts` writes. Read here with `readFileSync` rather than that module's own
// (async) `listPlugins`, because `PluginStore.list()` must stay SYNCHRONOUS: `daemon.ts` and
// `ipc/server.ts` (both L3-owned) call `new PluginStore({...}).list()` synchronously at several
// sites (boot-time skill/hook/supervisor wiring, the live-plugins RPC cache), and this lane cannot
// edit those files to thread an `await` through them. The async adapter is used directly by the new
// plugin RPC handlers and by the CLI's no-daemon fallback, which already await everything else on
// their path; this reimplements the SAME read, synchronously, for the pre-existing sync call sites.
// DECISION, recorded in the lane report.
interface InstalledPluginRecordV2 { scope: "user" | "project" | "local"; installPath: string; version?: string; installedAt?: string; lastUpdated?: string }
interface InstalledPluginsFileV2 { version: 2; plugins: Record<string, InstalledPluginRecordV2[]> }

function readInstalledPluginsFileSync(pluginsRoot: string): InstalledPluginsFileV2 {
  try {
    const raw = readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<InstalledPluginsFileV2> | null;
    const plugins = parsed !== null && typeof parsed === "object" && typeof parsed.plugins === "object" && parsed.plugins !== null ? (parsed.plugins as Record<string, InstalledPluginRecordV2[]>) : {};
    return { version: 2, plugins };
  } catch {
    return { version: 2, plugins: {} };
  }
}

/**
 * WS-21 (spec §5): reads the shared runtime home's claude-format plugin store —
 * `<home>/sdk/plugins/installed_plugins.json` (Contract B's V2 shape, the SAME file
 * `plugins/sdk-plugin-api.ts`/`winter plugin` write) plus `<home>/sdk/settings.json`'s
 * `enabledPlugins` — restricted to USER scope (daemon.ts's own call sites have no project cwd to
 * scope by; the `plugin.list` RPC combines scopes itself, through the async adapter, when a cwd is
 * given). For each installed, user-scope plugin, `winter-plugin.json` is read from the install path
 * for the Winter-only extras (tier/permissions/contributes.{tools,shortcuts,tile,provider}/entry) —
 * `agent/plugin-manifest.ts#loadManifest`, unchanged. A plugin with no winter-plugin.json (or an
 * unparseable one) still lists, as a `legacy: true` entry with no extras — mirroring claude's own
 * "the manifest is optional" rule (F15) so an ordinary claude plugin with no Winter extras at all is
 * never hidden.
 */
export class PluginStore {
  constructor(
    private readonly deps: {
      winterHome: string;
      /** Unused — WS-21 retires the old `<home>/plugins` on/off arrays (`enabledPlugins` in
       *  `sdk/settings.json` is now the single source of truth). Kept only so existing callers that
       *  still pass `plugins: settings?.plugins` (L3-owned call sites) keep compiling. */
      plugins?: { enabled?: string[]; disabled?: string[] };
      /** settings.plugins.consents — per-plugin-id consent records (Winter-only extras' consent,
       *  spec §5.4: "the extras keep their own consents"). Keyed by the SAME `"<name>@<marketplace>"`
       *  spec `installed_plugins.json` uses. */
      consents?: Record<string, PluginConsentRecord>;
      log?: (m: string) => void;
    },
  ) {}

  private consentedClasses(key: string): string[] {
    const record = this.deps.consents?.[key];
    if (!record) return [];
    return CONSENT_CLASSES.filter((c) => record[c] !== undefined);
  }

  list(): PluginInfo[] {
    const pluginsRoot = sdkPluginsRoot(this.deps.winterHome);
    const installedFile = readInstalledPluginsFileSync(pluginsRoot);
    // `sdk/settings.json`'s `enabledPlugins`, through Contract C's own live/keep-last-good reader
    // (`settings.ts#sdkEnabledPlugins`) — the "one door" that module's own header names for this
    // exact key (`MOVED_SETTINGS_KEYS`'s doc comment: "read by the plugin surface — lane L4").
    const enabledPlugins = sdkEnabledPlugins(this.deps.winterHome);

    const out: PluginInfo[] = [];
    for (const [key, records] of Object.entries(installedFile.plugins)) {
      const userRecord = records.find((r) => r.scope === "user");
      if (!userRecord) continue; // this store reports user scope only — see the class doc above
      const at = key.lastIndexOf("@");
      const name = at > 0 ? key.slice(0, at) : key;
      const marketplace = at > 0 ? key.slice(at + 1) : "";
      const dir = userRecord.installPath;

      const enabled = enabledPlugins[key] === true;
      const isDisabled = !enabled;
      let skills: string[] = [];
      try { skills = readdirSync(join(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, "skills", e.name, "SKILL.md"))).map((e) => e.name); } catch { /* no skills dir */ }
      const shared = { name, skills, hasMcp: false, mcpEnabled: enabled, disabled: isDisabled, installPath: dir, marketplace };
      const consented = this.consentedClasses(key);

      const { manifest } = loadManifest(dir, name, this.deps.log);
      if (manifest) {
        out.push({
          ...shared,
          description: manifest.description,
          version: manifest.version ?? userRecord.version,
          tier: manifest.tier,
          requiredConsents: requiredConsentClasses(manifest),
          consented,
          legacy: false,
          hasManifestMcp: false,
          execPayload: execPayloadLines(manifest),
          tccPermissions: manifest.permissions?.tcc ?? [],
          hardwarePermissions: manifest.permissions?.hardware ?? [],
          entry: manifest.entry,
        });
        continue;
      }

      let meta: z.infer<typeof PluginManifest> = {};
      try {
        const claudeManifestPath = join(dir, ".claude-plugin", "plugin.json");
        meta = PluginManifest.parse(JSON.parse(readFileSync(existsSync(claudeManifestPath) ? claudeManifestPath : join(dir, "plugin.json"), "utf8")));
      } catch { this.deps.log?.(`plugin ${name}: no/invalid manifest (loading anyway)`); }
      out.push({
        ...shared,
        description: meta.description,
        version: meta.version ?? userRecord.version,
        // A LEGACY (extras-less) plugin requires no consent class — enabling it (Contract B's
        // install+enable) is already the user's trust decision for its native content (spec §5.4).
        requiredConsents: [],
        consented,
        legacy: true,
        hasManifestMcp: false,
        execPayload: [],
        tccPermissions: [],
        hardwarePermissions: [],
      });
    }
    return out;
  }
}

/**
 * True when every consent class a plugin's manifest requires (`requiredConsents`) has a matching
 * record in `consented`. Legacy plugins have `requiredConsents === []`, so this is vacuously true
 * for them — consent never gates legacy plugin content (spec: "everything above keeps working
 * unchanged").
 */
export function consentComplete(p: PluginInfo): boolean {
  return p.requiredConsents.every((c) => p.consented.includes(c));
}

/**
 * WS-21: always false. A plugin's MCP servers are claude-native content now (its `.mcp.json`, or a
 * claude manifest's own `mcpServers`), loaded by both runtimes themselves (spec §5.3) — the daemon
 * no longer starts one. Kept only so the L3-owned call sites that still read it
 * (`daemon.ts:2018-2047`) keep compiling; see `PluginInfo.hasManifestMcp`'s own doc and the lane
 * report's REQUEST FOR L3 to delete those dead call sites.
 */
export function pluginMcpEligible(_p: PluginInfo): boolean {
  return false;
}

/**
 * WS-21: always false — the daemon's own `HookRegistry` no longer executes plugin-contributed
 * hooks; a plugin's hooks are claude-native `hooks/hooks.json` content, loaded by both runtimes
 * themselves (spec §5.1/§5.3). Kept only for the same reason as `pluginMcpEligible` above.
 */
export function pluginHooksEligible(_p: PluginInfo): boolean {
  return false;
}

/**
 * WS-21: always false — a plugin's skills are claude-native content now (its `skills/` dir), loaded
 * by both runtimes themselves in code mode (spec §5.3, "Skills appear as `plugin:skill`"); the
 * daemon's own `SkillStore.childSkillSurface`/`<home>/cache/skill-plugins/` handover is retired
 * (spec's "Supersedes" list, top of file). Kept only so `daemon.ts`'s own call site
 * (`.filter(pluginSkillsEligible)`, feeding that retired handover) keeps compiling; see the lane
 * report's REQUEST FOR L3 to delete it. `skills.list`'s OWN plugin-skill reporting (this lane's
 * `ipc/server.ts` block) does not use this predicate — it reads the installed+enabled set directly.
 */
export function pluginSkillsEligible(_p: PluginInfo): boolean {
  return false;
}

/**
 * Projects a plugin list into `HookRegistry.rebuild()`'s input shape. WS-21: `pluginHooksEligible`
 * always answers false now (see its own doc), so this always returns `[]` — kept only for the
 * `daemon.ts`/`ipc/server.ts` call sites' compile-compat.
 */
export function hookRegistryPlugins(plugins: PluginInfo[], _winterHome: string): HookRegistryPlugin[] {
  return plugins
    .filter(pluginHooksEligible)
    .map((p) => ({ id: p.name, dir: p.installPath, hooks: [] }));
}

/**
 * The daemon's Tier-2 process-supervision eligibility filter: a platform-tier manifest plugin with a
 * declared `entry` point, explicitly enabled, not disabled, and fully consented. UNLIKE the three
 * predicates above, this one stays LIVE under WS-21 — a Tier-2 entry process has no claude-native
 * equivalent; Winter's own `PluginSupervisor` is still what spawns it.
 */
export function pluginSpawnEligible(p: PluginInfo): boolean {
  return p.tier === "platform" && p.entry !== undefined && p.mcpEnabled && !p.disabled && consentComplete(p);
}
