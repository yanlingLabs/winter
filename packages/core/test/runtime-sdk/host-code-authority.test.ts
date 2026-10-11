import { expect, test } from "bun:test";
import {
  WINTER_BRAND,
  type PermissionResult,
} from "@yanlinglabs/winter-agent-sdk";
import {
  CanonicalHostCodeAuthority,
  type CanonicalHostCodePolicy,
  type HostCodePolicyAdapter,
} from "../../src/runtime-sdk/host-code-authority";
import type { HostCodeInvocation } from "../../src/runtime-sdk/host-code-broker";
const scope = {
  generationId: "query-generation",
  sessionId: "backend-session",
  toolUseId: "call",
};
function fixture() {
  let mode = "default",
    status = "allow",
    clear = 0,
    records = 0,
    forget = 0;
  const snapshots: unknown[] = [],
    requests: unknown[] = [];
  const adapter: HostCodePolicyAdapter = {
    settingsSeed: () => ({}),
    buildContext: (snapshot) => snapshot as unknown as Record<string, unknown>,
    create: (input) => ({
      clearReceipts() {
        clear++;
      },
      forgetCall() {
        forget++;
      },
      recordPromptResult(receipt) {
        input.getCurrentSnapshot(receipt);
        records++;
      },
      async evaluate(request) {
        requests.push(request);
        const snapshot = input.getCurrentSnapshot(request);
        snapshots.push(snapshot);
        return { status, policyRevision: snapshot.policyRevision };
      },
    }),
  };
  const policy = (): CanonicalHostCodePolicy => ({
    config: {
      permissionMode: mode as "default" | "plan",
      permissions: { deny: ["Bash(forbidden)"] },
    },
    sessionRoot: "/fixture/source",
    home: "/fixture/user",
    winterHome: "/fixture/private-run",
    storeHome: "/fixture/sdk",
    trustedWorkspace: true,
    brand: WINTER_BRAND,
  });
  const authority = new CanonicalHostCodeAuthority({
    adapter,
    getPolicy: policy,
  });
  const invocation: HostCodeInvocation = {
    callId: "call",
    threadId: "main",
    name: "Bash",
    input: { command: "echo ordinary" },
    scope,
    ancestors: [],
  };
  return {
    authority,
    adapter,
    invocation,
    snapshots,
    requests,
    setMode: (value: string) => {
      mode = value;
    },
    setStatus: (value: string) => {
      status = value;
    },
    counts: () => ({ clear, records, forget }),
  };
}
test("authority delegates exact host-bound invocation to SDK evaluator", async () => {
  const f = fixture();
  expect(
    await f.authority.authorize(
      f.invocation,
      "/fixture/source",
      new AbortController().signal,
    ),
  ).toBe(true);
  expect(f.requests).toEqual([
    { scope, toolName: "Bash", input: { command: "echo ordinary" } },
  ]);
  expect((f.snapshots[0] as { config: unknown }).config).toEqual({
    permissionMode: "default",
    permissions: { deny: ["Bash(forbidden)"] },
  });
});
test("every unresolved/denied/stale/cancelled decision refuses execution", async () => {
  const f = fixture();
  for (const state of ["deny", "needs_prompt", "stale", "cancelled"]) {
    f.setStatus(state);
    expect(
      await f.authority.authorize(
        f.invocation,
        "/fixture/source",
        new AbortController().signal,
      ),
    ).toBe(false);
  }
});
test("changing live policy invalidates receipts and increments revision", () => {
  const f = fixture(),
    initial = f.authority.policyRevision();
  f.setMode("plan");
  expect(f.authority.policyRevision()).not.toBe(initial);
  expect(f.counts().clear).toBe(2);
});
test("prompt result is bound to exact host revision, query and canonical cwd", () => {
  const f = fixture(),
    result: PermissionResult = {
      behavior: "allow",
      updatedInput: { command: "echo ordinary" },
    };
  const receipt = {
    ...scope,
    threadId: "main",
    toolName: "Bash",
    input: { command: "echo ordinary" },
    cwd: "/fixture/source",
    policyRevision: f.authority.policyRevision(),
    result,
  };
  f.authority.recordPromptResult(receipt);
  expect(f.counts().records).toBe(1);
  f.setMode("plan");
  expect(() => f.authority.recordPromptResult(receipt)).toThrow(
    "host-prompt-policy-stale",
  );
});
test("unsupported descendant reconstruction never falls back to root policy", async () => {
  const f = fixture();
  f.invocation.ancestors = [
    {
      callId: "parent",
      threadId: "main",
      name: "Agent",
      input: { subagent_type: "Explore" },
    },
  ];
  await expect(
    f.authority.authorize(
      f.invocation,
      "/fixture/source",
      new AbortController().signal,
    ),
  ).rejects.toThrow("host-descendant-policy-capability-missing");
});
test("completed host pre-hook decision is replayed without invoking reviewer again", async () => {
  const f = fixture();
  f.invocation.preHookDecision = {
    decision: "ask",
    message: "completed host reviewer requires approval",
  };
  await f.authority.authorize(
    f.invocation,
    "/fixture/source",
    new AbortController().signal,
  );
  const snapshot = f.snapshots[0] as {
    hookStage: { preToolUse(): Promise<unknown> };
  };
  expect(await snapshot.hookStage.preToolUse()).toEqual(
    f.invocation.preHookDecision,
  );
  f.authority.forgetCall("call");
  expect(f.counts().forget).toBe(1);
  f.authority.dispose();
  expect(f.counts().clear).toBe(2);
});

test("an evaluator allow for an old revision cannot authorize a changed policy", async () => {
  let mode: "default" | "plan" = "default";
  const authority = new CanonicalHostCodeAuthority({
    getPolicy: () => ({ config: { permissionMode: mode }, sessionRoot: "/fixture", home: "/fixture", trustedWorkspace: true, brand: WINTER_BRAND }),
    adapter: { settingsSeed: () => ({}), create: ({ getCurrentSnapshot }) => ({
      clearReceipts() {}, recordPromptResult() {},
      async evaluate(request) { const captured = getCurrentSnapshot(request); mode = "plan"; return { status: "allow", policyRevision: captured.policyRevision }; },
    }) },
  });
  expect(await authority.authorize(fixture().invocation, "/fixture", new AbortController().signal)).toBe(false);
});
