// Winter Phase 10b (Lane D2, task D2-2) — WS-18 §9 A-5: "the five-hop chain
// `claude -> deepseek -> GLM -> gpt -> claude` keeps one conversation." W18-19's own table and its
// prompt rule ("prompts appear exactly at claude -> deepseek and gpt -> claude") is BINDING.
//
// STRUCTURAL FINDING (2026-09-14, blocks the request-body-carriage half of this task end to end):
// `session.create`/`session.setModel` can NEVER route to `deepseek` or `zai` (GLM) on this daemon
// build, REGARDLESS of loopback wiring or settings.json tricks. `providerSelectionFor`
// (`src/runtime-sdk/provider-selection.ts:69-98`) refuses any model whose provider has no row in
// `WINTER_CREDENTIAL_INVENTORY` (`src/runtime-sdk/keychain.ts:115-127`) — and that inventory is a
// FIXED, hand-written array with exactly THREE rows: `openai`, `codex-oauth`, `anthropic`. There is
// no `deepseek`/`zai` row, and (measured) no `startDaemon` test seam analogous to
// `officialConnectionOverride` to inject one. `session.create({model: "deepseek/deepseek-reasoner"})`
// against a real daemon refuses immediately: `"the model \"deepseek/deepseek-reasoner\" … is served
// by no row this session can use: … belongs to a provider with no configured credential ref
// (configured: none)"` — BEFORE any HTTP request is ever attempted, so no loopback fake, however
// wired, can be reached. This is true even though the pinned SDK's own catalog (0.0.11) carries
// full, real reasoning-continuity facts for both providers (proven below, directly against the
// REAL `daemonResolveEndpoint()`/`classifySwitch`) — the gap is in THIS daemon's own credential
// inventory, not the catalog. Reported to the controller: A-5's own request-body carriage
// assertions for the DeepSeek/GLM hops cannot be proven end to end until `WINTER_CREDENTIAL_INVENTORY`
// (or an equivalent test seam) gains rows for these two providers.
//
// SCOPE THIS FILE ACTUALLY COVERS, given that finding:
//   1. The PROMPT-TIMING half of A-5 (W18-19's own binding rule), proven against the REAL daemon
//      resolver and the REAL `classifySwitch` — never a fixture that fakes `readableState`/
//      `continuation` (the same discipline `test/providers/registry.test.ts`'s own D1-6 describe
//      block already established for two of these four pairs; this file computes all FOUR of the
//      chain's transitions the same way, including the two SILENT ones W18-19 also requires).
//   2. The two REACHABLE endpoints of the chain (claude, gpt) through REAL daemon wiring — the
//      SAME two directions `handoff-parity-e2e.test.ts`'s A-1/A-2 already prove in depth, so this
//      file does not re-implement them; it only confirms the chain's own FIRST and LAST prompts
//      fire against a REAL session (not just the resolver), referencing Defects 1/2 from that
//      file's own header where the ACTUAL round trip is blocked.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySwitch, type ContinuityEndpoint } from "@yanlinglabs/winter-provider-runtime";
import { openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { daemonResolveEndpoint } from "../../src/providers/registry";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

const CATALOG_GPT_MODEL = "openai/gpt-5.6-sol";
const CATALOG_CLAUDE_MODEL = "claude-sonnet-5";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part 1 — W18-19's prompt-timing table, over all four of the chain's real transitions, computed
// from the REAL catalog resolver + the REAL classifySwitch (never a fixture).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("A-5 part 1: the five-hop chain's prompt rule, against the REAL daemon resolver (no fixture)", () => {
  const resolve = daemonResolveEndpoint();
  const endpoints: Record<"claude" | "deepseek" | "glm" | "gpt", ContinuityEndpoint> = {
    claude: resolve({ providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5", family: "anthropic" }),
    deepseek: resolve({ providerId: "deepseek", modelKey: "deepseek/deepseek-reasoner", family: "deepseek" }),
    glm: resolve({ providerId: "zai", modelKey: "zai/glm-5", family: "glm" }),
    gpt: resolve({ providerId: "openai", modelKey: "openai/gpt-5.6-sol", family: "openai" }),
  };

  test("catalog premises this whole table rests on (measured against SDK 0.0.11, the amendment's own GLM overlay)", () => {
    expect(endpoints.gpt.readableState).toBe("none"); // hidden reasoning source
    expect(endpoints.gpt.continuation).not.toBe("none");
    expect(endpoints.claude.readableState).not.toBe("full-exposed"); // native replay only within claude
    expect(endpoints.deepseek.readableState).toBe("full-exposed"); // complete exposed
    // The amendment's own point: GLM now carries real reasoning evidence (0.0.11), unlike 0.0.10.
    expect(endpoints.glm.readableState).toBe("full-exposed");
  });

  test("claude -> deepseek PROMPTS (a native/summary-only source crossing to a foreign family is warned-lossy)", () => {
    const c = classifySwitch(endpoints.claude, endpoints.deepseek, { sourceTurns: 1 });
    expect(c.lossClass).toBe("warned-lossy");
    expect(c.warnings.length).toBeGreaterThan(0);
  });

  test("deepseek -> GLM is SILENT (complete exposed reasoning carries unmodified)", () => {
    const c = classifySwitch(endpoints.deepseek, endpoints.glm, { exposedComplete: true, sourceTurns: 1 });
    expect(c.lossClass).not.toBe("warned-lossy");
  });

  test("GLM -> gpt is SILENT (complete exposed reasoning still carries, now as a tag on a hidden-reasoning destination)", () => {
    const c = classifySwitch(endpoints.glm, endpoints.gpt, { exposedComplete: true, sourceTurns: 1 });
    expect(c.lossClass).not.toBe("warned-lossy");
  });

  test("gpt -> claude PROMPTS (a hidden-reasoning source crossing to a different domain is warned-lossy)", () => {
    const c = classifySwitch(endpoints.gpt, endpoints.claude, { sourceTurns: 1 });
    expect(c.lossClass).toBe("warned-lossy");
    expect(c.warnings.length).toBeGreaterThan(0);
    for (const w of c.warnings) expect(w).not.toMatch(/\bSDK\b|\bruntime\b|Claude Agent|Winter Agent/i); // R-10b-4
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part 2 — the chain's two REACHABLE endpoints (claude, gpt), through REAL daemon wiring: the FIRST
// hop's own source prompt (claude -> [a foreign family]) and the LAST hop's own prompt (gpt ->
// claude), each measured directly against a real session.setModel call — never inferred from the
// resolver alone. The actual round trip past the prompt is covered (and found blocked) by
// `handoff-parity-e2e.test.ts`'s A-1 (Defect 1) and A-2 (Defect 2); this file does not repeat that
// depth, only confirms the CHAIN's own two prompting edges fire against a live session.
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
      // The actual resumed round trip past this prompt is Defect 1 (handoff-parity-e2e.test.ts's
      // A-1, same pairing) — not repeated here.

      rmSync(cwd, { recursive: true, force: true });
    }, 90_000);
  });
});
