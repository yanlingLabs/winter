// WS-25 §7 (prompt-free credentials): the daemon's `credential_resolve` / `mcp_oauth_refresh` answers.
//
// Hermetic: a `FileSecretStore` under a temp dir and the SDK's memory MCP store. No Keychain, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryMcpOAuthStore, encodeMcpOAuthTokenRecord, MCP_OAUTH_HOST_HELD_REFRESH_TOKEN, mcpOAuthClientAccount, mcpOAuthClientSecretAccount, mcpOAuthTokenAccount } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { FileSecretStore, type SecretStore } from "../../src/auth/secret-store";
import { createHostCredentialBroker, isNeverBrokered, sessionCredentialAllowlist, type HostCredentialDeps } from "../../src/runtime-sdk/host-credentials";

const SERVICE = "ws25.host-credentials.test";
const SECRET = "WS25-HOST-SENTINEL-8f1c";
const MCP_URL = "https://mcp.example.test/mcp";
const MCP_ACCOUNT = mcpOAuthTokenAccount(MCP_URL);
const signal = new AbortController().signal;

let dir: string;
let secrets: FileSecretStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws25-hostcred-"));
  secrets = new FileSecretStore(join(dir, "secrets"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A session whose Options named deepseek (provider), openai (advisor), exa (search), and one MCP server. */
function sessionOptions(): Options {
  return {
    provider: { providerId: "deepseek", authRef: { kind: "keychain", account: "deepseek:default", service: SERVICE } },
    advisor: { model: "openai/gpt-6-astra", authRef: { kind: "keychain", account: "openai:default", service: SERVICE } },
    web: { search: { authRef: { kind: "keychain", account: "exa-api-key", service: SERVICE } }, fetch: { privateAddressPolicy: "ask" }, blockedDomains: [] },
    mcpServers: { winter__browser: { type: "sdk", name: "winter__browser" } as never },
  } as unknown as Options;
}

function broker(extra: Partial<HostCredentialDeps> = {}, store: SecretStore = secrets) {
  const logs: string[] = [];
  const b = createHostCredentialBroker({ secrets: store, keychainService: SERVICE, log: (l) => logs.push(l), ...extra });
  const allow = sessionCredentialAllowlist(sessionOptions(), { linear: { type: "http", url: MCP_URL }, local: { type: "stdio", command: "x" } });
  return { b, allow, logs, resolve: b.resolverFor(allow), refreshMcp: b.mcpRefresherFor(allow) };
}

describe("the allowlist", () => {
  test("names exactly the Options' refs, the catalog provider slots and the configured http/sse MCP sign-ins", () => {
    const allow = sessionCredentialAllowlist(sessionOptions(), { linear: { type: "http", url: `${MCP_URL}/` }, events: { type: "sse", url: "https://events.example.test/sse" }, local: { type: "stdio", command: "x" }, bad: { type: "http", url: "https://user:pw@x.example.test/" } });
    for (const account of ["deepseek:default", "openai:default", "exa-api-key", "codex-oauth:default", "anthropic:console", "anthropic:default"]) expect(allow.accounts.has(account)).toBe(true);
    // Never a pairing token, an MCP client item or a tool key the Options did not name.
    for (const account of ["harness-token", "remote-token", "admin-token", "web-search-api-key", mcpOAuthClientAccount(MCP_URL), mcpOAuthClientSecretAccount(MCP_URL)]) expect(allow.accounts.has(account)).toBe(false);
    // The trailing slash canonicalises onto the same sign-in; userinfo keys nothing; stdio has no sign-in.
    expect([...allow.mcpAccounts.keys()].sort()).toEqual([MCP_ACCOUNT, mcpOAuthTokenAccount("https://events.example.test/sse")].sort());
    expect([...allow.mcpAccounts.get(MCP_ACCOUNT)!]).toEqual(["linear"]);
  });

  test("an Options object without an Exa ref leaves the Exa key out", () => {
    const opts = sessionOptions();
    (opts as { web: { search?: unknown } }).web.search = undefined;
    expect(sessionCredentialAllowlist(opts, {}).accounts.has("exa-api-key")).toBe(false);
  });

  test("isNeverBrokered: pairing tokens, their migration shadows, MCP client items, the retired Brave key", () => {
    for (const a of ["harness-token", "remote-token.migrating", "admin-token", "mcp-oauth-client:abc", "mcp-oauth-client-secret:abc", "web-search-api-key"]) expect(isNeverBrokered(a)).toBe(true);
    for (const a of ["deepseek:default", "mcp-oauth:abc", "exa-api-key"]) expect(isNeverBrokered(a)).toBe(false);
  });
});

describe("credential_resolve", () => {
  test("refuses what the session was not told about — typed, and before any read", async () => {
    let reads = 0;
    const counting: SecretStore = { get: async (n) => { reads++; return secrets.get(n); }, set: (n, v) => secrets.set(n, v), delete: (n) => secrets.delete(n) };
    await secrets.set("harness-token", SECRET);
    const { resolve } = broker({}, counting);
    for (const account of ["harness-token", "remote-token.migrating", "zai:default-not-a-slot", "exa-api-key-typo", mcpOAuthClientAccount(MCP_URL), mcpOAuthClientSecretAccount(MCP_URL), mcpOAuthTokenAccount("https://other.example.test/mcp")]) {
      expect(await resolve({ ref: { kind: "keychain", account } }, { signal })).toEqual({ ok: false, reason: "not_allowed" });
    }
    // An allowed account under ANOTHER Keychain service is not read either.
    expect(await resolve({ ref: { kind: "keychain", account: "deepseek:default", service: "com.winter.core" } }, { signal })).toEqual({ ok: false, reason: "not_allowed" });
    expect(reads).toBe(0);
  });

  test("an API key: the stored JSON verbatim, generation 1, stable until the item changes; absent is not_found", async () => {
    const { resolve, b } = broker();
    expect(await resolve({ ref: { kind: "keychain", account: "deepseek:default", service: SERVICE } }, { signal })).toEqual({ ok: false, reason: "not_found" });
    await secrets.set("deepseek:default", JSON.stringify({ kind: "api-key", key: SECRET }));
    const first = await resolve({ ref: { kind: "keychain", account: "deepseek:default", service: SERVICE } }, { signal });
    expect(first).toEqual({ ok: true, material: JSON.stringify({ kind: "api-key", key: SECRET }), generation: 1 });
    // The service may be absent (the brand's own) and the answer is the same.
    expect(await resolve({ ref: { kind: "keychain", account: "deepseek:default" } }, { signal })).toMatchObject({ ok: true, generation: 1 });
    // A write elsewhere (another process, a rotation) moves the generation at the next read.
    await secrets.set("deepseek:default", JSON.stringify({ kind: "api-key", key: `${SECRET}-2` }));
    expect(await resolve({ ref: { kind: "keychain", account: "deepseek:default" } }, { signal })).toMatchObject({ ok: true, generation: 2 });
    expect(b.generationOf("deepseek:default")).toBe(2);
    // A blank item is the pre-WS-19 "removed" spelling.
    await secrets.set("deepseek:default", "");
    expect(await resolve({ ref: { kind: "keychain", account: "deepseek:default" } }, { signal })).toEqual({ ok: false, reason: "not_found" });
  });

  test("minGeneration an unversioned key cannot meet is stale; a rotation meets it without any refresher", async () => {
    const { resolve } = broker();
    await secrets.set("deepseek:default", JSON.stringify({ kind: "api-key", key: SECRET }));
    expect(await resolve({ ref: { kind: "keychain", account: "deepseek:default" } }, { signal })).toMatchObject({ generation: 1 });
    expect(await resolve({ ref: { kind: "keychain", account: "deepseek:default" }, minGeneration: 2 }, { signal })).toEqual({ ok: false, reason: "stale" });
    await secrets.set("deepseek:default", JSON.stringify({ kind: "api-key", key: `${SECRET}-rotated` }));
    expect(await resolve({ ref: { kind: "keychain", account: "deepseek:default" }, minGeneration: 2 }, { signal })).toMatchObject({ ok: true, generation: 2 });
  });

  test("the Exa key (stored raw) crosses verbatim", async () => {
    await secrets.set("exa-api-key", SECRET);
    const { resolve } = broker();
    expect(await resolve({ ref: { kind: "keychain", account: "exa-api-key", service: SERVICE } }, { signal })).toEqual({ ok: true, material: SECRET, generation: 1 });
  });

  test("OAuth material never carries its refresh token; expiresAt is epoch ms", async () => {
    const expiresAt = Date.now() + 3_600_000;
    await secrets.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: "at-1", refreshToken: SECRET, expiresAt, accountId: "acct" }));
    const { resolve } = broker();
    const answer = await resolve({ ref: { kind: "keychain", account: "codex-oauth:default" } }, { signal });
    expect(answer).toEqual({ ok: true, material: JSON.stringify({ kind: "oauth", accessToken: "at-1", expiresAt, accountId: "acct" }), generation: 1, expiresAt });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    // A seconds-unit bearer expiry is scaled, never mis-stated.
    await secrets.set("anthropic:console", JSON.stringify({ kind: "bearer", token: "b", expiresAt: 4_000_000_000 }));
    expect(await resolve({ ref: { kind: "keychain", account: "anthropic:console" } }, { signal })).toMatchObject({ expiresAt: 4_000_000_000_000 });
  });

  test("a renewable item: renewed ONCE for concurrent askers that need newer material, never while still valid", async () => {
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const refresh = async (account: string): Promise<void> => {
      posts++;
      await gate;
      await secrets.set(account, JSON.stringify({ kind: "oauth", accessToken: `at-${posts + 1}`, refreshToken: "rt-2", expiresAt: Date.now() + 3_600_000 }));
    };
    await secrets.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 }));
    const { resolve } = broker({ refreshers: { "codex-oauth:default": refresh } });
    // Still valid: a plain read never refreshes.
    expect(await resolve({ ref: { kind: "keychain", account: "codex-oauth:default" } }, { signal })).toMatchObject({ ok: true, generation: 1 });
    expect(posts).toBe(0);
    // Two sessions got a 401 on generation 1: one grant, both answered with generation 2.
    const a = resolve({ ref: { kind: "keychain", account: "codex-oauth:default" }, minGeneration: 2 }, { signal });
    const c = resolve({ ref: { kind: "keychain", account: "codex-oauth:default" }, minGeneration: 2 }, { signal });
    await Bun.sleep(5);
    release();
    const [ra, rc] = await Promise.all([a, c]);
    expect(posts).toBe(1);
    expect(ra).toMatchObject({ ok: true, generation: 2 });
    expect(rc).toMatchObject({ ok: true, generation: 2 });
    expect(JSON.parse((ra as { material: string }).material)).toEqual(expect.not.objectContaining({ refreshToken: expect.anything() }));
  });

  test("an item about to expire is renewed before it is handed out; one without a refresh token is not", async () => {
    let posts = 0;
    const refresh = async (account: string): Promise<void> => {
      posts++;
      await secrets.set(account, JSON.stringify({ kind: "oauth", accessToken: "fresh", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 }));
    };
    const { resolve } = broker({ refreshers: { "codex-oauth:default": refresh } });
    await secrets.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: "stale-at", expiresAt: Date.now() + 10_000 }));
    expect(await resolve({ ref: { kind: "keychain", account: "codex-oauth:default" } }, { signal })).toMatchObject({ ok: true, generation: 1 });
    expect(posts).toBe(0);
    await secrets.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: "stale-at", refreshToken: "rt", expiresAt: Date.now() + 10_000 }));
    const answer = await resolve({ ref: { kind: "keychain", account: "codex-oauth:default" } }, { signal });
    expect(posts).toBe(1);
    expect(JSON.parse((answer as { material: string }).material).accessToken).toBe("fresh");
  });

  test("a failed renewal is stale, logged by account and class only — never a value", async () => {
    const refresh = async (): Promise<void> => { throw new Error(`the grant ${SECRET} was rejected`); };
    await secrets.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: SECRET, refreshToken: SECRET, expiresAt: Date.now() + 3_600_000 }));
    const { resolve, logs } = broker({ refreshers: { "codex-oauth:default": refresh } });
    await resolve({ ref: { kind: "keychain", account: "codex-oauth:default" } }, { signal });
    expect(await resolve({ ref: { kind: "keychain", account: "codex-oauth:default" }, minGeneration: 2 }, { signal })).toEqual({ ok: false, reason: "stale" });
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(SECRET);
  });

  test("a store that throws answers unavailable, and its message (which may quote material) is never logged", async () => {
    const throwing: SecretStore = { get: async () => { throw new Error(`boom ${SECRET}`); }, set: async () => {}, delete: async () => false };
    const { resolve, logs } = broker({}, throwing);
    const answer = await resolve({ ref: { kind: "keychain", account: "deepseek:default" } }, { signal });
    expect(answer).toEqual({ ok: false, reason: "unavailable" });
    expect(logs.join("\n")).not.toContain(SECRET);
  });
});

describe("MCP sign-ins", () => {
  const record = (over: Record<string, unknown> = {}) => encodeMcpOAuthTokenRecord({ v: 1, kind: "mcp-oauth", serverUrl: MCP_URL, issuer: "https://as.example.test", accessToken: "mcp-at", refreshToken: SECRET, expiresAt: Date.now() + 3_600_000, generation: 7, ...over } as never);

  test("credential_resolve answers the session's own server with the refresh token masked, at the record's generation", async () => {
    const store = createMemoryMcpOAuthStore({ [MCP_ACCOUNT]: record() });
    const { resolve } = broker({ mcpOAuthStore: store });
    const answer = await resolve({ ref: { kind: "keychain", account: MCP_ACCOUNT } }, { signal });
    expect(answer).toMatchObject({ ok: true, generation: 7 });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(JSON.parse((answer as { material: string }).material).refreshToken).toBe(MCP_OAUTH_HOST_HELD_REFRESH_TOKEN);
  });

  test("no store, no item, or a malformed item reads as signed out; the client items are never answerable", async () => {
    expect(await broker().resolve({ ref: { kind: "keychain", account: MCP_ACCOUNT } }, { signal })).toEqual({ ok: false, reason: "not_found" });
    const store = createMemoryMcpOAuthStore({ [mcpOAuthClientAccount(MCP_URL)]: "{}", [mcpOAuthClientSecretAccount(MCP_URL)]: SECRET });
    const { resolve } = broker({ mcpOAuthStore: store });
    expect(await resolve({ ref: { kind: "keychain", account: MCP_ACCOUNT } }, { signal })).toEqual({ ok: false, reason: "not_found" });
    store.entries.set(MCP_ACCOUNT, "{not json");
    expect(await resolve({ ref: { kind: "keychain", account: MCP_ACCOUNT } }, { signal })).toEqual({ ok: false, reason: "not_found" });
    expect(await resolve({ ref: { kind: "keychain", account: mcpOAuthClientAccount(MCP_URL) } }, { signal })).toEqual({ ok: false, reason: "not_allowed" });
    expect(await resolve({ ref: { kind: "keychain", account: mcpOAuthClientSecretAccount(MCP_URL) } }, { signal })).toEqual({ ok: false, reason: "not_allowed" });
  });

  test("minGeneration past a sign-in that cannot refresh (no refresh token) is stale", async () => {
    const store = createMemoryMcpOAuthStore({ [MCP_ACCOUNT]: record({ refreshToken: undefined }) });
    const { resolve } = broker({ mcpOAuthStore: store });
    expect(await resolve({ ref: { kind: "keychain", account: MCP_ACCOUNT }, minGeneration: 8 }, { signal })).toEqual({ ok: false, reason: "stale" });
  });

  test("mcp_oauth_refresh: only for this session's server at that URL; the SDK's refresh decides the rest", async () => {
    const store = createMemoryMcpOAuthStore({ [MCP_ACCOUNT]: record({ refreshToken: undefined }) });
    const { refreshMcp } = broker({ mcpOAuthStore: store });
    // Another session's server, or a name that is not configured at that URL: needs_auth, nothing read.
    expect(await refreshMcp({ server: "linear", account: mcpOAuthTokenAccount("https://other.example.test/mcp"), generation: 7 }, { signal })).toEqual({ ok: false, reason: "needs_auth" });
    expect(await refreshMcp({ server: "someone-else", account: MCP_ACCOUNT, generation: 7 }, { signal })).toEqual({ ok: false, reason: "needs_auth" });
    // A sign-in with no refresh token cannot be refreshed (spec §1.2).
    expect(await refreshMcp({ server: "linear", account: MCP_ACCOUNT, generation: 7 }, { signal })).toEqual({ ok: false, reason: "needs_auth" });
    // Another caller already moved the record past the asker's generation: answered without posting.
    store.entries.set(MCP_ACCOUNT, record({ generation: 9 }));
    expect(await refreshMcp({ server: "linear", account: MCP_ACCOUNT, generation: 7 }, { signal })).toEqual({ ok: true });
  });
});
