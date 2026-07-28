import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerAskQuestionTool } from "../../src/agent/tools/ask-question";
import { registerSearchTool } from "../../src/agent/tools/search";
import { registerPlanTool } from "../../src/agent/tools/plan";
import { registerSpawnAgentTool } from "../../src/agent/tools/spawn";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { registerWebTools } from "../../src/agent/tools/web";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine, type EngineConfig } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { AgentStore } from "../../src/agent/agents";
import { SubagentManager } from "../../src/agent/subagents";
import { BackgroundAgentRegistry } from "../../src/agent/bg-agent-registry";
import { WorktreeManager } from "../../src/agent/worktree";
import { sessionTmpDir } from "../../src/agent/session-tmp";
import type { LspManager } from "../../src/agent/lsp/manager";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { stubRegistry } from "./engine-reviewer.test"; // SP-policies Task 7: stub `bash` tool for the escalation tests' discriminating observable

export function setup(
  script: ProviderEvent[][],
  opts: {
    approvalPolicy?: "ask" | "auto" | "plan";
    withSubagents?: boolean; // default true; false → cfg.subagents/agents both omitted
    // 4h-ii-a: default true; false → cfg.bgAgents omitted while subagents/agents stay wired (lets
    // a test isolate "run_in_background requested but the registry was never wired" from the
    // unrelated "subagent bridge entirely absent" case above).
    withBgAgents?: boolean;
    subagentsOpts?: { maxConcurrent?: number; timeoutMs?: number | null; stallTimeoutMs?: number | null; acquireTimeoutMs?: number };
    provider?: Provider; // override — script ignored when set (e.g. a hanging provider for timeout tests)
    // undefined (default) → EngineConfig.provider.live absent, matching every pre-existing test
    // here (unchanged behavior: every turn uses the "fake-1" boot snapshot below).
    live?: () => { model: string; reasoningEffort?: string };
    // opts.registry lets a caller supply a registry it also registered its own tools onto
    // (e.g. registerToolSearchTool + a deferred tool) BEFORE calling setup — mirrors
    // engine-steer.test.ts's setupEngine `registry` opt. Default: a fresh registry, as before.
    // The standard tool set below is always registered onto whichever registry is used.
    registry?: ToolRegistry;
    // undefined (default) → no deferral anywhere, matching every pre-existing test here
    // (unchanged behavior). Mirrors engine-steer.test.ts's setupEngine `toolSearch` opt.
    toolSearch?: { enabled?: boolean; deferThreshold?: number; deferExternals?: "count" | "always" };
    // 4h-i Task 3: undefined (default) → EngineConfig.subagentMaxDepth absent → engine.ts defaults
    // it to 2 itself (one level deeper than the old hardcoded depth-1 cap). Pass 1 explicitly to
    // pin the OLD default behavior (a depth-1 child could never spawn further) as a regression.
    maxDepth?: number;
    // CC-parity subagent transcripts: default false (EngineConfig.tmpDirOf absent), matching every
    // pre-existing test in this file — none of them care about transcript files, and leaving this
    // off keeps them byte-identical (no real tmp-dir writes beyond what executeCall's OWN
    // unconditional sessionTmpDir call already does for other reasons). Pass true to wire the SAME
    // sessionTmpDir daemon.ts uses, for tests that specifically exercise transcript surfacing.
    withTranscripts?: boolean;
    // lsp-consolidation T3 (auto-diagnostics after edit): both undefined (default) → EngineConfig.
    // lsp/autoDiagnosticsEnabled both absent, matching every pre-existing test in this file (the
    // post-write/edit/notebook_edit hook never fires, byte-identical to before this feature).
    // `lsp` is a plain LspManager instance (real or a duck-typed test double cast to the type,
    // same "cast a minimal fake" precedent as auto-diagnostics.test.ts's own untouchableLsp) —
    // wrapped in a constant getter here since EngineConfig.lsp is a live-read function, mirroring
    // daemon.ts's own `() => lspManager ?? undefined` shape (this harness has no hot-rebuild story
    // to exercise, so a fixed instance per `setup()` call is enough). `autoDiagnosticsEnabled` is
    // instead taken AS a getter directly (not a plain boolean) so a hot-toggle test can hand in a
    // closure over a mutable flag and flip it BETWEEN two calls in the same test, exactly mirroring
    // EngineConfig's own getter shape — no extra wrapping needed at this boundary.
    lsp?: LspManager;
    autoDiagnosticsEnabled?: () => boolean | undefined;
    // whole-branch review FIX 1: optional plugin-hooks facade, threaded straight to
    // EngineConfig.hooks. Undefined (default) → every pre-existing call site in this file and
    // every file that imports this `setup()` stays byte-identical (cfg.hooks absent, no hook call
    // site in engine.ts ever fires — see EngineConfig.hooks' own doc comment). A test that wires
    // one gets a controllable pause point at a real hook call site (e.g. "turn-end", fired AFTER
    // cleanupThreadSteer but before runThread's own return — see engine.ts's fireTurnEnd call
    // sites) without needing a second, hand-rolled engine harness.
    hooks?: EngineConfig["hooks"];
  } = {},
) {
  const withSubagents = opts.withSubagents !== false;
  const home = mkdtempSync(join(tmpdir(), "norma-engine-spawn-home-"));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-spawn-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = opts.registry ?? new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerAskUserTool(registry);
  // R-T2 fix-round-1: registered so this harness matches the real daemon (daemon.ts always
  // registers both), which is what makes `registry.namesNotForMode("code")` below a REAL check
  // rather than one over an empty complement — see the exclusion-guard test's own updated comment.
  registerAskQuestionTool(registry);
  registerSearchTool(registry);
  registerPlanTool(registry);
  registerSpawnAgentTool(registry);
  const broker = new ApprovalBroker();
  const provider = opts.provider ?? new FakeProvider(script);
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-spawn-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const agentsHome = mkdtempSync(join(tmpdir(), "norma-engine-spawn-agents-"));
  const agentsTrust = new TrustStore(join(agentsHome, "trust.json"));
  const agents = withSubagents ? new AgentStore({ normaHome: agentsHome, trust: agentsTrust }) : undefined;
  // hot-settings T2 (+ no-timeout task): SubagentManager.maxConcurrent/timeoutMs/stallTimeoutMs
  // are all getters now — opts.subagentsOpts stays a plain-value shape (every existing call site
  // here passes raw numbers) and gets wrapped at this ONE boundary, mirroring daemon.ts's own
  // `() => settings?.subagents?.maxConcurrent` (and its timeoutMs/stallTimeoutMs twins, this
  // same task). Absent `subagentsOpts.timeoutMs`/`.stallTimeoutMs` → the getter resolves to
  // undefined → SubagentManager's own defaults apply (no wall clock; the 600s stall default),
  // unchanged from every pre-existing call site here that never mentioned either field.
  const subagents = withSubagents
    ? new SubagentManager({
        maxConcurrent: () => opts.subagentsOpts?.maxConcurrent,
        timeoutMs: () => opts.subagentsOpts?.timeoutMs,
        stallTimeoutMs: () => opts.subagentsOpts?.stallTimeoutMs,
        acquireTimeoutMs: opts.subagentsOpts?.acquireTimeoutMs,
      })
    : undefined;
  // 4h-ii-a: constructed by default (even when withSubagents is false — mirrors `subagents`'s own
  // optionality, cfg.bgAgents is independently optional in EngineConfig) so run_in_background
  // tests can inspect it directly without a separate setup path. `withBgAgents:false` omits it
  // from the engine config while still returning a live instance to the caller (so a test can
  // assert nothing was ever registered into it).
  const withBgAgents = opts.withBgAgents !== false;
  const bgAgents = new BackgroundAgentRegistry();
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1", live: opts.live },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    agents,
    subagents,
    bgAgents: withBgAgents ? bgAgents : undefined,
    // hot-settings T2: both are now getters — opts stays the plain-value shape every existing
    // call site here uses, wrapped at this ONE boundary (mirrors daemon.ts's own getters).
    subagentMaxDepth: () => opts.maxDepth,
    toolSearch: opts.toolSearch
      ? {
          enabled: () => opts.toolSearch?.enabled,
          deferThreshold: () => opts.toolSearch?.deferThreshold,
          deferExternals: () => opts.toolSearch?.deferExternals,
        }
      : undefined,
    tmpDirOf: opts.withTranscripts ? sessionTmpDir : undefined,
    lsp: opts.lsp ? () => opts.lsp : undefined,
    autoDiagnosticsEnabled: opts.autoDiagnosticsEnabled,
    hooks: opts.hooks,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.approvalPolicy ?? "auto" });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, hub, broker, sessionId, cwd, provider, dirs, events, registry, bgAgents, subagents };
}

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
// CC-parity SYNC result trailer (engine.ts's `syncTrailer`): every SUCCESSFUL sync spawn/resume
// tool_result now ends with this pointer — `setup()` never wires `tmpDirOf` by default, so the
// transcript clause is always omitted here (that omission is its own dedicated test elsewhere).
const trailer = (childId: string): string => `\n\nagentId: ${childId} (send_message with to: '${childId}' to continue this agent)`;
// 4g-ii (CC parity): `description` is now a REQUIRED spawn_agent arg — defaulted here so the
// ~15 pre-existing call sites below (none of which are testing the description contract itself)
// don't all need individual edits; `extra.description` still overrides it (see the "description
// rides thread_started" test below). The dedicated "without description" test constructs its
// tool_call by hand, bypassing this default, to pin the required-arg behavior itself.
// 5a: `run_in_background: false` is ALSO defaulted here (before the `...extra` spread, so
// `extra.run_in_background` still overrides it) — depth 0 now backgrounds by default (this
// harness's `setup()` always wires `bgAgents`), and none of the pre-existing call sites below are
// testing that default itself; they need the OLD synchronous-completion behavior as scaffolding
// for whatever else they're pinning. The dedicated default-matrix tests below construct their own
// tool_call by hand, omitting the key entirely, to pin the true default.
const spawnCall = (callId: string, prompt: string, extra?: { agentType?: string; model?: string; description?: string; max_turns?: number; mode?: string; isolation?: string; run_in_background?: boolean; name?: string }): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "test task", run_in_background: false, ...extra }) });

describe("AgentEngine: spawn_agent bridge (1d-iv T5)", () => {
  test("spawn_agent without description → invalid args tool_result, no thread_started/completed (schema-required, bridge path)", async () => {
    const { engine, store, sessionId } = setup([
      [{ type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "do X" }) }, done("tool_calls")],
      text("parent noticed the failure and wrapped up"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("description");
  });

  test("single spawn: fresh child input, thread_started/completed, parent tool_result === child final text", async () => {
    const { engine, store, sessionId, provider } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("child final report"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    expect(started).toMatchObject({ parentThreadId: "main", agentType: "general-purpose", prompt: "do X" });
    const childId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(childId).toMatch(/^th_/);
    expect((started as Extract<SessionEvent, { type: "thread_started" }>).description).toBe("test task");

    const completed = events.find((e) => e.type === "thread_completed" && e.threadId === childId);
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(toolResult).toMatchObject({ isError: false, output: "child final report" + trailer(childId) });

    // 3 provider calls: parent round 0 (spawn), the child's one round (index 1), then the
    // parent's own continuation round (index 2, script clamps to the last entry — also
    // "child final report" — ending the parent's turn).
    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBe(3);
    // the child's provider request input is EXACTLY [{message,user,"do X"}] — fresh, not parent history
    expect(fp.requests[1]!.input).toEqual([{ type: "message", role: "user", content: "do X" }]);
  });

  test("spawn description rides thread_started (explicit override wins over the test default)", async () => {
    const { engine, store, sessionId } = setup([
      [spawnCall("s1", "go do the thing", { description: "explore auth module" }), done("tool_calls")],
      text("child final report"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;
    expect(started.description).toBe("explore auth module");
  });

  test("two spawn_agent calls in one assistant message: both children run, two thread events, two results", async () => {
    const { engine, store, sessionId } = setup([
      [spawnCall("s1", "task A"), spawnCall("s2", "task B"), done("tool_calls")],
      text("child result"), // reused for both children (FakeProvider clamps to the last script entry)
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const starts = events.filter((e) => e.type === "thread_started");
    expect(starts.length).toBe(2);
    const childIds = new Set(starts.map((e) => (e as Extract<SessionEvent, { type: "thread_started" }>).threadId));
    expect(childIds.size).toBe(2); // distinct thread ids

    const completions = events.filter((e) => e.type === "thread_completed");
    expect(completions.length).toBe(2);

    const r1 = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const r2 = events.find((e) => e.type === "tool_result" && e.callId === "s2");
    const startedFor = (prompt: string) => (events.find((e) => e.type === "thread_started" && e.prompt === prompt) as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(r1).toMatchObject({ isError: false, output: "child result" + trailer(startedFor("task A")) });
    expect(r2).toMatchObject({ isError: false, output: "child result" + trailer(startedFor("task B")) });
  });

  test("maxDepth:1 (regression pin, today's old default): depth>0 spawn (a child trying to spawn) is denied without running the bridge", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")], // parent spawns a child
        [spawnCall("s2", "grandchild"), done("tool_calls")], // the child tries to spawn again (depth 1, at the cap)
        text("child gave up on spawning further"), // the child's final round after the denial
      ],
      { maxDepth: 1 },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // only ONE thread_started/completed pair — the grandchild attempt never ran the bridge
    expect(events.filter((e) => e.type === "thread_started").length).toBe(1);
    expect(events.filter((e) => e.type === "thread_completed").length).toBe(1);

    const denied = events.find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(denied).toMatchObject({ isError: true, output: "subagents cannot spawn further subagents" });
  });

  test("maxDepth:1 (regression pin, today's old default): child specs exclude spawn_agent, ask_user, exit_plan_mode", async () => {
    const { provider, engine, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")],
        text("done"),
      ],
      { maxDepth: 1 },
    );
    await engine.runTurn(sessionId);
    const fp = provider as FakeProvider;
    const childTools = fp.requests[1]!.tools ?? [];
    const names = childTools.map((t) => t.name);
    expect(names).not.toContain("spawn_agent");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("exit_plan_mode");
    // sanity: the child DOES see ordinary tools (e.g. read/write) — the excludeTools filter is targeted
    expect(names).toContain("write");
  });

  // B1-T3 fix round 2, Minor 2: a spawn_agent child only ever exists inside a CODE session. Spies
  // on the private `runThread` and reads the REAL `excludeTools` Set the spawn bridge built, keyed
  // off the fact that `childExcludeTools` unconditionally contains "ask_user" (the main thread's
  // own excludeTools never does) — a call-independent way to find the child's call without
  // depending on array index/ordering (same reasoning workflow-agent.test.ts's own M3 comment
  // gives). Pins `registry.namesNotForMode("code")`'s presence in `childExcludeTools` (engine.ts,
  // the spawn_agent bridge) the same way the maxDepth:1 test above pins spawn_agent/ask_user/
  // exit_plan_mode by name — nothing previously caught a future edit silently dropping that spread
  // from this specific Set.
  //
  // R-T2 fix-round-1: this harness's setup() NOW registers AskQuestion/Search (matching the real
  // daemon), so `registry.namesNotForMode("code")` here is a REAL derived value — {AskQuestion,
  // Search} — not read off the old CHAT_ONLY_TOOLS constant (now deleted). Reading it off the SAME
  // registry instance the child bridge itself consulted is a stronger check than the old hardcoded
  // import: it would also catch either tool's `modes` being edited wrong.
  test("a spawn_agent child's excludeTools includes every chat-only tool name (chat-only tools never reach a code session's spawned child)", async () => {
    const { engine, sessionId, registry } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("child final report"),
    ]);
    const runThreadSpy = spyOn(engine as unknown as { runThread: (...args: unknown[]) => unknown }, "runThread");
    try {
      await engine.runTurn(sessionId);
      const childCall = runThreadSpy.mock.calls.find(
        (c) => (c as [{ excludeTools?: Set<string> }])[0].excludeTools?.has("ask_user"),
      ) as [{ excludeTools?: Set<string> }] | undefined;
      expect(childCall).toBeDefined();
      for (const name of registry.namesNotForMode("code")) {
        expect(childCall![0].excludeTools?.has(name)).toBe(true);
      }
    } finally {
      runThreadSpy.mockRestore();
    }
  });

  test("policy inheritance: parent in plan mode → child's write tool_call is denied (block message)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")], // parent: spawn_agent allowed even under plan (orchestration)
        [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "x.txt", content: "y" }) }, done("tool_calls")],
        text("child acknowledged the block"),
      ],
      { approvalPolicy: "plan" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({ isError: false }); // spawning itself was not blocked

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: true });
    expect((writeResult as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("Blocked in plan mode");
  });

  // No-timeout task: `timeoutMs` here is the EXPLICIT wall-clock opt-in (settings.subagents
  // .timeoutMs via the constructor getter) — no wall clock exists by default anymore. The
  // opted-in clock must still work end-to-end exactly as the old default one did.
  test("explicit wall-clock opt-in: a SubagentManager configured with a tiny timeoutMs + a child that never ends → typed error tool_result", async () => {
    class HangOnSecondCall implements Provider {
      readonly id = "fake";
      private call = 0;
      models() { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        const n = this.call++;
        if (n === 0) {
          // parent round 0: spawns the child
          yield spawnCall("s1", "do X");
          yield done("tool_calls");
          return;
        }
        if (n === 1) {
          // the CHILD's only round: hangs forever — only the SubagentManager timeout ends this
          await new Promise<never>(() => {});
          return;
        }
        // n >= 2: the parent's OWN continuation round, after the child's timeout tool_result
        // comes back — lets the parent's turn actually finish instead of hanging too.
        yield { type: "text_delta", delta: "done despite child timeout" };
        yield done("end_turn");
      }
    }
    const { engine, store, sessionId } = setup([], {
      provider: new HangOnSecondCall(),
      subagentsOpts: { timeoutMs: 20 },
    });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("timed out");

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "error" });
  });

  test("cfg.subagents absent → spawn_agent returns the placeholder (no thread events)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")],
        text("ok"),
      ],
      { withSubagents: false },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: false });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("subagents are not available in this session");
  });

  test("threadsFor(sessionId) → [main, child...] with parentThreadId + status", async () => {
    const { engine, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("done"),
    ]);
    await engine.runTurn(sessionId);
    const threads = engine.threadsFor(sessionId);
    expect(threads.length).toBe(2);
    expect(threads[0]).toMatchObject({ threadId: "main" });
    expect(threads[1]).toMatchObject({ parentThreadId: "main", status: "completed", stopReason: "end_turn" });
    expect(threads[1]!.threadId).toMatch(/^th_/);
  });

  // (Seam #1 regression, updated for history-parity Task 1): the invariant this guards is that the
  // CHILD's OWN thread-tagged events (threadId != main) never leak into main's historyInput as
  // separate message items — the thread filter is unchanged. What's now DIFFERENT (intentional,
  // CC parity): the parent's OWN spawn_agent tool_result is a MAIN-thread event whose `output`
  // legitimately embeds the child's final report text (that's how the bridge always reported it —
  // see engine.ts's `outcome.output = result.value.finalText`), and main-thread tool_result events
  // ARE now replayed across turns. So "SECRET-CHILD-CHATTER" DOES now appear — but only once, as
  // that tool_result's `output`, never as a distinct `{type:"message",role:"assistant"}` item (which
  // would mean the child's OWN assistant_message, mistagged or thread-filter-bypassed, leaked in).
  test("multi-turn: a child's own thread-tagged assistant_message never leaks as a message item — its report legitimately appears only as the spawn_agent tool_result's output (Seam #1 regression)", async () => {
    const { engine, hub, sessionId, provider, store } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")], // turn 1, parent round 0: spawn
      text("SECRET-CHILD-CHATTER"), // the child's only round — its assistant_message is tagged with the CHILD's threadId, not main
      text("parent turn1 final report"), // turn 1, parent's own continuation round after the child returns
      text("parent turn2 final report"), // turn 2's only round (no spawn this time)
    ]);
    const client = { clientName: "u", deliver: () => true };
    hub.attach(client, sessionId, 0);
    await engine.runTurn(sessionId);
    hub.send(client, sessionId, "second question");
    await engine.runTurn(sessionId);

    const fp = provider as FakeProvider;
    // turn 2's only provider request is the last one recorded
    const req = fp.requests[fp.requests.length - 1]!;
    const input = req.input as { type: string; role?: string; content?: unknown; callId?: string; output?: unknown }[];

    // the child's OWN assistant_message (a different threadId) never leaks as a message item —
    // scanned as a substring across ALL message-role items (any role, not just assistant), since a
    // message item legitimately carrying this text under ANY role would mean the same leak. A
    // tool_result item legitimately containing the text (replayed by design, asserted below) is
    // untouched by this check because it's type "tool_result", not "message".
    expect(
      input.every((it) => !(it.type === "message" && typeof it.content === "string" && it.content.includes("SECRET-CHILD-CHATTER"))),
    ).toBe(true);
    // but the parent's OWN spawn_agent tool_result (a main-thread event) legitimately carries the
    // child's report as its output, and — per history-parity Task 1 — main-thread tool_result
    // events are now replayed across turns (with the CC-parity sync trailer appended)
    const started = store.read(sessionId).find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;
    expect(input.some((it) => it.type === "tool_result" && it.callId === "s1" && it.output === "SECRET-CHILD-CHATTER" + trailer(started.threadId))).toBe(true);

    // sanity: the parent's own turn-1 assistant_message and the new user message ARE present
    const asText = JSON.stringify(input);
    expect(asText).toContain("parent turn1 final report");
    expect(asText).toContain("second question");
  });

  // 4e gate fix loop 2 — Defect 1: spawn_agent model override validated against the calling
  // provider's own models() BEFORE thread_started/registerThread/subagents.run (a hallucinated
  // override must fail fast as a typed tool_result, not spawn a child that 404s).
  const TRIO_MODELS = [
    { id: "gpt-5.6-sol", family: "gpt-5", contextWindow: 100_000, supportsVision: false },
    { id: "gpt-5.6-terra", family: "gpt-5", contextWindow: 100_000, supportsVision: false },
    { id: "gpt-5.6-luna", family: "gpt-5", contextWindow: 100_000, supportsVision: false },
  ];

  test("spawn with unknown model override vs a provider whose models() = the 5.6 trio → typed error tool_result, no thread_started, child never runs", async () => {
    const script = [
      [spawnCall("s1", "do X", { model: "gpt-5-mini" }), done("tool_calls")],
      text("parent noticed the failure and wrapped up"),
    ];
    const provider = new FakeProvider(script, TRIO_MODELS);
    const { engine, store, sessionId } = setup(script, { provider });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    const output = (result as Extract<SessionEvent, { type: "tool_result" }>).output;
    expect(output).toContain("gpt-5-mini");
    expect(output).toContain("gpt-5.6-sol");
    expect(output).toContain("gpt-5.6-terra");
    expect(output).toContain("gpt-5.6-luna");

    // No child dispatch at all — only the parent's own two rounds (spawn, then continuation
    // after the typed-error tool_result) hit the provider.
    expect(provider.requests.length).toBe(2);
  });

  test("spawn with a valid model override (in the provider's models()) passes through to the child's TurnRequest.model", async () => {
    const script = [
      [spawnCall("s1", "do X", { model: "gpt-5.6-terra" }), done("tool_calls")],
      text("child final report"),
      text("parent wrap-up"),
    ];
    const provider = new FakeProvider(script, TRIO_MODELS);
    const { engine, store, sessionId } = setup(script, { provider });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(true);
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(toolResult).toMatchObject({ isError: false, output: "child final report" + trailer(childId) });

    expect(provider.requests[1]!.model).toBe("gpt-5.6-terra");
  });

  // 4h-ii-b Task 6 (CC parity: short model aliases) — "sol"/"terra"/"luna" resolve to the unique
  // known id ending "-<alias>" BEFORE the unknown-model check, so a spawn override of just "sol"
  // reaches the child as the FULL id, exactly as if the caller had spelled it out.
  test("spawn model override as a short alias ('sol') resolves to the full known id", async () => {
    const script = [
      [spawnCall("s1", "do X", { model: "sol" }), done("tool_calls")],
      text("child final report"),
      text("parent wrap-up"),
    ];
    const provider = new FakeProvider(script, TRIO_MODELS);
    const { engine, store, sessionId } = setup(script, { provider });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(true);
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(toolResult).toMatchObject({ isError: false, output: "child final report" + trailer(childId) });

    // the CHILD's own TurnRequest carries the RESOLVED full id, not the bare alias
    expect(provider.requests[1]!.model).toBe("gpt-5.6-sol");
  });

  // Ambiguity safety: an alias with no unique match falls straight into the EXISTING unknown-model
  // error path, unchanged — never a silent pass-through, never a crash.
  test("an ambiguous/unresolvable alias falls through to the existing unknown-model error", async () => {
    const ambiguousModels = [
      { id: "vendor-a-sol", family: "gpt-5", contextWindow: 100_000, supportsVision: false },
      { id: "vendor-b-sol", family: "gpt-5", contextWindow: 100_000, supportsVision: false },
    ];
    const script = [
      [spawnCall("s1", "do X", { model: "sol" }), done("tool_calls")],
      text("parent noticed the failure and wrapped up"),
    ];
    const provider = new FakeProvider(script, ambiguousModels);
    const { engine, store, sessionId } = setup(script, { provider });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    const output = (result as Extract<SessionEvent, { type: "tool_result" }>).output;
    expect(output).toContain("unknown model 'sol'");
    expect(output).toContain("vendor-a-sol");
    expect(output).toContain("vendor-b-sol");
  });

  test("provider with EMPTY models() → an arbitrary spawn model override passes through unchecked", async () => {
    const script = [
      [spawnCall("s1", "do X", { model: "totally-made-up-model" }), done("tool_calls")],
      text("child final report"),
      text("parent wrap-up"),
    ];
    const provider = new FakeProvider(script, []); // e.g. openai-compatible with no static `models` configured
    const { engine, store, sessionId } = setup(script, { provider });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(true);
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(toolResult).toMatchObject({ isError: false, output: "child final report" + trailer(childId) });

    expect(provider.requests[1]!.model).toBe("totally-made-up-model");
  });

  // 4e gate fix loop 2 — Defect 2: a child whose OWN final round hits a provider error must
  // surface to the parent as an isError tool_result (not the silent "finished without a final
  // message" success), and thread_completed must still carry stopReason "error".
  test("child provider stream error → parent tool_result isError:true with the error message, thread_completed stopReason error", async () => {
    class ErrorOnChildCall implements Provider {
      readonly id = "fake";
      private call = 0;
      models() { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        const n = this.call++;
        if (n === 0) {
          // parent round 0: spawns the child
          yield spawnCall("s1", "do X");
          yield done("tool_calls");
          return;
        }
        if (n === 1) {
          // the child's only round: the provider itself errors (e.g. a 404 on an unknown model)
          yield { type: "error", code: "server", message: "upstream 404: model not found" };
          return;
        }
        // n >= 2: the parent's own continuation round, after the child's isError tool_result
        // comes back — lets the parent's turn actually finish.
        yield { type: "text_delta", delta: "parent wrapped up despite the child's failure" };
        yield done("end_turn");
      }
    }
    const { engine, store, sessionId } = setup([], { provider: new ErrorOnChildCall() });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "error" });

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("upstream 404: model not found");
  });

  test("child-thread deltas carry the child threadId, not main", async () => {
    const { engine, sessionId, events } = setup([
      [spawnCall("c1", "do a thing"), done("tool_calls")],
      text("child-out"),
      text("parent-final"),
    ]);
    await engine.runTurn(sessionId);
    const childDelta = events.find((e) => e.type === "assistant_delta" && e.threadId !== "main");
    expect(childDelta).toMatchObject({ delta: "child-out" });
    const mainDeltas = events.filter((e) => e.type === "assistant_delta" && e.threadId === "main");
    expect(mainDeltas.map((d) => (d as { delta: string }).delta)).toEqual(["parent-final"]);
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4g whole-branch final-review fix: a spawned child's own ToolSearch load must land in
// THAT child's own `loaded` set (the one its specs()/deferred-guard actually consult), not the
// session-scoped map only the main thread reads. Before the fix, a subagent's ToolSearch-load-
// then-call of a deferred built-in looped (load → guard still rejects → load → ...) to the
// MAX_TOOL_ITERATIONS cap, surfacing to the parent as "subagent … failed: tool-iteration cap
// reached". `web_fetch` (a real deferred:true built-in, `deps.fetchFn` stubbed so no live
// network is hit) stands in for "e.g. web_fetch" from the finding — the same class of bug would
// hit any deferred built-in or mcp__ tool a child tries to ToolSearch-load.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: subagent ToolSearch-load-then-call (4g final-review fix)", () => {
  function buildWebDeferredRegistry(): { registry: ToolRegistry; fetchCalls: string[] } {
    const registry = new ToolRegistry();
    registerToolSearchTool(registry);
    const fetchCalls: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetchCalls.push(String(url));
      return new Response("<html><body><h1>Hi from the fake page</h1></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    registerWebTools(registry, { fetchFn: fakeFetch });
    return { registry, fetchCalls };
  }

  test("a spawned child can ToolSearch-load a deferred built-in and call it in the SAME child turn — no iteration-cap failure", async () => {
    const { registry, fetchCalls } = buildWebDeferredRegistry();
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "fetch the page"), done("tool_calls")], // parent round 0: spawn
      [{ type: "tool_call", callId: "ts1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:web_fetch" }) }, done("tool_calls")], // child round 0: load
      [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: "https://example.com/page" }) }, done("tool_calls")], // child round 1: call it
      text("child fetched the page"), // child round 2: end turn
      text("parent wrap-up"), // parent's continuation round, after the child's tool_result
    ];
    const { engine, store, sessionId } = setup(script, { registry, toolSearch: {} });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // The deferred tool actually ran — proof the child's OWN follow-up call was accepted, not
    // rejected-then-looped-to-the-cap (the pre-fix bug: the load landed in the session map, which
    // the child's own guard never consults).
    expect(fetchCalls).toEqual(["https://example.com/page"]);
    const callResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(callResult).toMatchObject({ isError: false });
    expect((callResult as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("Fetched https://example.com/page");

    // The child's own thread ended normally (not the iteration-cap typed error).
    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    // The parent sees the child's real final text, not a "subagent … failed: tool-iteration cap
    // reached" typed error.
    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const spawnChildId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(spawnResult).toMatchObject({ isError: false, output: "child fetched the page" + trailer(spawnChildId) });

    // The parent's own turn completed normally.
    const mainTurnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(mainTurnCompleted).toMatchObject({ stopReason: "end_turn" });
  });

  test("a child's ToolSearch load does not leak into the session/main-thread loaded set: the SAME tool called unloaded from main is still rejected", async () => {
    const { registry, fetchCalls } = buildWebDeferredRegistry();
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "fetch the page"), done("tool_calls")], // parent round 0: spawn
      [{ type: "tool_call", callId: "ts1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:web_fetch" }) }, done("tool_calls")], // child round 0: load
      [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: "https://example.com/page" }) }, done("tool_calls")], // child round 1: call it
      text("child fetched the page"), // child round 2: end turn
      // parent's continuation round: calls the SAME tool directly, unloaded on the main thread —
      // must still be rejected if the child's earlier load didn't leak into the session set.
      [{ type: "tool_call", callId: "p1", name: "web_fetch", argsJson: JSON.stringify({ url: "https://example.com/other" }) }, done("tool_calls")],
      text("parent wrap-up"),
    ];
    const { engine, store, sessionId } = setup(script, { registry, toolSearch: {} });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const parentCallResult = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(parentCallResult).toMatchObject({ isError: true });
    expect((parentCallResult as Extract<SessionEvent, { type: "tool_result" }>).output)
      .toContain("deferred — load its schema via ToolSearch first");
    // Only the CHILD's call actually reached the network stub — the parent's unloaded attempt
    // was rejected before executeCall ever ran.
    expect(fetchCalls).toEqual(["https://example.com/page"]);
  });

  test("main-thread ToolSearch load path is unchanged: a plain (non-subagent) load-then-call still works", async () => {
    const { registry, fetchCalls } = buildWebDeferredRegistry();
    const script: ProviderEvent[][] = [
      [{ type: "tool_call", callId: "ts1", name: "ToolSearch", argsJson: JSON.stringify({ query: "select:web_fetch" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: "https://example.com/page" }) }, done("tool_calls")],
      text("fetched it"),
    ];
    const { engine, store, sessionId } = setup(script, { registry, toolSearch: {}, withSubagents: false });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(fetchCalls).toEqual(["https://example.com/page"]);
    const callResult = events.find((e) => e.type === "tool_result" && e.callId === "c1");
    expect(callResult).toMatchObject({ isError: false });
    const turnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(turnCompleted).toMatchObject({ stopReason: "end_turn" });
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4h-i: spawn_agent's `max_turns` — a per-child cap on the tool-iteration loop (CC parity
// with Agent.max_turns). Only the spawn bridge ever passes this; main-thread turns are unaffected.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: spawn_agent max_turns (4h-i)", () => {
  const loopingToolCall = (callId: string): ProviderEvent =>
    ({ type: "tool_call", callId, name: "glob", argsJson: '{"pattern":"*"}' });

  test("max_turns: 2 caps the child at exactly 2 iterations — parent sees the cap message as an isError tool_result", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "loop forever", { max_turns: 2 }), done("tool_calls")], // parent round 0: spawn
      [loopingToolCall("loop0"), done("tool_calls")], // child iteration 0
      [loopingToolCall("loop1"), done("tool_calls")], // child iteration 1 — bound reached, cap fires
      text("parent wrap-up"), // parent's continuation round, after the child's isError tool_result
    ];
    const { engine, store, sessionId, provider } = setup(script);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    const childId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;

    const childCapError = events.find((e) => e.type === "agent_error" && e.threadId === childId);
    expect(childCapError).toMatchObject({ message: "tool-iteration cap (2) reached" });

    const completed = events.find((e) => e.type === "thread_completed" && e.threadId === childId);
    expect(completed).toMatchObject({ stopReason: "error" });

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({
      isError: true,
      output: "subagent (general-purpose) failed: tool-iteration cap (2) reached",
    });

    // The parent's own turn still completes normally — an isError tool_result doesn't itself end
    // the turn (only a human denial does); the parent just sees it and continues.
    const mainTurnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(mainTurnCompleted).toMatchObject({ stopReason: "end_turn" });

    // 4 provider calls: parent round 0 (spawn), the child's 2 capped iterations, then the
    // parent's own continuation round.
    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBe(4);
  });

  test("no max_turns → child still uses the default cap (24), unchanged from before this feature", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "loop forever"), done("tool_calls")], // parent round 0: spawn, no max_turns
      ...Array.from({ length: 24 }, (_, i): ProviderEvent[] => [loopingToolCall(`loop${i}`), done("tool_calls")]),
      text("parent wrap-up"), // parent's continuation round, after the child's isError tool_result
    ];
    const { engine, store, sessionId, provider } = setup(script);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    const childId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;

    const childCapError = events.find((e) => e.type === "agent_error" && e.threadId === childId);
    expect(childCapError).toMatchObject({ message: "tool-iteration cap (24) reached" });

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({
      isError: true,
      output: "subagent (general-purpose) failed: tool-iteration cap (24) reached",
    });

    // 26 provider calls: parent round 0 (spawn), the child's 24 capped iterations, then the
    // parent's own continuation round.
    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBe(26);
  });

  test("max_turns: 1 — the tight boundary caps after exactly 1 iteration", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "loop forever", { max_turns: 1 }), done("tool_calls")], // parent round 0: spawn
      [loopingToolCall("loop0"), done("tool_calls")], // child iteration 0 — bound reached, cap fires
      text("parent wrap-up"), // parent's continuation round
    ];
    const { engine, store, sessionId, provider } = setup(script);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    const childId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    const childCapError = events.find((e) => e.type === "agent_error" && e.threadId === childId);
    expect(childCapError).toMatchObject({ message: "tool-iteration cap (1) reached" });

    // 3 provider calls: parent round 0 (spawn), the child's single capped iteration, then the
    // parent's own continuation round.
    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBe(3);
  });

  // The bridge hand-parses raw argsJson BEFORE spawn.ts's own zod validation would ever run (a
  // provider could send an out-of-schema value even though the declared arg is
  // `.int().positive().max(50)`) — the guard must IGNORE an invalid value, not pass it through
  // as-is. A bug here (e.g. clamping a negative number up to 1 instead of ignoring it, or worse,
  // leaving it negative/zero) would make the loop bound `iteration < 0` — the child would hit the
  // cap message WITHOUT ever calling the provider. This pins that it's ignored (falls back to the
  // default 24), not misapplied.
  test("invalid max_turns (non-positive) is ignored — not passed through as a 0/negative bound", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X", { max_turns: -5 }), done("tool_calls")], // parent round 0: spawn, invalid max_turns
      text("child final report"), // child round 0: completes normally — proves the bound wasn't clamped to <= 0
      text("parent wrap-up"), // parent's continuation round
    ];
    const { engine, store, sessionId } = setup(script);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(spawnResult).toMatchObject({ isError: false, output: "child final report" + trailer(childId) });
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4h-i Task 2: spawn_agent's `mode` — a RESTRICT-ONLY child permission-mode override (CC
// parity with Agent's permission-mode arg). A child may run NARROWER than its parent, NEVER
// wider — see restrictPolicy/mapSpawnMode's own unit tests (spawn-mode-policy.test.ts) for the
// pure min-permissiveness logic itself. These engine tests pin the end-to-end wiring: the bridge
// actually applies the narrowed policy to the CHILD's own runThread, and never mutates the
// parent's shared `meta` object.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: spawn_agent mode (restrict-only, 4h-i Task 2)", () => {
  test("mode: 'plan' narrows a parent-'auto' child to plan policy — the child's write tool_call is gate-denied (Blocked in plan mode)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X", { mode: "plan" }), done("tool_calls")], // parent policy "auto"; mode narrows the child to "plan"
        [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "x.txt", content: "y" }) }, done("tool_calls")],
        text("child acknowledged the block"),
      ],
      { approvalPolicy: "auto" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({ isError: false }); // spawning itself is never blocked (read-only/orchestration)

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: true });
    expect((writeResult as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("Blocked in plan mode");

    // sanity: the PARENT's own session policy is untouched by the child's narrowed mode
    expect(store.meta(sessionId).approvalPolicy).toBe("auto");
  });

  test("mode: 'bypassPermissions' from a parent-'ask' session is an ESCALATION — denied; the child's bash still requires human approval, is not auto-allowed", async () => {
    // SP-policies Task 7: the child's observable MUST discriminate "ask" from the would-be-escalated
    // "bypass". An in-root WRITE no longer works — the in-project-silent flip makes it silent under
    // BOTH ask and bypass, so its card-presence proves nothing. A BASH call DOES discriminate: with
    // no permissionRules it CARDS under `ask` (MUTATING, and readOnlyBash never even runs without a
    // rules store) but is auto-allowed SILENTLY under bypass/auto. So an approval_requested for the
    // child's bash proves the child stayed at the parent's "ask" (escalation rejected); had bypass
    // taken effect, the bash would have auto-run with NO card at all.
    const { registry } = stubRegistry();
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X", { mode: "bypassPermissions" }), done("tool_calls")], // parent policy "ask"
      [{ type: "tool_call", callId: "w1", name: "bash", argsJson: JSON.stringify({ command: "git push" }) }, done("tool_calls")],
      text("child acknowledged the denial"),
      text("parent wrap-up"),
    ];
    const { engine, store, sessionId, hub, broker } = setup(script, { approvalPolicy: "ask", registry });
    const watcher = {
      clientName: "auto-denier",
      deliver: (e: SessionEvent) => { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(spawnResult).toMatchObject({ isError: false }); // spawn_agent itself is read-only, always allowed

    // The child's bash call REQUIRED approval — proof the "bypassPermissions" (→ Norma "bypass")
    // escalation was denied and the child stayed at the parent's "ask" policy. If the escalation
    // had gone through, this would have been a silent auto-allow with NO approval_requested at all.
    const approvalReq = events.find((e) => e.type === "approval_requested" && e.callId === "w1");
    expect(approvalReq).toBeDefined();
    expect(events.find((e) => e.type === "approval_resolved" && e.callId === "w1")).toMatchObject({ approved: false, by: "auto-denier" });

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: true });

    // sanity: the PARENT's own session policy is untouched by the denied escalation attempt
    expect(store.meta(sessionId).approvalPolicy).toBe("ask");
  });

  test("no mode → child inherits the parent's policy exactly, and the spawn NEVER mutates the shared parent meta (a same-turn parent bash still follows the original 'ask' policy)", async () => {
    // SP-policies Task 7: the parent's post-spawn observable must discriminate "ask" from a corrupted
    // (widened) meta. A BASH call cards under `ask` but is silent under auto — so an approval_requested
    // for the parent's p1 proves the shared meta was NOT widened by the spawn. (An in-root write is
    // silent under both now — the in-project-silent flip — so it could no longer prove this.)
    const { registry } = stubRegistry();
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X"), done("tool_calls")], // parent round 0: spawn, no mode at all
      text("child final report"), // the child's only round
      // the parent's OWN continuation round makes its OWN bash call — must still be gated under
      // the session's ORIGINAL "ask" policy; if the spawn bridge had mutated the shared `meta`
      // object (e.g. widened it while building childMeta), this call would see the corruption (run silently).
      [{ type: "tool_call", callId: "p1", name: "bash", argsJson: JSON.stringify({ command: "git push" }) }, done("tool_calls")],
      text("parent wrap-up"),
    ];
    const { engine, store, sessionId, hub, broker } = setup(script, { approvalPolicy: "ask", registry });
    const watcher = {
      clientName: "auto-approver",
      deliver: (e: SessionEvent) => { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(spawnResult).toMatchObject({ isError: false, output: "child final report" + trailer(childId) });

    // the parent's post-spawn bash still went through the normal "ask" approval flow
    const approvalReq = events.find((e) => e.type === "approval_requested" && e.callId === "p1");
    expect(approvalReq).toBeDefined();
    const p1Result = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(p1Result).toMatchObject({ isError: false }); // approved

    // the session's persisted policy is untouched (only enter/exit_plan_mode ever calls setPolicy)
    expect(store.meta(sessionId).approvalPolicy).toBe("ask");
  });

  test("mode: 'default' behaves exactly like an absent mode — no override, child inherits the parent's 'auto' policy (a child write is NOT blocked)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X", { mode: "default" }), done("tool_calls")],
        [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "x.txt", content: "y" }) }, done("tool_calls")],
        text("child wrote the file"),
      ],
      { approvalPolicy: "auto" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: false });
  });

  // T2 security review: the invariant above ("no mode → the spawn NEVER mutates the shared parent
  // meta") is pinned for the single-spawn case, but nothing yet proved it for the two CRITICAL
  // scenarios a copy-vs-mutate regression would actually break: (a) TWO concurrent spawns in one
  // assistant message, one narrowing + one not — a regression that did
  // `meta.approvalPolicy = childPolicy; childMeta = meta` (mutating the shared object instead of
  // copying) would make the FIRST (narrowing) spawn's mutation visible to the SECOND spawn's read
  // of `meta.approvalPolicy`, since the bridge's per-call setup runs synchronously up to its first
  // `await` (Promise.all(calls.map(...)) invokes each callback in order; the narrowing spawn's
  // sync prefix — including the mutation, under the regression — completes before the next spawn's
  // callback starts); (b) after a narrowing spawn returns, the PARENT's own same-turn continuation
  // tool call must still see the ORIGINAL policy, not the mutated one. Both pass on the current
  // (copy-on-narrow) code and both would fail under the regression — see the doc comment on
  // `childMeta` at engine.ts ~643.
  test("concurrent spawns, one narrowing + one not: the un-narrowed sibling's write still runs at the parent's ORIGINAL 'auto' policy (narrowing spawn A does not leak into spawn B via shared meta)", async () => {
    // A custom provider (not the shared script-array harness) because the two children must
    // behave DIFFERENTLY (child A's write is plan-denied, child B's write is auto-allowed) while
    // running CONCURRENTLY via Promise.all inside the engine's spawn bridge — dispatch here is
    // keyed off each request's OWN input content (each child's fresh thread input is exactly
    // `[{message,user,<prompt>}]` — see the spawn bridge's `input: [{type:"message",...}]`), not
    // provider-call order, so the test is robust regardless of which child's synchronous setup the
    // engine happens to run first.
    class ConcurrentModeProvider implements Provider {
      readonly id = "fake";
      readonly requests: TurnRequest[] = [];
      private parentRound = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        this.requests.push(req);
        const first = req.input[0] as { type?: string; content?: unknown } | undefined;
        const isChildA = first?.type === "message" && first.content === "task A";
        const isChildB = first?.type === "message" && first.content === "task B";
        if (isChildA || isChildB) {
          const callId = isChildA ? "wA" : "wB";
          const path = isChildA ? "a.txt" : "b.txt";
          if (req.input.length === 1) {
            // this child's first round: attempt a write
            yield { type: "tool_call", callId, name: "write", argsJson: JSON.stringify({ path, content: "y" }) };
            yield done("tool_calls");
          } else {
            // this child's second round, after the write's tool_result comes back: wrap up
            yield { type: "text_delta", delta: `${isChildA ? "child A" : "child B"} wrap-up` };
            yield done("end_turn");
          }
          return;
        }
        // the PARENT thread's own rounds — its own input never has input[0].content === "task A"/
        // "task B" (its history holds the spawn_agent function_calls, not the children's fresh
        // per-thread user messages), so it always falls through to here.
        const n = this.parentRound++;
        if (n === 0) {
          yield spawnCall("s1", "task A", { mode: "plan" }); // narrowing
          yield spawnCall("s2", "task B"); // no mode
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent wrap-up" };
        yield done("end_turn");
      }
    }
    const { engine, store, sessionId } = setup([], { provider: new ConcurrentModeProvider(), approvalPolicy: "auto" });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // both children ran to completion
    expect(events.filter((e) => e.type === "thread_started").length).toBe(2);
    expect(events.filter((e) => e.type === "thread_completed").length).toBe(2);

    // child A (mode: "plan") — its write was plan-denied
    const wA = events.find((e) => e.type === "tool_result" && e.callId === "wA");
    expect(wA).toMatchObject({ isError: true });
    expect((wA as Extract<SessionEvent, { type: "tool_result" }>).output).toContain("Blocked in plan mode");

    // child B (no mode) — its write was NOT plan-denied; it ran under the parent's original "auto"
    // policy, proving A's narrowing never leaked into B via the shared `meta` object
    const wB = events.find((e) => e.type === "tool_result" && e.callId === "wB");
    expect(wB).toMatchObject({ isError: false });

    // sanity: the parent's own session policy is untouched
    expect(store.meta(sessionId).approvalPolicy).toBe("auto");
  });

  test("after a narrowing (mode: 'plan') spawn returns, the PARENT's own same-turn write is still gated at the parent's ORIGINAL 'auto' policy, not the child's narrowed 'plan'", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X", { mode: "plan" }), done("tool_calls")], // parent round 0: spawn, narrowing mode
      text("child final report"), // the child's only round, running under the narrowed "plan" policy
      // the parent's OWN continuation round makes its OWN write call — must still be gated under
      // the session's ORIGINAL "auto" policy, NOT the child's narrowed "plan". If the spawn bridge
      // had mutated the shared `meta` object in place (regression: `meta.approvalPolicy =
      // childPolicy; childMeta = meta`) instead of copying, this call would see "plan" and be
      // denied ("Blocked in plan mode") even though the PARENT itself was never narrowed.
      [{ type: "tool_call", callId: "p1", name: "write", argsJson: JSON.stringify({ path: "after.txt", content: "z" }) }, done("tool_calls")],
      text("parent wrap-up"),
    ];
    const { engine, store, sessionId } = setup(script, { approvalPolicy: "auto" });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(spawnResult).toMatchObject({ isError: false, output: "child final report" + trailer(childId) });

    // the parent's post-spawn write was NOT plan-denied — proof the narrowing spawn didn't corrupt
    // the parent's own `meta.approvalPolicy` for the rest of the turn
    const p1Result = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(p1Result).toMatchObject({ isError: false });

    const mainTurnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(mainTurnCompleted).toMatchObject({ stopReason: "end_turn" });

    // the session's persisted policy is untouched (only enter/exit_plan_mode ever calls setPolicy)
    expect(store.meta(sessionId).approvalPolicy).toBe("auto");
  });
});

describe("AgentEngine: configurable subagent nesting depth (4h-i Task 3)", () => {
  test("default maxDepth (2, no explicit setting): a depth-1 child's specs DO include spawn_agent — nesting one level deeper than the old hardcoded cap", async () => {
    const { provider, engine, sessionId } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("done"),
    ]);
    await engine.runTurn(sessionId);
    const fp = provider as FakeProvider;
    const childTools = fp.requests[1]!.tools ?? [];
    const names = childTools.map((t) => t.name);
    expect(names).toContain("spawn_agent");
    // the depth-agnostic exclusions still apply regardless of maxDepth
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("exit_plan_mode");
    expect(names).not.toContain("enter_plan_mode");
  });

  test("maxDepth: 2 (explicit): a depth-1 child spawns a depth-2 grandchild end-to-end — thread_started/completed nest correctly, results bubble up two levels, grandchild's specs exclude spawn_agent (at the cap)", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X"), done("tool_calls")], // parent (depth 0) round 0: spawns the child
      [spawnCall("s2", "grandchild task"), done("tool_calls")], // child (depth 1) round 0: spawns the grandchild
      text("grandchild final report"), // grandchild (depth 2) round 0: no further spawn — ends its turn
      text("child wrapped up after grandchild"), // child's own continuation round, after the grandchild bridge returns
      text("parent final report"), // parent's own continuation round, after the child bridge returns
    ];
    const { engine, store, sessionId, provider } = setup(script, { maxDepth: 2 });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const starts = events.filter((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>[];
    expect(starts.length).toBe(2); // child + grandchild

    const childStart = starts.find((e) => e.parentThreadId === "main")!;
    expect(childStart).toBeDefined();
    const grandchildStart = starts.find((e) => e.parentThreadId === childStart.threadId)!;
    expect(grandchildStart).toBeDefined(); // proves the grandchild nests UNDER the child, not under main

    const completions = events.filter((e) => e.type === "thread_completed");
    expect(completions.length).toBe(2);
    expect(completions.every((e) => (e as Extract<SessionEvent, { type: "thread_completed" }>).stopReason === "end_turn")).toBe(true);

    // the grandchild's own result bubbles up as the CHILD's tool_result for s2
    const s2Result = events.find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(s2Result).toMatchObject({ isError: false, output: "grandchild final report" + trailer(grandchildStart.threadId) });
    // and the child's own final text (after the grandchild returns) bubbles up as the PARENT's
    // tool_result for s1 — proves the child kept running its OWN loop after the nested spawn
    const s1Result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(s1Result).toMatchObject({ isError: false, output: "child wrapped up after grandchild" + trailer(childStart.threadId) });

    const fp = provider as FakeProvider;
    // request[1] = child's round 0 (depth 1) — spawn_agent still visible, one level of room left
    expect((fp.requests[1]!.tools ?? []).map((t) => t.name)).toContain("spawn_agent");
    // request[2] = grandchild's round 0 (depth 2, AT the cap) — spawn_agent excluded
    expect((fp.requests[2]!.tools ?? []).map((t) => t.name)).not.toContain("spawn_agent");
  });

  test("maxDepth: 2 (explicit): a depth-2 grandchild that calls spawn_agent anyway (provider ignoring the excluded specs) is rejected via belt-and-braces — no great-grandchild thread runs", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X"), done("tool_calls")], // parent (depth 0): spawns the child
      [spawnCall("s2", "grandchild task"), done("tool_calls")], // child (depth 1): spawns the grandchild
      [spawnCall("s3", "great-grandchild attempt"), done("tool_calls")], // grandchild (depth 2, AT the cap) tries anyway
      text("grandchild gave up on spawning further"), // grandchild's continuation round after the denial
      text("child wrapped up"), // child's continuation round after the grandchild bridge returns
      text("parent final report"), // parent's continuation round after the child bridge returns
    ];
    const { engine, store, sessionId } = setup(script, { maxDepth: 2 });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // only TWO thread_started/completed pairs (child + grandchild) — the great-grandchild attempt
    // never ran the bridge
    expect(events.filter((e) => e.type === "thread_started").length).toBe(2);
    expect(events.filter((e) => e.type === "thread_completed").length).toBe(2);

    const denied = events.find((e) => e.type === "tool_result" && e.callId === "s3");
    expect(denied).toMatchObject({ isError: true, output: "subagents cannot spawn further subagents" });

    const starts = events.filter((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>[];
    const childStart = starts.find((e) => e.parentThreadId === "main")!;
    const grandchildStart = starts.find((e) => e.parentThreadId === childStart.threadId)!;
    const s2Result = events.find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(s2Result).toMatchObject({ isError: false, output: "grandchild gave up on spawning further" + trailer(grandchildStart.threadId) });
  });

  test("default maxDepth (5, CC parity): a depth-2 grandchild's specs INCLUDE spawn_agent — the default allows deeper nesting than 2 (proves the default is >2, i.e. 5)", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X"), done("tool_calls")], // parent (depth 0): spawns child
      [spawnCall("s2", "grandchild"), done("tool_calls")], // child (depth 1): spawns grandchild
      text("grandchild final report"), // grandchild (depth 2): ends — but its specs are what we check
      text("child wrapped"),
      text("parent report"),
    ];
    const { engine, sessionId, provider } = setup(script); // NO maxDepth → default 5
    const fp = provider as FakeProvider;
    await engine.runTurn(sessionId);
    // requests[2] is the grandchild's (depth 2) turn — under default 5, depth 2 < 5 so it still has spawn_agent
    expect((fp.requests[2]!.tools ?? []).map((t) => t.name)).toContain("spawn_agent");
  });

  test("maxDepth: 1 explicit — a depth-1 child cannot spawn (regression pin, identical to today's hardcoded default)", async () => {
    const { engine, store, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")],
        [spawnCall("s2", "grandchild"), done("tool_calls")],
        text("child gave up on spawning further"),
      ],
      { maxDepth: 1 },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.filter((e) => e.type === "thread_started").length).toBe(1);
    const denied = events.find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(denied).toMatchObject({ isError: true, output: "subagents cannot spawn further subagents" });
  });

  test("maxDepth: 5 — a depth-4 great-great-grandchild's specs still include spawn_agent (below the cap), same excludeTools logic applies at any depth", async () => {
    // Not a full 5-level e2e (heavy) — pins the depth-parameterized excludeTools construction
    // itself by checking BOTH boundary depths in one setup: the main thread's own child (depth 1)
    // keeps spawn_agent (1 < 5), same as any other below-cap depth would.
    const { provider, engine, sessionId } = setup(
      [
        [spawnCall("s1", "do X"), done("tool_calls")],
        text("done"),
      ],
      { maxDepth: 5 },
    );
    await engine.runTurn(sessionId);
    const fp = provider as FakeProvider;
    const names = (fp.requests[1]!.tools ?? []).map((t) => t.name);
    expect(names).toContain("spawn_agent");
  });

  // T3 review fix: nested-spawn semaphore reentrancy stall. maxConcurrent:1 means the child
  // (depth 1) itself holds the pool's ONLY slot for its whole run — when it tries to spawn a
  // grandchild (depth 2), that spawn's acquire is REENTRANT (opts.depth === 1 > 0) into an
  // already-fully-saturated pool with no other occupant ever going to release. Before the fix
  // this queued unboundedly and only gave up after the per-run timeoutMs (300s), reporting a
  // spurious "timed out" for a grandchild that never even started. After the fix it fails fast
  // with the typed "pool saturated" error, well within the bounded acquireTimeoutMs.
  test("maxConcurrent:1 nested-spawn saturation: grandchild spawn attempt fails fast with a typed pool-saturated error, not a 300s stall — parent/child turns still complete gracefully", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X"), done("tool_calls")], // parent (depth 0): spawns the child — takes the only slot
      [spawnCall("s2", "grandchild task"), done("tool_calls")], // child (depth 1): reentrant spawn attempt, saturated pool
      text("child noticed the saturation error and wrapped up"), // child's continuation round after the denial
      text("parent final report"), // parent's continuation round after the child bridge returns
    ];
    const { engine, store, sessionId } = setup(script, {
      subagentsOpts: { maxConcurrent: 1, timeoutMs: 5000, acquireTimeoutMs: 50 },
    });

    const start = Date.now();
    await engine.runTurn(sessionId);
    const elapsed = Date.now() - start;

    // bounded by acquireTimeoutMs (50ms), nowhere near the 300s (or even the 5s timeoutMs) stall
    expect(elapsed).toBeLessThan(3000);

    const events = store.read(sessionId);

    // only ONE thread_started/completed pair — the grandchild's bridge call ran (thread_started
    // fires before subagents.run) but its subagents.run() call itself failed the reentrant
    // acquire, so its own runThread body never executed.
    const starts = events.filter((e) => e.type === "thread_started");
    expect(starts.length).toBe(2); // child + the grandchild attempt (thread_started fires pre-acquire)
    const completions = events.filter((e) => e.type === "thread_completed") as Extract<SessionEvent, { type: "thread_completed" }>[];
    expect(completions.length).toBe(2);
    // the grandchild's own completion is reported as an error (its subagents.run() call
    // resolved !ok), even though its runThread body never actually ran
    expect(completions.some((e) => e.stopReason === "error")).toBe(true);

    // the grandchild spawn's tool_result on the CHILD's turn: typed saturation error, not a
    // generic timeout and not a hang
    const s2Result = events.find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(s2Result).toMatchObject({ isError: true });
    const s2Output = (s2Result as Extract<SessionEvent, { type: "tool_result" }>).output;
    expect(s2Output).toContain("pool saturated");
    expect(s2Output).not.toContain("timed out after"); // must NOT be the generic per-run timeout message

    // the parent's own turn still completes normally afterward — no stall propagates upward
    const s1Result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(s1Result).toMatchObject({ isError: false, output: "child noticed the saturation error and wrapped up" + trailer(childId) });
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4h-i Task 4: spawn_agent `isolation: "worktree"` (CC parity with Agent.isolation) — a
// spawned child runs in a FRESH git worktree instead of the parent's own cwd. Mac-gated (real
// git repos, mirroring engine-worktree.test.ts's isMac/repo() convention) since WorktreeManager
// shells out to the real `git` binary.
// -------------------------------------------------------------------------------------------
const isMac = process.platform === "darwin";

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { code: p.exitCode ?? 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** mkdtemp + git init + an initial commit so HEAD exists. Mirrors engine-worktree.test.ts's helper. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-spawn-wt-")));
  git(["init"], dir);
  git(["config", "user.email", "test@norma.dev"], dir);
  git(["config", "user.name", "Norma Test"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function setupIsolation(
  script: ProviderEvent[][],
  opts: { cwd?: string; withWorktrees?: boolean } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "norma-engine-spawn-wt-home-"));
  const cwd = opts.cwd ?? repo();
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerSpawnAgentTool(registry);
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  // Mirrors engine-worktree.test.ts's setup: roots are derived LIVE from store.meta(sid).cwd —
  // irrelevant to the isolated CHILD (its roots come from rootsOverride, not this), but this is
  // what the PARENT thread's own tool calls (before/after the spawn) still resolve against.
  const dirs = new SessionDirectories((sid) => {
    const m = store.meta(sid);
    return m.cwd ? [m.cwd] : [];
  });
  const worktrees = opts.withWorktrees !== false ? new WorktreeManager({ baseRef: () => "head" }) : undefined;
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-spawn-wt-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const agentsHome = mkdtempSync(join(tmpdir(), "norma-engine-spawn-wt-agents-"));
  const agentsTrust = new TrustStore(join(agentsHome, "trust.json"));
  const agents = new AgentStore({ normaHome: agentsHome, trust: agentsTrust });
  const subagents = new SubagentManager({});
  // 4h-ii-b Task 1: always wired (mirrors the top-level `setup()`'s own default) — no
  // pre-existing isolation test here asserts on registry state, so wiring it doesn't change any
  // of their observable behavior (a sync spawn's registry entry is a byte-identical no-op
  // as far as the child's own execution goes: `entryAbort`'s signal never fires). Lets a NEW
  // test assert isolation's worktree dir lands in the registry entry's `resume.roots`.
  const bgAgents = new BackgroundAgentRegistry();
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    agents,
    subagents,
    worktrees,
    bgAgents,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });
  return { engine, store, hub, broker, sessionId, cwd, provider, dirs, bgAgents };
}

describe.if(isMac)("AgentEngine: spawn_agent isolation:\"worktree\" (4h-i Task 4)", () => {
  test("child writes a file under isolation:\"worktree\" → the file lands in the worktree dir, NOT the parent repo; the (dirty) worktree is left on disk (no auto-remove, no auto-merge)", async () => {
    const { engine, store, sessionId, cwd, bgAgents } = setupIsolation([
      [spawnCall("s1", "write a note", { isolation: "worktree" }), done("tool_calls")], // parent round 0: spawn, isolated
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "note.txt", content: "isolated" }) }, done("tool_calls")], // child round 0
      text("wrote the note"), // child round 1: end turn
      text("parent wrap-up"), // parent's continuation round
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    expect(started).toBeDefined();
    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: false });

    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const startedThreadId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(spawnResult).toMatchObject({ isError: false, output: "wrote the note" + trailer(startedThreadId) });

    // the parent repo itself was never touched
    expect(existsSync(join(cwd, "note.txt"))).toBe(false);

    // the file DID land in a freshly created worktree under .norma/worktrees — discovered via
    // the filesystem since isolation doesn't emit a worktree_entered event (that's the
    // session-scoped enter_worktree/exit_worktree bridge, a different, unrelated mechanism)
    const wtParent = join(cwd, ".norma", "worktrees");
    const names = readdirSync(wtParent);
    expect(names.length).toBe(1);
    const wtDir = join(wtParent, names[0]!);
    expect(existsSync(join(wtDir, "note.txt"))).toBe(true);

    // dirty (uncommitted note.txt) → clean-only teardown refused to remove it; left on disk
    const status = git(["status", "--short"], wtDir);
    expect(status.stdout).toContain("note.txt");

    // sanity: still a real git worktree, on its own norma/ branch
    const branchList = git(["branch", "--list", `norma/${names[0]}`], cwd);
    expect(branchList.stdout.trim().length).toBeGreaterThan(0);

    // 4h-ii-b Task 1: the registry entry's captured resume context uses the ISOLATED worktree
    // dir as BOTH cwd and roots (exactly what this child's own runThread call actually got as
    // `cwd`/`rootsOverride` — see the bridge's `resumeCtx` construction) — not the parent repo.
    const entry = bgAgents.list(sessionId).find((e) => e.threadId === (started as Extract<SessionEvent, { type: "thread_started" }>).threadId);
    expect(entry?.resume?.cwd).toBe(wtDir);
    expect(entry?.resume?.roots).toEqual([wtDir]);
  });

  test("a CLEAN isolated child (no changes) → the worktree is auto-removed after it returns — `git worktree list` shows only the original repo", async () => {
    const { engine, store, sessionId, cwd } = setupIsolation([
      [spawnCall("s1", "just look around", { isolation: "worktree" }), done("tool_calls")],
      text("nothing to change"), // child makes no tool calls at all — worktree stays pristine
      text("parent wrap-up"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "end_turn" });
    const spawnResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(spawnResult).toMatchObject({ isError: false, output: "nothing to change" + trailer(childId) });

    // clean → auto-removed: `git worktree list` shows ONLY the main repo, no leftover worktree
    const list = git(["worktree", "list"], cwd);
    const lines = list.stdout.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });

  test("no isolation arg → child runs in the parent's own cwd, unchanged from before this feature (no .norma/worktrees created)", async () => {
    const { engine, store, sessionId, cwd } = setupIsolation([
      [spawnCall("s1", "write a note"), done("tool_calls")], // no isolation
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "plain.txt", content: "x" }) }, done("tool_calls")],
      text("wrote it"),
      text("parent wrap-up"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: false });
    // the file lands directly in the parent repo — no worktree involved
    expect(existsSync(join(cwd, "plain.txt"))).toBe(true);
    expect(existsSync(join(cwd, ".norma", "worktrees"))).toBe(false);
  });

  test("cwd is NOT a git repository → isolation:\"worktree\" fails as a typed isError tool_result, no thread_started (no ghost thread)", async () => {
    const plainDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-spawn-wt-notgit-")));
    const { engine, store, sessionId } = setupIsolation(
      [
        [spawnCall("s1", "do X", { isolation: "worktree" }), done("tool_calls")],
        text("parent noticed the failure and wrapped up"),
      ],
      { cwd: plainDir },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    const output = (result as Extract<SessionEvent, { type: "tool_result" }>).output;
    expect(output).toContain("requires a git repository");
  });

  test("cfg.worktrees not wired (WorktreeManager unavailable) → isolation:\"worktree\" fails as a typed isError tool_result, no thread_started", async () => {
    const { engine, store, sessionId } = setupIsolation(
      [
        [spawnCall("s1", "do X", { isolation: "worktree" }), done("tool_calls")],
        text("parent noticed the failure and wrapped up"),
      ],
      { withWorktrees: false },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    const output = (result as Extract<SessionEvent, { type: "tool_result" }>).output;
    expect(output).toContain("isolation:\"worktree\" is not available in this session");
  });

  test("PARENT cwd/roots are unaffected by a sibling isolated spawn: the parent's own post-spawn write still lands in the original repo", async () => {
    const { engine, store, sessionId, cwd } = setupIsolation([
      [spawnCall("s1", "write a note", { isolation: "worktree" }), done("tool_calls")], // parent round 0: spawn, isolated
      [{ type: "tool_call", callId: "cw1", name: "write", argsJson: JSON.stringify({ path: "child.txt", content: "y" }) }, done("tool_calls")], // child round 0
      text("child done"), // child round 1
      // parent's OWN continuation round: writes its own file — must land in the ORIGINAL repo,
      // proving the isolated child's cwd/roots override never leaked into the parent's own state
      [{ type: "tool_call", callId: "p1", name: "write", argsJson: JSON.stringify({ path: "parent.txt", content: "z" }) }, done("tool_calls")],
      text("parent wrap-up"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const p1Result = events.find((e) => e.type === "tool_result" && e.callId === "p1");
    expect(p1Result).toMatchObject({ isError: false });
    expect(existsSync(join(cwd, "parent.txt"))).toBe(true);
    // the child's own file did NOT land in the parent repo
    expect(existsSync(join(cwd, "child.txt"))).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4h-ii-a: spawn_agent `run_in_background` (CC parity: Agent.run_in_background) — a
// detached async spawn. The engine does NOT await the child: it returns
// `{agentId, status:"running"}` as this call's tool_result IMMEDIATELY (synchronously, inside the
// spawn bridge's Promise.all closure) and the child keeps running through SubagentManager,
// reporting into BackgroundAgentRegistry (cfg.bgAgents, wired by `setup()` above) when it
// finishes. Dispatch in the custom providers below is keyed off each request's OWN input content
// (mirrors the existing ConcurrentModeProvider pattern above) rather than call order, since a
// detached child's provider call can interleave with the parent's own continuation round in ways
// that are NOT deterministic relative to the shared FakeProvider script-index counter.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: spawn_agent run_in_background (4h-ii-a)", () => {
  test("run_in_background:true → tool_result is {agentId,status:'running'} immediately, with the child NOT yet completed (no thread_completed, registry still 'running'); the child DOES finish detached once released", async () => {
    let releaseChild: () => void = () => {};
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    class GatedChildProvider implements Provider {
      readonly id = "fake";
      private parentRound = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const first = req.input[0] as { type?: string; content?: unknown } | undefined;
        if (first?.type === "message" && first.content === "bg task") {
          await childGate; // blocks until the test explicitly releases it
          yield { type: "text_delta", delta: "child finished" };
          yield done("end_turn");
          return;
        }
        const n = this.parentRound++;
        if (n === 0) {
          yield spawnCall("s1", "bg task", { run_in_background: true });
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent wrap-up" };
        yield done("end_turn");
      }
    }
    const { engine, store, sessionId, bgAgents } = setup([], { provider: new GatedChildProvider() });

    // engine.runTurn resolves WITHOUT ever waiting on the gated (still-blocked) child — the
    // clearest proof the bg path never awaits the detached promise chain.
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started");
    expect(started).toBeDefined();
    const childId = (started as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(childId).toMatch(/^th_/);

    // strongest single proof of detachment: no thread_completed for the child yet
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(toolResult).toMatchObject({ isError: false });
    const output = (toolResult as Extract<SessionEvent, { type: "tool_result" }>).output;
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ agentId: childId, status: "running" });
    // (e) no AbortController / registry entry / any extra key ever reaches the model
    expect(Object.keys(parsed).sort()).toEqual(["agentId", "status"]);

    expect(bgAgents.get(childId)?.status).toBe("running");

    // the PARENT's own turn completed normally (it continued right past the bg spawn)
    const mainTurnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(mainTurnCompleted).toMatchObject({ stopReason: "end_turn" });

    // (b) now release the child and let it actually run to completion, detached
    releaseChild();
    for (let i = 0; i < 50 && bgAgents.get(childId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bgAgents.get(childId)?.status).toBe("completed");
    expect(bgAgents.get(childId)?.result).toBe("child finished");

    const eventsAfter = store.read(sessionId);
    const completed = eventsAfter.find((e) => e.type === "thread_completed" && e.threadId === childId);
    expect(completed).toMatchObject({ stopReason: "end_turn" });
  });

  test("mixed batch: one sync spawn + one bg spawn in the same assistant message — sync gets the full awaited result, bg gets the immediate running-JSON", async () => {
    class MixedBatchProvider implements Provider {
      readonly id = "fake";
      private parentRound = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const first = req.input[0] as { type?: string; content?: unknown } | undefined;
        if (first?.type === "message" && first.content === "sync task") {
          yield { type: "text_delta", delta: "sync child done" };
          yield done("end_turn");
          return;
        }
        if (first?.type === "message" && first.content === "bg task") {
          yield { type: "text_delta", delta: "bg child done" };
          yield done("end_turn");
          return;
        }
        const n = this.parentRound++;
        if (n === 0) {
          yield spawnCall("sSync", "sync task");
          yield spawnCall("sBg", "bg task", { run_in_background: true });
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent wrap-up" };
        yield done("end_turn");
      }
    }
    const { engine, store, sessionId, bgAgents } = setup([], { provider: new MixedBatchProvider() });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // both children started
    expect(events.filter((e) => e.type === "thread_started").length).toBe(2);

    const syncResult = events.find((e) => e.type === "tool_result" && e.callId === "sSync");
    const syncChildId = (events.find((e) => e.type === "thread_started" && e.prompt === "sync task") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(syncResult).toMatchObject({ isError: false, output: "sync child done" + trailer(syncChildId) });

    const bgResult = events.find((e) => e.type === "tool_result" && e.callId === "sBg");
    expect(bgResult).toMatchObject({ isError: false });
    const bgOutput = (bgResult as Extract<SessionEvent, { type: "tool_result" }>).output;
    const bgParsed = JSON.parse(bgOutput);
    expect(bgParsed.status).toBe("running");
    expect(typeof bgParsed.agentId).toBe("string");
    expect(bgAgents.get(bgParsed.agentId)).toBeDefined();

    // the parent's own turn completed normally
    const mainTurnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(mainTurnCompleted).toMatchObject({ stopReason: "end_turn" });
  });

  test("4h-ii-b Task 1: resume context is captured on the bg entry at spawn — agentType/cwd/approvalPolicy/model/maxTurns/instructions match what the child actually ran with", async () => {
    const { engine, store, sessionId, cwd, bgAgents } = setup([
      [spawnCall("s1", "bg task", { run_in_background: true, model: "fake-1", max_turns: 7, agentType: "general-purpose" }), done("tool_calls")],
      text("parent wrap-up"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;
    const entry = bgAgents.get(started.threadId);
    expect(entry?.resume).toMatchObject({
      agentType: "general-purpose",
      cwd,
      roots: undefined, // no isolation → the resumed child falls back to the session's live roots
      approvalPolicy: "auto", // setup()'s default policy, no mode override
      model: "fake-1",
      maxTurns: 7,
    });
    // instructions carries the child's own agent-def base prompt (subagent framing), not the
    // parent's own instructions — proof this is genuinely the CHILD's resolved instructionsFull.
    expect(entry?.resume?.instructions).toContain("subagent");
  });

  // 5a matrix case 1 (USER pin: background children, CC parity — phase 5a T2): depth 0, WITH the
  // bg registry wired, run_in_background OMITTED entirely → detached by default. This is the
  // flip itself: before 5a this omission meant synchronous (this test used to pin exactly that,
  // titled "no run_in_background (default false/absent) → unchanged..."); now it's re-pointed at
  // the NEW default. Constructs its own tool_call BYPASSING spawnCall's own `run_in_background:
  // false` default (added to that helper for the OTHER tests in this file, which need sync
  // scaffolding for whatever else they're pinning) so this one actually omits the key end to end,
  // proving the ENGINE's own default, not the test helper's.
  test("(5a matrix #1) depth 0 + registry wired + run_in_background OMITTED → detached by default (tool_result is {agentId,status:'running'} immediately, turn continues, child still finishes on its own)", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [{ type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "do X", description: "test task" }) }, done("tool_calls")],
      text("child final report"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;
    expect(started).toBeDefined();
    const childId = started.threadId;

    // the tool_result is the immediate running-JSON, not the child's final text — the
    // strongest single proof of detachment reachable WITHOUT gating the child's own provider
    // call (this simple, ungated script has no real delay, so the child's own trivial round can
    // race to completion within the same microtask flush as the parent's turn — the sibling
    // "run_in_background:true" test above proves genuine non-blocking via an explicit gate; this
    // test's job is only to prove OMISSION reaches the same detached path, not to re-prove that).
    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(toolResult).toMatchObject({ isError: false });
    expect(JSON.parse((toolResult as Extract<SessionEvent, { type: "tool_result" }>).output)).toEqual({ agentId: childId, status: "running" });

    // the parent's own turn completed normally — it never awaited the child's own result to get
    // its tool_result (a sync spawn's tool_result IS the child's final text, never this JSON)
    const mainTurnCompleted = events.find((e) => e.type === "turn_completed" && e.threadId === "main");
    expect(mainTurnCompleted).toMatchObject({ stopReason: "end_turn" });

    // the detached child DOES finish on its own — poll rather than a fixed sleep
    for (let i = 0; i < 200 && bgAgents.get(childId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bgAgents.get(childId)).toMatchObject({ status: "completed", result: "child final report" });
  });

  // 5a matrix case 2: depth 0 + registry wired + run_in_background EXPLICITLY false → the
  // synchronous, awaited path is still available on request (an explicit opt-out of the new
  // default) — parent's tool_result is the child's final text directly, not a running-JSON. Also
  // pins 4h-ii-b Task 1's "a sync spawn also registers (and completes) in the bg registry, already
  // notified" contract, now reached via explicit `false` rather than omission.
  test("(5a matrix #2) depth 0 + registry wired + run_in_background:false → synchronous, fully-awaited; parent's tool_result is the child's final text, not a running-JSON", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [spawnCall("s1", "do X", { run_in_background: false }), done("tool_calls")],
      text("child final report"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const started = events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;
    expect(toolResult).toMatchObject({ isError: false, output: "child final report" + trailer(started.threadId) });

    // 4h-ii-b Task 1: a sync spawn now ALSO registers (and completes) in the bg registry — CC
    // parity, so a finished sync-spawned agent is resumable too, not just a bg-spawned one — but
    // it's registered `notified` (see BackgroundAgentRegistry.complete's own doc comment): the
    // parent already got this result directly as the tool_result above, this same turn, so it
    // must never ALSO surface via the next turn's completion-reminder sweep.
    const entry = bgAgents.list(sessionId).find((e) => e.agentId === started.threadId);
    expect(entry).toMatchObject({ status: "completed", result: "child final report" + trailer(started.threadId), notified: true });
    expect(entry?.resume).toMatchObject({ agentType: "general-purpose", approvalPolicy: "auto" });
  });

  // 5a matrix case 3: depth 0 + NO registry wired + run_in_background OMITTED → still synchronous
  // (NOT the "not available" typed error) — the new default only ever applies where there's
  // somewhere to land a detached entry; a registry-less session must never have spawn_agent's
  // baseline behavior flip out from under it just because the flag was left out.
  test("(5a matrix #3) depth 0 + NO registry wired + run_in_background OMITTED → still synchronous, not the not-available error", async () => {
    const { engine, store, sessionId } = setup(
      [
        [{ type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "do X", description: "test task" }) }, done("tool_calls")],
        text("child final report"),
      ],
      { withBgAgents: false },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "end_turn" });

    const toolResult = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    const childId = (events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(toolResult).toMatchObject({ isError: false, output: "child final report" + trailer(childId) });
  });

  // 5a matrix case 5: depth 1 (a spawn issued FROM WITHIN a child) + run_in_background OMITTED →
  // still synchronous — only depth 0 flips to background by default; a nested spawn keeps waiting
  // by default (the grandchild's report needs to land in the CHILD's own in-report context, and
  // completion notifications are main-thread-only, so an unreachable-by-default detached
  // grandchild would be a footgun, not a convenience).
  test("(5a matrix #5) depth 1 (spawn issued from within a child) + run_in_background OMITTED → still synchronous, not detached", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X", { run_in_background: false }), done("tool_calls")], // parent (depth 0): sync-spawns the child — scaffolding, not the subject
      [{ type: "tool_call", callId: "s2", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "grandchild", description: "task" }) }, done("tool_calls")], // child (depth 1): omits run_in_background
      text("grandchild final report"), // grandchild (depth 2) round 0
      text("child wrapped up after grandchild"), // child's own continuation, after the grandchild bridge returns SYNCHRONOUSLY
      text("parent final report"), // parent's continuation
    ];
    const { engine, store, sessionId } = setup(script);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // the grandchild's result bubbles up as the CHILD's own tool_result for s2 — only possible if
    // the depth-1 spawn was awaited synchronously (a detached s2 would have returned an immediate
    // {agentId,status:"running"} tool_result instead of the grandchild's actual report)
    const starts = events.filter((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>[];
    const childStart = starts.find((e) => e.parentThreadId === "main")!;
    const grandchildStart = starts.find((e) => e.parentThreadId === childStart.threadId)!;
    const s2Result = events.find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(s2Result).toMatchObject({ isError: false, output: "grandchild final report" + trailer(grandchildStart.threadId) });

    // and the child's own final text (after the grandchild returns) bubbles up as the PARENT's
    // tool_result for s1, proving the child kept running its OWN loop after the nested spawn
    const s1Result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(s1Result).toMatchObject({ isError: false, output: "child wrapped up after grandchild" + trailer(childStart.threadId) });
  });

  test("run_in_background:true whose child provider ERRORS → registry.complete records isError-shaped failure text, thread_completed stopReason 'error'", async () => {
    class ErrorBgChildProvider implements Provider {
      readonly id = "fake";
      private parentRound = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const first = req.input[0] as { type?: string; content?: unknown } | undefined;
        if (first?.type === "message" && first.content === "bg task") {
          yield { type: "error", code: "server", message: "upstream 404: model not found" };
          return;
        }
        const n = this.parentRound++;
        if (n === 0) {
          yield spawnCall("s1", "bg task", { run_in_background: true });
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent wrap-up" };
        yield done("end_turn");
      }
    }
    const { engine, store, sessionId, bgAgents } = setup([], { provider: new ErrorBgChildProvider() });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const started = events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;
    const childId = started.threadId;

    // poll for the detached error to land
    for (let i = 0; i < 50 && bgAgents.get(childId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bgAgents.get(childId)?.status).toBe("failed");
    expect(bgAgents.get(childId)?.result).toContain("upstream 404: model not found");

    const eventsAfter = store.read(sessionId);
    const completed = eventsAfter.find((e) => e.type === "thread_completed" && e.threadId === childId);
    expect(completed).toMatchObject({ stopReason: "error" });
  });

  test("run_in_background:true when cfg.bgAgents is not wired (but subagents/agents ARE) → typed isError tool_result, no thread_started (no ghost thread)", async () => {
    const { engine, store, sessionId, bgAgents } = setup(
      [
        [spawnCall("s1", "bg task", { run_in_background: true }), done("tool_calls")],
        text("parent noticed the failure and wrapped up"),
      ],
      { withBgAgents: false }, // subagents/agents stay wired — only the bg registry is missing
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect(events.some((e) => e.type === "thread_completed")).toBe(false);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<SessionEvent, { type: "tool_result" }>).output)
      .toBe("run_in_background is not available in this session");

    // nothing was ever registered into the (unwired) registry either
    expect(bgAgents.list(sessionId)).toEqual([]);
  });

  // No-timeout task (user rule 2026-07-12): the old bg-path `timeoutMs: null`/`undefined`
  // depth-fork is RETIRED along with the manager's default wall clock — NO spawn path passes a
  // timeoutMs override anymore, at any depth. What bounds a child now: the manager's own
  // progress-stall watchdog (default 600s of NO provider events, every depth), the per-thread
  // iteration cap, task_stop (depth-0 bg), and an EXPLICIT settings.subagents.timeoutMs opt-in.
  test("run_in_background:true → subagents.run receives NO timeoutMs override (no wall clock; the stall watchdog + task_stop bound it)", async () => {
    const { engine, store, sessionId, subagents } = setup([
      [spawnCall("s1", "bg task", { run_in_background: true }), done("tool_calls")],
      text("parent wrap-up"),
    ]);
    const spy = spyOn(subagents!, "run");
    try {
      await engine.runTurn(sessionId);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(spy.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
    } finally {
      spy.mockRestore();
    }
  });

  // The SYNC path likewise carries NO timeoutMs override — with the manager's default wall clock
  // gone, "no override" now means NO wall clock at all unless settings.subagents.timeoutMs
  // explicitly configures one (the constructor getter).
  test("no run_in_background (sync spawn) → subagents.run's opts carry NO timeoutMs override (no default wall clock)", async () => {
    const { engine, store, sessionId, subagents } = setup([
      [spawnCall("s1", "do X"), done("tool_calls")],
      text("child final report"),
    ]);
    const spy = spyOn(subagents!, "run");
    try {
      await engine.runTurn(sessionId);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(spy.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
    } finally {
      spy.mockRestore();
    }
  });

  // No-timeout task, superseding whole-branch review C1 (4h-ii-c "untimed ⟺ killable"): a
  // depth-1 child's OWN bg grandchild used to keep the 300s net because task_stop can't reach it
  // (main-thread-only; entryAbort doesn't cascade into a grandchild's AbortSignal.any set). The
  // progress-stall watchdog — SubagentManager's own default, applied to EVERY run at EVERY depth
  // — is what covers that unreachable-by-task_stop case now, so the depth fork is gone: a nested
  // bg spawn passes NO timeoutMs either, same as depth 0. Drives a depth-1 child (spawned
  // synchronously, so its own bg spawn call is guaranteed to land as the SECOND subagents.run
  // invocation) that itself issues a `run_in_background` spawn.
  test("bg spawn issued FROM a depth-1 child (nested) → subagents.run receives NO timeoutMs override either (the stall watchdog covers what the old 300s net did)", async () => {
    const script: ProviderEvent[][] = [
      [spawnCall("s1", "do X"), done("tool_calls")], // parent (depth 0) round 0: SYNC-spawns the child — awaited, so calls[0] is recorded before calls[1] can exist
      [spawnCall("s2", "grandchild bg task", { run_in_background: true }), done("tool_calls")], // child (depth 1) round 0: bg-spawns a depth-2 grandchild
      text("wrap up"), // clamped script tail: covers the child's post-bg-spawn continuation, the parent's own continuation, and the detached grandchild's own round, whichever order they actually run in
    ];
    const { engine, store, sessionId, subagents } = setup(script);
    const spy = spyOn(subagents!, "run");
    try {
      await engine.runTurn(sessionId);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      // calls[0] = parent's (depth 0) own sync spawn of the child — no timeoutMs override.
      expect(spy.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
      // calls[1] = the depth-1 CHILD's bg spawn of the grandchild — no override here either (the
      // old depth>0 300s fallback is retired; the stall watchdog bounds it instead).
      expect(spy.mock.calls[1]?.[1]).not.toHaveProperty("timeoutMs");
    } finally {
      spy.mockRestore();
    }
  });
});

// -------------------------------------------------------------------------------------------
// Phase 4h-ii-b Task 2: spawn_agent `name` (CC parity) — a stable, per-session handle so a later
// resume/send_message (Tasks 3-4) can address a spawned agent by name instead of its opaque
// agentId. The engine's spawn bridge hand-parses `name` off argsJson (same two-layer shape as
// model/mode/isolation/run_in_background) and PRE-checks it against BackgroundAgentRegistry
// before thread_started fires — a collision with an EXISTING agent in the same session must
// never produce a ghost thread. register() itself is the backstop for the same-batch sibling
// race the pre-check can't see (untested here — out of scope per the task brief).
// -------------------------------------------------------------------------------------------
describe("AgentEngine: spawn_agent name (4h-ii-b Task 2)", () => {
  test("spawn with name:\"researcher\" → BackgroundAgentRegistry.get(\"researcher\", sessionId) resolves that agent", async () => {
    const { engine, store, sessionId, bgAgents } = setup([
      [spawnCall("s1", "do X", { name: "researcher" }), done("tool_calls")],
      text("child final report"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const started = events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;

    const entry = bgAgents.get("researcher", sessionId);
    expect(entry).toBeDefined();
    expect(entry!.agentId).toBe(started.threadId);
    expect(entry!.name).toBe("researcher");
  });

  test("a second spawn reusing an in-use name (different agent, same session) → typed isError, no ghost thread", async () => {
    const { engine, store, hub, sessionId, bgAgents } = setup([
      [spawnCall("s1", "do X", { name: "researcher" }), done("tool_calls")], // turn1 parent round0: spawn
      text("child final report"), // turn1 child's only round
      text("parent turn1 wrap-up"), // turn1 parent continuation
      [spawnCall("s2", "do Y", { name: "researcher" }), done("tool_calls")], // turn2 parent round0: spawn (rejected pre-check)
      text("parent turn2 wrap-up"), // turn2 parent continuation — NO child round consumed (pre-check rejects before dispatch)
    ]);
    await engine.runTurn(sessionId);
    const eventsAfterTurn1 = store.read(sessionId);
    const startedTurn1 = eventsAfterTurn1.filter((e) => e.type === "thread_started");
    expect(startedTurn1.length).toBe(1);
    const firstAgentId = (startedTurn1[0] as Extract<SessionEvent, { type: "thread_started" }>).threadId;

    const client = { clientName: "u", deliver: () => true };
    hub.attach(client, sessionId, 0);
    hub.send(client, sessionId, "second request");
    await engine.runTurn(sessionId);
    const eventsAfterTurn2 = store.read(sessionId);

    // no NEW thread_started/thread_completed — still exactly the one thread from turn 1 (no
    // ghost thread for the rejected spawn)
    expect(eventsAfterTurn2.filter((e) => e.type === "thread_started").length).toBe(1);
    expect(eventsAfterTurn2.filter((e) => e.type === "thread_completed").length).toBe(1);

    const result2 = eventsAfterTurn2.find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(result2).toMatchObject({ isError: true });
    expect((result2 as Extract<SessionEvent, { type: "tool_result" }>).output)
      .toBe(`name 'researcher' already in use by agent ${firstAgentId}`);

    // the registry still resolves "researcher" to the FIRST agent, unchanged by the rejected spawn
    expect(bgAgents.get("researcher", sessionId)?.agentId).toBe(firstAgentId);
  });

  test("the same name in a different session is allowed (names are per-session)", async () => {
    const { engine, store, sessionId: session1, cwd, bgAgents } = setup([
      [spawnCall("s1", "do X", { name: "researcher" }), done("tool_calls")], // session1 parent round0: spawn
      text("child1 final report"), // session1 child round
      text("parent1 wrap-up"), // session1 parent continuation
      [spawnCall("s2", "do Y", { name: "researcher" }), done("tool_calls")], // session2 parent round0: spawn
      text("child2 final report"), // session2 child round
      text("parent2 wrap-up"), // session2 parent continuation
    ]);
    await engine.runTurn(session1);

    const session2 = store.createSession("global", { cwd, approvalPolicy: "auto" });
    await engine.runTurn(session2);

    const entry1 = bgAgents.get("researcher", session1);
    const entry2 = bgAgents.get("researcher", session2);
    expect(entry1).toBeDefined();
    expect(entry2).toBeDefined();
    expect(entry1!.agentId).not.toBe(entry2!.agentId);
    expect(entry1!.sessionId).toBe(session1);
    expect(entry2!.sessionId).toBe(session2);

    const result2 = store.read(session2).find((e) => e.type === "tool_result" && e.callId === "s2");
    expect(result2).toMatchObject({ isError: false, output: "child2 final report" + trailer(entry2!.agentId) });
  });
});

// -------------------------------------------------------------------------------------------
// bg-retrigger Task 1: the 4h-ii-a Task 4 "background-agent completion reminder" describe block
// that lived here was RETIRED along with buildBgCompletionReminder itself — a detached child's
// completion is now PERSISTED as a task_notification history event (engine.ts's
// notifyBgCompletion) and replayed user-role. Its coverage migrated, test-for-test, to
// test/agent/bg-retrigger.test.ts.
// -------------------------------------------------------------------------------------------

// -------------------------------------------------------------------------------------------
// Phase 5a Task 4 (T3-review finding, controller-approved additional deliverable): a regression
// pin for the dispatch loop's per-call event ORDERING, not new behavior — it passes today without
// any implementation change. engine.ts's `for (const call of calls)` loop (~:1666) emits, per call
// in the MODEL's OWN original order, `tool_call(call)` then THAT SAME call's `tool_result` before
// ever emitting the next call's `tool_call` — strict alternation — even though the underlying
// children this dispatches EXECUTE concurrently (the bridge's own `Promise.all(spawnCalls.map(...))`
// runs above this loop and has already resolved every call's outcome by the time the loop below
// even starts). The TUI's name→row pairing (phase 5a T3, tui/state.ts's `bgSpawnNameMapping` +
// its `activeTools[0]` pop-the-front pairing) leans on this exact invariant — it pairs a
// background spawn's `name` onto the row for whichever tool_call is CURRENTLY at the front of
// `activeTools`, trusting that its very next tool_result is that SAME call's own. A future refactor
// that instead drained results in Promise.all SETTLEMENT order (fastest-finishing child first)
// rather than replaying them in call order would silently mispair names onto the wrong rows,
// without ever touching this loop's code shape — this test exists so that regression fails loudly
// here first.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: dispatch loop preserves strict per-call tool_call/tool_result alternation for N concurrent spawns (5a T4 regression pin)", () => {
  test("two named background spawns in one assistant message: tool_call(cA) -> tool_result(cA) -> tool_call(cB) -> tool_result(cB), in the model's original call order — and each result's agentId matches ITS OWN call's name, not the other's", async () => {
    const { engine, sessionId, events, bgAgents } = setup([
      [
        spawnCall("cA", "task A", { run_in_background: true, name: "alpha" }),
        spawnCall("cB", "task B", { run_in_background: true, name: "beta" }),
        done("tool_calls"),
      ],
      text("parent wrap-up"), // parent's own continuation round, after both immediate tool_results
    ]);
    await engine.runTurn(sessionId);

    // Strict alternation, main-thread only, restricted to these two callIds (a child's OWN
    // thread-tagged tool events, if any, are excluded by the threadId==="main" filter — not the
    // subject here).
    const mainToolEvents = events.filter((e): e is Extract<SessionEvent, { type: "tool_call" | "tool_result" }> =>
      (e.type === "tool_call" || e.type === "tool_result") && e.threadId === "main" && (e.callId === "cA" || e.callId === "cB"));
    expect(mainToolEvents.map((e) => `${e.type}:${e.callId}`)).toEqual([
      "tool_call:cA", "tool_result:cA", "tool_call:cB", "tool_result:cB",
    ]);

    const resultA = mainToolEvents[1] as Extract<SessionEvent, { type: "tool_result" }>;
    const resultB = mainToolEvents[3] as Extract<SessionEvent, { type: "tool_result" }>;
    const agentIdA = (JSON.parse(resultA.output) as { agentId: string }).agentId;
    const agentIdB = (JSON.parse(resultB.output) as { agentId: string }).agentId;
    expect(agentIdA).not.toBe(agentIdB);

    // thread_started carries no `name` field (per the T4 brief), so the pairing ground truth comes
    // from the registry instead: `name` lives only on each call's OWN argsJson (spawnCall's
    // `extra.name` above) and on the registry entry the spawn bridge registered FOR that same call
    // — independent of event order. A pairing bug (e.g. a Promise.all-settlement-order refactor)
    // would scramble these two lines against each other without ever breaking the alternation
    // assertion above, which is why both are asserted here.
    expect(bgAgents.get("alpha", sessionId)?.agentId).toBe(agentIdA);
    expect(bgAgents.get("beta", sessionId)?.agentId).toBe(agentIdB);
  });
});

// -------------------------------------------------------------------------------------------
// No-timeout task (user rule 2026-07-12, CC parity): the default subagent wall clock is GONE —
// replaced by (a) a progress-STALL watchdog whose window resets on every provider event the
// child streams (runThread's onProgress chokepoint), (b) ESC cascading into SYNC children (the
// parent turn's signal folded into the child's composite — a user interrupt now actually stops
// the foreground child instead of leaving the parent blocked on it), and (c) stall failures
// surfacing the child's last persisted assistant text (partial output) to the parent.
// -------------------------------------------------------------------------------------------
describe("AgentEngine: no-default-wall-clock — ESC cascade + stall watchdog (no-timeout task)", () => {
  test("ESC cascade: interrupt(sessionId) aborts a running SYNC child; the tool_result reads 'aborted' (never stalled/timed out), the parent turn settles aborted, and the child's slot is RELEASED (a follow-up spawn acquires it)", async () => {
    class ChildAwaitAbortProvider implements Provider {
      readonly id = "fake";
      private call = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const n = this.call++;
        if (n === 0) { yield spawnCall("s1", "long sync task"); yield done("tool_calls"); return; }
        if (n === 1) {
          // the CHILD's only round: blocks until ITS OWN composite signal aborts (which, with the
          // ESC cascade, the parent turn's interrupt now fires), then reports aborted — exactly
          // what the real providers do when their signal fires mid-stream.
          await new Promise<void>((resolve) => {
            if (req.signal?.aborted) return resolve();
            req.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield done("aborted");
          return;
        }
        if (n === 2) { yield done("aborted"); return; } // parent's own continuation: signal already aborted
        if (n === 3) { yield spawnCall("s2", "follow-up task"); yield done("tool_calls"); return; } // turn 2: spawn again
        if (n === 4) { yield { type: "text_delta", delta: "second child ok" }; yield done("end_turn"); return; } // child 2
        yield { type: "text_delta", delta: "turn 2 wrapped" }; yield done("end_turn"); // parent 2 continuation
      }
    }
    // maxConcurrent: 1 makes the slot-release assertion REAL: if the ESC'd child's slot leaked,
    // turn 2's spawn below would queue unbounded (non-reentrant) and this test would hang.
    const { engine, store, hub, sessionId } = setup([], {
      provider: new ChildAwaitAbortProvider(),
      subagentsOpts: { maxConcurrent: 1 },
    });

    const turn = engine.runTurn(sessionId);
    await new Promise((r) => setTimeout(r, 30)); // let the bridge start the child (it's now blocked awaiting abort)
    expect(engine.isRunning(sessionId)).toBe(true);
    const res = engine.interrupt(sessionId);
    expect(res.wasRunning).toBe(true);
    await turn;

    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    const out = (result as Extract<SessionEvent, { type: "tool_result" }>).output;
    expect(out).toContain("aborted");
    expect(out).not.toContain("stalled");
    expect(out).not.toContain("timed out");

    // the child's completion reports the abort, not an error
    const childCompleted = events.find((e) => e.type === "thread_completed");
    expect(childCompleted).toMatchObject({ stopReason: "aborted" });
    // and the main turn itself settled as user-interrupted
    const mainCompleted = events.filter((e) => e.type === "turn_completed" && e.threadId === "main").at(-1);
    expect(mainCompleted).toMatchObject({ stopReason: "aborted" });

    // slot released: a follow-up spawn in a fresh turn acquires the single slot and completes
    const client = { clientName: "u", deliver: () => true };
    hub.attach(client, sessionId, 0);
    hub.send(client, sessionId, "again");
    await engine.runTurn(sessionId);
    const finalEvents = store.read(sessionId);
    const result2 = finalEvents.find((e) => e.type === "tool_result" && e.callId === "s2");
    const secondChildId = (finalEvents.find((e) => e.type === "thread_started" && e.prompt === "follow-up task") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(result2).toMatchObject({ isError: false, output: "second child ok" + trailer(secondChildId) });
  });

  test("stall partial-output surfacing: a child that persisted an assistant message then went silent → the stall-abort tool_result contains 'stalled' AND the partial text", async () => {
    class TalkThenHangProvider implements Provider {
      readonly id = "fake";
      private call = 0;
      constructor(private readonly filePath: string) {}
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        const n = this.call++;
        if (n === 0) { yield spawnCall("s1", "scan the machine"); yield done("tool_calls"); return; }
        if (n === 1) {
          // child round 0: emits REAL assistant text (persisted at round end) + a tool call so
          // the round ends on tool_calls and the child CONTINUES into the hanging round below.
          yield { type: "text_delta", delta: "PARTIAL-FINDINGS: found 3 candidate dirs so far" };
          yield { type: "tool_call", callId: "r1", name: "read", argsJson: JSON.stringify({ file_path: this.filePath }) };
          yield done("tool_calls");
          return;
        }
        if (n === 2) {
          // child round 1: total silence — no events, never resolves. Only the stall watchdog
          // (40ms below) ends this.
          await new Promise<never>(() => {});
          return;
        }
        yield { type: "text_delta", delta: "parent wrapped up after the stall" }; yield done("end_turn");
      }
    }
    const home = mkdtempSync(join(tmpdir(), "norma-stall-partial-"));
    const filePath = join(home, "probe.txt");
    writeFileSync(filePath, "probe contents");
    const { engine, store, sessionId } = setup([], {
      provider: new TalkThenHangProvider(filePath),
      subagentsOpts: { stallTimeoutMs: 40 },
    });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const result = events.find((e) => e.type === "tool_result" && e.callId === "s1");
    expect(result).toMatchObject({ isError: true });
    const out = (result as Extract<SessionEvent, { type: "tool_result" }>).output;
    expect(out).toContain("stalled: no progress");
    expect(out).not.toContain("timed out"); // a stall must never masquerade as a wall-clock timeout
    expect(out).toContain("partial output before stall:");
    expect(out).toContain("PARTIAL-FINDINGS: found 3 candidate dirs so far");

    // task-16 (Stalled roster verb, CC-parity follow-up): a stall-killed child gets its OWN
    // distinct wire stopReason — "stalled" — never the generic "error" a genuine provider/tool
    // failure reports. Before this task both cases wired identically, so the TUI rendered a
    // stalled (resumable, partial-output) child as a flat "Failed" indistinguishable from a real
    // crash.
    const completed = events.find((e) => e.type === "thread_completed");
    expect(completed).toMatchObject({ stopReason: "stalled" });
  });

  test("(task-16) run_in_background:true child that STALLS (no provider events at all) → thread_completed stopReason 'stalled', not 'error' — registry status is UNCHANGED ('failed')", async () => {
    class HangForeverBgChildProvider implements Provider {
      readonly id = "fake";
      private parentRound = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const first = req.input[0] as { type?: string; content?: unknown } | undefined;
        if (first?.type === "message" && first.content === "bg task") {
          // the child's only round: total silence forever — only the stall watchdog (40ms below)
          // ends this.
          await new Promise<never>(() => {});
          return;
        }
        const n = this.parentRound++;
        if (n === 0) {
          yield spawnCall("s1", "bg task", { run_in_background: true });
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent wrap-up" };
        yield done("end_turn");
      }
    }
    const { engine, store, sessionId, bgAgents } = setup([], {
      provider: new HangForeverBgChildProvider(),
      subagentsOpts: { stallTimeoutMs: 40 },
    });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const started = events.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>;
    const childId = started.threadId;

    // poll for the detached stall-abort to land
    for (let i = 0; i < 50 && bgAgents.get(childId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Registry semantics are DELIBERATELY unchanged by this task — a stalled bg child still
    // reports "failed" (no `timedOut` flag ever gets set for a stall), only the WIRE stopReason
    // gains the distinct value.
    expect(bgAgents.get(childId)?.status).toBe("failed");

    const eventsAfter = store.read(sessionId);
    const completed = eventsAfter.find((e) => e.type === "thread_completed" && e.threadId === childId);
    expect(completed).toMatchObject({ stopReason: "stalled" });
  });

  test("progress pings genuinely reach the watchdog: a child streaming events SLOWER than the stall window in total (but faster per-event) completes fine — the chokepoint resets the window per provider event", async () => {
    class SlowStreamProvider implements Provider {
      readonly id = "fake";
      private call = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        const n = this.call++;
        if (n === 0) { yield spawnCall("s1", "slow but alive"); yield done("tool_calls"); return; }
        if (n === 1) {
          // the child's only round: ~5 x 20ms between events = ~100ms total, all gaps well under
          // the 50ms stall window. Without the onProgress chokepoint wiring, the watchdog (armed
          // once at run start) would fire at 50ms absolute and kill this child mid-stream.
          for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 20));
            yield { type: "text_delta", delta: "chunk " };
          }
          yield done("end_turn");
          return;
        }
        yield { type: "text_delta", delta: "parent done" }; yield done("end_turn");
      }
    }
    const { engine, store, sessionId } = setup([], {
      provider: new SlowStreamProvider(),
      subagentsOpts: { stallTimeoutMs: 50 },
    });
    await engine.runTurn(sessionId);
    const slowEvents = store.read(sessionId);
    const result = slowEvents.find((e) => e.type === "tool_result" && e.callId === "s1");
    const childId = (slowEvents.find((e) => e.type === "thread_started") as Extract<SessionEvent, { type: "thread_started" }>).threadId;
    expect(result).toMatchObject({ isError: false, output: "chunk chunk chunk chunk chunk " + trailer(childId) });
  });
});
