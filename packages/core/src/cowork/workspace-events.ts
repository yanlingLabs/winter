import { isDeepStrictEqual } from "node:util";
import { HOST_WORKSPACE_EVENT_TYPES, SessionEvent } from "@yanlinglabs/winter-protocol";
import type { SessionHub } from "../sessions/hub";
import type { EventInput, SessionStore } from "../sessions/store";
import { CoworkRepository, type WorkspaceChange } from "./repository";
import { CoworkError } from "./types";

/** Explicit safe projection. Legacy rows lacking snapshots emit refetch hints, never a later state
 * disguised as the state at that earlier revision. No guidance, labels, roots or credential text. */
export function workspaceEventInput(sessionId: string, change: WorkspaceChange): EventInput {
  const base = { sessionId, workspaceId: change.workspaceId, workspaceChangeId: change.changeId,
    operationId: change.operationId, workspaceRevision: change.revision };
  const data = (change.payload && typeof change.payload === "object" ? change.payload : {}) as Record<string, any>;
  let input: unknown;
  switch (change.kind) {
    case "workspace_sources_changed":
      input = { ...base, type: change.kind, phase: data.sources ? data.phase : "refetch",
        sources: Array.isArray(data.sources) ? data.sources.map(value => ({
          sourceId: value.sourceId, sourceRevision: value.sourceRevision, desired: value.desired, state: value.state,
          ackRevision: value.ackRevision, restartRequired: value.restartRequired, reason: value.reason,
        })) : [] };
      break;
    case "workspace_policy_changed":
      input = { ...base, type: change.kind, phase: "metadata", policyRevision: data.policyRevision,
        defaultRevision: data.defaultRevision, publicationRevision: data.publicationRevision,
        defaultPolicy: data.defaultPolicy, publication: data.publication };
      break;
    case "workspace_instructions_changed":
      input = { ...base, type: change.kind, instructionRevision: data.instructionRevision, digest: data.digest, refreshState: data.refreshState };
      break;
    case "workspace_operation_changed":
      input = { ...base, type: change.kind, status: data.status, terminal: data.terminal, supersededBy: data.supersededBy };
      break;
    case "workspace_created": case "workspace_display_changed": case "workspace_lifecycle_changed": case "conversation_bound":
      input = { ...base, type: "workspace_metadata_changed", change: ({ workspace_created: "created", workspace_display_changed: "display",
        workspace_lifecycle_changed: "lifecycle", conversation_bound: "conversation-bound" } as const)[change.kind] };
      break;
    default: throw new CoworkError("recovery_required");
  }
  const parsed = SessionEvent.safeParse({ ...(input as object), seq: 1, ts: 0 });
  if (!parsed.success) throw new CoworkError("recovery_required");
  // Match the persisted wire shape: optional undefined keys are absent in JSONL.
  const { seq, ts, ...event } = JSON.parse(JSON.stringify(parsed.data)) as SessionEvent;
  return event;
}

/** Called only after host session deletion; shared by boot reaping and live cleanup. */
export function createCoworkSessionDeletionHook(records: CoworkRepository | undefined, runtimeDelete?: (sessionId: string) => void) {
  return (sessionId: string): void => {
    try { runtimeDelete?.(sessionId); }
    finally {
      try { records?.abandonConversation(sessionId); }
      catch { console.error("[cowork] conversation notification cleanup pending"); }
    }
  };
}

export interface WorkspaceEventCrashPoint {
  /** Test-only crash windows. Never supplied by a client or runtime frame. */
  (phase: "before-append" | "after-append", sessionId: string, changeId: string): void;
}

/** Daemon-owned durable outbox consumer. Synchronous append/reconcile/ACK keeps commit order per
 * logical conversation; re-entrant hub observers cannot initiate a second delivery. Startup and
 * bounded periodic drains recover database commits even when their originating caller vanished. */
export class CoworkWorkspaceEvents {
  private draining = false;
  private failures = new Map<string, { attempts: number; retryAt: number }>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly records: CoworkRepository, private readonly store: SessionStore,
    private readonly hub: SessionHub, private readonly crashPoint?: WorkspaceEventCrashPoint, private readonly retryNow: () => number = () => performance.now()) {}

  drain(): { delivered: number; blocked: number; deferred: number; pruneBlocked: number } {
    if (this.draining) return { delivered: 0, blocked: 0, deferred: 0, pruneBlocked: 0 };
    if (this.records.rs.db.inTransaction) throw new CoworkError("recovery_required");
    this.draining = true;
    let delivered = 0, blocked = 0, deferred = 0, pruneBlocked = 0;
    try {
      const pendingSessions = this.records.pendingChangeSessions();
      const pendingSet = new Set(pendingSessions);
      for (const sessionId of this.failures.keys()) if (!pendingSet.has(sessionId)) this.failures.delete(sessionId);
      for (const sessionId of pendingSessions) {
        const failure = this.failures.get(sessionId);
        if (failure && failure.retryAt > this.retryNow()) { deferred++; continue; }
        try {
          if (!this.store.hasSession(sessionId)) {
            this.records.abandonConversation(sessionId);
            this.failures.delete(sessionId);
            continue;
          }
          // Read real JSONL, not the disposable index. A committed append may outlive its DB ACK.
          const events = this.store.read(sessionId);
          // Ordinary append can create a file; Cowork recovery must never replace a
          // missing/empty/uninitialized transcript just because its index row survived.
          const created = events[0];
          if (!created || created.type !== "session_created" || created.sessionId !== sessionId || created.seq !== 1) throw new CoworkError("recovery_required");
          const logged = new Map<string, SessionEvent>();
          for (const event of events) {
            if (!HOST_WORKSPACE_EVENT_TYPES.has(event.type) || !("workspaceChangeId" in event)) continue;
            if (logged.has(event.workspaceChangeId)) throw new CoworkError("recovery_required");
            logged.set(event.workspaceChangeId, event);
          }
          // Bound each pass; a blocked first change never permits later changes to overtake it.
          for (const change of this.records.pendingChanges(sessionId, 100)) {
            if (this.records.conversationWorkspace(sessionId) !== change.workspaceId) throw new CoworkError("recovery_required");
            const input = workspaceEventInput(sessionId, change);
            let event = logged.get(change.changeId);
            if (event) {
              const { seq, ts, ...prior } = event;
              if (!isDeepStrictEqual(prior, input)) throw new CoworkError("recovery_required");
            } else {
              this.crashPoint?.("before-append", sessionId, change.changeId);
              event = this.hub.append(sessionId, input);
              this.crashPoint?.("after-append", sessionId, change.changeId);
            }
            if (this.store.lastSeq(sessionId) < event.seq) throw new CoworkError("recovery_required");
            this.store.flushLog(sessionId);
            this.records.acknowledgeChange(sessionId, change.changeId, event.seq);
            delivered++;
          }
          this.failures.delete(sessionId);
          // Receipt retention is housekeeping after successful ACK, not a delivery failure.
          try { this.records.pruneDeliveredChanges(sessionId); } catch { pruneBlocked++; }
        } catch {
          const attempts = Math.min((failure?.attempts ?? 0) + 1, 10);
          this.failures.set(sessionId, { attempts, retryAt: this.retryNow() + Math.min(300_000, 1000 * 2 ** (attempts - 1)) });
          blocked++;
        } // Leave the exact delivery pending. No raw host errors enter events/logs.
      }
    } finally { this.draining = false; }
    return { delivered, blocked, deferred, pruneBlocked };
  }
  start(): void {
    if (this.timer) return;
    this.drain();
    this.timer = setInterval(() => this.drain(), 1000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
