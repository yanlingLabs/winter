import { fstatSync } from "node:fs";
import { CoworkNativeSimulatedCrash, type CoworkLauncherPort, type CoworkLauncherSession } from "../../../src/cowork/native/host";
import {
  CoworkNativeMuxSequence, parseCoworkNativeLauncherLine, serializeCoworkNativeLauncherLine, serializeCoworkNativeStopReceipt, COWORK_NATIVE_VOLUME_PURPOSES,
  type CoworkNativeMuxFrame, type CoworkNativeOrderlyReceipt, type CoworkNativeScope, type CoworkNativeToDaemon, type CoworkNativeToLauncher, type CoworkNativeUncertainReceipt, type CoworkNativeVolumeIdentity,
} from "../../../src/cowork/native/protocol";
import { COWORK_EXT4_FEATURES } from "../../../src/cowork/volume-filesystem";

/*
 * A scripted stand-in for the launcher, the worker and the guest, behind the host's launcher port. It speaks the real contract:
 * every message the host sends is serialized and re-parsed through protocol.ts (with its descriptor count), and every reply is
 * built as a typed message and round-tripped the same way, so the host never sees anything the wire could not carry.
 * It starts no process and touches no VM.
 */
export interface FakeBehavior {
  spawn?: "ok" | "fail" | "crash" | "hang" | "slow";
  begin?: "ok" | "refuse" | "silent" | "other-worker";
  volumes?: "ok" | "refuse" | "silent";
  /** Accept the descriptors but say nothing about a VM (no vm_running, no guest hello). */
  quietVm?: boolean;
  /** Unsolicited things the worker says even though it never accepted the descriptors. */
  chatter?: ("vm_running" | "hello")[];
  guestHello?: "ok" | "silent";
  bootstrap?: "ok" | "fault" | "silent" | "wrong-nonce" | "wrong-operation" | "tampered-receipt" | "duplicate-receipt" | "runtime-frame";
  mounted?: "ok" | "silent";
  /** What the guest does with the conversation set: answer, stay silent, fault, echo wrongly, or announce readiness before it was sent anything / twice. */
  conversations?: "ok" | "silent" | "bad" | "supervisor-failed" | "second" | "wrong-count" | "wrong-nonce" | "wrong-operation" | "duplicate-ready" | "late-ready" | "early-ready";
  /** What the launcher does when asked to stop. */
  stop?: "orderly" | "late-orderly" | "uncertain" | "eof" | "silent" | "wrong-nonce" | "bad-invariants" | "other-incarnation" | "wrong-volume" | "fault" | "other-request-id" | "other-launcher" | "denies-attach" | "denies-boot";
  /** Hello with another boot id. */
  helloBoot?: string;
}

interface Received { readonly message: CoworkNativeToLauncher; readonly rights: readonly number[] }
export class FakeLauncher implements CoworkLauncherPort {
  behavior: FakeBehavior;
  readonly sessions: FakeSession[] = [];
  readonly spawned: { workspaceId: string; incarnationId: string; leaseEpoch: number }[] = [];
  constructor(readonly options: { behavior: FakeBehavior; homeId: string; hostBootId: () => string; receipts: Map<string, string>; events: string[] }) { this.behavior = options.behavior; }
  async spawn(request: { workspaceId: string; incarnationId: string; leaseEpoch: number }): Promise<CoworkLauncherSession> {
    this.spawned.push(request);
    if (this.behavior.spawn === "fail") throw new Error("spawn failed");
    if (this.behavior.spawn === "crash") throw new CoworkNativeSimulatedCrash("launcher spawn");
    if (this.behavior.spawn === "hang") return new Promise<CoworkLauncherSession>(() => {});
    if (this.behavior.spawn === "slow") await new Promise(resolve => setTimeout(resolve, 300));
    const session = new FakeSession(this, request);
    this.sessions.push(session);
    return session;
  }
  get last(): FakeSession { return this.sessions[this.sessions.length - 1]!; }
  /** The daemon process died: nothing in it reacts, whatever the sessions were doing. */
  killAll(): void { this.sessions.forEach(session => session.vanish()); }
}

export class FakeSession implements CoworkLauncherSession {
  readonly launcherInstanceId = "launcher-fake0001";
  readonly pid = 5151; readonly startToken = "start-5151";
  vmRunning = false;
  readonly hostBootId: string;
  readonly received: Received[] = [];
  /** What each descriptor looked like WHEN it arrived. */
  readonly arrivals: { dev: string; ino: string; size: number }[][] = [];
  scope: CoworkNativeScope | null = null;
  volumes: readonly CoworkNativeVolumeIdentity[] = [];
  guestBooted = false;
  private live = true;
  private readonly handlers: ((message: CoworkNativeToDaemon) => void)[] = [];
  private readonly closers: (() => void)[] = [];
  private readonly down = new CoworkNativeMuxSequence();
  private upSeq = 0;
  /** Every conversation set the guest received (the host must send at most one). */
  readonly conversationSets: { operationId: string; nonce: string; incarnationId: string; profile: string | null; conversations: readonly unknown[] }[] = [];
  private plan: { operationId: string; nonce: string; plan: Record<string, unknown> } | null = null;
  private confirmCounter = 0;
  constructor(private readonly owner: FakeLauncher, readonly request: { workspaceId: string; incarnationId: string; leaseEpoch: number }) {
    this.hostBootId = owner.behavior.helloBoot ?? owner.options.hostBootId();
  }
  private get behavior(): FakeBehavior { return this.owner.behavior; }
  isLive(): boolean { return this.live; }
  onMessage(handler: (message: CoworkNativeToDaemon) => void): () => void { this.handlers.push(handler); return () => { const at = this.handlers.indexOf(handler); if (at >= 0) this.handlers.splice(at, 1); }; }
  onClose(handler: () => void): () => void { this.closers.push(handler); return () => { const at = this.closers.indexOf(handler); if (at >= 0) this.closers.splice(at, 1); }; }
  close(): void { this.live = false; }
  /** The launcher is gone and NOBODY is told: what a crash of the daemon process looks like from the launcher's side. */
  vanish(): void { this.live = false; }
  /** The channel ends without a word (the launcher died). */
  eof(): void { if (!this.live) return; this.live = false; for (const closer of [...this.closers]) closer(); }

  private deliver(message: CoworkNativeToDaemon): void {
    if (!this.live) return;
    // Round-trip through the real wire form so the host only ever sees what the contract can carry.
    const typed = parseCoworkNativeLauncherLine(serializeCoworkNativeLauncherLine(message, "to-daemon"), "to-daemon", 0) as CoworkNativeToDaemon;
    queueMicrotask(() => { if (this.live) for (const handler of [...this.handlers]) handler(typed); });
  }
  private muxUp(message: Extract<CoworkNativeMuxFrame, { class: "bootstrap" }>["message"]): void {
    this.upSeq += 1;
    this.deliver({ t: "mux_up", frame: { class: "bootstrap", seq: this.upSeq, message } });
  }

  send(message: CoworkNativeToLauncher, rights: readonly number[] = []): void {
    if (!this.live) throw new Error("channel closed");
    // The host's side of the wire, checked by the real parser, descriptors included.
    const wire = parseCoworkNativeLauncherLine(serializeCoworkNativeLauncherLine(message, "to-launcher"), "to-launcher", rights.length) as CoworkNativeToLauncher;
    this.received.push({ message: wire, rights: [...rights] });
    this.owner.options.events.push(`launcher:${wire.t}`);
    switch (wire.t) {
      case "begin": return this.onBegin(wire);
      case "volumes": return this.onVolumes(wire, rights);
      case "mux_down": return this.onMux(wire.frame);
      case "stop": return this.onStop(wire);
      // The launcher forgets a retained receipt when told to.
      case "receipt_retire": { for (const [at, text] of this.owner.options.receipts) if (text.includes(`"confirmationId":"${wire.confirmationId}"`)) this.owner.options.receipts.delete(at); return; }
      default: return;
    }
  }

  private onBegin(message: Extract<CoworkNativeToLauncher, { t: "begin" }>): void {
    const { t: _t, id, homeId: _home, ...scope } = message; void _t; void _home;
    this.scope = scope;
    if (this.behavior.begin === "silent") return;
    if (this.behavior.begin === "refuse") return this.deliver({ t: "refused", id, code: "code_identity_mismatch" });
    this.deliver({ t: "begun", id, workerInstanceId: this.behavior.begin === "other-worker" ? "wrk-someone-else" : scope.workerInstanceId, workerPid: 4242, workerStartToken: "start-4242" });
    this.deliver({ t: "worker_state", state: "sandboxed" });
  }
  private onVolumes(message: Extract<CoworkNativeToLauncher, { t: "volumes" }>, rights: readonly number[]): void {
    // Prove the descriptors were real, open files WHEN they arrived, and that they are the files the line names.
    const seen = rights.map(fd => { const st = fstatSync(fd, { bigint: true }); return { dev: String(st.dev), ino: String(st.ino), size: Number(st.size) }; });
    this.arrivals.push(seen);
    this.volumes = message.volumes;
    if (this.behavior.volumes === "silent") {
      for (const item of this.behavior.chatter ?? []) {
        if (item === "vm_running") { this.deliver({ t: "worker_state", state: "vm_running" }); this.vmRunning = true; }
        else this.muxUp({ t: "hello", guestBootId: "66666666-6666-4666-8666-666666666666", dataSerial: "winter-data", environmentSerial: "winter-environment" });
      }
      return;
    }
    if (this.behavior.volumes === "refuse" || seen.some((item, index) => item.dev !== message.volumes[index]!.device || item.ino !== message.volumes[index]!.inode)) { this.volumes = []; return this.deliver({ t: "refused", id: message.id, code: "volumes_rejected" }); }
    this.deliver({ t: "volumes_accepted", id: message.id });
    if (this.behavior.quietVm) return;
    this.deliver({ t: "worker_state", state: "vm_running" }); this.vmRunning = true;
    if (this.behavior.guestHello !== "silent") { this.guestBooted = true; this.muxUp({ t: "hello", guestBootId: "66666666-6666-4666-8666-666666666666", dataSerial: "winter-data", environmentSerial: "winter-environment" }); }
  }
  private onMux(frame: CoworkNativeMuxFrame): void {
    this.down.accept(frame, "down");
    if (frame.class !== "bootstrap") return;
    const message = frame.message;
    if (message.t === "plan") {
      this.plan = { operationId: message.operationId, nonce: message.nonce, plan: message.plan };
      switch (this.behavior.bootstrap) {
        case "silent": return;
        case "fault": return this.muxUp({ t: "fault", operationId: message.operationId, nonce: message.nonce, code: "format_failed" });
        case "runtime-frame": return this.deliver({ t: "mux_up", frame: { class: "runtime", seq: 1, conversation: 0, stream: "out", end: false, payload: new Uint8Array([1]) } });
      }
      const receipt = receiptFor(message.plan);
      if (this.behavior.bootstrap === "tampered-receipt") (receipt.volumes as { filesystemUUID: string }[])[0]!.filesystemUUID = "00000000-0000-4000-8000-000000000000";
      const nonce = this.behavior.bootstrap === "wrong-nonce" ? "ee".repeat(16) : message.nonce;
      const operationId = this.behavior.bootstrap === "wrong-operation" ? "filesystem_other" : message.operationId;
      this.muxUp({ t: "receipt", operationId, nonce, receipt: receipt as unknown as Record<string, unknown> });
      if (this.behavior.bootstrap === "duplicate-receipt") this.muxUp({ t: "receipt", operationId, nonce, receipt: receipt as unknown as Record<string, unknown> });
      return;
    }
    if (message.t === "ready" && this.behavior.conversations === "early-ready") this.muxUp({ t: "runtime_ready", operationId: message.operationId, nonce: message.nonce, conversations: 1 });
    if (message.t === "ready" && this.behavior.mounted !== "silent") this.muxUp({ t: "mounted", operationId: message.operationId, nonce: message.nonce });
    if (message.t === "conversations") {
      this.conversationSets.push(message);
      const { operationId, nonce } = message, count = message.conversations.length;
      switch (this.behavior.conversations ?? "ok") {
        case "silent": return;
        case "bad": return this.muxUp({ t: "fault", operationId, nonce, code: "bad_conversations" });
        case "supervisor-failed": return this.muxUp({ t: "fault", operationId, nonce, code: "supervisor_failed" });
        case "second": return this.muxUp({ t: "fault", operationId, nonce, code: "second_conversations" });
        case "wrong-count": return this.muxUp({ t: "runtime_ready", operationId, nonce, conversations: count + 1 });
        case "wrong-nonce": return this.muxUp({ t: "runtime_ready", operationId, nonce: "ee".repeat(16), conversations: count });
        case "wrong-operation": return this.muxUp({ t: "runtime_ready", operationId: "filesystem_other", nonce, conversations: count });
        case "late-ready": { setTimeout(() => { if (this.scope) this.muxUp({ t: "runtime_ready", operationId, nonce, conversations: count }); }, 600); return; }
        case "duplicate-ready": this.muxUp({ t: "runtime_ready", operationId, nonce, conversations: count }); return this.muxUp({ t: "runtime_ready", operationId, nonce, conversations: count });
        default: return this.muxUp({ t: "runtime_ready", operationId, nonce, conversations: count });
      }
    }
  }

  private orderly(overrides: Partial<CoworkNativeOrderlyReceipt> = {}, stopNonce: string): CoworkNativeOrderlyReceipt {
    const scope = this.scope!;
    const attached = this.volumes.length === 2, booted = this.guestBooted;
    this.confirmCounter += 1;
    const volumes = COWORK_NATIVE_VOLUME_PURPOSES.map((purpose, index) => {
      const volume = this.volumes[index];
      return { purpose, device: attached ? volume!.device : "0", inode: attached ? volume!.inode : "0", capacityBytes: attached ? volume!.capacityBytes : 0, attached, flushRequested: attached && booted ? 9 : 0, flushCompleted: attached && booted ? 9 : 0, finalFlush: attached ? "completed" as const : "not-attached" as const };
    }) as unknown as CoworkNativeOrderlyReceipt["volumes"];
    return { v: 1, class: "A", confirmationId: `confirm-fake${this.confirmCounter}`, stopNonce, origin: "host-stop", launcherInstanceId: this.launcherInstanceId, admissionId: scope.admissionId, homeId: this.owner.options.homeId,
      workspaceId: scope.workspaceId, incarnationId: scope.incarnationId, leaseEpoch: scope.leaseEpoch, controllerInstanceId: scope.controllerInstanceId, workerInstanceId: scope.workerInstanceId, runtimeImageDigest: scope.runtimeImageDigest,
      hostBootId: this.hostBootId, guest: attached && booted ? { drain: "acked", halting: "observed", powerOff: "observed" } : { drain: "not-booted", halting: "not-booted", powerOff: "not-booted" },
      worker: { pid: 4242, startToken: "start-4242", exit: "code", status: 0, reaped: true }, volumes, issuedAtMs: 1_760_000_000_000, ...overrides };
  }
  private uncertain(reason: CoworkNativeUncertainReceipt["reason"]): CoworkNativeUncertainReceipt {
    const scope = this.scope!;
    return { v: 1, class: "B", launcherInstanceId: this.launcherInstanceId, admissionId: scope.admissionId, workspaceId: scope.workspaceId, incarnationId: scope.incarnationId, leaseEpoch: scope.leaseEpoch, workerInstanceId: scope.workerInstanceId, reason,
      worker: { pid: 4242, startToken: "start-4242", exit: "signal", status: 9 }, attachedVolumes: this.volumes.length === 2, issuedAtMs: 1_760_000_000_000 };
  }
  /** Build the Class A receipt the way the real launcher would: durable first, then on the wire. */
  private emitOrderly(id: string | null, receipt: CoworkNativeOrderlyReceipt, durable = true): void {
    const scope = this.scope!;
    if (durable) this.owner.options.receipts.set(`${scope.workspaceId}|${scope.incarnationId}|${scope.leaseEpoch}`, serializeCoworkNativeStopReceipt(receipt));
    this.deliver({ t: "stopped", id, receipt });
  }
  private onStop(message: Extract<CoworkNativeToLauncher, { t: "stop" }>): void {
    if (!this.scope) return this.deliver({ t: "refused", id: message.id, code: "not_begun" });
    switch (this.behavior.stop ?? "orderly") {
      case "silent": return;
      case "late-orderly": { const id = message.id, nonce = message.stopNonce; setTimeout(() => { if (this.scope) this.emitOrderly(id, this.orderly({}, nonce)); }, 300); return; }
      case "other-request-id": return this.emitOrderly("req-someone-else", this.orderly({}, message.stopNonce), false);
      case "other-launcher": return this.emitOrderly(message.id, this.orderly({ launcherInstanceId: "launcher-impostor" }, message.stopNonce), false);
      // Internally consistent receipts that say less than the daemon saw: the volumes were never accepted / the VM never ran.
      case "denies-attach": return this.emitOrderly(message.id, this.orderly({ guest: { drain: "not-booted", halting: "not-booted", powerOff: "not-booted" }, volumes: [this.unattached(0), this.unattached(1)] }, message.stopNonce), false);
      case "denies-boot": return this.emitOrderly(message.id, this.orderly({ guest: { drain: "not-booted", halting: "not-booted", powerOff: "not-booted" }, volumes: this.orderly({}, message.stopNonce).volumes.map(v => ({ ...v, flushRequested: 0, flushCompleted: 0 })) as never }, message.stopNonce), false);
      case "eof": return queueMicrotask(() => this.eof());
      case "fault": return this.deliver({ t: "fault", code: "worker_channel_lost" });
      case "uncertain": return this.deliver({ t: "uncertain", receipt: this.uncertain("drain-timeout") });
      // A launcher that answers with a nonce nobody issued is lying on the live channel; it keeps no durable copy of that lie.
      case "wrong-nonce": return this.emitOrderly(message.id, this.orderly({}, "bb".repeat(16)), false);
      case "bad-invariants": return this.emitOrderly(message.id, this.orderly({ guest: { drain: "acked", halting: "observed", powerOff: "not-booted" } }, message.stopNonce));
      case "other-incarnation": return this.emitOrderly(message.id, this.orderly({ incarnationId: "inc-an-older-one" }, message.stopNonce));
      case "wrong-volume": return this.emitOrderly(message.id, this.orderlyWithWrongVolume(message.stopNonce));
      default:
        // A VM that ran but whose guest never answered cannot have halted by a drain: an honest launcher says so with a Class B.
        if (this.vmRunning && !this.guestBooted) return this.deliver({ t: "uncertain", receipt: this.uncertain("drain-timeout") });
        return this.emitOrderly(message.id, this.orderly({}, message.stopNonce));
    }
  }
  private unattached(index: number): CoworkNativeOrderlyReceipt["volumes"][number] {
    return { purpose: COWORK_NATIVE_VOLUME_PURPOSES[index]!, device: "0", inode: "0", capacityBytes: 0, attached: false, flushRequested: 0, flushCompleted: 0, finalFlush: "not-attached" };
  }
  private orderlyWithWrongVolume(stopNonce: string): CoworkNativeOrderlyReceipt {
    const good = this.orderly({}, stopNonce), first = { ...good.volumes[0], inode: "424242" };
    return { ...good, volumes: [first, good.volumes[1]] } as CoworkNativeOrderlyReceipt;
  }
  /** Used by tests that stage evidence without a live session: the receipt this session WOULD issue for a stop. */
  stagedOrderly(stopNonce: string, overrides: Partial<CoworkNativeOrderlyReceipt> = {}): CoworkNativeOrderlyReceipt { return this.orderly(overrides, stopNonce); }
  stagedUncertain(reason: CoworkNativeUncertainReceipt["reason"]): CoworkNativeUncertainReceipt { return this.uncertain(reason); }
  /** Push an unsolicited message at the host (a launcher that speaks without being asked). */
  push(message: CoworkNativeToDaemon): void { this.deliver(message); }
}

/** What an honest guest returns for a plan: every volume formatted/probed exactly as planned (volume-filesystem.ts, protocol 3). */
export function receiptFor(plan: Record<string, unknown>): { volumes: Record<string, unknown>[] } & Record<string, unknown> {
  const volumes = (plan.volumes as Record<string, unknown>[]).map(target => ({ ...target, filesystemType: "ext4", filesystemUUID: target.expectedFilesystemUUID, flushConfirmed: true, checked: true, filesystemFeatures: [...COWORK_EXT4_FEATURES],
    transientFilesystemFeatures: [], fullReadOnlyCheck: plan.checkMode === "full-read-only", journalReplayed: false, journalReplay: "none" }));
  return { ...plan, volumes };
}
