/*
 * The PORT for the host's durable records about a guest (N2 S7B, DOOR's migration 21 tables; the SQL lives in `host-env/guest-records.ts`): which guest boot belonged to which incarnation and what proved it ended,
 * and the data volume's own filesystem UUID. NOTHING in the daemon constructs this today; the native wiring builds it with the host, which production never
 * builds (the activation seam is off).
 *
 *  - `cowork_guest_boots` is written at the guest's `hello` and its end proof only after a release the recovery accepted. `endedGuestBoots` (DOOR's read) is
 *    built from rows with a proof, so a boot whose end was never proven is never attested to the guest. A guest-written marker is not a proof here: the three
 *    kinds are exactly the D1 evidence kinds.
 *  - `store_volume_uuid` is the data volume's filesystem UUID, kept per workspace and compared at every start (CR4 step 9). It is write-once: a different value is a
 *    mismatch, never an update.
 */

export type CoworkGuestEndProof = "orderly-receipt" | "new-boot" | "owner-recover";

export type CoworkGuestRecordFailure = "invalid_record" | "boot_conflict" | "unknown_workspace";
export class CoworkGuestRecordError extends Error {
  constructor(readonly code: CoworkGuestRecordFailure) { super(code); this.name = "CoworkGuestRecordError"; }
}

/** The port the native host and the recovery use. Optional in both; absent means nothing is recorded and no boot is ever attested as ended. */
export interface CoworkNativeGuestRecords {
  /** At the guest's `hello`. Idempotent for the same boot id; a different boot id for the same incarnation is a conflict. */
  recordHello(input: { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly guestBootId: string }): void;
  /** After a release the recovery accepted. Sets the proof once; never overwrites one. Returns whether a row was changed. */
  recordEnd(input: { readonly workspaceId: string; readonly incarnationId: string; readonly proof: CoworkGuestEndProof }): boolean;
  /** The data volume's recorded filesystem UUID, or null. */
  storeVolumeUuid(workspaceId: string): string | null;
  /** Write-once. `recorded` the first time, `same` for the same value, `mismatch` for a different one (nothing is changed). */
  recordStoreVolumeUuid(workspaceId: string, uuid: string): "recorded" | "same" | "mismatch";
}

