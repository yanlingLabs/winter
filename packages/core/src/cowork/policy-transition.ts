// Cowork POLICY TRANSITIONS (unwired): the narrowing classifier and the pending-transition machine for
// docs/cowork-execution-contracts.md, "Approval policies", last paragraph (the one starting "When narrowing a
// policy or hard capability ceiling"; grep for it, line numbers drift):
//
//   "first close affected admission and cancel/drain processes holding older writable handles or broker
//    capabilities. Switching into plan requires replacing the old execution view before it becomes effective.
//    Show a pending transition until affected work is stopped and the new view installed; a task cannot keep
//    broad authority behind a UI that already says plan. Use workspace restart where a share/grant revocation
//    cannot be enforced per process. Changes to completed external effects cannot be undone by this transition."
//
// ── The invariant ─────────────────────────────────────────────────────────────────────────────────────
// The REPORTED effective state (`snapshot().effective`) is the OLD one in every phase except `stable` after a
// successful `installView`. It is assigned in exactly one place, after `installView` resolved, and a failure at
// any step leaves it old. So a UI built on the snapshot can never say `plan` while an older, broader view is
// still running: while a transition is pending or failed it says the old policy AND carries the pending target.
//
// ── The classifier ────────────────────────────────────────────────────────────────────────────────────
// "These policies are not a linear privilege ranking." (spec, same section.) So a change is NOT compared by a
// rank of the policy names. It is compared CELL BY CELL over the host policy decision itself (`host-policy.ts`:
// every guest tool class on its path class, with and without an explicit allow) under a full ceiling, over every
// cell of the Cowork connector row (each stored setting x read-only or not), plus the ceiling set by set. The
// classifier therefore cannot drift from the matrix: it reads the matrix, and tests pin that every cell the
// matrix can answer with a table verdict has a classifier cell.
//   unchanged   no cell and no ceiling dimension differs
//   widening    something grew and nothing shrank
//   narrowing   something shrank and nothing grew
//   lateral     something grew AND something shrank (e.g. dont-ask -> plan: edits shrink, read-only Bash grows)
// A lateral change takes the narrowing protocol: whatever shrank needs the old holders closed and drained.
//
// ── The ports (all injected; the machine has no clock, no I/O and no timers) ─────────────────────────
//   closeAdmission  stop admitting new work that the NEW state would refuse. Idempotent. A rejection means the
//                   host cannot tell whether admission closed, so the machine reports admission `unknown`.
//   drain           cancel/drain every process holding an older writable handle or broker capability. Resolves
//                   `"drained"`, or `"restart-required"` when a share/grant revocation cannot be enforced per
//                   process (the spec's "Use workspace restart ..."). Anything else is treated as a failure.
//   installView     install the NEW execution view (for plan: the read-only mounts and a scratch scoped to the
//                   new `epoch`) and, once it is in force, reopen admission under it. Resolving means the new
//                   view is in force; the machine reports the new state only after this.
// A port that never settles leaves the transition pending, which is the safe report. Time limits belong to the
// port implementation. A widening needs no closing or draining (no authority is removed) but still installs the
// new view before the wider state is reported.
//
// ── Failure states (explicit; each keeps the OLD state as the effective one) ──────────────────────────
//   close-admission-failed   admission unknown; work still runs under the old authority; `retry()` resumes here
//   drain-failed             admission closed; older handles may still be live; `retry()` resumes at drain
//   restart-required         admission closed; only a workspace restart can enforce this; `retry()` refuses and
//                            the owner builds a fresh machine from the canonical record after the restart
//   install-view-failed      older holders drained, new view not installed, admission still closed (narrowing);
//                            `retry()` resumes at installView
// While failed, a new `request()` is refused (`unresolved`): without a reopen port a different target could
// leave admission closed under a state that claims otherwise. REVIEW NEEDED in the PR.
//
// Nothing in `src/` imports this module. It never touches a record, a process or a view itself.

import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import { coworkConnectorVerdict, coworkHostDecision, isCoworkApprovalPolicy, type CoworkGuestToolClass, type CoworkHostDecision, type CoworkPathClass, type CoworkVerdict } from "./host-policy";
import type { CapabilityCeiling } from "./types";

export interface CoworkPolicyState { readonly policy: ApprovalPolicy; readonly ceiling: CapabilityCeiling }

export type CoworkPolicyChangeKind = "unchanged" | "widening" | "narrowing" | "lateral";

// ── classifier ───────────────────────────────────────────────────────────────────────────────────────

/** Every cell the matrix distinguishes, with the path class a well-formed call carries. */
export const COWORK_CLASSIFIER_CELLS: ReadonlyArray<readonly [CoworkGuestToolClass, CoworkPathClass]> = Object.freeze([
  ["Read", "admitted"], ["Read", "shared-instructions"], ["Write", "admitted"], ["Edit", "admitted"],
  ["Read", "outputs"], ["Write", "outputs"], ["Edit", "outputs"], ["Read", "scratch"], ["Write", "scratch"], ["Edit", "scratch"],
  ["Bash", "admitted"], ["Bash", "none"], ["Workflow", "admitted"], ["Workflow", "none"], ["InstructionEdit", "shared-instructions"],
]);
/** Every cell of the connector row: stored setting (`undefined` = unset) x classified read-only. */
export const COWORK_CLASSIFIER_CONNECTOR_CELLS: ReadonlyArray<readonly ["allow" | "ask" | "deny" | undefined, boolean]> = Object.freeze([
  [undefined, false], [undefined, true], ["allow", false], ["allow", true], ["ask", false], ["ask", true], ["deny", false], ["deny", true],
]);
/** The ceiling the cells are read under, so the ceiling never masks a policy difference. */
const FULL_CEILING: CapabilityCeiling = { toolClasses: ["read", "write", "execute"], hostServices: ["workspace.instructions.update"], connectors: [], network: "none" };

/**
 * How much a tool cell lets through, weakest first: deny < allow-in-plan-view < ask < allow.
 * `bashReview` is deliberately NOT a rung: a per-call review of future launches revokes nothing a running process
 * already holds, and the spec says "`auto` does not promise every action received model review". Ranking it would
 * make the ordinary loosening switch to `auto` lateral and drain in-flight work for no reason.
 */
function reach(decision: CoworkHostDecision): number {
  switch (decision.verdict) {
    case "deny": return 0;
    case "allow-in-plan-view": return 1;
    case "ask": return 2;
    case "allow": return 4;
  }
}
const connectorReach = (verdict: CoworkVerdict): number => verdict === "deny" ? 0 : verdict === "ask" ? 1 : 2;

/** The two decision functions the classifier reads. The default is the real matrix; the parameter is a test seam. */
export interface CoworkPolicyMatrix { readonly decide: typeof coworkHostDecision; readonly connector: typeof coworkConnectorVerdict }
const MATRIX: CoworkPolicyMatrix = Object.freeze({ decide: coworkHostDecision, connector: coworkConnectorVerdict });

/** The policy's cells under a full ceiling: one number per (tool cell, explicit-allow) pair, then one per connector cell. */
function policyReach(policy: ApprovalPolicy, matrix: CoworkPolicyMatrix): number[] {
  const out: number[] = [];
  for (const [tool, path] of COWORK_CLASSIFIER_CELLS) for (const alreadyAuthorized of [false, true])
    out.push(reach(matrix.decide({ policy, tool, path, ceiling: FULL_CEILING, alreadyAuthorized })));
  for (const [setting, readOnly] of COWORK_CLASSIFIER_CONNECTOR_CELLS) out.push(connectorReach(matrix.connector(setting, readOnly, policy)));
  return out;
}
// A test pins that these cells cover every tool class of the matrix, so a new class cannot escape the classifier.

type Direction = "same" | "narrows" | "widens" | "both";
const merge = (a: Direction, b: Direction): Direction => a === "same" ? b : b === "same" ? a : a === b ? a : "both";

function setDirection(from: unknown, to: unknown): Direction | undefined {
  if (!Array.isArray(from) || !Array.isArray(to) || ![...from, ...to].every(value => typeof value === "string")) return undefined;
  const before = new Set<string>(from), after = new Set<string>(to);
  const removed = [...before].some(value => !after.has(value)), added = [...after].some(value => !before.has(value));
  return removed && added ? "both" : removed ? "narrows" : added ? "widens" : "same";
}

/** Fail closed: a malformed or unknown side is `lateral`, which takes the full narrowing protocol. */
export function classifyCoworkPolicyChange(from: CoworkPolicyState, to: CoworkPolicyState, matrix: CoworkPolicyMatrix = MATRIX): CoworkPolicyChangeKind {
  if (!from || !to || !isCoworkApprovalPolicy(from.policy) || !isCoworkApprovalPolicy(to.policy) || !from.ceiling || !to.ceiling) return "lateral";
  let direction: Direction = "same";
  const before = policyReach(from.policy, matrix), after = policyReach(to.policy, matrix);
  for (let index = 0; index < before.length; index += 1) direction = merge(direction, after[index]! < before[index]! ? "narrows" : after[index]! > before[index]! ? "widens" : "same");
  for (const dimension of ["toolClasses", "hostServices", "connectors"] as const) {
    const change = setDirection(from.ceiling[dimension], to.ceiling[dimension]);
    if (change === undefined) return "lateral";
    direction = merge(direction, change);
  }
  const networks: Readonly<Record<string, number>> = { none: 0, internet: 1 };
  const [oldNetwork, newNetwork] = [networks[from.ceiling.network], networks[to.ceiling.network]];
  if (oldNetwork === undefined || newNetwork === undefined) return "lateral";
  direction = merge(direction, newNetwork < oldNetwork ? "narrows" : newNetwork > oldNetwork ? "widens" : "same");
  return direction === "same" ? "unchanged" : direction === "narrows" ? "narrowing" : direction === "widens" ? "widening" : "lateral";
}

// ── machine ──────────────────────────────────────────────────────────────────────────────────────────

export type CoworkTransitionKind = Exclude<CoworkPolicyChangeKind, "unchanged">;
export type CoworkTransitionStep = "closing-admission" | "draining" | "installing-view";
export type CoworkTransitionFailure = "close-admission-failed" | "drain-failed" | "restart-required" | "install-view-failed";
export type CoworkAdmission = "open" | "closed" | "unknown";
export type CoworkDrainOutcome = "drained" | "restart-required";

/** What every port receives. `epoch` is the policy epoch the new state will carry (scope plan scratch by it). */
export interface CoworkTransitionPlan {
  readonly from: CoworkPolicyState;
  readonly to: CoworkPolicyState;
  readonly kind: CoworkTransitionKind;
  readonly epoch: number;
  readonly intoPlan: boolean;
}
export interface CoworkTransitionPorts {
  closeAdmission(plan: CoworkTransitionPlan): Promise<void>;
  drain(plan: CoworkTransitionPlan): Promise<CoworkDrainOutcome>;
  installView(plan: CoworkTransitionPlan): Promise<void>;
}

export type CoworkTransitionSnapshot =
  | { readonly phase: "stable"; readonly effective: CoworkPolicyState; readonly epoch: number; readonly admission: "open" }
  | { readonly phase: "pending"; readonly step: CoworkTransitionStep; readonly effective: CoworkPolicyState; readonly epoch: number;
      readonly target: CoworkPolicyState; readonly kind: CoworkTransitionKind; readonly admission: CoworkAdmission }
  | { readonly phase: "failed"; readonly failure: CoworkTransitionFailure; readonly step: CoworkTransitionStep; readonly effective: CoworkPolicyState; readonly epoch: number;
      readonly target: CoworkPolicyState; readonly kind: CoworkTransitionKind; readonly admission: CoworkAdmission; readonly workspaceRestartRequired: boolean };

export type CoworkTransitionStatus = "applied" | "unchanged" | "failed" | "busy" | "unresolved" | "invalid" | "nothing-to-retry";
export interface CoworkTransitionResult { readonly status: CoworkTransitionStatus; readonly snapshot: CoworkTransitionSnapshot }

const STEPS: readonly CoworkTransitionStep[] = ["closing-admission", "draining", "installing-view"];
const FAILURE_FOR: Readonly<Record<CoworkTransitionStep, CoworkTransitionFailure>> = { "closing-admission": "close-admission-failed", "draining": "drain-failed", "installing-view": "install-view-failed" };
const RESUME_AT: Readonly<Record<CoworkTransitionFailure, CoworkTransitionStep | undefined>> =
  { "close-admission-failed": "closing-admission", "drain-failed": "draining", "install-view-failed": "installing-view", "restart-required": undefined };

function normalize(state: CoworkPolicyState): CoworkPolicyState | undefined {
  if (!state || typeof state !== "object" || !isCoworkApprovalPolicy(state.policy)) return undefined;
  const ceiling = state.ceiling;
  if (!ceiling || typeof ceiling !== "object" || (ceiling.network !== "none" && ceiling.network !== "internet")) return undefined;
  const names = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? [...new Set<string>(value)].sort() : undefined;
  const toolClasses = names(ceiling.toolClasses), hostServices = names(ceiling.hostServices), connectors = names(ceiling.connectors);
  if (!toolClasses || !hostServices || !connectors) return undefined;
  return Object.freeze({ policy: state.policy, ceiling: Object.freeze({ toolClasses: Object.freeze(toolClasses) as string[], hostServices: Object.freeze(hostServices) as string[], connectors: Object.freeze(connectors) as string[], network: ceiling.network }) });
}

export class CoworkPolicyTransitionMachine {
  private effective: CoworkPolicyState;
  private epoch: number;
  private current: CoworkTransitionSnapshot;
  private readonly listeners = new Set<(snapshot: CoworkTransitionSnapshot) => void>();
  private plan: CoworkTransitionPlan | undefined;
  private notifying = false;
  private readonly queue: CoworkTransitionSnapshot[] = [];

  /** `initial` is the canonical record's current state; a fresh machine after a workspace restart starts here. */
  constructor(initial: CoworkPolicyState, private readonly ports: CoworkTransitionPorts, epoch = 0) {
    const state = normalize(initial);
    if (!state || !Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError("invalid initial Cowork policy state");
    this.effective = state; this.epoch = epoch;
    this.current = Object.freeze({ phase: "stable", effective: state, epoch, admission: "open" });
  }

  snapshot(): CoworkTransitionSnapshot { return this.current; }

  /**
   * Notified after every phase change, in order, each snapshot delivered to every listener before the next one is.
   * A listener may call `request()` or `retry()` synchronously: the nested phase changes are queued behind the one
   * being delivered. A throwing listener cannot affect the machine.
   */
  subscribe(listener: (snapshot: CoworkTransitionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Begin a transition to `target`. Refused while another is pending or unresolved. */
  async request(target: CoworkPolicyState): Promise<CoworkTransitionResult> {
    const phase = this.current.phase;
    if (phase === "pending") return this.result("busy");
    if (phase === "failed") return this.result("unresolved");
    const to = normalize(target);
    if (!to) return this.result("invalid");
    const kind = classifyCoworkPolicyChange(this.effective, to);
    if (kind === "unchanged") return this.result("unchanged");
    this.plan = Object.freeze({ from: this.effective, to, kind, epoch: this.epoch + 1, intoPlan: to.policy === "plan" && this.effective.policy !== "plan" });
    return this.run(kind === "widening" ? "installing-view" : "closing-admission");
  }

  /** Resume a failed transition at the step that failed. */
  async retry(): Promise<CoworkTransitionResult> {
    const snapshot = this.current;
    if (snapshot.phase === "pending") return this.result("busy");
    if (snapshot.phase !== "failed" || !this.plan) return this.result("nothing-to-retry");
    const resume = RESUME_AT[snapshot.failure];
    if (resume === undefined) return this.result("unresolved");
    return this.run(resume);
  }

  private result(status: CoworkTransitionStatus): CoworkTransitionResult { return Object.freeze({ status, snapshot: this.current }); }

  /** Commit, then notify. Returns the committed snapshot so a caller reports THIS one, never whatever `current` has become after a re-entrant listener. */
  private publish(snapshot: CoworkTransitionSnapshot): CoworkTransitionSnapshot {
    const committed = Object.freeze(snapshot);
    this.current = committed;
    this.queue.push(committed);
    if (!this.notifying) {
      this.notifying = true;
      try {
        for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift())
          for (const listener of [...this.listeners]) { try { listener(next); } catch { /* observers cannot affect the transition */ } }
      } finally { this.notifying = false; }
    }
    return committed;
  }

  private admissionDuring(step: CoworkTransitionStep, plan: CoworkTransitionPlan): CoworkAdmission {
    if (plan.kind === "widening") return "open";
    return step === "closing-admission" ? "unknown" : "closed";
  }

  private async run(start: CoworkTransitionStep): Promise<CoworkTransitionResult> {
    const plan = this.plan!;
    // A widening removes no authority, so it only installs the view.
    for (const step of STEPS.slice(STEPS.indexOf(start))) {
      this.publish({ phase: "pending", step, effective: this.effective, epoch: this.epoch, target: plan.to, kind: plan.kind, admission: this.admissionDuring(step, plan) });
      let failure: CoworkTransitionFailure | undefined;
      try {
        if (step === "closing-admission") await this.ports.closeAdmission(plan);
        else if (step === "draining") {
          const outcome = await this.ports.drain(plan);
          if (outcome === "restart-required") failure = "restart-required";
          else if (outcome !== "drained") failure = "drain-failed"; // anything but an explicit "drained" is not a drain
        } else await this.ports.installView(plan);
      } catch { failure = FAILURE_FOR[step]; }
      if (failure !== undefined) {
        // Admission after a failure: where the step began, or closed once a drain step ran.
        const admission: CoworkAdmission = plan.kind === "widening" ? "open" : step === "closing-admission" ? "unknown" : "closed";
        const failed = this.publish({ phase: "failed", failure, step, effective: this.effective, epoch: this.epoch, target: plan.to, kind: plan.kind, admission, workspaceRestartRequired: failure === "restart-required" });
        return Object.freeze({ status: "failed", snapshot: failed });
      }
    }
    // The ONLY place the reported state changes, after installView resolved.
    this.effective = plan.to; this.epoch = plan.epoch; this.plan = undefined;
    const stable = this.publish({ phase: "stable", effective: this.effective, epoch: this.epoch, admission: "open" });
    return Object.freeze({ status: "applied", snapshot: stable });
  }
}
