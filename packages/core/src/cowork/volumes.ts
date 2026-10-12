import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, ftruncateSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimeStateDb } from "../runtime-state/db";
import { AT_FDCWD, closeFd, createFileAt, mkdirAt, openDirAt, openImageAt } from "./volume-fs";
import { COWORK_EXT4_FEATURES, COWORK_EXT4_MOUNT_OPTIONS, filesystemUUID, validFilesystemPlan, matchesFilesystemReceipt, readyFilesystemHistory, type FilesystemCheckMode, type RecordedFilesystemPlan, type CoworkVolumeFilesystemAuthority, type VolumeFilesystemState, type VolumeFilesystemJournal, type VolumeFilesystemPlan, type VolumeFilesystemReceipt } from "./volume-filesystem";
import { timeMachineVolumeBackup, type CoworkVolumeBackup } from "./volume-backup";

export const RAW_VOLUME_FORMAT = "raw-ext4-v1" as const;
export const RAW_VOLUME_MAX_BYTES = 256 * 1024 ** 3;
export const RAW_VOLUME_MIN_BYTES = 16 * 1024 ** 2;
export type VolumePurpose = "data" | "environment";
export interface VolumeFileIdentity { device: string; inode: string; uid: number; mode: number }
/** No PID lease. Actual native admission authenticates these identities and binds them to its channel. */
export interface CoworkVolumeOwner {
  controllerInstanceId: string; workerInstanceId: string; incarnationId: string; leaseEpoch: number; runtimeImageDigest: string;
}
export interface CoworkVolumeRequest { workspaceId: string; owner: CoworkVolumeOwner; proof: unknown }
export interface CoworkVolumeStop { confirmationId: string; proof: unknown }
export interface CoworkVolumeRecord {
  volumeId: string; homeId: string; workspaceId: string; creationId: string; purpose: VolumePurpose;
  format: typeof RAW_VOLUME_FORMAT; formatVersion: 1; capacityBytes: number; sectorBytes: 512; filesystemBlockBytes: 4096;
  state: "planned" | "creating" | "allocated"; filesystemState: VolumeFilesystemState; filesystemUUID: string | null; formatEligible: boolean; filesystemJournal: VolumeFilesystemJournal | null;
  identity: VolumeFileIdentity | null; owner: CoworkVolumeOwner | null; lastStopId: string | null;
  createdAt: string; updatedAt: string;
}
export interface CoworkVolumeAuthority {
  /** Current authenticated controller, canonical home registration, workspace grant and incarnation
   * checks belong here. Mandatory injection; local paths, manifest bytes and worker PIDs are insufficient. */
  authorize(action: "allocate" | "claim" | "open" | "release", request: CoworkVolumeRequest, homeId: string): boolean;
  /** Protected native stop evidence for this exact previous owner and both disks. Never PID liveness. */
  verifyStopped(request: CoworkVolumeRequest, stop: CoworkVolumeStop, volumes: readonly CoworkVolumeRecord[]): boolean;
}
export type VolumeFailure = "invalid_request" | "authority_denied" | "not_found" | "unknown_format" | "recovery_required" | "volume_busy" | "stop_unconfirmed" | "backup_exclusion_unavailable" | "filesystem_compatibility_required";
export class CoworkVolumeError extends Error {
  constructor(readonly code: VolumeFailure) { super(code); this.name = "CoworkVolumeError"; }
}
type Row = Record<string, any>;
interface CheckedVolume { volume: CoworkVolumeRecord; fd: number; close(): void }
function fail(code: VolumeFailure): never { throw new CoworkVolumeError(code); }
const token = (value: unknown): string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : fail("invalid_request");
function owner(value: CoworkVolumeOwner): CoworkVolumeOwner {
  if (!value || !Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch < 1 || !/^[a-f0-9]{64}$/.test(value.runtimeImageDigest)) fail("invalid_request");
  return { controllerInstanceId: token(value.controllerInstanceId), workerInstanceId: token(value.workerInstanceId), incarnationId: token(value.incarnationId), leaseEpoch: value.leaseEpoch, runtimeImageDigest: value.runtimeImageDigest };
}
const sameOwner = (a: CoworkVolumeOwner | null, b: CoworkVolumeOwner) => a !== null && JSON.stringify(owner(a)) === JSON.stringify(owner(b));
const sameIdentity = (a: VolumeFileIdentity, b: VolumeFileIdentity) => a.device === b.device && a.inode === b.inode && a.uid === b.uid && a.mode === b.mode;
const filename = (purpose: VolumePurpose): "data.ext4" | "env.ext4" => purpose === "data" ? "data.ext4" : purpose === "environment" ? "env.ext4" : fail("invalid_request");
function identity(fd: number, kind: "directory" | "image"): VolumeFileIdentity {
  const st = fstatSync(fd, { bigint: true }), mode = Number(st.mode & 0o7777n), uid = Number(st.uid);
  if ((kind === "directory" ? !st.isDirectory() : !st.isFile() || st.nlink !== 1n) || uid !== process.geteuid?.() || mode !== (kind === "directory" ? 0o700 : 0o600)) fail("recovery_required");
  return { device: String(st.dev), inode: String(st.ino), uid, mode };
}
function record(row: Row): CoworkVolumeRecord {
  if (row.format !== RAW_VOLUME_FORMAT || row.format_version !== 1) fail("unknown_format");
  if (!["data", "environment"].includes(row.purpose) || !["planned", "creating", "allocated"].includes(row.state) || !["unformatted", "formatting", "probing", "ready", "recovery-required"].includes(row.filesystem_state) || row.sector_bytes !== 512 || row.filesystem_block_bytes !== 4096) fail("recovery_required");
  geometry(row.capacity_bytes);
  if ((row.filesystem_uuid !== null && !filesystemUUID(row.filesystem_uuid)) || ![0, 1].includes(row.format_eligible) || (row.format_eligible === 1 && (row.filesystem_state !== "unformatted" || !row.filesystem_uuid))) fail("recovery_required");
  let journal: VolumeFilesystemJournal | null = null;
  try { if (row.filesystem_journal_json !== null && (typeof row.filesystem_journal_json !== "string" || Buffer.byteLength(row.filesystem_journal_json) > 16384)) fail("recovery_required"); journal = row.filesystem_journal_json === null ? null : JSON.parse(row.filesystem_journal_json); if (journal && !validFilesystemPlan(journal.plan)) fail("recovery_required"); } catch { fail("recovery_required"); }
  if (["formatting", "probing", "ready"].includes(row.filesystem_state) && (!journal || !row.filesystem_uuid)) fail("recovery_required");
  if (row.filesystem_state === "ready" && !readyFilesystemHistory(journal)) fail("recovery_required");
  const observed = row.device === null ? null : { device: row.device, inode: row.inode, uid: row.uid, mode: row.mode };
  if ((observed === null && [row.inode, row.uid, row.mode].some(v => v !== null)) || (observed && (typeof observed.device !== "string" || typeof observed.inode !== "string" || observed.uid !== process.geteuid?.() || observed.mode !== 0o600))) fail("recovery_required");
  const history = readyFilesystemHistory(journal), historyTarget = history?.plan.volumes.find(v => v.purpose === row.purpose);
  if (history && (!historyTarget || history.plan.homeId !== row.home_id || history.plan.workspaceId !== row.workspace_id || historyTarget.volumeId !== row.volume_id || historyTarget.creationId !== row.creation_id || historyTarget.expectedFilesystemUUID !== row.filesystem_uuid || historyTarget.capacityBytes !== row.capacity_bytes || historyTarget.sectorBytes !== row.sector_bytes || historyTarget.filesystemBlockBytes !== row.filesystem_block_bytes || !observed || !sameIdentity(historyTarget.identity, observed))) fail("recovery_required");
  let recordedOwner: CoworkVolumeOwner | null = null;
  try { recordedOwner = row.owner_json === null ? null : owner(JSON.parse(row.owner_json)); } catch { fail("recovery_required"); }
  if ((row.state === "allocated" && !observed) || (row.state === "planned" && observed !== null)) fail("recovery_required");
  return { volumeId: token(row.volume_id), homeId: token(row.home_id), workspaceId: token(row.workspace_id), creationId: token(row.creation_id), purpose: row.purpose,
    format: RAW_VOLUME_FORMAT, formatVersion: 1, capacityBytes: row.capacity_bytes, sectorBytes: 512, filesystemBlockBytes: 4096,
    state: row.state, filesystemState: row.filesystem_state, filesystemUUID: row.filesystem_uuid, formatEligible: row.format_eligible === 1, filesystemJournal: journal, identity: observed, owner: recordedOwner, lastStopId: row.last_stop_id, createdAt: row.created_at, updatedAt: row.updated_at };
}
function geometry(value: number): number {
  if (!Number.isSafeInteger(value) || value < RAW_VOLUME_MIN_BYTES || value > RAW_VOLUME_MAX_BYTES || value % 4096 !== 0) fail("invalid_request");
  return value;
}

/** Trusted host primitive, deliberately absent from user/agent RPCs. It creates sparse unformatted
 * backing images only. No formatter, VM, guest ACK, credentials, keys or availability switch. */
export class CoworkVolumes {
  private readonly home: string;
  private readonly handles = new Map<string, number>();
  constructor(private readonly rs: RuntimeStateDb, home: string, private readonly authority: CoworkVolumeAuthority,
    private readonly backup: CoworkVolumeBackup = timeMachineVolumeBackup,
    /** Isolated crash/fault testing only, never serialized or supplied by an RPC. */
    private readonly checkpoint: (phase: string) => void = () => {},
    /** Absent means refusal, never a ready boolean or guest-ACK fallback. */
    private readonly filesystemAuthority?: CoworkVolumeFilesystemAuthority) {
    this.home = realpathSync(home);
    if (resolve(rs.path) !== join(resolve(home), "runtimes", "runtime-state.db")) fail("authority_denied");
  }
  private one(sql: string, ...args: any[]): Row | null { return this.rs.db.query<Row, any[]>(sql).get(...args); }
  private run(sql: string, ...args: any[]) { return this.rs.db.run(sql, args); }
  private admit(action: "allocate" | "claim" | "open" | "release", input: CoworkVolumeRequest): { request: CoworkVolumeRequest; homeId: string } {
    const request = { workspaceId: token(input.workspaceId), owner: owner(input.owner), proof: input.proof };
    const home = this.one("SELECT home_id FROM cowork_home_identity WHERE singleton=1");
    const workspace = this.one("SELECT * FROM cowork_workspaces WHERE workspace_id=?", request.workspaceId);
    if (!workspace) fail("not_found");
    if (!home || workspace.state !== "retained") fail("authority_denied");
    const homeId = token(home.home_id);
    if (this.authority.authorize(action, request, homeId) !== true) fail("authority_denied");
    let homeFd = -1;
    try {
      homeFd = openDirAt(AT_FDCWD, this.home);
      const current = identity(homeFd, "directory"), recorded = this.one("SELECT * FROM cowork_volume_directories WHERE relative_path='.'");
      if (recorded && (recorded.state !== "created" || !sameIdentity(current, { device: recorded.device, inode: recorded.inode, uid: recorded.uid, mode: recorded.mode }))) fail("recovery_required");
    } catch (error) { if (error instanceof CoworkVolumeError) throw error; fail("recovery_required"); }
    finally { closeFd(homeFd); }
    return { request, homeId };
  }
  records(workspaceId: string): CoworkVolumeRecord[] {
    return this.rs.db.query<Row, [string]>("SELECT * FROM cowork_volumes WHERE workspace_id=? ORDER BY purpose").all(token(workspaceId)).map(record);
  }
  /** Directory descriptors pin the checked chain. New names use mkdirat/O_EXCL, never recursive mkdir
   * or path-based file opens. A crash before a newly created directory's identity commit fails closed. */
  private directories(workspaceId: string, create: boolean): number[] {
    const descriptors: number[] = [];
    try {
      descriptors.push(openDirAt(AT_FDCWD, this.home));
      this.directoryIdentity(".", descriptors[0]!, false, create);
      let relative = "";
      for (const name of ["cowork", "workspaces", token(workspaceId)]) {
        relative = relative ? `${relative}/${name}` : name;
        let row = this.one("SELECT * FROM cowork_volume_directories WHERE relative_path=?", relative);
        let created = false;
        if (!row) {
          if (!create) fail("recovery_required");
          this.run("INSERT INTO cowork_volume_directories(relative_path,state) VALUES(?,'planned')", relative);
          row = this.one("SELECT * FROM cowork_volume_directories WHERE relative_path=?", relative);
          created = mkdirAt(descriptors.at(-1)!, name, 0o700);
          // Parent/shared roots may already exist before image provisioning. Never enroll an
          // existing workspace image directory: unknown backing data requires explicit recovery.
          if (!created && name === workspaceId) fail("recovery_required");
          fsyncSync(descriptors.at(-1)!);
          this.checkpoint("directory-created");
        } else if (row.state === "planned") fail("recovery_required");
        const fd = openDirAt(descriptors.at(-1)!, name); descriptors.push(fd);
        this.directoryIdentity(relative, fd, created, create, name !== workspaceId);
      }
      return descriptors;
    } catch (error) { descriptors.forEach(closeFd); if (error instanceof CoworkVolumeError) throw error; fail("recovery_required"); }
  }
  private directoryIdentity(relative: string, fd: number, created: boolean, create: boolean, sharedRoot = false): void {
    const current = identity(fd, "directory"), row = this.one("SELECT * FROM cowork_volume_directories WHERE relative_path=?", relative);
    if (!row) {
      if (!create || relative !== ".") fail("recovery_required");
      this.run("INSERT INTO cowork_volume_directories VALUES(?,'created',?,?,?,?)", relative, current.device, current.inode, current.uid, current.mode);
    } else if (row.state === "planned" && (created || sharedRoot)) {
      this.run("UPDATE cowork_volume_directories SET state='created',device=?,inode=?,uid=?,mode=? WHERE relative_path=?", current.device, current.inode, current.uid, current.mode, relative);
    } else if (row.state !== "created" || !sameIdentity(current, { device: row.device, inode: row.inode, uid: row.uid, mode: row.mode })) fail("recovery_required");
  }
  private validate(fd: number, volume: CoworkVolumeRecord, sizes: readonly number[] = [volume.capacityBytes]): void {
    if (!volume.identity || !sameIdentity(identity(fd, "image"), volume.identity) || !sizes.includes(Number(fstatSync(fd, { bigint: true }).size))) fail("recovery_required");
  }
  /** Rewalk by descriptor and compare to the pinned image around backup's required named-item API. */
  private verifyNamed(volume: CoworkVolumeRecord): void {
    const dirs = this.directories(volume.workspaceId, false); let fd = -1;
    try { fd = openImageAt(dirs.at(-1)!, filename(volume.purpose)); this.validate(fd, volume, volume.state === "creating" ? [0, volume.capacityBytes] : [volume.capacityBytes]); }
    catch (error) { if (error instanceof CoworkVolumeError) throw error; fail("recovery_required"); }
    finally { closeFd(fd); dirs.forEach(closeFd); }
  }
  private exclude(volume: CoworkVolumeRecord, fd: number, apply: boolean): void {
    if (this.rs.db.inTransaction) fail("invalid_request");
    const path = join(this.home, "cowork", "workspaces", volume.workspaceId, filename(volume.purpose));
    this.verifyNamed(volume);
    try {
      if (apply) this.backup.excludeItem(path, fd);
      if (this.backup.verifyItemExcluded(path, fd) !== true) fail("backup_exclusion_unavailable");
    } catch (error) { if (error instanceof CoworkVolumeError) throw error; fail("backup_exclusion_unavailable"); }
    this.verifyNamed(volume);
    this.validateDescriptor(volume, fd, volume.state === "creating" ? [0, volume.capacityBytes] : [volume.capacityBytes]);
  }
  /** Transaction-safe checks: only pinned metadata/identity and descriptor-relative directory I/O.
   * tmutil cross-checks have already completed outside the writer lock. */
  private validateDescriptor(volume: CoworkVolumeRecord, fd: number, sizes: readonly number[] = [volume.capacityBytes]): void {
    this.validate(fd, volume, sizes);
    try { if (this.backup.verifyDescriptorExcluded(fd) !== true) fail("backup_exclusion_unavailable"); }
    catch (error) { if (error instanceof CoworkVolumeError) throw error; fail("backup_exclusion_unavailable"); }
  }
  private revalidateChecked(volume: CoworkVolumeRecord, checked: readonly CheckedVolume[]): void {
    const pinned = checked.find(v => v.volume.volumeId === volume.volumeId);
    if (!pinned || pinned.volume.creationId !== volume.creationId || pinned.volume.homeId !== volume.homeId || pinned.volume.workspaceId !== volume.workspaceId || pinned.volume.purpose !== volume.purpose || volume.state !== "allocated") fail("recovery_required");
    this.verifyNamed(volume);
    this.validateDescriptor(volume, pinned.fd);
  }
  private prepareChecked(volumes: readonly CoworkVolumeRecord[]): CheckedVolume[] {
    const checked: CheckedVolume[] = [];
    try {
      for (const volume of volumes) checked.push({ volume, ...this.openChecked(volume) });
      return checked;
    } catch (error) { checked.forEach(v => v.close()); throw error; }
  }
  /** Durable allocation intent only; no files are created by this method. Geometries are immutable.
   * Previously allocated images must still match their identity/modes/exclusion on re-admission. */
  plan(input: CoworkVolumeRequest, capacities: { data: number; environment: number }): CoworkVolumeRecord[] {
    if (this.rs.db.inTransaction) fail("invalid_request");
    const data = geometry(capacities.data), environment = geometry(capacities.environment);
    const { request: admitted } = this.admit("allocate", input);
    const checked = this.prepareChecked(this.records(admitted.workspaceId).filter(v => v.state === "allocated"));
    try {
      return this.rs.transaction(() => {
        const { request, homeId } = this.admit("allocate", input);
        for (const existing of this.records(request.workspaceId)) {
          if (existing.state === "allocated") this.revalidateChecked(existing, checked);
        }
        this.planRecords(request.workspaceId, homeId, data, environment);
        return this.records(request.workspaceId);
      }, { mode: "immediate" });
    } finally { checked.forEach(v => v.close()); }
  }
  private planRecords(workspaceId: string, homeId: string, data: number, environment: number): void {
    for (const purpose of ["data", "environment"] as const) {
      const prior = this.one("SELECT * FROM cowork_volumes WHERE workspace_id=? AND purpose=?", workspaceId, purpose);
      if (prior) { const v = record(prior); if (v.homeId !== homeId || v.capacityBytes !== (purpose === "data" ? data : environment)) fail("invalid_request"); continue; }
      const at = new Date().toISOString();
      this.run("INSERT INTO cowork_volumes(volume_id,home_id,workspace_id,creation_id,purpose,format,format_version,capacity_bytes,sector_bytes,filesystem_block_bytes,state,filesystem_state,filesystem_uuid,format_eligible,created_at,updated_at) VALUES(?,?,?,?,?,'raw-ext4-v1',1,?,512,4096,'planned','unformatted',?,1,?,?)", `volume_${randomUUID()}`, homeId, workspaceId, `creation_${randomUUID()}`, purpose, purpose === "data" ? data : environment, randomUUID(), at, at);
    }
  }
  /** Plan commits before any image effect. Convenience entry for a trusted controller. */
  allocate(input: CoworkVolumeRequest, capacities: { data: number; environment: number }): CoworkVolumeRecord[] {
    if (this.rs.db.inTransaction) fail("invalid_request");
    this.plan(input, capacities); return this.materialize(input);
  }
  /** Bounded sparse allocation effect after the durable plan. Retry resumes only the exact recorded
   * virgin creation/inode; zero or final size are the recoverable ftruncate boundaries. Unknown files
   * are never truncated/replaced. Trusted caller explicitly controls this stage. */
  materialize(input: CoworkVolumeRequest): CoworkVolumeRecord[] {
    if (this.rs.db.inTransaction) fail("invalid_request");
    const { request, homeId } = this.admit("allocate", input);
    const volumes = this.records(request.workspaceId);
    if (volumes.length !== 2 || volumes.some(v => v.homeId !== homeId || v.owner !== null)) fail("volume_busy");
    const dirs = this.directories(request.workspaceId, true);
    try {
      for (let volume of volumes) {
        let fd = -1;
        try {
          if (volume.state === "planned") {
            this.rs.transaction(() => { if (this.run("UPDATE cowork_volumes SET state='creating' WHERE volume_id=? AND state='planned'", volume.volumeId).changes !== 1) fail("recovery_required"); }, { mode: "immediate" });
            this.checkpoint("creation-intent");
            fd = createFileAt(dirs.at(-1)!, filename(volume.purpose), 0o600);
            const observed = identity(fd, "image"); fsyncSync(fd); fsyncSync(dirs.at(-1)!);
            this.checkpoint("image-created");
            this.rs.transaction(() => { this.run("UPDATE cowork_volumes SET device=?,inode=?,uid=?,mode=? WHERE volume_id=? AND state='creating'", observed.device, observed.inode, observed.uid, observed.mode, volume.volumeId); }, { mode: "immediate" });
            volume = this.records(request.workspaceId).find(v => v.volumeId === volume.volumeId)!;
          } else {
            if (!volume.identity) fail("recovery_required");
            fd = openImageAt(dirs.at(-1)!, filename(volume.purpose));
            this.validate(fd, volume, volume.state === "creating" ? [0, volume.capacityBytes] : [volume.capacityBytes]);
          }
          this.exclude(volume, fd, volume.state === "creating");
          this.checkpoint("backup-excluded");
          if (volume.state === "creating") {
            // No guest has received the image; only this recorded virgin creation can be resized.
            this.rs.transaction(() => {
              const current = this.records(request.workspaceId).find(v => v.volumeId === volume.volumeId)!;
              if (current.owner || current.state !== "creating") fail("volume_busy");
              this.verifyNamed(current); this.validateDescriptor(current, fd, [0, current.capacityBytes]);
              ftruncateSync(fd, volume.capacityBytes); fsyncSync(fd);
              this.checkpoint("image-sized"); this.validateDescriptor(volume, fd);
              this.run("UPDATE cowork_volumes SET state='allocated',updated_at=? WHERE volume_id=? AND state='creating'", new Date().toISOString(), volume.volumeId);
            }, { mode: "immediate" });
          }
        } catch (error) { if (error instanceof CoworkVolumeError) throw error; fail("recovery_required"); }
        finally { if (fd >= 0) closeSync(fd); }
      }
    } finally { dirs.forEach(closeFd); }
    return this.records(request.workspaceId);
  }
  /** Claim both images atomically before native launch. File validation/exclusion is repeated on every
   * claim/open. Owner persists across close, daemon death and uncertain worker termination.
   * Caller-owned transactions refuse before effects: a nested savepoint is not a durable claim. */
  claim(input: CoworkVolumeRequest): CoworkVolumeRecord[] {
    if (this.rs.db.inTransaction) fail("invalid_request");
    const validateClaim = (request: CoworkVolumeRequest, homeId: string, volumes: CoworkVolumeRecord[]) => {
      if (volumes.length !== 2) fail("recovery_required");
      for (const volume of volumes) {
        if (volume.homeId !== homeId || volume.state !== "allocated") fail("recovery_required");
        if (volume.owner && !sameOwner(volume.owner, request.owner)) fail("volume_busy");
      }
    };
    const admitted = this.admit("claim", input), prior = this.records(admitted.request.workspaceId);
    validateClaim(admitted.request, admitted.homeId, prior);
    const checked = this.prepareChecked(prior);
    try {
      return this.rs.transaction(() => {
        const { request, homeId } = this.admit("claim", input), volumes = this.records(request.workspaceId);
        validateClaim(request, homeId, volumes);
        volumes.forEach(v => this.revalidateChecked(v, checked));
        this.run("UPDATE cowork_volumes SET owner_json=?,last_stop_id=NULL WHERE workspace_id=?", JSON.stringify(request.owner), request.workspaceId);
        return this.records(request.workspaceId);
      }, { mode: "immediate" });
    } finally { checked.forEach(v => v.close()); }
  }
  private openChecked(volume: CoworkVolumeRecord): { fd: number; close(): void } {
    const dirs = this.directories(volume.workspaceId, false); let fd = -1;
    try {
      fd = openImageAt(dirs.at(-1)!, filename(volume.purpose)); this.validate(fd, volume); this.exclude(volume, fd, false);
      const pinned = fd; let closed = false;
      return { fd, close: () => { if (!closed) { closed = true; closeSync(pinned); } } };
    } catch (error) { closeFd(fd); if (error instanceof CoworkVolumeError) throw error; fail("recovery_required"); }
    finally { dirs.forEach(closeFd); }
  }
  /** Returns a pinned O_CLOEXEC descriptor, never a raw-path grant. Native controller must transfer it
   * explicitly to its authenticated worker. Descriptor closure does not prove worker termination. */
  open(input: CoworkVolumeRequest, purpose: VolumePurpose): { volume: CoworkVolumeRecord; fd: number; close(): void } {
    if (this.rs.db.inTransaction) fail("invalid_request");
    const { request, homeId } = this.admit("open", input), prior = this.records(request.workspaceId).find(v => v.purpose === purpose);
    if (!prior) fail("not_found");
    if (prior.homeId !== homeId || prior.state !== "allocated" || !sameOwner(prior.owner, request.owner)) fail("volume_busy");
    const pending: CheckedVolume = { volume: prior, ...this.openChecked(prior) };
    let opened: { volume: CoworkVolumeRecord; handle: { fd: number; close(): void } };
    try {
      opened = this.rs.transaction(() => {
        const { request, homeId } = this.admit("open", input), volume = this.records(request.workspaceId).find(v => v.purpose === purpose);
        if (!volume) fail("not_found");
        if (volume.homeId !== homeId || volume.state !== "allocated" || !sameOwner(volume.owner, request.owner)) fail("volume_busy");
        this.revalidateChecked(volume, [pending]);
        // Any writable exposure outside a consumed format intent burns virgin eligibility.
        // Native integration must prepareFilesystems BEFORE attaching/transferring these FDs.
        if (volume.filesystemState === "unformatted") this.run("UPDATE cowork_volumes SET format_eligible=0,filesystem_state='recovery-required' WHERE volume_id=?", volume.volumeId);
        return { volume: this.records(request.workspaceId).find(v => v.volumeId === volume.volumeId)!, handle: pending };
      }, { mode: "immediate" });
    } catch (error) {
      // Transaction completion may fail after preflight opened an image. No local handle survives.
      pending.close(); throw error;
    }
    const { volume, handle } = opened; let closed = false;
    this.handles.set(volume.workspaceId, (this.handles.get(volume.workspaceId) ?? 0) + 1);
    return { volume, fd: handle.fd, close: () => {
      if (!closed) { closed = true; handle.close(); this.handles.set(volume.workspaceId, (this.handles.get(volume.workspaceId) ?? 1) - 1); }
    } };
  }
  /** Commit exact one-shot intent before descriptors reach a formatter. Repeated calls never
   * replay formatting. Read-only probe retries retain confirmed history and need a fresh
   * nonce/current admission; ambiguous format intent still requires explicit recovery. */
  prepareFilesystems(input: CoworkVolumeRequest, checkMode: FilesystemCheckMode = "normal"): VolumeFilesystemPlan {
    if (!["normal", "full-read-only"].includes(checkMode)) fail("invalid_request");
    if (this.rs.db.inTransaction) fail("invalid_request");
    if (!this.filesystemAuthority) fail("authority_denied");
    const admitted = this.admit("open", input), checked = this.prepareChecked(this.records(admitted.request.workspaceId));
    let plan: VolumeFilesystemPlan;
    try {
      plan = this.rs.transaction(() => {
        const { request, homeId } = this.admit("open", input), volumes = this.records(request.workspaceId);
        if (volumes.length !== 2 || volumes.some(v => !sameOwner(v.owner, request.owner))) fail("volume_busy");
        volumes.forEach(v => this.revalidateChecked(v, checked));
        if ((this.handles.get(request.workspaceId) ?? 0) !== 0 || this.filesystemAuthority!.authorize(request, homeId, volumes, checkMode) !== true) fail("authority_denied");
        // A read-only probe can be retried without destroying confirmed format history.
        // Legacy minimal-feature receipts cannot acquire the v2 sparse/noinit_itable contract.
        if (volumes.some(v => ["ready", "probing"].includes(v.filesystemState) && readyFilesystemHistory(v.filesystemJournal)?.plan.protocolVersion !== 2)) fail("filesystem_compatibility_required");
        if (volumes.some(v => !v.filesystemUUID || !(["ready", "probing"].includes(v.filesystemState) || (v.filesystemState === "unformatted" && v.formatEligible)))) fail("recovery_required");
        const intent: VolumeFilesystemPlan = { protocolVersion: 2, virginZeroProvenance: "new-sparse-creation", ext4Features: [...COWORK_EXT4_FEATURES], requiredMountOptions: [...COWORK_EXT4_MOUNT_OPTIONS], checkMode, operationId: `filesystem_${randomUUID()}`, homeId, workspaceId: request.workspaceId, owner: request.owner,
          volumes: volumes.map(v => ({ volumeId: v.volumeId, creationId: v.creationId, purpose: v.purpose, identity: v.identity!, capacityBytes: v.capacityBytes, sectorBytes: v.sectorBytes, filesystemBlockBytes: v.filesystemBlockBytes, expectedFilesystemUUID: v.filesystemUUID!, action: ["ready", "probing"].includes(v.filesystemState) ? "probe-existing" : "format-new" })) };
        for (const v of volumes) this.run("UPDATE cowork_volumes SET filesystem_state=?,format_eligible=0,filesystem_journal_json=?,updated_at=? WHERE volume_id=?", ["ready", "probing"].includes(v.filesystemState) ? "probing" : "formatting", JSON.stringify({ plan: intent, ...(readyFilesystemHistory(v.filesystemJournal) ? { previousReady: readyFilesystemHistory(v.filesystemJournal) } : {}) }), new Date().toISOString(), v.volumeId);
        return intent;
      }, { mode: "immediate" });
    } finally { checked.forEach(v => v.close()); }
    this.checkpoint("filesystem-intent-committed");
    return plan;
  }
  private currentFilesystemPlan(request: CoworkVolumeRequest, volumes: CoworkVolumeRecord[], operationId: string): RecordedFilesystemPlan {
    if (volumes.length !== 2 || volumes.some(v => !sameOwner(v.owner, request.owner))) fail("volume_busy");
    const plan = volumes[0]!.filesystemJournal?.plan;
    if (!plan || plan.operationId !== token(operationId) || plan.workspaceId !== request.workspaceId || JSON.stringify(plan.owner) !== JSON.stringify(request.owner) || volumes.some(v => JSON.stringify(v.filesystemJournal?.plan) !== JSON.stringify(plan))) fail("recovery_required");
    // Bind recorded plan to current canonical rows as well as its trusted receipt.
    if (plan.volumes.length !== 2 || plan.volumes.some((target, index) => {
      const volume = volumes[index]!;
      return target.volumeId !== volume.volumeId || target.creationId !== volume.creationId || target.purpose !== volume.purpose || target.expectedFilesystemUUID !== volume.filesystemUUID || target.capacityBytes !== volume.capacityBytes || target.sectorBytes !== volume.sectorBytes || target.filesystemBlockBytes !== volume.filesystemBlockBytes || volume.homeId !== plan.homeId || !volume.identity || !sameIdentity(target.identity, volume.identity);
    })) fail("recovery_required");
    return plan;
  }
  confirmFilesystems(input: CoworkVolumeRequest, receipt: VolumeFilesystemReceipt, proof: unknown): CoworkVolumeRecord[] {
    if (this.rs.db.inTransaction) fail("invalid_request");
    if (!this.filesystemAuthority) fail("authority_denied");
    if (!receipt || typeof receipt.operationId !== "string" || receipt.operationId.length > 160) fail("invalid_request");
    const admitted = this.admit("open", input), checked = this.prepareChecked(this.records(admitted.request.workspaceId));
    try {
      return this.rs.transaction(() => {
        const { request, homeId } = this.admit("open", input), volumes = this.records(request.workspaceId), plan = this.currentFilesystemPlan(request, volumes, receipt.operationId);
        volumes.forEach(v => this.revalidateChecked(v, checked));
        if (plan.protocolVersion !== 2) fail("filesystem_compatibility_required");
        if (volumes.some((v, index) => !["formatting", "probing"].includes(v.filesystemState) || plan.volumes[index]!.action !== (v.filesystemState === "formatting" ? "format-new" : "probe-existing"))) fail("recovery_required");
        if (plan.homeId !== homeId || !matchesFilesystemReceipt(plan, receipt) || this.filesystemAuthority!.authorize(request, homeId, volumes, plan.checkMode) !== true || this.filesystemAuthority!.verifyReceipt(request, plan, receipt, proof) !== true) fail("authority_denied");
        for (const v of volumes) this.run("UPDATE cowork_volumes SET filesystem_state='ready',filesystem_journal_json=?,updated_at=? WHERE volume_id=?", JSON.stringify({ plan, receipt }), new Date().toISOString(), v.volumeId);
        return this.records(request.workspaceId);
      }, { mode: "immediate" });
    } finally { checked.forEach(v => v.close()); }
  }
  /** Uncertainty narrows availability and never releases canonical disk ownership. */
  failFilesystems(input: CoworkVolumeRequest, operationId: string): void {
    if (this.rs.db.inTransaction) fail("invalid_request");
    this.rs.transaction(() => {
      const { request } = this.admit("open", input), volumes = this.records(request.workspaceId);
      const plan = this.currentFilesystemPlan(request, volumes, operationId);
      if (volumes.some(v => !["formatting", "probing"].includes(v.filesystemState))) fail("recovery_required");
      for (const [index, volume] of volumes.entries()) {
        const wasFormat = plan.volumes[index]!.action === "format-new";
        const state = wasFormat ? "recovery-required" : readyFilesystemHistory(volume.filesystemJournal) ? "ready" : "probing";
        this.run("UPDATE cowork_volumes SET filesystem_state=?,format_eligible=0,updated_at=? WHERE volume_id=?", state, new Date().toISOString(), volume.volumeId);
      }
    }, { mode: "immediate" });
  }
  /** A prior owner's ready record is not readiness for a fresh incarnation. */
  filesystemsReady(input: CoworkVolumeRequest): boolean {
    if (this.rs.db.inTransaction || !this.filesystemAuthority) return false;
    const { request, homeId } = this.admit("open", input), volumes = this.records(request.workspaceId);
    if (volumes.length !== 2 || volumes.some(v => v.filesystemState !== "ready" || v.filesystemJournal?.plan.protocolVersion !== 2 || !sameOwner(v.owner, request.owner) || !sameOwner(v.filesystemJournal?.plan.owner ?? null, request.owner))) return false;
    const plan = this.currentFilesystemPlan(request, volumes, volumes[0]!.filesystemJournal!.plan.operationId), receipt = volumes[0]!.filesystemJournal?.receipt;
    if (plan.protocolVersion !== 2 || !receipt || plan.homeId !== homeId || !matchesFilesystemReceipt(plan, receipt) || volumes.some(v => JSON.stringify(v.filesystemJournal?.receipt) !== JSON.stringify(receipt))) return false;
    const checked = this.prepareChecked(volumes);
    try { return this.rs.transaction(() => {
      const admitted = this.admit("open", input), current = this.records(request.workspaceId);
      current.forEach(v => this.revalidateChecked(v, checked));
      if (JSON.stringify(current.map(v => v.filesystemJournal)) !== JSON.stringify(volumes.map(v => v.filesystemJournal)) || current.some(v => v.filesystemState !== "ready" || !sameOwner(v.owner, request.owner))) return false;
      return this.filesystemAuthority!.authorize(admitted.request, admitted.homeId, current, plan.checkMode) === true;
    }, { mode: "immediate" }); } finally { checked.forEach(v => v.close()); }
  }
  release(input: CoworkVolumeRequest, stop: CoworkVolumeStop): void {
    if (this.rs.db.inTransaction) fail("invalid_request");
    token(stop.confirmationId);
    const validateRelease = (request: CoworkVolumeRequest, volumes: CoworkVolumeRecord[]) => {
      if ((this.handles.get(request.workspaceId) ?? 0) > 0) fail("stop_unconfirmed");
      if (volumes.length !== 2 || volumes.some(v => !sameOwner(v.owner, request.owner))) fail("volume_busy");
    };
    const { request: admitted } = this.admit("release", input), prior = this.records(admitted.workspaceId);
    validateRelease(admitted, prior);
    const checked = this.prepareChecked(prior);
    try {
      this.rs.transaction(() => {
        const { request } = this.admit("release", input), volumes = this.records(request.workspaceId);
        validateRelease(request, volumes);
        volumes.forEach(v => this.revalidateChecked(v, checked));
        if (this.authority.verifyStopped(request, stop, volumes) !== true) fail("stop_unconfirmed");
        this.run("UPDATE cowork_volumes SET owner_json=NULL,last_stop_id=? WHERE workspace_id=?", stop.confirmationId, request.workspaceId);
      }, { mode: "immediate" });
    } finally { checked.forEach(v => v.close()); }
  }
}
