// Fix wave (whole-branch review row 7): Norma's CONFIGURED MCP servers, forwarded to a Winter child.
//
// Two sources, the same two `McpManager` starts for the daemon's shared registry (`agent/mcp/
// manager.ts`): the user's `settings.mcpServers` (source "user") and a TRUSTED project's
// `<cwd>/.mcp.json` (source "project", trust-gated exactly as `McpManager.ensureProject` gates it —
// an untrusted directory contributes nothing, and nothing is read from it). Both are stdio servers
// in Norma's settings grammar (`command`, `args`, `env`); they are forwarded as the SDK's
// `McpStdioServerConfig` under the SAME KEY the manager registers them under, so the child names
// their tools `mcp__<key>__<tool>` — the names `tool.list` and the Mac's tool rows already carry.
//
// THE CHILD SPAWNS ITS OWN COPY. The daemon's `McpManager` still runs these servers for the shared
// registry (`tool.list`, `mcp.*` RPCs); a Winter child cannot reach an in-daemon stdio client, so
// each session's child starts the configured servers itself from these configs. One extra process
// per configured server per live session — recorded in the fix-wave report as the cost of this
// door; the alternative (a `norma__external` capability server proxying the daemon's clients) is
// the plugin-contributed-tools carry and lands with it.
//
// PRECEDENCE mirrors the registry: user servers were started first there and project tools with a
// colliding name were skipped, so here a user server shadows a same-keyed project server. Neither
// may shadow a daemon-owned `norma__<key>` server — that is `assertNoCapabilityCollision`'s job at
// the driver, which refuses the SESSION (typed) rather than choose.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpStdioServerConfig } from "@yanlinglabs/winter-agent-sdk";
import type { Settings } from "../settings";

const ProjectMcpConfig = z.object({
  mcpServers: z.record(z.string(), z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })).optional(),
});

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

function stdio(cfg: { command: string; args?: string[]; env?: Record<string, string> }): McpStdioServerConfig {
  return {
    type: "stdio",
    command: cfg.command,
    ...(cfg.args === undefined ? {} : { args: [...cfg.args] }),
    ...(cfg.env === undefined ? {} : { env: { ...cfg.env } }),
  };
}

/** The `Options.mcpServers` entries Norma's configuration contributes to ONE session, keyed as the
 *  daemon's registry keys them. Never throws: a malformed or missing `.mcp.json` contributes nothing
 *  (the manager's own "record none" posture). */
export function configuredMcpServersFor(input: ConfiguredMcpInput): Record<string, McpStdioServerConfig> {
  const out: Record<string, McpStdioServerConfig> = {};
  if (input.cwd !== undefined && input.cwd !== "") {
    let dir = input.cwd;
    try { dir = realpathSync(dir); } catch { /* the manager falls back to the given path too */ }
    if (input.trusted(dir)) {
      try {
        const raw = (input.readFile ?? ((p: string) => readFileSync(p, "utf8")))(join(dir, ".mcp.json"));
        const cfg = ProjectMcpConfig.parse(JSON.parse(raw));
        for (const [name, sc] of Object.entries(cfg.mcpServers ?? {})) out[name] = stdio(sc);
      } catch { /* missing/malformed → nothing from the project */ }
    }
  }
  // User servers LAST so they shadow a same-keyed project server (the registry's precedence).
  for (const [name, sc] of Object.entries(input.settings?.mcpServers ?? {})) out[name] = stdio(sc);
  return out;
}
