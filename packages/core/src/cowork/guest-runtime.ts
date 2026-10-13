import { coworkGuestSourceRoot } from "./guest-paths";
import { randomUUID } from "node:crypto";
import type { PermissionMode, SpawnedRuntimeProcess } from "@yanlinglabs/winter-agent-sdk";
import { permissionModeFor } from "../runtime-sdk/mode-options";
import type { CoworkRepository } from "./repository";
import { relativeCoworkPath } from "./repository";
import { intersectCeilings, type CoworkAuthority } from "./authority";
import { CoworkError, type CapabilityCeiling, type GuestEpoch, type SourceAccess, type ConversationBinding, type WorkspaceSource } from "./types";

export const GUEST_RUNTIME_TRANSPORT_LIMITS = Object.freeze({ frameBytes: 1024 * 1024, chunkBytes: 256 * 1024, pendingInputBytes: 2 * 1024 * 1024 });
export interface GuestRuntimeScope extends GuestEpoch {
  homeId: string; bootId: string; sessionId: string; backendSessionId: string; bindingRevision: number; policyRevision: number; instructionRevision: number;
}
/** Host facts from the canonical session directory, not resume data from the guest. */
export interface GuestRuntimeIdentity { backendSessionId: string; model: string; resume: boolean }
export interface GuestRuntimeCapabilities { readonly toolClasses: readonly string[]; readonly hostServices: readonly string[]; readonly connectors: readonly string[]; readonly network: CapabilityCeiling["network"] }
export interface GuestRuntimeLaunch {
  readonly protocolVersion: 1; readonly limits: typeof GUEST_RUNTIME_TRANSPORT_LIMITS;
  readonly scope: Readonly<GuestRuntimeScope>; readonly launchId: string;
  readonly source: Readonly<{ sourceId: string; locationId: string; revision: number; access: SourceAccess }>;
  readonly capabilities: GuestRuntimeCapabilities;
  readonly runtime: Readonly<{ executionPosture: "confined-guest"; sessionId: string; model: string; cwd: string; winterHome: string; storeHome: string; persistSession: true; permissionMode: PermissionMode; tools: readonly string[]; allowedTools: readonly []; resume?: string }>;
}
export interface GuestRuntimeTermination {
  scope: Readonly<GuestRuntimeScope>; launchId: string; outcome: "confirmed-stopped" | "uncertain";
  /** Native owner confirms protected SDK-store ownership is released, independently of EOF. */
  storeOwnerReleased: boolean;
}
/** Authenticated supervisor stream, already demultiplexed by the sandboxed worker/helper.
 * This is NOT a packet parser or a descriptor request channel in the credential daemon. */
export interface GuestRuntimeChannel {
  protocolVersion: 1; scope: Readonly<GuestRuntimeScope>; launchId: string;
  stdout: AsyncIterable<string>; stderr?: AsyncIterable<string>;
  /** Resolves only on this bound channel's delivery acknowledgment; bounded queues, no replay. */
  send(chunk: string): Promise<void>; endInput(): Promise<void>; stop(force: boolean): void;
  runtimeExited: Promise<{ code: number | null; signal: string | null }>;
  termination: Promise<GuestRuntimeTermination>;
}
/** Trusted native integration responsibility: authenticate boot/epoch/session before launch,
 * own guest process + descendant/store lifetime, and enforce tool confinement/immutable image.
 * No production implementation exists yet. JS shape checks are not OS ownership evidence. */
export interface GuestRuntimeSupervisorPort { open(launch: Readonly<GuestRuntimeLaunch>): GuestRuntimeChannel }
export interface GuestRuntimeSupervisorDeps {
  records: CoworkRepository; authority: CoworkAuthority;
  identity(sessionId: string): GuestRuntimeIdentity;
  /** Authenticated guest boot identity, never supplied by an RPC, tool or guest snapshot. */
  bootId(workspaceId: string): string;
  runtimeCapability?: { protocolVersion: number; capabilities: readonly string[]; supportsConfinedGuestExecution: boolean };
  port?: GuestRuntimeSupervisorPort;
}
/** Canonical query snapshot with a one-use spawn closure. This is host composition,
 * not independent native admission or a serializable startup capability. */
export interface PreparedGuestRuntimeQuery {
  readonly launch: Readonly<GuestRuntimeLaunch>;
  spawn(): SpawnedRuntimeProcess;
}
const safeSegment = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new CoworkError("invalid_request");
  return value;
};
const sameScope = (a: Readonly<GuestRuntimeScope>, b: Readonly<GuestRuntimeScope>): boolean =>
  !!b && Object.keys(a).every(key => a[key as keyof GuestRuntimeScope] === b[key as keyof GuestRuntimeScope]);
function freezeCeiling(value: CapabilityCeiling): GuestRuntimeCapabilities {
  return Object.freeze({ ...value, toolClasses: Object.freeze([...value.toolClasses]), hostServices: Object.freeze([...value.hostServices]), connectors: Object.freeze([...value.connectors]) });
}
function confinedToolVisibility(toolClasses: readonly string[]): readonly string[] {
  // Visibility is derived once from captured host authority. No pre-approval is
  // inferred from it, and unimplemented guest tool families remain unavailable.
  const classes = new Set(toolClasses), tools: string[] = [];
  if (classes.has("read")) tools.push("Read");
  if (classes.has("write")) { if (classes.has("read")) tools.push("Edit"); tools.push("Write"); }
  if (classes.has("execute")) tools.push("Bash");
  return Object.freeze(tools);
}
interface Admission { launch: Readonly<GuestRuntimeLaunch>; binding: ConversationBinding; source: WorkspaceSource }
interface Lifetime { launch: Readonly<GuestRuntimeLaunch>; phase: "opening" | "running" | "retained"; stop?: (force: boolean) => void; cancel?: (force: boolean) => void }

/** Host-side conversation transport executor. No local spawn or generic argv/env fallback.
 * The map prevents duplicate admission in this realm; cross-process/disk exclusion belongs to
 * the native port and canonical workspace worker owner, not another storage record here. */
export class CoworkGuestRuntimeSupervisor {
  private readonly lifetimes = new Map<string, Lifetime>();
  private stopped = false;
  constructor(private readonly deps: GuestRuntimeSupervisorDeps) {}
  private descriptor(sessionId: string): Admission {
    const binding = this.deps.records.binding(sessionId), workspace = this.deps.records.get(binding.workspaceId);
    if (binding.state !== "active" || !workspace.incarnationId) throw new CoworkError("authority_denied");
    const epoch = this.deps.records.refreshEpoch(workspace.workspaceId, workspace.incarnationId, workspace.leaseEpoch);
    const source = this.deps.authority.requireSource(workspace.workspaceId, binding.sourceId);
    const capabilities = this.deps.authority.effectiveCapabilities(sessionId), policy = this.deps.records.policy(workspace.workspaceId);
    const identity = this.deps.identity(sessionId), bootId = this.deps.bootId(workspace.workspaceId);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(bootId) || typeof identity.resume !== "boolean" || typeof identity.model !== "string" || !identity.model || identity.model.length > 200 || /[\0\r\n]/.test(identity.model)) throw new CoworkError("authority_denied");
    const store = `/workspace/.winter/conversations/${safeSegment(sessionId)}`;
    const relativeCwd = relativeCoworkPath(binding.relativeCwd);
    const sourceRoot = coworkGuestSourceRoot(source);
    const cwd = `${sourceRoot}${relativeCwd === "." ? "" : `/${relativeCwd}`}`;
    const capturedCapabilities = freezeCeiling(capabilities);
    const launch: Readonly<GuestRuntimeLaunch> = Object.freeze({ protocolVersion: 1, limits: GUEST_RUNTIME_TRANSPORT_LIMITS, launchId: randomUUID(),
      scope: Object.freeze({ ...epoch, homeId: this.deps.records.homeIdentity(), bootId, sessionId, backendSessionId: safeSegment(identity.backendSessionId), bindingRevision: binding.revision, policyRevision: policy.revision, instructionRevision: workspace.instructionRevision }),
      source: Object.freeze({ sourceId: source.sourceId, locationId: source.locationId, revision: source.revision, access: source.access }), capabilities: capturedCapabilities,
      runtime: Object.freeze({ executionPosture: "confined-guest", sessionId: identity.backendSessionId, model: identity.model, cwd,
        winterHome: `/run/winter/conversations/${safeSegment(sessionId)}`, storeHome: store, persistSession: true, permissionMode: permissionModeFor(binding.policy),
        tools: confinedToolVisibility(capturedCapabilities.toolClasses), allowedTools: Object.freeze([] as const), ...(identity.resume ? { resume: identity.backendSessionId } : {}) }),
    });
    return { launch, binding, source };
  }
  private assertCurrent({ launch, binding: admittedBinding, source: admittedSource }: Admission): void {
    const { scope } = launch, binding = this.deps.records.binding(scope.sessionId);
    // Recheck ownership and selected authority, not mutable launch configuration. Model/resume,
    // instructions, labels and workspace defaults refresh at the next launch. Current APIs do
    // not edit a bound conversation's approval policy; any such edit remains a stop condition.
    if (binding.state !== "active" || binding.workspaceId !== scope.workspaceId || binding.sourceId !== admittedBinding.sourceId || binding.revision !== admittedBinding.revision || binding.policy !== admittedBinding.policy || relativeCoworkPath(binding.relativeCwd) !== relativeCoworkPath(admittedBinding.relativeCwd) || this.deps.records.homeIdentity() !== scope.homeId || this.deps.bootId(scope.workspaceId) !== scope.bootId || this.deps.identity(scope.sessionId).backendSessionId !== scope.backendSessionId) throw new CoworkError("stale_acknowledgment");
    this.deps.records.refreshEpoch(scope.workspaceId, scope.incarnationId, scope.leaseEpoch);
    const source = this.deps.authority.requireSource(scope.workspaceId, admittedSource.sourceId, admittedSource.access === "read-write");
    if (source.locationId !== admittedSource.locationId || source.kind !== admittedSource.kind || JSON.stringify(source.detail) !== JSON.stringify(admittedSource.detail) || (source.trust === "revoked" && admittedSource.trust !== "revoked")) throw new CoworkError("stale_acknowledgment");
    const captured: CapabilityCeiling = { ...launch.capabilities, toolClasses: [...launch.capabilities.toolClasses], hostServices: [...launch.capabilities.hostServices], connectors: [...launch.capabilities.connectors] };
    const current = this.deps.authority.effectiveCapabilities(scope.sessionId);
    // Captured authority must remain a subset of current authority. Narrowing and incomparable
    // replacements fail closed; widening does not widen this already-admitted launch.
    if (JSON.stringify(intersectCeilings(captured, current)) !== JSON.stringify(intersectCeilings(captured, captured))) throw new CoworkError("stale_acknowledgment");
  }
  private requireTransport(): GuestRuntimeSupervisorPort {
    const { port, runtimeCapability } = this.deps;
    if (this.stopped || !port || runtimeCapability?.protocolVersion !== 1 || runtimeCapability.supportsConfinedGuestExecution !== true || !Array.isArray(runtimeCapability.capabilities) || !runtimeCapability.capabilities.includes("confined-guest-posture-v1")) throw new CoworkError("unsupported_topology");
    return port;
  }
  /** Preparing options has no process effect. Subsequent SDK startup must match the
   * exact canonical snapshot; neither an options mutation nor a stale queued query
   * can choose the runtime identity/configuration the native port receives. */
  prepareQuery(sessionId: string): PreparedGuestRuntimeQuery {
    this.requireTransport();
    const admission = this.descriptor(sessionId);
    let consumed = false;
    return Object.freeze({ launch: admission.launch, spawn: () => {
      if (consumed) throw new CoworkError("recovery_required");
      consumed = true;
      this.requireTransport();
      this.assertCurrent(admission);
      const current = this.descriptor(sessionId).launch;
      if (!sameScope(admission.launch.scope, current.scope) || JSON.stringify(admission.launch.runtime) !== JSON.stringify(current.runtime) || JSON.stringify(admission.launch.source) !== JSON.stringify(current.source) || JSON.stringify(admission.launch.capabilities) !== JSON.stringify(current.capabilities)) throw new CoworkError("stale_acknowledgment");
      return this.spawnAdmission(admission);
    } });
  }
  spawn(sessionId: string): SpawnedRuntimeProcess {
    this.requireTransport();
    if (this.lifetimes.has(sessionId)) throw new CoworkError("recovery_required");
    return this.spawnAdmission(this.descriptor(sessionId));
  }
  private spawnAdmission(admission: Admission): SpawnedRuntimeProcess {
    const port = this.requireTransport(), { launch } = admission, sessionId = launch.scope.sessionId;
    if (this.lifetimes.has(sessionId)) throw new CoworkError("recovery_required");
    if ([...this.lifetimes.values()].some(value => value.launch.scope.backendSessionId === launch.scope.backendSessionId)) throw new CoworkError("authority_denied");
    const lifetime: Lifetime = { launch, phase: "opening" }; this.lifetimes.set(sessionId, lifetime);
    let channel: GuestRuntimeChannel;
    try {
      channel = port.open(launch); lifetime.stop = force => channel.stop(force);
      if (typeof channel.send !== "function" || typeof channel.endInput !== "function" || typeof channel.stop !== "function" || typeof channel.stdout?.[Symbol.asyncIterator] !== "function" || (channel.stderr !== undefined && typeof channel.stderr?.[Symbol.asyncIterator] !== "function") || typeof channel.runtimeExited?.then !== "function" || typeof channel.termination?.then !== "function") throw new CoworkError("unsupported_topology");
      if (channel.protocolVersion !== 1 || !sameScope(launch.scope, channel.scope) || channel.launchId !== launch.launchId) throw new CoworkError("authority_denied");
      this.assertCurrent(admission); lifetime.phase = "running";
    } catch (error) { lifetime.phase = "retained"; try { lifetime.stop?.(true); } catch {} throw error; }
    let failed = false, ended = false, pending = 0, inputLine = 0;
    let nativeStopped = false, primaryOpened = false, primaryYielded = false, primaryClosed = false;
    const maybeRelease = (): void => {
      // Native/store termination does not consume already-buffered protocol frames. The exact
      // lifetime stays admitted until its primary consumer closes (or an unopened stream is fenced).
      if (nativeStopped && primaryClosed && this.lifetimes.get(sessionId) === lifetime) {
        failed = true; this.lifetimes.delete(sessionId);
      }
    };
    const primaryDone = (): void => { primaryClosed = true; maybeRelease(); };
    const cancel = (force: boolean): void => {
      failed = true; lifetime.phase = "retained";
      // A delivered chunk may still be in the SDK parser/permission handler. Keep its
      // admission until iterator completion/return; do not revoke native ownership by timeout.
      if (!primaryYielded) primaryDone();
      try { channel.stop(force); } catch {}
    };
    lifetime.cancel = cancel;
    let sends = Promise.resolve();
    const fail = (): void => cancel(true);
    const thisCheck = (): void => {
      if (this.lifetimes.get(sessionId) !== lifetime) throw new CoworkError("recovery_required");
      if (channel.protocolVersion !== 1 || !sameScope(launch.scope, channel.scope) || channel.launchId !== launch.launchId) throw new CoworkError("authority_denied");
      this.assertCurrent(admission);
    };
    const check = (alreadyAdmitted = false): void => {
      if (failed || (!alreadyAdmitted && ended) || lifetime.phase !== "running") throw new CoworkError("recovery_required");
      try { thisCheck(); } catch (error) { fail(); throw error; }
    };
    const admit = (chunk: string): number => {
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (bytes > GUEST_RUNTIME_TRANSPORT_LIMITS.frameBytes || pending + bytes > GUEST_RUNTIME_TRANSPORT_LIMITS.pendingInputBytes) { fail(); throw new CoworkError("response_too_large"); }
      for (const part of chunk.split(/(?<=\n)/)) {
        inputLine += Buffer.byteLength(part, "utf8");
        if (inputLine > GUEST_RUNTIME_TRANSPORT_LIMITS.frameBytes) { fail(); throw new CoworkError("response_too_large"); }
        if (part.endsWith("\n")) inputLine = 0;
      }
      return bytes;
    };
    const bounded = (stream: AsyncIterable<string>, primary = false): AsyncIterable<string> => {
      const body = async function* () {
      let line = 0;
      try {
        if (failed) throw new CoworkError("recovery_required");
        thisCheck();
        for await (const chunk of stream) {
          // No prefetch queue: downstream iteration applies stream backpressure to the port.
          if (failed) throw new CoworkError("recovery_required");
          thisCheck();
          if (Buffer.byteLength(chunk, "utf8") > GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes) throw new CoworkError("response_too_large");
          for (const part of chunk.split(/(?<=\n)/)) {
            line += Buffer.byteLength(part, "utf8"); if (line > GUEST_RUNTIME_TRANSPORT_LIMITS.frameBytes) throw new CoworkError("response_too_large");
            if (part.endsWith("\n")) line = 0;
          }
          if (primary) primaryYielded = true;
          yield chunk;
        }
        // Lost primary stream closes new admission and asks the native owner to drain.
        // EOF never settles runtime exit or releases protected ownership.
        if (primary && lifetime.phase === "running") { failed = true; lifetime.phase = "retained"; try { channel.stop(false); } catch {} }
      } catch (error) { fail(); throw error; }
      finally { if (primary) primaryDone(); }
      };
      return { [Symbol.asyncIterator]() {
        if (primary) {
          if (primaryOpened) throw new CoworkError("recovery_required");
          primaryOpened = true;
        }
        const iterator = body();
        return {
          next: () => iterator.next(),
          async return() { if (primary) cancel(false); try { return await iterator.return(); } finally { if (primary) primaryDone(); } },
          async throw(error: unknown) { if (primary) cancel(true); try { return await iterator.throw(error); } finally { if (primary) primaryDone(); } },
        };
      } };
    };
    const exited = channel.runtimeExited.then(value => { lifetime.phase = "retained"; return value; }, error => { fail(); throw error; });
    void Promise.all([exited, channel.termination]).then(([, proof]) => {
      if (proof && typeof proof === "object" && proof.outcome === "confirmed-stopped" && proof.storeOwnerReleased === true && proof.launchId === launch.launchId && sameScope(launch.scope, proof.scope)) { nativeStopped = true; maybeRelease(); }
      else lifetime.phase = "retained";
    }, () => { lifetime.phase = "retained"; });
    return { pid: null, stdout: bounded(channel.stdout, true), ...(channel.stderr ? { stderr: bounded(channel.stderr) } : {}), exited,
      stdin: { write: chunk => {
        check(); const bytes = admit(chunk); pending += bytes;
        sends = sends.then(() => { check(true); return channel.send(chunk); }).then(() => { pending -= bytes; }, () => { pending -= bytes; fail(); });
      }, end: () => {
        check(); ended = true;
        sends = sends.then(() => { if (failed) return; thisCheck(); return channel.endInput(); }).catch(() => { fail(); });
      } },
      kill: signal => cancel(signal === "SIGKILL"),
    };
  }
  /** Shutdown blocks new starts and requests drain; no timeout/EOF/kill-based release. */
  stop(): void { this.stopped = true; for (const value of this.lifetimes.values()) { value.phase = "retained"; try { if (value.cancel) value.cancel(false); else value.stop?.(false); } catch {} } }
  retained(): readonly Readonly<GuestRuntimeScope>[] { return [...this.lifetimes.values()].map(value => value.launch.scope); }
}
