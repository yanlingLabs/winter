// WS-20 (cross-lane, Lane 4 / Mac app): `settings.setAdvisorModel` — the ONE door onto
// `settings.runtimes.advisorModel`, replacing the Mac app's old direct settings.json write. Bare
// IPC server harness, own SessionStore + TokenAuthority — same shape provider-console.test.ts's
// own boot() uses; no shared test-harness module exists in this codebase.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings } from "../../src/settings";

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

describe("settings.setAdvisorModel (WS-20 cross-lane)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "winter-set-advisor-model-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets });
    stop = () => { server.stop(); store.close(); };
    return { home, settingsPath, socketPath, harnessToken: tokens.harness };
  }

  test("a real tag is accepted and stored, echoed back in the result", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.settingsSetAdvisorModel, { model: "anthropic/claude-opus-5" });
    expect(result.result).toEqual({ ok: true, model: "anthropic/claude-opus-5" });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.runtimes.advisorModel).toBe("anthropic/claude-opus-5");
    c.close();
  });

  test("a bare id is refused INVALID_PARAMS at the schema door, before the handler ever runs", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.settingsSetAdvisorModel, { model: "claude-opus-5" });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32602); // INVALID_PARAMS
    c.close();
  });

  test("a tag naming an unrecognised provider is refused INVALID_PARAMS by the handler's own check", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.settingsSetAdvisorModel, { model: "nosuchprovider/foo" });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32602);
    c.close();
  });

  test("null clears the override", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.settingsSetAdvisorModel, { model: "anthropic/claude-opus-5" });
    const cleared = await c.request(METHODS.settingsSetAdvisorModel, { model: null });
    expect(cleared.result).toEqual({ ok: true, model: null });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.runtimes?.advisorModel).toBeUndefined();
    c.close();
  });

  test("not remote-allowed — local role only", async () => {
    const { REMOTE_ALLOWED_METHODS } = await import("../../src/ipc/server");
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.settingsSetAdvisorModel)).toBe(false);
  });
});
