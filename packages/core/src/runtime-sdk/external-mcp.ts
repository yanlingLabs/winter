// Fix wave (whole-branch review row 7): Winter's CONFIGURED MCP servers, forwarded to a Winter child.
//
// Two sources, the same two `McpManager` starts for the daemon's shared registry (`agent/mcp/
// manager.ts`): the user's `settings.mcpServers` (source "user") and a TRUSTED project's
// `<cwd>/.mcp.json` (source "project", trust-gated exactly as `McpManager.ensureProject` gates it —
// an untrusted directory contributes nothing, and nothing is read from it). The project's
// `.mcp.json` stays stdio-only (Claude Code's own file format, unrelated to this widening); daemon
// settings surface batch 3 (item 3b) widens the USER side (`settings.mcpServers`) to also accept the
// HTTP/SSE shapes both SDKs' `Options.mcpServers` support — forwarded to both legs UNDER THE SAME
// KEY the manager registers them under, so the child names their tools `mcp__<key>__<tool>` — the
// names `tool.list` and the Mac's tool rows already carry.
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
import { ProjectMcpConfig } from "../agent/mcp/project-file";

// `ProjectMcpConfig` (the `.mcp.json` schema) now lives in `../agent/mcp/project-file` — shared
// with `agent/mcp/manager.ts`'s own reader and the CLI's `mcp add/remove --scope project`
// (`mcp-cli.ts`), which previously would have been a THIRD hand-copied duplicate of this exact
// shape (this file and the manager each had their own before).

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
 *  daemon's registry keys them. Never throws: a malformed or missing `.mcp.json` contributes nothing
 *  (the manager's own "record none" posture). Batch 3 (item 3a): a server named in
 *  `settings.mcp.disabled` is withheld entirely — neither leg ever sees it, the same "absent, not a
 *  present-but-inert entry" posture every other disable switch in this codebase takes. */
export function configuredMcpServersFor(input: ConfiguredMcpInput): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  const disabled = new Set(input.settings?.mcp?.disabled ?? []);
  if (input.cwd !== undefined && input.cwd !== "") {
    let dir = input.cwd;
    try { dir = realpathSync(dir); } catch { /* the manager falls back to the given path too */ }
    if (input.trusted(dir)) {
      try {
        const raw = (input.readFile ?? ((p: string) => readFileSync(p, "utf8")))(join(dir, ".mcp.json"));
        const cfg = ProjectMcpConfig.parse(JSON.parse(raw));
        for (const [name, sc] of Object.entries(cfg.mcpServers ?? {})) {
          if (!disabled.has(name)) out[name] = stdio(sc);
        }
      } catch { /* missing/malformed → nothing from the project */ }
    }
  }
  // User servers LAST so they shadow a same-keyed project server (the registry's precedence).
  for (const [name, sc] of Object.entries(input.settings?.mcpServers ?? {})) {
    if (disabled.has(name)) continue;
    out[name] = toMcpServerConfig(sc);
  }
  return out;
}
