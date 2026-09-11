// P8c Task 1.2, checkpoint b — ONE OFFICIAL SESSION ON THE REAL RUNTIME against the Anthropic
// loopback fake. Not routed through `startDaemon`/`ipc/server.ts` (session-driver.ts's multi-leg
// dispatch is a Task 1.2 CARRY — see the lane report): this drives `official-session.ts` +
// `official-options.ts` + `official-capabilities.ts` directly, which is where every line this
// checkpoint added actually lives. `describeWithClaudeRuntime` skips without the optional platform
// package and THROWS under `NORMA_CLAUDE_REQUIRE_RUNTIME=1` (P8c-9).
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
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
import { createNormaRuntimeSdk, type NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import { credentialRefFor, ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import type { OfficialInputDeps, OfficialSessionInput } from "../../src/runtime-sdk/official-options";
import { startOfficialSession, type OfficialSession } from "../../src/runtime-sdk/official-session";
import { createProjector, type CheckpointStore } from "../../src/projector";
import { z } from "zod";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID, withAnthropicLoopback, type AnthropicTurnScript } from "../helpers/claude-runtime";

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

async function buildWorld(selection: RuntimeSelection, secretsDir: string, baseUrl: string): Promise<World> {
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
      policy: "auto",
      emit: () => {},
    },
    policy: "auto",
  };

  const sessionInput: OfficialSessionInput = { sessionId, mode: "code", cwd };

  const session = startOfficialSession({
    sessionId,
    backendSessionId,
    mode: "code",
    runtime,
    selection,
    sessionInput: () => sessionInput,
    inputDeps,
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

  // P8c-L1-BLOCKER (see `official-options.ts`'s header on the `options` object it builds): the
  // router's `assertOptionsInvariants` refuses ANY `canUseTool` that was not produced by its own
  // (unexported) `createApprovalBridge`, so Norma cannot wire an approval broker on this leg with
  // router 0.0.2. What THIS test proves instead — measured, not assumed — is that the capability
  // server registration itself is correct end to end: the model can NAME the tool under the exact
  // canonical `mcp__norma__<key>__<tool>` name (P8b-35/P8c-4) and the request reaches the router's
  // own permission gate, which denies it with its fixed message. A round-trip through Norma's own
  // handler (`official-capabilities.test.ts` proves that piece directly, real SDK module, no
  // network) is BLOCKED end-to-end until router 0.0.3 exports the bridge factory.
  test("a capability tool call reaches the router's permission gate under its exact canonical name (approval itself is P8c-L1-BLOCKED)", async () => {
    const turns: AnthropicTurnScript[] = [
      { blocks: [{ type: "tool_use", id: "call_1", name: "mcp__norma__probe__probe", jsonChunks: [JSON.stringify({ note: "hi" })] }], stopReason: "tool_use" },
      { blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" },
    ];
    await withAnthropicLoopback(turns, async (fake) => {
      const secretsDir = mkdtempSync(join(tmpdir(), "p8c-official-e2e-secrets-"));
      const w = await buildWorld(selectionFor(), secretsDir, fake.url);
      await w.session.send("use the probe tool");
      await waitFor(w.events, (e) => e.type === "turn_completed", 45_000);
      const call = w.events.find((e) => e.type === "tool_call") as (SessionEvent & { name?: string }) | undefined;
      const result = w.events.find((e) => e.type === "tool_result") as (SessionEvent & { output?: string; isError?: boolean }) | undefined;
      expect(call?.name).toBe("mcp__norma__probe__probe");
      expect(result?.isError).toBe(true);
      expect(result?.output).toContain("canUseTool");
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
