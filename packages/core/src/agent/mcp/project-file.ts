// The `<cwd>/.mcp.json` project file's schema and read/write helpers — Claude Code's own file
// format (git-shared, stdio-only), previously duplicated verbatim in TWO places
// (`agent/mcp/manager.ts`'s own `ProjectMcpConfig`, `runtime-sdk/external-mcp.ts`'s own copy) with
// nothing keeping the two in sync beyond "nobody has changed one without the other yet". Both now
// import the schema from here; `winter mcp add/remove --scope project` (`mcp-cli.ts`) is the THIRD
// consumer this file exists to keep from becoming a fourth silently-drifting copy.
//
// Deliberately stdio-only, matching every existing reader: `configuredMcpServersFor` and
// `McpManager.doEnsureProject`/`startPlugins` have never accepted an http/sse project entry, so
// `winter mcp add --scope project --transport http` is refused one door earlier, in `mcp-cli.ts`,
// before it would ever reach a shape this schema can't express.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const ProjectMcpServerEntry = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type ProjectMcpServerEntry = z.infer<typeof ProjectMcpServerEntry>;

export const ProjectMcpConfig = z.object({
  mcpServers: z.record(z.string(), ProjectMcpServerEntry).optional(),
});
export type ProjectMcpConfig = z.infer<typeof ProjectMcpConfig>;

const PROJECT_MCP_FILENAME = ".mcp.json";

export function projectMcpConfigPath(dir: string): string {
  return join(dir, PROJECT_MCP_FILENAME);
}

/** Never throws: a missing or malformed `.mcp.json` reads as `{}` (contributes nothing) — the same
 *  "record none" posture `McpManager.doEnsureProject`/`configuredMcpServersFor` already take for
 *  this exact file. Callers that need to distinguish "absent" from "malformed" (there are none
 *  today) would need a different helper; every current caller only ever wants "what's configured,
 *  or nothing". */
export function readProjectMcpConfig(dir: string): ProjectMcpConfig {
  try {
    const raw = readFileSync(projectMcpConfigPath(dir), "utf8");
    return ProjectMcpConfig.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** True only when the file exists AND parses — distinct from `readProjectMcpConfig`'s degrade-to-
 *  empty, for a caller (the CLI) that needs to tell "no project MCP config yet" apart from "one
 *  exists but doesn't name this server" before deciding whether a write would be creating the file
 *  for the first time. */
export function projectMcpConfigExists(dir: string): boolean {
  return existsSync(projectMcpConfigPath(dir));
}

/** Writes the config back verbatim (pretty-printed, trailing newline) — a read-only convenience for
 *  a caller that already has a fully-typed `ProjectMcpConfig` in hand (there are none left inside
 *  this repo since the WRITE door below replaced them — see that function's own doc for why). Does
 *  NOT validate trust — writing to a project's `.mcp.json` has never required the directory to be
 *  trusted (trust only gates whether the DAEMON ever spawns what the file names,
 *  `TrustStore.isTrusted`); a caller reports trust status separately. */
export function writeProjectMcpConfig(dir: string, config: ProjectMcpConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(projectMcpConfigPath(dir), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * THE WRITE DOOR'S OWN READER — deliberately UNTYPED, unlike `readProjectMcpConfig` above.
 *
 * `winter mcp add/remove --scope project` must never lose a server it doesn't itself understand:
 * claude's own `.mcp.json` format accepts http/sse entries too (Winter's readers — this file's
 * `ProjectMcpConfig`, `agent/mcp/manager.ts`'s, `runtime-sdk/external-mcp.ts`'s — are stdio-only,
 * a PRE-EXISTING narrowing this write door does not fix). `readProjectMcpConfig`'s `ProjectMcpConfig
 * .parse(...)` throws on the FIRST entry that doesn't fit the stdio shape — one bad (or merely
 * differently-shaped) entry anywhere in the map fails the WHOLE parse, and that function's own
 * "never throws, degrades to `{}`" contract then reports the entire file as empty. A write built on
 * TOP of that degrade would read the file as empty, add the one new entry, and overwrite the file
 * with ONLY that one entry — silently deleting every other server a human or claude configured
 * there. This function exists so the write door never does that: it parses only far enough to find
 * `mcpServers` as a plain object, and leaves every entry's shape completely alone.
 *
 * Returns:
 *  - `{ kind: "absent" }` — no file yet (a fresh project; nothing to lose).
 *  - `{ kind: "malformed" }` — the file exists but isn't valid JSON, isn't a plain object, or its
 *    `mcpServers` key (if present) isn't itself a plain object. The write door REFUSES on this
 *    (never silently replaces a file it cannot make sense of) — mirrors `loadSettings`'s own
 *    "a torn file is a refusal, not silent data loss" posture, the write side of it: this file has
 *    no watcher/keep-last-good to fall back on the way settings.json does.
 *  - `{ kind: "ok"; raw; servers }` — `raw` is the WHOLE parsed top-level object, verbatim (every
 *    key besides `mcpServers` survives a write untouched); `servers` is `raw.mcpServers` (or a fresh
 *    `{}` if absent), each entry left as `unknown` — an http/sse entry, or a stdio entry carrying an
 *    explicit `type` field or any other extra key, round-trips byte-identical through an add/remove
 *    of some OTHER name.
 */
export function readRawProjectMcpConfig(dir: string): { kind: "absent" } | { kind: "malformed" } | { kind: "ok"; raw: Record<string, unknown>; servers: Record<string, unknown> } {
  const path = projectMcpConfigPath(dir);
  if (!existsSync(path)) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { kind: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed" };
  const raw = parsed as Record<string, unknown>;
  const serversUnknown = raw.mcpServers;
  if (serversUnknown !== undefined && (serversUnknown === null || typeof serversUnknown !== "object" || Array.isArray(serversUnknown))) {
    return { kind: "malformed" };
  }
  return { kind: "ok", raw, servers: (serversUnknown as Record<string, unknown> | undefined) ?? {} };
}

/** The write door's own writer — pairs with `readRawProjectMcpConfig`: `raw` is that call's own
 *  `raw` (every other top-level key preserved verbatim), `servers` is the NEW `mcpServers` map
 *  (built by `agent/mcp/mcp-write.ts`'s `addProjectMcpServer`/`removeProjectMcpServer`, which only
 *  ever touch the ONE name they were asked to — every sibling entry, in whatever shape it was read
 *  in, is still exactly what it was). */
export function writeRawProjectMcpConfig(dir: string, raw: Record<string, unknown>, servers: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  const next = { ...raw, mcpServers: servers };
  writeFileSync(projectMcpConfigPath(dir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
