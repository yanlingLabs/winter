import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import { PermissionGate } from "../../src/agent/gate";
import { connectorVerdict, type ConnectorPermission } from "../../src/agent/mcp/connector-permissions";
import * as hostPolicy from "../../src/cowork/host-policy";
import { COWORK_APPROVAL_POLICIES, COWORK_GUEST_TOOL_CLASSES, COWORK_PATH_CLASSES, coworkConnectorVerdict, coworkHostDecision, isCoworkApprovalPolicy,
  type CoworkHostDecisionInput, type CoworkHostVerdict, type CoworkVerdict } from "../../src/cowork/host-policy";
import type { CapabilityCeiling } from "../../src/cowork/types";

type Policy = (typeof COWORK_APPROVAL_POLICIES)[number];
const POLICIES: readonly Policy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];
const TOOLS = ["Read", "Write", "Edit", "Bash", "Workflow", "InstructionEdit"] as const;
const PATHS = ["admitted", "shared-instructions", "outputs", "scratch", "protected", "outside", "none"] as const;
type Tool = (typeof TOOLS)[number];
type Path = (typeof PATHS)[number];

const ceiling = (toolClasses: string[], hostServices: string[] = []): CapabilityCeiling => ({ toolClasses, hostServices, connectors: [], network: "none" });
const FULL = ceiling(["read", "write", "execute"], ["workspace.instructions.update"]);

// ── LITERAL copy of the spec table: docs/cowork-execution-contracts.md, "Approval policies" ─────────────────────────
// Columns: admitted reads | ordinary workspace edits | other admitted guest actions | shared workspace instruction edit.
// Cell text is the spec's, verbatim. This copy is deliberately independent of the module's own table.
const SPEC_TABLE: Readonly<Record<Policy, readonly [string, string, string, string]>> = {
  "plan": ["Allow", "Deny", "Planning/read operations only", "Deny"],
  "dont-ask": ["Allow", "Only if already authorized without a prompt", "Deny anything needing a prompt", "Deny"],
  "ask": ["Allow", "Ask unless already authorized", "Ask unless already authorized", "Ask"],
  "accept-edits": ["Allow", "Allow the bounded edit class", "Ask unless already authorized", "Ask"],
  "auto": ["Allow", "Allow", "Normal mutation class allowed; Bash review below; Workflow still asks", "Ask"],
  "bypass": ["Allow", "Allow", "Skip ordinary prompts within grants", "Ask"],
};

interface Expected { verdict: CoworkHostVerdict; bashReview: boolean }
const exp = (verdict: CoworkHostVerdict, flags: Partial<Omit<Expected, "verdict">> = {}): Expected => ({ verdict, bashReview: false, ...flags });
/** What each cell text means for a given tool and for "explicit allow applies". Workflow and Bash differ only where the spec says so (line 82). */
function meaning(text: string, tool: "Write/Edit" | "Bash" | "Workflow" | "InstructionEdit", authorized: boolean): Expected {
  switch (text) {
    case "Allow": return exp("allow");
    case "Deny": return exp("deny");
    case "Ask": return exp("ask");
    case "Only if already authorized without a prompt": return exp(authorized ? "allow" : "deny");
    case "Deny anything needing a prompt": return exp(authorized ? "allow" : "deny");
    case "Ask unless already authorized": return exp(authorized ? "allow" : "ask");
    case "Allow the bounded edit class": return exp("allow");
    // "Planning/read operations only": Bash runs only inside the read-only plan view, a DISTINCT verdict; Workflow "denies under plan" (line 82).
    case "Planning/read operations only": return tool === "Workflow" ? exp("deny") : exp("allow-in-plan-view");
    // "Bash review below": ALWAYS reported (only the hook's bashLooksSafe skips the review, never a saved rule); "Workflow still asks" unless already authorized.
    case "Normal mutation class allowed; Bash review below; Workflow still asks":
      return tool === "Workflow" ? exp(authorized ? "allow" : "ask") : exp("allow", { bashReview: true });
    // Workflow "follows bypass's ordinary no-prompt behavior within grants" (line 82).
    case "Skip ordinary prompts within grants": return exp("allow");
  }
  throw new Error(`unmapped spec cell: ${text}`);
}
function tableOutcome(policy: Policy, tool: Tool, authorized: boolean): Expected {
  const [reads, edits, other, instruction] = SPEC_TABLE[policy];
  switch (tool) {
    case "Read": return meaning(reads, "Write/Edit", authorized);
    case "Write": case "Edit": return meaning(edits, "Write/Edit", authorized);
    case "Bash": return meaning(other, "Bash", authorized);
    case "Workflow": return meaning(other, "Workflow", authorized);
    case "InstructionEdit": return meaning(instruction, "InstructionEdit", false); // no reusable approval exists for it
  }
}

/** Literal path rule grid: where the table applies and where the host denies regardless of policy. */
const PATH_RULES: Readonly<Record<Tool, Readonly<Record<Path, "table" | "deny">>>> = {
  Read:            { "admitted": "table", "shared-instructions": "table", "outputs": "table", "scratch": "table", "protected": "deny", "outside": "deny", "none": "deny" },
  Write:           { "admitted": "table", "shared-instructions": "deny",  "outputs": "table", "scratch": "table", "protected": "deny", "outside": "deny", "none": "deny" },
  Edit:            { "admitted": "table", "shared-instructions": "deny",  "outputs": "table", "scratch": "table", "protected": "deny", "outside": "deny", "none": "deny" },
  Bash:            { "admitted": "table", "shared-instructions": "deny",  "outputs": "deny", "scratch": "deny", "protected": "deny", "outside": "deny", "none": "table" },
  Workflow:        { "admitted": "table", "shared-instructions": "deny",  "outputs": "deny", "scratch": "deny", "protected": "deny", "outside": "deny", "none": "table" },
  InstructionEdit: { "admitted": "deny",  "shared-instructions": "table", "outputs": "deny", "scratch": "deny", "protected": "deny", "outside": "deny", "none": "deny" },
};
/** Literal ceiling requirement per tool (confinedToolVisibility, and CoworkInstructions.agentScope for InstructionEdit). */
const REQUIRES: Readonly<Record<Tool, { classes: string[]; services: string[] }>> = {
  Read: { classes: ["read"], services: [] }, Write: { classes: ["write"], services: [] }, Edit: { classes: ["read", "write"], services: [] },
  Bash: { classes: ["execute"], services: [] }, Workflow: { classes: ["execute"], services: [] },
  InstructionEdit: { classes: ["write"], services: ["workspace.instructions.update"] },
};
const ALL_CLASSES = ["read", "write", "execute"];
function* ceilings(): Generator<CapabilityCeiling> {
  for (let mask = 0; mask < 8; mask += 1) for (const service of [false, true])
    yield ceiling(ALL_CLASSES.filter((_, bit) => (mask >> bit) & 1), service ? ["workspace.instructions.update"] : []);
}
const granted = (tool: Tool, c: CapabilityCeiling) => REQUIRES[tool].classes.every(name => c.toolClasses.includes(name)) && REQUIRES[tool].services.every(name => c.hostServices.includes(name));

const decide = (over: Partial<CoworkHostDecisionInput> & Pick<CoworkHostDecisionInput, "policy" | "tool" | "path">) => coworkHostDecision({ ceiling: FULL, ...over });
const shape = (d: { verdict: CoworkHostVerdict; bashReview: boolean }) => ({ verdict: d.verdict, bashReview: d.bashReview });

test("the policy list is the protocol's, in order", () => {
  expect([...COWORK_APPROVAL_POLICIES]).toEqual([...ApprovalPolicy.options]);
  expect([...COWORK_APPROVAL_POLICIES]).toEqual([...POLICIES]);
  expect([...COWORK_GUEST_TOOL_CLASSES]).toEqual([...TOOLS]);
  expect([...COWORK_PATH_CLASSES]).toEqual([...PATHS]);
  for (const list of [COWORK_APPROVAL_POLICIES, COWORK_GUEST_TOOL_CLASSES, COWORK_PATH_CLASSES]) expect(Object.isFrozen(list)).toBe(true);
  for (const policy of POLICIES) expect(isCoworkApprovalPolicy(policy)).toBe(true);
  for (const bad of ["chat", "", "Plan", "__proto__", "constructor", undefined, null, 1, {}]) expect(isCoworkApprovalPolicy(bad)).toBe(false);
});

test("spec table copy: every policy row matches the module for every tool x path x ceiling x explicit-allow combination", () => {
  let cases = 0;
  for (const policy of POLICIES) for (const tool of TOOLS) for (const path of PATHS) for (const c of ceilings()) for (const alreadyAuthorized of [false, true]) {
    const got = coworkHostDecision({ policy, tool, path, ceiling: c, alreadyAuthorized });
    const hard = PATH_RULES[tool][path] === "deny" || !granted(tool, c);
    // Plan's planning scratch is writable inside the plan view: the one cell that differs from an admitted root.
    const planScratch = policy === "plan" && path === "scratch" && (tool === "Write" || tool === "Edit");
    const want = hard ? exp("deny") : planScratch ? exp("allow-in-plan-view") : tableOutcome(policy, tool, alreadyAuthorized);
    expect({ policy, tool, path, alreadyAuthorized, c, got: shape(got) }).toEqual({ policy, tool, path, alreadyAuthorized, c, got: want });
    expect(Object.isFrozen(got)).toBe(true);
    // Absent `alreadyAuthorized` is the same as false.
    if (!alreadyAuthorized) expect(shape(coworkHostDecision({ policy, tool, path, ceiling: c }))).toEqual(shape(got));
    cases += 1;
  }
  expect(cases).toBe(6 * 6 * 7 * 16 * 2);
});

test("spec table copy: the verdict grid for the well-formed cells, written out", () => {
  // [fresh, authorized] for Write/Edit | Bash | Workflow | InstructionEdit, read straight from the quoted cells.
  const GRID: Readonly<Record<Policy, readonly [string, string, string, string]>> = {
    "plan": ["deny/deny", "allow-in-plan-view/allow-in-plan-view", "deny/deny", "deny/deny"],
    "dont-ask": ["deny/allow", "deny/allow", "deny/allow", "deny/deny"],
    "ask": ["ask/allow", "ask/allow", "ask/allow", "ask/ask"],
    "accept-edits": ["allow/allow", "ask/allow", "ask/allow", "ask/ask"],
    "auto": ["allow/allow", "allow+review/allow+review", "ask/allow", "ask/ask"],
    "bypass": ["allow/allow", "allow/allow", "allow/allow", "ask/ask"],
  };
  const text = (d: ReturnType<typeof coworkHostDecision>) => `${d.verdict}${d.bashReview ? "+review" : ""}`;
  for (const policy of POLICIES) {
    const cells: Array<[Tool, string]> = [["Write", GRID[policy][0]], ["Edit", GRID[policy][0]], ["Bash", GRID[policy][1]], ["Workflow", GRID[policy][2]], ["InstructionEdit", GRID[policy][3]]];
    for (const [tool, cell] of cells) {
      const path: Path = tool === "InstructionEdit" ? "shared-instructions" : tool === "Bash" || tool === "Workflow" ? "none" : "admitted";
      const got = `${text(decide({ policy, tool, path }))}/${text(decide({ policy, tool, path, alreadyAuthorized: true }))}`;
      expect({ policy, tool, got }).toEqual({ policy, tool, got: cell });
    }
    expect(text(decide({ policy, tool: "Read", path: "admitted" }))).toBe("allow");
    expect(text(decide({ policy, tool: "Read", path: "shared-instructions" }))).toBe("allow");
  }
});

test("shared-instruction edit column: deny under plan AND dont-ask, ask everywhere else, bypass included, never softened by an explicit allow", () => {
  for (const policy of POLICIES) for (const alreadyAuthorized of [false, true]) {
    const d = decide({ policy, tool: "InstructionEdit", path: "shared-instructions", alreadyAuthorized });
    expect(d.verdict).toBe(policy === "plan" || policy === "dont-ask" ? "deny" : "ask");
    expect(d.reason).toBe("policy_table");
  }
  // The file tools never edit the shared file themselves: the read-only view plus the host write operation do.
  for (const policy of POLICIES) for (const tool of ["Write", "Edit", "Bash", "Workflow"] as const)
    expect(decide({ policy, tool, path: "shared-instructions" })).toMatchObject({ verdict: "deny", reason: "read_only_view" });
  for (const policy of POLICIES) expect(decide({ policy, tool: "InstructionEdit", path: "admitted" })).toMatchObject({ verdict: "deny", reason: "path_class_mismatch" });
});

test("hard denials beat every policy, bypass and an explicit allow included", () => {
  for (const policy of POLICIES) for (const tool of TOOLS) for (const alreadyAuthorized of [false, true]) {
    const path: Path = tool === "InstructionEdit" ? "shared-instructions" : tool === "Bash" || tool === "Workflow" ? "none" : "admitted";
    expect(decide({ policy, tool, path, alreadyAuthorized, explicitDeny: true })).toMatchObject({ verdict: "deny", reason: "explicit_deny" });
    for (const hard of ["protected", "outside"] as const) expect(decide({ policy, tool, path: hard, alreadyAuthorized })).toMatchObject({ verdict: "deny", reason: hard === "protected" ? "path_protected" : "path_outside" });
    expect(coworkHostDecision({ policy, tool, path, ceiling: ceiling([], []), alreadyAuthorized })).toMatchObject({ verdict: "deny", reason: "ceiling" });
  }
  // Under bypass specifically (the accepted product decision keeps the policy, not the confinement).
  expect(decide({ policy: "bypass", tool: "Read", path: "protected" }).verdict).toBe("deny");
  expect(decide({ policy: "bypass", tool: "Bash", path: "outside" }).verdict).toBe("deny");
  expect(coworkHostDecision({ policy: "bypass", tool: "Bash", path: "none", ceiling: ceiling(["read", "write"]) }).verdict).toBe("deny");
  expect(coworkHostDecision({ policy: "bypass", tool: "Write", path: "admitted", ceiling: ceiling(["read", "execute"]) }).verdict).toBe("deny");
  expect(coworkHostDecision({ policy: "bypass", tool: "Edit", path: "admitted", ceiling: ceiling(["write"]) }).verdict).toBe("deny"); // Edit needs read as well
  expect(coworkHostDecision({ policy: "bypass", tool: "InstructionEdit", path: "shared-instructions", ceiling: ceiling(["write"]) }).verdict).toBe("deny"); // and the host service
});

test("unknown tool classes, paths, policies and malformed inputs are denied, never admitted", () => {
  const unknownTools = ["", "read", "READ", "Read ", "Bash\n", "Task", "WebFetch", "Glob", "Grep", "NotebookEdit", "mcp__x__y", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "Instructionedit"];
  for (const policy of POLICIES) {
    for (const tool of unknownTools) expect(decide({ policy, tool, path: "admitted", alreadyAuthorized: true })).toMatchObject({ verdict: "deny", reason: "unknown_tool_class" });
    for (const tool of [undefined, null, 5, {}, [], ["Read"], true] as unknown[]) expect(decide({ policy, tool: tool as string, path: "admitted" })).toMatchObject({ verdict: "deny", reason: "unknown_tool_class" });
    for (const path of ["", "Admitted", "workspace", "constructor", "__proto__", undefined, null, 7] as unknown[]) expect(decide({ policy, tool: "Read", path: path as string })).toMatchObject({ verdict: "deny", reason: "unknown_path_class" });
  }
  for (const policy of ["chat", "", "Plan", "constructor", "__proto__", undefined, null, 0, {}] as unknown[])
    expect(decide({ policy: policy as Policy, tool: "Read", path: "admitted" })).toMatchObject({ verdict: "deny", reason: "unknown_policy" });
  // A malformed ceiling is a denial (never "no ceiling", never a throw).
  for (const bad of [undefined, null, {}, { toolClasses: "read", hostServices: [] }, { toolClasses: ["read"] }, 5] as unknown[])
    expect(coworkHostDecision({ policy: "bypass", tool: "Read", path: "admitted", ceiling: bad as CapabilityCeiling })).toMatchObject({ verdict: "deny", reason: "ceiling" });
  // `explicitDeny`/`alreadyAuthorized` only count when they are exactly `true`.
  expect(decide({ policy: "ask", tool: "Write", path: "admitted", alreadyAuthorized: "yes" as unknown as boolean }).verdict).toBe("ask");
  expect(decide({ policy: "ask", tool: "Write", path: "admitted", explicitDeny: 1 as unknown as boolean }).verdict).toBe("ask");
});

test("decisions are pure: frozen inputs are accepted, results do not alias the input, repeated calls agree", () => {
  const input = Object.freeze({ policy: "auto" as const, tool: "Bash", path: "none", ceiling: Object.freeze({ ...FULL }) });
  const first = coworkHostDecision(input), second = coworkHostDecision(input);
  expect(first).toEqual(second); expect(first).toEqual({ verdict: "allow", reason: "policy_table", bashReview: true });
  expect(Object.isFrozen(first)).toBe(true);
});

test("auto x Bash reports bashReview for every call, saved rule or not; no other cell ever does", () => {
  for (const alreadyAuthorized of [false, true]) expect(decide({ policy: "auto", tool: "Bash", path: "none", alreadyAuthorized })).toMatchObject({ verdict: "allow", bashReview: true });
  for (const policy of POLICIES) for (const tool of TOOLS) for (const path of PATHS) for (const alreadyAuthorized of [false, true]) {
    const d = decide({ policy, tool, path, alreadyAuthorized });
    expect(d.bashReview).toBe(policy === "auto" && tool === "Bash" && (path === "admitted" || path === "none"));
  }
});

test("fail-closed shape: plan x Bash is a distinct verdict that is not \"allow\", and nothing else ever uses it", () => {
  expect(decide({ policy: "plan", tool: "Bash", path: "none" })).toMatchObject({ verdict: "allow-in-plan-view", reason: "policy_table" });
  expect(decide({ policy: "plan", tool: "Bash", path: "none", alreadyAuthorized: true }).verdict).toBe("allow-in-plan-view");
  // A caller that only handles the three classic verdicts and switches on === "allow" never runs plan Bash in a writable view.
  expect(decide({ policy: "plan", tool: "Bash", path: "none" }).verdict === "allow").toBe(false);
  const inPlanView: string[] = [];
  for (const policy of POLICIES) for (const tool of TOOLS) for (const path of PATHS) for (const alreadyAuthorized of [false, true])
    if (decide({ policy, tool, path, alreadyAuthorized }).verdict === "allow-in-plan-view") inPlanView.push(`${policy}/${tool}/${path}/${alreadyAuthorized}`);
  expect(inPlanView).toEqual(["plan/Write/scratch/false", "plan/Write/scratch/true", "plan/Edit/scratch/false", "plan/Edit/scratch/true",
    "plan/Bash/admitted/false", "plan/Bash/admitted/true", "plan/Bash/none/false", "plan/Bash/none/true"]);
  // Plan allows plain "allow" only for reads.
  for (const tool of TOOLS.filter(name => name !== "Read")) for (const path of PATHS) expect(decide({ policy: "plan", tool, path }).verdict).not.toBe("allow");
});

test("outputs and conversation scratch (the conversation's OWN folders): read everywhere, write like an admitted root, plan's scratch only inside the plan view", () => {
  for (const policy of POLICIES) for (const alreadyAuthorized of [false, true]) {
    for (const path of ["outputs", "scratch"] as const) {
      expect(decide({ policy, tool: "Read", path, alreadyAuthorized })).toMatchObject({ verdict: "allow", reason: "policy_table" });
      for (const tool of ["Write", "Edit"] as const) {
        const admitted = decide({ policy, tool, path: "admitted", alreadyAuthorized }).verdict;
        const got = decide({ policy, tool, path, alreadyAuthorized }).verdict;
        expect({ policy, path, tool, got }).toEqual({ policy, path, tool, got: policy === "plan" && path === "scratch" ? "allow-in-plan-view" : admitted });
      }
      // Pathless tools and the host operation never take these classes.
      for (const tool of ["Bash", "Workflow"] as const) expect(decide({ policy, tool, path, alreadyAuthorized })).toMatchObject({ verdict: "deny", reason: "path_unclassified" });
      expect(decide({ policy, tool: "InstructionEdit", path, alreadyAuthorized })).toMatchObject({ verdict: "deny", reason: "path_class_mismatch" });
    }
  }
  // Plan x outputs is a plain Deny (outputs are deliverables, not planning scratch); the spec rows are otherwise unchanged.
  expect(decide({ policy: "plan", tool: "Write", path: "outputs" }).verdict).toBe("deny");
  expect(decide({ policy: "ask", tool: "Write", path: "outputs" }).verdict).toBe("ask");
  expect(decide({ policy: "auto", tool: "Edit", path: "outputs" }).verdict).toBe("allow");
  // An explicit deny and a missing ceiling still say why first.
  expect(decide({ policy: "ask", tool: "Read", path: "scratch", explicitDeny: true }).reason).toBe("explicit_deny");
  expect(coworkHostDecision({ policy: "ask", tool: "Read", path: "outputs", ceiling: ceiling([]) }).reason).toBe("ceiling");
  expect(decide({ policy: "plan", tool: "Write", path: "scratch", explicitDeny: true }).verdict).toBe("deny");
});

// ── connector row ────────────────────────────────────────────────────────────────────────────────────────────────
// LITERAL copy of the spec's connector table (docs/cowork-execution-contracts.md, "Give connectors an explicit Cowork row"):
//   | Explicit deny                 | Deny in every policy |
//   | Explicit ask                  | Ask even under bypass; deny under dont-ask and for plan-mode mutation |
//   | Explicit allow                | Allow except plan-mode mutation |
//   | Unset, classified read-only   | Allow |
//   | Unset mutation/unknown effect | plan/dont-ask deny; ask/accept-edits ask; auto/bypass allow |
// Written out per policy in the order plan, dont-ask, ask, accept-edits, auto, bypass; "readOnly" and "mutation" are the action classes.
type Row = Readonly<Record<"readOnly" | "mutation", readonly CoworkVerdict[]>>;
const CONNECTOR_SPEC: Readonly<Record<"deny" | "ask" | "allow" | "unset", Row>> = {
  deny:  { readOnly: ["deny", "deny", "deny", "deny", "deny", "deny"],         mutation: ["deny", "deny", "deny", "deny", "deny", "deny"] },
  ask:   { readOnly: ["ask", "deny", "ask", "ask", "ask", "ask"],              mutation: ["deny", "deny", "ask", "ask", "ask", "ask"] },
  allow: { readOnly: ["allow", "allow", "allow", "allow", "allow", "allow"],   mutation: ["deny", "allow", "allow", "allow", "allow", "allow"] },
  unset: { readOnly: ["allow", "allow", "allow", "allow", "allow", "allow"],   mutation: ["deny", "deny", "ask", "ask", "allow", "allow"] },
};
const SETTINGS: ReadonlyArray<["deny" | "ask" | "allow" | "unset", ConnectorPermission | undefined]> = [["deny", "deny"], ["ask", "ask"], ["allow", "allow"], ["unset", undefined]];

test("connector row: every setting x read-only x policy cell equals the spec table copy", () => {
  let cells = 0;
  for (const [name, setting] of SETTINGS) for (const kind of ["readOnly", "mutation"] as const) POLICIES.forEach((policy, index) => {
    expect({ name, kind, policy, got: coworkConnectorVerdict(setting, kind === "readOnly", policy) }).toEqual({ name, kind, policy, got: CONNECTOR_SPEC[name][kind][index]! });
    cells += 1;
  });
  expect(cells).toBe(4 * 2 * 6);
  // The cell the spec singles out: an explicit ask stays an ask under bypass.
  expect(coworkConnectorVerdict("ask", false, "bypass")).toBe("ask"); expect(coworkConnectorVerdict("ask", true, "bypass")).toBe("ask");
  expect(coworkConnectorVerdict("ask", false, "dont-ask")).toBe("deny"); expect(coworkConnectorVerdict("ask", false, "plan")).toBe("deny"); expect(coworkConnectorVerdict("ask", true, "plan")).toBe("ask");
});

test("connector row fails closed: unknown policy denies, unknown setting reads as ask, read-only must be exactly true", () => {
  for (const policy of ["chat", "", "__proto__", undefined, null, 3] as unknown[]) for (const setting of [undefined, "allow", "ask", "deny"] as const)
    expect(coworkConnectorVerdict(setting, true, policy as Policy)).toBe("deny");
  for (const garbage of ["", "ALLOW", "yes", 1, {}, null] as unknown[]) {
    const setting = garbage as ConnectorPermission;
    // A stored value nobody recognises is an "ask" (never unset, which could allow), as normalizeConnectorTable reads it.
    POLICIES.forEach((policy, index) => expect(coworkConnectorVerdict(setting, false, policy)).toBe(CONNECTOR_SPEC.ask.mutation[index]!));
    POLICIES.forEach((policy, index) => expect(coworkConnectorVerdict(setting, true, policy)).toBe(CONNECTOR_SPEC.ask.readOnly[index]!));
  }
  for (const loose of ["true", 1, "yes", undefined, null, {}] as unknown[]) POLICIES.forEach((policy, index) => expect(coworkConnectorVerdict(undefined, loose as boolean, policy)).toBe(CONNECTOR_SPEC.unset.mutation[index]!));
});

test("differential: the Cowork connector row equals connectorVerdict(code) everywhere except the cells where Code defers to its gate", () => {
  const differences: Array<{ setting: string; readOnly: boolean; policy: Policy; code: string; cowork: string }> = [];
  for (const [name, setting] of SETTINGS) for (const readOnly of [false, true]) for (const policy of POLICIES) {
    const code = connectorVerdict({ setting, readOnly, policy, mode: "code" }), cowork = coworkConnectorVerdict(setting, readOnly, policy);
    if (code !== cowork) differences.push({ setting: name, readOnly, policy, code, cowork });
  }
  // The ONLY differences: unset + not read-only, where Code answers "gate" (gate.ts decides) and Cowork spells the verdict.
  expect(differences).toEqual([
    { setting: "unset", readOnly: false, policy: "plan", code: "gate", cowork: "deny" },
    { setting: "unset", readOnly: false, policy: "dont-ask", code: "gate", cowork: "deny" },
    { setting: "unset", readOnly: false, policy: "ask", code: "gate", cowork: "ask" },
    { setting: "unset", readOnly: false, policy: "accept-edits", code: "gate", cowork: "ask" },
    { setting: "unset", readOnly: false, policy: "auto", code: "gate", cowork: "allow" },
    { setting: "unset", readOnly: false, policy: "bypass", code: "gate", cowork: "allow" },
  ]);
  // And the row never answers "gate".
  for (const [, setting] of SETTINGS) for (const readOnly of [false, true]) for (const policy of POLICIES) expect(["allow", "ask", "deny"]).toContain(coworkConnectorVerdict(setting, readOnly, policy));
});

test("differential: the explicit unset-mutation answers equal what Code's gate gives an external tool (dont-ask's card is declined by the engine)", () => {
  const gate = new PermissionGate();
  for (const policy of POLICIES) {
    const answer = gate.evaluate("mcp__fixture__action", policy);
    const asCowork = policy === "dont-ask" && answer === "ask" ? "deny" : answer; // engine.ts converts a still-"ask" call under dont-ask to deny
    expect({ policy, answer: coworkConnectorVerdict(undefined, false, policy) }).toEqual({ policy, answer: asCowork });
  }
});

test("pin: the current generic non-Code fallback is ask for every unset mutation, and the Cowork row does not inherit it", () => {
  // connectorVerdict has no Cowork mode. Chat and dispatch (not a dispatch child) answer "ask" for an unset mutation, whatever the policy;
  // code and a dispatch child answer "gate". If any of this changes, the spec's "explicit Cowork row" note (line 94) must be re-read.
  for (const policy of POLICIES) {
    for (const mode of ["chat", "dispatch"] as const) expect(connectorVerdict({ setting: undefined, readOnly: false, policy, mode })).toBe("ask");
    expect(connectorVerdict({ setting: undefined, readOnly: false, policy, mode: "code" })).toBe("gate");
    expect(connectorVerdict({ setting: undefined, readOnly: false, policy, mode: "dispatch", origin: "dispatch-child" })).toBe("gate");
  }
  // Where the fallback and the Cowork row disagree (the modes that must not be inherited): plan, dont-ask, auto, bypass.
  const disagree = POLICIES.filter(policy => coworkConnectorVerdict(undefined, false, policy) !== connectorVerdict({ setting: undefined, readOnly: false, policy, mode: "chat" }));
  expect(disagree).toEqual(["plan", "dont-ask", "auto", "bypass"]);
  // The explicit settings and the read-only default are the same under the fallback and in Cowork.
  for (const [, setting] of SETTINGS.filter(([name]) => name !== "unset")) for (const readOnly of [false, true]) for (const policy of POLICIES)
    expect(coworkConnectorVerdict(setting, readOnly, policy)).toBe(connectorVerdict({ setting, readOnly, policy, mode: "chat" }) as CoworkVerdict); // explicit and read-only cells never defer
});

// ── anti-wiring ──────────────────────────────────────────────────────────────────────────────────────────────────
const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
test("wired behind the refusal: only the transition module, the instruction owner and the Cowork approval projection reach the matrix; no barrel export; type-only imports", () => {
  const packages = sourceDirectory(), module = join(packages, "core", "src", "cowork", "host-policy.ts"), sibling = join(packages, "core", "src", "cowork", "policy-transition.ts");
  expect(existsSync(module)).toBe(true);
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  expect(sources.length).toBeGreaterThan(100); expect(sources).toContain(module);
  // Who may name the matrix: the classifier (policy-transition.ts), the shared-guidance edit's agentScope (instructions.ts) and the Cowork
  // approval projection (runtime-sdk/cowork-approval.ts, reached only from the approval bridge's injected `cowork` port; see
  // test/runtime-sdk/cowork-approval.test.ts, which also proves production never supplies that port).
  const offenders = new Set<string>();
  for (const file of sources.filter(candidate => candidate !== module && candidate !== sibling)) {
    const text = readFileSync(file, "utf8");
    for (const needle of ["./host-policy", "cowork/host-policy", "coworkHostDecision", "coworkConnectorVerdict", "COWORK_APPROVAL_POLICIES", "COWORK_GUEST_TOOL_CLASSES", "COWORK_PATH_CLASSES", "isCoworkApprovalPolicy", "CoworkHostDecision"])
      if (text.includes(needle)) offenders.add(basename(file));
  }
  expect([...offenders].sort()).toEqual(["cowork-approval.ts", "instructions.ts"]);
  expect(existsSync(join(packages, "core", "src", "cowork", "index.ts"))).toBe(false);
  expect(readFileSync(join(packages, "core", "src", "index.ts"), "utf8")).not.toMatch(/host-policy|policy-transition|from "\.\/cowork/);
  const own = readFileSync(module, "utf8");
  expect([...own.matchAll(/^import (type )?[^;]*from "([^"]+)"/gm)].map(match => `${match[1] ? "type " : ""}${match[2]}`).sort())
    .toEqual(["type ../agent/mcp/connector-permissions", "type ./types", "type @yanlinglabs/winter-protocol"]);
  expect(own).not.toMatch(/^import (?!type )/m);
  expect(Object.keys(hostPolicy).sort()).toEqual(["COWORK_APPROVAL_POLICIES", "COWORK_GUEST_TOOL_CLASSES", "COWORK_PATH_CLASSES", "coworkConnectorVerdict", "coworkHostDecision", "isCoworkApprovalPolicy"]);
  // No clock, no I/O, no environment: the module is a table and two functions.
  expect(own).not.toMatch(/\b(Date\.now|new Date|process\.|Bun\.|node:|fetch\(|setTimeout|Math\.random)\b/);
});
