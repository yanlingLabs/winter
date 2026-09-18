// Fix wave (review row 7): Winter's configured MCP servers → the SDK's stdio configs, keyed as the
// daemon's registry keys them, trust-gated for the project half.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredMcpServersFor } from "../../src/runtime-sdk/external-mcp";
import { Settings, loadSettings } from "../../src/settings";

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
// McpSSEServerConfig shapes. Ruling (fix wave item 6): a credential-shaped header (e.g.
// `Authorization`) is refused at the SETTINGS door (`Settings.parse`, `settings.test.ts`'s own
// dedicated describe block) — it can never reach this function at all, so this fixture uses a
// benign header. `configuredMcpServersFor` is the ONE function BOTH legs' options builders read
// from (`mode-options.ts`'s `buildWinterOptions` and `official-options.ts`'s `officialInputFor`
// both consume its output verbatim), so proving a benign header survives here is proving it reaches
// both legs, not just one.
test("an HTTP server and an SSE server pass through with their own shape (url, headers) — never coerced to stdio", () => {
  const settings = Settings.parse({
    schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" },
    mcpServers: {
      httpOne: { type: "http", url: "https://example.com/mcp", headers: { "X-Request-Id": "abc123" } },
      sseOne: { type: "sse", url: "https://example.com/sse" },
    },
  });
  const out = configuredMcpServersFor({ settings, cwd: undefined, trusted: () => false });
  expect(out).toEqual({
    httpOne: { type: "http", url: "https://example.com/mcp", headers: { "X-Request-Id": "abc123" } },
    sseOne: { type: "sse", url: "https://example.com/sse" },
  });
});

// Read-door follow-up (the ruling correction): a hand-edited settings.json carrying a
// credential-shaped header must still boot the daemon (`loadSettings` strips rather than refuses —
// see settings.test.ts's own dedicated describe block), and the stripped header must never reach
// EITHER leg's `Options` — `configuredMcpServersFor` is the one function both `mode-options.ts`'s
// `buildWinterOptions` and `official-options.ts`'s `officialInputFor` consume verbatim, so proving
// it is absent from THIS function's output proves it is absent from both legs.
test("a credential-shaped header a user hand-edited into settings.json is stripped by loadSettings and never reaches configuredMcpServersFor's output", () => {
  const dir = mkdtempSync(join(tmpdir(), "winter-ext-mcp-cred-header-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" },
    mcpServers: {
      httpOne: {
        type: "http", url: "https://example.com/mcp",
        headers: { Authorization: "Bearer sk-SENTINEL-should-never-reach-options", "X-Request-Id": "abc123" },
      },
    },
  }));
  // Load through the real daemon-facing door (not Settings.parse, which would itself refuse this
  // shape) — this IS the read door under test.
  const settings = loadSettings(path);
  const out = configuredMcpServersFor({ settings, cwd: undefined, trusted: () => false });
  expect(out).toEqual({ httpOne: { type: "http", url: "https://example.com/mcp", headers: { "X-Request-Id": "abc123" } } });
  expect(JSON.stringify(out)).not.toContain("sk-SENTINEL");
  expect(JSON.stringify(out)).not.toContain("Authorization");
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
