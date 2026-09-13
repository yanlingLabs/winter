// Winter Phase 10a (O6): provider.configure's anthropic arm + provider.login/loginCode/logout/
// status, exercised over a bare IPC server (own SessionStore + TokenAuthority, no AgentEngine),
// same harness shape as remote-role.test.ts's boot() — no shared test-harness module exists in
// this codebase; every *.test.ts in test/ipc carries its own copy.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import type { ConsoleProfileBroker } from "../../src/auth/console-profile-broker";
import { Settings, saveSettings } from "../../src/settings";

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from remote-role.test.ts's copy,
 *  extended with an `event` collector (this suite asserts on the provider_login_* broadcasts). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: any[] = [];

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.method === METHODS.event) { c.events.push(msg.params); continue; }
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

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** A fake `ConsoleProfileBroker` recording every call — no spawn, no SDK. */
function fakeBroker(overrides: Partial<ConsoleProfileBroker> = {}): { broker: ConsoleProfileBroker; calls: string[] } {
  const calls: string[] = [];
  const broker: ConsoleProfileBroker = {
    login: async (onLine) => {
      calls.push("login");
      onLine("Opening browser to sign in...");
      return { submitCode: async () => { calls.push("submitCode"); }, done: Promise.resolve({ ok: true, profile: "winter" }) };
    },
    profileExists: () => { calls.push("profileExists"); return false; },
    refreshBearer: async () => { calls.push("refreshBearer"); return { ok: true, expiresAt: 1 }; },
    logout: async () => { calls.push("logout"); },
    startRefresher: () => { calls.push("startRefresher"); },
    stopRefresher: () => { calls.push("stopRefresher"); },
    ...overrides,
  };
  return { broker, calls };
}

describe("provider.configure — the anthropic auth-mode arm (P10a-3)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "winter-provider-console-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({ schemaVersion: 2, provider: { type: "codex-oauth", model: "x" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const { broker, calls } = fakeBroker();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, consoleBroker: broker });
    stop = () => { server.stop(); store.close(); };
    return { home, settingsPath, socketPath, harnessToken: tokens.harness, secrets, calls };
  }

  test("writes exactly runtimes.official.auth, preserving the rest of settings.json", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.providerConfigure, { provider: "anthropic", settings: { "runtimes.official.auth": "console" } });
    expect(result.result).toEqual({ ok: true });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.runtimes.official.auth).toBe("console");
    expect(written.provider).toEqual({ type: "codex-oauth", model: "x" }); // untouched
    c.close();
  });

  test("a second write with a different value hot-reloads (no restart, no daemon involved at all)", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.providerConfigure, { provider: "anthropic", settings: { "runtimes.official.auth": "console" } });
    await c.request(METHODS.providerConfigure, { provider: "anthropic", settings: { "runtimes.official.auth": "api-key" } });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.runtimes.official.auth).toBe("api-key");
    c.close();
  });
});

describe("provider.login / provider.loginCode / provider.logout (O6, P10a-6)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(brokerOverrides: Partial<ConsoleProfileBroker> = {}) {
    const home = mkdtempSync(join(tmpdir(), "winter-provider-login-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const { broker, calls } = fakeBroker(brokerOverrides);
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, consoleBroker: broker });
    stop = () => { server.stop(); store.close(); };
    return { socketPath, harnessToken: tokens.harness, calls };
  }

  test("provider.login returns {started:true} immediately and streams a provider_login_progress line", async () => {
    const { socketPath, harnessToken, calls } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.providerLogin, { provider: "anthropic", kind: "console" });
    expect(result.result).toEqual({ started: true });
    await waitFor(() => c.events.some((e) => e.type === "provider_login_progress"));
    const progress = c.events.find((e) => e.type === "provider_login_progress");
    expect(progress).toMatchObject({ provider: "anthropic", line: "Opening browser to sign in...", sessionId: "$system" });
    expect(calls).toContain("login");
    c.close();
  });

  test("provider.login's handle resolving ok broadcasts provider_login_finished {ok:true}", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.providerLogin, { provider: "anthropic", kind: "console" });
    await waitFor(() => c.events.some((e) => e.type === "provider_login_finished"));
    const finished = c.events.find((e) => e.type === "provider_login_finished");
    expect(finished).toMatchObject({ provider: "anthropic", ok: true });
    c.close();
  });

  // Fix wave (M2): an RPC-driven (app/CLI-over-socket) login left the native-provider bearer
  // material un-refreshed until the NEXT daemon restart's own boot-time `profileExists()` check
  // (`daemon.ts`) — nothing here ever started the refresher for a login that happened while the
  // daemon was already up. `startRefresher()` must fire once the login handle resolves `ok: true`.
  test("a successful login also starts the broker's own refresher (M2)", async () => {
    const { socketPath, harnessToken, calls } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.providerLogin, { provider: "anthropic", kind: "console" });
    await waitFor(() => c.events.some((e) => e.type === "provider_login_finished"));
    await waitFor(() => calls.includes("startRefresher"));
    expect(calls).toContain("startRefresher");
    c.close();
  });

  test("a failed login broadcasts provider_login_finished {ok:false, reason}", async () => {
    const { socketPath, harnessToken, calls } = await boot({
      login: async () => ({ submitCode: async () => {}, done: Promise.resolve({ ok: false, reason: "exit_code_1" }) }),
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.providerLogin, { provider: "anthropic", kind: "console" });
    await waitFor(() => c.events.some((e) => e.type === "provider_login_finished"));
    expect(c.events.find((e) => e.type === "provider_login_finished")).toMatchObject({ ok: false, reason: "exit_code_1" });
    // M2: a FAILED login has no bearer to keep fresh — the refresher must never start on this path.
    expect(calls).not.toContain("startRefresher");
    c.close();
  });

  test("provider.loginCode forwards the code to the in-progress handle and never appears on the wire again", async () => {
    // `done` deliberately never settles — this test is about `submitCode` routing WHILE the login
    // is still in flight, not about the finished-broadcast (covered by the tests above).
    const { socketPath, harnessToken, calls } = await boot({
      login: async (onLine) => {
        calls.push("login");
        onLine("Opening browser to sign in...");
        return { submitCode: async () => { calls.push("submitCode"); }, done: new Promise(() => {}) };
      },
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.providerLogin, { provider: "anthropic", kind: "console" });
    const result = await c.request(METHODS.providerLoginCode, { provider: "anthropic", kind: "console", code: "123456" });
    expect(result.result).toEqual({ ok: true });
    expect(calls).toContain("submitCode");
    // The code itself must never be echoed back or broadcast anywhere.
    expect(JSON.stringify(c.events)).not.toContain("123456");
    c.close();
  });

  test("provider.loginCode with no login in progress refuses INVALID_PARAMS", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.providerLoginCode, { provider: "anthropic", kind: "console", code: "123456" });
    expect(result.error?.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  test("a second provider.login while one is already running is refused", async () => {
    const { socketPath, harnessToken } = await boot({
      login: async () => ({ submitCode: async () => {}, done: new Promise(() => {}) }), // never settles
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.providerLogin, { provider: "anthropic", kind: "console" });
    const second = await c.request(METHODS.providerLogin, { provider: "anthropic", kind: "console" });
    expect(second.error?.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  test("provider.logout forwards to the broker and returns {ok:true}", async () => {
    const { socketPath, harnessToken, calls } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.providerLogout, { provider: "anthropic", kind: "console" });
    expect(result.result).toEqual({ ok: true });
    expect(calls).toContain("logout");
    c.close();
  });

  test("without a consoleBroker wired, provider.login/logout refuse a typed INTERNAL failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-provider-login-none-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "cli");
    const login = await c.request(METHODS.providerLogin, { provider: "anthropic", kind: "console" });
    expect(login.error?.code).toBe(ERR.INTERNAL);
    const logout = await c.request(METHODS.providerLogout, { provider: "anthropic", kind: "console" });
    expect(logout.error?.code).toBe(ERR.INTERNAL);
    c.close();
  });
});

describe("provider.status (O6, P10a-3)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(opts: { auth?: "auto" | "api-key" | "console"; hasApiKey?: boolean; hasProfile?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), "winter-provider-status-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({
      schemaVersion: 2, provider: { type: "codex-oauth", model: "x" },
      ...(opts.auth === undefined ? {} : { runtimes: { official: { auth: opts.auth } } }),
    }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    if (opts.hasApiKey) await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-ant-x" });
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const { broker } = fakeBroker({ profileExists: () => opts.hasProfile ?? false });
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, consoleBroker: broker });
    stop = () => { server.stop(); store.close(); };
    return { socketPath, harnessToken: tokens.harness };
  }

  test("no credentials at all — auto/none", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.providerStatus, {});
    expect(result.result).toEqual({ anthropic: { apiKey: false, consoleProfile: false, auth: "auto", effective: "none" } });
    c.close();
  });

  test("api-key material present, auto -> effective api-key", async () => {
    const { socketPath, harnessToken } = await boot({ hasApiKey: true });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.providerStatus, {});
    expect(result.result).toEqual({ anthropic: { apiKey: true, consoleProfile: false, auth: "auto", effective: "api-key" } });
    c.close();
  });

  test("console profile present AND api key present, auto -> console wins", async () => {
    const { socketPath, harnessToken } = await boot({ hasApiKey: true, hasProfile: true });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.providerStatus, {});
    expect(result.result.anthropic).toEqual({ apiKey: true, consoleProfile: true, auth: "auto", effective: "console" });
    c.close();
  });

  test("explicit auth:\"console\" with no profile yet -> effective none (never silently falls back to api-key)", async () => {
    const { socketPath, harnessToken } = await boot({ auth: "console", hasApiKey: true, hasProfile: false });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.providerStatus, {});
    expect(result.result.anthropic).toEqual({ apiKey: true, consoleProfile: false, auth: "console", effective: "none" });
    c.close();
  });
});
