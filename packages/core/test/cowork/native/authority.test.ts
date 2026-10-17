import { afterEach, describe, expect, test } from "bun:test";
import { CoworkNativeAuthority, CoworkNativeAuthorityError, CoworkNativeChannelBinding, type CoworkNativeLink } from "../../../src/cowork/native/authority";
import { sortedCanonical } from "../../../src/cowork/native/protocol";
import { mintControllerInstanceId, mintOrderlyStopProof, type CoworkNativeOwnerRecoverAttestation } from "../../../src/cowork/native/stop-proof";
import type { CoworkVolumeOwner, CoworkVolumeRequest } from "../../../src/cowork/volumes";
import { matchesFilesystemReceipt, type VolumeFilesystemPlan, type VolumeFilesystemReceipt } from "../../../src/cowork/volume-filesystem";
import { receiptFor } from "./fake-launcher";
import { cleanupHarnesses, createHarness, IMAGE_DIGEST, type Harness } from "./harness";

afterEach(() => { cleanupHarnesses(); });
void (null as unknown as CoworkNativeOwnerRecoverAttestation);

function begin(h: Harness, label = "auth") {
  const ws = h.records.get(h.workspaceId), incarnationId = `inc-${label}`;
  const epoch = h.records.beginIncarnation(h.workspaceId, incarnationId, ws.configRevision);
  const owner: CoworkVolumeOwner = { controllerInstanceId: mintControllerInstanceId("boot-one", "0000000a"), workerInstanceId: `wrk-${label}`, incarnationId, leaseEpoch: epoch.leaseEpoch, runtimeImageDigest: IMAGE_DIGEST };
  const link = { live: true, isLive() { return this.live; } };
  const binding = h.authority.adopt(link, { workspaceId: h.workspaceId, homeId: h.homeId, admissionId: `adm-${label}`, owner });
  return { owner, link, binding, request: (): CoworkVolumeRequest => ({ workspaceId: h.workspaceId, owner, proof: binding.volumeProof() }) };
}
const refusal = (body: () => unknown, code: string) => { try { body(); } catch (error) { expect(error).toBeInstanceOf(CoworkNativeAuthorityError); expect(String((error as CoworkNativeAuthorityError).code)).toBe(code); return; } throw new Error("expected a refusal"); };

describe("adoption: a binding exists only for the live launcher of the current incarnation", () => {
  test("a dead link, a wrong home, a stale incarnation or epoch and a second live binding are all refused", () => {
    const h = createHarness();
    const ws = h.records.get(h.workspaceId);
    const owner = (label: string, epoch: number): CoworkVolumeOwner => ({ controllerInstanceId: mintControllerInstanceId("boot-one", "0000000b"), workerInstanceId: `wrk-${label}`, incarnationId: `inc-${label}`, leaseEpoch: epoch, runtimeImageDigest: IMAGE_DIGEST });
    // power is still `stopped`: nothing may be bound to a workspace that has no incarnation starting
    refusal(() => h.authority.adopt({ isLive: () => true }, { workspaceId: h.workspaceId, homeId: h.homeId, admissionId: "adm-x", owner: owner("x", 1) }), "stale_incarnation");
    h.records.beginIncarnation(h.workspaceId, "inc-live", ws.configRevision);
    const scope = { workspaceId: h.workspaceId, homeId: h.homeId, admissionId: "adm-live", owner: owner("live", 1) };
    refusal(() => h.authority.adopt({ isLive: () => false }, scope), "link_not_live");
    refusal(() => h.authority.adopt({ isLive: () => { throw new Error("hostile"); } }, scope), "link_not_live");
    refusal(() => h.authority.adopt(null as unknown as CoworkNativeLink, scope), "link_not_live");
    refusal(() => h.authority.adopt({ isLive: () => true }, { ...scope, homeId: "home-elsewhere" }), "invalid");
    refusal(() => h.authority.adopt({ isLive: () => true }, { ...scope, owner: { ...scope.owner, incarnationId: "inc-other" } }), "stale_incarnation");
    refusal(() => h.authority.adopt({ isLive: () => true }, { ...scope, owner: { ...scope.owner, leaseEpoch: 2 } }), "stale_incarnation");
    for (const power of ["running", "draining", "uncertain", "stopped"]) { // adoption is for a launch that is STARTING, nothing else
      h.db.db.run("UPDATE cowork_workspaces SET power=? WHERE workspace_id=?", [power, h.workspaceId]);
      refusal(() => h.authority.adopt({ isLive: () => true }, scope), "stale_incarnation");
    }
    h.db.db.run("UPDATE cowork_workspaces SET power='starting' WHERE workspace_id=?", [h.workspaceId]);
    const link = { live: true, isLive() { return this.live; } };
    const first = h.authority.adopt(link, scope);
    refusal(() => h.authority.adopt({ isLive: () => true }, scope), "already_bound");
    link.live = false;
    expect(first.isLive()).toBe(false);
    expect(h.authority.bindingFor(h.workspaceId)).toBeUndefined();
    expect(h.authority.adopt({ isLive: () => true }, scope).isLive()).toBe(true); // a dead binding is replaced
  });
  test("the binding constructor is closed to everyone but the authority", () => {
    const h = createHarness();
    expect(() => new CoworkNativeChannelBinding(Symbol("forged"), { isLive: () => true }, { workspaceId: "w", homeId: "h", admissionId: "a", owner: {} as CoworkVolumeOwner }, h.authority, () => "")).toThrow("invalid");
  });
  test("phases move one step forward, and only while the channel lives", () => {
    const h = createHarness(), { binding, link } = begin(h);
    expect(binding.phase).toBe("adopted");
    refusal(() => binding.advance("attached"), "wrong_phase");
    refusal(() => binding.advance("adopted"), "wrong_phase");
    binding.advance("begun"); binding.advance("attached");
    refusal(() => binding.advance("attached"), "wrong_phase");
    link.live = false;
    refusal(() => binding.advance("ready"), "not_live");
    refusal(() => binding.volumeProof(), "not_live");
  });
});

describe("volume authority", () => {
  test("allocate is refused outright, even for a live binding's own proof", () => {
    const h = createHarness(), { request } = begin(h), { binding } = { binding: h.authority.bindingFor(h.workspaceId)! };
    binding.advance("begun");
    expect(h.authority.volumes.authorize("allocate", request(), h.homeId)).toBe(false);
  });
  test("claim needs a begun worker and the starting power; open needs the same binding in any later phase", () => {
    const h = createHarness(), ctx = begin(h), request = ctx.request();
    expect(h.authority.volumes.authorize("claim", request, h.homeId)).toBe(false); // adopted, not begun
    ctx.binding.advance("begun");
    expect(h.authority.volumes.authorize("claim", request, h.homeId)).toBe(true);
    expect(h.authority.volumes.authorize("open", request, h.homeId)).toBe(true);
    ctx.binding.advance("attached");
    expect(h.authority.volumes.authorize("claim", request, h.homeId)).toBe(false);
    expect(h.authority.volumes.authorize("open", request, h.homeId)).toBe(true);
    h.db.db.run("UPDATE cowork_workspaces SET power='draining' WHERE workspace_id=?", [h.workspaceId]);
    expect(h.authority.volumes.authorize("open", request, h.homeId)).toBe(false);
    h.db.db.run("UPDATE cowork_workspaces SET power='running' WHERE workspace_id=?", [h.workspaceId]);
    expect(h.authority.volumes.authorize("open", request, h.homeId)).toBe(true);
    expect(h.authority.volumes.authorize("claim", request, h.homeId)).toBe(false);
  });
  test("forged proofs authorise nothing: JSON, spread, prototype, clone, proxy, another authority's, a primitive", () => {
    const h = createHarness(), ctx = begin(h); ctx.binding.advance("begun");
    const real = ctx.request(), other = createHarness();
    const foreign = begin(other); foreign.binding.advance("begun");
    const forged: unknown[] = [undefined, null, 0, "proof", {}, JSON.parse(JSON.stringify(real.proof)), { ...(real.proof as object) }, Object.create(real.proof as object), structuredClone(real.proof), new Proxy(real.proof as object, {}),
      Object.freeze({ kind: "native-volume-proof", workspaceId: h.workspaceId }), foreign.request().proof];
    for (const proof of forged) for (const action of ["claim", "open"] as const) expect(`${action}:${h.authority.volumes.authorize(action, { ...real, proof }, h.homeId)}`).toBe(`${action}:false`);
    expect(h.authority.volumes.authorize("claim", real, h.homeId)).toBe(true);
    // the same sealed object offered to ANOTHER authority is just as dead: even one over the very same database and registry
    expect(other.authority.volumes.authorize("claim", real, other.homeId)).toBe(false);
    const sibling = new CoworkNativeAuthority({ records: h.records, hostBoot: h.hostBoot, registry: h.registry });
    expect(sibling.volumes.authorize("claim", real, h.homeId)).toBe(false);
    expect(h.authority.volumes.authorize("claim", real, h.homeId)).toBe(true);
  });
  test("a closed binding, a closed link and a drifted request all fail", () => {
    const h = createHarness(), ctx = begin(h); ctx.binding.advance("begun");
    const real = ctx.request();
    const drift: [string, CoworkVolumeRequest, string][] = [
      ["workspace", { ...real, workspaceId: "workspace-other" }, h.homeId],
      ["home", real, "home-other"],
      ["controller", { ...real, owner: { ...real.owner, controllerInstanceId: "ctl-boot-one-0000000c" } }, h.homeId],
      ["worker", { ...real, owner: { ...real.owner, workerInstanceId: "wrk-else" } }, h.homeId],
      ["incarnation", { ...real, owner: { ...real.owner, incarnationId: "inc-else" } }, h.homeId],
      ["epoch+1", { ...real, owner: { ...real.owner, leaseEpoch: real.owner.leaseEpoch + 1 } }, h.homeId],
      ["epoch-1", { ...real, owner: { ...real.owner, leaseEpoch: 0 } }, h.homeId],
      ["digest", { ...real, owner: { ...real.owner, runtimeImageDigest: "e".repeat(64) } }, h.homeId],
    ];
    for (const [name, request, home] of drift) expect(`${name}:${h.authority.volumes.authorize("claim", request, home)}`).toBe(`${name}:false`);
    ctx.link.live = false;
    expect(h.authority.volumes.authorize("claim", real, h.homeId)).toBe(false);
    ctx.link.live = true;
    expect(h.authority.volumes.authorize("claim", real, h.homeId)).toBe(true);
    ctx.binding.close();
    expect(h.authority.volumes.authorize("claim", real, h.homeId)).toBe(false);
  });
  test("a superseded owner authorises nothing: the database must still name this incarnation and epoch", () => {
    const h = createHarness(), ctx = begin(h); ctx.binding.advance("begun");
    const real = ctx.request();
    h.db.db.run("UPDATE cowork_workspaces SET lease_epoch=lease_epoch+1 WHERE workspace_id=?", [h.workspaceId]);
    expect(h.authority.volumes.authorize("claim", real, h.homeId)).toBe(false);
    h.db.db.run("UPDATE cowork_workspaces SET lease_epoch=lease_epoch-1,incarnation_id='inc-newer' WHERE workspace_id=?", [h.workspaceId]);
    expect(h.authority.volumes.authorize("claim", real, h.homeId)).toBe(false);
    h.db.db.run("UPDATE cowork_workspaces SET incarnation_id=?,state='archived' WHERE workspace_id=?", [real.owner.incarnationId, h.workspaceId]);
    expect(h.authority.volumes.authorize("claim", real, h.homeId)).toBe(false);
  });
});

describe("release goes through sealed stop evidence only", () => {
  async function stopped(): Promise<{ h: Harness; request: CoworkVolumeRequest; proof: ReturnType<typeof mintOrderlyStopProof>; owner: CoworkVolumeOwner }> {
    const h = createHarness();
    const running = await h.host.start(h.workspaceId);
    const session = h.launcher.last, volumes = h.volumes.records(h.workspaceId);
    const receipt = session.stagedOrderly("ab".repeat(16));
    const proof = mintOrderlyStopProof({ receipt, owner: running.owner, homeId: h.homeId, admission: { admissionId: running.admissionId, owner: { bootId: "boot-one" } }, volumes, source: { kind: "live", stopNonce: "ab".repeat(16), launcherInstanceId: session.launcherInstanceId, observed: { volumesAccepted: true, vmRunning: true, guestHello: true } }, registry: h.registry, now: () => 1 });
    return { h, request: { workspaceId: h.workspaceId, owner: running.owner, proof }, proof, owner: running.owner };
  }
  test("only the sealed proof releases; every copy, clone and mismatch is refused, and release is allowed without a live binding", async () => {
    const { h, request, proof, owner } = await stopped();
    h.launcher.last.eof(); // the link is gone: release still works on evidence alone
    h.db.db.run("UPDATE cowork_workspaces SET power='uncertain' WHERE workspace_id=?", [h.workspaceId]);
    const volumes = h.volumes.records(h.workspaceId), stop = { confirmationId: proof.confirmationId, proof };
    expect(h.authority.volumes.authorize("release", request, h.homeId)).toBe(true);
    expect(h.authority.volumes.verifyStopped(request, stop, volumes)).toBe(true);
    for (const forged of [{}, { ...proof }, JSON.parse(JSON.stringify(proof)), Object.create(proof), structuredClone(proof), null, "orderly"]) {
      expect(h.authority.volumes.authorize("release", { ...request, proof: forged }, h.homeId)).toBe(false);
      expect(h.authority.volumes.verifyStopped(request, { confirmationId: proof.confirmationId, proof: forged }, volumes)).toBe(false);
    }
    expect(h.authority.volumes.verifyStopped(request, { confirmationId: "confirm-other", proof }, volumes)).toBe(false);
    expect(h.authority.volumes.verifyStopped({ ...request, owner: { ...owner, leaseEpoch: 9 } }, stop, volumes)).toBe(false);
    expect(h.authority.volumes.verifyStopped({ ...request, workspaceId: "workspace-other" }, stop, volumes)).toBe(false);
    expect(h.authority.volumes.verifyStopped(request, stop, volumes.slice(0, 1))).toBe(false);
    // both volumes must be this owner's, in this workspace: one foreign owner, one other-workspace volume, one free volume each break it
    expect(h.authority.volumes.verifyStopped(request, stop, [volumes[0]!, { ...volumes[1]!, owner: { ...owner, workerInstanceId: "wrk-else" } }])).toBe(false);
    expect(h.authority.volumes.verifyStopped(request, stop, [volumes[0]!, { ...volumes[1]!, workspaceId: "workspace-other" }])).toBe(false);
    expect(h.authority.volumes.verifyStopped(request, stop, [volumes[0]!, { ...volumes[1]!, owner: null }])).toBe(false);
    expect(h.authority.volumes.authorize("release", request, "home-other")).toBe(false);
    // a different current epoch, a different current incarnation, power `stopped`: the evidence is for a state that no longer exists
    h.db.db.run("UPDATE cowork_workspaces SET lease_epoch=lease_epoch+1 WHERE workspace_id=?", [h.workspaceId]);
    expect(h.authority.volumes.authorize("release", request, h.homeId)).toBe(false);
    h.db.db.run("UPDATE cowork_workspaces SET lease_epoch=lease_epoch-1,incarnation_id='inc-newer' WHERE workspace_id=?", [h.workspaceId]);
    expect(h.authority.volumes.authorize("release", request, h.homeId)).toBe(false);
    h.db.db.run("UPDATE cowork_workspaces SET incarnation_id=? WHERE workspace_id=?", [owner.incarnationId, h.workspaceId]);
    expect(h.authority.volumes.authorize("release", request, h.homeId)).toBe(true);
    h.db.db.run("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?", [h.workspaceId]);
    expect(h.authority.volumes.authorize("release", request, h.homeId)).toBe(false);
  });
  test("a spent proof can never release again", async () => {
    const { h, request, proof } = await stopped();
    h.db.db.run("UPDATE cowork_workspaces SET power='uncertain' WHERE workspace_id=?", [h.workspaceId]);
    expect(h.authority.volumes.authorize("release", request, h.homeId)).toBe(true);
    h.registry.consume(proof);
    expect(h.authority.volumes.authorize("release", request, h.homeId)).toBe(false);
    expect(h.authority.volumes.verifyStopped(request, { confirmationId: proof.confirmationId, proof }, h.volumes.records(h.workspaceId))).toBe(false);
  });
  test("an orderly proof is tied to the very files it attests", async () => {
    const { h, request, proof } = await stopped();
    const volumes = h.volumes.records(h.workspaceId);
    expect(h.authority.volumes.verifyStopped(request, { confirmationId: proof.confirmationId, proof }, volumes)).toBe(true);
    const swapped = [{ ...volumes[0]!, identity: { ...volumes[0]!.identity!, inode: "424242" } }, volumes[1]!];
    expect(h.authority.volumes.verifyStopped(request, { confirmationId: proof.confirmationId, proof }, swapped)).toBe(false);
    expect(h.authority.volumes.verifyStopped(request, { confirmationId: proof.confirmationId, proof }, [volumes[1]!, volumes[0]!])).toBe(false);
  });
});

describe("filesystem authority and the bootstrap receipt", () => {
  async function claimed() {
    const h = createHarness(), ctx = begin(h); ctx.binding.advance("begun");
    const request = ctx.request();
    h.volumes.claim(request);
    const plan = h.volumes.prepareFilesystems(request);
    ctx.binding.advance("attached");
    return { h, ctx, request, plan, receipt: receiptFor(sortedCanonical(plan) as Record<string, unknown>) as unknown as VolumeFilesystemReceipt };
  }
  test("authorize needs this binding's volumes and a known check mode; replay is only for a begun or attached worker", async () => {
    const { h, ctx, request, plan } = await claimed();
    const volumes = h.volumes.records(h.workspaceId);
    expect(h.authority.filesystem.authorize(request, h.homeId, volumes, "normal")).toBe(true);
    expect(h.authority.filesystem.authorize(request, h.homeId, volumes, "bogus" as never)).toBe(false);
    expect(h.authority.filesystem.authorize(request, h.homeId, [volumes[0]!], "normal")).toBe(false);
    expect(h.authority.filesystem.authorize(request, h.homeId, [volumes[0]!, { ...volumes[1]!, owner: { ...volumes[1]!.owner!, workerInstanceId: "wrk-else" } }], "normal")).toBe(false);
    expect(h.authority.filesystem.authorize({ ...request, proof: {} }, h.homeId, volumes, "normal")).toBe(false);
    expect(h.authority.filesystem.authorizeJournalReplay!(request, plan, volumes)).toBe(true);
    expect(h.authority.filesystem.authorizeJournalReplay!(request, { ...plan, owner: { ...plan.owner, leaseEpoch: 8 } }, volumes)).toBe(false);
    expect(h.authority.filesystem.authorizeJournalReplay!(request, { ...plan, workspaceId: "workspace-other" }, volumes)).toBe(false);
    ctx.binding.advance("ready");
    expect(h.authority.filesystem.authorizeJournalReplay!(request, plan, volumes)).toBe(false);
  });
  test("the receipt proof is bound to the plan in flight, its nonce and the digest of exactly those bytes", async () => {
    const { h, ctx, request, plan, receipt } = await claimed();
    const { operationId, nonce } = ctx.binding.issuePlan(plan);
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    refusal(() => ctx.binding.issuePlan(plan), "operation_in_flight");
    refusal(() => ctx.binding.acceptReceipt({ operationId: "filesystem_other", nonce, receipt }), "operation_mismatch");
    refusal(() => ctx.binding.acceptReceipt({ operationId, nonce: "ee".repeat(16), receipt }), "nonce_mismatch");
    const proof = ctx.binding.acceptReceipt({ operationId, nonce, receipt });
    refusal(() => ctx.binding.acceptReceipt({ operationId, nonce, receipt }), "replayed");
    expect(h.authority.filesystem.verifyReceipt(request, plan, receipt, proof)).toBe(true);
    // not with a different receipt (even a valid-looking one for the same plan), not with a copy of the proof, not with a plan for another operation
    const tampered = structuredClone(receipt); (tampered.volumes[0] as { filesystemUUID: string }).filesystemUUID = "00000000-0000-4000-8000-000000000000";
    expect(h.authority.filesystem.verifyReceipt(request, plan, tampered, proof)).toBe(false);
    expect(h.authority.filesystem.verifyReceipt(request, plan, { ...receipt, extra: 1 } as never, proof)).toBe(false);
    for (const forged of [{}, { ...proof }, JSON.parse(JSON.stringify(proof)), Object.create(proof), null]) expect(h.authority.filesystem.verifyReceipt(request, plan, receipt, forged)).toBe(false);
    expect(h.authority.filesystem.verifyReceipt(request, { ...plan, operationId: "filesystem_other" } as VolumeFilesystemPlan, receipt, proof)).toBe(false);
    // another receipt that ALSO matches the plan (a transient feature differs) is still not the one this proof was minted for
    const sibling = structuredClone(receipt); (sibling.volumes[0] as { transientFilesystemFeatures: string[] }).transientFilesystemFeatures = ["needs_recovery"];
    expect(matchesFilesystemReceipt(plan, sibling)).toBe(true);
    expect(h.authority.filesystem.verifyReceipt(request, plan, sibling, proof)).toBe(false);
    // spent: the second use is a replay
    ctx.binding.consumeReceipt(proof);
    expect(h.authority.filesystem.verifyReceipt(request, plan, receipt, proof)).toBe(false);
    refusal(() => ctx.binding.acceptReceipt({ operationId, nonce, receipt }), "no_operation");
  });
  test("a receipt proof dies with its link and is useless to another binding", async () => {
    const { h, ctx, request, plan, receipt } = await claimed();
    const { operationId, nonce } = ctx.binding.issuePlan(plan);
    const proof = ctx.binding.acceptReceipt({ operationId, nonce, receipt });
    ctx.link.live = false;
    expect(h.authority.filesystem.verifyReceipt(request, plan, receipt, proof)).toBe(false);
    const other = await claimed();
    expect(other.h.authority.filesystem.verifyReceipt(other.request, other.plan, other.receipt, proof)).toBe(false);
  });
  test("an abandoned exchange can never be answered later, and a new one gets a fresh nonce", async () => {
    const { ctx, plan, receipt } = await claimed();
    const first = ctx.binding.issuePlan(plan);
    ctx.binding.clearPending();
    refusal(() => ctx.binding.acceptReceipt({ operationId: first.operationId, nonce: first.nonce, receipt }), "no_operation");
    expect(ctx.binding.issuePlan(plan).nonce).not.toBe(first.nonce);
  });
  test("the previous replay writer is stopped only for a different owner with known evidence, never for the same owner or an unknown one", async () => {
    const { h, request } = await claimed();
    const foreign: CoworkVolumeOwner = { controllerInstanceId: mintControllerInstanceId("boot-one", "0000000d"), workerInstanceId: "wrk-previous", incarnationId: "inc-previous", leaseEpoch: 1, runtimeImageDigest: IMAGE_DIGEST };
    const debt = { operationId: "filesystem_previous", owner: foreign };
    const check = (value = debt, home = h.homeId) => h.authority.filesystem.verifyPreviousReplayStopped!(request, home, value, h.volumes.records(h.workspaceId));
    expect(check()).toBe(false); // same boot, no evidence
    expect(check({ operationId: "x", owner: request.owner })).toBe(false); // the current owner can never vouch for itself
    h.registry.noteStopped(request.owner, "orderly-receipt"); // ...even if something wrongly recorded it as stopped
    expect(check({ operationId: "x", owner: request.owner })).toBe(false);
    expect(check(debt, "home-other")).toBe(false);
    h.registry.noteStopped(foreign, "orderly-receipt");
    expect(check(debt, "home-other")).toBe(false); // known stopped, but asked about another home
    expect(check()).toBe(true);
    // boot evidence: the tuple's boot is not this one and the host confirms it ended
    const aged: CoworkVolumeOwner = { ...foreign, controllerInstanceId: mintControllerInstanceId("boot-ancient", "0000000e"), incarnationId: "inc-ancient" };
    expect(check({ operationId: "y", owner: aged })).toBe(false);
    h.hostBoot.ended = true;
    expect(check({ operationId: "y", owner: aged })).toBe(true);
    expect(check({ operationId: "z", owner: { ...aged, controllerInstanceId: "ctl-unparsable" } })).toBe(false);
  });
});
