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
/** An in-memory stand-in for the daemon's secret store (the preload's throwaway service is never used for this unit, and no Keychain is touched). */
function memorySlot(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial)), reads: string[] = [];
  return { values, reads, get: async (name: string) => { reads.push(name); return values.get(name) ?? null; }, set: async (name: string, value: string) => { values.set(name, value); } };
}
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
  return createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, secrets: memorySlot(), environment: () => envFor(h, env), imagePins: extra.imagePins ?? pins(h), ...extra });
}
const snapshot = (h: Harness) => JSON.stringify({ workspaces: h.db.db.query("SELECT * FROM cowork_workspaces ORDER BY workspace_id").all(), volumes: h.db.db.query("SELECT * FROM cowork_volumes ORDER BY workspace_id,purpose").all() });
const owners = (h: Harness) => h.volumes.records(h.workspaceId).map(v => v.owner);

// ================================================================================================ inertness

test("constructing the wiring builds nothing: the environment is not asked, the launcher is not touched, the database is unchanged", async () => {
  const h = createHarness();
  const before = snapshot(h);
  let asked = 0;
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, secrets: memorySlot(), environment: () => { asked += 1; return envFor(h); }, imagePins: pins(h) });
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
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, secrets: memorySlot(), imagePins: pins(h), environment: () => { asked += 1; if (asked === 1) throw new Error("no ledger yet"); return envFor(h); } });
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

test("a pins object that does not refuse a missing pin still cannot launch", async () => {
  const lax = { get: () => null, assertPinned: () => {} };
  expect(() => bindCoworkImagePins(lax as never).runtimeImageDigest("ws-x")).toThrow("image_unpinned");
});

test("a pin whose digests no longer match the live pin refuses (assertPinned is the judge, not the binding)", async () => {
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

test("with no live host the stop tail adds no measurable delay: undefined, synchronously, no timer", async () => {
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
  const boot = await wiring.reconcileAtBoot();
  expect(boot.source).toBe("records");
  expect(boot.reports).toMatchObject([{ workspaceId: h.workspaceId, action: "retained", ownerRetained: true }]);
  expect(snapshot(h)).toBe(before);
  expect(wiring.built).toBe(false);
});

test("a database with nothing to settle has nothing to report, with or without an environment, and the environment is never asked", async () => {
  const h = createHarness();
  expect(await createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home }).reconcileAtBoot()).toEqual({ source: "records", reports: [] });
  let asked = 0;
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, environment: () => { asked += 1; return envFor(h); } });
  expect(await wiring.reconcileAtBoot()).toEqual({ source: "records", reports: [] });
  expect(asked).toBe(0);
  expect(wiring.built).toBe(false);
});

for (const phase of ["claimed", "volumes-opened", "receipt-received", "power-running"]) {
  test(`with an environment, a crash at ${phase} followed by a same-boot restart keeps the owner (a dead process or EOF is not proof)`, async () => {
    const h = createHarness({ crashAt: phase });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart();
    const wiring = wiringFor(h);
    const boot = await wiring.reconcileAtBoot();
    expect(boot.source).toBe("host");
    expect(boot.reports).toMatchObject([{ action: "retained", evidence: null, power: "uncertain", ownerRetained: true }]);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
    expect(h.records.get(h.workspaceId).power).toBe("uncertain");
    // asking again, or asking after the registered process records say dead, changes nothing
    expect((await wiring.reconcileAtBoot()).reports).toMatchObject([{ action: "retained", ownerRetained: true }]);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
  });
}

test("with an environment, only a changed boot that the probe confirms ended releases the disks", async () => {
  const h = createHarness({ crashAt: "volumes-opened" });
  await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
  h.restart({ newBoot: true });
  const wiring = wiringFor(h);
  // the boot id changed, but nothing confirms the old boot ended
  expect((await wiring.reconcileAtBoot()).reports).toMatchObject([{ action: "retained", ownerRetained: true }]);
  expect(owners(h).every(owner => owner !== null)).toBe(true);
  h.hostBoot.ended = true;
  const released = await wiring.reconcileAtBoot();
  expect(released.reports).toMatchObject([{ action: "released", evidence: "new-boot", ownerRetained: false, power: "stopped" }]);
  expect(owners(h)).toEqual([null, null]);
});

test("a boot reconcile that cannot run is recorded and refused: it never throws and never releases", async () => {
  const h = createHarness({ crashAt: "volumes-opened" });
  await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
  h.restart();
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, environment: () => { throw new Error("ledger unreachable"); } });
  const before = snapshot(h);
  const boot = await wiring.reconcileAtBoot();
  expect(boot.source).toBe("host");
  expect(boot.reports).toMatchObject([{ workspaceId: h.workspaceId, action: "retained", ownerRetained: true }]);
  expect(snapshot(h)).toBe(before);
});

// ================================================================================================ boot scan predicate and failure modes

test("the boot scan fails closed: a records read that throws neither crashes boot nor reports a release", async () => {
  const h = createHarness();
  const broken = { ...h.records, list: () => { throw new Error("unreadable"); } } as unknown as typeof h.records;
  let asked = 0;
  const wiring = createCoworkNativeWiring({ db: h.db, records: broken, home: h.home, environment: () => { asked += 1; return envFor(h); } });
  expect(await wiring.reconcileAtBoot()).toEqual({ source: "records", reports: [] });
  expect(asked).toBe(0);
});

test("the boot scan examines a workspace that is not stopped OR whose volumes still name an owner, and skips the rest", async () => {
  const h = createHarness();
  const idle = h.addWorkspace();
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home });
  // both workspaces are stopped and free: nothing to examine
  expect((await wiring.reconcileAtBoot()).reports).toEqual([]);
  // an owner that outlives a `stopped` power (not reachable through the host's own release order, but the scan must not rely on that)
  await expect(h.host.start(h.workspaceId)).resolves.toBeDefined();
  h.db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [h.workspaceId]);
  expect(owners(h).every(owner => owner !== null)).toBe(true);
  const reports = (await wiring.reconcileAtBoot()).reports;
  expect(reports.map(report => report.workspaceId)).toEqual([h.workspaceId]);
  expect(reports[0]).toMatchObject({ action: "retained", ownerRetained: true, power: "stopped" });
  expect(reports.some(report => report.workspaceId === idle)).toBe(false);
  // a workspace that is not `retained` (archived) is never examined, whatever its power says
  h.db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [h.workspaceId]);
  expect((await wiring.reconcileAtBoot()).reports).toEqual([]);
  h.db.db.run("UPDATE cowork_workspaces SET state='retained' WHERE workspace_id=?", [h.workspaceId]);
  // a workspace that is not stopped is examined even though its volumes are free
  h.db.db.run("UPDATE cowork_volumes SET owner_json=NULL WHERE workspace_id=?", [h.workspaceId]);
  expect((await wiring.reconcileAtBoot()).reports).toEqual([]);
  h.db.db.run("UPDATE cowork_workspaces SET power='uncertain' WHERE workspace_id=?", [idle]);
  expect((await wiring.reconcileAtBoot()).reports.map(report => report.workspaceId)).toEqual([idle]);
});

test("with an environment, a workspace that was ever launched is handed to the host even when it looks stopped and free", async () => {
  const h = createHarness();
  await (await h.host.start(h.workspaceId)).stop();
  let asked = 0;
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, secrets: memorySlot(), imagePins: pins(h), environment: () => { asked += 1; return envFor(h); } });
  expect(await wiring.reconcileAtBoot()).toMatchObject({ source: "host" });
  expect(asked).toBe(1);
});

test("a guest whose stop rejects does not fail the drain, and the drain still settles", async () => {
  const h = createHarness();
  const wiring = wiringFor(h);
  await wiring.start(h.workspaceId);
  const host = (wiring as unknown as { hostInstance: { stop: () => Promise<never> } }).hostInstance;
  host.stop = async () => { throw new Error("stop failed"); };
  const drained = wiring.beginShutdown();
  expect(drained).toBeInstanceOf(Promise);
  await expect(drained).resolves.toBeUndefined();
  h.dispose();
});

// ================================================================================================ the receipt MAC key (owner ruling 2026-10-18)

import { inspect } from "node:util";
import { COWORK_NATIVE_RECEIPT_KEY_ACCOUNT, CoworkNativeReceiptKey, isCanonicalBase64Of32Bytes } from "../../src/cowork/native/receipt-mac";
import { RECEIPT_KEY } from "./native/harness";

const SYNTHETIC = "synthetic-receipt-key-0123456789"; // 32 bytes, obviously not a secret
const syntheticKey = CoworkNativeReceiptKey.fromBytes(Buffer.from(SYNTHETIC));

test("the first start creates the key in the daemon's secret slot under the Cowork account and hands the SAME key to the launcher; a second wiring reuses it", async () => {
  const h = createHarness(), slot = memorySlot();
  const first = wiringFor(h, { secrets: slot });
  expect(slot.reads).toEqual([]); // building the wiring touches nothing
  await first.start(h.workspaceId);
  const stored = slot.values.get(COWORK_NATIVE_RECEIPT_KEY_ACCOUNT);
  expect(isCanonicalBase64Of32Bytes(stored)).toBe(true);
  expect([...slot.values.keys()]).toEqual([COWORK_NATIVE_RECEIPT_KEY_ACCOUNT]);
  expect(h.launcher.sessions[0]!.receiptKey!.reveal()).toBe(stored!);
  await first.beginShutdown();
  const second = wiringFor(h, { secrets: slot });
  await second.start(h.workspaceId);
  expect(h.launcher.sessions[1]!.receiptKey!.reveal()).toBe(stored!);
  await second.beginShutdown();
});

test("production (no environment) never touches the secret slot, at a start or at boot", async () => {
  const h = createHarness(), slot = memorySlot();
  const wiring = createCoworkNativeWiring({ db: h.db, records: h.records, home: h.home, secrets: slot });
  await expect(wiring.start(h.workspaceId)).rejects.toMatchObject({ code: "native_unavailable" });
  await wiring.reconcileAtBoot();
  expect(slot.reads).toEqual([]);
  expect(slot.values.size).toBe(0);
});

test("a start with no secret slot, or a slot the Keychain will not give, refuses before anything moves", async () => {
  const h = createHarness();
  const before = snapshot(h);
  await expect(wiringFor(h, { secrets: undefined }).start(h.workspaceId)).rejects.toMatchObject({ code: "no_receipt_key" }); // no slot: no key to give the launcher
  const locked = { get: async () => { throw new Error("keychain locked"); }, set: async () => { throw new Error("must not write"); } };
  await expect(wiringFor(h, { secrets: locked }).start(h.workspaceId)).rejects.toMatchObject({ code: "receipt_key_unavailable" });
  expect(h.launcher.spawned).toEqual([]);
  expect(snapshot(h)).toBe(before);
});

test("boot reconcile READS the key, never creates it: with the key a retained receipt can release, without it the receipt is Class B", async () => {
  const receiptPorts = (h: Harness) => ({
    receipts: { load: (scope: { workspaceId: string; incarnationId: string; leaseEpoch: number }) => { const text = h.receipts.get(`${scope.workspaceId}|${scope.incarnationId}|${scope.leaseEpoch}`); return text === undefined ? null : { text, attested: true as const }; }, retire: () => {} },
    guards: { processAbsent: () => true, imagesUnlocked: () => true },
  });
  const scenario = async () => {
    const h = createHarness({ crashAt: "power-running" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    const text = (await import("../../src/cowork/native/protocol")).serializeCoworkNativeStopReceipt(h.launcher.last.stagedOrderly("cc".repeat(16), { origin: "owner-loss-drain" }));
    h.restart();
    h.receipts.set(`${h.workspaceId}|${h.records.get(h.workspaceId).incarnationId}|${h.records.get(h.workspaceId).leaseEpoch}`, text);
    return h;
  };
  const withKey = await scenario(), slotWith = memorySlot({ [COWORK_NATIVE_RECEIPT_KEY_ACCOUNT]: RECEIPT_KEY.reveal() });
  const released = await wiringFor(withKey, { secrets: slotWith }, receiptPorts(withKey)).reconcileAtBoot();
  expect(released.reports).toMatchObject([{ action: "released", evidence: "orderly-receipt" }]);
  expect(owners(withKey)).toEqual([null, null]);
  cleanupHarnesses();
  const without = await scenario(), slotEmpty = memorySlot();
  const kept = await wiringFor(without, { secrets: slotEmpty }, receiptPorts(without)).reconcileAtBoot();
  expect(kept.reports).toMatchObject([{ action: "retained", ownerRetained: true, reason: expect.stringContaining("mac_invalid") }]);
  expect(owners(without).every(owner => owner !== null)).toBe(true);
  expect(slotEmpty.values.size).toBe(0); // boot did not create a key
  expect(slotEmpty.reads).toEqual([COWORK_NATIVE_RECEIPT_KEY_ACCOUNT]);
});

test("the key is never printed: captured console and stream output, thrown errors, the launcher's message log and the host's event log hold none of its spellings", async () => {
  const secrets = [syntheticKey.reveal(), Buffer.from(SYNTHETIC).toString("hex"), SYNTHETIC, encodeURIComponent(syntheticKey.reveal())];
  const captured: string[] = [];
  const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const realOut = process.stdout.write.bind(process.stdout), realErr = process.stderr.write.bind(process.stderr);
  for (const name of ["log", "error", "warn", "info", "debug"] as const) console[name] = (...args: unknown[]) => { captured.push(args.map(arg => typeof arg === "string" ? arg : inspect(arg, { depth: 8 })).join(" ")); };
  process.stdout.write = ((chunk: unknown) => { captured.push(String(chunk)); return true; }) as never;
  process.stderr.write = ((chunk: unknown) => { captured.push(String(chunk)); return true; }) as never;
  const errors: unknown[] = [];
  let h: Harness | undefined;
  try {
    // 1. a full start and stop with the synthetic key in the slot
    h = createHarness();
    const slot = memorySlot({ [COWORK_NATIVE_RECEIPT_KEY_ACCOUNT]: syntheticKey.reveal() });
    const wiring = wiringFor(h, { secrets: slot });
    await wiring.start(h.workspaceId);
    expect(h.launcher.sessions[0]!.receiptKey!.equals(syntheticKey)).toBe(true); // the launcher DID receive it
    await wiring.beginShutdown();
    // 2. a launcher that refuses begin, and a start that fails after it
    h.setBehavior({ begin: "refuse" });
    await wiringFor(h, { secrets: slot }).start(h.workspaceId).catch(error => errors.push(error));
    h.setBehavior({ stop: "uncertain" });
    // 3. a crash and a boot reconcile that has to refuse
    const crashed = createHarness({ crashAt: "volumes-opened" });
    await crashed.host.start(crashed.workspaceId).catch(error => errors.push(error));
    crashed.restart();
    await wiringFor(crashed, { secrets: slot }).reconcileAtBoot();
    errors.push(...[crashed].flatMap(() => []));
    // 4. a Keychain that fails while holding the key in a message
    await wiringFor(h, { secrets: { get: async () => { throw new Error(`denied ${syntheticKey.reveal()}`); }, set: async () => {} } }).start(h.workspaceId).catch(error => errors.push(error));
  } finally {
    Object.assign(console, realConsole);
    process.stdout.write = realOut as never; process.stderr.write = realErr as never;
  }
  const logs = JSON.stringify(h!.launcher.sessions.map(session => session.received)) + inspect(h!.launcher.sessions.map(session => session.received), { depth: 10 }) + JSON.stringify(h!.events) + captured.join("\n");
  for (const secret of secrets) expect(logs.includes(secret)).toBe(false);
  // the error from step 4 was built by the test itself from the key, so it is excluded from the claim about OUR errors; every other error is ours
  const ours = errors.filter(error => !String((error as Error)?.message ?? "").includes("denied"));
  for (const error of ours) for (const secret of secrets) expect(`${(error as Error).message}${(error as Error).stack}${inspect(error, { depth: 8 })}`.includes(secret)).toBe(false);
  expect(errors.length).toBeGreaterThan(0);
  // the unavailable error that wraps a failing Keychain carries a fixed code, not the Keychain's message
  const wrapped = errors.find(error => (error as { code?: string }).code === "receipt_key_unavailable") as Error | undefined;
  expect(wrapped).toBeDefined();
  for (const secret of secrets) expect(`${wrapped!.message}${wrapped!.stack}${inspect(wrapped, { depth: 8 })}`.includes(secret)).toBe(false);
});
