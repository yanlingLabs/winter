import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERR, LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, CredentialListResult, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import { WEB_SEARCH_API_KEY_SECRET } from "../../src/agent/tools/web";
import { CODEX_SECRET_NAMES, readCredentialMaterial, writeCredentialMaterial } from "../../src/auth/credential-material";
import { ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";

// WS-19 (W19-3/4/5, W19-10) — the three credential RPCs over the REAL socket, in BOTH roles.
//
// Isolation: a mkdtemp home and a disk-backed `FileSecretStore` under it. Nothing here resolves
// `com.winter.core*` or touches the Keychain — `FileSecretStore` is files in a temp dir, and the
// values written are `WS19-SENTINEL-…` dummies, never a real key shape.
//
// The security obligation these tests carry is NEGATIVE and load-bearing: a `credential.list` reply
// and every `credential.set`/`remove` result and ERROR is asserted not to contain the sentinel. The
// end-to-end version of that sweep (daemon log, session JSONL, history, remote stream) is
// `test/e2e/credentials-routing-e2e.test.ts` (W19-14); this file pins the RPC boundary itself.

const SENTINEL = "WS19-SENTINEL-rpc-9f2c41";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("credential.list / credential.set / credential.remove (WS-19)", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  async function boot(): Promise<{ home: string; socketPath: string; harnessToken: string; remoteToken: string; secrets: FileSecretStore }> {
    const home = mkdtempSync(join(tmpdir(), "ws19-cred-rpc-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "auth-secrets")));
    const tokens = await authority.ensureTokens();
    const secrets = new FileSecretStore(join(home, "secrets"));
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, secrets, winterHome: home });
    cleanup = () => { server.stop(); store.close(); rmSync(home, { recursive: true, force: true }); };
    return { home, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote, secrets };
  }

  function rowFor(rows: any[], providerId: string, door = "credential.set"): any {
    return rows.find((r) => r.providerId === providerId && r.door === door);
  }

  test("list: the reply validates against the protocol schema and carries names + booleans only", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");

    const res = await c.request(METHODS.credentialList, {});
    expect(res.error).toBeUndefined();
    // §9 A-4: a reply ALWAYS carries `providers`; a client treats its absence as an error, so the
    // schema parse here is the daemon-side half of that contract.
    const parsed = CredentialListResult.safeParse(res.result);
    expect(parsed.success).toBe(true);
    const rows: any[] = res.result.providers;
    // The derived inventory (W19-1) + the two tool rows (§9 A-2).
    expect(rows.length).toBeGreaterThan(100);
    expect(rowFor(rows, "deepseek")).toMatchObject({ manageable: true, present: false, kind: "api-key", risk: "review-required", group: "provider" });
    expect(rowFor(rows, "openai")).toMatchObject({ manageable: true, present: false, kind: "api-key", risk: "approved" });
    expect(rowFor(rows, "exa")).toMatchObject({ group: "tool", manageable: true, kind: "api-key", risk: "approved", displayName: "Exa" });
    expect(rowFor(rows, "web-search")).toMatchObject({ group: "tool", displayName: "Web search" });
    c.close();
  });

  test("§9 A-1: anthropic appears TWICE — the api-key slot and the Console slot, each with its own door and kind", async () => {
    const { socketPath, harnessToken, secrets } = await boot();
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: SENTINEL });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");

    const rows: any[] = (await c.request(METHODS.credentialList, {})).result.providers;
    const anthropic = rows.filter((r) => r.providerId === "anthropic");
    expect(anthropic).toHaveLength(2);
    expect(anthropic[0]).toMatchObject({ door: "credential.set", kind: "api-key", manageable: true, present: true });
    expect(anthropic[1]).toMatchObject({ door: "provider.login", kind: "bearer", manageable: false, present: false });
    // The three identity fields a client keys a row by are UNIQUE across the whole reply — a
    // duplicate would make two different slots indistinguishable in the app and on the phone.
    const keys = rows.map((r) => `${r.providerId}|${r.door}|${r.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    c.close();
  });

  test("§9 A-1: the Console slot's `present` is the BEARER, never an api-key sitting in that account", async () => {
    const { socketPath, harnessToken, secrets } = await boot();
    // The wrong kind in the console account — exactly what `keychainSeamFromSecretStore` refuses to
    // serve. `present` must agree with the seam, or the app would offer to use a credential that
    // can never be read.
    await writeCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: SENTINEL });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");
    let rows: any[] = (await c.request(METHODS.credentialList, {})).result.providers;
    expect(rowFor(rows, "anthropic", "provider.login").present).toBe(false);

    await writeCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, { kind: "bearer", token: SENTINEL });
    rows = (await c.request(METHODS.credentialList, {})).result.providers;
    expect(rowFor(rows, "anthropic", "provider.login").present).toBe(true);
    c.close();
  });

  test("set -> list -> remove -> list round-trips on a derived provider, with no restart between calls (W19-8, B-1/B-3)", async () => {
    const { socketPath, harnessToken, secrets } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");

    const set = await c.request(METHODS.credentialSet, { providerId: "deepseek", apiKey: SENTINEL });
    expect(set.error).toBeUndefined();
    expect(set.result).toEqual({ ok: true });

    // SAME live server, no restart: the very next call already sees it.
    let rows: any[] = (await c.request(METHODS.credentialList, {})).result.providers;
    expect(rowFor(rows, "deepseek")).toMatchObject({ present: true, kind: "api-key" });
    // Stored as the JSON material record the spawned child actually parses — not a raw string.
    expect(await readCredentialMaterial(secrets, "deepseek:default")).toEqual({ kind: "api-key", key: SENTINEL });

    const removed = await c.request(METHODS.credentialRemove, { providerId: "deepseek" });
    expect(removed.result).toEqual({ ok: true, removed: true });
    rows = (await c.request(METHODS.credentialList, {})).result.providers;
    expect(rowFor(rows, "deepseek").present).toBe(false);

    // Removing again is a successful no-op, not a failure.
    expect((await c.request(METHODS.credentialRemove, { providerId: "deepseek" })).result).toEqual({ ok: true, removed: false });
    c.close();
  });

  test("the tool rows write their RAW long-standing secret names, not `<id>:default` material (§9 A-2)", async () => {
    const { socketPath, harnessToken, secrets } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");

    await c.request(METHODS.credentialSet, { providerId: "exa", apiKey: SENTINEL });
    await c.request(METHODS.credentialSet, { providerId: "web-search", apiKey: `${SENTINEL}-ws` });
    // Raw, verbatim — `sync.config.exaKey` and the tools themselves read these unchanged.
    expect(await secrets.get(EXA_API_KEY_SECRET)).toBe(SENTINEL);
    expect(await secrets.get(WEB_SEARCH_API_KEY_SECRET)).toBe(`${SENTINEL}-ws`);
    expect(await secrets.get("exa:default")).toBeNull();

    const rows: any[] = (await c.request(METHODS.credentialList, {})).result.providers;
    expect(rowFor(rows, "exa").present).toBe(true);
    expect((await c.request(METHODS.credentialRemove, { providerId: "exa" })).result).toEqual({ ok: true, removed: true });
    expect(await secrets.get(EXA_API_KEY_SECRET)).toBeNull();
    c.close();
  });

  test("§9 A-3: codex-oauth cannot be SET (typed, with its door) but CAN be removed — and removing clears every Codex name", async () => {
    const { socketPath, harnessToken, secrets } = await boot();
    await writeCredentialMaterial(secrets, "codex-oauth:default", { kind: "oauth", accessToken: SENTINEL });
    await secrets.set(CODEX_SECRET_NAMES.access, SENTINEL);
    await secrets.set(CODEX_SECRET_NAMES.refresh, `${SENTINEL}-r`);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");

    const refused = await c.request(METHODS.credentialSet, { providerId: "codex-oauth", apiKey: SENTINEL });
    expect(refused.result).toBeUndefined();
    expect(refused.error.code).toBe(ERR.INVALID_PARAMS);
    expect(refused.error.data).toEqual({ code: "credential_kind_unsupported", door: "cli-oauth" });
    expect(JSON.stringify(refused)).not.toContain(SENTINEL);

    const rows: any[] = (await c.request(METHODS.credentialList, {})).result.providers;
    expect(rowFor(rows, "codex-oauth", "cli-oauth")).toMatchObject({ manageable: false, kind: "oauth", present: true });

    expect((await c.request(METHODS.credentialRemove, { providerId: "codex-oauth" })).result).toEqual({ ok: true, removed: true });
    expect(await secrets.get("codex-oauth:default")).toBeNull();
    // The five legacy raw records too — a pre-material install would otherwise stay signed in
    // through `CodexAuthStore.load()`'s read-only fallback.
    for (const name of Object.values(CODEX_SECRET_NAMES)) expect(await secrets.get(name)).toBeNull();
    c.close();
  });

  test("set/remove on `anthropic` touch the api-key slot ONLY — the Console bearer is untouched (§9 A-1)", async () => {
    const { socketPath, harnessToken, secrets } = await boot();
    await writeCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, { kind: "bearer", token: `${SENTINEL}-console` });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");

    await c.request(METHODS.credentialSet, { providerId: "anthropic", apiKey: SENTINEL });
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME)).toEqual({ kind: "api-key", key: SENTINEL });

    await c.request(METHODS.credentialRemove, { providerId: "anthropic" });
    expect(await secrets.get(ANTHROPIC_CREDENTIAL_SECRET_NAME)).toBeNull();
    // The console account survives its sibling's removal — its only door is `provider.logout`.
    expect(await readCredentialMaterial(secrets, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME)).toEqual({ kind: "bearer", token: `${SENTINEL}-console` });
    c.close();
  });

  test("the typed refusals: unknown provider, and an unusable value — neither ever quotes the value", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");

    const unknown = await c.request(METHODS.credentialSet, { providerId: "not-a-provider", apiKey: SENTINEL });
    expect(unknown.error.data).toEqual({ code: "credential_provider_unknown" });
    expect(JSON.stringify(unknown)).not.toContain(SENTINEL);
    expect((await c.request(METHODS.credentialRemove, { providerId: "not-a-provider" })).error.data).toEqual({ code: "credential_provider_unknown" });

    // A zero-width space — the exact class `invisibleKeyCharWarning` has always rejected at the CLI,
    // now a refusal at this door too.
    const invisible = await c.request(METHODS.credentialSet, { providerId: "deepseek", apiKey: `${SENTINEL}​` });
    expect(invisible.error.data).toEqual({ code: "credential_value_invalid" });
    expect(JSON.stringify(invisible)).not.toContain(SENTINEL);

    // Whitespace-only trims to empty. The wire schema's own `min(1)` cannot see that.
    expect((await c.request(METHODS.credentialSet, { providerId: "deepseek", apiKey: "   " })).error.data).toEqual({ code: "credential_value_invalid" });

    // Over the wire bound: TYPED (review Minor 7). W19-4 names `credential_value_invalid` for this,
    // and the schema's own `.max()` would otherwise refuse it first as a bare INVALID_PARAMS with no
    // `data.code` to branch on. The refusal never says how long the value was.
    const tooLong = await c.request(METHODS.credentialSet, { providerId: "deepseek", apiKey: "a".repeat(5000) });
    expect(tooLong.error.code).toBe(ERR.INVALID_PARAMS);
    expect(tooLong.error.data).toEqual({ code: "credential_value_invalid" });
    expect(tooLong.error.message).not.toMatch(/\d/);
    // Exactly at the bound still passes the door (it is the value rule, not an off-by-one).
    expect((await c.request(METHODS.credentialSet, { providerId: "deepseek", apiKey: "a".repeat(4096) })).result).toEqual({ ok: true });
    c.close();
  });

  test("B-5: a REMOTE (phone) client may call all three; provider.configure stays refused for remote", async () => {
    const { socketPath, remoteToken, secrets } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");

    const set = await c.request(METHODS.credentialSet, { providerId: "zai", apiKey: SENTINEL });
    expect(set.error).toBeUndefined();
    expect(set.result).toEqual({ ok: true });
    expect(await readCredentialMaterial(secrets, "zai:default")).toEqual({ kind: "api-key", key: SENTINEL });

    const list = await c.request(METHODS.credentialList, {});
    expect(list.error).toBeUndefined();
    expect(rowFor(list.result.providers, "zai").present).toBe(true);
    // The whole reply, not just one row: nothing anywhere in it carries the value.
    expect(JSON.stringify(list)).not.toContain(SENTINEL);

    expect((await c.request(METHODS.credentialRemove, { providerId: "zai" })).result).toEqual({ ok: true, removed: true });

    // The negative pin: the rest of the provider family is still role-rejected for remote.
    const configure = await c.request(METHODS.providerConfigure, { apiKey: "sk-x", baseUrl: "https://example.com/v1" });
    expect(configure.result).toBeUndefined();
    expect(configure.error.code).toBe(ERR.UNAUTHORIZED);
    c.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// W19-14's NEGATIVE pins — what WS-19 must NOT have changed, and the logging discipline.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("WS-19 negative pins", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  async function boot(): Promise<{ home: string; socketPath: string; harnessToken: string; secrets: FileSecretStore }> {
    const home = mkdtempSync(join(tmpdir(), "ws19-neg-"));
    // `provider.status` reads settings live, so the home needs a real one.
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2, provider: { type: "openai-compatible", model: "m", baseUrl: "https://example.com/v1" },
    }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "auth-secrets")));
    const tokens = await authority.ensureTokens();
    const secrets = new FileSecretStore(join(home, "secrets"));
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, secrets, winterHome: home,
      dangerousDomainsAdded: () => [], liveModel: () => "m",
    });
    cleanup = () => { server.stop(); store.close(); rmSync(home, { recursive: true, force: true }); };
    return { home, socketPath, harnessToken: tokens.harness, secrets };
  }

  test("sync.config's shape is unchanged — `exaKey` still carries the RAW value, and `credential.set exa` is the same slot", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");

    // Pre-existing and deliberately OUT of WS-19's scope (spec §8): `sync.config` is the phone's own
    // standalone-chat bootstrap and hands it the Exa key itself. What WS-19 must not do is move the
    // slot out from under it — `credential.set exa` writes `exa-api-key`, the same name it reads.
    await c.request(METHODS.credentialSet, { providerId: "exa", apiKey: SENTINEL });
    const cfg = (await c.request(METHODS.syncConfig, {})).result;
    expect(cfg).toMatchObject({ exaKey: SENTINEL });
    expect(Object.keys(cfg as object).sort()).toEqual(
      ["clientEfforts", "defaultEffort", "defaultModel", "dangerousDomains", "exaKey", "models", "provider"].sort(),
    );
    c.close();
  });

  test("provider.status's shape is unchanged, and `credential.set anthropic` is the api-key arm it reports", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");

    const before = (await c.request(METHODS.providerStatus, {})).result as { anthropic: Record<string, unknown> };
    expect(Object.keys(before.anthropic).sort()).toEqual(["apiKey", "auth", "consoleProfile", "effective"].sort());
    expect(before.anthropic.apiKey).toBe(false);

    await c.request(METHODS.credentialSet, { providerId: "anthropic", apiKey: SENTINEL });
    const after = (await c.request(METHODS.providerStatus, {})).result as { anthropic: Record<string, unknown> };
    expect(after.anthropic.apiKey).toBe(true);
    expect(after.anthropic.consoleProfile).toBe(false);
    // Names and booleans only, here too.
    expect(JSON.stringify(after)).not.toContain(SENTINEL);
    c.close();
  });

  test("credential.list on a store that answers NOTHING is a typed refusal, never a list of absent rows (review Minor 4)", async () => {
    const home = mkdtempSync(join(tmpdir(), "ws19-dead-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "auth-secrets")));
    const tokens = await authority.ensureTokens();
    // Reads always throw; the token authority above has its own, working store.
    const dead = {
      get: async (): Promise<string | null> => { throw Object.assign(new Error("keychain locked"), { code: "EKEYCHAINLOCKED" }); },
      set: async (): Promise<void> => { throw new Error("unused"); },
      delete: async (): Promise<boolean> => { throw new Error("unused"); },
    };
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, secrets: dead, winterHome: home });
    cleanup = () => { server.stop(); store.close(); rmSync(home, { recursive: true, force: true }); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "test");

    const res = await c.request(METHODS.credentialList, {});
    expect(res.result).toBeUndefined();
    expect(res.error.data).toEqual({ code: "credential_store_unavailable" });
    // Names no item, and certainly no value.
    expect(res.error.message).not.toMatch(/openai|anthropic|deepseek|exa/);
    c.close();
  });

  test("the RPC read pump prints NOTHING per request — `credential.set`'s params can never reach a log", async () => {
    // VERIFIED BY CONSTRUCTION and pinned here: `ipc/server.ts` has no generic request logger at
    // all (the read pump decodes, dispatches and replies), and `parseParams` renders zod issue
    // PATHS only, never values. This asserts the observable half of that: a successful set, a
    // schema rejection and a typed refusal together produce no console output carrying the value.
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "test");
    const lines: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const warnSpy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    try {
      await c.request(METHODS.credentialSet, { providerId: "deepseek", apiKey: SENTINEL });
      await c.request(METHODS.credentialSet, { providerId: "deepseek", apiKey: "a".repeat(5000) }); // schema rejection
      await c.request(METHODS.credentialSet, { providerId: "codex-oauth", apiKey: SENTINEL });      // typed refusal
      await c.request(METHODS.credentialRemove, { providerId: "deepseek" });
    } finally {
      errSpy.mockRestore(); logSpy.mockRestore(); warnSpy.mockRestore();
    }
    for (const line of lines) expect(line).not.toContain(SENTINEL);
    c.close();
  });
});
