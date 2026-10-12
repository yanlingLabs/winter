import type { CoworkVolumeOwner, CoworkVolumeRequest, CoworkVolumeRecord, VolumeFileIdentity, VolumePurpose } from "./volumes";

export type VolumeFilesystemState = "unformatted" | "formatting" | "probing" | "ready" | "recovery-required";
export interface VolumeFilesystemTarget {
  volumeId: string; creationId: string; purpose: VolumePurpose; identity: VolumeFileIdentity;
  capacityBytes: number; sectorBytes: 512; filesystemBlockBytes: 4096; expectedFilesystemUUID: string;
  action: "format-new" | "probe-existing";
}
/** Protected host-to-immutable-bootstrap command. Never an agent/guest format-request RPC.
 * Native intake authenticates the envelope and exact FD pair; guest telemetry is not authority. */
export interface VolumeFilesystemPlan {
  protocolVersion: 1; operationId: string; homeId: string; workspaceId: string; owner: CoworkVolumeOwner;
  volumes: VolumeFilesystemTarget[];
}
export interface VolumeFilesystemReceipt {
  protocolVersion: 1; operationId: string; homeId: string; workspaceId: string; owner: CoworkVolumeOwner;
  volumes: (VolumeFilesystemTarget & { filesystemType: "ext4"; filesystemUUID: string; flushConfirmed: true; checked: true })[];
}
export interface VolumeFilesystemJournal { plan: VolumeFilesystemPlan; receipt?: VolumeFilesystemReceipt }
export interface CoworkVolumeFilesystemAuthority {
  /** Verify current native admission, immutable bootstrap digest, closed exact two-disk envelope,
   * virgin format targets have no prior writable exposure, host disk budget and this controller/owner/incarnation. */
  authorize(request: CoworkVolumeRequest, homeId: string, volumes: readonly CoworkVolumeRecord[]): boolean;
  /** Mandatory protected native/supervisor receipt, not untrusted guest JSON or PID observation.
   * Guest packet parsing belongs in sandboxed worker/helper. Recheck scope/current authority here. */
  verifyReceipt(request: CoworkVolumeRequest, plan: Readonly<VolumeFilesystemPlan>, receipt: Readonly<VolumeFilesystemReceipt>, proof: unknown): boolean;
}
export const filesystemUUID = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const closed = (value: unknown, keys: string): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys.split(" ").sort().join(",");
const token = (value: unknown): boolean => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
export function validFilesystemPlan(value: unknown): value is VolumeFilesystemPlan {
  if (!closed(value, "protocolVersion operationId homeId workspaceId owner volumes") || value.protocolVersion !== 1 || ![value.operationId, value.homeId, value.workspaceId].every(token) || !closed(value.owner, "controllerInstanceId workerInstanceId incarnationId leaseEpoch runtimeImageDigest") || ![value.owner.controllerInstanceId, value.owner.workerInstanceId, value.owner.incarnationId].every(token) || !Number.isSafeInteger(value.owner.leaseEpoch) || value.owner.leaseEpoch < 1 || typeof value.owner.runtimeImageDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.owner.runtimeImageDigest) || !Array.isArray(value.volumes) || value.volumes.length !== 2) return false;
  if (!value.volumes.every((target: unknown, index: number) => closed(target, "volumeId creationId purpose identity capacityBytes sectorBytes filesystemBlockBytes expectedFilesystemUUID action") && [target.volumeId, target.creationId].every(token) && target.purpose === ["data", "environment"][index] && ["format-new", "probe-existing"].includes(target.action) && Number.isSafeInteger(target.capacityBytes) && target.capacityBytes >= 16777216 && target.capacityBytes <= 274877906944 && target.capacityBytes % 4096 === 0 && target.sectorBytes === 512 && target.filesystemBlockBytes === 4096 && filesystemUUID(target.expectedFilesystemUUID) && closed(target.identity, "device inode uid mode") && [target.identity.device, target.identity.inode].every(v => typeof v === "string" && /^[0-9]{1,30}$/.test(v)) && Number.isSafeInteger(target.identity.uid) && target.identity.uid >= 0 && target.identity.uid <= 4294967295 && target.identity.mode === 384)) return false;
  const [a, b] = value.volumes;
  return a.volumeId !== b.volumeId && a.creationId !== b.creationId && a.expectedFilesystemUUID !== b.expectedFilesystemUUID && (a.identity.device !== b.identity.device || a.identity.inode !== b.identity.inode);
}
/** Exact bounded shape before trusted verification. No generic JSON forwarding or optional checks. */
export function matchesFilesystemReceipt(plan: VolumeFilesystemPlan, receipt: VolumeFilesystemReceipt): boolean {
  if (!validFilesystemPlan(plan)) return false;
  const exact = (actual: unknown, expected: Record<string, unknown>): boolean => !!actual && typeof actual === "object" && Object.keys(actual).sort().join(",") === Object.keys(expected).sort().join(",") && Object.keys(expected).every(key => (actual as Record<string, unknown>)[key] === expected[key]);
  if (!receipt || typeof receipt !== "object" || Object.keys(receipt).sort().join(",") !== "homeId,operationId,owner,protocolVersion,volumes,workspaceId" || receipt.protocolVersion !== 1 || receipt.operationId !== plan.operationId || receipt.homeId !== plan.homeId || receipt.workspaceId !== plan.workspaceId || !exact(receipt.owner, { ...plan.owner }) || !Array.isArray(receipt.volumes) || receipt.volumes.length !== 2) return false;
  return plan.volumes.every((expected, index) => {
    const actual = receipt.volumes[index];
    return !!actual && typeof actual === "object" && Object.keys(actual).sort().join(",") === [...Object.keys(expected), "filesystemType", "filesystemUUID", "flushConfirmed", "checked"].sort().join(",") && Object.keys(expected).every(key => key === "identity" ? exact(actual.identity, { ...expected.identity }) : actual[key as keyof VolumeFilesystemTarget] === expected[key as keyof VolumeFilesystemTarget]) && actual.filesystemType === "ext4" && actual.filesystemUUID === expected.expectedFilesystemUUID && actual.flushConfirmed === true && actual.checked === true;
  });
}
