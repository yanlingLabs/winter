import { afterEach, describe, expect, test } from "bun:test";
import { CoworkNativeSimulatedCrash } from "../../../src/cowork/native/host";
import { serializeCoworkNativeStopReceipt } from "../../../src/cowork/native/protocol";
import { CoworkNativeRecovery } from "../../../src/cowork/native/recovery";
import { cleanupHarnesses, createHarness, type Harness } from "./harness";

afterEach(() => { cleanupHarnesses(); });

// N2 S7 (cross-slice finding F2). The launcher's retained-receipt store is same-user writable and authenticates nothing, so a retained Class A receipt
// releases a disk only while BOTH of D1's guards pass at that moment. Whether the receipts also need a MAC is an owner Keychain ruling and is NOT made here.
const keyOf = (h: Harness) => { const ws = h.records.get(h.workspaceId); return `${ws.workspaceId}|${ws.incarnationId}|${ws.leaseEpoch}`; };
const owners = (h: Harness) => h.volumes.records(h.workspaceId).map(v => v.owner);
async function crashedWithReceipt(): Promise<Harness> {
  const h = createHarness({ crashAt: "power-running" });
  await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
  const text = serializeCoworkNativeStopReceipt(h.launcher.last.stagedOrderly("cc".repeat(16), { origin: "owner-loss-drain" }));
  h.restart();
  h.receipts.set(keyOf(h), text);
  return h;
}

describe("a retained Class A receipt is evidence only while both guards pass", () => {
  test("an old worker that is still present: the forged-or-stale file releases nothing, and the file stays", async () => {
    const h = await crashedWithReceipt();
    h.guards.processAbsent = false;
    for (let round = 0; round < 2; round++) {
      expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", ownerRetained: true, power: "uncertain", reason: expect.stringContaining("guard_failed") }]);
      expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained" });
    }
    expect(h.calls.volumeRelease).toBe(0); expect(h.calls.ledgerRelease).toBe(0);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
    expect(h.receipts.size).toBe(1);
    // the process is gone and the images unlocked at THIS moment: now it is evidence
    h.guards.processAbsent = true;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", evidence: "orderly-receipt", ownerRetained: false });
    expect(owners(h)).toEqual([null, null]);
    expect(h.receipts.size).toBe(0); // retired by the daemon directly, once the disk was settled
  });

  test("the disks already free but the admission row still held: the receipt again needs the guards before it settles the row", async () => {
    const h = createHarness({ crashAt: "volumes-released" });
    const running = await h.host.start(h.workspaceId);
    await expect(running.stop()).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart();
    expect(owners(h)).toEqual([null, null]);
    expect(h.receipts.size).toBe(1);
    h.guards.processAbsent = false;
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", admission: "uncertain" }]);
    expect(h.calls.ledgerRelease).toBe(0);
    h.guards.processAbsent = true;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", evidence: "orderly-receipt", power: "stopped" });
  });

  test("images that are still locked refuse the same way", async () => {
    const h = await crashedWithReceipt();
    h.guards.imagesUnlocked = false;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", ownerRetained: true, reason: expect.stringContaining("guard_failed") });
    expect(h.calls.volumeRelease).toBe(0);
    expect(h.guards.seen.length).toBeGreaterThan(0);
  });

  test("with no guard port at all the receipt is treated as Class B: nothing releases", async () => {
    const h = await crashedWithReceipt();
    const bare = new CoworkNativeRecovery({ records: h.records, volumes: h.volumes, admission: h.ledger, power: h.power, registry: h.registry, hostBoot: h.hostBoot,
      receipts: { load: scope => { const text = h.receipts.get(`${scope.workspaceId}|${scope.incarnationId}|${scope.leaseEpoch}`); return text === undefined ? null : { text, attested: true }; }, retire: () => {} } });
    expect(bare.recover(h.workspaceId)).toMatchObject({ action: "retained", ownerRetained: true, reason: expect.stringContaining("guard probes") });
    expect(owners(h).every(owner => owner !== null)).toBe(true);
  });

  test("a guard that throws, or answers anything but true, refuses", async () => {
    const h = await crashedWithReceipt();
    const real = h.guards;
    for (const answer of [() => { throw new Error("cannot tell"); }, () => undefined as never, () => 1 as never]) {
      (h.recovery["deps"] as { guards?: unknown }).guards = { processAbsent: answer, imagesUnlocked: () => true } as never;
      expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", ownerRetained: true });
    }
    expect(real.processAbsent).toBe(true);
    expect(h.calls.volumeRelease).toBe(0);
  });

  test("the old writer's receipt that a replay debt relies on is checked against the guards again before the successor starts", async () => {
    const h = createHarness();
    await (await h.host.start(h.workspaceId)).stop();
    h.restart({ crashAt: "receipt-received" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    const crashed = h.launcher.last, key = keyOf(h);
    h.restart();
    const text = serializeCoworkNativeStopReceipt(crashed.stagedOrderly("ab".repeat(16), { origin: "owner-loss-drain" }));
    h.receipts.set(key, text);
    expect(h.host.bootReconcile()).toMatchObject([{ action: "released", evidence: "orderly-receipt" }]);
    h.restart(); // memory forgets that the old writer stopped; the file is read again
    h.guards.processAbsent = false;
    await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ name: "CoworkNativeHostError" });
    expect(h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.replayDebt).toBeDefined();
    // (the fake launcher's retire matches by confirmation id, so the file is put back to model a store that still holds it)
    h.restart(); // a fresh daemon: the fake launcher reuses confirmation ids across staged receipts, so this process's spent-set must not carry over
    h.receipts.set(key, text);
    h.guards.processAbsent = true;
    const second = await h.host.start(h.workspaceId);
    expect(second.leaseEpoch).toBe(4);
    expect(h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.replayDebt).toBeUndefined();
    expect(h.receipts.size).toBe(0);
  });
});

describe("retained receipt files are retired only after the disk is otherwise settled", () => {
  test("a Class B file is left in place while the disk is held, and removed once another proof settles it", async () => {
    const h = createHarness({ crashAt: "power-running" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    const text = serializeCoworkNativeStopReceipt(h.launcher.last.stagedUncertain("daemon-lost"));
    h.restart({ newBoot: true });
    h.receipts.set(keyOf(h), text);
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", ownerRetained: true }]);
    expect(h.receipts.size).toBe(1);
    h.hostBoot.ended = true; // real proof: the previous boot is over
    expect(h.host.bootReconcile()).toMatchObject([{ action: "released", evidence: "new-boot" }]);
    expect(owners(h)).toEqual([null, null]);
    expect(h.receipts.size).toBe(0);
  });
});
