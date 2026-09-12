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
// M2 — NEVER an ambient env var; the deleted `WINTER_OFFICIAL_TEST_BASE_URL` hatch was one) redirects
// the real credential path to the loopback fake without touching the `api-key` family's own
// env-allowlist shape, the same "a value only a test constructs" spirit as `winter-test/<name>`.
//
// `describeWithClaudeRuntime` skips without the optional platform package and THROWS under
// `WINTER_CLAUDE_REQUIRE_RUNTIME=1` (P8c-9).
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
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
import { createWinterRuntimeSdk, type WinterRuntimeSdk } from "../../src/runtime-sdk/create";
import { credentialRefFor, ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { sessionHooksFor, type SessionHooksDeps } from "../../src/runtime-sdk/hooks";
import { attachOfficialSession } from "../../src/runtime-sdk/messaging";
import { createSqliteRuntimeDirectoryStore, openRuntimeStateDb } from "../../src/runtime-state";
import { processStartedAt } from "../../src/runtime-state/leases";
import { buildChildAddress, buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import { officialConfigDirFor, type OfficialInputDeps, type OfficialSessionInput } from "../../src/runtime-sdk/official-options";
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
  runtime: WinterRuntimeSdk;
  events: SessionEvent[];
  session: OfficialSession;
  backendSessionId: string;
  /** m1: the CHILD's own hermetic `HOME` — distinct from `home` (WINTER_HOME) above. Before this,
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
  opts: {
    reviewer?: BashReviewer; mode?: "code" | "chat"; hookFacade?: SessionHooksDeps["hookFacade"]; advisorReviewer?: ReviewerResolver; onIncarnationStart?: (abort: AbortController) => void;
    /** P9a-10: an alternate session id (default "s_official_e2e") — needed the moment a test wants
     *  a NAMED, addressable session (e.g. "row4hold-b") rather than the shared fixed id every other
     *  `buildWorld` caller uses. */
    sessionId?: string;
    /** P9a-10: wires `startOfficialSession`'s `messaging.attach` (`attachOfficialSession`) — the
     *  ORIGINAL row4/row5 tests build their own bespoke session precisely to get this; every other
     *  `buildWorld` caller runs unattached (byte-identical to before this option existed), so this
     *  defaults to `false`. */
    messagingAttach?: boolean;
  } = {},
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
  const runtime = await createWinterRuntimeSdk({
    home,
    settings: () => null,
    secrets,
    capabilities: [],
    // P9a-10 (MEASURED first without this): a `from` address the router cannot classify is refused
    // OUTRIGHT as unauthenticated, before WS-10 §13's own inbound matrix ever runs — the SAME fixed
    // "prompts" classifier the row4/row5 tests above already use. Harmless for every OTHER
    // `buildWorld` caller (none of them touch messaging).
    sessionPermissionClass: () => "prompts",
    ...(opts.advisorReviewer === undefined ? {} : { advisorReviewer: opts.advisorReviewer }),
  });
  const officialPeer = await runtime.officialPeer();
  if (officialPeer === undefined) throw new Error("unreachable: the suite is skipped without a bed");

  const trust = new TrustStore(join(home, "trust.json"));
  trust.trust(cwd);
  const skills = new SkillStore({ winterHome: home, trust });
  const assembler = new ContextAssembler({ winterHome: home, trust, skills });

  const sessionId = opts.sessionId ?? "s_official_e2e";
  const registry = new ToolRegistry();
  registry.register(probeDef);
  const capSession = { sessionId, mode, cwd, roots: [cwd] };
  const probeServer = capabilityServer({ key: "probe", defs: [probeDef] }, capSession);
  const capabilities: CapabilityServerRecord = { [probeServer.name]: probeServer };

  const events: SessionEvent[] = [];
  const checkpoints = new MemCheckpoints();
  let seq = 0;

  const backendSessionId = crypto.randomUUID();

  // m1: a hermetic HOME for the CHILD process, distinct from `home` (WINTER_HOME) above — passed
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
    ...(opts.onIncarnationStart === undefined ? {} : { onIncarnationStart: opts.onIncarnationStart }),
    ...(opts.messagingAttach ? { messaging: { attach: attachOfficialSession } } : {}),
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

/**
 * P9a-10/M5: `runtime.sdk.directory.get(<session address>)` reads the SAME row the spawn proxy's
 * record sink wrote (`processIdentity.pid` — the router's own directory-store seam, WS-14 §9 / WS-15
 * §6.4 step 2) — verbatim, no re-derivation. Polls because the record write races the spawn (the
 * router's own `Promise.race([sink.record(...), timeout])`): by the time `session.send()`'s own
 * promise resolves the row is USUALLY already there, but this is never assumed.
 */
async function officialChildPidOf(runtime: WinterRuntimeSdk, sessionId: string, timeoutMs = 10_000): Promise<number> {
  const address = serializeRuntimeAddress(buildSessionAddress(sessionId));
  const t0 = Date.now();
  for (;;) {
    const entry = await runtime.sdk.directory.get(address);
    if (entry?.processIdentity?.pid !== undefined) return entry.processIdentity.pid;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`officialChildPidOf: no processIdentity.pid recorded for ${address} within ${timeoutMs}ms (entry: ${JSON.stringify(entry)})`);
    }
    await Bun.sleep(20);
  }
}

/** `true` once the OS agrees `pid` no longer exists (ESRCH), polled up to `timeoutMs`. */
async function pollProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await Bun.sleep(25);
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

      // m1 (Phase 9c/P9c-1 update): the OBSERVED `CLAUDE_CONFIG_DIR`/spool a fresh-spool launch
      // actually used lives under WINTER_HOME (`w.home`, the router's own `winterHome`, per
      // `create.ts`'s `handoff: { winterHome: deps.home }`) — never under the child's hermetic
      // `HOME`. Since P9c-1 this leg no longer relies on the router's own default spool name
      // (`officialSpoolRoot`, `runtimes/official-agent-spool`) while `subscriptionAuth` is off (the
      // shipped default `buildWorld`'s `inputDeps` — no `settings` field — resolves to): it pins its
      // OWN `officialConfigDirFor(home)` (`runtimes/claude-config`) instead, created 0700. The real
      // `claude` CLI writing into it (a real file on disk, not merely a configured option) is the
      // actual proof `CLAUDE_CONFIG_DIR` took effect.
      const spoolRoot = officialConfigDirFor(w.home);
      expect(existsSync(spoolRoot)).toBe(true);
      expect(statSync(spoolRoot).mode & 0o777).toBe(0o700);
      // P9c-1 Step 4(b): no subscription-style credential file was ever written into this leg's
      // own config dir — an api-key session never logs in, so nothing should ever create one.
      expect(existsSync(join(spoolRoot, ".credentials.json"))).toBe(false);

      // m1: `~/.claude` is never created under the CHILD's own (hermetic) HOME — before this fix
      // the child had no HOME of its own (it silently inherited the real machine's `$HOME`), so this
      // assertion checked the wrong directory and passed for the wrong reason.
      expect(existsSync(join(w.hermetic.home, ".claude"))).toBe(false);

      // P9c-1 Step 4(a): the REAL 0.3.250 binary's own init message reports the pinned credential
      // source — MEASURED here (this world's own `explicitCredentials` names `ANTHROPIC_API_KEY`
      // explicitly, per `buildWorld`'s own header, even though its `selectionFor()` records
      // `authFamily: "custom"` for the loopback-redirect escape hatch: `AUTH_FAMILY_VARIABLES`
      // (the installed router package's own table) admits `ANTHROPIC_BASE_URL` only for
      // `console-oauth`/cloud/`custom` families, never for a real `api-key` one — so a genuine
      // `authFamily: "api-key"` session cannot be redirected to a loopback fake at all, and this is
      // the closest real-binary proof of Step 4(a) achievable without a real Anthropic key: the
      // OBSERVED credential source for a real `ANTHROPIC_API_KEY` env var, on the real binary).
      expect(w.session.init?.apiKeySource).toBe("ANTHROPIC_API_KEY");
    });
  }, 60_000);

  // Fix round 1 (item 0): router 0.0.3's `createApprovalBridge` is now wired for real
  // (`official-options.ts`) — a capability tool call reaches Winter's OWN approval flow, not the
  // router's fixed fail-closed default. Two shapes: the APPROVE path (policy "auto", which
  // `gate.evaluate`'s own "auto" column allows without a card) and the DENY path (policy
  // "dont-ask", which never prompts and denies outright — same `canUseToolFor` semantics as the
  // Winter leg, proven byte-identical in `approval-bridge.test.ts`).
  test("a capability tool call SUCCEEDS through the real approval bridge (policy auto)", async () => {
    const turns: AnthropicTurnScript[] = [
      { blocks: [{ type: "tool_use", id: "call_1", name: "mcp__winter__probe__probe", jsonChunks: [JSON.stringify({ note: "hi" })] }], stopReason: "tool_use" },
      { blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" },
    ];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto");
      await w.session.send("use the probe tool");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const call = w.events.find((e) => e.type === "tool_call") as (SessionEvent & { name?: string }) | undefined;
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      expect(call?.name).toBe("mcp__winter__probe__probe");
      expect(result?.isError).toBe(false);
      expect(result?.output).toContain("probed: hi");
    });
  }, 60_000);

  test("a capability tool call is DENIED through the real approval bridge (policy plan)", async () => {
    const turns: AnthropicTurnScript[] = [
      { blocks: [{ type: "tool_use", id: "call_1", name: "mcp__winter__probe__probe", jsonChunks: [JSON.stringify({ note: "hi" })] }], stopReason: "tool_use" },
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
      const SENTINEL = "WINTER_CONTROL_PLANE_SENTINEL_9f3d1a";
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
      { blocks: [{ type: "tool_use", id: "call_1", name: "Bash", jsonChunks: [JSON.stringify({ command: "echo hi > /tmp/winter-p8c-m4-should-not-run" })] }], stopReason: "tool_use" },
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
    // (reused verbatim on this leg) denies only `<home>/run`/`<home>/runtimes` — Winter's own
    // philosophy is unrestricted reads otherwise (CLAUDE.md: "the sole read denial is ~/.winter/run").
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
    const SENTINEL = "WINTER_8D_OUTSIDE_CWD_SENTINEL_7c2b";
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
      { blocks: [{ type: "tool_use", id: "call_1", name: "mcp__winter__probe__probe", jsonChunks: [JSON.stringify({ note: "8d-post" })] }], stopReason: "tool_use" },
      DONE_TURN,
    ];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { hookFacade });
      await w.session.send("use the probe tool");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const post = calls.find((c) => c.event === "post-tool" && c.extra.toolName === "mcp__winter__probe__probe");
      expect(post).toBeDefined();
      expect(post?.extra).toMatchObject({ toolName: "mcp__winter__probe__probe", isError: false, threadId: "main" });
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

  // ── P8d-17 (Lane 3b): the OFFICIAL leg's own `advisor` tool call — ROOT-CAUSED AND FIXED ──
  //
  // Round 2 left this UNPROVEN with the diagnosis "something beyond resolveReviewer/
  // connectionOverride must register the official leg's own standing-server tool (`advisor`) with
  // the real 0.3.250 CLI before the model can call it at all" — correct as far as it went. Lane 3b
  // found the EXACT mechanism, Winter-side, and fixed it:
  //
  // The router's own `officialCapabilityServers` (index.js, called from `openOfficialLeg` on EVERY
  // official-leg session) builds the STANDING server (`winterMcpServerDescriptor` —
  // SendMessage/ListAgents/ReadNotifications/advisor's canonical `mcp__<brand>__<tool>`
  // registrations) ONLY when `RuntimeSdkOptions.toInputShape` (a CONSTRUCTION-time field) is set.
  // `create.ts` never set it. Its own early-return is SILENT rather than a throw specifically
  // because Winter's construction-level `capabilities` list is `[]` on purpose (P8b-36 — Winter's
  // capability tools ride the PER-SESSION `officialCapabilityServersFor` door instead): `if
  // (deps.toInputShape === undefined) { if (deps.capabilities === undefined) return; throw … }`,
  // and an empty array normalizes to `undefined` one level up (`capabilityDescriptors`). So the
  // standing server was never built for ANY official-leg session, for all four aliased builtins —
  // not advisor alone. MEASURED (this test, before the fix): the official leg's tool list carried
  // bare `SendMessage`/`ListAgents` (the underlying CLI's OWN native subagent-messaging tools,
  // confirmed unrelated to Winter's canonical implementation) and NOTHING containing "advisor" or
  // "notification" anywhere — not even the alias's own redirect target — which is what a genuinely
  // unregistered tool looks like, as opposed to a denied/stripped one (ruling out (3) from the
  // brief: `additionalDisallowedTools`/deny rules never touch it; there is nothing to deny).
  //
  // THE FIX (`create.ts`, `official-capabilities.ts`): `official-capabilities.ts`'s own
  // `routerInputShape` (the JSON-Schema → zod-shape bridge Winter's PER-SESSION capability tools
  // already use) is now exported and threaded into `createRouterSdk({..., toInputShape:
  // routerInputShape})` at construction. MEASURED, AFTER: `mcp__winter__advisor`,
  // `mcp__winter__send_message`, `mcp__winter__list_agents` and `mcp__winter__read_notifications` all
  // now appear in the model-facing tool list, and a scripted bare `advisor` tool_use — via
  // `officialToolAliases`'s redirect, now pointed at a REAL registered target — reaches
  // `resolveReviewer()` and, once a credential is staged for F3's sync presence gate, the reviewer's
  // own `generate()` call, whose text comes back verbatim in the tool result. PINNED below.
  test("P8d-17 FIXED+PROVEN: toInputShape wired at construction registers the standing server; a bare 'advisor' call reaches resolveReviewer()/generate() end to end", async () => {
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
      const secretsForAdvisor = new FileSecretStore(secretsDir);
      // Lane 3b: an anthropic credential must be PRESENT for `advisorReviewerFor`'s claude-family
      // branch to resolve at all (F3's sync `credentialPresenceCache` gate) — absent, it answers
      // `undefined` and the tool reports "no reviewer model is resolvable", never reaching
      // `generate()`. This is a SEPARATE credential write from `buildWorld`'s own official-leg
      // session credential (both point at the same loopback fake either way).
      await writeCredentialMaterial(secretsForAdvisor, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-advisor-p8d17" });
      const { advisorReviewerFor, familyOfModel } = await import("../../src/runtime-sdk/advisor-reviewer");
      let reviewerGenerateCalled = false;
      const advisorReviewer = advisorReviewerFor({
        settings: () => undefined,
        secrets: secretsForAdvisor,
        familyOf: familyOfModel,
        sessionModel: () => "claude-sonnet-5",
        connectionOverride: () => ({ anthropicBaseUrl: fake.url }),
      });
      // Warm F3's background credential-presence cache (cold-start honesty: the FIRST call answers
      // `undefined` synchronously and fires the probe) BEFORE the session can ever call this
      // resolver for real — mirrors `advisor-reviewer.test.ts`'s own `waitForResolved` poll.
      {
        const t0 = Date.now();
        while (advisorReviewer() === undefined && Date.now() - t0 < 2000) await Bun.sleep(5);
      }
      const wrappedResolver = () => {
        const resolved = advisorReviewer();
        if (resolved === undefined) return undefined;
        return { ...resolved, provider: { generate: async (i: Parameters<typeof resolved.provider.generate>[0]) => { reviewerGenerateCalled = true; return resolved.provider.generate(i); } } };
      };
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { advisorReviewer: wrappedResolver });
      await w.session.send("please consult the advisor before you answer");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const result = w.events.find((e) => e.type === "tool_result" && (w.events.find((c) => c.type === "tool_call" && (c as { callId?: string }).callId === (e as { callId?: string }).callId) as { name?: string } | undefined)?.name === "advisor") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      console.warn(`[P8d-17] PROVEN: advisor tool_result = ${JSON.stringify(result)}; reviewer's own generate() was called: ${reviewerGenerateCalled}; anthropic loopback saw ${anthropicCallCount} request(s)`);

      // (2) the standing server's tool list — the brand-qualified advisor name is present now.
      const messagesReq = fake.requests.find((r) => r.path === "/v1/messages" && r.body.length > 0);
      const toolNames = (JSON.parse(messagesReq!.body) as { tools?: Array<{ name?: string }> }).tools?.map((t) => t.name) ?? [];
      expect(toolNames).toContain("mcp__winter__advisor");
      expect(toolNames).toContain("mcp__winter__send_message");
      expect(toolNames).toContain("mcp__winter__list_agents");
      expect(toolNames).toContain("mcp__winter__read_notifications");
      // The bare alias name itself is never advertised (the CLI advertises the REGISTERED/canonical
      // name; `officialToolAliases`'s redirect is what lets the model call the bare name anyway).
      expect(toolNames).not.toContain("advisor");

      // (4) the model's bare 'advisor' tool_use, through the alias, reaches a REAL registered
      // tool, which calls `resolveReviewer()` and then the reviewer's own `generate()` — whose
      // scripted text ("done") comes back verbatim in the tool result. Pinned shape:
      // `{"advice": <reviewer text>, "model": <resolved reviewer model>}`, `isError: false`.
      expect(result?.isError).toBe(false);
      expect(result?.output).toBe(JSON.stringify({ advice: "done", model: "claude-fable-5.1" }));
      expect(reviewerGenerateCalled).toBe(true);
      // Three requests reach the loopback: the main turn's scripted tool_use, the reviewer's own
      // `generate()` call (through `connectionOverride`), and the model's continuation after seeing
      // the tool result.
      expect(anthropicCallCount).toBe(3);
    } finally {
      await fake.close();
    }
  }, 60_000);

  // P8d-18 (controller ruling; Lane 3b re-measured, STILL UNPROVEN): a TEST-ONLY crash seam
  // (`onIncarnationStart` on `OfficialSessionDeps`, `official-session.ts`) was added so a test can
  // grab each incarnation's own `AbortController` and simulate the crash `run()`'s own `finally`
  // block needs to leave `state` at `"resumable"` (a deliberate `end()` is terminal for this leg —
  // see that file's header).
  //
  // Round 2's two approaches (abort-by-controller, SIGKILL-by-PID) both measured unreliable. Lane
  // 3b tried the brief's suggested "one remaining honest path" — driving a REAL upstream failure
  // through the loopback fake, never touching a PID or the AbortController's own signal semantics —
  // plus an independent, longer re-measurement of abort() with a request PROVABLY held open (two
  // tests below). BOTH land on the SAME conclusion, now measured twice from two different angles:
  //
  //   (1) abort(): re-confirmed — 25s with a request genuinely in flight, `state` never leaves
  //       "live". The router's official `Query` does not treat that signal as "the child died".
  //   (2) a malformed/truncated upstream response mid-turn: the real `claude` 0.3.250 process is
  //       ROBUST to it — one retry, then an in-band `agent_error`, turn completes, session stays
  //       "live". Not a crash at all, from any angle this lane could drive externally.
  //
  // THE SHARPENED BLOCKER: `OfficialAdapter.spawnProxy` (the router's own process-exit surface —
  // `OfficialSpawnedProcess.on("exit"|"error", …)`, exactly "the router's own crash/exit handling"
  // the brief points at) is built INTERNALLY by `createRuntimeSdk` (`createOfficialAdapter(context)`
  // called with no options, per that SDK's own doc comment) — router 0.0.3's `RuntimeSdkOptions`/
  // `RouterOfficialPolicy`/`OfficialLegDeps` expose NO field a host can supply its own spawn proxy
  // through. So there is no HOST-SIDE seam onto the actual exit event at all today; the only two
  // externally-drivable failure classes (an aborted signal, a broken upstream connection) are both
  // measured NOT to reach it. Unblocking this needs either a router 0.0.4 carry (a host-injectable
  // `spawnProxy`, mirroring the Winter leg's own `spawnClaudeCodeProcess` hook) or literally killing
  // the real OS process — which needs the process to be reliably locatable as a child in the first
  // place, and round 2 already measured that unreliable. Recorded as a carry; the
  // `onIncarnationStart` seam stays in place for whoever picks this up next.

  // Lane 3b (item B): the ONE remaining honest path per the brief — not PID-hunting, not driving
  // the AbortController (both already measured unreliable) — is to make the REAL upstream
  // connection die mid-turn (a malformed HTTP response the real `claude` process cannot parse) and
  // see whether the router's own `Query` treats THAT as "the child died", moving `state` off
  // `"live"` on its own. Diagnostic only (kept even if it lands on "still live" — either answer is
  // the measurement item B asks for).
  test("P8d-18 (lane 3b): a malformed upstream response mid-turn — does the router's own Query end/error, moving state off 'live'?", async () => {
    let requestNum = 0;
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            requestNum += 1;
            if (requestNum === 1) return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["hello"] }], stopReason: "end_turn" });
            // Second turn: headers announce an SSE stream, but the body is neither valid SSE nor
            // valid JSON, and the connection is torn down immediately after — the shape a real
            // upstream connection reset produces, not a well-formed provider error frame.
            return new Response("not-sse-not-json-garbage\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    try {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8d18-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto");
      await w.session.send("say hello");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      expect(w.session.state).toBe("live"); // sanity: the first, well-formed turn leaves it live
      await w.session.send("say something else");
      // No well-formed turn_completed/agent_error is guaranteed here — poll `state` directly for up
      // to 20s rather than waiting on an event that a genuine crash path might never emit.
      const t0 = Date.now();
      while (w.session.state === "live" && Date.now() - t0 < 20_000) await Bun.sleep(50);
      console.warn(`[P8d-18][3b] MEASURED: state after a malformed mid-turn upstream response = "${w.session.state}" (requests seen: ${requestNum}); events: ${JSON.stringify(w.events.map((e) => e.type))}`);
      // PINNED, against the real 0.3.250 binary: a malformed/truncated upstream response is fully
      // absorbed (one retry, then an in-band `agent_error`) without ending the generation — NOT the
      // crash seam either. If a future pinned version starts treating this as fatal, this assertion
      // is the tripwire that says so.
      expect(w.session.state).toBe("live");
    } finally {
      await fake.close();
    }
  }, 60_000);

  // Lane 3b (item B), second honest attempt: re-measure `.abort()` on the incarnation's OWN
  // `AbortController` (the `onIncarnationStart` seam already in place) with a request PROVABLY held
  // open at the fake (so abort has something real to interrupt) and a LONGER poll window than
  // round 2's 10s, since a real spawned process's teardown may simply be slower than that.
  test("P8d-18 (lane 3b): re-measure — abort() on the incarnation's own AbortController while a request is held open", async () => {
    const { startFake, stalledResponse } = await import("@yanlinglabs/winter-provider-conformance");
    let requestNum = 0;
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            requestNum += 1;
            if (requestNum === 1) {
              const { anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
              return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["hello"] }], stopReason: "end_turn" });
            }
            return stalledResponse(30_000); // held open well past this test's own timeout
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    try {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8d18-official-e2e-secrets2-"));
      let capturedAbort: AbortController | undefined;
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { onIncarnationStart: (a) => { capturedAbort = a; } });
      await w.session.send("say hello");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      expect(capturedAbort).toBeDefined();
      await w.session.send("this one will be held open by the fake"); // resolves fast (just pushes into the stream); the TURN never completes on its own
      // Give the fake time to actually receive the second request (so abort() has something live
      // to interrupt) before firing it.
      const t0req = Date.now();
      while (requestNum < 2 && Date.now() - t0req < 10_000) await Bun.sleep(20);
      expect(requestNum).toBeGreaterThanOrEqual(2);
      capturedAbort!.abort();
      const t0 = Date.now();
      while (w.session.state === "live" && Date.now() - t0 < 25_000) await Bun.sleep(50);
      console.warn(`[P8d-18][3b] MEASURED: state ${(Date.now() - t0)}ms after abort() = "${w.session.state}"`);
      // PINNED (re-confirms round 2, independently, with a request PROVABLY held open and a longer
      // window): abort() alone never moves the router's official Query off "live" — the router does
      // not appear to treat that signal as "the child died". See this describe block's own P8d-18
      // comment for the full blocker (no host-injectable spawn proxy exists in router 0.0.3 to drive
      // a REAL exit/disconnect event from Winter's side; a bare OS-level kill was already measured
      // unreliable — the child could not be reliably located as a direct process child).
      expect(w.session.state).toBe("live");
    } finally {
      await fake.close();
    }
  }, 60_000);

  // Lane 3b (item C, WS-17 §8 row 4): TWO official sessions sharing ONE spool (one WINTER_HOME, so
  // both are `officialSpoolRoot(home)`-identical fresh-spool launches) AND one child HOME (so a
  // PLANTED `~/.claude` is the SAME file for both) — SendMessage A->B delivered, and the planted
  // file byte-identical (content + mtime) after both ran. Enabled by item A's fix: before it, a
  // bare `SendMessage` reached the CLI's own NATIVE tool, never `mcp__winter__send_message`/the
  // messaging port, so this row could not have been proven at all.
  test("WS-17 §8 row 4: two official sessions, one spool, one child HOME — SendMessage A->B delivered; a planted ~/.claude untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "p8d-row4-home-"));
    const secrets = new FileSecretStore(join(home, "secrets"));
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-row4" });
    const credentialRef = credentialRefFor("anthropic")!;
    // Both sessions run under `policy: "auto"` (a prompting, non-bypass policy) — `"prompts"` is
    // the correct fixed class. Without SOME classifier, WS-10 §13's receiver-class-unknown rule
    // fails closed to `held` rather than guessing (measured first, before this was added).
    const runtime = await createWinterRuntimeSdk({ home, settings: () => null, secrets, capabilities: [], sessionPermissionClass: () => "prompts" });
    const officialPeer = await runtime.officialPeer();
    if (officialPeer === undefined) throw new Error("unreachable: the suite is skipped without a bed");

    const hermetic = hermeticOfficialHome("row4"); // ONE child HOME, shared by A and B
    const claudeDir = join(hermetic.home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const plantedFile = join(claudeDir, "marker.json");
    writeFileSync(plantedFile, JSON.stringify({ sentinel: "WINTER_ROW4_PLANT_9f21" }));
    const before = { content: readFileSync(plantedFile, "utf8"), mtimeMs: statSync(plantedFile).mtimeMs };

    const trust = new TrustStore(join(home, "trust.json"));
    const cwd = join(home, "work");
    mkdirSync(cwd, { recursive: true });
    trust.trust(cwd);
    const skills = new SkillStore({ winterHome: home, trust });
    const assembler = new ContextAssembler({ winterHome: home, trust, skills });
    const policy = "auto" as const;

    const eventsFor = new Map<string, SessionEvent[]>();
    let seq = 0;

    const makeSession = (sessionId: string, baseUrl: string) => {
      const events: SessionEvent[] = [];
      eventsFor.set(sessionId, events);
      const checkpoints = new MemCheckpoints();
      const sessionInput: OfficialSessionInput = { sessionId, mode: "code", cwd };
      const inputDeps: OfficialInputDeps = {
        home,
        selection: selectionFor(),
        explicitCredentials: [{ variable: "ANTHROPIC_API_KEY", ref: credentialRef }],
        explicitConnectionEnv: { ANTHROPIC_BASE_URL: baseUrl },
        claudeExecutableFor: () => ({ path: claudeRuntimeForTests()!.executable }),
        officialPeer,
        assembler,
        capabilities: {},
        canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy, emit: () => {} },
        policy,
        env: { ...process.env, HOME: hermetic.home }, // the SAME child HOME for both sessions
      };
      return startOfficialSession({
        sessionId,
        backendSessionId: crypto.randomUUID(),
        mode: "code",
        runtime,
        selection: selectionFor(),
        sessionInput: () => sessionInput,
        inputDeps: () => inputDeps,
        projector: (generation) => createProjector({
          sessionId, mode: "code", generation, runtimeKind: "claude-agent",
          nextSeq: () => ++seq, checkpoint: checkpoints, now: () => new Date().toISOString(), log: { warn: () => {} },
        }),
        append: (e) => { const stamped = { ...e, seq: (e as { seq?: number }).seq ?? ++seq } as SessionEvent; events.push(stamped); return stamped; },
        broadcast: (e) => { events.push(e as unknown as SessionEvent); },
        log: () => {},
        messaging: { attach: attachOfficialSession },
      });
    };

    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    const DONE = (text: string): AnthropicTurnScript => ({ blocks: [{ type: "text", chunks: [text] }], stopReason: "end_turn" });
    let bTurns = 0;
    // MEASURED (Lane 3b diagnosis): the delivered text never appears as a persisted `user_message`
    // event in B's own event log at all — delivery pushes a RENDERED, ATTRIBUTED envelope
    // (`<agent-message from="session:row4-a" message-id="..." sender-permission-class="prompts">
    // ...<summary>...</summary>...hello from A...</agent-message>`, `renderAttributedTurn`'s own
    // format — WS-10 §12) straight into B's prompt stream, bypassing `OfficialSession.deliver()`'s
    // `appendUser` call. So this test asserts on the REAL wire evidence (B's own second model
    // request body) rather than an event that never gets emitted — itself a finding: an official-leg
    // delivery leaves no trace in the RECEIVER's own persisted transcript (carry, out of this row's
    // scope — WS-17 §8 asks only whether delivery happens, not whether it is journaled).
    let secondRequestBody: string | undefined;
    const fakeB = await startFake({
      routes: [{
        path: "*", handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            bTurns += 1;
            if (bTurns === 2) secondRequestBody = recorded.body;
            return anthropicFake.anthropicTurnResponse(DONE(bTurns === 1 ? "hi, I'm B" : "got your message"));
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    let aTurns = 0;
    const fakeA = await startFake({
      routes: [{
        path: "*", handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            aTurns += 1;
            // `to` must be the CANONICAL serialized address (`session:<id>`) — `resolveTarget`'s own
            // algorithm (winter-agent-sdk's messaging/resolution.ts) only matches a BARE string
            // against the caller's own children by id/name or a peer's `name` field; a bare
            // top-level sibling session id with no `name` set resolves nowhere ("not_found",
            // measured first).
            if (aTurns === 1) return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_sm", name: "SendMessage", jsonChunks: [JSON.stringify({ to: "session:row4-b", message: "hello from A" })] }], stopReason: "tool_use" });
            return anthropicFake.anthropicTurnResponse(DONE("sent"));
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });

    try {
      // B first, so it is LIVE + attached (a messaging receiver) before A ever calls SendMessage.
      const sessionB = makeSession("row4-b", fakeB.url);
      await sessionB.send("hello");
      await waitFor(eventsFor.get("row4-b")!, (e) => e.type === "turn_completed", 45_000);

      const sessionA = makeSession("row4-a", fakeA.url);
      await sessionA.send("please message B for me");
      await waitFor(eventsFor.get("row4-a")!, (e) => e.type === "turn_completed", 45_000);

      const aResult = eventsFor.get("row4-a")!.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      console.warn(`[row4] MEASURED: A's SendMessage tool_result = ${JSON.stringify(aResult)}`);
      expect(aResult?.isError).not.toBe(true);
      expect(aResult?.output).toContain('"status":"queued"');

      // The delivery pushes straight into B's prompt stream as a RENDERED, ATTRIBUTED envelope
      // (MEASURED: it never becomes a persisted `user_message` event in B's own log at all — see
      // this test's own header comment) — so wait for B's SECOND real model request (its own reply
      // to it) and assert on the wire body directly, the only place the delivery is observable.
      const t0 = Date.now();
      while (secondRequestBody === undefined && Date.now() - t0 < 45_000) await Bun.sleep(20);
      expect(secondRequestBody).toBeDefined();
      // The body is still JSON-encoded text at this point, so the envelope's own quotes are
      // escaped (`\"`) inside it — match the escaped form rather than a literal `"`.
      expect(secondRequestBody).toContain("agent-message from=\\\"session:row4-a\\\"");
      expect(secondRequestBody).toContain("hello from A");
      await waitFor(eventsFor.get("row4-b")!, (e) => eventsFor.get("row4-b")!.filter((x) => x.type === "turn_completed").length >= 2, 45_000);

      // The planted `~/.claude` file: byte-identical (content AND mtime) after BOTH sessions ran —
      // proving neither the config-dir redirect nor the messaging round-trip touches it.
      const after = { content: readFileSync(plantedFile, "utf8"), mtimeMs: statSync(plantedFile).mtimeMs };
      expect(after).toEqual(before);
    } finally {
      await fakeA.close();
      await fakeB.close();
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  // Lane 3b (item C, WS-17 §8 row 5): a parent with a COMPLETED (exited) child, a NEW runtime
  // handle over the SAME durable directory db, the parent re-attached ("resumed"), then a NATIVE
  // SendMessage addressed at the exited child — measured at the router's own messaging seam
  // (`runtime.sdk.messaging.sendDetailed`, the exact call the standing server's `send_message`
  // handler makes) rather than through a second real spawned CLI, mirroring row 6's own precedent
  // of proving PERSISTENCE/ROUTING directly rather than re-proving a real spawn item A/row 4 already
  // did. `messaging.ts`'s own header states the official leg's `coldResume` only ever calls
  // `peers.winter.query(...)` — there is no official-runtime cold-resume path in router 0.0.3 at
  // all — so the a-priori expectation is the SECOND half of this row's own either/or: a typed
  // refusal, not an actual resume. This test PINS whichever the real router does, verbatim.
  test("WS-17 §8 row 5: a parent's native SendMessage to its COMPLETED official child, across a directory restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "p8d-row5-home-"));
    const secrets = new FileSecretStore(join(home, "secrets"));
    const rs1 = openRuntimeStateDb(home);
    const directory1 = createSqliteRuntimeDirectoryStore(rs1);
    const runtime1 = await createWinterRuntimeSdk({ home, settings: () => null, secrets, capabilities: [], directoryStore: directory1, sessionPermissionClass: () => "prompts" });

    const parentAddress = serializeRuntimeAddress(buildSessionAddress("row5-p"));
    const childAddress = serializeRuntimeAddress(buildChildAddress("row5-p", "row5-c"));

    // The parent, LIVE, attached — this writes the parent's own directory row.
    const parentDelivered: string[] = [];
    const parentHandle1 = attachOfficialSession(runtime1, { sessionId: "row5-p", backendSessionId: "be-row5-p", deliver: (t) => parentDelivered.push(t), mode: "code" });
    await parentHandle1.ready;

    // Manually seed a COMPLETED child row — the shape `attachOfficialSession` itself would have left
    // behind had a real child session run and then exited (row 4 + item A already prove a REAL
    // official child registers and messages correctly while live; this row is about what happens
    // to a NO-LONGER-LIVE one).
    await directory1.upsert({
      address: childAddress,
      parsed: buildChildAddress("row5-p", "row5-c"),
      runtimeKind: "claude-agent",
      objectKind: "agent",
      transport: "claude-child",
      status: "exited",
      mode: "code",
      generation: 1,
      selection: selectionFor(),
      parentAddress,
      backendSessionId: "be-row5-c",
      capabilities: { message: true, resume: false, notifyWhenIdle: false, reply: false },
      updatedAt: new Date().toISOString(),
    });

    parentHandle1.detach();
    await runtime1.dispose();

    // ── "the daemon restarts" — a NEW handle, over the SAME db file ─────────────────────────────
    const rs2 = openRuntimeStateDb(home);
    const directory2 = createSqliteRuntimeDirectoryStore(rs2);
    const runtime2 = await createWinterRuntimeSdk({ home, settings: () => null, secrets, capabilities: [], directoryStore: directory2, sessionPermissionClass: () => "prompts" });

    // The child row survived the restart (row 6's own proof, re-confirmed here for the OFFICIAL
    // side rather than a Winter one — `PersistedWinterChild`/`RuntimeChildren` is the Winter-only
    // door; this is the router's own cross-runtime directory instead).
    const rows = await directory2.load();
    const reloadedChild = rows.find((r) => r.address === childAddress);
    expect(reloadedChild).toBeDefined();
    expect(reloadedChild?.status).toBe("exited");
    expect(reloadedChild?.parentAddress).toBe(parentAddress);

    // "parent resume" — the daemon re-attaches the parent's official session under the NEW handle
    // (same session/backend ids; a real daemon would do this from `session.create`'s own resume
    // path — this test skips spawning the real CLI, per this row's own header comment).
    const parentHandle2 = attachOfficialSession(runtime2, { sessionId: "row5-p", backendSessionId: "be-row5-p", deliver: (t) => parentDelivered.push(t), mode: "code" });
    await parentHandle2.ready;

    // THE NATIVE SendMessage, addressed at the completed child — through the SAME seam the
    // standing server's real `send_message` tool handler calls.
    const outcome = await runtime2.sdk.messaging.sendDetailed({
      from: buildSessionAddress("row5-p"),
      to: childAddress,
      body: "please resume and confirm",
      originToolCallId: "call_row5_native",
    });
    console.warn(`[row5] MEASURED: native SendMessage to a completed official child = ${JSON.stringify(outcome)}`);

    // PINNED, against the real router 0.0.3: no official-runtime cold-resume path exists
    // (`messaging.ts`'s own header — `coldResume` only ever calls `peers.winter.query`), so this is
    // the row's "or the router's refusal verbatim" branch, not an actual resume.
    expect(outcome.outcome.status).not.toBe("resumed_and_delivered");
    // Pinned to the SPECIFIC refusal the router gives today (lane-3b review, Minor): a drift to any
    // other refusal shape is a behaviour change worth seeing, not a silently-still-green OR.
    expect(outcome.outcome.status).toBe("unavailable");
    expect(JSON.stringify(outcome)).toContain("is not active");

    parentHandle2.detach();
    await runtime2.dispose();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  // ── Winter Phase 9a (P9a-10) — the crash proof, MEASURED, never asserted as a wish ─────────────
  //
  // P8d-18 (this file's own earlier block) tried "SIGKILL-by-PID" and measured it unreliable — but
  // that was BEFORE the directory row's `processIdentity.pid` (M5) existed as a reliable lookup;
  // round 2's blocker was LOCATING the child, not the router's own reaction to its death. This test
  // retries the SAME idea armed with that lookup: `officialChildPidOf` reads the row the router's
  // own spawn proxy wrote (`WS-14 §9 / WS-15 §6.4 step 2`), so there is no PID-hunting left to be
  // unreliable about.
  //
  // Every assertion below is a MEASUREMENT, not a requirement this test enforces — see this file's
  // own `[9a MEASURED]` console lines for the raw values a re-run would need to reproduce. Where the
  // observed shape agrees with WS-16 §14's crash matrix ("crash mid-turn -> resumable; next send ->
  // resume"), the assertion pins it; where it does not, the assertion pins the ACTUAL shape instead
  // and the surrounding comment says so — the report to the controller names each as MATCHES-SPEC or
  // GAP.
  test("9a MEASURED: SIGKILL of the official child mid-turn (by the row's processIdentity.pid) — the record's state, the next send's incarnation, the projector's events", async () => {
    const { startFake, stalledResponse, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    let requestNum = 0;
    const FIRST_PROMPT = "say hello (9a crash proof, first incarnation)";
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            requestNum += 1;
            if (requestNum === 1) return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["hello"] }], stopReason: "end_turn" });
            // The turn we crash mid-flight: held open well past the kill this test performs.
            return stalledResponse(30_000);
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    try {
      const secretsDir = mkdtempSync(join(tmpdir(), "p9a-crash-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url, "auto", { sessionId: "p9a-crash" });
      await w.session.send(FIRST_PROMPT);
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      expect(w.session.state).toBe("live"); // sanity: matches every other test's own first-turn baseline
      const generationBeforeCrash = w.session.generation;

      await w.session.send("this turn will be crashed mid-flight");
      // Give the fake time to actually receive the SECOND request (the one that gets held) before
      // hunting for the child's pid — same discipline as the P8d-18 abort re-measurement above.
      const t0req = Date.now();
      while (requestNum < 2 && Date.now() - t0req < 10_000) await Bun.sleep(20);
      expect(requestNum).toBeGreaterThanOrEqual(2);

      const pid = await officialChildPidOf(w.runtime, w.session.sessionId);
      console.warn(`[9a MEASURED] official child pid = ${pid}, generation before crash = ${generationBeforeCrash}`);
      expect(() => process.kill(pid, 0)).not.toThrow(); // sanity: genuinely alive before the kill

      // P9a fix wave, n1: `officialChildPidOf` returns a bare pid, and a pid is recyclable — WS-14
      // §9 warns against trusting one alone for a RECOVERY decision, but says nothing against a
      // TEST killing whatever currently holds it milliseconds after reading it. Still, the row
      // carries `processIdentity.startedAt` right here for free, so cross-check it before the kill:
      // the OS's own `processStartedAt(pid)` (via `ps -o lstart=`, second-granularity) must land
      // close to the moment the router's spawn-proxy record sink observed this same child, which a
      // pid recycled from some unrelated, long-gone process would not.
      const recordedEntry = await w.runtime.sdk.directory.get(serializeRuntimeAddress(buildSessionAddress(w.session.sessionId)));
      const recordedStartedAt = recordedEntry?.processIdentity?.startedAt;
      const observedStartedAt = processStartedAt(pid);
      console.warn(`[9a MEASURED] processIdentity.startedAt recorded="${recordedStartedAt}" observed(ps)="${observedStartedAt}"`);
      expect(observedStartedAt).not.toBe("unknown");
      if (recordedStartedAt !== undefined) {
        const driftMs = Math.abs(new Date(observedStartedAt).getTime() - new Date(recordedStartedAt).getTime());
        console.warn(`[9a MEASURED] startedAt drift = ${driftMs}ms (recorded-vs-observed, same process expected well under 10s)`);
        expect(driftMs).toBeLessThan(10_000);
      }

      process.kill(pid, "SIGKILL");

      // (d) no orphan: the OS agrees the pid is gone, within a bounded window.
      const gone = await pollProcessGone(pid, 5_000);
      console.warn(`[9a MEASURED] (d) orphan check — pid gone within the drain budget = ${gone}`);
      expect(gone).toBe(true);

      // (a) the session record's state after the crash — WS-16 §14's matrix expects "resumable".
      const deadlineState = Date.now() + 15_000;
      while (w.session.state === "live" && Date.now() < deadlineState) await Bun.sleep(50);
      const stateAfterCrash = w.session.state;
      console.warn(`[9a MEASURED] (a) state after SIGKILL = "${stateAfterCrash}" (WS-16 §14 expects "resumable")`);
      expect(stateAfterCrash).toBe("resumable");

      // (b) the next send's incarnation — does it start a NEW generation (a resume), refuse, or
      // silently no-op? Measured, not assumed: `OfficialSession`'s own state machine treats
      // "resumable" as resumable-by-construction (only "ended" throws `OfficialSessionEnded`), so
      // the a-priori expectation is that this succeeds and increments `generation`.
      let sendAfterCrashError: string | undefined;
      try {
        await w.session.send("are you still there after the crash?");
      } catch (err) {
        sendAfterCrashError = err instanceof Error ? err.message : String(err);
      }
      console.warn(`[9a MEASURED] (b) session.send after the crash: ${sendAfterCrashError ? `THREW: ${sendAfterCrashError}` : "accepted"}`);
      expect(sendAfterCrashError).toBeUndefined();
      await waitFor(w.events, (e) => e.type === "turn_completed" && w.events.filter((x) => x.type === "turn_completed").length >= 2, 45_000);
      const generationAfterCrash = w.session.generation;
      console.warn(`[9a MEASURED] (b) generation before=${generationBeforeCrash} after=${generationAfterCrash}`);
      expect(generationAfterCrash).toBeGreaterThan(generationBeforeCrash);

      // (c) the model's SECOND incarnation sees the FIRST turn's user message in its transcript —
      // the real wire evidence (the fake's own recorded request bodies), never an assumption about
      // how CLAUDE_CONFIG_DIR-based resume represents history internally.
      const sawFirstPromptAgain = fake.requests.some((r) => r.path === "/v1/messages" && r.body.includes(FIRST_PROMPT));
      console.warn(`[9a MEASURED] (c) a later request's body contains the first turn's prompt = ${sawFirstPromptAgain}`);
      expect(sawFirstPromptAgain).toBe(true);
    } finally {
      await fake.close();
    }
  }, 90_000);

  // ── Winter Phase 9a (P9a-10) — WS-17 §8 row 4's three halves ────────────────────────────────────
  //
  // The ORIGINAL row 4 test above already proves one shape (A -> B while B has just completed its
  // FIRST turn — B's outcome measured "queued", and B answers it with NO explicit re-send from the
  // test: B's own SECOND `turn_completed` appears on its own, which is this row's own "idle wake"
  // half, already measured there). These two MEASURE the remaining shapes the row's header names:
  // mid-turn-and-held, and deleted.
  //
  // MEASURED FIRST (both attempts kept as the finding they are, not smoothed over): a raw
  // `runtime.sdk.messaging.sendDetailed()` call from a bare `attachOfficialSession`-only identity —
  // even with a hand-written "session" directory row seeded to match — is refused "not
  // authenticated" / resolves "not_found": the router's own `peers`/liveness check for a TOP-LEVEL
  // sibling session requires the SENDER to be a REAL, actually-running official session in this
  // process (WS-10 §13's inbound authentication, `senderKnown`), not merely an attached handle or a
  // manually-seeded row. So both tests below use the SAME proven shape the original row 4 test
  // does: TWO real spawned sessions, A's own turn issuing the NATIVE `SendMessage` tool call.
  interface Row4Pair {
    runtime: WinterRuntimeSdk;
    home: string;
    eventsFor: Map<string, SessionEvent[]>;
    makeSession: (sessionId: string, baseUrl: string) => OfficialSession;
    cleanup: () => Promise<void>;
  }

  async function buildRow4Pair(prefix: string): Promise<Row4Pair> {
    const home = mkdtempSync(join(tmpdir(), `p9a-${prefix}-home-`));
    const secrets = new FileSecretStore(join(home, "secrets"));
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: `sk-test-${prefix}` });
    const credentialRef = credentialRefFor("anthropic")!;
    const runtime = await createWinterRuntimeSdk({ home, settings: () => null, secrets, capabilities: [], sessionPermissionClass: () => "prompts" });
    const officialPeer = await runtime.officialPeer();
    if (officialPeer === undefined) throw new Error("unreachable: the suite is skipped without a bed");

    const hermetic = hermeticOfficialHome(prefix);
    const trust = new TrustStore(join(home, "trust.json"));
    const cwd = join(home, "work");
    mkdirSync(cwd, { recursive: true });
    trust.trust(cwd);
    const skills = new SkillStore({ winterHome: home, trust });
    const assembler = new ContextAssembler({ winterHome: home, trust, skills });
    const policy = "auto" as const;
    const eventsFor = new Map<string, SessionEvent[]>();
    let seq = 0;

    const makeSession = (sessionId: string, baseUrl: string): OfficialSession => {
      const events: SessionEvent[] = [];
      eventsFor.set(sessionId, events);
      const checkpoints = new MemCheckpoints();
      const sessionInput: OfficialSessionInput = { sessionId, mode: "code", cwd };
      const inputDeps: OfficialInputDeps = {
        home,
        selection: selectionFor(),
        explicitCredentials: [{ variable: "ANTHROPIC_API_KEY", ref: credentialRef }],
        explicitConnectionEnv: { ANTHROPIC_BASE_URL: baseUrl },
        claudeExecutableFor: () => ({ path: claudeRuntimeForTests()!.executable }),
        officialPeer,
        assembler,
        capabilities: {},
        canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy, emit: () => {} },
        policy,
        env: { ...process.env, HOME: hermetic.home }, // the SAME child HOME for both sessions
      };
      return startOfficialSession({
        sessionId,
        backendSessionId: crypto.randomUUID(),
        mode: "code",
        runtime,
        selection: selectionFor(),
        sessionInput: () => sessionInput,
        inputDeps: () => inputDeps,
        projector: (generation) => createProjector({
          sessionId, mode: "code", generation, runtimeKind: "claude-agent",
          nextSeq: () => ++seq, checkpoint: checkpoints, now: () => new Date().toISOString(), log: { warn: () => {} },
        }),
        append: (e) => { const stamped = { ...e, seq: (e as { seq?: number }).seq ?? ++seq } as SessionEvent; events.push(stamped); return stamped; },
        broadcast: (e) => { events.push(e as unknown as SessionEvent); },
        log: () => {},
        messaging: { attach: attachOfficialSession },
      });
    };

    return {
      runtime,
      home,
      eventsFor,
      makeSession,
      cleanup: async () => { await runtime.dispose(); rmSync(home, { recursive: true, force: true }); },
    };
  }

  test("9a MEASURED: row 4 HOLD — A's native SendMessage reaches B while B is mid-turn (held response)", async () => {
    const { startFake, stalledResponse, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    const DONE = (text: string): AnthropicTurnScript => ({ blocks: [{ type: "text", chunks: [text] }], stopReason: "end_turn" });
    let bTurns = 0;
    const fakeB = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            bTurns += 1;
            if (bTurns === 1) return anthropicFake.anthropicTurnResponse(DONE("hi, I'm B"));
            if (bTurns === 2) return stalledResponse(6_000); // B's SECOND turn — genuinely held when A sends
            return anthropicFake.anthropicTurnResponse(DONE("got your message"));
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    let aTurns = 0;
    const fakeA = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            aTurns += 1;
            if (aTurns === 1) return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_sm_hold", name: "SendMessage", jsonChunks: [JSON.stringify({ to: "session:row4hold-b", message: "hello while you are busy" })] }], stopReason: "tool_use" });
            return anthropicFake.anthropicTurnResponse(DONE("sent"));
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    const pair = await buildRow4Pair("row4hold");
    try {
      const sessionB = pair.makeSession("row4hold-b", fakeB.url);
      await sessionB.send("hello");
      await waitFor(pair.eventsFor.get("row4hold-b")!, (e) => e.type === "turn_completed", 45_000);
      await sessionB.send("say something long while I hold you open");
      const t0hold = Date.now();
      while (bTurns < 2 && Date.now() - t0hold < 10_000) await Bun.sleep(20);
      expect(bTurns).toBeGreaterThanOrEqual(2);
      expect(sessionB.state).toBe("live"); // genuinely mid-turn when A's SendMessage lands below

      const sessionA = pair.makeSession("row4hold-a", fakeA.url);
      await sessionA.send("please message B for me, right now, while it is busy");
      await waitFor(pair.eventsFor.get("row4hold-a")!, (e) => e.type === "turn_completed", 45_000);
      const aResult = pair.eventsFor.get("row4hold-a")!.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      console.warn(`[9a MEASURED] row4 HOLD: A's SendMessage tool_result while B mid-turn = ${JSON.stringify(aResult)}`);
      expect(aResult?.isError).not.toBe(true);

      // B's held response resolves on its own (6s); wait out its second turn, then send once more —
      // the row's own "next request" the held-and-released delivery should surface on.
      await waitFor(pair.eventsFor.get("row4hold-b")!, (e) => pair.eventsFor.get("row4hold-b")!.filter((x) => x.type === "turn_completed").length >= 2, 15_000);
      await sessionB.send("anything for me?");
      await waitFor(pair.eventsFor.get("row4hold-b")!, (e) => pair.eventsFor.get("row4hold-b")!.filter((x) => x.type === "turn_completed").length >= 3, 45_000);

      const sawDelivery = fakeB.requests.some((r) => r.path === "/v1/messages" && r.body.includes("hello while you are busy"));
      console.warn(`[9a MEASURED] row4 HOLD: a later request to B contains the held delivery = ${sawDelivery}`);
      expect(sawDelivery).toBe(true);
    } finally {
      await fakeA.close();
      await fakeB.close();
      await pair.cleanup();
    }
  }, 90_000);

  test("9a MEASURED: row 4 REFUSE — A's native SendMessage targets B after B's directory row is deleted", async () => {
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    const DONE = (text: string): AnthropicTurnScript => ({ blocks: [{ type: "text", chunks: [text] }], stopReason: "end_turn" });
    const fakeB = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(DONE("hi, I'm B"));
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    let aTurns = 0;
    const fakeA = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            aTurns += 1;
            if (aTurns === 1) return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_sm_refuse", name: "SendMessage", jsonChunks: [JSON.stringify({ to: "session:row4refuse-b", message: "are you still there?" })] }], stopReason: "tool_use" });
            return anthropicFake.anthropicTurnResponse(DONE("sent"));
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    const pair = await buildRow4Pair("row4refuse");
    try {
      const sessionB = pair.makeSession("row4refuse-b", fakeB.url);
      await sessionB.send("hello");
      await waitFor(pair.eventsFor.get("row4refuse-b")!, (e) => e.type === "turn_completed", 45_000);

      const address = serializeRuntimeAddress(buildSessionAddress("row4refuse-b"));
      const before = await pair.runtime.sdk.directory.get(address);
      expect(before).toBeDefined();
      await pair.runtime.sdk.directory.forget(address);
      const after = await pair.runtime.sdk.directory.get(address);
      expect(after).toBeUndefined();

      const sessionA = pair.makeSession("row4refuse-a", fakeA.url);
      await sessionA.send("please message B for me — check if it is still there");
      await waitFor(pair.eventsFor.get("row4refuse-a")!, (e) => e.type === "turn_completed", 45_000);
      const aResult = pair.eventsFor.get("row4refuse-a")!.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      console.warn(`[9a MEASURED] row4 REFUSE: A's SendMessage tool_result after B's row was deleted = ${JSON.stringify(aResult)}`);
      // The outcome union's ten arms (messaging-contract.d.ts) — a deleted row is the "no such
      // addressable object" shape, cited here as the SPECIFIC kind this router actually returns
      // (through the model-facing tool's own JSON envelope) rather than "some refusal or other".
      expect(aResult?.isError).toBe(true);
      expect(aResult?.output).toContain("not_found");
    } finally {
      await fakeA.close();
      await fakeB.close();
      await pair.cleanup();
    }
  }, 90_000);

  test("9a MEASURED: row 4 IDLE WAKE — A's native SendMessage targets B once B is genuinely resumable (not merely between turns)", async () => {
    // MEASURED (this file's own 9a crash-proof test, above): state does NOT flip to "resumable"
    // merely because a turn completed — right after a normal `turn_completed`, `state` is still
    // "live" (the underlying CLI process keeps running, listening for more input on the SAME
    // incarnation). P8d-18 (this file's own earlier block) also measured that a plain `abort()`
    // never moves `state` off "live" either. The ONLY confirmed way this router's official leg
    // reaches "resumable" without an explicit `.end()` is the SAME real-crash mechanism the 9a
    // crash-proof test uses (`officialChildPidOf` + SIGKILL) — so THAT is how this test honestly
    // constructs "B idle (resumable)", rather than assuming a natural idle-timeout this leg does
    // not appear to have.
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
    const DONE = (text: string): AnthropicTurnScript => ({ blocks: [{ type: "text", chunks: [text] }], stopReason: "end_turn" });
    let bTurns = 0;
    const fakeB = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            bTurns += 1;
            return anthropicFake.anthropicTurnResponse(DONE(bTurns === 1 ? "hi, I'm B" : "got your message"));
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    let aTurns = 0;
    const fakeA = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            aTurns += 1;
            if (aTurns === 1) return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_sm_idle", name: "SendMessage", jsonChunks: [JSON.stringify({ to: "session:row4idle-b", message: "wake up, message for you" })] }], stopReason: "tool_use" });
            return anthropicFake.anthropicTurnResponse(DONE("sent"));
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    const pair = await buildRow4Pair("row4idle");
    try {
      const sessionB = pair.makeSession("row4idle-b", fakeB.url);
      await sessionB.send("hello");
      await waitFor(pair.eventsFor.get("row4idle-b")!, (e) => e.type === "turn_completed", 45_000);
      expect(sessionB.state).toBe("live"); // confirms the measurement above, on THIS run too

      const pid = await officialChildPidOf(pair.runtime, "row4idle-b");
      process.kill(pid, "SIGKILL");
      const deadline = Date.now() + 15_000;
      while (sessionB.state === "live" && Date.now() < deadline) await Bun.sleep(50);
      console.warn(`[9a MEASURED] row4 IDLE WAKE: B's state once forced off "live" = "${sessionB.state}"`);
      expect(sessionB.state).toBe("resumable");

      const sessionA = pair.makeSession("row4idle-a", fakeA.url);
      await sessionA.send("please message B for me — it should be idle now");
      await waitFor(pair.eventsFor.get("row4idle-a")!, (e) => e.type === "turn_completed", 45_000);
      const aResult = pair.eventsFor.get("row4idle-a")!.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      console.warn(`[9a MEASURED] row4 IDLE WAKE: A's SendMessage tool_result to a resumable B = ${JSON.stringify(aResult)}`);
      // MEASURED — NOT the "queued, delivered on next turn" half of the row's either/or: a
      // genuinely "resumable" (not-live) official session is refused with the SAME shape row 5
      // already pinned for a fully-EXITED child ("unavailable" — "is not live in this process...
      // an exited official session is resumed by its backend session id through the official
      // adapter, which builds the launch this messaging lane deliberately does not", WS-15 §6.2).
      // So this router draws NO distinction between "resumable" and "exited" for inbound
      // messaging purposes — both are simply "not live", and neither has a cold-resume path in
      // router 0.0.3 (WS-15 §6.2, cited verbatim in the refusal reason). GAP against a reading of
      // WS-16 §14/WS-10 §13 that expected "resumable" to still accept a queued delivery.
      expect(aResult?.isError).toBe(true);
      expect(aResult?.output).toContain("unavailable");
      expect(aResult?.output).toContain("not live in this process");
      const bTurnsAfter = bTurns;
      await Bun.sleep(500); // belt: confirm B genuinely never received anything as a result
      expect(bTurns).toBe(bTurnsAfter);
      expect(fakeB.requests.some((r) => r.path === "/v1/messages" && r.body.includes("wake up, message for you"))).toBe(false);
    } finally {
      await fakeA.close();
      await fakeB.close();
      await pair.cleanup();
    }
  }, 90_000);
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

  const WINTER_BIN = process.env.WINTER_RUNTIME_EXECUTABLE ?? join(import.meta.dir, "../../../../dist/winter");

  const writeSettings = (): void => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/unused", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { winterExecutable: WINTER_BIN, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 10 },
    }, null, 2));
  };

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "winter-p8c14-e2e-")));
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

  test("a Claude model with NO anthropic material is a typed refusal naming winter login --anthropic-key", async () => {
    // A fresh home with the SAME winter/claude executables but no stored credential at all.
    const bareHome = realpathSync(mkdtempSync(join(tmpdir(), "winter-p8c14-bare-")));
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

  // P9c-1 Step 4(c): a FAKE, syntactically-valid subscription-shaped credential file sitting
  // nearby proves nothing here reads it — Winter's own selection (`session-driver.ts`'s
  // `decideRuntime`) decides purely off ITS OWN secrets store (`credentialPresenceFrom`), never off
  // anything under `.claude/`, so the refusal is IDENTICAL to the "NO anthropic material" test
  // above regardless of this planted file's presence. `process.env.HOME` is saved/restored around
  // the daemon's own lifetime (the same pattern `sessions.test.ts`'s own negative case uses) so the
  // planted file sits under a throwaway hermetic HOME, never the real machine's `~/.claude` — never
  // read, but also never at risk of being written to it.
  test("a planted FAKE ~/.claude/.credentials.json + NO Anthropic key material still refuses BEFORE spawn (no fallback to the subscription path)", async () => {
    const homeBefore = process.env.HOME;
    const hermetic = hermeticOfficialHome("p9c1-row-c");
    const claudeDir = join(hermetic.home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    // Syntactically valid, structurally OAuth-shaped — and explicitly FAKE (never a real token).
    writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "FAKE-not-a-real-token-9c1", refreshToken: "FAKE-not-a-real-refresh-9c1", expiresAt: 4102444800000, scopes: ["user:inference"] },
    }));
    process.env.HOME = hermetic.home;

    const bareHome = realpathSync(mkdtempSync(join(tmpdir(), "winter-p9c1-rowc-")));
    writeFileSync(join(bareHome, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/unused", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { winterExecutable: WINTER_BIN, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 10 },
    }, null, 2));
    const bareSecrets = new FileSecretStore(join(bareHome, "test-secrets")); // no anthropic material written
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
      if (homeBefore === undefined) delete process.env.HOME; else process.env.HOME = homeBefore;
      cleanupHermeticOfficialHomes();
    }
  }, 60_000);
});
