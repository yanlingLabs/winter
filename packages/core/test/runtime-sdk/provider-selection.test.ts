import { test, expect } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from "../../src/providers/codex-config";
import { WINTER_CREDENTIAL_INVENTORY } from "../../src/runtime-sdk/keychain";
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
  for (const slot of WINTER_CREDENTIAL_INVENTORY) {
    expect(ids.has(slot.provider)).toBe(true);
  }
  // The alignment itself, pinned: `codex` (Task 4's spelling) is NOT a catalog id and must not
  // return — `CredentialPresence.byProvider` is keyed by these, so a wrong id silently un-routes
  // every session on that provider. Fix wave 3 (M-B): "anthropic" now appears TWICE (the api-key
  // row and the console-bearer row, keychain.ts's own doc explains why) — still the same catalog id.
  // WS-19 (W19-1): the inventory is derived, so this pins the PREFIX — the four rows whose ORDER
  // decides every tie `providerSelectionFor` breaks below. The remaining ~144 derived rows are the
  // catalog's, in catalog order, and `keychain.test.ts` owns the derivation's own pins.
  expect(WINTER_CREDENTIAL_INVENTORY.slice(0, 4).map((s) => s.provider)).toEqual(["openai", "codex-oauth", "anthropic", "anthropic"]);
  expect(ids.has("codex")).toBe(false);
});

// -------------------------------------------------------------------------------------------
// (a) The parity test — every model Winter's own default catalogue offers.
// -------------------------------------------------------------------------------------------

test("every model Winter's default catalogue offers resolves to an inventory provider in the pinned catalog", () => {
  for (const m of CODEX_MODELS) {
    const providers = inventoryProvidersServing(m.id);
    expect({ id: m.id, providers }).toEqual({ id: m.id, providers: expect.arrayContaining([expect.any(String)]) });
    expect(providers.length).toBeGreaterThan(0);
  }
});

test("FINDING CLOSED at winter-provider-catalog 0.0.4: all three CODEX_MODELS are now codex-oauth rows", () => {
  // Previously (catalog 0.0.3): Winter offers three models on the `codex-oauth` provider
  // (`CODEX_MODELS`), but the pinned catalog listed only ONE of them under `codex-oauth` —
  // `gpt-5.6-terra` and `gpt-5.6-luna` were `openai`-only rows there. The consequence on the
  // Winter leg: a Codex-credentialled session asking for terra/luna was named to the `openai`
  // provider (which that install has no key for) and the child refused with its typed provider
  // error, where the ENGINE leg would have run it on the Codex OAuth credential.
  //
  // Catalog 0.0.4 adds the missing `codex-oauth` rows for terra/luna (P8b-34's "codex terra/luna"
  // carve-out) — the finding is closed. Pinned as an exact map so drift in EITHER direction fails:
  // the catalog losing a row, or Winter's table changing, both land here.
  //
  // WS-19 (W19-1) CHANGED THESE ANSWERS DELIBERATELY: the inventory is now every in-scope api-key
  // catalog provider, so the third-party resellers that also serve these ids (agentrouter,
  // freeaiapikey, kie, kilocode) are now inventory rows too and appear here. That is the POINT of
  // the derivation — a user who stores a kilocode key can route to it — and it is safe because
  // `providerSelectionFor` prefers a provider whose credential is actually PRESENT and falls back
  // to INVENTORY ORDER, whose first row is still `openai` (asserted just below, and in the
  // ambiguity test further down).
  expect(Object.fromEntries(CODEX_MODELS.map((m) => [m.id, inventoryProvidersServing(m.id)]))).toEqual({
    "gpt-5.6-sol": ["openai", "codex-oauth", "agentrouter", "freeaiapikey", "kie", "kilocode"],
    "gpt-5.6-terra": ["openai", "codex-oauth", "kie"],
    "gpt-5.6-luna": ["openai", "codex-oauth", "kie"],
  });
  // The tie-break that matters: with NO credential at all, every one of these still names `openai`
  // — never a reseller — because `openai` leads the inventory.
  for (const m of CODEX_MODELS) expect(providerSelectionFor(m.id, NONE)?.providerId).toBe("openai");
  expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
});

// Whole-branch review Minor 3: the list names each PROVIDER once, not each inventory SLOT. The
// inventory holds two `anthropic` slots (api-key + Console), and `beforeTurn`'s "exactly one
// provider serves this model" narrowing reads this list's LENGTH — so a duplicate would make an
// anthropic-only-served model count as two and never be gated.
test("inventoryProvidersServing de-dupes anthropic's two slots into one provider", () => {
  const anthropicRows = WINTER_CREDENTIAL_INVENTORY.filter((s) => s.provider === "anthropic");
  expect(anthropicRows.length).toBe(2); // the premise: two SLOTS, one provider
  for (const model of ["claude-sonnet-5", "anthropic/claude-sonnet-5", "gpt-5.6-sol"]) {
    const providers = inventoryProvidersServing(model);
    expect(providers.length).toBe(new Set(providers).size);
  }
  // A qualified anthropic key: `anthropic` appears once, not twice — the de-dup's own case. (A
  // reseller row for the same canonical model is legitimately in the list beside it.)
  const qualified = inventoryProvidersServing("anthropic/claude-sonnet-5");
  expect(qualified.filter((p) => p === "anthropic")).toEqual(["anthropic"]);
});

// -------------------------------------------------------------------------------------------
// (b) Credential naming — present → ref, absent → no ref, never a throw.
// -------------------------------------------------------------------------------------------

test("a present credential is NAMED as a keychain ref; the material is never read", () => {
  const sel = providerSelectionFor("gpt-5.6-sol", CODEX_ONLY);
  expect(sel).toEqual({
    providerId: "codex-oauth",
    authRef: { kind: "keychain", account: "codex-oauth:default", service: keychainService() },
  });
  // A locator, never material: nothing in the selection can carry a secret because none is read.
  expect(JSON.stringify(sel)).not.toContain("sk-");
});

test("an ABSENT credential still names the provider, with no ref — the child refuses, the host never throws", () => {
  const sel = providerSelectionFor("gpt-5.6-sol", NONE);
  expect(sel).toEqual({ providerId: "openai" });
  expect((sel as { authRef?: unknown }).authRef).toBeUndefined();
});

test("the credential Winter actually has decides which of six ambiguous rows wins", () => {
  // `gpt-5.6-sol` matches SIX catalog rows (agentrouter, codex-oauth, freeaiapikey, kie, kilocode,
  // openai). Restricting to Winter's inventory and preferring a PRESENT credential is what makes the
  // answer deterministic and right — and never a third-party reseller.
  expect(providerSelectionFor("gpt-5.6-sol", CODEX_ONLY)?.providerId).toBe("codex-oauth");
  expect(providerSelectionFor("gpt-5.6-sol", OPENAI_ONLY)?.providerId).toBe("openai");
  // With both present, inventory order decides — deterministic, and matching today's default.
  expect(providerSelectionFor("gpt-5.6-sol", BOTH)?.providerId).toBe("openai");
});

test("terra now resolves to codex-oauth on a codex-only install (the finding's fix, catalog 0.0.4)", () => {
  // At catalog 0.0.3 this named `openai` (no ref on this install; the child refused). Now that
  // 0.0.4 carries a `codex-oauth` row for terra, the credential Winter actually has decides it.
  const sel = providerSelectionFor("gpt-5.6-terra", CODEX_ONLY);
  expect(sel).toEqual({
    providerId: "codex-oauth",
    authRef: { kind: "keychain", account: "codex-oauth:default", service: keychainService() },
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
    authRef: { kind: "keychain", account: "codex-oauth:default", service: keychainService() },
  });
  expect(providerSelectionFor("openai/gpt-4o", NONE)).toEqual({ providerId: "openai" });
  // A qualified key for a provider Winter has no inventory row for still names it — the child owns
  // the credential question from there.
  expect(providerSelectionFor("groq/llama-3.3-70b-versatile", NONE)?.providerId).toBe("groq");
});

test("a model NO catalog row serves names no provider — the child's catalog-first selection answers", () => {
  expect(providerSelectionFor("definitely-not-a-real-model-id", BOTH)).toBeUndefined();
});

// WS-19 (W19-1) CHANGED THIS ANSWER DELIBERATELY. Before the derivation, `llama-3.3-70b-versatile`
// was "served by the catalog, but by nobody Winter holds a credential slot for" → `undefined`, and
// the session fell through to the child's own selection with no credential named. Now `groq` is an
// inventory row like every other in-scope api-key provider, so the model resolves and — once a groq
// key is stored — is actually routable. This is the requirement (R-10b-11), not a regression: it is
// the same change that makes WS-18's five-hop chain reachable at all.
test("a model served by a NEWLY-derived inventory provider now resolves to it (the WS-19 widening)", () => {
  expect(providerSelectionFor("llama-3.3-70b-versatile", BOTH)).toEqual({ providerId: "groq" });
  expect(providerSelectionFor("llama-3.3-70b-versatile", { byProvider: { groq: "keychain" } })).toEqual({
    providerId: "groq",
    authRef: { kind: "keychain", account: "groq:default", service: keychainService() },
  });
});
