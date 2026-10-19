// Cowork approvals projected into the real approval bridge, behind the refusal, with fakes: the six policies x the guest tool
// classes, the shared-instruction-edit column, unknown classes, the separate connector row, narrowing, the cards the clients
// already understand, the island and pending surfaces, unattended turns, and the proofs that nothing else is touched.
import { afterEach, expect, jest, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CanUseTool, PermissionResult } from "@yanlinglabs/winter-agent-sdk";
import { ApprovalRequestedEvent, type ApprovalPolicy, type NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import type { ConnectorPermissionSource, ConnectorPermissionTable } from "../../src/agent/mcp/connector-permissions";
import { QuestionBroker } from "../../src/agent/questions";
import { IslandRegistry } from "../../src/island/registry";
import { canUseToolFor, DISPATCH_CHILD_APPROVAL_TIMEOUT_MS, NO_PARK_TIMEOUT_MS, type BridgeLogger } from "../../src/runtime-sdk/approval-bridge";
import { coworkDeniedMessage, projectCoworkCall, type CoworkApprovalPorts } from "../../src/runtime-sdk/cowork-approval";
import { CoworkPolicyTransitionMachine, type CoworkPolicyState, type CoworkTransitionPorts } from "../../src/cowork/policy-transition";
import { coworkHostDecision } from "../../src/cowork/host-policy";
import type { CapabilityCeiling } from "../../src/cowork/types";
import { isUnrunnableSessionMode, runnableModeOf } from "../../src/sessions/session-mode";

afterEach(() => { jest.useRealTimers(); });
const SESSION = "cowork-1", NOW = 1_700_000_000_000;
const silent: BridgeLogger = { info: () => {}, error: () => {} };
const POLICIES: readonly ApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];
const FULL: CapabilityCeiling = { toolClasses: ["read", "write", "execute"], hostServices: ["workspace.instructions.update"], connectors: ["fx"], network: "none" };
const state = (policy: ApprovalPolicy, ceiling: CapabilityCeiling = FULL): CoworkPolicyState => ({ policy, ceiling });

/** What the host would answer for a guest path (the guest never classifies its own paths). */
function classifyPath(path: string): string {
  if (path === "/workspace/.winter/WINTER.md") return "shared-instructions";
  // Roots and every conversation's folder are "outputs"/"scratch" to the host; the projection narrows them to the OWN folder.
  if (path === "/workspace/.winter/scratch" || path.startsWith("/workspace/.winter/scratch/")) return "scratch";
  if (path === "/workspace/outputs" || path.startsWith("/workspace/outputs/")) return "outputs";
  if (path.startsWith("/workspace/.winter/") || path === "/workspace/.winter" || path.startsWith("/proc")) return "protected";
  if (path.startsWith("/workspace/repos/")) return "admitted";
  return "outside";
}

type Bridge = { (...args: Parameters<CanUseTool>): Promise<PermissionResult>; withdrawPending(callId: string): boolean };
interface Hold { closeAdmission?: Promise<void>; drain?: Promise<"drained" | "restart-required">; installView?: Promise<void> }
function build(initial: CoworkPolicyState, over: {
  ports?: Partial<CoworkApprovalPorts>; hold?: Hold; connectors?: ConnectorPermissionSource; turnOrigin?: () => string | undefined;
  planBridge?: Parameters<typeof canUseToolFor>[0]["planBridge"]; questions?: QuestionBroker; review?: Parameters<typeof canUseToolFor>[0]["coworkBashReview"];
} = {}) {
  const hold: Hold = over.hold ?? {};
  const transitionPorts: CoworkTransitionPorts = {
    closeAdmission: () => hold.closeAdmission ?? Promise.resolve(),
    drain: () => hold.drain ?? Promise.resolve("drained"),
    installView: () => hold.installView ?? Promise.resolve(),
  };
  const machine = new CoworkPolicyTransitionMachine(initial, transitionPorts);
  const ports: CoworkApprovalPorts = { identity: () => ({ workspaceId: "ws-7", sourceRevision: 12 }), snapshot: () => machine.snapshot(), classifyPath, planViewInstalled: () => true, ...over.ports };
  const events: NewSessionEvent[] = [], approvals = new ApprovalBroker(), questions = over.questions ?? new QuestionBroker();
  // The bridge never returns `null` (its header says so); the SDK type allows it, the tests read results directly.
  const canUse = canUseToolFor({
    sessionId: SESSION, mode: "code", policy: "auto", approvals, questions, gate: new PermissionGate(), cwd: "/workspace/repos/app",
    emit: e => { events.push(e); }, log: silent, now: () => NOW, cowork: ports,
    ...(over.connectors === undefined ? {} : { connectors: over.connectors }),
    ...(over.turnOrigin === undefined ? {} : { turnOrigin: over.turnOrigin }),
    ...(over.planBridge === undefined ? {} : { planBridge: over.planBridge }),
    ...(over.review === undefined ? {} : { coworkBashReview: over.review }),
  }) as unknown as Bridge;
  return { machine, events, approvals, questions, canUse, ports };
}
type Harness = ReturnType<typeof build>;

function ctx(over: Record<string, unknown> = {}): Parameters<CanUseTool>[2] {
  return { signal: (over.controller as AbortController | undefined)?.signal ?? new AbortController().signal, toolUseID: "tu1", requestId: "req-1", ...over } as Parameters<CanUseTool>[2];
}
const tick = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

type Outcome = "allow" | "deny" | "card";
/** Runs one call to its first observable result. A card is answered with `answer` (default: leave it pending and report "card"). */
async function outcome(h: Harness, toolName: string, input: Record<string, unknown>, over: Record<string, unknown> = {}): Promise<{ result: PermissionResult | undefined; kind: Outcome }> {
  const pending = h.canUse(toolName, input, ctx(over));
  await tick();
  if (h.approvals.list(SESSION).length > 0) {
    const callId = (over.toolUseID as string | undefined) ?? "tu1";
    h.approvals.resolve(SESSION, callId, false, "test-cleanup");
    return { result: await pending, kind: "card" };
  }
  const result = await pending;
  return { result, kind: result.behavior === "allow" ? "allow" : "deny" };
}

const READ = ["Read", { file_path: "/workspace/repos/app/a.ts" }] as const;
const WRITE = ["Write", { file_path: "/workspace/repos/app/a.ts", content: "x" }] as const;
const EDIT = ["Edit", { file_path: "/workspace/repos/app/a.ts", old_string: "a", new_string: "b" }] as const;
const BASH = ["Bash", { command: "ls" }] as const;
const WORKFLOW = ["Workflow", { script: "export default 1" }] as const;

// ── the six policies x the guest tool classes, written out from the spec table ─────────────────────────────────────────
// docs/cowork-execution-contracts.md "Approval policies": Reads Allow everywhere; edits Deny / only-if-authorized / Ask /
// Allow / Allow / Allow; other actions (Bash) plan-view / Deny / Ask / Ask / Allow (reviewed) / Allow; Workflow Deny /
// Deny / Ask / Ask / Ask / Allow.
const GRID: Readonly<Record<ApprovalPolicy, Readonly<Record<"Read" | "Write" | "Edit" | "Bash" | "Workflow", Outcome>>>> = {
  "plan":         { Read: "allow", Write: "deny", Edit: "deny", Bash: "allow", Workflow: "deny" },
  "dont-ask":     { Read: "allow", Write: "deny", Edit: "deny", Bash: "deny", Workflow: "deny" },
  "ask":          { Read: "allow", Write: "card", Edit: "card", Bash: "card", Workflow: "card" },
  "accept-edits": { Read: "allow", Write: "allow", Edit: "allow", Bash: "card", Workflow: "card" },
  "auto":         { Read: "allow", Write: "allow", Edit: "allow", Bash: "allow", Workflow: "card" },
  "bypass":       { Read: "allow", Write: "allow", Edit: "allow", Bash: "allow", Workflow: "allow" },
};

test("every policy x guest tool class takes the spec table's outcome through the bridge, with the right events", async () => {
  const calls = { Read: READ, Write: WRITE, Edit: EDIT, Bash: BASH, Workflow: WORKFLOW } as const;
  for (const policy of POLICIES) for (const [name, [tool, input]] of Object.entries(calls) as Array<[keyof typeof calls, (typeof calls)[keyof typeof calls]]>) {
    const h = build(state(policy));
    const { result, kind } = await outcome(h, tool, { ...input });
    expect({ policy, name, kind }).toEqual({ policy, name, kind: GRID[policy][name] });
    // A deny and an allow raise no event and hold no broker entry; a card raised exactly one request.
    const requested = h.events.filter(e => e.type === "approval_requested");
    expect(requested).toHaveLength(kind === "card" ? 1 : 0);
    if (kind === "allow") expect(result).toMatchObject({ behavior: "allow" });
    if (kind === "deny") expect(result).toMatchObject({ behavior: "deny" });
    if (kind !== "card") expect(h.events).toEqual([]);
  }
});

test("Glob, Grep and MultiEdit take the Read and Edit rows; Glob and Grep default to the working directory", async () => {
  for (const policy of POLICIES) {
    expect((await outcome(build(state(policy)), "Glob", { pattern: "*.ts" })).kind).toBe("allow");
    expect((await outcome(build(state(policy)), "Grep", { pattern: "x", path: "/workspace/repos/app/src" })).kind).toBe("allow");
    expect((await outcome(build(state(policy)), "MultiEdit", { file_path: "/workspace/repos/app/a.ts", edits: [] })).kind).toBe(GRID[policy].Edit);
  }
  // A pattern can reach beyond the search directory: its literal prefix is classified too (absolute, `..`, protected, outside).
  for (const policy of POLICIES) {
    for (const [tool, input] of [
      ["Glob", { pattern: "/workspace/.winter/**" }], ["Glob", { pattern: "../../../etc/*" }], ["Grep", { pattern: "x", glob: "/etc/*" }],
      ["Glob", { pattern: "/workspace/.winter/conversations/*/x.jsonl", path: "/workspace/repos/app" }], ["Grep", { pattern: "x", glob: "src/*/../../../../etc/*" }],
      ["Glob", { pattern: "?./etc/*" }], ["Glob", { pattern: ".?/x" }], ["Glob", { pattern: "??/x" }], ["Grep", { pattern: "x", glob: "src/?./../*" }],
      ["Glob", { pattern: "/proc/**" }], ["Glob", { pattern: "/workspace/outputs/**" }], ["Glob", { pattern: "../../.winter/*" }],
      // Brace alternatives, escapes, extglob groups, `~`: nothing outside the allowlist is ever classified from the cwd.
      ["Glob", { pattern: "{/etc,x}/passwd" }], ["Grep", { pattern: "x", glob: "{/etc,y}/*" }], ["Glob", { pattern: "{..,x}/etc/*" }],
      ["Glob", { pattern: "\\.\\./\\.\\./etc/*" }], ["Glob", { pattern: "..\\/..\\/etc/*" }], ["Glob", { pattern: "@(..|x)/etc/*" }],
      ["Glob", { pattern: "+(/etc)/*" }], ["Glob", { pattern: "~/x/*" }], ["Glob", { pattern: "~root/*" }], ["Grep", { pattern: "x", glob: "~/*" }],
      ["Glob", { pattern: "!(a)/*" }], ["Glob", { pattern: "?(a)/*" }], ["Glob", { pattern: "*(a)/*" }], ["Glob", { pattern: "[/]etc/*" }],
      ["Glob", { pattern: "src/~x/*" }], ["Glob", { pattern: "src\\x/*" }], ["Glob", { pattern: "a/b\n/c" }],
    ] as const) expect({ policy, tool, input, kind: (await outcome(build(state(policy)), tool, { ...input })).kind }).toEqual({ policy, tool, input, kind: "deny" });
    // In-workspace patterns, relative or absolute, still take the Read row.
    for (const [tool, input] of [
      ["Glob", { pattern: "**" }], ["Glob", { pattern: "**/*.md" }], ["Glob", { pattern: "" }], ["Grep", { pattern: "x", glob: "" }], ["Glob", { pattern: "src/my file-1_a.b/*.ts" }],
      ["Glob", { pattern: "src/**/*.ts" }], ["Glob", { pattern: "**/*.ts" }], ["Glob", { pattern: "*.ts" }], ["Glob", { pattern: "a?.ts" }], ["Glob", { pattern: "src/?/x.ts" }], ["Glob", { pattern: "./*.ts" }], ["Glob", { pattern: "/workspace/repos/app/src/*.ts" }],
      ["Grep", { pattern: "x", glob: "*.ts" }], ["Grep", { pattern: "x", glob: "../other/*.ts" }],
    ] as const) expect({ policy, tool, input, kind: (await outcome(build(state(policy)), tool, { ...input })).kind }).toEqual({ policy, tool, input, kind: "allow" });
  }
  // A search aimed outside the admitted roots is a hard denial even though Read is Allow in every policy.
  expect((await outcome(build(state("bypass")), "Grep", { pattern: "x", path: "/etc" })).kind).toBe("deny");
});

test("an explicit allow the host resolved lifts dont-ask and ask but never plan; an explicit deny beats bypass", async () => {
  const allow = { explicit: () => "allow" as const }, deny = { explicit: () => "deny" as const };
  expect((await outcome(build(state("dont-ask"), { ports: allow }), ...WRITE)).kind).toBe("allow");
  expect((await outcome(build(state("dont-ask"), { ports: allow }), ...BASH)).kind).toBe("allow");
  expect((await outcome(build(state("ask"), { ports: allow }), ...WRITE)).kind).toBe("allow");
  expect((await outcome(build(state("plan"), { ports: allow }), ...WRITE)).kind).toBe("deny");
  expect((await outcome(build(state("bypass"), { ports: deny }), ...WRITE)).kind).toBe("deny");
});

const OWN_OUT = "/workspace/outputs/cowork-1", OWN_SCRATCH = "/workspace/.winter/scratch/cowork-1";
test("the conversation's own outputs and scratch: read everywhere, write like an admitted root (plan's scratch only inside the plan view); others' folders and the roots are denied", async () => {
  for (const policy of POLICIES) {
    for (const [name, own, other, root] of [["outputs", OWN_OUT, "/workspace/outputs/someone-else", "/workspace/outputs"], ["scratch", OWN_SCRATCH, "/workspace/.winter/scratch/someone-else", "/workspace/.winter/scratch"]] as const) {
      const writeKind: Outcome = name === "scratch" && policy === "plan" ? "allow" : GRID[policy].Write;
      const editKind: Outcome = name === "scratch" && policy === "plan" ? "allow" : GRID[policy].Edit;
      const row = (dir: string) => ({
        Read: ["Read", { file_path: `${dir}/a.txt` }], Write: ["Write", { file_path: `${dir}/a.txt`, content: "x" }], Edit: ["Edit", { file_path: `${dir}/a.txt`, old_string: "a", new_string: "b" }],
        Glob: ["Glob", { pattern: "*.pdf", path: dir }], Grep: ["Grep", { pattern: "x", path: dir }],
      } as const);
      for (const [tool, [wire, input]] of Object.entries(row(own))) {
        const kind = (await outcome(build(state(policy)), wire, { ...input })).kind;
        expect({ policy, name, tool, kind }).toEqual({ policy, name, tool, kind: tool === "Write" ? writeKind : tool === "Edit" ? editKind : "allow" });
      }
      for (const dir of [other, root]) for (const [tool, [wire, input]] of Object.entries(row(dir)))
        expect({ policy, name, dir, tool, kind: (await outcome(build(state(policy)), wire, { ...input })).kind }).toEqual({ policy, name, dir, tool, kind: "deny" });
    }
  }
  // A pathless tool never takes these folders; a missing/unsafe session identity makes the folder nobody's.
  const none = (sessionId: string | undefined) => projectCoworkCall({ identity: () => ({ workspaceId: "w", sourceRevision: 1 }), snapshot: () => new CoworkPolicyTransitionMachine(state("bypass"), { closeAdmission: async () => {}, drain: async () => "drained", installView: async () => {} }).snapshot(), classifyPath },
    { toolName: "Write", input: { file_path: `/workspace/outputs/${sessionId ?? "x"}/a`, content: "" }, ...(sessionId === undefined ? {} : { sessionId }) }).kind;
  for (const id of [undefined, "", "..", ".", "a/b", "x".repeat(200), "x y", "-x", ".hidden", "a\nb"]) expect({ id, kind: none(id) }).toEqual({ id, kind: "deny" });
  expect(none("x")).toBe("allow");
});

test("the glob allowlist holds for outputs and scratch patterns: only the own folder's literal prefix allows", async () => {
  const bypass = () => build(state("bypass"));
  for (const [tool, input] of [
    ["Glob", { pattern: `${OWN_OUT}/*.pdf` }], ["Glob", { pattern: `${OWN_OUT}/**` }], ["Grep", { pattern: "x", glob: `${OWN_OUT}/reports/*.md` }], ["Glob", { pattern: `${OWN_SCRATCH}/**/*.tmp` }],
  ] as const) expect({ tool, input, kind: (await outcome(bypass(), tool, { ...input })).kind }).toEqual({ tool, input, kind: "allow" });
  for (const [tool, input] of [
    ["Glob", { pattern: "/workspace/outputs/*" }], ["Glob", { pattern: "/workspace/outputs/**" }], ["Glob", { pattern: "/workspace/outputs/other-*/x" }], ["Glob", { pattern: `${OWN_OUT}*/x` }],
    ["Glob", { pattern: `${OWN_OUT}/../other/*` }], ["Glob", { pattern: `${OWN_OUT}/*/../../other/*` }], ["Grep", { pattern: "x", glob: `${OWN_OUT}/{a,../other}/*` }], ["Glob", { pattern: `${OWN_OUT}/\\.\\./other/*` }],
    ["Glob", { pattern: `@(${OWN_OUT}|/etc)/*` }], ["Glob", { pattern: "/workspace/.winter/scratch/*/x" }], ["Glob", { pattern: "~/outputs/*" }],
  ] as const) expect({ tool, input, kind: (await outcome(bypass(), tool, { ...input })).kind }).toEqual({ tool, input, kind: "deny" });
});

test("hard denials hold under bypass: protected, outside, outputs and scratch paths, a missing ceiling class, unmapped paths", async () => {
  const bypass = () => build(state("bypass"));
  for (const path of ["/workspace/.winter/conversations/other/store.jsonl", "/workspace/.winter", "/proc/1/environ", "/etc/passwd", "/Users/someone/.ssh/id_rsa",
    // Another conversation's outputs/scratch, the roots, and look-alike prefixes: never the OWN folder.
    "/workspace/outputs/other-session/report.pdf", "/workspace/outputs", "/workspace/outputs/", "/workspace/outputs/cowork-10/x", "/workspace/outputs/cowork-1/../other/x",
    "/workspace/.winter/scratch/other/tmp.txt", "/workspace/.winter/scratch", "/workspace/.winter/scratch/cowork-12/t"]) {
    for (const [tool, base] of [READ, WRITE, EDIT]) expect((await outcome(bypass(), tool, { ...base, file_path: path })).kind).toBe("deny");
  }
  // Relative paths resolve against the conversation's cwd, and `..` cannot climb out of the host's classification.
  expect((await outcome(bypass(), "Write", { file_path: "../../.winter/conversations/x", content: "" })).kind).toBe("deny");
  expect((await outcome(bypass(), "Write", { file_path: "a.ts", content: "" })).kind).toBe("allow");
  // A file tool with no target is unclassified, never admitted.
  for (const input of [{}, { file_path: "" }, { file_path: 5 }, { file_path: "a\0b" }]) expect((await outcome(bypass(), "Write", input)).kind).toBe("deny");
  // The ceiling is the grant bypass works inside.
  expect((await outcome(build(state("bypass", { ...FULL, toolClasses: ["read"] })), ...WRITE)).kind).toBe("deny");
  expect((await outcome(build(state("bypass", { ...FULL, toolClasses: ["read", "write"] })), ...BASH)).kind).toBe("deny");
  expect((await outcome(build(state("bypass", { ...FULL, toolClasses: ["write"] })), ...EDIT)).kind).toBe("deny");
  // A host port that throws, or answers something unknown, is a denial.
  expect((await outcome(build(state("bypass"), { ports: { classifyPath: () => { throw new Error("boom"); } } }), ...WRITE)).kind).toBe("deny");
  expect((await outcome(build(state("bypass"), { ports: { classifyPath: () => "workspace" } }), ...WRITE)).kind).toBe("deny");
  expect((await outcome(build(state("bypass"), { ports: { snapshot: () => { throw new Error("boom"); } } }), ...READ)).kind).toBe("deny");
  expect((await outcome(build(state("bypass"), { ports: { snapshot: () => ({}) as never } }), ...READ)).kind).toBe("deny");
});

test("shared workspace instructions are read-only to tools in every policy; the edit column is the host operation", async () => {
  const path = "/workspace/.winter/WINTER.md";
  for (const policy of POLICIES) {
    expect((await outcome(build(state(policy)), "Read", { file_path: path })).kind).toBe("allow");
    for (const [tool, base] of [WRITE, EDIT]) {
      const r = await outcome(build(state(policy)), tool, { ...base, file_path: path });
      expect(r.kind).toBe("deny");
      expect((r.result as { message: string }).message).toContain("workspace instruction update");
    }
  }
  // The column itself, as the matrix the bridge and `CoworkInstructions.agentScope` share: Deny under plan and dont-ask, Ask otherwise.
  for (const policy of POLICIES) {
    const verdict = coworkHostDecision({ policy, tool: "InstructionEdit", path: "shared-instructions", ceiling: FULL }).verdict;
    expect(verdict).toBe(policy === "plan" || policy === "dont-ask" ? "deny" : "ask");
  }
});

test("unknown tool classes are denied under every policy, bypass included; the model is told why", async () => {
  for (const policy of POLICIES) for (const tool of ["TaskCreate", "WebFetch", "WebSearch", "Agent", "Skill", "ToolSearch", "NotebookEdit", "LSP", "SendMessage", "advisor", "ReadNotifications", "InstructionEdit", "constructor", "__proto__"]) {
    const r = await outcome(build(state(policy)), tool, { file_path: "/workspace/repos/app/a.ts" });
    expect({ policy, tool, kind: r.kind }).toEqual({ policy, tool, kind: "deny" });
    expect((r.result as { message: string }).message).toBe(coworkDeniedMessage(tool, "unknown_tool_class"));
  }
});

test("plan x own scratch needs the plan view, like plan x Bash: absent or false denies", async () => {
  const scratch = ["Write", { file_path: `${OWN_SCRATCH}/note.txt`, content: "x" }] as const;
  expect((await outcome(build(state("plan")), ...scratch)).kind).toBe("allow");
  for (const ports of [{ planViewInstalled: () => false }, { planViewInstalled: undefined }]) {
    const r = await outcome(build(state("plan"), { ports }), ...scratch);
    expect(r.kind).toBe("deny"); expect((r.result as { message: string }).message).toBe(coworkDeniedMessage("Write", "plan_view_missing"));
    expect((await outcome(build(state("plan"), { ports }), "Edit", { file_path: `${OWN_SCRATCH}/note.txt`, old_string: "a", new_string: "b" })).kind).toBe("deny");
  }
  // Reads of scratch need no view; outputs under plan are a plain deny whatever the view says.
  expect((await outcome(build(state("plan"), { ports: { planViewInstalled: undefined } }), "Read", { file_path: `${OWN_SCRATCH}/note.txt` })).kind).toBe("allow");
  expect((await outcome(build(state("plan")), "Write", { file_path: `${OWN_OUT}/r.pdf`, content: "" })).kind).toBe("deny");
});

test("the call is judged again after the review: a policy that narrowed during a hanging review denies it", async () => {
  let answer!: (v: { verdict: "safe" | "unsafe"; reason: string }) => void;
  const reviewer = fakeReviewer(() => new Promise(resolve => { answer = resolve; }));
  const h = build(state("auto"), { review: reviewer.review });
  const pending = h.canUse("Bash", { ...RISKY }, ctx()); await tick();
  expect(reviewer.calls).toHaveLength(1);
  expect((await h.machine.request(state("plan"))).status).toBe("applied");
  answer({ verdict: "safe", reason: "" });
  // Plan's view is installed in this fixture, so only a policy that denies Bash outright would stop it: use dont-ask below.
  expect(["allow", "deny"]).toContain((await pending)!.behavior);
  const g = build(state("auto"), { review: fakeReviewer(() => new Promise(resolve => { answer = resolve; })).review });
  const run = g.canUse("Bash", { ...RISKY }, ctx()); await tick();
  expect((await g.machine.request(state("dont-ask"))).status).toBe("applied");
  answer({ verdict: "safe", reason: "" });
  expect(await run).toMatchObject({ behavior: "deny", message: coworkDeniedMessage("Bash", "policy_changed") });
  expect(g.events).toEqual([]);
});

test("a sandbox escape and a network request beyond the ceiling are denied in every policy", async () => {
  for (const policy of POLICIES) {
    const escape = await outcome(build(state(policy)), "Bash", { command: "ls", dangerouslyDisableSandbox: true });
    expect(escape.kind).toBe("deny");
    expect((escape.result as { message: string }).message).toBe(coworkDeniedMessage("Bash", "sandbox_escape"));
    if (policy === "bypass" || policy === "auto") {
      expect((await outcome(build(state(policy)), "Bash", { command: "curl x", allowNetwork: true })).kind).toBe("deny");
      expect((await outcome(build(state(policy, { ...FULL, network: "internet" })), "Bash", { command: "curl x", allowNetwork: true })).kind).toBe("allow");
    }
  }
});

test("plan's read-only view is required: without it plan x Bash is denied, with it Bash runs", async () => {
  expect((await outcome(build(state("plan")), ...BASH)).kind).toBe("allow");
  for (const ports of [{ planViewInstalled: () => false }, { planViewInstalled: undefined }]) {
    const r = await outcome(build(state("plan"), { ports }), ...BASH);
    expect(r.kind).toBe("deny");
    expect((r.result as { message: string }).message).toBe(coworkDeniedMessage("Bash", "plan_view_missing"));
  }
});

// ── the connector row ────────────────────────────────────────────────────────────────────────────────────────────────
function connectorSource(table: ConnectorPermissionTable, readOnly: boolean | undefined): ConnectorPermissionSource {
  return { table: () => table, readOnly: () => readOnly };
}
test("connector actions take the separate Cowork row: explicit ask stays a card under bypass, explicit deny denies, unset mutation by policy", async () => {
  const CONNECTOR_ROW: Record<string, readonly Outcome[]> = {
    // plan, dont-ask, ask, accept-edits, auto, bypass
    "deny":         ["deny", "deny", "deny", "deny", "deny", "deny"],
    "ask":          ["deny", "deny", "card", "card", "card", "card"],
    "allow":        ["deny", "allow", "allow", "allow", "allow", "allow"],
    "unset":        ["deny", "deny", "card", "card", "allow", "allow"],
  };
  for (const [setting, row] of Object.entries(CONNECTOR_ROW)) for (const [index, policy] of POLICIES.entries()) {
    const table: ConnectorPermissionTable = setting === "unset" ? {} : { fx: { act: setting as "allow" } };
    const h = build(state(policy), { connectors: connectorSource(table, false) });
    expect({ setting, policy, kind: (await outcome(h, "mcp__fx__act", {})).kind }).toEqual({ setting, policy, kind: row[index]! });
  }
  // Classified read-only and unset: Allow everywhere, plan and dont-ask included. A stored ask over a read-only action cards in plan.
  for (const policy of POLICIES) expect((await outcome(build(state(policy), { connectors: connectorSource({}, true) }), "mcp__fx__act", {})).kind).toBe("allow");
  expect((await outcome(build(state("plan"), { connectors: connectorSource({ fx: { act: "ask" } }, true) }), "mcp__fx__act", {})).kind).toBe("card");
  // The model hears which setting refused it.
  const denied = await outcome(build(state("bypass"), { connectors: connectorSource({ fx: { act: "deny" } }, false) }), "mcp__fx__act", {});
  expect((denied.result as { message: string }).message).toContain("Always deny");
  // Inside the current grants only: a connector the ceiling does not list, or no connector facts at all, is denied.
  expect((await outcome(build(state("bypass"), { connectors: connectorSource({}, true) }), "mcp__other__act", {})).kind).toBe("deny");
  expect((await outcome(build(state("bypass", { ...FULL, connectors: [] }), { connectors: connectorSource({}, true) }), "mcp__fx__act", {})).kind).toBe("deny");
  expect((await outcome(build(state("bypass")), "mcp__fx__act", {})).kind).toBe("deny");
});

test("the projection reads the Cowork row, not Code's: an unset mutation under dont-ask is Cowork's explicit deny", () => {
  const ports: CoworkApprovalPorts = { identity: () => ({ workspaceId: "w", sourceRevision: 1 }), snapshot: () => new CoworkPolicyTransitionMachine(state("dont-ask"), { closeAdmission: async () => {}, drain: async () => "drained", installView: async () => {} }).snapshot(), classifyPath };
  expect(projectCoworkCall(ports, { toolName: "mcp__fx__act", input: {}, connectors: connectorSource({}, false) })).toMatchObject({ kind: "deny", policy: "dont-ask" });
});

// ── the events clients already understand ────────────────────────────────────────────────────────────────────────────
test("a card is the existing approval_requested: it names the workspace, source revision and agent, offers Allow and Deny only, and the answer is approval_resolved", async () => {
  const h = build(state("ask"), { turnOrigin: () => "mac" });
  const pending = h.canUse("Write", { file_path: "/workspace/repos/app/a.ts", content: "x" }, ctx({ agentID: "sub-agent-3" }));
  await tick();
  const requested = h.events.find(e => e.type === "approval_requested")!;
  expect(ApprovalRequestedEvent.safeParse({ ...requested, seq: 1, ts: 1 }).success).toBe(true);
  expect(requested).toMatchObject({ type: "approval_requested", sessionId: SESSION, callId: "tu1", toolName: "write", expiresAt: NOW + NO_PARK_TIMEOUT_MS });
  const summary = (requested as { summary: string }).summary;
  expect(summary).toContain("Cowork workspace ws-7"); expect(summary).toContain("source revision 12"); expect(summary).toContain("agent sub-agent-3");
  expect(summary).toContain("write");
  expect((requested as { options?: unknown }).options).toBeUndefined();   // no rule-bearing option: a saved rule is never host authority
  // The pending surface (what `approval.list` and the island read) holds it.
  expect(h.approvals.list(SESSION)).toHaveLength(1);
  expect(h.approvals.list(SESSION)[0]).toMatchObject({ toolName: "write" });
  h.approvals.resolve(SESSION, "tu1", true, "mac");
  const result = await pending;
  expect(result).toMatchObject({ behavior: "allow", decisionClassification: "user_temporary" });
  expect(h.events.filter(e => e.type === "approval_resolved")).toEqual([{ type: "approval_resolved", sessionId: SESSION, threadId: "main", callId: "tu1", approved: true, by: "mac" }]);
  // The main agent is named "main" when no sub-agent asks.
  const again = build(state("ask")); const p = again.canUse(...WRITE, ctx()); await tick();
  expect((again.events[0] as { summary: string }).summary).toContain("agent main"); again.approvals.resolve(SESSION, "tu1", false, "mac"); await p;
});

test("a Bash card offers Allow and Deny only - Code's rule-bearing options would write a saved rule that is never host authority in Cowork", async () => {
  const h = build(state("ask"), { turnOrigin: () => "mac" });
  const pending = h.canUse("Bash", { command: "git push origin main" }, ctx()); await tick();
  const requested = h.events.find(e => e.type === "approval_requested") as { options?: unknown; summary: string };
  expect(requested.options).toBeUndefined(); expect(requested.summary).toContain("bash git push origin main");
  h.approvals.resolve(SESSION, "tu1", true, "mac", "allow_global_0");
  expect(await pending).toMatchObject({ behavior: "allow", decisionClassification: "user_temporary" });
});

test("a human denial of a Cowork card interrupts like Code's; nobody answering is a machine outcome", async () => {
  const h = build(state("ask"));
  const pending = h.canUse(...WRITE, ctx()); await tick();
  h.approvals.resolve(SESSION, "tu1", false, "mac");
  expect(await pending).toMatchObject({ behavior: "deny", interrupt: true, decisionClassification: "user_reject" });
});

test("the island and pending surfaces list the Cowork card and drop it when answered", async () => {
  const h = build(state("ask"));
  const registry = new IslandRegistry({
    pending: { approval: (s, id) => h.approvals.pendingMeta(s, id) !== undefined, question: () => false, elicitation: () => false },
    facts: () => ({ mode: "cowork" } as never), hosts: () => [],
  });
  const pending = h.canUse(...BASH, ctx()); await tick();
  for (const e of h.events) registry.observe({ ...e, seq: 1, ts: 1 } as never);
  const items = registry.list();
  expect(items.map(i => [i.kind, i.sessionId, i.answerSessionId])).toEqual([["approval", SESSION, SESSION]]);
  expect((items[0]!.event as { summary: string }).summary).toContain("Cowork workspace ws-7");
  h.approvals.resolve(SESSION, "tu1", true, "island"); await pending;
  for (const e of h.events.slice(1)) registry.observe({ ...e, seq: 2, ts: 2 } as never);
  expect(registry.list()).toEqual([]);
});

test("AskUserQuestion and ExitPlanMode keep their own bridges in a Cowork session", async () => {
  let planCalls = 0;
  const planBridge = { onExitPlanMode: async () => { planCalls += 1; return { behavior: "allow", updatedInput: {} } as PermissionResult; } };
  const h = build(state("plan"), { planBridge });
  expect((await h.canUse("ExitPlanMode", { plan: "p" }, ctx())).behavior).toBe("allow");
  expect(planCalls).toBe(1);
  const asked = h.canUse("AskUserQuestion", { questions: [{ question: "q?", header: "h", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }], multiSelect: false }] }, ctx({ toolUseID: "q1" }));
  await tick();
  expect(h.events.map(e => e.type)).toContain("question_asked");
  h.questions.respond(SESSION, "q1", {}, "test");
  await asked;
});

// ── unattended turns, revalidation, narrowing ────────────────────────────────────────────────────────────────────────
test("an unattended turn keeps its policy: the card is raised and bounded, and the timeout is a typed deny, never an allow", async () => {
  jest.useFakeTimers();
  const h = build(state("ask"), { turnOrigin: () => "messaging" });
  const pending = h.canUse(...WRITE, ctx());
  await Promise.resolve();
  expect(h.events[0]).toMatchObject({ type: "approval_requested", expiresAt: NOW + DISPATCH_CHILD_APPROVAL_TIMEOUT_MS });
  jest.advanceTimersByTime(DISPATCH_CHILD_APPROVAL_TIMEOUT_MS + 1);
  const result = await pending;
  expect(result).toMatchObject({ behavior: "deny" });
  expect((result as { interrupt?: boolean }).interrupt).toBeUndefined();
  expect(h.events.find(e => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "timeout" });
  // An unknown origin is bounded too; a person's turn waits for its human.
  for (const [origin, bounded] of [[undefined, true], ["dispatch-wake", true], ["mac", false], ["tui", false]] as const) {
    const g = build(state("ask"), { turnOrigin: () => origin });
    const p = g.canUse(...WRITE, ctx()); await Promise.resolve();
    expect((g.events[0] as { expiresAt: number }).expiresAt).toBe(NOW + (bounded ? DISPATCH_CHILD_APPROVAL_TIMEOUT_MS : NO_PARK_TIMEOUT_MS));
    g.approvals.resolve(SESSION, "tu1", false, "x"); await p;
  }
});

test("an approval is revalidated when it lands: a policy that narrowed meanwhile turns the yes into a deny", async () => {
  const h = build(state("ask"));
  const pending = h.canUse(...WRITE, ctx()); await tick();
  expect((await h.machine.request(state("plan"))).status).toBe("applied");
  h.approvals.resolve(SESSION, "tu1", true, "mac");
  const result = await pending;
  expect(result).toMatchObject({ behavior: "deny", message: coworkDeniedMessage("Write", "policy_changed") });
  expect((result as { interrupt?: boolean }).interrupt).toBeUndefined();
  expect(h.events.find(e => e.type === "approval_resolved")).toMatchObject({ approved: false, by: "policy-changed" });
  // A policy that did not narrow the call away leaves the yes standing.
  const g = build(state("ask")); const q = g.canUse(...WRITE, ctx()); await tick();
  await g.machine.request(state("accept-edits")); g.approvals.resolve(SESSION, "tu1", true, "mac");
  expect((await q).behavior).toBe("allow");
});

test("a narrowing in flight admits nothing new and keeps reporting the old policy; a widening is judged under the old state", async () => {
  let release!: () => void;
  const hold: Hold = { drain: new Promise<"drained">(r => { release = () => r("drained"); }) };
  const h = build(state("auto"), { hold });
  expect((await outcome(h, ...WRITE)).kind).toBe("allow");
  const transition = h.machine.request(state("plan"));
  await tick();
  expect(h.machine.snapshot()).toMatchObject({ phase: "pending", step: "draining", effective: { policy: "auto" }, admission: "closed" });
  // Even a Read - allowed in both the old and the new policy - is not admitted while admission is closed.
  for (const [tool, input] of [READ, WRITE, BASH]) {
    const r = await outcome(h, tool, { ...input });
    expect(r.kind).toBe("deny");
    expect((r.result as { message: string }).message).toBe(coworkDeniedMessage(tool, "transition_pending"));
  }
  release(); expect((await transition).status).toBe("applied");
  expect((await outcome(h, ...WRITE)).kind).toBe("deny");   // plan now
  expect((await outcome(h, ...READ)).kind).toBe("allow");

  // A widening removes nothing: calls keep being judged under the OLD (narrower) policy until the view is installed.
  let install!: () => void;
  const w = build(state("plan"), { hold: { installView: new Promise<void>(r => { install = () => r(); }) } });
  const widening = w.machine.request(state("bypass"));
  await tick();
  expect(w.machine.snapshot()).toMatchObject({ phase: "pending", kind: "widening", effective: { policy: "plan" } });
  expect((await outcome(w, ...WRITE)).kind).toBe("deny");
  install(); await widening;
  expect((await outcome(w, ...WRITE)).kind).toBe("allow");
});

test("a failed narrowing keeps admission closed: restart-required says so, and no call is judged under the old state", async () => {
  const h = build(state("auto"), { hold: { drain: Promise.resolve("restart-required") } });
  expect((await h.machine.request(state("plan"))).status).toBe("failed");
  const r = await outcome(h, ...READ);
  expect(r.kind).toBe("deny");
  expect((r.result as { message: string }).message).toBe(coworkDeniedMessage("Read", "restart_required"));
  const g = build(state("auto"), { hold: { closeAdmission: Promise.reject(new Error("x")) } });
  expect((await g.machine.request(state("plan"))).status).toBe("failed");
  expect((await outcome(g, ...READ)).kind).toBe("deny");   // admission unknown
});

// ── the bash safety review, inside the Cowork route (the guest registers no hooks) ───────────────────────────────────────────
type Verdict = { verdict: "safe" | "unsafe"; reason: string };
function fakeReviewer(answer: (command: string, signal?: AbortSignal) => Promise<Verdict>) {
  const calls: Array<{ command: string; signal?: AbortSignal }> = [];
  return { calls, review: { reviewer: { review: async (request: { class: "bash"; command: string }, signal?: AbortSignal) => { calls.push({ command: request.command, ...(signal === undefined ? {} : { signal }) }); return answer(request.command, signal); } } } };
}
const RISKY = { command: "make deploy --force" };

test("auto x Bash runs the existing safety reviewer in the bridge: safe allows, unsafe denies with the reviewer's reason, no card either way", async () => {
  const safe = fakeReviewer(async () => ({ verdict: "safe", reason: "" }));
  const a = build(state("auto"), { review: safe.review });
  expect((await outcome(a, "Bash", { ...RISKY })).kind).toBe("allow");
  expect(safe.calls.map(c => c.command)).toEqual([RISKY.command]); expect(a.events).toEqual([]);
  const unsafe = fakeReviewer(async () => ({ verdict: "unsafe", reason: "it force-deploys to production" }));
  const b = build(state("auto"), { review: unsafe.review });
  const denied = await outcome(b, "Bash", { ...RISKY });
  expect(denied.kind).toBe("deny"); expect((denied.result as { message: string }).message).toBe("Bash was not run — it force-deploys to production");
  expect(b.events).toEqual([]);
  const blank = build(state("auto"), { review: fakeReviewer(async () => ({ verdict: "unsafe", reason: "" })).review });
  expect(((await outcome(blank, "Bash", { ...RISKY })).result as { message: string }).message).toContain("judged this command unsafe");
});

test("the review is skipped where the table says it is not owed: a read-only command, other policies, other tools, no reviewer, a disabled reviewer, an empty command", async () => {
  const never = fakeReviewer(async () => ({ verdict: "unsafe", reason: "no" }));
  expect((await outcome(build(state("auto"), { review: never.review }), "Bash", { command: "ls -la" })).kind).toBe("allow");      // bashLooksSafe
  expect((await outcome(build(state("auto"), { review: { ...never.review, allow: () => ["make"] } }), "Bash", { command: "make test" })).kind).toBe("allow");   // the user's allow list
  for (const policy of ["bypass", "accept-edits", "ask"] as const) {
    const h = build(state(policy), { review: never.review }); const r = await outcome(h, "Bash", { ...RISKY });
    expect(r.kind).toBe(policy === "bypass" ? "allow" : "card");
  }
  expect((await outcome(build(state("auto"), { review: never.review }), "Write", { file_path: "/workspace/repos/app/a.ts", content: "" })).kind).toBe("allow");
  expect((await outcome(build(state("auto")), "Bash", { ...RISKY })).kind).toBe("allow");                                              // no reviewer wired: as Code
  expect((await outcome(build(state("auto"), { review: { ...never.review, enabled: () => false } }), "Bash", { ...RISKY })).kind).toBe("allow");
  expect((await outcome(build(state("auto"), { review: never.review }), "Bash", { command: "" })).kind).toBe("allow");
  expect(never.calls).toEqual([]);
});

test("a reviewer that cannot reach a verdict asks (a card, never an allow); no runnable model allows as Code does", async () => {
  const { ReviewerNoRunnableModel } = await import("../../src/agent/reviewer");
  for (const failure of [async () => { throw new Error("provider 500"); }, async () => ({ verdict: "maybe", reason: "" }) as unknown as Verdict, async () => undefined as unknown as Verdict]) {
    const h = build(state("auto"), { review: fakeReviewer(failure).review, turnOrigin: () => "mac" });
    const pending = h.canUse("Bash", { ...RISKY }, ctx()); await tick();
    const requested = h.events.find(e => e.type === "approval_requested") as { summary: string } | undefined;
    expect(requested?.summary).toContain("bash make deploy --force");
    h.approvals.resolve(SESSION, "tu1", true, "mac");
    expect(await pending).toMatchObject({ behavior: "allow", decisionClassification: "user_temporary" });
  }
  const noModel = build(state("auto"), { review: fakeReviewer(async () => { throw new ReviewerNoRunnableModel("none", "x"); }).review });
  expect((await outcome(noModel, "Bash", { ...RISKY })).kind).toBe("allow");
  // And a refusal of that card is a refusal.
  const h = build(state("auto"), { review: fakeReviewer(async () => { throw new Error("down"); }).review, turnOrigin: () => "mac" });
  const pending = h.canUse("Bash", { ...RISKY }, ctx()); await tick(); h.approvals.resolve(SESSION, "tu1", false, "mac");
  expect(await pending).toMatchObject({ behavior: "deny", interrupt: true });
});

test("the review is bounded: a reviewer that never answers is aborted at the timeout and the call asks", async () => {
  let seen: AbortSignal | undefined;
  const hang = fakeReviewer((_c, signal) => { seen = signal; return new Promise<Verdict>(() => {}); });
  const h = build(state("auto"), { review: { ...hang.review, timeoutMs: 20 }, turnOrigin: () => "mac" });
  const pending = h.canUse("Bash", { ...RISKY }, ctx());
  await new Promise(r => setTimeout(r, 80));
  expect(seen?.aborted).toBe(true);
  expect(h.events.find(e => e.type === "approval_requested")).toBeDefined();
  h.approvals.resolve(SESSION, "tu1", false, "mac"); await pending;
  // A turn aborted during the review is a deny with no card.
  const controller = new AbortController();
  const g = build(state("auto"), { review: fakeReviewer(async (_c, signal) => { await new Promise(r => signal?.addEventListener("abort", r)); throw new Error("aborted"); }).review });
  const run = g.canUse("Bash", { ...RISKY }, ctx({ controller })); await tick(); controller.abort();
  expect(await run).toMatchObject({ behavior: "deny" }); expect(g.events).toEqual([]);
});

test("an aborted turn is denied with no event and no broker entry", async () => {
  const controller = new AbortController(); controller.abort();
  const h = build(state("ask"));
  const result = await h.canUse(...WRITE, ctx({ controller }));
  expect(result.behavior).toBe("deny"); expect(h.events).toEqual([]); expect(h.approvals.list(SESSION)).toEqual([]);
});

// ── nothing else changes, and the refusal holds ──────────────────────────────────────────────────────────────────────
test("without the cowork dependency the bridge is the gate's: a Code write outside any Cowork root runs under auto exactly as before", async () => {
  const events: NewSessionEvent[] = [];
  const code = canUseToolFor({ sessionId: SESSION, mode: "code", policy: "auto", approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), emit: e => { events.push(e); }, log: silent, now: () => NOW });
  expect((await code("Write", { file_path: "/tmp/x", content: "" }, ctx()))!.behavior).toBe("allow");
  expect(events).toEqual([]);
});

const sourceDirectory = (...parts: string[]) => join(import.meta.dir, "..", "..", "..", ...parts);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}
test("wired behind the refusal: only the bridge reaches the projection, production never supplies the port, and a cowork session is still unrunnable", () => {
  const packages = sourceDirectory();
  const sources = readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(packages, entry.name, "src"))).flatMap(entry => sourceFiles(join(packages, entry.name, "src")));
  const module = join(packages, "core", "src", "runtime-sdk", "cowork-approval.ts");
  expect(sources).toContain(module);
  const reaching = (needles: string[]) => sources.filter(file => needles.some(needle => readFileSync(file, "utf8").includes(needle))).map(file => basename(file)).sort();
  // The projection module is imported by the approval bridge and by nothing else.
  expect(reaching(["./cowork-approval\"", "runtime-sdk/cowork-approval"])).toEqual(["approval-bridge.ts"]);
  expect(reaching(["projectCoworkCall", "coworkCardPrefix", "CoworkApprovalPorts"])).toEqual(["approval-bridge.ts", "cowork-approval.ts"]);
  // The one production constructor of the bridge (the driver) never passes `cowork`, and nothing in src builds the port.
  const driver = readFileSync(join(packages, "core", "src", "runtime-sdk", "session-driver.ts"), "utf8");
  const construction = driver.slice(driver.indexOf("canUseToolFor({"), driver.indexOf("canUseToolFor({") + 1600);
  expect(construction).not.toMatch(/\bcowork\b/);
  expect(reaching(["canUseToolFor({"]).filter(name => name !== "approval-bridge.ts")).toEqual(["session-driver.ts"]);
  // The door still refuses.
  expect(isUnrunnableSessionMode("cowork")).toBe(true); expect(runnableModeOf("cowork")).toBeUndefined();
  // The bridge's only cowork seam is the injected dependency.
  const bridge = readFileSync(join(packages, "core", "src", "runtime-sdk", "approval-bridge.ts"), "utf8");
  expect(bridge.match(/if \(deps\.cowork !== undefined\)/g)!.length).toBe(1);
  // The projection is pure: no filesystem, clock, environment or network.
  expect(readFileSync(module, "utf8")).not.toMatch(/\b(Date\.now|new Date|process\.|Bun\.|node:fs|fetch\(|setTimeout)\b/);
});
