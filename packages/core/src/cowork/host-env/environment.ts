import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CoworkAdmissionLedger, type AdmissionOwner, type AdmissionProbes, type HomeObservation } from "../admission";
import type { CoworkRepository } from "../repository";
import type { RuntimeStateDb } from "../../runtime-state/db";
import { timeMachineVolumeBackup } from "../volume-backup";
import { createCoworkAdmissionProbes, createProductionHostAdapters, readMachineId, type HostCommandRunner, type ProcessTable, type SysctlReader } from "../native/admission-probes";
import { COWORK_FREE_SPACE_RESERVE_BYTES, createStatfsReader, type FilesystemSpaceReader } from "../native/free-space";
import { CoworkPressureGuard } from "../native/pressure";
import { createCoworkResourceObserver } from "../native/resource-observer";
import { coworkNativeLedgerStopProbe, type CoworkNativeHostBoot } from "../native/stop-proof";
import type { CoworkNativeEnvironment } from "../native-wiring";
import { CoworkHostEnvError, assertDisjointFromHome, assertOutsideWinterHomes, coordinationDirectory, coordinationLedgerFile, ensurePrivateDirectory, loadOrCreateInstallationId } from "./coordination";
import { createCoworkRecoverGuards, processStartToken } from "./guards";
import { createCoworkLauncherPort, type CoworkLauncherPortOptions } from "./launcher-port";
import { createCoworkHomeBindingStore, createCoworkLaunchJournal, createCoworkReceiptStore } from "./stores";
import { readVolumeId } from "./volume-identity";
import { createCoworkOutputsPreparer, createCoworkShareDirectoryOpener } from "./guest-dirs";
import { CoworkGuestRecords } from "./guest-records";
import { createCoworkProvisioningPort, type CoworkVerifiedGuestImage } from "./provisioning";
import { CoworkError } from "../types";
import type { CoordinationPathInputs } from "../native/admission-probes";

/*
 * The production native environment (N2 S7B part 1): every host fact the native wiring needs, assembled from real adapters. NOTHING in the daemon builds it today.
 * It is reachable only through the one activation seam, `cowork/native-activation.ts`, whose body returns `undefined` until the owner flips it.
 *
 * Pure construction inputs: this module never reads `process.env` or the real home directory. The caller passes `coordination` (the same two inputs S6's
 * `coordinationLedgerPath` takes), the daemon's own executable path and the runtime-state handles; a test passes temp directories and fakes for `ioreg`,
 * `sysctl` and the process table, so no real machine id is ever read or printed by a test.
 */

export const COWORK_LAUNCHER_IDENTIFIER = "com.winter.cowork.launcher";
/** What `dev:cowork-native` signs the dev launcher as: the launcher reads which daemon it serves from its OWN signing identifier, so a dev daemon expects this one. */
export const COWORK_LAUNCHER_DEV_IDENTIFIER = "com.winter.cowork.launcher.dev";
export const COWORK_DEFAULT_TEAM = "37N77U9RSZ";
/** Identifier + Winter's team under Apple's anchor, the same form as `scripts/embed-cowork-native.sh` states and `embed-computer-helper.sh` uses. */
export const coworkLauncherRequirement = (team: string = COWORK_DEFAULT_TEAM, identifier: string = COWORK_LAUNCHER_IDENTIFIER): string => `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
/** `Winter.app/Contents/Helpers/WinterCowork/{winter-cowork-launcher,winter-cowork-worker}`, next to `Contents/Resources/winter-core`. */
export function coworkNativeBinaryPaths(executablePath: string): { launcherPath: string; workerPath: string } {
  const base = resolve(dirname(executablePath), "..", "Helpers", "WinterCowork");
  return { launcherPath: join(base, "winter-cowork-launcher"), workerPath: join(base, "winter-cowork-worker") };
}

/** The budget the host admits against (accounting units, chosen by the host): half of the physical memory, half of the logical CPUs (at least 2), at most 2 guests at once. */
export const COWORK_GUEST_LIMIT = 2;
export function coworkResourceBudget(facts: { physicalMemoryBytes: number; logicalCpus: number }) {
  return { memoryBytes: Math.floor(facts.physicalMemoryBytes / 2), cpuUnits: Math.max(2, Math.floor(facts.logicalCpus / 2)), guestLimit: COWORK_GUEST_LIMIT };
}
export const COWORK_PRESSURE_EVALUATE_MS = 5_000;

export interface CoworkNativeProductionOptions {
  readonly home: string;
  readonly db: RuntimeStateDb;
  readonly records: CoworkRepository;
  readonly coordination: CoordinationPathInputs;
  /** The daemon's own executable (`process.execPath` in production). */
  readonly executablePath: string;
  readonly team?: string;
  /** The launcher's signing identifier: the dist one by default, the dev one for the dev daemon (`WINTER_PROFILE=dev`, chosen by the activation seam). */
  readonly launcherIdentifier?: string;
  /** `ioreg`, `sysctl` and the process table. The default is the real ones, created lazily and only here. */
  readonly adapters?: { runCommand: HostCommandRunner; sysctl: SysctlReader; processes: ProcessTable };
  readonly space?: FilesystemSpaceReader;
  readonly volumeId?: (path: string) => string | null;
  readonly launcher?: Partial<Pick<CoworkLauncherPortOptions, "spawn" | "openChannel" | "closeChannelDescriptor" | "verifyProcess" | "checkExecutable" | "helloTimeoutMs">>;
  readonly daemonPid?: number;
  readonly now?: () => number;
  /** The installed image's verified facts (the image lane's manifest check), or null. No reader exists yet, so the default is null and the provisioning port stays unavailable. */
  readonly image?: () => CoworkVerifiedGuestImage | null;
  /** Records the image pin for a workspace (the lifecycle authority behind it is the caller's). The default refuses. */
  readonly pin?: (workspaceId: string, digests: { baseImageDigest: string; runtimeImageDigest: string }) => unknown;
}

export interface CoworkNativeProductionEnvironment extends CoworkNativeEnvironment {
  /** The one probes object the ledger, the host boot and the stop-receipt check all use. */
  readonly probes: AdmissionProbes;
  readonly ledger: CoworkAdmissionLedger;
  /** The disk-pressure guard the ledger's resource observation reads (exposed for tests and diagnostics). */
  readonly pressure: CoworkPressureGuard;
  readonly homeId: string;
  readonly installationId: string;
  readonly receiptDirectory: string;
  readonly journalDirectory: string;
}

/** The host's view of its own boot, derived from the SAME probes object the ledger uses, so the two can never disagree about a boot change. */
export function hostBootFromProbes(probes: Pick<AdmissionProbes, "hostIdentity" | "confirmsPreviousBootEnded">): CoworkNativeHostBoot {
  return {
    bootId() { const host = probes.hostIdentity(); if (host === null) throw new CoworkHostEnvError("host_boot_unreadable"); return host.bootId; },
    confirmsPreviousBootEnded(previous: string) { const host = probes.hostIdentity(); return host !== null && probes.confirmsPreviousBootEnded(previous, host) === true; },
  };
}

export function createCoworkNativeProductionEnvironment(options: CoworkNativeProductionOptions): CoworkNativeProductionEnvironment {
  const adapters = options.adapters ?? createProductionHostAdapters();
  const now = options.now ?? Date.now;
  const directory = coordinationDirectory(options.coordination);
  assertOutsideWinterHomes(directory);
  assertDisjointFromHome(directory, options.home);
  ensurePrivateDirectory(directory);
  const installationId = loadOrCreateInstallationId(directory);

  // ---- home identity: the binding lives in the home database; the machine and installation it names are recorded once, at the first activation
  const store = createCoworkHomeBindingStore(options.db);
  if (!store.available()) throw new CoworkHostEnvError("home_binding_unavailable");
  const homeId = options.records.homeIdentity();
  const canonicalHome = realpathSync(options.home);
  const volumeOf = options.volumeId ?? readVolumeId;
  const homeIdentity = (atPath: string): HomeObservation | null => {
    const canonicalPath = realpathSync(atPath), info = statSync(canonicalPath), volumeId = volumeOf(canonicalPath), binding = store.read();
    return volumeId === null || binding === null ? null : { canonicalPath, volumeId, directoryId: `inode-${info.ino}`, canonicalDbBinding: binding };
  };

  // ---- the ONE probes object
  const probes = createCoworkAdmissionProbes({ runCommand: adapters.runCommand, sysctl: adapters.sysctl, processes: adapters.processes, installationId: () => installationId, homeIdentity, verifyStopReceipt: coworkNativeLedgerStopProbe });
  const hostBoot = hostBootFromProbes(probes);

  // ---- pressure and resources
  let halt: (() => Promise<boolean>) | null = null;
  const space = options.space ?? createStatfsReader();
  const guard = new CoworkPressureGuard({ space, writers: { haltWriters: async () => ({ halted: halt === null ? false : await halt() }) }, reserveBytes: COWORK_FREE_SPACE_RESERVE_BYTES, now });
  guard.watch("home", { kind: "path", path: canonicalHome });
  guard.watch("coordination", { kind: "path", path: directory });
  const observeResources = createCoworkResourceObserver({ sysctl: adapters.sysctl, disk: guard, budget: coworkResourceBudget, now });

  const ledger = new CoworkAdmissionLedger({ path: coordinationLedgerFile(options.coordination), domainId: `winter-user-${process.geteuid?.() ?? 0}`, probes, observeResources, now });
  try {
    let binding = store.read();
    if (binding === null) {
      const machine = readMachineId(adapters.runCommand), info = statSync(canonicalHome), volumeId = volumeOf(canonicalHome);
      if (machine === null || volumeId === null) throw new CoworkHostEnvError("home_binding_unavailable");
      binding = { homeId, canonicalPath: canonicalHome, volumeId, directoryId: `inode-${info.ino}`, originMachineId: machine, originInstallationId: installationId };
      store.writeOnce(binding);
    }
    if (binding.homeId !== homeId) throw new CoworkHostEnvError("home_binding_conflict");
    ledger.registerHome(binding, canonicalHome);
  } catch (error) { try { ledger.close(); } catch { /* closed */ } throw error; }

  // ---- stores beside the ledger, namespaced by the home
  const receiptDirectory = join(directory, "cowork-receipts", homeId), journalDirectory = join(directory, "cowork-launch-journal", homeId);
  assertOutsideWinterHomes(receiptDirectory);
  ensurePrivateDirectory(join(directory, "cowork-receipts")); ensurePrivateDirectory(receiptDirectory);
  const receipts = createCoworkReceiptStore(receiptDirectory);
  ensurePrivateDirectory(join(directory, "cowork-launch-journal"));
  const journal = createCoworkLaunchJournal(journalDirectory);

  const { launcherPath, workerPath } = coworkNativeBinaryPaths(options.executablePath);
  const launcher = createCoworkLauncherPort({ launcherPath, workerPath, receiptDirectory, requirement: coworkLauncherRequirement(options.team, options.launcherIdentifier), processes: adapters.processes, ...options.launcher });

  const instanceNonce = randomBytes(12).toString("hex"), daemonPid = options.daemonPid ?? process.pid;
  const daemon = (): AdmissionOwner => {
    const seen = adapters.processes.inspect(daemonPid), host = probes.hostIdentity();
    if (seen.kind !== "present" || host === null) throw new CoworkHostEnvError("daemon_identity_unreadable");
    return { pid: daemonPid, startToken: processStartToken(seen), bootId: host.bootId, instanceNonce };
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const guestRecords = new CoworkGuestRecords(options.db);
  return {
    launcher, admission: ledger, backup: timeMachineVolumeBackup, hostBoot, daemon, receipts, journal,
    guestRecords, outputs: createCoworkOutputsPreparer(options.home), shareDirectories: createCoworkShareDirectoryOpener(),
    provisioningPort: createCoworkProvisioningPort({ db: options.db, home: options.home, backup: timeMachineVolumeBackup, guestRecords, environmentActive: () => true, image: options.image ?? (() => null), pin: options.pin ?? (() => { throw new CoworkError("unsupported_topology"); }) }),
    guards: ({ volumes }) => createCoworkRecoverGuards({ journal, processes: adapters.processes, bootId: () => probes.hostIdentity()?.bootId ?? null, home: canonicalHome, ownersHeld: workspaceId => volumes.records(workspaceId).some(volume => volume.owner !== null) }),
    probes, ledger, pressure: guard, homeId, installationId, receiptDirectory, journalDirectory,
    bindHost(host) { halt = async () => { const outcomes = await Promise.all(host.activeWorkspaces().map(workspaceId => host.stop(workspaceId, "shutdown").then(outcome => outcome.released, () => false))); return outcomes.every(Boolean); }; },
    async prepareStart() {
      await guard.evaluate();
      timer ??= setInterval(() => { void guard.evaluate().catch(() => {}); }, COWORK_PRESSURE_EVALUATE_MS);
      timer.unref?.();
    },
    close() { if (timer !== null) { clearInterval(timer); timer = null; } try { ledger.close(); } catch { /* closed */ } },
  };
}
