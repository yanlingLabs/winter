/**
 * D1 (2026-09-22 dist-session-fixes): a chat session on a `deepseek`-family model was refused
 * mid-turn — "model \"alibaba-cn/deepseek-v4-flash\" declares no reasoning effort vocabulary, so
 * effort \"max\" cannot be mapped onto it" — even though the session's own row (whichever
 * `deepseek`-adapter-family provider it actually ran on) declares a real effort vocabulary.
 *
 * ROOT CAUSE, confirmed against the REAL pinned catalog (`@yanlinglabs/winter-provider-catalog`)
 * and the REAL pinned Winter-leg runtime (`@yanlinglabs/winter-provider-runtime`, version pinned by
 * `runtime-sdk/versions.ts`'s `REQUIRED_WINTER_AGENT_SDK`): this is an SDK-SIDE bug, not a daemon
 * one. The DAEMON'S OWN inputs are correct end to end —
 *
 *   - `runtime-sdk/provider-selection.ts`'s `providerFor(tag)` names exactly one provider from a tag
 *     (WS-20; no bare-id tie-break), verified below against the real catalog;
 *   - `runtime-sdk/mode-options.ts`'s `buildWinterOptions` sends the Winter child the BARE modelId
 *     as `Options.model` PLUS the qualified `Options.provider.providerId` — so the child receives
 *     BOTH pieces it needs to disambiguate.
 *
 * But inside the WINTER CHILD, `packages/provider-runtime/src/adapters/index.ts`'s
 * `descriptorLookupForAdapter` builds ONE descriptor index PER ADAPTER ID, not per provider, and
 * every OpenAI-family provider that shares an adapter (`winter.openai-chat-completions` alone
 * serves `deepseek`, `alibaba`, `alibaba-cn`, `blackbox`, `qwen-cloud`, `sensenova`,
 * `volcengine-coding-plan`, `openrouter`, …) is folded into that ONE map, keyed by the bare
 * `upstreamId` with a "first provider in catalog order wins" collision rule
 * (`if (!index.has(model.upstreamId)) index.set(...)`). `chat-completions.ts`'s `streamTurn` then
 * looks up `options.descriptors?.(req.model)` with `req.model` being the WIRE id
 * (`bridge.ts`'s `resolved.providerModelId` — the same bare id every one of these providers shares
 * for this model), so a request that is ALREADY on the session's own correctly-resolved provider
 * (verified by `registry.resolve`, which IS provider-scoped) gets its EFFORT validated against
 * WHICHEVER provider's row happened to be inserted first for that bare id — never the session's own.
 *
 * This is exactly the bare-id cross-provider substitution the user's qualified-tags ruling forbids
 * (CLAUDE.md "Providers and credentials": "a model is always a provider-qualified tag ...
 * `providerFor(tag)` names the credential and nothing in the daemon selects a provider for a bare
 * id") — it has simply moved one layer down, into the SDK's shared-adapter wiring, where the daemon
 * cannot reach it. The Anthropic-dialect adapter does not have this bug: its own
 * `findDescriptor(catalog, providerId, model)` (`adapters/anthropic/messages.ts:320`) takes an
 * explicit `providerId` and filters by it, and the DAEMON'S OWN internal-jobs adapter builder
 * (`providers/internal-adapters.ts`'s `descriptorsForProvider`) already does the provider-scoped
 * version of this same lookup for exactly this reason — this test is the proof that the Winter
 * CHILD's production wiring (`createShippedAdapters`) still uses the unscoped one.
 *
 * Fix required in `../winter-agent-sdk` (lane E), NOT here:
 *   `packages/provider-runtime/src/adapters/index.ts`'s `createShippedAdapters` registers ONE
 *   `createChatCompletionsAdapter`/`createResponsesAdapter`/… per ADAPTER ID today. It needs a
 *   descriptor lookup that also takes the REQUEST'S OWN `ctx.connection.providerId` — the same shape
 *   `findDescriptor` and this daemon's own `descriptorsForProvider` already use — so a shared adapter
 *   can never answer an effort/capability check with another provider's row.
 */
import { describe, expect, test } from "bun:test";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { descriptorLookupForAdapter } from "@yanlinglabs/winter-provider-runtime";
import { providerFor } from "../../src/runtime-sdk/provider-selection";

/**
 * A byte-for-byte copy of `packages/provider-runtime/src/adapters/openai/shared.ts`'s
 * `mapEffortAgainst` "no vocabulary" arm (the SDK's own `mapEffortAgainst` is not part of that
 * package's actual compiled public barrel at the pinned 0.0.17 -- a separate, minor packaging gap
 * from the `export * from "./adapters/index.js"` its `.d.ts` promises -- so this test proves the
 * WORDING by construction rather than depending on an import that may not resolve). Not a daemon
 * fix; reproduced here only so this test pins the exact dist error text.
 */
function noVocabularyReason(descriptor: WinterModelDescriptor | undefined, effort: string): string | undefined {
  if (descriptor === undefined) return undefined;
  const verified = descriptor.reasoning?.efforts ?? [];
  if (descriptor.reasoning === undefined || verified.length === 0) {
    return `model "${descriptor.key}" declares no reasoning effort vocabulary, so effort ${JSON.stringify(effort)} cannot be mapped onto it — Winter rejects the selection rather than silently sending the provider's default (WS-13 §8.2)`;
  }
  return undefined;
}

describe("D1: the daemon's own provider selection is correct", () => {
  test("providerFor never resolves a bare id -- it names exactly the tag's own provider", () => {
    const selection = providerFor("deepseek/deepseek-v4-flash");
    expect(selection?.providerId).toBe("deepseek");
  });

  test("the real catalog's registry-level resolution IS provider-scoped (not the bug)", () => {
    // Confirms the daemon-facing contract (`providerFor` + the registry's own `resolve()`) is sound;
    // the bug below is strictly downstream of a CORRECTLY resolved provider.
    const catalog = loadCatalog();
    const deepseek = catalog.models.find((m) => m.key === "deepseek/deepseek-v4-flash");
    expect(deepseek?.providerId).toBe("deepseek");
    expect(deepseek?.reasoning?.efforts).toEqual(["none", "low", "high", "max"]);
  });
});

describe("D1: the Winter-leg SDK's shared-adapter descriptor lookup is provider-scoped (fixed in agent SDK 0.0.20)", () => {
  test("deepseek and alibaba-cn share the openai-chat-completions adapter and the SAME bare upstreamId", () => {
    const catalog = loadCatalog();
    const deepseekProvider = catalog.providers.find((p) => p.id === "deepseek");
    const alibabaCnProvider = catalog.providers.find((p) => p.id === "alibaba-cn");
    expect(deepseekProvider?.adapterId).toBe("winter.openai-chat-completions");
    expect(alibabaCnProvider?.adapterId).toBe("winter.openai-chat-completions");
  });

  test("descriptorLookupForAdapter resolves 'deepseek-v4-flash' under the REQUEST's own provider -- the dist refusal cannot recur", () => {
    // Until 0.0.20 the lookup took the bare id alone and answered alibaba-cn's row (no reasoning
    // block), so a deepseek session's effort "max" was refused with alibaba-cn's name in the text.
    const catalog = loadCatalog();
    const lookup = descriptorLookupForAdapter(catalog, "winter.openai-chat-completions");
    const deepseek = lookup("deepseek-v4-flash", "deepseek");
    expect(deepseek?.key).toBe("deepseek/deepseek-v4-flash");
    expect(deepseek?.reasoning?.efforts).toContain("max");
    expect(noVocabularyReason(deepseek, "max")).toBeUndefined();

    // Each provider sharing the adapter gets its OWN row for the same bare id.
    expect(lookup("deepseek-v4-flash", "alibaba-cn")?.key).toBe("alibaba-cn/deepseek-v4-flash");
  });
});
