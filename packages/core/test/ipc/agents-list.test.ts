// Daemon settings surface (2026-09-17 plan, item 3): `agents.list` — the daemon's own parse of
// `<home>/agents/*.md`, its rejections, and the cached built-in list. Bare IPC server harness, same
// shape `capabilities-list.test.ts`/`settings-set-advisor-model.test.ts` already use.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { SupportedAgentsCache } from "../../src/agent/supported-agents-cache";

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

describe("agents.list", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(opts: { withAgentsDir?: boolean; supportedAgents?: SupportedAgentsCache } = {}) {
    const home = mkdtempSync(join(tmpdir(), "winter-agents-list-"));
    if (opts.withAgentsDir) mkdirSync(join(home, "agents"), { recursive: true });
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets,
      ...(opts.supportedAgents === undefined ? {} : { supportedAgents: opts.supportedAgents }),
    });
    stop = () => { server.stop(); store.close(); };
    return { home, socketPath, harnessToken: tokens.harness };
  }

  test("no agents/ directory at all -> empty definitions/rejected, builtins: null", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.agentsList, {});
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ ok: true, definitions: [], rejected: [], builtins: null });
    c.close();
  });

  test("valid + rejected files are reported separately, each rejection with its own reason and path", async () => {
    const { home, socketPath, harnessToken } = await boot({ withAgentsDir: true });
    writeFileSync(join(home, "agents", "reviewer.md"), ["---", "name: code-reviewer", "description: Reviews code", "model: sonnet", "---", "", "You review code."].join("\n"));
    writeFileSync(join(home, "agents", "no-name.md"), ["---", "description: no name here", "---", "", "Body."].join("\n"));
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.agentsList, {});
    expect(result.result.definitions).toEqual([
      { name: "code-reviewer", description: "Reviews code", model: "sonnet", path: join(home, "agents", "reviewer.md") },
    ]);
    expect(result.result.rejected).toHaveLength(1);
    expect(result.result.rejected[0].path).toBe(join(home, "agents", "no-name.md"));
    expect(result.result.rejected[0].reason).toContain('"name"');
    c.close();
  });

  test("builtins reports the cached last-observed answer when one exists", async () => {
    const cache = new SupportedAgentsCache();
    cache.observe("s_123", [{ name: "Explore", description: "read-only search" }]);
    const { socketPath, harnessToken } = await boot({ supportedAgents: cache });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.agentsList, {});
    expect(result.result.builtins.sessionId).toBe("s_123");
    expect(result.result.builtins.agents).toEqual([{ name: "Explore", description: "read-only search" }]);
    expect(typeof result.result.builtins.observedAt).toBe("number");
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.agentsList)).toBe(false);
  });
});
