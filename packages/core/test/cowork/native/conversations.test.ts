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
  expect(contexts).toEqual([{ workspaceId: h.workspaceId, incarnationId: running.incarnationId, leaseEpoch: running.leaseEpoch, guestBootId: running.guestBootId }]);
  const order = h.events.filter(event => ["host:ready-sent", "host:conversations-sent", "host:runtime-ready"].includes(event));
  expect(order).toEqual(["host:ready-sent", "host:conversations-sent", "host:runtime-ready"]);
  expect(h.records.get(h.workspaceId).power).toBe("running");
  expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
});
test("power is still `starting` while the host waits for runtime_ready", async () => {
  const h = createHarness({ behavior: { conversations: "silent" }, conversations: guidedSet, timeouts: { runtimeReadyMs: 150 }, onCheckpoint: (phase, harness) => { if (phase === "conversations-sent") expect(harness.records.get(harness.workspaceId).power).toBe("starting"); } });
  const error = await failure(h);
  expect(String(error!.code)).toBe("timeout");
  expect(error!.message).toContain("runtime_ready"); // which wait expired, deterministically (no wall-clock bound)
  settledOrderly(h);
});
test("runtime_ready is awaited for its OWN deadline, not the mounted one: an answer at 600 ms beats a 5000 ms wait though the mounted wait is 400 ms", async () => {
  const h = createHarness({ behavior: { conversations: "late-ready" }, conversations: guidedSet, timeouts: { runtimeReadyMs: 5_000 } });
  const running = await h.host.start(h.workspaceId);
  expect(h.records.get(h.workspaceId).power).toBe("running");
  await running.stop();
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
test("a duplicate runtime_ready still passes the up-sequence check: no gap for a later bootstrap-up consumer, and nothing else moves", async () => {
  const single = createHarness({ behavior: { conversations: "ok" }, conversations: guidedSet }), doubled = createHarness({ behavior: { conversations: "duplicate-ready" }, conversations: guidedSet });
  const first = await single.host.start(single.workspaceId), second = await doubled.host.start(doubled.workspaceId);
  await Bun.sleep(20);
  // hello, receipt, mounted, runtime_ready = 4 frames; the duplicate is the fifth.
  expect(single.host.nextBootstrapUpSequence(single.workspaceId)).toBe(5);
  expect(doubled.host.nextBootstrapUpSequence(doubled.workspaceId)).toBe(6);
  expect(doubled.host.duplicateReadySeqAnomaly(doubled.workspaceId)).toBe(false);
  expect(doubled.records.get(doubled.workspaceId).power).toBe("running");
  expect(doubled.ledger.listActive().map(record => record.state)).toEqual(["running"]);
  expect(owners(doubled).every(owner => owner !== null)).toBe(true);
  await first.stop(); await second.stop();
});
test("a duplicate runtime_ready with a wrong sequence number is ignored but recorded: still running, the expected sequence unchanged, the anomaly flag set", async () => {
  const h = createHarness({ conversations: guidedSet });
  const running = await h.host.start(h.workspaceId);
  const set = h.launcher.last.conversationSets[0]!;
  expect(h.host.duplicateReadySeqAnomaly(h.workspaceId)).toBe(false);
  h.launcher.last.push({ t: "mux_up", frame: { class: "bootstrap", seq: 9, message: { t: "runtime_ready", operationId: set.operationId, nonce: set.nonce, conversations: 1, continuations: [] } } });
  await Bun.sleep(10);
  expect(h.host.nextBootstrapUpSequence(h.workspaceId)).toBe(5);
  expect(h.host.duplicateReadySeqAnomaly(h.workspaceId)).toBe(true);
  expect(h.records.get(h.workspaceId).power).toBe("running");
  expect(h.ledger.listActive().map(record => record.state)).toEqual(["running"]);
  expect(owners(h).every(owner => owner !== null)).toBe(true);
  await running.stop();
});
test("a duplicate runtime_ready that arrives after the start is counted in the up sequence too, and changes nothing", async () => {
  const h = createHarness({ conversations: guidedSet });
  const running = await h.host.start(h.workspaceId);
  const set = h.launcher.last.conversationSets[0]!;
  expect(h.host.nextBootstrapUpSequence(h.workspaceId)).toBe(5);
  h.launcher.last.push({ t: "mux_up", frame: { class: "bootstrap", seq: 5, message: { t: "runtime_ready", operationId: set.operationId, nonce: set.nonce, conversations: 1, continuations: [] } } });
  await Bun.sleep(10);
  expect(h.host.nextBootstrapUpSequence(h.workspaceId)).toBe(6);
  expect(h.records.get(h.workspaceId).power).toBe("running");
  await running.stop();
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

/** The first root of the first conversation, with `source` changed (guestPath untouched). */
const withRootSource = (set: ReturnType<typeof guidedSet>, source: string): ReturnType<typeof guidedSet> => ({
  ...set, conversations: set.conversations.map((conversation, index) => index > 0 ? conversation : { ...conversation, roots: conversation.roots.map((root, at) => at === 0 ? { ...root, source } : root) }),
});
const HOST_REFUSALS: [string, Parameters<typeof createHarness>[0] extends infer O ? NonNullable<O extends { conversations?: infer C } ? C : never> : never][] = [
  ["a second host-query conversation", twoGuidedSet],
  ["a set above the 20,480 byte ceiling", oversizedSet],
  ["a root whose source differs from its guest path (both admitted views)", context => withRootSource(guidedSet(context), "/workspace/folders/other")],
  ["a root whose source lies outside the admitted views", context => withRootSource(guidedSet(context), "/workspace/system/elsewhere")],
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
