import { createHash } from "node:crypto";
import type { AdmissionRecord, StopReceipt as LedgerStopReceipt } from "../admission";
import type { CoworkVolumeOwner, CoworkVolumeRecord } from "../volumes";
import { classAInvariantsHold, parseCoworkNativeStopReceipt, serializeCoworkNativeStopReceipt, verifyCoworkNativeOrderlyReceiptMac, type CoworkNativeOrderlyReceipt } from "./protocol";
import type { CoworkNativeReceiptKey } from "./receipt-mac";

/*
 * Stop evidence: what may release the two disks of a workspace, and the sealed objects that carry it.
 *
 * DECISION D1 (conservative default, owner ruling still pending). Ownership is retained after ANY crash. Exactly three kinds of
 * evidence can release it, and `COWORK_NATIVE_RELEASE_POLICY` is the one place that says so:
 *
 *   orderly-receipt  a Class A receipt (protocol.ts) that parses, whose facts are self-consistent and which binds to this exact
 *                    owner, volume pair, home, admission and (for a live stop) the nonce the host issued for it
 *   new-boot         the host boot id embedded in the owner tuple differs from the current one and the host probe confirms that
 *                    previous boot really ended (the admission ledger's own `confirmsPreviousBootEnded` notion)
 *   owner-recover    an explicit owner input behind a port (unwired), plus two guard probes that must also agree
 *
 * Nothing else is evidence: not a vanished PID, not an EOF, not a closed descriptor, not a launcher or worker exit, not a Class B
 * receipt, not an admission record that was released. A different D1 ruling changes this table and the three mint functions, nothing else.
 *
 * Proofs are SEALED: each is a frozen object registered in a module-private WeakMap, so only this module's mint functions can
 * produce one. A JSON clone, a spread, `Object.create(proof)` or a structured clone is not in the map and is rejected. Nothing
 * here parses text; every mint takes already-validated, typed inputs and re-checks every binding itself.
 */

export type CoworkNativeEvidenceKind = "orderly-receipt" | "new-boot" | "owner-recover";
export const COWORK_NATIVE_RELEASE_POLICY = Object.freeze({
  releasing: Object.freeze(["orderly-receipt", "new-boot", "owner-recover"] as const),
  /** Written down so a reviewer (and a test) can see what is deliberately NOT here. */
  neverReleasing: Object.freeze(["class-b-receipt", "process-absence", "channel-eof", "descriptor-closed", "launcher-exit", "worker-exit-status", "released-admission", "stale-heartbeat"] as const),
});
export const releasesOwnership = (kind: string): boolean => (COWORK_NATIVE_RELEASE_POLICY.releasing as readonly string[]).includes(kind);

export type StopEvidenceFailure = "not_orderly" | "wrong_binding" | "nonce_mismatch" | "replayed" | "boot_unknown" | "boot_not_ended" | "recover_refused" | "guard_failed" | "mac_invalid" | "invalid";
export class CoworkNativeStopEvidenceError extends Error {
  constructor(readonly code: StopEvidenceFailure) { super(code); this.name = "CoworkNativeStopEvidenceError"; }
}
const refuse = (code: StopEvidenceFailure): never => { throw new CoworkNativeStopEvidenceError(code); };

/** The host's view of its own boot. `confirmsPreviousBootEnded` is the same probe the admission ledger uses. */
export interface CoworkNativeHostBoot {
  bootId(): string;
  confirmsPreviousBootEnded(previousBootId: string): boolean;
}
/** The owner's explicit input. It names the workspace and the incarnation, not an owner tuple: a person can read those from the
 * UI, and the host reads the tuple (when there is one) from the canonical volume records. */
export interface CoworkNativeOwnerRecoverAttestation {
  readonly kind: "owner-recover"; readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly attestedBy: "owner";
}
/** The processes of one launch, as the daemon recorded them DURABLY while it lived: what an absence check needs after a crash
 * (a pid alone is reused; the start token and the boot id make it an identity). `launcher` is null while the spawn was requested but its
 * identity not yet written, `worker` is null until the launcher's `begun`. */
export interface CoworkNativeLaunchEntry {
  readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly bootId: string;
  readonly launcher: { readonly pid: number; readonly startToken: string; readonly instanceId: string } | null;
  readonly worker: { readonly pid: number; readonly startToken: string } | null;
}
/** Durable, synchronous, keyed by (workspace, incarnation, epoch); `record` replaces the previous entry of that key. Written BEFORE the
 * launcher is spawned, again with the launcher's identity, again at `begun`. S7 binds it to a store outside the runtime-state schema. */
export interface CoworkNativeLaunchJournalPort {
  record(entry: CoworkNativeLaunchEntry): void;
  load(scope: { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number }): CoworkNativeLaunchEntry | null;
  forget(scope: { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number }): void;
}
export interface CoworkNativeRecoverSubject {
  readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly owner: CoworkVolumeOwner | null;
  /** The launch journal entry, or null when none was ever written (no launch was started by this daemon for the incarnation). */
  readonly processes: CoworkNativeLaunchEntry | null;
}
/** The two guard checks of D1. Extra safety only: they can only make recovery stricter, never replace the attestation. */
export interface CoworkNativeRecoverGuards {
  processAbsent(subject: Readonly<CoworkNativeRecoverSubject>): boolean;
  imagesUnlocked(volumes: readonly CoworkVolumeRecord[]): boolean;
}

export const ownerKey = (owner: CoworkVolumeOwner): string => JSON.stringify([owner.controllerInstanceId, owner.workerInstanceId, owner.incarnationId, owner.leaseEpoch, owner.runtimeImageDigest]);
export const sameOwnerTuple = (a: CoworkVolumeOwner | null, b: CoworkVolumeOwner | null): boolean => a !== null && b !== null && ownerKey(a) === ownerKey(b);

/** `controllerInstanceId` is `ctl-<host boot id>-<8 hex>`: the boot the owner was born in travels with the owner tuple, so
 * "has that boot ended" is answerable after a restart (or after another daemon's ledger reconcile released the admission row)
 * without any lookup. The tuple is host-written durable state, never guest input. */
export function mintControllerInstanceId(bootId: string, suffix: string): string {
  const id = `ctl-${bootId}-${suffix}`;
  if (!/^[A-Za-z0-9-]{1,40}$/.test(bootId) || !/^[a-f0-9]{8}$/.test(suffix) || id.length > 63) return refuse("invalid");
  return id;
}
export function ownerBootId(owner: CoworkVolumeOwner): string | null {
  const match = /^ctl-([A-Za-z0-9-]{1,40})-[a-f0-9]{8}$/.exec(owner.controllerInstanceId);
  return match ? match[1]! : null;
}

interface ProofState {
  readonly kind: CoworkNativeEvidenceKind; readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number;
  /** Null only for an explicit owner recovery of an incarnation that holds no volume claim: such a proof can never release a volume. */
  readonly owner: CoworkVolumeOwner | null; readonly confirmationId: string;
  /** For an orderly receipt: the facts it attests, kept for the later bindings. Null for the other kinds. */
  readonly receipt: CoworkNativeOrderlyReceipt | null; readonly issuedAtMs: number;
  consumed: boolean;
}
const proofs = new WeakMap<object, ProofState>();
export interface CoworkNativeStopProof { readonly kind: CoworkNativeEvidenceKind; readonly confirmationId: string; readonly workspaceId: string }
function seal(state: ProofState): CoworkNativeStopProof {
  const proof = Object.freeze({ kind: state.kind, confirmationId: state.confirmationId, workspaceId: state.workspaceId });
  proofs.set(proof, state);
  return proof;
}
/** Internal read access for authority.ts and recovery. The state is the module's own, never a copy a caller could edit. */
export function stopProofState(candidate: unknown): Readonly<ProofState> | undefined {
  return typeof candidate === "object" && candidate !== null ? proofs.get(candidate) : undefined;
}
export const isStopProof = (candidate: unknown): candidate is CoworkNativeStopProof => stopProofState(candidate) !== undefined;

/** In-process memory of what was used and what is known stopped. Not authority: every fact in it came from a mint above. */
export class CoworkNativeStopRegistry {
  private readonly spent = new Set<string>();
  private readonly stopped = new Map<string, CoworkNativeEvidenceKind>();
  /** True when this receipt (by id) or this nonce was already used to release. */
  wasSpent(confirmationId: string, nonce: string | null): boolean { return this.spent.has(`id:${confirmationId}`) || (nonce !== null && this.spent.has(`nonce:${nonce}`)); }
  /** Record that releasing with `proof` succeeded. After this the proof is spent: it cannot release a second time, and the
   * owner it names counts as stopped for replay-debt purposes. */
  consume(proof: CoworkNativeStopProof): void {
    const state = typeof proof === "object" && proof !== null ? proofs.get(proof) : undefined;
    if (!state) return refuse("invalid");
    state.consumed = true;
    this.spent.add(`id:${state.confirmationId}`);
    if (state.receipt) this.spent.add(`nonce:${state.receipt.stopNonce}`);
    if (state.owner) this.stopped.set(ownerKey(state.owner), state.kind);
  }
  isOwnerStopped(owner: CoworkVolumeOwner): boolean { return this.stopped.has(ownerKey(owner)); }
  /** A restart forgets nothing that matters: new-boot evidence re-derives from the owner tuple and a retained receipt re-loads. */
  noteStopped(owner: CoworkVolumeOwner, kind: CoworkNativeEvidenceKind): void { this.stopped.set(ownerKey(owner), kind); }
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** What the daemon saw on the channel before the stop: a receipt cannot know LESS than the daemon observed. */
export interface CoworkNativeObserved { readonly volumesAccepted: boolean; readonly vmRunning: boolean; readonly guestHello: boolean; /** The worker reported `guest_fault`: after one, no Class A can exist for the run. */ readonly guestFault?: boolean }
/** The admission record, reduced to what a receipt must agree with. */
export interface CoworkNativeAdmissionView { readonly admissionId: string; readonly owner: { readonly bootId: string } }
export interface OrderlyEvidenceInput {
  readonly receipt: CoworkNativeOrderlyReceipt; readonly owner: CoworkVolumeOwner; readonly homeId: string;
  /** The admission this incarnation reserved, when the caller knows it (a restarted daemon may not): the receipt must name it AND the boot it was made in. */
  readonly admission: CoworkNativeAdmissionView | null;
  readonly volumes: readonly CoworkVolumeRecord[];
  /** True when the volumes were already released (owner null) and only the admission and power remain to settle. */
  readonly volumesReleased?: boolean;
  /** `live`: the receipt arrived on the launcher channel this process owns, in answer to a stop it issued: the nonce must be the one it
   * issued, the launcher the one on the channel, and the receipt may not contradict what this process observed. `retained`: it was read
   * back from the launcher's durable store through an attesting port. */
  readonly source: { readonly kind: "live"; readonly stopNonce: string; readonly launcherInstanceId: string; readonly observed: CoworkNativeObserved } | {
    /** Read back from the launcher's durable store. That store is same-user writable and authenticates nothing, so a retained receipt releases ONLY
     * if both of D1's guards pass at this moment (the old worker process is absent, the images are unlocked); the probes are part of the source,
     * so there is no way to mint a retained proof without them. Otherwise the receipt is treated like a Class B one: no release. */
    readonly kind: "retained"; readonly guards: CoworkNativeRecoverGuards; readonly processes: CoworkNativeLaunchEntry | null;
    /** The installation's receipt key, or null when it is missing or unreadable (a null key makes every retained receipt Class B). The receipt's MAC is verified under it
     * BEFORE the guards run: a forged file never gets as far as asking about the old worker. */
    readonly key: CoworkNativeReceiptKey | null };
  readonly registry: CoworkNativeStopRegistry; readonly now: () => number;
}
/** Class A receipt to sealed release proof, or a refusal that says which binding failed. Class B has no function here at all. */
export function mintOrderlyStopProof(input: OrderlyEvidenceInput): CoworkNativeStopProof {
  const { owner, volumes } = input;
  // Re-validate from scratch: a typed object is not trusted because it has the right type. The strict serializer refuses an extra key,
  // a wrong type, a malformed id; the strict parser then refuses anything the wire would refuse (the worker's exit, status, reaping...).
  let receipt: CoworkNativeOrderlyReceipt;
  try {
    const reparsed = parseCoworkNativeStopReceipt(serializeCoworkNativeStopReceipt(input.receipt));
    if (reparsed.class !== "A") return refuse("not_orderly");
    receipt = reparsed;
  } catch (error) { if (error instanceof CoworkNativeStopEvidenceError) throw error; return refuse("not_orderly"); }
  if (!classAInvariantsHold(receipt)) return refuse("not_orderly");
  const bootId = ownerBootId(owner);
  if (bootId === null) return refuse("boot_unknown");
  if (receipt.workspaceId !== volumes[0]?.workspaceId || receipt.incarnationId !== owner.incarnationId || receipt.leaseEpoch !== owner.leaseEpoch || receipt.controllerInstanceId !== owner.controllerInstanceId
    || receipt.workerInstanceId !== owner.workerInstanceId || receipt.runtimeImageDigest !== owner.runtimeImageDigest || receipt.homeId !== input.homeId || receipt.hostBootId !== bootId
    || (input.admission !== null && (receipt.admissionId !== input.admission.admissionId || receipt.hostBootId !== input.admission.owner.bootId))) return refuse("wrong_binding");
  if (volumes.length !== 2) return refuse("wrong_binding");
  for (const [index, volume] of volumes.entries()) {
    const attested = receipt.volumes[index]!;
    // An unattached entry names nothing (zeros, enforced by the invariants); an attached one must be exactly this recorded file.
    const identityOk = !attested.attached || (volume.identity !== null && volume.identity.device === attested.device && volume.identity.inode === attested.inode && volume.capacityBytes === attested.capacityBytes);
    if (volume.purpose !== attested.purpose || volume.workspaceId !== receipt.workspaceId || !identityOk || (input.volumesReleased === true ? volume.owner !== null : !sameOwnerTuple(volume.owner, owner))) return refuse("wrong_binding");
  }
  if (input.source.kind === "live") {
    const { stopNonce, launcherInstanceId, observed } = input.source;
    if (receipt.launcherInstanceId !== launcherInstanceId) return refuse("wrong_binding");
    if (receipt.origin !== "host-stop" || receipt.stopNonce !== stopNonce) return refuse("nonce_mismatch");
    // `unattached` means the worker never accepted the descriptors and `not-booted` that it never reported a running VM. A daemon that saw
    // either happen cannot accept a receipt that says it did not.
    if (observed.guestFault === true) return refuse("not_orderly");
    if ((observed.volumesAccepted && receipt.volumes.some(v => !v.attached)) || ((observed.vmRunning || observed.guestHello) && receipt.guest.drain === "not-booted")) return refuse("not_orderly");
  }
  if (input.source.kind === "retained") {
    const { guards, processes, key } = input.source;
    // The launcher's store is a same-user writable file that authenticates nothing: the MAC (under a Keychain key the file cannot hold) is what makes it the launcher's.
    if (!verifyCoworkNativeOrderlyReceiptMac(receipt, key)) return refuse("mac_invalid");
    const subject: CoworkNativeRecoverSubject = { workspaceId: receipt.workspaceId, incarnationId: owner.incarnationId, leaseEpoch: owner.leaseEpoch, owner, processes };
    // A launch whose launcher identity was never written leaves a process nobody can name: absence cannot be shown (as for owner recover).
    if (processes !== null && (processes.launcher === null || processes.workspaceId !== subject.workspaceId || processes.incarnationId !== subject.incarnationId || processes.leaseEpoch !== subject.leaseEpoch)) return refuse("guard_failed");
    let absent = false, unlocked = false;
    try { absent = guards.processAbsent(subject) === true; unlocked = guards.imagesUnlocked(volumes) === true; } catch { /* a guard that cannot answer refuses */ }
    if (!absent || !unlocked) return refuse("guard_failed");
  }
  if (input.registry.wasSpent(receipt.confirmationId, receipt.stopNonce)) return refuse("replayed");
  return seal({ kind: "orderly-receipt", workspaceId: receipt.workspaceId, incarnationId: owner.incarnationId, leaseEpoch: owner.leaseEpoch, owner: { ...owner }, confirmationId: receipt.confirmationId, receipt, issuedAtMs: input.now(), consumed: false });
}

/** Host boot evidence: the owner was born in a boot that is not this one, and the host probe says that boot is over. */
export function mintNewBootStopProof(input: { readonly owner: CoworkVolumeOwner; readonly workspaceId: string; readonly hostBoot: CoworkNativeHostBoot; readonly now: () => number }): CoworkNativeStopProof {
  const previous = ownerBootId(input.owner);
  if (previous === null) return refuse("boot_unknown");
  if (previous === input.hostBoot.bootId()) return refuse("boot_not_ended");
  let ended = false;
  try { ended = input.hostBoot.confirmsPreviousBootEnded(previous) === true; } catch { /* an unanswerable probe is not evidence */ }
  if (!ended) return refuse("boot_not_ended");
  return seal({ kind: "new-boot", workspaceId: input.workspaceId, incarnationId: input.owner.incarnationId, leaseEpoch: input.owner.leaseEpoch, owner: { ...input.owner }, confirmationId: `boot-${sha(`${previous}|${ownerKey(input.owner)}`)}`, receipt: null, issuedAtMs: input.now(), consumed: false });
}

/** Explicit owner recovery: the attestation names exactly this workspace and incarnation, AND both guards agree. */
export function mintOwnerRecoverStopProof(input: { readonly subject: CoworkNativeRecoverSubject; readonly attestation: CoworkNativeOwnerRecoverAttestation | null; readonly guards: CoworkNativeRecoverGuards; readonly volumes: readonly CoworkVolumeRecord[]; readonly now: () => number }): CoworkNativeStopProof {
  const { attestation, subject } = input;
  if (!attestation || attestation.kind !== "owner-recover" || attestation.attestedBy !== "owner" || attestation.workspaceId !== subject.workspaceId || attestation.incarnationId !== subject.incarnationId || attestation.leaseEpoch !== subject.leaseEpoch) return refuse("recover_refused");
  // A launch that was requested but whose launcher identity was never written leaves a process nobody can name: absence cannot be shown.
  const entry = subject.processes;
  if (entry !== null && (entry.launcher === null || entry.workspaceId !== subject.workspaceId || entry.incarnationId !== subject.incarnationId || entry.leaseEpoch !== subject.leaseEpoch)) return refuse("recover_refused");
  let absent = false, unlocked = false;
  try { absent = input.guards.processAbsent(subject) === true; unlocked = input.guards.imagesUnlocked(input.volumes) === true; } catch { /* a guard that cannot answer refuses */ }
  if (!absent || !unlocked) return refuse("recover_refused");
  const basis = subject.owner ? ownerKey(subject.owner) : JSON.stringify([subject.workspaceId, subject.incarnationId, subject.leaseEpoch]);
  return seal({ kind: "owner-recover", workspaceId: subject.workspaceId, incarnationId: subject.incarnationId, leaseEpoch: subject.leaseEpoch, owner: subject.owner ? { ...subject.owner } : null, confirmationId: `recover-${sha(basis)}`, receipt: null, issuedAtMs: input.now(), consumed: false });
}

// ------------------------------------------------------------------------------------------------ admission ledger bridge

const ledgerReceipts = new WeakMap<object, { proof: CoworkNativeStopProof }>();
/** The admission ledger's `StopReceipt` for a record, built only from a sealed proof. The ledger's `verifyStopReceipt` probe must
 * be `coworkNativeLedgerStopProbe`, which accepts nothing that did not come from here. */
export function ledgerStopReceipt(proof: CoworkNativeStopProof, record: AdmissionRecord, homeId: string): LedgerStopReceipt {
  const state = stopProofState(proof);
  if (!state) return refuse("invalid");
  if (record.workspaceId !== state.workspaceId || record.incarnationId !== state.incarnationId || record.leaseEpoch !== state.leaseEpoch || record.homeId !== homeId) return refuse("wrong_binding");
  const receipt: LedgerStopReceipt = Object.freeze({ confirmationId: state.confirmationId, admissionId: record.admissionId, homeId, workspaceId: record.workspaceId, incarnationId: record.incarnationId, leaseEpoch: record.leaseEpoch, owner: record.owner, confirmedAt: state.issuedAtMs });
  ledgerReceipts.set(receipt, { proof });
  return receipt;
}
export function coworkNativeLedgerStopProbe(receipt: LedgerStopReceipt, record: AdmissionRecord): boolean {
  const entry = typeof receipt === "object" && receipt !== null ? ledgerReceipts.get(receipt) : undefined;
  const state = entry ? stopProofState(entry.proof) : undefined;
  if (!entry || !state || state.consumed) return false;
  return receipt.admissionId === record.admissionId && receipt.workspaceId === state.workspaceId && receipt.incarnationId === state.incarnationId && receipt.leaseEpoch === state.leaseEpoch && receipt.confirmationId === state.confirmationId;
}

// ------------------------------------------------------------------------------------------------ release tokens

const released = new WeakMap<object, { workspaceId: string; incarnationId: string; leaseEpoch: number; via: "release" | "volumes-free" }>();
export interface CoworkNativeReleaseToken { readonly workspaceId: string; readonly via: "release" | "volumes-free" }
/** The only thing the tokens read volumes through. `CoworkVolumes` is one; a caller cannot hand over records it made up. */
export interface CoworkNativeVolumeReader { records(workspaceId: string): readonly CoworkVolumeRecord[] }
const bothFree = (volumes: readonly CoworkVolumeRecord[]): boolean => volumes.length === 2 && volumes.every(v => v.owner === null);
/** Minted by the host AFTER `volumes.release` succeeded, and the only thing (with the volumes-free token below) that power.ts accepts
 * for a move to `stopped`. It reads the CURRENT records itself: both images must be free. */
export function mintReleaseToken(input: { readonly proof: CoworkNativeStopProof; readonly volumes: CoworkNativeVolumeReader }): CoworkNativeReleaseToken {
  const state = stopProofState(input.proof);
  if (!state) return refuse("invalid");
  if (!bothFree(input.volumes.records(state.workspaceId))) return refuse("wrong_binding");
  const token = Object.freeze({ workspaceId: state.workspaceId, via: "release" as const });
  released.set(token, { workspaceId: state.workspaceId, incarnationId: state.incarnationId, leaseEpoch: state.leaseEpoch, via: "release" });
  return token;
}
/** The volumes are free: no claim is recorded on either image. That alone moves nothing; it is the last step for an incarnation whose
 * evidence was already accepted (volumes released earlier) or that never claimed anything (the start died before the claim), and
 * whose admission is gone. It reads the current records itself, so an unknown workspace (no pair) is refused too. */
export function mintVolumesFreeToken(input: { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly volumes: CoworkNativeVolumeReader }): CoworkNativeReleaseToken {
  if (!bothFree(input.volumes.records(input.workspaceId))) return refuse("wrong_binding");
  const token = Object.freeze({ workspaceId: input.workspaceId, via: "volumes-free" as const });
  released.set(token, { workspaceId: input.workspaceId, incarnationId: input.incarnationId, leaseEpoch: input.leaseEpoch, via: "volumes-free" });
  return token;
}
export function releaseTokenState(candidate: unknown): { workspaceId: string; incarnationId: string; leaseEpoch: number; via: "release" | "volumes-free" } | undefined {
  return typeof candidate === "object" && candidate !== null ? released.get(candidate) : undefined;
}
