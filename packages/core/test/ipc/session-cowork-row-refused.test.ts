// Cowork (session door): a STORED session whose mode is `cowork` — a rolled-back newer daemon's, a rebuilt
// log's, a hand-edited index's; `session.create` can never mint one — is refused by every door that would
// run or re-target it, with the SAME typed answer `session.create` gives (INVALID_PARAMS,
// `data.code: "unsupported_topology"`), and appends nothing. These drive the RPC layer; the driver table's
// own refusal (no spawn, no record read, no run home) is pinned in test/runtime-sdk/session-driver.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, ERR, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { WinterLegRefusal, type WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";
import { planAndApplySwitch } from "../../src/runtime-sdk/handoff";

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

const UNSUPPORTED_CODE = { code: "unsupported_topology" };

/** A driver table; `ensure` and `leg` are the knobs. Nothing else may be reached. */
function table(opts: { ensure: WinterSessionDrivers["ensure"]; leg: ReturnType<WinterSessionDrivers["legOf"]> }): WinterSessionDrivers {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    legForNewSession: never, legOf: () => opts.leg, assertAvailable: never, create: never,
    get: () => undefined, runTurn: never, ensure: opts.ensure, evict: async () => {}, list: () => [], endAll: async () => {},
  };
}

describe("a stored cowork row is refused by the doors that would run it", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(winter: WinterSessionDrivers, withHandoff = false) {
    const home = mkdtempSync(join(tmpdir(), "winter-cowork-row-"));
    const store = new SessionStore(home);
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, winter, winterHome: home,
      ...(withHandoff ? { handoff: { planAndApplySwitch: (sessionId: string, model: string | null, confirmLossy: boolean) =>
        planAndApplySwitch({ runtime: {} as never, winter, records: { get: () => undefined } as never, store, settings: () => null }, sessionId, model, confirmLossy) } } : {}),
    });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "mac");
    return { store, c };
  }

  function coworkRow(store: SessionStore): string {
    const id = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", id]);
    return id;
  }

  test("record-less row: session.send and session.steer answer unsupported_topology (not 'phone-owned session'), appending nothing", async () => {
    const { store, c } = await boot(table({ ensure: async () => undefined, leg: undefined }));
    const id = coworkRow(store);
    expect((await c.request(METHODS.sessionAttach, { sessionId: id, fromSeq: 0 })).error).toBeUndefined();
    const before = store.read(id).length;
    const sent = await c.request(METHODS.sessionSend, { sessionId: id, text: "hello" });
    expect(sent.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(sent.error?.data).toEqual(UNSUPPORTED_CODE);
    const steered = await c.request(METHODS.sessionSteer, { sessionId: id, text: "steer" });
    expect(steered.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(steered.error?.data).toEqual(UNSUPPORTED_CODE);
    expect(store.read(id).length).toBe(before);
    c.close();
  });

  test("recorded row: the driver table's typed refusal maps to INVALID_PARAMS + data.code, never INTERNAL", async () => {
    const refusing = async (): Promise<never> => { throw new WinterLegRefusal("unsupported_topology", "Cowork unavailable"); };
    const { store, c } = await boot(table({ ensure: refusing, leg: "winter" }));
    const id = coworkRow(store);
    await c.request(METHODS.sessionAttach, { sessionId: id, fromSeq: 0 });
    const sent = await c.request(METHODS.sessionSend, { sessionId: id, text: "hello" });
    expect(sent.error).toMatchObject({ code: ERR.INVALID_PARAMS, message: "Cowork unavailable", data: UNSUPPORTED_CODE });
    c.close();
  });

  test("session.setModel on a cowork row is refused by planAndApplySwitch — set or clear — and the model column is untouched", async () => {
    const { store, c } = await boot(table({ ensure: async () => undefined, leg: "winter" }), true);
    const id = coworkRow(store);
    const code = store.createSession("global", { mode: "code" });
    for (const model of ["anthropic/claude-opus-5", null]) {
      const res = await c.request(METHODS.sessionSetModel, { sessionId: id, model });
      expect(res.error).toMatchObject({ code: ERR.INVALID_PARAMS, message: "Cowork unavailable", data: UNSUPPORTED_CODE });
    }
    expect(store.meta(id).model).toBeUndefined();
    // The same door still works for a runnable session (no runtime record: the ordinary store write).
    const ok = await c.request(METHODS.sessionSetModel, { sessionId: code, model: "anthropic/claude-opus-5" });
    expect(ok.error).toBeUndefined();
    expect(store.meta(code).model).toBe("anthropic/claude-opus-5");
    c.close();
  });
});
