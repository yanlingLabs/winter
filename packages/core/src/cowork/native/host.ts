import { randomBytes, randomUUID } from "node:crypto";
import type { AdmissionOwner, CoworkAdmissionLedger } from "../admission";
import type { CoworkRepository } from "../repository";
import type { CoworkVolumeOwner, CoworkVolumeRecord, CoworkVolumeRequest, CoworkVolumes } from "../volumes";
import type { VolumeFilesystemPlan, VolumeFilesystemReceipt } from "../volume-filesystem";
import { CoworkNativeAuthority, type CoworkNativeChannelBinding, type CoworkNativeLink } from "./authority";
import { CoworkNativeMuxSequence, COWORK_NATIVE_LIMITS, coworkNativeScopeDigest, sortedCanonical, type CoworkNativeMuxFrame, type CoworkNativeScope, type CoworkNativeToDaemon, type CoworkNativeToLauncher, type CoworkNativeUncertainReceipt, type CoworkNativeVolumeIdentity } from "./protocol";
import { CoworkNativePower, CoworkNativePowerError, type CoworkPowerKey } from "./power";
import { CoworkNativeRecovery, type CoworkNativeRecoveryReport } from "./recovery";
import { CoworkNativeStopEvidenceError, mintControllerInstanceId, mintVolumesFreeToken, mintOrderlyStopProof, type CoworkNativeEvidenceKind, type CoworkNativeHostBoot, type CoworkNativeStopRegistry } from "./stop-proof";

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

/** Thrown by a test's `checkpoint` hook to stand for the process dying at that point. The host never catches it. */
export class CoworkNativeSimulatedCrash extends Error { constructor(readonly phase: string) { super(`simulated crash at ${phase}`); this.name = "CoworkNativeSimulatedCrash"; } }

export type CoworkNativeHostFailure = "busy" | "not_stopped" | "not_allocated" | "owner_held" | "bad_image_digest" | "bad_boot" | "launcher_refused" | "protocol" | "timeout" | "guest_fault" | "start_failed" | "not_running" | "closed";
export class CoworkNativeHostError extends Error {
  constructor(readonly code: CoworkNativeHostFailure, readonly detail?: string, options?: { cause?: unknown }) { super(detail ? `${code}: ${detail}` : code, options); this.name = "CoworkNativeHostError"; }
}

/** A launcher process the port has ALREADY spawned and verified (code identity, parent/child relationship) and whose first line
 * (`hello`) it has already read. The host never reads a socket; it only sees typed messages. */
export interface CoworkLauncherSession extends CoworkNativeLink {
  readonly launcherInstanceId: string;
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

export interface CoworkNativeHostTimeouts { readonly begunMs: number; readonly volumesMs: number; readonly guestHelloMs: number; readonly receiptMs: number; readonly mountedMs: number; readonly stopGraceMs: number; readonly drainBudgetMs: number }
const DEFAULT_TIMEOUTS: CoworkNativeHostTimeouts = Object.freeze({ begunMs: 15_000, volumesMs: 15_000, guestHelloMs: 90_000, receiptMs: 180_000, mountedMs: 60_000, stopGraceMs: 10_000, drainBudgetMs: COWORK_NATIVE_LIMITS.drainBudgetMs });

export interface CoworkNativeHostDeps {
  readonly records: CoworkRepository; readonly volumes: CoworkVolumes; readonly admission: CoworkAdmissionLedger; readonly authority: CoworkNativeAuthority;
  readonly power: CoworkNativePower; readonly recovery: CoworkNativeRecovery; readonly registry: CoworkNativeStopRegistry; readonly hostBoot: CoworkNativeHostBoot;
  readonly launcher: CoworkLauncherPort; readonly images: CoworkNativeImagePins;
  /** This daemon process as the admission ledger knows it (pid, start token, boot id, instance nonce). */
  readonly daemon: () => AdmissionOwner;
  readonly timeouts?: Partial<CoworkNativeHostTimeouts>; readonly memoryMiB?: number;
  readonly now?: () => number;
  /** Isolated crash/fault testing only, never serialized or supplied by an RPC. A throw stands for the process dying there. */
  readonly checkpoint?: (phase: string) => void;
  /** Test seams for deterministic ids and nonces. */
  readonly mint?: { uuid?: () => string; nonce?: () => string; suffix?: () => string };
}

export type CoworkNativeStopOutcome =
  | { readonly released: true; readonly evidence: CoworkNativeEvidenceKind }
  | { readonly released: false; readonly reason: string };
export interface CoworkNativeRunning {
  readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly admissionId: string; readonly owner: CoworkVolumeOwner;
  stop(reason?: "user" | "shutdown" | "restart" | "update"): Promise<CoworkNativeStopOutcome>;
}
export interface CoworkNativeUncertainEvent { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly reason: string }

type RunPhase = "starting" | "running" | "stopping" | "dead";
interface Run {
  readonly key: CoworkPowerKey; readonly owner: CoworkVolumeOwner; readonly homeId: string;
  admissionId: string | null; session: CoworkLauncherSession | null; binding: CoworkNativeChannelBinding | null; inbox: SessionInbox | null;
  phase: RunPhase; unsubscribe: (() => void)[]; downSeq: number; upSeq: CoworkNativeMuxSequence;
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
  private push(message: CoworkNativeToDaemon): void {
    for (const [index, waiter] of this.waiters.entries()) {
      const picked = waiter.pick(message);
      if (picked !== undefined) { this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(picked); return; }
    }
    this.queue.push(message);
  }
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
  private readonly timeouts: CoworkNativeHostTimeouts;
  private readonly uncertainHandlers: ((event: CoworkNativeUncertainEvent) => void)[] = [];
  private readonly now: () => number;
  constructor(private readonly deps: CoworkNativeHostDeps) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
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

  /** Daemon start: delegates to recovery (the ledger's own reconcile, then every workspace that is not stopped). */
  bootReconcile(): CoworkNativeRecoveryReport[] { return this.deps.recovery.bootReconcile(new Set(this.runs.keys())); }
  /** One workspace, optionally with the owner's explicit recover input. Refused while this process runs it. */
  recover(workspaceId: string, options: { ownerRecover?: boolean } = {}): CoworkNativeRecoveryReport {
    if (this.runs.has(workspaceId)) throw new CoworkNativeHostError("busy", "workspace has a live run");
    return this.deps.recovery.recover(workspaceId, options);
  }

  // ===================================================================================================== start

  async start(workspaceId: string): Promise<CoworkNativeRunning> {
    if (this.runs.has(workspaceId)) throw new CoworkNativeHostError("busy");
    const { records, volumes } = this.deps;
    const workspace = records.get(workspaceId);
    if (workspace.state !== "retained" || workspace.power !== "stopped") throw new CoworkNativeHostError("not_stopped");
    const before = volumes.records(workspaceId);
    if (before.length !== 2 || before.some(v => v.state !== "allocated")) throw new CoworkNativeHostError("not_allocated");
    if (before.some(v => v.owner !== null)) throw new CoworkNativeHostError("owner_held", "a previous owner still holds the volumes; recover first");
    const runtimeImageDigest = this.deps.images.runtimeImageDigest(workspaceId);
    if (typeof runtimeImageDigest !== "string" || !/^[a-f0-9]{64}$/.test(runtimeImageDigest)) throw new CoworkNativeHostError("bad_image_digest");
    const bootId = this.deps.hostBoot.bootId(), daemon = this.deps.daemon();
    if (daemon.bootId !== bootId) throw new CoworkNativeHostError("bad_boot", "daemon identity is from another boot");

    const homeId = records.recordedHomeIdentity(), incarnationId = `inc-${this.uuid()}`;
    const epoch = records.beginIncarnation(workspaceId, incarnationId, workspace.configRevision);
    const owner: CoworkVolumeOwner = { controllerInstanceId: mintControllerInstanceId(bootId, this.suffix()), workerInstanceId: `wrk-${this.uuid()}`, incarnationId, leaseEpoch: epoch.leaseEpoch, runtimeImageDigest };
    const run: Run = { key: { workspaceId, incarnationId, leaseEpoch: epoch.leaseEpoch }, owner, homeId, admissionId: null, session: null, binding: null, inbox: null, phase: "starting", unsubscribe: [], downSeq: 0, upSeq: new CoworkNativeMuxSequence() };
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
    this.hook("power-running");
    this.watch(run);
    return Object.freeze({ workspaceId, incarnationId, leaseEpoch: epoch.leaseEpoch, admissionId: run.admissionId!, owner, stop: (reason: "user" | "shutdown" | "restart" | "update" = "user") => this.stop(workspaceId, reason) });
  }

  private async launch(run: Run): Promise<void> {
    const { volumes, admission, authority, launcher } = this.deps;
    const { workspaceId, incarnationId, leaseEpoch } = run.key, owner = run.owner, memoryMiB = this.deps.memoryMiB ?? 768;
    const scope: CoworkNativeScope = { workspaceId, incarnationId, leaseEpoch, admissionId: "", controllerInstanceId: owner.controllerInstanceId, workerInstanceId: owner.workerInstanceId, runtimeImageDigest: owner.runtimeImageDigest, vcpus: COWORK_NATIVE_LIMITS.vcpus, memoryMiB };

    // 1. admission reserve
    const reserved = admission.reserve({ requestId: `req-${incarnationId}`, homeId: run.homeId, owner: this.deps.daemon(), workspaceId, incarnationId, leaseEpoch, commitment: { memoryBytes: memoryMiB * 1024 * 1024, cpuUnits: COWORK_NATIVE_LIMITS.vcpus } });
    run.admissionId = reserved.admissionId;
    this.hook("admission-reserved");

    // 2. launcher spawn (verified and hello'd by the port)
    const session = await launcher.spawn({ workspaceId, incarnationId, leaseEpoch });
    run.session = session;
    this.hook("launcher-spawned");
    if (session.hostBootId !== this.deps.hostBoot.bootId()) throw new CoworkNativeHostError("bad_boot", "launcher reports another boot");
    run.inbox = new SessionInbox(session);
    const binding = authority.adopt(session, { workspaceId, homeId: run.homeId, admissionId: reserved.admissionId, owner });
    run.binding = binding;
    admission.transition(reserved.admissionId, this.deps.daemon(), "reserved", "booting");

    // 3. begin: the worker is spawned suspended, validated, sandboxed
    const full: CoworkNativeScope = { ...scope, admissionId: reserved.admissionId };
    const begin = `req-${this.uuid()}`.slice(0, 63);
    session.send({ t: "begin", id: begin, ...full });
    await run.inbox.expect(message => message.t === "begun" && message.id === begin ? message : message.t === "refused" && message.id === begin ? message : undefined, this.timeouts.begunMs, "begun")
      .then(message => { if (message.t === "refused") throw new CoworkNativeHostError("launcher_refused", message.code); if (message.t !== "begun" || message.workerInstanceId !== owner.workerInstanceId) throw new CoworkNativeHostError("protocol", "begun names another worker"); });
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
        .then(message => { if (message.t === "refused") throw new CoworkNativeHostError("launcher_refused", message.code); });
    } finally {
      // The worker holds its own copies now (or never will). Closing ours is cleanup, never a release.
      handles.forEach(handle => handle.close());
    }
    binding.advance("attached");
    this.hook("transferred");

    // 5. bootstrap: hello, plan(nonce), receipt, confirm
    const hello = await run.inbox.expect(message => message.t === "mux_up" && message.frame.class === "bootstrap" && message.frame.message.t === "hello" ? message.frame : undefined, this.timeouts.guestHelloMs, "guest hello");
    run.upSeq.accept(hello, "up");
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
    run.upSeq.accept(mounted, "up");
    binding.advance("ready");
    this.deps.power.transition(run.key, "starting", "running");
    admission.transition(reserved.admissionId, this.deps.daemon(), "booting", "running");
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
        power.transition(run.key, "starting", "stopped", mintVolumesFreeToken({ ...run.key, volumes }));
        return;
      }
      this.markUncertain(run, "start failed before an orderly stop was proved");
    } catch (error) {
      if (isCrash(error)) throw error;
      try { this.markUncertain(run, `start cleanup failed (${describe(error)})`); } catch (inner) { if (isCrash(inner)) throw inner; }
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
    const { power, admission } = this.deps;
    power.transition(run.key, "running", "draining");
    admission.transition(run.admissionId!, this.deps.daemon(), "running", "draining");
    this.hook("drain-requested");
    try {
      const outcome = await this.requestStop(run, reason);
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
      verdict = await inbox.expect(message => (message.t === "stopped" && message.id === id) || message.t === "uncertain" || message.t === "fault" ? message : undefined, this.timeouts.drainBudgetMs + this.timeouts.stopGraceMs, "stop verdict");
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
      proof = mintOrderlyStopProof({ receipt: verdict.receipt, owner: run.owner, homeId: run.homeId, admissionId: run.admissionId, volumes, volumesReleased: volumes.every(v => v.owner === null), source: { kind: "live", stopNonce }, registry: this.deps.registry, now: this.now });
    } catch (error) {
      if (error instanceof CoworkNativeStopEvidenceError) return { released: false, reason: `stop receipt refused (${error.code})` };
      throw error;
    }
    const admission = run.admissionId === null ? null : this.deps.admission.get(run.admissionId);
    const { retired } = this.deps.recovery.release(run.key, run.owner, volumes, admission, run.homeId, proof);
    // Only when nothing still needs it: a replay debt keeps the receipt, so the launcher must keep it too.
    if (retired) { try { session.send({ t: "receipt_retire", confirmationId: proof.confirmationId }); } catch { /* the channel may be gone; the durable store retires it on the next recovery */ } }
    return { released: true, evidence: proof.kind };
  }
}

/** An error's class and code, nothing else: never a message that could carry a path or a receipt. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? `${error.name}:${code}` : error.name;
}
function identityOf(volume: CoworkVolumeRecord): CoworkNativeVolumeIdentity {
  const identity = volume.identity;
  if (!identity) throw new CoworkNativeHostError("not_allocated", "volume has no recorded identity");
  return { purpose: volume.purpose, device: identity.device, inode: identity.inode, uid: identity.uid, mode: identity.mode, capacityBytes: volume.capacityBytes };
}
export type { VolumeFilesystemPlan };
