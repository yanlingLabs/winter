import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import type { ModelRole } from "../settings";

/**
 * 2026-09-18: quiet per-ROLE failure notes for the Mac app's Roles pane ("Notes" section) — when a
 * model role's call fails for a reason the user should know about (rate limit, quota/usage-limit
 * exhausted, out of credits, a rejected/missing credential, an unavailable model or provider), the
 * pane shows `role · model tag · one line`. A note about a RESOLVED problem is exactly the noise
 * the feature exists to avoid, so it clears the instant a later call for that role succeeds, or the
 * role moves off the model that failed (`problemFor`'s own doc comment).
 *
 * Lives here, in `providers/`, rather than growing `settings.ts` (already 2000+ lines and a pure
 * `Settings -> Settings` module with no fs/registry state of its own) or `agent/` (nothing here is
 * agent-turn-shaped) — this is DAEMON STATE about the daemon's own provider calls, the same shelf
 * `providers/quota.ts`'s `QuotaManager` already occupies for the identical kind of fact ("how is
 * this account's traffic actually going", as opposed to `settings.ts`'s "what did the user ask
 * for"). `classifyProviderFailure` is a pure function with no registry dependency at all — kept in
 * this file rather than split out because it exists FOR the registry and nothing else calls it.
 */

// ── Classification ────────────────────────────────────────────────────────────────────────────

/**
 * The five `ProviderEvent.error.code` values (`providers/types.ts`) plus two AgentErrorCode-only
 * members (`providers/errors.ts`'s cousin, `projector/errors.ts`'s `AgentErrorCode`) that have no
 * ProviderEvent equivalent — `"billing"`/`"model_not_found"` — added so dispatch's coarser
 * `agent_error.code` (all it has: no `providerCode`, no `retryAfterMs`, no HTTP status reach the
 * wire — see `AgentErrorEvent`, protocol/src/events.ts) can be classified through this SAME
 * function rather than a second, parallel implementation. See `classifyDispatchAgentError` below.
 */
export type ClassifyCode = "auth" | "rate_limit" | "server" | "network" | "bad_request" | "billing" | "model_not_found";

export interface ClassifyInput {
  code: ClassifyCode;
  /** The provider's own structured error code, verbatim — `ProviderEvent.error.providerCode`
   *  (`providers/types.ts`). Real values confirmed by reading `@yanlinglabs/winter-provider-runtime`'s
   *  own `normalizeHttpError`/`toSdkAssistantMessageError` (pinned 0.0.16, `dist/index-5dggdw6g.js`):
   *  `BILLING_CODES` = `insufficient_quota`, `billing_hard_limit_reached`, `billing_not_active`,
   *  `credit_balance_too_low`, `usage_limit_reached`, `usage_limit_exceeded`; `MODEL_NOT_FOUND_CODES`
   *  = `model_not_found`, `not_found_error`, `NOT_FOUND`, `model_not_supported`; the credential-store
   *  layer's own sentinel `WinterCredentialMissing` (not reachable through either internal adapter
   *  today — Bedrock-only — kept here so it classifies correctly the day it is). */
  providerCode?: string;
  retryAfterMs?: number;
  message: string;
  /** `QuotaManager.subscriptionQuota()`'s own shape — `info` is the Codex adapter's `quotaEvent()`
   *  output verbatim (same pinned dist file): `{status:"allowed"}` or `{status:"rejected",
   *  resetsAt?: <unix seconds>}`. Used only to fill `retryAt` when the failure itself carried no
   *  `retryAfterMs` — a subscription-quota report is informational, not itself the failure. */
  subscriptionQuota?: { info: Record<string, unknown>; at: number };
}

export interface ClassifiedFailure {
  /** A raw string on the wire (protocol's `problem.reason` is `z.string()`, not an enum) so a new
   *  value reaches the UI without a protocol change. Today's vocabulary: `rate-limited`,
   *  `usage-limit`, `out-of-credits`, `credential-rejected`, `no-credential`, `model-unavailable`,
   *  `provider-unavailable`, `other` — plus the two STRUCTURAL reasons `internal-role-problems.ts`
   *  overlays for an internal-jobs role (`provider-unsupported`, `no-internal-credential`), which this
   *  classifier never produces and this registry never stores: they are derived per read. */
  reason: string;
  /** ONE short human line (capped ~160 chars), built from the CLASSIFIED facts — never the raw
   *  provider message for an `auth`-class failure (the safest rule the brief asks for: an auth body
   *  is the one shape most likely to echo the credential itself back). Every other reason may carry
   *  a capped, key-shape-stripped fragment of `message` (the `"other"` bucket only — every other
   *  reason has a fixed, structured sentence and never touches `message` at all). */
  detail: string;
  /** ISO timestamp — when the provider (or the subscription window) said this resolves. */
  retryAt?: string;
}

/** `QuotaManager`'s own public shape, narrowed to the ONE method the classifier needs —
 *  `providers/quota.ts`'s real `QuotaManager` satisfies this structurally, so every real
 *  `RebindableProvider.quota`/`ActiveProvider.quota` is usable here with no adapter; a test double
 *  can supply a bare `{ subscriptionQuota: () => undefined }` or omit the field entirely. */
export interface SubscriptionQuotaSource {
  subscriptionQuota(): { info: Record<string, unknown>; at: number } | undefined;
}

const WINTER_CREDENTIAL_MISSING = "WinterCredentialMissing";
const USAGE_LIMIT_CODES = new Set(["usage_limit_reached", "usage_limit_exceeded"]);
const OUT_OF_CREDITS_CODES = new Set(["insufficient_quota", "billing_hard_limit_reached", "billing_not_active", "credit_balance_too_low"]);
const MODEL_UNAVAILABLE_CODES = new Set(["model_not_found", "not_found_error", "NOT_FOUND", "model_not_supported"]);

const DETAIL_MAX = 160;

/** Redacts any key-shaped run (20+ chars of the alphabet a real API key/token is drawn from) before
 *  capping — the brief's rule for the one bucket (`"other"`) that may carry a message fragment at
 *  all: "cap + strip anything key-shaped". Errs toward stripping too much (a long model slug or hash
 *  is not a plausible loss here) rather than too little. */
function safeDetail(raw: string): string {
  // `+`, `/` and `=` are IN the class on purpose: base64 and base64url secrets contain them, and
  // leaving them out would split a key into runs shorter than the threshold — each of which would then
  // survive on its own. Over-stripping a URL path or a long slug is the accepted cost.
  const stripped = raw.replace(/[A-Za-z0-9_\-.+/=]{20,}/g, "[redacted]").trim();
  if (stripped.length === 0) return "the provider returned an unrecognized error";
  return stripped.length <= DETAIL_MAX ? stripped : `${stripped.slice(0, DETAIL_MAX - 1)}…`;
}

function retryAtFrom(input: Pick<ClassifyInput, "retryAfterMs" | "subscriptionQuota">, now: () => number): string | undefined {
  if (input.retryAfterMs !== undefined) return new Date(now() + input.retryAfterMs).toISOString();
  const info = input.subscriptionQuota?.info;
  const resetsAt = info?.status === "rejected" ? info.resetsAt : undefined;
  return typeof resetsAt === "number" && Number.isFinite(resetsAt) ? new Date(resetsAt * 1000).toISOString() : undefined;
}

/**
 * THE one pure classifier — structured fields in, `{reason, detail, retryAt?}` out. Never parses
 * `message` prose to DECIDE a reason (the brief's rule); `message` is read only to build `"other"`'s
 * detail, through `safeDetail`, and never at all for `code: "auth"`.
 */
export function classifyProviderFailure(input: ClassifyInput, now: () => number = Date.now): ClassifiedFailure {
  const retryAt = retryAtFrom(input, now);
  switch (input.code) {
    case "auth": {
      if (input.providerCode === WINTER_CREDENTIAL_MISSING) {
        return { reason: "no-credential", detail: "no credential is stored for this role" };
      }
      return { reason: "credential-rejected", detail: "the stored credential was rejected by the provider" };
    }
    case "rate_limit": {
      if (input.providerCode !== undefined && USAGE_LIMIT_CODES.has(input.providerCode)) {
        return { reason: "usage-limit", detail: "the plan's usage window is exhausted", ...(retryAt ? { retryAt } : {}) };
      }
      if (input.providerCode !== undefined && OUT_OF_CREDITS_CODES.has(input.providerCode)) {
        return { reason: "out-of-credits", detail: "billing/credits are exhausted for this provider", ...(retryAt ? { retryAt } : {}) };
      }
      return { reason: "rate-limited", detail: "the provider is rate limiting requests", ...(retryAt ? { retryAt } : {}) };
    }
    case "bad_request": {
      if (input.providerCode !== undefined && MODEL_UNAVAILABLE_CODES.has(input.providerCode)) {
        return { reason: "model-unavailable", detail: "the model is not available to this account" };
      }
      if (input.providerCode !== undefined && USAGE_LIMIT_CODES.has(input.providerCode)) {
        return { reason: "usage-limit", detail: "the plan's usage window is exhausted", ...(retryAt ? { retryAt } : {}) };
      }
      if (input.providerCode !== undefined && OUT_OF_CREDITS_CODES.has(input.providerCode)) {
        return { reason: "out-of-credits", detail: "billing/credits are exhausted for this provider" };
      }
      return { reason: "other", detail: safeDetail(input.message) };
    }
    case "model_not_found":
      return { reason: "model-unavailable", detail: "the model is not available to this account" };
    // Dispatch-only bucket (`AgentErrorCode: "billing"`, `PROVIDER_TAXONOMY`'s `account_on_hold`/
    // `billing_error` members): the wire event carries no HTTP status and no providerCode, so
    // usage-limit and out-of-credits are NOT distinguishable here the way the internal-provider
    // path can (that path sees the raw `providerCode` and picks between them above). "out-of-credits"
    // is the closer single bucket — both source classes are a persistent billing block, not a
    // transient rate limit — see this file's own module doc / the report for the honest caveat.
    case "billing":
      return { reason: "out-of-credits", detail: "billing/credits are exhausted for this provider" };
    case "server":
    case "network":
      return { reason: "provider-unavailable", detail: "the provider is unavailable or overloaded", ...(retryAt ? { retryAt } : {}) };
  }
}

/**
 * Dispatch's own entry point — `agent_error.code` (protocol's `AgentErrorEvent.code`, an OPTIONAL
 * free string in practice drawn from `projector/errors.ts`'s closed `AgentErrorCode`) is all a
 * dispatch turn's terminal failure carries on the wire: no `providerCode`, no `retryAfterMs`, no
 * HTTP status (see `AgentErrorEvent`'s schema — `message`+`code` only). Codes outside the
 * provider-attributable set below (`max_turns`, `tool_failure`, `aborted`, `store_error`, …) are not
 * provider health at all — `undefined` here means "do not record anything for this failure",
 * exactly the "if all you get is prose, don't guess" posture extended one step further: if you don't
 * even get a provider-shaped CODE, there is nothing to classify.
 */
export function classifyDispatchAgentError(code: string | undefined): ClassifiedFailure | undefined {
  switch (code) {
    case "auth":
    case "rate_limit":
    case "server":
    case "network":
    case "model_not_found":
    case "billing":
      return classifyProviderFailure({ code, message: "" });
    case "bad_request":
      // `agent_error.message` IS already sanitized (`projector/errors.ts`'s `sanitizeDetail`,
      // opaque-marker-stripped and capped at 200 chars) before it ever reaches this event, so
      // reading it here would be safe on the SAME terms that module already established. Passed as
      // `""` anyway — the safer choice, and consistent with every other dispatch-side call above:
      // this function has no way to tell "the sanitizer ran and left nothing interesting" from "the
      // sanitizer ran and left something", and `classifyProviderFailure`'s own "other" bucket then
      // reports its fixed fallback line rather than a possibly-empty fragment.
      return classifyProviderFailure({ code, message: "" });
    default:
      return undefined;
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────────────────────

export interface RoleProblem {
  reason: string;
  detail: string;
  /** The provider-qualified tag that FAILED (or, if this is still current, is still running). */
  model: string;
  /** ISO — when this problem was recorded. */
  at: string;
  retryAt?: string;
}

interface StoredEntry { reason: string; detail: string; model: string; at: string; retryAt?: string }

function isStoredEntry(v: unknown): v is StoredEntry {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.reason === "string" && typeof o.detail === "string" && typeof o.model === "string" && typeof o.at === "string" &&
    (o.retryAt === undefined || typeof o.retryAt === "string");
}

/**
 * Live, in-memory, per-role failure notes — one entry per `ModelRole` at most, keyed by the role
 * string. Every method is fully SYNCHRONOUS (in-memory Map read/mutate, then a synchronous
 * tmp-file+rename write) with no `await` between the read and the write, so there is no interleaving
 * window for two concurrent callers to race — the "safe under concurrent consumers" requirement
 * falls out of the single-threaded event loop rather than needing a lock.
 *
 * Persistence: `<home>/runtimes/role-health.json`, tmp-file + `renameSync` (the same idiom
 * `migration/manifest.ts`'s `writeManifestAtomic` and `runtime-state/children.ts`'s own
 * `writeAtomic` already use — there is no single shared export of it to import, so this mirrors
 * their idiom rather than inventing a fourth one). `runtimes/` (not `run/`, `logs/`, `cache/`) is
 * deliberate: `migration/migrate-b.ts`'s `classify()` only ever disposes of those three prefixes
 * (plus `daemon.log`/`index.db`/`*.db-{shm,wal}`) — this file copies byte-for-byte on a Migration B
 * run and, more importantly for the actual requirement, is never wiped by anything the daemon does
 * on its own. It also rides the SAME deny-read fence `Read`/`Glob`/`Grep` already put on `<home>/
 * runtimes` (CLAUDE.md's Tool Surface section) — this is daemon state about the daemon's own
 * provider health, not project content, and there is no reason an agent's own file tools should
 * ever see it.
 *
 * Never a raw provider body: only the classified `{reason, detail, model, at, retryAt?}` is ever
 * written — `recordFailure` takes a `ClassifiedFailure`, never a `ProviderEvent`.
 */
export class RoleHealthRegistry {
  private entries = new Map<string, StoredEntry>();
  private readonly path: string;

  constructor(home: string) {
    this.path = join(home, "runtimes", "role-health.json");
    this.load();
  }

  /** Tolerant of a missing or corrupt file — starts empty, never throws at boot (the brief's own
   *  requirement: a dream cycle runs rarely, so a boot-time throw here would be a much louder
   *  failure than the quiet note it is protecting). */
  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return; // absent, unreadable, or not JSON — start empty
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
    for (const [role, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (isStoredEntry(entry)) this.entries.set(role, entry);
    }
  }

  /** Best-effort: a write failure (a read-only home, a full disk) is logged and otherwise ignored —
   *  the in-memory state (what every `problemFor` call actually reads) is already correct either
   *  way, and a note that fails to persist is no worse than the pre-restart world this feature adds
   *  to, never worse than that. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries), null, 2) + "\n");
      renameSync(tmp, this.path);
    } catch (err) {
      console.error(`role-health: failed to persist ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** `modelTag` is the EFFECTIVE, provider-qualified tag that actually ran this call — never the
   *  role's stored pin verbatim when the two can differ (a pin the daemon fell back away from, an
   *  internal-provider role bound to the live backend's own model). */
  recordFailure(role: ModelRole, modelTag: string, problem: ClassifiedFailure): void {
    this.entries.set(role, {
      reason: problem.reason, detail: problem.detail, model: modelTag, at: new Date().toISOString(),
      ...(problem.retryAt !== undefined ? { retryAt: problem.retryAt } : {}),
    });
    this.persist();
  }

  /** A no-op (no write) when the role already has no note — the common case on every clean call,
   *  and the reason this never pays a write cost for the overwhelming majority of successful runs. */
  recordSuccess(role: ModelRole): void {
    if (!this.entries.delete(role)) return;
    this.persist();
  }

  /**
   * `null` when there is no note, OR the note's own `model` no longer equals the role's CURRENT
   * effective model — a note about a model the role no longer uses is exactly the noise the brief
   * says to drop, and doing it here (a comparison, not a mutation) means no consumer has to
   * remember to clear a note on a model change: `settings.modelRoles`/`settings.setModelRole`'s
   * handler passes the role's freshly-computed `model` field on every call, so a role that has since
   * moved (a user re-pin, a `provider.model` cascade) reads as problem-free on its very next read,
   * with the stored note left untouched underneath in case the role moves BACK.
   */
  problemFor(role: ModelRole, currentEffectiveModelTag: string | null): RoleProblem | null {
    const e = this.entries.get(role);
    if (e === undefined) return null;
    if (currentEffectiveModelTag === null || e.model !== currentEffectiveModelTag) return null;
    return { ...e };
  }
}

/**
 * The dispatch observer's own decision logic — factored out of `daemon.ts`'s `hub.addObserver`
 * wiring so it is unit-testable without booting a whole daemon (that wiring's own job is only to
 * filter the hub's every-session fan-out down to the ONE dispatch-singleton session id and resolve
 * `tag`, then hand both to this function unchanged). `tag` is the EFFECTIVE, provider-qualified tag
 * this session actually ran on (the caller's own job — daemon.ts prefers the session's durable
 * `runtime-state.db` record, falling back to the live `pins.dispatch` setting only when the runtime
 * spine is offline).
 *
 * Mirrors `classifyDispatchAgentError`'s own scope note: an `agent_error` whose `code` is not
 * provider-attributable records nothing (`classifyDispatchAgentError` returns `undefined`), and a
 * `turn_completed` whose `stopReason` is `"aborted"` (a user interrupt, not a success) is likewise
 * observed and ignored — only `"end_turn"` clears the role's note.
 */
export function recordDispatchOutcome(event: SessionEvent, tag: string, roleHealth: RoleHealthRegistry): void {
  if (event.type === "agent_error") {
    const classified = classifyDispatchAgentError(event.code);
    if (classified !== undefined) roleHealth.recordFailure("pins.dispatch", tag, classified);
  } else if (event.type === "turn_completed" && event.stopReason === "end_turn") {
    roleHealth.recordSuccess("pins.dispatch");
  }
}

/** Merges `roleHealth.problemFor` onto one `modelRoleInfo`-shaped result — the wire-only
 *  augmentation the RPC handlers (`ipc/server.ts`'s `settings.modelRoles`/`settings.setModelRole`)
 *  apply on top of `settings.ts`'s pure `modelRoleInfo`/`modelRolesFor`, which stay settings-only
 *  functions with no registry dependency (this file's own module doc explains the split). */
export function withProblem<T extends { model: string | null }>(
  info: T,
  role: ModelRole,
  roleHealth: RoleHealthRegistry | undefined,
): T & { problem: RoleProblem | null } {
  return { ...info, problem: roleHealth?.problemFor(role, info.model) ?? null };
}

/** `withProblem`, applied to a WHOLE `modelRolesFor` result — what both RPC handlers
 *  (`ipc/server.ts`'s `settings.modelRoles`/`settings.setModelRole`) actually call. */
export function withProblemsForRoles<T extends { model: string | null }>(
  roles: Record<ModelRole, T>,
  roleHealth: RoleHealthRegistry | undefined,
): Record<ModelRole, T & { problem: RoleProblem | null }> {
  const out = {} as Record<ModelRole, T & { problem: RoleProblem | null }>;
  for (const role of Object.keys(roles) as ModelRole[]) out[role] = withProblem(roles[role], role, roleHealth);
  return out;
}
