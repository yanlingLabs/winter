import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { execPayloadLines, loadManifest, requiredConsentClasses, type WinterManifest } from "./plugin-manifest";
import type { HookRegistryPlugin } from "../plugins/hook-registry";

export const PluginManifest = z.object({
  name: z.string().optional(), description: z.string().optional(),
  version: z.string().optional(), author: z.string().optional(),
});

export interface PluginInfo {
  name: string; description?: string; version?: string; skills: string[]; hasMcp: boolean; mcpEnabled: boolean; disabled: boolean;
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
  /** true when winter-plugin.json declares contributes.mcpServers. Distinct from hasMcp, which reflects the legacy .mcp.json file. */
  hasManifestMcp: boolean;
  /** winter-plugin.json's contributes.mcpServers verbatim, filled from the SINGLE loadManifest
   *  call this store's list() already makes — callers (daemon.ts) read this instead of re-parsing
   *  winter-plugin.json a second time. undefined for legacy plugins and for manifest plugins with
   *  no mcpServers declared (hasManifestMcp false). */
  manifestServers?: NonNullable<WinterManifest["contributes"]>["mcpServers"];
  /** winter-plugin.json's `contributes.hooks` verbatim (Phase 4f Task 2), filled from the SAME
   *  single loadManifest call list() already makes — same precedent as manifestServers above.
   *  undefined for legacy plugins and manifest plugins with no hooks declared. daemon.ts/
   *  ipc/server.ts feed this straight into HookRegistry.rebuild() (dir/hooks per eligible plugin)
   *  rather than re-parsing winter-plugin.json a second time. */
  manifestHooks?: NonNullable<WinterManifest["contributes"]>["hooks"];
  /** Display data for the CLI consent block (Task 3, spec §1: "Consent text always shows the
   *  exec payload ... never just a summary."). execPayload = plugin-manifest.ts#execPayloadLines
   *  verbatim (one line per mcpServer/hook/entry). [] for legacy plugins or manifests with no
   *  exec-class content. */
  execPayload: string[];
  /** manifest.permissions.tcc verbatim (e.g. "accessibility") — one consent-block line per entry. [] when tcc isn't required. */
  tccPermissions: string[];
  /** manifest.permissions.hardware verbatim (e.g. "battery") — one consent-block line per entry. [] when hardware isn't required. */
  hardwarePermissions: string[];
  /** winter-plugin.json's `entry` verbatim (Phase 4b Task 3, spec §3: what the PluginSupervisor
   *  spawns for a Tier-2 platform plugin) — filled from the SAME single loadManifest call list()
   *  already makes, same precedent as manifestServers above. undefined for legacy plugins and for
   *  manifest plugins that declare no entry point (e.g. capability-tier / skills-only plugins). */
  entry?: NonNullable<WinterManifest["entry"]>;
}

/** Consent record shape for one plugin: settings.plugins.consents[id] (settings.ts). */
export type PluginConsentRecord = { exec?: number; tcc?: number; hardware?: number };

const CONSENT_CLASSES = ["exec", "tcc", "hardware"] as const;

/**
 * Reads ~/.winter/plugins/<name>/. The DIRECTORY NAME is the canonical plugin name.
 * winter-plugin.json (the Phase 4 superset manifest — see plugin-manifest.ts) is read first and,
 * when present and valid, is the source of truth for description/version/tier/consent classes.
 * Otherwise the plugin loads via the legacy path: plugin.json is metadata only (malformed →
 * ignored, the plugin still loads).
 */
export class PluginStore {
  constructor(
    private readonly deps: {
      winterHome: string;
      plugins?: { enabled?: string[]; disabled?: string[] };
      /** settings.plugins.consents — per-plugin-id consent records. Kept as a sibling dep (not
       *  nested under `plugins`) so callers/tests can wire it independently of enabled/disabled. */
      consents?: Record<string, PluginConsentRecord>;
      log?: (m: string) => void;
    },
  ) {}

  private consentedClasses(name: string): string[] {
    const record = this.deps.consents?.[name];
    if (!record) return [];
    return CONSENT_CLASSES.filter((c) => record[c] !== undefined);
  }

  list(): PluginInfo[] {
    const root = join(this.deps.winterHome, "plugins");
    let dirs: string[] = [];
    try { dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
    const enabled = this.deps.plugins?.enabled ?? [];
    const disabled = this.deps.plugins?.disabled ?? [];
    return dirs.map((name) => {
      const dir = join(root, name);
      let skills: string[] = [];
      try { skills = readdirSync(join(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, "skills", e.name, "SKILL.md"))).map((e) => e.name); } catch { /* no skills dir */ }
      const isDisabled = disabled.includes(name);
      const shared = { name, skills, hasMcp: existsSync(join(dir, ".mcp.json")), mcpEnabled: enabled.includes(name) && !isDisabled, disabled: isDisabled };
      const consented = this.consentedClasses(name);

      const { manifest } = loadManifest(dir, name, this.deps.log);
      if (manifest) {
        return {
          ...shared,
          description: manifest.description,
          version: manifest.version,
          tier: manifest.tier,
          requiredConsents: requiredConsentClasses(manifest),
          consented,
          legacy: false,
          hasManifestMcp: Boolean(manifest.contributes?.mcpServers?.length),
          manifestServers: manifest.contributes?.mcpServers,
          manifestHooks: manifest.contributes?.hooks,
          execPayload: execPayloadLines(manifest),
          tccPermissions: manifest.permissions?.tcc ?? [],
          hardwarePermissions: manifest.permissions?.hardware ?? [],
          entry: manifest.entry,
        };
      }

      let meta: z.infer<typeof PluginManifest> = {};
      try { meta = PluginManifest.parse(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"))); }
      catch { this.deps.log?.(`plugin ${name}: no/invalid plugin.json (loading anyway)`); }
      return {
        ...shared,
        description: meta.description,
        version: meta.version,
        requiredConsents: [],
        consented,
        legacy: true,
        hasManifestMcp: false,
        execPayload: [],
        tccPermissions: [],
        hardwarePermissions: [],
      };
    });
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
 * The daemon's plugin-MCP eligibility filter (design spec §9(4a) enforcement), extracted as a
 * pure predicate so it's unit-testable without booting a daemon: explicitly enabled, not
 * disabled, some MCP content declared (legacy `.mcp.json` OR manifest `contributes.mcpServers`),
 * AND every required consent class is on record. For legacy plugins `requiredConsents` is always
 * [] so `consentComplete` is vacuously true and behavior is byte-identical to pre-4a (enable
 * alone suffices). For a manifest plugin with exec content, enabling WITHOUT a consent record
 * leaves this false — the caller (daemon.ts) is expected to log why when that happens.
 */
export function pluginMcpEligible(p: PluginInfo): boolean {
  return p.mcpEnabled && !p.disabled && (p.hasMcp || p.hasManifestMcp) && consentComplete(p);
}

/**
 * The daemon's plugin-hooks eligibility filter (Phase 4f Task 2) — the SAME enabled/disabled/
 * consent shape as `pluginMcpEligible` above (a plugin declaring `contributes.hooks` requires the
 * "exec" consent class too, per plugin-manifest.ts#requiredConsentClasses, so `consentComplete`
 * gates it identically), swapping the MCP-content check (`hasMcp || hasManifestMcp`) for "has at
 * least one manifest hook declared". Legacy plugins have `manifestHooks` undefined, so this is
 * always false for them — hooks are a manifest-only concept, unlike MCP eligibility which legacy
 * plugins can satisfy via the old `.mcp.json` path.
 */
export function pluginHooksEligible(p: PluginInfo): boolean {
  return p.mcpEnabled && !p.disabled && Boolean(p.manifestHooks?.length) && consentComplete(p);
}

/**
 * Projects a plugin list into `HookRegistry.rebuild()`'s input shape — `pluginHooksEligible`
 * filter + `{id, dir, hooks}` mapping in ONE place, shared by daemon.ts (boot-time scan) and
 * ipc/server.ts (plugin.enable/disable/remove/setConsent hot-rebuild, mirroring how those RPCs
 * already hot-apply Tier-2 spawn via `hotApplyStart`/`hotApplyStop`) so the two call sites can
 * never drift out of sync on what counts as an eligible hook-contributing plugin.
 */
export function hookRegistryPlugins(plugins: PluginInfo[], winterHome: string): HookRegistryPlugin[] {
  return plugins
    .filter(pluginHooksEligible)
    .map((p) => ({ id: p.name, dir: join(winterHome, "plugins", p.name), hooks: p.manifestHooks ?? [] }));
}

/**
 * The daemon's Tier-2 process-supervision eligibility filter (Phase 4b Task 3, spec §3): a
 * platform-tier manifest plugin with a declared `entry` point, explicitly enabled, not disabled,
 * and fully consented — the SAME enabled/disabled/consent shape as `pluginMcpEligible` above
 * (mcpEnabled already encodes "explicitly enabled AND not disabled" — see PluginStore#list), plus
 * the two checks that are specific to spawning a process rather than starting an MCP server:
 * `tier === "platform"` (capability-tier plugins are never spawned, regardless of what else they
 * declare) and `entry` present (nothing to spawn without one). Legacy plugins have no `tier`, so
 * this is always false for them — Tier-2 supervision is a manifest-only concept, unlike MCP
 * eligibility which legacy plugins can satisfy via the old `.mcp.json` path.
 */
export function pluginSpawnEligible(p: PluginInfo): boolean {
  return p.tier === "platform" && p.entry !== undefined && p.mcpEnabled && !p.disabled && consentComplete(p);
}
