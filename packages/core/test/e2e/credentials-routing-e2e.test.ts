// WS-19 — the end-to-end half: a credential stored through `credential.set` actually ROUTES a real
// session to a real (loopback) provider, and the value it carries appears nowhere else.
//
// Acceptance covered here: B-1 (set -> list -> a live turn reaching the fake with the key, no
// restart in between — W19-8), B-3 (remove -> list absent, a NEW session refuses typed pre-flight,
// and the LIVE session is not killed), B-8 (W19-14's secret sweep).
//
// This is the proof that the structural finding recorded in `five-hop-chain-e2e.test.ts`'s and
// `session-set-model-review.test.ts`'s headers is CLOSED. Their account was exactly right at the
// time: `WINTER_CREDENTIAL_INVENTORY` had four rows, so `providerSelectionFor` could never name
// `deepseek`/`zai`/`openrouter`, and `optionsFor` built a `connection` for `providerId === "openai"`
// alone, so even a hand-injected inventory row left the real child refusing "no credential is
// configured for provider deepseek". W19-1 derives the inventory from the catalog (so those
// providers have real slots and real `CredentialRef`s) and W19-6 builds a connection for ANY
// provider with a `settings.providers.<id>.baseUrl`. Both halves of that finding are gone, and this
// file is the measurement.
//
// ISOLATION: a mkdtemp home, a `FileSecretStore` under it, loopback fakes on 127.0.0.1, and
// `WS19-SENTINEL-…` dummy values. No Keychain, no `com.winter.core*`, no network.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiChatFake, startFake, type FakeServer } from "@yanlinglabs/winter-provider-conformance/fakes";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { credentialRefFor, keychainSeamFromSecretStore } from "../../src/runtime-sdk/keychain";
import { keychainService } from "../../src/profile";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { describeWithWinterBinary } from "../helpers/winter-binary";

const SENTINEL = "WS19-SENTINEL-e2e-6d41af9c";
const DEEPSEEK_MODEL = "deepseek/deepseek-reasoner";

interface RpcErrorLike { rpc?: { message?: string; data?: { code?: string; reason?: string } } }

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
  readonly frames: string[] = [];
  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            c.frames.push(line);
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else if (msg.method === METHODS.event) c.events.push(msg.params as SessionEvent);
          }
        },
        drain() { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async call<T>(method: string, params?: unknown): Promise<T> {
    const r = await this.request(method, params);
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
    return r.result as T;
  }
  async hello(token: string, clientName: string, role = "harness"): Promise<void> {
    await this.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }
  async waitFor(pred: (e: SessionEvent) => boolean, ms = 45_000): Promise<SessionEvent> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timed out; saw: ${this.events.map((e) => e.type).join(",")}`);
      await Bun.sleep(20);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

/** Every file under `dir`, recursively — the sweep reads the WHOLE temp home rather than guessing
 *  which of its files a value might have landed in. */
function everyFileUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

describeWithWinterBinary("WS-19 end to end: a stored credential routes a real session (B-1/B-3/B-8)", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let fake: FakeServer | undefined;
  /** The RAW `Authorization` header, captured in the route handler. `RecordedRequest.headers`
   *  REDACTS it ("Bearer ***"), which is right for a conformance corpus and useless for the one
   *  assertion this file exists to make. */
  const authHeaders: string[] = [];
  let secretsRef: FileSecretStore | undefined;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "ws19-route-")));
    fake = await startFake({
      routes: [{
        path: "*",
        handler: (req, recorded) => {
          authHeaders.push(req.headers.get("authorization") ?? "");
          if (!recorded.path.endsWith("/chat/completions")) {
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          }
          return openaiChatFake.chatStream({ text: ["hello from the loopback provider"], finishReason: "stop" });
        },
      }],
    });
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      // The session's OWN model is the deepseek catalog row; `settings.provider` is only the
      // daemon's default-model fallback and is deliberately pointed at an unroutable port so
      // nothing can quietly succeed through it.
      provider: { type: "openai-compatible", model: DEEPSEEK_MODEL, baseUrl: "http://127.0.0.1:9/v1" },
      // W19-6: the ONLY thing that points deepseek at the fake. No daemon-side endpoint table.
      providers: { deepseek: { baseUrl: `${fake.url}/v1` } },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60 },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    secretsRef = secrets;
    // DELIBERATELY NO CREDENTIAL WRITTEN HERE — B-1 requires the key to arrive through
    // `credential.set` on the LIVE daemon, with no restart before the turn that uses it.
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    await fake?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("B-1/W19-8: credential.set -> credential.list -> a real turn reaches the fake carrying the key, with no restart", async () => {
    // (1) The slot is empty, and a session on it refuses BEFORE any spawn (W19-7) — asserted first
    // so the success below cannot be passing for some other reason.
    const before = await client.call<{ providers: Array<{ providerId: string; present: boolean }> }>(METHODS.credentialList, {});
    expect(before.providers.find((r) => r.providerId === "deepseek")?.present).toBe(false);

    const cwd0 = realpathSync(mkdtempSync(join(tmpdir(), "ws19-route-cwd0-")));
    let caught: RpcErrorLike | undefined;
    try {
      // NAMING an uncredentialled provider is refused by the ROUTER at create, and always was —
      // `selectRuntimeFor` answers `slot-unservable` for a model no candidate row can serve, long
      // before Winter's own gate is consulted. W19-7 only re-describes that refusal actionably
      // (`refusalForSelection`). The DEFAULT path — a session that names no model — is a different
      // story and is covered in its own test below: it must CREATE fine and refuse at the first turn.
      await client.call(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: DEEPSEEK_MODEL, cwd: cwd0 });
    } catch (err) { caught = err as RpcErrorLike; }
    expect(caught?.rpc?.data?.code).toBe("runtime_selection_refused");
    // The machine-readable half (review Nit 8): `code` alone covers several situations, and
    // `reason` is what a client branches on to say "you have no key for DeepSeek" rather than
    // "the model could not be selected". The sentence is pinned beside it, not instead of it.
    expect(caught?.rpc?.data?.reason).toBe("no-credential");
    expect(caught?.rpc?.message).toContain("no-credential");
    expect(caught?.rpc?.message).toContain("winter credentials set deepseek");
    // Never reached the provider at all: a typed refusal, not a 401.
    expect(authHeaders.length).toBe(0);
    rmSync(cwd0, { recursive: true, force: true });

    // (2) Store it on the LIVE daemon. No restart from here on.
    expect(await client.call<{ ok: boolean }>(METHODS.credentialSet, { providerId: "deepseek", apiKey: SENTINEL })).toEqual({ ok: true });
    const after = await client.call<{ providers: Array<{ providerId: string; present: boolean; kind?: string }> }>(METHODS.credentialList, {});
    expect(after.providers.find((r) => r.providerId === "deepseek")).toMatchObject({ present: true, kind: "api-key" });

    // (3) A real session, a real child, a real turn — reaching the loopback fake.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ws19-route-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: DEEPSEEK_MODEL, cwd });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "say hello" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 90_000);

    // (4) THE ROUTING, measured on the wire: the turn reached the CONFIGURED loopback endpoint,
    // asking for the DeepSeek row's own upstream model id. Before W19-1/W19-6 neither was possible —
    // `providerSelectionFor` could not name `deepseek` at all, and `optionsFor` built a connection
    // for `openai` alone, so the real child refused before any request was made.
    const chat = fake!.requests.filter((r) => r.path.endsWith("/chat/completions"));
    expect(chat.length).toBeGreaterThan(0);
    expect(JSON.parse(chat[0]!.body).model).toBe("deepseek-reasoner");
    // The provider's own answer came back through the session, so this is a completed round trip,
    // not just an outbound request.
    expect(client.events.some((e) => e.type === "assistant_message" && JSON.stringify(e).includes("hello from the loopback provider"))).toBe(true);

    // (5) THE CREDENTIAL, measured on the daemon's own half of the chain — which is the half this
    // lane owns and the only half a hermetic test can reach.
    //
    // MEASURED LIMITATION, recorded deliberately rather than worked around: the spawned `winter`
    // child resolves a `CredentialRef { kind: "keychain" }` by reading the macOS Keychain ITSELF
    // (the SDK's own `keychain-store.ts`, never through the daemon), so a test whose store is a
    // `FileSecretStore` can never put a value on the wire — the request above carries NO
    // `Authorization` header, which is asserted below so this stays honest rather than aspirational.
    // Writing a sentinel into a real Keychain service is the one thing these tests may never do.
    // What IS provable is everything the daemon is responsible for: the two links either side of
    // that gap.
    expect(authHeaders).toEqual([""]);
    const rt = daemon!.runtimeState;
    if ("unavailable" in rt) throw rt.unavailable;
    // The durable record names the right credential LOCATOR (never material — records.ts's own rule).
    expect(rt.records.get(sessionId)?.authRef).toBe("keychain:deepseek:default");
    expect(rt.records.get(sessionId)?.providerId).toBe("deepseek");
    // ...and that locator, through the daemon's OWN seam, resolves to exactly what was stored.
    const ref = credentialRefFor("deepseek", home)!;
    expect(ref).toEqual({ kind: "keychain", account: "deepseek:default", service: keychainService(undefined, home) });
    expect(await keychainSeamFromSecretStore(secretsRef!, home).read(ref)).toBe(SENTINEL);

    rmSync(cwd, { recursive: true, force: true });
  }, 180_000);

  test("B-8 / W19-14: the sentinel appears in NO log line, NO session file, NO history page, NO replay frame and NO credential.list", async () => {
    // The daemon logs through console.* in-process here, so this captures exactly the lines a
    // production daemon would write to its log file.
    // All THREE console channels (review Minor 3): the daemon writes progress through `console.log`
    // as well as `error`/`warn`, and a log line is a log line — a sweep that watched only two of
    // them would have been quiet about the third.
    const lines: string[] = [];
    const push = (...a: unknown[]): void => { lines.push(a.map(String).join(" ")); };
    const errSpy = spyOn(console, "error").mockImplementation(push);
    const warnSpy = spyOn(console, "warn").mockImplementation(push);
    const logSpy = spyOn(console, "log").mockImplementation(push);
    try {
      // Exercise every door again WHILE capturing, including the remote role (W19-10) and the
      // error paths, since an error message is the easiest place for a value to slip out.
      const remote = await TestClient.connect(daemon!.socketPath);
      await remote.hello(daemon!.tokens.remote, "iphone-gateway", "remote");
      await remote.call(METHODS.credentialSet, { providerId: "zai", apiKey: SENTINEL });
      const remoteList = await remote.request(METHODS.credentialList, {});
      const badProvider = await remote.request(METHODS.credentialSet, { providerId: "not-a-provider", apiKey: SENTINEL });
      const badValue = await remote.request(METHODS.credentialSet, { providerId: "zai", apiKey: `${SENTINEL}​` });
      const localList = await client.request(METHODS.credentialList, {});
      const sessions = await client.call<{ sessions: Array<{ sessionId: string }> }>(METHODS.sessionList, {});
      const sessionId = sessions.sessions[0]!.sessionId;
      const history = await client.request(METHODS.sessionHistory, { sessionId, limit: 200 });

      for (const [label, value] of [
        ["remote credential.list", remoteList],
        ["local credential.list", localList],
        ["unknown-provider error", badProvider],
        ["invalid-value error", badValue],
        ["session.history", history],
        ["remote replay frames", remote.frames],
        ["local frames", client.frames],
      ] as const) {
        expect({ label, leaked: JSON.stringify(value).includes(SENTINEL) }).toEqual({ label, leaked: false });
      }
      remote.close();

      for (const line of lines) expect(line).not.toContain(SENTINEL);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    // Every file under the temp home EXCEPT the test secret store itself (which is where the value
    // is SUPPOSED to be — a `FileSecretStore` standing in for the Keychain).
    const secretsDir = join(home, "test-secrets");
    const leaked = everyFileUnder(home)
      .filter((p) => !p.startsWith(secretsDir))
      .filter((p) => {
        try { return readFileSync(p, "utf8").includes(SENTINEL); } catch { return false; }
      });
    expect(leaked).toEqual([]);

    // ...and a positive control: the sweep can actually SEE a value in a file, so an empty result
    // above means "absent", not "the walk found nothing to read".
    expect(everyFileUnder(secretsDir).some((p) => readFileSync(p, "utf8").includes(SENTINEL))).toBe(true);
  }, 120_000);

  test("B-3: removing the credential leaves the LIVE session alone, and refuses the NEXT one typed", async () => {
    const sessions = await client.call<{ sessions: Array<{ sessionId: string }> }>(METHODS.sessionList, {});
    const liveSessionId = sessions.sessions[0]!.sessionId;

    expect(await client.call<{ ok: boolean; removed: boolean }>(METHODS.credentialRemove, { providerId: "deepseek" })).toEqual({ ok: true, removed: true });
    const list = await client.call<{ providers: Array<{ providerId: string; present: boolean }> }>(METHODS.credentialList, {});
    expect(list.providers.find((r) => r.providerId === "deepseek")?.present).toBe(false);

    // The live session is untouched — still listed, never killed by a credential change.
    const after = await client.call<{ sessions: Array<{ sessionId: string }> }>(METHODS.sessionList, {});
    expect(after.sessions.some((s) => s.sessionId === liveSessionId)).toBe(true);

    // ...but its NEXT TURN refuses typed, which is W19-7's own case and the one that matters most:
    // a session that was running happily until the key was taken away must say so before the spawn,
    // not hand the user a vendor 401 mid-turn (fix round 2 — this is where the gate lives now).
    const seqBefore = after.sessions.find((r) => r.sessionId === liveSessionId) as { lastSeq?: number } | undefined;
    let turnRefusal: RpcErrorLike | undefined;
    try {
      await client.call(METHODS.sessionSend, { sessionId: liveSessionId, text: "the key is gone now" });
    } catch (err) { turnRefusal = err as RpcErrorLike; }
    expect(turnRefusal?.rpc?.data?.code).toBe("runtime_selection_refused");
    expect(turnRefusal?.rpc?.data?.reason).toBe("no-credential");
    expect(turnRefusal?.rpc?.message).toContain("winter credentials set deepseek");
    // The gate runs before `open()` AND before the append, so the refusal left the session's log
    // exactly as it was — no orphan `user_message`, no `turn_started`.
    const afterRefusal = await client.call<{ sessions: Array<{ sessionId: string; lastSeq?: number }> }>(METHODS.sessionList, {});
    expect(afterRefusal.sessions.find((r) => r.sessionId === liveSessionId)?.lastSeq).toBe(seqBefore?.lastSeq);
    expect(afterRefusal.sessions.length).toBe(after.sessions.length);

    // A NEW session on the same provider refuses too — at CREATE, and that half is the ROUTER's, not
    // Winter's gate: `selectRuntimeFor` answers `slot-unservable` for a model no candidate row can
    // serve, and W19-7 only re-describes it actionably (`refusalForSelection`).
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ws19-route-cwd2-")));
    let caught: RpcErrorLike | undefined;
    try {
      await client.call(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: DEEPSEEK_MODEL, cwd });
    } catch (err) { caught = err as RpcErrorLike; }
    expect(caught?.rpc?.data?.code).toBe("runtime_selection_refused");
    expect(caught?.rpc?.data?.reason).toBe("no-credential");
    expect(caught?.rpc?.message).toContain("no-credential");
    rmSync(cwd, { recursive: true, force: true });
  }, 120_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D1 fix round 4, ITEM 6 — A SAME-LEG SWITCH THAT CHANGES PROVIDER REACHES THE CHILD.
//
// This closes CONCERN 1 of Lane P's own report, which this file's B-1 block made newly reachable: a
// live Winter child's `Options.provider`/`connection` is FIXED AT SPAWN (`session-driver.ts`'s
// `optionsFor`, once per incarnation). A same-leg model change that also moves PROVIDER is answered
// `same-runtime`, the store write lands, and `Query.setModel` tells the child its new model — but
// the child keeps posting to the OLD endpoint with the OLD credential, silently, until an idle reap
// or a daemon restart happens to replace it. Nothing errors, and `session.list` already shows the
// new model, so there is no surface on which a user could notice.
//
// `planAndApplySwitch`'s same-leg arm now evicts the live child when `decided.providerId` differs
// (at the next idle boundary if a turn is running), so the NEXT send re-spawns against the new
// endpoint. A same-provider model change stays hot, exactly as before.
//
// TWO loopback fakes, one per provider, each recording its own requests — the assertion is that
// turn 2 lands on B and NOT on A, which no single-fake bed could distinguish.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("WS-19 + D1 item 6: a same-leg PROVIDER change routes the NEXT turn to the new endpoint", (winterBin) => {
  const ZAI_MODEL = "zai/glm-5";
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let deepseekFake: FakeServer | undefined;
  let zaiFake: FakeServer | undefined;
  const deepseekChats: string[] = [];
  const zaiChats: string[] = [];

  const chatFake = (sink: string[]): Parameters<typeof startFake>[0] => ({
    routes: [{
      path: "*",
      handler: (_req, recorded) => {
        if (!recorded.path.endsWith("/chat/completions")) {
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
        sink.push(recorded.body);
        return openaiChatFake.chatStream({ text: ["answered"], finishReason: "stop" });
      },
    }],
  });

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "ws19-provider-switch-")));
    deepseekFake = await startFake(chatFake(deepseekChats));
    zaiFake = await startFake(chatFake(zaiChats));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: DEEPSEEK_MODEL, baseUrl: "http://127.0.0.1:9/v1" },
      // W19-6's seam, one entry per provider — the ONLY thing pointing either at a fake.
      providers: { deepseek: { baseUrl: `${deepseekFake.url}/v1` }, zai: { baseUrl: `${zaiFake.url}/v1` } },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 600, handoff: { crossRuntime: true } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
    await client.call(METHODS.credentialSet, { providerId: "deepseek", apiKey: `${SENTINEL}-ds` });
    await client.call(METHODS.credentialSet, { providerId: "zai", apiKey: `${SENTINEL}-zai` });
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    await deepseekFake?.close();
    await zaiFake?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("turn 1 on deepseek, setModel to a zai row, turn 2 hits the zai fake and never deepseek again", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ws19-provider-switch-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: DEEPSEEK_MODEL, cwd });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });

    let since = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId, text: "turn one" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
    expect(deepseekChats.length).toBeGreaterThan(0);
    expect(zaiChats.length).toBe(0);
    // `winterIdleTimeoutSec: 600` above keeps the child alive, so an idle reap can never be the
    // thing that replaces it — only the switch can.
    expect(daemon!.winter.get(sessionId)).toBeDefined();

    // Same LEG (both Winter), different PROVIDER. `confirmLossy: true` so the assertion does not
    // depend on whether this particular pair prompts — the claim under test is where the NEXT turn
    // goes, not whether the move asked first.
    await client.call(METHODS.sessionSetModel, { sessionId, model: ZAI_MODEL, confirmLossy: true });

    const rt = daemon!.runtimeState;
    if ("unavailable" in rt) throw rt.unavailable;
    expect(rt.records.get(sessionId)?.providerId).toBe("zai");
    expect(daemon!.winter.legOf(sessionId)).toBe("winter"); // never a runtime move
    // The child is GONE — replaced, not killed: the next send resumes from the transcript.
    expect(daemon!.winter.get(sessionId)).toBeUndefined();

    const deepseekBefore = deepseekChats.length;
    since = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId, text: "turn two" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.indexOf(e) >= since, 45_000);

    // THE POINT: turn 2 reached the NEW provider's endpoint, and the old one saw nothing more.
    expect(zaiChats.length).toBeGreaterThan(0);
    expect(deepseekChats.length).toBe(deepseekBefore);
    // …with no restart, and no crash surfacing as a dead runtime.
    expect(client.events.some((e) => e.type === "agent_error" && JSON.stringify(e).includes("process_death"))).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  }, 180_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// W19-7, FIX ROUND 2 — THE GATE IS A TURN GATE, AND IT NEVER FIRES ON A FALLBACK.
//
// A REGRESSION THIS PINS SO IT CANNOT COME BACK (measured by bisect to Lane P's own f640744f), in
// two halves, because the first round got BOTH wrong:
//
//   1. IT REFUSED AT CREATE. The check lived in `optionsFor`, which runs at every `open()` —
//      including the eager one `session.create`/`session.dispatch` perform — so a credential-less
//      home could not create ANY session. A fresh install with no key yet could not start one, and
//      the Mac app, which dispatches a session at launch, produced the "orb Enter silently
//      no-op'd" failure.
//   2. IT REFUSED ON A NAME NOBODY CHOSE. `providerSelectionFor` answers `inInventory[0]` for a bare
//      model id that several inventory providers serve and none is credentialled — a name, not a
//      decision. So a home configured for Codex OAuth, asking for the default `gpt-5.6-sol`, was
//      told to run `winter credentials set openai`: a provider the user never chose, through a door
//      that would not have helped.
//
// Both halves broke five real-daemon WinterKit gateway tests, whose harness dispatches and sends on
// exactly such a home. The rule that actually matters is unchanged and is asserted in the suite
// above (B-1/B-3): no TURN runs against a provider Winter HAS decided on and holds no credential for.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("W19-7: a credential-less, Codex-configured home creates, dispatches AND sends", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "ws19-turn-gate-")));
    // What `bootstrapWinterDir` + `loadSettings` leave a FRESH home looking like: the Codex OAuth
    // default provider and its default model, and nothing stored anywhere.
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.6-sol" },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60 },
    }, null, 2));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    rmSync(home, { recursive: true, force: true });
  });

  test("create, dispatch and the first send all succeed — the gate never fires on an inventory-order fallback", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ws19-turn-gate-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", cwd });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });

    // The singleton the Mac app mints at launch, and the exact call the WinterKit gateway harness
    // seeds every one of its real-daemon tests with.
    const dispatched = await client.call<{ sessionId: string; created: boolean }>(METHODS.sessionDispatch, {});
    expect(dispatched.created).toBe(true);

    // And the turn itself: `gpt-5.6-sol` is served by SIX inventory providers, none credentialled,
    // so Winter has decided nothing and says nothing. The send lands; whatever the child then makes
    // of an unauthenticated provider is the child's own typed error to report, exactly as before
    // WS-19 existed.
    const sent = await client.call<{ seq: number }>(METHODS.sessionSend, { sessionId, text: "this send must not be refused" });
    expect(typeof sent.seq).toBe("number");
    await client.call(METHODS.sessionAttach, { sessionId: dispatched.sessionId, fromSeq: 0 });
    const dispatchSent = await client.call<{ seq: number }>(METHODS.sessionSend, { sessionId: dispatched.sessionId, text: "nor this one" });
    expect(typeof dispatchSent.seq).toBe("number");

    rmSync(cwd, { recursive: true, force: true });
  }, 120_000);
});
