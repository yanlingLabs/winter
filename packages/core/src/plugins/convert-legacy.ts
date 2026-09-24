// WS-21 (spec §8 step 6): converts every plugin at the legacy `<home>/plugins/<id>` layout into a
// claude-shaped install under `<home>/sdk/plugins/marketplaces/winter-legacy/plugins/<id>/`,
// registered through Contract B (`plugins/plugin-manager.ts`) as one directory
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
// `settings.plugins.enabled.includes(id) && !settings.plugins.disabled.includes(id)`, AND — post-merge
// fix round, finding 1 — its OWN legacy consent record must have covered every class the pre-WS-21
// rule required (a manifest with nothing to consent to, or none at all, needs no record); the
// converted plugin's `enabledPlugins["<id>@winter-legacy"]` is set to that AND'd boolean, through the
// adapter's own `setPluginEnabled`/`installPlugin` (install's own default `enabled:true`, corrected to
// `false` otherwise). Consent records (`settings.json`'s `plugins.consents`, which itself STAYS —
// spec §4.1's "plugins.consents | stays (extras only)") get the qualified `"<id>@winter-legacy"`
// spec's OWN record ADDED beside the bare legacy id — post-merge fix round, finding 2: NEVER
// replacing or removing the bare-id record, which Migration C's own rollback does not restore
// (DECISION 15: rollback never touches `settings.json`) — an in-place re-key would silently strip a
// downgraded, pre-WS-21 build's ability to read its own consent back after a rollback. The new build
// reads only the qualified key (`PluginStore#list()`, `agent/plugins.ts`); an older, downgraded build
// reads only the bare one — both coexist in the same file, neither ever reads the other's key.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { sdkPluginsRoot, sdkHomeFor } from "../agent/paths";
import { loadManifest, requiredConsentClasses } from "../agent/plugin-manifest";
import { writeJsonAtomic } from "../sdk-files";
import { pluginConsentFingerprint } from "./consent-fingerprint";
import { addMarketplace, installPlugin, listPlugins, setPluginEnabled, type PluginManagerOptions } from "./plugin-manager";

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

/** Whether `<home>/plugins/<name>` (or any path under it) is a legacy PLUGIN this converter would
 *  actually pick up. `convertLegacyPlugins`'s own discovery treats ANY real directory under
 *  `<home>/plugins` as a candidate — a `winter-plugin.json` or a Tier-1 `plugin.json` is read if
 *  present (`readLegacyManifest`), but NEITHER is required: a manifest-less directory still converts,
 *  generating a fresh manifest from just its own name. Exported so Migration C's old-layout detection
 *  (`migration/migrate-c.ts`'s `legacyPluginDirs`) can use the EXACT SAME predicate — reviewer round,
 *  item 3 — instead of maintaining a second, driftable definition of "this counts as a legacy
 *  plugin" (the one it had required a `winter-plugin.json`, so a home whose only legacy content was a
 *  manifest-less or `plugin.json`-only plugin never migrated even though this converter would have
 *  picked it up). Follows symlinks (`statSync`-based `isDirectory`, not `Dirent.isDirectory()`) for
 *  the same reason finding 4's own discovery fix needed to — see this converter's own directory scan,
 *  below, which uses this same function. */
export function isLegacyPluginDir(path: string): boolean {
  return isDirectory(path);
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

/** Post-merge fix round, finding 4 (Opus review, data safety): the first NESTED symlink under `dir`
 *  (walked from `boundary`, a REAL — already `realpathSync`-resolved — directory) whose own resolved
 *  target falls OUTSIDE `boundary`, as a display path, or `undefined` when every symlink found stays
 *  inside it (including none at all). A dangling link (resolves nowhere) is not an escape — there is
 *  nothing outside the boundary for it to reach. Bounded against symlink cycles via `visited` (real
 *  paths already walked); an unreadable directory reports no escape from that branch (the COPY that
 *  follows will surface the same unreadability on its own, as a normal conversion failure). */
function findEscapingSymlink(dir: string, boundary: string, visited: Set<string> = new Set()): string | undefined {
  let real: string;
  try { real = realpathSync(dir); } catch { return undefined; }
  if (visited.has(real)) return undefined;
  visited.add(real);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) {
      let resolved: string;
      try { resolved = realpathSync(full); } catch { continue; } // dangling — nowhere to escape to
      if (resolved !== boundary && !resolved.startsWith(`${boundary}${sep}`)) return full;
      if (isDirectory(full)) {
        const nested = findEscapingSymlink(full, boundary, visited);
        if (nested !== undefined) return nested;
      }
      continue;
    }
    if (e.isDirectory()) {
      const nested = findEscapingSymlink(full, boundary, visited);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** Copies `<home>/plugins/<id>` into the converted plugin's install dir, then overlays the
 *  claude-shaped files this converter derives (`.claude-plugin/plugin.json`, `.mcp.json`,
 *  `hooks/hooks.json`, a narrowed `winter-plugin.json`) — the copy first so any file the legacy
 *  plugin already shipped that this converter has no opinion about (skills/, agents/, other assets)
 *  comes along unchanged.
 *
 *  Post-merge fix round, finding 4 (Opus review, data safety): `legacyDir` itself may be a SYMLINK
 *  (a dev checkout linked into `<home>/plugins`, for instance) — the OLD `cpSync(legacyDir, ...)`
 *  copied the link itself (Node's own default, `dereference:false`), so `targetDir` became a symlink
 *  to the SAME external folder, and every write this function makes below (deleting the stale
 *  manifests, writing the narrowed ones) landed THROUGH it, in the user's own folder. Now: dereference
 *  the TOP-LEVEL link first (`realpathSync`, a no-op when it wasn't one), refuse typed when any
 *  NESTED symlink inside points outside that resolved boundary (never write through one — the
 *  caller's own try/catch reports this plugin `skipped`, with THIS message as the reason, and the
 *  ORIGINAL `<home>/plugins/<id>` is never touched at all, not even read past this check), and copy
 *  with `dereference:true` so the OUTPUT under `targetDir` is a plain, symlink-free real directory. */
function convertOnePlugin(legacyDir: string, targetDir: string, id: string): void {
  const realLegacyDir = realpathSync(legacyDir); // dereference the TOP-LEVEL link — a no-op when it wasn't one
  const escaping = findEscapingSymlink(realLegacyDir, realLegacyDir);
  if (escaping !== undefined) {
    throw new Error(`${legacyDir}: a nested symlink (${escaping}) points outside the plugin's own folder — refusing to convert (never writing through a link that could reach files outside it)`);
  }
  cpSync(realLegacyDir, targetDir, { recursive: true, dereference: true });
  const { manifest, meta } = readLegacyManifest(realLegacyDir);

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

/** The PRE-WS-21 exec-consent rule, reconstructed here for MIGRATION-TIME verification only — NOT
 *  the current (WS-21-narrowed) `agent/plugin-manifest.ts#requiredConsentClasses`, which no longer
 *  requires `exec` for MCP servers/hooks/skills at all (they're claude-native content now, spec
 *  §5.4). Before WS-21, a manifest plugin's declared MCP servers, hooks and shipped skills all ran
 *  through the daemon's own process/tool machinery, gated on the SAME `exec` consent the Tier-2
 *  entry process needed (`agent/plugins.ts`'s pre-rewrite eligibility predicates). Used ONLY to
 *  decide whether a legacy plugin's OWN historical consent record already covered everything it
 *  needed BEFORE conversion — post-merge fix round, finding 1 (Opus review): converting an
 *  enabled-but-unconsented plugin must install it DISABLED, never silently start running commands
 *  the user never approved. */
function legacyRequiredConsentClasses(m: LegacyWinterManifest, opts: { shipsSkills: boolean }): Array<"exec" | "tcc" | "hardware"> {
  const classes: Array<"exec" | "tcc" | "hardware"> = [];
  const execNeeded = Boolean(m.entry) || Boolean(m.permissions?.exec)
    || Boolean(m.contributes?.mcpServers?.length) || Boolean(m.contributes?.hooks?.length) || opts.shipsSkills;
  if (execNeeded) classes.push("exec");
  if (m.permissions?.tcc?.length) classes.push("tcc");
  if (m.permissions?.hardware?.length) classes.push("hardware");
  return classes;
}

/** Whether `dir/skills` holds at least one skill directory — the same coarse signal
 *  `legacyRequiredConsentClasses`'s `shipsSkills` needs (a skill can run shell commands, so shipping
 *  one contributed to the pre-WS-21 exec requirement); never throws. Reviewer round, item 2: was
 *  `Dirent.isDirectory()` (does NOT follow symlinks — reports the dirent's OWN type), so a skill
 *  shipped as a symlinked directory (a shared skill package, for instance) was silently missed,
 *  under-reporting `shipsSkills` and so under-reporting the exec requirement itself — a plugin that
 *  DID ship a (symlinked) skill could convert enabled with no consent ever checked. Uses the same
 *  `isDirectory` (`statSync`-based, follows symlinks) this converter's own directory scan and
 *  `isLegacyPluginDir` already use. */
function legacyShipsSkills(dir: string): boolean {
  try {
    return readdirSync(join(dir, "skills"), { withFileTypes: true })
      .some((e) => isDirectory(join(dir, "skills", e.name)));
  } catch { return false; }
}

/** Whether a legacy consent record (the bare pre-fix `{exec?,tcc?,hardware?}` timestamp shape) held
 *  EVERY class `required` lists — vacuously true when `required` is empty. */
function legacyConsentCovers(record: unknown, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  if (record === null || typeof record !== "object") return false;
  const r = record as Record<string, unknown>;
  return required.every((cls) => r[cls] !== undefined);
}

/** Consent classes carried forward verbatim from a legacy record — `exec` is deliberately excluded
 *  (I3 fix round 1, ruling): before WS-21 it was granted because a plugin shipped skills, and
 *  enabling a plugin now covers that (native content, spec §5.4) — the ONLY thing an `exec` record
 *  still gates post-conversion is the Tier-2 entry process, which never had this specific consent
 *  evaluated against it before, so carrying it forward would grant something nobody actually
 *  consented to. The plugin's first entry-process run prompts fresh instead. */
const CARRIED_LEGACY_CONSENT_CLASSES = ["tcc", "hardware"] as const;

/** ADDS `<home>/settings.json`'s `plugins.consents` qualified `"<id>@winter-legacy"` records
 *  ALONGSIDE the bare legacy ids (see this module's header) — post-merge fix round, finding 2 (Opus
 *  review): this used to REPLACE each bare-id record with its qualified rewrite, so a rollback (which
 *  restores every OTHER file byte-for-byte, but never touches `settings.json` — DECISION 15,
 *  `migration/migrate-c.ts`'s own rollback doc) left a downgraded 0.116 build reading `plugins.consents`
 *  by bare id and finding NOTHING: the plugin's tcc/hardware consent had silently vanished. Now purely
 *  ADDITIVE: every bare-id record is left exactly as it was (a 0.116 downgrade after a rollback still
 *  reads it), and the qualified record is written BESIDE it (the new build reads only qualified keys —
 *  `PluginStore#list()`, `agent/plugins.ts` — so the two coexist without either ever reading the
 *  other's key). DROPS `exec` from each qualified record on the way (see
 *  `CARRIED_LEGACY_CONSENT_CLASSES`'s own doc) — the bare-id record itself is untouched, `exec`
 *  included; only the NEW qualified record excludes it. Every other top-level key is preserved
 *  verbatim, never re-serialized through the `Settings` schema (which could drop a field this
 *  converter doesn't know about). A no-op (never even opens the file for a write) when there is
 *  nothing to add. M5: atomic temp-then-rename (`writeJsonAtomic`, Contract C), the same write
 *  discipline every other file this module produces already uses — never a plain `writeFileSync`.
 *
 *  C1 fix round 2: the added qualified record is FINGERPRINTED, `{classes, fingerprint}}`
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
  // Every bare-id record starts here, untouched — the qualified records are ADDED below, never
  // replacing what's already here.
  const additive: Record<string, unknown> = { ...(consents as Record<string, unknown>) };
  let changed = false;
  for (const [id, record] of Object.entries(consents as Record<string, unknown>)) {
    const key = idToKey.get(id);
    if (key === undefined) continue;
    changed = true;
    const classes: string[] = [];
    if (record && typeof record === "object") {
      for (const cls of CARRIED_LEGACY_CONSENT_CLASSES) {
        if ((record as Record<string, unknown>)[cls] !== undefined) classes.push(cls);
      }
    }
    const fingerprint = idToFingerprint.get(id) ?? "";
    additive[key] = { classes, fingerprint };
  }
  if (!changed) return;
  writeJsonAtomic(path, { ...raw, plugins: { ...plugins, consents: additive } });
}

/**
 * Converts every plugin at `<home>/plugins/<id>` (COPY, never move — see this module's header) into
 * a claude-shaped install under one directory marketplace, `winter-legacy`, registered through the
 * Contract B adapter. Post-merge fix round, minor 2 (promoted, Opus review): a re-run SKIPS any id
 * that `sdk/plugins`'s own `installed_plugins.json` already carries an `"<id>@winter-legacy"` record
 * for, PROVIDED that record's `installPath` still exists on disk — never re-copying, re-registering
 * or touching that plugin's enabled/consent state a second time. Migration C's rollback restores
 * everything EXCEPT this lane's own SDK-side writes and `settings.json` (DECISION 15, this lane's
 * own rollback doc), so without this guard a re-migration after a rollback would silently blow away
 * and rebuild an already-converted copy, along with whatever the user changed on it since. Anything
 * NOT already installed converts the same as ever; Migration C's own manifest still tracks step
 * completion at the STEP level (spec §8) — this is the per-PLUGIN idempotency a re-run of the step
 * itself needs underneath that.
 */
export async function convertLegacyPlugins(home: string): Promise<ConvertLegacyPluginsResult> {
  const legacyRoot = join(home, "plugins");
  const result: ConvertLegacyPluginsResult = { converted: [], skipped: [] };
  let ids: string[] = [];
  try {
    // Post-merge fix round, finding 4 / reviewer round, item 3: `isLegacyPluginDir` — the SAME
    // predicate Migration C's old-layout detection now shares (see its own doc) — follows symlinks
    // and requires no manifest at all (a manifest-less directory still converts, below).
    ids = readdirSync(legacyRoot, { withFileTypes: true })
      .filter((e) => isLegacyPluginDir(join(legacyRoot, e.name)))
      .map((e) => e.name);
  } catch {
    return result; // no legacy plugins directory at all — nothing to convert
  }
  if (ids.length === 0) return result;

  const marketplaceDir = join(sdkPluginsRoot(home), "marketplaces", LEGACY_MARKETPLACE_NAME);
  mkdirSync(join(marketplaceDir, "plugins"), { recursive: true });
  mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });

  const options: PluginManagerOptions = {
    pluginsRoot: sdkPluginsRoot(home),
    settingsPathFor: () => join(sdkHomeFor(home), "settings.json"),
  };

  // Post-merge fix round, minor 2 (promoted, Opus review): read the SAME `installed_plugins.json`
  // the registration loop below writes to, ONCE, before either loop — an id already installed under
  // THIS marketplace, whose install folder still exists, is left alone below (no copy, no
  // re-registration, no enabled/consent touch — reviewer round, item 1's own carve-out below is the
  // one deliberate exception to "no touch"). A missing/fresh `installed_plugins.json` reads back as
  // no records at all (`listPlugins`'s own ENOENT degrade), so a first-ever run is unaffected. Keyed
  // to the install PATH (not just presence) — reviewer round, item 1 needs it to recompute a
  // fingerprint off the already-installed plugin without re-running `installPlugin`.
  const alreadyInstalled = new Map(
    (await listPlugins(options))
      .filter((p) => p.marketplace === LEGACY_MARKETPLACE_NAME && isDirectory(p.installPath))
      .map((p) => [p.id, p.installPath] as const),
  );

  // Read once, before either loop — reviewer round, item 1 needs it in the skip branch below (to
  // re-derive `wasFullyConsented` and to check whether a qualified consent record already exists),
  // not just in the registration loop it originally served alone.
  const legacySettings = readLegacyPluginSettings(home);
  const idToKey = new Map<string, string>();
  // C1 fix round 2: a fingerprint per converted id, computed off the SAME `installed.installPath` +
  // the freshly-written `winter-plugin.json` at that path (re-read via `loadManifest`, which this
  // converter's own `convertOnePlugin` already wrote) — `rekeyConsents` below needs this to write a
  // carried-forward consent record that reads as consented from the start (see its own doc).
  const idToFingerprint = new Map<string, string>();

  const manifestEntries: Array<{ name: string; source: string }> = [];
  const okIds: string[] = [];
  for (const id of ids) {
    const legacyDir = join(legacyRoot, id);
    if (!isDirectory(legacyDir)) continue;
    const targetDir = join(marketplaceDir, "plugins", id);
    const spec = `${id}@${LEGACY_MARKETPLACE_NAME}`;
    const existingInstallPath = alreadyInstalled.get(id);
    if (existingInstallPath !== undefined) {
      // Reviewer round, item 1 (Opus review): `installPlugin` (below, in the fresh-conversion path)
      // defaults a brand-new install to enabled:true; the disable that corrects an UNCONSENTED
      // plugin back to false is a SEPARATE call right after it. A crash between the two — or
      // anywhere later in the registration loop, since `rekeyConsents` runs only ONCE, at the very
      // end, over every id the loop processed — leaves the record + folder in place with the plugin
      // still enabled and/or its qualified consent record never written, and minor 2's own "don't
      // overwrite" (right below) would otherwise treat that half-finished state as fully done
      // forever. Finish it here, on every resume that hits this skip path — not just a genuinely
      // interrupted one: re-deriving `wasFullyConsented` and (re-)applying the disable when it's
      // false is a safe no-op when the plugin was already correctly disabled, and adding the
      // qualified record only when one is still missing is the same additive rule `rekeyConsents`
      // already applies everywhere else.
      const { manifest: legacyManifestForConsent } = readLegacyManifest(legacyDir);
      const wasFullyConsented = legacyManifestForConsent === undefined || legacyConsentCovers(
        legacySettings.consents[id],
        legacyRequiredConsentClasses(legacyManifestForConsent, { shipsSkills: legacyShipsSkills(legacyDir) }),
      );
      try {
        if (!wasFullyConsented) {
          await setPluginEnabled(options, spec, "user", false);
        }
        if (legacySettings.consents[spec] === undefined) {
          const { manifest } = loadManifest(existingInstallPath, id);
          idToKey.set(id, spec);
          idToFingerprint.set(id, pluginConsentFingerprint(existingInstallPath, {
            entry: manifest?.entry,
            tcc: manifest?.permissions?.tcc,
            hardware: manifest?.permissions?.hardware,
            requiredConsents: manifest ? requiredConsentClasses(manifest) : [],
          }));
        }
      } catch {
        // Best-effort: finishing a stranded half-conversion must never crash the whole run over it
        // — the next resume tries again. The plugin is still correctly reported `skipped` below.
      }
      // Don't overwrite: the folder from a PRIOR conversion is still there (a re-migration after a
      // rollback, most commonly) — the marketplace manifest still lists it (the folder is real and
      // unchanged), but nothing under it is touched and it never re-enters the registration loop.
      result.skipped.push({
        id,
        reason: `${id}@${LEGACY_MARKETPLACE_NAME} is already installed and its converted folder still exists — re-migrating never overwrites an existing winter-legacy copy, leaving it exactly as it is`,
      });
      manifestEntries.push({ name: id, source: `./plugins/${id}` });
      continue;
    }
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

  await addMarketplace(options, marketplaceDir);

  for (const id of okIds) {
    const spec = `${id}@${LEGACY_MARKETPLACE_NAME}`;
    idToKey.set(id, spec);
    // Post-merge fix round, finding 1 (Opus review): an enabled legacy plugin converts ENABLED only
    // when it also had no manifest, or its OWN legacy consent record already covered every class
    // the PRE-WS-21 rule (legacyRequiredConsentClasses) required — never silently start running a
    // manifest plugin's MCP servers/hooks/entry process/skills that the user consented to nothing
    // for. Installed DISABLED otherwise; the user re-consents on first enable, exactly the fresh-
    // consent posture `plugin.enable` already has for any other never-yet-consented plugin.
    const legacyDir = join(legacyRoot, id);
    const { manifest: legacyManifestForConsent } = readLegacyManifest(legacyDir);
    const wasFullyConsented = legacyManifestForConsent === undefined || legacyConsentCovers(
      legacySettings.consents[id],
      legacyRequiredConsentClasses(legacyManifestForConsent, { shipsSkills: legacyShipsSkills(legacyDir) }),
    );
    const enabled = legacySettings.enabled.has(id) && !legacySettings.disabled.has(id) && wasFullyConsented;
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
