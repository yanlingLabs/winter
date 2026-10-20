import type { RuntimeStateDb } from "../../runtime-state/db";
import { CoworkGuestRecordError, type CoworkGuestEndProof, type CoworkNativeGuestRecords } from "../native/guest-records";

/** The SQL behind the native host's guest-records port (DOOR's migration 21 tables). Lives beside the environment, not in `native/`, which writes the database in one place only. */
const END_PROOFS: ReadonlySet<string> = new Set(["orderly-receipt", "new-boot", "owner-recover"]);
const GUEST_BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_.-]{1,160}$/;

export class CoworkGuestRecords implements CoworkNativeGuestRecords {
  constructor(private readonly rs: RuntimeStateDb, private readonly now: () => string = () => new Date().toISOString()) {}
  recordHello(input: { workspaceId: string; incarnationId: string; leaseEpoch: number; guestBootId: string }): void {
    if (!TOKEN.test(input.workspaceId) || !TOKEN.test(input.incarnationId) || !Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1 || !GUEST_BOOT.test(input.guestBootId)) throw new CoworkGuestRecordError("invalid_record");
    this.rs.transaction(() => {
      if (this.rs.db.query("SELECT 1 FROM cowork_workspaces WHERE workspace_id=?").get(input.workspaceId) === null) throw new CoworkGuestRecordError("unknown_workspace");
      const existing = this.rs.db.query<{ guest_boot_id: string }, [string, string]>("SELECT guest_boot_id FROM cowork_guest_boots WHERE workspace_id=? AND incarnation_id=?").get(input.workspaceId, input.incarnationId);
      if (existing) { if (existing.guest_boot_id !== input.guestBootId) throw new CoworkGuestRecordError("boot_conflict"); return; }
      // The boot id is unique across the table: a reused id (another incarnation's) is a conflict, not a second row.
      try {
        this.rs.db.run("INSERT INTO cowork_guest_boots(workspace_id,incarnation_id,lease_epoch,guest_boot_id,recorded_at) VALUES(?,?,?,?,?)", [input.workspaceId, input.incarnationId, input.leaseEpoch, input.guestBootId, this.now()]);
      } catch { throw new CoworkGuestRecordError("boot_conflict"); }
    }, { mode: "immediate" });
  }
  recordEnd(input: { workspaceId: string; incarnationId: string; proof: CoworkGuestEndProof }): boolean {
    if (!TOKEN.test(input.workspaceId) || !TOKEN.test(input.incarnationId) || !END_PROOFS.has(input.proof)) throw new CoworkGuestRecordError("invalid_record");
    const result = this.rs.db.run("UPDATE cowork_guest_boots SET ended_proof=?,ended_at=? WHERE workspace_id=? AND incarnation_id=? AND ended_proof IS NULL", [input.proof, this.now(), input.workspaceId, input.incarnationId]);
    return result.changes > 0;
  }
  storeVolumeUuid(workspaceId: string): string | null {
    const row = this.rs.db.query<{ store_volume_uuid: string | null }, [string]>("SELECT store_volume_uuid FROM cowork_workspaces WHERE workspace_id=?").get(workspaceId);
    return row?.store_volume_uuid ?? null;
  }
  recordStoreVolumeUuid(workspaceId: string, uuid: string): "recorded" | "same" | "mismatch" {
    if (!TOKEN.test(workspaceId) || !GUEST_BOOT.test(uuid)) throw new CoworkGuestRecordError("invalid_record");
    return this.rs.transaction(() => {
      const row = this.rs.db.query<{ store_volume_uuid: string | null }, [string]>("SELECT store_volume_uuid FROM cowork_workspaces WHERE workspace_id=?").get(workspaceId);
      if (!row) throw new CoworkGuestRecordError("unknown_workspace");
      if (row.store_volume_uuid === null) { this.rs.db.run("UPDATE cowork_workspaces SET store_volume_uuid=? WHERE workspace_id=?", [uuid, workspaceId]); return "recorded" as const; }
      return row.store_volume_uuid === uuid ? "same" as const : "mismatch" as const;
    }, { mode: "immediate" });
  }
}
