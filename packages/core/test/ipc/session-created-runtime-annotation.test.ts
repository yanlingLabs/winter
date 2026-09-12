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
import type { NormaRuntimeSdk } from "../../src/runtime-sdk/create";

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

/** Winter Phase 8d (P8d-7): a fake `NormaRuntimeSdk` whose ONLY live member is
 *  `officialPeerSync` — every other member throws if ever touched, mirroring
 *  `handoff.test.ts`'s `fakeRuntime` (this file needs no barrier/selector, only the one
 *  presence check `session.create`/`session.dispatch` read to decide whether `runtimeKind` is
 *  knowable). */
function fakeRuntimeWithOfficialPeer(present: boolean): NormaRuntimeSdk {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    sdk: {} as NormaRuntimeSdk["sdk"],
    spawnHookFor: never, officialPeer: never,
    officialPeerSync: () => (present ? ({} as never) : undefined),
    claudeExecutableFor: never,
    selectRuntimeFor: never,
    buildSelectionInput: never,
    registerHandoffParticipants: () => {},
    trackQuery: never, untrack: never,
    messaging: { releaseHeld: never },
    dispose: never,
  };
}

describe("Winter Phase 8c: session_created carries runtimeKind/modelRef when known at creation", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(winter: WinterSessionDrivers | undefined, runtimeSdk?: NormaRuntimeSdk) {
    const home = mkdtempSync(join(tmpdir(), "norma-runtime-annotation-"));
    const store = new SessionStore(home);
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winter, runtimeSdk });
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

  // Winter Phase 8d (P8d-7, Task 4.1): the AMENDMENT to Phase 8c's stamp. M7 measured that the
  // pre-8d code stamped "winter-agent" unconditionally whenever `opts.winter` existed — a LIE for
  // a session the driver later runs on the official leg. These three cases are the fix's decision
  // table: an official peer alone is not enough (bail-out matters only WITH a Claude-family
  // model), and a Claude-family model alone is not enough (bail-out matters only WITH an official
  // peer) — only the conjunction is the honest "cannot know from here" case.
  test("an official peer present AND a Claude-family model: runtimeKind is OMITTED (P8d-7 — not a guess)", async () => {
    const { store, c } = await boot(acceptingTable(), fakeRuntimeWithOfficialPeer(true));
    const created = await c.request(METHODS.sessionCreate, { scope: "global", model: "claude-opus-5" });
    expect(created.error).toBeUndefined();
    const first = store.read(created.result.sessionId, 0)[0];
    expect((first as any).runtimeKind).toBeUndefined();
    c.close();
  });

  test("an official peer present but a NON-Claude-family model: runtimeKind still stamps winter-agent", async () => {
    const { store, c } = await boot(acceptingTable(), fakeRuntimeWithOfficialPeer(true));
    const created = await c.request(METHODS.sessionCreate, { scope: "global", model: "gpt-5.6-sol" });
    expect(created.error).toBeUndefined();
    const first = store.read(created.result.sessionId, 0)[0];
    expect((first as any).runtimeKind).toBe("winter-agent");
    c.close();
  });

  test("a Claude-family model but NO official peer: runtimeKind still stamps winter-agent", async () => {
    const { store, c } = await boot(acceptingTable(), fakeRuntimeWithOfficialPeer(false));
    const created = await c.request(METHODS.sessionCreate, { scope: "global", model: "claude-opus-5" });
    expect(created.error).toBeUndefined();
    const first = store.read(created.result.sessionId, 0)[0];
    expect((first as any).runtimeKind).toBe("winter-agent");
    c.close();
  });

  test("session.dispatch (no model param) stamps winter-agent even with an official peer present", async () => {
    const { store, c } = await boot(acceptingTable(), fakeRuntimeWithOfficialPeer(true));
    const dispatched = await c.request(METHODS.sessionDispatch, {});
    expect(dispatched.error).toBeUndefined();
    const first = store.read(dispatched.result.sessionId, 0)[0];
    expect((first as any).runtimeKind).toBe("winter-agent");
    c.close();
  });
});
