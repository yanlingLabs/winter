// `winter mcp add`/`add-json`/`remove`/`get` (CLI parity with `claude mcp add`/`remove`/`get`) —
// the USER-scope RPC handlers (`mcp.add`/`mcp.remove`/`mcp.get`, `ipc/server.ts`). Same bare IPC
// server harness as `mcp-enable-disable.test.ts` (no real MCP child process needed for these
// settings.json write-door tests).
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  async function boot(settingsOverride?: Record<string, unknown>) {
    const home = mkdtempSync(join(tmpdir(), "winter-mcp-add-remove-"));
    const base = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.6-sol" } };
    saveSettings(join(home, "settings.json"), Settings.parse({ ...base, ...settingsOverride }));
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

  test("mcp.add writes a stdio entry into settings.mcpServers and mcp.get reads it back", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, { name: "my-server", entry: { type: "stdio", command: "npx", args: ["my-mcp"] } });
    expect(add.result).toEqual({ ok: true, name: "my-server", transport: "stdio", started: true });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcpServers).toEqual({
      "my-server": { type: "stdio", command: "npx", args: ["my-mcp"] },
    });
    const get = await c.request(METHODS.mcpGet, { name: "my-server" });
    expect(get.result).toEqual({ ok: true, name: "my-server", found: true, transport: "stdio", command: "npx", args: ["my-mcp"], disabled: false });
    c.close();
  });

  test("mcp.get on an absent name reports found:false rather than an error", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const get = await c.request(METHODS.mcpGet, { name: "never-added" });
    expect(get.result).toEqual({ ok: true, name: "never-added", found: false });
    c.close();
  });

  test("mcp.add refuses a reserved capability-server name typed, and writes nothing", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, { name: "winter__browser", entry: { type: "stdio", command: "x" } });
    expect(add.error?.code).toBeDefined();
    expect(add.error?.message).toMatch(/reserved/);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcpServers).toBeUndefined();
    c.close();
  });

  test("mcp.add refuses a silent overwrite of an existing name", async () => {
    const { socketPath, harnessToken } = await boot({ mcpServers: { existing: { type: "stdio", command: "x" } } });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, { name: "existing", entry: { type: "stdio", command: "y" } });
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
    });
    expect(add.error?.message).toMatch(/credential-shaped/);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcpServers).toBeUndefined();
    c.close();
  });

  test("mcp.add of an http entry is NOT started by the daemon's own registry (no in-daemon client)", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const add = await c.request(METHODS.mcpAdd, { name: "remote", entry: { type: "http", url: "https://example.com/mcp" } });
    expect(add.result).toEqual({ ok: true, name: "remote", transport: "http", started: false });
    c.close();
  });

  test("mcp.add preserves every OTHER top-level settings key (a stray field survives)", async () => {
    const { home, socketPath, harnessToken } = await boot();
    // A stray top-level key this schema doesn't model, written directly (mirrors `saveSettings`'s
    // own round-trip-merge test posture elsewhere in this codebase).
    const raw = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    raw.aStrayTopLevelKey = "keep-me";
    writeFileSync(join(home, "settings.json"), JSON.stringify(raw, null, 2));
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.mcpAdd, { name: "my-server", entry: { type: "stdio", command: "x" } });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).aStrayTopLevelKey).toBe("keep-me");
    c.close();
  });

  test("mcp.remove drops the entry and reports removed:true; a second call reports removed:false", async () => {
    const { home, socketPath, harnessToken } = await boot({ mcpServers: { existing: { type: "stdio", command: "x" } } });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const first = await c.request(METHODS.mcpRemove, { name: "existing" });
    expect(first.result).toEqual({ ok: true, name: "existing", removed: true });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcpServers).toEqual({});
    const second = await c.request(METHODS.mcpRemove, { name: "existing" });
    expect(second.result).toEqual({ ok: true, name: "existing", removed: false });
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpAdd)).toBe(false);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpRemove)).toBe(false);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpGet)).toBe(false);
  });
});
