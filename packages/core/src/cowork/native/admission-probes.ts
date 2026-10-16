/** N2 S6 (UNWIRED): production host-fact probes for `CoworkAdmissionLedger` (`../admission`).
 *
 * Real here, all read-only host observations (no write, no lock, no signal, no VM):
 *  - machine identity   IOPlatformUUID, parsed from `/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice`
 *                       through an injected runner (cached after the first good answer; it cannot change);
 *  - OS boot identity   `kern.bootsessionuuid` through sysctl FFI, read on every call;
 *  - process identity   `proc_pidinfo(PROC_PIDTBSDINFO)` start time, so a reused PID never matches;
 *  - the Coordination ledger path, as a pure spelling function (no IO, no fallback to a real path in tests).
 *
 * Injected on purpose (S1 and S7 own them, and none has a permissive default):
 *  - `installationId`      REVIEW NEEDED: which durable per-install id the ledger pins is undecided. The ledger
 *                          writes it into `admission_meta` forever, so a lost id makes `ledger_identity_mismatch`
 *                          permanent. This module does not mint or persist one.
 *  - `homeIdentity`        reads the canonical home DB binding, which is runtime-state schema territory;
 *  - `verifyStopReceipt`   stays a PORT for S1's protected stop evidence. Nothing here derives stop evidence,
 *                          and no PID, EOF or boot observation in this file can release a disk;
 *  - `authorizeRelocation` defaults to DENY.
 *
 * Every failure is fail-closed: a runner that errors, times out, exits nonzero or prints anything other than
 * exactly one well-formed IOPlatformUUID gives `null`; the ledger turns `null` into `probe_unavailable`. */
import { dlopen, FFIType, read } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { AdmissionProbes, HostIdentity, ProcessObservation } from "../admission";

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const LEDGER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const validUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value) && !/^[0-]+$/.test(value);

// --- machine identity -----------------------------------------------------------------------------
export interface HostCommandResult { readonly status: number | null; readonly stdout: string; readonly timedOut?: boolean }
export type HostCommandRunner = (file: string, args: readonly string[]) => HostCommandResult;
export const IOREG_PATH = "/usr/sbin/ioreg";
export const IOREG_ARGS: readonly string[] = Object.freeze(["-rd1", "-c", "IOPlatformExpertDevice"]);
/** Bounded, synchronous, empty environment, stdin and stderr discarded. Used only for the fixed ioreg query. */
export const runHostCommand: HostCommandRunner = (file, args) => {
  const result = spawnSync(file, [...args], { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024, env: {}, stdio: ["ignore", "pipe", "ignore"] });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { status: result.error ? null : result.status, stdout: typeof result.stdout === "string" ? result.stdout : "", timedOut };
};
/** Exactly one line may mention the key and it must be a well-formed, non-nil UUID. Two matches, a malformed
 * value, extra tokens or no match at all are all `null`. */
export function parseIoPlatformUuid(stdout: string): string | null {
  if (typeof stdout !== "string" || stdout.length > 256 * 1024) return null;
  const mentions = stdout.split(/\r?\n/).filter(line => line.includes('"IOPlatformUUID"'));
  if (mentions.length !== 1) return null;
  const match = /^\s*"IOPlatformUUID"\s*=\s*"([^"]*)"\s*$/.exec(mentions[0]!);
  return match && validUuid(match[1]) ? match[1] : null;
}
export function readMachineId(run: HostCommandRunner): string | null {
  try {
    const result = run(IOREG_PATH, IOREG_ARGS);
    return !result || result.timedOut === true || result.status !== 0 ? null : parseIoPlatformUuid(result.stdout);
  } catch { return null; }
}

// --- sysctl ---------------------------------------------------------------------------------------
export interface SysctlReader {
  string(name: string): string | null;
  int32(name: string): number | null;
  uint64(name: string): bigint | null;
}
/** The raw call: the bytes sysctl wrote, or null on failure. Capacity bounds the read. */
export interface SysctlLibrary { query(name: string, capacity: number): Uint8Array | null }
const SYSCTL_NAME = /^[a-z0-9_.]{1,64}$/;
/** A sysctl string carries one trailing NUL. Anything else (no NUL, an interior NUL, empty, non-printable) is null. */
export function decodeSysctlString(bytes: Uint8Array | null): string | null {
  if (!bytes || bytes.length < 2 || bytes[bytes.length - 1] !== 0) return null;
  const text = Buffer.from(bytes.subarray(0, bytes.length - 1)).toString("latin1");
  return /^[ -~]+$/.test(text) ? text : null;
}
export function createSysctlReader(library: SysctlLibrary = loadSysctlLibrary()): SysctlReader {
  const query = (name: string, capacity: number): Uint8Array | null => {
    if (typeof name !== "string" || !SYSCTL_NAME.test(name)) return null;
    try { const bytes = library.query(name, capacity); return bytes && bytes.length <= capacity ? bytes : null; } catch { return null; }
  };
  return {
    string: name => decodeSysctlString(query(name, 128)),
    int32: name => { const bytes = query(name, 4); return bytes?.length === 4 ? Buffer.from(bytes).readInt32LE(0) : null; },
    uint64: name => { const bytes = query(name, 8); return bytes?.length === 8 ? Buffer.from(bytes).readBigUInt64LE(0) : null; },
  };
}
function loadSysctlLibrary(): SysctlLibrary {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("unsupported_topology");
  const lib = dlopen("/usr/lib/libSystem.B.dylib", { sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } });
  return {
    query(name, capacity) {
      const out = Buffer.alloc(capacity), length = new BigUint64Array([BigInt(capacity)]);
      const status = lib.symbols.sysctlbyname!(Buffer.from(`${name}\0`), out, length, null, 0n) as number;
      return status === 0 && length[0]! <= BigInt(capacity) ? out.subarray(0, Number(length[0])) : null;
    },
  };
}
/** `kern.bootsessionuuid` is regenerated at every boot. Anything but a well-formed non-nil UUID is null. */
export function readBootId(sysctl: SysctlReader): string | null {
  try { const value = sysctl.string("kern.bootsessionuuid"); return validUuid(value) ? value : null; } catch { return null; }
}

// --- process identity -----------------------------------------------------------------------------
export type ProcessInspection =
  | { readonly kind: "present"; readonly startSeconds: number; readonly startMicroseconds: number; readonly zombie: boolean }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };
export interface ProcessTable { inspect(pid: number): ProcessInspection }
export const PROC_PIDTBSDINFO = 3;
/** sizeof(struct proc_bsdinfo). Offsets: pbi_status@4 u32, pbi_pid@12 u32, pbi_start_tvsec@120 u64, pbi_start_tvusec@128 u64. */
export const PROC_BSDINFO_BYTES = 136;
const SZOMB = 5, ESRCH = 3;
/** Pure so synthetic buffers can exercise every refusal. A short or long return, a different pid in the record,
 * a zero start or an out-of-range microsecond field is `unknown`, never `present`. */
export function parseProcBsdInfo(raw: Uint8Array, returned: number, pid: number): ProcessInspection {
  if (returned !== PROC_BSDINFO_BYTES || raw.length < PROC_BSDINFO_BYTES) return { kind: "unknown" };
  const view = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const recordedPid = view.readUInt32LE(12), status = view.readUInt32LE(4), seconds = view.readBigUInt64LE(120), micros = view.readBigUInt64LE(128);
  if (recordedPid !== pid || seconds < 1n || seconds > BigInt(Number.MAX_SAFE_INTEGER) || micros >= 1_000_000n) return { kind: "unknown" };
  return { kind: "present", startSeconds: Number(seconds), startMicroseconds: Number(micros), zombie: status === SZOMB };
}
export interface ProcLibrary { pidinfo(pid: number, out: Buffer): { readonly returned: number; readonly errno: number } }
export function createProcessTable(library: ProcLibrary = loadProcLibrary()): ProcessTable {
  return {
    inspect(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return { kind: "unknown" };
      const out = Buffer.alloc(PROC_BSDINFO_BYTES), result = library.pidinfo(pid, out);
      // Only ESRCH proves absence. Every other failure (EPERM, a short read) is "cannot tell".
      if (result.returned <= 0) return result.errno === ESRCH ? { kind: "absent" } : { kind: "unknown" };
      return parseProcBsdInfo(out, result.returned, pid);
    },
  };
}
function loadProcLibrary(): ProcLibrary {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("unsupported_topology");
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  return {
    pidinfo(pid, out) {
      const returned = lib.symbols.proc_pidinfo!(pid, PROC_PIDTBSDINFO, 0n, out, out.length) as number;
      const address = lib.symbols.__error!();
      return { returned, errno: returned > 0 || address === null ? 0 : read.i32(address, 0) };
    },
  };
}
/** The three production adapters. The probe factory has no defaults, so a test never reaches the host by accident. */
export function createProductionHostAdapters(): { runCommand: HostCommandRunner; sysctl: SysctlReader; processes: ProcessTable } {
  return { runCommand: runHostCommand, sysctl: createSysctlReader(), processes: createProcessTable() };
}

// --- the probes -----------------------------------------------------------------------------------
export interface AdmissionProbeDeps {
  readonly runCommand: HostCommandRunner;
  readonly sysctl: SysctlReader;
  readonly processes: ProcessTable;
  /** REVIEW NEEDED: the production source of this durable per-install id is undecided; see the file comment. */
  readonly installationId: () => string | null;
  readonly homeIdentity: AdmissionProbes["homeIdentity"];
  /** S1 fills this with protected stop evidence. A missing function is a construction error. */
  readonly verifyStopReceipt: AdmissionProbes["verifyStopReceipt"];
  /** Absent means deny. */
  readonly authorizeRelocation?: AdmissionProbes["authorizeRelocation"];
}
export function createCoworkAdmissionProbes(deps: AdmissionProbeDeps): AdmissionProbes {
  if (!deps || ["runCommand", "installationId", "homeIdentity", "verifyStopReceipt"].some(name => typeof (deps as unknown as Record<string, unknown>)[name] !== "function") || typeof deps.sysctl?.string !== "function" || typeof deps.processes?.inspect !== "function") throw new TypeError("admission_probe_ports");
  if (deps.authorizeRelocation !== undefined && typeof deps.authorizeRelocation !== "function") throw new TypeError("admission_probe_ports");
  // IOPlatformUUID cannot change while the host runs, so only a good answer is cached (a null is retried).
  let cachedMachineId: string | null = null;
  const hostIdentity = (): HostIdentity | null => {
    try {
      cachedMachineId ??= readMachineId(deps.runCommand);
      const bootId = readBootId(deps.sysctl), installationId = deps.installationId();
      if (cachedMachineId === null || bootId === null || typeof installationId !== "string" || !LEDGER_ID.test(installationId)) return null;
      return { machineId: cachedMachineId, installationId, bootId };
    } catch { return null; }
  };
  return {
    hostIdentity,
    homeIdentity(atPath) { try { return deps.homeIdentity(atPath); } catch { return null; } },
    processIdentity(pid): ProcessObservation | null {
      try {
        if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return null;
        const bootId = readBootId(deps.sysctl);
        if (bootId === null) return null;
        const seen = deps.processes.inspect(pid);
        if (seen.kind === "absent") return { state: "dead" };
        if (seen.kind !== "present") return { state: "unknown" };
        // A zombie has terminated and only awaits its parent's wait(); its start time must not read as alive.
        if (seen.zombie) return { state: "dead" };
        return { state: "alive", startToken: `${seen.startSeconds}.${String(seen.startMicroseconds).padStart(6, "0")}`, bootId };
      } catch { return null; }
    },
    verifyStopReceipt(receipt, record) { try { return deps.verifyStopReceipt(receipt, record) === true; } catch { return false; } },
    /** A different, well-formed boot session UUID on the SAME live host proves the old boot session ended: the
     * kernel mints a new one only at boot. `current` must equal what this host reports right now, so a caller
     * cannot pass a forged "new boot". Equal ids (case-insensitively), malformed ids and any probe failure say no. */
    confirmsPreviousBootEnded(previousBootId, current) {
      try {
        if (!validUuid(previousBootId) || !current || !validUuid(current.bootId) || previousBootId.toLowerCase() === current.bootId.toLowerCase()) return false;
        const live = hostIdentity();
        return live !== null && live.machineId === current.machineId && live.installationId === current.installationId && live.bootId === current.bootId;
      } catch { return false; }
    },
    authorizeRelocation(authorization, previous, next) {
      try { return deps.authorizeRelocation?.(authorization, previous, next) === true; } catch { return false; }
    },
  };
}

// --- the Coordination ledger path -----------------------------------------------------------------
export const COORDINATION_DIR_ENV = "WINTER_COWORK_COORDINATION_DIR";
export const COORDINATION_LEDGER_FILE = "cowork-admission.sqlite";
const COORDINATION_DEFAULT = "Library/Application Support/Winter/Coordination";
export interface CoordinationPathInputs { readonly env: Readonly<Record<string, string | undefined>>; readonly homeDirectory: string }
function exact(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value) || value === "/" || !value.startsWith("/") || resolve(value) !== value) throw new Error("coordination_path_invalid");
  return value;
}
/** Pure spelling, no IO. The directory is spelled exactly as the host-storage fence spells it
 * (`runtime-sdk/host-storage-fence.ts`: the same environment variable, the same default under the home
 * directory), so the fence and the ledger cannot drift; a test pins that. A set-but-invalid override THROWS and
 * never falls back to the real per-user path. The ledger itself demands a canonical path and rejects an aliased
 * one with `ledger_path_alias`. */
export function coordinationLedgerPath(inputs: CoordinationPathInputs): string {
  const override = inputs?.env?.[COORDINATION_DIR_ENV];
  const directory = override !== undefined ? exact(override) : join(exact(inputs?.homeDirectory), COORDINATION_DEFAULT);
  return exact(join(exact(directory), COORDINATION_LEDGER_FILE));
}
