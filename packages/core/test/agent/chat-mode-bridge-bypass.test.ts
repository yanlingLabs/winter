import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerAskUserTool } from "../../src/agent/tools/ask-user";
import { registerBashTool } from "../../src/agent/tools/bash";
import { registerSpawnAgentTool } from "../../src/agent/tools/spawn";
import { registerToolSearchTool } from "../../src/agent/tools/toolsearch";
import { registerWorktreeTools } from "../../src/agent/tools/worktree";
import { registerWorkflowTool } from "../../src/agent/tools/workflow";
import { PermissionGate, type SessionApprovalPolicy } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import { AgentStore } from "../../src/agent/agents";
import { SubagentManager } from "../../src/agent/subagents";
import { WorktreeManager } from "../../src/agent/worktree";
import { CHAT_ALLOW_TOOLS } from "../../src/agent/chat-prompt";
import { DISPATCH_ALLOW_TOOLS } from "../../src/agent/dispatch-prompt";
import type { WorkflowRuntime } from "../../src/workflows/runtime";
import type { ProviderEvent } from "../../src/providers/types";

/**
 * CM (chat-mode) CLOSING branch review, the one must-fix: THE FOURTH SEAM.
 *
 * 77ee7857 threaded a single `toolAccess {excludeTools?, allowTools?}` pair through three seams —
 * the deferred-index instructions TEXT, the provider-facing `specs()` list, and `executeCall`. The
 * closing review then PROVED by probe that a fourth seam bypasses all of it: three call names are
 * intercepted by DEDICATED BRIDGES *before* the per-call dispatch loop ever reaches `executeCall`,
 * and each bridge was gated only on CONFIG PRESENCE, never on the thread's own toolset:
 *
 *   - the pre-branch `spawnCalls` gather — `cfg.subagents && cfg.agents && depth < maxDepth`
 *   - `isWorktree`     — `(enter_worktree | exit_worktree) && !!cfg.worktrees`
 *   - `isWorkflowLaunch` — `name === "Workflow" && !!cfg.workflows`
 *
 * The reviewer's probe on a real `mode:"chat"` session (`approvalPolicy:"auto"`, the app's own
 * default) whose provider emitted an off-list `spawn_agent` whose CHILD emitted `write`:
 *
 *     MAIN tools:  ["ask_user"]
 *     CHILD tools: ["read","ls","glob","grep","write","edit","bash","spawn_agent"]
 *     [th_b763be96/w1] isError=false :: wrote 34 bytes to child-pwned.txt
 *     CHILD WROTE FILE: true  "written by a chat session's child"
 *
 * ONE off-list call converted a no-hands session into a full-toolset, recursively spawn-capable
 * agent rooted at the chat session's cwd ($HOME in the real app). The fix adds an `offered(name)`
 * predicate (the same two filters `specs()` already applies) to all three gates, so an off-list
 * name simply falls through to the per-call loop and hits the `executeCall` guard 77ee7857 already
 * added — no new rejection path, no approval card, no side effect.
 *
 * `session_spawn` is NOT one of the three: its bridge is `meta.mode === "dispatch"`-gated, so a
 * chat session already falls through to `executeCall`. Pinned as a regression at the bottom.
 */

/** mkdtemp + git init + an initial commit so HEAD exists — the worktree bridge needs a REAL repo to
 *  be able to succeed, which is exactly what makes its RED failure a genuine side effect (a chat
 *  session creating a git worktree) rather than a git error message. Mirrors engine-worktree.test
 *  .ts's own `repo()` helper; duplicated rather than imported so this file doesn't re-register that
 *  file's whole describe block. */
function gitRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "norma-cm-bridge-repo-")));
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);
  git(["init"]);
  git(["config", "user.email", "test@norma.dev"]);
  git(["config", "user.name", "Norma Test"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  return dir;
}

/** Records every `launch()` the Workflow bridge makes. Duck-typed rather than a real
 *  WorkflowRuntime: the bridge's background path (`run_in_background` defaulting to true) calls
 *  `launch()` and returns immediately, so a real sandboxed-subprocess runtime would add a process
 *  spawn and prove nothing extra — what's under test is whether the bridge is REACHED at all. */
function stubWorkflows(): { runtime: WorkflowRuntime; launches: string[] } {
  const launches: string[] = [];
  const runtime = {
    launch: (l: { sessionId: string; source: string }) => { launches.push(l.source); return "wfrun_stub"; },
    await: async () => ({ runId: "wfrun_stub", sessionId: "", status: "completed", result: "" }),
    takeForNotification: () => undefined,
    list: () => [],
    get: () => undefined,
    stop: () => false,
  } as unknown as WorkflowRuntime;
  return { runtime, launches };
}

/**
 * A chat/code/dispatch session with ALL THREE bridges wired for real — subagents+agents (the spawn
 * gather), a WorktreeManager over a real git repo (isWorktree), and a launch-recording workflow
 * runtime (isWorkflowLaunch). Deliberately a separate harness from chat-mode-allowlist.test.ts's
 * `setup()` (which wires none of the three and therefore could never have caught this).
 *
 * `toolSearch` matches that file's production shape by DEFAULT: the config OBJECT present, its
 * `enabled` getter resolving `undefined` — exactly daemon.ts's real
 * `projectSettings.effective(...)?.toolSearch?.enabled` when the user never touched the setting.
 * NOT `{ enabled: () => true }`; that shape is precisely why the original leak hid from the suite.
 * Tests that need the deferral guard OUT of the way (see their own comments) pass
 * `toolSearchEnabled: false` — also a real production value (`settings.toolSearch.enabled: false`),
 * not a test-only contrivance.
 */
function setup(
  script: ProviderEvent[][],
  opts: {
    mode?: "code" | "dispatch" | "chat";
    approvalPolicy?: SessionApprovalPolicy;
    /** undefined (default) = the production UNTOUCHED-setting shape; `false` = the user turned
     *  ToolSearch off in settings.json. Never `true` — see this harness's own doc comment. */
    toolSearchEnabled?: false;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "norma-cm-bridge-home-"));
  const cwd = gitRepo();
  const store = new SessionStore(home);
  const hub = new SessionHub(store);

  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerAskUserTool(registry);
  registerBashTool(registry);
  registerSpawnAgentTool(registry);
  registerToolSearchTool(registry);
  // daemon.ts's own registration shapes, verbatim: spawn_agent is NOT deferred; the worktree tools
  // and Workflow ARE (`{ deferred: true }`). That asymmetry is load-bearing for which of the three
  // sites is reachable under which settings — see each test's own comment.
  registerWorktreeTools(registry, { deferred: true });
  registerWorkflowTool(registry, { deferred: true });

  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  // Live roots off store.meta(sid).cwd — daemon.ts's real wiring (and what makes a same-turn
  // worktree switch visible to the next call), mirroring engine-worktree.test.ts's own dirs.
  const dirs = new SessionDirectories((sid) => {
    const m = store.meta(sid);
    return m.cwd ? [m.cwd] : [];
  });

  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-cm-bridge-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });

  const agentsHome = mkdtempSync(join(tmpdir(), "norma-cm-bridge-agents-"));
  const agentsTrust = new TrustStore(join(agentsHome, "trust.json"));
  const agents = new AgentStore({ normaHome: agentsHome, trust: agentsTrust });
  const subagents = new SubagentManager();
  const worktrees = new WorktreeManager({ baseRef: () => "head" });
  const { runtime: workflows, launches: workflowLaunches } = stubWorkflows();

  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs, assembler, compactor,
    agents, subagents, worktrees, workflows,
    approvalTimeoutMs: 500, // a RED run must fail fast, not sit on the default approval window
    toolSearch: { enabled: () => (opts.toolSearchEnabled === false ? false : undefined) },
  });

  const sessionId = store.createSession("global", {
    cwd, approvalPolicy: opts.approvalPolicy ?? "auto", mode: opts.mode,
  });
  const events: SessionEvent[] = [];
  hub.attach({
    clientName: "test-observer",
    // Auto-APPROVES every card. A post-fix run never emits one (asserted directly); pre-fix this is
    // what lets the leak complete instead of hanging on the broker — so a RED failure is the real
    // side effect, not a timeout.
    deliver: (e) => {
      events.push(e);
      if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver");
      return true;
    },
  }, sessionId, 0);

  return { engine, store, sessionId, provider, cwd, events, worktrees, workflowLaunches };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];
const call = (callId: string, name: string, args: unknown): ProviderEvent[] =>
  [{ type: "tool_call", callId, name, argsJson: JSON.stringify(args) }, done("tool_calls")];

function toolResultFor(events: SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> {
  const e = events.find((e) => e.type === "tool_result" && e.callId === callId);
  if (!e || e.type !== "tool_result") throw new Error(`expected a tool_result for ${callId}`);
  return e;
}
/** Every distinct tool NAME the provider was offered across all rounds of the turn, deduped+sorted
 *  — the direct analogue of the reviewer's own "MAIN tools / CHILD tools" probe printout. A CHILD
 *  thread materialising is instantly visible here as names outside the parent's allowlist. */
function allOfferedTools(provider: FakeProvider): string[] {
  return [...new Set(provider.requests.flatMap((r) => (r.tools ?? []).map((t) => t.name)))].sort();
}

describe("CM closing review: bridged calls obey the thread's toolset (the fourth seam)", () => {
  test("RED (the reviewer's own probe): a chat session's off-list `spawn_agent` never reaches the spawn bridge — no child thread, no child toolset, nothing on disk", async () => {
    // Production-shaped deferral (`enabled` resolving undefined). spawn_agent is registered
    // NON-deferred by daemon.ts, so the dispatch loop's deferred-builtin guard has nothing to say
    // about it — this site is reachable under the DEFAULT settings, exactly as the reviewer proved.
    const { engine, sessionId, provider, cwd, events } = setup(
      [
        call("sp1", "spawn_agent", { prompt: "write a file", description: "pwn", run_in_background: false }),
        // Round 1 is the CHILD's own round if (and only if) the bridge fired. With the fix there is
        // no child, so the MAIN thread consumes this round instead — and its own off-list `write`
        // is refused by 77ee7857's executeCall guard, so the file still never lands either way this
        // round is read. FakeProvider repeats its LAST entry once exhausted, so a longer pre-fix
        // trace (child round + child end_turn + main continuation) is covered by the tail below.
        call("w1", "write", { path: "child-pwned.txt", content: "written by a chat session's child" }),
        text("ok"),
      ],
      { mode: "chat" },
    );

    await engine.runTurn(sessionId);

    expect(CHAT_ALLOW_TOOLS.has("spawn_agent")).toBe(false); // sanity: the premise is real
    // (1) The ground truth: nothing was written, at any depth.
    expect(existsSync(join(cwd, "child-pwned.txt"))).toBe(false);
    // (2) No child thread ever materialised — the bridge is what emits thread_started.
    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    // (3) The child TOOLSET never materialised: every provider round in this turn was offered
    //     exactly CHAT_ALLOW_TOOLS. Pre-fix this array also contained
    //     read/ls/glob/grep/write/edit/spawn_agent/... — the reviewer's "CHILD tools:" line.
    expect(allOfferedTools(provider)).toEqual(["ask_user"]);
    // (4) The call was refused by the SAME executeCall guard 77ee7857 already added — no new
    //     rejection path, and no approval card on the way there.
    const result = toolResultFor(events, "sp1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("tool spawn_agent is not available in this session");
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });

  test("RED: a chat session's off-list `enter_worktree` never reaches the worktree bridge — no git worktree, no cwd switch", async () => {
    // `toolSearchEnabled: false` — a real settings value (`settings.toolSearch.enabled: false`).
    // The worktree tools are registered `deferred: true`, so with deferral ON the dispatch loop's
    // deferred-builtin guard would reject an unloaded enter_worktree BEFORE `isWorktree` and mask
    // the bypass. Turning ToolSearch off is exactly the supported configuration in which this site
    // IS reachable, so that is where the regression must be pinned.
    const { engine, store, sessionId, cwd, events, worktrees, provider } = setup(
      [call("e1", "enter_worktree", { name: "feat" }), text("ok")],
      { mode: "chat", toolSearchEnabled: false },
    );

    await engine.runTurn(sessionId);

    expect(CHAT_ALLOW_TOOLS.has("enter_worktree")).toBe(false); // sanity
    expect(events.some((e) => e.type === "worktree_entered")).toBe(false);
    expect(worktrees.active(sessionId)).toBeUndefined();
    expect(store.meta(sessionId).cwd).toBe(cwd); // the bridge's setCwd never ran
    expect(allOfferedTools(provider)).toEqual(["ask_user"]);
    const result = toolResultFor(events, "e1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("tool enter_worktree is not available in this session");
  });

  test("RED: a chat session's off-list `Workflow` never reaches the launch bridge — no run launched, and no approval card asking the user to allow one", async () => {
    // Same `toolSearchEnabled: false` rationale as the worktree test above (Workflow is registered
    // `deferred: true` too). Note the pre-fix failure mode here is BOTH halves of the finding: the
    // gate cards a Workflow launch under `auto` (gate.ts's bespoke case), so a no-hands chat session
    // would first show the human a card offering to launch an unbounded background agent swarm, and
    // then — on approval — actually launch it.
    const { engine, sessionId, events, workflowLaunches, provider } = setup(
      [call("wf1", "Workflow", { script: "export default async () => 'pwned';", name: "pwn" }), text("ok")],
      { mode: "chat", toolSearchEnabled: false },
    );

    await engine.runTurn(sessionId);

    expect(CHAT_ALLOW_TOOLS.has("Workflow")).toBe(false); // sanity
    expect(workflowLaunches).toEqual([]);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(allOfferedTools(provider)).toEqual(["ask_user"]);
    const result = toolResultFor(events, "wf1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("tool Workflow is not available in this session");
  });

  test("an off-list call is refused BEFORE the human is ever asked — a chat session under `ask` policy gets no approval card for a `bash` it doesn't have", async () => {
    // The reviewer's acceptance criterion was "no new rejection path, no approval card, no side
    // effect". The prescribed bridge gating alone does NOT deliver the middle one: an off-list name
    // that falls through to the per-call loop still meets `gate.evaluate` and every approval branch
    // before `executeCall` at the far end. Under `ask` an off-list `bash` therefore carded — showing
    // the user of a "no access to this machine" session a "run this command?" prompt, and refusing it
    // only after they said yes. Hence the loop-level `!offered` rejection, sited before
    // `gate.evaluate`. This test is that guard's reason to exist.
    // (`bash`, not `write`: SP-policies Task 7 makes an IN-PROJECT write silent under `ask`, so a
    // write here would assert nothing — it never carded in the first place.)
    const { engine, sessionId, events } = setup(
      [call("b1", "bash", { command: "echo hi" }), text("ok")],
      { mode: "chat", approvalPolicy: "ask" },
    );
    await engine.runTurn(sessionId);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(toolResultFor(events, "b1").output).toBe("tool bash is not available in this session");
  });

  test("a tool that is BOTH off-list and deferred-unloaded keeps the deferral message — the new guard sits after the deferred-builtin guard, not before it", async () => {
    // Ordering pin. `enter_worktree` is registered `deferred: true` (daemon.ts) and chat can never
    // load it, so with deferral ON the pre-existing "load its schema via ToolSearch first" answer
    // must still win; moving the new guard above that one would silently rewrite this message (and
    // break chat-mode-allowlist.test.ts's `lsp` assertion the same way).
    const { engine, sessionId, events, worktrees } = setup(
      [call("e1", "enter_worktree", { name: "feat" }), text("ok")],
      { mode: "chat" }, // production-shaped deferral: ON
    );
    await engine.runTurn(sessionId);
    expect(toolResultFor(events, "e1").output).toBe("tool enter_worktree is deferred — load its schema via ToolSearch first");
    expect(worktrees.active(sessionId)).toBeUndefined(); // either way, the bridge never ran
  });

  test("session_spawn is NOT part of this fix and must not become part of it: its bridge is already mode-gated, so chat falls through to the same executeCall rejection", async () => {
    // Regression pin for the ONE bridge the fix deliberately leaves alone (`dispatchReg` is
    // `meta.mode === "dispatch" ? cfg.dispatch?.() : undefined`, and this harness wires no
    // cfg.dispatch at all) — proof that "the bridge list" was enumerated, not guessed at.
    const { engine, sessionId, events } = setup(
      [call("ss1", "session_spawn", { dir: "/tmp", prompt: "hi" }), text("ok")],
      { mode: "chat", toolSearchEnabled: false },
    );
    await engine.runTurn(sessionId);
    const result = toolResultFor(events, "ss1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("tool session_spawn is not available in this session");
  });
});

describe("CM closing review: the offered() gate does not narrow code or dispatch", () => {
  test("a CODE session still spawns a real child through the bridge, and the child gets its full toolset", async () => {
    // The load-bearing no-regression proof for site 1: `excludeTools` for a code session is
    // {session_spawn} (+Workflow when gated off) and never spawn_agent, so `offered("spawn_agent")`
    // is true and the gather is byte-identical to before.
    const { engine, sessionId, provider, cwd, events } = setup(
      [
        call("sp1", "spawn_agent", { prompt: "write a file", description: "child", run_in_background: false }),
        call("w1", "write", { path: "child-wrote.txt", content: "hello from the child" }),
        text("child done"),
        text("main done"),
      ],
      { mode: "code" },
    );

    await engine.runTurn(sessionId);

    const started = events.filter((e) => e.type === "thread_started");
    expect(started.length).toBe(1);
    expect(existsSync(join(cwd, "child-wrote.txt"))).toBe(true);
    const result = toolResultFor(events, "sp1");
    expect(result.isError).toBe(false);
    // The child's own round really was offered write/spawn_agent — i.e. this test would notice if
    // the new gate accidentally narrowed a code child's toolset.
    const offered = allOfferedTools(provider);
    expect(offered).toContain("write");
    expect(offered).toContain("spawn_agent");
  });

  test("a CODE session's enter_worktree still reaches the bridge and creates a real worktree", async () => {
    const { engine, store, sessionId, cwd, events, worktrees } = setup(
      [call("e1", "enter_worktree", { name: "feat" }), text("ok")],
      { mode: "code", toolSearchEnabled: false },
    );
    await engine.runTurn(sessionId);
    const entered = events.find((e) => e.type === "worktree_entered");
    expect(entered).toMatchObject({ name: "feat", branch: "norma/feat" });
    expect(worktrees.active(sessionId)).toBeDefined();
    expect(store.meta(sessionId).cwd).not.toBe(cwd);
    expect(toolResultFor(events, "e1").isError).toBe(false);
  });

  test("a CODE session's Workflow launch still reaches the bridge — the human card fires and an approval really launches the run", async () => {
    // Point 3 of the controller's verification list, proved rather than assumed: the launch card is
    // NOT a thing that happens while Workflow is excluded. Workflow IS offered to a plain code
    // session (workflowToolAllowed holds), `offered("Workflow")` is therefore true, and the whole
    // ask→card→onApprove→launch chain is untouched.
    const { engine, sessionId, events, workflowLaunches } = setup(
      [call("wf1", "Workflow", { script: "export default async () => 'ok';", name: "run" }), text("ok")],
      { mode: "code", toolSearchEnabled: false },
    );
    await engine.runTurn(sessionId);
    expect(events.some((e) => e.type === "approval_requested")).toBe(true); // the launch gate's card
    expect(workflowLaunches).toEqual(["export default async () => 'ok';"]); // and the approval launched it
    expect(toolResultFor(events, "wf1").isError).toBe(false);
  });

  test("dispatch orchestrates via session_spawn, which the gate cannot touch — and the three bridged names were never in DISPATCH_ALLOW_TOOLS to begin with", () => {
    // Point 1 of the controller's verification list, as a literal assertion rather than prose: for a
    // dispatch session the three gated sites are a TIGHTENING of calls the provider is never offered,
    // and its actual orchestration verb is untouched (session_spawn is on the allowlist AND is
    // separately mode-gated, so `offered()` is true for it and its bridge is unaffected).
    expect(DISPATCH_ALLOW_TOOLS.has("session_spawn")).toBe(true);
    for (const n of ["spawn_agent", "enter_worktree", "exit_worktree", "Workflow"]) {
      expect(DISPATCH_ALLOW_TOOLS.has(n)).toBe(false);
    }
  });
});
