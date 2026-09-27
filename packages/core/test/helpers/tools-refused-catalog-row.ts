// WS-24 (pickers lane) tests need a live catalog row that pins one specific boundary:
// `toolsRefusedFor()` (`runtime-sdk/provider-selection.ts`) refuses it because its PROVIDER'S
// ADAPTER actually gates on `toolCalling` (branch 2a) rather than because the evidence is
// confidently stated regardless of adapter (branch 2b, pinned separately against
// `xai/grok-4.20-multi-agent-0309`) — specifically on the `winter.anthropic-messages` leg of branch
// 2a ("an anthropic-family toolCalling:none tag"), the one these four tests are titled after, with an
// ordinary `api-key` Keychain slot so a test can write real credential material for it.
//
// A hand-picked example name (`zai-anthropic/glm-5`, `agentrouter/claude-opus-4-8`, …) goes stale
// every time the catalog re-measures a model's tool support — 0.0.33 promoted every row these tests
// used to `toolCalling: "native"`. Picking the row from the LOADED catalog at test time, by the same
// predicate the boundary is defined by, means a future catalog refresh can only ever break this test
// by removing the boundary itself (the `winter.anthropic-messages` leg becoming unreachable), never
// by re-measuring one example.
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { toolsRefusedFor } from "../../src/runtime-sdk/provider-selection";

const ANTHROPIC_MESSAGES_ADAPTER_ID = "winter.anthropic-messages";

/**
 * A live (not `"blocked"`/`"deprecated"`) catalog row on the `winter.anthropic-messages` adapter that
 * `toolsRefusedFor` refuses purely on that adapter gating on `toolCalling`: `toolCalling.value` is not
 * `"native"`, `confidence` is `"unknown"` (the catalog's fail-closed default for a capability upstream
 * never stated — not a measured denial). Its provider takes ordinary `api-key` material, so a test can
 * write real credential material for it. Optionally scoped to a provider that ALSO carries a
 * `"native"` sibling row, so a test can show the refusal is per-row, not a blanket hide of the whole
 * provider.
 */
export function toolsGatedNoneRow(opts: { withNativeSibling?: boolean } = {}): WinterModelDescriptor {
  const catalog = loadCatalog();
  const live = (m: WinterModelDescriptor) => m.status !== "blocked" && m.status !== "deprecated";
  const providers = new Map(catalog.providers.map((p) => [p.id, p]));
  const isAnthropicMessagesApiKeyProvider = (providerId: string): boolean => {
    const provider = providers.get(providerId);
    return provider?.adapterId === ANTHROPIC_MESSAGES_ADAPTER_ID && provider.authKinds.includes("api-key");
  };
  const providerHasNativeSibling = (providerId: string): boolean =>
    catalog.models.some((m) => m.providerId === providerId && m.toolCalling.value === "native" && live(m));
  const row = catalog.models.find(
    (m) =>
      live(m) &&
      isAnthropicMessagesApiKeyProvider(m.providerId) &&
      m.toolCalling.value !== "native" &&
      m.toolCalling.confidence === "unknown" &&
      toolsRefusedFor(m) &&
      (!opts.withNativeSibling || providerHasNativeSibling(m.providerId)),
  );
  if (!row) {
    throw new Error(
      "no catalog row currently pins the anthropic-messages leg of the adapter-gated toolCalling:none boundary — re-derive this test against the current catalog",
    );
  }
  return row;
}

/** A `"native"` row in the same provider as `row` — the contrast case proving the provider is not hidden wholesale. */
export function nativeSiblingRow(row: WinterModelDescriptor): WinterModelDescriptor {
  const catalog = loadCatalog();
  const sibling = catalog.models.find((m) => m.providerId === row.providerId && m.toolCalling.value === "native" && m.status !== "blocked" && m.status !== "deprecated");
  if (!sibling) throw new Error(`no native sibling row found for provider ${row.providerId} — pick a different toolsGatedNoneRow()`);
  return sibling;
}
