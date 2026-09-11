// Winter Phase 8c (P8c-11, Task 2.3): task.list over the Winter leg reads the session's own
// persisted task_updated history (tasks-reader.ts), not the retired engine's in-process TaskStore.
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

/** A driver table whose `get` reports a live session for exactly the ids in `liveIds`. */
function tableWithLiveSessions(liveIds: Set<string>): WinterSessionDrivers {
  const never = (): never => { throw new Error("not reached by this test"); };
  return {
    legForNewSession: () => "winter",
    legOf: (sid) => (liveIds.has(sid) ? "winter" : undefined),
    assertAvailable: () => {},
    create: async () => ({}) as never,
    get: (sid) => (liveIds.has(sid) ? ({} as WinterSession) : undefined),
    runTurn: async () => never(),
    ensure: async () => undefined,
    evict: async () => {},
    list: () => [],
    endAll: async () => {},
  };
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
    const home = mkdtempSync(join(tmpdir(), "norma-task-list-live-"));
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
    const home = mkdtempSync(join(tmpdir(), "norma-task-list-cold-"));
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
});
