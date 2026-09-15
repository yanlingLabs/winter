// Winter Phase 10b (Lane D2, task D2-2) — WS-18 §9 A-5: "the five-hop chain
// `claude -> deepseek -> GLM -> gpt -> claude` keeps one conversation." W18-19's own table and its
// prompt rule ("prompts appear exactly at claude -> deepseek and gpt -> claude") is BINDING.
//
// STRUCTURAL FINDING (2026-09-14, test fix round 1 — DEEPER than the original: reviewer's own
// suggested workaround was tried and does NOT work either): `session.create`/`session.setModel` can
// NEVER route to `deepseek` or `zai` (GLM) on this daemon build, REGARDLESS of loopback wiring.
// `providerSelectionFor` (`src/runtime-sdk/provider-selection.ts:69-98`) refuses any model whose
// provider has no row in `WINTER_CREDENTIAL_INVENTORY` (`src/runtime-sdk/keychain.ts:115-127`) — a
// FIXED array with exactly THREE rows (`openai`, `codex-oauth`, `anthropic`). review-lane-d2.md
// suggested pushing a `deepseek`/`zai` row into that array at test runtime (it is a real, mutable JS
// array despite its `readonly` TYPE) plus writing matching credential material — TRIED, SAFELY
// (no real network reached): this DOES get `session.create`/`setModel` to route the record to
// `winter-agent`/`deepseek` (the daemon's OWN bookkeeping succeeds), but the REAL spawned `dist/
// winter` child still refuses outright: `"...no credential is configured for provider \"deepseek\"
// — an OpenAI-compatible endpoint that is not a declared local installation needs one"` — a clean,
// typed refusal, not a network attempt. Root cause: `session-driver.ts`'s `optionsFor` builds a
// `connection`/local-declaration object for the child ONLY when `selection?.providerId === "openai"`
// (line ~406); there is no equivalent for any other provider, and no `startDaemon` test seam
// analogous to `officialConnectionOverride` to add one. The credential-inventory row makes the
// DAEMON believe a credential is configured; it does nothing for the CHILD's own separate need for
// an explicit connection/credential, which only the `openai` provider ever receives. This is true
// even though the pinned SDK's own catalog (0.0.11) carries full, real reasoning-continuity facts
// for both providers (proven below, directly against the REAL `daemonResolveEndpoint()`/
// `classifySwitch`) — the gap is in THIS daemon's own connection-building code, not the catalog, and
// not fixable from test code without a new seam in `packages/core/src/**` (out of scope for this
// lane). Reported to the controller: A-5's own request-body carriage assertions for the DeepSeek/GLM
// hops cannot be proven end to end until such a seam exists.
//
// SCOPE THIS FILE ACTUALLY COVERS, given that finding:
//   1. The PROMPT-TIMING half of A-5 (W18-19's own binding rule), proven against the REAL daemon
//      resolver and the REAL `classifySwitch` — never a fixture that fakes `readableState`/
//      `continuation` (the same discipline `test/providers/registry.test.ts`'s own D1-6 describe
//      block already established for two of these four pairs). The gpt -> claude cell is deliberately
//      NOT duplicated here as a classifySwitch-only check (review-lane-d2.md: "drop every substitute
//      a real session now covers") — Defect 1 is fixed, so Part 2 below and
//      `handoff-parity-e2e.test.ts`'s own A-1 already prove that exact pairing end to end through a
//      REAL session; only the two structurally-unreachable transitions (claude -> deepseek,
//      deepseek -> GLM, GLM -> gpt) keep a resolver-only check, each labeled as such.
//   2. The two REACHABLE endpoints of the chain (claude, gpt) through REAL daemon wiring — the
//      SAME two directions `handoff-parity-e2e.test.ts`'s A-1/A-2 already prove in depth, so this
//      file does not re-implement them; it only confirms the chain's own FIRST and LAST prompts
//      fire against a REAL session (not just the resolver).
//
// RESOLVED (WS-19, Lane P): the finding above is a HISTORICAL RECORD, accurate for when it was
// written — it is no longer this daemon's current state. W19-1 derives `WINTER_CREDENTIAL_INVENTORY`
// from the catalog (deepseek/zai/openrouter are now real, routable rows) and W19-6 gives
// `session-driver.ts`'s `optionsFor` a connection seam for any provider with a
// `settings.providers.<id>.baseUrl`, not just `openai`. Part 3 below now proves the FULL chain,
// BODY-LEVEL, on every hop — see its own header (and `test/helpers/carriage.ts`) for what "body-
// level" means and the two per-adapter carriage-tag forms it measures.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySwitch, type ContinuityEndpoint } from "@yanlinglabs/winter-provider-runtime";
import { openaiChatFake, openaiResponsesFake, startFake, type FakeServer } from "@yanlinglabs/winter-provider-conformance/fakes";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { daemonResolveEndpoint } from "../../src/providers/registry";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { carriesReasoning, opaqueLeaks, outOfOrder } from "../helpers/carriage";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

const CATALOG_GPT_MODEL = "openai/gpt-5.6-sol";
const CATALOG_CLAUDE_MODEL = "claude-sonnet-5";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part 1 — W18-19's prompt-timing table, over all four of the chain's real transitions, computed
// from the REAL catalog resolver + the REAL classifySwitch (never a fixture).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("A-5 part 1: the five-hop chain's prompt rule, against the REAL daemon resolver (no fixture)", () => {
  // Minor 5 (review-lane-d2-fix1.md): these `family` strings are HARDCODED literals, not derived
  // from a real `selectRuntimeFor` decision — there is no live daemon at this point to decide one
  // from. `createEndpointResolver` (provider-runtime 0.0.11+) memoizes by `modelKey` ALONE and keeps
  // whichever family the FIRST caller in the PROCESS supplied, so this is a real memo-poisoning
  // hazard for any OTHER test in the same `bun test` invocation that resolves the SAME model ids
  // with a DIFFERENT (real) family. Mitigated, not eliminated, by computing fresh inside each `test`
  // (module/describe-scope code runs during COLLECTION, before any test body, which is the worse
  // ordering) rather than once at describe scope — labeled here per that review's own instruction,
  // since a real decision genuinely isn't available without spinning up a daemon per case.
  const endpointsFresh = (): Record<"claude" | "deepseek" | "glm" | "gpt", ContinuityEndpoint> => {
    const resolve = daemonResolveEndpoint();
    return {
      claude: resolve({ providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5", family: "anthropic" }),
      deepseek: resolve({ providerId: "deepseek", modelKey: "deepseek/deepseek-reasoner", family: "deepseek" }),
      glm: resolve({ providerId: "zai", modelKey: "zai/glm-5", family: "glm" }),
      gpt: resolve({ providerId: "openai", modelKey: "openai/gpt-5.6-sol", family: "openai" }),
    };
  };

  test("catalog premises this whole table rests on (measured against SDK 0.0.11, the amendment's own GLM overlay)", () => {
    const endpoints = endpointsFresh();
    expect(endpoints.gpt.readableState).toBe("none"); // hidden reasoning source
    expect(endpoints.gpt.continuation).not.toBe("none");
    expect(endpoints.claude.readableState).not.toBe("full-exposed"); // native replay only within claude
    expect(endpoints.deepseek.readableState).toBe("full-exposed"); // complete exposed
    // The amendment's own point: GLM now carries real reasoning evidence (0.0.11), unlike 0.0.10.
    expect(endpoints.glm.readableState).toBe("full-exposed");
  });

  test("claude -> deepseek PROMPTS (a native/summary-only source crossing to a foreign family is warned-lossy)", () => {
    const endpoints = endpointsFresh();
    const c = classifySwitch(endpoints.claude, endpoints.deepseek, {});
    expect(c.lossClass).toBe("warned-lossy");
    expect(c.warnings.length).toBeGreaterThan(0);
  });

  test("deepseek -> GLM is SILENT (complete exposed reasoning carries unmodified)", () => {
    const endpoints = endpointsFresh();
    const c = classifySwitch(endpoints.deepseek, endpoints.glm, { exposedComplete: true });
    expect(c.lossClass).not.toBe("warned-lossy");
  });

  test("GLM -> gpt is SILENT (complete exposed reasoning still carries, now as a tag on a hidden-reasoning destination)", () => {
    const endpoints = endpointsFresh();
    const c = classifySwitch(endpoints.glm, endpoints.gpt, { exposedComplete: true });
    expect(c.lossClass).not.toBe("warned-lossy");
  });

  // gpt -> claude's OWN prompt is deliberately NOT a classifySwitch-only check here (review-lane-
  // d2.md: "drop every substitute a real session now covers") — Defect 1 is fixed, so Part 2 below
  // (and handoff-parity-e2e.test.ts's own A-1) prove this exact pairing end to end through a REAL
  // session instead.
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part 2 — the chain's two REACHABLE endpoints (claude, gpt), through REAL daemon wiring: the FIRST
// hop's own source prompt (claude -> [a foreign family]) and the LAST hop's own prompt (gpt ->
// claude), each measured directly against a real session.setModel call — never inferred from the
// resolver alone. The actual round trip past the prompt is GREEN and covered in depth by
// `handoff-parity-e2e.test.ts`'s own A-1/A-2 (Defects 1/2 both fixed); this file does not repeat
// that depth, only confirms the CHAIN's own two prompting edges fire against a live session — Part 3
// below covers the FULL chain, body-level, on every hop.
// ════════════════════════════════════════════════════════════════════════════════════════════════
interface RpcErrorLike { rpc?: { message?: string; data?: { code?: string; warnings?: string[] } } }

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

describeWithWinterBinary("A-5 part 2: the chain's LAST hop (gpt -> claude) prompts against a real session", (winterBin) => {
  describeWithClaudeRuntime("gpt -> claude", () => {
    let home: string;
    let daemon: RunningDaemon | undefined;
    let client: TestClient;
    let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
    let anthropicFakeClose: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "five-hop-")));
      const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
        scenarios: {}, unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello from gpt"] }),
      });
      openaiFakeRef = openaiFake;
      const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
      const anthropicFakeServer = await startFake({
        routes: [{
          path: "*",
          handler: async (_req, recorded) => (recorded.path === "/v1/messages" && recorded.method === "POST"
            ? anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["hi"] }], stopReason: "end_turn" } as AnthropicTurnScript)
            : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
        }],
      });
      anthropicFakeClose = () => anthropicFakeServer.close();
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "openai-compatible", model: CATALOG_GPT_MODEL, baseUrl: openaiFake.url },
        runtimes: { winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
      }, null, 2));
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-5hop" });
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-5hop-anthropic" });
      daemon = await startDaemon({
        home, secrets, agentProvider: null,
        officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeServer.url }, authFamily: "custom" }),
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

    test("gpt -> claude prompts, exactly as part 1's table computed", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "five-hop-cwd-")));
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      await client.call(METHODS.sessionSend, { sessionId, text: "the chain's last hop" });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

      let caught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });
      } catch (err) { caught = err as RpcErrorLike; }
      expect(caught).toBeDefined();
      expect(caught!.rpc?.data?.code).toBe("handoff_confirmation_required");
      expect(caught!.rpc?.data?.warnings?.length ?? 0).toBeGreaterThan(0);
      // The actual resumed round trip past this prompt is GREEN and covered in depth by
      // `handoff-parity-e2e.test.ts`'s own A-1 (same pairing) — not repeated here.

      rmSync(cwd, { recursive: true, force: true });
    }, 90_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part 3 — THE WHOLE CHAIN, BODY-LEVEL ON EVERY HOP (WS-19, Lane P).
//
// This file's header records, accurately for when it was written, why the two middle hops were
// structurally unreachable: `WINTER_CREDENTIAL_INVENTORY` was a four-row literal so
// `providerSelectionFor` could never name `deepseek` or `zai`, and `session-driver.ts`'s
// `optionsFor` built a provider connection ONLY for `providerId === "openai"`, so even the
// reviewer's own suggested workaround (injecting an inventory row at runtime) left the real child
// refusing outright. The header's diagnosis named BOTH halves exactly, and WS-19 removed both:
// W19-1 derives the inventory from the catalog, W19-6 builds a connection for any provider with a
// `settings.providers.<id>.baseUrl`. Parts 1 and 2 stand as written; this part adds the chain they
// could not run.
//
// "BODY-LEVEL" MEANS W18-19'S CARRIAGE, not merely the routing (corrected after review — the first
// pass of this block asserted only that each body named the provider's own upstream model id, which
// an empty, rebuilt conversation on the right endpoint would also satisfy). Every hop below asserts
// three things about the bytes that actually went out:
//
//   (a) the PRIOR TURNS are there, IN ORDER — the same conversation continued, not a fresh one;
//   (b) the prior model's REASONING is carried as data with its own provenance, where W18-19 says it
//       should be: `kind="summary"` off the Claude source, `kind="exposed"` off DeepSeek and GLM;
//   (c) NO OPAQUE STATE crosses — no `signature`, `encrypted_content` or `redacted_thinking` in the
//       conversation, and the Claude turn's own scripted signature value appears in no body at all.
//
// The carriage TAG's form is per-adapter and is MEASURED, not assumed — see `test/helpers/carriage.ts`
// for both renderings and why asserting only the angle-bracket one would have made every
// chat-completions hop read as a defect.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const CATALOG_DEEPSEEK_MODEL = "deepseek/deepseek-reasoner";
/** The Claude turn's scripted thinking and its opaque signature — the text MUST carry as summary
 *  data, the signature MUST NOT appear in any request body anywhere. */
const CLAUDE_THINKING = "claude was thinking here";
const CLAUDE_SIGNATURE = "sig-claude-hop0";
const CATALOG_GLM_MODEL = "zai/glm-5";

/** One loopback OpenAI-chat-completions provider (deepseek and zai both ride that adapter),
 *  recording the model id each request asked for. */
async function startChainChatFake(reply: string, reasoning?: string[]): Promise<{ fake: FakeServer; models: string[]; bodies: string[] }> {
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

describeWithWinterBinary("A-5 part 3: claude -> deepseek -> GLM -> gpt -> claude, every hop on its own provider", (winterBin) => {
  describeWithClaudeRuntime("the chain", () => {
    let home: string;
    let daemon: RunningDaemon | undefined;
    let client: TestClient;
    let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
    let anthropicFakeServer: FakeServer | undefined;
    let deepseek: Awaited<ReturnType<typeof startChainChatFake>> | undefined;
    let glm: Awaited<ReturnType<typeof startChainChatFake>> | undefined;

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "five-hop-chain-")));
      openaiFakeRef = await openaiResponsesFake.startOpenAiResponsesFake({
        scenarios: {}, unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello from gpt"] }),
      });
      const { startFake: startAnthropic, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
      anthropicFakeServer = await startAnthropic({
        routes: [{
          path: "*",
          handler: async (_req, recorded) => (recorded.path === "/v1/messages" && recorded.method === "POST"
            ? anthropicFake.anthropicTurnResponse({ blocks: [{ type: "thinking", chunks: [CLAUDE_THINKING], signature: CLAUDE_SIGNATURE }, { type: "text", chunks: ["hello from claude"] }], stopReason: "end_turn" } as AnthropicTurnScript)
            : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
        }],
      });
      // DeepSeek's exposed reasoning channel: the deepseek -> GLM hop is only classified SILENT when
      // the session actually carries complete exposed reasoning, so the fake has to produce some.
      deepseek = await startChainChatFake("hello from deepseek", ["reasoning on the deepseek hop"]);
      glm = await startChainChatFake("hello from glm", ["reasoning on the glm hop"]);
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "openai-compatible", model: CATALOG_GPT_MODEL, baseUrl: openaiFakeRef.url },
        providers: { deepseek: { baseUrl: `${deepseek.fake.url}/v1` }, zai: { baseUrl: `${glm.fake.url}/v1` } },
        runtimes: {
          winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable,
          winterIdleTimeoutSec: 60, handoff: { crossRuntime: true },
        },
      }, null, 2));
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-chain-openai" });
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-chain-anthropic" });
      // W19-1: these two slots did not exist before WS-19.
      await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-test-chain-deepseek" });
      await writeCredentialMaterial(secrets, "zai:default", { kind: "api-key", key: "sk-test-chain-zai" });
      daemon = await startDaemon({
        home, secrets, agentProvider: null,
        officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeServer!.url }, authFamily: "custom" }),
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
      await anthropicFakeServer?.close();
      await deepseek?.fake.close();
      await glm?.fake.close();
      rmSync(home, { recursive: true, force: true });
    });

    test("every hop runs on its own provider, and the prompts fall exactly where W18-19's table says", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "five-hop-chain-cwd-")));
      const turns = (): number => client.events.filter((e) => e.type === "turn_completed").length;
      // NOTHING stands in for an idle reap here any more. Lane P's first round had to force a fresh
      // incarnation between hops because a same-leg provider change did not reach the live child;
      // D1 round 4 evicts it, so every hop below changes provider on its own. If that eviction
      // regressed, the destination fake would simply never be reached and these assertions fail.

      // HOP 0 — claude, on the OFFICIAL leg.
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL, cwd });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(daemon!.winter!.legOf(sessionId)).toBe("official");
      await client.call(METHODS.sessionSend, { sessionId, text: "hop 0, on claude" });
      await client.waitFor(() => turns() >= 1, 120_000);
      expect(anthropicFakeServer!.requests.some((r) => r.path === "/v1/messages")).toBe(true);

      // HOP 1 — claude -> deepseek. A native/summary-only source crossing to a foreign family, AND
      // a cross-runtime move: PROMPTS (part 1's own table).
      let caught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_DEEPSEEK_MODEL });
      } catch (err) { caught = err as RpcErrorLike; }
      expect(caught?.rpc?.data?.code).toBe("handoff_confirmation_required");
      await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_DEEPSEEK_MODEL, confirmLossy: true });
      expect(daemon!.winter!.legOf(sessionId)).toBe("winter");
      await client.call(METHODS.sessionSend, { sessionId, text: "hop 1, on deepseek" });
      await client.waitFor(() => turns() >= 2, 120_000);
      expect(deepseek!.models).toContain("deepseek-reasoner");
      const deepseekBody = deepseek!.bodies.at(-1)!;
      expect(outOfOrder(deepseekBody, ["hop 0, on claude", "hello from claude", "hop 1, on deepseek"])).toEqual([]);
      // (b) the Claude turn's thinking, carried as data with its own provenance — the lossy carriage
      // the prompt above warned about, actually delivered rather than dropped. DeepSeek is
      // full-exposed, so this hop takes the THINKING-CHANNEL door, which renders no `kind`: the
      // `kind` half of W18-19's table is proven on hop 3, whose destination takes the tag door.
      expect(carriesReasoning(deepseekBody, { kind: "summary", provider: "anthropic", text: CLAUDE_THINKING })).toBe(true);
      // (c) ...and the signature that made it opaque stays behind.
      expect(opaqueLeaks(deepseekBody, [CLAUDE_SIGNATURE])).toEqual([]);

      // HOP 2 — deepseek -> GLM. Complete exposed reasoning carries unmodified: SILENT.
      await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_GLM_MODEL });
      await client.call(METHODS.sessionSend, { sessionId, text: "hop 2, on glm" });
      await client.waitFor(() => turns() >= 3, 120_000);
      expect(glm!.models).toContain("glm-5");
      const glmBody = glm!.bodies.at(-1)!;
      expect(outOfOrder(glmBody, ["hop 0, on claude", "hello from claude", "hop 1, on deepseek", "hello from deepseek", "hop 2, on glm"])).toEqual([]);
      // BOTH prior models' reasoning is still travelling — the chain accumulates, it does not
      // replace, which is what "keeps one conversation" means five hops in. GLM is full-exposed too,
      // so this is the thinking-channel door again and carries no `kind`.
      expect(carriesReasoning(glmBody, { kind: "summary", provider: "anthropic", text: CLAUDE_THINKING })).toBe(true);
      expect(carriesReasoning(glmBody, { kind: "exposed", provider: "deepseek", text: "reasoning on the deepseek hop" })).toBe(true);
      expect(opaqueLeaks(glmBody, [CLAUDE_SIGNATURE])).toEqual([]);

      // HOP 3 — GLM -> gpt. Still SILENT: the exposed state carries as a tag on a hidden-reasoning
      // destination.
      await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_GPT_MODEL });
      await client.call(METHODS.sessionSend, { sessionId, text: "hop 3, on gpt" });
      await client.waitFor(() => turns() >= 4, 120_000);
      const gptRequests = openaiFakeRef!.requests.filter((r) => r.path.includes("/responses"));
      expect(gptRequests.length).toBeGreaterThan(0);
      const gptBody = gptRequests.at(-1)!.body;
      expect(outOfOrder(gptBody, ["hop 0, on claude", "hello from claude", "hop 1, on deepseek", "hello from deepseek", "hop 2, on glm", "hello from glm", "hop 3, on gpt"])).toEqual([]);
      // THE LITERAL W18-19 TAG: `openai` rides the `openai-responses` adapter, which renders the
      // angle-bracket form — all THREE prior models, each with its own kind and provenance.
      expect(gptBody).toContain(`<recovered_reasoning kind=\\"summary\\" provider=\\"anthropic\\"`);
      expect(gptBody).toContain(`<recovered_reasoning kind=\\"exposed\\" provider=\\"deepseek\\"`);
      expect(gptBody).toContain(`<recovered_reasoning kind=\\"exposed\\" provider=\\"zai\\"`);
      expect(carriesReasoning(gptBody, { kind: "exposed", provider: "zai", text: "reasoning on the glm hop" })).toBe(true);
      expect(opaqueLeaks(gptBody, [CLAUDE_SIGNATURE])).toEqual([]);

      // HOP 4 — gpt -> claude. PROMPTS, and moves back to the official leg.
      let caught2: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });
      } catch (err) { caught2 = err as RpcErrorLike; }
      expect(caught2?.rpc?.data?.code).toBe("handoff_confirmation_required");

      // (c) once more across EVERY body every fake received, including the Anthropic source's own:
      // the Claude turn's signature is in none of them, and no conversation anywhere carries an
      // opaque field name.
      const everyBody = [
        ...deepseek!.bodies, ...glm!.bodies,
        ...openaiFakeRef!.requests.map((r) => r.body),
        ...anthropicFakeServer!.requests.map((r) => r.body),
      ];
      for (const body of everyBody) expect(opaqueLeaks(body, [CLAUDE_SIGNATURE])).toEqual([]);

      // ONE conversation throughout: every hop's user message is still in the session's own log.
      const history = await client.call<{ events: Array<{ type: string; text?: string }> }>(METHODS.sessionHistory, { sessionId, limit: 500 });
      const userTexts = history.events.filter((e) => e.type === "user_message").map((e) => e.text ?? "");
      for (const hop of ["hop 0, on claude", "hop 1, on deepseek", "hop 2, on glm", "hop 3, on gpt"]) {
        expect(userTexts.some((t) => t.includes(hop))).toBe(true);
      }

      rmSync(cwd, { recursive: true, force: true });
    }, 600_000);
  });
});
