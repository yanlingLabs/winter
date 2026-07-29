import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ERR, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Hands-Off Modes: Structural Plan-Policy Immunity (2026-07-28 design, USER-REVISED mid-
// implementation) — RPC-seam coverage for chat's fixed policy + dispatch's plan rejection:
//
//  - session.create: a chat-mode session's approvalPolicy is ALWAYS coerced to the fixed internal
//    "chat" value, regardless of what the caller sent (or omitted) — the shipped Mac app creates
//    chat sessions with approvalPolicy:"auto" (AppDelegate.swift) and must keep working unchanged.
//    Coerce, don't reject: the field is meaningless for chat.
//  - session.setPolicy: a chat session's policy can never be changed (ANY value is rejected — the
//    policy is fixed, not just "plan"-immune); a dispatch session's policy remains settable EXCEPT
//    "plan" (same incoherence as chat: exit_plan_mode is code-only, dispatch never asks either).
//  - "chat" is core-internal only: it can never even be EXPRESSED on the wire (the protocol's
//    ApprovalPolicy zod enum stays exactly six-valued) — a caller that tries gets a parse error,
//    not a policy decision.
//
// Chat Slice C extension (2026-07-29): the coercion above is proven again over the REMOTE role —
// the phone sends `mode` only (never cwd/approvalPolicy, SP3.4 hardening) and must land on the same
// fixed "chat" policy a local/harness create does. session.setPolicy, by contrast, is NOT
// REMOTE_ALLOWED_METHODS-listed — a remote caller never reaches the chat/dispatch immunity checks
// at all, refused earlier by the role→method allowlist gate. Both are asserted below rather than
// assumed.
//
// Harness duplicated from remote-chat-gate.test.ts's own TestClient/boot() shape (this codebase's
// convention: no shared test-harness module, every test/ipc/*.test.ts carries its own copy) — using
// the "harness" role throughout for the pre-existing tests, since none of that is role-specific
// (unlike Slice B1's remote gate); the two new tests below add the "remote" role explicitly.

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from remote-chat-gate.test.ts's copy. */
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

describe("plan-immunity: session.create's chat-seam coercion", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-plan-immunity-ipc-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  async function harnessClient(socketPath: string, token: string): Promise<TestClient> {
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "local-tui", "harness");
    return c;
  }

  async function remoteClient(socketPath: string, token: string): Promise<TestClient> {
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "iphone-gateway", "remote");
    return c;
  }

  // Chat Slice C: the phone sends mode ONLY — never cwd/approvalPolicy (SP3.4 hardening already
  // enforces that at the wire level) — and must land on the same fixed "chat" policy a local
  // create does. Extends the compat proof above to the remote path.
  test("remote chat create (Slice C) is ALSO coerced to the fixed 'chat' policy", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await remoteClient(socketPath, remoteToken);
    const res = await c.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).approvalPolicy).toBe("chat");
    c.close();
  });

  test("app-shaped create (mode:'chat', approvalPolicy:'auto') is coerced to the fixed 'chat' policy — the compat proof (AppDelegate.swift's own creation shape)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto", mode: "chat" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).approvalPolicy).toBe("chat");
    c.close();
  });

  test("mode:'chat' with NO approvalPolicy field sent at all is ALSO coerced to 'chat' (not the zod .default('ask') that would otherwise apply)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).approvalPolicy).toBe("chat");
    c.close();
  });

  test("mode:'chat' with approvalPolicy:'plan' explicitly requested is coerced to 'chat', NOT rejected — coerce, don't reject, for the mode-fixed policy", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "plan", mode: "chat" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).approvalPolicy).toBe("chat");
    c.close();
  });

  test("CONTROL: mode:'code' with approvalPolicy:'plan' is completely unaffected — stored verbatim as 'plan', proving the coercion is chat-only", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "plan", mode: "code" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).approvalPolicy).toBe("plan");
    c.close();
  });

  test("wire inexpressibility: approvalPolicy:'chat' sent directly over the wire is a zod parse error, not a policy decision — the protocol enum stays six-valued", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "chat", mode: "code" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });
});

describe("plan-immunity: session.setPolicy — chat's fixed policy + dispatch's plan rejection", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-plan-immunity-setpolicy-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  async function harnessClient(socketPath: string, token: string): Promise<TestClient> {
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "local-tui", "harness");
    return c;
  }

  async function remoteClient(socketPath: string, token: string): Promise<TestClient> {
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "iphone-gateway", "remote");
    return c;
  }

  // Chat Slice C requirement 4: confirm — not assume — that session.setPolicy stays off the
  // remote allowlist. If this ever regressed (someone adding it to REMOTE_ALLOWED_METHODS without
  // updating this test), the assertion below would catch it directly; the end-to-end test right
  // after proves the CONSEQUENCE — a remote setPolicy call never even reaches the chat/dispatch
  // immunity checks above, because the role→method gate refuses it first.
  test("session.setPolicy is NOT in REMOTE_ALLOWED_METHODS", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.sessionSetPolicy)).toBe(false);
  });

  test("a remote caller invoking session.setPolicy on a chat session is refused by the role allowlist (UNAUTHORIZED), never reaching the chat-immunity check", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const chat = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });
    const c = await remoteClient(socketPath, remoteToken);
    const res = await c.request(METHODS.sessionSetPolicy, { sessionId: chat, policy: "auto" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.UNAUTHORIZED);
    expect(res.error.message).toContain("remote role may not call");
    expect(store.meta(chat).approvalPolicy).toBe("chat"); // unchanged
    c.close();
  });

  test.each(["auto", "plan", "bypass", "ask"] as const)(
    "session.setPolicy(chat session, '%s') is rejected — chat's policy is fixed and can never be changed, not even to a value that ISN'T plan",
    async (policy) => {
      const { store, socketPath, harnessToken } = await boot();
      // approvalPolicy: "chat" explicitly — mirrors what session.create's own coercion would have
      // stored for a real chat session (this test drives the store directly to isolate setPolicy's
      // own behavior from create's).
      const chat = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });
      const c = await harnessClient(socketPath, harnessToken);
      const res = await c.request(METHODS.sessionSetPolicy, { sessionId: chat, policy });
      expect(res.error).toBeTruthy();
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(store.meta(chat).approvalPolicy).toBe("chat"); // unchanged — still the fixed policy
      c.close();
    },
  );

  test("session.setPolicy(dispatch session, 'plan') is rejected — same incoherence as chat: exit_plan_mode is code-only, dispatch never asks either", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const dispatch = store.createSession("global", { mode: "dispatch", approvalPolicy: "auto" });
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionSetPolicy, { sessionId: dispatch, policy: "plan" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.meta(dispatch).approvalPolicy).toBe("auto"); // unchanged
    c.close();
  });

  test("CONTROL: session.setPolicy(dispatch session, 'auto') still succeeds — only 'plan' is incoherent for dispatch, every other policy remains settable", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const dispatch = store.createSession("global", { mode: "dispatch", approvalPolicy: "ask" });
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionSetPolicy, { sessionId: dispatch, policy: "auto" });
    expect(res.error).toBeUndefined();
    expect(store.meta(dispatch).approvalPolicy).toBe("auto");
    c.close();
  });

  test("CONTROL: session.setPolicy(code session, 'plan') is completely unaffected", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const code = store.createSession("global", { mode: "code", approvalPolicy: "ask" });
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionSetPolicy, { sessionId: code, policy: "plan" });
    expect(res.error).toBeUndefined();
    expect(store.meta(code).approvalPolicy).toBe("plan");
    c.close();
  });

  // The established try/catch precedent (assertRemoteMayUseSession's own doc comment): an unknown
  // session id must fall through to the handler's OWN NOT_FOUND error, not a confusing immunity
  // message that implies the session exists and is just chat/dispatch-mode.
  test("unknown session id + policy 'plan' still produces the handler's own NOT_FOUND, not the dispatch-immunity error", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionSetPolicy, { sessionId: "s_does_not_exist", policy: "plan" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("unknown session id + policy 'auto' still produces the handler's own NOT_FOUND, not the chat-immunity error", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionSetPolicy, { sessionId: "s_does_not_exist", policy: "auto" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("wire inexpressibility: policy:'chat' sent directly over the wire is a zod parse error, not a policy decision", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const code = store.createSession("global", { mode: "code", approvalPolicy: "ask" });
    const c = await harnessClient(socketPath, harnessToken);
    const res = await c.request(METHODS.sessionSetPolicy, { sessionId: code, policy: "chat" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });
});
