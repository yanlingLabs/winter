import { randomBytes, randomUUID } from "node:crypto";
import type { AdmissionOwner, CoworkAdmissionLedger } from "../admission";
import type { CoworkRepository } from "../repository";
import type { CoworkVolumeOwner, CoworkVolumeRecord, CoworkVolumeRequest, CoworkVolumes } from "../volumes";
import type { VolumeFilesystemPlan, VolumeFilesystemReceipt } from "../volume-filesystem";
import { CoworkNativeAuthority, type CoworkNativeChannelBinding, type CoworkNativeLink } from "./authority";
import { CoworkNativeRuntimeStreams, CoworkNativeMuxSequence, serializeCoworkNativeMuxFrame, COWORK_NATIVE_LIMITS, coworkNativeConversationsAreBound, type CoworkNativeConversation, type CoworkNativeRuntimeProfile, coworkNativeHostStopWaitMs, coworkNativeLauncherKillMs, coworkNativeScopeDigest, sortedCanonical, type CoworkNativeMuxFrame, type CoworkNativeShareKind, type CoworkNativeShareRecord, type CoworkNativeGuestShare, type CoworkNativeScope, type CoworkNativeToDaemon, type CoworkNativeToLauncher, type CoworkNativeUncertainReceipt, type CoworkNativeVolumeIdentity } from "./protocol";
import type { CoworkNativeReceiptKey } from "./receipt-mac";
import { CoworkNativePower, CoworkNativePowerError, type CoworkPowerKey } from "./power";
import { CoworkNativeRecovery, CoworkNativeSimulatedCrash, describeNativeError, type CoworkNativeRecoveryReport } from "./recovery";
import { CoworkGuestDirectoryError, CoworkPlanEpochGuard, parseCoworkPlanView } from "./guest-dirs";
import type { CoworkNativeGuestRecords } from "./guest-records";
import { CoworkNativeStopEvidenceError, mintControllerInstanceId, mintVolumesFreeToken, mintOrderlyStopProof, type CoworkNativeEvidenceKind, type CoworkNativeHostBoot, type CoworkNativeLaunchEntry, type CoworkNativeLaunchJournalPort, type CoworkNativeObserved, type CoworkNativeStopRegistry } from "./stop-proof";

/*
 * CoworkNativeHost: the whole launch sequence of one Cowork workspace over an INJECTED launcher port, plus stop, release and
 * recovery. SOURCE ONLY and unwired: nothing in src/ imports this module, and the only launcher port implementation is the
 * fake in the tests. No VM exists behind any of it.
 *
 *   beginIncarnation -> admission reserve -> launcher spawn -> claim -> prepareFilesystems -> open x2 -> transfer -> bootstrap ->
 *   confirmFilesystems -> ready -> power running                 (and: stop -> release -> power stopped; recover)
 *
 * Rules the sequence enforces (each has a test, and a mutation check):
 *  - the owner is claimed BEFORE any descriptor exists, and descriptors are opened only after the format intent is committed;
 *  - the daemon closes its two descriptors the moment the worker accepted them, and closing is never treated as a release;
 *  - a failure after the worker exists is answered with a stop request, and only a valid orderly receipt for THAT request releases;
 *  - a Class B receipt, a channel EOF, a launcher fault, a timeout or an unsolicited stop only ever mark the workspace `uncertain`;
 *  - a simulated crash (the isolated `checkpoint` hook) is rethrown untouched: a dead process runs no cleanup.
 */

export { CoworkNativeSimulatedCrash };

export type CoworkNativeHostFailure = "busy" | "not_stopped" | "not_allocated" | "owner_held" | "bad_image_digest" | "bad_boot" | "launcher_refused" | "protocol" | "timeout" | "guest_fault" | "start_failed" | "not_running" | "closed" | "no_receipt_key" | "store_lost" | "prepare_failed";
export class CoworkNativeHostError extends Error {
  constructor(readonly code: CoworkNativeHostFailure, readonly detail?: string, options?: { cause?: unknown }) { super(detail ? `${code}: ${detail}` : code, options); this.name = "CoworkNativeHostError"; }
}

/** A launcher process the port has ALREADY spawned and verified (code identity, parent/child relationship) and whose first line
 * (`hello`) it has already read. The host never reads a socket; it only sees typed messages. */
export interface CoworkLauncherSession extends CoworkNativeLink {
  readonly launcherInstanceId: string;
  /** The launcher PROCESS: the port spawned it, so it knows its pid and start token (kept in the launch journal for owner recovery). */
  readonly pid: number; readonly startToken: string;
  /** The host boot id the launcher reported in `hello`. */
  readonly hostBootId: string;
  send(message: CoworkNativeToLauncher, rights?: readonly number[]): void;
  /** Typed, already-parsed messages from the launcher, in order. Returns an unsubscribe. */
  onMessage(handler: (message: CoworkNativeToDaemon) => void): () => void;
  /** The channel ended (EOF or a fault). Fires at most once. */
  onClose(handler: () => void): () => void;
  close(): void;
}
export interface CoworkLauncherPort { spawn(request: { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number }): Promise<CoworkLauncherSession> }
/** To be bound to the image-pin bookkeeping (`CoworkImagePins.assertPinned`) when the host is wired. The launch uses the digest
 * of the pinned runtime image; a missing or malformed pin refuses. */
export interface CoworkNativeImagePins { runtimeImageDigest(workspaceId: string): string }

export interface CoworkNativeHostTimeouts { readonly spawnMs: number; readonly heartbeatMs: number; readonly begunMs: number; readonly volumesMs: number; readonly guestHelloMs: number; readonly receiptMs: number; readonly mountedMs: number; readonly stopGraceMs: number; /** The VMM exit allowance after the guest budget (libkrun's exit watchdog plus the launcher's margin): the launcher kills no sooner. */ readonly exitAllowanceMs: number; /** From the conversation set's send to `runtime_ready`: the guest starts the tool supervisor and waits for its ready line. */ readonly runtimeReadyMs: number; /** The longest a runtime send waits for the guest to read before the in-flight budget frees (it then fails with `timeout`). */ readonly runtimeStallMs: number; readonly drainBudgetMs: number }
export const COWORK_NATIVE_HOST_DEFAULT_TIMEOUTS: CoworkNativeHostTimeouts = Object.freeze({ spawnMs: 20_000, heartbeatMs: 10_000, begunMs: 15_000, volumesMs: 15_000, guestHelloMs: 90_000, receiptMs: 180_000, mountedMs: 60_000, stopGraceMs: COWORK_NATIVE_LIMITS.hostStopMarginMs, exitAllowanceMs: coworkNativeLauncherKillMs(0), runtimeReadyMs: 60_000, runtimeStallMs: 60_000, drainBudgetMs: COWORK_NATIVE_LIMITS.drainBudgetMs });

/** What the host decides for the guest's tool supervisor (contract 6.1): `profile` null = tools only. */
export interface CoworkNativeConversationSet { readonly profile: CoworkNativeRuntimeProfile | null; readonly conversations: readonly CoworkNativeConversation[] }
/** The facts a conversation set must be bound to; the guest's boot id is the one from its `hello`. */
export interface CoworkNativeConversationContext { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly guestBootId: string }
export interface CoworkNativeHostDeps {
  /** Supplies the incarnation's conversation set after `mounted`, or null for none (no supervisor is started and there is no `runtime_ready`). Unwired: no implementation exists in src/. */
  readonly conversations?: (context: CoworkNativeConversationContext) => CoworkNativeConversationSet | null;
  readonly records: CoworkRepository; readonly volumes: CoworkVolumes; readonly admission: CoworkAdmissionLedger; readonly authority: CoworkNativeAuthority;
  readonly power: CoworkNativePower; readonly recovery: CoworkNativeRecovery; readonly registry: CoworkNativeStopRegistry; readonly hostBoot: CoworkNativeHostBoot;
  readonly launcher: CoworkLauncherPort; readonly images: CoworkNativeImagePins;
  /** The installation's receipt key, already in memory (the wiring loads it from the Keychain before a start). It rides only in the L1 `begin` line. Null refuses the start, before anything moves. */
  readonly receiptKey: () => CoworkNativeReceiptKey | null;
  /** The durable record of which processes each launch started (written before the spawn, then with each identity). */
  readonly journal?: CoworkNativeLaunchJournalPort;
  /** A repeating timer, so the admission heartbeat can be driven by a test clock. The default is an unref'd `setInterval`. */
  readonly timers?: { every(ms: number, run: () => void): () => void };
  /** This daemon process as the admission ledger knows it (pid, start token, boot id, instance nonce). */
  readonly daemon: () => AdmissionOwner;
  /** The durable guest records (DOOR's migration 21): the boot at `hello`, the data volume's UUID. Absent means nothing is recorded, no boot is ever attested as ended and the store volume is not compared. */
  readonly guestRecords?: CoworkNativeGuestRecords;
  /** Creates `/workspace/outputs/<logicalSessionId>` where the outputs share is served from, before the set is sent. Idempotent, never follows a symlink. Absent: nothing is created. */
  readonly outputs?: { ensure(workspaceId: string, logicalSessionId: string): void };
  /** Opens a share's host directory as exactly that directory (a canonical path, O_NOFOLLOW|O_DIRECTORY), described by its own descriptor. Absent: a start that asks for shares is refused. */
  readonly shareDirectories?: { open(hostPath: string): { readonly fd: number; readonly device: string; readonly inode: string; close(): void } };
  readonly timeouts?: Partial<CoworkNativeHostTimeouts>; readonly memoryMiB?: number;
  /** TEST ONLY: lets a test pass timeouts shorter than the contract's floor. Never set outside tests. */
  readonly unsafeTestTimeouts?: boolean;
  readonly now?: () => number;
  /** Isolated crash/fault testing only, never serialized or supplied by an RPC. A throw stands for the process dying there. */
  readonly checkpoint?: (phase: string) => void;
  /** Test seams for deterministic ids and nonces. */
  readonly mint?: { uuid?: () => string; nonce?: () => string; suffix?: () => string };
}

export type CoworkNativeStopOutcome =
  | { readonly released: true; readonly evidence: CoworkNativeEvidenceKind }
  | { readonly released: false; readonly reason: string };
/** What a caller of `start` may add: the conversation set comes from the caller (a Cowork session), not only from `deps.conversations`. */
/** One host-backed share the host prepared (contract revision 3). `hostPath` is a canonical directory the host opens itself; a folder share names the source it backs. */
export interface CoworkNativeHostShare {
  readonly tag: string; readonly kind: CoworkNativeShareKind; readonly guestPath: string; readonly readOnly: boolean; readonly hostPath: string;
  readonly sourceId?: string; readonly revision?: number;
}
export interface CoworkNativeStartRequest {
  /** The shares this incarnation mounts, or null/absent for none. Asked once, before `begin`; the L1 `shares` line carries one open directory per share. */
  readonly shares?: () => readonly CoworkNativeHostShare[] | null;
  /** At the guest's `shares_mounted`, BEFORE the conversation set: each mounted folder source, mapped from its tag. A throw faults the boot (`share_mount_failed`). */
  readonly sharesMounted?: (context: CoworkNativeConversationContext, mounted: readonly { readonly sourceId: string; readonly revision: number }[]) => void;
  /** A gated cold resume: put on every host-query conversation's runtime record, and checked against the guest's `continuation` echo. */
  readonly resume?: { readonly continuation: "fresh" | "resume" | "either"; readonly endedGuestBoots: readonly string[] };
  /** The host decided the conversation's guest store is gone: the guest said `resume_store_missing`, or the data volume is not the one the store lived on. */
  readonly storeLost?: (reason: "resume_store_missing" | "volume_mismatch" | "volume_unformatted") => void;
  /** Called once at `mounted`; returns this incarnation's set (N2: at most one host-query conversation), or null for none. Takes precedence over `deps.conversations`. */
  readonly conversations?: (context: CoworkNativeConversationContext) => CoworkNativeConversationSet | null;
}
/** Runtime class 2 for conversation index 0, available once `runtime_ready` was accepted. Frames are never dropped: every OUT and ERR frame reaches every handler in order. */
export interface CoworkNativeRuntimeLink {
  /** IN bytes, chunked to at most 256 KiB, bounded by the 1 MiB unanswered budget (waits for the guest to read, fails with `timeout` after `runtimeStallMs`). Resolves when the frame is handed to L1. `end` closes the IN stream. */
  send(bytes: Uint8Array, end?: boolean): Promise<void>;
  /** OUT and ERR bytes in order; `end` is true once per stream. Returns an unsubscribe. */
  onData(handler: (stream: "out" | "err", bytes: Uint8Array, end: boolean) => void): () => void;
  /** Resolves when the incarnation's stop outcome is known (released or not). */
  readonly ended: Promise<CoworkNativeStopOutcome>;
}
export interface CoworkNativeRunning {
  readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly admissionId: string; readonly owner: CoworkVolumeOwner;
  /** The guest's boot id from its `hello` (what the conversation set was bound to). */
  readonly guestBootId: string;
  /** What the guest reported for each host-query conversation at `runtime_ready`: `fresh` or `resume`, as the supervisor ran it (contract 12.2). Empty for a tools-only set. */
  readonly continuations: readonly ("fresh" | "resume")[];
  /** The runtime link of conversation 0; throws `not_running` when this incarnation has no host-query conversation. */
  runtime(conversation: 0): CoworkNativeRuntimeLink;
  /** Resolves when the incarnation's stop outcome is known (released or not), however it ended. */
  readonly ended: Promise<CoworkNativeStopOutcome>;
  stop(reason?: "user" | "shutdown" | "restart" | "update"): Promise<CoworkNativeStopOutcome>;
}
export interface CoworkNativeUncertainEvent { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly reason: string }

type RunPhase = "starting" | "running" | "stopping" | "dead";
interface Run {
  readonly key: CoworkPowerKey; readonly owner: CoworkVolumeOwner; readonly homeId: string;
  readonly receiptKey: CoworkNativeReceiptKey; admissionId: string | null; session: CoworkLauncherSession | null; binding: CoworkNativeChannelBinding | null; inbox: SessionInbox | null;
  phase: RunPhase; unsubscribe: (() => void)[]; downSeq: number; upSeq: CoworkNativeMuxSequence;
  /** What this process saw happen on the channel: a stop receipt cannot say less. */
  observed: { volumesAccepted: boolean; vmRunning: boolean; guestHello: boolean; guestFault: boolean };
  stopHeartbeat: (() => void) | null;
  /** True once the conversation set went out: a `runtime_ready` before that is out of order. */
  conversationsSent: boolean; earlyReady: boolean;
  /** A second `runtime_ready` is ignored for power, admission and ownership but still passes the up-sequence check, so a later bootstrap-up consumer sees no gap. */
  readySeen: boolean; readyAccepted: boolean; duplicateSeqAnomaly: boolean; pendingDuplicates: Extract<CoworkNativeMuxFrame, { class: "bootstrap" }>[];
  /** Set when a runtime violation must end the incarnation but the start has not finished yet (a stop needs a running guest): the start stops it as soon as it is running. */
  overflowStop?: boolean;
  request: CoworkNativeStartRequest | undefined; guestBootId: string; continuations: readonly ("fresh" | "resume")[];
  /** The shares the start sent, by tag (for the `shares_mounted` mapping). */
  shares: readonly CoworkNativeHostShare[];
  /** The runtime class, created when the conversation set goes out. */
  runtime: RuntimeEnd | null;
  /** How this incarnation ended, known to `ended`; set before `dispose`. */
  outcome: CoworkNativeStopOutcome | null; endedResolve: (outcome: CoworkNativeStopOutcome) => void; ended: Promise<CoworkNativeStopOutcome>;
}

const RUNTIME_CHUNK_BYTES = 256 * 1024;
/** OUT/ERR bytes held for a first subscriber that has not attached yet (the caller can only attach after `start()` resolves). Beyond it, frames count as violations and are dropped. */
const RUNTIME_PRESUBSCRIBE_BYTES = 1024 * 1024;
/** The host end of the runtime class of one run: sequence and stream bookkeeping, the handlers, and the senders waiting for the guest to read. */
class RuntimeEnd {
  readonly streams: CoworkNativeRuntimeStreams;
  readonly handlers = new Set<(stream: "out" | "err", bytes: Uint8Array, end: boolean) => void>();
  readonly waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  downSeq = 0; closed = false; violations = 0;
  /** Frames that arrived before any subscriber ever attached, in order; the first subscriber receives them, then this stays empty. */
  readonly held: { stream: "out" | "err"; bytes: Uint8Array; end: boolean }[] = []; heldBytes = 0; everSubscribed = false; overflowed = false;
  constructor(conversations: number) { this.streams = new CoworkNativeRuntimeStreams(conversations); }
  wake(): void { for (const waiter of this.waiters.splice(0)) waiter.resolve(); }
  close(): void {
    this.closed = true; this.handlers.clear();
    for (const waiter of this.waiters.splice(0)) waiter.reject(new CoworkNativeHostError("closed", "the run ended"));
  }
}

const isCrash = (error: unknown): boolean => error instanceof CoworkNativeSimulatedCrash;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** Typed message queue over one launcher session, with awaitable, timed, predicate-based receives. A terminal message or a
 * closed channel rejects every wait that has not been satisfied. */
class SessionInbox {
  private readonly queue: CoworkNativeToDaemon[] = [];
  private readonly waiters: { pick: (message: CoworkNativeToDaemon) => unknown | undefined; resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private ended: CoworkNativeHostError | null = null;
  private readonly off: (() => void)[];
  constructor(session: CoworkLauncherSession) { this.off = [session.onMessage(message => this.push(message)), session.onClose(() => this.end(new CoworkNativeHostError("closed", "launcher channel ended")))]; }
  private sealed = false;
  private push(message: CoworkNativeToDaemon): void {
    for (const [index, waiter] of this.waiters.entries()) {
      const picked = waiter.pick(message);
      if (picked !== undefined) { this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(picked); return; }
    }
    // After the start every unmatched message is noise to this inbox (runtime frames have no consumer in this slice); only the
    // verdicts a later stop waits for are worth keeping, and a flood of the rest must not grow without bound.
    if (this.sealed && message.t !== "stopped" && message.t !== "uncertain" && message.t !== "fault") return;
    this.queue.push(message);
  }
  /** Keep only terminal messages from now on, and forget what is already queued. */
  seal(): void { this.sealed = true; this.queue.splice(0); }
  get size(): number { return this.queue.length; }
  end(error: CoworkNativeHostError): void {
    if (this.ended) return; this.ended = error;
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
  }
  /** Wait for the first (queued or future) message `pick` accepts. `pick` returns undefined for "not this one". */
  expect<T>(pick: (message: CoworkNativeToDaemon) => T | undefined, ms: number, what: string): Promise<T> {
    for (const [index, message] of this.queue.entries()) {
      const picked = pick(message);
      if (picked !== undefined) { this.queue.splice(index, 1); return Promise.resolve(picked); }
    }
    if (this.ended) return Promise.reject(this.ended);
    return new Promise<T>((resolve, reject) => {
      const waiter = { pick: pick as (message: CoworkNativeToDaemon) => unknown | undefined, resolve: resolve as (value: unknown) => void, reject, timer: setTimeout(() => {
        const at = this.waiters.indexOf(waiter); if (at >= 0) this.waiters.splice(at, 1);
        reject(new CoworkNativeHostError("timeout", what));
      }, ms) };
      this.waiters.push(waiter);
    });
  }
  /** Everything still queued (for the monitor, which looks for terminal messages after start). */
  drain(): CoworkNativeToDaemon[] { return this.queue.splice(0); }
  close(): void { this.off.forEach(run => run()); this.end(new CoworkNativeHostError("closed", "inbox closed")); }
}

export class CoworkNativeHost {
  private readonly runs = new Map<string, Run>();
  private readonly planEpochs = new CoworkPlanEpochGuard();
  private readonly timeouts: CoworkNativeHostTimeouts;
  private readonly uncertainHandlers: ((event: CoworkNativeUncertainEvent) => void)[] = [];
  private readonly now: () => number;
  constructor(private readonly deps: CoworkNativeHostDeps) {
    this.timeouts = { ...COWORK_NATIVE_HOST_DEFAULT_TIMEOUTS, ...deps.timeouts };
    // The stop wait may never be shorter than the contract's H (guest budget + the VMM exit allowance + margins): a shorter wait gives up on a launcher that is still entitled to answer.
    if (deps.unsafeTestTimeouts !== true && this.timeouts.drainBudgetMs + this.timeouts.exitAllowanceMs + this.timeouts.stopGraceMs < coworkNativeHostStopWaitMs(this.timeouts.drainBudgetMs)) throw new CoworkNativeHostError("protocol", "stop wait is shorter than the contract's host wait");
    this.now = deps.now ?? Date.now;
  }
  private hook(phase: string): void { try { this.deps.checkpoint?.(phase); } catch (error) { throw isCrash(error) ? error : new CoworkNativeSimulatedCrash(phase); } }
  private uuid(): string { return this.deps.mint?.uuid?.() ?? randomUUID(); }
  private nonce(): string { return this.deps.mint?.nonce?.() ?? hex(16); }
  private suffix(): string { return this.deps.mint?.suffix?.() ?? hex(4); }

  onUncertain(handler: (event: CoworkNativeUncertainEvent) => void): () => void {
    this.uncertainHandlers.push(handler);
    return () => { const at = this.uncertainHandlers.indexOf(handler); if (at >= 0) this.uncertainHandlers.splice(at, 1); };
  }
  activeWorkspaces(): string[] { return [...this.runs.keys()]; }
  /** Launcher messages held for a running workspace (diagnostics and tests): bounded, terminal verdicts only. */
  queuedLauncherMessages(workspaceId: string): number { return this.runs.get(workspaceId)?.inbox?.size ?? 0; }

  /** Daemon start: delegates to recovery (the ledger's own reconcile, then every workspace that is not stopped). */
  bootReconcile(): CoworkNativeRecoveryReport[] { return this.deps.recovery.bootReconcile(new Set(this.runs.keys())); }
  /** One workspace, optionally with the owner's explicit recover input. Refused while this process runs it. */
  recover(workspaceId: string, options: { ownerRecover?: boolean } = {}): CoworkNativeRecoveryReport {
    if (this.runs.has(workspaceId)) throw new CoworkNativeHostError("busy", "workspace has a live run");
    return this.deps.recovery.recover(workspaceId, options);
  }

  // ===================================================================================================== start

  async start(workspaceId: string, request?: CoworkNativeStartRequest): Promise<CoworkNativeRunning> {
    if (this.runs.has(workspaceId)) throw new CoworkNativeHostError("busy");
    const { records, volumes } = this.deps;
    const workspace = records.get(workspaceId);
    if (workspace.state !== "retained" || workspace.power !== "stopped") throw new CoworkNativeHostError("not_stopped");
    const before = volumes.records(workspaceId);
    if (before.length !== 2 || before.some(v => v.state !== "allocated")) throw new CoworkNativeHostError("not_allocated");
    if (before.some(v => v.owner !== null)) throw new CoworkNativeHostError("owner_held", "a previous owner still holds the volumes; recover first");
    this.checkStoreVolume(workspaceId, before, request);
    const runtimeImageDigest = this.deps.images.runtimeImageDigest(workspaceId);
    if (typeof runtimeImageDigest !== "string" || !/^[a-f0-9]{64}$/.test(runtimeImageDigest)) throw new CoworkNativeHostError("bad_image_digest");
    const receiptKey = this.deps.receiptKey();
    if (receiptKey === null) throw new CoworkNativeHostError("no_receipt_key", "no receipt key is available; a launch without one could not leave authenticable receipts");
    const bootId = this.deps.hostBoot.bootId(), daemon = this.deps.daemon();
    if (daemon.bootId !== bootId) throw new CoworkNativeHostError("bad_boot", "daemon identity is from another boot");

    const homeId = records.recordedHomeIdentity(), incarnationId = `inc-${this.uuid()}`;
    // Everything that can be refused about the ids is refused BEFORE the incarnation moves: the boot id has to fit the owner tuple.
    let controllerInstanceId: string;
    try { controllerInstanceId = mintControllerInstanceId(bootId, this.suffix()); } catch { throw new CoworkNativeHostError("bad_boot", "the host boot id cannot be part of an owner tuple"); }
    const workerInstanceId = `wrk-${this.uuid()}`;
    const epoch = records.beginIncarnation(workspaceId, incarnationId, workspace.configRevision);
    const owner: CoworkVolumeOwner = { controllerInstanceId, workerInstanceId, incarnationId, leaseEpoch: epoch.leaseEpoch, runtimeImageDigest };
    const run: Run = { key: { workspaceId, incarnationId, leaseEpoch: epoch.leaseEpoch }, owner, homeId, receiptKey, admissionId: null, session: null, binding: null, inbox: null, phase: "starting", unsubscribe: [], downSeq: 0, upSeq: new CoworkNativeMuxSequence(),
      observed: { volumesAccepted: false, vmRunning: false, guestHello: false, guestFault: false }, stopHeartbeat: null, conversationsSent: false, earlyReady: false, readySeen: false, readyAccepted: false, duplicateSeqAnomaly: false, pendingDuplicates: [],
      request, guestBootId: "", continuations: [], shares: [], runtime: null, outcome: null, endedResolve: () => {}, ended: Promise.resolve({ released: false, reason: "never started" }) };
    run.ended = new Promise<CoworkNativeStopOutcome>(resolve => { run.endedResolve = resolve; });
    this.runs.set(workspaceId, run);
    this.hook("incarnation-begun");
    try {
      await this.launch(run);
    } catch (error) {
      if (isCrash(error)) throw error;
      await this.failStart(run, error);
      throw error instanceof CoworkNativeHostError ? error : new CoworkNativeHostError("start_failed", error instanceof Error ? error.name : "unknown", { cause: error });
    }
    run.phase = "running";
    run.inbox!.seal();
    this.hook("power-running");
    this.watch(run);
    if (run.overflowStop) void this.stop(workspaceId, "shutdown").catch(() => {});
    return Object.freeze({ workspaceId, incarnationId, leaseEpoch: epoch.leaseEpoch, admissionId: run.admissionId!, owner, guestBootId: run.guestBootId, continuations: run.continuations, ended: run.ended, runtime: (conversation: 0) => this.runtimeLink(run, conversation), stop: (reason: "user" | "shutdown" | "restart" | "update" = "user") => this.stop(workspaceId, reason) });
  }

  /** CR4 step 9: the data volume is the one the guest store lives on. Runs before the incarnation moves, so a refusal leaves nothing behind.
   *  - a store the host believes exists (`resume`/`either`) over a volume that was never formatted (a format-new would follow) is a lost store;
   *  - the volume's filesystem UUID is kept per workspace, write-once, and a different one is refused (a lost store when one was expected). */
  private checkStoreVolume(workspaceId: string, volumes: readonly CoworkVolumeRecord[], request: CoworkNativeStartRequest | undefined): void {
    const data = volumes.find(volume => volume.purpose === "data");
    if (!data || data.filesystemUUID === null) throw new CoworkNativeHostError("not_allocated");
    const resuming = request?.resume !== undefined && request.resume.continuation !== "fresh";
    const lost = (reason: "volume_mismatch" | "volume_unformatted"): never => {
      try { request?.storeLost?.(reason); } catch { /* the refusal below stands either way */ }
      throw new CoworkNativeHostError("store_lost", reason);
    };
    if (resuming && data.filesystemState === "unformatted") lost("volume_unformatted");
    const records = this.deps.guestRecords;
    if (records && records.recordStoreVolumeUuid(workspaceId, data.filesystemUUID) === "mismatch") {
      if (resuming) lost("volume_mismatch");
      throw new CoworkNativeHostError("store_lost", "volume_mismatch");
    }
  }

  private async launch(run: Run): Promise<void> {
    const { volumes, admission, authority, launcher } = this.deps;
    const { workspaceId, incarnationId, leaseEpoch } = run.key, owner = run.owner, memoryMiB = this.deps.memoryMiB ?? 768;
    const scope: CoworkNativeScope = { workspaceId, incarnationId, leaseEpoch, admissionId: "", controllerInstanceId: owner.controllerInstanceId, workerInstanceId: owner.workerInstanceId, runtimeImageDigest: owner.runtimeImageDigest, vcpus: COWORK_NATIVE_LIMITS.vcpus, memoryMiB };

    // 1. admission reserve
    const reserved = admission.reserve({ requestId: `req-${incarnationId}`, homeId: run.homeId, owner: this.deps.daemon(), workspaceId, incarnationId, leaseEpoch, commitment: { memoryBytes: memoryMiB * 1024 * 1024, cpuUnits: COWORK_NATIVE_LIMITS.vcpus } });
    run.admissionId = reserved.admissionId;
    this.startHeartbeat(run);
    this.hook("admission-reserved");

    // 2. launcher spawn (verified and hello'd by the port). The journal is written BEFORE the spawn, so a crash in it leaves a record that a
    // launch was started, and again with the launcher's identity as soon as it is known.
    const bootId = this.deps.hostBoot.bootId(), journal = (entry: Pick<CoworkNativeLaunchEntry, "launcher" | "worker">): void => this.deps.journal?.record({ workspaceId, incarnationId, leaseEpoch, bootId, ...entry });
    journal({ launcher: null, worker: null });
    const session = await this.spawnWithin(run, () => launcher.spawn({ workspaceId, incarnationId, leaseEpoch }));
    run.session = session;
    journal({ launcher: { pid: session.pid, startToken: session.startToken, instanceId: session.launcherInstanceId }, worker: null });
    this.hook("launcher-spawned");
    if (session.hostBootId !== this.deps.hostBoot.bootId()) throw new CoworkNativeHostError("bad_boot", "launcher reports another boot");
    run.inbox = new SessionInbox(session);
    run.unsubscribe.push(session.onMessage(message => {
      if (message.t === "worker_state" && message.state === "vm_running") run.observed.vmRunning = true;
      else if (message.t === "worker_state" && message.state === "guest_fault") run.observed.guestFault = true;
      else if (message.t === "mux_up" && message.frame.class === "bootstrap" && message.frame.message.t === "hello") run.observed.guestHello = true;
      else if (message.t === "mux_up" && message.frame.class === "runtime") this.onRuntimeUp(run, message.frame);
      else if (message.t === "mux_up" && message.frame.class === "bootstrap" && message.frame.message.t === "runtime_ready" && !run.conversationsSent) run.earlyReady = true;
      else if (message.t === "mux_up" && message.frame.class === "bootstrap" && message.frame.message.t === "runtime_ready") {
        if (!run.readySeen) run.readySeen = true;
        else if (run.readyAccepted) this.acceptDuplicate(run, message.frame);
        else run.pendingDuplicates.push(message.frame);
      }
    }));
    const binding = authority.adopt(session, { workspaceId, homeId: run.homeId, admissionId: reserved.admissionId, owner });
    run.binding = binding;
    this.moveAdmission(run, "booting");

    // 2b. host-backed shares (contract revision 3): ONE open directory per share on L1, after `hello` and before `begin`, at most once.
    run.shares = this.sendShares(run, session);

    // 3. begin: the worker is spawned suspended, validated, sandboxed
    const full: CoworkNativeScope = { ...scope, admissionId: reserved.admissionId };
    const begin = `req-${this.uuid()}`.slice(0, 63);
    session.send({ t: "begin", id: begin, homeId: run.homeId, ...full, receiptKey: run.receiptKey });
    await run.inbox.expect(message => message.t === "begun" && message.id === begin ? message : message.t === "refused" && message.id === begin ? message : undefined, this.timeouts.begunMs, "begun")
      .then(message => {
        if (message.t === "refused") throw new CoworkNativeHostError("launcher_refused", message.code);
        if (message.t !== "begun" || message.workerInstanceId !== owner.workerInstanceId) throw new CoworkNativeHostError("protocol", "begun names another worker");
        journal({ launcher: { pid: session.pid, startToken: session.startToken, instanceId: session.launcherInstanceId }, worker: { pid: message.workerPid, startToken: message.workerStartToken } });
      });
    binding.advance("begun");
    this.hook("worker-begun");

    // 4. claim -> prepareFilesystems -> open x2 -> transfer
    const request: CoworkVolumeRequest = { workspaceId, owner, proof: binding.volumeProof() };
    // A replay debt names a previous writer. Make its stop known (registry, boot id, or the launcher's retained receipt) BEFORE the
    // plan is built; if it cannot be shown, prepareFilesystems refuses with stop_unconfirmed and nothing is formatted or replayed.
    this.deps.recovery.ensureDebtStopped(workspaceId);
    volumes.claim(request);
    this.hook("claimed");
    const plan = volumes.prepareFilesystems(request);
    this.hook("filesystem-intent");
    const handles: { close(): void }[] = [];
    try {
      const data = volumes.open(request, "data"); handles.push(data);
      const environment = volumes.open(request, "environment"); handles.push(environment);
      this.hook("volumes-opened");
      const id = `req-${this.uuid()}`.slice(0, 63), pair: [CoworkNativeVolumeIdentity, CoworkNativeVolumeIdentity] = [identityOf(data.volume), identityOf(environment.volume)];
      session.send({ t: "volumes", id, scopeDigest: coworkNativeScopeDigest(full), volumes: pair }, [data.fd, environment.fd]);
      await run.inbox.expect(message => message.t === "volumes_accepted" && message.id === id ? message : message.t === "refused" && message.id === id ? message : undefined, this.timeouts.volumesMs, "volumes_accepted")
        .then(message => { if (message.t === "refused") throw new CoworkNativeHostError("launcher_refused", message.code); run.observed.volumesAccepted = true; });
    } finally {
      // The worker holds its own copies now (or never will). Closing ours is cleanup, never a release.
      handles.forEach(handle => handle.close());
    }
    binding.advance("attached");
    this.hook("transferred");

    // 5. bootstrap: hello, plan(nonce), receipt, confirm
    const hello = await run.inbox.expect(message => message.t === "mux_up" && message.frame.class === "bootstrap" && message.frame.message.t === "hello" ? message.frame : undefined, this.timeouts.guestHelloMs, "guest hello");
    run.upSeq.accept(hello, "up");
    // The boot is recorded when the guest says hello, before anything else is asked of it: a boot that is not recorded can never be attested as ended.
    if (hello.message.t === "hello") this.deps.guestRecords?.recordHello({ workspaceId, incarnationId: owner.incarnationId, leaseEpoch: owner.leaseEpoch, guestBootId: hello.message.guestBootId });
    const { nonce } = binding.issuePlan(plan);
    this.sendBootstrap(run, { t: "plan", operationId: plan.operationId, nonce, plan: sortedCanonical(plan) as Record<string, unknown> });
    this.hook("bootstrap-sent");
    const reply = await run.inbox.expect(message => message.t === "mux_up" && message.frame.class === "bootstrap" && (message.frame.message.t === "receipt" || message.frame.message.t === "fault") ? message.frame : undefined, this.timeouts.receiptMs, "bootstrap receipt");
    run.upSeq.accept(reply, "up");
    this.hook("receipt-received");
    const answer = (reply as Extract<CoworkNativeMuxFrame, { class: "bootstrap" }>).message;
    if (answer.t === "fault") {
      binding.clearPending(); volumes.failFilesystems(request, plan.operationId);
      throw new CoworkNativeHostError("guest_fault", answer.code);
    }
    if (answer.t !== "receipt") throw new CoworkNativeHostError("protocol", "unexpected bootstrap frame");
    const proof = binding.acceptReceipt({ operationId: answer.operationId, nonce: answer.nonce, receipt: answer.receipt });
    volumes.confirmFilesystems(request, answer.receipt as unknown as VolumeFilesystemReceipt, proof);
    binding.consumeReceipt(proof);
    this.deps.recovery.settleDebt(workspaceId, plan.priorReplay);
    this.hook("filesystems-confirmed");
    if (!volumes.filesystemsReady(request)) throw new CoworkNativeHostError("protocol", "filesystems not ready after confirmation");

    // 6. ready -> mounted -> power running
    this.sendBootstrap(run, { t: "ready", operationId: plan.operationId, nonce });
    this.hook("ready-sent");
    const mounted = await run.inbox.expect(message => message.t === "mux_up" && message.frame.class === "bootstrap" && message.frame.message.t === "mounted" && message.frame.message.operationId === plan.operationId && message.frame.message.nonce === nonce ? message.frame : undefined, this.timeouts.mountedMs, "mounted");
    if (run.earlyReady) throw new CoworkNativeHostError("protocol", "runtime_ready before the conversation set");
    run.upSeq.accept(mounted, "up");
    run.guestBootId = hello.message.t === "hello" ? hello.message.guestBootId : "";
    await this.deliverShares(run, { workspaceId, incarnationId: owner.incarnationId, leaseEpoch: owner.leaseEpoch, guestBootId: run.guestBootId }, plan.operationId, nonce);
    await this.deliverConversations(run, { workspaceId, incarnationId: owner.incarnationId, leaseEpoch: owner.leaseEpoch, guestBootId: run.guestBootId }, plan.operationId, nonce);
    binding.advance("ready");
    this.deps.power.transition(run.key, "starting", "running");
    this.moveAdmission(run, "running");
  }

  /** A duplicate `runtime_ready` changes nothing (power, admission, ownership) but is counted in the up sequence; a malformed sequence number on it is not a reason to stop a running guest. */
  private acceptDuplicate(run: Run, frame: Extract<CoworkNativeMuxFrame, { class: "bootstrap" }>): void { try { run.upSeq.accept(frame, "up"); } catch { run.duplicateSeqAnomaly = true; /* recorded, otherwise ignored: the first runtime_ready stands */ } }
  /** True when a duplicate `runtime_ready` carried a wrong up-sequence number: the frame was ignored (no power, admission or ownership change) but the anomaly is kept for diagnostics. */
  duplicateReadySeqAnomaly(workspaceId: string): boolean | undefined { return this.runs.get(workspaceId)?.duplicateSeqAnomaly; }
  /** Runtime frames the guest sent that broke the contract and were dropped (diagnostics and tests). */
  runtimeViolations(workspaceId: string): number | undefined { return this.runs.get(workspaceId)?.runtime?.violations; }
  /** The up-direction bootstrap sequence number the host expects next for a workspace it runs (diagnostics and tests). */
  nextBootstrapUpSequence(workspaceId: string): number | undefined { return this.runs.get(workspaceId)?.upSeq.nextExpected("bootstrap", "up"); }

  /** The L1 `shares` line. Every directory is opened here with O_NOFOLLOW|O_DIRECTORY from a canonical path (the realpath must equal the path), described by its own
   *  descriptor (device, inode), sent, and closed: the launcher owns its copies. A share that cannot be opened as exactly that directory refuses the start. */
  private sendShares(run: Run, session: CoworkLauncherSession): readonly CoworkNativeHostShare[] {
    const wanted = run.request?.shares?.() ?? null;
    if (wanted === null || wanted.length === 0) return [];
    const opener = this.deps.shareDirectories;
    if (opener === undefined) throw new CoworkNativeHostError("prepare_failed", "no share directory opener");
    const handles: { readonly fd: number; close(): void }[] = [];
    try {
      const records: CoworkNativeShareRecord[] = wanted.map(share => {
        let handle: ReturnType<typeof opener.open>;
        try { handle = opener.open(share.hostPath); } catch (error) { throw new CoworkNativeHostError("prepare_failed", "a share could not be opened", { cause: error }); }
        handles.push(handle);
        return { tag: share.tag, kind: share.kind, mode: share.readOnly ? "ro" : "rw", device: handle.device, inode: handle.inode, path: share.hostPath, guestPath: share.guestPath };
      });
      const id = `req-${this.uuid()}`.slice(0, 63);
      try { session.send({ t: "shares", id, shares: records }, handles.map(handle => handle.fd)); } catch (error) { throw new CoworkNativeHostError("prepare_failed", error instanceof Error ? error.name : "shares refused", { cause: error }); }
      return Object.freeze([...wanted]);
    } finally { for (const handle of handles) { try { handle.close(); } catch { /* already closed */ } } }
  }

  /** After `mounted`, before the set: the bootstrap `shares` (what the guest must find), then `shares_mounted` (or a fault), then the request's `sharesMounted` with each mounted
   *  FOLDER source mapped from its tag. A throw there is the bootstrap fault `share_mount_failed`: the start fails and the stop that follows is orderly. */
  private async deliverShares(run: Run, context: CoworkNativeConversationContext, operationId: string, nonce: string): Promise<void> {
    if (run.shares.length === 0) return;
    const guestShares: CoworkNativeGuestShare[] = run.shares.map(share => ({ tag: share.tag, guestPath: share.guestPath, readOnly: share.readOnly, kind: share.kind }));
    this.sendBootstrap(run, { t: "shares", operationId, nonce, shares: guestShares });
    const reply = await run.inbox!.expect(item => item.t === "mux_up" && item.frame.class === "bootstrap" && (item.frame.message.t === "shares_mounted" || item.frame.message.t === "fault") ? item.frame : undefined, this.timeouts.mountedMs, "shares_mounted");
    run.upSeq.accept(reply, "up");
    const answer = (reply as Extract<CoworkNativeMuxFrame, { class: "bootstrap" }>).message;
    if (answer.t === "fault") throw new CoworkNativeHostError("guest_fault", answer.code);
    if (answer.t !== "shares_mounted" || answer.operationId !== operationId || answer.nonce !== nonce) throw new CoworkNativeHostError("protocol", "shares_mounted does not answer these shares");
    this.hook("shares-mounted");
    const mounted = run.shares.flatMap(share => share.kind === "folder" && share.sourceId !== undefined && share.revision !== undefined ? [{ sourceId: share.sourceId, revision: share.revision }] : []);
    if (mounted.length === 0 || run.request?.sharesMounted === undefined) return;
    try { run.request.sharesMounted(context, mounted); } catch (error) {
      if (isCrash(error)) throw error;
      throw new CoworkNativeHostError("guest_fault", "share_mount_failed", { cause: error });
    }
  }

  /** What the host adds to a set before it is bound and sent: the resume record on each host-query runtime, the outputs directory a conversation names, and the plan view's
   *  epoch rule. A refusal here means nothing was sent. */
  private prepareSet(run: Run, context: CoworkNativeConversationContext, set: CoworkNativeConversationSet): CoworkNativeConversationSet {
    const resume = run.request?.resume;
    const conversations = set.conversations.map(item => {
      if (resume !== undefined && item.runtime !== null) return { ...item, runtime: { ...item.runtime, continuation: resume.continuation, endedGuestBoots: [...resume.endedGuestBoots] } };
      return item;
    });
    for (const item of conversations) {
      for (const root of item.roots) {
        if (root.guestPath === `/workspace/outputs/${item.logicalSessionId}` && this.deps.outputs !== undefined) {
          try { this.deps.outputs.ensure(context.workspaceId, item.logicalSessionId); } catch (error) { throw new CoworkNativeHostError("prepare_failed", error instanceof CoworkGuestDirectoryError ? error.code : "outputs directory", { cause: error }); }
        }
        const plan = parseCoworkPlanView(root.guestPath);
        if (plan !== null) {
          try { this.planEpochs.admit(context.workspaceId, plan.logicalSessionId, plan.epoch); } catch (error) { throw new CoworkNativeHostError("protocol", error instanceof CoworkGuestDirectoryError ? error.code : "plan epoch", { cause: error }); }
        }
      }
    }
    return { profile: set.profile, conversations };
  }

  /** Contract 6.1: the conversation set goes out ONCE, after `mounted`, bound to the plan's operation and nonce; `running` waits for `runtime_ready`.
   * A refusal to bind or to serialize means nothing was sent. A bootstrap fault, a wrong echo or a wrong count fails the start (and the stop that follows is orderly). */
  private async deliverConversations(run: Run, context: CoworkNativeConversationContext, operationId: string, nonce: string): Promise<void> {
    const source = run.request?.conversations ?? this.deps.conversations;
    const built = source?.(context) ?? null;
    if (built === null) return;
    const set = this.prepareSet(run, context, built);
    // `browseUid` is null until the file channel is routed (FC5); contract revision 3.
    const message = { t: "conversations" as const, operationId, nonce, incarnationId: context.incarnationId, profile: set.profile, browseUid: null, conversations: set.conversations };
    if (set.profile !== null && set.conversations.length !== 1) throw new CoworkNativeHostError("protocol", "a host-query profile carries exactly one conversation");
    if (!coworkNativeConversationsAreBound(message, { operationId, nonce, workspaceId: context.workspaceId, incarnationId: context.incarnationId, leaseEpoch: context.leaseEpoch, guestBootId: context.guestBootId })) throw new CoworkNativeHostError("protocol", "conversation set is not bound to this incarnation");
    run.downSeq += 1;
    // The strict serializer refuses an oversized or malformed set before anything is sent (a throw leaves the sequence number used, and the start fails).
    const frame = { class: "bootstrap" as const, seq: run.downSeq, message };
    try { serializeCoworkNativeMuxFrame(frame, "down"); } catch { throw new CoworkNativeHostError("protocol", "conversation set refused by the contract"); }
    // The runtime class exists from the moment the set goes out, so no frame the guest sends right after `runtime_ready` can fall between two steps.
    if (set.profile !== null) run.runtime = new RuntimeEnd(set.conversations.length);
    run.session!.send({ t: "mux_down", frame });
    run.conversationsSent = true;
    this.hook("conversations-sent");
    const reply = await run.inbox!.expect(item => item.t === "mux_up" && item.frame.class === "bootstrap" && (item.frame.message.t === "runtime_ready" || item.frame.message.t === "fault") ? item.frame : undefined, this.timeouts.runtimeReadyMs, "runtime_ready");
    run.upSeq.accept(reply, "up");
    run.readyAccepted = true;
    for (const frame of run.pendingDuplicates.splice(0)) this.acceptDuplicate(run, frame);
    const answer = (reply as Extract<CoworkNativeMuxFrame, { class: "bootstrap" }>).message;
    if (answer.t === "fault") {
      // The guest's own store is gone (a `resume` it could not find): the conversation can neither resume nor start fresh under its identity. The other cold-resume
      // fault, `fresh_store_not_empty`, is a refusal only: a store exists, so nothing is lost.
      // Only a `resume` we sent can find a store missing; for any other continuation the fault is a contract violation, not a lost store.
      if (answer.code === "resume_store_missing" && !set.conversations.some(item => item.runtime?.continuation === "resume")) throw new CoworkNativeHostError("protocol", "resume_store_missing without a resume");
      if (answer.code === "resume_store_missing") { try { run.request?.storeLost?.("resume_store_missing"); } catch { /* the failed start stands either way */ } }
      throw new CoworkNativeHostError("guest_fault", answer.code);
    }
    if (answer.t !== "runtime_ready" || answer.operationId !== operationId || answer.nonce !== nonce || answer.conversations !== set.conversations.length) throw new CoworkNativeHostError("protocol", "runtime_ready does not answer this set");
    // The continuation echo (contract 12.2): one entry per host-query conversation, and the guest never runs one differently from what the host decided
    // (`either` is the guest's own choice between the two).
    const sent = set.conversations.flatMap(item => item.runtime === null ? [] : [item.runtime.continuation]);
    if (answer.continuations.length !== sent.length || answer.continuations.some((ran, index) => sent[index] !== "either" && sent[index] !== ran)) throw new CoworkNativeHostError("protocol", "the guest's continuation does not match the set");
    run.continuations = answer.continuations;
    this.hook("runtime-ready");
  }

  // ===================================================================================================== runtime class (conversation 0)

  /** Up (guest to host) runtime frames, before the inbox's sealed filter ever sees them. A frame outside the contract (an IN frame from the guest, a wrong sequence, a second end, a frame before the runtime exists) is counted and dropped, never delivered. */
  private onRuntimeUp(run: Run, frame: Extract<CoworkNativeMuxFrame, { class: "runtime" }>): void {
    const end = run.runtime;
    if (end === null || end.closed) return;
    // Contract 6.2: runtime frames are delivered only after `runtime_ready`. `readySeen` is set synchronously when that frame arrives (before it is validated: a
    // runtime_ready that does not answer the set fails the start), so a frame sent right behind it is not mistaken for an early one.
    if (!run.readySeen) { try { run.upSeq.accept(frame, "up"); } catch { /* a bad sequence number is a violation too */ } end.violations += 1; return; }
    try {
      if (frame.stream === "in") throw new CoworkNativeHostError("protocol", "the guest sent an IN frame");
      run.upSeq.accept(frame, "up");
      end.streams.accept(frame);
    } catch (error) { if (isCrash(error)) throw error; end.violations += 1; return; }
    if (!end.everSubscribed) {
      if (end.overflowed) return;
      if (end.heldBytes + frame.payload.length > RUNTIME_PRESUBSCRIBE_BYTES) {
        // A gap is never silent. Dropping this frame while a later, smaller one is still held would hand the first subscriber bytes with a hole in the middle, so the
        // overflow ends the incarnation instead: nothing more is held or delivered, what is held is discarded, and the run is stopped as a contract violation.
        end.overflowed = true; end.violations += 1; end.held.length = 0; end.heldBytes = 0;
        // Closed for good: a subscriber that attaches during the stop that follows must not receive later frames after bytes were dropped.
        end.close();
        if (run.phase === "running") void this.stop(run.key.workspaceId, "shutdown").catch(() => {}); else run.overflowStop = true;
        return;
      }
      end.held.push({ stream: frame.stream as "out" | "err", bytes: frame.payload, end: frame.end }); end.heldBytes += frame.payload.length;
    }
    for (const handler of [...end.handlers]) { try { handler(frame.stream as "out" | "err", frame.payload, frame.end); } catch { /* a consumer's fault is not the guest's */ } }
    end.wake();
  }
  private runtimeLink(run: Run, conversation: 0): CoworkNativeRuntimeLink {
    const end = run.runtime;
    if (conversation !== 0 || end === null) throw new CoworkNativeHostError("not_running", "this incarnation has no runtime conversation");
    return Object.freeze({
      send: (bytes: Uint8Array, last = false) => this.sendRuntime(run, end, bytes, last),
      onData: (handler: (stream: "out" | "err", bytes: Uint8Array, end: boolean) => void) => {
        // An overflowed or closed stream delivers nothing to anyone, however late they attach.
        if (end.overflowed || end.closed) return () => {};
        end.handlers.add(handler);
        if (!end.everSubscribed) {
          end.everSubscribed = true;
          for (const frame of end.held.splice(0)) { try { handler(frame.stream, frame.bytes, frame.end); } catch { /* a consumer's fault is not the guest's */ } }
          end.heldBytes = 0;
        }
        return () => { end.handlers.delete(handler); };
      },
      ended: run.ended,
    });
  }
  private async sendRuntime(run: Run, end: RuntimeEnd, bytes: Uint8Array, last: boolean): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new CoworkNativeHostError("protocol", "runtime bytes must be a Uint8Array");
    if (end.overflowed || end.closed) throw new CoworkNativeHostError("closed", "the runtime stream ended");
    if (bytes.length === 0 && !last) return;
    for (let offset = 0; offset < bytes.length || (bytes.length === 0 && offset === 0); offset += RUNTIME_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + RUNTIME_CHUNK_BYTES), final = last && offset + RUNTIME_CHUNK_BYTES >= bytes.length;
      await this.waitRuntimeBudget(run, end, chunk.length);
      if (run.phase !== "running" || end.closed) throw new CoworkNativeHostError("closed", "the run ended");
      end.downSeq += 1;
      const frame = { class: "runtime" as const, seq: end.downSeq, conversation: 0, stream: "in" as const, end: final, payload: Uint8Array.from(chunk) };
      end.streams.accept(frame);
      run.session!.send({ t: "mux_down", frame });
      if (bytes.length === 0) break;
    }
  }
  /** IN bytes the guest has not answered stay within the contract's budget: wait until an OUT or ERR frame with payload shows it is reading. */
  private async waitRuntimeBudget(run: Run, end: RuntimeEnd, needed: number): Promise<void> {
    while (end.streams.inFlightBudget < needed) {
      if (run.phase !== "running" || end.closed) throw new CoworkNativeHostError("closed", "the run ended");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { const at = end.waiters.indexOf(waiter); if (at >= 0) end.waiters.splice(at, 1); reject(new CoworkNativeHostError("timeout", "the guest did not read the runtime stream")); }, this.timeouts.runtimeStallMs);
        const waiter = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (error: unknown) => { clearTimeout(timer); reject(error); } };
        end.waiters.push(waiter);
      });
    }
  }

  /** Move the admission to `to` from whatever state it REALLY is in. A row the ledger marked `uncertain` only because the heartbeat lapsed is
   * revived by a heartbeat first (the ledger restores its accounting phase); a harder `uncertain` is left to the transitions the ledger allows. */
  private moveAdmission(run: Run, to: "booting" | "running" | "draining"): void {
    const { admission } = this.deps, daemon = this.deps.daemon();
    let record = admission.get(run.admissionId!);
    if (record.state === "uncertain" && record.heartbeatResumeState !== null) record = admission.heartbeat(run.admissionId!, daemon);
    if (record.state === to) return;
    admission.transition(run.admissionId!, daemon, record.state, to);
  }
  /** The admission ledger treats a silent owner as lost after its heartbeat timeout (30 s by default): beat from the reserve until the run is disposed. */
  private startHeartbeat(run: Run): void {
    const every = this.deps.timers?.every ?? ((ms: number, fn: () => void) => { const timer = setInterval(fn, ms); (timer as { unref?: () => void }).unref?.(); return () => clearInterval(timer); });
    run.stopHeartbeat = every(this.timeouts.heartbeatMs, () => {
      if (run.phase === "dead" || run.admissionId === null) return;
      try { this.deps.admission.heartbeat(run.admissionId, this.deps.daemon()); } catch (error) {
        // A released or unknown row has nothing left to keep alive; anything else is retried at the next beat.
        const code = (error as { code?: unknown }).code;
        if (code === "transition_refused" || code === "not_found") { run.stopHeartbeat?.(); run.stopHeartbeat = null; }
      }
    });
  }
  /** `launcher.spawn` with a deadline. A session that arrives after it is closed: the host has already given up on that launch. */
  private spawnWithin(run: Run, spawn: () => Promise<CoworkLauncherSession>): Promise<CoworkLauncherSession> {
    return new Promise<CoworkLauncherSession>((resolve, reject) => {
      const timer = setTimeout(() => { late = true; reject(new CoworkNativeHostError("timeout", "launcher spawn")); }, this.timeouts.spawnMs);
      let late = false;
      spawn().then(session => { clearTimeout(timer); if (late) { try { session.close(); } catch { /* gone */ } } else resolve(session); }, error => { clearTimeout(timer); if (!late) reject(error); });
      void run;
    });
  }

  private sendBootstrap(run: Run, message: Extract<CoworkNativeMuxFrame, { class: "bootstrap" }>["message"]): void {
    run.downSeq += 1;
    run.session!.send({ t: "mux_down", frame: { class: "bootstrap", seq: run.downSeq, message } });
  }

  // ===================================================================================================== failure and monitoring

  /** A start that failed after `beginIncarnation`. Never throws (the original error is the one reported). */
  private async failStart(run: Run, _original: unknown): Promise<void> {
    try {
      const { power } = this.deps;
      const volumes = this.deps.volumes.records(run.key.workspaceId);
      const claimed = volumes.some(v => v.owner !== null);
      if (run.session?.isLive() === true && run.inbox) {
        const outcome = await this.requestStop(run, "failed-start");
        if (outcome.released) return;
      } else if (run.admissionId === null && !claimed) {
        // Nothing but the incarnation bump happened: no admission, no launcher, no claim. Back to stopped.
        power.transition(run.key, "starting", "stopped", mintVolumesFreeToken({ ...run.key, volumes: this.deps.volumes }));
        return;
      }
      this.markUncertain(run, "start failed before an orderly stop was proved");
    } catch (error) {
      if (isCrash(error)) throw error;
      try { this.markUncertain(run, `start cleanup failed (${describeNativeError(error)})`); } catch (inner) { if (isCrash(inner)) throw inner; }
    } finally {
      this.dispose(run);
    }
  }

  /** After a successful start: an unsolicited terminal message or a closed channel makes the workspace uncertain. Nothing here releases. */
  private watch(run: Run): void {
    const session = run.session!;
    run.unsubscribe.push(session.onMessage(message => {
      if (run.phase !== "running") return;
      if (message.t === "uncertain") this.handleUncertain(run, `launcher reported ${(message.receipt as CoworkNativeUncertainReceipt).reason}`);
      else if (message.t === "fault") this.handleUncertain(run, `launcher fault ${message.code}`);
      else if (message.t === "stopped") this.handleUncertain(run, "stop reported that this host did not request");
    }));
    run.unsubscribe.push(session.onClose(() => { if (run.phase === "running") this.handleUncertain(run, "launcher channel ended"); }));
  }
  private handleUncertain(run: Run, reason: string): void {
    run.outcome ??= { released: false, reason };
    try { this.markUncertain(run, reason); } catch (error) { if (isCrash(error)) throw error; }
    this.dispose(run);
  }
  /** Power and admission to `uncertain`; the volumes keep their owner. Idempotent. */
  private markUncertain(run: Run, reason: string): void {
    const { power, admission } = this.deps;
    try { power.markUncertain(run.key); } catch (error) { if (!(error instanceof CoworkNativePowerError)) throw error; }
    if (run.admissionId !== null) {
      try {
        const record = admission.get(run.admissionId);
        if (record.state !== "uncertain" && record.state !== "released") admission.transition(run.admissionId, record.owner, record.state, "uncertain");
      } catch (error) {
        // The ledger's own reconcile marks a dead owner uncertain; a live owner we cannot transition stays as accounted.
        if (isCrash(error)) throw error;
      }
    }
    for (const handler of this.uncertainHandlers) handler({ workspaceId: run.key.workspaceId, incarnationId: run.key.incarnationId, leaseEpoch: run.key.leaseEpoch, reason });
  }
  private dispose(run: Run): void {
    if (run.phase === "dead") return;
    run.phase = "dead";
    run.runtime?.close();
    run.endedResolve(run.outcome ?? { released: false, reason: "the run ended without a stop outcome" });
    run.stopHeartbeat?.(); run.stopHeartbeat = null;
    run.unsubscribe.splice(0).forEach(off => off());
    run.binding?.close(); run.inbox?.close();
    try { run.session?.close(); } catch { /* already closed */ }
    if (this.runs.get(run.key.workspaceId) === run) this.runs.delete(run.key.workspaceId);
  }

  // ===================================================================================================== stop

  async stop(workspaceId: string, reason: "user" | "shutdown" | "restart" | "update" = "user"): Promise<CoworkNativeStopOutcome> {
    const run = this.runs.get(workspaceId);
    if (!run || run.phase !== "running") throw new CoworkNativeHostError("not_running");
    run.phase = "stopping";
    try {
      // The stop request goes out whatever the bookkeeping says: an admission that lapsed to `uncertain` (a missed heartbeat) or a power state that
      // moved under us must not keep a healthy guest from being drained. Both moves read the REAL state and are best effort here; the release
      // flow settles whatever they leave.
      try { this.moveAdmission(run, "draining"); } catch (error) { if (isCrash(error)) throw error; }
      try {
        const power = this.deps.power.read(workspaceId).power;
        if (power === "running" || power === "uncertain") this.deps.power.transition(run.key, power, "draining");
      } catch (error) { if (isCrash(error)) throw error; }
      this.hook("drain-requested");
      const outcome = await this.requestStop(run, reason);
      run.outcome = outcome;
      if (!outcome.released) this.markUncertain(run, outcome.reason);
      return outcome;
    } finally { this.dispose(run); }
  }

  /** Send `stop` with a fresh nonce and wait for the launcher's verdict. Released only by a valid orderly receipt for THIS nonce. */
  private async requestStop(run: Run, reason: "user" | "shutdown" | "restart" | "update" | "failed-start"): Promise<CoworkNativeStopOutcome> {
    const session = run.session!, inbox = run.inbox!, id = `req-${this.uuid()}`.slice(0, 63), stopNonce = this.nonce();
    run.phase = run.phase === "starting" ? "starting" : "stopping";
    try { session.send({ t: "stop", id, stopNonce, reason, budgetMs: this.timeouts.drainBudgetMs }); } catch { return { released: false, reason: "launcher channel closed before the stop request" }; }
    let verdict: CoworkNativeToDaemon;
    try {
      verdict = await inbox.expect(message => (message.t === "stopped" && message.id === id) || message.t === "uncertain" || message.t === "fault" ? message : undefined, this.timeouts.drainBudgetMs + this.timeouts.exitAllowanceMs + this.timeouts.stopGraceMs, "stop verdict");
    } catch (error) {
      if (isCrash(error)) throw error;
      return { released: false, reason: error instanceof CoworkNativeHostError ? `no orderly stop receipt (${error.code})` : "no orderly stop receipt" };
    }
    this.hook("stop-receipt-received");
    if (verdict.t !== "stopped") return { released: false, reason: verdict.t === "uncertain" ? `launcher reported ${(verdict.receipt as CoworkNativeUncertainReceipt).reason}` : "launcher fault" };
    const volumes = this.deps.volumes.records(run.key.workspaceId);
    let proof;
    try {
      // A stop answered before any claim (a start that failed early) finds the volumes free: the receipt then attests nothing attached.
      const record = run.admissionId === null ? null : this.deps.admission.get(run.admissionId);
      proof = mintOrderlyStopProof({ receipt: verdict.receipt, owner: run.owner, homeId: run.homeId, admission: record === null ? null : { admissionId: record.admissionId, owner: { bootId: record.owner.bootId } }, volumes, volumesReleased: volumes.every(v => v.owner === null),
        source: { kind: "live", stopNonce, launcherInstanceId: session.launcherInstanceId, observed: { ...run.observed } as CoworkNativeObserved }, registry: this.deps.registry, now: this.now });
    } catch (error) {
      if (error instanceof CoworkNativeStopEvidenceError) return { released: false, reason: `stop receipt refused (${error.code})` };
      throw error;
    }
    let retired: boolean;
    try { ({ retired } = this.deps.recovery.release(run.key, run.owner, run.homeId, proof)); } catch (error) {
      if (isCrash(error)) throw error;
      // Part of the release may have happened; the records say how much, and the next recovery finishes from them.
      return { released: false, reason: `release incomplete (${describeNativeError(error)})` };
    }
    // Only when nothing still needs it: a replay debt keeps the receipt, so the launcher must keep it too.
    if (retired) { try { session.send({ t: "receipt_retire", confirmationId: proof.confirmationId }); } catch { /* the channel may be gone; the durable store retires it on the next recovery */ } }
    return { released: true, evidence: proof.kind };
  }
}

function identityOf(volume: CoworkVolumeRecord): CoworkNativeVolumeIdentity {
  const identity = volume.identity;
  if (!identity) throw new CoworkNativeHostError("not_allocated", "volume has no recorded identity");
  return { purpose: volume.purpose, device: identity.device, inode: identity.inode, uid: identity.uid, mode: identity.mode, capacityBytes: volume.capacityBytes };
}
export type { VolumeFilesystemPlan };
