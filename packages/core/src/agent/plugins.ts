import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { execPayloadLines, loadManifest, requiredConsentClasses, type WinterManifest } from "./plugin-manifest";
import { sdkPluginsRoot } from "./paths";
import { sdkEnabledPlugins } from "../settings";
import { consentedClassesFor, pluginConsentFingerprint, type PluginConsentRecordV2 } from "../plugins/consent-fingerprint";

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
  /** Consent classes actually granted, filled from settings.plugins.consents[spec]. WS-21 fix round
   *  2 (C1): a class counts as consented only when the record is the NEW `{classes, fingerprint}`
   *  shape AND its fingerprint matches this plugin's CURRENT install path + entry -- a legacy shape,
   *  a stale fingerprint (a different install folder or an edited entry), or no record at all all
   *  read as []. See `plugins/consent-fingerprint.ts`. */
  consented: string[];
  /** true when no valid winter-plugin.json was found (missing OR present-but-malformed) and the plugin loaded via the legacy plugin.json path. */
  legacy: boolean;
  // WS-24: `hasManifestMcp`/`manifestServers`/`manifestHooks` are gone -- inert since WS-21 (a plugin's
  // MCP servers and hooks are claude-native content both runtimes load themselves), and nothing read
  // them any more.
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

/** Consent record shape for one plugin: settings.plugins.consents[spec] (settings.ts). WS-21 fix
 *  round 2 (C1): `{classes, fingerprint}`, bound to the plugin's install path + entry at the moment
 *  consent was granted -- see `plugins/consent-fingerprint.ts`'s own header for the full ruling. */
export type PluginConsentRecord = PluginConsentRecordV2;

// WS-21 (spec §5): claude's own `installed_plugins.json` V2 shape (F15) — the SAME shape
// the agent SDK's `manage.ts` writes. Read here with `readFileSync` rather than that module's own
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
 * `plugins/plugin-manager.ts`/`winter plugin` write) plus `<home>/sdk/settings.json`'s
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
      /** settings.plugins.consents — per-plugin-id consent records (Winter-only extras' consent,
       *  spec §5.4: "the extras keep their own consents"). Keyed by the SAME `"<name>@<marketplace>"`
       *  spec `installed_plugins.json` uses. Typed `Record<string, unknown>` deliberately (C1, fix
       *  round 2): a stored value may be a stale pre-fix record, so it is validated at the point of
       *  use (`consentedClassesFor`), never trusted at this boundary. */
      consents?: Record<string, unknown>;
      log?: (m: string) => void;
    },
  ) {}

  /** WS-21 fix round 2 (C1): gated on `fingerprint` matching what the plugin's CURRENT install path
   *  + entry hashes to -- see `plugins/consent-fingerprint.ts`'s own header. */
  private consentedClasses(key: string, fingerprint: string): string[] {
    return consentedClassesFor(this.deps.consents?.[key], fingerprint);
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

      const { manifest } = loadManifest(dir, name, this.deps.log);
      if (manifest) {
        const requiredConsents = requiredConsentClasses(manifest);
        const fingerprint = pluginConsentFingerprint(dir, {
          entry: manifest.entry,
          tcc: manifest.permissions?.tcc,
          hardware: manifest.permissions?.hardware,
          requiredConsents,
        });
        out.push({
          ...shared,
          description: manifest.description,
          version: manifest.version ?? userRecord.version,
          tier: manifest.tier,
          requiredConsents,
          consented: this.consentedClasses(key, fingerprint),
          legacy: false,
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
        consented: this.consentedClasses(key, pluginConsentFingerprint(dir, {})),
        legacy: true,
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

// WS-24: `pluginMcpEligible`/`pluginSkillsEligible` are gone. Both had answered `false` since WS-21 and
// had no caller left: a plugin's MCP servers and skills are claude-native content the runtimes load
// themselves once the plugin is enabled (`plugins/plugin-skills.ts`'s header; `skills.list` reads the
// installed+enabled set directly), and the daemon's skills-only plugin-view handover they fed is retired.

// Post-merge round (DECISION 22): `pluginHooksEligible`/`hookRegistryPlugins` retired — the daemon's
// own `HookRegistry` is never fed plugin hooks any more (ipc/server.ts's plugin.enable/disable/
// setConsent handlers no longer rebuild it; nothing else in the codebase calls
// `HookRegistry#rebuild()` at all), and these two functions had no caller left besides that dead
// feed. A plugin's hooks reach a session's runtime child through the shared run folder and both
// SDKs natively now (spec §5.1/§5.3).

/**
 * The daemon's Tier-2 process-supervision eligibility filter: a platform-tier manifest plugin with a
 * declared `entry` point, explicitly enabled, not disabled, and fully consented. UNLIKE the retired
 * predicates above, this one stays LIVE under WS-21 — a Tier-2 entry process has no claude-native
 * equivalent; Winter's own `PluginSupervisor` is still what spawns it.
 */
export function pluginSpawnEligible(p: PluginInfo): boolean {
  return p.tier === "platform" && p.entry !== undefined && p.mcpEnabled && !p.disabled && consentComplete(p);
}
