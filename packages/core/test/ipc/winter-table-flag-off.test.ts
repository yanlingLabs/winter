// P8b Task 16 (fix round 1, m9) — THE FLAG-OFF BYTE PIN WITH THE TABLE PRESENT.
//
// `test/ipc`'s other pins run with `opts.winter` absent. The shipped daemon always constructs the
// driver table (daemon.ts), so the invariant P8b-13 actually needs is "table PRESENT, every flag
// OFF, engine PRESENT ⇒ every `session.*` reply is byte-identical to the table-less server's".
// Two servers, two homes, the same script; the replies are compared after the only legitimately
// different bytes (the minted session id) are normalised. The table's side effects are then
// checked separately: an engine-shaped record (no backend id) per create, no driver.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { startIpcServer } from "../../src/ipc/server";
import { sessionLegOf } from "../../src/runtime-sdk/leg";
import { createWinterSessionDrivers, type WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";
import { openRuntimeStateDb, ProjectionCheckpoints, RuntimeSessionRecords, type RuntimeStateDb } from "../../src/runtime-state";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import type { Settings } from "../../src/settings";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (raw: string) => void>();
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
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(line); c.pending.delete(msg.id); }
          }
        },
        drain() { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  /** The RAW reply line — the bytes under comparison. */
  request(method: string, params?: unknown): Promise<string> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`no reply to ${method} within 2 s`)), 2000);
    });
  }
  close(): void { this.socket.end(); }
}

/** The engine double every session.* handler on the engine path reaches. */
const fakeEngine = () => ({
  knownModels: () => [],
  isRunning: () => false,
  hasBackgroundWork: () => false,
  isGrantDenied: () => false,
  runTurn: async () => {},
  steer: () => ({ injected: false }),
  interrupt: () => ({ wasRunning: false }),
  compact: async () => ({ compacted: false, uptoSeq: 0, summaryChars: 0 }),
});

const FLAGS_OFF = { runtimes: { winterLeg: { chat: false, dispatch: false, code: false } } } as unknown as Settings;

describe("session.* with the driver table present and every flag off (P8b-13)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const c of cleanups.splice(0)) c(); });

  async function boot(withTable: boolean) {
    const home = mkdtempSync(join(tmpdir(), withTable ? "norma-winter-table-on-" : "norma-winter-table-off-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    let winter: WinterSessionDrivers | undefined;
    let records: RuntimeSessionRecords | undefined;
    let rs: RuntimeStateDb | undefined;
    if (withTable) {
      rs = openRuntimeStateDb(home);
      records = new RuntimeSessionRecords(rs);
      winter = createWinterSessionDrivers({
        home, settings: () => FLAGS_OFF, runtime: undefined, records, checkpoints: new ProjectionCheckpoints(rs), store, hub,
        secrets: new FileSecretStore(join(home, "secrets.json")), buildSessionCapabilities: () => ({}),
        approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(),
        rootsOf: () => [], tmpDirOf: () => home, outDirOf: () => home, memoryKeyOf: () => "k",
      });
    }
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub, engine: fakeEngine() as never, ...(winter === undefined ? {} : { winter }) });
    cleanups.push(() => { server.stop(); store.close(); rs?.close(); rmSync(home, { recursive: true, force: true }); });
    const client = await TestClient.connect(socketPath);
    await client.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: tokens.harness, clientName: "pin" });
    return { client, store, records, winter };
  }

  /** The same script on either server; replies with the session id normalised. */
  async function script(client: TestClient): Promise<{ replies: string[]; sessionIds: string[] }> {
    const replies: string[] = [];
    const sessionIds: string[] = [];
    // The only legitimately different bytes: the minted ids and the wall-clock `createdAt` stamps.
    const norm = (line: string): string => sessionIds.reduce((acc, id, i) => acc.split(id).join(`<S${i}>`), line).replace(/"createdAt":\d+/g, '"createdAt":<T>');
    for (const mode of ["chat", "code"] as const) {
      const created = await client.request(METHODS.sessionCreate, { scope: "pin", mode, ...(mode === "chat" ? {} : { cwd: tmpdir() }) });
      const sid = (JSON.parse(created) as { result: { sessionId: string } }).result.sessionId;
      sessionIds.push(sid);
      replies.push(norm(created));
      replies.push(norm(await client.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 })));
      replies.push(norm(await client.request(METHODS.sessionSend, { sessionId: sid, text: "hello" })));
      replies.push(norm(await client.request(METHODS.sessionSteer, { sessionId: sid, text: "and this" })));
      replies.push(norm(await client.request(METHODS.sessionInterrupt, { sessionId: sid })));
      replies.push(norm(await client.request(METHODS.sessionCompact, { sessionId: sid })));
      replies.push(norm(await client.request(METHODS.sessionSetModel, { sessionId: sid, model: "gpt-x" })));
      replies.push(norm(await client.request(METHODS.sessionList, {})));
    }
    return { replies, sessionIds };
  }

  test("create/attach/send/steer/interrupt/compact/setModel/list reply byte-identically with and without the table", async () => {
    const off = await boot(false);
    const on = await boot(true);
    const a = await script(off.client);
    const b = await script(on.client);
    expect(b.replies).toEqual(a.replies);
    expect(a.replies).toHaveLength(16);
    expect(a.replies.filter((r) => r.includes('"error"'))).toEqual([]);
    // the table's ONLY trace: an engine-shaped record per create (no backend id), and no driver
    for (const sid of b.sessionIds) {
      const rec = on.records!.get(sid);
      expect(rec).toBeDefined();
      expect(sessionLegOf(rec)).toBe("engine");
      expect(rec!.backendSessionId).toBeUndefined();
      expect(on.winter!.get(sid)).toBeUndefined();
      expect(on.winter!.legOf(sid)).toBe("engine");
    }
    expect(on.winter!.list()).toEqual([]);
    // and the session logs are the same shape (the user_message the hub appended, nothing Winter)
    for (let i = 0; i < a.sessionIds.length; i++) {
      const types = (s: SessionStore, sid: string) => s.read(sid).map((e) => e.type);
      expect(types(on.store, b.sessionIds[i]!)).toEqual(types(off.store, a.sessionIds[i]!));
    }
    off.client.close();
    on.client.close();
  });
});
