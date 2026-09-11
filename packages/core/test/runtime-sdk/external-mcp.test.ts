// Fix wave (review row 7): Norma's configured MCP servers → the SDK's stdio configs, keyed as the
// daemon's registry keys them, trust-gated for the project half.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredMcpServersFor } from "../../src/runtime-sdk/external-mcp";
import type { Settings } from "../../src/settings";

const settingsWith = (servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>): Settings =>
  ({ mcpServers: servers } as unknown as Settings);

test("user servers from settings.mcpServers become stdio configs under their own keys (mcp__<key>__<tool> on the child)", () => {
  const out = configuredMcpServersFor({
    settings: settingsWith({ fake: { command: "bun", args: ["run", "fake.ts"], env: { A: "1" } }, bare: { command: "npx" } }),
    cwd: undefined, trusted: () => false,
  });
  expect(out).toEqual({
    fake: { type: "stdio", command: "bun", args: ["run", "fake.ts"], env: { A: "1" } },
    bare: { type: "stdio", command: "npx" },
  });
});

test("a TRUSTED project's <cwd>/.mcp.json contributes its servers; an UNTRUSTED one contributes nothing and is never read", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "norma-ext-mcp-")));
  try {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "bun", args: ["run", "p.ts"] } } }));
    expect(configuredMcpServersFor({ settings: null, cwd: dir, trusted: () => true })).toEqual({ proj: { type: "stdio", command: "bun", args: ["run", "p.ts"] } });
    const reads: string[] = [];
    expect(configuredMcpServersFor({ settings: null, cwd: dir, trusted: () => false, readFile: (p) => { reads.push(p); return "{}"; } })).toEqual({});
    expect(reads).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing or malformed .mcp.json contributes nothing and never throws; a user server shadows a same-keyed project server", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "norma-ext-mcp-bad-")));
  try {
    expect(configuredMcpServersFor({ settings: null, cwd: dir, trusted: () => true })).toEqual({});
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    expect(configuredMcpServersFor({ settings: null, cwd: dir, trusted: () => true })).toEqual({});
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "project-cmd" }, only: { command: "p" } } }));
    const out = configuredMcpServersFor({ settings: settingsWith({ shared: { command: "user-cmd" } }), cwd: dir, trusted: () => true });
    expect(out.shared).toEqual({ type: "stdio", command: "user-cmd" });
    expect(out.only).toEqual({ type: "stdio", command: "p" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no settings, no cwd → nothing (a bare daemon forwards no servers)", () => {
  expect(configuredMcpServersFor({ settings: undefined, cwd: undefined, trusted: () => true })).toEqual({});
  expect(configuredMcpServersFor({ settings: null, cwd: "", trusted: () => true })).toEqual({});
});
