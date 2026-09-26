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
//      block already established for two of these four pairs).
//   2. The chain's LAST prompt (gpt -> claude) against a REAL session (part 2).
//
// WS-23: the official `claude` leg this file's Claude hops once ran on is retired — every hop,
// Claude's included, runs on the Winter runtime, and the retired cross-runtime parity files that
// parts 1 and 2 used to lean on are gone with it.
//
// WS-23 (reasoning-state, decision 9 — SDK b5a79db): W18-19's prompt rule ("prompts appear exactly at
// claude -> deepseek and gpt -> claude") is SUPERSEDED. Both prompts were over reasoning a hidden-
// reasoning source could not hand on; that reasoning now stays in the provider-state sidecar for its
// own model and replays on a switch back (hop 4 below measures exactly that), so NO hop of this chain
// prompts. A switch prompts only over what the target cannot represent — images or documents for a
// text-only model, another vendor's server-tool steps, a compaction the fit check will run, an
// interrupted turn — and part 2 keeps a real-session prompt on the one of those a text-only session
// can reach: a conversation the chain's own GLM cannot hold.
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
import type { anthropicFake as AnthropicFakeModule } from "@yanlinglabs/winter-provider-conformance";

type AnthropicTurnScript = Parameters<typeof AnthropicFakeModule.anthropicTurnResponse>[0];

const CATALOG_GPT_MODEL = "openai/gpt-5.6-sol";
const CATALOG_CLAUDE_MODEL = "anthropic/claude-sonnet-5";

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
      deepseek: resolve({ providerId: "deepseek", modelKey: "deepseek/deepseek-v4-pro", family: "deepseek" }),
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

  // WS-23 (reasoning-state, user decision 9): Claude's signed thinking stays in the sidecar for Claude and
  // replays on the hop back, so crossing to DeepSeek is no longer a prompt; unreadable media still is.
  test("claude -> deepseek is SILENT over reasoning (WS-23: kept for Claude), and prompts over media DeepSeek cannot read", () => {
    const endpoints = endpointsFresh();
    const c = classifySwitch(endpoints.claude, endpoints.deepseek, {});
    expect(c.lossClass).toBe("lossless-portable");
    expect(c.warnings).toEqual([]);
    expect(classifySwitch(endpoints.claude, endpoints.deepseek, { unreadableMedia: 2 }).lossClass).toBe("warned-lossy");
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
  // d2.md: "drop every substitute a real session now covers") — Part 2 below proves this exact
  // pairing through a REAL session instead, and Part 3's hop 4 the round trip past the prompt.
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part 2 — the chain's two REACHABLE endpoints (claude, gpt), through REAL daemon wiring: the FIRST
// hop's own source prompt (claude -> [a foreign family]) and the LAST hop's own prompt (gpt ->
// claude), each measured directly against a real session.setModel call — never inferred from the
// resolver alone. Part 3 below covers the FULL chain, body-level, on every hop.
// WS-23: gpt -> claude is measured SILENT now; the real-session prompt moves to a hop the target
// cannot hold (see this file's header).
// ════════════════════════════════════════════════════════════════════════════════════════════════
interface RpcErrorLike { rpc?: { message?: string; data?: { code?: string; warnings?: string[]; portable?: string[]; fit?: { fits: boolean; estimatedTokens: number; window: number } } } }

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

// WS-23: Claude runs on the Winter runtime too now — the Anthropic fake is reached through
// `settings.providers.anthropic.baseUrl`, the same per-provider door every other hop uses.
describeWithWinterBinary("A-5 part 2: the chain's LAST hop (gpt -> claude) is silent against a real session; a hop the target cannot hold prompts", (winterBin) => {
  describe("gpt -> claude", () => {
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
        schemaVersion: 3,
        provider: { model: CATALOG_GPT_MODEL },
        providers: { openai: { baseUrl: openaiFake.url }, anthropic: { baseUrl: anthropicFakeServer.url } },
        runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60 },
      }, null, 2));
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-5hop" });
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-5hop-anthropic" });
      // The GLM hop only has to PROMPT here, never to run, but `selectRuntimeFor` refuses a provider
      // with no credential before the review is ever reached.
      await writeCredentialMaterial(secrets, "zai:default", { kind: "api-key", key: "sk-test-5hop-zai" });
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
      await anthropicFakeClose?.();
      rmSync(home, { recursive: true, force: true });
    });

    test("gpt -> claude is SILENT (WS-23: gpt's reasoning stays in the sidecar), and the session really moves to claude", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "five-hop-cwd-")));
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      await client.call(METHODS.sessionSend, { sessionId, text: "the chain's last hop" });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

      // No `confirmLossy`: a prompt here throws `handoff_confirmation_required` and fails the test.
      await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });
      expect(d.runtimeState.records.get(sessionId)?.providerId).toBe("anthropic");
      // The body-level round trip past this hop is part 3's hop 4 below.

      rmSync(cwd, { recursive: true, force: true });
    }, 90_000);

    // The prompt part 2 used to measure, kept on a loss WS-23 still counts: the same gpt session shape,
    // but ~700k characters of conversation (~220k tokens by the review's estimate) toward the chain's
    // own GLM, whose 200k window cannot hold it — the fit check will compact on gpt first, and the
    // confirmation says so, with the fit itself in the error data.
    test("gpt -> GLM with a conversation GLM cannot hold PROMPTS, carrying the fit and naming gpt as the summarizer", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "five-hop-cwd-")));
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      await client.call(METHODS.sessionSend, { sessionId, text: `a long document: ${"a".repeat(700_000)}` });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

      let caught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: "zai/glm-5" });
      } catch (err) { caught = err as RpcErrorLike; }
      expect(caught).toBeDefined();
      expect(caught!.rpc?.data?.code).toBe("handoff_confirmation_required");
      expect(caught!.rpc?.data?.fit?.fits).toBe(false);
      expect(caught!.rpc?.data?.fit?.window).toBe(200_000);
      expect(caught!.rpc?.data?.fit?.estimatedTokens ?? 0).toBeGreaterThan(200_000);
      expect(caught!.rpc?.data?.warnings?.some((w) => w.includes(`so ${CATALOG_GPT_MODEL} will summarize its older part`))).toBe(true);
      // Unconfirmed, nothing moved.
      expect(d.runtimeState.records.get(sessionId)?.providerId).toBe("openai");

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
//       should be: `kind="summary"` off a hidden-reasoning source (Claude, GPT), `kind="exposed"`
//       off DeepSeek and GLM — including on ROW 4, the Claude destination (the official leg's
//       until WS-23; the Winter runtime's Anthropic adapter since);
//   (c) NO OPAQUE STATE crosses — no `signature`, `encrypted_content` or `redacted_thinking` in the
//       conversation, and the Claude turn's own scripted signature value appears in no body at all.
//
// The carriage TAG's form is per-adapter and is MEASURED, not assumed — see `test/helpers/carriage.ts`
// for both renderings and why asserting only the angle-bracket one would have made every
// chat-completions hop read as a defect.
//
// ── A W18-19 ROW-4 CONTINUITY FINDING, MEASURED 2026-09-15 (review N4) — CLOSED BY WS-23 ─────────
// (On the Winter runtime the Claude destination replays hop 0's thinking natively, signature and all;
// the account below is the official leg's, kept as the record of what it did.)
// Hop 4's Claude-destination body carries the WHOLE conversation from hop 0 in order — every user
// turn and every assistant reply, including the Claude turn the chain started with — and it carries
// the reasoning of all three FOREIGN families as `<recovered_reasoning>` tags (`kind="summary"` for
// GPT, `kind="exposed"` for DeepSeek and GLM). What it does NOT carry is hop 0's OWN thinking: the
// Claude turn that opened the chain comes back as text alone, its reasoning gone.
//
// That is a real gap in the round trip — a session that starts on Claude, travels, and returns loses
// exactly the state Claude could have replayed natively — but whether it SHOULD carry is a spec
// question about same-family replay across an intervening foreign leg, not something this lane gets
// to decide by writing an assertion. So it is pinned as ABSENT (so a later fix has to come here and
// say so deliberately) and reported to the controller rather than asserted as correct.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const CATALOG_DEEPSEEK_MODEL = "deepseek/deepseek-v4-pro";
/** The Claude turn's scripted thinking and its opaque signature — the text MUST carry as summary
 *  data, the signature MUST NOT appear in any request body anywhere. */
const CLAUDE_THINKING = "claude was thinking here";
const CLAUDE_SIGNATURE = "sig-claude-hop0";
/** GPT's own turn is HIDDEN-reasoning: a readable summary that MAY carry to a foreign family, and
 *  an opaque `encrypted_content` blob that may not. Hop 4 is where both are tested. */
const GPT_SUMMARY = "gpt summarised its reasoning here";
const GPT_ENCRYPTED = "ENC-DUMMY-FIVEHOP-GPT";
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
  describe("the chain", () => {
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
        scenarios: {},
        // GPT's turn carries a HIDDEN reasoning item: an opaque `encrypted_content` blob plus a
        // readable summary. Both halves are load-bearing for hop 4 — the summary is the only thing
        // that can carry to a foreign family, and the blob is the thing that must NOT.
        unknownModel: async () => openaiResponsesFake.responsesStream({
          text: ["hello from gpt"],
          summary: [GPT_SUMMARY],
          reasoningItems: [{ index: 0, encrypted: GPT_ENCRYPTED, summaryText: GPT_SUMMARY }],
        }),
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
        schemaVersion: 3,
        provider: { model: CATALOG_GPT_MODEL },
        providers: {
          openai: { baseUrl: openaiFakeRef.url },
          deepseek: { baseUrl: `${deepseek.fake.url}/v1` }, zai: { baseUrl: `${glm.fake.url}/v1` },
          anthropic: { baseUrl: anthropicFakeServer.url },
        },
        runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60 },
      }, null, 2));
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-chain-openai" });
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-chain-anthropic" });
      // W19-1: these two slots did not exist before WS-19.
      await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-test-chain-deepseek" });
      await writeCredentialMaterial(secrets, "zai:default", { kind: "api-key", key: "sk-test-chain-zai" });
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
      await anthropicFakeServer?.close();
      await deepseek?.fake.close();
      await glm?.fake.close();
      rmSync(home, { recursive: true, force: true });
    });

    test("every hop runs on its own provider, and no hop prompts (WS-23: every model's reasoning stays in the sidecar)", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "five-hop-chain-cwd-")));
      const turns = (): number => client.events.filter((e) => e.type === "turn_completed").length;
      // NOTHING stands in for an idle reap here any more. Lane P's first round had to force a fresh
      // incarnation between hops because a same-leg provider change did not reach the live child;
      // D1 round 4 evicts it, so every hop below changes provider on its own. If that eviction
      // regressed, the destination fake would simply never be reached and these assertions fail.

      // HOP 0 — claude (on the Winter runtime since WS-23).
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL, cwd });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(daemon!.winter!.legOf(sessionId)).toBe("winter");
      await client.call(METHODS.sessionSend, { sessionId, text: "hop 0, on claude" });
      await client.waitFor(() => turns() >= 1, 120_000);
      expect(anthropicFakeServer!.requests.some((r) => r.path === "/v1/messages")).toBe(true);

      // HOP 1 — claude -> deepseek. A native/summary-only source crossing to a foreign family. WS-23:
      // SILENT (part 1's table) — Claude's signed thinking stays in the sidecar for Claude, and hop 4
      // proves it comes back. No `confirmLossy`: a prompt here throws and fails the test.
      await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_DEEPSEEK_MODEL });
      expect(daemon!.winter!.legOf(sessionId)).toBe("winter");
      await client.call(METHODS.sessionSend, { sessionId, text: "hop 1, on deepseek" });
      await client.waitFor(() => turns() >= 2, 120_000);
      expect(deepseek!.models).toContain("deepseek-v4-pro");
      const deepseekBody = deepseek!.bodies.at(-1)!;
      expect(outOfOrder(deepseekBody, ["hop 0, on claude", "hello from claude", "hop 1, on deepseek"])).toEqual([]);
      // (b) the Claude turn's thinking, carried as data with its own provenance — the readable part of
      // it, as the capped decoration WS-23 keeps (decision 2). DeepSeek is
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

      // HOP 4 — gpt -> claude. WS-23: SILENT, like every hop before it (part 2 measures the same
      // pairing on its own). The turn actually runs — W18-19's ROW 4: a Claude destination, whose
      // `readableState` is not full-exposed, so it takes the TAG door.
      const anthropicTurnsBefore = anthropicFakeServer!.requests.filter((r) => r.path === "/v1/messages").length;
      await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });
      expect(daemon!.winter!.legOf(sessionId)).toBe("winter");
      await client.call(METHODS.sessionSend, { sessionId, text: "hop 4, back on claude" });
      await client.waitFor(() => turns() >= 5, 120_000);
      const claudeRequests = anthropicFakeServer!.requests.filter((r) => r.path === "/v1/messages");
      expect(claudeRequests.length).toBeGreaterThan(anthropicTurnsBefore);
      const claudeBody = claudeRequests.at(-1)!.body;
      // The WHOLE chain, from hop 0, in order — MEASURED (review N4): the Claude destination does
      // receive the Claude turn it started with, so the needles start where the conversation does.
      expect(outOfOrder(claudeBody, ["hop 0, on claude", "hello from claude", "hop 1, on deepseek", "hello from deepseek", "hop 2, on glm", "hello from glm", "hop 3, on gpt", "hop 4, back on claude"])).toEqual([]);
      // ...AND hop 0's own THINKING, replayed NATIVELY — a `thinking` block carrying its signature,
      // same-domain replay. MEASURED 2026-09-25 (WS-23): the row-4 gap this block's header records
      // was the retired official leg's; the Winter runtime's Anthropic adapter closes it. Pinned as
      // carried, so a regression has to come here and say so.
      expect(claudeBody).toContain(`{"type":"thinking","thinking":"${CLAUDE_THINKING}","signature":"${CLAUDE_SIGNATURE}"}`);
      // THE TAG DOOR, all three prior families: GPT is hidden-reasoning, so its readable SUMMARY is
      // what carries (`kind="summary"`); DeepSeek and GLM are full-exposed sources, so theirs carry
      // as `kind="exposed"`.
      expect(carriesReasoning(claudeBody, { kind: "summary", provider: "openai", text: GPT_SUMMARY })).toBe(true);
      expect(carriesReasoning(claudeBody, { kind: "exposed", provider: "deepseek", text: "reasoning on the deepseek hop" })).toBe(true);
      expect(carriesReasoning(claudeBody, { kind: "exposed", provider: "zai", text: "reasoning on the glm hop" })).toBe(true);
      // ...and GPT's OPAQUE half stays behind. `encrypted_content` is what the Responses leg calls
      // it and `itemJson` is what Winter's own `reasoning_item` calls it; neither the field names nor
      // the blob itself may cross a family boundary.
      expect(claudeBody).not.toContain(GPT_ENCRYPTED);
      expect(claudeBody).not.toContain("itemJson");
      // N5: the SAME Anthropic exemption the everyBody sweep below installs — a Claude destination
      // may legitimately carry a `signature` for its own same-domain native replay, and this body is
      // a Claude destination. `encrypted_content`/`redacted_thinking` and GPT's blob stay barred.
      expect(opaqueLeaks(claudeBody, [GPT_ENCRYPTED]).filter((leak) => leak !== "signature")).toEqual([]);

      // (c) once more across EVERY body every fake received: no conversation carries an opaque field
      // name, and the two scripted opaque VALUES cross nothing.
      //
      // THE ANTHROPIC BODIES ARE EXEMPT FROM THE `signature` NAME CHECK, deliberately and in
      // ADVANCE: a Claude destination replaying Claude's OWN thinking is SAME-DOMAIN native replay —
      // exactly what W18-19 wants to happen, and it carries a `signature` field legitimately. A
      // names-only bar there would fail the very behaviour it is meant to protect.
      //
      // MEASURED (WS-23): the exemption IS load-bearing now — hop 4's request carries hop 0's native
      // `thinking` block with its `signature`, the same-domain replay the rule was written to allow.
      //
      // What must never happen is that signature reaching a FOREIGN family, so its VALUE is asserted
      // absent from every non-Anthropic body, and `encrypted_content`/`redacted_thinking` stay barred
      // everywhere, including here.
      const foreignBodies = [
        ...deepseek!.bodies, ...glm!.bodies,
        ...openaiFakeRef!.requests.map((r) => r.body),
      ];
      for (const body of foreignBodies) expect(opaqueLeaks(body, [CLAUDE_SIGNATURE, GPT_ENCRYPTED])).toEqual([]);
      for (const body of anthropicFakeServer!.requests.map((r) => r.body)) {
        expect(opaqueLeaks(body, [GPT_ENCRYPTED]).filter((leak) => leak !== "signature")).toEqual([]);
      }

      // ONE conversation throughout: every hop's user message is still in the session's own log.
      const history = await client.call<{ events: Array<{ type: string; text?: string }> }>(METHODS.sessionHistory, { sessionId, limit: 500 });
      const userTexts = history.events.filter((e) => e.type === "user_message").map((e) => e.text ?? "");
      for (const hop of ["hop 0, on claude", "hop 1, on deepseek", "hop 2, on glm", "hop 3, on gpt", "hop 4, back on claude"]) {
        expect(userTexts.some((t) => t.includes(hop))).toBe(true);
      }

      rmSync(cwd, { recursive: true, force: true });
    }, 600_000);
  });
});
