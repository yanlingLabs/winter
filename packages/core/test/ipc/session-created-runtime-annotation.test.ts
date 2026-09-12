// Winter Phase 8c (P8c-5): the runtime-annotation fields on the seq-1 `session_created` event.
// `runtimeKind` is knowable at ONE point in the creation transaction — the `session.create`/
// `session.dispatch` handler, before the 8a runtime record exists (see ipc/server.ts's doc
// comments at both call sites and store.ts's `createSession`) — so this test drives the RPC over
// a bare IPC server with a fake `WinterSessionDrivers` (same shape as session-unrecorded.test.ts's
// `recordlessTable`) standing in for the Winter leg, and reads the persisted event back off the
// store rather than trusting the RPC reply alone.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
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

/** A driver table whose `create` succeeds silently — enough for the creation transaction to
 *  commit (no `WinterLegRefusal`), never actually spawning anything. */
function acceptingTable(): WinterSessionDrivers {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    legForNewSession: () => "winter",
    legOf: () => "winter",
    assertAvailable: () => {},
    create: async () => ({}) as never,
    get: () => undefined,
    runTurn: async () => never(),
    ensure: async () => undefined,
    evict: async () => {},
    list: () => [],
    endAll: async () => {},
  };
}

describe("Winter Phase 8c: session_created carries runtimeKind/modelRef when known at creation", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(winter: WinterSessionDrivers | undefined) {
    const home = mkdtempSync(join(tmpdir(), "norma-runtime-annotation-"));
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

  test("session.create on the Winter leg yields session_created.runtimeKind === \"winter-agent\"", async () => {
    const { store, c } = await boot(acceptingTable());
    const created = await c.request(METHODS.sessionCreate, { scope: "global" });
    expect(created.error).toBeUndefined();
    const first = store.read(created.result.sessionId, 0)[0];
    expect(first?.type).toBe("session_created");
    expect((first as any).runtimeKind).toBe("winter-agent");
    // No model was requested — modelRef stays absent rather than a guessed default.
    expect((first as any).modelRef).toBeUndefined();
    c.close();
  });

  test("session.create with an explicit model stamps the RESOLVED modelRef", async () => {
    const { store, c } = await boot(acceptingTable());
    const created = await c.request(METHODS.sessionCreate, { scope: "global", model: "gpt-5.6-sol" });
    expect(created.error).toBeUndefined();
    const first = store.read(created.result.sessionId, 0)[0];
    expect((first as any).modelRef).toBe("gpt-5.6-sol");
    c.close();
  });

  test("session.dispatch's singleton also stamps runtimeKind (no modelRef — dispatch takes no model param)", async () => {
    const { store, c } = await boot(acceptingTable());
    const dispatched = await c.request(METHODS.sessionDispatch, {});
    expect(dispatched.error).toBeUndefined();
    const first = store.read(dispatched.result.sessionId, 0)[0];
    expect((first as any).runtimeKind).toBe("winter-agent");
    expect((first as any).modelRef).toBeUndefined();
    c.close();
  });

  test("with no Winter facade at all (bare test server), runtimeKind is left undefined — never a guessed value", async () => {
    const { store, c } = await boot(undefined);
    const created = await c.request(METHODS.sessionCreate, { scope: "global" });
    expect(created.error).toBeUndefined();
    const first = store.read(created.result.sessionId, 0)[0];
    expect((first as any).runtimeKind).toBeUndefined();
    c.close();
  });
});
