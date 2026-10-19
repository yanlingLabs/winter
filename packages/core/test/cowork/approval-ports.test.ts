// Session door D3: the host ports the APPROVALS projection reads for one source-located conversation, and the real
// approval bridge deciding with them.
import { afterEach, expect, test } from "bun:test";
import type { CanUseTool, PermissionResult } from "@yanlinglabs/winter-agent-sdk";
import type { ApprovalPolicy, NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { coworkApprovalPortsFor, coworkClassifyGuestPath, type CoworkHostApprovalPorts } from "../../src/cowork/approval-ports";
import { canUseToolFor } from "../../src/runtime-sdk/approval-bridge";
import type { CoworkApprovalPorts } from "../../src/runtime-sdk/cowork-approval";
import { doorFixture, type DoorFixture } from "./session-door-fixture";

// Compile-time: the DOOR's structural ports ARE the APPROVALS lane's ports (assignable both ways).
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ASSIGNABLE: Mutual<CoworkHostApprovalPorts, Required<CoworkApprovalPorts> extends infer R ? Omit<R, "explicit"> : never> = true;

const fixtures: DoorFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const POLICIES: readonly ApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];

test("the path table: its root and memory are admitted, its own outputs and scratch are its own, every other store, outputs, scratch and run home is protected", () => {
  expect(ASSIGNABLE).toBe(true);
  const at = (path: string) => coworkClassifyGuestPath(path, { sessionId: "conversation", root: "/workspace/folders/grant/repo" });
  const TABLE: Record<string, string> = {
    "/workspace/folders/grant/repo": "admitted", "/workspace/folders/grant/repo/src/a.ts": "admitted", "/workspace/folders/grant/repo/": "admitted",
    "/workspace/folders/grant/repo/x/../y": "admitted",
    "/workspace/.winter/memory": "admitted", "/workspace/.winter/memory/notes.md": "admitted",
    "/workspace/.winter/WINTER.md": "shared-instructions",
    "/workspace/outputs/conversation": "outputs", "/workspace/outputs/conversation/report.md": "outputs",
    "/workspace/.winter/scratch/conversation": "scratch", "/workspace/.winter/scratch/conversation/tmp": "scratch",
    // O1: another conversation's outputs and scratch are denied for every tool.
    "/workspace/outputs/other": "protected", "/workspace/outputs/conversationX": "protected", "/workspace/outputs": "protected",
    "/workspace/.winter/scratch/other": "protected", "/workspace/.winter/scratch": "protected",
    "/workspace/.winter/conversations/conversation": "protected", "/workspace/.winter/conversations/other/x.jsonl": "protected",
    "/workspace/.winter": "protected", "/workspace/.winter/WINTER.md.bak": "protected", "/workspace": "protected",
    "/run/winter/conversations/conversation/.control/provider.sock": "protected", "/run/winter": "protected",
    "/workspace/folders/grant/repo/../../../.winter/conversations/x": "protected",
    // Outside the conversation's view: the rest of its source, other sources, the OS.
    "/workspace/folders/grant": "outside", "/workspace/folders/grant/repository": "outside", "/workspace/folders/other": "outside", "/workspace/repos/r": "outside",
    "/etc/passwd": "outside", "/": "outside", "/run": "outside",
    // Not an absolute path: never admitted.
    "relative/path": "protected", "": "protected", "/workspace/folders/grant/repo/\0": "protected",
  };
  for (const [path, expected] of Object.entries(TABLE)) expect([path, at(path)]).toEqual([path, expected]);
});

test("the ports: identity is the workspace and source revision; the machine is stable at the binding's REAL policy; its change ports refuse; plan's view is plan's", async () => {
  for (const policy of POLICIES) {
    const f = doorFixture({ policy, relativeCwd: "repo" }); fixtures.push(f);
    const binding = f.records.binding("conversation"), context = f.begin(), source = f.authority.requireSource(f.workspaceId, binding.sourceId);
    expect(context.workspaceId).toBe(f.workspaceId);
    const ceiling = f.authority.effectiveCapabilities("conversation"), ports = coworkApprovalPortsFor({ binding, source, ceiling });
    expect(ports.identity()).toEqual({ workspaceId: f.workspaceId, sourceRevision: source.revision });
    expect(ports.snapshot()).toEqual({ phase: "stable", effective: { policy, ceiling: { ...ceiling, toolClasses: [...ceiling.toolClasses].sort() } }, epoch: 0, admission: "open" });
    expect(ports.planViewInstalled()).toBe(policy === "plan");
    expect(ports.classifyPath("/workspace/folders/grant/repo/a")).toBe("admitted");
    expect(ports.classifyPath("/workspace/folders/grant/a")).toBe("outside");
    expect(Object.isFrozen(ports)).toBe(true);
  }
});

function bridge(policy: ApprovalPolicy) {
  const f = doorFixture({ policy }); fixtures.push(f);
  const binding = f.records.binding("conversation"); f.begin();
  const ports = coworkApprovalPortsFor({ binding, source: f.authority.requireSource(f.workspaceId, binding.sourceId), ceiling: f.authority.effectiveCapabilities("conversation") });
  const approvals = new ApprovalBroker(), events: NewSessionEvent[] = [];
  // The APPROVALS lane's bridge with the DOOR's ports; `mode: "code"` is the bridge's own type (a NEEDS for APPROVALS).
  const canUse = canUseToolFor({ sessionId: "conversation", mode: "code", policy, approvals, questions: new QuestionBroker(), gate: new PermissionGate(),
    cwd: "/workspace/folders/grant", emit: event => { events.push(event); }, log: { info() {}, error() {} }, cowork: ports, turnOrigin: () => "Winter" });
  return { canUse: canUse as unknown as (...args: Parameters<CanUseTool>) => Promise<PermissionResult>, approvals, events };
}
const ctx = (id: string) => ({ signal: new AbortController().signal, toolUseID: id, requestId: `r-${id}` }) as Parameters<CanUseTool>[2];

test("through the real bridge: a protected path or another conversation's outputs is denied even under bypass; its own outputs follow the policy", async () => {
  for (const policy of POLICIES) {
    const h = bridge(policy);
    for (const path of ["/workspace/.winter/conversations/other/log.jsonl", "/workspace/outputs/other/x", "/run/winter/conversations/conversation/.control/provider.sock"]) {
      const read = await h.canUse("Read", { file_path: path }, ctx("read"));
      expect([policy, path, read.behavior]).toEqual([policy, path, "deny"]);
      const write = await h.canUse("Write", { file_path: path, content: "x" }, ctx("write"));
      expect([policy, path, write.behavior]).toEqual([policy, path, "deny"]);
    }
    // Its own source under bypass runs; under plan a write is refused.
    if (policy === "bypass") expect((await h.canUse("Write", { file_path: "/workspace/folders/grant/a.txt", content: "x" }, ctx("w2"))).behavior).toBe("allow");
    if (policy === "plan") expect((await h.canUse("Write", { file_path: "/workspace/folders/grant/a.txt", content: "x" }, ctx("w3"))).behavior).toBe("deny");
    expect(h.approvals.list("conversation")).toEqual([]);
  }
});
