// A send (or steer) that joins a session runtime replaced while it was starting is refused
// `session_replaced` by that runtime (`WinterSession.end` mid-open): nothing was taken. The RPC doors retry
// ONCE on the session's next driver, so a client never sees it in the normal case; if the successor is
// replaced too, the error is typed and RETRYABLE (`ERR.RETRY`, `data.retryable: true`), never INTERNAL.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { WinterLegRefusal, type WinterSessionDrivers, type LegSession } from "../../src/runtime-sdk/session-driver";
import { withReplacementRetry } from "../../src/runtime-sdk/session-replaced";

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

const replaced = () => new WinterLegRefusal("session_replaced", "this session's runtime was replaced while it was starting; send again");

/** A driver that refuses `session_replaced` (and hands the table its successor) or takes the text. */
function driver(name: string, replace: boolean, got: string[], onReplaced: () => void): LegSession {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    sessionId: "s1", backendSessionId: "be-1", mode: "code", state: "live", generation: 1, resumed: true,
    init: undefined, turnRunning: false, turnStartedAt: undefined, done: Promise.resolve(),
    pendingSends: [], heldDeliveries: [],
    send: async (text: string) => { if (replace) { onReplaced(); throw replaced(); } got.push(`${name}:${text}`); return { seq: got.length, queued: false }; },
    steer: async (text: string) => { if (replace) { onReplaced(); throw replaced(); } got.push(`${name}:steer:${text}`); return { seq: got.length, injected: true }; },
    interrupt: never, compact: never, setModel: never, setPolicy: never,
    end: async () => {}, deliver: never, open: async () => {}, idle: async () => {},
  } as unknown as LegSession;
}

/** The table's current driver for the session: `drivers[i]`, advanced each time a driver is replaced. */
function table(replaceFlags: boolean[], got: string[]): WinterSessionDrivers {
  let i = 0;
  const drivers: LegSession[] = [];
  replaceFlags.forEach((r, n) => drivers.push(driver(`d${n}`, r, got, () => { i = Math.min(i + 1, drivers.length - 1); })));
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    legForNewSession: () => "winter",
    legOf: () => "winter",
    assertAvailable: () => {},
    create: async () => never(),
    get: () => drivers[i],
    runTurn: async () => never(),
    ensure: async () => drivers[i],
    evict: async () => {},
    list: () => [],
    endAll: async () => {},
  } as unknown as WinterSessionDrivers;
}

async function withServer(t: WinterSessionDrivers, body: (c: TestClient, sessionId: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "winter-send-replaced-"));
  const store = new SessionStore(home);
  const sessionId = store.createSession("global");
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  const tokens = await authority.ensureTokens();
  const socketPath = join(home, "core.sock");
  const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winter: t });
  const c = await TestClient.connect(socketPath);
  try {
    await c.hello(tokens.harness, "mac");
    await c.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await body(c, sessionId);
  } finally {
    c.close();
    server.stop();
    store.close();
  }
}

describe("session_replaced: the send doors retry once on the session's next driver", () => {
  test("session.send lands on the successor; the client sees a plain success", async () => {
    const got: string[] = [];
    await withServer(table([true, false], got), async (c, sessionId) => {
      const res = await c.request(METHODS.sessionSend, { sessionId, text: "hello" });
      expect(res.error).toBeUndefined();
      expect(got).toEqual(["d1:hello"]);
    });
  });

  test("session.steer lands on the successor too", async () => {
    const got: string[] = [];
    await withServer(table([true, false], got), async (c, sessionId) => {
      const res = await c.request(METHODS.sessionSteer, { sessionId, text: "also" });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, injected: true });
      expect(got).toEqual(["d1:steer:also"]);
    });
  });

  test("replaced twice: a typed RETRY error (never INTERNAL), and nothing was taken", async () => {
    const got: string[] = [];
    await withServer(table([true, true, false], got), async (c, sessionId) => {
      const res = await c.request(METHODS.sessionSend, { sessionId, text: "hello" });
      expect(res.error.code).toBe(ERR.RETRY);
      expect(res.error.data).toEqual({ code: "session_replaced", retryable: true });
      expect(got).toEqual([]);
    });
  });
});

describe("withReplacementRetry", () => {
  test("only session_replaced is retried, once, and only onto a different driver", async () => {
    const calls: string[] = [];
    const send = async (d: string) => { calls.push(d); if (d === "a") throw replaced(); return d; };
    expect(await withReplacementRetry("a", async () => "b", send)).toBe("b");
    expect(calls).toEqual(["a", "b"]);
    await expect(withReplacementRetry("a", async () => "a", send)).rejects.toThrow("replaced");
    await expect(withReplacementRetry("a", async () => undefined, send)).rejects.toThrow("replaced");
    let asked = false;
    await expect(withReplacementRetry("a", async () => { asked = true; return "b"; }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(asked).toBe(false);
  });
});
