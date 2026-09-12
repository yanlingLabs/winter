// Winter Phase 8c (Task 4.1): `session.setModel`'s RPC-level wiring to `opts.handoff` — proved
// against a fake `planAndApplySwitch` hook (the decision matrix itself is
// `test/runtime-sdk/handoff.test.ts`'s). Confirms the store write is gated on the outcome: it runs
// for same-runtime/resumed, and never runs for a refusal/confirmation/lossy-fork/blocked.
//
// Winter Phase 8d fix round 1 (item 5): `deferred` moved OUT of the "writes" bucket into its own
// test below — Lane 2's handoff m5 change makes the deferred continuation commit the model
// preference itself, exactly once, when it settles to "resumed"; this RPC must reply success
// (never a refusal) but must NOT write `meta.model` now, or the continuation's later write would
// either double it or race a preference this RPC never actually applied.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@winter/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { PlanSwitchOutcome } from "../../src/runtime-sdk/handoff";

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

async function boot(store: SessionStore, home: string, outcome: PlanSwitchOutcome) {
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  const tokens = await authority.ensureTokens();
  const socketPath = join(home, "core.sock");
  const server = startIpcServer({
    socketPath, serverVersion: "test", tokens: authority, store,
    handoff: { planAndApplySwitch: async () => outcome },
  });
  const c = await TestClient.connect(socketPath);
  await c.hello(tokens.harness, "mac");
  return { server, c };
}

const cases: Array<{ name: string; outcome: PlanSwitchOutcome; expectWrite: boolean; expectedCode?: string }> = [
  { name: "same-runtime", outcome: { kind: "same-runtime" }, expectWrite: true },
  { name: "resumed", outcome: { kind: "resumed", selection: { runtimeKind: "claude-agent", providerId: "p", modelRef: "m", family: "f", authFamily: "api-key", sdkVersion: "x", reason: "r", decidedAt: "t" } }, expectWrite: true },
  { name: "refused", outcome: { kind: "refused", code: "runtime_selection_refused", detail: "no credential" }, expectWrite: false, expectedCode: "runtime_selection_refused" },
  { name: "confirmation_required", outcome: { kind: "confirmation_required", warnings: ["lossy"] }, expectWrite: false, expectedCode: "handoff_confirmation_required" },
  { name: "lossy_fork", outcome: { kind: "lossy_fork", reason: "cannot compare tails" }, expectWrite: false, expectedCode: "handoff_lossy_fork" },
  { name: "blocked", outcome: { kind: "blocked", reason: "lease held" }, expectWrite: false, expectedCode: "handoff_blocked" },
];

describe("session.setModel — the P8c-14 handoff outcome gate", () => {
  for (const c of cases) {
    test(`${c.name}: ${c.expectWrite ? "writes the model" : "refuses typed, writes nothing"}`, async () => {
      const home = mkdtempSync(join(tmpdir(), `winter-setmodel-handoff-${c.name}-`));
      const store = new SessionStore(home);
      const sessionId = store.createSession("global");
      const { server, client } = await (async () => {
        const b = await boot(store, home, c.outcome);
        return { server: b.server, client: b.c };
      })();
      try {
        const res = await client.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/sonnet", confirmLossy: true });
        if (c.expectWrite) {
          expect(res.error).toBeUndefined();
          expect(store.meta(sessionId).model).toBe("anthropic/sonnet");
        } else {
          expect(res.error).toBeDefined();
          expect(res.error.data?.code).toBe(c.expectedCode);
          expect(store.meta(sessionId).model).toBeUndefined();
        }
      } finally {
        client.close();
        server.stop();
        store.close();
      }
    });
  }

  // Fix round 1 (item 5): "deferred" is neither a refusal NOR an immediate write — the RPC
  // succeeds (a turn is running; the caller's model preference was accepted, not rejected) but
  // `meta.model` must stay exactly what it was before this call, because `planAndApplySwitch`'s
  // OWN deferred continuation is what commits it, once, when the turn settles to "resumed".
  test("deferred: succeeds with no error, but leaves meta.model UNCHANGED (the continuation commits it later)", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-setmodel-handoff-deferred-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    const { server, c } = await boot(store, home, { kind: "deferred" });
    try {
      const before = store.meta(sessionId).model;
      const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/sonnet", confirmLossy: true });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({});
      expect(store.meta(sessionId).model).toBe(before);
      expect(store.meta(sessionId).model).toBeUndefined();
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });
});
