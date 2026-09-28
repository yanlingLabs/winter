// Catalog rows picked by SHAPE, not by name, so a catalog refresh that states reasoning for a row a test
// used as its example cannot break the test's claim (agent SDK 0.0.34 did exactly that to
// `agentrouter/claude-opus-5`). Both pickers stay on openai/anthropic rows, which every role accepts.
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";

const ROLE_SAFE_PROVIDERS = ["openai", "anthropic"];

/** A live row that declares NO `reasoning` block at all. */
export function noReasoningBlockTag(): string {
  const row = loadCatalog().models.find((m) => m.reasoning === undefined && m.status !== "deprecated" && ROLE_SAFE_PROVIDERS.includes(m.providerId));
  if (row === undefined) throw new Error("the catalog has no openai/anthropic row without a reasoning block — pick another shape");
  return row.key;
}

/** A live row whose `reasoning` block states reasoning is NOT supported. */
export function reasoningUnsupportedTag(): string {
  const row = loadCatalog().models.find((m) => m.reasoning?.supported.value === false && m.status !== "deprecated" && ROLE_SAFE_PROVIDERS.includes(m.providerId));
  if (row === undefined) throw new Error("the catalog has no openai/anthropic row stating reasoning unsupported — pick another shape");
  return row.key;
}
