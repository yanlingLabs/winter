import type { CoworkVolumeOwner, CoworkVolumeRequest, CoworkVolumeRecord, VolumeFileIdentity, VolumePurpose } from "./volumes";

export const COWORK_EXT4_FEATURES = Object.freeze(["64bit", "dir_index", "dir_nlink", "extent", "extra_isize", "filetype", "flex_bg", "has_journal", "huge_file", "large_file", "metadata_csum", "sparse_super"]);
export const COWORK_EXT4_MOUNT_OPTIONS = Object.freeze(["noinit_itable"]);
export type FilesystemCheckMode = "normal" | "full-read-only";
export type VolumeFilesystemState = "unformatted" | "formatting" | "probing" | "ready" | "recovery-required";
export interface VolumeFilesystemTarget {
  volumeId: string; creationId: string; purpose: VolumePurpose; identity: VolumeFileIdentity;
  capacityBytes: number; sectorBytes: 512; filesystemBlockBytes: 4096; expectedFilesystemUUID: string;
  action: "format-new" | "probe-existing";
}
interface PlanScope { operationId: string; homeId: string; workspaceId: string; owner: CoworkVolumeOwner; volumes: VolumeFilesystemTarget[] }
/** Protected host-to-immutable-bootstrap command, never an agent/guest format RPC.
 * Format-new alone carries canonical virgin provenance; noinit_itable is a REQUIRED mount
 * contract, not evidence a mount occurred. The eventual trusted mount adapter must enforce it. */
export interface VolumeFilesystemPlan extends PlanScope {
  protocolVersion: 2; virginZeroProvenance: "new-sparse-creation"; ext4Features: string[]; requiredMountOptions: string[]; checkMode: FilesystemCheckMode;
}
interface LegacyPlan extends PlanScope { protocolVersion: 1 }
type Observation = VolumeFilesystemTarget & { filesystemType: "ext4"; filesystemUUID: string; flushConfirmed: true; checked: true };
export interface VolumeFilesystemReceipt extends Omit<VolumeFilesystemPlan, "volumes"> {
  volumes: (Observation & { filesystemFeatures: string[]; fullReadOnlyCheck: boolean })[];
}
interface LegacyReceipt extends Omit<LegacyPlan, "volumes"> { volumes: Observation[] }
export type RecordedFilesystemPlan = VolumeFilesystemPlan | LegacyPlan;
export type RecordedFilesystemReceipt = VolumeFilesystemReceipt | LegacyReceipt;
export interface FilesystemReadyHistory { plan: RecordedFilesystemPlan; receipt: RecordedFilesystemReceipt }
/** Retain one last confirmed receipt, never a recursively growing history or another owner ledger. */
export interface VolumeFilesystemJournal { plan: RecordedFilesystemPlan; receipt?: RecordedFilesystemReceipt; previousReady?: FilesystemReadyHistory }
export interface CoworkVolumeFilesystemAuthority {
  /** Verify current native admission, immutable bootstrap/envelope, exact owner/incarnation,
   * virgin provenance for format targets, disk budget and explicit repair/full-check authority. */
  authorize(request: CoworkVolumeRequest, homeId: string, volumes: readonly CoworkVolumeRecord[], checkMode: FilesystemCheckMode): boolean;
  /** Mandatory protected worker/supervisor evidence; packet parsers stay sandboxed. */
  verifyReceipt(request: CoworkVolumeRequest, plan: Readonly<VolumeFilesystemPlan>, receipt: Readonly<VolumeFilesystemReceipt>, proof: unknown): boolean;
}
export const filesystemUUID = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const closed = (value: unknown, keys: string): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys.split(" ").sort().join(",");
const token = (value: unknown): boolean => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const sameList = (value: unknown, expected: readonly string[]): boolean => Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
export function validFilesystemPlan(value: unknown): value is RecordedFilesystemPlan {
  if (!value || typeof value !== "object") return false;
  const version = (value as any).protocolVersion;
  if (!closed(value, "protocolVersion operationId homeId workspaceId owner volumes" + (version === 2 ? " virginZeroProvenance ext4Features requiredMountOptions checkMode" : "")) || ![1, 2].includes(version) || ![value.operationId, value.homeId, value.workspaceId].every(token) || !closed(value.owner, "controllerInstanceId workerInstanceId incarnationId leaseEpoch runtimeImageDigest") || ![value.owner.controllerInstanceId, value.owner.workerInstanceId, value.owner.incarnationId].every(token) || !Number.isSafeInteger(value.owner.leaseEpoch) || value.owner.leaseEpoch < 1 || typeof value.owner.runtimeImageDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.owner.runtimeImageDigest) || !Array.isArray(value.volumes) || value.volumes.length !== 2) return false;
  if (version === 2 && (value.virginZeroProvenance !== "new-sparse-creation" || !sameList(value.ext4Features, COWORK_EXT4_FEATURES) || !sameList(value.requiredMountOptions, COWORK_EXT4_MOUNT_OPTIONS) || !["normal", "full-read-only"].includes(value.checkMode))) return false;
  if (!value.volumes.every((target: unknown, index: number) => closed(target, "volumeId creationId purpose identity capacityBytes sectorBytes filesystemBlockBytes expectedFilesystemUUID action") && [target.volumeId, target.creationId].every(token) && target.purpose === ["data", "environment"][index] && ["format-new", "probe-existing"].includes(target.action) && Number.isSafeInteger(target.capacityBytes) && target.capacityBytes >= 16777216 && target.capacityBytes <= 274877906944 && target.capacityBytes % 4096 === 0 && target.sectorBytes === 512 && target.filesystemBlockBytes === 4096 && filesystemUUID(target.expectedFilesystemUUID) && closed(target.identity, "device inode uid mode") && [target.identity.device, target.identity.inode].every(v => typeof v === "string" && /^[0-9]{1,30}$/.test(v)) && Number.isSafeInteger(target.identity.uid) && target.identity.uid >= 0 && target.identity.uid <= 4294967295 && target.identity.mode === 384)) return false;
  const [a, b] = value.volumes;
  return a.volumeId !== b.volumeId && a.creationId !== b.creationId && a.expectedFilesystemUUID !== b.expectedFilesystemUUID && (a.identity.device !== b.identity.device || a.identity.inode !== b.identity.inode);
}
/** Legacy receipts preserve history only; they cannot satisfy v2 current-owner readiness. */
export function matchesFilesystemReceipt(plan: RecordedFilesystemPlan, receipt: RecordedFilesystemReceipt): boolean {
  if (!validFilesystemPlan(plan)) return false;
  const exact = (actual: unknown, expected: Record<string, unknown>): boolean => !!actual && typeof actual === "object" && Object.keys(actual).sort().join(",") === Object.keys(expected).sort().join(",") && Object.keys(expected).every(key => (actual as Record<string, unknown>)[key] === expected[key]);
  if (!closed(receipt, Object.keys(plan).join(" ")) || receipt.protocolVersion !== plan.protocolVersion || receipt.operationId !== plan.operationId || receipt.homeId !== plan.homeId || receipt.workspaceId !== plan.workspaceId || !exact(receipt.owner, { ...plan.owner }) || !Array.isArray(receipt.volumes) || receipt.volumes.length !== 2) return false;
  if (plan.protocolVersion === 2 && (receipt.protocolVersion !== 2 || receipt.virginZeroProvenance !== plan.virginZeroProvenance || !sameList(receipt.ext4Features, plan.ext4Features) || !sameList(receipt.requiredMountOptions, plan.requiredMountOptions) || receipt.checkMode !== plan.checkMode)) return false;
  return plan.volumes.every((expected, index) => {
    const actual: unknown = receipt.volumes[index];
    return closed(actual, Object.keys(expected).join(" ") + " filesystemType filesystemUUID flushConfirmed checked" + (plan.protocolVersion === 2 ? " filesystemFeatures fullReadOnlyCheck" : "")) && Object.keys(expected).every(key => key === "identity" ? exact(actual.identity, { ...expected.identity }) : actual[key] === expected[key as keyof VolumeFilesystemTarget]) && actual.filesystemType === "ext4" && actual.filesystemUUID === expected.expectedFilesystemUUID && actual.flushConfirmed === true && actual.checked === true && (plan.protocolVersion === 1 || (sameList(actual.filesystemFeatures, plan.ext4Features) && actual.fullReadOnlyCheck === (plan.checkMode === "full-read-only")));
  });
}
export function readyFilesystemHistory(journal: VolumeFilesystemJournal | null): FilesystemReadyHistory | undefined {
  if (journal?.receipt && matchesFilesystemReceipt(journal.plan, journal.receipt)) return { plan: journal.plan, receipt: journal.receipt };
  const previous = journal?.previousReady;
  return previous && matchesFilesystemReceipt(previous.plan, previous.receipt) ? previous : undefined;
}
