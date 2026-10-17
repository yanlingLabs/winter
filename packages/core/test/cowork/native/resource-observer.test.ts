import { afterEach, expect, test } from "bun:test";
import type { AdmissionOwner, ResourceObservation } from "../../../src/cowork/admission";
import { createCoworkAdmissionProbes, createProductionHostAdapters, type SysctlReader } from "../../../src/cowork/native/admission-probes";
import { COWORK_FREE_SPACE_RESERVE_BYTES, type FilesystemSpace } from "../../../src/cowork/native/free-space";
import { CoworkPressureGuard, type WriterHaltPort } from "../../../src/cowork/native/pressure";
import {
  RESOURCE_DISK_SAMPLE_MAX_AGE_MS, RESOURCE_OBSERVATION_VALIDITY_MS, createCoworkResourceObserver, diskPressureFromSnapshot, memoryPressureFromLevel,
  type DiskPressureSource, type ResourceBudgetPolicy,
} from "../../../src/cowork/native/resource-observer";
import { ledgerFixture } from "./pressure-ledger-fixture";

const GiB = 1024 ** 3, R = COWORK_FREE_SPACE_RESERVE_BYTES;
const real = process.platform === "darwin" && process.arch === "arm64" ? test : test.skip;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const NOW = 1_700_000_000_000;
function sysctlWith(values: { memsize?: bigint | null; ncpu?: number | null; level?: number | null | "throw" }): SysctlReader {
  return {
    string: () => null,
    uint64: name => name === "hw.memsize" ? (values.memsize === undefined ? 16n * 1024n ** 3n : values.memsize) : null,
    int32: name => {
      if (name === "hw.ncpu") return values.ncpu === undefined ? 8 : values.ncpu;
      if (name === "kern.memorystatus_vm_pressure_level") { if (values.level === "throw") throw new Error("x"); return values.level === undefined ? 1 : values.level; }
      return null;
    },
  };
}
const budget: ResourceBudgetPolicy = facts => ({ memoryBytes: Math.floor(facts.physicalMemoryBytes / 2), cpuUnits: facts.logicalCpus, guestLimit: 2 });
const disk = (evaluatedAt: number | null, entries: Array<{ state: "clear" | "blocked"; observed?: boolean }>): DiskPressureSource => ({ snapshot: () => ({ evaluatedAt, entries: entries.map(e => ({ state: e.state, observed: e.observed ?? true })) }) });
const healthy = disk(NOW - 1000, [{ state: "clear" }]);
const observe = (sysctl: SysctlReader, source: DiskPressureSource = healthy, extra: Partial<Parameters<typeof createCoworkResourceObserver>[0]> = {}) =>
  createCoworkResourceObserver({ sysctl, disk: source, budget, now: () => NOW, ...extra })();

test("memory pressure levels map 1/2/4 and everything else is unknown", () => {
  expect([1, 2, 4, 0, 3, 5, 8, -1, null].map(memoryPressureFromLevel)).toEqual(["normal", "elevated", "critical", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  expect(memoryPressureFromLevel(Number.NaN)).toBe("unknown");
});
test("disk pressure: unknown unless a recent evaluation observed every watched filesystem; blocked is critical", () => {
  const snap = (...a: Parameters<typeof disk>) => disk(...a).snapshot(), max = RESOURCE_DISK_SAMPLE_MAX_AGE_MS;
  expect(diskPressureFromSnapshot(snap(NOW, [{ state: "clear" }]), NOW, max)).toBe("normal");
  expect(diskPressureFromSnapshot(snap(NOW, [{ state: "clear" }, { state: "blocked" }]), NOW, max)).toBe("critical");
  expect(diskPressureFromSnapshot(snap(NOW - max, [{ state: "clear" }]), NOW, max)).toBe("normal");          // exactly the max age is still fresh
  expect(diskPressureFromSnapshot(snap(NOW - max - 1, [{ state: "clear" }]), NOW, max)).toBe("unknown");     // one millisecond older is stale
  expect(diskPressureFromSnapshot(snap(NOW + 1, [{ state: "clear" }]), NOW, max)).toBe("unknown");           // an evaluation from the future
  expect(diskPressureFromSnapshot(snap(null, [{ state: "clear" }]), NOW, max)).toBe("unknown");              // never evaluated
  expect(diskPressureFromSnapshot(snap(null, [{ state: "clear" }]), 5000, max)).toBe("unknown");              // even on a clock too young for staleness to catch it
  expect(diskPressureFromSnapshot(snap(NOW, []), NOW, max)).toBe("unknown");                                 // nothing watched
  expect(diskPressureFromSnapshot(snap(NOW, [{ state: "clear" }, { state: "clear", observed: false }]), NOW, max)).toBe("unknown");
  expect(diskPressureFromSnapshot(undefined as never, NOW, max)).toBe("unknown");
});
test("a healthy host is observed as admitting, with a fresh validity window and the injected budget", () => {
  const seen = observe(sysctlWith({}));
  expect(seen).toEqual({ budget: { memoryBytes: 8 * GiB, cpuUnits: 8, guestLimit: 2 }, pressure: "normal", admitNew: true, observedAt: NOW, validUntil: NOW + RESOURCE_OBSERVATION_VALIDITY_MS });
  expect(observe(sysctlWith({ level: 2 }))).toMatchObject({ pressure: "elevated", admitNew: true });
  expect(observe(sysctlWith({}), healthy, { validityMs: 123 })).toMatchObject({ validUntil: NOW + 123 });
});
test("memory pressure critical or unknown never admits", () => {
  expect(observe(sysctlWith({ level: 4 }))).toMatchObject({ pressure: "critical", admitNew: false });
  for (const level of [0, 3, 7, null, "throw"] as const) expect(observe(sysctlWith({ level }))).toMatchObject({ pressure: "unknown", admitNew: false });
});
test("disk pressure blocked, unevaluated, stale or empty never admits, whatever memory says", () => {
  expect(observe(sysctlWith({}), disk(NOW, [{ state: "blocked" }]))).toMatchObject({ pressure: "critical", admitNew: false });
  expect(observe(sysctlWith({}), disk(null, [{ state: "clear" }]))).toMatchObject({ pressure: "unknown", admitNew: false });
  expect(observe(sysctlWith({}), disk(NOW - RESOURCE_DISK_SAMPLE_MAX_AGE_MS - 1, [{ state: "clear" }]))).toMatchObject({ pressure: "unknown", admitNew: false });
  expect(observe(sysctlWith({}), disk(NOW, []))).toMatchObject({ pressure: "unknown", admitNew: false });
  expect(observe(sysctlWith({}), healthy, { maxDiskSampleAgeMs: 10 })).toMatchObject({ pressure: "unknown", admitNew: false }); // healthy snapshot is 1000 ms old
});
test("the worst of memory and disk pressure wins: unknown over critical over elevated over normal", () => {
  const blocked = disk(NOW, [{ state: "blocked" }]), unseen = disk(null, [{ state: "clear" }]);
  expect(observe(sysctlWith({ level: 2 }), blocked)).toMatchObject({ pressure: "critical" });
  expect(observe(sysctlWith({ level: 4 }), healthy)).toMatchObject({ pressure: "critical" });
  expect(observe(sysctlWith({ level: 4 }), unseen)).toMatchObject({ pressure: "unknown" });
  expect(observe(sysctlWith({ level: 0 }), blocked)).toMatchObject({ pressure: "unknown" });
  expect(observe(sysctlWith({ level: 2 }), healthy)).toMatchObject({ pressure: "elevated" });
});
test("unreadable host facts or an unusable budget give null, which the ledger refuses as probe_unavailable", () => {
  for (const values of [{ memsize: null }, { memsize: 0n }, { memsize: 1n << 60n }, { ncpu: null }, { ncpu: 0 }, { ncpu: -1 }]) expect(observe(sysctlWith(values))).toBeNull();
  const withBudget = (b: ResourceBudgetPolicy) => createCoworkResourceObserver({ sysctl: sysctlWith({}), disk: healthy, budget: b, now: () => NOW })();
  for (const bad of [null, { memoryBytes: -1, cpuUnits: 1, guestLimit: 1 }, { memoryBytes: 1.5, cpuUnits: 1, guestLimit: 1 }, { memoryBytes: 1, cpuUnits: -1, guestLimit: 1 }, { memoryBytes: 1, cpuUnits: 1, guestLimit: 4097 }, { memoryBytes: 1, cpuUnits: 1, guestLimit: -1 }, { memoryBytes: Number.NaN, cpuUnits: 1, guestLimit: 1 }, {} as never])
    expect(withBudget(() => bad)).toBeNull();
  expect(withBudget(() => { throw new Error("policy"); })).toBeNull();
  // The physical memory size is bounded before the policy ever sees it, whatever the policy then returns.
  const huge = createCoworkResourceObserver({ sysctl: sysctlWith({ memsize: 1n << 60n }), disk: healthy, budget: () => ({ memoryBytes: 1, cpuUnits: 1, guestLimit: 1 }), now: () => NOW })();
  expect(huge).toBeNull();
  expect(withBudget(() => ({ memoryBytes: 0, cpuUnits: 0, guestLimit: 0 }))).toMatchObject({ budget: { memoryBytes: 0, cpuUnits: 0, guestLimit: 0 } }); // a zero budget is valid and admits nothing
  expect(createCoworkResourceObserver({ sysctl: { ...sysctlWith({}), uint64: () => { throw new Error("x"); } }, disk: healthy, budget, now: () => NOW })()).toBeNull();
  expect(createCoworkResourceObserver({ sysctl: sysctlWith({}), disk: { snapshot: () => { throw new Error("x"); } }, budget, now: () => NOW })()).toBeNull();
});
test("construction validates ports and options", () => {
  const ok = { sysctl: sysctlWith({}), disk: healthy, budget };
  for (const bad of [{ sysctl: {} }, { disk: {} }, { budget: undefined }]) expect(() => createCoworkResourceObserver({ ...ok, ...bad } as never)).toThrow(TypeError);
  expect(() => createCoworkResourceObserver(undefined as never)).toThrow(TypeError);
  for (const bad of [{ validityMs: 0 }, { validityMs: 1.5 }, { maxDiskSampleAgeMs: 0 }]) expect(() => createCoworkResourceObserver({ ...ok, ...bad })).toThrow(RangeError);
});

// ---------------------------------------------------------------- guard -> observer -> ledger
const fakeSpace = (available: number): FilesystemSpace => ({ filesystemId: "fsid:x:1", typeName: "apfs", blockBytes: 4096, totalBytes: 10 ** 13, availableBytes: available });
test("a blocked disk guard makes the real ledger refuse a reservation with pressure_refused, and a cleared one lets it through", async () => {
  const f = ledgerFixture(); cleanups.push(() => f.dispose());
  let available = 100 * GiB, now = 1_000_000; // one clock for the guard, the observer and the ledger
  const writers: WriterHaltPort = { haltWriters: () => ({ halted: true }) };
  const guard = new CoworkPressureGuard({ space: { read: () => fakeSpace(available) }, writers, now: () => now });
  guard.watch("home", { kind: "path", path: "/home" });
  const MACHINE = "00000000-0000-4000-8000-0000000000A1", BOOT = "00000000-0000-4000-8000-0000000000B1"; // synthetic
  const processes = new Map([[4242, { kind: "present" as const, startSeconds: 1700000000, startMicroseconds: 1, zombie: false }]]);
  const probes = createCoworkAdmissionProbes({
    runCommand: () => ({ status: 0, stdout: `    "IOPlatformUUID" = "${MACHINE}"\n` }), sysctl: { string: () => BOOT, int32: () => null, uint64: () => null },
    processes: { inspect: pid => processes.get(pid) ?? { kind: "absent" } }, installationId: () => "installation-fixture", homeIdentity: f.homeIdentity, verifyStopReceipt: () => false,
  });
  const observer = createCoworkResourceObserver({ sysctl: sysctlWith({}), disk: guard, budget, now: () => now });
  const ledger = f.open(probes, observer, () => now);
  const home = f.makeHome("home-one", MACHINE, "installation-fixture"); ledger.registerHome(home, home.canonicalPath);
  const identity = probes.processIdentity(4242);
  if (identity?.state !== "alive") throw new Error("fixture process");
  const owner: AdmissionOwner = { pid: 4242, startToken: identity.startToken, bootId: identity.bootId, instanceNonce: "nonce-one" };
  const reserve = (workspace: string) => ledger.reserve({ requestId: `req-${workspace}`, homeId: home.homeId, owner, workspaceId: workspace, incarnationId: `inc-${workspace}`, leaseEpoch: 1, commitment: { memoryBytes: 1024, cpuUnits: 1 } });
  const code = (body: () => unknown) => { try { body(); return "admitted"; } catch (error) { return (error as { code: string }).code; } };
  expect(code(() => reserve("w0"))).toBe("pressure_refused");    // the guard has never evaluated: unknown, fail closed
  await guard.evaluate(); now += 1;
  expect(code(() => reserve("w1"))).toBe("admitted");
  available = R - 1; await guard.evaluate(); now += 1;           // crosses the reserve
  expect(code(() => reserve("w2"))).toBe("pressure_refused");
  available = R + 1; await guard.evaluate(); now += 1;           // above the reserve, below the resume line: still blocked
  expect(code(() => reserve("w3"))).toBe("pressure_refused");
  available = 100 * GiB; await guard.evaluate(); now += 1;
  expect(code(() => reserve("w4"))).toBe("admitted");
});

// ---------------------------------------------------------------- the real host (read-only; shape, not values)
real("the real observer reads the host's memory pressure and budget inputs", () => {
  const seen = createCoworkResourceObserver({ sysctl: createProductionHostAdapters().sysctl, disk: healthy, budget, now: () => NOW })();
  expect(seen).not.toBeNull();
  expect(["normal", "elevated", "critical"]).toContain(seen!.pressure);
  expect(seen!.budget.guestLimit).toBe(2); expect(seen!.budget.cpuUnits).toBeGreaterThanOrEqual(1); expect(seen!.budget.memoryBytes).toBeGreaterThanOrEqual(1 << 29);
  expect(seen!.admitNew).toBe(seen!.pressure !== "critical");
});
