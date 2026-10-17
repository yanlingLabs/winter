import { createHash, randomBytes } from "node:crypto";
import type { CoworkRepository } from "../repository";
import type { CoworkVolumeAuthority, CoworkVolumeOwner, CoworkVolumeRecord, CoworkVolumeRequest, CoworkVolumeStop } from "../volumes";
import { matchesFilesystemReceipt, type CoworkVolumeFilesystemAuthority, type FilesystemCheckMode, type FilesystemReplayDebt, type VolumeFilesystemPlan, type VolumeFilesystemReceipt } from "../volume-filesystem";
import { sortedCanonical } from "./protocol";
import { mintNewBootStopProof, ownerKey, sameOwnerTuple, stopProofState, type CoworkNativeHostBoot, type CoworkNativeStopRegistry } from "./stop-proof";

/*
 * The two authority ports of the volume layer, implemented with SEALED in-process proof objects.
 *
 * Every proof here is a frozen object registered in a module-private WeakMap. A proof is minted only from a LIVE channel binding:
 * the daemon's authenticated link to the launcher it spawned for exactly this workspace, incarnation and lease epoch. JSON,
 * a manifest, a PID, a clone or a copy of a proof is not in the map and authorises nothing. "Live" is checked again on every
 * call: when the link closes, the binding's proofs die with it. Releasing the disks does NOT go through a binding (the link is
 * usually gone by then); it goes through a sealed STOP proof from stop-proof.ts, which carries the evidence itself.
 *
 * SOURCE ONLY and unwired. Nothing here writes the database; `records` is read-only here. `allocate` is REFUSED: provisioning
 * volumes is not on the native launch path and needs its own reviewed authority.
 */

export type CoworkNativeAuthorityFailure = "link_not_live" | "stale_incarnation" | "already_bound" | "invalid" | "wrong_phase" | "operation_in_flight" | "no_operation" | "operation_mismatch" | "nonce_mismatch" | "replayed" | "not_live";
export class CoworkNativeAuthorityError extends Error {
  constructor(readonly code: CoworkNativeAuthorityFailure) { super(code); this.name = "CoworkNativeAuthorityError"; }
}
const refuse = (code: CoworkNativeAuthorityFailure): never => { throw new CoworkNativeAuthorityError(code); };

/** All the authority needs to know about a launcher session: whether the authenticated channel is still alive. The port that
 * spawned and verified the launcher is the only thing that can honestly answer. */
export interface CoworkNativeLink { isLive(): boolean }
export interface CoworkNativeBindingScope { readonly workspaceId: string; readonly homeId: string; readonly admissionId: string; readonly owner: CoworkVolumeOwner }
export type CoworkNativePhase = "adopted" | "begun" | "attached" | "ready";
const PHASES: readonly CoworkNativePhase[] = ["adopted", "begun", "attached", "ready"];

const SECRET = Symbol("cowork-native-binding");
interface VolumeProofState { readonly binding: CoworkNativeChannelBinding; readonly authority: CoworkNativeAuthority }
interface ReceiptProofState { readonly binding: CoworkNativeChannelBinding; readonly operationId: string; readonly nonce: string; readonly digest: string; consumed: boolean }
const volumeProofs = new WeakMap<object, VolumeProofState>();
const receiptProofs = new WeakMap<object, ReceiptProofState>();
export interface CoworkNativeVolumeProof { readonly kind: "native-volume-proof"; readonly workspaceId: string }
export interface CoworkNativeReceiptProof { readonly kind: "native-receipt-proof"; readonly operationId: string }
const digestOf = (receipt: unknown): string => createHash("sha256").update(JSON.stringify(sortedCanonical(receipt))).digest("hex");

/** The live authenticated channel of ONE incarnation. Created only by `CoworkNativeAuthority.adopt`. */
export class CoworkNativeChannelBinding {
  private phaseIndex = 0;
  private closed = false;
  private pending: { operationId: string; nonce: string; received: boolean } | null = null;
  private proof: CoworkNativeVolumeProof | undefined;
  readonly scope: Readonly<CoworkNativeBindingScope>;
  constructor(secret: symbol, private readonly link: CoworkNativeLink, scope: CoworkNativeBindingScope, private readonly authority: CoworkNativeAuthority, private readonly mint: () => string) {
    if (secret !== SECRET) throw new CoworkNativeAuthorityError("invalid");
    this.scope = Object.freeze({ workspaceId: scope.workspaceId, homeId: scope.homeId, admissionId: scope.admissionId, owner: Object.freeze({ ...scope.owner }) });
  }
  get phase(): CoworkNativePhase { return PHASES[this.phaseIndex]!; }
  get owner(): CoworkVolumeOwner { return this.scope.owner; }
  isLive(): boolean {
    if (this.closed) return false;
    try { return this.link.isLive() === true; } catch { return false; }
  }
  /** Phases only move forward, one step at a time, and only while the channel is alive. */
  advance(to: CoworkNativePhase): void {
    if (!this.isLive()) return refuse("not_live");
    if (PHASES.indexOf(to) !== this.phaseIndex + 1) return refuse("wrong_phase");
    this.phaseIndex += 1;
  }
  /** The proof to put in `CoworkVolumeRequest.proof`. Minting needs a live channel; USING it needs one too. */
  volumeProof(): CoworkNativeVolumeProof {
    if (!this.isLive()) return refuse("not_live");
    if (!this.proof) {
      const proof = Object.freeze({ kind: "native-volume-proof" as const, workspaceId: this.scope.workspaceId });
      volumeProofs.set(proof, { binding: this, authority: this.authority });
      this.proof = proof;
    }
    return this.proof;
  }
  /** Start one bootstrap exchange for `plan`. The nonce is fresh, 16 random bytes; one exchange at a time. */
  issuePlan(plan: Readonly<VolumeFilesystemPlan>): { operationId: string; nonce: string } {
    if (!this.isLive()) return refuse("not_live");
    if (this.pending !== null) return refuse("operation_in_flight");
    if (!sameOwnerTuple(plan.owner, this.scope.owner) || plan.workspaceId !== this.scope.workspaceId || plan.homeId !== this.scope.homeId) return refuse("invalid");
    const nonce = this.mint();
    if (!/^[a-f0-9]{32}$/.test(nonce)) return refuse("invalid");
    this.pending = { operationId: plan.operationId, nonce, received: false };
    return { operationId: plan.operationId, nonce };
  }
  /** A guest `receipt` frame arrived. It must answer THE plan in flight, with its nonce, once. The returned proof is bound to the
   * digest of exactly these bytes: it cannot be paired with any other receipt object. */
  acceptReceipt(message: { readonly operationId: string; readonly nonce: string; readonly receipt: unknown }): CoworkNativeReceiptProof {
    if (!this.isLive()) return refuse("not_live");
    const pending = this.pending;
    if (!pending) return refuse("no_operation");
    if (message.operationId !== pending.operationId) return refuse("operation_mismatch");
    if (message.nonce !== pending.nonce) return refuse("nonce_mismatch");
    if (pending.received) return refuse("replayed");
    pending.received = true;
    const proof = Object.freeze({ kind: "native-receipt-proof" as const, operationId: pending.operationId });
    receiptProofs.set(proof, { binding: this, operationId: pending.operationId, nonce: pending.nonce, digest: digestOf(message.receipt), consumed: false });
    return proof;
  }
  /** The confirmation committed: the proof is spent and the exchange is over. */
  consumeReceipt(proof: CoworkNativeReceiptProof): void {
    const state = receiptProofs.get(proof);
    if (!state || state.binding !== this) return refuse("invalid");
    state.consumed = true; this.pending = null;
  }
  /** Abandon the exchange in flight (a guest fault, a timeout). Its nonce can never be accepted again. */
  clearPending(): void { this.pending = null; }
  close(): void { this.closed = true; this.pending = null; }
}

export interface CoworkNativeAuthorityDeps {
  readonly records: Pick<CoworkRepository, "get" | "recordedHomeIdentity">;
  readonly hostBoot: CoworkNativeHostBoot;
  readonly registry: CoworkNativeStopRegistry;
  /** Test seam: a fresh 32 hex character nonce per call. */
  readonly mint?: () => string;
}
const ACTION_POWER: Record<"claim" | "open", readonly string[]> = { claim: ["starting"], open: ["starting", "running"] };
const ACTION_PHASE: Record<"claim" | "open", readonly CoworkNativePhase[]> = { claim: ["begun"], open: ["begun", "attached", "ready"] };

export class CoworkNativeAuthority {
  readonly volumes: CoworkVolumeAuthority;
  readonly filesystem: CoworkVolumeFilesystemAuthority;
  private readonly bindings = new Map<string, CoworkNativeChannelBinding>();
  private readonly mint: () => string;
  constructor(private readonly deps: CoworkNativeAuthorityDeps) {
    this.mint = deps.mint ?? (() => randomBytes(16).toString("hex"));
    // Methods are bound arrow properties so a caller handing them to CoworkVolumes cannot detach the instance.
    this.volumes = Object.freeze({
      authorize: (action: "allocate" | "claim" | "open" | "release", request: CoworkVolumeRequest, homeId: string) => this.authorizeVolume(action, request, homeId),
      verifyStopped: (request: CoworkVolumeRequest, stop: CoworkVolumeStop, volumes: readonly CoworkVolumeRecord[]) => this.verifyStopped(request, stop, volumes),
    });
    this.filesystem = Object.freeze({
      authorize: (request: CoworkVolumeRequest, homeId: string, volumes: readonly CoworkVolumeRecord[], checkMode: FilesystemCheckMode) => this.authorizeFilesystem(request, homeId, volumes, checkMode),
      authorizeJournalReplay: (request: CoworkVolumeRequest, plan: Readonly<VolumeFilesystemPlan>, volumes: readonly CoworkVolumeRecord[]) => this.authorizeReplay(request, plan, volumes),
      verifyPreviousReplayStopped: (request: CoworkVolumeRequest, homeId: string, debt: Readonly<FilesystemReplayDebt>, volumes: readonly CoworkVolumeRecord[]) => this.previousReplayStopped(request, homeId, debt, volumes),
      verifyReceipt: (request: CoworkVolumeRequest, plan: Readonly<VolumeFilesystemPlan>, receipt: Readonly<VolumeFilesystemReceipt>, proof: unknown) => this.verifyReceipt(request, plan, receipt, proof),
    });
  }

  /** Bind the live launcher channel of one incarnation. The workspace must be in `starting` with exactly this incarnation and epoch. */
  adopt(link: CoworkNativeLink, scope: CoworkNativeBindingScope): CoworkNativeChannelBinding {
    try { if (!link || link.isLive() !== true) return refuse("link_not_live"); } catch { return refuse("link_not_live"); }
    if (this.deps.records.recordedHomeIdentity() !== scope.homeId) return refuse("invalid");
    const workspace = this.deps.records.get(scope.workspaceId);
    if (workspace.state !== "retained" || workspace.power !== "starting" || workspace.incarnationId !== scope.owner.incarnationId || workspace.leaseEpoch !== scope.owner.leaseEpoch) return refuse("stale_incarnation");
    const existing = this.bindings.get(scope.workspaceId);
    if (existing?.isLive()) return refuse("already_bound");
    const binding = new CoworkNativeChannelBinding(SECRET, link, scope, this, this.mint);
    this.bindings.set(scope.workspaceId, binding);
    return binding;
  }
  /** The live binding for a workspace, if any. */
  bindingFor(workspaceId: string): CoworkNativeChannelBinding | undefined { const binding = this.bindings.get(workspaceId); return binding?.isLive() ? binding : undefined; }

  // ----------------------------------------------------------------------------------------------- volume authority

  /** The binding a request's proof names, if the proof is ours, its channel is alive and it describes exactly this request. */
  private bound(request: CoworkVolumeRequest, homeId: string, phases: readonly CoworkNativePhase[], power: readonly string[]): CoworkNativeChannelBinding | undefined {
    const state = typeof request?.proof === "object" && request.proof !== null ? volumeProofs.get(request.proof) : undefined;
    if (!state || state.authority !== this) return undefined;
    const binding = state.binding;
    if (this.bindings.get(binding.scope.workspaceId) !== binding || !binding.isLive() || !phases.includes(binding.phase)) return undefined;
    if (request.workspaceId !== binding.scope.workspaceId || homeId !== binding.scope.homeId || !sameOwnerTuple(request.owner, binding.owner)) return undefined;
    // The database must still agree that THIS is the current incarnation and epoch: a superseded owner authorises nothing.
    const workspace = this.deps.records.get(request.workspaceId);
    if (workspace.state !== "retained" || workspace.incarnationId !== binding.owner.incarnationId || workspace.leaseEpoch !== binding.owner.leaseEpoch || !power.includes(workspace.power)) return undefined;
    return binding;
  }
  private authorizeVolume(action: "allocate" | "claim" | "open" | "release", request: CoworkVolumeRequest, homeId: string): boolean {
    try {
      if (action === "allocate") return false;
      if (action === "release") return this.releaseAuthorized(request, homeId);
      return this.bound(request, homeId, ACTION_PHASE[action], ACTION_POWER[action]) !== undefined;
    } catch { return false; }
  }
  /** Release is authorised by the evidence itself: a sealed stop proof for exactly this workspace, owner and home, not yet spent,
   * while the database still names that owner as the current incarnation. */
  private releaseAuthorized(request: CoworkVolumeRequest, homeId: string): boolean {
    const state = stopProofState(request.proof);
    if (!state || state.consumed || state.owner === null || state.workspaceId !== request.workspaceId || !sameOwnerTuple(state.owner, request.owner)) return false;
    if (homeId !== this.deps.records.recordedHomeIdentity()) return false;
    const workspace = this.deps.records.get(request.workspaceId);
    return workspace.state === "retained" && workspace.incarnationId === state.incarnationId && workspace.leaseEpoch === state.leaseEpoch && ["starting", "running", "draining", "uncertain"].includes(workspace.power);
  }
  private verifyStopped(request: CoworkVolumeRequest, stop: CoworkVolumeStop, volumes: readonly CoworkVolumeRecord[]): boolean {
    try {
      const state = stopProofState(stop?.proof);
      if (!state || state.consumed || state.owner === null || stop.confirmationId !== state.confirmationId || state.workspaceId !== request.workspaceId || !sameOwnerTuple(state.owner, request.owner)) return false;
      if (volumes.length !== 2 || volumes.some(volume => volume.workspaceId !== state.workspaceId || !sameOwnerTuple(volume.owner, state.owner))) return false;
      if (state.kind === "orderly-receipt") {
        const attested = state.receipt?.volumes;
        if (!attested) return false;
        // An attached entry names exactly the recorded file; an unattached one names nothing (zeros), so there is nothing to compare.
        return volumes.every((volume, index) => volume.purpose === attested[index]!.purpose && (!attested[index]!.attached || (volume.identity?.device === attested[index]!.device && volume.identity?.inode === attested[index]!.inode && volume.capacityBytes === attested[index]!.capacityBytes)));
      }
      return true;
    } catch { return false; }
  }

  // ----------------------------------------------------------------------------------------------- filesystem authority

  private authorizeFilesystem(request: CoworkVolumeRequest, homeId: string, volumes: readonly CoworkVolumeRecord[], checkMode: FilesystemCheckMode): boolean {
    try {
      if (!["normal", "full-read-only"].includes(checkMode)) return false;
      const binding = this.bound(request, homeId, ACTION_PHASE.open, ACTION_POWER.open);
      return binding !== undefined && volumes.length === 2 && volumes.every(volume => volume.workspaceId === binding.scope.workspaceId && sameOwnerTuple(volume.owner, binding.owner));
    } catch { return false; }
  }
  /** Writable journal replay is permission to change a filesystem. It needs the live channel, a plan for exactly this owner, and
   * a worker that has not yet been told to stop (the begun and attached phases only). */
  private authorizeReplay(request: CoworkVolumeRequest, plan: Readonly<VolumeFilesystemPlan>, volumes: readonly CoworkVolumeRecord[]): boolean {
    try {
      const binding = this.bound(request, plan.homeId, ["begun", "attached"], ["starting"]);
      return binding !== undefined && plan.protocolVersion === 3 && plan.workspaceId === binding.scope.workspaceId && sameOwnerTuple(plan.owner, binding.owner)
        && volumes.length === 2 && volumes.every(volume => sameOwnerTuple(volume.owner, binding.owner));
    } catch { return false; }
  }
  /** The previous replay writer is stopped only if it is a DIFFERENT owner and release evidence for it is known: spent here in
   * this process, or derivable from the boot id inside its owner tuple. PID disappearance, JSON and EOF are not evidence. */
  private previousReplayStopped(request: CoworkVolumeRequest, homeId: string, debt: Readonly<FilesystemReplayDebt>, _volumes: readonly CoworkVolumeRecord[]): boolean {
    try {
      if (homeId !== this.deps.records.recordedHomeIdentity() || sameOwnerTuple(debt.owner, request.owner)) return false;
      if (this.deps.registry.isOwnerStopped(debt.owner)) return true;
      mintNewBootStopProof({ owner: debt.owner, workspaceId: request.workspaceId, hostBoot: this.deps.hostBoot, now: () => 0 });
      return true;
    } catch { return false; }
  }
  private verifyReceipt(request: CoworkVolumeRequest, plan: Readonly<VolumeFilesystemPlan>, receipt: Readonly<VolumeFilesystemReceipt>, proof: unknown): boolean {
    try {
      const state = typeof proof === "object" && proof !== null ? receiptProofs.get(proof) : undefined;
      if (!state || state.consumed || !state.binding.isLive()) return false;
      const binding = this.bound(request, plan.homeId, ["attached", "ready"], ["starting"]);
      if (!binding || binding !== state.binding) return false;
      return plan.operationId === state.operationId && sameOwnerTuple(plan.owner, binding.owner) && digestOf(receipt) === state.digest && matchesFilesystemReceipt(plan, receipt);
    } catch { return false; }
  }
  /** A stable key for diagnostics and tests; the owner tuple is the identity of a binding. */
  static keyOf(owner: CoworkVolumeOwner): string { return ownerKey(owner); }
}
