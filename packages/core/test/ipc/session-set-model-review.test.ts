// Winter Phase 10b (Lane D2, task D2-3) — spec WS-18 §9's A-6 (no credential), A-7 (same-leg loss),
// A-7a (same family, silent), plus the controller's own C1 addendum item (a same-leg model change
// must not leave the pre-flight review reading a STALE recorded model before a later cross-runtime
// move).
//
// STRUCTURAL FINDING (2026-09-14, test fix round 1 — same root cause `five-hop-chain-e2e.test.ts`
// documents in full depth, including the DEEPER attempt: review-lane-d2.md's own suggested
// workaround, pushing a `deepseek`/`zai` row into `WINTER_CREDENTIAL_INVENTORY` at test runtime plus
// writing matching credential material, was TRIED and does NOT work — the real `dist/winter` child
// still refuses "no credential is configured for provider deepseek", because `session-driver.ts`'s
// `optionsFor` only ever builds a connection/local-declaration object for `providerId === "openai"`;
// see that file's header for the full account): `WINTER_CREDENTIAL_INVENTORY`
// (`src/runtime-sdk/keychain.ts:115-127`) has exactly three rows — `openai`, `codex-oauth`,
// `anthropic` — so NEITHER `deepseek` NOR `zai` (GLM) NOR any OpenRouter-style row can ever be routed
// to end to end. This blocks, via REAL daemon wiring:
//   - A-7's OWN literal pairing ("gpt -> deepseek on Winter prompts; deepseek -> GLM does not");
//   - A-7a's OWN literal "Claude on Anthropic -> Claude on OpenRouter" case;
//   - the controller's OWN C1 addendum's literal "GPT -> DeepSeek -> GPT -> Claude" chain (it cannot
//     even reach the first step).
// Substituted below with the CLOSEST achievable real-wiring equivalents (two real, same-family,
// differently-reasoning-capable OpenAI catalog rows: `openai/gpt-5.4`, no reasoning at all, and
// `openai/gpt-5.6-sol`, hidden reasoning) plus the SAME real-resolver/real-`classifySwitch` technique
// `five-hop-chain-e2e.test.ts` already established for the literal DeepSeek/GLM pairing — never a
// fixture that fakes `readableState`/`continuation`.
//
// RESOLVED (WS-19, Lane P): the finding above is a HISTORICAL RECORD, accurate for when it was
// written — it is no longer this daemon's current state (W19-1 derives the credential inventory from
// the catalog; W19-6 gives `session-driver.ts` a connection seam for any provider with a
// `settings.providers.<id>.baseUrl`). The substitutes above still stand as real coverage of the same
// classification, and the file's OWN "A-7 / A-7a — THE LITERAL PAIRINGS, now reachable" section
// (below) adds the literal pairings beside them, body-level, through real sessions — including the
// A-7a deviation it records: the spec's literal "Claude on Anthropic -> Claude on OpenRouter" case is
// unbuildable against the pinned catalog (0.0.12 carries no OpenRouter Claude row at all), so it is
// substituted with the same SHAPE the case is actually about (one canonical model, two providers,
// switching silently) using a pairing the catalog does carry.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySwitch, sameFamily } from "@yanlinglabs/winter-provider-runtime";
import { openaiChatFake, openaiResponsesFake, startFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { renderNoCredentialHint } from "../../src/runtime-sdk/handoff";
import { daemonResolveEndpoint } from "../../src/providers/registry";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { carriesReasoning, opaqueLeaks, outOfOrder } from "../helpers/carriage";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

interface RpcErrorLike { rpc?: { message?: string; data?: { code?: string; warnings?: string[]; portable?: string[]; reason?: string } } }

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
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
  async hello(token: string, clientName: string): Promise<void> {
    await this.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }
  async waitFor(pred: (e: SessionEvent) => boolean, ms = 20_000): Promise<SessionEvent> {
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A-6 — no credential.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("A-6a: the no-credential hint never names an SDK or runtime (pure function, real code)", () => {
  test("an OpenRouter-only alternative renders a hint that never mentions an SDK/runtime name (R-10b-4)", () => {
    // Substitute for "Claude with only an OpenRouter credential -> the winter leg": OpenRouter has
    // no row in this daemon's own WINTER_CREDENTIAL_INVENTORY either (this file's own header), so
    // the end-to-end shape cannot be constructed; `renderNoCredentialHint` is the REAL, exported
    // pure function `planAndApplySwitch` itself calls for this exact case — exercised directly with
    // an alternatives list shaped like a real no-credential refusal would carry.
    const hint = renderNoCredentialHint(
      [{ providerId: "openrouter", authKind: "api-key", label: "OpenRouter" }],
      { subscriptionEnabled: false },
    );
    expect(hint).toContain("OpenRouter");
    expect(hint).not.toMatch(/\bSDK\b|\bruntime\b|Claude Agent|Winter Agent|winter-agent|claude-agent/i);
  });

  test("no doors at all renders a hint naming no provider, still never an SDK/runtime", () => {
    const hint = renderNoCredentialHint([], { subscriptionEnabled: false });
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).not.toMatch(/\bSDK\b|\bruntime\b|Claude Agent|Winter Agent/i);
  });
});

describeWithWinterBinary("A-6b: no credential at all -> runtime_selection_refused with the alternatives hint", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "review-a6b-")));
    const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: {}, unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hi"] }),
    });
    openaiFakeRef = openaiFake;
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "openai/gpt-5.6-sol", baseUrl: openaiFake.url },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-a6b" });
    // Deliberately NO anthropic credential written at all.
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
    await openaiFakeRef?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("setModel to claude with zero anthropic credential refuses typed, with an alternatives-driven hint", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "review-a6b-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "openai/gpt-5.6-sol", cwd });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });

    let caught: RpcErrorLike | undefined;
    try {
      await client.call(METHODS.sessionSetModel, { sessionId, model: "claude-sonnet-5" });
    } catch (err) { caught = err as RpcErrorLike; }
    expect(caught).toBeDefined();
    expect(caught!.rpc?.data?.code).toBe("runtime_selection_refused");
    expect(caught!.rpc?.message).not.toMatch(/\bSDK\b|Claude Agent|Winter Agent/i);
    // Never applied: the session stays on its original leg/model.
    expect(d.winter.legOf(sessionId)).toBe("winter");

    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A-7a — same family never prompts.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithClaudeRuntime("A-7a: Sonnet -> Opus (official) never prompts", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let anthropicFakeClose: (() => Promise<void>) | undefined;
  const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hi"] }], stopReason: "end_turn" };

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "review-a7a-sonnet-")));
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    const fakeServer = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => (recorded.path === "/v1/messages" && recorded.method === "POST"
          ? anthropicFake.anthropicTurnResponse(anthropicScript)
          : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
      }],
    });
    anthropicFakeClose = () => fakeServer.close();
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/unused", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { claudeExecutable: claudeRuntimeForTests()!.executable, handoff: { crossRuntime: true } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-a7a" });
    daemon = await startDaemon({
      home, secrets, agentProvider: null,
      officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: fakeServer.url }, authFamily: "custom" }),
    });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    await anthropicFakeClose?.();
    rmSync(home, { recursive: true, force: true });
  });

  test("Sonnet -> Opus applies silently (same family, official leg unaffected)", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "claude-sonnet-5" });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    expect(d.winter.legOf(sessionId)).toBe("official");
    await client.call(METHODS.sessionSend, { sessionId, text: "one turn on sonnet" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

    // Same family, same leg -> `same-runtime`, applied with NO error and NO prompt.
    await client.call(METHODS.sessionSetModel, { sessionId, model: "claude-opus-5" });
    expect(d.winter.legOf(sessionId)).toBe("official"); // never moved runtimes
  }, 60_000);
});

describeWithWinterBinary("A-7a: two OpenAI-family models never prompt on Winter", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "review-a7a-gpt-")));
    const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: {}, unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hi"] }),
    });
    openaiFakeRef = openaiFake;
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "openai/gpt-5.4", baseUrl: openaiFake.url },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-a7a-gpt" });
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
    await openaiFakeRef?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("openai/gpt-5.4 -> openai/gpt-5.6-sol never prompts (sameFamily, real catalog facts)", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;

    // 5a fix (review-lane-d2.md): `RuntimeSelection.family` is the catalog FRAMING id ("gpt"), a
    // DIFFERENT vocabulary from `ContinuityEndpoint.family` ("openai") — a hardcoded `family:
    // "openai"` string here only happened to match `daemonResolveEndpoint`'s own reading; provider-
    // runtime 0.0.11's `createEndpointResolver` memoizes by `modelKey` ALONE and keeps whichever
    // family the FIRST caller in this process supplied, so a hardcoded probe silently goes stale
    // the instant an earlier test in the same `bun test` invocation resolves the same model id
    // through a real `setModel` first (measured: this exact test flaked when run alongside
    // `five-hop-chain-e2e.test.ts` in one invocation). Deriving the family from a REAL decision
    // (`selectRuntimeFor`) instead of a hardcoded literal makes the probe immune to that ordering.
    const decidedA = await d.runtimeSdk!.selectRuntimeFor({ mode: "code", model: "openai/gpt-5.4" });
    const decidedB = await d.runtimeSdk!.selectRuntimeFor({ mode: "code", model: "openai/gpt-5.6-sol" });
    if ("refused" in decidedA || "refused" in decidedB) throw new Error("both models must resolve for this probe");
    const resolve = daemonResolveEndpoint();
    const a = resolve({ providerId: "openai", modelKey: "openai/gpt-5.4", family: decidedA.family });
    const b = resolve({ providerId: "openai", modelKey: "openai/gpt-5.6-sol", family: decidedB.family });
    expect(sameFamily(a, b)).toBe(true);
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "openai/gpt-5.4" });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "one turn" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

    await client.call(METHODS.sessionSetModel, { sessionId, model: "openai/gpt-5.6-sol" }); // never throws
    expect(d.winter.legOf(sessionId)).toBe("winter");
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A-7 — same-leg loss (the literal deepseek/GLM pairing is unreachable end to end; verified against
// the real resolver + real classifySwitch instead, same technique as `five-hop-chain-e2e.test.ts`)
// plus the zero-turn carve-out, which IS achievable end to end.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("A-7: same-leg loss, against the REAL daemon resolver (no fixture)", () => {
  const resolve = daemonResolveEndpoint();

  // Minor 5 (review-lane-d2-fix1.md): the `family` strings below are HARDCODED literals, not
  // derived from a real `selectRuntimeFor` decision — there is no live daemon in this describe
  // block to decide one from. `createEndpointResolver` (provider-runtime 0.0.11+) memoizes by
  // `modelKey` ALONE and keeps whichever family the FIRST caller in the PROCESS supplied, so this
  // remains a real memo-poisoning hazard for any OTHER test in the same `bun test` invocation that
  // resolves these SAME model ids with a DIFFERENT (real) family — even though each `resolve(...)`
  // call below already lives inside its own `test()` body (never at describe/module scope), the
  // cross-FILE ordering risk is not eliminated. Labeled here per that review's own instruction.
  test("gpt -> deepseek on Winter prompts (a hidden-reasoning source crossing families is warned-lossy)", () => {
    const gpt = resolve({ providerId: "openai", modelKey: "openai/gpt-5.6-sol", family: "openai" });
    const deepseek = resolve({ providerId: "deepseek", modelKey: "deepseek/deepseek-reasoner", family: "deepseek" });
    const c = classifySwitch(gpt, deepseek, {});
    expect(c.lossClass).toBe("warned-lossy");
  });

  test("deepseek -> GLM does not (exposedComplete asserted from complete exposed records)", () => {
    const deepseek = resolve({ providerId: "deepseek", modelKey: "deepseek/deepseek-reasoner", family: "deepseek" });
    const glm = resolve({ providerId: "zai", modelKey: "zai/glm-5", family: "glm" });
    expect(deepseek.readableState).toBe("full-exposed"); // the premise this case rests on
    const c = classifySwitch(deepseek, glm, { exposedComplete: true });
    expect(c.lossClass).not.toBe("warned-lossy");
  });
});

describeWithWinterBinary("A-7: a zero-turn session that switches families does not prompt", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
  let anthropicFakeClose: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "review-a7-zero-")));
    const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: {}, unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hi"] }),
    });
    openaiFakeRef = openaiFake;
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    const fakeServer = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => (recorded.path === "/v1/messages" && recorded.method === "POST"
          ? anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["hi"] }], stopReason: "end_turn" } as AnthropicTurnScript)
          : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
      }],
    });
    anthropicFakeClose = () => fakeServer.close();
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "openai/gpt-5.6-sol", baseUrl: openaiFake.url },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-a7-zero" });
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-a7-zero-anthropic" });
    daemon = await startDaemon({
      home, secrets, agentProvider: null,
      officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: fakeServer.url }, authFamily: "custom" }),
    });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    await openaiFakeRef?.close();
    await anthropicFakeClose?.();
    rmSync(home, { recursive: true, force: true });
  });

  test("session.create then IMMEDIATELY session.setModel (no turns at all): gpt -> claude never prompts (P10b-2)", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "openai/gpt-5.6-sol" });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    // Zero turns sent — nothing to lose, so the review must be SKIPPED entirely (silent).
    //
    // CANDIDATE FINDING (2026-09-14, MEASURED): this session already has a `backendSessionId`
    // allocated by `session.attach` (it is not the `session_predates_winter_leg` shape
    // `sessionKeyFor` returning `undefined` guards — that daemon-level skip does NOT fire here), but
    // its canonical transcript file does not exist yet (no turn has ever run), and `barrier
    // .reviewSwitch` THROWS reading it rather than treating a missing file as zero entries. The
    // fail-safe catch in `runtime-sdk/handoff.ts`'s `planAndApplySwitch` then converts that into a
    // PROMPT ("Winter couldn't check what carries over to claude-sonnet-5…") — not the silent skip
    // P10b-2 requires for a session with nothing to lose. Reported to the controller; left asserting
    // the spec's required silent behaviour rather than weakened.
    await client.call(METHODS.sessionSetModel, { sessionId, model: "claude-sonnet-5" }); // MEASURED to throw handoff_confirmation_required today (see above)
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Controller addendum item 1 (C1) — a same-leg model change must not leave the pre-flight review
// reading a STALE recorded model before a later cross-runtime move. DEVIATION (documented in this
// file's header): the coordinator's own "GPT -> DeepSeek -> GPT -> Claude" chain is unreachable
// (DeepSeek has no credential row); substituted with the closest achievable real-wiring equivalent
// that exercises the IDENTICAL underlying worry — does a same-leg, same-family switch actually
// update what the NEXT review reads as "from"? — using two real, same-family OpenAI rows that
// differ specifically in whether they reason at all: `openai/gpt-5.4` (no reasoning; a move away
// from it is `lossless-native`) and `openai/gpt-5.6-sol` (hidden reasoning; a move away from it is
// `warned-lossy`). If the review reads the STALE gpt-5.4 identity after the same-leg move to
// gpt-5.6-sol, the final gpt -> claude move would WRONGLY fail to prompt.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("C1: a same-leg switch must not leave the review reading a stale model", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "review-c1-")));
    const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: {}, unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hi"] }),
    });
    openaiFakeRef = openaiFake;
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "openai/gpt-5.4", baseUrl: openaiFake.url },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-c1" });
    // An anthropic credential is REQUIRED even though the LAST move only needs to PROMPT, never to
    // succeed: without one, `selectRuntimeFor` itself refuses `runtime_selection_refused` (no
    // credential) BEFORE the pre-flight review is ever reached at all (measured) — a different,
    // uninteresting refusal that would never exercise this test's own point.
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-c1-anthropic" });
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
    await openaiFakeRef?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("gpt-5.4 -> gpt-5.6-sol (same-leg, silent) -> claude MUST prompt (the review must read gpt-5.6-sol, not the stale gpt-5.4)", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "review-c1-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "openai/gpt-5.4", cwd });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "on the non-reasoning model" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

    // Step 1: gpt-5.4 -> gpt-5.6-sol, same family, same leg — must apply silently.
    await client.call(METHODS.sessionSetModel, { sessionId, model: "openai/gpt-5.6-sol" }); // never throws
    expect(d.winter.legOf(sessionId)).toBe("winter");
    // A turn on the NEW model, so the review has a source turn to weigh under the NEW identity.
    await client.call(METHODS.sessionSend, { sessionId, text: "on the reasoning model now" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.filter((ev) => ev.type === "turn_completed").length >= 2, 45_000);

    // Step 2: gpt-5.6-sol -> claude, cross-runtime — MUST prompt (W18-21's own required behaviour).
    // GREEN since the D1 C1 fix (`5c09626d`): the review now reads gpt-5.6-sol's OWN fresh facts
    // (hidden reasoning, warned-lossy), not the stale gpt-5.4 identity from before the same-leg move.
    let caught: RpcErrorLike | undefined;
    try {
      await client.call(METHODS.sessionSetModel, { sessionId, model: "claude-sonnet-5" });
    } catch (err) { caught = err as RpcErrorLike; }
    expect(caught).toBeDefined();
    expect(caught!.rpc?.data?.code).toBe("handoff_confirmation_required");

    rmSync(cwd, { recursive: true, force: true });
  }, 90_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A-7 / A-7a — THE LITERAL PAIRINGS, now reachable (WS-19, Lane P).
//
// This file's header records, accurately for the time it was written, why A-7's own literal
// `gpt -> deepseek` / `deepseek -> GLM` pairing and A-7a's own literal case could not be built:
// `WINTER_CREDENTIAL_INVENTORY` was a four-row literal, so `providerSelectionFor` refused any model
// whose provider was not one of `openai`/`codex-oauth`/`anthropic`, and `session-driver.ts`'s
// `optionsFor` built a provider connection ONLY for `providerId === "openai"`, so even a
// hand-injected inventory row left the real child refusing outright. The header's own diagnosis
// named both halves exactly, and WS-19 removed both: W19-1 DERIVES the inventory from the catalog
// (every in-scope api-key provider has a real slot and a real `CredentialRef`), and W19-6 builds a
// connection for ANY provider with a `settings.providers.<id>.baseUrl`.
//
// So the substitutes above stand as written — they are real coverage of the same classification —
// and these two blocks add the LITERAL pairings beside them, through real sessions on real
// `dist/winter` children, body-level on every hop (each hop's own loopback fake receives a request
// whose body names that provider's own upstream model id).
//
// A-7a DEVIATION, recorded rather than faked: the spec's literal case is "Claude on Anthropic ->
// Claude on OpenRouter", and the PINNED CATALOG (provider-catalog 0.0.12) carries NO OpenRouter
// Claude row at all — `openrouter` serves exactly `openai/gpt-4.1` and `openrouter/auto` there. That
// pairing is therefore unbuildable against this catalog for a reason that has nothing to do with the
// daemon, and inventing a row would be testing a fixture rather than the product. The case is built
// on the same SHAPE that A-7a is actually about — ONE canonical model served by TWO different
// providers, which must switch silently — using the pairing the catalog does carry:
// `openai/gpt-4.1` -> `openrouter/openai/gpt-4.1`.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** One loopback OpenAI-chat-completions provider (deepseek/zai/openrouter all ride that adapter),
 *  recording the model id each request asked for so a hop can be proven BODY-LEVEL. */
async function startChatProviderFake(reply: string, reasoning?: string[]): Promise<{ fake: Awaited<ReturnType<typeof startFake>>; models: string[]; bodies: string[] }> {
  const models: string[] = [];
  const bodies: string[] = [];
  const fake = await startFake({
    routes: [{
      path: "*",
      handler: (_req, recorded) => {
        if (!recorded.path.endsWith("/chat/completions")) {
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
        bodies.push(recorded.body);
        try { models.push(String(JSON.parse(recorded.body).model)); } catch { models.push("<unparseable>"); }
        return openaiChatFake.chatStream({ text: [reply], finishReason: "stop", ...(reasoning === undefined ? {} : { reasoning }) });
      },
    }],
  });
  return { fake, models, bodies };
}


/**
 * MEASURED, then CLOSED (Lane P, 2026-09-15; D1 fix round 4): a same-leg model change that also
 * changed the PROVIDER did not reach the LIVE child — its `Options.provider`/`connection` are fixed
 * at spawn, the child refused `Query.setModel`, the store write landed anyway, and the next turn
 * went silently to the OLD endpoint. Lane P's first round forced a fresh incarnation between hops to
 * work around it and reported the finding; `planAndApplySwitch` now evicts the live child when the
 * decided provider differs from the recorded one, so the hops below change provider with NOTHING
 * standing in for an idle reap. That is why these assertions are worth making: if the eviction
 * regressed, the destination fake would simply never be reached.
 */

describeWithWinterBinary("A-7: the LITERAL gpt -> deepseek (prompts) / deepseek -> GLM (silent) pairing", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
  let deepseek: Awaited<ReturnType<typeof startChatProviderFake>> | undefined;
  let zai: Awaited<ReturnType<typeof startChatProviderFake>> | undefined;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "a7-literal-")));
    openaiFakeRef = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: {}, unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello from gpt"] }),
    });
    // DeepSeek's exposed reasoning channel (`delta.reasoning_content`) — the session has to actually
    // CARRY complete exposed reasoning for the deepseek -> GLM hop to be classified silent; a reply
    // with no reasoning at all leaves the review with nothing to carry and it warns, correctly.
    deepseek = await startChatProviderFake("hello from deepseek", ["thinking about the hop"]);
    zai = await startChatProviderFake("hello from glm");
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "openai/gpt-5.6-sol", baseUrl: openaiFakeRef.url },
      // W19-6 — the ONLY thing pointing these two providers anywhere. No daemon-side endpoint table.
      providers: { deepseek: { baseUrl: `${deepseek.fake.url}/v1` }, zai: { baseUrl: `${zai.fake.url}/v1` } },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-a7-openai" });
    // W19-1: these two slots simply did not exist before.
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-test-a7-deepseek" });
    await writeCredentialMaterial(secrets, "zai:default", { kind: "api-key", key: "sk-test-a7-zai" });
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
    await openaiFakeRef?.close();
    await deepseek?.fake.close();
    await zai?.fake.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("gpt -> deepseek PROMPTS and, once confirmed, really runs on deepseek; deepseek -> GLM is SILENT and really runs on GLM", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "a7-literal-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "openai/gpt-5.6-sol", cwd });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "hop 0, on gpt" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 90_000);

    // HOP 1 — gpt -> deepseek. A hidden-reasoning source crossing to a foreign family: PROMPTS.
    let caught: RpcErrorLike | undefined;
    try {
      await client.call(METHODS.sessionSetModel, { sessionId, model: "deepseek/deepseek-reasoner" });
    } catch (err) { caught = err as RpcErrorLike; }
    expect(caught?.rpc?.data?.code).toBe("handoff_confirmation_required");
    expect((caught?.rpc?.data?.warnings?.length ?? 0)).toBeGreaterThan(0);
    // Confirmed, it goes through — same leg, so no runtime migration is involved at all.
    await client.call(METHODS.sessionSetModel, { sessionId, model: "deepseek/deepseek-reasoner", confirmLossy: true });

    // BODY-LEVEL (W18-19): the next turn reaches DeepSeek's own endpoint asking for its own id, AND
    // carries the conversation so far, in order. gpt is a HIDDEN-reasoning source, so there is no
    // reasoning to carry off it — the prompt this hop is about is precisely that loss, and the
    // confirmation above is where the user was told.
    await client.call(METHODS.sessionSend, { sessionId, text: "hop 1, on deepseek" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.filter((x) => x.type === "turn_completed").length >= 2, 90_000);
    expect(deepseek!.models).toContain("deepseek-reasoner");
    const deepseekBody = deepseek!.bodies.at(-1)!;
    expect(outOfOrder(deepseekBody, ["hop 0, on gpt", "hello from gpt", "hop 1, on deepseek"])).toEqual([]);
    expect(opaqueLeaks(deepseekBody)).toEqual([]);

    // HOP 2 — deepseek -> GLM. Complete exposed reasoning carries unmodified: SILENT, no prompt,
    // no confirmLossy.
    await client.call(METHODS.sessionSetModel, { sessionId, model: "zai/glm-5" });

    await client.call(METHODS.sessionSend, { sessionId, text: "hop 2, on glm" });
    await client.waitFor(() => client.events.filter((x) => x.type === "turn_completed").length >= 3, 90_000);
    expect(zai!.models).toContain("glm-5");
    // BODY-LEVEL (W18-19): the whole conversation in order, AND DeepSeek's reasoning re-rendered as
    // data the destination can read — which is exactly why this hop is silent: there is nothing to
    // warn about when the state carries. GLM is a full-exposed destination, so this takes the
    // THINKING-CHANNEL door, which renders the labelled plain-text form and no `kind` at all (see
    // `test/helpers/carriage.ts`).
    const zaiBody = zai!.bodies.at(-1)!;
    expect(outOfOrder(zaiBody, ["hop 0, on gpt", "hello from gpt", "hop 1, on deepseek", "hello from deepseek", "hop 2, on glm"])).toEqual([]);
    expect(carriesReasoning(zaiBody, { kind: "exposed", provider: "deepseek", text: "thinking about the hop" })).toBe(true);
    expect(opaqueLeaks(zaiBody)).toEqual([]);

    rmSync(cwd, { recursive: true, force: true });
  }, 240_000);
});

describeWithWinterBinary("A-7a: ONE canonical model on TWO providers switches SILENTLY (openai -> openrouter)", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
  let openrouter: Awaited<ReturnType<typeof startChatProviderFake>> | undefined;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "a7a-literal-")));
    openaiFakeRef = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: {}, unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello from openai"] }),
    });
    openrouter = await startChatProviderFake("hello from openrouter");
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "openai/gpt-4.1", baseUrl: openaiFakeRef.url },
      providers: { openrouter: { baseUrl: `${openrouter.fake.url}/v1` } },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-a7a-openai" });
    await writeCredentialMaterial(secrets, "openrouter:default", { kind: "api-key", key: "sk-test-a7a-openrouter" });
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
    await openaiFakeRef?.close();
    await openrouter?.fake.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("openai/gpt-4.1 -> openrouter/openai/gpt-4.1 never prompts; the destination it lands on depends on the child's lifetime (MEASURED)", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "a7a-literal-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "openai/gpt-4.1", cwd });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "before the provider change" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 90_000);
    const openaiTurns = (): number => openaiFakeRef!.requests.filter((r) => r.path.includes("/responses")).length;
    const beforeSwitch = openaiTurns();

    // A-7a'S OWN CLAIM: one canonical model on two providers switches SILENTLY — no `confirmLossy`,
    // no prompt, no refusal of any kind.
    await client.call(METHODS.sessionSetModel, { sessionId, model: "openrouter/openai/gpt-4.1" });

    // ════════════════════════════════════════════════════════════════════════════════════════════
    // MEASURED, 2026-09-15 (Lane P fix round 1) — A REAL FINDING, asserted rather than worked around.
    //
    // TWO resolvers disagree about a fully-qualified `<provider>/<model>` key when a SECOND
    // credentialled provider also serves the same canonical model:
    //
    //   - the ROUTER (`selectRuntimeFor`, which `planAndApplySwitch` and the durable record follow)
    //     canonicalises `openrouter/openai/gpt-4.1` to `gpt-4.1` and picks the first credentialled
    //     candidate row — `openai`. Measured directly against the pinned router: BOTH spellings
    //     answer `providerId: "openai"`.
    //   - Winter's own `providerSelectionFor` (which `optionsFor` uses to build the child's
    //     `Options.provider`/`connection` at every incarnation) takes a qualified key at its word —
    //     `openrouter`.
    //
    // So the endpoint a turn actually reaches depends on WHETHER THE CHILD WAS RESPAWNED. D1 round
    // 4's eviction cannot help: it compares the record's provider against the ROUTER's decision, and
    // the router does not think the provider changed at all. Both halves are pinned below so the
    // divergence is executable evidence rather than prose, and neither is the "right" answer this
    // lane gets to choose — reported to the controller.
    //
    // THE ONE-LINE FIX WAS MEASURED AND IS NOT SAFE TO TAKE HERE (fix round 2, item 4). The daemon
    // builds the router's input as `requested: { model }` and never sets `provider`, though
    // `candidatesFor` filters on it and `qualifiedProviderFor` already has the answer. Against the
    // pinned router 0.0.7, with the ONLY change being whether `requested.provider` is set:
    //
    //   openrouter/openai/gpt-4.1, both credentialled   → "openai"        | with provider → "openrouter"  ✅ fixes this
    //   gpt-5.6-sol, codex-oauth only                    → "codex-oauth"   | (unqualified; unaffected)      ✅ safe
    //   openai/gpt-5.6-sol, codex-oauth only             → "codex-oauth"   | with provider → slot-unservable ❌ BREAKS
    //
    // The third row looked like a reason not to take the change. IT IS NOT, and the correction
    // matters (review N1): that configuration is ALREADY refused, by Winter's own pre-turn gate —
    // a qualified key names its provider, so `openai/gpt-5.6-sol` on a Codex-only home is told to
    // add an OpenAI key at the first turn regardless of what the router would have routed. The
    // router follow-up would make the two doors AGREE rather than change the outcome; today they
    // disagree, which is the divergence this block exists to record.
    //
    // The standing ruling is that a user who explicitly picks provider X gets X's door, so both
    // doors owe the same answer. The change is still left to the router lane — it is a routing
    // change to the SELECTOR, whose blast radius reaches every host, not just this daemon — but not
    // because it would break a working configuration. It would not.
    // ════════════════════════════════════════════════════════════════════════════════════════════
    await client.call(METHODS.sessionSend, { sessionId, text: "on the live child" });
    await client.waitFor(() => client.events.filter((x) => x.type === "turn_completed").length >= 2, 90_000);
    expect(openaiTurns()).toBeGreaterThan(beforeSwitch);   // the LIVE child stayed on openai
    expect(openrouter!.models).toEqual([]);                 // ...and openrouter was never reached

    // The same session, after the child is replaced (an idle reap or a daemon restart does this for
    // a real user; `endAll()` is the door a test drives): the SAME stored model now routes to
    // OpenRouter, because `optionsFor` rebuilds the provider from the qualified key.
    await daemon!.winter!.endAll();
    await client.call(METHODS.sessionSend, { sessionId, text: "after the child was replaced" });
    await client.waitFor(() => client.events.filter((x) => x.type === "turn_completed").length >= 3, 90_000);
    // BODY-LEVEL (W18-19): OpenRouter's own spelling of the id (`openai/gpt-4.1`, the ROW's
    // upstreamId, not the Winter key) AND the conversation so far, in order — a rebuilt, empty
    // conversation on the right endpoint would pass a model-id check alone. Nothing is carried as
    // reasoning and nothing should be: the source is a hidden-reasoning OpenAI row whose turns
    // produced none, which is also why this hop is silent.
    expect(openrouter!.models).toContain("openai/gpt-4.1");
    const body = openrouter!.bodies.at(-1)!;
    expect(outOfOrder(body, ["before the provider change", "hello from openai", "on the live child", "after the child was replaced"])).toEqual([]);
    expect(opaqueLeaks(body)).toEqual([]);

    rmSync(cwd, { recursive: true, force: true });
  }, 240_000);
});
