// The `<cwd>/.mcp.json` project file's schema and read/write helpers — Claude Code's own file
// format (git-shared), previously duplicated verbatim in TWO places (`agent/mcp/manager.ts`'s own
// `ProjectMcpConfig`, `runtime-sdk/external-mcp.ts`'s own copy) with nothing keeping the two in sync
// beyond "nobody has changed one without the other yet". Both now import the schema from here.
//
// PARITY FIX (controller-directed, after the write-door fix below shipped): claude's own `.mcp.json`
// reader (`McpServerConfigSchema`, the reference clone's `services/mcp/types.ts`) accepts stdio,
// sse AND http entries (plus a few IDE-internal ones Winter has no equivalent of) — Winter's
// PER-FILE readers (`ProjectMcpConfig` below, `manager.ts`'s `doEnsureProject`,
// `external-mcp.ts`'s `configuredMcpServersFor`) used to accept ONLY stdio, and — worse — used to
// validate the WHOLE `mcpServers` map in one `.parse()` call, so a single http/sse (or otherwise
// differently-shaped) entry anywhere in the file failed the ENTIRE map and silently dropped every
// sibling server too. `parseProjectMcpServers` below is the fix: it validates PER ENTRY, against
// the SAME shape `settings.mcpServers` already accepts (`McpServerSettingsEntry`, `../../settings`
// — stdio/http/sse, `type` defaulted to `stdio` when absent, the credential-shaped-header refusal
// on an http/sse entry) — the shape the daemon already knows how to hand to either leg. An entry
// that still doesn't fit is skipped and reported (name + reason), never taking its siblings down.
// `manager.ts`'s `doEnsureProject` and `external-mcp.ts`'s `configuredMcpServersFor` now call this
// one function — for a PROJECT's own `.mcp.json` specifically; see each of their own call sites for
// what they do with an http/sse entry (the daemon's own `McpManager` has no in-daemon client for
// those transports — same limitation `settings.mcpServers`' http/sse rows already have there — so
// it reports/logs them without starting them itself; the CHILD, which `external-mcp.ts` feeds,
// connects to all three transports directly). NOT converted, deliberately out of this fix's scope:
// `manager.ts`'s OWN `startPlugins` still does a one-shot `ProjectMcpConfig.parse(...)` over a
// PLUGIN's `.mcp.json` (a different config, a different tier — manifest-declared servers win over
// it entirely when present) — a plugin author's own malformed entry is a different failure mode
// than a project's, and this fix was never asked to touch it.
//
// `winter mcp add --scope project` (`mcp-cli.ts`) still writes ONLY stdio entries — a deliberate,
// narrower choice than what the readers now ACCEPT (see that command's own refusal message): the
// readers had to widen to match every shape claude or a human might already have put in the file;
// Winter's own write door hasn't been asked to grow a new transport, and this fix does not do that.
//
// TWO READER/WRITER PAIRS, deliberately, for two different callers:
//   - `readProjectMcpConfig`/`writeProjectMcpConfig`/`ProjectMcpConfig` (typed, stdio-only,
//     degrades a missing/malformed file OR any entry it can't parse to `{}` for the WHOLE file) —
//     kept as the schema's own natural typed API for a caller that already has a fully-typed,
//     validated stdio-only shape in hand; today that is only this file's own tests. `manager.ts`/
//     `external-mcp.ts` no longer use this pair at all (see above).
//   - `readRawProjectMcpConfig`/`writeRawProjectMcpConfig` (untyped, refuses on a malformed file) —
//     THE WRITE DOOR. `winter mcp add/remove --scope project` (`mcp-cli.ts`) uses ONLY this pair.
//     See that function's own doc for why a write can never go through the typed pair above: one
//     stdio-only `.parse()` failure anywhere in the map would make a write silently drop every
//     OTHER server in the file. `extractRawMcpServers` is the shape-recognition half this shares
//     with `external-mcp.ts`, which has its own injectable `readFile` test seam and so cannot call
//     `readRawProjectMcpConfig` itself (that function does its own `readFileSync`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { McpServerSettingsEntry } from "../../settings";

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
 *  "record none" posture `McpManager.doEnsureProject`/`configuredMcpServersFor` used to take for
 *  the WHOLE file before the per-entry fix (`parseProjectMcpServers`) — kept here, unchanged, as the
 *  typed pair's own degrade; this function is stdio-only and still fails its OWN `.parse()` on the
 *  first non-stdio entry it meets, by design (it's the typed convenience, not the parity fix). */
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
 * The "is this shaped like a project MCP config at all" half of `readRawProjectMcpConfig` below,
 * factored out so `external-mcp.ts` — which has its OWN injectable `readFile` test seam and so
 * cannot call `readRawProjectMcpConfig` itself (that function does its own `readFileSync`) — can
 * reuse the exact same shape-recognition rather than a second hand-copy of it. Takes an
 * ALREADY-`JSON.parse`d value; never touches the filesystem itself. `undefined` means "not
 * recognizable as a project MCP config at all" (not a plain object, or an `mcpServers` key present
 * but not itself a plain object) — the caller's own "malformed" answer.
 */
export function extractRawMcpServers(parsedJson: unknown): { raw: Record<string, unknown>; servers: Record<string, unknown> } | undefined {
  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) return undefined;
  const raw = parsedJson as Record<string, unknown>;
  const serversUnknown = raw.mcpServers;
  if (serversUnknown !== undefined && (serversUnknown === null || typeof serversUnknown !== "object" || Array.isArray(serversUnknown))) {
    return undefined;
  }
  return { raw, servers: (serversUnknown as Record<string, unknown> | undefined) ?? {} };
}

/**
 * THE WRITE DOOR'S OWN READER — deliberately UNTYPED, unlike `readProjectMcpConfig` above.
 *
 * `winter mcp add/remove --scope project` must never lose a server it doesn't itself understand:
 * claude's own `.mcp.json` format accepts http/sse entries too. `readProjectMcpConfig`'s
 * `ProjectMcpConfig.parse(...)` throws on the FIRST entry that doesn't fit the stdio shape — one
 * bad (or merely differently-shaped) entry anywhere in the map fails the WHOLE parse, and that
 * function's own "never throws, degrades to `{}`" contract then reports the entire file as empty. A
 * write built on TOP of that degrade would read the file as empty, add the one new entry, and
 * overwrite the file with ONLY that one entry — silently deleting every other server a human or
 * claude configured there. This function exists so the write door never does that: it parses only
 * far enough to find `mcpServers` as a plain object (`extractRawMcpServers`), and leaves every
 * entry's shape completely alone.
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
  const extracted = extractRawMcpServers(parsed);
  if (!extracted) return { kind: "malformed" };
  return { kind: "ok", raw: extracted.raw, servers: extracted.servers };
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

/** One skipped project-scope entry, for a caller to turn into ONE log line (never a batch, never
 *  the value). `reason` is the schema's own first issue message — the SAME per-branch "which shape
 *  did you mean" text `settings.mcpServers` itself would raise for the identical malformed entry
 *  (`McpServerSettingsEntry`'s own doc explains why that beats one aggregated wall of text). */
export interface SkippedProjectMcpServer {
  name: string;
  reason: string;
}

export interface ParsedProjectMcpServers {
  /** name -> a VALIDATED entry (stdio, http or sse) — the exact shape `settings.mcpServers` already
   *  hands to either leg (`McpServerSettingsEntry`). Every name here is safe to forward. */
  servers: Record<string, McpServerSettingsEntry>;
  /** Every name that was present in the raw map but did not validate — never also in `servers`. */
  skipped: SkippedProjectMcpServer[];
}

/**
 * THE SHARED PER-ENTRY PARSER — `agent/mcp/manager.ts`'s `doEnsureProject` and `runtime-sdk/
 * external-mcp.ts`'s `configuredMcpServersFor` both call this instead of validating their raw
 * `mcpServers` map in one shot. Reuses `settings.ts`'s own `McpServerSettingsEntry` schema entry-by-
 * entry — the identical shape (stdio/http/sse, `type` defaulted to `stdio`, the credential-shaped-
 * header refusal on an http/sse entry) `settings.mcpServers` already validates against, so a
 * project's `.mcp.json` accepts exactly what the daemon already knows how to hand to either leg,
 * matching claude's own `.mcp.json` reader's accepted transports (stdio/http/sse; Winter has no
 * equivalent of claude's IDE-internal `sse-ide`/`ws-ide`/`ws`/`sdk` rows, which are not a MCP shape
 * a project file would ever legitimately carry). An entry that fails EVERY branch (missing
 * `command`/`url`, a non-URL `url`, a credential-shaped header, an unrecognized `type`, …) is
 * reported in `skipped` and simply absent from `servers` — it never prevents any OTHER entry in the
 * same map from validating, which is the entire point of this function existing (the bug it fixes:
 * both callers used to `.parse()` the whole map in one call and lose every sibling server the
 * moment ONE entry didn't fit).
 */
export function parseProjectMcpServers(raw: Record<string, unknown>): ParsedProjectMcpServers {
  const servers: Record<string, McpServerSettingsEntry> = {};
  const skipped: SkippedProjectMcpServer[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    const result = McpServerSettingsEntry.safeParse(entry);
    if (result.success) {
      servers[name] = result.data;
    } else {
      skipped.push({ name, reason: result.error.issues[0]?.message ?? "does not match a recognized MCP server shape (stdio/http/sse)" });
    }
  }
  return { servers, skipped };
}
