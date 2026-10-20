import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { HostPreparedHomeBinding } from "../admission";
import type { RuntimeStateDb } from "../../runtime-state/db";
import { COWORK_NATIVE_LIMITS, parseCoworkNativeStopReceipt } from "../native/protocol";
import type { CoworkNativeDurableReceiptPort, CoworkNativeReceiptScope } from "../native/recovery";
import type { CoworkNativeLaunchEntry, CoworkNativeLaunchJournalPort } from "../native/stop-proof";
import { CoworkHostEnvError, assertOutsideWinterHomes, ensurePrivateDirectory } from "./coordination";

/*
 * The three durable stores of the production native environment (N2 S7B part 1). Files live beside the admission ledger in the Coordination
 * directory (outside every Winter home, so a home wipe or copy neither loses nor forges them); the home binding lives in the home database.
 */
const fail = (code: string): never => { throw new CoworkHostEnvError(code); };
const euid = (): number => process.geteuid?.() ?? -1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const scopeId = (value: unknown): string => typeof value === "string" && ID.test(value) && !value.includes("..") ? value : fail("scope_invalid");
const scopeEpoch = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 0xffff_ffff ? value as number : fail("scope_invalid");
const scopeName = (scope: CoworkNativeReceiptScope, suffix: string): string => `${scopeId(scope.workspaceId)}.${scopeId(scope.incarnationId)}.${scopeEpoch(scope.leaseEpoch)}.${suffix}`;

function readRegular(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const info = fstatSync(fd);
    // The same checks the launcher's own store makes of what it wrote: a regular file, this user's, 0600, one link, bounded.
    if (!info.isFile() || info.uid !== euid() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size < 1 || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size); let read = 0;
    while (read < buffer.length) { const n = readSync(fd, buffer, read, buffer.length - read, read); if (n <= 0) return null; read += n; }
    return buffer;
  } finally { closeSync(fd); }
}
function writeAtomically(directory: string, name: string, bytes: Buffer): void {
  const temporary = join(directory, `.tmp-${randomBytes(8).toString("hex")}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, join(directory, name));
  } catch (error) { try { unlinkSync(temporary); } catch { /* gone */ } throw error; }
  const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

// ------------------------------------------------------------------------------------------------ receipts

/**
 * The launcher's retained receipts (`<dir>/<workspaceId>.<incarnationId>.<leaseEpoch>.receipt`, S2's `DirectoryReceiptStore` format), read back by the daemon.
 *
 * `attested: true` here means ONLY "this file passed the file checks": a regular file, this user's, 0600, one link, within the receipt size bound, opened
 * without following a symlink, parseable, and its scope in the name is the scope in the content. It is NOT authentication: the file is plain text that
 * any process of this user could also have written. The authentication is the receipt's MAC (stop-proof.ts, `mac_invalid`), checked together with both guard
 * probes before anything is released. Anything that fails a check is "no receipt" (null), never an error: an absent receipt is Class B.
 *
 * `retire` unlinks the one file of that scope and tolerates its absence (the live `receipt_retire` races it). It never follows a symlink, never touches another scope.
 */
export function createCoworkReceiptStore(directory: string): CoworkNativeDurableReceiptPort {
  assertOutsideWinterHomes(directory);
  return {
    load(scope) {
      let name: string;
      try { name = scopeName(scope, "receipt"); } catch { return null; }
      const bytes = readRegular(join(directory, name), COWORK_NATIVE_LIMITS.receiptBytes);
      if (bytes === null) return null;
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
      try {
        const receipt = parseCoworkNativeStopReceipt(text);
        if (receipt.workspaceId !== scope.workspaceId || receipt.incarnationId !== scope.incarnationId || receipt.leaseEpoch !== scope.leaseEpoch) return null;
      } catch { return null; }
      return { text, attested: true };
    },
    retire(scope) {
      let name: string;
      try { name = scopeName(scope, "receipt"); } catch { return; }
      try { unlinkSync(join(directory, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    },
  };
}

// ------------------------------------------------------------------------------------------------ launch journal

/** The daemon's own durable record of which processes each launch started. Written BEFORE the spawn, then with each identity; synchronous and atomic. A corrupt or foreign file reads as "no entry". */
export function createCoworkLaunchJournal(directory: string): CoworkNativeLaunchJournalPort {
  ensurePrivateDirectory(directory);
  const fileOf = (scope: CoworkNativeReceiptScope): string => scopeName(scope, "json");
  const sameScope = (entry: CoworkNativeLaunchEntry, scope: CoworkNativeReceiptScope): boolean => entry.workspaceId === scope.workspaceId && entry.incarnationId === scope.incarnationId && entry.leaseEpoch === scope.leaseEpoch;
  return {
    record(entry) {
      const name = fileOf(entry);
      if (typeof entry.bootId !== "string" || !ID.test(entry.bootId)) fail("journal_entry_invalid");
      writeAtomically(directory, name, Buffer.from(`${JSON.stringify(entry)}\n`, "utf8"));
    },
    load(scope) {
      let name: string;
      try { name = fileOf(scope); } catch { return null; }
      const bytes = readRegular(join(directory, name), 4096);
      if (bytes === null) return null;
      try {
        const parsed = JSON.parse(bytes.toString("utf8")) as CoworkNativeLaunchEntry;
        const identity = (value: unknown, instance: boolean): boolean => value === null || (typeof value === "object" && Number.isSafeInteger((value as { pid: number }).pid) && (value as { pid: number }).pid > 0 && typeof (value as { startToken: unknown }).startToken === "string" && (!instance || typeof (value as { instanceId: unknown }).instanceId === "string"));
        if (!sameScope(parsed, scope) || typeof parsed.bootId !== "string" || !identity(parsed.launcher, true) || !identity(parsed.worker, false)) return null;
        return parsed;
      } catch { return null; }
    },
    forget(scope) {
      let name: string;
      try { name = fileOf(scope); } catch { return; }
      try { unlinkSync(join(directory, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    },
  };
}

// ------------------------------------------------------------------------------------------------ home binding

/**
 * The shape DOOR's migration 18 must create (`cowork/schema.ts`, with `cowork_home_binding` added to `COWORK_TABLES`). Until that migration exists the table is missing, the store
 * is unavailable and the production environment cannot be built: the activation stays off by construction. A test pins this text against `schema.ts` once DOOR's migration has merged.
 */
export const COWORK_HOME_BINDING_DDL = `CREATE TABLE IF NOT EXISTS cowork_home_binding (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  home_id TEXT NOT NULL UNIQUE REFERENCES cowork_home_identity(home_id),
  canonical_path TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  directory_id TEXT NOT NULL,
  origin_machine_id TEXT NOT NULL,
  origin_installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;
export interface CoworkHomeBindingStore {
  available(): boolean;
  read(): HostPreparedHomeBinding | null;
  /** Write-once: a second call with a different binding is refused, an identical one is a no-op. Relocation is not a write, it is an owner authorization the ledger denies by default. */
  writeOnce(binding: HostPreparedHomeBinding): void;
}
export function createCoworkHomeBindingStore(rs: RuntimeStateDb, now: () => string = () => new Date().toISOString()): CoworkHomeBindingStore {
  type Row = { home_id: string; canonical_path: string; volume_id: string; directory_id: string; origin_machine_id: string; origin_installation_id: string };
  const same = (a: HostPreparedHomeBinding, b: HostPreparedHomeBinding): boolean => a.homeId === b.homeId && a.canonicalPath === b.canonicalPath && a.volumeId === b.volumeId && a.directoryId === b.directoryId && a.originMachineId === b.originMachineId && a.originInstallationId === b.originInstallationId;
  const store: CoworkHomeBindingStore = {
    available: () => rs.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cowork_home_binding'").get() !== null,
    read() {
      if (!store.available()) return null;
      const row = rs.db.query<Row, []>("SELECT home_id,canonical_path,volume_id,directory_id,origin_machine_id,origin_installation_id FROM cowork_home_binding WHERE singleton=1").get();
      return row ? { homeId: row.home_id, canonicalPath: row.canonical_path, volumeId: row.volume_id, directoryId: row.directory_id, originMachineId: row.origin_machine_id, originInstallationId: row.origin_installation_id } : null;
    },
    writeOnce(binding) {
      if (!store.available()) return fail("home_binding_unavailable");
      const existing = store.read();
      if (existing !== null) { if (!same(existing, binding)) fail("home_binding_conflict"); return; }
      rs.db.run("INSERT INTO cowork_home_binding(singleton,home_id,canonical_path,volume_id,directory_id,origin_machine_id,origin_installation_id,created_at) VALUES(1,?,?,?,?,?,?,?)",
        [binding.homeId, binding.canonicalPath, binding.volumeId, binding.directoryId, binding.originMachineId, binding.originInstallationId, now()]);
    },
  };
  return store;
}
