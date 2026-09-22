// A3 (2026-09-22): top-level files a legacy home (`legacy-names.ts`'s `LEGACY_HOME_DIR`) carries
// that NOTHING in Winter reads — and that mislead a model reading the home. In s_56fc the agent
// "installed" an MCP server by editing `~/.winter/mcp.json`, a file Migration B had copied
// byte-for-byte from the legacy home's `mcp.json` and that no code has ever opened.
//
// THE EVIDENCE, per file (2026-09-22 sweep): no reader of `<home>/<name>` anywhere in
// `packages/*/src` or `apple/*`, and `git log -S` finds none of these names ever added to this repo
// — they predate it. The agent SDK's only `mcp.json` reader is the PROJECT file
// `<cwd>/.winter/mcp.json`, gated on `settingSources` including `project` (the daemon passes `[]`).
// MCP servers come from `settings.json → mcpServers` and a trusted project's `.mcp.json`
// (`daemon.ts`'s `configuredMcpServersFor`, `runtime-sdk/external-mcp.ts`, `agent/mcp/manager.ts`).
// `app-state.json` (150 MB on the user's machine) is NOT the `app-state/` directory, which the Mac
// app does use (`migrate-b.ts`'s `TOLERATED_APP_OWNED_TOP_LEVEL`).
//
// Migration B skips these (`classify`). For homes that already hold them, the daemon logs ONE boot
// line and `winter doctor` prints the same line. Nothing here ever modifies or deletes a user file.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Top-level only, and only these names — a plugin's own `mcp.json` deeper in the tree is someone
 *  else's file. Kept sorted; that is the order they are reported in. */
export const DEAD_LEGACY_TOP_LEVEL_FILES: readonly string[] = ["app-state.json", "mcp.json", "permissions.json", "tools.json", "toolsets.json"];

export interface DeadLegacyFile {
  name: string;
  path: string;
  /** `mcp.json` only: how many servers it declares (0 for an empty or unparsable file). */
  mcpServers?: number;
}

/** A read of an `mcp.json` is capped: it is only ever counted, and a pathological file must not
 *  cost boot anything. */
const MAX_MCP_JSON_BYTES = 1024 * 1024;

function countMcpServers(path: string, size: number): number {
  if (size === 0 || size > MAX_MCP_JSON_BYTES) return 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return 0;
    const record = parsed as Record<string, unknown>;
    const servers = "mcpServers" in record ? record.mcpServers : record;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return 0;
    return Object.values(servers).filter((v) => typeof v === "object" && v !== null && !Array.isArray(v)).length;
  } catch {
    return 0;
  }
}

/** The dead legacy files present at the top of `home` — regular files only (a directory or a
 *  symlink by one of these names is not what Migration B copied). Never throws. */
export function findDeadLegacyFiles(home: string): DeadLegacyFile[] {
  const found: DeadLegacyFile[] = [];
  for (const name of DEAD_LEGACY_TOP_LEVEL_FILES) {
    const path = join(home, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    found.push(name === "mcp.json" ? { name, path, mcpServers: countMcpServers(path, st.size) } : { name, path });
  }
  return found;
}

/** ONE line for the boot log and `winter doctor`, or `undefined` when there is nothing to say. File
 *  names and a server COUNT only — never file contents. */
export function describeDeadLegacyFiles(found: readonly DeadLegacyFile[], home: string): string | undefined {
  if (found.length === 0) return undefined;
  const mcp = found.find((f) => f.name === "mcp.json" && (f.mcpServers ?? 0) > 0);
  const names = found.map((f) => f.name).join(", ");
  const base = `legacy files: ${home} holds ${names} — copied from the legacy home and not read by Winter (left untouched)`;
  if (mcp === undefined) return base;
  const n = mcp.mcpServers!;
  return `${base}; mcp.json declares ${n} MCP server${n === 1 ? "" : "s"} that ${n === 1 ? "is" : "are"} NOT loaded — MCP servers belong under settings.json → mcpServers (or, in a trusted project, its .mcp.json)`;
}
