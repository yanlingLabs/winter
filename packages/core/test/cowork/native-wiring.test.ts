import { afterEach, expect, test } from "bun:test";
import { CoworkImagePins } from "../../src/cowork/images";
import { createMacCoworkHost } from "../../src/cowork/mac-host";
import { bindCoworkImagePins, createCoworkNativeWiring, CoworkNativeUnavailableError, type CoworkNativeEnvironment, type CoworkNativeWiringOptions } from "../../src/cowork/native-wiring";
import { CoworkWorkspaceService, disabledCoworkHost } from "../../src/cowork/service";
import { CoworkError } from "../../src/cowork/types";
import { CoworkNativeSimulatedCrash } from "../../src/cowork/native/host";
import { cleanupHarnesses, createHarness, IMAGE_DIGEST, type Harness } from "./native/harness";
import type { CoworkVolumeBackup } from "../../src/cowork/volume-backup";

afterEach(() => { cleanupHarnesses(); });

// The test backup port: the harness's own is private to it, and the volumes record their own exclusion proofs in the database.
const backup: CoworkVolumeBackup = { excludeItem: () => {}, verifyItemExcluded: () => true, verifyDescriptorExcluded: () => true };
const SHORT = { stopGraceMs: 20, exitAllowanceMs: 20, drainBudgetMs: 50 };

/** The environment a wiring needs, assembled from the S1 harness's fakes (no process, no VM, no socket). */
function envFor(h: Harness, extra: Partial<CoworkNativeEnvironment> = {}): CoworkNativeEnvironment {
  const { timers, timeouts, unsafeTestTimeouts, now, conversations, mint, checkpoint } = h.deps;
  return { launcher: h.launcher, admission: h.ledger, backup, hostBoot: h.hostBoot, daemon: () => h.daemon, hostOptions: { timers, timeouts, unsafeTestTimeouts, now, conversations, mint, checkpoint }, ...extra };
}
function pins(h: Harness, digest = IMAGE_DIGEST): CoworkImagePins {
  const store = new CoworkImagePins(h.db, { authorize: () => true }, { compatible: () => true });
  store.pin(h.workspaceId, { baseImageDigest: "b".repeat(64), runtimeImageDigest: digest }, {});
  return store;
}
function wiringFor(h: Harness, extra: Partial<CoworkNativeWiringOptions> = {}, env: Partial<CoworkNativeEnvironment> = {}) {
  return createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, environment: () => envFor(h, env), imagePins: extra.imagePins ?? pins(h), ...extra });
}
const snapshot = (h: Harness) => JSON.stringify({ workspaces: h.db.db.query("SELECT * FROM cowork_workspaces ORDER BY workspace_id").all(), volumes: h.db.db.query("SELECT * FROM cowork_volumes ORDER BY workspace_id,purpose").all() });
const owners = (h: Harness) => h.volumes.records(h.workspaceId).map(v => v.owner);

// ================================================================================================ inertness

test("constructing the wiring builds nothing: the environment is not asked, the launcher is not touched, the database is unchanged", () => {
  const h = createHarness();
  const before = snapshot(h);
  let asked = 0;
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, environment: () => { asked += 1; return envFor(h); }, imagePins: pins(h) });
  expect(wiring.built).toBe(false);
  expect(wiring.activeWorkspaces()).toEqual([]);
  expect(asked).toBe(0);
  expect(h.launcher.spawned).toEqual([]);
  expect(h.timers.active).toBe(0);
  expect(snapshot(h)).toBe(before);
  // Shutting an unused wiring down asks for nothing either.
  expect(wiring.beginShutdown()).toBeUndefined();
  expect(asked).toBe(0);
  expect(wiring.built).toBe(false);
});

test("without an environment (production) a start refuses with native_unavailable and nothing changes", async () => {
  const h = createHarness();
  const before = snapshot(h);
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home });
  await expect(wiring.start(h.workspaceId)).rejects.toMatchObject({ name: "CoworkNativeUnavailableError", code: "native_unavailable" });
  await expect(wiring.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeUnavailableError);
  expect(wiring.built).toBe(false);
  expect(h.launcher.spawned).toEqual([]);
  expect(snapshot(h)).toBe(before);
});

test("an environment that throws is unavailable, leaves no half-built host and is asked again next time", async () => {
  const h = createHarness();
  let asked = 0;
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, imagePins: pins(h), environment: () => { asked += 1; if (asked === 1) throw new Error("no ledger yet"); return envFor(h); } });
  await expect(wiring.start(h.workspaceId)).rejects.toMatchObject({ code: "native_unavailable" });
  expect(wiring.built).toBe(false);
  expect(h.launcher.spawned).toEqual([]);
  await wiring.start(h.workspaceId);
  expect(asked).toBe(2);
  expect(wiring.activeWorkspaces()).toEqual([h.workspaceId]);
  await wiring.beginShutdown();
});

// ================================================================================================ the optional native port

test("the service refuses startNative exactly as before when no native port is injected, and createMacCoworkHost adds none by default", async () => {
  const h = createHarness();
  const service = new CoworkWorkspaceService(h.records, disabledCoworkHost);
  const local = { kind: "local-user" as const, id: "local-admin" };
  await expect(service.startNative(local, h.workspaceId)).rejects.toMatchObject({ code: "unsupported_topology" });
  await expect(service.startNative(local, h.workspaceId)).rejects.toBeInstanceOf(CoworkError);
  const mac = createMacCoworkHost(h.home, undefined, h.db);
  expect("native" in mac).toBe(false);
  expect("native" in disabledCoworkHost).toBe(false);
  await expect(new CoworkWorkspaceService(h.records, mac).startNative(local, h.workspaceId)).rejects.toMatchObject({ code: "unsupported_topology" });
  expect(h.launcher.spawned).toEqual([]);
});

test("an injected native port is reached only after the workspace authority check, and only for a local user", async () => {
  const h = createHarness();
  const started: string[] = [];
  const port = { start: async (workspaceId: string) => { started.push(workspaceId); return "started"; } };
  const service = new CoworkWorkspaceService(h.records, { ...disabledCoworkHost, native: port });
  const paired = { kind: "paired-user" as const, id: "paired", workspaceIds: new Set([h.workspaceId]), repositoryAuthorities: new Set<string>() };
  await expect(service.startNative(paired as never, h.workspaceId)).rejects.toMatchObject({ code: "authority_denied" });
  await expect(service.startNative({ kind: "local-user", id: "local-admin" }, "ws-does-not-exist")).rejects.toBeInstanceOf(CoworkError);
  expect(started).toEqual([]);
  expect(await service.startNative({ kind: "local-user", id: "local-admin" }, h.workspaceId)).toBe("started");
  expect(started).toEqual([h.workspaceId]);
  expect(createMacCoworkHost(h.home, undefined, h.db, port).native).toBe(port);
});

// ================================================================================================ image pins (PR #46)

test("the host's ImagePins port is bound to CoworkImagePins.assertPinned: an unpinned workspace refuses before the incarnation moves", async () => {
  const h = createHarness();
  const unpinned = new CoworkImagePins(h.db, { authorize: () => true }, { compatible: () => true });
  const wiring = wiringFor(h, { imagePins: unpinned });
  const before = snapshot(h);
  await expect(wiring.start(h.workspaceId)).rejects.toMatchObject({ code: "image_unpinned" });
  expect(h.launcher.spawned).toEqual([]);
  expect(snapshot(h)).toBe(before);
  expect(h.records.get(h.workspaceId).leaseEpoch).toBe(0);
});

test("the launch uses the PINNED runtime digest; assertPinned runs once per ask on the live pin and a pending update never counts", async () => {
  const h = createHarness();
  const store = pins(h, "a".repeat(64));
  const asserted: string[] = [];
  const spy = { get: (id: string) => store.get(id), assertPinned: (id: string, expected: Parameters<CoworkImagePins["assertPinned"]>[1]) => { asserted.push(expected.runtimeImageDigest); return store.assertPinned(id, expected); } };
  expect(bindCoworkImagePins(spy).runtimeImageDigest(h.workspaceId)).toBe("a".repeat(64));
  expect(asserted).toEqual(["a".repeat(64)]);
  // a pending update leaves the live digests alone
  store.beginUpdate(h.workspaceId, { baseImageDigest: "b".repeat(64), runtimeImageDigest: "c".repeat(64) }, {});
  expect(bindCoworkImagePins(spy).runtimeImageDigest(h.workspaceId)).toBe("a".repeat(64));
  // the owner tuple a start claims carries that digest
  const wiring = wiringFor(h, { imagePins: spy });
  const running = await wiring.start(h.workspaceId) as { owner: { runtimeImageDigest: string } };
  expect(running.owner.runtimeImageDigest).toBe("a".repeat(64));
  expect(asserted).toEqual(["a".repeat(64), "a".repeat(64), "a".repeat(64)]);
  await wiring.beginShutdown();
});

test("a pins object that does not refuse a missing pin still cannot launch", () => {
  const lax = { get: () => null, assertPinned: () => {} };
  expect(() => bindCoworkImagePins(lax as never).runtimeImageDigest("ws-x")).toThrow("image_unpinned");
});

test("a pin whose digests no longer match the live pin refuses (assertPinned is the judge, not the binding)", () => {
  const h = createHarness();
  const store = pins(h);
  const racing = { get: (id: string) => ({ ...store.get(id)!, runtimeImageDigest: "e".repeat(64) }), assertPinned: (id: string, expected: Parameters<CoworkImagePins["assertPinned"]>[1]) => store.assertPinned(id, expected) };
  expect(() => bindCoworkImagePins(racing as never).runtimeImageDigest(h.workspaceId)).toThrow("image_digest_mismatch");
});

// ================================================================================================ the stop tail

test("a live guest is drained at shutdown: stopped, released with an orderly receipt, and later starts refuse", async () => {
  const h = createHarness();
  const wiring = wiringFor(h);
  await wiring.start(h.workspaceId);
  expect(h.records.get(h.workspaceId).power).toBe("running");
  expect(owners(h).every(owner => owner !== null)).toBe(true);
  const drained = wiring.beginShutdown();
  expect(drained).toBeInstanceOf(Promise);
  await drained;
  expect(h.records.get(h.workspaceId).power).toBe("stopped");
  expect(owners(h)).toEqual([null, null]);
  expect(wiring.activeWorkspaces()).toEqual([]);
  await expect(wiring.start(h.workspaceId)).rejects.toMatchObject({ code: "native_closing" });
});

test("a start still in flight at shutdown is waited for and then drained, not abandoned half-started", async () => {
  const h = createHarness({ behavior: { spawn: "slow" } });
  const wiring = wiringFor(h);
  const starting = wiring.start(h.workspaceId);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(h.records.get(h.workspaceId).power).toBe("starting");
  const drained = wiring.beginShutdown();
  expect(drained).toBeInstanceOf(Promise);
  await drained;
  await starting;
  expect(h.records.get(h.workspaceId).power).toBe("stopped");
  expect(owners(h)).toEqual([null, null]);
  expect(wiring.activeWorkspaces()).toEqual([]);
});

test("a guest that never answers the stop does not hold the daemon past the bound, and keeps its ownership", async () => {
  const h = createHarness({ behavior: { stop: "silent" }, timeouts: { stopGraceMs: 5_000, exitAllowanceMs: 5_000, drainBudgetMs: 5_000 } });
  const wiring = wiringFor(h, { shutdownBoundMs: 120 });
  await wiring.start(h.workspaceId);
  const began = performance.now();
  await wiring.beginShutdown();
  const waited = performance.now() - began;
  expect(waited).toBeGreaterThanOrEqual(100);
  expect(waited).toBeLessThan(2_000);
  // nothing was released on the strength of having given up waiting
  expect(owners(h).every(owner => owner !== null)).toBe(true);
  expect(h.records.get(h.workspaceId).power).not.toBe("stopped");
  h.dispose();
});

test("the shutdown bound is the contract's host wait (65 s at the default) and the seam can only shorten it", async () => {
  const { coworkNativeHostStopWaitMs } = await import("../../src/cowork/native/protocol");
  expect(coworkNativeHostStopWaitMs(30_000)).toBe(65_000);
  const h = createHarness();
  const realSetTimeout = globalThis.setTimeout, seen: number[] = [];
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => { if (typeof ms === "number" && ms >= 1_000) seen.push(ms); return realSetTimeout(fn, ms, ...rest); }) as never;
  try {
    // an enormous seam value is clamped to the contract; a small one is honoured
    const lengthened = wiringFor(h, { shutdownBoundMs: 10 ** 9 });
    await lengthened.start(h.workspaceId);
    await lengthened.beginShutdown();
  } finally { globalThis.setTimeout = realSetTimeout; }
  const contract = coworkNativeHostStopWaitMs(h.deps.timeouts!.drainBudgetMs!);
  expect(seen).toContain(contract);
  expect(seen.some(ms => ms > contract && ms < 10 ** 9)).toBe(false);
});

test("with no live host the stop tail adds no measurable delay: undefined, synchronously, no timer", () => {
  const h = createHarness();
  const never = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home });
  const built = wiringFor(h);
  const realSetTimeout = globalThis.setTimeout; let timers = 0;
  (globalThis as { setTimeout: unknown }).setTimeout = ((...args: Parameters<typeof setTimeout>) => { timers += 1; return realSetTimeout(...args); }) as never;
  let started = performance.now();
  try {
    for (let i = 0; i < 20_000; i += 1) expect(never.beginShutdown()).toBeUndefined();
  } finally { globalThis.setTimeout = realSetTimeout; }
  const elapsed = performance.now() - started;
  expect(timers).toBe(0);
  expect(elapsed / 20_000).toBeLessThan(0.05); // under 50 microseconds each, in fact well under 1 microsecond
  started = performance.now();
  expect(built.beginShutdown()).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(5);
});

// ================================================================================================ boot-time reconcile (D1)

test("without an environment the boot reconcile only READS: it reports held ownership and writes nothing", async () => {
  const h = createHarness({ crashAt: "volumes-opened" });
  await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
  h.restart();
  const before = snapshot(h);
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home });
  const boot = wiring.reconcileAtBoot();
  expect(boot.source).toBe("records");
  expect(boot.reports).toMatchObject([{ workspaceId: h.workspaceId, action: "retained", ownerRetained: true }]);
  expect(snapshot(h)).toBe(before);
  expect(wiring.built).toBe(false);
});

test("a database with nothing to settle has nothing to report, with or without an environment, and the environment is never asked", () => {
  const h = createHarness();
  expect(createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home }).reconcileAtBoot()).toEqual({ source: "records", reports: [] });
  let asked = 0;
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, environment: () => { asked += 1; return envFor(h); } });
  expect(wiring.reconcileAtBoot()).toEqual({ source: "records", reports: [] });
  expect(asked).toBe(0);
  expect(wiring.built).toBe(false);
});

for (const phase of ["claimed", "volumes-opened", "receipt-received", "power-running"]) {
  test(`with an environment, a crash at ${phase} followed by a same-boot restart keeps the owner (a dead process or EOF is not proof)`, async () => {
    const h = createHarness({ crashAt: phase });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart();
    const wiring = wiringFor(h);
    const boot = wiring.reconcileAtBoot();
    expect(boot.source).toBe("host");
    expect(boot.reports).toMatchObject([{ action: "retained", evidence: null, power: "uncertain", ownerRetained: true }]);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
    expect(h.records.get(h.workspaceId).power).toBe("uncertain");
    // asking again, or asking after the registered process records say dead, changes nothing
    expect(wiring.reconcileAtBoot().reports).toMatchObject([{ action: "retained", ownerRetained: true }]);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
  });
}

test("with an environment, only a changed boot that the probe confirms ended releases the disks", async () => {
  const h = createHarness({ crashAt: "volumes-opened" });
  await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
  h.restart({ newBoot: true });
  const wiring = wiringFor(h);
  // the boot id changed, but nothing confirms the old boot ended
  expect(wiring.reconcileAtBoot().reports).toMatchObject([{ action: "retained", ownerRetained: true }]);
  expect(owners(h).every(owner => owner !== null)).toBe(true);
  h.hostBoot.ended = true;
  const released = wiring.reconcileAtBoot();
  expect(released.reports).toMatchObject([{ action: "released", evidence: "new-boot", ownerRetained: false, power: "stopped" }]);
  expect(owners(h)).toEqual([null, null]);
});

test("a boot reconcile that cannot run is recorded and refused: it never throws and never releases", async () => {
  const h = createHarness({ crashAt: "volumes-opened" });
  await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
  h.restart();
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, environment: () => { throw new Error("ledger unreachable"); } });
  const before = snapshot(h);
  const boot = wiring.reconcileAtBoot();
  expect(boot.source).toBe("host");
  expect(boot.reports).toMatchObject([{ workspaceId: h.workspaceId, action: "retained", ownerRetained: true }]);
  expect(snapshot(h)).toBe(before);
});
