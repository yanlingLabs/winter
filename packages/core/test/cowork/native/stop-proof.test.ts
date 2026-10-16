import { afterEach, describe, expect, test } from "bun:test";
import type { StopReceipt as LedgerStopReceipt } from "../../../src/cowork/admission";
import type { CoworkNativeOrderlyReceipt } from "../../../src/cowork/native/protocol";
import {
  COWORK_NATIVE_RELEASE_POLICY, CoworkNativeStopEvidenceError, CoworkNativeStopRegistry, coworkNativeLedgerStopProbe, isStopProof, ledgerStopReceipt, mintControllerInstanceId, mintNewBootStopProof, mintOrderlyStopProof, mintOwnerRecoverStopProof,
  ownerBootId, ownerKey, releasesOwnership, stopProofState, type CoworkNativeStopProof,
} from "../../../src/cowork/native/stop-proof";
import type { CoworkVolumeOwner, CoworkVolumeRecord } from "../../../src/cowork/volumes";
import { cleanupHarnesses, createHarness, type Harness } from "./harness";

afterEach(() => { cleanupHarnesses(); });
const code = (body: () => unknown): string => { try { body(); } catch (error) { expect(error).toBeInstanceOf(CoworkNativeStopEvidenceError); return (error as CoworkNativeStopEvidenceError).code; } return "accepted"; };
const NONCE = "ab".repeat(16);

async function running(): Promise<{ h: Harness; owner: CoworkVolumeOwner; volumes: CoworkVolumeRecord[]; admissionId: string; receipt: CoworkNativeOrderlyReceipt }> {
  const h = createHarness(), handle = await h.host.start(h.workspaceId);
  return { h, owner: handle.owner, volumes: h.volumes.records(h.workspaceId), admissionId: handle.admissionId, receipt: h.launcher.last.stagedOrderly(NONCE) };
}
const mint = (c: Awaited<ReturnType<typeof running>>, over: Partial<CoworkNativeOrderlyReceipt> = {}, extra: Partial<Parameters<typeof mintOrderlyStopProof>[0]> = {}) =>
  mintOrderlyStopProof({ receipt: { ...c.receipt, ...over } as CoworkNativeOrderlyReceipt, owner: c.owner, homeId: c.h.homeId, admissionId: c.admissionId, volumes: c.volumes, source: { kind: "live", stopNonce: NONCE }, registry: c.h.registry, now: () => 7, ...extra });

describe("D1: the release policy is one table", () => {
  test("exactly three kinds release; everything else is written down as NOT evidence", () => {
    expect([...COWORK_NATIVE_RELEASE_POLICY.releasing]).toEqual(["orderly-receipt", "new-boot", "owner-recover"]);
    expect([...COWORK_NATIVE_RELEASE_POLICY.neverReleasing]).toEqual(["class-b-receipt", "process-absence", "channel-eof", "descriptor-closed", "launcher-exit", "worker-exit-status", "released-admission", "stale-heartbeat"]);
    expect(Object.isFrozen(COWORK_NATIVE_RELEASE_POLICY) && Object.isFrozen(COWORK_NATIVE_RELEASE_POLICY.releasing) && Object.isFrozen(COWORK_NATIVE_RELEASE_POLICY.neverReleasing)).toBe(true);
    for (const kind of COWORK_NATIVE_RELEASE_POLICY.releasing) expect(releasesOwnership(kind)).toBe(true);
    for (const kind of COWORK_NATIVE_RELEASE_POLICY.neverReleasing) expect(releasesOwnership(kind)).toBe(false);
    expect(releasesOwnership("anything-else")).toBe(false);
  });
  test("the owner tuple carries the boot it was born in, bounded and parseable", () => {
    const id = mintControllerInstanceId("0B0B0B0B-0B0B-4B0B-8B0B-0B0B0B0B0B0B", "a1b2c3d4");
    expect(id).toBe("ctl-0B0B0B0B-0B0B-4B0B-8B0B-0B0B0B0B0B0B-a1b2c3d4"); expect(id.length).toBeLessThanOrEqual(63);
    const owner = { controllerInstanceId: id, workerInstanceId: "w", incarnationId: "i", leaseEpoch: 1, runtimeImageDigest: "a".repeat(64) };
    expect(ownerBootId(owner)).toBe("0B0B0B0B-0B0B-4B0B-8B0B-0B0B0B0B0B0B");
    for (const bad of ["", "ctl-x", "ctl--a1b2c3d4", "ctl-boot-A1B2C3D4", "ctl-boot-a1b2c3d", "xyz-boot-a1b2c3d4"]) expect(ownerBootId({ ...owner, controllerInstanceId: bad })).toBeNull();
    expect(code(() => mintControllerInstanceId("has space", "a1b2c3d4"))).toBe("invalid");
    expect(code(() => mintControllerInstanceId("b".repeat(41), "a1b2c3d4"))).toBe("invalid");
    expect(code(() => mintControllerInstanceId("boot", "XYZ"))).toBe("invalid");
  });
});

describe("a Class A receipt becomes a release proof only if every binding holds", () => {
  test("the honest receipt mints a sealed, frozen proof", async () => {
    const c = await running(), proof = mint(c);
    expect(isStopProof(proof)).toBe(true); expect(Object.isFrozen(proof)).toBe(true);
    expect(proof).toMatchObject({ kind: "orderly-receipt", workspaceId: c.h.workspaceId });
    const state = stopProofState(proof)!;
    expect(state.owner).toEqual(c.owner); expect(state.consumed).toBe(false); expect(state.issuedAtMs).toBe(7);
  });
  test("each broken binding is refused with its code", async () => {
    const c = await running();
    const cases: [string, Partial<CoworkNativeOrderlyReceipt>, string][] = [
      ["workspace", { workspaceId: "workspace-other" }, "wrong_binding"], ["incarnation", { incarnationId: "inc-x" }, "wrong_binding"], ["epoch", { leaseEpoch: c.owner.leaseEpoch + 1 }, "wrong_binding"],
      ["controller", { controllerInstanceId: "ctl-boot-one-00000000" }, "wrong_binding"], ["worker", { workerInstanceId: "wrk-x" }, "wrong_binding"], ["digest", { runtimeImageDigest: "e".repeat(64) }, "wrong_binding"],
      ["home", { homeId: "home-x" }, "wrong_binding"], ["boot", { hostBootId: "boot-two" }, "wrong_binding"], ["admission", { admissionId: "adm-x" }, "wrong_binding"],
      ["nonce", { stopNonce: "ee".repeat(16) }, "nonce_mismatch"], ["origin", { origin: "owner-loss-drain" }, "nonce_mismatch"],
      ["acked-without-power-off", { guest: { drain: "acked", powerOff: "not-booted" } }, "not_orderly"], ["flush gap", { volumes: [{ ...c.receipt.volumes[0], flushCompleted: 1 }, c.receipt.volumes[1]] } as never, "not_orderly"],
    ];
    for (const [name, over, expected] of cases) expect(`${name}:${code(() => mint(c, over))}`).toBe(`${name}:${expected}`);
    const file = (i: number, over: object) => ({ volumes: [i === 0 ? { ...c.receipt.volumes[0], ...over } : c.receipt.volumes[0], i === 1 ? { ...c.receipt.volumes[1], ...over } : c.receipt.volumes[1]] }) as never;
    for (const [name, over] of [["inode", { inode: "1" }], ["device", { device: "1" }], ["capacity", { capacityBytes: 33554432 }]] as const) for (const i of [0, 1]) expect(`${name}${i}:${code(() => mint(c, file(i, over)))}`).toBe(`${name}${i}:wrong_binding`);
    expect(code(() => mint(c, { volumes: [c.receipt.volumes[1], c.receipt.volumes[0]] } as never))).toBe("wrong_binding"); // swapped purposes
  });
  test("an owner tuple whose boot cannot be read, and volumes that are not exactly this owner's pair, refuse", async () => {
    const c = await running();
    expect(code(() => mint(c, {}, { owner: { ...c.owner, controllerInstanceId: "ctl-unparsable" } }))).toBe("boot_unknown");
    expect(code(() => mint(c, {}, { volumes: [c.volumes[0]!] }))).toBe("wrong_binding");
    expect(code(() => mint(c, {}, { volumes: [c.volumes[0]!, { ...c.volumes[1]!, owner: { ...c.owner, workerInstanceId: "wrk-x" } }] }))).toBe("wrong_binding");
    expect(code(() => mint(c, {}, { volumes: [c.volumes[0]!, { ...c.volumes[1]!, owner: null }] }))).toBe("wrong_binding");
    // ...unless the volumes are already released and only the admission and power remain
    const free = c.volumes.map(v => ({ ...v, owner: null }));
    expect(isStopProof(mint(c, {}, { volumes: free, volumesReleased: true }))).toBe(true);
    expect(code(() => mint(c, {}, { volumes: c.volumes, volumesReleased: true }))).toBe("wrong_binding");
  });
  test("a retained receipt skips only the nonce comparison: every other binding stays", async () => {
    const c = await running();
    expect(isStopProof(mint(c, { stopNonce: "ee".repeat(16), origin: "owner-loss-drain" }, { source: { kind: "retained" } }))).toBe(true);
    expect(code(() => mint(c, { workerInstanceId: "wrk-x" }, { source: { kind: "retained" } }))).toBe("wrong_binding");
  });
  test("a Class B receipt has no path to a proof at all", async () => {
    const c = await running(), b = c.h.launcher.last.stagedUncertain("daemon-lost");
    expect(code(() => mintOrderlyStopProof({ receipt: b as never, owner: c.owner, homeId: c.h.homeId, admissionId: c.admissionId, volumes: c.volumes, source: { kind: "retained" }, registry: c.h.registry, now: () => 1 }))).toBe("not_orderly");
    expect(code(() => mintOrderlyStopProof({ receipt: { ...c.receipt, class: "B" } as never, owner: c.owner, homeId: c.h.homeId, admissionId: c.admissionId, volumes: c.volumes, source: { kind: "retained" }, registry: c.h.registry, now: () => 1 }))).toBe("not_orderly");
    expect(code(() => mintOrderlyStopProof({ receipt: null as never, owner: c.owner, homeId: c.h.homeId, admissionId: c.admissionId, volumes: c.volumes, source: { kind: "retained" }, registry: c.h.registry, now: () => 1 }))).toBe("not_orderly");
  });
  test("a spent receipt (by id or by nonce) can never mint again", async () => {
    const c = await running(), proof = mint(c);
    c.h.registry.consume(proof);
    expect(code(() => mint(c))).toBe("replayed");
    expect(code(() => mint(c, { confirmationId: "confirm-fresh-id" }))).toBe("replayed"); // same nonce
    expect(code(() => mint(c, { stopNonce: "dd".repeat(16) }, { source: { kind: "retained" } }))).toBe("replayed"); // the id alone is enough
    expect(isStopProof(mint(c, { stopNonce: "dd".repeat(16), confirmationId: "confirm-fresh-id" }, { source: { kind: "retained" } }))).toBe(true); // a genuinely new receipt is not blocked
  });
  test("sealing: only the module's own object is a proof", async () => {
    const c = await running(), proof = mint(c);
    for (const forged of [{ ...proof }, JSON.parse(JSON.stringify(proof)), Object.create(proof), structuredClone(proof), new Proxy(proof, {}), Object.freeze({ kind: proof.kind, confirmationId: proof.confirmationId, workspaceId: proof.workspaceId })]) {
      expect(isStopProof(forged)).toBe(false); expect(stopProofState(forged)).toBeUndefined();
      expect(() => c.h.registry.consume(forged as CoworkNativeStopProof)).toThrow(CoworkNativeStopEvidenceError);
    }
    expect(isStopProof(null) || isStopProof(1) || isStopProof("x")).toBe(false);
  });
});

describe("boot evidence", () => {
  const owner = (boot: string): CoworkVolumeOwner => ({ controllerInstanceId: mintControllerInstanceId(boot, "a1b2c3d4"), workerInstanceId: "w", incarnationId: "i", leaseEpoch: 1, runtimeImageDigest: "a".repeat(64) });
  const boot = (current: string, ended: boolean | "throws") => ({ bootId: () => current, confirmsPreviousBootEnded: () => { if (ended === "throws") throw new Error("unanswerable"); return ended; } });
  test("a different boot that the host confirms ended is evidence; the same boot, an unconfirmed one, an unanswerable probe and an unparsable tuple are not", () => {
    const ok = mintNewBootStopProof({ owner: owner("old"), workspaceId: "w", hostBoot: boot("new", true), now: () => 3 });
    expect(ok.kind).toBe("new-boot"); expect(ok.confirmationId).toMatch(/^boot-[a-f0-9]{24}$/);
    expect(code(() => mintNewBootStopProof({ owner: owner("same"), workspaceId: "w", hostBoot: boot("same", true), now: () => 3 }))).toBe("boot_not_ended");
    expect(code(() => mintNewBootStopProof({ owner: owner("old"), workspaceId: "w", hostBoot: boot("new", false), now: () => 3 }))).toBe("boot_not_ended");
    expect(code(() => mintNewBootStopProof({ owner: owner("old"), workspaceId: "w", hostBoot: boot("new", "throws"), now: () => 3 }))).toBe("boot_not_ended");
    expect(code(() => mintNewBootStopProof({ owner: { ...owner("old"), controllerInstanceId: "ctl-nope" }, workspaceId: "w", hostBoot: boot("new", true), now: () => 3 }))).toBe("boot_unknown");
  });
});

describe("explicit owner recovery", () => {
  const subject = { workspaceId: "w", incarnationId: "inc-1", leaseEpoch: 1, owner: null };
  const attestation = { kind: "owner-recover", workspaceId: "w", incarnationId: "inc-1", leaseEpoch: 1, attestedBy: "owner" } as const;
  const guards = (absent: unknown, unlocked: unknown) => ({ processAbsent: () => absent as boolean, imagesUnlocked: () => unlocked as boolean });
  test("needs the attestation naming this incarnation AND both guards answering exactly true", () => {
    const base = { subject, attestation, guards: guards(true, true), volumes: [], now: () => 1 };
    expect(mintOwnerRecoverStopProof(base).kind).toBe("owner-recover");
    const refused = (over: object) => code(() => mintOwnerRecoverStopProof({ ...base, ...over }));
    expect(refused({ attestation: null })).toBe("recover_refused");
    for (const wrong of [{ workspaceId: "x" }, { incarnationId: "inc-2" }, { leaseEpoch: 2 }, { attestedBy: "launcher" }, { kind: "new-boot" }]) expect(refused({ attestation: { ...attestation, ...wrong } })).toBe("recover_refused");
    expect(refused({ guards: guards(false, true) })).toBe("recover_refused");
    expect(refused({ guards: guards(true, false) })).toBe("recover_refused");
    expect(refused({ guards: guards("yes", true) })).toBe("recover_refused");
    expect(refused({ guards: { processAbsent: () => { throw new Error("cannot answer"); }, imagesUnlocked: () => true } })).toBe("recover_refused");
  });
});

describe("the admission ledger bridge", () => {
  test("a ledger receipt exists only for a sealed proof and a matching record, and only such a receipt passes the probe", async () => {
    const c = await running(), proof = mint(c), record = c.h.ledger.get(c.admissionId);
    const receipt = ledgerStopReceipt(proof, record, c.h.homeId);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt).toMatchObject({ confirmationId: proof.confirmationId, admissionId: c.admissionId, workspaceId: c.h.workspaceId, incarnationId: c.owner.incarnationId, leaseEpoch: c.owner.leaseEpoch, homeId: c.h.homeId, confirmedAt: 7 });
    expect(coworkNativeLedgerStopProbe(receipt, record)).toBe(true);
    // a hand-built receipt with every field right is still not ours
    expect(coworkNativeLedgerStopProbe({ ...receipt } as LedgerStopReceipt, record)).toBe(false);
    expect(coworkNativeLedgerStopProbe(JSON.parse(JSON.stringify(receipt)), record)).toBe(false);
    expect(coworkNativeLedgerStopProbe(null as never, record)).toBe(false);
    expect(coworkNativeLedgerStopProbe(receipt, { ...record, admissionId: "adm-other" })).toBe(false);
    expect(code(() => ledgerStopReceipt({ ...proof } as CoworkNativeStopProof, record, c.h.homeId))).toBe("invalid");
    expect(code(() => ledgerStopReceipt(proof, { ...record, leaseEpoch: 9 }, c.h.homeId))).toBe("wrong_binding");
    expect(code(() => ledgerStopReceipt(proof, { ...record, workspaceId: "workspace-x" }, c.h.homeId))).toBe("wrong_binding");
    expect(code(() => ledgerStopReceipt(proof, record, "home-x"))).toBe("wrong_binding");
    c.h.registry.consume(proof);
    expect(coworkNativeLedgerStopProbe(receipt, record)).toBe(false); // spent
  });
});

describe("the registry", () => {
  test("remembers spent ids and nonces and the owners it knows stopped, and nothing else", async () => {
    const c = await running(), registry = new CoworkNativeStopRegistry(), proof = mint(c, {}, { registry });
    expect(registry.wasSpent(proof.confirmationId, NONCE)).toBe(false); expect(registry.isOwnerStopped(c.owner)).toBe(false);
    registry.consume(proof);
    expect(registry.wasSpent(proof.confirmationId, null)).toBe(true); expect(registry.wasSpent("other", NONCE)).toBe(true); expect(registry.wasSpent("other", "ff".repeat(16))).toBe(false);
    expect(registry.isOwnerStopped(c.owner)).toBe(true);
    expect(registry.isOwnerStopped({ ...c.owner, leaseEpoch: c.owner.leaseEpoch + 1 })).toBe(false);
    registry.noteStopped({ ...c.owner, workerInstanceId: "wrk-n" }, "new-boot");
    expect(registry.isOwnerStopped({ ...c.owner, workerInstanceId: "wrk-n" })).toBe(true);
    expect(ownerKey(c.owner)).not.toBe(ownerKey({ ...c.owner, workerInstanceId: "wrk-n" }));
  });
});
