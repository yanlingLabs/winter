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
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { PlanSwitchOutcome } from "../../src/runtime-sdk/handoff";
import type { RuntimeSessionRecord } from "../../src/runtime-state/records";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";

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
 * Winter Phase 10b (D1 fix round 3, INVARIANT 1c): the 8a record door `session.setModel`'s new
 * guard reads. OPTIONAL, and absent for every pre-round-3 case above — a daemon whose runtime spine
 * is offline wires no `records` at all, and the guard is inert there by design, so the existing
 * table keeps proving exactly what it always did.
 */
async function boot(store: SessionStore, home: string, outcome: PlanSwitchOutcome, records?: { get: (id: string) => RuntimeSessionRecord | undefined }) {
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  const tokens = await authority.ensureTokens();
  const socketPath = join(home, "core.sock");
  const server = startIpcServer({
    socketPath, serverVersion: "test", tokens: authority, store,
    handoff: { planAndApplySwitch: async () => outcome },
    ...(records === undefined ? {} : { records }),
  });
  const c = await TestClient.connect(socketPath);
  await c.hello(tokens.harness, "mac");
  return { server, c };
}

const cases: Array<{ name: string; outcome: PlanSwitchOutcome; expectWrite: boolean; expectedCode?: string }> = [
  { name: "same-runtime", outcome: { kind: "same-runtime" }, expectWrite: true },
  { name: "resumed", outcome: { kind: "resumed", selection: { runtimeKind: "claude-agent", providerId: "p", modelRef: "m", family: "f", authFamily: "api-key", sdkVersion: "x", reason: "r", decidedAt: "t" } }, expectWrite: true },
  { name: "refused", outcome: { kind: "refused", code: "runtime_selection_refused", detail: "no credential" }, expectWrite: false, expectedCode: "runtime_selection_refused" },
  { name: "confirmation_required", outcome: { kind: "confirmation_required", warnings: ["lossy"], portable: ["deepseek"] }, expectWrite: false, expectedCode: "handoff_confirmation_required" },
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

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Winter Phase 10b (D1 fix round 3) — THE 1c INVARIANT.
  //
  // `session.setModel` may report success / write `meta.model` ONLY when the durable 8a record's
  // `runtimeKind`/`selection` — what `session-driver.ts`'s `resume()` and `resumeOfficial()`
  // actually route on — now name the requested model's leg and selection. The round-2 CRITICAL was
  // exactly this disagreement: a `same-runtime` outcome for a cross-leg move wrote `meta.model`
  // while the record kept naming the source leg, so `session.list` showed the new model and every
  // future turn ran the old one, silently and forever.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  const SEL = (kind: "winter-agent" | "claude-agent", providerId: string, modelRef: string): RuntimeSelection => ({
    runtimeKind: kind, providerId, modelRef, family: "f", authFamily: "api-key",
    sdkVersion: "x", reason: "r", decidedAt: "t",
  });
  const recordNaming = (kind: "winter-agent" | "claude-agent", providerId: string, modelRef: string): RuntimeSessionRecord =>
    ({ runtimeKind: kind, providerId, modelRef, selection: SEL(kind, providerId, modelRef) } as RuntimeSessionRecord);

  for (const arm of [
    { name: "same-runtime", outcome: (want: RuntimeSelection): PlanSwitchOutcome => ({ kind: "same-runtime", decided: want }) },
    { name: "resumed", outcome: (want: RuntimeSelection): PlanSwitchOutcome => ({ kind: "resumed", selection: want }) },
  ]) {
    test(`1c: ${arm.name} whose record DISAGREES is blocked, and meta.model is left untouched`, async () => {
      const home = mkdtempSync(join(tmpdir(), `winter-setmodel-invariant-${arm.name}-`));
      const store = new SessionStore(home);
      const sessionId = store.createSession("global");
      // The record still names the SOURCE leg — precisely the state a "not in the runtime
      // directory" silent apply used to leave behind.
      const { server, c } = await boot(store, home, arm.outcome(SEL("claude-agent", "anthropic", "claude-sonnet-5")), {
        get: () => recordNaming("winter-agent", "openai", "openai/gpt-5.6-sol"),
      });
      try {
        const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/sonnet", confirmLossy: true });
        expect(res.error).toBeDefined();
        expect(res.error.data?.code).toBe("handoff_blocked");
        // The neutral copy (M1): never the record's own contents, never a runtime name.
        expect(res.error.message).toContain("Couldn't finish switching models");
        expect(res.error.message).not.toMatch(/\bruntime\b/i);
        expect(store.meta(sessionId).model).toBeUndefined();
      } finally {
        c.close();
        server.stop();
        store.close();
      }
    });

    test(`1c: ${arm.name} whose record AGREES still writes the model (the guard is not a blanket refusal)`, async () => {
      const home = mkdtempSync(join(tmpdir(), `winter-setmodel-invariant-ok-${arm.name}-`));
      const store = new SessionStore(home);
      const sessionId = store.createSession("global");
      const want = SEL("claude-agent", "anthropic", "claude-sonnet-5");
      const { server, c } = await boot(store, home, arm.outcome(want), { get: () => recordNaming("claude-agent", "anthropic", "claude-sonnet-5") });
      try {
        const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/sonnet", confirmLossy: true });
        expect(res.error).toBeUndefined();
        expect(store.meta(sessionId).model).toBe("anthropic/sonnet");
      } finally {
        c.close();
        server.stop();
        store.close();
      }
    });
  }

  // A bare `same-runtime` — no `decided` — is one of `planAndApplySwitch`'s early bail-outs
  // (`model === null`, no record at all, an engine-era row, a `winter-test/*` double, an off-catalog
  // model). No leg decision ever ran, so there is nothing for a record to agree with and the guard
  // must stay out of the way: an ordinary in-runtime model change keeps working on a session whose
  // record names a different family entirely.
  test("1c: a same-runtime with NO decided selection is never guarded — the ordinary store write still runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-setmodel-invariant-bailout-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    const { server, c } = await boot(store, home, { kind: "same-runtime" }, { get: () => recordNaming("winter-agent", "openai", "openai/gpt-5.6-sol") });
    try {
      const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/sonnet", confirmLossy: true });
      expect(res.error).toBeUndefined();
      expect(store.meta(sessionId).model).toBe("anthropic/sonnet");
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  // A session the record store has never heard of (a record row that was deleted, or a spine that
  // lost it) is a DISAGREEMENT, not a pass: nothing proves the destination leg is recorded.
  test("1c: an absent record is treated as a disagreement, not a pass", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-setmodel-invariant-absent-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    const { server, c } = await boot(store, home, { kind: "same-runtime", decided: SEL("winter-agent", "openai", "openai/gpt-5.6-sol") }, { get: () => undefined });
    try {
      const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/sonnet", confirmLossy: true });
      expect(res.error).toBeDefined();
      expect(res.error.data?.code).toBe("handoff_blocked");
      expect(store.meta(sessionId).model).toBeUndefined();
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

  // Winter Phase 10b (D1-4/D1-6, W18-23): `portable` is additive in the error data — threaded
  // verbatim from `PlanSwitchOutcome.confirmation_required.portable` (D1-6 fills that from the
  // router's own `reviewSwitch` classification). Proved separately from the parameterized table
  // above with a NON-EMPTY value, so this pins real threading rather than two `[]`s matching by
  // coincidence.
  test("confirmation_required: error data carries portable verbatim from the outcome", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-setmodel-handoff-portable-"));
    const store = new SessionStore(home);
    const sessionId = store.createSession("global");
    const { server, c } = await boot(store, home, { kind: "confirmation_required", warnings: ["lossy"], portable: ["deepseek", "GLM"] });
    try {
      const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/sonnet" });
      expect(res.error).toBeDefined();
      expect(res.error.data?.code).toBe("handoff_confirmation_required");
      expect(res.error.data?.warnings).toEqual(["lossy"]);
      expect(res.error.data?.portable).toEqual(["deepseek", "GLM"]);
      // Never names an SDK or runtime (R-10b-4) — this outcome now also fires for a same-leg
      // family change, which never moves a runtime at all.
      expect(res.error.message).not.toMatch(/\bruntime\b/i);
    } finally {
      c.close();
      server.stop();
      store.close();
    }
  });

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

  // M1 (whole-branch review, fix round 2): `blocked` NEVER surfaces the raw `reason`/`detail` to
  // the user (either can name router/daemon internals) — the user copy is one neutral sentence
  // naming the session's CURRENT model, and `detail` (router 0.0.6's `revert-pending` reason)
  // goes to the daemon log only, as a CATEGORY, never raw text.
  describe("blocked: never surfaces the raw reason/detail to the user", () => {
    test("the error message is the neutral copy, naming the session's current model, never the raw reason", async () => {
      const home = mkdtempSync(join(tmpdir(), "winter-setmodel-handoff-blocked-copy-"));
      const store = new SessionStore(home);
      const sessionId = store.createSession("global");
      store.setModel(sessionId, "openai/gpt-5.6-sol"); // the session's CURRENT model, before this failed attempt
      const { server, c } = await boot(store, home, { kind: "blocked", reason: "revert-pending", detail: "the pending-revert note was written; this will self-converge" });
      try {
        const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-sonnet-5", confirmLossy: true });
        expect(res.error).toBeDefined();
        expect(res.error.data?.code).toBe("handoff_blocked");
        expect(res.error.message).toBe("Couldn't finish switching models; the session stays on openai/gpt-5.6-sol. Try again in a moment.");
        // Never the raw reason enum or any part of the router's own detail text.
        expect(res.error.message).not.toContain("revert-pending");
        expect(res.error.message).not.toContain("self-converge");
        expect(res.error.message).not.toMatch(/\bSDK\b|\brouter\b|Claude Agent|Winter Agent/i);
        // The model preference never applied — the source stays authoritative.
        expect(store.meta(sessionId).model).toBe("openai/gpt-5.6-sol");
      } finally {
        c.close();
        server.stop();
        store.close();
      }
    });

    test("the SAME neutral copy fires regardless of what detail says — self-converge or needing manual reconciliation", async () => {
      const home = mkdtempSync(join(tmpdir(), "winter-setmodel-handoff-blocked-copy2-"));
      const store = new SessionStore(home);
      const sessionId = store.createSession("global");
      store.setModel(sessionId, "openai/gpt-5.6-sol");
      const { server, c } = await boot(store, home, { kind: "blocked", reason: "revert-pending", detail: "the pending-revert note ALSO failed; this needs manual reconciliation" });
      try {
        const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-sonnet-5", confirmLossy: true });
        expect(res.error.message).toBe("Couldn't finish switching models; the session stays on openai/gpt-5.6-sol. Try again in a moment.");
        expect(res.error.message).not.toContain("manual reconciliation");
      } finally {
        c.close();
        server.stop();
        store.close();
      }
    });

    test("no current model on record: the copy falls back to \"the default model\", never a blank", async () => {
      const home = mkdtempSync(join(tmpdir(), "winter-setmodel-handoff-blocked-nodefault-"));
      const store = new SessionStore(home);
      const sessionId = store.createSession("global"); // no model ever set
      const { server, c } = await boot(store, home, { kind: "blocked", reason: "lease-held" });
      try {
        const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-sonnet-5", confirmLossy: true });
        expect(res.error.message).toBe("Couldn't finish switching models; the session stays on the default model. Try again in a moment.");
      } finally {
        c.close();
        server.stop();
        store.close();
      }
    });

    test("detail reaches the daemon log as a CATEGORY only — never its raw text", async () => {
      const home = mkdtempSync(join(tmpdir(), "winter-setmodel-handoff-blocked-log-"));
      const store = new SessionStore(home);
      const sessionId = store.createSession("global");
      store.setModel(sessionId, "openai/gpt-5.6-sol");
      const errSpy = spyOn(console, "error").mockImplementation(() => {});
      const { server, c } = await boot(store, home, { kind: "blocked", reason: "revert-pending", detail: "the pending-revert note was written; this will self-converge" });
      try {
        await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-sonnet-5", confirmLossy: true });
        const logged = errSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(logged).toContain("revert-pending"); // the reason enum — a safe, closed vocabulary
        expect(logged).toContain("self-converge"); // the DERIVED category, not raw prose
        expect(logged).not.toContain("the pending-revert note was written"); // never the raw sentence
      } finally {
        errSpy.mockRestore();
        c.close();
        server.stop();
        store.close();
      }
    });
  });
});
