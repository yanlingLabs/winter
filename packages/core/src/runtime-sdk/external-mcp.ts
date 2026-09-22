// Fix wave (whole-branch review row 7): Winter's CONFIGURED MCP servers, forwarded to a Winter child.
//
// Two sources, the same two `McpManager` starts for the daemon's shared registry (`agent/mcp/
// manager.ts`): the user's `settings.mcpServers` (source "user") and a TRUSTED project's
// `<cwd>/.mcp.json` (source "project", trust-gated exactly as `McpManager.ensureProject` gates it —
// an untrusted directory contributes nothing, and nothing is read from it). Daemon settings surface
// batch 3 (item 3b) widened the USER side (`settings.mcpServers`) to accept the HTTP/SSE shapes both
// SDKs' `Options.mcpServers` support; a later parity fix (controller-directed) widened the PROJECT
// side to match — `.mcp.json` now accepts stdio/http/sse too, PER ENTRY (`parseProjectMcpServers`,
// `agent/mcp/project-file.ts`), same as claude's own `.mcp.json` reader accepts (claude Code's own
// file format). Forwarded to both legs UNDER THE SAME KEY the manager registers them under, so the
// child names their tools `mcp__<key>__<tool>` — the names `tool.list` and the Mac's tool rows
// already carry.
//
// THE CHILD SPAWNS/CONNECTS ITS OWN COPY. The daemon's `McpManager` still runs stdio servers for the
// shared registry (`tool.list`, `mcp.*` RPCs) — it has no HTTP/SSE client of its own (`daemon.ts`
// filters those out before `McpManager.startAll`, see that call site's own comment); a Winter child
// cannot reach an in-daemon stdio client either, so each session's child starts/connects the
// configured servers itself from these configs. One extra process/connection per configured server
// per live session — recorded in the fix-wave report as the cost of this door for stdio; unchanged
// for HTTP/SSE, which were never proxied through the daemon to begin with.
//
// PRECEDENCE mirrors the registry: user servers were started first there and project tools with a
// colliding name were skipped, so here a user server shadows a same-keyed project server. Neither
// may shadow a daemon-owned `winter__<key>` server — that is `assertNoCapabilityCollision`'s job at
// the driver, which refuses the SESSION (typed) rather than choose.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@yanlinglabs/winter-agent-sdk";
import type { McpServerSettingsEntry, Settings } from "../settings";
import { extractRawMcpServers, parseProjectMcpServers } from "../agent/mcp/project-file";

// The project `.mcp.json` schema/parser now lives in `../agent/mcp/project-file` — shared with
// `agent/mcp/manager.ts`'s own reader and the CLI's `mcp add/remove --scope project`/`mcp get`
// (`mcp-cli.ts`), which previously would have been a THIRD hand-copied duplicate of this exact
// shape (this file and the manager each had their own before). `parseProjectMcpServers` is the
// PARITY FIX (controller-directed): validates the project's `mcpServers` map PER ENTRY against the
// same stdio/http/sse shape `settings.mcpServers` accepts, instead of the old one-shot
// `ProjectMcpConfig.parse(...)` that failed the WHOLE map (and so contributed NOTHING to the
// session) the moment any single entry — an http/sse one, most commonly — didn't fit.

export interface ConfiguredMcpInput {
  /** THE LIVE settings (a getter's answer, never a boot snapshot). */
  settings: Settings | null | undefined;
  /** The session's cwd — where `.mcp.json` is looked for (the manager's own rule: `<cwd>/.mcp.json`,
   *  not the repo root). */
  cwd: string | undefined;
  /** `TrustStore.isTrusted` — an untrusted cwd contributes no project servers and is never read. */
  trusted: (dir: string) => boolean;
  /** Test seam: how `<cwd>/.mcp.json` is read. */
  readFile?: (path: string) => string;
  /** One log line per project-scope entry this function could not forward to the child — named,
   *  with why (`parseProjectMcpServers`' own per-branch message). Optional: a caller with no logger
   *  (every existing test) simply gets silence, matching this function's own pre-existing "a
   *  malformed file contributes nothing, quietly" posture for the file-level failure modes. */
  log?: (message: string) => void;
}

function stdio(cfg: { command: string; args?: string[]; env?: Record<string, string> }): McpServerConfig {
  return {
    type: "stdio",
    command: cfg.command,
    ...(cfg.args === undefined ? {} : { args: [...cfg.args] }),
    ...(cfg.env === undefined ? {} : { env: { ...cfg.env } }),
  };
}

/** `settings.mcpServers`' own entry shape (already `type`-discriminated by the schema, batch 3 item
 *  3b) straight onto the matching SDK config — no translation beyond copying the fields the SDK
 *  type actually has (`tools`/`timeout`/`alwaysLoad` are NOT in Winter's settings grammar today, so
 *  they are never set here; the SDK treats an absent optional field the same as one explicitly
 *  omitted). */
function toMcpServerConfig(entry: McpServerSettingsEntry): McpServerConfig {
  if (entry.type === "stdio") return stdio(entry);
  return { type: entry.type, url: entry.url, ...(entry.headers === undefined ? {} : { headers: { ...entry.headers } }) };
}

/** The `Options.mcpServers` entries Winter's configuration contributes to ONE session, keyed as the
 *  daemon's registry keys them. Never throws: a missing `.mcp.json`, or one that isn't even
 *  shaped like a project MCP config, contributes nothing (the manager's own "record none" posture)
 *  — but a project file that IS shaped right contributes every entry that validates, PER ENTRY
 *  (`parseProjectMcpServers`): one bad or differently-shaped sibling entry no longer takes the rest
 *  down with it (the parity fix this function's own header describes). Batch 3 (item 3a): a server
 *  named in `settings.mcp.disabled` is withheld entirely — neither leg ever sees it, the same
 *  "absent, not a present-but-inert entry" posture every other disable switch in this codebase
 *  takes. */
export function configuredMcpServersFor(input: ConfiguredMcpInput): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  const disabled = new Set(input.settings?.mcp?.disabled ?? []);
  if (input.cwd !== undefined && input.cwd !== "") {
    let dir = input.cwd;
    try { dir = realpathSync(dir); } catch { /* the manager falls back to the given path too */ }
    if (input.trusted(dir)) {
      let extracted: ReturnType<typeof extractRawMcpServers>;
      try {
        const raw = (input.readFile ?? ((p: string) => readFileSync(p, "utf8")))(join(dir, ".mcp.json"));
        extracted = extractRawMcpServers(JSON.parse(raw));
      } catch {
        extracted = undefined; // missing file, unreadable, or malformed JSON → nothing from the project, unchanged
      }
      if (extracted) {
        const { servers, skipped } = parseProjectMcpServers(extracted.servers);
        for (const { name, reason } of skipped) input.log?.(`mcp: project server '${name}' (${dir}) skipped — ${reason}`);
        // THE CHILD speaks stdio/http/sse directly (this file's own header) — every valid entry,
        // whichever transport, is forwarded via the SAME `toMcpServerConfig` a user-scope entry
        // goes through below.
        for (const [name, entry] of Object.entries(servers)) {
          if (!disabled.has(name)) out[name] = toMcpServerConfig(entry);
        }
      }
    }
  }
  // User servers LAST so they shadow a same-keyed project server (the registry's precedence).
  for (const [name, sc] of Object.entries(input.settings?.mcpServers ?? {})) {
    if (disabled.has(name)) continue;
    out[name] = toMcpServerConfig(sc);
  }
  return out;
}
