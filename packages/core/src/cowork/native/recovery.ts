import type { AdmissionRecord, CoworkAdmissionLedger } from "../admission";
import type { CoworkRepository } from "../repository";
import type { CoworkVolumeOwner, CoworkVolumeRecord, CoworkVolumes } from "../volumes";
import type { CoworkNativeReceiptKey } from "./receipt-mac";
import { parseCoworkNativeStopReceipt, type CoworkNativeOrderlyReceipt } from "./protocol";
import { CoworkNativePower, type CoworkPower, type CoworkPowerKey } from "./power";
import {
  CoworkNativeStopEvidenceError, ledgerStopReceipt, mintVolumesFreeToken, mintNewBootStopProof, mintOrderlyStopProof, mintOwnerRecoverStopProof, mintReleaseToken, sameOwnerTuple, stopProofState,
  type CoworkNativeAdmissionView, type CoworkNativeEvidenceKind, type CoworkNativeHostBoot, type CoworkNativeLaunchEntry, type CoworkNativeLaunchJournalPort, type CoworkNativeOwnerRecoverAttestation, type CoworkNativeRecoverGuards, type CoworkNativeStopProof, type CoworkNativeStopRegistry,
} from "./stop-proof";

/*
 * Releasing what a stop (or a restart, or a reboot) proved stopped, and everything that must NOT be released.
 *
 * Two entry points share one release flow:
 *   - `CoworkNativeRecovery.bootReconcile()` at daemon start: runs the admission ledger's own `reconcile()` (which marks dead or
 *     unknown owners `uncertain` and releases rows whose previous boot provably ended), then settles every workspace that is not
 *     `stopped`.
 *   - `CoworkNativeRecovery.recover(workspaceId)`: the same, for one workspace, optionally with an explicit owner `recover` input.
 *
 * Order inside the release flow, and why: volumes FIRST (the writable disks are what matters; freeing them while a stale
 * admission row still exists is harmless), then the admission row, then `power`, then the proof is spent. Each step is idempotent and
 * re-derives its evidence, so a crash between any two of them is finished by the next run; nothing relies on memory that a
 * restart loses.
 *
 * The D1 conservative default lives in stop-proof.ts. In this file: a workspace WITHOUT evidence is only ever moved to `uncertain`
 * (never to `stopped`) and keeps its owner; a Class B receipt is read, recorded in the report and otherwise ignored.
 */

export interface CoworkNativeReceiptScope { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number }
/** The launcher's retained receipts, outside the Winter home. The port must return ONLY text it can attest was written by the
 * launcher for this incarnation (the launcher slice decides how); file presence alone is not attestation. Synchronous: it is called
 * inside recovery, never inside a database transaction. */
export interface CoworkNativeDurableReceiptPort {
  load(scope: CoworkNativeReceiptScope): { readonly text: string; readonly attested: true } | null;
  /** Forget the receipts of this incarnation. Called only once nothing can need them any more (see `release` and `settleDebt`). */
  retire(scope: CoworkNativeReceiptScope): void;
}
/** UNWIRED: nothing in src/ implements it. The owner's explicit "this workspace's worker is gone, release it" input. */
export interface CoworkNativeOwnerRecoverPort {
  confirm(request: { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number }): CoworkNativeOwnerRecoverAttestation | null;
}

/** Thrown by a test's `checkpoint` hook to stand for the process dying at that point. Nothing in this module (or the host) catches it. */
export class CoworkNativeSimulatedCrash extends Error { constructor(readonly phase: string) { super(`simulated crash at ${phase}`); this.name = "CoworkNativeSimulatedCrash"; } }
/** An error's class and code, nothing else: never a message that could carry a path or a receipt. */
export function describeNativeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? `${error.name}:${code}` : error.name;
}
const view = (admission: AdmissionRecord | null): CoworkNativeAdmissionView | null => admission === null ? null : { admissionId: admission.admissionId, owner: { bootId: admission.owner.bootId } };

export type CoworkNativeRecoveryAction = "none" | "retained" | "released";
export interface CoworkNativeRecoveryReport {
  readonly workspaceId: string;
  readonly action: CoworkNativeRecoveryAction;
  readonly evidence: CoworkNativeEvidenceKind | "admission-reconcile" | "nothing-held" | null;
  readonly power: CoworkPower;
  /** True while the canonical volume records still name an owner. */
  readonly ownerRetained: boolean;
  readonly admission: "none" | "active" | "uncertain" | "released";
  /** Why nothing was released, when nothing was. Never carries a path, a pid or receipt text. */
  readonly reason: string | null;
}

export interface CoworkNativeRecoveryDeps {
  readonly records: CoworkRepository; readonly volumes: CoworkVolumes; readonly admission: CoworkAdmissionLedger; readonly power: CoworkNativePower;
  readonly registry: CoworkNativeStopRegistry; readonly hostBoot: CoworkNativeHostBoot;
  /** The installation's receipt key as already loaded into memory (the Keychain read is asynchronous, recovery is not). Null or absent: every retained receipt is Class B. */
  readonly receiptKey?: () => CoworkNativeReceiptKey | null;
  readonly receipts?: CoworkNativeDurableReceiptPort; readonly ownerRecover?: CoworkNativeOwnerRecoverPort; readonly guards?: CoworkNativeRecoverGuards;
  /** The durable record of which processes each launch started; consulted by owner recovery and forgotten once an incarnation is released. */
  readonly journal?: CoworkNativeLaunchJournalPort;
  readonly now?: () => number;
  /** Isolated crash/fault testing only, never serialized: called after each durable step. */
  readonly checkpoint?: (phase: string) => void;
}

const activeStates = new Set(["reserved", "booting", "running", "draining", "uncertain"]);

export class CoworkNativeRecovery {
  private readonly now: () => number;
  private readonly checkpoint: (phase: string) => void;
  constructor(private readonly deps: CoworkNativeRecoveryDeps) {
    this.now = deps.now ?? Date.now;
    this.checkpoint = deps.checkpoint ?? (() => {});
  }

  /** Daemon start: the ledger's own reconcile first, then every workspace that is not `stopped`. No owner-recover input is used here. */
  bootReconcile(exclude: ReadonlySet<string> = new Set()): CoworkNativeRecoveryReport[] {
    this.deps.admission.reconcile();
    this.checkpoint("boot-reconciled");
    const reports: CoworkNativeRecoveryReport[] = [];
    for (const workspace of this.deps.records.list()) {
      if (workspace.state !== "retained" || workspace.incarnationId === null || exclude.has(workspace.workspaceId)) continue;
      let volumes: readonly CoworkVolumeRecord[] | null = null;
      try {
        volumes = this.deps.volumes.records(workspace.workspaceId);
        if (workspace.power === "stopped" && volumes.every(v => v.owner === null) && this.findAdmission(workspace.workspaceId, workspace.incarnationId, workspace.leaseEpoch) === null) continue;
        reports.push(this.recover(workspace.workspaceId));
      } catch (error) {
        if (error instanceof CoworkNativeSimulatedCrash) throw error;
        // One workspace that cannot be read must not stop the others from being settled.
        reports.push({ workspaceId: workspace.workspaceId, action: "retained", evidence: null, power: workspace.power, ownerRetained: volumes === null || volumes.some(v => v.owner !== null), admission: "none", reason: `recovery failed (${describeNativeError(error)})` });
      }
    }
    return reports;
  }

  /** Settle one workspace. Never throws for lack of evidence: that is a `retained` report, not an error. */
  recover(workspaceId: string, options: { readonly ownerRecover?: boolean } = {}): CoworkNativeRecoveryReport {
    const workspace = this.deps.records.get(workspaceId);
    const volumes = this.deps.volumes.records(workspaceId);
    const incarnationId = workspace.incarnationId;
    const report = (action: CoworkNativeRecoveryAction, evidence: CoworkNativeRecoveryReport["evidence"], reason: string | null): CoworkNativeRecoveryReport => {
      const current = this.deps.records.get(workspaceId), admission = incarnationId ? this.findAdmission(workspaceId, incarnationId, workspace.leaseEpoch) : null;
      return { workspaceId, action, evidence, power: current.power, ownerRetained: this.deps.volumes.records(workspaceId).some(v => v.owner !== null),
        admission: admission === null ? "none" : admission.state === "uncertain" ? "uncertain" : "active", reason };
    };
    if (workspace.state !== "retained" || incarnationId === null) return report("none", null, "nothing to recover");
    const key: CoworkPowerKey = { workspaceId, incarnationId, leaseEpoch: workspace.leaseEpoch };

    const first = volumes[0]?.owner ?? null, second = volumes[1]?.owner ?? null;
    const consistent = volumes.length === 2 && ((first === null && second === null) || sameOwnerTuple(first, second));
    const owner = consistent ? first : null;
    if (!consistent || (owner !== null && (owner.incarnationId !== incarnationId || owner.leaseEpoch !== workspace.leaseEpoch))) {
      // Volume ownership that does not describe the current incarnation is never guessed at: retain, mark uncertain, ask a person.
      this.retain(key, workspace.power);
      return report("retained", null, "volume ownership does not match the current incarnation");
    }
    const admission = this.findAdmission(workspaceId, incarnationId, workspace.leaseEpoch);

    // Nothing to release and nothing held: the incarnation is already settled.
    if (workspace.power === "stopped" && owner === null && admission === null) return report("none", null, null);

    const homeId = this.deps.records.recordedHomeIdentity();
    const found = owner !== null ? this.evidenceWithOwner(key, owner, volumes, admission, homeId, options) : this.evidenceWithoutOwner(key, volumes, admission, homeId, options);
    if (found.kind === "none") {
      this.retain(key, workspace.power);
      return report("retained", null, found.reason);
    }
    if (found.kind === "ledger-released") {
      // Disks are free and the ledger holds no row for this incarnation (it released it itself, by its own boot probe, or none was ever made). Only `power` remains.
      this.finishPower(key, null);
      return report("released", admission === null ? "nothing-held" : "admission-reconcile", null);
    }
    try {
      this.release(key, owner, homeId, found.proof);
    } catch (error) {
      if (error instanceof CoworkNativeSimulatedCrash) throw error;
      // A step failed part-way (for example the ledger disagreed about a boot change): whatever was already released stays released, the
      // rest is held, and the next run starts from the records again.
      this.retain(key, this.deps.power.read(workspaceId).power);
      return report("retained", null, `release incomplete (${describeNativeError(error)})`);
    }
    return report("released", found.proof.kind, null);
  }

  // ----------------------------------------------------------------------------------------------- evidence

  private evidenceWithOwner(key: CoworkPowerKey, owner: CoworkVolumeOwner, volumes: readonly CoworkVolumeRecord[], admission: AdmissionRecord | null, homeId: string, options: { ownerRecover?: boolean }):
    { kind: "proof"; proof: CoworkNativeStopProof } | { kind: "none"; reason: string } {
    let reason = "no release evidence";
    const stored = this.deps.receipts?.load({ workspaceId: key.workspaceId, incarnationId: key.incarnationId, leaseEpoch: key.leaseEpoch }) ?? null;
    if (stored?.attested === true) {
      try {
        const receipt = parseCoworkNativeStopReceipt(stored.text);
        if (receipt.class === "A") {
          const source = this.retainedSource(key);
          if (source === null) reason = "retained receipt needs the guard probes; treated as uncertain";
          else return { kind: "proof", proof: mintOrderlyStopProof({ receipt, owner, homeId, admission: view(admission), volumes, source, registry: this.deps.registry, now: this.now }) };
        } else
        reason = `uncertain receipt (${receipt.reason}) never releases`;
      } catch (error) { reason = error instanceof CoworkNativeStopEvidenceError ? `retained receipt refused (${error.code})` : "retained receipt unreadable"; }
    }
    try { return { kind: "proof", proof: mintNewBootStopProof({ owner, workspaceId: key.workspaceId, hostBoot: this.deps.hostBoot, now: this.now }) }; } catch { /* same boot, or unanswerable */ }
    if (options.ownerRecover === true) {
      const proof = this.ownerRecoverProof(key, owner, volumes);
      if (proof) return { kind: "proof", proof };
      reason = "owner recovery refused";
    }
    return { kind: "none", reason };
  }
  private evidenceWithoutOwner(key: CoworkPowerKey, volumes: readonly CoworkVolumeRecord[], admission: AdmissionRecord | null, homeId: string, options: { ownerRecover?: boolean }):
    { kind: "proof"; proof: CoworkNativeStopProof } | { kind: "ledger-released" } | { kind: "none"; reason: string } {
    if (admission === null) return { kind: "ledger-released" };
    // Only the ledger's own probe may release an admission by boot change; run it, then look again.
    this.deps.admission.reconcile();
    if (this.findAdmission(key.workspaceId, key.incarnationId, key.leaseEpoch) === null) return { kind: "ledger-released" };
    let reason = "no release evidence";
    const stored = this.deps.receipts?.load(key) ?? null;
    if (stored?.attested === true) {
      try {
        const receipt = parseCoworkNativeStopReceipt(stored.text);
        if (receipt.class === "A") {
          const owner = ownerFromReceipt(receipt), source = this.retainedSource(key);
          if (source === null) reason = "retained receipt needs the guard probes; treated as uncertain";
          else return { kind: "proof", proof: mintOrderlyStopProof({ receipt, owner, homeId, admission: view(admission), volumes, volumesReleased: true, source, registry: this.deps.registry, now: this.now }) };
        } else reason = `uncertain receipt (${receipt.reason}) never releases`;
      } catch (error) { reason = error instanceof CoworkNativeStopEvidenceError ? `retained receipt refused (${error.code})` : "retained receipt unreadable"; }
    }
    if (options.ownerRecover === true) {
      const proof = this.ownerRecoverProof(key, null, volumes);
      if (proof) return { kind: "proof", proof };
      reason = "owner recovery refused";
    }
    return { kind: "none", reason };
  }
  /** The only way a retained receipt becomes a source: with the journal entry and the guards. No guards means the receipt is not evidence. */
  private retainedSource(scope: CoworkNativeReceiptScope): { kind: "retained"; guards: CoworkNativeRecoverGuards; processes: CoworkNativeLaunchEntry | null; key: CoworkNativeReceiptKey | null } | null {
    const { guards } = this.deps;
    if (!guards) return null;
    let processes: CoworkNativeLaunchEntry | null = null;
    try { processes = this.deps.journal?.load(scope) ?? null; } catch { return null; }
    let key: CoworkNativeReceiptKey | null = null;
    try { key = this.deps.receiptKey?.() ?? null; } catch { key = null; }
    return { kind: "retained", guards, processes, key };
  }
  private ownerRecoverProof(key: CoworkPowerKey, owner: CoworkVolumeOwner | null, volumes: readonly CoworkVolumeRecord[]): CoworkNativeStopProof | null {
    const { ownerRecover, guards } = this.deps;
    if (!ownerRecover || !guards) return null;
    try {
      const attestation = ownerRecover.confirm({ workspaceId: key.workspaceId, incarnationId: key.incarnationId, leaseEpoch: key.leaseEpoch });
      const processes = this.deps.journal?.load({ workspaceId: key.workspaceId, incarnationId: key.incarnationId, leaseEpoch: key.leaseEpoch }) ?? null;
      return mintOwnerRecoverStopProof({ subject: { workspaceId: key.workspaceId, incarnationId: key.incarnationId, leaseEpoch: key.leaseEpoch, owner, processes }, attestation, guards, volumes, now: this.now });
    } catch { return null; }
  }

  // ----------------------------------------------------------------------------------------------- the release flow

  /** Volumes, then admission, then power, then spend the proof. Public so a live `stop` uses exactly the same steps. Every step reads
   * the CURRENT records (the arguments are only what the caller believed), so a retry after a crash finishes what is left. */
  release(key: CoworkPowerKey, owner: CoworkVolumeOwner | null, homeId: string, proof: CoworkNativeStopProof): { readonly retired: boolean } {
    const state = stopProofState(proof);
    if (!state || state.workspaceId !== key.workspaceId || state.incarnationId !== key.incarnationId || state.leaseEpoch !== key.leaseEpoch) throw new CoworkNativeStopEvidenceError("wrong_binding");
    // A boot change releases only if the ledger's own probe AGREES: two independent answers before a single disk is freed.
    if (proof.kind === "new-boot" && this.findAdmission(key.workspaceId, key.incarnationId, key.leaseEpoch) !== null) {
      this.deps.admission.reconcile();
      if (this.findAdmission(key.workspaceId, key.incarnationId, key.leaseEpoch) !== null) throw new CoworkNativeStopEvidenceError("boot_not_ended");
    }
    if (this.deps.volumes.records(key.workspaceId).some(v => v.owner !== null)) {
      if (owner === null || state.owner === null) throw new CoworkNativeStopEvidenceError("wrong_binding");
      this.deps.volumes.release({ workspaceId: key.workspaceId, owner, proof }, { confirmationId: proof.confirmationId, proof });
      this.checkpoint("volumes-released");
    }
    const admission = this.findAdmission(key.workspaceId, key.incarnationId, key.leaseEpoch);
    if (admission !== null && activeStates.has(admission.state)) {
      if (proof.kind === "new-boot") {
        // The ledger decides boot changes itself, through its own probe; it already agreed above (or released the row).
        this.deps.admission.reconcile();
      } else this.deps.admission.release(admission.admissionId, admission.owner, ledgerStopReceipt(proof, admission, homeId));
      this.checkpoint("admission-released");
    }
    const free = this.deps.volumes.records(key.workspaceId);
    this.finishPower(key, mintReleaseToken({ proof, volumes: this.deps.volumes }));
    this.deps.registry.consume(proof);
    this.deps.journal?.forget({ workspaceId: key.workspaceId, incarnationId: key.incarnationId, leaseEpoch: key.leaseEpoch });
    // A receipt is still needed while a replay debt names its owner: the successor must prove THAT writer stopped. It is retired by `settleDebt`,
    // and the caller must not tell the launcher to forget it either (hence the result).
    const owed = free.some(v => v.filesystemJournal?.replayDebt?.owner.incarnationId === key.incarnationId && v.filesystemJournal.replayDebt.owner.leaseEpoch === key.leaseEpoch);
    // Retire policy (N2 S7): after an owner-loss exit no launcher remains to retire a retained file over L1, and a Class B file is never retired by one.
    // The daemon therefore deletes a file ONLY here, directly, after volumes, admission and power are settled by real proof (any proof kind, so a Class B
    // file of a settled incarnation goes with it). A file of a disk that stays held is left in place, never deleted on read or on refusal.
    if (!owed) this.deps.receipts?.retire({ workspaceId: key.workspaceId, incarnationId: key.incarnationId, leaseEpoch: key.leaseEpoch });
    this.checkpoint("receipt-retired");
    return { retired: !owed };
  }
  /** `stopped` with a token minted from the current free volumes (or, without a proof, from the pre-claim rule). */
  private finishPower(key: CoworkPowerKey, token: ReturnType<typeof mintReleaseToken> | null): void {
    let from = this.deps.power.read(key.workspaceId).power;
    if (from === "stopped") return;
    const release = token ?? mintVolumesFreeToken({ workspaceId: key.workspaceId, incarnationId: key.incarnationId, leaseEpoch: key.leaseEpoch, volumes: this.deps.volumes });
    // A workspace that was running had no orderly drain of its own; it passes through `draining` like any other stop.
    if (from === "running") { this.deps.power.transition(key, "running", "draining"); from = "draining"; }
    this.deps.power.transition(key, from, "stopped", release);
    this.checkpoint("power-stopped");
  }
  private retain(key: CoworkPowerKey, power: CoworkPower): void {
    if (power !== "stopped") this.deps.power.markUncertain(key);
  }
  /** Before a new incarnation claims: if the volumes carry a replay debt, make sure the stop of THAT writer is known in this process.
   * Known already, derivable from the boot id in its owner tuple, or provable from the launcher's retained orderly receipt. Returns
   * whether it is known; a debt whose writer cannot be shown stopped makes the next `prepareFilesystems` refuse with `stop_unconfirmed`. */
  ensureDebtStopped(workspaceId: string): boolean {
    const volumes = this.deps.volumes.records(workspaceId), debt = volumes[0]?.filesystemJournal?.replayDebt;
    if (!debt) return true;
    if (this.deps.registry.isOwnerStopped(debt.owner)) return true;
    try { mintNewBootStopProof({ owner: debt.owner, workspaceId, hostBoot: this.deps.hostBoot, now: this.now }); this.deps.registry.noteStopped(debt.owner, "new-boot"); return true; } catch { /* same boot */ }
    const stored = this.deps.receipts?.load({ workspaceId, incarnationId: debt.owner.incarnationId, leaseEpoch: debt.owner.leaseEpoch }) ?? null;
    if (stored?.attested !== true) return false;
    try {
      const receipt = parseCoworkNativeStopReceipt(stored.text);
      if (receipt.class !== "A" || !sameOwnerTuple(ownerFromReceipt(receipt), debt.owner)) return false;
      // The proof is minted only to validate the receipt against the canonical records; it releases nothing here.
      const source = this.retainedSource({ workspaceId, incarnationId: debt.owner.incarnationId, leaseEpoch: debt.owner.leaseEpoch });
      if (source === null) return false;
      mintOrderlyStopProof({ receipt, owner: debt.owner, homeId: this.deps.records.recordedHomeIdentity(), admission: null, volumes, volumesReleased: true, source, registry: this.deps.registry, now: this.now });
      this.deps.registry.noteStopped(debt.owner, "orderly-receipt");
      return true;
    } catch { return false; }
  }
  /** After the successor confirmed its filesystems, the previous writer's retained receipt has done its job. */
  settleDebt(workspaceId: string, debt: { readonly owner: CoworkVolumeOwner } | null): void {
    if (debt) this.deps.receipts?.retire({ workspaceId, incarnationId: debt.owner.incarnationId, leaseEpoch: debt.owner.leaseEpoch });
  }
  /** The active (non-released) admission of exactly this incarnation and epoch, if the ledger still holds one. */
  findAdmission(workspaceId: string, incarnationId: string, leaseEpoch: number): AdmissionRecord | null {
    return this.deps.admission.listActive().find(r => r.workspaceId === workspaceId && r.incarnationId === incarnationId && r.leaseEpoch === leaseEpoch) ?? null;
  }
}

/** A retained receipt names the whole owner tuple; the caller still binds every field of it to the canonical records. */
export function ownerFromReceipt(receipt: CoworkNativeOrderlyReceipt): CoworkVolumeOwner {
  return { controllerInstanceId: receipt.controllerInstanceId, workerInstanceId: receipt.workerInstanceId, incarnationId: receipt.incarnationId, leaseEpoch: receipt.leaseEpoch, runtimeImageDigest: receipt.runtimeImageDigest };
}
