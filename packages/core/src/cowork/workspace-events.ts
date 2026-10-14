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
  const { seq, ts, ...event } = parsed.data;
  return event;
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
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly records: CoworkRepository, private readonly store: SessionStore,
    private readonly hub: SessionHub, private readonly crashPoint?: WorkspaceEventCrashPoint) {}

  drain(): { delivered: number; blocked: number } {
    if (this.draining) return { delivered: 0, blocked: 0 };
    if (this.records.rs.db.inTransaction) throw new CoworkError("recovery_required");
    this.draining = true;
    let delivered = 0, blocked = 0;
    try {
      for (const sessionId of this.records.pendingChangeSessions()) {
        try {
          // Read real JSONL, not the disposable index. A committed append may outlive its DB ACK.
          const logged = new Map<string, SessionEvent>();
          for (const event of this.store.read(sessionId)) {
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
              if (JSON.stringify(prior) !== JSON.stringify(input)) throw new CoworkError("recovery_required");
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
        } catch { blocked++; } // Leave the exact delivery pending. No raw host errors enter events/logs.
      }
    } finally { this.draining = false; }
    return { delivered, blocked };
  }
  start(): void {
    if (this.timer) return;
    this.drain();
    this.timer = setInterval(() => this.drain(), 1000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
