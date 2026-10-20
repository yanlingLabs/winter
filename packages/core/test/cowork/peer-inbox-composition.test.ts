import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionEvent } from "@yanlinglabs/winter-protocol";
import { SessionMessaging, type SessionMessagingDeps } from "../../src/agent/session-messaging";
import { coworkLostInputNotice, coworkStalledInboxNotice } from "../../src/cowork/held-input";
import { coworkHeldInputGate, coworkPeerInboxNotes, type CoworkNoticeSink } from "../../src/cowork/peer-inbox-composition";
import type { CoworkHeldInputInbox } from "../../src/cowork/held-input-reconcile";

// The composition seam for Cowork peer messaging, with fakes. Behind the refusal: nothing in production calls it.
const messagingOnly = () => new SessionMessaging({ store: { meta: () => { throw new Error("unused"); }, list: () => [] } as never, derive: () => "active" as const, working: () => false, sessions: { get: () => undefined, ensure: async () => { throw new Error("unused"); } } as never, log: () => {} });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("the lost and stalled hooks append the fixed notices as continuity_warning events on the recipient's main thread", () => {
  const seen: Array<{ sessionId: string; input: Record<string, unknown> }> = [];
  const sink: CoworkNoticeSink = { append: (sessionId, input) => { seen.push({ sessionId, input }); SessionEvent.parse({ ...input, seq: 1, ts: 1 }); } };
  const notes = coworkPeerInboxNotes(sink);
  notes.noteLostPeerMessage("s_rec");
  notes.noteStalledPeerInbox("s_rec");
  expect(seen.map(entry => entry.sessionId)).toEqual(["s_rec", "s_rec"]);
  expect(seen[0]!.input).toMatchObject({ type: "continuity_warning", threadId: "main", ...coworkLostInputNotice() });
  expect(seen[1]!.input).toMatchObject({ type: "continuity_warning", threadId: "main", ...coworkStalledInboxNotice() });
  // The notices name no sender and no receipt.
  expect(JSON.stringify(seen)).not.toContain("pr_");
});
test("a sink that throws never throws into the drain", () => {
  const notes = coworkPeerInboxNotes({ append: () => { throw new Error("log closed"); } });
  expect(() => notes.noteLostPeerMessage("s_rec")).not.toThrow();
  expect(() => notes.noteStalledPeerInbox("s_rec")).not.toThrow();
});
test("the messaging service wires both hooks: a lost or stalled notice reaches the sink through SessionMessaging's own deps type", () => {
  const seen: string[] = [];
  const notes = coworkPeerInboxNotes({ append: (_sid, input) => { seen.push(input.warning); } });
  const deps: Pick<SessionMessagingDeps, "noteLostPeerMessage" | "noteStalledPeerInbox"> = { noteLostPeerMessage: (recipient, _receipt) => notes.noteLostPeerMessage(recipient), noteStalledPeerInbox: notes.noteStalledPeerInbox };
  deps.noteLostPeerMessage!("s_rec", "pr_x"); deps.noteStalledPeerInbox!("s_rec");
  expect(seen).toEqual(["peer_message_lost", "peer_inbox_stalled"]);
});
test("runInRecipientChain runs after the recipient's earlier jobs and before later ones, per recipient; a throw rejects only that job", async () => {
  const messaging = messagingOnly(), order: string[] = [];
  const slow = messaging.runInRecipientChain("s_a", async () => { order.push("a1:start"); await sleep(30); order.push("a1:end"); });
  const second = messaging.runInRecipientChain("s_a", async () => { order.push("a2"); });
  const other = messaging.runInRecipientChain("s_b", async () => { order.push("b1"); });
  const failing = messaging.runInRecipientChain("s_a", async () => { throw new Error("boom"); });
  const third = messaging.runInRecipientChain("s_a", async () => { order.push("a3"); });
  await expect(failing).rejects.toThrow("boom");
  await Promise.all([slow, second, other, third]);
  expect(order.filter(entry => entry.startsWith("a"))).toEqual(["a1:start", "a1:end", "a2", "a3"]);
  expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a1:end")); // another recipient is not held up
});
test("the held-input gate reconciles inside the recipient's chain, then drains when the epoch is published", async () => {
  const log: string[] = [];
  const inbox: CoworkHeldInputInbox = { verdict: () => { log.push("verdict"); return { action: "discard" }; }, confirmCommitted: () => undefined, deliveredUnconfirmed: () => [] };
  const messaging = { runInRecipientChain: async (sid: string, work: () => Promise<void>) => { log.push(`chain:${sid}`); await work(); log.push("chain:done"); }, drainCoworkInbox: async (sid: string) => { log.push(`drain:${sid}`); } };
  const gate = coworkHeldInputGate({ inbox, messaging: () => messaging });
  expect(gate.enabled).toBe(true);
  const verbs = { discard: async () => { log.push("discard"); } } as never;
  await gate.reconcile({ sessionId: "s_rec", epoch: { incarnationId: "i", leaseEpoch: 1 }, verbs, inputs: [{ inputId: "pr_1", state: "held", holdToken: "a".repeat(64) } as never] });
  expect(log).toEqual(["chain:s_rec", "verdict", "discard", "chain:done"]);
  gate.published!("s_rec");
  expect(log.at(-1)).toBe("drain:s_rec");
  // Before the messaging service exists, the reconcile still runs (directly) and published is a no-op.
  const early = coworkHeldInputGate({ inbox, messaging: () => undefined });
  log.length = 0;
  await early.reconcile({ sessionId: "s_rec", epoch: { incarnationId: "i", leaseEpoch: 1 }, verbs, inputs: [] });
  expect(() => early.published!("s_rec")).not.toThrow();
});
test("anti-wiring: no production source imports the composition, and the daemon still supplies no peer inbox or held-input gate", () => {
  const root = join(import.meta.dir, "..", "..", "src");
  for (const file of ["daemon.ts", "ipc/server.ts", "cowork/native-wiring.ts"]) {
    const text = readFileSync(join(root, file), "utf8");
    expect(text).not.toContain("peer-inbox-composition");
    expect(text).not.toMatch(/heldInput\s*:/);
  }
  expect(readFileSync(join(root, "daemon.ts"), "utf8")).not.toMatch(/peerInbox\s*:/);
});
