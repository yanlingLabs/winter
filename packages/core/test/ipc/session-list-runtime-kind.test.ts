// Winter Phase 8c (P8c-14/Task 4.2): `session.list` rows carry the RECORDED runtime leg
// (`runtimeKind`), derived from `opts.winter.legOf(sessionId)` at list time — never a stored column.
// Unified listing/resume BY RECORD (an idle/resumed session following `sessionLegOf(record)` rather
// than a live driver) is lane 1's own P8c-14 follow-on work (`session-driver.ts`'s `resume()`/
// `ensure()`), already proved by its own e2e suite (7/7 on the real official leg, plus the existing
// Winter-leg resume tests this repo already carries) — this file's own scope is the LISTING surface
// only: does the row say the right thing for each of the three legs `sessionLegOf` can answer.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";
import type { RuntimeSessionRecord, RuntimeSessionRecords } from "../../src/runtime-state/records";

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

function tableWithLegs(legs: Map<string, "winter" | "official" | "engine">): WinterSessionDrivers {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    legForNewSession: () => "winter", legOf: (id) => legs.get(id), assertAvailable: () => {},
    create: never, get: () => undefined, runTurn: never, ensure: never,
    evict: async () => {}, list: () => [], endAll: async () => {},
  };
}

/** Winter Phase 8d (P8d-7, Task 4.1): a fake `RuntimeSessionRecords` narrowed to `get`, the ONE
 *  member `opts.records` names — `providerId` rides the same record `legOf` above reads. */
function tableWithProviders(byId: Map<string, string>): Pick<RuntimeSessionRecords, "get"> {
  return {
    get: (sessionId) => (byId.has(sessionId) ? ({ providerId: byId.get(sessionId) } as RuntimeSessionRecord) : undefined),
  };
}

describe("session.list carries the recorded runtimeKind", () => {
  test("winter, official, engine-era, and unrecorded rows each answer honestly", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-list-runtimekind-"));
    const store = new SessionStore(home);
    const winterId = store.createSession("g");
    const officialId = store.createSession("g");
    const engineId = store.createSession("g");
    const unrecordedId = store.createSession("g");
    const legs = new Map<string, "winter" | "official" | "engine">([
      [winterId, "winter"], [officialId, "official"], [engineId, "engine"],
      // unrecordedId deliberately absent from the map — `legOf` answers undefined, exactly like a
      // records store that can't find the row (or a phone-owned session with no runtime record).
    ]);
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winter: tableWithLegs(legs) });
    const c = await TestClient.connect(socketPath);
    try {
      await c.hello(tokens.harness, "mac");
      const res = await c.request(METHODS.sessionList, {});
      const byId = new Map((res.result.sessions as Array<{ sessionId: string; runtimeKind?: string }>).map((s) => [s.sessionId, s.runtimeKind]));
      expect(byId.get(winterId)).toBe("winter-agent");
      expect(byId.get(officialId)).toBe("claude-agent");
      expect(byId.get(engineId)).toBeUndefined();
      expect(byId.get(unrecordedId)).toBeUndefined();
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("no driver table at all: every row is silently absent the field (a bare test server)", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-list-runtimekind-bare-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("g");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    const c = await TestClient.connect(socketPath);
    try {
      await c.hello(tokens.harness, "mac");
      const res = await c.request(METHODS.sessionList, {});
      const row = (res.result.sessions as Array<{ sessionId: string; runtimeKind?: string }>).find((s) => s.sessionId === sessionId);
      expect(row?.runtimeKind).toBeUndefined();
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  // Winter Phase 8d (P8d-7, Task 4.1): `providerId` is a FINER fact than `runtimeKind` — read from
  // the SAME record, but present or absent independently of whether a leg is known.
  test("providerId rides the record independently of runtimeKind — present, absent, and no-door cases", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-list-providerid-"));
    const store = new SessionStore(home);
    const recordedId = store.createSession("g");
    const unrecordedId = store.createSession("g");
    const legs = new Map<string, "winter" | "official" | "engine">([[recordedId, "winter"]]);
    const providers = new Map<string, string>([[recordedId, "anthropic"]]);
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      winter: tableWithLegs(legs), records: tableWithProviders(providers),
    });
    const c = await TestClient.connect(socketPath);
    try {
      await c.hello(tokens.harness, "mac");
      const res = await c.request(METHODS.sessionList, {});
      const byId = new Map((res.result.sessions as Array<{ sessionId: string; providerId?: string }>).map((s) => [s.sessionId, s.providerId]));
      expect(byId.get(recordedId)).toBe("anthropic");
      expect(byId.get(unrecordedId)).toBeUndefined();
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("no records door at all: providerId is silently absent on every row (a bare test server)", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-list-providerid-bare-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("g");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    const c = await TestClient.connect(socketPath);
    try {
      await c.hello(tokens.harness, "mac");
      const res = await c.request(METHODS.sessionList, {});
      const row = (res.result.sessions as Array<{ sessionId: string; providerId?: string }>).find((s) => s.sessionId === sessionId);
      expect(row?.providerId).toBeUndefined();
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });
});
