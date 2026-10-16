import { afterEach, describe, expect, test } from "bun:test";
import { CoworkVolumeError } from "../../../src/cowork/volumes";
import { CoworkNativeSimulatedCrash } from "../../../src/cowork/native/host";
import { serializeCoworkNativeStopReceipt } from "../../../src/cowork/native/protocol";
import { cleanupHarnesses, createHarness, START_PHASES, type Harness } from "./harness";

afterEach(() => { cleanupHarnesses(); });

const owners = (h: Harness) => h.volumes.records(h.workspaceId).map(v => v.owner);
const active = (h: Harness) => h.ledger.listActive();
const power = (h: Harness) => h.records.get(h.workspaceId).power;
const keyOf = (h: Harness) => { const ws = h.records.get(h.workspaceId); return `${ws.workspaceId}|${ws.incarnationId}|${ws.leaseEpoch}`; };
const none = (h: Harness) => { expect(h.calls.volumeRelease).toBe(0); expect(h.calls.ledgerRelease).toBe(0); };
const FORMATTING = new Set(["filesystem-intent", "volumes-opened", "transferred", "bootstrap-sent", "receipt-received"]);
const claimedAtPhase = (phase: string) => START_PHASES.indexOf(phase) >= START_PHASES.indexOf("claimed");

describe("a crash at every step of the start sequence", () => {
  for (const phase of START_PHASES) {
    test(`at ${phase}: a same-boot restart retains ownership, marks everything uncertain and releases nothing`, async () => {
      const h = createHarness({ crashAt: phase });
      await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
      expect(h.host.activeWorkspaces()).toEqual([h.workspaceId]);
      const claimed = owners(h).every(owner => owner !== null);
      expect(claimed).toBe(claimedAtPhase(phase));
      h.restart();
      const reports = h.host.bootReconcile();
      if (phase === "incarnation-begun") {
        // Only the incarnation bump happened: no admission, no launcher, no claim. Nothing to hold, back to stopped.
        expect(reports).toMatchObject([{ action: "released", evidence: "nothing-held", power: "stopped", ownerRetained: false }]);
        expect(power(h)).toBe("stopped");
      } else {
        expect(reports).toMatchObject([{ action: "retained", evidence: null, power: "uncertain", ownerRetained: claimed }]);
        expect(power(h)).toBe("uncertain");
        expect(active(h).map(record => record.state)).toEqual(["uncertain"]);
      }
      expect(owners(h).every(owner => owner !== null)).toBe(claimed);
      none(h);
      // Asking again changes nothing.
      expect(h.host.bootReconcile()).toMatchObject(phase === "incarnation-begun" ? [] : [{ action: "retained", power: "uncertain" }]);
      none(h);
    });
  }

  for (const phase of START_PHASES.filter(candidate => candidate !== "incarnation-begun")) {
    test(`at ${phase}: a new boot that really ended releases it with boot evidence, and the next start behaves as the volume state dictates`, async () => {
      const h = createHarness({ crashAt: phase });
      await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
      const claimed = claimedAtPhase(phase);
      h.restart({ newBoot: true });
      // The boot changed but nothing confirms the old one ended: still retained.
      expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", power: "uncertain", ownerRetained: claimed }]);
      none(h);
      h.hostBoot.ended = true;
      const reports = h.host.bootReconcile();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ action: "released", ownerRetained: false, power: "stopped", admission: "none" });
      expect(reports[0]!.evidence).toBe(claimed ? "new-boot" : "nothing-held"); // the top-level ledger reconcile had already released the row
      expect(owners(h)).toEqual([null, null]);
      expect(active(h)).toEqual([]);
      expect(h.calls.volumeRelease).toBe(claimed ? 1 : 0);
      if (FORMATTING.has(phase)) {
        // A consumed format intent is never retried: the volume layer demands explicit recovery, and the failed start is settled orderly.
        await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "start_failed", cause: expect.any(CoworkVolumeError) });
        expect(power(h)).toBe("stopped"); expect(owners(h)).toEqual([null, null]);
      } else {
        const running = await h.host.start(h.workspaceId);
        expect(power(h)).toBe("running"); expect(running.leaseEpoch).toBe(2);
      }
    });
  }

  test("a crash inside the volume layer's own intent commit is held the same way", async () => {
    const h = createHarness({ volumeCheckpoint: phase => { if (phase === "filesystem-intent-committed") throw new CoworkNativeSimulatedCrash(phase); } });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    expect(h.volumes.records(h.workspaceId).map(v => [v.filesystemState, v.formatEligible])).toEqual([["formatting", false], ["formatting", false]]);
    h.restart();
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", ownerRetained: true, power: "uncertain" }]);
    none(h);
  });
});

describe("a crash at every step of the stop sequence", () => {
  const STOP = ["drain-requested", "stop-receipt-received", "volumes-released", "admission-released", "power-stopped", "receipt-retired"] as const;
  for (const phase of STOP) {
    test(`at ${phase}: the launcher's retained orderly receipt finishes the job exactly once`, async () => {
      const h = createHarness({ crashAt: phase });
      const running = await h.host.start(h.workspaceId);
      await expect(running.stop()).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
      h.restart();
      const reports = h.host.bootReconcile();
      if (phase === "drain-requested") {
        // The stop was never sent: there is no receipt, so nothing is released.
        expect(reports).toMatchObject([{ action: "retained", power: "uncertain", ownerRetained: true }]); none(h);
        return;
      }
      if (phase === "power-stopped" || phase === "receipt-retired") {
        // Everything was already settled before the crash.
        expect(reports).toEqual([]);
      } else if (phase === "admission-released") {
        expect(reports).toMatchObject([{ action: "released", evidence: "nothing-held", power: "stopped" }]);
      } else {
        expect(reports).toMatchObject([{ action: "released", evidence: "orderly-receipt", power: "stopped", ownerRetained: false, admission: "none" }]);
      }
      expect(power(h)).toBe("stopped"); expect(owners(h)).toEqual([null, null]); expect(active(h)).toEqual([]);
      // Each release door was used at most once across the crash and the recovery.
      expect(h.calls.volumeRelease).toBe(1); expect(h.calls.ledgerRelease).toBe(1);
      // And the workspace starts again.
      expect((await h.host.start(h.workspaceId)).leaseEpoch).toBe(2);
    });
  }
});

describe("evidence is the only way out", () => {
  async function crashedRunning(): Promise<Harness> {
    const h = createHarness({ crashAt: "power-running" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    return h;
  }

  test("a vanished process, a closed channel and an expired heartbeat release nothing, however long they last", async () => {
    const h = await crashedRunning();
    h.launcher.last.eof();
    h.restart();
    for (let round = 0; round < 3; round++) {
      expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", power: "uncertain", ownerRetained: true, admission: "uncertain" }]);
      expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained" });
    }
    none(h);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
  });

  test("a Class B receipt in the launcher's store is read, reported and never releases", async () => {
    const h = await crashedRunning();
    h.receipts.set(keyOf(h), serializeCoworkNativeStopReceipt(h.launcher.last.stagedUncertain("daemon-lost")));
    h.restart();
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", ownerRetained: true, reason: expect.stringContaining("never releases") }]);
    none(h);
    expect(h.receipts.size).toBe(1);
  });

  test("a retained orderly receipt for another owner, another epoch or another volume does not release", async () => {
    const h = await crashedRunning();
    const session = h.launcher.last, nonce = "cc".repeat(16);
    const bad = [
      session.stagedOrderly(nonce, { workerInstanceId: "wrk-an-impostor" }),
      session.stagedOrderly(nonce, { controllerInstanceId: "ctl-boot-one-00000000" }),
      session.stagedOrderly(nonce, { leaseEpoch: 7 }),
      session.stagedOrderly(nonce, { incarnationId: "inc-someone-else" }),
      session.stagedOrderly(nonce, { workspaceId: "workspace-other" }),
      session.stagedOrderly(nonce, { homeId: "home-other" }),
      session.stagedOrderly(nonce, { admissionId: "adm-other" }),
      session.stagedOrderly(nonce, { hostBootId: "boot-two" }),
      session.stagedOrderly(nonce, { runtimeImageDigest: "e".repeat(64) }),
      session.stagedOrderly(nonce, { guest: { drain: "acked", powerOff: "not-booted" } }),
      { ...session.stagedOrderly(nonce), volumes: [{ ...session.stagedOrderly(nonce).volumes[0], inode: "999" }, session.stagedOrderly(nonce).volumes[1]] },
    ] as ReturnType<typeof session.stagedOrderly>[];
    h.restart();
    for (const receipt of bad) {
      h.receipts.set(keyOf(h), serializeCoworkNativeStopReceipt(receipt));
      expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", power: "uncertain", ownerRetained: true });
    }
    h.receipts.set(keyOf(h), "{not json}\n");
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", reason: "retained receipt unreadable" });
    none(h);
    h.receipts.set(keyOf(h), serializeCoworkNativeStopReceipt(session.stagedOrderly(nonce, { origin: "owner-loss-drain" })));
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", evidence: "orderly-receipt" });
    expect(h.calls.volumeRelease).toBe(1);
  });

  test("a receipt can release only once: after it did, a replay of the same text changes nothing", async () => {
    const h = await crashedRunning();
    const text = serializeCoworkNativeStopReceipt(h.launcher.last.stagedOrderly("dd".repeat(16), { origin: "owner-loss-drain" }));
    h.receipts.set(keyOf(h), text);
    h.restart();
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released" });
    const epoch = h.records.get(h.workspaceId).leaseEpoch;
    // The next incarnation claims the volumes; the old receipt is replayed at it.
    const second = await h.host.start(h.workspaceId);
    h.receipts.set(`${h.workspaceId}|${second.incarnationId}|${second.leaseEpoch}`, text);
    h.receipts.set(keyOf(h), text);
    h.restart();
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", ownerRetained: true }]);
    expect(h.calls.volumeRelease).toBe(1);
    expect(epoch).toBe(1);
  });

  test("owner recovery needs the explicit input AND both guards, and names this incarnation", async () => {
    const h = await crashedRunning();
    h.restart();
    const ws = h.records.get(h.workspaceId), attestation = { kind: "owner-recover", workspaceId: h.workspaceId, incarnationId: ws.incarnationId, leaseEpoch: ws.leaseEpoch, attestedBy: "owner" } as const;
    // Not asked for: boot reconcile never uses it.
    h.ownerRecoverAttestation.value = attestation;
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained" }]);
    // Asked for, but no attestation / a wrong one / a guard that disagrees.
    h.ownerRecoverAttestation.value = null;
    expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "retained", reason: "owner recovery refused" });
    for (const wrong of [{ ...attestation, incarnationId: "inc-elsewhere" }, { ...attestation, leaseEpoch: 9 }, { ...attestation, workspaceId: "workspace-other" }, { ...attestation, attestedBy: "launcher" }, { ...attestation, kind: "new-boot" }]) {
      h.ownerRecoverAttestation.value = wrong;
      expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "retained" });
    }
    h.ownerRecoverAttestation.value = attestation;
    h.guards.processAbsent = false;
    expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "retained" });
    h.guards.processAbsent = true; h.guards.imagesUnlocked = false;
    expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "retained" });
    none(h);
    h.guards.imagesUnlocked = true;
    expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "released", evidence: "owner-recover", power: "stopped", ownerRetained: false, admission: "none" });
    expect(h.calls.volumeRelease).toBe(1); expect(h.calls.ledgerRelease).toBe(1);
  });

  test("owner recovery also settles an incarnation that never claimed a volume", async () => {
    const h = createHarness({ crashAt: "launcher-spawned" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart();
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", ownerRetained: false, admission: "uncertain" }]);
    const ws = h.records.get(h.workspaceId);
    h.ownerRecoverAttestation.value = { kind: "owner-recover", workspaceId: h.workspaceId, incarnationId: ws.incarnationId, leaseEpoch: ws.leaseEpoch, attestedBy: "owner" };
    expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "released", evidence: "owner-recover", power: "stopped", admission: "none" });
    expect(h.calls.volumeRelease).toBe(0); expect(h.calls.ledgerRelease).toBe(1);
  });

  test("boot reconcile runs the admission ledger's own reconcile, and recover refuses a workspace this process runs", async () => {
    const h = createHarness();
    await h.host.start(h.workspaceId);
    const before = h.calls.reconcile;
    expect(h.host.bootReconcile()).toEqual([]); // a workspace this process is running is not its business
    expect(h.calls.reconcile).toBeGreaterThan(before);
    expect(power(h)).toBe("running");
    expect(() => h.host.recover(h.workspaceId)).toThrow("busy");
  });
});

describe("volume ownership that does not describe the current incarnation is never guessed at", () => {
  const setOwner = (h: Harness, purpose: "data" | "environment", owner: object | null) => h.db.db.run("UPDATE cowork_volumes SET owner_json=? WHERE workspace_id=? AND purpose=?", [owner === null ? null : JSON.stringify(owner), h.workspaceId, purpose]);
  test("an owner from another epoch, a half-owned pair and two different owners are retained, whatever receipt exists", async () => {
    const h = createHarness({ crashAt: "power-running" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    const owner = h.volumes.records(h.workspaceId)[0]!.owner!, receipt = serializeCoworkNativeStopReceipt(h.launcher.last.stagedOrderly("ab".repeat(16), { origin: "owner-loss-drain" }));
    h.restart(); h.receipts.set(keyOf(h), receipt);
    for (const [name, change] of [
      ["another epoch", () => { setOwner(h, "data", { ...owner, leaseEpoch: 9 }); setOwner(h, "environment", { ...owner, leaseEpoch: 9 }); }],
      ["another incarnation", () => { setOwner(h, "data", { ...owner, incarnationId: "inc-older" }); setOwner(h, "environment", { ...owner, incarnationId: "inc-older" }); }],
      ["half owned", () => { setOwner(h, "data", owner); setOwner(h, "environment", null); }],
      ["two owners", () => { setOwner(h, "data", owner); setOwner(h, "environment", { ...owner, workerInstanceId: "wrk-other" }); }],
    ] as const) {
      change();
      expect(`${name}:${JSON.stringify(h.host.recover(h.workspaceId))}`).toContain(`"action":"retained"`);
      expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
    }
    setOwner(h, "data", owner); setOwner(h, "environment", owner);
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released" }); // restored and attested: the receipt works again
  });
  test("boot evidence does not paper over it either: a changed, confirmed boot still retains a pair that is not one owner's", async () => {
    const h = createHarness({ crashAt: "power-running" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    const owner = h.volumes.records(h.workspaceId)[0]!.owner!;
    h.restart({ newBoot: true }); h.hostBoot.ended = true;
    setOwner(h, "environment", { ...owner, workerInstanceId: "wrk-other" });
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", reason: "volume ownership does not match the current incarnation", ownerRetained: true });
    setOwner(h, "environment", null);
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained" });
    expect(h.calls.volumeRelease).toBe(0);
    setOwner(h, "environment", owner);
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", evidence: "new-boot" });
  });
});
