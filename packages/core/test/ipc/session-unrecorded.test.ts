// Fix wave F2 (whole-branch review): a session with NO runtime record — a phone-owned session that
// `sync.push` materialised through `store.createSynced`, which 8a's backfill never records — gets a
// TYPED refusal on `session.send`/`session.steer` (`code: "session_unrecorded"`), never silence.
// Before F2 the send fell through to `hub.send`: the text landed in the log and no turn ran.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";

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
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
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
  async hello(token: string, clientName: string): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }
  close(): void { this.socket.end(); }
}

/** A driver table that knows NO record for anything — the production shape for a phone-minted id
 *  (every record-bearing session takes the live/resume paths before this door is asked). */
function recordlessTable(legOf: (sid: string) => "winter" | "engine" | undefined): WinterSessionDrivers {
  const never = (): never => { throw new Error("not reached: a record-less session never opens a child"); };
  return {
    legForNewSession: () => "winter",
    legOf,
    assertAvailable: () => {},
    create: async () => never(),
    recordEngineCreation: () => {},
    get: () => undefined,
    runTurn: async () => never(),
    ensure: async () => undefined,
    evict: async () => {},
    list: () => [],
    endAll: async () => {},
  };
}

describe("fix wave F2: a session with no runtime record refuses typed on the Winter leg", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(winter: WinterSessionDrivers) {
    const home = mkdtempSync(join(tmpdir(), "norma-unrecorded-"));
    const store = new SessionStore(home);
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winter });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "mac");
    return { store, c };
  }

  test("session.send into a `createSynced` (phone-owned) session → INVALID_PARAMS, code session_unrecorded, and NOTHING lands in the log", async () => {
    const { store, c } = await boot(recordlessTable(() => undefined));
    const phoneId = "0f2a1c00-0000-4000-8000-00000000abcd";
    store.createSynced(phoneId, { scope: "phone", mode: "chat", approvalPolicy: "chat" });
    const attach = await c.request(METHODS.sessionAttach, { sessionId: phoneId, fromSeq: 0 });
    expect(attach.error).toBeUndefined();
    const before = store.read(phoneId).length;
    const sent = await c.request(METHODS.sessionSend, { sessionId: phoneId, text: "hello from the Mac" });
    expect(sent.error).toBeTruthy();
    expect(sent.error.code).toBe(ERR.INVALID_PARAMS);
    expect(sent.error.data).toEqual({ code: "session_unrecorded" });
    expect(sent.error.message).toContain("no runtime record");
    // the silence is gone in BOTH directions: no user_message was appended for a turn nobody runs
    expect(store.read(phoneId).length).toBe(before);
    c.close();
  });

  test("session.steer into the same session → the same typed refusal (never `{ ok: true, injected: false }`)", async () => {
    const { store, c } = await boot(recordlessTable(() => undefined));
    const phoneId = "0f2a1c00-0000-4000-8000-00000000abce";
    store.createSynced(phoneId, { scope: "phone", mode: "chat", approvalPolicy: "chat" });
    const steered = await c.request(METHODS.sessionSteer, { sessionId: phoneId, text: "steer" });
    expect(steered.error).toBeTruthy();
    expect(steered.error.code).toBe(ERR.INVALID_PARAMS);
    expect(steered.error.data).toEqual({ code: "session_unrecorded" });
    c.close();
  });

  test("an engine-era record (leg: engine) keeps its own code — the two refusals are distinct", async () => {
    const { store, c } = await boot(recordlessTable(() => "engine"));
    const sid = store.createSession("t", { mode: "code" });
    await c.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
    const sent = await c.request(METHODS.sessionSend, { sessionId: sid, text: "x" });
    expect(sent.error.data).toEqual({ code: "session_predates_winter_leg" });
    c.close();
  });

  test("a server built WITHOUT the driver table is untouched: the message lands in the log as before", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-unrecorded-bare-"));
    const store = new SessionStore(home);
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "mac");
    const phoneId = "0f2a1c00-0000-4000-8000-00000000abcf";
    store.createSynced(phoneId, { scope: "phone", mode: "chat" });
    await c.request(METHODS.sessionAttach, { sessionId: phoneId, fromSeq: 0 });
    const sent = await c.request(METHODS.sessionSend, { sessionId: phoneId, text: "bare" });
    expect(sent.error).toBeUndefined();
    expect(store.read(phoneId).some((e) => e.type === "user_message")).toBe(true);
    c.close();
  });
});
