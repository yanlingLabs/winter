import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import type { SyncConfigModel } from "@yanlinglabs/winter-protocol";
import { facingNameOf, type ModelTag } from "../runtime-sdk/model-tag";
import { effortVocabularyFor } from "../runtime-sdk/provider-selection";
import { credentialPresentProbe } from "../runtime-sdk/keychain";

// Mirrors `ipc/sync.ts`'s own `effortsForModel` EXACTLY (never imported from there — `sync.ts`
// imports `pickerModels` from this module for `sync.config`'s own `models` field, and importing
// back would be a cycle). Both now read the SAME row rule (`effortVocabularyFor`,
// runtime-sdk/provider-selection.ts), so the two copies of the `"none"` prepend are the only thing
// duplicated and they can never disagree about what the catalog says.
function effortsForModel(tag: string): string[] {
  const efforts = effortVocabularyFor(tag) ?? [];
  return efforts.length > 0 ? ["none", ...efforts] : [];
}

/**
 * WS-20: the rows a picker (`sync.config`'s `models`, and any future Mac-side model picker) may
 * offer — one entry per (provider that holds a credential) × (row that provider serves), catalog
 * order throughout. `cc/*` never — it has no catalog row at all (a reserved, code-level prefix,
 * never a real provider id), so it can never be reached by this iteration to begin with.
 *
 * A provider with NO stored credential (the Console included, when its bearer slot is empty) is
 * EXCLUDED entirely — the app's "Add a key…" footer is a separate, `credential.list`-fed affordance,
 * not this list's job to represent an absence.
 *
 * The rule lives in ONE place (`credentialPresentProbe`, runtime-sdk/keychain.ts) and is shared with
 * `models.catalog`'s `credentialPresent`, so the two provider listings cannot disagree about which
 * providers a home is ready to use — and it reads the same `byProvider` the router admits a session's
 * row on, so a model offered here is one `session.create` accepts (the WS-23 live-gate fix: `console`
 * used to be answered by its on-disk profile here while the router saw no `console` credential at all).
 */
export function pickerModels(deps: { credentials: CredentialPresence; home: string }): SyncConfigModel[] {
  const catalog = loadCatalog();
  const credentialPresent = credentialPresentProbe(deps);
  const out: SyncConfigModel[] = [];
  for (const provider of catalog.providers) {
    if (!credentialPresent(provider.id)) continue;
    for (const row of catalog.models) {
      if (row.providerId !== provider.id) continue;
      // A vendor-retired row (`deprecated`, SDK 0.0.23) still resolves for a stored tag but is never offered.
      if (row.status === "blocked" || row.status === "deprecated") continue;
      const tag = row.key as ModelTag;
      out.push({
        id: tag,
        providerId: provider.id,
        displayName: row.displayName,
        ...(facingNameOf(tag) === undefined ? {} : { facingName: facingNameOf(tag)! }),
        efforts: effortsForModel(tag),
      });
    }
  }
  return out;
}
