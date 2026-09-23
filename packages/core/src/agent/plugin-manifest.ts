import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * winter-plugin.json — WS-21 (spec §5.1): Winter-only EXTRAS on top of a claude plugin. A plugin is
 * now a claude plugin first (claude's own component dirs — `skills/`, `.mcp.json`, `agents/`,
 * `hooks/hooks.json`, …), loaded natively by both runtimes; this manifest carries only what claude's
 * layout has no room for: `tier`, `permissions` (`tcc`/`hardware`/`exec` for the entry process),
 * `contributes.{tools, shortcuts, tile, provider}` and `entry` (the Tier-2 process-supervision
 * command). It is optional, exactly like claude's own `.claude-plugin/plugin.json` (F15).
 *
 * Pre-WS-21 manifests could ALSO declare `contributes.{skills, mcpServers, agents, hooks}` — those
 * moved to claude's native component dirs (skills/, .mcp.json, agents/, hooks/hooks.json) and are no
 * longer read from here. A manifest still carrying them is not an error: `loadManifest` strips them
 * silently at the schema boundary (zod's default unknown-key behavior) and logs exactly ONE warning
 * naming which of the four legacy keys it found, so the extras that ARE still declared load normally
 * — see `loadManifest` below.
 */
export const WinterPluginManifest = z.object({
  id: z.string().min(1),
  name: z.string().optional(), description: z.string().optional(),
  version: z.string().optional(), author: z.string().optional(),
  tier: z.enum(["capability", "platform"]),
  permissions: z.object({
    exec: z.boolean().optional(),
    tcc: z.array(z.enum(["accessibility", "screen-recording", "input-monitoring"])).optional(),
    hardware: z.array(z.enum(["battery"])).optional(),
  }).optional(),
  contributes: z.object({
    tools: z.literal(true).optional(),
    shortcuts: z.array(z.object({ id: z.string().min(1), description: z.string().optional(), default: z.string().optional() })).optional(),
    tile: z.literal(true).optional(),
    provider: z.literal(true).optional(),
  }).optional(),
  entry: z.object({ command: z.string().min(1), args: z.array(z.string()).optional(), cwd: z.string().optional() }).optional(),
  signature: z.string().optional(), // RESERVED — unenforced until Phase 6 PKI
});
export type WinterManifest = z.infer<typeof WinterPluginManifest>;

/** The `contributes` keys a pre-WS-21 manifest could declare that now live in claude's own plugin
 *  layout instead (skills/, .mcp.json, agents/, hooks/hooks.json) — see the schema's own doc above. */
const LEGACY_CONTRIBUTES_KEYS = ["skills", "mcpServers", "agents", "hooks"] as const;

/** Which of `LEGACY_CONTRIBUTES_KEYS` a RAW (pre-schema) manifest's `contributes` object declares,
 *  in the schema's own field order — `[]` when none do (including when `contributes` itself is
 *  absent or not an object). Read off the raw JSON, before `WinterPluginManifest` strips them. */
function legacyContributesKeysPresent(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const contributes = (raw as Record<string, unknown>)["contributes"];
  if (typeof contributes !== "object" || contributes === null) return [];
  return LEGACY_CONTRIBUTES_KEYS.filter((k) => Object.hasOwn(contributes as object, k));
}

/**
 * Reads winter-plugin.json out of `dir` (a plugin directory whose canonical name is `dirName`).
 * - valid winter-plugin.json → { manifest, legacy: false }. When manifest.id doesn't match
 *   dirName, the directory wins (id is coerced) and a warning is logged — the directory name
 *   stays canonical throughout Winter's plugin model.
 * - missing winter-plugin.json → { legacy: true }, no manifest, no log (the caller falls back to
 *   the legacy plugin.json metadata path — this is the common/expected case, not a warning).
 * - present but malformed (bad JSON or schema failure) → { legacy: true } + a logged warning.
 *   Never throws — a broken manifest degrades to legacy loading, it never bricks the plugin.
 */
export function loadManifest(dir: string, dirName: string, log?: (m: string) => void): { manifest?: WinterManifest; legacy: boolean } {
  // Final-review Fix 3 (id/name charset): tool.register's own wire schema (protocol/methods.ts)
  // now REJECTS a `__` in a tool NAME outright, but a pluginId is a raw directory name — user/
  // filesystem-controlled, so it's a WARNING here, not a hard reject (a plugin someone already
  // installed under a `__`-bearing directory name must keep loading). The risk: ipc/server.ts's
  // `tool.register` handler namespaces every tool as `plugin__<pluginId>__<name>`, and
  // `ToolRegistry.unregisterByPrefix("plugin__<id>__")` matches that by plain string prefix — a
  // pluginId containing `__` can make its own unregister prefix collide with a DIFFERENT,
  // unrelated plugin's registered tool names (e.g. pluginId "foo" unregistering
  // "plugin__foo__" also matches "plugin__foo__evil__bar", a tool actually owned by a sibling
  // plugin literally named "foo__evil"), silently dropping that sibling's tools out from under it.
  if (dirName.includes("__")) {
    log?.(`plugin ${dirName}: directory name contains "__" — this can collide with another plugin's tool-unregister prefix (plugin__<id>__); consider renaming the plugin directory`);
  }
  const path = join(dir, "winter-plugin.json");
  if (!existsSync(path)) return { legacy: true };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    log?.(`plugin ${dirName}: malformed winter-plugin.json (loading as legacy)`);
    return { legacy: true };
  }

  const parsed = WinterPluginManifest.safeParse(raw);
  if (!parsed.success) {
    log?.(`plugin ${dirName}: invalid winter-plugin.json (loading as legacy)`);
    return { legacy: true };
  }

  // WS-21: a manifest written before the claude-plugin-layout move may still declare
  // `contributes.{skills,mcpServers,agents,hooks}` — those now live in claude's own component dirs
  // and `WinterPluginManifest`'s narrowed schema silently strips them (zod's default unknown-key
  // behavior). The plugin still loads, with every extra it DOES declare (tier, permissions,
  // tools/shortcuts/tile/provider, entry) intact — this is ONE warning naming which legacy keys were
  // ignored, never a hard failure.
  const legacyKeys = legacyContributesKeysPresent(raw);
  if (legacyKeys.length > 0) {
    log?.(`plugin ${dirName}: winter-plugin.json declares contributes.{${legacyKeys.join(", ")}} — these now live in claude's own plugin layout (skills/, .mcp.json, agents/, hooks/hooks.json) and are ignored here`);
  }

  let manifest = parsed.data;
  if (manifest.id !== dirName) {
    log?.(`plugin ${dirName}: winter-plugin.json id "${manifest.id}" does not match directory name — using directory name`);
    manifest = { ...manifest, id: dirName };
  }
  return { manifest, legacy: false };
}

/**
 * The disclosure line for a plugin's SHIPPED SKILLS (lane B, 2026-09-23) — shared by a manifest
 * plugin's consent block (`execPayloadLines`) and a legacy plugin's no-consent enable notice
 * (`plugins/lifecycle.ts#enableNotice`), so both say the same thing: a skill can run shell commands
 * when a session uses it. Empty when the plugin ships none.
 */
export function skillsPayloadLines(skills: readonly string[] | undefined): string[] {
  if (skills === undefined || skills.length === 0) return [];
  return [`skills: ${skills.join(", ")} — a skill can run shell commands when a session uses it`];
}

/**
 * Consent classes a manifest requires, in the order the spec/consent block lists them: exec (the
 * Tier-2 entry process, or an explicit permissions.exec), tcc (accessibility/screen-recording/
 * input-monitoring), hardware (battery etc, routed through the XPC helper).
 *
 * WS-21 (spec §5.4): "enabling a plugin is the consent for its claude parts" — a plugin's NATIVE
 * content (skills, mcpServers, hooks, agents, all loaded straight off claude's own component dirs)
 * is authorized by install+enable alone (Contract B), never a separate Winter consent record here.
 * Only the EXTRAS winter-plugin.json itself declares still gate on this consent flow — this function
 * narrowed accordingly; it no longer takes a `shipsSkills` hint (there is nothing left for it to add).
 */
export function requiredConsentClasses(m: WinterManifest): Array<"exec" | "tcc" | "hardware"> {
  const classes: Array<"exec" | "tcc" | "hardware"> = [];
  const execNeeded = Boolean(m.entry) || Boolean(m.permissions?.exec);
  if (execNeeded) classes.push("exec");
  if (m.permissions?.tcc?.length) classes.push("tcc");
  if (m.permissions?.hardware?.length) classes.push("hardware");
  return classes;
}

/**
 * The verbatim exec-payload disclosure lines the consent block prints (design spec §1: "Consent
 * text always shows the exec payload (commands to be run), never just a summary."). WS-21: the
 * mcpServer/hook lines are gone (native content needs no Winter consent, see
 * `requiredConsentClasses`'s own doc above) — the entry command is what's left, at most one line.
 */
export function execPayloadLines(m: WinterManifest): string[] {
  const lines: string[] = [];
  if (m.entry) {
    lines.push(`entry: ${[m.entry.command, ...(m.entry.args ?? [])].join(" ")}`);
  }
  return lines;
}
