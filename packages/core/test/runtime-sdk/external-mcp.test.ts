// Fix wave (review row 7): Winter's configured MCP servers → the SDK's stdio configs, keyed as the
// daemon's registry keys them, trust-gated for the project half.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredMcpServersFor } from "../../src/runtime-sdk/external-mcp";
import { Settings } from "../../src/settings";

// Daemon settings surface batch 3 (item 3b): a real `Settings.parse` always normalizes a `type`-less
// entry to `{ type: "stdio", ... }` (settings.ts's own preprocess step), so this helper stamps the
// SAME discriminant a live settings.json read would already carry by the time it reaches
// `configuredMcpServersFor` — never a raw shape the real type no longer allows.
const settingsWith = (servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>): Settings =>
  ({ mcpServers: Object.fromEntries(Object.entries(servers).map(([k, v]) => [k, { type: "stdio" as const, ...v }])) } as unknown as Settings);

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-ext-mcp-")));
  try {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "bun", args: ["run", "p.ts"] } } }));
    expect(configuredMcpServersFor({ settings: null, cwd: dir, trusted: () => true })).toEqual({ proj: { type: "stdio", command: "bun", args: ["run", "p.ts"] } });
    const reads: string[] = [];
    expect(configuredMcpServersFor({ settings: null, cwd: dir, trusted: () => false, readFile: (p) => { reads.push(p); return "{}"; } })).toEqual({});
    expect(reads).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing or malformed .mcp.json contributes nothing and never throws; a user server shadows a same-keyed project server", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-ext-mcp-bad-")));
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

// Daemon settings surface batch 3 (item 3b): HTTP/SSE settings.mcpServers entries survive into
// Options.mcpServers, field-for-field, mirroring the agent SDK's own McpHttpServerConfig/
// McpSSEServerConfig shapes.
test("an HTTP server and an SSE server pass through with their own shape (url, headers) — never coerced to stdio", () => {
  const settings = Settings.parse({
    schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" },
    mcpServers: {
      httpOne: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
      sseOne: { type: "sse", url: "https://example.com/sse" },
    },
  });
  const out = configuredMcpServersFor({ settings, cwd: undefined, trusted: () => false });
  expect(out).toEqual({
    httpOne: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
    sseOne: { type: "sse", url: "https://example.com/sse" },
  });
});

// Daemon settings surface batch 3 (item 3a): a server named in settings.mcp.disabled is withheld
// entirely from Options.mcpServers — for BOTH the user and the trusted-project source.
test("a disabled server is withheld entirely — neither a user nor a project entry of that name survives", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-ext-mcp-disabled-")));
  try {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { blocked: { command: "project-cmd" }, allowed: { command: "p" } } }));
    const settings = Settings.parse({
      schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" },
      mcpServers: { blocked: { type: "stdio", command: "user-cmd" }, kept: { type: "stdio", command: "keep" } },
      mcp: { disabled: ["blocked"] },
    });
    const out = configuredMcpServersFor({ settings, cwd: dir, trusted: () => true });
    expect(out.blocked).toBeUndefined();
    expect(out.kept).toEqual({ type: "stdio", command: "keep" });
    expect(out.allowed).toEqual({ type: "stdio", command: "p" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
