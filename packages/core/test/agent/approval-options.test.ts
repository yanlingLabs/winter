import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerWorktreeTools } from "../../src/agent/tools/worktree";
import { WorktreeManager } from "../../src/agent/worktree";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { suggestBashPrefix } from "../../src/agent/engine";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, bashTurn, writeTurn, stubReviewer } from "./engine-reviewer.test";
import { repo } from "./engine-worktree.test";

// SP-approvals Task 5: approval cards now offer "always allow" OPTIONS alongside the plain
// approve/deny choice. `suggestBashPrefix` is exported and unit-tested directly below;
// `approvalOptionsFor` (engine.ts) stays PRIVATE and is exercised only indirectly, by driving the
// real dispatch loop and reading the emitted `approval_requested` event / the broker's `list()` —
// same "drive the real loop, don't unit-test internals in isolation" precedent
// permission-gate-order.test.ts's own doc comment states for this exact feature area.

const isMac = process.platform === "darwin";

describe("suggestBashPrefix", () => {
  test("a single-word command → the command itself", () => {
    expect(suggestBashPrefix("ls -la")).toBe("ls");
  });

  test("a known multi-word head → first two tokens", () => {
    expect(suggestBashPrefix("git push origin")).toBe("git push");
  });

  test.each(["git", "npm", "pnpm", "cargo", "docker", "kubectl", "brew", "bun", "swift", "xcodebuild", "gh", "make"])(
    "%s is a recognized multi-word head",
    (head) => {
      expect(suggestBashPrefix(`${head} sometarget --flag`)).toBe(`${head} sometarget`);
    },
  );

  test("a known multi-word head with NO second token stays just the head", () => {
    expect(suggestBashPrefix("git")).toBe("git");
  });

  test("an unrecognized head stays single-word even with arguments", () => {
    expect(suggestBashPrefix("curl https://example.com")).toBe("curl");
  });

  test("whitespace-normalized: irregular/extra spacing collapses the same as single spaces", () => {
    expect(suggestBashPrefix("  git    push   origin  ")).toBe("git push");
    expect(suggestBashPrefix("\tnpm\n\ninstall\tfoo")).toBe("npm install");
  });

  test("empty or whitespace-only command → empty string (never throws)", () => {
    expect(suggestBashPrefix("")).toBe("");
    expect(suggestBashPrefix("   ")).toBe("");
  });
});

function tmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// Same auto-approve/deny hub-watcher idiom as permission-gate-order.test.ts's own (unexported)
// `approver` helper — duplicated here rather than imported, same "small per-file test helper"
// precedent already used throughout this package (e.g. remote-role.test.ts's own TestClient
// copy). `onDeliver`, when supplied, runs BEFORE `broker.resolve()` — letting a test snapshot
// `broker.list(sessionId)` at the exact moment the card is live, proving T4's wait-meta → list()
// passthrough carries `options` too, not just the emitted event.
function autoResolver(
  broker: { resolve: (sessionId: string, callId: string, approved: boolean, by: string) => void; list: (sessionId: string) => Array<{ callId: string; options?: unknown }> },
  sessionId: string,
  approved: boolean,
  onDeliver?: (e: { callId: string }) => void,
): HubClient {
  return {
    clientName: approved ? "auto-approver" : "auto-denier",
    deliver(e) {
      if (e.type === "approval_requested") {
        onDeliver?.(e);
        broker.resolve(sessionId, e.callId, approved, approved ? "auto-approver" : "auto-denier");
      }
      return true;
    },
  };
}

function editTurn(path: string, oldString: string, newString: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "edit", argsJson: JSON.stringify({ path, old_string: oldString, new_string: newString }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

// A stub `computer` tool (not the real ComputerUseService-backed one) purely to exercise the
// gate/options interplay for a tool name OTHER than bash/write/edit — mirrors
// permission-gate-order.test.ts's own (unexported) `stubComputerRegistry`.
function stubComputerRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "computer",
    description: "stub computer",
    args: z.object({ action: z.string() }),
    run({ action }) { return `did: ${action}`; },
  });
  return registry;
}

function computerTurn(action: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "computer", argsJson: JSON.stringify({ action }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

describe("approvalOptionsFor via the real dispatch loop (engine.ts's private helper, exercised indirectly)", () => {
  test("bash under plain ask → allow_once/allow_project/allow_global/deny; labels show the exact rule string; broker.list() carries the SAME options", async () => {
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("git push origin main"));
    const { engine, events, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
    let listedAtRequestTime: any;
    hub.attach(autoResolver(broker, sessionId, true, (e) => {
      listedAtRequestTime = broker.list(sessionId).find((p) => p.callId === e.callId);
    }), sessionId, 0);

    await engine.runTurn(sessionId);

    const rule = "Bash(git push:*)";
    const expected = [
      { id: "allow_once", label: "Allow once" },
      { id: "allow_project", label: `Allow "${rule}" in this project`, rule, scope: "project" },
      { id: "allow_global", label: `Allow "${rule}" everywhere`, rule, scope: "global" },
      { id: "deny", label: "Deny" },
    ];
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested.options).toEqual(expected);
    expect(listedAtRequestTime.options).toEqual(expected); // T4's wait-meta -> list() passthrough
    expect(calls.length).toBe(1); // approved → ran
  });

  test("bash with a single-word command → the rule uses just that word (no phantom second token)", async () => {
    const { registry } = stubRegistry();
    const provider = new FakeProvider(bashTurn("pwd"));
    const { engine, events, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
    hub.attach(autoResolver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested.options.find((o: any) => o.id === "allow_project")).toEqual({
      id: "allow_project", label: 'Allow "Bash(pwd:*)" in this project', rule: "Bash(pwd:*)", scope: "project",
    });
  });

  // SP-policies Task 7 RETIRED the generic write/edit options card. `approvalOptionsFor` no longer
  // has a write/edit branch, AND an in-root write/edit under `ask` is silenced by the
  // in-project-silent flip before it could ever reach the generic `decision === "ask"` card (this
  // helper's only caller) — so an in-root edit produces NO card of any kind. The old
  // allow_once/allow_project(Edit)/deny options card is gone; the "persist an Edit rule from a
  // write card" capability moves to the OUT-OF-ROOT grant card's path-scoped "Always allow edits in
  // /foo" = `Edit(/foo)` option (Task 9). These two tests pin that retirement (not just delete the
  // old coverage); the out-of-root grant card's own no-options shape is pinned by "an out-of-root
  // write's grant-flavored card gets no options" further below.
  test("write under plain (in-root) ask → NO generic options card at all (SP-policies Task 7: retired; in-root edits are silent)", async () => {
    const provider = new FakeProvider(writeTurn("notes.txt", "hi"));
    const { engine, events, sessionId, cwd } = setupEngine(provider, { policy: "ask" });

    await engine.runTurn(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card — not the old options card, not any card
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("hi"); // silently ALLOWED (in-project-silent), not denied
  });

  test("edit under plain (in-root) ask → NO generic options card either (same retirement as write)", async () => {
    const cwd = tmpDir("norma-approval-opts-edit-");
    writeFileSync(join(cwd, "notes.txt"), "hello world");
    const provider = new FakeProvider(editTurn("notes.txt", "world", "there"));
    const { engine, events, sessionId } = setupEngine(provider, { policy: "ask", cwd });

    await engine.runTurn(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("hello there"); // silently ALLOWED, not denied
  });

  test("every other tool (e.g. computer) → NO options, even under plain ask", async () => {
    const registry = stubComputerRegistry();
    const provider = new FakeProvider(computerTurn("screenshot"));
    const { engine, events, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask" });
    hub.attach(autoResolver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.options).toBeUndefined();
  });
});

describe("requestApproval call sites: reviewer-escalation + worktree pass NO options; the out-of-project grant card carries its OWN (SP-policies Task 9, +Task 6.5's 4th option)", () => {
  // SP-policies Task 9 retitled this: the out-of-project grant card USED to be a fourth "no options"
  // site, but it now carries edit options of its own (Allow once / Allow and add as working
  // directory / Always allow edits in <dir> = Edit(<dir>) scope project / Deny) — a DIFFERENT shape
  // from approvalOptionsFor's bash options (that helper is never even consulted for the grant card,
  // which builds its options inline). working-directories Task 6.5 added `allow_add_dir` as a THIRD
  // choice beside the honest one-shot default (`allow_once`), additive and in-place — the other
  // three ids/labels/order are byte-identical to before. The full behavior (one-shot write, rule
  // persistence, silence-on-repeat, `allow_add_dir` adoption) lives in
  // policy-out-of-project-edit.test.ts / engine-dirs-fence.test.ts; here we just pin the card's
  // option SHAPE at this seam.
  test("an out-of-project write's grant-flavored card carries the four with-dirs options, in order (not approvalOptionsFor's bash shape, not the old no-options card)", async () => {
    const outsideDir = tmpDir("norma-approval-opts-oor-");
    const target = join(outsideDir, "f.txt");
    const provider = new FakeProvider(writeTurn(target, "x"));
    const { engine, events, hub, broker, sessionId } = setupEngine(provider, { policy: "ask" });
    hub.attach(autoResolver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested.summary).toContain("outside your project"); // proves this rode the grant seam, not the plain-ask one
    expect(requested.options).toEqual([
      { id: "allow_once", label: "Allow once" },
      { id: "allow_add_dir", label: "Allow and add as working directory" },
      { id: "allow_project", label: `Always allow edits in ${outsideDir}`, rule: `Edit(${outsideDir})`, scope: "project" },
      { id: "deny", label: "Deny" },
    ]);
    expect(readFileSync(target, "utf8")).toBe("x"); // approved → one-shot write landed
  });

  test("a reviewer-escalation card (non-safe verdict) gets no options", async () => {
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_NO_OPTIONS" });
    const provider = new FakeProvider(bashTurn("rm -rf x"));
    const { engine, events, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any });
    hub.attach(autoResolver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.reviewerReason).toBe("REASON_NO_OPTIONS"); // confirms this really is the escalation card
    expect(requested.options).toBeUndefined();
    expect(calls.length).toBe(1); // approved → ran
  });

  describe.if(isMac)("worktree card", () => {
    test("enter_worktree under plain ask gets no options", async () => {
      const cwd = repo();
      const registry = new ToolRegistry();
      registerWorktreeTools(registry);
      const worktrees = new WorktreeManager({ baseRef: () => "head" });
      const provider = new FakeProvider([
        [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, { type: "done", stopReason: "tool_calls" }],
        [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
      ]);
      const { engine, events, hub, broker, sessionId } = setupEngine(provider, { registry, cwd, policy: "ask", worktrees });
      hub.attach(autoResolver(broker, sessionId, true), sessionId, 0);

      await engine.runTurn(sessionId);

      const requested = events.find((e) => e.type === "approval_requested") as any;
      expect(requested).toBeDefined();
      expect(requested.options).toBeUndefined();
      expect(events.some((e) => e.type === "worktree_entered")).toBe(true); // approved → bridge ran
    });
  });
});
