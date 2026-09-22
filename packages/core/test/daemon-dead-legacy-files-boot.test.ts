// A3: a home that already holds dead legacy files (copied by an earlier Migration B) gets ONE boot
// line naming them — and the files are left byte-identical.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { withTempHome } from "./runtime-state/support";

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  const stopping = daemon?.stop();
  daemon = undefined;
  await stopping;
});

async function bootCapturing(home: string): Promise<string[]> {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  try {
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("daemon boot — dead legacy files", () => {
  test("an mcp.json with a server and a tools.json: one line, files untouched", async () => {
    await withTempHome(async (home) => {
      const mcp = JSON.stringify({ mcpServers: { youtube: { command: "npx", args: ["-y", "yt-mcp"] } } });
      writeFileSync(join(home, "mcp.json"), mcp);
      writeFileSync(join(home, "tools.json"), "[]");
      const lines = (await bootCapturing(home)).filter((l) => l.startsWith("legacy files:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("mcp.json, tools.json");
      expect(lines[0]).toContain("mcp.json declares 1 MCP server");
      expect(lines[0]).toContain("settings.json → mcpServers");
      expect(readFileSync(join(home, "mcp.json"), "utf8")).toBe(mcp);
      expect(readFileSync(join(home, "tools.json"), "utf8")).toBe("[]");
    });
  });

  test("a home without them: no line", async () => {
    await withTempHome(async (home) => {
      const lines = await bootCapturing(home);
      expect(lines.some((l) => l.startsWith("legacy files:"))).toBe(false);
    });
  });
});
