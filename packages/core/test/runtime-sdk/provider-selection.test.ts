import { test, expect } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from "../../src/providers/codex-config";
import { NORMA_CREDENTIAL_INVENTORY } from "../../src/runtime-sdk/keychain";
import { keychainService } from "../../src/profile";
import {
  providerSelectionFor, inventoryProvidersServing, testProviderNameFor,
} from "../../src/runtime-sdk/provider-selection";

const NONE: CredentialPresence = { byProvider: {} };
const CODEX_ONLY: CredentialPresence = { byProvider: { "codex-oauth": "keychain" } };
const OPENAI_ONLY: CredentialPresence = { byProvider: { openai: "keychain" } };
const BOTH: CredentialPresence = { byProvider: { openai: "keychain", "codex-oauth": "keychain" } };

// -------------------------------------------------------------------------------------------
// (0) The catalog alignment — ruling 9's precondition.
// -------------------------------------------------------------------------------------------

test("every inventory provider id exists in the PINNED catalog", () => {
  const ids = new Set(loadCatalog().providers.map((p) => p.id));
  for (const slot of NORMA_CREDENTIAL_INVENTORY) {
    expect(ids.has(slot.provider)).toBe(true);
  }
  // The alignment itself, pinned: `codex` (Task 4's spelling) is NOT a catalog id and must not
  // return — `CredentialPresence.byProvider` is keyed by these, so a wrong id silently un-routes
  // every session on that provider.
  expect(NORMA_CREDENTIAL_INVENTORY.map((s) => s.provider)).toEqual(["openai", "codex-oauth"]);
  expect(ids.has("codex")).toBe(false);
});

// -------------------------------------------------------------------------------------------
// (a) The parity test — every model Norma's own default catalogue offers.
// -------------------------------------------------------------------------------------------

test("every model Norma's default catalogue offers resolves to an inventory provider in the pinned catalog", () => {
  for (const m of CODEX_MODELS) {
    const providers = inventoryProvidersServing(m.id);
    expect({ id: m.id, providers }).toEqual({ id: m.id, providers: expect.arrayContaining([expect.any(String)]) });
    expect(providers.length).toBeGreaterThan(0);
  }
});

test("FINDING CLOSED at winter-provider-catalog 0.0.4: all three CODEX_MODELS are now codex-oauth rows", () => {
  // Previously (catalog 0.0.3): Norma offers three models on the `codex-oauth` provider
  // (`CODEX_MODELS`), but the pinned catalog listed only ONE of them under `codex-oauth` —
  // `gpt-5.6-terra` and `gpt-5.6-luna` were `openai`-only rows there. The consequence on the
  // Winter leg: a Codex-credentialled session asking for terra/luna was named to the `openai`
  // provider (which that install has no key for) and the child refused with its typed provider
  // error, where the ENGINE leg would have run it on the Codex OAuth credential.
  //
  // Catalog 0.0.4 adds the missing `codex-oauth` rows for terra/luna (P8b-34's "codex terra/luna"
  // carve-out) — the finding is closed. Pinned as an exact map so drift in EITHER direction fails:
  // the catalog losing a row, or Norma's table changing, both land here.
  expect(Object.fromEntries(CODEX_MODELS.map((m) => [m.id, inventoryProvidersServing(m.id)]))).toEqual({
    "gpt-5.6-sol": ["openai", "codex-oauth"],
    "gpt-5.6-terra": ["openai", "codex-oauth"],
    "gpt-5.6-luna": ["openai", "codex-oauth"],
  });
  expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
});

// -------------------------------------------------------------------------------------------
// (b) Credential naming — present → ref, absent → no ref, never a throw.
// -------------------------------------------------------------------------------------------

test("a present credential is NAMED as a keychain ref; the material is never read", () => {
  const sel = providerSelectionFor("gpt-5.6-sol", CODEX_ONLY);
  expect(sel).toEqual({
    providerId: "codex-oauth",
    authRef: { kind: "keychain", account: "codex-access-token", service: keychainService() },
  });
  // A locator, never material: nothing in the selection can carry a secret because none is read.
  expect(JSON.stringify(sel)).not.toContain("sk-");
});

test("an ABSENT credential still names the provider, with no ref — the child refuses, the host never throws", () => {
  const sel = providerSelectionFor("gpt-5.6-sol", NONE);
  expect(sel).toEqual({ providerId: "openai" });
  expect((sel as { authRef?: unknown }).authRef).toBeUndefined();
});

test("the credential Norma actually has decides which of six ambiguous rows wins", () => {
  // `gpt-5.6-sol` matches SIX catalog rows (agentrouter, codex-oauth, freeaiapikey, kie, kilocode,
  // openai). Restricting to Norma's inventory and preferring a PRESENT credential is what makes the
  // answer deterministic and right — and never a third-party reseller.
  expect(providerSelectionFor("gpt-5.6-sol", CODEX_ONLY)?.providerId).toBe("codex-oauth");
  expect(providerSelectionFor("gpt-5.6-sol", OPENAI_ONLY)?.providerId).toBe("openai");
  // With both present, inventory order decides — deterministic, and matching today's default.
  expect(providerSelectionFor("gpt-5.6-sol", BOTH)?.providerId).toBe("openai");
});

test("terra now resolves to codex-oauth on a codex-only install (the finding's fix, catalog 0.0.4)", () => {
  // At catalog 0.0.3 this named `openai` (no ref on this install; the child refused). Now that
  // 0.0.4 carries a `codex-oauth` row for terra, the credential Norma actually has decides it.
  const sel = providerSelectionFor("gpt-5.6-terra", CODEX_ONLY);
  expect(sel).toEqual({
    providerId: "codex-oauth",
    authRef: { kind: "keychain", account: "codex-access-token", service: keychainService() },
  });
});

// -------------------------------------------------------------------------------------------
// (c) The escapes.
// -------------------------------------------------------------------------------------------

test("winter-test/* never names a provider — the double is selected by env var", () => {
  expect(providerSelectionFor("winter-test/echo", BOTH)).toBeUndefined();
  expect(providerSelectionFor("winter-test/anything", NONE)).toBeUndefined();
  expect(testProviderNameFor("winter-test/echo")).toBe("echo");
  expect(testProviderNameFor("winter-test/")).toBeUndefined();
  expect(testProviderNameFor("gpt-5.6-sol")).toBeUndefined();
  expect(testProviderNameFor(undefined)).toBeUndefined();
});

test("no model names no provider", () => {
  expect(providerSelectionFor(undefined, BOTH)).toBeUndefined();
  expect(providerSelectionFor("", BOTH)).toBeUndefined();
});

test("a fully-qualified <providerId>/<model> key is taken at its word, with its ref when we have one", () => {
  expect(providerSelectionFor("codex-oauth/gpt-5.6-sol", CODEX_ONLY)).toEqual({
    providerId: "codex-oauth",
    authRef: { kind: "keychain", account: "codex-access-token", service: keychainService() },
  });
  expect(providerSelectionFor("openai/gpt-4o", NONE)).toEqual({ providerId: "openai" });
  // A qualified key for a provider Norma has no inventory row for still names it — the child owns
  // the credential question from there.
  expect(providerSelectionFor("groq/llama-3.3-70b-versatile", NONE)?.providerId).toBe("groq");
});

test("a model no inventory provider serves names no provider — the child's catalog-first selection answers", () => {
  expect(providerSelectionFor("definitely-not-a-real-model-id", BOTH)).toBeUndefined();
  // Served by the catalog, but by nobody Norma holds a credential slot for.
  expect(providerSelectionFor("llama-3.3-70b-versatile", BOTH)).toBeUndefined();
});
