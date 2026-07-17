import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Remote Gateway SP1 Task 2: daemon-side command idempotency for the `remote` role — a flaky
// mobile link means a phone may resend a request whose ack was lost, so remote mutating RPCs may
// carry a client-generated top-level `commandId` (a sibling of id/method/params, NOT inside
// params); a repeat on the SAME connection returns the CACHED result and does NOT re-dispatch.
// Harness/local callers (no commandId, or role !== "remote") are completely unaffected. Same bare
// -server harness shape as remote-role.test.ts (Task 1) — no shared test-harness module exists in
// this codebase.

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from remote-role.test.ts's copy,
 *  extended with `requestWithCommandId` since the standard client (and every RpcRequest-shaped
 *  helper in this codebase) has no way to attach a top-level `commandId`; only a flaky-link retry
 *  (the phone gateway, not yet built) would ever need to construct one. */
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
    return this.requestWithCommandId(method, params, undefined);
  }

  /** Sends a raw request line, optionally carrying a top-level `commandId` — builds the JSON
   *  object by hand rather than going through any typed request helper. */
  requestWithCommandId(method: string, params: unknown, commandId: string | undefined): Promise<any> {
    const id = this.nextId++;
    const req: Record<string, unknown> = { jsonrpc: "2.0", id, method, params };
    if (commandId !== undefined) req.commandId = commandId;
    this.writer.enqueue(encodeLine(req));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("remote command idempotency — per-connection commandId dedup (Remote Gateway SP1 Task 2)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-remote-idempotency-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  /** Creates a dispatch-mode session and attaches `c` to it — required before `session.send` is
   *  valid (`hub.send` throws unless the client is attached). */
  async function attachToNewSession(c: TestClient): Promise<string> {
    const dispatched = await c.request(METHODS.sessionDispatch, {});
    const sessionId: string = dispatched.result.sessionId;
    const attached = await c.request(METHODS.sessionAttach, { sessionId });
    expect(attached.error).toBeUndefined();
    return sessionId;
  }

  function userMessageCount(store: SessionStore, sessionId: string, text: string): number {
    return store.read(sessionId, 0).filter((e: any) => e.type === "user_message" && e.text === text).length;
  }

  test("case 1: same commandId sent twice on a remote connection dedups — one user_message, byte-equal responses", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = await attachToNewSession(c);

    const first = await c.requestWithCommandId(METHODS.sessionSend, { sessionId, text: "hi" }, "c1");
    const second = await c.requestWithCommandId(METHODS.sessionSend, { sessionId, text: "hi" }, "c1");

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.result).toEqual(first.result); // cached: same {seq}, no re-dispatch
    expect(userMessageCount(store, sessionId, "hi")).toBe(1);
    c.close();
  });

  test("case 2: different commandIds both dispatch — two user_messages", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = await attachToNewSession(c);

    const first = await c.requestWithCommandId(METHODS.sessionSend, { sessionId, text: "hi" }, "c1");
    const second = await c.requestWithCommandId(METHODS.sessionSend, { sessionId, text: "hi" }, "c2");

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.result.seq).not.toBe(first.result.seq);
    expect(userMessageCount(store, sessionId, "hi")).toBe(2);
    c.close();
  });

  test("case 3: the 257th distinct commandId evicts the oldest (cap 256) — a resent k0 re-dispatches", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = await attachToNewSession(c);

    for (let i = 0; i <= 256; i++) {
      const res = await c.requestWithCommandId(METHODS.sessionSend, { sessionId, text: `m${i}` }, `k${i}`);
      expect(res.error).toBeUndefined();
    }
    // 257 distinct commandIds inserted into a cap-256 cache: k0 (the oldest) has already been
    // evicted by the time k256 was inserted — but the log itself only has one "m0" so far.
    expect(userMessageCount(store, sessionId, "m0")).toBe(1);

    const resent = await c.requestWithCommandId(METHODS.sessionSend, { sessionId, text: "m0" }, "k0");
    expect(resent.error).toBeUndefined();
    expect(userMessageCount(store, sessionId, "m0")).toBe(2); // k0 was evicted → re-dispatched
    c.close();
  });

  test("case 4: a harness connection sending the same commandId twice is NOT deduped (remote-only)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "harness-client");
    const sessionId = await attachToNewSession(c);

    const first = await c.requestWithCommandId(METHODS.sessionSend, { sessionId, text: "hi" }, "c1");
    const second = await c.requestWithCommandId(METHODS.sessionSend, { sessionId, text: "hi" }, "c1");

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.result.seq).not.toBe(first.result.seq);
    expect(userMessageCount(store, sessionId, "hi")).toBe(2);
    c.close();
  });

  test("case 5: session.send with no commandId on a remote connection is unaffected — normal double-dispatch", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = await attachToNewSession(c);

    const first = await c.request(METHODS.sessionSend, { sessionId, text: "hi" });
    const second = await c.request(METHODS.sessionSend, { sessionId, text: "hi" });

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.result.seq).not.toBe(first.result.seq);
    expect(userMessageCount(store, sessionId, "hi")).toBe(2);
    c.close();
  });
});
