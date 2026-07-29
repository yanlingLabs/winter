import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket,
  type NewSessionEvent,
} from "@norma/protocol";
import { startIpcServer, type IpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { ApprovalBroker } from "../../src/agent/approvals";
import type { SessionApprovalPolicy } from "../../src/agent/gate";
import { AuditLog } from "../../src/peripheral/audit";
import { PeripheralBroker, type PeripheralClass } from "../../src/peripheral/broker";
import { ProviderLink } from "../../src/peripheral/provider-link";

// =================================================================================================
// Phase 2f Task 7 — the 2f-i scripted gate: an in-process daemon-level end-to-end covering the
// FULL peripheral-lease sequence (spec §A1-A4, plan Task 7) in two chained flows, rather than the
// single-behavior style of test/server.test.ts's own peripheral coverage (which this file does NOT
// duplicate — see each test's docstring for what's genuinely new here). Chain A scripts the whole
// grant/ask/plan/contention/disconnect/panic sequence over ONE real IPC server + REAL
// PeripheralBroker/AuditLog/ProviderLink/SessionHub — exactly what daemon.ts wires, assembled here
// by hand (mirroring server.test.ts's own low-level "noop capability call round-trips" test) so
// this file gets direct in-process access to `broker.call()` for the capability round-trip, since
// v1 deliberately exposes no wire method for it (spec: only the six peripheral.* verbs are on the
// socket — see plan Task 3). Chain B is a second, short-expiry daemon (settings can't be swapped
// mid-process) for the renew/expire timing legs.
// =================================================================================================

/** Minimal raw test client speaking NDJSON JSON-RPC — same conventions as server.test.ts's
 *  TestClient (duplicated here rather than imported: that class is private to server.test.ts). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly notifications: any[] = [];
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            } else if (msg.method) {
              c.notifications.push(msg);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName: string): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }

  close(): void { try { this.socket.end(); } catch { /* already closed */ } }

  async waitForNotification(predicate: (n: any) => boolean, timeoutMs = 2000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.notifications.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for notification");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** sha256 hex digest, lowercase — matches `hashToken()` in ../../src/peripheral/broker.ts AND
 *  `sha256Hex()` in apple/Norma/Sources/App/PeripheralProvider.swift (both documented as
 *  byte-identical). Used to drive a scripted provider that validates a REAL core-minted token
 *  exactly the way the Swift provider's `shouldServe()` does — closing the Task-4 report's MINOR
 *  ("Swift hash tests lack a literal cross-impl vector"). */
function sha256Hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function sessionLogPath(home: string, sessionId: string, scope = "global"): string {
  return join(home, "sessions", scope, `${sessionId}.jsonl`);
}

/** Mirrors `buildLeasePolicy` in ../../src/daemon.ts byte-for-byte (that function is private to
 *  daemon.ts, so it can't be imported) — the exact ask/auto/plan wait-before-emit policy the real
 *  daemon wires PeripheralBroker.lease() to. See daemon.ts's docstring for why the wait is
 *  registered BEFORE the approval_requested emit. */
function buildLeasePolicy(deps: {
  store: SessionStore;
  approvals: ApprovalBroker;
  hub: SessionHub;
}): (sessionId: string, cls: PeripheralClass) => Promise<"granted" | "denied"> {
  return async (sessionId: string, cls: PeripheralClass): Promise<"granted" | "denied"> => {
    let meta: { approvalPolicy: SessionApprovalPolicy; mode?: string };
    try {
      meta = deps.store.meta(sessionId);
    } catch {
      return "denied";
    }
    // Plan-immunity fix round 1, Minor 1: mirrors daemon.ts's own "chat" fix — keyed on `meta.mode`,
    // not the raw `approvalPolicy` column (a pre-fix chat row keeps stored "auto" forever). See
    // daemon.ts's buildLeasePolicy for the full rationale this mirrors byte-for-byte.
    if (meta.mode === "chat") return "denied";
    if (meta.approvalPolicy === "plan") return "denied";
    if (meta.approvalPolicy === "auto") return "granted";

    const callId = `lease_${randomBytes(6).toString("hex")}`;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 5 * 60_000;
    const waiting = deps.approvals.wait(sessionId, callId, 5 * 60_000);
    const event: NewSessionEvent = {
      type: "approval_requested", sessionId, threadId: "main", callId,
      toolName: "peripheral.lease", summary: `Session ${sessionId} requests ${cls}`, issuedAt, expiresAt,
    };
    deps.hub.append(sessionId, event);
    const res = await waiting;
    deps.hub.append(sessionId, {
      type: "approval_resolved", sessionId, threadId: "main", callId, approved: res.approved, by: res.by,
    });
    return res.approved ? "granted" : "denied";
  };
}

interface Harness {
  home: string;
  socketPath: string;
  harnessToken: string;
  store: SessionStore;
  auditPath: string;
  broker: PeripheralBroker;
  stop(): void;
}

/** Assembles the real production wiring (SessionStore + SessionHub + ApprovalBroker +
 *  AuditLog + PeripheralBroker + ProviderLink + startIpcServer) by hand, exactly as daemon.ts
 *  does — giving this file direct in-process access to `broker` (needed for the capability-call
 *  round-trip, spec v1 has no wire method for it) while every lease/renew/release/advertise/
 *  revoke/respond operation below still goes over the REAL unix socket via TestClient. */
async function buildHarness(opts: { expiryMs?: number; heartbeatMs?: number; callTimeoutMs?: number } = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "norma-e2e-peripheral-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const secrets = new FileSecretStore(join(home, "test-secrets"));
  const authority = new TokenAuthority(secrets);
  const tokens = await authority.ensureTokens();
  const auditPath = join(home, "audit.jsonl");
  const audit = new AuditLog(auditPath);
  const providerLink = new ProviderLink();
  const approvals = new ApprovalBroker();
  const broker = new PeripheralBroker({
    audit,
    heartbeatMs: opts.heartbeatMs,
    expiryMs: opts.expiryMs,
    callTimeoutMs: opts.callTimeoutMs,
    policy: buildLeasePolicy({ store, approvals, hub }),
    // Byte-identical to daemon.ts's emitTransient: lease_granted/lease_lost fan out to the
    // requester's session AND are pushed directly to the provider connection (which is rarely
    // attached to the requesting session).
    emitTransient: (sessionId, event) => {
      hub.broadcastTransient(sessionId, event);
      if (event.type === "lease_granted" || event.type === "lease_lost") providerLink.push(event);
    },
    pushToProvider: (event) => providerLink.push(event),
  });
  const socketPath = join(home, "core.sock");
  const server: IpcServer = startIpcServer({
    socketPath, serverVersion: "e2e-test", tokens: authority, store, hub,
    broker: approvals, peripheral: broker, providerLink,
  });
  return {
    home, socketPath, harnessToken: tokens.harness, store, auditPath, broker,
    stop() { server.stop(); store.close(); },
  };
}

describe("2f Task 7: peripheral lease end-to-end gate", () => {
  // -----------------------------------------------------------------------------------------
  // Chain A — one continuous scripted flow against a single daemon-equivalent harness (default
  // 15s/5s expiry/heartbeat, irrelevant here: nothing in this chain waits on real expiry).
  // -----------------------------------------------------------------------------------------
  describe("chain A: grant/ask/plan/contention/disconnect/panic + replay + audit", () => {
    let harness: Harness;
    let provider: TestClient;   // the ORIGINAL provider connection — closed mid-chain (disconnect leg)
    let provider2: TestClient;  // re-advertised provider after the disconnect leg
    let roundTripSessionId: string;

    beforeAll(async () => {
      harness = await buildHarness();
      provider = await TestClient.connect(harness.socketPath);
      await provider.hello(harness.harnessToken, "e2e-provider");
      await provider.request(METHODS.peripheralAdvertise, {
        classes: [
          { class: "noop", tccGranted: true },
          { class: "screenshot", tccGranted: true },
          { class: "ax-read", tccGranted: true },
          { class: "input-drive", tccGranted: true },
        ],
      });
    });

    afterAll(() => {
      provider2?.close();
      harness.stop();
    });

    test("auto policy grants noop immediately; the granted token is a REAL core-minted token whose sha256 matches lease_granted.tokenHash the way the Swift provider validates it, and a scripted Swift-style provider round-trips a noop call", async () => {
      const c = await TestClient.connect(harness.socketPath);
      await c.hello(harness.harnessToken, "auto-leaser");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
      roundTripSessionId = created.sessionId;
      await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

      const grant = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
      const { leaseId, token, expiresAt } = grant.result;
      expect(leaseId).toBeTruthy();
      expect(token).toBeTruthy();
      expect(expiresAt).toBeGreaterThan(Date.now());

      // The provider connection receives lease_granted even though it is not attached to the
      // requesting session (pushed via ProviderLink, mirrors daemon.ts) — it carries tokenHash,
      // never the raw token.
      const grantedOnProvider = await provider.waitForNotification((n) =>
        n.method === METHODS.event && n.params.type === "lease_granted" && n.params.leaseId === leaseId);
      expect(grantedOnProvider.params.holder).toEqual({ kind: "session", id: created.sessionId });
      expect(grantedOnProvider.params.token).toBeUndefined();

      // Cross-impl hash vector (closes the Task-4 report's MINOR): the SAME sha256-hex the Swift
      // provider's shouldServe() computes, checked here against a REAL core-minted token.
      expect(sha256Hex(token)).toBe(grantedOnProvider.params.tokenHash);

      // Capability call: v1 exposes no wire method for it (only the six peripheral.* verbs are on
      // the socket) — drive it directly against the SAME broker instance the real IPC server
      // shares (mirrors server.test.ts's own round-trip test), which is the only way a requester
      // ever reaches it even in production (there is no requester-facing peripheral.call verb yet).
      const callPromise = harness.broker.call({
        leaseId, token, class: "noop", payloadJson: JSON.stringify({ ping: 1 }),
      });
      const requested = await provider.waitForNotification((n) =>
        n.method === METHODS.event && n.params.type === "peripheral_call_requested");
      expect(requested.params.leaseId).toBe(leaseId);

      // Scripted provider validates EXACTLY like Swift's shouldServe(): sha256(call.token) must
      // equal the tokenHash captured off lease_granted — never re-derived any other way — plus
      // class + not-expired, before it will serve the call.
      const providerAccepts =
        sha256Hex(requested.params.token) === grantedOnProvider.params.tokenHash &&
        requested.params.class === "noop" &&
        Date.now() < expiresAt;
      expect(providerAccepts).toBe(true);
      await provider.request(METHODS.peripheralRespond, {
        requestId: requested.params.requestId,
        resultJson: JSON.stringify({ echo: JSON.parse(requested.params.payloadJson) }),
      });

      const callResult = await callPromise;
      if (!("ok" in callResult) || !callResult.ok) throw new Error(`expected ok, got ${JSON.stringify(callResult)}`);
      expect(JSON.parse(callResult.resultJson)).toEqual({ echo: { ping: 1 } });

      const release = await c.request(METHODS.peripheralRelease, { sessionId: created.sessionId, leaseId, token });
      expect(release.result).toEqual({ ok: true });
      await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_lost" && n.params.leaseId === leaseId);

      c.close();
    });

    test("ask policy raises an approval card naming the class on the requester's own session; approving grants", async () => {
      const c = await TestClient.connect(harness.socketPath);
      await c.hello(harness.harnessToken, "ask-leaser");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "ask" });
      await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

      const leasePromise = c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "screenshot" });
      const ask = await c.waitForNotification((n) =>
        n.method === METHODS.event && n.params.type === "approval_requested" && n.params.toolName === "peripheral.lease");
      expect(ask.params.summary).toBe(`Session ${created.sessionId} requests screenshot`);

      const respond = await c.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: true });
      expect(respond.result).toEqual({ ok: true, alreadyResolved: false });

      const res = await leasePromise;
      expect(res.result.leaseId).toBeTruthy();
      await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_granted");

      const release = await c.request(METHODS.peripheralRelease, {
        sessionId: created.sessionId, leaseId: res.result.leaseId, token: res.result.token,
      });
      expect(release.result).toEqual({ ok: true });
      c.close();
    });

    test("plan policy denies immediately — no approval card is ever raised", async () => {
      const c = await TestClient.connect(harness.socketPath);
      await c.hello(harness.harnessToken, "plan-leaser");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "plan" });
      await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

      const res = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "ax-read" });
      expect(res.result).toEqual({ code: "denied" });
      await sleep(100);
      expect(c.notifications.some((n) => n.params?.type === "approval_requested")).toBe(false);
      c.close();
    });

    // Plan-immunity fix round 1, Minor 1 (reviewer finding): buildLeasePolicy (daemon.ts) was not
    // taught "chat" — a chat row's stored policy is now "chat" (session.create's own coercion),
    // neither the "plan" deny nor the "auto" grant branch above, so it fell through to the ask
    // branch and raised the ONE outcome plan-immunity forbids for a chat session: an approval card.
    // Unreachable today (computer/peripheral isn't chat-eligible), but it's exactly the "every
    // comparison site handles chat explicitly" class of fix this slice otherwise claims closed.
    test("chat policy (post-fix: the stored row genuinely reads 'chat') denies immediately — no approval card, chat never asks and has no computer tool anyway", async () => {
      const c = await TestClient.connect(harness.socketPath);
      await c.hello(harness.harnessToken, "chat-leaser");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
      expect(harness.store.meta(created.sessionId).approvalPolicy).toBe("chat"); // sanity: the coercion really landed
      await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

      const res = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "ax-read" });
      expect(res.result).toEqual({ code: "denied" });
      await sleep(100);
      expect(c.notifications.some((n) => n.params?.type === "approval_requested")).toBe(false);
      c.close();
    });

    // The reviewer's own wrinkle: a chat session created BEFORE this fix shipped keeps its stored
    // "auto" forever — session.setPolicy now rejects EVERY change to a chat target, so there is no
    // migration path that would ever rewrite that row to "chat". buildLeasePolicy must therefore key
    // on `mode`, not the raw `approvalPolicy` column, or exactly the rows this fix most needs to
    // catch would still fall through to a card. Simulated here via a direct store write (bypassing
    // session.setPolicy's own RPC-level rejection), matching this whole slice's established
    // "synthetic pre-fix row" precedent (packages/core/test/agent/plan-immunity.test.ts).
    test("a PRE-FIX chat session whose stored row still carries 'auto' is STILL denied — keyed on mode, not the raw approvalPolicy column", async () => {
      const c = await TestClient.connect(harness.socketPath);
      await c.hello(harness.harnessToken, "stale-chat-leaser");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
      harness.store.setApprovalPolicy(created.sessionId, "auto");
      expect(harness.store.meta(created.sessionId).approvalPolicy).toBe("auto"); // sanity: the stale row is real
      await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

      const res = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "ax-read" });
      expect(res.result).toEqual({ code: "denied" });
      await sleep(100);
      expect(c.notifications.some((n) => n.params?.type === "approval_requested")).toBe(false);
      c.close();
    });

    test("contention: the second requester sees lease_held carrying the first holder's identity", async () => {
      const a = await TestClient.connect(harness.socketPath);
      await a.hello(harness.harnessToken, "contender-a");
      const sa = (await a.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" })).result.sessionId;
      const grantA = await a.request(METHODS.peripheralLease, { sessionId: sa, class: "input-drive" });
      expect(grantA.result.leaseId).toBeTruthy();

      const b = await TestClient.connect(harness.socketPath);
      await b.hello(harness.harnessToken, "contender-b");
      const sb = (await b.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" })).result.sessionId;
      const grantB = await b.request(METHODS.peripheralLease, { sessionId: sb, class: "input-drive" });
      expect(grantB.result).toEqual({ code: "lease_held", holder: { kind: "session", id: sa } });

      const release = await a.request(METHODS.peripheralRelease, {
        sessionId: sa, leaseId: grantA.result.leaseId, token: grantA.result.token,
      });
      expect(release.result).toEqual({ ok: true });
      a.close(); b.close();
    });

    test("provider disconnect revokes its active lease with reason provider-gone; a later lease sees no_provider until re-advertised", async () => {
      const c = await TestClient.connect(harness.socketPath);
      await c.hello(harness.harnessToken, "disc-leaser");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
      await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
      const grant = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
      expect(grant.result.leaseId).toBeTruthy();

      provider.close(); // the ONLY advertised provider connection

      const lost = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_lost");
      expect(lost.params.reason).toBe("provider-gone");
      expect(lost.params.leaseId).toBe(grant.result.leaseId);

      const res2 = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "screenshot" });
      expect(res2.result).toEqual({ code: "no_provider" });
      c.close();
    });

    test("revoke-all (panic): the re-advertised provider sheds every active lease across sessions/classes, each with reason panic", async () => {
      provider2 = await TestClient.connect(harness.socketPath);
      await provider2.hello(harness.harnessToken, "e2e-provider-2");
      await provider2.request(METHODS.peripheralAdvertise, {
        classes: [
          { class: "noop", tccGranted: true },
          { class: "screenshot", tccGranted: true },
          { class: "input-drive", tccGranted: true },
        ],
      });

      const clients: TestClient[] = [];
      const grants: Array<{ sessionId: string; leaseId: string }> = [];
      for (const cls of ["noop", "screenshot", "input-drive"] as const) {
        const c = await TestClient.connect(harness.socketPath);
        await c.hello(harness.harnessToken, `panic-leaser-${cls}`);
        const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
        await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
        const grant = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: cls });
        expect(grant.result.leaseId).toBeTruthy();
        clients.push(c);
        grants.push({ sessionId: created.sessionId, leaseId: grant.result.leaseId });
      }

      const revoke = await provider2.request(METHODS.peripheralRevoke, { all: true, reason: "panic" });
      expect(revoke.result).toEqual({ ok: true, revoked: 3 });

      for (let i = 0; i < clients.length; i++) {
        const lost = await clients[i]!.waitForNotification((n) =>
          n.method === METHODS.event && n.params.type === "lease_lost" && n.params.leaseId === grants[i]!.leaseId);
        expect(lost.params.reason).toBe("panic");
        expect(lost.params.holder).toEqual({ kind: "session", id: grants[i]!.sessionId });
      }
      for (const c of clients) c.close();
    });

    test("REPLAY: the round-trip session's JSONL log persists zero lease_*/peripheral_* events despite a full grant/call/release sequence", async () => {
      const path = sessionLogPath(harness.home, roundTripSessionId);
      const rows = readJsonl(path);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.type === "session_created")).toBe(true);

      const leakedTypes = rows.filter((r) => typeof r.type === "string" && (r.type.startsWith("lease_") || r.type === "peripheral_call_requested"));
      expect(leakedTypes).toEqual([]);

      // Same assertion, exercised via the ACTUAL replay code path (a fresh attach), not just the
      // raw file: transient events are absent from store.read()'s replay just as they are from the
      // file, since broadcastTransient never calls store.append (see sessions/hub.ts).
      const replay = await TestClient.connect(harness.socketPath);
      await replay.hello(harness.harnessToken, "replay-watcher");
      const attach = await replay.request(METHODS.sessionAttach, { sessionId: roundTripSessionId, fromSeq: 0 });
      expect(attach.result.ok).toBe(true);
      await sleep(100); // give the replay's synchronous delivery loop a beat to fully drain
      const replayedLeaseEvents = replay.notifications.filter((n) =>
        n.method === METHODS.event && typeof n.params?.type === "string" &&
        (n.params.type.startsWith("lease_") || n.params.type === "peripheral_call_requested"));
      expect(replayedLeaseEvents).toEqual([]);
      replay.close();
    });

    test("audit.jsonl: the full action trail is recorded; lease-lifecycle entries share the uniform {ts, kind:'lease', action,...} shape", () => {
      const rows = readJsonl(harness.auditPath);
      expect(rows.length).toBeGreaterThan(15); // rich trail across the whole chain above

      const actions = new Set(rows.map((r) => r.action));
      for (const expected of ["advertise", "lease_grant", "lease_denied", "lease_lost", "call_requested", "call_result", "revoke", "provider_gone"]) {
        expect(actions.has(expected)).toBe(true);
      }

      // Lease-LIFECYCLE actions (as opposed to capability-call bookkeeping like call_requested/
      // call_result, which the broker deliberately audits WITHOUT kind:"lease" — see broker.ts's
      // `audit()` vs `auditLease()` split) uniformly carry {ts:number, kind:"lease", action, ...}
      // — mirrors packages/core/test/peripheral/broker.test.ts's own "audit-trail-complete" test.
      const leaseLifecycleActions = new Set(["lease_grant", "lease_denied", "renew", "renew_failed", "release_failed", "lease_lost", "revoke"]);
      const lifecycleRows = rows.filter((r) => leaseLifecycleActions.has(r.action as string));
      expect(lifecycleRows.length).toBeGreaterThan(0);
      for (const row of lifecycleRows) {
        expect(row.kind).toBe("lease");
        expect(typeof row.ts).toBe("number");
        expect(typeof row.action).toBe("string");
      }
      // Every row overall — lease-kind or not — is ts-stamped (AuditLog's own invariant).
      for (const row of rows) expect(typeof row.ts).toBe("number");
    });
  });

  // -----------------------------------------------------------------------------------------
  // Chain B — a SEPARATE harness with a short expiry/heartbeat override (settings are fixed at
  // broker-construction time; a live daemon can't be reconfigured mid-flow the way Chain A's
  // needed to stay fast). Mirrors server.test.ts's own `{ peripheral: { expiryMs, heartbeatMs } }`
  // settings-override convention, just passed directly to the broker instead of via settings.json.
  // -----------------------------------------------------------------------------------------
  describe("chain B: renew keeps a lease alive; no renewal lets it expire (short override)", () => {
    let harness: Harness;
    let provider: TestClient;

    beforeAll(async () => {
      harness = await buildHarness({ expiryMs: 150, heartbeatMs: 20 });
      provider = await TestClient.connect(harness.socketPath);
      await provider.hello(harness.harnessToken, "e2e-expiry-provider");
      await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });
    });

    afterAll(() => { provider.close(); harness.stop(); });

    test("renew on a heartbeat cadence keeps the lease alive past its ORIGINAL expiry, surviving a real expiry-sweep tick", async () => {
      const c = await TestClient.connect(harness.socketPath);
      await c.hello(harness.harnessToken, "renew-heartbeat-leaser");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
      await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

      const grant = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
      const { leaseId, token, expiresAt: originalExpiresAt } = grant.result;
      expect(leaseId).toBeTruthy();

      // The broker's expiry sweep runs on a FIXED 1000ms cadence anchored at grant time
      // (see PeripheralBroker.armSweep) — well past this lease's 150ms expiryMs override. A real
      // client renews on its heartbeat (20ms override here) to keep expiresAt ahead of that sweep;
      // looping past 1000ms proves survival across an ACTUAL sweep tick, not just a wall-clock gap.
      const heartbeatDeadline = Date.now() + 1300;
      while (Date.now() < heartbeatDeadline) {
        await sleep(20);
        const renew = await c.request(METHODS.peripheralRenew, { sessionId: created.sessionId, leaseId, token });
        expect(renew.result).toMatchObject({ ok: true });
      }

      expect(Date.now()).toBeGreaterThan(originalExpiresAt); // the ORIGINAL 150ms expiry is long past
      expect(c.notifications.some((n) => n.params?.type === "lease_lost" && n.params.leaseId === leaseId)).toBe(false);

      const release = await c.request(METHODS.peripheralRelease, { sessionId: created.sessionId, leaseId, token });
      expect(release.result).toEqual({ ok: true });
      c.close();
    });

    test("no renewal: the lease is lost with reason expired within the override window", async () => {
      const c = await TestClient.connect(harness.socketPath);
      await c.hello(harness.harnessToken, "no-renew-leaser");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
      await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

      const grantedAt = Date.now();
      const grant = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
      const { leaseId } = grant.result;
      expect(leaseId).toBeTruthy();

      const lost = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_lost", 3000);
      expect(lost.params.leaseId).toBe(leaseId);
      expect(lost.params.reason).toBe("expired");
      // "within the override window": the 150ms expiry plus at most one 1000ms sweep tick — well
      // under this generous outer bound (guards against the sweep silently never firing).
      expect(Date.now() - grantedAt).toBeLessThan(2500);

      c.close();
    });
  });
});
