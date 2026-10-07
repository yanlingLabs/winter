// 2026-10-07: `session.compact` on the Winter leg asks the SESSION to compact. It sends `/compact
// [instructions]` through the session's own driver -- the same door a typed message takes (queued behind a
// running turn, an idle session resumed) -- and answers `requested: true` with the message's seq. It used to
// refuse `not_supported_on_winter_leg`, which left the TUI's `/compact` and `winter compact` dead.
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
  const home = mkdtempSync(join(tmpdir(), "winter-compact-"));
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

describe("session.compact on the Winter leg", () => {
  test("sends `/compact` through the session's driver and answers requested, with the message's seq", async () => {
    const got: string[] = [];
    await withServer(table([false], got), async (c, sessionId) => {
      const res = await c.request(METHODS.sessionCompact, { sessionId });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, compacted: false, uptoSeq: 0, summaryChars: 0, requested: true, seq: 1 });
      expect(got).toEqual(["d0:/compact"]);
    });
  });

  test("instructions ride the command line, trimmed; blank instructions are no instructions", async () => {
    const got: string[] = [];
    await withServer(table([false], got), async (c, sessionId) => {
      expect((await c.request(METHODS.sessionCompact, { sessionId, instructions: "  keep the API decisions  " })).error).toBeUndefined();
      expect((await c.request(METHODS.sessionCompact, { sessionId, instructions: "   " })).error).toBeUndefined();
      expect(got).toEqual(["d0:/compact keep the API decisions", "d0:/compact"]);
    });
  });

  test("a driver replaced while starting: the request lands once, on its successor", async () => {
    const got: string[] = [];
    await withServer(table([true, false], got), async (c, sessionId) => {
      const res = await c.request(METHODS.sessionCompact, { sessionId });
      expect(res.error).toBeUndefined();
      expect(got).toEqual(["d1:/compact"]);
    });
  });
});
