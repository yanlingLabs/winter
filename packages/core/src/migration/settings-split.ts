// WS-21 (spec §4.1, §4.2, §8): THE SETTINGS SPLIT — the runtime-facing keys of `settings.json` copied
// once into the shared runtime home's claude-format files:
//
//   settings.json                               →  sdk/settings.json
//   permissions.allow                               permissions.allow  (translated, `sdkAllowRulesFor`)
//   permissions.deny / additionalDirectories        same keys, verbatim
//   outputStyle                                     outputStyle
//   memory.enabled / memory.directory               autoMemoryEnabled / autoMemoryDirectory
//   mcpServers                                  →  sdk/.winter.json mcpServers (credential-shaped headers dropped)
//
// Runs automatically at EVERY boot on every home and build (L3.2 already reads these keys from `sdk/`
// only — a home whose split never ran would silently lose its rules, servers and memory switch), and
// as Migration C's step 5. `settings.json` itself is never written: its copies stay for a downgrade.
//
// ONCE PER KEY, two conditions (spec §4.1 + §8): a key is copied only when the per-key marker
// (`migration/settings-split.json`) has not recorded it AND the sdk file does not hold it yet. Without
// the marker, a key the user deleted from `sdk/` would be re-copied at the next boot; without the
// sdk-presence check, a value the user set through a new door would be overwritten.
//
// The plugin pair (`plugins.enabled`/`plugins.disabled` → `enabledPlugins`) is NOT split here: its
// `<plugin>@<marketplace>` names are decided by the plugin conversion (lane L4), which owns that copy.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRule } from "../agent/permission-rules";
import { sdkAllowRulesFor } from "../runtime-sdk/mode-options";
import { readSdkGlobalConfigDetailed, readSdkSettingsDetailed, updateSdkGlobalConfig, updateSdkSettings, writeJsonAtomic } from "../sdk-files";
import { stripCredentialShapedMcpHeaders } from "../settings";

/** The keys this split copies (the moved keys minus the plugin pair — see the header). */
export const SPLIT_KEYS = [
  "permissions.allow", "permissions.deny", "permissions.additionalDirectories",
  "outputStyle", "memory.enabled", "memory.directory", "mcpServers",
] as const;
export type SplitKey = (typeof SPLIT_KEYS)[number];

export function settingsSplitMarkerPath(home: string): string {
  return join(home, "migration", "settings-split.json");
}

export interface SettingsSplitReport {
  /** Keys copied by THIS run. */
  copied: SplitKey[];
  /** Keys the sdk file already stated (marked, never overwritten). */
  alreadyPresent: SplitKey[];
  /** Winter-grammar allow rules with no claude spelling that is not wider (spec §4.2). */
  untranslated: string[];
  untranslatedFile?: string;
  /** The `["Computer"]` default was written (spec §4.2: only when `allow` was absent). */
  computerDefault: boolean;
}

interface Marker { version: 1; keys: Record<string, string> }

function readMarker(home: string): Marker {
  try {
    const parsed = JSON.parse(readFileSync(settingsSplitMarkerPath(home), "utf8")) as Partial<Marker>;
    if (parsed && typeof parsed === "object" && parsed.keys && typeof parsed.keys === "object") return { version: 1, keys: { ...parsed.keys } };
  } catch { /* absent or torn: nothing recorded */ }
  return { version: 1, keys: {} };
}

const get = (obj: unknown, path: string): unknown => {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

/** Where each split key lands: which file, which key, and how its value is carried. */
function destinationOf(key: SplitKey): { file: "settings" | "global"; path: string } {
  switch (key) {
    case "permissions.allow": return { file: "settings", path: "permissions.allow" };
    case "permissions.deny": return { file: "settings", path: "permissions.deny" };
    case "permissions.additionalDirectories": return { file: "settings", path: "permissions.additionalDirectories" };
    case "outputStyle": return { file: "settings", path: "outputStyle" };
    case "memory.enabled": return { file: "settings", path: "autoMemoryEnabled" };
    case "memory.directory": return { file: "settings", path: "autoMemoryDirectory" };
    case "mcpServers": return { file: "global", path: "mcpServers" };
  }
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  if (rest.length === 0) return { ...obj, [head!]: value };
  const child = obj[head!];
  const base = child !== null && typeof child === "object" && !Array.isArray(child) ? (child as Record<string, unknown>) : {};
  return { ...obj, [head!]: setPath(base, rest.join("."), value) };
}

/** Winter allow rules that `sdkAllowRulesFor` drops: Winter's own grammar, refused or not expressible
 *  without widening (a `*` value, `Edit(<dir>)`, a bare `WebFetch`, …). Foreign-grammar rules forward. */
function untranslatedRules(rules: readonly string[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (typeof rule !== "string") continue;
    const head = /^(?:BashUnsandboxed|Bash|Edit|Computer|Worktree|WebFetch)(?:\(|$)/.test(rule);
    if (!head) continue;
    if (sdkAllowRulesFor([rule]).length === 0 || parseRule(rule) === null) out.push(rule);
  }
  return out;
}

/**
 * Copy the runtime-facing keys of `<home>/settings.json` into `sdk/` (see the header). Never throws: an
 * absent or unparseable `settings.json` copies nothing; an unparseable sdk file is never clobbered and
 * its keys are neither copied nor marked (the next boot retries).
 */
export function splitSettingsToSdk(home: string, opts: { now?: () => Date; log?: (line: string) => void } = {}): SettingsSplitReport {
  const now = opts.now ?? (() => new Date());
  const report: SettingsSplitReport = { copied: [], alreadyPresent: [], untranslated: [], computerDefault: false };
  const settingsPath = join(home, "settings.json");
  if (!existsSync(settingsPath)) return report;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { return report; }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return report;

  const marker = readMarker(home);
  const sdkSettings = readSdkSettingsDetailed(home);
  const sdkGlobal = readSdkGlobalConfigDetailed(home);
  const readable = { settings: sdkSettings.state !== "invalid", global: sdkGlobal.state !== "invalid" };
  const current = {
    settings: (sdkSettings.state === "ok" ? sdkSettings.value : {}) as Record<string, unknown>,
    global: (sdkGlobal.state === "ok" ? sdkGlobal.value : {}) as Record<string, unknown>,
  };
  const pending: { settings: [string, unknown][]; global: [string, unknown][] } = { settings: [], global: [] };
  const marks: string[] = [];

  for (const key of SPLIT_KEYS) {
    if (marker.keys[key] !== undefined) continue;
    const dest = destinationOf(key);
    if (!readable[dest.file]) continue;
    let value = get(raw, key);
    if (key === "permissions.allow" && value === undefined) {
      // Spec §4.2: Winter's getter-level `["Computer"]` default, written in once — only when this
      // home's settings.json never stated an allow list at all (an explicit `[]` opts out of it).
      if (get(current.settings, dest.path) !== undefined) { report.alreadyPresent.push(key); marks.push(key); continue; }
      pending.settings.push([dest.path, sdkAllowRulesFor(["Computer"])]);
      report.computerDefault = true;
      marks.push(key);
      continue;
    }
    if (value === undefined) continue;
    if (get(current[dest.file], dest.path) !== undefined) { report.alreadyPresent.push(key); marks.push(key); continue; }
    if (key === "permissions.allow") {
      const rules = Array.isArray(value) ? value.filter((r): r is string => typeof r === "string") : [];
      report.untranslated.push(...untranslatedRules(rules));
      value = sdkAllowRulesFor(rules);
    }
    if (key === "mcpServers") {
      // Never carry a credential-shaped header into a model-readable file (the same strip `loadSettings`
      // applies at its read door).
      const copy = JSON.parse(JSON.stringify({ mcpServers: value })) as { mcpServers: unknown };
      stripCredentialShapedMcpHeaders(copy);
      value = copy.mcpServers;
    }
    pending[dest.file].push([dest.path, value]);
    report.copied.push(key);
    marks.push(key);
  }

  try {
    if (pending.settings.length > 0) updateSdkSettings(home, (cur) => pending.settings.reduce((acc, [p, v]) => setPath(acc, p, v), cur as Record<string, unknown>));
    if (pending.global.length > 0) updateSdkGlobalConfig(home, (cur) => pending.global.reduce((acc, [p, v]) => setPath(acc, p, v), cur as Record<string, unknown>));
  } catch (err) {
    opts.log?.(`settings split: not copied (${(err as Error).message}) — retried at the next boot`);
    return { ...report, copied: [], alreadyPresent: [], computerDefault: false };
  }

  if (report.untranslated.length > 0) {
    const dir = join(home, "migration", `c-${now().toISOString().replace(/[:.]/g, "-")}`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, "untranslated-rules.json");
      writeJsonAtomic(file, { from: "settings.json permissions.allow", rules: report.untranslated });
      report.untranslatedFile = file;
    } catch { /* bounded: the rules stay in settings.json either way */ }
  }
  if (marks.length > 0) {
    const stamp = now().toISOString();
    for (const k of marks) marker.keys[k] = stamp;
    try {
      mkdirSync(join(home, "migration"), { recursive: true, mode: 0o700 });
      writeJsonAtomic(settingsSplitMarkerPath(home), marker);
    } catch { /* bounded: an unmarked key is re-checked (and found present) next boot */ }
  }
  if (report.copied.length > 0 || report.computerDefault) {
    opts.log?.(`settings split: copied ${[...report.copied, ...(report.computerDefault ? ["permissions.allow (the Computer default)"] : [])].join(", ")} into ${join(home, "sdk")}`
      + (report.untranslated.length > 0 ? ` — ${report.untranslated.length} rule(s) had no claude spelling, archived at ${report.untranslatedFile ?? "(not written)"}` : ""));
  }
  return report;
}
