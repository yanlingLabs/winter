// P8b Task 12 — 8a's recovery step 10, with the router's `directory.recover()` actually in it.
//
// THE ONE FACT UNDER TEST: a delivery the previous daemon CLAIMED and never receipted is the
// messaging spec's whole evidence for `delivery_uncertain` (WS-15 §6.4 step 5) — "from this side
// 'the call failed' and 'the effect happened and then the call failed' are indistinguishable". So
// recovery must reconcile it as uncertain, and the next attach must NOT re-deliver it: a retry that
// started a second turn in a session that may already have read the message is the exact harm the
// claim/receipt pair exists to prevent.
//
// A REAL 8a STORE IN A TEMP HOME, never `createInMemoryRuntimeDirectoryStore()`: the claim and the
// receipt are SQLite rows, and the reconciliation is a write into the same file recovery walks.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { GlobalAgentMessage } from "@yanlinglabs/winter-agent-sdk/messaging";
import * as winter from "@yanlinglabs/winter-agent-sdk";
import { createRuntimeSdk } from "@yanlinglabs/winter-runtime-sdk";
import type { RuntimeDirectoryEntry, SerializedRuntimeAddress } from "@yanlinglabs/winter-runtime-sdk";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { createSqliteRuntimeDirectoryStore } from "../../src/runtime-state/directory-store";
import { processStartedAt } from "../../src/runtime-state/leases";
import { recoverRuntimeState } from "../../src/runtime-state/recovery";
import { SessionStore } from "../../src/sessions/store";
import { NORMA_BRAND } from "../../src/runtime-sdk/brand";
import { attachWinterSession } from "../../src/runtime-sdk/messaging";
import type { NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import { NORMA_PEER_VERSIONS } from "../../src/runtime-sdk/versions";
import { ISO, withTempHome } from "./support";

const ADDR = (id: string): SerializedRuntimeAddress => serializeRuntimeAddress(buildSessionAddress(id)) as SerializedRuntimeAddress;

const entry = (id: string, displayName: string): RuntimeDirectoryEntry => ({
  address: ADDR(id),
  parsed: buildSessionAddress(id),
  runtimeKind: "winter-agent",
  objectKind: "session",
  transport: "winter-session",
  displayName,
  status: "running",
  mode: "code",
  generation: 1,
  selection: {
    runtimeKind: "winter-agent", providerId: "openai", modelRef: "openai/gpt-5.6-sol", family: "openai",
    authFamily: "api-key", sdkVersion: NORMA_PEER_VERSIONS.winterAgentSdk, reason: "test", decidedAt: ISO(),
  },
  backendSessionId: id,
  capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
  updatedAt: ISO(),
});

/** WS-10 §12's message id, spelled out: "derived/persisted from the sender session plus tool-call
 *  ID, so that a retry with the same ID returns the stored outcome". Both halves percent-encoded.
 *  The router's own `deriveMessageId` is not on its published barrel, so the format is pinned here —
 *  a change to it breaks this test, which is the point: it is what makes a retry idempotent. */
const derivedId = (senderSessionId: string, toolUseId: string): string =>
  `msg:${encodeURIComponent(senderSessionId)}:${encodeURIComponent(toolUseId)}`;

const envelope = (messageId: string, from: string, to: string): GlobalAgentMessage => ({
  messageId,
  from: buildSessionAddress(from),
  fromGeneration: 1,
  to: buildSessionAddress(to),
  toGeneration: 1,
  body: "did this arrive, or not?",
  notifyWhenIdle: false,
  createdAt: Date.now(),
  expiresAt: Date.now() + 600_000,
  hopCount: 0,
  originToolCallId: "toolu_crash",
  senderPermissionClass: "prompts",
});

/** A facet that would answer over the control pipe on a real child. Nothing in this file may reach
 *  it — a re-delivery would show up here as well as in `pushed`. */
const inertFacet = () => {
  const calls: string[] = [];
  return {
    calls,
    query: {
      messaging: {
        listReachable: async () => [],
        deliver: async (msg: GlobalAgentMessage) => {
          calls.push(`deliver:${msg.messageId}`);
          return { status: "unavailable" as const, messageId: msg.messageId, retryable: false, reason: "inert" };
        },
        steerChild: async (_id: string, msg: GlobalAgentMessage) => ({ status: "delivered" as const, messageId: msg.messageId }),
        resumeChild: async (_id: string, msg: GlobalAgentMessage) => ({ status: "delivered" as const, messageId: msg.messageId }),
        subscribeIdle: async (_id: string, opts: { messageId: string }) => ({ status: "subscribed" as const, messageId: opts.messageId }),
        senderClass: async () => "prompts" as const,
        readNotifications: async () => ({ notifications: [], remaining: 0 }),
        onIdleNotice: () => () => {},
      },
    },
  };
};

describe("recovery step 10 — directory.recover() over the 8a store", () => {
  test("a claimed-but-unreceipted delivery reconciles as `delivery_uncertain` and is NEVER re-delivered", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      const store = new SessionStore(home);
      try {
        const directoryStore = createSqliteRuntimeDirectoryStore(rs);
        const sdk = createRuntimeSdk({
          peers: { winter },
          peerVersions: NORMA_PEER_VERSIONS,
          keychain: { read: async () => undefined },
          brand: NORMA_BRAND,
          directoryStore,
          handoff: { winterHome: home },
        });
        const runtime = { sdk } as unknown as NormaRuntimeSdk;

        // ── What the PREVIOUS daemon left behind ────────────────────────────────────────────────
        // Both sessions' rows, and one delivery that was claimed and never receipted: the process
        // died between "the adapter is about to be called" and "here is what it answered".
        await directoryStore.upsert(entry("be_sender", "sender"));
        await directoryStore.upsert(entry("be_target", "target"));
        const message = envelope(derivedId("be_sender", "toolu_crash"), "be_sender", "be_target");
        await directoryStore.deliveries.put({ messageId: message.messageId, message, toGeneration: 1, claimedBy: "winter-agent", updatedAt: ISO() });

        expect((await directoryStore.deliveries.claimedWithoutReceipt()).map((r) => r.messageId)).toEqual([derivedId("be_sender", "toolu_crash")]);

        // ── Boot: §13's twelve steps, with step 10 wired ────────────────────────────────────────
        const report = await recoverRuntimeState({
          home,
          rs,
          store,
          self: { pid: process.pid, startedAt: processStartedAt(process.pid) },
          tempScanRoot: join(home, "tmp-scan"),
          // Major 1: this file calls `recoverRuntimeState` directly (not through
          // `startRuntimeState`), so `support.ts`'s env seam is never consulted here — name the
          // root explicitly or this sweeps the developer's real tmpdir.
          claudeResumeScanRoot: join(home, "claude-resume-scan"),
          hooks: { recoverDirectory: () => sdk.directory.recover() },
        });

        const step10 = report.steps.find((s) => s.step === 10);
        expect(step10?.outcome).toBe("ok");
        // The step REPORTS counts and never contents — the rows it looks at hold whole envelopes.
        expect(step10?.detail).toMatchObject({ claimedWithoutReceipt: 1 });
        expect(JSON.stringify(step10?.detail)).not.toContain("did this arrive");

        // ── The reconciliation itself ───────────────────────────────────────────────────────────
        const reconciled = await directoryStore.deliveries.get(derivedId("be_sender", "toolu_crash"));
        expect(reconciled?.outcome?.status).toBe("delivery_uncertain");
        expect(reconciled?.outcome).toMatchObject({ deliveryMayHaveOccurred: true });
        // And it is no longer evidence of a crash window: the pair is complete.
        expect(await directoryStore.deliveries.claimedWithoutReceipt()).toHaveLength(0);

        // ── The next attach does NOT re-deliver it ──────────────────────────────────────────────
        const sender = inertFacet();
        const target = inertFacet();
        const pushed: string[] = [];
        const attachedSender = attachWinterSession(runtime, { sessionId: "s_sender", backendSessionId: "be_sender", query: sender.query, push: () => {}, displayName: "sender" });
        const attachedTarget = attachWinterSession(runtime, { sessionId: "s_target", backendSessionId: "be_target", query: target.query, push: (t) => pushed.push(t), displayName: "target" });
        await attachedSender.ready;
        await attachedTarget.ready;

        expect(pushed).toHaveLength(0);
        expect(target.calls).toHaveLength(0);

        // A retry under the SAME (sender, tool-call) pair — which is how the sender's own tool call
        // comes back after a restart — returns the STORED uncertain receipt rather than starting a
        // second turn. `delivery_uncertain` is terminal for this message id.
        const retry = await sdk.messaging.send({ from: buildSessionAddress("be_sender"), to: "target", body: "did this arrive, or not?", originToolCallId: "toolu_crash" });
        expect(retry.status).toBe("delivery_uncertain");
        expect(pushed).toHaveLength(0);
        expect(target.calls).toHaveLength(0);

        attachedSender.detach();
        attachedTarget.detach();
        await attachedTarget.ready;
        await sdk.dispose();
      } finally {
        store.close();
        rs.close();
      }
    });
  });

  test("with NO hook, step 10 is skipped and says why — the 8a default, unchanged", async () => {
    await withTempHome(async (home) => {
      const rs = openRuntimeStateDb(home);
      const store = new SessionStore(home);
      try {
        const report = await recoverRuntimeState({
          home, rs, store,
          self: { pid: process.pid, startedAt: processStartedAt(process.pid) },
          tempScanRoot: join(home, "tmp-scan"),
          claudeResumeScanRoot: join(home, "claude-resume-scan"),
        });
        const step10 = report.steps.find((s) => s.step === 10);
        expect(step10?.outcome).toBe("skipped");
        // Not `reason: "8b"` any more: 8b landed, and the honest reason is an ORDERING one.
        expect(String((step10?.detail as { reason?: string })?.reason)).toContain("router");
      } finally {
        store.close();
        rs.close();
      }
    });
  });
});
