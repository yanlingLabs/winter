// Winter Phase 8c (P8c-11, Task 2.3): task.list over the Winter leg reads the session's own
// persisted task_updated history (tasks-reader.ts), not the retired engine's in-process TaskStore.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";
import type { WinterSession } from "../../src/runtime-sdk/winter-session";

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

/**
 * review r1 (Major): `get` (a LIVE driver) and `legOf` (the RECORDED leg, live or not) are
 * DISTINCT signals in the real `WinterSessionDrivers` — an idle/resumed Winter session has a
 * recorded leg but no live driver. This fake keeps them independently controllable so a test can
 * exercise the case the taskList fix is about: `legOf` says "winter" while `get` says undefined.
 */
function tableWith(opts: { live?: Set<string>; recordedLeg?: Map<string, "winter" | "official" | "engine"> }): WinterSessionDrivers {
  const live = opts.live ?? new Set<string>();
  const recordedLeg = opts.recordedLeg ?? new Map<string, "winter" | "engine">();
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    legForNewSession: () => "winter",
    legOf: (sid) => recordedLeg.get(sid),
    assertAvailable: () => {},
    create: async () => ({}) as never,
    get: (sid) => (live.has(sid) ? ({} as WinterSession) : undefined),
    runTurn: async () => never(),
    ensure: async () => undefined,
    evict: async () => {},
    list: () => [],
    endAll: async () => {},
  };
}

/** Back-compat shape for this file's original two cases: `get` and `legOf` agree (a LIVE
 *  Winter-leg session — the common case). */
function tableWithLiveSessions(liveIds: Set<string>): WinterSessionDrivers {
  return tableWith({ live: liveIds, recordedLeg: new Map([...liveIds].map((id) => [id, "winter" as const])) });
}

async function boot(winter: WinterSessionDrivers | undefined, store: SessionStore, home: string) {
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  const tokens = await authority.ensureTokens();
  const socketPath = join(home, "core.sock");
  const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winter });
  const c = await TestClient.connect(socketPath);
  await c.hello(tokens.harness, "mac");
  return { server, c };
}

describe("task.list over the Winter leg reads the session's own task_updated history", () => {
  test("a session opts.winter has, with a task_updated in its log, returns that task", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-task-list-live-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    store.append(sessionId, {
      type: "task_updated", sessionId, threadId: "main",
      task: { id: "1", subject: "write the plan", status: "pending" },
    });
    const { server, c } = await boot(tableWithLiveSessions(new Set([sessionId])), store, home);
    try {
      const res = await c.request(METHODS.taskList, { sessionId });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, tasks: [{ id: "1", subject: "write the plan", status: "pending" }] });
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("a session opts.winter does NOT have falls back to the engine's TaskStore (empty, since none is wired)", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-task-list-cold-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    store.append(sessionId, {
      type: "task_updated", sessionId, threadId: "main",
      task: { id: "1", subject: "write the plan", status: "pending" },
    });
    // `tableWithLiveSessions(new Set())` reports NO live session for this id — the taskList case
    // falls through to `opts.tasks?.list(sessionId) ?? []`, which is empty on a bare server with
    // no TaskStore wired. That is the correct, honest answer even though this session's OWN log
    // does contain a task_updated row: the fallback path is engine-shaped, not a second read of
    // the same log — a session not on the Winter leg has no Winter task graph to report.
    const { server, c } = await boot(tableWithLiveSessions(new Set()), store, home);
    try {
      const res = await c.request(METHODS.taskList, { sessionId });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, tasks: [] });
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("review r1 (Major): an IDLE Winter-leg session (recorded leg, no live driver) still returns its folded tasks", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-task-list-idle-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    store.append(sessionId, {
      type: "task_updated", sessionId, threadId: "main",
      task: { id: "1", subject: "write the plan", status: "pending" },
    });
    // `get` reports NO live driver (the child idled/ended); `legOf` still says "winter" — this is
    // exactly the resumed/idle-session shape the pre-fix `opts.winter?.get(id) !== undefined`
    // guard alone missed, falling through to the empty legacy path.
    const table = tableWith({ live: new Set(), recordedLeg: new Map([[sessionId, "winter"]]) });
    const { server, c } = await boot(table, store, home);
    try {
      const res = await c.request(METHODS.taskList, { sessionId });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, tasks: [{ id: "1", subject: "write the plan", status: "pending" }] });
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("M3 (whole-branch review): an IDLE OFFICIAL-leg session (recorded leg, no live driver) still returns its folded tasks", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-task-list-official-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    store.append(sessionId, {
      type: "task_updated", sessionId, threadId: "main",
      task: { id: "1", subject: "write the plan", status: "pending" },
    });
    // The pre-fix condition (`legOf(id) === "winter"`) missed the official leg entirely — this is
    // that same idle/resumed shape (review r1's own fix for Winter), one leg over.
    const table = tableWith({ live: new Set(), recordedLeg: new Map([[sessionId, "official"]]) });
    const { server, c } = await boot(table, store, home);
    try {
      const res = await c.request(METHODS.taskList, { sessionId });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, tasks: [{ id: "1", subject: "write the plan", status: "pending" }] });
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  test("an ENGINE-era session (recorded leg \"engine\", never Winter) still takes the legacy fallback", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-task-list-engine-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    store.append(sessionId, {
      type: "task_updated", sessionId, threadId: "main",
      task: { id: "1", subject: "write the plan", status: "pending" },
    });
    // Neither live nor recorded as "winter" — an engine-era session's log may still contain a
    // task_updated row (the engine wrote its own), but that history is not the Winter task graph
    // and must not be folded by readWinterTasks; the fallback (empty, no TaskStore wired) stands.
    const table = tableWith({ live: new Set(), recordedLeg: new Map([[sessionId, "engine"]]) });
    const { server, c } = await boot(table, store, home);
    try {
      const res = await c.request(METHODS.taskList, { sessionId });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, tasks: [] });
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });
});
