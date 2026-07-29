import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Chat mode Slice B1 Task 1 introduced this gate so a remote-role (iPhone) client could not
// enumerate, attach to, read the history of, send to, or interrupt a mode:"chat" session —
// daemon-side, not a phone-side filter, so it protected every phone (including one that never
// updated). Slice C now ships the phone's own chat surface, so this file FLIPS: chat is remote-
// eligible again, and the mechanism (assertRemoteMayUseSession + the session.list filter) is
// proven to still generalize via a synthetic cowork-shaped session (mode written straight to the
// store — cowork has no protocol/session.create support to register anywhere). Harness shape
// duplicated from remote-role.test.ts — this codebase's convention is no shared test-harness
// module; every test/ipc/*.test.ts carries its own copy.

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

describe("remote chat gate: chat lifted (Slice C), the mechanism survives for cowork", () => {
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

  // A synthetic cowork-shaped session for the mechanism proof (T1 requirement 2). "cowork" has NO
  // protocol/session.create support — SessionCreatedEvent's mode enum (protocol/src/events.ts)
  // stays three-valued (code/dispatch/chat) — so store.createSession's own event-append path would
  // reject it via SessionEvent.parse's zod validation (a real ZodError, not just a TS type error).
  // Writing the store's `mode` column directly, bypassing the event log entirely, is exactly the
  // "no registration needed" the mechanism proof calls for: nothing about "cowork" needs to be
  // taught to the protocol for assertRemoteMayUseSession/session.list to refuse it anyway.
  function makeCoworkSession(store: SessionStore): string {
    const id = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", id]);
    return id;
  }

  // FLIP 1 (was "session.list omits chat sessions for remote, keeps them for local"): Slice C
  // lifts chat into remote's view. The narrow-not-blanket proof now uses a cowork-shaped session
  // (mode written straight to the store — no session.create/protocol support for "cowork" exists,
  // by design; see REMOTE_ELIGIBLE_SESSION_MODES's doc comment in server.ts) in place of the old
  // code-vs-chat contrast, since chat is no longer the mode being excluded.
  test("session.list now includes chat sessions for remote (Slice C), still excludes a cowork-shaped session", async () => {
    const { store, socketPath, harnessToken, remoteToken } = await boot();
    const chat = store.createSession("global", { mode: "chat" });
    const code = store.createSession("global", { mode: "code" });
    const cowork = makeCoworkSession(store);

    const remote = await remoteClient(socketPath, remoteToken);
    const remoteList = await remote.request(METHODS.sessionList, {});
    expect(remoteList.error).toBeUndefined();
    const remoteIds = remoteList.result.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(remoteIds).toContain(chat); // FLIP: chat is now visible to remote
    expect(remoteIds).toContain(code);
    expect(remoteIds).not.toContain(cowork); // gate is narrow, not deleted — cowork stays hidden

    const harness = await harnessClient(socketPath, harnessToken);
    const localList = await harness.request(METHODS.sessionList, {});
    const localIds = localList.result.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(localIds).toContain(chat);
    expect(localIds).toContain(cowork); // local/harness sees every mode regardless of the remote gate

    remote.close(); harness.close();
  });

  // FLIP 2 (was "%s on a chat session is refused for remote"): the same seven methods (the brief's
  // four verbs — attach/send/history/interrupt — plus approval.respond/approval.list/ask_user.respond,
  // every OTHER REMOTE_ALLOWED_METHODS entry taking a bare `sessionId`) now SUCCEED against a chat
  // session for remote. sessionSend always requires a prior attach regardless of role/mode (ordinary
  // session semantics, unrelated to the remote-chat gate) — attaching first is harmless for the other
  // six methods too, so it's done uniformly.
  test.each([
    [METHODS.sessionAttach, {}],
    [METHODS.sessionSend, { text: "hi" }],
    [METHODS.sessionHistory, {}],
    [METHODS.sessionInterrupt, {}],
    [METHODS.approvalRespond, { callId: "c_x", approved: true }],
    [METHODS.approvalList, {}],
    [METHODS.askUserRespond, { callId: "c_x", answers: {} }],
  ])("%s on a chat session now succeeds for remote (Slice C lifted the gate)", async (method, extra) => {
    const { store, socketPath, remoteToken } = await boot();
    const chat = store.createSession("global", { mode: "chat" });

    const remote = await remoteClient(socketPath, remoteToken);
    const attach = await remote.request(METHODS.sessionAttach, { sessionId: chat });
    expect(attach.error).toBeUndefined();
    const res = await remote.request(method, { sessionId: chat, ...extra });
    expect(res.error).toBeUndefined();
    remote.close();
  });

  // The mechanism proof (T1 requirement 2): assertRemoteMayUseSession is GENERALIZED, not deleted.
  // A cowork-shaped session — mode written directly to the store; there is no session.create or
  // wire support for "cowork" to register anywhere, deliberately — is still refused for remote on
  // every one of the same seven methods, exactly like chat used to be before this slice.
  test.each([
    [METHODS.sessionAttach, {}],
    [METHODS.sessionSend, { text: "hi" }],
    [METHODS.sessionHistory, {}],
    [METHODS.sessionInterrupt, {}],
    [METHODS.approvalRespond, { callId: "c_x", approved: true }],
    [METHODS.approvalList, {}],
    [METHODS.askUserRespond, { callId: "c_x", answers: {} }],
  ])("%s on a cowork-shaped session is refused for remote (the gate generalizes, not deleted)", async (method, extra) => {
    const { store, socketPath, remoteToken } = await boot();
    const cowork = makeCoworkSession(store);

    const remote = await remoteClient(socketPath, remoteToken);
    const res = await remote.request(method, { sessionId: cowork, ...extra });
    expect(res.error).toBeDefined();
    expect(res.error.message).toMatch(/not available/i);
    remote.close();
  });

  test("the same verbs still work for remote on a code session (unchanged control)", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const code = store.createSession("global", { mode: "code" });

    const remote = await remoteClient(socketPath, remoteToken);
    const attached = await remote.request(METHODS.sessionAttach, { sessionId: code });
    expect(attached.error).toBeUndefined();
    remote.close();
  });

  // The gate's try/catch around store.meta() is deliberate: an unknown session id must fall through
  // to the handler's OWN error (e.g. session.attach's NOT_FOUND from hub.attach), not a confusing
  // "sessions are not available" message that implies the session exists and is just an ineligible
  // mode.
  test("an unknown session id still produces the handler's own error, not the gate's", async () => {
    const { socketPath, remoteToken } = await boot();
    const remote = await remoteClient(socketPath, remoteToken);
    const res = await remote.request(METHODS.sessionAttach, { sessionId: "s_does_not_exist" });
    expect(res.error).toBeDefined();
    expect(res.error.message).not.toMatch(/not available/i);
    remote.close();
  });
});
