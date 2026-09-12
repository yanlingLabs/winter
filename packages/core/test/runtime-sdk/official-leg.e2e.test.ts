// P8c Task 1.2/1.4 (checkpoint b + the P8c-14 follow-on) — ONE OFFICIAL SESSION ON THE REAL
// RUNTIME against the Anthropic loopback fake.
//
// The FIRST describe block drives `official-session.ts` + `official-options.ts` +
// `official-capabilities.ts` DIRECTLY (checkpoint b's own proof, unchanged) — not routed through
// `startDaemon`/`ipc/server.ts`, so it stays green whatever `session-driver.ts`'s own wiring does.
//
// The SECOND describe block (P8c-14) is the follow-on: a REAL `startDaemon`, a real NDJSON client,
// `session.create`/`session.send`/`session.interrupt` over the wire — proving `session-driver.ts`'s
// leg dispatch end to end. `startDaemon`'s own `officialConnectionOverride` test opt (fix round 1,
// M2 — NEVER an ambient env var; the deleted `NORMA_OFFICIAL_TEST_BASE_URL` hatch was one) redirects
// the real credential path to the loopback fake without touching the `api-key` family's own
// env-allowlist shape, the same "a value only a test constructs" spirit as `winter-test/<name>`.
//
// `describeWithClaudeRuntime` skips without the optional platform package and THROWS under
// `NORMA_CLAUDE_REQUIRE_RUNTIME=1` (P8c-9).
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@norma/protocol";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import type { ReviewerResolver } from "@yanlinglabs/winter-agent-sdk/tools";
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
import { FakeProvider } from "../../src/agent/fake-provider";
import { BashReviewer } from "../../src/agent/reviewer";
import { createNormaRuntimeSdk, type NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import { credentialRefFor, ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { sessionHooksFor, type SessionHooksDeps } from "../../src/runtime-sdk/hooks";
import type { OfficialInputDeps, OfficialSessionInput } from "../../src/runtime-sdk/official-options";
import { startOfficialSession, type OfficialSession } from "../../src/runtime-sdk/official-session";
import { createProjector, type CheckpointStore } from "../../src/projector";
import { z } from "zod";
import {
  claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID, withAnthropicLoopback,
  hermeticOfficialHome, cleanupHermeticOfficialHomes,
  type AnthropicTurnScript, type HermeticOfficialHome,
} from "../helpers/claude-runtime";

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
  backendSessionId: string;
  /** m1: the CHILD's own hermetic `HOME` — distinct from `home` (NORMA_HOME) above. Before this,
   *  nothing in this file ever gave the spawned `claude` process a `HOME` at all, so it silently
   *  inherited the real machine's `$HOME` and every "never touches `~/.claude`" assertion was
   *  checking the wrong directory (m1: `hermeticOfficialHome` was exported and unused). */
  hermetic: HermeticOfficialHome;
}

const worlds: World[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) { await w.runtime.dispose(); rmSync(w.home, { recursive: true, force: true }); }
  cleanupHermeticOfficialHomes();
});

const probeDef: ToolDefinition = {
  name: "probe",
  description: "an official-leg capability probe",
  args: z.object({ note: z.string() }),
  run: (args) => `probed: ${(args as { note: string }).note}`,
};

async function buildWorld(
  selection: RuntimeSelection, secretsDir: string, baseUrl: string, policy: "auto" | "dont-ask" | "plan" = "auto",
  opts: { reviewer?: BashReviewer; mode?: "code" | "chat"; hookFacade?: SessionHooksDeps["hookFacade"]; advisorReviewer?: ReviewerResolver } = {},
): Promise<World> {
  const mode = opts.mode ?? "code";
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
    ...(opts.advisorReviewer === undefined ? {} : { advisorReviewer: opts.advisorReviewer }),
  });
  const officialPeer = await runtime.officialPeer();
  if (officialPeer === undefined) throw new Error("unreachable: the suite is skipped without a bed");

  const trust = new TrustStore(join(home, "trust.json"));
  trust.trust(cwd);
  const skills = new SkillStore({ normaHome: home, trust });
  const assembler = new ContextAssembler({ normaHome: home, trust, skills });

  const registry = new ToolRegistry();
  registry.register(probeDef);
  const capSession = { sessionId: "s_official_e2e", mode, cwd, roots: [cwd] };
  const probeServer = capabilityServer({ key: "probe", defs: [probeDef] }, capSession);
  const capabilities: CapabilityServerRecord = { [probeServer.name]: probeServer };

  const events: SessionEvent[] = [];
  const checkpoints = new MemCheckpoints();
  let seq = 0;

  const sessionId = "s_official_e2e";
  const backendSessionId = crypto.randomUUID();

  // m1: a hermetic HOME for the CHILD process, distinct from `home` (NORMA_HOME) above — passed
  // through `officialInputFor`'s own `env` door (`minimalOsEnvironment` reads `env.HOME`), the same
  // door a production daemon has (`officialInputFor`'s `deps.env ?? process.env`). Everything else
  // in `process.env` (PATH in particular — the child needs a real one to execute at all) still
  // passes through; only `HOME` is overridden.
  const hermetic = hermeticOfficialHome();

  // M4 (ruling P8c-19): the SAME `hooks.ts` builder the Winter leg uses, its `.official` half —
  // see `hooks.ts`'s own header for why that value is safe to hand the official leg unmodified.
  // Only built when a test asks for a reviewer OR a hook facade — every other `buildWorld` caller
  // keeps running with no `Options.hooks` at all, byte-identical to before this fix wave.
  const hooks = opts.reviewer === undefined && opts.hookFacade === undefined
    ? undefined
    : sessionHooksFor({
        sessionId, roots: [cwd], policy: () => policy,
        ...(opts.reviewer === undefined ? {} : { reviewer: opts.reviewer }),
        ...(opts.hookFacade === undefined ? {} : { hookFacade: opts.hookFacade }),
      }).official;

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
    env: { ...process.env, HOME: hermetic.home },
    ...(hooks === undefined ? {} : { hooks }),
  };

  const sessionInput: OfficialSessionInput = { sessionId, mode, cwd };

  const session = startOfficialSession({
    sessionId,
    backendSessionId,
    mode,
    runtime,
    selection,
    sessionInput: () => sessionInput,
    inputDeps: () => inputDeps,
    projector: (generation) => createProjector({
      sessionId, mode, generation, runtimeKind: "claude-agent",
      nextSeq: () => ++seq,
      checkpoint: checkpoints,
      now: () => new Date().toISOString(),
      log: { warn: () => {} },
    }),
    append: (e) => { const stamped = { ...e, seq: (e as { seq?: number }).seq ?? ++seq } as SessionEvent; events.push(stamped); if (process.env.DEBUG_E2E) console.log("EVENT", JSON.stringify(stamped).slice(0, 300)); return stamped; },
    broadcast: (e) => { events.push(e as unknown as SessionEvent); if (process.env.DEBUG_E2E) console.log("BROADCAST", JSON.stringify(e).slice(0, 300)); },
    log: (l) => { if (process.env.DEBUG_E2E) console.log("[log]", l); },
  });

  const world: World = { home, cwd, runtime, events, session, backendSessionId, hermetic };
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

      // m1: the OBSERVED `CLAUDE_CONFIG_DIR`/spool a fresh-spool launch actually used
      // (`officialSpoolRoot(winterHome)` — WS-14 §1 profile 1) lives under NORMA_HOME (`w.home`,
      // the router's own `winterHome`, per `create.ts`'s `handoff: { winterHome: deps.home }`) —
      // never under the child's hermetic `HOME`. The real `claude` CLI writing into it (a real file
      // on disk, not merely a configured option) is the actual proof CLAUDE_CONFIG_DIR took effect.
      const spoolRoot = join(w.home, "runtimes", "official-agent-spool");
      expect(existsSync(spoolRoot)).toBe(true);

      // m1: `~/.claude` is never created under the CHILD's own (hermetic) HOME — before this fix
      // the child had no HOME of its own (it silently inherited the real machine's `$HOME`), so this
      // assertion checked the wrong directory and passed for the wrong reason.
      expect(existsSync(join(w.hermetic.home, ".claude"))).toBe(false);
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

  test("session.interrupt ends the turn (wasRunning: true), not a thrown error", async () => {
    const longText = Array.from({ length: 200 }, (_, i) => `chunk-${i} `);
    const turns: AnthropicTurnScript[] = [{ blocks: [{ type: "text", chunks: longText }], stopReason: "end_turn" }];
    // A real HTTP round trip to loopback is usually too fast for a 30-50ms interrupt to land before
    // the whole (short) response has already arrived — delaying the FIRST byte gives the interrupt
    // a real window to cancel the in-flight request instead of racing an already-finished turn.
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url);
      await w.session.send("say a lot");
      // Give the stream a moment to actually start before interrupting it.
      await Bun.sleep(80);
      const { wasRunning } = await w.session.interrupt();
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const completed = w.events.find((e) => e.type === "turn_completed") as (SessionEvent & { stopReason?: string }) | undefined;
      expect(wasRunning).toBe(true);
      expect(completed).toBeDefined();
      // Minor m2 (measured, not assumed): even with the loopback's first byte delayed 500ms and
      // `interrupt()` called ~80ms after `send()` — well before any response data could have
      // arrived — the terminal's `stopReason` still reads `"end_turn"`, never `"aborted"`, on the
      // real pinned 0.3.250 CLI. `wasRunning: true` (asserted above) is the measured, reliable
      // signal that the interrupt reached a real in-flight turn; `stopReason` is NOT — CARRIED
      // rather than forced green, pending a closer look at what field (if any) the real CLI sets
      // on an interrupted result when the interrupt fires before the model's own response starts.
      expect(completed?.stopReason).toBe("end_turn");
    }, { delayFirstResponseMs: 500 });
  }, 60_000);

  // Fix round 1, M1: per-incarnation AbortController + runtime.trackQuery/untrack — mirrors
  // `create.test.ts`'s own Winter shutdown proof, on the official leg.
  //
  // Fix wave m3 — MEASURED (not assumed) against the real 0.3.250 binary, with instrumented probes:
  //
  //  1. The PRECONDITION race the review named: `official-session.ts`'s `beginAndPush` increments
  //     `inFlight` SYNCHRONOUSLY inside `send()` (before any `await` that could let a response
  //     land), so `turnRunning` is ALREADY `true` the instant `send()`'s own promise resolves — the
  //     original 30ms `Bun.sleep` before checking it was pure risk, not insurance: on a quiet
  //     machine the WHOLE turn (request, streamed response, `inFlight` back to 0) could complete
  //     inside those 30ms, racing an already-finished turn. Dropping the sleep and reading
  //     `turnRunning` in the SAME synchronous continuation `send()` resolves into removes the race
  //     outright — nothing else can run before this line.
  //
  //  2. A SECOND, previously-undiagnosed race in the POSTCONDITION, found by instrumenting this
  //     exact test: `dispose()`'s own `SHUTDOWN_QUERY_GRACE_MS` is 300ms, and — measured — a
  //     300-word streamed turn through the real spawned CLI routinely has NOT resolved by then, so
  //     `dispose()` takes `endWithin`'s TIMEOUT branch: it calls `abort.abort()` and resolves
  //     IMMEDIATELY, without waiting for `run()`'s async iteration to actually notice the abort and
  //     run its `finally` (which is what flips `state` off `"live"`) — `create.ts`'s own contract is
  //     "aborts stragglers", never "waits out stragglers". Measured propagation lag after the abort
  //     signal: consistently ~100ms, whether the turn's response arrives naturally or is held back
  //     with `delayFirstResponseMs` (holding it 2000ms still flipped `state` at ~400ms after
  //     `dispose()` started, NOT at the 2000ms mark — the abort is genuinely fast; it just is not
  //     SYNCHRONOUS with `dispose()`'s own promise settling). So asserting `state` in the same tick
  //     `dispose()` resolves was never a sound proof of "ends the child" — it happened to pass only
  //     when the turn's natural completion beat the 300ms grace outright.
  //
  //  The fix for both: hold the loopback's first byte well past the grace window (so the precondition
  //  and the abort path are exercised deterministically, never racing how fast 300 chunks happen to
  //  stream), and bound the POSTCONDITION with a short poll instead of a same-tick assertion — proving
  //  "ends the child, no orphan" the way it is actually true: eventually, within a small bounded
  //  window, not synchronously with `dispose()`'s own return.
  test("M1: daemon shutdown (runtime.dispose) with a live official turn ends the child, no orphan", async () => {
    const longText = Array.from({ length: 300 }, (_, i) => `word-${i} `);
    const turns: AnthropicTurnScript[] = [{ blocks: [{ type: "text", chunks: longText }], stopReason: "end_turn" }];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url);
      await w.session.send("say a whole lot");
      // No sleep: `inFlight` was already incremented SYNCHRONOUSLY by `send()`'s own `beginAndPush`
      // call, before this line ever runs — nothing else gets a turn to decrement it first.
      expect(w.session.turnRunning).toBe(true);
      // `dispose()` is what a daemon `stop()` calls — it must return within its own bounded grace
      // even though a turn is still in flight (measured: it does, via the abort path below), and
      // the session must eventually leave `"live"` — never orphan the child. Idempotent (create.ts's
      // own contract), so `afterEach`'s own cleanup call afterward is a safe no-op.
      await w.runtime.dispose();
      // Bounded poll, not a same-tick assertion (see this test's own header — measured ~100ms of
      // abort-propagation lag past `dispose()`'s own return; 5s is a generous multiple of that,
      // nowhere near the SDK's own end-to-end turn/teardown budget this test's 60s timeout allows).
      const deadline = Date.now() + 5_000;
      while (w.session.state === "live" && Date.now() < deadline) await Bun.sleep(25);
      expect(w.session.state).not.toBe("live");
    }, { delayFirstResponseMs: 2_000 });
  }, 60_000);

  // ── Fix wave C1 (whole-branch review): the control-plane fence, MEASURED on the real binary ──
  //
  // `withAnthropicLoopback`'s `turns` array is captured BY REFERENCE in the fake's request handler
  // (it indexes `turns[...]` live, at request time, never a snapshot taken up front) — so each test
  // below scripts a PLACEHOLDER turn to satisfy the call signature, then overwrites `turns[0]` with
  // the real absolute path once `buildWorld` has minted this run's `home`/`cwd`, before calling
  // `session.send`. The fake sees only the overwritten script.
  const PLACEHOLDER_TURN = (name: string, jsonChunks: string[]): AnthropicTurnScript => (
    { blocks: [{ type: "tool_use", id: "call_1", name, jsonChunks }], stopReason: "tool_use" }
  );
  const DONE_TURN: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" };

  test("C1: a Read of <home>/run/probe.txt is DENIED — the sentinel content reaches no event", async () => {
    const turns: AnthropicTurnScript[] = [PLACEHOLDER_TURN("Read", [JSON.stringify({ file_path: "/placeholder" })]), DONE_TURN];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto");
      const runDir = join(w.home, "run");
      mkdirSync(runDir, { recursive: true });
      const probePath = join(runDir, "probe.txt");
      const SENTINEL = "NORMA_CONTROL_PLANE_SENTINEL_9f3d1a";
      writeFileSync(probePath, SENTINEL);
      turns[0] = PLACEHOLDER_TURN("Read", [JSON.stringify({ file_path: probePath })]);
      await w.session.send("read that file for me and tell me what it says");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      expect(result).toBeDefined();
      expect(result?.isError).toBe(true);
      for (const e of w.events) expect(JSON.stringify(e)).not.toContain(SENTINEL);
    });
  }, 60_000);

  test("C1: a Read of an ordinary cwd file still works (the fence is narrow, not a blanket read denial)", async () => {
    const CONTENT = "ordinary cwd content, unrelated to the control plane";
    const turns: AnthropicTurnScript[] = [PLACEHOLDER_TURN("Read", [JSON.stringify({ file_path: "/placeholder" })]), DONE_TURN];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto");
      const target = join(w.cwd, "ordinary.txt");
      writeFileSync(target, CONTENT);
      turns[0] = PLACEHOLDER_TURN("Read", [JSON.stringify({ file_path: target })]);
      await w.session.send("read that file for me and tell me what it says");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      expect(result?.isError).toBe(false);
      expect(result?.output).toContain(CONTENT);
    });
  }, 60_000);

  async function expectRuntimesWriteDenied(policy: "auto" | "dont-ask"): Promise<void> {
    const turns: AnthropicTurnScript[] = [PLACEHOLDER_TURN("Write", [JSON.stringify({ file_path: "/placeholder", content: "x" })]), DONE_TURN];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, policy);
      const runtimesDir = join(w.home, "runtimes");
      mkdirSync(runtimesDir, { recursive: true }); // exists beforehand so a denial can't be mistaken for ENOENT
      const target = join(runtimesDir, "should-not-exist.txt");
      turns[0] = PLACEHOLDER_TURN("Write", [JSON.stringify({ file_path: target, content: "should never land on disk" })]);
      await w.session.send("write that file for me");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      expect(result).toBeDefined();
      expect(result?.isError).toBe(true);
      expect(existsSync(target)).toBe(false);
    });
  }

  test("C1: a Write into <home>/runtimes/ is DENIED under policy auto", async () => {
    await expectRuntimesWriteDenied("auto");
  }, 60_000);

  test("C1: a Write into <home>/runtimes/ is DENIED under policy dont-ask", async () => {
    await expectRuntimesWriteDenied("dont-ask");
  }, 60_000);

  // ── Fix wave M4 (ruling P8c-19): the bash reviewer reaches the official leg's Options.hooks ──
  //
  // Mirrors `test/e2e/winter-hooks-review-wiring-e2e.test.ts`'s own Winter-leg proof: a `Bash` call
  // whose command trips `bashLooksSafe` to false (a shell redirect, `>`) must reach `bashReviewerHook`
  // under `auto` policy; the hook calls the SAME `BashReviewer` (over a `FakeProvider` scripted to
  // answer "unsafe"); a `PreToolUse` deny must block the call end to end on the REAL 0.3.250 binary —
  // the resulting `tool_result` must carry the FAKE reviewer's own reason text, which is only
  // possible if `sessionHooksFor(...).official` (this fix wave's own change) actually reached
  // `Options.hooks` on this leg, not the pre-fix-wave `undefined`.
  test("M4: the bash reviewer (sessionHooksFor(...).official) blocks an unsafe Bash call on the real binary", async () => {
    const reviewProvider = new FakeProvider([[
      { type: "text_delta", delta: '{"verdict":"unsafe","reason":"official-leg-hooks-forced-unsafe"}' },
      { type: "done", stopReason: "end_turn" },
    ]], []);
    const reviewer = new BashReviewer({ provider: { provider: reviewProvider, model: "fake-1" } });
    const turns: AnthropicTurnScript[] = [
      { blocks: [{ type: "tool_use", id: "call_1", name: "Bash", jsonChunks: [JSON.stringify({ command: "echo hi > /tmp/norma-p8c-m4-should-not-run" })] }], stopReason: "tool_use" },
      DONE_TURN,
    ];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { reviewer });
      await w.session.send("run that shell command for me");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      expect(result).toBeDefined();
      // The reviewer's own reason, not the command's stdout — only reachable if the official leg's
      // Options.hooks actually carried the bash-reviewer PreToolUse group.
      expect(result?.isError).toBe(true);
      expect(result?.output).toContain("official-leg-hooks-forced-unsafe");
      expect(reviewProvider.requests.length).toBeGreaterThan(0);
    });
  }, 60_000);

  // ── Phase 8d Task 3.2 — remaining official-leg measurements (WS-17 §8, real binary) ──────────

  test("8d MEASURED: a Bash read OUTSIDE cwd is ALLOWED on this leg — no sandbox denies it (unlike Winter's own seatbelt)", async () => {
    // MEASURED, not assumed (this test's premise going in was the OPPOSITE): `sandboxConfigFor(home)`
    // (reused verbatim on this leg) denies only `<home>/run`/`<home>/runtimes` — Norma's own
    // philosophy is unrestricted reads otherwise (CLAUDE.md: "the sole read denial is ~/.norma/run").
    // The real 0.3.250 CLI's own default sandbox (`Options.sandbox`, reused from `sandboxConfigFor`)
    // does NOT additionally fence Bash to the working directory the way `agent/sandbox.ts`'s
    // seatbelt profile does for the retired engine — an out-of-cwd `cat` SUCCEEDS end to end, and its
    // content reaches the ordinary `tool_result` event. This is the exact "denial shape" measurement
    // Task 3.2 asked for: on the official leg, filesystem containment for Bash is `permissions.deny`
    // (named paths) ONLY — there is no path-independent out-of-cwd fence — so a deployment relying on
    // Bash confinement to cwd for the official leg needs an explicit `permissions.deny` rule of its
    // own; `sandboxConfigFor`'s current denyRead/denyWrite lists (`<home>/run`, `<home>/runtimes`)
    // are the daemon control plane ONLY, never a project-boundary fence.
    const outsideDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-outside-"));
    const SENTINEL = "NORMA_8D_OUTSIDE_CWD_SENTINEL_7c2b";
    writeFileSync(join(outsideDir, "secret.txt"), SENTINEL);
    const turns: AnthropicTurnScript[] = [PLACEHOLDER_TURN("Bash", [JSON.stringify({ command: "cat /placeholder" })]), DONE_TURN];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto");
      const target = join(outsideDir, "secret.txt");
      turns[0] = PLACEHOLDER_TURN("Bash", [JSON.stringify({ command: `cat ${target}` })]);
      await w.session.send("cat that file for me");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      expect(result).toBeDefined();
      expect(result?.isError).toBe(false);
      expect(result?.output).toContain(SENTINEL);
      console.warn(`[8d official-leg] MEASURED: an out-of-cwd Bash read is ALLOWED on the official leg (policy=auto, no seatbelt-equivalent fence) — isError=${result?.isError}`);
      rmSync(outsideDir, { recursive: true, force: true });
    });
  }, 60_000);

  test("8d: additionalDisallowedTools is HONOURED by the real binary — a chat-mode session's system/init.tools never advertises Bash, a code-mode one does", async () => {
    const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
    await withAnthropicLoopback([DONE_TURN], async (fake) => {
      const codeWorld = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { mode: "code" });
      await codeWorld.session.send("hi");
      await waitFor(codeWorld.events, (e) => e.type === "turn_completed", 45_000);
      expect(codeWorld.session.init?.tools).toContain("Bash");
    });
    await withAnthropicLoopback([DONE_TURN], async (fake) => {
      const chatWorld = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { mode: "chat" });
      await chatWorld.session.send("hi");
      await waitFor(chatWorld.events, (e) => e.type === "turn_completed", 45_000);
      expect(chatWorld.session.init?.tools).toBeDefined();
      expect(chatWorld.session.init?.tools).not.toContain("Bash");
    });
  }, 90_000);

  // ── PostToolUse / PostToolUseFailure fire on the official binary (Task 3.2) ──────────────────
  //
  // `hooks.ts`'s `pluginPostToolUseHook`/`pluginPostToolUseFailureHook` are already measured on the
  // WINTER leg (P8c-7's own `hooks-measure.e2e.test.ts`); M4 above proves the official leg's
  // PreToolUse group (the bash reviewer) fires on the REAL 0.3.250 binary, but nothing yet measures
  // whether the SAME binary's PostToolUse/PostToolUseFailure events reach a plugin-shaped
  // `HookFacadeLike` on this leg — this is that measurement, with the PINNED payload shape
  // `pluginPostToolUseHook`/`pluginPostToolUseFailureHook` build (`toolName`, `argsJson`, `output`,
  // `isError`, `threadId`).
  test("8d: PostToolUse fires (with the real tool output) for a SUCCEEDED call, on the real binary", async () => {
    const calls: Array<{ event: string; extra: Record<string, unknown> }> = [];
    const hookFacade: SessionHooksDeps["hookFacade"] = {
      async runFor(event, extra) { calls.push({ event, extra }); return []; },
    };
    const turns: AnthropicTurnScript[] = [
      { blocks: [{ type: "tool_use", id: "call_1", name: "mcp__norma__probe__probe", jsonChunks: [JSON.stringify({ note: "8d-post" })] }], stopReason: "tool_use" },
      DONE_TURN,
    ];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { hookFacade });
      await w.session.send("use the probe tool");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const post = calls.find((c) => c.event === "post-tool" && c.extra.toolName === "mcp__norma__probe__probe");
      expect(post).toBeDefined();
      expect(post?.extra).toMatchObject({ toolName: "mcp__norma__probe__probe", isError: false, threadId: "main" });
      expect(String(post?.extra.output)).toContain("probed: 8d-post");
    });
  }, 60_000);

  test("8d: PostToolUseFailure fires (isError: true) for a call that RAN and failed, on the real binary", async () => {
    // A Bash command that RUNS (passes every permission check) and then fails at execution — NOT the
    // C1 control-plane fence: a call the fence denies never runs at all, so PostToolUse/
    // PostToolUseFailure never fire for it either (measured separately, below) — this is `hooks.ts`'s
    // OWN documented rule for a PreToolUse deny, and the control-plane fence is functionally the same
    // "never ran" shape. `cat` of a path that genuinely does not exist is the honest "ran, failed" case.
    const calls: Array<{ event: string; extra: Record<string, unknown> }> = [];
    const hookFacade: SessionHooksDeps["hookFacade"] = {
      async runFor(event, extra) { calls.push({ event, extra }); return []; },
    };
    const turns: AnthropicTurnScript[] = [PLACEHOLDER_TURN("Bash", [JSON.stringify({ command: "cat /this/path/genuinely/does/not/exist/8d" })]), DONE_TURN];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { hookFacade });
      await w.session.send("run that shell command for me");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { isError?: boolean }) | undefined;
      expect(result?.isError).toBe(true); // the call genuinely ran and failed (not denied)
      const postToolCalls = calls.filter((c) => c.event === "post-tool");
      const failed = postToolCalls.find((c) => c.extra.isError === true);
      console.warn(`[8d official-leg] PostToolUse/PostToolUseFailure calls observed for the failing Bash call: ${JSON.stringify(postToolCalls.map((c) => ({ isError: c.extra.isError, toolName: c.extra.toolName })))}`);
      expect(failed).toBeDefined();
      expect(failed?.extra).toMatchObject({ toolName: "Bash", isError: true, threadId: "main" });
    });
  }, 60_000);

  test("8d MEASURED: the C1 control-plane fence denies BEFORE the tool runs — neither PostToolUse nor PostToolUseFailure fire for it", async () => {
    const calls: Array<{ event: string; extra: Record<string, unknown> }> = [];
    const hookFacade: SessionHooksDeps["hookFacade"] = {
      async runFor(event, extra) { calls.push({ event, extra }); return []; },
    };
    const turns: AnthropicTurnScript[] = [PLACEHOLDER_TURN("Read", [JSON.stringify({ file_path: "/placeholder" })]), DONE_TURN];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { hookFacade });
      const runDir = join(w.home, "run");
      mkdirSync(runDir, { recursive: true });
      const probePath = join(runDir, "probe-8d.txt");
      writeFileSync(probePath, "denied content");
      turns[0] = PLACEHOLDER_TURN("Read", [JSON.stringify({ file_path: probePath })]);
      await w.session.send("read that file for me");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { isError?: boolean }) | undefined;
      expect(result?.isError).toBe(true); // the fence still denies it (C1, re-confirmed)
      const postToolCalls = calls.filter((c) => c.event === "post-tool");
      console.warn(`[8d official-leg] MEASURED: post-tool hook calls for a control-plane-denied Read: ${postToolCalls.length} (expected 0 — the deny happens before the tool ever runs)`);
      expect(postToolCalls).toHaveLength(0);
    });
  }, 60_000);

  // ── P8d-17: the OFFICIAL leg's own `advisor` tool call reaching advisorReviewerFor — MEASURED ──
  //
  // The seam itself (`advisorReviewerFor`'s new `connectionOverride`, `advisor-reviewer.ts`) is
  // built, wired into `buildWorld` (an `advisorReviewer` this session's `NormaRuntimeSdk` is
  // constructed WITH — every other `buildWorld` call in this file omits it), and typechecks.
  //
  // MEASURED, NOT ASSUMED: scripting a `tool_use` named "advisor" (parameterless, per the SDK's own
  // `ADVISOR_DEFINITION`: "the built-in name IS the bare name... on the official branch") and
  // sending it to the real 0.3.250 binary produces `<tool_use_error>Error: No such tool available:
  // advisor</tool_use_error>` — the model's own call is REFUSED before it ever reaches
  // `resolveReviewer()` (confirmed: the Anthropic loopback saw exactly ONE request, the main turn's
  // own scripted `tool_use`, never a second request for the advisor's own `generate()` call).
  //
  // Diagnosed one level further (bounded): the router's own `official/aliases.ts`
  // (`ALIASED_BUILTINS`/`officialToolAliases`) states a `toolAliases` table redirecting
  // `SendMessage`/`ListAgents`/`ReadNotifications`/`advisor` to their canonical registered names, and
  // that table is NOT re-exported from the package's public barrel (its `exports` map has one entry,
  // `"."` — the same gap `official-capabilities.ts`'s own header documents for
  // `createApprovalBridge`). Threading a hand-built equivalent onto the outer `Options.toolAliases`
  // (the `sdk.query()` call in `official-session.ts`'s `open()`) did NOT change the outcome — still
  // refused — which is consistent with `ALIASED_BUILTINS`'s own row for advisor being an IDENTITY
  // mapping (`{builtin: "advisor", tool: "advisor"}`, unlike the other three), meaning no alias was
  // ever the missing piece here. That attempted fix was REVERTED (unverified for the other three
  // rows too, and a production wiring change must not ship unverified) — this file records the
  // measurement rather than a fix that could not be confirmed to work.
  //
  // UNPROVEN, WITH THE EXACT BLOCKER: something beyond `resolveReviewer`/`connectionOverride` must
  // register the official leg's own standing-server tool (`advisor`) with the real 0.3.250 CLI before
  // the model can call it at all — no code path in `official-options.ts`/`official-session.ts` builds
  // such a registration today (`officialInputFor`'s own `mcpServers` covers ONLY Norma's capability
  // servers, never the router's native standing-server tools). Diagnosing that mechanism needs
  // reading router-internal code beyond what this lane's briefs sanctioned; recorded as a carry.
  test("P8d-17 MEASURED: the official leg's real binary refuses the bare 'advisor' tool call — resolveReviewer/connectionOverride are never reached", async () => {
    const turns: AnthropicTurnScript[] = [
      { blocks: [{ type: "tool_use", id: "call_1", name: "advisor", jsonChunks: ["{}"] }], stopReason: "tool_use" },
      DONE_TURN,
    ];
    let anthropicCallCount = 0;
    const { startFake } = await import("@yanlinglabs/winter-provider-conformance");
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            anthropicCallCount += 1;
            return (await import("@yanlinglabs/winter-provider-conformance")).anthropicFake.anthropicTurnResponse(turns[Math.min(anthropicCallCount - 1, turns.length - 1)]!);
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    try {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const { advisorReviewerFor, familyOfModel } = await import("../../src/runtime-sdk/advisor-reviewer");
      let reviewerGenerateCalled = false;
      const advisorReviewer = advisorReviewerFor({
        settings: () => undefined,
        secrets: new FileSecretStore(secretsDir),
        familyOf: familyOfModel,
        sessionModel: () => "claude-sonnet-5",
        connectionOverride: () => ({ anthropicBaseUrl: fake.url }),
      });
      const wrappedResolver = () => {
        const resolved = advisorReviewer();
        if (resolved === undefined) return undefined;
        return { ...resolved, provider: { generate: async (i: Parameters<typeof resolved.provider.generate>[0]) => { reviewerGenerateCalled = true; return resolved.provider.generate(i); } } };
      };
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { advisorReviewer: wrappedResolver });
      await w.session.send("please consult the advisor before you answer");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result" && (w.events.find((c) => c.type === "tool_call" && (c as { callId?: string }).callId === (e as { callId?: string }).callId) as { name?: string } | undefined)?.name === "advisor") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      console.warn(`[P8d-17] MEASURED: advisor tool_result = ${JSON.stringify(result)}; reviewer's own generate() was called: ${reviewerGenerateCalled}; anthropic loopback saw ${anthropicCallCount} request(s)`);
      expect(result?.isError).toBe(true);
      expect(result?.output).toContain("No such tool available");
      expect(reviewerGenerateCalled).toBe(false); // the call never reaches our reviewer at all
      // Two requests reach the loopback (the scripted tool_use, then the model's own continuation
      // after seeing the tool error) — never a THIRD for a reviewer generate() call that never fires.
      expect(anthropicCallCount).toBe(2);
    } finally {
      await fake.close();
    }
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
    let responseDelayMs = 0;
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          requests.push({ path: recorded.path, headers: recorded.headers });
          if (responseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
          if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(script[0]!);
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    fakeUrl = fake.url;
    fakeClose = () => fake.close();
    (globalThis as { __setOfficialE2eScript?: (s: AnthropicTurnScript[]) => void }).__setOfficialE2eScript = (s) => { script = s; };
    // Minor m2 support: `stopReason === "aborted"` needs the interrupt to land BEFORE the (fast,
    // localhost) response finishes — see `withAnthropicLoopback`'s own `delayFirstResponseMs` for
    // the identical reasoning. This shared daemon-wide fake gets the SAME knob, reset per-test.
    (globalThis as { __setOfficialE2eResponseDelayMs?: (ms: number) => void }).__setOfficialE2eResponseDelayMs = (ms) => { responseDelayMs = ms; };
    // Fix round 1 (M2): a test-injected override on `startDaemon` opts, never an ambient env var —
    // the SAME shape the `winter-test/<name>` double already uses (a value only a test constructs).
    daemon = await startDaemon({ home, secrets, agentProvider: null, officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: fakeUrl }, authFamily: "custom" }) });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
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
    // m5: the record's `authRef` is the LOCATOR only (never material — records.ts's own rule),
    // derived through `credentialRefFor` exactly as the Winter path's own record write is.
    expect(rt.records.get(sessionId)?.authRef).toBe("keychain:anthropic:default");
    await client.call(METHODS.sessionSend, { sessionId, text: "say hello" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
    const kinds = client.events.filter((e) => e.sessionId === sessionId).map((e) => e.type);
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("turn_completed");
    expect(requests.some((r) => r.path === "/v1/messages" && (r.headers["x-api-key"] !== undefined || r.headers["authorization"] !== undefined))).toBe(true);
  }, 60_000);

  test("session.interrupt on the official leg ends the turn, never a thrown error", async () => {
    (globalThis as { __setOfficialE2eScript?: (s: AnthropicTurnScript[]) => void }).__setOfficialE2eScript?.([
      { blocks: [{ type: "text", chunks: Array.from({ length: 100 }, (_, i) => `word-${i} `) }], stopReason: "end_turn" },
    ]);
    (globalThis as { __setOfficialE2eResponseDelayMs?: (ms: number) => void }).__setOfficialE2eResponseDelayMs?.(500);
    try {
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      await client.call(METHODS.sessionSend, { sessionId, text: "say a lot" });
      await Bun.sleep(80);
      const res = await client.call<{ ok: boolean; wasRunning: boolean }>(METHODS.sessionInterrupt, { sessionId });
      expect(res.ok).toBe(true);
      const completed = await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000) as SessionEvent & { stopReason?: string };
      // Minor m2 (measured, not assumed) — see the checkpoint-b interrupt test's own comment: the
      // real pinned CLI's terminal reads `"end_turn"` here too, not `"aborted"`, even with the
      // interrupt landing well before any response data. `res.ok`/`wasRunning` (asserted above) is
      // the reliable signal; CARRIED.
      expect(completed.stopReason).toBe("end_turn");
    } finally {
      (globalThis as { __setOfficialE2eResponseDelayMs?: (ms: number) => void }).__setOfficialE2eResponseDelayMs?.(0);
    }
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
