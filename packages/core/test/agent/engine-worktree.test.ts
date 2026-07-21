import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub, type HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { registerWorktreeTools } from "../../src/agent/tools/worktree";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { WorktreeManager } from "../../src/agent/worktree";
import { AgentEngine } from "../../src/agent/engine";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionDirectories } from "../../src/agent/dirs";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { ProviderEvent } from "../../src/providers/types";

const isMac = process.platform === "darwin";

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { code: p.exitCode ?? 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** mkdtemp + git init + an initial commit so HEAD exists. Mirrors worktree.test.ts's helper.
 *  Exported for reuse by permission-gate-order.test.ts (SP-approvals T3 follow-up, scenario 9) —
 *  same cross-test-file reuse precedent as engine-steer.test.ts's setupEngine / engine-reviewer
 *  .test.ts's stubRegistry/bashTurn/stubReviewer. */
export function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "norma-engine-wt-")));
  git(["init"], dir);
  git(["config", "user.email", "test@norma.dev"], dir);
  git(["config", "user.name", "Norma Test"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function setup(
  script: ProviderEvent[][],
  opts: { worktrees?: boolean; approvalPolicy?: "ask" | "auto" | "plan" } = {},
) {
  const withWorktrees = opts.worktrees !== false;
  const home = mkdtempSync(join(tmpdir(), "norma-engine-wt-home-"));
  const cwd = repo();
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerWriteTools(registry);
  registerWorktreeTools(registry);
  const worktrees = withWorktrees ? new WorktreeManager({ baseRef: () => "head" }) : undefined;
  const broker = new ApprovalBroker();
  const provider = new FakeProvider(script);
  // Mirrors daemon.ts's real wiring: roots are derived LIVE from store.meta(sid).cwd, so a
  // same-turn store.setCwd (the worktree bridge) is immediately visible to the next executeCall's
  // roots() — this is what makes a same-turn relative write land inside the worktree.
  const dirs = new SessionDirectories((sid) => {
    const m = store.meta(sid);
    return m.cwd ? [m.cwd] : [];
  });
  const assemblerHome = mkdtempSync(join(tmpdir(), "norma-engine-wt-actx-"));
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const assembler = new ContextAssembler({
    normaHome: assemblerHome,
    trust: assemblerTrust,
    skills: new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust }),
  });
  const compactor = new Compactor({ provider: { provider, model: "fake-1" }, store, hub });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "fake-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    worktrees,
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.approvalPolicy ?? "auto" });
  return { engine, store, hub, broker, sessionId, cwd, provider, dirs };
}

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, { type: "usage", inputTokens: 10, outputTokens: 2 }, done("end_turn")];

describe.if(isMac)("AgentEngine: worktree bridge (enter/exit_worktree)", () => {
  test("enter_worktree → worktree_entered emitted; same-turn write lands in the worktree, not the original repo", async () => {
    const { engine, store, sessionId, cwd } = setup([
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "scratch.txt", content: "x" }) }, done("tool_calls")],
      text("done"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const entered = events.find((e) => e.type === "worktree_entered");
    expect(entered).toMatchObject({ name: "feat", branch: "norma/feat" });
    const wtDir = (entered as any).path as string;
    expect(existsSync(wtDir)).toBe(true);

    const enterResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(enterResult).toMatchObject({ isError: false });
    expect((enterResult as any).output).toContain("Entered worktree feat");

    // store.setCwd was called with the worktree dir
    expect(store.meta(sessionId).cwd).toBe(wtDir);

    // SAME-TURN follow-up write lands in the worktree, not the original repo
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: false });
    expect(existsSync(join(wtDir, "scratch.txt"))).toBe(true);
    expect(existsSync(join(cwd, "scratch.txt"))).toBe(false);
  });

  test("exit_worktree {keep} → worktree_exited emitted; same-turn follow-up write lands back in the original repo", async () => {
    const { engine, store, sessionId, cwd } = setup([
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat2" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "x1", name: "exit_worktree", argsJson: JSON.stringify({ action: "keep" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "back.txt", content: "y" }) }, done("tool_calls")],
      text("done"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const entered = events.find((e) => e.type === "worktree_entered");
    const wtDir = (entered as any).path as string;

    const exited = events.find((e) => e.type === "worktree_exited");
    expect(exited).toMatchObject({ name: "feat2", action: "keep", removed: false });

    const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "x1");
    expect(exitResult).toMatchObject({ isError: false });
    expect((exitResult as any).output).toContain("kept");

    // store.setCwd reverted to the original repo
    expect(store.meta(sessionId).cwd).toBe(cwd);

    // SAME-TURN follow-up write lands back in the original repo, not the worktree
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: false });
    expect(existsSync(join(cwd, "back.txt"))).toBe(true);
    expect(existsSync(join(wtDir, "back.txt"))).toBe(false);
  });

  // Regression (S1, final review): exit_worktree {remove} deletes the worktree dir from disk.
  // Before the fix, that dir lingered in SessionDirectories' `added` set (no dirs.remove()
  // existed), and resolveWithinAny's `roots.map(realpathSync)` threw ENOENT for that one vanished
  // root — bricking EVERY subsequent fs tool call for the rest of the session, even ones against
  // the perfectly valid original repo. This pins that a same-turn follow-up write after
  // exit_worktree {remove} still succeeds.
  test("exit_worktree {remove} → worktree_exited emitted; same-turn follow-up write still succeeds (fs tools not bricked)", async () => {
    const { engine, store, sessionId, cwd } = setup([
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat5" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "x1", name: "exit_worktree", argsJson: JSON.stringify({ action: "remove" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "after-remove.txt", content: "z" }) }, done("tool_calls")],
      text("done"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const entered = events.find((e) => e.type === "worktree_entered");
    const wtDir = (entered as any).path as string;

    const exited = events.find((e) => e.type === "worktree_exited");
    expect(exited).toMatchObject({ name: "feat5", action: "remove", removed: true });
    expect(existsSync(wtDir)).toBe(false); // the worktree dir is really gone from disk

    const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "x1");
    expect(exitResult).toMatchObject({ isError: false });

    // store.setCwd reverted to the original repo
    expect(store.meta(sessionId).cwd).toBe(cwd);

    // THE FIX: a same-turn follow-up write against the ORIGINAL repo must succeed — not throw
    // ENOENT / come back as an fs error because a stale, now-deleted worktree root is still in
    // the session's allowed-roots list.
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: false });
    expect(existsSync(join(cwd, "after-remove.txt"))).toBe(true);
  });

  // 4g-ii (CC parity): exit_worktree {remove} on a dirty worktree, discard_changes threaded
  // through the engine's hand-parsed argsJson bridge (engine.ts's runWorktreeBridge) down to
  // WorktreeManager.exit()'s own pre-check (worktree.ts). Without discard_changes: true, the
  // manager throws BEFORE calling git worktree remove or deleting its own session entry — so the
  // worktree stays fully active (no worktree_exited event, no cwd revert) and the SAME session
  // can retry with discard_changes: true afterward.
  test("exit_worktree {remove} on a DIRTY worktree WITHOUT discard_changes → isError listing the dirty paths; worktree stays active", async () => {
    const { engine, store, sessionId } = setup([
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "featdirty1" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "dirty.txt", content: "uncommitted" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "x1", name: "exit_worktree", argsJson: JSON.stringify({ action: "remove" }) }, done("tool_calls")],
      text("done"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const entered = events.find((e) => e.type === "worktree_entered");
    const wtDir = (entered as any).path as string;

    expect(events.some((e) => e.type === "worktree_exited")).toBe(false); // the bridge never got past exit()'s pre-check

    const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "x1");
    expect(exitResult).toMatchObject({ isError: true });
    const output = (exitResult as any).output as string;
    expect(output).toContain("refusing to remove: uncommitted changes:");
    expect(output).toContain("dirty.txt");
    expect(output).toContain("re-run with discard_changes: true to delete them");

    // the worktree is still there and still the active cwd — the refusal didn't half-apply
    expect(existsSync(wtDir)).toBe(true);
    expect(store.meta(sessionId).cwd).toBe(wtDir);
  });

  test("exit_worktree {remove, discard_changes: true} on a DIRTY worktree → force-removed; worktree_exited emitted; cwd reverts", async () => {
    const { engine, store, sessionId, cwd } = setup([
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "featdirty2" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "dirty.txt", content: "uncommitted" }) }, done("tool_calls")],
      [{ type: "tool_call", callId: "x1", name: "exit_worktree", argsJson: JSON.stringify({ action: "remove", discard_changes: true }) }, done("tool_calls")],
      text("done"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const entered = events.find((e) => e.type === "worktree_entered");
    const wtDir = (entered as any).path as string;

    const exited = events.find((e) => e.type === "worktree_exited");
    expect(exited).toMatchObject({ name: "featdirty2", action: "remove", removed: true });
    expect(existsSync(wtDir)).toBe(false); // gone from disk despite the uncommitted change

    const exitResult = events.find((e) => e.type === "tool_result" && e.callId === "x1");
    expect(exitResult).toMatchObject({ isError: false });

    expect(store.meta(sessionId).cwd).toBe(cwd); // reverted to the original repo
  });

  test("cfg.worktrees absent → enter_worktree returns the placeholder (no event, no cwd change)", async () => {
    const { engine, store, sessionId, cwd } = setup(
      [
        [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, done("tool_calls")],
        text("ok"),
      ],
      { worktrees: false },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "worktree_entered")).toBe(false);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(result).toMatchObject({ isError: false });
    expect((result as any).output).toContain("worktree support is not available in this session");
    expect(store.meta(sessionId).cwd).toBe(cwd);
  });

  test("gate: enter_worktree under plan policy → deny (block message), no git op", async () => {
    const { engine, store, sessionId, cwd } = setup(
      [
        [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, done("tool_calls")],
        text("ok"),
      ],
      { approvalPolicy: "plan" },
    );
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(result).toMatchObject({ isError: true });
    expect((result as any).output).toContain("Blocked in plan mode");
    expect(events.some((e) => e.type === "worktree_entered")).toBe(false);
    expect(store.meta(sessionId).cwd).toBe(cwd);
  });

  // `ask` is the DEFAULT session policy, and enter_worktree/exit_worktree are MUTATING (gate.ts)
  // → under `ask`, gate.evaluate returns "ask", not "allow". Before the fix, the dispatch loop's
  // generic `decision === "ask"` branch ran FIRST and, on approval, called executeCall — which
  // resolves to the worktree tool's own PLACEHOLDER run() ("worktree support is not available"),
  // never the bridge (setCwd + git + same-turn cwd + worktree_entered). These two tests pin the
  // approved and denied halves of that path under `ask`.
  test("ask policy: enter_worktree APPROVED → the bridge runs (not the placeholder): worktree_entered emitted, same-turn write lands in the worktree", async () => {
    const { engine, store, hub, broker, sessionId, cwd } = setup(
      [
        [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat3" }) }, done("tool_calls")],
        [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "scratch.txt", content: "x" }) }, done("tool_calls")],
        text("done"),
      ],
      { approvalPolicy: "ask" },
    );
    // watcher approves the approval as soon as it sees it (sync — must be registered BEFORE the
    // emit; requestApproval's wait-before-emit ordering is what makes this not race/hang):
    const watcher: HubClient = {
      clientName: "auto-approver",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    // approval flow happened (this IS the `ask` path — not silently downgraded to auto)
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: true, by: "auto-approver" });

    // the BRIDGE ran, not the placeholder: worktree_entered was emitted
    const entered = events.find((e) => e.type === "worktree_entered");
    expect(entered).toMatchObject({ name: "feat3", branch: "norma/feat3" });
    const wtDir = (entered as any).path as string;
    expect(existsSync(wtDir)).toBe(true);

    const enterResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(enterResult).toMatchObject({ isError: false });
    expect((enterResult as any).output).toContain("Entered worktree feat3"); // NOT "worktree support is not available"

    // store.setCwd was called with the worktree dir
    expect(store.meta(sessionId).cwd).toBe(wtDir);

    // SAME-TURN follow-up write lands in the worktree, not the original repo
    const writeResult = events.find((e) => e.type === "tool_result" && e.callId === "w1");
    expect(writeResult).toMatchObject({ isError: false });
    expect(existsSync(join(wtDir, "scratch.txt"))).toBe(true);
    expect(existsSync(join(cwd, "scratch.txt"))).toBe(false);
  });

  test("ask policy: enter_worktree DENIED → denied outcome, no git op, no worktree_entered", async () => {
    const { engine, store, hub, broker, sessionId, cwd } = setup(
      [
        [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat4" }) }, done("tool_calls")],
        text("ok, not entering"),
      ],
      { approvalPolicy: "ask" },
    );
    const watcher: HubClient = {
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    };
    hub.attach(watcher, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "auto-denier" });
    expect(events.some((e) => e.type === "worktree_entered")).toBe(false);

    const enterResult = events.find((e) => e.type === "tool_result" && e.callId === "e1");
    expect(enterResult).toMatchObject({ isError: true });
    expect((enterResult as any).output).toMatch(/denied/);

    // no git op: cwd unchanged, no worktree dir created under cwd's parent side-effects
    expect(store.meta(sessionId).cwd).toBe(cwd);
  });
});
