// WS-21 fix round 2 (new `hooks` field on `plugin.list`'s per-plugin listing, for lane L5's Mac
// Hooks tab): a claude-format plugin's hooks live in TWO possible places:
//   - `hooks/hooks.json` -- claude's own file, WRAPPED in a top-level `hooks` key:
//     `{hooks: {<Event>: [{matcher?, hooks: [{type, command?, ...}]}]}}`;
//   - a plugin manifest's (`.claude-plugin/plugin.json`, or Winter's own manifest dir) OWN inline
//     `hooks` field -- the SAME inner shape, `{<Event>: [{matcher?, hooks: [...]}]}`, already
//     unwrapped (it's a field ACCESS on the manifest object, not a standalone file with its own
//     top-level "hooks" key).
// EITHER can carry hooks, and a claude-format plugin with no `winter-plugin.json` at all still has
// them -- unlike `plugin.list`'s `extras` (winter-plugin.json-only, absent otherwise), this field is
// read from BOTH sources and reported whenever EITHER has something, per the fix round 2 ruling:
// "Load both, as claude does."
//
// This is a TOP-LEVEL `plugin.list` field (protocol/methods.ts's `PluginListingSchema.hooks`), a
// SIBLING of `extras`, not nested in it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PluginHookEntry {
  event: string;
  matcher?: string;
  type: string;
  command?: string;
}

/** Ruling: cap each disclosed command at 500 characters and at most 100 hook entries per plugin --
 *  this is a listing for a consent/review UI, not a full audit dump. */
const MAX_HOOK_COMMAND_CHARS = 500;
const MAX_HOOKS_PER_PLUGIN = 100;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJsonObjectIfPresent(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined; // absent OR malformed both degrade to "nothing from this source" -- never throw
  }
}

/**
 * Flattens claude's settings-shaped hook map, `{<Event>: [{matcher?, hooks: [{type, command?,
 * ...}]}]}`, into one entry per (event, matcher-group, hook). Malformed shapes are skipped
 * entry-by-entry rather than failing the whole map -- one bad group in an otherwise-valid file still
 * yields every OTHER group's entries.
 */
function flattenHookEventMap(eventMap: unknown): PluginHookEntry[] {
  if (!isPlainObject(eventMap)) return [];
  const out: PluginHookEntry[] = [];
  for (const [event, groups] of Object.entries(eventMap)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isPlainObject(group)) continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
      const hooks = group.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        if (!isPlainObject(h) || typeof h.type !== "string") continue;
        const command = typeof h.command === "string" ? h.command.slice(0, MAX_HOOK_COMMAND_CHARS) : undefined;
        out.push({
          event,
          ...(matcher !== undefined ? { matcher } : {}),
          type: h.type,
          ...(command !== undefined ? { command } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * `plugin.list`'s `hooks` field for one installed plugin: the UNION of `hooks/hooks.json` and the
 * claude manifest's (`.claude-plugin/plugin.json`) own inline `hooks` field -- "load both, as claude
 * does" (fix round 2 ruling). Capped at `MAX_HOOKS_PER_PLUGIN` entries total (file's entries first,
 * then the manifest's) and `MAX_HOOK_COMMAND_CHARS` per command. `undefined` when neither source
 * yields anything -- an absent field, never an empty array, matching `extras`'s own "nothing to say"
 * convention -- and NEVER throws: a missing or malformed file at either path silently contributes
 * nothing from that source rather than failing the whole `plugin.list` call.
 */
export function pluginHooksFor(installPath: string): PluginHookEntry[] | undefined {
  const fileRaw = readJsonObjectIfPresent(join(installPath, "hooks", "hooks.json"));
  const fromFile = fileRaw ? flattenHookEventMap(fileRaw.hooks) : [];

  const manifestRaw = readJsonObjectIfPresent(join(installPath, ".claude-plugin", "plugin.json"));
  const fromManifest = manifestRaw ? flattenHookEventMap(manifestRaw.hooks) : [];

  const combined = [...fromFile, ...fromManifest].slice(0, MAX_HOOKS_PER_PLUGIN);
  return combined.length > 0 ? combined : undefined;
}
