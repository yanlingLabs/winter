// WS-25 (MCP OAuth, spec §2): the daemon's sign-in doors over a REAL IPC server — `mcp.login`,
// `mcp.loginStatus`, `mcp.logout`, `mcp.setClientSecret` and `mcp.list`'s auth columns — against the fixture
// authorization server (a loopback copy of the SDK's; never a real one), with an in-memory MCP OAuth store
// (never the Keychain).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, McpLoginResult, McpSetClientSecretResult, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { canonicalMcpServerUrl, createMemoryMcpOAuthStore, decodeMcpOAuthClientSecretItem, encodeMcpOAuthClientRecord, mcpOAuthClientAccount, mcpOAuthClientSecretAccount, mcpOAuthTokenAccount } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings } from "../../src/settings";
import { McpManager } from "../../src/agent/mcp/manager";
import { TrustStore } from "../../src/agent/trust";
import { credentialInventory } from "../../src/runtime-sdk/keychain";
import { startFixtureAs, type FixtureAs } from "../fixtures/mcp-oauth-fixture-as";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName: "mcp-oauth-test" });
  }

  close(): void { this.socket.end(); }
}

/** A free loopback port (bound and released), for a pre-registered client's fixed redirect URI. */
function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!(await check())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("the MCP sign-in doors (WS-25)", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => { for (const f of cleanup.reverse()) f(); cleanup = []; });

  async function boot(opts: { userServers?: Record<string, unknown>; project?: { servers: Record<string, unknown>; trusted: boolean }; loginTtlMs?: number; winter?: unknown } = {}) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-oauth-")));
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({ mcpServers: opts.userServers ?? {} }));
    const trust = new TrustStore(join(home, "trust.json"));
    let projectDir: string | undefined;
    if (opts.project !== undefined) {
      projectDir = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-oauth-proj-")));
      mkdirSync(join(projectDir, ".winter"), { recursive: true });
      writeFileSync(join(projectDir, ".winter", "mcp.json"), JSON.stringify({ mcpServers: opts.project.servers }));
      if (opts.project.trusted) trust.trust(projectDir);
    }
    const oauthStore = createMemoryMcpOAuthStore();
    const mcp = new McpManager({ trust, remote: { oauthStore: () => oauthStore } });
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, mcp, trust,
      mcpOAuth: { store: oauthStore, ...(opts.loginTtlMs !== undefined ? { loginTtlMs: opts.loginTtlMs } : {}) },
      ...(opts.winter !== undefined ? { winter: opts.winter as never } : {}),
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness);
    cleanup.push(() => { c.close(); server.stop(); store.close(); });
    return { home, c, oauthStore, projectDir, store, tokens, socketPath };
  }

  function fixture(opts: Parameters<typeof startFixtureAs>[0] = {}): FixtureAs {
    const fx = startFixtureAs(opts);
    cleanup.push(() => fx.close());
    return fx;
  }

  test("a bare { name } sign-in (the Mac's call): login → the browser approves → done → mcp.list shows signed-in + connected", async () => {
    const fx = fixture();
    const { c, oauthStore } = await boot({ userServers: { linear: { type: "http", url: fx.mcpUrl } } });

    const before = await c.request(METHODS.mcpList, {});
    expect(before.result.servers).toEqual([{ name: "linear", status: "needs-auth", toolNames: [], source: "user", transport: "http", auth: "needs-auth" }]);

    const start = await c.request(METHODS.mcpLogin, { name: "linear" });
    expect(start.error).toBeUndefined();
    expect(start.result).toMatchObject({ issuerOrigin: fx.origin, authorizeOrigin: fx.origin });
    // WS-25 integration: the reply satisfies the protocol schema, whose `authorizeOrigin` is REQUIRED
    // (the Mac's decoder refuses a reply without it).
    expect(McpLoginResult.strict().safeParse(start.result).success).toBe(true);
    expect(start.result.loginId).toMatch(/^ml_[0-9a-f]{24}$/);
    expect((await c.request(METHODS.mcpLoginStatus, { loginId: start.result.loginId })).result).toEqual({ state: "pending" });

    const { callbackStatus } = await fx.approve(start.result.authUrl);
    expect(callbackStatus).toBe(200);
    await until(async () => (await c.request(METHODS.mcpLoginStatus, { loginId: start.result.loginId })).result.state === "done");
    expect(await oauthStore.read(mcpOAuthTokenAccount(fx.mcpUrl))).not.toBeNull();

    const after = await c.request(METHODS.mcpList, {});
    const row = after.result.servers[0];
    expect(row).toMatchObject({ name: "linear", status: "connected", auth: "signed-in", oauthIssuerOrigin: fx.origin, transport: "http" });
    expect(row.toolNames.length).toBeGreaterThan(0);
    expect(row.oauthPreregistered).toBeUndefined();
    // Nothing secret on the listing.
    const raw = (await oauthStore.read(mcpOAuthTokenAccount(fx.mcpUrl)))!;
    expect(JSON.stringify(after.result)).not.toContain(JSON.parse(raw).accessToken);
  });

  test("an unknown login id, and a login nobody completes within its lifetime, read `expired` — and the listener is closed", async () => {
    const fx = fixture();
    const { c } = await boot({ userServers: { linear: { type: "http", url: fx.mcpUrl } }, loginTtlMs: 200 });
    expect((await c.request(METHODS.mcpLoginStatus, { loginId: "ml_nope" })).result).toEqual({ state: "expired" });
    const start = await c.request(METHODS.mcpLogin, { name: "linear" });
    await until(async () => (await c.request(METHODS.mcpLoginStatus, { loginId: start.result.loginId })).result.state === "expired");
    await expect(fx.approve(start.result.authUrl)).rejects.toThrow();
  });

  test("a changed authorization server needs confirmation: typed, both origins, the stored registration put back; confirmed → proceeds", async () => {
    const fx = fixture();
    const { c, oauthStore } = await boot({ userServers: { linear: { type: "http", url: fx.mcpUrl } } });
    const stored = encodeMcpOAuthClientRecord({
      v: 1, kind: "mcp-oauth-client", serverUrl: fx.mcpUrl, issuer: "https://old-issuer.example.test", clientId: "old-client",
      registeredVia: "dcr", redirectUri: "http://127.0.0.1:1/callback",
    });
    await oauthStore.write(mcpOAuthClientAccount(fx.mcpUrl), stored);

    const refused = await c.request(METHODS.mcpLogin, { name: "linear" });
    expect(refused.result).toBeUndefined();
    expect(refused.error.data).toEqual({ code: "mcp_issuer_change_requires_confirmation", storedIssuer: "https://old-issuer.example.test", newIssuer: fx.issuer, storedIssuerOrigin: "https://old-issuer.example.test", newIssuerOrigin: fx.origin });
    expect(await oauthStore.read(mcpOAuthClientAccount(fx.mcpUrl))).toBe(stored); // nothing left behind

    const confirmed = await c.request(METHODS.mcpLogin, { name: "linear", confirmIssuerChange: true });
    expect(confirmed.error).toBeUndefined();
    await fx.approve(confirmed.result.authUrl);
    await until(async () => (await c.request(METHODS.mcpLoginStatus, { loginId: confirmed.result.loginId })).result.state === "done");
  });

  test("mcp.logout revokes and signs out, keeping the client registration; forgetClient removes it too", async () => {
    const fx = fixture();
    const { c, oauthStore } = await boot({ userServers: { linear: { type: "http", url: fx.mcpUrl } } });
    const signIn = async (): Promise<void> => {
      const start = await c.request(METHODS.mcpLogin, { name: "linear" });
      await fx.approve(start.result.authUrl);
      await until(async () => (await c.request(METHODS.mcpLoginStatus, { loginId: start.result.loginId })).result.state === "done");
    };
    await signIn();
    expect((await c.request(METHODS.mcpLogout, { name: "linear" })).result).toEqual({ ok: true });
    expect(await oauthStore.read(mcpOAuthTokenAccount(fx.mcpUrl))).toBeNull();
    expect(await oauthStore.read(mcpOAuthClientAccount(fx.mcpUrl))).not.toBeNull();
    expect(fx.revokedViaEndpoint.length).toBeGreaterThan(0);
    const listed = await c.request(METHODS.mcpList, {});
    expect(listed.result.servers[0]).toMatchObject({ status: "needs-auth", auth: "needs-auth" });

    await signIn();
    expect((await c.request(METHODS.mcpLogout, { name: "linear", forgetClient: true })).result).toEqual({ ok: true });
    expect(await oauthStore.read(mcpOAuthClientAccount(fx.mcpUrl))).toBeNull();
  });

  test("mcp.setClientSecret: the DERIVED account, bound to the user server's own issuer; never echoed; the sign-in then uses it", async () => {
    const port = freePort();
    const SECRET = "pre-registered-SECRET-value-xyz";
    const fx = fixture({ dcr: false, preregistered: [{ clientId: "winter-gh", clientSecret: SECRET, redirectUris: [`http://127.0.0.1:${port}/callback`] }] });
    const { c, oauthStore } = await boot({
      userServers: { gh: { type: "http", url: fx.mcpUrl, oauth: { clientId: "winter-gh", clientSecretRef: { kind: "keychain" }, callbackPort: port } } },
    });
    const errSpy = spyOn(console, "error");
    try {
      const listed = await c.request(METHODS.mcpList, {});
      expect(listed.result.servers[0]).toMatchObject({ auth: "needs-auth", oauthPreregistered: true });

      // Before the secret: the sign-in is refused typed, naming the door.
      const early = await c.request(METHODS.mcpLogin, { name: "gh" });
      expect(early.error.data.code).toBe("mcp_client_secret_unavailable");

      // Confirm first: the issuer the secret would be bound to, discovered without a flow.
      const shown = await c.request(METHODS.mcpClientSecretIssuer, { name: "gh" });
      expect(shown.result).toEqual({ name: "gh", issuer: fx.issuer, issuerOrigin: fx.origin, authorizeOrigin: fx.origin });
      const unconfirmed = await c.request(METHODS.mcpSetClientSecret, { name: "gh", secret: SECRET });
      expect(unconfirmed.error.data).toEqual({ code: "mcp_expected_issuer_required", issuer: fx.issuer, issuerOrigin: fx.origin });
      expect(JSON.stringify(unconfirmed)).not.toContain(SECRET);
      expect(await oauthStore.read(mcpOAuthClientSecretAccount(fx.mcpUrl))).toBeNull();
      const set = await c.request(METHODS.mcpSetClientSecret, { name: "gh", secret: SECRET, expectedIssuer: shown.result.issuer });
      expect(set.result).toEqual({ ok: true, issuer: fx.issuer, issuerOrigin: fx.origin });
      expect(McpSetClientSecretResult.strict().safeParse(set.result).success).toBe(true); // issuer/issuerOrigin REQUIRED
      expect(JSON.stringify(set)).not.toContain(SECRET);
      const item = decodeMcpOAuthClientSecretItem((await oauthStore.read(mcpOAuthClientSecretAccount(fx.mcpUrl)))!);
      expect(item).toEqual({ secret: SECRET, issuer: fx.issuer });
      // Discovery registered nothing and posted nothing.
      expect(fx.registrations).toEqual([]);
      expect(fx.tokenPosts).toEqual([]);

      const start = await c.request(METHODS.mcpLogin, { name: "gh" });
      expect(start.error).toBeUndefined();
      await fx.approve(start.result.authUrl);
      await until(async () => (await c.request(METHODS.mcpLoginStatus, { loginId: start.result.loginId })).result.state === "done");
      expect(errSpy.mock.calls.map((call) => String(call[0])).some((l) => l.includes(SECRET))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("mcp.setClientSecret refuses: a project server with no user-scope counterpart, a non-pre-registered server, a stdio server, an unknown name", async () => {
    const fx = fixture();
    const { c, projectDir } = await boot({
      userServers: { plain: { type: "http", url: fx.mcpUrl }, tool: { type: "stdio", command: "true" } },
      project: { servers: { repo: { type: "http", url: `${fx.origin}/other-mcp`, oauth: { clientId: "c", clientSecretRef: { kind: "keychain" }, authServerMetadataUrl: `${fx.origin}/.well-known/oauth-authorization-server` } } }, trusted: true },
    });
    const code = async (params: Record<string, unknown>): Promise<string> => (await c.request(METHODS.mcpSetClientSecret, { secret: "s", expectedIssuer: fx.issuer, ...params })).error?.data?.code;
    expect(await code({ name: "repo", cwd: projectDir })).toBe("mcp_secret_needs_user_scope");
    expect(await code({ name: "plain" })).toBe("mcp_not_preregistered");
    expect(await code({ name: "tool" })).toBe("mcp_oauth_not_applicable");
    expect(await code({ name: "ghost" })).toBe("mcp_server_not_found");
    expect(await code({ name: "repo", scope: "project" })).toBe("mcp_scope_needs_cwd");
  });

  test("an UNTRUSTED project's server is never read; a trusted one resolves through the session fold (project over user)", async () => {
    const fx = fixture();
    const other = fixture();
    const { c, projectDir } = await boot({
      userServers: { linear: { type: "http", url: other.mcpUrl } },
      project: { servers: { linear: { type: "http", url: fx.mcpUrl } }, trusted: false },
    });
    // Untrusted: the fold skips the project and the user's server is the one meant.
    const viaUser = await c.request(METHODS.mcpLogin, { name: "linear", cwd: projectDir });
    expect(viaUser.result.issuerOrigin).toBe(other.origin);
    expect((await c.request(METHODS.mcpLogin, { name: "linear", scope: "project", cwd: projectDir })).error.data.code).toBe("mcp_project_untrusted");
  });

  test("mcp.add stores an oauth block and mcp.get echoes it; a secret value, a named secret account and a loopback metadata URL are refused", async () => {
    const { c } = await boot();
    const oauth = { clientId: "Iv1.x", clientSecretRef: { kind: "keychain" }, callbackPort: 47823, scopes: ["repo"] };
    const added = await c.request(METHODS.mcpAdd, { name: "gh", scope: "user", entry: { type: "http", url: "https://api.example.test/mcp", oauth } });
    expect(added.error).toBeUndefined();
    const got = await c.request(METHODS.mcpGet, { name: "gh", scope: "user" });
    expect(got.result.oauth).toEqual(oauth);
    const bad = async (o: unknown): Promise<any> => (await c.request(METHODS.mcpAdd, { name: `b${Math.random().toString(36).slice(2, 8)}`, scope: "user", entry: { type: "http", url: "https://api.example.test/mcp2", oauth: o } })).error;
    const secretValue = await bad({ clientId: "x", clientSecret: "VALUE-never-echoed" });
    expect(secretValue).toBeDefined();
    expect(JSON.stringify(secretValue)).not.toContain("VALUE-never-echoed");
    expect(await bad({ clientId: "x", clientSecretRef: { kind: "keychain", account: "openai:default" } })).toBeDefined();
    const loopback = await bad({ authServerMetadataUrl: "http://127.0.0.1:9/.well-known/oauth-authorization-server" });
    expect(loopback.message).toMatch(/authServerMetadataUrl/);
  });

  test("an SDK issuer check that refuses a sign-in surfaces as the door's code with the SDK's own code in data.reason (the Mac reads it there)", async () => {
    const fx = fixture();
    // A metadata document that claims the REAL authorization server's issuer while being served from
    // somewhere else: RFC 8414 §3.3 says its issuer must equal the URL it was fetched from.
    const liar = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: async () => {
        const real = await (await fetch(`${fx.origin}/.well-known/oauth-authorization-server`)).json();
        return Response.json(real);
      },
    });
    cleanup.push(() => liar.stop(true));
    const metadataUrl = `http://127.0.0.1:${liar.port}/.well-known/oauth-authorization-server`;
    const { c } = await boot({ userServers: { linear: { type: "http", url: fx.mcpUrl, oauth: { authServerMetadataUrl: metadataUrl } } } });
    const refused = await c.request(METHODS.mcpLogin, { name: "linear" });
    expect(refused.error.data).toMatchObject({ code: "mcp_login_failed", reason: "metadata_issuer_mismatch" });
    expect(fx.registrations).toEqual([]);
    expect(fx.tokenPosts).toEqual([]);
  });

  test("the sign-in doors are LOCAL role only, and the credential inventory never lists an MCP sign-in item", () => {
    for (const m of [METHODS.mcpLogin, METHODS.mcpLoginStatus, METHODS.mcpLogout, METHODS.mcpSetClientSecret, METHODS.mcpClientSecretIssuer]) {
      expect(REMOTE_ALLOWED_METHODS.has(m)).toBe(false);
    }
    expect(credentialInventory().some((slot) => slot.secretName.startsWith("mcp-oauth") || slot.provider.startsWith("mcp-oauth"))).toBe(false);
  });

  test("after a sign-in, every live child that configures the server's URL is asked to reconnect it (by ITS name), a mid-turn one at its idle boundary", async () => {
    const fx = fixture();
    const calls: string[] = [];
    let releaseIdle!: () => void;
    const idleGate = new Promise<void>((r) => { releaseIdle = r; });
    const sessions: Array<Record<string, unknown>> = [];
    const winter = { list: () => sessions };
    const { c, store } = await boot({ userServers: { linear: { type: "http", url: fx.mcpUrl }, unrelated: { type: "http", url: `${fx.origin}/elsewhere` } }, winter });
    const idle = store.createSession("u", { cwd: tmpdir() });
    const busy = store.createSession("u", { cwd: tmpdir() });
    // Each double answers like `WinterSession.mcpServerNamesFor` (its live incarnation's own names, compared
    // canonically) -- the busy one names the server differently, so the door must use each session's own name.
    const namesAt = (names: Record<string, string>) => (url: string): string[] =>
      Object.entries(names).filter(([, u]) => canonicalMcpServerUrl(u) === canonicalMcpServerUrl(url)).map(([n]) => n);
    const unrelated = `${fx.origin}/elsewhere`;
    sessions.push(
      { sessionId: idle, turnRunning: false, idle: async () => {}, mcpServerNamesFor: namesAt({ linear: fx.mcpUrl, other: unrelated }), reconnectMcpServer: async (n: string) => { calls.push(`${idle}:${n}`); } },
      { sessionId: busy, turnRunning: true, idle: () => idleGate, mcpServerNamesFor: namesAt({ "linear-work": `${fx.mcpUrl}/` }), reconnectMcpServer: async (n: string) => { calls.push(`${busy}:${n}`); } },
    );
    const start = await c.request(METHODS.mcpLogin, { name: "linear" });
    await fx.approve(start.result.authUrl);
    await until(async () => calls.length >= 1);
    expect(calls).toEqual([`${idle}:linear`]);
    releaseIdle();
    await until(async () => calls.length >= 2);
    expect(calls).toEqual([`${idle}:linear`, `${busy}:linear-work`]);
  });
});
