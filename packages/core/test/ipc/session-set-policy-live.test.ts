// `session.setPolicy` REPORTS a live child's refusal, and never leaves the store ahead of the child.
//
// The handler used to be fire-and-forget on the leg: it wrote the `approval_policy` column, called
// `winter.get(sessionId)?.setPolicy(policy)` without awaiting, logged a rejection to the daemon log
// and answered `{ ok: true }` regardless. That was survivable only while the official leg's own
// `setPolicy` was a documented no-op. Now that BOTH legs tell a running child through
// `Query.setPermissionMode`, a refusal is real — the router refuses a mode this branch may not offer,
// and a child can be gone — and the consequences of swallowing it are user-visible: the Mac's picker
// adopts the new mode unless the RPC errors, so the session would display `ask` while its child went
// on auto-approving edits in the mode it was spawned with.
//
// Both halves are asserted here, because either alone is a lie:
//   * the RPC FAILS, so the picker shows "Couldn't switch to X — try again";
//   * the store is PUT BACK, so the next `session.list` agrees with the child rather than with the
//     request that failed. A stored `ask` over a child in `accept-edits` is worse than either end
//     state: this session's own gate would start denying calls the child never asks about.
//
// One fake driver table, both legs: `WinterSessionDrivers.get` is leg-agnostic (it answers with
// whichever `LegSession` a session is running on), which is exactly why one change here fixes both.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import type { WinterSessionDrivers, LegSession } from "../../src/runtime-sdk/session-driver";

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

/** A driver table with one live session, whose `setPolicy` records — or refuses. */
function fakeTable(opts: { told: SessionApprovalPolicy[]; refuse?: string; present?: boolean }): WinterSessionDrivers {
  const never = (): never => { throw new Error("not reached by this test"); };
  const session: LegSession = {
    sessionId: "s1", backendSessionId: "be-1", mode: "code", state: "live", generation: 1, resumed: false,
    init: undefined, turnRunning: false, turnStartedAt: undefined, done: Promise.resolve(),
    pendingSends: [], heldDeliveries: [],
    send: never, steer: never, interrupt: never, compact: never, setModel: never,
    setPolicy: async (policy) => {
      if (opts.refuse !== undefined) throw new Error(opts.refuse);
      opts.told.push(policy);
    },
    end: async () => {}, deliver: never, open: async () => {}, idle: async () => {},
  };
  return {
    legForNewSession: () => "winter",
    legOf: () => "winter",
    assertAvailable: () => {},
    create: async () => never(),
    get: () => (opts.present === false ? undefined : session),
    runTurn: async () => never(),
    ensure: async () => session,
    evict: async () => {},
    list: () => [],
    endAll: async () => {},
  };
}

async function boot(winter: WinterSessionDrivers): Promise<{ store: SessionStore; client: TestClient; stop: () => void }> {
  const home = mkdtempSync(join(tmpdir(), "winter-set-policy-live-"));
  const store = new SessionStore(home);
  const socketPath = join(home, "core.sock");
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  const tokens = await authority.ensureTokens();
  const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winter });
  const client = await TestClient.connect(socketPath);
  await client.hello(tokens.harness, "mac");
  return { store, client, stop: () => { client.close(); server.stop(); store.close(); } };
}

describe("session.setPolicy — the live child decides whether the change happened", () => {
  test("a live child is told, and the store carries the new policy", async () => {
    const told: SessionApprovalPolicy[] = [];
    const { store, client, stop } = await boot(fakeTable({ told }));
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "accept-edits" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "ask" });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true });
      // AWAITED, not fire-and-forget: the answer arrives only once the child has taken it.
      expect(told).toEqual(["ask"]);
      expect(store.meta(sessionId).approvalPolicy).toBe("ask");
    } finally {
      stop();
    }
  });

  test("a child that refuses makes the RPC fail AND puts the stored policy back", async () => {
    const told: SessionApprovalPolicy[] = [];
    const { store, client, stop } = await boot(fakeTable({ told, refuse: "the runtime refused the control request" }));
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "accept-edits" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "ask" });
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(String(res.error.message)).toMatch(/refused the approval-mode change/);
      // THE REVERT. Without it the session would display and enforce `ask` while its child stayed in
      // `accept-edits` — a UI told "it failed" by a surface whose next read says it succeeded.
      expect(store.meta(sessionId).approvalPolicy).toBe("accept-edits");
      expect(told).toEqual([]);
    } finally {
      stop();
    }
  });

  test("a session with no live child still succeeds — the next incarnation reads the store", async () => {
    const told: SessionApprovalPolicy[] = [];
    const { store, client, stop } = await boot(fakeTable({ told, present: false }));
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "ask" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "plan" });
      expect(res.result).toEqual({ ok: true });
      expect(store.meta(sessionId).approvalPolicy).toBe("plan");
      expect(told).toEqual([]);
    } finally {
      stop();
    }
  });

  test("an unknown session is still NOT_FOUND — the pre-read of the old policy never shadows that", async () => {
    const told: SessionApprovalPolicy[] = [];
    const { client, stop } = await boot(fakeTable({ told }));
    try {
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId: "s_nope", policy: "ask" });
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32004);
      expect(told).toEqual([]);
    } finally {
      stop();
    }
  });
});
