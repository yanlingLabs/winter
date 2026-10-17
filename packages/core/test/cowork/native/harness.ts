import { fstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkAdmissionLedger, type AdmissionOwner, type AdmissionProbes, type HostPreparedHomeBinding, type ProcessObservation, type ResourceObservation } from "../../../src/cowork/admission";
import { CoworkRepository } from "../../../src/cowork/repository";
import { CoworkVolumes, RAW_VOLUME_MIN_BYTES, type CoworkVolumeAuthority } from "../../../src/cowork/volumes";
import type { CoworkVolumeBackup } from "../../../src/cowork/volume-backup";
import { CoworkNativeAuthority } from "../../../src/cowork/native/authority";
import { CoworkNativeHost, CoworkNativeSimulatedCrash, type CoworkNativeHostDeps, type CoworkNativeHostTimeouts } from "../../../src/cowork/native/host";
import { CoworkNativePower } from "../../../src/cowork/native/power";
import { CoworkNativeRecovery, type CoworkNativeDurableReceiptPort, type CoworkNativeOwnerRecoverPort } from "../../../src/cowork/native/recovery";
import { coworkNativeLedgerStopProbe, CoworkNativeStopRegistry, type CoworkNativeHostBoot, type CoworkNativeLaunchEntry, type CoworkNativeLaunchJournalPort, type CoworkNativeRecoverGuards, type CoworkNativeRecoverSubject } from "../../../src/cowork/native/stop-proof";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../../src/runtime-state/db";
import { FakeLauncher, type FakeBehavior } from "./fake-launcher";

export const IMAGE_DIGEST = "d".repeat(64);
const PHASES = ["incarnation-begun", "admission-reserved", "launcher-spawned", "worker-begun", "claimed", "filesystem-intent", "volumes-opened", "transferred", "bootstrap-sent", "receipt-received", "filesystems-confirmed", "ready-sent", "power-running"] as const;
export const START_PHASES: readonly string[] = PHASES;
/** Volume-layer checkpoints that fire inside CoworkVolumes, in sequence order. */
export const VOLUME_PHASES = ["filesystem-intent-committed"] as const;
export const STOP_PHASES = ["drain-requested", "stop-receipt-received", "volumes-released", "admission-released", "power-stopped", "receipt-retired"] as const;

export interface HarnessOptions {
  readonly behavior?: FakeBehavior; readonly crashAt?: string; readonly timeouts?: Partial<CoworkNativeHostTimeouts>;
  readonly volumeCheckpoint?: (phase: string) => void;
  /** Runs at every host checkpoint, before a crash is raised: lets a test change the world between two steps of a start. */
  readonly onCheckpoint?: (phase: string, harness: Harness) => void;
}
export interface Harness {
  readonly root: string; readonly home: string; readonly workspaceId: string; readonly homeId: string;
  db: RuntimeStateDb; records: CoworkRepository; volumes: CoworkVolumes; ledger: CoworkAdmissionLedger; authority: CoworkNativeAuthority; registry: CoworkNativeStopRegistry;
  power: CoworkNativePower; recovery: CoworkNativeRecovery; host: CoworkNativeHost; launcher: FakeLauncher; deps: CoworkNativeHostDeps;
  hostBoot: CoworkNativeHostBoot & { current: string; ended: boolean };
  receipts: Map<string, string>; ownerRecoverAttestation: { value: unknown };
  guards: { processAbsent: boolean; imagesUnlocked: boolean; seen: CoworkNativeRecoverSubject[] };
  /** The test clock shared by the admission ledger and the host, in ms; `advance` moves it. */
  clock: { now: number; advance(ms: number): void };
  /** The host's repeating timers, driven by hand: `tick()` runs every registered callback once. */
  timers: { active: number; tick(): void };
  /** The launch journal (in memory) and the switches of the fakes the recovery reads. */
  journal: Map<string, CoworkNativeLaunchEntry>;
  attested: boolean; ledgerAgrees: boolean;
  daemon: AdmissionOwner;
  /** Calls observed on the release paths (spies). */
  calls: { volumeRelease: number; ledgerRelease: number; reconcile: number };
  events: string[];
  /** Replace every in-memory object with a fresh one over the same files, as a new daemon process would have. */
  restart(options?: { newBoot?: boolean; behavior?: FakeBehavior; crashAt?: string; volumeCheckpoint?: (phase: string) => void }): void;
  setBehavior(behavior: FakeBehavior): void;
  stopAll(): void;
  /** Another retained workspace with its own allocated volume pair (so two workspaces can be in flight at once). */
  addWorkspace(): string;
  dispose(): void;
}

const roots: string[] = [];
export function cleanupHarnesses(): void { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); }

export function createHarness(options: HarnessOptions = {}): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-native-host-"))); roots.push(root);
  const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
  const coordination = join(root, "coordination", "admission.sqlite");
  const excluded = new Set<string>(), key = (fd: number) => { const st = fstatSync(fd); return `${st.dev}:${st.ino}`; };
  const backup: CoworkVolumeBackup = { excludeItem: (_path: string, fd: number) => { excluded.add(key(fd)); }, verifyItemExcluded: (_path: string, fd: number) => excluded.has(key(fd)), verifyDescriptorExcluded: (fd: number) => excluded.has(key(fd)) };

  let db = openRuntimeStateDb(home);
  const seed = new CoworkRepository(db); const homeId = seed.homeIdentity();
  const made = seed.create({ principalId: "fixture-user", requestId: "create" }, { ownership: "project", title: "Fixture", sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }], ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" } });
  const workspaceId = made.workspaceId;
  // Provisioning is NOT on the native launch path: the native authority refuses `allocate`, so a separate permissive authority allocates.
  const provisioning: CoworkVolumeAuthority = { authorize: action => action === "allocate", verifyStopped: () => false };
  const provisioner = new CoworkVolumes(db, home, provisioning, backup);
  provisioner.allocate({ workspaceId, proof: {}, owner: { controllerInstanceId: "provision", workerInstanceId: "provision", incarnationId: "provision", leaseEpoch: 1, runtimeImageDigest: IMAGE_DIGEST } }, { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES });

  // ---- shared fakes that survive a restart (the "disk" and the "OS")
  const hostBoot = { current: "boot-one", ended: false, bootId() { return this.current; }, confirmsPreviousBootEnded(previous: string) { return this.ended && previous !== this.current; } };
  const processes = new Map<number, ProcessObservation>();
  const persisted = new Map<string, HostPreparedHomeBinding>();
  const receipts = new Map<string, string>();
  const calls = { volumeRelease: 0, ledgerRelease: 0, reconcile: 0 };
  const events: string[] = [];
  const guards = { processAbsent: true, imagesUnlocked: true, seen: [] as CoworkNativeRecoverSubject[] };
  const clock = { now: 1_000_000, advance(ms: number) { this.now += ms; } };
  const callbacks = new Set<() => void>();
  const timers = { get active() { return callbacks.size; }, tick() { [...callbacks].forEach(run => run()); }, every(_ms: number, run: () => void) { callbacks.add(run); return () => { callbacks.delete(run); }; } };
  const journal = new Map<string, CoworkNativeLaunchEntry>();
  const switches = { attested: true, ledgerAgrees: true };
  const journalPort: CoworkNativeLaunchJournalPort = {
    record: entry => { journal.set(`${entry.workspaceId}|${entry.incarnationId}|${entry.leaseEpoch}`, structuredClone(entry)); },
    load: scope => structuredClone(journal.get(`${scope.workspaceId}|${scope.incarnationId}|${scope.leaseEpoch}`) ?? null),
    forget: scope => { journal.delete(`${scope.workspaceId}|${scope.incarnationId}|${scope.leaseEpoch}`); },
  };
  const ownerRecoverAttestation: { value: unknown } = { value: null };
  const resources: ResourceObservation = { budget: { memoryBytes: 64 * 1024 ** 3, cpuUnits: 64, guestLimit: 8 }, pressure: "normal", admitNew: true, observedAt: 0, validUntil: Number.MAX_SAFE_INTEGER };
  const machine = { machineId: "machine-fixture", installationId: "installation-fixture" };
  const probes: AdmissionProbes = {
    hostIdentity: () => ({ ...machine, bootId: hostBoot.current }),
    homeIdentity: atPath => { try { const canonicalPath = realpathSync(atPath), st = statSync(canonicalPath), identity = persisted.get(canonicalPath); return identity ? { canonicalPath, volumeId: `dev-${st.dev}`, directoryId: `inode-${st.ino}`, canonicalDbBinding: { ...identity } } : null; } catch { return null; } },
    processIdentity: pid => processes.get(pid) ?? { state: "unknown" },
    verifyStopReceipt: coworkNativeLedgerStopProbe,
    confirmsPreviousBootEnded: previous => switches.ledgerAgrees && hostBoot.confirmsPreviousBootEnded(previous),
    authorizeRelocation: () => false,
  };
  const st = statSync(home);
  const binding: HostPreparedHomeBinding = { homeId, canonicalPath: home, volumeId: `dev-${st.dev}`, directoryId: `inode-${st.ino}`, originMachineId: machine.machineId, originInstallationId: machine.installationId };
  persisted.set(home, binding);

  let sequence = 0;
  const harness = { root, home, workspaceId, homeId, hostBoot, receipts, guards, ownerRecoverAttestation, calls, events, clock, timers, journal } as unknown as Harness;
  Object.defineProperties(harness, { attested: { get: () => switches.attested, set: (value: boolean) => { switches.attested = value; } }, ledgerAgrees: { get: () => switches.ledgerAgrees, set: (value: boolean) => { switches.ledgerAgrees = value; } } });

  function build(boot: { behavior?: FakeBehavior; crashAt?: string; volumeCheckpoint?: (phase: string) => void; timeouts?: Partial<CoworkNativeHostTimeouts> }): void {
    sequence += 1;
    const pid = 70_000 + sequence, daemon: AdmissionOwner = { pid, startToken: `start-${sequence}`, bootId: hostBoot.current, instanceNonce: `nonce-${sequence}` };
    for (const [other] of processes) processes.set(other, { state: "dead" });
    processes.set(pid, { state: "alive", startToken: daemon.startToken, bootId: daemon.bootId });
    harness.db = db;
    harness.records = new CoworkRepository(db);
    harness.registry = new CoworkNativeStopRegistry();
    harness.authority = new CoworkNativeAuthority({ records: harness.records, hostBoot, registry: harness.registry });
    const crashAt = boot.crashAt, volumeCheckpoint = boot.volumeCheckpoint;
    harness.volumes = new CoworkVolumes(db, home, harness.authority.volumes, backup, phase => { events.push(`volumes:${phase}`); volumeCheckpoint?.(phase); }, harness.authority.filesystem);
    // Spy on the two release doors without changing them.
    const realRelease = harness.volumes.release.bind(harness.volumes);
    harness.volumes.release = ((...args: Parameters<CoworkVolumes["release"]>) => { calls.volumeRelease += 1; return realRelease(...args); }) as CoworkVolumes["release"];
    harness.ledger = new CoworkAdmissionLedger({ path: coordination, domainId: "fixture-user-domain", probes, observeResources: () => resources, now: () => clock.now, heartbeatTimeoutMs: 30_000 });
    try { harness.ledger.registerHome(binding, home); } catch { /* already registered by an earlier instance */ }
    const realLedgerRelease = harness.ledger.release.bind(harness.ledger), realReconcile = harness.ledger.reconcile.bind(harness.ledger);
    harness.ledger.release = ((...args: Parameters<CoworkAdmissionLedger["release"]>) => { calls.ledgerRelease += 1; return realLedgerRelease(...args); }) as CoworkAdmissionLedger["release"];
    harness.ledger.reconcile = (() => { calls.reconcile += 1; return realReconcile(); }) as CoworkAdmissionLedger["reconcile"];
    harness.power = new CoworkNativePower(db);
    const durable: CoworkNativeDurableReceiptPort = {
      load: scope => { const text = receipts.get(`${scope.workspaceId}|${scope.incarnationId}|${scope.leaseEpoch}`); return text === undefined ? null : { text, attested: switches.attested as true }; },
      retire: scope => { receipts.delete(`${scope.workspaceId}|${scope.incarnationId}|${scope.leaseEpoch}`); },
    };
    const ownerRecover: CoworkNativeOwnerRecoverPort = { confirm: () => ownerRecoverAttestation.value as never };
    const recoveryGuards: CoworkNativeRecoverGuards = { processAbsent: subject => { guards.seen.push(subject); return guards.processAbsent; }, imagesUnlocked: () => guards.imagesUnlocked };
    const checkpoint = (phase: string) => { events.push(`host:${phase}`); options.onCheckpoint?.(phase, harness); if (crashAt === phase) throw new CoworkNativeSimulatedCrash(phase); };
    harness.recovery = new CoworkNativeRecovery({ records: harness.records, volumes: harness.volumes, admission: harness.ledger, power: harness.power, registry: harness.registry, hostBoot, receipts: durable, ownerRecover, guards: recoveryGuards, journal: journalPort, now: () => clock.now, checkpoint });
    harness.launcher = new FakeLauncher({ behavior: boot.behavior ?? {}, homeId, hostBootId: () => hostBoot.current, receipts, events });
    harness.daemon = daemon;
    const deps: CoworkNativeHostDeps = {
      records: harness.records, volumes: harness.volumes, admission: harness.ledger, authority: harness.authority, power: harness.power, recovery: harness.recovery, registry: harness.registry, hostBoot,
      launcher: harness.launcher, images: { runtimeImageDigest: () => IMAGE_DIGEST }, daemon: () => daemon, journal: journalPort, timers, timeouts: { begunMs: 400, volumesMs: 400, guestHelloMs: 400, receiptMs: 400, mountedMs: 400, stopGraceMs: 150, drainBudgetMs: 150, ...boot.timeouts },
      now: () => clock.now, checkpoint, mint: { suffix: () => sequence.toString(16).padStart(8, "0") },
    };
    harness.deps = deps;
    harness.host = new CoworkNativeHost(deps);
  }
  harness.restart = (restartOptions = {}) => {
    harness.stopAll();
    try { harness.ledger.close(); } catch { /* closed */ }
    db.close(); db = openRuntimeStateDb(home);
    if (restartOptions.newBoot) hostBoot.current = `boot-${sequence + 2}`;
    build({ behavior: restartOptions.behavior, crashAt: restartOptions.crashAt, volumeCheckpoint: restartOptions.volumeCheckpoint, timeouts: options.timeouts });
  };
  let extra = 0;
  harness.addWorkspace = () => {
    const made = harness.records.create({ principalId: "fixture-user", requestId: `create-extra-${++extra}` }, { ownership: "project", title: `Extra ${extra}`, sources: [{ kind: "folder", label: "Extra", access: "read-write", detail: { grantRef: `extra-grant-${extra}`, rootIdentity: `extra-root-${extra}` } }], ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" } });
    new CoworkVolumes(db, home, provisioning, backup).allocate({ workspaceId: made.workspaceId, proof: {}, owner: { controllerInstanceId: "provision", workerInstanceId: "provision", incarnationId: "provision", leaseEpoch: 1, runtimeImageDigest: IMAGE_DIGEST } }, { data: RAW_VOLUME_MIN_BYTES, environment: RAW_VOLUME_MIN_BYTES });
    return made.workspaceId;
  };
  harness.setBehavior = behavior => { harness.launcher.behavior = behavior; };
  harness.stopAll = () => { harness.launcher?.killAll(); };
  harness.dispose = () => { harness.stopAll(); try { harness.ledger.close(); } catch { /* closed */ } try { db.close(); } catch { /* closed */ } };
  build({ behavior: options.behavior, crashAt: options.crashAt, volumeCheckpoint: options.volumeCheckpoint, timeouts: options.timeouts });
  return harness;
}
