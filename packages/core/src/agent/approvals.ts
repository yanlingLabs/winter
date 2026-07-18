export interface ApprovalOutcome { approved: boolean; by: string }

/** A currently-pending approval, as returned by `ApprovalBroker.list()` and the `approval.list`
 *  RPC — the queryable STATE the report's approval contract asks for (pending approvals age out of
 *  the event stream, so a phone that reconnects can't reconstruct them from replay alone).
 *  `expiresAt` is the fail-closed deadline (epoch ms); a phone renders "expires in Ns" and derives
 *  `.expired` from it without waiting for the `approval_resolved{by:"timeout"}` event. */
export interface PendingApproval {
  callId: string;
  toolName: string;
  summary: string;
  issuedAt: number;   // epoch ms the approval was requested
  expiresAt: number;  // epoch ms the broker will fail it closed (issuedAt + timeoutMs)
}

/** Optional metadata threaded from the emit site (engine.ts/daemon.ts) so a pending approval is
 *  listable + carries its deadline. Omitted by callers that don't need listing (direct unit tests);
 *  the broker then falls back to `Date.now()`/`+timeoutMs` and empty tool/summary strings. */
export interface WaitMeta { toolName: string; summary: string; issuedAt: number; expiresAt: number }

interface PendingEntry {
  sessionId: string;
  callId: string;
  resolve: (o: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  toolName: string;
  summary: string;
  issuedAt: number;
  expiresAt: number;
}

/** In-flight approval requests, keyed by sessionId+callId. First response wins (spec §4.10).
 *
 *  Approval identity + compare-and-set: an approval is identified by its `(sessionId, callId)` for
 *  its whole life — the callId never mutates or is reused — so `callId` IS the compare-and-set token
 *  the report's contract calls `expectedVersion`, and `resolve()`'s `{ok, alreadyResolved}` already
 *  IS its "a second answer → AlreadyResolved" semantics (an answer for an already-settled callId
 *  reports `alreadyResolved:true`). There is deliberately NO redundant numeric `version` field:
 *  callId + alreadyResolved subsumes it (SP3 T4b design decision). */
export class ApprovalBroker {
  private pending = new Map<string, PendingEntry>();

  private key(sessionId: string, callId: string): string { return `${sessionId}:${callId}`; }

  wait(sessionId: string, callId: string, timeoutMs: number, meta?: WaitMeta): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const k = this.key(sessionId, callId);
      const timer = setTimeout(() => {
        this.pending.delete(k);
        resolve({ approved: false, by: "timeout" }); // fail-closed: no answer means no
      }, timeoutMs);
      const issuedAt = meta?.issuedAt ?? Date.now();
      this.pending.set(k, {
        sessionId, callId, resolve, timer,
        toolName: meta?.toolName ?? "",
        summary: meta?.summary ?? "",
        issuedAt,
        expiresAt: meta?.expiresAt ?? issuedAt + timeoutMs,
      });
    });
  }

  resolve(sessionId: string, callId: string, approved: boolean, by: string): { ok: true; alreadyResolved: boolean } {
    const k = this.key(sessionId, callId);
    const entry = this.pending.get(k);
    if (!entry) return { ok: true, alreadyResolved: true };
    this.pending.delete(k);
    clearTimeout(entry.timer);
    entry.resolve({ approved, by });
    return { ok: true, alreadyResolved: false };
  }

  /** The currently-pending approvals for a session (queryable state — see `PendingApproval`).
   *  Timed-out/resolved entries have already been removed from the map, so a stale approval never
   *  appears here. Order is insertion order (Map iteration). */
  list(sessionId: string): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const e of this.pending.values()) {
      if (e.sessionId !== sessionId) continue;
      out.push({ callId: e.callId, toolName: e.toolName, summary: e.summary, issuedAt: e.issuedAt, expiresAt: e.expiresAt });
    }
    return out;
  }
}
