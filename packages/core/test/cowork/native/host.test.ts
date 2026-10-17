import { afterEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { CoworkNativeHost, CoworkNativeHostError, COWORK_NATIVE_HOST_DEFAULT_TIMEOUTS } from "../../../src/cowork/native/host";
import { COWORK_NATIVE_LIMITS, coworkNativeHostStopWaitMs } from "../../../src/cowork/native/protocol";
import { cleanupHarnesses, createHarness, IMAGE_DIGEST, START_PHASES } from "./harness";

afterEach(() => { cleanupHarnesses(); });

const owners = (h: ReturnType<typeof createHarness>) => h.volumes.records(h.workspaceId).map(v => v.owner);
const admissionOf = (h: ReturnType<typeof createHarness>) => h.ledger.listActive()[0];
const open = (fd: number) => { try { statSync(`/dev/fd/${fd}`); return true; } catch { return false; } };

test("the full sequence runs in order and ends running, owned, ready and admitted", async () => {
  const h = createHarness();
  const running = await h.host.start(h.workspaceId);
  const workspace = h.records.get(h.workspaceId);
  expect([workspace.power, workspace.incarnationId, workspace.leaseEpoch]).toEqual(["running", running.incarnationId, 1]);
  expect(h.host.activeWorkspaces()).toEqual([h.workspaceId]);
  // Order of the host's own steps, and the launcher messages interleaved with them.
  const host = h.events.filter(event => event.startsWith("host:")).map(event => event.slice(5));
  expect(host).toEqual([...START_PHASES]);
  const launcher = h.events.filter(event => event.startsWith("launcher:")).map(event => event.slice(9));
  expect(launcher).toEqual(["begin", "volumes", "mux_down", "mux_down", "mux_down"]); // plan, ready, conversations
  // claim happened BEFORE the descriptors reached the launcher, the format intent BEFORE they were opened.
  const order = h.events.filter(event => event === "host:claimed" || event === "host:filesystem-intent" || event === "host:volumes-opened" || event === "launcher:volumes" || event === "host:transferred");
  expect(order).toEqual(["host:claimed", "host:filesystem-intent", "host:volumes-opened", "launcher:volumes", "host:transferred"]);
  // the owner tuple is the one handed to the launcher, with the pinned digest
  const owner = running.owner, session = h.launcher.last;
  expect(owners(h)).toEqual([owner, owner]);
  expect(owner.runtimeImageDigest).toBe(IMAGE_DIGEST);
  expect(session.scope).toMatchObject({ workspaceId: h.workspaceId, incarnationId: owner.incarnationId, leaseEpoch: 1, controllerInstanceId: owner.controllerInstanceId, workerInstanceId: owner.workerInstanceId, runtimeImageDigest: IMAGE_DIGEST, vcpus: 2, memoryMiB: 768 });
  expect(owner.controllerInstanceId).toMatch(/^ctl-boot-one-[a-f0-9]{8}$/);
  // two real descriptors arrived with the volumes line, and the daemon closed its own copies afterwards
  expect(session.arrivals).toHaveLength(1); expect(session.arrivals[0]).toHaveLength(2);
  const sent = session.received.find(item => item.message.t === "volumes")!;
  expect(sent.rights).toHaveLength(2); expect(sent.rights.some(open)).toBe(false);
  // filesystems confirmed, admission running
  expect(h.volumes.records(h.workspaceId).map(v => v.filesystemState)).toEqual(["ready", "ready"]);
  expect(h.volumes.filesystemsReady({ workspaceId: h.workspaceId, owner, proof: h.authority.bindingFor(h.workspaceId)!.volumeProof() })).toBe(true);
  expect(admissionOf(h)).toMatchObject({ state: "running", workspaceId: h.workspaceId, incarnationId: owner.incarnationId, leaseEpoch: 1 });
  expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
});

test("an orderly stop releases the volumes, then the admission, then power, in that order, and a second start replays the journal", async () => {
  const h = createHarness();
  const first = await h.host.start(h.workspaceId);
  const outcome = await first.stop("user");
  expect(outcome).toEqual({ released: true, evidence: "orderly-receipt" });
  const order = h.events.filter(event => ["host:drain-requested", "host:stop-receipt-received", "host:volumes-released", "host:admission-released", "host:power-stopped", "host:receipt-retired"].includes(event));
  expect(order).toEqual(["host:drain-requested", "host:stop-receipt-received", "host:volumes-released", "host:admission-released", "host:power-stopped", "host:receipt-retired"]);
  expect(owners(h)).toEqual([null, null]);
  expect(h.records.get(h.workspaceId).power).toBe("stopped");
  expect(h.ledger.listActive()).toEqual([]);
  expect(h.host.activeWorkspaces()).toEqual([]);
  expect(h.receipts.size).toBe(0); // retired
  expect(h.launcher.last.received.map(item => item.message.t).slice(-2)).toEqual(["stop", "receipt_retire"]);
  const second = await h.host.start(h.workspaceId);
  expect(second.leaseEpoch).toBe(2); expect(second.incarnationId).not.toBe(first.incarnationId);
  const plan = h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.plan;
  expect(plan.volumes.map(v => v.action)).toEqual(["replay-journal-then-probe", "replay-journal-then-probe"]);
  expect(h.records.get(h.workspaceId).power).toBe("running");
});

test("start refuses a running, owned or unallocated workspace and a bad image digest without any effect", async () => {
  const h = createHarness();
  await h.host.start(h.workspaceId);
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "busy" });
  const g = createHarness();
  g.records.beginIncarnation(g.workspaceId, "inc-manual", g.records.get(g.workspaceId).configRevision);
  await expect(g.host.start(g.workspaceId)).rejects.toMatchObject({ code: "not_stopped" });
  const bad = createHarness();
  const host = new CoworkNativeHost({ ...bad.deps, images: { runtimeImageDigest: () => "XYZ" } });
  await expect(host.start(bad.workspaceId)).rejects.toBeInstanceOf(CoworkNativeHostError);
  expect(bad.records.get(bad.workspaceId).power).toBe("stopped");
  expect(bad.records.get(bad.workspaceId).leaseEpoch).toBe(0);
});

// ------------------------------------------------------------------------------------------------ failures during start

import type { FakeBehavior } from "./fake-launcher";
import { CoworkVolumeError } from "../../../src/cowork/volumes";
import { serializeCoworkNativeStopReceipt } from "../../../src/cowork/native/protocol";

const admissionState = (h: ReturnType<typeof createHarness>) => h.ledger.listActive().map(record => record.state);

/** A start that fails while a live, honest launcher can still be told to stop: the stop is orderly, so everything is released. */
const SETTLED_ORDERLY: [string, FakeBehavior, string][] = [
  ["the launcher refuses to begin", { begin: "refuse" }, "launcher_refused"],
  ["the begun reply names another worker", { begin: "other-worker" }, "protocol"],
  ["the launcher never answers begin", { begin: "silent" }, "timeout"],
  ["the launcher rejects the volumes", { volumes: "refuse" }, "launcher_refused"],
  ["the launcher never accepts the volumes", { volumes: "silent" }, "timeout"],
  ["the guest reports a format fault", { bootstrap: "fault" }, "guest_fault"],
  ["the guest never answers the plan", { bootstrap: "silent" }, "timeout"],
  ["the guest echoes another nonce", { bootstrap: "wrong-nonce" }, "start_failed"],
  ["the guest answers another operation", { bootstrap: "wrong-operation" }, "start_failed"],
  ["the guest's receipt does not match the plan", { bootstrap: "tampered-receipt" }, "start_failed"],
  ["the guest never reports the mount", { mounted: "silent" }, "timeout"],
];
for (const [name, behavior, expected] of SETTLED_ORDERLY) {
  test(`${name}: start fails with ${expected} and the orderly stop that follows releases everything`, async () => {
    const h = createHarness({ behavior });
    const error = await h.host.start(h.workspaceId).then(() => null, e => e as CoworkNativeHostError);
    expect(error).toBeInstanceOf(CoworkNativeHostError); expect(String(error!.code)).toBe(expected);
    expect(h.records.get(h.workspaceId).power).toBe("stopped");
    expect(owners(h)).toEqual([null, null]); expect(h.ledger.listActive()).toEqual([]); expect(h.host.activeWorkspaces()).toEqual([]);
    expect(h.launcher.last.received.map(item => item.message.t)).toContain("stop");
    const stop = h.launcher.last.received.find(item => item.message.t === "stop")!.message;
    expect(stop).toMatchObject({ reason: "failed-start" });
    expect(h.calls.ledgerRelease).toBe(1);
    expect(h.calls.volumeRelease).toBe(h.volumes.records(h.workspaceId)[0]!.lastStopId === null ? 0 : 1);
  });
}

test("a guest that never says hello leaves a VM that cannot have drained: the launcher's answer is uncertain and nothing is released", async () => {
  const h = createHarness({ behavior: { guestHello: "silent" } });
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "timeout" });
  expect(h.records.get(h.workspaceId).power).toBe("uncertain");
  expect(admissionState(h)).toEqual(["uncertain"]); expect(owners(h).every(owner => owner !== null)).toBe(true);
  expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
});

test("a hostile bootstrap that sends a runtime frame before the mount is a protocol fault, settled orderly", async () => {
  const h = createHarness({ behavior: { bootstrap: "runtime-frame", mounted: "silent" } });
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "timeout" });
  expect(h.records.get(h.workspaceId).power).toBe("stopped");
});

test("a guest fault narrows the volume state: the format intent is consumed and the pair needs explicit recovery", async () => {
  const h = createHarness({ behavior: { bootstrap: "fault" } });
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "guest_fault" });
  expect(h.volumes.records(h.workspaceId).map(v => [v.filesystemState, v.formatEligible])).toEqual([["recovery-required", false], ["recovery-required", false]]);
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ cause: expect.any(CoworkVolumeError) });
});

test("a launcher that cannot be spawned leaves the admission uncertain and the incarnation uncertain: nothing proves nothing started", async () => {
  const h = createHarness({ behavior: { spawn: "fail" } });
  const seen: string[] = []; h.host.onUncertain(event => seen.push(event.reason));
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "start_failed" });
  expect(h.records.get(h.workspaceId).power).toBe("uncertain");
  expect(admissionState(h)).toEqual(["uncertain"]); expect(owners(h)).toEqual([null, null]);
  expect(seen).toHaveLength(1);
  expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
  // and the same-boot recovery has nothing to release it with
  expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained", admission: "uncertain" });
});

test("a launcher from another boot, and a daemon identity from another boot, are refused", async () => {
  const h = createHarness({ behavior: { helloBoot: "boot-elsewhere" } });
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "bad_boot" });
  expect(h.records.get(h.workspaceId).power).toBe("uncertain");
  const g = createHarness();
  const host = new CoworkNativeHost({ ...g.deps, daemon: () => ({ ...g.daemon, bootId: "boot-stale" }) });
  await expect(host.start(g.workspaceId)).rejects.toMatchObject({ code: "bad_boot" });
  expect(g.records.get(g.workspaceId).leaseEpoch).toBe(0); // refused before the incarnation moved
});

test("a failed start whose stop is not orderly keeps ownership and marks everything uncertain", async () => {
  for (const stop of ["uncertain", "eof", "silent", "fault", "wrong-nonce", "bad-invariants", "other-incarnation", "wrong-volume"] as const) {
    const h = createHarness({ behavior: { bootstrap: "fault", stop } });
    await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "guest_fault" });
    expect(`${stop}:${h.records.get(h.workspaceId).power}`).toBe(`${stop}:uncertain`);
    expect(`${stop}:${owners(h).every(owner => owner !== null)}`).toBe(`${stop}:true`);
    expect(`${stop}:${admissionState(h).join()}`).toBe(`${stop}:uncertain`);
    expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
  }
});

// ------------------------------------------------------------------------------------------------ D1: a Class B event never releases

const NOT_ORDERLY = ["uncertain", "eof", "silent", "fault", "wrong-nonce", "bad-invariants", "other-incarnation", "wrong-volume", "other-request-id", "other-launcher", "denies-attach", "denies-boot"] as const;
for (const stop of NOT_ORDERLY) {
  test(`stop answered by "${stop}": nothing is released, ownership is retained, and no later EOF, dead process or repeat changes that`, async () => {
    const h = createHarness({ behavior: { stop } });
    const running = await h.host.start(h.workspaceId), seen: string[] = []; h.host.onUncertain(event => seen.push(event.reason));
    const outcome = await running.stop();
    expect(outcome.released).toBe(false);
    expect(h.records.get(h.workspaceId).power).toBe("uncertain");
    expect(admissionState(h)).toEqual(["uncertain"]);
    expect(owners(h)).toEqual([running.owner, running.owner]);
    expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
    expect(h.host.activeWorkspaces()).toEqual([]);
    expect(seen).toHaveLength(1);
    // a restart, a dead owner process and an EOF are all "evidence" a naive controller would accept
    h.launcher.last.eof();
    h.restart();
    expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", power: "uncertain", ownerRetained: true }]);
    expect(h.host.recover(h.workspaceId)).toMatchObject({ action: "retained" });
    expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
    expect(owners(h).every(owner => owner !== null)).toBe(true);
  });
}

// ------------------------------------------------------------------------------------------------ a running workspace

test("a launcher that speaks while running: an uncertain receipt, a fault, an EOF and an unsolicited stop only mark it uncertain", async () => {
  const cases: [string, (h: ReturnType<typeof createHarness>) => void][] = [
    ["uncertain receipt", h => h.launcher.last.push({ t: "uncertain", receipt: h.launcher.last.stagedUncertain("worker-crashed") })],
    ["launcher fault", h => h.launcher.last.push({ t: "fault", code: "protocol_violation" })],
    ["channel EOF", h => h.launcher.last.eof()],
    ["an orderly receipt nobody asked for", h => h.launcher.last.push({ t: "stopped", id: null, receipt: h.launcher.last.stagedOrderly("ab".repeat(16)) })],
  ];
  for (const [name, act] of cases) {
    const h = createHarness(), running = await h.host.start(h.workspaceId), seen: string[] = []; h.host.onUncertain(event => seen.push(event.reason));
    act(h);
    await Bun.sleep(10);
    expect(`${name}:${h.records.get(h.workspaceId).power}`).toBe(`${name}:uncertain`);
    expect(`${name}:${admissionState(h).join()}`).toBe(`${name}:uncertain`);
    expect(owners(h)).toEqual([running.owner, running.owner]);
    expect(h.calls.volumeRelease + h.calls.ledgerRelease).toBe(0);
    expect(h.host.activeWorkspaces()).toEqual([]);
    expect(seen).toHaveLength(1);
    await expect(running.stop()).rejects.toMatchObject({ code: "not_running" });
  }
});

test("stopping something that is not running, or twice, is refused", async () => {
  const h = createHarness();
  await expect(h.host.stop(h.workspaceId)).rejects.toMatchObject({ code: "not_running" });
  const running = await h.host.start(h.workspaceId);
  await running.stop();
  await expect(running.stop()).rejects.toMatchObject({ code: "not_running" });
});

// ------------------------------------------------------------------------------------------------ replay debt across writers

import type { Harness } from "./harness";
async function interruptedReplay(): Promise<{ h: Harness; key: string; debtEpoch: number }> {
  // incarnation 1 formats and stops; incarnation 2 starts its journal replay and the process dies before the receipt is confirmed
  const h = createHarness();
  await (await h.host.start(h.workspaceId)).stop();
  h.restart({ crashAt: "receipt-received" });
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ name: "CoworkNativeSimulatedCrash" });
  const ws = h.records.get(h.workspaceId), debt = h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.replayDebt!;
  expect(debt.owner.leaseEpoch).toBe(2); expect(ws.leaseEpoch).toBe(2);
  return { h, key: `${ws.workspaceId}|${ws.incarnationId}|${ws.leaseEpoch}`, debtEpoch: debt.owner.leaseEpoch };
}

test("a replay interrupted by a crash leaves a debt: with no evidence the old writer keeps the volumes and nothing starts", async () => {
  const { h } = await interruptedReplay();
  h.restart();
  expect(h.host.bootReconcile()).toMatchObject([{ action: "retained", ownerRetained: true, power: "uncertain" }]);
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "not_stopped" });
  expect(h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.replayDebt).toBeDefined();
});

test("the old writer's retained orderly receipt releases it, survives for the debt, and is retired only after the successor confirmed", async () => {
  const { h, key } = await interruptedReplay();
  const crashed = h.launcher.last;
  h.restart();
  h.receipts.set(key, serializeCoworkNativeStopReceipt(crashed.stagedOrderly("ab".repeat(16), { origin: "owner-loss-drain" })));
  expect(h.host.bootReconcile()).toMatchObject([{ action: "released", evidence: "orderly-receipt", power: "stopped" }]);
  expect(h.receipts.size).toBe(1); // a debt still names that writer, so its proof of stopping must outlive the release
  // a restart forgets everything in memory; the receipt is read back from the launcher's store
  h.restart();
  const third = await h.host.start(h.workspaceId);
  expect(third.leaseEpoch).toBe(3);
  const plan = h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.plan;
  expect(plan.protocolVersion === 3 && plan.priorReplay?.owner.leaseEpoch).toBe(2);
  expect(h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.replayDebt).toBeUndefined();
  expect(h.receipts.size).toBe(0); // settled
});

test("without that receipt the debt makes the next start refuse with stop_unconfirmed, and the failed start settles orderly", async () => {
  const { h } = await interruptedReplay();
  const ws = h.records.get(h.workspaceId);
  h.restart();
  h.ownerRecoverAttestation.value = { kind: "owner-recover", workspaceId: h.workspaceId, incarnationId: ws.incarnationId, leaseEpoch: ws.leaseEpoch, attestedBy: "owner" };
  expect(h.host.recover(h.workspaceId, { ownerRecover: true })).toMatchObject({ action: "released", evidence: "owner-recover" });
  h.restart(); // the proof of stopping lived in memory only
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "start_failed", cause: expect.objectContaining({ code: "stop_unconfirmed" }) });
  expect(h.records.get(h.workspaceId).power).toBe("stopped"); expect(owners(h)).toEqual([null, null]);
  expect(h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.replayDebt).toBeDefined(); // still owed
});

test("a new boot that ended proves the old writer stopped, even after the process that proved it is gone", async () => {
  const { h } = await interruptedReplay();
  h.restart({ newBoot: true }); h.hostBoot.ended = true;
  expect(h.host.bootReconcile()).toMatchObject([{ action: "released", evidence: "new-boot" }]);
  h.restart(); // forgets the in-memory proof; the boot id inside the old owner tuple re-derives it
  const third = await h.host.start(h.workspaceId);
  expect(third.leaseEpoch).toBe(3);
  expect(h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.plan.protocolVersion).toBe(3);
});

test("an orderly stop after an interrupted replay keeps the old writer's receipt, both in the store and on the launcher", async () => {
  // incarnation 1 formats and stops; incarnation 2 replays, the guest faults, and the stop that follows is orderly
  const h = createHarness();
  await (await h.host.start(h.workspaceId)).stop();
  h.restart({ behavior: { bootstrap: "fault", stop: "orderly" } });
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "guest_fault" });
  const volumes = h.volumes.records(h.workspaceId);
  expect(volumes.every(v => v.owner === null && v.filesystemJournal?.replayDebt?.owner.leaseEpoch === 2)).toBe(true);
  expect(h.records.get(h.workspaceId).power).toBe("stopped");
  expect(h.receipts.size).toBe(1); // epoch 2's receipt: a debt still names that writer
  expect(h.launcher.last.received.map(item => item.message.t)).not.toContain("receipt_retire");
  // and the next incarnation can still prove that writer stopped, from the store alone, after a restart; confirming settles the debt
  h.restart();
  const third = await h.host.start(h.workspaceId);
  expect(third.leaseEpoch).toBe(3);
  expect(h.volumes.records(h.workspaceId)[0]!.filesystemJournal!.replayDebt).toBeUndefined();
  expect(h.receipts.size).toBe(0);
});

test("a start refuses, before the incarnation moves, while a previous owner still holds the volumes", async () => {
  const h = createHarness();
  const owner = { controllerInstanceId: "ctl-boot-one-0000000f", workerInstanceId: "wrk-held", incarnationId: "inc-held", leaseEpoch: 1, runtimeImageDigest: IMAGE_DIGEST };
  h.db.db.run("UPDATE cowork_volumes SET owner_json=? WHERE workspace_id=?", [JSON.stringify(owner), h.workspaceId]);
  await expect(h.host.start(h.workspaceId)).rejects.toMatchObject({ code: "owner_held" });
  const ws = h.records.get(h.workspaceId);
  expect([ws.power, ws.leaseEpoch, ws.incarnationId]).toEqual(["stopped", 0, null]);
  expect(h.launcher.spawned).toEqual([]); expect(h.ledger.listActive()).toEqual([]);
});

test("a running workspace's launcher chatter is not kept: only terminal verdicts are queued, so a flood cannot grow memory", async () => {
  const h = createHarness(), running = await h.host.start(h.workspaceId), session = h.launcher.last;
  for (let n = 0; n < 500; n++) {
    session.push({ t: "pong", id: `ping-${n % 9}` });
    session.push({ t: "worker_state", state: "vm_running" });
    session.push({ t: "mux_up", frame: { class: "runtime", seq: n + 1, conversation: 0, stream: "out", end: false, payload: new Uint8Array(8) } });
  }
  await Bun.sleep(10);
  expect(h.host.queuedLauncherMessages(h.workspaceId)).toBe(0);
  expect(h.records.get(h.workspaceId).power).toBe("running"); // chatter is not a verdict
  expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
});

test("a worker that reported guest_fault makes the otherwise perfect orderly receipt not orderly: the workspace stays uncertain", async () => {
  const h = createHarness(), running = await h.host.start(h.workspaceId);
  h.launcher.last.push({ t: "worker_state", state: "guest_fault" });
  await Bun.sleep(10);
  const outcome = await running.stop();
  expect(outcome.released).toBe(false);
  expect(h.records.get(h.workspaceId).power).not.toBe("stopped");
});

test("the host waits for the stop verdict through the VMM exit allowance: an answer after the guest budget but inside the launcher's kill deadline still releases", async () => {
  const h = createHarness({ behavior: { stop: "late-orderly" }, timeouts: { drainBudgetMs: 50, stopGraceMs: 50, exitAllowanceMs: 1_000 } });
  const running = await h.host.start(h.workspaceId);
  expect(await running.stop()).toEqual({ released: true, evidence: "orderly-receipt" });
});
test("the host's default wait for a stop is the contract's H: budget, plus the exit watchdog and the launcher's margin, plus the daemon's margin", () => {
  expect(COWORK_NATIVE_HOST_DEFAULT_TIMEOUTS.drainBudgetMs + COWORK_NATIVE_HOST_DEFAULT_TIMEOUTS.exitAllowanceMs + COWORK_NATIVE_HOST_DEFAULT_TIMEOUTS.stopGraceMs).toBe(coworkNativeHostStopWaitMs(COWORK_NATIVE_LIMITS.drainBudgetMs));
});

test("the host refuses a stop wait shorter than the contract's H unless a test says so", () => {
  const h = createHarness();
  const deps = { ...h.deps, unsafeTestTimeouts: undefined };
  expect(() => new CoworkNativeHost({ ...deps, timeouts: { drainBudgetMs: 30_000, exitAllowanceMs: 0, stopGraceMs: 1_000 } })).toThrow();
  expect(() => new CoworkNativeHost({ ...deps, timeouts: { drainBudgetMs: 120_000 } })).not.toThrow(); // defaults for the other two still reach H for the larger budget
  expect(() => new CoworkNativeHost({ ...deps, timeouts: undefined })).not.toThrow();
  expect(() => new CoworkNativeHost({ ...h.deps, timeouts: { drainBudgetMs: 30_000, exitAllowanceMs: 0, stopGraceMs: 1_000 } })).not.toThrow(); // the harness's explicit test override
});
