import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { CoworkInstructions } from "../../src/cowork/instructions";
import { COWORK_GUEST_TOOL_CLASSES, COWORK_PATH_CLASSES, coworkConnectorVerdict, coworkHostDecision, type CoworkHostDecision } from "../../src/cowork/host-policy";
import * as transition from "../../src/cowork/policy-transition";
import { COWORK_CLASSIFIER_CELLS, COWORK_CLASSIFIER_CONNECTOR_CELLS, classifyCoworkPolicyChange, CoworkPolicyTransitionMachine, type CoworkDrainOutcome, type CoworkPolicyChangeKind,
  type CoworkPolicyState, type CoworkTransitionPlan, type CoworkTransitionPorts, type CoworkTransitionSnapshot } from "../../src/cowork/policy-transition";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkError, type CapabilityCeiling } from "../../src/cowork/types";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";

const POLICIES: readonly ApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];
const ceiling = (toolClasses: string[], network: "none" | "internet" = "none", hostServices: string[] = [], connectors: string[] = []): CapabilityCeiling => ({ toolClasses, hostServices, connectors, network });
const WIDE = ceiling(["read", "write", "execute"], "internet", ["workspace.instructions.update"], ["github"]);
const state = (policy: ApprovalPolicy, c: CapabilityCeiling = WIDE): CoworkPolicyState => ({ policy, ceiling: c });
const kind = (from: CoworkPolicyState, to: CoworkPolicyState): CoworkPolicyChangeKind => classifyCoworkPolicyChange(from, to);

// ── classifier ───────────────────────────────────────────────────────────────────────────────────────────────────

test("classifier: the policy change matrix is cell-wise, not a rank (plan <-> dont-ask is lateral)", () => {
  // Rows: from. Columns: to, in the order plan, dont-ask, ask, accept-edits, auto, bypass. Worked out cell by cell from the spec table:
  // e.g. dont-ask -> plan shrinks an explicitly allowed edit (allow -> deny) but grows unauthorized Bash (deny -> read-only-view allow).
  // auto's per-call Bash review is not a cell rung (it revokes nothing a running process holds), so the switch to auto is an ordinary widening.
  const U = "unchanged", W = "widening", N = "narrowing", L = "lateral";
  const EXPECTED: Readonly<Record<ApprovalPolicy, readonly CoworkPolicyChangeKind[]>> = {
    "plan":         [U, L, W, W, W, W],
    "dont-ask":     [L, U, W, W, W, W],
    "ask":          [N, N, U, W, W, W],
    "accept-edits": [N, N, N, U, W, W],
    "auto":         [N, N, N, N, U, W],
    "bypass":       [N, N, N, N, N, U],
  };
  for (const from of POLICIES) POLICIES.forEach((to, index) => expect({ from, to, kind: kind(state(from), state(to)) }).toEqual({ from, to, kind: EXPECTED[from][index]! }));
  // Not symmetric opposites except where the cells really are: every widening has a narrowing reverse, except the lateral pair.
  for (const from of POLICIES) for (const to of POLICIES) {
    const forward = kind(state(from), state(to)), back = kind(state(to), state(from));
    if (forward === "widening") expect(back).toBe("narrowing"); else if (forward === "narrowing") expect(back).toBe("widening"); else expect(back).toBe(forward);
  }
});

test("classifier: X -> auto with Bash authorized is a widening, not a shrinking (the per-call review is not a rung)", async () => {
  const full = ceiling(["read", "write", "execute"], "none", ["workspace.instructions.update"]);
  for (const from of ["dont-ask", "ask", "accept-edits"] as const) {
    // The authorized Bash cell is allow in both; auto only adds the reviewer flag on the decision.
    const before = coworkHostDecision({ policy: from, tool: "Bash", path: "none", ceiling: full, alreadyAuthorized: true });
    const after = coworkHostDecision({ policy: "auto", tool: "Bash", path: "none", ceiling: full, alreadyAuthorized: true });
    expect([before.verdict, after.verdict]).toEqual(["allow", "allow"]); expect([before.bashReview, after.bashReview]).toEqual([false, true]);
    expect(kind(state(from), state("auto"))).toBe("widening");
    // So the machine installs the view and drains nothing on the ordinary loosening switch to the default policy.
    const h = harness(state(from));
    expect((await h.machine.request(state("auto"))).status).toBe("applied");
    expect(h.calls).toEqual(["installView"]);
  }
  // Leaving auto for a stricter policy still shrinks: that is a narrowing and drains.
  for (const to of ["dont-ask", "ask", "accept-edits"] as const) expect(kind(state("auto"), state(to))).toBe("narrowing");
});

test("classifier: switching into plan is never a widening, and the cells cover every tool class of the matrix", () => {
  for (const from of POLICIES.filter(policy => policy !== "plan")) expect(kind(state(from), state("plan"))).not.toBe("widening");
  expect(new Set(COWORK_CLASSIFIER_CELLS.map(([tool]) => tool))).toEqual(new Set(COWORK_GUEST_TOOL_CLASSES));
  // Every classifier cell is a well-formed call: under the full ceiling the matrix gives it a policy-table answer, not a hard denial.
  const full = ceiling(["read", "write", "execute"], "none", ["workspace.instructions.update"]);
  for (const [tool, path] of COWORK_CLASSIFIER_CELLS) expect(coworkHostDecision({ policy: "bypass", tool, path, ceiling: full }).reason).toBe("policy_table");
});

test("classifier: every cell the matrix can answer with a table verdict has a classifier cell, and every connector cell is listed", () => {
  const full = ceiling(["read", "write", "execute"], "none", ["workspace.instructions.update"]);
  const covered = new Set(COWORK_CLASSIFIER_CELLS.map(([tool, path]) => `${tool}/${path}`)), reachable = new Set<string>();
  for (const policy of POLICIES) for (const tool of COWORK_GUEST_TOOL_CLASSES) for (const path of COWORK_PATH_CLASSES)
    if (coworkHostDecision({ policy, tool, path, ceiling: full }).reason === "policy_table") reachable.add(`${tool}/${path}`);
  expect([...reachable].sort()).toEqual([...covered].sort());
  expect(COWORK_CLASSIFIER_CONNECTOR_CELLS).toHaveLength(8);
  expect(new Set(COWORK_CLASSIFIER_CONNECTOR_CELLS.map(([setting, readOnly]) => `${setting}/${readOnly}`)).size).toBe(8);
  for (const setting of [undefined, "allow", "ask", "deny"] as const) for (const readOnly of [false, true])
    expect(COWORK_CLASSIFIER_CONNECTOR_CELLS.some(([s, r]) => s === setting && r === readOnly)).toBe(true);
});

test("classifier: the connector row is read too, so a change to it alone cannot escape classification", () => {
  const allAllow = (): CoworkHostDecision => ({ verdict: "allow", reason: "policy_table", bashReview: false });
  // With every tool cell identical, only the connector row can tell policies apart.
  const connectorOnly = { decide: allAllow as typeof coworkHostDecision, connector: coworkConnectorVerdict };
  expect(classifyCoworkPolicyChange(state("plan"), state("ask"), connectorOnly)).toBe("widening");   // unset mutation deny -> ask, explicit allow mutation deny -> allow
  expect(classifyCoworkPolicyChange(state("ask"), state("plan"), connectorOnly)).toBe("narrowing");
  expect(classifyCoworkPolicyChange(state("accept-edits"), state("auto"), connectorOnly)).toBe("widening"); // unset mutation ask -> allow
  expect(classifyCoworkPolicyChange(state("ask"), state("dont-ask"), connectorOnly)).toBe("narrowing");  // explicit ask over read-only ask -> deny
  // Take the connector row away (constant) and the same tool-identical pairs are indistinguishable.
  const neither = { decide: allAllow as typeof coworkHostDecision, connector: (() => "allow") as typeof coworkConnectorVerdict };
  for (const from of POLICIES) for (const to of POLICIES) expect(classifyCoworkPolicyChange(state(from), state(to), neither)).toBe("unchanged");
  // And a connector-only change flips a real classification: here ask answers an unset mutation with allow while accept-edits denies it.
  const skewed = { decide: coworkHostDecision, connector: ((setting, readOnly, policy) => policy === "ask" && setting === undefined && !readOnly ? "allow" : coworkConnectorVerdict(setting, readOnly, policy)) as typeof coworkConnectorVerdict };
  expect(classifyCoworkPolicyChange(state("accept-edits"), state("ask"))).toBe("narrowing");
  expect(classifyCoworkPolicyChange(state("accept-edits"), state("ask"), skewed)).toBe("lateral");
});

test("classifier: the capability ceiling is compared set by set", () => {
  const base = state("ask", ceiling(["read", "write"], "none", ["a"], ["c"]));
  const change = (c: CapabilityCeiling, policy: ApprovalPolicy = "ask") => kind(base, state(policy, c));
  expect(change(ceiling(["write", "read"], "none", ["a"], ["c"]))).toBe("unchanged");        // order
  expect(change(ceiling(["read", "write", "read"], "none", ["a", "a"], ["c"]))).toBe("unchanged"); // duplicates
  expect(change(ceiling(["read"], "none", ["a"], ["c"]))).toBe("narrowing");
  expect(change(ceiling(["read", "write", "execute"], "none", ["a"], ["c"]))).toBe("widening");
  expect(change(ceiling(["read", "execute"], "none", ["a"], ["c"]))).toBe("lateral");        // swap
  expect(change(ceiling(["read", "write"], "none", [], ["c"]))).toBe("narrowing");           // host service revoked
  expect(change(ceiling(["read", "write"], "none", ["a"], []))).toBe("narrowing");           // connector revoked
  expect(change(ceiling(["read", "write"], "none", ["a"], ["c", "d"]))).toBe("widening");
  expect(kind(state("ask", ceiling([], "internet")), state("ask", ceiling([], "none")))).toBe("narrowing");
  expect(kind(state("ask", ceiling([], "none")), state("ask", ceiling([], "internet")))).toBe("widening");
  // A policy widening with a ceiling narrowing is lateral; the same direction in both stays that direction.
  expect(change(ceiling(["read"], "none", ["a"], ["c"]), "bypass")).toBe("lateral");
  expect(change(ceiling(["read"], "none", ["a"], ["c"]), "plan")).toBe("narrowing");
  expect(change(ceiling(["read", "write", "execute"], "none", ["a"], ["c"]), "bypass")).toBe("widening");
  // Fail closed: anything malformed or unknown takes the full narrowing protocol.
  for (const bad of [undefined, null, {}, { policy: "chat", ceiling: WIDE }, { policy: "ask" }, { policy: "ask", ceiling: { toolClasses: "read", hostServices: [], connectors: [], network: "none" } },
    { policy: "ask", ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "lan" } }, { policy: "ask", ceiling: { toolClasses: [1], hostServices: [], connectors: [], network: "none" } }] as unknown[]) {
    expect(kind(base, bad as CoworkPolicyState)).toBe("lateral"); expect(kind(bad as CoworkPolicyState, base)).toBe("lateral");
  }
});

// ── machine ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };

/** Ports the test steps by hand; every call is recorded with the snapshot the machine reported at that instant. */
function harness(initial: CoworkPolicyState = state("auto"), epoch = 0) {
  const calls: string[] = [], plans: CoworkTransitionPlan[] = [], seen: Array<{ port: string; snapshot: CoworkTransitionSnapshot }> = [];
  const pending: Record<"closeAdmission" | "drain" | "installView", Deferred<unknown> | undefined> = { closeAdmission: undefined, drain: undefined, installView: undefined };
  const mode: Record<string, "manual" | "auto" | "reject" | "throw" | { value: unknown }> = { closeAdmission: "auto", drain: "auto", installView: "auto" };
  let machine!: CoworkPolicyTransitionMachine;
  const run = (port: "closeAdmission" | "drain" | "installView", plan: CoworkTransitionPlan, value: unknown) => {
    calls.push(port); plans.push(plan); seen.push({ port, snapshot: machine.snapshot() });
    const how = mode[port]!;
    if (how === "throw") throw new Error(`${port} threw synchronously`);
    if (how === "reject") return Promise.reject(new Error(`${port} rejected`));
    if (how === "manual") { pending[port] = deferred<unknown>(); return pending[port]!.promise; }
    if (typeof how === "object") return Promise.resolve(how.value);
    return Promise.resolve(value);
  };
  const ports: CoworkTransitionPorts = {
    closeAdmission: plan => run("closeAdmission", plan, undefined) as Promise<void>,
    drain: plan => run("drain", plan, "drained") as Promise<CoworkDrainOutcome>,
    installView: plan => run("installView", plan, undefined) as Promise<void>,
  };
  machine = new CoworkPolicyTransitionMachine(initial, ports, epoch);
  const snapshots: CoworkTransitionSnapshot[] = []; machine.subscribe(snapshot => snapshots.push(snapshot));
  return { machine, calls, plans, seen, pending, mode, snapshots, release: (port: "closeAdmission" | "drain" | "installView", value?: unknown) => { pending[port]!.resolve(value); pending[port] = undefined; } };
}

test("narrowing into plan runs closeAdmission, drain, installView in order and reports the new state only after installView resolves", async () => {
  const h = harness(state("auto"));
  h.mode.closeAdmission = "manual"; h.mode.drain = "manual"; h.mode.installView = "manual";
  const started = h.machine.request(state("plan"));
  // Synchronously pending: nothing has resolved yet.
  expect(h.machine.snapshot()).toMatchObject({ phase: "pending", step: "closing-admission", admission: "unknown", kind: "narrowing", effective: { policy: "auto" }, target: { policy: "plan" }, epoch: 0 });
  expect(h.calls).toEqual(["closeAdmission"]);
  h.release("closeAdmission"); await settle();
  expect(h.machine.snapshot()).toMatchObject({ phase: "pending", step: "draining", admission: "closed", effective: { policy: "auto" } });
  expect(h.calls).toEqual(["closeAdmission", "drain"]);
  h.release("drain", "drained"); await settle();
  // The broad policy is STILL the reported one while the new view is being installed.
  expect(h.machine.snapshot()).toMatchObject({ phase: "pending", step: "installing-view", admission: "closed", effective: { policy: "auto" }, target: { policy: "plan" } });
  expect(h.calls).toEqual(["closeAdmission", "drain", "installView"]);
  h.release("installView"); const result = await started;
  expect(result.status).toBe("applied");
  expect(h.machine.snapshot()).toMatchObject({ phase: "stable", effective: { policy: "plan" }, epoch: 1, admission: "open" });
  // At every port call, and at every published snapshot before the last one, the effective state was the OLD one.
  for (const { snapshot } of h.seen) expect(snapshot.effective.policy).toBe("auto");
  expect(h.snapshots.slice(0, -1).every(snapshot => snapshot.effective.policy === "auto")).toBe(true);
  expect(h.snapshots.map(snapshot => snapshot.phase === "pending" ? snapshot.step : snapshot.phase)).toEqual(["closing-admission", "draining", "installing-view", "stable"]);
  // The plan handed to the ports.
  expect(h.plans.every(plan => plan === h.plans[0])).toBe(true);
  expect(h.plans[0]).toMatchObject({ kind: "narrowing", epoch: 1, intoPlan: true, from: { policy: "auto" }, to: { policy: "plan" } });
  expect(Object.isFrozen(h.plans[0])).toBe(true);
});

test("a ceiling narrowing with the policy unchanged takes the same protocol, and the epoch advances once per applied transition", async () => {
  const h = harness(state("ask", WIDE), 4);
  const narrower = ceiling(["read"], "none");
  expect((await h.machine.request(state("ask", narrower))).status).toBe("applied");
  expect(h.calls).toEqual(["closeAdmission", "drain", "installView"]);
  expect(h.machine.snapshot()).toMatchObject({ phase: "stable", epoch: 5, effective: { policy: "ask", ceiling: { toolClasses: ["read"], network: "none" } } });
  expect(h.plans[0]).toMatchObject({ epoch: 5, intoPlan: false, kind: "narrowing" });
  expect((await h.machine.request(state("ask", narrower))).status).toBe("unchanged");
  expect(h.calls).toHaveLength(3); expect(h.machine.snapshot()).toMatchObject({ epoch: 5 });
});

test("a lateral change takes the narrowing protocol", async () => {
  const h = harness(state("dont-ask"));
  expect((await h.machine.request(state("plan"))).status).toBe("applied");
  expect(h.calls).toEqual(["closeAdmission", "drain", "installView"]); expect(h.plans[0]!.kind).toBe("lateral");
});

test("a widening only installs the view, keeps admission open and still reports the OLD state until installView resolves", async () => {
  const h = harness(state("plan"));
  h.mode.installView = "manual";
  const started = h.machine.request(state("auto"));
  expect(h.machine.snapshot()).toMatchObject({ phase: "pending", step: "installing-view", admission: "open", kind: "widening", effective: { policy: "plan" }, target: { policy: "auto" } });
  await settle(); expect(h.machine.snapshot()).toMatchObject({ phase: "pending", effective: { policy: "plan" } });
  h.release("installView"); expect((await started).status).toBe("applied");
  expect(h.calls).toEqual(["installView"]);
  expect(h.machine.snapshot()).toMatchObject({ phase: "stable", effective: { policy: "auto" }, epoch: 1 });
  expect(h.snapshots.map(snapshot => snapshot.phase)).toEqual(["pending", "stable"]);
});

test("closeAdmission failure: explicit state, admission unknown, nothing else ran, effective unchanged; retry resumes there", async () => {
  const h = harness(state("auto"));
  h.mode.closeAdmission = "reject";
  const failed = await h.machine.request(state("plan"));
  expect(failed.status).toBe("failed");
  expect(failed.snapshot).toMatchObject({ phase: "failed", failure: "close-admission-failed", step: "closing-admission", admission: "unknown", workspaceRestartRequired: false, effective: { policy: "auto" }, target: { policy: "plan" }, epoch: 0 });
  expect(h.calls).toEqual(["closeAdmission"]);
  h.mode.closeAdmission = "auto";
  expect((await h.machine.retry()).status).toBe("applied");
  expect(h.calls).toEqual(["closeAdmission", "closeAdmission", "drain", "installView"]);
  expect(h.machine.snapshot()).toMatchObject({ phase: "stable", effective: { policy: "plan" } });
});

test("a port that throws synchronously is a failure of its step, not a crash", async () => {
  const h = harness(state("auto"));
  h.mode.closeAdmission = "throw";
  expect((await h.machine.request(state("plan"))).snapshot).toMatchObject({ phase: "failed", failure: "close-admission-failed", effective: { policy: "auto" } });
  h.mode.closeAdmission = "auto"; h.mode.drain = "throw";
  expect((await h.machine.retry()).snapshot).toMatchObject({ phase: "failed", failure: "drain-failed", admission: "closed" });
  h.mode.drain = "auto"; h.mode.installView = "throw";
  expect((await h.machine.retry()).snapshot).toMatchObject({ phase: "failed", failure: "install-view-failed", admission: "closed" });
  h.mode.installView = "auto";
  expect((await h.machine.retry()).status).toBe("applied");
  expect(h.calls).toEqual(["closeAdmission", "closeAdmission", "drain", "drain", "installView", "installView"]);
});

test("drain failure: admission closed, older handles may be live, effective unchanged; retry resumes at drain without reclosing", async () => {
  const h = harness(state("bypass"));
  h.mode.drain = "reject";
  const failed = await h.machine.request(state("ask"));
  expect(failed.snapshot).toMatchObject({ phase: "failed", failure: "drain-failed", step: "draining", admission: "closed", workspaceRestartRequired: false, effective: { policy: "bypass" } });
  expect(h.calls).toEqual(["closeAdmission", "drain"]);
  h.mode.drain = "auto";
  expect((await h.machine.retry()).status).toBe("applied");
  expect(h.calls).toEqual(["closeAdmission", "drain", "drain", "installView"]);
});

test("drain that cannot be enforced per process is restart-required: explicit, admission closed, retry refuses without touching a port", async () => {
  const h = harness(state("auto"));
  h.mode.drain = { value: "restart-required" };
  const failed = await h.machine.request(state("plan"));
  expect(failed.status).toBe("failed");
  expect(failed.snapshot).toMatchObject({ phase: "failed", failure: "restart-required", step: "draining", admission: "closed", workspaceRestartRequired: true, effective: { policy: "auto" } });
  const calls = h.calls.length;
  expect((await h.machine.retry()).status).toBe("unresolved");
  expect(h.calls).toHaveLength(calls); expect(h.machine.snapshot()).toMatchObject({ failure: "restart-required", effective: { policy: "auto" } });
  // The owner restarts the workspace and builds a fresh machine from the canonical record; the old one is never "unstuck" in place.
  const fresh = harness(state("plan"), 1);
  expect(fresh.machine.snapshot()).toMatchObject({ phase: "stable", effective: { policy: "plan" }, epoch: 1 });
});

test("an unrecognised drain result is not a drain", async () => {
  for (const value of [undefined, null, "", "Drained", "ok", true, 1, {}]) {
    const h = harness(state("auto")); h.mode.drain = { value };
    const result = await h.machine.request(state("plan"));
    expect(result.snapshot).toMatchObject({ phase: "failed", failure: "drain-failed", admission: "closed", effective: { policy: "auto" } });
    expect(h.calls).toEqual(["closeAdmission", "drain"]);
  }
});

test("installView failure: drained but unreplaced, admission closed, effective STILL the old state; retry resumes at installView only", async () => {
  const h = harness(state("auto"));
  h.mode.installView = "reject";
  const failed = await h.machine.request(state("plan"));
  expect(failed.snapshot).toMatchObject({ phase: "failed", failure: "install-view-failed", step: "installing-view", admission: "closed", workspaceRestartRequired: false, effective: { policy: "auto" }, target: { policy: "plan" }, epoch: 0 });
  expect(h.calls).toEqual(["closeAdmission", "drain", "installView"]);
  h.mode.installView = "auto";
  expect((await h.machine.retry()).status).toBe("applied");
  expect(h.calls).toEqual(["closeAdmission", "drain", "installView", "installView"]);
  expect(h.machine.snapshot()).toMatchObject({ phase: "stable", effective: { policy: "plan" }, epoch: 1 });
});

test("a widening whose installView fails keeps admission open and the narrower old state", async () => {
  const h = harness(state("plan"));
  h.mode.installView = "reject";
  const failed = await h.machine.request(state("bypass"));
  expect(failed.snapshot).toMatchObject({ phase: "failed", failure: "install-view-failed", admission: "open", effective: { policy: "plan" }, kind: "widening" });
  h.mode.installView = "auto";
  expect((await h.machine.retry()).status).toBe("applied");
  expect(h.calls).toEqual(["installView", "installView"]);
});

test("while pending or failed a new request is refused and no port is called; invalid targets and retries are explicit", async () => {
  const h = harness(state("auto"));
  h.mode.drain = "manual";
  const started = h.machine.request(state("plan"));
  await settle();
  const calls = [...h.calls];
  expect((await h.machine.request(state("bypass"))).status).toBe("busy");
  expect((await h.machine.request(state("plan"))).status).toBe("busy");
  expect((await h.machine.retry()).status).toBe("busy");
  expect(h.calls).toEqual(calls);
  expect(h.machine.snapshot()).toMatchObject({ phase: "pending", step: "draining", target: { policy: "plan" } });
  h.release("drain", "drained"); expect((await started).status).toBe("applied");
  expect((await h.machine.retry()).status).toBe("nothing-to-retry");
  // Invalid targets never reach a port and never change the state.
  const before = h.calls.length;
  for (const bad of [undefined, null, {}, { policy: "chat", ceiling: WIDE }, { policy: "plan" }, { policy: "plan", ceiling: { toolClasses: "read", hostServices: [], connectors: [], network: "none" } },
    { policy: "plan", ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "lan" } }] as unknown[])
    expect((await h.machine.request(bad as CoworkPolicyState)).status).toBe("invalid");
  expect(h.calls).toHaveLength(before); expect(h.machine.snapshot()).toMatchObject({ phase: "stable", effective: { policy: "plan" } });
  // A failed transition is unresolved: a different request is refused until the failure is retried.
  h.mode.closeAdmission = "reject";
  expect((await h.machine.request(state("dont-ask"))).status).toBe("failed");
  const failedCalls = h.calls.length;
  expect((await h.machine.request(state("auto"))).status).toBe("unresolved");
  expect(h.calls).toHaveLength(failedCalls); expect(h.machine.snapshot()).toMatchObject({ phase: "failed", effective: { policy: "plan" }, target: { policy: "dont-ask" } });
});

test("snapshots are frozen copies: later edits to the caller's objects cannot change what the machine reports", async () => {
  const target = { policy: "plan" as ApprovalPolicy, ceiling: ceiling(["read", "write"], "none", [], []) };
  const h = harness(state("auto"));
  h.mode.drain = "manual";
  const started = h.machine.request(target);
  target.ceiling.toolClasses.push("execute"); target.policy = "bypass";
  await settle();
  const snapshot = h.machine.snapshot();
  expect(snapshot).toMatchObject({ target: { policy: "plan", ceiling: { toolClasses: ["read", "write"] } } });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen((snapshot as { target: CoworkPolicyState }).target.ceiling.toolClasses)).toBe(true);
  h.release("drain", "drained"); await started;
  expect(h.machine.snapshot()).toMatchObject({ effective: { policy: "plan", ceiling: { toolClasses: ["read", "write"] } } });
});

test("re-entrancy: a stable listener that starts another request cannot change the snapshot the first request reports", async () => {
  const h = harness(state("auto"));
  const second: string[] = [];
  let nested: Promise<unknown> | undefined;
  h.machine.subscribe(snapshot => { if (snapshot.phase === "stable" && snapshot.effective.policy === "plan" && !nested) nested = h.machine.request(state("bypass")); });
  h.machine.subscribe(snapshot => { second.push(snapshot.phase === "pending" ? `pending:${snapshot.target.policy}:${snapshot.step}` : `${snapshot.phase}:${snapshot.effective.policy}`); });
  const result = await h.machine.request(state("plan"));
  // The returned result is the transition that just applied, not whatever the nested request has made of the machine since.
  expect(result.status).toBe("applied");
  expect(result.snapshot).toMatchObject({ phase: "stable", effective: { policy: "plan" }, epoch: 1 });
  expect(nested).toBeDefined(); await nested;
  expect(h.machine.snapshot()).toMatchObject({ phase: "stable", effective: { policy: "bypass" }, epoch: 2 });
  // Every listener saw every phase, in order: the nested request's phases queue behind the delivery in progress.
  expect(second).toEqual(["pending:plan:closing-admission", "pending:plan:draining", "pending:plan:installing-view", "stable:plan", "pending:bypass:installing-view", "stable:bypass"]);
});

test("re-entrancy: a failed listener that retries synchronously cannot change the failure the first request reports", async () => {
  const h = harness(state("auto"));
  h.mode.drain = "reject";
  let retried: Promise<unknown> | undefined;
  h.machine.subscribe(snapshot => { if (snapshot.phase === "failed" && !retried) { h.mode.drain = "auto"; retried = h.machine.retry(); } });
  const result = await h.machine.request(state("plan"));
  expect(result.status).toBe("failed");
  expect(result.snapshot).toMatchObject({ phase: "failed", failure: "drain-failed", effective: { policy: "auto" } });
  await retried;
  expect(h.machine.snapshot()).toMatchObject({ phase: "stable", effective: { policy: "plan" } });
});

test("observers cannot affect the transition and can unsubscribe; a malformed initial state is refused", async () => {
  const h = harness(state("auto"));
  const seen: string[] = [];
  const off = h.machine.subscribe(snapshot => { seen.push(snapshot.phase); throw new Error("observer failure"); });
  expect((await h.machine.request(state("plan"))).status).toBe("applied");
  expect(seen).toEqual(["pending", "pending", "pending", "stable"]);
  off(); await h.machine.request(state("bypass")); expect(seen).toHaveLength(4);
  const ports: CoworkTransitionPorts = { closeAdmission: async () => {}, drain: async () => "drained", installView: async () => {} };
  for (const bad of [undefined, { policy: "chat", ceiling: WIDE }, { policy: "ask", ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "x" } }] as unknown[])
    expect(() => new CoworkPolicyTransitionMachine(bad as CoworkPolicyState, ports)).toThrow(TypeError);
  expect(() => new CoworkPolicyTransitionMachine(state("ask"), ports, -1)).toThrow(TypeError);
  expect(() => new CoworkPolicyTransitionMachine(state("ask"), ports, 1.5)).toThrow(TypeError);
});

// ── regression: the shared-instruction edit is denied under dont-ask as well as plan ──────────────────────────────

const supported = process.platform === "darwin" && process.arch === "arm64"; // CoworkInstructions refuses to construct elsewhere
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const user = { kind: "local-user" as const, id: "user" };
const grants = { folder: () => ({ rootIdentity: "root", writable: true, revoked: false }), repository: () => undefined };

/** A minimal conversation bound at `policy`; no instruction file is ever created (updateAgent refuses or cards before any file access). */
function instructionConversation(policy: ApprovalPolicy) {
  const home = mkdtempSync(join(tmpdir(), "winter-host-policy-")); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const db = openRuntimeStateDb(home); cleanups.push(() => db.close());
  const records = new CoworkRepository(db), store = new SessionStore(home); cleanups.push(() => store.close());
  const hub = new SessionHub(store), broker = new ApprovalBroker();
  const made = records.create({ principalId: user.id, requestId: "create" }, { ownership: "project", title: "Fixture",
    sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "grant", rootIdentity: "root" } }],
    ceiling: { toolClasses: ["read", "write"], hostServices: ["workspace.instructions.update"], connectors: [], network: "none" } });
  const workspaceId = made.workspaceId;
  records.updatePolicy({ principalId: user.id, requestId: "default-policy", expectedRevision: records.get(workspaceId).configRevision }, workspaceId, { defaultPolicy: policy });
  const epoch = records.beginIncarnation(workspaceId, "fixture-incarnation", records.get(workspaceId).configRevision), sourceId = made.value.sources[0]!.sourceId;
  records.acknowledgeSource(epoch, sourceId, 1, "ready");
  const sessionId = store.createSession("global", { mode: "code" });
  records.bindConversation({ principalId: user.id, requestId: "bind", expectedRevision: records.get(workspaceId).configRevision }, workspaceId, { sessionId, sourceId }, store);
  expect(records.binding(sessionId).policy).toBe(policy);
  const owner = new CoworkInstructions(records, home, grants, { broker, emit: (id, event) => { hub.append(id, event); } });
  const runtime = { kind: "runtime" as const, id: "runtime", sessionId, workspaceId };
  const input = { workspaceId, content: "agent proposal", requestId: "agent-edit", expectedInstructionRevision: 1, expectedDigest: "0".repeat(64) };
  const cards = () => store.read(sessionId).filter(event => event.type === "approval_requested").length;
  return { owner, runtime, input, broker, cards, sessionId };
}

test.skipIf(!supported)("regression: an agent's shared-instruction edit is refused before any card under plan AND dont-ask, and carded under the other four, exactly as the host policy matrix says", async () => {
  for (const policy of POLICIES) {
    const f = instructionConversation(policy), controller = new AbortController();
    const expected = coworkHostDecision({ policy, tool: "InstructionEdit", path: "shared-instructions", ceiling: ceiling(["read", "write"], "none", ["workspace.instructions.update"]) }).verdict;
    expect(expected).toBe(policy === "plan" || policy === "dont-ask" ? "deny" : "ask");
    const call = f.owner.updateAgent(f.runtime, f.input, controller.signal);
    if (expected === "deny") {
      await expect(call).rejects.toMatchObject({ name: "CoworkError", code: "authority_denied" });
      expect(f.broker.list(f.sessionId)).toHaveLength(0); expect(f.cards()).toBe(0);
    } else {
      await settle();
      expect(f.broker.list(f.sessionId)).toHaveLength(1); expect(f.cards()).toBe(1);
      controller.abort();
      const error = await call.then(() => undefined, caught => caught);
      expect(error).toBeInstanceOf(CoworkError); expect((error as CoworkError).code).toBe("authority_denied");
    }
  }
});

// ── anti-wiring ──────────────────────────────────────────────────────────────────────────────────────────────────
const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
test("wired behind the refusal: only the Cowork approval projection names the transition module (a type), no barrel export, and it reaches only the matrix", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "policy-transition.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module);
  // runtime-sdk/cowork-approval.ts imports the snapshot TYPE so the approval bridge can read the machine's phase and admission. Session door
  // D3: the DOOR's approval ports (cowork/approval-ports.ts) construct ONE machine per conversation incarnation, stable at the binding's
  // policy, whose ports refuse every change; only the Cowork driver table builds those ports, and nothing in src constructs that table
  // (test/cowork/session-door-off.test.ts).
  const offenders = new Set<string>(), constructors = new Set<string>();
  for (const file of sources.filter(candidate => candidate !== module)) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["./policy-transition", "cowork/policy-transition", "CoworkPolicyTransitionMachine", "classifyCoworkPolicyChange", "CoworkTransitionPorts", "CoworkTransitionSnapshot", "COWORK_CLASSIFIER_CELLS"])
      if (text.includes(needle)) offenders.add(basename(file));
    if (text.includes("CoworkPolicyTransitionMachine") || text.includes("classifyCoworkPolicyChange")) constructors.add(basename(file));
  }
  expect([...offenders].sort()).toEqual(["approval-ports.ts", "cowork-approval.ts"]);
  expect([...constructors]).toEqual(["approval-ports.ts"]);
  const projection = readFileSync(join(packages, "core", "src", "runtime-sdk", "cowork-approval.ts"), "utf8");
  expect(projection).toMatch(/import type \{ CoworkTransitionSnapshot \} from "\.\.\/cowork\/policy-transition"/);
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/policy-transition|from "\.\/cowork/);
  const own = readFileSync(module, "utf8");
  expect([...own.matchAll(/^import (type )?[^;]*from "([^"]+)"/gm)].map(match => `${match[1] ? "type " : ""}${match[2]}`).sort())
    .toEqual(["./host-policy", "type ./types", "type @yanlinglabs/winter-protocol"]);
  expect(Object.keys(transition).sort()).toEqual(["COWORK_CLASSIFIER_CELLS", "COWORK_CLASSIFIER_CONNECTOR_CELLS", "CoworkPolicyTransitionMachine", "classifyCoworkPolicyChange"]);
  // No timers, clock, I/O or environment: ports are the only way the machine touches anything.
  expect(own).not.toMatch(/\b(Date\.now|new Date|process\.|Bun\.|node:|fetch\(|setTimeout|setInterval|Math\.random)\b/);
});
