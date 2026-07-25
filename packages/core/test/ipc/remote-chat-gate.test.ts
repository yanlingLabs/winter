import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Chat mode Slice B1 Task 1: a remote-role (iPhone) client must not be able to enumerate, attach
// to, read the history of, send to, or interrupt a mode:"chat" session — daemon-side, not a phone-
// side filter, so it protects every phone (including one that never updates). Lands BEFORE Slice
// B1 Task 2's wire change (QuestionSchema.header going optional) so the protection exists before
// the hazard. Harness shape duplicated from remote-role.test.ts — this codebase's convention is no
// shared test-harness module; every test/ipc/*.test.ts carries its own copy.

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from remote-role.test.ts's copy. */
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

  async hello(token: string, clientName: string, role: string): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("remote role cannot reach chat sessions (Slice B1 Task 1 precondition)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-remote-chat-gate-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  async function remoteClient(socketPath: string, token: string): Promise<TestClient> {
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "iphone-gateway", "remote");
    return c;
  }

  async function harnessClient(socketPath: string, token: string): Promise<TestClient> {
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "local-tui", "harness");
    return c;
  }

  test("session.list omits chat sessions for remote, keeps them for local", async () => {
    const { store, socketPath, harnessToken, remoteToken } = await boot();
    const chat = store.createSession("global", { mode: "chat" });
    const code = store.createSession("global", { mode: "code" });

    const remote = await remoteClient(socketPath, remoteToken);
    const remoteList = await remote.request(METHODS.sessionList, {});
    expect(remoteList.error).toBeUndefined();
    const remoteIds = remoteList.result.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(remoteIds).not.toContain(chat);
    expect(remoteIds).toContain(code); // gate is narrow, not a blanket denial

    const harness = await harnessClient(socketPath, harnessToken);
    const localList = await harness.request(METHODS.sessionList, {});
    expect(localList.result.sessions.map((s: { sessionId: string }) => s.sessionId)).toContain(chat);

    remote.close(); harness.close();
  });

  // The brief's four verbs (attach/send/history/interrupt) plus every OTHER REMOTE_ALLOWED_METHODS
  // entry that also takes a bare `sessionId` and could target a chat session: approval.respond,
  // approval.list, ask_user.respond. (approval.list has no extra required params; the others need
  // enough to pass their own zod schema so the request reaches the gate, not a parse error.)
  test.each([
    [METHODS.sessionAttach, {}],
    [METHODS.sessionSend, { text: "hi" }],
    [METHODS.sessionHistory, {}],
    [METHODS.sessionInterrupt, {}],
    [METHODS.approvalRespond, { callId: "c_x", approved: true }],
    [METHODS.approvalList, {}],
    [METHODS.askUserRespond, { callId: "c_x", answers: {} }],
  ])("%s on a chat session is refused for remote", async (method, extra) => {
    const { store, socketPath, remoteToken } = await boot();
    const chat = store.createSession("global", { mode: "chat" });

    const remote = await remoteClient(socketPath, remoteToken);
    const res = await remote.request(method, { sessionId: chat, ...extra });
    expect(res.error).toBeDefined();
    expect(res.error.message).toMatch(/not available/i);
    remote.close();
  });

  test("the same verbs still work for remote on a code session", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const code = store.createSession("global", { mode: "code" });

    const remote = await remoteClient(socketPath, remoteToken);
    const attached = await remote.request(METHODS.sessionAttach, { sessionId: code });
    expect(attached.error).toBeUndefined();
    remote.close();
  });

  // The gate's try/catch around store.meta() is deliberate: an unknown session id must fall through
  // to the handler's OWN error (e.g. session.attach's NOT_FOUND from hub.attach), not a confusing
  // "chat sessions are not available" message that implies the session exists and is just chat-mode.
  test("an unknown session id still produces the handler's own error, not the chat gate's", async () => {
    const { socketPath, remoteToken } = await boot();
    const remote = await remoteClient(socketPath, remoteToken);
    const res = await remote.request(METHODS.sessionAttach, { sessionId: "s_does_not_exist" });
    expect(res.error).toBeDefined();
    expect(res.error.message).not.toMatch(/not available/i);
    remote.close();
  });
});
