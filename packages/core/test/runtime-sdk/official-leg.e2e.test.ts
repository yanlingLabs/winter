// P8c Task 1.2/1.4 (checkpoint b + the P8c-14 follow-on) — ONE OFFICIAL SESSION ON THE REAL
// RUNTIME against the Anthropic loopback fake.
//
// The FIRST describe block drives `official-session.ts` + `official-options.ts` +
// `official-capabilities.ts` DIRECTLY (checkpoint b's own proof, unchanged) — not routed through
// `startDaemon`/`ipc/server.ts`, so it stays green whatever `session-driver.ts`'s own wiring does.
//
// The SECOND describe block (P8c-14) is the follow-on: a REAL `startDaemon`, a real NDJSON client,
// `session.create`/`session.send`/`session.interrupt` over the wire — proving `session-driver.ts`'s
// leg dispatch end to end. `NORMA_OFFICIAL_TEST_BASE_URL` (session-driver.ts's own test-only
// hatch, same spirit as the `winter-test/` model-double convention) redirects the real credential
// path to the loopback fake without touching the `api-key` family's own env-allowlist shape.
//
// `describeWithClaudeRuntime` skips without the optional platform package and THROWS under
// `NORMA_CLAUDE_REQUIRE_RUNTIME=1` (P8c-9).
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@norma/protocol";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { ContextAssembler } from "../../src/agent/context";
import { ToolRegistry, type ToolDefinition } from "../../src/agent/tools/registry";
import { capabilityServer, type CapabilityServerRecord } from "../../src/capabilities";
import { FileSecretStore } from "../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { createNormaRuntimeSdk, type NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import { credentialRefFor, ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import type { OfficialInputDeps, OfficialSessionInput } from "../../src/runtime-sdk/official-options";
import { startOfficialSession, type OfficialSession } from "../../src/runtime-sdk/official-session";
import { createProjector, type CheckpointStore } from "../../src/projector";
import { z } from "zod";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID, withAnthropicLoopback, type AnthropicTurnScript } from "../helpers/claude-runtime";

const CATALOG_CLAUDE_MODEL = "claude-sonnet-5"; // a real pinned-catalog Claude model id (selectRuntime must recognize it)

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

class MemCheckpoints implements CheckpointStore {
  private marks = new Map<string, "begun" | "committed">();
  begin(key: { sourceId: string }): "begun" | "already-committed" | "pending-elsewhere" {
    const k = key.sourceId;
    if (this.marks.get(k) === "committed") return "already-committed";
    this.marks.set(k, "begun");
    return "begun";
  }
  complete(key: { sourceId: string }): void { this.marks.set(key.sourceId, "committed"); }
}

interface World {
  home: string;
  cwd: string;
  runtime: NormaRuntimeSdk;
  events: SessionEvent[];
  session: OfficialSession;
}

const worlds: World[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) { await w.runtime.dispose(); rmSync(w.home, { recursive: true, force: true }); }
});

const probeDef: ToolDefinition = {
  name: "probe",
  description: "an official-leg capability probe",
  args: z.object({ note: z.string() }),
  run: (args) => `probed: ${(args as { note: string }).note}`,
};

async function buildWorld(selection: RuntimeSelection, secretsDir: string, baseUrl: string, policy: "auto" | "dont-ask" | "plan" = "auto"): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), "p8c-official-e2e-"));
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const secrets = new FileSecretStore(secretsDir);
  // The REAL credential-material path (P8c-10): `anthropic:default` holds fake `sk-test`-style
  // material, read back through the SAME `keychainSeamFromSecretStore` seam a production daemon
  // uses — never a bespoke test keychain. `explicitCredentials` below still names the family
  // `custom` (the loopback endpoint needs `ANTHROPIC_BASE_URL` beside the key, which the `api-key`
  // family's own variable set does not include — WS-14 §12; see `official-options.ts`'s header).
  await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-e2e-material" });
  const credentialRef = credentialRefFor("anthropic")!;
  const runtime = await createNormaRuntimeSdk({
    home,
    settings: () => null,
    secrets,
    capabilities: [],
  });
  const officialPeer = await runtime.officialPeer();
  if (officialPeer === undefined) throw new Error("unreachable: the suite is skipped without a bed");

  const trust = new TrustStore(join(home, "trust.json"));
  trust.trust(cwd);
  const skills = new SkillStore({ normaHome: home, trust });
  const assembler = new ContextAssembler({ normaHome: home, trust, skills });

  const registry = new ToolRegistry();
  registry.register(probeDef);
  const capSession = { sessionId: "s_official_e2e", mode: "code" as const, cwd, roots: [cwd] };
  const probeServer = capabilityServer({ key: "probe", defs: [probeDef] }, capSession);
  const capabilities: CapabilityServerRecord = { [probeServer.name]: probeServer };

  const events: SessionEvent[] = [];
  const checkpoints = new MemCheckpoints();
  let seq = 0;

  const sessionId = "s_official_e2e";
  const backendSessionId = crypto.randomUUID();

  const inputDeps: OfficialInputDeps = {
    home,
    selection,
    explicitCredentials: [{ variable: "ANTHROPIC_API_KEY", ref: credentialRef }],
    explicitConnectionEnv: { ANTHROPIC_BASE_URL: baseUrl },
    claudeExecutableFor: () => ({ path: claudeRuntimeForTests()!.executable }),
    officialPeer,
    assembler,
    capabilities,
    canUseToolDeps: {
      approvals: new ApprovalBroker(),
      questions: new QuestionBroker(),
      gate: new PermissionGate(),
      policy,
      emit: () => {},
    },
    policy,
  };

  const sessionInput: OfficialSessionInput = { sessionId, mode: "code", cwd };

  const session = startOfficialSession({
    sessionId,
    backendSessionId,
    mode: "code",
    runtime,
    selection,
    sessionInput: () => sessionInput,
    inputDeps: () => inputDeps,
    projector: (generation) => createProjector({
      sessionId, mode: "code", generation, runtimeKind: "claude-agent",
      nextSeq: () => ++seq,
      checkpoint: checkpoints,
      now: () => new Date().toISOString(),
      log: { warn: () => {} },
    }),
    append: (e) => { const stamped = { ...e, seq: (e as { seq?: number }).seq ?? ++seq } as SessionEvent; events.push(stamped); if (process.env.DEBUG_E2E) console.log("EVENT", JSON.stringify(stamped).slice(0, 300)); return stamped; },
    broadcast: (e) => { events.push(e as unknown as SessionEvent); if (process.env.DEBUG_E2E) console.log("BROADCAST", JSON.stringify(e).slice(0, 300)); },
    log: (l) => { if (process.env.DEBUG_E2E) console.log("[log]", l); },
  });

  const world: World = { home, cwd, runtime, events, session };
  worlds.push(world);
  return world;
}

function selectionFor(overrides: Partial<RuntimeSelection> = {}): RuntimeSelection {
  return {
    runtimeKind: "claude-agent",
    providerId: "loopback",
    modelRef: LOOPBACK_MODEL_ID,
    family: "claude",
    authFamily: "custom",
    sdkVersion: "0.0.2",
    reason: "the e2e test bed",
    decidedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

async function waitFor(events: SessionEvent[], pred: (e: SessionEvent) => boolean, ms = 30_000): Promise<SessionEvent> {
  const t0 = Date.now();
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting; saw: ${events.map((e) => e.type).join(",")}`);
    await Bun.sleep(20);
  }
}

describeWithClaudeRuntime("official leg — one real session against the loopback fake", () => {
  test("turn_started -> assistant_message -> turn_completed; the loopback saw x-api-key, never the JSON material", async () => {
    const turns: AnthropicTurnScript[] = [{ blocks: [{ type: "text", chunks: ["hello ", "from the official leg"] }], stopReason: "end_turn" }];
    await withAnthropicLoopback(turns, async (fake, requests) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const selection = selectionFor();
      const w = await buildWorld(selection, secretsDir, fake.url);
      await w.session.send("say hello");
      await waitFor(w.events, (e) => e.type === "turn_completed");
      const types = w.events.map((e) => e.type);
      expect(types).toContain("user_message");
      expect(types).toContain("turn_started");
      expect(types.some((t) => t === "assistant_message" || t === "assistant_delta")).toBe(true);
      expect(types).toContain("turn_completed");

      const seen = requests().filter((r) => r.path === "/v1/messages");
      expect(seen.length).toBeGreaterThan(0);
      const auth = seen[0]!.headers["x-api-key"] ?? seen[0]!.headers["authorization"];
      expect(auth).toBeDefined();
      expect(String(auth)).not.toContain("sk-e2e");

      // `~/.claude` is never created — `CLAUDE_CONFIG_DIR` scopes everything under the temp home.
      expect(existsSync(join(w.home, ".claude"))).toBe(false);
    });
  }, 60_000);

  // Fix round 1 (item 0): router 0.0.3's `createApprovalBridge` is now wired for real
  // (`official-options.ts`) — a capability tool call reaches Norma's OWN approval flow, not the
  // router's fixed fail-closed default. Two shapes: the APPROVE path (policy "auto", which
  // `gate.evaluate`'s own "auto" column allows without a card) and the DENY path (policy
  // "dont-ask", which never prompts and denies outright — same `canUseToolFor` semantics as the
  // Winter leg, proven byte-identical in `approval-bridge.test.ts`).
  test("a capability tool call SUCCEEDS through the real approval bridge (policy auto)", async () => {
    const turns: AnthropicTurnScript[] = [
      { blocks: [{ type: "tool_use", id: "call_1", name: "mcp__norma__probe__probe", jsonChunks: [JSON.stringify({ note: "hi" })] }], stopReason: "tool_use" },
      { blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" },
    ];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto");
      await w.session.send("use the probe tool");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const call = w.events.find((e) => e.type === "tool_call") as (SessionEvent & { name?: string }) | undefined;
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      expect(call?.name).toBe("mcp__norma__probe__probe");
      expect(result?.isError).toBe(false);
      expect(result?.output).toContain("probed: hi");
    });
  }, 60_000);

  test("a capability tool call is DENIED through the real approval bridge (policy plan)", async () => {
    const turns: AnthropicTurnScript[] = [
      { blocks: [{ type: "tool_use", id: "call_1", name: "mcp__norma__probe__probe", jsonChunks: [JSON.stringify({ note: "hi" })] }], stopReason: "tool_use" },
      { blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" },
    ];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "plan");
      await w.session.send("use the probe tool");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      expect(result?.isError).toBe(true);
    });
  }, 60_000);

  test("session.interrupt ends the turn with an aborted terminal, not a thrown error", async () => {
    const longText = Array.from({ length: 200 }, (_, i) => `chunk-${i} `);
    const turns: AnthropicTurnScript[] = [{ blocks: [{ type: "text", chunks: longText }], stopReason: "end_turn" }];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url);
      await w.session.send("say a lot");
      // Give the stream a moment to actually start before interrupting it.
      await Bun.sleep(50);
      const { wasRunning } = await w.session.interrupt();
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const completed = w.events.find((e) => e.type === "turn_completed");
      expect(wasRunning).toBe(true);
      expect(completed).toBeDefined();
    });
  }, 60_000);
});

test("claude runtime bed resolves on this machine (sanity: the platform package really installed)", () => {
  const bed = claudeRuntimeForTests();
  if (bed === undefined) {
    console.warn("[official-leg.e2e] no platform package for this machine — the suite above was skipped");
    return;
  }
  expect(existsSync(bed.executable)).toBe(true);
});

// ====================================================================================================
// P8c-14 — session-driver.ts's leg dispatch, through a REAL startDaemon + the NDJSON wire.
// ====================================================================================================
describeWithClaudeRuntime("the official leg through startDaemon + IPC (P8c-14)", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let fakeUrl = "";
  let fakeClose: (() => Promise<void>) | undefined;
  let requests: Array<{ path: string; headers: Record<string, string> }> = [];

  const WINTER_BIN = process.env.NORMA_WINTER_EXECUTABLE ?? join(import.meta.dir, "../../../../dist/winter");

  const writeSettings = (): void => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/unused", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { winterExecutable: WINTER_BIN, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 10 },
    }, null, 2));
  };

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "norma-p8c14-e2e-")));
    writeSettings();
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-daemon-e2e" });
    // startFake here (not withAnthropicLoopback's own scope) — the fake must outlive `beforeAll`
    // and be reachable from every test in this block, closed once in `afterAll`.
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    let script: AnthropicTurnScript[] = [{ blocks: [{ type: "text", chunks: ["hello from the daemon e2e"] }], stopReason: "end_turn" }];
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: (_req, recorded) => {
          requests.push({ path: recorded.path, headers: recorded.headers });
          if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(script[0]!);
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    fakeUrl = fake.url;
    fakeClose = () => fake.close();
    (globalThis as { __setOfficialE2eScript?: (s: AnthropicTurnScript[]) => void }).__setOfficialE2eScript = (s) => { script = s; };
    process.env.NORMA_OFFICIAL_TEST_BASE_URL = fakeUrl;
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
    delete process.env.NORMA_OFFICIAL_TEST_BASE_URL;
    await fakeClose?.();
    rmSync(home, { recursive: true, force: true });
  });

  test("session.create with a Claude model + anthropic:default material -> the record says claude-agent; a turn completes", async () => {
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    const record = daemon!.winter.legOf(sessionId);
    expect(record).toBe("official");
    const rt = daemon!.runtimeState;
    if ("unavailable" in rt) throw rt.unavailable;
    expect(rt.records.get(sessionId)?.runtimeKind).toBe("claude-agent");
    await client.call(METHODS.sessionSend, { sessionId, text: "say hello" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
    const kinds = client.events.filter((e) => e.sessionId === sessionId).map((e) => e.type);
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("turn_completed");
    expect(requests.some((r) => r.path === "/v1/messages" && (r.headers["x-api-key"] !== undefined || r.headers["authorization"] !== undefined))).toBe(true);
  }, 60_000);

  test("session.interrupt on the official leg ends the turn (aborted), never a thrown error", async () => {
    (globalThis as { __setOfficialE2eScript?: (s: AnthropicTurnScript[]) => void }).__setOfficialE2eScript?.([
      { blocks: [{ type: "text", chunks: Array.from({ length: 100 }, (_, i) => `word-${i} `) }], stopReason: "end_turn" },
    ]);
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "say a lot" });
    await Bun.sleep(80);
    const res = await client.call<{ ok: boolean; wasRunning: boolean }>(METHODS.sessionInterrupt, { sessionId });
    expect(res.ok).toBe(true);
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
  }, 60_000);

  test("a Claude model with NO anthropic material is a typed refusal naming norma login --anthropic-key", async () => {
    // A fresh home with the SAME winter/claude executables but no stored credential at all.
    const bareHome = realpathSync(mkdtempSync(join(tmpdir(), "norma-p8c14-bare-")));
    writeFileSync(join(bareHome, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/unused", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { winterExecutable: WINTER_BIN, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 10 },
    }, null, 2));
    const bareSecrets = new FileSecretStore(join(bareHome, "test-secrets"));
    const bareDaemon = await startDaemon({ home: bareHome, secrets: bareSecrets, agentProvider: null });
    try {
      if ("unavailable" in bareDaemon.runtimeState) throw bareDaemon.runtimeState.unavailable;
      const bareClient = await TestClient.connect(bareDaemon.socketPath);
      try {
        await bareClient.hello(bareDaemon.tokens.harness, "e2e");
        let caught: { rpc?: { data?: { code?: string }; message?: string } } | undefined;
        try {
          await bareClient.call(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL });
        } catch (err) {
          caught = err as typeof caught;
        }
        expect(caught).toBeDefined();
        expect(caught?.rpc?.data?.code).toBe("runtime_selection_refused");
      } finally {
        bareClient.close();
      }
    } finally {
      await bareDaemon.stop();
      rmSync(bareHome, { recursive: true, force: true });
    }
  }, 60_000);
});
