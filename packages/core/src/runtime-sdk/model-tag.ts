import { CATALOG_TAG_RENAMES, loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { setWireModelTagCanonicalizer } from "@yanlinglabs/winter-protocol";

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

/** Case-insensitive: the catalog row for `providerId` whose family slot NAME matches `facingName`
 *  (e.g. `providerId="anthropic"`, `facingName="sonnet"` or `"Sonnet"` → the `anthropic/claude-
 *  sonnet-*` row), or `undefined` when this provider serves no such slot. Distinct from
 *  `facingNameToTag` (case-SENSITIVE, and matches by tag-string prefix rather than the row's own
 *  `providerId` field) — kept as its own local helper rather than changed in place, since
 *  `facingNameToTag` is a stable, already-exported API other callers rely on case-sensitively. */
function rowForFacingName(providerId: string, facingName: string): ModelTag | undefined {
  const wanted = facingName.toLowerCase();
  const catalog = loadCatalog();
  for (const family of catalog.families ?? []) {
    for (const slot of family.slots) {
      if (slot.name.toLowerCase() !== wanted) continue;
      const row = catalog.models.find((m) => m.providerId === providerId && m.canonicalModelId === slot.canonicalModelId);
      if (row) return row.key as ModelTag;
    }
  }
  return undefined;
}

/**
 * WS-20 (review round 2, M4 fix — R1): the STRICTER membership + CANONICALIZATION gate the RPC
 * doors need (`session.create`/`setModel`/`sync.push` meta/`provider.configure`). Returns the
 * CANONICAL catalog row key a tag resolves to, or `undefined` when it cannot be resolved at all —
 * callers store/forward THIS value, never the tag as typed, so a facing-name request never persists
 * its shorthand form.
 *
 * Resolution order:
 *  1. The sentinel and `winter-test/*` pass through unchanged (never validated against the
 *     catalog at all).
 *  2. A tag that is ALREADY a real catalog row key (`rowForTag`'s own check) — the common case.
 *  3. A `<providerId>/<facingName>` request (spec §1: "a facing name resolves to a tag only within
 *     a chosen provider") — `anthropic/sonnet` names the SLOT `sonnet` within provider `anthropic`,
 *     resolved case-insensitively to that provider's own row for the slot (`anthropic/claude-
 *     sonnet-5`), same for `codex-oauth/terra` → `codex-oauth/gpt-5.6-terra`. `isModelTag` already
 *     proved `providerId` is a pinned catalog provider, so this is never a guess at WHICH provider,
 *     only which of ITS OWN rows the facing name means.
 *  4. Neither a real row nor a facing name: the ORIGINAL typo-refusal rule 3 items on — refuse,
 *     UNLESS the provider has a BYO `providers.<id>.baseUrl` configured (an intentionally unlisted
 *     endpoint model, e.g. a fine-tune, keeps its pass-through verbatim) or the provider has NO
 *     catalog rows at all (nothing for the tag to be a member of, so refusing would be refusing
 *     every possible model that provider could ever serve) — either way, the caller's own literal
 *     tag is returned unchanged (there is no canonical form to resolve it TO).
 *
 * `settings` is optional and duck-typed (not the full `Settings` type) to avoid this module
 * depending on `../settings`, which already depends on THIS module.
 */
export function canonicalizeModelTag(tag: string, settings?: { providers?: Record<string, { baseUrl?: string }> }): ModelTag | undefined {
  if (!isModelTag(tag)) return undefined;
  if (tag === UNSTATED_TAG || tag.startsWith(WINTER_TEST_PREFIX)) return tag as ModelTag;
  const catalog = loadCatalog();
  if (catalog.models.some((m) => m.key === tag)) return tag as ModelTag;
  const { providerId, modelId } = splitTag(tag);
  const facing = rowForFacingName(providerId, modelId);
  if (facing !== undefined) return facing;
  const providerHasRows = catalog.models.some((m) => m.providerId === providerId);
  const baseUrl = settings?.providers?.[providerId]?.baseUrl;
  const hasByoEndpoint = typeof baseUrl === "string" && baseUrl.length > 0;
  return !providerHasRows || hasByoEndpoint ? (tag as ModelTag) : undefined;
}

/** Thin boolean wrapper over `canonicalizeModelTag` — kept for callers that only need "is this tag
 *  resolvable at all", never the resolved value itself. */
export function modelTagIsKnown(tag: string, settings?: { providers?: Record<string, { baseUrl?: string }> }): boolean {
  return canonicalizeModelTag(tag, settings) !== undefined;
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


// ── WS-21 (spec §8 step 5): stored tags canonicalize ON READ ──────────────────────────────────────
//
// A catalog refresh can rename a row (DeepSeek's retired `deepseek-v4-flash` now lives at
// `deepseek-flash`). Stored tags are NEVER rewritten — an older Winter's catalog has no row under the
// new spelling, so a rewrite is a downgrade hazard (r2 I5) — they are resolved through this ONE
// function at three parse layers: the live settings view (`liveSettingsView`), the runtime-state row
// decoder (`records.ts` `fromRow`, `sessions/store.ts`'s `model` column) and the protocol request parse
// (`ModelTagSchema`'s transform, registered below). The rename table is the catalog's own
// `CATALOG_TAG_RENAMES` (lane L1b: derived from the refresh's reviewed exclusions and the surviving
// rows' aliases, never hand-typed here).

let liveKeysCache: ReadonlySet<string> | undefined;
let liveKeysOverride: ReadonlySet<string> | undefined;
function liveCatalogKeys(): ReadonlySet<string> {
  if (liveKeysOverride !== undefined) return liveKeysOverride;
  liveKeysCache ??= new Set(loadCatalog().models.map((m) => m.key));
  return liveKeysCache;
}

/** TEST ONLY: stand in a catalog's row keys (e.g. the refreshed catalog's) — `undefined` restores the
 *  linked catalog. A test that sets it must restore it. */
export function setCatalogKeysForTests(keys: Iterable<string> | undefined): void {
  liveKeysOverride = keys === undefined ? undefined : new Set(keys);
}

/**
 * The pure rule: `tag` renames to `renames[tag]` only when the OLD tag no longer resolves on its own
 * (L1b's "never shadow a tag that still resolves") AND the NEW one does (never rename into nothing). So
 * against a catalog that still carries the old row (0.0.20, where `deepseek/deepseek-v4-flash` is live
 * and `deepseek-flash` does not exist) this is the identity, and a working DeepSeek home is untouched.
 */
export function canonicalModelTagWith(tag: string, renames: Readonly<Record<string, string>>, liveKeys: ReadonlySet<string>): string {
  const to = renames[tag];
  if (to === undefined || liveKeys.has(tag) || !liveKeys.has(to)) return tag;
  return to;
}

/** A stored or wire model tag, canonicalized through the catalog's renames (see above). Never throws. */
export function canonicalModelTag(tag: string): string {
  try {
    return canonicalModelTagWith(tag, CATALOG_TAG_RENAMES, liveCatalogKeys());
  } catch {
    return tag;
  }
}

// Layer 3: the protocol package cannot see the catalog, so the daemon registers the rule with it the
// moment this module loads (every daemon, CLI and test that parses a request imports this module
// through `settings.ts`).
setWireModelTagCanonicalizer(canonicalModelTag);
