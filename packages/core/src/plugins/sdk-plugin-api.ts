// WS-21 TEMP: replaced by @yanlinglabs/winter-agent-sdk plugins API at integration.
//
// Lane L4's own adapter, mirroring lane L1b's Contract B export
// (`winter-agent-sdk`'s `packages/sdk/src/plugins/manage.ts`) field-for-field and
// function-for-function. This branch builds against the PUBLISHED agent SDK 0.0.20, which does not
// carry that export yet, so this file is an in-repo reimplementation of the SAME file writes,
// following L1b's write discipline (claude's own, spec F15) exactly. The integration branch swaps a
// real `@yanlinglabs/winter-agent-sdk` import in for this whole file; every exported name and
// signature below is deliberately IDENTICAL to `manage.ts`'s so that swap is a one-line change at
// every call site (`plugins/lifecycle.ts`, `ipc/server.ts`'s plugin RPC block, `plugin-cli.ts`).
//
// Differences from `manage.ts`, both load-bearing for staying inside core's OWN dependency graph
// rather than reaching into the SDK package:
//   - `manage.ts` reads a settings file through the SDK's own `loadSettingsFile`
//     (`packages/sdk/src/settings/sources.ts`). This file has no such import (0.0.20 doesn't export
//     it either) — `loadPluginSettingsFile` below is a small, generic, path-agnostic equivalent:
//     present-but-unparseable reads as `{present:true, loaded:false, values:{}}`, exactly
//     `loadSettingsFile`'s own contract, so `assertSettingsWritable`'s refusal fires identically.
//   - The atomic-no-lock JSON write reuses core's OWN `writeJsonAtomic` (`../sdk-files`, Contract C) —
//     same discipline (temp file, 0600, `rename`), one fewer copy of that logic in this codebase. It
//     does not carry `manage.ts`'s EXDEV/EPERM/EEXIST/EBUSY in-place fallback (a cross-filesystem
//     rename edge case, unexercised by this lane's tests); a future TEMP-removal should pick that up
//     from the real export.
//
// Evidence for the on-disk shapes (V2 `installed_plugins.json`, `known_marketplaces.json`, the
// `"<name>@<marketplace>"` compound key, a directory marketplace's `.claude-plugin/marketplace.json`)
// is `manage.ts`'s own header — measured against the pinned `claude` binary v0.3.250 — not
// re-derived here.
import { mkdir, readFile, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeJsonAtomic } from "../sdk-files";
import { ensureGlobalGitExclude } from "../agent/git-exclude";

export class PluginManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManagerError";
  }
}

export type PluginScope = "user" | "project" | "local";

export interface PluginManagerOptions {
  /** claude's plugins root (WS-21 §6.3 item 5: `storeHome/plugins`) — `installed_plugins.json` and
   *  `known_marketplaces.json` live directly under it. Callers pass `sdkPluginsRoot(home)`. */
  pluginsRoot: string;
  /** The `enabledPlugins` carrier for one scope — the settings file at that tier. */
  settingsPathFor(scope: PluginScope): string;
}

export interface MarketplaceInfo {
  name: string;
  source: string;
  kind: "directory" | "git" | "github" | "url";
  path: string;
}

export interface InstalledPlugin {
  id: string;
  version?: string;
  installPath: string;
  scope: PluginScope;
}

export interface PluginListing extends InstalledPlugin {
  enabled: boolean;
  marketplace: string;
}

// --- on-disk shapes (F15) -------------------------------------------------------------------------

interface InstalledPluginRecordV2 {
  scope: PluginScope;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
}

interface InstalledPluginsFileV2 {
  version: 2;
  plugins: Record<string, InstalledPluginRecordV2[]>;
}

interface KnownMarketplaceSource {
  source: MarketplaceInfo["kind"];
  path?: string;
  url?: string;
  repo?: string;
}

interface KnownMarketplaceRecord {
  source: KnownMarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  autoUpdate: boolean;
}

type KnownMarketplacesFile = Record<string, KnownMarketplaceRecord>;

interface MarketplaceManifestPluginEntry {
  name: string;
  source: string | Record<string, unknown>;
  version?: string;
  description?: string;
}

interface MarketplaceManifest {
  name: string;
  version?: string;
  description?: string;
  plugins: MarketplaceManifestPluginEntry[];
  metadata?: { pluginRoot?: string };
}

function installedPluginsPath(o: PluginManagerOptions): string {
  return join(o.pluginsRoot, "installed_plugins.json");
}

function knownMarketplacesPath(o: PluginManagerOptions): string {
  return join(o.pluginsRoot, "known_marketplaces.json");
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === "ENOENT";
}

// --- installed_plugins.json: write-temp-then-rename, NO lock (F15) -------------------------------

async function writeJsonAtomicNoLock(path: string, data: unknown): Promise<void> {
  // Delegates to core's own Contract C atomic writer (temp file 0600, fsync, rename) rather than
  // reimplementing it a second time — see this file's header. `writeJsonAtomic` throws on failure
  // rather than manage.ts's own EXDEV/EPERM/EEXIST/EBUSY in-place fallback; that fallback is not
  // exercised by this lane's tests and is picked up for free once the real SDK export replaces this
  // file (see the top-of-file TEMP marker).
  writeJsonAtomic(path, data);
}

async function readInstalledPluginsFile(o: PluginManagerOptions): Promise<InstalledPluginsFileV2> {
  try {
    const raw = await readFile(installedPluginsPath(o), "utf8");
    const parsed = JSON.parse(raw) as Partial<InstalledPluginsFileV2> | null;
    const plugins = parsed !== null && typeof parsed === "object" && typeof parsed.plugins === "object" && parsed.plugins !== null ? (parsed.plugins as Record<string, InstalledPluginRecordV2[]>) : {};
    return { version: 2, plugins };
  } catch (err) {
    if (isEnoent(err)) return { version: 2, plugins: {} };
    throw err;
  }
}

// --- known_marketplaces.json: written under a `.lock` directory, bounded retries, degrade (F15) ---

const MARKETPLACES_LOCK_ATTEMPTS = 25;
const MARKETPLACES_LOCK_RETRY_DELAY_MS = 20;

async function withMarketplacesLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < MARKETPLACES_LOCK_ATTEMPTS; attempt++) {
    try {
      await mkdir(lockPath);
      acquired = true;
      break;
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, MARKETPLACES_LOCK_RETRY_DELAY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        await rmdir(lockPath);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
  }
}

async function readKnownMarketplacesFile(o: PluginManagerOptions): Promise<KnownMarketplacesFile> {
  try {
    const raw = await readFile(knownMarketplacesPath(o), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as KnownMarketplacesFile) : {};
  } catch (err) {
    if (isEnoent(err)) return {};
    throw err;
  }
}

async function writeKnownMarketplacesFile(path: string, file: KnownMarketplacesFile): Promise<void> {
  await writeJsonAtomicNoLock(path, file);
}

// --- directory marketplace manifests (read in place, F15/§5.2) -----------------------------------

async function readDirectoryMarketplaceManifest(marketplaceDir: string): Promise<MarketplaceManifest> {
  const manifestPath = join(marketplaceDir, ".claude-plugin", "marketplace.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) throw new PluginManagerError(`${manifestPath}: no marketplace manifest there (expected .claude-plugin/marketplace.json under ${marketplaceDir})`);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PluginManagerError(`${manifestPath}: malformed JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new PluginManagerError(`${manifestPath}: expected a JSON object at the top level`);
  const obj = parsed as Partial<MarketplaceManifest>;
  if (typeof obj.name !== "string" || obj.name.length === 0) throw new PluginManagerError(`${manifestPath}: missing required "name"`);
  if (!Array.isArray(obj.plugins)) throw new PluginManagerError(`${manifestPath}: missing required "plugins" array`);
  return {
    name: obj.name,
    plugins: obj.plugins as MarketplaceManifestPluginEntry[],
    ...(obj.version !== undefined ? { version: obj.version } : {}),
    ...(obj.description !== undefined ? { description: obj.description } : {}),
    ...(obj.metadata !== undefined ? { metadata: obj.metadata } : {}),
  };
}

// --- source classification (kind only; only "directory" is actually fetched) ---------------------

interface SourceClassification {
  kind: MarketplaceInfo["kind"];
  locator: string;
}

function classifySource(source: string): SourceClassification {
  if (/^https?:\/\//i.test(source)) return { kind: "url", locator: source };
  if (/^git@[^:]+:/i.test(source) || /^git\+/i.test(source) || /\.git$/i.test(source)) return { kind: "git", locator: source };
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(source) && !source.includes("..")) {
    return { kind: "github", locator: source };
  }
  return { kind: "directory", locator: isAbsolute(source) ? source : resolve(source) };
}

function marketplaceInfoOf(name: string, record: KnownMarketplaceRecord): MarketplaceInfo {
  const kind = record.source.source;
  const source = record.source.path ?? record.source.url ?? record.source.repo ?? record.installLocation;
  return { name, source, kind, path: record.installLocation };
}

// --- spec parsing: "<name>@<marketplace>" -----------------------------------------------------

function parseSpec(spec: string): { name: string; marketplace: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new PluginManagerError(`plugin spec must be "<name>@<marketplace>" (got ${JSON.stringify(spec)}) — bare-name marketplace inference is not implemented in this build`);
  }
  return { name: spec.slice(0, at), marketplace: spec.slice(at + 1) };
}

function keyFor(name: string, marketplace: string): string {
  return `${name}@${marketplace}`;
}

// --- enabledPlugins (settings.json's own field) -----------------------------------------------

interface LoadedSettingsFile {
  present: boolean;
  loaded: boolean;
  values: { enabledPlugins?: Record<string, boolean>; [key: string]: unknown };
  error?: string;
}

/** Generic, path-agnostic settings-file reader with `loadSettingsFile`'s own degrade contract: a
 *  present-but-unparseable file is `{present:true, loaded:false, values:{}}` so a reader never
 *  crashes and a writer can refuse to clobber it (`assertSettingsWritable` below). */
async function loadPluginSettingsFile(path: string): Promise<LoadedSettingsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return { present: false, loaded: true, values: {} };
    return { present: true, loaded: false, values: {}, error: (err as { code?: string })?.code ?? "unreadable" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { present: true, loaded: false, values: {}, error: "not a JSON object" };
    }
    return { present: true, loaded: true, values: parsed as LoadedSettingsFile["values"] };
  } catch (err) {
    return { present: true, loaded: false, values: {}, error: (err as Error).message };
  }
}

async function readEnabledFromSettings(o: PluginManagerOptions, scope: PluginScope, key: string): Promise<boolean> {
  // `listPlugins` (below) enumerates every installed record's scope, including a project/local one
  // a caller with no `cwd` in hand cannot resolve — the daemon's own `settingsPathFor` (a caller
  // concern, not the adapter's) throws typed in exactly that case (spec: mutating a scope without a
  // cwd is a refusal, never a silent write to the wrong place). A pure LIST must not crash on that:
  // a scope this call has no cwd context for reads conservatively as "not enabled", the same
  // degrade a genuinely missing/unparseable settings file already gets.
  let path: string;
  try {
    path = o.settingsPathFor(scope);
  } catch {
    return false;
  }
  const loaded = await loadPluginSettingsFile(path);
  return loaded.values.enabledPlugins?.[key] === true;
}

function assertSettingsWritable(loaded: LoadedSettingsFile, path: string): void {
  if (loaded.present && !loaded.loaded) {
    throw new PluginManagerError(`${path}: cannot update enabledPlugins — the file exists but ${loaded.error ?? "could not be read"}; fix it by hand first`);
  }
}

async function setEnabledInSettings(o: PluginManagerOptions, scope: PluginScope, key: string, enabled: boolean | undefined): Promise<void> {
  const path = o.settingsPathFor(scope);
  const loaded = await loadPluginSettingsFile(path);
  assertSettingsWritable(loaded, path);
  const settings: Record<string, unknown> = { ...loaded.values };
  const enabledPlugins = { ...((settings.enabledPlugins as Record<string, boolean> | undefined) ?? {}) };
  if (enabled === undefined) delete enabledPlugins[key];
  else enabledPlugins[key] = enabled;
  settings.enabledPlugins = enabledPlugins;
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomicNoLock(path, settings);
  // Post-merge round: `local` scope's own file (`<root>/.winter/settings.local.json`, this exact
  // path -- `settingsPathFor`'s own `join(root, ".winter", "settings.local.json")` convention, both
  // the CLI's and the daemon's) is a PERSONAL overlay, never meant to be committed -- claude parity
  // (F21, `agent/git-exclude.ts`'s own header) keeps it out of git the same way L3's
  // `agent/saved-answers.ts` does for its own `.winter/settings.local.json` writes. `project` scope
  // writes the TEAM-SHARED `.winter/settings.json` instead (meant to be committed) and `user` scope
  // never touches the project's git tree at all, so neither needs this. Best-effort, never throws
  // (`ensureGlobalGitExclude`'s own contract) -- this install/uninstall/enable/disable never fails
  // over a cosmetic git-excludes write. `dirname(dirname(path))` recovers `root` from the two-level
  // `.winter/settings.local.json` suffix every `settingsPathFor` implementation uses.
  if (scope === "local") ensureGlobalGitExclude(dirname(dirname(path)));
}

// --- marketplaces -----------------------------------------------------------------------------

export async function listMarketplaces(o: PluginManagerOptions): Promise<MarketplaceInfo[]> {
  const file = await readKnownMarketplacesFile(o);
  return Object.entries(file).map(([name, rec]) => marketplaceInfoOf(name, rec));
}

export async function addMarketplace(o: PluginManagerOptions, source: string): Promise<MarketplaceInfo> {
  const classification = classifySource(source);
  if (classification.kind !== "directory") {
    throw new PluginManagerError(`marketplace source kind "${classification.kind}" is not supported in this build (no network) — only local directory marketplaces can be added; got ${JSON.stringify(source)}`);
  }
  const dir = classification.locator;
  const manifest = await readDirectoryMarketplaceManifest(dir);
  await mkdir(o.pluginsRoot, { recursive: true });
  const path = knownMarketplacesPath(o);
  const record: KnownMarketplaceRecord = {
    source: { source: "directory", path: dir },
    installLocation: dir,
    lastUpdated: new Date().toISOString(),
    autoUpdate: false,
  };
  await withMarketplacesLock(path, async () => {
    const file = await readKnownMarketplacesFile(o);
    file[manifest.name] = record;
    await writeKnownMarketplacesFile(path, file);
  });
  return marketplaceInfoOf(manifest.name, record);
}

export async function removeMarketplace(o: PluginManagerOptions, name: string): Promise<void> {
  const path = knownMarketplacesPath(o);
  await withMarketplacesLock(path, async () => {
    const file = await readKnownMarketplacesFile(o);
    if (!(name in file)) throw new PluginManagerError(`marketplace "${name}" is not known`);
    delete file[name];
    await writeKnownMarketplacesFile(path, file);
  });
}

export async function updateMarketplace(o: PluginManagerOptions, name?: string): Promise<void> {
  const path = knownMarketplacesPath(o);
  await withMarketplacesLock(path, async () => {
    const file = await readKnownMarketplacesFile(o);
    const names = name !== undefined ? [name] : Object.keys(file);
    for (const n of names) {
      const rec = file[n];
      if (rec === undefined) throw new PluginManagerError(`marketplace "${n}" is not known`);
      if (rec.source.source !== "directory") {
        throw new PluginManagerError(`marketplace "${n}" has source kind "${rec.source.source}", which this build cannot refresh (no network)`);
      }
      await readDirectoryMarketplaceManifest(rec.installLocation);
      rec.lastUpdated = new Date().toISOString();
    }
    await writeKnownMarketplacesFile(path, file);
  });
}

// --- plugins -----------------------------------------------------------------------------------

async function resolvePluginSourcePath(o: PluginManagerOptions, name: string, marketplace: string): Promise<{ installPath: string; version: string | undefined }> {
  const marketplaces = await readKnownMarketplacesFile(o);
  const rec = marketplaces[marketplace];
  if (rec === undefined) throw new PluginManagerError(`marketplace "${marketplace}" is not known — add it first`);
  if (rec.source.source !== "directory") {
    throw new PluginManagerError(`marketplace "${marketplace}" has source kind "${rec.source.source}", which this build cannot install from (no network)`);
  }
  const manifest = await readDirectoryMarketplaceManifest(rec.installLocation);
  const entry = manifest.plugins.find((p) => p.name === name);
  if (entry === undefined) throw new PluginManagerError(`plugin "${name}" is not listed by marketplace "${marketplace}"`);
  if (typeof entry.source !== "string") {
    throw new PluginManagerError(`plugin "${name}@${marketplace}" declares a non-local source, which this build cannot install (no network)`);
  }
  const pluginRoot = manifest.metadata?.pluginRoot ?? ".";
  const installPath = resolve(rec.installLocation, pluginRoot, entry.source);
  return { installPath, version: entry.version };
}

export async function installPlugin(o: PluginManagerOptions, spec: string, scope: PluginScope): Promise<InstalledPlugin> {
  const { name, marketplace } = parseSpec(spec);
  const settingsPath = o.settingsPathFor(scope);
  assertSettingsWritable(await loadPluginSettingsFile(settingsPath), settingsPath);

  const { installPath, version } = await resolvePluginSourcePath(o, name, marketplace);
  const key = keyFor(name, marketplace);
  await mkdir(o.pluginsRoot, { recursive: true });
  const now = new Date().toISOString();
  const record: InstalledPluginRecordV2 = { scope, installPath, installedAt: now, ...(version !== undefined ? { version } : {}) };

  const file = await readInstalledPluginsFile(o);
  const existing = file.plugins[key] ?? [];
  file.plugins[key] = [...existing.filter((r) => r.scope !== scope), record];
  await writeJsonAtomicNoLock(installedPluginsPath(o), file);

  await setEnabledInSettings(o, scope, key, true);
  return { id: name, installPath, scope, ...(version !== undefined ? { version } : {}) };
}

export async function uninstallPlugin(o: PluginManagerOptions, spec: string, scope: PluginScope): Promise<void> {
  const { name, marketplace } = parseSpec(spec);
  const key = keyFor(name, marketplace);
  const settingsPath = o.settingsPathFor(scope);
  assertSettingsWritable(await loadPluginSettingsFile(settingsPath), settingsPath);

  const file = await readInstalledPluginsFile(o);
  const existing = file.plugins[key];
  const remaining = (existing ?? []).filter((r) => r.scope !== scope);
  if (existing === undefined || remaining.length === existing.length) {
    throw new PluginManagerError(`plugin "${key}" is not installed at scope "${scope}"`);
  }
  if (remaining.length > 0) file.plugins[key] = remaining;
  else delete file.plugins[key];
  await writeJsonAtomicNoLock(installedPluginsPath(o), file);

  await setEnabledInSettings(o, scope, key, undefined);
}

export async function setPluginEnabled(o: PluginManagerOptions, spec: string, scope: PluginScope, enabled: boolean): Promise<void> {
  const { name, marketplace } = parseSpec(spec);
  const key = keyFor(name, marketplace);
  const file = await readInstalledPluginsFile(o);
  if (!(file.plugins[key]?.some((r) => r.scope === scope) ?? false)) {
    throw new PluginManagerError(`plugin "${key}" is not installed at scope "${scope}"`);
  }
  await setEnabledInSettings(o, scope, key, enabled);
}

export async function updatePlugin(o: PluginManagerOptions, spec: string): Promise<InstalledPlugin> {
  const { name, marketplace } = parseSpec(spec);
  const key = keyFor(name, marketplace);
  const file = await readInstalledPluginsFile(o);
  const records = file.plugins[key];
  if (records === undefined || records.length === 0) throw new PluginManagerError(`plugin "${key}" is not installed`);

  const { installPath, version } = await resolvePluginSourcePath(o, name, marketplace);
  const now = new Date().toISOString();
  const updated = records.map((r) => ({ ...r, installPath, lastUpdated: now, ...(version !== undefined ? { version } : {}) }));
  file.plugins[key] = updated;
  await writeJsonAtomicNoLock(installedPluginsPath(o), file);

  const last = updated[updated.length - 1]!;
  return { id: name, installPath, scope: last.scope, ...(version !== undefined ? { version } : {}) };
}

export async function listPlugins(o: PluginManagerOptions): Promise<PluginListing[]> {
  const file = await readInstalledPluginsFile(o);
  const out: PluginListing[] = [];
  for (const [key, records] of Object.entries(file.plugins)) {
    const at = key.lastIndexOf("@");
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : "";
    for (const rec of records) {
      const enabled = await readEnabledFromSettings(o, rec.scope, key);
      out.push({ id: name, installPath: rec.installPath, scope: rec.scope, enabled, marketplace, ...(rec.version !== undefined ? { version: rec.version } : {}) });
    }
  }
  return out;
}
