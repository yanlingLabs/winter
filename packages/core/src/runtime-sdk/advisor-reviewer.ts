// Phase 8d Task 3.1 (P8d-8) — D30: the advisor's per-family DEFAULT model. A Winter session's
// advisor is configured per-session through `Options.advisor.model` (`mode-options.ts`/
// `session-driver.ts`) — the spawned `winter` child resolves the reviewer's own PROVIDER itself (it
// reads the Keychain itself), so the daemon only ever states the target MODEL, and `d30DefaultModel`
// below is the table it states it from when `runtimes.advisorModel` is unset.
//
// WS-23: this file also built the retired official leg's advisor — a daemon-side `ReviewerResolver`
// the router handed that leg's standing advisor tool, with its own OpenAI and Anthropic reviewer
// providers. That half is gone with the leg; the family table is what remains.
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { facingNameToTag, splitTag, type ModelTag } from "./model-tag";

/** Which of Winter's three D30-relevant families a catalog-recognised model belongs to. `"other"` is
 *  every family the pinned catalog has that is neither the OpenAI ("gpt") nor the Claude ("claude")
 *  family — Gemini/Grok/DeepSeek/etc. — for which D30 states no default: the table's own third rung,
 *  "else the session's own model", is what such a family falls through to (`d30DefaultModel` answers
 *  `undefined`, and the child's own default is the session's model). */
export type AdvisorFamily = "openai" | "claude" | "other";

/** A catalog row's `key`/`upstreamId`/`canonicalModelId`/alias match, same lookup
 *  `provider-selection.ts`'s `catalogRowsFor` uses — reimplemented here (rather than imported) only
 *  because that function's declared return type omits `modelFamily`; the row objects are identical
 *  either way, so this can never drift into a second answer for the same model. */
export function familyOfModel(model: string): AdvisorFamily {
  const catalog = loadCatalog();
  const row = catalog.models.find((m) => m.key === model || m.upstreamId === model || m.canonicalModelId === model || m.aliases.includes(model));
  if (row === undefined) return "other";
  if (row.modelFamily === "gpt") return "openai";
  if (row.modelFamily === "claude") return "claude";
  return "other";
}

/** D30's own per-family default: family slot 1's NAME ("astra" for gpt, "fable" for claude —
 *  WS-13c §9's own ranked slot 1). `undefined` only if the pinned catalog ever drops the family
 *  entirely (never true for the two families 8d cares about; a defensive `undefined` rather than a
 *  throw so a catalog hiccup degrades to "no reviewer", never a daemon crash). WS-20: the NAME,
 *  not a canonical model id — `facingNameToTag` (model-tag.ts) needs the name to find which TAG a
 *  given provider serves for that slot; a hand-composed `<provider>/<canonicalId>` string is not
 *  guaranteed to match a real row (the catalog's normaliser can rewrite an id between a row's
 *  `key` and its `canonicalModelId`). */
function firstSlotNameOfFamily(familyId: "gpt" | "claude"): string | undefined {
  return loadCatalog().families.find((f) => f.id === familyId)?.slots[0]?.name;
}

/**
 * D30's table: unset -> a gpt session's reviewer is family slot 1 ("astra"), a claude session's is
 * family slot 1 ("fable") — WS-13c §9's own ranked slot 1.
 *
 * WS-20: the answer is now the SAME PROVIDER's own tag for that slot (`facingNameToTag`), never a
 * bare canonical id and never a cross-provider fallback (spec §4.3) — a provider that does not
 * serve its family's slot 1 (or a session whose tag matches no catalog family at all) answers
 * `undefined`, letting the caller fall through to no explicit advisor override (the child's own
 * default, which is the session's own model either way).
 */
export function d30DefaultModel(sessionTag: string | undefined): ModelTag | undefined {
  if (sessionTag === undefined) return undefined;
  let providerId: string;
  try {
    providerId = splitTag(sessionTag).providerId;
  } catch {
    return undefined;
  }
  const family = familyOfModel(sessionTag);
  if (family === "openai") return facingNameToTag(providerId, firstSlotNameOfFamily("gpt") ?? "");
  if (family === "claude") return facingNameToTag(providerId, firstSlotNameOfFamily("claude") ?? "");
  return undefined;
}
