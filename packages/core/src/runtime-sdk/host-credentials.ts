// WS-25 §7 (prompt-free credentials): the DAEMON'S half of `credential_resolve` and `mcp_oauth_refresh`.
//
// WHY THIS EXISTS. macOS asks for consent whenever a process reads a Keychain item ANOTHER binary created.
// A code session's `winter` child reading the daemon's items (its provider slot, an advisor or digest pin,
// the Exa key, the Console bearer, an MCP sign-in) was exactly that — once per item per binary, and on a
// dev build once per REBUILD (`.superpowers/sdd/2026-09-27-keychain-prompts/progress.md`). With
// `Options.onCredentialResolve` set, the agent SDK puts `hostCredentials: true` on the wire and the child
// builds no Keychain store at all: every `{ kind: "keychain" }` read becomes a control request answered
// HERE, by `winter-core` — the binary that created the items, so its own reads never prompt. An embedded
// chat/dispatch Worker gets the same handler: it already ran in-process, but the daemon being the ONE
// refresher (spec §1.1) matters there too.
//
// THE RULES THIS FILE KEEPS (spec §7 A; the SDK contract in `CredentialResolveAnswer`'s doc):
//
//   ONLY WHAT THE SESSION WAS TOLD ABOUT. A session is answered only for the refs its OWN `Options` named
//   (`provider.authRef`, `advisor.authRef`, `web.search.authRef`, `web.fetch.authRef`), the catalog's
//   provider slots (`credentialInventory()` — what a cross-provider subagent resolves by itself, since an
//   agent definition may name any catalog model), and `mcp-oauth:<id>` for the http/sse servers in the
//   session's own MCP configuration. Everything else is `not_allowed`: the app's pairing tokens, the MCP
//   client registrations and client secrets (`mcp-oauth-client:*`, `mcp-oauth-client-secret:*`), a ref
//   naming a Keychain service other than this daemon's. (One exception in the ANSWER, not the rule: an
//   `mcp-oauth:<id>` outside the fold is answered `not_found` — see the resolver for why.)
//
//   NEVER A REFRESH TOKEN. Provider `oauth` material crosses with its refresh token removed; an MCP token
//   record crosses through `toSessionMcpTokenRecord` (the refresh token replaced by the SDK's non-secret
//   "host-held" marker, which is what tells the session a refresh is possible). The daemon posts every
//   refresh grant itself, single-flight per item — which is what keeps a ROTATING refresh token from
//   being replayed by two processes (RFC 9700 §4.14) and ends the dev partition-list poisoning a child's
//   own write-back caused.
//
//   A GENERATION PER ITEM, API KEYS INCLUDED. The SDK counts on `generation` rising with every write of
//   an item, so a child that got a 401 can ask for "newer than N" (`minGeneration`). A Keychain item has
//   no version of its own and is written by processes this one never hears from (the CLI's in-process
//   `winter login`, `ant`'s own profile refresh, a human with `security`), so the generation is DERIVED:
//   a digest of the last value this daemon handed out, per account, and a counter that moves whenever
//   the digest does. The digest is SHA-256 of the value — the value itself is never kept. An MCP token
//   record carries its own `generation` (the SDK's refresh and login write it), so that one is used as is.
//
//   THE MATERIAL STAYS IN THE FRAME. It is returned to the SDK's `query()`, which writes it into ONE
//   `control_response` over the child's stdio pipe (or the Worker's port). Nothing here logs it, puts it
//   in an error, or keeps it past the call. Log lines name the account and a reason code, never a value.
import { createHash } from "node:crypto";
import type { CredentialResolveAnswer, CredentialResolveRequest, McpOAuthRefreshAnswer, McpOAuthRefreshRequest, McpServerConfig, Options } from "@yanlinglabs/winter-agent-sdk";
import { McpOAuthError, mcpOAuthTokenAccount, refreshMcpOAuthToken, toSessionMcpTokenRecord, decodeMcpOAuthTokenRecord, MCP_OAUTH_CLIENT_ACCOUNT_PREFIX, MCP_OAUTH_TOKEN_ACCOUNT_PREFIX, type McpOAuthStore } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import type { SecretStore } from "../auth/secret-store";
import { TOKEN_NAMES } from "../auth/tokens";
import { WEB_SEARCH_API_KEY_SECRET } from "../agent/tools/web";
import { credentialInventory } from "./keychain";

/** An item within this much of its expiry is refreshed BEFORE it is handed out, when a refresher exists
 *  for it — the same 60 s window spec §1.2 names for an MCP token and `refreshOauthMaterial`'s callers use. */
export const HOST_REFRESH_SKEW_MS = 60_000;

/** After a renewal FAILS, how long the same item is not renewed again (review r1 (f)): a dead Console
 *  profile would otherwise spawn `ant` on every resolve a retrying child makes. */
export const HOST_RENEWAL_BACKOFF_MS = 30_000;

/** The client-secret prefix (`mcp-oauth-client-secret:<id>`) — it also starts with `mcp-oauth-client`,
 *  so the one prefix check below covers both daemon-only item families; spelled here for the doc. */
const MCP_CLIENT_ITEM_PREFIX = MCP_OAUTH_CLIENT_ACCOUNT_PREFIX.replace(/:$/, "");

/**
 * Accounts no session may ever be answered for, checked BEFORE the allowlist (belt and braces: none of
 * them can reach an allowlist today, and this keeps it so if a future builder widens one). The pairing
 * tokens and their migration shadows (`auth/keychain-acl.ts`), the MCP client registrations and client
 * secrets, and the retired Brave key.
 */
export function isNeverBrokered(account: string): boolean {
  if (account.startsWith(MCP_CLIENT_ITEM_PREFIX)) return true;
  const base = account.endsWith(".migrating") ? account.slice(0, -".migrating".length) : account;
  if ((Object.values(TOKEN_NAMES) as string[]).includes(base)) return true;
  return account === WEB_SEARCH_API_KEY_SECRET;
}

/** What one session may resolve (see this file's header). Built once per incarnation from the FINAL
 *  `Options` the incarnation is about to launch with. */
export interface SessionCredentialAllowlist {
  /** Provider/tool accounts: the refs `Options` named plus the catalog's provider slots. */
  readonly accounts: ReadonlySet<string>;
  /** `mcp-oauth:<id>` → the session's server NAMES configured at that URL (`mcp_oauth_refresh` names one). */
  readonly mcpAccounts: ReadonlyMap<string, ReadonlySet<string>>;
}

type KeychainRef = { kind: "keychain"; account: string; service?: string };

function keychainAccountOf(ref: unknown): string | undefined {
  if (typeof ref !== "object" || ref === null) return undefined;
  const r = ref as { kind?: unknown; account?: unknown };
  return r.kind === "keychain" && typeof r.account === "string" ? r.account : undefined;
}

/**
 * The allowlist for one incarnation. `mcpServers` is the session's CONFIGURED MCP set (user, local and a
 * trusted project's servers — `external-mcp.ts`'s fold), passed separately because on a run-home
 * incarnation the run folder carries those servers and `options.mcpServers` holds only the daemon's
 * capability servers. A server whose URL does not canonicalise (userinfo, a non-http scheme) contributes
 * nothing: the SDK refuses to key a sign-in for it either.
 */
export function sessionCredentialAllowlist(options: Options, mcpServers: Readonly<Record<string, McpServerConfig>>, slotProviders?: ReadonlySet<string>): SessionCredentialAllowlist {
  const accounts = new Set<string>();
  const named = [options.provider?.authRef, options.advisor?.authRef, options.web?.search?.authRef, options.web?.fetch?.authRef];
  for (const ref of named) {
    const account = keychainAccountOf(ref);
    if (account !== undefined) accounts.add(account);
  }
  // The catalog slots a cross-provider subagent may resolve — narrowed, when the caller knows it, to the
  // providers that are PERMITTED and CREDENTIALED at spawn (`slotProviders`, review r1 (h)): a slot with no
  // item could only answer `not_found`, and the narrower grant leaves nothing to probe. The trade-off: a
  // key added for ANOTHER provider mid-session reaches this session's subagents at its next incarnation.
  for (const slot of credentialInventory()) if (slotProviders === undefined || slotProviders.has(slot.provider)) accounts.add(slot.secretName);
  const mcpAccounts = new Map<string, Set<string>>();
  for (const [name, config] of Object.entries({ ...mcpServers, ...(options.mcpServers ?? {}) })) {
    const url = (config as { type?: unknown; url?: unknown }).url;
    const type = (config as { type?: unknown }).type;
    if ((type !== "http" && type !== "sse") || typeof url !== "string") continue;
    let account: string;
    try {
      account = mcpOAuthTokenAccount(url);
    } catch {
      continue;
    }
    const names = mcpAccounts.get(account) ?? new Set<string>();
    names.add(name);
    mcpAccounts.set(account, names);
  }
  for (const account of [...accounts]) if (isNeverBrokered(account)) accounts.delete(account);
  return { accounts, mcpAccounts };
}

/** A refresher for one provider account: posts the grant (or asks the broker) and persists the result.
 *  Throws or resolves; the caller re-reads the item either way. */
export type ProviderRefresher = (account: string) => Promise<void>;

export interface HostCredentialDeps {
  /** The daemon's own Keychain store — the one its items were created by. */
  secrets: SecretStore;
  /** `keychainService(undefined, home)`: the ONE service a session's refs may name (absent = the same). */
  keychainService: string;
  /** The daemon's ONE MCP OAuth store (`daemonMcpOAuthStore`). Absent (a test double, a harness without
   *  MCP sign-in): every `mcp-oauth:<id>` answers `not_found`, i.e. the server reads as signed out. */
  mcpOAuthStore?: McpOAuthStore;
  /** Per provider account, how to renew it (production: `codex-oauth:default` through the refresh-token
   *  grant, `anthropic:console` through the Console broker). An account with none is never refreshed:
   *  a `minGeneration` it cannot meet from what is stored answers `stale`. */
  refreshers?: Readonly<Record<string, ProviderRefresher>>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface HostCredentialBroker {
  /** `Options.onCredentialResolve` for one session. */
  resolverFor(allowlist: SessionCredentialAllowlist): NonNullable<Options["onCredentialResolve"]>;
  /** `Options.onMcpOAuthRefresh` for one session. */
  mcpRefresherFor(allowlist: SessionCredentialAllowlist): NonNullable<Options["onMcpOAuthRefresh"]>;
  /** The generation last handed out for `account` (tests, diagnostics); `undefined` before the first. */
  generationOf(account: string): number | undefined;
}

/** A stored expiry, as epoch MILLISECONDS. The Console profile's `expires_at` unit was never measured
 *  (`console-profile-broker.ts`'s `normalizeExpiresAtMs`); a seconds value is scaled, never mis-stated. */
function expiresAtMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

/**
 * The item's value as a session may see it. A provider slot holds JSON `CredentialMaterial`; an `oauth`
 * record loses its refresh token (and nothing else). Anything that is not such a record — the Exa key,
 * stored raw — is passed through verbatim for the child's own tool-secret reader to judge.
 */
function sessionView(raw: string): { material: string; expiresAt?: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { material: raw };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { material: raw };
  const record = parsed as Record<string, unknown>;
  const expiresAt = expiresAtMs(record.expiresAt);
  if (record.kind === "oauth" && "refreshToken" in record) {
    const { refreshToken: _held, ...rest } = record;
    return { material: JSON.stringify(rest), ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }
  return { material: raw, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** Can a renewal help this value at all? An `oauth` record without a refresh token cannot be renewed
 *  (only a new login helps), so asking its refresher would be a pointless round trip. Anything else —
 *  the Console bearer, whose broker renews from `ant`'s own profile — is left to its refresher. */
function renewable(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; refreshToken?: unknown };
    return parsed.kind !== "oauth" || (typeof parsed.refreshToken === "string" && parsed.refreshToken !== "");
  } catch {
    return true;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createHostCredentialBroker(deps: HostCredentialDeps): HostCredentialBroker {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  /** account → the digest of the value last read, and the generation that value carries. */
  const seen = new Map<string, { digest: string; generation: number }>();
  /** account → the refresh in flight (a second asker joins it; a failed one is never cached). */
  const refreshing = new Map<string, Promise<void>>();
  /** account → when its last renewal failed (`HOST_RENEWAL_BACKOFF_MS`). Cleared by a renewal that works. */
  const failedAt = new Map<string, number>();
  /** MCP sign-in accounts already logged as outside a session's fold (one line each, not one per connect). */
  const outsideFold = new Set<string>();

  /** One read of a provider/tool item, stamped with its derived generation. `null` = no item (a blank
   *  string is the pre-WS-19 "removed" spelling, `SecretStore.delete`'s own doc). */
  const read = async (account: string): Promise<{ raw: string; generation: number } | null> => {
    const raw = await deps.secrets.get(account);
    if (raw === null || raw === "") return null;
    const d = digest(raw);
    const prior = seen.get(account);
    const generation = prior === undefined ? 1 : prior.digest === d ? prior.generation : prior.generation + 1;
    seen.set(account, { digest: d, generation });
    return { raw, generation };
  };

  const refreshOnce = (account: string, refresher: ProviderRefresher): Promise<void> => {
    const running = refreshing.get(account);
    if (running !== undefined) return running;
    const run = refresher(account)
      .then(() => {
        failedAt.delete(account);
      })
      .catch((err: unknown) => {
        failedAt.set(account, now());
        // The class only — a refresh error may quote the grant it failed (refreshOauthMaterial never
        // does, a broker might), so no message ever reaches the log.
        log(`host credentials: refreshing ${account} failed (${err instanceof Error ? err.name : "error"})`);
      })
      .finally(() => {
        refreshing.delete(account);
      });
    refreshing.set(account, run);
    return run;
  };

  const resolveProvider = async (account: string, minGeneration: number | undefined, signal: AbortSignal): Promise<CredentialResolveAnswer> => {
    let current = await read(account);
    const refresher = deps.refreshers?.[account];
    const due = (c: { raw: string } | null): boolean => {
      if (c === null) return false;
      const expiresAt = sessionView(c.raw).expiresAt;
      return expiresAt !== undefined && expiresAt - now() <= HOST_REFRESH_SKEW_MS;
    };
    const short = (c: { generation: number } | null): boolean => minGeneration !== undefined && (c === null || c.generation < minGeneration);
    // A renewal is attempted when the asker needs newer material than is stored, or when what is stored
    // is about to expire and can be renewed. Never for a still-valid item at a plain read (spec §1.2's
    // "never refresh a still-valid token" rule, applied to provider credentials too).
    const backingOff = (failedAt.get(account) ?? -Infinity) + HOST_RENEWAL_BACKOFF_MS > now();
    if (refresher !== undefined && current !== null && !backingOff && renewable(current.raw) && (short(current) || due(current))) {
      await refreshOnce(account, refresher);
      if (signal.aborted) return { ok: false, reason: "unavailable" };
      current = await read(account);
    }
    if (current === null) return minGeneration === undefined ? { ok: false, reason: "not_found" } : { ok: false, reason: "stale" };
    if (short(current)) return { ok: false, reason: "stale" };
    const view = sessionView(current.raw);
    return { ok: true, material: view.material, generation: current.generation, ...(view.expiresAt !== undefined ? { expiresAt: view.expiresAt } : {}) };
  };

  const readMcp = async (store: McpOAuthStore, account: string): Promise<{ answer: CredentialResolveAnswer; generation?: number }> => {
    const raw = await store.read(account);
    if (raw === null) return { answer: { ok: false, reason: "not_found" } };
    let material: string;
    let generation: number;
    let expiresAt: number | undefined;
    try {
      material = toSessionMcpTokenRecord(raw);
      const record = decodeMcpOAuthTokenRecord(raw);
      generation = record.generation;
      expiresAt = record.expiresAt;
    } catch (err) {
      // A malformed record reads as "not signed in" (the SDK's own lenient read does the same); a NEWER
      // record version is not ours to interpret, and "sign in again" would overwrite what a newer Winter wrote.
      if (err instanceof McpOAuthError && err.code === "malformed_record") return { answer: { ok: false, reason: "not_found" } };
      log(`host credentials: ${account} could not be read (${err instanceof McpOAuthError ? err.code : "unreadable"})`);
      return { answer: { ok: false, reason: "unavailable" } };
    }
    return { answer: { ok: true, material, generation, ...(expiresAt !== undefined ? { expiresAt } : {}) }, generation };
  };

  const resolveMcp = async (account: string, minGeneration: number | undefined, signal: AbortSignal): Promise<CredentialResolveAnswer> => {
    const store = deps.mcpOAuthStore;
    if (store === undefined) return { ok: false, reason: "not_found" };
    const first = await readMcp(store, account);
    if (minGeneration === undefined || (first.generation !== undefined && first.generation >= minGeneration)) return first.answer;
    if (first.generation === undefined) return first.answer.ok === false && first.answer.reason === "unavailable" ? first.answer : { ok: false, reason: "stale" };
    const refreshed = await refreshMcpOAuthToken({ account, store, generation: first.generation });
    if (signal.aborted) return { ok: false, reason: "unavailable" };
    if (!refreshed.ok) return { ok: false, reason: refreshed.reason === "transient" ? "unavailable" : "stale" };
    const second = await readMcp(store, account);
    if (second.generation === undefined || second.generation < minGeneration) return second.answer.ok ? { ok: false, reason: "stale" } : second.answer;
    return second.answer;
  };

  return {
    resolverFor(allowlist) {
      return async (request: CredentialResolveRequest, { signal }: { signal: AbortSignal }): Promise<CredentialResolveAnswer> => {
        const account = request.ref.account;
        // The service a session names must be this daemon's own (absent = the same, the brand's). A ref
        // into another service is never read, whatever its account.
        if (request.ref.service !== undefined && request.ref.service !== deps.keychainService) return { ok: false, reason: "not_allowed" };
        if (isNeverBrokered(account)) return { ok: false, reason: "not_allowed" };
        try {
          if (account.startsWith(MCP_OAUTH_TOKEN_ACCOUNT_PREFIX)) {
            // `not_found`, deliberately NOT `not_allowed`, for a sign-in outside this session's fold. The
            // SDK's session provider reads the token item at EVERY http/sse connect, signed in or not, and
            // lets any answer but `not_found` propagate as a connect failure (`mcp-auth/session-provider.ts`
            // `read` → `readTokenRecordLenient`, reached from `preflight`). Servers the fold cannot see —
            // a plugin's own `.mcp.json` servers, which ride the run folder's `enabledPlugins`, and a
            // server a subagent declares — would then fail to connect at all instead of connecting
            // unauthenticated. `not_found` crosses no material either way and reads as "not signed in",
            // exactly what an empty Keychain says. Logged once per account, so a plugin server a user DID
            // sign in to is diagnosable.
            if (!allowlist.mcpAccounts.has(account)) {
              if (!outsideFold.has(account)) {
                outsideFold.add(account);
                log(`host credentials: ${account} is not one of this session's configured MCP servers — answered as not signed in`);
              }
              return { ok: false, reason: "not_found" };
            }
            return await resolveMcp(account, request.minGeneration, signal);
          }
          if (!allowlist.accounts.has(account)) return { ok: false, reason: "not_allowed" };
          return await resolveProvider(account, request.minGeneration, signal);
        } catch (err) {
          log(`host credentials: resolving ${account} failed (${err instanceof Error ? err.name : "error"})`);
          return { ok: false, reason: "unavailable" };
        }
      };
    },
    mcpRefresherFor(allowlist) {
      return async (request: McpOAuthRefreshRequest): Promise<McpOAuthRefreshAnswer> => {
        // The account must be one this session's configuration implies, AND the server the session
        // names must be configured at that URL: a session cannot drive a refresh of another server's
        // sign-in by naming its account.
        const names = allowlist.mcpAccounts.get(request.account);
        if (names === undefined || !names.has(request.server)) return { ok: false, reason: "needs_auth" };
        const store = deps.mcpOAuthStore;
        if (store === undefined) return { ok: false, reason: "needs_auth" };
        try {
          const result = await refreshMcpOAuthToken({
            account: request.account,
            store,
            generation: request.generation,
            ...(request.stepUpScope !== undefined ? { stepUpScope: request.stepUpScope } : {}),
          });
          return result.ok ? { ok: true } : { ok: false, reason: result.reason };
        } catch (err) {
          log(`host credentials: refreshing ${request.account} failed (${err instanceof McpOAuthError ? err.code : err instanceof Error ? err.name : "error"})`);
          return { ok: false, reason: "transient" };
        }
      };
    },
    generationOf(account) {
      return seen.get(account)?.generation;
    },
  };
}
