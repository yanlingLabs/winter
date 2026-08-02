import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, SESSION_MODEL_MAX_CHARS, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { ModelInfo } from "../../src/providers/types";

// Chat Slice D task 1: per-session model override — session.setModel {sessionId, model: string|null}
// → {} (null clears), mode-agnostic (works for code/dispatch/chat, unlike session.setPolicy which
// rejects chat outright). Exercised over a bare IPC server (own SessionStore + TokenAuthority, no
// AgentEngine) — same harness shape as session-dispatch.test.ts/remote-chat-gate.test.ts (this
// codebase's convention: no shared test-harness module, every test/ipc/*.test.ts carries its own copy).

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from session-dispatch.test.ts's copy. */
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

describe("session.setModel round-trip RPC (Chat Slice D task 1)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-set-model-rpc-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  test("set → store.meta AND session.list both reflect the new model", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});

    expect(store.meta(sessionId).model).toBe("claude-opus-5");
    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.model).toBe("claude-opus-5");
    c.close();
  });

  test("a session created WITHOUT a model has no model in meta/list (control)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global");

    expect(store.meta(sessionId).model).toBeUndefined();
    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.model).toBeUndefined();
    c.close();
  });

  test("model: null CLEARS a previously-set override", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global", { model: "claude-opus-5" });
    expect(store.meta(sessionId).model).toBe("claude-opus-5");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: null });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBeUndefined();
    c.close();
  });

  test("session.create with model stores it immediately (creation-time stamp)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");

    const created = await c.request(METHODS.sessionCreate, { scope: "global", model: "gpt-6" });
    expect(created.error).toBeUndefined();
    expect(store.meta(created.result.sessionId).model).toBe("gpt-6");
    c.close();
  });

  test("idempotent: setting the same value twice both succeed and leave the same value", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global");

    const first = await c.request(METHODS.sessionSetModel, { sessionId, model: "m1" });
    const second = await c.request(METHODS.sessionSetModel, { sessionId, model: "m1" });
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("m1");
    c.close();
  });

  test("unknown session → NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");

    const res = await c.request(METHODS.sessionSetModel, { sessionId: "s_does_not_exist", model: "m1" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // Mode-agnostic: session.setModel works for EVERY mode, unlike session.setPolicy (which rejects
  // chat outright and rejects "plan" for dispatch) — there is no equivalent restriction here.
  test("works for a CHAT session (contrast: session.setPolicy rejects every value for chat)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("claude-opus-5");
    c.close();
  });

  // session-activity-hygiene task 1: dispatch's model is a FIXED PIN (DISPATCH_MODEL, a user
  // ruling — the RESEARCH_MODEL precedent) — the door refuses a dispatch target OUTRIGHT, before
  // resolveModelSelection even runs. This replaces the old "works for a DISPATCH session too"
  // control (mode-agnosticism no longer holds for dispatch specifically; chat is unaffected, see
  // the test just above).
  test("refuses a DISPATCH target with INVALID_PARAMS naming the pin — the model is never stored", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global", { mode: "dispatch", origin: "dispatch" });

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("dispatch runs a fixed model");
    expect(res.error.message).toContain("gpt-5.6-terra");
    expect(res.error.message).toContain("medium");
    expect(store.meta(sessionId).model).toBeUndefined();
    c.close();
  });

  // Fix round 1 (reviewer finding): dispatch is a LONG-LIVED SINGLETON
  // (store.dispatchSessionId() reuses the same row forever), and BEFORE this task's commit both
  // doors were mode-agnostic — a stored override written during that era is a genuine historical
  // possibility, not a hypothetical. `session.list` reports the raw stored `model` column
  // VERBATIM (store.ts's `list()`), independent of `resolveSel` — so refusing the clear
  // unconditionally would make a pre-pin override PERMANENTLY un-clearable while displaying as
  // truth forever (zero runtime effect, since resolveSel's short-circuit wins regardless — but a
  // real display/data-hygiene defect). `model: null` therefore SUCCEEDS even against a dispatch
  // target; only a non-null SET is refused (the test just above).
  test("model: null SUCCEEDS as a clear even against a DISPATCH target — only a non-null set is refused", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global", { mode: "dispatch", origin: "dispatch" });

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: null });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBeUndefined();
    c.close();
  });

  // The historical-override scenario itself, end to end: a stored override from BEFORE this
  // task's pin shipped (simulated here by writing it directly via `store.setModel`, bypassing the
  // RPC door entirely — exactly how such a row would have gotten there pre-fix) is removable by
  // the null-clear above, and `session.list` — which reads the raw column, never `resolveSel` —
  // stops reporting it the moment it's cleared.
  test("a PRE-PIN stored override on a dispatch session is clearable, and session.list stops reporting it once cleared", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global", { mode: "dispatch", origin: "dispatch" });
    store.setModel(sessionId, "pre-pin-legacy-override"); // simulates a row written before this fix existed

    const listedBefore = await c.request(METHODS.sessionList, {});
    expect(listedBefore.result.sessions.find((s: any) => s.sessionId === sessionId).model).toBe("pre-pin-legacy-override");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: null });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBeUndefined();

    const listedAfter = await c.request(METHODS.sessionList, {});
    expect(listedAfter.result.sessions.find((s: any) => s.sessionId === sessionId).model).toBeUndefined();
    c.close();
  });

  // Unknown session id must still win with NOT_FOUND — the dispatch-pin refusal must never fire for
  // an id that doesn't resolve to a real session (mirrors session.setPolicy's own precedent, whose
  // targetMode try/catch idiom this reuses).
  test("an UNKNOWN session id is still NOT_FOUND, not the dispatch-pin refusal", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");

    const res = await c.request(METHODS.sessionSetModel, { sessionId: "s_does_not_exist", model: "claude-opus-5" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // session.setModel is REMOTE_ALLOWED_METHODS-listed (the phone sets models on remote-driven code
  // sessions) — a remote caller can reach it for an eligible-mode session.
  test("a REMOTE caller may set the model on a code session", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = store.createSession("global", { mode: "code" });

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("claude-opus-5");
    c.close();
  });

  // The assertRemoteMayUseSession gate generalizes to this method too (server.ts's own doc
  // comment) — a Mac-local-only mode stays refused for remote. remote-chat-gate.test.ts carries
  // the full parametrized proof across every REMOTE_ALLOWED_METHODS bare-sessionId method
  // (including session.setModel, added there alongside this task); this is a focused smoke test.
  test("a REMOTE caller is refused against a cowork-shaped (Mac-local-only) session", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", sessionId]);

    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(res.error).toBeTruthy();
    expect(res.error.message).toMatch(/not available/i);
    c.close();
  });

  test("empty-string model is rejected at the wire schema (INVALID_PARAMS)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  // T1 review M2, landed in the whole-branch fix round. `model` rides every `session.list` and
  // `sync.heads` row, both UNPAGED, and a provider that cannot enumerate its catalogue stores
  // whatever slug it is handed (deliberately — BYO endpoints). Without a schema bound, one remote
  // call could park a multi-megabyte value in the column and every later list response would then
  // exceed the phone transport's frame limit, permanently. Same class as the title cap next door.
  test("an absurdly long model is refused at the wire schema, and never reaches the column", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = store.createSession("global", { mode: "code" });

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "m".repeat(SESSION_MODEL_MAX_CHARS + 1) });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.meta(sessionId).model).toBeUndefined();

    // Control: a realistic slug (and one right AT the bound) still passes — the cap is far above
    // every real model id, so no existing caller changes behavior.
    const atCap = "m".repeat(SESSION_MODEL_MAX_CHARS);
    expect((await c.request(METHODS.sessionSetModel, { sessionId, model: atCap })).error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe(atCap);
    c.close();
  });
});

/** The `session.setModel`/`sync.push`/`sync.config` catalogue shape — same fake used by
 *  sync-push-effort.test.ts/sync-config.test.ts, and the SAME production ids
 *  (providers/codex-config.ts's CODEX_MODELS) so an alias like "sol" resolves the way it really
 *  would in production. */
function fakeEngine(models: ModelInfo[]): any {
  return { knownModels: () => models, isRunning: () => false };
}

const CATALOGUE: ModelInfo[] = [
  { id: "gpt-5.6-sol", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-terra", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-luna", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
];

// ================================================================================================
// followups batch T2: `session.create`'s OWN `model` was never validated — unlike `session.setModel`
// above (already alias-resolving + membership-checking since Chat Slice D task 1), a bogus model
// handed to `session.create` was stored VERBATIM and bricked every subsequent turn on that session
// (each one 400s against the provider, with nothing pointing back at create), and an alias like
// "sol" never matched the catalogue's canonical "gpt-5.6-sol" — which ALSO makes that session's
// effort menu render wire-empty on the Mac (the picker matches `row.model` against catalogue ids).
// Fixed with the SAME idiom `session.setModel` already applies (now a shared helper so the two
// surfaces cannot drift): resolve aliases, refuse membership only when the catalogue can enumerate
// (`known.length > 0` — a BYO endpoint that cannot enumerate is never bricked).
// ================================================================================================
describe("session.create validates model exactly like session.setModel (followups T2)", () => {
  let stop2: (() => void) | undefined;
  afterEach(() => { stop2?.(); stop2 = undefined; });

  async function boot2(models: ModelInfo[]): Promise<{ store: SessionStore; socketPath: string; harnessToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-create-model-rpc-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, engine: fakeEngine(models), hub: new SessionHub(store) });
    stop2 = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness };
  }

  test("a garbage model is REFUSED at create when the catalogue can enumerate — the brick, closed", async () => {
    const { store, socketPath, harnessToken } = await boot2(CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "garbage" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("garbage");
    // Refused BEFORE the row exists, same precedent as the effort refusal (T6) just above in the
    // sibling suite — a bricked session (every future turn 400s, silently) is worse than an upfront
    // refusal the caller can act on immediately.
    expect(store.list().length).toBe(0);
    c.close();
  });

  test("an alias is RESOLVED to its canonical id at create, not stored verbatim", async () => {
    const { store, socketPath, harnessToken } = await boot2(CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "sol" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("gpt-5.6-sol");

    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === res.result.sessionId);
    expect(row.model).toBe("gpt-5.6-sol");
    c.close();
  });

  test("a full canonical id passes through unchanged (control)", async () => {
    const { store, socketPath, harnessToken } = await boot2(CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "gpt-5.6-terra" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("gpt-5.6-terra");
    c.close();
  });

  test("without an enumerable catalogue, an arbitrary model is stored freely — a BYO endpoint is never bricked (control)", async () => {
    const { store, socketPath, harnessToken } = await boot2([]);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "garbage" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("garbage");
    c.close();
  });

  test("omitting model is unaffected — no resolution/validation runs at all (control)", async () => {
    const { store, socketPath, harnessToken } = await boot2(CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBeUndefined();
    c.close();
  });

  // The interaction the brief's own checklist calls out by name: create's effort validation (T6,
  // `assertEffortSelectable`) must run against the RESOLVED model, not whatever alias the caller
  // typed. `effortsForModel` is uniform (ignores its modelId argument today — untouched by this
  // task), so a divergent ALLOWED-list can't be the probe; the refusal MESSAGE naming the model can
  // be: it is built from whatever string `assertEffortSelectable` was handed. If create ran the
  // effort check before resolving the alias, the message would name 'sol'; run in the correct
  // order, it names the canonical id the row is about to be stamped with.
  test("effort validates against the RESOLVED model, not the alias the caller sent", async () => {
    const { store, socketPath, harnessToken } = await boot2(CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "sol", effort: "minimal" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("gpt-5.6-sol");
    expect(res.error.message).not.toContain("'sol'");
    // Refused before the row exists, exactly like the T6 "wire-invalid effort" refusal.
    expect(store.list().length).toBe(0);
    c.close();
  });

  test("a resolved alias's canonical id is what actually gets stamped when effort ALSO validates fine", async () => {
    const { store, socketPath, harnessToken } = await boot2(CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "luna", effort: "high" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("gpt-5.6-luna");
    expect(store.meta(res.result.sessionId).effort).toBe("high");
    c.close();
  });
});
