// Cowork HOST POLICY MATRIX (unwired): the pure, table-driven approval decisions the spec gives Cowork
// ("Approval policies" in docs/cowork-execution-contracts.md; line numbers below are the grep -n lines of
// that file at the time of writing, and every cited cell is QUOTED so a drift in numbering stays checkable).
//
// ── What this module is, and is not ──────────────────────────────────────────────────────────────────
// It answers ONE question for the guest tool classes: given the conversation's approval policy, the tool
// class, the class of path it targets and the EFFECTIVE capability ceiling, is the call allowed, asked or
// denied by the host policy check? It decides nothing else:
//   - it is NOT the Bash reviewer ("Preserve Winter's existing `auto` reviewer semantics ...", line 82):
//     Bash under `auto` is `allow` here with `bashReview: true` (false when an explicit allow applies:
//     "recognized read-only/user-allowed commands may skip model review"); the reviewer is a separate layer;
//   - it is NOT the plan execution view ("Enforce `plan` below command classification ...", line 74):
//     Bash under `plan` is `allow` here with `planView: true`, meaning "only inside the read-only plan
//     view"; the mount view is what makes it read-only, never this function and never command
//     classification;
//   - it does not intersect grants: the caller passes the already-intersected EFFECTIVE ceiling
//     (`intersectCeilings` over Project ceiling and conversation restrictions);
//   - it does not resolve saved rules: the caller resolves explicit rules first ("The following defaults
//     apply after hard denials and explicit applicable rules", line 63) and passes the result in as
//     `explicitDeny` / `alreadyAuthorized`.
// Nothing in `src/` imports this module. It has no wiring, no barrel export, no I/O and no state.
//
// ── The table (spec lines 65-72, cell text verbatim) ──────────────────────────────────────────────────
//   plan          Allow | Deny                                  | Planning/read operations only                       | Deny
//   dont-ask      Allow | Only if already authorized without a prompt | Deny anything needing a prompt                 | Deny
//   ask           Allow | Ask unless already authorized         | Ask unless already authorized                       | Ask
//   accept-edits  Allow | Allow the bounded edit class          | Ask unless already authorized                       | Ask
//   auto          Allow | Allow                                 | Normal mutation class allowed; Bash review below; Workflow still asks | Ask
//   bypass        Allow | Allow                                 | Skip ordinary prompts within grants                 | Ask
// Columns: admitted reads | ordinary workspace edits | other admitted guest actions | shared workspace
// instruction edit.
//
// Decisions the table leaves to this module (each is a REVIEW NEEDED in the PR):
//   - "ordinary workspace edits" are the Write and Edit tools on an `admitted` path;
//   - "other admitted guest actions" are Bash and Workflow. Workflow has its own sentence at line 82:
//     "Workflow asks under auto and ordinary prompt policies unless already appropriately authorized,
//     denies under plan or unresolved dont-ask, and follows bypass's ordinary no-prompt behavior within
//     grants". The table's `auto` cell repeats "Workflow still asks";
//   - the "shared workspace instruction edit" column is the host's content-bound write operation
//     (`workspace.instructions.update`), modelled as the tool class `InstructionEdit`. A direct Write,
//     Edit or Bash against the shared-instruction path is DENIED: the spec says the agent edit is "enforced
//     by a read-only tool view and content-bound host write operation, not a path-hook convention alone"
//     (docs/cowork-spec.md, shared instructions section) and "Tool code cannot edit ... protected shared
//     instructions" (docs/cowork-spec.md, host authority section);
//   - the Ask in the instruction column does not depend on `alreadyAuthorized`: no reusable approval token
//     exists for it (`CoworkInstructions.updateAgent` binds each card to the exact copied content);
//   - the required ceiling class per tool follows `confinedToolVisibility` (guest-runtime.ts): Read needs
//     `read`, Write needs `write`, Edit needs `read` and `write`, Bash and Workflow need `execute`. The
//     InstructionEdit class follows `CoworkInstructions.agentScope`: `write` plus the host service
//     `workspace.instructions.update`.
//
// ── Order of evaluation (every earlier step beats every later one, bypass included) ───────────────────
//   1. unknown policy, tool class or path class       deny  ("Unknown tool classes are not silently admitted.", line 78)
//   2. explicit deny from a saved rule                deny  ("Explicit deny ... apply under every policy.", line 78)
//   3. protected runtime state / outside admitted     deny  ("protected runtime state, source/egress constraints and host
//                                                           capability boundaries apply under every policy"; "`bypass` never
//                                                           disables Linux control-state confinement or grants access to the
//                                                           Mac.", line 78)
//   4. effective ceiling lacks the class              deny  ("Skip ordinary prompts within grants", line 72)
//   5. the policy table above
//
// Nothing here may grow a new `CoworkErrorCode`: a denial is a value, not an error.

import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import type { ConnectorPermission } from "../agent/mcp/connector-permissions";
import type { CapabilityCeiling } from "./types";

export type CoworkVerdict = "allow" | "ask" | "deny";

/** The six policies, in the protocol's order. A test pins this against the protocol enum. */
export const COWORK_APPROVAL_POLICIES: readonly ApprovalPolicy[] = Object.freeze(["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"] as const);

/** The guest tool classes this matrix knows. Anything else is an unknown class and is denied. */
export type CoworkGuestToolClass = "Read" | "Write" | "Edit" | "Bash" | "Workflow" | "InstructionEdit";
export const COWORK_GUEST_TOOL_CLASSES: readonly CoworkGuestToolClass[] = Object.freeze(["Read", "Write", "Edit", "Bash", "Workflow", "InstructionEdit"] as const);

/**
 * What a call targets, as the HOST classified it (never the guest):
 *  - `admitted`             an admitted source root or the Project memory directory;
 *  - `shared-instructions`  the shared workspace instruction file (`/workspace/.winter/WINTER.md`);
 *  - `protected`            run homes, SDK stores, another conversation's store, the protected `.winter` skeleton;
 *  - `outside`              anything not admitted;
 *  - `none`                 the call names no path (Bash, Workflow), or the host could not classify one.
 */
export type CoworkPathClass = "admitted" | "shared-instructions" | "protected" | "outside" | "none";
export const COWORK_PATH_CLASSES: readonly CoworkPathClass[] = Object.freeze(["admitted", "shared-instructions", "protected", "outside", "none"] as const);

export type CoworkHostReason =
  | "policy_table"          // the spec table decided
  | "unknown_policy" | "unknown_tool_class" | "unknown_path_class"
  | "explicit_deny"         // a saved explicit deny applies
  | "path_protected" | "path_outside" | "path_unclassified"
  | "read_only_view"        // a tool aimed at the shared instruction file: only the host write operation may edit it
  | "path_class_mismatch"   // InstructionEdit for anything but the shared instruction file
  | "ceiling";              // the effective ceiling does not grant the class (or is malformed)

export interface CoworkHostDecisionInput {
  /** The conversation's own policy (never the Project default). */
  readonly policy: ApprovalPolicy;
  /** The guest tool class. A string on purpose: a class this matrix does not know is data, and is denied. */
  readonly tool: string;
  /** The host's classification of the call's target. A string for the same reason. */
  readonly path: string;
  /** The EFFECTIVE ceiling: Project ceiling intersected with the conversation's restrictions. */
  readonly ceiling: CapabilityCeiling;
  /** The caller resolved an explicit applicable allow (saved rule, delegation bound) for exactly this action. */
  readonly alreadyAuthorized?: boolean;
  /** The caller resolved an explicit applicable deny for this action. */
  readonly explicitDeny?: boolean;
}

export interface CoworkHostDecision {
  readonly verdict: CoworkVerdict;
  readonly reason: CoworkHostReason;
  /** `auto` x Bash: the Winter reviewer semantics still apply on top of this allow (line 82). */
  readonly bashReview: boolean;
  /** `plan` x Bash: the allow holds only inside the read-only plan execution view (line 74). */
  readonly planView: boolean;
}

interface Outcome { readonly verdict: CoworkVerdict; readonly bashReview?: true; readonly planView?: true }
/** `fresh`: no explicit allow applies; `authorized`: the caller resolved one. */
interface Cell { readonly fresh: Outcome; readonly authorized: Outcome }
const outcome = (verdict: CoworkVerdict, flag?: "bashReview" | "planView"): Outcome =>
  Object.freeze({ verdict, ...(flag === "bashReview" ? { bashReview: true as const } : {}), ...(flag === "planView" ? { planView: true as const } : {}) });
const cell = (fresh: CoworkVerdict, authorized: CoworkVerdict = fresh): Cell => Object.freeze({ fresh: outcome(fresh), authorized: outcome(authorized) });

interface Row { readonly edit: Cell; readonly bash: Cell; readonly workflow: Cell; readonly instruction: Cell }
/** Admitted reads are Allow in every row, so they have no cell. */
const TABLE: Readonly<Record<ApprovalPolicy, Row>> = Object.freeze({
  // "Deny" | "Planning/read operations only" | "Deny". Workflow: "denies under plan" (line 82).
  "plan": Object.freeze({ edit: cell("deny"), bash: Object.freeze({ fresh: outcome("allow", "planView"), authorized: outcome("allow", "planView") }), workflow: cell("deny"), instruction: cell("deny") }),
  // "Only if already authorized without a prompt" | "Deny anything needing a prompt" | "Deny".
  "dont-ask": Object.freeze({ edit: cell("deny", "allow"), bash: cell("deny", "allow"), workflow: cell("deny", "allow"), instruction: cell("deny") }),
  // "Ask unless already authorized" | "Ask unless already authorized" | "Ask".
  "ask": Object.freeze({ edit: cell("ask", "allow"), bash: cell("ask", "allow"), workflow: cell("ask", "allow"), instruction: cell("ask") }),
  // "Allow the bounded edit class" | "Ask unless already authorized" | "Ask".
  "accept-edits": Object.freeze({ edit: cell("allow"), bash: cell("ask", "allow"), workflow: cell("ask", "allow"), instruction: cell("ask") }),
  // "Allow" | "Normal mutation class allowed; Bash review below; Workflow still asks" | "Ask". Bash review: line 82,
  // "recognized read-only/user-allowed commands may skip model review", so an explicit allow does not demand it.
  "auto": Object.freeze({ edit: cell("allow"), bash: Object.freeze({ fresh: outcome("allow", "bashReview"), authorized: outcome("allow") }), workflow: cell("ask", "allow"), instruction: cell("ask") }),
  // "Allow" | "Skip ordinary prompts within grants" | "Ask". Workflow "follows bypass's ordinary no-prompt behavior".
  "bypass": Object.freeze({ edit: cell("allow"), bash: cell("allow"), workflow: cell("allow"), instruction: cell("ask") }),
});

const POLICY_SET: ReadonlySet<string> = new Set(COWORK_APPROVAL_POLICIES);
const TOOL_SET: ReadonlySet<string> = new Set(COWORK_GUEST_TOOL_CLASSES);
const PATH_SET: ReadonlySet<string> = new Set(COWORK_PATH_CLASSES);

export const isCoworkApprovalPolicy = (value: unknown): value is ApprovalPolicy => typeof value === "string" && POLICY_SET.has(value);

const decision = (verdict: CoworkVerdict, reason: CoworkHostReason, flags: { bashReview?: boolean; planView?: boolean } = {}): CoworkHostDecision =>
  Object.freeze({ verdict, reason, bashReview: flags.bashReview === true, planView: flags.planView === true });
const DENY = (reason: CoworkHostReason): CoworkHostDecision => decision("deny", reason);

function ceilingHas(ceiling: CapabilityCeiling, tool: CoworkGuestToolClass): boolean {
  // A malformed ceiling is a denial, never a crash and never "no ceiling".
  if (ceiling === null || typeof ceiling !== "object" || !Array.isArray(ceiling.toolClasses) || !Array.isArray(ceiling.hostServices)) return false;
  const has = (name: string) => ceiling.toolClasses.includes(name);
  switch (tool) {
    case "Read": return has("read");
    case "Write": return has("write");
    case "Edit": return has("read") && has("write"); // confinedToolVisibility: Edit is only visible with both
    case "Bash": case "Workflow": return has("execute");
    case "InstructionEdit": return has("write") && ceiling.hostServices.includes("workspace.instructions.update");
  }
}

/** The one decision. Pure: no clock, no I/O, no mutation of `input`. */
export function coworkHostDecision(input: CoworkHostDecisionInput): CoworkHostDecision {
  const { policy, tool, path } = input;
  // 1. Unknown anything is denied (line 78: "Unknown tool classes are not silently admitted.").
  if (typeof policy !== "string" || !POLICY_SET.has(policy)) return DENY("unknown_policy");
  if (typeof tool !== "string" || !TOOL_SET.has(tool)) return DENY("unknown_tool_class");
  if (typeof path !== "string" || !PATH_SET.has(path)) return DENY("unknown_path_class");
  const toolClass = tool as CoworkGuestToolClass, pathClass = path as CoworkPathClass;
  // 2. An explicit applicable deny wins in every policy (line 78: "Explicit deny ... apply under every policy").
  if (input.explicitDeny === true) return DENY("explicit_deny");
  // 3. Hard path boundaries hold under every policy, bypass included (line 78).
  if (pathClass === "protected") return DENY("path_protected");
  if (pathClass === "outside") return DENY("path_outside");
  // 4. The effective ceiling is the grant "within" which bypass skips prompts (line 72).
  if (!ceilingHas(input.ceiling, toolClass)) return DENY("ceiling");
  const row = TABLE[policy as ApprovalPolicy];
  switch (toolClass) {
    case "Read":
      // "Admitted reads | Allow" in every row. The shared instruction file is read through its admitted view.
      if (pathClass === "none") return DENY("path_unclassified");
      return decision("allow", "policy_table");
    case "Write": case "Edit":
      if (pathClass === "shared-instructions") return DENY("read_only_view");
      if (pathClass !== "admitted") return DENY("path_unclassified");
      return fromCell(row.edit, input.alreadyAuthorized === true);
    case "Bash": case "Workflow":
      // A shell or workflow cannot be classified by one target path; the caller passes `none` (or `admitted`).
      if (pathClass === "shared-instructions") return DENY("read_only_view");
      return fromCell(toolClass === "Bash" ? row.bash : row.workflow, input.alreadyAuthorized === true);
    case "InstructionEdit":
      if (pathClass !== "shared-instructions") return DENY("path_class_mismatch");
      return fromCell(row.instruction, input.alreadyAuthorized === true);
  }
}

function fromCell(selected: Cell, authorized: boolean): CoworkHostDecision {
  const chosen = authorized ? selected.authorized : selected.fresh;
  return decision(chosen.verdict, "policy_table", { bashReview: chosen.bashReview === true, planView: chosen.planView === true });
}

// ── The connector row (spec lines 84-92, "Give connectors an explicit Cowork row in the existing connector system") ──
// Line 89 is the cell the brief singles out: "Explicit ask | Ask even under bypass; deny under dont-ask and for plan-mode mutation".
//   Explicit deny                 Deny in every policy
//   Explicit ask                  Ask even under bypass; deny under dont-ask and for plan-mode mutation
//   Explicit allow                Allow except plan-mode mutation
//   Unset, classified read-only   Allow
//   Unset mutation/unknown effect plan/dont-ask deny; ask/accept-edits ask; auto/bypass allow
// "Existing connector rules must be applied explicitly rather than letting the new mode inherit the current
// generic non-Code fallback" (line 94): `connectorVerdict` answers `"ask"` for every unset mutation outside
// code and a dispatch child, and `"gate"` (the Code gate decides) inside it. Cowork is neither: this function
// spells all six answers and never returns `"gate"`. Read-only is the admitted server's annotation, "metadata,
// not a security proof or a grant" (line 94); the caller supplies `readOnly === true` only from the admitted
// server/action's canonical host record. "Within current grants": whether the connector is in the effective
// ceiling's `connectors` list is the caller's check, before this row.
export function coworkConnectorVerdict(setting: ConnectorPermission | undefined, readOnly: boolean, policy: ApprovalPolicy): CoworkVerdict {
  if (typeof policy !== "string" || !POLICY_SET.has(policy)) return "deny";
  const reads = readOnly === true, mutation = !reads;
  // An unrecognised stored value is read as "ask", never as unset (`normalizeConnectorTable` does the same).
  const stored: ConnectorPermission | undefined = setting === undefined ? undefined : setting === "allow" || setting === "deny" ? setting : "ask";
  // Explicit deny | Deny in every policy.
  if (stored === "deny") return "deny";
  // Explicit allow | Allow except plan-mode mutation.
  if (stored === "allow") return policy === "plan" && mutation ? "deny" : "allow";
  // Explicit ask | Ask even under bypass; deny under dont-ask and for plan-mode mutation.
  if (stored === "ask") {
    if (policy === "plan" && mutation) return "deny";
    if (policy === "dont-ask") return "deny";
    return "ask";
  }
  // Unset, classified read-only | Allow.
  if (reads) return "allow";
  // Unset mutation/unknown effect | plan/dont-ask deny; ask/accept-edits ask; auto/bypass allow.
  switch (policy) {
    case "plan": case "dont-ask": return "deny";
    case "ask": case "accept-edits": return "ask";
    case "auto": case "bypass": return "allow";
  }
}
