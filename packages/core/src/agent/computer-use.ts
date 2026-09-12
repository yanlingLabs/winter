import type { PeripheralClass } from "../peripheral/broker";

// ---------------------------------------------------------------------------------------------
// ComputerUseService (Phase 5 CU) — lease lifecycle around PeripheralBroker for the `computer`
// tool. Requesters INSIDE core hit the broker in-process (2f §A1: "Requesters inside core (the
// engine, Phase 5g) hit the broker in-process"). A stateless tool run() cannot hold a lease across
// the CU loop, and re-leasing per action would raise an approval card on EVERY action under `ask`
// (2f: lease acquisition follows the session approval policy). So this service HOLDS one lease per
// (session, class): acquired lazily on first use, renewed by a per-session heartbeat, released on
// the session's turn completion (with an IDLE backstop — see maxIdleMs). Under `ask` that means ONE
// card per class per turn, not one per action.
//
// Every public method returns a typed result and NEVER throws across its surface (mirrors
// PeripheralBroker's convention). The broker + clock + scheduler are all injectable so the whole
// service is unit-tested with a fake broker — no Winter.app, no TCC, no real timers.
// ---------------------------------------------------------------------------------------------

/** The exact subset of PeripheralBroker this service depends on (kept narrow so tests inject a
 *  fake). Shapes mirror broker.ts's LeaseResult/RenewResult/ReleaseResult/CallResult unions. */
export interface PeripheralBrokerLike {
  lease(req: { sessionId: string; class: PeripheralClass }): Promise<
    | { leaseId: string; token: string; expiresAt: number }
    | { code: "lease_held"; holder: { kind: string; id: string } }
    | { code: "no_provider" }
    | { code: "denied" }
  >;
  renew(req: { leaseId: string; token: string }): { ok: true; expiresAt: number } | { code: string };
  release(req: { leaseId: string; token: string }): { ok: true } | { code: string };
  call(req: { leaseId: string; token: string; class: PeripheralClass; payloadJson: string }): Promise<
    | { ok: true; resultJson: string }
    | { code: "not_found" }
    | { code: "token_mismatch" }
    | { code: "expired" }
    | { code: "timeout" }
    | { code: "lease_gone"; reason: string }
    | { code: "provider_error"; message: string }
  >;
}

/** Injectable interval scheduler — the default uses real (unref'd) timers; tests capture the
 *  callback and drive it manually so heartbeat renewal is deterministic and clock-free. */
export interface CuScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const DEFAULT_SCHEDULER: CuScheduler = {
  setInterval(fn, ms) {
    const t = setInterval(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface ComputerUseServiceDeps {
  broker: PeripheralBrokerLike;
  /** Client-facing renewal cadence (spec-default 5000ms, settings.peripheral.heartbeatMs). */
  heartbeatMs?: number;
  /** Idle backstop (default 60s): when no CU action has run for this long, the heartbeat RELEASES
   *  the session's leases instead of renewing them. This re-arms the broker's 15s expiry backstop
   *  against a lease acquired by a DETACHED background thread (same sessionId, outlives the main
   *  turn whose settle calls releaseSession) — without it the unref'd heartbeat would renew such a
   *  lease forever, and the single-holder-per-class peripheral would stay locked to the session
   *  indefinitely. A later CU action simply re-leases (silent under auto, one card under ask). */
  maxIdleMs?: number;
  now?: () => number;
  scheduler?: CuScheduler;
}

/** The tool-facing outcome of a CU action. `ok:false` carries a model-ready message and a `kind`
 *  the tool can use for logging/branching. `unavailable` is the spec-pinned "no provider / lease
 *  gone" case → message "computer use unavailable — Winter.app not running". */
export type CuActResult =
  | { ok: true; resultJson: string }
  | { ok: false; kind: "unavailable" | "denied" | "provider_error" | "timeout"; message: string };

interface HeldLease {
  leaseId: string;
  token: string;
  expiresAt: number;
}

type LeaseOutcome = HeldLease | { code: "lease_held"; holder: { kind: string; id: string } } | { code: "no_provider" } | { code: "denied" };

interface SessionState {
  leases: Map<PeripheralClass, HeldLease>;
  /** In-flight lease acquisitions, keyed by class — concurrent first-acquisitions by two threads
   *  of the SAME session (main + a spawned child both calling `computer`) must share ONE broker
   *  lease() call: the broker is holder-blind on lease() (broker.ts leaseDecision — a class already
   *  held returns `held` even for the same holder), so a second racing lease() would spuriously
   *  fail with "already controlled by <own session>". */
  inflight: Map<PeripheralClass, Promise<LeaseOutcome>>;
  /** Last act() timestamp — drives the idle-release backstop in renewAll. */
  lastActAt: number;
  timer: unknown | null;
}

/** Treat a cached lease as needing renewal this many ms before its stated expiry — avoids racing a
 *  lease that is about to expire (the heartbeat normally keeps it well clear of this window). */
const EXPIRY_SKEW_MS = 1_000;

export const CU_UNAVAILABLE_MESSAGE = "computer use unavailable — Winter.app not running";

export class ComputerUseService {
  private readonly broker: PeripheralBrokerLike;
  private readonly heartbeatMs: number;
  private readonly maxIdleMs: number;
  private readonly now: () => number;
  private readonly scheduler: CuScheduler;
  private readonly sessions = new Map<string, SessionState>();
  // hot-settings T5a: count of act() calls currently executing, for inFlight()'s drain gate —
  // incremented at the top of act(), decremented in a finally around its whole body so it's
  // accurate across every return path (success, typed error, or a thrown broker call).
  private activeActs = 0;

  constructor(deps: ComputerUseServiceDeps) {
    this.broker = deps.broker;
    this.heartbeatMs = deps.heartbeatMs ?? 5_000;
    this.maxIdleMs = deps.maxIdleMs ?? 60_000;
    this.now = deps.now ?? (() => Date.now());
    this.scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** Run one CU capability call for `sessionId`, ensuring a live lease for `cls` first. The single
   *  entry point the `computer` tool calls. Never throws. */
  async act(sessionId: string, cls: PeripheralClass, payloadJson: string): Promise<CuActResult> {
    this.activeActs++;
    try {
      const preState = this.sessions.get(sessionId);
      if (preState) preState.lastActAt = this.now();
      const ensured = await this.ensureLease(sessionId, cls);
      if (!("leaseId" in ensured)) return this.mapLeaseError(ensured);

      const res = await this.broker.call({ leaseId: ensured.leaseId, token: ensured.token, class: cls, payloadJson });
      if ("ok" in res) return { ok: true, resultJson: res.resultJson }; // only the success member has `ok`

      // A LEASE-INVALIDATING failure drops the cached lease so the next action re-acquires (and,
      // under ask, re-cards) — the token/lease is genuinely gone. A provider_error/timeout leaves
      // the lease intact: the lease is fine, the capability call itself failed (e.g. TCC not granted,
      // a slow capture), and re-carding on the next action would be pure noise.
      if (res.code === "not_found" || res.code === "token_mismatch" || res.code === "expired" || res.code === "lease_gone") {
        this.dropLease(sessionId, cls);
        return { ok: false, kind: "unavailable", message: CU_UNAVAILABLE_MESSAGE };
      }
      if (res.code === "timeout") return { ok: false, kind: "timeout", message: "the computer-use action timed out" };
      return { ok: false, kind: "provider_error", message: res.message };
    } finally {
      this.activeActs--;
    }
  }

  /** Release every lease held for `sessionId` and stop its heartbeat — called by the engine on the
   *  main thread's turn completion and by the heartbeat's idle backstop. Best-effort + synchronous
   *  (broker.release is sync); broker expiry is the final backstop if this is ever missed. A no-op
   *  for a session that holds nothing. */
  releaseSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const held of state.leases.values()) {
      this.broker.release({ leaseId: held.leaseId, token: held.token });
    }
    this.stopTimer(state);
    this.sessions.delete(sessionId);
  }

  /** Quiesce point for hot-disable (hot-settings T5b calls this once the inFlight() drain gate
   *  closes): releases EVERY session's held leases and stops their heartbeats, leaving the
   *  service holding nothing but still usable (a later re-enable calls act() as normal, which
   *  lazily re-acquires). Reuses releaseSession per session id — idempotent, and a no-op when
   *  there are no sessions. Snapshots the id list first since releaseSession mutates `sessions`
   *  (same copy-before-iterate pattern as renewAll's lease loop below). */
  releaseAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.releaseSession(sessionId);
    }
  }

  /** True while ≥1 act() call is currently executing — the drain gate hot-disable waits on before
   *  calling releaseAll()/tearing the service down, so an in-flight capability call is never
   *  yanked out from under itself. */
  inFlight(): boolean {
    return this.activeActs > 0;
  }

  /** True if `sessionId` currently holds any lease (test/introspection helper). */
  holdsAny(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.leases.size ?? 0) > 0;
  }

  private getOrCreate(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { leases: new Map(), inflight: new Map(), lastActAt: this.now(), timer: null };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private async ensureLease(sessionId: string, cls: PeripheralClass): Promise<LeaseOutcome> {
    const state = this.sessions.get(sessionId);
    const cached = state?.leases.get(cls);
    if (cached) {
      if (this.now() < cached.expiresAt - EXPIRY_SKEW_MS) return cached;
      // Near/past expiry: RENEW the still-held lease rather than lease() again — the broker's
      // lease() is holder-blind (a class already held returns `held` even for this same session),
      // so calling it while our own lease is still in the table would spuriously self-deny AND
      // leave the stale cache poisoning every later action. renew() is the sanctioned re-acquire
      // path (broker.ts: "re-acquiring the SAME lease goes through renew()"). On any renew failure
      // the cache entry is dropped and we fall through to a genuinely fresh lease().
      const r = this.broker.renew({ leaseId: cached.leaseId, token: cached.token });
      if ("ok" in r) {
        cached.expiresAt = r.expiresAt;
        return cached;
      }
      this.dropLease(sessionId, cls);
    }

    // Fresh acquisition — memoized per (session, class) so concurrent callers (main thread + a
    // child thread of the same session) share ONE broker.lease() call instead of the loser
    // self-denying on `lease_held` by its own session. The inflight entry is removed when the
    // shared promise settles, whatever the outcome.
    const s = this.getOrCreate(sessionId);
    const existing = s.inflight.get(cls);
    if (existing) return existing;
    const acquisition = (async (): Promise<LeaseOutcome> => {
      const r = await this.broker.lease({ sessionId, class: cls });
      if (!("leaseId" in r)) return r; // typed lease error passes through
      const held: HeldLease = { leaseId: r.leaseId, token: r.token, expiresAt: r.expiresAt };
      // Re-fetch the state: a releaseSession racing this await deleted the map entry, and caching
      // into the DELETED object would strand a live lease nothing tracks. getOrCreate re-registers
      // it; the idle backstop then bounds the worst-case hold even in that race.
      const live = this.getOrCreate(sessionId);
      live.leases.set(cls, held);
      this.armHeartbeat(sessionId, live);
      return held;
    })();
    s.inflight.set(cls, acquisition);
    try {
      return await acquisition;
    } finally {
      // Delete via the CURRENT state object — releaseSession may have replaced it mid-await.
      this.sessions.get(sessionId)?.inflight.delete(cls);
      s.inflight.delete(cls);
    }
  }

  private mapLeaseError(
    err: { code: "lease_held"; holder: { kind: string; id: string } } | { code: "no_provider" } | { code: "denied" },
  ): CuActResult {
    if (err.code === "no_provider") return { ok: false, kind: "unavailable", message: CU_UNAVAILABLE_MESSAGE };
    if (err.code === "denied") return { ok: false, kind: "denied", message: "computer use was not permitted for this session" };
    return { ok: false, kind: "denied", message: `that peripheral is already controlled by ${err.holder.kind} ${err.holder.id}` };
  }

  private armHeartbeat(sessionId: string, state: SessionState): void {
    if (state.timer !== null) return; // one heartbeat per session
    state.timer = this.scheduler.setInterval(() => this.renewAll(sessionId), this.heartbeatMs);
  }

  /** Heartbeat tick: renew every held lease; drop any the broker won't renew (typed renew error).
   *  IDLE BACKSTOP: when no act() has run for maxIdleMs, RELEASE everything instead — see
   *  ComputerUseServiceDeps.maxIdleMs. Stops the timer once the session holds nothing.
   *  Synchronous (broker.renew/release are sync). */
  private renewAll(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (this.now() - state.lastActAt >= this.maxIdleMs) {
      this.releaseSession(sessionId);
      return;
    }
    for (const [cls, held] of [...state.leases]) {
      const r = this.broker.renew({ leaseId: held.leaseId, token: held.token });
      if ("ok" in r) held.expiresAt = r.expiresAt; // success member only
      else state.leases.delete(cls);
    }
    if (state.leases.size === 0 && state.inflight.size === 0) {
      this.stopTimer(state);
      this.sessions.delete(sessionId);
    }
  }

  private dropLease(sessionId: string, cls: PeripheralClass): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.leases.delete(cls);
    if (state.leases.size === 0 && state.inflight.size === 0) {
      this.stopTimer(state);
      this.sessions.delete(sessionId);
    }
  }

  private stopTimer(state: SessionState): void {
    if (state.timer !== null) {
      this.scheduler.clearInterval(state.timer);
      state.timer = null;
    }
  }
}
