import { afterEach, describe, expect, test } from "bun:test";
import { AdmissionError } from "../../../src/cowork/admission";
import { CoworkNativeHost, CoworkNativeSimulatedCrash } from "../../../src/cowork/native/host";
import { serializeCoworkNativeStopReceipt } from "../../../src/cowork/native/protocol";
import { CoworkNativeStopEvidenceError, mintOrderlyStopProof } from "../../../src/cowork/native/stop-proof";
import { cleanupHarnesses, createHarness, type Harness } from "./harness";

afterEach(() => { cleanupHarnesses(); });
const owners = (h: Harness) => h.volumes.records(h.workspaceId).map(v => v.owner);
const power = (h: Harness) => h.records.get(h.workspaceId).power;
const admissions = (h: Harness) => h.ledger.listActive().map(record => record.state);
const keyOf = (h: Harness) => { const ws = h.records.get(h.workspaceId); return `${ws.workspaceId}|${ws.incarnationId}|${ws.leaseEpoch}`; };
const scopeOf = (h: Harness) => { const ws = h.records.get(h.workspaceId); return { workspaceId: ws.workspaceId, incarnationId: ws.incarnationId!, leaseEpoch: ws.leaseEpoch }; };
const attestation = (h: Harness) => ({ kind: "owner-recover" as const, ...scopeOf(h), attestedBy: "owner" as const });

describe("a healthy run outlives the admission heartbeat timeout, and a stop never wedges", () => {
  test("the host beats from the reserve to the disposal, so 90 s of silence from anyone else never expires the row", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId);
    expect(h.timers.active).toBe(1);
    for (let round = 0; round < 3; round++) { h.clock.advance(25_000); h.timers.tick(); h.ledger.reconcile(); } // the ledger's timeout is 30 s
    expect(admissions(h)).toEqual(["running"]);
    expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
    expect(h.timers.active).toBe(0); expect(power(h)).toBe("stopped"); expect(h.ledger.listActive()).toEqual([]);
  });
  test("the beat starts at the reserve, so a long start is not expired either", async () => {
    const h = createHarness({ crashAt: "launcher-spawned" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    expect(h.timers.active).toBe(1);
    h.clock.advance(25_000); h.timers.tick(); h.clock.advance(25_000); h.timers.tick();
    h.ledger.reconcile();
    expect(admissions(h)).toEqual(["reserved"]);
  });
  test("a row the ledger already marked lapsed is revived, not wedged: stop completes and releases", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId);
    h.clock.advance(31_000); h.ledger.reconcile(); // nobody beat
    expect(h.ledger.listActive()[0]).toMatchObject({ state: "uncertain", uncertainReason: "heartbeat-expired" });
    expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
    expect(power(h)).toBe("stopped"); expect(owners(h)).toEqual([null, null]); expect(h.ledger.listActive()).toEqual([]);
  });
  test("a harder uncertain row still goes uncertain to draining and the stop completes", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId), record = h.ledger.listActive()[0]!;
    h.ledger.transition(record.admissionId, record.owner, "running", "uncertain");
    expect(h.ledger.listActive()[0]).toMatchObject({ state: "uncertain", heartbeatResumeState: null });
    expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
  });
  test("when every bookkeeping move fails, the stop request still goes out, the run is disposed, and the release still happens", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId);
    h.ledger.transition = () => { throw new AdmissionError("transition_refused"); };
    h.db.db.run("UPDATE cowork_workspaces SET power='starting' WHERE workspace_id=?", [h.workspaceId]); // the power move cannot be made from here either
    const outcome = await running.stop();
    expect(h.launcher.last.received.map(item => item.message.t)).toContain("stop");
    expect(outcome).toEqual({ released: true, evidence: "orderly-receipt" });
    expect(h.host.activeWorkspaces()).toEqual([]); expect(h.timers.active).toBe(0);
  });
  test("a stop that fails after its request still disposes the run", async () => {
    const h = createHarness({ behavior: { stop: "silent" } });
    const running = await h.host.start(h.workspaceId);
    expect(await running.stop()).toMatchObject({ released: false });
    expect(h.host.activeWorkspaces()).toEqual([]); expect(h.timers.active).toBe(0);
    await expect(h.host.stop(h.workspaceId)).rejects.toMatchObject({ code: "not_running" });
  });
});

describe("a row that lapsed in the middle of a start", () => {
  test("is revived before it is moved, so the start completes and the admission ends running", async () => {
    const h = createHarness({ onCheckpoint: (phase, harness) => { if (phase === "ready-sent") { harness.clock.advance(31_000); harness.ledger.reconcile(); } } });
    const record = () => h.ledger.listActive()[0]!;
    const running = await h.host.start(h.workspaceId);
    expect(record()).toMatchObject({ state: "running", uncertainReason: null });
    expect(power(h)).toBe("running");
    expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
  });
});

describe("a stop receipt may not know less than the daemon saw, each observation on its own", () => {
  test("the descriptors were accepted and nothing else was seen: an `unattached` receipt is refused", async () => {
    const h = createHarness({ behavior: { quietVm: true, stop: "denies-attach" }, timeouts: { guestHelloMs: 80 } });
    await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "timeout" });
    expect(power(h)).toBe("uncertain"); expect(owners(h).every(owner => owner !== null)).toBe(true);
    expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
  });
  test("a running VM was reported and the descriptors never acknowledged: a `not-booted` receipt is refused", async () => {
    const h = createHarness({ behavior: { volumes: "silent", chatter: ["vm_running"], stop: "denies-boot" }, timeouts: { volumesMs: 80 } });
    await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "timeout" });
    expect(power(h)).toBe("uncertain"); expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
  });
  test("a guest greeting was seen and the descriptors never acknowledged: a `not-booted` receipt is refused", async () => {
    const h = createHarness({ behavior: { volumes: "silent", chatter: ["hello"], stop: "denies-boot" }, timeouts: { volumesMs: 80 } });
    await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "timeout" });
    expect(power(h)).toBe("uncertain"); expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
  });
  test("with nothing observed, the same honest receipts are accepted", async () => {
    const h = createHarness({ behavior: { volumes: "silent" }, timeouts: { volumesMs: 80 } });
    await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "timeout" });
    expect(power(h)).toBe("stopped"); expect(h.ledger.listActive()).toEqual([]);
  });
});

describe("the launch journal and owner recovery", () => {
  test("the journal is written before the spawn, with the launcher's identity once it exists, with the worker's at begun, and forgotten after the release", async () => {
    const spawning = createHarness({ behavior: { spawn: "crash" } });
    await expect(spawning.host.start(spawning.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    expect([...spawning.journal.values()]).toMatchObject([{ launcher: null, worker: null, bootId: "boot-one" }]);
    const spawned = createHarness({ crashAt: "launcher-spawned" });
    await expect(spawned.host.start(spawned.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    expect([...spawned.journal.values()]).toMatchObject([{ launcher: { pid: 5151, startToken: "start-5151", instanceId: "launcher-fake0001" }, worker: null }]);
    const begun = createHarness({ crashAt: "worker-begun" });
    await expect(begun.host.start(begun.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    expect([...begun.journal.values()]).toMatchObject([{ launcher: { pid: 5151 }, worker: { pid: 4242, startToken: "start-4242" } }]);
    const whole = createHarness();
    const running = await whole.host.start(whole.workspaceId);
    expect(whole.journal.size).toBe(1);
    await running.stop();
    expect(whole.journal.size).toBe(0);
  });
  test("owner recovery hands the guard the recorded launcher and worker identities, not just the owner tuple", async () => {
    const h = createHarness({ crashAt: "worker-begun" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart();
    h.ownerRecoverAttestation.value = attestation(h);
    expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "released", evidence: "owner-recover" });
    expect(h.guards.seen).toHaveLength(1);
    expect(h.guards.seen[0]!.processes).toMatchObject({ bootId: "boot-one", launcher: { pid: 5151, startToken: "start-5151", instanceId: "launcher-fake0001" }, worker: { pid: 4242, startToken: "start-4242" } });
    expect(h.journal.size).toBe(0); // released, so forgotten
  });
  test("a launch whose launcher identity was never written leaves a process nobody can name: owner recovery refuses, the guard is not even asked", async () => {
    const h = createHarness({ behavior: { spawn: "crash" } });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart();
    h.ownerRecoverAttestation.value = attestation(h);
    expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "retained", reason: "owner recovery refused" });
    expect(h.guards.seen).toEqual([]);
    h.journal.clear(); // no entry at all: this daemon started no launcher for the incarnation, so there is no process to name
    expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "released", evidence: "owner-recover" });
  });
});

describe("retained receipts must be attested by the port that serves them", () => {
  async function crashed(): Promise<Harness> {
    const h = createHarness({ crashAt: "power-running" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.receipts.set(keyOf(h), serializeCoworkNativeStopReceipt(h.launcher.last.stagedOrderly("ab".repeat(16), { origin: "owner-loss-drain" })));
    h.restart();
    return h;
  }
  test("an unattested record is ignored with an owner, without one, and for a replay debt", async () => {
    const h = await crashed();
    h.attested = false;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", ownerRetained: true });
    expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
    h.attested = true;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", evidence: "orderly-receipt" });
  });
  test("the same holds when no volume owner remains and only the admission is left", async () => {
    const h = createHarness({ crashAt: "worker-begun" }); // the worker exists, nothing is claimed yet
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.receipts.set(keyOf(h), serializeCoworkNativeStopReceipt(h.launcher.last.stagedOrderly("ab".repeat(16), { origin: "owner-loss-drain" })));
    h.restart(); h.attested = false;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", admission: "uncertain" });
    h.attested = true;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", evidence: "orderly-receipt" });
  });
});

describe("a boot change releases only when the ledger's own probe agrees", () => {
  test("if it does not, nothing is freed: not a disk, not the row, not the power state", async () => {
    const h = createHarness({ crashAt: "power-running" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart({ newBoot: true }); h.hostBoot.ended = true; h.ledgerAgrees = false;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", reason: "release incomplete (CoworkNativeStopEvidenceError:boot_not_ended)", ownerRetained: true, power: "uncertain" });
    expect(h.calls.volumeRelease).toBe(0); expect(h.ledger.listActive()).toHaveLength(1);
    h.ledgerAgrees = true;
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", evidence: "new-boot" });
  });
  test("the no-owner path runs the ledger's reconcile itself before it looks at the row again", async () => {
    const h = createHarness({ crashAt: "launcher-spawned" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart({ newBoot: true }); h.hostBoot.ended = true; // note: no bootReconcile, no reconcile by anyone else
    expect(h.calls.reconcile).toBe(0);
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "released", power: "stopped", admission: "none" });
    expect(h.calls.reconcile).toBeGreaterThan(0);
  });
  test("one workspace that cannot be settled does not stop boot reconcile from settling the others", async () => {
    const h = createHarness({ crashAt: "power-running" });
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart({ newBoot: true }); h.hostBoot.ended = true; h.ledgerAgrees = false;
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", reason: expect.stringContaining("release incomplete") }]);
  });
  test("a workspace whose records cannot even be read is reported, and the next one is still settled", async () => {
    const h = createHarness({ crashAt: "power-running" });
    const second = h.addWorkspace();
    await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart({ crashAt: "power-running" });
    await expect(h.host.start(second)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
    h.restart();
    h.db.db.run("UPDATE cowork_volumes SET owner_json=? WHERE workspace_id=?", ["{not json", h.workspaceId]); // the first workspace's pair no longer reads
    const reports = h.host.bootReconcile();
    expect(reports).toHaveLength(2);
    expect(reports.find(report => report.workspaceId === h.workspaceId)).toMatchObject({ action: "retained", ownerRetained: true, reason: "recovery failed (CoworkVolumeError:recovery_required)" });
    expect(reports.find(report => report.workspaceId === second)).toMatchObject({ action: "retained", power: "uncertain", ownerRetained: true, reason: "no release evidence" });
  });
});

describe("the release flow binds its proof to the incarnation it was asked about", () => {
  test("a valid proof for another incarnation, epoch or workspace is refused before anything is touched", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId), volumes = h.volumes.records(h.workspaceId), record = h.ledger.listActive()[0]!;
    const proof = mintOrderlyStopProof({ receipt: h.launcher.last.stagedOrderly("ab".repeat(16)), owner: running.owner, homeId: h.homeId, admission: { admissionId: record.admissionId, owner: { bootId: "boot-one" } }, volumes,
      source: { kind: "live", stopNonce: "ab".repeat(16), launcherInstanceId: h.launcher.last.launcherInstanceId, observed: { volumesAccepted: true, vmRunning: true, guestHello: true } }, registry: h.registry, now: () => 1 });
    const key = { workspaceId: h.workspaceId, incarnationId: running.incarnationId, leaseEpoch: running.leaseEpoch };
    for (const wrong of [{ ...key, incarnationId: "inc-other" }, { ...key, leaseEpoch: 9 }, { ...key, workspaceId: "workspace-other" }]) expect(() => h.recovery.release(wrong, running.owner, h.homeId, proof)).toThrow(CoworkNativeStopEvidenceError);
    expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0); expect(power(h)).toBe("running");
    expect(h.recovery.release(key, running.owner, h.homeId, proof)).toEqual({ retired: true });
  });
});

describe("a crash in the middle of releasing", () => {
  const PHASES = ["volumes-released", "admission-released", "power-stopped", "receipt-retired"] as const;
  for (const phase of PHASES) {
    test(`inside recovery's own release at ${phase}: the next run finishes it, each door used once`, async () => {
      const h = createHarness({ crashAt: "power-running" });
      await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
      h.receipts.set(keyOf(h), serializeCoworkNativeStopReceipt(h.launcher.last.stagedOrderly("ab".repeat(16), { origin: "owner-loss-drain" })));
      h.restart({ crashAt: phase });
      expect(() => h.host.bootReconcile()).toThrow(CoworkNativeSimulatedCrash);
      h.restart();
      const reports = h.host.bootReconcile();
      if (phase === "receipt-retired" || phase === "power-stopped") expect(reports).toEqual([]);
      else expect(reports).toMatchObject([{ action: "released", power: "stopped", ownerRetained: false, admission: "none" }]);
      expect(power(h)).toBe("stopped"); expect(owners(h)).toEqual([null, null]); expect(h.ledger.listActive()).toEqual([]);
      expect(h.calls.volumeRelease).toBe(1); expect(h.calls.ledgerRelease).toBe(1);
      expect((await h.host.start(h.workspaceId)).leaseEpoch).toBe(2);
    });
  }
  for (const phase of ["stop-receipt-received", "volumes-released", "admission-released", "power-stopped"] as const) {
    test(`inside the stop that settles a FAILED START at ${phase}: the next run converges`, async () => {
      const h = createHarness({ behavior: { bootstrap: "fault" }, crashAt: phase });
      await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
      h.restart();
      h.host.bootReconcile();
      expect(power(h)).toBe("stopped"); expect(owners(h)).toEqual([null, null]); expect(h.ledger.listActive()).toEqual([]);
      expect(h.calls.volumeRelease).toBe(1); expect(h.calls.ledgerRelease).toBe(1);
    });
  }
});

describe("starting is refused before it changes anything", () => {
  test("a host boot id that cannot be part of an owner tuple stops the start before the incarnation moves", async () => {
    const h = createHarness();
    h.hostBoot.current = "boot id with spaces";
    const host = new CoworkNativeHost({ ...h.deps, daemon: () => ({ ...h.daemon, bootId: "boot id with spaces" }) });
    await expect(host.start(h.workspaceId)).rejects.toMatchObject({ code: "bad_boot" });
    const ws = h.records.get(h.workspaceId);
    expect([ws.power, ws.leaseEpoch, ws.incarnationId]).toEqual(["stopped", 0, null]);
    expect(h.ledger.listActive()).toEqual([]); expect(h.launcher.spawned).toEqual([]);
  });
  test("a launcher spawn that never returns times out, leaves the run uncertain and spawns nothing twice", async () => {
    const h = createHarness({ behavior: { spawn: "hang" }, timeouts: { spawnMs: 80 } });
    await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "timeout" });
    expect(power(h)).toBe("uncertain"); expect(admissions(h)).toEqual(["uncertain"]); expect(h.timers.active).toBe(0);
    expect(h.launcher.spawned).toHaveLength(1);
  });
  test("a session that arrives after the deadline is closed, not adopted", async () => {
    const h = createHarness({ behavior: { spawn: "slow" }, timeouts: { spawnMs: 60 } });
    await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "timeout" });
    await Bun.sleep(400);
    expect(h.launcher.sessions).toHaveLength(1);
    expect(h.launcher.sessions[0]!.isLive()).toBe(false);
    expect(h.host.activeWorkspaces()).toEqual([]);
  });
});
