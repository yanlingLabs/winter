// `winter mcp add`/`add-json`/`remove`/`get` (CLI parity with `claude mcp add`/`remove`/`get`) —
// the USER-scope RPC handlers (`mcp.add`/`mcp.remove`/`mcp.get`, `ipc/server.ts`). Same bare IPC
// server harness as `mcp-enable-disable.test.ts` (no real MCP child process needed for these
// settings.json write-door tests).
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings } from "../../src/settings";
import { McpManager } from "../../src/agent/mcp/manager";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { TrustStore } from "../../src/agent/trust";

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

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("mcp.add / mcp.remove / mcp.get", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  // WS-21: the user scope is `sdk/.winter.json` `mcpServers` (claude's `.claude.json` shape).
  async function boot(userServers?: Record<string, unknown>) {
    const home = mkdtempSync(join(tmpdir(), "winter-mcp-add-remove-"));
    const base = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.6-sol" } };
    saveSettings(join(home, "settings.json"), Settings.parse(base));
    if (userServers !== undefined) {
      mkdirSync(join(home, "sdk"), { recursive: true });
      writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({ numStartups: 7, mcpServers: userServers }));
    }
    const trust = new TrustStore(join(home, "trust.json"));
    const mcp = new McpManager({ registry: new ToolRegistry(), trust });
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, mcp });
    stop = () => { server.stop(); store.close(); };
    return { home, socketPath, harnessToken: tokens.harness };
  }
  const globalConfig = (home: string): Record<string, any> => {
    const path = join(home, "sdk", ".winter.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  };

  test("mcp.add (scope user) writes a stdio entry into sdk/.winter.json mcpServers and mcp.get reads it back", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, { name: "my-server", entry: { type: "stdio", command: "npx", args: ["my-mcp"] }, scope: "user" });
    expect(add.result).toEqual({ ok: true, name: "my-server", transport: "stdio", started: true, scope: "user" });
    expect(globalConfig(home).mcpServers).toEqual({ "my-server": { type: "stdio", command: "npx", args: ["my-mcp"] } });
    expect(statSync(join(home, "sdk", ".winter.json")).mode & 0o777).toBe(0o600);
    // …and never into settings.json, where the key no longer lives.
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcpServers).toBeUndefined();
    const get = await c.request(METHODS.mcpGet, { name: "my-server", scope: "user" });
    expect(get.result).toEqual({ ok: true, name: "my-server", found: true, scope: "user", transport: "stdio", command: "npx", args: ["my-mcp"], disabled: false });
    c.close();
  });

  test("a stale settings.json mcpServers entry is invisible to mcp.get (a moved key)", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const raw = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    raw.mcpServers = { stale: { type: "stdio", command: "x" } };
    writeFileSync(join(home, "settings.json"), JSON.stringify(raw));
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    expect((await c.request(METHODS.mcpGet, { name: "stale", scope: "user" })).result.found).toBe(false);
    c.close();
  });

  test("mcp.get on an absent name reports found:false rather than an error", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const get = await c.request(METHODS.mcpGet, { name: "never-added", scope: "user" });
    expect(get.result).toEqual({ ok: true, name: "never-added", found: false, scope: "user" });
    c.close();
  });

  test("mcp.add refuses a reserved capability-server name typed, and writes nothing", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, { name: "winter__browser", entry: { type: "stdio", command: "x" }, scope: "user" });
    expect(add.error?.code).toBeDefined();
    expect(add.error?.message).toMatch(/reserved/);
    expect(existsSync(join(home, "sdk", ".winter.json"))).toBe(false);
    c.close();
  });

  test("mcp.add refuses a silent overwrite of an existing name", async () => {
    const { socketPath, harnessToken } = await boot({ existing: { type: "stdio", command: "x" } });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, { name: "existing", entry: { type: "stdio", command: "y" }, scope: "user" });
    expect(add.error?.message).toMatch(/already exists in user config/);
    c.close();
  });

  test("mcp.add refuses a credential-shaped header on an http entry, surfaced as a clear error, and writes nothing", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, {
      name: "remote",
      entry: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer sk-secret" } },
      scope: "user",
    });
    expect(add.error?.message).toMatch(/credential-shaped/);
    expect(add.error?.message).not.toContain("sk-secret");
    expect(existsSync(join(home, "sdk", ".winter.json"))).toBe(false);
    c.close();
  });

  test("mcp.add of an http entry is NOT started by the daemon's own registry (no in-daemon client)", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, { name: "remote", entry: { type: "http", url: "https://example.com/mcp" }, scope: "user" });
    expect(add.result).toEqual({ ok: true, name: "remote", transport: "http", started: false, scope: "user" });
    c.close();
  });

  test("mcp.add preserves every OTHER key of sdk/.winter.json", async () => {
    const { home, socketPath, harnessToken } = await boot({});
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.mcpAdd, { name: "my-server", entry: { type: "stdio", command: "x" }, scope: "user" });
    expect(globalConfig(home).numStartups).toBe(7);
    c.close();
  });

  test("mcp.remove drops the entry and reports removed:true; a second call reports removed:false", async () => {
    const { home, socketPath, harnessToken } = await boot({ existing: { type: "stdio", command: "x" } });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const first = await c.request(METHODS.mcpRemove, { name: "existing", scope: "user" });
    expect(first.result).toEqual({ ok: true, name: "existing", removed: true, scope: "user" });
    expect(globalConfig(home).mcpServers).toEqual({});
    const second = await c.request(METHODS.mcpRemove, { name: "existing", scope: "user" });
    expect(second.result).toEqual({ ok: true, name: "existing", removed: false, scope: "user" });
    c.close();
  });

  test("an unparseable sdk/.winter.json is refused typed and left untouched", async () => {
    const { home, socketPath, harnessToken } = await boot();
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", ".winter.json"), '{"mcpServers": {');
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, { name: "my-server", entry: { type: "stdio", command: "x" }, scope: "user" });
    expect(add.error?.data?.code).toBe("sdk_file_unreadable");
    expect(readFileSync(join(home, "sdk", ".winter.json"), "utf8")).toBe('{"mcpServers": {');
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpAdd)).toBe(false);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpRemove)).toBe(false);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpGet)).toBe(false);
  });
});
