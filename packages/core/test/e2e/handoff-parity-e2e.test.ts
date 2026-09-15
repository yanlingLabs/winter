// Winter Phase 10b (Lane D2, task D2-1) — hermetic-ish (real `dist/winter` + real platform `claude`
// binary, loopback Anthropic/OpenAI fakes) parity coverage for spec WS-18 §9's A-1..A-4, plus the
// controller's own C1-2/m4 addendum item (a REAL resumed official child's environment, through the
// router's own door rather than a fake `query()`).
//
// STATUS (2026-09-14, test fix round 1, HEAD 05b914dc): Defect 1 (Winter -> official confirmLossy
// deadlocked on `awaitDestinationInit`) and Defect 2 (the official/Winter leg never bumped the
// durable generation counter, so the projector's checkpoint silently dropped the next turn's
// completion) are BOTH FIXED — D1 fix round 2, `efbb503b` (Defect 1) and `10b9088c` (Defect 2). A-1
// is green end to end (including Major 4's tool-call fixture, below). A-2 stays RED: the SDK's own
// message reader drops `message.model`, root-caused and fixed upstream but not yet pinned in this
// build (SDK 0.0.12); left asserting the spec's required tag rather than weakened — see that test's
// own comment. Defect 3 (below, A-3a only) is still open, under investigation in the router lane.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { RESUME_STAGING_PREFIX } from "@yanlinglabs/winter-runtime-sdk";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { officialConfigDirFor } from "../../src/runtime-sdk/official-options";
import { FORBIDDEN_CHILD_ENV } from "../../src/runtime-sdk/official-options";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

// A real, catalog-listed, credentialed, REASONING-CAPABLE gpt row — `registry.test.ts`'s own note:
// `gpt-5.6-sol` carries `reasoning.continuation: "opaque-provider-state"` (it reasons, hidden), no
// readable-summary evidence — exactly W18-20's "hidden-reasoning source" shape, unlike
// `openai/gpt-5.4` (no reasoning continuation at all, `handoff-cross-runtime-e2e.test.ts`'s own
// `lossless-native` fixture) which would never prompt for A-1's own required "the prompt appears".
const CATALOG_GPT_MODEL = "openai/gpt-5.6-sol";
const CATALOG_CLAUDE_MODEL = "claude-sonnet-5";

interface RpcErrorLike { rpc?: { message?: string; data?: { code?: string; warnings?: string[]; portable?: string[] } } }

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
// A-1 — GPT -> Claude (Winter -> official). GREEN end to end (Defect 1 fixed, D1 fix round 2,
// `efbb503b`): the prompt, confirmLossy, the actual resume onto the official leg, and Major 4's real
// tool-call round trip (assistant(tool_use) -> user(tool_result), never merged) all pass.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("A-1: GPT -> Claude (Winter -> official)", (winterBin) => {
  describeWithClaudeRuntime("session.setModel prompts, then confirmLossy should resume onto the official leg", () => {
    let home: string;
    let daemon: RunningDaemon | undefined;
    let client: TestClient;
    let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
    let anthropicFakeUrl = "";
    let anthropicFakeClose: (() => Promise<void>) | undefined;
    const anthropicRequests: Array<{ path: string; body: string }> = [];
    const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hello from claude, after the handoff"] }], stopReason: "end_turn" };

    let openaiRequestCount = 0;

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "parity-a1-")));
      const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
        scenarios: {},
        // Major 4 (review-lane-d2.md): the FIRST source turn issues a REAL tool call (Winter's own
        // built-in, parameterless `advisor` — the SAME proven technique
        // `advisor-winter-leg-e2e.test.ts` already uses with a real model over this exact fake, so
        // it needs no approval policy and is known to round-trip against the real winter binary).
        // request 1: the tool call itself; request 2: the advisor's OWN internal generation
        // (triggered automatically); request 3+: the turn's own continuation (after its tool
        // result) and every later turn. A hidden reasoning item (opaque `encrypted_content`) rides
        // the continuation — the fixture A-8's sweep later greps for `ENC-DUMMY` never leaking into
        // a foreign-family body/UI surface.
        unknownModel: async () => {
          openaiRequestCount += 1;
          if (openaiRequestCount === 1) {
            return openaiResponsesFake.responsesStream({
              calls: [{ index: 0, itemId: "item_1", callId: "call_1", name: "advisor", argumentsJson: "{}" }],
            });
          }
          if (openaiRequestCount === 2) {
            return openaiResponsesFake.responsesStream({ text: ["consulted"] });
          }
          return openaiResponsesFake.responsesStream({
            text: ["noted: P10B-A1-7"],
            reasoningItems: [{ index: 0, encrypted: "ENC-DUMMY-A1-1", summaryText: "thinking about the number" }],
          });
        },
      });
      openaiFakeRef = openaiFake;
      const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
      const anthropicFakeServer = await startFake({
        routes: [{
          path: "*",
          handler: async (_req, recorded) => {
            anthropicRequests.push({ path: recorded.path, body: recorded.body });
            if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(anthropicScript);
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          },
        }],
      });
      anthropicFakeUrl = anthropicFakeServer.url;
      anthropicFakeClose = () => anthropicFakeServer.close();

      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "openai-compatible", model: CATALOG_GPT_MODEL, baseUrl: openaiFake.url },
        runtimes: { winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
      }, null, 2));
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-a1" });
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-a1-anthropic" });

      daemon = await startDaemon({
        home, secrets, agentProvider: null,
        officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeUrl }, authFamily: "custom" }),
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

    test("prompts once, and confirmLossy resumes onto the official leg carrying prior text in order (A-1)", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const rt = d.runtimeState;
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "parity-a1-cwd-")));

      // TWO prior turns — the P2 "unique message.id, no merge across entries" concern needs at
      // least two assistant entries to have anything to merge.
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(d.winter.legOf(sessionId)).toBe("winter");
      const FIRST_TEXT = "remember P10B-A1-7";
      await client.call(METHODS.sessionSend, { sessionId, text: FIRST_TEXT });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

      // Major 4 (review-lane-d2.md): the canonical file now holds a REAL tool round trip for this
      // FIRST turn — assistant(tool_use) -> user(tool_result) -> assistant(text) — never merged.
      {
        const record = rt.records.get(sessionId);
        if (record === undefined || record.backendSessionId === undefined) throw new Error("no record/backendSessionId yet");
        const findTranscriptFile = (root: string, backendSessionId: string): string | undefined => {
          if (!existsSync(root)) return undefined;
          for (const entry of readdirSync(root, { withFileTypes: true })) {
            const full = join(root, entry.name);
            if (entry.isDirectory()) {
              const found = findTranscriptFile(full, backendSessionId);
              if (found !== undefined) return found;
            } else if (entry.name === `${backendSessionId}.jsonl`) {
              return full;
            }
          }
          return undefined;
        };
        const transcriptFile = findTranscriptFile(home, record.backendSessionId);
        if (transcriptFile === undefined) throw new Error(`no canonical transcript file for ${record.backendSessionId}`);
        const entries = readFileSync(transcriptFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
        const kinds = entries.map((e) => {
          const msg = e["message"] as { role?: string; content?: unknown } | undefined;
          if (msg === undefined) return e["type"];
          const content = Array.isArray(msg.content) ? msg.content : [];
          if (msg.role === "assistant" && content.some((b: { type?: string }) => b.type === "tool_use")) return "assistant(tool_use)";
          if (msg.role === "user" && content.some((b: { type?: string }) => b.type === "tool_result")) return "user(tool_result)";
          return `${msg.role}(${e["type"]})`;
        });
        const toolUseIdx = kinds.indexOf("assistant(tool_use)");
        const toolResultIdx = kinds.indexOf("user(tool_result)");
        expect(toolUseIdx).toBeGreaterThanOrEqual(0);
        expect(toolResultIdx).toBeGreaterThan(toolUseIdx); // in order, never merged/reordered
        expect(kinds.slice(toolResultIdx + 1).some((k) => k === "assistant(text)" || String(k).startsWith("assistant("))).toBe(true);
      }

      const SECOND_TEXT = "what number did I ask you to remember?";
      await client.call(METHODS.sessionSend, { sessionId, text: SECOND_TEXT });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.indexOf(e) > client.events.findIndex((ev) => ev.type === "turn_completed"), 45_000);

      // A-1: the FIRST setModel (no confirmLossy) must prompt — gpt-5.6-sol reasons (hidden), and
      // the destination differs in family, with source turns present.
      let firstCaught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });
      } catch (err) { firstCaught = err as RpcErrorLike; }
      expect(firstCaught).toBeDefined();
      expect(firstCaught!.rpc?.data?.code).toBe("handoff_confirmation_required");
      expect(firstCaught!.rpc?.data?.warnings?.length ?? 0).toBeGreaterThan(0);

      // confirmLossy proceeds — this is the SPEC-required outcome (A-1: "the prompt appears, and
      // confirmLossy proceeds"). GREEN since Defect 1 was fixed (D1 fix round 2, `efbb503b`).
      let caught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL, confirmLossy: true });
      } catch (err) { caught = err as RpcErrorLike; }
      expect(caught).toBeUndefined();
      expect(d.winter.legOf(sessionId)).toBe("official");

      const anthropicRequestsBefore = anthropicRequests.length;
      // Fix round 2 (test-authoring bug, unmasked once Defects 1/2 stopped blocking this far):
      // TWO pre-handoff turn_completed events for this SAME sessionId already sit in `client.events`
      // (FIRST_TEXT, SECOND_TEXT) — an un-disambiguated predicate matches the OLDEST one instantly,
      // exactly the trap the SECOND_TEXT wait above already guards against with its own
      // `indexOf(e) > findIndex(...)` — generalized here to a COUNT since there are now two priors.
      const turnCompletedSoFar = () => client.events.filter((e) => e.type === "turn_completed" && e.sessionId === sessionId).length;
      const priorTurnCompletedCount = turnCompletedSoFar();
      await client.call(METHODS.sessionSend, { sessionId, text: "one more, after the handoff" });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && turnCompletedSoFar() > priorTurnCompletedCount, 45_000);
      expect(anthropicRequests.length).toBeGreaterThan(anthropicRequestsBefore);
      const body = JSON.parse(anthropicRequests[anthropicRequests.length - 1]!.body) as {
        messages?: Array<{ role: string; content: Array<{ type?: string; text?: string; id?: string; tool_use_id?: string }> | string }>;
      };
      const messages = body.messages ?? [];
      const contentOf = (m: (typeof messages)[number]): Array<{ type?: string; text?: string; id?: string; tool_use_id?: string }> =>
        Array.isArray(m.content) ? m.content : [];
      const flatText = (m: (typeof messages)[number]): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      // Both prior turns' text reaches the request, and in EXACT order (FIRST before SECOND).
      const firstIdx = messages.findIndex((m) => m.role === "user" && flatText(m).includes(FIRST_TEXT));
      const secondIdx = messages.findIndex((m) => m.role === "user" && flatText(m).includes(SECOND_TEXT));
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(secondIdx).toBeGreaterThan(firstIdx);

      // Major 4: the tool_use / tool_result pair from the FIRST turn crosses intact, and no
      // assistant message merged ACROSS the tool_result boundary (P2 / distinct `message.id`
      // per-entry, W18-11) — asserted here as distinct assistant message OBJECTS in the wire body,
      // never one combined block spanning both sides of the tool_result.
      const toolUseMsgIdx = messages.findIndex((m) => m.role === "assistant" && contentOf(m).some((b) => b.type === "tool_use"));
      expect(toolUseMsgIdx).toBeGreaterThanOrEqual(0);
      const toolUseBlock = contentOf(messages[toolUseMsgIdx]!).find((b) => b.type === "tool_use");
      expect(toolUseBlock?.id).toBeDefined();
      const toolResultMsgIdx = messages.findIndex((m, i) => i > toolUseMsgIdx && m.role === "user" && contentOf(m).some((b) => b.type === "tool_result"));
      expect(toolResultMsgIdx).toBeGreaterThan(toolUseMsgIdx);
      const toolResultBlock = contentOf(messages[toolResultMsgIdx]!).find((b) => b.type === "tool_result");
      expect(toolResultBlock?.tool_use_id).toBe(toolUseBlock?.id); // valid, paired
      // The assistant message immediately after the tool_result is a SEPARATE object from the one
      // that made the tool_use call — never merged into a single assistant entry spanning both.
      const nextAssistantIdx = messages.findIndex((m, i) => i > toolResultMsgIdx && m.role === "assistant");
      expect(nextAssistantIdx).toBeGreaterThan(toolResultMsgIdx);
      expect(nextAssistantIdx).not.toBe(toolUseMsgIdx);
      const assistantCount = messages.filter((m) => m.role === "assistant").length;
      expect(assistantCount).toBeGreaterThanOrEqual(3); // tool_use call + its own continuation + the second turn's reply — none merged

      rmSync(cwd, { recursive: true, force: true });
    }, 90_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A-2 — Claude -> GPT (official -> Winter). GREEN end to end (item 0, resume-d2-fix2.md): the
// handoff resumes, the completion event arrives (Defect 2 fixed, D1 fix round 2, `10b9088c`), and
// the carry (Claude's `thinking` -> a `kind="summary"` tag on the GPT-bound request) is proven
// against the REAL raw request body.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("A-2: Claude -> GPT (official -> Winter)", (winterBin) => {
  describeWithClaudeRuntime("Claude's thinking lands in the canonical file, then carries to OpenAI as a summary tag", () => {
    let home: string;
    let daemon: RunningDaemon | undefined;
    let client: TestClient;
    let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
    let anthropicFakeUrl = "";
    let anthropicFakeClose: (() => Promise<void>) | undefined;
    const anthropicRequests: Array<{ path: string; body: string }> = [];
    const anthropicScript: AnthropicTurnScript = {
      blocks: [
        { type: "thinking", chunks: ["reasoning about the handoff"], signature: "SIG-DUMMY-A2-1" },
        { type: "text", chunks: ["the answer is 4"] },
      ],
      stopReason: "end_turn",
    };

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "parity-a2-")));
      const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
        scenarios: {},
        unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello from gpt, after the handoff"] }),
      });
      openaiFakeRef = openaiFake;
      const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
      const anthropicFakeServer = await startFake({
        routes: [{
          path: "*",
          handler: async (_req, recorded) => {
            anthropicRequests.push({ path: recorded.path, body: recorded.body });
            if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(anthropicScript);
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          },
        }],
      });
      anthropicFakeUrl = anthropicFakeServer.url;
      anthropicFakeClose = () => anthropicFakeServer.close();

      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "openai-compatible", model: CATALOG_GPT_MODEL, baseUrl: openaiFake.url },
        runtimes: { winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
      }, null, 2));
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-a2" });
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-a2-anthropic" });

      daemon = await startDaemon({
        home, secrets, agentProvider: null,
        officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeUrl }, authFamily: "custom" }),
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

    test("thinking lands in the canonical file, then carries as a kind=summary tag with no signature/redacted_thinking leaking (A-2)", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const rt = d.runtimeState;

      const PRIOR_TEXT = "remember P10B-A2-4";
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(d.winter.legOf(sessionId)).toBe("official");
      await client.call(METHODS.sessionSend, { sessionId, text: PRIOR_TEXT });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

      // A-2: FIRST assert the fake's `thinking` block actually landed in the canonical transcript —
      // never a vacuously-green carry assertion.
      const record = rt.records.get(sessionId);
      if (record === undefined) throw new Error("no record");
      const findTranscriptFile = (root: string, backendSessionId: string): string | undefined => {
        if (!existsSync(root)) return undefined;
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const full = join(root, entry.name);
          if (entry.isDirectory()) {
            const found = findTranscriptFile(full, backendSessionId);
            if (found !== undefined) return found;
          } else if (entry.name === `${backendSessionId}.jsonl`) {
            return full;
          }
        }
        return undefined;
      };
      if (record.backendSessionId === undefined) throw new Error("no backendSessionId on the record");
      const transcriptFile = findTranscriptFile(home, record.backendSessionId);
      if (transcriptFile === undefined) throw new Error(`no canonical transcript file found for backendSessionId ${record.backendSessionId} under ${home}`);
      const canonicalLines = readFileSync(transcriptFile, "utf8").trim().split("\n").filter(Boolean);
      const hasThinking = canonicalLines.some((l) => l.includes("SIG-DUMMY-A2-1") || (l.includes("\"thinking\"") && l.includes("reasoning about the handoff")));
      expect(hasThinking).toBe(true);

      // Prompt, then confirmLossy — Claude reasoning crossing to a foreign family is warned-lossy.
      let firstCaught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_GPT_MODEL });
      } catch (err) { firstCaught = err as RpcErrorLike; }
      expect(firstCaught).toBeDefined();
      expect(firstCaught!.rpc?.data?.code).toBe("handoff_confirmation_required");

      let caught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_GPT_MODEL, confirmLossy: true });
      } catch (err) { caught = err as RpcErrorLike; }
      expect(caught).toBeUndefined();
      expect(d.winter.legOf(sessionId)).toBe("winter");

      // Defect 2 is fixed (D1 fix round 2, 10b9088c) — a plain send + wait, no polling workaround.
      // Disambiguated against the PRIOR (pre-handoff) turn_completed already sitting in
      // `client.events`, the same trap A-1's own SECOND_TEXT wait guards against.
      const openaiRequestsBefore = openaiFakeRef!.requests.length;
      const sinceIdx = client.events.length;
      await client.call(METHODS.sessionSend, { sessionId, text: "what did I ask you to remember?" });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.indexOf(e) >= sinceIdx, 45_000);
      expect(openaiFakeRef!.requests.length).toBeGreaterThan(openaiRequestsBefore);
      const lastReq = openaiFakeRef!.requests[openaiFakeRef!.requests.length - 1]!;
      // item 0 (resume-d2-fix2.md, report-lane-d1-fix3.md): `lastReq.body` is ALREADY the raw
      // request body STRING — `JSON.stringify`-ing it again double-encodes it (every `"` becomes
      // `\"`), so a literal `toContain('kind="summary"')` check could never match. Asserted directly
      // against the string; the product carry is GREEN.
      const reqBody = lastReq.body;
      expect(reqBody).toContain(PRIOR_TEXT);
      expect(reqBody).toContain("recovered_reasoning");
      expect(reqBody).toContain('kind=\\"summary\\"'); // the body is itself a JSON string, so an embedded `"` is escaped
      expect(reqBody).not.toContain("SIG-DUMMY-A2-1");
      expect(reqBody).not.toContain("redacted_thinking");
    }, 90_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A-3 — destination death, injected BOTH directions: the source leg serves the next send, the
// record/model revert, and there is no `process_death`. Deterministic stub executables (the
// coordinator's own suggested technique, already proven in `handoff-official-to-winter-e2e.test.ts`
// for one direction). The revert half (record/model back to the source, typed `handoff_lossy_fork`,
// never a silent `applied`) is proven and PASSES in both directions below.
//
// DEFECT 3 — FIXED (router 0.0.7). History: after a FAILED Winter -> official handoff attempt (the
// destination dies; the record correctly reverts to the Winter source), the Winter SOURCE was
// measured (2026-09-14) to be left PERMANENTLY STRANDED — every subsequent `session.send` on it
// failed immediately with `agent_error code=process_death "runtime exited before init"`. The router
// lane traced it to the winter binary's own resume gate never releasing `handoff-leases/`'s entry on
// a REVERTED (never-committed) handoff attempt. A-3a below now proves the fix: the source re-resumes
// cleanly and serves the next send for real (a genuine delta on the destination fake's own request
// log, never a bare "some request existed" check — the exact class of vacuous-green M2 flagged on
// A-3b). A-3b (official source) never hit this defect at all.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithClaudeRuntime("A-3a: destination death, Winter -> official — the source keeps serving", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "parity-a3a-")));
    const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: {},
      unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello from gpt"] }),
    });
    openaiFakeRef = openaiFake;
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: CATALOG_GPT_MODEL, baseUrl: openaiFake.url },
      runtimes: {
        // A deliberately DEAD official destination — a real, on-disk executable that exits(0)
        // immediately without ever speaking the wire protocol (the coordinator's own technique).
        winterExecutable: process.env.WINTER_RUNTIME_EXECUTABLE ?? join(import.meta.dir, "../../../../dist/winter"),
        claudeExecutable: "/usr/bin/true",
        winterIdleTimeoutSec: 60,
        handoff: { crossRuntime: true },
      },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-a3a" });
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-a3a-anthropic" });
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

  test("a dead official destination reverts the record and the source keeps serving, no process_death", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
    const rt = d.runtimeState;
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "parity-a3a-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "remember A3a-1" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
    const beforeSelection = rt.records.get(sessionId)?.selection;

    let caught: RpcErrorLike | undefined;
    try {
      await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL, confirmLossy: true });
    } catch (err) { caught = err as RpcErrorLike; }
    expect(caught).toBeDefined();
    expect(caught!.rpc?.data?.code).toBe("handoff_lossy_fork");
    expect(d.winter.legOf(sessionId)).toBe("winter");
    expect(rt.records.get(sessionId)?.selection).toEqual(beforeSelection);

    const sinceIdx = client.events.length;
    const openaiRequestsBefore = openaiFakeRef!.requests.length;
    await client.call(METHODS.sessionSend, { sessionId, text: "still on gpt?" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.indexOf(e) >= sinceIdx, 45_000);
    expect(openaiFakeRef!.requests.length).toBeGreaterThan(openaiRequestsBefore);
    expect(openaiFakeRef!.requests[openaiFakeRef!.requests.length - 1]!.body).toContain("still on gpt?");
    expect(client.events.slice(sinceIdx).some((e) => e.type === "agent_error" && (e as { code?: string }).code === "process_death")).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);
});

describeWithWinterBinary("A-3b: destination death, official -> Winter — the source keeps serving", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let anthropicFakeUrl = "";
  let anthropicFakeClose: (() => Promise<void>) | undefined;
  const anthropicRequests: Array<{ path: string; body: string }> = [];
  const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hello from claude"] }], stopReason: "end_turn" };

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "parity-a3b-")));
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    const anthropicFakeServer = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          anthropicRequests.push({ path: recorded.path, body: recorded.body });
          if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(anthropicScript);
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    anthropicFakeUrl = anthropicFakeServer.url;
    anthropicFakeClose = () => anthropicFakeServer.close();
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: CATALOG_GPT_MODEL, baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: {
        // A deliberately DEAD Winter destination.
        winterExecutable: "/usr/bin/true",
        claudeExecutable: claudeRuntimeForTests()!.executable,
        winterIdleTimeoutSec: 60,
        handoff: { crossRuntime: true },
      },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-a3b" });
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-a3b-anthropic" });
    daemon = await startDaemon({
      home, secrets, agentProvider: null,
      officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeUrl }, authFamily: "custom" }),
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

  test("a dead Winter destination reverts the record and the source keeps serving, no process_death", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
    const rt = d.runtimeState;
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "remember A3b-1" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
    const beforeSelection = rt.records.get(sessionId)?.selection;

    let caught: RpcErrorLike | undefined;
    try {
      await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_GPT_MODEL, confirmLossy: true });
    } catch (err) { caught = err as RpcErrorLike; }
    expect(caught).toBeDefined();
    expect(caught!.rpc?.data?.code).toBe("handoff_lossy_fork");
    expect(d.winter.legOf(sessionId)).toBe("official");
    expect(rt.records.get(sessionId)?.selection).toEqual(beforeSelection);

    const sinceIdx = client.events.length;
    // M2 (review-lane-d2-fix1.md): a bare `> 0` here is satisfied by the PRE-handoff turn's own
    // request and would stay green even on a re-resumed source that completes an EMPTY turn — the
    // exact failure shape A-3a's OWN measurement shows. Restored to a DELTA against a snapshot taken
    // right before this send, plus a check that the NEW request's body actually carries this send's
    // own text — never a vacuous "some request, at some point, existed" check.
    const messagesRequestsBefore = anthropicRequests.filter((r) => r.path === "/v1/messages").length;
    // Unlike A-3a's Winter source (Defect 3, still open — see this file's header), the OFFICIAL
    // source here re-resumes cleanly — and now that Defect 2 is fixed (D1 fix round 2, 10b9088c) the
    // plain wait works with no polling workaround.
    await client.call(METHODS.sessionSend, { sessionId, text: "still on claude?" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.indexOf(e) >= sinceIdx, 45_000);
    const messagesRequestsAfter = anthropicRequests.filter((r) => r.path === "/v1/messages");
    expect(messagesRequestsAfter.length).toBeGreaterThan(messagesRequestsBefore);
    expect(messagesRequestsAfter[messagesRequestsAfter.length - 1]!.body).toContain("still on claude?");
    expect(client.events.slice(sinceIdx).some((e) => e.type === "agent_error" && (e as { code?: string }).code === "process_death")).toBe(false);
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// controller addendum (m4) — a REAL resumed official child's environment, through the router's own
// door (never a fake `query()`, unlike D1-8's unit tests). A SAME-LEG cold resume (daemon restart on
// the same home, after one canonical entry exists) — neither Defect 1 nor Defect 2 apply (no
// cross-runtime handoff at all).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithClaudeRuntime("m4: a REAL resumed official child's environment", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let anthropicFakeUrl = "";
  let anthropicFakeClose: (() => Promise<void>) | undefined;
  let shimPath: string;
  let captureLog: string;
  const anthropicRequests: Array<{ path: string; body: string }> = [];
  const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hello"] }], stopReason: "end_turn" };

  /** The set of env var NAMES (never values) the real child's own spawn carried, for the invocation
   *  whose block starts at or after `sinceByteOffset` in the growing capture log. */
  function envNamesSince(sinceByteOffset: number): { names: Set<string>; claudeConfigDir: string | undefined } {
    const raw = readFileSync(captureLog, "utf8").slice(sinceByteOffset);
    const block = raw.split("=== invocation ===\n").filter(Boolean)[0] ?? raw;
    const lines = block.trim().split("\n").filter(Boolean);
    const claudeConfigDirLine = lines.find((l) => l.startsWith("CLAUDE_CONFIG_DIR_VALUE="));
    const names = new Set(lines.filter((l) => l !== claudeConfigDirLine));
    return { names, claudeConfigDir: claudeConfigDirLine?.slice("CLAUDE_CONFIG_DIR_VALUE=".length) };
  }

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "parity-m4-")));
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    const anthropicFakeServer = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          anthropicRequests.push({ path: recorded.path, body: recorded.body });
          if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(anthropicScript);
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    anthropicFakeUrl = anthropicFakeServer.url;
    anthropicFakeClose = () => anthropicFakeServer.close();

    // Critical 1 (review-lane-d2.md): a real env-capturing SHIM in place of the platform `claude`
    // binary, so the assertions below read the ACTUAL spawned child's environment rather than
    // recomputing what the daemon INTENDED to send. `resolveClaudeExecutable`'s explicit
    // (setting/env) rungs only ever check `existsSync` — no VERSIONS.json/identity gate applies
    // outside the bundle rung — so a plain executable script here is accepted exactly like a real
    // binary path would be. The shim never inspects or transforms anything: it snapshots `env`'s
    // NAMES (never values, via `cut -d= -f1`), separately records the single VALUE of
    // `CLAUDE_CONFIG_DIR` (a path, not a secret), appends both to a growing log (one block per
    // invocation, so the test can isolate the SECOND/resumed launch), then `exec`s the real
    // platform `claude` binary with the untouched argument vector — the turn itself still runs for
    // real, against the real binary.
    const realClaudeBin = claudeRuntimeForTests()!.executable;
    shimPath = join(home, "claude-env-shim.sh");
    captureLog = join(home, "captured-env.log");
    writeFileSync(shimPath, [
      "#!/bin/sh",
      "{",
      "  echo '=== invocation ==='",
      "  env | cut -d= -f1",
      '  printf \'CLAUDE_CONFIG_DIR_VALUE=%s\\n\' "$CLAUDE_CONFIG_DIR"',
      `} >> "${captureLog}"`,
      `exec "${realClaudeBin}" "$@"`,
      "",
    ].join("\n"));
    chmodSync(shimPath, 0o755);

    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/unused", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { claudeExecutable: shimPath },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-m4" });
    // Contamination probe: a codex/openai-named credential material present in this SAME secret
    // store, so a spawn that ever forwarded a FORBIDDEN_CHILD_ENV name or an OPENAI*/CODEX* name
    // would have something real to leak — and the shim above now actually PROVES the absence,
    // rather than checking a filesystem side effect that a leak would never touch.
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-should-never-reach-claude" });
    daemon = await startDaemon({
      home, secrets, agentProvider: null,
      officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeUrl }, authFamily: "custom" }),
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

  test("a cold-resumed official child (through the real router door) still passes P9c-1/P10a and never touches ~/.claude or a codex/openai config dir", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;

    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "first, before the resume" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

    const stagingBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith(RESUME_STAGING_PREFIX)));
    const captureOffsetBeforeResume = existsSync(captureLog) ? statSync(captureLog).size : 0;

    // Force a COLD resume: stop the daemon, restart on the SAME home. At least one canonical entry
    // now exists, so the router's own door opens the NEXT official incarnation with `resume`.
    client.close();
    await daemon!.stop();
    const secrets2 = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({
      home, secrets: secrets2, agentProvider: null,
      officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeUrl }, authFamily: "custom" }),
    });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    const sinceIdx = client.events.length;
    // Defect 2 (generation-not-bumped) is FIXED (D1 fix round 2, 10b9088c) — the plain wait is the
    // spec-required idiom again, no polling workaround needed.
    await client.call(METHODS.sessionSend, { sessionId, text: "second, after the resume" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.indexOf(e) >= sinceIdx, 45_000);

    // apiKeySource: I-4 holds on every official init, including a resumed one. Read directly off
    // the live driver (`LegSession.init`) — apiKeySource is never a projected `SessionEvent` field,
    // so a harness client alone cannot see it (mirrors `official-leg.e2e.test.ts`'s own `w.session
    // .init?.apiKeySource`, just through the real socket-facing driver table instead of a
    // lower-level test bed).
    // `LegSession.init`'s declared type is deliberately the WinterSession/OfficialSession
    // INTERSECTION (`session-driver.ts:97`'s own doc: "excludes… nothing outside… reads them"), so
    // it does not name `apiKeySource` (an official-only field) — this session IS genuinely on the
    // official leg (asserted throughout this test), so the cast is a real narrowing, not a guess.
    const resumedDriver = d.winter.get(sessionId) as { init?: { apiKeySource?: string } } | undefined;
    expect(resumedDriver?.init?.apiKeySource).toBe("ANTHROPIC_API_KEY");

    // Critical 1 (review-lane-d2.md): the REAL spawned child's own environment, captured by the
    // shim — never a recomputation. Isolated to the SECOND (resumed) invocation's own block.
    const { names: childEnvNames, claudeConfigDir } = envNamesSince(captureOffsetBeforeResume);
    expect(childEnvNames.size).toBeGreaterThan(0); // non-vacuous: the shim really captured something
    expect(claudeConfigDir).toBeDefined();

    // The P9c-1 api-key arm's own required name is present; every OTHER FORBIDDEN_CHILD_ENV name
    // (the console/OAuth/Bedrock/Vertex/Foundry arms' own auth names) is absent — this arm never
    // needs them, and their presence would mean an ambient leak the strip failed to catch.
    expect(childEnvNames.has("ANTHROPIC_API_KEY")).toBe(true);
    for (const name of FORBIDDEN_CHILD_ENV) {
      if (name === "ANTHROPIC_API_KEY" || name === "CLAUDE_CONFIG_DIR") continue; // both expected, asserted separately
      expect(childEnvNames.has(name)).toBe(false);
    }
    // No codex/openai-named credential env reached the child at all, despite one being present in
    // the SAME secret store this session's own credential resolution reads from.
    for (const name of childEnvNames) {
      expect(name).not.toMatch(/codex|openai/i);
    }

    // CLAUDE_CONFIG_DIR's REAL value: Winter-owned, never `~/.claude`, never the FRESH-launch
    // `officialConfigDirFor(home)` dir reused across a resume (it must be a per-resume staging
    // root instead — I-4).
    expect(claudeConfigDir).toBeDefined();
    expect(claudeConfigDir).not.toBe(officialConfigDirFor(home));
    expect(claudeConfigDir!.split("/")).not.toContain(".claude");
    const home200 = process.env.HOME;
    if (home200 !== undefined) expect(claudeConfigDir!.startsWith(join(home200, ".claude"))).toBe(false);
    expect(claudeConfigDir).toContain(RESUME_STAGING_PREFIX);

    // A resume-staging root (`claude-resume-<uuid>`, router-owned, under system tmpdir — never
    // under `home`) appears for this cross-generation resume; the loop below is non-vacuous
    // (Critical 2) and confirms it is FRESH (not reused across generations) and never itself
    // carries a codex/openai-named file.
    const stagingAfter = readdirSync(tmpdir()).filter((n) => n.startsWith(RESUME_STAGING_PREFIX));
    const newStaging = stagingAfter.filter((n) => !stagingBefore.has(n));
    expect(newStaging.length).toBeGreaterThan(0);
    for (const dir of newStaging) {
      const full = join(tmpdir(), dir);
      const names = existsSync(full) ? readdirSync(full) : [];
      expect(names.some((n) => /codex|openai/i.test(n))).toBe(false);
    }
  }, 90_000);
});
