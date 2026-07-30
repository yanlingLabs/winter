import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, SESSION_MODEL_MAX_CHARS, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Chat Slice D task 1: per-session model override — session.setModel {sessionId, model: string|null}
// → {} (null clears), mode-agnostic (works for code/dispatch/chat, unlike session.setPolicy which
// rejects chat outright). Exercised over a bare IPC server (own SessionStore + TokenAuthority, no
// AgentEngine) — same harness shape as session-dispatch.test.ts/remote-chat-gate.test.ts (this
// codebase's convention: no shared test-harness module, every test/ipc/*.test.ts carries its own copy).

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

describe("session.setModel round-trip RPC (Chat Slice D task 1)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-set-model-rpc-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  test("set → store.meta AND session.list both reflect the new model", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});

    expect(store.meta(sessionId).model).toBe("claude-opus-5");
    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.model).toBe("claude-opus-5");
    c.close();
  });

  test("a session created WITHOUT a model has no model in meta/list (control)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global");

    expect(store.meta(sessionId).model).toBeUndefined();
    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.model).toBeUndefined();
    c.close();
  });

  test("model: null CLEARS a previously-set override", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global", { model: "claude-opus-5" });
    expect(store.meta(sessionId).model).toBe("claude-opus-5");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: null });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBeUndefined();
    c.close();
  });

  test("session.create with model stores it immediately (creation-time stamp)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");

    const created = await c.request(METHODS.sessionCreate, { scope: "global", model: "gpt-6" });
    expect(created.error).toBeUndefined();
    expect(store.meta(created.result.sessionId).model).toBe("gpt-6");
    c.close();
  });

  test("idempotent: setting the same value twice both succeed and leave the same value", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global");

    const first = await c.request(METHODS.sessionSetModel, { sessionId, model: "m1" });
    const second = await c.request(METHODS.sessionSetModel, { sessionId, model: "m1" });
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("m1");
    c.close();
  });

  test("unknown session → NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");

    const res = await c.request(METHODS.sessionSetModel, { sessionId: "s_does_not_exist", model: "m1" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // Mode-agnostic: session.setModel works for EVERY mode, unlike session.setPolicy (which rejects
  // chat outright and rejects "plan" for dispatch) — there is no equivalent restriction here.
  test("works for a CHAT session (contrast: session.setPolicy rejects every value for chat)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("claude-opus-5");
    c.close();
  });

  test("works for a DISPATCH session too", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global", { mode: "dispatch", origin: "dispatch" });

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("claude-opus-5");
    c.close();
  });

  // session.setModel is REMOTE_ALLOWED_METHODS-listed (the phone sets models on remote-driven code
  // sessions) — a remote caller can reach it for an eligible-mode session.
  test("a REMOTE caller may set the model on a code session", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = store.createSession("global", { mode: "code" });

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("claude-opus-5");
    c.close();
  });

  // The assertRemoteMayUseSession gate generalizes to this method too (server.ts's own doc
  // comment) — a Mac-local-only mode stays refused for remote. remote-chat-gate.test.ts carries
  // the full parametrized proof across every REMOTE_ALLOWED_METHODS bare-sessionId method
  // (including session.setModel, added there alongside this task); this is a focused smoke test.
  test("a REMOTE caller is refused against a cowork-shaped (Mac-local-only) session", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", sessionId]);

    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeTruthy();
    expect(res.error.message).toMatch(/not available/i);
    c.close();
  });

  test("empty-string model is rejected at the wire schema (INVALID_PARAMS)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  // T1 review M2, landed in the whole-branch fix round. `model` rides every `session.list` and
  // `sync.heads` row, both UNPAGED, and a provider that cannot enumerate its catalogue stores
  // whatever slug it is handed (deliberately — BYO endpoints). Without a schema bound, one remote
  // call could park a multi-megabyte value in the column and every later list response would then
  // exceed the phone transport's frame limit, permanently. Same class as the title cap next door.
  test("an absurdly long model is refused at the wire schema, and never reaches the column", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = store.createSession("global", { mode: "code" });

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "m".repeat(SESSION_MODEL_MAX_CHARS + 1) });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.meta(sessionId).model).toBeUndefined();

    // Control: a realistic slug (and one right AT the bound) still passes — the cap is far above
    // every real model id, so no existing caller changes behavior.
    const atCap = "m".repeat(SESSION_MODEL_MAX_CHARS);
    expect((await c.request(METHODS.sessionSetModel, { sessionId, model: atCap })).error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe(atCap);
    c.close();
  });
});
