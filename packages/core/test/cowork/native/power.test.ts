import { afterEach, describe, expect, test } from "bun:test";
import { CoworkError } from "../../../src/cowork/types";
import { COWORK_NATIVE_POWER_TRANSITIONS, CoworkNativePowerError, type CoworkPower, type CoworkPowerKey } from "../../../src/cowork/native/power";
import { mintReleaseToken, mintVolumesFreeToken, mintOrderlyStopProof, CoworkNativeStopEvidenceError } from "../../../src/cowork/native/stop-proof";
import { cleanupHarnesses, createHarness, type Harness } from "./harness";

afterEach(() => { cleanupHarnesses(); });

function started(h: Harness, label = "p"): CoworkPowerKey {
  const ws = h.records.get(h.workspaceId), incarnationId = `inc-${label}`, epoch = h.records.beginIncarnation(h.workspaceId, incarnationId, ws.configRevision);
  return { workspaceId: h.workspaceId, incarnationId, leaseEpoch: epoch.leaseEpoch };
}
const code = (body: () => unknown): string => { try { body(); } catch (error) { expect(error).toBeInstanceOf(CoworkNativePowerError); return (error as CoworkNativePowerError).code; } return "accepted"; };
const freeToken = (h: Harness, key: CoworkPowerKey) => mintVolumesFreeToken({ ...key, volumes: h.volumes });
const power = (h: Harness) => h.power.read(h.workspaceId).power;
const set = (h: Harness, value: CoworkPower) => h.db.db.run("UPDATE cowork_workspaces SET power=? WHERE workspace_id=?", [value, h.workspaceId]);

describe("compare-and-set power transitions", () => {
  test("the transition table is pinned, and `stopped` has no way out here", () => {
    expect(Object.fromEntries(Object.entries(COWORK_NATIVE_POWER_TRANSITIONS).map(([from, to]) => [from, [...to]]))).toEqual({
      stopped: [], starting: ["running", "draining", "uncertain", "stopped"], running: ["draining", "uncertain"], draining: ["uncertain", "stopped"], uncertain: ["draining", "stopped"] });
    expect(Object.isFrozen(COWORK_NATIVE_POWER_TRANSITIONS)).toBe(true);
  });
  test("a move needs the believed power, incarnation and epoch to match; otherwise nothing changes", () => {
    const h = createHarness(), key = started(h);
    expect(code(() => h.power.transition(key, "running", "draining"))).toBe("stale"); // not running yet
    expect(code(() => h.power.transition({ ...key, incarnationId: "inc-other" }, "starting", "running"))).toBe("stale");
    expect(code(() => h.power.transition({ ...key, leaseEpoch: key.leaseEpoch + 1 }, "starting", "running"))).toBe("stale");
    expect(code(() => h.power.transition({ ...key, workspaceId: "workspace-other" }, "starting", "running"))).toBe("stale");
    expect(power(h)).toBe("starting");
    h.power.transition(key, "starting", "running"); expect(power(h)).toBe("running");
    // a stale controller repeating the same move is refused: the first one already won
    expect(code(() => h.power.transition(key, "starting", "running"))).toBe("stale");
    h.power.transition(key, "running", "draining"); expect(power(h)).toBe("draining");
  });
  test("moves outside the table are illegal, whatever the evidence", () => {
    const h = createHarness(), key = started(h);
    expect(code(() => h.power.transition(key, "starting", "starting"))).toBe("illegal");
    expect(code(() => h.power.transition(key, "running", "stopped"))).toBe("illegal");
    expect(code(() => h.power.transition(key, "stopped", "starting"))).toBe("illegal");
    expect(code(() => h.power.transition(key, "stopped", "running"))).toBe("illegal");
    expect(code(() => h.power.transition(key, "running", "starting"))).toBe("illegal");
    expect(code(() => h.power.transition(key, "starting", "running", freeToken(h, key)))).toBe("illegal"); // a token belongs to `stopped` only
    expect(power(h)).toBe("starting");
  });
  test("`stopped` needs a release token for exactly this workspace, incarnation and epoch", () => {
    const h = createHarness(), key = started(h);
    expect(code(() => h.power.transition(key, "starting", "stopped"))).toBe("needs_release");
    for (const forged of [{}, { workspaceId: h.workspaceId, via: "release" }, JSON.parse(JSON.stringify(freeToken(h, key))), Object.create(freeToken(h, key)), null, "token"])
      expect(code(() => h.power.transition(key, "starting", "stopped", forged))).toBe("needs_release");
    const other = mintVolumesFreeToken({ ...key, incarnationId: "inc-other", volumes: h.volumes });
    expect(code(() => h.power.transition(key, "starting", "stopped", other))).toBe("needs_release");
    expect(code(() => h.power.transition(key, "starting", "stopped", mintVolumesFreeToken({ ...key, leaseEpoch: 99, volumes: h.volumes })))).toBe("needs_release");
    expect(power(h)).toBe("starting");
    h.power.transition(key, "starting", "stopped", freeToken(h, key));
    expect(power(h)).toBe("stopped");
  });
  test("a free-volumes token cannot be minted while any volume has an owner or for a workspace with no pair, and a release token needs a sealed proof", async () => {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId);
    const key = { workspaceId: h.workspaceId, incarnationId: running.incarnationId, leaseEpoch: running.leaseEpoch }, volumes = h.volumes.records(h.workspaceId);
    expect(() => mintVolumesFreeToken({ ...key, volumes: h.volumes })).toThrow(CoworkNativeStopEvidenceError);
    // It reads the records itself: a caller cannot hand over records it made up, and a workspace with no volume pair has nothing to be free.
    expect(() => mintVolumesFreeToken({ ...key, workspaceId: "workspace-none", volumes: h.volumes })).toThrow(CoworkNativeStopEvidenceError);
    expect(() => mintVolumesFreeToken({ ...key, volumes: { records: () => volumes.map(v => ({ ...v, owner: null })) } })).not.toThrow(); // the reader is the only source of truth it has
    expect(() => mintVolumesFreeToken({ ...key, volumes: { records: () => [] } })).toThrow(CoworkNativeStopEvidenceError);
    expect(() => mintReleaseToken({ proof: {} as never, volumes: h.volumes })).toThrow(CoworkNativeStopEvidenceError);
    const proof = mintOrderlyStopProof({ receipt: h.launcher.last.stagedOrderly("ab".repeat(16)), owner: running.owner, homeId: h.homeId, admission: { admissionId: running.admissionId, owner: { bootId: "boot-one" } }, volumes, source: { kind: "live", stopNonce: "ab".repeat(16), launcherInstanceId: h.launcher.last.launcherInstanceId, observed: { volumesAccepted: true, vmRunning: true, guestHello: true } }, registry: h.registry, now: () => 1 });
    expect(() => mintReleaseToken({ proof, volumes: h.volumes })).toThrow(CoworkNativeStopEvidenceError); // volumes still owned
    expect(power(h)).toBe("running");
  });
  test("an archived workspace cannot be moved", () => {
    const h = createHarness(), key = started(h);
    h.db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [h.workspaceId]);
    expect(code(() => h.power.transition(key, "starting", "running"))).toBe("stale");
    expect(code(() => h.power.markUncertain(key))).toBe("stale");
  });
  test("the write touches only `power` (and the timestamp): incarnation, epoch and revisions are untouched", () => {
    const h = createHarness(), key = started(h), before = h.records.get(h.workspaceId);
    h.power.transition(key, "starting", "running");
    const after = h.records.get(h.workspaceId);
    expect({ ...after, power: before.power, updatedAt: before.updatedAt }).toEqual(before);
  });
  test("markUncertain: from starting, running or draining; idempotent; refuses stopped and a stale key", () => {
    const h = createHarness(), key = started(h);
    expect(h.power.markUncertain(key)).toBe(true); expect(power(h)).toBe("uncertain");
    expect(h.power.markUncertain(key)).toBe(false);
    for (const from of ["running", "draining"] as const) { set(h, from); expect(h.power.markUncertain(key)).toBe(true); expect(power(h)).toBe("uncertain"); }
    expect(code(() => h.power.markUncertain({ ...key, leaseEpoch: 5 }))).toBe("stale");
    expect(code(() => h.power.markUncertain({ ...key, incarnationId: "inc-else" }))).toBe("stale");
    set(h, "stopped");
    expect(code(() => h.power.markUncertain(key))).toBe("illegal");
  });
  test("an unknown workspace is not_found, and writes refuse to join a caller's transaction", () => {
    const h = createHarness(), key = started(h);
    expect(code(() => h.power.read("workspace-none"))).toBe("not_found");
    expect(() => h.db.transaction(() => h.power.transition(key, "starting", "running"))).toThrow(CoworkError);
    expect(power(h)).toBe("starting");
  });
});
