import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { PeripheralClassSchema, type Holder, type NewSessionEvent } from "@winter/protocol";
import type { AuditLog } from "./audit";

export type PeripheralClass = z.infer<typeof PeripheralClassSchema>;

const SWEEP_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------------------------
// Pure decision core (spec §A3: "Pure decision core (leaseDecision(state, request)) unit-tested;
// the broker is thin plumbing around it."). Neither function reads a clock or any broker state —
// expiredLeases takes `nowMs` as an explicit argument so callers (tests, the sweep) control time.
// ---------------------------------------------------------------------------------------------

export interface LeaseEntry {
  leaseId: string;
  class: PeripheralClass;
  holder: Holder;
  tokenHash: string;
  expiresAt: number;
}

/** The decision core's view of broker state: the lease table (at most one entry per class) plus
 *  whether a provider is currently connected. Deliberately narrower than the broker's full
 *  internal state (no connections, no pending-call map) — that's all leaseDecision/expiredLeases
 *  need, and it's what keeps them pure and table-testable. */
export interface LeaseTable {
  hasProvider: boolean;
  entries: Map<PeripheralClass, LeaseEntry>;
}

export type LeaseDecision = { kind: "grant" } | { kind: "held"; holder: Holder } | { kind: "no_provider" };

/** Single holder per class (spec §A1): contention is rejected immediately with the current
 *  holder's identity — no queuing. `no_provider` takes priority over `held`: with no provider
 *  connected there is nothing to grant against regardless of any (stale) table contents.
 *
 *  Deliberately holder-BLIND on contention: a class already held returns `held` with the
 *  existing entry's holder even when that holder is `req.holder` itself (re-requesting a class
 *  you already hold is still "held", not an idempotent re-grant) — re-acquiring the SAME lease
 *  goes through `renew()`, not `lease()` again. This keeps "at most one entry per class" a real
 *  invariant: `lease()` never produces a second leaseId/token for a class that already has one. */
export function leaseDecision(state: LeaseTable, req: { class: PeripheralClass; holder: Holder }): LeaseDecision {
  if (!state.hasProvider) return { kind: "no_provider" };
  const existing = state.entries.get(req.class);
  if (existing) return { kind: "held", holder: existing.holder };
  return { kind: "grant" };
}

/** Leases whose `expiresAt` has been reached AT OR BEFORE `nowMs` — the boundary is INCLUSIVE
 *  (`nowMs === expiresAt` counts as expired: a lease "expires at" that instant, so it must not
 *  still be honored then). Per-class independence falls out of iterating the table directly:
 *  each entry's fate depends only on its own `expiresAt`. */
export function expiredLeases(state: LeaseTable, nowMs: number): string[] {
  const ids: string[] = [];
  for (const entry of state.entries.values()) {
    if (nowMs >= entry.expiresAt) ids.push(entry.leaseId);
  }
  return ids;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// PeripheralBroker — thin, injectable plumbing around the decision core.
// ---------------------------------------------------------------------------------------------

export type LeaseLostReason = "expired" | "released" | "panic" | "revoked" | "provider-gone";

export type LeaseError = { code: "lease_held"; holder: Holder } | { code: "no_provider" } | { code: "denied" };
export type LeaseResult = { leaseId: string; token: string; expiresAt: number } | LeaseError;

export type RenewError = { code: "not_found" } | { code: "token_mismatch" } | { code: "expired" };
export type RenewResult = { ok: true; expiresAt: number } | RenewError;

export type ReleaseError = { code: "not_found" } | { code: "token_mismatch" };
export type ReleaseResult = { ok: true } | ReleaseError;

export type RevokeResult = { ok: true; revoked: number };

export type CallError =
  | { code: "not_found" }
  | { code: "token_mismatch" }
  | { code: "expired" }
  | { code: "timeout" }
  | { code: "lease_gone"; reason: LeaseLostReason }
  | { code: "provider_error"; message: string };
export type CallResult = { ok: true; resultJson: string } | CallError;

export type RespondResult = { ok: true; alreadyResolved: boolean };

interface PendingCall {
  leaseId: string;
  resolve: (r: CallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PeripheralBrokerDeps {
  audit: AuditLog;
  /** Client-facing renewal cadence (spec-default 5000ms). Informational only — the broker never
   *  renews on a requester's behalf; it just carries the configured value for callers that want
   *  to surface/enforce it (e.g. a future settings read). */
  heartbeatMs?: number;
  /** Missed-heartbeat expiry (spec-default 15000ms) — the actual lifetime granted/extended by
   *  lease()/renew(). */
  expiryMs?: number;
  /** Per-call round-trip timeout to the provider (spec-fixed at 10000ms; overridable here only
   *  so tests don't have to wait out a real 10s — mirrors ApprovalBroker/PlanBroker/BashReviewer's
   *  constructor-overridable timeouts elsewhere in this codebase). */
  callTimeoutMs?: number;
  /** Session approval-policy check for a lease request (Task 3 builds this on ApprovalBroker).
   *  The broker never touches policy internals — it only awaits "granted" | "denied". Takes the
   *  requested `class` directly (the broker already has it in `req.class`) so a caller building
   *  an approval-card summary reads it as a plain call argument, not through a side-channel that
   *  a future `await` could desynchronize from the request it was meant to describe. */
  policy: (sessionId: string, cls: PeripheralClass) => Promise<"granted" | "denied">;
  /** Broadcast a TRANSIENT event to a session's attached clients (Task 3 wires this to
   *  `hub.broadcastTransient`). Used for lease_granted/lease_lost — the broker never touches the
   *  hub directly. */
  emitTransient: (sessionId: string, event: NewSessionEvent) => void;
  /** Push an event directly to the provider's connection (bypasses session attachment — the
   *  provider is rarely attached to the requesting session). Returns false if there is no
   *  provider connection to deliver to. Used for peripheral_call_requested. */
  pushToProvider: (event: NewSessionEvent) => boolean;
}

/** Provider registry + lease table + expiry sweep + request/respond correlation, all built as
 *  thin plumbing around the pure `leaseDecision`/`expiredLeases` core. Every public method
 *  returns a typed result — NONE of them throw across the public surface (mirrors the tools
 *  registry / ApprovalBroker convention); the ipc layer (Task 3) maps typed results to RPC
 *  errors. */
export class PeripheralBroker {
  private hasProvider = false;
  private providerConn: unknown = null;
  private entries = new Map<PeripheralClass, LeaseEntry>();
  private pending = new Map<string, PendingCall>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly expiryMs: number;
  private readonly heartbeatMs: number;
  private readonly callTimeoutMs: number;

  constructor(private readonly deps: PeripheralBrokerDeps) {
    this.expiryMs = deps.expiryMs ?? 15_000;
    this.heartbeatMs = deps.heartbeatMs ?? 5_000;
    this.callTimeoutMs = deps.callTimeoutMs ?? 10_000;
  }

  /** Provider attach / TCC-state re-advertise. Last advertiser wins (Task 3 pins connection
   *  identity/authorization on top of `isProvider`); existing leases are untouched — only an
   *  actual disconnect (`providerGone`) revokes them.
   *
   *  L2 fix: `clientName` (the connecting harness's own self-reported identity, e.g.
   *  `socket.data.clientName` at the ipc layer) rides the audit line alongside `classes` — when a
   *  second advertiser silently displaces the first ("last advertiser wins"), the audit trail
   *  previously had no way to say WHO the new provider was, only that SOME advertise happened.
   *  Optional (defaults to `""`) so existing test/call sites that don't care about identity don't
   *  have to thread one through. */
  advertise(conn: unknown, classes: Array<{ class: PeripheralClass; tccGranted: boolean }>, clientName = ""): void {
    this.providerConn = conn;
    this.hasProvider = true;
    this.audit("advertise", { classes, clientName });
  }

  /** True if `conn` is the connection that most recently advertised — the hook Task 3 needs to
   *  gate revoke/respond (provider-only verbs) on connection identity. */
  isProvider(conn: unknown): boolean {
    return this.hasProvider && this.providerConn === conn;
  }

  /** Provider disconnected: revoke every active lease with reason "provider-gone" (spec §A3). */
  providerGone(): void {
    if (!this.hasProvider) return;
    this.hasProvider = false;
    this.providerConn = null;
    const revoked = this.dropAll("provider-gone");
    this.audit("provider_gone", { revoked });
  }

  /** Acquire a lease for `class`, following the session's approval policy (spec §A1: lease
   *  acquisition follows policy for ALL classes). Fails fast on immediate contention/no-provider
   *  (no point prompting a human for something already impossible) and RE-CHECKS after the
   *  (possibly slow, ask-mode) policy wait — the table can change while a card is pending, and
   *  the invariant "at most one entry per class" must hold even across that race. */
  async lease(req: { sessionId: string; class: PeripheralClass }): Promise<LeaseResult> {
    const holder: Holder = { kind: "session", id: req.sessionId };
    const decide = () => leaseDecision(this.table(), { class: req.class, holder });

    const pre = decide();
    if (pre.kind === "held") return this.denyHeld(req, pre.holder);
    if (pre.kind === "no_provider") return this.denyNoProvider(req);

    const outcome = await this.deps.policy(req.sessionId, req.class);
    if (outcome === "denied") return this.denyPolicy(req);

    const post = decide();
    if (post.kind === "held") return this.denyHeld(req, post.holder);
    if (post.kind === "no_provider") return this.denyNoProvider(req);

    const leaseId = `lease_${randomBytes(6).toString("hex")}`;
    const token = `tok_${randomBytes(24).toString("hex")}`;
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + this.expiryMs;
    this.entries.set(req.class, { leaseId, class: req.class, holder, tokenHash, expiresAt });
    this.armSweep();

    this.auditLease("lease_grant", { class: req.class, leaseId, holder });
    // tokenHash rides the event (spec §A1: "no token, no service") so the PROVIDER can validate
    // token+class+expiry on every call — the raw token itself is NEVER broadcast; it goes solely
    // to the requester in this method's return value and back from the requester on calls.
    this.deps.emitTransient(req.sessionId, {
      type: "lease_granted", sessionId: req.sessionId, threadId: "main",
      leaseId, class: req.class, holder, expiresAt, tokenHash,
    });
    return { leaseId, token, expiresAt };
  }

  private denyHeld(req: { sessionId: string; class: PeripheralClass }, holder: Holder): LeaseError {
    this.auditLease("lease_denied", { class: req.class, reason: "held", holder });
    return { code: "lease_held", holder };
  }

  private denyNoProvider(req: { sessionId: string; class: PeripheralClass }): LeaseError {
    this.auditLease("lease_denied", { class: req.class, reason: "no_provider" });
    return { code: "no_provider" };
  }

  private denyPolicy(req: { sessionId: string; class: PeripheralClass }): LeaseError {
    this.auditLease("lease_denied", { class: req.class, reason: "denied" });
    return { code: "denied" };
  }

  /** Extend an existing lease's expiry by `expiryMs` from now. Does not change the class's
   *  entry identity (leaseId/token unchanged) — only `expiresAt` moves forward.
   *
   *  L1 fix: a lease past its `expiresAt` but not yet swept (the sweep only runs on its own
   *  `SWEEP_INTERVAL_MS` cadence, up to ~1s late — see `armSweep`/`sweep`) must not be renewable
   *  back to life; without this check a renew landing in that pre-sweep window would silently
   *  resurrect an already-expired lease. Same inclusive boundary as `expiredLeases`
   *  (`nowMs >= expiresAt` counts as expired) and the same typed-error family as `not_found`/
   *  `token_mismatch` above — deliberately NOT dropping the entry here: the sweep (or the next
   *  call()/renew() to observe it) still owns firing the one `lease_lost` + audit line for it. */
  renew(req: { leaseId: string; token: string }): RenewResult {
    const found = this.findByLeaseId(req.leaseId);
    if (!found) {
      this.auditLease("renew_failed", { leaseId: req.leaseId, reason: "not_found" });
      return { code: "not_found" };
    }
    const [cls, entry] = found;
    if (entry.tokenHash !== hashToken(req.token)) {
      this.auditLease("renew_failed", { leaseId: req.leaseId, class: cls, reason: "token_mismatch" });
      return { code: "token_mismatch" };
    }
    if (Date.now() >= entry.expiresAt) {
      this.auditLease("renew_failed", { leaseId: req.leaseId, class: cls, reason: "expired" });
      return { code: "expired" };
    }
    entry.expiresAt = Date.now() + this.expiryMs;
    this.auditLease("renew", { leaseId: req.leaseId, class: cls });
    return { ok: true, expiresAt: entry.expiresAt };
  }

  /** Voluntary release by the holder — the token must match (a stolen/guessed leaseId cannot
   *  release someone else's lease). */
  release(req: { leaseId: string; token: string }): ReleaseResult {
    const found = this.findByLeaseId(req.leaseId);
    if (!found) {
      this.auditLease("release_failed", { leaseId: req.leaseId, reason: "not_found" });
      return { code: "not_found" };
    }
    const [cls, entry] = found;
    if (entry.tokenHash !== hashToken(req.token)) {
      this.auditLease("release_failed", { leaseId: req.leaseId, class: cls, reason: "token_mismatch" });
      return { code: "token_mismatch" };
    }
    this.dropLease(cls, "released");
    return { ok: true };
  }

  /** Admin/provider-triggered revoke: a single `leaseId` or every active lease (`all: true`,
   *  the panic path). Tolerant of unknown leaseIds (revokes 0) rather than erroring — revoke is
   *  a "make sure it's gone" verb, not an assertion that it existed. */
  revoke(req: { leaseId?: string; all?: boolean; reason: LeaseLostReason }): RevokeResult {
    const revoked = req.all ? this.dropAll(req.reason) : this.dropOne(req.leaseId, req.reason);
    this.auditLease("revoke", { leaseId: req.leaseId, reason: req.reason, all: !!req.all, revoked });
    return { ok: true, revoked };
  }

  private dropOne(leaseId: string | undefined, reason: LeaseLostReason): number {
    if (!leaseId) return 0;
    const found = this.findByLeaseId(leaseId);
    if (!found) return 0;
    this.dropLease(found[0], reason);
    return 1;
  }

  private dropAll(reason: LeaseLostReason): number {
    const classes = [...this.entries.keys()];
    for (const cls of classes) this.dropLease(cls, reason);
    return classes.length;
  }

  /** Requester → core → provider capability call (spec §A1 routing). Validates leaseId+token+
   *  class+expiry (indexing by `req.class` means a wrong class for a right leaseId naturally
   *  misses — no separate "class_mismatch" code is needed), then pushes
   *  `peripheral_call_requested` to the provider and awaits `respond()` (10s timeout). Never
   *  throws: every failure path is a typed `CallError`.
   *
   *  L3 fix: every `call_failed` audit line — here AND in `failPending` below — now goes through
   *  `auditLease` (`kind: "lease"`). Previously this method logged `call_failed` via the plain
   *  `audit()` helper (no `kind`) while `failPending`'s OWN `call_failed` line (a revoke/expiry
   *  racing an in-flight call) used `auditLease` — same action name, two different shapes on
   *  disk. Unified on `auditLease` since `call_failed` is fundamentally a lease-identifying event
   *  (it always carries `leaseId`), same family as `lease_denied`/`lease_lost`. */
  async call(req: { leaseId: string; token: string; class: PeripheralClass; payloadJson: string }): Promise<CallResult> {
    const entry = this.entries.get(req.class);
    if (!entry || entry.leaseId !== req.leaseId) {
      this.auditLease("call_failed", { leaseId: req.leaseId, class: req.class, reason: "not_found" });
      return { code: "not_found" };
    }
    if (entry.tokenHash !== hashToken(req.token)) {
      this.auditLease("call_failed", { leaseId: req.leaseId, class: req.class, reason: "token_mismatch" });
      return { code: "token_mismatch" };
    }
    if (Date.now() >= entry.expiresAt) {
      this.auditLease("call_failed", { leaseId: req.leaseId, class: req.class, reason: "expired" });
      return { code: "expired" };
    }

    const requestId = `req_${randomBytes(6).toString("hex")}`;
    const sessionId = entry.holder.kind === "session" ? entry.holder.id : "";
    const event: NewSessionEvent = {
      type: "peripheral_call_requested", sessionId, threadId: "main",
      requestId, leaseId: req.leaseId, token: req.token, class: req.class, payloadJson: req.payloadJson,
    };

    const result = new Promise<CallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.audit("call_timeout", { requestId, leaseId: req.leaseId, class: req.class });
        resolve({ code: "timeout" });
      }, this.callTimeoutMs);
      this.pending.set(requestId, { leaseId: req.leaseId, resolve, timer });
    });

    this.audit("call_requested", { requestId, leaseId: req.leaseId, class: req.class });
    const delivered = this.deps.pushToProvider(event);
    if (!delivered) {
      const p = this.pending.get(requestId);
      if (p) { clearTimeout(p.timer); this.pending.delete(requestId); }
      this.auditLease("call_failed", { requestId, leaseId: req.leaseId, class: req.class, reason: "no_provider" });
      return { code: "lease_gone", reason: "provider-gone" };
    }
    return result;
  }

  /** Provider's answer to a `peripheral_call_requested` — resolves the matching pending call
   *  (first response wins, mirrors ApprovalBroker/PlanBroker). `error` and `resultJson` are
   *  mutually exclusive; `error` set (regardless of `resultJson`) means the call failed. */
  respond(req: { requestId: string; resultJson?: string; error?: string }): RespondResult {
    const p = this.pending.get(req.requestId);
    if (!p) return { ok: true, alreadyResolved: true };
    this.pending.delete(req.requestId);
    clearTimeout(p.timer);
    if (req.error !== undefined) {
      this.audit("call_error", { requestId: req.requestId, leaseId: p.leaseId, error: req.error });
      p.resolve({ code: "provider_error", message: req.error });
    } else {
      this.audit("call_result", { requestId: req.requestId, leaseId: p.leaseId });
      p.resolve({ ok: true, resultJson: req.resultJson ?? "" });
    }
    return { ok: true, alreadyResolved: false };
  }

  /** Expiry sweep for `nowMs` — called every `SWEEP_INTERVAL_MS` by the (unref'd) interval timer
   *  while the table is non-empty, and callable directly by tests with a fabricated `nowMs` so
   *  expiry never depends on real wall-clock waits. */
  sweep(nowMs: number): void {
    for (const leaseId of expiredLeases(this.table(), nowMs)) {
      const found = this.findByLeaseId(leaseId);
      if (found) this.dropLease(found[0], "expired");
    }
  }

  private table(): LeaseTable {
    return { hasProvider: this.hasProvider, entries: this.entries };
  }

  private findByLeaseId(leaseId: string): [PeripheralClass, LeaseEntry] | undefined {
    for (const [cls, entry] of this.entries) {
      if (entry.leaseId === leaseId) return [cls, entry];
    }
    return undefined;
  }

  /** Removes the class's entry, fails any in-flight call() for it (so a revoke/expiry doesn't
   *  leave a caller hanging until the 10s call timeout), emits lease_lost to the holder's own
   *  session, audits, and disarms the sweep timer once the table is empty. The one place that
   *  mutates `entries` on the "losing a lease" path — release/revoke/providerGone/sweep all
   *  funnel through here so every loss gets exactly one lease_lost + audit line. */
  private dropLease(cls: PeripheralClass, reason: LeaseLostReason): void {
    const entry = this.entries.get(cls);
    if (!entry) return;
    this.entries.delete(cls);
    this.failPending(entry.leaseId, reason);
    if (entry.holder.kind === "session") {
      this.deps.emitTransient(entry.holder.id, {
        type: "lease_lost", sessionId: entry.holder.id, threadId: "main",
        leaseId: entry.leaseId, class: cls, holder: entry.holder, reason,
      });
    }
    this.auditLease("lease_lost", { leaseId: entry.leaseId, class: cls, holder: entry.holder, reason });
    if (this.entries.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private failPending(leaseId: string, reason: LeaseLostReason): void {
    for (const [requestId, p] of this.pending) {
      if (p.leaseId !== leaseId) continue;
      this.pending.delete(requestId);
      clearTimeout(p.timer);
      this.auditLease("call_failed", { leaseId, reason });
      p.resolve({ code: "lease_gone", reason });
    }
  }

  private armSweep(): void {
    if (this.sweepTimer) return;
    const timer = setInterval(() => this.sweep(Date.now()), SWEEP_INTERVAL_MS);
    timer.unref();
    this.sweepTimer = timer;
  }

  private auditLease(
    action: string,
    fields: {
      class?: PeripheralClass;
      leaseId?: string;
      holder?: Holder;
      reason?: string;
      [key: string]: unknown;
    }
  ): void {
    const entry: Record<string, unknown> = {
      kind: "lease",
      action,
      class: fields.class,
      leaseId: fields.leaseId,
      holder: fields.holder,
    };
    // Add any extra fields (like reason, revoked count, etc.)
    for (const [k, v] of Object.entries(fields)) {
      if (k !== "class" && k !== "leaseId" && k !== "holder" && v !== undefined) {
        entry[k] = v;
      }
    }
    this.deps.audit.append(entry);
  }

  private audit(action: string, fields: Record<string, unknown>): void {
    this.deps.audit.append({ action, ...fields });
  }
}
