import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Remote Gateway SP1 Task 1: the least-privileged `remote` hello role (the future iPhone gateway
// connects as this role, never harness/admin) + REMOTE_ALLOWED_METHODS, the role→method allowlist
// gate for it — same table-driven precedent as Phase 4b Task 2's PLUGIN_ALLOWED_METHODS gate.
// Exercised over a bare IPC server (own SessionStore + TokenAuthority, no AgentEngine/etc), same
// harness shape as session-dispatch.test.ts's boot() (not imported: no shared test-harness module
// exists in this codebase — every *.test.ts in test/ipc carries its own copy).

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from session-dispatch.test.ts's copy. */
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
        drain(_s) {
          c.writer.onDrain();
        },
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

describe("remote hello role + REMOTE_ALLOWED_METHODS gate (Remote Gateway SP1 Task 1)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-remote-role-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  test("hello role:remote with the remote token succeeds", async () => {
    const { socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    const res = await c.hello(remoteToken, "iphone-gateway", "remote");
    expect(res.error).toBeUndefined();
    expect(res.result.ok).toBe(true);
    c.close();
  });

  test("the nine allowed verbs pass the role gate — never role-rejected (each reaches its real handler, not the allowlist)", async () => {
    const { socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");

    const dispatched = await c.request(METHODS.sessionDispatch, {});
    expect(dispatched.error).toBeUndefined();
    const sessionId: string = dispatched.result.sessionId;

    const attached = await c.request(METHODS.sessionAttach, { sessionId });
    expect(attached.error).toBeUndefined();

    const sent = await c.request(METHODS.sessionSend, { sessionId, text: "hi" });
    expect(sent.error).toBeUndefined();

    const list = await c.request(METHODS.sessionList, {});
    expect(list.error).toBeUndefined();

    const activity = await c.request(METHODS.engineActivity, {});
    expect(activity.error).toBeUndefined();

    // No broker/questions/engine wired on this bare server — these three degrade to a default
    // success object rather than throwing, which still proves dispatch reached the handler (not
    // the allowlist gate, which would throw UNAUTHORIZED with the role-reject message).
    for (const [method, params] of [
      [METHODS.approvalRespond, { sessionId, callId: "c_x", approved: true }],
      [METHODS.askUserRespond, { sessionId, callId: "c_x", answers: {} }],
      [METHODS.sessionInterrupt, { sessionId }],
    ] as const) {
      const res = await c.request(method, params);
      expect(res.error).toBeUndefined();
    }
    c.close();
  });

  test("off-list verbs are role-rejected before dispatch with the remote-specific message", async () => {
    const { socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");

    for (const method of [
      METHODS.trustDir, METHODS.sessionSetCwd, METHODS.pluginRegister,
      METHODS.memoryList, METHODS.providerConfigure,
    ]) {
      const res = await c.request(method, {});
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      expect(res.error?.message).toBe(`remote role may not call ${method}`);
    }
    c.close();
  });

  test("hello role:remote with a wrong token is unauthorized", async () => {
    const { socketPath } = await boot();
    const c = await TestClient.connect(socketPath);
    const res = await c.hello("not-the-real-token", "iphone-gateway", "remote");
    expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
    c.close();
  });

  test("regression: a harness hello is unaffected — can still call an off-remote-list method", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "harness-client");

    const res = await c.request(METHODS.trustDir, { path: "/tmp" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, trusted: true });
    c.close();
  });
});
