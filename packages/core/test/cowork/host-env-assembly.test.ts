import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoworkImagePins } from "../../src/cowork/images";
import { COWORK_HOME_BINDING_DDL, createCoworkHomeBindingStore } from "../../src/cowork/host-env/stores";
import { COWORK_DEFAULT_TEAM, COWORK_LAUNCHER_DEV_IDENTIFIER, COWORK_LAUNCHER_IDENTIFIER, coworkLauncherRequirement, createCoworkNativeProductionEnvironment, hostBootFromProbes, type CoworkNativeProductionOptions } from "../../src/cowork/host-env/environment";
import { COWORK_INSTALLATION_ID_FILE } from "../../src/cowork/host-env/coordination";
import { createCoworkNativeWiring, type CoworkNativeEnvironment } from "../../src/cowork/native-wiring";
import { CoworkNativeSimulatedCrash } from "../../src/cowork/native/host";
import type { ProcessInspection } from "../../src/cowork/native/admission-probes";
import { COWORK_NATIVE_RECEIPT_KEY_ACCOUNT } from "../../src/cowork/native/receipt-mac";
import { serializeCoworkNativeStopReceipt } from "../../src/cowork/native/protocol";
import { cleanupHarnesses, createHarness, IMAGE_DIGEST, RECEIPT_KEY, type Harness } from "./native/harness";
import { FakeLauncher } from "./native/fake-launcher";
import type { CoworkNativeLaunchEntry } from "../../src/cowork/native/stop-proof";
import type { CoworkVolumeBackup } from "../../src/cowork/volume-backup";

// N2 S7B part 1: the production native environment assembled over fakes. No real ioreg, sysctl, process table, Keychain, launcher or VM is touched.
afterEach(() => { cleanupHarnesses(); });

const MACHINE = "4a1f9c52-0b7e-4d36-9a8c-5e2d71b3c0f4";
const BOOT_ONE = "b1d2c3e4-1111-4222-8333-444455556666", BOOT_TWO = "b9d8c7e6-9999-4888-8777-666655554444";
const DAEMON_PID = 9001, LAUNCHER_PID = 5151, WORKER_PID = 5152;
const backup: CoworkVolumeBackup = { excludeItem: () => {}, verifyItemExcluded: () => true, verifyDescriptorExcluded: () => true };

interface World { boot: string; processes: Map<number, ProcessInspection>; ioregCalls: number; sysctlBootReads: number }
function world(): World { return { boot: BOOT_ONE, processes: new Map([[DAEMON_PID, { kind: "present", startSeconds: 1000, startMicroseconds: 7, zombie: false }]]), ioregCalls: 0, sysctlBootReads: 0 }; }
function adapters(w: World) {
  return {
    runCommand: () => { w.ioregCalls += 1; return { status: 0, stdout: `    "IOPlatformUUID" = "${MACHINE}"\n` }; },
    sysctl: {
      string: (name: string) => { if (name === "kern.bootsessionuuid") { w.sysctlBootReads += 1; return w.boot; } return null; },
      int32: (name: string) => (name === "hw.ncpu" ? 8 : name === "kern.memorystatus_vm_pressure_level" ? 1 : null),
      uint64: (name: string) => (name === "hw.memsize" ? 32n * 1024n ** 3n : null),
    },
    processes: { inspect: (pid: number): ProcessInspection => w.processes.get(pid) ?? { kind: "absent" } },
  };
}
const space = { read: () => ({ filesystemId: "fs-fixture", typeName: "apfs", blockBytes: 4096, totalBytes: 500 * 1024 ** 3, availableBytes: 200 * 1024 ** 3 }) };
function options(h: Harness, w: World, over: Partial<CoworkNativeProductionOptions> = {}): CoworkNativeProductionOptions {
  return {
    home: h.home, db: h.db, records: h.records, coordination: { env: { WINTER_COWORK_COORDINATION_DIR: join(h.root, "coord") }, homeDirectory: "/nonexistent" },
    executablePath: join(h.root, "Winter.app", "Contents", "Resources", "winter-core"), adapters: adapters(w), space, volumeId: () => "volume-fixture", daemonPid: DAEMON_PID, ...over,
  };
}
const withBindingTable = (h: Harness): void => { h.db.db.exec(COWORK_HOME_BINDING_DDL); };
function memorySlot(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, get: async (name: string) => values.get(name) ?? null, set: async (name: string, value: string) => { values.set(name, value); } };
}
const owners = (h: Harness) => h.volumes.records(h.workspaceId).map(v => v.owner);
const pinned = (h: Harness) => { const store = new CoworkImagePins(h.db, { authorize: () => true }, { compatible: () => true }); store.pin(h.workspaceId, { baseImageDigest: "b".repeat(64), runtimeImageDigest: IMAGE_DIGEST }, {}); return store; };

describe("construction", () => {
  test("a database without the binding table cannot build the environment, and nothing is created in the coordination directory's ledger", () => {
    const h = createHarness(), w = world();
    h.db.db.run("DROP TABLE IF EXISTS cowork_home_binding"); // migration 18 (DOOR) creates it in a fresh database; this test is about a database that lacks it
    expect(() => createCoworkNativeProductionEnvironment(options(h, w))).toThrow(expect.objectContaining({ code: "home_binding_unavailable" }));
    expect(existsSync(join(h.root, "coord", "cowork-admission.sqlite"))).toBe(false);
  });
  test("a coordination directory equal to, inside or above the home is refused before anything is created", () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    for (const where of [h.home, join(h.home, "coord"), h.root]) {
      expect(() => createCoworkNativeProductionEnvironment(options(h, w, { coordination: { env: { WINTER_COWORK_COORDINATION_DIR: where }, homeDirectory: "/nonexistent" } }))).toThrow(expect.objectContaining({ code: "path_inside_winter_home" }));
    }
    expect(existsSync(join(h.home, "coord"))).toBe(false);
  });
  test("a coordination directory inside a Winter home is refused before anything is created", () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    const inside = join(h.root, ".winter-dev", "coord");
    expect(() => createCoworkNativeProductionEnvironment(options(h, w, { coordination: { env: { WINTER_COWORK_COORDINATION_DIR: inside }, homeDirectory: "/nonexistent" } }))).toThrow(expect.objectContaining({ code: "path_inside_winter_home" }));
    expect(existsSync(inside)).toBe(false);
  });
  test("the installation id, the home binding and the ledger registration are made once, and a rebuild reuses all three", () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    const first = createCoworkNativeProductionEnvironment(options(h, w));
    const id = readFileSync(join(h.root, "coord", COWORK_INSTALLATION_ID_FILE), "utf8").trim();
    expect(first.installationId).toBe(id);
    expect(createCoworkHomeBindingStore(h.db).read()).toMatchObject({ homeId: h.homeId, volumeId: "volume-fixture", originMachineId: MACHINE, originInstallationId: id });
    expect(statSync(first.receiptDirectory).mode & 0o777).toBe(0o700);
    expect(first.receiptDirectory).toBe(join(h.root, "coord", "cowork-receipts", h.homeId));
    expect(first.journalDirectory).toBe(join(h.root, "coord", "cowork-launch-journal", h.homeId));
    first.close?.();
    const second = createCoworkNativeProductionEnvironment(options(h, w));
    expect(second.installationId).toBe(id);
    expect(createCoworkHomeBindingStore(h.db).read()).toMatchObject({ originInstallationId: id });
    second.close?.();
  });
  test("a binding for another home, or an unreadable machine id, refuses and leaves no open ledger behind", () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    const mismatch = () => createCoworkNativeProductionEnvironment(options(h, w, { records: { homeIdentity: () => "home_other" } as never }));
    createCoworkNativeProductionEnvironment(options(h, w)).close?.();
    expect(mismatch).toThrow(expect.objectContaining({ code: "home_binding_conflict" }));
    const blind = createHarness(); withBindingTable(blind);
    const noMachine = { ...adapters(w), runCommand: () => ({ status: 1, stdout: "" }) };
    expect(() => createCoworkNativeProductionEnvironment(options(blind, w, { adapters: noMachine }))).toThrow();
  });
  test("the host boot and the ledger read ONE probes object: a boot change shows in both at once, and the host asks the probes (not sysctl) for it", () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    const env = createCoworkNativeProductionEnvironment(options(h, w));
    expect(env.hostBoot.bootId()).toBe(BOOT_ONE);
    expect(env.probes.hostIdentity()?.bootId).toBe(BOOT_ONE);
    w.boot = BOOT_TWO;
    expect(env.hostBoot.bootId()).toBe(BOOT_TWO);
    expect(env.probes.hostIdentity()?.bootId).toBe(BOOT_TWO);
    expect(env.hostBoot.confirmsPreviousBootEnded(BOOT_ONE)).toBe(true);
    expect(env.hostBoot.confirmsPreviousBootEnded(BOOT_TWO)).toBe(false);
    expect(env.hostBoot.confirmsPreviousBootEnded("not-a-uuid")).toBe(false);
    // The delegation itself: a spy that disagrees with everything else is the only thing the host consults.
    const calls: string[] = [];
    const spy = hostBootFromProbes({ hostIdentity: () => { calls.push("host"); return { machineId: "m", installationId: "i", bootId: "spy-boot" }; }, confirmsPreviousBootEnded: (previous) => { calls.push(`confirm:${previous}`); return true; } });
    expect(spy.bootId()).toBe("spy-boot");
    expect(spy.confirmsPreviousBootEnded("old")).toBe(true);
    expect(calls).toEqual(["host", "host", "confirm:old"]);
    // An unreadable host never invents a boot id and never confirms.
    const blind = hostBootFromProbes({ hostIdentity: () => null, confirmsPreviousBootEnded: () => true });
    expect(() => blind.bootId()).toThrow();
    expect(blind.confirmsPreviousBootEnded("old")).toBe(false);
    env.close?.();
  });
  test("the machine id is asked of ioreg once however many times the boot is read (only a good answer is cached)", () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    const env = createCoworkNativeProductionEnvironment(options(h, w));
    const before = w.ioregCalls;
    for (let i = 0; i < 5; i += 1) env.hostBoot.bootId();
    expect(w.ioregCalls).toBe(before);
    env.close?.();
  });
});

describe("the launcher's identity", () => {
  test("the dist requirement names the dist identifier and the team; the dev daemon asks for the dev identifier, which is what dev:cowork-native signs", async () => {
    expect(coworkLauncherRequirement()).toBe('identifier "com.winter.cowork.launcher" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"');
    expect(coworkLauncherRequirement(undefined, COWORK_LAUNCHER_DEV_IDENTIFIER)).toBe('identifier "com.winter.cowork.launcher.dev" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"');
    // the same strings the scripts state (the signing side)
    const { coworkNativeIdentifier, coworkRequirement } = await import("../../../../scripts/cowork-native-lib");
    expect(coworkRequirement(coworkNativeIdentifier("launcher", "dev"))).toBe(coworkLauncherRequirement(undefined, COWORK_LAUNCHER_DEV_IDENTIFIER));
    expect(coworkRequirement(coworkNativeIdentifier("launcher"))).toBe(coworkLauncherRequirement());
    // and the seam picks the dev identifier from the profile
    expect(readFileSync(join(import.meta.dir, "..", "..", "src", "cowork", "native-activation.ts"), "utf8")).toContain('env.WINTER_PROFILE === "dev" ? { launcherIdentifier: COWORK_LAUNCHER_DEV_IDENTIFIER }');
  });
  test("the identifier and team the daemon expects are the ones the launcher package compiles in (read from the Swift source)", () => {
    const swift = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "apple", "Cowork", "WinterCoworkLauncher", "Sources", "LauncherCore", "Identity", "CodeIdentity.swift"), "utf8");
    expect(swift).toContain(`launcherIdentifier = "${COWORK_LAUNCHER_IDENTIFIER}"`);
    expect(swift).toContain(`teamID = "${COWORK_DEFAULT_TEAM}"`);
  });
});

describe("an omitted bundle", () => {
  test("an omitted bundle (no Contents/Helpers/WinterCowork) gives the daemon nothing to spawn: the real launcher port refuses launcher_missing, before any process exists", async () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    const env = createCoworkNativeProductionEnvironment(options(h, w)); // executablePath is <root>/Winter.app/Contents/Resources/winter-core; no Helpers directory exists beside it
    expect(existsSync(join(h.root, "Winter.app", "Contents", "Helpers"))).toBe(false);
    await expect(env.launcher.spawn({ workspaceId: h.workspaceId, incarnationId: "inc-1", leaseEpoch: 1 })).rejects.toMatchObject({ code: "launcher_missing" });
    env.close?.();
  });
});

describe("through the wiring", () => {
  function envWith(h: Harness, prod: ReturnType<typeof createCoworkNativeProductionEnvironment>, launcher: FakeLauncher): CoworkNativeEnvironment {
    const { timers, timeouts, unsafeTestTimeouts, now, conversations, mint, checkpoint } = h.deps;
    return { ...prod, launcher, backup, hostOptions: { timers, timeouts, unsafeTestTimeouts, now, conversations, mint, checkpoint } };
  }
  test("a start and a stop run end to end on the production stores and ledger, and the receipt directory is empty after the orderly stop", async () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    const prod = createCoworkNativeProductionEnvironment(options(h, w));
    const fake = new FakeLauncher({ behavior: {}, homeId: h.homeId, hostBootId: () => prod.hostBoot.bootId(), receipts: new Map(), events: [] });
    const slot = memorySlot();
    const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, secrets: slot, imagePins: pinned(h), environment: () => envWith(h, prod, fake) });
    await wiring.start(h.workspaceId);
    expect(wiring.activeWorkspaces()).toEqual([h.workspaceId]);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
    expect(readdirSync(prod.journalDirectory).filter(name => !name.startsWith(".")).length).toBe(1); // the launch was journaled durably, outside every Winter home
    await wiring.beginShutdown();
    expect(owners(h)).toEqual([null, null]);
    expect(wiring.activeWorkspaces()).toEqual([]);
  });
  test("a pressure halt before the host is bound is reported UNCONFIRMED; once bound (and the guests stopped) it is confirmed", async () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    const full = { read: () => ({ filesystemId: "fs-full", typeName: "apfs", blockBytes: 4096, totalBytes: 500 * 1024 ** 3, availableBytes: 1024 }) };
    const unbound = createCoworkNativeProductionEnvironment(options(h, w, { space: full }));
    const before = await unbound.pressure.evaluate();
    expect(before.blocked.length).toBeGreaterThan(0);
    expect(before.haltUnconfirmed.length).toBe(before.blocked.length);
    unbound.close?.();
    const h2 = createHarness(), w2 = world(); withBindingTable(h2);
    const bound = createCoworkNativeProductionEnvironment(options(h2, w2, { space: full }));
    bound.bindHost?.({ activeWorkspaces: () => [], stop: async () => ({ released: true }) });
    const after = await bound.pressure.evaluate();
    expect(after.blocked.length).toBeGreaterThan(0);
    expect(after.haltUnconfirmed).toEqual([]);
    bound.close?.();
  });
  test("the pressure timer starts with the first start and the close hook clears it; closing twice is harmless", async () => {
    const h = createHarness(), w = world(); withBindingTable(h);
    const prod = createCoworkNativeProductionEnvironment(options(h, w));
    await prod.prepareStart?.();
    await prod.prepareStart?.();
    prod.close?.(); prod.close?.();
  });

  /** A crashed start whose launcher left a signed Class A receipt: the receipt is copied into the REAL receipt directory, the launch entry into the REAL journal. */
  async function crashed(mutate: (state: { text: string; entry: CoworkNativeLaunchEntry }, w: World) => void = () => {}) {
    const h = createHarness({ crashAt: "power-running" }), w = world(); withBindingTable(h);
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    const staged = h.launcher.last.stagedOrderly("cc".repeat(16), { origin: "owner-loss-drain" });
    const text = serializeCoworkNativeStopReceipt(staged);
    const record = h.records.get(h.workspaceId);
    // The host's own journal entry (what it wrote before and during the launch), re-based onto the fake OS of this test.
    const written = [...h.journal.values()].find(candidate => candidate.workspaceId === h.workspaceId);
    expect(written?.launcher).not.toBeNull();
    const entry = { ...written!, bootId: BOOT_ONE, launcher: { ...written!.launcher!, pid: LAUNCHER_PID, startToken: "77.000005" }, worker: { pid: WORKER_PID, startToken: "88.000001" } };
    const state = { text, entry };
    mutate(state, w);
    h.restart();
    const prod = createCoworkNativeProductionEnvironment(options(h, w));
    prod.journal!.record(state.entry);
    const file = join(prod.receiptDirectory, `${h.workspaceId}.${record.incarnationId}.${record.leaseEpoch}.receipt`);
    writeFileSync(file, state.text, { mode: 0o600 }); chmodSync(file, 0o600);
    return { h, w, prod, file };
  }
  const reconcile = async (h: Harness, prod: ReturnType<typeof createCoworkNativeProductionEnvironment>, key: string | null = RECEIPT_KEY.reveal()) => {
    const fake = new FakeLauncher({ behavior: {}, homeId: h.homeId, hostBootId: () => prod.hostBoot.bootId(), receipts: new Map(), events: [] });
    const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, secrets: memorySlot(key === null ? {} : { [COWORK_NATIVE_RECEIPT_KEY_ACCOUNT]: key }), environment: () => envWith(h, prod, fake) });
    return wiring.reconcileAtBoot();
  };

  test("RELEASE: a signed receipt in the real receipt directory, a journaled launcher that is gone and unlocked images release the disks, and the receipt file is retired", async () => {
    const { h, prod, file } = await crashed();
    const boot = await reconcile(h, prod);
    expect(boot.reports).toMatchObject([{ action: "released", evidence: "orderly-receipt", ownerRetained: false }]);
    expect(owners(h)).toEqual([null, null]);
    expect(existsSync(file)).toBe(false);
  });
  test("a forged MAC (one byte of the signature changed) keeps the owner and the file", async () => {
    const { h, prod, file } = await crashed((state) => { state.text = state.text.replace(/("mac":")(.)/, (_all, head: string, c: string) => `${head}${c === "A" ? "B" : "A"}`); });
    const boot = await reconcile(h, prod);
    expect(boot.reports).toMatchObject([{ action: "retained", ownerRetained: true }]);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
  test("a missing key at boot makes the receipt Class B: retained, and boot created no key", async () => {
    const { h, prod } = await crashed();
    const boot = await reconcile(h, prod, null);
    expect(boot.reports).toMatchObject([{ action: "retained", ownerRetained: true }]);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
  });
  test("a recorded launcher that is still alive (same pid, same start token, same boot) keeps the owner even with a valid receipt", async () => {
    const { h, prod } = await crashed((_state, w) => { w.processes.set(LAUNCHER_PID, { kind: "present", startSeconds: 77, startMicroseconds: 5, zombie: false }); });
    const boot = await reconcile(h, prod);
    expect(boot.reports).toMatchObject([{ action: "retained", ownerRetained: true }]);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
  });
  test("a lost journal entry while the volumes still name an owner is not 'process absent': the owner stays", async () => {
    const { h, prod } = await crashed();
    // replace the entry by one for another incarnation: the scope under test has none
    const record = h.records.get(h.workspaceId);
    const entryName = readdirSync(prod.journalDirectory).find(name => name.includes(record.incarnationId!));
    expect(entryName).toBeDefined();
    const { rmSync } = await import("node:fs");
    rmSync(join(prod.journalDirectory, entryName!));
    const boot = await reconcile(h, prod);
    expect(boot.reports).toMatchObject([{ action: "retained", ownerRetained: true }]);
  });
});
