import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { ensureGlobalGitignore, WINTER_PERSONAL_IGNORES } from "./global-gitignore";
import { OFFICIAL_SUBSCRIPTION_AUTH_APPROVED } from "./runtime-sdk/versions";
import { consoleProfileCredentialFile } from "./runtime-sdk/anthropic-paths";
import { canonicalModelTag, facingNameToTag, isModelTag, splitTag, UNSTATED_TAG, WINTER_TEST_PREFIX, type ModelTag } from "./runtime-sdk/model-tag";
// The ONE catalog-row-by-tag lookup (WS-20) — imported rather than re-written here so a role write
// and a session's own model resolution agree on what "this model exists" means, by construction.
// `effortVocabularyFor`: the ONE interpretation of a catalog row's `reasoning?.efforts`, shared with
// `models.catalog` and `sync.config` so a role's advertised vocabulary and a model listing's can
// never differ. Its `null`/`[]` distinction is what `modelRoleInfo.efforts` carries.
// `implicitEffortFor`: the spend-time mapping of a STORED effort onto the row it is about to be sent
// to (`effortToSpendForRole` below) — the same function the dispatch pin's fixed tier already goes
// through, so a role effort and a code constant are mapped by one rule.
import { effortVocabularyFor, implicitEffortFor, internalEffortNoEscalationFor, rowForTag } from "./runtime-sdk/provider-selection";
// 2026-09-19 (the internal-jobs widening): the two catalog-derived inputs to
// `internalEligibleProviderIds` below. `credentialInventory` is which providers this daemon can store
// a credential for at all; `internalDrivableAdapterIds` is which adapter families the daemon's own
// `Provider` translation can drive. Both are leaf reads — neither module imports this one, so these
// are static imports rather than a lazy hop.
import { credentialInventory } from "./runtime-sdk/keychain";
import { internalDrivableAdapterIds } from "./providers/internal-adapters";
import { liveSdkGlobalConfig, liveSdkSettings } from "./sdk-files";
import { sdkSettingsPath } from "./agent/paths";

/** Reasoning-effort slugs valid on the wire — measured LIVE against the Codex OAuth endpoint
 *  (2026-07-30), one model at a time, NOT read off the /models catalogue text. That distinction
 *  matters: "ultra" was added here on 2026-07-10 from exactly that catalogue reading and was
 *  never checked against the request validator. Effort is global and hot-reloaded (every session
 *  re-resolves it every turn), so a persisted invalid slug doesn't fail at set-time — it breaks
 *  EVERY session with an opaque HTTP 400 one turn later.
 *
 *  There are TWO validation layers on the wire, and they disagree per-model — never infer one
 *  model's answer from another's:
 *   - "none" is genuinely HONOURED on all three gpt-5.6 models: the server echoes back
 *     `effort: "none"` in both response.created and response.completed, emits no reasoning item
 *     at all, and reports 0 reasoning tokens (the same model at "max" reports 42, proving the
 *     counter is live rather than always zero).
 *   - "ultra" is rejected by a DIFFERENT, GLOBAL enum layer (`invalid_value`, model-agnostic) —
 *     it is not a per-model gap, it is invalid everywhere. It must never be re-added here.
 *
 *  "minimal" is deliberately ABSENT from this list: it is rejected PER-MODEL (`unsupported_value`,
 *  the error naming the slug) rather than globally. A future read of the /models catalogue will
 *  list it right alongside the others that ARE valid — do not re-add it from that reading alone.
 *  That is exactly the mistake that put "ultra" here on 2026-07-10; verify per-model wire support
 *  first, the same way "none" and "ultra" were verified for this list. */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/** WINTER-LEVEL effort tiers (provider-correctness T5) — selectable in Winter, **never on the wire**.
 *
 *  This is a STRICTLY DISJOINT vocabulary from `REASONING_EFFORTS` above, and the two live next to
 *  each other so nobody reads one without the other. `REASONING_EFFORTS` is what the endpoint's
 *  request validator accepts. A value here is a Winter product decision that is TRANSLATED to a wire
 *  effort (`wireEffort` below) before any request body exists, plus whatever local behaviour the
 *  tier names.
 *
 *  `ultra` belongs here precisely BECAUSE the wire refuses it — the same global `invalid_value`
 *  enum documented above. It was never a real API level; it was a catalogue misreading. What the
 *  user actually wanted from it (the thing that made it look real) is now what it means in Winter:
 *  `max` on the wire, plus a proactive-delegation posture in the system prompt
 *  (`ULTRA_DELEGATION_INSTRUCTION`, agent/context.ts). Code sessions only — see
 *  `clientEffortEligible`.
 *
 *  **Never merge these into `REASONING_EFFORTS`, and never let them into `effortsForModel`**
 *  (ipc/sync.ts): that function is the single source for BOTH what `sync.config` advertises as a
 *  model's levels AND what `session.setEffort` accepts as a wire effort, so a tier inside it would
 *  make the daemon advertise a value its own turn would be 400'd on — the original bug, arriving
 *  through the fix. Tiers ride `sync.config`'s own `clientEfforts` field instead. */
export const CLIENT_EFFORTS = ["ultra"] as const;
export type ClientEffort = (typeof CLIENT_EFFORTS)[number];

/** The WIRE effort each tier is translated to. A `Record<ClientEffort, …>` on purpose: adding a
 *  tier to `CLIENT_EFFORTS` without deciding what it sends is a TYPE ERROR here, not a runtime
 *  surprise at the request layer. The value type is pinned to `REASONING_EFFORTS` for the same
 *  reason — a mapping to something the wire refuses cannot be written. */
const CLIENT_EFFORT_WIRE: Record<ClientEffort, (typeof REASONING_EFFORTS)[number]> = {
  // "reason as hard as the endpoint allows" — the honest wire meaning of the tier.
  ultra: "max",
};

/** Whether `effort` is a Winter-level tier rather than a wire effort. Undefined (no selection) is
 *  not a tier. */
export function isClientEffort(effort: string | undefined): effort is ClientEffort {
  return effort !== undefined && (CLIENT_EFFORTS as readonly string[]).includes(effort);
}

/** Translate a SELECTED effort (a wire effort, a Winter tier, or nothing) into what may go on the
 *  wire. TOTAL by construction: every result is either `undefined` or a member of
 *  `REASONING_EFFORTS`, so no caller downstream of this can hand a tier to a provider. Applied at
 *  `AgentEngine.resolveSel` — the one place a session's stored effort becomes a request field. */
export function wireEffort(effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined;
  return isClientEffort(effort) ? CLIENT_EFFORT_WIRE[effort] : effort;
}

/** Which session modes may SELECT a client tier: CODE ONLY.
 *
 *  A tier changes the system prompt, and chat/dispatch have their own base prompts and their own
 *  narrow toolsets (a chat session has no `spawn_agent` at all, so a delegation posture there would
 *  be an instruction to use a tool it does not have — the exact machine-touching-capability leak
 *  `skillToolOffered` exists to prevent, in a different slot).
 *
 *  An ALLOWLIST, deliberately fail-CLOSED, and deliberately NOT `engine.ts`'s `resolveMode` (which
 *  defaults an unrecognised mode to "code"). They agree on every mode that exists today; on a mode
 *  nobody has written yet they disagree, and "not this one" is the safe default for something that
 *  rewrites the prompt. `undefined` is code by the store-wide `mode ?? "code"` convention. */
export function clientEffortEligible(mode: string | undefined): boolean {
  return mode === undefined || mode === "code";
}

/**
 * THE ONE effort-selection rule: why `effort` may NOT be selected for `model` on a `mode` session, or
 * `undefined` when it may. `session.setEffort` / `session.create` throw this text; the session store
 * clears a stored effort a model change made stale; the spend path drops one that is stale anyway
 * (an old row, a phone-synced session) rather than send the child something it refuses typed —
 * "model … declares no effort vocabulary, so no effort level can be verified for it" ended the turn.
 * One function so those four can never disagree about what a model takes.
 *
 * The two branches are ALTERNATIVES, not layers: a Winter-level tier (`ultra`) never reaches the
 * endpoint, so it is judged by the session's MODE only and never by the row's vocabulary. A wire
 * level is judged by the row: a catalog row with no vocabulary takes none; a row with one takes only
 * what it lists (plus `"none"`); a tag the catalog does not know (a BYO endpoint) is unconstrained.
 */
export function effortRefusalFor(effort: string, model: string, mode: string | undefined): string | undefined {
  const vocabulary = effortVocabularyFor(model) ?? [];
  const allowed = vocabulary.length > 0 ? ["none", ...vocabulary] : [];
  if (isClientEffort(effort)) {
    if (clientEffortEligible(mode)) return undefined;
    return `effort '${effort}' is a Winter-level tier offered on code sessions only — this is a '${mode ?? "unknown"}' session (wire efforts: ${allowed.join(", ")})`;
  }
  if (allowed.length === 0 && model && rowForTag(model) !== undefined) {
    return `model '${model}' declares no reasoning-effort vocabulary — an effort cannot be set for it (leave it on the provider's default)`;
  }
  if (allowed.length > 0 && !allowed.includes(effort)) {
    const forModel = model ? `by model '${model}'` : "by the configured provider";
    return `effort '${effort}' is not accepted ${forModel} — supported: ${allowed.join(", ")}`;
  }
  return undefined;
}

/**
 * WS-20 (review round 4): the ONLY two providers the daemon's own internal `Provider`
 * (`providers/manager.ts`, ONE instance per daemon process — titles/the bash reviewer/dreamer/the
 * session cleaner/research/turn compaction all call through it) can actually be BUILT for.
 * `createProvider` uses this as its own predicate, answering `null` for anything else (never
 * mis-building an OpenAI-compatible client pointed at a provider it was never meant to speak to);
 * `daemon.ts` treats a `null` as "no internal Provider" and logs ONE line naming what goes inert —
 * never a boot refusal.
 *
 * WS-20 (review round 2, M6 — SUPERSEDED by round 4): a prior round gated `settings.provider.model`
 * itself to this set at the schema door (`ProviderModelTagSchema`, since removed). That broke the
 * ordinary "my default chat model is Claude" case: a SESSION with no explicit override falls back
 * to `settings.provider.model` too (`session-driver.ts`'s `create()`), and that fallback is meant
 * to be UNCONSTRAINED — any catalog provider, routed per-session through the runtime SDK, same as
 * an explicit `model` on `session.create` always has been. The constraint belongs where the
 * internal Provider is actually BUILT, not on the field a session's own default also reads.
 *
 * 2026-09-19 — THIS CONSTANT NO LONGER GATES ANYTHING. Winter's own background jobs run on any
 * provider in `internalEligibleProviderIds()` (below) that holds a credential, whatever
 * `settings.provider.model` says, so neither the builder nor the roles consult this set as a
 * predicate. It survives as the HEAD of `internalProviderPreferenceOrder()`: the two providers those
 * jobs have always run on, preferred over a third-party key that happens to be stored too. The
 * retired single-instance builder in `providers/manager.ts` still reads it; nothing else should.
 */
export const INTERNAL_PROVIDER_IDS = ["codex-oauth", "openai"] as const;

/** WS-20: the core-side tag schema — checks SHAPE (protocol's `ModelTagSchema`) AND provider
 *  EXISTENCE against the pinned catalog (`isModelTag`), unlike the protocol package's own
 *  shape-only `ModelTagSchema`. */
export const ModelTagSchemaCore = z.string().refine(isModelTag, "model must be a provider-qualified tag '<providerId>/<modelId>'");

/** WS-20: no `type`, no `baseUrl` — the provider IS the tag's prefix (`splitTag(model).providerId`),
 *  and a BYO endpoint lives in the sibling `providers.<id>.baseUrl` block below, never here.
 *  `.strict()` so a stray legacy `type` field on a hand-edited/un-migrated settings.json throws
 *  rather than being silently stripped — the migration (`migrateSettingsV2ToV3`) is the ONLY place
 *  that reads and discards it.
 *
 *  WS-20 (review round 4): `model` is the SAME `ModelTagSchemaCore` every other model-bearing field
 *  uses — any catalog provider, or `winter-test/*` — never narrowed to `INTERNAL_PROVIDER_IDS` (see
 *  that constant's own doc for why the round-2 narrowing broke a real Mac-default scenario). */
export const ProviderSettings = z.object({
  model: ModelTagSchemaCore,
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
}).strict();

export const PermissionsSettings = z.object({
  additionalDirectories: z.array(z.string()).optional(),
  /** CC-grammar allow-rules (SP-approvals T1, `agent/permission-rules.ts`'s `PermissionRules`
   *  class) — global-scope rule strings like `"Bash(git push:*)"`/`"Edit"`/`"Computer"`. Additive
   *  optional key: schemaVersion stays 2, no migration needed. Absent means "no global rules
   *  configured here"; the CC-parity `["Computer"]` default is NOT this field's default — it is
   *  applied by the daemon's OWN getter fallback (Task 3), so an explicit `"allow": []` can
   *  disable that default outright. */
  allow: z.array(z.string()).optional(),
  /** SP-approvals T10 (spec §7 "Web tools"): user-added dangerous-domain entries — the effective
   *  set web_fetch's pre-exec floor checks against is `agent/dangerous-domains.ts`'s
   *  SHIPPED_DANGEROUS_DOMAINS ∪ this array. Additive optional key: schemaVersion stays 2, no
   *  migration needed. Absent (or `added` absent) means "no user additions" — the shipped list
   *  alone is still enforced. Removing an entry HERE is how a user-added domain is removed; the
   *  shipped list itself is immutable by construction (there is no equivalent of `allow: []`'s
   *  "opt out of a default" for it — a shipped entry can never be deleted this way). */
  dangerousDomains: z.object({
    added: z.array(z.string()).optional(),
  }).optional(),
  /** Daemon settings surface batch 3 (item 2): SDK-grammar DENY rules — `Options.permissions.deny`
   *  string entries (`"Skill(<name>)"`, `"Agent(<type>)"`, …), forwarded verbatim to BOTH legs
   *  (`mode-options.ts`'s `permissionDenyRulesFor`, reused by `official-options.ts`) alongside the
   *  fixed control-plane fence (`controlPlaneDenyRules`). This is a COMPLETELY SEPARATE mechanism
   *  from `allow` above: `allow` feeds Winter's OWN engine-level approval gate
   *  (`agent/permission-rules.ts`'s `PermissionRules`, a different grammar/evaluator entirely) and
   *  never reaches `Options` at all; `deny` here rides straight into the pinned runtimes' own
   *  permission evaluator, unparsed by anything in this repo. GLOBAL-scope only, the same posture
   *  `allow`'s own doc states — a trusted project's `.winter/settings.json` cannot add to or clear
   *  this list (no union-merge wiring for it in `project-settings.ts`, deliberately: unlike
   *  `allow`/`additionalDirectories`, this is not a per-project override surface today). The one
   *  shipped writer is `settings.setSkillDenied` (`ipc/server.ts`), which toggles a single
   *  `Skill(<name>)` entry; a hand-written entry of any other shape is preserved and forwarded
   *  unchanged (never validated against a known grammar — that is the pinned runtimes' job). */
  deny: z.array(z.string()).optional(),
});

/** The default `runtimes.winterIdleTimeoutSec`, spelled once so the schema and the absent-block
 *  answer cannot drift (the same pairing `retention.ts` keeps for its two windows). */
export const DEFAULT_WINTER_IDLE_TIMEOUT_SEC = 900;

/** Daemon settings surface batch 3 (item 3b): the three `settings.mcpServers` entry shapes,
 *  mirroring the agent SDK's own `Options.mcpServers` process-transport union field-for-field
 *  (`McpStdioServerConfig`/`McpHttpServerConfig`/`McpSSEServerConfig`, `@yanlinglabs/winter-agent-sdk`)
 *  rather than inventing a fourth shape — an `McpSdkServerConfig` (in-process, carries a live JS
 *  instance) has no settings-file representation and is deliberately NOT one of these three.
 *  `enabled` is NOT one of the mirrored SDK fields — see `mcp.disabled` below for why Winter's own
 *  "disable" spelling is a separate, name-keyed list instead of a per-entry flag here. */
const McpStdioServerSettings = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * RULING (fix wave, pre-merge review, item 6): `<home>/settings.json` is model-readable — reads are
 * deliberately unrestricted (CLAUDE.md), and the bash sandbox/deny-rule fence only ever covers
 * WRITES to it — so a bearer token or API key sitting in an HTTP/SSE MCP server's `headers` is
 * agent-exfiltratable the moment any tool reads the file. That is the REAL tension with the hard
 * "secrets live in the macOS Keychain… never on disk" rule: not the file's existence, this ONE field
 * specifically. Refused at the settings door, case-insensitively, UNTIL `${env:VAR}`-style
 * indirection or a Keychain locator exists for `headers` (neither is implemented today — this
 * refusal is what stands in for that door until one lands): the four well-known credential-bearing
 * header names, plus any name containing "token" or "secret" anywhere. Deliberately broad rather
 * than an exact list — a header carrying credential material overwhelmingly says so in its own name
 * (`X-Auth-Token`, `X-Secret-Key`, …), and the cost of a false positive (a legitimately-but-oddly-
 * named benign header) is far lower than a missed credential landing on disk in the clear. A benign
 * header (`Accept`, `X-Request-Id`, a custom non-credential marker, …) still passes through
 * unchanged. This is a DELIBERATE, DOCUMENTED narrowing of what the SDKs themselves accept for
 * `Options.mcpServers` — the pinned agent SDK's own `McpHttpServerConfig`/`McpSSEServerConfig`
 * place no such restriction on `headers`, only Winter's own settings door does, ahead of the SDK.
 */
const CREDENTIAL_HEADER_EXACT_NAMES = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization"]);
function isCredentialShapedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_HEADER_EXACT_NAMES.has(lower) || lower.includes("token") || lower.includes("secret");
}
function refuseCredentialShapedHeaders<T extends z.ZodObject<{ headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>> }>>(schema: T) {
  return schema.superRefine((value, ctx) => {
    for (const name of Object.keys(value.headers ?? {})) {
      if (!isCredentialShapedHeaderName(name)) continue;
      ctx.addIssue({
        code: "custom",
        path: ["headers", name],
        message:
          `header "${name}" looks credential-shaped (Authorization/X-Api-Key/Cookie/Proxy-Authorization, or a name containing "token"/"secret") — ` +
          `settings.json is model-readable, so MCP headers are not yet a safe place for credentials; use \${env:VAR}-style indirection once it exists, never a literal secret here`,
      });
    }
  });
}

/**
 * READ-DOOR companion to `refuseCredentialShapedHeaders` above (the WRITE-door refusal, unchanged
 * — `saveSettings` and every direct `Settings.parse`/`Settings.safeParse` caller still refuse a
 * credential-shaped header, full stop). A `settings.json` a HUMAN hand-edited can carry one the
 * moment they save the file outside Winter entirely, and refusing to *load* such a file is far
 * worse than the leak the write door guards against: `loadSettings` throwing is exactly what
 * `daemon.ts`'s boot catch turns into `"settings unavailable, agent disabled"` — disabling EVERY
 * session on the machine over ONE header on ONE configured MCP server. So the read door does the
 * opposite of the write door: it silently (to the schema) DROPS just the offending header key —
 * never the whole `headers` object, never the whole server entry, never the rest of the file — and
 * hands the caller back what it removed, per server, so `loadSettings` can log it and `mcp.list`
 * can report it.
 *
 * Scoped to `http`/`sse` entries ONLY, matching exactly what `refuseCredentialShapedHeaders` is
 * wired onto above — a stdio entry has no `headers` field in its schema at all, so a stray
 * `headers` object on one is already dropped wholesale by zod's ordinary unknown-key stripping;
 * walking it here would log a misleading "dropped from headers" line for a key that was never
 * going anywhere near a wire request.
 *
 * Pure and non-throwing: operates on `raw` — the UNTYPED, pre-schema-validation JSON — so it runs
 * identically across every `loadSettings` schemaVersion branch (the field's shape is unchanged by
 * the v2→v3 migration). MUTATES `raw` in place (deleting the offending keys): every `loadSettings`
 * call site passes a freshly-`JSON.parse`d object it owns exclusively, and `mcp.list`'s own
 * read-only use (`ipc/server.ts`, against a throwaway `readRawSettings` result it discards right
 * after reading the returned map) has no other observer to surprise.
 *
 * NOTE (read this before assuming the header survives on disk): stripping happens only in memory,
 * at load time — the file itself is untouched by this function. But the header does NOT reliably
 * survive on disk either: `saveSettings`'s own round-trip merge (`mergeUnknownKeys`) takes a
 * `mcpServers` entry from the IN-MEMORY value wholesale (a `z.preprocess` value schema hits that
 * function's leaf branch), so the very next UNRELATED settings write on that home (an `mcp.disable`,
 * a `setSkillDenied`, a plugin toggle — anything at all that round-trips through `loadSettings` →
 * `saveSettings`) persists the ALREADY-STRIPPED shape, permanently removing the hand-edited header
 * from the file. This is accepted, not a bug to route around here: the alternative (restoring the
 * header so it can round-trip) would make `saveSettings`'s post-merge `Settings.safeParse` refuse
 * every subsequent unrelated write on that home — reintroducing a version of the exact outage this
 * function exists to remove, just one write later instead of one load later.
 */
export function stripCredentialShapedMcpHeaders(raw: unknown): Record<string, string[]> {
  const stripped: Record<string, string[]> = {};
  const servers = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).mcpServers : undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return stripped;
  for (const [name, entryUnknown] of Object.entries(servers as Record<string, unknown>)) {
    if (!entryUnknown || typeof entryUnknown !== "object" || Array.isArray(entryUnknown)) continue;
    const entry = entryUnknown as Record<string, unknown>;
    if (entry.type !== "http" && entry.type !== "sse") continue; // stdio (or typeless-stdio) has no headers field at all
    const headers = entry.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) continue;
    const headersObj = headers as Record<string, unknown>;
    const offending = Object.keys(headersObj).filter(isCredentialShapedHeaderName);
    if (offending.length === 0) continue;
    for (const headerName of offending) delete headersObj[headerName];
    stripped[name] = offending;
  }
  return stripped;
}

/** Process-lifetime dedupe key set for the read-door strip's log line — `loadSettings` has ~30 call
 *  sites across the daemon/CLI, several re-invoked on every RPC (`mcp.list`, `capabilities.list`,
 *  every settings-writing handler re-reads before it writes) — without this, a single hand-edited
 *  header would print a fresh stderr line on every one of those calls for as long as the daemon
 *  runs, which is not what "log exactly one stderr line per offending entry" means. Keyed on the
 *  file path too, so two different homes (or two different temp-dir test fixtures) with the SAME
 *  server/header name each still get their own line. Never cleared — intentionally process-lifetime,
 *  matching the "logged once" posture of this file's other boot-time "accepted, logged, ignored"
 *  lines (`winterLegDisabledKeys`/`officialSubscriptionAuthFlagInert`), which log once per settings
 *  CHANGE rather than once per read for the same reason. */
const loggedCredentialHeaderStrips = new Set<string>();

const McpHttpServerSettings = refuseCredentialShapedHeaders(z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
}));
const McpSSEServerSettings = refuseCredentialShapedHeaders(z.object({
  type: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
}));
/** A pre-item-3b entry (no `type` field at all) is stdio — the shape every `settings.mcpServers`
 *  entry has always had — normalized to the explicit-discriminant form BEFORE the discriminated
 *  union runs, so an existing home's settings.json keeps parsing byte-for-byte with no migration.
 *  A malformed entry (missing `command` on a stdio-shaped one, a non-URL `url`, an unrecognized
 *  `type`, …) fails with the discriminated union's own per-branch message — a useful "which shape
 *  did you mean" error rather than a plain-union's aggregated wall of text.
 *
 *  NEVER reuse this schema (including its `refuseCredentialShapedHeaders` refinement) for a
 *  project's `<cwd>/.mcp.json` — a review round briefly did, which silently dropped a git-shared
 *  http/sse entry the moment it carried an `Authorization` header (claude's own reader accepts and
 *  forwards such headers verbatim). `agent/mcp/project-file.ts`'s `ProjectMcpEntrySchema` is the
 *  project-scope equivalent, defined fresh there without that refinement — see its own header for
 *  the ruling. This one stays private to `settings.ts` (not exported as a value) again. */
const McpServerSettingsEntry = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) && !("type" in v) ? { ...(v as object), type: "stdio" } : v),
  z.discriminatedUnion("type", [McpStdioServerSettings, McpHttpServerSettings, McpSSEServerSettings]),
);
export type McpServerSettingsEntry = z.infer<typeof McpServerSettingsEntry>;

export const Settings = z.object({
  schemaVersion: z.literal(3),
  provider: ProviderSettings,
  permissions: PermissionsSettings.optional(),
  mcpServers: z.record(z.string(), McpServerSettingsEntry).optional(),
  /** Daemon settings surface batch 3 (item 3a): which CONFIGURED MCP servers are disabled, by
   *  NAME. A name-keyed denylist — not a per-entry `enabled` flag on `mcpServers` above — because
   *  it is the one shape that can name a server regardless of which tier configured it (today only
   *  `settings.mcpServers`, but a trusted project's `.mcp.json` server shares the same tool-name
   *  key space and could be named here too without needing its own settings-file entry to carry a
   *  flag on). Mirrors claude's own `disabledMcpjsonServers` concept — same idea, Winter's own
   *  settings shape (a flat name list, not nested under `mcpServers` itself, so disabling a server
   *  never touches its config block). A disabled server is withheld from BOTH legs
   *  (`external-mcp.ts`'s `configuredMcpServersFor`) and from the daemon's own boot-time
   *  `McpManager.startAll` (`daemon.ts`), and `mcp.list` reports it as `status: "disabled"`. */
  mcp: z.object({
    disabled: z.array(z.string()).optional(),
  }).optional(),
  reviewer: z.object({
    enabled: z.boolean().optional(),
    model: ModelTagSchemaCore.optional(),
    allow: z.array(z.string()).optional(),
    // Phase 5e T4: per-class on/off, subordinate to `enabled` — an `enabled:false` reviewer
    // never runs regardless of what's set here (engine.ts ANDs reviewerEnabled with
    // reviewClassEnabled at every call site). Absent block OR an absent per-class key means
    // enabled — same optional-means-default-true shape as engine.ts's own reviewClassEnabled.
    classes: z.object({
      bash: z.boolean().optional(),
      fs: z.boolean().optional(),
      external: z.boolean().optional(),
    }).optional(),
  }).optional(),
  titles: z.object({
    enabled: z.boolean().optional(),
    model: ModelTagSchemaCore.optional(),
  }).optional(),
  /** CC-parity output style: the active style NAME (built-in or a `.winter/output-styles/<name>.md`).
   *  Absent or "default" → Winter's base prompt (today's behavior). Hot-reloaded; per-project via the
   *  ProjectSettingsResolver. */
  outputStyle: z.string().optional(),
  plugins: z.object({
    enabled: z.array(z.string()).optional(),
    disabled: z.array(z.string()).optional(),
    /** Per-plugin consent records, keyed by the qualified `"<name>@<marketplace>"` spec. WS-21 fix
     *  round 2 (C1): `{classes: string[], fingerprint: string}`, bound to the plugin's install path
     *  + entry at grant time (`plugins/consent-fingerprint.ts` has the full ruling) — superseding
     *  the pre-fix `{exec?: ts, tcc?: ts, hardware?: ts}` per-class-timestamp shape. Typed
     *  `z.unknown()` here, DELIBERATELY not validated against either shape: a pre-fix record must
     *  still parse successfully (it is the CONSUMER, `consentedClassesFor`, that treats anything but
     *  the new fingerprinted shape as "not consented" — never a zod rejection, which would rollback
     *  the WHOLE settings file to keep-last-good over one stale plugin's consent record). */
    consents: z.record(z.string(), z.unknown()).optional(),
    /** PluginSupervisor lifecycle overrides (Phase 4b Task 3, spec §3 — all four values are
     *  spec-defaulted when omitted: registration timeout 10s, backoff cap 60s, circuit 5
     *  failures/10min). The invoke timeout (default 60s) and the SIGTERM→SIGKILL kill grace (5s)
     *  are deliberately NOT here — spec pins the former to the `WINTER_PLUGIN_TOOL_TIMEOUT_MS` env
     *  var and the latter isn't settings-overridable at all. */
    supervisor: z.object({
      registrationTimeoutMs: z.number().int().positive().optional(),
      backoffCapMs: z.number().int().positive().optional(),
      circuitFailures: z.number().int().positive().optional(),
      circuitWindowMs: z.number().int().positive().optional(),
    }).optional(),
  }).optional(),
  toolSearch: z.object({
    enabled: z.boolean().optional(),
    deferThreshold: z.number().int().positive().optional(),
    // "always": externals (mcp__/plugin__) defer whenever ANY is visible, ignoring deferThreshold's
    // count comparison entirely. Absent/"count" = today's threshold-count behavior, unchanged.
    deferExternals: z.enum(["count", "always"]).optional(),
  }).optional(),
  worktree: z.object({
    baseRef: z.enum(["fresh", "head"]).optional(),
  }).optional(),
  subagents: z.object({
    maxConcurrent: z.number().int().positive().optional(),
    // 4h-i Task 3 (CC parity: nesting depth up to 5): how many levels of spawn_agent nesting are
    // allowed — a thread at depth < maxDepth may spawn a child; a thread AT maxDepth cannot.
    // Default 5 when unset (engine.ts's `subagentMaxDepth ?? 5`) — matches Claude Code's fixed
    // max nesting depth of 5 (user decision 2026-07-11: "whatever Claude Code does"). Lower it
    // (e.g. `maxDepth: 1`, the pre-4h-i behavior where a depth-1 child could never spawn further)
    // to restrict nesting. Concurrency (maxConcurrent, default 4) and total fan-out are separate:
    // total spawns per session are UNLIMITED by design (user decision), bounded only by the
    // concurrency semaphore at any instant.
    // CC itself allows depth 5, hence the upper bound here.
    maxDepth: z.number().int().min(1).max(5).optional(),
    /** No-timeout task (user rule 2026-07-12): an EXPLICIT wall-clock cap per subagent run, in
     *  ms. ABSENT (the default) means NO wall clock at all — subagents are never killed just for
     *  running long (a legitimate laptop-wide scan died at the old always-on 300s cap; CC has no
     *  wall-clock subagent timeout either). Hot: read via a live getter (daemon.ts) — an edit
     *  applies to the very next subagent run, no daemon restart. */
    timeoutMs: z.number().int().positive().optional(),
    /** No-timeout task: the progress-STALL watchdog window, in ms — a subagent whose provider
     *  stream produces NO events for this long is aborted as stalled (its partial output is
     *  surfaced to the parent). ABSENT means the default 600000 (10 min — deliberately ≥ bash's
     *  own max per-call timeout, so a tool-bounded silent bash never falsely trips it; env
     *  override: WINTER_SUBAGENT_STALL_TIMEOUT_MS). Hot, same live-getter semantics as timeoutMs
     *  above. */
    stallTimeoutMs: z.number().int().positive().optional(),
  }).optional(),
  /** Peripheral lease v1 (Phase 2f, spec §A1): "Heartbeat 5s / expiry 15s (user-confirmed;
   *  settings-overridable peripheral.heartbeatMs/expiryMs)". Both optional — PeripheralBroker
   *  falls back to the spec defaults (5000/15000) when omitted. */
  peripheral: z.object({
    heartbeatMs: z.number().int().positive().optional(),
    expiryMs: z.number().int().positive().optional(),
  }).optional(),
  /** Computer use (Phase 5 CU). `enabled` is the capability opt-in: the `computer` tool is
   *  registered ONLY when true (the strongest reading of "full-auto CU requires explicit opt-in" —
   *  absent/false means CU does not exist for the session). `screenshotMaxDim` caps the longest
   *  side of a captured screenshot (default 1280, Winter.app-side) to bound the base64 payload well
   *  under the NDJSON line limit and the model's image budget. The lease heartbeat/expiry reuse the
   *  `peripheral` block above. */
  computerUse: z.object({
    enabled: z.boolean().optional(),
    screenshotMaxDim: z.number().int().positive().optional(),
  }).optional(),
  /** web_search backend (4g Task 6). `provider` defaults to "brave" when the block/field is
   *  absent — the literal union is forward-room for other search backends later; today "brave"
   *  is the only accepted value. */
  webSearch: z.object({
    provider: z.literal("brave").optional(),
  }).optional(),
  /** Plugin hooks runtime (Phase 4f, plan Global Constraints: "default true, read like other hot
   *  settings"). `enabled: undefined` (block absent OR field absent) means ENABLED — see
   *  `hooksEnabledFrom` below, the single place that decision is made. */
  hooks: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  /** Scheduled routines (Phase 5, design doc header — USER-DECIDED pin: "routines run in
   *  PARALLEL ... routines.maxConcurrent? settings knob, default unlimited"). Undefined (block or
   *  field absent) means unlimited — mirrors subagents.maxConcurrent's own optional-means-default
   *  shape above, read once at daemon boot (same boot-snapshot precedent as subagents.maxConcurrent,
   *  not hot-reloaded — routines/scheduler.ts's makeRoutineScheduler takes it as a `() => number |
   *  undefined` thunk purely to match its own injectable-dependency shape, not because this needs
   *  to change without a daemon restart). */
  routines: z.object({
    maxConcurrent: z.number().int().positive().optional(),
  }).optional(),
  /** LSP integration (Phase 5f; consolidated into the single `lsp` tool by lsp-consolidation T2,
   *  design doc `2026-07-15-lsp-consolidation-design.md`) over a lazily-spawned
   *  typescript-language-server/sourcekit-lsp. `enabled` is default-ON, the SAME boot-snapshot
   *  shape as `reviewer.enabled`/`titles.enabled` above (an explicit `false` is the only way to
   *  turn it off; block absent, field absent, or `true` all mean the `lsp` tool gets registered —
   *  daemon.ts's registerLspTools gate reads `settings?.lsp?.enabled !== false`).
   *  When off, the tool is never registered, so a model's query for it is the registry's
   *  ordinary "unknown tool" error — no special-cased denial path. `idleShutdownMs` threads
   *  straight into `new LspManager({idleShutdownMs})`; absent means the manager's own default
   *  (300_000 — 5 min, agent/lsp/manager.ts's DEFAULT_SCHEDULER-adjacent constant).
   *  `autoDiagnostics` (lsp-consolidation T3, design doc §2 — CC parity: "after each file edit, it
   *  automatically reports type errors and warnings so Claude can fix issues without a separate
   *  build step") is ALSO default-ON, same `!== false` shape — see `lspAutoDiagnosticsEnabledFrom`
   *  below, the one place that decision is made. Read LIVE (hot, per
   *  [[no-daemon-restart-for-settings]]) by engine.ts's post-write/edit/notebook_edit hook — a
   *  toggle applies to the session's NEXT edit, no restart. Independent of `enabled`: turning THIS
   *  off still leaves the on-demand `lsp` tool (action: diagnostics) usable; only the automatic
   *  post-edit append is skipped. */
  lsp: z.object({
    enabled: z.boolean().optional(),
    idleShutdownMs: z.number().int().positive().optional(),
    autoDiagnostics: z.boolean().optional(),
  }).optional(),
  /** Auto-update channel. "beta" additionally receives beta-tagged appcast items;
   *  absent/stable = stable only. Read live by the app at each update check (hot — no restart). */
  updates: z
    .object({
      channel: z.enum(["stable", "beta"]).optional(),
    })
    .optional(),
  /** File-based memory (MEMDIR, T1 — design doc `2026-07-15-file-based-memory-design.md`).
   *  `enabled` default-ON, the SAME `!== false` boot-snapshot-shaped default as `lsp.enabled`/
   *  `hooks.enabled` above, but read LIVE (hot, per [[no-daemon-restart-for-settings]]) by both
   *  daemon.ts's write-root join and context.ts's injection — a toggle takes effect on the
   *  session's NEXT tool call / turn, no restart. `directory` (absolute or `~/`-relative) replaces
   *  the computed `~/.winter/projects/<key>/memory` path entirely (CC's own relocatable-directory
   *  setting) — see memory-dir.ts's `memoryDirFor`. */
  memory: z
    .object({
      enabled: z.boolean().optional(),
      directory: z.string().optional(),
    })
    .optional(),
  /** Dynamic workflows (CC-parity phase 3). `enabled` default-ON (`!== false`, same shape as
   *  hooks/memory/lsp above): the deferred Workflow tool is registered + /ultracode active only when
   *  true. `keywordTrigger` default-ON: `/ultracode` is inert when false, but the tool is still
   *  available to the model. Hot-reloaded, per-project via the ProjectSettingsResolver. */
  workflows: z.object({
    enabled: z.boolean().optional(),
    keywordTrigger: z.boolean().optional(),
  }).optional(),
  /** The session cleaner (session-activity-hygiene T7, spec §3) — the LLM-judged pass that deletes
   *  old, idle, unjudged junk sessions. `enabled` default-ON (`!== false`, the same shape as
   *  hooks/memory/lsp/workflows above), read LIVE by daemon.ts's `cleanerEnabledHot` closure over
   *  the hot-swapped settings holder: turning it off stops the very NEXT pass, and turning it back
   *  on resumes at the next one, with no daemon restart in either direction (the project's standing
   *  no-restart-for-settings rule).
   *
   *  Deliberately does NOT gate the empty-session reaper (T6) — that path deletes only sessions
   *  with no content at all and is not a judgment. */
  cleaner: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  /** Runtime-state housekeeping (P8a, WS-16 §16). Hot like every other key here: the retention
   *  sweep re-reads this through a live getter on each pass, so widening or narrowing a window
   *  takes effect at the very next sweep with no daemon restart (the project's standing rule).
   *
   *  `.prefault({})` RATHER THAN `.default({})` on the two inner blocks, and the difference is not
   *  cosmetic: in zod 4 a `.default()` value is the parsed OUTPUT, handed back verbatim without
   *  descending — so `.default({})` would make `runtimes: {}` parse with `retention` and
   *  `migrations` UNDEFINED, and the shipped 30/7 defaults would exist only in this file's prose.
   *  `.prefault` feeds the value back through the schema, which is what actually fills them in.
   *
   *  The BLOCK ITSELF is `.optional()`, like every other top-level key in this schema, rather than
   *  defaulted. Two reasons, both about not moving things that already work: a defaulted block makes
   *  `runtimes` REQUIRED on the inferred `Settings` type, which breaks every hand-built settings
   *  literal in the codebase (35 of them); and `saveSettings` writes the parsed object verbatim, so
   *  it would start stamping these defaults into every user's settings.json — freezing today's
   *  values into files that should have kept following the shipped default. The 30/7 answer for an
   *  absent block therefore lives in `retention.ts`'s `retentionFromSettings`, which is the door
   *  every consumer actually reads, and which must answer for `undefined` settings anyway.
   *
   *  The two windows have a floor of one day and must be whole days: a zero would prune a delivery
   *  record in the same second its receipt landed, destroying the evidence WS-15 §6.4 needs to tell
   *  `delivered` from `delivery_uncertain`. Neither window can ever reach an UNRECEIPTED delivery or
   *  a HELD name lease — those are pruned at no age at all (see `directory-store.ts`); retention
   *  only ever shortens the tail of things that are already settled.
   *
   *  `migrations.memoryKeys` is OFF until a user turns it on: WS-16 §17 phase 5 relocates a user's
   *  own memory files, and that is not a thing an upgrade does on its own initiative.
   *
   *  WHEN IT IS ON, THE MIGRATION RUNS (P8b-17, Task 14 — 8a's build accepted the flag and ignored
   *  it, because the live memory path still derived today's key). Three things are worth knowing
   *  before turning it on: a home whose `memory.directory` (above) pins the MEMDIR is DECLINED
   *  rather than migrated — the project key decides nothing there — and a decline is not an attempt,
   *  so clearing that override later still gets the migration with no restart; a completed
   *  relocation is one-shot (a `schema_meta` marker), while a run that could not finish (a
   *  destination to clear, a cwd to restore) retries at the next boot; and a relocation interrupted
   *  between its rename and its commit is repaired at EVERY boot, flag or no flag, so turning the
   *  flag back off can never strand a half-moved tree. See `runtime-state/migrations/memory-keys.ts`.
   *
   *  ── The Winter leg (8b) ──────────────────────────────────────────────────────────────────────
   *
   *  `winterLeg` DECIDED, per mode, whether a NEW session ran on the Winter runtime or on the
   *  legacy engine (P8b-13) while both existed. Task 17 retired the engine: every mode runs on the
   *  Winter leg, the keys are accepted for one release and a `false` is logged and ignored
   *  (`winterLegDisabledKeys` below names them for the log). A flag governs new sessions only: a session runs to
   *  completion on the leg it was created with, which is what makes flipping one safe at any moment.
   *
   *  `winterExecutable` overrides the `winter` binary lookup (P8b-2's first door, ahead of
   *  `WINTER_RUNTIME_EXECUTABLE`, the bundle drop and `<WINTER_HOME>/runtimes/bin/winter`).
   *  `advisorModel` names the model the router's advisor uses. Both are plain `z.string()` on
   *  purpose — NOT `.min(1)` — because an invalid `settings.json` costs the WHOLE FILE: boot
   *  degrades to `settings = null` and the agent is disabled (`daemon.ts`'s load catch), and a hot
   *  edit is discarded entirely by the watcher ("settings reload failed, keeping previous"). One
   *  blank string must not be able to do that. Blank therefore means absent, and
   *  `winterOptionsFromSettings` below is the door that says so once for every consumer.
   *  (`winterIdleTimeoutSec`'s floor CAN invalidate the file the same way — that is the deliberate
   *  shape the retention windows already have, and the brief mandates it; it is stated here so the
   *  asymmetry reads as a decision rather than an oversight.)
   *
   *  `winterIdleTimeoutSec` ends an idle Winter child (P8b-24) — the session becomes `resumable` and
   *  its next message resumes it, so this is a memory bound, not a session lifetime. The floor is
   *  10s rather than 1: below that, a child would be reaped between a user's own keystrokes.
   *
   *  THE DEFAULTS ONLY MATERIALIZE WHEN THE BLOCK IS PRESENT, because the block is `.optional()`
   *  (see above — a defaulted block would make `runtimes` required on every settings literal in the
   *  codebase, and `saveSettings` would start stamping today's values into every user's file). So
   *  an absent block has to be answered for, and `winterOptionsFromSettings` below is the ONE place
   *  that does it — the same shape `retentionFromSettings` has for the windows. Read that door
   *  rather than the raw block, or three lanes each re-derive "absent means all legs false" and
   *  "blank means absent", and nothing fails to compile when one of them forgets. */
  runtimes: z.object({
    retention: z.object({
      deliveriesDays: z.number().int().min(1).default(30),
      nameLeasesDays: z.number().int().min(1).default(7),
    }).prefault({}),
    migrations: z.object({ memoryKeys: z.boolean().default(false) }).prefault({}),
    winterExecutable: z.string().optional(),
    // P8c-3: the same blank-is-absent, restart-free ladder rung as `winterExecutable` above, for the
    // official leg's `claude` executable (`official-executable.ts`'s `resolveClaudeExecutable`,
    // ahead of env `WINTER_CLAUDE_EXECUTABLE`, the 8d bundle drop and the dev-only package door).
    claudeExecutable: z.string().optional(),
    // Winter Phase 10a (Lane L's own rung — `bundle-layout.ts`'s `resolveAntExecutable` ladder):
    // same blank-is-absent shape as `claudeExecutable` above, for the bundled Anthropic Platform
    // CLI (`ant`) the console-profile broker spawns. Lane O adds only the schema line here; Lane L
    // owns the resolver that reads it.
    antExecutable: z.string().optional(),
    // Task 17 Step 4: the engine is retired — every mode runs on the Winter leg. The block stays
    // ACCEPTED for one release (the `migrations.memoryKeys` pattern): a `false` is read, logged
    // ("the engine leg no longer exists; ignored") and ignored by `winterOptionsFromSettings`.
    winterLeg: z.object({
      chat: z.boolean().default(true),
      dispatch: z.boolean().default(true),
      code: z.boolean().default(true),
    }).prefault({}),
    // WS-20: stays a PLAIN `z.string()` (not the tag-refined schema) — same "blank must not
    // invalidate the whole file" reasoning as `winterExecutable` above. `setAdvisorModel`
    // validates a non-blank value with `isModelTag` at the WRITE door instead (see below); a
    // stored value is a `ModelTag` by construction of that door, never re-validated here.
    advisorModel: z.string().optional(),
    winterIdleTimeoutSec: z.number().int().min(10).default(DEFAULT_WINTER_IDLE_TIMEOUT_SEC),
    // Fix wave (whole-branch review C2 / ruling P8c-18): a `session.setModel` whose FRESH
    // destination decision names a DIFFERENT runtime leg than the session's recorded one is a
    // cross-runtime HANDOFF (`runtime-sdk/handoff.ts`). Winter Phase 10b (D1-1, W18-10, R-10b-1):
    // the real round-trip is now measured end to end (the whole-branch parity e2e coverage), so the
    // fence flips to default ON for Code sessions — chat and dispatch never reach the official leg
    // regardless (`select-runtime.ts`'s own mode gate), so they stay at the pre-10b "off" posture.
    // `crossRuntime` is deliberately left `.optional()` here rather than `.default()`ed, so a raw
    // parse can tell "never set" from an explicit `true`/`false` — same "absent isn't a value"
    // shape `winterExecutable`/`advisorModel` already have on this block. The MODE-AWARE default
    // lives in `handoffCrossRuntimeEnabled` below, the one door every reader goes through; an
    // explicit value here always overrides it, in every mode. `handoff.ts` reads this HOT
    // (`handoffCrossRuntimeEnabled(deps.settings(), mode)`), never a boot snapshot, same as every
    // other setting in this file.
    handoff: z.object({ crossRuntime: z.boolean().optional() }).prefault({}),
    // Phase 9c (P9c-1, the user's ruling on WS-00 §8 #1): the official leg authenticates ONLY with
    // Anthropic API-key material the user supplied to Winter. `subscriptionAuth: false` (the
    // default, and the ONLY shipped value until Anthropic approves subscription auth for Winter's
    // Agent SDK integration) means the spawned `claude` child gets a Winter-owned
    // `CLAUDE_CONFIG_DIR`, an env scrubbed of every auth-injecting variable except the one the
    // credential plan names, and a per-session assertion on the SDK's reported `apiKeySource`.
    // Read HOT (`official-options.ts`), never a boot snapshot.
    // WS-20: `official.auth` is REMOVED, not deprecated — the official leg's auth arm is now the
    // tag's own prefix (`anthropic/*` = API key, `console/*` = the Console profile;
    // `officialAuthArmFor`, official-options.ts). `subscriptionAuth` stays: it is orthogonal to
    // WHICH arm, gating whether a claude.ai subscription login is even permitted at all.
    // `.strict()` (unlike every sibling block in this schema, which strips unknown keys) so a
    // stray legacy `auth` field THROWS rather than being silently discarded — `auth` is REMOVED,
    // not deprecated, and the migration is the only place that reads and discards it.
    official: z.object({
      subscriptionAuth: z.boolean().default(false),
    }).strict().optional(),
  }).optional(),
  // Phase 9c (P9c-4, the user's ruling on WS-00 §8 #7): Winter reads a project's unconverted legacy
  // instructions file / project dir (`legacy-names.ts`'s `LEGACY_INSTRUCTIONS_FILE` / `LEGACY_PROJECT_DIR`) READ-ONLY when the Winter-named file/dir is absent and this is true —
  // with a visible per-project deprecation notice; `winter migrate-project` converts. Default ON,
  // indefinitely, until a later release flips the default. Read HOT, never a boot snapshot.
  // OPTIONAL (not prefaulted) for the same reason `runtimes` is: a prefaulted block becomes REQUIRED on
  // the inferred `Settings` type and breaks every hand-built settings literal. Absent block = default
  // ON; readers go through `legacyProjectFilesReadEnabled()` below, never the raw block.
  /**
   * WS-19 (W19-6): per-provider connection overrides, keyed by the CATALOG provider id
   * (`deepseek`, `zai`, `openrouter`, …) — the same ids `credential.list` reports and
   * `credential.set` writes a slot for.
   *
   * There is NO daemon-side endpoint table and there must never be one: the catalog ships every
   * provider's own `defaultEndpoints`, and the SDK's `connectionFrom` copies them for the
   * multi-provider adapters (deepseek/zai/openrouter/xai all ride `winter.openai-chat-completions`).
   * This block exists only for the case the SDK cannot answer — a self-hosted or proxied endpoint
   * for a provider whose shipped endpoint is not where the user's account lives, and the loopback
   * fakes the parity e2e tests point at.
   *
   * ABSENT IS THE NORMAL CASE. An entry without a `baseUrl` is the same as no entry: the session
   * gets no `connection` at all and the SDK fills the catalog endpoint.
   *
   * WS-20: `settings.provider.baseUrl` (the legacy single-provider `openai-compatible` arm) is
   * REMOVED from `ProviderSettings` — the v2→v3 migration copies it into `providers.openai.baseUrl`
   * ONCE, so a home that configured BYO OpenAI that way keeps working byte-identically without
   * this block's own precedence rule (a settings.ts function reading a now-nonexistent field would
   * be dead code, not a fallback).
   *
   * Read HOT at every incarnation (`session-driver.ts`'s `optionsFor` calls `deps.settings()`), so
   * adding or changing an endpoint takes effect on the next turn with no daemon restart — the
   * project's standing rule.
   *
   * `.url()` rather than a bare string, unlike `runtimes.winterExecutable`: a malformed endpoint
   * cannot be treated as "absent" the way a blank executable path can, because the only other
   * reading is "send the user's credential to whatever this parses as".
   */
  providers: z.record(z.string(), z.object({ baseUrl: z.string().url().optional() })).optional(),
  legacy: z.object({ readLegacyProjectFiles: z.boolean().default(true) }).optional(),
  /** WS-20: user-overridable per-slot model pins for the daemon's own callers (dispatch, dreaming, the
   *  session cleaner, and `research` — `WebFetch`'s page digest inside the runtime child since
   *  2026-09-18) — every key is optional; an absent key (or an absent block) falls back to `pinsFor`'s
   *  own default, the ONE reader every consumer goes through (never this raw block). See `pinsFor`
   *  below for the exact default rule.
   *
   *  `researchFallback` IS RETIRED AND STILL PARSED. Its only consumer was the multi-page research
   *  sub-agent, retired with `ReadPage` in the 2026-09-18 web-tools ruling. The key stays in this schema
   *  because a settings.json that stores one must still LOAD — dropping the key would make zod strip it
   *  on the next `saveSettings` and silently rewrite the user's file. `modelRoleInfo` marks the role
   *  retired instead, and `setModelRole` refuses to set a new value while still allowing a stored one to
   *  be cleared. Same rule for its `roleEfforts` key below. */
  pins: z.object({
    dispatch: ModelTagSchemaCore,
    dream: ModelTagSchemaCore,
    cleaner: ModelTagSchemaCore,
    research: ModelTagSchemaCore,
    researchFallback: ModelTagSchemaCore,
  }).partial().optional(),
  /**
   * 2026-09-18: the reasoning effort each MODEL ROLE runs at. The keys are `MODEL_ROLES`' own strings
   * VERBATIM — dots and all — and that is the entire reason for this shape: `settings.setModelRole`'s
   * wire `role` parameter IS the key here, so the write door needs no role→path mapping table to keep
   * in sync with `modelRoleConstraint`/`modelRoleInfo`. The alternative (an `effort` sibling inside
   * each role's own block — `pins.dispatchEffort`, `titles.effort`, …) would scatter one concept
   * across five blocks and put an effort under `runtimes`, where nothing else is per-role.
   *
   * EIGHT keys, not nine: `provider.model` is ABSENT by design. Its effort already has an established
   * home in the sibling `provider.reasoningEffort` above — what `winter model --effort` writes and
   * what every existing reader of the daemon's own default effort reads (`sync.config`'s
   * `defaultEffort`, the engine's `resolveSel`) — and duplicating it here would create two places to
   * disagree about one value. `roleEffortFor` (below) is the ONE reader that routes that role to its
   * real home; nothing else needs to know about the exception.
   *
   * Every key optional, the whole block optional: an absent entry means "nothing is STORED for this
   * role" — never a level this file computes. `roleEffortFor` is the one place that is spelled, per the
   * file-wide `.optional()`-block convention. (Corrected when the spend side landed: absent is NOT
   * always "no effort is sent" — four consumers have a code default of their own, `DREAM_EFFORT`,
   * `CLEANER_EFFORT`, `RESEARCH_EFFORT` and `DISPATCH_EFFORT`, and an absent entry leaves exactly that
   * in force. `effortToSpendForRole` is where stored-vs-default is decided.)
   *
   * The value type is `z.enum(REASONING_EFFORTS)` — the same schema `provider.reasoningEffort` uses,
   * for the same reason: a stored role effort is always something the wire will honour. Winter-level
   * tiers (`CLIENT_EFFORTS`) are excluded by construction and refused at the write door as well (see
   * `roleAcceptsClientEffort`), so no role can ever store a value the endpoint would 400 on.
   *
   * TWO KEYS ARE PARSED BUT UNSPENDABLE (2026-09-18): `pins.research` (the SDK's `WebFetchConfig` has no
   * effort field) and `pins.researchFallback` (its consumer retired). `roleCarriesEffort` answers `false`
   * for both, so the write door refuses one and `modelRoleInfo` reports `efforts: null`; the KEYS stay
   * here so a settings.json written while the door accepted one still loads and `effort: null` still
   * clears it — the same rule `runtimes.advisorModel`'s own key already follows.
   */
  roleEfforts: z.object({
    "pins.dispatch": z.enum(REASONING_EFFORTS),
    "pins.dream": z.enum(REASONING_EFFORTS),
    "pins.cleaner": z.enum(REASONING_EFFORTS),
    "pins.research": z.enum(REASONING_EFFORTS),
    "pins.researchFallback": z.enum(REASONING_EFFORTS),
    "titles.model": z.enum(REASONING_EFFORTS),
    "reviewer.model": z.enum(REASONING_EFFORTS),
    "runtimes.advisorModel": z.enum(REASONING_EFFORTS),
  }).partial().optional(),
});
export type Settings = z.infer<typeof Settings>;

/** WS-20 (review round 1, GUARD): the catalog providerId the daemon's SINGLE internal-calls
 *  `Provider` instance is actually bound to — `splitTag(settings.provider.model).providerId`, with
 *  the same `DEFAULT_PROVIDER` fallback `pinsFor` itself uses for a settings file with no
 *  `provider.model` at all. Extracted so `pinsFor`'s own `ownProvider` derivation and
 *  `providers/manager.ts`'s `internalModelFor` guard (dreamer/cleaner/research's own internal-
 *  Provider calls) read the identical "which provider is this daemon actually bound to" answer —
 *  they must never independently rederive it and risk disagreeing. */
export function ownProviderFor(settings: Settings | null | undefined): string {
  const providerModel = settings?.provider?.model ?? DEFAULT_PROVIDER.model;
  try { return splitTag(providerModel).providerId; } catch { return splitTag(DEFAULT_PROVIDER.model).providerId; }
}

/** WS-20: the ONE reader of `settings.pins.<slot>` — every default falls back to a `gpt-5.6-terra`
 *  (dispatch/dream/cleaner/researchFallback) or `gpt-5.6-luna` (research) row SERVED BY THE SAME
 *  PROVIDER as `settings.provider.model`, so a fresh install's internal callers run on whichever
 *  provider the user actually configured rather than an unrelated one. When that provider does
 *  NOT serve the pinned slot (e.g. `deepseek`, which has no `terra`/`luna` row), the default falls
 *  back to `openai` — the api-key vendor every gpt-5.6 slot is guaranteed to serve — never a
 *  fabricated tag, and never a throw: a settings file with no `provider.model` at all still gets a
 *  real answer via `DEFAULT_PROVIDER`. An explicit `settings.pins.<slot>` entry always wins over
 *  every default, per slot independently. */
export function pinsFor(settings: Settings | null | undefined): {
  dispatch: ModelTag; dream: ModelTag; cleaner: ModelTag; research: ModelTag; researchFallback: ModelTag;
} {
  // WS-20 (review round 2, M6 fix — R2): a `winter-test/*` primary is a provider-LESS test double —
  // it has no catalog family, so it serves no terra/luna slot at all, and `ownProviderFor` would
  // answer the literal string "winter-test" (never a pinned catalog provider). The OLD `UNSTATED_TAG`
  // default (correct for a REAL provider that genuinely serves no gpt-family slot) made every
  // winter-test-primary daemon's dispatch/dream/cleaner/research refuse outright, because the
  // harness's own double has no OTHER model to default to. Rule: the primary tag IS the pin — every
  // slot defaults to the SAME double the session itself runs on, unless an explicit
  // `settings.pins.<slot>` override says otherwise (still wins, unchanged).
  const primary = settings?.provider?.model ?? DEFAULT_PROVIDER.model;
  if (primary.startsWith(WINTER_TEST_PREFIX)) {
    return {
      dispatch: settings?.pins?.dispatch ?? (primary as ModelTag),
      dream: settings?.pins?.dream ?? (primary as ModelTag),
      cleaner: settings?.pins?.cleaner ?? (primary as ModelTag),
      research: settings?.pins?.research ?? (primary as ModelTag),
      researchFallback: settings?.pins?.researchFallback ?? (primary as ModelTag),
    };
  }
  const ownProvider = ownProviderFor(settings);
  // WS-20 (review round 2, M6): the OLD `?? facingNameToTag("openai", slotName)` rung silently
  // pinned dispatch/dream/cleaner/research to a DIFFERENT provider than the daemon's own configured
  // one whenever `ownProvider` did not itself serve the slot (e.g. an `anthropic/*` primary) — a
  // cross-provider guess this function has no business making. Dropped: a provider that does not
  // serve its own family's terra/luna slot yields `UNSTATED_TAG`, and every one of these doors
  // already refuses/skips typed on that sentinel (`internalModelFor`'s own guard, session-driver.ts's
  // dispatch door) rather than silently running on a provider nobody configured.
  // 2026-09-17 field report (0.114.1): with a DeepSeek/Claude primary every pin became the UNSTATED
  // sentinel, and an EXISTING dispatch record then resumed with `model: "unstated"` and no provider.
  // The pin now falls back to the user's OWN tag — still no provider chosen by code, it is the model
  // the user already picked. dream/cleaner/research additionally pass `internalModelFor`, so they
  // stay inert (typed, one log line) on a non-internal provider.
  const defaultFor = (slotName: "terra" | "luna"): ModelTag => {
    return facingNameToTag(ownProvider, slotName) ?? (primary as ModelTag);
  };
  const terra = defaultFor("terra");
  const luna = defaultFor("luna");
  return {
    dispatch: settings?.pins?.dispatch ?? terra,
    dream: settings?.pins?.dream ?? terra,
    cleaner: settings?.pins?.cleaner ?? terra,
    research: settings?.pins?.research ?? luna,
    researchFallback: settings?.pins?.researchFallback ?? terra,
  };
}

/** Phase 9c (P9c-4): the ONE reader of `legacy.readLegacyProjectFiles` — absent block or absent key
 *  means ON (the shipped default); only an explicit `false` turns the legacy read-only fallback off. */
export function legacyProjectFilesReadEnabled(settings: Settings | null | undefined): boolean {
  return settings?.legacy?.readLegacyProjectFiles ?? true;
}

/** WS-19 (W19-6): the ONE reader of `providers.<id>.baseUrl` — absent block, absent entry, absent
 *  key and a blank string all mean "no override", so callers never have to spell that themselves.
 *  WS-20: this is now the ONLY door — the legacy `provider.baseUrl` arm no longer exists on
 *  `ProviderSettings` at all (the v2→v3 migration copies a stored value in here once, on the
 *  provider it named, and drops the field). */
export function providerBaseUrlFor(settings: Settings | null | undefined, providerId: string): string | undefined {
  const url = settings?.providers?.[providerId]?.baseUrl;
  return url === undefined || url.length === 0 ? undefined : url;
}

/**
 * Daemon settings surface batch 3 (item 3): `settings.mcpServers` narrowed to the STDIO entries the
 * daemon's own `McpManager` can actually run (`daemon.ts`'s boot-time `mcp.startAll` call) — an
 * HTTP/SSE entry has no in-daemon client (`external-mcp.ts`'s own header explains why that is fine:
 * only the spawned child ever connects to those), so it is silently excluded here rather than
 * passed to a manager that would crash on a missing `command`. Also excludes anything named in
 * `settings.mcp.disabled` (item 3a) — the daemon's own shared registry must not run a server the
 * user disabled any more than a session's `Options.mcpServers` should. Shape matches
 * `agent/mcp/manager.ts`'s own `McpServerConfig` (`{command, args?, env?}`) field-for-field.
 */
export function stdioMcpServersFor(
  servers: Readonly<Record<string, McpServerSettingsEntry>> | undefined,
  disabledNames: readonly string[] | undefined,
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  const out: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  const disabled = new Set(disabledNames ?? []);
  for (const [name, entry] of Object.entries(servers ?? {})) {
    if (entry.type !== "stdio" || disabled.has(name)) continue;
    out[name] = { command: entry.command, ...(entry.args === undefined ? {} : { args: entry.args }), ...(entry.env === undefined ? {} : { env: entry.env }) };
  }
  return out;
}

// ── WS-21: the runtime-facing keys live in `<home>/sdk` (spec §4.1) ──────────────────────────────
//
// These keys MOVED to the shared runtime home's claude-format files. They stay in the `Settings`
// schema so an older build (a downgrade) still parses a home that carries them, but THIS daemon never
// reads them from `settings.json` again: `withoutMovedKeys` strips them from every live holder, and
// the readers below are the only doors to their values. The one-time copy (`settings.json` →
// `sdk/`) is Migration C's automatic settings split.
//
//   settings.json                         →  sdk/settings.json (claude `Settings`)
//   permissions.allow                         permissions.allow (claude grammar, translated once)
//   permissions.deny / additionalDirectories  same keys
//   outputStyle                               outputStyle
//   memory.enabled / memory.directory         autoMemoryEnabled / autoMemoryDirectory
//   plugins.enabled / plugins.disabled        enabledPlugins  (read by the plugin surface — lane L4)
//   mcpServers                            →  sdk/.winter.json `mcpServers` (claude's `.claude.json`)
//
// `permissions.dangerousDomains`, `mcp.disabled`, `plugins.consents` and everything else stay.

/**
 * The moved keys, dotted. `plugins.enabled`/`plugins.disabled` are listed (they moved) but NOT stripped
 * by `withoutMovedKeys`: the plugin surface that reads them switches to `sdkEnabledPlugins` with its
 * own lane (L4), and stripping them first would silently disable every plugin in between.
 */
export const MOVED_SETTINGS_KEYS = [
  "permissions.allow",
  "permissions.deny",
  "permissions.additionalDirectories",
  "outputStyle",
  "memory.enabled",
  "memory.directory",
  "plugins.enabled",
  "plugins.disabled",
  "mcpServers",
] as const;

/**
 * `settings` without the moved keys (except the plugin pair — see `MOVED_SETTINGS_KEYS`). Applied to
 * every live settings holder, so no reader of `settings.json` can see a stale copy, and a trusted
 * project's overlay (`ProjectSettingsResolver`) merges onto a base that no longer carries them. Never
 * mutates its argument; the file on disk is untouched (the keys stay there for a downgrade).
 */
export function withoutMovedKeys(settings: Settings): Settings {
  const out: Settings = { ...settings };
  if (out.permissions !== undefined) {
    const { allow: _a, deny: _d, additionalDirectories: _ad, ...rest } = out.permissions;
    if (Object.keys(rest).length > 0) out.permissions = rest; else delete out.permissions;
  }
  if (out.memory !== undefined) {
    const { enabled: _e, directory: _dir, ...rest } = out.memory as Record<string, unknown>;
    if (Object.keys(rest).length > 0) out.memory = rest as Settings["memory"]; else delete out.memory;
  }
  delete out.outputStyle;
  delete out.mcpServers;
  return out;
}

/**
 * WS-21 (spec §8 step 5, layer 1 of 3): the settings' model tags, canonicalized ON READ through the
 * catalog's renames (`canonicalModelTag`) — `provider.model`, every `pins` role, `reviewer.model`,
 * `titles.model` and `runtimes.advisorModel` (`roleEfforts` holds efforts, not tags). Applied to the LIVE
 * view only (`liveSettingsView`), never inside `loadSettings`: the writers load, patch and save whole
 * objects, and a canonicalizing parse there would rewrite every stored tag on the next unrelated write —
 * the downgrade hazard (r2 I5) the no-rewrite rule exists for. Returns its argument when nothing changes.
 */
export function canonicalSettingsModelTags(settings: Settings): Settings {
  let out = settings;
  const patch = <K extends keyof Settings>(key: K, value: Settings[K]): void => { if (out === settings) out = { ...settings }; out[key] = value; };
  const provider = settings.provider;
  if (provider?.model !== undefined && canonicalModelTag(provider.model) !== provider.model) {
    patch("provider", { ...provider, model: canonicalModelTag(provider.model) as ModelTag });
  }
  const pins = settings.pins;
  if (pins !== undefined) {
    const next: Record<string, unknown> = { ...pins };
    let changed = false;
    for (const [role, tag] of Object.entries(pins)) {
      if (typeof tag === "string" && canonicalModelTag(tag) !== tag) { next[role] = canonicalModelTag(tag); changed = true; }
    }
    if (changed) patch("pins", next as Settings["pins"]);
  }
  for (const key of ["reviewer", "titles"] as const) {
    const block = settings[key] as { model?: string } | undefined;
    if (block?.model !== undefined && canonicalModelTag(block.model) !== block.model) {
      patch(key, { ...block, model: canonicalModelTag(block.model) } as Settings[typeof key]);
    }
  }
  const advisor = settings.runtimes?.advisorModel;
  if (typeof advisor === "string" && canonicalModelTag(advisor) !== advisor) {
    patch("runtimes", { ...settings.runtimes, advisorModel: canonicalModelTag(advisor) } as Settings["runtimes"]);
  }
  return out;
}

/** The daemon's LIVE settings holder, from a parsed `settings.json`: the moved keys stripped
 *  (`withoutMovedKeys`) and the model tags canonicalized on read (`canonicalSettingsModelTags`). Every
 *  live holder is built through this one function. */
export function liveSettingsView(settings: Settings): Settings {
  return canonicalSettingsModelTags(withoutMovedKeys(settings));
}

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** `sdk/settings.json` `permissions.allow` — claude grammar, verbatim — or `undefined` when the key is
 *  absent (which is distinct from `[]`: an explicit empty list opts out of every default). */
export function sdkAllowRules(home: string): string[] | undefined {
  return stringList(liveSdkSettings(home).permissions?.allow);
}

/** `sdk/settings.json` `permissions.deny`, verbatim (claude grammar; `Skill(<name>)` toggles included). */
export function sdkDenyRules(home: string): string[] {
  return stringList(liveSdkSettings(home).permissions?.deny) ?? [];
}

/** `sdk/settings.json` `permissions.additionalDirectories`, verbatim (`~/` expanded by the caller). */
export function sdkAdditionalDirectories(home: string): string[] {
  return stringList(liveSdkSettings(home).permissions?.additionalDirectories) ?? [];
}

/** `sdk/settings.json` `outputStyle` — the user tier's style NAME, or `undefined`. */
export function sdkOutputStyle(home: string): string | undefined {
  const v = liveSdkSettings(home).outputStyle;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * `sdk/settings.json` `autoMemoryEnabled` / `autoMemoryDirectory` (spec §3.7) — claude's own keys and
 * defaults: memory is ON unless explicitly `false`; the directory override is absent unless a
 * non-blank string.
 */
export function sdkAutoMemory(home: string): { enabled: boolean; directory: string | undefined } {
  const s = liveSdkSettings(home);
  const directory = typeof s.autoMemoryDirectory === "string" && s.autoMemoryDirectory.trim() !== "" ? s.autoMemoryDirectory : undefined;
  return { enabled: s.autoMemoryEnabled !== false, directory };
}

/** `sdk/settings.json` `enabledPlugins` (`"<plugin>@<marketplace>" → boolean`, claude's shape). */
export function sdkEnabledPlugins(home: string): Record<string, boolean> {
  const v = liveSdkSettings(home).enabledPlugins;
  const out: Record<string, boolean> = {};
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, on] of Object.entries(v)) if (typeof on === "boolean") out[k] = on;
  }
  return out;
}

const reportedMcpEntries = new Set<string>();

/** One `.winter.json` `mcpServers` map, parsed the way `settings.mcpServers` always was: a
 *  credential-shaped header is DROPPED (read door, reported once), and an entry that does not
 *  validate is skipped (reported once) rather than taking its siblings down. */
function parseMcpServerMap(raw: unknown, where: string): Record<string, McpServerSettingsEntry> {
  const out: Record<string, McpServerSettingsEntry> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const copy = structuredClone(raw) as Record<string, unknown>;
  const stripped = stripCredentialShapedMcpHeaders({ mcpServers: copy });
  for (const [name, headers] of Object.entries(stripped)) {
    const key = `${where}\u0000${name}\u0000strip:${headers.join(",")}`;
    if (!reportedMcpEntries.has(key)) {
      reportedMcpEntries.add(key);
      console.error(`settings: ${where} mcpServers.${name}: dropped credential-shaped header(s) ${headers.join(", ")} — never a literal secret in this file`);
    }
  }
  for (const [name, entry] of Object.entries(copy)) {
    const parsed = McpServerSettingsEntry.safeParse(entry);
    if (parsed.success) { out[name] = parsed.data; continue; }
    const key = `${where}\u0000${name}\u0000invalid`;
    if (!reportedMcpEntries.has(key)) {
      reportedMcpEntries.add(key);
      console.error(`settings: ${where} mcpServers.${name} skipped — ${parsed.error.issues[0]?.message ?? "invalid entry"}`);
    }
  }
  return out;
}

/** `sdk/.winter.json` `mcpServers` — the USER-scope MCP servers (spec §4.4), validated per entry. */
export function sdkUserMcpServers(home: string): Record<string, McpServerSettingsEntry> {
  return parseMcpServerMap(liveSdkGlobalConfig(home).mcpServers, "sdk/.winter.json");
}

/** `sdk/.winter.json` `projects[<root>].mcpServers` — the LOCAL-scope MCP servers for one project
 *  root (spec §4.4), validated per entry. `root` must be the absolute canonical project root. */
export function sdkLocalMcpServers(home: string, root: string): Record<string, McpServerSettingsEntry> {
  const projects = liveSdkGlobalConfig(home).projects;
  const entry = projects !== null && typeof projects === "object" && !Array.isArray(projects) ? projects[root] : undefined;
  return parseMcpServerMap(entry?.mcpServers, `sdk/.winter.json projects[${root}]`);
}

/** Validate one MCP entry for a WRITE into `sdk/.winter.json`: the same schema — and the same
 *  credential-shaped-header REFUSAL — `settings.mcpServers` always enforced at its write door. Throws a
 *  plain `Error` naming the problem (never a header value). */
export function validateMcpServerEntryForWrite(entry: unknown): McpServerSettingsEntry {
  const parsed = McpServerSettingsEntry.safeParse(entry);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

/**
 * Daemon settings surface batch 3 (item 3a): pure `Settings -> Settings` transform toggling ONE
 * server's membership in `settings.mcp.disabled` — the same "load, transform, save" pattern
 * `setSkillDenied`/`setModelRole` already use (`ipc/server.ts`'s `mcp.enable`/`mcp.disable`
 * handlers). `disabled: true` adds the name (a no-op if already present); `disabled: false` removes
 * it (a no-op if absent). Never validates `name` against the currently-configured server list —
 * disabling a server before it exists in `settings.mcpServers` (or one only a trusted project's
 * `.mcp.json` will ever configure) is a legitimate pre-emptive block, same posture `skillDenyRule`
 * takes for a skill that hasn't been written yet.
 */
export function setMcpServerDisabled(settings: Settings, name: string, disabled: boolean): Settings {
  const current = settings.mcp?.disabled ?? [];
  const next = disabled
    ? (current.includes(name) ? current : [...current, name])
    : current.filter((n) => n !== name);
  return { ...settings, mcp: { ...settings.mcp, disabled: next } };
}

/**
 * `winter mcp add`/`mcp.add`'s USER-scope write door: a pure `Settings -> Settings` transform that
 * sets (adds or replaces) one `mcpServers` entry by name. Mirrors `setMcpServerDisabled`'s own
 * posture exactly — never validates `name` against a reserved/existing-name rule; that is a HIGHER
 * door's job (`agent/mcp/mcp-write.ts`'s `addUserMcpServer`, the one function both `ipc/server.ts`'s
 * `mcp.add` handler and the CLI's no-daemon fallback call, so the two write paths can never drift on
 * what counts as a valid add). The caller still owes `saveSettings` a call afterward — THAT is where
 * the real enforcement lives (the full `Settings` schema, including the credential-shaped-header
 * refusal on an http/sse entry); this function only shapes the record.
 */
export function setMcpServerEntry(settings: Settings, name: string, entry: McpServerSettingsEntry): Settings {
  return { ...settings, mcpServers: { ...(settings.mcpServers ?? {}), [name]: entry } };
}

/** The remove-side mirror of `setMcpServerEntry` — deletes one `mcpServers` entry by name.
 *  A no-op (returns `settings` unchanged) when the name isn't present, same "idempotent, never
 *  throws on its own input" posture `setMcpServerDisabled` already has. */
export function removeMcpServerEntry(settings: Settings, name: string): Settings {
  if (!settings.mcpServers || !(name in settings.mcpServers)) return settings;
  const rest = { ...settings.mcpServers };
  delete rest[name];
  return { ...settings, mcpServers: rest };
}

/**
 * Phase 9c (P9c-1) / pre-release hardening: the ONE reader of `runtimes.official.subscriptionAuth`
 * — absent means OFF (blocked); only an explicit `true` on the SETTINGS FLAG opens the door, and
 * even then only while the compile-time approval gate (`OFFICIAL_SUBSCRIPTION_AUTH_APPROVED`,
 * `runtime-sdk/versions.ts`) is also `true`. Before this hardening the settings flag alone could
 * flip the official leg's subscription posture — this ANDs the two so a hand-set (or migrated,
 * or mis-synced) `true` in settings.json can never do that on its own; only a reviewed code change
 * to the compile-time constant can. `approved` defaults to the real constant and exists ONLY as an
 * injectable seam for tests that need to exercise the "approved" branch — production callers must
 * never pass it.
 */
export function officialSubscriptionAuthEnabled(
  settings: Settings | null | undefined,
  approved: boolean = OFFICIAL_SUBSCRIPTION_AUTH_APPROVED,
): boolean {
  return approved && (settings?.runtimes?.official?.subscriptionAuth ?? false);
}

/**
 * Pre-release hardening (P9c-1 amendment): true when the settings file's raw flag is `true` but
 * the compile-time approval gate is not — i.e. the flag is currently INERT and every settings
 * change while it stays set should say so exactly once (`settings-apply.ts`'s hot-reload diff,
 * `daemon.ts`'s boot-time check). Never the inverse of `officialSubscriptionAuthEnabled`: an
 * absent/false raw flag is not "inert", it is simply off and unremarkable.
 */
export function officialSubscriptionAuthFlagInert(
  settings: Settings | null | undefined,
  approved: boolean = OFFICIAL_SUBSCRIPTION_AUTH_APPROVED,
): boolean {
  return !approved && (settings?.runtimes?.official?.subscriptionAuth ?? false);
}

// WS-20: `officialAuthModeSetting` is DELETED along with `runtimes.official.auth` — the official
// leg's auth arm is now the tag's own prefix (`official-options.ts`'s `officialAuthArmFor`).

/** The one place `hooks.enabled`'s default-ON semantics live (4f Task 2): absent block, absent
 *  field, or `enabled: true` all mean hooks run; only an explicit `false` turns them off. Kept as
 *  a pure `Settings -> boolean` helper (not inlined at each call site) so both the daemon's hot
 *  settings-reader (daemon.ts, re-reads settings.json per call, mtime-cached — same pattern as
 *  providers/manager.ts's `liveModel`) and this file's own tests exercise the SAME decision. */
export const hooksEnabledFrom = (s: Settings): boolean => s.hooks?.enabled !== false;

/** Fix wave (C2 / P8c-18); Winter Phase 10b (D1-1, W18-10, R-10b-1): the ONE door
 *  `runtime-sdk/handoff.ts` reads before letting a `session.setModel` cross a runtime leg.
 *
 *  An EXPLICIT `true`/`false` on `runtimes.handoff.crossRuntime` always wins, in every mode — the
 *  schema leaves the field `.optional()` (no `.default()`) precisely so this function can tell
 *  "the user never set it" from "the user set it to false" (see the schema comment above).
 *
 *  Absent (never set) falls back to the MODE-AWARE default: ON for Code, OFF for chat/dispatch.
 *  `mode` follows the file-wide `mode ?? "code"` convention (`clientEffortEligible` above is the
 *  same shape) — an omitted mode reads as Code, never as "unknown". Chat and dispatch sessions
 *  never reach the official leg regardless of this flag (`select-runtime.ts`'s own mode gate), so
 *  their OFF default is belt-and-suspenders, not a behavioural fence on its own.
 *
 *  Deliberately total (`null`/`undefined` settings both fall through to the mode-aware default,
 *  never a throw) for the same boot-degraded-to-`settings=null` reason every getter here is total. */
export function handoffCrossRuntimeEnabled(s: Settings | null | undefined, mode?: string): boolean {
  const explicit = s?.runtimes?.handoff?.crossRuntime;
  if (explicit !== undefined) return explicit;
  return mode === undefined || mode === "code";
}

/** What the Winter leg actually runs with, for a home whose `runtimes` block may not exist at all. */
export interface WinterOptions {
  /** Absent when unset OR blank — never `""`. See `winterOptionsFromSettings`. */
  winterExecutable?: string;
  /** P8c-3's own rung, same blank-is-absent rule. Read only by the official leg's ladder — inert on
   *  a Winter-only session. */
  claudeExecutable?: string;
  /** Winter Phase 10a (Lane L's `bundle-layout.ts` `resolveAntExecutable` ladder), same
   *  blank-is-absent rule. Read only by the console-profile broker (`daemon.ts`, O6) — inert
   *  everywhere else. */
  antExecutable?: string;
  advisorModel?: string;
  idleTimeoutSec: number;
  winterLeg: { chat: boolean; dispatch: boolean; code: boolean };
}

/**
 * THE DOOR EVERY WINTER-LEG CONSUMER READS (`resolveWinterExecutable`, `createWinterRuntimeSdk`,
 * `legForNewSession`, the idle timer), and the reason it exists rather than three lanes each
 * reaching into `settings.runtimes`.
 *
 * It answers the two conventions the raw block cannot:
 *
 *   AN ABSENT BLOCK IS NOT UNKNOWN. `runtimes` is `.optional()` (a defaulted block would make it
 *   required on every settings literal in this codebase and would have `saveSettings` stamp today's
 *   values into every user's file), so zod's per-key defaults never materialize for a home that has
 *   never configured it. Absent means all three legs OFF and 900 seconds — stated here, once.
 *
 *   BLANK MEANS ABSENT. `winterExecutable: ""` is a user clearing the field, not a path to an
 *   executable at the filesystem root; `advisorModel: ""` is not a model id. Both are trimmed to
 *   `undefined` so no consumer has to remember (the same rule `memory.directory` follows in
 *   `memory-dir.ts`), and neither can invalidate the whole settings file the way a `.min(1)` would.
 *
 * Deliberately total: it takes `null`/`undefined` settings, because the daemon boots with
 * `settings = null` when `settings.json` is missing or invalid and every getter here must still
 * answer.
 */
/** The `winterLeg` keys a settings file sets to `false` — accepted, logged, ignored (Task 17). */
export function winterLegDisabledKeys(s: Settings | null | undefined): string[] {
  const leg = s?.runtimes?.winterLeg;
  if (leg === undefined) return [];
  return (["chat", "dispatch", "code"] as const).filter((m) => leg[m] === false);
}

export function winterOptionsFromSettings(s: Settings | null | undefined): WinterOptions {
  const r = s?.runtimes;
  const blankIsAbsent = (v: string | undefined): string | undefined => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  };
  return {
    ...(blankIsAbsent(r?.winterExecutable) === undefined ? {} : { winterExecutable: blankIsAbsent(r?.winterExecutable)! }),
    ...(blankIsAbsent(r?.claudeExecutable) === undefined ? {} : { claudeExecutable: blankIsAbsent(r?.claudeExecutable)! }),
    ...(blankIsAbsent(r?.antExecutable) === undefined ? {} : { antExecutable: blankIsAbsent(r?.antExecutable)! }),
    ...(blankIsAbsent(r?.advisorModel) === undefined ? {} : { advisorModel: blankIsAbsent(r?.advisorModel)! }),
    idleTimeoutSec: r?.winterIdleTimeoutSec ?? DEFAULT_WINTER_IDLE_TIMEOUT_SEC,
    // Task 17 Step 4: the engine leg no longer exists. Every mode answers `true` whatever the block
    // says; a written `false` is reported by `settings-apply.ts` and by the boot log, never obeyed.
    winterLeg: { chat: true, dispatch: true, code: true },
  };
}

/** Same default-ON shape as `hooksEnabledFrom` above: absent block, absent field, or `true` all
 *  mean file-based memory is on; only an explicit `false` turns it off. The single place this
 *  decision is made — daemon.ts's write-root join and context.ts's injection gate both call this
 *  (via a live getter over the `settings` holder) rather than re-deriving it inline. */
export const memoryEnabledFrom = (s: Settings): boolean => s.memory?.enabled !== false;

/** Same default-ON shape as `hooksEnabledFrom`/`memoryEnabledFrom` above: absent block, absent
 *  field, or `true` all mean the dynamic Workflow tool is registered and `/ultracode` is active;
 *  only an explicit `false` turns the whole feature off. The single place THIS decision is made —
 *  daemon.ts's `workflowsEnabled` getter (mirrors reviewerEnabled/toolSearch's own per-project,
 *  hot-reloaded shape) calls this rather than re-deriving it inline. */
export const workflowsEnabledFrom = (s: Settings): boolean => s.workflows?.enabled !== false;
/** Same default-ON shape as `workflowsEnabledFrom` just above, but gates ONLY the `/ultracode`
 *  keyword trigger — an explicit `false` here leaves the Workflow tool itself registered and
 *  available to the model; it just stops treating the keyword as an implicit invocation. */
export const keywordTriggerEnabledFrom = (s: Settings): boolean => s.workflows?.keywordTrigger !== false;

/** Same default-ON shape as `memoryEnabledFrom`/`hooksEnabledFrom` above: absent block, absent
 *  field, or `true` all mean auto-diagnostics-after-edit is on; only an explicit `false` turns it
 *  off. The single place THIS decision is made — engine.ts's post-write/edit/notebook_edit hook
 *  calls this (via a live getter over the `settings` holder) rather than re-deriving it inline. */
export const lspAutoDiagnosticsEnabledFrom = (s: Settings): boolean => s.lsp?.autoDiagnostics !== false;

/** session-activity-hygiene T7: same default-ON shape as `memoryEnabledFrom`/`workflowsEnabledFrom`
 *  above — absent block, absent field, or `true` all mean the session cleaner's pass runs; only an
 *  explicit `false` turns it off. The single place THIS decision is made: daemon.ts's
 *  `cleanerEnabledHot` live getter calls it rather than re-deriving the `!== false` shape inline,
 *  so the two can never drift. */
export const cleanerEnabledFrom = (s: Settings): boolean => s.cleaner?.enabled !== false;

/** Minor 5e (fix wave, pre-merge review): computer use (Phase 5 CU) opt-in gate — the ONE place
 *  `settings.computerUse.enabled === true` is decided, replacing THREE independently hand-spelled
 *  copies (daemon.ts's boot registration gate, daemon.ts's own `computerUseEnabled` live getter,
 *  and `ipc/server.ts`'s `capabilities.list` handler — `settings-apply.ts`'s `cuEnabled` closure is
 *  the fourth). Deliberately `=== true` (not the `!== false` shape every OTHER gate in this file
 *  has) — computer use is opt-in/default-OFF, "the strongest reading of 'full-auto CU requires
 *  explicit opt-in'" (the schema's own doc on `computerUse.enabled`). */
export const computerUseEnabledFrom = (s: Settings): boolean => s.computerUse?.enabled === true;

/** Minor 5e (fix wave, pre-merge review): LSP integration (Phase 5f) opt-out gate — the ONE place
 *  `settings.lsp.enabled !== false` is decided, same "one reader" consolidation as
 *  `computerUseEnabledFrom` just above. Default-ON, the SAME `!== false` shape as
 *  `hooksEnabledFrom`/`memoryEnabledFrom`/`cleanerEnabledFrom` above — only an explicit `false`
 *  turns the `lsp` tool off entirely. Distinct from `lspAutoDiagnosticsEnabledFrom` above, which
 *  gates only the automatic post-edit-diagnostics append, not the tool's existence. */
export const lspEnabledFrom = (s: Settings): boolean => s.lsp?.enabled !== false;

// WS-20: the pre-deprecation `gpt-5.4` default is gone (there is no more CODEX_MODELS allowlist to
// deprecate against) — points at `gpt-5.6-sol`, prefixed as a codex-oauth tag: the ONE default a
// fresh install (no settings.json at all) or a v1-or-legacy file (no real provider info) lands on.
export const DEFAULT_PROVIDER = { model: "codex-oauth/gpt-5.6-sol" as ModelTag } as const;

/** WS-20 (spec §5): every catalog provider id with a row whose BARE modelId (the tag's own tail)
 *  equals `m`, or whose `canonicalModelId` equals `m` (an alias/family match) — the "S" set the
 *  v2→v3 migration rule and the runtime-state/session-row rewrite (`runtime-state/migrations/
 *  tags.ts`, `sessions/store.ts`) both resolve a bare legacy id against. Catalog order. */
export function providersServingBareId(m: string): string[] {
  const catalog = loadCatalog();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of catalog.models) {
    const bare = row.key.slice(row.key.indexOf("/") + 1);
    if (bare !== m && row.canonicalModelId !== m) continue;
    if (seen.has(row.providerId)) continue;
    seen.add(row.providerId);
    out.push(row.providerId);
  }
  return out;
}

/** WS-20 (spec §5): options for `migrateBareModelId` — one call per bare-id field being migrated,
 *  whether it lives in settings.json or a runtime-state/session row. */
export interface MigrateBareModelIdOptions {
  /** Named ONLY for the one log line this function may emit — NEVER the value itself (which is
   *  not a secret, but this keeps the discipline uniform with every other settings log). */
  fieldName: string;
  /** The Winter home — for the Claude-id arm's console-profile existence probe. */
  home: string;
  /** The legacy `runtimes.official.auth` value, when migrating from settings (undefined for a
   *  runtime-state/session row migration, which has no such field to read). */
  legacyOfficialAuth?: "auto" | "api-key" | "console";
  /** The legacy `provider.type`, ONLY meaningful when this field IS `provider.model` itself
   *  (rule 3) — absent for every other field/row. */
  legacyProviderType?: "codex-oauth" | "openai-compatible";
  /** Rule 2's answer when NO catalog provider serves `m`: a settings field either gets a real
   *  provider default (`provider.model` itself) or is cleared (`"delete"`); a runtime-state/session
   *  row always gets the sentinel (`UNSTATED_TAG`). */
  emptySFallback: ModelTag | "delete";
  /** WS-20 (review round 2, M5): the set of providers this HOME actually holds a credential for
   *  (`credentialPresenceFrom(secrets)`'s keys) — rule 5's tie-break (several serving providers,
   *  none named by the legacy `provider.type`) prefers a member of S that HOLDS a credential over
   *  the fixed codex-oauth>openai>anthropic order. Absent (every caller but the daemon boot hook,
   *  which is the only one with `secrets` in hand at migration time) falls straight to the fixed
   *  order, exactly as before this field existed. */
  presentProviders?: ReadonlySet<string>;
}

/** WS-20 (spec §5, numbered exactly as the plan states it): resolves ONE bare legacy model id `m`
 *  to a `ModelTag`, or `undefined` when the caller's `emptySFallback` is `"delete"` (the field
 *  should be removed rather than defaulted). Shared by the settings v2→v3 migration AND the
 *  runtime-state/session-row rewrite so the rule is never duplicated. */
export function migrateBareModelId(m: string, opts: MigrateBareModelIdOptions): ModelTag | undefined {
  // 1. already a tag with a catalog provider (or the winter-test escape hatch) → keep.
  if (isModelTag(m)) return m as ModelTag;
  // Claude ids: the arm is decided by the legacy official-auth setting / on-disk console profile,
  // NOT by the generic S-based rules below (S would contain both `anthropic` and `console` for
  // every Claude row, which the generic tie-break has no way to resolve correctly).
  if (m.startsWith("claude-")) {
    const arm =
      opts.legacyOfficialAuth === "console" ||
      ((opts.legacyOfficialAuth === undefined || opts.legacyOfficialAuth === "auto") && existsSync(consoleProfileCredentialFile(opts.home)))
        ? "console"
        : "anthropic";
    return `${arm}/${m}` as ModelTag;
  }
  const S = providersServingBareId(m);
  // 2. no catalog provider serves it.
  if (S.length === 0) {
    console.error(`[settings migration] "${opts.fieldName}" named a model no catalog provider serves${opts.emptySFallback === "delete" ? " — cleared" : ""}`);
    return opts.emptySFallback === "delete" ? undefined : opts.emptySFallback;
  }
  // 3. the legacy provider.type, when THAT provider is in S (provider.model only).
  if (opts.legacyProviderType === "codex-oauth" && S.includes("codex-oauth")) return "codex-oauth/" + m as ModelTag;
  if (opts.legacyProviderType === "openai-compatible" && S.includes("openai")) return "openai/" + m as ModelTag;
  // 4. exactly one serving provider (no ambiguity to resolve — presence plays no role).
  if (S.length === 1) return `${S[0]}/${m}` as ModelTag;
  // 5. several, none named. WS-20 (review round 2, M5): prefer a member of S that HOLDS A
  //    CREDENTIAL, when the caller knows presence at all — falling back to the fixed
  //    api-key-vendor order (unchanged) when presence is unknown, OR known but none of S holds one
  //    (logged either way, so a silent wrong-provider guess is never truly silent).
  const fixedOrder = (["codex-oauth", "openai", "anthropic"] as const).find((p) => S.includes(p));
  if (opts.presentProviders !== undefined) {
    const credentialed = S.find((p) => opts.presentProviders!.has(p));
    if (credentialed !== undefined) {
      console.error(`[settings migration] "${opts.fieldName}" is ambiguous across providers (${S.join(", ")}) — chose ${credentialed}, which holds a credential`);
      return `${credentialed}/${m}` as ModelTag;
    }
    const chosen = fixedOrder ?? S[0]!;
    console.error(`[settings migration] "${opts.fieldName}" is ambiguous across providers (${S.join(", ")}) — none holds a credential, chose ${chosen} by fixed preference`);
    return `${chosen}/${m}` as ModelTag;
  }
  const chosen = fixedOrder ?? S[0]!;
  console.error(`[settings migration] "${opts.fieldName}" is ambiguous across providers (${S.join(", ")}) — chose ${chosen}`);
  return `${chosen}/${m}` as ModelTag;
}

/** WS-20 (spec §5): the v2 → v3 settings migration. Takes the RAW parsed v2 object (never a
 *  validated `Settings` — the whole point is to accept a v2 shape the v3 schema rejects) and `home`
 *  (for the Claude-id console-profile probe) and returns a raw object shaped for `Settings.parse`.
 *  Preserves every unrelated key verbatim (same "nothing silently lost" discipline the v1→v2 branch
 *  already had). Exported so `loadSettings` and this file's own tests share one implementation. */
export function migrateSettingsV2ToV3(raw: Record<string, unknown>, home: string, presentProviders?: ReadonlySet<string>): Record<string, unknown> {
  const legacyProvider = (raw.provider ?? {}) as Record<string, unknown>;
  const legacyProviderType = legacyProvider.type as "codex-oauth" | "openai-compatible" | undefined;
  const legacyRuntimes = (raw.runtimes ?? {}) as Record<string, unknown>;
  const legacyOfficial = (legacyRuntimes.official ?? {}) as Record<string, unknown>;
  const legacyOfficialAuth = legacyOfficial.auth as "auto" | "api-key" | "console" | undefined;

  const out: Record<string, unknown> = { ...raw, schemaVersion: 3 };

  // provider: model (required), reasoningEffort (carried as-is), type/baseUrl dropped.
  if (typeof legacyProvider.model === "string") {
    // WS-20 (review round 4): `provider.model` is UNCONSTRAINED again (any catalog provider, or
    // `winter-test/*`) — a round-2/round-3 fallback lived here briefly to keep
    // `migrateBareModelId`'s Claude-id arm (which answers purely off `legacyOfficialAuth`/the
    // console profile) from producing a `provider.model` the schema would then refuse; that
    // refusal no longer exists, so the fallback would now silently steer a genuinely Claude-primary
    // v2 home to an openai/codex-oauth default instead of the CORRECT `anthropic/claude-*` answer.
    // Removed — `migrateBareModelId`'s own answer is trusted verbatim, same as every other field.
    const tag = migrateBareModelId(legacyProvider.model, {
      fieldName: "provider.model", home, legacyOfficialAuth, legacyProviderType, presentProviders,
      emptySFallback: legacyProviderType === "openai-compatible" ? ("openai/gpt-5.6-sol" as ModelTag) : ("codex-oauth/gpt-5.6-sol" as ModelTag),
    });
    const nextProvider: Record<string, unknown> = { model: tag };
    if (legacyProvider.reasoningEffort !== undefined) nextProvider.reasoningEffort = legacyProvider.reasoningEffort;
    out.provider = nextProvider;
  } else if (raw.provider !== undefined) {
    // A malformed provider block (no model at all) — drop `type`/whatever else it had and let the
    // final Settings.parse report the missing `model` as the readable "settings.json is invalid"
    // error; fabricating a default here would hide a genuinely corrupt file.
    out.provider = {};
  }
  if (typeof legacyProvider.baseUrl === "string" && legacyProvider.baseUrl.length > 0) {
    const existingProviders = (raw.providers ?? {}) as Record<string, { baseUrl?: string }>;
    out.providers = { ...existingProviders, openai: { ...existingProviders.openai, baseUrl: legacyProvider.baseUrl } };
  }

  // reviewer.model / titles.model: settings fields OTHER than provider.model → cleared, not
  // defaulted, when no catalog provider serves the legacy id (rule 2).
  for (const [block, key] of [["reviewer", "reviewer"], ["titles", "titles"]] as const) {
    const legacyBlock = (raw[block] ?? {}) as Record<string, unknown>;
    if (typeof legacyBlock.model !== "string") continue;
    const tag = migrateBareModelId(legacyBlock.model, { fieldName: `${key}.model`, home, legacyOfficialAuth, presentProviders, emptySFallback: "delete" });
    const nextBlock = { ...(out[block] as Record<string, unknown> | undefined) };
    if (tag) nextBlock.model = tag; else delete nextBlock.model;
    out[block] = nextBlock;
  }

  // runtimes.advisorModel + runtimes.official.auth removal.
  if (raw.runtimes !== undefined) {
    const nextRuntimes: Record<string, unknown> = { ...legacyRuntimes };
    if (typeof legacyRuntimes.advisorModel === "string" && legacyRuntimes.advisorModel.length > 0) {
      const tag = migrateBareModelId(legacyRuntimes.advisorModel, { fieldName: "runtimes.advisorModel", home, legacyOfficialAuth, presentProviders, emptySFallback: "delete" });
      if (tag) nextRuntimes.advisorModel = tag; else delete nextRuntimes.advisorModel;
    }
    if (legacyRuntimes.official !== undefined) {
      const { auth: _auth, ...restOfficial } = legacyOfficial;
      nextRuntimes.official = restOfficial;
    }
    out.runtimes = nextRuntimes;
  }

  return out;
}

/** Copies the settings file to `<path>.bak-pre-ws20` before its first v2→v3 (or earlier) migration
 *  — skipped once that backup already exists, so a daemon that boots repeatedly against an
 *  un-upgraded home never overwrites the ORIGINAL pre-migration file with a later, already-migrated
 *  one. Best-effort: a failure to write the backup must never block the migration itself. */
function backupPreWs20Once(path: string, raw: unknown): void {
  const backupPath = `${path}.bak-pre-ws20`;
  if (existsSync(backupPath)) return;
  try {
    writeFileSync(backupPath, JSON.stringify(raw, null, 2) + "\n");
  } catch {
    /* best-effort only */
  }
}

/**
 * WS-20 (review round 2, M5): `opts.presentProviders` threads credential presence into migration
 * rule 5's tie-break (`migrateBareModelId`) — only the DAEMON boot hook has `secrets` in hand at
 * migration time (`credentialPresenceFrom(secrets)`, computed before this call), so every other
 * caller (the CLI, every test without a daemon) omits it and gets the OLD fixed-preference tie-break
 * unchanged.
 *
 * `opts.persistMigration` (default `false`) gates every DISK WRITE this function can make — the
 * migrated-shape return value is IDENTICAL either way (a caller always gets a valid, migrated
 * `Settings` object back), but with it left `false` the on-disk file is left EXACTLY as it was
 * found (still v2, still un-backed-up). This makes the daemon boot hook (which passes `true`, AFTER
 * it has computed presence) the ONLY writer of a migrated v3 file — a CLI or test process that
 * happens to read a v2 home first can no longer race the daemon to a migration written WITHOUT
 * presence in hand.
 */
/**
 * Fix wave (pre-merge review, advisor round 2 on finding 6): the ONE renderer for a `Settings`
 * parse failure's issue list — `loadSettings`'s two throw sites AND `readableSettingsParseError`
 * (the `saveSettings` door) all call this rather than each hand-joining `issues.map((i) =>
 * i.path.join("."))` its own way, which is what made the item 6 ruling's own refusal message
 * (`refuseCredentialShapedHeaders`'s `ctx.addIssue({code: "custom", ...})`) invisible at the two
 * doors a user actually hits: a path-only join names the FIELD (`mcpServers.x.headers.Authorization`)
 * but drops the WHY, so a hand-edited settings.json with a credential-shaped header produced a
 * refusal that named neither the rule nor the alternative — exactly what the ruling's own text
 * requires ("naming the rule and pointing at the alternative"). A `"custom"` issue's own `.message`
 * (the only zod issue kind whose message is caller-authored prose, never a generic type/shape
 * complaint) is now appended after its path; every other issue kind's rendering is BYTE-IDENTICAL to
 * before this fix, since only the custom branch adds anything.
 */
function renderSettingsIssues(issues: readonly { path: PropertyKey[]; code?: string; message: string }[]): string {
  return issues
    .map((i) => {
      const field = i.path.join(".") || "(root)";
      return i.code === "custom" ? `${field}: ${i.message}` : field;
    })
    .join(", ");
}

export function loadSettings(path: string, opts?: { presentProviders?: ReadonlySet<string>; persistMigration?: boolean }): Settings {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`settings file not found at ${path} — run \`winter daemon run\` once to initialize`);
    }
    throw err;
  }
  // Read door (ruling, item 6 follow-up — see `stripCredentialShapedMcpHeaders`'s own doc above):
  // strip any credential-shaped MCP header from the RAW object BEFORE any schema validation runs,
  // on EVERY branch below (v3 direct, v2/v1 migration alike — the field's shape is unaffected by
  // migration) — a hand-edited file carrying one must still boot the daemon and keep the agent
  // enabled, never widen into `daemon.ts`'s "settings unavailable, agent disabled". One stderr line
  // per offending (server, header) pair, the FIRST time this path/server/header combination is
  // ever seen by this process (`loggedCredentialHeaderStrips` — see its own doc for why: this
  // function is called from many places, repeatedly, and "log once per read" would spam the log
  // for as long as the file stays unedited).
  for (const [serverName, headerNames] of Object.entries(stripCredentialShapedMcpHeaders(raw))) {
    for (const headerName of headerNames) {
      const key = `${path}\0${serverName}\0${headerName}`;
      if (loggedCredentialHeaderStrips.has(key)) continue;
      loggedCredentialHeaderStrips.add(key);
      console.error(
        `settings: mcp server "${serverName}" header "${headerName}" is credential-shaped — dropped from its headers at load, so that server will authenticate as if it were absent, AND the next settings write removes it from ${path} for good. settings.json is model-readable, so a literal credential there is not safe — use \${env:VAR}-style indirection once it exists, never a literal secret here`,
      );
    }
  }
  if (raw.schemaVersion === 3) {
    const parsed = Settings.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`settings.json is invalid: ${renderSettingsIssues(parsed.error.issues)} — fix or delete ${path}`);
    }
    return parsed.data;
  }
  const home = dirname(path);
  const persistMigration = opts?.persistMigration ?? false;
  if (raw.schemaVersion === 2) {
    const migrated = migrateSettingsV2ToV3(raw, home, opts?.presentProviders);
    const parsed = Settings.safeParse(migrated);
    if (!parsed.success) {
      throw new Error(`settings.json is invalid: ${renderSettingsIssues(parsed.error.issues)} — fix or delete ${path}`);
    }
    // WS-20 (review round 2, self-fix): VALIDATE BEFORE WRITING — `saveSettings`'s own discipline
    // ("never persist an invalid settings file"). The old write-then-validate order could leave an
    // INVALID v3 file on disk (this function throws either way, but a caller that only reads the
    // thrown message never learns the file itself is now broken): M6's `ProviderModelTagSchema`
    // refinement made this newly reachable — `migrateBareModelId`'s Claude arm can produce
    // `anthropic/claude-*`/`console/claude-*` for `provider.model` from a v2 `openai-compatible` BYO
    // endpoint that happened to serve a model with a `claude-` prefixed bare id, which now fails
    // that refinement.
    //
    // WS-20 (review round 2, nit h): the backup is a REAL pre-WS20 file worth preserving — only
    // reached once migration is KNOWN to produce a valid result, and gated on `persistMigration`
    // like every other write this function makes.
    if (persistMigration) {
      backupPreWs20Once(path, raw);
      writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n");
    }
    return parsed.data;
  }
  // v1-or-legacy file (Phase 0 wrote {schemaVersion:1}; the retired v1 app wrote files with no
  // schemaVersion at all — same directory on case-insensitive APFS). No real provider info exists
  // to migrate, so this lands straight on v3's DEFAULT_PROVIDER — preserving unknown fields so
  // nothing is silently lost. Never backed up (nit h) — there is nothing real to lose.
  const { schemaVersion: _legacy, ...preserved } = raw;
  const migrated = { ...preserved, schemaVersion: 3 as const, provider: DEFAULT_PROVIDER };
  // zod v4 z.object() strips unknown keys by default (does NOT throw) — safe to parse migrated.
  // Validated BEFORE writing, same discipline as the v2 branch above (this arm's own `provider` is
  // always the fixed `DEFAULT_PROVIDER`, so it can never itself fail the M6 refinement — kept in the
  // same order regardless, for the same reason `saveSettings` always validates before writing).
  const result = Settings.parse(migrated);
  if (persistMigration) writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n");
  return result;
}

/**
 * Daemon settings surface (2026-09-17 plan, item 5a): the round-trip merge every `saveSettings`
 * write applies so a key the daemon's own `Settings` schema does not model is never silently
 * dropped by an unrelated write (a `setModelRole`, a `plugin.enable`, …). Without this, `saveSettings`
 * persisted `Settings.parse(s)`'s own (discarded) validation as proof of shape but wrote `s` itself
 * verbatim — which is already correct for every field THIS schema knows about (an absent optional
 * block stays absent, never backfilled with its `.prefault()`/`.default()` value — see the doc on
 * `runtimes.retention` above for why that distinction matters), but `s` can never carry a field the
 * schema has no shape for at all, because every real `Settings` value existing in this codebase was
 * itself produced by parsing against this same schema at some earlier point (`loadSettings`, a pure
 * `Settings -> Settings` transform, or a hand-built test literal) — so a hand-written SDK-format
 * block (`hooks.PreToolUse`, an entire unrelated top-level key like `enabledPlugins`) that lives only
 * on disk is invisible to `s` by construction and would otherwise be erased the moment anything else
 * writes settings.json.
 *
 * THE ORDERING RULE, decided here once: **daemon-owned keys always win; unknown keys survive
 * untouched.** A key is "daemon-owned" when this exact `Settings` schema (descended structurally —
 * through `ZodObject` shapes and `ZodRecord` value schemas, unwrapping `optional`/`nullable`/
 * `default`/`prefault`/`readonly`/`catch`) defines it at that nesting level, REGARDLESS of whether
 * `owned` currently holds a value there — an owned key that is absent/cleared in `owned` is removed
 * from the merged result even if `raw` (the file on disk right now) still has it, because clearing a
 * known field is itself a daemon-owned decision, not an accident. A key this schema does NOT define
 * at that level (at any depth) is never touched: it is copied from `raw` verbatim, because `owned`
 * cannot originate one (see above) and there is nothing for the daemon to decide about it. A LEAF
 * (string/number/boolean/enum/array/anything not itself an object/record) always takes `owned`'s
 * value wholesale — a leaf has no "extra keys" of its own to lose. `.strict()` blocks
 * (`ProviderSettings`, `runtimes.official`) need no special case: `Settings.parse` already throws
 * before an unknown key inside one of those ever reaches this merge (their own schema comments), so
 * there is nothing there this function could be asked to preserve that would not already have
 * refused the whole file at load time.
 *
 * A `z.record(...)` field (`mcpServers`, `providers`, `plugins.consents`) is treated differently
 * from a plain object: the record's OWN key set (which server, which provider) is itself daemon-
 * owned data, not schema-defined shape — a key present in `raw`'s map but absent from `owned`'s
 * means something upstream deliberately removed that entry, so it is dropped, never resurrected.
 * Only within an entry BOTH sides still share does this descend into that entry's own value schema —
 * but that is NOT the same guarantee a plain object field gets. Minor correction (pre-merge review):
 * `mcpServers`' own value schema (`McpServerSettingsEntry`) is a `z.preprocess(...)` — a `"pipe"` def
 * in zod v4, which this switch does not special-case — so a value there hits the LEAF branch below
 * and `owned` wins outright, exactly like a plain string/number leaf. An unknown field nested inside
 * one server's config does NOT survive a save; it is silently dropped along with whatever else the
 * preprocess step didn't preserve. A related, deliberate side effect of the same leaf treatment: a
 * legacy typeless stdio entry (no `type` field on disk) is written back with an explicit
 * `type: "stdio"` on ANY unrelated settings save that round-trips it through `loadSettings` →
 * `saveSettings`, because the parsed/normalized shape (with the preprocess's own defaulting applied)
 * is what `owned` carries. This is accepted, not fixed here — descending into a `"pipe"` schema to
 * recover its pre-image would need the preprocess's own untransformed input, which zod does not
 * expose, and the normalization itself is harmless (the stdio shape is byte-identical in meaning).
 */
function mergeUnknownKeys(schema: unknown, raw: unknown, owned: unknown): unknown {
  const def = (schema as { def?: { type?: string; innerType?: unknown; valueType?: unknown } } | undefined)?.def;
  switch (def?.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
      // A wrapper carries no shape of its own — recurse into what it wraps with the SAME pair.
      return mergeUnknownKeys(def.innerType, raw, owned);
    case "object": {
      // The whole block is absent/cleared in `owned` — a daemon-owned decision, propagates as-is
      // (never backfilled from `raw`, matching `saveSettings`'s pre-existing "write `s` verbatim,
      // an absent optional block stays absent" contract).
      if (owned === undefined) return undefined;
      // BLOCKER FIX (fix wave, pre-merge review): a `.strict()` block (`provider`,
      // `runtimes.official`) accepts NOTHING this schema does not itself model — `Settings.parse`
      // already refuses a stray key inside one at LOAD time (their own schema comments), so any
      // such key still sitting in `raw` can only be a block that predates the `.strict()` schema
      // and was never rewritten to disk (the v2→v3 migration's `provider.type`/`provider.baseUrl`
      // strip is IN-MEMORY only unless `persistMigration` was passed — see `loadSettings`). The
      // general "unknown keys survive by copying `raw` first" rule below would carry that stray key
      // straight into the merged result, and the second `Settings.parse` in `saveSettings` would
      // then throw on every write to that home. Detected via zod v4's own `catchall: z.never()`
      // marker rather than a hand-kept list of strict schemas, so a future `.strict()` block gets
      // this for free. `owned` wins OUTRIGHT here — nothing from disk is preserved for this
      // subtree — because `loadSettings` would have refused those keys anyway, so there is nothing
      // legitimate on disk this could lose.
      const isStrict = (schema as { def?: { catchall?: { def?: { type?: string } } } }).def?.catchall?.def?.type === "never";
      if (isStrict) return owned;
      const rawObj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const ownedObj = owned && typeof owned === "object" && !Array.isArray(owned) ? (owned as Record<string, unknown>) : {};
      const shape = (schema as { shape: Record<string, unknown> }).shape;
      const out: Record<string, unknown> = { ...rawObj }; // unknown keys survive by default
      for (const key of Object.keys(shape)) {
        const merged = mergeUnknownKeys(shape[key], rawObj[key], ownedObj[key]);
        if (merged === undefined) delete out[key];
        else out[key] = merged;
      }
      // Belt-and-suspenders: an `owned` value built by hand (never parsed) COULD carry a property
      // this schema has no shape for at all. Such a key is daemon-owned in spirit (the caller put it
      // there deliberately) but schema-unknown, so it is carried through only when `raw` didn't
      // already decide its fate above.
      for (const key of Object.keys(ownedObj)) {
        if (!(key in shape) && !(key in out)) out[key] = ownedObj[key];
      }
      return out;
    }
    case "record": {
      if (owned === undefined) return undefined;
      const rawObj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const ownedObj = owned && typeof owned === "object" && !Array.isArray(owned) ? (owned as Record<string, unknown>) : {};
      const valueSchema = def.valueType;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(ownedObj)) {
        out[key] = mergeUnknownKeys(valueSchema, rawObj[key], ownedObj[key]);
      }
      return out;
    }
    default:
      // Leaf type (string/number/boolean/enum/literal/union/array/…) — `owned` wins outright.
      return owned;
  }
}

/** BLOCKER FIX (fix wave, pre-merge review): `Settings.parse` throwing straight out of
 *  `saveSettings` hands every caller a raw zod issue dump (`unrecognized_keys ["type"] at
 *  ["provider"]`, or worse across several errors) as the error's `.message` — exactly the class of
 *  silent-strip-turned-opaque-throw this branch exists to fix, just at the other end. `loadSettings`
 *  already renders its own parse failures as a readable, actionable sentence
 *  (`"settings.json is invalid: <fields> — fix or delete <path>"`); this is the same rendering,
 *  reused so both doors speak one language. Every `saveSettings` caller — the CLI's direct calls and
 *  every `ipc/server.ts` handler (`settings.setModelRole`, `settings.setSkillDenied`, `mcp.enable`,
 *  `mcp.disable`, and any future one) — gets this for free rather than needing its own try/catch. */
function readableSettingsParseError(path: string, error: z.ZodError, context: string): Error {
  return new Error(`settings.json ${context}: ${renderSettingsIssues(error.issues)} — fix or delete ${path}`);
}

export function saveSettings(path: string, s: Settings): void {
  {
    const parsed = Settings.safeParse(s); // validate before writing — never persist an invalid settings file
    if (!parsed.success) throw readableSettingsParseError(path, parsed.error, "write refused (the value being saved is invalid)");
  }
  // Item 5a (2026-09-17 plan): merge onto the CURRENT on-disk shape so a key this schema does not
  // model — anywhere from a stray top-level field to one nested inside a block this schema DOES
  // define — rides through untouched. `readRawSettings` is `null` for an absent OR unparsable
  // (torn) file: there is nothing on disk to preserve keys FROM in either case, so the write falls
  // back to the pre-existing verbatim behavior — which is itself the correct recovery for a torn
  // file (the next good write replaces the garbage with a valid one; whatever keys lived only in the
  // unreadable bytes cannot be recovered by construction, same as any other torn-file loss).
  const raw = readRawSettings(path);
  const merged = raw === null ? s : (mergeUnknownKeys(Settings, raw, s) as Settings);
  // Second validation pass, on the MERGED shape (review round 2): `s` alone can be valid while the
  // merge just copied an unknown key from a `.strict()` block ON DISK (`provider`,
  // `runtimes.official` — see their own schema comments) straight through untouched, because
  // nothing else in this function ever decided that key's fate. The BLOCKER fix above (the `.strict()`
  // branch in `mergeUnknownKeys`'s object case) means a `.strict()` block's stray on-disk key can no
  // longer reach here at all — `owned` wins outright for that whole block — but this pass stays as
  // belt-and-suspenders for any OTHER shape this merge could someday get wrong, with the same
  // readable rendering rather than a raw dump either way. Refuse to persist the result if IT is not a
  // valid `Settings` file — the SAME "never persist an invalid settings file" contract as the line
  // above, extended to what this function actually writes rather than only what the caller handed it.
  const mergedParsed = Settings.safeParse(merged);
  if (!mergedParsed.success) throw readableSettingsParseError(path, mergedParsed.error, "write refused after merging with the on-disk file");
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
}

/** Parse a settings file to a raw object for OVERLAY merging (no zod, no migration) — absent/torn → null. */
export function readRawSettings(path: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/** Pure `Settings -> Settings` provider-model transform (mirrors plugins/lifecycle.ts's
 *  `setPluginEnabled` pattern) — used by `winter model <slug>`. Preserves every other field,
 *  including `provider.reasoningEffort` if set. WS-20: `model` is a `ModelTag` — tag-shape/provider
 *  validation is the CALLER's job (same "never throws on the slug itself" contract as before,
 *  except the slug is now the whole tag): this never throws except on whatever `Settings.parse`
 *  would already reject. */
export function setProviderModel(settings: Settings, model: ModelTag): Settings {
  // WS-20 (review round 4): `provider.model` is UNCONSTRAINED here — any catalog provider, or
  // `winter-test/*` — same as a session's own model always has been. A round-2 gate to
  // `INTERNAL_PROVIDER_IDS` lived here briefly; it's now enforced only where the daemon's internal
  // Provider is actually BUILT (`createProvider`, providers/manager.ts), which answers `null`
  // rather than refusing the write — see `INTERNAL_PROVIDER_IDS`'s own doc comment.
  return { ...settings, provider: { ...settings.provider, model } };
}

/** Pure Settings→Settings: set the active output style (or clear it for undefined/"default").
 *  Preserves every other field — mirrors setProviderModel. */
export function setOutputStyle<T extends { outputStyle?: string }>(settings: T, name: string | undefined): T {
  // WS-21: applied to `sdk/settings.json` (claude `Settings`) through `updateSdkSettings` — generic so
  // it transforms either shape.
  const next = { ...settings };
  if (!name || name === "default") delete next.outputStyle;
  else next.outputStyle = name;
  return next;
}

/** Pure `Settings -> Settings` reasoning-effort transform — used by `winter model --effort
 *  <level>` (effort-only or combined with a model change). `effort: undefined` clears it. */
export function setReasoningEffort(settings: Settings, effort: (typeof REASONING_EFFORTS)[number] | undefined): Settings {
  return { ...settings, provider: { ...settings.provider, reasoningEffort: effort } };
}

/**
 * Winter Phase 8d (P8d-8): pure `Settings -> Settings` transform for THE ONE D30 advisor
 * setting (`settings.runtimes.advisorModel`) — used by `winter model --advisor <slug|auto>`
 * (Task 4.3) and the Mac app's composer-chip picker (Swift side writes the JSON file directly,
 * same "no daemon RPC needed" posture this function's CLI caller takes). `model: undefined`
 * clears the override, mirroring `setReasoningEffort`'s own `effort: undefined` convention — the
 * router then applies D30's per-family defaults (OpenAI family → astra, Claude family → fable,
 * else the session's own model), never a fabricated slug written here.
 *
 * Preserves every OTHER key already under `runtimes` (retention/migrations/winterExecutable/etc.)
 * — a shallow merge one level in, mirroring `provider.configure`'s own handler-side merge
 * (`ipc/server.ts`) rather than replacing the whole block. `settings.runtimes` may be absent
 * entirely (it is `.optional()`); spreading `undefined` is a no-op object literal, so the first
 * write on a home with no `runtimes` block yet still produces a schema-valid one.
 *
 * WS-20: validates a non-blank `model` with `isModelTag` — the schema itself stays a plain
 * `z.string()` (blank must not invalidate the whole settings file, see the schema's own comment),
 * so THIS is the one door that enforces "a stored advisorModel is a real tag or nothing at all".
 * Throws `TypeError` (same shape `parseModelTag` throws) on a non-tag, non-blank value — the
 * CALLER's job to catch and report (mirrors `setProviderModel`'s "never throws on the slug itself,
 * only on what the schema already would" EXCEPT this one extra check, because `advisorModel`'s own
 * schema cannot make it for the blank-is-absent reason above).
 */
export function setAdvisorModel(settings: Settings, model: string | undefined): Settings {
  // `Record<string, unknown>` rather than `Settings["runtimes"]`: that type's OTHER fields
  // (`retention`/`migrations`/`winterLeg`/`winterIdleTimeoutSec`/`handoff`) are non-optional in
  // zod's INFERRED output type (`.prefault({})` fills them during validation), but this function
  // — like `saveSettings` itself (which persists its argument VERBATIM, never the parsed/defaulted
  // result) — must be able to write a `runtimes` block that omits them, exactly as a home that has
  // never touched `runtimes` at all has none of them on disk either. The cast back on `return` is
  // the honest boundary: `Settings.parse` (inside `saveSettings`) is what actually re-validates
  // this shape before it is ever persisted.
  const runtimes: Record<string, unknown> = { ...settings.runtimes };
  const trimmed = model?.trim();
  if (trimmed) {
    // WS-20 (review round 2, nit e): `isModelTag` accepts the `unstated/unstated` sentinel (a
    // STORED record may legitimately carry it), but a CALLER explicitly selecting it here is never
    // a real request — same door-level rejection `resolveModelSelection`/`validateSyncMeta` apply.
    if (!isModelTag(trimmed) || trimmed === UNSTATED_TAG) throw new TypeError(`not a model tag: ${JSON.stringify(trimmed)}`);
    runtimes.advisorModel = trimmed;
  } else {
    delete runtimes.advisorModel;
  }
  return { ...settings, runtimes: runtimes as Settings["runtimes"] };
}

/** The exact SDK-grammar rule string a skill toggle writes/removes — spelled once so the writer
 *  (`setSkillDenied` below) and the reader (`ipc/server.ts`'s `skills.list` handler) can never
 *  drift onto two different strings for the "same" skill. */
export function skillDenyRule(skillName: string): string {
  return `Skill(${skillName})`;
}

/**
 * Daemon settings surface batch 3 (item 2): pure `Settings -> Settings` transform toggling ONE
 * `Skill(<name>)` deny rule in `settings.permissions.deny` — the SAME "load, transform, save"
 * pattern `setAdvisorModel`/`setModelRole` already use (`ipc/server.ts`'s `settings.setSkillDenied`
 * handler). `denied: true` appends the rule (a no-op if already present — dedup, same posture
 * `PermissionRules.append` uses for `allow`); `denied: false` removes it (a no-op if absent).
 * Preserves every OTHER entry in `permissions.deny` untouched, INCLUDING a hand-written rule of a
 * different shape (`"Agent(fork)"`, a malformed string, …) — this function only ever adds/removes
 * its OWN exact `Skill(<name>)` string, never rewrites or validates the rest of the array.
 */
export function setSkillDenied<T extends { permissions?: { deny?: string[] } }>(settings: T, skillName: string, denied: boolean): T {
  const rule = skillDenyRule(skillName);
  const current = settings.permissions?.deny ?? [];
  const next = denied
    ? (current.includes(rule) ? current : [...current, rule])
    : current.filter((r) => r !== rule);
  // WS-21: the one writer is `settings.setSkillDenied`, which applies this to `sdk/settings.json`
  // (claude `Settings`) through `updateSdkSettings` — generic so it transforms either shape.
  return { ...settings, permissions: { ...settings.permissions, deny: next } };
}

/**
 * Daemon settings surface (2026-09-17 plan, item 4): the nine model-bearing settings roles the Mac
 * app's Roles pane offers ONE door for. Mirrors `packages/protocol/src/methods.ts`'s `ModelRole`
 * enum LITERALLY — protocol never depends on core, so that file hand-spells the same nine strings;
 * this is the canonical list, kept in sync by hand (the same layering every protocol-side mirror of
 * a core-only shape already has — there is no shared import to enforce it).
 */
export const MODEL_ROLES = [
  "pins.dispatch", "pins.dream", "pins.cleaner", "pins.research", "pins.researchFallback",
  "provider.model", "titles.model", "reviewer.model", "runtimes.advisorModel",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * WS-20: which of the three routing shapes a role's model actually resolves through — the one
 * thing that decides its `permitted` set in `modelRoleInfo` below.
 *
 *  - `"internal-provider"`: routed through the daemon's SINGLE internal `Provider` instance
 *    (`providers/manager.ts`'s `createProvider`, built for `ownProviderFor(settings)` only when
 *    that provider is one of `INTERNAL_PROVIDER_IDS`, else not built at all) — `pins.dream`/
 *    `pins.cleaner`/`pins.researchFallback` (gated by `internalModelFor`, providers/manager.ts) and
 *    `titles.model`/`reviewer.model` (same gate, daemon.ts) all run on it. A tag naming any OTHER
 *    provider is refused at read time (`internalModelFor` logs and skips), never guessed at.
 *  - `"any"`: routed per-session through the runtime SDK exactly like an ordinary session model —
 *    `provider.model` (the daemon's own default chat model, `ownProviderFor`), `pins.dispatch`
 *    (dispatch's fixed model, `session-driver.ts`) and, since 2026-09-18, `pins.research`
 *    (`WebFetch`'s page digest, `Options.web.fetch.digestModel` inside the child) — any catalog
 *    provider the daemon has (or could have) credentials for, unconstrained by
 *    `INTERNAL_PROVIDER_IDS`.
 *  - `"same-as-session"`: no role reports it any more. `runtimes.advisorModel` did until D3
 *    (2026-09-22), when `buildWinterOptions` dropped an advisor on any provider but the session's;
 *    it now sends the FULL tag plus that provider's own `authRef`, and the child runs the advisor on
 *    its own provider — the `pins.research` shape — so the role is `"any"`. Kept in the union because
 *    it is a protocol enum value (`ModelRoleConstraintSchema`) a client may still decode.
 */
export type ModelRoleConstraint = "internal-provider" | "any" | "same-as-session";

export function modelRoleConstraint(role: ModelRole): ModelRoleConstraint {
  switch (role) {
    case "pins.dream": case "pins.cleaner": case "pins.researchFallback":
    case "titles.model": case "reviewer.model":
      return "internal-provider";
    // 2026-09-18 (user ruling, agent SDK 0.0.17): `pins.research` STOPS being an internal-Provider
    // role. It is `WebFetch`'s page-digest model now, and that call runs INSIDE the runtime child —
    // `Options.web.fetch.digestModel` + its own `authRef`, resolved through the same selection path
    // as a session model, on any catalog provider this daemon has a credential for. Nothing about it
    // touches `providers/manager.ts`'s single internal `Provider` any more, so narrowing `permitted`
    // to the currently bound backend would refuse models the child can genuinely run.
    // `pins.researchFallback` keeps its `internal-provider` answer, but the constraint is moot: the role
    // is RETIRED (its consumer, the multi-page research runner, went with `ReadPage`) and
    // `modelRoleInfo` reports `permitted: []` for it regardless of what this says. Kept rather than
    // re-answered because `constraint` is a wire field a client may render, and "internal-provider" is
    // what it has always reported.
    case "pins.research":
      return "any";
    case "provider.model": case "pins.dispatch":
      return "any";
    // D3 (2026-09-22): the advisor runs on its OWN provider (full tag + that provider's `authRef`,
    // `mode-options.ts`), so it is no longer "whatever the session itself is running".
    case "runtimes.advisorModel":
      return "any";
  }
}

/** One catalog provider's servable rows for a `modelRoleInfo` `permitted` entry — every model row
 *  the daemon could actually NAME for this provider today: `status !== "blocked"` (the only status
 *  the registry refuses to resolve, per `winter-provider-catalog`'s own doc on `ModelStatus`) and
 *  the provider's own `risk.class !== "blocked"` (the SAME floor `credentialInventory()`,
 *  runtime-sdk/keychain.ts, already applies to which providers get a Keychain slot at all — a role
 *  picker must never offer a provider the credential surface itself refuses to list) and
 *  `scope === "llm"` (stt/tts/embedding/image/video/search rows are never model-role candidates).
 *  `filterProviderIds` narrows to a single provider (the `"internal-provider"` constraint); omitted
 *  returns every eligible provider (the `"any"`/`"same-as-session"` constraints). A provider with
 *  zero servable rows after this filter is dropped entirely — never an empty-but-present entry.
 *
 *  EXPORTED for `providers/model-catalog-wire.ts`'s `models.catalog` reader, called there
 *  unfiltered (the exact same call `modelRoleInfo` makes for its "any"/"same-as-session" roles) so
 *  that surface's eligible provider/model set is PROVABLY the same one `permitted` can ever name —
 *  reused, never a second hand-copy of this predicate that could drift from it. */
export function permittedProviders(filterProviderIds?: ReadonlySet<string>): Array<{ providerId: string; displayName: string; models: ModelTag[] }> {
  const catalog = loadCatalog();
  const out: Array<{ providerId: string; displayName: string; models: ModelTag[] }> = [];
  for (const p of catalog.providers) {
    if (p.risk.class === "blocked") continue;
    if (p.scope !== "llm") continue;
    if (filterProviderIds !== undefined && !filterProviderIds.has(p.id)) continue;
    // `deprecated` (SDK 0.0.23: a vendor-retired row) is never offered either — it still resolves for a
    // stored tag, but nothing here may name it as a fresh choice.
    const models = catalog.models.filter((m) => m.providerId === p.id && m.status !== "blocked" && m.status !== "deprecated").map((m) => m.key as ModelTag);
    if (models.length === 0) continue;
    out.push({ providerId: p.id, displayName: p.displayName, models });
  }
  return out;
}

/**
 * USER RULING 2026-09-19: Winter's OWN background jobs — session titles, the bash safety reviewer,
 * the dreamer and the session cleaner — never run on a FIRST-PARTY CLAUDE provider. "claude models
 * run through anthropic which has its own reviewer anyway": the official leg exists for Claude, and
 * a Winter-internal job that borrowed an Anthropic credential would be spending a subscription/
 * Console entitlement on work the user never asked for.
 *
 * The three ids, and why each is here: `anthropic` (the API-key row), `console` (the Console-profile
 * row) and `cc` (reserved for the claude.ai subscription arm, `runtime-sdk/create.ts`'s tag prefixes).
 * This is an exclusion by PROVIDER ID, deliberately NOT by adapter family — a third-party provider
 * that merely speaks the Anthropic dialect (`deepseek-anthropic`, `zai-anthropic`, `kimi-coding`, …)
 * is an ordinary token-priced vendor and stays eligible.
 */
export const CLAUDE_FIRST_PARTY_PROVIDER_IDS = ["anthropic", "console", "cc"] as const;

/**
 * A LIVE snapshot of which providers this home actually holds credential material for, threaded
 * into the otherwise-pure readers below.
 *
 * Credential presence is an ASYNCHRONOUS fact (a Keychain read, ~150 slots wide) and every reader
 * in this module is synchronous and pure, so presence is never probed here — it arrives as a value.
 * `providers/internal-view.ts` owns the one snapshot the daemon threads everywhere (seeded from
 * `daemon.ts`'s own boot probe, refreshed on every credential write), which is what makes the wire
 * (`settings.modelRoles`), the default-tag readers below and the actual dispatcher
 * (`providers/internal-router.ts`) provably read the SAME answer — the generalisation of the
 * anti-race property `createRebindableProvider`'s header describes.
 *
 * ABSENT means "no snapshot was threaded": every reader then falls back to the pre-2026-09-19
 * behaviour (derive from `settings.provider.model` alone), which is what keeps ~10 existing
 * `pinsFor` callers and every test that predates this unchanged.
 */
export interface InternalProviderSnapshot {
  /** Eligible providers (`internalEligibleProviderIds`) whose credential slot holds material NOW. */
  credentialed: ReadonlySet<string>;
}

let memoisedInternalEligible: ReadonlySet<string> | undefined;

/**
 * WHICH catalog providers Winter's own jobs may run on — derived from the pinned catalog, never a
 * hand-kept list (the same discipline `credentialInventory()` already follows for credential slots).
 *
 * Four conditions, each for its own reason:
 *  1. the provider is an ordinary model-role candidate at all — `permittedProviders()`'s own floor
 *     (`scope === "llm"`, `risk.class !== "blocked"`), reused rather than restated;
 *  2. it is not a first-party Claude provider (`CLAUDE_FIRST_PARTY_PROVIDER_IDS`, the user's ruling);
 *  3. this daemon has a credential SLOT for it — a row in `credentialInventory()`. That inventory is
 *     itself catalog-derived and already excludes every `requiresUserEndpoint` row (`azure-ai`, `oci`
 *     — whose shipped endpoint is a placeholder host), every local-none row and every cloud-
 *     credential-chain-only row, so a provider with no way to store a key is absent by construction
 *     rather than by a denylist;
 *  4. the daemon can actually DRIVE its adapter family — `INTERNAL_ADAPTER_IDS`
 *     (`providers/internal-adapters.ts`). `bedrock`/`vertex` are the exclusions with teeth: their
 *     credential material is `aws`/`gcp-*`, which `providers/credential-store.ts` refuses typed.
 *
 * Memoised: `loadCatalog()` is itself memoised and immutable for the life of the process.
 */
export function internalEligibleProviderIds(): ReadonlySet<string> {
  if (memoisedInternalEligible !== undefined) return memoisedInternalEligible;
  const excluded = new Set<string>(CLAUDE_FIRST_PARTY_PROVIDER_IDS);
  const withSlots = new Set(credentialSlotProviderIds());
  const drivable = internalDrivableAdapterIds();
  const out = new Set<string>();
  for (const p of permittedProviders()) {
    if (excluded.has(p.providerId)) continue;
    if (!withSlots.has(p.providerId)) continue;
    const adapterId = loadCatalog().providers.find((c) => c.id === p.providerId)?.adapterId;
    if (adapterId === undefined || !drivable.has(adapterId)) continue;
    out.add(p.providerId);
  }
  memoisedInternalEligible = out;
  return out;
}

/**
 * WHICH eligible provider Winter's own jobs PREFER, given a live credential snapshot — the answer
 * an internal role with no explicit pin follows.
 *
 * Three rungs, and the first is the whole point of the 2026-09-19 fix (the THIRD produces no runnable
 * default at all — see its own comment in the body): `settings.provider.model`'s own
 * provider wins whenever it is eligible AND credentialed, so a DeepSeek user with a DeepSeek key gets
 * titles on DeepSeek with ZERO setup. Only when the session default's provider cannot serve these
 * jobs (a Claude default, or an eligible provider with no key stored yet) does this fall to
 * `internalProviderPreferenceOrder()`'s first credentialed member — never to Claude, which is not in
 * the eligible set at all.
 *
 * `undefined` means "nothing runnable": every internal role then reports `no-internal-credential`
 * (`providers/internal-router.ts`) and the jobs are inert — one log line per change, never per call.
 *
 * With NO snapshot this reports `ownProviderFor(settings)` when eligible and `undefined` otherwise —
 * i.e. exactly the pre-2026-09-19 "is the daemon's own provider internal" question, so a caller that
 * threads no snapshot is unchanged.
 */
export function preferredInternalProviderFor(
  settings: Settings | null | undefined,
  snapshot?: InternalProviderSnapshot,
): string | undefined {
  const eligible = internalEligibleProviderIds();
  const own = ownProviderFor(settings);
  if (snapshot === undefined) return eligible.has(own) ? own : undefined;
  if (eligible.has(own) && snapshot.credentialed.has(own)) return own;
  // M-3 RULING (2026-09-19, review): the fallback considers ONLY `INTERNAL_PROVIDER_IDS`. The wider
  // `internalProviderPreferenceOrder()` tail is gone from this path: it is alphabetical inventory order
  // over ~94 providers, so "the first credentialed one" is a coin toss the user never asked for, and
  // only 3 of those 94 declare a `terra` slot — a default on any of the others had to guess a model.
  // Never guess a provider AND a model the user did not choose: codex-oauth/openai are the two Winter's
  // own jobs have always run on, they both declare the family slots, and anything else needs an
  // explicit pin (`no-default-model`, `internalRoleEffectiveTag` below).
  for (const id of INTERNAL_PROVIDER_IDS) {
    if (eligible.has(id) && snapshot.credentialed.has(id)) return id;
  }
  // THE LAST RUNG EXISTS ONLY TO NAME A REFUSAL, and it is worth being explicit about why, because it
  // looks like the guess the rung above just removed and is the opposite of one.
  //
  // A home with (say) only a Groq key and a Claude session default HAS a credential Winter could use —
  // it just has no model on it that the user can be said to have chosen. Answering `undefined` here
  // would report `no-internal-credential` ("sign in / add a key"), which is both wrong and unactionable
  // for that user: they already did. So this names the provider, `internalRoleDefaultTagFor` still
  // refuses to invent a model on it, and the role reports `no-default-model` ("pick a model") pointing
  // at the provider in question. NOTHING EVER RUNS off this rung — it produces no tag by construction.
  for (const id of internalProviderPreferenceOrder()) {
    if (snapshot.credentialed.has(id)) return id;
  }
  return undefined;
}

/**
 * The deterministic fallback order — `INTERNAL_PROVIDER_IDS` first, in their own order (the two
 * providers Winter's jobs have always run on; a user who signed in with ChatGPT expects the dreamer
 * on Codex, not on whichever third-party key happens to be stored too), then every other eligible
 * provider in `credentialInventory()` order, which is the ONE provider ordering this daemon already
 * pins deliberately (see that function's "THE ORDER IS LOAD-BEARING" note).
 *
 * Deterministic by construction: no `Set` iteration order and no catalog scan order leaks into it.
 */
export function internalProviderPreferenceOrder(): readonly string[] {
  const eligible = internalEligibleProviderIds();
  const head = (INTERNAL_PROVIDER_IDS as readonly string[]).filter((id) => eligible.has(id));
  const seen = new Set(head);
  const tail = credentialSlotProviderIds().filter((id) => eligible.has(id) && !seen.has(id));
  return [...head, ...tail];
}

/**
 * The DEFAULT model for an internal role sitting on `providerId` — the rule that had to be invented
 * because today's defaults are FACING NAMES (`terra`/`luna`) that only the OpenAI family declares,
 * and 2026-09-19 lets these roles run on any eligible provider.
 *
 * TWO rungs, and there is deliberately no third:
 *  1. the provider's own `terra`/`luna` family slot (`facingNameToTag`) — the family-slot machinery,
 *     used FIRST so codex-oauth/openai users' defaults are byte-identical to what they were before;
 *  2. `settings.provider.model` itself, when this IS the session default's provider — the model the
 *     user already picked, never a model this code chose for them. This is the DeepSeek case: no
 *     `terra` slot exists on that provider, and titling on the user's own default is both correct and
 *     zero-setup.
 *
 * `undefined` otherwise, which is a REFUSAL and the point of M-3 (review, 2026-09-19). A first draft had
 * a third rung — "the provider's first non-blocked llm row in catalog order" — and measurement killed
 * it: only 3 of 94 eligible providers declare a `terra` slot, catalog/inventory order is alphabetical,
 * and that rung picked things like `agentrouter/claude-opus-4-8`, `kilocode/anthropic/claude-opus-5`, a
 * `-Base` completion model and a vision model. Winter does not choose a model on a provider the user
 * did not choose: the role reports `no-default-model` and stays inert until the user picks one.
 */
export function internalRoleDefaultTagFor(
  settings: Settings | null | undefined,
  providerId: string,
  slot: "terra" | "luna",
): ModelTag | undefined {
  const slotted = facingNameToTag(providerId, slot);
  if (slotted !== undefined) return slotted;
  if (providerId === ownProviderFor(settings)) return (settings?.provider?.model ?? DEFAULT_PROVIDER.model) as ModelTag;
  return undefined;
}

/**
 * THE ONE effective-model rule for an internal-jobs role — the explicit pin, else the preferred
 * credentialed provider's default row. `null` ONLY when the role has no pin and nothing is credentialed
 * (there is then no model to report and no job to run).
 *
 * Lives HERE, pure and sync, rather than in `providers/internal-router.ts`, because BOTH the wire
 * (`modelRoleModel` below, which cannot import the router) and the dispatcher must answer it — and two
 * spellings of "explicit ?? preferred ?? default" is exactly how the pre-2026-09-19 bookkeeping and the
 * actually-bound backend came to disagree.
 *
 * A role's `explicit` tag is reported VERBATIM even when it names a provider Winter's own jobs cannot
 * run (a Claude pin): the role really does sit on that model, and the reason it is not running rides the
 * `problem` field instead. Never silently substituted.
 */
export function internalRoleEffectiveTag(
  settings: Settings | null | undefined,
  role: InternalJobRole,
  snapshot?: InternalProviderSnapshot,
  /** `ignoreExplicitPin`: answer as if the role had NO pin — the reviewer's pin fallback (user ruling
   *  2026-09-19, `providers/internal-router.ts`'s `ResolveOptions`) asks exactly this question when a
   *  pinned reviewer's own tag turns out to be unrunnable. No other caller passes it. */
  opts?: { ignoreExplicitPin?: boolean },
): ModelTag | null {
  const explicit = opts?.ignoreExplicitPin === true ? undefined : explicitInternalRolePin(settings, role);
  if (explicit !== undefined) return explicit;
  const preferred = preferredInternalProviderFor(settings, snapshot);
  if (preferred === undefined) return null;
  return internalRoleDefaultTagFor(settings, preferred, INTERNAL_ROLE_SLOT[role]) ?? null;
}

/**
 * M-3: WHY a role has no effective tag — the two cases `internalRoleEffectiveTag`'s `null` collapses,
 * which the wire has to tell apart because they have different fixes.
 *
 *  - `"no-credential"`: nothing Winter's jobs can use holds a credential. Fix: sign in / add a key.
 *  - `"no-default-model"`: a provider IS credentialed, but Winter will not choose a model on it
 *    (no family slot, and it is not the session default's provider). Fix: pick one in Settings › Roles.
 *
 * `undefined` when the role HAS a tag — there is nothing to explain.
 */
export function internalRoleNoTagReason(
  settings: Settings | null | undefined,
  role: InternalJobRole,
  snapshot?: InternalProviderSnapshot,
): { reason: "no-credential" | "no-default-model"; providerId?: string } | undefined {
  if (internalRoleEffectiveTag(settings, role, snapshot) !== null) return undefined;
  const preferred = preferredInternalProviderFor(settings, snapshot);
  return preferred === undefined ? { reason: "no-credential" } : { reason: "no-default-model", providerId: preferred };
}

/** The four LIVE roles that run on Winter's own internal calls. `pins.researchFallback` is retired (its
 *  consumer went with `ReadPage`, itself since retired) and turn compaction has NO production consumer
 *  at all — `agent/compactor.ts` is constructed only by its own test and the golden-capture script — so
 *  neither is here: a role in this union is one something actually calls. */
export const INTERNAL_JOB_ROLES = ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner"] as const;
export type InternalJobRole = (typeof INTERNAL_JOB_ROLES)[number];

export function isInternalJobRole(role: ModelRole): role is InternalJobRole {
  return (INTERNAL_JOB_ROLES as readonly string[]).includes(role);
}

/** Each internal role's default family slot — `terra` for all four, which is what `pinsFor` defaulted
 *  dream/cleaner to and what `titles.model`/`reviewer.model` inherited from `provider.model`'s own
 *  provider before 2026-09-19. Spelled once so the wire and the dispatcher cannot differ. */
const INTERNAL_ROLE_SLOT: Readonly<Record<InternalJobRole, "terra" | "luna">> = {
  "titles.model": "terra",
  "reviewer.model": "terra",
  "pins.dream": "terra",
  "pins.cleaner": "terra",
};

/** Where each internal role's EXPLICIT override actually lives in settings.json. */
export function explicitInternalRolePin(settings: Settings | null | undefined, role: InternalJobRole): ModelTag | undefined {
  switch (role) {
    case "titles.model": return settings?.titles?.model;
    case "reviewer.model": return settings?.reviewer?.model;
    case "pins.dream": return settings?.pins?.dream;
    case "pins.cleaner": return settings?.pins?.cleaner;
  }
}

/** The provider ids `credentialInventory()` names, de-duplicated, in inventory order. Spelled here
 *  (rather than inline twice above) because the inventory carries TWO rows for `anthropic` and the
 *  order of the FIRST occurrence is what `internalProviderPreferenceOrder` promises. */
function credentialSlotProviderIds(): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const slot of credentialInventory()) {
    if (seen.has(slot.provider)) continue;
    seen.add(slot.provider);
    out.push(slot.provider);
  }
  return out;
}

/**
 * 2026-09-18: THE ONE READER of a role's stored reasoning effort — `undefined` means "no effort is
 * stored for this role", and this function's whole job ends there: what is then SENT is the consumer's
 * own pre-existing default (none at all for most roles; a code constant for dream/cleaner/research/
 * dispatch), decided in `effortToSpendForRole` below. Nothing here fabricates a level, for the reason
 * `effortsForModel`'s own doc gives about `""` vs `"none"`: an unset effort omits the `reasoning`
 * block entirely, and collapsing that to `"none"` would start sending an explicit level the user
 * never chose.
 *
 * `provider.model` is routed to `settings.provider.reasoningEffort` — its established home, written by
 * `winter model --effort` (`setReasoningEffort`) and read by every existing consumer of the daemon's
 * own default effort. That role deliberately has NO `roleEfforts` entry (see the block's own schema
 * comment): this function is the only place the exception is spelled, so every caller — the read
 * (`modelRoleInfo`), the write (`setModelRole`) and any future consumer — asks one question and gets
 * one answer.
 */
export function roleEffortFor(settings: Settings | null | undefined, role: ModelRole): string | undefined {
  if (role === "provider.model") return settings?.provider?.reasoningEffort;
  return settings?.roleEfforts?.[role];
}

/**
 * 2026-09-18 (the spend side): can this role's call path carry a reasoning effort AT ALL?
 *
 * `roleEffortFor` above answers "what is stored"; this answers "is there anywhere for it to go". An
 * exhaustive `switch` for `roleAcceptsClientEffort`'s reason — a tenth role must be a TYPE ERROR here,
 * not a silent "yes" that puts a control in the UI which nothing will ever honour.
 *
 *  - `pins.dispatch` / `provider.model` — a runtime child's `Options.effort` (`session-driver.ts`'s
 *    `optionsFor`).
 *  - the four LIVE `"internal-provider"` roles (`pins.dream`/`pins.cleaner`/`titles.model`/
 *    `reviewer.model`) — `TurnRequest.reasoningEffort` on the daemon's internal `Provider`
 *    (`providers/runtime-provider.ts`'s `mapTurnRequest` forwards it verbatim).
 *  - `pins.research` — NO longer: `WebFetch`'s digest has no effort field on the wire.
 *  - `pins.researchFallback` — NO: its one consumer retired. See `roleCarriesEffort` for both.
 *  - `runtimes.advisorModel` — NO. The Winter agent SDK's `AdvisorConfig` is `{ model, authRef? }` and
 *    nothing else, and the pinned Claude Agent SDK's `Options` has no advisor effort either (its only
 *    `effort` is the SESSION's own). Agent-SDK parity comes first in this project, so the daemon does
 *    not grow an option the SDKs do not have and does not pretend to spend one: `modelRoleInfo`
 *    reports `efforts: null` for this role whatever its model, and the write door refuses an effort
 *    for it and says why. The `roleEfforts` schema KEEPS the key: a settings.json written while the
 *    door briefly accepted one must still load, and `effort: null` still clears it.
 */
/**
 * 2026-09-18 (the web-tools ruling) — TWO roles answer `false` now, and for the same reason: there is
 * nowhere left for their stored effort to go.
 *
 *  - `pins.research` — its model moved INTO the runtime child (`Options.web.fetch.digestModel`,
 *    `WebFetch`'s page digest), and the SDK's `WebFetchConfig` has NO effort field:
 *    `{digestModel, authRef, privateAddressPolicy}` is the whole shape. The note the spine left here
 *    said "when the research runner retires, this arm must become `false`" — it has, so it is. If the
 *    SDK ever grows a `web.fetch.effort` this flips back with it and nothing else changes.
 *  - `pins.researchFallback` — the ONLY consumer it ever had was that multi-page research runner, which
 *    retired with `ReadPage`. The SETTINGS KEY is kept (an old settings.json must still load, and
 *    `pinsFor` still resolves it) but nothing reads the value, so an effort for it is unspendable by
 *    construction. `modelRoleInfo` marks the role retired; see its own note there.
 *
 * `modelRoleInfo` therefore reports `efforts: null` for both, and the write door refuses an effort for
 * either — which is this function's whole point: never put a control in the Roles pane that stores a
 * value nothing will ever spend.
 */
export function roleCarriesEffort(role: ModelRole): boolean {
  switch (role) {
    case "pins.dispatch": case "provider.model":
      return true;
    case "pins.dream": case "pins.cleaner":
    case "titles.model": case "reviewer.model":
      return true;
    case "pins.research": case "pins.researchFallback":
    case "runtimes.advisorModel":
      return false;
  }
}

/**
 * 2026-09-18: THE ONE SPEND-SIDE RESOLVER — "the effort to put on the request for this role, given the
 * model it is ACTUALLY about to run on and the default this consumer had before roles could store
 * one". Every consumer calls this and nothing else; the fallback chain is spelled here once.
 *
 * It lives HERE, beside `roleEffortFor`, rather than beside `implicitEffortFor` for a plain layering
 * reason: this module already imports `provider-selection.ts` (the catalog row lookups above) and
 * that module imports nothing from this one, so the resolver needs no new edge here and would need a
 * cycle-making one there.
 *
 * Three cases, in order:
 *
 *  1. NOTHING STORED -> `consumerDefault`, returned VERBATIM. This is the "absent means unchanged" rule
 *     and it is why the default is the caller's to pass rather than this function's to compute: the
 *     consumers do not share one (`DREAM_EFFORT` "medium", `CLEANER_EFFORT` "low", `RESEARCH_EFFORT`
 *     "none", dispatch's already-mapped `implicitEffortFor(pin, DISPATCH_EFFORT)`, and nothing at all
 *     for titles/the reviewer/an ordinary session), and they do not all map theirs — the internal
 *     callers send their constant raw. Routing those constants through `implicitEffortFor` here would
 *     change what an untouched install sends. NOTE this makes `roleEffortFor`'s "absent = no effort is
 *     sent" an over-statement for the four roles with a code default; the READ side still reports only
 *     what is stored, which is the honest answer to "what did the user choose".
 *
 *  2. `"none"` -> `"none"` when the model's row declares a non-empty vocabulary or has no row at all;
 *     omitted (`undefined`) when the row declares none. This deliberately BYPASSES `implicitEffortFor`:
 *     that function asks `vocab.includes(wanted)`, the catalog lists `"none"` for almost no row (it is
 *     Winter's own "off", which the write door admits on ANY row with a vocabulary), and a miss there
 *     falls through to the row's `defaultEffort` — it would silently turn the user's explicit "no
 *     reasoning" into "medium". The rule used instead is the write door's own
 *     (`assertRoleEffortSelectable`), so what was selectable at write time is what is spent. What
 *     `"none"` then MEANS is the transport's business, not a second meaning invented here: the runtime
 *     leg's `sdkEffortOf` drops it (exactly what it does to a session's own stored `"none"` — the SDK's
 *     `EffortLevel` has no such member, so the request carries no effort).
 *
 *     2026-09-19 (review M-1) — the INTERNAL `Provider` path DROPS it too now, and this paragraph is why.
 *     It used to send `"none"` verbatim, which was only ever safe because those adapters were built with
 *     no descriptors at all; with real ones the SDK's `mapEffort` refuses `"none"` outright, and piping it
 *     through `implicitEffortFor` to dodge that would hit exactly the miss-to-`defaultEffort` trap this
 *     case exists to avoid (measured: `"none"` on `codex-oauth/gpt-5.6-terra` came back `"medium"`). So
 *     `internalWireEffortFor` (providers/internal-provider.ts) drops it, and the honest consequence is
 *     that the request carries NO effort and the PROVIDER's own default applies — which escalated past the
 *     user's intent (measured 2026-09-22: `"medium"` on `codex-oauth/gpt-5.6-luna`, timing out the
 *     cleaner). So since 2026-09-22 `internalWireEffortFor` sends a reasoning row that lacks a `"none"`
 *     tier its LOWEST declared effort instead; a row with no vocabulary still sends nothing, and a row
 *     that lists `"none"` is SENT `"none"` (SDK 0.0.23/0.0.24 settled the former SDK CARRY: the catalog now
 *     lists a literal `"none"` exactly where the vendor documents one for the adapter's dialect — the
 *     metered GPT-5.x/6 rows among them — and dropped the undocumented one on DeepSeek's chat rows).
 *
 *  3. ANY OTHER LEVEL -> `implicitEffortFor(model, stored)`: sent when the row lists it, else the row's
 *     own default, else omitted. NEVER a refusal and never a throw — the write door validated the
 *     effort against the model the role sat on THEN, but `setModelRole` deliberately lets the model move
 *     under a stored effort, and a background job or a dispatch spawn must not fail over a tier that no
 *     longer fits ("a pin must never make a session refuse over a tier the user never chose").
 *
 * A role that cannot carry an effort (`roleCarriesEffort`) always answers `consumerDefault`: a stale
 * stored value for it is inert by construction rather than by every caller remembering to check.
 *
 * `model` is the provider-qualified TAG the request is about to name — not `modelRoleInfo`'s reported
 * model when the two differ (a `titles.model` naming an unbound provider falls back to the bound
 * provider's live model, and the effort must be mapped onto THAT row).
 */
export function effortToSpendForRole(
  settings: Settings | null | undefined,
  role: ModelRole,
  model: string,
  consumerDefault: string | undefined,
  /** R.1 (controller ruling): the INTERNAL jobs pass this — a stored effort the row does not list never
   *  maps UP onto a heavier row default (`internalEffortNoEscalationFor`); it is dropped instead. */
  opts?: { neverEscalate?: boolean },
): string | undefined {
  if (!roleCarriesEffort(role)) return consumerDefault;
  const stored = roleEffortFor(settings, role);
  if (stored === undefined) return consumerDefault;
  if (stored === "none") {
    if (rowForTag(model) === undefined) return stored;
    return (effortVocabularyFor(model) ?? []).length > 0 ? stored : undefined;
  }
  return opts?.neverEscalate === true ? internalEffortNoEscalationFor(model, stored) : implicitEffortFor(model, stored);
}

/**
 * 2026-09-18: may this role's effort be a WINTER-LEVEL tier (`CLIENT_EFFORTS`, e.g. `"ultra"`)?
 *
 * `clientEffortEligible` (above) answers this for a SESSION, by mode. A role is not a session, so the
 * question has to be re-asked per role rather than by handing that function a mode — and in
 * particular NEVER by handing it `undefined`, which it reads as "code" by the store-wide convention
 * and would therefore admit a tier for every role that has no session at all.
 *
 * An exhaustive `switch`, so adding a tenth role is a TYPE ERROR here rather than a silent inheritance
 * of whichever answer happened to be last. Every arm is `false` today, and each for its own reason:
 *
 *  - `pins.dispatch` — this model runs DISPATCH sessions, and `clientEffortEligible("dispatch")` is
 *    already `false`: a tier rewrites the system prompt with a proactive-delegation posture, and a
 *    dispatch session has its own base prompt and toolset. Asked through that function rather than
 *    hardcoded, so the two move together if dispatch's eligibility ever changes.
 *  - `provider.model` — a code session with no override of its own DOES fall back to this model, so
 *    eligibility is not what refuses here: the STORAGE does. Its effort lives in
 *    `provider.reasoningEffort`, whose schema is `z.enum(REASONING_EFFORTS)` — a tier cannot be
 *    persisted there at all. A session that wants one selects it per-session (`session.setEffort`,
 *    where `clientEffortEligible` governs), which is where a prompt-rewriting choice belongs anyway.
 *  - the five `"internal-provider"` roles and `pins.research` (`pins.dream`/`cleaner`/`researchFallback`,
 *    `titles.model`, `reviewer.model`) — these are not sessions in any sense: they are the daemon's
 *    own internal `Provider` calls (providers/manager.ts). There is no agent prompt for a tier to
 *    rewrite and no `spawn_agent` for a delegation posture to name, and those calls do not run through
 *    `AgentEngine.resolveSel` — the one place `wireEffort` translates a tier away — so a stored tier
 *    would reach a request body verbatim and be refused by the endpoint's global `invalid_value` enum.
 *    That is precisely the bug `CLIENT_EFFORTS`' own doc says must never be re-created.
 *  - `runtimes.advisorModel` — the advisor is a TOOL inside somebody else's session, not a session. Its
 *    host session's own tier (and prompt) is the one in play; a second, independent tier here would
 *    have no prompt of its own to change.
 */
export function roleAcceptsClientEffort(role: ModelRole): boolean {
  switch (role) {
    case "pins.dispatch":
      return clientEffortEligible("dispatch");
    case "provider.model":
      return false;
    case "pins.dream": case "pins.cleaner": case "pins.research": case "pins.researchFallback":
    case "titles.model": case "reviewer.model":
      return false;
    case "runtimes.advisorModel":
      return false;
  }
}

/**
 * WS-20: per-role read for `settings.modelRoles` (the Mac app's Roles pane) — the effective model
 * (an explicit override, or the SAME default rule the role's real consumer uses), whether that is
 * an explicit override, the routing `constraint` (`modelRoleConstraint` above), and the `permitted`
 * providers/tags the daemon can actually serve for this role TODAY — never hardcoded in the UI,
 * which is `settings.modelRoles`'s whole reason to exist (the "per-provider internal Provider"
 * follow-up widens `INTERNAL_PROVIDER_IDS` later and this reader picks it up automatically).
 *
 * `boundProviderId` (fix wave, pre-merge review, finding 4): the CURRENTLY BOUND internal-Provider
 * backend's own catalog providerId — `agentProvider?.live?.().providerId`, live over
 * `RebindableProvider.refresh` (`providers/manager.ts`) — the SAME value `internalModelFor`
 * (`providers/manager.ts`) and `daemon.ts`'s `titles.model`/`reviewer.model` gates now compare a pin
 * against. Every OTHER caller of the internal Provider was moved onto this comparison already; this
 * function was the one straggler still computing its `"internal-provider"` `permitted` set from
 * `ownProviderFor(settings)` alone — a PURE settings read that can disagree with the actual bound
 * backend for as long as a rebind has not caught up, or forever, on a rebind that failed (no stored
 * credential for the new provider yet — `RebindableProvider.refresh` never tears down the old
 * backend on failure, so the daemon keeps running on it, but this reader used to advertise the NEW,
 * unreachable one as `permitted` anyway). Absent (every caller/test that predates this fix, or a
 * daemon with no internal Provider at all) falls back to `ownProviderFor(settings)`, unchanged.
 *
 * `runtimes.advisorModel`'s "unset" case has no single default to report at all (see
 * `modelRoleConstraint`'s own doc) — it reads back `null`, never a guess.
 *
 * 2026-09-18 — the EFFORT half (`effort`/`effortExplicit`/`efforts`). Deliberately unlike `model`
 * above, `effort` reports ONLY what is stored: an absent effort is not "fall back to a default", it is
 * "send no effort and let the provider's own default apply" (`roleEffortFor`'s doc), and naming a level
 * for it would put a choice in the UI that the user never made. `efforts` is the role's CURRENT model's
 * vocabulary, carried here so the effort control needs no second `models.catalog` lookup, with
 * `effortVocabularyFor`'s three states intact (`null` = no vocabulary known — including a role whose
 * `model` is itself `null`; `[]` = a real row that takes no effort setting).
 */
export function modelRoleInfo(settings: Settings | null | undefined, role: ModelRole, boundProviderId?: string, internal?: InternalProviderSnapshot): {
  model: ModelTag | null;
  explicit: boolean;
  constraint: ModelRoleConstraint;
  permitted: Array<{ providerId: string; displayName: string; models: ModelTag[] }>;
  effort: string | null;
  effortExplicit: boolean;
  efforts: string[] | null;
} {
  const base = modelRoleModel(settings, role, boundProviderId, internal);
  const storedEffort = roleEffortFor(settings, role);
  return {
    ...base,
    effort: storedEffort ?? null,
    effortExplicit: storedEffort !== undefined,
    // `null` for a role with no model at all (an unset `runtimes.advisorModel`) — there is no row to
    // ask, which is the same answer `effortVocabularyFor` gives for a tag it cannot find.
    //
    // ALSO `null` for a role whose call path cannot carry an effort at all (`roleCarriesEffort` — as of
    // 2026-09-18 that is THREE roles, whatever model each names: `runtimes.advisorModel`, `pins.research`
    // — `WebFetch`'s digest, whose `WebFetchConfig` has no effort field — and `pins.researchFallback`,
    // whose consumer retired with the research runner): `null` is the "render no control" state,
    // and a control that stores a value nothing can ever spend is worse than no control. `effort`
    // above still reports a stale stored value verbatim, so a client can see it and clear it.
    efforts: base.model === null || !roleCarriesEffort(role) ? null : effortVocabularyFor(base.model),
  };
}

/** The MODEL half of `modelRoleInfo`, split out so the effort fields are added in exactly one place
 *  rather than repeated across nine `return`s (and so `setModelRole` can resolve "which model does this
 *  role sit on after my write" without also computing a vocabulary it is about to re-derive). Every
 *  rule and caveat in `modelRoleInfo`'s own doc comment above applies to this function — it is that
 *  function's body, not a second one. */
function modelRoleModel(settings: Settings | null | undefined, role: ModelRole, boundProviderId?: string, internal?: InternalProviderSnapshot): {
  model: ModelTag | null;
  explicit: boolean;
  constraint: ModelRoleConstraint;
  permitted: Array<{ providerId: string; displayName: string; models: ModelTag[] }>;
} {
  const constraint = modelRoleConstraint(role);
  // Fix wave (finding 4): the BOUND backend when known, never a pure settings re-derivation — see
  // this function's own doc comment for why the two can disagree.
  const effectiveProvider = boundProviderId ?? ownProviderFor(settings);
  // 2026-09-19 (the internal-jobs widening): an `"internal-provider"` role's picker offers EVERY
  // eligible provider — not the one currently bound, which is what left this user's Roles pane with
  // `permitted: []` and no picker at all, and not only the CREDENTIALED ones either: that is exactly
  // what the `"any"` roles do (`models.catalog` carries `credentialPresent` per provider beside this,
  // so a client greys a row rather than losing it), and it is what lets a user pin a role to a provider
  // they are about to add a key for. The pre-2026-09-19 single-provider answer is kept ONLY for a
  // caller that threads no snapshot, so every existing test reads unchanged.
  const permitted = constraint === "internal-provider"
    ? (internal !== undefined
        ? permittedProviders(internalEligibleProviderIds())
        : (INTERNAL_PROVIDER_IDS as readonly string[]).includes(effectiveProvider) ? permittedProviders(new Set([effectiveProvider])) : [])
    : permittedProviders();
  const primaryModel = (settings?.provider?.model ?? DEFAULT_PROVIDER.model) as ModelTag;

  switch (role) {
    case "pins.dispatch":
      return { model: pinsFor(settings).dispatch, explicit: settings?.pins?.dispatch !== undefined, constraint, permitted };
    // 2026-09-19: the internal roles report `internalRoleEffectiveTag` (explicit pin, else the
    // PREFERRED CREDENTIALED provider's default row) whenever a snapshot is threaded — the SAME rule
    // `providers/internal-router.ts` dispatches on, so the pane can never show a model the job would
    // not actually use. `null` is a NEW possibility for these four (nothing credentialed at all, so
    // there is no model to name); the schema already allows it — `runtimes.advisorModel` reports `null`
    // for an unset advisor — and the accompanying `problem` says why.
    case "pins.dream":
      return { model: internal !== undefined ? internalRoleEffectiveTag(settings, "pins.dream", internal) : pinsFor(settings).dream, explicit: settings?.pins?.dream !== undefined, constraint, permitted };
    case "pins.cleaner":
      return { model: internal !== undefined ? internalRoleEffectiveTag(settings, "pins.cleaner", internal) : pinsFor(settings).cleaner, explicit: settings?.pins?.cleaner !== undefined, constraint, permitted };
    case "pins.research":
      return { model: pinsFor(settings).research, explicit: settings?.pins?.research !== undefined, constraint, permitted };
    // RETIRED (2026-09-18, the web-tools ruling): its ONE consumer was the multi-page research runner,
    // which went with `ReadPage`. The role stays on the wire because the protocol's `ModelRole` enum is
    // a hand-mirrored literal with a parity test and a Swift picker behind it — narrowing it is an
    // RPC-schema change, not this lane's -- so it is marked retired with the fields the wire already
    // has: `permitted: []` (a picker with nothing to pick, the same shape an unbound internal provider
    // already produces) and, via `roleCarriesEffort`, `efforts: null`. `model` still reports its
    // resolved value so a client that stored one can SEE it and clear it; `setModelRole` refuses to set
    // a new one and says why.
    case "pins.researchFallback":
      return { model: pinsFor(settings).researchFallback, explicit: settings?.pins?.researchFallback !== undefined, constraint, permitted: [] };
    case "provider.model":
      // Always "explicit": `ProviderSettings.model` is a REQUIRED field, so every loaded `Settings`
      // always carries a real, currently-effective value — there is no "unset" state to distinguish.
      return { model: primaryModel, explicit: true, constraint, permitted };
    case "titles.model":
      return { model: internal !== undefined ? internalRoleEffectiveTag(settings, "titles.model", internal) : settings?.titles?.model ?? primaryModel, explicit: settings?.titles?.model !== undefined, constraint, permitted };
    case "reviewer.model":
      return { model: internal !== undefined ? internalRoleEffectiveTag(settings, "reviewer.model", internal) : settings?.reviewer?.model ?? primaryModel, explicit: settings?.reviewer?.model !== undefined, constraint, permitted };
    case "runtimes.advisorModel": {
      const raw = settings?.runtimes?.advisorModel?.trim();
      return { model: raw ? (raw as ModelTag) : null, explicit: Boolean(raw), constraint, permitted };
    }
  }
}

/** Every role at once — `settings.modelRoles`'s whole result, and what `settings.setModelRole`
 *  echoes back post-write so the app sees the FULL cascade (a `provider.model` write moves every
 *  `"internal-provider"`/`"any"` role's default) without a second round trip. `boundProviderId`
 *  (fix wave, finding 4): forwarded verbatim to every `modelRoleInfo` call — see that function's
 *  own doc comment. */
export function modelRolesFor(settings: Settings | null | undefined, boundProviderId?: string, internal?: InternalProviderSnapshot): Record<ModelRole, ReturnType<typeof modelRoleInfo>> {
  const out = {} as Record<ModelRole, ReturnType<typeof modelRoleInfo>>;
  for (const role of MODEL_ROLES) out[role] = modelRoleInfo(settings, role, boundProviderId, internal);
  return out;
}

/**
 * WS-20: the ONE write door for all nine model roles (`settings.setModelRole`) — mirrors
 * `setAdvisorModel`'s own validation exactly (a non-blank value must be a real provider-qualified
 * tag, and the `unstated/unstated` sentinel is refused even though `isModelTag` itself accepts it —
 * same "a caller explicitly selecting it here is never a real request" rule) and DELEGATES to
 * `setAdvisorModel` for the advisor role rather than duplicating its transform.
 *
 * `model` is now a THREE-way key, mirroring `effort`'s own established three-way meaning below
 * (2026-09-18, the "make model optional" fix): ABSENT leaves the role's stored model exactly as it
 * is (an effort-only write no longer has to re-send the current tag — see the ruling comment right
 * above `assertCatalogBackedTag`'s USER RULING for why re-sending used to be load-bearing and
 * dangerous: a defaulted role's client had to send `model: null` to change only the effort, which
 * SILENTLY UNPINS the role if another client pinned it in the gap between that client's last read
 * and this write landing); `null` clears an optional role's override, falling back to
 * `modelRoleInfo`'s own default rule; a tag sets it. `provider.model` still has no "unset" state at
 * all (`ProviderSettings.model` is a REQUIRED field) and THROWS on `null` rather than silently doing
 * nothing — the caller (the RPC handler) reports this the same way it reports an unresolvable tag,
 * `ERR.INVALID_PARAMS` — but now accepts `model` ABSENT (an effort-only `provider.reasoningEffort`
 * write) exactly like every other role.
 *
 * A call with BOTH `model` and `effort` absent is refused — there is nothing left for this door to
 * do, and silently returning the settings unchanged would read as success for a call that changed
 * nothing on purpose or by a caller bug either way; the ambiguity is refused rather than guessed at.
 */
/**
 * USER RULING 2026-09-18: a model role may only be set to a tag the PINNED CATALOG actually backs.
 * Before this, `setModelRole` checked the tag's SHAPE and nothing else, so
 * `settings.setModelRole("pins.dispatch", "openai/does-not-exist")` was written to settings.json and
 * failed much later — at the first dispatch spawn, as a refusal with no obvious connection to the
 * write that caused it. The Roles-pane picker was the only thing keeping unusable values out, which
 * makes every other caller of that RPC (a hand-made call, the TUI, a future client) a way in.
 *
 * The check is CATALOG MEMBERSHIP, deliberately not the role's own `permitted` set, because those
 * answer different questions and only the first is a write-time fact:
 *   - "does this model exist" — permanent, and what this refuses.
 *   - "can this role run it right now" — situational. `modelRoleConstraint`'s `"internal-provider"`
 *     roles narrow `permitted` to the CURRENTLY BOUND provider, so gating the write on `permitted`
 *     would refuse pinning a role to a provider the user is about to bind, and would strand a
 *     stored pin whose provider is temporarily unbound. Clients already receive `constraint` and
 *     `permitted` from `modelRoleInfo` and can grey a row out without the daemon refusing it.
 *
 * `winter-test/*` is exempt by construction, not by leniency: it is not a catalog provider at all
 * (`provider-selection.ts`'s `WINTER_TEST_MODEL_PREFIX` doc — "must never be resolved against one"),
 * and `setProviderModel`'s own comment records that `provider.model` has always accepted it.
 *
 * Clearing a role (`null`/empty, where the role allows it) is never checked — there is no tag to
 * verify, and a user must always be able to get back to a role's default.
 */
/** `setModelRole`'s internal-jobs gate — see its own call site for the accept/refuse split. Exempts
 *  `winter-test/*` for the same reason `assertCatalogBackedTag` does: it is not a catalog provider. */
function assertInternalJobRoleTag(tag: string, role: InternalJobRole): void {
  if (tag.startsWith(WINTER_TEST_PREFIX)) return;
  let providerId: string;
  try { providerId = splitTag(tag).providerId; } catch { return; } // shape is `assertCatalogBackedTag`'s job
  if (internalEligibleProviderIds().has(providerId)) {
    // M-3 (review): the PROVIDER being eligible is not enough — the ROW has to be one Winter's own
    // one-shot chat call can actually issue. Two checks, both permanent catalog facts (never the
    // situational credential question, which stays a `problem` rather than a refusal):
    //   - not `status: "blocked"` — the one status the registry itself refuses to resolve;
    //   - `scope: "llm"` on its provider AND a chat/responses/messages-capable endpoint, which is what
    //     "the provider is drivable" already guarantees via the adapter table — so this is really the
    //     row-level half: an embedding/image/`-Base` completion row on an otherwise-fine provider.
    const row = rowForTag(tag);
    if (row !== undefined && row.status === "blocked") {
      throw new TypeError(
        `${role}: ${JSON.stringify(tag)} is marked blocked in the pinned catalog — Winter will not issue its own ` +
          `background calls against a blocked model. Pick another from this role's \`permitted\` set.`,
      );
    }
    // The row must be reachable by the ONE request shape these jobs issue: a single chat/responses turn.
    // `WinterModelDescriptor.endpoints` is the per-row fact (`"chat" | "responses" | "embeddings" |
    // "image" | "audio" | "video"`) — the Anthropic-dialect providers declare `"chat"` too, so this is a
    // capability test rather than a dialect one. MEASURED 2026-09-19: all 571 rows on the 94 eligible
    // providers already declare chat or responses, so this refuses nothing today. It is a TRIPWIRE, and a
    // cheap one: the day the catalog adds an embeddings-only or image-only row to an otherwise-fine
    // provider, a pin on it would otherwise be accepted and then fail every background call.
    if (row !== undefined && !row.endpoints.includes("chat") && !row.endpoints.includes("responses")) {
      throw new TypeError(
        `${role}: ${JSON.stringify(tag)} serves only ${row.endpoints.join("/")} — Winter's own background jobs issue a ` +
          `single chat/responses turn, so this model cannot run one. Pick another from this role's \`permitted\` set.`,
      );
    }
    return;
  }
  const display = loadCatalog().providers.find((p) => p.id === providerId)?.displayName ?? providerId;
  const claude = (CLAUDE_FIRST_PARTY_PROVIDER_IDS as readonly string[]).includes(providerId);
  throw new TypeError(
    `${role}: Winter's own background jobs can't run on ${display}. ` +
      (claude
        ? `Claude models run through Anthropic's own runtime, which brings its own reviewer — so titles, the bash safety reviewer, the dreamer and the session cleaner never borrow an Anthropic credential. `
        : `Winter has no way to drive that provider for its own calls (its credential shape or its API family is not one the daemon can use). `) +
      `Pick a model from the providers \`settings.modelRoles\` reports as \`permitted\` for this role, or clear the pin (model: null) to use the default.`,
  );
}

function assertCatalogBackedTag(tag: string, role: ModelRole): void {
  if (tag.startsWith(WINTER_TEST_PREFIX)) return;
  if (rowForTag(tag) !== undefined) return;
  throw new TypeError(
    `${role}: no model in the pinned catalog has the tag ${JSON.stringify(tag)} — ` +
      `a role can only name a model this daemon can actually serve. The tags it will accept are the ` +
      `ones \`settings.modelRoles\` reports as \`permitted\` for this role (and \`models.catalog\` lists ` +
      `in full); a tag that merely LOOKS like \`provider/model\` is not enough.`,
  );
}

/**
 * 2026-09-18: `effort` — the role's reasoning effort, in the SAME write door as its model so a model
 * change and a matching effort land together (one `saveSettings`) or not at all.
 *
 * THREE states, and they are three different requests:
 *   - `undefined` (the argument absent) — the stored effort is left exactly as it is. NOTE that this
 *     includes a model change that leaves a stored effort the new model does not offer: the effort is
 *     not silently dropped, because the caller did not ask about it, and the post-write `roles` echo
 *     reports it verbatim beside the new model's `efforts` so a client can see and fix it. The read
 *     side never repairs it either — the consumer-side mapping for an effort a row does not list is
 *     `implicitEffortFor` (runtime-sdk/provider-selection.ts), at the point the effort is SPENT.
 *   - `null` — cleared: the role sends no effort and the provider's own default applies.
 *   - a string — set, validated against the model this call leaves the role on (see
 *     `assertRoleEffortSelectable`).
 */
export function setModelRole(settings: Settings, role: ModelRole, model?: string | null, effort?: string | null): Settings {
  if (model === undefined && effort === undefined) {
    throw new TypeError(`${role}: neither model nor effort was given — there is nothing to change (pass model to change the pin, effort to change the reasoning level, or both)`);
  }
  // RETIRED ROLE (2026-09-18): setting a model for it would store a value nothing reads. CLEARING it
  // (`null`) is deliberately still allowed — a user with a stored pin from before the retirement must
  // be able to get rid of it, exactly as `modelRoleInfo` still reports it so they can see it.
  if (role === "pins.researchFallback" && typeof model === "string" && model.trim() !== "") {
    throw new TypeError(
      `${role}: this role is retired — the multi-page research runner it fed was replaced by the ` +
        `runtime's own WebFetch (whose digest model is \`pins.research\`), so a model stored here would ` +
        `never be used. Pass model: null to clear a value stored before the retirement.`,
    );
  }
  // 2026-09-19 (the internal-jobs widening): an internal-jobs role may only name a provider Winter's
  // own background calls can actually be driven over. Refused on the PERMANENT facts only — a
  // first-party Claude provider (the user's own ruling: those run through the official leg, which has
  // its own reviewer) or an adapter family the daemon cannot drive — never on the situational one.
  // An ELIGIBLE provider with no key stored yet is ACCEPTED: that is precisely the case
  // `assertCatalogBackedTag`'s own doc says a write must not refuse ("a provider the user is about to
  // bind"), and the role reports `no-credential` on its `problem` until the key arrives.
  if (isInternalJobRole(role) && typeof model === "string" && model.trim() !== "") {
    assertInternalJobRoleTag(model.trim(), role);
  }
  const withModel = model === undefined ? settings : setModelRoleModel(settings, role, model);
  if (effort === undefined) return withModel;
  // Validated against the POST-WRITE model, never the one the role sat on when the call arrived: a
  // single call that moves a role to a new model and picks an effort for it must be checked as the
  // state it is creating, not the one it is leaving.
  if (effort !== null) assertRoleEffortSelectable(withModel, role, effort);
  return writeRoleEffort(withModel, role, effort);
}

/**
 * The effort half's own validator — `ipc/server.ts`'s `assertEffortSelectable` (the ONE rule
 * `session.setEffort` and `session.create` share), restated for a ROLE and kept word-for-word where
 * the two say the same thing.
 *
 * It cannot simply CALL that function, for two reasons that are both about this being a role and not a
 * session: its tier branch asks `clientEffortEligible(mode)` and a role has no mode (that question is
 * `roleAcceptsClientEffort`'s, and handing the session function `undefined` would read as "code" and
 * admit a tier everywhere), and it throws `RpcFailure` — an `ipc` type this module must not depend on.
 * The transform throws `TypeError`, which `settings.setModelRole`'s handler already reports as
 * `INVALID_PARAMS`, exactly like every other refusal from this door.
 *
 * The three model-facing rules are `assertEffortSelectable`'s, unchanged:
 *   - a real catalog row whose vocabulary is empty (`null` OR `[]` — 570 of 618 rows) refuses ANY
 *     effort, rather than letting one through to a child that will refuse it typed mid-turn;
 *   - a row WITH a vocabulary accepts that vocabulary plus `"none"` (the `effortsForModel` rule: the
 *     catalog omits `"none"` because it is Winter's unset, but the wire honours it once a model
 *     reasons at all). Computed inline rather than imported from `ipc/sync.ts` — that module imports
 *     this one, so the import would be a cycle; the ROW read underneath it is the shared
 *     `effortVocabularyFor`, so the two cannot disagree about the catalog itself.
 *   - a tag with NO catalog row (`winter-test/*`, a BYO endpoint's own id) passes through unchecked —
 *     `implicitEffortFor`'s own posture, and for its reasons: the harness doubles accept anything and
 *     an off-catalog endpoint offers this daemon no evidence either way, so refusing would be a guess
 *     dressed as a rule.
 */
function assertRoleEffortSelectable(settings: Settings, role: ModelRole, effort: string): void {
  if (isClientEffort(effort)) {
    if (!roleAcceptsClientEffort(role)) {
      throw new TypeError(
        `${role}: effort ${JSON.stringify(effort)} is a Winter-level tier, and no model role accepts one — ` +
          `a tier rewrites a session's system prompt, and no role's model is a code session's own (see ` +
          `\`roleAcceptsClientEffort\` for the per-role reason). Select a tier per session instead ` +
          `(\`session.setEffort\`); the efforts a role may store are: ${REASONING_EFFORTS.join(", ")}.`,
      );
    }
    // UNREACHABLE today (every arm of `roleAcceptsClientEffort` is `false`). A tier is deliberately
    // NOT then checked against the model's vocabulary — T5's ruling: the two branches are
    // ALTERNATIVES, not layers, because a tier never reaches the endpoint. If a role is ever made to
    // accept one, `roleEfforts`' value schema must widen in the SAME change or `saveSettings` will
    // refuse the write.
    return;
  }
  // A role with nowhere to SEND an effort refuses one outright (`roleCarriesEffort` — the advisor).
  // After the tier branch so a tier keeps its own, more specific message; before everything
  // model-specific because no model makes this role's effort spendable. Clearing (`null`) never
  // reaches this function, so a value stored before this refusal existed can always be removed.
  if (!roleCarriesEffort(role)) {
    throw new TypeError(
      `${role}: this role cannot run at a chosen reasoning effort — the advisor is configured through the ` +
        `agent SDK's \`advisor\` option, which carries a model (and its credential) and no effort, on ` +
        `either runtime leg. There is nothing for a stored effort to reach, so none is accepted; the ` +
        `advisor runs at its provider's own default.`,
    );
  }
  // The value must be STORABLE, checked before anything model-specific so a level the catalog might
  // one day declare but this daemon cannot persist (`roleEfforts` is `z.enum(REASONING_EFFORTS)`, like
  // its `provider.reasoningEffort` sibling) refuses typed HERE rather than throwing out of
  // `saveSettings`'s own validation pass two lines later.
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new TypeError(
      `${role}: effort ${JSON.stringify(effort)} is not a reasoning effort this daemon can store — ` +
        `supported: ${REASONING_EFFORTS.join(", ")}.`,
    );
  }
  const model = modelRoleModel(settings, role).model;
  if (model === null) {
    // Only `runtimes.advisorModel` can reach this: cleared, it has no model at all (see
    // `modelRoleConstraint`). Storing an effort for a model that does not exist yet would be an orphan
    // nothing validates and nothing spends — refuse rather than accept a write with no meaning.
    throw new TypeError(
      `${role}: this role currently names no model, so an effort cannot be validated or applied — ` +
        `set its model in the same call (or first), then the effort.`,
    );
  }
  if (rowForTag(model) === undefined) return;
  const vocabulary = effortVocabularyFor(model) ?? [];
  const allowed = vocabulary.length > 0 ? ["none", ...vocabulary] : [];
  if (allowed.length === 0) {
    throw new TypeError(
      `${role}: model '${model}' declares no reasoning-effort vocabulary — an effort cannot be set for ` +
        `it (leave it on the provider's default).`,
    );
  }
  if (!allowed.includes(effort)) {
    throw new TypeError(
      `${role}: effort '${effort}' is not accepted by model '${model}' — supported: ${allowed.join(", ")}.`,
    );
  }
}

/** The effort STORE — `roleEffortFor`'s write-side twin, and the only other place the
 *  `provider.model` → `provider.reasoningEffort` exception is spelled. `null` clears. Preserves every
 *  other entry in the block, and removes the block's last entry as an empty object rather than
 *  deleting the block (schema-valid either way; `saveSettings`'s merge treats them identically). */
function writeRoleEffort(settings: Settings, role: ModelRole, effort: string | null): Settings {
  if (role === "provider.model") {
    // `setReasoningEffort`'s own `undefined`-clears convention — the established door, reused rather
    // than re-implemented, so `winter model --effort` and a role write cannot diverge.
    return setReasoningEffort(settings, effort === null ? undefined : (effort as (typeof REASONING_EFFORTS)[number]));
  }
  const roleEfforts: Record<string, unknown> = { ...settings.roleEfforts };
  if (effort === null) delete roleEfforts[role]; else roleEfforts[role] = effort;
  return { ...settings, roleEfforts: roleEfforts as Settings["roleEfforts"] };
}

/** `setModelRole`'s MODEL half — see that function's own doc comment above (and the ruling comment
 *  above `assertCatalogBackedTag`) for every rule here; this is that function's original body, split
 *  out unchanged so the effort half can be applied after it in one transform. */
function setModelRoleModel(settings: Settings, role: ModelRole, model: string | null): Settings {
  if (role === "runtimes.advisorModel") {
    // Validated HERE rather than inside `setAdvisorModel`: that function is also the door for
    // `winter model --advisor` and the v2→v3 migration, and this ruling is about what a ROLE WRITE
    // through `settings.setModelRole` may contain — the same reason `provider.model`'s check sits
    // below instead of inside `setProviderModel`.
    const advisor = model?.trim();
    if (advisor) assertCatalogBackedTag(advisor, role);
    return setAdvisorModel(settings, model ?? undefined);
  }
  if (role === "provider.model") {
    if (model === null) throw new TypeError("provider.model: this role has no \"unset\" state (it is a required field) — pass a tag, never null");
    if (!isModelTag(model) || model === UNSTATED_TAG) throw new TypeError(`not a model tag: ${JSON.stringify(model)}`);
    assertCatalogBackedTag(model, role);
    return setProviderModel(settings, model as ModelTag);
  }
  const trimmed = model?.trim();
  if (trimmed && (!isModelTag(trimmed) || trimmed === UNSTATED_TAG)) throw new TypeError(`not a model tag: ${JSON.stringify(trimmed)}`);
  if (trimmed) assertCatalogBackedTag(trimmed, role);
  const value = trimmed ? (trimmed as ModelTag) : undefined;
  switch (role) {
    case "pins.dispatch": case "pins.dream": case "pins.cleaner": case "pins.research": case "pins.researchFallback": {
      const slot = role.slice("pins.".length) as "dispatch" | "dream" | "cleaner" | "research" | "researchFallback";
      const pins: Record<string, unknown> = { ...settings.pins };
      if (value === undefined) delete pins[slot]; else pins[slot] = value;
      return { ...settings, pins: pins as Settings["pins"] };
    }
    case "titles.model": {
      const titles: Record<string, unknown> = { ...settings.titles };
      if (value === undefined) delete titles.model; else titles.model = value;
      return { ...settings, titles: titles as Settings["titles"] };
    }
    case "reviewer.model": {
      const reviewer: Record<string, unknown> = { ...settings.reviewer };
      if (value === undefined) delete reviewer.model; else reviewer.model = value;
      return { ...settings, reviewer: reviewer as Settings["reviewer"] };
    }
    default:
      throw new TypeError(`unknown model role: ${JSON.stringify(role)}`);
  }
}

function expandTilde(p: string): string {
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
}

function readDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const dirs = raw?.permissions?.additionalDirectories;
    return Array.isArray(dirs) ? dirs.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Merge additionalDirectories across scopes (Claude-Code-style). BOTH the COMMITTED
 * <projectDir>/.winter/settings.json AND the gitignored settings.local.json are honored ONLY when
 * `projectTrusted` — a repo can't silently widen the fence until the user trusts the folder.
 * fix-wave A2: settings.local.json used to be honored unconditionally ("gitignored, always"), but
 * gitignore is advisory, not a trust boundary — a repo can `git add -f` one, so it needs the same
 * gate the committed file gets (matches CC). Only the user's OWN ~/.winter/sdk/settings.json is always
 * honored, trust-independent.
 */
export function loadPermissionDirs(homeDir: string, projectDir?: string, projectTrusted = false): string[] {
  // WS-21: the user tier is `sdk/settings.json` (claude `Settings`), where `additionalDirectories` moved;
  // a stale copy left in `<home>/settings.json` for a downgrade is never read.
  const sources = [sdkSettingsPath(homeDir)]; // user global — always
  if (projectDir && projectTrusted) {
    sources.push(join(projectDir, ".winter", "settings.json"));      // committed — trust-gated
    sources.push(join(projectDir, ".winter", "settings.local.json")); // local: a repo can force-commit one → also trust-gated (matches CC)
  }
  const merged: string[] = [];
  for (const src of sources) {
    for (const d of readDirs(src)) {
      const e = expandTilde(d);
      if (!merged.includes(e)) merged.push(e);
    }
  }
  return merged;
}

/** Persist a runtime-granted directory to the project's local (gitignored) settings. */
export function addLocalDir(projectDir: string, dir: string): void {
  const dotWinter = join(projectDir, ".winter");
  mkdirSync(dotWinter, { recursive: true });
  const path = join(dotWinter, "settings.local.json");
  let obj: any = {};
  if (existsSync(path)) {
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      obj = {};
    }
  }
  obj.permissions ??= {};
  obj.permissions.additionalDirectories ??= [];
  if (!obj.permissions.additionalDirectories.includes(dir)) obj.permissions.additionalDirectories.push(dir);
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  ensureGlobalGitignore(WINTER_PERSONAL_IGNORES);
}
