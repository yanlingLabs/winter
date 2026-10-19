// COWORK APPROVAL PROJECTION: turns the Cowork host policy decision (`cowork/host-policy.ts`, `cowork/policy-transition.ts`)
// into what `approval-bridge.ts` does with one `canUseTool` request. Pure and port-driven: it reads no file, no clock and
// no setting, and it is reached ONLY from a bridge that was handed a `CoworkApprovalPorts`, which production never supplies
// (a Cowork session is refused at the door, `session.create {mode:"cowork"}` -> `unsupported_topology`, and the driver
// refuses a stored `cowork` row). Spec: docs/cowork-execution-contracts.md "Approval policies" and
// docs/cowork-spec.md (approval cards, occupancy, unattended work).
//
// What the projection decides, in order (each step beats every later one, `bypass` included):
//   1. a policy change in flight that narrows (pending, or failed with admission not open): deny. "first close affected
//      admission" - a call is never judged against the broader OLD state while its replacement is being installed;
//   2. `dangerouslyDisableSandbox: true`: deny ("Cowork rejects `dangerouslyDisableSandbox` when it would remove mandatory
//      confinement; there is no guest Bash fallback to host Bash"); Bash `allowNetwork: true` under a `none` network ceiling: deny;
//   3. a connector action (`mcp__<server>__<tool>`): the Cowork connector row, inside the ceiling's `connectors` grant;
//   4. a guest tool class (Read/Glob/Grep, Write, Edit/MultiEdit, Bash, Workflow): the host policy matrix;
//   5. anything else - an unknown class - is denied ("Unknown tool classes are not silently admitted").
// The host decides the path class (`ports.classifyPath`); the guest never does.
//
// The verdicts map to the approval events clients already understand and to nothing new: a deny is a typed deny with no
// event, an allow is silent, an ask is `approval_requested` / `approval_resolved` answered by `approval.respond` (plain
// Allow/Deny - a saved rule never becomes host authority). The card's summary leads with the workspace, the source revision
// and the requesting agent ("Approval cards belong to the target conversation and identify its workspace, operation,
// source revision and requesting agent"). Island and `approval.list` read the same broker, so they show it unchanged.

import { posix } from "node:path";
import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import { connectorFactsFor, isConnectorToolName, statedServerFromCanUseTool, type ConnectorPermissionSource } from "../agent/mcp/connector-permissions";
import { coworkConnectorVerdict, coworkHostDecision, type CoworkHostReason } from "../cowork/host-policy";
import type { CoworkTransitionSnapshot } from "../cowork/policy-transition";

/** What the host supplies for ONE Cowork conversation. Every member is read per call (a policy change reaches the next one). */
export interface CoworkApprovalPorts {
  /** Who the card belongs to: the workspace and the source revision the conversation is bound at. */
  identity(): { readonly workspaceId: string; readonly sourceRevision: number; readonly outputsFolder?: string };
  /** The conversation's CURRENT policy epoch (the machine's `epoch`). `/workspace/plan/<sid>/<epoch>` is the plan scratch of exactly this
   *  epoch; absent or not a non-negative safe integer, no path is the plan scratch. Never read from a path. */
  planScratchEpoch?(): number | undefined;
  /** The policy-transition machine's snapshot. `effective` is the policy and ceiling in force; while a narrowing is pending
   *  or failed, `admission` says whether new work may start. */
  snapshot(): CoworkTransitionSnapshot;
  /** The HOST's class for an absolute guest path: `admitted`, `shared-instructions`, `outputs`, `scratch`, `protected`,
   *  `outside`. Anything else (including an unknown string) is denied by the matrix. */
  classifyPath(absolutePath: string): string;
  /** An explicit applicable rule the host already resolved for this exact call (never a guest claim). */
  explicit?(call: { toolName: string; input: Record<string, unknown> }): "allow" | "deny" | undefined;
  /** Is the plan execution view (read-only source and memory mounts, scratch scoped to the policy epoch) installed? Absent
   *  or false: `allow-in-plan-view` is refused, never run in a writable view. */
  planViewInstalled?(): boolean;
}

export type CoworkProjection =
  | { readonly kind: "allow"; readonly bashReview: boolean }
  | { readonly kind: "ask"; readonly policy: ApprovalPolicy; readonly connector: boolean }
  | { readonly kind: "deny"; readonly policy: ApprovalPolicy; readonly reason: CoworkDenyReason;
      /** Set for a connector action's own deny, so the model is told which setting refused it. */
      readonly connector?: { readonly server: string; readonly tool: string; readonly setting: "allow" | "ask" | "deny" | undefined } };

export type CoworkDenyReason =
  | CoworkHostReason
  | "transition_pending" | "restart_required" | "sandbox_escape" | "network_ceiling" | "connector_not_granted" | "plan_view_missing" | "bad_state" | "policy_changed";

const FILE_READ = new Set(["Read", "Glob", "Grep"]);

/**
 * The directory a Glob `pattern` / Grep `glob` can reach, as an absolute path - or `"/"` (never admitted) for anything this
 * module cannot reason about lexically. An ALLOWLIST, not a blacklist: only `[A-Za-z0-9._ -]`, `*`, `?` and `/` are accepted.
 * Every other character - braces, extglob groups (`@(`, `+(`, `?(`, `*(`, `!(`), brackets, `|`, a backslash escape, `~` (a tool may
 * expand it to a home directory), `!` - makes the reach `"/"`, wherever it sits, prefix included. A `..` segment after the first
 * wildcard also names `"/"`. Otherwise the literal prefix (up to the last `/` before the first `*` or `?`) is resolved against `cwd`,
 * so `/workspace/.winter/**` and `../../../etc/*` name what they reach.
 */
function globReach(value: unknown, cwd: string): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (!/^[A-Za-z0-9._ \-*?/]+$/.test(value)) return "/";
  // A segment of only dots and question marks (`?.`, `.?`, `??`, `...`) can match `..`: not resolvable lexically. (A literal `..` is resolved below.)
  if (value.split("/").some(segment => /^[.?]{2,}$/.test(segment) && segment !== "..")) return "/";
  const meta = value.search(/[*?]/);
  if (meta >= 0 && value.slice(meta).split("/").includes("..")) return "/";
  const slash = meta < 0 ? -1 : value.lastIndexOf("/", meta);
  const literal = meta < 0 ? value : slash < 0 ? "" : value.slice(0, slash + 1);
  return posix.resolve(posix.isAbsolute(cwd) ? cwd : "/", literal === "" ? "." : literal);
}

/** The guest tool class, target path and any further paths the call can reach; `undefined` is an unknown class. */
function classFor(toolName: string, input: Record<string, unknown>, cwd: string): { tool: string; path: string | undefined; extra?: string[] } | undefined {
  const str = (value: unknown) => typeof value === "string" && value !== "" ? value : undefined;
  const target = (value: unknown): string | undefined => {
    const raw = str(value);
    if (raw === undefined || raw.includes("\0")) return undefined;
    return posix.resolve(posix.isAbsolute(cwd) ? cwd : "/", raw);
  };
  if (FILE_READ.has(toolName)) {
    // Glob and Grep default to the working directory; Read names its file.
    const named = toolName === "Read" ? input.file_path : input.path;
    const extra = toolName === "Glob" ? globReach(input.pattern, cwd) : toolName === "Grep" ? globReach(input.glob, cwd) : undefined;
    return { tool: "Read", path: named === undefined && toolName !== "Read" ? target(".") : target(named), ...(extra === undefined ? {} : { extra: [extra] }) };
  }
  if (toolName === "Write") return { tool: "Write", path: target(input.file_path) };
  if (toolName === "Edit" || toolName === "MultiEdit") return { tool: "Edit", path: target(input.file_path) };
  if (toolName === "Bash") return { tool: "Bash", path: undefined };
  if (toolName === "Workflow") return { tool: "Workflow", path: undefined };
  return undefined;
}

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/**
 * `outputs` and `scratch` mean the conversation's OWN folder only: `/workspace/outputs/<its session id>` and
 * `/workspace/.winter/scratch/<its session id>`. Whatever the host classified, a path in ANOTHER conversation's folder, or the
 * `/workspace/outputs` root itself, is `outside` (denied for every tool). The identity is the bridge's own session id, never the guest's.
 */
function ownFolderOnly(hostClass: string, absolute: string, sessionId: string | undefined, planEpoch?: number): string {
  if (hostClass !== "outputs" && hostClass !== "scratch" && hostClass !== "planScratch") return hostClass;
  if (sessionId === undefined || !SAFE_SESSION_SEGMENT.test(sessionId)) return "outside";
  // The plan scratch is `/workspace/plan/<sid>/<current epoch>`: both parts are the bridge's own, the epoch from the port.
  if (hostClass === "planScratch" && (planEpoch === undefined || !Number.isSafeInteger(planEpoch) || planEpoch < 0)) return "outside";
  const own = hostClass === "outputs" ? `/workspace/outputs/${sessionId}`
    : hostClass === "scratch" ? `/workspace/.winter/scratch/${sessionId}` : `/workspace/plan/${sessionId}/${planEpoch}`;
  return absolute === own || absolute.startsWith(`${own}/`) ? hostClass : "outside";
}

function deny(policy: ApprovalPolicy, reason: CoworkDenyReason, connector?: { server: string; tool: string; setting: "allow" | "ask" | "deny" | undefined }): CoworkProjection {
  return Object.freeze({ kind: "deny", policy, reason, ...(connector === undefined ? {} : { connector }) });
}

/**
 * The one projection. `cwd` is the conversation's guest working directory (relative paths resolve against it).
 * Never throws: a port that throws is a denial (`bad_state`).
 */
export function projectCoworkCall(
  ports: CoworkApprovalPorts,
  call: { toolName: string; input: Record<string, unknown>; cwd?: string; sessionId?: string; ctx?: unknown; connectors?: ConnectorPermissionSource; liveKeys?: ReadonlySet<string> },
): CoworkProjection {
  let snapshot: CoworkTransitionSnapshot;
  try { snapshot = ports.snapshot(); } catch { return deny("plan", "bad_state"); }
  const state = snapshot?.effective;
  if (!state || typeof state.policy !== "string") return deny("plan", "bad_state");
  const policy = state.policy;
  // 1. A narrowing in flight: admission is closed or unknown, so nothing new starts under the old, broader state.
  if (snapshot.phase !== "stable" && snapshot.kind !== "widening" && snapshot.admission !== "open") {
    return deny(policy, snapshot.phase === "failed" && snapshot.workspaceRestartRequired ? "restart_required" : "transition_pending");
  }
  try {
    const input = call.input ?? {};
    // 2. Confinement flags that no policy can waive.
    if (call.toolName === "Bash") {
      if (input.dangerouslyDisableSandbox === true) return deny(policy, "sandbox_escape");
      if (input.allowNetwork === true && state.ceiling.network !== "internet") return deny(policy, "network_ceiling");
    }
    // 3. Connectors: the separate Cowork row, inside the current connector grant.
    if (isConnectorToolName(call.toolName, call.liveKeys)) {
      const facts = call.connectors === undefined ? undefined
        : connectorFactsFor(call.connectors, call.toolName, call.cwd, statedServerFromCanUseTool(call.ctx), call.liveKeys);
      if (facts === undefined) return deny(policy, "connector_not_granted");
      if (!Array.isArray(state.ceiling.connectors) || !state.ceiling.connectors.includes(facts.server)) return deny(policy, "connector_not_granted");
      const verdict = coworkConnectorVerdict(facts.setting, facts.readOnly, policy);
      if (verdict === "deny") return deny(policy, "policy_table", { server: facts.server, tool: facts.tool, setting: facts.setting });
      return verdict === "ask" ? Object.freeze({ kind: "ask", policy, connector: true }) : Object.freeze({ kind: "allow", bashReview: false });
    }
    // 4/5. A guest tool class, or an unknown one.
    const cwd = call.cwd ?? "/";
    const klass = classFor(call.toolName, input, cwd);
    const explicit = ports.explicit?.({ toolName: call.toolName, input });
    // A file tool with no resolvable target, and Bash/Workflow, carry the path class `none` (the matrix denies the former).
    let planEpoch: number | undefined;
    try { planEpoch = ports.planScratchEpoch?.(); } catch { planEpoch = undefined; }
    const classify = (absolute: string): string => ownFolderOnly(ports.classifyPath(absolute), absolute, call.sessionId, planEpoch);
    const path = klass?.path === undefined ? "none" : classify(klass.path);
    const decide = (pathClass: string) => coworkHostDecision({
      // An unmapped wire name can never spell a known class by accident: it is prefixed.
      policy, tool: klass?.tool ?? `unmapped:${call.toolName}`, path: pathClass,
      ceiling: state.ceiling, alreadyAuthorized: explicit === "allow", explicitDeny: explicit === "deny",
    });
    // Every path the call can reach must pass: a pattern aimed outside the roots is a denial even when the search directory is admitted.
    const reached = (klass?.extra ?? []).map(extra => decide(classify(extra))).find(d => d.verdict === "deny");
    const decision = reached ?? decide(path);
    if (decision.verdict === "deny") return deny(policy, decision.reason);
    if (decision.verdict === "ask") return Object.freeze({ kind: "ask", policy, connector: false });
    if (decision.verdict === "allow-in-plan-view") {
      return ports.planViewInstalled?.() === true ? Object.freeze({ kind: "allow", bashReview: false }) : deny(policy, "plan_view_missing");
    }
    return Object.freeze({ kind: "allow", bashReview: decision.bashReview });
  } catch {
    return deny(policy, "bad_state");
  }
}

/** The model-facing text of a Cowork deny that is not the policy's own (plan and dont-ask use the bridge's existing wording). */
export function coworkDeniedMessage(toolName: string, reason: CoworkDenyReason): string {
  const head = `${toolName} was not run — `;
  switch (reason) {
    case "transition_pending": return `${head}the approval policy or capability ceiling of this conversation is changing and new work is not admitted until the change is complete. Nobody refused it; try again shortly.`;
    case "restart_required": return `${head}a narrower policy cannot be enforced for running work without restarting the workspace, and new work is not admitted until then. Nobody refused it.`;
    case "sandbox_escape": return `${head}Cowork never runs a command outside the guest's mandatory confinement, whatever the approval policy.`;
    case "network_ceiling": return `${head}this conversation's capability ceiling grants no network access.`;
    case "connector_not_granted": return `${head}this connector action is not inside the grants of this workspace.`;
    case "plan_view_missing": return `${head}plan mode's read-only execution view is not installed, so the action cannot run safely.`;
    case "policy_changed": return `${head}the approval policy of this conversation changed while the approval was pending, and the action is no longer permitted. Nobody refused it.`;
    case "unknown_tool_class": return `${head}Cowork has no approval class for this tool, and unknown tool classes are never admitted.`;
    case "unknown_policy": case "unknown_path_class": case "bad_state": return `${head}the host could not establish this conversation's approval state, so it fails closed.`;
    case "explicit_deny": return `${head}an explicit rule denies this action in every policy.`;
    case "path_protected": case "path_outside": return `${head}the target is outside the paths this conversation may use (protected runtime state or not admitted).`;
    case "path_unclassified": return `${head}the host has no approval rule for the target of this action.`;
    case "read_only_view": return `${head}the shared workspace instructions are read-only to tools; propose a change through the workspace instruction update, which asks the user.`;
    case "path_class_mismatch": return `${head}this operation applies only to the shared workspace instructions.`;
    case "ceiling": return `${head}this conversation's capability ceiling does not grant this kind of action.`;
    case "plan_scratch_only_in_plan": return `${head}the planning scratch is writable only while this conversation is in plan mode.`;
    case "policy_table": return `${head}the approval policy of this conversation does not permit it.`;
  }
}

/** The card's leading words: the workspace, the source revision and the requesting agent. */
export function coworkCardPrefix(ports: CoworkApprovalPorts, agentID: string | undefined): string {
  let who = "Cowork workspace (unknown)";
  try {
    const identity = ports.identity();
    // A conversation that lives in its outputs folder has no source revision to name (it reads "0"): name the folder instead.
    const where = typeof identity.outputsFolder === "string" && identity.outputsFolder !== "" ? `outputs folder ${identity.outputsFolder}` : `source revision ${identity.sourceRevision}`;
    who = `Cowork workspace ${identity.workspaceId} (${where}, agent ${agentID ?? "main"})`;
  } catch { /* the card still raises, with the generic prefix */ }
  return `${who} — `;
}
