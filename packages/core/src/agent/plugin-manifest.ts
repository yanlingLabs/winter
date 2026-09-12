import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * winter-plugin.json — the Phase 4 superset manifest (design spec §1). Lives next to, and takes
 * precedence over, the legacy `plugin.json` (metadata-only, Tier-1). Malformed winter-plugin.json
 * never bricks a plugin: the loader falls back to the legacy path with a warning — see
 * `loadManifest` below.
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
    skills: z.literal(true).optional(),
    mcpServers: z.array(z.object({ name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() })).optional(),
    agents: z.literal(true).optional(),
    hooks: z.array(z.object({ event: z.enum(["session-start", "pre-tool", "post-tool", "turn-end"]), command: z.string().min(1), timeoutMs: z.number().int().positive().optional() })).optional(),
    tools: z.literal(true).optional(),
    shortcuts: z.array(z.object({ id: z.string().min(1), description: z.string().optional(), default: z.string().optional() })).optional(),
    tile: z.literal(true).optional(),
    provider: z.literal(true).optional(),
  }).optional(),
  entry: z.object({ command: z.string().min(1), args: z.array(z.string()).optional(), cwd: z.string().optional() }).optional(),
  signature: z.string().optional(), // RESERVED — unenforced until Phase 6 PKI
});
export type WinterManifest = z.infer<typeof WinterPluginManifest>;

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

  let manifest = parsed.data;
  if (manifest.id !== dirName) {
    log?.(`plugin ${dirName}: winter-plugin.json id "${manifest.id}" does not match directory name — using directory name`);
    manifest = { ...manifest, id: dirName };
  }
  return { manifest, legacy: false };
}

/**
 * Consent classes a manifest requires, in the order the spec/consent block lists them:
 * exec (any code execution — mcpServers, hooks, a Tier-2 entry point, or an explicit
 * permissions.exec), tcc (accessibility/screen-recording/input-monitoring), hardware (battery
 * etc, routed through the XPC helper).
 */
export function requiredConsentClasses(m: WinterManifest): Array<"exec" | "tcc" | "hardware"> {
  const classes: Array<"exec" | "tcc" | "hardware"> = [];
  const execNeeded = Boolean(m.entry) || Boolean(m.contributes?.mcpServers?.length) || Boolean(m.contributes?.hooks?.length) || Boolean(m.permissions?.exec);
  if (execNeeded) classes.push("exec");
  if (m.permissions?.tcc?.length) classes.push("tcc");
  if (m.permissions?.hardware?.length) classes.push("hardware");
  return classes;
}

/**
 * The verbatim exec-payload disclosure lines the consent block prints (design spec §1: "Consent
 * text always shows the exec payload (commands to be run), never just a summary."). One line per
 * mcpServer, then one line per hook, then the entry command (at most one) — in manifest order.
 */
export function execPayloadLines(m: WinterManifest): string[] {
  const lines: string[] = [];
  for (const server of m.contributes?.mcpServers ?? []) {
    lines.push(`mcp: ${[server.command, ...(server.args ?? [])].join(" ")}`);
  }
  for (const hook of m.contributes?.hooks ?? []) {
    lines.push(`hook(${hook.event}): ${hook.command}`);
  }
  if (m.entry) {
    lines.push(`entry: ${[m.entry.command, ...(m.entry.args ?? [])].join(" ")}`);
  }
  return lines;
}
