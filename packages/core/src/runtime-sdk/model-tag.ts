import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";

/** WS-20: a model is ALWAYS a provider-qualified tag ("<providerId>/<modelId>") in code — the
 *  catalog row `key` already IS the tag. This module is the one place the tag shape and its
 *  parsing/lookup helpers live; nothing else in the daemon may pick a provider for a bare id. */
export type ModelTag = string & { readonly __brand: "ModelTag" };

/** Escape hatch: a test double id, never split as a tag, always passed through unchanged. */
export const WINTER_TEST_PREFIX = "winter-test/";

/** The ONE sentinel for "no model recorded" (a session/record with nothing stamped yet). */
export const UNSTATED_TAG = "unstated/unstated" as ModelTag;

/** providerId '/' modelId; modelId MAY itself contain '/' (an openrouter-style nested id). */
export const MODEL_TAG_RE = /^[a-z0-9][a-z0-9.-]*\/\S+$/;

/** Splits at the FIRST '/'. Throws on anything that is not shaped like "<providerId>/<modelId>". */
export function splitTag(tag: string): { providerId: string; modelId: string } {
  const i = tag.indexOf("/");
  if (i <= 0 || i === tag.length - 1 || !MODEL_TAG_RE.test(tag)) throw new TypeError(`not a model tag: ${JSON.stringify(tag)}`);
  return { providerId: tag.slice(0, i), modelId: tag.slice(i + 1) };
}

const providerIds = (): Set<string> => new Set(loadCatalog().providers.map((p) => p.id));

/** MODEL_TAG_RE && providerId is a PINNED catalog provider, OR s is the sentinel, OR s is a
 *  winter-test double (never validated against the catalog at all). */
export function isModelTag(s: string): s is ModelTag {
  if (s === UNSTATED_TAG) return true;
  if (s.startsWith(WINTER_TEST_PREFIX)) return true;
  if (!MODEL_TAG_RE.test(s)) return false;
  return providerIds().has(s.slice(0, s.indexOf("/")));
}

export function parseModelTag(s: string): ModelTag {
  if (!isModelTag(s)) throw new TypeError(`not a model tag: ${JSON.stringify(s)}`);
  return s as ModelTag;
}

/**
 * WS-20 (review round 2, M4): `isModelTag` only checks TAG SHAPE plus "the provider itself is a
 * pinned catalog provider" — a typo model id on a real provider (`codex-oauth/gpt-5.4`) passes it.
 * `modelTagIsKnown` is the STRICTER membership gate the RPC doors need (`session.create`/`setModel`/
 * `sync.push` meta/`provider.configure`): the tag must name a REAL catalog row, UNLESS either (a)
 * the provider has a BYO `providers.<id>.baseUrl` configured — an intentionally unlisted endpoint
 * model, e.g. a fine-tune, keeps its pass-through — or (b) the provider has NO catalog rows at all
 * (nothing for the tag to be a member of, so refusing would be refusing every possible model that
 * provider could ever serve). The sentinel and `winter-test/*` are accepted here exactly as
 * `isModelTag` accepts them — rejecting the sentinel at the RPC boundary is a SEPARATE, door-level
 * concern (nit e), not this membership question.
 *
 * `settings` is optional and duck-typed (not the full `Settings` type) to avoid this module
 * depending on `../settings`, which already depends on THIS module.
 */
export function modelTagIsKnown(tag: string, settings?: { providers?: Record<string, { baseUrl?: string }> }): boolean {
  if (!isModelTag(tag)) return false;
  if (tag === UNSTATED_TAG || tag.startsWith(WINTER_TEST_PREFIX)) return true;
  const catalog = loadCatalog();
  if (catalog.models.some((m) => m.key === tag)) return true;
  const { providerId } = splitTag(tag);
  const providerHasRows = catalog.models.some((m) => m.providerId === providerId);
  const baseUrl = settings?.providers?.[providerId]?.baseUrl;
  const hasByoEndpoint = typeof baseUrl === "string" && baseUrl.length > 0;
  return !providerHasRows || hasByoEndpoint;
}

/** Every catalog row key whose family slot name === slotName (across every family that defines
 *  that slot), in catalog order. */
export function tagsForSlot(slotName: string): ModelTag[] {
  const catalog = loadCatalog();
  const out: ModelTag[] = [];
  for (const family of catalog.families ?? []) {
    for (const slot of family.slots) {
      if (slot.name !== slotName) continue;
      for (const row of catalog.models) if (row.canonicalModelId === slot.canonicalModelId) out.push(row.key as ModelTag);
    }
  }
  return out;
}

export function facingNameToTag(providerId: string, slotName: string): ModelTag | undefined {
  return tagsForSlot(slotName).find((t) => t.startsWith(`${providerId}/`));
}

/** The slot name when the row is a family slot, else undefined. */
export function facingNameOf(tag: ModelTag): string | undefined {
  const catalog = loadCatalog();
  const row = catalog.models.find((m) => m.key === tag);
  if (!row) return undefined;
  for (const family of catalog.families ?? []) for (const slot of family.slots) if (slot.canonicalModelId === row.canonicalModelId) return slot.name;
  return undefined;
}
