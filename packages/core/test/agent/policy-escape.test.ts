import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../../src/agent/fake-provider";
import { PermissionRules } from "../../src/agent/permission-rules";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, stubReviewer } from "./engine-reviewer.test";

// SP-policies Task 11: the sandbox-escape (`dangerouslyDisableSandbox`) gate, reworked from
// SP-approvals' unconditional always-card floor into a mode split:
//   - a BashUnsandboxed(<prefix>:*) rule PRE-CLEARS the escape (silent, no reviewer) in every
//     non-plan mode (unsandboxedRuleAllowed, computed BEFORE the dont-ask deny flip);
//   - under `auto` with a reviewer the reviewer is the GATE (safe → runs unsandboxed unattended,
//     non-safe → escalates to the human card);
//   - under `ask`/`accept-edits` a human card fires, the reviewer only ANNOTATES it;
//   - the card offers [Allow once, Always allow "<rule>" in this project, ... everywhere, Deny]
//     with `<rule> = BashUnsandboxed(suggestBashPrefix(command):*)`.
// These drive the REAL dispatch loop (setupEngine), same idiom as permission-gate-order.test.ts's
// scenario 11 and policy-bypass-floors.test.ts. The stub bash tool (stubRegistry) records runs
// without a real sandbox; bypass/plan interactions live in policy-bypass-floors/permission-gate-
// order respectively — here we cover auto (reviewer gate), the rule pre-clear, ask (annotate), and
// the two dont-ask regressions (covered runs / uncovered denies).

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// One round: the model asks for a full sandbox escape (dangerouslyDisableSandbox:true) via bash,
// then stops with tool_calls; round 2 ends the turn. Untyped on purpose — it flows only through
// `provider(turns: any)` below, which launders it into FakeProvider (same runtime shape bashTurn
// produces).
const escTurn = (command: string) => [
  [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify({ command, dangerouslyDisableSandbox: true }) }, { type: "done", stopReason: "tool_calls" }],
  [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
];

function provider(turns: any) { return new FakeProvider(turns); }

describe("dangerouslyDisableSandbox floor (SP-policies Task 11)", () => {
  test("auto + reviewer 'safe' → runs unsandboxed, NO card (the reviewer is the gate)", async () => {
    const cwd = tmp("norma-esc-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-esc-home-") });
    const { registry, calls } = stubRegistry();
    const { reviewer, reviews } = stubReviewer("safe");
    const { engine, store, sessionId } = setupEngine(provider(escTurn("docker ps")), { registry, policy: "auto", cwd, permissionRules, reviewer: reviewer as any });
    await engine.runTurn(sessionId);
    expect(reviews.length).toBe(1);                                                              // reviewer consulted as the gate
    // exactly one tool_review, verdict safe
    const review = store.read(sessionId).find((e: any) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "bash", verdict: "safe" });
    expect(store.read(sessionId).some((e: any) => e.type === "approval_requested")).toBe(false); // no card
    expect(calls.length).toBe(1);                                                                // ran unsandboxed, unattended
  });

  test("auto + reviewer 'unsafe' → escalates to a human card with BashUnsandboxed rule options", async () => {
    const cwd = tmp("norma-esc2-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-esc2-home-") });
    const { registry } = stubRegistry();
    const { reviewer, reviews } = stubReviewer("unsafe");
    const { engine, store, sessionId } = setupEngine(provider(escTurn("docker ps")), { registry, policy: "auto", cwd, permissionRules, reviewer: reviewer as any });
    await engine.runTurn(sessionId);
    expect(reviews.length).toBe(1); // the reviewer gate ran and said unsafe → escalate
    const card = store.read(sessionId).find((e: any) => e.type === "approval_requested") as any;
    expect(card).toBeDefined();
    expect(card.summary).toBe("bash (UNSANDBOXED): docker ps");
    expect(card.reviewerReason).toBe("stub: unsafe"); // the gate verdict's reason threads into the card
    // suggestBashPrefix("docker ps") === "docker ps" (docker is a multi-word head), so the suggested
    // rule is BashUnsandboxed(docker ps:*) — NOT (docker:*). Both rule-bearing options carry it.
    const ruleOpt = card.options.find((o: any) => o.rule);
    expect(ruleOpt.rule).toBe("BashUnsandboxed(docker ps:*)");
    expect(card.options).toEqual([
      { id: "allow_once", label: "Allow once" },
      { id: "allow_unsandboxed_project", label: 'Always allow "BashUnsandboxed(docker ps:*)" in this project', rule: "BashUnsandboxed(docker ps:*)", scope: "project" },
      { id: "allow_unsandboxed_global", label: 'Always allow "BashUnsandboxed(docker ps:*)" everywhere', rule: "BashUnsandboxed(docker ps:*)", scope: "global" },
      { id: "deny", label: "Deny" },
    ]);
  });

  test("a BashUnsandboxed rule pre-clears the escape under ASK (no card, reviewer NOT consulted, runs)", async () => {
    const cwd = tmp("norma-esc3-");
    const permissionRules = new PermissionRules({ globalAllow: () => ["BashUnsandboxed(docker:*)"], normaHome: tmp("norma-esc3-home-") });
    const { registry, calls } = stubRegistry();
    const { reviewer, reviews } = stubReviewer("unsafe"); // would escalate if wrongly consulted — proves it is NOT
    const { engine, store, sessionId } = setupEngine(provider(escTurn("docker ps")), { registry, policy: "ask", cwd, permissionRules, reviewer: reviewer as any });
    await engine.runTurn(sessionId);
    expect(store.read(sessionId).some((e: any) => e.type === "approval_requested")).toBe(false);
    expect(reviews.length).toBe(0); // pre-cleared by the rule → the escape branch (and its reviewer) is skipped entirely
    expect(calls.length).toBe(1);   // ran unsandboxed
  });

  test("a BashUnsandboxed rule pre-clears the escape under AUTO too — no card, no reviewer (proves the ordinary bash reviewer excludes the escape)", async () => {
    const cwd = tmp("norma-esc-autocov-");
    const permissionRules = new PermissionRules({ globalAllow: () => ["BashUnsandboxed(docker:*)"], normaHome: tmp("norma-esc-autocov-home-") });
    const { registry, calls } = stubRegistry();
    const { reviewer, reviews } = stubReviewer("unsafe"); // would card if the ordinary bash reviewer branch wrongly ran it
    const { engine, store, sessionId } = setupEngine(provider(escTurn("docker ps")), { registry, policy: "auto", cwd, permissionRules, reviewer: reviewer as any });
    await engine.runTurn(sessionId);
    expect(store.read(sessionId).some((e: any) => e.type === "approval_requested")).toBe(false);
    expect(reviews.length).toBe(0); // pre-cleared → neither the escape branch NOR the ordinary bash reviewer (excluded by !dangerouslyDisableSandbox) runs
    expect(calls.length).toBe(1);   // ran unsandboxed, unattended
  });

  test("ask + no rule → human card even when the reviewer says 'safe' (annotation, not a gate)", async () => {
    const cwd = tmp("norma-esc4-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-esc4-home-") });
    const { registry } = stubRegistry();
    const { reviewer, reviews } = stubReviewer("safe"); // even 'safe' still cards under ask
    const { engine, store, sessionId } = setupEngine(provider(escTurn("docker ps")), { registry, policy: "ask", cwd, permissionRules, reviewer: reviewer as any });
    await engine.runTurn(sessionId);
    const card = store.read(sessionId).find((e: any) => e.type === "approval_requested") as any;
    expect(card).toBeDefined();                     // the card fired despite the safe verdict
    expect(reviews.length).toBe(1);                 // the reviewer ran, but only to annotate
    expect(card.reviewerReason).toBe("stub: safe"); // its reason annotates the card
    expect(card.options.find((o: any) => o.rule).rule).toBe("BashUnsandboxed(docker ps:*)");
  });

  test("regression: a BashUnsandboxed-covered escape under DONT-ASK runs silently (pre-clear beats the deny flip)", async () => {
    const cwd = tmp("norma-esc5-");
    const permissionRules = new PermissionRules({ globalAllow: () => ["BashUnsandboxed(docker:*)"], normaHome: tmp("norma-esc5-home-") });
    const { registry, calls } = stubRegistry();
    const { reviewer, reviews } = stubReviewer("unsafe");
    const { engine, store, sessionId } = setupEngine(provider(escTurn("docker ps")), { registry, policy: "dont-ask", cwd, permissionRules, reviewer: reviewer as any });
    await engine.runTurn(sessionId);
    expect(store.read(sessionId).some((e: any) => e.type === "approval_requested")).toBe(false);
    expect(reviews.length).toBe(0);
    expect(calls.length).toBe(1); // ran — unsandboxedRuleAllowed set decision="allow" BEFORE the dont-ask deny flip
  });

  test("regression: an uncovered escape under DONT-ASK is denied outright (no card, never runs)", async () => {
    const cwd = tmp("norma-esc6-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-esc6-home-") });
    const { registry, calls } = stubRegistry();
    const { engine, store, sessionId } = setupEngine(provider(escTurn("docker ps")), { registry, policy: "dont-ask", cwd, permissionRules });
    await engine.runTurn(sessionId);
    expect(store.read(sessionId).some((e: any) => e.type === "approval_requested")).toBe(false);
    const result = store.read(sessionId).find((e: any) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("dont-ask");
    expect(calls.length).toBe(0); // never ran — the dont-ask flip converted ask→deny (no BashUnsandboxed rule to pre-clear)
  });
});
