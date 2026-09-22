// `session.setPolicy` ACROSS THE BYPASS BOUNDARY on a live Winter-leg child re-incarnates it.
//
// A Winter child is spawned with `permissions.disableBypassPermissionsMode: policy !== "bypass"` and
// `allowDangerouslySkipPermissions` only under bypass (`mode-options.ts`'s `buildWinterOptions`) — a
// deliberate clamp against an agent DEFINITION minting its own bypass. Both are SPAWN-TIME facts, so a
// live `Query.setPermissionMode("bypassPermissions")` on a child spawned under any other policy is
// refused by the runtime ("bypassPermissions is disabled by managed configuration"), and the RPC used
// to fail and revert: the dist log carried that refusal x19 for one TUI session and once for a Mac
// session 3 s after creation, which then silently ran as `auto`.
//
// The fix mirrors a credential write (`evictSessionsForCredential`): the child is replaced RESUMABLY
// (the table's `evict`), at once when idle and at the next idle boundary when a turn is running, and
// the next incarnation's `optionsFor` reads the stored policy — so the clamp and the mode follow it.
// Leaving bypass does the same (the clamp must come back), and additionally tells the live child at
// once: a running turn in `bypassPermissions` never consults `canUseTool`, so waiting for the boundary
// alone would let the rest of that turn keep auto-approving after the user switched it off.
//
// Everything that does NOT cross the boundary keeps today's live `setPermissionMode` path (the sibling
// `session-set-policy-live.test.ts` pins it), and the official leg keeps it too: its bypass maps to
// `acceptEdits` (`officialPermissionModeFor`), which a live child accepts, so it has no refusal class.
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
import type { SessionLeg } from "../../src/runtime-sdk/leg";

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

interface Harness {
  table: WinterSessionDrivers;
  /** Every live `setPolicy` the child was told, in order. */
  told: SessionApprovalPolicy[];
  /** Every session id the table evicted, in order. */
  evicted: string[];
  /** Resolve the running turn's idle boundary (a no-op when no turn is running). */
  finishTurn(): void;
  /** End the child's incarnation WITHOUT an idle boundary (a crash; `idle()` never settles). */
  endIncarnation(): void;
}

/**
 * One live session on a configurable leg. `turnRunning` makes `idle()` wait for `finishTurn()`; the
 * child REFUSES a live switch into `bypass` exactly as the Winter runtime does when its spawn-time
 * clamp is on (`refuseBypass`, default true), and `evict` forgets the driver, as the real table does.
 */
function harness(opts: { leg?: SessionLeg; turnRunning?: boolean; refuseBypass?: boolean; refuseLeavingBypass?: boolean } = {}): Harness {
  const never = (): never => { throw new Error("not reached by this test"); };
  const told: SessionApprovalPolicy[] = [];
  const evicted: string[] = [];
  let release: () => void = () => {};
  const idle = opts.turnRunning === true ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
  // A LIVE child's incarnation has not ended: `done` stays pending until `endIncarnation()`.
  let endInc: () => void = () => {};
  const done = new Promise<void>((r) => { endInc = r; });
  let present = true;
  const session: LegSession = {
    sessionId: "s1", backendSessionId: "be-1", mode: "code", state: "live", generation: 1, resumed: false,
    init: undefined, turnRunning: opts.turnRunning === true, turnStartedAt: undefined, done,
    pendingSends: [], heldDeliveries: [],
    send: never, steer: never, interrupt: never, compact: never, setModel: never,
    setPolicy: async (policy) => {
      if (policy === "bypass" && (opts.leg ?? "winter") === "winter" && opts.refuseBypass !== false) {
        throw new Error("bypassPermissions is disabled by managed configuration (permissions.disableBypassPermissionsMode)");
      }
      if (policy !== "bypass" && opts.refuseLeavingBypass === true) throw new Error("the control request was refused");
      told.push(policy);
    },
    end: async () => {}, deliver: never, open: async () => {}, idle: () => idle,
  };
  const table: WinterSessionDrivers = {
    legForNewSession: () => opts.leg ?? "winter",
    legOf: () => opts.leg ?? "winter",
    assertAvailable: () => {},
    create: async () => never(),
    get: () => (present ? session : undefined),
    runTurn: async () => never(),
    ensure: async () => session,
    evict: async (sessionId) => { evicted.push(sessionId); present = false; },
    list: () => (present ? [session] : []),
    endAll: async () => {},
  };
  return { table, told, evicted, finishTurn: () => release(), endIncarnation: () => { endInc(); present = false; } };
}

async function boot(winter: WinterSessionDrivers): Promise<{ store: SessionStore; client: TestClient; stop: () => void }> {
  const home = mkdtempSync(join(tmpdir(), "winter-set-policy-bypass-"));
  const store = new SessionStore(home);
  const socketPath = join(home, "core.sock");
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  const tokens = await authority.ensureTokens();
  const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winter });
  const client = await TestClient.connect(socketPath);
  await client.hello(tokens.harness, "mac");
  return { store, client, stop: () => { client.close(); server.stop(); store.close(); } };
}

/** Let a scheduled `idle().then(...)` continuation run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("session.setPolicy across the bypass boundary — the Winter child is replaced, never refused", () => {
  test("INTO bypass on an idle child: succeeds, stores bypass, replaces the child, never asks it to switch", async () => {
    const h = harness();
    const { store, client, stop } = await boot(h.table);
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "auto" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "bypass" });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, replaced: "now" });
      expect(store.meta(sessionId).approvalPolicy).toBe("bypass");
      // Replaced NOW (idle), so the very next send spawns a child whose clamp is off.
      expect(h.evicted).toEqual([sessionId]);
      // The live switch is the call the runtime refuses by construction — it is not attempted.
      expect(h.told).toEqual([]);
    } finally {
      stop();
    }
  });

  test("OUT of bypass on an idle child: the child is told at once AND replaced, so the clamp comes back", async () => {
    const h = harness();
    const { store, client, stop } = await boot(h.table);
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "bypass" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "ask" });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ ok: true, replaced: "now" });
      expect(store.meta(sessionId).approvalPolicy).toBe("ask");
      expect(h.told).toEqual(["ask"]);
      expect(h.evicted).toEqual([sessionId]);
    } finally {
      stop();
    }
  });

  test("INTO bypass MID-TURN: answers at once, and the child is replaced only at the idle boundary", async () => {
    const h = harness({ turnRunning: true });
    const { store, client, stop } = await boot(h.table);
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "ask" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "bypass" });
      expect(res.result).toEqual({ ok: true, replaced: "at-idle" });
      expect(store.meta(sessionId).approvalPolicy).toBe("bypass");
      // A running turn is never cut.
      await settle();
      expect(h.evicted).toEqual([]);
      h.finishTurn();
      await settle();
      expect(h.evicted).toEqual([sessionId]);
      expect(h.told).toEqual([]);
    } finally {
      stop();
    }
  });

  test("OUT of bypass MID-TURN: the running turn stops auto-approving NOW; the clamp returns at the boundary", async () => {
    const h = harness({ turnRunning: true });
    const { store, client, stop } = await boot(h.table);
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "bypass" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "accept-edits" });
      expect(res.result).toEqual({ ok: true, replaced: "at-idle" });
      expect(h.told).toEqual(["accept-edits"]);
      await settle();
      expect(h.evicted).toEqual([]);
      h.finishTurn();
      await settle();
      expect(h.evicted).toEqual([sessionId]);
    } finally {
      stop();
    }
  });

  test("a MID-TURN crossing the user takes back before the boundary replaces nothing", async () => {
    const h = harness({ turnRunning: true });
    const { store, client, stop } = await boot(h.table);
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "ask" });
      expect((await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "bypass" })).result).toEqual({ ok: true, replaced: "at-idle" });
      // Back across before the turn ends: the child was spawned under `ask`, so its clamp is already
      // the right one — this is an ordinary live change, and the boundary finds nothing to do.
      expect((await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "auto" })).result).toEqual({ ok: true });
      expect(h.told).toEqual(["auto"]);
      h.finishTurn();
      await settle();
      expect(h.evicted).toEqual([]);
      expect(store.meta(sessionId).approvalPolicy).toBe("auto");
    } finally {
      stop();
    }
  });

  // Review M4 (2026-09-23): a running child that refuses to LEAVE bypass keeps auto-approving until the
  // boundary — the user is told so in the result, not just the log.
  test("M4: a mid-turn refusal to leave bypass is surfaced in the result; the store and the boundary replacement still apply", async () => {
    const h = harness({ turnRunning: true, refuseLeavingBypass: true });
    const { store, client, stop } = await boot(h.table);
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "bypass" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "ask" });
      expect(res.result).toMatchObject({ ok: true, replaced: "at-idle" });
      expect(String(res.result.warning)).toContain("still bypassing");
      expect(store.meta(sessionId).approvalPolicy).toBe("ask");
      h.finishTurn();
      await settle();
      expect(h.evicted).toEqual([sessionId]);
    } finally {
      stop();
    }
  });

  test("M4: a child whose incarnation ends without an idle boundary drops the pending replacement (nothing left to replace)", async () => {
    const h = harness({ turnRunning: true });
    const { store, client, stop } = await boot(h.table);
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "ask" });
      expect((await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "bypass" })).result).toEqual({ ok: true, replaced: "at-idle" });
      h.endIncarnation();
      await settle();
      expect(h.evicted).toEqual([]);
      // A later change is judged against the stored policy again, not the dead child's spawn policy.
      expect((await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "auto" })).result).toEqual({ ok: true });
    } finally {
      stop();
    }
  });

  test("a change that does NOT cross the boundary keeps the live path and replaces nothing", async () => {
    const h = harness();
    const { store, client, stop } = await boot(h.table);
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "ask" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "accept-edits" });
      expect(res.result).toEqual({ ok: true });
      expect(h.told).toEqual(["accept-edits"]);
      expect(h.evicted).toEqual([]);
    } finally {
      stop();
    }
  });

  test("the OFFICIAL leg keeps its live switch (bypass is acceptEdits there, which a child accepts) and is not replaced", async () => {
    const h = harness({ leg: "official" });
    const { store, client, stop } = await boot(h.table);
    try {
      const sessionId = store.createSession("global", { mode: "code", approvalPolicy: "ask" });
      const res = await client.request(METHODS.sessionSetPolicy, { sessionId, policy: "bypass" });
      expect(res.result).toEqual({ ok: true });
      expect(h.told).toEqual(["bypass"]);
      expect(h.evicted).toEqual([]);
      expect(store.meta(sessionId).approvalPolicy).toBe("bypass");
    } finally {
      stop();
    }
  });
});
