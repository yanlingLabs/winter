import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Dispatch (Phase 7) Task 2: session.dispatch's get-or-create RPC, exercised over a bare IPC
// server (own SessionStore + TokenAuthority, no AgentEngine/etc) — same harness shape as
// server.test.ts's bootPluginTestServer, copied here (not imported: no shared test-harness
// module exists in this codebase — every *.test.ts in test/ipc and test/ carries its own copy).

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from server.test.ts's copy. */
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

describe("session.dispatch get-or-create RPC (Phase 7 dispatch mode Task 2)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-dispatch-rpc-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness };
  }

  test("first call creates the singleton with the fixed dispatch values", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dispatch-tester");

    const res = await c.request(METHODS.sessionDispatch, {});
    expect(res.error).toBeUndefined();
    expect(res.result.created).toBe(true);
    expect(res.result.sessionId).toMatch(/^s_/);

    const meta = store.meta(res.result.sessionId);
    expect(meta.mode).toBe("dispatch");
    expect(meta.origin).toBe("dispatch");
    expect(meta.approvalPolicy).toBe("auto");
    expect(meta.cwd).toBe(homedir());
    c.close();
  });

  test("second call get-or-creates: same sessionId, created: false", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dispatch-tester");

    const first = await c.request(METHODS.sessionDispatch, {});
    const second = await c.request(METHODS.sessionDispatch, {});
    expect(second.error).toBeUndefined();
    expect(second.result.sessionId).toBe(first.result.sessionId);
    expect(second.result.created).toBe(false);
    c.close();
  });

  test("session.create rejects mode: dispatch with INVALID_PARAMS mentioning session.dispatch", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dispatch-tester");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", mode: "dispatch" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("session.dispatch");
    c.close();
  });

  // orb-regressions fix round 1 (2026-07-29), review finding I1 — the SERVER-SIDE belt.
  //
  // JSON-RPC 2.0 says `params` MAY be omitted, and `RpcRequest.params` (protocol/jsonrpc.ts) is
  // `z.unknown().optional()` so the ENVELOPE accepts an absent key — but `parseParams` used to
  // `safeParse` the raw value, and every no-argument method's schema is `z.object({})`, which
  // REJECTS `undefined`. Result: `-32602 invalid params: (root)` for a perfectly legal frame.
  //
  // That is exactly what killed the orb (`NormaClient` omitted the key for `session.dispatch`), and
  // the same shape still lives in the TS CLI client and the phone's `NormaSessionClient`. Fixing it
  // in each client protects only clients that update; normalizing HERE protects every client,
  // including already-shipped ones. Verified safe by sweeping all 76 `*Params` schemas: ZERO accept
  // `undefined` today, so this cannot flip any currently-SUCCEEDING call — it only converts the
  // spurious failures into the intended behavior. The paired test below pins the other half: a
  // schema with a required field must STILL fail, so this is a normalization, not a loosening.
  test("an omitted params key is normalized to {} for a no-argument method (JSON-RPC 2.0 compliance)", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dispatch-tester");

    // `TestClient.request` drops an undefined `params` in JSON.stringify — the frame really does
    // go out as {"jsonrpc":"2.0","id":N,"method":"session.dispatch"}, byte-identical to what
    // NormaKit used to send.
    const res = await c.request(METHODS.sessionDispatch);
    expect(res.error).toBeUndefined();
    expect(typeof res.result.sessionId).toBe("string");
    expect(res.result.created).toBe(true);

    // …and it is the SAME singleton an explicit `{}` returns — normalization, not a second path.
    const explicit = await c.request(METHODS.sessionDispatch, {});
    expect(explicit.result.sessionId).toBe(res.result.sessionId);
    expect(explicit.result.created).toBe(false);
    c.close();
  });

  test("an omitted params key still fails for a schema with required fields", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dispatch-tester");

    // session.attach requires `sessionId`: `{}` cannot satisfy it, so the refusal must survive —
    // only the reported path changes (from the bare "(root)" to the field that is actually
    // missing, which is strictly more useful).
    const res = await c.request(METHODS.sessionAttach);
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("sessionId");
    c.close();
  });

  test("session.list rows carry mode/parentSessionId passthrough", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dispatch-tester");

    const dispatched = await c.request(METHODS.sessionDispatch, {});
    const dispatchId: string = dispatched.result.sessionId;
    const childId = store.createSession("global", { origin: "dispatch-child", parentSessionId: dispatchId });

    const listed = await c.request(METHODS.sessionList, {});
    expect(listed.error).toBeUndefined();
    const dRow = listed.result.sessions.find((r: any) => r.sessionId === dispatchId);
    const cRow = listed.result.sessions.find((r: any) => r.sessionId === childId);
    expect(dRow.mode).toBe("dispatch");
    expect(cRow.parentSessionId).toBe(dispatchId);
    c.close();
  });
});

// Chat Mode Slice A Task 1: chat becomes a third session.create mode value — additive alongside
// code (default) and dispatch (still rejected here, singleton minted only via session.dispatch).
// Same bare-IPC-server harness shape as the dispatch describe block above (own SessionStore +
// TokenAuthority), extended with the remote token (remote-role.test.ts's boot() pattern). Slice A
// kept chat Mac-local for remote; Slice C lifts that (see remote-chat-gate.test.ts and
// plan-immunity.test.ts for the full gate-lift + coercion coverage) — the FLIPPED test below now
// proves a remote caller CAN mint a chat session, with the daemon supplying cwd/policy.
describe("chat mode (Chat Mode Slice A Task 1)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-chat-mode-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  test("session.create mints a chat session and PERSISTS the mode", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "chat-tester");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
    expect(res.error).toBeUndefined();
    const created = store.read(res.result.sessionId, 0)[0] as any;
    expect(created.type).toBe("session_created");
    expect(created.mode).toBe("chat"); // today mode is parsed then DISCARDED — this is the gap
    c.close();
  });

  test("session.create still rejects dispatch (singleton rule intact)", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "chat-tester");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", mode: "dispatch" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("session.dispatch");
    c.close();
  });

  test("chat is NOT a singleton — two creates make two sessions", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "chat-tester");

    const a = await c.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
    const b = await c.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(a.result.sessionId).not.toBe(b.result.sessionId);
    c.close();
  });

  // FLIP (was "a REMOTE caller may not create a chat session (slice A: remote stays code-only)"):
  // Slice C lifts the remote chat-create gate. cwd defaults to $HOME (SP3.4's remote convention,
  // same as any other remote session.create) and approvalPolicy is coerced to the fixed "chat"
  // value exactly as it is for local/harness callers — see plan-immunity.test.ts's dedicated
  // remote-path coercion test for the focused proof.
  test("a REMOTE caller may now create a chat session (Slice C lifted the gate)", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
    expect(res.error).toBeUndefined();
    const meta = store.meta(res.result.sessionId);
    expect(meta.mode).toBe("chat");
    expect(meta.cwd).toBe(homedir());
    expect(meta.approvalPolicy).toBe("chat");
    c.close();
  });
});
