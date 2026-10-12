import type { CoworkVolumeOwner, CoworkVolumeRequest, CoworkVolumeRecord, VolumeFileIdentity, VolumePurpose } from "./volumes";

export const COWORK_EXT4_FEATURES = Object.freeze(["64bit", "dir_index", "dir_nlink", "extent", "extra_isize", "filetype", "flex_bg", "has_journal", "huge_file", "large_file", "metadata_csum", "sparse_super"]);
export const COWORK_EXT4_MOUNT_OPTIONS = Object.freeze(["noinit_itable"]);
export const COWORK_EXT4_TRANSIENT_FEATURES = Object.freeze(["needs_recovery"]);
export type FilesystemCheckMode = "normal" | "full-read-only";
export type VolumeFilesystemState = "unformatted" | "formatting" | "probing" | "ready" | "recovery-required";
interface TargetScope {
  volumeId: string; creationId: string; purpose: VolumePurpose; identity: VolumeFileIdentity;
  capacityBytes: number; sectorBytes: 512; filesystemBlockBytes: 4096; expectedFilesystemUUID: string;
}
interface LegacyTarget extends TargetScope { action: "format-new" | "probe-existing" }
export interface VolumeFilesystemTarget extends TargetScope {
  action: "format-new" | "probe-existing" | "replay-journal-then-probe";
  readyOperationId: string | null;
}
interface Scope { operationId: string; homeId: string; workspaceId: string; owner: CoworkVolumeOwner }
interface Contract { virginZeroProvenance: "new-sparse-creation"; ext4Features: string[]; requiredMountOptions: string[]; checkMode: FilesystemCheckMode }
export interface FilesystemReplayDebt { operationId: string; owner: CoworkVolumeOwner }
/** Protected writable journal-replay permission, distinct from a tool effect or full repair. */
export interface VolumeFilesystemPlan extends Scope, Contract {
  protocolVersion: 3; volumes: VolumeFilesystemTarget[]; priorReplay: FilesystemReplayDebt | null;
}
interface V2Plan extends Scope, Contract { protocolVersion: 2; volumes: LegacyTarget[] }
interface LegacyPlan extends Scope { protocolVersion: 1; volumes: LegacyTarget[] }
type Observation<T> = T & { filesystemType: "ext4"; filesystemUUID: string; flushConfirmed: true; checked: true };
export interface VolumeFilesystemReceipt extends Omit<VolumeFilesystemPlan, "volumes"> {
  volumes: (Observation<VolumeFilesystemTarget> & { filesystemFeatures: string[]; transientFilesystemFeatures: string[]; fullReadOnlyCheck: boolean; journalReplayed: boolean })[];
}
interface V2Receipt extends Omit<V2Plan, "volumes"> { volumes: (Observation<LegacyTarget> & { filesystemFeatures: string[]; transientFilesystemFeatures?: string[]; fullReadOnlyCheck: boolean })[] }
interface LegacyReceipt extends Omit<LegacyPlan, "volumes"> { volumes: Observation<LegacyTarget>[] }
export type RecordedFilesystemPlan = VolumeFilesystemPlan | V2Plan | LegacyPlan;
export type RecordedFilesystemReceipt = VolumeFilesystemReceipt | V2Receipt | LegacyReceipt;
export interface FilesystemReadyHistory { plan: RecordedFilesystemPlan; receipt: RecordedFilesystemReceipt }
/** Bounded last-ready history plus one uncertain/authorized replay tuple; never another owner ledger. */
export interface VolumeFilesystemJournal { plan: RecordedFilesystemPlan; receipt?: RecordedFilesystemReceipt; previousReady?: FilesystemReadyHistory; replayDebt?: FilesystemReplayDebt }
export interface CoworkVolumeFilesystemAuthority {
  authorize(request: CoworkVolumeRequest, homeId: string, volumes: readonly CoworkVolumeRecord[], checkMode: FilesystemCheckMode): boolean;
  /** Mandatory current native writable authority for this exact journal-only plan. Missing denies. */
  authorizeJournalReplay?(request: CoworkVolumeRequest, plan: Readonly<VolumeFilesystemPlan>, volumes: readonly CoworkVolumeRecord[]): boolean;
  /** Actual old writer/guest termination, not PID disappearance/JSON/EOF. New owner required. */
  verifyPreviousReplayStopped?(request: CoworkVolumeRequest, homeId: string, debt: Readonly<FilesystemReplayDebt>, volumes: readonly CoworkVolumeRecord[]): boolean;
  verifyReceipt(request: CoworkVolumeRequest, plan: Readonly<VolumeFilesystemPlan>, receipt: Readonly<VolumeFilesystemReceipt>, proof: unknown): boolean;
}
export const filesystemUUID = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const closed = (value: unknown, keys: string): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys.split(" ").sort().join(",");
const token = (value: unknown): boolean => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const sameList = (value: unknown, expected: readonly string[]): boolean => Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
const exact = (a: unknown, b: Record<string, unknown>): boolean => !!a && typeof a === "object" && Object.keys(a).sort().join(",") === Object.keys(b).sort().join(",") && Object.keys(b).every(k => (a as Record<string, unknown>)[k] === b[k]);
function owner(value: unknown): boolean {
  return closed(value, "controllerInstanceId workerInstanceId incarnationId leaseEpoch runtimeImageDigest") && [value.controllerInstanceId, value.workerInstanceId, value.incarnationId].every(token) && Number.isSafeInteger(value.leaseEpoch) && value.leaseEpoch > 0 && typeof value.runtimeImageDigest === "string" && /^[a-f0-9]{64}$/.test(value.runtimeImageDigest);
}
export function validReplayDebt(value: unknown): value is FilesystemReplayDebt { return closed(value, "operationId owner") && token(value.operationId) && owner(value.owner); }
export function sameReplayDebt(a: FilesystemReplayDebt | null | undefined, b: FilesystemReplayDebt | null | undefined): boolean {
  return !a || !b ? !a && !b : a.operationId === b.operationId && exact(a.owner, { ...b.owner });
}
export function validFilesystemPlan(value: unknown): value is RecordedFilesystemPlan {
  if (!value || typeof value !== "object") return false;
  const version = (value as any).protocolVersion;
  if (!closed(value, "protocolVersion operationId homeId workspaceId owner volumes" + (version >= 2 ? " virginZeroProvenance ext4Features requiredMountOptions checkMode" : "") + (version === 3 ? " priorReplay" : "")) || ![1, 2, 3].includes(version) || ![value.operationId, value.homeId, value.workspaceId].every(token) || !owner(value.owner) || !Array.isArray(value.volumes) || value.volumes.length !== 2) return false;
  if (version >= 2 && (value.virginZeroProvenance !== "new-sparse-creation" || !sameList(value.ext4Features, COWORK_EXT4_FEATURES) || !sameList(value.requiredMountOptions, COWORK_EXT4_MOUNT_OPTIONS) || !["normal", "full-read-only"].includes(value.checkMode))) return false;
  if (version === 3 && value.priorReplay !== null && (!validReplayDebt(value.priorReplay) || value.priorReplay.operationId === value.operationId || exact(value.priorReplay.owner, value.owner))) return false;
  if (!value.volumes.every((target: unknown, index: number) => {
    if (!closed(target, "volumeId creationId purpose identity capacityBytes sectorBytes filesystemBlockBytes expectedFilesystemUUID action" + (version === 3 ? " readyOperationId" : "")) || ![target.volumeId, target.creationId].every(token) || target.purpose !== ["data", "environment"][index] || !(version === 3 ? ["format-new", "probe-existing", "replay-journal-then-probe"] : ["format-new", "probe-existing"]).includes(target.action) || !Number.isSafeInteger(target.capacityBytes) || target.capacityBytes < 16777216 || target.capacityBytes > 274877906944 || target.capacityBytes % 4096 !== 0 || target.sectorBytes !== 512 || target.filesystemBlockBytes !== 4096 || !filesystemUUID(target.expectedFilesystemUUID) || !closed(target.identity, "device inode uid mode") || ![target.identity.device, target.identity.inode].every(v => typeof v === "string" && /^[0-9]{1,30}$/.test(v)) || !Number.isSafeInteger(target.identity.uid) || target.identity.uid < 0 || target.identity.uid > 4294967295 || target.identity.mode !== 384) return false;
    if (version === 3 && (target.action === "format-new" ? target.readyOperationId !== null : !token(target.readyOperationId))) return false;
    return target.action !== "replay-journal-then-probe" || value.checkMode === "normal";
  })) return false;
  if (version === 3 && value.priorReplay && value.volumes.some((v: Record<string, any>) => v.action === "format-new")) return false;
  const [a, b] = value.volumes;
  return a.volumeId !== b.volumeId && a.creationId !== b.creationId && a.expectedFilesystemUUID !== b.expectedFilesystemUUID && (a.identity.device !== b.identity.device || a.identity.inode !== b.identity.inode);
}
export function matchesFilesystemReceipt(plan: RecordedFilesystemPlan, receipt: RecordedFilesystemReceipt, allowLegacyV2Observation = false): boolean {
  if (!validFilesystemPlan(plan) || !closed(receipt, Object.keys(plan).join(" ")) || receipt.protocolVersion !== plan.protocolVersion || receipt.operationId !== plan.operationId || receipt.homeId !== plan.homeId || receipt.workspaceId !== plan.workspaceId || !exact(receipt.owner, { ...plan.owner }) || !Array.isArray(receipt.volumes) || receipt.volumes.length !== 2) return false;
  if (plan.protocolVersion !== 1 && (receipt.protocolVersion === 1 || receipt.virginZeroProvenance !== plan.virginZeroProvenance || !sameList(receipt.ext4Features, plan.ext4Features) || !sameList(receipt.requiredMountOptions, plan.requiredMountOptions) || receipt.checkMode !== plan.checkMode)) return false;
  if (plan.protocolVersion === 3 && (receipt.protocolVersion !== 3 || !sameReplayDebt(receipt.priorReplay, plan.priorReplay))) return false;
  return plan.volumes.every((expected, index) => {
    const actual: unknown = receipt.volumes[index];
    const keys = Object.keys(expected).join(" ") + " filesystemType filesystemUUID flushConfirmed checked" + (plan.protocolVersion >= 2 ? " filesystemFeatures fullReadOnlyCheck" : "");
    const legacy = closed(actual, keys), transient = closed(actual, keys + " transientFilesystemFeatures"), replay = closed(actual, keys + " transientFilesystemFeatures journalReplayed");
    if (!(plan.protocolVersion === 1 ? legacy : plan.protocolVersion === 2 ? transient || (allowLegacyV2Observation && legacy) : replay)) return false;
    const observed = actual as Record<string, any>;
    if ((transient || replay) && !(sameList(observed.transientFilesystemFeatures, []) || sameList(observed.transientFilesystemFeatures, COWORK_EXT4_TRANSIENT_FEATURES))) return false;
    if (replay && (typeof observed.journalReplayed !== "boolean" || (observed.journalReplayed && expected.action !== "replay-journal-then-probe"))) return false;
    return Object.keys(expected).every(key => key === "identity" ? exact(observed.identity, { ...expected.identity }) : observed[key] === expected[key as keyof typeof expected]) && observed.filesystemType === "ext4" && observed.filesystemUUID === expected.expectedFilesystemUUID && observed.flushConfirmed === true && observed.checked === true && (plan.protocolVersion === 1 || (sameList(observed.filesystemFeatures, plan.ext4Features) && observed.fullReadOnlyCheck === (plan.checkMode === "full-read-only")));
  });
}
export function filesystemReceiptNeedsRecovery(receipt: RecordedFilesystemReceipt): boolean {
  return receipt.protocolVersion >= 2 && receipt.volumes.some(v => "transientFilesystemFeatures" in v && Array.isArray(v.transientFilesystemFeatures) && v.transientFilesystemFeatures.length !== 0);
}
export function readyFilesystemHistory(journal: VolumeFilesystemJournal | null): FilesystemReadyHistory | undefined {
  if (journal?.receipt && matchesFilesystemReceipt(journal.plan, journal.receipt, true) && !filesystemReceiptNeedsRecovery(journal.receipt)) return { plan: journal.plan, receipt: journal.receipt };
  const previous = journal?.previousReady;
  return previous && matchesFilesystemReceipt(previous.plan, previous.receipt, true) && !filesystemReceiptNeedsRecovery(previous.receipt) ? previous : undefined;
}
