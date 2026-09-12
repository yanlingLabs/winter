// Winter Phase 8c (P8c-6): `session.send`'s import door — the RPC-level wiring this lane owns in
// `ipc/server.ts`. Proved here against a FAKE driver table + a fake `importLegacy` hook (no real
// winter binary, no real conversion) — the real-binary proof that a CONVERTED transcript actually
// resumes lives in `test/e2e/import-legacy-real-child.test.ts`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { WinterSessionDrivers, LegSession } from "../../src/runtime-sdk/session-driver";
import { ImportLegacySessionError } from "../../src/runtime-sdk/import-legacy";

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

/** A driver table whose `legOf`/`get`/`ensure` all read ONE mutable ref — `importSession` flips it,
 *  which is what lets the test observe "ensure() only succeeds AFTER importSession() ran". */
function fakeTable(opts: { leg: { current: "engine" | "winter" | undefined }; sent: string[] }): WinterSessionDrivers {
  const legNow = opts.leg;
  const never = (): never => { throw new Error("not reached by this test"); };
  const session: LegSession = {
    sessionId: "s1", backendSessionId: "be-1", mode: "code", state: "live", generation: 1, resumed: true,
    init: undefined, turnRunning: false, turnStartedAt: undefined, done: Promise.resolve(),
    pendingSends: [], heldDeliveries: [],
    send: async (text) => { opts.sent.push(text); return { seq: opts.sent.length, queued: false }; },
    steer: never, interrupt: never, compact: never, setModel: never, setPolicy: never,
    end: async () => {}, deliver: never, open: async () => {}, idle: async () => {},
  };
  return {
    legForNewSession: () => "winter",
    legOf: () => legNow.current,
    assertAvailable: () => {},
    create: async () => never(),
    get: () => (legNow.current === "winter" ? session : undefined),
    runTurn: async () => never(),
    ensure: async () => (legNow.current === "winter" ? session : undefined),
    evict: async () => {},
    list: () => [],
    endAll: async () => {},
  };
}

async function boot(winter: WinterSessionDrivers, store: SessionStore, home: string, importLegacy?: { importSession(sessionId: string): Promise<{ backendSessionId: string; entries: number }> }) {
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  const tokens = await authority.ensureTokens();
  const socketPath = join(home, "core.sock");
  const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winter, importLegacy });
  const c = await TestClient.connect(socketPath);
  await c.hello(tokens.harness, "mac");
  return { server, c };
}

describe("session.send — the P8c-6 engine-era import door", () => {
  test("an engine-era session is imported ONCE, then the send proceeds on the newly-resumable leg", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-send-import-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    const sent: string[] = [];
    const legRef = { current: "engine" as "engine" | "winter" | undefined };
    const table = fakeTable({ leg: legRef, sent });
    let importCalls = 0;
    const importLegacy = {
      importSession: async (id: string) => {
        importCalls++;
        expect(id).toBe(sessionId);
        // Simulate the real door: the record is now "winter" from here on.
        legRef.current = "winter";
        return { backendSessionId: "be-imported", entries: 2 };
      },
    };
    const { server, c } = await boot(table, store, home, importLegacy);
    try {
      await c.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      const res = await c.request(METHODS.sessionSend, { sessionId, text: "continue please" });
      expect(res.error).toBeUndefined();
      expect(importCalls).toBe(1);
      expect(sent).toEqual(["continue please"]);
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("a live/resumable session never triggers an import attempt", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-send-import-live-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    const sent: string[] = [];
    const table = fakeTable({ leg: { current: "winter" }, sent });
    let importCalls = 0;
    const importLegacy = { importSession: async () => { importCalls++; return { backendSessionId: "x", entries: 0 }; } };
    const { server, c } = await boot(table, store, home, importLegacy);
    try {
      await c.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      const res = await c.request(METHODS.sessionSend, { sessionId, text: "hi" });
      expect(res.error).toBeUndefined();
      expect(importCalls).toBe(0);
      expect(sent).toEqual(["hi"]);
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("no importLegacy hook wired: an engine-era session keeps the ordinary permanent refusal", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-send-import-none-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    const table = fakeTable({ leg: { current: "engine" }, sent: [] });
    const { server, c } = await boot(table, store, home, undefined);
    try {
      await c.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      const res = await c.request(METHODS.sessionSend, { sessionId, text: "hi" });
      expect(res.error?.data?.code).toBe("session_predates_winter_leg");
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("m1 (whole-branch review): the attachment check runs BEFORE the import attempt — a client attached elsewhere never triggers it", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-send-import-attach-"));
    const store = new SessionStore(home);
    const sessionIdA = store.createSession("global");
    const sessionIdB = store.createSession("global");
    const legRef = { current: "engine" as "engine" | "winter" | undefined };
    const table = fakeTable({ leg: legRef, sent: [] });
    let importCalls = 0;
    const importLegacy = {
      importSession: async (id: string) => { importCalls++; legRef.current = "winter"; return { backendSessionId: "be-imported", entries: 1 }; },
    };
    const { server, c } = await boot(table, store, home, importLegacy);
    try {
      // Attached to session A, never B — sending to the engine-era session B must be refused for
      // attachment BEFORE the (expensive, mutating) import ever runs.
      await c.request(METHODS.sessionAttach, { sessionId: sessionIdA, fromSeq: 0 });
      const res = await c.request(METHODS.sessionSend, { sessionId: sessionIdB, text: "hi" });
      expect(res.error).toBeDefined();
      expect(res.error?.message).toContain("not attached");
      expect(res.error?.message).toContain(sessionIdB);
      expect(importCalls).toBe(0);
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("an import failure is refused typed, never a silent fall-through to the log-only path", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-send-import-fail-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    const table = fakeTable({ leg: { current: "engine" }, sent: [] });
    const importLegacy = { importSession: async () => { throw new ImportLegacySessionError("boom"); } };
    const { server, c } = await boot(table, store, home, importLegacy);
    try {
      await c.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      const res = await c.request(METHODS.sessionSend, { sessionId, text: "hi" });
      expect(res.error?.data?.code).toBe("session_import_failed");
      expect(res.error?.message).toContain("boom");
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });
});
