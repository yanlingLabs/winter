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
// `ProjectMcpEntrySchema` (this file, below) — stdio/http/sse, `type` defaulted to `stdio` when
// absent — the shape the daemon already knows how to hand to either leg. An entry that still
// doesn't fit is skipped and reported (name + reason), never taking its siblings down.
// `manager.ts`'s `doEnsureProject` and `external-mcp.ts`'s `configuredMcpServersFor` now call this
// one function — for a PROJECT's own `.mcp.json` specifically; see each of their own call sites for
// what they do with an http/sse entry, which DIFFERS between the two, deliberately: the daemon's own
// `McpManager` (`manager.ts`) has no in-daemon client for those transports at all (same limitation
// `settings.mcpServers`' http/sse rows already have there), so it only reports/logs the entry —
// never touching, never even inspecting, its headers. `external-mcp.ts`'s `configuredMcpServersFor`
// is the OPPOSITE case: it feeds the CHILD, which DOES speak all three transports, so it forwards
// the validated entry — headers included, verbatim — via `toMcpServerConfig`. See the RULING below
// for why "verbatim, credential-shaped or not" is the deliberate answer for the child-facing path.
// NOT converted, deliberately out of this fix's scope:
// `manager.ts`'s OWN `startPlugins` still does a one-shot `ProjectMcpConfig.parse(...)` over a
// PLUGIN's `.mcp.json` (a different config, a different tier — manifest-declared servers win over
// it entirely when present) — a plugin author's own malformed entry is a different failure mode
// than a project's, and this fix was never asked to touch it.
//
// RULING (review round 2 — CREDENTIAL HEADERS ARE NOT REFUSED HERE, DELIBERATELY):
// `ProjectMcpEntrySchema` below is otherwise IDENTICAL to `settings.ts`'s `McpServerSettingsEntry`
// (same three shapes, same `type`-defaulting preprocess) but does NOT carry that schema's
// `refuseCredentialShapedHeaders` refinement, and is defined fresh here rather than importing it.
// `settings.mcpServers` is Winter's OWN file, and the refusal exists because settings.json is
// model-readable with no other guard on a bearer token landing there in the clear. A project's
// `.mcp.json` is a DIFFERENT file with a DIFFERENT ownership story — it is claude's own format, git-
// shared with a team, and a real team's shared MCP server frequently authenticates via a header IN
// that committed file. claude's own reader accepts and forwards such an entry's headers to the
// child VERBATIM; an earlier revision of this fix reused `McpServerSettingsEntry` wholesale and so
// silently dropped a git-shared http/sse entry the moment it had an `Authorization` header — verified
// live (`mcp get <name>` on such an entry reported "not recognized", and the surfaced reason
// wrongly said "settings.json is model-readable…", naming the wrong file entirely). Fixed: a
// project-scope entry's headers reach the child UNCHANGED, credential-shaped or not — parity with
// claude, not a new hole (nothing here READS the header value except to forward it, same as before
// this whole fix existed). The write door (`mcp add --scope project`) may still choose to refuse
// WRITING a new credential-shaped header into a file that would be committed — that would be a
// separate, write-side policy call (`mcp-write.ts`'s `addProjectMcpServer`, not implemented here,
// since the write door for project scope is stdio-only today and so never writes a header at all —
// see below); it must never again say "settings.json" while doing it.
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * The per-entry shape `parseProjectMcpServers` validates a project's `.mcp.json` entries against.
 * Field-for-field identical to `settings.ts`'s `McpServerSettingsEntry` (stdio/http/sse, `type`
 * defaulted to `stdio` when absent) EXCEPT it does NOT carry that schema's
 * `refuseCredentialShapedHeaders` refinement — see this file's own header ("RULING") for why a
 * project's `.mcp.json` is not settings.json and must not be validated as if it were. Defined fresh
 * (not imported) for exactly that one reason; keep the three branches' fields in sync with
 * `settings.ts`'s `McpStdioServerSettings`/`McpHttpServerSettings`/`McpSSEServerSettings` if either
 * ever changes shape.
 */
const ProjectMcpEntryStdio = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const ProjectMcpEntryHttp = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
const ProjectMcpEntrySse = z.object({
  type: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
/** A pre-item-3b-shaped entry (no `type` field at all) is stdio — mirrors `settings.ts`'s own
 *  preprocess step, same rationale: it's the shape every project `.mcp.json` stdio entry has always
 *  had (claude's own `type` field is optional on a stdio entry too, `McpStdioServerConfigSchema`,
 *  the reference clone's `services/mcp/types.ts:27-32`). */
export const ProjectMcpEntrySchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) && !("type" in v) ? { ...(v as object), type: "stdio" } : v),
  z.discriminatedUnion("type", [ProjectMcpEntryStdio, ProjectMcpEntryHttp, ProjectMcpEntrySse]),
);
export type ProjectMcpEntry = z.infer<typeof ProjectMcpEntrySchema>;

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

/**
 * Writes `content` to `path` ATOMICALLY: a temp file in the SAME directory (so the final
 * `renameSync` is a same-filesystem rename, atomic on every platform this runs on — never a
 * cross-device copy), preserving the existing file's mode when there is one. Without this, a write
 * that dies mid-`writeFileSync` (a crash, a killed daemon, disk full) can leave `.mcp.json`
 * truncated or empty — a git-shared, hand-editable file with no watcher/keep-last-good the way
 * settings.json has one, so a torn write here is a team's shared config silently gone until someone
 * notices and reverts it from git. The temp name embeds random bytes so two concurrent writers
 * (unlikely — same process, same dir — but cheap to rule out) never collide on one temp path.
 */
function atomicWriteFile(path: string, content: string): void {
  let mode: number | undefined;
  // Masked to the permission bits only — `statSync`'s `mode` also carries the file-type bits
  // (S_IFREG etc.); `chmodSync` on macOS/Linux ignores them, but mask explicitly so correctness
  // doesn't quietly depend on that OS leniency.
  try { mode = statSync(path).mode & 0o7777; } catch { /* no existing file — default mode (umask) is fine */ }
  const tmpPath = join(dirname(path), `.${PROJECT_MCP_FILENAME}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmpPath, content, "utf8");
    if (mode !== undefined) {
      try { chmodSync(tmpPath, mode); } catch { /* best effort — never fail the write over a mode-preserve miss */ }
    }
    renameSync(tmpPath, path);
  } catch (err) {
    // A failed write/rename must never leave a stray `.tmp` file behind in a team's git-shared
    // project directory (it would show up as an untracked file in `git status`).
    try { unlinkSync(tmpPath); } catch { /* the write itself may never have created it — fine */ }
    throw err;
  }
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

/** Writes the config back verbatim (pretty-printed, trailing newline), ATOMICALLY (`atomicWriteFile`
 *  — temp file in the same dir + rename, existing file mode preserved) — a read-only convenience
 *  for a caller that already has a fully-typed `ProjectMcpConfig` in hand (there are none left
 *  inside this repo since the WRITE door below replaced them — see that function's own doc for
 *  why). Does NOT validate trust — writing to a project's `.mcp.json` has never required the
 *  directory to be trusted (trust only gates whether the DAEMON ever spawns what the file names,
 *  `TrustStore.isTrusted`); a caller reports trust status separately. */
export function writeProjectMcpConfig(dir: string, config: ProjectMcpConfig): void {
  mkdirSync(dir, { recursive: true });
  atomicWriteFile(projectMcpConfigPath(dir), `${JSON.stringify(config, null, 2)}\n`);
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
 *  in, is still exactly what it was). ATOMIC (`atomicWriteFile`) — a crash or kill mid-write can
 *  never leave a team's git-shared `.mcp.json` truncated. */
export function writeRawProjectMcpConfig(dir: string, raw: Record<string, unknown>, servers: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  const next = { ...raw, mcpServers: servers };
  atomicWriteFile(projectMcpConfigPath(dir), `${JSON.stringify(next, null, 2)}\n`);
}

/** One skipped project-scope entry, for a caller to turn into ONE log line (never a batch, never
 *  the value). `reason` is `ProjectMcpEntrySchema`'s own first issue message — a per-branch "which
 *  shape did you mean" text, the discriminated union's own useful error rather than one aggregated
 *  wall of text. */
export interface SkippedProjectMcpServer {
  name: string;
  reason: string;
}

export interface ParsedProjectMcpServers {
  /** name -> a VALIDATED entry (stdio, http or sse), headers verbatim — every name here is safe to
   *  forward to the child UNCHANGED (`ProjectMcpEntrySchema`, this file's own header — NOT
   *  `settings.ts`'s `McpServerSettingsEntry`, deliberately, so a credential-shaped header is never
   *  refused or altered here). */
  servers: Record<string, ProjectMcpEntry>;
  /** Every name that was present in the raw map but did not validate — never also in `servers`. */
  skipped: SkippedProjectMcpServer[];
}

/**
 * THE SHARED PER-ENTRY PARSER — `agent/mcp/manager.ts`'s `doEnsureProject` and `runtime-sdk/
 * external-mcp.ts`'s `configuredMcpServersFor` both call this instead of validating their raw
 * `mcpServers` map in one shot. Validates against `ProjectMcpEntrySchema` (this file, above) —
 * stdio/http/sse, `type` defaulted to `stdio` — matching claude's own `.mcp.json` reader's accepted
 * transports (Winter has no equivalent of claude's IDE-internal `sse-ide`/`ws-ide`/`ws`/`sdk` rows,
 * which are not a MCP shape a project file would ever legitimately carry) WITHOUT
 * `settings.mcpServers`' own credential-header refusal — see this file's header for why a project's
 * `.mcp.json` is not that file. An entry that fails EVERY branch (missing `command`/`url`, a
 * non-URL `url`, an unrecognized `type`, …) is reported in `skipped` and simply absent from
 * `servers` — it never prevents any OTHER entry in the same map from validating, which is the
 * entire point of this function existing (the bug it fixes: both callers used to `.parse()` the
 * whole map in one call and lose every sibling server the moment ONE entry didn't fit).
 */
export function parseProjectMcpServers(raw: Record<string, unknown>): ParsedProjectMcpServers {
  const servers: Record<string, ProjectMcpEntry> = {};
  const skipped: SkippedProjectMcpServer[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    const result = ProjectMcpEntrySchema.safeParse(entry);
    if (result.success) {
      servers[name] = result.data;
    } else {
      skipped.push({ name, reason: result.error.issues[0]?.message ?? "does not match a recognized MCP server shape (stdio/http/sse)" });
    }
  }
  return { servers, skipped };
}
