import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { saveSettings, Settings } from "../../src/settings";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// ComputerV2 Phase 1b (the phone mirror): `session.mirror` is the daemon's GATE for the phone watching the
// live mirror of the session it is attached to. The frames never come through the daemon (Winter.app's
// Gateway relays what its own mirror already receives), so all this method decides is: may this caller watch
// this session (the remote mode gate + the attachment), and is the mirror on at all (the user's settings).
// Harness shape duplicated from remote-chat-gate.test.ts — this codebase keeps no shared ipc test harness.

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

  async hello(token: string, clientName: string, role: string): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("session.mirror — the phone mirror's gate (ComputerV2 Phase 1b)", () => {
  let stop: (() => void) | undefined;
  let home: string | undefined;

  afterEach(() => {
    stop?.(); stop = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  async function boot(settings: Record<string, unknown> = {}): Promise<{ store: SessionStore; socketPath: string; remoteToken: string; harnessToken: string }> {
    home = mkdtempSync(join(tmpdir(), "winter-session-mirror-"));
    // A real daemon always has its settings file (boot writes it); the gate fails closed without one.
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, ...settings }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, remoteToken: tokens.remote, harnessToken: tokens.harness };
  }

  async function remote(socketPath: string, token: string): Promise<TestClient> {
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "iphone-gateway", "remote");
    return c;
  }

  test("is on the remote allowlist", () => {
    expect(METHODS.sessionMirror).toBe("session.mirror");
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.sessionMirror)).toBe(true);
  });

  test("a phone attached to the session may watch it; the mirror is on by default", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const code = store.createSession("global", { mode: "code" });
    const c = await remote(socketPath, remoteToken);
    expect((await c.request(METHODS.sessionAttach, { sessionId: code })).error).toBeUndefined();
    const res = await c.request(METHODS.sessionMirror, { sessionId: code, watch: true });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, mirror: true });
    c.close();
  });

  test("watching needs the attachment: a session the caller is not attached to is refused", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const a = store.createSession("global", { mode: "code" });
    const b = store.createSession("global", { mode: "code" });
    const c = await remote(socketPath, remoteToken);
    const before = await c.request(METHODS.sessionMirror, { sessionId: a, watch: true });
    expect(before.error?.code).toBe(ERR.NOT_FOUND);
    expect(before.error?.message).toContain("attach to the session first");

    expect((await c.request(METHODS.sessionAttach, { sessionId: a })).error).toBeUndefined();
    const other = await c.request(METHODS.sessionMirror, { sessionId: b, watch: true });
    expect(other.error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("an unknown session is NOT_FOUND", async () => {
    const { socketPath, remoteToken } = await boot();
    const c = await remote(socketPath, remoteToken);
    const res = await c.request(METHODS.sessionMirror, { sessionId: "s_nope", watch: true });
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("a Mac-local mode (a cowork-shaped session) is refused for remote, like every bare-sessionId remote verb", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const id = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", id]);
    const c = await remote(socketPath, remoteToken);
    const res = await c.request(METHODS.sessionMirror, { sessionId: id, watch: true });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error?.message).toContain("not available to remote clients");
    c.close();
  });

  test("stopping is never refused — not attached, unknown session, any mode", async () => {
    const { socketPath, remoteToken } = await boot();
    const c = await remote(socketPath, remoteToken);
    const res = await c.request(METHODS.sessionMirror, { sessionId: "s_nope", watch: false });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, mirror: false });
    c.close();
  });

  test.each([
    [{ computerUse: { mirror: false } }],
    [{ computerUse: { enabled: false } }],
  ])("the user's setting turns it off (%j): answered mirror:false", async (settings) => {
    const { store, socketPath, remoteToken } = await boot(settings);
    const code = store.createSession("global", { mode: "code" });
    const c = await remote(socketPath, remoteToken);
    expect((await c.request(METHODS.sessionAttach, { sessionId: code })).error).toBeUndefined();
    const res = await c.request(METHODS.sessionMirror, { sessionId: code, watch: true });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, mirror: false });
    c.close();
  });

  test("a dispatch session may be watched once attached", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const id = store.createSession("global", { mode: "dispatch" });
    const c = await remote(socketPath, remoteToken);
    expect((await c.request(METHODS.sessionAttach, { sessionId: id })).error).toBeUndefined();
    const res = await c.request(METHODS.sessionMirror, { sessionId: id, watch: true });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, mirror: true });
    c.close();
  });

  test("a chat session has no computer use: answered mirror:false, so nothing is opened for it", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const id = store.createSession("global", { mode: "chat" });
    const c = await remote(socketPath, remoteToken);
    expect((await c.request(METHODS.sessionAttach, { sessionId: id })).error).toBeUndefined();
    const res = await c.request(METHODS.sessionMirror, { sessionId: id, watch: true });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, mirror: false });
    c.close();
  });

  test("settings that cannot be read fail CLOSED: mirror:false (a missing file too)", async () => {
    const { store, socketPath, remoteToken } = await boot();
    // A settings.json that is not JSON at all: the reader cannot tell what the user chose.
    writeFileSync(join(home!, "settings.json"), "{ this is not json");
    const code = store.createSession("global", { mode: "code" });
    const c = await remote(socketPath, remoteToken);
    expect((await c.request(METHODS.sessionAttach, { sessionId: code })).error).toBeUndefined();
    const res = await c.request(METHODS.sessionMirror, { sessionId: code, watch: true });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, mirror: false });
    c.close();
  });
});
