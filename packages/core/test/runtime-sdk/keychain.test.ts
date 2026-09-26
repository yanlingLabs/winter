import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import { WEB_SEARCH_API_KEY_SECRET } from "../../src/agent/tools/web";
import { FileSecretStore, type SecretStore } from "../../src/auth/secret-store";
import { TOKEN_NAMES } from "../../src/auth/tokens";
import { keychainService } from "../../src/profile";
import { OPENAI_API_KEY_SECRET } from "../../src/providers/manager";
import { CODEX_SECRET_NAMES, CodexAuthStore, writeOpenAiApiKey } from "../../src/auth/credential-material";
import { credentialInventory, credentialPresenceFrom, credentialPresentProbe, credentialRefFor, isInScopeApiKeyProvider, refMaterialPresent, WINTER_CREDENTIAL_INVENTORY, ANTHROPIC_CREDENTIAL_SECRET_NAME, ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT } from "@yanlinglabs/winter-provider-runtime";
import { Settings } from "../../src/settings";

// The real `CredentialRef` (`@yanlinglabs/winter-agent-sdk` protocol/config.d.ts:317-333) is a
// discriminated union with NO `api_key` kind and NO `provider`/`secretName` fields — the brief's
// `{ kind: "api_key", provider, secretName }` placeholder does not exist on the installed type.
// The kind that names a Keychain-backed secret is `{ kind: "keychain"; account: string; service?:
// string }`; `account` is the secret name, `service` is Winter's own `keychainService()`
// (see keychain.ts's `credentialRefFor`).
//
// HOTFIX (post-8b, 2026-09-11): the inventory's secret names moved from raw token/key strings
// ("openai-api-key" / "codex-access-token") to JSON `CredentialMaterial` records ("openai:default"
// / "codex-oauth:default") — see auth/credential-material.ts. (WS-23: the `KeychainSeam` that read
// them for the retired official leg is gone — the daemon names a credential and never reads it.)

let dir: string;
let store: FileSecretStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p8b-kc-"));
  store = new FileSecretStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A `SecretStore` whose `get` always rejects — simulates a locked/denied Keychain (F2). */
class ThrowingSecretStore implements SecretStore {
  async get(): Promise<string | null> {
    const err = new Error("keychain locked — should never appear in a log line");
    (err as Error & { code?: string }).code = "EKEYCHAINLOCKED";
    throw err;
  }
  async set(): Promise<void> {
    throw new Error("not used by these tests");
  }
  async delete(): Promise<boolean> {
    throw new Error("not used by these tests");
  }
}

describe("credential inventory and presence over SecretStore", () => {
  test("credentialPresenceFrom lists providers by KIND only — no material anywhere in the result", async () => {
    await writeOpenAiApiKey(store, "sk-test");
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider.openai).toBe("keychain");
    expect(presence.byProvider["codex-oauth"]).toBeUndefined();
    expect(JSON.stringify(presence)).not.toContain("sk-test");
  });

  test("credentialPresenceFrom reports codex only once VALID OAuth material is stored", async () => {
    await new CodexAuthStore(store).save({ accessToken: "at_live", refreshToken: null, idToken: null, accountId: null, expiresAt: 0 });
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider["codex-oauth"]).toBe("keychain");
    expect(presence.byProvider.openai).toBeUndefined();
    // P8c-10: authByProvider is now filled for every present provider this file has a family for.
    expect(presence.authByProvider).toEqual({ "codex-oauth": { authFamily: "custom" } });
  });

  test("credentialPresenceFrom: authByProvider (P8c-10) — openai and anthropic are api-key, codex-oauth is custom", async () => {
    await writeOpenAiApiKey(store, "sk-test");
    await store.set(WINTER_CREDENTIAL_INVENTORY.find((s) => s.provider === "anthropic")!.secretName, JSON.stringify({ kind: "api-key", key: "sk-ant-test" }));
    const presence = await credentialPresenceFrom(store);
    expect(presence.authByProvider).toEqual({ openai: { authFamily: "api-key" }, anthropic: { authFamily: "api-key" } });
  });

  // WS-23 live-gate bug: a Console-only home refused every `console/*` session at create ("console:
  // add a credential"), because its bearer was filed under "anthropic" — so `byProvider.console` never
  // existed, and the home falsely reported `anthropic` (the API-key provider) present. Each Anthropic
  // account now answers for its OWN provider, and only with its own material kind.
  describe("the two Anthropic accounts answer for their own providers (WS-23 live-gate fix)", () => {
    test("a Console-only home: `console` present, `anthropic` NOT", async () => {
      await store.set(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "bearer", token: "console-bearer-test" }));
      const presence = await credentialPresenceFrom(store);
      expect(presence.byProvider.console).toBe("keychain");
      expect(presence.byProvider.anthropic).toBeUndefined();
      // No declared family for `console` — the router names it `console-profile` itself.
      expect(presence.authByProvider?.console).toBeUndefined();
    });

    test("an API-key-only home: `anthropic` present, `console` NOT", async () => {
      await store.set(ANTHROPIC_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "api-key", key: "sk-ant-test" }));
      const presence = await credentialPresenceFrom(store);
      expect(presence.byProvider.anthropic).toBe("keychain");
      expect(presence.byProvider.console).toBeUndefined();
    });

    test("a record of the WRONG kind in either account is absent — the same narrowing credential.list applies", async () => {
      await store.set(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "api-key", key: "sk-ant-misfiled" }));
      await store.set(ANTHROPIC_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "bearer", token: "bearer-misfiled" }));
      const presence = await credentialPresenceFrom(store);
      expect(presence.byProvider.console).toBeUndefined();
      expect(presence.byProvider.anthropic).toBeUndefined();
      expect(await refMaterialPresent(store, credentialRefFor("console", dir))).toBe(false);
      expect(await refMaterialPresent(store, credentialRefFor("anthropic", dir))).toBe(false);
    });

    test("credentialPresentProbe answers `console` from its slot, never from an on-disk profile", async () => {
      await store.set(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, JSON.stringify({ kind: "bearer", token: "console-bearer-test" }));
      const present = credentialPresentProbe({ credentials: await credentialPresenceFrom(store) });
      expect(present("console")).toBe(true);
      expect(present("anthropic")).toBe(false);
      const none = credentialPresentProbe({ credentials: await credentialPresenceFrom(new FileSecretStore(mkdtempSync(join(dir, "empty-")))) });
      expect(none("console")).toBe(false);
    });
  });

  test("credentialPresenceFrom: PRESENCE IS PARSEABILITY (hotfix review r1, M1) — a raw non-JSON leftover (the OLD pre-hotfix shape) is ABSENT, never present", async () => {
    await store.set(WINTER_CREDENTIAL_INVENTORY.find((s) => s.provider === "codex-oauth")!.secretName, "codex-token");
    const presence = await credentialPresenceFrom(store);
    expect(presence.byProvider["codex-oauth"]).toBeUndefined();
  });

  test("a SecretStore.get failure never propagates — credentialPresenceFrom treats the slot as absent", async () => {
    const presence = await credentialPresenceFrom(new ThrowingSecretStore());
    expect(presence.byProvider).toEqual({});
  });

  test("WS-19 (review Minor 4): a dead store logs ONE aggregated line with a COUNT, not one per slot", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    try {
      await credentialPresenceFrom(new ThrowingSecretStore());
    } finally { spy.mockRestore(); }
    // The inventory is ~150 rows; the per-slot form turned one fault into 148 identical lines on
    // every session open.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${WINTER_CREDENTIAL_INVENTORY.length} of ${WINTER_CREDENTIAL_INVENTORY.length} presence probe(s) failed`);
    // The error CODE only — never a secret name, never the message text, never a value.
    expect(lines[0]).toContain("EKEYCHAINLOCKED");
    expect(lines[0]).not.toContain("openai:default");
    expect(lines[0]).not.toContain("should never appear in a log line");
  });

  // WS-19 (W19-1): the inventory is DERIVED from the pinned catalog, so this is no longer a
  // contents pin (a catalog bump legitimately moves ~146 of the 148 rows). What is pinned instead
  // is the DERIVATION: the four-row prefix that must not move, the count formula, and spot rows
  // that must be in or out. Everything a literal pin used to protect is still protected — just at
  // the level that can survive a catalog that grows on its own, which is the whole point of the
  // "providers live in the SDKs" ruling.
  describe("the derived inventory (WS-19 W19-1)", () => {
    test("today's four rows are the PREFIX, verbatim and in order — providerSelectionFor breaks ties by inventory order", () => {
      expect(WINTER_CREDENTIAL_INVENTORY.slice(0, 4)).toEqual([
        { provider: "openai", secretName: "openai:default", kind: "keychain" },
        { provider: "codex-oauth", secretName: "codex-oauth:default", kind: "keychain" },
        { provider: "anthropic", secretName: "anthropic:default", kind: "keychain" },
        // WS-23 live-gate fix: the console bearer account is filed under the `console` CATALOG
        // provider (fix wave 3's M-B had filed it under "anthropic", which left `byProvider.console`
        // unproducible and refused every `console/*` session at create time).
        { provider: "console", secretName: "anthropic:console", kind: "keychain" },
      ]);
    });

    test("the count is the formula, not a number — in-scope api-key providers + the two OAuth rows", () => {
      const inScope = loadCatalog().providers.filter(isInScopeApiKeyProvider);
      // `openai` and `anthropic` are themselves in-scope api-key rows and appear once each; the two
      // EXTRA rows are `codex-oauth:default` and `anthropic:console`, neither of which is derived.
      expect(WINTER_CREDENTIAL_INVENTORY.length).toBe(inScope.length + 2);
      expect(credentialInventory()).toBe(WINTER_CREDENTIAL_INVENTORY); // memoised, one array
    });

    test("every row's secretName is <providerId>:default (bar the Console's fixed account), and every provider appears exactly once", () => {
      for (const slot of WINTER_CREDENTIAL_INVENTORY) {
        if (slot.secretName === "anthropic:console") continue;
        expect(slot.secretName).toBe(`${slot.provider}:default`);
        expect(slot.kind).toBe("keychain");
      }
      const counts = new Map<string, number>();
      for (const slot of WINTER_CREDENTIAL_INVENTORY) counts.set(slot.provider, (counts.get(slot.provider) ?? 0) + 1);
      expect([...counts].filter(([, n]) => n > 1)).toEqual([]);
      // The Console's account keeps its `anthropic:` prefix (renaming a Keychain item would strand every
      // signed-in home) but belongs to the `console` provider — the one row whose name is not derived.
      expect(WINTER_CREDENTIAL_INVENTORY.filter((s) => s.secretName === "anthropic:console")).toEqual([{ provider: "console", secretName: "anthropic:console", kind: "keychain" }]);
    });

    test("the providers WS-18's five-hop chain needs are IN — this is the whole reason the inventory was derived", () => {
      const ids = new Set(WINTER_CREDENTIAL_INVENTORY.map((s) => s.provider));
      for (const id of ["deepseek", "zai", "openrouter", "google", "xai"]) expect(ids.has(id)).toBe(true);
    });

    test("endpoint-required, local-none and blocked rows are OUT — by construction, never by a denylist", () => {
      const ids = new Set(WINTER_CREDENTIAL_INVENTORY.map((s) => s.provider));
      // `requiresUserEndpoint` rows ship with a placeholder host, so a credential slot for one
      // would route a session at a literal `<resource>` domain.
      for (const id of ["azure-ai", "oci"]) expect(ids.has(id)).toBe(false);
      for (const p of loadCatalog().providers) {
        if (p.risk.class === "blocked") expect(ids.has(p.id)).toBe(false);
        // A `local-none` row (a local endpoint with no key) is only excluded when it declares NO
        // api-key kind at all — which is what `local-none` means. Asserted over the real catalog so
        // a row that later gains an api-key kind is a deliberate, visible change here.
        if (p.authKinds.length === 1 && p.authKinds[0] === "local-none") expect(ids.has(p.id)).toBe(false);
      }
    });
  });

  test("every non-provider secret is excluded from the inventory", () => {
    const excluded = [
      "sparkle-private-key",
      TOKEN_NAMES.harness,
      TOKEN_NAMES.admin,
      TOKEN_NAMES.remote,
      EXA_API_KEY_SECRET,
      WEB_SEARCH_API_KEY_SECRET,
      // LEGACY raw records (hotfix): migration-source/logout-target only now, never read through
      // this seam.
      OPENAI_API_KEY_SECRET,
      CODEX_SECRET_NAMES.access,
      CODEX_SECRET_NAMES.refresh,
      CODEX_SECRET_NAMES.id,
      CODEX_SECRET_NAMES.account,
      CODEX_SECRET_NAMES.expires,
    ];
    const inventoryNames = new Set(WINTER_CREDENTIAL_INVENTORY.map((s) => s.secretName));
    for (const name of excluded) expect(inventoryNames.has(name)).toBe(false);
  });

  test("credentialRefFor names a known provider's ref (matching 8a's keychain:<account> locator form); unknown providers get undefined", () => {
    expect(credentialRefFor("openai")).toEqual({ kind: "keychain", account: "openai:default", service: keychainService() });
    expect(credentialRefFor("codex-oauth")).toEqual({ kind: "keychain", account: "codex-oauth:default", service: keychainService() });
    expect(credentialRefFor("nope")).toBeUndefined();
  });

  describe("credentialRefFor — WS-20: the arm is the tag's own prefix, not a settings decision", () => {
    test("\"anthropic\" always resolves to anthropic:default — the arm decision moved to the tag prefix (officialAuthArmFor), not a settings-driven choice here", () => {
      expect(credentialRefFor("anthropic", dir)).toEqual({ kind: "keychain", account: ANTHROPIC_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, dir) });
    });

    test("\"console\" names the console broker's bearer slot — an ordinary inventory row, no special case", () => {
      // WS-23: the official `claude` leg that read the on-disk profile is gone, so `console` gets the
      // `{kind:"keychain", account, service}` locator for `anthropic:console` like every other
      // provider — and since the live-gate fix it is the inventory's own `console` row, so presence
      // (`credentialPresenceFrom`) reads the very slot this ref names.
      expect(credentialRefFor("console", dir)).toEqual({ kind: "keychain", account: ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME, service: keychainService(undefined, dir) });
      expect(WINTER_CREDENTIAL_INVENTORY.find((s) => s.provider === "console")?.secretName).toBe(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME);
    });

    test("every OTHER provider is an ordinary fixed inventory row", () => {
      expect(credentialRefFor("openai", dir)).toEqual({ kind: "keychain", account: "openai:default", service: keychainService(undefined, dir) });
    });
  });

  // Test-keychain-isolation TRIPWIRE: `test/preload.ts` sets `WINTER_KEYCHAIN_SERVICE` for the
  // whole run, and every real daemon/session in this test process runs on a temp (non-default)
  // `WINTER_HOME` — so a resolution built for ANY test home must never land back on the real
  // `com.winter.core[.dev]` service, no matter which function does the resolving. This fails loudly
  // the moment either the preload's override or `keychainService()`'s default-home guard regresses.
  test("TRIPWIRE: a test-homed credentialRefFor resolution never equals the REAL Keychain service", () => {
    expect(process.env.WINTER_KEYCHAIN_SERVICE).toBeTruthy(); // preload precondition — if this is unset, the tripwire is meaningless
    const ref = credentialRefFor("openai", dir); // `dir` (beforeEach) is a temp, non-default home
    if (ref?.kind !== "keychain") throw new Error("expected a keychain CredentialRef for a known provider");
    expect(ref.service).toBeDefined();
    expect(ref.service).not.toBe("com.winter.core");
    expect(ref.service).not.toBe("com.winter.core.dev");
    expect(ref.service).toBe(process.env.WINTER_KEYCHAIN_SERVICE);
  });
});

describe("the console bearer's Keychain account (P10a R-10a-6, 0.0.9 integration)", () => {
  test("the daemon's local literal equals the SDK's exported console account, and is never the API-key slot", () => {
    expect(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME).toBe(ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT);
    expect(ANTHROPIC_CONSOLE_CREDENTIAL_SECRET_NAME).not.toBe(ANTHROPIC_CREDENTIAL_SECRET_NAME);
  });
});
