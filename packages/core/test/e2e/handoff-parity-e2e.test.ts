// Winter Phase 10b (Lane D2, task D2-1) — hermetic-ish (real `dist/winter` + real platform `claude`
// binary, loopback Anthropic/OpenAI fakes) parity coverage for spec WS-18 §9's A-1..A-4, plus the
// controller's own C1-2/m4 addendum item (a REAL resumed official child's environment, through the
// router's own door rather than a fake `query()`).
//
// TWO BLOCKING PRODUCT DEFECTS were measured while writing this file (both reported to the
// controller for Lane D1/router routing; neither is touched here — `packages/core/src/**` is out of
// scope for this lane):
//
// DEFECT 1 — Winter -> official (needed for A-1, and the LAST hop of A-5): `session.setModel`'s
// `confirmLossy: true` retry NEVER completes. `runtime-sdk/handoff.ts`'s `destinationRuntimeFor`
// retries `evict()`+`ensure()` up to 3 times, each bounded by `awaitDestinationInit`'s
// `DEFAULT_CONFIRM_INIT_TIMEOUT_MS` (10s) — every attempt exhausts the full 10s with NO
// `session.init` ever arriving (the child is not reported dead either: this is the TIMEOUT branch,
// "the destination runtime did not report init within the handoff's confirmation window", never
// "exited before it reached init"). Measured twice, deterministically, with a real, credentialed,
// catalog-listed, reasoning-capable Winter GPT model (`openai/gpt-5.6-sol`) handing off to
// `claude-sonnet-5` after `confirmLossy: true`; the record reverts to the source leg both times.
// Repro: a Winter session on `openai/gpt-5.6-sol` (real catalog row, openai loopback), one completed
// turn, `session.setModel({model: "claude-sonnet-5", confirmLossy: true})`. Expected (A-1): the
// handoff resumes onto the official leg. Actual: `handoff_lossy_fork`, "the destination runtime did
// not report init within the handoff's confirmation window", every time, ~31s later (3 retries).
//
// DEFECT 2 — official -> Winter (needed for A-2, and hop 4 of A-5), the OPPOSITE symptom: the
// destination attach itself SUCCEEDS (leg/providerId/runtimeKind all patch correctly, proving the
// P10a-h fix and the P10b lease-release both hold), but the FIRST turn run on the resumed Winter
// destination never completes from the CLIENT's point of view: `assistant_delta` streams the fake's
// full scripted text, but no `assistant_message`/`turn_completed` ever follows, and the record
// settles to `state: "idle"` (the runtime's own side believes the turn is done). The daemon log
// carries the cause, twice, the instant the destination attach opens: `[projector] source already
// projected — skipping; on a live stream this means a resume that did not bump \`generation\`\``
// (`src/projector/index.ts:487-501`, checkpoint keyed on `{winterSessionId, generation, sourceId}`).
// `records.get(sessionId).generation` is measured to stay `1` from before the handoff through after
// the hang — never bumping to `2` the way `WinterSession.open()`'s own contract promises on every
// fresh incarnation (`src/runtime-sdk/winter-session.ts:512`). The destination's own fresh
// incarnation resets its local turn/message counters to 0, so its own first NEW turn computes the
// SAME `sourceId` the checkpoint already committed for the SOURCE leg's own last turn (during the
// handoff's own bootstrap replay, under the SAME un-bumped generation) — the checkpoint reads the
// genuinely-new completion frames as "already committed" and silently drops them. Full account:
// `handoff-official-to-winter-e2e.test.ts`'s own 10b addendum comment.
//
// WORKAROUND USED BELOW for A-2/A-4's OFFICIAL-> WINTER half only: the destination's own OUTBOUND
// HTTP request DOES reach the openai loopback fake (proven — the fake's own request log grows), so
// this file verifies the CARRIED CONTENT by polling the fake's request log directly (bounded, never
// indefinite) rather than waiting on the swallowed `turn_completed` event — then SEPARATELY asserts
// (to the SPEC, never weakened) that the completion event is expected, which currently fails red on
// Defect 2 and is left that way rather than silently dropped.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Bounded poll for a fake's own request log growing past `before` — the A-2/A-4 workaround: the
 *  destination's outbound HTTP request is unaffected by Defect 2 (a client-visible EVENT bug), so
 *  content can be verified even though `turn_completed` never arrives. */
async function waitForRequestCount(requests: { length: number }, min: number, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (requests.length >= min) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${min} request(s); saw ${requests.length}`);
    await Bun.sleep(20);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A-1 — GPT -> Claude (Winter -> official). BLOCKED on Defect 1 (see header): the prompt/confirmLossy
// half is proven; the actual resume is not reachable today. Left asserting the SPEC's required
// outcome (never weakened to pass around the defect).
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

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "parity-a1-")));
      const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
        scenarios: {},
        // A hidden reasoning item (opaque `encrypted_content`) plus visible text — the fixture A-8's
        // sweep later greps for `ENC-DUMMY` never leaking into a foreign-family body/UI surface.
        unknownModel: async () => openaiResponsesFake.responsesStream({
          text: ["noted: P10B-A1-7"],
          reasoningItems: [{ index: 0, encrypted: "ENC-DUMMY-A1-1", summaryText: "thinking about the number" }],
        }),
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
      // confirmLossy proceeds"). MEASURED to fail today on Defect 1 (see this file's header); left
      // asserting success rather than weakened.
      let caught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL, confirmLossy: true });
      } catch (err) { caught = err as RpcErrorLike; }
      expect(caught).toBeUndefined(); // MEASURED (2026-09-14): fails here with handoff_lossy_fork,
      // "the destination runtime did not report init within the handoff's confirmation window" —
      // Defect 1. Everything below is reached only once that is fixed.
      expect(d.winter.legOf(sessionId)).toBe("official");

      const anthropicRequestsBefore = anthropicRequests.length;
      await client.call(METHODS.sessionSend, { sessionId, text: "one more, after the handoff" });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
      expect(anthropicRequests.length).toBeGreaterThan(anthropicRequestsBefore);
      const body = JSON.parse(anthropicRequests[anthropicRequests.length - 1]!.body) as { messages?: Array<{ role: string; content: unknown }> };
      const userTexts = (body.messages ?? []).filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
      // Both prior turns' text reaches the request, in order, and no assistant entry merged into
      // another (distinct message.id per Winter's own claude-shape write, W18-11).
      expect(userTexts.some((t) => t.includes(FIRST_TEXT))).toBe(true);
      expect(userTexts.some((t) => t.includes(SECOND_TEXT))).toBe(true);
      const assistantCount = (body.messages ?? []).filter((m) => m.role === "assistant").length;
      expect(assistantCount).toBeGreaterThanOrEqual(2); // not merged into one

      rmSync(cwd, { recursive: true, force: true });
    }, 90_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A-2 — Claude -> GPT (official -> Winter). The handoff itself SUCCEEDS (Defect 1 does not apply to
// this direction); Defect 2 swallows the post-handoff `turn_completed`, so this test verifies
// carried content via the destination fake's own request log (unaffected) and separately, honestly,
// asserts the completion event the spec requires (fails red on Defect 2, not weakened).
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

      // Workaround for Defect 2: verify carried CONTENT via the destination fake's own request log
      // (bounded poll), not via `turn_completed` (silently dropped today).
      const openaiRequestsBefore = openaiFakeRef!.requests.length;
      await client.call(METHODS.sessionSend, { sessionId, text: "what did I ask you to remember?" }).catch(() => { /* fire; the reply's completion may never surface — see Defect 2 */ });
      await waitForRequestCount(openaiFakeRef!.requests, openaiRequestsBefore + 1, 20_000);
      const lastReq = openaiFakeRef!.requests[openaiFakeRef!.requests.length - 1]!;
      const reqBody = JSON.stringify(lastReq.body ?? {});
      expect(reqBody).toContain(PRIOR_TEXT);
      // CANDIDATE FINDING (2026-09-14, LESS CERTAIN than Defects 1-3 — not fully root-caused, and
      // may be a gap in this fixture rather than the product): the visible conversation DOES carry
      // (the prior USER text above, and separately confirmed the assistant's visible reply "the
      // answer is 4" also reaches this request) but NEITHER a `<recovered_reasoning` tag NOR the
      // `<prior_model_handoff>` fallback appears anywhere in the request body — the Claude turn's
      // `thinking` content (confirmed landed in the canonical file above) does not visibly carry in
      // any form. Left asserting the SPEC's required tag (W18-15/17) rather than weakened; reported
      // to the controller to determine whether this is a real gap or something this fixture is
      // missing (e.g. a sidecar/summary record write this test never triggers).
      expect(reqBody).toContain("recovered_reasoning");
      expect(reqBody).toContain("kind=\"summary\"");
      expect(reqBody).not.toContain("SIG-DUMMY-A2-1");
      expect(reqBody).not.toContain("redacted_thinking");

      // Now the SPEC-required completion event, asserted honestly (never weakened): MEASURED
      // (2026-09-14) to fail on Defect 2 — see this file's header.
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 20_000);
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
// DEFECT 3 — MEASURED (2026-09-14), A-3a only: after a FAILED Winter -> official handoff attempt
// (the destination dies; the record correctly reverts to the Winter source), the Winter SOURCE is
// left PERMANENTLY STRANDED — every subsequent `session.send` on it fails immediately with
// `agent_error code=process_death "the runtime process exited unexpectedly: runtime exited before
// init"`, deterministically, even after a 5-SECOND wait (ruling out ordinary OS process-exit
// propagation lag; this is not a timing race). This is the identical class of failure
// `handoff-official-to-winter-e2e.test.ts`'s own header already anticipated but deliberately did
// NOT assert ("a resume attempt right after this one would plausibly hit the identical real 'exited
// before init'... This test's own job... stops at 'reverted, typed, never silently applied'") — this
// file's A-3a is the concrete repro that measurement was speculating about, now confirmed for a
// PLAIN same-leg re-resume after a REVERTED cross-runtime attempt (no destination cross-runtime
// state involved at all). Likely cause (unconfirmed at the daemon-source level — the actual lock is
// internal to the real winter binary / router): `destinationRuntimeFor`'s retry loop
// (`runtime-sdk/handoff.ts`) calls `deps.winter.evict()` on the ORIGINAL, healthy Winter incarnation
// before attempting the (doomed) official destination, and whatever release the real winter binary's
// own resume gate needs before it will resume the SAME backend session id again appears to happen
// only on a SUCCESSFUL commit, never on this revert path — matching the ORIGINAL P10a-h finding's own
// theory ("that marker is transferred only as part of a successful commit"), just now measured for
// the SOURCE side of a failed attempt rather than the destination side of a successful one. A-3a
// below is left asserting the SPEC's required behaviour (fails red on this defect); A-3b (official
// source) does NOT hit this — its own source re-resume succeeds, but its completion event is then
// swallowed by Defect 2 instead (see that test's own comment).
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

    await Bun.sleep(300); // negligible; MEASURED (2026-09-14) that even a 5s sleep here does not help -- see Defect 3 below
    const sinceIdx = client.events.length;
    const openaiRequestsBefore = openaiFakeRef!.requests.length;
    await client.call(METHODS.sessionSend, { sessionId, text: "still on gpt?" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.indexOf(e) >= sinceIdx, 45_000);
    expect(openaiFakeRef!.requests.length).toBeGreaterThan(openaiRequestsBefore);
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
    const messagesRequestsBefore = anthropicRequests.filter((r) => r.path === "/v1/messages").length;
    await client.call(METHODS.sessionSend, { sessionId, text: "still on claude?" });
    // MEASURED (2026-09-14): unlike A-3a's Winter source (Defect 3: permanently stranded, every
    // subsequent send fails "exited before init"), the OFFICIAL source here DOES re-resume and DOES
    // reach the anthropic loopback (proven below via the fake's own request log, unaffected) — but
    // its own completion event is then swallowed by Defect 2 (the same generation-not-bumped
    // checkpoint collision, on this fresh incarnation's own reset local counters). Verified via the
    // fake's request log first (the workaround this file uses for Defect 2 throughout), and the
    // completion event is asserted afterward, honestly, per the spec (fails red on Defect 2).
    const t0 = Date.now();
    for (;;) {
      if (anthropicRequests.filter((r) => r.path === "/v1/messages").length > messagesRequestsBefore) break;
      if (Date.now() - t0 > 20_000) throw new Error("timed out waiting for the source's re-resumed request to reach the anthropic loopback");
      await Bun.sleep(20);
    }
    const messagesRequests = anthropicRequests.filter((r) => r.path === "/v1/messages");
    expect(messagesRequests.length).toBeGreaterThan(messagesRequestsBefore);
    expect(messagesRequests[messagesRequests.length - 1]!.body).toContain("still on claude?");
    expect(client.events.slice(sinceIdx).some((e) => e.type === "agent_error" && (e as { code?: string }).code === "process_death")).toBe(false);
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.indexOf(e) >= sinceIdx, 20_000);
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
  const anthropicRequests: Array<{ path: string; body: string }> = [];
  const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hello"] }], stopReason: "end_turn" };

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
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/unused", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { claudeExecutable: claudeRuntimeForTests()!.executable },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-m4" });
    // Contamination probe (best-effort, filesystem/env-name level — see this block's own doc): a
    // codex/openai-named credential material present in this SAME secret store, so a spawn that
    // ever forwarded FORBIDDEN_CHILD_ENV names would have something real to leak.
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
    const messagesBefore = anthropicRequests.filter((r) => r.path === "/v1/messages").length;
    await client.call(METHODS.sessionSend, { sessionId, text: "second, after the resume" }).catch(() => { /* fire; see Defect 2 below */ });
    // MEASURED (2026-09-14): this PLAIN, SAME-LEG cold resume (daemon restart, no handoff at all)
    // ALSO hits Defect 2 (see this file's header) — the resumed official incarnation's own fresh
    // local counters collide with generation 1's already-committed checkpoint, and `turn_completed`
    // never arrives. This BROADENS Defect 2's scope beyond cross-runtime handoffs: it is measured
    // here to affect ANY fresh incarnation after the first on a backend session with existing
    // history, including an ordinary crash/restart resume. Workaround: poll the destination fake's
    // own request log (unaffected) to reach the env/config-dir assertions below; the completion
    // event is asserted honestly afterward (fails red on Defect 2).
    {
      const t0 = Date.now();
      for (;;) {
        if (anthropicRequests.filter((r) => r.path === "/v1/messages").length > messagesBefore) break;
        if (Date.now() - t0 > 20_000) throw new Error("timed out waiting for the resumed official child's request to reach the loopback");
        await Bun.sleep(20);
      }
    }
    const messagesAfter = anthropicRequests.filter((r) => r.path === "/v1/messages");
    expect(messagesAfter.length).toBeGreaterThan(messagesBefore);
    expect(messagesAfter[messagesAfter.length - 1]!.body).toContain("second, after the resume");

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

    // CLAUDE_CONFIG_DIR stays Winter-owned across the resume — never `~/.claude`, never re-created
    // under a codex/openai-named path.
    const spool = officialConfigDirFor(home);
    expect(existsSync(spool)).toBe(true);
    expect(statSync(spool).mode & 0o777).toBe(0o700);
    const home200 = process.env.HOME;
    if (home200 !== undefined) expect(existsSync(join(home200, ".claude", "projects", sessionId))).toBe(false);
    expect(existsSync(join(spool, ".credentials.json"))).toBe(false);
    expect(existsSync(join(spool, "codex"))).toBe(false);
    expect(existsSync(join(spool, "openai"))).toBe(false);

    // A resume-staging root (`claude-resume-<uuid>`, router-owned, under system tmpdir — never
    // under `home`) may appear for this cross-generation resume; if it does, it must be FRESH (not
    // reused across generations) and must never itself carry a codex/openai-named file.
    const stagingAfter = readdirSync(tmpdir()).filter((n) => n.startsWith(RESUME_STAGING_PREFIX));
    const newStaging = stagingAfter.filter((n) => !stagingBefore.has(n));
    for (const dir of newStaging) {
      const full = join(tmpdir(), dir);
      const names = existsSync(full) ? readdirSync(full) : [];
      expect(names.some((n) => /codex|openai/i.test(n))).toBe(false);
    }

    // The SPEC-required completion event, asserted honestly last (never weakened): MEASURED
    // (2026-09-14) to fail here on Defect 2.
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId && client.events.indexOf(e) >= sinceIdx, 20_000);
  }, 90_000);
});
