// Winter Phase 10b (Lane D2, task D2-3) — spec WS-18 §9's A-6 (no credential), A-7 (same-leg loss),
// A-7a (same family, silent), plus the controller's own C1 addendum item (a same-leg model change
// must not leave the pre-flight review reading a STALE recorded model before a later cross-runtime
// move).
//
// STRUCTURAL FINDING (2026-09-14, same root cause `five-hop-chain-e2e.test.ts` documents in depth):
// `WINTER_CREDENTIAL_INVENTORY` (`src/runtime-sdk/keychain.ts:115-127`) has exactly three rows —
// `openai`, `codex-oauth`, `anthropic` — so NEITHER `deepseek` NOR `zai` (GLM) NOR any OpenRouter-style
// row can ever be routed to (`session.create`/`session.setModel` both refuse `runtime_selection_refused`
// before any HTTP request is attempted, MEASURED against this exact daemon build). This blocks, via
// REAL daemon wiring:
//   - A-7's OWN literal pairing ("gpt -> deepseek on Winter prompts; deepseek -> GLM does not");
//   - A-7a's OWN literal "Claude on Anthropic -> Claude on OpenRouter" case;
//   - the controller's OWN C1 addendum's literal "GPT -> DeepSeek -> GPT -> Claude" chain (it cannot
//     even reach the first step).
// Substituted below with the CLOSEST achievable real-wiring equivalents (two real, same-family,
// differently-reasoning-capable OpenAI catalog rows: `openai/gpt-5.4`, no reasoning at all, and
// `openai/gpt-5.6-sol`, hidden reasoning) plus the SAME real-resolver/real-`classifySwitch` technique
// `five-hop-chain-e2e.test.ts` already established for the literal DeepSeek/GLM pairing — never a
// fixture that fakes `readableState`/`continuation`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySwitch, sameFamily } from "@yanlinglabs/winter-provider-runtime";
import { openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { renderNoCredentialHint } from "../../src/runtime-sdk/handoff";
import { daemonResolveEndpoint } from "../../src/providers/registry";
import { describeWithWinterBinary } from "../helpers/winter-binary";
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
    // MEASURED (2026-09-14): RED, exactly matching the controller's own prediction. `review.prompt`
    // comes back FALSE — the review reads gpt-5.4's OWN stale facts (no reasoning, lossless-native)
    // rather than gpt-5.6-sol's (hidden reasoning, warned-lossy) — so `session.setModel` proceeds
    // PAST the (missing) prompt with no `confirmLossy` at all, all the way into a REAL handoff
    // attempt, which then times out on Defect 1 (`handoff-parity-e2e.test.ts`'s own header) ~31s
    // later and reports `handoff_lossy_fork` instead of ever reaching `handoff_confirmation_required`.
    // Per the controller: "expected red until router 0.0.6 + the D1 C1 fix." Never skipped, never
    // weakened.
    let caught: RpcErrorLike | undefined;
    try {
      await client.call(METHODS.sessionSetModel, { sessionId, model: "claude-sonnet-5" });
    } catch (err) { caught = err as RpcErrorLike; }
    expect(caught).toBeDefined();
    expect(caught!.rpc?.data?.code).toBe("handoff_confirmation_required");

    rmSync(cwd, { recursive: true, force: true });
  }, 90_000);
});
