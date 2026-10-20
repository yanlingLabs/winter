import { RuntimeSessionRecords } from "../runtime-state/records";
import { intersectCeilings } from "./authority";
import type { CoworkContextRegistration } from "./current-context";
import { COWORK_SHARED_INSTRUCTION_VIEW } from "./current-context-resolver";
import { coworkGuestSourceRoot } from "./guest-paths";
import { GUEST_RUNTIME_TRANSPORT_LIMITS, type GuestRuntimeLaunch } from "./guest-runtime";
import { relativeCoworkPath, type CoworkRepository } from "./repository";
import { CoworkError, type CapabilityCeiling, type SourceAccess } from "./types";

/*
 * Private owning-context slot for guided Cowork guest queries (Slice A).
 *
 * SOURCE ONLY. Nothing under src/ imports this module, it has no barrel export, and
 * CoworkGuestOwnerEvidencePort has NO production implementation, so production context
 * construction stays refused. A slot test with a fake port proves slot logic; it never
 * proves issuer authenticity, kernel facts or native admission.
 *
 * Core's winter-agent-sdk pin (0.0.53) predates the SDK's guided module, so no SDK guided
 * type is imported: the correlation, owner mirror and kernel record below are plain-data mirrors.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const BOOT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const GUIDED_PROFILE = "host-query-guided-v1" as const;
/** Mirror of the runtime's closed guided-reader loader limits. Inert here: stored, never interpreted. */
export const COWORK_GUEST_OWNER_READER_LIMITS = Object.freeze({ maxFileBytes: 128 * 1024, maxReadBytes: 256 * 1024, maxReadOccurrences: 256, maxExpandedBytes: 128 * 1024 });
const SHARED_PATH = `${COWORK_SHARED_INSTRUCTION_VIEW}/WINTER.md` as const;
const LIVE_RUNTIME_STATES = ["ready", "running", "idle"];
const LIVE_POWER = ["starting", "running"];

/** Seven-field mirror of the runtime's LinuxGuidedReaderOwner, including the backend generation. */
export interface CoworkGuestOwnerIdentity {
  readonly workspaceId: string; readonly logicalSessionId: string; readonly backendSessionId: string;
  readonly incarnationId: string; readonly leaseEpoch: number; readonly bootId: string; readonly generation: number;
}
/** Optional, inert reader plan. Views must equal the canonical source root/cwd; limits the closed constants. */
export interface CoworkGuestOwnerReaderPlan {
  readonly registrationId: string;
  readonly views: Readonly<{ sourceRoot: string; sourceCwd: string; sharedRoot: typeof COWORK_SHARED_INSTRUCTION_VIEW; sharedPath: typeof SHARED_PATH }>;
  readonly limits: Readonly<typeof COWORK_GUEST_OWNER_READER_LIMITS>;
}
/** Immutable capture of canonical rows. Extra fields stay here; the port's return type is the closed 13 fields. */
export type CoworkGuestOwnerCapture = Readonly<{
  homeId: string; workspaceId: string; sessionId: string; backendSessionId: string; trustedQuerySessionId: string; backendGeneration: number;
  bootId: string; incarnationId: string; leaseEpoch: number; launchId: string;
  source: Readonly<{ sourceId: string; revision: number; root: string; access: SourceAccess }>;
  cwd: string;
  capabilities: Readonly<{ toolClasses: readonly string[]; hostServices: readonly string[]; connectors: readonly string[]; network: CapabilityCeiling["network"] }>;
  readerRegistrationId?: string; views?: CoworkGuestOwnerReaderPlan["views"]; limits?: CoworkGuestOwnerReaderPlan["limits"];
}> & { readonly __coworkGuestOwnerCapture: true };

/** Data the future admission-owned issuer reports about the live owner. Kernel facts are required true. */
export interface CoworkGuestOwnerEvidence {
  readonly profile: typeof GUIDED_PROFILE;
  readonly registrationId: string;
  readonly owner: CoworkGuestOwnerIdentity;
  readonly launchId: string;
  readonly bindingId: string;
  readonly kernel: Readonly<{ pidfs: true; peerPidfd: true }>;
}
/** ABSTRACT seam only: no implementation exists anywhere in src/ (an anti-wiring test pins that).
 * `evidence` is synchronous, is called at every lookup and must never be cached. It reports; it does
 * not authorize. A throw, a non-closed result or any mismatch makes the lookup return undefined.
 * It is called inside the planner's read transaction: an implementation must not touch the canonical
 * database and must not write durably. */
export interface CoworkGuestOwnerEvidencePort { evidence(capture: CoworkGuestOwnerCapture): CoworkGuestOwnerEvidence }

export interface CoworkGuestOwnerDeps {
  readonly records: CoworkRepository;
  /** The supervisor's independent authenticated guest boot dep (GuestRuntimeSupervisorDeps.bootId). */
  bootId(workspaceId: string): string;
}
export interface CoworkGuestContextOwnersDeps extends CoworkGuestOwnerDeps { readonly evidence: CoworkGuestOwnerEvidencePort }
/** Plain data, never an SDK type. The SDK's process-local consumed set stays the only replay set. */
export interface CoworkGuestOwnerCorrelation { readonly version: 1; readonly bindingId: string }
export interface CoworkGuestOwnerLifetime { held(): boolean }
export type CoworkGuestOwnerCloseReason = "query-ended" | "runtime-exited" | "host-stopping";
export type CoworkGuestOwnerPhase = "open" | "closed" | "revoked" | "replaced";

const refuse = (code: ConstructorParameters<typeof CoworkError>[0]): never => { throw new CoworkError(code); };
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
/** One own DATA property; accessors, inherited fields and non-objects are refused. */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return refuse("invalid_request");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return refuse("invalid_request");
  return descriptor.value;
}
/** Exact key set, own data properties only, plain prototype. */
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse("invalid_request");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !keys.includes(key))
    || Object.values(descriptors).some(descriptor => !("value" in descriptor))) return refuse("invalid_request");
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
const text = (value: unknown): string => typeof value === "string" && ID.test(value) ? value : refuse("invalid_request");
const revision = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : refuse("invalid_request");
const bootId = (value: unknown): string => typeof value === "string" && BOOT.test(value) ? value : refuse("invalid_request");
function names(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) return refuse("invalid_request");
  const list = Array.from({ length: value.length }, (_, i) => field(value, String(i)));
  if (list.some(name => typeof name !== "string" || name.length < 1 || name.length > 200 || /[\0\r\n]/.test(name))) return refuse("invalid_request");
  return Object.freeze([...new Set(list as string[])].sort());
}

/** Module-private brand: only captureCoworkGuestOwner mints members, and membership cannot be forged. */
const captures = new WeakSet<object>();

/** Canonical rows must still agree with the capture. Pure reads only: `recordedHomeIdentity` never mints
 * (the durable `homeIdentity` throws inside a transaction), and the lookup runs inside the planner's
 * read transaction. The independent `bootId` dep is an external callback, so it runs BEFORE the SQLite
 * reads and no external callback follows them. Grants, policy and source revocation stay with the planner. */
function canonicalAgrees(deps: CoworkGuestOwnerDeps, sessions: RuntimeSessionRecords, c: Pick<CoworkGuestOwnerCapture, "homeId" | "workspaceId" | "sessionId" | "backendSessionId" | "backendGeneration" | "bootId" | "incarnationId" | "leaseEpoch">): boolean {
  const currentBoot = deps.bootId(c.workspaceId);
  const row = sessions.get(c.sessionId);
  if (!row || row.backendSessionId !== c.backendSessionId || row.generation !== c.backendGeneration || row.runtimeKind !== "winter-agent"
    || !LIVE_RUNTIME_STATES.includes(row.state) || row.parentWinterSessionId !== undefined) return false;
  const workspace = deps.records.get(c.workspaceId);
  if (workspace.state !== "retained" || workspace.incarnationId !== c.incarnationId || workspace.leaseEpoch !== c.leaseEpoch || !LIVE_POWER.includes(workspace.power)) return false;
  const binding = deps.records.binding(c.sessionId);
  if (binding.state !== "active" || binding.workspaceId !== c.workspaceId) return false;
  return currentBoot === c.bootId && deps.records.recordedHomeIdentity() === c.homeId;
}

/** Build an immutable capture from the supervisor's canonical launch AND the canonical rows. The launch is
 * only a claim: every field is re-derived from or compared with the rows, so a cloned, parsed or edited
 * object is refused. Provenance checks here are hygiene, not proof the supervisor issued it. May throw. */
export function captureCoworkGuestOwner(deps: CoworkGuestOwnerDeps, launch: Readonly<GuestRuntimeLaunch>, reader?: CoworkGuestOwnerReaderPlan): CoworkGuestOwnerCapture {
  const scope = field(launch, "scope"), source = field(launch, "source"), granted = field(launch, "capabilities"), runtime = field(launch, "runtime");
  // Only the supervisor builds a launch from its module constant, frozen at every level.
  if (field(launch, "protocolVersion") !== 1 || field(launch, "limits") !== GUEST_RUNTIME_TRANSPORT_LIMITS
    || ![launch, scope, source, granted, runtime].every(value => Object.isFrozen(value))) return refuse("authority_denied");
  const workspaceId = text(field(scope, "workspaceId")), sessionId = text(field(scope, "sessionId")), backendSessionId = text(field(scope, "backendSessionId"));
  // F4: the SDK query's own session id is also the trusted query identity.
  const trustedQuerySessionId = text(field(runtime, "sessionId"));
  if (trustedQuerySessionId !== backendSessionId || field(runtime, "executionPosture") !== "confined-guest") return refuse("authority_denied");
  const sessions = new RuntimeSessionRecords(deps.records.rs), row = sessions.get(sessionId);
  // The launch carries no generation: it comes from the canonical runtime row only.
  if (!row || row.backendSessionId !== backendSessionId) return refuse("stale_acknowledgment");
  const base = { homeId: text(field(scope, "homeId")), workspaceId, sessionId, backendSessionId, backendGeneration: revision(row.generation),
    bootId: bootId(field(scope, "bootId")), incarnationId: text(field(scope, "incarnationId")), leaseEpoch: revision(field(scope, "leaseEpoch")) };
  if (!canonicalAgrees(deps, sessions, base)) return refuse("stale_acknowledgment");
  const binding = deps.records.binding(sessionId), sourceId = text(field(source, "sourceId")), selected = deps.records.source(workspaceId, sourceId);
  const access = field(source, "access");
  if (binding.sourceId !== sourceId || selected.revision !== revision(field(source, "revision")) || selected.access !== access || (access !== "read-only" && access !== "read-write")) return refuse("stale_acknowledgment");
  const root = coworkGuestSourceRoot(selected), relative = relativeCoworkPath(binding.relativeCwd), cwd = `${root}${relative === "." ? "" : `/${relative}`}`;
  if (field(runtime, "cwd") !== cwd) return refuse("stale_acknowledgment");
  const capabilities: CapabilityCeiling = { toolClasses: [...names(field(granted, "toolClasses"))], hostServices: [...names(field(granted, "hostServices"))], connectors: [...names(field(granted, "connectors"))],
    network: field(granted, "network") === "internet" ? "internet" : field(granted, "network") === "none" ? "none" : refuse("invalid_request") };
  // Captured authority may only narrow the current canonical ceiling (the supervisor's own subset rule).
  const ceiling = intersectCeilings(binding.restrictions, deps.records.policy(workspaceId).ceiling);
  if (JSON.stringify(intersectCeilings(capabilities, ceiling)) !== JSON.stringify(intersectCeilings(capabilities, capabilities))) return refuse("stale_acknowledgment");
  let plan: Pick<CoworkGuestOwnerCapture, "readerRegistrationId" | "views" | "limits"> = {};
  if (reader !== undefined) {
    const data = closed(reader, ["registrationId", "views", "limits"]), views = closed(data.views, ["sourceRoot", "sourceCwd", "sharedRoot", "sharedPath"]), limits = closed(data.limits, Object.keys(COWORK_GUEST_OWNER_READER_LIMITS));
    if (views.sourceRoot !== root || views.sourceCwd !== cwd || views.sharedRoot !== COWORK_SHARED_INSTRUCTION_VIEW || views.sharedPath !== SHARED_PATH
      || Object.entries(COWORK_GUEST_OWNER_READER_LIMITS).some(([key, expected]) => limits[key] !== expected)) return refuse("invalid_request");
    plan = { readerRegistrationId: text(data.registrationId), views: { sourceRoot: root, sourceCwd: cwd, sharedRoot: COWORK_SHARED_INSTRUCTION_VIEW, sharedPath: SHARED_PATH }, limits: { ...COWORK_GUEST_OWNER_READER_LIMITS } };
  }
  const capture = deepFreeze({ ...base, trustedQuerySessionId, launchId: text(field(launch, "launchId")),
    source: { sourceId, revision: selected.revision, root, access }, cwd, capabilities, ...plan }) as unknown as CoworkGuestOwnerCapture;
  captures.add(capture);
  return capture;
}

function evidenceMatches(value: unknown, c: CoworkGuestOwnerCapture, bindingId: string): boolean {
  const e = closed(value, ["profile", "registrationId", "owner", "launchId", "bindingId", "kernel"]);
  const owner = closed(e.owner, ["workspaceId", "logicalSessionId", "backendSessionId", "incarnationId", "leaseEpoch", "bootId", "generation"]);
  const kernel = closed(e.kernel, ["pidfs", "peerPidfd"]);
  return e.profile === GUIDED_PROFILE && typeof e.registrationId === "string" && ID.test(e.registrationId)
    && (c.readerRegistrationId === undefined || e.registrationId === c.readerRegistrationId)
    && owner.workspaceId === c.workspaceId && owner.logicalSessionId === c.sessionId && owner.backendSessionId === c.backendSessionId
    && owner.incarnationId === c.incarnationId && owner.leaseEpoch === c.leaseEpoch && owner.bootId === c.bootId && owner.generation === c.backendGeneration
    && e.launchId === c.launchId && e.bindingId === bindingId && kernel.pidfs === true && kernel.peerPidfd === true;
}
/** A fresh deep-frozen copy of exactly the closed 13 registration fields on every call. */
function registrationOf(c: CoworkGuestOwnerCapture): CoworkContextRegistration {
  return deepFreeze({ trustedQuerySessionId: c.trustedQuerySessionId, sessionId: c.sessionId, workspaceId: c.workspaceId, backendSessionId: c.backendSessionId,
    backendGeneration: c.backendGeneration, bootId: c.bootId, incarnationId: c.incarnationId, leaseEpoch: c.leaseEpoch, state: "active" as const, platform: "linux" as const,
    executionPosture: "confined-guest" as const,
    capabilities: { toolClasses: [...c.capabilities.toolClasses], hostServices: [...c.capabilities.hostServices], connectors: [...c.capabilities.connectors], network: c.capabilities.network },
    admittedSources: [{ sourceId: c.source.sourceId, revision: c.source.revision, root: c.source.root, access: c.source.access }] });
}

interface OwnerState {
  readonly capture: CoworkGuestOwnerCapture;
  phase: CoworkGuestOwnerPhase; reason?: CoworkGuestOwnerCloseReason; bindingId?: string; held?: () => boolean;
}
type Leave = (state: OwnerState, phase: CoworkGuestOwnerPhase, reason?: CoworkGuestOwnerCloseReason) => void;
/** The caller-facing handle. State is private; there is no constructor export and no register* method. */
class Owner {
  readonly #state: OwnerState;
  readonly #leave: Leave;
  /** This owner's own `CoworkCurrentContextDeps.currentRegistration` closure. */
  readonly registrationPort: (trustedQuerySessionId: string) => CoworkContextRegistration | undefined;
  constructor(state: OwnerState, leave: Leave, port: Owner["registrationPort"]) { this.#state = state; this.#leave = leave; this.registrationPort = port; }
  get phase(): CoworkGuestOwnerPhase { return this.#state.phase; }
  get closeReason(): CoworkGuestOwnerCloseReason | undefined { return this.#state.reason; }
  /** Write-once plain data. A second call is refused even when identical. */
  bindCorrelation(correlation: CoworkGuestOwnerCorrelation): void {
    const state = this.#state;
    if (state.phase !== "open" || state.bindingId !== undefined) return refuse("authority_denied");
    const data = closed(correlation, ["version", "bindingId"]);
    if (data.version !== 1) return refuse("invalid_request");
    state.bindingId = text(data.bindingId);
  }
  /** Write-once. The holder is the host's own statement that the guest lifetime is still held. */
  attachLifetime(lifetime: CoworkGuestOwnerLifetime): void {
    const state = this.#state;
    if (state.phase !== "open" || state.held !== undefined) return refuse("authority_denied");
    const held = (lifetime as { held?: unknown } | null | undefined)?.held;
    if (typeof held !== "function") return refuse("invalid_request");
    state.held = () => (held as () => boolean).call(lifetime);
  }
  /** Terminal. The first terminal transition wins; nothing revives an owner. */
  close(reason: CoworkGuestOwnerCloseReason): void { this.#leave(this.#state, "closed", reason); }
  revoke(): void { this.#leave(this.#state, "revoked"); }
  toJSON(): never { return refuse("authority_denied"); }
}
export type CoworkGuestContextOwner = Owner;

/** Registry keyed by backend session id: at most one owner per backend session. There is no ledger of
 * correlation ids across owners; the SDK's consumed set stays the only replay set. */
export class CoworkGuestContextOwners {
  readonly #deps: CoworkGuestContextOwnersDeps;
  readonly #sessions: RuntimeSessionRecords;
  readonly #current = new Map<string, OwnerState>();
  #stopped = false;
  constructor(deps: CoworkGuestContextOwnersDeps) {
    if (!deps?.records || typeof deps.bootId !== "function" || typeof deps.evidence?.evidence !== "function") refuse("invalid_request");
    this.#deps = { records: deps.records, bootId: deps.bootId, evidence: deps.evidence };
    this.#sessions = new RuntimeSessionRecords(deps.records.rs);
  }
  /** A stale capture must not displace a current owner; the previous owner becomes terminal `replaced`. */
  prepare(capture: CoworkGuestOwnerCapture): CoworkGuestContextOwner {
    if (this.#stopped) return refuse("authority_denied");
    if (typeof capture !== "object" || capture === null || !captures.has(capture)) return refuse("authority_denied");
    let current = false;
    try { current = canonicalAgrees(this.#deps, this.#sessions, capture); } catch { current = false; }
    if (!current) return refuse("stale_acknowledgment");
    const prior = this.#current.get(capture.backendSessionId);
    if (prior) this.#leave(prior, "replaced");
    const state: OwnerState = { capture, phase: "open" };
    this.#current.set(capture.backendSessionId, state);
    return new Owner(state, (target, phase, reason) => this.#leave(target, phase, reason), trusted => this.#lookup(state, trusted));
  }
  /** Shutdown: the registry stops vouching for every owner and refuses new ones. Like the supervisor's stop(),
   * it does not end any lifetime: each owner's own phase is closed by its host when the guest really ends. */
  stop(): void { this.#stopped = true; this.#current.clear(); }
  #leave(state: OwnerState, phase: CoworkGuestOwnerPhase, reason?: CoworkGuestOwnerCloseReason): void {
    if (state.phase !== "open") return;
    state.phase = phase;
    if (phase === "closed") state.reason = reason === "query-ended" || reason === "runtime-exited" || reason === "host-stopping" ? reason : "query-ended";
    if (this.#current.get(state.capture.backendSessionId) === state) this.#current.delete(state.capture.backendSessionId);
  }
  #live(state: OwnerState): boolean { return !this.#stopped && state.phase === "open" && this.#current.get(state.capture.backendSessionId) === state; }
  /** Synchronous, pure and cheap, never throws. Returns the registration only when every condition holds. */
  #lookup(state: OwnerState, trustedQuerySessionId: string): CoworkContextRegistration | undefined {
    try {
      const c = state.capture, held = state.held, bindingId = state.bindingId;
      if (trustedQuerySessionId !== c.trustedQuerySessionId || !this.#live(state) || held === undefined || bindingId === undefined) return undefined;
      if (held() !== true) return undefined;
      if (!evidenceMatches(this.#deps.evidence.evidence(c), c, bindingId)) return undefined;
      // Canonical reads come last: no external callback follows them.
      if (!canonicalAgrees(this.#deps, this.#sessions, c) || !this.#live(state)) return undefined;
      return registrationOf(c);
    } catch { return undefined; }
  }
}
