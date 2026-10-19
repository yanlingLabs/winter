// Session door D3: the conversation set the guest is started with. Every set the builder makes is checked by the NATIVE
// wire validator (native/protocol.ts `conversationOf`, the supervisor's own rules mirrored), and the policy encoding is
// pinned against the guest supervisor's literal map.
import { afterEach, expect, test } from "bun:test";
import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import {
  coworkPlanScratchPath,
  COWORK_GUEST_IDENTITIES, COWORK_GUEST_RUNTIME_MODES, coworkConversationFor, coworkGuestCwdFor, coworkGuestPermissionModeFor, coworkGuestPolicyFor,
  coworkGuestToolClassesFor, coworkGuestToolsFromClasses, type CoworkConversationSetInput,
} from "../../src/cowork/conversation-set";
import { coworkGuestOfferedTools } from "../../src/cowork/guest-runtime";
import { parseCoworkNativeMuxFrame, serializeCoworkNativeMuxFrame } from "../../src/cowork/native/protocol";
import type { CoworkGuestConversation, CoworkGuestConversationSet } from "../../src/cowork/session-ports";
import type { ConversationBinding } from "../../src/cowork/types";
import { doorFixture, FIXTURE_MODEL, standinRoute, type DoorFixture } from "./session-door-fixture";

const fixtures: DoorFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const POLICIES: readonly ApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];

/** The guest supervisor's map, VERBATIM: agent SDK `packages/runtime/src/guest/linux-supervisor.py` `host_query_config`
 *  (main 80bca246fdaf; the same at 093fb3ea and 68e57c646f23). */
const SDK_HOST_QUERY_MODES: Readonly<Record<string, string>> = { auto: "default", ask: "default", plan: "plan", "accept-edits": "acceptEdits", "dont-ask": "dontAsk", bypass: "bypassPermissions" };

function inputFor(f: DoorFixture, over: Partial<CoworkConversationSetInput> = {}): CoworkConversationSetInput {
  const context = f.begin(), binding = f.records.binding("conversation"), source = f.authority.requireSource(f.workspaceId, binding.sourceId);
  const epoch = f.records.refreshEpoch(context.workspaceId, context.incarnationId, context.leaseEpoch);
  return { binding, source, context, configRevision: epoch.configRevision, grantRevision: epoch.grantRevision, policyRevision: f.records.policy(f.workspaceId).revision,
    homeId: f.records.homeIdentity(), backendSessionId: "0b6d7c4e-5a1f-4c2e-9d3b-7e8f9a0b1c2d",
    offered: coworkGuestOfferedTools(binding.policy, f.authority.effectiveCapabilities("conversation"), ["guest-compartment"]), route: standinRoute(), ...over };
}
function fixture(opts: Parameters<typeof doorFixture>[0] = {}): DoorFixture { const f = doorFixture(opts); fixtures.push(f); return f; }

/** Through the native wire exactly as the host sends it at `mounted`, and back: what the guest would receive. */
function onTheWire(set: CoworkGuestConversationSet, incarnationId: string): CoworkGuestConversationSet {
  const message = { t: "conversations", operationId: "operation", nonce: "ab".repeat(16), incarnationId, profile: set.profile, conversations: set.conversations } as const;
  const frame = parseCoworkNativeMuxFrame(serializeCoworkNativeMuxFrame({ class: "bootstrap", seq: 1, message }, "down"), "down");
  if (frame.class !== "bootstrap" || frame.message.t !== "conversations") throw new Error("shape");
  return { profile: frame.message.profile, conversations: frame.message.conversations };
}
const refusedOnTheWire = (conversation: CoworkGuestConversation, incarnationId: string): boolean => {
  try { onTheWire({ profile: "host-query-v1", conversations: [conversation] }, incarnationId); return false; } catch { return true; }
};

test("the policy encoding: plan is sent as plan, every other policy as ask, so the guest's own map runs default or plan, never a self-resolving mode", () => {
  for (const policy of POLICIES) {
    const sent = coworkGuestPolicyFor(policy), runs = SDK_HOST_QUERY_MODES[sent];
    expect([policy, sent]).toEqual([policy, policy === "plan" ? "plan" : "ask"]);
    expect([policy, runs]).toEqual([policy, policy === "plan" ? "plan" : "default"]);
    expect(["bypassPermissions", "acceptEdits", "dontAsk"]).not.toContain(runs);
    // The host launch states the mode the guest runs.
    expect([policy, coworkGuestPermissionModeFor(policy) as string]).toEqual([policy, runs!]);
  }
  // The two values the builder sends map, in the SDK's own table, to the modes this module claims.
  for (const [sent, mode] of Object.entries(COWORK_GUEST_RUNTIME_MODES)) expect([sent, SDK_HOST_QUERY_MODES[sent]]).toEqual([sent, mode]);
  expect(() => coworkGuestPolicyFor("chat" as ApprovalPolicy)).toThrow("invalid_request");
});

test("every built set passes the native wire validator, under every policy, and carries what the host decides", () => {
  for (const policy of POLICIES) {
    const f = fixture({ policy }), input = inputFor(f), set = coworkConversationFor(input);
    const wire = onTheWire(set, input.context.incarnationId), item = wire.conversations[0]!;
    expect(wire.profile).toBe("host-query-v1");
    expect(wire.conversations).toHaveLength(1);
    expect(item.logicalSessionId).toBe("conversation");
    expect(item.authority).toEqual({ workspaceId: f.workspaceId, sessionId: input.backendSessionId, incarnationId: "incarnation", leaseEpoch: input.context.leaseEpoch,
      configRevision: input.configRevision, grantRevision: input.grantRevision, policyRevision: input.policyRevision });
    expect([item.runtimeUid, item.toolUid, item.workspaceGid]).toEqual([COWORK_GUEST_IDENTITIES.runtimeUid, COWORK_GUEST_IDENTITIES.toolUid, COWORK_GUEST_IDENTITIES.workspaceGid]);
    expect(item.policy).toBe(policy === "plan" ? "plan" : "ask");
    expect(item.roots).toEqual([{ id: f.sourceId, guestPath: "/workspace/folders/grant", source: "/workspace/folders/grant", readOnly: policy === "plan" }]);
    expect(item.runtime!.model).toBe(FIXTURE_MODEL);
    expect(item.runtime!.guided).toBeNull();
    expect(coworkGuestToolsFromClasses(item.runtime!.toolClasses).sort()).toEqual([...input.offered].sort());
    expect((item.runtime!.provider.scope as Record<string, unknown>)).toMatchObject({ sessionId: "conversation", backendSessionId: input.backendSessionId, bootId: input.context.guestBootId, homeId: input.homeId });
    expect(Object.isFrozen(set) && Object.isFrozen(set.conversations[0]) && Object.isFrozen(set.conversations[0]!.roots)).toBe(true);
  }
});

test("a read-only source is a read-only root, and a relative cwd is the root itself (only that subdirectory is visible)", () => {
  const f = fixture({ access: "read-only", toolClasses: ["read"], relativeCwd: "repo/sub" }), input = inputFor(f), item = onTheWire(coworkConversationFor(input), "incarnation").conversations[0]!;
  expect(item.roots).toEqual([{ id: f.sourceId, guestPath: "/workspace/folders/grant/repo/sub", source: "/workspace/folders/grant/repo/sub", readOnly: true }]);
  expect(item.runtime!.toolClasses).toEqual(["read"]);
  expect(coworkGuestCwdFor({ ...(input.binding as ConversationBinding), relativeCwd: "./repo//sub/" }, input.source!)).toBe("/workspace/folders/grant/repo/sub");
  for (const bad of ["../escape", "/abs", "café", "tab\there"]) expect(() => coworkGuestCwdFor({ ...(input.binding as ConversationBinding), relativeCwd: bad }, input.source!)).toThrow("invalid_request");
  expect(() => coworkGuestCwdFor({ ...(input.binding as ConversationBinding), sourceId: "source_other" }, input.source!)).toThrow("authority_denied");
});

test("CONDITION (D3 note section 4): no protected path can be a host-query root: the native wire refuses each, and the builder only ever sends the source", () => {
  const f = fixture(), input = inputFor(f), item = coworkConversationFor(input).conversations[0]!;
  expect(refusedOnTheWire(item, "incarnation")).toBe(false);
  // The builder: one root, its `source` IS its guest path, and it is a folder or repository root (never .winter, outputs or /run).
  expect(item.roots).toHaveLength(1);
  expect(item.roots[0]!.source).toBe(item.roots[0]!.guestPath);
  expect(item.roots[0]!.guestPath).toMatch(/^\/workspace\/(folders|repos)\/[A-Za-z0-9][A-Za-z0-9_.-]*(\/|$)/);
  const PROTECTED = [
    "/workspace/.winter/conversations/conversation",            // this conversation's SDK store
    "/workspace/.winter/conversations/other",                   // another conversation's store
    "/run/winter/conversations/conversation",                   // its run home (the provider socket's directory)
    "/run/winter/conversations/conversation/.control",          // the provider socket itself lives here
    "/workspace/.winter",                                       // the skeleton
    "/workspace/.winter/memory",                                // memory: not in a host-query view (G3, a spec gap)
    "/workspace/.winter/WINTER.md",                             // shared guidance: a guided view only
    "/workspace/.winter/scratch/conversation",                  // even its own scratch: no .winter for host-query
    "/workspace/.winter/scratch/other",
    "/workspace/outputs/other",                                 // another conversation's outputs
    "/workspace/outputs",                                       // the outputs parent
    "/workspace", "/workspace/folders", "/workspace/repos",     // parents of every source
    "/opt/winter/environment", "/etc", "/",                     // never under /workspace
  ];
  for (const path of PROTECTED) {
    const root = { ...item.roots[0]!, guestPath: path, source: path };
    expect([path, refusedOnTheWire({ ...item, roots: [root] }, "incarnation")]).toEqual([path, true]);
    // Nor beside an admitted root.
    expect([path, refusedOnTheWire({ ...item, roots: [item.roots[0]!, { ...root, id: "second" }] }, "incarnation")]).toEqual([path, true]);
  }
  // Its OWN outputs is an allowed view (O1, the outputs slice D3b); the builder does not send it in D3.
  expect(refusedOnTheWire({ ...item, roots: [{ ...item.roots[0]!, guestPath: "/workspace/outputs/conversation", source: "/workspace/outputs/conversation" }] }, "incarnation")).toBe(false);
  // Plan with a writable root, and a nested pair, are refused too.
  expect(refusedOnTheWire({ ...item, policy: "plan" }, "incarnation")).toBe(true);
  expect(refusedOnTheWire({ ...item, roots: [item.roots[0]!, { ...item.roots[0]!, id: "nested", guestPath: `${item.roots[0]!.guestPath}/sub`, source: `${item.roots[0]!.guestPath}/sub` }] }, "incarnation")).toBe(true);
});

test("tool classes: the guest takes classes only, so an offered list its classes cannot reproduce is refused, never widened", () => {
  const all = ["Read", "Edit", "Write", "Bash"];
  for (let mask = 0; mask < 16; mask++) {
    const offered = all.filter((_, index) => mask & (1 << index));
    let classes: string[] | undefined;
    try { classes = coworkGuestToolClassesFor(offered); } catch { classes = undefined; }
    const reproducible = !(offered.includes("Read") && offered.includes("Write") && !offered.includes("Edit")) && !(offered.includes("Edit") && !(offered.includes("Read") && offered.includes("Write")));
    expect([offered.join(), classes !== undefined]).toEqual([offered.join(), reproducible]);
    if (classes) expect(coworkGuestToolsFromClasses(classes as ("read" | "write" | "execute")[]).sort()).toEqual([...offered].sort());
  }
  for (const bad of [["Glob"], ["read"], ["Read", "Read"], [1]] as unknown as string[][]) expect(() => coworkGuestToolClassesFor(bad)).toThrow("invalid_request");
  // Never offered by the host path (the supervisor's own derivation folds Edit with Read and Write).
  for (const policy of POLICIES) for (const classes of [["read", "write"], ["read", "write", "execute"], ["write"], ["read"]]) {
    const offered = coworkGuestOfferedTools(policy, { toolClasses: classes, network: "none" }, ["guest-compartment"]);
    expect(() => coworkGuestToolClassesFor(offered)).not.toThrow();
  }
});

test("the provider route: none is provider_unavailable; it may describe the selection but never change the scope or the model, nor carry a private key", () => {
  const f = fixture(), input = inputFor(f);
  expect(() => coworkConversationFor({ ...input, route: undefined as never })).toThrow("provider_unavailable");
  expect(() => coworkConversationFor({ ...input, route: { ...standinRoute(), kind: "other" as never } })).toThrow("provider_unavailable");
  const selection = { providerId: "standin", modelKey: FIXTURE_MODEL, providerModelId: "standin-1", family: "standin", protocol: "scripted", capabilities: ["tools"] };
  const wrong: Record<string, ReturnType<typeof standinRoute>["plan"]> = {
    model: ({ scope }) => ({ model: "other/model", provider: { scope, selection } }),
    scope: ({ scope }) => ({ model: FIXTURE_MODEL, provider: { scope: { ...scope, sessionId: "other" }, selection } }),
    selectionModel: ({ scope }) => ({ model: FIXTURE_MODEL, provider: { scope, selection: { ...selection, modelKey: "other/model" } } }),
    privateKey: ({ scope }) => ({ model: FIXTURE_MODEL, provider: { scope, selection: { ...selection, apiToken: "x" } as never } }),
    nested: ({ scope }) => ({ model: FIXTURE_MODEL, provider: { scope, selection: { ...selection, capabilities: [{ baseUrl: "x" }] } as never } }),
  };
  const outcome = (build: () => unknown): string => { try { build(); return "built"; } catch (error) { return (error as Error).message; } };
  for (const [name, plan] of Object.entries(wrong)) expect([name, outcome(() => coworkConversationFor({ ...input, route: standinRoute({ plan }) }))]).toEqual([name, "invalid_request"]);
});

test("the set is refused for a binding that is not active, in another workspace, or an offered list that does not match", () => {
  const f = fixture(), input = inputFor(f);
  expect(() => coworkConversationFor({ ...input, binding: { ...(input.binding as ConversationBinding), state: "archived" } })).toThrow("authority_denied");
  expect(() => coworkConversationFor({ ...input, context: { ...input.context, workspaceId: "workspace_other" } })).toThrow("authority_denied");
  expect(() => coworkConversationFor({ ...input, offered: ["Read", "Write"] })).toThrow("invalid_request");
});

test("plan view: under plan with an epoch the set carries the own writable plan scratch beside the read-only roots; the native wire refuses it today", () => {
  const plan = fixture({ policy: "plan" }), input = inputFor(plan);
  const item = coworkConversationFor({ ...input, planScratchEpoch: 3 }).conversations[0]!;
  expect(item.roots).toEqual([
    { id: plan.sourceId, guestPath: "/workspace/folders/grant", source: "/workspace/folders/grant", readOnly: true },
    { id: "plan-scratch", guestPath: "/workspace/plan/conversation/3", source: "/workspace/plan/conversation/3", readOnly: false },
  ]);
  // The cross-lane gap: the contract's allowed views and plan's read-only rule do not admit it (S7B + the supervisor).
  expect(() => onTheWire({ profile: "host-query-v1", conversations: [item] }, "incarnation")).toThrow();
  expect(coworkConversationFor(input).conversations[0]!.roots).toHaveLength(1);
  for (const epoch of [-1, 1.5, Number.NaN]) expect(() => coworkConversationFor({ ...input, planScratchEpoch: epoch })).toThrow("invalid_request");
  // Outside plan the epoch is ignored: no plan scratch is ever mounted writable beside a writable source.
  const ask = fixture({ policy: "ask" });
  expect(coworkConversationFor({ ...inputFor(ask), planScratchEpoch: 3 }).conversations[0]!.roots).toHaveLength(1);
  expect(coworkPlanScratchPath("s_0123456789ab", 0)).toBe("/workspace/plan/s_0123456789ab/0");
});
