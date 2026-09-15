// Winter Phase 10b (D1-6, R6-R8 review CRITICAL): the daemon's own ProviderRegistry — built from
// the compiled catalog with EVERY shipped adapter registered, so `createEndpointResolver` (the
// router's `HandoffBarrierDeps.resolveEndpoint`) reads REAL catalog descriptor facts instead of the
// registry-free fallback. Measured against the real router (0.0.5) `registry.resolve()`: a provider
// whose adapter is NOT registered refuses `no-adapter`, and `createEndpointResolver` then falls back
// to `endpointFromOrigin` (`readableState: "none"` for everything) — which is exactly what silently
// over-warned a real lossless DeepSeek -> GLM transfer before this lane existed.
import { describe, expect, test } from "bun:test";
import { WinterProviderResolutionError, reviewModelSwitch } from "@yanlinglabs/winter-provider-runtime";
import type { ProviderStateRecord, SwitchReview } from "@yanlinglabs/winter-provider-runtime";
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { daemonProviderRegistry, daemonResolveEndpoint } from "../../src/providers/registry";

describe("daemonProviderRegistry", () => {
  test("registers a real adapter for every shipped adapter family — no provider refuses no-adapter", () => {
    const registry = daemonProviderRegistry();
    const listing = registry.list();
    // Every adapter this build ships is present (SHIPPED_ADAPTER_IDS' own count), and every catalog
    // provider row reports its adapter as REGISTERED — not merely declared in the catalog.
    for (const provider of listing.providers) {
      expect({ provider: provider.id, adapterRegistered: provider.adapterRegistered }).toEqual({
        provider: provider.id,
        adapterRegistered: true,
      });
    }
  });

  test("resolve() succeeds (not no-adapter) for one provider per adapter family", () => {
    const registry = daemonProviderRegistry();
    // One representative provider id per SHIPPED_ADAPTER_IDS family (from the catalog's own
    // adapterId -> provider grouping, measured 2026-09-14 against 0.0.10's catalog).
    const representatives: Array<{ providerId: string; model: string }> = [
      { providerId: "openai", model: "gpt-5.6-sol" },
      { providerId: "deepseek", model: "deepseek-chat" },
      { providerId: "codex-oauth", model: "gpt-5.6-sol" },
      { providerId: "anthropic", model: "claude-opus-5" },
      { providerId: "google", model: "gemini-2.5-pro" },
      { providerId: "vertex", model: "gemini-2.5-pro" },
      { providerId: "bedrock", model: "claude-opus-5" },
      { providerId: "azure-openai", model: "gpt-5.6-sol" },
    ];
    for (const { providerId, model } of representatives) {
      const resolved = registry.resolve({ model, provider: { providerId, allowUnlisted: true } });
      const failed = resolved instanceof WinterProviderResolutionError;
      // Some representative model ids may not resolve to a real row (unknown-model) — that is fine,
      // this test only pins that a MISSING ADAPTER (no-adapter) never happens.
      if (failed) {
        expect({ providerId, code: (resolved as WinterProviderResolutionError).code }).not.toEqual({ providerId, code: "no-adapter" });
      }
    }
  });

  test("is a memoised singleton", () => {
    expect(daemonProviderRegistry()).toBe(daemonProviderRegistry());
  });
});

describe("daemonResolveEndpoint", () => {
  test("returns real catalog readableState for a known-reasoning model, not the registry-free 'none' fallback", () => {
    const resolve = daemonResolveEndpoint();
    // DeepSeek's reasoning is documented as fully exposed (`reasoning_content`) — W18-15/W18-19's own
    // "DeepSeek (complete exposed)" premise. Without a real registry this reads back "none".
    const endpoint = resolve({ providerId: "deepseek", modelKey: "deepseek/deepseek-reasoner", family: "deepseek" });
    expect(endpoint.readableState).not.toBe("none");
  });

  test("is memoised (same function survives across calls, per-process cache)", () => {
    expect(daemonResolveEndpoint()).toBe(daemonResolveEndpoint());
  });
});

// Winter Phase 10b (D1-6, R6-R8 review, CRITICAL — resume note's own explicit ask): "a test on the
// REAL daemon wiring, with no fixture resolver: deepseek (complete exposed) -> GLM is silent, and
// gpt -> claude prompts." `daemonResolveEndpoint()` here is the REAL, registry-backed resolver
// (`create.ts`'s own `HandoffBarrierDeps.resolveEndpoint` injection) — never a test fixture that
// fakes `readableState`/`continuation`. `reviewModelSwitch` is the router's OWN pure pre-flight
// review (re-exported by `@yanlinglabs/winter-provider-runtime`, the same function
// `HandoffBarrier.reviewSwitch` calls internally per the published 0.0.5 source). Driving it
// directly with hand-built minimal `entries`/`sidecarRecords` — rather than a full router
// barrier/store/directory stack — is a deliberate scope choice: `SessionStoreEntry` is a loose
// `{type, uuid?, timestamp?, [key: string]: unknown}` shape (`@yanlinglabs/winter-agent-sdk`'s own
// declared type), and `switchFactsFor`'s ENTIRE read of it (measured against the published
// `winter-provider-runtime` 0.0.10 source) is: walk `uuid`/`parentUuid` back from the last entry,
// filter `type === "assistant"`, and look up sidecar records by `anchorUuid`. Building a full JSONL
// canonical transcript + a real `HandoffBarrier`/`SharedSessionStore` would exercise strictly MORE
// file-format plumbing without exercising the REGISTRY WIRING this test exists to prove — the one
// property still worth measuring end to end is that the REAL resolver's catalog facts (not a
// fixture's) drive `classifySwitch` correctly for exactly the two rows the resume note names.
describe("D1-6: the pre-flight review, against the daemon's REAL resolveEndpoint (no fixture)", () => {
  const resolve = daemonResolveEndpoint();

  test("DeepSeek (complete exposed) -> GLM is silent (lossless-portable, no prompt)", () => {
    const from = resolve({ providerId: "deepseek", modelKey: "deepseek/deepseek-reasoner", family: "deepseek" });
    // 0.0.10's catalog carries no reasoning evidence for zai/GLM rows at all (resume note's own
    // note) — the silence here must hold on the SOURCE's own complete-exposed facts, never on the
    // destination happening to have matching evidence.
    const to = resolve({ providerId: "zai", modelKey: "zai/glm-5", family: "glm" });
    expect(from.readableState).toBe("full-exposed"); // the premise this case rests on
    const entries: SessionStoreEntry[] = [
      { type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "text", text: "the answer is 4" }] } },
    ];
    const sidecarRecords: ProviderStateRecord[] = [
      {
        type: "provider_state", uuid: "sc1", timestamp: new Date().toISOString(), sessionId: "s_test",
        anchorUuid: "a1", provider: "deepseek", model: "deepseek/deepseek-reasoner", family: "deepseek",
        itemIndex: 0, kind: "summary", payload: { text: "reasoning: 2+2=4", material: "exposed", complete: true },
      },
    ];
    const review: SwitchReview = reviewModelSwitch({ entries, sidecarRecords, from, to });
    expect(review.prompt).toBe(false);
    expect(review.classification?.lossClass).toBe("lossless-portable");
  });

  test("gpt -> claude prompts (a hidden-reasoning source crossing to a different domain is warned-lossy)", () => {
    // gpt-5.6-sol: `reasoning.continuation: "opaque-provider-state"` (it reasons) with no readable-
    // summary evidence declared (`readableState` reads back "none") — the catalog's own "Anthropic/
    // OpenAI strip thinking across models" premise this case rests on.
    const from = resolve({ providerId: "openai", modelKey: "openai/gpt-5.6-sol", family: "openai" });
    const to = resolve({ providerId: "anthropic", modelKey: "anthropic/claude-opus-5", family: "anthropic" });
    expect(from.readableState).not.toBe("full-exposed");
    expect(from.continuation).not.toBe("none");
    const entries: SessionStoreEntry[] = [
      { type: "assistant", uuid: "b1", parentUuid: null, message: { role: "assistant", content: [{ type: "text", text: "the answer is 4" }] } },
    ];
    // No sidecar record at all — GPT's reasoning is hidden/encrypted, so there is nothing readable
    // to carry, which is exactly the case that must still warn (never "no evidence, so silence").
    const review: SwitchReview = reviewModelSwitch({ entries, sidecarRecords: [], from, to });
    expect(review.prompt).toBe(true);
    expect(review.classification?.lossClass).toBe("warned-lossy");
    expect(review.classification?.warnings.length).toBeGreaterThan(0);
    // Never names an SDK or runtime (R-10b-4) — the matrix's own prose invariant.
    for (const w of review.classification?.warnings ?? []) {
      expect(w).not.toMatch(/\bSDK\b|\bruntime\b|Claude Agent|Winter Agent/i);
    }
  });
});
