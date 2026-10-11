import { randomUUID } from "node:crypto";
import type { CoworkRepository } from "../repository";
import { GitPublicationError, type PublicationJournal, type PublicationReceipt, type PublicationStatus } from "./types";

const statusOf = (phase: PublicationStatus): "pending" | "blocked" | "applied" | "failed" =>
  phase === "prepared" ? "pending" : phase === "applied" ? "applied" : phase === "rejected" ? "failed" : "blocked";
type Row = { operation_id: string; request_digest: string; status: string; result_json: string };
export interface PublicationRecoveryCandidate {
  workspaceId: string; operationId: string; ownerId: string;
}

/** Host-only canonical receipt/outbox adapter. Never reconstruct receipts from a guest store.
 * Dispatched/uncertain effects stay blocked for explicit reconciliation, never prepared again. */
export class CanonicalPublicationJournal implements PublicationJournal {
  constructor(private readonly records: CoworkRepository, private readonly workspaceId: string,
    private readonly ownerId: string,
    private readonly now: () => string = () => new Date().toISOString()) {
    // An authenticated host incarnation, never a guest ID, PID alone, or a new
    // random ID per journal handle. Multiple handles in one host share this ID.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) throw new GitPublicationError("invalid_request");
    records.get(workspaceId);
  }
  /** Host recovery only. Opening a second handle is not crash evidence. The
   * authority must prove this immutable owner incarnation terminated (not just
   * a stale heartbeat or reused PID); unknown/legacy owners stay pending. */
  async recoverPrepared(confirmPreviousOwnerTerminated: (candidate: Readonly<PublicationRecoveryCandidate>) => Promise<boolean>): Promise<number> {
    const candidates = this.records.rs.db.query<Row & { principal_id: string; request_id: string }, [string]>(
      "SELECT operation_id,request_digest,status,result_json,principal_id,request_id FROM cowork_operations WHERE method='git.publish' AND scope=? AND status='pending'").all(this.workspaceId);
    let recovered = 0;
    for (const candidate of candidates) {
      if (this.receipt(candidate).status !== "prepared") throw new GitPublicationError("command_failed");
      const ownerId = this.preparationOwner(candidate);
      if (!ownerId || ownerId === this.ownerId) continue;
      if (!await confirmPreviousOwnerTerminated(Object.freeze({ workspaceId: this.workspaceId, operationId: candidate.operation_id, ownerId }))) continue;
      // The proof awaited outside the transaction. Recheck this exact operation,
      // phase, digest and owner, never a newly claimed row or a dispatched effect.
      recovered += this.records.rs.transaction(() => {
        const key = { principalId: candidate.principal_id, requestId: candidate.request_id }, current = this.row(key);
        if (!current || current.operation_id !== candidate.operation_id || current.request_digest !== candidate.request_digest ||
            this.receipt(current).status !== "prepared" || this.preparationOwner(current) !== ownerId) return 0;
        this.move(key, "prepared", "rejected", ownerId); return 1;
      }, { mode: "immediate" });
    }
    return recovered;
  }
  private preparationOwner(row: Row): string | undefined {
    const owner = JSON.parse(row.result_json).preparationOwner;
    return typeof owner === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(owner) ? owner : undefined;
  }
  private key(raw: string): { principalId: string; requestId: string } {
    let parts: unknown;
    try { parts = JSON.parse(raw); } catch { throw new GitPublicationError("invalid_request"); }
    if (!Array.isArray(parts) || parts.length !== 3 || parts[1] !== this.workspaceId ||
        ![parts[0], parts[2]].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new GitPublicationError("invalid_request");
    return { principalId: parts[0], requestId: parts[2] };
  }
  private row(key: { principalId: string; requestId: string }): Row | null {
    return this.records.rs.db.query<Row, [string,string,string]>("SELECT operation_id,request_digest,status,result_json FROM cowork_operations WHERE principal_id=? AND method='git.publish' AND scope=? AND request_id=?")
      .get(key.principalId, this.workspaceId, key.requestId);
  }
  private receipt(row: Row): PublicationReceipt {
    try {
      const envelope = JSON.parse(row.result_json), receipt = envelope.value.publication as PublicationReceipt;
      if (envelope.workspaceId !== this.workspaceId || envelope.operationId !== row.operation_id ||
          receipt.operationId !== row.operation_id || receipt.digest !== row.request_digest ||
          !["prepared","dispatched","applied","rejected","uncertain"].includes(receipt.status) || statusOf(receipt.status) !== row.status) throw new Error();
      return receipt;
    } catch { throw new GitPublicationError("command_failed"); }
  }
  private emit(receipt: PublicationReceipt): void {
    const db = this.records.rs.db, changeId = `change_${randomUUID()}`, revision = this.records.get(this.workspaceId).configRevision;
    const payload = { operationId: receipt.operationId, status: statusOf(receipt.status), publicationStatus: receipt.status,
      terminal: receipt.status === "applied" || receipt.status === "rejected", automaticReplayAllowed: false };
    db.run("INSERT INTO cowork_outbox(change_id,workspace_id,operation_id,revision,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
      [changeId, this.workspaceId, receipt.operationId, revision, "workspace_operation_changed", JSON.stringify(payload), this.now()]);
    db.run("INSERT INTO cowork_outbox_deliveries(change_id,session_id,state) SELECT ?,session_id,'pending' FROM cowork_conversations WHERE workspace_id=? AND state!='deleted'", [changeId, this.workspaceId]);
  }
  async claim(raw: string, incoming: PublicationReceipt): Promise<{ created: boolean; receipt: PublicationReceipt }> {
    const key = this.key(raw);
    if (incoming.status !== "prepared" || !/^[a-f0-9-]{36}$/.test(incoming.operationId) || !/^[a-f0-9]{64}$/.test(incoming.digest)) throw new GitPublicationError("invalid_request");
    const receipt: PublicationReceipt = { operationId: incoming.operationId, digest: incoming.digest, status: "prepared",
      repositoryId: incoming.repositoryId, ref: incoming.ref, oldOid: incoming.oldOid, newOid: incoming.newOid };
    return this.records.rs.transaction(() => {
      const previous = this.row(key); if (previous) return { created: false, receipt: this.receipt(previous) };
      const workspace = this.records.get(this.workspaceId), at = this.now();
      const envelope = { operationId: receipt.operationId, workspaceId: this.workspaceId, revision: workspace.configRevision,
        preparationOwner: this.ownerId, value: { publication: receipt } };
      this.records.rs.db.run("INSERT INTO cowork_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)", [receipt.operationId,key.principalId,"git.publish",this.workspaceId,key.requestId,receipt.digest,this.workspaceId,"pending",JSON.stringify(envelope),at,at]);
      this.emit(receipt); return { created: true, receipt };
    }, { mode: "immediate" });
  }
  async transition(raw: string, from: PublicationStatus, to: PublicationStatus): Promise<PublicationReceipt> {
    const key = this.key(raw);
    const allowed = from === "prepared" ? ["dispatched","rejected"] : from === "dispatched" ? ["applied","rejected","uncertain"] : [];
    if (!allowed.includes(to)) throw new GitPublicationError("request_conflict");
    return this.records.rs.transaction(() => this.move(key, from, to), { mode: "immediate" });
  }
  private move(key: { principalId: string; requestId: string }, from: PublicationStatus, to: PublicationStatus, preparationOwner = this.ownerId): PublicationReceipt {
    const row = this.row(key); if (!row) throw new GitPublicationError("request_conflict");
    const previous = this.receipt(row);
    if (previous.status === to) return previous;
    if (previous.status !== from) throw new GitPublicationError("request_conflict");
    if (from === "prepared" && this.preparationOwner(row) !== preparationOwner) throw new GitPublicationError("request_conflict");
    const next = { ...previous, status: to }, envelope = JSON.parse(row.result_json);
    envelope.value.publication = next;
    this.records.rs.db.run("UPDATE cowork_operations SET status=?,result_json=?,updated_at=? WHERE operation_id=?", [statusOf(to),JSON.stringify(envelope),this.now(),next.operationId]);
    this.emit(next); return next;
  }
}
