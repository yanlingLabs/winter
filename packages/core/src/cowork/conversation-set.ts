import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";
import { coworkGuestSourceRoot } from "./guest-paths";
import { relativeCoworkPath } from "./repository";
import type { CoworkGuestConversation, CoworkGuestConversationContext, CoworkGuestConversationSet, CoworkProviderRoute, CoworkProviderRouteScope, CoworkProviderSelection } from "./session-ports";
import { CoworkError, type ConversationBinding, type WorkspaceSource } from "./types";

/*
 * Cowork session door D3: the ONE builder of a conversation's entry in the incarnation's conversation set (design section
 * 2.3). The native host sends it at `mounted`; the guest's tool supervisor (agent SDK `linux-supervisor.py`) admits it and
 * builds the guest runtime's config FROM IT, never from the host query's Options:
 *
 *   - the runtime's permission mode comes from `policy`, through the supervisor's own map (`host_query_config`):
 *     auto/ask -> default, plan -> plan, accept-edits -> acceptEdits, dont-ask -> dontAsk, bypass -> bypassPermissions;
 *   - its tools come from `runtime.toolClasses` (read -> Read, write -> Write, read and write -> Edit, execute -> Bash);
 *   - its cwd is `roots[0].guestPath`; roots may not nest, and a host-query conversation may not see `/workspace/.winter`.
 *
 * ENCODING (owner decision 2026-10-18, option A): the set carries `policy: "plan"` for plan and `"ask"` for every other
 * policy, so the guest runtime always runs `default` or `plan`. Under `default` every call that is not built-in read-only
 * reaches the host's `canUseTool`, where the APPROVALS projection applies the binding's REAL policy (it stays host-side, in
 * the binding and the transition machine). bypassPermissions, acceptEdits and dontAsk would resolve calls inside the guest
 * without asking the host, and a host-query guest can run no host hook (its only outbound control subtype is
 * `permission`). The guest-recorded policy therefore reads "ask" for a non-plan conversation; the agent SDK lane is asked
 * to map every non-plan policy to `default` so the real policy can be sent after a later repin (option B).
 *
 * Source-located conversations only (D3). The outputs location (O1) is its own slice (D3b).
 */

/** What the guest supervisor's map makes of the policy this builder sends. Mirrors `host_query_config` for the two values sent. */
export const COWORK_GUEST_RUNTIME_MODES = Object.freeze({ ask: "default", plan: "plan" } as const);
export type CoworkGuestPolicy = keyof typeof COWORK_GUEST_RUNTIME_MODES;
export type CoworkGuestPermissionMode = typeof COWORK_GUEST_RUNTIME_MODES[CoworkGuestPolicy];

const POLICIES: readonly ApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];

/** The policy the conversation set carries for a binding's policy: `plan` stays `plan`, everything else is sent as `ask`. */
export function coworkGuestPolicyFor(policy: ApprovalPolicy): CoworkGuestPolicy {
  if (!POLICIES.includes(policy)) throw new CoworkError("invalid_request");
  return policy === "plan" ? "plan" : "ask";
}

/** The permission mode the guest runtime actually runs for a binding's policy. The host launch uses the same value, so
 *  the host query's Options can never disagree with the guest. */
export function coworkGuestPermissionModeFor(policy: ApprovalPolicy): CoworkGuestPermissionMode {
  return COWORK_GUEST_RUNTIME_MODES[coworkGuestPolicyFor(policy)];
}

/** Fixed host picks for conversation index 0 (N2 carries one host-query conversation per guest): distinct, inside the
 *  contract's 1000..65533, the group equal to neither user. */
export const COWORK_GUEST_IDENTITIES = Object.freeze({ runtimeUid: 2001, toolUid: 2002, workspaceGid: 2000 });
/** The guest runtime's per-call timeout, the contract's ceiling (`RUNTIME_SPEC.timeoutMs` allows 1..600000). */
export const COWORK_GUEST_RUNTIME_TIMEOUT_MS = 600_000;

type GuestToolClass = "read" | "write" | "execute";
const CLASS_ORDER: readonly GuestToolClass[] = ["read", "write", "execute"];

/** The guest supervisor's own derivation of tools from classes (`host_query_config`), in its order. */
export function coworkGuestToolsFromClasses(classes: readonly GuestToolClass[]): string[] {
  const has = new Set(classes), tools: string[] = [];
  if (has.has("read")) tools.push("Read");
  if (has.has("write")) { if (has.has("read")) tools.push("Edit"); tools.push("Write"); }
  if (has.has("execute")) tools.push("Bash");
  return tools;
}

/**
 * The classes that make the guest offer exactly `offered`. The guest cannot be told "Read and Write but not Edit": classes
 * are all it takes. So when the offered list is not exactly what its classes derive, this refuses `invalid_request`
 * rather than send a set under which the guest would offer a tool the host withheld.
 */
export function coworkGuestToolClassesFor(offered: readonly string[]): GuestToolClass[] {
  if (!Array.isArray(offered) || offered.some(name => typeof name !== "string")) throw new CoworkError("invalid_request");
  const classes = CLASS_ORDER.filter(klass => offered.includes(klass === "read" ? "Read" : klass === "write" ? "Write" : "Bash"));
  if ([...coworkGuestToolsFromClasses(classes)].sort().join() !== [...offered].sort().join()) throw new CoworkError("invalid_request");
  return classes;
}

/** The conversation's single root and cwd: the source's canonical guest root plus the binding's relative cwd. The guest's
 *  cwd must BE a root and roots may not nest, so with a relative cwd only that subdirectory of the source is visible. */
export function coworkGuestCwdFor(binding: Readonly<ConversationBinding>, source: Readonly<WorkspaceSource>): string {
  if (binding.sourceId !== source.sourceId || binding.workspaceId !== source.workspaceId) throw new CoworkError("authority_denied");
  const relative = relativeCoworkPath(binding.relativeCwd);
  const cwd = `${coworkGuestSourceRoot(source)}${relative === "." ? "" : `/${relative}`}`;
  // The wire's guest path rule (native/protocol.ts `guestPath`): printable ASCII, at most 1024 bytes. A cwd the guest
  // would refuse is refused here, before any set is built.
  if (cwd.length > 1024 || !/^[\x20-\x7e]*$/.test(cwd)) throw new CoworkError("invalid_request");
  return cwd;
}

const PRIVATE_WORDS = ["authref", "url", "header", "secret", "token", "credential"];
function publicOnly(node: unknown, depth: number): void {
  if (depth > 6) throw new CoworkError("invalid_request");
  if (node === null || typeof node === "string" || typeof node === "boolean" || (typeof node === "number" && Number.isSafeInteger(node))) return;
  if (Array.isArray(node)) { for (const item of node) publicOnly(item, depth + 1); return; }
  if (typeof node !== "object" || Object.getPrototypeOf(node) !== Object.prototype) throw new CoworkError("invalid_request");
  for (const [key, value] of Object.entries(node)) {
    if (PRIVATE_WORDS.some(word => key.toLowerCase().includes(word))) throw new CoworkError("invalid_request");
    publicOnly(value, depth + 1);
  }
}
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])])) : value;

export interface CoworkConversationSetInput {
  /** A source-located binding (`CoworkRepository.binding` refuses an outputs row). */
  readonly binding: Readonly<ConversationBinding>;
  /** Its admitted source, as `CoworkAuthority.requireSource` returned it. */
  readonly source: Readonly<WorkspaceSource>;
  /** The incarnation this set is for, as the native host reports it at `mounted`. */
  readonly context: CoworkGuestConversationContext;
  readonly configRevision: number;
  readonly grantRevision: number;
  readonly policyRevision: number;
  readonly homeId: string;
  /** The guest runtime's durable identity (`CoworkRepository.conversationBackend`). */
  readonly backendSessionId: string;
  /** The offered tool list (`coworkToolsFor`), the same one the prompt names. */
  readonly offered: readonly string[];
  /** The provider route the door was built with. Production has none, and then nothing reaches this builder. */
  readonly route: CoworkProviderRoute;
}

/** The incarnation's conversation set for ONE source-located conversation (N2: a host-query set carries exactly one). */
export function coworkConversationFor(input: CoworkConversationSetInput): CoworkGuestConversationSet {
  const { binding, source, context, route } = input;
  if (binding.state !== "active" || binding.workspaceId !== context.workspaceId) throw new CoworkError("authority_denied");
  const policy = coworkGuestPolicyFor(binding.policy);
  const cwd = coworkGuestCwdFor(binding, source);
  // The root's `source` is what the guest opens and mounts at `guestPath`. The guest checks the guest path against its
  // allowed views but only checks `source` against its own supervisor, environment and artifact directories, so the host
  // sends the canonical guest path itself: never a run home, a store or another conversation's directory.
  const root = Object.freeze({ id: source.sourceId, guestPath: cwd, source: cwd, readOnly: source.access === "read-only" || policy === "plan" });
  const toolClasses = coworkGuestToolClassesFor(input.offered);
  const scope: CoworkProviderRouteScope = Object.freeze({
    homeId: input.homeId, workspaceId: context.workspaceId, sessionId: binding.sessionId, backendSessionId: input.backendSessionId,
    taskId: input.backendSessionId, incarnationId: context.incarnationId, bootId: context.guestBootId, leaseEpoch: context.leaseEpoch,
    grantRevision: input.grantRevision, accountRevision: 0, modelRevision: 0,
  });
  if (!route || route.kind !== "scripted-standin" || typeof route.plan !== "function" || typeof route.model !== "string" || route.model.length === 0) throw new CoworkError("provider_unavailable");
  const plan = route.plan({ scope });
  const selection: CoworkProviderSelection | undefined = plan?.provider?.selection;
  // The route may describe the selection; it may not change the scope, the model, or carry anything but public metadata.
  if (!plan || plan.model !== route.model || JSON.stringify(sorted(plan.provider?.scope)) !== JSON.stringify(sorted(scope)) || !selection || selection.modelKey !== route.model) throw new CoworkError("invalid_request");
  publicOnly(plan.provider, 0);
  const conversation: CoworkGuestConversation = Object.freeze({
    logicalSessionId: binding.sessionId,
    authority: Object.freeze({ workspaceId: context.workspaceId, sessionId: input.backendSessionId, incarnationId: context.incarnationId, leaseEpoch: context.leaseEpoch,
      configRevision: input.configRevision, grantRevision: input.grantRevision, policyRevision: input.policyRevision }),
    ...COWORK_GUEST_IDENTITIES,
    policy,
    roots: Object.freeze([root]),
    runtime: Object.freeze({ model: route.model, timeoutMs: COWORK_GUEST_RUNTIME_TIMEOUT_MS, toolClasses: Object.freeze(toolClasses),
      provider: Object.freeze(sorted({ scope, selection }) as Record<string, unknown>), guided: null }),
  });
  return Object.freeze({ profile: "host-query-v1", conversations: Object.freeze([conversation]) });
}
