// WS-25: `McpManager`'s http/sse status probe through the runtime's public `/mcp-client`, with the
// daemon's MCP OAuth store — against the fixture authorization server (never a real one).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcpOAuthStore, startMcpOAuthLogin, type McpOAuthStore } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { McpManager } from "../../../src/agent/mcp/manager";
import { TrustStore } from "../../../src/agent/trust";
import { startFixtureAs, type FixtureAs } from "../../fixtures/mcp-oauth-fixture-as";

const trustNone = (): TrustStore => new TrustStore(join(realpathSync(mkdtempSync(join(tmpdir(), "mcp-remote-"))), "trust.json"));

async function signIn(fx: FixtureAs, store: McpOAuthStore): Promise<void> {
  const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
  await fx.approve(login.authUrl);
  expect(await login.done).toEqual({ ok: true });
}

describe("McpManager's http/sse probe (WS-25)", () => {
  let fx: FixtureAs | undefined;
  afterEach(() => { fx?.close(); fx = undefined; });

  test("without `remote` an http server is never connected (the pre-WS-25 behaviour)", async () => {
    fx = startFixtureAs();
    const mgr = new McpManager({ trust: trustNone() });
    await mgr.ensureRemote({ remote: { type: "http", url: fx.mcpUrl } });
    expect(mgr.list()).toEqual([]);
    expect(fx.mcpRequests).toBe(0);
  });

  test("a DEAD stored sign-in (expired, no refresh token) → needs-auth without one request (spec §1.2)", async () => {
    fx = startFixtureAs({ refreshTokens: false });
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const entries = (store as unknown as { entries: Map<string, string> }).entries;
    const account = [...entries.keys()].find((k) => k.startsWith("mcp-oauth:"))!;
    entries.set(account, JSON.stringify({ ...JSON.parse(entries.get(account)!), expiresAt: Date.now() - 1_000 }));
    const before = fx.mcpRequests;
    const mgr = new McpManager({ trust: trustNone(), remote: { oauthStore: () => store } });
    await mgr.ensureRemote({ remote: { type: "http", url: fx.mcpUrl } });
    expect(mgr.list()[0]).toMatchObject({ status: "needs-auth" });
    expect(fx.mcpRequests).toBe(before);
    expect(fx.tokenPosts.filter((g) => g === "refresh_token")).toEqual([]);
  });

  test("no sign-in → needs-auth (the server's own 401), and nothing is posted to the token endpoint", async () => {
    fx = startFixtureAs();
    const store = createMemoryMcpOAuthStore();
    const mgr = new McpManager({ trust: trustNone(), remote: { oauthStore: () => store } });
    await mgr.ensureRemote({ remote: { type: "http", url: fx.mcpUrl } });
    expect(mgr.list()).toEqual([{ name: "remote", status: "needs-auth", toolNames: [], source: "user", transport: "http" }]);
    // With NO stored sign-in the probe must ask: a server without an `oauth` block may need none at all.
    expect(fx.mcpRequests).toBeGreaterThan(0);
    expect(fx.tokenPosts).toEqual([]);
  });

  test("signed in → connected with its tools; recorded until forgotten, then re-probed", async () => {
    fx = startFixtureAs();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const mgr = new McpManager({ trust: trustNone(), remote: { oauthStore: () => store } });
    await mgr.ensureRemote({ remote: { type: "http", url: fx.mcpUrl } });
    const row = mgr.list()[0]!;
    expect(row).toMatchObject({ name: "remote", status: "connected", source: "user", transport: "http" });
    expect(row.toolNames.length).toBeGreaterThan(0);
    const before = fx.mcpRequests;
    await mgr.ensureRemote({ remote: { type: "http", url: fx.mcpUrl } });
    expect(fx.mcpRequests).toBe(before); // recorded: no second probe
    // A still-valid token is never refreshed at connect (spec §1.2).
    expect(fx.tokenPosts.filter((g) => g === "refresh_token")).toEqual([]);
    await store.remove([...(store as unknown as { entries: Map<string, string> }).entries.keys()].find((k) => k.startsWith("mcp-oauth:"))!);
    mgr.forgetRemote();
    await mgr.ensureRemote({ remote: { type: "http", url: fx.mcpUrl } });
    expect(mgr.list()[0]).toMatchObject({ status: "needs-auth" });
  });

  test("two concurrent lists join ONE probe", async () => {
    fx = startFixtureAs();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    let connects = 0;
    const mgr = new McpManager({
      trust: trustNone(),
      remote: { oauthStore: () => store },
      connect: async (opts) => {
        connects++;
        const { connectMcpServer } = await import("@yanlinglabs/winter-agent-runtime/mcp-client");
        return connectMcpServer(opts);
      },
    });
    await Promise.all([mgr.ensureRemote({ r: { type: "http", url: fx.mcpUrl } }), mgr.ensureRemote({ r: { type: "http", url: fx.mcpUrl } })]);
    expect(connects).toBe(1);
  });

  test("an unreachable server is a failed probe (not needs-auth)", async () => {
    const store = createMemoryMcpOAuthStore();
    const mgr = new McpManager({ trust: trustNone(), remote: { oauthStore: () => store } });
    // A closed loopback port: refused at once, no network beyond this machine.
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${dead.port}/mcp`;
    dead.stop(true);
    await mgr.ensureRemote({ gone: { type: "http", url, headers: { "x-static": "1" } } });
    expect(mgr.list()[0]).toMatchObject({ name: "gone", status: "failed", transport: "http" });
  });
});
