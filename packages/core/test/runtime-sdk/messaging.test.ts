// P8b Task 12 — two in-memory-driven sessions and the router between them.
//
// NO CHILD PROCESS ANYWHERE IN THIS FILE. The router is built from its own published factories over
// `createInMemoryRuntimeDirectoryStore()`; each "session" is a fake `Query.messaging` facet plus a
// `push` sink that records what a real `HostPromptQueue` would have been handed. That is exactly the
// seam Task 12 owns: whether a delivery ends up as the target session's next user turn.
import { describe, expect, test } from "bun:test";
import {
  buildChildAddress,
  buildSessionAddress,
  serializeRuntimeAddress,
  delivered,
  queued,
} from "@yanlinglabs/winter-agent-sdk/messaging";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, PermissionClassLabel } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { Query, SessionMessagingFacet } from "@yanlinglabs/winter-agent-sdk";
import * as winter from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryRuntimeDirectoryStore, createRuntimeSdk } from "@yanlinglabs/winter-runtime-sdk";
import type { RuntimeDirectoryStore, RuntimeSdk, SerializedRuntimeAddress } from "@yanlinglabs/winter-runtime-sdk";
import { NORMA_BRAND } from "../../src/runtime-sdk/brand";
import { attachWinterSession, releaseAllHeld, renderAttributedTurn } from "../../src/runtime-sdk/messaging";
import type { NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import { NORMA_PEER_VERSIONS } from "../../src/runtime-sdk/versions";

// ── The two sessions ────────────────────────────────────────────────────────────────────────────

interface FakeSession {
  backendSessionId: string;
  pushed: string[];
  /** What the facet was asked to do, in order — the child doors must reach the REAL facet. */
  facetCalls: string[];
  query: Pick<Query, "messaging">;
  status: () => ListedRuntimeObject["status"];
  setStatus(s: ListedRuntimeObject["status"]): void;
}

function fakeSession(backendSessionId: string, permissionClass: PermissionClassLabel = "prompts"): FakeSession {
  const pushed: string[] = [];
  const facetCalls: string[] = [];
  let status: ListedRuntimeObject["status"] = "idle";
  const facet: SessionMessagingFacet = {
    listReachable: async () => {
      facetCalls.push("listReachable");
      return [];
    },
    // A REAL spawned child answers this over the control pipe; a Norma session must never reach it
    // (surface map §2.5: "no messaging runtime is registered in that process"). If a test ever sees
    // this call, the wrapper has stopped re-pointing `deliver` at the host queue.
    deliver: async (msg: GlobalAgentMessage): Promise<DeliveryOutcome> => {
      facetCalls.push(`deliver:${msg.messageId}`);
      return { status: "unavailable", messageId: msg.messageId, retryable: false, reason: "no messaging runtime is registered in that process" };
    },
    steerChild: async (id, msg) => {
      facetCalls.push(`steerChild:${id}`);
      return delivered(msg.messageId);
    },
    resumeChild: async (id, msg) => {
      facetCalls.push(`resumeChild:${id}`);
      return { status: "resumed_and_delivered", messageId: msg.messageId };
    },
    subscribeIdle: async (id, opts) => {
      facetCalls.push(`subscribeIdle:${id}`);
      return { status: "subscribed", messageId: opts.messageId };
    },
    senderClass: async () => permissionClass,
    readNotifications: async () => {
      facetCalls.push("readNotifications");
      return { notifications: [], remaining: 0 };
    },
    onIdleNotice: () => {
      facetCalls.push("onIdleNotice");
      return () => {};
    },
  };
  return {
    backendSessionId,
    pushed,
    facetCalls,
    query: { messaging: facet },
    status: () => status,
    setStatus(s) {
      status = s;
    },
  };
}

/** The real router, over an in-memory store. `NormaRuntimeSdk` is structurally satisfied by the two
 *  members this task's door reads — building the whole daemon handle here would drag in a secret
 *  store and an executable resolution neither of which messaging touches. */
function harness(
  store: RuntimeDirectoryStore = createInMemoryRuntimeDirectoryStore(),
  /** `createNormaRuntimeSdk`'s `sessionPermissionClass` seam — the host's declaration for a session
   *  this process holds no live facet for. Absent is the shipped daemon's state in Task 12. */
  declaredClass?: PermissionClassLabel,
): {
  runtime: NormaRuntimeSdk;
  sdk: RuntimeSdk;
  store: RuntimeDirectoryStore;
} {
  const sdk = createRuntimeSdk({
    peers: { winter },
    peerVersions: NORMA_PEER_VERSIONS,
    keychain: { read: async () => undefined },
    brand: NORMA_BRAND,
    directoryStore: store,
    handoff: { winterHome: "/tmp/norma-messaging-test" },
    messaging: declaredClass === undefined ? {} : { messaging: { winter: { permissionClass: () => declaredClass } } },
  });
  const runtime = { sdk } as unknown as NormaRuntimeSdk;
  return { runtime, sdk, store };
}

const addr = (id: string): SerializedRuntimeAddress => serializeRuntimeAddress(buildSessionAddress(id)) as SerializedRuntimeAddress;

describe("attachWinterSession", () => {
  test("a delivery addressed to the target's NAME lands in its push sink, receipted `delivered`", async () => {
    const { runtime, store } = harness();
    const a = fakeSession("be_a");
    const b = fakeSession("be_b");

    const attachedA = attachWinterSession(runtime, { sessionId: "s_a", backendSessionId: a.backendSessionId, query: a.query, push: (t) => a.pushed.push(t), displayName: "alpha", mode: "code" });
    const attachedB = attachWinterSession(runtime, { sessionId: "s_b", backendSessionId: b.backendSessionId, query: b.query, push: (t) => b.pushed.push(t), displayName: "beta", mode: "chat" });
    await attachedA.ready;
    await attachedB.ready;

    const outcome = await runtime.sdk.messaging.send({
      from: buildSessionAddress(a.backendSessionId),
      to: "beta",
      body: "the deploy is green",
      summary: "deploy",
      originToolCallId: "toolu_01",
    });

    expect(outcome.status).toBe("delivered");
    // The target's own queue is where it landed — never the facet's `deliver`, which on a spawned
    // child answers `messaging_unavailable`.
    expect(b.pushed).toHaveLength(1);
    expect(b.pushed[0]).toContain("the deploy is green");
    expect(b.facetCalls.filter((c) => c.startsWith("deliver:"))).toHaveLength(0);
    expect(a.pushed).toHaveLength(0);

    // WS-15 §6.2: the receipt is durable, and it is what makes a retry idempotent.
    const record = await store.deliveries.get(outcome.messageId);
    expect(record?.outcome?.status).toBe("delivered");
    expect(record?.claimedBy).toBe("winter-agent");

    // A retry under the same (sender, tool-call) pair returns the STORED outcome and pushes nothing.
    const retry = await runtime.sdk.messaging.send({
      from: buildSessionAddress(a.backendSessionId),
      to: "beta",
      body: "the deploy is green",
      originToolCallId: "toolu_01",
    });
    expect(retry).toEqual(outcome);
    expect(b.pushed).toHaveLength(1);

    attachedA.detach();
    attachedB.detach();
    await attachedB.ready;
  });

  test("a running target is `queued`, not `delivered` — the router's own live-status rule", async () => {
    const { runtime } = harness();
    const a = fakeSession("be_a2");
    const b = fakeSession("be_b2");
    b.setStatus("running");

    const attachedA = attachWinterSession(runtime, { sessionId: "s_a", backendSessionId: a.backendSessionId, query: a.query, push: (t) => a.pushed.push(t), displayName: "alpha2" });
    const attachedB = attachWinterSession(runtime, { sessionId: "s_b", backendSessionId: b.backendSessionId, query: b.query, push: (t) => b.pushed.push(t), displayName: "beta2", status: b.status });
    await attachedA.ready;
    await attachedB.ready;

    const outcome = await runtime.sdk.messaging.send({ from: buildSessionAddress(a.backendSessionId), to: "beta2", body: "mid-turn", originToolCallId: "toolu_02" });
    expect(outcome).toEqual(queued(outcome.messageId));
    expect(b.pushed).toHaveLength(1);
  });

  test("the wrapper's rendered frame is BYTE-IDENTICAL to the router's own push path", async () => {
    // The drift tripwire this module's header promises. `renderAttributedTurn` is not re-exported by
    // the published router, so Norma rebuilds it; a push-ONLY handle takes the router's own
    // rendering, and the two strings must be the same one.
    //
    // The declared class is load-bearing here and nowhere else: a push-only handle carries NO facet,
    // so without a host declaration its receiver class is `unknown` and the router holds the message
    // before any rendering happens (which is exactly what the "unattached receivers hold" test below
    // pins). Declaring it is what lets this comparison reach the push at all.
    const { runtime } = harness(createInMemoryRuntimeDirectoryStore(), "prompts");
    const wrapped = fakeSession("be_wrapped");
    const routerPushed: string[] = [];

    const attachedSender = attachWinterSession(runtime, { sessionId: "s_send", backendSessionId: "be_send", query: fakeSession("be_send").query, push: () => {}, displayName: "sender" });
    const attachedWrapped = attachWinterSession(runtime, { sessionId: "s_w", backendSessionId: wrapped.backendSessionId, query: wrapped.query, push: (t) => wrapped.pushed.push(t), displayName: "wrapped" });
    await attachedSender.ready;
    await attachedWrapped.ready;

    // The same session, recorded a SECOND time under a push-only handle at its own address.
    const rawAddress = addr("be_raw");
    await runtime.sdk.directory.record({
      address: rawAddress,
      parsed: buildSessionAddress("be_raw"),
      runtimeKind: "winter-agent",
      objectKind: "session",
      transport: "winter-session",
      displayName: "raw",
      status: "idle",
      mode: "code",
      generation: 1,
      selection: {
        runtimeKind: "winter-agent", providerId: "unstated", modelRef: "unstated/unstated", family: "unstated",
        authFamily: "custom", sdkVersion: NORMA_PEER_VERSIONS.winterAgentSdk, reason: "test", decidedAt: new Date().toISOString(),
      },
      backendSessionId: "be_raw",
      capabilities: { message: true, resume: true, notifyWhenIdle: false, reply: true },
      updatedAt: new Date().toISOString(),
    });
    const detachRaw = runtime.sdk.messaging.attachWinterSession(rawAddress, { push: (t) => { routerPushed.push(t); } });

    const body = 'a <body> with "quotes" & an ampersand';
    await runtime.sdk.messaging.send({ from: buildSessionAddress("be_send"), to: "wrapped", body, summary: "s & <um>", originToolCallId: "toolu_w" });
    await runtime.sdk.messaging.send({ from: buildSessionAddress("be_send"), to: "raw", body, summary: "s & <um>", originToolCallId: "toolu_r" });

    expect(wrapped.pushed).toHaveLength(1);
    expect(routerPushed).toHaveLength(1);
    // Only the message id differs (it is derived from the tool-call id), so normalise that one span.
    const strip = (s: string) => s.replace(/message-id="[^"]*"/, 'message-id="X"');
    expect(strip(wrapped.pushed[0]!)).toBe(strip(routerPushed[0]!));
    detachRaw();
  });

  test("a detached session is `unavailable` to messaging — never a throw, and nothing is pushed", async () => {
    const { runtime } = harness();
    const a = fakeSession("be_a3");
    const b = fakeSession("be_b3");

    const attachedA = attachWinterSession(runtime, { sessionId: "s_a", backendSessionId: a.backendSessionId, query: a.query, push: (t) => a.pushed.push(t), displayName: "alpha3" });
    const attachedB = attachWinterSession(runtime, { sessionId: "s_b", backendSessionId: b.backendSessionId, query: b.query, push: (t) => b.pushed.push(t), displayName: "beta3" });
    await attachedA.ready;
    await attachedB.ready;

    attachedB.detach();
    await attachedB.ready;

    const outcome = await runtime.sdk.messaging.send({ from: buildSessionAddress(a.backendSessionId), to: "beta3", body: "anyone home?", originToolCallId: "toolu_03" });

    // `detach()` parks the row `exited` and RELEASES the name lease, so the name now answers WS-10
    // §11 rule 5's stale-name refusal rather than "no such agent" — and nothing reached the child.
    expect(outcome.status).toBe("refused");
    expect((outcome as { reason: string }).reason).toContain("no longer reachable");
    expect(b.pushed).toHaveLength(0);
    expect(b.facetCalls.filter((c) => c.startsWith("deliver:"))).toHaveLength(0);

    // By CANONICAL address the row is still there and still not live. With NO host declaration of
    // the receiver's permission class this is the router's fail-closed `held` — the daemon's state
    // in Task 12, pinned so that the day `sessionPermissionClass` is wired the change is visible.
    const byAddress = await runtime.sdk.messaging.send({ from: buildSessionAddress(a.backendSessionId), to: addr(b.backendSessionId), body: "still there?", originToolCallId: "toolu_04" });
    expect(byAddress.status).toBe("held");
    expect(b.pushed).toHaveLength(0);
  });

  test("with the class DECLARED, a detached session answers `unavailable` — and never cold-resumes", async () => {
    // The brief's outcome, and the reason `detach()` drops `backendSessionId`: with the receiver's
    // class known the inbound matrix ACCEPTS, so the delivery reaches the Winter adapter — which,
    // finding no live handle, would open a second `winter` process on the transcript if the row
    // still named one. It does not, so the answer is the honest non-retryable `unavailable` and no
    // process is spawned. (A spawn here would be visible: `peers.winter.query` would try to exec a
    // binary this test never provides.)
    const { runtime } = harness(createInMemoryRuntimeDirectoryStore(), "prompts");
    const a = fakeSession("be_a4");
    const b = fakeSession("be_b4");

    const attachedA = attachWinterSession(runtime, { sessionId: "s_a", backendSessionId: a.backendSessionId, query: a.query, push: (t) => a.pushed.push(t), displayName: "alpha4" });
    const attachedB = attachWinterSession(runtime, { sessionId: "s_b", backendSessionId: b.backendSessionId, query: b.query, push: (t) => b.pushed.push(t), displayName: "beta4" });
    await attachedA.ready;
    await attachedB.ready;
    attachedB.detach();
    await attachedB.ready;

    const outcome = await runtime.sdk.messaging.send({ from: buildSessionAddress(a.backendSessionId), to: addr(b.backendSessionId), body: "still there?", originToolCallId: "toolu_04b" });
    expect(outcome.status).toBe("unavailable");
    expect(outcome).toMatchObject({ retryable: false });
    expect((outcome as { reason: string }).reason).toContain("no backend session id");
    expect(b.pushed).toHaveLength(0);
  });

  test("an unaddressable entry is the router's typed refusal, raised out of `ready`", async () => {
    const { runtime } = harness();
    const s = fakeSession("be_bad");
    // `UnaddressableEntryError` (surface map §8.5): "A LISTED OBJECT IS ALWAYS ADDRESSABLE" — a row
    // whose address is not canonical is refused at the door rather than listed and unreachable.
    const attached = attachWinterSession(runtime, { sessionId: "s_bad", backendSessionId: "", query: s.query, push: () => {} });
    await expect(attached.ready).rejects.toThrow(/UnaddressableEntryError|not.*canonical|address/i);
  });

  test("two sessions claiming ONE name: resolution is `ambiguous`, and neither is pushed to", async () => {
    // The honest reading of "a name collision". `directory.record` does NOT refuse a duplicate
    // display name (`syncLeases` only releases leases held by the SAME address), because a name is a
    // handle, not an identity — a Norma session title is not unique. The refusal lands where it can
    // name both candidates: at resolution, as WS-10 §11's `ambiguous`.
    const { runtime } = harness();
    const a = fakeSession("be_s");
    const b = fakeSession("be_x");
    const c = fakeSession("be_y");

    for (const [sid, sess] of [["s_s", a], ["s_x", b], ["s_y", c]] as const) {
      const at = attachWinterSession(runtime, {
        sessionId: sid, backendSessionId: sess.backendSessionId, query: sess.query,
        push: (t) => sess.pushed.push(t), displayName: sid === "s_s" ? "sender" : "twin",
      });
      await at.ready;
    }

    const outcome = await runtime.sdk.messaging.send({ from: buildSessionAddress("be_s"), to: "twin", body: "which of you?", originToolCallId: "toolu_05" });
    expect(outcome.status).toBe("ambiguous");
    expect((outcome as { candidates: ListedRuntimeObject[] }).candidates.map((r) => r.address).sort()).toEqual([addr("be_x"), addr("be_y")].sort());
    expect(b.pushed).toHaveLength(0);
    expect(c.pushed).toHaveLength(0);
  });

  test("a CHILD is reached through the owning session's real facet, never through the queue", async () => {
    // WS-10 §12's amendment / P8b-15: a child engine has no facet of its own. The wrapper re-points
    // `deliver` and NOTHING else, which is what keeps `steerChild` reaching the live `Query`.
    const { runtime } = harness();
    const parentSession = fakeSession("be_p");
    const sender = fakeSession("be_sender");

    const attachedSender = attachWinterSession(runtime, { sessionId: "s_send", backendSessionId: "be_sender", query: sender.query, push: () => {}, displayName: "sender" });
    const attachedParent = attachWinterSession(runtime, { sessionId: "s_p", backendSessionId: "be_p", query: parentSession.query, push: (t) => parentSession.pushed.push(t), displayName: "parent" });
    await attachedSender.ready;
    await attachedParent.ready;

    const childAddress = serializeRuntimeAddress(buildChildAddress("be_p", "c_1")) as SerializedRuntimeAddress;
    await runtime.sdk.directory.record({
      address: childAddress,
      parsed: buildChildAddress("be_p", "c_1"),
      runtimeKind: "winter-agent",
      objectKind: "agent",
      transport: "winter-thread",
      displayName: "worker",
      status: "running",
      mode: "code",
      generation: 1,
      selection: {
        runtimeKind: "winter-agent", providerId: "unstated", modelRef: "unstated/unstated", family: "unstated",
        authFamily: "custom", sdkVersion: NORMA_PEER_VERSIONS.winterAgentSdk, reason: "test", decidedAt: new Date().toISOString(),
      },
      parentAddress: addr("be_p"),
      capabilities: { message: true, resume: true, notifyWhenIdle: false, reply: true },
      updatedAt: new Date().toISOString(),
    });

    const outcome = await runtime.sdk.messaging.send({ from: buildSessionAddress("be_p"), to: "worker", body: "status?", originToolCallId: "toolu_06" });
    expect(outcome.status).toBe("delivered");
    expect(parentSession.facetCalls).toContain("steerChild:c_1");
    // The child's message never became the PARENT's user turn.
    expect(parentSession.pushed).toHaveLength(0);
  });
});

describe("releaseHeld (zero-arg)", () => {
  test("a held message is re-decided and delivered for EVERY receiver, with no address supplied", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const { runtime, sdk } = harness(store);
    const a = fakeSession("be_h_a");
    const b = fakeSession("be_h_b");

    const attachedA = attachWinterSession(runtime, { sessionId: "s_a", backendSessionId: a.backendSessionId, query: a.query, push: (t) => a.pushed.push(t), displayName: "holder" });
    const attachedB = attachWinterSession(runtime, { sessionId: "s_b", backendSessionId: b.backendSessionId, query: b.query, push: (t) => b.pushed.push(t), displayName: "sender" });
    await attachedA.ready;
    await attachedB.ready;

    // Seed the durable mailbox directly rather than fighting the inbound matrix into a hold: the
    // subject here is the SWEEP, not the policy that decided to hold.
    const message: GlobalAgentMessage = {
      messageId: "msg:held-1",
      from: buildSessionAddress(b.backendSessionId),
      fromGeneration: 1,
      to: buildSessionAddress(a.backendSessionId),
      toGeneration: 1,
      body: "held while the window was narrow",
      notifyWhenIdle: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      hopCount: 0,
      senderPermissionClass: "prompts",
    };
    // `kind: "default"` is load-bearing: the router's mailbox re-evaluates DEFAULT holds only — an
    // `explicit` hold is the receiver's own `crossSessionInbound: "hold"` setting and is never
    // auto-released, at any retention. A settings sweep releases the class-driven holds, not the
    // ones a user asked for.
    await store.mailboxes.hold({
      messageId: message.messageId, receiver: addr(a.backendSessionId), reason: "receiver class unknown at the time",
      kind: "default", heldAt: Date.now(), expiresAt: Date.now() + 300_000, message,
    });

    expect(a.pushed).toHaveLength(0);
    const outcomes = await releaseAllHeld(sdk, store);

    expect(outcomes.map((o) => o.status)).toContain("delivered");
    expect(a.pushed).toHaveLength(1);
    expect(a.pushed[0]).toContain("held while the window was narrow");
    // And the mailbox is empty afterwards, so a second settings change does not re-deliver it.
    expect(await store.mailboxes.listHeld(addr(a.backendSessionId))).toHaveLength(0);
    const again = await releaseAllHeld(sdk, store);
    expect(again).toHaveLength(0);
    expect(a.pushed).toHaveLength(1);
  });

  test("with NO injected store the sweep still covers this process's live sessions, and never throws", async () => {
    const { runtime, sdk } = harness();
    const a = fakeSession("be_nostore");
    const attached = attachWinterSession(runtime, { sessionId: "s_a", backendSessionId: a.backendSessionId, query: a.query, push: (t) => a.pushed.push(t), displayName: "solo" });
    await attached.ready;
    await expect(releaseAllHeld(sdk, undefined)).resolves.toEqual([]);
  });

  test("a store whose mailbox listing throws is logged, and the live sessions are still swept", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const { runtime, sdk } = harness(store);
    const a = fakeSession("be_throwy");
    const attached = attachWinterSession(runtime, { sessionId: "s_a", backendSessionId: a.backendSessionId, query: a.query, push: (t) => a.pushed.push(t), displayName: "solo" });
    await attached.ready;
    const lines: string[] = [];
    const broken = { mailboxes: { receivers: async () => { throw new Error("db is gone"); } } } as unknown as RuntimeDirectoryStore;
    await expect(releaseAllHeld(sdk, broken, (l) => lines.push(l))).resolves.toEqual([]);
    expect(lines.join("\n")).toContain("could not list held receivers");
  });
});

describe("renderAttributedTurn", () => {
  test("refuses an envelope whose sender claims to be another session's child", () => {
    const message: GlobalAgentMessage = {
      messageId: "msg:x",
      from: buildChildAddress("someone_else", "c_9"),
      fromGeneration: 1,
      to: buildSessionAddress("be_me"),
      toGeneration: 1,
      body: "trust me",
      notifyWhenIdle: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000,
      hopCount: 0,
      senderPermissionClass: "bypasses",
    };
    // The rendering itself is total; it is the wrapper that turns the refusal into an outcome. What
    // is pinned here is that the frame carries the sender's class verbatim — the one fact the
    // receiving model reads to decide how much to trust it.
    expect(renderAttributedTurn(message, { winterSessionId: "someone_else" })).toContain('sender-permission-class="bypasses"');
  });
});
