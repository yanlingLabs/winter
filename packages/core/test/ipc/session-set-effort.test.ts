import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, SESSION_EFFORT_MAX_CHARS, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { clientEfforts, effortsForModel } from "../../src/ipc/sync";
import { REASONING_EFFORTS } from "../../src/settings";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// provider-correctness T4: per-session reasoning effort — session.setEffort {sessionId, effort:
// string|null} → {} (null clears), mode-agnostic exactly like session.setModel (and unlike
// session.setPolicy, which rejects chat outright). Its OWN method rather than a second argument on
// session.setModel: "effort and model are two different things, just like the CLI".
//
// Exercised over a bare IPC server (own SessionStore + TokenAuthority, no AgentEngine) — the same
// harness shape as session-set-model.test.ts, whose copy of TestClient this duplicates (this
// codebase's convention: no shared test-harness module, every test/ipc/*.test.ts carries its own).

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from session-set-model.test.ts. */
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
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            }
          }
        },
        drain(_s) {
          c.writer.onDrain();
        },
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

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("session.setEffort round-trip RPC (provider-correctness T4)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(opts: { liveModel?: () => string } = {}): Promise<{ store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-set-effort-rpc-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, liveModel: opts.liveModel });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  test("set → store.meta AND session.list both reflect the new effort", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "xhigh" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});

    expect(store.meta(sessionId).effort).toBe("xhigh");
    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.effort).toBe("xhigh");
    c.close();
  });

  test("a session created WITHOUT an effort has none in meta/list (control — it uses the global default)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    expect(store.meta(sessionId).effort).toBeUndefined();
    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.effort).toBeUndefined();
    c.close();
  });

  test("effort: null CLEARS a previously-set override", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");
    expect((await c.request(METHODS.sessionSetEffort, { sessionId, effort: "low" })).error).toBeUndefined();
    expect(store.meta(sessionId).effort).toBe("low");

    const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: null });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).effort).toBeUndefined();
    c.close();
  });

  test("idempotent: setting the same value twice both succeed and leave the same value", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    const first = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "high" });
    const second = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "high" });
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(store.meta(sessionId).effort).toBe("high");
    c.close();
  });

  test("clearing an already-clear session is idempotent too (null on a never-set session)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: null });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).effort).toBeUndefined();
    c.close();
  });

  test("unknown session → NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");

    const res = await c.request(METHODS.sessionSetEffort, { sessionId: "s_does_not_exist", effort: "high" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // Unknown session AND a clearing call: `null` skips validation entirely, so the store's own
  // throw is the only thing that can report the bad id — proving the NOT_FOUND path isn't an
  // accident of the validation branch happening to read meta() first.
  test("unknown session → NOT_FOUND even when CLEARING (the validation branch is skipped)", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");

    const res = await c.request(METHODS.sessionSetEffort, { sessionId: "s_does_not_exist", effort: null });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // Mode-agnostic, exactly like session.setModel: there is no "fixed effort" concept for any mode.
  test("works for a CHAT session", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });

    const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "medium" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).effort).toBe("medium");
    c.close();
  });

  test("works for a DISPATCH session too", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global", { mode: "dispatch", origin: "dispatch" });

    const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "medium" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).effort).toBe("medium");
    c.close();
  });

  // session.setEffort is REMOTE_ALLOWED_METHODS-listed (the phone's effort picker drives a
  // remote-driven session) — a remote caller can reach it for an eligible-mode session.
  test("a REMOTE caller may set the effort on a code session", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = store.createSession("global", { mode: "code" });

    const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "high" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).effort).toBe("high");
    c.close();
  });

  test("a REMOTE caller is refused against a cowork-shaped (Mac-local-only) session", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", sessionId]);

    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "high" });
    expect(res.error).toBeTruthy();
    expect(res.error.message).toMatch(/not available/i);
    c.close();
  });

  test("empty-string effort is rejected at the wire schema (INVALID_PARAMS)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.meta(sessionId).effort).toBeUndefined();
    c.close();
  });

  test("an absurdly long effort is refused at the wire schema, and never reaches the column", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "e".repeat(SESSION_EFFORT_MAX_CHARS + 1) });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.meta(sessionId).effort).toBeUndefined();
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // SET-TIME VALIDATION (mirrors session.setModel's, which was itself added after a review found
  // that an unvalidated model bricks every future turn SILENTLY). The API validates effort
  // PER-MODEL — `minimal` is refused with an `unsupported_value` naming the slug, by a different
  // layer than the global enum that refuses `ultra` — so the check is against the SESSION'S OWN
  // MODEL's effort list (`effortsForModel`), not a free-floating constant.
  // -------------------------------------------------------------------------------------------

  test("every effort the daemon ADVERTISES for a model is accepted for a session on that model", async () => {
    const { store, socketPath, harnessToken } = await boot({ liveModel: () => "gpt-5.6-sol" });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    for (const effort of effortsForModel("gpt-5.6-sol")) {
      const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort });
      expect(res.error).toBeUndefined();
      expect(store.meta(sessionId).effort).toBe(effort);
    }
    // The advertised set is the wire-valid one (settings.ts's REASONING_EFFORTS) — pinned here so
    // "accepts everything it advertises" can't degrade into "advertises nothing, accepts nothing".
    expect(effortsForModel("gpt-5.6-sol")).toEqual([...REASONING_EFFORTS]);
    c.close();
  });

  // SCOPE, stated precisely: this pins that none of these reaches the WIRE as an effort. `minimal`
  // is a real level the endpoint refuses per-model; `HIGH`/`turbo` are simply not levels.
  //
  // `ultra` USED TO BE IN THIS LIST and is deliberately no longer — provider-correctness T5 landed
  // the Norma-level tier the earlier note anticipated, so `ultra` is now ADMITTED here (for code
  // sessions) as a selector that is translated to `max` before any request is built, never by
  // adding it to `effortsForModel`. Its new truth — accepted for code, refused for chat/dispatch —
  // is pinned in its own describe block below; the other three must stay here.
  test("an effort OUTSIDE the model's list is refused with INVALID_PARAMS and never reaches the column", async () => {
    const { store, socketPath, harnessToken } = await boot({ liveModel: () => "gpt-5.6-sol" });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    for (const bogus of ["minimal", "HIGH", "turbo"]) {
      const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: bogus });
      expect(res.error).toBeTruthy();
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.message).toContain(bogus);
      expect(store.meta(sessionId).effort).toBeUndefined();
    }
    c.close();
  });

  // The validation is keyed off the SESSION's effective model (its own override when it has one,
  // otherwise the daemon's live default) — the same precedence `AgentEngine.resolveSel` applies.
  // Uniform today (`effortsForModel` returns the same list for every id), so this cannot yet
  // OBSERVE a divergence; it pins the wiring so the day a model's list diverges, the per-session
  // override — not the global default — is what the check reads.
  test("a session with its OWN model override is validated against THAT model's list", async () => {
    const { store, socketPath, harnessToken } = await boot({ liveModel: () => "gpt-5.6-sol" });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");
    store.setModel(sessionId, "gpt-5.6-luna");

    for (const effort of effortsForModel("gpt-5.6-luna")) {
      expect((await c.request(METHODS.sessionSetEffort, { sessionId, effort })).error).toBeUndefined();
    }
    const refused = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "minimal" });
    expect(refused.error.code).toBe(ERR.INVALID_PARAMS);
    expect(refused.error.message).toContain("gpt-5.6-luna");
    c.close();
  });

  // A daemon with no provider at all (no liveModel wired — most test harnesses, and a real daemon
  // started with agentProvider: null) still validates: there is no model to name, but the effort
  // set is not empty, so a bogus value is still refused rather than silently stored.
  //
  // T5 note: the bogus value here used to be `ultra`, which is now an ACCEPTED tier on a code
  // session — so it stopped being a witness for this claim. `minimal` replaces it and is a strictly
  // better one: it is a real level the endpoint refuses per-model, i.e. exactly the kind of value
  // this "still validated with no provider" branch exists to catch.
  test("with NO provider configured the effort is still validated (a bogus value never reaches the column)", async () => {
    const { store, socketPath, harnessToken } = await boot(); // no liveModel
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    expect((await c.request(METHODS.sessionSetEffort, { sessionId, effort: "high" })).error).toBeUndefined();
    const refused = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "minimal" });
    expect(refused.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.meta(sessionId).effort).toBe("high"); // the refused call left the previous value alone
    c.close();
  });
});

// The column itself: an additive index-only migration, the SAME pattern as `model` (store.ts).
// `model` never carried a store-level test of its own — its coverage is the RPC + engine paths —
// but the one property those cannot show is that the value SURVIVES a reopen, which is also what
// proves the ADD COLUMN loop is idempotent on a database that already has it.
describe("store.setEffort: the effort column is durable and its migration is idempotent", () => {
  test("an effort set on one SessionStore instance is still there after close + reopen", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-effort-column-"));
    const first = new SessionStore(home);
    const sessionId = first.createSession("global");
    first.setEffort(sessionId, "xhigh");
    expect(first.meta(sessionId).effort).toBe("xhigh");
    first.close();

    // Reopening re-runs the ALTER TABLE loop against a database that ALREADY has the column — the
    // "duplicate column" case the constructor swallows. A regression there throws right here.
    const second = new SessionStore(home);
    expect(second.meta(sessionId).effort).toBe("xhigh");
    expect(second.list().find((r) => r.sessionId === sessionId)?.effort).toBe("xhigh");
    second.close();
  });
});

// ================================================================================================
// provider-correctness T5 — `ultra`, a NORMA-LEVEL tier admitted at THIS handler.
//
// This is the door, and the FIRST of the tier's two enforcements (the second is `resolveSel`, which
// keeps a tier that got in some other way — a fork, a hand-edited index — inert on a non-code
// session; engine-live-model.test.ts pins that half at the request layer).
//
// The tier is admitted here rather than inside `effortsForModel` on purpose: that function is the
// single source for BOTH what `sync.config` advertises per model AND what this handler accepts as a
// WIRE effort, and a tier inside it would make the daemon advertise a level its own request would
// be 400'd on. `ultra` is instead advertised through `sync.config`'s separate `clientEfforts`.
// ================================================================================================
describe("session.setEffort admits the ultra tier for CODE sessions only (provider-correctness T5)", () => {
  let stop2: (() => void) | undefined;
  afterEach(() => { stop2?.(); stop2 = undefined; });

  async function boot2(opts: { liveModel?: () => string } = {}) {
    const home = mkdtempSync(join(tmpdir(), "norma-set-effort-ultra-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, liveModel: opts.liveModel });
    stop2 = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness };
  }

  test("a CODE session accepts `ultra`, and the STORE keeps `ultra` — never silently rewritten to max", async () => {
    // The stored value is the user's SELECTION, not a wire value. Rewriting it to `max` at set time
    // would make every picker unable to show what they actually chose, and would erase the tier's
    // prompt half on the very next turn (resolveSel keys the injection off the tier, not off max).
    const { store, socketPath, harnessToken } = await boot2({ liveModel: () => "gpt-5.6-sol" });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");

    for (const sessionId of [store.createSession("global"), store.createSession("global", { mode: "code" })]) {
      const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "ultra" });
      expect(res.error).toBeUndefined();
      expect(store.meta(sessionId).effort).toBe("ultra");
    }
    c.close();
  });

  for (const mode of ["chat", "dispatch"] as const) {
    test(`a ${mode.toUpperCase()} session REFUSES \`ultra\` with the same INVALID_PARAMS shape, and the column stays empty`, async () => {
      const { store, socketPath, harnessToken } = await boot2({ liveModel: () => "gpt-5.6-sol" });
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "effort-setter");
      const sessionId = store.createSession("global", { mode });

      const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort: "ultra" });
      expect(res.error).toBeTruthy();
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.message).toContain("ultra");
      expect(store.meta(sessionId).effort).toBeUndefined();

      // ...and the refusal is scoped to the TIER: the same session still takes every WIRE effort,
      // so this is not "chat/dispatch cannot set an effort".
      for (const effort of effortsForModel("gpt-5.6-sol")) {
        expect((await c.request(METHODS.sessionSetEffort, { sessionId, effort })).error).toBeUndefined();
        expect(store.meta(sessionId).effort).toBe(effort);
      }
      c.close();
    });
  }

  test("the tier is NOT routed through effortsForModel — an unenumerable model still accepts it", async () => {
    // `effortsForModel` describes what the ENDPOINT accepts; the tier never reaches the endpoint, so
    // the model is irrelevant to it. This also pins that the two checks are alternatives, not layers:
    // if the tier were run through the wire check it would be refused by every model.
    const { store, socketPath, harnessToken } = await boot2({ liveModel: () => "" });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");
    store.setModel(sessionId, "unknown-vendor/byo-model-x");

    expect((await c.request(METHODS.sessionSetEffort, { sessionId, effort: "ultra" })).error).toBeUndefined();
    expect(store.meta(sessionId).effort).toBe("ultra");
    c.close();
  });

  test("`ultra` on an UNKNOWN session is still NOT_FOUND — the store stays the single source of that error", async () => {
    const { socketPath, harnessToken } = await boot2({ liveModel: () => "gpt-5.6-sol" });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");

    const res = await c.request(METHODS.sessionSetEffort, { sessionId: "s_nosuchsession", effort: "ultra" });
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("clearing works the same for a tier as for a wire effort", async () => {
    const { store, socketPath, harnessToken } = await boot2({ liveModel: () => "gpt-5.6-sol" });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    expect((await c.request(METHODS.sessionSetEffort, { sessionId, effort: "ultra" })).error).toBeUndefined();
    expect((await c.request(METHODS.sessionSetEffort, { sessionId, effort: null })).error).toBeUndefined();
    expect(store.meta(sessionId).effort).toBeUndefined();
    c.close();
  });

  // The advertise/accept identity, restated for the tier half. `sync.config` serves TWO lists and
  // this handler must accept the union of them for a code session — a level a picker can show but
  // the daemon refuses is the failure mode this whole plan exists to remove.
  test("every level sync.config advertises — wire efforts AND client tiers — is accepted on a code session", async () => {
    const { store, socketPath, harnessToken } = await boot2({ liveModel: () => "gpt-5.6-sol" });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "effort-setter");
    const sessionId = store.createSession("global");

    for (const effort of [...effortsForModel("gpt-5.6-sol"), ...clientEfforts()]) {
      const res = await c.request(METHODS.sessionSetEffort, { sessionId, effort });
      expect(res.error).toBeUndefined();
      expect(store.meta(sessionId).effort).toBe(effort);
    }
    c.close();
  });
});
