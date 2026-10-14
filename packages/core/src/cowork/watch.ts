import { createHash, randomUUID } from "node:crypto";
import { CoworkWatchFrame, WORKSPACE_WATCH_LEASE_MS, WORKSPACE_WATCH_RENEW_MS, type CoworkWorkspace } from "@yanlinglabs/winter-protocol";
import type { RuntimeStateDb } from "../runtime-state/db";
import { CoworkError } from "./types";
import type { CoworkConnection } from "./service";

export interface CoworkWatchSink {
  send(frame: CoworkWatchFrame): "sent" | "blocked" | "closed";
}
export interface CoworkWatchRead {
  principalId: string;
  workspaces: Array<{ snapshot: CoworkWorkspace; position: number }>;
}
export interface CoworkWatchOptions {
  monotonicNow?: () => number;
  wallNow?: () => number;
  /** Deterministic fixture clocks only. Production always maintains leases automatically. */
  automaticMaintenance?: boolean;
}
interface Subscription {
  subscriptionId: string; connection: CoworkConnection; principalId: string; ids: string[];
  deadline: number; leaseExpiresAt: string; seq: number; sink: CoworkWatchSink;
  snapshots: string[]; signatures: Map<string, string>;
  dirty: boolean; commits: number; refetchRequired: boolean;
  expiry?: ReturnType<typeof setTimeout>; maintenance?: ReturnType<typeof setInterval>;
}
const MAX_IDS = 32, MAX_CONNECTION_WATCHES = 4, MAX_COALESCED_COMMITS = 128;
const digest = (snapshot: CoworkWorkspace, position: number) => createHash("sha256").update(JSON.stringify([snapshot, position])).digest("hex");

/** Ephemeral delivery only. Canonical snapshots/outbox remain in runtime-state.db.
 * Does not open a session, read a transcript, execute a tool or create durable subscriptions. */
export class CoworkWorkspaceWatches {
  private subscriptions = new Map<string, Subscription>();
  private queued?: ReturnType<typeof setTimeout>;
  private closed = false;
  private unsubscribe?: () => void;
  private readonly now: () => number;
  private readonly wall: () => number;
  constructor(private readonly db: RuntimeStateDb, private readonly read: (connection: CoworkConnection, ids: string[]) => CoworkWatchRead,
              private readonly authorize: (connection: CoworkConnection, ids: string[]) => string,
              private readonly options: CoworkWatchOptions = {}) {
    this.now = options.monotonicNow ?? (() => performance.now());
    this.wall = options.wallNow ?? Date.now;
  }
  private observe(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.db.onCommittedWrite(() => {
      for (const watch of this.subscriptions.values()) {
        watch.dirty = true;
        // One counter and at most32 IDs, never an unbounded event/payload queue.
        watch.commits = Math.min(MAX_COALESCED_COMMITS + 1, watch.commits + 1);
        if (watch.commits > MAX_COALESCED_COMMITS) watch.refetchRequired = true;
      }
      this.schedule();
    });
  }
  get size(): number { return this.subscriptions.size; }
  start(connection: CoworkConnection, ids: string[], sink: CoworkWatchSink) {
    if (this.closed) throw new CoworkError("unsupported_topology");
    if (!ids.length || ids.length > MAX_IDS || new Set(ids).size !== ids.length) throw new CoworkError("invalid_request");
    if ([...this.subscriptions.values()].filter(value => value.connection.connectionId === connection.connectionId).length >= MAX_CONNECTION_WATCHES) throw new CoworkError("invalid_request");
    // Validate every ID before allocation. One unauthorized member refuses the whole watch.
    const current = this.read(connection, ids);
    const watch: Subscription = { subscriptionId: `watch_${randomUUID()}`, connection: { ...connection }, principalId: current.principalId,
      ids: [...ids], deadline: 0, leaseExpiresAt: "", seq: 0, sink, snapshots: [...ids],
      signatures: new Map(current.workspaces.map(({ snapshot, position }) => [snapshot.workspaceId, digest(snapshot, position)])),
      dirty: false, commits: 0, refetchRequired: false };
    this.subscriptions.set(watch.subscriptionId, watch);
    this.observe();
    this.extend(watch);
    this.schedule();
    return this.lease(watch);
  }
  renew(connection: CoworkConnection, subscriptionId: string) {
    const watch = this.owned(connection, subscriptionId);
    if (this.now() >= watch.deadline) { this.end(watch, "expired"); throw new CoworkError("authority_denied"); }
    try { this.checkAuthority(watch); }
    catch { this.end(watch, "authority_revoked"); throw new CoworkError("authority_denied"); }
    this.extend(watch);
    return this.lease(watch);
  }
  detach(connection: CoworkConnection, subscriptionId: string) {
    this.end(this.owned(connection, subscriptionId), "detached");
    return { detached: true as const };
  }
  private owned(connection: CoworkConnection, subscriptionId: string) {
    const watch = this.subscriptions.get(subscriptionId);
    if (!watch || watch.connection.connectionId !== connection.connectionId || watch.connection.role !== connection.role) throw new CoworkError("authority_denied");
    // Detach remains available after access revocation: same connection owns cleanup.
    return watch;
  }
  private lease(watch: Subscription) {
    return { subscriptionId: watch.subscriptionId, leaseExpiresAt: watch.leaseExpiresAt, renewAfterMs: WORKSPACE_WATCH_RENEW_MS };
  }
  private extend(watch: Subscription) {
    watch.deadline = this.now() + WORKSPACE_WATCH_LEASE_MS;
    watch.leaseExpiresAt = new Date(this.wall() + WORKSPACE_WATCH_LEASE_MS).toISOString();
    if (watch.expiry) clearTimeout(watch.expiry);
    if (this.options.automaticMaintenance !== false) {
      watch.expiry = setTimeout(() => this.maintainOne(watch), WORKSPACE_WATCH_LEASE_MS); watch.expiry.unref();
      if (!watch.maintenance) {
        watch.maintenance = setInterval(() => this.maintainOne(watch), WORKSPACE_WATCH_RENEW_MS); watch.maintenance.unref();
      }
    }
  }
  private checkAuthority(watch: Subscription): void {
    if (this.authorize(watch.connection, watch.ids) !== watch.principalId) throw new CoworkError("authority_denied");
  }
  private authorized(watch: Subscription): CoworkWatchRead {
    const result = this.read(watch.connection, watch.ids);
    if (result.principalId !== watch.principalId || result.workspaces.length !== watch.ids.length) throw new CoworkError("authority_denied");
    return result;
  }
  /** Lease/access checks only; does not poll workspace state for changes. */
  private maintainOne(watch: Subscription): void {
    if (!this.subscriptions.has(watch.subscriptionId)) return;
    if (this.now() >= watch.deadline) { this.end(watch, "expired"); return; }
    try { this.checkAuthority(watch); } catch { this.end(watch, "authority_revoked"); }
  }
  maintain(): void {
    for (const watch of [...this.subscriptions.values()]) this.maintainOne(watch);
  }
  private schedule(): void {
    if (this.queued || this.closed || !this.subscriptions.size) return;
    // A macrotask lets the RPC acceptance result precede the first notification.
    this.queued = setTimeout(() => { this.queued = undefined; this.flush(); }, 0);
    this.queued.unref();
  }
  private send(watch: Subscription, body: Record<string, unknown>): "sent" | "blocked" | "closed" {
    const frame = CoworkWatchFrame.parse({ ...body, subscriptionId: watch.subscriptionId, seq: watch.seq + 1, leaseExpiresAt: watch.leaseExpiresAt });
    const result = watch.sink.send(frame);
    if (result === "sent") watch.seq++;
    if (result === "closed") this.release(watch);
    return result;
  }
  flush(connectionId?: number): void {
    for (const watch of [...this.subscriptions.values()]) {
      if (connectionId !== undefined && watch.connection.connectionId !== connectionId) continue;
      if (this.now() >= watch.deadline) { this.end(watch, "expired"); continue; }
      try {
        // Recheck every enrolled workspace and current host principal at each delivery.
        const current = this.authorized(watch);
        let blocked = false;
        for (const workspaceId of [...watch.snapshots]) {
          const value = current.workspaces.find(value => value.snapshot.workspaceId === workspaceId)!;
          if (this.send(watch, { phase: "snapshot", workspace: value.snapshot }) !== "sent") { blocked = true; break; }
          watch.snapshots.shift();
          watch.signatures.set(workspaceId, digest(value.snapshot, value.position));
        }
        if (blocked || !this.subscriptions.has(watch.subscriptionId) || !watch.dirty) continue;
        const changed = current.workspaces.filter(({ snapshot, position }) => watch.refetchRequired || watch.signatures.get(snapshot.workspaceId) !== digest(snapshot, position));
        if (!changed.length) { watch.dirty = false; watch.commits = 0; continue; }
        const revisions = changed.map(({ snapshot }) => {
          const { workspaceId, configRevision, grantRevision, instructionRevision, leaseEpoch } = snapshot;
          return { workspaceId, configRevision, grantRevision, instructionRevision, leaseEpoch };
        });
        if (this.send(watch, { phase: "change", revisions, refetchRequired: watch.refetchRequired }) !== "sent") continue;
        for (const { snapshot, position } of changed) watch.signatures.set(snapshot.workspaceId, digest(snapshot, position));
        watch.dirty = false; watch.commits = 0; watch.refetchRequired = false;
      } catch (error) {
        this.end(watch, error instanceof CoworkError && ["authority_denied", "not_found"].includes(error.code) ? "authority_revoked" : "unavailable");
      }
    }
  }
  private release(watch: Subscription): void {
    this.subscriptions.delete(watch.subscriptionId);
    if (watch.expiry) clearTimeout(watch.expiry);
    if (watch.maintenance) clearInterval(watch.maintenance);
    watch.snapshots.length = 0; watch.signatures.clear();
    if (!this.subscriptions.size) {
      this.unsubscribe?.(); this.unsubscribe = undefined;
      if (this.queued) clearTimeout(this.queued);
      this.queued = undefined;
    }
  }
  private end(watch: Subscription, reason: Extract<CoworkWatchFrame, { phase: "ended" }>["reason"]): void {
    this.release(watch); // no terminal send failure can retain a lease
    try { this.send(watch, { phase: "ended", reason }); } catch { /* disconnected; release already complete */ }
  }
  closeConnection(connectionId: number): void {
    for (const watch of [...this.subscriptions.values()]) if (watch.connection.connectionId === connectionId) this.end(watch, "disconnected");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.queued) clearTimeout(this.queued);
    this.queued = undefined;
    for (const watch of [...this.subscriptions.values()]) this.end(watch, "shutdown");
  }
}
