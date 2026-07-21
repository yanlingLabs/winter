import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HubClient } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { PermissionRules } from "../../src/agent/permission-rules";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, bashTurn, writeTurn, stubReviewer } from "./engine-reviewer.test";

// SP-approvals Task 3: the engine's dispatch loop now consults Task 1's PermissionRules and Task
// 2's readOnlyBash BEFORE carding an `ask`-policy call — this is the piece that stops an ask-policy
// session from re-prompting forever for a call a standing rule (or a provably read-only bash
// command) already covers. Every test below drives the REAL dispatch loop (setupEngine's harness,
// same one engine-reviewer.test.ts uses) rather than calling PermissionRules/readOnlyBash in
// isolation (already covered by their own unit suites) — the point here is the WIRING and its
// security invariants: rules are consulted ONLY on `ask`, NEVER on `deny` (plan mode), NEVER ahead
// of an out-of-root write's own grant card, and NEVER in a way that lets the AI safety reviewer be
// skipped for bash once a rule/classifier allows it.

function tmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// A stub `computer` tool (NOT the real ComputerUseService-backed one — see engine-computer.test.ts
// for that harness): records every invocation so a test can assert whether it actually ran. This
// suite only cares about the gate/rule interplay for the `computer` tool name (CC-parity default
// allow-rule, scenario 3), never computer-use itself.
function stubComputerRegistry(): { registry: ToolRegistry; calls: Array<{ action: string }> } {
  const registry = new ToolRegistry();
  const calls: Array<{ action: string }> = [];
  registry.register({
    name: "computer",
    description: "stub computer",
    args: z.object({ action: z.string() }),
    run({ action }) {
      calls.push({ action });
      return `did: ${action}`;
    },
  });
  return { registry, calls };
}

// One round: model calls computer(action) then stops with tool_calls; round 2 ends the turn.
function computerTurn(action: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "computer", argsJson: JSON.stringify({ action }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

// An approval-card watcher that always approves — used where the test WANTS the card to appear
// and resolve cleanly (rather than time out), mirroring engine-reviewer.test.ts's own "auto-approver"/
// "auto-denier" watcher idiom.
function approver(broker: { resolve: (sessionId: string, callId: string, approved: boolean, by: string) => void }, sessionId: string, approved: boolean): HubClient {
  return {
    clientName: approved ? "auto-approver" : "auto-denier",
    deliver(e) {
      if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, approved, approved ? "auto-approver" : "auto-denier");
      return true;
    },
  };
}

describe("scenario 1: a project rule allows a bash call outright — no card", () => {
  test("Bash(git status:*) project rule + `git status` under ask → runs, NO approval_requested", async () => {
    const cwd = tmpDir("norma-pgo-cwd-");
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "permissions.local.json"), JSON.stringify({ allow: ["Bash(git status:*)"] }));
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("git status"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([{ command: "git status", justification: undefined }]);
  });
});

describe("scenario 2: readOnlyBash classifier — read-only runs silently, non-read-only still cards", () => {
  test("no rule anywhere, `cat f` (read-only) under ask → runs, NO approval_requested", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("cat f"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([{ command: "cat f", justification: undefined }]);
  });

  test("no rule anywhere, `git push` (NOT read-only) under ask → card still appears (unchanged)", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("git push"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });
    hub.attach(approver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(calls.length).toBe(1); // approved → ran
  });
});

describe("scenario 3: `computer` CC-parity default lives in the daemon getter fallback, not PermissionRules itself", () => {
  test("globalAllow resolves to the [\"Computer\"] default (simulating settings.permissions.allow absent) → no card", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Computer"], normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubComputerRegistry();
    const provider = new FakeProvider(computerTurn("screenshot"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([{ action: "screenshot" }]);
  });

  test("globalAllow resolves to [] (simulating explicit settings \"allow\": []) → card returns", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubComputerRegistry();
    const provider = new FakeProvider(computerTurn("screenshot"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", permissionRules });
    hub.attach(approver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(calls.length).toBe(1); // approved → ran
  });
});

describe("scenario 4: an Edit rule covers an IN-ROOT target only — an out-of-root target still needs its own grant card", () => {
  test("Edit rule (any) + in-root write target under ask → no card, write lands", async () => {
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn("notes.txt", "hello"));
    const { engine, store, sessionId, cwd } = setupEngine(provider, { policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("hello");
  });

  test("the SAME Edit rule + an OUT-OF-ROOT write target under ask → the grant card still appears (rule does not bypass it)", async () => {
    const outsideDir = tmpDir("norma-pgo-oor-");
    const target = join(outsideDir, "f.txt");
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn(target, "should still need a grant"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { policy: "ask", permissionRules });
    hub.attach(approver(broker, sessionId, true), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    // The grant-flavored summary (engine.ts's dirGrant branch), NOT the generic approvalCardSummary
    // — proves this rode the SAME out-of-root grant seam a ruleless call would, not a rule-skip.
    expect(requested.summary).toContain("outside the allowed directories");
    expect(requested.summary).toContain(`grant write access to ${outsideDir}`);
    expect(readFileSync(target, "utf8")).toBe("should still need a grant"); // approved → grant applied → write landed
  });
});

describe("scenario 5: plan policy denies outright — a rule is never even consulted", () => {
  test("a Bash(any) global rule + plan policy → still denied, no card, bash never ran", async () => {
    // "git status" is BOTH rule-matched (Bash, kind "any") and readOnlyBash-classified true — if
    // either source were consulted despite the deny, this would flip to "allow"; asserting the
    // plan-mode denial text proves neither ever ran.
    const permissionRules = new PermissionRules({ globalAllow: () => ["Bash"], normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("git status"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "plan", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // deny is silent, not a card
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("plan mode");
    expect(calls.length).toBe(0);
  });
});

describe("scenario 6/7: a rule- or classifier-allowed bash call still rides the AI safety reviewer when configured", () => {
  test("6. rule-allowed (Bash(npm test:*)) + reviewer configured, unsafe verdict → escalation card appears DESPITE the matching rule", async () => {
    // "npm test" is rule-matched but NOT readOnlyBash-classified (npm's read-only subcommands are
    // only ls/view/outdated) — isolates the RULE as the sole source of ruleAllowed.
    const permissionRules = new PermissionRules({ globalAllow: () => ["Bash(npm test:*)"], normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "REASON_RULE_BASH" });
    const provider = new FakeProvider(bashTurn("npm test"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask", permissionRules });
    hub.attach(approver(broker, sessionId, false), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "bash", verdict: "unsafe", reason: "REASON_RULE_BASH" });
    const requested = events.find((e) => e.type === "approval_requested") as any;
    expect(requested).toBeDefined();
    expect(requested.reviewerReason).toBe("REASON_RULE_BASH");
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(calls.length).toBe(0); // never ran — reviewer said unsafe, human denied
    expect(reviewer.seen).toEqual([{ class: "bash", command: "npm test", justification: undefined }]);
  });

  test("7. classifier-allowed (`git log --oneline -5`, no rule at all) + reviewer configured, safe verdict → reviewer WAS consulted, bash ran", async () => {
    // No rule anywhere — readOnlyBash alone is what flips ruleAllowed here, isolating the
    // CLASSIFIER as the sole source (spec: both sources must ride the same reviewer branch).
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: tmpDir("norma-pgo-home-") });
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "safe", reason: "REASON_CLASSIFIER_BASH" });
    const provider = new FakeProvider(bashTurn("git log --oneline -5"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, reviewer: reviewer as any, policy: "ask", permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // safe verdict, no escalation
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "bash", verdict: "safe", reason: "REASON_CLASSIFIER_BASH" });
    expect(reviewer.seen.length).toBe(1); // the reviewer was genuinely consulted, not bypassed
    expect(calls).toEqual([{ command: "git log --oneline -5", justification: undefined }]);
  });
});

describe("scenario 8: the control-plane grant-denial hard error is unchanged — no rule can ever bypass it", () => {
  test("an allow-everything Edit rule + a write into the denied-prefix dir → still a hard error, no card, no grant", async () => {
    const runDir = tmpDir("norma-pgo-rundir-");
    const target = join(runDir, "core.sock.d", "evil.txt");
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit"], normaHome: tmpDir("norma-pgo-home-") });
    const provider = new FakeProvider(writeTurn(target, "x"));
    const { engine, store, sessionId, dirs } = setupEngine(provider, { policy: "ask", permissionRules, grantDeniedPrefixes: [runDir] });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card, even under ask
    expect(events.some((e) => e.type === "directory_added")).toBe(false);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/control plane/);
    expect(result.output).toMatch(/never be granted/);
    expect(existsSync(target)).toBe(false);
    expect(dirs.has(sessionId, runDir)).toBe(false);
  });
});
