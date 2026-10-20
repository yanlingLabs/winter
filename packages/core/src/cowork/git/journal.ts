import { randomUUID } from "node:crypto";
import type { CoworkRepository } from "../repository";
import { GitPublicationError, type PublicationJournal, type PublicationReceipt, type PublicationStatus } from "./types";

const statusOf = (phase: PublicationStatus): "pending" | "blocked" | "applied" | "failed" =>
  phase === "prepared" ? "pending" : phase === "applied" ? "applied" : phase === "rejected" ? "failed" : "blocked";
type Row = { operation_id: string; request_digest: string; status: string; result_json: string };
export interface PublicationRecoveryCandidate {
  workspaceId: string; operationId: string; ownerId: string;
}
type OwnedPreparation = { operationId: string; digest: string; reject: boolean };
// Shared across handles in one actual host process, not persisted authority. An
// explicit rejection is proof that this host has finished its unsent attempt.
// Retain that fact through transient DB errors; never infer it from a timeout.
const ownedPreparations = new Map<string, Map<string, OwnedPreparation>>();
const MAX_OWNED_PREPARATIONS = 1024;

/** Host-only canonical receipt/outbox adapter. Never reconstruct receipts from a guest store.
 * Dispatched/uncertain effects stay blocked for explicit reconciliation, never prepared again. */
export class CanonicalPublicationJournal implements PublicationJournal {
  private readonly ownerScope: string;
  constructor(private readonly records: CoworkRepository, private readonly workspaceId: string,
    private readonly ownerId: string,
    private readonly now: () => string = () => new Date().toISOString()) {
    // An authenticated host incarnation, never a guest ID, PID alone, or a new
    // random ID per journal handle. Multiple handles in one host share this ID.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) throw new GitPublicationError("invalid_request");
    this.ownerScope = JSON.stringify([records.rs.path, workspaceId, ownerId]);
    records.get(workspaceId);
  }
  private remember(raw: string, preparation: OwnedPreparation): void {
    let entries = ownedPreparations.get(this.ownerScope);
    if (!entries) ownedPreparations.set(this.ownerScope, entries = new Map());
    if (!entries.has(raw) && entries.size >= MAX_OWNED_PREPARATIONS) throw new GitPublicationError("command_failed");
    entries.set(raw, preparation);
  }
  private forget(raw: string): void {
    const entries = ownedPreparations.get(this.ownerScope); entries?.delete(raw);
    if (entries?.size === 0) ownedPreparations.delete(this.ownerScope);
  }
  /** Host recovery only. Opening a second handle is not crash evidence. The
   * authority must prove this immutable owner incarnation terminated (not just
   * a stale heartbeat or reused PID); unknown/legacy owners stay pending. */
  async recoverPrepared(confirmPreviousOwnerTerminated: (candidate: Readonly<PublicationRecoveryCandidate>) => Promise<boolean>,
    onCandidateError?: (operationId: string, code: "record_invalid" | "proof_unavailable" | "persistence_unavailable") => void): Promise<number> {
    const candidates = this.records.rs.db.query<Row & { principal_id: string; request_id: string }, [string]>(
      "SELECT operation_id,request_digest,status,result_json,principal_id,request_id FROM cowork_operations WHERE method='git.publish' AND scope=? AND status='pending'").all(this.workspaceId);
    let recovered = 0;
    for (const candidate of candidates) {
      const report = (code: "record_invalid" | "proof_unavailable" | "persistence_unavailable") => {
        try { onCandidateError?.(candidate.operation_id, code); } catch { /* Diagnostics cannot abort unrelated recovery. */ }
      };
      let ownerId: string | undefined;
      try {
        if (this.receipt(candidate).status !== "prepared") throw new Error();
        ownerId = this.preparationOwner(candidate);
      } catch { report("record_invalid"); continue; }
      if (!ownerId || ownerId === this.ownerId) continue;
      try {
        if (!await confirmPreviousOwnerTerminated(Object.freeze({ workspaceId: this.workspaceId, operationId: candidate.operation_id, ownerId }))) continue;
      } catch { report("proof_unavailable"); continue; }
      // The proof awaited outside the transaction. Recheck this exact operation,
      // phase, digest and owner, never a newly claimed row or a dispatched effect.
      try { recovered += this.records.rs.transaction(() => {
        const key = { principalId: candidate.principal_id, requestId: candidate.request_id }, current = this.row(key);
        if (!current || current.operation_id !== candidate.operation_id || current.request_digest !== candidate.request_digest ||
            this.receipt(current).status !== "prepared" || this.preparationOwner(current) !== ownerId) return 0;
        this.move(key, "prepared", "rejected", ownerId); return 1;
      }, { mode: "immediate" }); } catch { report("persistence_unavailable"); }
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
    const result = this.records.rs.transaction(() => {
      const previous = this.row(key);
      if (previous) {
        let receipt = this.receipt(previous);
        const idle = ownedPreparations.get(this.ownerScope)?.get(raw);
        if (idle?.reject && idle.operationId === receipt.operationId && idle.digest === receipt.digest && this.preparationOwner(previous) === this.ownerId) {
          if (receipt.status === "prepared") receipt = this.move(key, "prepared", "rejected");
          // Defer forgetting until the containing transaction commits below.
        }
        return { created: false, receipt };
      }
      if ((ownedPreparations.get(this.ownerScope)?.size ?? 0) >= MAX_OWNED_PREPARATIONS) throw new GitPublicationError("command_failed");
      const workspace = this.records.get(this.workspaceId), at = this.now();
      const envelope = { operationId: receipt.operationId, workspaceId: this.workspaceId, revision: workspace.configRevision,
        preparationOwner: this.ownerId, value: { publication: receipt } };
      this.records.rs.db.run("INSERT INTO cowork_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)", [receipt.operationId,key.principalId,"git.publish",this.workspaceId,key.requestId,receipt.digest,this.workspaceId,"pending",JSON.stringify(envelope),at,at]);
      this.emit(receipt); return { created: true, receipt };
    }, { mode: "immediate" });
    if (result.created) this.remember(raw, { operationId: result.receipt.operationId, digest: result.receipt.digest, reject: false });
    else if (result.receipt.status !== "prepared") this.forget(raw);
    return result;
  }
  async transition(raw: string, from: PublicationStatus, to: PublicationStatus): Promise<PublicationReceipt> {
    const key = this.key(raw);
    const allowed = from === "prepared" ? ["dispatched","rejected"] : from === "dispatched" ? ["applied","rejected","uncertain"] : [];
    if (!allowed.includes(to)) throw new GitPublicationError("request_conflict");
    if (from === "prepared" && to === "rejected") {
      const known = ownedPreparations.get(this.ownerScope)?.get(raw);
      // The owning broker explicitly ended its unsent attempt. Keep the exact
      // identity even if this transaction cannot read/write the DB right now.
      if (known) this.remember(raw, { ...known, reject: true });
    } else if (from === "prepared") {
      // Dispatch was attempted; even an ambiguous DB result is not unsent proof.
      this.forget(raw);
    }
    const receipt = this.records.rs.transaction(() => this.move(key, from, to), { mode: "immediate" });
    this.forget(raw); return receipt;
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
