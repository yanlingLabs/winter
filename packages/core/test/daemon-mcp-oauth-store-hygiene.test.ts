// WS-25 integration (test-Keychain hygiene): a daemon handed its own `secrets` store -- every test daemon, and
// the Swift suites' `RealDaemon` fixture (`apple/WinterKit/Tests/WinterKitTests/support/RealDaemon.swift`, which
// boots `startDaemon({ home, secrets: new FileSecretStore(...) })`) -- keeps its MCP sign-ins in a per-daemon
// MEMORY store. The sign-in doors, the `mcp.list` probe and the session credential answers share it, and the
// Keychain store is never even constructed: not the throwaway service, and never the real `com.winter.core` a
// fixture that forgot `WINTER_KEYCHAIN_SERVICE` would otherwise land on.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import * as mcpAuth from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import * as daemonStore from "../src/runtime-sdk/mcp-oauth-store";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";
import { FakeProvider } from "../src/agent/fake-provider";
import { startFixtureAs, type FixtureAs } from "./fixtures/mcp-oauth-fixture-as";

/** Minimal raw NDJSON JSON-RPC client (each test file carries its own copy, as the rest of this directory does). */
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
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params: params ?? {} }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  hello(token: string): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName: "mcp-store-hygiene" });
  }

  close(): void { this.socket.end(); }
}

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await check())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

describe("a daemon with injected secrets never builds a Keychain MCP OAuth store (WS-25 integration)", () => {
  let daemon: RunningDaemon | undefined;
  let fx: FixtureAs | undefined;
  let client: TestClient | undefined;
  afterEach(async () => {
    client?.close();
    await daemon?.stop();
    fx?.close();
    daemon = undefined; fx = undefined; client = undefined;
  });

  test("probe, sign-in, status and sign-out all run on the per-daemon memory store", async () => {
    const daemonKeychain = spyOn(daemonStore, "daemonMcpOAuthStore");
    const sdkKeychain = spyOn(mcpAuth, "createKeychainMcpOAuthStore");
    try {
      fx = startFixtureAs();
      const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-store-hygiene-")));
      mkdirSync(join(home, "sdk"), { recursive: true });
      writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({ mcpServers: { linear: { type: "http", url: fx.mcpUrl } } }));
      // A provider (a fake: nothing here runs a turn) because the `mcp.list` status probe is built only beside one.
      daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets")), agentProvider: { provider: new FakeProvider([]), model: "fake-1" } });
      client = await TestClient.connect(daemon.socketPath);
      await client.hello(daemon.tokens.harness);

      const before = await client.request(METHODS.mcpList, {});
      expect(before.result.servers).toEqual([expect.objectContaining({ name: "linear", status: "needs-auth", auth: "needs-auth" })]);

      const start = await client.request(METHODS.mcpLogin, { name: "linear" });
      expect(start.error).toBeUndefined();
      await fx.approve(start.result.authUrl);
      await until(async () => (await client!.request(METHODS.mcpLoginStatus, { loginId: start.result.loginId })).result.state === "done");

      // The doors wrote the sign-in and the probe read it back: ONE store, shared.
      await until(async () => {
        const listed = await client!.request(METHODS.mcpList, {});
        return listed.result.servers[0]?.auth === "signed-in" && listed.result.servers[0]?.status === "connected";
      });

      expect((await client.request(METHODS.mcpLogout, { name: "linear" })).result).toEqual({ ok: true });

      expect(daemonKeychain).not.toHaveBeenCalled();
      expect(sdkKeychain).not.toHaveBeenCalled();
    } finally {
      daemonKeychain.mockRestore();
      sdkKeychain.mockRestore();
    }
  });
});
