import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Internal host coordination only. No default path, home discovery, guest JSON or module-level IO. */
export type AdmissionState = "reserved" | "booting" | "running" | "draining" | "uncertain" | "released";
export type AdmissionErrorCode = "invalid_request" | "probe_unavailable" | "ledger_unavailable" | "ledger_identity_mismatch" | "ledger_permissions_invalid" | "ledger_path_alias" | "newer_schema" | "ledger_corrupt" | "home_identity_mismatch" | "home_not_registered" | "home_overlaps_coordination" | "home_busy" | "relocation_denied" | "owner_mismatch" | "owner_unavailable" | "request_conflict" | "workspace_busy" | "epoch_reused" | "capacity_exceeded" | "pressure_refused" | "resource_observation_stale" | "transition_refused" | "stop_unconfirmed" | "not_found" | "revision_conflict";
export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) { super(code); this.name = "AdmissionError"; }
}
export interface HostIdentity { machineId: string; installationId: string; bootId: string }
/** Read from protected canonical home DB metadata, not reconstructed from copied bytes or a manifest.
 * Origin machine/installation are persisted before the home's first activation. */
export interface HostPreparedHomeBinding {
  homeId: string; canonicalPath: string; volumeId: string; directoryId: string;
  originMachineId: string; originInstallationId: string;
}
export interface HomeObservation {
  canonicalPath: string; volumeId: string; directoryId: string;
  canonicalDbBinding: HostPreparedHomeBinding;
}
export interface RegisteredHome extends HostPreparedHomeBinding { revision: number; registeredAt: number; updatedAt: number }
export interface AdmissionOwner { pid: number; startToken: string; bootId: string; instanceNonce: string }
export type ProcessObservation = { state: "alive"; startToken: string; bootId: string } | { state: "dead" } | { state: "unknown" };
export interface ResourceCommitment { memoryBytes: number; cpuUnits: number }
/** Commitments are accounting units chosen by automatic host policy, not physical allocation claims. */
export interface ResourceObservation {
  budget: ResourceCommitment & { guestLimit: number };
  pressure: "normal" | "elevated" | "critical" | "unknown";
  admitNew: boolean; observedAt: number; validUntil: number;
}
export interface StopReceipt {
  confirmationId: string; admissionId: string; homeId: string; workspaceId: string; incarnationId: string;
  leaseEpoch: number; owner: AdmissionOwner; confirmedAt: number;
}
export interface RelocationAuthorization { kind: "local-authorized-relocation"; authorizationId: string }
export interface AdmissionProbes {
  hostIdentity(): HostIdentity | null;
  homeIdentity(atPath: string): HomeObservation | null;
  processIdentity(pid: number): ProcessObservation | null;
  verifyStopReceipt(receipt: StopReceipt, record: AdmissionRecord): boolean;
  /** A changed token alone is insufficient: this probe confirms the old OS boot actually ended. */
  confirmsPreviousBootEnded(previousBootId: string, current: HostIdentity): boolean;
  authorizeRelocation(authorization: RelocationAuthorization, previous: RegisteredHome, next: HostPreparedHomeBinding): boolean;
}
export interface AdmissionRecord {
  admissionId: string; domainId: string; homeId: string; owner: AdmissionOwner;
  workspaceId: string; incarnationId: string; leaseEpoch: number; requestId: string;
  commitment: ResourceCommitment; resourceObservation: ResourceObservation; state: AdmissionState;
  createdAt: number; updatedAt: number; heartbeatAt: number; reconciledAt: number | null;
  uncertainReason: string | null; releasedAt: number | null; releaseReason: "confirmed-stop" | "trusted-new-boot" | null;
  stopConfirmationId: string | null;
}
export interface AdmissionLedgerOptions {
  path: string; domainId: string; probes: AdmissionProbes;
  observeResources(): ResourceObservation | null;
  now?: () => number; mint?: () => string; heartbeatTimeoutMs?: number; busyTimeoutMs?: number;
}
type Row = Record<string, unknown>;
const STATES = new Set<AdmissionState>(["reserved", "booting", "running", "draining", "uncertain", "released"]);
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw new AdmissionError("invalid_request");
  return value;
};
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new AdmissionError("invalid_request");
  return value;
};
function exactPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value) || !isAbsolute(value) || resolve(value) !== value) throw new AdmissionError("invalid_request");
  return value;
}
function owner(value: AdmissionOwner): AdmissionOwner {
  if (!value) throw new AdmissionError("invalid_request");
  return { pid: integer(value.pid, 1, 0x7fffffff), startToken: id(value.startToken), bootId: id(value.bootId), instanceNonce: id(value.instanceNonce) };
}
function sameOwner(a: AdmissionOwner, b: AdmissionOwner): boolean {
  return a.pid === b.pid && a.startToken === b.startToken && a.bootId === b.bootId && a.instanceNonce === b.instanceNonce;
}
function binding(value: HostPreparedHomeBinding): HostPreparedHomeBinding {
  if (!value) throw new AdmissionError("invalid_request");
  return { homeId: id(value.homeId), canonicalPath: exactPath(value.canonicalPath), volumeId: id(value.volumeId), directoryId: id(value.directoryId), originMachineId: id(value.originMachineId), originInstallationId: id(value.originInstallationId) };
}
function sameBinding(a: HostPreparedHomeBinding, b: HostPreparedHomeBinding): boolean {
  return a.homeId === b.homeId && a.canonicalPath === b.canonicalPath && a.volumeId === b.volumeId && a.directoryId === b.directoryId && a.originMachineId === b.originMachineId && a.originInstallationId === b.originInstallationId;
}
function commitment(value: ResourceCommitment): ResourceCommitment {
  if (!value) throw new AdmissionError("invalid_request");
  return { memoryBytes: integer(value.memoryBytes, 1), cpuUnits: integer(value.cpuUnits, 1) };
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }

/** SQLite is the global reservation counter for this explicitly selected logged-in-user domain.
 * Synchronous probes must be bounded host observations; no VM/network effects occur in a transaction.
 * Released admission is NEVER evidence that a writable disk may be reattached. */
export class CoworkAdmissionLedger {
  readonly path: string;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly mint: () => string;
  private readonly heartbeatTimeout: number;
  private initialHost?: HostIdentity;
  constructor(private readonly options: AdmissionLedgerOptions) {
    if (!options || typeof options.observeResources !== "function" || !options.probes || ["hostIdentity", "homeIdentity", "processIdentity", "verifyStopReceipt", "confirmsPreviousBootEnded", "authorizeRelocation"].some(name => typeof (options.probes as unknown as Record<string, unknown>)[name] !== "function")) throw new AdmissionError("invalid_request");
    this.path = exactPath(options.path); id(options.domainId);
    this.now = options.now ?? Date.now; this.mint = options.mint ?? randomUUID;
    this.heartbeatTimeout = integer(options.heartbeatTimeoutMs ?? 30_000, 1);
    const busy = integer(options.busyTimeoutMs ?? 5_000, 1, 60_000), host = this.host();
    this.initialHost=host;
    let fd: number | undefined, db: Database | undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (join(realpathSync(dirname(this.path)), basename(this.path)) !== this.path) throw new AdmissionError("ledger_path_alias");
      const parent = lstatSync(dirname(this.path));
      if (!parent.isDirectory() || parent.uid !== process.geteuid?.() || (parent.mode & 0o777) !== 0o700) throw new AdmissionError("ledger_permissions_invalid");
      try { fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; fd = openSync(this.path, constants.O_RDWR | constants.O_NOFOLLOW); }
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== process.geteuid?.() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) throw new AdmissionError("ledger_permissions_invalid");
      this.checkSidecars();
      db = new Database(this.path, { create: false, readwrite: true });
      const after = lstatSync(this.path);
      if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()) throw new AdmissionError("ledger_path_alias");
      db.run(`PRAGMA busy_timeout=${busy}`); db.run("PRAGMA foreign_keys=ON");
      db.transaction(() => this.initialize(db!, host)).immediate();
      db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA synchronous=FULL");
      this.checkSidecars(); this.db = db;
    } catch (error) {
      db?.close();
      if (error instanceof AdmissionError) throw error;
      throw new AdmissionError("ledger_unavailable");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  private checkSidecars(): void {
    for (const suffix of ["-wal", "-shm"]) {
      let st; try { st = lstatSync(`${this.path}${suffix}`); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.geteuid?.() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) throw new AdmissionError("ledger_permissions_invalid");
    }
  }
  private initialize(db: Database, host: HostIdentity): void {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > 1) throw new AdmissionError("newer_schema");
    if (version === 0) {
      if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new AdmissionError("ledger_corrupt");
      db.exec(`
        CREATE TABLE admission_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),domain_id TEXT NOT NULL,machine_id TEXT NOT NULL,installation_id TEXT NOT NULL,canonical_path TEXT NOT NULL);
        CREATE TABLE admission_homes(home_id TEXT PRIMARY KEY,canonical_path TEXT NOT NULL UNIQUE,volume_id TEXT NOT NULL,directory_id TEXT NOT NULL,origin_machine_id TEXT NOT NULL,origin_installation_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),registered_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(origin_machine_id,volume_id,directory_id));
        CREATE TABLE admission_owners(instance_nonce TEXT PRIMARY KEY,home_id TEXT NOT NULL REFERENCES admission_homes(home_id),pid INTEGER NOT NULL,start_token TEXT NOT NULL,boot_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(boot_id,pid,start_token));
        CREATE TABLE admission_records(admission_id TEXT PRIMARY KEY,domain_id TEXT NOT NULL,home_id TEXT NOT NULL REFERENCES admission_homes(home_id),owner_nonce TEXT NOT NULL REFERENCES admission_owners(instance_nonce),workspace_id TEXT NOT NULL,incarnation_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL CHECK(lease_epoch>0),request_id TEXT NOT NULL,request_digest TEXT NOT NULL,memory_bytes INTEGER NOT NULL CHECK(memory_bytes>0),cpu_units INTEGER NOT NULL CHECK(cpu_units>0),resource_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','booting','running','draining','uncertain','released')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,reconciled_at INTEGER,uncertain_reason TEXT,released_at INTEGER,release_reason TEXT CHECK(release_reason IN ('confirmed-stop','trusted-new-boot')),stop_confirmation_id TEXT,stop_digest TEXT,UNIQUE(home_id,request_id),UNIQUE(workspace_id,incarnation_id,lease_epoch),CHECK((state='released')=(released_at IS NOT NULL)));
        CREATE UNIQUE INDEX admission_one_workspace ON admission_records(workspace_id) WHERE state!='released';
        CREATE INDEX admission_active ON admission_records(state);
      `);
      db.run("INSERT INTO admission_meta VALUES(1,?,?,?,?)", [this.options.domainId, host.machineId, host.installationId, this.path]);
      db.run("PRAGMA user_version=1");
    }
    const meta = db.query<Row, []>("SELECT * FROM admission_meta WHERE singleton=1").get();
    if (!meta || meta.domain_id !== this.options.domainId || meta.machine_id !== host.machineId || meta.installation_id !== host.installationId || meta.canonical_path !== this.path) throw new AdmissionError("ledger_identity_mismatch");
    if (db.query<{ quick_check: string }, []>("PRAGMA quick_check").all().some(row => row.quick_check !== "ok") || db.query("PRAGMA foreign_key_check").all().length) throw new AdmissionError("ledger_corrupt");
  }
  private transaction<T>(body: () => T): T { return this.db.transaction(body).immediate(); }
  private time(): number { return integer(this.now()); }
  private probe<T>(body: () => T | null): T { try { const result = body(); if (result === null || result === undefined) throw new Error(); return result; } catch { throw new AdmissionError("probe_unavailable"); } }
  private host(): HostIdentity {
    const value = this.probe(() => this.options.probes.hostIdentity());
    const host={ machineId: id(value.machineId), installationId: id(value.installationId), bootId: id(value.bootId) };
    if (this.initialHost && (host.machineId!==this.initialHost.machineId || host.installationId!==this.initialHost.installationId)) throw new AdmissionError("ledger_identity_mismatch");
    return host;
  }
  private verifyBinding(prepared: HostPreparedHomeBinding, atPath: string): void {
    const actual = this.probe(() => this.options.probes.homeIdentity(exactPath(atPath))), host = this.host();
    if (!sameBinding(prepared,binding(actual.canonicalDbBinding)) || prepared.canonicalPath !== atPath || actual.canonicalPath !== atPath || actual.volumeId !== prepared.volumeId || actual.directoryId !== prepared.directoryId || prepared.originMachineId !== host.machineId || prepared.originInstallationId !== host.installationId) throw new AdmissionError("home_identity_mismatch");
    if (overlaps(prepared.canonicalPath.toLowerCase(), dirname(this.path).toLowerCase())) throw new AdmissionError("home_overlaps_coordination");
  }
  private homeRow(row: Row): RegisteredHome {
    return { ...binding({homeId: row.home_id as string, canonicalPath: row.canonical_path as string, volumeId: row.volume_id as string, directoryId: row.directory_id as string, originMachineId: row.origin_machine_id as string, originInstallationId: row.origin_installation_id as string}), revision: integer(row.revision,1), registeredAt: integer(row.registered_at), updatedAt: integer(row.updated_at) };
  }
  home(homeId: string): RegisteredHome {
    const row = this.db.query<Row,[string]>("SELECT * FROM admission_homes WHERE home_id=?").get(id(homeId));
    if (!row) throw new AdmissionError("home_not_registered"); return this.homeRow(row);
  }
  registerHome(prepared: HostPreparedHomeBinding, atPath: string): RegisteredHome {
    const next = binding(prepared); exactPath(atPath);
    return this.transaction(() => {
      this.verifyBinding(next, atPath);
      const row = this.db.query<Row,[string]>("SELECT * FROM admission_homes WHERE home_id=?").get(next.homeId);
      if (row) { const existing = this.homeRow(row); if (!sameBinding(existing,next)) throw new AdmissionError("home_identity_mismatch"); return existing; }
      if (this.db.query("SELECT 1 FROM admission_homes WHERE canonical_path=? OR (origin_machine_id=? AND volume_id=? AND directory_id=?)").get(next.canonicalPath,next.originMachineId,next.volumeId,next.directoryId)) throw new AdmissionError("home_identity_mismatch");
      const now = this.time();
      this.db.run("INSERT INTO admission_homes VALUES(?,?,?,?,?,?,1,?,?)", [next.homeId,next.canonicalPath,next.volumeId,next.directoryId,next.originMachineId,next.originInstallationId,now,now]);
      return this.home(next.homeId);
    });
  }
  relocateHome(input: { homeId: string; expectedRevision: number; from: HostPreparedHomeBinding; to: HostPreparedHomeBinding; atPath: string; authorization: RelocationAuthorization }): RegisteredHome {
    const from=binding(input.from),to=binding(input.to); id(input.homeId); integer(input.expectedRevision,1); exactPath(input.atPath);
    if (from.homeId !== input.homeId || to.homeId !== input.homeId || input.authorization?.kind !== "local-authorized-relocation") throw new AdmissionError("relocation_denied");
    id(input.authorization.authorizationId);
    return this.transaction(() => {
      const old=this.home(input.homeId);
      if (old.revision !== input.expectedRevision || !sameBinding(old,from)) throw new AdmissionError("revision_conflict");
      if (this.db.query("SELECT 1 FROM admission_records WHERE home_id=? AND state!='released'").get(input.homeId)) throw new AdmissionError("home_busy");
      if (this.probe(() => this.options.probes.authorizeRelocation(input.authorization,old,to))!==true) throw new AdmissionError("relocation_denied");
      this.verifyBinding(to,input.atPath);
      if (this.db.query("SELECT 1 FROM admission_homes WHERE home_id!=? AND (canonical_path=? OR (origin_machine_id=? AND volume_id=? AND directory_id=?))").get(input.homeId,to.canonicalPath,to.originMachineId,to.volumeId,to.directoryId)) throw new AdmissionError("home_identity_mismatch");
      this.db.run("UPDATE admission_homes SET canonical_path=?,volume_id=?,directory_id=?,origin_machine_id=?,origin_installation_id=?,revision=revision+1,updated_at=? WHERE home_id=?", [to.canonicalPath,to.volumeId,to.directoryId,to.originMachineId,to.originInstallationId,this.time(),input.homeId]);
      return this.home(input.homeId);
    });
  }
  private verifyOwner(value: AdmissionOwner): void {
    const host=this.host(), observed=this.probe(() => this.options.probes.processIdentity(value.pid));
    if (value.bootId !== host.bootId || observed.state !== "alive") throw new AdmissionError("owner_unavailable");
    if (observed.bootId !== value.bootId || observed.startToken !== value.startToken) throw new AdmissionError("owner_mismatch");
  }
  private resourceObservation(): ResourceObservation {
    const value=this.probe(() => this.options.observeResources()),now=this.time();
    const normalized: ResourceObservation={ budget:{memoryBytes:integer(value.budget?.memoryBytes),cpuUnits:integer(value.budget?.cpuUnits),guestLimit:integer(value.budget?.guestLimit,0,4096)},pressure:value.pressure,admitNew:value.admitNew,observedAt:integer(value.observedAt),validUntil:integer(value.validUntil) };
    if (!["normal","elevated","critical","unknown"].includes(normalized.pressure) || typeof normalized.admitNew !== "boolean") throw new AdmissionError("invalid_request");
    if (now < normalized.observedAt || now > normalized.validUntil || normalized.validUntil < normalized.observedAt) throw new AdmissionError("resource_observation_stale");
    if (!normalized.admitNew || normalized.pressure === "unknown" || normalized.pressure === "critical") throw new AdmissionError("pressure_refused");
    return normalized;
  }
  reserve(input: {requestId: string;homeId: string;owner: AdmissionOwner;workspaceId: string;incarnationId: string;leaseEpoch: number;commitment: ResourceCommitment}): AdmissionRecord {
    const normalized={requestId:id(input.requestId),homeId:id(input.homeId),owner:owner(input.owner),workspaceId:id(input.workspaceId),incarnationId:id(input.incarnationId),leaseEpoch:integer(input.leaseEpoch,1),commitment:commitment(input.commitment)},requestDigest=digest(normalized);
    return this.transaction(() => {
      const home=this.home(normalized.homeId); this.verifyBinding(home,home.canonicalPath); this.verifyOwner(normalized.owner);
      const previous=this.db.query<Row,[string,string]>("SELECT admission_id,request_digest FROM admission_records WHERE home_id=? AND request_id=?").get(normalized.homeId,normalized.requestId);
      if (previous) { if (previous.request_digest !== requestDigest) throw new AdmissionError("request_conflict"); return this.get(previous.admission_id as string); }
      if (this.db.query("SELECT 1 FROM admission_records WHERE workspace_id=? AND state!='released'").get(normalized.workspaceId)) throw new AdmissionError("workspace_busy");
      const epoch=this.db.query<{max_epoch:number|null},[string]>("SELECT MAX(lease_epoch) AS max_epoch FROM admission_records WHERE workspace_id=?").get(normalized.workspaceId)?.max_epoch ?? 0;
      if (normalized.leaseEpoch <= epoch) throw new AdmissionError("epoch_reused");
      const observation=this.resourceObservation(),active=this.db.query<{memory_bytes:number;cpu_units:number},[]>("SELECT memory_bytes,cpu_units FROM admission_records WHERE state!='released' LIMIT 4097").all();
      let memory=normalized.commitment.memoryBytes,cpu=normalized.commitment.cpuUnits;
      for (const row of active) { memory+=integer(row.memory_bytes,1); cpu+=integer(row.cpu_units,1); }
      if (!Number.isSafeInteger(memory) || !Number.isSafeInteger(cpu) || active.length+1>observation.budget.guestLimit || memory>observation.budget.memoryBytes || cpu>observation.budget.cpuUnits) throw new AdmissionError("capacity_exceeded");
      const own=this.db.query<Row,[string]>("SELECT * FROM admission_owners WHERE instance_nonce=?").get(normalized.owner.instanceNonce);
      if (own) {
        if (own.home_id !== normalized.homeId || own.pid !== normalized.owner.pid || own.start_token !== normalized.owner.startToken || own.boot_id !== normalized.owner.bootId) throw new AdmissionError("owner_mismatch");
      } else {
        if (this.db.query("SELECT 1 FROM admission_owners WHERE boot_id=? AND pid=? AND start_token=?").get(normalized.owner.bootId,normalized.owner.pid,normalized.owner.startToken)) throw new AdmissionError("owner_mismatch");
        this.db.run("INSERT INTO admission_owners VALUES(?,?,?,?,?,?)",[normalized.owner.instanceNonce,normalized.homeId,normalized.owner.pid,normalized.owner.startToken,normalized.owner.bootId,this.time()]);
      }
      const admissionId=id(this.mint()),now=this.time();
      this.db.run("INSERT INTO admission_records(admission_id,domain_id,home_id,owner_nonce,workspace_id,incarnation_id,lease_epoch,request_id,request_digest,memory_bytes,cpu_units,resource_json,state,created_at,updated_at,heartbeat_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?)",[admissionId,this.options.domainId,normalized.homeId,normalized.owner.instanceNonce,normalized.workspaceId,normalized.incarnationId,normalized.leaseEpoch,normalized.requestId,requestDigest,normalized.commitment.memoryBytes,normalized.commitment.cpuUnits,JSON.stringify(observation),now,now,now]);
      return this.get(admissionId);
    });
  }
  get(admissionId: string): AdmissionRecord {
    const row=this.db.query<Row,[string]>("SELECT r.*,o.pid,o.start_token,o.boot_id FROM admission_records r JOIN admission_owners o ON o.instance_nonce=r.owner_nonce WHERE admission_id=?").get(id(admissionId));
    if (!row) throw new AdmissionError("not_found");
    try {
      const state=row.state as AdmissionState; if (!STATES.has(state)) throw new Error();
      const resourceObservation=JSON.parse(row.resource_json as string) as ResourceObservation;
      return {admissionId:id(row.admission_id),domainId:id(row.domain_id),homeId:id(row.home_id),owner:owner({pid:row.pid as number,startToken:row.start_token as string,bootId:row.boot_id as string,instanceNonce:row.owner_nonce as string}),workspaceId:id(row.workspace_id),incarnationId:id(row.incarnation_id),leaseEpoch:integer(row.lease_epoch,1),requestId:id(row.request_id),commitment:commitment({memoryBytes:row.memory_bytes as number,cpuUnits:row.cpu_units as number}),resourceObservation,state,createdAt:integer(row.created_at),updatedAt:integer(row.updated_at),heartbeatAt:integer(row.heartbeat_at),reconciledAt:row.reconciled_at===null?null:integer(row.reconciled_at),uncertainReason:row.uncertain_reason as string|null,releasedAt:row.released_at===null?null:integer(row.released_at),releaseReason:row.release_reason as AdmissionRecord["releaseReason"],stopConfirmationId:row.stop_confirmation_id as string|null};
    } catch { throw new AdmissionError("ledger_corrupt"); }
  }
  listActive(): AdmissionRecord[] { return this.db.query<{admission_id:string},[]>("SELECT admission_id FROM admission_records WHERE state!='released' ORDER BY created_at,admission_id LIMIT 4097").all().map(row=>this.get(row.admission_id)); }
  private owned(admissionId: string, claimed: AdmissionOwner, live=true): AdmissionRecord {
    const record=this.get(admissionId); if (!sameOwner(record.owner,owner(claimed))) throw new AdmissionError("owner_mismatch");
    if (live) { this.verifyOwner(record.owner); const home=this.home(record.homeId); this.verifyBinding(home,home.canonicalPath); }
    return record;
  }
  transition(admissionId: string, claimed: AdmissionOwner, expected: AdmissionState, next: AdmissionState): AdmissionRecord {
    return this.transaction(() => {
      const record=this.owned(admissionId,claimed);
      const transitions:Record<AdmissionState,AdmissionState[]>={reserved:["booting","draining","uncertain"],booting:["running","draining","uncertain"],running:["draining","uncertain"],draining:["uncertain"],uncertain:["draining"],released:[]};
      if (record.state!==expected || !transitions[record.state].includes(next)) throw new AdmissionError("transition_refused");
      const now=this.time(); this.db.run("UPDATE admission_records SET state=?,updated_at=?,heartbeat_at=? WHERE admission_id=?",[next,now,now,admissionId]); return this.get(admissionId);
    });
  }
  heartbeat(admissionId: string, claimed: AdmissionOwner): AdmissionRecord {
    return this.transaction(() => { const record=this.owned(admissionId,claimed); if (record.state==="released") throw new AdmissionError("transition_refused"); const now=this.time(); this.db.run("UPDATE admission_records SET heartbeat_at=?,updated_at=? WHERE admission_id=?",[now,now,admissionId]); return this.get(admissionId); });
  }
  release(admissionId: string, claimed: AdmissionOwner, receipt: StopReceipt): {record:AdmissionRecord;admissionReleased:true;diskOwnershipVerified:false} {
    return this.transaction(() => {
      const record=this.owned(admissionId,claimed,false); id(receipt?.confirmationId); integer(receipt?.confirmedAt);
      this.host();
      if (receipt.admissionId!==record.admissionId || receipt.homeId!==record.homeId || receipt.workspaceId!==record.workspaceId || receipt.incarnationId!==record.incarnationId || receipt.leaseEpoch!==record.leaseEpoch || !sameOwner(owner(receipt.owner),record.owner) || receipt.confirmedAt<record.createdAt || receipt.confirmedAt>this.time() || this.probe(()=>this.options.probes.verifyStopReceipt(receipt,record))!==true) throw new AdmissionError("stop_unconfirmed");
      const proofDigest=digest(receipt);
      if (record.state==="released") {
        const prior=this.db.query<{stop_digest:string|null},[string]>("SELECT stop_digest FROM admission_records WHERE admission_id=?").get(admissionId);
        if (record.releaseReason==="confirmed-stop" && prior?.stop_digest!==proofDigest) throw new AdmissionError("request_conflict");
      } else { const now=this.time(); this.db.run("UPDATE admission_records SET state='released',released_at=?,updated_at=?,release_reason='confirmed-stop',stop_confirmation_id=?,stop_digest=? WHERE admission_id=?",[now,now,receipt.confirmationId,proofDigest,admissionId]); }
      return {record:this.get(admissionId),admissionReleased:true,diskOwnershipVerified:false};
    });
  }
  reconcile(): AdmissionRecord[] {
    return this.transaction(() => {
      const host=this.host(),now=this.time();
      for (const record of this.listActive()) {
        let reason:string|null=null;
        if (record.owner.bootId!==host.bootId) {
          let ended=false; try { ended=this.options.probes.confirmsPreviousBootEnded(record.owner.bootId,host); } catch { /* uncertainty consumes capacity */ }
          if (ended===true) { this.db.run("UPDATE admission_records SET state='released',released_at=?,updated_at=?,reconciled_at=?,release_reason='trusted-new-boot' WHERE admission_id=?",[now,now,now,record.admissionId]); continue; }
          reason="previous-boot-unconfirmed";
        } else {
          let observed:ProcessObservation|null=null; try { observed=this.options.probes.processIdentity(record.owner.pid); } catch { /* unknown owner */ }
          if (!observed || observed.state==="unknown") reason="owner-unknown";
          else if (observed.state==="dead") reason="owner-dead";
          else if (observed.bootId!==record.owner.bootId || observed.startToken!==record.owner.startToken) reason="pid-reused";
          else if (now-record.heartbeatAt>this.heartbeatTimeout || now<record.heartbeatAt) reason="heartbeat-expired";
          else {
            try { const home=this.home(record.homeId); this.verifyBinding(home,home.canonicalPath); }
            catch { reason="home-identity-unavailable"; }
          }
        }
        if (reason) this.db.run("UPDATE admission_records SET state='uncertain',uncertain_reason=?,updated_at=?,reconciled_at=? WHERE admission_id=?",[reason,now,now,record.admissionId]);
        else this.db.run("UPDATE admission_records SET reconciled_at=? WHERE admission_id=?",[now,record.admissionId]);
      }
      return this.listActive();
    });
  }
  close(): void { this.db.close(); }
}
