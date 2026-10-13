import { createHash } from "node:crypto";
import { posix } from "node:path";
import { RuntimeSessionRecords, type RuntimeSessionRecord } from "../runtime-state/records";
import { intersectCeilings, type CoworkGrantResolver } from "./authority";
import { coworkGuestSourceRoot } from "./guest-paths";
import type { CoworkRepository } from "./repository";
import type { CapabilityCeiling, ConversationBinding, Workspace, WorkspacePolicy, WorkspaceSource } from "./types";

export const COWORK_CONTEXT_MAX_BYTES = 128 * 1024;
export type CoworkContextErrorCode = "invalid_request" | "unregistered_agent" | "stale_backend" | "stale_boot" | "unknown_workspace"
  | "policy_unavailable" | "source_unavailable" | "cwd_unavailable" | "generation_changed" | "over_bound" | "cancelled" | "context_unavailable";
export class CoworkContextError extends Error {
  constructor(readonly code: CoworkContextErrorCode) { super(code); this.name = "CoworkContextError"; }
}
/** Captured/current host query registration, never guest JSON or a provisional global registration.
 * The owner must authenticate this Linux view before supplying the port. Shape is not native proof. */
export interface CoworkContextRegistration {
  trustedQuerySessionId: string; sessionId: string; workspaceId: string; backendSessionId: string; backendGeneration: number;
  bootId: string; incarnationId: string; leaseEpoch: number; state: "active"; platform: "linux";
  executionPosture: "confined-guest"; capabilities: CapabilityCeiling;
  admittedSources: { sourceId: string; revision: number; root: string; access: "read-only" | "read-write" }[];
}
/** Guest fields are bounded lookup hints only. Nonces, revisions and workspace/grant selectors are absent. */
export interface CoworkContextLookup { sessionId: string; cwd: string; purpose: "generation" | "compaction"; attempt: number; agentId?: string }
type RuntimeIdentity = Pick<RuntimeSessionRecord, "winterSessionId" | "backendSessionId" | "generation" | "runtimeKind" | "state" | "parentWinterSessionId">;
type Grant = { sourceId: string; readable: boolean; writable: boolean; revoked: boolean; rootMatches: boolean };
export interface CoworkContextRecords {
  registration: CoworkContextRegistration; runtime: RuntimeIdentity; bootId: string;
  workspace: Workspace; binding: ConversationBinding; policy: WorkspacePolicy; sources: WorkspaceSource[]; grants: Grant[];
}
export interface CoworkCurrentContextPlan {
  /** Diagnostic provenance only, never authorization or a reusable capability. */
  revision: string;
  facts: string;
  sources: ReadonlyArray<Readonly<{ sourceId: string; kind: WorkspaceSource["kind"]; state: WorkspaceSource["state"]; desired: WorkspaceSource["desired"]; admitted: boolean; root?: string; access?: "read-only" | "read-write" }>>;
  publication: Readonly<{ configured: WorkspacePolicy["publication"]; githubOnly: boolean; completion: "feature-commit-and-push" | "unavailable" | "manual"; publicationCandidateSourceIds: readonly string[] }>;
  instructionScopes: Readonly<{
    owner: "protected-guest-router";
    shared: Readonly<{ path: "/workspace/.winter/WINTER.md"; required: true; imports: "guidance-only" }>;
    source: Readonly<{ sourceId: string; root: string; cwd: string; discovery: "code-plain-guidance"; executableConfiguration: "not-admitted-by-this-plan" }>;
  }>;
  /** The eventual resolver must bound final facts+instructions/rendering, not just use this reserve. */
  remainingInstructionBytes: number;
}
const fail = (code: CoworkContextErrorCode): never => { throw new CoworkContextError(code); };
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const policies = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) fail("cancelled"); };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const bySourceId = (a: { sourceId: string }, b: { sourceId: string }) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
const hash = (value: unknown): string => createHash("sha256").update(canonical(value), "utf8").digest("hex");
function capabilities(value: CapabilityCeiling): CapabilityCeiling {
  const names = (input: string[]) => {
    if (!Array.isArray(input) || input.length > 256) return fail("over_bound");
    if (input.some(name => typeof name !== "string" || name.length < 1 || name.length > 200 || /[\0\r\n]/.test(name))) return fail("policy_unavailable");
    return [...new Set(input)].sort();
  };
  if (!value || !["none", "internet"].includes(value.network)) return fail("policy_unavailable");
  return { toolClasses: names(value.toolClasses), hostServices: names(value.hostServices), connectors: names(value.connectors), network: value.network };
}
function lookup(value: CoworkContextLookup): CoworkContextLookup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_request");
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !["sessionId", "cwd", "purpose", "attempt", "agentId"].includes(key))
    || Object.values(properties).some(property => !("value" in property))) return fail("invalid_request");
  const v = Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, property.value])) as unknown as CoworkContextLookup;
  if (!id(v.sessionId) || !["generation", "compaction"].includes(v.purpose) || !revision(v.attempt) || v.attempt > 1_000_000
    || typeof v.cwd !== "string" || Buffer.byteLength(v.cwd, "utf8") > 4096 || /[\\\0\r\n]/.test(v.cwd)
    || !v.cwd.startsWith("/") || posix.normalize(v.cwd) !== v.cwd || v.cwd.split("/").includes("..")) return fail("invalid_request");
  if (v.agentId !== undefined) return fail("unregistered_agent");
  return v;
}
/** Labels/titles and private host/authority locators never enter visible facts/output. Private source
 * identities are hashed only to detect current authority changes; that digest is not authority. */
function projection(value: CoworkContextRecords) {
  const { workspace: w, binding: b, policy: p, registration: r } = value;
  return { registration: { ...r, capabilities: capabilities(r.capabilities), admittedSources: [...r.admittedSources].sort(bySourceId) },
    runtime: value.runtime, bootId: value.bootId,
    workspace: { workspaceId: w.workspaceId, ownership: w.ownership, ownerId: w.ownerId, state: w.state, configRevision: w.configRevision,
      grantRevision: w.grantRevision, instructionRevision: w.instructionRevision, incarnationId: w.incarnationId, leaseEpoch: w.leaseEpoch, power: w.power },
    binding: { sessionId: b.sessionId, workspaceId: b.workspaceId, projectId: b.projectId, sourceId: b.sourceId, relativeCwd: b.relativeCwd,
      policy: b.policy, restrictions: capabilities(b.restrictions), revision: b.revision, state: b.state },
    policy: { policyId: p.policyId, workspaceId: p.workspaceId, defaultPolicy: p.defaultPolicy, publication: p.publication,
      ceiling: capabilities(p.ceiling), revision: p.revision, defaultRevision: p.defaultRevision, publicationRevision: p.publicationRevision },
    sources: value.sources.map(({ label: _label, createdAt: _created, updatedAt: _updated, ...source }) => source).sort(bySourceId),
    grants: [...value.grants].sort(bySourceId) };
}
/** Pure current-record planner, NOT a complete SDK snapshot resolver and never a filesystem reader. */
export function planCoworkCurrentContext(value: CoworkContextRecords, requested: CoworkContextLookup, signal?: AbortSignal): Readonly<CoworkCurrentContextPlan> {
  cancelled(signal); const request = lookup(requested);
  const { workspace: w, binding: b, policy: p, registration: r, runtime } = value;
  if (!r || !id(r.trustedQuerySessionId) || !id(r.sessionId) || r.state !== "active" || r.platform !== "linux" || r.executionPosture !== "confined-guest"
    || !runtime || runtime.winterSessionId !== r.sessionId || runtime.parentWinterSessionId !== undefined || runtime.runtimeKind !== "winter-agent"
    || !["ready", "running", "idle"].includes(runtime.state) || !id(runtime.backendSessionId) || runtime.backendSessionId !== r.backendSessionId
    || request.sessionId !== runtime.backendSessionId || !revision(runtime.generation) || runtime.generation !== r.backendGeneration) return fail("stale_backend");
  if (!w || !b || w.workspaceId !== r.workspaceId || b.workspaceId !== w.workspaceId || b.sessionId !== runtime.winterSessionId
    || w.state !== "retained" || b.state !== "active"
    || (w.ownership === "project" ? b.projectId !== w.ownerId : w.ownership !== "standalone" || b.projectId !== null || w.ownerId !== b.sessionId)) return fail("unknown_workspace");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.bootId) || value.bootId !== r.bootId
    || !id(r.incarnationId) || !revision(r.leaseEpoch) || w.incarnationId !== r.incarnationId || w.leaseEpoch !== r.leaseEpoch || !["starting", "running"].includes(w.power)) return fail("stale_boot");
  if (!p || p.workspaceId !== w.workspaceId || !policies.includes(b.policy) || !policies.includes(p.defaultPolicy)
    || !["manual", "github-only-feature-branches"].includes(p.publication) || ![w.configRevision, w.grantRevision, w.instructionRevision, b.revision, p.revision, p.publicationRevision, p.defaultRevision].every(revision)) return fail("policy_unavailable");
  if (!Array.isArray(value.sources) || value.sources.length > 100 || !Array.isArray(r.admittedSources) || r.admittedSources.length > 100 || !Array.isArray(value.grants) || value.grants.length > 100) return fail("over_bound");
  if (new Set(value.sources.map(source => source.sourceId)).size !== value.sources.length || new Set(r.admittedSources.map(source => source.sourceId)).size !== r.admittedSources.length) return fail("source_unavailable");
  const effective = intersectCeilings(intersectCeilings(capabilities(b.restrictions), capabilities(p.ceiling)), capabilities(r.capabilities));
  const eligible: string[] = [];
  const sources = [...value.sources].sort(bySourceId).filter(source => source.state !== "detached").map(source => {
    if (!id(source.sourceId) || source.workspaceId !== w.workspaceId || !revision(source.revision)
      || !["folder", "githubRepository"].includes(source.kind) || !["preparing", "ready", "unavailable", "removing", "detached"].includes(source.state)
      || !["present", "removed"].includes(source.desired) || !["read-only", "read-write"].includes(source.access) || !["untrusted", "trusted", "revoked"].includes(source.trust)) return fail("source_unavailable");
    const grant = value.grants.find(grant => grant.sourceId === source.sourceId), admitted = r.admittedSources.find(root => root.sourceId === source.sourceId);
    if (grant && [grant.readable, grant.writable, grant.revoked, grant.rootMatches].some(value => typeof value !== "boolean")) return fail("source_unavailable");
    const ready = source.desired === "present" && source.state === "ready" && source.trust !== "revoked" && source.ackRevision === source.revision
      && source.ackIncarnationId === w.incarnationId && !!grant && !grant.revoked && grant.readable && grant.rootMatches
      && (source.kind !== "folder" || source.access !== "read-write" || grant.writable);
    let root: string;
    try { root = coworkGuestSourceRoot(source); } catch { return fail("source_unavailable"); }
    const present = ready && !!admitted && admitted.revision === source.revision && admitted.root === root
      && ["read-only", "read-write"].includes(admitted.access) && (admitted.access !== "read-write" || (source.access === "read-write" && (source.kind === "githubRepository" || grant!.writable)));
    if (present && source.kind === "githubRepository" && admitted!.access === "read-write" && grant!.writable
      && effective.toolClasses.includes("write") && effective.hostServices.includes("git.publish") && b.policy !== "plan") eligible.push(source.sourceId);
    return Object.freeze({ sourceId: source.sourceId, kind: source.kind, state: source.state, desired: source.desired, admitted: present,
      ...(present ? { root, access: admitted!.access } : {}) });
  });
  const bound = sources.find(source => source.sourceId === b.sourceId);
  if (!bound?.admitted || bound.root === undefined) return fail("source_unavailable");
  if (!(request.cwd === bound.root || request.cwd.startsWith(`${bound.root}/`))) return fail("cwd_unavailable");
  // Mirror CoworkRepository.githubOnly: a removing folder still counts until detached.
  const githubOnly = sources.some(source => source.kind === "githubRepository" && source.desired === "present") && !sources.some(source => source.kind === "folder");
  const automatic = p.publication === "github-only-feature-branches" && githubOnly;
  const completion = automatic ? eligible.length > 0 ? "feature-commit-and-push" as const : "unavailable" as const : "manual" as const;
  const publication = Object.freeze({ configured: p.publication, githubOnly, completion,
    publicationCandidateSourceIds: Object.freeze(automatic ? eligible : []) });
  const facts = ["Cowork current host context", "Platform: Linux; parent query registration: active.",
    `Workspace: ${w.workspaceId}; workspace state: ${w.state}; readiness: ${w.power}.`,
    `Conversation policy: ${b.policy}; workspace default policy: ${p.defaultPolicy}.`,
    `Effective ceiling: read=${effective.toolClasses.includes("read")}; write=${effective.toolClasses.includes("write")}; execute=${effective.toolClasses.includes("execute")}; host services=${effective.hostServices.length}; connectors=${effective.connectors.length}; network=${effective.network}.`,
    ...sources.map(source => `Source ${source.sourceId}: ${source.kind}; ${source.desired}; ${source.state}; ${source.admitted ? `admitted at ${source.root}; ${source.access}` : "not admitted in the current view"}.`),
    completion === "feature-commit-and-push" ? "Completion default: commit and push completed authorized changes to feature branches unless task-specific instructions or guidance narrow the requested behavior. Removing shared guidance does not disable this host policy."
      : completion === "unavailable" ? "Automatic completion unavailable in this conversation; respect current session policy/task limits and report blocked publication."
        : "Completion default: manual publication; no automatic commit/push obligation applies.",
    `Publication candidates pending host task/ref approval: ${publication.publicationCandidateSourceIds.join(",") || "none"}.`,
    "Publication still requires the host Git broker's current task, source and ref authorization. This plan grants no authority; main/default/protected branches, merges, force-pushes and other separately controlled actions remain separately authorized.",
    "Plain guidance is separate from executable configuration trust; this plan does not admit settings, hooks, plugins or MCP configuration."].join("\n");
  const instructionScopes = Object.freeze({ owner: "protected-guest-router" as const,
    shared: Object.freeze({ path: "/workspace/.winter/WINTER.md" as const, required: true as const, imports: "guidance-only" as const }),
    source: Object.freeze({ sourceId: bound.sourceId, root: bound.root, cwd: request.cwd, discovery: "code-plain-guidance" as const, executableConfiguration: "not-admitted-by-this-plan" as const }) });
  const plan = Object.freeze({ revision: `context:${hash({ records: projection(value), facts, instructionScopes })}`, facts,
    sources: Object.freeze(sources), publication, instructionScopes, remainingInstructionBytes: COWORK_CONTEXT_MAX_BYTES - Buffer.byteLength(facts, "utf8") });
  if (plan.remainingInstructionBytes < 0 || Buffer.byteLength(JSON.stringify(plan), "utf8") > COWORK_CONTEXT_MAX_BYTES) return fail("over_bound");
  cancelled(signal); return plan;
}

export interface CoworkCurrentContextDeps {
  records: CoworkRepository; grants: CoworkGrantResolver; trustedQuerySessionId: string;
  /** A port onto the host's current owning query registration, NOT a guest registration endpoint. */
  currentRegistration(trustedQuerySessionId: string): CoworkContextRegistration | undefined;
  currentBootId(workspaceId: string): string;
}
/** Synchronous read transaction plus external authority checks on BOTH sides of grant reads.
 * External grants/registration are not made atomically bound by a SQLite transaction. */
export class CoworkCurrentContextPlanner {
  private readonly sessions: RuntimeSessionRecords;
  private readonly trustedQuerySessionId: string;
  constructor(private readonly deps: CoworkCurrentContextDeps) {
    if (!id(deps.trustedQuerySessionId)) fail("stale_backend");
    this.trustedQuerySessionId = deps.trustedQuerySessionId;
    this.sessions = new RuntimeSessionRecords(deps.records.rs);
  }
  plan(request: CoworkContextLookup, options: { signal?: AbortSignal } = {}): Readonly<CoworkCurrentContextPlan> {
    const { signal } = options; cancelled(signal); lookup(request);
    try {
      return this.deps.records.rs.transaction(() => {
        const first = this.read(signal), plan = planCoworkCurrentContext(first, request, signal);
        const second = this.read(signal); planCoworkCurrentContext(second, request, signal);
        // No external grant callback follows this last metadata/registration/boot guard.
        const final = this.metadata(signal);
        if (hash(projection({ ...second, grants: [] })) !== hash(projection({ ...final, grants: [] }))) return fail("generation_changed");
        if (hash(projection(first)) !== hash(projection(second))) return fail("generation_changed");
        cancelled(signal); return plan;
      });
    } catch (error) {
      if (error instanceof CoworkContextError) throw new CoworkContextError(error.code);
      throw new CoworkContextError("context_unavailable");
    }
  }
  private metadata(signal?: AbortSignal): Omit<CoworkContextRecords, "grants"> {
    cancelled(signal);
    const raw = this.deps.currentRegistration(this.trustedQuerySessionId);
    if (!raw || raw.trustedQuerySessionId !== this.trustedQuerySessionId || !id(raw.sessionId)) return fail("stale_backend");
    // Copy before any external grant getter can mutate its owning registration object.
    if (!Array.isArray(raw.admittedSources) || raw.admittedSources.length > 100) return fail("over_bound");
    const registration: CoworkContextRegistration = { ...raw, capabilities: capabilities(raw.capabilities), admittedSources: raw.admittedSources.map(source => ({ ...source })) };
    const runtime = this.sessions.get(registration.sessionId);
    if (!runtime) return fail("stale_backend");
    let binding: ConversationBinding, workspace: Workspace, policy: WorkspacePolicy;
    try { binding = this.deps.records.binding(registration.sessionId); workspace = this.deps.records.get(binding.workspaceId); }
    catch { return fail("unknown_workspace"); }
    try { policy = this.deps.records.policy(workspace.workspaceId); } catch { return fail("policy_unavailable"); }
    // Only current sources: detached tombstones do not consume the 100-source response ceiling.
    const ids = this.deps.records.rs.db.query<{ source_id: string }, [string]>("SELECT source_id FROM cowork_sources WHERE workspace_id=? AND state!='detached' ORDER BY source_id LIMIT 101").all(workspace.workspaceId);
    if (ids.length > 100) return fail("over_bound");
    const sources = ids.map(({ source_id }) => this.deps.records.source(workspace.workspaceId, source_id)), bootId = this.deps.currentBootId(workspace.workspaceId);
    if (sources.length > 100) return fail("over_bound");

    cancelled(signal);
    return { registration, runtime: { winterSessionId: runtime.winterSessionId, ...(runtime.backendSessionId === undefined ? {} : { backendSessionId: runtime.backendSessionId }), generation: runtime.generation,
      runtimeKind: runtime.runtimeKind, state: runtime.state, ...(runtime.parentWinterSessionId === undefined ? {} : { parentWinterSessionId: runtime.parentWinterSessionId }) },
      bootId, workspace, binding, policy, sources };
  }
  private read(signal?: AbortSignal): CoworkContextRecords {
    const metadata = this.metadata(signal), { sources } = metadata;
    const grants = sources.map(source => {
      cancelled(signal);
      if (source.kind === "folder") {
        const grant = this.deps.grants.folder(source.detail.grantRef);
        return { sourceId: source.sourceId, readable: !!grant && !grant.revoked, writable: !!grant && grant.writable, revoked: !grant || grant.revoked, rootMatches: !!grant && grant.rootIdentity === source.detail.rootIdentity };
      }
      const grant = this.deps.grants.repository(source.detail.authorityRef, source.detail.repositoryId);
      return { sourceId: source.sourceId, readable: !!grant && grant.readable, writable: !!grant && grant.writable, revoked: !grant || grant.revoked, rootMatches: true };
    });
    cancelled(signal); return { ...metadata, grants };
  }
}
