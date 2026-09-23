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
//
// L5 re-review, item 3 (semantics): `hooks: []` means "the daemon successfully checked and this
// plugin declares no hooks" -- a MISSING file (the common case; most plugins have neither) is a
// legitimate, readable "nothing from this source", not a failure. The field is OMITTED only when the
// daemon genuinely couldn't determine the true state -- a file that exists but fails to parse as
// JSON, isn't a JSON object, or whose own `hooks` field isn't a plain object either. A caller must be
// able to tell "this plugin has no hooks" (`[]`) apart from "the daemon couldn't read them" (absent).
//
// L5 re-review round 2, item 2 (hardening): a hooks source is refused -- treated exactly like an
// unreadable/malformed file (`ok: false`, which makes the WHOLE field absent) -- when it resolves,
// through any symlink at any point in the path (the leaf file itself, `hooks/`, `.claude-plugin/`),
// to somewhere OUTSIDE `realpath(installPath)`. A directory marketplace is read in place from
// wherever its manifest points, so a plugin author (or a compromised/updated marketplace) could
// otherwise point `hooks/hooks.json` at an arbitrary file on disk and have its contents disclosed
// over `plugin.list` as though they belonged to the plugin.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

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

/** `true` when `target` (already `realpath`-resolved) is `base` itself or somewhere under it —
 *  `relative` naturally handles drive/root differences; a `..`-leading or absolute result means
 *  `target` fell outside `base`. */
function isWithin(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** One source's read outcome: `ok: true` covers BOTH "the file is absent" and "the file parsed and
 *  its `hooks` field is a valid (possibly empty) event map" -- both are legitimate, known states.
 *  `ok: false` is reserved for a genuine failure: the file exists but isn't valid JSON, isn't a JSON
 *  object, its own `hooks` field is present but isn't a plain object either, or it resolves (through
 *  any symlink) outside the plugin's own `installPathReal` (see this module's header). */
function readHookSource(path: string, installPathReal: string): { ok: boolean; hooks: PluginHookEntry[] } {
  if (!existsSync(path)) return { ok: true, hooks: [] };
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, hooks: [] }; // existsSync said yes but realpath failed (race, broken link) — unreadable
  }
  if (!isWithin(installPathReal, real)) return { ok: false, hooks: [] }; // symlink escape — refused, treated as unreadable
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, hooks: [] };
  }
  if (!isPlainObject(raw)) return { ok: false, hooks: [] };
  const hooksField = raw.hooks;
  if (hooksField === undefined) return { ok: true, hooks: [] }; // no hooks declared at all -- fine
  if (!isPlainObject(hooksField)) return { ok: false, hooks: [] }; // declared, but garbled
  return { ok: true, hooks: flattenHookEventMap(hooksField) };
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
 * then the manifest's) and `MAX_HOOK_COMMAND_CHARS` per command.
 *
 * Returns `[]` when both sources were readable (present-and-valid OR simply absent) but declare no
 * hooks -- "this plugin has no hooks" is a known, positive fact. Returns `undefined` ONLY when EITHER
 * source exists but fails to parse/validate -- the daemon genuinely doesn't know the true state, so
 * it says nothing rather than claiming an empty list it can't back up (L5 re-review, item 3). NEVER
 * throws.
 */
export function pluginHooksFor(installPath: string): PluginHookEntry[] | undefined {
  let installPathReal = installPath;
  try {
    installPathReal = realpathSync(installPath);
  } catch {
    /* keep the given path -- a moved/deleted install dir mid-check still fences deterministically */
  }
  const file = readHookSource(join(installPath, "hooks", "hooks.json"), installPathReal);
  const manifest = readHookSource(join(installPath, ".claude-plugin", "plugin.json"), installPathReal);
  if (!file.ok || !manifest.ok) return undefined;
  return [...file.hooks, ...manifest.hooks].slice(0, MAX_HOOKS_PER_PLUGIN);
}
