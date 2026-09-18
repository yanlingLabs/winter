// Daemon settings surface batch 3 (item 3a): `mcp.enable`/`mcp.disable` (the write door) and
// `mcp.list`'s settings overlay — a disabled server withheld/reported, and a configured HTTP/SSE
// server (never started by the daemon's own McpManager — no in-daemon client for those transports)
// reported as "unmanaged" rather than silently absent. Bare IPC server harness, same shape
// `settings-set-skill-denied.test.ts`/`agents-list.test.ts` already use — no real MCP child process
// needed here (that flip, against a REAL stdio server the manager started at boot, is covered in
// server.test.ts's own mcp.list tests, which already spawn a fixture process).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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

describe("mcp.enable / mcp.disable / mcp.list settings overlay", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(settingsOverride?: Record<string, unknown>) {
    const home = mkdtempSync(join(tmpdir(), "winter-mcp-enable-"));
    const base = { schemaVersion: 3 as const, provider: { model: "codex-oauth/gpt-5.6-sol" } };
    saveSettings(join(home, "settings.json"), Settings.parse({ ...base, ...settingsOverride }));
    const trust = new TrustStore(join(home, "trust.json"));
    // A bare McpManager with NOTHING started — this file never spawns a real child process (see
    // header); `mcp.list`'s stdio/"connected" path is exercised elsewhere.
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

  test("mcp.disable writes the name into settings.mcp.disabled; mcp.enable removes it", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const off = await c.request(METHODS.mcpDisable, { name: "fake" });
    expect(off.result).toEqual({ ok: true, name: "fake", enabled: false });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.disabled).toEqual(["fake"]);
    const on = await c.request(METHODS.mcpEnable, { name: "fake" });
    expect(on.result).toEqual({ ok: true, name: "fake", enabled: true });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.disabled).toEqual([]);
    c.close();
  });

  test("disabling twice is a no-op (deduped), enabling an absent name is a no-op", async () => {
    const { home, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.mcpDisable, { name: "fake" });
    await c.request(METHODS.mcpDisable, { name: "fake" });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.disabled).toEqual(["fake"]);
    await c.request(METHODS.mcpEnable, { name: "never-disabled" });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcp.disabled).toEqual(["fake"]);
    c.close();
  });

  test("a configured HTTP server the manager never started is reported unmanaged, with its transport", async () => {
    const { socketPath, harnessToken } = await boot({
      mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } },
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const { result } = await c.request(METHODS.mcpList, {});
    expect(result.servers).toEqual([{ name: "remote", status: "unmanaged", toolNames: [], source: "user", transport: "http" }]);
    c.close();
  });

  test("a configured SSE server that is ALSO disabled is reported disabled, not unmanaged", async () => {
    const { socketPath, harnessToken } = await boot({
      mcpServers: { remote: { type: "sse", url: "https://example.com/mcp" } },
      mcp: { disabled: ["remote"] },
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const { result } = await c.request(METHODS.mcpList, {});
    expect(result.servers).toEqual([{ name: "remote", status: "disabled", toolNames: [], source: "user", transport: "sse" }]);
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpEnable)).toBe(false);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.mcpDisable)).toBe(false);
  });
});
