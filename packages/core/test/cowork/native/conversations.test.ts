import { afterEach, expect, test } from "bun:test";
import { CoworkNativeHostError, COWORK_NATIVE_HOST_DEFAULT_TIMEOUTS, type CoworkNativeConversationContext } from "../../../src/cowork/native/host";
import { cleanupHarnesses, createHarness } from "./harness";
import type { FakeBehavior } from "./fake-launcher";
import { guidedSet, oversizedSet, toolsOnlySet, twoGuidedSet } from "./conversation-fixtures";

afterEach(() => { cleanupHarnesses(); });
// Host adapter: the conversation set (contract section 6.1) is sent once after `mounted`, and `running` waits for `runtime_ready`.
type H = ReturnType<typeof createHarness>;
const owners = (h: H) => h.volumes.records(h.workspaceId).map(v => v.owner);
const failure = (h: H) => h.host.start(h.workspaceId).then(() => null, error => error as CoworkNativeHostError);
const settledOrderly = (h: H) => {
  expect(h.records.get(h.workspaceId).power).toBe("stopped");
  expect(owners(h)).toEqual([null, null]); expect(h.ledger.listActive()).toEqual([]);
  expect(h.launcher.last.received.find(item => item.message.t === "stop")!.message).toMatchObject({ reason: "failed-start" });
};

test("happy path: the set goes out once after mounted, bound to the plan, and running waits for runtime_ready", async () => {
  const contexts: CoworkNativeConversationContext[] = [];
  const h = createHarness({ conversations: context => { contexts.push(context); return guidedSet(context); } });
  const running = await h.host.start(h.workspaceId);
  const sets = h.launcher.last.conversationSets;
  expect(sets.length).toBe(1);
  expect(sets[0]).toMatchObject({ profile: "host-query-guided-v1", incarnationId: running.incarnationId });
  expect(sets[0]!.conversations.length).toBe(1);
  expect(contexts).toEqual([{ workspaceId: h.workspaceId, incarnationId: running.incarnationId, leaseEpoch: running.leaseEpoch, guestBootId: "66666666-6666-4666-8666-666666666666" }]);
  const order = h.events.filter(event => ["host:ready-sent", "host:conversations-sent", "host:runtime-ready"].includes(event));
  expect(order).toEqual(["host:ready-sent", "host:conversations-sent", "host:runtime-ready"]);
  expect(h.records.get(h.workspaceId).power).toBe("running");
  expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
});
test("power is still `starting` while the host waits for runtime_ready", async () => {
  const h = createHarness({ behavior: { conversations: "silent" }, conversations: guidedSet, timeouts: { runtimeReadyMs: 150 }, onCheckpoint: (phase, harness) => { if (phase === "conversations-sent") expect(harness.records.get(harness.workspaceId).power).toBe("starting"); } });
  const started = Date.now();
  const error = await failure(h);
  expect(String(error!.code)).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(380); // the runtime_ready deadline (150 ms here), not the 400 ms mounted one
  settledOrderly(h);
});
test("a tools-only set may hold several conversations and is acknowledged the same way", async () => {
  const h = createHarness({ conversations: toolsOnlySet });
  const running = await h.host.start(h.workspaceId);
  expect(h.launcher.last.conversationSets[0]!.conversations.length).toBe(2);
  expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
});
test("no provider, or a provider with nothing to say, starts no supervisor: no set is sent and nothing waits for runtime_ready", async () => {
  for (const conversations of [undefined, () => null]) {
    const h = createHarness({ conversations });
    const running = await h.host.start(h.workspaceId);
    expect(h.launcher.last.conversationSets).toEqual([]);
    expect(h.events).not.toContain("host:conversations-sent");
    await running.stop();
  }
});
test("a duplicate runtime_ready is ignored: the first stands, as a second DRAIN does", async () => {
  const h = createHarness({ behavior: { conversations: "duplicate-ready" }, conversations: guidedSet });
  const running = await h.host.start(h.workspaceId);
  await Bun.sleep(20);
  expect(h.records.get(h.workspaceId).power).toBe("running");
  expect(h.launcher.last.conversationSets.length).toBe(1);
  expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
});

const GUEST_FAILURES: [string, FakeBehavior, string][] = [
  ["bad_conversations", { conversations: "bad" }, "guest_fault"],
  ["supervisor_failed", { conversations: "supervisor-failed" }, "guest_fault"],
  ["second_conversations", { conversations: "second" }, "guest_fault"],
  ["no answer within the pinned timeout", { conversations: "silent" }, "timeout"],
  ["runtime_ready with a wrong count", { conversations: "wrong-count" }, "protocol"],
  ["runtime_ready echoing another nonce", { conversations: "wrong-nonce" }, "protocol"],
  ["runtime_ready echoing another operation", { conversations: "wrong-operation" }, "protocol"],
  ["runtime_ready before any set was sent (out of order)", { conversations: "early-ready" }, "protocol"],
];
for (const [name, behavior, code] of GUEST_FAILURES) {
  test(`${name}: the start fails with ${code}, the stop is orderly and everything is released`, async () => {
    const h = createHarness({ behavior, conversations: guidedSet });
    const error = await failure(h);
    expect(error).toBeInstanceOf(CoworkNativeHostError); expect(String(error!.code)).toBe(code);
    settledOrderly(h);
  });
}

const HOST_REFUSALS: [string, Parameters<typeof createHarness>[0] extends infer O ? NonNullable<O extends { conversations?: infer C } ? C : never> : never][] = [
  ["a second host-query conversation", twoGuidedSet],
  ["a set above the 20,480 byte ceiling", oversizedSet],
  ["a set bound to another lease epoch", context => guidedSet({ ...context, leaseEpoch: context.leaseEpoch + 1 })],
  ["a set bound to another incarnation", context => guidedSet({ ...context, incarnationId: "inc-other" })],
  ["a set whose providers name another guest boot", context => guidedSet({ ...context, guestBootId: "77777777-7777-4777-8777-777777777777" })],
];
for (const [name, conversations] of HOST_REFUSALS) {
  test(`${name} is refused by the host before anything is sent`, async () => {
    const h = createHarness({ conversations });
    const error = await failure(h);
    expect(String(error!.code)).toBe("protocol");
    expect(h.launcher.last.conversationSets).toEqual([]);
    expect(h.events).not.toContain("host:conversations-sent");
    settledOrderly(h);
  });
}

test("the timeout from the set to runtime_ready is pinned at 60 seconds", () => {
  expect(COWORK_NATIVE_HOST_DEFAULT_TIMEOUTS.runtimeReadyMs).toBe(60_000);
});
test("a crash right after the set went out leaves ownership retained: nothing is released by the death", async () => {
  const h = createHarness({ conversations: guidedSet, crashAt: "conversations-sent" });
  await failure(h);
  expect(h.records.get(h.workspaceId).power).not.toBe("stopped");
  expect(owners(h).every(owner => owner !== null)).toBe(true);
});
