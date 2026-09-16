import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, SESSION_MODEL_MAX_CHARS, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

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
    const home = mkdtempSync(join(tmpdir(), "winter-set-model-rpc-"));
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

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});

    expect(store.meta(sessionId).model).toBe("anthropic/claude-opus-5");
    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.model).toBe("anthropic/claude-opus-5");
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
    const sessionId = store.createSession("global", { model: "anthropic/claude-opus-5" });
    expect(store.meta(sessionId).model).toBe("anthropic/claude-opus-5");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: null });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBeUndefined();
    c.close();
  });

  test("session.create with model stores it immediately (creation-time stamp)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");

    const created = await c.request(METHODS.sessionCreate, { scope: "global", model: "codex-oauth/gpt-6" });
    expect(created.error).toBeUndefined();
    expect(store.meta(created.result.sessionId).model).toBe("codex-oauth/gpt-6");
    c.close();
  });

  test("idempotent: setting the same value twice both succeed and leave the same value", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");
    const sessionId = store.createSession("global");

    const first = await c.request(METHODS.sessionSetModel, { sessionId, model: "codex-oauth/m1" });
    const second = await c.request(METHODS.sessionSetModel, { sessionId, model: "codex-oauth/m1" });
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("codex-oauth/m1");
    c.close();
  });

  test("unknown session → NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "model-setter");

    const res = await c.request(METHODS.sessionSetModel, { sessionId: "s_does_not_exist", model: "codex-oauth/m1" });
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

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("anthropic/claude-opus-5");
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

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/claude-opus-5" });
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

    const res = await c.request(METHODS.sessionSetModel, { sessionId: "s_does_not_exist", model: "anthropic/claude-opus-5" });
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

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("anthropic/claude-opus-5");
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
    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/claude-opus-5" });
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

    // WS-20: `ModelTagSchema` now requires the "<providerId>/<modelId>" shape as well as the
    // length cap, so the filler has to stay tag-shaped (a real catalog providerId prefix) for the
    // AT-CAP control below to mean anything — an unprefixed run of "m"s would be refused for its
    // shape alone, not its length, which is not what this test is proving.
    const prefix = "codex-oauth/";
    const overCap = prefix + "m".repeat(SESSION_MODEL_MAX_CHARS + 1 - prefix.length);
    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: overCap });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.meta(sessionId).model).toBeUndefined();

    // Control: a tag-shaped value right AT the bound still passes — the cap is far above every
    // real model id, so no existing caller changes behavior.
    const atCap = prefix + "m".repeat(SESSION_MODEL_MAX_CHARS - prefix.length);
    expect(atCap.length).toBe(SESSION_MODEL_MAX_CHARS);
    expect((await c.request(METHODS.sessionSetModel, { sessionId, model: atCap })).error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe(atCap);
    c.close();
  });
});


// ================================================================================================
// WS-20: `session.create`'s OWN `model` is validated by the SAME `resolveModelSelection` helper
// `session.setModel` applies above — a plain `parseModelTag` check, extracted once (beside
// `assertEffortSelectable`) so the two surfaces cannot drift. There is no more alias-resolution
// step and no more catalogue-enumerability escape hatch (both were pre-WS-20 concepts, built
// around `AgentEngine.knownModels()` / `providers/codex-config.ts`'s `CODEX_MODELS`, neither of
// which exists any more): every model is now EITHER shape-valid AND names a real catalog
// provider, OR it is refused — full stop, with no alias table and no "catalogue can't enumerate,
// so anything goes" branch. A model id the named provider doesn't itself recognize is still
// accepted verbatim (there is no per-provider model list to check membership against any more,
// on or off catalog) — only the PROVIDER half of the tag is ever validated.
// ================================================================================================
describe("session.create validates model exactly like session.setModel (WS-20: tags, not aliases)", () => {
  let stop2: (() => void) | undefined;
  afterEach(() => { stop2?.(); stop2 = undefined; });

  async function boot2(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "winter-create-model-rpc-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub: new SessionHub(store) });
    stop2 = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness };
  }

  test("a bare (non-tag-shaped) model is refused at the wire schema, before the handler ever runs", async () => {
    const { store, socketPath, harnessToken } = await boot2();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "garbage" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    // Refused BEFORE the row exists, same precedent as the effort refusal further down — a bricked
    // session (every future turn 400s, silently) is worse than an upfront refusal the caller can
    // act on immediately.
    expect(store.list().length).toBe(0);
    c.close();
  });

  test("a tag-shaped model naming an unrecognized provider is refused by resolveModelSelection", async () => {
    const { store, socketPath, harnessToken } = await boot2();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "nosuchprovider/foo" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("nosuchprovider/foo");
    expect(store.list().length).toBe(0);
    c.close();
  });

  test("a real tag passes through unchanged — no alias table, no resolution step (control)", async () => {
    const { store, socketPath, harnessToken } = await boot2();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "codex-oauth/gpt-5.6-terra" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("codex-oauth/gpt-5.6-terra");

    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === res.result.sessionId);
    expect(row.model).toBe("codex-oauth/gpt-5.6-terra");
    c.close();
  });

  test("a real provider with an off-catalog model id is stored verbatim — never bricked, only the provider half is validated (control)", async () => {
    const { store, socketPath, harnessToken } = await boot2();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "codex-oauth/some-byo-endpoint-model" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("codex-oauth/some-byo-endpoint-model");
    c.close();
  });

  test("omitting model is unaffected — no resolution/validation runs at all (control)", async () => {
    const { store, socketPath, harnessToken } = await boot2();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBeUndefined();
    c.close();
  });

  // The interaction the original T6 checklist called out by name still matters under WS-20: effort
  // validation runs against the TAG this call is about to stamp (there is no alias step left to
  // run it against the wrong thing) — `effortsForModel` reads the real catalog row for a known tag.
  test("effort validates against the model tag actually being stamped", async () => {
    const { store, socketPath, harnessToken } = await boot2();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "codex-oauth/gpt-5.6-sol", effort: "minimal" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("codex-oauth/gpt-5.6-sol");
    // Refused before the row exists, exactly like the wire-invalid effort refusal above.
    expect(store.list().length).toBe(0);
    c.close();
  });

  test("a real tag is what actually gets stamped when effort ALSO validates fine", async () => {
    const { store, socketPath, harnessToken } = await boot2();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "codex-oauth/gpt-5.6-luna", effort: "high" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("codex-oauth/gpt-5.6-luna");
    expect(store.meta(res.result.sessionId).effort).toBe("high");
    c.close();
  });

  // An off-catalog model id has no row to check effort against — `effortsForModel` returns `[]`,
  // and `assertEffortSelectable`'s own guard (`allowed.length > 0`) means no restriction applies,
  // same as a pre-WS-20 "catalogue can't enumerate" BYO endpoint.
  test("effort is unrestricted against an off-catalog model id (no row to validate against)", async () => {
    const { store, socketPath, harnessToken } = await boot2();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "codex-oauth/some-byo-endpoint-model", effort: "minimal" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("codex-oauth/some-byo-endpoint-model");
    expect(store.meta(res.result.sessionId).effort).toBe("minimal");
    c.close();
  });
});
