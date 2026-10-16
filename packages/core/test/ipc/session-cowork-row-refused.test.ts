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
import { rpcFromWinterRefusal, startIpcServer, type InternalSessionCreator } from "../../src/ipc/server";
import { CoworkError } from "../../src/cowork/types";
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
    legForNewSession: never, legOf: () => opts.leg, assertAvailable: () => {}, create: never,
    get: () => undefined, runTurn: never, ensure: opts.ensure, evict: async () => {}, list: () => [], endAll: async () => {},
  };
}

describe("a stored cowork row is refused by the doors that would run it", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(winter: WinterSessionDrivers, withHandoff = false, extra: Record<string, unknown> = {}) {
    const home = mkdtempSync(join(tmpdir(), "winter-cowork-row-"));
    const store = new SessionStore(home);
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, winter, winterHome: home,
      ...extra,
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
  // S2: the refusal must not depend on a handoff being wired — without one, `store.setModel` would stamp the column.
  test("session.setModel is refused for a cowork row even with NO handoff wired, and nothing is written", async () => {
    const { store, c } = await boot(table({ ensure: async () => undefined, leg: "winter" }), false);
    const cowork = coworkRow(store);
    const odd = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["something-new", odd]);
    for (const id of [cowork, odd]) {
      for (const model of ["anthropic/claude-opus-5", null]) {
        const res = await c.request(METHODS.sessionSetModel, { sessionId: id, model });
        expect(res.error).toMatchObject({ code: ERR.INVALID_PARAMS, data: UNSUPPORTED_CODE });
      }
      expect(store.meta(id).model).toBeUndefined();
    }
    expect((await c.request(METHODS.sessionSetModel, { sessionId: "s_nope", model: "anthropic/claude-opus-5" })).error?.code).toBe(ERR.NOT_FOUND);
    const code = store.createSession("global", { mode: "code" });
    expect((await c.request(METHODS.sessionSetModel, { sessionId: code, model: "anthropic/claude-opus-5" })).error).toBeUndefined();
    expect(store.meta(code).model).toBe("anthropic/claude-opus-5");
    c.close();
  });

  // The other two session setters match `session.setModel`: an unrunnable row's column is never written.
  test("session.setPolicy and session.setEffort refuse a cowork row and an unknown-mode row, and the column is unchanged", async () => {
    const { store, c } = await boot(table({ ensure: async () => undefined, leg: "winter" }), false);
    const cowork = coworkRow(store);
    const odd = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["something-new", odd]);
    for (const id of [cowork, odd]) {
      const before = { policy: store.meta(id).approvalPolicy, effort: store.meta(id).effort };
      expect(before.effort).toBeUndefined();
      for (const policy of ["auto", "plan", "bypass"]) {
        const res = await c.request(METHODS.sessionSetPolicy, { sessionId: id, policy });
        expect(res.error).toMatchObject({ code: ERR.INVALID_PARAMS, data: UNSUPPORTED_CODE });
      }
      for (const effort of ["high", "ultra", null]) {
        const res = await c.request(METHODS.sessionSetEffort, { sessionId: id, effort });
        expect(res.error).toMatchObject({ code: ERR.INVALID_PARAMS, data: UNSUPPORTED_CODE });
      }
      expect({ policy: store.meta(id).approvalPolicy, effort: store.meta(id).effort }).toEqual(before);
    }
    // An unknown id is still NOT_FOUND from both, and a Code session still works.
    expect((await c.request(METHODS.sessionSetPolicy, { sessionId: "s_nope", policy: "auto" })).error?.code).toBe(ERR.NOT_FOUND);
    expect((await c.request(METHODS.sessionSetEffort, { sessionId: "s_nope", effort: "high" })).error?.code).toBe(ERR.NOT_FOUND);
    const code = store.createSession("global", { mode: "code" });
    expect((await c.request(METHODS.sessionSetPolicy, { sessionId: code, policy: "auto" })).error).toBeUndefined();
    expect(store.meta(code).approvalPolicy).toBe("auto");
    expect((await c.request(METHODS.sessionSetEffort, { sessionId: code, effort: null })).error).toBeUndefined();
    c.close();
  });

  // S3: `workflow.run` launches agents that create CODE children with the row's cwd and policy.
  test("workflow.run and workflow.list refuse a cowork row: nothing is launched, no script resolved, nothing listed", async () => {
    const launched: unknown[] = [];
    let listed = 0, read = 0;
    const workflows = { launch: (input: unknown) => { launched.push(input); return "run_1"; }, list: () => { listed++; return []; } };
    const workflowStore = { read: () => { read++; return { body: "x" }; }, list: () => { listed++; return []; } };
    const { store, c } = await boot(table({ ensure: async () => undefined, leg: "winter" }), false, { workflows, workflowStore });
    const cowork = coworkRow(store);
    const odd = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["something-new", odd]);
    for (const id of [cowork, odd]) {
      const byScript = await c.request(METHODS.workflowRun, { sessionId: id, script: "return 1" });
      expect(byScript.error).toMatchObject({ code: ERR.INVALID_PARAMS, data: UNSUPPORTED_CODE });
      const byName = await c.request(METHODS.workflowRun, { sessionId: id, name: "saved" });
      expect(byName.error).toMatchObject({ code: ERR.INVALID_PARAMS, data: UNSUPPORTED_CODE });
      expect((await c.request(METHODS.workflowList, { sessionId: id })).error).toMatchObject({ code: ERR.INVALID_PARAMS, data: UNSUPPORTED_CODE });
    }
    expect([launched.length, listed, read]).toEqual([0, 0, 0]);
    // The same handlers still serve a Code session, and an unknown id is still NOT_FOUND.
    const code = store.createSession("global", { mode: "code" });
    const run = await c.request(METHODS.workflowRun, { sessionId: code, script: "return 1" });
    expect(run.error).toBeUndefined();
    expect(launched).toHaveLength(1);
    expect((await c.request(METHODS.workflowList, { sessionId: code })).error).toBeUndefined();
    expect((await c.request(METHODS.workflowRun, { sessionId: "s_nope", script: "x" })).error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // L1: the store-level guard's `CoworkError` becomes the numeric RPC error, not an uncaught string-coded Error.
  test("the store guard's CoworkError maps to INVALID_PARAMS + data.code (rpcFromWinterRefusal), reached through the internal creator", async () => {
    let creator: InternalSessionCreator | undefined;
    const { store } = await boot(table({ ensure: async () => undefined, leg: "winter" }), false, { onSessionCreator: (c: InternalSessionCreator) => { creator = c; } });
    // The daemon's own doors create through this: a cowork mode smuggled past its type reaches `SessionStore.createSession`.
    let thrown: unknown;
    try { await creator!({ scope: "global", approvalPolicy: "ask", mode: "cowork" as never }); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(CoworkError);
    expect((thrown as CoworkError).code).toBe("unsupported_topology");
    expect(store.list()).toEqual([]);

    let mapped: any;
    try { rpcFromWinterRefusal(thrown); } catch (err) { mapped = err; }
    expect(mapped).toMatchObject({ code: ERR.INVALID_PARAMS, message: "Cowork unavailable", data: { code: "unsupported_topology" } });
    // Another CoworkError code keeps the Cowork doors' own numeric mapping.
    let denied: any;
    try { rpcFromWinterRefusal(new CoworkError("authority_denied")); } catch (err) { denied = err; }
    expect(denied).toMatchObject({ code: ERR.UNAUTHORIZED, message: "Cowork request refused", data: { code: "authority_denied" } });
    // And anything that is not a refusal is still rethrown untouched.
    const other = new Error("boom");
    expect(() => rpcFromWinterRefusal(other)).toThrow(other);
  });
});
