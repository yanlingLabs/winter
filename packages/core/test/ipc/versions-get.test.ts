// Daemon settings surface (2026-09-17 plan, item 3): `versions.get` — compile-time pins vs what is
// actually installed/staged, reusing `diagnoseRuntimes` (the SAME resolver `winter doctor` calls)
// rather than a second probe. Bare IPC server harness, same shape `settings-set-advisor-model.test.ts`
// already uses.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings } from "../../src/settings";
import { REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";
import { VersionsGetResult } from "@yanlinglabs/winter-protocol";

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

describe("versions.get", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "winter-versions-get-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test-core-version", tokens: authority, store, winterHome: home, secrets });
    stop = () => { server.stop(); store.close(); };
    return { home, socketPath, harnessToken: tokens.harness };
  }

  test("full shape: core, pins (the REQUIRED_* constants verbatim), installed, bundle", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.versionsGet, {});
    expect(result.error).toBeUndefined();
    const r = result.result;
    expect(r.ok).toBe(true);
    expect(r.core).toBe("test-core-version");
    // WS-23: the Winter pins only — the retired official leg's `claudeAgentSdk` pin is gone.
    expect(r.pins).toEqual({
      winterAgentSdk: REQUIRED_WINTER_AGENT_SDK,
      winterRuntimeSdk: REQUIRED_WINTER_RUNTIME_SDK,
    });
    // The wrapper's own SDK_VERSION is always reported (no optional-peer story on this leg).
    expect(typeof r.installed.winterAgentSdk).toBe("string");
    expect(r.installed.winterAgentSdk.length).toBeGreaterThan(0);
    // Every OTHER installed field is independently optional — present or absent, never a throw.
    for (const key of ["winterRuntimeSdk", "winterExecutable"]) {
      expect(["string", "object", "undefined"]).toContain(typeof r.installed[key]);
    }
    expect("claudeAgentSdk" in r.installed).toBe(false);
    expect("claudeExecutable" in r.installed).toBe(false);
    // `bundle` is either the staged records or null — never an error either way, and in this
    // dev/test checkout nothing is staged, so it must be null. The retired `official` key is gone.
    expect(r.bundle).toBeNull();
    expect("official" in r).toBe(false);
    // The reply satisfies the wire schema the app decodes against.
    expect(VersionsGetResult.safeParse(r).success).toBe(true);
    c.close();
  });

  test("a missing winter executable resolution never throws — reported as an absent field, not an error", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.versionsGet, {});
    // This dev/test checkout has no bundle-relative runtimes; the call must still succeed —
    // `diagnoseRuntimes` never throws by construction (its own header comment), and a resolution
    // miss is reported by simply omitting `installed.winterExecutable`, never a thrown RPC error.
    expect(result.error).toBeUndefined();
    expect(result.result.ok).toBe(true);
    c.close();
  });

  test("no winterHome configured still answers (home falls back, never throws)", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-versions-get-nohome-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, secrets });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "cli");
    const result = await c.request(METHODS.versionsGet, {});
    expect(result.error).toBeUndefined();
    expect(result.result.ok).toBe(true);
    expect(result.result.bundle).toBeNull();
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.versionsGet)).toBe(false);
  });
});
